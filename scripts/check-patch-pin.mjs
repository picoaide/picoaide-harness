#!/usr/bin/env node
/**
 * 补丁 ↔ 上游 pin 的版本绑定门禁。
 *
 * 为什么需要它（2026-09-20 DSH 0.1.6 升级审计，模块 H 判为 **P0 门禁盲区**）：
 *
 *   我们要打补丁的 4 个包（`dsh-subprocess-local` / `dsh-tool-fs-search` /
 *   `dsh-win32-process` / `dsh-client-ui-brand-official`）**根本不在任何 manifest
 *   的 deps/devDeps 里** —— 它们只靠 `resolutions` 的 patch 描述符接进来。
 *   而既有的三道防线各有盲区：
 *     · `verify-layout.mjs:190-197` 只查 4 个 manifest 的 `dependencies` +
 *       `peerDependencies`（**不含 `devDependencies`，也不看 `resolutions`**）；
 *     · `verify-patch-resolutions.mjs` / `verify-patches.mjs` 只做
 *       `resolutions ↔ patches/ ↔ .yarn/cache` 的**自洽**对拍，从不读 pin；
 *     · yarn 4.18.0 对**没有描述符命中**的 resolution 是**静默忽略**的。
 *
 *   合起来的效果：升级时漏改一条 resolution 版本 ⇒ yarn 按未打补丁的 pristine
 *   包安装、补丁**静默消失**，而三个门禁全绿。受害面是沙箱托管、全局搜索 asar
 *   路径、Windows 隐藏控制台、品牌样式 —— 全是"不报错但功能退化"的形态。
 *
 * 本门禁把这条链补上，断言四件事：
 *   1. 每条 `patch:` resolution 的目标版本 == `upstream.json` 的
 *      `runtimePackageVersion`（pin 的唯一真源）；resolution **键**里的版本同源；
 *   2. 该 patch 文件确实存在，且 `patches/` 下没有孤儿补丁；
 *   3. 对于**已安装**的补丁目标包，它的**实际版本**必须等于 pin —— 这是
 *      "resolution 静默失配"的直接判据：版本对不上说明描述符没命中，装进去的
 *      就是未打补丁的副本。**安装位置必须逐个 workspace 找**（2026-09-23 补）：
 *      本仓 `nmHoistingLimits: workspaces`，patched 包并不落在仓库根的
 *      `node_modules/`（根目录只有一个 `yaml`）⇒ 旧版按 `<root>/node_modules/<name>`
 *      找，**这份判据在本仓从未真正跑过**，而且因为根 `node_modules` 目录存在，
 *      连"未安装"的提示都没打印过（实测：运行 3 次全绿、判据 0 次执行）。
 *   4. 补丁文件名形如 `<包名>@<版本>.patch`（升级脚本按这个形状改名）。
 *   5. **内容级判据**（2026-09-23 第四轮门禁审计 R4-A-32，=D7）：每个登了记的补丁
 *      目标，其已安装副本里必须真的**含补丁新增的锚点**（锚点直接从补丁文件本身
 *      抽出来，不另抄一份会漂移的字面量；某段若是纯删除，则反向断言那些行**不再
 *      存在**）。判据 3 只比 `version` 字段，而 pristine 与打过补丁的副本**版本号
 *      完全相同** ⇒ 对"描述符没命中、装进去的是 pristine"天然失明（审计实测：
 *      `dsh-web-fetch-http` 还原成 pristine 后本门禁仍 exit 0）。锚点判据补上
 *      这一层：它读的是交付副本的内容，不需要 `.yarn/cache`，也不需要 pristine
 *      tarball。抽不出可判定的锚点（补丁不可读/段里没有任何内容行）时 **fail-loud**，
 *      绝不静默放过。
 *
 * 下限与"没装依赖"（2026-09-23 二轮审计 W3-10 + R3-C）：
 *   · `patches/` **目录整个缺失** ⇒ 红（与"目录在但为空"分开报，见下）；
 *   · 一条 DSH patch resolution 都没有（`checked === 0`）⇒ 红（空集不是通过）；
 *   · 判据 3 需要 `node_modules/<name>` 在场：**缺失/为空时它一条都跑不了**，
 *     所以默认 **fail-loud**（点名缺哪些包、说明这条断言为什么没跑）。
 *     要在未安装依赖的树上只查"resolution ↔ pin ↔ 文件名"的接线，显式传
 *     `--skip-installed`：它会打印"跳过 N 条、本次未证明命中"，不留静默路径。
 *
 * 第三方补丁（例如 `app-builder-lib`，非 `@deepseek-ai/dsh-*`）**豁免**版本绑定：
 * 它们跟随自己的版本线，与 DSH pin 无关。
 *
 * 自证：每次运行都跑 `selfTest()` —— 把本脚本复制进合成树、用**真实入口**跑四例
 * （空 `node_modules` 必红 / `--skip-installed` 显式跳过 / 已安装 == pin 必绿 /
 * 已安装 ≠ pin 必红并点名"未打补丁"），外加 R4-A-32 的内容级两例
 * （版本 == pin 但文件仍是 pristine ⇒ 必红并点名锚点 / 补丁抽不出锚点 ⇒ 必红）。
 * 只测辅助函数证明不了 main() 真的判了。
 *
 * 副本的"我是副本"标记走 **argv**（`--self-test-fence`，父进程自己构造），**不是**环境变量
 * —— 2026-09-25 的同族收口：`CHECK_PATCH_PIN_SKIP_SELF_TEST` 这个环境变量可在**任何语境**
 * （含 CI）关掉整段自证，且此前零判据拦它；现在它被废除，外部设置即 exit 2。
 *
 * 用法：`node scripts/check-patch-pin.mjs [--skip-installed]`；
 * 退出码 0 通过、1 有断言失败、2 = 外部设置了已废除的测试缝。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parsePatchSections } from './patch-targets.mjs'
// R5-D-6:核对面必须**派生**（打包白名单 + Node 解析顺序），不能是固定枚举根。
import { copyScanNodeModulesDirs, resolutionProbes } from './patch-copy-scan.mjs'
import { realpathSync } from 'node:fs'

const root = resolve(import.meta.dirname, '..')
const failures = []
const notes = []

/** 只有上游 DSH 家族的包跟随 pin；其余（第三方）豁免。 */
const PIN_BOUND = /^@deepseek-ai\/dsh-/

