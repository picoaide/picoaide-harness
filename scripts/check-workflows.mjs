#!/usr/bin/env node
/**
 * Workflow gate: every `run:` shell block in `.github/workflows/*.yml` must parse.
 *
 * 为什么需要这个门禁(2026-09-10 审计教训):
 *   重写 CI 时往 `.github/workflows/ci.yml` 的 release job 里写进了两处未闭合的
 *   双引号(一处 `echo "…" "`、一处 escape 了引号却漏掉收尾引号)。YAML 本身
 *   是合法的(它们都在块标量里),所以 `yaml.safe_load` 结构校验、"CI 能不能
 *   跑"这类检查全都看不见;而 bash 解析整段脚本时才发现 EOF,step 直接 exit 2。
 *   两个 bug 都只在 tag 触发的 job 里,PR/分支 CI 全绿,直到发版才炸。
 *
 *   这类错误的唯一有效拦截点是 `bash -n`(只解析不执行)——本脚本把每个
 *   shell run 块拆出来逐个过一遍。
 *
 * 实现取舍:不引入 YAML 依赖(与 scripts/verify-layout.mjs 一致,根脚本只用
 * Node 内建模块)。这里只需要识别 GitHub Actions 用到的 YAML 子集:
 *
 *     jobs:
 *       <job>:                         # 缩进 2
 *         defaults:
 *           run:
 *             shell: pwsh              # job 级默认 shell
 *         steps:
 *           - name: …                  # 缩进 6
 *             shell: bash              # step 级 shell 覆盖
 *             run: |                   # 块标量,内容缩进更深
 *               set -euo pipefail
 *             run: single command      # 单行内联
 *
 * 防退化:任何 workflow 解析出 0 个 run 块都会被判为失败 —— 扫描器一旦失效
 * (格式变化/正则走样),门禁必须响,而不是静默放行。
 *
 * 2026-09-11 补一条**策略**检查(不只是语法):调用 `scripts/ci-channel-transfer.sh`
 * 的 step 必须带齐 R2_* 与 AWS_* 两组凭据环境变量。当天 v2.7.0 正式 tag 上,
 * 五处中转 step 只传了 R2_*,而 aws CLI 只认 AWS_* —— 三个平台 job 全部以
 * "Unable to locate credentials" 失败、品牌渠道零交付,release job 因 needs
 * 失败被跳过。这类"PR/分支全绿、发版才炸"的缺口只能靠静态策略门禁拦。
 *
 * 同日晚些时候再补两条**发布面**策略(Release 名与发布说明,见 checkWorkflow 内注释):
 * Release 名必须是 tag 本身(长名会被 Releases 页左侧列表截断,同页版本号全看不见),
 * 且正式 tag 缺 `docs/releases/<tag>.md` 时必须 exit 1(不静默回退自动生成的 PR 列表)。
 *
 * 用法:node scripts/check-workflows.mjs
 * 退出码:0 = 全部通过;1 = 有块解析失败或扫描器退化。
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'

const root = resolve(import.meta.dirname, '..')
/**
 * 被扫描的 workflow 目录。
 *
 * `--workflows-dir=<path>` 是**变异验证/本地回归**用的测试缝:把 workflow 的逐字节副本
 * 放进临时目录、故意造一个违规 step,断言门禁 exit≠0 且点名该 step(R2-SK-7 的判据)。
 * CI 与 `yarn check` 一律不带这个参数,默认只扫仓库里的 `.github/workflows`。
 */
const workflowsDirArgument = process.argv.slice(2).find(argument => argument.startsWith('--workflows-dir='))
const workflowDirectory = workflowsDirArgument === undefined
  ? join(root, '.github', 'workflows')
  : resolve(workflowsDirArgument.slice('--workflows-dir='.length))

/** shell 家族中本门禁不认识、因而跳过的那些(不是 sh/bash 方言)。 */
const NON_POSIX_SHELLS = /^(pwsh|powershell|cmd|python|node)\b/iu

/** 块标量头:`run: |` / `run: |-` / `run: >-` 等。 */
const BLOCK_SCALAR = /^(\s*)run:\s*([|>])[-+]?\s*$/u
/** 内联 `run: <命令>`。 */
const INLINE_RUN = /^(\s*)run:\s*(\S.*)$/u
/** `shell: <名字>`。 */
const SHELL_KEY = /^(\s*)shell:\s*(\S+)\s*$/u
/** 中转脚本需要的凭据环境变量(aws CLI 认 AWS_*,R2_* 供端点/桶名/HMAC 种子)。 */
const TRANSFER_REQUIRED_ENV = [
  'R2_ACCOUNT_ID',
  'R2_BUCKET',
  'R2_SECRET_ACCESS_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
]

/**
 * 渠道 DMG 打包 step 必须带齐的公证三元组(2026-09-11 补的策略门禁)。
 *
 * 渠道包是交付给客户的安装包,正式 tag 上必须签名+公证+staple,否则客户 Mac
 * 首次打开被 Gatekeeper 拦成「Apple 无法验证」。此前渠道 step 只传了签名证书、
 * 走预发那条 `--sign-only` 路径,产物签名有效但没有票据 —— 这类"PR/分支全绿、
 * 发版才在客户端炸"的缺口只能靠静态检查拦。step 内部允许按 tag 形态分支成
 * sign-only(预发内测),但**公证凭据必须一直在 env 里**,否则分支一改就静默降级。
 */
const CHANNEL_DMG_NOTARIZE_REQUIRED_ENV = [
  'APPLE_API_KEY',
  'APPLE_API_KEY_ID',
  'APPLE_API_ISSUER',
]

/** `defaults:` 下的 `run:` 分组(job 级默认 shell 的父键)。 */
const JOB_KEY = /^ {2}([A-Za-z_][\w-]*):\s*$/u
const STEP_KEY = /^ {6}- /u

/**
 * compact step:`- run: <单行命令>`(run 与序列项**同一行**)。
 *
 * 为什么单独一条正则(2026-09-19 第二轮审计 §3.3 / R2-SK-1):旧实现里 STEP_KEY 先把这类
 * 行 `continue` 掉,于是 `bash -n` 永远看不到它们 —— `.github/workflows/ci.yml` 里 14 条
 * compact step(含本次提交改过的 `go test … -timeout 25m`)**零语法检查**,而门禁显示绿。
 */
const COMPACT_INLINE_RUN = /^(\s*)- run:\s*(\S.*)$/u
/** compact step 的块标量形态:`- run: |`(头与序列项同一行)。 */
const COMPACT_BLOCK_RUN = /^(\s*)- run:\s*([|>])[-+]?\s*$/u

/**
 * 从一个 workflow 文本里抽出全部 shell run 块。
 * @param text - workflow 文件内容。
 * @returns 块列表,每项含 shell、内容与起始行号(1-based)。
 */
