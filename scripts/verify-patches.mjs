#!/usr/bin/env node
/**
 * 补丁应用门禁:在**仓库外**的临时目录里,对每个 `patches/*.patch` 做真正的
 * dry-run + 结果对拍。
 *
 * 为什么必须在仓库外(2026-09-12 二次审查 P1-6;评估文档 §9-4 的遗留项):
 *   仓库内的 `temp/` 被 .gitignore 忽略,在仓库里对 `patches/*.patch` 跑
 *   `git apply --check` 会因为路径落在忽略目录而**假通过** —— 两个子代理据此
 *   给出过相反结论。唯一可靠的姿势是把 yarn cache 里的 pristine tarball 解到
 *   仓库外的临时目录,在那里应用补丁。
 *
 * 每个补丁做四件事:
 *   1. **补丁体自身必须有内容**:零字节/纯空白、或"非空但一个文件段都没有"的
 *      补丁一律判红并点名补丁文件(2026-09-23 第三轮门禁审计 G-1:此前这种补丁
 *      抽出 0 个路径 ⇒ 逐字节对拍循环整体空转,守卫仍打印 `0 file(s)` 与
 *      "与封存副本逐字节一致");每个文件段还必须带 ≥1 个 hunk,且 hunk 正文行数
 *      与 `@@` 声明一致(段头在而段体丢/被改坏同样是红);
 *   2. `patch -p1 --dry-run --forward` 必须退出码 0(失配即红,并回显 patch 的
 *      hunk 级输出:`Hunk #N FAILED at ...`);
 *   3. 不允许 fuzz(`with fuzz`)或"已应用/反向"补丁(`--forward` 会拒绝);
 *      纯 **offset** 不直接判红,但必须能证明无害 —— 见第 4 步;
 *   4. 真应用到 pristine 后,判据的方向是**从封存副本反推**:封存副本
 *      (`.yarn/cache/<pkg>-patch-*.zip`,回退到安装树里的顶层副本)相对 pristine
 *      变了哪些文件,补丁的文件段就必须**逐个对上** —— 少一段(丢整段)即红,
 *      多一段(封存副本里该文件没变)也是红(2026-09-23 G-2)。再有,补丁触及的
 *      每个文件必须与封存副本逐字节一致。这条同时兜住 offset 与"补丁文件被手改
 *      但与锁文件里的 patch 不一致"。
 *
 * 结果对拍的另一半(补丁覆盖所有副本:嵌套 node_modules 里不得留未打补丁拷贝)
 * 以**警告**形式输出:修掉它需要 `yarn install` 重解析,离线门禁不能自己改锁文件。
 *
 * 守卫自检(2026-09-23 G-1/G-2 的变异网):本文件在跑真实补丁之前,先用一组
 * **最小多文件补丁夹具**把上面第 1/4 步的判据本身驱动一遍(零字节 ⇒ 红、丢段 ⇒ 红、
 * 改坏 hunk ⇒ 红、完好 ⇒ 绿)。夹具与真实补丁走的是**同一个**
 * `inspectPatchAgainstTrees`,所以把判据拆掉时自检必然变红 —— 不必等谁手工注入。
 * 自检跑在同一个仓库外临时树里,不碰工作区。
 *
 * 用法:node scripts/verify-patches.mjs
 * 退出码:0 全部通过;1 有补丁失配(或守卫自检失败)。
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { diffTrees, findCacheZips, listPatchFiles, parsePatchSections, readPatchTargets } from './patch-targets.mjs'

const root = resolve(import.meta.dirname, '..')
const failures = []
const notes = []
const warnings = []

const fail = message => failures.push(message)
const note = message => notes.push(message)
const warn = message => warnings.push(message)

/** 载入 adm-zip(桌面包的依赖;经 createRequire 从它的 manifest 解析)。 */
function loadAdmZip() {
  for (const base of [join(root, 'packages/host/desktop/package.json'), join(root, 'package.json')]) {
    try {
      return createRequire(base)('adm-zip')
    } catch {
      // 试下一个锚点
    }
  }
  throw new Error(
    'verify-patches: 无法解析 adm-zip(解压 yarn cache 的 zip 需要它)。'
    + '先在仓库根跑 `corepack yarn install --immutable`',
  )
}

