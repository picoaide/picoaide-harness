#!/usr/bin/env node
/**
 * 根守卫独立运行器 —— **给"改动只碰文档"的 PR 用**（2026-09-23 第三轮审计 R3-C C-3）。
 *
 * ## 为什么需要它
 *
 * `.github/workflows/ci.yml` 的 `changes` job 会把 `docs/*`、`site/*`、任意 `*.md`
 * 的改动判成 docs-only（`code=false`），而 gate job 的 `if:` 据此**整条跳过**；GitHub
 * 分支保护把 skipped 的必需检查**记成成功**（线上 PR #129 就是 Gate=skipped 后合并的）。
 * 结果：铁律 0 的域名守卫、迁移区间守卫、文档数字守卫在"只改文档"的 PR 上**一次都没跑**，
 * 而它们的判据正好落在文档上 —— 实测把合成域名写进一个 `.md`，完整门禁里的
 * `check:no-real-domains` EXIT=1，docs-only 形态下却从未被执行。
 *
 * 修法是把这批**不依赖构建产物**的根守卫交给一个永远运行的路径：
 * `ci.yml` 的 gate job 不再可跳过，docs-only 时跑本脚本（≈1 分钟），
 * 有代码改动时仍跑完整的 `yarn check`（包 check + 同一批根守卫）。
 *
 * ## 单一真源（为什么守卫清单不写在本文件里）
 *
 * 守卫清单**解析自 `scripts/check-workspaces.mjs` 的 `GUARDS` 表**（同一个编排器，
 * `yarn check` 用的也是这张表）—— 新增根守卫时本文件自动跟上，不会出现"编排器加了、
 * docs-only 路径漏了"的第二份清单。解析失败/表消失一律 **fail-loud（exit 2）**，
 * 绝不"解析不到就当作没有守卫"。
 *
 * `MINIMUM_REQUIRED_GUARDS` 是**下限**而不是清单：这几条判据的覆盖面包含文档与提交
 * 信息（铁律 0 的域名、迁移区间、文档数字、变异体残留、workflow 纪律、布局记录），
 * 一旦它们从编排器表里消失**或被标成 `advisory`**，本脚本会红 —— 那种时候必须有人显式
 * 决定"docs-only 的 PR 还需要跑什么"，而不是让这条路径悄悄变空/变静音。
 *
 * ## 用法与退出码
 *
 * 用法：node scripts/check-root-guards.mjs [--list] [--concurrency N] [--full-output] [--allow-advisory]
 * 退出码：0 = 守卫全部通过；1 = 有守卫失败；2 = 用法/解析/登记错误。
 *
 * **`advisory` 默认在本脚本里不生效**（2026-09-23 第六轮审计 R6-C-1）：这里是不跳过的那条
 * 路径，只有显式传 `--allow-advisory` 才会把失败降级成告警 —— CI 的任何调用都不得带它
 * （`scripts/check-workflows.mjs` 会钉住这一点的反面：守卫运行步必须真的在跑）。
 * 另外，`advisory` 还必须先登记在编排器的 `ADVISORY_REGISTRY` 里，否则这里直接 exit 2。
 */

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const ORCHESTRATOR = join(ROOT, 'scripts', 'check-workspaces.mjs')

/** 下限（不是清单）：这些守卫的判据覆盖文档/提交信息，见文件头。 */
const MINIMUM_REQUIRED_GUARDS = [
  'check:layout',
  'check:workflows',
  'check:no-leftover-mutants',
  'check:migration-range',
  'check:doc-claims',
  'check:no-real-domains',
]

/**
 * 从编排器的源码里解析 `GUARDS` 表（name / args / advisory）。
 *
 * 用正则而不是 import：`check-workspaces.mjs` 是"一跑就跑整轮门禁"的 CLI，import 它
 * 会立刻开始调度。解析是**有判据**的：条数对不上（name 与 args 数量不等、条目切分数量
 * 对不上）就是 fail-loud，而不是"解析到几条算几条"。
 *
 * @param source - `scripts/check-workspaces.mjs` 的源码文本。
 * @returns `{ guards }` 或 `{ error }`。
 */