export function extractRunBlocks(text) {
  const lines = text.split(/\r?\n/u)
  const blocks = []
  let jobDefaultShell
  let currentJob

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]

    const jobMatch = JOB_KEY.exec(line)
    if (jobMatch !== null) {
      currentJob = jobMatch[1]
      jobDefaultShell = undefined
    }
    if (STEP_KEY.test(line) && currentJob !== undefined) {
      // 新 step:step 级 shell 覆盖在下面按行就近读取。
      //
      // ⚠️ compact 形态的 `run:` 就写在这一行上(`- run: <cmd>` / `- run: |`),所以
      // **先把 run 抽出来再 continue** —— 否则它永远到不了下面的 INLINE_RUN(那个正则
      // 要求 `run:` 顶行),门禁对这批 step 静默通过(2026-09-19 第二轮审计 §3.3)。
      const compactBlock = COMPACT_BLOCK_RUN.exec(line)
      const compactInline = COMPACT_INLINE_RUN.exec(line)
      // 块标量必须先判:它的头部(`|` / `>`)同样满足 INLINE_RUN 的 `\S.*`(普通形态里
      // BLOCK_SCALAR 也排在 INLINE_RUN 之前,这里保持同一顺序)。
      if (compactBlock !== null) {
        // 序列项里的块标量:内容缩进必须深于 `- ` 之后的 `run:` 键(prefix 缩进 + 2)。
        const keyIndent = compactBlock[1].length + 2
        const { body, nextIndex } = readBlockScalar(lines, index + 1, keyIndent)
        blocks.push({
          shell: nearestShell(lines, index, jobDefaultShell),
          content: dedent(body).join('\n'),
          line: index + 2,
        })
        index = nextIndex - 1
      } else if (compactInline !== null) {
        blocks.push({
          shell: nearestShell(lines, index, jobDefaultShell),
          content: compactInline[2],
          line: index + 1,
        })
      }
      continue
    }

    // job 级默认 shell:`defaults.run.shell`
    const shellMatch = SHELL_KEY.exec(line)
    if (shellMatch !== null) {
      const indent = shellMatch[1].length
      if (indent >= 8 && indent <= 12) jobDefaultShell = shellMatch[2]
      continue
    }

    const blockMatch = BLOCK_SCALAR.exec(line)
    if (blockMatch !== null) {
      const parentIndent = blockMatch[1].length
      const startLine = index + 2 // 块内容从下一行开始
      const { body, nextIndex } = readBlockScalar(lines, index + 1, parentIndent)
      // 去掉块标量自身的缩进(YAML 取块内最小缩进)
      const content = dedent(body)
      blocks.push({
        shell: nearestShell(lines, index, jobDefaultShell),
        content: content.join('\n'),
        line: startLine,
      })
      index = nextIndex - 1
      continue
    }

    const inlineMatch = INLINE_RUN.exec(line)
    if (inlineMatch !== null) {
      blocks.push({
        shell: nearestShell(lines, index, jobDefaultShell),
        content: inlineMatch[2],
        line: index + 1,
      })
    }
  }

  return blocks
}

/**
 * 读一个块标量的内容行(缩进深于 parentIndent 的连续行)。
 * @param lines - 文件所有行。
 * @param from - 块内容的第一行下标。
 * @param parentIndent - 块标量头所在键的缩进。
 * @returns body = 原始内容行;nextIndex = 块之后的第一行下标。
 */
function readBlockScalar(lines, from, parentIndent) {
  const body = []
  let cursor = from
  for (; cursor < lines.length; cursor += 1) {
    const candidate = lines[cursor]
    if (candidate.trim() === '') {
      body.push('')
      continue
    }
    const indent = candidate.length - candidate.trimStart().length
    if (indent <= parentIndent) break
    body.push(candidate)
  }
  return { body, nextIndex: cursor }
}

/** 归一化脚本内容(只为"这一步有没有被检查过"的对账:忽略缩进与首尾空行)。 */
function normalizeScript(text) {
  return text
    .split('\n')
    .map(line => line.trimStart())
    .join('\n')
    .trim()
}

/**
 * 对账:YAML 解析出的**每个 POSIX shell 步骤**是否都有一个被 `bash -n` 检查过的块。
 *
 * 为什么要有这条(2026-09-19 第二轮审计 §3.3 的根因):"有哪些 YAML 形态能写 run"这个清单
 * 永远列不全(compact / flow / 未来新写法),而扫描器漏抽的症状**恰好是静默的** —— 门禁
 * 照常绿,只是那一步没被检查。所以这里不枚举形态,而是拿"解析器看到的事实"与"扫描器抽出
 * 的块"对账:少任何一个就 fail-loud。这条闸门本身就能抓到本轮那 14 条 compact step。
 *
 * @param document - parseYaml 的结果。
 * @param blocks - extractRunBlocks 的结果。
 * @returns 没被检查到的步骤标识(`job#序号`)。
 */
export function uncheckedShellSteps(document, blocks) {
  const checked = new Set(blocks.map(block => normalizeScript(block.content)))
  const out = []
  const jobs = typeof document?.jobs === 'object' && document.jobs !== null ? document.jobs : {}
  for (const [jobId, job] of Object.entries(jobs)) {
    const defaultShell = job?.defaults?.run?.shell
    const steps = Array.isArray(job?.steps) ? job.steps : []
    steps.forEach((step, index) => {
      if (typeof step?.run !== 'string') return
      const stepShell = typeof step?.shell === 'string' && step.shell.trim() !== '' ? step.shell : defaultShell
      const shell = typeof stepShell === 'string' && stepShell.trim() !== '' ? stepShell : 'bash'
      if (NON_POSIX_SHELLS.test(shell)) return
      if (!checked.has(normalizeScript(step.run))) out.push(`${jobId}#${index + 1}`)
    })
  }
  return out
}

/**
 * 找与 `run:` 同一 step 的 shell 覆盖(块之前的最近一个更浅缩进的 shell:)。
 * @param lines - 文件所有行。
 * @param runIndex - `run:` 所在行下标。
 * @param fallback - job 级默认 shell(可能为 undefined)。
 * @returns 生效的 shell 名。
 */
function nearestShell(lines, runIndex, fallback) {
  const runIndent = lines[runIndex].length - lines[runIndex].trimStart().length
  for (let cursor = runIndex - 1; cursor >= 0; cursor -= 1) {
    const line = lines[cursor]
    if (line.trim() === '') continue
    const indent = line.length - line.trimStart().length
    if (indent < runIndent) break // 越过了本 step 的起点
    const match = SHELL_KEY.exec(line)
    if (match !== null && match[1].length === runIndent) return match[2]
  }
  return fallback ?? 'bash'
}

/**
 * 去掉块标量的公共缩进(YAML 块标量语义)。
 * @param body - 块内的原始行。
 * @returns 去缩进后的行。
 */
function dedent(body) {
  const indents = body
    .filter(line => line.trim() !== '')
    .map(line => line.length - line.trimStart().length)
  if (indents.length === 0) return []
  const common = Math.min(...indents)
  return body.map(line => (line.trim() === '' ? '' : line.slice(common)))
}

/**
 * 用 `bash -n` 解析一段脚本(不执行)。
 * @param content - 脚本内容。
 * @param file - 临时文件名(只为错误信息可读)。
 * @returns 解析错误信息;通过时为 null。
 */