/** sha256 摘要(对拍用)。 */
function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** 补丁输出里需要判红的信号(fuzz / 反向补丁 / 跳过)。 */
const FUZZ_PATTERN = /with fuzz/iu
const REVERSED_PATTERN = /reversed \(or previously applied\)|previously applied patch detected|skipping patch/iu
/** 纯偏移警告(GNU patch:`succeeded at 156 (offset 1 line)`)。 */
const OFFSET_PATTERN = /offset \d+ lines?/iu

/** 在给定目录里跑一次 patch。 */
function runPatch(pkgDir, patchFile, dryRun) {
  const args = ['-p1', '--forward', '--batch', '--reject-file=-', '-i', patchFile]
  if (dryRun) args.splice(1, 0, '--dry-run')
  const result = spawnSync('patch', args, { cwd: pkgDir, encoding: 'utf8' })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  return { status: result.status, output, error: result.error }
}

/** 找到安装树里的顶层副本(仅用于结果对拍的回退见证)。 */
function findInstalledCopy(name) {
  let dir = join(root, 'packages', 'host', 'desktop')
  for (;;) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/**
 * 列出仓库安装树里该包的全部副本(顶层 + 一层嵌套)。
 * `nmHoistingLimits: workspaces` 下,未打补丁的拷贝正是以
 * `<ws>/node_modules/<something>/node_modules/<pkg>` 的形态出现。
 * @param name - 包名。
 * @returns 副本目录列表。
 */
function listInstalledCopies(name) {
  const copies = new Set()
  const nodeModulesRoots = [join(root, 'node_modules')]
  for (const group of ['packages/host', 'packages/client', 'packages/vendor', 'community']) {
    const groupDir = join(root, group)
    if (!existsSync(groupDir)) continue
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (entry.isDirectory()) nodeModulesRoots.push(join(groupDir, entry.name, 'node_modules'))
    }
  }
  const scoped = name.startsWith('@')
  for (const nodeModules of nodeModulesRoots) {
    if (!existsSync(nodeModules)) continue
    const direct = join(nodeModules, name)
    if (existsSync(join(direct, 'package.json'))) copies.add(direct)
    // 一层嵌套:node_modules/<pkg>/node_modules/<name>(含 scope 两级展开)。
    let children = []
    try {
      children = readdirSync(nodeModules, { withFileTypes: true })
    } catch {
      continue
    }
    for (const child of children) {
      if (!child.isDirectory()) continue
      const childDir = join(nodeModules, child.name)
      const packages = child.name.startsWith('@')
        ? readdirSync(childDir, { withFileTypes: true })
          .filter(entry => entry.isDirectory())
          .map(entry => join(childDir, entry.name))
        : [childDir]
      for (const pkgDir of packages) {
        const nested = join(pkgDir, 'node_modules', name)
        if (existsSync(join(nested, 'package.json'))) copies.add(nested)
        if (scoped) {
          // 更深一层(某些依赖自带 node_modules/<scope>/<pkg>)交给上面的递归形态覆盖。
          continue
        }
      }
    }
  }
  return [...copies]
}

/**
 * 对一个补丁 + 一棵 pristine 树 + 一份参照副本做全部判据。
 *
 * 抽成函数是为了让**守卫自检**用合成夹具驱动同一套判据(2026-09-23 G-1/G-2):
 * 夹具与真实补丁只有输入不同,判据完全一致 —— 于是"把判据拆掉"必然让自检变红。
 *
 * @param args - `{ patchText, patchFile, pkgDir, referenceDir, referenceLabel, sealedReference }`。
 * @returns `{ problems, notes, touched, offset, compared }`;problems 是**不含**补丁名的
 *   失败消息(调用方负责加 `<补丁路径>:` 前缀)。
 */