export function parseGuardTable(source) {
  const start = source.indexOf('const GUARDS = [')
  if (start < 0) return { error: '在 scripts/check-workspaces.mjs 里找不到 `const GUARDS = [`' }
  const end = source.indexOf('\n]', start)
  if (end < 0) return { error: '在 scripts/check-workspaces.mjs 里找不到 `GUARDS` 表的结尾' }
  const body = source.slice(start, end)
  const chunks = body.split(/\n {2}\{/u).slice(1)
  const guards = []
  for (const chunk of chunks) {
    const name = /name:\s*'([^']+)'/u.exec(chunk)?.[1]
    const argsRaw = /args:\s*\[([^\]]*)\]/u.exec(chunk)?.[1]
    if (name === undefined || argsRaw === undefined) {
      return { error: `GUARDS 表的条目解析失败（切分出 ${chunks.length} 条，其中一条缺 name/args）：${chunk.slice(0, 80)}…` }
    }
    const args = [...argsRaw.matchAll(/'([^']+)'/gu)].map(match => match[1])
    if (args.length === 0) return { error: `GUARDS 表里 ${name} 的 args 为空` }
    guards.push({ name, args, advisory: /advisory:\s*true/u.test(chunk) })
  }
  if (guards.length === 0) return { error: 'GUARDS 表解析出 0 条守卫（表结构变了？）' }
  return { guards }
}

/**
 * 从编排器的源码里解析 `ADVISORY_REGISTRY`（advisory 的**登记制**，R6-C-1）。
 *
 * `advisory` 曾经是条目上的一个自由字段：加一个词就能让任一条守卫在 `yarn check` 与
 * 本运行器里同时变成"只告警"。现在它必须在编排器里逐条登记，本运行器**独立**复核
 * 这份登记（不依赖编排器是否跑过 —— docs-only 的 PR 上编排器根本不跑）。
 *
 * 解析是**有判据**的：找不到登记表 = fail-loud（不是"当作没有 advisory"）。
 *
 * @param source - `scripts/check-workspaces.mjs` 的源码文本。
 * @returns `{ entries }` 或 `{ error }`。
 */
export function parseAdvisoryRegistry(source) {
  const marker = source.indexOf('const ADVISORY_REGISTRY = [')
  if (marker < 0) return { error: '在 scripts/check-workspaces.mjs 里找不到 `const ADVISORY_REGISTRY = [`' }
  const lineEnd = source.indexOf('\n', marker)
  const firstLine = source.slice(marker, lineEnd < 0 ? source.length : lineEnd)
  // 空表（当前形态）：`const ADVISORY_REGISTRY = []`（`]` 与 `[` 同行）。
  if (/^const ADVISORY_REGISTRY = \[\]\s*$/u.test(firstLine)) return { entries: [] }
  const end = source.indexOf('\n]', marker)
  if (end < 0) return { error: '在 scripts/check-workspaces.mjs 里找不到 `ADVISORY_REGISTRY` 表的结尾' }
  const body = source.slice(marker, end)
  const entries = []
  for (const chunk of body.split(/\n {2}\{/u).slice(1)) {
    const name = /name:\s*'([^']+)'/u.exec(chunk)?.[1]
    if (name === undefined) return { error: `ADVISORY_REGISTRY 的条目解析失败（缺 name）：${chunk.slice(0, 80)}…` }
    entries.push({
      name,
      reason: /reason:\s*'([^']*)'/u.exec(chunk)?.[1],
      approvedBy: /approvedBy:\s*'([^']*)'/u.exec(chunk)?.[1],
      expiresOn: /expiresOn:\s*'([^']*)'/u.exec(chunk)?.[1],
    })
  }
  if (entries.length === 0) return { error: 'ADVISORY_REGISTRY 表解析出 0 条（表结构变了？）' }
  return { entries }
}

function parseArgs(argv) {
  const options = { list: false, concurrency: null, fullOutput: false, allowAdvisory: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--list') options.list = true
    else if (arg === '--full-output') options.fullOutput = true
    else if (arg === '--allow-advisory') options.allowAdvisory = true
    else if (arg === '--concurrency') {
      const value = Number(argv[index + 1])
      if (!Number.isSafeInteger(value) || value <= 0) {
        console.error(`check-root-guards: --concurrency 需要正整数，收到 ${JSON.stringify(argv[index + 1])}`)
        return null
      }
      options.concurrency = value
      index += 1
    } else {
      console.error(`check-root-guards: 未知参数 ${arg}`)
      return null
    }
  }
  return options
}

