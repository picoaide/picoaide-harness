#!/usr/bin/env node
/**
 * 「冻结启动器」的**行为探针**（第十三轮 R13-D-02 的收口件；第十四轮 V13-A §3.3 / R1 的补修）。
 *
 * ## 现场（为什么静态判据不够）
 *
 * R13-D-02 的实测载荷**不碰 git、不改任何被跟踪文件**：只把假 `node` 目录写进
 * `$GITHUB_PATH`（那行写在某个 `.sh` 里 ⇒ 读 YAML 的静态判据看不见）⇒ 探针 / 编排器 /
 * **凭据检查器**三次 `node` 调用全部被替换，假 `node` 按 `--nonce-file` 自己把凭据回显回去，
 * 于是 `EXIT=0`、工作树干净、日志里凭据"齐全"。
 *
 * ## 收口（两半，缺一不可）
 *
 * ① **冻结"步骤命令位"的启动器**：**第一个执行体**（在任何仓内代码跑过之前）把
 *    `command -v node/bash/git` 的**绝对路径**与当时的 `$PATH` 写进**步骤输出**
 *    （`$GITHUB_OUTPUT`）。步骤输出在步骤结束时被 runner 读走、存进 runner 自己的状态；
 *    后续步骤里的仓内进程**改不到**它 —— 于是判据步一律用
 *    `"${{ steps.frozen-launchers.outputs.node }}"`（runner 侧展开的绝对路径）调用 node。
 * ② **复位 `PATH`**（V13-A §3.3 / R1 实测的洞）：只冻结"步骤命令位"冻不到**仓内脚本体**
 *    里的裸命令 —— `"${{ …outputs.interp }}" scripts/<x>.sh` 里的 `node` 仍按活的 `$PATH`
 *    解析。实测复现：真错误状态下 `group 2 pass=2 fail=1 / EXIT=1`，前置一个只拦
 *    `check-deletion-surface.mjs`、其余转发真 node 的假 `node` ⇒ `pass=3 fail=0 / EXIT=0`。
 *    所以**每个跑仓内执行体的判据步**都必须在任何仓内命令之前
 *    `export PATH="${{ steps.<冻结点>.outputs.path }}"`；两个冻结点：
 *      · `frozen-launchers`：工具链就位之前那份（早于 setup-node 的判据步用它）；
 *      · `frozen-toolchain`：把冻结 PATH 与**白名单内**（`${{ runner.tool_cache }}/node/`）
 *        的工具链目录合成的可用值 —— 其它任何新增目录即红（`$GITHUB_PATH` 注入的痕迹）。
 *
 * ## 本探针做的不是"再写一遍静态判据"，而是把上面两件事**真的跑一遍**
 *
 *   · **逐 job 解析冻结点**（V13-A 的 R5：旧版只验"一对 (job, 冻结点)"，删掉某个 job 的冻结步
 *     时探针会**退到另一个** job 的冻结点上继续 EXIT=0）—— 现在每个登记 job 各跑一次冻结步体；
 *   · **逐判据步取证**：把 `ci.yml` 里**每个**"以仓内脚本为执行体"的判据步体**按原字节**拿到
 *     一个**金丝雀仓**（scratch git repo：每个被引用的仓内路径都换成一个"记录被调用 + 做一次
 *     裸 `node` 调用"的金丝雀）里跑一遍，断言：真跑到执行体、且假 `node` **零调用**；
 *   · **正控 A**（整份冻结拆除）：把冻结表达式换回裸命令名**并**删掉 PATH 复位 ⇒ 同一个载荷
 *     必须能把判据换掉；
 *   · **正控 B**（R1 形态：只冻结解释器、不复位 PATH）：保留冻结表达式、**只**删掉那一行
 *     `export PATH=…` ⇒ 脚本体里的裸 `node` **必须**命中假 node。这条正控就是 R1 的形状 ——
 *     它被打红才说明"复位 PATH"这一半是承重的，而不是注释。
 *   · 另有一个**端到端**格子：把 `gate-guards` 的判据步体按原字节（`${{ … }}` 换成冻结值）
 *     在**真仓**里跑一遍，要求它仍然跑到**真判据**并留下通过凭据。
 *
 * 没有正控的探针只能证明"绿"，证明不了"它抓得住"。
 *
 * ## 残余边界（认账，不许写成"完全收口"）
 *
 *   · GitHub 托管 runner 上 runner 用户有**免密 sudo**（官方文档明说），同 job 内任意代码
 *     理论上仍可替换**任何主机侧路径**（`/usr/bin/node`、`/opt/hostedtoolcache/…`）。
 *     本判据收口的是 **`$PATH` 注入**这条**低成本**通道（一行 `echo … >> "$GITHUB_PATH"`，
 *     不需要任何权限提升、不改任何文件）；它不承诺"启动器不可被替换"。
 *   · 合成的 PATH 里**工具链目录**是按白名单（`${{ runner.tool_cache }}/node/`）放行的：
 *     白名单之外的注入会被抓，但白名单**内部**的替换（需要写权限/免密 sudo）不在判据面内。
 *   · `openssl` 等**外部工具**不再逐个写冻结点输出：复位 `PATH` 之后它们与 `node`/`git`/`bash`
 *     走**同一份**解析面（`check-workflows.mjs` 的 `FROZEN_LAUNCHER_EXTERNAL_TOOLS` 是它们的
 *     登记表 —— 判据步里新出现一个未登记的外部命令即红）。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/check-frozen-launchers.mjs --root "$PWD"      # CI：gate-guards 的一个判据步
 * ```
 *
 * `--workflow <path>`（缺省 `.github/workflows/ci.yml`）、`--freeze-step-id <id>`
 * （缺省 `frozen-launchers`）、`--toolchain-step-id <id>`（缺省 `frozen-toolchain`）、
 * `--json <path>`。退出码：0 = 通过；1 = 断言失败（冻结未生效 / 正控抓不到载荷 /
 * 判据步没有复位 PATH）；2 = 输入不可用。
 */