function inspectPatchAgainstTrees({ patchText, patchFile, pkgDir, referenceDir, referenceLabel, sealedReference }) {
  const problems = []
  const localNotes = []
  const info = { touched: [], offset: false, compared: false }

  // 判据 0:补丁体自身必须"有话可说"(G-1/G-2 的入口)。
  const shape = parsePatchSections(patchText)
  if (shape.sections.length === 0) {
    if (patchText.trim() === '') {
      problems.push(
        '补丁文件为空(0 字节或纯空白)—— 这个守卫没有任何可验证的内容,补丁也绝不可能生效;'
        + '空补丁 = 补丁效果已丢失,请用 `yarn patch` 重新录制',
      )
    } else {
      problems.push(...(shape.problems.length > 0
        ? shape.problems
        : ['补丁里没有任何文件段(既没有 `---`/`+++` 也没有 `diff --git` 头)—— '
          + '不能把"没有可验证内容"当作通过']))
    }
    return { ...info, problems, notes: localNotes }
  }
  problems.push(...shape.problems)
  const touched = shape.sections.map(section => section.path)
  info.touched = touched
  const hunkless = shape.sections.filter(section => section.hunks.length === 0).map(section => section.path)
  if (hunkless.length > 0) {
    problems.push(`文件段没有 hunk(只有 ---/+++ 头):${hunkless.join(', ')} —— 该段的补丁体已丢失`)
  }
  if (problems.length > 0) return { ...info, problems, notes: localNotes }

  // 判据 1:dry-run。
  const dry = runPatch(pkgDir, patchFile, true)
  if (dry.error !== undefined) {
    problems.push(`无法执行 patch(${String(dry.error.message)})`)
    return { ...info, problems, notes: localNotes }
  }
  if (dry.status !== 0) {
    problems.push(
      `在 pristine 树上 dry-run 失败(退出码 ${String(dry.status)}) —— 补丁与当前版本已失配:\n`
      + dry.output.trimEnd().split('\n').map(line => `      ${line}`).join('\n'),
    )
    return { ...info, problems, notes: localNotes }
  }
  if (REVERSED_PATTERN.test(dry.output)) {
    problems.push(`patch 报告"已应用/反向补丁"(${dry.output.trim()}) —— 补丁文件或 cache 里的 pristine 树有问题`)
    return { ...info, problems, notes: localNotes }
  }
  if (FUZZ_PATTERN.test(dry.output)) {
    problems.push(
      `patch 需要 fuzz 才能应用(fuzz = 上下文不再精确匹配):\n`
      + dry.output.trimEnd().split('\n').map(line => `      ${line}`).join('\n'),
    )
    return { ...info, problems, notes: localNotes }
  }
  info.offset = OFFSET_PATTERN.test(dry.output)

  // 判据 2:从**封存副本反推**改动集,再要求补丁的文件段与之对齐(G-1/G-2)。
  // 必须在真应用**之前**做 —— 应用之后 pkgDir 就是补丁结果,再与封存副本比会得到
  // "完全相同"的假象(这正是第一版踩到的坑)。
  const hasReference = referenceDir !== undefined && existsSync(referenceDir)
  const declaredAdded = shape.sections
    .filter(section => section.oldPath === '/dev/null')
    .map(section => section.path)
  if (hasReference) {
    const { changed, added } = diffTrees(pkgDir, referenceDir)
    info.compared = true
    if (changed.length === 0 && added.length === 0) {
      problems.push(
        `${referenceLabel} 与 pristine 逐字节相同,但补丁文件非空 —— `
        + '封存副本里看不到任何改动(补丁未生效/未被 yarn 记录)',
      )
      return { ...info, problems, notes: localNotes }
    }
    const missing = changed.filter(relative => !touched.includes(relative))
    if (missing.length > 0) {
      problems.push(
        `补丁缺少整段:${missing.join(', ')} —— ${referenceLabel} 里这些文件相对 pristine 已改变,`
        + '但补丁文本里没有它们的文件段(整段被删/改坏)',
      )
    }
    if (sealedReference === true) {
      // 封存副本是补丁结果的忠实重打包,所以"多出来的段"同样是缺陷。
      const extra = touched.filter(relative => !changed.includes(relative) && !added.includes(relative))
      if (extra.length > 0) {
        problems.push(
          `补丁声明改动 ${extra.join(', ')},但 ${referenceLabel} 里这些文件与 pristine 逐字节相同 —— `
          + '该文件段没有效果(补丁被手改过,或封存副本已过期)',
        )
      }
      const addedMissing = declaredAdded.filter(relative => !added.includes(relative))
      if (addedMissing.length > 0) {
        problems.push(`补丁声明新建 ${addedMissing.join(', ')},但 ${referenceLabel} 里没有这些新文件`)
      }
    }
    if (problems.length > 0) return { ...info, problems, notes: localNotes }
  } else if (info.offset) {
    problems.push(
      'patch 报告行偏移,但既没有 cache 封存副本也没有安装树副本可以对拍 —— '
      + '无法证明偏移无害;请先 `corepack yarn install --immutable`',
    )
    return { ...info, problems, notes: localNotes }
  } else {
    localNotes.push('无封存副本可对拍(结果等价性未验证)')
  }

  // 判据 3:真应用。
  const applied = runPatch(pkgDir, patchFile, false)
  if (applied.status !== 0) {
    problems.push(
      `真应用补丁失败(退出码 ${String(applied.status)}):\n`
      + applied.output.trimEnd().split('\n').map(line => `      ${line}`).join('\n'),
    )
    return { ...info, problems, notes: localNotes }
  }

  // 判据 4:逐字节对拍(offset 无害性的唯一证明也在这里)。
  if (hasReference) {
    const mismatches = []
    for (const relative of touched) {
      const a = join(pkgDir, relative)
      const b = join(referenceDir, relative)
      if (!existsSync(b)) {
        mismatches.push(`${relative}(封存副本里不存在)`)
        continue
      }
      if (sha256(a) !== sha256(b)) mismatches.push(relative)
    }
    if (mismatches.length > 0) {
      problems.push(
        `应用结果与${referenceLabel}不一致:${mismatches.join(', ')} —— `
        + '补丁文件与 yarn 封存的补丁结果已漂移(重新用 `yarn patch` 录制或修正补丁)',
      )
      return { ...info, problems, notes: localNotes }
    }
  }

  return { ...info, problems, notes: localNotes }
}