/** 与编排器同形地起一个守卫（`corepack yarn <args>`），失败时保留输出尾部。 */
function runGuard(guard) {
  return new Promise(resolveTask => {
    const started = Date.now()
    const child = spawn('corepack', ['yarn', ...guard.args], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      env: { ...process.env, FORCE_COLOR: '0' },
    })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    child.on('error', error => {
      resolveTask({ guard, ok: false, ms: Date.now() - started, output: `${output}\n${String(error)}` })
    })
    child.on('close', code => {
      resolveTask({ guard, ok: code === 0, ms: Date.now() - started, output })
    })
  })
}

/** 有界输出：失败详情只打判定行与尾部（与编排器同一取舍，避免把 CI 日志刷爆）。 */
function summarize(output) {
  const lines = output.split('\n').filter(line => line.trim() !== '')
  if (lines.length <= 40) return lines.join('\n')
  return [...lines.slice(0, 20), `  …（省略 ${lines.length - 40} 行）`, ...lines.slice(-20)].join('\n')
}

async function runPool(tasks, concurrency, results) {
  let cursor = 0
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, tasks.length)) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      const task = tasks[index]
      if (task === undefined) return
      const result = await runGuard(task)
      results.push(result)
      console.log(`${result.ok ? '✓' : '✗'} ${task.name} ${(result.ms / 1000).toFixed(1)}s`)
    }
  })
  await Promise.all(workers)
}

const options = parseArgs(process.argv.slice(2))
if (options === null) process.exit(2)

let source
try {
  source = readFileSync(ORCHESTRATOR, 'utf8')
} catch (error) {
  console.error(`check-root-guards: 读不到 ${ORCHESTRATOR}：${error.message}`)
  process.exit(2)
}
const parsed = parseGuardTable(source)
if (parsed.error !== undefined) {
  console.error(`check-root-guards: ${parsed.error}`)
  console.error('  ⇒ 拒绝在"守卫清单解析不出来"的情况下继续（那会让 docs-only 的 PR 变成零守卫通过）。')
  process.exit(2)
}
const guards = parsed.guards

// advisory 的**登记制**（R6-C-1）：本运行器独立复核编排器里的 ADVISORY_REGISTRY，
// 不依赖编排器跑没跑过 —— docs-only 的 PR 上编排器根本不跑，而这条路径正是它唯一的防线。
const advisoryRegistry = parseAdvisoryRegistry(source)
if (advisoryRegistry.error !== undefined) {
  console.error(`check-root-guards: ${advisoryRegistry.error}`)
  console.error('  ⇒ 拒绝在"advisory 登记表解析不出来"的情况下继续（那会让任何守卫都能被一个词静音）。')
  process.exit(2)
}
const registeredAdvisories = new Set(advisoryRegistry.entries.map(entry => entry.name))
const unregisteredAdvisory = guards.filter(guard => guard.advisory === true && !registeredAdvisories.has(guard.name))
if (unregisteredAdvisory.length > 0) {
  console.error(`check-root-guards: 这些守卫被标成 advisory 但没有登记：${unregisteredAdvisory.map(guard => guard.name).join(', ')}`)
  console.error('  ⇒ advisory 是无判据的红→绿开关（R6-C-1）：必须在 scripts/check-workspaces.mjs 的'
    + ' ADVISORY_REGISTRY 里写明理由/批准人/到期日，或者干脆删掉条目上的 `advisory: true`。')
  process.exit(2)
}
const staleAdvisory = advisoryRegistry.entries.filter(entry => !guards.some(guard => guard.name === entry.name && guard.advisory === true))
if (staleAdvisory.length > 0) {
  console.error(`check-root-guards: ADVISORY_REGISTRY 里的 ${staleAdvisory.map(entry => entry.name).join(', ')} 并不是（或不再是）advisory 守卫`)
  console.error('  ⇒ 陈旧登记同样要清掉：留下它等于给下一个人一个可以随时按亮的静音键。')
  process.exit(2)
}

