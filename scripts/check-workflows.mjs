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
 * 自检的**覆盖下限**与**策略标签清单**(2026-09-19 第三轮审计 F3-4)。
 *
 * 为什么是"下限 + 精确标签集合"而不是"必须恰好 N 个":样本是可以合理地增删的
 * (新增一条策略就加红样本),用"恰好 N"会逼着每次改样本都改常量,久了就没人当真;
 * 而"下限 + 标签集合"抓的正是**掏空**这件事 —— 删掉样本会让数量掉到下限以下,
 * 删掉某条策略的全部红样本会让标签集合少一个。两者都 fail-loud。
 */
/**
 * **块标量**的 errexit 约定白名单(2026-09-19 第三轮审计 F2-3)。
 *
 * 默认规则:每个 `run: |` 块必须自己声明退出语义(`set -euo pipefail` / `set -eo pipefail`,
 * 或等价的 `set -o errexit` + `set -o pipefail`)。只有"块内确实要跑完所有命令再汇总"
 * 这类语义时,才在这里逐条登记 + 写明理由。
 *
 * 与 SWALLOW_ALLOWLIST 同一纪律:
 *   - 粒度是**单个块**(`job + step 名`),没有"整个文件豁免";
 *   - 死条目会被对账:登记的块如果已经被补上 `set -e…`(不再需要豁免)⇒ 报错要求删掉,
 *     否则白名单会悄悄长成一个可复用的豁免洞。
 */
const BLOCK_ERREXIT_ALLOWLIST = [
  {
    file: 'ci.yml',
    key: 'block-errexit:server:Deployment asset syntax checks',
    // 为什么这个块**必须跑完再汇总**:它有三条互斥的资产检查(容器 entrypoint 的
    // `bash -n` → compose 语法 → PG18 挂载点运行验证),按 `if/elif/else` 逐条判定,
    // 每条都自带 `echo "::error::…"; exit 1`。若开 errexit,第一条**基础设施性**失败
    // (例如 `docker compose config -q` 因 runner 上 docker 版本差异返回非 0、而下一
    // 条检查本来能给出更准确的结论)会让后面两条检查根本不执行 ⇒ 报告只剩第一个症状,
    // 运维得"改一次跑一次"。块内所有"失败也不该中断"的清理(`docker rm -f … || true`、
    // `rm -rf … || true`)已逐条登记在 SWALLOW_ALLOWLIST;这条豁免只针对 errexit。
    reason: '三条互斥的部署资产检查(bash -n → compose 语法 → PG18 挂载点)必须**都跑到**,'
      + '否则只报第一个症状、后两条的结论丢失;每条检查都自带显式 ::error:: + exit 1,'
      + '退出语义由块自己保证。该块的清理语句已逐条登记在 SWALLOW_ALLOWLIST。',
  },
  {
    file: 'ci.yml',
    key: 'block-errexit:desktop-linux:Collect E2E report & screenshots',
    // 为什么这个块**必须跑完再汇总**:它要收集的是**三份互相独立**的证据
    // (e2e 报告 / e2e 截图 / 右栏 e2e 截图),而这三份在失败路径上**本来就可能缺**
    // —— `run` 的三条 `cp` 因此都带 `|| true`。开 errexit 的后果是:第一份缺失
    // (最常见)就让 step 立刻红,后两份**来得及上传的证据也一起丢**,而这一步的
    // 唯一职责恰恰是"失败也把证据留下来"(step 上是 `if: always()`)。
    reason: '证据收集步骤(`if: always()`):三份证据(报告/截图/右栏截图)在失败路径上'
      + '本来就可能缺失,必须**逐个尝试收集完**再一次上传;开 errexit 会让第一份缺失就中断,'
      + '把后两份能拿到的证据一起丢掉 —— 而"失败也留证据"正是这一步存在的全部理由。'
      + '三条 `cp … || true` 已逐条登记在 SWALLOW_ALLOWLIST。',
  },
  {
    file: 'notary-probe.yml',
    key: 'block-errexit:probe:Logs for known submissions',
    // 为什么这个块**必须跑完再汇总**:这是"聚合退出码"的教科书形态 —— 逐个
    // `xcrun notarytool log <id>`,单条失败记 ::error:: 并把 `failed` 累加 1,
    // 循环结束后 `if [ "$failed" -ne 0 ]; then … exit 1; fi` 统一失败。
    // 探针的用途是"一次拿到全部 submission 的状态",开 errexit 会让第一条失败
    // (例如某个 id 仍在 processing)中断循环,后面几条的状态**这一轮就问不到了**,
    // 而使用者往往要等几分钟才能再跑一次。
    reason: '聚合退出码的正例:逐个查询 submission,单条失败记 ::error:: 并累加 `failed`,'
      + '循环结束后统一 `exit 1`。必须**问完全部 submission 再判定** —— 开 errexit 会让'
      + '第一条失败(常见:该 id 仍在 processing)中断循环,后面几条的状态这一轮就拿不到了。',
  },
]

const SELFTEST_MIN_SAMPLES = 30
/** 必须被策略报出来的红样本下限(与上一条同口径)。 */
const SELFTEST_MIN_RED_SAMPLES = 20
/**
 * 红样本必须覆盖的策略标签(精确匹配,不能靠 `includes` —— `[SK-7]` 是 `[SK-7a]` 的
 * 前缀,子串匹配会把"某条策略没有样本盯着"放过去)。`[SK-7]` = 块级 errexit 策略。
 */
const SELFTEST_EXPECTED_POLICIES = ['SK-10', 'SK-11', 'SK-12', 'SK-7', 'SK-7a', 'SK-7b', 'SK-7c', 'SK-8', 'SK-8b', 'SK-9']

/** `selfTestScanner()` 至少执行的断言条数(供 main() 对账"自检没被掏空")。 */
const SELFTEST_SCANNER_ASSERTIONS = 5
/** `selfTestFatalPaths()` 至少执行的断言条数(4 样本 + 覆盖对账 2 条)。 */
const SELFTEST_FATAL_PATH_ASSERTIONS = 6

/**
 * `selfTestFatalPaths()` 必须覆盖的致命路径(2026-09-19 第三轮审计 F2-1)。
 * 与 SELFTEST_EXPECTED_POLICIES 同一手法:声明一份清单,断言实际跑到的就是它。
 */
const SELFTEST_EXPECTED_FATAL_PATHS = [
  'yaml-parse-error',
  'missing-jobs-map',
  'no-run-blocks',
  'reusable-only-job',
]

/**
 * `checkWorkflowText` 的**统一返回形状**（成功路径与三条 early return 共用）。
 *
 * 为什么必须统一（2026-09-19 第三轮审计 F2-1，本批新引入的 bug）：`main()` 无条件
 * `notes.push(...result.notes)`，而 YAML 解析失败 / 顶层缺 jobs / 解析出的 run 块数为 0
 * 这三条 early return 只返回 `{failures, checked}` ⇒ `notes` 是 `undefined` ⇒
 * `TypeError: result.notes is not iterable` 在 `main()` 里抛出，**已经收集到的
 * failures 一条都打不出来**（PR 上只剩一段 Node 栈，连"哪个文件哪一行"都没有）。
 * 这正是本门禁存在的理由的反面：静态检查报错必须自己先能读。
 *
 * 修法两层：①三条 early return 走这个构造函数（形状恒定，字段永远可迭代）；
 * ②`main()` 侧再加一道 `??` 兜底 —— 万一将来又有人加了一条忘了形状的 early return，
 * 也不能把诊断信息吞掉（宁可少一行 note，也不能吞 failures）。
 *
 * @param failures - 已收集的失败项。
 * @param options - `checked`（已过 bash -n 的块数）与已有的 notes/hits。
 * @returns 形状恒定的检查结果。
 */
function workflowResult(failures, { checked = 0, notes = [], allowlistHits = [], goTestTimeoutHits = 0 } = {}) {
  return { failures, checked, notes, allowlistHits, goTestTimeoutHits }
}

/**
 * 检查一份 workflow 文本（纯函数：变异验证与内置自检都调它，不落任何文件）。
 * @param name - 文件名（只用于失败信息与白名单键）。
 * @param text - workflow 内容。
 * @returns `{failures, checked, notes, allowlistHits, goTestTimeoutHits}`（三条 early
 *   return 与成功路径**形状相同**，见 workflowResult）。
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
    // 解析失败就是"这个文件不能跑",但**文件:行 + 原因**必须先说出来(2026-09-19 第三轮
    // 审计 F2-1):此前这条路径的 failures 会被 main() 的 TypeError 全部吞掉。
    failures.push({
      name,
      line,
      detail: `YAML 解析失败: ${cause?.message ?? String(cause)}`
        + '\n  ⇒ 这个 workflow 无法被 GitHub 解析(整个文件失效,里面所有 step 都不会跑)。'
        + '修好 YAML 再重跑;本门禁只做到"报出文件:行 + 原因",不猜你的意图。',
    })
    return workflowResult(failures)
  }
  if (typeof document !== 'object' || document === null || typeof document.jobs !== 'object' || document.jobs === null) {
    failures.push({
      name,
      line: 0,
      detail: 'YAML 顶层缺少 jobs 映射'
        + '\n  ⇒ GitHub 只把带 `jobs:` 的 workflow 当成可运行流水线,没有 jobs 的文件等于空转'
        + '(PR 上表现为排队的检查永远不出现)。',
    })
    return workflowResult(failures)
  }
  for (const [jobId, job] of Object.entries(document.jobs)) {
    if (!Array.isArray(job?.steps) || job.steps.length === 0) {
      // job 级 `uses:` = 调 reusable workflow（没有自己的 steps，shell 语义由被调方决定）。
      // 合法形态，不能报错 —— "解析出 0 个 run 块"也不该被当成扫描器退化（2026-09-19
      // 第三轮审计 F2-1 的第一条触发路径：新增一个只调 reusable workflow 的 job）。
      if (typeof job?.uses === 'string' && job.uses.trim() !== '') continue
      failures.push({ name, line: 0, detail: `job ${jobId} 没有 steps` })
      continue
    }
    for (const step of job.steps) {
      if (typeof step?.run === 'string' && typeof step.uses === 'string') {
        failures.push({ name, line: 0, detail: `job ${jobId} 的某个 step 同时有 run 与 uses` })
      }
      if (typeof step?.run === 'string' && executableScript(step.run).includes('ci-channel-transfer.sh')) {
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
        && executableScript(step.run).includes('ci-package-clients.sh')
        && executableScript(step.run).includes('*.dmg')
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
        // "真的调了公证"必须落在**命令**上:先剥注释、再剥引号内容 —— 否则
        // `echo "… dist:mac:notarize"` 这种回显就能满足判据(C-CI-3 的同类形态)。
        if (!stripQuotedPayloads(executableScript(step.run)).includes('dist:mac:notarize')) {
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
      // GitHub Release 的「名字」与「说明」判据(2026-09-11 定案)已迁到 [SK-11],
      // 且从"整段 YAML 子串匹配"改成**解析调用参数**(2026-09-23 审计 C-CI-3:
      // 旧写法把 `--title "${TAG}"` 注释掉仍 EXIT=0,而等价的 `--title "$TAG"` 反被判红)。
    }
  }

  const blocks = extractRunBlocks(text)
  if (blocks.length === 0) {
    // 扫描器退化保护:正常情况下一个 workflow 不可能没有任何 run 块。
    //
    // 但"0 个 run 块"也可能是**合法**的(2026-09-19 第三轮审计 F2-1 的触发路径):
    // 全部 job 都只调 reusable workflow(`uses:`),自己没有 shell 步骤。所以要分两种
    // 形态报不同的话 —— 合法但无内容 ⇒ 说清"这个文件没有可静态检查的 shell",让读者
    // 一眼知道该去看被调用的那个 workflow;真的扫描器退化 ⇒ 仍然 fail-loud。
    // 无论哪一种都走 workflowResult():此前这条 early return 少了 notes,main() 直接
    // TypeError,把 failures 全吞了。
    const jobs = Object.entries(document.jobs)
    const allReusable = jobs.length > 0 && jobs.every(([, job]) => typeof job?.uses === 'string' && job.uses.trim() !== '')
    const detail = allReusable
      ? `job ${jobs.map(([id]) => id).join(', ')} 只调 reusable workflow(uses:),本文件没有可检查的 shell 步骤`
        + '\n  ⇒ 这不是缺陷,但"bash -n 与 SK-7 策略扫过 0 个块"必须说清楚:'
        + '被调用的那个 workflow 要单独扫(它自己的 run 块在这里看不见)。'
      : '未解析出任何 run 块 —— 扫描器可能已失效,请检查 extractRunBlocks'
        + '\n  ⇒ 门禁对这份文件形同不存在(它一个 shell 步骤都没看),不能当通过。'
    failures.push({ name, line: 0, detail })
    return workflowResult(failures)
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
  // 策略 4(2026-09-19 第三轮审计 F2-3):块标量里的 `|| exit 0` / `! cmd` / 管道 + 缺
  // `set -eo pipefail` 三类静默失败。挂在白名单与 reported 去重之后,与 7a/7c 同口径。
  failures.push(...checkBlockScalarErrorHandling(name, document, blocks, allowlist, reported))
  // 策略 5(2026-09-23 第三轮审计 R3-C C-7/C-3):CI 不得把根门禁换成弱化形态,
  // 且 docs-only 判定不得跳过根守卫。
  failures.push(...checkRootGateIntegrity(name, document, text, notes))
  // 策略 6(C-CI-1):docs-only 分类器的规则逐条钉死(改宽/改窄都要红)。
  failures.push(...checkDocsOnlyClassifier(name, document, text, notes))
  // 策略 7(C-CI-2/C-CI-3):发布面语义判据(策展说明位置 + gh release argv)。
  failures.push(...checkReleaseSurface(name, document, text, notes))
  // 策略 8(W-4/W-5):WASM 门禁的两处接线(用例级报告 + 协议探针)。
  failures.push(...checkWasmGateWiring(name, document, notes))

  return workflowResult(failures, {
    checked,
    notes,
    allowlistHits: allowlist.hits,
    goTestTimeoutHits: budget.hits,
  })
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
  // 2026-09-19 第三轮审计 F2-3:块标量里 `cmd || exit 0` / `cmd || echo ok` 同样让失败
  // 静默 —— 而且是最难发现的一种(`set -e` 与 `pipefail` 都拦不住:整行的退出码就是
  // 那个恒成功的末尾命令)。
  //
  // 判据限定在**失败被换成成功**的形态(见 isSilentSuccessTail):`cmd || echo ok`、
  // `cmd; exit 0` 报;而 `echo "code=false" >> "$GITHUB_OUTPUT"`、`echo "ok"; exit 0`
  // 这类"本来就不可能失败"的行不报 —— 第三轮审计把"收紧过度引入假阳性"列为下一轮的
  // 新缺陷来源,所以这里按语义收敛,而不是按关键字收敛。
  // `|| exit 1` 等安全形态由 isSafeFailureTail 放行。
  { re: /\|\|\s*(?:exit(?:\s+0)?|echo|printf|break|continue|logger)(?![\w-])/u, form: '|| exit 0 / || echo / || break(失败被换成成功)' },
  { re: /;\s*(?:exit(?:\s+0)?|echo|printf)(?![\w-])/u, form: '; exit 0 / ; echo(失败被换成成功)' },
]

/**
 * 语句尾部的**安全**形态:失败照样传出去,不该被吞码策略报成假阳性。
 *
 *   - `|| exit 1` / `; exit 1`(含 `exit 2` 等非 0);
 *   - `|| { …; exit 1; }`(花括号块里显式非 0 退出);
 *   - `|| return 1`。
 *
 * 注意:`|| exit 0` **不**在放行之列 —— 这正是 F2-3 要抓的形态。
 */
const SAFE_FAILURE_TAIL = /(?:\|\||;)\s*(?:\{\s*[^}]*\b(?:exit|return)\s+[1-9]\d*\s*;?\s*\}|(?:exit|return)\s+[1-9]\d*)(?![\w-])/u

/**
 * 引号包裹形态:`bash -c '…'` / `sh -c "…"` / `eval "…"` —— 把吞码语句包进引号再交给
 * shell 执行(2026-09-19 第三轮审计"仍为假护栏"的第 4 类)。
 *
 * 为什么必须单独递归:`shellSkeleton` 会把**引号内**的内容整体屏蔽(它本来是为了避免
 * `echo "go test || true"` 这种字面量误报),于是 `bash -c 'npm test || true'` 里的
 * `|| true` 在骨架里看不见 —— 策略判绿,而运行时 shell 真的把失败吞了。这是"用引号
 * 绕过静态检查"的形态,不是假阳性问题。
 */
const QUOTED_SHELL_INVOCATION = /(^|[^A-Za-z0-9_.-])(bash|sh|zsh|dash|ksh)\b|(^|[^A-Za-z0-9_.-])eval\b/u

/**
 * `go test` 命令行(取**逻辑行**:`\` 续行先合并,见 logicalShellLines)。
 *
 * 只认**命令起始位置**(行首 / `;` / `&&` / `||` / `|` / `(` 之后,可选 `sudo`、`env`
 * 与 `VAR=value` 前缀)—— 否则 `echo "go test || true"` 这种把命令**当字符串打印**的
 * 行会被当成真的 go test 命令,报出一条"这条命令没有 -timeout"的假阳性(门禁收紧后
 * 的误报会把白名单逼成大洞)。
 */