function parseShell(content, file) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-workflow-check-'))
  const scriptPath = join(directory, file)
  try {
    writeFileSync(scriptPath, content)
    execFileSync('bash', ['-n', scriptPath], { stdio: ['ignore', 'pipe', 'pipe'] })
    return null
  } catch (cause) {
    const stderr = cause.stderr?.toString?.() ?? ''
    return stderr.trim() === '' ? String(cause.message ?? cause) : stderr.trim()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

/**
 * 检查一个 workflow 文件（从 `.github/workflows/<name>` 读）。
 * @param name - 文件名。
 * @returns 失败项列表 + 统计（见 checkWorkflowText）。
 */
export function checkWorkflow(name) {
  return checkWorkflowText(name, readFileSync(join(workflowDirectory, name), 'utf8'))
}

/**
 * 检查一份 workflow 文本（纯函数：变异验证与内置自检都调它，不落任何文件）。
 * @param name - 文件名（只用于失败信息与白名单键）。
 * @param text - workflow 内容。
 * @returns `{failures, checked, notes, allowlistHits, allowlistMisses}`。
 */
export function checkWorkflowText(name, text) {
  const failures = []

  // YAML 缩进不允许 tab;这类错误会让整个文件失效,先单独拦一道。
  if (/^\t|:\s*\t|\s\t/u.test(text)) {
    failures.push({ name, line: 0, detail: 'YAML 缩进中不允许出现 tab 字符' })
  }

  // 结构解析(2026-09-10 补):bash -n 只看得见 shell 语法,看不见 YAML 语义。
  // 实测踩过一次:`- name: ... (fork PR: no channel access)` 里的 `: ` 让 YAML
  // 把它当成嵌套映射,整个 workflow 直接失效 —— 而所有 run 块的 bash -n 全绿。
  // 这类错误必须在本地拦住,否则要等 push 之后由 GitHub 报"invalid workflow"。
  let document
  try {
    document = parseYaml(text)
  } catch (cause) {
    const line = typeof cause?.linePos?.[0]?.line === 'number' ? cause.linePos[0].line : 0
    failures.push({ name, line, detail: `YAML 解析失败: ${cause?.message ?? String(cause)}` })
    return { failures, checked: 0 }
  }
  if (typeof document !== 'object' || document === null || typeof document.jobs !== 'object' || document.jobs === null) {
    failures.push({ name, line: 0, detail: 'YAML 顶层缺少 jobs 映射' })
    return { failures, checked: 0 }
  }
  for (const [jobId, job] of Object.entries(document.jobs)) {
    if (!Array.isArray(job?.steps) || job.steps.length === 0) {
      failures.push({ name, line: 0, detail: `job ${jobId} 没有 steps` })
      continue
    }
    for (const step of job.steps) {
      if (typeof step?.run === 'string' && typeof step.uses === 'string') {
        failures.push({ name, line: 0, detail: `job ${jobId} 的某个 step 同时有 run 与 uses` })
      }
      if (typeof step?.run === 'string' && step.run.includes('ci-channel-transfer.sh')) {
        const env = typeof step.env === 'object' && step.env !== null ? step.env : {}
        const missing = TRANSFER_REQUIRED_ENV.filter(name => {
          const value = env[name]
          return typeof value !== 'string' || value.trim() === ''
        })
        if (missing.length > 0) {
          failures.push({
            name,
            line: 0,
            detail: `job ${jobId} 的 ci-channel-transfer.sh step 缺少凭据环境变量: ${missing.join(', ')}`
              + '(aws CLI 只认 AWS_*,R2_* 是端点/桶名/HMAC 种子;2026-09-11 因漏 AWS_* 三个平台零交付)',
          })
        }
      }
      // 渠道 DMG 打包(ci-package-clients.sh + '*.dmg')必须带公证三元组。
      if (
        typeof step?.run === 'string'
        && step.run.includes('ci-package-clients.sh')
        && step.run.includes('*.dmg')
      ) {
        const env = typeof step.env === 'object' && step.env !== null ? step.env : {}
        const missing = CHANNEL_DMG_NOTARIZE_REQUIRED_ENV.filter(name => {
          const value = env[name]
          return typeof value !== 'string' || value.trim() === ''
        })
        if (missing.length > 0) {
          failures.push({
            name,
            line: 0,
            detail: `job ${jobId} 的渠道 DMG 打包 step 缺少公证凭据: ${missing.join(', ')}`
              + '(渠道包是客户交付物,正式 tag 必须签名+公证+staple;2026-09-11 客户 Mac 首次打开被拦)',
          })
        }
        // 凭据齐了还要真的调公证:`--sign-only` 只签名不 staple,客户包会退回
        // "无票据"状态(本次缺陷的形态),必须能在 run 里看到公证命令。
        if (!step.run.includes('dist:mac:notarize')) {
          failures.push({
            name,
            line: 0,
            detail: `job ${jobId} 的渠道 DMG 打包 step 没有调用 dist:mac:notarize`
              + '(只 sign-only 的渠道包没有公证票据,客户 Mac 首次打开会被 Gatekeeper 拦下)',
          })
        }
        // run 里"有公证命令"不等于"每次都会公证":分支开关可以是 tag 形态派生的
        // 表达式(2026-09-13 前正是 `!contains(github.ref_name, '-')`,于是预发 tag
        // 上的 beta mac 包悄悄退化成只签名)。要求它**写死为 true** —— 渠道包没有
        // "只签名"的例外:预发 tag 的渠道列表只有 beta,而它同样是交付物。
        const notarizeSwitch = env.CHANNEL_NOTARIZE
        if (typeof notarizeSwitch !== 'string' || notarizeSwitch.trim() !== 'true') {
          failures.push({
            name,
            line: 0,
            detail: `job ${jobId} 的渠道 DMG 打包 step 的 CHANNEL_NOTARIZE 必须写死为 'true'`
              + `(当前: ${typeof notarizeSwitch === 'string' ? notarizeSwitch : '未设置'})`
              + ' —— 由 tag 形态派生的开关会让预发 tag 上的 beta mac 包退化成只签名,'
              + '内测同学的 Mac 首次打开仍被 Gatekeeper 拦',
          })
        }
      }
      // GitHub Release 的「名字」与「说明」(2026-09-11 定案):
      //   - Release 名必须是 tag 本身。Releases 页左侧列表宽度固定,
      //     "PicoAide Harness v2.6.9-beta.5" 会被截断成 "PicoAide Harness v2.6…",
      //     一页十几个版本号全都看不见 —— 只剩重复的产品名前缀。
      //   - 正式 tag 缺 docs/releases/<tag>.md 必须 fail-loud:回退自动生成的 PR
      //     列表等于把公开版本页变成 CI 日志(v2.7.0 的实际情况)。
      // 这两条都只在 tag 触发时才有感觉(PR/分支全绿、发版才发现),只能靠静态检查拦。
      if (typeof step?.run === 'string' && step.run.includes('gh release create')) {
        if (!step.run.includes('--title "${TAG}"')) {
          failures.push({
            name,
            line: 0,
            detail: `job ${jobId} 的 gh release 步骤没有把 Release 名设为 tag 本身`
              + '(长名会被 Releases 页左侧列表截断,同页版本号全部不可见;请用 --title "${TAG}")',
          })
        }
        const notesPolicy = ['docs/releases/${TAG}.md', '--notes-file', '--generate-notes', 'exit 1']
        const missingPolicy = notesPolicy.filter(fragment => !step.run.includes(fragment))
        if (missingPolicy.length > 0) {
          failures.push({
            name,
            line: 0,
            detail: `job ${jobId} 的 gh release 步骤缺少发布说明策略: ${missingPolicy.join(', ')}`
              + '(正式 tag 必须用 docs/releases/${TAG}.md;缺失时 exit 1,不静默回退自动变更日志;模板 docs/releases/TEMPLATE.md)',
          })
        }
      }
    }
  }

  const blocks = extractRunBlocks(text)
  if (blocks.length === 0) {
    // 扫描器退化保护:一个 workflow 不可能没有任何 run 块。
    failures.push({ name, line: 0, detail: '未解析出任何 run 块 —— 扫描器可能已失效,请检查 extractRunBlocks' })
    return { failures, checked: 0 }
  }
  // 覆盖率对账(2026-09-19 第二轮审计 §3.3):解析器说有 N 个 shell 步骤,扫描器就必须抽出
  // N 个块。少一个 = 那一步没被 bash -n 检查过 —— 这种漏抽是**静默**的(门禁照常绿),
  // 所以必须 fail-loud(compact 形态曾整批漏掉 14 条)。
  const unchecked = uncheckedShellSteps(document, blocks)
  if (unchecked.length > 0) {
    failures.push({
      name,
      line: 0,
      detail: `有 ${unchecked.length} 个 shell 步骤没有被 bash -n 检查过(${unchecked.join(', ')})`
        + ' —— extractRunBlocks 漏抽了某种写法(compact `- run:` / flow 映射 / 新的缩进形态?)'
        + '；请补扫描分支,不要放宽这条对账(2026-09-19 审计 R2-SK-1 的现场就是 14 条 compact step)',
    })
  }

  let checked = 0
  for (const block of blocks) {
    if (NON_POSIX_SHELLS.test(block.shell)) continue
    if (block.content.trim() === '') continue
    checked += 1
    const error = parseShell(block.content, `${name}.run.sh`)
    if (error !== null) failures.push({ name, line: block.line, detail: error })
  }

  // ===== SK-7 三条静态策略(2026-09-19 第三批:吞码 / 超时序 / 单行退出码)=====
  const notes = []
  const allowlist = new AllowlistUse()
  // 策略 1 先跑:它报过的语句不再被策略 3 重复报(同一句话两个毛病只报一次)。
  const reported = new Set()
  failures.push(...checkSwallowedExitCodes(name, document, blocks, allowlist, reported))
  const budget = checkGoTestTimeoutBudget(name, document, blocks, notes)
  failures.push(...budget.failures)
  failures.push(...checkInlineRunExitStatus(name, document, blocks, allowlist, reported))

  return {
    failures,
    checked,
    notes,
    allowlistHits: allowlist.hits,
    goTestTimeoutHits: budget.hits,
  }
}

// ===== SK-7:三条"静默变绿"的静态策略(2026-09-19 第二轮审计 §3.3 / R2-SK-7)=====
//
// 为什么要有这一批(子审计实测):把 CI 里的验证步骤改成 `|| true`、给它加
// `continue-on-error: true`、或把 `go test -timeout 15m` 放宽成 `-timeout 120m`,
// 三种变异**全部静默通过** —— 语法门禁看得见它们(bash -n 完全合法),但没有任何策略拦。
// 三条策略分别覆盖:
//
//   1. [SK-7a] **吞退出码**:`|| true` / `; true` / `|| :` / `; :` /
//      `continue-on-error: true` 一律 fail-loud。清理类动作(容器/临时目录/证据收集)
//      允许放行,但必须在本文件的 SWALLOW_ALLOWLIST 里**逐条**登记 + 写明理由
//      —— "整个文件豁免""整个 job 豁免"这种粒度这里不提供。
//   2. [SK-7b] **`-timeout` 与 job 预算的序关系**:`go test … -timeout Xm` 必须满足
//      `2X + 5 ≤ job 的 timeout-minutes`(由来见 checkGoTestTimeoutBudget 的长注释)。
//   3. [SK-7c] **compact 单行 `- run:` 的退出码语义**:`|` 串联、`;`/`||` 末尾吞码、
//      `!` 取反 —— 任何让"这一步的失败"传不出去的写法都要报错。
//
// 反"假绿"的两道自证(每次运行都执行):
//   - selfTestPolicies():合成违规样本必须被三条策略抓到(策略失效 ⇒ 门禁自己红);
//   - 白名单死条目对账:SWALLOW_ALLOWLIST 里任何一条不再命中真实语句 ⇒ 失败
//     (否则白名单会悄悄长成一个可复用的豁免洞)。

/**
 * 语句级白名单:每条 `{file, signature, reason}`。
 *
 * signature = 语句去掉首尾空白、把连续空白压成单个空格后的**逐字**文本 ——
 * 只放行"这一句话",不放行"这一类话"(想放行新语句就得改这个文件,且必须写理由)。
 * `file` 也要匹配:同一条清理命令出现在别的 workflow 里必须重新登记。
 */
const SWALLOW_ALLOWLIST = [
  {
    file: 'ci.yml',
    signature: 'CHANGED="$(git diff --name-only "${BASE}" "${HEAD}" || true)"',
    reason: '命令替换内吞掉 git diff 的失败:紧接着的 `if [[ -z "${CHANGED}" ]]` 把空输出'
      + '判成"有代码改动"(fail-safe 方向 = 跑全量 CI,不是跳过验证)⇒ 没有任何验证结论被掩盖。',
  },
  {
    file: 'ci.yml',
    signature: 'docker logs "$PG18_CID" 2>&1 | tail -20 || true',
    reason: '诊断输出:容器已经被判定启动失败,这一句只是把容器日志贴给人类看;'
      + '同一分支上面已写 ::error:: 且紧接着 `exit 1`,日志取不到不改变"PG18 挂载点检查失败"这个结论。',
  },
  {
    file: 'ci.yml',
    signature: 'docker rm -f "$PG18_CID" >/dev/null 2>&1 || true',
    reason: '清理:删除临时 PG 容器(它可能已经不存在/已被 --rm 清掉);'
      + '清理失败不能掩盖上一步真正的失败原因。',
  },
  {
    file: 'ci.yml',
    signature: 'rm -rf "$PG18_MOUNT" 2>/dev/null || true',
    reason: '清理:$RUNNER_TEMP 下的临时挂载目录,退出路径上尽力删除;失败不影响任何验证结论。',
  },
  {
    file: 'ci.yml',
    signature: 'cp packages/host/desktop/.e2e-report.md packages/host/desktop/e2e-results/e2e-report.md 2>/dev/null || true',
    reason: '证据收集(step 是 `if: always()`,只为"失败也留证据"):e2e 失败时点开头的报告文件'
      + '本来就可能不存在,复制失败不应把这一步变红 —— 否则会盖掉 e2e 本身的失败原因。',
  },
  {
    file: 'ci.yml',
    signature: 'cp -r packages/host/desktop/.e2e-shots packages/host/desktop/e2e-results/shots 2>/dev/null || true',
    reason: '同上:e2e 截图目录在失败/超时路径上可能不存在,证据收集不得反过来掩盖被测失败。',
  },
  {
    file: 'ci.yml',
    signature: 'cp -r packages/host/desktop/.e2e-sidebar/shots packages/host/desktop/e2e-results/sidebar-shots 2>/dev/null || true',
    reason: '同上:右栏 e2e 截图目录在失败路径上可能不存在,证据收集不得反过来掩盖被测失败。',
  },
]

/** 吞码形态(语句级)。`&&` 故意不在列表里:`A && B` 短路后行退出码取 A 的**失败**,
 *  不会吞掉任何失败 —— 报了就是假阳性。`&&` 参与的吞码链条(`A && B || echo ok`、
 *  `A && B | tail`)由 `||` 与管道两条规则分别覆盖。 */
const SWALLOW_PATTERNS = [
  { re: /\|\|\s*(?:true|:)(?![\w-])/u, form: '|| true / || :' },
  { re: /;\s*(?:true|:)(?![\w-])/u, form: '; true / ; :' },
]

/** `go test` 命令行(逐行取,避免跨行贪婪)。 */
const GO_TEST_COMMAND = /\bgo\s+test\b[^\n]*/gu
/** `-timeout 15m` / `-timeout=900s`(Go 的 flag 两种写法)。 */
const GO_TEST_TIMEOUT_FLAG = /-timeout[= ](\d+)([smh])\b/u
/** 管道(`|` 但不是 `||`)。 */
const SHELL_PIPELINE = /(^|[^|])\|([^|]|$)/u
/** 末尾吞码:`cmd || echo ok` / `cmd; true` / `cmd || exit 0`(末尾命令可带参数)。 */
const INLINE_SWALLOW_TAIL = /(?:\|\||;)\s*(?:true|:|echo|exit\s+0)(?![\w-])[^;&|]*;?\s*$/u
/** `!` 取反(行首或跟在 `;`/`&`/`|` 之后)。 */
const SHELL_NEGATION = /(?:^|[;&|])\s*!\s*\S/u

/** 归一化一条 shell 语句(连续空白 → 单个空格 + 去首尾空白):白名单签名的唯一形状。 */
function normalizeStatement(text) {
  return text.replace(/\s+/gu, ' ').trim()
}

/**
 * 去掉引号内容与整行注释,只留"结构性"字符(判据不该被引号里的字面量触发)。
 *
 * 本仓的注释里恰好写着 `|| echo` 这类字面量(notary-probe.yml 记录了它被移除的原因),
 * 所以整行注释必须去掉。引号只做**可靠**的屏蔽:
 *   - 单引号串:shell 里不能再嵌套,直接找下一个 `'` 就够;
 *   - 双引号串:只有当这一段里**没有命令替换**(`$(` 或反引号)时才屏蔽 —— 双引号内的
 *     字面 `"` 只可能来自命令替换,于是 `CHANGED="$(git diff … || true)"` 这种真实形态
 *     必须保留(它的 `|| true` 就是要抓的东西),而 `echo "go test || true"` 这类会被
 *     正确屏蔽掉。
 * 屏蔽不到的角落(带命令替换的双引号串里写 `|| true`)只会**多报**,不会漏报 ——
 * 这是有意的方向:漏报 = 静默变绿,多报 = 改一句话就修好。
 */
function shellSkeleton(line) {
  if (line.trimStart().startsWith('#')) return ''
  let out = ''
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (char === "'" || char === '"') {
      const close = quoteCloseIndex(line, index, char)
      if (close > index) {
        out += char + char
        index = close
        continue
      }
    }
    out += char
  }
  return out
}