// 守卫名必须真的是根 package.json 里的脚本（改名/删除 ⇒ 这里红，而不是"跑了个不存在的东西"）。
const rootScripts = Object.keys(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts ?? {})
const unknown = guards.filter(guard => !rootScripts.includes(guard.name)).map(guard => guard.name)
if (unknown.length > 0) {
  console.error(`check-root-guards: 编排器表里的守卫在 package.json scripts 里不存在：${unknown.join(', ')}`)
  process.exit(2)
}
// 下限判据 = "在表里 **且 不是 advisory**"：光在表里不够 —— 一个 `advisory: true` 就能让
// 铁律 0 的域名守卫在这条从不跳过的路径上只打告警（R6-C-1 的现场形态）。
const missingRequired = MINIMUM_REQUIRED_GUARDS.filter(name => !guards.some(guard => guard.name === name && guard.advisory !== true))
if (missingRequired.length > 0) {
  console.error(`check-root-guards: 编排器表里缺少下限要求的守卫（或它们被标成了 advisory）：${missingRequired.join(', ')}`)
  console.error('  ⇒ 这些守卫的判据覆盖文档/提交信息，docs-only 的 PR 必须跑到它们**并且**让它们能拦门禁。'
    + '确实要移除时，请同时修改本文件的 MINIMUM_REQUIRED_GUARDS 并说明替代判据。')
  process.exit(2)
}

if (options.list) {
  for (const guard of guards) console.log(`${guard.name.padEnd(28)} ${guard.args.join(' ')}${guard.advisory ? '（advisory）' : ''}`)
  console.log(`check-root-guards: ${guards.length} 个根守卫（清单来自 ${ORCHESTRATOR}）`)
  console.log(`check-root-guards: advisory 登记 ${advisoryRegistry.entries.length} 条`
    + `${options.allowAdvisory ? '，且**本次允许** advisory 不拦门禁（--allow-advisory）' : '；本次 advisory 失败照样拦门禁'}`)
  process.exit(0)
}

const envConcurrency = Number(process.env.CHECK_CONCURRENCY ?? '')
const defaultConcurrency = Math.max(1, Math.min(4, availableParallelism()))
const concurrency = options.concurrency
  ?? (Number.isFinite(envConcurrency) && envConcurrency > 0 ? envConcurrency : defaultConcurrency)

console.log(`check-root-guards — 并发 ${concurrency}；docs-only 的 PR 也必须跑到的根守卫（${guards.length} 个）`
  + `${options.allowAdvisory ? '；**--allow-advisory**：advisory 失败只告警' : ''}`)
const startedAt = Date.now()
const results = []
await runPool(guards, concurrency, results)

// **默认不放行 advisory**（R6-C-1③）：这条路径是 docs-only PR 的唯一防线，"一个词让红变绿"
// 在这里尤其危险。只有显式 `--allow-advisory` 才降级成告警 —— CI 的任何调用都不许带它。
const toleratesAdvisory = options.allowAdvisory
const failed = results.filter(result => !result.ok
  && !(result.guard.advisory === true && toleratesAdvisory))
const advisory = results.filter(result => !result.ok && result.guard.advisory === true)
const tolerated = toleratesAdvisory ? advisory : []
console.log(`──── ${results.length} 个根守卫：${results.length - failed.length - tolerated.length} 通过、`
  + `${failed.length} 失败、${tolerated.length} 告警(advisory)，总耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`)
if (!toleratesAdvisory && advisory.length > 0) {
  console.error(`\n提示：有 ${advisory.length} 条失败落在 advisory 守卫上，但本运行器**默认不认 advisory**`
    + '（docs-only 的 PR 只有这条路）。要让它们不拦门禁，必须显式传 `--allow-advisory`。')
}

for (const result of failed) {
  console.error(`\n===== ${result.guard.name} 失败 =====`)
  console.error(options.fullOutput ? result.output.trimEnd() : summarize(result.output))
}
for (const result of tolerated) {
  console.error(`\n===== ${result.guard.name} 失败(advisory，--allow-advisory 下不拦门禁) =====`)
  console.error(options.fullOutput ? result.output.trimEnd() : summarize(result.output))
}
if (failed.length > 0) process.exit(1)