const GO_TEST_COMMAND = /(?:^|[;&|(]|\$\()\s*(?:sudo\s+|env\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*go\s+test\b[^\n]*/gu
/**
 * `-timeout <值>` / `-timeout=<值>`(Go 的 flag 两种写法)。
 *
 * 2026-09-19 第三轮审计 F2-2/F3-1 的两处修正:
 *   - 分隔符 `[= ]` 只吃一个字符 ⇒ `-timeout  120m`(两个空格)漏检;现在用 `[=\s]+`;
 *   - 值必须能判读成"数字 + 单位",否则**不能静默 continue** —— 见 checkGoTestTimeoutBudget。
 * 同时这里保留"有 `-timeout` 这个 flag 但值不可读"的分支(值捕获组可以是变量/空)。
 */
const GO_TEST_TIMEOUT_FLAG = /(?<![-\w])-timeout(?:=|\s+)(\S+)?/gu
/** Go 的 time.ParseDuration 形态:`30s` / `15m` / `2h`(必须有单位;裸数字不是合法 duration)。 */
const GO_DURATION = /^(\d+)(s|m|h)$/u
/**
 * `-timeout` 的**下界**:低于一分钟的全局测试超时没有意义 —— 最慢的包要几百秒,任何
 * <1m 的取值都会让"挂起的包"变成"正常慢的包也一起被砍",而 Go 的 `-timeout 0` 更是
 * **关闭超时**(语义完全相反)。见 checkGoTestTimeoutBudget 的长注释。
 */
const GO_TEST_TIMEOUT_FLOOR_MINUTES = 1
/**
 * 管道(`|` 但不是 `||`)。
 *
 * 用"管道符后面必须跟空白或命令首字符"来排除两种**非管道**的 `|`:
 *   - `case` 分支的多个模式:`docs/*|site/*)` —— 那是模式分隔符,不是管道;
 *   - `[[ a || b ]]` 里的 `||` —— 由前置的 `[^|]` 排除。
 * 2026-09-19 第三轮审计把这批误报当成"收紧过度"的风险点,所以这里按最小可用集收敛。
 */
const SHELL_PIPELINE = /(^|[^|])\|(?=\s|\$|\()/u
/**
 * 末尾吞码:`cmd || echo ok` / `cmd; true` / `cmd || exit 0`(末尾命令可带参数)。
 * 允许末尾命令外面包一层分组 `( … )` / `{ …; }`(`cmd || (exit 0)`,2026-09-19 审计的 c4)。
 */
const INLINE_SWALLOW_TAIL = /(?:\|\||;)\s*[({]?\s*(?:true|:|echo|exit\s+0)(?![\w-])[^;&|]*;?\s*[)}]?\s*$/u
/**
 * `!` 取反(行首或跟在 `;`/`&`/`|` 之后)。
 *
 * 两种**结构性豁免**(不是这次运行才放行,而是语义上"取反不等于吞失败"):
 *   - `if ! cmd; then … fi` / `while ! cmd` / `elif ! cmd`:取反后接 `;` 或 `then`,
 *     失败会被 `else`/`fi` 分支显式处理 —— 门禁推荐的写法本身就是它;
 *   - `[[ … ]]` / `[ … ]` 里的 `!`:那是**模式取反**(`[[ ! -f x ]]`),不是命令取反。
 */
const SHELL_NEGATION = /(?:^|[;&|])\s*!\s*\S/u
/** `if ! cmd` / `while ! cmd` / `elif ! cmd`(取反结果交给分支处理)。 */
const NEGATION_IN_CONDITION = /\b(?:if|elif|while|until)\s+!\s+/u

// ===== SK-8 / SK-9:根门禁调用的形态,以及"docs-only 不得跳过根守卫" =====
//
// 现场一(2026-09-23 第三轮审计 R3-C C-7):把 gate 那一步改成
// `yarn check --no-guards`(丢掉**全部**根守卫)/ `--only <单包>`(只跑一个包)/
// `--changed <ref>`(只跑改动映射到的包)/ `check:fast`(就是 `--changed` 的别名),
// 四种变异在 `check-workflows.mjs` 下**全部 EXIT=0** —— bash -n 合法,SK-7 的三条
// (吞码 / 超时序 / 单行退出码)也都不适用。这属于"守卫与被守卫对象的**语义**脱钩":
// 静态策略钉住了 shell 层面的吞码手法,却没钉住"CI 调用的必须是全量、带守卫的那一种
// `yarn check`"。
//
// 现场二(C-3):docs-only(`docs/*` `site/*` 任意 `*.md`)的 PR 让 gate 整条被 job 级
// `if:` 跳过,而 GitHub 分支保护把 skipped 的必需检查记成**成功**(线上 PR #129 就是
// Gate=skipped 后合并的)⇒ 16 个根守卫里判据落在文档上的那几条(铁律 0 的域名、迁移
// 区间、文档数字、布局记录)**一次都没跑**。
//
// 判据:
//   [SK-8] **调用形态**:根门禁调用(见 ROOT_GATE_INVOCATION)不得带
//          `--no-guards` / `--only` / `--changed` / `--list` / `--help` / `-h`;
//          `yarn check:fast` 一律禁止(它就是 `--changed`)。`--concurrency N` 与
//          `--full-output` 只影响并发与日志、不减少覆盖面 ⇒ 放行。
//   [SK-9] **docs-only 不得跳过根守卫**(只在"这份 workflow 有 docs-only 机制",
//          即出现 `needs.changes.outputs` 时生效 —— 没有该机制就没有这个缺口):
//          ① 恰好一次**参数向量为空**的全量 `yarn check`(承载它的 job 记作"门禁 job");
//          ② 必须存在一个**结构上无法被跳过**的守卫 job(`node
//             scripts/check-root-guards.mjs` 就是它的 run;它不得有 `if:`,也不得
//             有 `needs:` —— 有 needs 时上游失败会把它变成 skipped,而 skipped 在
//             分支保护里算成功);
//          ③ 门禁 job 必须 `needs` 那个守卫 job,且必须有一条"守卫 job 未成功即
//             `exit 1`"的步骤 —— 这是"守卫失败 ⇒ 必需的 Gate 检查也红"的唯一链路
//             (守卫 job 加进分支保护之前靠它兜住);
//          ④ 门禁 job 的 `if:` 不得引用 docs-only 输出;全量那一步若写了 `if:`,
//             必须是 `!= 'false'` 形态(fail-safe:changes 失败/输出为空时走完整路径)。
//   [SK-8b] **跑全量门禁的 job 必须拿到完整历史**:该 job 的 `actions/checkout`
//          必须 `fetch-depth: 0`(且在门禁步之前)。C-4 的另一半:depth-1 检出解析不到
//          提交信息区间的 base,`check-no-real-domains` 的提交信息判据就恒为空跑。
//          守卫侧另有 fail-loud 兜底(区间解析不到 ⇒ EXIT=3),这条是让它不必触发的那半。
//   [SK-10] **docs-only 分类器的规则逐条钉死**(C-CI-1:改宽改窄都要红):
//          ① 分类步的 `case` 分支必须与登记表**逐条同序**相等(顺序本身是判据:
//             `*.md` 若排在 `*/*` 之前,任意深度的 markdown 又会被当成文档);
//          ② `code=false` 只允许写一次(唯一出口是"判定为 docs-only");
//          ③ fail-safe 的 `code=true` 至少三处(tag / base 不可用 / 空 diff);
//          ④ 承载分类器的 job 不得有 `if:`(它必须永远运行)。
//   [SK-11] **发布面(策展说明 + GitHub Release)的语义判据**:
//          ① 正式 tag 缺 `docs/releases/<tag>.md` 必须 fail-loud,且**两处**:
//             gate 里的早检(1 分钟内红)与 release job 里、**任何对外上传之前**的
//             第二道(C-CI-2:此前第二道排在 R2 上传之后 ⇒ 半发布窗口);
//          ② `gh release create|edit` 的 argv 必须带 `--title` 且取值引用 tag 变量;
//             必须有说明来源(`--notes-file` / `--notes` / `--generate-notes`,含在同
//             一脚本里赋值的变量)。判据一律跑在**去掉注释后的可执行文本**上 ——
//             子串匹配的旧写法把关键行注释掉就能静默通过(C-CI-3)。
const ROOT_GATE_INVOCATION = /(?:^|[;&|(\n]|\$\()\s*(?:corepack\s+yarn|yarn|node\s+scripts\/check-workspaces\.mjs)\s+(check:fast(?![:\w-])|check(?![:\w-]))((?:[ \t]+[^\s;&|>()]+)*)/gu
/** 减少覆盖面的参数(R3-C C-7 的三种写法 + 两个"什么都不跑"的形态)。 */
const ROOT_GATE_WEAKENING_FLAGS = ['--no-guards', '--only', '--changed', '--list', '--help', '-h']
/** 永远运行那个守卫 job 的 run 内容(docs-only 的 PR 也跑)。 */
const DOCS_ONLY_GUARD_RUNNER = 'scripts/check-root-guards.mjs'
/** docs-only 分类器的登记形态(顺序即判据,见 [SK-10])。 */
const DOCS_ONLY_CLASSIFIER_CASES = [
  ['docs/*', 'docs'],
  ['site/*', 'docs'],
  ['*/*', 'code'],
  ['*.md', 'docs'],
  ['*', 'code'],
]
/**
 * [SK-12] WASM 门禁接线(2026-09-23 第三轮审计 W-4/W-5)。
 *
 * 为什么需要静态判据:这两条判据的**脚本侧**早就存在(`scripts/wasm/check-go-test-json.mjs`
 * 与 `scripts/verify-wasm-client-only.sh --groups 6`),但 `.github/` 对它们 **0 引用** ⇒
 * "从不执行"在 CI 侧不会被任何东西发现。接线只有几行,而最容易发生的退化是:
 * ① 把 `--scope`/`--require` 改松(判据变成恒绿);
 * ② 判定脚本的退出码被丢掉(少了 `exit 1` 这类把判定变成失败的收口);
 * ③ 探针那一步的"平台未覆盖即显式 SKIP"开关被摘掉(非 Linux 上"跑完给结论")。
 */
const WASM_CASE_GATE_SCRIPT = 'scripts/wasm/check-go-test-json.mjs'
/** W-4 的三条关键用例(与 `scripts/verify-wasm-client-only.sh` 组 3 同一份名单)。 */
const WASM_CASE_GATE_REQUIRED = [
  'TestClientRequest_LoginRequiredWithoutIdentityIs401',
  'TestCheckClientOrigin',
  'TestClientFrameUser_ProjectsUserRowAndPublisherFlag',
]
/** W-4 的判定范围(与组 3 同面;全仓套"零 skip"会因环境条件型 skip 变成每次必红的假红)。 */
const WASM_CASE_GATE_SCOPE = ['internal/wasmapp', 'internal/router']
/** W-5 的探针组与它必须带的"非覆盖平台显式 SKIP"开关。 */
const WASM_PROBE_GROUPS = ['6']
const WASM_PROBE_ENV = 'WASM_GATE_REQUIRE_COVERED_PLATFORM'

/**
 *
 * 刻意**不含** `ci-channel-transfer.sh`:它上传的是 R2 上那个 run 级临时中转前缀
 * (不可猜、由 release job 的 `if: always()` 步骤销毁),不是客户侧更新面;把它算进来
 * 会让三个 desktop 打包 job 都要求一份发布说明检查 —— 那不是这条 finding 的面。
 */
const EXTERNAL_UPLOAD_COMMANDS = [
  'ci-publish-update-server.sh',
  'gh release create',
  'gh release edit',
  'gh release upload',
]

/** `gh release create|edit` 的调用点(捕获子命令与同一行的其余 argv)。 */
const GH_RELEASE_INVOCATION = /(?:^|[;&|(\n]|\$\()\s*gh\s+release\s+(create|edit)\s+([^\n;&|]*)/gu

/**
 * **可执行文本**:逐行去掉注释后的 run 内容。
 *
 * 为什么所有"命令里有没有 X"的判据都要走它(2026-09-23 审计 C-CI-3):旧实现直接对
 * YAML 里的原始 `run` 做子串匹配,于是把关键行**注释掉**仍能通过 —— 审计方实测
 * `--title "${TAG}"` 只在注释里时 `check-workflows.mjs` **EXIT=0**。
 * @param run - step.run 原文。
 * @returns 去掉整行/行尾注释的文本。
 */
function executableScript(run) {
  return run.split('\n').map(line => stripLineComment(line)).join('\n')
}

/** 把行尾 `\` 续行接成一行(argv 解析需要;`gh release … \` 是多行写法)。 */
function joinContinuations(script) {
  return script.replace(/\\\n[ \t]*/gu, ' ')
}

/** step 的展示名(自检与失败信息共用)。 */
function stepName(step, index) {
  return typeof step?.name === 'string' && step.name.trim() !== '' ? step.name : `第 ${index + 1} 步`
}

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

/**
 * 去掉一行的**行内注释**(`#` 到行尾),引号内的 `#` 不算注释。
 *
 * 用于 SK-7b(2026-09-19 第三轮审计 F3-2):块标量里写一句历史注释
 * `# 旧写法: go test ./... -timeout 120m` 会让超时策略**误报**(假阳性),而它此前
 * 既没有注释剥离、也没有白名单出口 ⇒ 门禁卡死、只能靠改注释绕过。
 * `shellSkeleton` 只屏蔽了"整行以 # 开头"的注释,对行尾注释无能为力。
 *
 * @param line - 原始行。
 * @returns 去掉行尾注释后的行。
 */
export function stripLineComment(line) {
  let out = ''
  let quote = null
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (char === '\\' && quote !== "'" && index + 1 < line.length) {
      out += char + line[index + 1]
      index += 1
      continue
    }
    if (quote !== null) {
      out += char
      if (char === quote) quote = null
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      out += char
      continue
    }
    if (char === '#' && (index === 0 || /\s/u.test(line[index - 1]))) break
    out += char
  }
  return out
}

/**
 * 把 `\` 续行合并成**逻辑行**(并剥离行尾注释)。
 *
 * 为什么需要(2026-09-19 第三轮审计 F3-1):`go test ./... \` + 换行 + `-timeout 120m`
 * 是 shell 里合法的一条命令,而逐行扫描时没有任何一行同时含 `go test` 与 `-timeout`
 * ⇒ 静默通过。合并后按逻辑行判,`\` 续行里写的超时再也跑不掉。
 *
 * @param content - 脚本文本。
 * @returns `{text, lines}`;lines 记录每个逻辑行对应的源行号(1-based,取起始行)。
 */
export function logicalShellLines(content) {
  const physical = content.split('\n')
  const text = []
  const lines = []
  let buffer = ''
  let startLine = 0
  for (let index = 0; index < physical.length; index += 1) {
    const stripped = stripLineComment(physical[index])
    if (buffer === '') startLine = index + 1
    if (/\\\s*$/u.test(stripped)) {
      buffer += stripped.replace(/\\\s*$/u, ' ')
      continue
    }
    buffer += stripped
    text.push(buffer)
    lines.push(startLine)
    buffer = ''
  }
  if (buffer !== '') {
    text.push(buffer)
    lines.push(startLine)
  }
  return { text, lines }
}

/**
 * 语句尾部是否有"失败照样传出去"的安全形态(用于 `|| exit 0` / `|| echo` 的假阳性方向)。
 * @param skeleton - 去引号/注释后的语句骨架。
 * @returns 安全形态为 true。
 */
function isSafeFailureTail(skeleton) {
  return SAFE_FAILURE_TAIL.test(skeleton)
}

/**
 * 这一行是否有未闭合的引号(跨行字符串的首行/中间行)。
 *
 * 用途:`-- bash -c '` 这种写法把内层脚本放到**后面的行**,单行视角永远取不到内层。
 * 块级 errexit 策略(策略 4)已经要求整块自己声明退出语义,所以这里不重复报"内层
 * 读不出"—— 但**单行**里就能看出的坏引号仍会被 `bash -n` 抓住,不靠这条判据。
 *
 * @param line - 语句(已去注释)。
 * @returns 引号不配平为 true。
 */
function hasUnbalancedQuote(line) {
  let quote = null
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (char === '\\' && quote !== "'") {
      index += 1
      continue
    }
    if (quote === null && (char === "'" || char === '"')) quote = char
    else if (char === quote) quote = null
  }
  return quote !== null
}

/**
 * 语句尾部是否是"**失败被换成成功**"的形态(`cmd || echo ok` / `cmd; exit 0`)。
 *
 * 与 `isSafeFailureTail` 精确互补:
 *   - `cmd || echo ok` ⇒ 左侧 `cmd` 的失败被 `echo` 的成功顶掉 ⇒ **报**;
 *   - `cmd || echo "::error::…"; exit 1` ⇒ 打印完还是失败 ⇒ 不报(isSafeFailureTail);
 *   - `echo x >> "$GITHUB_OUTPUT"; exit 0` ⇒ 左侧根本不会失败(echo/printf/赋值/
 *     流程控制) ⇒ **不报**。这条排除是"收紧过度"的防线:`E="$?"`、`echo …` 这类
 *     语句后面接 `; exit 0` 是显式流程控制,不是吞码;把它报成吞码会逼人往白名单里
 *     塞一堆噪音(白名单一长就不是护栏了)。
 *   - `cmd || echo ok && exit 1` ⇒ 后面还有失败判定 ⇒ 不报(保守方向:宁可漏报这种
 *     罕见写法,也不要把 `|| echo` + `exit 1` 的正常写法报成假阳性)。
 *
 * @param skeleton - 去引号/注释后的语句骨架。
 * @returns 命中"静默变成功"为 true。
 */
export function isSilentSuccessTail(skeleton) {
  // 末尾命令集合与 SWALLOW_PATTERNS 一一对应(`true` / `:` 是最常见的恒成功命令,
  // 漏掉它们会让 `cmd || true` 判成"不静默" —— 那正好是最经典的一条)。
  // `|| (exit 0)` / `|| { exit 0; }` 这类**分组包裹**的末尾命令同样恒成功(2026-09-19
  // 审计的 c4 形态),所以允许命令前有一个 `(`/`{` 与空白。
  const match = /(?:\|\||;)\s*[({]?\s*(?:(exit)(?:\s+([0-9]+))?|(true|:|echo|printf|break|continue|logger))(?![\w-])/u.exec(skeleton)
  if (match === null) return false
  // `|| exit <非 0>` / `; exit <非 0>`:显式失败,不报。
  if (match[1] !== undefined && match[2] !== undefined && match[2] !== '0') return false
  if (isSafeFailureTail(skeleton)) return false
  const tail = skeleton.slice(match.index + match[0].length)
  // 尾部后面紧接着 `&& exit 1` / `|| exit 1`:失败结论仍然成立。
  if (/(?:&&|\|\|)\s*(?:exit|return)\s+[1-9]/u.test(tail)) return false
  // 左侧前缀"不可能失败"(全是 echo/printf/赋值/流程控制)⇒ 没有失败可吞,不报。
  // 注意:`x="$(cmd || true)"` 这种"命令替换里的兜底"**照报** —— 它同样让那句话的失败
  // 消失,只不过程度比 `|| echo` 轻(至少下一句还能判定空值)。本仓那条就是靠
  // SWALLOW_ALLOWLIST **逐条登记 + 写明理由**放行的,不靠启发式放过:启发式一旦放宽,
  // 下一个真正危险的 `|| true` 就会搭同一条便车。
  const prefix = skeleton.slice(0, match.index).trim()
  if (isHarmlessPrefix(prefix)) {
    // `cmd && echo …; exit 0` 这种链里 `cmd` 仍可能失败 —— 前缀含 `&&`/`||`/`;` 时要看链条。
    if (!/[&|;]/u.test(prefix)) return false
  }
  return true
}

/** 空转命令（跑完必成功，与 SWALLOW_PATTERNS 的命令集合一一对应）。 */
const HARMLESS_COMMANDS = ['echo', 'printf', 'true', ':', 'break', 'continue', 'return']

const isWordChar = (ch) => ch !== undefined && /[A-Za-z0-9_]/u.test(ch)

const isBlank = (ch) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r'

/**
 * 跳过一段"值"（shell 的相邻片段拼接：裸串 / 双引号 / 单引号），返回结束下标。
 *
 * 引号只有在**闭合且闭合后紧跟空白**时才算"引号片段"（`A="a b" `）；否则它就是普通字符
 * （`A=x"y ` / `A="a"b" `）—— 这正是旧正则从 `"[^"]*"` 回退到 `\S*` 的行为，逐字对齐。
 */
function skipAssignmentValue(text, from) {
  let i = from
  while (i < text.length) {
    const ch = text[i]
    if (isBlank(ch)) break
    if (ch === '"' || ch === "'") {
      const close = text.indexOf(ch, i + 1)
      if (close !== -1 && isBlank(text[close + 1])) { i = close + 1; continue }
    }
    i += 1
  }
  return i
}

/**
 * 前缀是否只由"**不可能失败**"的东西组成：`NAME=值` 赋值 + 空转命令（echo/printf/true/:/break/continue/return）。
 *
 * 2026-09-21（CodeQL #100 `js/redos`）：这里原来是一条大正则
 *   `/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)[ \t]+)*(?:echo|printf|true|:|break|continue|return)\b/u`
 * 值分支内部**重叠**（`""` 既能走 `"[^"]*"` 也能走 `\S*`），在外层 `(?:…)*` 重复下就是
 * 指数回溯（CodeQL 给的泵串正是 `A=` + 反复的 `""\tA=`）。改成**手写扫描**后是单次线性
 * 推进，没有可回退的重复构造；语义按 shell 的"值 = 若干相邻片段"实现：
 *   - 与旧正则一致：`A=`、`A=x`、`A="a b"`、`B='x'`、`A=x"y`、多 token（空白分隔）、
 *     结尾命令必须带 `\b`（`echox` 不算、`:` 只在后面跟词字符时算）；
 *   - 有意收紧（fail-closed，多报而不是漏报）：引号不闭合的怪写法（`A="a"b"`）不再算
 *     "无害前缀"；
 *   - 有意放宽（更符合 shell）：`A=a"b c"d` 这类**合法**的片段拼接算无害（它确实不可能失败）。
 *
 * @param prefix - 去引号/注释骨架里位于匹配位置之前的片段（调用方已 trim）。
 * @returns 前缀是"不可能失败"的赋值/空转命令序列时为 true。
 */
export function isHarmlessPrefix(prefix) {
  let i = 0
  for (;;) {
    const tokenStart = i
    // NAME = [A-Za-z_][A-Za-z0-9_]*
    if (i >= prefix.length || !/[A-Za-z_]/u.test(prefix[i])) { i = tokenStart; break }
    i += 1
    while (i < prefix.length && /[A-Za-z0-9_]/u.test(prefix[i])) i += 1
    if (prefix[i] !== '=') { i = tokenStart; break }
    i = skipAssignmentValue(prefix, i + 1)
    const valueEnd = i
    while (i < prefix.length && (prefix[i] === ' ' || prefix[i] === '\t')) i += 1
    // 值与下一个 token（或结尾命令）之间必须有空白，否则这个 token 不成立（旧正则的
    // `[ \t]+` 同理），回到它的起点交给结尾命令判定。
    if (i === valueEnd) { i = tokenStart; break }
  }
  for (const command of HARMLESS_COMMANDS) {
    if (!prefix.startsWith(command, i)) continue
    const next = prefix[i + command.length]
    const lastIsWord = isWordChar(command[command.length - 1])
    // `\b` 语义：命令末字符是词字符 ⇒ 后面必须是非词字符或串尾；`:` 不是词字符 ⇒
    // 后面必须是词字符（`:` 单独结尾不算边界）。
    return next === undefined ? lastIsWord : lastIsWord !== isWordChar(next)
  }
  return false
}

/**
 * 从 `bash -c '…'` / `sh -c "…"` / `eval "…"` 里取出**内层脚本**(2026-09-19 第三轮
 * 审计"仍为假护栏"的第 4 类:引号包裹吞码)。
 *
 * 返回三种状态:
 *   - `{kind:'none'}`:这一行没有 shell-to-shell 调用;
 *   - `{kind:'payload', payload, raw}`:取到了内层脚本文本(raw = 保留引号的原样文本,便于报错);
 *   - `{kind:'unreadable', reason}`:调用形态认识、但内层**无法安全解析**(变量代换、
 *     拼接的引号串、`$(…)` 之类)⇒ 调用方必须 fail-loud,不能静默放过
 *     —— 静态看不出内层,就不能假装它安全。
 *
 * @param line - 单行语句(已去注释)。
 * @returns 抽取结果。
 */
export function extractQuotedPayload(line, followingLines = '') {
  if (!QUOTED_SHELL_INVOCATION.test(line)) return { kind: 'none' }
  for (let index = 0; index < line.length; index += 1) {
    const rest = line.slice(index)
    const match = /^(?:([A-Za-z0-9_./-]*(?:bash|sh|zsh|dash|ksh))|\beval\b)/u.exec(rest)
    if (match === null) continue
    // 词首边界:前面不能是标识符字符(否则 `mybash` 也会命中)。
    if (index > 0 && /[A-Za-z0-9_.-]/u.test(line[index - 1])) continue
    const isEval = rest.startsWith('eval')
    const start = index + match[0].length
    // 跨行引号串:`-- bash -c '` 的引号在**后面的行**才闭合(YAML 块标量里很常见,
    // 本仓的渠道 DMG 步骤就是)。把后续行接上来,内层才可能被完整解析;接上仍然配不平
    // 才判"读不出"(此时由块级策略兜底)。
    const words = splitShellWords(line.slice(start)) ?? splitShellWords(line.slice(start) + '\n' + followingLines)
    if (words === null) return { kind: 'unreadable', reason: `无法解析 ${match[0]} 之后的参数(引号/转义不完整)` }
    if (isEval) {
      if (words.length === 0) return { kind: 'unreadable', reason: '`eval` 后面没有可判读的内容' }
      return payloadFromWords(words.slice(0, 1), 'eval')
    }
    // `bash -c <payload>` / `bash --noprofile --norc -c <payload>`:先跳过全部短选项,
    // 再要求第一个位置参数就是内层脚本(`--noprofile` 这类长选项直接跳过)。
    let cursor = 0
    while (cursor < words.length && /^-/u.test(words[cursor].text)) {
      const option = words[cursor].text
      cursor += 1
      if (option === '-c' || option === '--command') return payloadFromWords(words.slice(cursor), `${match[0]} -c`)
    }
    return { kind: 'none' }
  }
  return { kind: 'none' }
}

/**
 * 把 `eval` / `-c` 之后的词归一成内层脚本文本(见 extractQuotedPayload)。
 * @param words - 参数字词。
 * @param label - 报错用的调用形态。
 * @returns payload / unreadable / none。
 */
function payloadFromWords(words, label) {
  if (words.length === 0) return { kind: 'unreadable', reason: `${label} 后面没有内层脚本` }
  const [head, ...tail] = words
  if (head.unquoted) {
    // 未加引号的内层脚本(如 `bash -c npm\ test`):只有它自己一个词才可能安全。
    if (tail.length > 0) {
      return { kind: 'unreadable', reason: `${label} 的内层脚本未加引号且有多个词(静态无法确定边界)` }
    }
    return { kind: 'payload', payload: head.text, raw: head.text }
  }
  // 引号串与紧随其后的**未加引号**词会拼接(`bash -c "foo"bar`)—— 静态不猜。
  if (tail.some(word => word.unquoted && word.text !== '')) {
    return { kind: 'unreadable', reason: `${label} 的内层脚本由引号串与裸词拼接而成(静态无法安全还原)` }
  }
  const payload = [head, ...tail].map(word => word.text).join('')
  if (payload.trim() === '') return { kind: 'unreadable', reason: `${label} 的内层脚本是空串` }
  // 未展开的变量 / 命令替换 / 反引号:内层到底跑什么静态看不出来 —— 不能假装它安全。
  // 单引号串里的 `$` 是字面量(`'echo $HOME'` 交给内层时才展开),所以只对**双引号/裸词**
  // 报"读不出";单引号串里出现 `$(...)` 同样按读不出处理(它可能被外层先展开)。
  const expands = /\$\{|\$[A-Za-z_(]|`/u.test(payload)
  if (expands) {
    return {
      kind: 'unreadable',
      reason: `${label} 的内层脚本含未展开的变量/命令替换(${payload.trim().slice(0, 60)}),`
        + '静态无法确定它实际执行什么',
    }
  }
  return { kind: 'payload', payload, raw: head.raw }
}

/**
 * 把一行 shell 按引号切分成词(保留每个词"是否被引号包裹"的事实)。
 * @param line - 语句片段。
 * @returns 词列表;引号/转义不完整时返回 null(调用方按"无法解析"处理)。
 */
function splitShellWords(line) {
  const words = []
  let buffer = ''
  let raw = ''
  let started = false
  let quoted = false
  let quote = null
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (quote !== null) {
      if (char === '\\' && quote === '"' && index + 1 < line.length) {
        buffer += line[index + 1]
        raw += char + line[index + 1]
        index += 1
        continue
      }
      raw += char
      if (char === quote) {
        quote = null
        continue
      }
      buffer += char
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      quoted = true
      started = true
      raw += char
      continue
    }
    if (/\s/u.test(char)) {
      if (started) {
        words.push({ text: buffer, raw, unquoted: !quoted })
        buffer = ''
        raw = ''
        started = false
        quoted = false
      }
      continue
    }
    buffer += char
    raw += char
    started = true
  }
  if (quote !== null) return null
  if (started) words.push({ text: buffer, raw, unquoted: !quoted })
  return words
}

/**
 * 一个 run 块是否显式建立了"任意命令失败即失败"的语义。
 *
 * 为什么可以接受两种写法(2026-09-19 第三轮审计 F2-3):`set -euo pipefail` 与
 * `set -eo pipefail` 都显式钉住了 errexit + pipefail;`-u`(nounset)不是本策略的
 * 目的,而且它在"引用可能未定义的变量"时会**误杀合法步骤** —— 策略要的是"自己的
 * 退出语义自己声明",不是把脚本写得更严格。反过来说:块里如果出现 `set +e` /
 * `set +o pipefail`,等于把语义又关掉,判失败。
 *
 * 只看**外层脚本**:交给 `bash -c '…'` 的内层脚本文本不算数(那句 `set -euo pipefail`
 * 约束的是内层,外层块的中间失败照样不会让 step 红)。
 *
 * @param content - 块脚本内容。
 * @returns 建立了 errexit + pipefail 为 true。
 */
export function hasErrexitGuard(content) {
  const text = logicalShellLines(stripQuotedPayloads(content)).text.join('\n')
  const disablesErrexit = /(^|\n)\s*set\s+\+[a-zA-Z]*e/u.test(text)
  const disablesPipefail = /(^|\n)\s*set\s+\+o\s+pipefail\b/u.test(text)
  if (disablesErrexit || disablesPipefail) return false
  // ⚠️ 只看**顶层**语句:同样的 `set -euo pipefail` 写在 `if … then` 分支里,约束的是
  // 那个分支,外层脚本仍是无 errexit 的(`server` 的部署资产检查块历史上就带着这样一份
  // "藏在分支里的" guard —— 宽松匹配会把它误判成"已声明",从而既不报缺口、又让白名单
  // 条目变成死条目)。判据:guard 必须出现在**第一条非注释/非空/非 guard 的语句之前**。
  const isGuard = line => /^\s*set\s+(?:-[a-zA-Z]*e[a-zA-Z]*\b|-[a-zA-Z]*o\s+(?:errexit|pipefail)\b|-o\s+(?:errexit|pipefail)\b)/u.test(line)
  let seesErrexit = false
  let seesPipefail = false
  for (const line of text.split('\n')) {
    const stripped = stripLineComment(line)
    if (stripped.trim() === '') continue
    if (isGuard(stripped)) {
      if (/set\s+(?:-[a-zA-Z]*e[a-zA-Z]*\b|-[a-zA-Z]*o\s+errexit\b|-o\s+errexit\b)/u.test(stripped)) seesErrexit = true
      if (/set\s+(?:-[a-zA-Z]*o\s+pipefail\b|-o\s+pipefail\b)/u.test(stripped)) seesPipefail = true
      continue
    }
    // 第一条真正的命令:此后再出现 guard 也不算"在块首声明退出语义"。
    break
  }
  return seesErrexit && seesPipefail
}

/**
 * 把 `bash -c '…'` / `eval "…"` 的**内层脚本文本**从块内容里抹掉(留外形)。
 *
 * 用途只有一个:判断"外层脚本有没有自己声明 errexit"时,不能被内层那句
 * `set -euo pipefail` 骗过去(`desktop-macos` 的渠道 DMG 步骤正是这个形状)。
 *
 * @param content - 块脚本内容。
 * @returns 抹掉引号内层脚本后的脚本文本。
 */
function stripQuotedPayloads(content) {
  return content
    .split('\n')
    .map(line => {
      const wrapped = extractQuotedPayload(stripLineComment(line))
      if (wrapped.kind !== 'payload') return line
      return line.replace(wrapped.raw, "''")
    })
    .join('\n')
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
      // 块级 errexit 白名单同表登记:两边的死条目对账共用一套机制(2026-09-19 F2-3)。
      ?? BLOCK_ERREXIT_ALLOWLIST.find(item => item.file === file && item.key === signature)
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
 * `|| exit 0` / `|| echo` / `continue-on-error: true`(step 级与 **job 级**)。
 *
 * 判定在**语句级**(逐行 + 去引号/注释 + 逐行注释剥离 + 白名单逐条登记):语句里任何
 * 位置出现吞码形态都算 —— `cmd || true; next`、`x="$(cmd || true)"` 这种"半吞"同样会
 * 让那句话的失败消失。
 *
 * 2026-09-19 第三轮审计的两条扩展:
 *   - **F2-3**:块标量里的 `|| exit 0` / `|| echo` 此前完全无人守(7a 只认 true/:,
 *     7c 只审单行)。现在两句形态都进 SWALLOW_PATTERNS,`|| exit 1` 等安全形态放行。
 *   - **F2-4**:job 级 `continue-on-error: true` 此前无人看(策略只读 step 级字段),
 *     而它让**整个 job 的所有测试失败**都不再让流水线红 —— 正是 7a 想拦的静默变绿。
 *     与 step 级同口径:白名单逐条登记 + 写明理由,不允许整文件/整 job 豁免。
 *
 * @returns 失败项列表。
 */
function checkSwallowedExitCodes(file, document, blocks, allowlist, reported) {
  const failures = []
  const jobs = typeof document?.jobs === 'object' && document.jobs !== null ? document.jobs : {}
  // (a0) YAML 级:**job** 上的 continue-on-error(F2-4)。
  for (const [jobId, job] of Object.entries(jobs)) {
    const continueOnError = job?.['continue-on-error']
    if (continueOnError === undefined || isContinueOnErrorDisabled(continueOnError)) continue
    const key = `continue-on-error:job:${jobId}`
    if (allowlist.lookup(file, key) !== undefined) continue
    failures.push({
      name: file,
      line: 0,
      detail: `[SK-7a] job ${jobId} 打开了 continue-on-error(${JSON.stringify(continueOnError)})`
        + ' ⇒ 这个 job 里**所有** step 的失败都不再让流水线红(测试/校验被整段静默跳过)。'
        + '删掉它;确需(例如矩阵里的实验平台)请在本脚本 SWALLOW_ALLOWLIST 里逐条登记 + 写明理由'
        + '(表达式形态静态求不出真假,同样按"会静默"处理)。',
    })
  }
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
    // 行尾注释先去干净(F3-2 的同族:注释里的 `|| true` 说明文字不该报错 ——
    // shellSkeleton 只屏蔽"整行注释")。
    const lines = item.step.run.split('\n').map(stripLineComment)
    for (const [index, line] of lines.entries()) {
      const skeleton = shellSkeleton(line)
      if (skeleton.trim() === '') continue
      const hit = SWALLOW_PATTERNS.find(pattern => pattern.re.test(skeleton))
      if (hit === undefined) continue
      // `cmd || exit 1` / `cmd || { echo …; exit 1; }` 放行;`echo x; exit 0` 这类
      // "左侧不可能失败"的语句也放行(见 isSilentSuccessTail)。
      if (!isSilentSuccessTail(skeleton)) continue
      const signature = normalizeStatement(line)
      if (allowlist.lookup(file, signature) !== undefined) continue
      reported.add(statementKey(item, signature))
      failures.push({
        name: file,
        line: item.block?.line === undefined ? 0 : item.block.line + index,
        detail: `[SK-7a] ${stepLabel(item)} 吞掉了退出码(${hit.form}):${signature}\n`
          + '  ⇒ 这一步永远退出 0,命令的失败会静默变绿(2026-09-19 第二轮审计 R2-SK-7 实测:'
          + '`|| true` 变异无任何静态守卫;第三轮 F2-3 补的 `|| exit 0` / `|| echo` 同族)。\n'
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
    // 逐**逻辑行**扫(合并 `\` 续行 + 剥离行尾注释,见 logicalShellLines):
    // 此前逐物理行扫,`go test … \` 换行写 `-timeout 120m` 就完全看不见(F3-1)。
    const { text, lines } = logicalShellLines(item.step.run)
    const blockLine = item.block?.line ?? 0
    const where = line => (blockLine === 0 ? 0 : blockLine + line - 1)
    for (let index = 0; index < text.length; index += 1) {
      const line = text[index]
      // 注释已被剥离 ⇒ 注释里的历史命令不再误报(F3-2)。
      for (const command of line.match(GO_TEST_COMMAND) ?? []) {
        const report = detail => failures.push({
          name: file,
          line: where(lines[index]),
          detail: `[SK-7b] ${stepLabel(item)} 的 go test 单包预算:${detail}`,
        })
        // 取该命令上的**全部** `-timeout` flag:Go 的 flag 是后者覆盖前者,两个不同
        // 取值意味着"写下的那个不是生效的那个",不能只看第一个(F3-1 的 $EXTRA_FLAGS 同族)。
        GO_TEST_TIMEOUT_FLAG.lastIndex = 0
        const flags = []
        for (let m = GO_TEST_TIMEOUT_FLAG.exec(command); m !== null; m = GO_TEST_TIMEOUT_FLAG.exec(command)) {
          flags.push(m[1] ?? '')
        }
        if (flags.length === 0) {
          report(`这条命令没有 \`-timeout\`(写出来的超时值可能来自未展开的变量)\n`
            + `  命令:${command}\n`
            + '  ⇒ 单包预算缺失时,挂起的包会一路烧到 job 上限被整体取消,`panic: test timed out` + '
            + 'goroutine dump + 用例名全部丢失(2026-09-19 R2-SK-7)。请直接写 `-timeout <数字><s|m|h>`。')
          continue
        }
        // 值不可判读(变量 / 表达式 / 无单位 / 空)⇒ **fail-loud**。
        //
        // 此前这里是 `continue`(静默跳过),唯一兜底是 main() 的全仓计数器 —— 只要仓里
        // 还有任何一处合法的 `-timeout`,下面这些形态就全部静默通过(F3-1)。
        GO_DURATION.lastIndex = 0
        const bad = flags.find(value => !GO_DURATION.test(value))
        if (bad !== undefined) {
          report(`\`-timeout ${bad}\` 的值读不出"数字 + 单位"\n`
            + `  命令:${command}\n`
            + '  ⇒ Go 的 `-timeout` 只认 time.ParseDuration 形态(`30s`/`15m`/`2h`),'
            + '**裸数字不是合法 duration**;变量或 `${{ }}` 表达式则让静态门禁无法证明预算。\n'
            + '  请就地写死一个字面量(例:`-timeout 15m`)—— 门禁宁可报"读不出",也不假装它安全。')
          continue
        }
        // 环境变量注入的第二条 `-timeout`(F3-1 的 `$EXTRA_FLAGS` 形态):
        // `env: EXTRA_FLAGS: -timeout=120m` + `go test … -timeout 15m $EXTRA_FLAGS` 时,
        // Go 的 flag 解析是后者覆盖前者 ⇒ 实际生效 120m,而字面值看起来是 15m。
        // 只对**本命令引用到的**变量报(裸变量的 `-timeout` 在别的变量里无关紧要)。
        const injected = []
        for (const [name, value] of Object.entries({ ...(item.job?.env ?? {}), ...(item.step.env ?? {}) })) {
          if (typeof value !== 'string' || !value.includes('-timeout')) continue
          if (!new RegExp(`\\$\\{?${name}\\b`, 'u').test(command)) continue
          injected.push(`${name}=${value.trim()}`)
        }
        if (injected.length > 0) {
          report(`命令引用的环境变量里还带着另一个 \`-timeout\`(${injected.join(', ')})\n`
            + `  命令:${command}\n`
            + '  ⇒ Go 的 flag 解析是**后者覆盖前者**,实际生效的超时是环境变量里那个,不是字面上写的。\n'
            + '  把超时统一写在命令里,或删掉 env 里的 -timeout。')
          continue
        }
        const durations = new Set(flags)
        if (durations.size > 1) {
          report(`同一条命令里出现 ${flags.length} 个不同的 \`-timeout\`(${flags.map(v => `\`${v}\``).join(', ')})\n`
            + `  命令:${command}\n`
            + '  ⇒ Go 的 flag 解析是**后者覆盖前者**,生效的超时不是写在明面上的那个'
            + '(审计实测:`-timeout 15m $EXTRA_FLAGS` 而 `EXTRA_FLAGS=-timeout=120m` 时实际生效 120m)。\n'
            + '  只留一个,或用显式变量并在本文件登记理由。')
          continue
        }
        const value = flags[0]
        const match = GO_DURATION.exec(value)
        hits += 1
        const minutes = timeoutMinutes(match[1], match[2])
        const worst = 2 * minutes + 5
        const budget = numericMinutes(item.job?.['timeout-minutes'])
        const flagText = `-timeout ${value}`
        if (budget === undefined) {
          report(`${flagText} 所在 job 没有声明 timeout-minutes\n`
            + `  ⇒ 无法证明"挂起的包会被自己的 -timeout 打断并打出 goroutine dump"。\n`
            + `  给 job 加显式预算:2×${formatMinutes(minutes)}+5=${formatMinutes(worst)} ≤ timeout-minutes。`)
          continue
        }
        // 下界(2026-09-19 第三轮审计 F2-2):`-timeout 0` 在 Go 里是**关闭超时**
        // (`time.ParseDuration("0")` 合法、`0` 与 `0s` 都等于"没有超时"),一个 token
        // 就把本策略唯一的目的废掉;负值在 shell/Go 两侧同样是"读作别的意思"的噪音。
        // 因此除了上界,还必须校验一个**正的下界**:小于 floor 的取值不可能是有意义的
        // 单包预算(本仓最慢包数百秒),报出来就是让人改。
        if (minutes < GO_TEST_TIMEOUT_FLOOR_MINUTES) {
          const isZero = minutes === 0
          report(`${flagText} 小于下界 ${GO_TEST_TIMEOUT_FLOOR_MINUTES}m`
            + (isZero ? '(Go 语义:**`-timeout 0` = 关闭超时**,不是"预算很小")' : '')
            + `\n  ⇒ ${isZero
              ? '这一条把单包超时彻底关掉:用例真挂时不会有 `panic: test timed out`,也没有 '
                + 'goroutine dump,只剩 job 被整体取消 —— 正是本策略要防的"gate 红查不出原因"。'
              : '低于一分钟的全局测试超时会让正常慢的包被误杀,而不是拦住真挂的包。'}\n`
            + `  本仓最慢单包 250–300s 量级,合法区间是 ${GO_TEST_TIMEOUT_FLOOR_MINUTES}m ≤ X ≤ `
            + `${formatMinutes((budget - 5) / 2)}m(本 job)。`)
          continue
        }
        if (worst <= budget) {
          notes.push(`${file} job ${item.jobId}: -timeout ${value}`
            + ` ⇒ 2×${formatMinutes(minutes)}+5=${formatMinutes(worst)} ≤ job ${formatMinutes(budget)} ✓`
            + `(下界 ${GO_TEST_TIMEOUT_FLOOR_MINUTES}m ≤ ${formatMinutes(minutes)}m)`)
          continue
        }
        report(`${flagText} 与 job 预算的序关系不成立:`
          + `2×${formatMinutes(minutes)}+5=${formatMinutes(worst)} > ${formatMinutes(budget)}(job 预算)。\n`
          + '  ⇒ 挂起的那个包会先撞 job 上限被整体取消,`panic: test timed out` + goroutine dump + '
          + '用例名全部丢失,只剩"gate 红查不出原因"(2026-09-19 R2-SK-7 的现场:25m + 其余 '
          + '~21m 必然先撞 30min 的 job)。\n'
          + `  把 -timeout 收到 ≤ ${formatMinutes((budget - 5) / 2)}m,或把 job 预算抬到 ≥ `
          + `${formatMinutes(worst)}min。`)
      }
    }
  }
  return { failures, hits }
}

/**
 * [SK-7c] 单行 `- run:` 与**块标量逐行**的退出码语义,含引号包裹的内层命令。
 *
 * 单行 `run:`(compact `- run: <cmd>` 与缩进 8 的 `run: <cmd>`)的行退出码 = 最后一个
 * 命令的退出码。三种写法会让失败溜走:
 *   - `cmd1 | tail -5`:管道退出码只反映最后一段;
 *   - `cmd || echo ok` / `cmd; true` / `cmd || exit 0`:末尾命令恒成功;
 *   - `! cmd`:`!` 反转退出码,cmd 失败时整行反而成功。
 *
 * 结构性放行(不需要白名单,也不该被当成豁免):同一行里出现 `pipefail`、末尾是
 * `|| exit 1` / `|| { …; exit 1; }`、以及 `A && B`(`&&` 短路后行退出码取 A 的失败 ——
 * `&&` 本身不会吞失败)。
 *
 * 2026-09-19 第三轮审计的两条扩展:
 *   - **F2-3**:块标量不再整体 `continue`。此前注释写着"块标量由 `set -euo pipefail`
 *     约定覆盖",而本仓 23 个块标量里只有 3 个带它 ⇒ 20 个块的 `! cmd` / 无 pipefail
 *     管道 / 末尾吞码三种形态零守卫。现在逐行审(块级 errexit 由策略 4 单独要求)。
 *   - **引号包裹(新点名)**:`bash -c '… || true'` / `eval "… | tail"` 把内层命令
 *     交给另一个 shell,`shellSkeleton` 会把引号内整体屏蔽 ⇒ 内层必须**取出来递归判**;
 *     取不出来(变量代换/拼接引号串)则 fail-loud,要求人工确认,不静默放过。
 *
 * @returns 失败项列表。
 */
function checkInlineRunExitStatus(file, document, blocks, allowlist, reported) {
  const failures = []
  for (const item of shellSteps(document, blocks)) {
    if (NON_POSIX_SHELLS.test(item.shell)) continue
    // 块级白名单(BLOCK_ERREXIT_ALLOWLIST)是"这个块不适用 errexit 约定",那它的逐行
    // 形态也不再逐条重报 —— 否则白名单放行了块级策略、却挡不住 7c 的逐行噪音,
    // 登记一条等于没登记(`server` job 的 PG18 挂载点检查正是这种块)。
    //
    // ⚠️ `hasErrexitGuard` 必须**先**判:补上 guard 的块已经不需要这条豁免了,
    // 若仍然 lookup 就会把"不需要的豁免"登记成命中 ⇒ main() 的死条目对账永远不报
    // (豁免只能加不能删)。这是本轮自检第二次抓到的同一类顺序错误(另一处在
    // checkBlockScalarErrorHandling)。
    if (
      item.step.run.includes('\n')
      && !hasErrexitGuard(item.step.run)
      && allowlist.lookup(file, `block-errexit:${item.jobId}:${item.label}`) !== undefined
    ) continue
    const baseLine = item.block?.line ?? 0
    const rawLines = item.step.run.split('\n').map(stripLineComment)
    // 块首已经声明 `pipefail`(或块里任意处 set -o pipefail)时,块内的 `a | b` 不再报 ——
    // 策略 4 已经强制块自己声明退出语义,再按行报管道就是同一件事报两遍
    // (2026-09-19 第三轮审计把这种"收紧过度"列为下一轮的新缺陷来源)。
    const blockHasPipefail = rawLines.some(text => /(^|\s)(?:set\s+-\S*o\s+pipefail|set\s+-o\s+pipefail)\b/u.test(text))
    for (const [index, line] of rawLines.entries()) {
      const signature = normalizeStatement(line)
      if (signature === '') continue
      const skeleton = shellSkeleton(line)
      const lineNumber = baseLine === 0 ? 0 : baseLine + index
      const report = problem => {
        if (allowlist.lookup(file, signature) !== undefined) return
        reported.add(statementKey(item, signature))
        failures.push({
          name: file,
          line: lineNumber,
          detail: `[SK-7c] ${stepLabel(item)} ${problem}\n  语句:${signature}`,
        })
      }
      // 引号包裹的内层命令:先递归判内层(与 7a/7c 同一套规则),再判本行外层。
      if (!reported.has(statementKey(item, signature))) {
        const wrapped = extractQuotedPayload(line, rawLines.slice(index).join('\n'))
        if (wrapped.kind === 'unreadable') {
          // 跨行引号串的内层在**块级**判据里(head 行取不到内层文本,例如
          // `-- bash -c '` 后面才换行);块级 errexit 策略已经单独盯着这个块,
          // 而且块有白名单出口 ⇒ 这里不重复报,免得同一件事报两遍。
          if (hasUnbalancedQuote(line)) continue
          report('把命令交给了另一个 shell(`bash -c` / `eval`),但内层无法静态解析:'
            + `${wrapped.reason}\n`
            + '  ⇒ 内层可能含吞码/管道/取反,静态门禁看不见它。请把内层写成**单个静态字符串**'
            + '(例:`bash -c \'set -euo pipefail; go vet ./...\'`),或把命令直接写在 run 块里。')
        } else if (wrapped.kind === 'payload') {
          failures.push(...checkWrappedPayload(file, item, index, lineNumber, wrapped, allowlist, reported))
        }
      }
      if (reported.has(statementKey(item, signature))) continue
      // `!` 取反:排除两种**结构性**豁免(见 NEGATION_IN_CONDITION / SHELL_NEGATION 注释)。
      // `[[ ! -f x ]]` 是模式取反,由 SHELL_NEGATION 的"`!` 后面必须跟词"天然放过
      // (`! -f` 里 `-f` 也算词,所以这里另外排掉 `[[`/`[ … ]` 的条件上下文)。
      if (SHELL_NEGATION.test(skeleton) && !NEGATION_IN_CONDITION.test(skeleton) && !/\[\[|\[\s/u.test(skeleton)) {
        report('用 `!` 取反了退出码 ⇒ 被检查命令失败时整行反而成功。'
          + '要"应当失败"的检查 fail-loud,请写成 `if ! cmd; then echo ::error::…; exit 1; fi`。')
        continue
      }
      // 管道:排除 `if ! a | b; then`(取反结果交给分支显式处理)与带 `pipefail` 的行。
      if (
        SHELL_PIPELINE.test(skeleton)
        && !blockHasPipefail
        && !/\bpipefail\b/u.test(skeleton)
        && !NEGATION_IN_CONDITION.test(skeleton)
      ) {
        report('把命令接进了管道,而管道退出码只反映最后一段(`| tail -5` 会把失败吃掉)⇒ '
          + '加 `set -o pipefail`(块标量里写在块首),或改用显式检查。')
        continue
      }
      if (INLINE_SWALLOW_TAIL.test(skeleton) && isSilentSuccessTail(skeleton)) {
        report('末尾命令恒成功(`|| echo` / `; true` / `|| exit 0`)⇒ 失败被吞。'
          + '让最后一条命令保留原退出码,或显式 `|| { echo ::error::…; exit 1; }`。')
      }
    }
  }
  return failures
}

/**
 * 递归检查引号包裹的内层命令(`bash -c '…'` / `eval "…"`)。
 *
 * 内层脚本按**与外层同一套规则**判:取反 / 管道缺 pipefail / 末尾吞码 / `|| true` 家族。
 * 内层自带 `set -e`/`pipefail` 时,内层的 `cmd || true` 依旧是吞码(显式写的,白名单要
 * 单独登记),但内层的管道不再报 —— 它已经声明了 pipefail。
 *
 * @returns 失败项列表。
 */
function checkWrappedPayload(file, item, index, lineNumber, wrapped, allowlist, reported) {
  const failures = []
  const payload = wrapped.payload
  const inner = logicalShellLines(payload)
  const innerHasPipefail = inner.text.some(text => /\b(?:set\s+-\S*o\s+pipefail|set\s+-o\s+pipefail|pipefail)\b/u.test(text))
  for (const [innerIndex, text] of inner.text.entries()) {
    const skeleton = shellSkeleton(text)
    if (skeleton.trim() === '') continue
    const innerSignature = normalizeStatement(text)
    const report = problem => {
      if (allowlist.lookup(file, innerSignature) !== undefined) return
      failures.push({
        name: file,
        line: lineNumber,
        detail: `[SK-7c] ${stepLabel(item)} 的引号内层命令有问题(内层第 ${innerIndex + 1} 句):${problem}\n`
          + `  内层语句:${innerSignature}\n`
          + `  外层语句:${normalizeStatement(item.step.run.split('\n')[index] ?? '')}\n`
          + '  ⇒ `bash -c`/`eval` 把这句话交给另一个 shell 执行,静态检查必须往下递归一层;\n'
          + '     内层与 run 块同一口径:`|| true`/`|| echo`/`|| exit 0` 吞码、`! cmd` 取反、'
          + '无 pipefail 的管道都算。',
      })
    }
    const swallowed = SWALLOW_PATTERNS.find(pattern => pattern.re.test(skeleton))
    if (swallowed !== undefined && isSilentSuccessTail(skeleton)) {
      report(`吞掉了退出码(${swallowed.form})`)
      continue
    }
    if (SHELL_NEGATION.test(skeleton)) {
      report('用 `!` 取反了退出码 ⇒ 被检查命令失败时整层反而成功')
      continue
    }
    if (SHELL_PIPELINE.test(skeleton) && !innerHasPipefail && !/\bpipefail\b/u.test(skeleton)) {
      report('把命令接进了管道,而管道退出码只反映最后一段(`| tail -5` 会把失败吃掉)')
      continue
    }
    if (INLINE_SWALLOW_TAIL.test(skeleton) && isSilentSuccessTail(skeleton)) {
      report('末尾命令恒成功(`|| echo` / `; true` / `|| exit 0`)⇒ 失败被吞')
    }
  }
  if (failures.length === 0) {
    reported.add(statementKey(item, normalizeStatement(item.step.run.split('\n')[index] ?? '')))
  }
  return failures
}

/**
 * [SK-7(BLOCK)] 块标量必须**自己声明退出语义**(2026-09-19 第三轮审计 F2-3)。
 *
 * 背景:SK-7c 的旧注释声称"块标量由 `set -euo pipefail` 约定覆盖",但那是**未兑现的
 * 约定** —— 本仓 23 个 `run: |` 只有 3 个带它。而没有 errexit 的块里,`svc start` 这种
 * "中间某行失败"的形态不会让 step 红(只有最后一条命令的退出码算数);GitHub 的默认
 * shell 形态(`bash -e` 家族)也不覆盖 `! cmd` 与 `cmd || echo`。
 *
 * 处置(二选一里选"把约定变成强制"):每个块标量**必须**在块首显式建立 errexit +
 * pipefail,否则 fail-loud 点名"哪个文件、哪个 step、第几行、缺哪一半"。
 *   - 为什么选强制而不是"逐行模拟 errexit":静态模拟 `set -e` 的豁免规则(条件上下文、
 *     `!`、`&&`/`||` 链)必然做不准,做不准的守卫就是下一个假护栏;
 *   - 白名单是**块级**且必须写明理由(BLOCK_ERREXIT_ALLOWLIST),条目会被死条目对账
 *     盯着(不再命中真实块 ⇒ 报错)。
 *
 * @returns 失败项列表。
 */
function checkBlockScalarErrorHandling(file, document, blocks, allowlist, reported) {
  const failures = []
  for (const item of shellSteps(document, blocks)) {
    if (NON_POSIX_SHELLS.test(item.shell)) continue
    if (!item.step.run.includes('\n')) continue
    // ⚠️ 顺序是关键:`hasErrexitGuard` 必须在 `allowlist.lookup` **之前**。
    // lookup 会登记命中,而"命中"正是死条目对账的判据 —— 如果先 lookup 再判 guard,
    // 那么一个**已经补上 guard 的块**仍会被登记成命中,死条目对账就永远不会报
    // "这条豁免已经不需要了"(2026-09-19 本轮自检抓到:guard 版夹具仍然命中)。
    // 顺序颠倒 = 豁免只能加不能删,白名单必然腐化。
    if (hasErrexitGuard(item.step.run)) continue
    const key = `block-errexit:${item.jobId}:${item.label}`
    if (allowlist.lookup(file, key) !== undefined) continue
    const snippet = item.step.run
      .split('\n')
      .map(line => stripLineComment(line))
      .find(line => line.trim() !== '') ?? ''
    failures.push({
      name: file,
      line: item.block?.line ?? 0,
      detail: `[SK-7] ${stepLabel(item)} 是块标量(run: |),但没有在块首声明退出语义`
        + `(缺 ${hasErrexitOnly(item.step.run) ? '`set -o pipefail`' : '`set -e` + `set -o pipefail`'})\n`
        + `  块首第一句:${normalizeStatement(snippet)}\n`
        + '  ⇒ 没有 errexit 时块中间某条命令失败**不会**让 step 红(只有最后一条命令的退出码算数);'
        + '没有 pipefail 时 `a | b` 只反映 b 的退出码。\n'
        + '  两种修法:①在块首加 `set -euo pipefail`(推荐);'
        + '②确有不适用(例如要"跑完所有检查再汇总退出码")的块,到本脚本 BLOCK_ERREXIT_ALLOWLIST '
        + '登记这一条 + 写明理由。\n'
        + '  注意 `-u` 不是本策略要求(nounset 会误杀引用可选变量的步骤),'
        + '`set -eo pipefail` 同样满足。',
    })
  }
  return failures
}

/** 块里是否只缺 pipefail(用于把报错说准)。 */
function hasErrexitOnly(content) {
  const text = logicalShellLines(content).text.join('\n')
  return /(^|\n)\s*set\s+(?:-[a-zA-Z]*e[a-zA-Z]*|-[a-zA-Z]*o\s+errexit)\b/u.test(text)
    || /(^|\n)\s*set\s+-o\s+errexit\b/u.test(text)
}

/**
 * 自检用的合成 workflow 生成器(策略自检与覆盖对账共用一份夹具形状)。
 *
 * `timeoutMinutes: null` = 不写 job 预算;`jobContinueOnError` = job 级 COE。
 * @param steps - `steps:` 下的原始行(含缩进)。
 * @param options - 见上。
 * @returns workflow 文本。
 */
function selftestWorkflow(steps, { timeoutMinutes = 45, jobContinueOnError = false, jobIf = '', jobNeeds = '' } = {}) {
  return [
    'name: selftest',
    'on: push',
    'jobs:',
    '  verify:',
    '    runs-on: ubuntu-latest',
    ...(timeoutMinutes === null ? [] : [`    timeout-minutes: ${timeoutMinutes}`]),
    ...(jobNeeds === '' ? [] : [`    needs: ${jobNeeds}`]),
    ...(jobIf === '' ? [] : [`    if: ${jobIf}`]),
    ...(jobContinueOnError ? ['    continue-on-error: true'] : []),
    '    steps:',
    ...steps,
    '',
  ].join('\n')
}

/**
 * [SK-8] / [SK-9] 的实现(判据见常量区的注释)。
 *
 * 为什么从 YAML 文档而不是 `blocks` 走:`if:` 是 job/step 级的字段,而 blocks 只带
 * `{shell, content, line}` —— 这两条判据必须看见"哪一步在什么条件下跑"。
 * run 内容仍先过 `stripLineComment`(注释里的历史命令不该触发判据)并去掉重定向
 * (否则 `yarn check 2>&1 | tee …` 会被当成"带了参数")。
 *
 * @param file - workflow 文件名。
 * @param document - parseYaml 的结果。
 * @param text - 原始文本(用于判定"这份 workflow 有没有 docs-only 机制")。
 * @param notes - 提示收集器。
 * @returns 失败项列表。
 */
function checkRootGateIntegrity(file, document, text, notes) {
  const failures = []
  const jobs = typeof document?.jobs === 'object' && document.jobs !== null ? document.jobs : {}
  const invocations = []
  for (const [jobId, job] of Object.entries(jobs)) {
    const steps = Array.isArray(job?.steps) ? job.steps : []
    steps.forEach((step, index) => {
      if (typeof step?.run !== 'string') return
      const script = step.run
        .split('\n')
        .map(line => stripLineComment(line))
        .join('\n')
        .replace(/\d?>>?\s*[^\s;&|]+/gu, ' ')
      for (const match of script.matchAll(ROOT_GATE_INVOCATION)) {
        const args = match[2].trim() === '' ? [] : match[2].trim().split(/\s+/u)
        invocations.push({
          jobId,
          stepIndex: index,
          stepName: typeof step.name === 'string' && step.name.trim() !== '' ? step.name : `第 ${index + 1} 步`,
          step,
          flag: match[1],
          args,
        })
      }
    })
  }

  for (const invocation of invocations) {
    const label = `job ${invocation.jobId} 的 step「${invocation.stepName}」`
    if (invocation.flag === 'check:fast') {
      failures.push({
        name: file,
        line: 0,
        detail: `[SK-8] ${label} 拿 \`yarn check:fast\` 当门禁 —— 它就是 \`--changed\` 的别名`
          + '(package.json: "check:fast": "node scripts/check-workspaces.mjs --changed"),'
          + '只跑改动映射到的包(映射表打错一个字就是 0 个包)。CI 里必须跑全量 `yarn check`。',
      })
      continue
    }
    const weakening = invocation.args.filter(arg => ROOT_GATE_WEAKENING_FLAGS.includes(arg))
    if (weakening.length > 0) {
      const consequence = weakening.includes('--no-guards')
        ? '`--no-guards` 会让**全部**根守卫不跑(域名 / 迁移区间 / 文档数字 / 布局 / 变异体 / workflow 纪律…)'
        : weakening.includes('--list') || weakening.includes('--help') || weakening.includes('-h')
          ? '这个参数让命令**根本不执行检查**(只打印计划/用法后 exit 0)'
          : '这个参数把检查面缩到"被改动映射到的包"或点名的一个包'
      failures.push({
        name: file,
        line: 0,
        detail: `[SK-8] ${label} 把根门禁换成了弱化形态:\`yarn check ${invocation.args.join(' ')}\``
          + `(弱化参数 ${weakening.join(', ')})\n  ⇒ ${consequence}。`
          + 'CI 里必须是不带参数的全量 `yarn check`(2026-09-23 审计 R3-C C-7:'
          + '`--no-guards` / `--only` / `--changed` 三种写法当时在静态策略下全部 EXIT=0)。',
      })
    }
  }

  // 没有 docs-only 机制 ⇒ 没有"整条门禁被跳过"的缺口,下面几条不适用。
  const fullGateInvocations = invocations.filter(invocation => invocation.flag === 'check' && invocation.args.length === 0)

  // [SK-8b]:跑全量门禁的 job 必须拿到完整历史(C-4 的另一半)。
  for (const invocation of fullGateInvocations) {
    const steps = Array.isArray(jobs[invocation.jobId]?.steps) ? jobs[invocation.jobId].steps : []
    const checkouts = steps
      .map((step, index) => ({ step, index }))
      .filter(entry => typeof entry.step?.uses === 'string' && entry.step.uses.startsWith('actions/checkout@'))
    const fullHistory = checkouts.find(entry => {
      const depth = entry.step?.with?.['fetch-depth']
      return depth === 0 || depth === '0'
    })
    if (fullHistory === undefined) {
      const seen = checkouts.map(entry => String(entry.step?.with?.['fetch-depth'] ?? '默认(1)')).join(', ')
      failures.push({
        name: file,
        line: 0,
        detail: `[SK-8b] job ${invocation.jobId} 跑全量门禁,但它的 actions/checkout 没有 \`fetch-depth: 0\``
          + `(检出的 ref ${checkouts.length === 0 ? '根本没有 checkout 步骤' : `fetch-depth = ${seen}`})`
          + '\n  ⇒ depth-1 检出解析不到提交信息区间的 base(PR 的检出 ref 是 refs/pull/N/merge,'
          + 'origin/<base> 往往不存在),`check-no-real-domains` 的提交信息判据退化成"只看 HEAD"'
          + ' —— 中间提交信息里的域名看不见(2026-09-23 审计 R3-C C-4 的现场:同一份历史,'
          + '完整克隆 EXIT=1、depth-1 克隆 EXIT=0 且照打"零命中 ✅")。',
      })
    } else if (fullHistory.index > invocation.stepIndex) {
      failures.push({
        name: file,
        line: 0,
        detail: `[SK-8b] job ${invocation.jobId} 的完整历史 checkout 排在门禁步之后(第 ${fullHistory.index + 1} 步 vs 第 ${invocation.stepIndex + 1} 步)`
          + ' ⇒ 门禁跑的时候历史还没拿到,等同于没有 fetch-depth: 0。',
      })
    }
  }

  if (!/needs\.changes\.outputs/u.test(text)) return failures

  const full = fullGateInvocations
  if (full.length !== 1) {
    failures.push({
      name: file,
      line: 0,
      detail: `[SK-9] 这份 workflow 用 docs-only 判定控制门禁(出现 \`needs.changes.outputs\`),`
        + `但**参数向量为空**的全量 \`yarn check\` 出现了 ${full.length} 次(要求恰好 1 次)`
        + '\n  ⇒ 全量门禁被删掉/改名/加了参数之后,CI 里就没有任何一步跑全量根守卫了'
        + '(2026-09-23 审计 R3-C C-3/C-7)。',
    })
    return failures
  }

  const gateStep = full[0]
  const gateJob = jobs[gateStep.jobId]
  const jobIf = gateJob?.if
  if (typeof jobIf === 'boolean' && jobIf === false) {
    failures.push({
      name: file,
      line: 0,
      detail: `[SK-9] 承载全量门禁的 job ${gateStep.jobId} 的 \`if: false\` ⇒ 这个 job 永远不跑。`,
    })
  } else if (typeof jobIf === 'string' && /needs\.changes\.outputs/u.test(jobIf)) {
    failures.push({
      name: file,
      line: 0,
      detail: `[SK-9] 承载全量门禁的 job ${gateStep.jobId} 的 \`if:\` 引用了 docs-only 判定(${jobIf.trim()})`
        + '\n  ⇒ "只改文档"的 PR 会把整条 gate 跳过,而分支保护把 skipped 的必需检查记成**成功**'
        + ' ⇒ 判据落在文档上的根守卫(铁律 0 的域名 / 迁移区间 / 文档数字 / 布局记录)一次都不跑'
        + '(2026-09-23 审计 R3-C C-3;线上 PR #129 的 Gate 就是 skipped 后合并的)。'
        + `\n  处置:这个 job 永不跳过,docs-only 时改跑 \`${DOCS_ONLY_GUARD_RUNNER}\`。`,
    })
  }

  // [SK-9②③] 永远运行的守卫 job + "守卫失败 ⇒ 门禁 job 红"的链路。
  // 识别方式:哪个 job 的 run 里出现 DOCS_ONLY_GUARD_RUNNER。它必须结构上无法跳过:
  // 有 `needs:` 时上游失败会被跳过,而 skipped 在分支保护里算成功 ⇒ 与 C-3 同形。
  const guardJobs = Object.entries(jobs)
    .filter(([, job]) => (Array.isArray(job?.steps) ? job.steps : [])
      .some(step => typeof step?.run === 'string' && step.run.includes(DOCS_ONLY_GUARD_RUNNER)))
  if (guardJobs.length !== 1) {
    failures.push({
      name: file,
      line: 0,
      detail: `[SK-9] 跑 \`${DOCS_ONLY_GUARD_RUNNER}\` 的 job 有 ${guardJobs.length} 个(要求恰好 1 个)`
        + '\n  ⇒ 0 个 = docs-only 的 PR 没有任何根守卫路径;多个 = 守卫会被并发跑两遍'
        + '(资源竞争会把其中一次的失败伪装成超时)。',
    })
  } else {
    const [guardJobId, guardJob] = guardJobs[0]
    const guardNeeds = guardJob?.needs
    const hasNeeds = Array.isArray(guardNeeds) ? guardNeeds.length > 0 : typeof guardNeeds === 'string' && guardNeeds.trim() !== ''
    if (guardJob?.if !== undefined && guardJob.if !== null) {
      failures.push({
        name: file,
        line: 0,
        detail: `[SK-9] 根守卫 job ${guardJobId} 带了 \`if:\`(${String(guardJob.if).trim()})`
          + '\n  ⇒ 条件在 PR 形态上可能为假,而被跳过的 job 在分支保护里算成功(MR/PR 上"零守卫通过")。'
          + '这个 job 必须没有任何 `if:`。',
      })
    }
    if (hasNeeds) {
      failures.push({
        name: file,
        line: 0,
        detail: `[SK-9] 根守卫 job ${guardJobId} 带了 \`needs:\`(${Array.isArray(guardNeeds) ? guardNeeds.join(', ') : String(guardNeeds)})`
          + '\n  ⇒ 上游 job 失败时本 job 会变成 **skipped**,而 skipped 在分支保护里算成功。'
          + '这个 job 必须没有任何 `needs:`(它不需要 changes 的输出)。',
      })
    }
    // ③ 必需的 Gate 检查必须反映守卫 job 的结果。
    const gateNeeds = Array.isArray(gateJob?.needs)
      ? gateJob.needs
      : (typeof gateJob?.needs === 'string' ? [gateJob.needs] : [])
    if (!gateNeeds.includes(guardJobId)) {
      failures.push({
        name: file,
        line: 0,
        detail: `[SK-9] 门禁 job ${gateStep.jobId} 的 \`needs:\` 里没有根守卫 job ${guardJobId}`
          + '\n  ⇒ 守卫失败时必需的 Gate 检查仍可能报绿(守卫 job 还没被加进分支保护之前,'
          + '这条 needs + 下一步的 exit 1 就是唯一链路)。',
      })
    } else {
      const gateStepsForLink = Array.isArray(gateJob?.steps) ? gateJob.steps : []
      const resultRef = new RegExp(`needs\\.${guardJobId}\\.result`, 'u')
      const links = gateStepsForLink.filter(step => typeof step?.run === 'string'
        && /exit\s+[1-9]/u.test(step.run)
        // 引用可以写在 run 里(`echo "…needs.x.result…"`)或写在 `if:` 上(更常见)。
        && (resultRef.test(step.run) || (typeof step?.if === 'string' && resultRef.test(step.if))))
      if (links.length === 0) {
        failures.push({
          name: file,
          line: 0,
          detail: `[SK-9] 门禁 job ${gateStep.jobId} 里没有"根守卫 job ${guardJobId} 未成功 ⇒ exit 1"的步骤`
            + `\n  ⇒ 判据:该 job 的某个 run 必须引用 \`needs.${guardJobId}.result\` 且含 \`exit 1\`。`
            + '少了它,守卫 job 红的时候必需的 Gate 检查照样绿(C-3 的同一形态)。',
        })
      }
    }
  }

  const gateStepIf = typeof gateStep.step?.if === 'string' ? gateStep.step.if : ''
  if (gateStepIf !== '' && /needs\.changes\.outputs\.code/u.test(gateStepIf) && !/!=/u.test(gateStepIf)) {
    failures.push({
      name: file,
      line: 0,
      detail: `[SK-9] 全量门禁那一步的 \`if:\` 是 \`${gateStepIf.trim()}\` —— 必须是 \`!= 'false'\` 形态`
        + '\n  ⇒ 写成 `== \'true\'` 时,changes job 失败/输出为空会让"完整"与"轻量"两条路径'
        + '**都不跑**(静默零门禁)。fail-safe 的写法是只有明确判定为 docs-only 才走轻量路径。',
    })
  }

  notes.push(`[SK-8/SK-9] 全量门禁 = job ${gateStep.jobId} 的 step「${gateStep.stepName}」;`
    + `根守卫 job = ${guardJobs.length === 1 ? guardJobs[0][0] : '未识别'}`)
  return failures
}

/**
 * [SK-10] docs-only 分类器的规则逐条钉死(C-CI-1)。
 *
 * 为什么必须钉死:分类器是"哪些改动可以只跑轻量路径"的唯一判据,而它此前
 * **零策略** —— 把 `case` 放宽成 `*) ;;`(全仓都算文档)、把输出硬编码成
 * `code=false`、把 fail-safe 的 `code=true` 分支删掉,`check-workflows.mjs`
 * 全部 EXIT=0(子泳道 C-CI-1 实测)。它同时是唯一会**静默**扩大"跳过面"的地方。
 *
 * @param file - workflow 文件名。
 * @param document - parseYaml 的结果。
 * @param text - 原始文本。
 * @param notes - 提示收集器。
 * @returns 失败项列表。
 */
function checkDocsOnlyClassifier(file, document, text, notes) {
  const failures = []
  const jobs = typeof document?.jobs === 'object' && document.jobs !== null ? document.jobs : {}
  let classifier = null
  for (const [jobId, job] of Object.entries(jobs)) {
    const steps = Array.isArray(job?.steps) ? job.steps : []
    for (const step of steps) {
      if (typeof step?.run === 'string' && step.run.includes('DOCS_ONLY=1')) classifier = { jobId, job, step }
    }
  }
  if (classifier === null) {
    // 没有分类器 = 没有 docs-only 机制,这条不适用(缺的其实是"跳过面",不是判据)。
    return failures
  }
  const script = classifier.step.run
    .split('\n')
    .map(line => stripLineComment(line))
    .join('\n')
  const caseBody = /case\s+"\$f"\s+in\n([\s\S]*?)\n\s*esac/u.exec(script)?.[1]
  if (caseBody === undefined) {
    failures.push({
      name: file,
      line: 0,
      detail: '[SK-10] 找不到 docs-only 分类器里 `case "$f" in … esac` 的分支表(判据无从对拍)',
    })
    return failures
  }
  const observed = []
  for (const line of caseBody.split('\n')) {
    const match = /^\s*([^)\s]+)\)\s*(.*)$/u.exec(line)
    if (match === null) continue
    const body = match[2]
    const kind = body.includes('DOCS_ONLY=0') || body.includes('break') ? 'code' : 'docs'
    // `a|b)` 是 bash 的合并写法 ⇒ 展开成两条登记项(顺序即判据)。
    for (const pattern of match[1].split('|')) observed.push([pattern.trim(), kind])
  }
  const expected = DOCS_ONLY_CLASSIFIER_CASES
  const same = observed.length === expected.length
    && observed.every((entry, index) => entry[0] === expected[index][0] && entry[1] === expected[index][1])
  if (!same) {
    failures.push({
      name: file,
      line: 0,
      detail: '[SK-10] docs-only 分类器的分支表与登记形态不一致(顺序也是判据):'
        + `\n  实际:${observed.map(([pattern, kind]) => `${pattern} → ${kind}`).join(' | ') || '(空)'}`
        + `\n  登记:${expected.map(([pattern, kind]) => `${pattern} → ${kind}`).join(' | ')}`
        + '\n  ⇒ **改宽**(把更多路径算成文档 = 跳过更多门禁)与**改窄**(把文档改动当代码 = '
        + '白跑三平台)都必须是一次显式决定:同步改 DOCS_ONLY_CLASSIFIER_CASES 并说明理由。'
        + '特别地 `*.md` 会跨 `/` 匹配,必须排在 `*/*`(按代码处理)之后。',
    })
  }
  const falseEcho = /echo\s+"code=false"/gu
  const trueEcho = /echo\s+"code=true"/gu
  const falseCount = (script.match(falseEcho) ?? []).length
  const falseIndex = script.search(falseEcho)
  // fail-safe 出口 = `code=false` **之前**的那些 `code=true`(tag / base 不可用 / 空 diff);
  // 判定之后那个 else 分支的 `code=true` 不算在内(否则删掉一条 fail-safe 也能凑够数)。
  const failSafeCount = falseIndex < 0
    ? (script.match(trueEcho) ?? []).length
    : (script.slice(0, falseIndex).match(trueEcho) ?? []).length
  if (falseCount !== 1) {
    failures.push({
      name: file,
      line: 0,
      detail: `[SK-10] docs-only 分类器里 \`echo "code=false"\` 出现 ${falseCount} 次(要求恰好 1 次)`
        + '\n  ⇒ 多出来的出口都是"绕过全部重活"的静默通道;唯一允许的出口是"逐文件判定完确实是文档"。',
    })
  }
  // "code=false 必须由 DOCS_ONLY 判定导出",不能是硬编码出口(子泳道实测:把 if/else
  // 换成一句 `echo "code=false"` ⇒ 全仓都算文档,而门禁 EXIT=0)。
  const docsOnlyGuard = /(?:\[\[|\[)\s*"?\$\{?DOCS_ONLY\}?"?\s*==?\s*"?1"?\s*(?:\]\]|\])/u
  const guardIndex = script.search(docsOnlyGuard)
  if (guardIndex < 0) {
    failures.push({
      name: file,
      line: 0,
      detail: '[SK-10] docs-only 分类器里找不到对 \`DOCS_ONLY\` 的判据'
        + '(要求形如 `if [[ "${DOCS_ONLY}" == "1" ]]; then … echo "code=false" …`)\n'
        + '  ⇒ `code=false` 必须由"逐文件判定"的结果导出;硬编码/无条件写出它 = 全仓都算文档,'
        + '所有重活被跳过而门禁全绿(C-CI-1 的实测变异)。',
    })
  } else if (falseIndex >= 0 && falseIndex < guardIndex) {
    failures.push({
      name: file,
      line: 0,
      detail: '[SK-10] docs-only 分类器在 \`DOCS_ONLY\` 判据**之前**就写了 `code=false`'
        + ' ⇒ 那条出口不受"逐文件判定"约束。',
    })
  }
  if (failSafeCount < 3) {
    failures.push({
      name: file,
      line: 0,
      detail: `[SK-10] docs-only 分类器的 fail-safe 出口只剩 ${failSafeCount} 个(要求 ≥ 3:tag / base 不可用 / 空 diff)`
        + '\n  ⇒ 少一个,"算不出改动/算不出 base"就会落进 `code=false`,与 2026-09-17 编排器 '
        + '`--changed` 的假绿同一形态(算不出来 ≠ 没有改动)。',
    })
  }
  if (typeof classifier.job?.if === 'string' || typeof classifier.job?.if === 'boolean') {
    failures.push({
      name: file,
      line: 0,
      detail: `[SK-10] 承载 docs-only 分类器的 job ${classifier.jobId} 带了 \`if:\`(${String(classifier.job.if).trim()})`
        + '\n  ⇒ 分类器必须永远运行(它同时是"必须跑重活"的 fail-safe 出口);被跳过时 '
        + '`needs.changes.outputs.code` 为空,下游按完整路径跑倒还安全,但"docs-only 的 PR"'
        + '会因此永远拿不到判定,而 PR 仍可能以 skipped 计入成功。',
    })
  }
  notes.push(`[SK-10] docs-only 分类器 = job ${classifier.jobId};登记形态 ${expected.length} 条`)
  return failures
}

/**
 * [SK-11] 发布面语义判据(C-CI-2 半发布窗口 + C-CI-3 子串假绿)。
 *
 * 逐条:
 *   ① 策展发布说明的 fail-loud 必须出现在**两个**位置:存在 `yarn check` 的门禁 job
 *      (早检,1 分钟内红)与 release job(内部含对外上传的那个 job);且后者必须排在
 *      该 job 内**任何**对外上传调用之前。
 *   ② `gh release create|edit` 的 argv 语义:必须 `--title` 且取值引用 tag 变量;
 *      必须给出说明来源。argv 在**去掉注释后的可执行文本**上解析(旧实现是整段 YAML
 *      子串匹配 ⇒ 把关键行注释掉仍 EXIT=0)。等价的写法(`--title "$TAG"`)必须放行。
 *
 * @param file - workflow 文件名。
 * @param document - parseYaml 的结果。
 * @param notes - 提示收集器。
 * @returns 失败项列表。
 */
/**
 * [SK-12] 的实现:WASM 门禁的两处接线(W-4 用例级 0 skip / W-5 协议探针)。
 *
 * 判据(每条都对应一种"接上了但等于没接"的形态):
 *   ① `check-go-test-json.mjs` 恰好被一步调用;那一步里 `go test … -json` 的**落盘路径**
 *      必须等于判定脚本读的那个路径(路径不一致 ⇒ checker 只会以 exit 2 收尾,而人容易
 *      把它当成"环境问题");`--require` 与 `--scope` 必须与登记值**集合相等**;
 *      该 step 不得 `continue-on-error`,且必须含 `exit 1`(判定结果要真的变成失败);
 *      所在 job(或该 step)必须提供 `PG_DSN_TEST` —— 没有真 PG 时 wasm 用例会 t.Skip,
 *      判定必然红,接进无 PG 的 job 等于接了个恒红判据(会被关掉)。
 *   ② `verify-wasm-client-only.sh --groups 6` 恰好被一步调用;该 step 的 env 必须
 *      `WASM_GATE_REQUIRE_COVERED_PLATFORM=1`(否则非 Linux 平台会"跑完给结论");
 *      不得 `continue-on-error`;`if:`(若有)不得把它收窄成"几乎不跑"的条件。
 *
 * @param file - workflow 文件名。
 * @param document - parseYaml 的结果。
 * @param notes - 提示收集器。
 * @returns 失败项列表。
 */
function checkWasmGateWiring(file, document, notes) {
  const failures = []
  const jobs = typeof document?.jobs === 'object' && document.jobs !== null ? document.jobs : {}
  const stepsOf = job => (Array.isArray(job?.steps) ? job.steps : [])
  const scriptOf = step => (typeof step?.run === 'string' ? executableScript(step.run) : '')
  const setEqual = (observed, expected) => observed.length === expected.length
    && [...observed].sort().join(',') === [...expected].sort().join(',')

  // 判据只对**本仓的 CI 工作流**(`ci.yml`)生效。为什么锚文件名而不是"内容里有没有
  // `yarn check`/`go test`":那类锚点会随被检查的东西一起消失 —— 把接线整段删掉时,
  // 锚点也没了,判据静默变绿(正是这条策略要防的形态)。改名/搬走 ci.yml 不会静默:
  // `scripts/verify-ci-scripts.mjs` 的 §1c/§1d 直接按这个路径抽取并断言(找不到即红)。
  if (file !== 'ci.yml') return failures

  const caseGateHits = []
  const probeHits = []
  for (const [jobId, job] of Object.entries(jobs)) {
    for (const [index, step] of stepsOf(job).entries()) {
      const script = scriptOf(step)
      if (script.includes(WASM_CASE_GATE_SCRIPT)) caseGateHits.push({ jobId, job, step, index, script })
      const groups = /--groups\s+([0-9,]+)/u.exec(script)
      if (script.includes('verify-wasm-client-only.sh') && groups !== null) {
        probeHits.push({ jobId, job, step, index, script, groups: groups[1].split(',').filter(Boolean) })
      }
    }
  }

  if (caseGateHits.length !== 1) {
    failures.push({
      name: file,
      line: 0,
      detail: `[SK-12] 调用 \`${WASM_CASE_GATE_SCRIPT}\` 的 step 有 ${caseGateHits.length} 个(要求恰好 1 个)`
        + '\n  ⇒ 0 个 = W-4「用例级 0 skip」在 CI 侧从不执行(脚本里那句"PG 不可达 ⇒ 全部 t.Skip ⇒ '
        + '0 断言通过"会重新变绿);多个 = 同一份报告被反复判/接错工作目录。',
    })
  } else {
    const hit = caseGateHits[0]
    const label = `job ${hit.jobId} 的 step「${stepName(hit.step, hit.index)}」`
    const goTest = /go\s+test\b[^\n]*?-json[^\n]*?>\s*([^\s;&|]+)/u.exec(hit.script)
    if (goTest === null) {
      failures.push({
        name: file,
        line: 0,
        detail: `[SK-12] ${label} 里没有 \`go test … -json > <报告>\` 的落盘写法`
          + '\n  ⇒ 判定脚本需要 `go test -json` 的报告;没有它只能以 exit 2 收尾(而"环境问题"很容易被忽略)。',
      })
    }
    const reportArg = new RegExp(`${WASM_CASE_GATE_SCRIPT.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\s+([^\\\s\\\\]+)`, 'u').exec(hit.script)
    const reportPath = reportArg?.[1]
    if (goTest !== null && reportPath !== undefined && goTest[1] !== reportPath) {
      failures.push({
        name: file,
        line: 0,
        detail: `[SK-12] ${label} 的报告路径不一致:go test 落盘到 \`${goTest[1]}\`,`
          + `判定脚本读 \`${reportPath}\` ⇒ checker 只会 exit 2("报告不可读")。`,
      })
    }
    const requireMatch = /--require\s+(\S+)/u.exec(hit.script)
    const requireList = requireMatch === null ? [] : requireMatch[1].split(',').map(name => name.trim()).filter(Boolean)
    if (!setEqual(requireList, WASM_CASE_GATE_REQUIRED)) {
      failures.push({
        name: file,
        line: 0,
        detail: `[SK-12] ${label} 的 --require 名单与登记值不一致`
          + `\n  实际:${requireList.join(', ') || '(缺失)'}`
          + `\n  登记:${WASM_CASE_GATE_REQUIRED.join(', ')}`
          + '\n  ⇒ 名单被改松(例如只留一条必然通过的用例)= 判据恒绿;改名时必须同步这里的登记值。',
      })
    }
    const scopeMatch = /--scope\s+(\S+)/u.exec(hit.script)
    const scopeList = scopeMatch === null ? [] : scopeMatch[1].split(',').map(prefix => prefix.trim()).filter(Boolean)
    if (!setEqual(scopeList, WASM_CASE_GATE_SCOPE)) {
      failures.push({
        name: file,
        line: 0,
        detail: `[SK-12] ${label} 的 --scope 与登记值不一致`
          + `\n  实际:${scopeList.join(', ') || '(缺失:整份报告都判)'}`
          + `\n  登记:${WASM_CASE_GATE_SCOPE.join(', ')}`
          + '\n  ⇒ 缺省(整份报告)会把 `internal/serverstore` 的 DST 用例这类**环境条件型 skip** 也算成失败'
          + '(UTC runner 上必然红);范围被放大到全仓 = 每次必红的假红,而假红的下场通常是关掉判据。',
      })
    }
    if (!/exit\s+[1-9]/u.test(hit.script)) {
      failures.push({
        name: file,
        line: 0,
        detail: `[SK-12] ${label} 里没有把判定收口成失败的 \`exit 1\``
          + '\n  ⇒ checker 的 1/2(报告不合格 / 前置缺失)会被当成"只是打印了几行")。',
      })
    }
    if (hit.step?.continue_on_error !== undefined && hit.step.continue_on_error !== false) {
      failures.push({
        name: file,
        line: 0,
        detail: `[SK-12] ${label} 打开了 continue-on-error ⇒ 判定永远不会失败。`,
      })
    }
    const jobPg = hit.job?.env?.PG_DSN_TEST
    const stepPg = hit.step?.env?.PG_DSN_TEST
    const pg = typeof stepPg === 'string' && stepPg.trim() !== '' ? stepPg : jobPg
    if (typeof pg !== 'string' || pg.trim() === '') {
      failures.push({
        name: file,
        line: 0,
        detail: `[SK-12] ${label} 所在的 job 没有 \`PG_DSN_TEST\``
          + '\n  ⇒ 没有真 PG 时 wasm 的 appserver 用例会 t.Skip,判定必然红 ⇒ 接进无 PG 的 job 等于接了个恒红判据。',
      })
    }
  }

  if (probeHits.length !== 1) {
    failures.push({
      name: file,
      line: 0,
      detail: `[SK-12] 调用 \`verify-wasm-client-only.sh --groups …\` 的 step 有 ${probeHits.length} 个(要求恰好 1 个)`
        + '\n  ⇒ 0 个 = W-5 的 4 个协议探针在 CI 侧从不执行(`.github/` 对它 0 引用)。',
    })
  } else {
    const hit = probeHits[0]
    const label = `job ${hit.jobId} 的 step「${stepName(hit.step, hit.index)}」`
    if (!setEqual(hit.groups, WASM_PROBE_GROUPS)) {
      failures.push({
        name: file,
        line: 0,
        detail: `[SK-12] ${label} 跑的是 --groups ${hit.groups.join(',')}(登记 ${WASM_PROBE_GROUPS.join(',')})`
          + '\n  ⇒ 接线要的是组 6(协议探针);漏掉/换组等于探针仍然从不执行。',
      })
    }
    const env = typeof hit.step?.env === 'object' && hit.step.env !== null ? hit.step.env : {}
    if (env[WASM_PROBE_ENV] !== '1' && env[WASM_PROBE_ENV] !== 1) {
      failures.push({
        name: file,
        line: 0,
        detail: `[SK-12] ${label} 没有 \`${WASM_PROBE_ENV}: '1'\`(实际 ${JSON.stringify(env[WASM_PROBE_ENV] ?? null)})`
          + '\n  ⇒ 非 Linux 平台上探针会"跑完给结论"而不是显式 SKIP(77);组内新增的"全组 SKIP = 失败"'
          + '只在 Linux 上保证不装作跑过。',
      })
    }
    if (hit.step?.continue_on_error !== undefined && hit.step.continue_on_error !== false) {
      failures.push({
        name: file,
        line: 0,
        detail: `[SK-12] ${label} 打开了 continue-on-error ⇒ 探针失败不会拦门禁。`,
      })
    }
    // `if:` 不得把它收窄成"几乎不跑"的条件(允许 `!= 'false'` 这种 fail-safe 形态)。
    const stepIf = typeof hit.step?.if === 'string' ? hit.step.if : ''
    const narrow = /github\.event_name|needs\.[\w-]+\.result|outputs\.code\s*==/u.test(stepIf)
    if (narrow && !/!=\s*'false'/u.test(stepIf)) {
      failures.push({
        name: file,
        line: 0,
        detail: `[SK-12] ${label} 的 \`if:\` 是 \`${stepIf.trim()}\` —— 这会把探针收窄成"几乎不跑"`
          + '\n  ⇒ 允许的形态只有:不写 `if:`,或写成 `!= \'false\'`(docs-only 的 fail-safe 形态)。',
      })
    }
  }
  if (caseGateHits.length > 0 || probeHits.length > 0) {
    notes.push(`[SK-12] WASM 接线:用例级报告 ${caseGateHits.length} 步(范围 ${WASM_CASE_GATE_SCOPE.join(',')})、`
      + `协议探针 ${probeHits.length} 步(组 ${WASM_PROBE_GROUPS.join(',')})`)
  }
  return failures
}

function checkReleaseSurface(file, document, text, notes) {
  const failures = []
  // 只在"这份 workflow 有发布面"时生效:合成样本 / 纯测试 workflow 只跑 `yarn check`
  // 却没有 release 步骤是合法的(这条判据的动机是"半发布窗口",前提是先有发布面)。
  if (!/gh\s+release\s+(?:create|edit|upload)|ci-release-policy\.sh/u.test(text)) return failures
  const jobs = typeof document?.jobs === 'object' && document.jobs !== null ? document.jobs : {}
  /** 策展发布说明的 fail-loud:判据必须落在**可执行文本**上(注释不算)。 */
  const isNotesGate = step => {
    if (typeof step?.run !== 'string') return false
    const script = executableScript(step.run)
    return /docs\/releases\//u.test(script)
      && /(?:test\s+-f|\[\s+-f)/u.test(script)
      && /exit\s+1/u.test(script)
  }
  const isUpload = step => typeof step?.run === 'string'
    && EXTERNAL_UPLOAD_COMMANDS.some(command => executableScript(step.run).includes(command))
  const idsOf = steps => steps.map((step, index) => (step ? index : -1)).filter(index => index >= 0)
  const position = (steps, predicate) => idsOf(steps).filter(index => predicate(steps[index]))

  for (const [jobId, job] of Object.entries(jobs)) {
    const steps = Array.isArray(job?.steps) ? job.steps : []
    if (steps.length === 0) continue
    const notesIndexes = position(steps, isNotesGate)
    const uploadIndexes = position(steps, isUpload)
    const fullGateIndexes = position(steps, step => typeof step?.run === 'string'
      && /(?:^|[;&|(\n]|\$\()\s*(?:corepack\s+yarn|yarn)\s+check(?![\w:-])/u.test(executableScript(step.run)))

    // ① 对外上传之前必须有一道 fail-loud(C-CI-2 的半发布窗口)。
    if (uploadIndexes.length > 0) {
      if (notesIndexes.length === 0) {
        failures.push({
          name: file,
          line: 0,
          detail: `[SK-11] job ${jobId} 有对外上传步骤(${uploadIndexes.map(index => `第 ${index + 1} 步`).join(', ')}),`
            + '但整个 job 里没有"策展发布说明缺失即 fail-loud"的步骤'
            + '\n  ⇒ 正式 tag 缺 docs/releases/<tag>.md 时,客户侧更新面会先被挂上新版本(半发布窗口,'
            + '2026-09-23 审计 C-CI-2)。判据:该步骤的**可执行文本**必须同时含 `docs/releases/`、'
            + '`test -f`(或 `[ -f`)与 `exit 1`(注释里写不算)。',
        })
      } else if (Math.min(...notesIndexes) > Math.min(...uploadIndexes)) {
        failures.push({
          name: file,
          line: 0,
          detail: `[SK-11] job ${jobId} 的策展说明检查(第 ${Math.min(...notesIndexes) + 1} 步)排在第一个对外上传`
            + `(第 ${Math.min(...uploadIndexes) + 1} 步)之后 ⇒ 说明缺失时上传已经发生(半发布:C-CI-2)。`,
        })
      }
    }
    // ② 早检:跑全量门禁的那个 job 里必须有一道(1 分钟内红,不等三平台构建 40 分钟)。
    if (fullGateIndexes.length > 0 && notesIndexes.length === 0) {
      failures.push({
        name: file,
        line: 0,
        detail: `[SK-11] job ${jobId} 跑全量门禁但没有"策展发布说明早检"步骤`
          + '\n  ⇒ 正式 tag 缺 docs/releases/<tag>.md 时,要等三平台构建 + 各渠道镜像构建跑完'
          + '才在最后一步红(本仓明文的成本规则是"1 分钟内报错")。'
          + '要求:门禁步之前有一道纯 shell 的 fail-loud(不依赖构建产物)。',
      })
    } else if (fullGateIndexes.length > 0 && Math.min(...notesIndexes) > Math.min(...fullGateIndexes)) {
      failures.push({
        name: file,
        line: 0,
        detail: `[SK-11] job ${jobId} 的策展说明早检(第 ${Math.min(...notesIndexes) + 1} 步)排在门禁步`
          + `(第 ${Math.min(...fullGateIndexes) + 1} 步)之后 ⇒ 不再是"早检"(C-CI-2)。`,
      })
    }
  }

  // ③ `gh release create|edit` 的参数语义(C-CI-3:旧实现是整段 YAML 子串匹配,
  //    把关键行注释掉仍 EXIT=0;等价的 `--title "$TAG"` 反而被判红)。
  const TAG_REF = /\$\{?(?:TAG|GITHUB_REF_NAME)\b\}?/u
  for (const [jobId, job] of Object.entries(jobs)) {
    const steps = Array.isArray(job?.steps) ? job.steps : []
    steps.forEach((step, index) => {
      if (typeof step?.run !== 'string') return
      const script = joinContinuations(executableScript(step.run))
      for (const match of script.matchAll(GH_RELEASE_INVOCATION)) {
        const tail = match[2]
        const title = /(?:^|\s)(?:--title|-t)(?:=|\s+)(?:"([^"]*)"|'([^']*)'|(\S+))/u.exec(tail)
        const titleValue = title === null ? undefined : (title[1] ?? title[2] ?? title[3])
        if (titleValue === undefined || !TAG_REF.test(titleValue)) {
          failures.push({
            name: file,
            line: 0,
            detail: `[SK-11] job ${jobId} 的 step「${stepName(step, index)}」里 \`gh release ${match[1]}\` 的 Release 名不是 tag 本身`
              + `(实际 --title 取值:${titleValue === undefined ? '缺失' : titleValue})`
              + '\n  ⇒ Releases 页左侧列表宽度固定,长名会被截断成 "PicoAide Harness v2.6…",同页版本号全部不可见。'
              + '必须 `--title` 且取值引用 tag 变量(`${TAG}` / `$TAG` / `${GITHUB_REF_NAME}` 都接受)。',
          })
        }
        const assignedNotesVars = new Set(
          [...script.matchAll(/([A-Za-z_][A-Za-z0-9_]*)=[^\n]*?(--notes-file|--generate-notes|--notes)\b/gu)].map(hit => hit[1]),
        )
        const hasNotesInline = /(?:^|\s)--(?:notes-file|notes|generate-notes)\b/u.test(tail)
        const hasNotesVar = [...assignedNotesVars].some(name => new RegExp(`\\$\\{?${name}\\b`, 'u').test(tail))
        if (!/exit\s+[1-9]/u.test(script)) {
          failures.push({
            name: file,
            line: 0,
            detail: `[SK-11] job ${jobId} 的 step「${stepName(step, index)}」里没有 fail-loud(\`exit 1\`)`
              + '\n  ⇒ 本仓定案:正式 tag 缺 docs/releases/<tag>.md 时**绝不静默回退**自动生成的 PR 列表'
              + '(v2.7.0 的教训:公开版本页变成 CI 日志)。这一条判据只认可执行文本,注释里写不算。',
          })
        }
        if (!hasNotesInline && !hasNotesVar) {
          failures.push({
            name: file,
            line: 0,
            detail: `[SK-11] job ${jobId} 的 step「${stepName(step, index)}」里 \`gh release ${match[1]}\` 没有说明来源`
              + '\n  ⇒ 需要 `--notes-file` / `--notes` / `--generate-notes`,或同一脚本里赋给这些 flag 的变量'
              + '(本仓的策展说明路径是 docs/releases/<tag>.md)。',
          })
        }
      }
    })
  }
  notes.push('[SK-11] 发布面已按可执行文本检查(策展说明位置 + gh release 参数语义)')
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
  const run = (label, steps, options = {}) => {
    const file = options.file ?? 'selftest.yml'
    const result = checkWorkflowText(file, selftestWorkflow(steps, options))
    return { label, failures: result.failures }
  }
  const tags = (result, tag) => result.failures.filter(failure => failure.detail.includes(tag))
  /**
   * 自检样本登记表(2026-09-19 第三轮审计 F3-4:"自检自身被掏空无人察觉")。
   *
   * 每个样本都同时登记两件事:①它**必须**被门禁报出来(红样本)或**必须不**被报出来
   * (绿样本);②它的存在本身。跑完全部样本后做两条对账:
   *   - `observed` 里的**红样本**数量必须等于 `SELFTEST_EXPECTED_RED_SAMPLES`;
   *   - 红样本对应的策略标签集合必须等于 `SELFTEST_EXPECTED_POLICIES`。
   * 掏空样本(把违规样本删掉/改成合法形态/把断言注释掉)任一条都会让对账红 ——
   * 这就是"看守守门人"的那道闸(此前 m8:同时掏空 selfTestPolicies+selfTestScanner
   * 可以完全静默,因为自检自己没有任何存在性断言)。
   */
  const observed = []
  const expect = (ok, message) => {
    if (!ok) failures.push(message)
  }
  /**
   * 跑一个样本并登记:red = 期望被报出来的策略标签,null = 期望完全绿。
   * `options.raw` 直接给整份 workflow 文本(SK-9/SK-10/SK-11 的样本需要多 job 形状)。
   */
  const sample = (id, expectation, steps, options = {}) => {
    const file = options.file ?? 'selftest.yml'
    const text = options.raw ?? selftestWorkflow(steps, options)
    const result = checkWorkflowText(file, text)
    const label = expectation === null ? `${id} [绿样本]` : `${id} [红样本 ${expectation}]`
    observed.push({ id, policy: expectation, label, failures: result.failures })
    return result
  }
  const expectRed = (id, tag, steps, options = {}) => {
    const result = sample(id, tag, steps, options)
    const hits = tags(result, tag)
    expect(hits.length >= 1, `${tag} 自检:样本 \`${id}\` 没有被判失败(策略形同不存在)`)
    return result
  }
  const expectGreen = (id, steps, options = {}) => {
    const result = sample(id, null, steps, options)
    expect(result.failures.length === 0,
      `自检:样本 \`${id}\` 被判失败(假阳性会把白名单逼成大洞;收紧过度也是缺陷):\n`
        + result.failures.map(failure => `    ${failure.detail.split('\n')[0]}`).join('\n'))
    return result
  }

  /**
   * WASM 接线的形态开关(W-4/W-5,见 [SK-12]):
   * `full` 正常 / `none` 整段缺 / `no-scope` 去掉 --scope / `weakened-require` 名单改松 /
   * `no-exit` 去掉收口 / `no-pg` 所在 job 不给 PG_DSN_TEST / `path-mismatch` 报告路径不一致。
   */
  const WASM_CASE_GATE_OPTIONS = {
    full: {
      scope: `--scope ${WASM_CASE_GATE_SCOPE.join(',')} \\`,
      require: `--require ${WASM_CASE_GATE_REQUIRED.join(',')} \\`,
      exit: ['          if [ "${GO_TEST_STATUS}" -ne 0 ] || [ "${CHECK_STATUS}" -ne 0 ]; then', '            exit 1', '          fi'],
      report: 'go-test.json',
      read: 'go-test.json',
      pg: true,
    },
    'no-scope': {
      scope: null,
      require: `--require ${WASM_CASE_GATE_REQUIRED.join(',')} \\`,
      exit: ['          if [ "${GO_TEST_STATUS}" -ne 0 ] || [ "${CHECK_STATUS}" -ne 0 ]; then', '            exit 1', '          fi'],
      report: 'go-test.json',
      read: 'go-test.json',
      pg: true,
    },
    'weakened-require': {
      scope: `--scope ${WASM_CASE_GATE_SCOPE.join(',')} \\`,
      require: '--require TestClientFrameUser_ProjectsUserRowAndPublisherFlag \\',
      exit: ['          if [ "${GO_TEST_STATUS}" -ne 0 ] || [ "${CHECK_STATUS}" -ne 0 ]; then', '            exit 1', '          fi'],
      report: 'go-test.json',
      read: 'go-test.json',
      pg: true,
    },
    'no-exit': {
      scope: `--scope ${WASM_CASE_GATE_SCOPE.join(',')} \\`,
      require: `--require ${WASM_CASE_GATE_REQUIRED.join(',')} \\`,
      exit: [],
      report: 'go-test.json',
      read: 'go-test.json',
      pg: true,
    },
    'no-pg': {
      scope: `--scope ${WASM_CASE_GATE_SCOPE.join(',')} \\`,
      require: `--require ${WASM_CASE_GATE_REQUIRED.join(',')} \\`,
      exit: ['          if [ "${GO_TEST_STATUS}" -ne 0 ] || [ "${CHECK_STATUS}" -ne 0 ]; then', '            exit 1', '          fi'],
      report: 'go-test.json',
      read: 'go-test.json',
      pg: false,
    },
    'path-mismatch': {
      scope: `--scope ${WASM_CASE_GATE_SCOPE.join(',')} \\`,
      require: `--require ${WASM_CASE_GATE_REQUIRED.join(',')} \\`,
      exit: ['          if [ "${GO_TEST_STATUS}" -ne 0 ] || [ "${CHECK_STATUS}" -ne 0 ]; then', '            exit 1', '          fi'],
      report: 'go-test.json',
      read: 'server/go-test.json',
      pg: true,
    },
  }
  /** W-5 探针步的形态生成器(两个夹具共用)。 */
  const wasmProbeLines = (mode) => (mode === 'none' ? [] : [
    '      - name: WASM protocol probes (group 6; Linux)',
    ...(mode === 'narrow-if' ? ["        if: github.event_name == 'workflow_dispatch'"] : []),
    '        env:',
    `          ${WASM_PROBE_ENV}: ${mode === 'no-env' ? "''" : "'1'"}`,
    `        run: bash scripts/verify-wasm-client-only.sh --groups ${mode === 'group1' ? '1' : '6'}`,
  ])
  /** W-4 用例级报告步的形态生成器(两个夹具共用)。 */
  const wasmCaseGateLines = (mode) => {
    if (mode === 'none') return []
    const option = WASM_CASE_GATE_OPTIONS[mode]
    return [
      '  server:',
      '    runs-on: ubuntu-latest',
      '    timeout-minutes: 45',
      ...(option.pg ? [
        '    env:',
        '      PG_DSN_TEST: postgres://postgres:postgres@127.0.0.1:5432/postgres?sslmode=disable',
      ] : []),
      '    defaults:',
      '      run:',
      '        working-directory: server',
      '    steps:',
      '      - uses: actions/checkout@v7',
      '        with:',
      '          fetch-depth: 0',
      '      - run: |',
      '          set -euo pipefail',
      '          GO_TEST_STATUS=0',
      `          go test ./... -count=1 -p 1 -timeout 15m -json > ${option.report} || GO_TEST_STATUS=$?`,
      '          CHECK_STATUS=0',
      `          node ../${WASM_CASE_GATE_SCRIPT} ${option.read} \\`,
      ...(option.scope === null ? [] : [`            ${option.scope}`]),
      `            ${option.require}`,
      '            || CHECK_STATUS=$?',
      ...option.exit,
    ]
  }
  /**
   * 夹具：真实 CI 的检出形态（`actions/checkout` + `fetch-depth: 0`）。
   * [SK-8b] 要求"跑全量根门禁的 job 必须拿到完整历史"，所以任何含 `yarn check` 的
   * 样本都要带这一步 —— 不带就是"夹具不像真 CI"的假红。
   */
  const GATE_CHECKOUT = (depth = '          fetch-depth: 0') => [
    '      - uses: actions/checkout@v7',
    '        with:',
    '          submodules: recursive',
    ...(depth === null ? [] : [depth]),
  ]

  // ---- 策略 1:吞退出码 ----
  const swallowOr = expectRed('a1-or-true', '[SK-7a]', [
    '      - name: go test 被吞',
    '        run: |',
    '          set -euo pipefail',
    '          go test ./... -count=1 -timeout 15m || true',
  ])
  expect(tags(swallowOr, '[SK-7a]').some(failure => failure.detail.includes('go test 被吞')),
    '[SK-7a] 自检:报错没有点名 step')
  expectRed('a2-colon', '[SK-7a]', [
    '      - name: 冒号吞码',
    '        run: |',
    '          set -euo pipefail',
    '          npm test; :',
  ])
  expectRed('a3-continue-on-error', '[SK-7a]', [
    '      - name: continue-on-error 吞码',
    '        continue-on-error: true',
    '        run: yarn check',
  ])
  // F2-4:job 级 continue-on-error(策略此前只读 step 级字段)。
  expectRed('a4-job-continue-on-error', '[SK-7a]', [
    '      - name: 正常 step',
    '        run: yarn check',
  ], { jobContinueOnError: true })
  // F2-3 块标量:三种此前零守卫的形态,现在都必须红且点名。
  expectRed('a5-block-or-exit0', '[SK-7a]', [
    '      - name: 块标量 || exit 0',
    '        run: |',
    '          set -euo pipefail',
    '          npm test || exit 0',
  ])
  expectRed('a6-block-or-echo', '[SK-7a]', [
    '      - name: 块标量 || echo',
    '        run: |',
    '          set -euo pipefail',
    '          npm test || echo skipped',
  ])
  // 命令替换里的 `|| true` 是**真的吞码**(本仓白名单里那条的形态):必须红。
  expectRed('a17-command-substitution-swallow', '[SK-7a]', [
    '      - name: 命令替换里的兜底',
    '        run: |',
    '          set -euo pipefail',
    '          CHANGED="$(git diff --name-only A B || true)"',
  ])
  // 引号包裹(第三轮新增点名的第 4 类):内层必须被递归判。
  expectRed('a7-bash-c-single-quote', '[SK-7c]', [
    '      - run: |',
    '          set -euo pipefail',
    '          bash -c \'go vet ./... || true\'',
  ])
  expectRed('a8-eval-or-echo', '[SK-7c]', [
    '      - run: |',
    '          set -euo pipefail',
    '          eval "yarn check || echo skipped"',
  ])
  expectRed('a9-bash-c-pipeline', '[SK-7c]', [
    '      - run: |',
    '          set -euo pipefail',
    '          bash -c \'go test ./... -timeout 15m | tail -5\'',
  ])
  expectRed('a10-quoted-unreadable', '[SK-7c]', [
    '      - run: |',
    '          set -euo pipefail',
    '          bash -c "$CMD"',
  ])
  expectGreen('g-quoted-safe-inner', [
    '      - run: |',
    '          set -euo pipefail',
    '          bash -c \'set -euo pipefail; go vet ./...\'',
  ])
  // 策略 4:块标量必须自己声明退出语义(F2-3)。
  expectRed('a11-block-without-errexit', '[SK-7]', [
    '      - name: 裸块标量',
    '        run: |',
    '          npm test | tail -5',
  ])
  // 藏在 `if … then` 分支里的 guard **不算**块首声明(外层脚本仍然无 errexit)。
  // 这条曾经真的踩到:本仓部署资产检查块历史上带着一份"分支里的" `set -euo pipefail`,
  // 宽松匹配会把它误判成"已声明"⇒ 既不报缺口、又让白名单条目变成死条目(本轮自检抓到)。
  expectRed('a20-nested-guard-does-not-count', '[SK-7]', [
    '      - name: 分支里的 guard 不算数',
    '        run: |',
    '          if command -v docker >/dev/null 2>&1; then',
    '            set -euo pipefail',
    '            docker compose config -q',
    '          fi',
  ])
  expectRed('a21-guard-after-first-command', '[SK-7]', [
    '      - name: guard 写在第一条命令之后',
    '        run: |',
    '          echo start',
    '          set -euo pipefail',
    '          npm test',
  ])
  expectGreen('a22-split-guard-ok', [
    '      - name: 分两句声明也算',
    '        run: |',
    '          set -e',
    '          set -o pipefail',
    '          npm test | tail -5',
  ])
  expectRed('a12-block-pipeline-no-pipefail', '[SK-7]', [
    '      - name: 有 errexit 没 pipefail',
    '        run: |',
    '          set -e',
    '          npm test | tail -5',
  ])
  expectGreen('g-block-with-errexit', [
    '      - name: 规范块标量',
    '        run: |',
    '          set -euo pipefail',
    '          npm test | tail -5',
  ])
  const swallowedInComment = expectGreen('g-comment-and-quotes-literal', [
    '      - name: 注释里的 || true 不是吞码',
    '        run: |',
    '          set -euo pipefail',
    '          # 这里写 `|| true` 只是说明,不是吞码',
    '          echo "go test || true"',
  ])
  // 白名单**逐条**生效:同一句话在 ci.yml 里被登记放行,在别的文件里必须照报
  // (否则白名单会退化成"整类语句豁免",那正是要防的豁免洞)。
  // 白名单条目按 (file, signature) 命中,所以这条样本必须用 file: 'ci.yml';
  // 而 [SK-12] 只对 ci.yml 生效 ⇒ 样本也要带上 WASM 接线(否则是本夹具形状不真实造成的假红)。
  expectGreen('g-allowlisted-cleanup', [
    '      - name: 清理类动作走白名单',
    '        run: |',
    '          set -euo pipefail',
    '          rm -rf "$PG18_MOUNT" 2>/dev/null || true',
    ...wasmProbeLines('full'),
    ...wasmCaseGateLines('full'),
  ], { file: 'ci.yml' })
  expectRed('a19-allowlist-not-file-wide', '[SK-7a]', [
    '      - name: 同样的清理语句在别的文件里',
    '        run: |',
    '          set -euo pipefail',
    '          rm -rf "$PG18_MOUNT" 2>/dev/null || true',
  ])
  // 第三轮审计"试过但没能绕过"的形态:同样必须**不误报**(收紧过度是下一轮的新缺陷)。
  expectRed('a13-or-true-two-spaces', '[SK-7a]', [
    '      - name: 多空格 || true',
    '        run: |',
    '          set -euo pipefail',
    '          npm test ||  true',
  ])
  expectRed('a14-or-true-tab', '[SK-7a]', [
    '      - name: 制表符 || true',
    '        run: |',
    '          set -euo pipefail',
    '          npm test ||\ttrue',
  ])
  expectRed('a15-semicolon-true-nospace', '[SK-7a]', [
    '      - name: 无空格 ;true',
    '        run: |',
    '          set -euo pipefail',
    '          npm test ;true',
  ])
  // 子 shell 里的 `|| true` 同样是吞码(审计"试过但没能绕过"清单里被 7a 正确抓到的一条)。
  expectRed('a18-subshell-swallow', '[SK-7a]', [
    '      - run: |',
    '          set -euo pipefail',
    '          ( npm test || true )',
  ])
  // 表达式形态的 continue-on-error 静态求不出真假 ⇒ 按"会静默"处理(旧策略口径,不得退化)。
  expectRed('a16-continue-on-error-expression', '[SK-7a]', [
    '      - run: yarn check',
    '        continue-on-error: ${{ matrix.experimental }}',
  ])
  expectGreen('g-coe-expr-false-is-ok', [
    ...GATE_CHECKOUT(),
    '      - name: 表达式为字面 false',
    '        continue-on-error: false',
    '        run: yarn check',
  ])

  // ---- 策略 2:超时序关系 ----
  const tooLong = expectRed('b1-timeout-25m', '[SK-7b]', [
    '      - name: 单包 25m',
    '        run: go test ./... -count=1 -p 1 -timeout 25m',
  ])
  const budgetFailure = tags(tooLong, '[SK-7b]')
  expect(budgetFailure.some(failure => failure.detail.includes('2×25+5=55 > 45')),
    '[SK-7b] 自检:报错里没有写出算术(2×25+5=55 > 45)')
  expect(budgetFailure.some(failure => failure.detail.includes('单包 25m')),
    '[SK-7b] 自检:报错没有点名 step')
  expectGreen('b2-timeout-15m-ok', [
    '      - name: 单包 15m',
    '        run: go test ./... -count=1 -p 1 -timeout 15m',
  ])
  expectRed('b3-timeout-no-job-budget', '[SK-7b]', [
    '      - name: 没有 job 预算',
    '        run: go test ./... -timeout 15m',
  ], { timeoutMinutes: null })
  // F2-2:`-timeout 0` 在 Go 里是**关闭超时**(实测 `-timeout 0s` 时 3 秒用例照跑)。
  expectRed('b4-timeout-zero-s', '[SK-7b]', [
    '      - name: 超时被关掉',
    '        run: go test ./... -count=1 -p 1 -timeout 0s',
  ])
  expectRed('b5-timeout-zero-bare', '[SK-7b]', [
    '      - name: 超时被关掉(裸 0)',
    '        run: go test ./... -count=1 -p 1 -timeout 0',
  ])
  expectRed('b6-timeout-one-second', '[SK-7b]', [
    '      - name: 荒谬小值',
    '        run: go test ./... -count=1 -p 1 -timeout 1s',
  ])
  // F3-1:解析不出的 `-timeout` 必须 fail-loud,而不是靠全仓计数器兜底。
  expectRed('b7-timeout-two-spaces', '[SK-7b]', [
    '      - name: 双空格',
    '        run: go test ./... -count=1 -p 1 -timeout  120m',
  ])
  expectRed('b8-timeout-variable', '[SK-7b]', [
    '      - name: 变量值',
    '        run: go test ./... -count=1 -p 1 -timeout "$T"',
  ])
  expectRed('b9-timeout-backslash-continuation', '[SK-7b]', [
    '      - name: 反斜杠续行',
    '        run: |',
    '          set -euo pipefail',
    '          go test ./... -count=1 -p 1 \\',
    '            -timeout 120m',
  ])
  expectRed('b10-timeout-no-unit', '[SK-7b]', [
    '      - name: 无单位',
    '        run: go test ./... -count=1 -p 1 -timeout 90',
  ])
  expectRed('b11-timeout-env-injected', '[SK-7b]', [
    '      - name: 后者覆盖前者',
    '        env:',
    '          EXTRA_FLAGS: -timeout=120m',
    '        run: go test ./... -count=1 -p 1 -timeout 15m $EXTRA_FLAGS',
  ])
  expectRed('b12-timeout-two-literal-values', '[SK-7b]', [
    '      - name: 字面两个超时',
    '        run: go test ./... -count=1 -p 1 -timeout 15m -timeout=120m',
  ])
  // F3-2:注释里的历史命令不得误报(块里另有一条真命令维持存在性对账)。
  expectGreen('b13-timeout-in-comment', [
    '      - name: 注释里的历史命令',
    '        run: |',
    '          set -euo pipefail',
    '          # 旧写法: go test ./... -timeout 120m',
    '          go test ./... -count=1 -p 1 -timeout 15m',
  ])

  // ---- 策略 3:单行退出码语义 ----
  expectRed('c1-pipeline', '[SK-7c]', [
    '      - run: go test ./... -timeout 15m | tail -5',
  ])
  expectRed('c2-or-echo', '[SK-7a]', [
    '      - run: yarn check || echo skipped',
  ])
  expectRed('c3-negation', '[SK-7c]', [
    '      - run: test -f package.json; ! yarn check',
  ])
  expectGreen('c4-pipefail-ok', [
    '      - run: set -o pipefail; go test ./... -timeout 15m | tail -5',
  ])
  expectGreen('c5-exit-one-ok', [
    ...GATE_CHECKOUT(),
    '      - run: yarn check || exit 1',
  ])
  expectGreen('c6-and-chain-ok', [
    ...GATE_CHECKOUT(),
    '      - run: cp a b && yarn check',
  ])
  expectGreen('c7-real-inline-install', [
    '      - run: command -v aws >/dev/null 2>&1 || choco install awscli -y --no-progress',
  ])
  expectGreen('c8-if-not-negation-ok', [
    '      - run: |',
    '          set -euo pipefail',
    '          if ! command -v docker >/dev/null 2>&1; then',
    '            echo "::error::docker 不可用"',
    '            exit 1',
    '          fi',
  ])
  expectGreen('c9-echo-then-exit-zero-ok', [
    '      - run: |',
    '          set -euo pipefail',
    '          echo "code=false" >> "$GITHUB_OUTPUT"',
    '          exit 0',
  ])

  // ---- CodeQL #100 js/redos：前缀扫描器（替代原来会指数回溯的大正则）----
  //
  // 语义表 + **泵串**判据。旧正则 `(?:NAME=(?:"[^"]*"|'[^']*'|\S*)[ \t]+)*(?:echo|…)\b`
  // 的值分支内部重叠（`""` 既能走引号分支也能走 `\S*`），实测 k=24 组泵串要 1.08s、
  // k=26 约 4s（指数）；新实现是单次线性扫描（<1ms）。把实现回退成正则 ⇒ 这里必然变红。
  for (const [input, expected] of [
    ['echo', true], ['true', true], ['break', true], ['continue', true], ['return', true],
    [':x', true], [':', false], [': ', false], ['echox', false], ['echo-x', true],
    // 末尾命令本身；`printf` 与 `echo -n` 这类也照旧
    ['printf', true], ['echo -n x', true],
    // 赋值 token 必须**后接空白再跟空转命令**才算"无害前缀"（单个 `A=x` 不是）
    ['A=x', false], ['A=', false], ['A="a b"', false], ["B='c d'", false],
    ['A= echo', true], ['A=x echo', true], ['A="a b" echo', true], ["B='c d' echo", true],
    ['A=1 B=2 echo', true], ['FOO=""\tA= BAR=baz echo', true],
    // 引号形态：不闭合/闭合后紧跟非空白 ⇒ 引号当普通字符（与旧正则回退 `\S*` 一致）
    ['A=x"y echo', true], ['A="a"b" echo', true], ['A=a"b c"d echo', false], ['A=" x=1 echo"', true],
    // 非无害前缀
    ['set -euo pipefail', false], ['go test ./... || true', false], ['A=1 && echo', false],
  ]) {
    const got = isHarmlessPrefix(input)
    expect(got === expected,
      `isHarmlessPrefix(${JSON.stringify(input)}) 期望 ${expected}，实得 ${got}`)
  }
  {
    const pump = 'A=' + '""\tA='.repeat(24) + 'echo'
    const started = Date.now()
    isHarmlessPrefix(pump)
    const elapsed = Date.now() - started
    expect(elapsed < 250, `前缀扫描器在泵串上退化成指数回溯（${elapsed}ms > 250ms）`)
  }

  // ---- 第三轮审计"试过但没能绕过"的形态:负向断言(收紧过度也是缺陷)----
  //
  // 这些形态在审计的对抗测试里**已经被正确抓到或正确放行**;把它们固化成断言是为了
  // 下一轮不要因为"门禁又收紧了"把它们误报成新缺陷(审计明确把"收紧过度引入假阳性"
  // 列为下一轮的新缺陷来源)。每一条都注明期望方向。
  expectGreen('n1-pipeline-with-pipefail-block', [
    '      - name: 块首声明了 pipefail',
    '        run: |',
    '          set -euo pipefail',
    '          go test ./... -timeout 15m | tail -5',
  ])
  expectGreen('n2-if-not-pipeline-condition', [
    '      - name: if ! a | b(取反结果交给分支处理)',
    '        run: |',
    '          set -euo pipefail',
    '          if ! docker ps --format X | grep -qx pg; then',
    '            echo "::error::未启动"',
    '            exit 1',
    '          fi',
  ])
  expectGreen('n3-case-branch-patterns-not-pipeline', [
    '      - name: case 分支的 | 是模式分隔符',
    '        run: |',
    '          set -euo pipefail',
    '          case "$f" in',
    '            docs/*|site/*|*.md) ;;',
    '            *) echo other ;;',
    '          esac',
  ])
  expectGreen('n4-test-negation-in-condition', [
    '      - run: |',
    '          set -euo pipefail',
    '          [[ ! -f x ]] && echo missing',
  ])
  expectGreen('n5-exit-zero-after-echo', [
    '      - run: |',
    '          set -euo pipefail',
    '          echo "code=false" >> "$GITHUB_OUTPUT"',
    '          exit 0',
  ])
  expectGreen('n6-timeout-equals-form', [
    '      - name: -timeout=15m 合法写法',
    '        run: go test ./... -timeout=15m',
  ])
  expectRed('n7-double-dash-timeout-flag', '[SK-7b]', [
    '      - name: --timeout 是另一个 flag(不受 -timeout 约束,但也不许假装有预算)',
    '        run: go test ./... --timeout 15m',
  ])
  expectRed('n8-timeout-2h-over-budget', '[SK-7b]', [
    '      - name: 2h 超上界',
    '        run: go test ./... -timeout 2h',
  ])
  expectRed('n9-timeout-7200s-over-budget', '[SK-7b]', [
    '      - name: 7200s 超上界',
    '        run: go test ./... -timeout 7200s',
  ])
  expectGreen('n10-comment-and-quoted-literals', [
    '      - run: |',
    '          set -euo pipefail',
    '          # go test ./... -timeout 120m(注释里的历史命令)',
    '          echo "go test || true"',
  ])

  // ---- 策略 5([SK-8]/[SK-8b]/[SK-9]):根门禁调用形态 + 永不跳过的守卫 job ----
  //
  // 样本形状复刻 ci.yml 的真实形态(两个 job:永不跳过的守卫 job + 门禁 job),
  // 这样"守卫 job 会不会被跳过""守卫结果有没有接进必需检查"这类缺陷才可能被覆盖到。
  const GATE_SHAPE = ({
    guardJob = true,
    guardIf = '',
    guardNeeds = '',
    guardRun = `node ${DOCS_ONLY_GUARD_RUNNER}`,
    gateNeeds = '[changes, gate-guards]',
    gateIf = '${{ !cancelled() }}',
    gateStepIf = "needs.changes.outputs.code != 'false'",
    gateRun = 'yarn check',
    gateDepth = '          fetch-depth: 0',
    guardDepth = '          fetch-depth: 0',
    linkStep = true,
    wasmCaseGate = 'full',
    wasmProbe = 'full',
  } = {}) => [
    'name: selftest',
    'on: push',
    'jobs:',
    '  changes:',
    '    runs-on: ubuntu-latest',
    '    timeout-minutes: 5',
    '    outputs:',
    '      code: ${{ steps.scope.outputs.code }}',
    '    steps:',
    '      - id: scope',
    '        run: echo "code=true" >> "$GITHUB_OUTPUT"',
    ...(guardJob ? [
      '  gate-guards:',
      '    runs-on: ubuntu-latest',
      ...(guardNeeds === '' ? [] : [`    needs: ${guardNeeds}`]),
      ...(guardIf === '' ? [] : [`    if: ${guardIf}`]),
      '    timeout-minutes: 20',
      '    steps:',
      '      - uses: actions/checkout@v7',
      '        with:',
      '          submodules: recursive',
      ...(guardDepth === null ? [] : [guardDepth]),
      `      - run: ${guardRun}`,
    ] : []),
    '  gate:',
    '    runs-on: ubuntu-latest',
    `    needs: ${gateNeeds}`,
    `    if: ${gateIf}`,
    '    timeout-minutes: 60',
    '    steps:',
    ...(linkStep ? [
      '      - name: Root guards must have passed',
      "        if: needs.gate-guards.result != 'success'",
      '        run: |',
      '          set -euo pipefail',
      '          exit 1',
    ] : []),
    '      - uses: actions/checkout@v7',
    '        with:',
    '          submodules: recursive',
    ...(gateDepth === null ? [] : [gateDepth]),
    '      - name: 全量门禁',
    `        if: ${gateStepIf}`,
    `        run: ${gateRun}`,
    ...wasmProbeLines(wasmProbe),
    ...wasmCaseGateLines(wasmCaseGate),
    '',
  ].join('\n')
  const gateSample = (id, expectation, options = {}) => {
    const entry = { raw: GATE_SHAPE(options), file: options.file ?? 'selftest.yml' }
    return expectation === null ? expectGreen(id, [], entry) : expectRed(id, expectation, [], entry)
  }
  // 正例:与 ci.yml 同形 ⇒ 一条失败都不许有(假阳性会把真实形态逼着改坏)。
  gateSample('o1-gate-shape-green', null, {})
  // 注释里的历史命令不该触发判据。
  expectGreen('o2-weakening-in-comment', [
    ...GATE_CHECKOUT(),
    '      - run: |',
    '          set -euo pipefail',
    '          # 历史写法:yarn check --no-guards(仅本地提速)',
    '          yarn check',
  ])
  // 弱化写法必须红(这条策略的现场,逐个样本)。
  gateSample('o3-no-guards', '[SK-8]', { gateRun: 'yarn check --no-guards' })
  gateSample('o4-only-package', '[SK-8]', { gateRun: 'yarn check --only dsh-plugin-desktop' })
  gateSample('o5-changed-ref', '[SK-8]', { gateRun: 'yarn check --changed origin/master' })
  gateSample('o6-check-fast-alias', '[SK-8]', { gateRun: 'yarn check:fast' })
  gateSample('o7-list-only', '[SK-8]', { gateRun: 'yarn check --list' })
  // 全量门禁整个消失(只剩单个守卫)也必须红。
  gateSample('o8-no-full-gate', '[SK-9]', { gateRun: 'yarn check:layout' })
  // 门禁 job 被 docs-only 判定跳过(= C-3 的原形态)。
  gateSample('o9-job-skipped-on-docs-only', '[SK-9]', {
    gateIf: "needs.changes.result != 'success' || needs.changes.outputs.code == 'true'",
  })
  // 永不跳过的守卫 job 不存在 / 它带 if: / 它带 needs: —— 都是"skipped 算成功"的形态。
  gateSample('o10-missing-guard-job', '[SK-9]', { guardJob: false })
  gateSample('o11-guard-job-with-if', '[SK-9]', { guardIf: '${{ !cancelled() }}' })
  gateSample('o12-guard-job-with-needs', '[SK-9]', { guardNeeds: 'changes' })
  // 守卫结果没有接进必需的 Gate 检查(少了 needs 或少了 exit 1 那一步)。
  gateSample('o13-no-link-step', '[SK-9]', { linkStep: false })
  gateSample('o14-gate-needs-without-guard-job', '[SK-9]', { gateNeeds: '[changes]' })
  // 两步条件不互补(`== 'true'` 而不是 `!= 'false'`)。
  gateSample('o15-step-not-failsafe', '[SK-9]', { gateStepIf: "needs.changes.outputs.code == 'true'" })
  // [SK-8b]:跑全量门禁的 job 必须拿到完整历史(C-4 的另一半)。
  gateSample('o16-no-fetch-depth', '[SK-8b]', { gateDepth: null })
  gateSample('o17-fetch-depth-1', '[SK-8b]', { gateDepth: '          fetch-depth: 1' })
  // 没有 docs-only 机制的 workflow 不受 [SK-9] 约束(没有跳过就没有缺口)。
  expectGreen('o18-no-docs-only-mechanism', [
    '      - run: yarn check:layout',
  ])

  // ---- 策略 8([SK-12]):WASM 门禁的两处接线(W-4 用例级报告 / W-5 协议探针) ----
  // 样本必须用 `file: 'ci.yml'` —— [SK-12] 只对本仓 CI 工作流生效(锚点理由见策略注释)。
  gateSample('r1-wasm-wiring-green', null, { file: 'ci.yml' })
  gateSample('r2-case-gate-missing', '[SK-12]', { file: 'ci.yml', wasmCaseGate: 'none' })
  gateSample('r3-case-gate-no-scope', '[SK-12]', { file: 'ci.yml', wasmCaseGate: 'no-scope' })
  gateSample('r4-case-gate-weakened-require', '[SK-12]', { file: 'ci.yml', wasmCaseGate: 'weakened-require' })
  gateSample('r5-case-gate-no-exit', '[SK-12]', { file: 'ci.yml', wasmCaseGate: 'no-exit' })
  gateSample('r6-case-gate-no-pg', '[SK-12]', { file: 'ci.yml', wasmCaseGate: 'no-pg' })
  gateSample('r7-case-gate-path-mismatch', '[SK-12]', { file: 'ci.yml', wasmCaseGate: 'path-mismatch' })
  gateSample('r8-probe-missing', '[SK-12]', { file: 'ci.yml', wasmProbe: 'none' })
  gateSample('r9-probe-no-require-covered', '[SK-12]', { file: 'ci.yml', wasmProbe: 'no-env' })
  gateSample('r10-probe-wrong-group', '[SK-12]', { file: 'ci.yml', wasmProbe: 'group1' })
  gateSample('r11-probe-narrow-if', '[SK-12]', { file: 'ci.yml', wasmProbe: 'narrow-if' })

  // ---- 策略 6([SK-10]):docs-only 分类器的规则逐条钉死 ----
  const CLASSIFIER_SHAPE = ({ cases, failsafes = 3, jobIf = '' } = {}) => [
    'name: selftest',
    'on: push',
    'jobs:',
    '  changes:',
    '    runs-on: ubuntu-latest',
    ...(jobIf === '' ? [] : [`    if: ${jobIf}`]),
    '    timeout-minutes: 5',
    '    outputs:',
    '      code: ${{ steps.scope.outputs.code }}',
    '    steps:',
    '      - id: scope',
    '        run: |',
    '          set -euo pipefail',
    ...(failsafes >= 1 ? [
      '          if [[ "${GITHUB_REF}" == refs/tags/* ]]; then',
      '            echo "code=true" >> "$GITHUB_OUTPUT"; exit 0',
      '          fi',
    ] : []),
    ...(failsafes >= 2 ? [
      '          if [[ -z "${BASE}" ]]; then',
      '            echo "code=true" >> "$GITHUB_OUTPUT"; exit 0',
      '          fi',
    ] : []),
    ...(failsafes >= 3 ? [
      '          if [[ -z "${CHANGED}" ]]; then',
      '            echo "code=true" >> "$GITHUB_OUTPUT"; exit 0',
      '          fi',
    ] : []),
    '          DOCS_ONLY=1',
    '          while IFS= read -r f; do',
    '            [[ -z "$f" ]] && continue',
    '            case "$f" in',
    ...cases,
    '            esac',
    '          done <<< "${CHANGED}"',
    '          if [[ "${DOCS_ONLY}" == "1" ]]; then',
    '            echo "code=false" >> "$GITHUB_OUTPUT"',
    '          else',
    '            echo "code=true" >> "$GITHUB_OUTPUT"',
    '          fi',
    '',
  ].join('\n')
  const GREEN_CASES = [
    '              docs/*|site/*) ;;',
    '              */*) DOCS_ONLY=0; break ;;',
    '              *.md) ;;',
    '              *) DOCS_ONLY=0; break ;;',
  ]
  expectGreen('q1-classifier-green', [], { raw: CLASSIFIER_SHAPE({ cases: GREEN_CASES }), file: 'selftest.yml' })
  expectRed('q2-classifier-widened', '[SK-10]', [], {
    raw: CLASSIFIER_SHAPE({ cases: ['              docs/*|site/*|*.md) ;;', '              *) DOCS_ONLY=0; break ;;'] }),
    file: 'selftest.yml',
  })
  expectRed('q3-classifier-reordered', '[SK-10]', [], {
    raw: CLASSIFIER_SHAPE({ cases: ['              *.md) ;;', '              docs/*|site/*) ;;', '              */*) DOCS_ONLY=0; break ;;', '              *) DOCS_ONLY=0; break ;;'] }),
    file: 'selftest.yml',
  })
  expectRed('q4-classifier-no-failsafe', '[SK-10]', [], {
    raw: CLASSIFIER_SHAPE({ cases: GREEN_CASES, failsafes: 1 }),
    file: 'selftest.yml',
  })
  expectRed('q5-classifier-job-with-if', '[SK-10]', [], {
    raw: CLASSIFIER_SHAPE({ cases: GREEN_CASES, jobIf: "github.event_name == 'pull_request'" }),
    file: 'selftest.yml',
  })

  // ---- 策略 7([SK-11]):发布面语义判据(策展说明位置 + gh release 参数) ----
  const RELEASE_SHAPE = ({
    releaseNotesStep = true,
    gateNotesStep = true,
    gateFirst = true,
    titleFlag = '--title "${TAG}"',
    notesFlag = '${NOTES_FLAG}',
  } = {}) => [
    'name: selftest',
    'on: push',
    'jobs:',
    '  gate:',
    '    runs-on: ubuntu-latest',
    '    timeout-minutes: 60',
    '    steps:',
    '      - uses: actions/checkout@v7',
    '        with:',
    '          fetch-depth: 0',
    ...(gateNotesStep && gateFirst ? [
      '      - name: Require curated release notes for stable tags',
      '        run: |',
      '          set -euo pipefail',
      '          test -f "docs/releases/${GITHUB_REF_NAME}.md" || {',
      '            echo "::error::missing curated notes"',
      '            exit 1',
      '          }',
    ] : []),
    '      - run: yarn check',
    ...wasmProbeLines('full'),
    ...(gateNotesStep && !gateFirst ? [
      '      - name: Require curated release notes for stable tags',
      '        run: |',
      '          set -euo pipefail',
      '          test -f "docs/releases/${GITHUB_REF_NAME}.md" || {',
      '            echo "::error::missing curated notes"',
      '            exit 1',
      '          }',
    ] : []),
    '  release:',
    '    runs-on: ubuntu-latest',
    '    timeout-minutes: 45',
    '    steps:',
    '      - uses: actions/checkout@v7',
    '        with:',
    '          fetch-depth: 0',
    ...(releaseNotesStep ? [
      '      - name: Require curated release notes before any upload',
      '        run: |',
      '          set -euo pipefail',
      '          test -f "docs/releases/${GITHUB_REF_NAME}.md" || {',
      '            echo "::error::missing curated notes"',
      '            exit 1',
      '          }',
    ] : []),
    '      - name: Upload every channel image to the update server (R2)',
    '        run: bash scripts/ci-publish-update-server.sh --list channels.list',
    '      - name: Create GitHub Release',
    '        run: |',
    '          set -euo pipefail',
    '          TAG="${GITHUB_REF_NAME}"',
    '          NOTES="docs/releases/${TAG}.md"',
    '          if [ -f "${NOTES}" ]; then',
    '            NOTES_FLAG="--notes-file ${NOTES}"',
    '          else',
    '            exit 1',
    '          fi',
    `          gh release create "\${TAG}" ${titleFlag} ${notesFlag}`,
    ...wasmCaseGateLines('full'),
    '',
  ].join('\n')
  const releaseSample = (id, expectation, options) => {
    const entry = { raw: RELEASE_SHAPE(options), file: 'selftest.yml' }
    return expectation === null ? expectGreen(id, [], entry) : expectRed(id, expectation, [], entry)
  }
  releaseSample('p1-release-green', null, {})
  // 等价写法必须放行(`--title="$TAG"` / `--title=${TAG}` 都是 tag 本身)。
  releaseSample('p2-title-equivalent-quoting', null, { titleFlag: '--title="$TAG"' })
  releaseSample('p3-title-unbraced', null, { titleFlag: '--title=${TAG}' })
  // 弱化/缺失形态必须红。
  releaseSample('p4-upload-before-notes', '[SK-11]', { releaseNotesStep: false })
  releaseSample('p5-title-commented-out', '[SK-11]', { titleFlag: '# --title "${TAG}"' })
  releaseSample('p6-no-notes-source', '[SK-11]', { notesFlag: '' })
  releaseSample('p7-early-check-after-gate', '[SK-11]', { gateFirst: false })
  releaseSample('p8-no-early-check', '[SK-11]', { gateNotesStep: false })
  // 自检自身的对账放在独立函数里(F3-4:看守守门人)——
  // 不能内联在 selfTestPolicies 体内:那样"把 selfTestPolicies 整条掏空"会连带
  // 把对账一起掏空(第三轮审计 m8 的形态)。这里只做数据收集,断言在
  // selfTestPoliciesCoverage() 里,由 main() **分别**调用。
  return { failures, observed }
}

/**
 * 自检样本的**覆盖对账**(2026-09-19 第三轮审计 F3-4:"自检自身被掏空无人察觉")。
 *
 * 与 selfTestPolicies 分开成两个导出函数,是这条护栏的关键:如果有人把
 * selfTestPolicies 改成恒返回 `{failures: [], observed: []}`,本函数会看到
 * `observed` 为空/不足 ⇒ 门禁立刻红,而不是"自检被掏空但门禁照常绿"。
 *
 * @param observed - selfTestPolicies 登记的样本(含 id / 期望策略标签 / 实际失败项)。
 * @returns 自检失败项列表(空 = 通过)。
 */
export function selfTestPoliciesCoverage(observed) {
  const failures = []
  const samples = Array.isArray(observed) ? observed : []
  const redSamples = samples.filter(entry => entry.policy !== null)
  const policyTag = failure => /\[(SK-\d+[a-z]?)\]/u.exec(failure.detail ?? '')?.[1] ?? ''
  const countTag = (entry, tag) => entry.failures.filter(failure => failure.detail.includes(tag)).length
  const expect = (ok, message) => {
    if (!ok) failures.push(message)
  }
  expect(samples.length >= SELFTEST_MIN_SAMPLES,
    `[self-test] 自检样本被掏空:实际只剩 ${observed.length} 个,至少要有 ${SELFTEST_MIN_SAMPLES} 个\n`
      + '  ⇒ 这道对账就是"看守守门人"的闸:没有它,把 selfTestPolicies 与 selfTestScanner '
      + '一起清空可以让门禁完全静默(第三轮审计 F3-4 / m8)。\n'
      + `  当前样本:${observed.map(entry => entry.id).join(', ')}`)
  expect(redSamples.length >= SELFTEST_MIN_RED_SAMPLES,
    `[self-test] 违规样本被删:红样本(必须被策略报出来的样本)只剩 ${redSamples.length} 个,`
      + `至少要有 ${SELFTEST_MIN_RED_SAMPLES} 个 ⇒ 有违规样本被删掉或改成合法形态了。`)
  const coveredPolicies = [...new Set(
    redSamples.flatMap(entry => entry.failures.map(policyTag)).filter(tag => tag !== ''),
  )].sort()
  expect(coveredPolicies.join(',') === SELFTEST_EXPECTED_POLICIES.join(','),
    `[self-test] 红样本覆盖的策略标签变了:实际 [${coveredPolicies.join(', ')}],`
      + `登记期望 [${SELFTEST_EXPECTED_POLICIES.join(', ')}] ⇒ 某条策略已经没有违规样本盯着它了`
      + '(或某个标签被改名,而断言没跟着改)。')
  const emptyRed = redSamples.filter(entry => countTag(entry, entry.policy) === 0)
  expect(emptyRed.length === 0,
    `[self-test] 有红样本实际上一条失败都没报出来:${emptyRed.map(entry => entry.id).join(', ')}`)
  // ---- 白名单死条目对账机制(F2-3 的"防豁免腐化"条件,必须自证)----
  //
  // 块级 errexit 白名单只允许"跑完再汇总"这类语义,而豁免最大的风险是**腐化**:
  // 某块后来补上了 guard,白名单那条却留着 ⇒ 变成可复用的豁免洞。生产路径的
  // 对账是 main() 的 `deadAllowlist = [...SWALLOW_ALLOWLIST, ...BLOCK_ERREXIT_ALLOWLIST]
  // .filter(entry => names.includes(entry.file) && !allowlistHits.includes(entry))`。
  // 这里用一个真实登记的 key 自证那条对账真的会因为"不再命中"而报出来:
  //   ① 去掉 guard ⇒ 该 key 必须**命中**(否则死条目对账永远不会触发);
  //   ② 加上 guard ⇒ 该 key 必须**不命中**(这正是死条目对账报错的条件)。
  // 用一个**真实登记**的块级条目做被测对象。块级 key 的形状是
  // `block-errexit:<job id>:<step 名>`,所以夹具必须复刻那个 job/step 名,
  // 否则测的不是同一条 (job, step) 对。
  const liveEntry = BLOCK_ERREXIT_ALLOWLIST[0]
  const liveParts = /^block-errexit:([^:]+):(.+)$/u.exec(liveEntry.key)
  if (liveEntry.file !== 'ci.yml' || liveParts === null) {
    failures.push('[allowlist] 块级 errexit 白名单的第一条形状变了(本自检按 '
      + '`block-errexit:<job>:<step>` 解析它)—— 要么恢复形状,要么同步改这条断言')
  } else {
    const [, liveJob, liveStep] = liveParts
    const blockFixture = run => [
      `      - name: ${liveStep}`,
      '        if: always()',
      '        run: |',
      ...(run ? ['          set -euo pipefail'] : []),
      '          mkdir -p packages/host/desktop/e2e-results',
    ]
    // 夹具的 job 名必须与 key 里的 job 一致 —— 用替换 label 的方式生成。
    const inJob = steps => selftestWorkflow(steps).replace('jobs:\n  verify:', `jobs:\n  ${liveJob}:`)
    const unguarded = checkWorkflowText(liveEntry.file, inJob(blockFixture(false)))
    expect(unguarded.allowlistHits.some(entry => entry.key === liveEntry.key),
      '[allowlist] 去掉 guard 的块没有命中已登记的白名单条目 ⇒ 死条目对账永远不会触发,'
        + '豁免会腐化成"整类语句豁免"')
    const guarded = checkWorkflowText(liveEntry.file, inJob(blockFixture(true)))
    expect(!guarded.allowlistHits.some(entry => entry.key === liveEntry.key),
      '[allowlist] 已经补上 guard 的块仍然命中白名单 ⇒ main() 的死条目对账会漏报这个豁免洞'
        + '(白名单加回 guard 后必须自己红,否则豁免会永久留着)')
  }

  // 样本 id 必须唯一(复制粘贴样本会让"数量对账"用重复项凑数)。
  const ids = samples.map(entry => entry.id)
  expect(new Set(ids).size === ids.length,
    `[self-test] 自检样本 id 有重复:${ids.filter((id, i) => ids.indexOf(id) !== i).join(', ')}`
      + ' ⇒ 数量对账会被重复项凑出来,覆盖对账失去意义。')
  return failures
}

/**
 * 致命路径自检(2026-09-19 第三轮审计 F2-1):**门禁自己崩掉时不能吞掉诊断**。
 *
 * 背景(本批新引入的 bug):`checkWorkflowText` 有三条 early return 只返回
 * `{failures, checked}`,而 `main()` 无条件 `notes.push(...result.notes)` ⇒
 * `TypeError: result.notes is not iterable`,**已收集的 failures 一条都打不出来**。
 * 触发条件都是真实场景:任何 YAML 笔误、缺 `jobs:`、或新增一个只调 reusable workflow
 * 的 job(那个文件解析出 0 个 run 块)。
 *
 * 这条自检的判据是**输出的形状**,不是"某个函数返回了什么":
 *   ① 四个致命样本都必须有失败项(不能静默通过);
 *   ② 每个失败项都要有非空 `detail`(否则打印出来是一行空白,等于没诊断);
 *   ③ 返回对象必须有 `notes` / `allowlistHits` / `goTestTimeoutHits` 三个可迭代字段
 *      —— 少一个,`main()` 就会在解构处抛 TypeError 并吞掉整批 failures;
 *   ④ 每个样本的 detail 里必须出现**可操作的信息**(文件名 / 行号 / 原因关键词):
 *      "有 N 项未通过"这种汇总不算诊断。
 *
 * 为什么放在本文件而不是测试脚本里:①与另两个自检同一理由 —— 失效形态是"静默吞掉
 * 诊断",必须每次运行都被检查;②它跑的是纯函数,不需要起子进程。
 *
 * 变异验证:把任一 `workflowResult(failures)` 改回 `{ failures, checked: 0 }` ⇒ ③ 红;
 * 把 fatal 样本的 detail 清空 ⇒ ② 红;把三个 early return 删掉改成 `continue` ⇒ ① 红。
 *
 * @returns 自检失败项列表(空 = 通过)。
 */
export function selfTestFatalPaths() {
  const failures = []
  /** 实际执行的断言条数(供 main() 做"自检没被掏空"的对账)。 */
  let assertions = 0
  const samples = [
    {
      id: 'yaml-parse-error',
      text: 'name: bad\non: push\njobs:\n  a: [\n',
      // 解析失败必须点名**文件:行 + 原因**(不是"有 1 项未通过")。
      mustMatch: /YAML 解析失败/u,
    },
    {
      id: 'missing-jobs-map',
      text: 'name: nojobs\non: push\n',
      mustMatch: /顶层缺少 jobs/u,
    },
    {
      id: 'no-run-blocks',
      text: 'name: shellless\non: push\njobs:\n  verify:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v7\n',
      mustMatch: /未解析出任何 run 块|扫描器/u,
    },
    {
      id: 'reusable-only-job',
      text: 'name: reusable\non: push\njobs:\n  call:\n    uses: ./.github/workflows/ci.yml\n',
      mustMatch: /reusable workflow/u,
    },
  ]
  const covered = []
  for (const sample of samples) {
    const result = checkWorkflowText(`${sample.id}.yml`, sample.text)
    covered.push(sample.id)
    assertions += 1
    // ③ 形状恒定:三个字段必须存在且可迭代(main() 的解构点)。
    if (!Array.isArray(result.notes) || !Array.isArray(result.allowlistHits)
      || typeof result.goTestTimeoutHits !== 'number') {
      failures.push(`[fatal-paths] 样本 ${sample.id}:返回形状不完整`
        + `(notes=${Array.isArray(result.notes) ? 'ok' : typeof result.notes},`
        + ` allowlistHits=${Array.isArray(result.allowlistHits) ? 'ok' : typeof result.allowlistHits},`
        + ` goTestTimeoutHits=${typeof result.goTestTimeoutHits})`
        + ' ⇒ main() 会在解构处抛 TypeError 并**吞掉整批 failures**(F2-1)')
    }
    // ① 致命样本不能静默通过。
    if (!Array.isArray(result.failures) || result.failures.length === 0) {
      failures.push(`[fatal-paths] 样本 ${sample.id} 没有任何失败项 —— 门禁对这个形态静默通过`)
      continue
    }
    // ② 每个失败项都要有非空 detail。
    const empty = result.failures.filter(f => typeof f.detail !== 'string' || f.detail.trim() === '')
    if (empty.length > 0) {
      failures.push(`[fatal-paths] 样本 ${sample.id} 有 ${empty.length} 条失败但 detail 为空`
        + ' ⇒ 打印出来只有一行空白,PR 上等于没有诊断')
    }
    // ④ 必须点名可操作的信息(原因关键词)。
    if (!result.failures.some(f => sample.mustMatch.test(f.detail ?? ''))) {
      failures.push(`[fatal-paths] 样本 ${sample.id} 的失败信息里没有可操作的原因`
        + `(期望匹配 ${sample.mustMatch});实际:`
        + result.failures.map(f => (f.detail ?? '').split('\n')[0]).join(' | '))
    }
  }
  assertions += 1
  const missing = SELFTEST_EXPECTED_FATAL_PATHS.filter(id => !covered.includes(id))
  if (missing.length > 0) {
    failures.push(`[fatal-paths] 致命路径自检本身被掏空:少了 ${missing.join(', ')}`
      + '(F2-1 的现场就是"门禁崩了却只剩一段 Node 栈")')
  }
  assertions += 1
  if (assertions < SELFTEST_FATAL_PATH_ASSERTIONS) {
    failures.push(`[fatal-paths] 自检只执行了 ${assertions} 条断言(期望 ≥ ${SELFTEST_FATAL_PATH_ASSERTIONS})`)
  }
  return { failures, assertions }
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
  // 覆盖计数(F3-4):本自检"被掏空成 return []"时,只有断言数能证明它真的跑过。
  let assertions = 0
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
  assertions += 1
  if (broken === undefined) {
    failures.push('compact 单行形态(`      - run: <cmd>`)没有被抽出 —— 这正是静默跳过的形态')
  } else if (parseShell(broken.content, 'selftest.run.sh') === null) {
    failures.push('compact step 里未闭合的引号没有被 bash -n 抓到(门禁对这批 step 形同不存在)')
  }
  assertions += 1
  if (!contents.some(content => content.includes('echo block-ok'))) {
    failures.push('compact 块标量形态(`      - run: |`)没有被抽出')
  }
  assertions += 1
  if (!contents.includes('echo compact-ok')) {
    failures.push('普通内联 `run:`(缩进 8)没有被抽出')
  }

  const document = parseYaml(sample)
  assertions += 1
  if (uncheckedShellSteps(document, blocks).length !== 0) {
    failures.push(`自检样本里仍有未被检查的 shell 步骤: ${uncheckedShellSteps(document, blocks).join(', ')}`)
  }
  const missingCompact = blocks.filter(block => !block.content.includes('echo "未闭合引号') && !block.content.includes('echo 又一个 compact'))
  const detected = uncheckedShellSteps(document, missingCompact)
  assertions += 1
  if (detected.length !== 2) {
    failures.push(`覆盖率对账没有发现被漏抽的 2 个 compact step(实际报出 ${detected.length} 个)`
      + ' —— 那条 fail-loud 只是摆设,漏抽仍会静默通过')
  }
  return { failures, assertions }
}

function main() {
  const names = readdirSync(workflowDirectory)
    .filter(entry => entry.endsWith('.yml') || entry.endsWith('.yaml'))
    .sort()
  if (names.length === 0) {
    process.stderr.write('check-workflows: .github/workflows 下没有找到任何 workflow\n')
    process.exit(1)
  }

  // ===== `--workflows-dir=` 的自证(2026-09-19 第三轮审计 F3-3)=====
  //
  // 这个开关是**变异验证/本地回归**的测试缝(把 workflow 副本放进临时目录),但它此前
  // 没有任何自证:带参数跑只扫指定目录,却打印与真实仓一模一样的 `OK — N 个 workflow…`,
  // 而且 SWALLOW_ALLOWLIST 的死条目对账按"被扫到的文件名"过滤 ⇒ 指向临时目录时那条
  // 对账**连带被静默关掉**。风险场景很具体:有人把 `--workflows-dir` 加进 yarn check /
  // CI(或复制粘贴进别的守卫),整个仓的 workflow 就再没被扫过,而输出依然说 OK。
  //
  // 处置:**不禁止**这个开关(变异验证必须能用),但把它降级成"明显不是全仓门禁"的形态:
  //   ① 每次带参数运行都 fail-loud?不行 —— 变异验证需要它成功返回 0/1 以便断言。
  //   ② 所以改成:stderr 打一条不可忽略的 WARNING,列明"哪些检查被关掉了";
  //   ③ 并且**把被关掉的白名单对账补回来**:对白名单登记的每个文件,如果它不在被扫
  //      目录里,就点名说"这条豁免本次未被核对"(而不是静默跳过)。
  // 判据(自检里钉住):带 `--workflows-dir` 时 stderr 必须出现 WARNING;不带时必须没有。
  const isDefaultDirectory = workflowDirectory === join(root, '.github', 'workflows')
  const outsideAllowlistFiles = SWALLOW_ALLOWLIST
    .map(entry => entry.file)
    .filter((file, index, all) => all.indexOf(file) === index)
    .filter(file => !names.includes(file))

  const failures = []
  const scannerSelftest = selfTestScanner()
  if (!Array.isArray(scannerSelftest?.failures) || typeof scannerSelftest?.assertions !== 'number') {
    failures.push({
      name: '[scanner-selftest]',
      line: 0,
      detail: 'selfTestScanner() 的返回形状不对(需要 {failures, assertions}) —— 自检被改坏了'
        + '(F2-1 的同一类形状问题:自检崩掉不能反过来吞掉门禁的诊断)',
    })
  } else {
    for (const detail of scannerSelftest.failures) {
      failures.push({ name: '[scanner-selftest]', line: 0, detail })
    }
    // 覆盖下限(F3-4):`return []` 掏空形状上是对的,只有"断言条数"能证伪。
    if (scannerSelftest.assertions < SELFTEST_SCANNER_ASSERTIONS) {
      failures.push({
        name: '[scanner-selftest]',
        line: 0,
        detail: `扫描器自检只执行了 ${scannerSelftest.assertions} 条断言(期望 ≥ ${SELFTEST_SCANNER_ASSERTIONS})`
          + ' ⇒ 自检被掏空(把 selfTestScanner 改成 `return []` 这类改法形状上检查不出来)。',
      })
    }
  }
  // SK-7 三条策略的自检:合成违规样本必须红、安全形态必须绿(策略失效 ⇒ 门禁自己红)。
  // 覆盖对账**单独**调用(F3-4):selfTestPolicies 被掏空时它会看见 observed 为空 ⇒ 红。
  //
  // 形状兜底(F2-1 的同一类 bug,第二次现场):`selfTestPolicies` 被改成返回 `[]`
  // (而不是 `{failures, observed}`)时,下面两行会抛 `TypeError: … is not iterable`,
  // **把已收集的 failures 全部吞掉**。自检的返回值先过形状检查,坏形状 = 一条可读的
  // 失败项,而不是一段 Node 栈。
  const policySelftest = selfTestPolicies()
  if (!Array.isArray(policySelftest?.failures) || !Array.isArray(policySelftest?.observed)) {
    failures.push({
      name: '[policy-selftest]',
      line: 0,
      detail: 'selfTestPolicies() 的返回形状不对(需要 {failures, observed} 两个数组)'
        + ` —— 实际 failures=${Array.isArray(policySelftest?.failures) ? '数组' : typeof policySelftest?.failures}`
        + ` / observed=${Array.isArray(policySelftest?.observed) ? '数组' : typeof policySelftest?.observed}`
        + '\n  ⇒ 自检被改坏(或整条被掏空成 `return []`)。这里**不抛 TypeError**:'
        + '门禁自己的诊断绝不能被自己的崩溃吞掉(F2-1 的同一类 bug)。',
    })
  } else {
    for (const detail of policySelftest.failures) {
      failures.push({ name: '[policy-selftest]', line: 0, detail })
    }
    for (const detail of selfTestPoliciesCoverage(policySelftest.observed)) {
      failures.push({ name: '[self-test-coverage]', line: 0, detail })
    }
  }
  // 致命路径自检(F2-1):门禁自己崩掉时也必须打印诊断,不能只剩 Node 栈。
  const fatalPathsSelftest = selfTestFatalPaths()
  if (!Array.isArray(fatalPathsSelftest?.failures) || typeof fatalPathsSelftest?.assertions !== 'number') {
    failures.push({
      name: '[fatal-paths-selftest]',
      line: 0,
      detail: 'selfTestFatalPaths() 的返回形状不对(需要 {failures, assertions}) —— 自检被改坏了'
        + '(F2-1 的同一类形状问题)',
    })
  } else {
    for (const detail of fatalPathsSelftest.failures) {
      failures.push({ name: '[fatal-paths-selftest]', line: 0, detail })
    }
    if (fatalPathsSelftest.assertions < SELFTEST_FATAL_PATH_ASSERTIONS) {
      failures.push({
        name: '[fatal-paths-selftest]',
        line: 0,
        detail: `致命路径自检只执行了 ${fatalPathsSelftest.assertions} 条断言`
          + `(期望 ≥ ${SELFTEST_FATAL_PATH_ASSERTIONS}) ⇒ 自检被掏空。`,
      })
    }
  }
  let total = 0
  const notes = []
  const allowlistHits = []
  let goTestTimeoutHits = 0
  for (const name of names) {
    const result = checkWorkflow(name)
    // `?? []` 兜底(2026-09-19 第三轮审计 F2-1):将来若有人再加一条忘了统一形状的
    // early return,这里少一行 note,而**不会**因为 TypeError 把已收集的 failures 吞掉。
    failures.push(...result.failures)
    total += result.checked
    notes.push(...(result.notes ?? []))
    allowlistHits.push(...(result.allowlistHits ?? []))
    goTestTimeoutHits += result.goTestTimeoutHits ?? 0
  }

  // 白名单死条目对账:登记了却不再命中任何语句的条目必须清掉 —— 否则白名单会悄悄
  // 长成一个"谁都能往里塞一句"的豁免洞(与本脚本"不许整个文件豁免"的口径配套)。
  const deadAllowlist = [...SWALLOW_ALLOWLIST, ...BLOCK_ERREXIT_ALLOWLIST].filter(
    entry => names.includes(entry.file) && !allowlistHits.includes(entry),
  )
  if (deadAllowlist.length > 0) {
    failures.push({
      name: '[allowlist]',
      line: 0,
      detail: `SWALLOW_ALLOWLIST 有 ${deadAllowlist.length} 条**死条目**(不再命中任何真实语句):\n`
        + deadAllowlist.map(entry => `  - ${entry.file}: ${entry.signature ?? entry.key}`).join('\n')
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
  // 全仓存在性对账在"只扫一个临时目录"时是**没有意义**的(那个目录里本来就可能没有
  // go test),所以改口径:被扫目录里一个 `go test` 都没有时,必须说清这是"本次没扫到"
  // 而不是"通过" —— 否则 --workflows-dir 会让人误以为那条对账绿了。
  if (goTestTimeoutHits === 0 && !isDefaultDirectory) {
    process.stderr.write('check-workflows: WARNING — 本次是对临时目录跑变异验证且没有扫到任何 `go test -timeout`;\n'
      + '  「全仓至少一处单包预算」这条存在性对账本次**未生效**,不能当作该策略已通过。\n')
  }

  // `--workflows-dir` 的显式降级声明(F3-3):带参数 ⇒ 这不是全仓门禁。
  if (!isDefaultDirectory) {
    process.stderr.write(`check-workflows: WARNING — 正在检查**非默认目录**(${workflowDirectory}),这不是全仓门禁:\n`)
    process.stderr.write('  - 只扫描该目录下的 workflow,仓库 .github/workflows 本次**完全没有被扫**;\n')
    if (outsideAllowlistFiles.length > 0) {
      process.stderr.write(`  - SWALLOW_ALLOWLIST 的死条目对账被关掉了:${outsideAllowlistFiles.join(', ')} `
        + `不在被扫目录里 ⇒ 这 ${outsideAllowlistFiles.length} 个文件的豁免本次未被核对;\n`)
    }
    process.stderr.write('  - CI 与 `yarn check` 一律不带这个参数;要跑全仓门禁请直接 `node scripts/check-workflows.mjs`。\n')
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
    process.stdout.write(`check-workflows: [SK-7] 白名单命中 ${allowlistHits.length} 条(逐条登记,含理由):\n`)
    for (const entry of allowlistHits) {
      const scope = entry.signature === undefined ? '块级 errexit' : '语句级吞码'
      process.stdout.write(`  - ${entry.file}(${scope}): ${entry.signature ?? entry.key}\n`)
    }
  }
  process.stdout.write(`check-workflows: OK — ${names.length} 个 workflow,${total} 个 shell run 块全部通过 `
    + 'bash -n + SK-7 策略(吞码 / go test 超时序 / 单行退出码 / 块标量退出语义)'
    + ' + SK-8/SK-8b/SK-9/SK-10/SK-11/SK-12 策略(根门禁调用形态 / 跑门禁的 job 必须完整历史 /\n'
    + '    docs-only 不得跳过根守卫 / 分类器规则钉死 / 发布面语义判据 / WASM 门禁接线)\n')
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main()
}