/**
 * 找配对闭引号的下标(找不到返回 -1)。
 * @param line - 语句。
 * @param openIndex - 开引号下标。
 * @param quote - `'` 或 `"`。
 * @returns 闭引号下标;双引号里出现命令替换时返回 -1(那一段的引号结构不能按字面理解)。
 */
function quoteCloseIndex(line, openIndex, quote) {
  for (let index = openIndex + 1; index < line.length; index += 1) {
    if (quote === '"' && (line[index] === '`' || (line[index] === '$' && line[index + 1] === '('))) return -1
    if (line[index] === quote) return index
  }
  return -1
}

/** 白名单使用登记:命中即登记,供 main() 做"死条目"对账。 */
class AllowlistUse {
  constructor() {
    this.seen = new Set()
  }

  /**
   * 查白名单并登记命中。
   * @param file - workflow 文件名。
   * @param signature - 语句签名。
   * @returns 命中的条目;没有则 undefined。
   */
  lookup(file, signature) {
    const entry = SWALLOW_ALLOWLIST.find(item => item.file === file && item.signature === signature)
    if (entry !== undefined) this.seen.add(entry)
    return entry
  }

  /** 已命中的条目。 */
  get hits() {
    return [...this.seen]
  }
}

/** 迭代 YAML 里全部 POSIX/其他 shell 步骤(带 run 块与行号)。 */
function* shellSteps(document, blocks) {
  const bySignature = new Map()
  for (const block of blocks) {
    const key = normalizeScript(block.content)
    if (!bySignature.has(key)) bySignature.set(key, block)
  }
  const jobs = typeof document?.jobs === 'object' && document.jobs !== null ? document.jobs : {}
  for (const [jobId, job] of Object.entries(jobs)) {
    const defaultShell = job?.defaults?.run?.shell
    const steps = Array.isArray(job?.steps) ? job.steps : []
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index]
      if (typeof step?.run !== 'string') continue
      const stepShell = typeof step?.shell === 'string' && step.shell.trim() !== '' ? step.shell : defaultShell
      const shell = typeof stepShell === 'string' && stepShell.trim() !== '' ? stepShell : 'bash'
      const label = typeof step.name === 'string' && step.name.trim() !== ''
        ? step.name.trim()
        : `run#${index + 1}`
      yield { jobId, job, step, shell, label, block: bySignature.get(normalizeScript(step.run)) }
    }
  }
}

