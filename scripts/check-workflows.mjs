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
 * 2026-09-23 第四轮审计 R4-A 之后再补两条(现场与登记值见各自策略的注释):
 *   [SK-13] **触发面(`on:)的业务契约** —— 此前全文对 `on:` 零判据:删掉 `push:` 会让
 *           tag push 不再触发整条发布链,而 PR 检查仍然全绿(引入改动的 PR 自己能合)。
 *   [SK-14] **被钉住的判据步骤必须可执行** —— 给步骤加一行 `if: false`(`run` 一字不改)
 *           即可让整套 Go 测试 / 守卫结果链路静默不跑,而 SK-8/SK-9/SK-12 只问"文本在不在"。
 *
 * 2026-09-25 第九轮审计 D/B 泳道再补两条(同一面的两个方向:放走恶意形态 + 误伤合法写法):
 *   [SK-17] **进程环境层** —— `env:` 不是 `if:`/argv/`shell:`/步骤体,[SK-14] 的四条判据都
 *           读不到它。给"永不跳过"的 `gate-guards` 加一行
 *           `NODE_OPTIONS: "--import=data:text/javascript,process.on('exit',()=>{process.exitCode=0})"`
 *           (或 `BASH_ENV: ./.github/shell-hooks.sh`)就能让 16 个根守卫**零执行**而门禁 EXIT=0。
 *           现在三层 `env:`(workflow / job / step)与 `$GITHUB_ENV`/`$GITHUB_PATH` 的**键名**
 *           一起判:被钉步骤/根守卫 job 上不得出现改写解释器行为的键。
 *   [SK-14⑦/⑧ + SK-15] **命令位与整串判据** —— "文本里出现某串"不等于"它被执行":
 *           `: scripts/check-root-guards.mjs` / `test -f …` / `echo "node …"` 三行 no-op 让
 *           守卫零执行;`shell: bash -c 'exit 0' {0}` 让脚本体从不执行;发布链 `require` 的
 *           子串匹配让 R2 上传步 `echo` 化后照样"命中登记"。三者改成命令位/整串判据。
 *           同批收掉第八轮新引入的三条**假红**(子 shell 收尾 / 重定向当参数 / env 说明文本)。
 *
 * 2026-09-25 第十四轮现场再补一条(判据与现场说明见 [SK-22] 的常量区):
 *   [SK-22] **表达式的词法字符集** —— 一个 `run: |` 块的 **shell 注释**里写了
 *           `${{ …outputs.interp }}`(U+2026 省略号):YAML 合法、`bash -n` 合法(那行就是注释)、
 *           本文件此前所有判据都看不见它,而推上 GitHub 后**整条 CI 零 job**
 *           (run 0 秒 / 0 job 的 startup_failure,`pull_request` 下连 run 都不创建)。
 *           判据按**全文**(含 `#` 注释行、heredoc、字符串)扫 `${{ … }}`,剥掉 `'…'`
 *           单引号字面量后剩字符必须落在表达式词法器允许的集合里;未闭合 / 空表达式同样红。
 *
 * 用法:node scripts/check-workflows.mjs
 * 退出码:0 = 全部通过;1 = 有块解析失败、策略违规或扫描器退化。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
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
/** `shell: <名字>` —— 取**整值**(第九轮审计 B 泳道 P1-3:只看第一个词会让 `bash -c 'exit 0' {0}` 与 `bash` 等价)。 */
const SHELL_KEY = /^(\s*)shell:\s*(\S.*?)\s*$/u
/** `defaults:`(job 级 / workflow 级):只有它下面的 `shell:` 才是默认 shell(R8-D-24)。 */
const DEFAULTS_KEY = /^(\s*)defaults:\s*$/u
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
  // `defaults:` 的缩进(`null` = 本 job 没写 `defaults:`)—— 只有它下面的 `shell:`
  // 才是 job 级默认(第八轮审计 D-24)。
  let jobDefaultsIndent
  let currentJob

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]

    const jobMatch = JOB_KEY.exec(line)
    if (jobMatch !== null) {
      currentJob = jobMatch[1]
      jobDefaultShell = undefined
      jobDefaultsIndent = undefined
    }
    // `defaults:`(job 级 4 空格 / workflow 级 0 空格)开启"默认 shell 可被声明"的窗口。
    const defaultsMatch = DEFAULTS_KEY.exec(line)
    if (defaultsMatch !== null) {
      jobDefaultsIndent = defaultsMatch[1].length
      jobDefaultShell = undefined
      continue
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

    // job 级默认 shell:`defaults.run.shell` —— **必须真的在 `defaults:` 之下**。
    //
    // 第八轮审计 D-24 的现场:旧判据只按缩进区间(8–12)认,而 **step 级 `shell:` 的缩进
    // 正好也是 8** ⇒ 一个步骤声明的 `shell: python` 会被当成该 job 的默认 shell,
    // **泄漏给这个 job 里后面所有块** ⇒ 它们被当非 POSIX、`bash -n` 与 [SK-14] 的覆盖
    // 整段失效(全绿)。现在改成"先看见 `defaults:` 才算数"。
    const shellMatch = SHELL_KEY.exec(line)
    if (shellMatch !== null) {
      const indent = shellMatch[1].length
      if (jobDefaultsIndent !== undefined && indent > jobDefaultsIndent) {
        jobDefaultShell = normalizeShellValue(shellMatch[2])
      }
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
    if (match !== null && match[1].length === runIndent) return normalizeShellValue(match[2])
  }
  return fallback ?? 'bash'
}

/**
 * `shell:` 的取值归一:去 YAML 注释、去包裹引号、折叠空白。
 *
 * 为什么必须有它(第九轮审计 B 泳道 P1-3):`SHELL_KEY` 现在取**整值**,所以
 * `shell: bash -e {0}   # 官方模板` 这种写法会连注释一起进来 —— 归一后两条口径
 * (`extractRunBlocks` 的块级解析 vs YAML 解析出的 `step.shell`)才逐字可比。
 * @param value - `shell:` 后面的原文。
 * @returns 归一后的整串取值。
 */
function normalizeShellValue(value) {
  const text = typeof value === 'string' ? value : ''
  return text
    .replace(/\s+#.*$/u, '')
    .trim()
    .replace(/^["'](.*)["']$/u, '$1')
    .replace(/\s+/gu, ' ')
    .trim()
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
  // `scannedFile` 是给"只对**真实的那份** workflow 有意义"的判据用的测试缝
  // （第十二轮红队的 [SK-14⑨]/[SK-14⑩]：它们点名的 job/step 名属于 ci.yml，
  // 自检的合成样本不可能满足 —— 那种判据不该在样本上判，否则自检全是假红）。
  // `--workflows-dir` 的变异副本走的是同一条函数 ⇒ 变异验证照常有效。
  return checkWorkflowText(name, readFileSync(join(workflowDirectory, name), 'utf8'), { scannedFile: name })
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
/**
 * 自检合成的"被钉 job"用的 `runs-on` —— **必须与真 ci.yml / `PINNED_JOB_RUNS_ON_REGISTRY` 同值**。
 *
 * 为什么把取值抽出来:合成样本是"与 ci.yml 同形"的绿样本,写 `ubuntu-latest` 会让新加的
 * `runs-on` 登记判据在自检里当场假红(门禁自己把自己的绿样本判红 ⇒ 白名单会被逼着放大)。
 * 想改这个值必须**同时**改 `PINNED_JOB_RUNS_ON_REGISTRY`(那才是"可评审的 diff")。
 */
const GATE_SELFTEST_RUNS_ON = 'ubuntu-24.04'
/**
 * 自检合成样本的 `runs-on` 登记项（只作用于 `selftestWorkflow()` / `sk15Workflow()` 造的
 * job `verify`）。与 `SK15_SELFTEST_REGISTRY` 同一手法：样本需要"合成树里的 job 名"也能被
 * 登记制认出，否则"登记后确实变绿"那一格构造不出来。
 */
const SELFTEST_RUNS_ON_REGISTRY = {
  jobRunsOn: [{ job: 'verify', runsOn: GATE_SELFTEST_RUNS_ON, why: '自检合成样本:`selftestWorkflow()` 造的 job 名' }],
}
const SELFTEST_EXPECTED_POLICIES = ['SK-10', 'SK-11', 'SK-12', 'SK-13', 'SK-14', 'SK-15', 'SK-16', 'SK-17', 'SK-18', 'SK-19', 'SK-22', 'SK-7', 'SK-7a', 'SK-7b', 'SK-7c', 'SK-8', 'SK-8b', 'SK-9']

/**
 * **定向样本存在性登记**(2026-09-24 第七轮独立复审 V2 §1.2/§2.2 之后补)。
 *
 * 为什么需要:数量对账(`SELFTEST_MIN_SAMPLES` / `SELFTEST_MIN_RED_SAMPLES`)与策略标签对账
 * (`SELFTEST_EXPECTED_POLICIES`)只能证明"**某条**策略还有样本盯着",证明不了"**这一批
 * 绕过形态**的样本还在" —— 把 u29–u44 整段删掉,SK-14 仍被 u17–u28 覆盖,两道对账都照样绿,
 * 而那批形态正是复审实测能静默摘除"守卫失败 ⇒ 必需 Gate 红"唯一链路的写法。
 * 这张表按 `id + 期望策略标签` 逐条点名(与 `SELFTEST_EXPECTED_FATAL_PATHS` 同一手法)。
 */
const SELFTEST_REQUIRED_SAMPLES = [
  { id: 'u29-guard-link-case-branch-zero', policy: '[SK-14]' },
  { id: 'u30-guard-link-case-inline-zero', policy: '[SK-14]' },
  { id: 'u31-guard-link-time-prefixed-zero', policy: '[SK-14]' },
  { id: 'u32-guard-link-command-prefixed-zero', policy: '[SK-14]' },
  { id: 'u33-guard-link-builtin-prefixed-zero', policy: '[SK-14]' },
  { id: 'u34-guard-link-backslash-escaped-zero', policy: '[SK-14]' },
  { id: 'u35-guard-link-continuation-split-word', policy: '[SK-14]' },
  { id: 'u36-guard-link-function-wrapped-zero', policy: '[SK-14]' },
  { id: 'u37-guard-link-trap-action-zero', policy: '[SK-14]' },
  { id: 'u38-guard-link-exec-replaces-shell', policy: '[SK-14]' },
  { id: 'u39-guard-link-or-always-true', policy: '[SK-14]' },
  { id: 'u40-guard-link-or-echo-tail', policy: '[SK-14]' },
  { id: 'u41-guard-link-eval-action-zero', policy: '[SK-14]' },
  { id: 'u42-guard-link-exit-function-shadow', policy: '[SK-14]' },
  { id: 'u43-guard-link-quote-split-word', policy: '[SK-14]' },
  { id: 'u44-guard-link-quote-split-empty', policy: '[SK-14]' },
  { id: 'u45-guard-link-case-without-exit-green', policy: null },
  { id: 'u46-guard-link-quoted-exit-text-green', policy: null },
  { id: 'u47-guard-link-command-v-or-exit-green', policy: null },
  { id: 'u48-guard-link-trap-cleanup-green', policy: null },
  { id: 'u49-guard-link-exec-redirect-green', policy: null },
  { id: 'u50-guard-link-quoted-exit-argument-green', policy: null },
  { id: 'u51-guard-runner-commented-out', policy: '[SK-9]' },
  { id: 'u52-guard-link-exit-commented-out', policy: '[SK-9]' },
  { id: 'u53-guard-link-heredoc-terminator', policy: '[SK-14]' },
  { id: 'u54-guard-link-source-herestring', policy: '[SK-14]' },
  { id: 'u55-guard-link-heredoc-message-green', policy: null },
  { id: 'u56-guard-link-source-script-green', policy: null },
  { id: 'u57-guard-runner-list-arg', policy: '[SK-14]' },
  { id: 'u58-guard-link-function-definition-tail', policy: '[SK-14]' },
  { id: 'u59-guard-link-shell-python', policy: '[SK-14]' },
  { id: 'u60-guard-link-brace-group-tail-green', policy: null },
  { id: 'u61-guard-link-explicit-bash-green', policy: null },
  { id: 'u62-step-shell-does-not-leak-green', policy: null },
  { id: 'u63-guard-link-exit-function-keyword', policy: '[SK-14]' },
  { id: 'v9-guard-step-concat-flag', policy: '[SK-16]' },
  { id: 'v10-workflow-env-without-guard-invocation', policy: '[SK-16]' },
  { id: 'v5-workflow-env-advisory-opt-in', policy: '[SK-16]' },
  { id: 'v6-github-env-split-literal', policy: '[SK-16]' },
  { id: 'v7-github-env-dynamic-injection', policy: '[SK-16]' },
  { id: 'v8-workflow-env-unrelated-green', policy: null },
  // ---- [SK-17] 进程环境层(2026-09-25 第九轮审计 D 泳道 P1)----
  // 形态 A/B 的最小复现文本 + 同族键 + 三处 `env:` 位置 + `$GITHUB_ENV`/`$GITHUB_PATH`,
  // 以及两条**必须保持绿**的对照(合法 env / 非判据步骤上的 NODE_OPTIONS)。
  { id: 'w1-node-options-guard-job-env', policy: '[SK-17]' },
  { id: 'w2-bash-env-guard-step-env', policy: '[SK-17]' },
  { id: 'w3-node-options-workflow-env', policy: '[SK-17]' },
  { id: 'w4-github-env-node-options', policy: '[SK-17]' },
  { id: 'w5-bash-func-guard-step-env', policy: '[SK-17]' },
  { id: 'w6-github-path-append', policy: '[SK-17]' },
  { id: 'w7-pinned-link-step-shellopts', policy: '[SK-17]' },
  { id: 'w8-pinned-full-gate-node-options', policy: '[SK-17]' },
  { id: 'w9-guard-env-key-case-variant', policy: '[SK-17]' },
  { id: 'w10-guard-env-legit-keys-green', policy: null },
  { id: 'w11-unpinned-step-node-options-green', policy: null },
  { id: 'w12-unpinned-github-path-green', policy: null },
  // ---- [SK-17] 第十轮审计 C-01/C-02/C-03/D-03 的四层/四通道补样本 ----
  // 白名单(U-1:未登记即红,含 COREPACK_HOME 这条**已端到端实跑**的解释器替换通道)、
  // 第四层 `container.env`、被钉步骤体内的 `export`/前缀赋值、`uses:` 委派目标。
  { id: 'w13-guard-job-unregistered-env-key', policy: '[SK-17]' },
  { id: 'w14-container-image-unregistered', policy: '[SK-17]' },
  { id: 'w14b-container-env-node-options', policy: '[SK-17]' },
  { id: 'w15-step-body-export-node-options', policy: '[SK-17]' },
  { id: 'w16-step-body-prefix-assignment', policy: '[SK-17]' },
  { id: 'w17-step-body-registered-assignment-green', policy: null },
  { id: 'w18-github-env-unregistered-key', policy: '[SK-17]' },
  { id: 'w19-guard-job-unregistered-uses', policy: '[SK-17]' },
  // ---- 第十一轮复审 J1 的 N2:被钉步骤体里**清除**环境变量(`unset` / `env -u`) ----
  // 旧判据面只认 `export`/前缀赋值(写入),`unset CI GITHUB_ACTIONS` 一个字都不报 ——
  // 而它正是把"CI 硬判据"降级成"本地告警"的那一行(审计方实测 gpi EXIT 1→0)。
  { id: 'w24-step-body-unset-ci', policy: '[SK-17]' },
  { id: 'w25-step-body-env-unset-ci', policy: '[SK-17]' },
  { id: 'w26-unpinned-step-unset-green', policy: null },
  // ---- 第十一轮审计 C2-A-01/A-02:发布正文来源(策展文件的可证明性)----
  { id: 'p12-notes-command-substitution', policy: '[SK-11]' },
  { id: 'p13-notes-file-unprovable-var', policy: '[SK-11]' },
  { id: 'p14-notes-file-outside-curated-dir', policy: '[SK-11]' },
  { id: 'p15-notes-inline-literal-text', policy: '[SK-11]' },
  { id: 'p16-notes-short-flag-green', policy: null },
  { id: 'p17-notes-cat-curated-green', policy: null },
  { id: 'p18-gh-api-release-body', policy: '[SK-11]' },
  { id: 'p19-gh-release-command-in-array', policy: '[SK-11]' },
  // ---- 第十一轮审计 P1-3 / P2-1:`with:` 输入与 `runs-on`(8 条 with 变异 + 取值 + 非映射 + 3 条 runs-on + 2 绿样本)
  { id: 'wa1-with-checkout-repository', policy: '[SK-17]' },
  { id: 'wa2-with-checkout-ref', policy: '[SK-17]' },
  { id: 'wa3-with-checkout-token', policy: '[SK-17]' },
  { id: 'wa4-with-checkout-sparse', policy: '[SK-17]' },
  { id: 'wa5-with-setup-node-major', policy: '[SK-17]' },
  { id: 'wa6-with-setup-node-file', policy: '[SK-17]' },
  { id: 'wa7-with-setup-node-corepack', policy: '[SK-17]' },
  { id: 'wa8-with-cache-key', policy: '[SK-17]' },
  { id: 'wa9-with-checkout-fetch-depth-value', policy: '[SK-17]' },
  { id: 'wa10-with-registered-values-green', policy: null },
  { id: 'wa11-with-not-a-mapping', policy: '[SK-17]' },
  { id: 'wr1-runs-on-self-hosted', policy: '[SK-17]' },
  { id: 'wr2-runs-on-other-image', policy: '[SK-17]' },
  { id: 'wr3-runs-on-list-form', policy: '[SK-17]' },
  { id: 'wr4-runs-on-registered-green', policy: null },
  // ---- [SK-18]/[SK-19] 第十轮复审 V1 的 C-04/C-05(执行目录 / YAML 合并键)----
  // 两条判据面各自的**正例**(必须红)与**绿样本**(不得一刀切)都逐条点名:删掉任一条分支
  // 或把某一格样本改成绿形态,这里立刻报"登记了却没跑到/策略形同不存在"。
  { id: 'w20-guard-job-defaults-working-directory', policy: '[SK-18]' },
  { id: 'w21-pinned-gate-step-working-directory', policy: '[SK-18]' },
  { id: 'w22-unpinned-step-working-directory-green', policy: null },
  { id: 'w23-guard-job-merge-key', policy: '[SK-19]' },
  { id: 'w24-env-merge-key', policy: '[SK-19]' },
  { id: 'w25-anchored-alias-env-green', policy: null },
  // ---- [SK-18]/[SK-19] 第十轮**复审 W1** 的 N1/N2(两个入口只堵了一个)----
  // W1 实测:顶层 `defaults.run.working-directory` 与顶层 `defaults.run` 上的 `<<` 都曾是
  // EXIT=0。这两格红样本 + 两格"登记/显式键后确实变绿"的对照逐条点名 —— 删掉任一条分支、
  // 或把登记制悄悄改成"顶层一律红/一律绿",这里立刻报出来。
  { id: 'w26-workflow-defaults-working-directory', policy: '[SK-18]' },
  { id: 'w27-workflow-defaults-working-directory-green', policy: null },
  { id: 'w28-guard-job-working-directory-registered-green', policy: null },
  { id: 'w29-workflow-defaults-merge-key', policy: '[SK-19]' },
  { id: 'w30-workflow-defaults-explicit-key-green', policy: null },
  // ---- 第九轮审计 B 泳道的 5 条 P1 + 3 条假红(同属"判据只看文本、不看执行语义")----
  { id: 'x1-guard-runner-colon-noop', policy: '[SK-9]' },
  { id: 'x2-guard-runner-test-f', policy: '[SK-9]' },
  { id: 'x3-guard-runner-echo-literally', policy: '[SK-9]' },
  { id: 'x4-link-shell-template-noop', policy: '[SK-14]' },
  { id: 'x5-full-gate-shell-template-noop', policy: '[SK-14]' },
  { id: 'x6-link-indirect-trap', policy: '[SK-14]' },
  { id: 'x7-link-trap-substitution', policy: '[SK-14]' },
  { id: 'x8-release-require-echo-noop', policy: '[SK-15]' },
  { id: 'x8b-release-require-command-green', policy: null },
  { id: 'x9-shell-template-script-arg-green', policy: null },
  { id: 'x10-link-subshell-tail-green', policy: null },
  { id: 'x11-link-trap-cleanup-green', policy: null },
  { id: 'x12-guard-runner-redirect-tee-green', policy: null },
  { id: 'x13-guard-runner-redirect-null-green', policy: null },
  { id: 'x14-workflow-env-lookalike-green', policy: null },
  { id: 'x15-workflow-env-other-flag-green', policy: null },
  // ---- [SK-22] 表达式词法字符集(2026-09-25 第十四轮现场:整条 workflow 解析失败 ⇒ 0 job)----
  // 现场原形是"`run:` 的 **shell 注释**里的表达式带 U+2026";四条红样本 + 四条绿样本逐条点名
  // (尤其绿样本钉的是"必须剥掉单引号字面量 / 取体必须字符串感知"这两件容易做错的半件事)。
  { id: 'w31-run-comment-expression-ellipsis', policy: '[SK-22]' },
  { id: 'w32-expression-non-ascii-outside-literals', policy: '[SK-22]' },
  { id: 'w33-unterminated-expression', policy: '[SK-22]' },
  { id: 'w34-expression-disallowed-ascii-operator', policy: '[SK-22]' },
  { id: 'w35-expression-charset-green', policy: null },
  { id: 'w36-expression-literal-non-ascii-green', policy: null },
  { id: 'w37-expression-literal-braces-green', policy: null },
  { id: 'w38-expression-brace-in-literal-green', policy: null },
]

/** `selfTestScanner()` 至少执行的断言条数(供 main() 对账"自检没被掏空")。 */
const SELFTEST_SCANNER_ASSERTIONS = 5
/** `selfTestFatalPaths()` 至少执行的断言条数(4 样本 + 覆盖对账 2 条)。 */
const SELFTEST_FATAL_PATH_ASSERTIONS = 6
/** `selfTestWorkflowFileRegistry()` 至少执行的断言条数(4 个正反样本 + 1 条具名性)。 */
const SELFTEST_WORKFLOW_FILE_REGISTRY_ASSERTIONS = 5
/** `selfTestPinnedStepCoverage()` 至少执行的断言条数(1 条全命中 + 每条策略 1 条缺口)。 */
const SELFTEST_PINNED_STEP_COVERAGE_ASSERTIONS = 1 + 5
/** `selfTestPinnedEnvLayers()` 至少执行的断言条数(正向集合相等 + 反向未登记层 + 变异打坏)。 */
const SELFTEST_PINNED_ENV_LAYER_ASSERTIONS = 3
/** `selfTestCompositeActions()` 至少执行的断言条数(5 类正反样本 + 接线 + 变异)。 */
const SELFTEST_COMPOSITE_ACTION_ASSERTIONS = 9

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
function workflowResult(failures, {
  checked = 0,
  notes = [],
  allowlistHits = [],
  goTestTimeoutHits = 0,
  pinnedStepPolicies = [],
  pinnedEnvLayers = [],
  pinnedUses = [],
  usesWith = [],
  expressionBodies = 0,
} = {}) {
  return {
    failures,
    checked,
    notes,
    allowlistHits,
    goTestTimeoutHits,
    pinnedStepPolicies,
    pinnedEnvLayers,
    pinnedUses,
    usesWith,
    expressionBodies,
  }
}

/**
 * 检查一份 workflow 文本（纯函数：变异验证与内置自检都调它，不落任何文件）。
 * @param name - 文件名（只用于失败信息与白名单键）。
 * @param text - workflow 内容。
 * @returns `{failures, checked, notes, allowlistHits, goTestTimeoutHits}`（三条 early
 *   return 与成功路径**形状相同**，见 workflowResult）。
 */
export function checkWorkflowText(name, text, options = {}) {
  const failures = []
  // 提示收集器（"策略真的跑过了"的证据）。声明在这里而不是 SK-7 那一段之后：判定顺序最前的
  // [SK-22]（表达式词法字符集）就要往里面写通过证据，而它必须跑在 YAML 解析之前。
  const notes = []
  // SK-15 的登记表(默认 = 仓库真实登记值;自检用合成表注入,见 REGISTRY_DEFAULT)。
  const registries = options.registries ?? REGISTRY_DEFAULT
  // 本地 action 的解析根(第十轮审计 C-03):默认 = 仓库根;自检用临时树注入,
  // 这样 `uses: ./.github/actions/<name>` 的"能不能在仓内解析到"可以在合成树上判。
  const rootDir = options.rootDir ?? root

  // YAML 缩进不允许 tab;这类错误会让整个文件失效,先单独拦一道。
  if (/^\t|:\s*\t|\s\t/u.test(text)) {
    failures.push({ name, line: 0, detail: 'YAML 缩进中不允许出现 tab 字符' })
  }

  // 策略 14（[SK-22]，2026-09-25 第十四轮现场）：**表达式的词法字符集**。
  // 放在 YAML 解析**之前**，理由有两条：
  //   ① 它是"GitHub 能不能解析这个文件"的另一条独立失败面 —— 现场那份 ci.yml 的 YAML
  //      完全合法、`bash -n` 完全合法（非法字符就在一行 shell 注释里），只有模板解析器看得见；
  //   ② 放在最早 ⇒ YAML 也坏时两条诊断都在（本文件反复强调"门禁自己不能吞诊断"）。
  const expressionLexis = checkExpressionCharacterSet(name, text, notes)
  failures.push(...expressionLexis.failures)

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
  // （`notes` 已在函数开头声明：判定顺序更早的 [SK-22] 要往里面写通过证据。）
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
  // 策略 10(R5-D-1 / R4-A N6):交付物/判据 job 的"不可静默跳过"(登记式,两侧都红)。
  failures.push(...checkJobExecutability(name, document, notes, registries))
  // 策略 11(R5-D-2 / R5-C-6 / R5-C-8):发布链步骤的可执行性 + 效果判据 + 远端写入面。
  failures.push(...checkReleaseChainSteps(name, document, notes, registries))
  failures.push(...checkRemoteWriteCapabilities(name, document, notes, registries))
  // 策略 9(R4-A-3):触发面(`on:`)的业务契约 —— 删掉 `push:` 就等于关掉整条发布链。
  failures.push(...checkTriggerSurface(name, document, text, notes))
  // 策略 10(R4-A-5):被钉住的判据步骤必须**可执行**(`if: false` 落在"存在性"与
  // "形态"两条判据之间:文本在、内容对,就是永不执行)。
  const pinnedSteps = checkPinnedStepExecutability(name, document, blocks, allowlist, notes)
  failures.push(...pinnedSteps.failures)
  // 策略 10b（第十二轮红队 R12-D-01 / C-P1-2）：
  //   ⑨ **install 期完整性前置校验必须在任何 yarn/corepack 命令之前**（顺序即判据：
  //      载荷正是靠"判据跑在 install 之后"生效的）；
  //   ⑩ **通过凭据的断言块**必须在场且形态逐字（凭据的形态、独占目录、一次性 nonce、
  //      分开的两个流、退出码、恰好一行）—— 没有这一条，把断言块删掉/改弱没有任何静态反应。
  failures.push(...checkInstallIntegrityPrecedence(name, document, notes, options))
  failures.push(...checkVerdictAssertionBlocks(name, document, notes, options))
  // 策略 10c（第十三轮红队 R13-D-02，P0）：**判据步的启动器必须冻结** ——
  // 载荷只往 `$GITHUB_PATH` 追加一个假 `node` 目录（那行写在 `.sh` 里 ⇒ 上面两条静态判据
  // 都看不见）就能把探针 / 编排器 / 凭据检查器三次 `node` 调用全换掉，假 node 自己回显凭据。
  failures.push(...checkFrozenLaunchers(name, document, notes, options))
  // 策略 10d（第十三轮 C 泳道 C-05，P3）：**永不跳过的守卫 job 的权限面**逐字登记。
  failures.push(...checkPinnedJobPermissions(name, document, notes, options))
  // 策略 13(2026-09-25 第九轮审计 D 泳道 P1;2026-09-24 第十轮审计 C-01/C-02/C-03/D-03 加强):
  // 被钉步骤/守卫 job 的**进程环境层** —— 白名单式的四层 `env:` + 前序步骤的 `$GITHUB_ENV`
  // 写入 + 被钉步骤自己步骤体里的 `export`/前缀赋值 + 被钉单元里的 `uses:` 委派目标。
  // 上面那条 [SK-14] 读的是 argv / 解析后的 shell / 步骤体 / `if:`,四种通道全都在
  // "命令怎么被写出来"这一层,看不见"解释器被换掉了"(形态 A:`NODE_OPTIONS=--import=…`;
  // 形态 B:`BASH_ENV=…`;形态 C:`COREPACK_HOME=…` ⇒ 连 `yarn` 都是攻击者的文件)。
  // [SK-19] YAML 合并键（第十轮审计 C-05）：解析器不展开 `<<`，而 Actions 会 ——
  // 判据读不懂"被合并进来的是什么"，一律红（fail-closed）。放在最前面：它是"判据的输入是否
  // 完整"的问题，后面的每一条判据都建立在"解析结果就是 runner 看到的那份"之上。
  const mergeKeys = checkYamlMergeKeys(name, document)
  failures.push(...mergeKeys.failures)
  if (mergeKeys.failures.length === 0) {
    notes.push(`[SK-19] YAML 合并键(\`<<\`):已按 fail-closed 判定 `
      + `${Object.keys(typeof document?.jobs === 'object' && document.jobs !== null ? document.jobs : {}).length} 个 job 块 / `
      + `${mergeKeys.stepBlocks} 个步骤块(出现合并键即红 —— 解析器不展开它,判据与 runner 的语义会分叉)`
      + ` + workflow 顶层 \`defaults\`/\`defaults.run\` ${mergeKeys.workflowDefaultsBlocks} 个块`
      + '(顶层 `defaults.run` 一次作用于所有 job ⇒ W1 复审 N2 补进扫描面)')
  }
  const pinnedEnv = checkPinnedStepEnvironment(name, document, blocks, notes, {
    rootDir,
    // 被钉 job 的**容器镜像登记表**走与 SK-15 同一个 `registries` 测试缝（第十轮复审 V1 的
    // P3-D3）：`w14` 那个样本同时带了未登记的 `container:`（镜像判据）与 `container.env`
    // 里的危险键，于是**删掉 `container.env` 的键判定循环后样本照样红**（被相邻判据顶替）——
    // 那一层就成了"没有自检守住的分支"。拆样本的前提是能单独放行镜像登记，所以这里必须可注入。
    containerImages: registries.containerImages ?? PINNED_JOB_CONTAINER_REGISTRY,
    // [SK-18] 的两张 **cwd 登记表**走同一个测试缝（W1 复审 N1 补）：没有它，"已登记例外绿"
    // 这一格样本就无法构造（真实登记表里只有 `server` job 那一条，而样本的 job 名是
    // `gate-guards`）—— 只有红样本、没有"登记后确实变绿"的证据，登记制就只被证明了一半。
    // 注入语义 = **追加**（不是替换）：样本树复刻了 ci.yml 的 `server` job，替换会把真实登记的
    // 那一格判成未登记 ⇒ 假红（第一版就是这么红的）。
    jobWorkingDirectories: [...PINNED_JOB_WORKING_DIRECTORY_REGISTRY, ...(registries.jobWorkingDirectories ?? [])],
    workflowWorkingDirectories: [...WORKFLOW_LEVEL_WORKING_DIRECTORY_REGISTRY, ...(registries.workflowWorkingDirectories ?? [])],
    // [SK-17⑦c] 被钉 job 的 `runs-on` 登记表走同一个测试缝（第十一轮审计 P2-1）：注入语义 =
    // **追加**（与 cwd 两张表一致）—— 自检合成的 job 名（`verify`）与真 ci.yml 的三个 job 并存，
    // 这样"登记后确实变绿"那一格能被单独构造出来（只有红样本 = 登记制只被证明了一半）。
    jobRunsOn: [...PINNED_JOB_RUNS_ON_REGISTRY, ...(registries.jobRunsOn ?? [])],
  })
  failures.push(...pinnedEnv.failures)
  // [SK-14⑧](R8-D-24):块级 shell 与步骤级 shell 两条口径必须一致(危险方向即红)。
  failures.push(...checkShellResolutionConsistency(name, document, blocks, notes))
  // 策略 12(R7-C P2-1):`--allow-advisory` 是 advisory 降级成告警的唯一入口,CI 不得带。
  failures.push(...checkAdvisoryOptIn(name, document, notes))

  return workflowResult(failures, {
    checked,
    notes,
    allowlistHits: allowlist.hits,
    goTestTimeoutHits: budget.hits,
    pinnedStepPolicies: pinnedSteps.policies,
    pinnedEnvLayers: pinnedEnv.layers,
    pinnedUses: pinnedEnv.uses,
    usesWith: pinnedEnv.usesWith,
    // [SK-22]：全文扫到的表达式处数（main() 用它做"扫描器退化"对账：全仓一处都扫不到即红）。
    expressionBodies: expressionLexis.expressions,
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
/**
 * 根门禁调用的**第二种形态**（第十二轮红队 C-P0-2①）：`node scripts/check-workspaces.mjs`
 * —— 由 **CI 自己的 node** 直接起编排器，不经 yarn。
 *
 * 为什么必须有这个形态：`yarn check` 会让 yarn 在**启动期**加载 `.yarnrc.yml` 的 `plugins:`
 * （顶层模块代码），于是"承载判决的那个进程"的启动器本身由仓内配置决定；而包级 check 仍由
 * 编排器内部经 yarn 起（那条路上编排器自己拒 `yarnPath`/`plugins`/生命周期钩子）。
 * 形态等价（root `package.json` 的 `check` 脚本就是 `node scripts/check-workspaces.mjs`），
 * 所以两条入口是同一件事的两种写法。
 */
// ---- [SK-20] 的常量（放在这里是因为 `ROOT_GATE_DIRECT_INVOCATION` 等判据正则要用它们）----
/** 冻结步的 `id`（契约：被钉步骤用 `steps.<id>.outputs.*` 引用它）。 */
const FROZEN_LAUNCHER_STEP_ID = 'frozen-launchers'
/** 必须使用冻结启动器的 job（跑判据的那两个）。 */
const FROZEN_LAUNCHER_JOBS = ['gate-guards', 'gate']
/** 必须**真的跑**行为探针的 job（"永不跳过"的那一个；其余 job 不必各跑一遍）。 */
const FROZEN_LAUNCHER_PROBE_JOBS = ['gate-guards']
/** 行为探针脚本（必须真的被某个被钉 job 执行）。 */
const FROZEN_LAUNCHER_PROBE = 'scripts/check-frozen-launchers.mjs'
/** 冻结步必须写出的输出键。 */
const FROZEN_LAUNCHER_OUTPUT_KEYS = ['node', 'interp', 'git', 'path']
/**
 * **第二个冻结点**：把"冻结的 PATH"与**白名单内的工具链目录**合成一份判据步真能用的 PATH
 * （V13-A §3.3 / R1 的收口件）。
 *
 * 为什么需要它：第一个冻结点排在任何仓内执行点**之前**（位置即判据），所以它抓到的 `path`
 * 是"工具链之前"那份；而 `Full gate` 经 `corepack yarn` 起包级 check，需要 setup-node 的
 * node 与 corepack shim 在 PATH 上。直接拿冻结那份复位 PATH = 用 runner **预装**的 node
 * 跑 `yarn install` 装出来的依赖（版本/ABI 面不一致）—— 那是"用一个可能坏掉的构建换一个
 * 看起来安全的形态"。所以这一格把工具链目录**按白名单**放进来：
 *   · 只放行 `${{ runner.tool_cache }}/node/` 之下的目录（runner 侧展开的常量，仓内代码改不到）；
 *   · 其它任何**新增**目录一律当场红 —— 那正是 `$GITHUB_PATH` 注入留下的痕迹。
 */
const FROZEN_TOOLCHAIN_STEP_ID = 'frozen-toolchain'
/**
 * **允许被 `export PATH=…` 复位的两个冻结点**（`FROZEN_LAUNCHER_PATH_EXPORT` 的正则里逐字写着
 * 这两个名字；这里再做一次纯字符串对拍 —— 两处漂移时 [SK-17] 的例外会失效而不是放宽）。
 */
const FROZEN_LAUNCHER_STEP_IDS = [FROZEN_LAUNCHER_STEP_ID, FROZEN_TOOLCHAIN_STEP_ID]
/**
 * 判据步里允许出现的**外部命令**（登记制）。
 *
 * 为什么不再逐个写冻结点输出（V13-A §3.3 顺带点名的 `openssl`）：复位 `PATH` 之后，
 * `openssl`/`cat`/`grep`/`mkdir` 与 `node`/`git`/`bash` 走的是**同一份**解析面 ——
 * 冻结的是"整份 PATH"，逐个工具再写一个冻结点输出只是把同一件事说几遍。但"步骤能跑什么"
 * 仍是判据面的一部分 ⇒ 按**登记制**收口：判据步里新出现一个未登记的外部命令即红
 * （要么登记它并写清为什么不需要单独的冻结输出，要么别在判据步里用它）。
 */
const FROZEN_LAUNCHER_EXTERNAL_TOOLS = [
  ['openssl', '凭据通道用它造一次性 nonce（`openssl rand -hex 16 > "$verdict_dir/nonce"`）'],
  ['mkdir', '造步骤独占目录（`mkdir -m 700 "$verdict_dir"`：原子性本身就是判据的一部分）'],
  ['cat', '把步骤自己的 stdout/stderr 捕获文件打回日志（凭据只从捕获文件里认）'],
  ['grep', '在通过凭据文件里数"恰好一行"'],
  ['tar', '打包 workspace 构建产物（不跑仓内代码，产物面判据）'],
]
/** shell 内建 / 关键字：不是外部命令，不需要登记。 */
const SHELL_BUILTIN_OR_KEYWORD_WORDS = new Set([
  'set', 'export', 'unset', 'declare', 'typeset', 'readonly', 'local', 'shift', 'eval', 'exec',
  'source', '.', 'command', 'builtin', 'type', 'hash', 'umask', 'shopt', 'alias', 'unalias',
  'echo', 'printf', 'read', 'test', '[', ']', '[[', ']]', ':', 'true', 'false', 'let', 'getopts',
  'cd', 'pwd', 'pushd', 'popd', 'dirs', 'exit', 'return', 'break', 'continue', 'trap', 'wait',
  'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'in',
  'select', 'time', 'coproc', 'function',
])
/** 合成步体里必须逐字出现的判据（冻结值来源 / 白名单锚 / 输出通道 / 拒绝路径）。 */
const FROZEN_TOOLCHAIN_FRAGMENTS = [
  'steps.frozen-launchers.outputs.path',
  'runner.tool_cache',
  '>> "$GITHUB_OUTPUT"',
  'exit 1',
]
/**
 * 判据步体里"复位 PATH"的那一行。**两个冻结点都认**（早于工具链就位的步骤只能用第一份）。
 * 与 [SK-17] 的 PATH 例外（`FROZEN_LAUNCHER_PATH_EXPORT`，定义在下面的 [SK-20] 常量区）
 * **逐字相同**：逐字 + 两端锚定 —— 多加一个字符（例如在后面再接一个目录）即不再豁免。
 * 两份字面量必须同步；漂移由 `FROZEN_LAUNCHER_STEP_IDS` 的纯字符串对拍兜住。
 */
const FROZEN_LAUNCHER_PATH_EXPORT_ANY = /^export\s+PATH="\$\{\{\s*steps\.(frozen-launchers|frozen-toolchain)\.outputs\.path\s*\}\}"$/u
/** 命令位的冻结表达式（`"${{ steps.<id>.outputs.<key> }}" …`）。 */
const FROZEN_EXPRESSION_COMMAND_POSITION = /(?:^|[\n;&|(]|&&|\|\|)\s*"\$\{\{\s*steps\.[A-Za-z0-9_-]+\.outputs\.[A-Za-z0-9_-]+\s*\}\}"/u
/** 命令位直接跑仓内路径（`scripts/…` / `packages/…` / `integration-tests/…`）。 */
const REPO_PATH_COMMAND_POSITION = /(?:^|[\n;&|(]|&&|\|\|)\s*(?:\.\/)?(?:scripts|packages|integration-tests)\//u
/** 冻结步体里必须逐字出现的形态（绝对路径 + 步骤输出通道）。 */
const FROZEN_LAUNCHER_FREEZE_FRAGMENTS = [
  'command -v node',
  'command -v bash',
  'command -v git',
  '>> "$GITHUB_OUTPUT"',
]
/** `export PATH="${{ steps.<id>.outputs.path }}"`（SK-17 body-assignment 的**唯一** PATH 例外）。 */
const FROZEN_LAUNCHER_PATH_EXPORT = /^export\s+PATH="\$\{\{\s*steps\.(frozen-launchers|frozen-toolchain)\.outputs\.path\s*\}\}"$/u
/** 冻结启动器的 node 调用形态（runner 侧展开的绝对路径）。 */
const FROZEN_LAUNCHER_NODE_EXPRESSION = 'steps.frozen-launchers.outputs.node'
/** 冻结的 `git`（取判据执行体来源的那条链）。 */
const FROZEN_LAUNCHER_GIT_EXPRESSION = 'steps.frozen-launchers.outputs.git'
/**
 * 冻结的解释器（执行仓内脚本的那条链）。
 *
 * 输出键叫 `interp` 而不是它的常见名字：静态判据 `[SK-7c]` 把 `sh`/`ba*sh` 这类**词**当成
 * "把命令交给另一个 shell"，冻结步里出现那个词会被它判红（`command -v <词>` 与带引号的
 * 写法都在内，实测）。判据的形态学不该被绕过，但也不该为了一个名字把收口写变形 ——
 * 键名换掉、语义不变。
 */
const FROZEN_LAUNCHER_BASH_EXPRESSION = 'steps.frozen-launchers.outputs.interp'
/**
 * shell **函数定义**形态（`f() { … }` / `function f { … }` / `function f() { … }`）。
 * 见 [SK-14⑩]：承载凭据的步骤里出现定义即红（同名函数会遮蔽断言用的命令）。
 */
const SHELL_FUNCTION_DEFINITION = /(?:^|[\n;&|(])\s*(?:function\s+)?[A-Za-z_][A-Za-z0-9_]*\s*(?:\(\s*\))?\s*\{/gu
const VERDICT_ASSERTION_STEPS = [
  {
    job: 'gate-guards',
    name: 'Judge execution bodies are pristine (runs before any yarn command)',
    required: [
      '"${{ steps.frozen-launchers.outputs.git }}" show HEAD:scripts/check-install-integrity.mjs',
      '"${{ steps.frozen-launchers.outputs.node }}" "$probe" --root "$PWD"',
      'verdict_dir="$RUNNER_TEMP/verdict-$SRANDOM$SRANDOM$RANDOM"',
      'mkdir -m 700 "$verdict_dir"',
      'openssl rand -hex 16 > "$verdict_dir/nonce"',
      '> "$verdict_dir/stdout" 2> "$verdict_dir/stderr"',
      'scripts/check-verdict-credential.mjs',
      '--dir "$verdict_dir" --nonce-file "$verdict_dir/nonce" --status "$status"',
      "'^check-install-integrity: VERDICT PASS judge-bodies=[0-9]+'",
      '--min judge-bodies 1',
      // [SK-20] / R13-D-01：凭据必须把**平台锚**一起回显（`github-sha=` 由判据自己写出，
      // 值是它读到的 `$GITHUB_SHA`）—— 于是「HEAD == 平台值」这件事进凭据、进汇总，
      // 可被这一步逐字断言（判据侧不等就退出码 2，凭据根本打印不出来）。
      '--expect github-sha "$GITHUB_SHA"',
      'picoaide-verdict: PASS nonce=',
      '[ "$verdict_lines" -ne 1 ]',
      'exit 1',
    ],
    forbidden: ['/tmp/', '|& tee'],
  },
  {
    job: 'gate',
    name: 'Judge execution bodies are pristine (runs before any yarn command)',
    required: [
      '"${{ steps.frozen-launchers.outputs.git }}" show HEAD:scripts/check-install-integrity.mjs',
      '"${{ steps.frozen-launchers.outputs.node }}" "$probe" --root "$PWD"',
      'verdict_dir="$RUNNER_TEMP/verdict-$SRANDOM$SRANDOM$RANDOM"',
      'mkdir -m 700 "$verdict_dir"',
      'openssl rand -hex 16 > "$verdict_dir/nonce"',
      '> "$verdict_dir/stdout" 2> "$verdict_dir/stderr"',
      'scripts/check-verdict-credential.mjs',
      '--dir "$verdict_dir" --nonce-file "$verdict_dir/nonce" --status "$status"',
      "'^check-install-integrity: VERDICT PASS judge-bodies=[0-9]+'",
      '--min judge-bodies 1',
      // [SK-20] / R13-D-01：凭据必须把**平台锚**一起回显（`github-sha=` 由判据自己写出，
      // 值是它读到的 `$GITHUB_SHA`）—— 于是「HEAD == 平台值」这件事进凭据、进汇总，
      // 可被这一步逐字断言（判据侧不等就退出码 2，凭据根本打印不出来）。
      '--expect github-sha "$GITHUB_SHA"',
      'picoaide-verdict: PASS nonce=',
      '[ "$verdict_lines" -ne 1 ]',
      'exit 1',
    ],
    forbidden: ['/tmp/', '|& tee'],
  },
  {
    job: 'gate-guards',
    name: 'Root guards (every PR shape)',
    required: [
      '"${{ steps.frozen-launchers.outputs.git }}" show HEAD:scripts/check-install-integrity.mjs',
      '--root "$PWD" --restore',
      'verdict_dir="$RUNNER_TEMP/verdict-$SRANDOM$SRANDOM$RANDOM"',
      'mkdir -m 700 "$verdict_dir"',
      'openssl rand -hex 16 > "$verdict_dir/nonce"',
      '> "$verdict_dir/stdout" 2> "$verdict_dir/stderr"',
      'scripts/check-verdict-credential.mjs',
      '--dir "$verdict_dir" --nonce-file "$verdict_dir/nonce" --status "$status"',
      "'^check-root-guards: VERDICT PASS guards=[1-9][0-9]*'",
      '--min guards 1',
      'picoaide-verdict: PASS nonce=',
      '[ "$verdict_lines" -ne 1 ]',
      'exit 1',
    ],
    forbidden: ['/tmp/root-guards.log'],
  },
  {
    job: 'gate-guards',
    name: 'Guard parser integrity (strict worktree↔HEAD anchor)',
    required: [
      '"${{ steps.frozen-launchers.outputs.git }}" show HEAD:scripts/check-install-integrity.mjs',
      '--root "$PWD" --restore',
      'verdict_dir="$RUNNER_TEMP/verdict-$SRANDOM$SRANDOM$RANDOM"',
      'mkdir -m 700 "$verdict_dir"',
      'openssl rand -hex 16 > "$verdict_dir/nonce"',
      '> "$verdict_dir/stdout" 2> "$verdict_dir/stderr"',
      'check-guard-parser-integrity.mjs --require-clean',
      'scripts/check-verdict-credential.mjs',
      '--dir "$verdict_dir" --nonce-file "$verdict_dir/nonce" --status "$status"',
      "'^check-guard-parser-integrity: OK — [0-9]+ 条守卫脚本'",
      'picoaide-verdict: PASS nonce=',
      '[ "$verdict_lines" -ne 1 ]',
      'exit 1',
    ],
    forbidden: ['/tmp/root-guards.log'],
  },
  {
    job: 'gate',
    name: 'Full gate (packages + all root guards)',
    required: [
      '"${{ steps.frozen-launchers.outputs.git }}" show HEAD:scripts/check-install-integrity.mjs',
      '--root "$PWD" --restore',
      'verdict_dir="$RUNNER_TEMP/verdict-$SRANDOM$SRANDOM$RANDOM"',
      'mkdir -m 700 "$verdict_dir"',
      'openssl rand -hex 16 > "$verdict_dir/nonce"',
      '> "$verdict_dir/stdout" 2> "$verdict_dir/stderr"',
      '"${{ steps.frozen-launchers.outputs.node }}" scripts/check-workspaces.mjs',
      'scripts/check-verdict-credential.mjs',
      '--dir "$verdict_dir" --nonce-file "$verdict_dir/nonce" --status "$status"',
      "'^check-workspaces: VERDICT PASS planned=[0-9]+ executed=[0-9]+'",
      '--min planned 1 --equal planned executed',
      'picoaide-verdict: PASS nonce=',
      '[ "$verdict_lines" -ne 1 ]',
      'exit 1',
    ],
    forbidden: ['/tmp/gate.log', '|& tee'],
  },
]

// ===== SK-20:被钉步骤的**启动器**必须冻结（第十三轮 R13-D-02，P0） =====
//
// 现场（第十三轮 D 泳道实测）：载荷**不碰 git、不改任何被跟踪文件**，只把假 `node` 目录写进
// `$GITHUB_PATH`（那行写在某个 `.sh` 里 ⇒ 读 YAML 的静态判据看不见）⇒ 探针 / 编排器 /
// **凭据检查器**三次 `node` 调用全被替换；假 `node` 按 `--nonce-file` 把凭据自己回显回去，
// 于是 `EXIT=0`、工作树干净、日志里凭据"齐全"，而一条判据都没跑。
//
// 收口形态（本规则钉住的形态）：
//   ① 每个跑判据的 job 有且只有一个**冻结步**：`id: frozen-launchers`，且它之前没有执行仓内
//      代码的步骤 —— 它把 `command -v node/bash/git` 的绝对路径与当时的 `$PATH` 写进
//      `$GITHUB_OUTPUT`；
//   ② 该 job 里**任何**在命令位调用 `node` 的步骤都必须用 `"${{ steps.frozen-launchers.outputs.node }}"`
//      （runner 侧展开的绝对路径；步骤输出在步骤结束时被 runner 读走，后续仓内进程改不到）；
//   ③ **每个跑仓内执行体的判据步**都必须 `export PATH="${{ steps.<冻结点>.outputs.path }}"`
//      —— 而且是该步里**任何仓内命令之前**的第一条（V13-A §3.3 / R1：只冻结"步骤命令位的
//      启动器"冻不到仓内脚本体里的裸 `node`，实测能把 wasm 门禁翻成 EXIT=0）；
//      冻结点有两个：`frozen-launchers`（工具链就位之前的那份）与
//      `frozen-toolchain`（把冻结 PATH 与**白名单内**的工具链目录合成后的那份 —— 白名单是
//      `${{ runner.tool_cache }}/node/`，其它任何新增目录 ⇒ 当场红，那正是 `$GITHUB_PATH`
//      注入的痕迹）；引用哪一个都行，但被引用的冻结点必须在本步**之前**；
//   ④ 该 job 里必须有一个步骤**真的跑**行为探针 `scripts/check-frozen-launchers.mjs`
//      （静态判据只能证明"文本形态对"，跑一遍才能证明"PATH 注入换不掉启动器"，
//      探针内部自带**正控**：拆掉冻结点后同一个载荷必须能把判据换掉，否则探针恒绿；
//      另有一个**R1 形态的正控**：只拆掉 PATH 复位、保留冻结解释器 ⇒ 必须变红）。
//
// 诚实边界：收口的是 `$PATH` 注入这条**低成本**通道；GitHub 托管 runner 上 runner 用户有
// 免密 sudo，同 job 内任意代码理论上仍可替换任何主机侧路径 —— 见行为探针的末尾输出。
const ROOT_GATE_FROZEN_NODE_TOKEN = String.raw`"\$\{\{\s*steps\.${FROZEN_LAUNCHER_STEP_ID}\.outputs\.node\s*\}\}"`
const ROOT_GATE_DIRECT_INVOCATION = new RegExp(
  `(?:^|[;&|(\\n]|\\$\\()\\s*(?:node|${ROOT_GATE_FROZEN_NODE_TOKEN})\\s+scripts/check-workspaces[.]mjs`
  + `(?![\\w:.-])((?:[ \\t]+[^\\s;&|>()]+)*)`,
  'gu',
)
/**
 * 根门禁调用的**全部形态**（`yarn check` / `corepack yarn check` / `node scripts/check-workspaces.mjs`）。
 * @param script - 去注释后的可执行文本。
 * @returns `{ mode, args }[]`；`mode === 'check'` = 全量门禁，`'check:fast'` = 弱化形态。
 */
function rootGateInvocations(script) {
  const text = String(script)
  const hits = [...text.matchAll(ROOT_GATE_INVOCATION)].map(match => ({ mode: match[1], args: match[2] }))
  for (const match of text.matchAll(ROOT_GATE_DIRECT_INVOCATION)) hits.push({ mode: 'check', args: match[1] })
  return hits
}
/** 永远运行那个守卫 job 的 run 内容(docs-only 的 PR 也跑)。 */
const DOCS_ONLY_GUARD_RUNNER = 'scripts/check-root-guards.mjs'
/**
 * 守卫解析器完整性判据的脚本（第十二轮红队 R12-D-04）：它是"工作树↔HEAD 锚定"的承重判据，
 * 却**从未**进过 `PINNED_STEP_POLICIES` —— `if: false` / 删 `--require-clean` 都能让它静默。
 */
const GUARD_PARSER_SCRIPT = 'scripts/check-guard-parser-integrity.mjs'
/**
 * 「install 期判据本体完整性」前置校验的脚本（第十二轮红队 R12-D-01 的收口件）。
 *
 * 它必须出现在**每个**跑判据的 job 的最前面、且此前不得有任何 `yarn`/`corepack` 命令 ——
 * 载荷（`.yarnrc.yml` 的 `plugins:` / 工作区 `postinstall`）正是靠"判据跑在 install 之后"
 * 生效的：install 期改写工作树里的判据本体，`ci.yml` 一字未改即可让全部判定块变绿。
 */
const INSTALL_INTEGRITY_PRECHECK = 'scripts/check-install-integrity.mjs'
/** 必须让前置校验**先于任何 yarn 命令**执行的 job（顺序即判据，见 [SK-14⑨]）。 */
const INSTALL_INTEGRITY_PRECEDENCE_JOBS = ['gate-guards', 'gate']
/**
 * 这一步是不是在**执行**「install 期完整性前置校验」。
 *
 * 两种等价形态都认：① 直接 `node scripts/check-install-integrity.mjs`；② 先
 * `git show HEAD:scripts/check-install-integrity.mjs > "$probe"` 再 `node "$probe"` ——
 * 后者的**执行体来自 git 对象**（工作树里那份在更早的步里可被改写），是 CI 现在用的形态。
 * 注意 ② 的判据是 `git show HEAD:<路径>` 这个**动作**在场（不是"文本里提到过路径"）。
 * @param script - 去注释后的可执行文本。
 * @returns 是否在执行前置校验。
 */
function executesInstallPrecheck(script) {
  if (commandPositionArgvs(script, INSTALL_INTEGRITY_PRECHECK).length > 0) return true
  // 判据是 `git show HEAD:<路径>` 这个**动作**在场。命令词可能是冻结的 git 表达式
  // （`"${{ steps.frozen-launchers.outputs.git }}" show HEAD:…`）⇒ 按"命令词 + show HEAD:"
  // 判，而不是按整串字面量（[SK-20] 之后字面量形态不再出现）。
  const escaped = INSTALL_INTEGRITY_PRECHECK.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return new RegExp(`show\\s+HEAD:${escaped}`, 'u').test(String(script))
}
/**
 * [SK-14⑩] **通过凭据的断言块**的登记表（第十二轮红队 R12-D-03 / C-P1-2 的唯一真源）。
 *
 * 每一条 = 一个承载"通过凭据断言"的步骤：`required` 是它必须**逐字**包含的关键件，
 * `forbidden` 是已废弃的旧形态（固定日志路径 = 前序步骤留下的进程可以往它追加一行凭据）。
 * 改步骤体必须同步改这张表 —— 登记值进 diff、可评审。
 */
/** 承载"通过凭据断言块"的那份 workflow（登记表里的 job/step 名都属于它）。 */
const VERDICT_WORKFLOW_FILE = 'ci.yml'
/**
 * 这段步骤体是不是"从冻结输出复位 PATH"的那一行（SK-17 的 PATH 例外）。
 * @param segment - `shellEnvironmentAssignments()` 报出的原始片段。
 * @returns 是否放行。
 */
function isFrozenLauncherPathExport(segment) {
  const match = FROZEN_LAUNCHER_PATH_EXPORT.exec(String(segment ?? '').trim())
  return match !== null && FROZEN_LAUNCHER_STEP_IDS.includes(match[1])
}

/**
 * 把 shell 的行继续（行尾 `\`）接起来 —— "命令位"判定必须在**逻辑行**上做，否则
 * `tar -czf x.tgz \` 后面每一行都以路径开头，会被误判成"在命令位跑仓内脚本"。
 * @param script - 去注释后的可执行文本。
 * @returns 逻辑行数组。
 */
function joinedLogicalLines(script) {
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
 * 这一步是不是"跑仓内执行体的判据步"：命令位出现**冻结表达式**或**仓内路径**。
 *
 * 只用同一份口径判定"哪些步骤必须复位 PATH"，避免"按步骤名手写清单"（清单会漂移）。
 * @param run - 步骤的原始 `run` 文本。
 * @returns 是否判据步。
 */
function isJudgeStepRun(run) {
  for (const line of joinedLogicalLines(run)) {
    const code = line.replace(/#.*$/u, '')
    if (FROZEN_LAUNCHER_PATH_EXPORT_ANY.test(code.trim())) continue
    if (FROZEN_EXPRESSION_COMMAND_POSITION.test(code)) return true
    if (REPO_PATH_COMMAND_POSITION.test(code)) return true
  }
  return false
}

/**
 * 判据步体里第一次"执行仓内东西"的**逻辑行**下标（复位 PATH 那一行不算）；没有 ⇒ -1。
 * @param run - 步骤的原始 `run` 文本。
 * @returns 下标。
 */
function firstJudgeInvocationLine(run) {
  const lines = joinedLogicalLines(run)
  for (let index = 0; index < lines.length; index += 1) {
    const code = lines[index].replace(/#.*$/u, '')
    if (FROZEN_LAUNCHER_PATH_EXPORT_ANY.test(code.trim())) continue
    if (FROZEN_EXPRESSION_COMMAND_POSITION.test(code)) return index
    if (REPO_PATH_COMMAND_POSITION.test(code)) return index
  }
  return -1
}

/**
 * 判据步体里"复位 PATH"那一行的**逻辑行**下标；没有 ⇒ -1。
 * @param run - 步骤的原始 `run` 文本。
 * @returns 下标。
 */
function frozenPathExportLine(run) {
  const lines = joinedLogicalLines(run)
  for (let index = 0; index < lines.length; index += 1) {
    if (FROZEN_LAUNCHER_PATH_EXPORT_ANY.test(lines[index].replace(/#.*$/u, '').trim())) return index
  }
  return -1
}

/**
 * 判据步体里出现的**外部命令**（跳过赋值前缀、shell 关键字/内建、冻结表达式与仓内路径）。
 *
 * 用途只有一个：判据步里"新出现一个没登记的外部命令"要红（见 `FROZEN_LAUNCHER_EXTERNAL_TOOLS`）。
 * 它是**近似的 shell 词法**（不做完整解析），因此只对"命令位第一个词"判，且内建/关键字按
 * 白名单放过 —— 宁可漏判一个奇怪写法，也不要因为误判把正常判据步骤判红（假红的下场是
 * 整条判据被关掉）。
 * @param run - 步骤的原始 `run` 文本。
 * @returns 外部命令名数组（去重、排序）。
 */
function externalCommandWords(run) {
  const found = new Set()
  const known = new Set(FROZEN_LAUNCHER_EXTERNAL_TOOLS.map(([tool]) => tool))
  for (const line of joinedLogicalLines(run)) {
    const code = line.replace(/#.*$/u, '')
    for (const segment of code.split(/(?:&&|\|\||[;&|])/u)) {
      const words = segment.trim().split(/\s+/u).filter(word => word !== '')
      let index = 0
      while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[index])) index += 1
      while (index < words.length && SHELL_BUILTIN_OR_KEYWORD_WORDS.has(words[index])) index += 1
      const word = words[index]
      if (word === undefined) continue
      if (word.startsWith('"') || word.startsWith("'") || word.startsWith('$')) continue
      if (/^(?:\.\/)?(?:scripts|packages|integration-tests|docs|server|\.github)\//u.test(word)) continue
      const name = /([^/]+)$/u.exec(word)?.[1] ?? word
      if (SHELL_BUILTIN_OR_KEYWORD_WORDS.has(name) || known.has(name)) continue
      if (!/^[A-Za-z][A-Za-z0-9._-]*$/u.test(name)) continue
      found.add(name)
    }
  }
  return [...found].sort()
}

/**
 * [SK-20] 冻结启动器的静态判据（现场说明见上面常量区）。
 * @param file - workflow 文件名。
 * @param document - parseYaml 的结果。
 * @param notes - 提示收集器。
 * @param options - `{ scannedFile }`（只对真实的那份 workflow 判）。
 * @returns 失败项列表。
 */
function checkFrozenLaunchers(file, document, notes, options = {}) {
  const failures = []
  if (options?.scannedFile !== VERDICT_WORKFLOW_FILE) return failures
  const jobs = typeof document?.jobs === 'object' && document.jobs !== null ? document.jobs : {}
  for (const jobId of FROZEN_LAUNCHER_JOBS) {
    const job = jobs[jobId]
    if (job === undefined || job === null) {
      failures.push({
        name: file,
        line: 0,
        detail: `[SK-20] 登记的 job \`${jobId}\` 不在本 workflow 里 —— \`FROZEN_LAUNCHER_JOBS\` 的每一条`
          + '都是"这个 job 跑判据、所以它的启动器必须冻结"的登记，job 被删/改名必须同步这张表。',
      })
      continue
    }
    const steps = Array.isArray(job?.steps) ? job.steps : []
    const scripts = steps.map(step => (typeof step?.run === 'string' ? executableScript(step.run) : ''))
    const jobFailures = []
    const freezeIndex = steps.findIndex(step => typeof step?.id === 'string' && step.id.trim() === FROZEN_LAUNCHER_STEP_ID)
    if (freezeIndex < 0) {
      failures.push({
        name: file,
        line: 0,
        detail: `[SK-20] job \`${jobId}\` 里没有 \`id: ${FROZEN_LAUNCHER_STEP_ID}\` 的**冻结步** ——\n`
          + '  ⇒ 后续判据步里的 `node` 会按 `$PATH` 解析，而同 job 里任何一个更早的步骤都可以把假'
          + '`node` 目录追加进 `$GITHUB_PATH`（第十三轮 R13-D-02：探针 / 编排器 / 凭据检查器三次调用'
          + '全被替换，假 node 自己回显凭据 ⇒ EXIT=0、工作树干净、判据一条没跑）。',
      })
      continue
    }
    const freezeScript = scripts[freezeIndex] ?? ''
    for (const fragment of FROZEN_LAUNCHER_FREEZE_FRAGMENTS) {
      if (!freezeScript.includes(fragment)) {
        jobFailures.push({
          name: file,
          line: 0,
          detail: `[SK-20] job \`${jobId}\` 的冻结步里缺少 \`${fragment}\` —— 冻结步必须把`
            + ' `command -v node/bash/git` 的**绝对路径**与当时的 `$PATH` 写进 `$GITHUB_OUTPUT`'
            + '（步骤输出由 runner 读走，后续仓内进程改不到）。',
        })
      }
    }
    for (const key of FROZEN_LAUNCHER_OUTPUT_KEYS) {
      if (!new RegExp(`(?:^|[^A-Za-z0-9_-])${key}=`, 'u').test(freezeScript)) {
        jobFailures.push({
          name: file,
          line: 0,
          detail: `[SK-20] 冻结步没有写出 \`${key}=\` 输出 —— 被钉步骤要按 `
            + `\`steps.${FROZEN_LAUNCHER_STEP_ID}.outputs.${key}\` 引用它。`,
        })
      }
    }
    // 冻结步之前不得有**执行仓内代码**的步骤（`echo`/`exit` 这类纯 shell 不算）。
    const earlier = []
    for (let index = 0; index < freezeIndex; index += 1) {
      const script = scripts[index]
      if (script === '') continue
      const runsRepoCode = ['node', 'yarn', 'corepack', 'bash'].some(command => commandPositionArgvs(script, command).length > 0)
        || /(?:^|[\s;&|])"?\.?\/?(?:scripts|packages)\//u.test(script)
      if (runsRepoCode) earlier.push(`第 ${index + 1} 步「${stepName(steps[index], index)}」`)
    }
    if (earlier.length > 0) {
      jobFailures.push({
        name: file,
        line: 0,
        detail: `[SK-20] job \`${jobId}\` 的冻结步排在第 ${freezeIndex + 1} 步，但它之前还有执行仓内`
          + `代码的步骤：${earlier.join('；')}\n  ⇒ 冻结必须在**任何仓内执行点之前**（在那之前跑过的`
          + '东西都可以改写 `$PATH`/`$GITHUB_ENV`，冻结出来的就是被污染的值）。',
      })
    }
    // ② 该 job 里**任何**在命令位调用 `node` 的步骤都必须用冻结的绝对路径。
    //    同时：取判据执行体来源的 `git show HEAD:` 与仓内 `bash <脚本>` 也必须走冻结值 ——
    //    它们与 `node` 同属"启动器"（假 `git`/假 `bash` 一样能把探针来源/脚本换成攻击者的）。
    //    ③（V13-A §3.3 / R1）**冻结点只冻结了"步骤命令位"的启动器，冻不到仓内脚本体内的裸命令**：
    //    `"${{ …outputs.interp }}" scripts/<x>.sh` 里的 `node` 仍按 `$PATH` 解析 ⇒ 一个只拦
    //    某条判据、其余转发真 node 的假 `node` 能把 `pass=2 fail=1/EXIT=1` 翻成
    //    `pass=3 fail=0/EXIT=0`（端到端实测）。所以**每个跑仓内执行体的判据步**都必须在
    //    任何仓内命令之前把 PATH 复位到冻结值（工具链就位之前用第一份、之后用合成那份）——
    //    复位方向与攻击相反（攻击往 PATH **前面**塞假 bin），形态逐字登记。
    const composeIndex = steps.findIndex(step => typeof step?.id === 'string' && step.id.trim() === FROZEN_TOOLCHAIN_STEP_ID)
    const composeScript = composeIndex < 0 ? '' : scripts[composeIndex]
    if (composeIndex < 0) {
      jobFailures.push({
        name: file,
        line: 0,
        detail: `[SK-20] job \`${jobId}\` 里没有 \`id: ${FROZEN_TOOLCHAIN_STEP_ID}\` 的**PATH 合成步** ——\n`
          + '  ⇒ 冻结步排在任何仓内执行点之前（位置即判据），它抓到的 `path` 是"工具链之前"那份；'
          + '判据步要么复位成它（`Full gate` 经 `corepack yarn` 起包级 check 时工具链解析不到），'
          + '要么复位成"合成份"——而合成份必须由**登记过的白名单规则**产生，不能就地拼字符串。',
      })
    } else {
      for (const fragment of FROZEN_TOOLCHAIN_FRAGMENTS) {
        if (composeScript.includes(fragment)) continue
        jobFailures.push({
          name: file,
          line: 0,
          detail: `[SK-20] job \`${jobId}\` 的 PATH 合成步里缺少 \`${fragment}\` —— 它必须：`
            + '① 从冻结输出取基准 PATH；② 只放行 `${{ runner.tool_cache }}/node/` 之下的新增目录'
            + '（runner 侧常量，仓内代码改不到）；③ 用 `$GITHUB_OUTPUT` 交出合成值；'
            + '④ 遇到任何其它新增目录就 `exit 1`（那正是 `$GITHUB_PATH` 注入的痕迹）。',
        })
      }
      if (composeIndex < freezeIndex) {
        jobFailures.push({
          name: file,
          line: 0,
          detail: `[SK-20] job \`${jobId}\` 的 PATH 合成步排在冻结步**之前** —— 它没有基准 PATH 可取。`,
        })
      }
      notes.push(`[SK-20] job \`${jobId}\` 的 PATH 合成步在第 ${composeIndex + 1} 步`
        + '（白名单目录 + 其它新增目录即红）')
    }
    let frozenCalls = 0
    let frozenPathSteps = 0
    steps.forEach((step, index) => {
      if (typeof step?.run !== 'string') return
      // 冻结步自己**豁免**：它跑在任何冻结值存在之前，`command -v node` 在这里是
      // "解析路径"而不是"启动判据"（冻结之后每一步都必须走冻结值）。
      if (index === freezeIndex) return
      // PATH 合成步也豁免：它就是"把冻结值变成可用值"的那一步，自身不跑仓内执行体。
      if (index === composeIndex) return
      const script = scripts[index]
      const label = `job \`${jobId}\` 的第 ${index + 1} 步「${stepName(step, index)}」`
      // ③a 判据步必须复位 PATH（形态 + 顺序都是判据）。
      if (isJudgeStepRun(step.run)) {
        const exportLine = frozenPathExportLine(step.run)
        const firstInvocation = firstJudgeInvocationLine(step.run)
        if (exportLine < 0) {
          jobFailures.push({
            name: file,
            line: 0,
            detail: `[SK-20] ${label} 是**跑仓内执行体的判据步**，但步骤体里没有`
              + ' `export PATH="${{ steps.<冻结点>.outputs.path }}"` ——\n'
              + '  ⇒ 冻结只罩住了"步骤命令位的启动器"：仓内 `.sh`/`.mjs` 体（以及它起的子进程）'
              + '里的裸 `node` 仍按**活 PATH** 解析，一个只拦某条判据、其余转发真 node 的假 `node`'
              + '（一行 `echo … >> $GITHUB_PATH`，不碰 git、不改被跟踪文件）就能把'
              + ' `pass=2 fail=1/EXIT=1` 翻成 `pass=3 fail=0/EXIT=0`（V13-A §3.3 端到端实测）。',
          })
        } else if (firstInvocation >= 0 && exportLine > firstInvocation) {
          jobFailures.push({
            name: file,
            line: 0,
            detail: `[SK-20] ${label} 的 PATH 复位排在第 ${exportLine + 1} 个逻辑行，`
              + `但它第 ${firstInvocation + 1} 个逻辑行就已经在跑仓内东西了 ——\n`
              + '  ⇒ 复位必须在**任何仓内命令之前**（晚一步，那之前的命令已经按活 PATH 解析过了）。',
          })
        } else if (firstInvocation >= 0) {
          frozenPathSteps += 1
          // ③b 外部命令登记制（V13-A §3.3 顺带点名的 `openssl`）：复位 PATH 之后它们与
          //     `node`/`git`/`bash` 同一解析面 ⇒ 不需要逐个写冻结点输出，但**新出现的**
          //     外部命令必须登记（登记表 = `FROZEN_LAUNCHER_EXTERNAL_TOOLS`，逐条带理由）。
          for (const tool of externalCommandWords(step.run)) {
            jobFailures.push({
              name: file,
              line: 0,
              detail: `[SK-20] ${label} 用了一个**未登记的外部命令** \`${tool}\` —— 判据步对外部`
                + '命令的解析面是那一行 `export PATH=…` 复位出来的 PATH，所以它们不需要各自写一个'
                + '冻结点输出；但"这一步能跑什么"必须进登记表（可评审的 diff）。'
                + `\n  ⇒ 登记进 \`FROZEN_LAUNCHER_EXTERNAL_TOOLS\` 并写清它在这条判据里干什么。`,
            })
          }
        }
      }
      const nodeHits = rawCommandPositionArgvs(script, 'node')
      const usesFrozenNode = step.run.includes(FROZEN_LAUNCHER_NODE_EXPRESSION)
      if (nodeHits.length > 0) {
        jobFailures.push({
          name: file,
          line: 0,
          detail: `[SK-20] ${label} 在**命令位**调用裸 \`node\`（${nodeHits.length} 处）—— 它的解析面是`
            + '步骤自己的 `$PATH`，而 `$GITHUB_PATH` 注入的目录会前置到它前面（R13-D-02 的载荷形态：'
            + '假 `node` 按 `--nonce-file` 把凭据自己回显回去）。'
            + "\n  ⇒ 判据步必须用 `\"${{ " + FROZEN_LAUNCHER_NODE_EXPRESSION + " }}\"`"
            + '（runner 侧展开的冻结绝对路径：步骤输出在步骤结束时被 runner 读走，后续仓内进程改不到）。',
        })
      }
      if (usesFrozenNode) frozenCalls += 1
      // `git show HEAD:<path>`：判据执行体的**来源**。假 `git` 可以让它吐出攻击者的字节。
      const gitHits = rawCommandPositionArgvs(script, 'git')
      const frozenGitGit = step.run.includes(FROZEN_LAUNCHER_GIT_EXPRESSION)
      if (gitHits.length > 0 && !frozenGitGit) {
        jobFailures.push({
          name: file,
          line: 0,
          detail: `[SK-20] ${label} 在**命令位**调用裸 \`git\`（${gitHits.length} 处）——`
            + '`git show HEAD:<判据执行体>` 是"探针来源"的取字节动作，假 `git`（PATH 注入）可以让'
            + '它吐出攻击者的字节，于是从 git 对象取执行体这条免疫整体失效。'
            + "\n  ⇒ 用 `\"${{ " + FROZEN_LAUNCHER_GIT_EXPRESSION + " }}\"`"
            + '（冻结的绝对路径）。',
        })
      }
      // `bash <仓内脚本>`：仓内脚本的解释器同样是"启动器"。
      const bashHits = rawCommandPositionArgvs(script, 'bash').filter(hit => /(?:^|\/)(?:scripts|packages)\/\S+/u.test(hit.join(' ')))
      if (bashHits.length > 0 && !step.run.includes(FROZEN_LAUNCHER_BASH_EXPRESSION)) {
        jobFailures.push({
          name: file,
          line: 0,
          detail: `[SK-20] ${label} 用裸 \`bash\` 执行仓内脚本（${bashHits.length} 处）——`
            + '假 `bash`（PATH 注入）可以在这条链上换掉脚本行为。'
            + "\n  ⇒ 用 `\"${{ " + FROZEN_LAUNCHER_BASH_EXPRESSION + " }}\"`。",
        })
      }
    })
    if (frozenCalls === 0) {
      jobFailures.push({
        name: file,
        line: 0,
        detail: `[SK-20] job \`${jobId}\` 里没有任何步骤使用冻结的 node 启动器`
          + `（\`${FROZEN_LAUNCHER_NODE_EXPRESSION}\`）—— 冻结步存在但没被用上等于没有收口。`,
      })
    }
    // ③ 行为探针必须真的被**永不跳过**的那个 job 执行（`gate-guards`：docs-only 的 PR 也跑它；
    //    要求每个 job 各跑一遍只是把同一件事做两次，成本换不来新的证据）。
    const probeSteps = steps
      .filter(step => typeof step?.run === 'string'
        && commandPositionArgvs(executableScript(step.run), FROZEN_LAUNCHER_PROBE).length > 0)
    if (probeSteps.length === 0 && FROZEN_LAUNCHER_PROBE_JOBS.includes(jobId)) {
      jobFailures.push({
        name: file,
        line: 0,
        detail: `[SK-20] job \`${jobId}\` 里没有步骤在**命令位**执行行为探针 \`${FROZEN_LAUNCHER_PROBE}\` ——`
          + '静态判据只能证明"文本形态对"；跑一遍才能证明"PATH 注入换不掉启动器"'
          + '（探针内部自带正控：拆掉冻结点后同一个载荷必须能把判据换掉，否则探针自己就是恒绿）。',
      })
    }
    failures.push(...jobFailures)
    if (jobFailures.length === 0) {
      notes.push(`[SK-20] job \`${jobId}\` 的启动器已冻结:冻结步在第 ${freezeIndex + 1} 步(输出 `
        + `${FROZEN_LAUNCHER_OUTPUT_KEYS.join('/')} · 冻结调用 ${frozenCalls} 处 · 裸 node 0 处)`
        + ` · PATH 复位 ${frozenPathSteps} 个判据步 · 行为探针 ${probeSteps.length} 处`)
    }
  }
  return failures
}

// ===== SK-21:"永不跳过"的守卫 job 的**权限面**必须逐字登记（第十三轮 C-05，P3） =====
//
// 现场（第十三轮 C 泳道）：给 `gate-guards` 加 `permissions: contents: write`，
// `check-workflows` EXIT=0（绿）—— 那个 job 是"永不跳过"的守卫 job，却可以带着写权限跑，
// 而权限面此前只继承 workflow 顶层的 `contents: read`，没有任何静态判据盯它。
// 同族的 `strategy` / `timeout-minutes` 取值面也是同样的"未被管"，但它们的失败方向是
// fail-safe（矩阵任一腿红则 job 红、超时只会更容易失败），所以只登记**权限**这一条
// （能改变"这一步能做什么"的那一条）。
/**
 * 「永不跳过的守卫 job」的权限面登记表（逐字相等；缺省/多键/取值不同都红）。
 * 加一条 = 显式的、可评审的决定（并写清那个 job 为什么需要它）。
 */
const PINNED_JOB_PERMISSIONS_REGISTRY = [
  {
    job: 'gate-guards',
    // 只读：它取仓、跑根守卫、跑两个 install 期锚与行为探针 —— 没有任何一步需要写仓库。
    permissions: { contents: 'read' },
    why: '永不跳过的守卫 job：它只读仓（检出 + 判据），写权限对它没有任何用途；'
      + '给它 `contents: write` 等于让"永不跳过"的那条链带上仓库写面（第三轮 C-05 实测 EXIT=0）。',
  },
]

/**
 * [SK-21] 「永不跳过的守卫 job」的权限面判据。
 * @param file - workflow 文件名。
 * @param document - parseYaml 的结果。
 * @param notes - 提示收集器。
 * @param options - `{ scannedFile }`（只对真实的那份 workflow 判）。
 * @returns 失败项列表。
 */
function checkPinnedJobPermissions(file, document, notes, options = {}) {
  const failures = []
  if (options?.scannedFile !== VERDICT_WORKFLOW_FILE) return failures
  const jobs = typeof document?.jobs === 'object' && document.jobs !== null ? document.jobs : {}
  for (const entry of PINNED_JOB_PERMISSIONS_REGISTRY) {
    const job = jobs[entry.job]
    if (job === undefined || job === null) {
      failures.push({
        name: file,
        line: 0,
        detail: `[SK-21] 登记的 job \`${entry.job}\` 不在本 workflow 里 —— `
          + '`PINNED_JOB_PERMISSIONS_REGISTRY` 的每一条都是"这个 job 的权限面被钉死"的登记。',
      })
      continue
    }
    const actual = job.permissions
    const expected = entry.permissions
    const normalize = value => (typeof value === 'object' && value !== null
      ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)]).sort())
      : value ?? null)
    const same = JSON.stringify(normalize(actual)) === JSON.stringify(normalize(expected))
    if (!same) {
      failures.push({
        name: file,
        line: 0,
        detail: `[SK-21] job \`${entry.job}\` 的 \`permissions\` 与登记值不一致：\n`
          + `      登记：${JSON.stringify(expected)}\n      实际：${JSON.stringify(actual ?? null)}\n`
          + `  ⇒ ${entry.why}\n`
          + '  ⇒ 要改权限面必须同步改 `PINNED_JOB_PERMISSIONS_REGISTRY`（进 diff、可评审）。',
      })
    } else {
      notes.push(`[SK-21] job \`${entry.job}\` 的权限面逐字等于登记值（${JSON.stringify(expected)}）`)
    }
  }
  return failures
}

// ===== SK-22:表达式的**词法字符集**（2026-09-25 第十四轮现场：整个 workflow 解析失败 ⇒ 0 job）=====
//
// 现场:`.github/workflows/ci.yml` 里一个 `run: |` 块的 **shell 注释**中写了
// `# … "${{ …outputs.interp }}" scripts/<x>.sh 只冻结了解释器 …`,其中 `…` 是 U+2026。
// YAML 完全合法;`bash -n` 完全合法(那只是一行注释);本文件此前所有判据都看不见它。
// 推上 GitHub 后**整条 CI 一个 job 都没起来**:run 是 0 秒 / 0 job 的 startup_failure,
// `pull_request` 事件下连 run 都没创建(同提交的 CodeQL 照常跑),PR 因此永远等不到检查。
//
// 判据层的关键事实(这条判据存在的全部理由):**GitHub 的模板/表达式解析不理会 shell 注释**
// —— `${{` 出现在 `run:` 标量的**任何位置**(含 `#` 注释行、heredoc、字符串字面量内部)
// 都会开始一个表达式,并且必须在**解析期**合法。所以"它只是注释 / 只是字符串"不是豁免理由。
// 反过来,`'…'` 单引号字面量是**表达式自己的**语法(`''` 是"一个字面单引号"的转义写法),
// 字面量内部的字符不参与词法 —— 中文标签、`'refs/tags/v'` 里的 `/`、`format('{0}')` 里的
// 花括号都因此必须放行(下面的 `w36`/`w37` 就是钉这两格的绿样本)。
//
// 字符集来源:GitHub 表达式词法器允许的字符。对拍物 = 本机 actionlint 的报错原文
// (`got unexpected character '…' while lexing expression, expecting 'a'..'z', 'A'..'Z',
// '_', '0'..'9', ''', '}', '(', ')', '[', ']', '.', '!', '<', '>', '=', '&', '|', '*',
// ',', ' '`)。本判据把 `'''` 单独处理(字面量剥离),再补一个 `-`(负数字面量:
// `${{ -1 < 0 }}` 实测 actionlint EXIT=0)。
//
// **这是近似,不是复刻**(诚实的边界,写在这里免得被当成"等价于真实解析器"):
//   · `-` 只在负数字面量里合法 —— 实测 `${{ github.run_number - 1 }}` 被 actionlint 拒
//     ("while lexing integer part of number, expecting '0'..'9'"),而本判据整体放行 `-`;
//   · 判据是"表达式可解析"的**必要条件**而非充分条件:`${{ 1 2 }}` 这类**语法**错误
//     (字符全合法)漏判;`${{ github.ref }} }}` 这种多余 `}` 会被判红(单 `}` 不在集合里);
//   · 表达式之外的解析期拒绝面(重复键 / 别名循环 / `on:` 形态)不在这里,见 [SK-19] 等。
// 结论性证据仍然是"真实 push 之后 run 真的起来"—— 本判据只能把这一类**字符级**的
// 解析期失败拦在本地,拦不到的形态必须在别处有判据(报告里逐条认账)。
/**
 * 表达式体里允许出现的 ASCII 标点。
 *
 * 与 actionlint 的期望集合逐字对齐(见上面的注释),`'` 由 {@link checkExpressionCharacterSet}
 * 在扫描时单独处理(字面量剥离),`-` 是本判据有意补的一项(负数字面量)。
 */
const EXPRESSION_ALLOWED_PUNCTUATION = new Set(['_', '.', '(', ')', '[', ']', '!', '<', '>', '=', '&', '|', '*', ',', '-'])
/** 空白字符(表达式可以跨行:`${{ github.event_name\n  == 'push' }}`)。 */
const EXPRESSION_WHITESPACE = new Set([' ', '\t', '\n', '\r'])
/**
 * 一个文件最多逐条打印几处非法字符。超出的部分用一条汇总失败项接着报 ——
 * 既不静默吞掉(数量与首个位置still可见),也不让一个被写坏的文件刷出几千行。
 */
const EXPRESSION_OFFENDER_REPORT_LIMIT = 8

/**
 * 单个字符是否落在表达式词法器允许的集合里。
 * @param character - 单个 code point(调用方已保证不是 `'`,字面量在扫描时整体跳过)。
 * @returns 允许 = true。
 */
function isAllowedExpressionCharacter(character) {
  if (EXPRESSION_WHITESPACE.has(character)) return true
  if (EXPRESSION_ALLOWED_PUNCTUATION.has(character)) return true
  const code = character.codePointAt(0)
  if (code >= 0x30 && code <= 0x39) return true // 0-9
  if (code >= 0x41 && code <= 0x5a) return true // A-Z
  if (code >= 0x61 && code <= 0x7a) return true // a-z
  return false
}

/**
 * 把文本里的每个字符映射成 `{line, column}`(1 起,按 GitHub/Actions 日志的习惯列号从 1 开始)。
 * 只对**要报出来的位置**调用(非法字符数被 {@link EXPRESSION_OFFENDER_REPORT_LIMIT} 限住)。
 * @param text - workflow 全文。
 * @param offsets - 升序的字符下标。
 * @returns 与 offsets 等长的位置数组。
 */
function positionsAt(text, offsets) {
  const starts = [0]
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') starts.push(index + 1)
  }
  return offsets.map(offset => {
    let low = 0
    let high = starts.length - 1
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      if (starts[mid] <= offset) low = mid
      else high = mid - 1
    }
    return { line: low + 1, column: offset - starts[low] + 1 }
  })
}

/** 码点转 `U+XXXX`(超出 BMP 的用 5-6 位,与 Unicode 的写法一致)。 */
function codePointLabel(character) {
  return `U+${character.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`
}

/** 把一段文本压成单行、截断(诊断里回显表达式片段用)。 */
function truncateForDiagnostic(text, limit = 120) {
  const flat = text.replace(/\s+/gu, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`
}

/**
 * [SK-22] 表达式词法字符集判据(现场与边界见上面的常量区注释)。
 *
 * 扫描面 = **workflow 全文**(不只是"代码行"):`run:` 的 `#` 注释、heredoc、YAML 字符串
 * 里的 `${{` 一样会被 GitHub 展开,一样必须在解析期合法。判定顺序:
 *   ① 找 `${{`,再找它后面**第一个** `}}`(与模板读取器的"字面终止符"语义一致);
 *      找不到 ⇒ 未闭合,**fail-closed 判红**(不猜意图,也不静默放行);
 *   ② 表达式体为空 ⇒ 判红(actionlint 对 `${{ }}` 报
 *      `unexpected end of input while parsing …`,实测 EXIT=1);
 *   ③ 在体内扫描:遇到 `'` 就整体跳过一个字符串字面量(`''` = 转义),字面量没闭合也判红;
 * 扫描面 = **workflow 全文**(不只是"代码行"):`run:` 的 `#` 注释、heredoc、YAML 字符串
 * 里的 `${{` 一样会被 GitHub 展开,一样必须在解析期合法。判定顺序:
 *   ① 从 `${{` 起**单趟**走:遇到 `'` 就进入字符串字面量(`''` = 一个转义的字面单引号),
 *      字面量**内部**的 `}}` 不算终止符 —— 与真实解析器同形(`${{ format('{0}}}', x) }}`
 *      实测 actionlint EXIT=0,即字符串感知的取体);不在字面量里的第一个 `}}` = 表达式结束;
 *   ② 走到文件结尾都没有结束标记 ⇒ **fail-closed 判红**,并且按"停在哪"给更准的诊断:
 *      停在字面量里 = 字面量没闭合(它把后面的 `}}` 一起吞了),否则 = 表达式未闭合;
 *   ③ 表达式体为空 ⇒ 判红(actionlint 对 `${{ }}` 报
 *      `unexpected end of input while parsing …`,实测有错);
 *   ④ 其余每个字符必须落在 {@link isAllowedExpressionCharacter} 的集合里。
 *
 * @param file - workflow 文件名。
 * @param text - workflow 全文。
 * @param notes - 提示收集器。
 * @returns `{failures, expressions, literals}`(`expressions` 供 main() 做"扫描器退化"对账)。
 */
function checkExpressionCharacterSet(file, text, notes) {
  const failures = []
  const offenders = []
  let expressions = 0
  let literals = 0
  let cursor = 0
  let unterminated = null
  for (;;) {
    const open = text.indexOf('${{', cursor)
    if (open < 0) break
    // 单趟:取结束标记 + 逐字符判字符集 + 数字面量。
    const pending = []
    let index = open + 3
    let inLiteral = false
    let literalStart = -1
    let close = -1
    while (index < text.length) {
      const character = text[index]
      if (inLiteral) {
        if (character !== "'") {
          index += 1
          continue
        }
        if (text[index + 1] === "'") {
          index += 2
          continue
        }
        inLiteral = false
        literals += 1
        index += 1
        continue
      }
      if (character === "'") {
        inLiteral = true
        literalStart = index
        index += 1
        continue
      }
      if (character === '}' && text[index + 1] === '}') {
        close = index
        break
      }
      if (!isAllowedExpressionCharacter(character)) {
        pending.push({ kind: 'character', index, character })
      }
      index += 1
    }
    if (close < 0) {
      // 未闭合:它之后**还剩几处** `${{` 一起报出来(同一个坏文件里往往不止一处)。
      // 这一段的字符不逐条报(表达式本该在哪里结束已经无从判断,报出来只会是噪音)。
      unterminated = {
        open,
        literalStart: inLiteral ? literalStart : -1,
        remaining: text.slice(open + 3).split('${{').length - 1,
      }
      break
    }
    expressions += 1
    const body = text.slice(open + 3, close)
    // 空表达式(`${{ }}` / `${{   }}`):没有字符可判,但它本身不是合法表达式。
    if (body.trim() === '') pending.push({ kind: 'empty', index: open + 3 })
    for (const entry of pending) offenders.push({ ...entry, snippet: body })
    cursor = close + 2
  }

  if (unterminated !== null) {
    const [where] = positionsAt(text, [unterminated.open])
    if (unterminated.literalStart >= 0) {
      const [literalWhere] = positionsAt(text, [unterminated.literalStart])
      failures.push({
        name: file,
        line: literalWhere.line,
        detail: `[SK-22] 表达式里的单引号字面量没有闭合,位置 ${file}:${literalWhere.line}:${literalWhere.column}`
          + `(该 \`\${{ \` 在 ${file}:${where.line}:${where.column};其后还有 ${unterminated.remaining} 处 \`\${{ \`)\n`
          + '  ⇒ 表达式里表示一个**字面单引号**要写两个(`\'\'`);单个 `\'` 会一直吃到文件结尾,'
          + '连它后面的 `}}` 也被吞掉(字符串感知的取体是这样,真实解析器同样报'
          + ' "unexpected EOF while lexing end of string literal")⇒ 整个 workflow 解析失败。\n'
          + '  ⇒ 与未闭合表达式同一口径:**fail-closed**,不放行。',
      })
    } else {
      failures.push({
        name: file,
        line: where.line,
        detail: `[SK-22] \`\${{ \` 没有配对的 \`}}\`(未闭合表达式),位置 ${file}:${where.line}:${where.column}`
          + `(其后还有 ${unterminated.remaining} 处 \`\${{ \`)\n`
          + '  ⇒ GitHub 的模板读取器以字面 `}}` 作为表达式结束标记:找不到就是"这份 workflow 无法解析"'
          + ' —— 与非法字符同一类后果(整个文件 0 job,PR 上连 run 都不创建)。\n'
          + '  ⇒ 这里按 **fail-closed** 判:没有终止符的 `\${{ ` 之后的任何形态都不放行'
          + '(不猜"它是不是只想当字面量"—— 模板展开不看上下文)。',
      })
    }
  }
  if (offenders.length > 0) {
    const reported = offenders.slice(0, EXPRESSION_OFFENDER_REPORT_LIMIT)
    const positions = positionsAt(text, reported.map(entry => entry.index))
    reported.forEach((entry, order) => {
      const { line, column } = positions[order]
      const at = `${file}:${line}:${column}`
      if (entry.kind === 'empty') {
        failures.push({
          name: file,
          line,
          detail: `[SK-22] 表达式体为空:\`\${{ }}\`,位置 ${at}\n`
            + '  ⇒ 空表达式不是合法表达式(actionlint 实测报 "unexpected end of input while parsing '
            + 'variable access, function call, null, bool, int, float or string")⇒ 整个 workflow 解析失败。',
        })
        return
      }
      failures.push({
        name: file,
        line,
        detail: `[SK-22] 表达式体里有词法非法字符 \`${entry.character}\`(${codePointLabel(entry.character)}),位置 ${at}\n`
          + `      该表达式:\`\${{ ${truncateForDiagnostic(entry.snippet ?? '')} }}\`\n`
          + '  ⇒ GitHub 的模板/表达式解析**不理会 shell 注释**:`\${{ ` 出现在 `run:` 标量里的任何位置'
          + '(含 `#` 注释行、heredoc、字符串内部)都会开始一个表达式,且必须在**解析期**合法。\n'
          + '     这个字符让**整个 workflow 解析失败** —— run 起来是 0 秒 / 0 个 job(startup_failure),'
          + '`pull_request` 事件下连 run 都不会创建,PR 永远等不到检查(第十四轮现场)。\n'
          + '  ⇒ 合法字符集:`A-Z a-z 0-9 _ . ( ) [ ] ! < > = & | * , -` 与空白;'
          + "单引号字面量(`'…'`,`''` 表示一个字面单引号)内部的字符不参与词法。\n"
          + '  ⇒ 修法:把该字符移进单引号字面量,或改成 ASCII 写法(例如 `...` 代替 `…`)。',
      })
    })
    if (offenders.length > reported.length) {
      failures.push({
        name: file,
        line: 0,
        detail: `[SK-22] 本文件还有 ${offenders.length - reported.length} 处非法字符未逐条打印`
          + `(上面只列了前 ${reported.length} 处)—— 判据同样把它们算作失败。`,
      })
    }
  } else {
    notes.push(`[SK-22] 表达式词法字符集:全文扫描到 ${expressions} 处 \`\${{ … }}\``
      + `(含 \`run:\` 的 \`#\` 注释行 / heredoc,注释不是豁免理由),剥掉 ${literals} 处单引号字面量后`
      + '剩余字符全部落在表达式词法器允许的集合里')
  }
  return { failures, expressions, literals }
}

/**
 * [SK-17]（第十二轮红队 C-P0-1）**`defaults.run.shell`** 的登记表（**空表 = 禁止声明**）。
 *
 * 现场：workflow 顶层 `defaults: { run: { shell: … } }` 作用于**每个 job 的每个 step**，
 * 而它此前不在任何判据面里 —— `shellSteps()` 只解析 step 级与 job 级的 `defaults.run.shell`，
 * 顶层那份被静默忽略（`item.shell` 回落到 `bash`，于是 [SK-14⑦]/[SK-7a] 的 shell 判据
 * 全部以为这一步跑在 bash 里）。加一个顶层 `defaults.run.shell` 就能让所有 `run:` 块
 * 换解释器（`python`/自定义包装器），而"命令位/argv/步骤体"三条判据一字未改。
 *
 * 条目形态：`{ scope: 'workflow' | 'job', job: <jobId|null>, shell: <逐字取值>, why }`。
 */
const PINNED_DEFAULT_SHELL_REGISTRY = []
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
/**
 * W-4 的判定范围(前两段与组 3 同面;`internal/marketplace`/`internal/agentshare` 是
 * 2026-09-23 第三轮修复按 F8 补的 —— 渠道命名空间守卫(A-8)的用例全在这两个包里,
 * 且它们**依赖真 PG**:PG 不可达时 `serverstore.NewTestDB` 会整包 `t.Skip`
 * ("DB test skipped: postgres unavailable"),旧范围下"整包静默跳过"是绿的。
 * 真库实测两包用例级 skip = 0 ⇒ 纳入判定面不会造成假红。全仓套"零 skip"仍会因
 * `internal/serverstore` 的 DST 这类**环境条件型** skip 变成每次必红。
 * 改这里必须同步 `scripts/verify-ci-scripts.mjs` 的登记值(它真跑判定脚本并逐字
 * 比对 ci.yml 的 `--scope`)。
 */
const WASM_CASE_GATE_SCOPE = ['internal/wasmapp', 'internal/router', 'internal/marketplace', 'internal/agentshare']
/** W-5 的探针组与它必须带的"非覆盖平台显式 SKIP"开关。 */
const WASM_PROBE_GROUPS = ['6']
const WASM_PROBE_ENV = 'WASM_GATE_REQUIRE_COVERED_PLATFORM'
/**
 * W-8 接线的后半(2026-09-23):跑 WASM 门禁的每一步都必须把**结论**钉在权威 HEAD 上。
 * 变量名与取值都登记在这里(脚本侧 `scripts/verify-wasm-client-only.sh` 的跑前校验读它;
 * `scripts/verify-ci-scripts.mjs` 会从 ci.yml 抽出真值并**实跑**脚本证明这个名字被认)。
 */
const WASM_GATE_EXPECT_HEAD_ENV = 'WASM_GATE_EXPECT_HEAD'
const WASM_GATE_EXPECT_HEAD_VALUE = '${{ github.sha }}'

// ===== SK-13:触发面(`on:`)的业务契约 =====
//
// 现场(2026-09-23 第四轮审计 R4-A-3):本脚本全文对 `on:` **零判据**(SK-8/SK-8b/SK-9/
// SK-10/SK-11/SK-12 六条策略全部只看 job/step 的内容)。把 `ci.yml` 的
//     on:
//       pull_request:
//       push:
// 改成只留 `pull_request:`(一次一行删除)之后,本门禁与 `verify-ci-scripts.mjs` 全绿 ——
// 而后果是**整条发布链静默消失**:tag push 不再触发 workflow ⇒ `release` job、
// `gh release create`、R2 `publish-update-server`、mac 签名+公证 job 全部不会启动;
// 连流水线**自己内部**的那批检查(`ci-release-policy.sh` 的 tag 形态判定、
// `docs/releases/<tag>.md` 策展说明检查、tag 上的根守卫)也一起消失。因为
// `pull_request:` 还在,**引入这个改动的 PR 自己会拿到全绿检查并通过分支保护**。
// 同一次探测的另两种形态(`on:` 只留 `workflow_dispatch` / 给 push 与 pull_request
// 加 `branches: [never-exists]`)同样全绿。
//
// 登记值(依据 `AGENTS.md` 的 CI 段与 `docs/decisions/2026-09-06-ci-pipeline-redesign.md`:
// 「触发 = `pull_request` + `push`(全分支含 tag)。**每个提交都产出可下载产物**……
// tag 走 mac 签名 + release job 发布」 ⇒ 触发面本身就是交付契约的一部分):
//   ① 承载发布链 / 全量门禁的 workflow 必须同时有 `pull_request` 与 `push`;
//   ② `push` 必须是**未加过滤**的 —— `branches` / `branches-ignore` / `tags` /
//      `tags-ignore` / `paths` / `paths-ignore` 任意一个都会把 tag 或一部分分支从触发面
//      里摘掉(`branches` 与 `tags` 同时给出时是 AND 关系,写 `branches: [master]` 就等于
//      "`v*` tag 不再触发发布"),所以登记形态只有"不写任何过滤键"这一种;
//   ③ `pull_request` 同样不得收窄(受保护的 PR 形态必须都被检查);
//   ④ `workflow_dispatch` 可有可无,但**出现即登记**:触发键集合必须 ⊆ 登记集合,
//      新增 `schedule` / `workflow_run` 之类必须在这里登记并写明理由;
//   ⑤ 只有 `workflow_dispatch`(或任何"没有 push/pull_request"的形态)= 红。
//
// 契约挂在哪个 workflow 上(两个锚点,缺一不可):
//   · 文件名锚点:`ci.yml` —— 本仓承载发布链的那个 workflow;
//   · 内容锚点:可执行文本里出现发布链命令(`RELEASE_LINE_ANCHORS`)—— 改名/搬走时契约
//     跟着走,不会因为"文件不叫 ci.yml 了"而静默失效(第四轮审计 R4-A-3 的附注:
//     改名后的"红"此前只是 SWALLOW_ALLOWLIST 失配的副作用,不是有意识的判据)。
const RELEASE_LINE_WORKFLOW = 'ci.yml'
/** 发布链的内容锚点(**可执行文本**里的命令;注释里写不算)。 */
const RELEASE_LINE_ANCHORS = ['ci-publish-update-server.sh', 'gh release create', 'gh release edit']
/** 必须存在的触发键。 */
const REQUIRED_TRIGGERS = ['push', 'pull_request']
/** 被登记过的触发键(`workflow_dispatch` 可有可无,但只有登记过的键才允许出现)。 */
const REGISTERED_TRIGGERS = ['push', 'pull_request', 'workflow_dispatch']
/** 会收窄触发面的过滤键(登记形态 = 这些键一个都不出现)。 */
const TRIGGER_NARROWING_KEYS = ['branches', 'branches-ignore', 'tags', 'tags-ignore', 'paths', 'paths-ignore']

// ===== SK-14:被钉住的判据步骤必须**可执行**(不是"文本还在") =====
//
// 现场(2026-09-23 第四轮审计 R4-A-5):SK-8/SK-9/SK-12 把若干步骤钉成"必须存在",但判据
// 只问**文本存在性**。给步骤加一行 `if: false`(`run` 一字不改)之后实测:
//   · 「Go tests (repo-wide) + WASM case-level report」 → **全绿**:整套 Go 测试(含
//     `-json` 报告 + `check-go-test-json.mjs` 的"用例级 0 skip / 三条关键用例确实 pass /
//     退出码 0-1-2 三段可区分")静默不跑,而必需的 **Go server** 检查仍然是绿的;
//   · 「Root guards must have passed」 → **全绿**:docs-only 的 PR 上"守卫失败 ⇒ 必需的
//     Gate 检查也红"这条**唯一链路**被摘除(第三轮 C-3 / 线上 PR #129 的复发路径)。
// 根因两处:SK-9③ 只正则匹配 `run` 文本;SK-12 的 `if:` 判据只认**字符串**形态
// (`typeof step.if === 'string'` ⇒ YAML 里的布尔 `false` 直接漏掉)。
//
// 判据(对每个"被钉住的判据步骤"):
//   ① 不得是**常量假** `if:`(`false` / `'false'` / `${{ false }}` / `0` / 空串);
//   ② `if:` 只允许该步骤**登记过的形态**(见 PINNED_STEP_IF_POLICIES),否则一律拒 ——
//      需要新形态就把形态登记进去并写明理由,与白名单同一套纪律;
//   ③ 不得 `continue-on-error`(表达式形态静态求不出真假,同样按"会静默"处理);
//   ④ `run` 不得被吞掉退出码 —— **复用 [SK-7a] 的同一份谓词与白名单**(`SWALLOW_PATTERNS`
//      + `isSilentSuccessTail`):这里要的是"钉住的步骤必须真的能失败",不是再发明一套
//      吞码语法;
//   ⑤ 所在 job 不得是常量假 `if:`(job 被跳过 = 里面的步骤一样不跑)。
/** 被钉住的判据步骤:**识别口径**与 `if:` 允许形态(登记表)。 */
const PINNED_STEP_POLICIES = [
  {
    id: 'full-root-gate',
    label: '全量根门禁(`yarn check`)',
    // 与 [SK-8]/[SK-9] 同一份识别口径:参数向量为空的全量根门禁（`yarn check` 或
    // `node scripts/check-workspaces.mjs` —— 见 `ROOT_GATE_DIRECT_INVOCATION`）。
    match: script => rootGateInvocations(script).some(hit => hit.mode === 'check' && hit.args.trim() === ''),
    ifPolicy: 'fail-safe-docs-only',
  },
  {
    id: 'root-guard-runner',
    label: `根守卫运行步(\`${DOCS_ONLY_GUARD_RUNNER}\`)`,
    // **命令位**判据(第九轮审计 B 泳道 P1-1):`includes` 只证明"文本里提到过" ——
    // `: <脚本>` / `test -f <脚本>` / `echo "node <脚本>"` 三种写法都让这一步零执行,
    // 而当时的判据（含 5/5 覆盖下限与 argv 钉子）全部满足、门禁 EXIT=0。
    match: script => guardRunnerCommandProblem(script) === null,
    ifPolicy: 'never',
  },
  {
    id: 'root-guard-link',
    label: '守卫结果链路步(`needs.<job>.result` 驱动)',
    // **识别不能自指**(2026-09-24 第八轮审计 R8-C-2):旧口径要求"文本里有 `exit [1-9]`",
    // 于是"这一步算不算被钉住"取决于它**还没被掏空** —— 把收尾 `exit 1` 改成注释
    // (`# exit 1`,保留 `true`)之后它不算被钉步骤 ⇒ 步骤体判据(⑥)整条不执行,门禁 EXIT=0
    // 而这一步真实退出码 0。现在按**结构**认:只要这一步引用了别的 job 的 `result`
    // (写在 `if:` 或可执行文本里),它就是"因为某条链路没成功才存在"的步骤 ⇒ 必须真的能失败。
    // 代价(认账):将来若新增一个"引用别的 job result"的步骤,它也会被要求走登记形态 ——
    // 这是 fail-closed 的方向,且报错会点名 `PINNED_STEP_IF_POLICIES` 的登记办法。
    match: (script, item) => needsResultReference(script, item?.step?.if),
    ifPolicy: 'needs-result',
    // **逐字登记**（2026-09-23 第六轮审计 R6-C-2）。这一步是"根守卫失败 ⇒ 必需 Gate 变红"
    // 的**唯一**链路（`gate-guards` 自己不在分支保护的必需检查里）。旧判据只要求 `if:`
    // 里出现 `needs.<job>.result` 子串 ⇒ 任意合取项都能让它永不执行而门禁全绿，实测两种形态：
    //   `if: needs.gate-guards.result != 'success' && github.event_name != 'pull_request'`
    //   `if: needs.gate-guards.result != 'success' && github.repository_owner == 'nobody'`
    // 都 EXIT=0。现在只认下面这个**逐字**取值；要新形态必须先登记进本表并写明理由。
    ifValues: ["needs.gate-guards.result != 'success'"],
    // ⑥ **步骤体**判据（第六轮独立复审 V2 边界③）：`if:` 逐字合法**不等于**这一步真的会红。
    // 把 `run` 换成"结构上不可能失败、但仍含 `exit 1` 与 `needs.*.result` 子串"的惰性形态
    // （多行 diff）此前 EXIT=0 ⇒ 唯一链路可被掏空。判据见 `pinnedStepFailureTailProblem`。
    requireUnconditionalFailure: true,
  },
  {
    id: 'wasm-case-gate',
    label: `用例级判定(\`${WASM_CASE_GATE_SCRIPT}\`)`,
    match: script => script.includes(WASM_CASE_GATE_SCRIPT),
    ifPolicy: 'never',
  },
  {
    // R12-D-04（P2，第十二轮红队）：这一步是"判据本体的内容摘要 ↔ 登记值"的承重判据，
    // 却**从未**进过本表 —— 三种变异实测 `check-workflows` EXIT=0：
    //   · `if: false`（M11）/ `if: ${{ false }}`（M5）：步骤永不执行，而 [SK-17] 只看得见
    //     `env:` 层，[SK-8]/[SK-9]/[SK-15] 只问"文本在不在"；
    //   · 删掉 `--require-clean`（M10）：git 锚定从 CI 硬判据降级成本地告警（J1 复审 N2 ②）。
    // 识别口径与守卫运行步同一套：**命令位**必须真的执行那个脚本（`:` / `test -f` / `echo` 不算）。
    id: 'guard-parser-integrity',
    label: `守卫解析器完整性步(\`${GUARD_PARSER_SCRIPT}\`)`,
    match: script => commandPositionArgvs(script, GUARD_PARSER_SCRIPT).length > 0,
    ifPolicy: 'never',
  },
  {
    // R12-D-01（P0，第十二轮红队）：install 期的判据本体完整性前置校验。
    // 它的**位置**是判据的一部分（必须在任何 yarn/corepack 命令之前，见 [SK-14⑨]），
    // 这里只负责"这一步本身不会被静默"：`if: false` / `continue-on-error` / 吞码 / 换 shell。
    id: 'install-integrity-precheck',
    label: `install 期判据本体完整性前置校验(\`${INSTALL_INTEGRITY_PRECHECK}\`)`,
    // 识别口径 = "**这一步是它所在 job 里第一个执行前置校验的步骤**"：判据步骤体里也有
    // `git show HEAD:scripts/check-install-integrity.mjs`（把探针从 git 对象取出来做免疫），
    // 若按"文本里出现即命中"，`Full gate` 那条（带 docs-only 的 `if:`）会被误判成前置校验步
    // ——那是与它意图无关的假红。位置本身也是判据（见 [SK-14⑨]）。
    match: (script, item) => {
      if (!executesInstallPrecheck(script)) return false
      const steps = Array.isArray(item?.job?.steps) ? item.job.steps : []
      const first = steps.findIndex(candidate => typeof candidate?.run === 'string'
        && executesInstallPrecheck(executableScript(candidate.run)))
      return first === item?.index
    },
    ifPolicy: 'never',
  },
  {
    id: 'wasm-probe',
    label: 'WASM 协议探针(`verify-wasm-client-only.sh`)',
    match: script => script.includes('verify-wasm-client-only.sh'),
    ifPolicy: 'fail-safe-docs-only',
  },
  {
    // [SK-20]（第十三轮红队 R13-D-02，P0）：**冻结启动器的行为探针**。
    // 它是"PATH 注入换不掉判据启动器"这条承诺的**唯一**运行级证据（静态面只能证明文本形态）；
    // 与 `guard-parser-integrity` 同族：`if: false` / 删掉调用都能让它静默，而静态面全绿。
    id: 'frozen-launcher-probe',
    label: `冻结启动器行为探针(\`${FROZEN_LAUNCHER_PROBE}\`)`,
    match: script => commandPositionArgvs(script, FROZEN_LAUNCHER_PROBE).length > 0,
    ifPolicy: 'never',
  },
]
/**
 * `if:` 允许形态的**登记值**。
 *   · `never` = 必须无条件运行(它本身就是"无论如何都要跑"的那一步);
 *   · `fail-safe-docs-only` = 只允许 docs-only 的 fail-safe 形态(`!= 'false'`,与
 *     [SK-9]④ 同一份口径 —— changes 失败/输出为空时走完整路径);
 *   · `needs-result` = **逐字**等于该策略条目上登记的 `ifValues` 之一(与
 *     `JOB_IF_POLICIES.exact` 同一范式)。**不接受子串匹配** —— "表达式里出现过
 *     `needs.<job>.result`"这个判据可以被任何合取项绕过(R6-C-2 的现场)。
 */
const PINNED_STEP_IF_POLICIES = {
  never: {
    check: () => false,
    describe: '不得带 `if:`(这一步必须无条件运行)',
  },
  'fail-safe-docs-only': {
    check: value => /needs\.changes\.outputs\.code\s*!=\s*'false'/u.test(value),
    describe: "只允许 `if: needs.changes.outputs.code != 'false'`(docs-only 的 fail-safe 形态)",
  },
  'needs-result': {
    check: (value, policy) => (policy?.ifValues ?? []).includes(String(value).trim()),
    describe: policy => `只允许**逐字**等于 ${
      (policy?.ifValues ?? []).map(item => `\`${item}\``).join(' 或 ') || '(该步骤没有登记任何取值)'
    }（不接受合取项/取反/换写法的收窄 —— 那会让这一步永不执行而门禁仍绿）`,
  },
}

// ===== SK-17:被钉住的判据步骤/作业的**进程环境层**(2026-09-25 第九轮审计 D 泳道 P1)=====
//
// 现场(第九轮审计 D 泳道,审计方实跑确认):第八轮把判据搬到"执行视角"是对的 —— 也就是说
// [SK-14] 现在读的是 argv / 解析后的 shell / 步骤体 / `$GITHUB_ENV`。但那四条通道**全都在
// "命令怎么被写出来"这一层**;进程环境层没有纳入判据面,于是两类形态可以**一个字都不改命令、
// 不新增任何脚本**,就让"永不跳过"的根守卫 job 静默变绿:
//
//   形态 A(零新增文件):
//     ```yaml
//     gate-guards:
//       env:
//         NODE_OPTIONS: "--import=data:text/javascript,process.on('exit',()=>{process.exitCode=0})"
//     ```
//     `node scripts/check-root-guards.mjs` 的 argv 一字未改、步骤体一字未改,但**每个 node
//     进程**退出时都会把 `process.exitCode` 改回 0 ⇒ 门禁 EXIT=0。实测:`gate-guards` 的
//     守卫步真跑在有 7 个守卫失败的树上,仍打印「16 个根守卫:16 通过、0 失败」并 EXIT=0。
//
//   形态 B(一个 20 字节的 hook 文件):
//     ```yaml
//     env:
//       BASH_ENV: ./.github/shell-hooks.sh   # 内含 node() { return 0; }
//     ```
//     非交互 bash 启动时会 source 它 ⇒ `node` 变成 shell 函数,守卫命令"跑是跑了",但
//     退出码恒 0。仓库里的 workflow 写的是哪一条命令完全不重要。
//
// 同族(同样改解释器行为、同样不改 argv/shell/步骤体):
//   · `NODE_PATH`      —— 改写模块解析路径(可把 `scripts/*.mjs` 解析到替身);
//   · `ENV`            —— POSIX `sh` 的启动文件(与 `BASH_ENV` 同族);
//   · `SHELLOPTS`/`BASHOPTS` —— 改写 bash 选项(`errexit`/`nounset` 等退出语义);
//   · `PROMPT_COMMAND` —— 注入同名函数/包装器;
//   · `PATH`           —— 让 `node` 解析到另一个二进制(命令名一字未改);
//   · `BASH_FUNC_<name>%%` —— **导出的 shell 函数**(`BASH_FUNC_node%%` 与形态 B 等价,
//     而且连 hook 文件都不需要);
//   · `LD_PRELOAD`/`LD_AUDIT` —— 动态链接器注入(可拦截 `exit`/`__libc_start_main`)。
//
// 判据(**白名单**,第十轮审计 C-01 把黑名单换成登记表):对被钉住的判定单元 ——
//   · [SK-14] 的 `PINNED_STEP_POLICIES` 命中的**判据步骤**(含 `gate` 的收尾链路步);
//   · **根守卫 job**(`SK-9②` 的同一份派生口径,即跑 `check-root-guards.mjs` 的那个 job)——
//     它的**每一个**步骤都算被钉(它是"永不跳过"的那个作业,任何一层 env 都在守卫链上);
// 下面**每一层**出现的 env 键都必须命中 `PINNED_ENV_ALLOWED_KEYS`(未登记即红,fail-closed):
//   ① workflow 顶层 `env:`(Actions 会把它注入每个 job 的每个 step);
//   ② job 级 `env:`;
//   ③ `jobs.<id>.container.env`(**Actions 的第四层**:该 job 所有 step 的容器环境变量;
//      第九轮的枚举漏了它,审计用一个键在 job 级被抓、在 container 级静默通过实测确认);
//   ④ step 级 `env:`(根守卫 job 里连 `uses:` 步骤一起查 —— 那一步也是守卫链的一部分);
//   ⑤ 同 job 内、**位置在被钉步骤之前**的步骤往 `$GITHUB_ENV` 写入的键(运行期注入,
//      `run` 文本里只有 `$VAR`),或往 `$GITHUB_PATH` 追加目录(PATH 覆写,无条件红);
//   ⑥ **被钉步骤自己的步骤体**里 `export` / 前缀赋值(`NODE_OPTIONS=… node …`)写出的键
//      (第十轮审计 D-03:一行 `export NODE_OPTIONS=…` 让根守卫打印「1 项未通过」却 EXIT=0,
//      而前三层判据一个字节都看不见它)。
// 层清单是 `PINNED_ENV_LAYER_REGISTRY`(唯一真源):通过行由**枚举结果**生成,`main()` 还会
// 断言产出的层 id 与该表双向一致 —— 声明与代码不可能再各写一份(C-02 的现场:日志硬编码
// "三层…均已检查",代码只枚举了三层)。
//
// 与 [SK-14] 的关系:`env:` **不是** `if:`/argv/shell/步骤体,`[SK-14]` 的四条判据都看不见它;
// 两条策略互补,不重复报(同一处 env 只有 [SK-17] 报)。
//
// 诚实边界(不假装穷尽):键名是**运行期动态拼出来**的形态静态证明不了 ——
// `K=NODE_OPTIONS; echo "$K=…" >> "$GITHUB_ENV"`、`cmd=exit; "$cmd" 0`、`source hook.sh`
// 这类写法本判据不覆盖;只做常量折叠(`""`/转义拆分会被归一到同一个键名)。取向与 [SK-14]
// 其余各条一致:**求不出真假 ⇒ 按"会静默"处理**的下一层是"能静态看见的一律拒"。
// 第二道(与"层"无关)收口在 `scripts/check-root-guards.mjs`:它**清洗**交给守卫子进程的
// 环境(丢弃未登记的 `NODE_*`/`BASH_*`/`LD_*`/`COREPACK_*` 等)并显式 `process.exit(code)`。
/**
 * [SK-17] 被钉单元上**允许**出现的 env 键 —— **白名单式逐条登记**(2026-09-24 第十轮审计 C-01)。
 *
 * 现场(审计方端到端实跑):第九轮的判据是**黑名单**(`PINNED_ENV_DENIED_KEYS`),而
 * `COREPACK_HOME` 不在表里 —— 给 `gate-guards` 加一步
 * `echo "COREPACK_HOME=/tmp/yc" >> "$GITHUB_ENV"`(目录里放一个 `process.exit(0)` 的
 * `v1/yarn/4.18.0/yarn.js`)之后:判据 EXIT=0、而真跑 `check-root-guards.mjs` 时
 * 16 个根守卫全部"通过"(实测:同树不带该变量是「7 通过、9 失败」EXIT=1)。
 * 机理:`packageManager: "yarn@4.18.0"` 不带 hash ⇒ Corepack 直接从 `$COREPACK_HOME`
 * 取解释器且**不做内容校验** ⇒ 16 条守卫的**被执行体由攻击者提供**。
 *
 * 逐个补名字追不上下一层(`HOME`/`XDG_CACHE_HOME`/`LD_LIBRARY_PATH`/`GIT_CONFIG_GLOBAL`/
 * `PYTHONSTARTUP` …都是同族),所以判据取向反过来:
 *
 *   **被钉单元(含根守卫 job 的每一步)在四层 `env:` 上出现的键、前序步骤写进
 *   `$GITHUB_ENV` 的键、以及被钉步骤自己步骤体里 `export`/前缀赋值写出的键,
 *   必须命中下面这份登记表;未登记一律红。**
 *
 * 表的内容 = 本仓 workflow **真实用到**的 22 个键(第九轮审计统计的"22 个合法 env 键零误伤"
 * 语料,本轮按 `node` 遍历三个 workflow 的四层 `env:` 重建并逐条写清理由)。判据是
 * **fail-closed** 的:解析不出(`null`/非字符串)、空键、大小写变体、未登记 —— 全部按
 * "未登记"处理(大小写变体不归一:Windows 上 `Path` 就是 `PATH`,归一就等于放行一条通道)。
 *
 * 新增一个合法键 = 在**本文件**里加一条带 `why` 的登记(可评审的 diff);判据不再有
 * "下一个 COREPACK_HOME"这种黑名单尾巴。
 */
const PINNED_ENV_ALLOWED_KEYS = [
  // ---- 渠道仓检出(私有仓凭据,四个调用点复用) ----
  { key: 'CHANNELS_REPO_TOKEN', why: '从私有渠道仓取渠道包用的 token(检出步的数据面输入)' },
  { key: 'CHANNELS_REPO_SSH_KEY', why: '同上,SSH 形态的渠道仓凭据' },
  { key: 'CI_CHANNELS_PIN', why: 'gate 解析出的渠道仓 commit pin(不 pin 会让同一个 tag 产出不同客户端)' },
  // ---- 更新服务器(R2 兼容 S3 端点)与 GitHub Release ----
  { key: 'R2_ACCOUNT_ID', why: '更新服务器端点/桶名/HMAC 种子的输入之一' },
  { key: 'R2_BUCKET', why: '同上' },
  { key: 'R2_SECRET_ACCESS_KEY', why: '同上' },
  { key: 'AWS_ACCESS_KEY_ID', why: 'aws CLI 的真实凭据(它只认 AWS_*)' },
  { key: 'AWS_SECRET_ACCESS_KEY', why: '同上' },
  { key: 'AWS_DEFAULT_REGION', why: 'aws CLI 在兼容 S3 端点上要求的区域占位值' },
  { key: 'GH_TOKEN', why: 'release 步骤创建/更新 GitHub Release 用的 token' },
  // ---- macOS 签名与公证 ----
  { key: 'APPLE_API_KEY', why: 'App Store Connect API Key(.p8)内容,公证用' },
  { key: 'APPLE_API_KEY_ID', why: '同上,key id' },
  { key: 'APPLE_API_ISSUER', why: '同上,issuer' },
  { key: 'MAC_CERT_P12_BASE64', why: 'Developer ID 证书(P12 base64),签名用' },
  { key: 'CSC_KEY_PASSWORD', why: 'P12 口令(签名工具读它)' },
  { key: 'MACOS_SIGN_IDENTITY', why: '签名身份名(Developer ID Application: …)' },
  { key: 'CHANNEL_NOTARIZE', why: '渠道 DMG 是否走公证路径的开关(打包脚本读)' },
  // ---- 门禁/构建自身的元数据(不改变解释器行为) ----
  { key: 'WASM_GATE_EXPECT_HEAD', why: 'WASM 残留门禁期望的基线 SHA' },
  { key: 'WASM_GATE_REQUIRE_COVERED_PLATFORM', why: 'WASM 门禁对平台覆盖的硬性要求' },
  { key: 'PG_DSN_TEST', why: 'server job 的测试数据库 DSN' },
  { key: 'VERSION', why: '打包/发布步骤的版本号(由 tag 派生)' },
  { key: 'DSH_TELEMETRY_DISABLED', why: 'workflow 顶层:构建期关掉遥测' },
]

/**
 * **诊断用**的"已知危险键"提示表(2026-09-24 第十轮审计 C-01)。
 *
 * ⚠️ 它**不是判据**:判据是上面那份白名单 —— 未登记即红,与这张表无关。这里只负责在
 * 报错时把"为什么这个键危险"讲清楚(第九轮那份黑名单的文本原样保留为**理由库**),
 * 让被拦下的人一眼看懂该往哪走,而不是把黑名单原样开回来。
 */
const PINNED_ENV_DANGEROUS_HINTS = [
  { key: 'NODE_OPTIONS', why: '`node` 的启动参数(`--import=`/`--require=`)可以在进程退出时改写 `process.exitCode`' },
  { key: 'NODE_PATH', why: '改写模块解析路径(可把 `scripts/*.mjs` 解析到替身)' },
  { key: 'BASH_ENV', why: '非交互 bash 启动时 source 的文件(可定义 `node() { return 0; }` 之类的同名函数)' },
  { key: 'ENV', why: 'POSIX `sh` 启动时 source 的文件(与 `BASH_ENV` 同族)' },
  { key: 'SHELLOPTS', why: 'bash 选项(可改写 `errexit`/`nounset` 等退出语义)' },
  { key: 'BASHOPTS', why: 'bash `shopt` 选项(同上)' },
  { key: 'PROMPT_COMMAND', why: 'bash 提示符钩子(可注入同名函数/包装器)' },
  { key: 'PATH', why: '可让 `node`/`bash` 解析到另一个二进制(命令名一字未改)' },
  { key: 'LD_PRELOAD', why: '动态链接器预载库(可拦截 `exit`/`__libc_start_main`)' },
  { key: 'LD_AUDIT', why: '动态链接器审计库(同上)' },
  { key: 'LD_LIBRARY_PATH', why: '动态链接器搜索路径(同上)' },
  { key: 'COREPACK_HOME', why: 'Corepack 从这里取 `v1/yarn/<ver>/yarn.js` 且**不校验内容** ⇒ 16 条根守卫的被执行体换成攻击者的文件(第十轮审计 C-01 端到端实跑)' },
  { key: 'HOME', why: '决定 Corepack/npm/yarn 的缓存与配置根(COREPACK_HOME 的另一条入口)' },
  { key: 'XDG_CACHE_HOME', why: '同上' },
  { key: 'GIT_CONFIG_GLOBAL', why: 'git 全局配置(守卫里有 git 调用)' },
  { key: 'PYTHONSTARTUP', why: 'Python 启动文件(与 `BASH_ENV` 同族的解释器注入)' },
]
/** 前缀形态的危险键提示(`BASH_FUNC_<name>%%` = 导出的 shell 函数)。 */
const PINNED_ENV_HINT_PREFIXES = [
  { prefix: 'BASH_FUNC_', why: '导出的 shell 函数(`BASH_FUNC_node%%` 会让 `node` 变成 shell 函数,与 `BASH_ENV` 等价且不需要 hook 文件)' },
  { prefix: 'COREPACK_', why: 'Corepack 的配置族(`COREPACK_HOME`/`COREPACK_ENABLE_*` 都能改"谁来解释 `yarn`")' },
  { prefix: 'LD_', why: '动态链接器注入族' },
  { prefix: 'YARN_', why: 'Yarn 配置族(可改它跑哪个脚本/用哪个缓存)' },
]

/**
 * [SK-17] 判据面的**层清单**(唯一真源,2026-09-24 第十轮审计 C-02)。
 *
 * 为什么单列一张表:第九轮的通过行**硬编码**写着"三层 `env:` … 均已检查",而代码实际
 * 只枚举了三层(`container.env` 那一层根本没读,`grep -c container` = 0)—— 同一个键写在
 * `jobs.<id>.container.env` 上时判据静默放行,**日志却仍然宣称"均已检查"**(假保证比沉默更糟)。
 * 现在:枚举逐层产出 `{id, detail}`,通过行**由枚举结果生成**,而 `main()` 断言产出的
 * id 集合与这张表**双向一致**(少一层即红 ⇒ 声明与代码同源,不可能再漂移)。
 */
const PINNED_ENV_LAYER_REGISTRY = [
  { id: 'workflow-env', label: 'workflow 顶层 `env:`' },
  { id: 'job-env', label: 'job 级 `env:`' },
  { id: 'container-env', label: '`jobs.<id>.container.env`(Actions 的第四层)' },
  { id: 'step-env', label: 'step 级 `env:`' },
  { id: 'github-env-write', label: '前序步骤写入 `$GITHUB_ENV`' },
  { id: 'step-body-assignment', label: '被钉步骤体内的 `export`/前缀赋值/`unset`/`env -u`' },
]

/**
 * 被钉 job 允许声明的**容器**执行体(第十轮审计 C-02 的同族面:`container:` 一旦出现,
 * 这一步就不再跑在 runner 上,而是跑在那面镜像里 —— 与"env 换解释器"同级)。
 *
 * 当前为空(**没有任何被钉 job 声明容器**),空表 = 未登记即红:要在被钉 job 上用容器,
 * 必须先在这里登记 `image`(逐字)并写明"这面镜像为什么可以承担判据步骤"。
 */
const PINNED_JOB_CONTAINER_REGISTRY = []

/**
 * [SK-18] 被钉 job 允许声明的 **`defaults.run.working-directory`**（第十轮审计 C-04，本轮修复）。
 *
 * 现场（审计方实跑）：给 `gate-guards` 加两行
 * ```yaml
 *     defaults:
 *       run:
 *         working-directory: /tmp/decoy
 * ```
 * `check-workflows` **EXIT=0**。机理与 `env:` 同族：`node scripts/check-root-guards.mjs`
 * 的 argv 一字未改、步骤体一字未改，但它在**另一个目录**里被解析 —— 相对路径的脚本、
 * `package.json`、`.yarnrc.yml` 全部换成那个目录里的。而"命令去哪解析"此前**不在判据面内**
 * （第九轮把 `env:` 四层 + `$GITHUB_ENV` + 步骤体都收了进来，唯独漏了 cwd）。
 *
 * 判据（**登记制**，fail-closed）：被钉 job 上出现 `defaults.run.working-directory`、
 * 或被钉单元的任何一步出现步骤级 `working-directory` ⇒ 必须逐字登记在下面两张表里，
 * 否则红。**例外只允许逐字登记**（`job` + `workingDirectory` 全等）：本仓真实存在的唯一
 * 一例是 `server` job（`server` 目录，`server` job 里的 `wasm-case-gate` 判据步
 * `node ../scripts/wasm/check-go-test-json.mjs` 正是按这个 cwd 写的 `../` 前缀）——
 * 任何**新** job、或**改**这个取值，都必须带着理由进 diff（这才是"可评审"，而不是"看起来人畜无害"）。
 *
 * 作用域边界（W1 复审 N6，认账）：登记项按 `{ job, workingDirectory }` 逐字匹配 ⇒ 该 job 内
 * **将来新增**的被钉步骤会自动继承已登记的 cwd，不需要按步骤再登记。当前不可利用
 * （把三个被钉单元搬进 `server` job 会被 [SK-9]/[SK-9③]/[SK-8b] 拦住，W1 三个探针实测 EXIT=1），
 * 但这是本表的**已知边界**：给 `server` job 加新判据步骤时，评审者要自己看这个 cwd 对新步骤
 * 是否仍然成立（判据不代劳）。
 */
const PINNED_JOB_WORKING_DIRECTORY_REGISTRY = [
  {
    job: 'server',
    workingDirectory: 'server',
    why: '`server` job 的 `defaults.run.working-directory: server`：job 内所有步骤都在 `server/`'
      + '下解析（`make check` / `go test` / `npm ci --prefix` 的既有形态），其中 `wasm-case-gate`'
      + '判据步写的是 `node ../scripts/wasm/check-go-test-json.mjs` —— `../` 前缀**依赖**这个 cwd。'
      + '它与"给判据步骤换执行体"无关（判据脚本本身仍在仓内、argv 未变），所以按登记制放行。',
  },
]
/**
 * [SK-18] 被钉单元**步骤级** `working-directory` 的登记表（当前为空 = 未登记即红）。
 *
 * 与 job 级同族：步骤级 `working-directory` 只影响这一步，但"这一步"恰恰是判据步骤时，
 * 效果与 job 级完全一样（命令在别处解析）。空表是 fail-closed 的默认形态。
 */
const PINNED_STEP_WORKING_DIRECTORY_REGISTRY = []

/**
 * [SK-18] **workflow 级** `defaults.run.working-directory` 的登记表（当前为空 = 未登记即红）。
 *
 * 现场（2026-09-25 第十轮复审 W1 的 N1，**P2**）：`defaults` 在 Actions 语法里**两个层级**
 * 都合法 —— `jobs.<id>.defaults`（W1 之前的判据面）与 workflow **顶层** `defaults`。在
 * `ci.yml` 顶层写
 * ```yaml
 * defaults:
 *   run:
 *     working-directory: <某个已入库的目录>
 * ```
 * 时，**所有 job**（含 `gate-guards` 的根守卫步、`gate` 的全量门禁步）都在那个目录里解析，
 * 而 `check-workflows` **EXIT=0** —— 与 C-04 的原始现场同一机理、同一收益（argv / 步骤体 /
 * `env:` 一字未改，`node scripts/…` 的相对路径、`package.json`、`.yarnrc.yml`、`.git` 全部
 * 换成别处的）。判据随之一分为二：**两个入口同扫**，只堵一个等于没堵。
 *
 * 与 job 级同一条纪律：**顶层非空即未登记即红**，例外只允许逐字登记
 * `{ workflow, workingDirectory, why }`（`workflow` = workflow 文件名，例如 `ci.yml`），
 * 并在 `why` 里写明"判据步骤在这个 cwd 下为什么仍然成立"。空表是本仓当前的正确形态
 * （三个 workflow 都没有顶层 `defaults.run.working-directory`）。
 */
const WORKFLOW_LEVEL_WORKING_DIRECTORY_REGISTRY = []

/**
 * 被钉单元里允许出现的 `uses:`(第十轮审计 C-03 / MAINCTL-3)。
 *
 * 判据(`pinnedUsesProblem`):被钉单元里的每一个 `uses:` 步骤**要么**是能在仓内解析到的
 * 本地路径(其内容被 `checkCompositeActionTree()` 的同一套判据覆盖),**要么**逐字登记在
 * 这张表里。空 `why` 一律按配置错误处理(登记 = 必须写清"它能做什么")。
 *
 * 表里三条是 `gate-guards`(永不跳过的那条路径)在用的官方 action;新增未登记的 action
 * 必须红 —— 这正是 MAINCTL-3 的现场:插一步 `uses: ./.github/actions/poison` 之后,
 * 判据把它**算进了"被钉住的判定单元"**(单元数 10 → 11)却从不读它的内容,EXIT=0。
 */
const PINNED_USES_REGISTRY = [
  { uses: 'actions/checkout@v7', why: '官方检出 action:`gate-guards` 的第一步,取仓 + submodule(守卫脚本与 workflow 文本的来源)' },
  { uses: 'actions/setup-node@v7', why: '官方 Node 安装 action:守卫运行器要的 node 24(注:corepack enable 必须排在它之后)' },
  { uses: 'actions/cache@v6', why: '官方缓存 action:只读写 `.yarn/cache` 与 electron 缓存目录,不参与判据结论' },
]

/**
 * 被钉单元里允许出现的 `with:` **输入**(第十一轮审计 P1-3,本轮修复)。
 *
 * 现场(审计方 8/8 条变异实测 `check-workflows` EXIT=0,完整树副本上 13 条根守卫逐条同形):
 * `PINNED_USES_REGISTRY` 只钉了 `uses:` 的**名字**,同一步的 `with:` 取值完全不在判据面内 ⇒
 *   · `actions/checkout@v7` 的 `repository:`(换成另一仓)/`ref:`(换成另一分支)/`token:`/
 *     `sparse-checkout:` 一行就能让"守卫脚本与 workflow 文本的来源"变成**另一个仓库的另一棵树**,
 *     而 `[SK-17]`/`[SK-14]`/`[SK-18]` 看到的 argv、步骤体、cwd、env 全部原样;
 *   · `actions/setup-node@v7` 的 `node-version:` / `node-version-file:` / `enable-corepack:`
 *     换的是**解释器**本身(同族的"执行体由谁提供");
 *   · `actions/cache@v6` 的 `path:` / `key:` 决定缓存恢复**写进工作区的哪些目录**
 *     (`path: scripts` 就能在根守卫跑之前把 `scripts/` 覆盖成缓存内容)。
 * 同一步的 `fetch-depth` 反倒早就有专门判据(`[SK-8b]`)⇒ 同族只收口了一半。
 *
 * 判据(取向 = 白名单/逐字登记,与 `PINNED_ENV_ALLOWED_KEYS`、`PINNED_JOB_CONTAINER_REGISTRY` 同形):
 *   · 被钉单元里的 `uses:` 步骤,其 `with:` 的**每一个键**都必须登记在下面这张表里;
 *   · 取值必须是登记表里的**逐字**取值之一(去首尾空白后比较) —— 改一个字符就要进 diff;
 *   · 表里的键必须有被钉单元在用(死条目对账,与 `PINNED_USES_REGISTRY` 同一纪律)。
 */
const PINNED_USES_WITH_REGISTRY = [
  {
    uses: 'actions/checkout@v7',
    inputs: [
      {
        key: 'fetch-depth',
        values: ['0'],
        why: '`fetch-depth: 0` 是 [SK-8b] 明文要求的完整历史(`check-no-real-domains` 的提交信息判据要先解析出区间 base);'
          + '改成别的取值就是那条判据的静默退化。',
      },
      {
        key: 'submodules',
        values: ['recursive'],
        why: '`submodules: recursive` 取上游 pin(`deepseek-harness/`)—— 守卫脚本与 workflow 文本都来自这棵树;'
          + '去掉它 checkout 出来的是空目录。',
      },
    ],
    why: '官方检出 action:树的内容与来源由这几个输入决定(repository/ref/token/sparse-checkout 一律未登记 = 红)。',
  },
  {
    uses: 'actions/setup-node@v7',
    inputs: [
      {
        key: 'node-version',
        values: ['24'],
        why: '仓库要求 Node `^22.19.0` / `>=24.0.0`(AGENTS.md 的 Prerequisites);换版本就是换判据的解释器。'
          + '取向是逐字登记而不是"范围匹配":改版本必须进 diff 让人看见。',
      },
    ],
    why: '官方 Node 安装 action:判据步骤赖以成立的解释器由它提供(node-version-file/enable-corepack 等未登记 = 红)。',
  },
  {
    uses: 'actions/cache@v6',
    inputs: [
      {
        key: 'path',
        values: ['.yarn/cache\n~/.cache/electron\n~/.cache/electron-builder'],
        why: '只允许缓存这三个目录 —— 它们都是**包管理/打包缓存**,恢复它们不会改变任何被判对象。'
          + '`path: scripts`(或仓内任何源码目录)会让缓存恢复在根守卫跑之前覆盖判据脚本本身。',
      },
      {
        key: 'key',
        values: ["desktop-cache-${{ runner.os }}-${{ hashFiles('yarn.lock') }}"],
        why: '缓存键必须由 `yarn.lock` 的内容派生:换成固定键之后,缓存内容与锁文件脱钩,'
          + '跨分支复用一份被污染的缓存(actions/cache 的既有风险面),而这一步跑在被钉步骤之前。',
      },
    ],
    why: '官方缓存 action:它写的是**工作区里的目录**(path)且按 key 决定命中哪一份 ⇒ 与判据脚本同权。',
  },
]

/**
 * 被钉 **job** 允许声明的 `runs-on:`(第十一轮审计 P2-1,本轮修复)。
 *
 * 现场(审计方 `mutF`):`gate-guards` 的 `runs-on: ubuntu-24.04` 改成 `self-hosted` 或
 * `ubuntu-22.04`,`check-workflows` **EXIT=0**。`container:` 早就有登记制
 * (`PINNED_JOB_CONTAINER_REGISTRY`),`runs-on` 是**同一层**("这一步跑在谁的机器上"):
 * 一旦仓库出现自托管 runner,这一行就是把"永不跳过"的必需检查搬到对手的机器上跑。
 * 当前不可利用(本仓各处 `runs-on` 全是 GitHub 托管标签,指过去只会挂着不绿),但同层漏项
 * 必须在同层收口。
 *
 * 判据(登记制,fail-closed):**有被钉判定单元的 job**,其 `runs-on` 必须逐字登记在下面这张表里。
 * 未登记(含列表形态 `runs-on: [self-hosted, linux]`、表达式、非字符串)一律红 —— 判据读不懂
 * "这一步会跑在哪台机器上"时按"会静默"处理。
 */
const PINNED_JOB_RUNS_ON_REGISTRY = [
  {
    job: 'gate-guards',
    runsOn: 'ubuntu-24.04',
    why: '根守卫 job(永不跳过):根守卫在同一台 GitHub 托管 Ubuntu 24.04 runner 上跑,'
      + '镜像自带的 python/go/node 版本是判据的一部分 ⇒ 换标签必须进 diff。',
  },
  {
    job: 'gate',
    runsOn: 'ubuntu-24.04',
    why: '全量门禁 job(`yarn check` + 发布面判据):与 gate-guards 同一镜像口径 —— 两个 job 跑'
      + '同一套命令,标签不一致会让"本地绿、CI 红"类问题变成两台机器之间的差异。',
  },
  {
    job: 'server',
    runsOn: 'ubuntu-24.04',
    why: 'Go/服务端 job:含被钉的 `wasm-case-gate` 判据步(PG 容器 + `go test -json`),'
      + '托管 Ubuntu 24.04 是它的既有形态(PG 18 镜像与 go 版本都在这一步的判据面内)。',
  },
]

/**
 * 键名是否**未登记**(= 必须红)。判据是白名单,fail-closed:
 * 非字符串 / 空键 / 前后带空白 / 大小写变体 / 表里没有 —— 全部按未登记处理。
 *
 * @param key - `env:` 里的原始键名。
 * @returns `null` = 已登记;否则是 `{ raw, why, hint }`(`hint` = 命中的危险键提示,仅用于文案)。
 */
function pinnedEnvKeyProblem(key) {
  if (typeof key !== 'string') {
    return {
      raw: JSON.stringify(key) ?? String(key),
      why: '键名不是一个字符串(YAML 的映射键理论上都是字符串)⇒ 判据读不懂这一项',
      hint: null,
    }
  }
  if (key === '' || key.trim() !== key) {
    return {
      raw: JSON.stringify(key),
      why: '键名是空串或前后带空白,判据读不懂它到底是哪个键',
      hint: null,
    }
  }
  if (PINNED_ENV_ALLOWED_KEYS.some(entry => entry.key === key)) return null
  const upper = key.toUpperCase()
  const hint = PINNED_ENV_DANGEROUS_HINTS.find(entry => entry.key === upper)
  const prefixHint = PINNED_ENV_HINT_PREFIXES.find(entry => upper.startsWith(entry.prefix))
  if (hint !== undefined) {
    return {
      raw: key,
      why: `${hint.why}${key === hint.key ? '' : `(注意:登记表按**逐字**比较,大小写变体 \`${key}\` 与 \`${hint.key}\` 不是同一个键 —— Windows runner 上它们却是同一个环境变量,所以变体一律按未登记处理)`}`,
      hint: hint.key,
    }
  }
  if (prefixHint !== undefined) {
    return { raw: key, why: prefixHint.why, hint: `${prefixHint.prefix}*` }
  }
  return {
    raw: key,
    why: '它不在 `PINNED_ENV_ALLOWED_KEYS` 的登记表里',
    hint: null,
  }
}

/** `env:` 映射(非对象一律当空 —— 静态判不了的形态由 YAML 自己的检查兜)。 */
function envEntries(env) {
  return typeof env === 'object' && env !== null ? Object.entries(env) : []
}

/**
 * [SK-17] 被钉步骤体里**允许清除**的环境变量名（登记表，当前为空 = 任何 `unset` 都红）。
 *
 * 现场（第十一轮复审 J1 的 N2）：`PINNED_ENV_ALLOWED_KEYS` 是"**出现**在被钉单元环境面上的
 * 键必须登记"，而 `unset` 是**反向**的一层 —— 它名字里根本没有键，只有"少了一个键"。
 * 而少一个键的后果和写一个键同级：`unset CI GITHUB_ACTIONS` 把
 * `check-guard-parser-integrity` 的 git 锚定从"CI 硬判据"降级成"本地告警"
 * （实测 `CI=true node scripts/check-guard-parser-integrity.mjs` = 1，同一棵树加一行 `unset` = **0**），
 * `unset WASM_GATE_EXPECT_HEAD` 同理能让一条判据静默退化。
 *
 * 因此判据是**独立**的一条：被钉步骤体里出现 `unset <NAME>` / `env -u <NAME>` ⇒ 名字必须逐字
 * 登记在这里，否则红（空的表 = 这条路径整体关闭）。**不复用** `PINNED_ENV_ALLOWED_KEYS`：
 * 那张表回答的是"这个键出现在环境面上是否安全"，而 `PG_DSN_TEST`/`WASM_GATE_EXPECT_HEAD`
 * 这类键出现在表里恰恰是因为**它们必须存在**，清除它们与登记它们的理由正好相反。
 */
const PINNED_STEP_UNSET_ALLOWED_KEYS = []

/**
 * [SK-17] 被钉步骤体里"清除环境变量"的判定（与 `pinnedEnvKeyProblem` 互补，见上面登记表）。
 * @param key - 被清除的变量名。
 * @returns `null` = 已登记放行；否则 `{ raw, why, hint }`。
 */
function pinnedUnsetKeyProblem(key) {
  if (typeof key !== 'string' || key === '' || key.trim() !== key) {
    return {
      raw: JSON.stringify(key),
      why: '被清除的键名读不出来（空串/带空白）⇒ 判据不知道这一步抹掉了什么',
      hint: null,
    }
  }
  if (PINNED_STEP_UNSET_ALLOWED_KEYS.some(entry => entry.key === key)) return null
  return {
    raw: key,
    why: `被钉步骤体**清除**了环境变量 \`${key}\` —— 删除不会让判据报错，只会让它**降级**`
      + '（J1 复审 N2 的现场：`unset CI GITHUB_ACTIONS` 把 git 锚定从 CI 硬判据变成本地告警，'
      + '实测 EXIT 1→0；`unset` 掉门禁自己的开关键同族）',
    hint: key,
  }
}

/**
 * 被钉步骤**自己的步骤体**里写进子进程环境的变量名(第十轮审计 D-03)。
 *
 * 现场(审计方实跑):在守卫步的 `run` 里加一行
 * `export NODE_OPTIONS="--import=data:text/javascript,process.on('exit',()=>{process.exitCode=0})"`
 * 之后,`check-workflows` EXIT=0(它只看 YAML 的 `env:` 三层),而真跑那条命令时
 * 16 个根守卫"跑是跑了"、`process.exitCode` 被退出钩子改回 0 ⇒ 门禁 EXIT=0。
 * 同族的第二半在 `scripts/check-root-guards.mjs`(它此前把 `process.env` **原样透传**
 * 给 16 个守卫子进程)。
 *
 * 认识范围(**只认真的会进入/离开子进程环境的三类写法**):
 *   · `export NAME=…` / `export NAME` / `export -x NAME`(裸 `export NAME` 也认:
 *     它把已有变量导出,同样是"这一步的子进程会看见它");
 *   · `declare -x NAME` / `typeset -x NAME`(`-x` = 导出属性);
 *   · **命令位前缀赋值** `NAME=… cmd …`(含 `env NAME=… cmd`:前导前缀词表里已有 `env`);
 *   · **`unset NAME…`(第十一轮复审 J1 的 N2)** 与 **`env -u NAME` / `env --unset=NAME`**:
 *     方向相反的同族写法 —— 删掉一个键不会让判据报错,只会让它**降级**
 *     (`unset CI GITHUB_ACTIONS` 就把 CI 硬判据变成本地告警,实测 `CI=true …`=1、加 `unset`=0);
 *     另有 `env -i`/`--ignore-environment`(清空整份环境)与 `env -S`(再交给一层 shell),
 *     两者都按 `unparsable` fail-closed 处理。
 * 不认:普通赋值语句(`FOO=1` 单独一行,不导出 ⇒ 子进程看不见)、函数定义、`local`、
 * 以及命令词**之后**的 `NAME=…` 参数(`docker run -e FOO=bar` 那种不是本进程的环境)。
 *
 * 分词用与 [SK-14⑥]/[SK-15] 同一套原语(`joinShellContinuations` → `maskQuotedRegions`
 * 切段 → `stripShellRedirections` → `splitShellWords`),所以"引号里的 `export`"
 * (`echo "export NODE_OPTIONS=x"`)不会被误判。
 *
 * 诚实边界:键名由变量拼出来(`K=NODE_OPTIONS; export "$K"`)、`source hook.sh`、
 * `eval "$payload"` 这类形态静态证明不了 —— 与 [SK-17] 其余各条同一取向:能静态看见的
 * 一律判,看不见的由"求不出真假 ⇒ 按会静默处理"之外的第二道(环境清洗)兜。
 *
 * @param script - 步骤体的原始 `run` 文本(本函数自己剥注释)。
 * @returns `[{ name, kind, form }]`(`kind` = `'set'`/`'unset'`)或
 *   `[{ unparsable: true, segment, form }]`(分词失败 / `env -i` / `env -S`)。
 */
function shellEnvironmentAssignments(script) {
  if (typeof script !== 'string' || script.trim() === '') return []
  const results = []
  const opened = joinShellContinuations(executableScript(script))
  const masked = maskQuotedRegions(opened)
  const segments = []
  let start = 0
  COMMAND_SEGMENT_SEPARATOR.lastIndex = 0
  let match
  while ((match = COMMAND_SEGMENT_SEPARATOR.exec(masked)) !== null) {
    segments.push(opened.slice(start, match.index))
    start = match.index + match[0].length
  }
  segments.push(opened.slice(start))

  for (const segment of segments) {
    const cleaned = stripShellRedirections(segment).trim()
    if (cleaned === '') continue
    const words = splitShellWords(cleaned)
    if (words === null) {
      // 分词失败 ⇒ 判据读不懂这一句。只有它**看起来**在写环境时才 fail-closed
      // (否则任意一段带引号的文本都会把一个正常的守卫步骤判红)。
      // `unset` / `env -u|-i|--unset` 与 `export`/`declare`/`typeset` 同族（第十一轮复审 J1 的 N2）
      // —— 读不懂的"清除环境"比读不懂的"写出环境"更危险：它只会让判据**降级**。
      if (/(?:^|[\s;&|(){}])(?:export|declare|typeset|unset)\b|\benv\s+(?:-u\b|-i\b|--unset\b|--ignore-environment\b)|\b[A-Za-z_][A-Za-z0-9_]*=/u.test(cleaned)) {
        results.push({ unparsable: true, segment: cleaned, form: '无法分词的赋值片段' })
      }
      continue
    }
    const texts = words.map(word => word.text)
    // **`env` 的"清空/取消"选项**（第十一轮复审 J1 的 N2）——必须在通用前缀扫描**之前**认：
    // `env -u CI -u GITHUB_ACTIONS node …` 里的 `-u` 会被下面那圈 `word.startsWith('-')` 当普通
    // 选项跳过，于是 `CI` 被当命令词、这一段的键**一个都看不见**。三种形态：
    //   · `env -u NAME` / `env --unset NAME` / `env --unset=NAME` ⇒ 清除单个键；
    //   · `env -i` / `env --ignore-environment` ⇒ 清空**整份**环境（`CI`/`GITHUB_ACTIONS` 全没）；
    //   · `env -S '…'` / `env --split-string …` ⇒ 判据读不懂（等价于再来一层 shell）。
    // 前两种按"写入环境面"逐键/整体记录；第三种按 unparsable（fail-closed）。
    if (texts[0] === 'env') {
      let cursor = 1
      while (cursor < texts.length) {
        const word = texts[cursor]
        const unsetInline = /^--unset=(.+)$/u.exec(word)
        if (word === '-u' || word === '--unset') {
          const name = /^([A-Za-z_][A-Za-z0-9_]*)/u.exec(texts[cursor + 1] ?? '')?.[1]
          results.push(name === undefined
            ? { unparsable: true, segment: cleaned, form: '`env -u`(名字读不出来)' }
            : { name, kind: 'unset', form: `\`env -u ${name}\`(清除该键后执行)` })
          cursor += 2
          continue
        }
        if (unsetInline !== null) {
          const name = /^([A-Za-z_][A-Za-z0-9_]*)/u.exec(unsetInline[1])?.[1]
          results.push(name === undefined
            ? { unparsable: true, segment: cleaned, form: '`env --unset=`(名字读不出来)' }
            : { name, kind: 'unset', form: `\`env --unset=${name}\`(清除该键后执行)` })
          cursor += 1
          continue
        }
        if (word === '-i' || word === '--ignore-environment') {
          results.push({ unparsable: true, segment: cleaned, form: '`env -i`(清空整份环境)' })
          cursor += 1
          continue
        }
        if (word === '-S' || word === '--split-string' || word.startsWith('--split-string=')) {
          results.push({ unparsable: true, segment: cleaned, form: '`env -S`(把命令串再交给 shell)' })
          cursor += 1
          continue
        }
        if (word.startsWith('-') && word !== '-') { cursor += 1; continue }
        break
      }
    }
    // 命令位:跳过前缀词(`env`/`time`/`sudo`/`eval`/`exec`…)与 `NAME=…` 赋值词。
    let index = 0
    const leadingAssignments = []
    while (index < texts.length) {
      const word = texts[index]
      if (EXIT_PREFIX_WORDS.includes(word)) { index += 1; continue }
      const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=/u.exec(word)
      if (assignment !== null) {
        leadingAssignments.push(assignment[1])
        index += 1
        continue
      }
      if (word.startsWith('-') && word !== '-') { index += 1; continue }
      break
    }
    // **只有"赋值之后、同一段里还有命令词"才是前缀赋值**(`FOO=1 cmd` ⇒ 子进程看得见)。
    // 单独一行的 `FOO=1` 是普通 shell 变量(不导出 ⇒ 子进程看不见),不能报 ——
    // 本仓 `ci.yml` 的 `GO_TEST_STATUS=0` / `CHECK_STATUS=0` 正是这种合法写法。
    if (index < texts.length) {
      // `segment` 让调用方能判"这一句是不是那个唯一的 PATH 例外"（[SK-20] / [SK-17]）。
      for (const name of leadingAssignments) results.push({ name, kind: 'set', segment: cleaned, form: `前缀赋值 \`${name}=…\`` })
    }
    const command = texts[index]
    // **`unset NAME…`**（第十一轮复审 J1 的 N2）：与 `export` 同一层写入面，方向相反 ——
    // 删掉一个键不会让判据报错，只会让它**降级**。现场：被钉步骤体里一行
    // `unset CI GITHUB_ACTIONS` 就把 `check-guard-parser-integrity` 的"git 锚定"从 CI 硬判据
    // 降成本地告警（实测 `CI=true node …` = 1、加 `unset` = 0），而静态判据此前**不认 `unset`**
    // ⇒ `check-workflows` EXIT=0。选项（`-v`/`-f`/`--`）跳过；名字读不出来的形态按 unparsable 处理。
    if (command === 'unset') {
      let cursor = index + 1
      while (cursor < texts.length) {
        const word = texts[cursor]
        if (word === '--' || (word.startsWith('-') && word !== '-')) { cursor += 1; continue }
        const name = /^([A-Za-z_][A-Za-z0-9_]*)/u.exec(word)?.[1]
        if (name === undefined) { cursor += 1; continue }
        results.push({ name, kind: 'unset', segment: cleaned, form: `\`unset ${name}\`(清除键)` })
        cursor += 1
      }
      continue
    }
    if (command !== 'export' && command !== 'declare' && command !== 'typeset') continue
    let cursor = index + 1
    const expectsExportAttribute = command !== 'export'
    let exportsAttribute = command === 'export'
    while (cursor < texts.length) {
      const word = texts[cursor]
      if (word === '--') { cursor += 1; continue }
      if (word.startsWith('-') && word !== '-') {
        // `export -f` = 导出 **shell 函数**(环境里变成 `BASH_FUNC_<name>%%`,与 `BASH_ENV` 等价)。
        if (/^-[A-Za-z]*f/u.test(word)) {
          results.push({ unparsable: true, segment: cleaned, form: `\`${command} ${word}\`(导出 shell 函数)` })
        }
        if (/^-[A-Za-z]*x/u.test(word)) exportsAttribute = true
        // `-n`(取消导出属性)之后仍按导出判:fail-closed,不区分"取消"与"设置"。
        cursor += 1
        continue
      }
      const name = /^([A-Za-z_][A-Za-z0-9_]*)/u.exec(word)?.[1]
      if (name === undefined) { cursor += 1; continue }
      if (!expectsExportAttribute || exportsAttribute) {
        results.push({ name, kind: 'set', segment: cleaned, form: `\`${command}${exportsAttribute ? '' : ' -x'} ${name}\`` })
      }
      cursor += 1
    }
  }
  return results
}

/**
 * 一个 `uses:` 是否落在判据的**读取面**内(第十轮审计 C-03 / MAINCTL-3)。
 *
 * 判据(与 `PINNED_USES_REGISTRY` 配套):
 *   · **本地路径**(`./…`):必须能在仓内解析到,必须在 `.github/actions/` 之下(那样它的
 *     内容才被 `checkCompositeActionTree()` 的同一套键表判据覆盖),且必须是 composite
 *     (`runs.using === 'composite'`)—— 非 composite 的执行体(js/docker)不在读取面内;
 *   · **远端引用**:必须逐字登记在 `PINNED_USES_REGISTRY` 里(每条带"它能做什么"的说明)。
 * 其余形态(表达式、`../` 越界、空值、非字符串)一律红:求不出真假 ⇒ 按会静默处理。
 *
 * @param uses - `step.uses` 的取值。
 * @param rootDir - 仓库根(本地路径的解析基准;自检注入合成树)。
 * @returns `null` = 在读取面内;否则是人读的原因(含出路)。
 */
function pinnedUsesProblem(uses, rootDir) {
  if (typeof uses !== 'string' || uses.trim() === '') {
    return `\`uses:\` 取值不是一个非空字符串(${JSON.stringify(uses ?? null)})⇒ 判据读不懂这一步委派给了谁。`
      + '被钉单元里的 `uses:` 只允许"仓内可解析的本地 composite action"或登记在 '
      + '`PINNED_USES_REGISTRY` 里的逐字条目。'
  }
  const value = uses.trim()
  if (!value.startsWith('./')) {
    const registered = PINNED_USES_REGISTRY.find(entry => entry.uses === value)
    if (registered !== undefined) return null
    const known = PINNED_USES_REGISTRY.map(entry => `\`${entry.uses}\``).join('、')
    return `它引用的是**远端 action** \`${value}\`,而它不在 \`PINNED_USES_REGISTRY\` 里`
      + `(已登记:${known || '（空）'})⇒ 这一步的执行体由仓库之外的东西提供,判据读不到。`
      + '\n  ⇒ 要在被钉单元上用一个新的远端 action,先在 `PINNED_USES_REGISTRY` 里逐字登记'
      + '（action 名/ref + 它能做什么 + 为什么可以承担判据步骤）。'
  }
  const actionsRoot = join(rootDir, '.github', 'actions')
  const target = resolve(rootDir, value)
  if (target !== actionsRoot && !target.startsWith(`${actionsRoot}${sep}`)) {
    return `它是本地路径 \`${value}\`,但不在 \`.github/actions/\` 之下 ⇒ 它的内容不在`
      + ' `checkCompositeActionTree()` 的扫描面内(那条判据逐字检查每个 composite action 的'
      + ' `run:`/`env:`/`uses:`)。被钉单元委派的本地 action 必须放在 `.github/actions/` 下。'
  }
  let stats
  try {
    stats = statSync(target)
  } catch {
    return `它是本地路径 \`${value}\`,但在仓内**解析不到**(路径不存在)⇒ 判据无法读到它的内容。`
      + '（`uses:` 指向不存在的本地 action 时 Actions 会直接失败;判据同样不能假装它可判。）'
  }
  let actionFile = null
  if (stats.isDirectory()) {
    for (const candidate of ['action.yml', 'action.yaml']) {
      const path = join(target, candidate)
      if (existsSync(path)) { actionFile = path; break }
    }
    if (actionFile === null) {
      return `它是本地路径 \`${value}\`(目录),但目录里没有 \`action.yml\`/\`action.yaml\` ⇒ `
        + '判据读不到它的执行体。'
    }
  } else if (stats.isFile() && /\.ya?ml$/u.test(target)) {
    actionFile = target
  } else {
    return `它是本地路径 \`${value}\`,但它既不是目录也不是 \`.yml\`/\`.yaml\` 文件 ⇒ 判据读不到它的执行体。`
  }
  let actionDocument
  try {
    actionDocument = parseYaml(readFileSync(actionFile, 'utf8'))
  } catch (cause) {
    return `它的 action 文件 \`${relative(rootDir, actionFile)}\` YAML 解析失败`
      + `(${cause?.message ?? String(cause)})⇒ 判据读不到它的执行体。`
  }
  const using = actionDocument?.runs?.using
  if (using !== 'composite') {
    return `它是本地 action \`${relative(rootDir, actionFile)}\`,但 \`runs.using\` = `
      + `${JSON.stringify(using ?? null)}(不是 \`composite\`)⇒ 执行体是 js/docker 而不是可读的 `
      + '`run:` 文本,不在本判据的读取面内。要用新的执行体,请登记进 `PINNED_USES_REGISTRY`'
      + '（远端形态）或改成 composite。'
  }
  return null
}

/**
 * 把一个本地 `uses:` 路径解析到它的 `action.yml`/`action.yaml` 文件。
 *
 * 唯一实现（`pinnedUsesProblem` / `localActionDeclaredInputs` / 引用集合收集器共用）——
 * 三处各写一份"目录还是文件 / yml 还是 yaml"的判断，迟早会分叉。
 * @param uses - `./…` 形态的本地路径（可带首尾空白）。
 * @param rootDir - 仓库根。
 * @returns 绝对路径；解析不到时 `null`。
 */
function resolveLocalActionFile(uses, rootDir = root) {
  if (typeof uses !== 'string' || !uses.trim().startsWith('./')) return null
  const target = resolve(rootDir, uses.trim())
  try {
    const stats = statSync(target)
    if (stats.isDirectory()) {
      for (const candidate of ['action.yml', 'action.yaml']) {
        const path = join(target, candidate)
        if (existsSync(path)) return path
      }
      return null
    }
    if (stats.isFile() && /\.ya?ml$/u.test(target)) return target
    return null
  } catch {
    return null
  }
}

/**
 * 全仓 workflow 文本里**被引用到的**本地 composite action 集合（递归含嵌套 `uses:`）。
 *
 * 为什么需要（第十一轮审计 P2-2 的假红边界）：`checkCompositeActionTree()` 此前把
 * `.github/actions/**` 的**整棵树**都按"被钉单元的白名单"判 —— 将来某个只被**非判据步骤**
 * （例如打包 job）引用的本地 action，只要它需要 `PATH`/`HOME`/`NODE_OPTIONS` 之类键就会被红，
 * 而它与被钉单元毫无关系。判据应该只判"**真的会进判据链**的那部分"：引用集合由 workflow
 * 文本解析得出（不是靠人肉登记），未引用的单独提示（不判）。
 *
 * 递归是必须的：composite action 内部还可以 `uses: ./…` 继续委派，闭包里的每个文件都在
 * 被钉单元的**实际执行链**上。
 * @param workflowDirectory - `.github/workflows` 目录。
 * @param rootDir - 仓库根（本地路径的解析基准）。
 * @returns 被引用到的 action 文件绝对路径集合。
 */
function collectReferencedLocalActions(workflowDirectory, rootDir = root) {
  const referenced = new Set()
  const visit = uses => {
    if (typeof uses !== 'string' || !uses.trim().startsWith('./')) return
    const file = resolveLocalActionFile(uses, rootDir)
    // 解析不到的路径由 `pinnedUsesProblem()` 自己报（读不懂的目标不能靠"我没引用它"逃掉）。
    if (file === null || referenced.has(file)) return
    referenced.add(file)
    try {
      const document = parseYaml(readFileSync(file, 'utf8'))
      for (const step of Array.isArray(document?.runs?.steps) ? document.runs.steps : []) visit(step?.uses)
    } catch {
      // YAML 读不懂 ⇒ 由内容判据报（这里只负责算引用闭包）。
    }
  }
  let names
  try {
    names = readdirSync(workflowDirectory)
  } catch {
    return referenced
  }
  for (const name of names.filter(entry => /\.ya?ml$/u.test(entry)).sort()) {
    let document
    try {
      document = parseYaml(readFileSync(join(workflowDirectory, name), 'utf8'))
    } catch {
      continue
    }
    const jobs = typeof document?.jobs === 'object' && document.jobs !== null ? document.jobs : {}
    for (const job of Object.values(jobs)) {
      for (const step of Array.isArray(job?.steps) ? job.steps : []) visit(step?.uses)
    }
  }
  return referenced
}

/**
 * 本地 composite action 的**内容**判据(第十轮审计 C-03 / MAINCTL-3)。
 *
 * 现场:`.github/actions/poison/action.yml`(composite,内部
 * `echo "NODE_OPTIONS=--import=…" >> "$GITHUB_ENV"`)在 `.github/workflows/` 的**平铺
 * `readdirSync` 扫描面之外** ⇒ 判据把那一步算进了"被钉住的判定单元"(单元数 10 → 11)
 * 却从不读它的内容,EXIT=0;而 `$GITHUB_ENV` 的写入跨步骤生效 ⇒ 守卫步拿到的就是被污染的
 * `NODE_OPTIONS`。
 *
 * 判据:每个 action 文件的 `runs.steps[]` 都按**同一套**键表判 —— `env:` 键、`run` 文本里的
 * `export`/前缀赋值(步骤体那一层)、`run` 文本里的 `$GITHUB_ENV` 写入键、以及嵌套的
 * `uses:`(本地路径 / 登记表,递归同一函数)。
 *
 * @param actionsRoot - `.github/actions` 目录(缺省 = 仓库根下那一个;自检注入合成树)。
 * @param notes - 提示收集器。
 * @returns 失败项数组。
 */
function checkCompositeActionTree(actionsRoot, notes, rootDir = root, options = {}) {
  const failures = []
  let files = []
  const walk = directory => {
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile() && /^action\.ya?ml$/u.test(entry.name)) files.push(path)
    }
  }
  walk(actionsRoot)
  files.sort()
  // **只判被引用的**（第十一轮审计 P2-2）：`options.referenced` 由 workflow 文本解析得出
  // （见 `collectReferencedLocalActions()`）；未引用的 action 不在任何被钉单元的执行链上，
  // 按被钉白名单判它就是**假红方向的边界**（合法用途会被挡），所以只提示、不判。
  // 缺省 `null` = 全树判（`selfTestCompositeActions()` 等直接调用方的既有语义，不变）。
  const referenced = options.referenced ?? null
  let unchecked = 0
  if (referenced !== null) {
    const kept = files.filter(file => referenced.has(file))
    unchecked = files.length - kept.length
    files = kept
  }
  if (files.length === 0) {
    notes.push(unchecked === 0
      ? '[SK-17] 本地 composite action:`.github/actions/**` 下 0 个 action 文件(扫描面已就位)'
      : `[SK-17] 本地 composite action:\`.github/actions/**\` 下 ${unchecked} 个 action 文件`
        + '**未被任何 workflow 引用**(不在被钉单元的执行链上,不按被钉白名单判 —— '
        + '引用集合由 workflow 文本解析得出,见 `collectReferencedLocalActions()`)')
    return failures
  }
  let checkedSteps = 0
  for (const file of files) {
    const relativePath = relative(rootDir, file)
    let document
    try {
      document = parseYaml(readFileSync(file, 'utf8'))
    } catch (cause) {
      failures.push({
        name: relativePath,
        line: 0,
        detail: `[SK-17] 本地 action 的 YAML 解析失败: ${cause?.message ?? String(cause)}`
          + '\n  ⇒ 这个 action 被 workflow 引用时执行体是什么,判据读不出来(读不懂按会静默处理)。',
      })
      continue
    }
    const using = document?.runs?.using
    if (using !== 'composite') {
      failures.push({
        name: relativePath,
        line: 0,
        detail: `[SK-17] 本地 action 的 \`runs.using\` = ${JSON.stringify(using ?? null)}(不是 \`composite\`)`
          + '\n  ⇒ 执行体是 js/docker 或声明缺失,判据读不到它的 `run:` 文本。'
          + '被钉单元委派的本地 action 必须是 composite;要用别的执行体请登记进 `PINNED_USES_REGISTRY`。',
      })
      continue
    }
    const steps = Array.isArray(document?.runs?.steps) ? document.runs.steps : []
    steps.forEach((step, index) => {
      checkedSteps += 1
      const label = `${relativePath} 的 step#${index + 1}`
      for (const [key] of envEntries(step?.env)) {
        const hit = pinnedEnvKeyProblem(key)
        if (hit === null) continue
        failures.push({
          name: relativePath,
          line: 0,
          detail: `[SK-17] ${label} 的 \`env:\` 里有 \`${hit.raw}\`,而它寄宿在本地 composite action 里`
            + `(会被引用它的被钉单元整段执行)。\n  为什么必须拒:${hit.why}。`
            + '\n  ⇒ composite action 的 `env:` 与 workflow 里的 `env:` 同权,但它此前落在'
            + ' `.github/workflows/` 的平铺扫描面之外(第十轮审计 C-03 / MAINCTL-3 的现场)。'
            + '未登记的键要么去掉,要么先在 `PINNED_ENV_ALLOWED_KEYS` 里登记并写清理由。',
        })
      }
      if (typeof step?.run !== 'string') {
        if (typeof step?.uses === 'string') {
          const problem = pinnedUsesProblem(step.uses, rootDir)
          if (problem !== null) {
            failures.push({
              name: relativePath,
              line: 0,
              detail: `[SK-17] ${label} 通过 \`uses: ${step.uses}\` 继续委派,而该目标不在判据的读取面内。`
                + `\n  ${problem}`,
            })
          }
        }
        return
      }
      const script = executableScript(step.run)
      // 步骤体那一层:`export`/前缀赋值（写入）+ `unset`/`env -u`（清除，J1 的 N2）。
      for (const assignment of shellEnvironmentAssignments(step.run)) {
        // [SK-20] 的**唯一** PATH 例外：`export PATH="${{ steps.frozen-launchers.outputs.path }}"`
        // 把 PATH **复位**到冻结值（方向与攻击相反 —— 攻击要往 PATH 前面塞假 bin）。
        if (assignment.name === 'PATH' && isFrozenLauncherPathExport(assignment.segment)) continue
        const name = assignment.unparsable === true
          ? null
          : (assignment.kind === 'unset' ? pinnedUnsetKeyProblem(assignment.name) : pinnedEnvKeyProblem(assignment.name))
        if (assignment.unparsable !== true && name === null) continue
        failures.push({
          name: relativePath,
          line: 0,
          detail: `[SK-17] ${label} 的步骤体用 \`${assignment.form}\` 写出了 `
            + `\`${assignment.name ?? assignment.segment}\`${assignment.unparsable === true ? '(分词失败)' : ''}`
            + `,而它寄宿在本地 composite action 里(引用它的被钉单元会整段执行它)。`
            + `\n  为什么必须拒:${assignment.unparsable === true ? '判据读不懂这段 shell 写出了哪个键,按未登记处理' : name.why}。`,
        })
      }
      // `$GITHUB_ENV` 写入:`$GITHUB_ENV` 是 job 级共享文件 ⇒ 键会被**调用方 job 的后续步骤**继承。
      if (GITHUB_ENV_APPEND.test(script)) {
        const normalized = advisoryFlagShape(script)
        for (const match of normalized.matchAll(GITHUB_ENV_KEY_ASSIGNMENT)) {
          const hit = pinnedEnvKeyProblem(match[1])
          if (hit === null) continue
          failures.push({
            name: relativePath,
            line: 0,
            detail: `[SK-17] ${label} 往 \`$GITHUB_ENV\` 写入了 \`${hit.raw}\`,而它寄宿在本地 composite `
              + 'action 里 —— `$GITHUB_ENV` 是 job 级共享文件,写入的键会被**调用方 job 的后续步骤**'
              + '(含被钉的守卫步)继承。'
              + `\n  为什么必须拒:${hit.why}。`
              + '\n  ⇒ 这正是 MAINCTL-3 的现场:一个仓内可判的文件里的 8 行 YAML 让"永不跳过"的'
              + '守卫 job 恒绿,而 workflow 文本一个字未改。',
          })
        }
      }
    })
  }
  notes.push(`[SK-17] 本地 composite action:${files.length} 个**被 workflow 引用**的 action 文件、`
    + `${checkedSteps} 个 composite step 的 \`env:\`/步骤体赋值/\`$GITHUB_ENV\` 写入/嵌套 \`uses:\` `
    + '已按同一套键表检查'
    + (unchecked === 0
      ? ''
      : `(另有 ${unchecked} 个未被引用的 action 文件不在被钉单元的执行链上,不判)`))
  return failures
}

/**
 * `with:` 取值的**归一形态**（用于与登记表逐字比较）。
 *
 * YAML 会把 `node-version: 24` 解析成**数字**、`fetch-depth: 0` 同样是数字、`enable-corepack: true`
 * 是布尔 —— 而登记表里写的是字符串。比较前统一成"字符串 + trim + CRLF→LF"，避免"取值的类型
 * 差异"变成假绿/假红。非标量（映射/序列）一律 JSON 化：它们本就该按未登记处理。
 * @param raw - YAML 解析出来的取值。
 * @returns 归一后的字符串。
 */
function normalizeWithValue(raw) {
  if (typeof raw === 'string') return raw.replace(/\r\n?/gu, '\n').trim()
  if (typeof raw === 'number' || typeof raw === 'boolean' || typeof raw === 'bigint') return String(raw)
  return JSON.stringify(raw ?? null)
}

/**
 * 一个 `uses:` 步骤的 `with:` 输入是否**未登记**（第十一轮审计 P1-3，本轮修复）。
 *
 * 判据（白名单，fail-closed；与 `pinnedUsesWithProblems` 的调用点一起读）：
 *   · 远端 action：`with:` 的每个键必须登记在 `PINNED_USES_WITH_REGISTRY` 的对应 `uses` 条目里，
 *     取值必须是登记值的逐字形态 —— 未登记的键 / 改过的取值一律红；
 *   · 本地 composite action（`./…`）：`with:` 的每个键必须在该 action 的 `action.yml` 的
 *     `inputs:` 里**声明**过（否则这个输入在执行体里根本读不到，判据也读不懂它想改什么）；
 *   · `with:` 不是映射（字符串/数字/序列）⇒ 红（判据读不懂这一步给 action 传了什么）。
 * @param uses - `step.uses` 的取值。
 * @param withValue - `step.with` 的取值。
 * @param rootDir - 仓库根（本地 action 的解析基准）。
 * @returns 问题描述数组（空 = 全部在读取面内）。
 */
function pinnedUsesWithProblems(uses, withValue, rootDir = root) {
  if (withValue === undefined || withValue === null) return []
  const value = typeof uses === 'string' ? uses.trim() : ''
  if (typeof withValue !== 'object' || Array.isArray(withValue)) {
    return [`它的 \`with:\` 不是一个映射（${JSON.stringify(withValue)}）⇒ 判据读不懂这一步给 `
      + `\`${value}\` 传了哪些输入。被钉单元里的 \`with:\` 必须是逐字登记的键值对。`]
  }
  const entries = Object.entries(withValue)
  if (entries.length === 0) return []
  const problems = []
  // 本地 composite action：以它自己声明的 `inputs:` 为准（判据读得到，且"声明了才有意义"）。
  if (value.startsWith('./')) {
    const declared = localActionDeclaredInputs(value, rootDir)
    for (const [key] of entries) {
      if (declared === null) {
        problems.push(`它给本地 action \`${value}\` 传了输入 \`${key}\`,但那个 action 的 `
          + '`action.yml` 读不到（路径不存在 / YAML 解析失败）⇒ 判据无法证明这个输入会做什么。')
        break
      }
      if (declared.includes(key)) continue
      problems.push(`它给本地 action \`${value}\` 传了输入 \`${key}\`,而那个 action 的 `
        + `\`action.yml\` 的 \`inputs:\` 里**没有声明**它（已声明:${declared.join('、') || '（无）'}）`
        + '⇒ 这个输入要么是笔误,要么是执行体通过别的方式读它(那样判据读不懂它的作用)。')
    }
    return problems
  }
  const entry = PINNED_USES_WITH_REGISTRY.find(item => item.uses === value)
  if (entry === undefined) {
    return [`它给 \`${value}\` 传了 ${entries.length} 个输入（${entries.map(([key]) => `\`${key}\``).join('、')}）,`
      + '而这个 action **没有登记任何允许的输入** ⇒ 未登记即红。']
  }
  for (const [key, raw] of entries) {
    const registered = entry.inputs.find(input => input.key === key)
    if (registered === undefined) {
      problems.push(`它的 \`with:\` 里有 \`${key}\`（取值 ${JSON.stringify(raw)}）,而它**不在** `
        + `\`PINNED_USES_WITH_REGISTRY\` 为 \`${value}\` 登记的输入表里`
        + `（已登记:${entry.inputs.map(input => `\`${input.key}\``).join('、') || '（无）'}）`
        + '\n  ⇒ `with:` 决定这一步**实际做什么**:同一步的 `fetch-depth` 早有专门判据([SK-8b]),'
        + '而"取哪棵树 / 用哪个解释器 / 缓存写进哪些目录"此前完全不在判据面内。'
        + '\n  ⇒ 要用新的输入,先把它连同**允许的逐字取值**与理由登记进那张表。')
      continue
    }
    const normalized = normalizeWithValue(raw)
    if (registered.values.includes(normalized)) continue
    problems.push(`它的 \`with.${key}\` 取值是 ${JSON.stringify(normalized)},`
      + `而登记值只有 ${registered.values.map(item => JSON.stringify(item)).join(' / ')}`
      + `\n  为什么必须逐字登记:${registered.why}`)
  }
  return problems
}

/**
 * 本地 composite action 的 `action.yml` 里**声明过的 `inputs:` 键**。
 * @param uses - `./…` 形态的本地路径。
 * @param rootDir - 仓库根。
 * @returns 键数组；读不到（路径/解析失败）时 `null`（调用方按"证明不了"处理）。
 */
function localActionDeclaredInputs(uses, rootDir = root) {
  const actionFile = resolveLocalActionFile(uses, rootDir)
  if (actionFile === null) return null
  try {
    const document = parseYaml(readFileSync(actionFile, 'utf8'))
    const inputs = document?.inputs
    return typeof inputs === 'object' && inputs !== null ? Object.keys(inputs) : []
  } catch {
    return null
  }
}

/**
 * `PINNED_USES_WITH_REGISTRY` 的**死条目对账**（与 `pinnedUsesRegistryProblem` 同一纪律）。
 *
 * 两个方向都要判：
 *   · 登记了但没有任何被钉单元在用（值域里的某个取值）⇒ 死条目 = 登记表在长成一个豁免洞；
 *   · 登记项挂在一个 `PINNED_USES_REGISTRY` 里根本没有的 `uses` 上 ⇒ 配置错误（两张表漂移）。
 * @param observedKeys - 本次扫描里被钉单元实际用到的 `uses\u0000键名` 集合。
 * @returns 失败项数组（空 = 每条登记都还在用）。
 */
function pinnedUsesWithRegistryProblems(observedKeys) {
  const used = new Set(Array.isArray(observedKeys) ? observedKeys : [])
  const failures = []
  const dead = []
  for (const entry of PINNED_USES_WITH_REGISTRY) {
    if (!PINNED_USES_REGISTRY.some(item => item.uses === entry.uses)) {
      failures.push({
        name: '[SK-17]',
        line: 0,
        detail: `\`PINNED_USES_WITH_REGISTRY\` 里的 \`${entry.uses}\` 不在 \`PINNED_USES_REGISTRY\` 里`
          + '\n  ⇒ 两张表漂移:能进 `with:` 判据面的 action 必须先是"被钉单元允许委派的目标"。',
      })
    }
    for (const input of entry.inputs) {
      if (used.has(`${entry.uses}\u0000${input.key}`)) continue
      dead.push(`  - \`${entry.uses}\` 的 \`with.${input.key}\``)
    }
  }
  if (dead.length > 0) {
    failures.push({
      name: '[SK-17]',
      line: 0,
      detail: `\`PINNED_USES_WITH_REGISTRY\` 里有 ${dead.length} 条**死条目**(没有任何被钉单元在用):`
        + `\n${dead.join('\n')}`
        + '\n  ⇒ 与 `PINNED_USES_REGISTRY` 同一纪律:不用的登记项必须清掉,否则这张表会悄悄长成'
        + '"谁都能往 `with:` 里塞一个输入"的豁免洞。',
    })
  }
  return failures
}

/**
 * 绑定在"被钉单元"上的 `uses:` 登记表的**死条目对账**(与 SWALLOW_ALLOWLIST 同一纪律)。
 *
 * @param observed - 本次全仓扫描里被钉单元实际用到的 `uses:` 取值(去重)。
 * @returns 失败项数组(空 = 每条登记都还在用)。 */
function pinnedUsesRegistryProblem(observed) {
  const used = new Set(Array.isArray(observed) ? observed : [])
  const dead = PINNED_USES_REGISTRY.filter(entry => !used.has(entry.uses))
  if (dead.length === 0) return []
  return [{
    name: '[SK-17]',
    line: 0,
    detail: `PINNED_USES_REGISTRY 里有 ${dead.length} 条**死条目**(没有任何被钉单元再用它):`
      + `\n${dead.map(entry => `  - \`${entry.uses}\``).join('\n')}`
      + '\n  ⇒ 登记表会悄悄长成一个"谁都能往里塞一个 action"的豁免洞:不用的条目必须清掉。',
  }]
}

/**
 * 本地 composite action 判据的**自证**(第十轮审计 C-03 / MAINCTL-3)。
 *
 * 为什么必须单独一个自证:这条判据的输入是**目录**(`.github/actions/**`),不是 workflow
 * 文本 —— `gateSample` 那套合成文本机制覆盖不到它,而"用合成文件树跑一遍真判据"才是
 * 能被打坏的形态(把 `checkCompositeActionTree()` 的 `$GITHUB_ENV` 那一段删掉,
 * 下面第 1/3 条断言立刻红)。
 *
 * 五个断言各钉一件事:
 *   ① composite action 里的 `$GITHUB_ENV` 写入被树扫描抓到(而且点名了那个 action);
 *   ② 干净 action(`export VERSION=…` 这种登记键)不报(不得一刀切);
 *   ③ 同一份 poison 内容在**workflow 文本只有一个 `uses:` 行**时也会被读到 —— 这是本条
 *      判据存在的理由(第九轮把它算进了"被钉住的判定单元"却从不读它的内容);
 *   ④ 本地路径解析不到 / 非 composite 的执行体 ⇒ 红(读不懂的执行体不能算覆盖);
 *   ⑤ 变异:把 poison 里那一行 `$GITHUB_ENV` 写入删掉之后**必须不再报**
 *      (证明第 ①③ 条不是恒真断言)。
 *
 * @returns `{ failures, assertions }`。
 */
function selfTestCompositeActions() {
  const failures = []
  let assertions = 0
  const directory = mkdtempSync(join(tmpdir(), 'dsh-composite-selftest-'))
  try {
    const actionsRoot = join(directory, '.github', 'actions')
    const writeAction = (name, lines) => {
      mkdirSync(join(actionsRoot, name), { recursive: true })
      writeFileSync(join(actionsRoot, name, 'action.yml'), [...lines, ''].join('\n'))
    }
    const poisonLines = envLine => [
      `name: ${envLine === null ? 'clean' : 'poison'}`,
      'runs:',
      '  using: composite',
      '  steps:',
      '    - shell: bash',
      '      env:',
      "        VERSION: '1.2.3'",
      '      run: |',
      '        set -euo pipefail',
      ...(envLine === null ? ['        export VERSION=1.2.3'] : [`        ${envLine}`]),
    ]
    writeAction('poison', poisonLines('echo "NODE_OPTIONS=--import=data:text/javascript,process.exitCode=0" >> "$GITHUB_ENV"'))
    writeAction('clean', poisonLines(null))
    writeAction('nodekind', [
      'name: nodekind',
      'runs:',
      '  using: node20',
      '  main: index.js',
    ])
    const notes = []
    const treeFailures = checkCompositeActionTree(actionsRoot, notes, directory)
    assertions += 1
    const poisonHits = treeFailures.filter(entry => entry.name.includes('poison'))
    if (poisonHits.length === 0) {
      failures.push('[composite-selftest] 合成树里的 poison composite action 没有被抓到'
        + '(它的 `$GITHUB_ENV` 写入会让引用它的被钉单元恒绿)。')
    } else if (!poisonHits.some(entry => entry.detail.includes('NODE_OPTIONS'))) {
      failures.push('[composite-selftest] 抓到 poison 但报错里没有点名 `NODE_OPTIONS`(诊断读不出病根)。')
    }
    assertions += 1
    // 键名必须**恰好一个**(第十轮修复过程实测的假阳性):`$GITHUB_ENV` 的键名提取若用宽正则,
    // `NODE_OPTIONS=--import=data:…` 里的 `import=`、`…process.exitCode=0` 里的 `exitCode=`
    // 会被当成"又写了两个键"⇒ 白名单下就是两条假红(要求 `GITHUB_ENV_KEY_ASSIGNMENT`)。
    if (poisonHits.length > 1) {
      failures.push(`[composite-selftest] 一条 \`$GITHUB_ENV\` 注入被报成 ${poisonHits.length} 条`
        + `(键名提取把**取值里**的 \`=\` 片段也算成键):${poisonHits.map(entry => entry.detail.split('写入了')[1]?.slice(0, 12)).join(' / ')}`)
    }
    assertions += 1
    const cleanHits = treeFailures.filter(entry => entry.name.includes('clean'))
    if (cleanHits.length > 0) {
      failures.push(`[composite-selftest] 干净 composite action 被误报:${cleanHits[0].detail.split('\n')[0]}`)
    }
    assertions += 1
    const nodeKindHits = treeFailures.filter(entry => entry.name.includes('nodekind'))
    if (nodeKindHits.length === 0) {
      failures.push('[composite-selftest] `runs.using: node20` 的本地 action 没有被判红'
        + '(它的执行体是 js,不在判据的读取面内 ⇒ 引用它的被钉单元等于不受判)。')
    }
    const workflow = [
      'name: selftest',
      'on:',
      '  push:',
      'jobs:',
      '  gate-guards:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: ./.github/actions/poison',
      '      - run: node scripts/check-root-guards.mjs',
      '  other:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: ./.github/actions/missing',
      '      - uses: ./.github/actions/clean',
      '      - run: node scripts/check-root-guards.mjs',
      '',
    ].join('\n')
    const result = checkWorkflowText('selftest.yml', workflow, { rootDir: directory })
    assertions += 1
    // 可解析、且是 composite ⇒ `uses:` 这一层**通过**(内容由 `checkCompositeActionTree()`
    // 覆盖,上面第 ① 条断言已经证明它抓到了 poison 的那一行)。这里钉住"不得误报"。
    const localUses = result.failures.filter(entry => entry.detail.includes('.github/actions/poison'))
    if (localUses.length > 0) {
      failures.push('[composite-selftest] 可解析的本地 composite action 被 `uses:` 这一层误报:'
        + `${localUses[0].detail.split('\n')[0]}(它的内容由 .github/actions 的树扫描负责)。`)
    }
    assertions += 1
    if (!result.failures.some(entry => entry.detail.includes('.github/actions/missing'))) {
      failures.push('[composite-selftest] 指向不存在路径的 `uses:` 没有被判红'
        + '(判据读不到它的内容,不能假装它可判)。')
    }
    assertions += 1
    if (result.failures.some(entry => entry.detail.includes('actions/clean'))) {
      failures.push('[composite-selftest] 干净的本地 composite action 在 workflow 侧被误报。')
    }
    // ⑤ **接线**断言(变异实测出来的形态):把 `main()` 里那一次 `checkCompositeActionTree()`
    //    调用删掉之后,上面所有断言**照样绿**(自检直接调函数),而真实 workflow 里的
    //    poison 不再被抓 —— "判据在、接线没了"。这一条读本文件自己的源码点名那次调用
    //    (与 `wasm-app-open-route-parity` 那类源码级接线守卫同一手法:行为断言覆盖不到
    //    "函数还在但没人调用")。
    assertions += 1
    const ownSource = readFileSync(import.meta.filename, 'utf8')
    const wiringNeedle = ['failures.push(...checkComposite', 'ActionTree(actionsRoot'].join('')
    const wiring = ownSource.split('\n').filter(line => line.includes(wiringNeedle))
    if (wiring.length !== 1) {
      failures.push(`[composite-selftest] 本文件源码里的 composite 扫描接线出现 ${wiring.length} 次`
        + '(期望 1 次)⇒ 判据函数还在但**没有接到全仓扫描**上,真实仓里的 composite action 不再被检查。')
    }
    // ⑤b **引用集合**的接线(第十一轮审计 P2-2):`checkCompositeActionTree()` 必须拿到
    //     "由 workflow 文本解析出来的引用集合" —— 少了它判据会退化成"整棵树按被钉白名单判",
    //     将来只被非判据步骤引用的本地 action 会被误红(假红方向的边界)。
    assertions += 1
    const referencedNeedle = ['referenced: collectReferenced', 'LocalActions('].join('')
    const referencedWiring = ownSource.split('\n').filter(line => line.includes(referencedNeedle))
    if (referencedWiring.length !== 1) {
      failures.push(`[composite-selftest] 引用集合的接线出现 ${referencedWiring.length} 次(期望 1 次)`
        + '⇒ 判据退化成"整棵树按被钉白名单判":未被引用的本地 action 会被误红。')
    }
    // ⑦ **引用集合**（第十一轮审计 P2-2）：判据只判"被 workflow 引用到的"本地 action。
    //    行为判据（不是源码字符串）：合成树里放一个**未被引用**的 poison，传入"只引用 poison"
    //    的集合 ⇒ 它必须**不**被报（否则假红方向的边界没修好），而被引用的那个必须照报。
    writeAction('poison-unreferenced',
      poisonLines('echo "NODE_OPTIONS=--import=data:text/javascript,process.exitCode=0" >> "$GITHUB_ENV"'))
    const referencedOnlyNotes = []
    const referencedOnly = checkCompositeActionTree(actionsRoot, referencedOnlyNotes, directory, {
      referenced: new Set([join(actionsRoot, 'poison', 'action.yml')]),
    })
    assertions += 1
    if (referencedOnly.some(entry => entry.name.endsWith('poison-unreferenced/action.yml'))) {
      failures.push('[composite-selftest] **未被引用**的本地 composite action 被当成被钉单元判了'
        + '（第十一轮审计 P2-2 的假红边界:引用集合必须真的被用来过滤）。')
    }
    assertions += 1
    if (!referencedOnly.some(entry => entry.name.endsWith('/poison/action.yml'))) {
      failures.push('[composite-selftest] 被引用的 poison 在没有被报出来'
        + '（引用集合过滤不能变成"一律不判"）。')
    }
    assertions += 1
    if (!referencedOnlyNotes.some(note => note.includes('未被引用'))) {
      failures.push('[composite-selftest] 未引用的 action 必须**单独提示**（否则"不判"会静默成'
        + '"不存在"),实际 notes 里没有那条提示。')
    }
    // ⑥ 变异:删掉 poison 的那一行之后,同一条判据必须**不再报**(否则它是恒真的)。
    writeAction('poison', poisonLines(null))
    // 引用集合也要传（否则上面那个 `poison-unreferenced` 会把这次变异的结果污染成"仍然报红"）。
    const mutated = checkCompositeActionTree(actionsRoot, [], directory, {
      referenced: new Set([join(actionsRoot, 'poison', 'action.yml')]),
    })
    assertions += 1
    if (mutated.some(entry => entry.name.includes('poison'))) {
      failures.push('[composite-selftest] 变异验证:把 poison 的 `$GITHUB_ENV` 写入删掉之后仍然报红'
        + ' ⇒ 这条判据不是"读到了内容",而是恒真断言。')
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
  return { failures, assertions }
}

/**
 * [SK-17] 的**层清单自证**(第十轮审计 C-02:覆盖面声明必须与代码里的枚举同源)。
 *
 * 判据:在**合成** workflow 上跑一遍 `checkPinnedStepEnvironment()`,它逐层产出的 id 集合
 * 必须与 `PINNED_ENV_LAYER_REGISTRY` **双向相等** —— 少一层(有人把某层的枚举删了)即红,
 * 多一层(有人加了枚举却没登记)也红。这样"通过行里声称检查了哪几层"就不可能再与代码漂移
 * (C-02 的现场:日志硬编码"三层 `env:` … 均已检查",而 `container.env` 那一层根本没读)。
 *
 * @returns `{ failures, assertions }`。
 */
function selfTestPinnedEnvLayers() {
  const failures = []
  let assertions = 0
  const text = [
    'name: selftest',
    'on:',
    '  push:',
    'env:',
    "  VERSION: '1.2.3'",
    'jobs:',
    '  gate-guards:',
    '    runs-on: ubuntu-latest',
    '    container:',
    '      image: node:24-bookworm',
    '      env:',
    "        VERSION: '1.2.3'",
    '    env:',
    "      VERSION: '1.2.3'",
    '    steps:',
    '      - name: Root guards (every PR shape)',
    '        env:',
    "          VERSION: '1.2.3'",
    '        run: |',
    '          set -euo pipefail',
    '          export VERSION=1.2.3',
    '          node scripts/check-root-guards.mjs',
    '  changes:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: |',
    '          set -euo pipefail',
    "          echo \"VERSION=1.2.3\" >> \"$GITHUB_ENV\"",
    '',
  ].join('\n')
  const document = parseYaml(text)
  const blocks = extractRunBlocks(text)
  const result = checkPinnedStepEnvironment('selftest.yml', document, blocks, [], { rootDir: root })
  const produced = new Set((result?.layers ?? []).map(layer => layer.id))
  assertions += 1
  const missing = PINNED_ENV_LAYER_REGISTRY.filter(layer => !produced.has(layer.id))
  if (missing.length > 0) {
    failures.push('[SK-17] 层清单自证:合成样本上这些层**一次都没被枚举**:'
      + `${missing.map(layer => `${layer.id}(${layer.label})`).join('、')}`
      + ' ⇒ 判据面比 `PINNED_ENV_LAYER_REGISTRY` 声明的窄(通过行会撒谎)。')
  }
  assertions += 1
  const unknown = [...produced].filter(id => !PINNED_ENV_LAYER_REGISTRY.some(layer => layer.id === id))
  if (unknown.length > 0) {
    failures.push(`[SK-17] 层清单自证:枚举产出了未登记层 ${unknown.join('、')}`
      + ' ⇒ 新增的判据面没有写进 `PINNED_ENV_LAYER_REGISTRY`(声明与代码必须同源)。')
  }
  assertions += 1
  // 反向:把登记表**临时**砍掉一层,枚举结果必须报出缺口(证明上面那条断言真能被打坏)。
  const removed = PINNED_ENV_LAYER_REGISTRY.pop()
  try {
    const trimmed = new Set((checkPinnedStepEnvironment('selftest.yml', document, blocks, [], { rootDir: root })?.layers ?? [])
      .map(layer => layer.id))
    if (trimmed.size === produced.size) {
      failures.push('[SK-17] 层清单自证:抽掉登记表最后一条之后 id 集合**没有变化** ⇒ '
        + '断言是恒真的(它证明不了任何东西)。')
    }
  } finally {
    PINNED_ENV_LAYER_REGISTRY.push(removed)
  }
  return { failures, assertions }
}

/**
 * 步骤是否**因为别的 job 的 result** 而存在(`if:` 或可执行文本里引用 `needs.<job>.result`)。
 *
 * [SK-14] 的 `root-guard-link` 用它做**结构识别**(R8-C-2):旧口径要求"文本里有
 * `exit [1-9]`"—— 那是自指条件(识别取决于它还没被掏空)。改成"引用别人的 result"之后,
 * 把收尾 `exit 1` 注释掉 **不会**让它从被钉清单里消失,⑥ 仍然会判它的步骤体。
 *
 * @param script - 去注释后的可执行文本。
 * @param ifValue - 该步骤的 `if:` 取值(可为 undefined)。
 * @returns 是否引用 `needs.<job>.result`。
 */
function needsResultReference(script, ifValue) {
  const pattern = /needs\.[A-Za-z_][\w-]*\.result/u
  return pattern.test(script) || (typeof ifValue === 'string' && pattern.test(ifValue))
}

/**
 * 这份 workflow 的**可执行文本**里是否出现发布链命令(注释里写不算)。
 * @param text - workflow 原文。
 * @returns 是否承载发布链。
 */
function carriesReleaseLine(text) {
  return extractRunBlocks(text)
    .map(block => executableScript(block.content))
    .some(script => RELEASE_LINE_ANCHORS.some(anchor => script.includes(anchor)))
}

/**
 * `if:` 是否**静态可判定为假**(布尔 false / `'false'` / `${{ false }}` / `0` / 空串)。
 *
 * 只判"逐字常量"这一档:其余表达式(如 `needs.x.outputs.y == 'z'`)静态度量不出真假,
 * 交由 `PINNED_STEP_IF_POLICIES` 的**形态登记**兜住(与 [SK-7a] 对表达式形态
 * `continue-on-error` 的口径一致:求不出真假 ⇒ 按"会静默"处理)。
 * @param value - YAML 解析出来的 `if:` 取值。
 * @returns 是否恒假。
 */
function isConstantFalseIf(value) {
  if (value === false) return true
  if (value === undefined || value === null) return false
  if (typeof value === 'number') return value === 0
  if (typeof value !== 'string') return false
  const text = value.trim()
  if (text === '') return true
  // `${{ … }}` 只看花括号里的表达式本身(`${{ false }}` 与 `false` 同判)。
  const inner = /^\$\{\{([\s\S]*)\}\}$/u.exec(text)?.[1]
  const probe = (inner ?? text).trim().toLowerCase()
  return probe === 'false' || probe === '0' || probe === "''" || probe === '""'
}

/**
 * **能力级**的"能写远端对象存储"识别表(2026-09-23 第五轮审计 R5-C-6 / R5-D-2)。
 *
 * 现场:旧实现只认 4 条**登记命令**(`EXTERNAL_UPLOAD_COMMANDS`),于是
 *   · 在说明检查**之前**插一条内联 `aws s3 cp … s3://…` 上传步骤 ⇒ 守卫 EXIT=0
 *     (它不在那 4 条里,`isUpload` 看不见;客户侧更新面被绕过说明门);
 *   · 发布链里别的被策略"点名"的步骤加 `if: false` / `continue-on-error` ⇒ 也 EXIT=0
 *     (SK-11 与公证三元组策略只看"文本在不在")。
 *
 * 现在的口径:**能力**优先于命令名 —— 任何"真的能写远端对象存储/发布面"的步骤都必须
 * 先过策展说明检查;识别不了归属的新形态一律**判红并要求登记**(见
 * `REMOTE_WRITE_REGISTERED`),而不是默默放行。
 *
 * `surface` 取值:
 *   · `release-surface`   —— 客户侧/公开发布面(更新服务器、GitHub Release);
 *   · `run-scoped`        —— run 级临时中转(只有显式登记的例外,见下);
 *   · `unregistered`      —— 未登记的新形态 ⇒ 判红(必须登记成上面两类之一)。
 */
const REMOTE_WRITE_CAPABILITIES = [
  {
    id: 'publish-update-server',
    label: '更新服务器发布脚本',
    surface: 'release-surface',
    re: /\bci-publish-update-server\.sh\b/u,
  },
  {
    id: 'gh-release',
    label: '`gh release create|edit|upload`',
    surface: 'release-surface',
    re: /(?:^|[;&|(\n]|\$\()\s*gh\s+release\s+(?:create|edit|upload)\b/u,
  },
  {
    id: 'aws-s3-write',
    label: '`aws s3 cp|sync|mv|rm` / `aws s3api put-object|delete-object`',
    surface: 'unregistered',
    re: /(?:^|[;&|(\n]|\$\()\s*aws\s+s3(?:api)?\s+(?:cp|sync|mv|rm|put-object|delete-object)\b/u,
  },
  {
    id: 'rclone-write',
    label: '`rclone copy|sync|move|delete|purge`',
    surface: 'unregistered',
    re: /(?:^|[;&|(\n]|\$\()\s*rclone\s+(?:copy|sync|move|delete|purge)\b/u,
  },
  {
    id: 'gsutil-write',
    label: '`gsutil cp|rsync|mv|rm`',
    surface: 'unregistered',
    re: /(?:^|[;&|(\n]|\$\()\s*gsutil\s+(?:cp|rsync|mv|rm)\b/u,
  },
  {
    id: 'azure-blob-write',
    label: '`az storage blob upload|delete|copy`',
    surface: 'unregistered',
    re: /(?:^|[;&|(\n]|\$\()\s*az\s+storage\s+blob\s+(?:upload|delete|copy)\b/u,
  },
  {
    id: 's3-cli-alias',
    label: '其它对象存储 CLI(`s5cmd` / `ossutil` / `coscli` / `mc`)',
    surface: 'unregistered',
    re: /(?:^|[;&|(\n]|\$\()\s*(?:s5cmd|ossutil|coscli|mc)\s+(?:cp|mirror|sync|mv|rm)\b/u,
  },
  {
    id: 'curl-upload',
    label: '`curl -T/--upload-file`(裸 HTTP PUT 上传)',
    surface: 'unregistered',
    re: /(?:^|[;&|(\n]|\$\()\s*curl\b[^\n]*\s(?:-T|--upload-file)(?:\s|=)/u,
  },
  {
    id: 'channel-transfer-push',
    label: '`ci-channel-transfer.sh push`(run 级临时中转前缀)',
    surface: 'run-scoped',
    re: /\bci-channel-transfer\.sh\s+push\b/u,
  },
]
/**
 * **run 级中转**的显式登记(唯一允许"不上说明门"的对外写入面,逐条写明理由)。
 *
 * 刻意**不含** `ci-channel-transfer.sh pull/clean`:那两条是读/清理,不是对外写。
 * 登记项会被对账(登记了却不再命中 ⇒ 红),避免它长成一个"谁都能塞"的豁免洞。
 */
const REMOTE_WRITE_REGISTERED = [
  {
    file: 'ci.yml',
    job: 'desktop-linux',
    step: 'Transfer brand-channel installers over R2 (not via public artifacts)',
    capability: 'channel-transfer-push',
    surface: 'run-scoped',
    why: '上传到 R2 上由 run id + HMAC(R2 密钥)派生的**临时中转前缀**,同 run 结束前由 '
      + 'release job 的 `if: always()` 步骤销毁;客户侧更新面在 release job(那里有说明门)',
  },
  {
    file: 'ci.yml',
    job: 'desktop-windows',
    step: 'Transfer brand-channel installers over R2 (not via public artifacts)',
    capability: 'channel-transfer-push',
    surface: 'run-scoped',
    why: '同上:run 级临时中转前缀,不是客户侧更新面',
  },
  {
    file: 'ci.yml',
    job: 'desktop-macos',
    step: 'Transfer brand-channel DMGs over R2 (not via public artifacts)',
    capability: 'channel-transfer-push',
    surface: 'run-scoped',
    why: '同上:run 级临时中转前缀,不是客户侧更新面',
  },
]
/**
 * 交付物/判据 job 的**不可静默跳过**登记表(2026-09-23 第五轮审计 R5-D-1 / R4-A N6)。
 *
 * 现场:SK-14⑤ 只判"**被钉步骤所在 job**"的常量假 `if:`;而 `desktop-linux` /
 * `desktop-windows` / `desktop-macos` / `release` / `pr-summary` 这些 job **没有任何
 * 判据读它们的 `if:`** —— 把 `desktop-linux` 的 `if:` 换成 `false`,三个平台 job 整块
 * 不跑(零安装包),`[SK-8]/[SK-9]/[SK-10]/[SK-12]` 只认各自点名的对象 ⇒ 全绿。
 *
 * 现在的口径:**每个 job 都必须登记**(登记了却不存在 / 存在却没登记,两个方向都红),
 * 且 `if:` 必须是登记过的**逐字形态**(常量假、`… && false`、偷偷加
 * `event_name == 'workflow_dispatch'` 这类收窄都会红)。正当的条件型 `if:` 不是被禁,
 * 而是必须**显式登记 + 写明依据**。
 */
const REGISTERED_WORKFLOW_FILES = ['ci.yml', 'codeql.yml', 'notary-probe.yml']
const REGISTERED_JOBS = [
  {
    file: 'ci.yml',
    job: 'changes',
    ifPolicy: 'never',
    why: 'docs-only 分类器:整条门禁的输入,任何条件下都必须跑(它自己不依赖别的 job)',
  },
  {
    file: 'ci.yml',
    job: 'gate-guards',
    ifPolicy: 'never',
    why: '根守卫 job:docs-only 的 PR 也必须跑(2026-09-19 第三轮审计 C-3 / 线上 PR #129 的复发路径)',
  },
  {
    file: 'ci.yml',
    job: 'gate',
    ifPolicy: 'exact',
    ifValue: '!cancelled()',
    why: '全量门禁:必须在上游 job 失败时也运行(否则"守卫失败 ⇒ 门禁红"的链路断掉)',
  },
  {
    file: 'ci.yml',
    job: 'server',
    ifPolicy: 'exact',
    ifValue: "needs.changes.result != 'success' || needs.changes.outputs.code == 'true'",
    why: 'docs-only 的 **fail-safe** 形态:分类器失败/输出为空时走完整路径(docs-only 只是一种加速)',
  },
  {
    file: 'ci.yml',
    job: 'desktop-linux',
    ifPolicy: 'exact',
    ifValue: "needs.changes.result != 'success' || needs.changes.outputs.code == 'true'",
    why: 'Linux 安装包(AppImage/deb)+ 客户端 e2e:交付物 job,必须是同一个 fail-safe 形态',
  },
  {
    file: 'ci.yml',
    job: 'desktop-windows',
    ifPolicy: 'exact',
    ifValue: "needs.changes.result != 'success' || needs.changes.outputs.code == 'true'",
    why: 'Windows 安装包(NSIS):交付物 job,必须是同一个 fail-safe 形态',
  },
  {
    file: 'ci.yml',
    job: 'desktop-macos',
    ifPolicy: 'exact',
    ifValue: "needs.changes.result != 'success' || needs.changes.outputs.code == 'true'",
    why: 'macOS DMG(含签名+公证):交付物 job,必须是同一个 fail-safe 形态',
  },
  {
    file: 'ci.yml',
    job: 'release',
    ifPolicy: 'exact',
    ifValue: "startsWith(github.ref, 'refs/tags/v')",
    why: '发布 job:**只**允许判"是不是 v 开头的 tag"(形态→渠道集/是否发布的映射是 '
      + 'scripts/ci-release-policy.sh 的唯一真源,由 gate 第一步执行)。'
      + '`if: false` / `… && false` / `… && github.event_name == \'workflow_dispatch\'` '
      + '都会让"job 在、命令文本在、但永不执行" ⇒ 必须逐字登记(R4-A N6)',
  },
  {
    file: 'ci.yml',
    job: 'pr-summary',
    ifPolicy: 'exact',
    ifValue: "always() && github.event_name == 'pull_request' && !github.event.pull_request.head.repo.fork",
    why: 'PR 汇总评论:只在**非 fork 的 PR** 上运行是产品约定(信息面 job,不产交付物也不跑判据)',
  },
  {
    file: 'codeql.yml',
    job: 'analyze',
    ifPolicy: 'exact',
    ifValue: "github.event_name != 'pull_request' || !github.event.pull_request.head.repo.fork",
    why: 'CodeQL 分析:fork PR 没有 secrets ⇒ 只在非 fork PR / push / 定时上跑(安全扫描面)',
  },
  {
    file: 'notary-probe.yml',
    job: 'probe',
    ifPolicy: 'never',
    why: '公证历史查询(workflow_dispatch 触发):任何一次手动触发都必须真的跑',
  },
]
/**
 * 发布链**必须执行的步骤**登记表(2026-09-23 第五轮审计 R5-D-2)。
 *
 * 现场:SK-11 只判"说明检查在不在、在不在上传之前",公证三元组策略只看 `env:` 键 ——
 * 于是给这些步骤加 `if: false` / `continue-on-error: true`(只加一行、`run` 一字不改)
 * 就能让 R2 上传、渠道 DMG 公证、GitHub Release 全部静默,而两条根守卫都 EXIT=0。
 *
 * 口径:
 *   · **每个 job `release` 里的步骤都必须登记**(新增一步必须登记);
 *   · 任何"能写远端对象存储"的步骤(能力级识别)都必须登记;
 *   · 任何承载发布链命令(RELEASE_LINE_ANCHORS)、公证命令(dist:mac:notarize)的步骤
 *     都必须登记;
 *   · 登记项的两侧都红:登记了却找不到 / 找到却没登记。
 * `require`:该步骤的可执行文本里必须出现的子串(**效果**判据,不只是"文本在不在"的
 * 存在性判据 —— 例如说明门必须真的从 `ci-release-policy.sh` 取 `release_kind`)。
 */
const REGISTERED_RELEASE_STEPS = [
  {
    file: 'ci.yml',
    job: 'gate',
    step: 'Classify the release tag (single source of truth)',
    ifPolicy: 'never',
    require: ['scripts/ci-release-policy.sh', 'GITHUB_OUTPUT'],
    why: '形态→渠道集/是否发布的唯一真源:它不跑,后面的说明门与渠道集全部失去依据',
  },
  {
    file: 'ci.yml',
    job: 'gate',
    step: 'Require curated release notes for release tags',
    ifPolicy: 'exact',
    ifValue: "steps.release_policy.outputs.release_kind != 'none'",
    require: ['docs/releases/', 'test -f', 'exit 1'],
    why: '发布 tag 的策展说明早检(1 分钟内报错,正式版与预发版一律要求);'
      + '条件必须取自上面那一步的 outputs(而不是写死的名字形状判断)',
  },
  {
    file: 'ci.yml',
    job: 'gate',
    step: 'Resolve the channel packages revision (once per run)',
    ifPolicy: 'exact',
    ifValue: "startsWith(github.ref, 'refs/tags/v')",
    require: ['scripts/ci-channels.sh --resolve-only', 'GITHUB_OUTPUT'],
    why: '渠道仓 revision **一处解析、全链复用**(2026-09-23 另一泳道的修复):'
      + '它不跑 ⇒ 下游拿不到 pin,同一 tag 的交付物不再同源/可复现',
  },
  {
    file: 'ci.yml',
    job: 'gate',
    step: 'Release topology (previous release tag is an ancestor; tag is on the mainline)',
    ifPolicy: 'exact',
    ifValue: "startsWith(github.ref, 'refs/tags/v')",
    require: ['scripts/ci-release-topology.sh'],
    why: 'tag 必须打在主线且包含上一个 tag(旁支拓扑会静默丢掉上一版的修复);'
      + '判据本体在 ci-release-topology.sh(R5-C-4),这一步必须仍然调用它',
  },
  {
    file: 'ci.yml',
    job: 'release',
    step: 'Require curated release notes before any upload',
    ifPolicy: 'never',
    require: ['scripts/ci-release-policy.sh', 'docs/releases/', 'test -f', 'exit 1'],
    why: '任何对外上传之前的第二道说明门,必须无条件运行(它自己在脚本里按 release_kind 分支)',
  },
  {
    file: 'ci.yml',
    job: 'release',
    step: 'Verify tag matches package versions',
    ifPolicy: 'never',
    require: ['scripts/version.mjs check'],
    why: 'tag 与两处 package.json 版本必须逐字一致(不一致会让升级源永久对不上)',
  },
  {
    file: 'ci.yml',
    job: 'release',
    step: 'Fetch channel packages (private repo)',
    ifPolicy: 'never',
    require: ['scripts/ci-channels.sh'],
    why: '渠道发现:发布面按渠道逐个构建,跳过后官方之外的渠道零交付',
  },
  {
    file: 'ci.yml',
    job: 'release',
    step: 'Fetch brand-channel installers from the R2 transfer prefix',
    ifPolicy: 'never',
    require: ['scripts/ci-channel-transfer.sh pull'],
    why: '取回品牌渠道客户端产物(它们要打进各渠道镜像)',
  },
  {
    file: 'ci.yml',
    job: 'release',
    step: 'Build one server image per channel',
    ifPolicy: 'never',
    require: ['scripts/ci-build-channel-images.sh'],
    why: '逐渠道镜像构建:发布物的本体',
  },
  {
    file: 'ci.yml',
    job: 'release',
    step: 'Upload every channel image to the update server (R2)',
    ifPolicy: 'never',
    require: ['scripts/ci-publish-update-server.sh'],
    why: 'R2 是**客户侧更新面的唯一来源**;它被静默跳过 = 客户端永远停在上一版',
  },
  {
    file: 'ci.yml',
    job: 'release',
    step: 'Create GitHub Release',
    ifPolicy: 'never',
    require: ['gh release', 'docs/releases/'],
    why: '公开 Release 面(名字 = tag,说明 = 策展文件)',
  },
  {
    file: 'ci.yml',
    job: 'release',
    step: 'Destroy the R2 transfer prefix',
    ifPolicy: 'exact',
    ifValue: 'always()',
    why: '无论前面成功失败都要销毁 run 级中转前缀(否则品牌产物长期留在 R2)',
  },
  {
    file: 'ci.yml',
    job: 'desktop-linux',
    step: 'Transfer brand-channel installers over R2 (not via public artifacts)',
    ifPolicy: 'exact',
    ifValue: "!github.event.pull_request.head.repo.fork && startsWith(github.ref, 'refs/tags/v')",
    require: ['scripts/ci-channel-transfer.sh push'],
    why: '品牌渠道安装包只经 R2 中转(不进公开 artifact);条件 = 非 fork PR 且是 tag',
  },
  {
    file: 'ci.yml',
    job: 'desktop-windows',
    step: 'Transfer brand-channel installers over R2 (not via public artifacts)',
    ifPolicy: 'exact',
    ifValue: "!github.event.pull_request.head.repo.fork && startsWith(github.ref, 'refs/tags/v')",
    require: ['scripts/ci-channel-transfer.sh push'],
    why: '同上(Windows 侧)',
  },
  {
    file: 'ci.yml',
    job: 'desktop-macos',
    step: 'Notarize and build DMG (resumable)',
    ifPolicy: 'exact',
    ifValue: "startsWith(github.ref, 'refs/tags/v') && !contains(github.ref_name, '-')",
    require: ['dist:mac:notarize'],
    why: '正式 tag 的官方 DMG 必须签名 + 公证 + staple(只签名会被 Gatekeeper 拦)',
  },
  {
    file: 'ci.yml',
    job: 'desktop-macos',
    step: 'Package brand-channel DMGs (quiet, signed + notarized)',
    ifPolicy: 'exact',
    ifValue: "startsWith(github.ref, 'refs/tags/v')",
    require: ['scripts/ci-package-clients.sh', 'dist:mac:notarize'],
    why: '渠道 DMG 是客户交付物:正式 tag 上与官方同链签名+公证(2026-09-11 现场)',
  },
  {
    file: 'ci.yml',
    job: 'desktop-macos',
    step: 'Transfer brand-channel DMGs over R2 (not via public artifacts)',
    ifPolicy: 'exact',
    ifValue: "startsWith(github.ref, 'refs/tags/v')",
    require: ['scripts/ci-channel-transfer.sh push'],
    why: '渠道 DMG 只经 R2 中转',
  },
]
/**
 * 三个 SK-15 判据的**默认登记表**。
 *
 * 之所以做成一个对象(而不是各自读常量):内置自检要能在**合成样本**上验证这三条判据
 * 本身(登记项被删/形态被改/未登记对象出现都必须红),而合成样本的 job/步骤名不可能与
 * 真实 ci.yml 的登记项一致 —— 用 `checkWorkflowText(name, text, { registries })` 这个
 * **测试缝**注入合成登记表(与 `--workflows-dir` 同一性质:CI 与 `yarn check` 永不传它)。
 */
const REGISTRY_DEFAULT = {
  files: REGISTERED_WORKFLOW_FILES,
  jobs: REGISTERED_JOBS,
  steps: REGISTERED_RELEASE_STEPS,
  remoteWrites: REMOTE_WRITE_REGISTERED,
  containerImages: PINNED_JOB_CONTAINER_REGISTRY,
}
/**
 * **空登记表**:内置自检的合成样本默认用它 —— 否则每个合成了 `ci.yml` 形状的样本
 * (SK-8/SK-9/SK-11/SK-12 的那些)都会被 SK-15 拿"真实 ci.yml 的登记值"去套,
 * 得到一堆与样本意图无关的假红(SK-15 的样本改用下面那张合成登记表)。
 */
const REGISTRY_NONE = {
  files: [], jobs: [], steps: [], remoteWrites: [], containerImages: [],
  // 自检合成样本的 `runs-on` 登记项(见 `SELFTEST_RUNS_ON_REGISTRY`):缺了它,凡是被钉单元
  // 出现在合成 job(`verify`)里的样本都会被 `runs-on` 判据判红 —— 那是与样本意图无关的假红。
  ...SELFTEST_RUNS_ON_REGISTRY,
}
/**
 * SK-15 自检用的**合成登记表**:一个 job `verify` + 一个步骤 `Gate`。
 * 用它把"登记了却不存在 / 存在却没登记 / 常量假 if / 收窄 if / continue-on-error /
 * 效果子串缺失 / 未登记的上传能力"七种形态逐条盯住。
 */
const SK15_SELFTEST_REGISTRY = {
  files: ['selftest.yml'],
  // 合成树的 job 名同样要登记 `runs-on`(同 `SELFTEST_RUNS_ON_REGISTRY`)。
  ...SELFTEST_RUNS_ON_REGISTRY,
  jobs: [
    { file: 'selftest.yml', job: 'verify', ifPolicy: 'exact', ifValue: 'true', why: '合成样本:允许的 if 形态只有 `true`' },
  ],
  steps: [
    {
      file: 'selftest.yml',
      job: 'verify',
      step: 'Gate',
      ifPolicy: 'exact',
      ifValue: 'true',
      require: ['scripts/ci-release-policy.sh'],
      why: '合成样本:发布链步骤必须无条件/按登记形态运行,且必须仍然调用唯一真源脚本',
    },
  ],
  remoteWrites: [],
}
/** `if:` 形态登记:每个 job / 步骤的 `if:` 必须逐字匹配登记值(或按策略必须缺失)。 */
const JOB_IF_POLICIES = {
  never: {
    check: value => value === null,
    describe: '不得带 `if:`(这个 job 必须无条件运行)',
  },
  exact: {
    check: (value, entry) => value !== null && value === entry.ifValue,
    describe: entry => `只允许逐字等于 \`${entry.ifValue}\``,
  },
}

/** `gh release create|edit` 的调用点(捕获子命令与同一行的其余 argv)。 */
const GH_API_INVOCATION = /(?:^|[\s;&|(]|\$\()gh\s+api\s+([^\n;&|]*)/gu
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

/**
 * **shell 语义**的续行合并:把 `\` + 换行这一对**整对删除**(不是替换成空格)。
 *
 * 与上面 `joinContinuations` 的差别是实质性的,不是风格问题:bash 在**分词之前**删掉
 * backslash-newline、**不插入空格** —— 所以
 *
 *   ```sh
 *   exi\
 *   t 0
 *   ```
 *
 * 在 shell 里是**一个词** `exit 0`(第七轮独立复审 V2 §1.2 实测:这一步的真实退出码是 0)。
 * 若按"替换成空格"归一,得到的是 `exi t 0`(两个词),两侧都看不见 `exit` ⇒ 静默绕过。
 * 需要"逻辑行 + argv 解析"的调用点继续用 `joinContinuations`(它们要的是可读的行),
 * 只有 [SK-14⑥] 的**退出语义**判据需要这一份"词级"语义。
 *
 * @param script - 去掉注释后的可执行文本。
 * @returns 续行已按 shell 语义合并的文本。
 */
function joinShellContinuations(script) {
  return script.replace(/\\\r?\n/gu, '')
}

/** step 的展示名(自检与失败信息共用)。 */
function stepName(step, index) {
  return typeof step?.name === 'string' && step.name.trim() !== '' ? step.name : `第 ${index + 1} 步`
}

/**
 * 归一化 `if:` 取值(判据与登记值共用一份口径)。
 *
 * `${{ … }}` 只看花括号里的表达式(`${{ false }}` 与 `false` 同判),连续空白折成一个
 * 空格,便于登记值逐字比对;缺失返回 `null`(与"空串"区分:空串是常量假)。
 * @param value - YAML 解析出来的 `if:` 取值。
 * @returns 归一化文本或 null。
 */
function normalizeIf(value) {
  if (value === undefined || value === null) return null
  const text = typeof value === 'string' ? value.trim() : String(value)
  const inner = /^\$\{\{([\s\S]*)\}\}$/u.exec(text)?.[1]
  return (inner ?? text).replace(/\s+/gu, ' ').trim()
}

/**
 * 从**可执行文本**里识别"能写远端对象存储/发布面"的能力(能力级,不是命令名白名单)。
 * @param script - 已剥注释的 run 文本。
 * @returns 命中的能力条目数组(可能多条)。
 */
function detectRemoteWrites(script) {
  return REMOTE_WRITE_CAPABILITIES.filter(capability => capability.re.test(script))
}

/**
 * workflow **文件级**登记的双向判据（2026-09-23 第六轮审计 R6-D P2-1）。
 *
 * 现场：SK-15 的"不可静默跳过"是**按文件**放行的 —— `checkJobExecutability` 与
 * `checkReleaseChainSteps` 都以 `registry.files.includes(file)` / `entries.length === 0`
 * 早退，而 `.github/workflows/*.yml` ⊆ `REGISTERED_WORKFLOW_FILES` 这层**没有任何判据**。
 * 于是新建一个 `zz-new-lane.yml`、里面放一个 `if: false` 的交付/公证 job ⇒ 门禁 EXIT=0
 * 并照打"全部通过"（同一形态放进已登记文件里则 EXIT=1）。审计口径里这属于"换一个文件即
 * 静默"，与"换一个 job / 一条步骤 / 一个对象"是同一类覆盖面缺口。
 *
 * 判据（两侧都红，只在扫描**默认目录**时生效）：
 *   · 目录里存在却没登记 ⇒ 红（新文件必须先登记进 `REGISTERED_WORKFLOW_FILES`）；
 *   · 登记了却不存在 ⇒ 红（文件被删/改名后登记项成了可复用的空壳）。
 *
 * 为什么要登记而不是"自动全部检查"：SK-15 的强制面需要**逐条写明依据**（每个 job 的
 * 允许 `if:` 形态、每个发布链步骤的效果子串），自动扫描给不出依据 —— 所以新文件必须是
 * 一次显式决定。`--workflows-dir` 指向临时目录时不做这条（那里是变异验证的合成树）。
 *
 * @param presentNames - 被扫目录里的 workflow 文件名（含 `.yml`/`.yaml`）。
 * @param registeredFiles - 登记表里的文件名。
 * @returns 失败项数组。
 */
export function checkRegisteredWorkflowFiles(presentNames, registeredFiles) {
  const failures = []
  for (const name of registeredFiles) {
    if (!presentNames.includes(name)) {
      failures.push({
        name: '[SK-15]',
        line: 0,
        detail: `登记表里的 workflow 文件 \`${name}\` 在 .github/workflows 下**不存在**\n`
          + '  ⇒ 文件被删掉/改名了：它的 job 与发布链步骤的登记项随即变成空壳，'
          + '而"登记了却不存在"这一侧此前没有任何判据。改结构请同步 REGISTERED_WORKFLOW_FILES。',
      })
    }
  }
  for (const name of presentNames) {
    if (!registeredFiles.includes(name)) {
      failures.push({
        name: '[SK-15]',
        line: 0,
        detail: `\`.github/workflows/${name}\` **没有登记**（登记值：${registeredFiles.join(', ')}）\n`
          + '  ⇒ 未登记文件的 job / 步骤**不进 SK-15 的强制面**：`if: false` 的交付或公证 job、'
          + '承载发布链命令的步骤都可以整块静默存在（R6-D P2-1 的现场形态：新文件 EXIT=0）。\n'
          + '  处置：把该文件登记进 REGISTERED_WORKFLOW_FILES 的 registry（jobs 与 steps 两侧都要写'
          + '清允许的 `if:` 形态与依据），或者删掉这个文件。',
      })
    }
  }
  return failures
}

/**
 * 文件级登记自检（R6-D P2-1）：判据必须**两个方向都能被咬住**，且正向形态要绿。
 * @returns `{ failures, assertions }`。
 */
export function selfTestWorkflowFileRegistry() {
  const failures = []
  let assertions = 0
  const registered = ['a.yml', 'b.yml']
  const expect = (id, present, shouldFail) => {
    assertions += 1
    const found = checkRegisteredWorkflowFiles(present, registered)
    if (shouldFail ? found.length === 0 : found.length > 0) {
      failures.push(`[file-registry-selftest] 样本 ${id}：期望${shouldFail ? '红' : '绿'}，`
        + `实得 ${found.length} 条失败（${found.map(item => item.detail.split('\n')[0]).join(' / ')}）`)
    }
  }
  expect('f1-全部登记且都存在', ['a.yml', 'b.yml'], false)
  expect('f2-存在却没登记(新文件)', ['a.yml', 'b.yml', 'zz-new-lane.yml'], true)
  expect('f3-登记了却不存在(删/改名)', ['a.yml'], true)
  expect('f4-两个方向同时漂移', ['a.yml', 'zz-new-lane.yml'], true)
  // 具名性：未登记的那份文件必须被**点名**（不能只说"有 1 项未通过"）。
  assertions += 1
  const named = checkRegisteredWorkflowFiles(['a.yml', 'b.yml', 'zz-new-lane.yml'], registered)
  if (!named.some(item => item.detail.includes('zz-new-lane.yml'))) {
    failures.push('[file-registry-selftest] 未登记文件必须被具名点名（诊断里找不到文件名）')
  }
  return { failures, assertions }
}

/**
 * [SK-14] 覆盖下限的自检(2026-09-24 第八轮审计 R8-C-1 ②:判据本身要能被打坏)。
 *
 * 两组断言:全命中 ⇒ 无失败;逐个 id 少一条 ⇒ **恰好一条**失败且**点名**那个 id。
 * 与 `selfTestWorkflowFileRegistry()` 同一手法(含"具名性"断言),由 main() 单独调用 +
 * 断言条数下限对账 —— 把本函数掏空成 `return []` 会被条数下限抓住。
 *
 * @returns `{failures, assertions}`。
 */
export function selfTestPinnedStepCoverage() {
  const failures = []
  let assertions = 0
  const all = PINNED_STEP_POLICIES.map(policy => policy.id)
  assertions += 1
  if (pinnedStepCoverageProblem(all).length !== 0) {
    failures.push('[pinned-coverage-selftest] 全命中时不该报失败（假阳性会让门禁逼着人删判据）')
  }
  for (const policy of PINNED_STEP_POLICIES) {
    assertions += 1
    const found = pinnedStepCoverageProblem(all.filter(id => id !== policy.id))
    if (found.length !== 1 || !found[0].detail.includes(policy.id)) {
      failures.push(`[pinned-coverage-selftest] 少一条策略(\`${policy.id}\`)时必须**恰好一条**失败并点名它，`
        + `实得 ${found.length} 条（${found.map(item => item.detail.split('\n')[0]).join(' / ') || '无'}）`)
    }
  }
  return { failures, assertions }
}

/**
 * job 级"不可静默跳过"判据(2026-09-23 第五轮审计 R5-D-1 / R4-A N6)。
 *
 * 两侧都红:登记的 job 必须存在、文件里的每个 job 都必须登记;`if:` 必须是登记形态
 * (`if: false` / `… && false` / 偷偷加 `event_name == 'workflow_dispatch'` 都会红);
 * job 级 `continue-on-error` 同样是"失败不再让检查红"。
 * @param file - workflow 文件名。
 * @param document - 解析后的 YAML。
 * @param notes - 证据行收集器。
 * @returns 失败项数组。
 */
function checkJobExecutability(file, document, notes, registry = REGISTRY_DEFAULT) {
  const failures = []
  if (!registry.files.includes(file)) return failures
  const jobs = typeof document?.jobs === 'object' && document.jobs !== null ? document.jobs : {}
  const entries = registry.jobs.filter(entry => entry.file === file)
  const registered = new Set(entries.map(entry => entry.job))
  for (const entry of entries) {
    if (!(entry.job in jobs)) {
      failures.push({
        name: file,
        line: 0,
        detail: `[SK-15] 登记表里的 job \`${entry.job}\` 在这份 workflow 里**不存在**`
          + `(${entry.why})\n  ⇒ job 被删掉/改名了:交付物或判据整块消失,而别的策略可能只认`
          + '自己点名的对象。改结构请同步 REGISTERED_JOBS。',
      })
      continue
    }
    const job = jobs[entry.job]
    const value = normalizeIf(job?.if)
    if (isConstantFalseIf(job?.if)) {
      failures.push({
        name: file,
        line: 0,
        detail: `[SK-15] job \`${entry.job}\` 的 \`if:\` 是**常量假**(${JSON.stringify(job.if)})`
          + ' ⇒ 这个 job 永远不会执行(里面的步骤、交付物、判据全部消失),'
          + '而"文本还在"的存在性判据仍会全绿(R5-D-1 的现场形态)。',
      })
    } else {
      const policy = JOB_IF_POLICIES[entry.ifPolicy]
      const describe = typeof policy.describe === 'function' ? policy.describe(entry) : policy.describe
      if (!policy.check(value, entry)) {
        failures.push({
          name: file,
          line: 0,
          detail: `[SK-15] job \`${entry.job}\` 的 \`if:\`(${value === null ? '缺失' : value})不在登记形态里`
            + `\n  该 job 只允许:${describe}`
            + `\n  登记依据:${entry.why}`
            + "\n  ⇒ 收窄条件(`… && false` / `… && github.event_name == 'workflow_dispatch'`)"
            + '与常量假等效:job 在、命令文本在、但永不执行。需要新形态请登记进 REGISTERED_JOBS 并写明理由。',
        })
      }
    }
    const jobContinueOnError = job?.['continue-on-error']
    if (jobContinueOnError !== undefined && !isContinueOnErrorDisabled(jobContinueOnError)) {
      failures.push({
        name: file,
        line: 0,
        detail: `[SK-15] job \`${entry.job}\` 打开了 continue-on-error(${JSON.stringify(jobContinueOnError)})`
          + ' ⇒ 这个 job 失败不再让 workflow 红(必需的检查会变绿)。',
      })
    }
  }
  const unregistered = Object.keys(jobs).filter(jobId => !registered.has(jobId))
  if (unregistered.length > 0) {
    failures.push({
      name: file,
      line: 0,
      detail: `[SK-15] 这份 workflow 里有 ${unregistered.length} 个 job **没有登记**:${unregistered.join(', ')}`
        + '\n  ⇒ "存在却没登记"与"登记了却不存在"是同一个洞的两面:没登记的 job 的 `if:`'
        + '没有任何判据读它(R5-D-1)。请把它登记进 REGISTERED_JOBS 并写明"允许的 if 形态 + 依据"。',
    })
  }
  if (entries.length > 0 && unregistered.length === 0) {
    notes.push(`[SK-15] job 可执行性:${file} 的 ${entries.length} 个 job 全部登记且 \`if:\` 形态符合登记值`)
  }
  return failures
}

/**
 * 发布链步骤的"不可静默跳过 + 效果"判据(2026-09-23 第五轮审计 R5-D-2 / R5-C-6/C-8)。
 *
 * 强制面对(必须登记):
 *   · job `release` 里的**每一个**步骤;
 *   · 任何命中"能写远端对象存储"能力的步骤;
 *   · 任何承载发布链命令(RELEASE_LINE_ANCHORS)或公证命令(dist:mac:notarize)的步骤。
 * 两侧都红 + `if:` 形态逐字登记 + 不得 continue-on-error + `require` 子串(效果判据)。
 * @param file - workflow 文件名。
 * @param document - 解析后的 YAML。
 * @param notes - 证据行收集器。
 * @returns 失败项数组。
 */
function checkReleaseChainSteps(file, document, notes, registry = REGISTRY_DEFAULT) {
  const failures = []
  const entries = registry.steps.filter(entry => entry.file === file)
  if (entries.length === 0) return failures
  const jobs = typeof document?.jobs === 'object' && document.jobs !== null ? document.jobs : {}
  /** 文件里**所有**带 run 的步骤(`${job}\u0000${步骤名}` → 详情):登记项在里面找。 */
  const allSteps = new Map()
  /** 需要登记的候选步骤(**强制面**):job release / 能写远端 / 承载发布链命令 / 调公证。 */
  const mandatory = new Map()
  for (const [jobId, job] of Object.entries(jobs)) {
    const steps = Array.isArray(job?.steps) ? job.steps : []
    steps.forEach((step, index) => {
      if (typeof step?.run !== 'string') return
      const script = executableScript(step.run)
      const reasons = []
      if (jobId === 'release') reasons.push('job release 的步骤')
      const writes = detectRemoteWrites(script)
      if (writes.length > 0) reasons.push(`能写远端对象存储(${writes.map(item => item.id).join(', ')})`)
      if (RELEASE_LINE_ANCHORS.some(anchor => script.includes(anchor))) reasons.push('承载发布链命令')
      if (script.includes('dist:mac:notarize')) reasons.push('调用公证命令')
      const key = `${jobId}\u0000${stepName(step, index)}`
      const item = { jobId, step, index, reasons, script }
      allSteps.set(key, item)
      if (reasons.length === 0) return
      mandatory.set(key, item)
    })
  }
  const matched = new Set()
  for (const entry of entries) {
    // 登记项在**全部**步骤里找(不只强制面):这样"把某个发布链步骤也登记上"是允许的,
    // 而"强制面里有步骤没登记"由下面的 unregistered 单独判。
    const hits = [...allSteps.entries()].filter(([, item]) => item.jobId === entry.job
      && stepName(item.step, item.index) === entry.step)
    if (hits.length === 0) {
      failures.push({
        name: file,
        line: 0,
        detail: `[SK-15] 发布链登记表里的步骤「${entry.step}」在 job \`${entry.job}\` 里**找不到**`
          + `(${entry.why})\n  ⇒ 步骤被删/改名了(发布链的一环消失)。改结构请同步 REGISTERED_RELEASE_STEPS。`,
      })
      continue
    }
    if (hits.length > 1) {
      failures.push({
        name: file,
        line: 0,
        detail: `[SK-15] 发布链登记表的锚点「${entry.step}」在 job \`${entry.job}\` 里匹配到 ${hits.length} 个步骤`
          + ' ⇒ 锚点不唯一,登记与检查的对应关系不可判定。',
      })
      continue
    }
    const [key, item] = hits[0]
    matched.add(key)
    const label = `job ${entry.job} 的步骤「${entry.step}」`
    const value = normalizeIf(item.step?.if)
    if (isConstantFalseIf(item.step?.if)) {
      failures.push({
        name: file,
        line: 0,
        detail: `[SK-15] ${label} 的 \`if:\` 是**常量假**(${JSON.stringify(item.step.if)})`
          + ' ⇒ 这一步永远不执行(run 一字未改,SK-11/公证三元组这类"文本在不在"的判据全绿)。',
      })
    } else {
      const policy = JOB_IF_POLICIES[entry.ifPolicy]
      const describe = typeof policy.describe === 'function' ? policy.describe(entry) : policy.describe
      if (!policy.check(value, entry)) {
        failures.push({
          name: file,
          line: 0,
          detail: `[SK-15] ${label} 的 \`if:\`(${value === null ? '缺失' : value})不在登记形态里`
            + `\n  该步骤只允许:${describe}`
            + `\n  登记依据:${entry.why}`,
        })
      }
    }
    const stepContinueOnError = item.step?.['continue-on-error']
    if (stepContinueOnError !== undefined && !isContinueOnErrorDisabled(stepContinueOnError)) {
      failures.push({
        name: file,
        line: 0,
        detail: `[SK-15] ${label} 打开了 continue-on-error(${JSON.stringify(stepContinueOnError)})`
          + ' ⇒ 这一步失败不再让 job 红(R2 上传/公证/GitHub Release 会静默失败)。',
      })
    }
    for (const needle of entry.require ?? []) {
      // **命令位**判据(第九轮审计 B 泳道 P1-4):`require` 里的脚本路径必须是**被执行的**
      // 那条命令。子串匹配下,把 R2 上传步改成 `run: echo "scripts/ci-publish-update-server.sh …"`
      // 就能让"零上传"通过登记(step 名 / if / continue-on-error / env 全部不动)。
      const satisfied = isCommandRequire(needle)
        ? commandRequireSatisfied(item.script, needle)
        : item.script.includes(needle)
      if (satisfied) continue
      failures.push({
        name: file,
        line: 0,
        detail: `[SK-15] ${label} 的可执行文本里缺少 \`${needle}\``
          + (isCommandRequire(needle)
            ? '\n  ⇒ 这一条按**命令位**判:登记脚本必须出现在被真的执行的命令上'
              + `(\`bash ${needle.split(/\s+/u)[0]}\` 这类形态),`
              + '`echo "…"` / `: …` / `test -f …` 只是**提到**它,不算执行。'
            : '')
          + `\n  登记依据:${entry.why}`
          + '\n  ⇒ "步骤还在"不等于"它还在做那件事"(R5-C-8:把 release_kind 判据换成永不匹配的'
          + '常量、或把命令换成空转,存在性判据都看不出来)。',
      })
    }
  }
  const unregistered = [...mandatory.entries()].filter(([key]) => !matched.has(key))
  if (unregistered.length > 0) {
    failures.push({
      name: file,
      line: 0,
      detail: `[SK-15] 有 ${unregistered.length} 个发布链步骤**没有登记**:\n`
        + unregistered.map(([, item]) => `  - job ${item.jobId} 「${stepName(item.step, item.index)}」`
          + `(${item.reasons.join('、')})`).join('\n')
        + '\n  ⇒ 没登记的步骤,它的 `if:` / continue-on-error 没有任何判据读它(R5-D-2 的现场形态:'
        + '给 R2 上传步加一行 `if: false`,两条根守卫都 EXIT=0)。请登记进 REGISTERED_RELEASE_STEPS。',
    })
  }
  if (entries.length > 0 && unregistered.length === 0) {
    notes.push(`[SK-15] 发布链步骤:${file} 的 ${entries.length} 个登记步骤全部命中,强制面(${mandatory.size} 个)无遗漏`)
  }
  return failures
}

/**
 * "能写远端对象存储"的能力级对账(2026-09-23 第五轮审计 R5-C-6)。
 *
 * · 命中 `run-scoped` 能力的步骤必须在 `REMOTE_WRITE_REGISTERED` 里逐条登记(写明理由);
 * · 命中 `release-surface` 能力的步骤由 SK-11 的说明门负责(这里只计数);
 * · 命中 `unregistered` 能力(内联 `aws s3 cp` / `rclone` / `curl -T` …)⇒ **判红并要求登记**
 *   —— 这正是"在说明检查之前插一条内联上传"能绕过旧判据的那个洞。
 * @param file - workflow 文件名。
 * @param document - 解析后的 YAML。
 * @param notes - 证据行收集器。
 * @returns 失败项数组。
 */
function checkRemoteWriteCapabilities(file, document, notes, registry = REGISTRY_DEFAULT) {
  const failures = []
  const jobs = typeof document?.jobs === 'object' && document.jobs !== null ? document.jobs : {}
  const registeredHits = new Set()
  let releaseSurfaceHits = 0
  for (const [jobId, job] of Object.entries(jobs)) {
    const steps = Array.isArray(job?.steps) ? job.steps : []
    steps.forEach((step, index) => {
      if (typeof step?.run !== 'string') return
      const script = executableScript(step.run)
      for (const capability of detectRemoteWrites(script)) {
        const label = `job ${jobId} 的步骤「${stepName(step, index)}」`
        if (capability.surface === 'release-surface') {
          releaseSurfaceHits += 1
          continue
        }
        const entry = registry.remoteWrites.find(candidate => candidate.file === file
          && candidate.job === jobId
          && candidate.step === stepName(step, index)
          && candidate.capability === capability.id)
        if (capability.surface === 'run-scoped' && entry !== undefined) {
          registeredHits.add(entry)
          continue
        }
        failures.push({
          name: file,
          line: 0,
          detail: `[SK-15] ${label} 命中了**能写远端对象存储**的能力 \`${capability.id}\`(${capability.label})`
            + ',但它没有被登记:'
            + '\n  · 若它写的是客户侧/公开发布面 ⇒ 必须排在"策展说明检查"之后(SK-11 的半发布窗口);'
            + '\n  · 若是 run 级临时中转 ⇒ 登记进 REMOTE_WRITE_REGISTERED 并写明为什么不上说明门;'
            + '\n  · 若是别的形态 ⇒ 说明它到底写到哪里,再把能力条目与登记一起改。'
            + '\n  ⇒ 旧实现只认 4 条**登记命令**(R5-C-6):内联 `aws s3 cp …` 这类等价的'
            + '上传形态可以整条绕过说明门。',
        })
      }
    })
  }
  const dead = registry.remoteWrites.filter(entry => entry.file === file && !registeredHits.has(entry))
  if (dead.length > 0) {
    failures.push({
      name: file,
      line: 0,
      detail: `[SK-15] REMOTE_WRITE_REGISTERED 有 ${dead.length} 条**死条目**(本次不再命中任何步骤):\n`
        + dead.map(entry => `  - ${entry.job} 「${entry.step}」← ${entry.capability}`).join('\n')
        + '\n  ⇒ 该步骤已被改写/删除,登记必须同步收窄(留下它就是一条可复用的豁免洞)。',
    })
  }
  if (registeredHits.size > 0 || releaseSurfaceHits > 0) {
    notes.push(`[SK-15] 远端写入面:${releaseSurfaceHits} 个发布面上传步骤(走说明门)+ `
      + `${registeredHits.size} 个已登记的 run 级中转步骤`)
  }
  return failures
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
  // **workflow 顶层** `defaults.run.shell` 也作用于每一个 step（第十二轮红队 C-P0-1）：
  // 它此前不在解析链里 ⇒ `item.shell` 会静默回落到 `bash`，而 runner 上跑的是别的解释器。
  const workflowShell = document?.defaults?.run?.shell
  for (const [jobId, job] of Object.entries(jobs)) {
    const defaultShell = job?.defaults?.run?.shell ?? workflowShell
    const steps = Array.isArray(job?.steps) ? job.steps : []
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index]
      if (typeof step?.run !== 'string') continue
      const stepShell = typeof step?.shell === 'string' && step.shell.trim() !== '' ? step.shell : defaultShell
      const shell = typeof stepShell === 'string' && stepShell.trim() !== '' ? stepShell : 'bash'
      const label = typeof step.name === 'string' && step.name.trim() !== ''
        ? step.name.trim()
        : `run#${index + 1}`
      // `index` = 该 step 在 job.steps 里的下标。[SK-17] 需要它来判"某一步是否在某个被钉
      // 步骤**之前**"(同 job 内 `$GITHUB_ENV`/`$GITHUB_PATH` 的写入会被后续步骤继承)。
      yield { jobId, job, step, shell, label, index, block: bySignature.get(normalizeScript(step.run)) }
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
function selftestWorkflow(steps, { timeoutMinutes = 45, jobContinueOnError = false, jobIf = '', jobNeeds = '', triggers = ['push'] } = {}) {
  return [
    'name: selftest',
    'on:',
    ...triggers.map(trigger => `  ${trigger}:`),
    'jobs:',
    '  verify:',
    `    runs-on: ${GATE_SELFTEST_RUNS_ON}`,
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
      const script = stripShellRedirections(executableScript(step.run))
      for (const hit of rootGateInvocations(script)) {
        const args = hit.args.trim() === '' ? [] : hit.args.trim().split(/\s+/u)
        invocations.push({
          jobId,
          stepIndex: index,
          stepName: typeof step.name === 'string' && step.name.trim() !== '' ? step.name : `第 ${index + 1} 步`,
          step,
          flag: hit.mode,
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
  //
  // **读的是去注释后的可执行文本**(2026-09-24 第八轮审计 R8-C-1):旧实现读原始
  // `run` 文本,于是把
  //   `- run: node scripts/check-root-guards.mjs`  →  `run: |` + `# node scripts/…`
  // (只加一个 `#`)**照样**满足"恰好一个守卫 job",而 [SK-14] 的 `root-guard-runner`
  // 读的是可执行文本 ⇒ 那条策略不再适用,覆盖从 5 个被钉步骤静默降到 4 个,
  // `check-workflows` EXIT=0 而 `gate-guards` 一个根守卫都不跑(必需 Gate 仍绿)。
  // 现在两侧同口径:命令被注释掉 ⇒ 这里就是"0 个守卫 job"⇒ 红。
  const guardJobs = Object.entries(jobs)
    .filter(([, job]) => (Array.isArray(job?.steps) ? job.steps : [])
      .some(step => typeof step?.run === 'string'
        && commandPositionArgvs(executableScript(step.run), DOCS_ONLY_GUARD_RUNNER).length > 0))
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
      // 与 [SK-14] 同一份口径:**可执行文本**(2026-09-24 第八轮审计 R8-C-2)。
      // 旧实现在这里读原始 `run`、在 [SK-14] 的 `root-guard-link` 里读可执行文本 ⇒
      // 把收尾 `exit 1` 改成注释(`# exit 1`,保留 `true`)时:**这一条照样满足**,
      // 而 `root-guard-link` 不再命中 ⇒ 步骤体判据(⑥)整条不执行 ⇒ 门禁 EXIT=0,
      // 而这一步在"根守卫失败"时的真实退出码是 0(唯一链路被静默摘除)。
      const links = gateStepsForLink.filter(step => typeof step?.run === 'string'
        && /exit\s+[1-9]/u.test(executableScript(step.run))
        // 引用可以写在 run 里(`echo "…needs.x.result…"`)或写在 `if:` 上(更常见)。
        && (resultRef.test(executableScript(step.run))
          || (typeof step?.if === 'string' && resultRef.test(step.if))))
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
 * **策展发布说明路径**的判据（第十一轮审计 C2-A-01，本轮修复）。
 *
 * 现场：`--notes "$(git log -1 --format=%B)"`（或任何命令替换/变量/管道）让公开 Release 正文
 * 来自**未评审文本**，而 `SK-11` 的两道策展说明检查 + `gh` 参数判据**全绿** —— 旧判据问的是
 * "有没有说明来源这个旗标"，不是"正文是不是那份策展文件"。历史上真实域名/IP 正是从
 * "正文来自提交信息/PR 正文"这条路进公开 Release 的（`--generate-notes` 只是其中一种形态）。
 *
 * 判据（fail-closed，与同批 `--body` 判据同一形态）：取值必须**可证明**是
 * `docs/releases/<tag>.md` —— 前缀逐字、`.md` 结尾、单段文件名、且不含命令替换/反引号/管道。
 * 证明不了就红（`$PWD/…`、循环变量这类"运行时才成形"的形态同样红：判据问的是可证明性）。
 * @param value - 已去引号、已解析变量之后的取值文本。
 * @returns `null` = 可证明是策展文件；否则是人读的原因。
 */
function curatedNotesPathProblem(value) {
  const text = String(value ?? '').trim()
  if (text === '') return '取值是空的（`--notes-file` 后面什么都没有）'
  if (text.includes('$(') || text.includes('`')) {
    return `取值 ${JSON.stringify(text)} 里有命令替换/反引号 ⇒ 正文内容来自那条命令的输出，而不是策展文件`
  }
  if (text.includes('|')) return `取值 ${JSON.stringify(text)} 里有管道 ⇒ 正文来源读不出来`
  if (!/^docs\/releases\/[^/\s]+\.md$/u.test(text)) {
    return `取值 ${JSON.stringify(text)} 不是 \`docs/releases/<tag>.md\` 形态的路径`
      + '（公开 Release 正文必须来自那一份**可评审**的策展文件）'
  }
  return null
}

/**
 * 把一个 shell 取值 token 解析成"可静态证明的文本"（变量按脚本内的赋值链展开，深度 ≤ 4）。
 * @param raw - 原始 token（可能带引号、可能是 `$VAR` / `${VAR}`）。
 * @param variables - {@link shellStaticVariables} 的结果。
 * @param depth - 递归深度（防自引用）。
 * @returns `{ text, resolvable }`；`resolvable === false` = 判据读不懂这个取值。
 */
function resolveShellToken(raw, variables) {
  const trimmed = String(raw ?? '').trim()
  const unquoted = /^"(.*)"$/su.test(trimmed)
    ? trimmed.slice(1, -1)
    : (/^'(.*)'$/su.test(trimmed) ? trimmed.slice(1, -1) : trimmed)
  // 命令替换/反引号:不展开(展开会掩盖"正文来自某条命令"这件事),原样交给上层按形态判。
  if (unquoted.includes('$(') || unquoted.includes('`')) return { text: unquoted, resolvable: true }
  // 变量替换(与 `--body` 判据同一取向:只在**能证明**时才放行)。
  // 两个 tag 变量刻意**保留字面形态**:它们的取值由 runner 提供,判据看的是
  // `docs/releases/<tag>.md` 这个**路径形态**,不是 tag 的具体值。
  let text = unquoted
  for (let round = 0; round < 4; round += 1) {
    let changed = false
    text = text.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/gu, (whole, name) => {
      if (name === 'TAG' || name === 'GITHUB_REF_NAME') return whole
      const assigned = variables.get(name)
      if (assigned === undefined) return whole
      changed = true
      return assigned
    })
    if (!changed) break
  }
  const leftover = [...text.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/gu)]
    .map(match => match[1])
    .filter(name => name !== 'TAG' && name !== 'GITHUB_REF_NAME')
  return { text, resolvable: leftover.length === 0 }
}

/**
 * shell 脚本里**可静态解析的变量赋值**（第一处赋值优先）。
 *
 * 与 `--body` 的静态判据同一手法：只认"名字=取值"的普通赋值，取第一处（后面的覆盖不追）——
 * 取向是 fail-closed：解析不出来就算"证明不了"。
 * @param script - 可执行文本（注释已剥）。
 * @returns `Map<string, string>`（名字 → 原始取值 token）。
 */
function shellStaticVariables(script) {
  const variables = new Map()
  const pattern = /(?:^|[\s;])?([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"\n]*)"|'([^'\n]*)'|([^\s;&|\n]+))/gu
  for (const match of script.matchAll(pattern)) {
    const name = match[1]
    if (variables.has(name)) continue
    variables.set(name, match[2] ?? match[3] ?? match[4] ?? '')
  }
  return variables
}

/**
 * 一个 `gh release create|edit` 的 argv 尾巴里，**说明来源**是否可证明是策展文件。
 *
 * 三条形态（`gh release create --help` 的短旗标语义逐个相同，见 C2-A-03 的假红）：
 *   · `--notes-file|-F <取值>`：取值（字面量或脚本内可解析的变量）必须是策展路径；
 *   · `--notes|-n <取值>`：只放行"取值可证明来自 `cat docs/releases/<tag>.md`"的形态
 *     （`$(cat <策展路径>)` / `$(< <策展路径>)`），其余（`$(git log …)` / `$VAR` / 字面正文）一律红；
 *   · 变量形态：`NOTES_FLAG="--notes-file …"` 之类，按同一规则解析它的赋值。
 * **枚举全部**说明来源旗标并逐个判（不是只取第一个）—— 同一逻辑行上第二个坏取值同样要拦。
 * @param script - 可执行文本（用于解析变量赋值）。
 * @param tail - `gh release …` 之后的 argv 文本。
 * @returns `{ sources, problems }`（`sources` = 可证明的说明来源个数）。
 */
function releaseNotesSourceReport(script, tail) {
  const variables = shellStaticVariables(script)
  const problems = []
  let sources = 0
  // 取值 token 的读法:平衡括号的 `$( … )`(引号里可以再带引号)/ 普通引号串 / 裸 token。
  // 顺序重要:`"$(cat "${NOTES}")"` 必须整体读成一个取值,否则内层引号会把取值截成 `$(cat `。
  const notesFlag = /(?:^|[\s"'])(--notes-file|-F|--notes|-n)(?:=|\s+)(?:"(\$\((?:[^()]|\([^()]*\))*\))"|"([^"\n]*)"|'([^'\n]*)'|(\$\((?:[^()]|\([^()]*\))*\)|\S+))/gu
  const judge = (flag, raw) => {
    const resolved = resolveShellToken(raw, variables)
    const isFile = flag === '--notes-file' || flag === '-F'
    if (!resolved.resolvable) {
      problems.push(`\`${flag} ${raw}\` 的取值无法静态证明（变量在同一个 step 里没有可解析的赋值，`
        + '或由命令替换/管道成形）⇒ 正文可能来自未评审文本')
      return
    }
    if (isFile) {
      const problem = curatedNotesPathProblem(resolved.text)
      if (problem === null) { sources += 1; return }
      problems.push(`\`${flag} ${raw}\` ⇒ ${problem}`)
      return
    }
    // `--notes` / `-n`：只认"读那份策展文件"的命令替换。
    const catForm = /^\$\(\s*cat\s+(.+?)\s*\)$/su.exec(resolved.text) ?? /^\$\(<\s*(.+?)\)$/su.exec(resolved.text)
    const inner = catForm === null ? null : resolveShellToken(catForm[1].replace(/^["']|["']$/gu, ''), variables)
    if (inner === null || !inner.resolvable) {
      problems.push(`\`${flag} ${raw}\` 的取值不是"读策展文件"的形态（只放行 `
        + '`$(cat docs/releases/<tag>.md)` / `$(< docs/releases/<tag>.md)`，'
        + '其余（如 `$(git log …)`、`$变量`、字面正文）一律按未评审文本处理）')
      return
    }
    const problem = curatedNotesPathProblem(inner.text)
    if (problem === null) { sources += 1; return }
    problems.push(`\`${flag} ${raw}\` ⇒ ${problem}`)
  }
  for (const match of tail.matchAll(notesFlag)) {
    judge(match[1], match[2] ?? match[3] ?? match[4] ?? match[5] ?? '')
  }
  // 变量形态：tail 里引用的每个变量，如果它的赋值里含说明来源旗标，就把那段赋值也判一遍。
  const seenVars = new Set()
  for (const match of tail.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/gu)) {
    const name = match[1]
    if (seenVars.has(name)) continue
    seenVars.add(name)
    const assigned = variables.get(name)
    if (assigned === undefined || !/--(?:notes-file|notes|generate-notes)\b|(?:^|\s)-[Fn](?:\s|=)/u.test(assigned)) continue
    for (const inner of assigned.matchAll(notesFlag)) judge(inner[1], inner[2] ?? inner[3] ?? inner[4] ?? inner[5] ?? '')
  }
  return { sources, problems }
}

/**
 * `gh api` 写 Release 正文的判据（第十一轮审计 C2-A-02，本轮修复）。
 *
 * 现场：`gh api -X POST repos/${REPO}/releases -f tag_name=… -f body="$(git log -1 --format=%B)"`
 * 与 `gh release create|edit` **同权**（gh 官方推荐的等价写面），但它不匹配
 * `GH_RELEASE_INVOCATION` ⇒ 判据面外。判据取向与 `--body` 同：**能力面**而不是命令名。
 * @param script - 可执行文本。
 * @param tail - `gh api …` 之后的 argv 文本。
 * @returns 问题描述数组（空 = 这一步没有经 `gh api` 写 Release 正文，或者取值可证明）。
 */
function ghApiReleaseBodyFlagPresent(tail) {
  return /(?:^|\s)(?:-f|--raw-field|-F|--field)\s+body(?:=|@)/u.test(tail)
    || /(?:^|\s)--input(?:=|\s)/u.test(tail)
}

function ghApiReleaseBodyProblems(script, tail) {
  if (!/releases/u.test(tail)) return []
  const variables = shellStaticVariables(script)
  const problems = []
  const bodyField = /(?:^|\s)(?:-f|--raw-field|-F|--field)\s+body(?:=|@)(?:"([^"\n]*)"|'([^'\n]*)'|(\S+))/gu
  let hits = 0
  for (const match of tail.matchAll(bodyField)) {
    hits += 1
    const raw = match[1] ?? match[2] ?? match[3] ?? ''
    const resolved = resolveShellToken(`"${raw}"`, variables)
    const problem = resolved.resolvable ? curatedNotesPathProblem(resolved.text) : '取值无法静态证明'
    if (problem === null) continue
    problems.push(`\`body=${raw}\` ⇒ ${problem}`)
  }
  const inputForm = /(?:^|\s)--input\s+(?:"([^"\n]*)"|'([^'\n]*)'|(\S+))/u.exec(tail)
  if (inputForm !== null) {
    hits += 1
    const resolved = resolveShellToken(inputForm[1] ?? inputForm[2] ?? inputForm[3] ?? '', variables)
    const problem = resolved.resolvable ? curatedNotesPathProblem(resolved.text) : '取值无法静态证明'
    if (problem !== null) problems.push(`\`--input\` ⇒ ${problem}`)
  }
  if (hits === 0) return []
  return problems.length === 0
    ? []
    : [`这一步用 \`gh api\` 写 \`releases\` 的正文（与 \`gh release create|edit\` **同权**的写面）：`
      + `\n    ${problems.join('\n    ')}`
      + '\n  ⇒ 正文来源必须与 `gh release` 那条路径同一条判据：策展文件 `docs/releases/<tag>.md`。']
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
 *   ③ **结论必须绑权威 HEAD**(W-8 接线的后半,2026-09-23):跑这个门禁的**两处**入口
 *      (整仓门禁那一步 + 协议探针那一步)都必须在 step 的 `env` 里带
 *      `WASM_GATE_EXPECT_HEAD: ${{ github.sha }}`。脚本侧的这份能力早就存在
 *      (不匹配即**跑前**退出码 2 并打印"结论不可比"),但 `.github/` 里没有任何地方设置它
 *      ⇒ 又是一次"有能力、没接线":换 commit、脏树、跑动中被推进 HEAD,都能拿到同一句
 *      "全部通过 ✅(绑定 HEAD …)"。取值必须是 `github.sha` —— 写死一个字面量 sha 会在
 *      下一次提交后**恒红**(而恒红的判据迟早被摘掉),写成 `github.ref` 之类则形状非法。
 *      反例(必须红):env 缺失 / 写成字面量 sha / 写成别的 github 变量。
 *   ④ **刻意不接 `--require-clean` / `WASM_GATE_REQUIRE_CLEAN`**(2026-09-23 拍板,理由见
 *      ci.yml 该 step 的注释与脚本头部):共享工作树恒脏、门禁自身会产出被忽略的构建产物,
 *      "必须干净"容易变成假红 ⇒ 这一条**不做**静态判据(它也不构成静默缺口:真接上了且
 *      红了,CI 会当场报错,不会悄悄失去判据)。
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
  /**
   * 这一步是不是「参数向量为空的全量根门禁」(与 [SK-8]/[SK-9] 同一份识别口径:
   * `ROOT_GATE_INVOCATION` + 参数向量为空)。`scriptOf` 已去掉注释 ⇒ 把 `yarn check`
   * 注释掉的写法不会被当成跑过门禁。
   */
  const isFullRootGate = script => rootGateInvocations(script)
    .some(hit => hit.mode === 'check' && hit.args.trim() === '')
  /**
   * ③ 结论绑定权威 HEAD(W-8 接线):step 的 `env` 必须带
   * `WASM_GATE_EXPECT_HEAD: ${{ github.sha }}`。只接受这一个取值 —— 字面量 sha 会在下一次
   * 提交后恒红,其它 github 变量(如 `github.ref`)形状非法 ⇒ 两者都会把判据变成噪音。
   * @param workflow - 文件名(进失败项)。
   * @param label - 人读的定位串。
   * @param step - YAML 解析出来的 step 对象。
   * @returns 失败项数组(可能为空)。
   */
  const expectHeadBinding = (workflow, label, step) => {
    const env = typeof step?.env === 'object' && step.env !== null ? step.env : {}
    const raw = env[WASM_GATE_EXPECT_HEAD_ENV]
    const value = typeof raw === 'string' ? raw.trim() : (raw === undefined || raw === null ? '' : String(raw).trim())
    if (value === WASM_GATE_EXPECT_HEAD_VALUE) return []
    const shape = value === ''
      ? '缺失'
      : (/^\$\{\{/u.test(value) ? '写成了别的表达式' : '写成了字面量')
    return [{
      name: workflow,
      line: 0,
      detail: `[SK-12] ${label} 没有把结论钉在权威 HEAD 上:`
        + `\`${WASM_GATE_EXPECT_HEAD_ENV}: ${WASM_GATE_EXPECT_HEAD_VALUE}\`(实际 ${shape}:${JSON.stringify(value)})`
        + '\n  ⇒ 脚本侧早已支持跑前锁定期望 HEAD(不匹配即**跑前**退出码 2 + "结论不可比"),'
        + '但 CI 不设置它 ⇒ 换 commit / 脏树 / 跑动中被推进 HEAD 都能拿到同一句"全部通过 ✅(绑定 HEAD …)"。'
        + '\n  取值必须是 `${{ github.sha }}`:字面量 sha 在下一次提交后恒红,`github.ref` 之类形状非法。',
    }]
  }

  // 判据只对**本仓的 CI 工作流**(`ci.yml`)生效。为什么锚文件名而不是"内容里有没有
  // `yarn check`/`go test`":那类锚点会随被检查的东西一起消失 —— 把接线整段删掉时,
  // 锚点也没了,判据静默变绿(正是这条策略要防的形态)。改名/搬走 ci.yml 不会静默:
  // `scripts/verify-ci-scripts.mjs` 的 §1c/§1d 直接按这个路径抽取并断言(找不到即红)。
  if (file !== 'ci.yml') return failures

  const caseGateHits = []
  const probeHits = []
  const fullGateHits = []
  for (const [jobId, job] of Object.entries(jobs)) {
    for (const [index, step] of stepsOf(job).entries()) {
      const script = scriptOf(step)
      if (script.includes(WASM_CASE_GATE_SCRIPT)) caseGateHits.push({ jobId, job, step, index, script })
      const groups = /--groups\s+([0-9,]+)/u.exec(script)
      if (script.includes('verify-wasm-client-only.sh') && groups !== null) {
        probeHits.push({ jobId, job, step, index, script, groups: groups[1].split(',').filter(Boolean) })
      }
      // 「整仓门禁那一步」= 参数向量为空的全量 `yarn check`(与 [SK-8] 同一份识别口径)。
      // 它跑 `check:wasm-client-only`(check-workspaces.mjs 的 GUARDS 表),所以也吃 step env。
      if (isFullRootGate(script)) fullGateHits.push({ jobId, job, step, index, script })
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
    failures.push(...expectHeadBinding(file, label, hit.step))
  }

  // ③ 整仓门禁那一步:它经 `check:wasm-client-only` 跑同一份门禁,所以结论同样必须绑 HEAD。
  // 0 个全量门禁 ⇒ [SK-8]/[SK-9] 已经会红,这里不重复报(避免同一缺陷两处噪音)。
  for (const hit of fullGateHits) {
    failures.push(...expectHeadBinding(file, `job ${hit.jobId} 的 step「${stepName(hit.step, hit.index)}」`, hit.step))
  }

  if (caseGateHits.length > 0 || probeHits.length > 0 || fullGateHits.length > 0) {
    notes.push(`[SK-12] WASM 接线:用例级报告 ${caseGateHits.length} 步(范围 ${WASM_CASE_GATE_SCOPE.join(',')})、`
      + `协议探针 ${probeHits.length} 步(组 ${WASM_PROBE_GROUPS.join(',')})、`
      + `结论绑 HEAD ${fullGateHits.length + probeHits.length} 步(${WASM_GATE_EXPECT_HEAD_ENV})`)
  }
  return failures
}

/**
 * [SK-13] 的实现:触发面(`on:`)的业务契约(判据与登记值见常量区注释)。
 *
 * 判据跑在 **parseYaml 的结果**上(不是子串匹配 —— 注释里的 `push:` 不算,`on:` 写成
 * 字符串/数组/映射三种形态都能读),并逐条给出"这条改动会让什么静默消失"。
 *
 * @param file - workflow 文件名。
 * @param document - parseYaml 的结果。
 * @param text - 原始文本(用于内容锚点)。
 * @param notes - 提示收集器。
 * @returns 失败项列表。
 */
function checkTriggerSurface(file, document, text, notes) {
  const failures = []
  // 契约只挂在"承载发布链的那个 workflow"上:文件名锚点 + 内容锚点(见常量区注释)。
  if (file !== RELEASE_LINE_WORKFLOW && !carriesReleaseLine(text)) return failures
  const where = file === RELEASE_LINE_WORKFLOW
    ? `workflow \`${file}\`(承载发布链的那一个)`
    : `workflow \`${file}\`(可执行文本里出现发布链命令,因而承载发布链)`
  const consequence = '\n  ⇒ 后果不是"少跑一条检查",而是**整条发布链静默消失**:tag push 不再'
    + '触发 workflow ⇒ `release` job、`gh release create`、R2 `publish-update-server`、'
    + 'mac 签名+公证 job 全部不会启动,连流水线内部那批检查(`ci-release-policy.sh` 的 tag 形态'
    + '判定、`docs/releases/<tag>.md` 策展说明检查、tag 上的根守卫)也一起消失;'
    + '而 `pull_request:` 还在 ⇒ **引入这个改动的 PR 自己仍然全绿可合**(2026-09-23 第四轮审计 R4-A-3)。'

  /** 触发键 → 取值(map/字符串/数组三种写法归一)。 */
  const triggers = new Map()
  const on = document?.on
  if (typeof on === 'string' && on.trim() !== '') triggers.set(on.trim(), null)
  else if (Array.isArray(on)) {
    for (const entry of on) if (typeof entry === 'string' && entry.trim() !== '') triggers.set(entry.trim(), null)
  } else if (typeof on === 'object' && on !== null) {
    for (const [name, value] of Object.entries(on)) triggers.set(name, value)
  }
  if (triggers.size === 0) {
    failures.push({
      name: file,
      line: 0,
      detail: `[SK-13] ${where} 没有可解析的 \`on:\` 触发面(缺失/空/形态不认识)`
        + '\n  ⇒ 没有触发面的 workflow 只能手工 `workflow_dispatch` 启动:PR 不检查、'
        + 'push 不构建、tag 不发布。' + consequence,
    })
    return failures
  }

  const names = [...triggers.keys()]
  // ① 必须存在的触发键。
  const missing = REQUIRED_TRIGGERS.filter(name => !triggers.has(name))
  if (missing.length > 0) {
    failures.push({
      name: file,
      line: 0,
      detail: `[SK-13] ${where} 的触发面缺少 ${missing.map(name => `\`${name}\``).join(' / ')}`
        + `(实际只有 ${names.map(name => `\`${name}\``).join(', ')})。`
        + `\n  登记形态:${REQUIRED_TRIGGERS.map(name => `\`${name}\``).join(' + ')}`
        + `(可有可无但出现即登记:${REGISTERED_TRIGGERS.filter(name => !REQUIRED_TRIGGERS.includes(name)).map(name => `\`${name}\``).join(', ')})。`
        + consequence,
    })
  }
  // ② 未登记的触发键(新增 schedule / workflow_run 之类必须改登记值 + 写明理由)。
  const unregistered = names.filter(name => !REGISTERED_TRIGGERS.includes(name))
  if (unregistered.length > 0) {
    failures.push({
      name: file,
      line: 0,
      detail: `[SK-13] ${where} 出现了未登记的触发键 ${unregistered.map(name => `\`${name}\``).join(', ')}`
        + `\n  登记集合:${REGISTERED_TRIGGERS.map(name => `\`${name}\``).join(', ')}`
        + '\n  ⇒ 触发面是本文件里 REGISTERED_TRIGGERS 的登记值;新增触发形态请同步登记并写明'
        + '它与发布链/门禁的关系(否则"多了一条谁也不认识的触发"和"少了一条"一样无从审计)。',
    })
  }
  // ③ push / pull_request 不得被过滤键收窄(登记形态 = 一个过滤键都不出现)。
  for (const name of REQUIRED_TRIGGERS) {
    if (!triggers.has(name)) continue
    const value = triggers.get(name)
    if (value === null || value === undefined) continue
    if (typeof value !== 'object' || Array.isArray(value)) {
      failures.push({
        name: file,
        line: 0,
        detail: `[SK-13] ${where} 的 \`${name}:\` 取值形态不认识(${JSON.stringify(value)})`
          + '\n  ⇒ 登记形态是这个键**不带任何取值**(不写过滤);写法请与其余触发键一致。',
      })
      continue
    }
    const keys = Object.keys(value)
    if (keys.length === 0) continue
    const narrowing = keys.filter(key => TRIGGER_NARROWING_KEYS.includes(key))
    failures.push({
      name: file,
      line: 0,
      detail: `[SK-13] ${where} 的 \`${name}:\` 带了过滤键(${keys.join(', ')}),触发面被收窄`
        + `\n  登记形态:\`${name}:\` 不带任何过滤键 —— \`push\` 必须是"全分支含 tag"`
        + '(`branches` 与 `tags` 同时给出时是 AND 关系:写 `branches: [master]` 就等于 `v*` tag'
        + '不再触发发布),`pull_request` 不得用 `branches` 白名单收窄。'
        + (narrowing.length > 0 ? `\n  本次命中的收窄键:${narrowing.join(', ')}` : '')
        + consequence,
    })
  }

  notes.push(`[SK-13] 触发面 = ${names.map(name => `\`${name}\``).join(' + ')}(登记形态:`
    + `${REQUIRED_TRIGGERS.join(' + ')};不得带过滤键)`)
  return failures
}

/**
 * [SK-16] 「让已登记 `advisory` 真正静默」的那个开关 —— **CI 的任何调用都不得带它**。
 *
 * 现场(2026-09-23 第七轮独立复审 R7-C P2-1,三守卫全绿):`--allow-advisory` 是
 * `scripts/check-root-guards.mjs` 上唯一能把"advisory 守卫失败"从**拦门禁**降级成
 * **只打一行告警**的入口,而它与 `advisory` 登记制(`check-workspaces.mjs` 的
 * `ADVISORY_REGISTRY`)一起构成了一条**完整的红→绿通道**。`check-root-guards.mjs`
 * 自己的用法注释写着"CI 的任何调用都不得带它(`scripts/check-workflows.mjs` 会钉住
 * 这一点的反面:守卫运行步必须真的在跑)" —— 而当时本文件只钉了**"这一步在跑"**
 * (存在性/`if:` 形态/步骤体可失败),**没有任何一条判据读这个开关**:把它加到
 * `.github/workflows/ci.yml` 的守卫运行步上,`node scripts/check-workflows.mjs`
 * 实测 **EXIT=0**(2026-09-23 复现)。于是"根守卫失败 ⇒ 必需检查红"这条链路上,
 * 多了一个"谁都能按一下"的静音键。
 *
 * 判据(四条,任一条命中即红):
 *   ① **全局**:任何 workflow、任何**可执行**文本里出现 `--allow-advisory` ⇒ 红
 *      (不限于守卫步:任何一步带上它都是把门禁静默化,没有第二种用途)。字面量被引号/
 *      转义**切开**的写法(`--allow-""advisory`、`--allow-advis\ory`)按**词级归一**一并判
 *      (第七轮独立复审 V2 §2.3:`echo …--allow-""advisory…` 实测 EXIT=0);
 *   ①b **workflow 顶层 `env:`**(第七轮独立复审 V2 §2.2):`env:` 写在 document 顶层时会被
 *      **每个 job 的每个 step** 继承 —— 在那里放一行 `ROOT_GUARD_FLAGS: --allow-advisory`,
 *      守卫步只写 `node scripts/check-root-guards.mjs $ROOT_GUARD_FLAGS`,判据① 看不见字面量、
 *      判据② 原先只读 step/job 的 env ⇒ 实测 `check-workflows` **EXIT=0**,而复审用 argv 替身
 *      证明旗标**真的送到了守卫**、干净探针证明它真能把「已登记 advisory 的守卫失败」从
 *      EXIT=1 翻成 EXIT=0(无需任何混淆)。顶层 env 的取值里出现这个开关一律红,
 *      **不判它有没有被引用**(同判据②的取向:少一层推理就少一个绕过口);
 *   ①c **`$GITHUB_ENV` / `$GITHUB_OUTPUT` 运行期注入**(复审 §2.3):同一 job 里前一步写进
 *      `$GITHUB_ENV` 的变量会被后一步继承 ⇒ 判据①②都只看得见变量名。判据 = "写进去的变量名
 *      是本 job 里**后面的**守卫/编排器调用步 argv 会读到的"(跨 job 不成立:每个 job 是独立
 *      runner,按同 job + 位置在前收窄以避免假阳性);
 *   ② **逐调用点**:调用根守卫 / 编排器的步骤(`check-root-guards.mjs` /
 *      `check-workspaces.mjs` / `yarn check` / `yarn check:fast`),**连同该步、所在 job
 *      **与 workflow 顶层**的 `env:` 取值**一起判 —— 把开关放进 env 再用 `$EXTRA_FLAGS`
 *      拼进 argv 是 ① 看不见的形态(它不在 `run` 的文本里)。env 侧**故意不判"这个变量有没有被
 *      引用"**:守卫步的 env 里根本不该出现这个名字,少一层推理就少一个绕过口。
 *
 * **仍然认账**(写清楚,不让读者以为已经穷尽):`env:` 的取值本身可以是表达式/变量
 * (`${{ vars.X }}` / `${{ env.X }}`),静态看不出它最终展开成什么 —— 本判据只管"取值里
 * 真的写着这个开关 ✕ 拆开写"的形态;`$GITHUB_PATH` 改写 `node`/`yarn` 解析路径、上游 job
 * 用 artifact/缓存投毒等更远的路径不在射程内(需要时另立判据)。
 *
 * 与 [SK-8] 的分工:[SK-8] 判**命令形态**(`--no-guards` / `--only` / `--changed` 这类
 * 让检查面缩水的参数),本条判**退出语义**(检查照跑,但失败被降级成告警)。两条都缺一
 * 不可 —— [SK-8] 的弱化参数清单里没有 `--allow-advisory`,而它比任何弱化参数都更彻底。
 *
 * 与 `o2-weakening-in-comment` 一致:判据读的是 `executableScript`(去注释后的可执行
 * 文本),注释里写"历史写法:--allow-advisory"不触发 —— 注释不是会被执行的命令。
 */
const ADVISORY_OPT_IN_FLAG = '--allow-advisory'
/** 承载根守卫/编排器的脚本(判据②的调用点锚点;别名由 `ADVISORY_GATE_ALIAS` 覆盖)。 */
const ADVISORY_GUARD_ANCHORS = ['check-root-guards.mjs', 'check-workspaces.mjs']
/** `yarn check` / `yarn check:fast` / `node scripts/check-workspaces.mjs check` 别名(**非**全局正则)。 */
const ADVISORY_GATE_ALIAS = /(?:^|[;&|(\n]|\$\()\s*(?:corepack\s+yarn|yarn|node\s+scripts\/check-workspaces\.mjs)\s+(?:check:fast(?![:\w-])|check(?![:\w-]))/u

/**
 * 把一段 shell/env 文本归一成**词级**形态:去掉空引号对(`""` / `''`)与反斜杠转义
 * (`\x` → `x`)。
 *
 * 为什么需要(第七轮独立复审 V2 §2.3):`--allow-""advisory` 在 shell 里展开成
 * `--allow-advisory`,而字面子串匹配看不见它(实测 `check-workflows` EXIT=0)。
 * 这个归一**只删字符、不新增字符**,所以它只会把"本来就是同一个开关、只是被引号/转义
 * 切开"的写法认出来,不会凭空空造出这个开关。
 *
 * @param text - 原文。
 * @returns 归一后的文本。
 */
function advisoryFlagShape(text) {
  return typeof text === 'string' ? text.replace(/""|''/gu, '').replace(/\\([\s\S])/gu, '$1') : ''
}

/**
 * 开关的**整词**形态:前后必须是词边界(空白 / 引号 / `=` / 命令分隔符)。
 *
 * 为什么必须是整词(2026-09-25 第九轮审计 B 泳道 FP-3):旧判据是裸子串匹配 ⇒
 * **不同旗标** `--allow-advisory-strict` 也被判红(它根本不是那个开关),
 * 而且报错文案说"把开关放在了顶层",与事实不符。
 */
const ADVISORY_FLAG_WORD = /(?:^|[\s"'=;|&(){}<>$,])--allow-advisory(?=$|[\s"';|&(){}<>$,])/u

/**
 * 文本里是否出现那个静音开关(字面量形态 **或** 引号/转义拆开的形态)。
 *
 * `requireFlagVector`(env 取值专用):还要求这段取值是"**旗标向量**"—— 每个空白分隔的
 * token 都以 `-` 开头。这一半是给 FP-3 的**说明文本**用的:workflow 顶层写
 * `env: {PICO_NOTE: "do not pass --allow-advisory anywhere"}` 时,那段话里有整词的
 * `--allow-advisory` 却显然不是"把开关注入 argv";而真正的用法(`ROOT_GUARD_FLAGS:
 * --allow-advisory` / `--allow-advisory --verbose`)每个 token 都是旗标。
 *
 * @param text - 原文。
 * @param options - `requireFlagVector` = 这段文本是 env **取值**还是一段命令文本。
 * @returns 是否命中。
 */
function carriesAdvisoryFlag(text, { requireFlagVector = false } = {}) {
  if (typeof text !== 'string') return false
  const shaped = advisoryFlagShape(text)
  if (requireFlagVector) {
    const tokens = shaped.split(/\s+/u).filter(token => token !== '')
    if (tokens.length === 0 || !tokens.every(token => token.startsWith('-'))) return false
    return tokens.includes(ADVISORY_OPT_IN_FLAG)
  }
  return ADVISORY_FLAG_WORD.test(shaped)
}

/** `env:` 映射里的字符串取值(非字符串取值静态判不了,原样滤掉)。 */
function envStringValues(env) {
  if (typeof env !== 'object' || env === null) return []
  return Object.values(env).filter(value => typeof value === 'string')
}

/** 运行期写入"后续步骤环境"的文件(`$GITHUB_ENV` / `$GITHUB_OUTPUT` / `$GITHUB_PATH`)。 */
const GITHUB_ENV_WRITE = /(?:^|[^A-Za-z0-9_])GITHUB_(?:ENV|OUTPUT|PATH)\b/u
/**
 * `$GITHUB_ENV` 的**追加**形态(重定向或 `tee -a`)。
 *
 * [SK-17⑧b] 用它把"真的往环境文件里写键"与"顺带提到这个名字"分开。与 `GITHUB_ENV_WRITE`
 * 的差别是**只认 `$GITHUB_ENV`**:`$GITHUB_OUTPUT` 写的是 step output(供
 * `${{ steps.x.outputs.y }}` 消费),**不注入后续步骤的进程环境** —— 在"未登记即红"的
 * 白名单下把输出名也拉进判据面,只会把 `code=` / `version=` 这类正常写法变成假阳性。
 */
const GITHUB_ENV_APPEND = /(?:>>?|(?:^|\|)\s*tee\s+(?:-a|--append)\s*)\s*"?\$?\{?GITHUB_ENV\}?"?/u
/**
 * `$GITHUB_PATH` 的**追加**形态(重定向或 `tee -a`)。
 *
 * [SK-17⑥a] 用它把"PATH 覆写"与"顺带提到这个名字"分开:赋值 `GITHUB_PATH=/x` 或注释里的
 * 说明文字都不算(注释在上面已被 `executableScript` 剥掉),只有真的往那个文件里写目录才算
 * —— 那正是 Actions 里改后续步骤 PATH 的正式通道。
 */
const GITHUB_PATH_APPEND = /(?:>>?|(?:^|\|)\s*tee\s+(?:-a|--append)\s*)\s*"?\$?\{?GITHUB_PATH\}?"?/u
/** 从 `NAME=value` 里取变量名(判据①c 的另一半:写进去的名字有没有被守卫步消费)。 */
const ENV_ASSIGNMENT = /(?:^|[^A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_]*)=/gu
/**
 * `$GITHUB_ENV` 写入里的**键名**(比 `ENV_ASSIGNMENT` 窄:名字必须出现在行首/空白/引号之后)。
 *
 * 为什么不能直接用 `ENV_ASSIGNMENT`([SK-17⑧b] 在"未登记即红"的白名单下会变假阳性机器):
 * 它按"前一个字符不是字母数字"匹配,于是**取值里**的 `=` 片段也算成键 ——
 * `NODE_OPTIONS=--import=data:…` 里的 `import=`、`…process.exitCode=0` 里的 `exitCode=`、
 * 连接串 `?sslmode=require` 里的 `sslmode=` 全都会被当成"往 `$GITHUB_ENV` 写了一个新键"。
 * 实测(第十轮修复过程):一条 composite 注入被报成 3 个键,而白名单会把这种噪声判红。
 * `(?:^|[\s"'])` 要求名字前面是空白/引号/行首 ⇒ 取值内部的片段不再入面。
 */
const GITHUB_ENV_KEY_ASSIGNMENT = /(?:^|[\s"'])([A-Za-z_][A-Za-z0-9_]*)=/gu
/** 一段 shell 文本里引用的 `$VAR` / `${VAR}`。 */
const SHELL_VARIABLE_REFERENCE = /\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/gu

/**
 * [SK-16] 的实现(判据见常量区注释)。
 * @param file - workflow 文件名。
 * @param document - parseYaml 的结果。
 * @param notes - 提示收集器。
 * @returns 失败项列表。
 */
function checkAdvisoryOptIn(file, document, notes) {
  const failures = []
  const jobs = typeof document?.jobs === 'object' && document.jobs !== null ? document.jobs : {}
  // workflow **顶层** `env:`(2026-09-24 第七轮独立复审 V2 §2.2):Actions 会把它注入
  // **每个 job 的每个 step**,而旧实现的判据②只读 `step.env` 与 `job.env`。
  const workflowEnv = envStringValues(document?.env)
  // ①b 顶层 env 的取值里出现这个开关 ⇒ 红。**不判它有没有被引用**:守卫步只要写
  // `$ROOT_GUARD_FLAGS`,运行期就会把它拼进 argv(复审用 argv 替身实测过),而"变量名叫
  // 什么"是可以随便改的 —— 少一层推理就少一个绕过口(与判据②同一取向)。
  const workflowEnvMap = typeof document?.env === 'object' && document.env !== null ? document.env : {}
  for (const [key, value] of Object.entries(workflowEnvMap)) {
    if (!carriesAdvisoryFlag(value, { requireFlagVector: true })) continue
    failures.push({
      name: file,
      line: 0,
      detail: `[SK-16] workflow **顶层** \`env:\` 的 \`${key}\` 取值里出现了 \`${ADVISORY_OPT_IN_FLAG}\` 的写法`
        + `(\`${String(value).trim()}\`)`
        + '\n  ⇒ 顶层 `env:` 会被**每个 job 的每个 step** 继承,而判据①只看 `run` 文本、'
        + '判据②原先只看 step/job 的 `env:` ⇒ 把开关放在顶层、命令里只写 `$VAR`,'
        + '两条判据都看不见(第七轮复审实测 `check-workflows` EXIT=0,而旗标真的送到了守卫、'
        + '也真的把「已登记 advisory 的守卫失败」从 EXIT=1 翻成 EXIT=0)。'
        + '\n  ⇒ 守卫静音开关不许出现在任何一层 `env:` 里(顶层 / job / step 都不行)。',
    })
  }
  // ---- 第一遍:找守卫/编排器调用步,记下它们 argv 会读到的变量名(判据①c 的另一半)----
  const guardSteps = []
  for (const [jobId, job] of Object.entries(jobs)) {
    const jobEnvKeys = Object.keys(typeof job?.env === 'object' && job.env !== null ? job.env : {})
    const steps = Array.isArray(job?.steps) ? job.steps : []
    steps.forEach((step, index) => {
      if (typeof step?.run !== 'string') return
      const script = executableScript(step.run)
      const invokesGuard = ADVISORY_GUARD_ANCHORS.some(anchor => script.includes(anchor))
        || ADVISORY_GATE_ALIAS.test(script)
      if (!invokesGuard) return
      const referenced = new Set(jobEnvKeys)
      for (const key of Object.keys(typeof step.env === 'object' && step.env !== null ? step.env : {})) {
        referenced.add(key)
      }
      for (const match of script.matchAll(SHELL_VARIABLE_REFERENCE)) referenced.add(match[1])
      guardSteps.push({ jobId, index, referenced })
    })
  }
  let guardInvocations = 0
  for (const [jobId, job] of Object.entries(jobs)) {
    const jobEnv = typeof job?.env === 'object' && job.env !== null ? Object.values(job.env) : []
    const steps = Array.isArray(job?.steps) ? job.steps : []
    steps.forEach((step, index) => {
      if (typeof step?.run !== 'string') return
      const stepName = typeof step.name === 'string' && step.name.trim() !== '' ? step.name : `第 ${index + 1} 步`
      const label = `job ${jobId} 的 step「${stepName}」`
      const script = executableScript(step.run)
      // ① 全局:任何可执行文本里都不许出现这个开关(**含引号/转义拆开的写法**)。
      if (carriesAdvisoryFlag(script)) {
        failures.push({
          name: file,
          line: 0,
          detail: `[SK-16] ${label} 的可执行文本里出现了 \`${ADVISORY_OPT_IN_FLAG}\``
            + '\n  ⇒ 这个开关只有一个用途:让 `scripts/check-root-guards.mjs` 把'
            + '「已登记 advisory 的守卫失败」从**拦门禁**降级成**只打一行告警**'
            + '(`advisory` 登记制 + 这个开关 = 一条完整的红→绿通道)。CI 里它是静音键,'
            + '一律不得出现 —— 要临时放行请走"改 `ADVISORY_REGISTRY` 并写明理由/批准人/'
            + '到期日"那条**可评审、可到期复核**的路。',
        })
      }
      // ①c `$GITHUB_ENV` 注入:运行期写进"后续步骤的环境"⇒ 判据①只看得见**这一步自己的
      //    文本**(拆字面量那种写法由 ① 的词级归一咬住),而"写进去的变量名被本 job 里
      //    **后面的**守卫调用步消费"这一半 ①②都看不见(命令里只有 `$VAR`、env 里是空的)。
      //    跨 job 不生效:每个 job 是独立 runner,所以按同 job + 位置在前 收窄(避免假阳性)。
      if (GITHUB_ENV_WRITE.test(script)) {
        const assigned = new Set([...script.matchAll(ENV_ASSIGNMENT)].map(match => match[1]))
        const consumers = guardSteps.filter(entry => entry.jobId === jobId && entry.index > index)
        const consumed = [...assigned].filter(name => consumers.some(entry => entry.referenced.has(name)))
        if (consumed.length > 0) {
          failures.push({
            name: file,
            line: 0,
            detail: `[SK-16] ${label} 往 \`$GITHUB_ENV\`/\`$GITHUB_OUTPUT\` 写入了本 job 里`
              + '**守卫/编排器调用步的 argv 会读到的变量**:'
              + `${consumed.map(name => `\`${name}\``).join(', ')}`
              + '\n  ⇒ 同一个 job 里,前一步写进 `$GITHUB_ENV` 的变量会被后一步继承 ——'
              + '于是"这一步到底给守卫传了什么参数"在 `run` 文本里读不出来(判据①看不见字面量、'
              + '判据②的 env 里也是空的)。第七轮复审的现场形态就是它:'
              + '`echo "ROOT_GUARD_FLAGS=--allow-""advisory" >> "$GITHUB_ENV"` + 守卫步 `… $ROOT_GUARD_FLAGS`'
              + '(拆字面量那一半由判据①的词级归一另判)。'
              + '\n  ⇒ 守卫/编排器的 argv 只允许来自**这一步自己 `env:` 里逐字写出的取值**;'
              + '需要动态取值请走 `ADVISORY_REGISTRY` 那条可评审、可到期复核的路。',
          })
        }
      }
      // ② 逐调用点:守卫/编排器调用步 + 该步、所在 job **与 workflow 顶层**的 env 取值。
      const stepEnv = envStringValues(step.env)
      const invokesGuard = ADVISORY_GUARD_ANCHORS.some(anchor => script.includes(anchor))
        || ADVISORY_GATE_ALIAS.test(script)
      if (!invokesGuard) return
      guardInvocations += 1
      const smuggled = [
        ...(carriesAdvisoryFlag(script) ? [script] : []),
        ...stepEnv.filter(text => carriesAdvisoryFlag(text, { requireFlagVector: true })),
        ...jobEnv.filter(text => carriesAdvisoryFlag(text, { requireFlagVector: true })),
        ...workflowEnv.filter(text => carriesAdvisoryFlag(text, { requireFlagVector: true })),
      ]
      if (smuggled.length > 0 && !carriesAdvisoryFlag(script)) {
        failures.push({
          name: file,
          line: 0,
          detail: `[SK-16] ${label} 调用了根守卫/编排器,而 \`allow-advisory\` 出现在`
            + '它的 `env:` 取值里(run 文本里看不见 ⇒ 单看命令会漏判)'
            + `\n  命中取值:${smuggled.map(text => `\`${text.trim()}\``).join(', ')}`
            + '\n  ⇒ 用 env 把开关拼进 argv 与直接写在命令上等价:检查照跑、失败被降级成告警。'
            + '守卫/编排器的调用步必须**完全不带**这个开关(env 也不许;'
            + '`env:` 写在 step / job / **workflow 顶层**哪一层都一样会被继承)。',
        })
      }
    })
  }
  if (guardInvocations > 0) {
    // 措辞刻意**不写开关名**：`check-workspaces.mjs` 的降级行分类器把 `advisory` 当关键词，
    // 写进去会让这条"检查通过"的证据被摘进 [DEGRADED] 摘要、误导读者以为有判据没跑。
    notes.push(`[SK-16] 守卫静音开关面:${guardInvocations} 个根守卫/编排器调用点均已检查`
      + '(该开关只会把守卫失败改成告警,取值与判据见 [SK-16] 注释)')
  }
  return failures
}

/**
 * [SK-14⑥] 被钉住的「失败链」步骤的**步骤体**判据(第六轮独立复审 V2 边界③)。
 *
 * 现场(R6-C-2 的同族,2026-09-23 第六轮独立复审 V2):`if:` 可以逐字合法、`run` 里也
 * 仍然有 `exit 1` 与 `needs.<job>.result` 两个子串,但把步骤体换成**结构上不可能失败**
 * 的惰性形态 —— 多行 diff、可评审,而 `node scripts/check-workflows.mjs` EXIT=0:
 *
 *   ```yaml
 *   run: |
 *     set -euo pipefail
 *     if [ "never" = "${{ needs.gate-guards.result }}" ]; then
 *       echo "::error::…${{ needs.gate-guards.result }}…"
 *       exit 1
 *     fi
 *     echo "guards ok"
 *   ```
 *
 * 这一步是"根守卫失败 ⇒ 必需的 Gate 检查也红"的**唯一**链路(`gate-guards` 自己不在
 * 分支保护的必需检查里)。判据只回答一个问题:**这一步跑起来时，它一定会以非零码结束吗**。
 *
 * 判据(两条,缺一不可):
 *   ① 步骤体里不得有**零退出码的出口** —— `exit 0`,以及裸 `exit`(退出码取上一条命令,
 *      实测形态里就是 0)。有它,尾部那句 `exit 1` 可能永远到不了;
 *   ② **最后一条有效语句**必须是一个**非零 `exit` 的失败收尾**,即该语句以
 *      `exit <非零>` 结束(前面可以是普通命令、`;` 序列、`&&`/`||` 短路、`{ …; }` 块):
 *      · `exit <非零>`、`<命令>; exit <非零>` ✓;
 *      · `<命令> || exit <非零>`、`<命令> && exit <非零>` ✓ —— 这是本仓既有的"正常
 *        fail-loud 收尾"写法,**不得误判**(与 [SK-7a] 的 `isSafeFailureTail` 同一口径);
 *      · **块级收尾**(`fi` / `done` / `esac` / `}`)✗ —— 块里的 `exit` 可能永不执行,
 *        这正是上面那个惰性形态(它的最后一条有效语句是那句 `echo "guards ok"`)。
 *
 * ## 退出码必须**数值归一**,不能只认字面量 `exit 0`(第七轮独立复审 R7-C P1-1)
 *
 * 现场:旧判据把"零出口"写成一个正则 `exit\s+0`、把"失败收尾"写成 `exit\s+[1-9][0-9]*`,
 * 于是只认**十进制字面量**。实测(2026-09-23,把 `.github/workflows/ci.yml` 的 `exit 1`
 * 换成 `exit 00` 再补一句死代码 `exit 1`)**EXIT=0** —— "根守卫失败 ⇒ 必需 Gate 红"
 * 这条唯一链路被静默摘除,而 diff 看起来只是"多了一个字符":
 *
 *   ```yaml
 *   run: |
 *     set -euo pipefail
 *     echo "::error::…"
 *     exit 00          # bash: 退出码 0 —— 这一步到这里就绿了
 *     exit 1           # 死代码:永远到不了,但旧判据只看得见它
 *   ```
 *
 * 所以两条判据都改走 `normalizeExitCode()`:把 `exit` 的**操作数**按 shell 的真实语义
 * 归一到 0..255(见该函数的注释),再判"是不是零"。命中的形态(逐条实测):
 *   · `exit 00` / `exit 000`      → 十进制 0;
 *   · `exit "0"` / `exit '0'`     → 去引号后 0;
 *   · `exit +0` / `exit -0`       → 带符号 0;
 *   · `exit $((0))` / `exit "$(( 1 - 1 ))"` → 算术展开后 0;
 *   · `exit 256` / `exit 512`     → **低 8 位**为 0(bash 的真实语义:`exit 256` 的
 *     退出码就是 0)—— 这是同一族里更隐蔽的一张脸,旧判据同样只认 `exit 1`;
 *   · `exit 0x0` / `exit 0x100`   → 归一为 0。**诚实标注**:bash 的 `exit` 内建只接受
 *     十进制,这两个形态会让 bash **自己报错退 2**(即"这一步其实会红");本判据仍按
 *     "零出口"拒,是与 [SK-14] 一致的 fail-closed 取向(求不出/不该写的形态一律不放过),
 *     不是"它们真的会静默绿"。
 * 反向同样归一:尾部那句必须是**归一后非零**的 `exit`,`exit 256` 不再算合格收尾。
 *
 * 诚实边界(不假装是证明):这是**语法级**判据,不是"这段 shell 一定失败"的证明。
 *
 * 第七轮独立复审 V2 §1.2(2026-09-24)实测:上一版把边界写成
 * `(?:^|[;&|({])[ \t]*(?:(?:then|do|else)[ \t]+)?exit\b`、再按 `\n` 切语句,于是**同一份
 * 判据还有 11 种写法能让它 EXIT=0,而这一步的真 bash 退出码恒为 0**,其中 7 种连注释里的
 * 认账清单都没提 —— 最容易写出的 `case … in …) exit 0 ;; esac` 就在里面。三处根因:
 *
 *   · **边界集不含 `)`** ⇒ `case` 分支里的 `exit`(`1) exit 0 ;;`)看不见;
 *   · **只允许 `then|do|else` 三个关键字** ⇒ `time` / `command` / `builtin` / `\exit`
 *     这些**前缀**看不见(它们不改 `exit` 的语义,只改词法形状);
 *   · **按 `\n` 切语句** ⇒ 行尾续行把一个词劈成两行(`exi\` + 换行 + `t 0`)时两侧都看不见。
 *
 * 本轮逐条补上(每条都有红/绿样本,见 u29–u50):
 *   ⓪ 续行先按 **shell 语义**合并(`\`+换行**整对删除**,不是替换成空格)——
 *      见 `joinShellContinuations`;替换成空格会把 `exi\`+`t 0` 归一成 `exi t 0`(仍然漏);
 *   ① 边界集补 `)`/`}`,并允许**前缀链**(`time`/`command`/`builtin`/`nohup`/`setsid`/
 *      `stdbuf`/`sudo`/`env`/`eval`/`exec`/`!`/`\`);边界识别前先把**引号内容**屏蔽掉
 *      (引号里的文本不是代码,`echo "… ) exit 0 …"` 不得误报);
 *   ①b 引号里**同样是代码**的那一面单独判:`trap <动作>` 的动作、`eval <代码>` 的参数
 *      会被 shell 再解析一次 —— `trap 'exit 0' EXIT` 会让整步以 0 收尾;
 *   ①c `exec <命令>` 会**替换掉这个 shell** ⇒ 尾部那句 `exit 1` 是死代码(`exec true`);
 *   ①d 定义一个叫 `exit` 的函数会把内建**遮蔽**掉(`exit() { true; }` + `exit 1` ⇒ 退出 0);
 *   ①e 命令词被引号拆开(`ex"it" 0` / `""exit 0`)拼起来仍是 `exit`,只是词法上看不见;
 *   ②b 尾部是 `X || exit <非零>` 且 `X` 是**恒成功**命令(`echo`/`true`/`:`)⇒ 判红
 *      (`echo ok || exit 1` 就是复审认账的那条残余;`test … || exit 1` 这类判定命令不受影响)。
 *
 * 仍然认账(**写清楚,不让读者以为已经穷尽**):命令词是**动态**拼出来的形态静态证明不了 ——
 * `cmd=exit; "$cmd" 0`、`"$RUNNER" 0`、变量/命令替换当命令词;靠**别的语句**(而不是尾部
 * `exit`)决定退出码的写法同理;`X || exit <非零>` 里 `X` 是**外部命令/函数调用**时它的真实
 * 退出码也证明不了(只收紧了能静态认出恒成功的那一类)。取向与 [SK-14] 其余各条一致:
 * **求不出真假 ⇒ 按"会静默"处理**(所以 u28 那种 `exit "$code"` 一律红,而不是"不确定就放过")。
 *
 * @param script - 去掉注释后的可执行文本(`executableScript(step.run)`)。
 * @returns `null` = 合格;否则是人读的不合格原因(带现场形态)。
 */
function pinnedStepFailureTailProblem(script) {
  const statements = stripHereDocBodies(joinShellContinuations(script))
    .split('\n')
    .map(line => stripLineComment(line).trim())
    .filter(line => line !== '')
  if (statements.length === 0) return '步骤体是空的(一个语句都没有)'
  // ① 零退出码出口(**任意位置**,归一后为 0 的 `exit`,以及裸 `exit`)。
  //
  // "任意位置"这条对**所有** `exit` 都要求一个可达性下限:归一后为 0 ⇒ 红;连归都归不
  // 出来的(`exit "$code"` / `exit $?` / 命令替换)也 ⇒ 红 —— 因为"它一定非零"同样证明
  // 不了,而只要有一条不确定的出口,尾部那句非零 `exit` 就可能是死代码。取向与块级收尾
  // 一致:**求不出真假 ⇒ 按"会静默"处理**。
  for (const line of statements) {
    const shadowed = exitFunctionShadowProblem(line)
    if (shadowed !== null) return shadowed
    const split = quoteSplitCommandWordProblem(line)
    if (split !== null) return split
    for (const invocation of scanExitInvocations(line)) {
      if (invocation.operand === '') return `步骤体里有零退出码的出口(裸 \`exit\`(退出码取上一条命令)):${line}`
      const value = normalizeExitCode(invocation.operand)
      if (value === null) {
        return `步骤体里有一个**归一不出确定退出码**的出口(\`exit ${invocation.operand}\`):${line}`
          + ' ⇒ 静态证明不了它一定非零(变量/命令替换/函数),而只要有一条这样的出口,'
          + '"这一步必然失败"就不成立 —— 求不出真假按"会静默"处理,与块级收尾同一取向。'
      }
      if (value === 0) {
        return `步骤体里有零退出码的出口(\`exit ${invocation.operand}\` 归一后退出码 0):${line}`
      }
    }
    // ①b/①c:引号里的**代码面**(`trap` 动作 / `eval` 参数)与 `exec` 替换 shell。
    const embedded = embeddedExitProblem(line)
    if (embedded !== null) return embedded
    // ①b 的另一半:动作本身是**动态构造**的 `trap`(第九轮审计 B 泳道 P1-2)。
    const dynamicTrap = trapDynamicActionProblem(line)
    if (dynamicTrap !== null) return dynamicTrap
    const replaced = execReplacementProblem(line)
    if (replaced !== null) return replaced
  }
  // ② 尾部:最后一条有效语句必须以**归一后非零**的 `exit` 收尾(位置不限:裸形态 /
  //    `;` 序列 / `&&` / `||` / `{ …; exit N; }` / `( …; exit N )` 都算 —— 正常
  //    fail-loud 收尾与等价的子 shell 收尾都不得误判)。
  const last = statements[statements.length - 1]
  // ⓪d **子 shell / 命令组收尾**(2026-09-25 第九轮审计 B 泳道 FP-1):`( exit 1 )` 与
  //     `{ …; exit 1; }` 在执行视角下**等价**(两者都会真的执行里面的语句,退出码都由里面
  //     最后一条命令决定)。第八轮的反例样本 u60 收下了 `{ …; exit 1; }`,却把 `( exit 1 )`
  //     判红(父提交 `3d4306dded` 上实测 EXIT=0)⇒ 同一语义两种结论。归约到内层再判。
  const effective = unwrapTrailingCommandGroup(last) ?? last
  // ⓪c **函数定义不是失败收尾**(2026-09-24 第八轮审计 D-18)。
  const definition = functionDefinitionProblem(effective)
  if (definition !== null) return definition
  const tail = effective.replace(/[\s;}]+$/u, '')
  const invocations = scanExitInvocations(tail)
  const final = invocations[invocations.length - 1]
  if (final !== undefined && tail.slice(final.end).trim() === '') {
    // ① 已经保证这里归得出确定值(它扫的就是同一批语句) —— 这一句是"顺序变了也不会漏"
    // 的兜底,不是活判据。
    const value = normalizeExitCode(final.operand)
    if (value === null) {
      return `最后一条有效语句(\`${last}\`)的 \`exit\` 操作数(\`${final.operand}\`)归一不出确定退出码`
        + ' ⇒ "这一步一定会以非零码结束"证明不了(变量/命令替换的真实取值静态度量不出)'
    }
    if (value !== 0) {
      // ②b `X || exit <非零>`:左侧**恒成功**时这一步会以 0 结束。
      const alwaysGreen = alwaysSucceedingOrTailProblem(tail, final)
      if (alwaysGreen !== null) return alwaysGreen
      return null
    }
    return `最后一条有效语句(\`${last}\`)以**零退出码**收尾(\`exit ${final.operand}\` 归一后 0)`
      + ' ⇒ 这一步会绿着退出'
  }
  return `最后一条有效语句(\`${last}\`)不是非零 \`exit\` 的失败收尾`
}

/**
 * 把"尾部被一对圆括号整包住"的语句**归约到内层**(第九轮审计 B 泳道 FP-1)。
 *
 * 只认这一种形态:语句的**最后一个顶层片段**(按 `;` / `&&` / `||` / `|` / `&` 切)恰好被
 * 一对圆括号包住 —— 即第一个非空字符是 `(`、括号深度在最后一个非空字符处才回到 0。
 * 这样 `x=$(exit 1)` / `echo $(exit 1)` 这类**命令替换**不会被误放行(它们的退出码由外层
 * 命令决定,`echo $(exit 1)` 的退出码是 0)。
 *
 * @param statement - 最后一条有效语句(已 trim)。
 * @returns 内层文本;不是"整包住的命令组"时返回 `null`。
 */
function unwrapTrailingCommandGroup(statement) {
  const masked = maskQuotedRegions(statement)
  let start = 0
  let depth = 0
  for (let index = 0; index < masked.length; index += 1) {
    const char = masked[index]
    if (char === '(') { depth += 1; continue }
    if (char === ')') { depth -= 1; continue }
    if (depth !== 0) continue
    if (char === ';') { start = index + 1; continue }
    if ((char === '&' || char === '|') && masked[index + 1] === char) {
      start = index + 2
      index += 1
      continue
    }
    if (char === '&' || char === '|') { start = index + 1 }
  }
  const maskedSegment = masked.slice(start)
  const segment = statement.slice(start)
  if (!maskedSegment.trim().startsWith('(')) return null
  let level = 0
  let close = -1
  for (let index = 0; index < maskedSegment.length; index += 1) {
    const char = maskedSegment[index]
    if (char === '(') level += 1
    if (char !== ')') continue
    level -= 1
    if (level < 0) return null
    if (level === 0) {
      if (maskedSegment.slice(index + 1).trim() !== '') return null
      close = index
    }
  }
  if (level !== 0 || close < 0) return null
  const open = segment.indexOf('(')
  if (open < 0 || close <= open) return null
  return segment.slice(open + 1, close)
}

/**
 * 把 here-doc 的**载荷与终止词**从语句流里摘掉([SK-14⑥],2026-09-24 第八轮审计 R8-C-3)。
 *
 * 现场:`cat <<'exit 1'` + 载荷 + 终止词 `exit 1` —— 终止词在语法上**不是命令**,但逐行
 * 扫描会把最后这行当成"尾部那句非零 `exit`",于是判据认为这一步可靠地失败(实测门禁
 * EXIT=0),而真实退出码是 0。修法:按 here-doc 语法把 `<<[-]?<词>` 之后的载荷与
 * **终止词**一起丢弃(丢弃的是数据,不是代码)。
 *
 * 诚实边界:`<<<`(here-string)不在此列 —— 它是**参数**,内容会被 shell 当代码执行
 * (`source /dev/stdin <<< 'exit 0'`),由 `embeddedExitProblem` 的 `source`/`.` 判据覆盖。
 * 找不到终止词时把剩余行全部丢弃(数据无法界定 ⇒ 不拿它当代码,也不会误当成收尾)。
 *
 * @param script - 已按 shell 语义合并续行的文本。
 * @returns 摘掉 here-doc 载荷/终止词后的文本。
 */
const HERE_DOC_START = /(?<![<])<<(-?)[ \t]*(?:'([^']*)'|"([^"]*)"|([A-Za-z_][A-Za-z0-9_]*))/u

function stripHereDocBodies(script) {
  const lines = script.split('\n')
  const kept = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    kept.push(line)
    const match = HERE_DOC_START.exec(line)
    if (match === null) continue
    const [, dash, single, double, bare] = match
    const word = single ?? double ?? bare ?? ''
    if (word === '') continue
    const terminator = dash === '-'
      ? new RegExp(`^\\t*${escapeRegExp(word)}[ \\t]*$`, 'u')
      : new RegExp(`^${escapeRegExp(word)}[ \\t]*$`, 'u')
    index += 1
    while (index < lines.length && !terminator.test(lines[index])) index += 1
    // 终止词那一行也不进语句流(它不是命令);找不到终止词时循环自然走到末尾(剩余按数据丢弃)。
  }
  return kept.join('\n')
}

/** 把文本按**字面量**放进正则(here-doc 终止词可能含 `.`/`*` 等)。 */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/**
 * 扫出一行 shell 里**全部** `exit` 调用及其操作数文本([SK-14⑥] 的共用词法层)。
 *
 * 与"用一条正则匹配 `exit 0`"的区别(第七轮独立复审 R1-1 的根因):操作数可以是
 * `$((0))` 这种**带括号**的形态,正则的字符类一旦把 `)` 当分隔符就会截断成 `$((0`
 * 而**漏判**。这里改成手写扫描:从 `exit` 之后读操作数,带**引号感知**与**括号配平**
 * (`,` `$(( … ))` 里的空格与括号都算操作数的一部分),在深度 0 遇到
 * `;` `&` `|` `}` `#` 或空白才收尾。
 *
 * `exit` 的边界(第七轮独立复审 V2 §1.2 后收紧):行首或 `; & | ( ) { }` 之后,允许中间
 * 隔一个 `then` / `do` / `else` / `elif` **与一串前缀词**(`time` / `command` / `builtin` /
 * `nohup` / `setsid` / `stdbuf` / `sudo` / `env` / `eval` / `exec`)或 `!` / `\`。
 *   · 关键字与前缀词**不能**单独当边界(必须在分隔符之后):否则 `echo "then exit 0"` 这种
 *     **引号里的文本**会被误判成零出口;
 *   · 边界识别在 `maskQuotedRegions()` 之后做 —— 引号里的 `)`/`;` 同样不算分隔符。
 *
 * @param line - 单条语句(已去注释、已 trim)。
 * @returns `{ operand, start, end }[]`:`operand` = 操作数原文(`''` = 裸 `exit`),
 *   `start` = `exit` 词本身在原行里的起始下标,`end` = 操作数的结束下标
 *   (供"尾部只剩 `;`/`}`"与"`||` 左侧是不是恒成功命令"这两条判据使用)。
 */
function scanExitInvocations(line) {
  const results = []
  const masked = maskQuotedRegions(line)
  const boundary = exitBoundaryPattern()
  let match
  while ((match = boundary.exec(masked)) !== null) {
    const { operand, end } = readExitOperand(line, match.index + match[0].length)
    results.push({ start: match.index + match[0].length - 'exit'.length, operand, end })
    boundary.lastIndex = Math.max(boundary.lastIndex, end)
  }
  return results
}

/**
 * [SK-14⑧] **两条 shell 口径必须一致**:块级(`extractRunBlocks` + `nearestShell`)vs
 * 步骤级(YAML 解析后的 `step.shell` / `job.defaults.run.shell`)。
 *
 * 现场(第八轮审计 D-24):`extractRunBlocks` 里 step 级 `shell:`(缩进 8)与 job 级
 * `defaults.run.shell`(也是缩进 8)曾按同一个缩进区间认 ⇒ 一个步骤声明的 `shell: python`
 * 被当成**该 job 的默认 shell**、泄漏给后面所有块。后果是**静默**的:那些块的 `bash -n`
 * 与 SK-7 三条策略整段不跑(它们按 `block.shell` 决定要不要检查),而 `[SK-14]` 用的是
 * 步骤级口径 ⇒ 两条口径不一致时,**没有任何东西报出来**。
 *
 * 判据(只判**危险方向**):块级口径是**非 POSIX** shell、而步骤级口径是 POSIX ⇒ 红。
 * 反向(块级 POSIX / 步骤级非 POSIX)不判红 —— 那只是检查更严,不会漏。
 * 这样既不误伤"workflow 级 `defaults.run.shell`"(两条口径这时都拿不到它),也把 D-24 的
 * 泄漏变成一句可读的报错。
 *
 * @param file - workflow 文件名。
 * @param document - 解析后的 YAML。
 * @param blocks - `extractRunBlocks` 的结果。
 * @param notes - 证据行收集器。
 * @returns 失败项数组。
 */
function checkShellResolutionConsistency(file, document, blocks, notes) {
  const failures = []
  let checked = 0
  for (const item of shellSteps(document, blocks)) {
    const blockShell = item.block?.shell
    if (typeof blockShell !== 'string') continue
    checked += 1
    if (!NON_POSIX_SHELLS.test(blockShell) || NON_POSIX_SHELLS.test(item.shell)) continue
    failures.push({
      name: file,
      line: 0,
      detail: `[SK-14] job ${item.jobId} 的步骤「${item.label}」的两条 shell 口径**不一致**:`
        + `块级解析 = \`${blockShell}\`,步骤级解析 = \`${item.shell}\``
        + '\n  ⇒ 块级口径决定 `bash -n` 与 SK-7 三条策略**要不要检查这个块**,步骤级口径决定'
        + ' [SK-14] 的判定 ⇒ 不一致时那个块会**静默失去语法检查**(第八轮审计 D-24 的现场:'
        + '同 job 里一个步骤的 `shell: python` 泄漏成该 job 的默认 shell,后面所有块整段不检查)。'
        + '\n  ⇒ 只有 `defaults.run.shell` 才是 job 默认 shell;step 级 `shell:` 只影响它自己那一步。',
    })
  }
  if (checked > 0) notes.push(`[SK-14] shell 口径一致性:${checked} 个 shell 步骤两条口径一致`)
  return failures
}

/**
 * [SK-14⑦] 被钉步骤允许的 **shell**(2026-09-24 第八轮审计 D-19;2026-09-25 第九轮 B 泳道 P1-3 收紧)。
 *
 * 现场一(D-19):`shell: python` + `sys.exit(0)` 体 —— SK-14 的 ④/⑥ 对**非 POSIX shell
 * 直接 `continue`**(静态判不了那个语言的退出语义),而当时**没有任何判据钉住被钉步骤的 shell**
 * ⇒ 门禁 EXIT=0,而这一步在 Actions 里跑的是 python,退出码由 `sys.exit(0)` 决定。
 *
 * 现场二(P1-3,第九轮 B 泳道):旧判据只看**第一个词** ⇒ `shell: bash -c 'exit 0' {0}` 与
 * `bash` 等价(首词都是 `bash`)。但 GitHub 的 shell 模板把 `{0}` 替换成脚本路径并**作为参数**
 * 传给 `bash -c '<代码>'` —— 于是 `run:` 的脚本体**一次都不执行**,而这一步的退出码由那段
 * 内联代码决定。实测:给**唯一链路步**或 **`run: yarn check` 的全量门禁步**加这一行,
 * `check-workflows` EXIT=0、`[SK-8/SK-9]` 的"全量门禁恰好一次"照旧命中。
 *
 * 判据:**整串**必须是登记形态之一(不是"首词在名单里"):
 *   · `bash` / `sh`(缺省形态:脚本体就是 `run` 的内容);
 *   · `bash` / `sh` + 选项 + **`{0}` 作为独立词**(如官方的 `bash -e {0}`:脚本路径是
 *     **文件参数** ⇒ 脚本体一定被执行)。
 * 其余一律红,尤其是含 **`-c`** 的模板(`{0}` 只会成为内联代码的 `$0`)与**不含 `{0}`** 的
 * 模板(脚本内容根本不会被喂给解释器)。要新形态请登记进 `PINNED_STEP_SHELL_FORMS` 并写明
 * "脚本体为什么一定被执行"。
 */
const PINNED_STEP_SHELLS = ['bash', 'sh']

/**
 * `[SK-14⑦]` 的整串判据实现。
 * @param shell - 解析后的 shell 取值(step 级 → job 默认 → 缺省 `bash`)。
 * @returns `null` = 登记形态内;否则是人读的不合格原因。
 */
function pinnedShellProblem(shell) {
  const value = normalizeShellValue(shell)
  if (PINNED_STEP_SHELLS.includes(value)) return null
  const words = value.split(' ').filter(word => word !== '')
  const head = (words[0] ?? '').toLowerCase()
  if (!PINNED_STEP_SHELLS.includes(head)) {
    return `它的 shell 是 \`${shell}\`(只允许 ${PINNED_STEP_SHELLS.map(name => `\`${name}\``).join(' / ')};`
      + 'step 级 `shell:` > job 级 `defaults.run.shell` > 缺省 bash)'
      + '\n  ⇒ 判据的 ④/⑥ 对非 POSIX shell 静态判不了退出语义(直接跳过)⇒ 一个'
      + '`shell: python` + `sys.exit(0)` 就能让被钉步骤恒绿(第八轮审计 D-19 实测 EXIT=0)。'
      + '\n  ⇒ 被钉的判据步骤必须跑在本门禁认识的 shell 里;要别的语言请另立判据,'
      + '不要把这一步换掉。'
  }
  const rest = words.slice(1)
  const program = rest.map(word => normalizeShellValue(word))
  if (program.some(word => /^-[A-Za-z]*c/u.test(word))) {
    return `它的 shell 是 \`${shell}\` —— 含 \`-c\` 的**模板**会让脚本体**一次都不执行**`
      + '(`{0}` 只会成为内联代码的 `$0`,GitHub 把脚本路径当参数传进去,而 `bash -c` 只跑它'
      + '第一个参数里的代码)'
      + '\n  ⇒ 实测:给"唯一链路步"或 `run: yarn check` 的全量门禁步加一行'
      + " `shell: bash -c 'exit 0' {0}`(run 一字不改)⇒ `check-workflows` EXIT=0,"
      + '而这一步真实退出码 0、整段脚本文本从不执行。'
      + '\n  ⇒ 被钉步骤的 shell 只允许 `bash` / `sh` 与"把 `{0}` 当脚本文件参数"的模板(如 `bash -e {0}`)。'
  }
  if (!program.includes('{0}')) {
    return `它的 shell 是 \`${shell}\` —— 模板里没有 \`{0}\`(脚本路径)⇒ 脚本文本不会被喂给解释器`
      + '(GitHub 只执行这个模板本身)。被钉步骤只允许 `bash` / `sh` 或含 `{0}` 的模板(如 `bash -e {0}`)。'
  }
  return null
}

/**
 * [SK-14⑦] 被钉步骤的 **argv 钉子**(2026-09-24 第八轮审计 D-21)。
 *
 * 现场:跨过 `yarn check` 的 `[SK-8]` 弱化参数判据,给**守卫运行步**加一个参数
 * `node scripts/check-root-guards.mjs --list` ⇒ `check-workflows` EXIT=0。而 `--list`
 * 只打印清单、**恒退 0** ⇒ "永不跳过"的 `gate-guards` 变成**永久绿灯空转**,
 * 必需的 Gate 检查照样看到 success。
 *
 * 判据:**逐字登记**允许的附加 argv(缺省 = 一个都不许)。要加参数必须先登记并写明理由
 * (与 `PINNED_STEP_IF_POLICIES` / 白名单同一套纪律)。
 */
const PINNED_STEP_ARGV_POLICIES = {
  'root-guard-runner': {
    allowed: [],
    describe: '不得带任何附加参数(`--list` / `--help` / `--version` 这类会让这一步'
      + '只打印信息、恒退 0 ⇒ 「永不跳过」的守卫 job 变成永久绿灯空转)',
  },
  'guard-parser-integrity': {
    // R12-D-04（P2）：锚点只有这一个脚本 —— 判据读的是"这一步**执行**的 argv"，
    // 而这一步的步骤体里还有 `git show HEAD:scripts/check-install-integrity.mjs`（另一个脚本），
    // 所以锚点必须**逐策略**指定，不能沿用 `ADVISORY_GUARD_ANCHORS`（那是守卫/编排器运行步的）。
    anchors: [GUARD_PARSER_SCRIPT],
    allowed: ['--require-clean'],
    required: ['--require-clean'],
    describe: '必须**逐字**带 `--require-clean`（它是"工作树↔HEAD 锚定"的**参数通道**：'
      + 'env 信号能被一行 `unset CI GITHUB_ACTIONS` 清掉，argv 不能 —— J1 复审 N2 ②），'
      + '且不得带其它附加参数（`--print-digests` 只打印、不判）',
  },
}

/**
 * 取调用点之后的**附加 argv**([SK-14⑦])。
 *
 * @param script - 去注释后的可执行文本。
 * @param anchor - 脚本锚点(例:`scripts/check-root-guards.mjs`)。
 * @returns 附加 argv 词(已去引号;不含锚点本身)。
 */
function pinnedStepExtraArgv(script, anchor) {
  const pattern = new RegExp(`[^\\s;&|(){}]*${escapeRegExp(anchor)}([^\\n;&|]*)`, 'u')
  const match = pattern.exec(script)
  if (match === null) return []
  // 重定向先剥掉(第九轮审计 B 泳道 FP-2):`… 2>&1 | tee log` / `… > /dev/null` 里的
  // `2>`、`/dev/null` 是**重定向**不是参数,旧口径把两者当"未登记的附加参数"判红,而
  // 同一个文件里的 `checkRootGateIntegrity` 明确先剥重定向 ⇒ 两份口径必须统一。
  return stripShellRedirections(match[1])
    .split(/[ \t]+/u)
    .map(token => token.replace(/^["']|["']$/gu, '').trim())
    .filter(token => token !== '')
}

// ===== [SK-14⑦]/[SK-15] 的**命令位**判据(2026-09-25 第九轮审计 B 泳道 P1-1/P1-4)=====
//
// 现场:第八轮把识别口径从"原始 YAML 子串"改成"**去注释后的可执行文本**子串" —— 方向对,
// 但仍然是**子串**判据:"提到"与"执行"不分。审计方实跑确认三行 no-op 就能让 16 个根守卫
// 零执行、而 `check-workflows` EXIT=0:
//   · `run: |` + `: scripts/check-root-guards.mjs`   (`:` 是 bash 内建 no-op,退出码恒 0)
//   · `run: |` + `test -f scripts/check-root-guards.mjs`
//   · `run: |` + `echo "node scripts/check-root-guards.mjs"`
// 同一根因的第二处:把 R2 上传步改成 `run: echo "scripts/ci-publish-update-server.sh --list …"`
// 之后,发布链登记表照样"命中"(`require` 也是子串匹配)⇒ **品牌渠道唯一分发面零上传而门禁绿**。
//
// 判据不是再加一层正则,而是把"这段 shell 跑起来会执行哪些命令"解析出来:按 shell 分隔符
// 切段 → 用 `maskQuotedRegions` 找到**引号外**的分隔位置 → 在**原文**上切片并分词 → 跳过
// 前缀词(`env`/`sudo`/`time`/`command`/…)与变量赋值 → 取剩下的第一个词作**命令词**。
// 只有"命令词本身是目标"或"解释器之后的第一个参数是目标"才算**被执行**。
//
// 诚实边界:`$(…)`/变量拼出来的命令词静态证明不了(与 [SK-14] 其余各条同一取向:求不出
// 真假 ⇒ 按"会静默"处理,所以那种形态拿不到"命令位"认定 ⇒ 判红)。
/** shell 里"一条新命令开始"的分隔形态(在**屏蔽引号后**的文本上匹配;含换行)。 */
const COMMAND_SEGMENT_SEPARATOR = /\n|&&|\|\||[;&|(){}]|!(?=\s)|\b(?:if|then|elif|else|while|until|do|done|esac|fi)\b/gu
/** 能把脚本体当**参数**交给解释器的命令词(命令位判据的认识范围)。 */
const SHELL_INTERPRETER_COMMANDS = ['node', 'nodejs', 'bash', 'sh', 'dash', 'zsh', 'ksh']

/**
 * 把 shell 重定向从文本里**用空格顶掉**(保留下标与长度,便于与屏蔽后的位置对齐)。
 *
 * 覆盖 `2>&1` / `2>&-` / `> file` / `>> file` / `< file` / `&> file`;只认**引号外**的
 * 重定向(位置取自 `maskQuotedRegions` 的结果),所以 `echo "a > b"` 不被误剥。
 * @param text - 一段 shell 文本。
 * @returns 重定向被空格顶掉的同长文本。
 */
function stripShellRedirections(text) {
  const masked = maskQuotedRegions(text)
  const pattern = /(?:\d?>&\d+-?|\d?>&-|\d?&>>?|\d?>>?|\d?<)\s*(?:[^\s;&|()]+)?/gu
  const chars = text.split('')
  for (const match of masked.matchAll(pattern)) {
    for (let index = match.index; index < match.index + match[0].length; index += 1) chars[index] = ' '
  }
  return chars.join('')
}

/**
 * 冻结启动器表达式的**命令名等价**（[SK-20]）。
 *
 * `"${{ steps.frozen-launchers.outputs.node }}" <脚本>` 里的命令词在 `splitShellWords` 之后是
 * 那个表达式本身 —— 判据面必须知道它**就是** `node`/`bash`/`git`，否则收口会把下面这些
 * 既有判据全部打死（实测：加冻结前缀后 [SK-14] 覆盖率 8→3、`PINNED_USES_REGISTRY` 冒出
 * 8 条假死条目）：`guardRunnerCommandProblem` / `executesInstallPrecheck` /
 * `rootGateInvocations` / `wasmGate*` / `PINNED_STEP_POLICIES` 的每一条 match。
 */
const FROZEN_LAUNCHER_TARGET_ALIASES = new Map([
  [`\${{ steps.${FROZEN_LAUNCHER_STEP_ID}.outputs.node }}`, 'node'],
  [`\${{ steps.${FROZEN_LAUNCHER_STEP_ID}.outputs.interp }}`, 'bash'],
  [`\${{ steps.${FROZEN_LAUNCHER_STEP_ID}.outputs.git }}`, 'git'],
])

/** `./x` → `x`(只去"当前目录"前缀;带目录的形态原样保留)；冻结启动器表达式 → 它等价的那个命令名。 */
function normalizeScriptTarget(word) {
  const normalized = word.replace(/^\.\//u, '')
  return FROZEN_LAUNCHER_TARGET_ALIASES.get(normalized.trim()) ?? normalized
}

/** 解释器名比较用:取路径最后一段(`/usr/bin/node` 与 `node` 等价)。 */
function commandHead(word) {
  const parts = word.split('/')
  return parts[parts.length - 1] ?? word
}

/**
 * 一段 shell 文本里**被真的执行**的命令(命令词 + 后面全部词)。
 *
 * 实现要点:**整段一起处理**(不按行切)—— `bash -c '多行载荷'` 这类形态里引号跨行,
 * 按行切会让 `splitShellWords` 因引号不配对返回 `null`,整段命令就被静默跳过
 * (`ci.yml` 的渠道 DMG 打包步正是这个形状)。
 *
 * @param script - 去注释后的可执行文本。
 * @returns `{ command, argv }[]`(`argv` = 命令词之后的词,已剥重定向与引号)。
 */
function executedCommands(script) {
  const opened = joinShellContinuations(executableScript(script))
  const masked = maskQuotedRegions(opened)
  const segments = []
  let start = 0
  COMMAND_SEGMENT_SEPARATOR.lastIndex = 0
  let match
  while ((match = COMMAND_SEGMENT_SEPARATOR.exec(masked)) !== null) {
    segments.push(opened.slice(start, match.index))
    start = match.index + match[0].length
  }
  segments.push(opened.slice(start))
  const commands = []
  for (const segment of segments) {
    const cleaned = stripShellRedirections(segment).trim()
    if (cleaned === '') continue
    const words = splitShellWords(cleaned)
    if (words === null) continue
    let index = 0
    while (index < words.length) {
      const word = words[index].text
      // 前缀词(`env`/`sudo`/`time`/…)、它们的选项、以及 `FOO=bar` 赋值前缀都不改"命令词是谁"。
      if (EXIT_PREFIX_WORDS.includes(word)) {
        // **`env` 的"带取值选项"**（第十一轮复审 J1 的 N2 同族）：`-u NAME` / `--unset NAME`
        // 各自**吃掉一个词**。通用规则只看"以 `-` 开头就跳过"，于是
        // `env -u CI -u GITHUB_ACTIONS node scripts/…` 的命令词被判成 `CI` ——
        // 这一步于是**不算执行过那个脚本**，`[SK-14]` 的"命令位"识别与 `[SK-17]` 的步骤体判据
        // 整条不适用（审计方实测：该形态既不报"没在命令位"，也不报 `unset` 面）。
        if (word === 'env') {
          let lookahead = index + 1
          while (lookahead < words.length && words[lookahead].text.startsWith('-')) {
            lookahead += (words[lookahead].text === '-u' || words[lookahead].text === '--unset') ? 2 : 1
          }
          index = lookahead
          continue
        }
        index += 1
        continue
      }
      if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(word)) { index += 1; continue }
      if (word.startsWith('-') && word !== '-') { index += 1; continue }
      break
    }
    const command = words[index]
    if (command === undefined) continue
    commands.push({ command: command.text, argv: words.slice(index + 1).map(word => word.text) })
  }
  return commands
}

/**
 * 目标脚本出现在**命令位**(被真的执行)时,它在各调用点**之后的** argv 词。
 *
 * @param script - 去注释后的可执行文本。
 * @param target - 目标脚本路径(例:`scripts/check-root-guards.mjs`)。
 * @returns 每个命中调用点的"目标之后"的 argv 词;**空数组 = 一次都没在命令位出现**。
 */
function commandPositionArgvs(script, target) {
  const wanted = normalizeScriptTarget(target)
  const hits = []
  for (const entry of executedCommands(script)) {
    if (normalizeScriptTarget(entry.command) === wanted) {
      hits.push(entry.argv)
      continue
    }
    // [SK-20]：解释器判定必须先过 `normalizeScriptTarget` —— 冻结启动器的命令词是
    // `${{ steps.frozen-launchers.outputs.node }}` 这种表达式，`commandHead` 认不出它是 `node`。
    if (!SHELL_INTERPRETER_COMMANDS.includes(commandHead(normalizeScriptTarget(entry.command)))) continue
    if (normalizeScriptTarget(entry.argv[0] ?? '') !== wanted) continue
    hits.push(entry.argv.slice(1))
  }
  return hits
}

/**
 * 与 {@link commandPositionArgvs} 同源，但**不**把冻结启动器表达式算作目标命令。
 *
 * 为什么需要它（[SK-20]）：`normalizeScriptTarget` 把
 * `"${{ steps.frozen-launchers.outputs.node }}"` 归一成 `node`（否则 `guardRunnerCommandProblem` /
 * `rootGateInvocations` / `PINNED_STEP_POLICIES` 的每一条 match 都会被冻结前缀打死），
 * 于是"这一步有没有调用裸 `node`"这个问题不能再问 `commandPositionArgvs` —— 它会把
 * 我们**要的**那个形态也数进去。这里按"命令词的原文是不是冻结表达式"过滤。
 * @param script - 去注释后的可执行文本。
 * @param target - 目标命令名（`node` / `bash` / `git`）。
 * @returns 每个命中调用点的 argv；空数组 = 没有**裸**调用。
 */
function rawCommandPositionArgvs(script, target) {
  const wanted = normalizeScriptTarget(target)
  const hits = []
  for (const entry of executedCommands(script)) {
    const raw = entry.command.trim()
    if (FROZEN_LAUNCHER_TARGET_ALIASES.has(raw)) continue
    if (normalizeScriptTarget(entry.command) === wanted) {
      hits.push(entry.argv)
      continue
    }
    if (!SHELL_INTERPRETER_COMMANDS.includes(commandHead(normalizeScriptTarget(entry.command)))) continue
    if (normalizeScriptTarget(entry.argv[0] ?? '') !== wanted) continue
    hits.push(entry.argv.slice(1))
  }
  return hits
}

/**
 * [SK-15] 的 `require` 里"调用某个脚本"的那一类,按**命令位 + 参数**判。
 *
 * 与 `commandPositionArgvs` 的分工:只有 `require` 的第一段**看起来是一个脚本路径**时才走
 * 命令位判据(`scripts/*.mjs` / `*.sh` / `*.ts`);其余的 `require`(`GITHUB_OUTPUT` /
 * `docs/releases/` / `test -f` / `exit 1` / `gh release` / `dist:mac:notarize`)是"这段
 * 文本里必须出现的东西",继续按子串判 —— 它们本来就不是"执行某个脚本"的断言。
 * @param script - 去注释后的可执行文本。
 * @param require - 登记项。
 * @returns 是否满足。
 */
function commandRequireSatisfied(script, require) {
  const words = splitShellWords(require)
  if (words === null || words.length === 0) return false
  const [head, ...rest] = words.map(word => word.text)
  return commandPositionArgvs(script, head).some(argv => {
    let cursor = 0
    for (const word of argv) {
      if (word === rest[cursor]) cursor += 1
      if (cursor === rest.length) break
    }
    return cursor === rest.length
  })
}

/** 一个 `require` 是否是"调用某个脚本"那一类(走命令位判据)。 */
function isCommandRequire(require) {
  return /^\S*scripts\/[\w./-]+\.(?:mjs|sh|ts|js)$/u.test(splitShellWords(require)?.[0]?.text ?? '')
}

/** 根守卫运行脚本是否出现在命令位;返回未命中的原因(命中返回 null)。 */
function guardRunnerCommandProblem(script) {
  if (commandPositionArgvs(script, DOCS_ONLY_GUARD_RUNNER).length > 0) return null
  return `文本里出现了 \`${DOCS_ONLY_GUARD_RUNNER}\`,但它不在**命令位**上`
    + ' ⇒ 这一步**不会执行**那个脚本,"永不跳过"的守卫 job 变成永久绿灯空转。'
    + '\n  实测三种零执行的写法(门禁当时全部 EXIT=0):'
    + `\n    · \`: ${DOCS_ONLY_GUARD_RUNNER}\`(bash 内建 \`:\` = no-op,退出码恒 0);`
    + `\n    · \`test -f ${DOCS_ONLY_GUARD_RUNNER}\`(只测文件在不在);`
    + `\n    · \`echo "node ${DOCS_ONLY_GUARD_RUNNER}"\`(只回显一行字)。`
    + '\n  ⇒ 只有 `node <脚本>` / `bash <脚本>` / `./<脚本>`(命令词位)才算执行;'
    + '命令词由变量/命令替换拼出来的形态静态证明不了,同样不算(求不出真假按"会静默"处理)。'
}

/** [SK-14⑥] 命令位置上的**前缀词**(第七轮独立复审 V2 §1.2 的形态②)。
 *
 * 它们不改 `exit` 的语义,只改词法形状:`time exit 0` / `command exit 0` / `builtin exit 0`
 * 全都是 `exit 0`(实测退出码 0),而旧边界只认 `then|do|else` 三个关键字。
 * `eval` / `exec` 本身是"交给另一个解析器/替换掉 shell"的语义,单列在 ①b/①c 里判;
 * 放进本表是为了让 `eval exit 0` 这种直白形态也被 ① 看见。
 */
const EXIT_PREFIX_WORDS = ['time', 'command', 'builtin', 'nohup', 'setsid', 'stdbuf', 'sudo', 'env', 'eval', 'exec']

/**
 * [SK-14⑥] 的边界词法:`<分隔符> [关键字] [前缀词… | `!` | `\`] exit`。
 *
 * **每次调用新建**(带 `g` 的正则是有状态的:共用常量时,嵌套调用会互相踩 lastIndex)。
 * @returns 边界正则。
 */
function exitBoundaryPattern() {
  return new RegExp(
    '(?:^|[;&|(){}])[ \\t]*(?:(?:then|do|else|elif)[ \\t]+)?'
      + `(?:(?:${EXIT_PREFIX_WORDS.join('|')})[ \\t]+|![ \\t]*|\\\\[ \\t]*)*exit\\b`,
    'gu',
  )
}

/** [SK-14⑥] ①e:命令位置上的**第一个词**(用来认"被引号拆开的命令词")。 */
function commandWordPattern() {
  return new RegExp(
    '(?:^|[;&|(){}])[ \\t]*(?:(?:then|do|else|elif)[ \\t]+)?'
      + `(?:(?:${EXIT_PREFIX_WORDS.join('|')})[ \\t]+)*([^\\s;&|(){}]+)`,
    'gu',
  )
}

/**
 * 把**引号内**的字符换成占位符(`\u0000`),下标与长度与原文逐字符对齐。
 *
 * 为什么需要:边界集补上 `)` 之后,`echo "case 1 in 1) exit 0 ;; esac"` 这种**引号里的
 * 文本**会被误判成零出口(假阳性)。反向的取舍也要写清楚:双引号里含命令替换
 * (`$( … )` / 反引号)时只屏蔽引号本身、内容留可见 —— 那一段是**代码**,不是文本;
 * 于是 `echo "… $(cmd) … exit 0 …"` 这种"文本里夹代码"的形态会**多报**(取向:多报只是
 * 改一句话,漏报就是静默变绿)。
 *
 * @param line - 单条语句。
 * @returns 同长度的屏蔽文本。
 */
function maskQuotedRegions(line) {
  const chars = line.split('')
  let index = 0
  while (index < line.length) {
    const char = line[index]
    if (char === '\\' && index + 1 < line.length) {
      index += 2
      continue
    }
    if (char !== "'" && char !== '"') {
      index += 1
      continue
    }
    const close = quoteCloseIndex(line, index, char)
    if (close < 0) {
      // 双引号里有命令替换(或引号不配对):只屏蔽引号本身,内容按代码处理。
      chars[index] = '\u0000'
      index += 1
      continue
    }
    for (let cursor = index; cursor <= close; cursor += 1) chars[cursor] = '\u0000'
    index = close + 1
  }
  return chars.join('')
}

/**
 * ①d:步骤体里定义了一个叫 `exit` 的 shell 函数 ⇒ 内建被**遮蔽**。
 *
 * 实测(`bash -c 'set -euo pipefail; exit() { true; }; exit 1'` ⇒ 退出码 0):函数优先于
 * 内建,尾部那句 `exit 1` 调的是函数。这是"尾部看着是 `exit <非零>`"里最直白的一张假脸。
 */
const EXIT_FUNCTION_SHADOW = /(?:^|[;&|(){}])[ \t]*(?:function[ \t]+)?exit[ \t]*(?:\([ \t]*\)[ \t]*)?\{/u

/**
 * ①d 的判据实现。
 * @param line - 单条语句。
 * @returns `null` = 没有遮蔽;否则是不合格原因。
 */
function exitFunctionShadowProblem(line) {
  if (!EXIT_FUNCTION_SHADOW.test(line)) return null
  return `步骤体里定义了一个叫 \`exit\` 的函数(\`${line}\`)⇒ 函数优先于内建,`
    + '尾部那句 `exit <非零>` 调的是它(实测 `exit() { true; }` 之后 `exit 1` 的退出码是 0)。'
}

/**
 * ①e:命令词被引号拆开(`ex"it" 0` / `""exit 0` / `exit"" 0`)。
 *
 * shell 会把这些片段拼成**一个词** `exit`(实测退出码 0),而 `maskQuotedRegions` 之后
 * 词法上再也看不见它。判据只看"命令位置上的第一个词":去掉引号后恰好是 `exit` 且**至少
 * 含一个引号字符** —— `echo "exit"` 这种"`exit` 只是参数"的形态不受影响(它的命令词是
 * `echo`)。
 *
 * @param line - 单条语句。
 * @returns `null` = 没有这种形态;否则是不合格原因。
 */
function quoteSplitCommandWordProblem(line) {
  for (const match of line.matchAll(commandWordPattern())) {
    const word = match[1]
    if (!/['"]/u.test(word)) continue
    if (word.replace(/['"]/gu, '') !== 'exit') continue
    return `步骤体里的 \`exit\` 被引号拆开了(\`${word}\`):\`${line}\``
      + ' ⇒ shell 把这些片段拼成**一个词** `exit`(实测 `ex"it" 0` 的退出码是 0),'
      + '而词法层看不见它。命令词不要用引号拼接。'
  }
  return null
}

/** ①b:`trap` / `eval` / `source` / `.` 把**一段会被再执行一次的代码**放进参数里。 */
const EMBEDDED_CODE_COMMANDS = ['trap', 'eval', 'source', '\\.']

/**
 * ①b 的判据实现:把 `trap <动作>` / `eval <代码>` 的参数去引号后再扫一遍 `exit`。
 *
 * 为什么单独判:引号里的文本一般不是代码(`echo "… exit 0 …"`),但这两个命令的参数
 * **是**代码 —— `trap 'exit 0' EXIT` 会让整步以 0 收尾(实测),`eval 'exit 0'` 同理。
 *
 * 诚实边界:参数是变量/命令替换时(`trap "$ACTION" EXIT`)静态看不出来 —— 那种形态在
 * [SK-7c] 的"内层无法静态解析"里另有判据,这里只判**静态字符串**参数。
 *
 * @param line - 单条语句。
 * @returns `null` = 合格;否则是不合格原因。
 */
function embeddedExitProblem(line) {
  for (const command of EMBEDDED_CODE_COMMANDS) {
    // `\.` 是"点号 source"的形态(`. ./x.sh`):它后面必须是空白,不能用 `\\b`(点不是词字符)。
    const pattern = new RegExp(
      `(?:^|[;&|(){}])[ \\t]*(?:(?:${EXIT_PREFIX_WORDS.join('|')})[ \\t]+)*${command}(?:\\b|(?=[ \\t]))`,
      'gu',
    )
    for (const match of line.matchAll(pattern)) {
      // `<<<`(here-string)把右侧当**输入**,而 `source`/`.` 会把它当代码执行:
      // `source /dev/stdin <<< 'exit 0'` 实测退出码 0(第八轮审计 R8-C-3)。
      // 归一成命令分隔符后再扫,让它落进同一套边界判据。
      const payload = line.slice(match.index + match[0].length).replace(/['"]/gu, '').replace(/<<</gu, '; ')
      for (const invocation of scanExitInvocations(payload)) {
        const value = invocation.operand === '' ? 0 : normalizeExitCode(invocation.operand)
        if (value !== null && value !== 0) continue
        const shape = invocation.operand === '' ? '裸 `exit`' : `\`exit ${invocation.operand}\``
        return `步骤体里的 \`${command}\` 参数是**会被再执行一次的代码**,而那段代码里有`
          + `${value === 0 ? '零退出码的出口' : '归一不出确定退出码的出口'}(${shape}):\`${line}\``
          + (command === 'trap'
            ? ' ⇒ `trap … EXIT` 的动作是 `exit 0` 时整步以 0 收尾(实测),尾部那句 `exit <非零>` 是死代码。'
            : ' ⇒ `eval` 的参数会被 shell 再解析一次,`exit 0` 一样会让整步绿着退出。')
      }
    }
  }
  return null
}

/**
 * ①b 的另一半:`trap` 的**动作是动态构造**的 ⇒ 按"会静默"处理(2026-09-25 第九轮审计 B 泳道 P1-2)。
 *
 * 现场:被钉链路步里写
 *   ```sh
 *   A='exit 0'
 *   trap "$A" EXIT
 *   echo "::error::root guards failed"
 *   exit 1
 *   ```
 * `embeddedExitProblem` 看不见它:`A='exit 0'` 的载荷被 `maskQuotedRegions` 屏蔽(引号里的
 * 文本不是代码),而 `trap` 的动作词是 `$A`(不是字面量 `exit`)。门禁 EXIT=0、**零失败项**,
 * 而真 bash 的退出码是 **0**(EXIT trap 里的 `exit 0` 覆盖最终退出码)⇒"根守卫失败 ⇒ 必需的
 * Gate 检查也红"这条唯一链路被摘除。同族:`trap "$(printf '%s %s' exit 0)" EXIT`。
 *
 * 判据:`trap` 的**动作词**不是"单个单引号字面量"、又含 `$`/反引号 ⇒ fail-closed。
 * 单引号整词**不做参数展开**,所以 `trap 'rm -rf "$tmp"' EXIT` 这类合法清理必须继续放行
 * (它有变量,但动作本身是静态字符串);`trap cleanup EXIT`(函数名)同样放行。
 *
 * 诚实边界:与 [SK-14] 其余各条一致 —— 动态动作的真实取值静态度量不出,**求不出真假 ⇒
 * 按"会静默"处理**;取向与 `exit "$code"` 被判红完全一致。
 *
 * @param line - 单条语句。
 * @returns `null` = 合格;否则是不合格原因。
 */
function trapDynamicActionProblem(line) {
  const pattern = new RegExp(
    `(?:^|[;&|(){}])[ \\t]*(?:(?:${EXIT_PREFIX_WORDS.join('|')})[ \\t]+)*trap(?:\\b|(?=[ \\t]))`,
    'gu',
  )
  for (const match of line.matchAll(pattern)) {
    const words = splitShellWords(line.slice(match.index + match[0].length))
    if (words === null || words.length === 0) continue
    let index = 0
    // `trap -p` / `trap -l` / `trap --` 这类选项与分隔符不算动作词。
    while (index < words.length && /^-[lp-]*$/u.test(words[index].raw)) index += 1
    const action = words[index]
    if (action === undefined) continue
    // 单引号整词 = 完全不做参数展开 ⇒ 动作是静态字面量,不是动态构造。
    if (/^'[^']*'$/u.test(action.raw)) continue
    if (!/[$`]/u.test(action.text)) continue
    return `步骤体里的 \`trap\` **动作是动态构造的**(\`${action.raw.trim()}\`)⇒ 静态证明不了`
      + '它在退出时会做什么(实测 `A=\'exit 0\'; trap "$A" EXIT; …; exit 1` 的退出码是 0:'
      + 'trap 里的 `exit 0` 覆盖了尾部那句 `exit 1`)。'
      + '\n  ⇒ 引号载荷被屏蔽、动作词不是字面量 ⇒ ①b 的字面量扫描看不见它。半静态的'
      + '`trap`(单引号字面量动作,如 `trap \'rm -rf "$tmp"\' EXIT` 清理)不受影响;'
      + '要动态动作请把退出语义写成**直接执行**的非零 `exit` 收尾。'
  }
  return null
}

/**
 * ①c:`exec <命令>` 会**替换掉这个 shell**。
 *
 * 实测(`bash -c 'set -euo pipefail; exec true; exit 1'` ⇒ 退出码 0):`exec <命令>` 之后
 * shell 进程就是那条命令,后面的 `exit 1` 永远不执行。纯重定向形态
 * (`exec 2>&1` / `exec 3<file` / `exec >log`)不替换进程,不算。
 */
const EXEC_REPLACEMENT = /(?:^|[;&|(){}])[ \t]*(?:(?:time|command|builtin)[ \t]+)?exec[ \t]+(?![0-9]*[<>]|[<>]|&[<>]|&-)\S/u

/**
 * ①c 的判据实现。
 * @param line - 单条语句。
 * @returns `null` = 合格;否则是不合格原因。
 */
function execReplacementProblem(line) {
  if (!EXEC_REPLACEMENT.test(line)) return null
  return `步骤体里用 \`exec\` 替换掉了这个 shell(\`${line.trim()}\`)⇒ \`exec <命令>\` 之后`
    + '这个 shell 就是那条命令,尾部那句 `exit <非零>` 永远不会执行(实测 `exec true` 的退出码是 0)。'
    + '纯重定向形态(`exec 2>&1` / `exec 3<file`)不算。'
}

/**
 * ⓪c:尾部是**函数定义**时,定义它本身**不会执行**函数体 ⇒ 这一步以 0 收尾(R8-D-18)。
 *
 * 现场(第八轮审计 D-18 的实测形态):把被钉链路步的收尾 `exit 1` 换成
 * `report_guards() { echo "guards ok"; exit 1; }` —— 旧的尾部归一先做
 * `tail.replace(/[\s;}]+$/u, '')`,把证明"这个 `exit` 在函数体内"的 `; }` **吃掉**,
 * 于是尾部看起来就是一段以 `exit 1` 收尾的普通语句 ⇒ 门禁 EXIT=0,而这一步真实退出码 0。
 *
 * 判据:最后一条有效语句**不得是函数定义**(`name() { … }` / `function name { … }`)。
 * 反例必须继续放行:`{ …; exit 1; }`(无名花括号组会**真的执行**)与正常的多行
 * `if …; then …; fi` 之后的 `exit 1`。
 */
const FUNCTION_DEFINITION = /^\s*(?:function[ \t]+)?[A-Za-z_][\w.-]*[ \t]*(?:\([ \t]*\)[ \t]*)?\{/u

/**
 * ⓪c 的判据实现。
 * @param line - 最后一条有效语句(未做尾部 `;`/`}` 剥离)。
 * @returns `null` = 不是函数定义;否则是不合格原因。
 */
function functionDefinitionProblem(line) {
  if (!FUNCTION_DEFINITION.test(line)) return null
  return `最后一条有效语句(\`${line}\`)是一个**函数定义** ⇒ 定义函数不会执行它,这一步以 0 收尾`
    + '(实测 `report_guards() { echo "guards ok"; exit 1; }` 的退出码是 0;'
    + '旧的尾部归一会把结尾的 `; }` 吃掉,于是它看起来像以 `exit 1` 收尾的普通语句)。'
    + '\n  ⇒ 尾部必须是**直接执行**的非零 `exit`(或 `X || exit N` / `X && exit N` / `{ …; exit N; }`)——'
    + '把失败写进函数体而不调用它,等于没有失败收尾。'
}

/** ②b:静态可判的"恒成功"命令(只收这一小类,外部命令的真实退出码证明不了)。 */
const ALWAYS_SUCCEEDING_COMMANDS = ['echo', 'true', ':']

/**
 * ②b 的判据实现:`X || exit <非零>` 里 `X` 的命令词是**恒成功**命令 ⇒ 这一步会绿着退出。
 *
 * 现场是复审认账的那条残余:`echo ok || exit 1`(实测退出码 0)。判据只收紧"能静态认出
 * 恒成功左侧"的那一类 —— 本仓既有的正常写法 `test … || exit 1`(`X` 是判定命令,失败时
 * 才走 `exit`)必须继续放行,所以**不能**把整类 `||` 收尾判红。
 *
 * @param tail - 尾部语句(已 trim 掉收尾的 `;`/`}`)。
 * @param final - `tail` 里最后一条 `exit` 调用(`scanExitInvocations` 的结果)。
 * @returns `null` = 合格;否则是不合格原因。
 */
function alwaysSucceedingOrTailProblem(tail, final) {
  const prefix = tail.slice(0, final.start).replace(/[ \t]+$/u, '')
  if (!/\|\|$/u.test(prefix)) return null
  const left = prefix.replace(/\|\|$/u, '')
  const segments = maskQuotedRegions(left).split(/[;&|(){}]+/u).filter(part => part.trim() !== '')
  const words = (segments[segments.length - 1] ?? '').trim().split(/[ \t]+/u).filter(word => word !== '')
  let index = 0
  while (index < words.length && EXIT_PREFIX_WORDS.includes(words[index])) index += 1
  const command = words[index] ?? ''
  if (!ALWAYS_SUCCEEDING_COMMANDS.includes(command)) return null
  return `最后一条有效语句(\`${tail}\`)是 \`${command} … || exit ${final.operand}\`:`
    + `\`${command}\` 恒成功 ⇒ 左侧永远成功、右侧的 \`exit <非零>\` 永不执行(实测`
    + ` \`echo ok || exit 1\` 的退出码是 0)。`
    + '\n  ⇒ 要"判定失败才退出",左侧必须是**真的会失败的判定命令**(`test` / `[` / 具体的校验命令);'
    + `\`${command}\` 这种恒成功命令写在 \`||\` 左边等于没有判据。`
}

/**
 * 从 `exit` 之后读操作数([SK-14⑥] 的词法细节见 `scanExitInvocations`)。
 * @param line - 单条语句。
 * @param from - `exit` 词之后的起始下标。
 * @returns `{ operand, end }`。
 */
function readExitOperand(line, from) {
  let index = from
  while (index < line.length && (line[index] === ' ' || line[index] === '\t')) index += 1
  const begin = index
  let depth = 0
  let quote = null
  while (index < line.length) {
    const char = line[index]
    if (quote !== null) {
      if (char === quote) quote = null
      index += 1
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      index += 1
      continue
    }
    if (char === '(') {
      depth += 1
      index += 1
      continue
    }
    if (char === ')') {
      if (depth === 0) break
      depth -= 1
      index += 1
      continue
    }
    if (depth === 0) {
      if (char === ';' || char === '&' || char === '|' || char === '}' || char === '#') break
      if (char === ' ' || char === '\t') break
    }
    index += 1
  }
  return { operand: line.slice(begin, index), end: index }
}

/**
 * 把 `exit` 的操作数按 **shell 的真实语义**归一成 0..255 的退出码([SK-14⑥])。
 *
 * 实测口径(bash 5.x,`bash -c 'exit <操作数>'; echo $?`):
 *   · 操作数先做**展开**(去引号、算术展开),再按**十进制整数**解析;
 *   · 最终退出码 = 该整数**低 8 位**(`exit 256` → 0、`exit -1` → 255);
 *   · `$(( … ))` 内部是**算术**语义(十六进制/八进制/四则/括号都合法):
 *     `exit $((0x0))` → 0、`exit $(( 1 - 1 ))` → 0。
 *
 * 归不出确定值时返回 `null`(变量、命令替换、`$RANDOM`、函数调用…):调用方据此区分
 * "确定是零"与"求不出" —— 前者是缺陷,后者既不能算零(不误报)也不能算非零(见 ②)。
 *
 * @param operand - `exit` 之后的操作数原文(可能带引号)。
 * @returns 归一后的退出码(0..255);求不出时为 `null`。
 */
function normalizeExitCode(operand) {
  const bare = stripShellQuotes(operand.trim())
  if (bare === null || bare === '') return null
  const arithmetic = /^\$\(\((.*)\)\)$/su.exec(bare)
  const value = arithmetic === null ? parseIntegerOperand(bare) : evaluateArithmetic(arithmetic[1])
  if (value === null) return null
  return ((value % 256) + 256) % 256
}

/**
 * 去掉**成对包裹**的引号(单/双,可叠加:`"$((0))"`)。引号不配对或引号内有未配对的
 * 同类引号时返回 `null`(形态不认识 ⇒ 不猜)。
 * @param text - 已 trim 的操作数。
 * @returns 去引号后的文本;形态不认识时为 `null`。
 */
function stripShellQuotes(text) {
  let current = text
  for (;;) {
    if (current.length < 2) return current
    const first = current[0]
    const last = current[current.length - 1]
    if ((first !== '"' && first !== "'") || last !== first) return current
    const inner = current.slice(1, -1)
    if (inner.includes(first)) return null
    current = inner
  }
}

/**
 * `exit` 操作数的整数字面量:十进制 `[+-]?[0-9]+` 或十六进制 `[+-]?0x…`。
 *
 * **按十进制**解析十进制形态是有意为之:`exit 010` 在 bash 里是 10(不是八进制 8),
 * 退出码 10 —— 这里只判"是不是 0",两种解析都不影响结论,但按真实语义写免得日后被
 * 当成 bug 改回去。十六进制(`exit 0x0` / `exit 0x100`)在 bash 里其实会让 `exit`
 * 内建**报错退 2**,这里仍然按数值归一 —— 与 [SK-14] 一致取向:这类形态不该出现在
 * "必然失败"的收尾上,拦下来比放过它安全(见 `pinnedStepFailureTailProblem` 的注释)。
 * @param text - 去引号后的操作数。
 * @returns 数值;不是整数字面量时为 `null`。
 */
function parseIntegerOperand(text) {
  if (/^[+-]?0[xX][0-9a-fA-F]+$/u.test(text)) {
    const negative = text.startsWith('-')
    const magnitude = Number.parseInt(text.replace(/^[+-]/u, ''), 16)
    if (!Number.isSafeInteger(magnitude)) return null
    return negative ? -magnitude : magnitude
  }
  if (!/^[+-]?[0-9]+$/u.test(text)) return null
  const value = Number.parseInt(text, 10)
  return Number.isSafeInteger(value) ? value : null
}

/**
 * `$(( … ))` 的**只读**算术求值(整数 + `- * / %` + 括号 + 一元 `±`)。
 *
 * 只求值、不执行任何东西(没有变量、没有命令替换、没有赋值):任何不认识的字符(含
 * `$`、字母、`<`、`>`、`?`、`:` 等)都让整式归为 `null` —— 这是"求不出就不猜"的一半,
 * 也是它不可能被当成求值器的原因。支持的进制与 bash 算术一致:十六进制 `0x…`、
 * 前导 0 的八进制、十进制。
 *
 * @param expression - `$((` 与 `))` **之间**的原文。
 * @returns 整数结果;含不认识的 token 或除零时为 `null`。
 */
function evaluateArithmetic(expression) {
  const source = expression.replace(/\s+/gu, '')
  if (source === '') return null
  let index = 0
  const parsePrimary = () => {
    if (source[index] === '(') {
      index += 1
      const inner = parseSum()
      if (inner === null || source[index] !== ')') return null
      index += 1
      return inner
    }
    const literal = /^(?:0[xX][0-9a-fA-F]+|0[0-7]*|[0-9]+)/u.exec(source.slice(index))
    if (literal === null) return null
    index += literal[0].length
    const radix = /^0[xX]/u.test(literal[0]) ? 16 : /^0[0-7]+$/u.test(literal[0]) ? 8 : 10
    const value = Number.parseInt(literal[0], radix)
    return Number.isSafeInteger(value) ? value : null
  }
  const parseUnary = () => {
    if (source[index] === '+') {
      index += 1
      return parseUnary()
    }
    if (source[index] === '-') {
      index += 1
      const inner = parseUnary()
      return inner === null ? null : -inner
    }
    return parsePrimary()
  }
  const parseProduct = () => {
    let left = parseUnary()
    if (left === null) return null
    while (source[index] === '*' || source[index] === '/' || source[index] === '%') {
      const operator = source[index]
      index += 1
      const right = parseUnary()
      if (right === null) return null
      if ((operator === '/' || operator === '%') && right === 0) return null
      left = operator === '*' ? left * right : operator === '/' ? Math.trunc(left / right) : left % right
    }
    return left
  }
  const parseSum = () => {
    let left = parseProduct()
    if (left === null) return null
    while (source[index] === '+' || source[index] === '-') {
      const operator = source[index]
      index += 1
      const right = parseProduct()
      if (right === null) return null
      left = operator === '+' ? left + right : left - right
    }
    return left
  }
  const value = parseSum()
  if (value === null || index !== source.length) return null
  return Number.isSafeInteger(value) ? value : null
}

/**
 * [SK-14] 的实现:被钉住的判据步骤必须**可执行**(判据见常量区注释)。
 *
 * 与 [SK-8]/[SK-9]/[SK-12] 的分工:那三条策略负责"这一步在不在"(存在性与形态),
 * 本条负责"这一步**会不会真的跑、跑了能不能失败**" —— 它们各自只看得见自己那一面,
 * 而 `if: false` 正好落在两者之间(文本在、内容对,就是永不执行)。
 *
 * 步骤枚举走 `shellSteps()`(与 [SK-7a] 同一份"有效 shell"解析),吞码谓词与白名单也整份
 * 复用 [SK-7a] —— 这里是**收口**,不是第二套语法。
 *
 * @param file - workflow 文件名。
 * @param document - parseYaml 的结果。
 * @param blocks - extractRunBlocks 的结果(供 shellSteps 解析有效 shell 与行号)。
 * @param allowlist - 语句级吞码白名单(与 [SK-7a] 共用)。
 * @param notes - 提示收集器。
 * @returns 失败项列表。
 */
/**
 * [SK-14⑨] **install 期完整性前置校验必须真的在最前面**（第十二轮红队 R12-D-01）。
 *
 * 现场：`.yarnrc.yml` 的 `plugins:`（顶层模块代码在 yarn 启动期执行）与工作区
 * `postinstall` 都能在 `yarn install --immutable` 期间改写工作树里的判据本体
 * （`scripts/check-*.mjs`）⇒ **ci.yml 一字未改**，三个判定块全部 EXIT=0 而判据一条没跑。
 * 因此"这一步存在"不够，它的**位置**也是判据：必须在任何 `yarn` / `corepack` 命令之前。
 *
 * 判据（对每个登记 job，按 step 顺序）：
 *   ① 必须存在一个在**命令位**执行 `scripts/check-install-integrity.mjs` 的步骤；
 *   ② 该步骤之前不得有任何一个步骤在**命令位**执行 `yarn` / `corepack`
 *      （`uses:` 步骤不算：它们不跑仓内代码；注释与字符串里的字样也不算 —— 走命令位判定）。
 *
 * @param file - workflow 文件名。
 * @param document - parseYaml 的结果。
 * @param notes - 提示收集器。
 * @returns 失败项列表。
 */
function checkInstallIntegrityPrecedence(file, document, notes, options = {}) {
  const failures = []
  // **只对真实的那份 workflow 判**：登记表里的 job 名是 `ci.yml` 的（自检样本是合成文本，
  // 它们不该被这条判据要求"必须有 gate-guards/gate" —— 那会把自检逼成假红）。
  if (options?.scannedFile !== VERDICT_WORKFLOW_FILE) return failures
  const jobs = typeof document?.jobs === 'object' && document.jobs !== null ? document.jobs : {}
  for (const jobId of INSTALL_INTEGRITY_PRECEDENCE_JOBS) {
    const job = jobs[jobId]
    if (job === undefined || job === null) {
      failures.push({
        name: file,
        line: 0,
        detail: `[SK-14⑨] 登记的 job \`${jobId}\` 不在本 workflow 里 —— `
          + '`INSTALL_INTEGRITY_PRECEDENCE_JOBS` 的每一条都是"判据本体必须在 install 之前校验"的登记，'
          + 'job 被删/改名必须同步这张表（否则判据静默消失）。',
      })
      continue
    }
    const steps = Array.isArray(job?.steps) ? job.steps : []
    const scripts = steps.map(step => (typeof step?.run === 'string' ? executableScript(step.run) : ''))
    const precheckIndexes = scripts
      .map((script, index) => (executesInstallPrecheck(script) ? index : -1))
      .filter(index => index >= 0)
    if (precheckIndexes.length === 0) {
      failures.push({
        name: file,
        line: 0,
        detail: `[SK-14⑨] job \`${jobId}\` 里没有"在命令位执行 \`${INSTALL_INTEGRITY_PRECHECK}\`"的步骤 ——`
          + '判据本体（`scripts/check-*.mjs` / `.yarnrc.yml` / 全部 workspace manifest 的 install 期钩子）'
          + '在 install 期可被改写，而判据步骤排在 install **之后** ⇒ ci.yml 一字未改也能让全部判定块变绿'
          + '（第十二轮红队 R12-D-01 实测：三个 verbatim 判定块 EXIT=0、零判据执行）。',
      })
      continue
    }
    const first = Math.min(...precheckIndexes)
    const earlier = []
    for (let index = 0; index < first; index += 1) {
      const script = scripts[index]
      for (const command of ['yarn', 'corepack']) {
        if (commandPositionArgvs(script, command).length > 0) {
          earlier.push(`第 ${index + 1} 步「${stepName(steps[index], index)}」执行了 \`${command}\``)
        }
      }
    }
    if (earlier.length > 0) {
      failures.push({
        name: file,
        line: 0,
        detail: `[SK-14⑨] job \`${jobId}\` 的 install 期完整性前置校验排在第 ${first + 1} 步，`
          + `但它之前还有 yarn/corepack 命令：${earlier.join('；')}\n`
          + '  ⇒ 前置校验必须在**任何** yarn/corepack 命令之前（`.yarnrc.yml` 的 `plugins:` 顶层模块代码'
          + '在 yarn 启动期就执行，连 `yarn --version` 都会）—— 晚一步它校验的就是"已经被改写的树"。',
      })
      continue
    }
    notes.push(`[SK-14⑨] job \`${jobId}\` 的 install 期完整性前置校验在第 ${first + 1} 步，`
      + '此前没有任何 yarn/corepack 命令（顺序即判据）')
  }
  return failures
}

/**
 * [SK-14⑩] **通过凭据的断言块**必须在场且形态逐字（第十二轮红队 R12-D-03 / C-P1-2）。
 *
 * 现场：判定权上移到"只认通过凭据"之后，**断言块自己**没有静态判据 ——
 * 删掉断言、把 `恰好一行` 改回"出现过就行"、把步骤独占目录换回固定的 `/tmp/*.log`、
 * 或者去掉 nonce 绑定，`check-workflows` 都 EXIT=0（它可以被静默改弱/伪造）。
 *
 * 判据：登记表里的每一步都必须存在、且 `run:` 的可执行文本**逐字包含**它登记的关键件
 * （凭据形态 / 独占目录 / 一次性 nonce / 两个流分开 / 凭据检查器 / 退出码），
 * 并且**不得**出现登记表里点名的旧形态（固定日志路径 = R12-D-03 的③号载荷通道）。
 *
 * @param file - workflow 文件名。
 * @param document - parseYaml 的结果。
 * @param notes - 提示收集器。
 * @returns 失败项列表。
 */
function checkVerdictAssertionBlocks(file, document, notes, options = {}) {
  const failures = []
  // 同 [SK-14⑨]：登记表点的是 `ci.yml` 里的 job/step 名，合成样本不该被它要求。
  if (options?.scannedFile !== VERDICT_WORKFLOW_FILE) return failures
  const jobs = typeof document?.jobs === 'object' && document.jobs !== null ? document.jobs : {}
  for (const entry of VERDICT_ASSERTION_STEPS) {
    const job = jobs[entry.job]
    const steps = Array.isArray(job?.steps) ? job.steps : []
    const found = steps
      .map((step, index) => ({ step, index }))
      .filter(({ step }) => typeof step?.name === 'string' && step.name.trim() === entry.name)
    if (found.length !== 1) {
      failures.push({
        name: file,
        line: 0,
        detail: `[SK-14⑩] job \`${entry.job}\` 里名为「${entry.name}」的步骤有 ${found.length} 个（要求恰好 1 个）`
          + ' —— 这一步承载通过凭据的断言块，删掉/改名/复制都必须在登记表（`VERDICT_ASSERTION_STEPS`）里显式改。',
      })
      continue
    }
    const script = executableScript(found[0].step.run)
    const missing = entry.required.filter(token => !script.includes(token))
    if (missing.length > 0) {
      failures.push({
        name: file,
        line: 0,
        detail: `[SK-14⑩] job \`${entry.job}\` 的步骤「${entry.name}」的断言块少了关键件：`
          + `${missing.map(token => `\`${token}\``).join('、')}\n`
          + '  ⇒ 这条断言的作用是把"凭据"从**流属性**抬成"步骤独占文件 + 一次性 nonce"'
          + '（R12-D-03 的三种载荷：launcher 打印 / 两个流各打半行 / 前序步骤留下的进程往固定路径追加）。'
          + '删掉任一关键件都会让它退回旧形态；要改形态请同步改 `VERDICT_ASSERTION_STEPS` 并写明理由。',
      })
    }
    // **shell 函数遮蔽**（第十二轮 C 路实测）：在被钉步骤体里定义 `grep() { return 0; }` /
    // `awk() { … }` 这类同名函数，断言就恒真而文本一字未改。判据：这些承载凭据的步骤里
    // **不允许定义任何 shell 函数**（要复用逻辑请落到被登记的脚本文件里，那才是判据执行体）。
    const shadowed = [...script.matchAll(SHELL_FUNCTION_DEFINITION)].map(match => match[0].trim())
    if (shadowed.length > 0) {
      failures.push({
        name: file,
        line: 0,
        detail: `[SK-14⑩] job \`${entry.job}\` 的步骤「${entry.name}」里定义了 shell 函数：`
          + `${shadowed.slice(0, 2).map(text => `\`${text.split('\n')[0]}\``).join('、')}`
          + '\n  ⇒ 同名函数会**遮蔽**断言用的命令（实测 `grep() { return 0; }` 让"凭据必须恰好一行" '
          + '恒真，而步骤体文本一字未改）；承载凭据的步骤里不许定义函数。',
      })
    }
    const forbidden = entry.forbidden.filter(token => script.includes(token))
    if (forbidden.length > 0) {
      failures.push({
        name: file,
        line: 0,
        detail: `[SK-14⑩] job \`${entry.job}\` 的步骤「${entry.name}」里出现了**已废弃**的形态：`
          + `${forbidden.map(token => `\`${token}\``).join('、')}\n`
          + '  ⇒ 固定的日志路径可以被"前序步骤留下的进程"盯住并追加一行凭据'
          + '（第十二轮红队 R12-D-03 的③号载荷：一个只 `process.exit(0)` 的 runner + 一个往'
          + '`/tmp/root-guards.log` 追加伪造行的守护进程 ⇒ EXIT=0）。',
      })
    }
    if (missing.length === 0 && forbidden.length === 0) {
      notes.push(`[SK-14⑩] 步骤「${entry.name}」的凭据断言块形态完整（独占目录 + 一次性 nonce + 恰好一行）`)
    }
  }
  return failures
}

/**
 * [SK-14] 的实现:被钉住的判据步骤必须**可执行**(判据见常量区注释)。
 *
 * 与 [SK-8]/[SK-9]/[SK-12] 的分工:那三条策略负责"这一步在不在"(存在性与形态),
 * 本条负责"这一步**会不会真的跑、跑了能不能失败**" —— 它们各自只看得见自己那一面,
 * 而 `if: false` 正好落在两者之间(文本在、内容对,就是永不执行)。
 *
 * 步骤枚举走 `shellSteps()`(与 [SK-7a] 同一份"有效 shell"解析),吞码谓词与白名单也整份
 * 复用 [SK-7a] —— 这里是**收口**,不是第二套语法。
 *
 * @param file - workflow 文件名。
 * @param document - parseYaml 的结果。
 * @param blocks - extractRunBlocks 的结果(供 shellSteps 解析有效 shell 与行号)。
 * @param allowlist - 语句级吞码白名单(与 [SK-7a] 共用)。
 * @param notes - 提示收集器。
 * @returns 失败项列表。
 */
function checkPinnedStepExecutability(file, document, blocks, allowlist, notes) {
  const failures = []
  /** 命中过哪些"被钉住"的类别(供收尾 note 打印证据,避免"存在性断言 = 假绿")。 */
  const observed = []
  for (const item of shellSteps(document, blocks)) {
    const step = item.step
    const label = stepLabel(item)
    const script = executableScript(step.run)
    for (const policy of PINNED_STEP_POLICIES) {
      if (!policy.match(script, item)) continue
      observed.push(`${policy.id}@${item.jobId}#${item.label}`)
      // ① 常量假 `if:`(布尔 false 与字符串形态一起判 —— SK-12 此前只认字符串)。
      if (isConstantFalseIf(step.if)) {
        failures.push({
          name: file,
          line: 0,
          detail: `[SK-14] ${label} 是「${policy.label}」,但它的 \`if:\` 是常量假`
            + `(${JSON.stringify(step.if)})⇒ **这一步永远不会执行**(run 一字未改,`
            + '所以"文本还在"的存在性判据全绿)。'
            + '\n  ⇒ 被钉住的判据步骤必须真的能跑;要条件就用登记过的形态,不要把条件写成常量。',
        })
      } else if (step.if !== undefined && step.if !== null) {
        // ② `if:` 形态必须在该类别的登记表里。
        const allowed = PINNED_STEP_IF_POLICIES[policy.ifPolicy]
        const text = typeof step.if === 'string' ? step.if : String(step.if)
        if (!allowed.check(text, policy)) {
          const describe = typeof allowed.describe === 'function' ? allowed.describe(policy) : allowed.describe
          failures.push({
            name: file,
            line: 0,
            detail: `[SK-14] ${label} 是「${policy.label}」,但它的 \`if:\`(${text.trim()})不在登记形态里`
              + `\n  该类别只允许:${describe}`
              + '\n  ⇒ 判据步骤一旦被条件收窄(哪怕只是加一个合取项),就可能整条不跑;需要新形态请登记进'
              + ' PINNED_STEP_IF_POLICIES 并写明理由(与吞码白名单同一套纪律)。',
          })
        }
      }
      // ③ `continue-on-error`:失败不再让 job 红(表达式形态同样按"会静默"处理)。
      if (step['continue-on-error'] !== undefined && !isContinueOnErrorDisabled(step['continue-on-error'])) {
        failures.push({
          name: file,
          line: 0,
          detail: `[SK-14] ${label} 是「${policy.label}」,但打开了 continue-on-error`
            + `(${JSON.stringify(step['continue-on-error'])})⇒ 这一步失败不再让 job 红。`
            + '\n  ⇒ 判据步骤的失败必须传出去(它是"必需检查红"的唯一来源)。',
        })
      }
      // ⑦ **shell 钉子**(第八轮审计 D-19;第九轮 B 泳道 P1-3 收紧成**整串**登记)。
      //    它必须在 ④/⑥ 的"非 POSIX 就跳过"**之前**判 —— 否则那两个 `continue` 会把
      //    一个换了解释器的被钉步骤整段放过去(`shell: python` + `sys.exit(0)` 实测 EXIT=0)。
      const shellProblem = pinnedShellProblem(item.shell)
      if (shellProblem !== null) {
        failures.push({
          name: file,
          line: 0,
          detail: `[SK-14] ${label} 是「${policy.label}」,但${shellProblem}`,
        })
      }
      // ⑦ **argv 钉子**(第八轮审计 D-21):调用点之后不得带未登记的附加参数;
      //    第十二轮红队 R12-D-04 补另一半:**必须带的参数也不许少**(`allowed` 只拒"多"，
      //    拒不了"少" —— 删掉 `--require-clean` 实测 EXIT=0）。
      const argvPolicy = PINNED_STEP_ARGV_POLICIES[policy.id]
      if (argvPolicy !== undefined) {
        const anchors = argvPolicy.anchors ?? ADVISORY_GUARD_ANCHORS
        const anchor = anchors.find(candidate => script.includes(candidate))
        const extra = anchor === undefined ? [] : pinnedStepExtraArgv(script, anchor)
        const unexpected = extra.filter(token => !argvPolicy.allowed.includes(token))
        if (unexpected.length > 0) {
          failures.push({
            name: file,
            line: 0,
            detail: `[SK-14] ${label} 是「${policy.label}」,但它带了未登记的附加参数:`
              + `${unexpected.map(token => `\`${token}\``).join(', ')}`
              + `\n  该类别${argvPolicy.describe}`
              + '\n  ⇒ 第八轮审计 D-21 的现场:给守卫运行步加一个 `--list`(只打印清单、'
              + '恒退 0)就让"永不跳过"的 `gate-guards` 变成永久绿灯空转,而必需的 Gate 检查'
              + '照样看到 success(`yarn check --list` 会被 [SK-8] 咬住,守卫运行步当时没有这颗牙)。'
              + '\n  ⇒ 需要新参数请登记进 `PINNED_STEP_ARGV_POLICIES` 并写明理由(逐字登记,不做通配)。',
          })
        }
        // **必带参数**（第十二轮红队 R12-D-04 的另一半）：在**命令位**上执行的那个调用点，
        // 必须逐字带上登记的参数。逐字比对、不做通配 —— 与 `allowed` 同一套纪律。
        const invocation = anchor === undefined ? [] : commandPositionArgvs(script, anchor)
        const missing = (argvPolicy.required ?? [])
          .filter(token => !invocation.some(argv => argv.includes(token)))
        if (missing.length > 0) {
          failures.push({
            name: file,
            line: 0,
            detail: `[SK-14] ${label} 是「${policy.label}」,但它的调用点少了**必带参数**:`
              + `${missing.map(token => `\`${token}\``).join(', ')}`
              + `\n  该类别${argvPolicy.describe}`
              + '\n  ⇒ 第十二轮红队 R12-D-04 实测:删掉 `--require-clean` 之后 `check-workflows` EXIT=0,'
              + '而"工作树↔HEAD 锚定"当场从 CI 硬判据降级成本地告警(J1 复审 N2 ② 的同一形态)。',
          })
        }
      }
      // ④ `run` 被吞码 —— 谓词与白名单整份复用 [SK-7a](不另发明一套语法)。
      if (NON_POSIX_SHELLS.test(item.shell)) continue
      const lines = step.run.split('\n').map(stripLineComment)
      for (const line of lines) {
        const skeleton = shellSkeleton(line)
        if (skeleton.trim() === '') continue
        const hit = SWALLOW_PATTERNS.find(pattern => pattern.re.test(skeleton))
        if (hit === undefined || !isSilentSuccessTail(skeleton)) continue
        const signature = normalizeStatement(line)
        // 与 [SK-7a] 共用白名单(登记过的那句话不重复报);这里只对"钉住的步骤"再报一次
        // **未被登记**的吞码 —— 顺序上 SK-7a 先跑,所以真实形态不会两处都红。
        if (allowlist.lookup(file, signature) !== undefined) continue
        failures.push({
          name: file,
          line: 0,
          detail: `[SK-14] ${label} 是「${policy.label}」,但它的 run 吞掉了退出码(${hit.form}):${signature}`
            + '\n  ⇒ 被钉住的判据步骤永远退出 0 = 判据静默失效(与 [SK-7a] 同一份谓词与白名单:'
            + '这里只是把"这一步必须真的能失败"写成对判据步骤的显式下限)。',
        })
      }
      // ⑤ 所在 job 被常量假 `if:` 跳过 ⇒ 步骤一样不跑。
      if (isConstantFalseIf(item.job?.if)) {
        failures.push({
          name: file,
          line: 0,
          detail: `[SK-14] ${label} 是「${policy.label}」,但它所在的 job ${item.jobId} 的 \`if:\` 是常量假`
            + `(${JSON.stringify(item.job.if)})⇒ job 被跳过,里面的判据步骤一样不跑。`,
        })
      }
      // ⑥ **步骤体**必须无条件失败(只对登记了 `requireUnconditionalFailure` 的类别生效;
      //    第六轮独立复审 V2 边界③)。判据与诚实边界见 `pinnedStepFailureTailProblem`。
      //    与 ④ 同一取舍:非 POSIX shell 静态求不出 ⇒ 交给 `run` 的语法检查,不在这里判。
      if (policy.requireUnconditionalFailure === true && !NON_POSIX_SHELLS.test(item.shell)) {
        const problem = pinnedStepFailureTailProblem(script)
        if (problem !== null) {
          failures.push({
            name: file,
            line: 0,
            detail: `[SK-14] ${label} 是「${policy.label}」,但它的**步骤体**不可能可靠地失败:${problem}`
              + '\n  ⇒ 这一步是"根守卫失败 ⇒ 必需的 Gate 检查也红"的**唯一**链路'
              + '(`gate-guards` 自己不在分支保护的必需检查里)。`if:` 逐字合法、`run` 里也还留着'
              + ' `exit 1` 与 `needs.*.result` 子串 —— 但那两个子串现在只是文本:把步骤体换成'
              + '结构上不可能失败的惰性形态(条件永假 + 块级收尾 + 一句 `echo`),旧判据下门禁照样全绿。'
              + '\n  该步骤必须以**非零 `exit` 的失败收尾**结束。允许的收尾:'
              + '\n    · `exit <非零>`(无条件);'
              + '\n    · `<命令> || exit <非零>` / `<命令> && exit <非零>` / `<命令>; exit <非零>`'
              + '(本仓既有的正常 fail-loud 写法);'
              + '\n    · `<命令> && { …; exit <非零>; }` 这类块内收尾同样算。'
              + '\n  不接受**块级收尾**(`fi`/`done`/`esac`/`}`:块里的 `exit` 可能永不执行 —— '
              + '这正是被掏空的形态)与任何零退出码出口(`exit 0` / 裸 `exit`)。',
          })
        }
      }
    }
  }
  if (observed.length > 0) notes.push(`[SK-14] 可执行性检查覆盖 ${observed.length} 个被钉住的判据步骤(${observed.join(', ')})`)
  // 除了打印,还要把**命中的策略 id** 交出去:main() 用它做覆盖下限(第八轮审计
  // R8-C-1 ②—— 此前少识别一个被钉步骤是完全静默的)。
  return { failures, policies: observed.map(entry => entry.split('@')[0]) }
}

/**
 * [SK-19] **YAML 合并键 `<<`** 让判据看不见被展开的内容（第十轮审计 C-05，本轮修复）。
 *
 * 现场：`yaml` 解析器默认**不展开 merge key**（YAML 1.1 的 `<<`）—— `env: { <<: *base }`
 * 解析成字面键 `<<`，其值是别名指向的 map；`jobs.<id>: { <<: *jobbase }` 同理。于是
 * **判据面上那些键一个都不出现**：
 *
 * ```yaml
 * x-job: &jobbase
 *   env:
 *     NODE_OPTIONS: "--import=data:text/javascript,process.on('exit',()=>{process.exitCode=0})"
 * jobs:
 *   gate-guards:
 *     <<: *jobbase            # ⇒ 解析后 jobs['gate-guards'].env === undefined
 * ```
 *
 * `jobs.<id>.env` 是 [SK-17④] 的判据入口 —— 合并之后那一层**空着**（计数 0、层层"已检查"），
 * 而 Actions 在运行期是**会**展开 merge key 的（YAML 1.1，Actions 的解析器支持 `<<`）：
 * 判据看到的与 runner 执行的不是同一份语义，这就是"三层 `env:` 对判据隐形"。
 * 同一手法还能藏 `steps:`（那会让"哪些步骤被钉住"整个判据失效）、`container:`、`with:`。
 *
 * 判据（fail-closed）：**任何** job 块 / 步骤块 / `env:` / `container:` / `defaults:` /
 * `with:` / workflow 顶层上出现 `<<` 键 ⇒ 红。
 *
 * 覆盖面（W1 复审 N2 的修复）：workflow **顶层**的 `defaults:` 与 `defaults.run:` 也在
 * 枚举里 —— 顶层 `defaults.run` **一次作用于所有 job**，它的合并键此前不在扫描面上
 * （顶层 `x: &s {shell: bash}` + `defaults: {run: {<<: *s}}` ⇒ EXIT=0）。两个入口
 * （workflow 级 / job 级）必须同扫：只堵一个等于没堵（与 SK-18 的 cwd 两入口同族）。
 *
 * 为什么按"任何 job"而不是"被钉 job"：
 * 合并键可以**藏掉 `steps:` 本身**（那正是"这一步算不算被钉"的输入）—— 判据读不懂它展开了
 * 什么，"读不懂 ⇒ 拒绝"是唯一与 [SK-17] 其余各条一致的取向。确需共享片段时把键**显式写出来**
 * （或在 `check-workflows.mjs` 里显式展开后再喂给判据），不要用 merge key。
 *
 * @param file - workflow 文件名。
 * @param document - `parseYaml` 的结果。
 * @returns 失败项数组（空 = 该文件没有任何合并键）。
 */
function checkYamlMergeKeys(file, document) {
  const failures = []
  const isMap = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  const hits = []
  const scan = (node, path) => {
    if (!isMap(node)) return
    if (Object.hasOwn(node, '<<')) hits.push({ path, value: node['<<'] })
  }
  scan(document, 'workflow 顶层')
  scan(document?.env, 'workflow 顶层 `env:`')
  // workflow 级 `defaults:` / `defaults.run:`（2026-09-25 第十轮复审 W1 的 N2）。
  //
  // 现场（W1 探针实测）：顶层 `x-shell: &s {shell: bash}` + `defaults: {run: {<<: *s}}`
  // ⇒ 旧覆盖面**不含** `document.defaults` ⇒ `check-workflows` EXIT=0。而 Actions 在运行期
  // 会展开这个合并键，且 workflow 级 `defaults.run` 一次作用于**所有 job** —— 与 N1
  // （顶层 `defaults.run.working-directory`）组合起来可以同时藏掉"执行目录"与 `defaults`
  // 下的其它键。判据与 job 级同族：出现合并键即红（读不懂展开了什么 ⇒ 拒绝）。
  scan(document?.defaults, 'workflow 顶层 `defaults:`')
  scan(document?.defaults?.run, 'workflow 顶层 `defaults.run:`')
  const workflowDefaultsBlocks = (isMap(document?.defaults) ? 1 : 0) + (isMap(document?.defaults?.run) ? 1 : 0)
  const jobs = isMap(document?.jobs) ? document.jobs : {}
  let stepBlocks = 0
  for (const [jobId, job] of Object.entries(jobs)) {
    scan(job, `jobs.${jobId}`)
    scan(job?.env, `jobs.${jobId}.env`)
    scan(job?.container, `jobs.${jobId}.container`)
    scan(job?.container?.env, `jobs.${jobId}.container.env`)
    scan(job?.defaults, `jobs.${jobId}.defaults`)
    scan(job?.defaults?.run, `jobs.${jobId}.defaults.run`)
    if (!Array.isArray(job?.steps)) continue
    job.steps.forEach((step, index) => {
      stepBlocks += 1
      scan(step, `jobs.${jobId}.steps[${index}]`)
      scan(step?.env, `jobs.${jobId}.steps[${index}].env`)
      scan(step?.with, `jobs.${jobId}.steps[${index}].with`)
    })
  }
  for (const hit of hits) {
    failures.push({
      name: file,
      line: 0,
      detail: `[SK-19] \`${hit.path}\` 上出现了 YAML **合并键** \`<<\`（值：`
        + `${isMap(hit.value) ? `别名的 map（${Object.keys(hit.value).join(', ') || '空'}）` : JSON.stringify(hit.value ?? null)}）。`
        + '\n  ⇒ 解析器（`yaml`）默认**不展开** merge key：它只留下一个字面键 `<<`，'
        + '而被合并进来的键在判据面（`env:` 各层 / `container:` / `steps:` / `with:` / `defaults:`）上'
        + '**一个都不出现**；Actions 在运行期却会展开它 ⇒ 判据看到的与 runner 执行的不是同一份语义'
        + '（第十轮审计 C-05：三层 `env:` 因此对判据隐形，而锚点/别名的**非**合并形态是可见的）。'
        + '\n  ⇒ 请把这些键**显式写出来**（共享片段用锚点+别名时不要用 `<<`），'
        + '不要指望判据去展开它 —— "读不懂展开了什么"一律按未登记处理是 [SK-17]/[SK-19] 的共同取向。',
    })
  }
  return { failures, stepBlocks, workflowDefaultsBlocks, hits: hits.length }
}

/**
 * [SK-17] 的实现(判据与现场见常量区 `PINNED_ENV_ALLOWED_KEYS` 的注释)。
 *
 * 判据面共六层,**全部只读 YAML 文档 + `run` 文本**(不执行任何东西),层清单的唯一真源是
 * `PINNED_ENV_LAYER_REGISTRY` —— 函数逐层产出 `{id, detail}` 交给 `main()` 与通过行,
 * 所以"声称检查了哪几层"与"代码真的枚举了哪几层"不可能各写一份(C-02 的现场正是两者漂移):
 *   ① workflow 顶层 `env:`   —— Actions 注入**每个 job 的每个 step**;
 *   ② job 级 `env:`          —— 注入该 job 的每个 step;
 *   ③ `jobs.<id>.container.env` —— **Actions 的第四层**(该 job 所有 step 的容器环境变量);
 *   ④ step 级 `env:`         —— 只注入这一步(根守卫 job 里连 `uses:` 步骤一起查);
 *   ⑤ `$GITHUB_ENV`/`$GITHUB_PATH` —— 同 job 内、位置在被钉步骤**之前**的步骤写进去的,
 *      会被后面的步骤继承(命令里只剩 `$VAR`,上面四层里什么都没有);
 *   ⑥ 被钉步骤**自己的步骤体**里的 `export`/前缀赋值 —— 命令文本里看得见,上面五层都看不见。
 *
 * 判据读的是 `executableScript`(去注释)与词级归一(删空引号对 / 去反斜杠转义)后的文本 ——
 * 与 [SK-16] 同一套口径:注释里的历史写法不算,而 `NODE_""OPTIONS` 这种"拆开写的同一个键"
 * 必须算(它写进 `$GITHUB_ENV` 之后就是 `NODE_OPTIONS` 本身)。
 *
 * @param file - workflow 文件名。
 * @param document - parseYaml 的结果。
 * @param blocks - extractRunBlocks 的结果(供 shellSteps 解析有效 shell / 行号 / 下标)。
 * @param notes - 提示收集器。
 * @param context - `{ rootDir, containerImages }`:`rootDir` = 本地 `uses:` 的解析根
 *   (缺省 = 仓库根;自检注入合成树);`containerImages` = 被钉 job 的容器镜像登记表
 *   (缺省 = `PINNED_JOB_CONTAINER_REGISTRY`;自检用它单独放行镜像、只留 `container.env`
 *   的键判定 —— 第十轮复审 V1 的 P3-D3:两个分支必须在**两个样本**上各自可红)。
 * @returns `{ failures, layers, uses }`(`layers` = 逐层枚举结果,供通过行与层清单对账;
 *   `uses` = 被钉单元里实际用到的 `uses:` 取值,供登记表的死条目对账)。
 */
function checkPinnedStepEnvironment(file, document, blocks, notes, context = {}) {
  const failures = []
  /** 命中同一登记项的重复报告压掉(同一处 env 只报一次)。 */
  const reported = new Set()
  const reportOnce = (dedupeKey, detail) => {
    if (reported.has(dedupeKey)) return
    reported.add(dedupeKey)
    failures.push({ name: file, line: 0, detail })
  }
  /**
   * 逐层登记(唯一真源 = `PINNED_ENV_LAYER_REGISTRY`)。
   *
   * `visited` 是**这一层真的被枚举过**的证据 —— 只有跑到的层才进 `layers()`,所以
   * "把某一层的枚举删掉"会让它的 id 从结果里消失,`main()` 的覆盖面双向对账当场红。
   * (如果 `layers()` 无条件照抄登记表,那条对账就是恒真的 —— 第十轮修复过程里踩到过:
   * 删掉 container 枚举之后 `layers()` 照样报 6 层。)
   */
  const layerCounts = new Map(PINNED_ENV_LAYER_REGISTRY.map(layer => [layer.id, 0]))
  const layerVisited = new Set()
  const markLayer = (id, increment = 0) => {
    layerVisited.add(id)
    layerCounts.set(id, (layerCounts.get(id) ?? 0) + increment)
  }
  const layers = () => PINNED_ENV_LAYER_REGISTRY
    .filter(layer => layerVisited.has(layer.id))
    .map(layer => ({ id: layer.id, label: layer.label, count: layerCounts.get(layer.id) ?? 0 }))

  const jobs = typeof document?.jobs === 'object' && document.jobs !== null ? document.jobs : {}
  const stepsOf = jobId => (Array.isArray(jobs[jobId]?.steps) ? jobs[jobId].steps : [])
  const unitLabel = unit => `job ${unit.jobId} 的 step「${unit.label}」`

  // ① 根守卫 job 的**结构**识别:与 [SK-9②] 同一份口径(谁的 run 里有 `check-root-guards.mjs`)。
  //    刻意不写死 job 名 —— 改名/搬家不会让这条判据静默失效(那正是 R8-C-1 的教训)。
  const guardJobIds = new Set(Object.entries(jobs)
    .filter(([, job]) => (Array.isArray(job?.steps) ? job.steps : [])
      .some(step => typeof step?.run === 'string'
        && commandPositionArgvs(executableScript(step.run), DOCS_ONLY_GUARD_RUNNER).length > 0))
    .map(([jobId]) => jobId))

  // ② 被钉住的判定单元 = [SK-14] 命中的判据步骤 ∪ 根守卫 job 的**每一步**。
  //    后者是"永不跳过"的那个作业:它载荷的是根守卫本身,任何一层的 env 都在守卫链上
  //    (形态 A/B 的现场正是"给 `gate-guards` 加一行 `env:`")。
  const units = []
  for (const item of shellSteps(document, blocks)) {
    const policy = PINNED_STEP_POLICIES.find(entry => entry.match(executableScript(item.step.run), item))
    const reason = policy !== undefined
      ? `[SK-14] 的 \`${policy.id}\`(被钉住的判据步骤)`
      : (guardJobIds.has(item.jobId) ? '根守卫 job(永不跳过)的步骤' : null)
    if (reason === null) continue
    units.push({ jobId: item.jobId, step: item.step, index: item.index, label: item.label, reason })
  }
  // 根守卫 job 里**没有 `run`** 的步骤(`uses:` 之类的)不进 `shellSteps()` 的枚举,但它们
  // 同样在守卫链上(给 `actions/checkout` 加一行 `env:` 一样是往这个 job 的环境里塞东西)。
  for (const jobId of guardJobIds) {
    stepsOf(jobId).forEach((step, index) => {
      if (typeof step?.run === 'string') return
      units.push({ jobId, step, index, label: stepName(step, index), reason: '根守卫 job(永不跳过)的步骤' })
    })
  }
  if (units.length === 0) return { failures, layers: [], uses: [], usesWith: [] }

  /** 所有命中项共用的"为什么"尾注(把现场与修法一次说清)。 */
  const tail = (hit, where) =>
    `\n  为什么必须拒:${hit.why}。`
    + '\n  ⇒ 判据是**白名单**:被钉单元上的每一个 env 键都必须登记在 `PINNED_ENV_ALLOWED_KEYS`'
    + '(本文件内、逐条带理由,可评审的 diff),未登记即红 —— 逐个补黑名单追不上下一层'
    + '(第十轮审计 C-01:`COREPACK_HOME` 不在第九轮的禁用表里 ⇒ 16 个根守卫的**被执行体**'
    + '整体被换成 `process.exit(0)`,判据侧与执行侧同时绿灯)。'
    + `\n  ⇒ ${where}`

  // ③ workflow 顶层 `env:`(注入每个 job 的每个 step)。
  const workflowEnvKeys = envEntries(document?.env)
  markLayer('workflow-env', workflowEnvKeys.length)
  for (const [key] of workflowEnvKeys) {
    const hit = pinnedEnvKeyProblem(key)
    if (hit === null) continue
    const sample = units.slice(0, 3).map(unitLabel).join('、')
    reportOnce(`workflow:${hit.raw}`, `[SK-17] workflow **顶层** \`env:\` 里的 \`${hit.raw}\` `
      + `会注入**每一个 job 的每一个 step**,包括本 workflow 的 ${units.length} 个被钉住的判定单元`
      + `(例如 ${sample}${units.length > 3 ? ' 等' : ''})。`
      + tail(hit, '这类键只能出现在**非判据步骤**上;合法用途请在 `PINNED_ENV_ALLOWED_KEYS` 里'
        + '登记该键(写清它为什么不会改变判据的结论),不要用"某个键看起来人畜无害"当豁免。'))
  }

  const pinnedJobIds = [...new Set(units.map(unit => unit.jobId))]

  // ③b **`defaults.run.shell` 走登记制**（第十二轮红队 C-P0-1）。
  //     `shell:` 是"谁来解释这段脚本"的入口：step 级 `shell:` 由 [SK-14⑦] 的整串登记看着，
  //     但 **workflow 顶层** `defaults.run.shell` 此前不在判据面里（`shellSteps()` 没读它 ⇒
  //     `item.shell` 回落成 `bash`，runner 上跑的却是别的解释器），**job 级** `defaults.run.shell`
  //     也只在"该 job 里有被钉步骤"时才被 [SK-14⑦] 顺带看见。这里两个入口一起收：
  //     登记表 `PINNED_DEFAULT_SHELL_REGISTRY` 为空 = **禁止声明**（要声明必须先登记并写理由）。
  {
    const declaredDefaults = []
    if (document?.defaults?.run?.shell !== undefined && document.defaults.run.shell !== null) {
      declaredDefaults.push({ scope: 'workflow', job: null, shell: document.defaults.run.shell })
    }
    for (const jobId of pinnedJobIds) {
      const jobShell = jobs[jobId]?.defaults?.run?.shell
      if (jobShell !== undefined && jobShell !== null) {
        declaredDefaults.push({ scope: 'job', job: jobId, shell: jobShell })
      }
    }
    for (const entry of declaredDefaults) {
      const value = typeof entry.shell === 'string' ? entry.shell : String(entry.shell)
      // 与 [SK-14⑦] 同一份"这个 shell 认不认识"的口径：`bash` / `sh` / 把 `{0}` 当脚本文件的模板
      // **不改变解释器**（它们就是缺省语义），因此不需要登记；只有"换成别的解释器"才要登记
      // ——否则每条显式写 `shell: bash` 的合法 workflow 都会被迫进登记表（那是假红）。
      if (pinnedShellProblem(value) === null) continue
      const registered = PINNED_DEFAULT_SHELL_REGISTRY.some(item => item.scope === entry.scope
        && (item.job ?? null) === entry.job && item.shell === value)
      if (registered) continue
      const where = entry.scope === 'workflow'
        ? '**workflow 顶层** `defaults.run.shell`'
        : `job ${entry.job} 的 \`defaults.run.shell\``
      reportOnce(`default-shell:${entry.scope}:${entry.job ?? ''}:${value}`, `[SK-17] ${where} = `
        + `\`${value}\` —— 它作用于该范围内**每一个 step**,而"命令位 / argv / 步骤体"三条判据`
        + '都建立在"这段脚本由 bash 解释"之上。[SK-14⑦] 只登记 **step 级** `shell:`，'
        + 'workflow 顶层的这一份此前根本不在解析链里(`item.shell` 静默回落成 `bash`)。'
        + '\n  ⇒ 与 cwd（`defaults.run.working-directory`）与 `env:` 同族（"执行体由谁提供"）:'
        + '走**登记制**,要在被钉单元上声明必须先登记进 `PINNED_DEFAULT_SHELL_REGISTRY`'
        + '`{ scope, job, shell, why }`（当前为空 = 未登记即红）。')
    }
  }

  // ④ job 级 `env:`(注入该 job 的每个 step)。
  for (const jobId of pinnedJobIds) {
    const jobEnvKeys = envEntries(jobs[jobId]?.env)
    markLayer('job-env', jobEnvKeys.length)
    for (const [key] of jobEnvKeys) {
      const hit = pinnedEnvKeyProblem(key)
      if (hit === null) continue
      const labels = units.filter(unit => unit.jobId === jobId).map(unit => `「${unit.label}」`)
      reportOnce(`job:${jobId}:${hit.raw}`, `[SK-17] job ${jobId} 的 **job 级** \`env:\` 里的 `
        + `\`${hit.raw}\` 会注入该 job 的每一个 step,包括它的被钉住判定单元:`
        + `${labels.slice(0, 4).join('、')}${labels.length > 4 ? ` 等 ${labels.length} 个` : ''}。`
        + tail(hit, 'job 级 `env:` 是形态 A/B/C 最省事的挂点:一个 job 加两行、命令一字不改;'
          + '而"根守卫失败 ⇒ 必需的 Gate 检查也红"这条唯一链路就挂在它上面。'))
    }
  }

  // ⑤ **第四层**:`jobs.<id>.container.env`(Actions 文档:"在 job 容器内设置环境变量")。
  //    注入能力与 job 级 `env:` **完全等价**,但第九轮的枚举里没有这个词
  //    (`grep -c container scripts/check-workflows.mjs` = 0)⇒ 同一个键在 job 级被抓、
  //    在 container 级静默通过(第十轮审计 C-02 / MAINCTL-2 的判别性对照实测)。
  for (const jobId of pinnedJobIds) {
    const container = jobs[jobId]?.container
    // 这一层"被读过"与"有没有人写"是两件事:没有容器也要记一笔(否则覆盖面会退化成
    // "当前恰好没人用这一层" —— 那正是 C-02 里"声称三层均已检查"的同族形态)。
    markLayer('container-env', envEntries(typeof container === 'object' ? container.env : undefined).length)
    if (container === undefined || container === null) continue
    const image = typeof container === 'string' ? container : container.image
    const containerImages = context.containerImages ?? PINNED_JOB_CONTAINER_REGISTRY
    const registered = containerImages.some(entry => entry.image === image)
    if (!registered) {
      reportOnce(`container-image:${jobId}`, `[SK-17] job ${jobId} 有被钉住的判定单元,但它声明了 `
        + `\`container:\`(image = ${JSON.stringify(image ?? null)})—— 这一步不再跑在 runner 上,`
        + '而是跑在那面镜像里:判据步骤赖以成立的解释器/工具链全部由这面镜像提供。'
        + '\n  ⇒ `container:` 与 `env:` 是同一族("执行体由谁提供"),所以它走**登记制**:'
        + '要在被钉 job 上用容器,必须先在 `PINNED_JOB_CONTAINER_REGISTRY` 里逐字登记 `image`'
        + '并写明"这面镜像为什么可以承担判据步骤"(当前登记表为空)。')
    }
    for (const [key] of envEntries(typeof container === 'object' ? container.env : undefined)) {
      const hit = pinnedEnvKeyProblem(key)
      if (hit === null) continue
      const labels = units.filter(unit => unit.jobId === jobId).map(unit => `「${unit.label}」`)
      reportOnce(`container:${jobId}:${hit.raw}`, `[SK-17] job ${jobId} 的 `
        + `**\`container.env\`(Actions 的第四层)** 里的 \`${hit.raw}\` 会注入该 job 容器里的`
        + `每一个 step,包括它的被钉住判定单元:`
        + `${labels.slice(0, 4).join('、')}${labels.length > 4 ? ` 等 ${labels.length} 个` : ''}。`
        + tail(hit, '这一层与 job 级 `env:` 注入能力完全等价,但第九轮的枚举漏了它 —— '
          + '同一个键写在 job 级被抓、写在这里静默通过,而通过行还照样打印"三层 `env:` 均已检查"。'))
    }
  }

  // ⑥ step 级 `env:`(只注入这一步)。
  for (const unit of units) {
    const stepEnvKeys = envEntries(unit.step?.env)
    markLayer('step-env', stepEnvKeys.length)
    for (const [key] of stepEnvKeys) {
      const hit = pinnedEnvKeyProblem(key)
      if (hit === null) continue
      reportOnce(`step:${unit.jobId}#${unit.index}:${hit.raw}`, `[SK-17] ${unitLabel(unit)} 是`
        + `${unit.reason},但它的 **step 级** \`env:\` 里有 \`${hit.raw}\`。`
        + tail(hit, '这一步的退出码就是判据结论;给它挂一个改解释器行为的键,等价于把判据的结论'
          + '改成"恒绿",而 `run` 文本一个字都没变。'))
    }
  }

  // ⑦ `uses:` 的**执行体来路**(第十轮审计 C-03 / MAINCTL-3):被钉单元里的每一个 `uses:`
  //    步骤要么是能在仓内解析到的本地路径(其内容被 `checkCompositeActionTree()` 用同一套
  //    判据覆盖),要么逐字登记在 `PINNED_USES_REGISTRY` 里。第九轮把 `uses:` 步算进了
  //    "被钉住的判定单元"(单元数 10 → 11),却**从不读它的内容** ⇒ 本地复合 action 里的
  //    `echo NODE_OPTIONS=… >> $GITHUB_ENV` 静默通过。
  const usedUses = []
  const usedUsesWith = new Set()
  const usesWithCheck = (label, reason, uses, withValue, where) => {
    if (typeof uses === 'string') usedUses.push(uses)
    const problem = pinnedUsesProblem(uses, context.rootDir ?? root)
    if (problem !== null) {
      reportOnce(`uses:${where}`, `[SK-17] ${label} 是`
        + `${reason},但它通过 \`uses: ${typeof uses === 'string' ? uses : JSON.stringify(uses)}\` `
        + '把执行委托出去,而这个委派目标不在判据的读取面内。'
        + `\n  ${problem}`)
      // 委派目标都读不懂 ⇒ 它的 `with:` 更无从判起(不重复报,免得诊断被两行同样的病根刷屏)。
      return
    }
    if (typeof uses === 'string') {
      for (const key of envEntries(withValue).map(([name]) => name)) {
        usedUsesWith.add(`${uses.trim()}\u0000${key}`)
      }
    }
    const withProblems = pinnedUsesWithProblems(uses, withValue, context.rootDir ?? root)
    if (withProblems.length === 0) return
    reportOnce(`with:${where}`, `[SK-17] ${label} 是${reason},但它的 \`with:\` 输入不在判据面内。`
      + `\n  ${withProblems.join('\n  ')}`)
  }
  for (const unit of units) {
    const uses = unit.step?.uses
    if (uses === undefined || uses === null) continue
    usesWithCheck(unitLabel(unit), unit.reason, uses, unit.step?.with, `${unit.jobId}#${unit.index}`)
  }
  // ⑦b **同族的第二个入口**:跑全量门禁的那个 job 的 `actions/checkout` —— 它决定"门禁看到的
  //     是哪一棵树"(口径与 [SK-8b] 一致:`ROOT_GATE_INVOCATION` + 参数向量为空)。
  //     只对**已登记在 `PINNED_USES_WITH_REGISTRY` 里的 action** 判:其余步骤(如
  //     `upload-artifact`)不是被钉单元,`with:` 不在本判据的作用域内(判了就是假红)。
  for (const unit of units) {
    const jobSteps = stepsOf(unit.jobId)
    const runsFullGate = jobSteps.some(step => typeof step?.run === 'string'
      && rootGateInvocations(stripShellRedirections(executableScript(step.run)))
        .some(hit => hit.mode === 'check' && hit.args.trim() === ''))
    if (!runsFullGate) continue
    jobSteps.forEach((step, index) => {
      const uses = typeof step?.uses === 'string' ? step.uses.trim() : ''
      if (!PINNED_USES_WITH_REGISTRY.some(entry => entry.uses === uses)) return
      usesWithCheck(`job ${unit.jobId} 的 step「${stepName(step, index)}」`,
        `跑全量门禁的 job(它检出的那棵树就是门禁看到的树)`, step.uses, step?.with,
        `${unit.jobId}#gate-tree#${index}`)
    })
  }

  // ⑦c 被钉 job 的 `runs-on`(第十一轮审计 P2-1):与 `container:` 同层 —— "这一步跑在谁的机器上"。
  //     登记制,fail-closed:未登记 / 列表形态 / 表达式 / 非字符串一律红。
  for (const jobId of pinnedJobIds) {
    const raw = jobs[jobId]?.['runs-on']
    const value = typeof raw === 'string' ? raw.trim() : null
    const runsOnRegistry = context.jobRunsOn ?? PINNED_JOB_RUNS_ON_REGISTRY
    const registered = runsOnRegistry.find(entry => entry.job === jobId)
    const shape = value === null
      ? (raw === undefined ? '缺失' : `非字符串(${JSON.stringify(raw)})`)
      : value
    if (registered !== undefined && value !== null && registered.runsOn === value) continue
    reportOnce(`runs-on:${jobId}`, `[SK-17] job ${jobId} 有被钉住的判定单元,但它的 \`runs-on\` `
      + `是 ${shape}${registered === undefined
        ? '（这个 job **不在** `PINNED_JOB_RUNS_ON_REGISTRY` 里）'
        : `（该 job 的登记值是 \`${registered.runsOn}\`）`}`
      + '\n  ⇒ `runs-on` 与 `container:` 是同一层("判据跑在谁的机器上"):换成 `self-hosted`、'
      + '换一个镜像标签、或写成列表形态,被钉步骤赖以成立的工具链/python/内核版本就全由另一方提供,'
      + '而 argv、步骤体、`env:`、`working-directory` 一字未改。'
      + '\n  ⇒ 判据是登记制:要在被钉 job 上用别的 runner,先把它逐字登记进 `PINNED_JOB_RUNS_ON_REGISTRY`'
      + '并写明"这台机器为什么可以承担判据步骤"。')
  }

  // ⑧ `$GITHUB_ENV` / `$GITHUB_PATH`:同 job 内、位置在被钉步骤**之前**的步骤写进去的,
  //    会被后面的步骤继承(跨 job 不生效 —— 每个 job 是独立 runner)。
  const writers = new Map()
  for (const unit of units) {
    stepsOf(unit.jobId).forEach((step, index) => {
      if (index >= unit.index || typeof step?.run !== 'string') return
      const script = executableScript(step.run)
      if (!GITHUB_ENV_APPEND.test(script) && !GITHUB_PATH_APPEND.test(script)) return
      writers.set(`${unit.jobId}#${index}`, { jobId: unit.jobId, index, step, script })
    })
  }
  markLayer('github-env-write', writers.size)
  for (const writer of writers.values()) {
    const targets = units.filter(unit => unit.jobId === writer.jobId && unit.index > writer.index)
    if (targets.length === 0) continue
    const writerLabel = `job ${writer.jobId} 的 step「${stepName(writer.step, writer.index)}」`
    const inherited = `${targets.slice(0, 3).map(unitLabel).join('、')}`
      + `${targets.length > 3 ? ` 等 ${targets.length} 个被钉单元` : ''}`
    // ⑧a `$GITHUB_PATH`:追加目录 = PATH 覆写(与 `PATH` 键同级)。
    if (GITHUB_PATH_APPEND.test(writer.script)) {
      reportOnce(`ghpath:${writer.jobId}#${writer.index}`, `[SK-17] ${writerLabel} 往 \`$GITHUB_PATH\` `
        + `追加了目录,而它后面还有被钉住的判定单元会继承这个 PATH(${inherited})。`
        + '\n  ⇒ `$GITHUB_PATH` 是 Actions 里"改后续步骤 PATH"的正式通道,与 `env: PATH:` 等价:'
        + '后续步骤里的 `node`/`bash` 可以解析到另一个二进制,而命令名一字未改。'
        + tail({ why: 'PATH 决定 `node`/`bash` 解析到哪个二进制' },
          '守卫 job / 判据步骤所在 job 里不要用 `$GITHUB_PATH`;需要工具路径请在**非判据步骤**上处理。'))
    }
    // ⑧b `$GITHUB_ENV`:写入的键名未登记 ⇒ 后续步骤继承它。
    //     词级归一(与 [SK-16] 的 `advisoryFlagShape` 同一手法):`NODE_""OPTIONS=…` 写进
    //     文件后就是 `NODE_OPTIONS=…`。
    //     只认 `$GITHUB_ENV`:`$GITHUB_OUTPUT` 写的是 step output(**不注入进程环境**),
    //     把输出名也拉进白名单会变成一台假阳性机器(`code=` / `version=` 都是正常写法)。
    if (GITHUB_ENV_APPEND.test(writer.script)) {
      const normalized = advisoryFlagShape(writer.script)
      for (const match of normalized.matchAll(GITHUB_ENV_KEY_ASSIGNMENT)) {
        const hit = pinnedEnvKeyProblem(match[1])
        if (hit === null) continue
        reportOnce(`ghenv:${writer.jobId}#${writer.index}:${hit.raw}`, `[SK-17] ${writerLabel} 往 `
          + `\`$GITHUB_ENV\` 写入了 \`${hit.raw}\`,而它后面还有被钉住的判定单元会继承它(${inherited})。`
          + tail(hit, '这类注入在 `run` 文本里只留一个 `$VAR`,四层 `env:` 里什么都没有 ⇒'
            + '判据面必须把 `$GITHUB_ENV` 的**键名**也算上(第八轮只扫了它的**取值**层面:'
            + '`--allow-advisory` 那个开关;第十轮 C-01 的 `COREPACK_HOME` 正是从这里进来的)。'))
      }
    }
  }

  // ⑨ **被钉步骤自己的步骤体**(第十轮审计 D-03):`export NODE_OPTIONS=…` / 前缀赋值
  //    (`NODE_OPTIONS=… node …`)写出的键。⑤–⑧ 全都在"env 声明"这一侧,命令文本里
  //    自己 export 出来的键一个都看不见 —— 审计实测:守卫步里加一行
  //    `export NODE_OPTIONS="--import=data:text/javascript,process.on('exit',()=>{process.exitCode=0})"`
  //    之后判据 EXIT=0,而同一条命令真跑时守卫打印「1 项未通过」却 EXIT=0。
  for (const unit of units) {
    if (typeof unit.step?.run !== 'string') continue
    const assignments = shellEnvironmentAssignments(unit.step.run)
    markLayer('step-body-assignment', assignments.length)
    for (const assignment of assignments) {
      // [SK-20] 的**唯一** PATH 例外（理由见上面那条同名判断）。
      if (assignment.name === 'PATH' && isFrozenLauncherPathExport(assignment.segment)) continue
      const hit = assignment.unparsable === true
        ? {
          raw: '（读不懂的片段）',
          why: '这段 shell 里出现了 `export`/`declare`/`unset`/赋值形态,但分词失败(引号不配对等)⇒ '
            + '判据读不懂它到底写出了/抹掉了哪个键,按"未登记"处理',
        }
        : (assignment.kind === 'unset'
          ? pinnedUnsetKeyProblem(assignment.name)
          : pinnedEnvKeyProblem(assignment.name))
      if (hit === null) continue
      reportOnce(`body:${unit.jobId}#${unit.index}:${assignment.name ?? assignment.segment}`, `[SK-17] `
        + `${unitLabel(unit)} 是${unit.reason},而它的**步骤体自己**用 \`${assignment.form}\` 写出了 `
        + `\`${assignment.name ?? assignment.segment}\`${assignment.unparsable === true ? '(分词失败)' : ''}。`
        + tail(hit, '步骤体里的 `export`/前缀赋值把键直接交给这一步的子进程(`node`/`corepack` 都在里面),'
          + '而它在 YAML 的 `env:` 里一个字都不出现 ⇒ 四层 `env:` 判据全都看不见它;'
          + '**`unset`/`env -u` 是同一层的反向写法**(J1 复审 N2):删除只会让下游判据降级,不会报错。'
          + '要在这个键上跑判据,先在 `PINNED_ENV_ALLOWED_KEYS`(写入)/`PINNED_STEP_UNSET_ALLOWED_KEYS`(清除)'
          + '里登记;第二道收口在 `scripts/check-root-guards.mjs`(它清洗交给守卫子进程的环境)。'))
    }
  }

  // ⑩ **执行目录**（第十轮审计 C-04，本轮修复；W1 复审 N1 补齐**第三个入口**）：
  //    workflow 级 `defaults.run.working-directory` / job 级 `defaults.run.working-directory`
  //    / 步骤级 `working-directory` —— "命令在哪个目录里被解析"此前**不在判据面内**。
  //    与 `env:` 同族：argv 一字未改，脚本/`package.json`/`.yarnrc.yml` 却换成了别处的
  //    （审计方实测：给 `gate-guards` 加 `defaults.run.working-directory: /tmp/decoy` ⇒ EXIT=0）。
  //    登记制例外只认**逐字**匹配（见 `PINNED_JOB_WORKING_DIRECTORY_REGISTRY` 的头注释）。
  //
  //    ⑩a **workflow 级**（P2）：`defaults` 在 Actions 里两个层级都合法，顶层那份作用于
  //    **所有 job**（W1 实测：顶层写同一个键 ⇒ 旧判据 EXIT=0，同机理同收益）。
  {
    const runDefaults = document?.defaults?.run
    const value = runDefaults !== null && typeof runDefaults === 'object'
      && Object.hasOwn(runDefaults, 'working-directory')
      ? runDefaults['working-directory']
      : undefined
    const declared = value !== undefined
    // 刻意**不**进 `PINNED_ENV_LAYER_REGISTRY`（那张表是"`env:` 键白名单"的覆盖面账，
    // 与 cwd 不是同一类判据；job 级 / 步骤级两个入口同样不在那张表里）。本分支的防静默
    // 拆除靠**定向样本**：`w26-workflow-defaults-working-directory`（必须红）+
    // `SELFTEST_REQUIRED_SAMPLES` 的逐条点名 —— 删掉本分支，自检当场报"策略形同不存在"。
    const registered = (context.workflowWorkingDirectories ?? WORKFLOW_LEVEL_WORKING_DIRECTORY_REGISTRY)
      .some(entry => entry.workflow === file && entry.workingDirectory === value)
    if (declared && !registered) {
      reportOnce('cwd:workflow', `[SK-18] workflow **顶层**声明了 `
        + `\`defaults.run.working-directory: ${JSON.stringify(value ?? null)}\`，而本 workflow 里`
        + `有 ${units.length} 个被钉住的判定单元（${pinnedJobIds.join('、')}）。`
        + '\n  ⇒ workflow 级 `defaults.run` 作用于**所有 job**：argv 与步骤体一字未改，'
        + '可 `node scripts/…` 的相对路径、`package.json`、`.yarnrc.yml`、`.git` 全部来自那个目录 ——'
        + '与"换成谁的解释器"同级，所以它走**登记制**（W1 复审 N1：顶层写这几行时判据 EXIT=0）。'
        + '\n  ⇒ 要在顶层换 cwd，先在 `WORKFLOW_LEVEL_WORKING_DIRECTORY_REGISTRY` 里逐字登记'
        + '`{ workflow, workingDirectory }` 并写明"被钉步骤在这个 cwd 下为什么仍然成立"。')
    }
  }
  for (const jobId of pinnedJobIds) {
    const runDefaults = jobs[jobId]?.defaults?.run
    if (runDefaults === null || typeof runDefaults !== 'object') continue
    if (!Object.hasOwn(runDefaults, 'working-directory')) continue
    const value = runDefaults['working-directory']
    const registered = (context.jobWorkingDirectories ?? PINNED_JOB_WORKING_DIRECTORY_REGISTRY)
      .some(entry => entry.job === jobId && entry.workingDirectory === value)
    if (registered) continue
    const labels = units.filter(unit => unit.jobId === jobId).map(unit => `「${unit.label}」`)
    reportOnce(`cwd:${jobId}`, `[SK-18] job ${jobId} 有被钉住的判定单元`
      + `(${labels.slice(0, 4).join('、')}${labels.length > 4 ? ` 等 ${labels.length} 个` : ''})，`
      + `而它声明了 \`defaults.run.working-directory: ${JSON.stringify(value ?? null)}\`。`
      + '\n  ⇒ `defaults.run.working-directory` 换的是**命令解析的目录**：argv 与步骤体一字未改，'
      + '可 `node scripts/…` 的相对路径、`package.json`、`.yarnrc.yml`、`.git` 全部来自那个目录 ——'
      + '与"换成谁的解释器"同级，所以它走**登记制**（第十轮审计 C-04：加上这两行时判据 EXIT=0）。'
      + '\n  ⇒ 要在这个 job 上换 cwd，先在 `PINNED_JOB_WORKING_DIRECTORY_REGISTRY` 里逐字登记'
      + '`{ job, workingDirectory }` 并写明"判据步骤为什么仍然成立"（本仓合法的一例是 `server` job）。')
  }
  for (const unit of units) {
    if (unit.step === null || typeof unit.step !== 'object') continue
    if (!Object.hasOwn(unit.step, 'working-directory')) continue
    const value = unit.step['working-directory']
    const registered = PINNED_STEP_WORKING_DIRECTORY_REGISTRY
      .some(entry => entry.job === unit.jobId && entry.step === unit.label && entry.workingDirectory === value)
    if (registered) continue
    reportOnce(`cwd:${unit.jobId}#${unit.index}`, `[SK-18] ${unitLabel(unit)} 是${unit.reason}，`
      + `而这一步声明了 \`working-directory: ${JSON.stringify(value ?? null)}\`。`
      + '\n  ⇒ 与 job 级同族：命令在**另一个目录**里解析（argv / 步骤体 / `env:` 全都看不出区别）。'
      + '要给被判据钉住的那一步换 cwd，先在 `PINNED_STEP_WORKING_DIRECTORY_REGISTRY` 里逐字登记并写明理由。')
  }

  if (failures.length === 0) {
    notes.push(`[SK-17] 进程环境层:${units.length} 个被钉住的判定单元`
      + `(${pinnedJobIds.join(', ')})已按**白名单**检查 ${layers().length} 层 —— `
      + layers().map(layer => `${layer.label}[${layer.count}]`).join(' · ')
      + `(键表 = PINNED_ENV_ALLOWED_KEYS,共 ${PINNED_ENV_ALLOWED_KEYS.length} 条登记;未登记即红)`)
  }
  return { failures, layers: layers(), uses: usedUses, usesWith: [...usedUsesWith] }
}

/**
 * 被钉住的判据步骤的**覆盖下限**(2026-09-24 第八轮审计 R8-C-1 ②)。
 *
 * 现场:`observed.length` 只是被打印出来。把 `gate-guards` 的根守卫命令注释掉之后
 * `root-guard-runner` 这条策略**不再适用**,覆盖从 5 个静默降到 4 个,而门禁 EXIT=0 ——
 * "少识别一个被钉步骤"等于"少一份判据",却没有任何断言要求它在。
 *
 * 判据:登记在 `PINNED_STEP_POLICIES` 里的**每一个**策略 id 都必须在本次全仓扫描里至少
 * 命中一次(与 SK-13 的"发布链承载者必须存在"同一手法:只在默认目录的全仓扫描里判,
 * `--workflows-dir` 指向的合成树本来就可能只有一份最小文件)。
 *
 * @param policies - 本次扫描命中的策略 id(可重复)。
 * @returns 失败项数组(空 = 全覆盖)。
 */
function pinnedStepCoverageProblem(policies) {
  const seen = new Set(Array.isArray(policies) ? policies : [])
  const missing = PINNED_STEP_POLICIES.filter(policy => !seen.has(policy.id))
  if (missing.length === 0) return []
  return [{
    name: '[SK-14]',
    line: 0,
    detail: `被钉住的判据步骤**覆盖不足**:${missing.map(policy => `\`${policy.id}\`(${policy.label})`).join(', ')}`
      + ` 本次一次都没被识别到(命中 ${seen.size}/${PINNED_STEP_POLICIES.length} 条策略)。`
      + '\n  ⇒ 每条策略都是"某一步必须真的在跑 / 真的能失败"的判据,**识别不到等于判据不存在**。'
      + '常见原因:守卫运行步的命令被注释掉了(判据读的是可执行文本)、步骤被删或改名、'
      + '驱动它的结构(`needs.<job>.result` / 唯一的全量门禁调用)被改写。'
      + '\n  ⇒ 要调整覆盖面请**显式**改 `PINNED_STEP_POLICIES` 并写明理由 —— '
      + '不允许"少识别一个"这种静默降级(第八轮审计 R8-C-1:覆盖 5→4 时门禁照样 EXIT=0)。',
  }]
}

function checkReleaseSurface(file, document, text, notes) {
  const failures = []
  const jobs = typeof document?.jobs === 'object' && document.jobs !== null ? document.jobs : {}
  // 发布面的**执行文本**(注释不算 —— ci.yml 的注释里就提到过 `gh api`)。
  const releaseScripts = Object.values(jobs)
    .flatMap(job => (Array.isArray(job?.steps) ? job.steps : []))
    .filter(step => typeof step?.run === 'string')
    .map(step => executableScript(step.run))
  // 只在"这份 workflow 有发布面"时生效:合成样本 / 纯测试 workflow 只跑 `yarn check`
  // 却没有 release 步骤是合法的(这条判据的动机是"半发布窗口",前提是先有发布面)。
  // **发布面的口径是能力面**(第十一轮审计 C2-A-02):`gh api … releases … body=` 与
  // `gh release create|edit` **同权**,只按命令名判会让"换一种等价写面"整条判据静默失效。
  const writesReleaseViaApi = releaseScripts.some(script => [...script.matchAll(GH_API_INVOCATION)]
    .some(match => /releases/u.test(match[1]) && ghApiReleaseBodyFlagPresent(match[1])))
  if (!/gh\s+release\s+(?:create|edit|upload)|ci-release-policy\.sh/u.test(text) && !writesReleaseViaApi) {
    return failures
  }
  /** 策展发布说明的 fail-loud:判据必须落在**可执行文本**上(注释不算)。 */
  const isNotesGate = step => {
    if (typeof step?.run !== 'string') return false
    const script = executableScript(step.run)
    return /docs\/releases\//u.test(script)
      && /(?:test\s+-f|\[\s+-f)/u.test(script)
      && /exit\s+1/u.test(script)
  }
  // 能力级(2026-09-23 第五轮审计 R5-C-6):不再是"4 条登记命令",而是
  // "任何真的能写远端对象存储/发布面的步骤"(见 REMOTE_WRITE_CAPABILITIES)。
  // **只算发布面**(release-surface):run 级临时中转(channel-transfer push)是已登记的
  // 例外,它不上说明门 —— 但它同样受 SK-15 的步骤登记(if 形态 / continue-on-error)约束。
  const isUpload = step => typeof step?.run === 'string'
    && detectRemoteWrites(executableScript(step.run))
      .some(capability => capability.surface === 'release-surface')
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
    // ④ 判据本身不得被"只对正式版"的条件收窄(2026-09-23 第五轮审计 R5-C-3)。
    //
    // 现场:gate 与 release job 的策展说明检查都以 `release_kind == 'stable'` 为前提,
    // 预发 tag 缺说明被放行到 `--generate-notes` —— 自动变更日志的正文由提交信息 +
    // **PR 标题/正文**生成,而后者不是文件、不在任何守卫判据内(铁律 0 的盲区)。
    // 历史上正是这条路径把真实域名/IP 带进了公开 Release 正文。
    // 判据只读**可执行文本**里的 `if:` 条件(注释里写不算),覆盖两种收窄写法:
    // 只认 stable,以及"名字不含 `-` 才算正式版"这类第二份名字形状判断。
    for (const index of notesIndexes) {
      const condition = steps[index]?.if
      if (typeof condition !== 'string') continue
      const narrow = /release_kind\s*==\s*['"]stable['"]/u.test(condition)
        || /(?:!\s*)?contains\(\s*github\.ref_name\s*,\s*['"]-['"]/u.test(condition)
      if (!narrow) continue
      failures.push({
        name: file,
        line: 0,
        detail: `[SK-11] job ${jobId} 的策展说明检查(第 ${index + 1} 步)带条件 \`if: ${condition.trim()}\``
          + '\n  ⇒ 预发 tag 被排除在这条判据之外,缺说明时会回退 GitHub 自动变更日志,'
          + '而自动正文来自提交信息 + **PR 标题/正文**(PR 标题/正文不是文件 ⇒ 不在任何守卫判据内,'
          + '铁律 0 的盲区;历史上真实域名/IP 就是这么进公开 Release 正文的)。'
          + '策展说明对**发布 tag 一律要求**:条件只能是"是不是发布 tag",不得只认正式版。',
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
      const stepLabel = `job ${jobId} 的 step「${stepName(step, index)}」`
      const invocations = [...script.matchAll(GH_RELEASE_INVOCATION)]
      // ⑦ **写入口不许藏进变量/数组**(第十一轮审计 C2-A-02)。现场:
      //    `GH_CREATE=(gh release create)` 之后 `"${GH_CREATE[@]}" … --notes "$(git log …)"`
      //    —— 命令名不在文本里(而且 `(gh release create)` 后面紧跟 `)`,连
      //    `GH_RELEASE_INVOCATION` 的"命令词后必须有空白"都不满足) ⇒ 判据面外。
      //    取向:写 Release 正文的**能力**出现在 step 里,但 argv 读不懂 ⇒ fail-closed 红。
      const indirectWrite = /\bgh\s+release\s+(?:create|edit)\b/u.test(script) && invocations.length === 0
      if (indirectWrite) {
        failures.push({
          name: file,
          line: 0,
          detail: `[SK-11] ${stepLabel} 里有 \`gh release create|edit\` 的文本,但**读不到可判的 argv**`
            + '(命令名/数组被放进变量,例如 `GH_CREATE=(gh release create)`)'
            + '\n  ⇒ 这一步能写 Release 正文(含标题与说明来源),而判据看不见它用了哪个旗标、取值从哪来。'
            + '求不出真假 ⇒ 按会静默处理:把 `gh release …` 写成**字面命令**,或把这种间接形态登记成'
            + '一条显式的判据(不接受"看起来人畜无害"当豁免)。',
        })
      }
      // ⑧ `gh api` 写 `releases` 正文:与 `gh release create|edit` **同权**的写面,一并判。
      for (const match of script.matchAll(GH_API_INVOCATION)) {
        const problems = ghApiReleaseBodyProblems(script, match[1])
        if (problems.length === 0) continue
        failures.push({
          name: file,
          line: 0,
          detail: `[SK-11] ${stepLabel} 经 \`gh api\` 写 Release 正文,而正文来源**不可证明**是策展文件。`
            + `\n  ${problems.join('\n  ')}`,
        })
      }
      if (invocations.length === 0) return
      // 说明来源的总账:这一步有没有**至少一条可证明来自策展文件**的来源。
      let provenSources = 0
      for (const match of invocations) {
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
        if (!/exit\s+[1-9]/u.test(script)) {
          failures.push({
            name: file,
            line: 0,
            detail: `[SK-11] job ${jobId} 的 step「${stepName(step, index)}」里没有 fail-loud(\`exit 1\`)`
              + '\n  ⇒ 本仓定案:正式 tag 缺 docs/releases/<tag>.md 时**绝不静默回退**自动生成的 PR 列表'
              + '(v2.7.0 的教训:公开版本页变成 CI 日志)。这一条判据只认可执行文本,注释里写不算。',
          })
        }
        // ③/④ **正文来源必须可证明是策展文件**(第十一轮审计 C2-A-01,P1)。旧判据只问
        //    "有没有说明来源这个旗标" ⇒ `--notes "$(git log -1 --format=%B)"` 全绿而公开
        //    正文来自未评审文本(提交信息 / 任意命令输出)。现在逐条判取值来源,fail-closed。
        const report = releaseNotesSourceReport(script, tail)
        provenSources += report.sources
        for (const problem of report.problems) {
          failures.push({
            name: file,
            line: 0,
            detail: `[SK-11] job ${jobId} 的 step「${stepName(step, index)}」里 \`gh release ${match[1]}\` 的`
              + `说明来源**不能证明是策展文件**:\n  ${problem}`
              + '\n  ⇒ 公开 Release 正文必须来自 `docs/releases/<tag>.md`(可评审、进 diff、'
              + '过 `check-no-real-domains`);来源证明不了的形态一律按未评审文本处理。',
          })
        }
        // ⑤ 绝不回退自动变更日志(2026-09-23 第五轮审计 R5-C-3):`--generate-notes` 的正文
        //    由提交信息 + **PR 标题/正文**生成,而 PR 标题/正文不是文件 ⇒ 不在任何守卫判据内
        //    (铁律 0 的盲区)。历史上真实域名/IP 正是这么进公开 Release 正文的。
        //    预发 tag 曾有这条回退,现已删除;这里把它钉死,防止再长回来。
        if (/--generate-notes\b/u.test(script)) {
          failures.push({
            name: file,
            line: 0,
            detail: `[SK-11] job ${jobId} 的 step「${stepName(step, index)}」里用了 \`--generate-notes\``
              + '\n  ⇒ 那会把 Release 正文回退成自动变更日志(提交信息 + PR 标题/正文),'
              + '而 PR 标题/正文不是文件、不在任何守卫判据内(铁律 0 的盲区;历史泄漏路径)。'
              + '发布 tag(正式版与预发版)一律用 `--notes-file docs/releases/<tag>.md`。',
          })
        }
      }
      if (provenSources === 0) {
        failures.push({
          name: file,
          line: 0,
          detail: `[SK-11] ${stepLabel} 里 \`gh release create|edit\` 没有**可证明来自策展文件**的说明来源`
            + '\n  ⇒ 需要 `--notes-file docs/releases/<tag>.md`(或同一脚本里赋给它的变量;'
            + '`--notes "$(cat docs/releases/<tag>.md)"` 亦可),或 `-F`/`-n` 短形态。'
            + '判据问的是"正文是不是那份策展文件",不是"有没有写这个旗标"。',
        })
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
    // 合成的被钉 job（`verify`）要用**同一张** `runs-on` 登记表的口径：注入一条合成登记项，
    // 否则新加的 `runs-on` 判据会把一堆与它无关的绿样本判红（收紧过度也是缺陷）。
    const result = checkWorkflowText(file, selftestWorkflow(steps, options), {
      registries: options.registries ?? SELFTEST_RUNS_ON_REGISTRY,
    })
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
    const result = checkWorkflowText(file, text, { registries: options.registries ?? REGISTRY_NONE })
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
  /**
   * W-8③ 的 env 行生成器(两个夹具共用):`full` = 登记形态,其余是三种必须红的变异。
   * `literal` = 写死一个字面量 sha(下次提交后恒红);`wrong-var` = 换成别的 github 变量
   * (脚本侧形状校验会拒);`none` = 整行缺失(= 本判据要修的原始形态)。
   */
  const expectHeadEnvLine = mode => {
    if (mode === 'none') return null
    if (mode === 'literal') return `          ${WASM_GATE_EXPECT_HEAD_ENV}: '1f9c621b98e81c92ecb5170fd97910a78725b8e9'`
    if (mode === 'wrong-var') return `          ${WASM_GATE_EXPECT_HEAD_ENV}: \${{ github.ref }}`
    return `          ${WASM_GATE_EXPECT_HEAD_ENV}: \${{ github.sha }}`
  }
  /** W-5 探针步的形态生成器(两个夹具共用)。 */
  const wasmProbeLines = (mode, expectHead = 'full') => (mode === 'none' ? [] : [
    '      - name: WASM protocol probes (group 6; Linux)',
    ...(mode === 'narrow-if' ? ["        if: github.event_name == 'workflow_dispatch'"] : []),
    // 第四轮审计 R4-A-5 的现场形态:布尔 `false`(SK-12 此前只认字符串形态 ⇒ 漏掉)。
    ...(mode === 'if-false' ? ['        if: false'] : []),
    ...(mode === 'if-string-false' ? ["        if: 'false'"] : []),
    '        env:',
    `          ${WASM_PROBE_ENV}: ${mode === 'no-env' ? "''" : "'1'"}`,
    ...(expectHeadEnvLine(expectHead) === null ? [] : [expectHeadEnvLine(expectHead)]),
    `        run: bash scripts/verify-wasm-client-only.sh --groups ${mode === 'group1' ? '1' : '6'}`,
  ])
  /** W-4 用例级报告步的形态生成器(两个夹具共用)。`ifLine` 用来注入常量假 `if:`(R4-A-5)。 */
  const wasmCaseGateLines = (mode, ifLine = null, { continueOnError = false, swallow = false } = {}) => {
    if (mode === 'none') return []
    const option = WASM_CASE_GATE_OPTIONS[mode]
    return [
      '  server:',
      `    runs-on: ${GATE_SELFTEST_RUNS_ON}`,
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
      '      - name: Go tests (repo-wide) + WASM case-level report',
      ...(ifLine === null ? [] : [`        if: ${ifLine}`]),
      ...(continueOnError ? ['        continue-on-error: true'] : []),
      '        run: |',
      '          set -euo pipefail',
      '          GO_TEST_STATUS=0',
      `          go test ./... -count=1 -p 1 -timeout 15m -json > ${option.report} || GO_TEST_STATUS=$?`,
      ...(swallow ? ['          yarn check || true'] : []),
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
  ], { file: 'ci.yml', triggers: REQUIRED_TRIGGERS })
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
    guardRunIf = null,
    // 守卫运行步的 `env:`（[SK-16②] 的样本入口）：null = 不带 env（与真 ci.yml 同形）；
    // 给了数组就走"多行 + env:"形态（**仍然不得带 `if:`** —— [SK-14] 的 `never` 形态）。
    guardStepEnv = null,
    // 根守卫 **job 级** `env:`（[SK-17④] 的样本入口）：数组 = 该 job 的 `env:` 块内容
    // （已缩进 4 空格）。形态 A/B 最省事的挂点就是这里（2026-09-25 第九轮审计 D 泳道）。
    guardJobEnv = null,
    // 根守卫 job 的 `container:` 块（[SK-17③] 的样本入口，第十轮审计 C-02）：数组 =
    // 已缩进 4 空格的 YAML 行（`container:` + `image:` + `env:` …）。
    guardContainer = null,
    // 根守卫 job 的 `defaults.run.working-directory`（[SK-18] 的样本入口，第十轮审计 C-04）：
    // 字符串 = 逐字写进 `defaults: / run: / working-directory:`；null = 不声明。
    guardJobWorkingDirectory = null,
    // workflow **顶层** `defaults.run.working-directory`（[SK-18] 的第三个样本入口，
    // 第十轮复审 W1 的 N1）：字符串 = 顶格写 `defaults: / run: / working-directory:`；
    // null = 不声明。与 job 级同族，但作用于**所有 job**（含根守卫步与全量门禁步）。
    workflowWorkingDirectory = null,
    // workflow **顶层** `defaults:` 块里额外的顶格 YAML 行（[SK-19] 的顶层样本入口，
    // 第十轮复审 W1 的 N2）：配合 `workflowWorkingDirectory` 使用（例如写一行 `  <<: *s`）。
    workflowDefaultsExtra = [],
    // 被钉住的**全量门禁**步的步骤级 `working-directory`（[SK-18] 的第二个样本入口）。
    gateStepWorkingDirectory = null,
    // 非判据步骤（`changes` job 那一步）的 `working-directory`（[SK-18] 的绿样本入口：
    // 判据只钉"被钉单元"，不许一刀切成"整个文件里不许出现这个键"）。
    changesStepWorkingDirectory = null,
    // workflow **顶层锚点块**（[SK-19] 的样本入口）：数组 = 已顶格的 YAML 行
    // （`x-base: &base` + 内容），配合 `guardJobEnvAlias` 使用。
    rawPrefix = [],
    // 根守卫 job 的 `env:` 写成**别名**形态（`env: *base`）—— 与 `<<` 合并键形成对照：
    // 普通别名解析后键是**可见**的（判据照常判），只有合并键会让它们隐形。
    guardJobEnvAlias = null,
    // 根守卫 **job 块**上的 YAML **合并键**（`<<: *base`，[SK-19] 的样本入口）：
    // 字符串 = 别名名（含 `*`），null = 不声明。合并键藏的是**整个 job 块**的内容
    // （`env:` / `steps:` 都可以被它顶掉，解析结果里只剩一个字面键 `<<`）。
    guardJobMergeKey = null,
    // 根守卫 job 里**额外**的 `uses:` 步骤（[SK-17⑦] 的样本入口，第十轮审计 C-03）：
    // 数组 = 已缩进 6 空格的 YAML 行。
    guardUsesSteps = [],
    // 根守卫 job 的 `runs-on`（[SK-17⑦c] 的样本入口，第十一轮审计 P2-1）：字符串 = 逐字写进
    // `runs-on:`；也接受字符串化后的列表形态（`[self-hosted, linux]`）用来测"非标量 ⇒ 红"。
    guardRunsOn = GATE_SELFTEST_RUNS_ON,
    // 守卫结果链路步（`gate` 的收尾链路步）的 `env:`（[SK-17⑤] 的样本入口）。
    linkStepEnv = null,
    // `changes` job 里那一步（**非**判据步骤）的 `env:`（[SK-17] 的绿样本入口：
    // 判据只钉"判据步骤/守卫 job"，`NODE_OPTIONS: --max-old-space-size=…` 这类
    // 真实存在的合法用法不许被一刀切）。
    changesStepEnv = null,
    // 被钉住的**全量门禁**步（`gate` 的 `yarn check`）的额外 `env:` 行（[SK-17⑤] 的样本入口）。
    gateStepExtraEnv = [],
    // 被钉住的**全量门禁**步的 `shell:`（[SK-14⑦] 整串判据的样本入口，R9-B P1-3）。
    gateStepShell = null,
    // `changes` job（**没有**判据步骤的 job）里那一步之后的额外步骤（[SK-17] 的绿样本入口：
    // `$GITHUB_PATH` 这类写法在非判据 job 里是正常姿势，不许被一刀切）。
    changesExtraSteps = [],
    // 守卫运行步的**块标量**形态（[SK-9②]/R8-C-1 的样本入口：命令被注释掉）。
    // 给了数组就走 `run: |` + 逐行内容（不再有内联 `- run:`）。
    guardRunLines = null,
    // 守卫运行步**之前**的额外步骤（[SK-16①c] 的样本入口：`$GITHUB_ENV` 注入）。
    // 每项是一组"已缩进 6 空格"的 YAML 行。
    guardPreSteps = [],
    // workflow **顶层** `env:`（[SK-16①b] 的样本入口）：null = 不带（与真 ci.yml 的
    // `DSH_TELEMETRY_DISABLED` 同形时用数组给出"正常形态"）。
    workflowEnv = null,
    gateNeeds = '[changes, gate-guards]',
    gateIf = '${{ !cancelled() }}',
    gateStepIf = "needs.changes.outputs.code != 'false'",
    gateRun = 'yarn check',
    gateDepth = '          fetch-depth: 0',
    guardDepth = '          fetch-depth: 0',
    linkStep = true,
    linkIf = "needs.gate-guards.result != 'success'",
    // 守卫结果链路步的**步骤体**（第六轮独立复审 V2 边界③的样本入口）：null = 与真 ci.yml
    // 同形的形态；给了数组就整段替换（只在 `linkStep` 为真时生效）。
    linkRun = null,
    // 链路步的 `shell:`（[SK-14⑦] shell 钉子的样本入口，R8-D-19）：null = 不声明。
    linkShell = null,
    caseGateIf = null,
    caseGateContinueOnError = false,
    caseGateSwallow = false,
    triggers = ['pull_request', 'push'],
    pushFilter = null,
    prFilter = null,
    extraTriggers = [],
    releaseAnchor = false,
    wasmCaseGate = 'full',
    wasmProbe = 'full',
    gateExpectHead = 'full',
    probeExpectHead = 'full',
  } = {}) => [
    'name: selftest',
    'on:',
    ...triggers.flatMap(trigger => {
      const filter = trigger === 'push' ? pushFilter : (trigger === 'pull_request' ? prFilter : null)
      return filter === null ? [`  ${trigger}:`] : [`  ${trigger}:`, `    ${filter}`]
    }),
    ...rawPrefix,
    ...extraTriggers.map(trigger => `  ${trigger}:`),
    ...(workflowEnv === null ? [] : ['env:', ...workflowEnv]),
    // workflow **顶层** `defaults:`（[SK-18] N1 / [SK-19] N2 的样本入口）：顶格两行 + 可选
    // 额外的 `run:` 级 YAML 行（`workflowDefaultsExtra` 已是**顶格**形态，调用方自己缩进）。
    ...(workflowWorkingDirectory === null && workflowDefaultsExtra.length === 0
      ? []
      : ['defaults:', '  run:',
        ...(workflowWorkingDirectory === null ? [] : [`    working-directory: ${workflowWorkingDirectory}`]),
        ...workflowDefaultsExtra]),
    'jobs:',
    '  changes:',
    '    runs-on: ubuntu-latest',
    '    timeout-minutes: 5',
    '    outputs:',
    '      code: ${{ steps.scope.outputs.code }}',
    '    steps:',
    '      - id: scope',
    ...(changesStepEnv === null ? [] : ['        env:', ...changesStepEnv]),
    ...(changesStepWorkingDirectory === null ? [] : [`        working-directory: ${changesStepWorkingDirectory}`]),
    '        run: echo "code=true" >> "$GITHUB_OUTPUT"',
    ...changesExtraSteps,
    ...(guardJob ? [
      '  gate-guards:',
      `    runs-on: ${guardRunsOn}`,
      ...(guardNeeds === '' ? [] : [`    needs: ${guardNeeds}`]),
      ...(guardIf === '' ? [] : [`    if: ${guardIf}`]),
      '    timeout-minutes: 20',
      ...(guardContainer === null ? [] : guardContainer),
      ...(guardJobMergeKey === null ? [] : [`    <<: ${guardJobMergeKey}`]),
      ...(guardJobWorkingDirectory === null ? [] : [
        '    defaults:',
        '      run:',
        `        working-directory: ${guardJobWorkingDirectory}`,
      ]),
      ...(guardJobEnvAlias !== null
        ? [`    env: ${guardJobEnvAlias}`]
        : (guardJobEnv === null ? [] : ['    env:', ...guardJobEnv])),
      '    steps:',
      '      - uses: actions/checkout@v7',
      '        with:',
      '          submodules: recursive',
      ...(guardDepth === null ? [] : [guardDepth]),
      ...guardUsesSteps,
      ...guardPreSteps,
      // R4-A-5 的现场形态:守卫运行步本身被常量假 `if:` 摘掉(带 `if:` 时必须展开成多行形态)。
      ...(guardRunLines !== null ? [
        '      - name: Root guards (every PR shape)',
        ...(guardRunIf === null ? [] : [`        if: ${guardRunIf}`]),
        '        run: |',
        ...guardRunLines.map(line => `          ${line}`),
      ] : guardStepEnv !== null ? [
        '      - name: Root guards (every PR shape)',
        ...(guardRunIf === null ? [] : [`        if: ${guardRunIf}`]),
        '        env:',
        ...guardStepEnv,
        `        run: ${guardRun}`,
      ] : guardRunIf === null
        ? [`      - run: ${guardRun}`]
        : ['      - name: Root guards (every PR shape)', `        if: ${guardRunIf}`, `        run: ${guardRun}`]),
    ] : []),
    '  gate:',
    `    runs-on: ${GATE_SELFTEST_RUNS_ON}`,
    `    needs: ${gateNeeds}`,
    `    if: ${gateIf}`,
    '    timeout-minutes: 60',
    '    steps:',
    ...(linkStep ? [
      '      - name: Root guards must have passed',
      `        if: ${linkIf}`,
      ...(linkShell === null ? [] : [`        shell: ${linkShell}`]),
      ...(linkStepEnv === null ? [] : ['        env:', ...linkStepEnv]),
      '        run: |',
      ...(linkRun ?? [
        '          set -euo pipefail',
        // 与真 ci.yml 同形:run 里点名 `needs.<guard>.result` —— [SK-9]③ 的链路识别口径
        // (`run` 或 `if:` 引用结果)。少了它,注入 `if: false` 之后这一步连"链路"都算不上,
        // 样本就测不到"链路还在但永不执行"这个真实现场。
        '          echo "::error::根守卫 job 未成功(result=${{ needs.gate-guards.result }})⇒ 门禁整体失败"',
        '          exit 1',
      ]),
    ] : []),
    '      - uses: actions/checkout@v7',
    '        with:',
    '          submodules: recursive',
    ...(gateDepth === null ? [] : [gateDepth]),
    '      - name: 全量门禁',
    `        if: ${gateStepIf}`,
    ...(gateStepShell === null ? [] : [`        shell: ${gateStepShell}`]),
    ...(gateStepWorkingDirectory === null ? [] : [`        working-directory: ${gateStepWorkingDirectory}`]),
    ...(expectHeadEnvLine(gateExpectHead) === null && gateStepExtraEnv.length === 0 ? [] : [
      '        env:',
      ...(expectHeadEnvLine(gateExpectHead) === null ? [] : [expectHeadEnvLine(gateExpectHead)]),
      ...gateStepExtraEnv,
    ]),
    `        run: ${gateRun}`,
    ...(releaseAnchor ? [
      '      - name: Publish channel images to the update server (R2)',
      '        run: bash scripts/ci-publish-update-server.sh --list channels.list',
    ] : []),
    ...wasmProbeLines(wasmProbe, probeExpectHead),
    ...wasmCaseGateLines(wasmCaseGate, caseGateIf, { continueOnError: caseGateContinueOnError, swallow: caseGateSwallow }),
    '',
  ].join('\n')
  const gateSample = (id, expectation, options = {}) => {
    const entry = {
      raw: GATE_SHAPE(options),
      file: options.file ?? 'selftest.yml',
      // `registries` 透传（第十轮复审 V1 的 P3-D3）：样本要能**单独**放行容器镜像登记，
      // 从而只留 `container.env` 的键判定那一条分支可红（否则两个分支互相顶替）。
      ...(options.registries === undefined ? {} : { registries: options.registries }),
    }
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
  // ③ W-8 接线的后半:结论必须钉在权威 HEAD 上(整仓门禁步 + 探针步两处都要)。
  // 三种变异都要红:整行缺失(= 原始形态)/ 写死字面量 sha(下次提交后恒红)/ 换成别的 github 变量。
  gateSample('r12-gate-missing-expect-head', '[SK-12]', { file: 'ci.yml', gateExpectHead: 'none' })
  gateSample('r13-gate-literal-expect-head', '[SK-12]', { file: 'ci.yml', gateExpectHead: 'literal' })
  gateSample('r14-gate-wrong-var-expect-head', '[SK-12]', { file: 'ci.yml', gateExpectHead: 'wrong-var' })
  gateSample('r15-probe-missing-expect-head', '[SK-12]', { file: 'ci.yml', probeExpectHead: 'none' })
  gateSample('r16-probe-literal-expect-head', '[SK-12]', { file: 'ci.yml', probeExpectHead: 'literal' })

  // ---- 策略 9([SK-13]):触发面(`on:`)的业务契约(2026-09-23 第四轮审计 R4-A-3) ----
  //
  // 三种现场变异(删 `push:` / 只留 `workflow_dispatch` / 加 `branches: [never-exists]`)
  // 此前**全部 EXIT=0**。样本用 `file: 'ci.yml'`(= 承载发布链的那个 workflow 的登记名)。
  gateSample('s1-push-removed', '[SK-13]', { file: 'ci.yml', triggers: ['pull_request'] })
  gateSample('s2-dispatch-only', '[SK-13]', { file: 'ci.yml', triggers: ['workflow_dispatch'] })
  gateSample('s3-pull-request-removed', '[SK-13]', { file: 'ci.yml', triggers: ['push'] })
  gateSample('s4-push-branches-narrowed', '[SK-13]', { file: 'ci.yml', pushFilter: 'branches: [never-exists-xyz]' })
  gateSample('s5-push-branches-ignore', '[SK-13]', { file: 'ci.yml', pushFilter: 'branches-ignore: [master]' })
  gateSample('s6-push-tags-only', '[SK-13]', { file: 'ci.yml', pushFilter: "tags: ['v*']" })
  gateSample('s7-pr-branches-whitelist', '[SK-13]', { file: 'ci.yml', prFilter: 'branches: [master]' })
  gateSample('s8-unregistered-trigger', '[SK-13]', { file: 'ci.yml', extraTriggers: ['schedule'] })
  // 正例:登记形态(必含的两种 + 可有可无但已登记的 `workflow_dispatch`)必须绿。
  gateSample('s9-triggers-with-dispatch-green', null, { file: 'ci.yml', triggers: ['pull_request', 'push', 'workflow_dispatch'] })
  // 内容锚点:文件**不叫** ci.yml 时,只要它承载发布链,契约照样生效(改名不是逃生门)。
  gateSample('s10-renamed-release-line', '[SK-13]', {
    file: 'ci-main.yml', triggers: ['pull_request'], releaseAnchor: true,
  })
  gateSample('s11-renamed-release-line-green', null, {
    file: 'ci-main.yml', triggers: ['pull_request', 'push'], releaseAnchor: true,
  })
  // 与发布链无关的普通 workflow 不受约束(没有触发面契约可谈的地方不要收紧)。
  expectGreen('s12-plain-workflow-not-release-line', [
    '      - run: echo hello',
  ])

  // ---- 策略 10([SK-14]):被钉住的判据步骤必须**可执行**(R4-A-5) ----
  //
  // 现场形态:步骤保留、`run` 一字不改,只加一行常量假 `if:`。两条最重的实例(整套 Go
  // 测试、守卫结果链路)此前**全绿**。
  gateSample('u1-go-tests-if-false', '[SK-14]', { file: 'ci.yml', caseGateIf: 'false' })
  gateSample('u2-go-tests-if-string-false', '[SK-14]', { file: 'ci.yml', caseGateIf: "'false'" })
  gateSample('u3-guard-link-if-false', '[SK-14]', { file: 'ci.yml', linkIf: 'false' })
  gateSample('u4-guard-runner-if-false', '[SK-14]', { file: 'ci.yml', guardRunIf: 'false' })
  gateSample('u5-full-gate-if-false', '[SK-14]', { file: 'ci.yml', gateStepIf: 'false' })
  gateSample('u6-probe-if-false', '[SK-14]', { file: 'ci.yml', wasmProbe: 'if-false' })
  gateSample('u7-probe-if-string-false', '[SK-14]', { file: 'ci.yml', wasmProbe: 'if-string-false' })
  gateSample('u8-guard-runner-if-expression', '[SK-14]', { file: 'ci.yml', guardRunIf: '${{ github.event_name == \'push\' }}' })
  gateSample('u9-go-tests-continue-on-error', '[SK-14]', { file: 'ci.yml', caseGateContinueOnError: true })
  gateSample('u10-go-tests-swallowed-exit', '[SK-14]', { file: 'ci.yml', caseGateSwallow: true })
  // 正例:`if:` 写成登记过的形态(docs-only 的 fail-safe / 守卫结果)一律绿 —— r1 已覆盖
  // 「与真 ci.yml 同形」,这里再钉一条"探针步不带 if: 也绿"(避免把正确形态误判)。
  gateSample('u11-pinned-steps-without-if-green', null, { file: 'ci.yml', wasmProbe: 'full', caseGateIf: null })
  // 2026-09-23 第六轮审计 R6-C-2：守卫结果链路步的 `if:` 是**逐字**判据（不再是子串）。
  // 三种形态都必须红：常量假 / 加合取项 / 换写法（`== 'failure'`、`${{ … }}` 包裹）。
  // 这一步是"守卫失败 ⇒ 必需 Gate 红"的唯一链路，任何收窄都等于把它摘掉。
  gateSample('u12-guard-link-if-compound', '[SK-14]', {
    file: 'ci.yml',
    linkIf: "needs.gate-guards.result != 'success' && github.event_name != 'pull_request'",
  })
  gateSample('u13-guard-link-if-compound-owner', '[SK-14]', {
    file: 'ci.yml',
    linkIf: "needs.gate-guards.result != 'success' && github.repository_owner == 'nobody'",
  })
  gateSample('u14-guard-link-if-equals-failure', '[SK-14]', {
    file: 'ci.yml',
    linkIf: "needs.gate-guards.result == 'failure'",
  })
  gateSample('u15-guard-link-if-expression-wrapped', '[SK-14]', {
    file: 'ci.yml',
    linkIf: '${{ needs.gate-guards.result != \'success\' }}',
  })
  gateSample('u16-guard-link-if-other-job-result', '[SK-14]', {
    file: 'ci.yml',
    linkIf: "needs.changes.result != 'success'",
  })
  // 2026-09-23 第六轮独立复审 V2 边界③：`if:` 逐字合法**不等于**步骤体真的会失败。
  // 现场形态（多行 diff、可评审）：条件永假 + 块级收尾 + 一句 `echo`，而 `exit 1` 与
  // `needs.*.result` 两个子串都还在 ⇒ 旧判据 EXIT=0（"守卫失败 ⇒ Gate 红"的唯一链路被掏空）。
  const LAZY_LINK_BODY = [
    '          set -euo pipefail',
    '          if [ "never" = "${{ needs.gate-guards.result }}" ]; then',
    '            echo "::error::根守卫 job 未成功(result=${{ needs.gate-guards.result }})⇒ 门禁整体失败"',
    '            exit 1',
    '          fi',
    '          echo "guards ok"',
  ]
  gateSample('u17-guard-link-lazy-body', '[SK-14]', { file: 'ci.yml', linkRun: LAZY_LINK_BODY })
  // 反例必须只打在"步骤体"这一条上：`run` 里已无 `exit 1` 时 [SK-14] 的识别口径不命中，
  // 这里保留一个 exit 让失败原因可归因（否则红的是别的策略，样本就测不到新判据）。
  gateSample('u18-guard-link-exit-zero-tail', '[SK-14]', {
    file: 'ci.yml',
    linkRun: [
      '          set -euo pipefail',
      '          if [ "never" = "${{ needs.gate-guards.result }}" ]; then exit 1; fi',
      '          exit 0',
    ],
  })
  // `||` / `&&` 收尾是本仓既有的**正常 fail-loud 写法**（与 [SK-7a] 的 `isSafeFailureTail`
  // 同一口径）⇒ 必须绿，不得误判成"步骤体不可靠"。
  gateSample('u19-guard-link-or-exit-tail-green', null, {
    file: 'ci.yml',
    linkRun: [
      '          set -euo pipefail',
      '          echo "::error::根守卫 job 未成功(result=${{ needs.gate-guards.result }})"',
      '          test "${{ needs.gate-guards.result }}" != "success" || exit 1',
    ],
  })
  gateSample('u20-guard-link-and-exit-tail-green', null, {
    file: 'ci.yml',
    linkRun: [
      '          set -euo pipefail',
      '          echo "::error::根守卫 job 未成功(result=${{ needs.gate-guards.result }})"',
      '          test "${{ needs.gate-guards.result }}" != "success" && exit 1',
    ],
  })
  // 块级收尾（`fi`）= 掏空形态的另一张脸：整段只剩一个条件块，`exit 1` 在块里 ——
  // 块不执行时脚本以 0 收尾（这也是 u17 那句 `echo` 之外的等价写法）。
  gateSample('u21-guard-link-block-tail', '[SK-14]', {
    file: 'ci.yml',
    linkRun: [
      '          set -euo pipefail',
      '          if [ "never" = "${{ needs.gate-guards.result }}" ]; then',
      '            echo "::error::根守卫 job 未成功(result=${{ needs.gate-guards.result }})"',
      '            exit 1',
      '          fi',
    ],
  })
  // 2026-09-23 第七轮独立复审 R7-C P1-1：零出口/失败收尾必须**数值归一**，不能只认
  // 十进制字面量 `exit 0` / `exit [1-9][0-9]*`。现场是把这一条的 `exit 1` 换成
  // `exit 00` 再补一句死代码 `exit 1`：旧判据 EXIT=0（"根守卫失败 ⇒ Gate 红"的唯一
  // 链路被静默摘除），而 diff 只多了一个字符。下面每个形态都必须判红。
  const ZERO_EXIT_LINK_RUN = zeroExit => [
    '          set -euo pipefail',
    '          echo "::error::根守卫 job 未成功(result=${{ needs.gate-guards.result }})⇒ 门禁整体失败"',
    `          exit ${zeroExit}`,
    // 死代码：旧判据就是被这一句骗过去的（它只看得见"尾部有个非零 exit"）。
    '          exit 1',
  ]
  gateSample('u22-guard-link-exit-double-zero', '[SK-14]', { file: 'ci.yml', linkRun: ZERO_EXIT_LINK_RUN('00') })
  gateSample('u23-guard-link-exit-hex-zero', '[SK-14]', { file: 'ci.yml', linkRun: ZERO_EXIT_LINK_RUN('0x0') })
  gateSample('u24-guard-link-exit-arith-zero', '[SK-14]', { file: 'ci.yml', linkRun: ZERO_EXIT_LINK_RUN('"$((0))"') })
  // `exit 256` 是同一族里更隐蔽的一张脸：bash 的退出码是**低 8 位**，所以它真的会绿；
  // 旧判据只认 `exit 0`，连"尾部必须是非零"那条也把它当合格收尾。
  gateSample('u25-guard-link-exit-low-byte-zero', '[SK-14]', { file: 'ci.yml', linkRun: ZERO_EXIT_LINK_RUN('256') })
  // 同一行里的条件块：`if …; then exit 0; fi` 不是尾行 ⇒ 旧判据（只认 `exit` 紧跟
  // `; & | ( {`）看不见它，条件成立就绿着退出。
  gateSample('u26-guard-link-inline-then-zero-exit', '[SK-14]', {
    file: 'ci.yml',
    linkRun: [
      '          set -euo pipefail',
      '          if [ "never" = "${{ needs.gate-guards.result }}" ]; then exit 0; fi',
      '          echo "::error::根守卫 job 未成功(result=${{ needs.gate-guards.result }})"',
      '          exit 1',
    ],
  })
  // 反向：归一不能把**合法的非零收尾**误判掉（本仓既有写法 + 两个非十进制形态）。
  gateSample('u27-guard-link-nonzero-forms-green', null, {
    file: 'ci.yml',
    linkRun: [
      '          set -euo pipefail',
      '          if [ "never" = "${{ needs.gate-guards.result }}" ]; then',
      '            echo "::error::根守卫 job 未成功(result=${{ needs.gate-guards.result }})"',
      '            exit 3',
      '          fi',
      '          test "${{ needs.gate-guards.result }}" != "success"',
      '          exit "$((1 + 1))"',
    ],
  })
  // "任意位置的 `exit` 都要有可达性下限"的另一半：**归一不出确定退出码**的出口同样是
  // 掏空形态（`exit "$code"` 可以是 0，于是尾部那句 `exit 1` 变成死代码），按
  // "求不出真假 ⇒ 按会静默处理"判红。
  gateSample('u28-guard-link-undecidable-exit', '[SK-14]', {
    file: 'ci.yml',
    linkRun: [
      '          set -euo pipefail',
      '          code=0',
      '          exit "$code"',
      '          echo "::error::根守卫 job 未成功(result=${{ needs.gate-guards.result }})"',
      '          exit 1',
    ],
  })
  // 2026-09-24 第七轮独立复审 V2 §1.2：同一份判据还有 **11 种写法能静默绕过**
  // （实测：这一步的真 bash 退出码恒为 0，而 `check-workflows` EXIT=0）。其中 7 种连注释
  // 里的认账清单都没提。下面每个形态都逐条实测过"真 bash 退出码 = 0"，必须判红。
  // 统一用同一条 `echo` 行提供 `needs.*.result`（[SK-14] 的链路识别口径），尾行仍是 `exit 1`。
  const LINK_LINK_BODY = (...lines) => [
    '          set -euo pipefail',
    '          echo "::error::根守卫 job 未成功(result=${{ needs.gate-guards.result }})⇒ 门禁整体失败"',
    ...lines.map(line => (line === '' ? '' : `          ${line}`)),
  ]
  // 根因①：边界集不含 `)` ⇒ `case` 分支里的 `exit` 看不见（复审称之为"最容易写出"的形态）。
  gateSample('u29-guard-link-case-branch-zero', '[SK-14]', {
    file: 'ci.yml',
    linkRun: LINK_LINK_BODY('case 1 in', '  1) exit 0 ;;', 'esac', 'exit 1'),
  })
  gateSample('u30-guard-link-case-inline-zero', '[SK-14]', {
    file: 'ci.yml',
    linkRun: LINK_LINK_BODY('case 1 in 1) exit 0 ;; esac', 'exit 1'),
  })
  // 根因②：只允许 `then|do|else` 三个关键字 ⇒ 前缀词看不见（它们不改 `exit` 的语义）。
  gateSample('u31-guard-link-time-prefixed-zero', '[SK-14]', {
    file: 'ci.yml',
    linkRun: LINK_LINK_BODY('time exit 0', 'exit 1'),
  })
  gateSample('u32-guard-link-command-prefixed-zero', '[SK-14]', {
    file: 'ci.yml',
    linkRun: LINK_LINK_BODY('command exit 0', 'exit 1'),
  })
  gateSample('u33-guard-link-builtin-prefixed-zero', '[SK-14]', {
    file: 'ci.yml',
    linkRun: LINK_LINK_BODY('builtin exit 0', 'exit 1'),
  })
  gateSample('u34-guard-link-backslash-escaped-zero', '[SK-14]', {
    file: 'ci.yml',
    linkRun: LINK_LINK_BODY('\\exit 0', 'exit 1'),
  })
  // 根因③：按 `\n` 切语句 ⇒ 行尾续行把一个词劈成两行（`exi\` + `t 0` 在 bash 里是
  // **一个词** `exit 0`；按"续行替换成空格"归一只会得到 `exi t 0`，仍然漏）。
  gateSample('u35-guard-link-continuation-split-word', '[SK-14]', {
    file: 'ci.yml',
    linkRun: LINK_LINK_BODY('exi\\', 't 0', 'exit 1'),
  })
  // 函数包装（复审认账清单里的第一条）：函数体里的 case 分支现在能看见了。
  gateSample('u36-guard-link-function-wrapped-zero', '[SK-14]', {
    file: 'ci.yml',
    linkRun: LINK_LINK_BODY('f() { case 1 in 1) exit 0 ;; esac; }', 'f', 'exit 1'),
  })
  // 复审认账清单里的其余三条：trap / exec / `||`。
  gateSample('u37-guard-link-trap-action-zero', '[SK-14]', {
    file: 'ci.yml',
    linkRun: LINK_LINK_BODY("trap 'exit 0' EXIT", 'exit 1'),
  })
  gateSample('u38-guard-link-exec-replaces-shell', '[SK-14]', {
    file: 'ci.yml',
    linkRun: LINK_LINK_BODY('exec true', 'exit 1'),
  })
  gateSample('u39-guard-link-or-always-true', '[SK-14]', {
    file: 'ci.yml',
    linkRun: LINK_LINK_BODY('true || exit 1'),
  })
  gateSample('u40-guard-link-or-echo-tail', '[SK-14]', {
    file: 'ci.yml',
    linkRun: LINK_LINK_BODY('echo ok || exit 1'),
  })
  // 同一族的另外三张脸（复审报告清单之外，本轮一并收）：`eval` 的参数是会被再解析一次的
  // 代码（参数里先写别的命令，就是为了绕开"命令词被引号拆开"那条）；
  gateSample('u41-guard-link-eval-action-zero', '[SK-14]', {
    file: 'ci.yml',
    linkRun: LINK_LINK_BODY("eval 'set -e; exit 0'", 'exit 1'),
  })
  gateSample('u42-guard-link-exit-function-shadow', '[SK-14]', {
    file: 'ci.yml',
    linkRun: LINK_LINK_BODY('exit() { true; }', 'exit 1'),
  })
  gateSample('u43-guard-link-quote-split-word', '[SK-14]', {
    file: 'ci.yml',
    linkRun: LINK_LINK_BODY('ex"it" 0', 'exit 1'),
  })
  gateSample('u44-guard-link-quote-split-empty', '[SK-14]', {
    file: 'ci.yml',
    linkRun: LINK_LINK_BODY('""exit 0', 'exit 1'),
  })
  // 假阳性防护（收紧到"能静态认出"的边界就够，不能把正常写法一起判红）：
  gateSample('u45-guard-link-case-without-exit-green', null, {
    file: 'ci.yml',
    linkRun: LINK_LINK_BODY(
      'case "${{ needs.gate-guards.result }}" in',
      '  success) echo ok ;;',
      'esac',
      'exit 1',
    ),
  })
  gateSample('u46-guard-link-quoted-exit-text-green', null, {
    file: 'ci.yml',
    linkRun: LINK_LINK_BODY('echo "case 1 in 1) exit 0 ;; esac"', 'exit 1'),
  })
  gateSample('u47-guard-link-command-v-or-exit-green', null, {
    file: 'ci.yml',
    linkRun: LINK_LINK_BODY('command -v node >/dev/null || exit 1'),
  })
  gateSample('u48-guard-link-trap-cleanup-green', null, {
    file: 'ci.yml',
    linkRun: LINK_LINK_BODY('trap "rm -rf /tmp/x" EXIT', 'exit 1'),
  })
  gateSample('u49-guard-link-exec-redirect-green', null, {
    file: 'ci.yml',
    linkRun: LINK_LINK_BODY('exec 2>&1', 'exit 1'),
  })
  gateSample('u50-guard-link-quoted-exit-argument-green', null, {
    file: 'ci.yml',
    linkRun: LINK_LINK_BODY('echo "exit"', 'exit 1'),
  })
  // 2026-09-24 第八轮审计 R8-C-1(P1):把守卫运行步的命令**注释掉** —— SK-9② 读原始
  // 文本时"恰好一个守卫 job"照样成立,而 [SK-14] 的 `root-guard-runner` 读可执行文本、
  // 不再命中 ⇒ 覆盖 5→4 静默、`gate-guards` 一个根守卫都不跑、门禁 EXIT=0。
  gateSample('u51-guard-runner-commented-out', '[SK-9]', {
    file: 'ci.yml',
    guardRunLines: ['set -euo pipefail', '# node scripts/check-root-guards.mjs', 'echo guards-skipped'],
  })
  // 第八轮审计 R8-C-2(P1):把收尾 `exit 1` 只写成注释(`# exit 1` + `true`)。
  // 旧实现里 SK-9③ 读原始文本(照样满足)、`root-guard-link` 读可执行文本(不再命中)⇒
  // 步骤体判据整条不执行、门禁 EXIT=0,而这一步真实退出码 0。整行**删掉**则会被抓住,
  // 只有"注释形态"能同时骗过两条判据 —— 这正是两份口径分裂的教科书形态。
  gateSample('u52-guard-link-exit-commented-out', '[SK-9]', {
    file: 'ci.yml',
    linkRun: LINK_LINK_BODY('true', '# exit 1'),
  })
  // 第八轮审计 R8-C-3(P2)的残余词法族:here-doc 的**终止词不是命令**,而它长得就像
  // 尾部的失败收尾(`exit 1` 那一行);`source` + here-string 则把代码藏在参数里。
  gateSample('u53-guard-link-heredoc-terminator', '[SK-14]', {
    file: 'ci.yml',
    linkRun: LINK_LINK_BODY("cat <<'exit 1'", 'guards failed', 'exit 1'),
  })
  gateSample('u54-guard-link-source-herestring', '[SK-14]', {
    file: 'ci.yml',
    linkRun: LINK_LINK_BODY("source /dev/stdin <<< 'exit 0'", 'exit 1'),
  })
  // 反例:正常的 here-doc(打印诊断)与正常的 `source <脚本>` 不得误报。
  gateSample('u55-guard-link-heredoc-message-green', null, {
    file: 'ci.yml',
    linkRun: LINK_LINK_BODY("cat <<'MSG'", '::error::根守卫 job 未成功', 'MSG', 'exit 1'),
  })
  gateSample('u56-guard-link-source-script-green', null, {
    file: 'ci.yml',
    linkRun: LINK_LINK_BODY('source ./scripts/ci-brand-mask.sh', 'exit 1'),
  })
  // 2026-09-24 第八轮审计 D 泳道的四条 P1(全部与"被钉步骤/守卫调用点"同族):
  //   D-21 守卫运行步加 `--list`(只打印清单、恒退 0)⇒ argv 钉子;
  //   D-18 收尾换成**函数定义**(定义不执行)⇒ 尾部必须是直接执行的 exit;
  //   D-19 `shell: python` + `sys.exit(0)`(SK-14 对非 POSIX shell 整段跳过)⇒ shell 钉子。
  gateSample('u57-guard-runner-list-arg', '[SK-14]', {
    file: 'ci.yml',
    guardRun: `node ${DOCS_ONLY_GUARD_RUNNER} --list`,
  })
  gateSample('u58-guard-link-function-definition-tail', '[SK-14]', {
    file: 'ci.yml',
    linkRun: LINK_LINK_BODY('report_guards() { echo "guards ok"; exit 1; }'),
  })
  gateSample('u59-guard-link-shell-python', '[SK-14]', {
    file: 'ci.yml',
    linkShell: 'python',
    linkRun: [
      '          import sys',
      '          print("guards ok")',
      '          sys.exit(0)',
    ],
  })
  // 正反样本(反例必须继续放行,否则判据会被逼着放宽):
  //   · 无名花括号组**会真的执行** `exit`,`{ …; exit 1; }` 依然是合格收尾;
  //   · 显式 `shell: bash` 是登记形态;
  //   · 守卫运行步不带任何参数(o1 已覆盖,这里再钉一次带注释的形态)。
  gateSample('u60-guard-link-brace-group-tail-green', null, {
    file: 'ci.yml',
    linkRun: LINK_LINK_BODY('{ echo "guards failed"; exit 1; }'),
  })
  gateSample('u61-guard-link-explicit-bash-green', null, {
    file: 'ci.yml',
    linkShell: 'bash',
    linkRun: LINK_LINK_BODY('exit 1'),
  })
  // 第八轮审计 D-24(P3):同一 job 里一个 `shell: python` 步骤不得把**后续块**也变成
  // python(旧判据按缩进 8–12 认 job 默认 shell,而 step 级 `shell:` 正好在 8 ⇒ 泄漏)。
  // 泄漏一旦发生,后面那些块会被当非 POSIX ⇒ `bash -n` 与 [SK-14] 的覆盖整段失效。
  // `function exit { … }` 这一形态**只有** ①d 抓得住:旧边界只看 `{`/`;` 之后紧跟的
  // `exit`,而 `function` 与 `exit` 之间隔着一个关键字 ⇒ 旧判据看不见它(实测 EXIT=0),
  // 而函数优先于内建 ⇒ 尾部那句 `exit 1` 调的是函数(退出码 0)。
  gateSample('u63-guard-link-exit-function-keyword', '[SK-14]', {
    file: 'ci.yml',
    linkRun: LINK_LINK_BODY('function exit { true; }', 'exit 1'),
  })
  gateSample('u62-step-shell-does-not-leak-green', null, {
    file: 'ci.yml',
    guardPreSteps: [
      '      - name: Probe (python, 只影响这一步)',
      '        shell: python',
      '        run: sys.exit(0)',
    ],
  })

  // ---- 策略 12([SK-16]):CI 不得打开 advisory 静音开关(2026-09-23 R7-C P2-1) ----
  //
  // 现场:`--allow-advisory` 能把"advisory 守卫失败"从拦门禁降级成只打一行告警,而
  // `check-root-guards.mjs` 的用法注释写着"CI 的任何调用都不得带它(check-workflows
  // 会钉住)" —— 实际上只钉了"这一步在跑",把它加到守卫运行步上 EXIT=0。
  gateSample('v1-guard-runner-advisory-opt-in', '[SK-16]', {
    file: 'ci.yml',
    guardRun: `node ${DOCS_ONLY_GUARD_RUNNER} --allow-advisory`,
  })
  // 同一张脸的另一处调用点:编排器别名(`yarn check`)。
  gateSample('v2-gate-advisory-opt-in', '[SK-16]', { file: 'ci.yml', gateRun: 'yarn check --allow-advisory' })
  // 用 env 拼进 argv:命令文本里看不见 `--allow-advisory`(所以 ① 不命中),只有 ② 咬得住
  // —— 这条样本专门证明 ② 不是死判据(它必须在 ① 沉默时报出来)。
  gateSample('v3-guard-runner-advisory-opt-in-via-env', '[SK-16]', {
    file: 'ci.yml',
    guardStepEnv: [`          ROOT_GUARD_FLAGS: '${ADVISORY_OPT_IN_FLAG}'`],
    guardRun: `node ${DOCS_ONLY_GUARD_RUNNER} "$ROOT_GUARD_FLAGS"`,
  })
  // 注释里写历史写法不该触发判据(与 `o2-weakening-in-comment` 同一口径:注释不是命令,
  // `executableScript` 先剥注释再判)。这里用块标量形态:compact 单行 `- run: … # 注释`
  // 会撞上 [SK-7] 的"步骤数 = bash -n 块数"对账(YAML 把 ` #` 之后当注释、抽取器不当),
  // 那是既有形态差异,不在本判据的射程内。
  gateSample('v4-advisory-opt-in-in-comment-green', null, {
    file: 'ci.yml',
    linkRun: [
      '          set -euo pipefail',
      `          # 本地调试可临时给守卫加 ${ADVISORY_OPT_IN_FLAG}(CI 里不许)`,
      '          echo "::error::根守卫 job 未成功(result=${{ needs.gate-guards.result }})⇒ 门禁整体失败"',
      '          exit 1',
    ],
  })
  // 2026-09-24 第七轮独立复审 V2 §2.2/§2.3：同一个开关还有两条**运行期**通道，
  // 判据①②都看不见（实测 `check-workflows` EXIT=0，且复审用 argv 替身证明旗标真的
  // 送到了守卫、干净探针证明它真能把「已登记 advisory 的守卫失败」从 EXIT=1 翻成 EXIT=0）。
  //
  // 缺口一：**workflow 顶层 `env:`** —— 它被每个 job 的每个 step 继承，而旧实现只读
  // step/job 的 env。命令里只写 `$ROOT_GUARD_FLAGS`，字面量一个都不出现。
  gateSample('v5-workflow-env-advisory-opt-in', '[SK-16]', {
    file: 'ci.yml',
    workflowEnv: [
      "  DSH_TELEMETRY_DISABLED: '1'",
      // YAML 里 `--` 开头是合法纯量（不是 tag 指示符）；真要引号也可以，判据两种都认。
      `  ROOT_GUARD_FLAGS: ${ADVISORY_OPT_IN_FLAG}`,
    ],
    guardStepEnv: null,
    guardRun: `node ${DOCS_ONLY_GUARD_RUNNER} $ROOT_GUARD_FLAGS`,
  })
  // 缺口二的判定形态之一：拆分字面量（`--allow-""advisory`）—— 运行期由 `$GITHUB_ENV`
  // 注入，字面量被引号切开（`carriesAdvisoryFlag` 的"词级归一"咬它）。
  gateSample('v6-github-env-split-literal', '[SK-16]', {
    file: 'ci.yml',
    guardPreSteps: [
      '      - name: Export guard flags',
      '        run: |',
      '          set -euo pipefail',
      `          echo "ROOT_GUARD_FLAGS=--allow-""advisory" >> "$GITHUB_ENV"`,
    ],
    guardRun: `node ${DOCS_ONLY_GUARD_RUNNER} $ROOT_GUARD_FLAGS`,
  })
  // 缺口二的判定形态之二：字面量根本不出现（变量名被后续守卫步消费）—— 由 ①c 的
  // "同 job + 位置在前"那一半咬住。
  gateSample('v7-github-env-dynamic-injection', '[SK-16]', {
    file: 'ci.yml',
    guardPreSteps: [
      '      - name: Export guard flags',
      '        run: |',
      '          set -euo pipefail',
      '          FLAG="--allow-$(printf %s advisory)"',
      '          echo "ROOT_GUARD_FLAGS=$FLAG" >> "$GITHUB_ENV"',
    ],
    guardRun: `node ${DOCS_ONLY_GUARD_RUNNER} $ROOT_GUARD_FLAGS`,
  })
  // 反例：顶层 `env:` 与 `$GITHUB_ENV` **正常用法**不得误报（真 ci.yml 的顶层 env 就是
  // `DSH_TELEMETRY_DISABLED`；steps 里写 `$GITHUB_OUTPUT` 是本仓到处都在用的写法）。
  // 缺口三(第八轮审计 D-20):字面量被引号切开后写进**同一步的赋值语句**,命令里只剩
  // `$FLAG` ⇒ 判据①(裸子串)与判据②(env)都看不见。块形态(带 `set -euo pipefail`)实测 EXIT=0。
  // 缺口一的可判据样本(第八轮复审 V2 §2.2 + R8-D 同族):顶层 `env:` 里放着开关,
  // 而这份 workflow **没有任何守卫/编排器调用点** —— 此时判据②无从谈起,只有 ①b 咬得住
  // (它读的是 document 顶层 env,与"有没有被引用/有没有调用点"无关)。
  gateSample('v10-workflow-env-without-guard-invocation', '[SK-16]', {
    file: 'ci.yml',
    guardJob: false,
    workflowEnv: [`  ROOT_GUARD_FLAGS: ${ADVISORY_OPT_IN_FLAG}`],
    gateRun: 'echo hi',
  })
  gateSample('v9-guard-step-concat-flag', '[SK-16]', {
    file: 'ci.yml',
    guardRunLines: [
      'set -euo pipefail',
      'FLAG="--allow-""advisory"',
      'node scripts/check-root-guards.mjs $FLAG',
    ],
  })
  gateSample('v8-workflow-env-unrelated-green', null, {
    file: 'ci.yml',
    workflowEnv: ["  DSH_TELEMETRY_DISABLED: '1'"],
    guardPreSteps: [
      '      - name: Export telemetry flag',
      '        run: |',
      '          set -euo pipefail',
      '          echo "CI_CHANNELS_PIN=guards-ran" >> "$GITHUB_ENV"',
    ],
    guardRun: `node ${DOCS_ONLY_GUARD_RUNNER}`,
  })

  // ---- 策略 13([SK-17]):被钉步骤/守卫 job 的**进程环境层**(2026-09-25 第九轮审计 D 泳道) ----
  //
  // 现场:第八轮把 [SK-14] 的判据搬到"执行视角"(argv / 解析后的 shell / 步骤体 / `if:` /
  // `$GITHUB_ENV` 的**取值**)是对的,但那四条通道全都在"命令怎么被写出来"这一层。审计方
  // 实跑确认两类形态**不改 argv、不改 shell、不改步骤体、不需要任何新增文件**就能让
  // "永不跳过"的根守卫 job 静默变绿:
  //   形态 A  `env: NODE_OPTIONS: "--import=data:text/javascript,process.on('exit',()=>{process.exitCode=0})"`
  //   形态 B  `env: BASH_ENV: ./.github/shell-hooks.sh`(内含 `node() { return 0; }`)
  // 两者都让 `check-workflows` EXIT=0;而真跑 `check-root-guards.mjs` 时,形态 A 在有 7 个
  // 守卫失败的树上仍打印「16 个根守卫:16 通过、0 失败」并 EXIT=0。
  //
  // 下面的样本按**位置 × 键族**逐格覆盖(每一格都是一条独立的绕过路径,删掉哪一格,
  // 对应的键/位置就会静默回到"没人看着"的状态 —— `SELFTEST_REQUIRED_SAMPLES` 逐条点名):
  //   位置:job 级(④)/ step 级(⑤)/ workflow 顶层(③)/ `$GITHUB_ENV`(⑥b)/ `$GITHUB_PATH`(⑥a);
  //   单元:根守卫 job 的守卫步、`gate` 的收尾链路步、被钉住的**全量门禁**步;
  //   键族:审计点名键(NODE_OPTIONS/BASH_ENV/SHELLOPTS/PATH)+ 前缀形态(`BASH_FUNC_`)+
  //         大小写变体(Windows 上 `Path` 就是 `PATH`)。
  const SK17_NODE_OPTIONS = `--import=data:text/javascript,process.on('exit',()=>{process.exitCode=0})`
  // 形态 A 的最省事挂点(job 级 `env:`)。
  gateSample('w1-node-options-guard-job-env', '[SK-17]', {
    file: 'ci.yml',
    guardJobEnv: [`      NODE_OPTIONS: "${SK17_NODE_OPTIONS}"`],
  })
  // 形态 B 的最省事挂点(守卫步的 step 级 `env:` ⇐ 审计方实跑的两条形态之一)。
  gateSample('w2-bash-env-guard-step-env', '[SK-17]', {
    file: 'ci.yml',
    guardStepEnv: ['          BASH_ENV: ./.github/shell-hooks.sh'],
  })
  // 位置③:workflow 顶层 `env:` —— 注入每个 job 的每个 step(命令里连字面量都不出现)。
  gateSample('w3-node-options-workflow-env', '[SK-17]', {
    file: 'ci.yml',
    workflowEnv: ["  DSH_TELEMETRY_DISABLED: '1'", `  NODE_OPTIONS: "${SK17_NODE_OPTIONS}"`],
  })
  // 位置⑥b:`$GITHUB_ENV` 运行期注入键名(第八轮只扫了这个通道的**取值**层面)。
  gateSample('w4-github-env-node-options', '[SK-17]', {
    file: 'ci.yml',
    guardPreSteps: [
      '      - name: Export interpreter flags',
      '        run: |',
      '          set -euo pipefail',
      `          echo "NODE_OPTIONS=${SK17_NODE_OPTIONS}" >> "$GITHUB_ENV"`,
    ],
  })
  // 前缀形态:导出的 shell 函数(`BASH_FUNC_node%%`),连 hook 文件都不需要。
  gateSample('w5-bash-func-guard-step-env', '[SK-17]', {
    file: 'ci.yml',
    guardStepEnv: ['          BASH_FUNC_node%%: "() { return 0; }"'],
  })
  // 位置⑥a:`$GITHUB_PATH` = PATH 覆写(与 `env: PATH:` 同级,命令名一字未改)。
  gateSample('w6-github-path-append', '[SK-17]', {
    file: 'ci.yml',
    guardPreSteps: [
      '      - name: Prepend a shim directory',
      '        run: |',
      '          set -euo pipefail',
      '          echo "$PWD/scripts/shim" >> "$GITHUB_PATH"',
    ],
  })
  // 单元:`gate` 的收尾链路步(根守卫失败 ⇒ 必需 Gate 红 的**唯一**链路)。
  gateSample('w7-pinned-link-step-shellopts', '[SK-17]', {
    file: 'ci.yml',
    linkStepEnv: ['          SHELLOPTS: errexit'],
  })
  // 单元:被钉住的**全量门禁**步(它的退出码就是 gate job 的结论)。
  gateSample('w8-pinned-full-gate-node-options', '[SK-17]', {
    file: 'ci.yml',
    gateStepExtraEnv: [`          NODE_OPTIONS: "${SK17_NODE_OPTIONS}"`],
  })
  // 大小写变体:Windows runner 上环境变量名不区分大小写(`Path` 就是 `PATH`),一律按大写判。
  gateSample('w9-guard-env-key-case-variant', '[SK-17]', {
    file: 'ci.yml',
    guardJobEnv: ['      Bash_Env: ./.github/shell-hooks.sh'],
  })
  // **绿样本 1**(不得误伤):守卫 job 上的合法 env 必须照常通过 —— 判据拒的是"改解释器
  // 行为"的键,不是"给守卫 job 传 env"这件事本身。
  gateSample('w10-guard-env-legit-keys-green', null, {
    file: 'ci.yml',
    guardJobEnv: [
      "      DSH_TELEMETRY_DISABLED: '1'",
      '      VERSION: "1.2.3"',
      '      R2_BUCKET: artifacts',
      '      AWS_DEFAULT_REGION: auto',
    ],
    guardStepEnv: ['          VERSION: "1.2.3"'],
    guardPreSteps: [
      '      - name: Export build metadata',
      '        run: |',
      '          set -euo pipefail',
      '          echo "CI_CHANNELS_PIN=guards-ran" >> "$GITHUB_ENV"',
    ],
  })
  // **绿样本 2**(不得一刀切):`NODE_OPTIONS: --max-old-space-size=…` 是本仓/业界真实存在
  // 的合法用法 —— 它落在**非判据步骤**上(与"判据结论"无关)时必须照常通过。判据的面是
  // "被钉住的判据步骤 / 根守卫 job",不是"整个文件里不许出现这个键"。
  gateSample('w11-unpinned-step-node-options-green', null, {
    file: 'ci.yml',
    changesStepEnv: ['          NODE_OPTIONS: "--max-old-space-size=4096"'],
  })
  // **绿样本 3**(不得一刀切):`$GITHUB_PATH` 在**没有判据步骤**的 job 里是正常写法
  // (装工具链的标准姿势);它只在"后面还有被钉单元会继承它"时才红。
  gateSample('w12-unpinned-github-path-green', null, {
    file: 'ci.yml',
    changesExtraSteps: [
      '      - name: Prepend a toolchain directory',
      '        run: |',
      '          set -euo pipefail',
      '          echo "$PWD/tools/bin" >> "$GITHUB_PATH"',
    ],
  })

  // ---- 第十轮审计 C-01:黑名单 → **白名单**(未登记即红) ----
  //
  // 现场(审计方端到端实跑):`COREPACK_HOME` 不在第九轮的禁用表里 ⇒ 给守卫 job 加一步
  // `echo "COREPACK_HOME=/tmp/yc" >> "$GITHUB_ENV"`(目录里放一个 `process.exit(0)` 的
  // `v1/yarn/4.18.0/yarn.js`)之后,判据 EXIT=0 而 16 个根守卫**全部换成攻击者的解释器**
  // 跑(实测:同树不带该变量是「7 通过、9 失败」EXIT=1)。逐个补名字追不上下一层,所以判据
  // 反过来了:被钉单元上的每个 env 键都必须登记在 `PINNED_ENV_ALLOWED_KEYS` 里。
  gateSample('w13-guard-job-unregistered-env-key', '[SK-17]', {
    file: 'ci.yml',
    guardJobEnv: ['      COREPACK_HOME: /tmp/yc'],
  })
  // 同一族的"键名变体"样本(第九轮的黑名单按大写归一,白名单按**逐字**比较):
  // `Path` 在 Windows runner 上就是 `PATH`,未登记 ⇒ 红。
  gateSample('w13b-guard-job-case-variant-unregistered', '[SK-17]', {
    file: 'ci.yml',
    guardJobEnv: ['      Path: /tmp/shim'],
  })
  // ---- 第十轮审计 C-02:Actions 的**第四层** `jobs.<id>.container.env` ----
  //
  // 现场(MAINCTL-2 的判别性对照):同一个键写在 job 级 `env:` 被抓、写在 `container.env`
  // 上静默通过,而通过行还照样打印"三层 `env:` … 均已检查"(`grep -c container` = 0)。
  //
  // **P3-D3（第十轮复审 V1）**:这条判据面里其实有**两条**独立分支 ——"容器镜像登记"与
  // "已登记镜像下的 `container.env` 键白名单"。旧样本把两者写在同一个 YAML 里(未登记的
  // 镜像 + 危险键),于是**只删掉第四层键判定循环**(691B)时样本照样红(被镜像那条顶替),
  // 而 `PINNED_JOB_CONTAINER_REGISTRY=[]` 又保证镜像那条永远命中 ⇒ 分支②没有任何样本守着
  // (本项目登记的第 2 类假绿:只钉字符串不钉能力)。现在拆成两条,各自单独可红:
  //   ① `w14`  —— 容器**镜像**未登记(不带 `env:`,把第四层键那条分支排除在外);
  //   ② `w14b` —— 镜像**已登记**(经 `registries.containerImages` 测试缝单独放行),
  //      只剩 `container.env` 里的 `NODE_OPTIONS` ⇒ 只有键白名单那条分支能让它红。
  gateSample('w14-container-image-unregistered', '[SK-17]', {
    file: 'ci.yml',
    guardContainer: [
      '    container:',
      '      image: node:24-bookworm',
    ],
  })
  gateSample('w14b-container-env-node-options', '[SK-17]', {
    file: 'ci.yml',
    guardContainer: [
      '    container:',
      '      image: node:24-bookworm',
      '      env:',
      `        NODE_OPTIONS: "${SK17_NODE_OPTIONS}"`,
    ],
    // 镜像登记放行 ⇒ 命中只可能来自"第四层键白名单"那一条分支。
    registries: {
      ...REGISTRY_NONE,
      containerImages: [{ image: 'node:24-bookworm', why: '合成样本:单独放行镜像登记,只留 container.env 的键判定' }],
    },
  })
  // ---- [SK-18] 被钉单元的**执行目录**(第十轮审计 C-04,本轮修复) ----------------
  //
  // 现场(审计方实跑):给 `gate-guards` 加两行
  //   `defaults: / run: / working-directory: /tmp/decoy`
  // ⇒ `check-workflows` **EXIT=0**:argv 一字未改,命令却在**另一个目录**里被解析
  // (`node scripts/…` 的相对路径、`package.json`、`.yarnrc.yml` 全部来自那个目录)。
  // 判据走**登记制**(`PINNED_JOB_WORKING_DIRECTORY_REGISTRY`),例外只认逐字匹配。
  gateSample('w20-guard-job-defaults-working-directory', '[SK-18]', {
    file: 'ci.yml',
    guardJobWorkingDirectory: '/tmp/decoy',
  })
  // 第二个入口:**步骤级** `working-directory` —— 只影响这一步,但这"一步"恰好是被钉的
  // 全量门禁步时,效果与 job 级完全一样(给 `yarn check` 换一个解析目录)。
  gateSample('w21-pinned-gate-step-working-directory', '[SK-18]', {
    file: 'ci.yml',
    gateStepWorkingDirectory: '/tmp/decoy',
  })
  // **绿样本**(不得一刀切):`working-directory` 落在**非判据步骤**上是本仓真实存在的
  // 正常写法(`ci.yml` 的 `npm ci` / `npm test` 就带 `working-directory: server/webadmin`)——
  // 判据的面是"被钉单元",不是"整个文件里不许出现这个键"。
  gateSample('w22-unpinned-step-working-directory-green', null, {
    file: 'ci.yml',
    changesStepWorkingDirectory: 'server/webadmin',
  })
  // ---- [SK-18] 第十轮**复审 W1** 的 N1:**workflow 顶层** `defaults.run.working-directory` ----
  //
  // 现场(W1 探针实跑):顶层写
  //   `defaults: / run: / working-directory: <已存在的目录>`
  // ⇒ **所有 job**(含 `gate-guards` 的根守卫步、`gate` 的全量门禁步)都在那个目录里解析,
  // 而旧判据只读 `jobs.<id>.defaults` ⇒ `check-workflows` **EXIT=0**。同一机理、同一收益。
  // 现在两个入口同扫,顶层同样走**逐字登记制**(`WORKFLOW_LEVEL_WORKING_DIRECTORY_REGISTRY`,
  // 当前为空 ⇒ 未登记即红)。
  gateSample('w26-workflow-defaults-working-directory', '[SK-18]', {
    file: 'ci.yml',
    workflowWorkingDirectory: '/tmp/decoy',
  })
  // **绿样本**(不得一刀切):顶层 cwd 走**逐字登记**时放行 —— 证明这条判据是"登记制"而不是
  // "文件里不许出现顶层 `defaults.run.working-directory`"(登记表为空 ⇒ 顶层非空即红)。
  // 登记表经与 `containerImages` 同一个 `registries` 测试缝注入,只对合成样本生效。
  gateSample('w27-workflow-defaults-working-directory-green', null, {
    file: 'ci.yml',
    workflowWorkingDirectory: '/tmp/legacy',
    registries: {
      ...REGISTRY_NONE,
      workflowWorkingDirectories: [{
        workflow: 'ci.yml',
        workingDirectory: '/tmp/legacy',
        why: '合成样本:顶层 cwd 逐字登记后放行,证明判据是登记制而非一刀切',
      }],
    },
  })
  // 同族第二格:**job 级**登记例外也必须真的能放行(绿样本)——
  // `PINNED_JOB_WORKING_DIRECTORY_REGISTRY` 里本仓真实存在一条(`server` job),这条用测试缝
  // 复刻同一形状。缺了它,"登记制"就只有红样本、没有"登记后确实变绿"的证据。
  gateSample('w28-guard-job-working-directory-registered-green', null, {
    file: 'ci.yml',
    guardJobWorkingDirectory: 'sub',
    registries: {
      ...REGISTRY_NONE,
      jobWorkingDirectories: [{
        job: 'gate-guards',
        workingDirectory: 'sub',
        why: '合成样本:job 级 cwd 逐字登记后放行(证登记表承重且不是一刀切)',
      }],
    },
  })

  // ---- [SK-19] YAML **合并键** `<<`(第十轮审计 C-05,本轮修复) ------------------
  //
  // 现场:`yaml` 解析器默认**不展开** merge key ⇒ `env: { <<: *base }` 解析成字面键 `<<`,
  // 被合并进来的键在判据面(`env:` 各层 / `container:` / `steps:` / `with:` / `defaults:`)
  // 上**一个都不出现**;而 Actions 在运行期会展开它(YAML 1.1)⇒ 判据看到的与 runner 执行的
  // 不是同一份语义。判据 fail-closed:出现合并键即红(可以藏掉 `steps:` 本身)。
  gateSample('w23-guard-job-merge-key', '[SK-19]', {
    file: 'ci.yml',
    rawPrefix: [
      'x-job-base: &job-base',
      '  env:',
      `    NODE_OPTIONS: "${SK17_NODE_OPTIONS}"`,
      '',
    ],
    guardJobMergeKey: '*job-base',
  })
  gateSample('w24-env-merge-key', '[SK-19]', {
    file: 'ci.yml',
    rawPrefix: [
      'x-env-base: &env-base',
      `  NODE_OPTIONS: "${SK17_NODE_OPTIONS}"`,
      '',
    ],
    // `env:` 里只有一行合并键 —— 被合并进来的 `NODE_OPTIONS` 在判据面上不可见
    // (`jobs.gate-guards.env` 解析结果只剩一个 `<<`)。
    guardJobEnv: ['      <<: *env-base'],
  })
  // **绿样本**(不得一刀切):普通**别名**(`env: *env-base`)解析后键是**可见**的 ——
  // 判据照常按白名单判它;只有 `<<` 合并键会让键隐形。这条对照证明判据打的是 merge key,
  // 不是"文件里出现了锚点/别名"。
  gateSample('w25-anchored-alias-env-green', null, {
    file: 'ci.yml',
    rawPrefix: [
      'x-env-safe: &env-safe',
      "  DSH_TELEMETRY_DISABLED: '1'",
      '',
    ],
    guardJobEnvAlias: '*env-safe',
  })
  // ---- [SK-19] 第十轮**复审 W1** 的 N2:**workflow 顶层** `defaults` 上的合并键 ----
  //
  // 现场(W1 探针实跑):顶层 `x-shell: &s {shell: bash}` + `defaults: {run: {<<: *s}}`
  // ⇒ 旧 `scan` 覆盖面不含 `document.defaults` ⇒ EXIT=0。而 workflow 级 `defaults.run`
  // 一次作用于**所有 job**,与 N1 组合可同时藏掉 cwd 与 `defaults` 下的其它键。
  // 现在顶层 `defaults:` / `defaults.run:` 与 job 级同扫。
  gateSample('w29-workflow-defaults-merge-key', '[SK-19]', {
    file: 'ci.yml',
    rawPrefix: [
      'x-shell-base: &shell-base',
      '  shell: bash',
      '',
    ],
    workflowDefaultsExtra: ['    <<: *shell-base'],
  })
  // **绿样本**(不得一刀切):顶层 `defaults.run` 上写**普通显式键**(本仓合法且常见的形态,
  // 例如 `shell: bash`)解析后键是可见的 ⇒ 与 `<<` 无关的写法不许被误伤。
  gateSample('w30-workflow-defaults-explicit-key-green', null, {
    file: 'ci.yml',
    workflowDefaultsExtra: ['    shell: bash'],
  })

  // ---- 第十轮审计 D-03:被钉步骤**自己的步骤体**里的 `export`/前缀赋值 ----
  //
  // 现场(审计方实跑):守卫步里加一行 `export NODE_OPTIONS=…` 之后判据 EXIT=0,而真跑
  // 那条命令时 16 个守卫打印「1 项未通过」却 EXIT=0(`process.env` 被原样透传 + 退出钩子
  // 把 `process.exitCode` 改回 0)。前半条判据在这里,后半条(环境清洗 + 显式退出)在
  // `scripts/check-root-guards.mjs`。
  gateSample('w15-step-body-export-node-options', '[SK-17]', {
    file: 'ci.yml',
    guardRunLines: [
      'set -euo pipefail',
      `export NODE_OPTIONS="${SK17_NODE_OPTIONS}"`,
      `node ${DOCS_ONLY_GUARD_RUNNER}`,
    ],
  })
  // 同族第二种写法:**命令位前缀赋值**(`NODE_OPTIONS=… node …`),env 块里一个字都没有。
  gateSample('w16-step-body-prefix-assignment', '[SK-17]', {
    file: 'ci.yml',
    guardRunLines: [
      'set -euo pipefail',
      `NODE_OPTIONS="${SK17_NODE_OPTIONS}" node ${DOCS_ONLY_GUARD_RUNNER}`,
    ],
  })
  // **绿样本**(不得一刀切):登记键的 `export` 是正常写法(守卫步里导出 VERSION 之类),
  // 以及**不导出**的普通赋值(子进程看不见)更不许误伤 —— 本仓 `ci.yml` 的
  // `GO_TEST_STATUS=0` / `CHECK_STATUS=0` 正是后者。
  gateSample('w17-step-body-registered-assignment-green', null, {
    file: 'ci.yml',
    guardRunLines: [
      'set -euo pipefail',
      'GO_TEST_STATUS=0',
      'export VERSION="1.2.3"',
      'CHECK_STATUS=$?',
      `node ${DOCS_ONLY_GUARD_RUNNER}`,
    ],
  })
  // ---- 第十一轮复审 J1 的 N2:步骤体里**清除**环境变量(与上面两条"写入"互补) ----
  //
  // 现场(审计方实跑):把 `set -euo pipefail` + `unset CI GITHUB_ACTIONS` 写进 `gate-guards` 的
  // 守卫步骤体之后,`check-workflows` EXIT=**0**(旧判据只认 `export`/前缀赋值),而同一棵树
  // 真跑 `node scripts/check-guard-parser-integrity.mjs` 时"git 锚定"从 CI 硬判据降级成本地告警
  // ⇒ `CI=true …` = 1、`env -u CI -u GITHUB_ACTIONS …` = **0**。删除只会让判据降级,不会报错。
  gateSample('w24-step-body-unset-ci', '[SK-17]', {
    file: 'ci.yml',
    guardRunLines: [
      'set -euo pipefail',
      'unset CI GITHUB_ACTIONS',
      `node ${DOCS_ONLY_GUARD_RUNNER}`,
    ],
  })
  // 同族第二种写法:`env -u NAME` / `env --unset=NAME`(前缀词 `env` 后面的 `-u` 会被通用前缀
  // 扫描当普通选项跳过,所以这一形态必须在解析器里**单独**认)。
  gateSample('w25-step-body-env-unset-ci', '[SK-17]', {
    file: 'ci.yml',
    guardRunLines: [
      'set -euo pipefail',
      `env -u CI -u GITHUB_ACTIONS node ${DOCS_ONLY_GUARD_RUNNER}`,
    ],
  })
  // **绿样本**(不得一刀切):同一个 `unset` 写在**没有判据步骤**的 job 里是正常写法
  // (清理环境再跑分类器)。判据面只覆盖"会被判据步骤继承"的位置。
  gateSample('w26-unpinned-step-unset-green', null, {
    file: 'ci.yml',
    changesExtraSteps: [
      '      - name: Normalize environment for the classifier',
      '        run: |',
      '          set -euo pipefail',
      '          unset CI GITHUB_ACTIONS',
      '          echo "classifier"',
    ],
  })
  // 前序步骤写 `$GITHUB_ENV` 的键同样按白名单判(C-01 的攻击就是从这里进来的);
  // 注意 `$GITHUB_OUTPUT` 不注入进程环境 ⇒ 输出名(如 `code=`)不在判据面内(见 GITHUB_ENV_APPEND)。
  gateSample('w18-github-env-unregistered-key', '[SK-17]', {
    file: 'ci.yml',
    guardPreSteps: [
      '      - name: Warm yarn cache metadata',
      '        run: |',
      '          set -euo pipefail',
      '          echo "COREPACK_HOME=/tmp/yc" >> "$GITHUB_ENV"',
    ],
  })
  // ---- 第十轮审计 C-03 / MAINCTL-3:被钉单元里的 `uses:` 委派目标 ----
  //
  // 现场:插一步 `uses: ./.github/actions/poison` 之后,判据把它**算进了"被钉住的判定单元"**
  // (单元数 10 → 11)却从不读它的内容,EXIT=0;而那个 composite action 里的
  // `echo NODE_OPTIONS=… >> $GITHUB_ENV` 跨步骤生效。本样本钉住"未登记的远端 action 即红",
  // 本地路径 / composite 内容的判据在 `selfTestCompositeActions()` 里(需要合成 action 文件)。
  gateSample('w19-guard-job-unregistered-uses', '[SK-17]', {
    file: 'ci.yml',
    guardUsesSteps: ['      - uses: evil/action@v1'],
  })

  // ---- 第十一轮审计 P1-3:被钉单元里的 **`with:` 输入** ----
  //
  // 现场:审计方 8/8 条 `with:` 变异 `check-workflows` EXIT=0,完整树副本上 13 条根守卫逐条
  // 同形。`uses:` 只钉了 action 的**名字** —— 而"取哪棵树 / 用哪个解释器 / 缓存写进哪些目录"
  // 全在 `with:` 里。下面 8 条与审计方的 8 条同形,逐条钉住。
  const WITH_CHECKOUT = lines => ['      - uses: actions/checkout@v7', '        with:', ...lines]
  const WITH_SETUP_NODE = lines => ['      - uses: actions/setup-node@v7', '        with:', ...lines]
  for (const [id, steps] of [
    ['wa1-with-checkout-repository', WITH_CHECKOUT(['          repository: example/other-repo', '          submodules: recursive'])],
    ['wa2-with-checkout-ref', WITH_CHECKOUT(['          ref: refs/heads/evil', '          submodules: recursive'])],
    ['wa3-with-checkout-token', WITH_CHECKOUT(['          token: ${{ secrets.SOME_OTHER_TOKEN }}', '          submodules: recursive'])],
    ['wa4-with-checkout-sparse', WITH_CHECKOUT(['          sparse-checkout: scripts', '          submodules: recursive'])],
    ['wa5-with-setup-node-major', WITH_SETUP_NODE(['          node-version: 8'])],
    ['wa6-with-setup-node-file', WITH_SETUP_NODE(['          node-version-file: .nvmrc'])],
    ['wa7-with-setup-node-corepack', WITH_SETUP_NODE(['          node-version: 24', '          enable-corepack: true'])],
    ['wa8-with-cache-key', ['      - uses: actions/cache@v6', '        with:',
      '          path: |', '            .yarn/cache',
      "          key: desktop-cache-${{ runner.os }}-fixed"]],
  ]) {
    gateSample(id, '[SK-17]', { file: 'ci.yml', guardUsesSteps: steps })
  }
  // 逐字取值同样要判(登记了键、但取值被改):`fetch-depth: 1` 既有 [SK-8b] 也走 `with:` 白名单。
  gateSample('wa9-with-checkout-fetch-depth-value', '[SK-17]', {
    file: 'ci.yml',
    guardUsesSteps: ['      - uses: actions/checkout@v7', '        with:', '          fetch-depth: 1'],
  })
  // **绿样本**(不得一刀切):与真 ci.yml 逐字同形的三个 `with:` 块必须放行。
  gateSample('wa10-with-registered-values-green', null, {
    file: 'ci.yml',
    guardUsesSteps: [
      ...WITH_CHECKOUT(['          submodules: recursive', '          fetch-depth: 0']),
      ...WITH_SETUP_NODE(['          node-version: 24']),
      '      - uses: actions/cache@v6',
      '        with:',
      '          path: |',
      '            .yarn/cache',
      '            ~/.cache/electron',
      '            ~/.cache/electron-builder',
      "          key: desktop-cache-${{ runner.os }}-${{ hashFiles('yarn.lock') }}",
    ],
  })
  // `with:` 不是映射(这里是最容易被当成"等价写法"的字符串化形态)⇒ 红。
  gateSample('wa11-with-not-a-mapping', '[SK-17]', {
    file: 'ci.yml',
    guardUsesSteps: ['      - uses: actions/checkout@v7', '        with: "fetch-depth: 1"'],
  })

  // ---- 第十一轮审计 P2-1:被钉 job 的 `runs-on`(与 `container:` 同层) ----
  for (const [id, runsOn] of [
    ['wr1-runs-on-self-hosted', 'self-hosted'],
    ['wr2-runs-on-other-image', 'ubuntu-22.04'],
    ['wr3-runs-on-list-form', '[self-hosted, linux]'],
  ]) {
    gateSample(id, '[SK-17]', { file: 'ci.yml', guardRunsOn: runsOn })
  }
  // **绿样本**:登记值本身必须放行(否则登记制只被证明了一半)。
  gateSample('wr4-runs-on-registered-green', null, { file: 'ci.yml', guardRunsOn: GATE_SELFTEST_RUNS_ON })

  // ---- 策略 14(P1-1/P1-2/P1-3/P1-4)与第八轮三条假红的回归(2026-09-25 第九轮审计 B 泳道) ----
  //
  // B 泳道在"同一面"(判据只看文本、不看执行语义)上又找到 5 条 P1,并实测出第八轮新引入的
  // 3 条**假红**。两边的样本都放在这里:红样本钉住绕过形态,绿样本钉住"不得误伤"
  // (FP-1 子 shell 收尾 / FP-2 重定向当参数 / FP-3 env 说明文本 —— 三条都有父提交对照)。
  //
  // P1-1:守卫运行步只被"文本里出现脚本路径"识别 ⇒ 三行 no-op 让 16 个根守卫零执行。
  for (const [id, line] of [
    ['x1-guard-runner-colon-noop', `: ${DOCS_ONLY_GUARD_RUNNER}`],
    ['x2-guard-runner-test-f', `test -f ${DOCS_ONLY_GUARD_RUNNER}`],
    ['x3-guard-runner-echo-literally', `echo "node ${DOCS_ONLY_GUARD_RUNNER}"`],
  ]) {
    const result = gateSample(id, '[SK-9]', {
      file: 'ci.yml',
      guardRunLines: ['set -euo pipefail', line],
    })
    // **判据面**断言(为什么红样本不够):`: <脚本>` 在"识别退回文本子串"时**照样是红的**
    // —— SK-9 的"0 个守卫 job"独立命中,于是把 `root-guard-runner` 的识别改回
    // `script.includes(…)`(变异 m2)之后自检全绿,而 P1-1 的洞原样回来。
    // 这里直接断言**策略命中集合**:这一步不得被当成"被钉住的守卫运行步"。
    expect(!result.pinnedStepPolicies.includes('root-guard-runner'),
      `自检:样本 \`${id}\` 把"提到脚本路径"当成了"执行脚本" —— \`root-guard-runner\` 策略仍然命中`
        + ' ⇒ 识别退回文本子串,`: <脚本>` / `test -f <脚本>` / `echo "node <脚本>"` 重新变成"守卫跑过了"')
  }
  {
    // 正控:真实形态必须仍然被识别(否则 SK-14 的覆盖下限会假红,判据自己把自己咬死)。
    const result = gateSample('x1b-guard-runner-command-position-green', null, { file: 'ci.yml' })
    expect(result.pinnedStepPolicies.includes('root-guard-runner'),
      '自检:真实形态 `- run: node scripts/check-root-guards.mjs` 没有被识别成被钉住的守卫运行步'
        + ' ⇒ 命令位判据收得过紧(会把真实 ci.yml 判成"守卫 job 不存在")')
  }
  // P1-3:`shell:` 模板让脚本体**一次都不执行**(首词仍是 `bash` ⇒ 旧的"首词判据"放行)。
  gateSample('x4-link-shell-template-noop', '[SK-14]', {
    file: 'ci.yml',
    linkShell: "bash -c 'exit 0' {0}",
  })
  gateSample('x5-full-gate-shell-template-noop', '[SK-14]', {
    file: 'ci.yml',
    gateStepShell: "bash -c 'exit 0' {0}",
  })
  // P1-2:链路步的 `trap` 动作是**动态构造**的(引号载荷被屏蔽、动作词不是字面量)。
  gateSample('x6-link-indirect-trap', '[SK-14]', {
    file: 'ci.yml',
    linkRun: [
      '          set -euo pipefail',
      "          A='exit 0'",
      '          trap "$A" EXIT',
      '          echo "::error::root guards failed(result=${{ needs.gate-guards.result }})"',
      '          exit 1',
    ],
  })
  gateSample('x7-link-trap-substitution', '[SK-14]', {
    file: 'ci.yml',
    linkRun: [
      '          set -euo pipefail',
      "          trap \"$(printf '%s %s' exit 0)\" EXIT",
      '          echo "::error::root guards failed(result=${{ needs.gate-guards.result }})"',
      '          exit 1',
    ],
  })
  // P1-4(`echo` 化发布脚本)的样本在 [SK-15] 合成登记表那一节(x8:它要用 sk15Sample)。
  // 绿样本(P1-3 的正确放行):`bash -e {0}` 是 GitHub 官方模板,`{0}` 是**脚本文件参数**
  // ⇒ 脚本体一定被执行,必须继续通过。
  gateSample('x9-shell-template-script-arg-green', null, {
    file: 'ci.yml',
    linkShell: 'bash -e {0}',
  })
  // 绿样本(FP-1,第八轮新引入的假红):子 shell 收尾 `( exit 1 )` 与 `{ …; exit 1; }`
  // 执行视角等价,父提交 `3d4306dded` 上实测 EXIT=0。
  gateSample('x10-link-subshell-tail-green', null, {
    file: 'ci.yml',
    linkRun: [
      '          set -euo pipefail',
      '          echo "::error::root guards failed(result=${{ needs.gate-guards.result }})"',
      '          ( exit 1 )',
    ],
  })
  // 绿样本(P1-2 的正确放行):单引号字面量动作的 `trap` 清理(含变量但**不做展开**)。
  gateSample('x11-link-trap-cleanup-green', null, {
    file: 'ci.yml',
    linkRun: [
      '          set -euo pipefail',
      "          trap 'rm -rf \"$tmp\"' EXIT",
      '          echo "::error::root guards failed(result=${{ needs.gate-guards.result }})"',
      '          exit 1',
    ],
  })
  // 绿样本(FP-2,第八轮新引入的假红):守卫运行步把输出落盘 / 接管道。
  // 父提交上 `… 2>&1 | tee log` 与 `… > /dev/null` 都是绿的(重定向不是参数)。
  gateSample('x12-guard-runner-redirect-tee-green', null, {
    file: 'ci.yml',
    guardRunLines: ['set -euo pipefail', `node ${DOCS_ONLY_GUARD_RUNNER} 2>&1 | tee root-guards.log`],
  })
  gateSample('x13-guard-runner-redirect-null-green', null, {
    file: 'ci.yml',
    guardRunLines: ['set -euo pipefail', `node ${DOCS_ONLY_GUARD_RUNNER} > /dev/null`],
  })
  // 绿样本(FP-3,第八轮新引入的假红):顶层 `env:` 里的**说明文本**与**不同旗标**
  // 都不是"把开关注入 argv"(旧判据按子串匹配,两条都判红,且文案与事实不符)。
  gateSample('x14-workflow-env-lookalike-green', null, {
    file: 'ci.yml',
    workflowEnv: ["  DSH_TELEMETRY_DISABLED: '1'", '  VERSION: "do not pass --allow-advisory anywhere"'],
  })
  gateSample('x15-workflow-env-other-flag-green', null, {
    file: 'ci.yml',
    workflowEnv: ["  DSH_TELEMETRY_DISABLED: '1'", '  VERSION: --allow-advisory-strict'],
  })

  // ---- 策略 12([SK-15]):job / 发布链步骤的**不可静默跳过**(R5-D-1 / R5-D-2) ----
  //
  // 现场:SK-14⑤ 只判"被钉步骤所在 job",别的 job 的 `if:` 没有任何判据读它 ⇒ 把
  // `desktop-linux` 的 `if:` 换成 `false`,三个平台 job 整块不跑(零安装包)而全绿;
  // 发布链里未被 SK-14 钉住的步骤(如 R2 上传)加一行 `if: false` / `continue-on-error`
  // 同样静默。合成登记表见 SK15_SELFTEST_REGISTRY(一个 job `verify` + 一个步骤 `Gate`)。
  const sk15Workflow = ({
    jobIf = 'true',
    jobContinueOnError = false,
    stepIf = 'true',
    stepContinueOnError = false,
    stepRun = 'bash scripts/ci-release-policy.sh',
    extraJob = false,
    dropStep = false,
    extraSteps = [],
  } = {}) => [
    'name: selftest',
    'on:',
    '  push:',
    '  pull_request:',
    'jobs:',
    '  verify:',
    `    runs-on: ${GATE_SELFTEST_RUNS_ON}`,
    ...(jobIf === null ? [] : [`    if: ${jobIf}`]),
    ...(jobContinueOnError ? ['    continue-on-error: true'] : []),
    '    steps:',
    ...(dropStep ? [] : [
      '      - name: Gate',
      ...(stepIf === null ? [] : [`        if: ${stepIf}`]),
      ...(stepContinueOnError ? ['        continue-on-error: true'] : []),
      `        run: ${stepRun}`,
    ]),
    ...extraSteps.map(line => `      ${line}`),
    ...(extraJob ? [
      '  publish-extra:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: echo extra',
    ] : []),
    '',
  ].join('\n')
  const sk15Sample = (id, raw, expectation = '[SK-15]') => (expectation === null
    ? expectGreen(id, [], { file: 'selftest.yml', raw, registries: SK15_SELFTEST_REGISTRY })
    : expectRed(id, expectation, [], { file: 'selftest.yml', raw, registries: SK15_SELFTEST_REGISTRY }))
  sk15Sample('v1-job-if-false', sk15Workflow({ jobIf: 'false' }))                      // R5-D-1 原形态
  sk15Sample('v2-job-if-narrowed', sk15Workflow({ jobIf: "true && github.event_name == 'workflow_dispatch'" })) // R4-A N6
  sk15Sample('v3-job-unregistered', sk15Workflow({ extraJob: true }))                   // 存在却没登记
  sk15Sample('v4-step-if-false', sk15Workflow({ stepIf: 'false' }))                     // R5-D-2 原形态
  sk15Sample('v5-step-if-narrowed', sk15Workflow({ stepIf: "true && github.event_name == 'workflow_dispatch'" }))
  sk15Sample('v6-step-continue-on-error', sk15Workflow({ stepContinueOnError: true }))
  // 登记了却不存在(留一个无关步骤,免得撞上"job 没有 steps"的通用判据而红错原因)
  sk15Sample('v7-step-missing', sk15Workflow({ dropStep: true, extraSteps: ['- run: echo unrelated'] }))
  sk15Sample('v8-step-effect-gone', sk15Workflow({ stepRun: 'echo noop' }))             // R5-C-8:效果判据
  sk15Sample('v9-inline-remote-write', sk15Workflow({                                   // R5-C-6:能力级识别
    extraSteps: ["- name: Sneaky upload", "  run: aws s3 cp bundle.zip s3://some-bucket/releases/"],
  }))
  sk15Sample('v10-registered-shape-green', sk15Workflow(), null)                        // 正例
  // P1-4(第九轮审计 B 泳道):发布链步骤的 `require` 曾经是**子串**判据 —— 把真正调用
  // 发布脚本的那一行换成 `echo`(step 名 / `if:` / `continue-on-error` / `env:` 全不动)
  // 就能让"零上传"通过登记。现在脚本路径必须出现在**命令位**。
  sk15Sample('x8-release-require-echo-noop', sk15Workflow({
    stepRun: 'echo "scripts/ci-release-policy.sh --list channels.list"',
  }))
  // 对照(正确放行):真正执行它的写法必须继续通过。
  sk15Sample('x8b-release-require-command-green', sk15Workflow({
    stepRun: 'bash scripts/ci-release-policy.sh --list channels.list',
  }), null)

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
    // 第十一轮审计 C2-A-01/A-02 的样本入口:`with:` 之外还要能改"写 Release 的那一行/那一段"
    // （命令替换来源、`gh api` 写正文、把命令名藏进数组）。
    releaseWrite = null,
    // 2026-09-23 第五轮审计 R5-C-3:策展说明判据不得被"只对正式版"的条件收窄。
    gateNotesIf = '',
    triggers = ['pull_request', 'push'],
  } = {}) => [
    'name: selftest',
    'on:',
    ...triggers.map(trigger => `  ${trigger}:`),
    'jobs:',
    '  gate:',
    `    runs-on: ${GATE_SELFTEST_RUNS_ON}`,
    '    timeout-minutes: 60',
    '    steps:',
    '      - uses: actions/checkout@v7',
    '        with:',
    '          fetch-depth: 0',
    ...(gateNotesStep && gateFirst ? [
      '      - name: Require curated release notes for release tags',
      ...(gateNotesIf === '' ? [] : [`        if: ${gateNotesIf}`]),
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
      '      - name: Require curated release notes for release tags',
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
    ...(releaseWrite === null
      ? [`          gh release create "\${TAG}" ${titleFlag} ${notesFlag}`]
      : releaseWrite),
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
  // R5-C-3:策展说明判据被"只对正式版"的条件收窄(预发 tag 缺说明会回退自动变更日志,
  // 而自动正文来自 PR 标题/正文 —— 不在任何守卫判据内)。两种收窄写法都必须红。
  releaseSample('p9-notes-gate-stable-only', '[SK-11]', {
    gateNotesIf: "steps.release_policy.outputs.release_kind == 'stable'",
  })
  releaseSample('p10-notes-gate-name-shape', '[SK-11]', {
    // `${{ }}` 不能省:裸 `!contains(...)` 在 YAML 里是显式 tag 指示符,解析出来不是字符串。
    gateNotesIf: "${{ !contains(github.ref_name, '-') }}",
  })
  // R5-C-3:`--generate-notes` 回退本身必须红(自动变更日志 = 提交信息 + PR 标题/正文)。
  releaseSample('p11-generate-notes-fallback', '[SK-11]', { notesFlag: '--generate-notes' })
  // ---- 第十一轮审计 C2-A-01(P1):正文来源必须**可证明**是策展文件 ----
  //
  // 现场:`--notes "$(git log -1 --format=%B)"` 让公开 Release 正文来自未评审文本(提交信息),
  // 而三道发布面检查全绿 —— 旧判据问的是"有没有说明来源这个旗标",不是"正文是不是那份文件"。
  releaseSample('p12-notes-command-substitution', '[SK-11]', {
    notesFlag: '--notes "$(git log -1 --format=%B)"',
  })
  releaseSample('p13-notes-file-unprovable-var', '[SK-11]', {
    notesFlag: '--notes-file "$SOME_EXTERNAL_PATH"',
  })
  releaseSample('p14-notes-file-outside-curated-dir', '[SK-11]', {
    notesFlag: '--notes-file "CHANGELOG.md"',
  })
  releaseSample('p15-notes-inline-literal-text', '[SK-11]', {
    notesFlag: '--notes "hotfix release"',
  })
  // 绿样本(C2-A-03 的假红方向):短旗标 `-F`(=`--notes-file`)与"读策展文件"的
  // `$(cat …)` 形态语义与长形态**逐个相同**,必须放行。
  releaseSample('p16-notes-short-flag-green', null, { notesFlag: '-F "${NOTES}"' })
  releaseSample('p17-notes-cat-curated-green', null, { notesFlag: '--notes "$(cat "${NOTES}")"' })
  // C2-A-02:同族的两条旁路 —— `gh api` 写正文 / 把命令名藏进数组。
  releaseSample('p18-gh-api-release-body', '[SK-11]', {
    releaseWrite: [
      '          gh api -X POST "repos/${REPO}/releases" -f tag_name="${TAG}" '
        + '-f name="${TAG}" -f body="$(git log -1 --format=%B)" >/dev/null',
    ],
  })
  releaseSample('p19-gh-release-command-in-array', '[SK-11]', {
    releaseWrite: [
      '          GH_CREATE=(gh release create)',
      '          "${GH_CREATE[@]}" "${TAG}" --title "${TAG}" ${NOTES_FLAG}',
    ],
  })
  // ---- 策略 14([SK-22]):表达式的**词法字符集**(2026-09-25 第十四轮现场) ----
  //
  // 现场:一个 `run: |` 块的 **shell 注释**里写了 `${{ …outputs.interp }}`(U+2026)——
  // YAML 合法、`bash -n` 合法(那一行就是注释)、本文件此前所有判据都看不见它,而推上
  // GitHub 之后**整条 CI 零 job**(run 0 秒 / 0 job 的 startup_failure,`pull_request`
  // 事件下连 run 都不创建)。样本按"判据面 × 正反"逐格点名(`SELFTEST_REQUIRED_SAMPLES`
  // 逐条登记:删掉任一格,对应形态就回到"没人看着"的状态):
  //   红:①`run:` 注释里的表达式(现场原形) ②表达式里的非 ASCII(不在注释里)
  //       ③未闭合的 `${{` ④表达式体里的非法 ASCII 标点(`+` —— actionlint 实测词法报错)
  //   绿:⑤普通表达式 + 单引号字面量 `'refs/tags/v'`(里面的 `/` 只有被剥掉才不误伤)
  //       ⑥字面量里的非 ASCII(`'标签/中文'`) ⑦字面量里的花括号(`format('{0}-{1}', …)`)
  //       ⑧字面量**内部**的 `}}`(`format('{0}}}', …)` —— 取体必须字符串感知)
  expectRed('w31-run-comment-expression-ellipsis', '[SK-22]', [
    '      - run: |',
    '          set -euo pipefail',
    '          # 承重行:`"${{ …outputs.interp }}" scripts/x.sh` 只冻结了**解释器**',
    '          echo done',
  ])
  expectRed('w32-expression-non-ascii-outside-literals', '[SK-22]', [
    '      - name: judge ${{ github.event_name — github.ref }}',
    '        run: echo ok',
  ])
  expectRed('w33-unterminated-expression', '[SK-22]', [
    '      - name: judge ${{ github.ref',
    '        run: echo ok',
  ])
  expectRed('w34-expression-disallowed-ascii-operator', '[SK-22]', [
    '      - run: echo ok',
    "        if: ${{ github.run_number + 1 > 0 }}",
  ])
  expectGreen('w35-expression-charset-green', [
    '      - run: |',
    '          set -euo pipefail',
    '          echo "${{ steps.x.outputs.y }}"',
    "          echo \"${{ startsWith(github.ref, 'refs/tags/v') }}\"",
  ])
  expectGreen('w36-expression-literal-non-ascii-green', [
    '      - run: echo ok',
    "        if: ${{ contains('标签/中文', github.ref_name) }}",
  ])
  expectGreen('w37-expression-literal-braces-green', [
    '      - run: |',
    '          set -euo pipefail',
    "          echo \"${{ format('{0}-{1}', github.ref, github.sha) }}\"",
  ])
  // 绿样本⑧:字面量**内部**的 `}}` 不是结束标记(取体是字符串感知的 —— actionlint 对
  // `format('{0}}}', …)` 整条表达式 EXIT=0)。没有这一格,把取体改回 `indexOf('}}')`
  // 会静默切掉合法写法,而红样本一条都不会响。
  expectGreen('w38-expression-brace-in-literal-green', [
    '      - run: echo ok',
    "        if: ${{ format('{0}}}', github.ref) == 'x' }}",
  ])

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
  // 定向样本存在性(第七轮独立复审 V2 的绕过形态):数量/标签两道对账都证明不了
  // "**这一批**样本还在" —— 删掉整段仍然绿,这里按 id 逐条点名。
  const missingRequired = SELFTEST_REQUIRED_SAMPLES.filter(
    entry => !samples.some(sample => sample.id === entry.id && sample.policy === entry.policy))
  expect(missingRequired.length === 0,
    `[self-test] 定向样本被删或被改成了别的期望:${missingRequired
      .map(entry => `\`${entry.id}\`(期望 ${entry.policy === null ? '绿样本' : `红样本 ${entry.policy}`})`).join(', ')}`
      + '\n  ⇒ 这批样本钉的是两批**实跑出来的绕过形态**:'
      + '①2026-09-24 第七轮独立复审 V2(步骤体退出语义的词法形态 + workflow 级 `env:`/`$GITHUB_ENV` 的静音开关通道);'
      + '②2026-09-25 第九轮审计 D 泳道与 B 泳道(进程环境层 `env:` 的三层键面 / 命令位判据 / `shell:` 整串 / '
      + '`trap` 动态动作 / 发布链 `require` 的命令位 / 三条第八轮新引入的假红)。'
      + '删样本 = 把这些形态重新放回"静默摘除唯一链路"的状态。')
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
  // workflow **文件级**登记的双向判据自检（R6-D P2-1）：判据本身要能被打坏。
  const fileRegistrySelftest = selfTestWorkflowFileRegistry()
  if (!Array.isArray(fileRegistrySelftest?.failures) || typeof fileRegistrySelftest?.assertions !== 'number') {
    failures.push({
      name: '[file-registry-selftest]',
      line: 0,
      detail: 'selfTestWorkflowFileRegistry() 的返回形状不对(需要 {failures, assertions}) —— 自检被改坏了'
        + '(F2-1 的同一类形状问题)',
    })
  } else {
    for (const detail of fileRegistrySelftest.failures) {
      failures.push({ name: '[file-registry-selftest]', line: 0, detail })
    }
    if (fileRegistrySelftest.assertions < SELFTEST_WORKFLOW_FILE_REGISTRY_ASSERTIONS) {
      failures.push({
        name: '[file-registry-selftest]',
        line: 0,
        detail: `workflow 文件级登记自检只执行了 ${fileRegistrySelftest.assertions} 条断言`
          + `(期望 ≥ ${SELFTEST_WORKFLOW_FILE_REGISTRY_ASSERTIONS}) ⇒ 自检被掏空。`,
      })
    }
  }
  // [SK-14] 覆盖下限的自检(R8-C-1 ②):判据本身要能被打坏 —— 逐个 id 挖掉必须报出来。
  const pinnedCoverageSelftest = selfTestPinnedStepCoverage()
  if (!Array.isArray(pinnedCoverageSelftest?.failures) || typeof pinnedCoverageSelftest?.assertions !== 'number') {
    failures.push({
      name: '[pinned-coverage-selftest]',
      line: 0,
      detail: 'selfTestPinnedStepCoverage() 的返回形状不对(需要 {failures, assertions}) —— 自检被改坏了',
    })
  } else {
    for (const detail of pinnedCoverageSelftest.failures) {
      failures.push({ name: '[pinned-coverage-selftest]', line: 0, detail })
    }
    if (pinnedCoverageSelftest.assertions < SELFTEST_PINNED_STEP_COVERAGE_ASSERTIONS) {
      failures.push({
        name: '[pinned-coverage-selftest]',
        line: 0,
        detail: `覆盖下限自检只执行了 ${pinnedCoverageSelftest.assertions} 条断言`
          + `(期望 ≥ ${SELFTEST_PINNED_STEP_COVERAGE_ASSERTIONS}) ⇒ 自检被掏空。`,
      })
    }
  }
  // 本地 composite action 判据的自证(C-03):输入是目录,不在 gateSample 的文本机制里。
  const compositeSelftest = selfTestCompositeActions()
  if (!Array.isArray(compositeSelftest?.failures) || typeof compositeSelftest?.assertions !== 'number') {
    failures.push({
      name: '[composite-action-selftest]',
      line: 0,
      detail: 'selfTestCompositeActions() 的返回形状不对(需要 {failures, assertions}) —— 自检被改坏了',
    })
  } else {
    for (const detail of compositeSelftest.failures) {
      failures.push({ name: '[composite-action-selftest]', line: 0, detail })
    }
    if (compositeSelftest.assertions < SELFTEST_COMPOSITE_ACTION_ASSERTIONS) {
      failures.push({
        name: '[composite-action-selftest]',
        line: 0,
        detail: `本地 composite action 自检只执行了 ${compositeSelftest.assertions} 条断言`
          + `(期望 ≥ ${SELFTEST_COMPOSITE_ACTION_ASSERTIONS}) ⇒ 自检被掏空。`,
      })
    }
  }
  // [SK-17] 层清单的自证(C-02):判据面声明的层必须与代码里的枚举**同源**。
  const pinnedEnvLayerSelftest = selfTestPinnedEnvLayers()
  if (!Array.isArray(pinnedEnvLayerSelftest?.failures) || typeof pinnedEnvLayerSelftest?.assertions !== 'number') {
    failures.push({
      name: '[pinned-env-layer-selftest]',
      line: 0,
      detail: 'selfTestPinnedEnvLayers() 的返回形状不对(需要 {failures, assertions}) —— 自检被改坏了',
    })
  } else {
    for (const detail of pinnedEnvLayerSelftest.failures) {
      failures.push({ name: '[pinned-env-layer-selftest]', line: 0, detail })
    }
    if (pinnedEnvLayerSelftest.assertions < SELFTEST_PINNED_ENV_LAYER_ASSERTIONS) {
      failures.push({
        name: '[pinned-env-layer-selftest]',
        line: 0,
        detail: `层清单自证只执行了 ${pinnedEnvLayerSelftest.assertions} 条断言`
          + `(期望 ≥ ${SELFTEST_PINNED_ENV_LAYER_ASSERTIONS}) ⇒ 自检被掏空。`,
      })
    }
  }
  let total = 0
  const notes = []
  const allowlistHits = []
  let goTestTimeoutHits = 0
  // [SK-22] 的扫描器退化对账（与 `goTestTimeoutHits` 同一手法）：全仓一处表达式都扫不到，
  // 要么是扫描器坏了，要么是 CI 里一个 `${{ … }}` 都不剩 —— 两种都必须说清，不能静默"通过"。
  let expressionBodyCount = 0
  const pinnedStepPolicies = []
  const pinnedEnvLayerIds = new Set()
  const pinnedUses = new Set()
  const pinnedUsesWith = new Set()
  for (const name of names) {
    const result = checkWorkflow(name)
    // `?? []` 兜底(2026-09-19 第三轮审计 F2-1):将来若有人再加一条忘了统一形状的
    // early return,这里少一行 note,而**不会**因为 TypeError 把已收集的 failures 吞掉。
    failures.push(...result.failures)
    total += result.checked
    notes.push(...(result.notes ?? []))
    allowlistHits.push(...(result.allowlistHits ?? []))
    goTestTimeoutHits += result.goTestTimeoutHits ?? 0
    expressionBodyCount += result.expressionBodies ?? 0
    pinnedStepPolicies.push(...(result.pinnedStepPolicies ?? []))
    for (const layer of result.pinnedEnvLayers ?? []) pinnedEnvLayerIds.add(layer.id)
    for (const uses of result.pinnedUses ?? []) pinnedUses.add(uses)
    for (const key of result.usesWith ?? []) pinnedUsesWith.add(key)
  }

  // [SK-17] 的**层清单双向对账**(第十轮审计 C-02):`PINNED_ENV_LAYER_REGISTRY` 是判据面的
  // 唯一真源,本次全仓扫描产出的层 id 必须与它**双向相等** —— 少一层(枚举被删/被短路)即红,
  // 多一层(加了枚举却没登记)也红。通过行由同一份枚举生成 ⇒ "声称检查了哪几层"不可能再与
  // 代码漂移(C-02 的现场:日志硬编码"三层 `env:` … 均已检查",而 `container.env` 从未被读)。
  // 与覆盖下限同一口径:只在默认目录的全仓扫描里判(`--workflows-dir` 的合成树可能没有守卫 job)。
  if (isDefaultDirectory) {
    const missingLayers = PINNED_ENV_LAYER_REGISTRY.filter(layer => !pinnedEnvLayerIds.has(layer.id))
    if (missingLayers.length > 0) {
      failures.push({
        name: '[SK-17]',
        line: 0,
        detail: `进程环境层的**覆盖面不足**:${missingLayers.map(layer => `${layer.id}(${layer.label})`).join('、')}`
          + ' 本次一次都没被枚举到(实际枚举到:'
          + `${[...pinnedEnvLayerIds].join('、') || '（空）'})。`
          + '\n  ⇒ 每层都是一条独立的静默通道(键写在那一层上进不到判据面),少一层等于少一份判据。'
          + '\n  ⇒ 要调整覆盖面请**显式**改 `PINNED_ENV_LAYER_REGISTRY` 并写明理由 —— '
          + '不接受"少枚举一层"这种静默降级。',
      })
    }
    const unknownLayers = [...pinnedEnvLayerIds].filter(id => !PINNED_ENV_LAYER_REGISTRY.some(layer => layer.id === id))
    if (unknownLayers.length > 0) {
      failures.push({
        name: '[SK-17]',
        line: 0,
        detail: `进程环境层枚举产出了未登记的层:${unknownLayers.join('、')}`
          + '\n  ⇒ 判据面扩大了却没人知道 ⇒ 通过行(由枚举生成)会宣称检查了注册表里没有的层。'
          + '请把新层写进 `PINNED_ENV_LAYER_REGISTRY`(它同时驱动通过行与这条对账)。',
      })
    }
    // `uses:` 登记表的**死条目**对账(与 SWALLOW_ALLOWLIST 同一纪律)。
    failures.push(...pinnedUsesRegistryProblem([...pinnedUses]))
    // `PINNED_USES_WITH_REGISTRY` 的死条目对账（第十一轮审计 P1-3）：登记了却没有被钉单元在用
    // 的输入 = 登记表在长成豁免洞。
    failures.push(...pinnedUsesWithRegistryProblems([...pinnedUsesWith]))
    // 本地 composite action 的内容判据(第十轮审计 C-03):`.github/workflows/` 的平铺扫描面
    // 之外还有一整类**仓内可判**的执行体 —— 它们此前只在被 `uses:` 委派时才"跑",却没人读。
    const actionsRoot = join(root, '.github', 'actions')
    failures.push(...checkCompositeActionTree(actionsRoot, notes, root, {
      referenced: collectReferencedLocalActions(join(root, '.github', 'workflows'), root),
    }))
  }

  // [SK-13] 的**全仓存在性**对账(只在默认目录):契约挂在"承载发布链的那个 workflow"
  // 上,所以先证明这样的 workflow 真的存在 —— 把发布链整段删掉/搬进一个没有发布命令的
  // 文件时,这条点名(判据不依赖文件叫什么名字)。
  if (isDefaultDirectory) {
    // 文件级登记的双向对拍（R6-D P2-1）：`.github/workflows/*.yml` ⊆ 登记集合。
    // 放在这里而不是 `checkWorkflowText()` 里 —— 它判的是**目录清单**，不是单份文本。
    failures.push(...checkRegisteredWorkflowFiles(names, REGISTRY_DEFAULT.files))
    // 被钉步骤的**覆盖下限**(R8-C-1 ②):每条策略都必须至少命中一次,少一条即红。
    const pinnedCoverage = pinnedStepCoverageProblem(pinnedStepPolicies)
    failures.push(...pinnedCoverage)
    if (pinnedCoverage.length === 0) {
      notes.push(`[SK-14] 被钉住的判据步骤覆盖 ${new Set(pinnedStepPolicies).size}`
        + `/${PINNED_STEP_POLICIES.length} 条策略(逐条命中,少一条即红)`)
    }
    if (names.every(name => REGISTRY_DEFAULT.files.includes(name))) {
      notes.push(`[SK-15] workflow 文件登记:${names.length} 个文件与登记集合双向一致`
        + `(${REGISTRY_DEFAULT.files.join(', ')})—— 新文件/删文件都要先改登记表`)
    }
    const releaseLines = names.filter(name => carriesReleaseLine(readFileSync(join(workflowDirectory, name), 'utf8')))
    if (releaseLines.length === 0) {
      failures.push({
        name: '[SK-13]',
        line: 0,
        detail: `.github/workflows 下没有任何 workflow 承载发布链(可执行文本里没有 `
          + `${RELEASE_LINE_ANCHORS.map(anchor => `\`${anchor}\``).join(' / ')})\n`
          + '  ⇒ 发布链被整段删掉/搬走了 ⇒ tag push 不会有任何交付面动作(GitHub Release、'
          + 'R2 更新面、渠道镜像全都不产出),而 PR 上的检查仍可能全绿。\n'
          + `  登记值:发布链承载者是 \`${RELEASE_LINE_WORKFLOW}\`(可改名,但必须仍然承载它)。`,
      })
    }
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

  // [SK-22] 的扫描器退化对账(与上面 `go test` 同口径):全文扫描器一旦失效(正则/循环被改坏),
  // 它会**永远绿** —— 这正是本判据存在的理由的反面。全仓 0 处表达式 ⇒ 红(默认目录);
  // 临时目录(--workflows-dir 的变异验证)只如实 WARNING,不制造假红。
  if (expressionBodyCount === 0) {
    if (isDefaultDirectory) {
      failures.push({
        name: '[SK-22]',
        line: 0,
        detail: '全文扫描在**所有** workflow 里一处 `${{ … }}` 都没找到 —— 要么扫描器退化了'
          + '(判据静默变绿),要么 CI 里真的一个表达式都不剩(那样的 workflow 不可能是本仓的 CI 形态)。\n'
          + '  ⇒ 与"解析出 0 个 run 块即失败"同一纪律:扫描器失效必须响,而不是放行。',
      })
    } else {
      process.stderr.write('check-workflows: WARNING — 本次是对临时目录跑变异验证且没有扫到任何 '
        + '`${{ … }}`;\n  [SK-22] 的"全仓至少一处表达式"存在性对账本次**未生效**,不能当作该策略已通过。\n')
    }
  }

  // `--workflows-dir` 的显式降级声明(F3-3):带参数 ⇒ 这不是全仓门禁。
  if (!isDefaultDirectory) {
    process.stderr.write(`check-workflows: WARNING — 正在检查**非默认目录**(${workflowDirectory}),这不是全仓门禁:\n`)
    process.stderr.write('  - 只扫描该目录下的 workflow,仓库 .github/workflows 本次**完全没有被扫**;\n')
    if (outsideAllowlistFiles.length > 0) {
      process.stderr.write(`  - SWALLOW_ALLOWLIST 的死条目对账被关掉了:${outsideAllowlistFiles.join(', ')} `
        + `不在被扫目录里 ⇒ 这 ${outsideAllowlistFiles.length} 个文件的豁免本次未被核对;\n`)
    }
    process.stderr.write('  - 本地 composite action(`.github/actions/**`)与 `uses:` 登记表的死条目对账本次**未生效**'
      + '(它们只在全仓扫描里判);\n')
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
    + '    docs-only 不得跳过根守卫 / 分类器规则钉死 / 发布面语义判据 / WASM 门禁接线)\n'
    + '    + SK-13/SK-14 策略(触发面业务契约 / 被钉住的判据步骤必须可执行:命令位 · 整串 `shell:` · '
    + '步骤体退出语义)\n'
    + '    + SK-20 策略(被钉步骤的**启动器必须冻结**:`command -v node/bash/git` 的绝对路径写进步骤输出、'
    + '后续判据步只用冻结值 —— `$GITHUB_PATH` 注入换不掉启动器;运行级证据是行为探针'
    + ' `scripts/check-frozen-launchers.mjs`,它自带正控)\\n'
    + '    + SK-21 策略(「永不跳过的守卫 job」的 `permissions` 逐字登记:该 job 只读仓)'
    + '\\n'
    + '    + SK-17 策略(被钉步骤/根守卫 job 的**进程环境层**:四层 `env:` 的**白名单登记表** + '
    + '`$GITHUB_ENV` 键名注入 + 被钉步骤体内的 `export`/前缀赋值 + `uses:` 委派目标的'
    + '本地可解析/登记制 + `.github/actions/**` 的内容判据)\n'
    + '    + SK-18 策略(被钉单元的**执行目录**:workflow 级 / job 级 `defaults.run.working-directory` 与'
    + '步骤级 `working-directory` 走**逐字登记制** —— 命令在另一个目录里解析,argv 看不出来)\n'
    + '    + SK-19 策略(YAML **合并键** `<<`:解析器不展开而 Actions 会 ⇒ 出现即红'
    + '(fail-closed);否则 `env:` 各层 / `container:` / `steps:` / `with:` 都能被它藏掉)\n'
    + `    + SK-22 策略(表达式**词法字符集**:全文 ${expressionBodyCount} 处 \`\${{ … }}\` —— 含 `
    + '`run:` 的 `#` 注释行 / heredoc(模板解析不看上下文);剥掉 `\'…\'` 单引号字面量后剩字符必须落在 '
    + '`A-Z a-z 0-9 _ . ( ) [ ] ! < > = & | * , -` 与空白里;未闭合 / 空表达式 / 未闭合字面量同样红)\n'
    + '    + SK-15 策略(交付物 job 与发布链步骤的**登记式不可静默跳过**:两侧对拍 / if 形态逐字 / '
    + 'continue-on-error / 效果子串(命令位) / 能力级远端写入面;`.github/workflows/*.yml` 与登记集合**双向**对拍)\n')
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main()
}