import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

/** 必须逐 job 解析冻结点的 job（与 `check-workflows.mjs` 的 `FROZEN_LAUNCHER_JOBS` 同一份登记）。 */
const PINNED_JOBS = ['gate-guards', 'gate']
/** 冻结步必须写出的输出键（与 `check-workflows.mjs` 的 `FROZEN_LAUNCHER_OUTPUT_KEYS` 同源）。 */
const FREEZE_OUTPUT_KEYS = ['node', 'interp', 'git', 'path']

/** 正控/反控共用的假 `node`：留下标记文件，并打印一条"看起来通过"的凭据。 */
const FAKE_NODE_SOURCE = `#!/bin/sh
printf '%s\\n' "$0 $*" >> "\${FAKE_NODE_MARKER:?}"
printf 'check-install-integrity: VERDICT PASS judge-bodies=99 manifests=99 head=deadbeefcafe github-sha=%s\\n' "\${GITHUB_SHA:-0}"
exit 0
`

/**
 * 金丝雀（仓内 `.sh` 执行体）：记录自己被调用，并且**做一次裸 `node` 调用** ——
 * 裸命令的解析面就是"判据步体里那一行 `export PATH=…` 到底有没有生效"的判据。
 */
const CANARY_SHELL_SOURCE = `#!/bin/sh
printf 'CANARY %s\\n' "$0" >> "\${CANARY_LOG:?}"
node -e 'process.exit(0)'
`

/**
 * 金丝雀（仓内 `.mjs`/`.ts` 执行体）：记录自己被调用，并 **spawn 一个裸 `node` 子进程**
 * （真实执行体如 `check-root-guards.mjs` 也会经 `corepack`/`node` 起子进程 —— 子进程的
 * 解析面正是这一格要验的东西）。
 */
const CANARY_MJS_SOURCE = `import { spawnSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
appendFileSync(process.env.CANARY_LOG, \`CANARY \${process.argv[1]}\\n\`)
spawnSync('node', ['-e', 'process.exit(0)'], { stdio: 'ignore' })
`

