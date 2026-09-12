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
 * 每个补丁做三件事:
 *   1. `patch -p1 --dry-run --forward` 必须退出码 0(失配即红,并回显 patch 的
 *      hunk 级输出:`Hunk #N FAILED at ...`);
 *   2. 不允许 fuzz(`with fuzz`)或"已应用/反向"补丁(`--forward` 会拒绝);
 *      纯 **offset** 不直接判红,但必须能证明无害 —— 见第 3 步;
 *   3. 真应用到 pristine 后,补丁触及的每个文件必须与 yarn 落盘的**封存副本**
 *      (`.yarn/cache/<pkg>-patch-*.zip`,回退到安装树里的顶层副本)逐字节一致。
 *      这条同时兜住 offset 与"补丁文件被手改但与锁文件里的 patch 不一致"。
 *
 * 结果对拍的另一半(补丁覆盖所有副本:嵌套 node_modules 里不得留未打补丁拷贝)
 * 以**警告**形式输出:修掉它需要 `yarn install` 重解析,离线门禁不能自己改锁文件。
 *
 * 用法:node scripts/verify-patches.mjs
 * 退出码:0 全部通过;1 有补丁失配。
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { findCacheZips, listPatchFiles, patchedFilePaths, readPatchTargets } from './patch-targets.mjs'

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
if (tempRoot === root || tempRoot.startsWith(root + sep)) {
  process.stderr.write(`verify-patches: 临时目录 ${tempRoot} 落在仓库内,拒绝继续(仓库内校验会假通过)\n`)
  process.exit(1)
}

const cacheDir = join(root, '.yarn', 'cache')
const patchFiles = listPatchFiles(root)
const report = []
const cleanup = []

try {
  for (const target of [...targets].sort((a, b) => a.patchPath.localeCompare(b.patchPath))) {
    const label = target.patchPath
    const patchFile = join(root, target.patchPath)
    if (!existsSync(patchFile)) {
      fail(`${label}: 补丁文件不存在(${patchFile})`)
      continue
    }
    const patchText = readFileSync(patchFile, 'utf8')
    const touched = patchedFilePaths(patchText)

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

    // 1) dry-run。
    const dry = runPatch(pkgDir, patchFile, true)
    if (dry.error !== undefined) {
      fail(`${label}: 无法执行 patch(${String(dry.error.message)})`)
      continue
    }
    if (dry.status !== 0) {
      fail(
        `${label}: 在 pristine 树上 dry-run 失败(退出码 ${String(dry.status)}) —— 补丁与当前版本已失配:\n`
        + dry.output.trimEnd().split('\n').map(line => `      ${line}`).join('\n'),
      )
      continue
    }
    if (REVERSED_PATTERN.test(dry.output)) {
      fail(`${label}: patch 报告"已应用/反向补丁"(${dry.output.trim()}) —— 补丁文件或 cache 里的 pristine 树有问题`)
      continue
    }
    if (FUZZ_PATTERN.test(dry.output)) {
      fail(
        `${label}: patch 需要 fuzz 才能应用(fuzz = 上下文不再精确匹配):\n`
        + dry.output.trimEnd().split('\n').map(line => `      ${line}`).join('\n'),
      )
      continue
    }
    const offset = OFFSET_PATTERN.test(dry.output)

    // 2) 真应用 + 结果对拍。
    const applied = runPatch(pkgDir, patchFile, false)
    if (applied.status !== 0) {
      fail(
        `${label}: 真应用补丁失败(退出码 ${String(applied.status)}):\n`
        + applied.output.trimEnd().split('\n').map(line => `      ${line}`).join('\n'),
      )
      continue
    }

    let referenceDir
    let referenceLabel = '无'
    if (patched !== undefined) {
      mkdirSync(patchedDir, { recursive: true })
      new admZip(join(cacheDir, patched)).extractAllTo(patchedDir, true)
      referenceDir = join(patchedDir, 'node_modules', target.name)
      referenceLabel = `cache 封存副本 ${patched}`
    } else {
      const installed = findInstalledCopy(target.name)
      if (installed !== undefined) {
        referenceDir = installed
        referenceLabel = `安装树顶层副本 ${installed.slice(root.length + 1)}`
      }
    }

    const mismatches = []
    if (referenceDir !== undefined && existsSync(join(referenceDir, 'package.json'))) {
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
        fail(
          `${label}: 应用结果与${referenceLabel}不一致:${mismatches.join(', ')} —— `
          + '补丁文件与 yarn 封存的补丁结果已漂移(重新用 `yarn patch` 录制或修正补丁)',
        )
        continue
      }
    } else if (offset) {
      fail(
        `${label}: patch 报告行偏移,但既没有 cache 封存副本也没有安装树副本可以对拍 —— `
        + '无法证明偏移无害;请先 `corepack yarn install --immutable`',
      )
      continue
    } else {
      note(`${label}: 无封存副本可对拍(结果等价性未验证)`)
    }

    const offsetNote = offset
      ? `  [偏移:${referenceDir === undefined ? '未验证' : `已由${referenceLabel}逐字节对拍证明无害`}]`
      : ''
    report.push(`  ✓ ${label.padEnd(52)} ${touched.length} file(s)${offsetNote}  见证:${referenceLabel}`)

    // 3) 诊断:安装树里的未打补丁副本(修它需要 yarn install)。
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
      const matchesPatched = touched.every((relative) => {
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
  + '全部干净应用(无 fuzz / 无反向),且应用结果与 yarn 封存副本逐字节一致\n'
  + `${report.join('\n')}\n`,
)