/**
 * 守卫自检:用最小多文件补丁夹具把 `inspectPatchAgainstTrees` 的判别力驱动一遍。
 *
 * 为什么**内嵌**在守卫里而不是另开一个文件:本轮审计的教训正是"判据存在但没人驱动"
 * (G-8)。夹具跑在真实守卫的每次运行里 ⇒ 拆掉任一条判据,`yarn check` 立刻红,
 * 不依赖任何人记得再加一条 wiring。
 *
 * @param tempRoot - 仓库外临时根目录。
 * @returns 自检失败消息列表(空 = 通过)。
 */
function runGuardSelfCheck(tempRoot) {
  const problems = []
  const fixtureRoot = join(tempRoot, 'guard-selfcheck')
  const pristineFiles = {
    'lib/a.js': 'export const a = 1\nexport const b = 2\n',
    'lib/b.js': 'export const c = 1\n',
    // 第三个文件在两棵树里完全相同 —— 用来造"补丁多声明了一段没有效果的改动"的夹具。
    'lib/c.js': 'export const d = 1\n',
  }
  const patchedFiles = {
    'lib/a.js': 'export const a = 1\nexport const b = 3\n',
    'lib/b.js': 'export const c = 2\n',
    'lib/c.js': 'export const d = 1\n',
  }
  const writeTree = (dir, files) => {
    for (const [relative, content] of Object.entries(files)) {
      const target = join(dir, relative)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, content)
    }
  }
  const pristineDir = join(fixtureRoot, 'pristine')
  const referenceDir = join(fixtureRoot, 'reference')
  writeTree(pristineDir, pristineFiles)
  writeTree(referenceDir, patchedFiles)

  const sectionA = [
    'diff --git a/lib/a.js b/lib/a.js',
    '--- a/lib/a.js',
    '+++ b/lib/a.js',
    '@@ -1,2 +1,2 @@',
    ' export const a = 1',
    '-export const b = 2',
    '+export const b = 3',
    '',
  ]
  // 第二段故意用不带 `diff --git` 的经典形态(仓库里 dsh-agent-presets 等补丁就是这样)。
  const sectionB = [
    '--- a/lib/b.js',
    '+++ b/lib/b.js',
    '@@ -1,1 +1,1 @@',
    '-export const c = 1',
    '+export const c = 2',
    '',
  ]
  const intact = [...sectionA, ...sectionB].join('\n')
  // 第三段:删一行再加回同一行 ⇒ patch 能应用、逐字节也对得上,但封存副本里该文件
  // 根本没变 —— 这条只能由"改动集对齐"的反方向判据抓住。
  const noEffectSection = [
    '--- a/lib/c.js',
    '+++ b/lib/c.js',
    '@@ -1,1 +1,1 @@',
    '-export const d = 1',
    '+export const d = 1',
    '',
  ]
  const cases = [
    { name: '完好两段补丁', text: intact, expectRed: false },
    { name: '零字节补丁', text: '', expectRed: true, pattern: /补丁文件为空/u },
    { name: '纯空白补丁', text: '   \n\t\n', expectRed: true, pattern: /补丁文件为空/u },
    {
      name: '丢掉第二段',
      text: sectionA.join('\n'),
      expectRed: true,
      pattern: /补丁缺少整段:lib\/b\.js/u,
    },
    {
      name: '多出一段没有效果的改动',
      text: [...sectionA, ...sectionB, ...noEffectSection].join('\n'),
      expectRed: true,
      pattern: /该文件段没有效果/u,
    },
    {
      name: 'hunk 体被截断',
      text: [...sectionA.slice(0, 5), ...sectionB].join('\n'),
      expectRed: true,
      pattern: /hunk 正文与 @@ 声明不符/u,
    },
    {
      name: '只有段头没有 hunk',
      text: [...sectionA.slice(0, 3), '', ...sectionB].join('\n'),
      expectRed: true,
      pattern: /文件段没有 hunk/u,
    },
    {
      name: '非空但无文件段',
      text: 'this is not a unified diff at all\n',
      expectRed: true,
      pattern: /解析不出任何文件段/u,
    },
  ]

  for (const [index, testCase] of cases.entries()) {
    const caseDir = join(fixtureRoot, `case-${index}`)
    const pkgDir = join(caseDir, 'pkg')
    cpSync(pristineDir, pkgDir, { recursive: true })
    const patchFile = join(caseDir, 'fixture.patch')
    writeFileSync(patchFile, testCase.text)
    const result = inspectPatchAgainstTrees({
      patchText: testCase.text,
      patchFile,
      pkgDir,
      referenceDir,
      referenceLabel: '夹具封存副本',
      sealedReference: true,
    })
    const isRed = result.problems.length > 0
    if (isRed !== testCase.expectRed) {
      problems.push(
        `自检用例「${testCase.name}」期望${testCase.expectRed ? '判红' : '判绿'},实际${isRed ? '判红' : '判绿'}`
        + `(${result.problems.join(' | ') || '无 problem'})`,
      )
      continue
    }
    if (testCase.pattern !== undefined && !testCase.pattern.test(result.problems.join(' | '))) {
      problems.push(
        `自检用例「${testCase.name}」判红但理由不对:期望匹配 ${String(testCase.pattern)},`
        + `实际 ${result.problems.join(' | ')}`,
      )
    }
    if (!testCase.expectRed) {
      const expectedTouched = ['lib/a.js', 'lib/b.js']
      if (JSON.stringify(result.touched) !== JSON.stringify(expectedTouched)) {
        problems.push(
          `自检用例「${testCase.name}」的段解析不对:期望 ${JSON.stringify(expectedTouched)},`
          + `实际 ${JSON.stringify(result.touched)}`,
        )
      }
      if (result.compared !== true) problems.push(`自检用例「${testCase.name}」没有真的做封存副本对拍`)
    }
  }
  return problems
}