/** `export PATH="${{ steps.<id>.outputs.path }}"`（逐字、两端锚定；与 [SK-17]/[SK-20] 同一份形态）。 */
const FROZEN_PATH_EXPORT = /^export\s+PATH="\$\{\{\s*steps\.(frozen-launchers|frozen-toolchain)\.outputs\.path\s*\}\}"$/u
/** 命令位的冻结表达式。 */
const FROZEN_EXPRESSION_COMMAND_POSITION = /(?:^|[\n;&|(]|&&|\|\|)\s*"\$\{\{\s*steps\.([A-Za-z0-9_-]+)\.outputs\.[A-Za-z0-9_-]+\s*\}\}"/u
/** 命令位直接跑仓内路径。 */
const REPO_PATH_COMMAND_POSITION = /(?:^|[\n;&|(]|&&|\|\|)\s*(?:\.\/)?(?:scripts|packages|integration-tests)\//u
/** 步骤体里出现的仓内路径 token（用来给金丝雀仓铺文件）。 */
const REPO_PATH_TOKEN = /(?:^|[\s"'=(:[])((?:\.\/)?(?:scripts|packages|integration-tests|community)\/[A-Za-z0-9._@/-]+)/gu

/**
 * 从 workflow 文本里抽出某个步骤的 `run:` 块体（**缩进扫描**，不需要 YAML 解析器）。
 *
 * 为什么要自己抽：本探针要执行的正是 **ci.yml 里那一段真字节**（不是另写一份"等价"的），
 * 否则它证明的是探针自己而不是产线。步骤定位按 `- name:` 的**逐字**匹配。
 * @param text - workflow 文本。
 * @param stepName - 步骤名（逐字）。
 * @returns 步骤体的行数组（已去掉公共缩进）；找不到 ⇒ `null`。
 */
export function extractStepRunBody(text, stepName) {
  const lines = String(text).split('\n')
  const anchor = lines.findIndex(line => /^\s*-\s*name:\s*/u.test(line) && line.includes(stepName))
  if (anchor < 0) return null
  let runIndex = -1
  for (let index = anchor + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^\s*-\s*(name|uses|id):/u.test(line)) break
    if (/^\s*(?:-\s*)?run:\s*\|/u.test(line)) { runIndex = index; break }
    if (/^\s*(?:-\s*)?run:\s*\S/u.test(line)) { runIndex = index; break }
  }
  return runIndex < 0 ? null : runBodyFrom(lines, runIndex, lines.length)
}

/**
 * 抽出一个**顶层** `key:` 标量（用于取步骤的 `id:`）。只用于自检与提示，不参与判决。
 * @param text - workflow 文本。
 * @param stepName - 步骤名。
 * @param key - 键名。
 * @returns 取值；找不到 ⇒ `null`。
 */
export function stepScalar(text, stepName, key) {
  const lines = String(text).split('\n')
  const anchor = lines.findIndex(line => /^\s*-\s*name:\s*/u.test(line) && line.includes(stepName))
  if (anchor < 0) return null
  for (let index = anchor; index < lines.length; index += 1) {
    if (index > anchor && /^\s*-\s*(name|uses):/u.test(lines[index])) break
    const value = scalarOnLine(lines[index], key)
    if (value !== null) return value
  }
  return null
}

/**
 * 读一行里的**顶层 `key: 取值`** 标量。
 *
 * **不要**改回 `new RegExp(\`^\\s*${key}:…\`)`：`key` 与待比较的取值都来自调用方 /
 * 命令行参数，动态构造 RegExp 会被 CodeQL 判为 `js/regex-injection`（high）——
 * 本仓的 Code Scanning 门禁会因此变红（第十三轮 PR #149 实测两条）。
 * 这里用**字面量正则 + 纯字符串比较**，语义与原来逐字相同。
 *
 * @param line - 一行文本。
 * @param key - 键名（与捕获到的键做**字符串**比较，不进正则）。
 * @returns 取值（已 trim）；该行不是这个键 / 取值为空 ⇒ `null`。
 */
function scalarOnLine(line, key) {
  const match = /^\s*(?:-\s*)?([A-Za-z0-9_-]+):\s*(\S.*)?$/u.exec(line)
  if (match === null || match[1] !== key) return null
  if (match[2] === undefined) return null
  const value = match[2].trim()
  return value === '' ? null : value
}

/** 一行的缩进宽度。 */
function indentOf(line) {
  const match = /^(\s*)/u.exec(line)
  return match === null ? 0 : match[1].length
}

/**
 * 把 shell 的行继续（行尾 `\`）接起来 —— "命令位"判定要在**逻辑行**上做。
 * @param script - 步骤体文本。
 * @returns 逻辑行数组。
 */
function joinLogicalLines(script) {
  const joined = []
  let buffer = ''
  for (const line of String(script).split('\n')) {
    if (/\\$/u.test(line)) {
      buffer += `${line.replace(/\\$/u, ' ')}`
      continue
    }
    joined.push(`${buffer}${line}`)
    buffer = ''
  }
  if (buffer !== '') joined.push(buffer)
  return joined
}

/**
 * `jobs:` 下的顶层 job（缩进 2 的键）及其行区间。
 * @param lines - workflow 的全部行。
 * @returns `[{ id, start, end }]`。
 */
function parseJobs(lines) {
  const jobsLine = lines.findIndex(line => /^jobs:\s*$/u.test(line))
  if (jobsLine < 0) return []
  const jobs = []
  for (let index = jobsLine + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '' || /^\s*#/u.test(line)) continue
    if (indentOf(line) === 0) break
    const match = /^ {2}([A-Za-z0-9_-]+):\s*$/u.exec(line)
    if (match !== null) jobs.push({ id: match[1], start: index, end: lines.length })
  }
  for (let index = 0; index < jobs.length; index += 1) {
    if (index + 1 < jobs.length) jobs[index].end = jobs[index + 1].start
  }
  return jobs
}

/**
 * 一个 job 里的步骤（按 `steps:` 下第一项的缩进取列表项）。
 * @param lines - workflow 的全部行。
 * @param start - job 起始行。
 * @param end - job 结束行（不含）。
 * @returns `[{ start, end, name, id, run }]`。
 */
function parseSteps(lines, start, end) {
  let stepsLine = -1
  for (let index = start; index < end; index += 1) {
    if (/^\s*steps:\s*$/u.test(lines[index])) { stepsLine = index; break }
  }
  if (stepsLine < 0) return []
  const steps = []
  let itemIndent = -1
  for (let index = stepsLine + 1; index < end; index += 1) {
    const line = lines[index]
    if (line.trim() === '') continue
    const indent = indentOf(line)
    if (indent <= indentOf(lines[stepsLine])) break
    if (itemIndent < 0) itemIndent = indent
    if (indent === itemIndent && /^\s*- /u.test(line)) steps.push({ start: index, end })
  }
  for (let index = 0; index < steps.length; index += 1) {
    if (index + 1 < steps.length) steps[index].end = steps[index + 1].start
  }
  for (const step of steps) {
    step.name = null
    step.id = null
    let runIndex = -1
    for (let index = step.start; index < step.end; index += 1) {
      const id = scalarOnLine(lines[index], 'id')
      if (id !== null && step.id === null) step.id = id
      const name = scalarOnLine(lines[index], 'name')
      if (name !== null && step.name === null) step.name = name
      if (runIndex < 0 && /^\s*(?:-\s*)?run:\s*(?:\||\S)/u.test(lines[index])) runIndex = index
    }
    step.run = runIndex < 0 ? null : runBodyFrom(lines, runIndex, step.end).join('\n')
  }
  return steps
}

/**
 * 从 `run:` 那一行开始抽块体（去公共缩进）。
 * @param lines - 全部行。
 * @param runIndex - `run:` 所在行。
 * @param end - 扫描上界（不含）。
 * @returns 行数组。
 */
function runBodyFrom(lines, runIndex, end) {
  const inline = /^\s*(?:-\s*)?run:\s*(\S.*)$/u.exec(lines[runIndex])
  // `run: |` / `run: >` 是块标量指示符，不是内联脚本（`|` 也是 `\S` ⇒ 必须先排掉）。
  if (inline !== null && !/^[|>]/u.test(inline[1])) return [inline[1]]
  const runIndent = indentOf(lines[runIndex])
  const body = []
  for (let index = runIndex + 1; index < end; index += 1) {
    const line = lines[index]
    if (line.trim() !== '' && indentOf(line) <= runIndent) break
    body.push(line)
  }
  const indents = body.filter(line => line.trim() !== '').map(indentOf)
  const common = indents.length === 0 ? 0 : Math.min(...indents)
  return body.map(line => line.slice(common))
}

/**
 * 这一步是不是"跑仓内执行体的判据步"（命令位出现冻结表达式或仓内路径）。
 * @param run - 步骤的 `run` 文本。
 * @returns 是否判据步。
 */
function isJudgeStepRun(run) {
  for (const line of joinLogicalLines(run)) {
    const code = line.replace(/#.*$/u, '').trim()
    if (FROZEN_PATH_EXPORT.test(code)) continue
    if (FROZEN_EXPRESSION_COMMAND_POSITION.test(code)) return true
    if (REPO_PATH_COMMAND_POSITION.test(code)) return true
  }
  return false
}

/** 步骤体里"复位 PATH"那一行的逻辑行下标；没有 ⇒ -1。 */
function pathExportLine(run) {
  const lines = joinLogicalLines(run)
  for (let index = 0; index < lines.length; index += 1) {
    if (FROZEN_PATH_EXPORT.test(lines[index].replace(/#.*$/u, '').trim())) return index
  }
  return -1
}

/** 步骤体里第一次"执行仓内东西"的逻辑行下标（复位行不算）；没有 ⇒ -1。 */
function firstInvocationLine(run) {
  const lines = joinLogicalLines(run)
  for (let index = 0; index < lines.length; index += 1) {
    const code = lines[index].replace(/#.*$/u, '').trim()
    if (FROZEN_PATH_EXPORT.test(code)) continue
    if (FROZEN_EXPRESSION_COMMAND_POSITION.test(code)) return index
    if (REPO_PATH_COMMAND_POSITION.test(code)) return index
  }
  return -1
}

/** 删掉"复位 PATH"那一行（正控 B 用：只拆掉这一半）。 */
function stripPathExport(text) {
  return String(text)
    .split('\n')
    .filter(line => !FROZEN_PATH_EXPORT.test(line.replace(/#.*$/u, '').trim()))
    .join('\n')
}

/**
 * 把 runner 侧展开的表达式换成冻结值：
 *   · `${{ steps.<id>.outputs.<key> }}` ⇒ 对应冻结点那一次运行的输出；
 *   · `${{ runner.tool_cache }}` ⇒ 同名环境变量（本机复刻时缺省空串）。
 * 剩下的未展开表达式由调用方按"引用了不存在的冻结点"报红（runner 会把它展开成空串，
 * 而那正是"没有启动器"的形态）。
 */
function substituteFrozenOutputs(text, outputsByStepId) {
  let result = String(text).replaceAll('\${{ runner.tool_cache }}', process.env.RUNNER_TOOL_CACHE ?? '')
  for (const [id, outputs] of Object.entries(outputsByStepId)) {
    for (const [key, value] of Object.entries(outputs)) {
      result = result.replaceAll(`\${{ steps.${id}.outputs.${key} }}`, String(value))
    }
  }
  return result
}

/** 步骤体里出现的仓内路径 token（去重、排序）。 */
function repoPathTokens(text) {
  const tokens = new Set()
  for (const match of String(text).matchAll(REPO_PATH_TOKEN)) {
    const token = match[1].replace(/^\.\//u, '').replace(/[.,;:]+$/u, '')
    if (token === '' || token.includes('..')) continue
    tokens.add(token)
  }
  return [...tokens].sort()
}

/** 仓内执行体的金丝雀源码（`.sh`/`.bash` 走 shell，其余走 JS）。 */
function canarySourceFor(path) {
  return /\.(?:sh|bash)$/u.test(path) ? CANARY_SHELL_SOURCE : CANARY_MJS_SOURCE
}

/**
 * 跑判据主流程。
 * @param argv - 命令行参数。
 * @returns 退出码。
 */
function main(argv) {
  const options = {
    root: process.cwd(),
    workflow: '.github/workflows/ci.yml',
    freezeStepId: 'frozen-launchers',
    toolchainStepId: 'frozen-toolchain',
    json: null,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const value = argv[index + 1]
    if (!['--root', '--workflow', '--freeze-step-id', '--toolchain-step-id', '--json'].includes(argument)) {
      process.stderr.write(`check-frozen-launchers: 未知参数 ${argument}\n`)
      return 2
    }
    if (value === undefined || value.startsWith('--')) {
      process.stderr.write(`check-frozen-launchers: \`${argument}\` 需要一个取值\n`)
      return 2
    }
    index += 1
    if (argument === '--root') options.root = value
    else if (argument === '--workflow') options.workflow = value
    else if (argument === '--freeze-step-id') options.freezeStepId = value
    else if (argument === '--toolchain-step-id') options.toolchainStepId = value
    else options.json = value
  }

  const root = resolve(options.root)
  const workflowPath = resolve(root, options.workflow)
  if (!existsSync(workflowPath)) {
    process.stderr.write(`check-frozen-launchers: 读不到 workflow ${workflowPath}\n`)
    return 2
  }
  if (!existsSync(join(root, '.git'))) {
    process.stderr.write(`check-frozen-launchers: ${root} 不是 git 检出（判据步体会用 \`git show HEAD:\` 取探针）\n`)
    return 2
  }
  const workflowText = readFileSync(workflowPath, 'utf8')
  const lines = workflowText.split('\n')
  const jobs = parseJobs(lines)
  if (jobs.length === 0) {
    process.stderr.write('check-frozen-launchers: ci.yml 里解析不出任何 job（读不出 ⇒ 不当成"没有"）\n')
    return 2
  }

  const failures = []
  const notes = []
  const scratch = mkdtempSync(join(tmpdir(), 'frozen-launcher-'))
  const work = join(scratch, 'work')
  const fakebin = join(scratch, 'fakebin')
  mkdirSync(work, { recursive: true })
  mkdirSync(fakebin, { recursive: true })
  const fakeNode = join(fakebin, 'node')
  writeFileSync(fakeNode, FAKE_NODE_SOURCE)
  chmodSync(fakeNode, 0o755)
  // 判据步体会在 `$RUNNER_TEMP` 下 `mkdir` 自己的独占目录 ⇒ 父目录必须先存在
  // （GitHub runner 上它本来就在；本地探针要自己建）。
  mkdirSync(join(scratch, 'runner-temp'), { recursive: true })

  const runShell = (script, env, cwd = work) => spawnSync('bash', ['-e', '-o', 'pipefail', '-c', script], {
    cwd,
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 32 * 1024 * 1024,
    env: { HOME: scratch, ...env },
  })

  // 平台锚值：CI 上必须用 `$GITHUB_SHA`（runner 注入、仓内代码改不到）；本地没有它时
  // 退回本地 HEAD —— 否则把**空串**喂给判据步体会让 `check-install-integrity` 判
  // 「平台锚缺席」而 exit 2，探针在本地永远红（第十三轮修复批自测时踩到）。
  const headRev = runShell('git rev-parse HEAD', { PATH: process.env.PATH ?? '/usr/bin:/bin' }, root)
  const anchorSha = (process.env.GITHUB_SHA ?? '').trim() !== ''
    ? String(process.env.GITHUB_SHA).trim()
    : String(headRev.stdout ?? '').trim()

  try {
    /** 跑一个"冻结点步骤体"并把它的步骤输出解析成对象。 */
    const runFreezeBody = (body, extraOutputs = {}) => {
      const outputFile = join(scratch, `github-output-${Math.random().toString(36).slice(2)}`)
      writeFileSync(outputFile, '')
      const substituted = substituteFrozenOutputs(body, extraOutputs)
      const result = runShell(substituted, {
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        GITHUB_OUTPUT: outputFile,
        GITHUB_PATH: join(scratch, 'github-path'),
        GITHUB_ENV: join(scratch, 'github-env'),
        RUNNER_TEMP: join(scratch, 'runner-temp'),
        GITHUB_SHA: anchorSha,
        // `${{ runner.tool_cache }}` 是 runner 侧展开的常量；本机复刻时按同名环境变量取，
        // 缺省空（⇒ 合成步只认"冻结那份"，本地没有工具链新增目录 ⇒ 结论不受影响）。
        RUNNER_TOOL_CACHE: process.env.RUNNER_TOOL_CACHE ?? '',
      })
      const outputs = {}
      for (const line of readFileSync(outputFile, 'utf8').split('\n')) {
        const match = /^([A-Za-z_][A-Za-z0-9_-]*)=(.*)$/u.exec(line)
        if (match !== null) outputs[match[1]] = match[2]
      }
      return { result, outputs, substituted }
    }

    /** 冻结点：**逐 job** 解析（V13-A 的 R5 —— 旧版只验一对，删掉一个 job 的冻结步会退到另一个）。 */
    const freezeOutputsByJob = new Map()
    const judgeSteps = []
    for (const job of jobs) {
      const steps = parseSteps(lines, job.start, job.end)
      const freezeStep = steps.find(step => step.id === options.freezeStepId)
      const pinned = PINNED_JOBS.includes(job.id)
      if (freezeStep === undefined || freezeStep.run === null) {
        if (pinned) {
          failures.push(`job \`${job.id}\` 里没有 \`id: ${options.freezeStepId}\` 的**冻结步**（或它的 `
            + '`run:` 读不出来）—— 探针必须**逐 job** 验证冻结点：只验一对时，删掉某个 job 的冻结步'
            + '会让探针静默退到另一个 job 的冻结点上继续 EXIT=0（V13-A §3.2 / R5 实测）。')
        }
        continue
      }
      const freeze = runFreezeBody(freezeStep.run)
      if (freeze.result.status !== 0) {
        failures.push(`job \`${job.id}\` 的冻结步体 EXIT=${freeze.result.status}\n`
          + `      stdout: ${JSON.stringify((freeze.result.stdout ?? '').slice(0, 300))}\n`
          + `      stderr: ${JSON.stringify((freeze.result.stderr ?? '').slice(0, 300))}`)
        continue
      }
      const outputs = { [options.freezeStepId]: { ...freeze.outputs } }
      for (const key of FREEZE_OUTPUT_KEYS) {
        if (typeof outputs[options.freezeStepId][key] !== 'string' || outputs[options.freezeStepId][key].trim() === '') {
          failures.push(`job \`${job.id}\` 的冻结步没有写出 \`${key}\` 输出`
            + '（步骤输出是"后续步骤改不到"的那份值）')
        }
      }
      for (const key of ['node', 'interp', 'git']) {
        const value = outputs[options.freezeStepId][key] ?? ''
        if (value !== '' && !value.startsWith('/')) {
          failures.push(`job \`${job.id}\` 的冻结输出 \`${key}=${value}\` 不是绝对路径`)
        }
      }

      // 工具链合成步（可选但被判据步引用时必需）：它把冻结 PATH 与**白名单内**的工具链目录合成。
      const toolchainStep = steps.find(step => step.id === options.toolchainStepId)
      if (toolchainStep !== undefined && toolchainStep.run !== null) {
        const composed = runFreezeBody(toolchainStep.run, outputs)
        if (composed.result.status !== 0) {
          failures.push(`job \`${job.id}\` 的 PATH 合成步 EXIT=${composed.result.status}\n`
            + `      stderr: ${JSON.stringify((composed.result.stderr ?? '').slice(0, 300))}`)
        } else {
          if (typeof composed.outputs.path !== 'string' || composed.outputs.path.trim() === '') {
            failures.push(`job \`${job.id}\` 的 PATH 合成步没有写出 \`path\` 输出`)
          } else {
            outputs[options.toolchainStepId] = { path: composed.outputs.path }
          }
        }
      }
      freezeOutputsByJob.set(job.id, outputs)

      // 本 job 里所有"跑仓内执行体"的判据步。
      for (const step of steps) {
        if (step.run === null) continue
        if (step.id === options.freezeStepId || step.id === options.toolchainStepId) continue
        if (!isJudgeStepRun(step.run)) continue
        judgeSteps.push({ job: job.id, step, outputs })
      }
    }

    if (judgeSteps.length === 0) {
      failures.push('ci.yml 里一个"跑仓内执行体的判据步"都没找到 —— "读不出"不等于"没有"。')
    }

    // ---- 金丝雀仓：给每个被引用的仓内路径铺一个"记录 + 裸 node 调用"的执行体 ----
    const canaryTokens = [...new Set(judgeSteps.flatMap(entry => repoPathTokens(entry.step.run)))].sort()
    const canaryDir = join(scratch, 'canary')
    mkdirSync(canaryDir, { recursive: true })
    for (const token of canaryTokens) {
      const absolute = join(canaryDir, token)
      mkdirSync(dirname(absolute), { recursive: true })
      writeFileSync(absolute, canarySourceFor(token))
      if (/\.(?:sh|bash)$/u.test(token)) chmodSync(absolute, 0o755)
    }
    {
      const origin = join(scratch, 'origin.git')
      const gitEnv = { HOME: scratch, PATH: process.env.PATH ?? '/usr/bin:/bin' }
      const git = (args, cwd = canaryDir) => spawnSync('git', args, { cwd, encoding: 'utf8', env: gitEnv })
      // `Release topology` 那一步会先 `git fetch origin …` ⇒ 金丝雀仓必须有可取的远端。
      git(['init', '--quiet', '--initial-branch=master'])
      git(['add', '-A'])
      git(['-c', 'user.email=canary@example.invalid', '-c', 'user.name=canary', 'commit', '--quiet', '-m', 'canary'])
      git(['tag', 'v0.0.0'])
      git(['init', '--quiet', '--bare', origin], scratch)
      git(['remote', 'add', 'origin', `file://${origin}`])
      git(['push', '--quiet', 'origin', 'master', '--tags'])
    }

    const canaryLog = join(scratch, 'canary-log')
    /** 在**金丝雀仓**里跑一段判据步体（PATH 前置假 `node`）。 */
    const runCanaryStep = (body, marker) => {
      writeFileSync(canaryLog, '')
      const result = runShell(body, {
        PATH: `${fakebin}:${process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'}`,
        RUNNER_TEMP: join(scratch, 'runner-temp'),
        GITHUB_OUTPUT: join(scratch, 'github-output-canary'),
        GITHUB_PATH: join(scratch, 'github-path-canary'),
        GITHUB_ENV: join(scratch, 'github-env-canary'),
        GITHUB_SHA: anchorSha,
        GITHUB_REF: 'refs/heads/main',
        GITHUB_REF_NAME: 'main',
        GITHUB_REF_TYPE: 'branch',
        FAKE_NODE_MARKER: marker,
        CANARY_LOG: canaryLog,
      }, canaryDir)
      return {
        status: result.status,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        canaryRan: readFileSync(canaryLog, 'utf8').trim() !== '',
        fakeUsed: existsSync(marker),
      }
    }

    let behaviorProbes = 0
    judgeSteps.forEach((entry, index) => {
      const { job, step, outputs } = entry
      const label = `job \`${job}\` 的判据步「${step.name ?? '(无名)'}」`
      const substituted = substituteFrozenOutputs(step.run, outputs)
      const leftover = /\$\{\{\s*steps\.(?:frozen-launchers|frozen-toolchain)\.outputs\./u.exec(substituted)
      if (leftover !== null) {
        failures.push(`${label} 引用了本 job 里**不存在**的冻结点输出（${leftover[0]}…）——`
          + '引用一个不存在的冻结点会让 runner 展开成空串，那里就成了"没有启动器"。')
        return
      }
      // ① 静态：判据步必须复位 PATH，且在任何仓内命令之前。
      const exportLine = pathExportLine(step.run)
      const firstInvocation = firstInvocationLine(step.run)
      if (exportLine < 0) {
        failures.push(`${label} 是跑仓内执行体的判据步，但步骤体里没有`
          + ' `export PATH="${{ steps.<冻结点>.outputs.path }}"` —— 只冻结"步骤命令位的启动器"'
          + '冻不到仓本体里的裸命令（V13-A §3.3 实测：假 `node` 能把 wasm 门禁翻成 EXIT=0）。')
        return
      }
      if (firstInvocation >= 0 && exportLine > firstInvocation) {
        failures.push(`${label} 的 PATH 复位排在第 ${exportLine + 1} 个逻辑行，`
          + `但它第 ${firstInvocation + 1} 个逻辑行就已经在跑仓内东西了 —— 复位必须在任何仓内命令之前。`)
        return
      }
      // ② 行为：在被审的**那一份真字节**上跑一遍金丝雀。
      const green = runCanaryStep(substituted, join(scratch, `fake-green-${index}`))
      behaviorProbes += 1
      if (!green.canaryRan) {
        failures.push(`${label} 在金丝雀仓里**没有跑到仓内执行体**（EXIT=${green.status}）——`
          + '这一格证明不了任何东西，先看步骤体是不是变了形。\n'
          + `      stdout: ${JSON.stringify(green.stdout.slice(0, 200))}\n`
          + `      stderr: ${JSON.stringify(green.stderr.slice(0, 200))}`)
        return
      }
      if (green.fakeUsed) {
        failures.push(`${label} **冻结 PATH 没有生效**：仓内执行体里的裸 \`node\` 命中了被注入的假 `
          + `\`node\`（标记文件 ${join(scratch, `fake-green-${index}`)} 存在）\n`
          + '      ⇒ 这正是 R13-D-02 的载荷形态：一行 `echo … >> $GITHUB_PATH` 就能把判据换成攻击者的。')
        return
      }
      // ③ 正控 B（R1 形态）：只删掉"复位 PATH"这一半、保留冻结表达式 ⇒ 假 node **必须**被调用。
      //    注意顺序：**先按原始字节删那一行、再做表达式替换** —— 替换之后的形态里
      //    `${{ … }}` 已经变成绝对路径，按形态匹配就删不掉了（第一版就踩了这个坑：
      //    正控与"绿"跑的是同一份字节 ⇒ 那一格恒绿）。
      const controlB = runCanaryStep(
        substituteFrozenOutputs(stripPathExport(step.run), outputs),
        join(scratch, `fake-r1-${index}`),
      )
      if (!controlB.fakeUsed) {
        failures.push(`**正控 B（R1 形态）失败**：${label} 在"只冻结解释器、不复位 PATH"的形态下，`
          + '假 `node` 仍然没有被调用 ⇒ 本探针抓不到"脚本体走活 PATH"这条载荷（要么金丝雀没跑到，'
          + `要么这一格是恒绿的）。\n      正控 EXIT=${controlB.status}`
          + ` canaryRan=${String(controlB.canaryRan)}`)
        return
      }
      notes.push(`冻结 PATH 生效：${label} 的仓内执行体里裸 \`node\` 走的是冻结份；`
        + '把"复位 PATH"这一半拆掉后同一个载荷确实被换掉（正控 B 成立）')
    })

    // ---- 端到端格子：把 gate-guards 的判据步体按原字节在**真仓**里跑一遍 ----
    const judgeName = 'Judge execution bodies are pristine (runs before any yarn command)'
    const gateGuards = jobs.find(job => job.id === PINNED_JOBS[0])
    const canonical = gateGuards === undefined
      ? undefined
      : parseSteps(lines, gateGuards.start, gateGuards.end)
        .find(step => step.name === judgeName)
    if (canonical === undefined || canonical.run === null) {
      failures.push(`抽不出 \`${PINNED_JOBS[0]}\` 的「${judgeName}」步骤体（它是"判据本体在 install 期`
        + '有没有被改写"的前置校验，必须逐字可跑）')
    } else {
      const outputs = freezeOutputsByJob.get(PINNED_JOBS[0]) ?? {}
      const judgeTemplate = substituteFrozenOutputs(canonical.run, outputs)
      if (!judgeTemplate.includes(`steps.${options.freezeStepId}.outputs.node`.replace('steps.', ''))) {
        notes.push('判据步体里已看不到冻结表达式（替换后）—— 下面跑的是替换后的真字节')
      }
      const marker = join(scratch, 'fake-node-used')
      const judgeRun = runShell(judgeTemplate, {
        PATH: `${fakebin}:${process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'}`,
        RUNNER_TEMP: join(scratch, 'runner-temp'),
        FAKE_NODE_MARKER: marker,
        GITHUB_SHA: anchorSha,
      }, root)
      const fakeUsed = existsSync(marker)
      const stdout = judgeRun.stdout ?? ''
      if (fakeUsed) {
        failures.push(`**冻结启动器没有生效**：判据步仍然执行了被注入的假 \`node\`（标记文件 ${marker} 存在）\n`
          + `      ⇒ 假 node 会自己回显凭据：\`${readFileSync(marker, 'utf8').split('\n')[0]}\``)
      } else {
        const passed = stdout.includes('check-install-integrity: VERDICT PASS')
        // 「真判据在跑」的证据 = 它自己的输出前缀出现在两个流里。**不能**只看 PASS 行：
        // 本地脏树（工作树 ≠ HEAD）上真判据会红，而那恰恰证明跑的是真判据而不是假 node。
        const judgeRan = /check-install-integrity:/u.test(stdout) || /check-install-integrity:/u.test(judgeRun.stderr ?? '')
        const platformAnchor = (process.env.GITHUB_SHA ?? '').trim() !== ''
        if (!judgeRan) {
          failures.push('判据步既没用假 node，也没跑到真判据 ⇒ 它什么都没跑（EXIT='
            + `${judgeRun.status}）\n      stdout: ${JSON.stringify(stdout.slice(0, 400))}\n`
            + `      stderr: ${JSON.stringify((judgeRun.stderr ?? '').slice(0, 400))}`)
        } else if (!passed && platformAnchor) {
          // CI 语境（平台给了 GITHUB_SHA）：检出树应当等于 HEAD ⇒ 判据必须 PASS。
          failures.push('判据步跑到了真判据但**没有通过凭据**（EXIT='
            + `${judgeRun.status}）—— CI 上检出树应当等于 HEAD，这里必须 PASS\n`
            + `      stderr: ${JSON.stringify((judgeRun.stderr ?? '').slice(0, 400))}`)
        } else if (!passed) {
          notes.push(`冻结启动器生效：PATH 前置了假 \`node\`（${fakebin}）之后，判据步仍跑**真**判据`
            + `（EXIT=${judgeRun.status}，本地脏树上判据本身会红，属预期；CI 上要求 PASS）`)
        } else {
          notes.push(`冻结启动器生效：PATH 前置了假 \`node\`（${fakebin}）之后，判据步仍跑真判据并打印通过凭据（EXIT=${judgeRun.status}）`)
        }
      }

      // ---- 正控 A：整份冻结拆除（裸命令名 + 不复位 PATH）⇒ 同一个载荷必须能把判据换掉 ----
      const plain = { node: 'node', interp: 'bash', git: 'git' }
      // 同正控 B 的顺序：先在**原始字节**上删掉 PATH 复位、再把冻结表达式换成裸命令名，
      // 最后才做"冻结点输出"的替换（否则替换过的绝对路径上什么都匹配不到）。
      const controlBody = substituteFrozenOutputs(stripPathExport(canonical.run).replace(
        /"\$\{\{\s*steps\.[A-Za-z0-9_-]+\.outputs\.([A-Za-z0-9_-]+)\s*\}\}"/gu,
        (match, key) => plain[key] ?? match,
      ), outputs)
      const controlMarker = join(scratch, 'fake-node-used-control')
      const controlRun = runShell(controlBody, {
        PATH: `${fakebin}:${process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'}`,
        RUNNER_TEMP: join(scratch, 'runner-temp'),
        FAKE_NODE_MARKER: controlMarker,
        GITHUB_SHA: anchorSha,
      }, root)
      if (!existsSync(controlMarker)) {
        failures.push('**正控 A 失败**：把冻结拆除之后，假 `node` 仍然没有被执行 ⇒ 本探针抓不到"PATH 注入换启动器"'
          + '这条载荷（它测不出任何东西：绿是恒绿）\n'
          + `      正控 EXIT=${controlRun.status}`)
      } else {
        notes.push('正控 A 成立：拆除冻结后同一个载荷确实替换掉了启动器（假 node 被调用）'
          + `⇒ 上面的"绿"有判别力（正控 EXIT=${controlRun.status}）`)
      }
    }

    if (options.json !== null) {
      writeFileSync(options.json, `${JSON.stringify({
        freezeOutputs: Object.fromEntries(freezeOutputsByJob),
        judgeSteps: judgeSteps.map(entry => `${entry.job}#${entry.step.name ?? '(无名)'}`),
        canaryTokens,
        behaviorProbes,
        failures,
        notes,
      }, null, 2)}\n`)
    }

    if (failures.length > 0) {
      for (const detail of failures) process.stderr.write(`\ncheck-frozen-launchers: ${detail}\n`)
      process.stderr.write(`\ncheck-frozen-launchers: ${failures.length} 项未通过\n`)
      return 1
    }
    process.stdout.write(`check-frozen-launchers: VERDICT PASS frozen=${options.freezeStepId}`
      + ` node=${freezeOutputsByJob.get(PINNED_JOBS[0])?.[options.freezeStepId]?.node ?? '(未取到)'}`
      + ` jobs=${freezeOutputsByJob.size} steps=${judgeSteps.length} probes=${behaviorProbes + 1}\n`)
    for (const note of notes) process.stdout.write(`check-frozen-launchers: ${note}\n`)
    process.stdout.write('check-frozen-launchers: 诚实边界 — 本判据收口的是 `$PATH` 注入这条**低成本**通道；'
      + 'GitHub 托管 runner 上 runner 用户有免密 sudo，同 job 内任意代码理论上仍可替换任何主机侧路径'
      + '（本判据不承诺"启动器不可被替换"，只承诺"PATH 注入换不掉判据的启动器、也换不掉仓内执行体里的裸命令"）。\n')
    return 0
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const code = main(process.argv.slice(2))
  process.removeAllListeners('exit')
  process.removeAllListeners('beforeExit')
  process.exit(code)
}