/** 失败信息里的步骤标识(策略门禁必须**点名 step**,否则红了也不知道改哪)。 */
function stepLabel(item) {
  return `job ${item.jobId} 的 step「${item.label}」`
}

/** 同一 step 内同一语句的去重键(策略 1 报过的语句策略 3 不再重复报)。 */
function statementKey(item, signature) {
  return `${item.jobId}#${item.label}|${signature}`
}

/** `timeout-minutes` 的数字形态(字符串数字也认);无法解析时返回 undefined。 */
function numericMinutes(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^\d+$/u.test(value.trim())) return Number(value.trim())
  return undefined
}

/** 把 `-timeout` 的值折算成分钟(`s`/`m`/`h`)。 */
function timeoutMinutes(count, unit) {
  const value = Number(count)
  if (unit === 's') return value / 60
  if (unit === 'h') return value * 60
  return value
}

/** 算术展示:整数不带小数点,非整数保留一位。 */
function formatMinutes(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

/** `continue-on-error` 是否等价于关闭(false / 'false');其余(含表达式)都算"会让失败静默"。 */
function isContinueOnErrorDisabled(value) {
  if (value === false) return true
  return typeof value === 'string' && value.trim().toLowerCase() === 'false'
}

/**
 * [SK-7a] 吞退出码:验证/测试步骤里的 `|| true` / `; true` / `|| :` / `; :` /
 * `continue-on-error: true`。
 *
 * 判定在**语句级**(逐行 + 去引号/注释 + 白名单逐条登记):语句里任何位置出现吞码形态
 * 都算 —— `cmd || true; next`、`x="$(cmd || true)"` 这种"半吞"同样会让那句话的失败消失。
 * @returns 失败项列表。
 */
function checkSwallowedExitCodes(file, document, blocks, allowlist, reported) {
  const failures = []
  for (const item of shellSteps(document, blocks)) {
    // (a) YAML 级:`continue-on-error` 让这一步的失败不再让 job 红。
    const continueOnError = item.step['continue-on-error']
    if (continueOnError !== undefined && !isContinueOnErrorDisabled(continueOnError)) {
      const key = `continue-on-error:${item.jobId}:${item.label}`
      if (allowlist.lookup(file, key) === undefined) {
        failures.push({
          name: file,
          line: item.block?.line ?? 0,
          detail: `[SK-7a] ${stepLabel(item)} 打开了 continue-on-error(${JSON.stringify(continueOnError)})`
            + ' ⇒ 这一步失败不再让 job 红(测试/校验被静默跳过)。'
            + '删掉它;确需(例如矩阵里的实验平台)请在本脚本 SWALLOW_ALLOWLIST 里逐条登记 + 写明理由'
            + '(表达式形态静态求不出真假,同样按"会静默"处理)。',
        })
      }
    }
    if (NON_POSIX_SHELLS.test(item.shell)) continue
    for (const line of item.step.run.split('\n')) {
      const skeleton = shellSkeleton(line)
      if (skeleton.trim() === '') continue
      const hit = SWALLOW_PATTERNS.find(pattern => pattern.re.test(skeleton))
      if (hit === undefined) continue
      const signature = normalizeStatement(line)
      if (allowlist.lookup(file, signature) !== undefined) continue
      reported.add(statementKey(item, signature))
      failures.push({
        name: file,
        line: item.block?.line ?? 0,
        detail: `[SK-7a] ${stepLabel(item)} 吞掉了退出码(${hit.form}):${signature}\n`
          + '  ⇒ 这一步永远退出 0,命令的失败会静默变绿(2026-09-19 第二轮审计 R2-SK-7 实测:'
          + '`|| true` 变异无任何静态守卫)。\n'
          + '  让失败导致 step 红;清理类动作请在本脚本 SWALLOW_ALLOWLIST 里逐条登记 + 写明理由'
          + '(不允许整个文件 / 整个 job 豁免)。',
      })
    }
  }
  return failures
}

/**
 * [SK-7b] `go test … -timeout X` 与所在 job `timeout-minutes` 的序关系。
 *
 * 硬规则:`2X + 5 ≤ job 上限`(X 以分钟计),报错信息里写出算术。
 *
 * 为什么不是"X < job 上限"这种显然的判据 —— 本仓刚踩过(2026-09-19 第二轮审计 R2-SK-7,
 * 也是本策略的由来):单包 `-timeout 25m` + 其余包 ≈ 21 min 的最坏路径 ≈ 46 min,而 job
 * 上限 30 min ⇒ **挂起的那个包还没到自己的 -timeout,job 就被整体取消**了。产物因此从
 * `panic: test timed out after 25m0s` + goroutine dump + 用例名,退化成一句"gate 红、
 * 查不出原因"(被 cancel 的 step 不会留下 Go 的 dump)。现在的取值是 15m + job 45min:
 * 15(挂满) + 21(其余包) = 36 ≤ 45,且 2×15+5 = 35 ≤ 45。
 *
 * 判据里的 `2X` = "挂满的那个包" + "其余包 ≈ 与之同量级"(实测最慢单包 299s,全量 ~21 min);
 * `+5` = PG 启动 / npm ci / gofmt / go vet / npm test / make build-server 的固定开销。
 * 没声明 `timeout-minutes` 的 job 也判失败:平台默认 360 min 只是兜底,不能拿它证明
 * "dump 一定打得出来"。
 *
 * @returns `{failures, hits}`(hits 供 main() 做"全仓至少有一处 `-timeout`"的存在性对账)。
 */
function checkGoTestTimeoutBudget(file, document, blocks, notes) {
  const failures = []
  let hits = 0
  for (const item of shellSteps(document, blocks)) {
    if (NON_POSIX_SHELLS.test(item.shell)) continue
    for (const command of item.step.run.match(GO_TEST_COMMAND) ?? []) {
      const flag = GO_TEST_TIMEOUT_FLAG.exec(command)
      if (flag === null) continue
      hits += 1
      const minutes = timeoutMinutes(flag[1], flag[2])
      const worst = 2 * minutes + 5
      const budget = numericMinutes(item.job?.['timeout-minutes'])
      const where = `${stepLabel(item)} 的 go test 单包预算 -timeout ${flag[1]}${flag[2]}`
      if (budget === undefined) {
        failures.push({
          name: file,
          line: item.block?.line ?? 0,
          detail: `[SK-7b] ${where}:所在 job 没有声明 timeout-minutes`
            + ` ⇒ 无法证明"挂起的包会被自己的 -timeout 打断并打出 goroutine dump"。\n`
            + `  给 job 加显式预算:2×${formatMinutes(minutes)}+5=${formatMinutes(worst)} ≤ timeout-minutes。`,
        })
        continue
      }
      if (worst <= budget) {
        notes.push(`${file} job ${item.jobId}: -timeout ${flag[1]}${flag[2]}`
          + ` ⇒ 2×${formatMinutes(minutes)}+5=${formatMinutes(worst)} ≤ job ${formatMinutes(budget)} ✓`)
        continue
      }
      failures.push({
        name: file,
        line: item.block?.line ?? 0,
        detail: `[SK-7b] ${where} 与 job 预算的序关系不成立:`
          + `2×${formatMinutes(minutes)}+5=${formatMinutes(worst)} > ${formatMinutes(budget)}(job 预算)。\n`
          + '  ⇒ 挂起的那个包会先撞 job 上限被整体取消,`panic: test timed out` + goroutine dump + '
          + '用例名全部丢失,只剩"gate 红查不出原因"(2026-09-19 R2-SK-7 的现场:25m + 其余 '
          + '~21m 必然先撞 30min 的 job)。\n'
          + `  把 -timeout 收到 ≤ ${formatMinutes((budget - 5) / 2)}m,或把 job 预算抬到 ≥ `
          + `${formatMinutes(worst)}min。`,
      })
    }
  }
  return { failures, hits }
}

/**
 * [SK-7c] compact 单行 `- run:` 的退出码语义。
 *
 * 单行 `run:`(compact `- run: <cmd>` 与缩进 8 的 `run: <cmd>`)没有块标量那样的
 * `set -euo pipefail` 铺垫,行退出码 = 最后一个命令的退出码。三种写法会让失败溜走:
 *   - `cmd1 | tail -5`:管道退出码只反映最后一段;
 *   - `cmd || echo ok` / `cmd; true` / `cmd || exit 0`:末尾命令恒成功;
 *   - `! cmd`:`!` 反转退出码,cmd 失败时整行反而成功。
 *
 * 结构性放行(不需要白名单,也不该被当成豁免):同一行里出现 `pipefail`、末尾是
 * `|| exit 1` / `|| { …; exit 1; }`、以及 `A && B`(`&&` 短路后行退出码取 A 的失败 ——
 * `&&` 本身不会吞失败)。
 *
 * @returns 失败项列表。
 */
function checkInlineRunExitStatus(file, document, blocks, allowlist, reported) {
  const failures = []
  for (const item of shellSteps(document, blocks)) {
    if (NON_POSIX_SHELLS.test(item.shell)) continue
    // 块标量由 `set -euo pipefail`(约定)与策略 1 覆盖;这里只审单行形态。
    if (item.step.run.includes('\n')) continue
    const signature = normalizeStatement(item.step.run)
    const skeleton = shellSkeleton(item.step.run)
    if (reported.has(statementKey(item, signature))) continue
    const report = problem => {
      if (allowlist.lookup(file, signature) !== undefined) return
      reported.add(statementKey(item, signature))
      failures.push({
        name: file,
        line: item.block?.line ?? 0,
        detail: `[SK-7c] ${stepLabel(item)} ${problem}\n  语句:${signature}`,
      })
    }
    if (SHELL_NEGATION.test(skeleton)) {
      report('用 `!` 取反了退出码 ⇒ 被检查命令失败时整行反而成功。'
        + '要"应当失败"的检查 fail-loud,请写成 `if ! cmd; then echo ::error::…; exit 1; fi`。')
      continue
    }
    if (SHELL_PIPELINE.test(skeleton) && !/\bpipefail\b/u.test(skeleton)) {
      report('把命令接进了管道,而管道退出码只反映最后一段(`| tail -5` 会把失败吃掉)⇒ '
        + '加 `set -o pipefail;` 前缀,或改用块标量 `run: |` + `set -euo pipefail`。')
      continue
    }
    if (INLINE_SWALLOW_TAIL.test(skeleton)) {
      report('末尾命令恒成功(`|| echo` / `; true` / `|| exit 0`)⇒ 失败被吞。'
        + '让最后一条命令保留原退出码,或显式 `|| { echo ::error::…; exit 1; }`。')
    }
  }
  return failures
}

/**
 * 策略自检:三条 SK-7 策略在**合成样本**上必须按预期红/绿(每次运行都执行)。
 *
 * 为什么内置(与 selfTestScanner 同一理由):这三条策略的失效形态同样是"静默放行"。
 * 把任意一条改成恒返回 `[]`(或把白名单放宽成"整文件豁免")⇒ 本自检立刻报错、
 * `node scripts/check-workflows.mjs` exit 1。
 *
 * @returns 自检失败项列表(空 = 通过)。
 */
export function selfTestPolicies() {
  const failures = []
  const workflow = (steps, { timeoutMinutes = 45 } = {}) => [
    'name: selftest',
    'on: push',
    'jobs:',
    '  verify:',
    '    runs-on: ubuntu-latest',
    ...(timeoutMinutes === null ? [] : [`    timeout-minutes: ${timeoutMinutes}`]),
    '    steps:',
    ...steps,
    '',
  ].join('\n')
  const run = (label, steps, options = {}) => {
    const file = options.file ?? 'selftest.yml'
    const result = checkWorkflowText(file, workflow(steps, options))
    return { label, failures: result.failures }
  }
  const tags = (result, tag) => result.failures.filter(failure => failure.detail.includes(tag))
  const expect = (ok, message) => {
    if (!ok) failures.push(message)
  }

  // ---- 策略 1:吞退出码 ----
  const swallowOr = run('|| true', [
    '      - name: go test 被吞',
    '        run: |',
    '          set -euo pipefail',
    '          go test ./... -count=1 -timeout 15m || true',
  ])
  expect(tags(swallowOr, '[SK-7a]').length === 1,
    '[SK-7a] 自检:`go test … || true` 没有被判失败(策略形同不存在)')
  expect(tags(swallowOr, '[SK-7a]').some(failure => failure.detail.includes('go test 被吞')),
    '[SK-7a] 自检:报错没有点名 step')
  const swallowColon = run('; :', [
    '      - name: 冒号吞码',
    '        run: |',
    '          set -euo pipefail',
    '          npm test; :',
  ])
  expect(tags(swallowColon, '[SK-7a]').length === 1, '[SK-7a] 自检:`npm test; :` 没有被判失败')
  const continueOnError = run('continue-on-error', [
    '      - name: continue-on-error 吞码',
    '        continue-on-error: true',
    '        run: yarn check',
  ])
  expect(tags(continueOnError, '[SK-7a]').length === 1,
    '[SK-7a] 自检:`continue-on-error: true` 没有被判失败')
  const swallowedInComment = run('注释/引号里的字面量不算', [
    '      - name: 注释里的 || true 不是吞码',
    '        run: |',
    '          set -euo pipefail',
    '          # 这里写 `|| true` 只是说明,不是吞码',
    '          echo "go test || true"',
  ])
  expect(tags(swallowedInComment, '[SK-7a]').length === 0,
    '[SK-7a] 自检:注释/引号里的 `|| true` 被误判成吞码(假阳性会把白名单逼成大洞)')
  const allowlisted = run('白名单逐条放行', [
    '      - name: 清理类动作走白名单',
    '        run: |',
    '          set -euo pipefail',
    '          rm -rf "$PG18_MOUNT" 2>/dev/null || true',
  ], { file: 'ci.yml' })
  expect(tags(allowlisted, '[SK-7a]').length === 0,
    '[SK-7a] 自检:白名单条目没有生效(逐条登记机制坏了)')

  // ---- 策略 2:超时序关系 ----
  const tooLong = run('-timeout 25m vs job 45', [
    '      - name: 单包 25m',
    '        run: go test ./... -count=1 -p 1 -timeout 25m',
  ])
  const budgetFailure = tags(tooLong, '[SK-7b]')
  expect(budgetFailure.length === 1, '[SK-7b] 自检:`-timeout 25m` 撞 45min job 没有被判失败')
  expect(budgetFailure.some(failure => failure.detail.includes('2×25+5=55 > 45')),
    '[SK-7b] 自检:报错里没有写出算术(2×25+5=55 > 45)')
  expect(budgetFailure.some(failure => failure.detail.includes('单包 25m')),
    '[SK-7b] 自检:报错没有点名 step')
  const withinBudget = run('-timeout 15m vs job 45', [
    '      - name: 单包 15m',
    '        run: go test ./... -count=1 -p 1 -timeout 15m',
  ])
  expect(tags(withinBudget, '[SK-7b]').length === 0,
    '[SK-7b] 自检:当前仓在用的 15m + 45min 被判失败(规则过严 ⇒ 会被绕过)')
  const noBudget = run('job 没有 timeout-minutes', [
    '      - name: 没有 job 预算',
    '        run: go test ./... -timeout 15m',
  ], { timeoutMinutes: null })
  expect(tags(noBudget, '[SK-7b]').length === 1,
    '[SK-7b] 自检:job 缺 timeout-minutes 时没有报错(拿平台默认 360min 证明不了 dump 打得出来)')

  // ---- 策略 3:单行退出码语义 ----
  const pipeline = run('cmd | tail', [
    '      - run: go test ./... -timeout 15m | tail -5',
  ])
  expect(tags(pipeline, '[SK-7c]').length === 1,
    '[SK-7c] 自检:`cmd | tail` 没有被判失败(管道会把左侧失败吃掉)')
  const orEcho = run('cmd || echo ok', [
    '      - run: yarn check || echo skipped',
  ])
  expect(tags(orEcho, '[SK-7c]').length === 1, '[SK-7c] 自检:`cmd || echo ok` 没有被判失败')
  const negation = run('! cmd', [
    '      - run: test -f package.json; ! yarn check',
  ])
  expect(tags(negation, '[SK-7c]').length === 1, '[SK-7c] 自检:`! cmd` 没有被判失败')
  const pipefailOk = run('pipefail 放行', [
    '      - run: set -o pipefail; go test ./... -timeout 15m | tail -5',
  ])
  expect(tags(pipefailOk, '[SK-7c]').length === 0,
    '[SK-7c] 自检:写了 `pipefail` 的安全形态被误判(假阳性)')
  const exitOneOk = run('|| exit 1 放行', [
    '      - run: yarn check || exit 1',
  ])
  expect(tags(exitOneOk, '[SK-7c]').length === 0,
    '[SK-7c] 自检:`|| exit 1` 的安全形态被误判(假阳性)')
  const andChainOk = run('A && B 放行', [
    '      - run: cp a b && yarn check',
  ])
  expect(tags(andChainOk, '[SK-7c]').length === 0,
    '[SK-7c] 自检:`A && B` 被误判 —— `&&` 短路后行退出码取 A 的失败,本身不吞失败')
  const realInline = run('真实形式:命令缺失才安装', [
    '      - run: command -v aws >/dev/null 2>&1 || choco install awscli -y --no-progress',
  ])
  expect(tags(realInline, '[SK-7c]').length === 0,
    '[SK-7c] 自检:ci.yml 里在用的"缺了才装"形态被误判(规则过严 ⇒ 会被绕过)')

  return failures
}

/**
 * 扫描器自检:用一段**合成 workflow** 证明 compact 形态真的会过 `bash -n`。
 *
 * 为什么内置而不是另写一个脚本(2026-09-19 第二轮审计 §3.3 的回归用例):这条门禁的失效
 * 形态是"静默放行"，所以"漏抽"必须由一个**每次运行都执行**的判据抓住:
 *   - 合成的 compact step 带未闭合引号 ⇒ 必须被抽出、且 bash -n 必须报错(门禁的必红判据);
 *   - 覆盖率对账必须能报出"人为去掉的块"(否则那条 fail-loud 只是摆设)。
 * 变异验证:把 extractRunBlocks 的 compact 分支改回旧的 `continue`(静默跳过) ⇒ 本自检
 * 报错、`node scripts/check-workflows.mjs` exit 1。
 *
 * @returns 自检失败项列表(空 = 通过)。
 */
export function selfTestScanner() {
  const failures = []
  const sample = [
    'name: selftest',
    'on: push',
    'jobs:',
    '  selftest:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: echo "未闭合引号',
    '      - name: 正常 compact step',
    '        run: echo compact-ok',
    '      - run: |',
    '          set -euo pipefail',
    '          echo block-ok',
    '      - run: echo 又一个 compact',
    '',
  ].join('\n')
  const blocks = extractRunBlocks(sample)
  const contents = blocks.map(block => block.content)

  const broken = blocks.find(block => block.content.includes('未闭合引号'))
  if (broken === undefined) {
    failures.push('compact 单行形态(`      - run: <cmd>`)没有被抽出 —— 这正是静默跳过的形态')
  } else if (parseShell(broken.content, 'selftest.run.sh') === null) {
    failures.push('compact step 里未闭合的引号没有被 bash -n 抓到(门禁对这批 step 形同不存在)')
  }
  if (!contents.some(content => content.includes('echo block-ok'))) {
    failures.push('compact 块标量形态(`      - run: |`)没有被抽出')
  }
  if (!contents.includes('echo compact-ok')) {
    failures.push('普通内联 `run:`(缩进 8)没有被抽出')
  }

  const document = parseYaml(sample)
  if (uncheckedShellSteps(document, blocks).length !== 0) {
    failures.push(`自检样本里仍有未被检查的 shell 步骤: ${uncheckedShellSteps(document, blocks).join(', ')}`)
  }
  const missingCompact = blocks.filter(block => !block.content.includes('echo "未闭合引号') && !block.content.includes('echo 又一个 compact'))
  const detected = uncheckedShellSteps(document, missingCompact)
  if (detected.length !== 2) {
    failures.push(`覆盖率对账没有发现被漏抽的 2 个 compact step(实际报出 ${detected.length} 个)`
      + ' —— 那条 fail-loud 只是摆设,漏抽仍会静默通过')
  }
  return failures
}

function main() {
  const names = readdirSync(workflowDirectory)
    .filter(entry => entry.endsWith('.yml') || entry.endsWith('.yaml'))
    .sort()
  if (names.length === 0) {
    process.stderr.write('check-workflows: .github/workflows 下没有找到任何 workflow\n')
    process.exit(1)
  }

  const failures = []
  for (const detail of selfTestScanner()) {
    failures.push({ name: '[scanner-selftest]', line: 0, detail })
  }
  // SK-7 三条策略的自检:合成违规样本必须红、安全形态必须绿(策略失效 ⇒ 门禁自己红)。
  for (const detail of selfTestPolicies()) {
    failures.push({ name: '[policy-selftest]', line: 0, detail })
  }
  let total = 0
  const notes = []
  const allowlistHits = []
  let goTestTimeoutHits = 0
  for (const name of names) {
    const result = checkWorkflow(name)
    failures.push(...result.failures)
    total += result.checked
    notes.push(...result.notes)
    allowlistHits.push(...result.allowlistHits)
    goTestTimeoutHits += result.goTestTimeoutHits
  }

  // 白名单死条目对账:登记了却不再命中任何语句的条目必须清掉 —— 否则白名单会悄悄
  // 长成一个"谁都能往里塞一句"的豁免洞(与本脚本"不许整个文件豁免"的口径配套)。
  const deadAllowlist = SWALLOW_ALLOWLIST.filter(
    entry => names.includes(entry.file) && !allowlistHits.includes(entry),
  )
  if (deadAllowlist.length > 0) {
    failures.push({
      name: '[allowlist]',
      line: 0,
      detail: `SWALLOW_ALLOWLIST 有 ${deadAllowlist.length} 条**死条目**(不再命中任何真实语句):\n`
        + deadAllowlist.map(entry => `  - ${entry.file}: ${entry.signature}`).join('\n')
        + '\n  ⇒ 该语句已被改写/删除,白名单必须同步收窄(留下它 = 一个可复用的豁免洞)。',
    })
  }

  // `go test … -timeout` 的存在性对账:全仓一处都没有 ⇒ 单包预算缺失 —— 挂起的包会一路
  // 烧到 job 上限,"panic: test timed out" + goroutine dump 全部丢失(R2-SK-7 的教训)。
  if (goTestTimeoutHits === 0) {
    failures.push({
      name: '[SK-7b]',
      line: 0,
      detail: '没有在任何 workflow 里找到 `go test … -timeout`:单包预算缺失 ⇒ 挂起的包会烧到 job '
        + '上限被整体取消,`panic: test timed out` + goroutine dump + 用例名全部丢失'
        + '(2026-09-19 R2-SK-7)。请给 go test 显式钉一个远小于 job 预算的 -timeout。',
    })
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      const where = failure.line === 0 ? failure.name : `${failure.name}:${failure.line}`
      process.stderr.write(`\ncheck-workflows: ${where}\n`)
      process.stderr.write(`${failure.detail.split('\n').map(line => `  ${line}`).join('\n')}\n`)
    }
    process.stderr.write(`\ncheck-workflows: ${failures.length} 项未通过(共检查 ${total} 个 run 块)\n`)
    process.exit(1)
  }

  // 通过时把"策略真的跑过了"的证据打出来(避免"存在性断言=假绿":看到算术才算数)。
  for (const note of notes) process.stdout.write(`check-workflows: [SK-7b] ${note}\n`)
  if (allowlistHits.length > 0) {
    process.stdout.write(`check-workflows: [SK-7a] 白名单命中 ${allowlistHits.length} 条(逐条登记,含理由):\n`)
    for (const entry of allowlistHits) {
      process.stdout.write(`  - ${entry.file}: ${entry.signature}\n`)
    }
  }
  process.stdout.write(`check-workflows: OK — ${names.length} 个 workflow,${total} 个 shell run 块全部通过 `
    + 'bash -n + SK-7 策略(吞码 / go test 超时序 / 单行退出码)\n')
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main()
}