const admZip = loadAdmZip()
const { targets, failures: parseFailures } = readPatchTargets(root)
failures.push(...parseFailures)

if (targets.length === 0) {
  fail('resolutions 里没有任何 patch 目标,但 patches/ 下有文件 —— 补丁不会生效')
}

// GNU patch 可用性:缺失时直接给可操作信息,而不是每个补丁报一次 ENOENT。
const probe = spawnSync('patch', ['--version'], { encoding: 'utf8' })
if (probe.error?.code === 'ENOENT') {
  process.stderr.write(
    'verify-patches: 未找到 GNU patch。Linux 上 `apt-get install patch`;macOS 自带;'
    + 'Windows 需要 Git Bash / gnuwin32 的 patch.exe(CI 门禁在 ubuntu 上跑)\n',
  )
  process.exit(1)
}

const tempRoot = mkdtempSync(join(tmpdir(), 'dsh-verify-patches-'))
// P1-6 的核心断言:临时树必须在仓库外(仓库内的 temp/ 被 gitignore,会假通过)。
// G-3(2026-09-23):两边都取 realpath 再比 —— 只做字符串前缀判断时,
// TMPDIR 指向仓库内的**符号链接**即可绕过(realpath 后落在仓库里)。
const realTempRoot = realpathSync(tempRoot)
const realRepoRoot = realpathSync(root)
if (realTempRoot === realRepoRoot || realTempRoot.startsWith(realRepoRoot + sep)) {
  process.stderr.write(
    `verify-patches: 临时目录 ${realTempRoot} 落在仓库内(${realRepoRoot}),拒绝继续(仓库内校验会假通过)\n`,
  )
  process.exit(1)
}