/** `--skip-installed`：显式声明"这棵树没装依赖"，只查接线（判据 3 不跑）。 */
const skipInstalled = process.argv.includes('--skip-installed')

/**
 * 自检子进程的 **argv** 开关（2026-09-25，第十三轮 R14-F 的同族收口）。
 *
 * `selfTest()` 把本脚本**复制**进合成树、用真实入口跑四例；副本必须不再派生子进程
 * （否则无穷递归）—— 这个"我是副本"的标记原先走环境变量
 * `CHECK_PATCH_PIN_SKIP_SELF_TEST`，而**环境是外部可改的输入面**：一句
 * `CHECK_PATCH_PIN_SKIP_SELF_TEST=1`（`$GITHUB_ENV` / `env` / 继承）就能让本守卫在
 * **任何语境**（含 CI）跳过整段合成树自证，且没有任何判据拦它。
 * 现改为父进程把 {@link SELF_TEST_FENCE_ARG} **追加到自己 argv 的副本**上 ——
 * 外部改不了父进程自己构造的 argv（改仓内文件则要先过 check-install-integrity 的
 * 执行体锚定与 check-root-guards 的 argv 登记校验）。
 */
const SELF_TEST_FENCE_ARG = '--self-test-fence'

/** 已**废除**的环境变量开关（只留名字给"外部设置即攻击面"的判据用）。 */
const RETIRED_SELF_TEST_ENV = 'CHECK_PATCH_PIN_SKIP_SELF_TEST'

/**
 * {@link RETIRED_SELF_TEST_ENV} 在**任何语境**下被设置 ⇒ exit 2。
 *
 * 修好之后它没有任何合法来源（自检副本走 argv），所以"它被设上了"只剩一种解释：
 * 有人想关掉本守卫的合成树自证。宁可红着停下，也不接受一句环境变量把判据摘掉。
 */
function refuseRetiredTestSeam() {
  const value = process.env[RETIRED_SELF_TEST_ENV]
  if (value === undefined || value === '') return
  console.error(`check-patch-pin: 测试缝已废除：环境变量 ${RETIRED_SELF_TEST_ENV} **任何语境下都不得设置**`
    + `（实际 ${JSON.stringify(value)}）—— 自检副本的标记已改由 argv 自调用（${SELF_TEST_FENCE_ARG}）传递，`
    + '这个环境变量没有合法来源，外部设置它一律视为攻击面（唯一效果是跳过整段合成树自证）。')
  process.exit(2)
}

refuseRetiredTestSeam()

/**
 * 解析一条 patch resolution。
 * 形状：`patch:<name>@npm%3A<version>#./patches/<file>.patch`
 * @param value - resolution 取值。
 * @returns 拆出的名字 / 版本 / 补丁相对路径；形状不符返回 undefined。
 */
function parsePatchValue(value) {
  const match = /^patch:(@?[^@]+)@npm%3A([^#]+)#(.+)$/.exec(value)
  if (match === null) return undefined
  return { name: match[1], version: match[2], patchPath: match[3].replace(/^\.\//u, '') }
}

/** 锚点行的最短长度（更短的行没有判别力，见 `isAnchorText`）。 */
const ANCHOR_MIN_LENGTH = 12
/** 锚点必须含至少一个非标点、非符号、非空白字符（滤掉 `*`、注释收尾符、`{` 这类结构行）。 */
const ANCHOR_HAS_CONTENT = /[^\p{P}\p{S}\s]/u

/**
 * 一行内容够不够格当锚点。
 * @param text - 已去掉 diff 前缀的原始行（保留缩进）。
 * @returns 是否可作为锚点。
 */
function isAnchorText(text) {
  const trimmed = text.trim()
  return trimmed.length >= ANCHOR_MIN_LENGTH && ANCHOR_HAS_CONTENT.test(trimmed)
}

/**
 * 从补丁文本里抽出**内容级锚点**（R4-A-32）。
 *
 * 锚点**只能**来自补丁文件本身：新增加的行 = "必须存在"，某段若没有任何新增行
 * （纯删除段）则改用被删除的行 = "必须不存在"。这样升级/重录补丁时锚点自己跟着走，
 * 不存在"另抄一份字面量、改了一边另一边漂移"的问题。段的边界与 hunk 行数由共享的
 * `parsePatchSections` 给出（不在这里另写一套 unified diff 解析）。
 *
 * @param patchText - 补丁文件内容。
 * @returns `{ sections, problems }`；sections 每项含
 *   `{ path, deletesFile, absent, anchors }`；problems 非空 = 无法判定（调用方 fail-loud）。
 */
function patchAnchors(patchText) {
  const lines = String(patchText ?? '').split(/\r?\n/u)
  const shape = parsePatchSections(patchText)
  const problems = [...shape.problems]
  const sections = []
  for (const section of shape.sections) {
    const added = []
    const removed = []
    for (const hunk of section.hunks) {
      let index = hunk.atLine
      let oldSeen = 0
      let newSeen = 0
      // 与 `parsePatchSections` 的 hunk 正文走法一致：吃到 `@@` 声明的行数为止，
      // 遇到结构行（下一段头 / hunk 头 / 空行）立即停。
      while (index < lines.length && (oldSeen < hunk.oldLines || newSeen < hunk.newLines)) {
        const body = lines[index]
        if (body === '' || body.startsWith('diff --git ') || body.startsWith('@@ ')) break
        if (body.startsWith('--- ') && (lines[index + 1] ?? '').startsWith('+++ ')) break
        if (body.startsWith('\\')) { index += 1; continue }
        if (body.startsWith(' ')) { oldSeen += 1; newSeen += 1; index += 1; continue }
        if (body.startsWith('-')) { oldSeen += 1; removed.push(body.slice(1)); index += 1; continue }
        if (body.startsWith('+')) { newSeen += 1; added.push(body.slice(1)); index += 1; continue }
        break
      }
    }
    const presentAnchors = added.filter(isAnchorText)
    const absentAnchors = removed.filter(isAnchorText)
    const absent = presentAnchors.length === 0 && absentAnchors.length > 0
    const anchors = absent ? absentAnchors : presentAnchors
    if (anchors.length === 0) {
      problems.push(
        `补丁段 ${section.path} 抽不出任何可判定的锚点（新增行 ${String(added.length)} 条、删除行 ${String(removed.length)} 条，`
        + `都短于 ${String(ANCHOR_MIN_LENGTH)} 字符或只有标点）—— 该段是否生效无法判定。`
        + '处置：确认补丁没有被截断；确属极短改动时，在补丁里保留一行更长的注释/代码作为锚点后重录。',
      )
    }
    sections.push({
      path: section.path,
      deletesFile: section.newPath === '/dev/null',
      absent,
      anchors,
    })
  }
  if (shape.sections.length === 0 && shape.problems.length === 0) {
    problems.push('补丁里解析不出任何文件段，锚点判据无从下手')
  }
  return { sections, problems }
}

/**
 * 在**一份已安装副本**里核对锚点（R4-A-32 判据 5）。
 *
 * @param args - `{ copy, copyLabel, patchPath, sections }`。
 * @returns `{ problems, checkedLines }`。
 */
function anchorProblemsForCopy({ copy, copyLabel, patchPath, sections }) {
  const problems = []
  let checkedLines = 0
  for (const section of sections) {
    const file = join(copy, section.path)
    if (section.deletesFile) {
      if (existsSync(file)) {
        problems.push(`${patchPath}: ${copyLabel} 里 ${section.path} 仍然存在，但补丁删除了它（该段未生效）`)
      }
      continue
    }
    if (!existsSync(file)) {
      problems.push(`${patchPath}: ${copyLabel} 里缺少补丁触及的文件 ${section.path}（该段未生效）`)
      continue
    }
    let lines
    try {
      lines = readFileSync(file, 'utf8').split(/\r?\n/u)
    } catch (error) {
      problems.push(`${patchPath}: ${copyLabel} 的 ${section.path} 读不出来（${String(error?.message ?? error)}）—— 锚点判据无法判定`)
      continue
    }
    checkedLines += section.anchors.length
    const hit = anchor => lines.includes(anchor)
    if (section.absent) {
      const stillThere = section.anchors.filter(hit)
      if (stillThere.length > 0) {
        problems.push(
          `${patchPath}: ${copyLabel} 的 ${section.path} 里仍能找到补丁**删除**的行（${String(stillThere.length)}/${String(section.anchors.length)}）—— `
          + `该段未生效；例：${JSON.stringify(stillThere[0].trim().slice(0, 80))}`,
        )
      }
      continue
    }
    const missing = section.anchors.filter(anchor => !hit(anchor))
    if (missing.length > 0) {
      problems.push(
        `${patchPath}: ${copyLabel} 的 ${section.path} 里缺少补丁**新增**的锚点（${String(missing.length)}/${String(section.anchors.length)}）—— `
        + `这份副本的字节不是补丁结果；例：${JSON.stringify(missing[0].trim().slice(0, 80))}`,
      )
    }
  }
  return { problems, checkedLines }
}

/**
 * 合成树自检（真实入口）：`node_modules` 空/缺、`--skip-installed`、已安装 ==/≠ pin、
 * 已安装 == pin 但字节仍是 pristine（R4-A-32 的内容级判据）、抽不出锚点必须 fail-loud。
 *
 * 副本靠环境变量掐断递归（副本不会再派生子进程）；每个副本都跑在各自的临时树里，
 * 树里放最小 `patches/` + `package.json`(resolutions) + `upstream.json`。
 */
function selfTest() {
  // 副本标记走 **argv**（父进程追加），不看环境 —— 见文件头"副本的'我是副本'标记"。
  if (process.argv.includes(SELF_TEST_FENCE_ARG)) return
  const scratch = mkdtempSync(join(tmpdir(), 'check-patch-pin-'))
  const pin = JSON.parse(readFileSync(join(root, 'upstream.json'), 'utf8')).runtimePackageVersion
  const name = '@deepseek-ai/dsh-probe'
  const patchFile = 'dsh-probe@' + pin + '.patch'
  const probeFile = 'lib/x.js'
  const pristineProbe = 'const probeValue = 1;\n'
  const patchedProbe = 'const probeValue = 2;\n'
  // 夹具补丁：一个文件段、一行新增、一行删除 —— 锚点就是那行新增内容。
  const fixturePatch = [
    `--- a/${probeFile}`,
    `+++ b/${probeFile}`,
    '@@ -1,1 +1,1 @@',
    '-const probeValue = 1;',
    '+const probeValue = 2;',
    '',
  ].join('\n')
  try {
    mkdirSync(join(scratch, 'scripts'))
    // 本脚本现在 import 共享解析器 `patch-targets.mjs`（锚点判据复用它的段/hunk
    // 边界解析）—— 合成树里必须一并放进去，否则副本连模块都加载不了。
    for (const file of ['check-patch-pin.mjs', 'patch-targets.mjs', 'patch-copy-scan.mjs']) {
      writeFileSync(
        join(scratch, 'scripts', file),
        readFileSync(join(import.meta.dirname, file)),
      )
    }
    writeFileSync(join(scratch, 'upstream.json'), JSON.stringify({ runtimePackageVersion: pin }))
    writeFileSync(join(scratch, 'package.json'), JSON.stringify({
      name: 'probe',
      resolutions: {
        [`${name}@npm:${pin}`]: `patch:${name}@npm%3A${pin}#./patches/${patchFile}`,
      },
    }))
    mkdirSync(join(scratch, 'patches'))
    writeFileSync(join(scratch, 'patches', patchFile), fixturePatch)
    const run = args => spawnSync(process.execPath, [join('scripts', 'check-patch-pin.mjs'), ...args, SELF_TEST_FENCE_ARG], {
      cwd: scratch,
      encoding: 'utf8',
      // 不再注入任何自检开关：副本靠 **argv** 认出自己（环境是外部可改的输入面）。
      env: { ...process.env },
    })
    const expect = (label, result, wantStatus, mustInclude) => {
      if (result.status !== wantStatus) {
        throw new Error(
          `check-patch-pin: self-test 失败 —— ${label} 期望 exit ${wantStatus}，实际 ${result.status}：`
          + `${(result.stdout + result.stderr).slice(0, 400)}`,
        )
      }
      if (mustInclude !== undefined && !`${result.stdout}${result.stderr}`.includes(mustInclude)) {
        throw new Error(
          `check-patch-pin: self-test 失败 —— ${label} 的输出里没有 ${JSON.stringify(mustInclude)}：`
          + `${(result.stdout + result.stderr).slice(0, 400)}`,
        )
      }
    }
    // ① node_modules 整个不存在 ⇒ 红（点名缺的包 + 说明判据 3 没跑）
    expect('缺 node_modules', run([]), 1, name)
    expect('缺 node_modules：必须说明判据 3 没跑', run([]), 1, '一个包都没验到')
    // ② node_modules 存在但为空（R3-C 记录的形态）⇒ 同样红，不能只因目录在就放过
    mkdirSync(join(scratch, 'node_modules'))
    expect('空 node_modules', run([]), 1, '一个包都没验到')
    // ③ 显式 --skip-installed ⇒ 绿，且必须打印"跳过 N 条"
    expect('--skip-installed', run(['--skip-installed']), 0, '跳过 1 个包')
    // ④ 补丁目标装上了但版本 ≠ pin ⇒ 红（判据 3 的正题：描述符没命中）
    const installed = join(scratch, 'node_modules', name)
    mkdirSync(join(installed, 'lib'), { recursive: true })
    writeFileSync(join(installed, 'package.json'), JSON.stringify({ name, version: '0.0.0-pristine' }))
    writeFileSync(join(installed, probeFile), patchedProbe)
    expect('已安装版本 ≠ pin', run([]), 1, '未打补丁')
    // ⑤ 已安装版本 == pin、文件也真的是补丁结果 ⇒ 绿，且 OK 行要打印真的校验条数
    writeFileSync(join(installed, 'package.json'), JSON.stringify({ name, version: pin }))
    expect('已安装版本 == pin', run([]), 0, '已安装版本校验 1 份拷贝')
    expect('已安装版本 == pin：必须打印锚点核对条数', run([]), 0, '内容级锚点校验 1 份拷贝')
    // ⑥ R4-A-32 的正题：版本号恰好还是 pin，但字节仍是 pristine ⇒ 必须红并点名锚点。
    //    （旧版只比 version 字段，这一形态下 exit 0 —— 审计 D7 实测。）
    writeFileSync(join(installed, probeFile), pristineProbe)
    expect('版本 == pin 但字节是 pristine', run([]), 1, '缺少补丁**新增**的锚点')
    // ⑦ 抽不出锚点（补丁没有可解析的文件段）⇒ fail-loud，绝不静默放过。
    writeFileSync(join(installed, probeFile), patchedProbe)
    writeFileSync(join(scratch, 'patches', patchFile), 'diff --git a/x b/x\n')
    expect('补丁抽不出锚点', run([]), 1, '无法判定')
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/**
 * 展开根 `workspaces` 里的 `<star>` 段（与仓库用法一致：单层星号段）。
 * @returns {string[]} 相对仓库根的 workspace 目录（含可能的重复，调用方不关心顺序）。
 */
function workspaceDirs() {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const out = []
  for (const pattern of manifest.workspaces ?? []) {
    let dirs = ['']
    for (const segment of pattern.split('/')) {
      const next = []
      for (const base of dirs) {
        if (segment !== '*') {
          next.push(base === '' ? segment : `${base}/${segment}`)
          continue
        }
        const baseDir = join(root, base === '' ? '.' : base)
        if (!existsSync(baseDir)) continue
        for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
          if (entry.isDirectory()) next.push(base === '' ? entry.name : `${base}/${entry.name}`)
        }
      }
      dirs = next
    }
    out.push(...dirs)
  }
  return out
}

/**
 * 找出某个包的**全部已安装拷贝**（仓库根 + 每个 workspace 的 `node_modules/`）。
 *
 * 本仓 `nmHoistingLimits: workspaces` ⇒ 同名的 patched 包会在多个 workspace 下各有一份，
 * 每一份都必须等于 pin；只看仓库根等于一份都没看（见文件头注释）。
 * @param {string[]} roots - 相对仓库根的安装根（`''` = 仓库根）。
 * @param {string} name - 包名。
 * @returns {{ path: string, dir: string, version: string }[]} 找到的拷贝
 *   （`path` = 相对仓库根的 package.json、`dir` = 包目录绝对路径、`version`）。
 */
function installedCopies(roots, name) {
  const copies = []
  const seen = new Set()
  const consider = dir => {
    const manifestPath = join(dir, 'package.json')
    if (!existsSync(manifestPath)) return
    let real = dir
    try {
      real = realpathSync(dir)
    } catch {
      // 读不到 realpath 就按原路径去重（不影响判定，只是可能多一条同源条目）。
    }
    if (seen.has(real)) return
    seen.add(real)
    copies.push({
      path: relative(root, manifestPath),
      dir,
      version: JSON.parse(readFileSync(manifestPath, 'utf8')).version,
    })
  }
  for (const base of ['', ...roots]) consider(join(root, base, 'node_modules', name))
  // **派生的枚举根**（R5-D-6）：仓库根 + 各 workspace + 应用根下每个随包子树（含一层
  // 子目录）。旧实现只有 `['', ...roots]`，于是
  // `packages/host/desktop/lib/node_modules/<pkg>` 这类"Node 解析优先、随包交付、
  // 又不在清单里"的影子副本完全不被核对。
  for (const item of copyScanNodeModulesDirs(root)) consider(join(item.dir, name))
  return copies
}

/**
 * **解析面**判据（R5-D-6）：Node 会解析到的副本必须都在核对面里。
 * @param name - 包名。
 * @param copies - `installedCopies()` 的结果。
 * @returns 影子副本（未被核对却会被解析到）的描述数组。
 */
function resolutionShadowCopies(name, copies) {
  const enumerated = copies.map(item => {
    try {
      return realpathSync(item.dir)
    } catch {
      return resolve(item.dir)
    }
  })
  const shadow = []
  for (const probe of resolutionProbes(root, name)) {
    if (probe.resolved === null) continue
    let resolvedReal
    try {
      resolvedReal = realpathSync(probe.resolved)
    } catch {
      resolvedReal = resolve(probe.resolved)
    }
    if (enumerated.some(dir => resolvedReal === dir || resolvedReal.startsWith(dir + '/'))) continue
    shadow.push(`${probe.resolvedRelative}（从 ${probe.from} 解析）`)
  }
  return shadow
}

/** 主流程：自检 → 判据 1/2/4 → 判据 3（含"没装依赖必须红"）→ 输出。 */
function main() {
  selfTest()

  const upstream = JSON.parse(readFileSync(join(root, 'upstream.json'), 'utf8'))
  const pin = upstream.runtimePackageVersion
  if (typeof pin !== 'string' || !/^\d+\.\d+\.\d+-/.test(pin)) {
    process.stderr.write(`check-patch-pin: upstream.json runtimePackageVersion 不合法: ${JSON.stringify(pin)}\n`)
    return 1
  }

  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const resolutions = manifest.resolutions ?? {}

  const patchDir = join(root, 'patches')
  // 目录**整个缺失**必须与"目录在但为空"区分开（2026-09-23 审计 W3-10）：
  // 旧写法 `existsSync ? readdirSync : []` 把两者合并成同一个空集 ⇒ 删除/改名/
  // 漏检出 `patches/` 时门禁打印 `OK — 0 个 DSH 补丁目标…（patches/ 共 0 个文件）`
  // 并 exit 0 —— 恰好在"补丁全丢"这种最该红的场景假绿。
  if (!existsSync(patchDir)) {
    failures.push(
      `找不到补丁目录 ${relative(root, patchDir)}/ —— 本门禁的全部判据（resolution 的版本 == upstream.json 的 pin、`
      + '补丁文件存在、文件名形状、已安装目标版本）都挂在 patches/ 下的补丁文件上，'
      + '目录整个缺失时对拍会退化成「0 个目标、全部通过」。'
      + '它被误删/改名/检出不完整时必须先恢复（`git ls-files patches/` 看该有哪些文件），再跑本门禁。',
    )
  }
  const patchFiles = existsSync(patchDir)
    ? readdirSync(patchDir).filter(file => file.endsWith('.patch')).sort()
    : []
  const referenced = new Set()
  let checked = 0
  let skippedThirdParty = 0
  let installedChecked = 0
  const missingInstalls = []
  // 同一个包会被 exact + `^` 两条 resolution 各点到一次：安装情况只算一次。
  const foundCopies = new Map()
  const installRoots = workspaceDirs()
  // 安装副本按包名缓存（判据 3 与内容级判据 5 共用，避免重复扫目录）。
  const copyCache = new Map()
  const copiesFor = (packageName) => {
    if (!copyCache.has(packageName)) copyCache.set(packageName, installedCopies(installRoots, packageName))
    // 解析面（R5-D-6）：Node 会解析到的副本必须在核对面里 —— 影子副本当场点名。
    for (const shadow of resolutionShadowCopies(packageName, copyCache.get(packageName))) {
      failures.push(
        `${packageName}: Node 会解析到**没有被核对**的副本 ${shadow} —— 解析面与核对面不一致。`
        + '\n  ⇒ 一份 pristine（或任意未核对的）副本放在"Node 解析优先、随包交付、但不在枚举里"'
        + '的位置即可让本门禁与 verify-patches 双双 EXIT=0（R5-D-6）。'
        + '\n  处置：把它从随包位置移除；确实需要该位置时按打包白名单加进 '
        + 'scripts/patch-copy-scan.mjs 的 copyScanNodeModulesDirs。',
      )
    }
    return copyCache.get(packageName)
  }
  /** 补丁目标（按 `<name>@<version>` 去重）——内容级判据 5 的核对清单。 */
  const anchorTargets = new Map()

  for (const [key, value] of Object.entries(resolutions)) {
    if (typeof value !== 'string' || !value.startsWith('patch:')) continue
    const parsed = parsePatchValue(value)
    if (parsed === undefined) {
      failures.push(`resolution ${JSON.stringify(key)} 的 patch 取值形状无法解析: ${JSON.stringify(value)}`)
      continue
    }
    referenced.add(parsed.patchPath)
    anchorTargets.set(`${parsed.name}@${parsed.version}`, parsed)
    if (!PIN_BOUND.test(parsed.name)) {
      skippedThirdParty += 1
      continue
    }
    checked += 1

    // 1. 取值里的版本 + 键里的版本都必须等于 pin。
    if (parsed.version !== pin) {
      failures.push(
        `resolution ${JSON.stringify(key)} 指向 ${parsed.name}@${parsed.version}，`
        + `但 upstream.json 的 pin 是 ${pin}（漏改这条 ⇒ yarn 静默忽略该 resolution、补丁消失）`,
      )
    }
    const keyVersion = /@npm:\^?(.+)$/u.exec(key)?.[1]
    if (keyVersion !== pin && keyVersion !== `^${pin}`) {
      failures.push(`resolution 键 ${JSON.stringify(key)} 的版本不是 ${pin} / ^${pin}（实际 ${JSON.stringify(keyVersion)}）`)
    }

    // 2. 补丁文件必须存在，且文件名里的版本段必须是 pin。
    //    命名约定 = 包名去掉 npm scope（`@deepseek-ai/`）后接 `@<pin>.patch`，
    //    与 `upgrade-upstream.mjs` 的 `migratePatchFiles()`（只替换版本段）一致。
    if (!existsSync(join(root, parsed.patchPath))) {
      failures.push(`resolution ${JSON.stringify(key)} 指向的补丁文件不存在: ${parsed.patchPath}`)
    } else {
      const actual = parsed.patchPath.replace(/^patches\//u, '')
      const base = parsed.name.replace(/^@[^/]+\//u, '')
      const expected = `${base}@${pin}.patch`
      if (actual !== expected) {
        failures.push(`补丁文件名 ${actual} 必须是 ${expected}（升级脚本按 <包名去 scope>@<pin>.patch 改名）`)
      }
    }

    // 3. 已安装的补丁目标（**每一份拷贝**）必须是 pin 版本（静默失配的直接判据）。
    if (foundCopies.has(parsed.name)) continue
    const copies = copiesFor(parsed.name)
    foundCopies.set(parsed.name, copies.length)
    for (const copy of copies) {
      installedChecked += 1
      if (copy.version !== pin) {
        failures.push(
          `已安装的 ${parsed.name}（${copy.path}）版本是 ${copy.version}，不是 pin ${pin} ——`
          + ' resolution 描述符没有命中，装进去的是**未打补丁**的副本',
        )
      }
    }
    if (copies.length === 0) missingInstalls.push(parsed.name)
  }

  // 4. 孤儿补丁：patches/ 下有文件但没有任何 resolution 引用它。
  for (const file of patchFiles) {
    if (!referenced.has(`patches/${file}`)) {
      failures.push(`patches/${file} 没有被任何 resolution 引用（孤儿补丁）`)
    }
  }

  // 5. 空集下限（2026-09-23 审计 W3-10 / 首轮 G-4）：一条 DSH 补丁目标都没校验到
  //    ⇒ 本门禁**什么都没证明**，不能以 OK 收尾。同族范本见
  //    `verify-patch-resolutions.mjs`（"既然仓库有 patches/,这里不该为空"）。
  if (checked === 0) {
    failures.push(
      '没有任何 DSH 补丁目标被校验：resolutions 里找不到指向 patches/ 的 `@deepseek-ai/dsh-*` patch 描述符，'
      + `而 patches/ 下有 ${patchFiles.length} 个补丁文件 —— 本门禁的判据全部挂在"至少有一条 DSH patch resolution"上，`
      + '整表被清空/改名（或 yarn.lock 与 resolutions 脱钩）时它会以「0 个目标、全部通过」假绿。'
      + '请确认 root package.json 的 resolutions 与 upstream.json 的 pin 仍然成对。',
    )
  }

  // 6. 判据 3 的输入不在场（2026-09-23 R3-C）：`node_modules` 缺失**或为空**时，
  //    那 N 条"已安装版本 == pin"一条都跑不了 —— 而它正是"resolution 静默失配"的
  //    唯一直接判据。旧版只在整个 node_modules 目录不存在时打一行提示，目录在但
  //    目标没装（空目录/只装了别的包）时**一个字都不打印就 OK**（实测假绿）。
  if (missingInstalls.length > 0) {
    const head = missingInstalls.slice(0, 5).join(', ')
    const rest = missingInstalls.length > 5 ? ` 等 ${missingInstalls.length} 个` : ''
    if (skipInstalled) {
      notes.push(
        `按 --skip-installed 跳过 ${missingInstalls.length} 个包的「已安装版本 == pin」判据（${head}${rest}）——`
        + ' 本次**未证明** resolution 描述符真的命中，只校验了 resolution ↔ pin ↔ 补丁文件名。',
      )
    } else {
      failures.push(
        `在任何 node_modules（仓库根 + ${installRoots.length} 个 workspace）里都找不到这 `
        + `${missingInstalls.length} 个补丁目标：${head}${rest} ——`
        + ' 「已安装的补丁目标版本 == pin」这条断言（判据 3：描述符是否命中、装进去的是不是未打补丁的副本）'
        + '**一个包都没验到**，所以本次无法证明补丁与 pin 一致。先 `yarn install`（CI：`yarn install --immutable`）'
        + '再跑本门禁；确实要在未安装依赖的树上只查接线，请显式传 --skip-installed。',
      )
    }
  }

  // 7. **内容级判据**（2026-09-23 第四轮门禁审计 R4-A-32）：判据 3 只比 `version`
  //    字段，而 pristine 与打过补丁的副本**版本号完全相同** ⇒ "描述符没命中、
  //    装进去的是 pristine"这种形态它天然看不见。这里改为直接读交付副本的**内容**：
  //    补丁新增的锚点必须真的在里面（纯删除段则断言被删的行不再出现）。锚点全部
  //    取自补丁文件本身 —— 不另抄一份会漂移的字面量。抽不出锚点 = fail-loud。
  let anchorCopiesChecked = 0
  let anchorLinesChecked = 0
  for (const target of anchorTargets.values()) {
    if (!existsSync(join(root, target.patchPath))) continue // 判据 2 已经报过"补丁文件不存在"
    let patchText
    try {
      patchText = readFileSync(join(root, target.patchPath), 'utf8')
    } catch (error) {
      failures.push(
        `${target.patchPath}: 补丁文件读不出来（${String(error?.message ?? error)}）—— 内容级锚点判据无法判定`,
      )
      continue
    }
    const parsedAnchors = patchAnchors(patchText)
    if (parsedAnchors.problems.length > 0) {
      failures.push(
        `${target.patchPath}: 内容级锚点判据**无法判定**（${parsedAnchors.problems.join('；')}）——`
        + ' 这条判据宁可 fail-loud 也不静默放过：请修好补丁文件的形状（每段都要有 hunk 与内容行）。',
      )
      continue
    }
    const copies = copiesFor(target.name).filter(copy => copy.version === target.version)
    if (copies.length === 0) {
      notes.push(
        `补丁 ${target.patchPath}: 安装树里没有 ${target.name}@${target.version} 的副本，内容级锚点判据未在场`
        + `（该判据需要已安装的交付副本；${skipInstalled ? '已按 --skip-installed 声明本树未安装依赖' : '先 `yarn install`'}）`,
      )
      continue
    }
    for (const copy of copies) {
      const verdict = anchorProblemsForCopy({
        copy: copy.dir,
        copyLabel: copy.path.replace(/\/package\.json$/u, ''),
        patchPath: target.patchPath,
        sections: parsedAnchors.sections,
      })
      for (const message of verdict.problems) failures.push(message)
      anchorCopiesChecked += 1
      anchorLinesChecked += verdict.checkedLines
    }
  }

  for (const message of notes) process.stdout.write(`check-patch-pin: 提示: ${message}\n`)
  if (failures.length > 0) {
    process.stderr.write(`\ncheck-patch-pin: ${failures.length} 项断言失败\n`)
    for (const message of failures) process.stderr.write(`- ${message}\n`)
    return 1
  }
  process.stdout.write(
    `check-patch-pin: OK — ${checked} 条 DSH patch resolution、${foundCopies.size} 个包绑定在 pin ${pin}`
    + `（已安装版本校验 ${installedChecked} 份拷贝；内容级锚点校验 ${anchorCopiesChecked} 份拷贝 × ${anchorLinesChecked} 条锚点；`
    + `第三方补丁豁免 ${skippedThirdParty} 条；patches/ 共 ${patchFiles.length} 个文件）\n`,
  )
  return 0
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main())
}