const cacheDir = join(root, '.yarn', 'cache')
const patchFiles = listPatchFiles(root)
const report = []
const cleanup = []
let uncompared = 0
/** 参照副本不是 cache 封存副本(而是安装树副本)的补丁数 —— 只影响总结文案的措辞。 */
let installedReference = 0

try {
  // 判据自检必须在真实补丁之前跑:夹具红了就说明守卫本身坏了,后面的"全绿"没有意义。
  for (const message of runGuardSelfCheck(tempRoot)) fail(`守卫自检失败:${message}`)

  for (const target of [...targets].sort((a, b) => a.patchPath.localeCompare(b.patchPath))) {
    const label = target.patchPath
    const patchFile = join(root, target.patchPath)
    if (!existsSync(patchFile)) {
      fail(`${label}: 补丁文件不存在(${patchFile})`)
      continue
    }
    const patchText = readFileSync(patchFile, 'utf8')

    const { pristine, patched } = findCacheZips(cacheDir, target.name, target.version)
    if (pristine === undefined) {
      fail(
        `${label}: 在 ${join('.yarn', 'cache')} 里找不到 ${target.name}@${target.version} 的 pristine tarball`
        + `(<name>-npm-<version>-*.zip)。离线校验需要它 —— 先跑 \`corepack yarn install --immutable\``,
      )
      continue
    }

    const workDir = join(tempRoot, label.replace(/[^A-Za-z0-9.@-]/gu, '_'))
    const pristineDir = join(workDir, 'pristine')
    const patchedDir = join(workDir, 'patched-reference')
    mkdirSync(pristineDir, { recursive: true })
    cleanup.push(workDir)
    new admZip(join(cacheDir, pristine)).extractAllTo(pristineDir, true)
    const pkgDir = join(pristineDir, 'node_modules', target.name)
    if (!existsSync(join(pkgDir, 'package.json'))) {
      fail(`${label}: pristine tarball ${pristine} 里没有 node_modules/${target.name}`)
      continue
    }

    let referenceDir
    let referenceLabel = '无'
    let sealedReference = false
    if (patched !== undefined) {
      mkdirSync(patchedDir, { recursive: true })
      new admZip(join(cacheDir, patched)).extractAllTo(patchedDir, true)
      referenceDir = join(patchedDir, 'node_modules', target.name)
      referenceLabel = `cache 封存副本 ${patched}`
      sealedReference = true
    } else {
      const installed = findInstalledCopy(target.name)
      if (installed !== undefined) {
        referenceDir = installed
        referenceLabel = `安装树顶层副本 ${installed.slice(root.length + 1)}`
      }
    }

    const result = inspectPatchAgainstTrees({
      patchText,
      patchFile,
      pkgDir,
      referenceDir,
      referenceLabel,
      sealedReference,
    })
    for (const message of result.problems) fail(`${label}: ${message}`)
    for (const message of result.notes) note(`${label}: ${message}`)
    if (result.problems.length > 0) continue
    if (!result.compared) uncompared += 1
    else if (sealedReference !== true) installedReference += 1

    const offsetNote = result.offset
      ? `  [偏移:${result.compared ? `已由${referenceLabel}逐字节对拍证明无害` : '未验证'}]`
      : ''
    const witness = result.compared
      ? `见证:${referenceLabel}`
      : '见证:无(结果等价性未验证)'
    report.push(
      `  ✓ ${label.padEnd(52)} ${result.touched.length} file(s)${offsetNote}  ${witness}`,
    )

    // 诊断:安装树里的未打补丁副本(修它需要 yarn install)。
    const unpatched = []
    for (const copy of listInstalledCopies(target.name)) {
      let version
      try {
        version = JSON.parse(readFileSync(join(copy, 'package.json'), 'utf8')).version
      } catch {
        continue
      }
      if (version !== target.version) continue
      // 与"pristine + 补丁"的结果对比:一致 = 这份副本已打补丁。
      const matchesPatched = result.touched.every((relative) => {
        const file = join(copy, relative)
        return existsSync(file) && sha256(file) === sha256(join(pkgDir, relative))
      })
      if (!matchesPatched) {
        unpatched.push(copy.slice(root.length + 1))
      }
    }
    if (unpatched.length > 0) {
      warn(
        `${target.name}@${target.version}: 安装树里有 ${unpatched.length} 份未打补丁的副本 —— `
        + `需要主 agent 跑 \`corepack yarn install\` 重解析 resolutions 后复跑(${unpatched.join(', ')})`,
      )
    }
  }

  if (patchFiles.length !== targets.length) {
    fail(`patches/ 下有 ${patchFiles.length} 个补丁文件,但 resolutions 只引用了 ${targets.length} 个`)
  }
} finally {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })
  rmSync(tempRoot, { recursive: true, force: true })
}

for (const message of warnings) process.stderr.write(`verify-patches: 警告: ${message}\n`)
for (const message of notes) process.stderr.write(`verify-patches: 提示: ${message}\n`)

if (failures.length > 0) {
  process.stderr.write(`\nverify-patches: ${failures.length} 项断言失败\n`)
  for (const message of failures) process.stderr.write(`- ${message}\n`)
  process.exit(1)
}

process.stdout.write(
  `verify-patches: OK — ${targets.length} 个补丁在仓库外临时树(${tmpdir()})的 pristine tarball 上`
  + '全部干净应用(无 fuzz / 无反向;每段都有 hunk,且与参照副本的改动集逐段对齐)'
  + (uncompared > 0
    ? `;其中 ${uncompared} 个补丁没有任何参照副本可对拍(结果等价性**未**验证)\n`
    : installedReference > 0
      // G-4(2026-09-23):见证是安装树副本时不能宣称"与 yarn 封存副本逐字节一致"。
      ? `,应用结果与参照副本逐字节一致(其中 ${installedReference} 个的参照是安装树副本而非 cache 封存副本)\n`
      : ',应用结果与 yarn 封存副本逐字节一致\n')
  + `${report.join('\n')}\n`
  + `  守卫自检:8 个合成夹具(零字节 / 丢段 / 多余段 / 截断 hunk / 无段头 / 完好)已驱动同一套判据\n`,
)
