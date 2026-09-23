#!/usr/bin/env node
/**
 * 解析 `go test -json` 报告：**禁止静默跳过**（TST-2 / R2T-1 / R2T-2）。
 *
 * 三件事（每一条都对应一次真实事故）：
 *   1. 只取 `go test` 的退出码会让"PG 不可达 ⇒ 所有 DB 用例 t.Skip ⇒ 0 断言通过"
 *      变成门禁绿 —— 所以**用例级 skip 一律算失败**（R1-TST-2）。
 *   2. 包级 `skip`（`no test files`）不是问题，必须与用例级区分开：早期实现用
 *      `"Package":"…"}` 这种"Package 紧贴右括号"的正则，而 test2json 的真实字段序是
 *      `Time,Action,Package,Elapsed` ⇒ 恒不匹配（R2T-2）；所以这里**解析 JSON**，不猜字段序。
 *   3. 关键用例必须**确实 pass**：`Action` 在 `Test` 之前的正则曾在审计里被写反过，
 *      恒不匹配却"看起来在断言"（R2T-1）—— 解析事件流可以直接消除这类风险。
 *
 * 用法：node scripts/wasm/check-go-test-json.mjs <report.json> [--require A,B] [--scope p1,p2]
 * 退出码（**三段可区分**，2026-09-23 第三轮审计 W-4 补齐）：
 *   0 = 无用例级 skip、无失败、关键用例全 pass；
 *   1 = 报告**存在但不合格**（用例级 skip / 失败事件 / 关键用例缺失或未 pass / 零断言）；
 *   2 = **前置缺失或用法错误**（缺参数、报告文件不存在/不可读、`--scope` 没匹配到任何包）
 *       —— 显式打印原因并明确"这不是通过"。缺报告时绝不静默绿：没有报告就没有判定，
 *       只有环境/接线错误。
 *
 * ## `--scope`（2026-09-23，CI 接线 W-4 的**必要条件**）
 *
 * 缺省（不带 `--scope`）= 整份报告都判，组 3 的用法不变。
 *
 * 为什么 CI 需要它：server job 跑的是**全仓** `./...`，而"用例级 0 skip"这条判据的
 * 设计面是 `internal/wasmapp/... internal/router/...`（组 3 的范围）加上 2026-09-23 按
 * F8 补进来的 `internal/marketplace`/`internal/agentshare`（渠道命名空间守卫 A-8 的用例
 * 所在包 —— 那两个包依赖真 PG，`serverstore.NewTestDB` 在 PG 不可达时整包 `t.Skip`，
 * 旧范围下"静默全跳"是绿的；真库实测两包用例级 skip = 0）。全仓报告里有若干
 * **环境条件型** skip —— 例如 `internal/serverstore` 的 DST 用例在 UTC runner 上必然
 * `t.Skip("本机时区无夏令时")`、`internal/portal`/`serverstore` 的对拍用例在"看不到
 * 仓库外的客户端源码"时 skip。把零 skip 套到全仓 = 每次必红的假红，而假红的下场
 * 通常是把整条判据关掉（本仓反复记录过这个退化路径）。所以 CI 按范围判定：
 * `--scope internal/wasmapp,internal/router,internal/marketplace,internal/agentshare`
 * （前两段与组 3 同面）。
 *
 * **前缀不要带尾斜杠**：`internal/router/` 会漏掉 `internal/router` 根包自己的用例事件
 * （实测 65 个事件/12 个用例），而它正是路由表对拍所在。前缀按"包导入路径片段"匹配。
 *
 * `--scope` 在报告里**一个包都没匹配到**时按 2 退出（接线/报告与判据面不一致），
 * 不是"范围内没问题"。
 */

import { readFileSync } from 'node:fs'

const [report, ...rest] = process.argv.slice(2)
if (report === undefined) {
  console.error('用法: node scripts/wasm/check-go-test-json.mjs <report.json> [--require Test1,Test2] [--scope prefix1,prefix2]')
  process.exit(2)
}
const requireIndex = rest.indexOf('--require')
const required = requireIndex >= 0
  ? (rest[requireIndex + 1] ?? '').split(',').map(name => name.trim()).filter(Boolean)
  : []
const scopeIndex = rest.indexOf('--scope')
const scope = scopeIndex >= 0
  ? (rest[scopeIndex + 1] ?? '').split(',').map(prefix => prefix.trim()).filter(Boolean)
  : []
if (scopeIndex >= 0 && scope.length === 0) {
  console.error('用法: --scope 需要一个非空的包导入路径片段列表（逗号分隔，例如 internal/wasmapp/,internal/router/）')
  process.exit(2)
}

/**
 * 读报告：**前置缺失必须自己说清楚**（而不是让 ENOENT 以一段 fs 栈收尾）。
 *
 * 为什么单列成 2：调用方（门禁组 3 / CI step）只有"非零即失败"这一条路，
 * 但排障要能一眼区分"代码/测试不合格"（1）与"go test 根本没跑起来 / 报告路径写错"（2）。
 */
let rawReport
try {
  rawReport = readFileSync(report, 'utf8')
} catch (cause) {
  console.error(`  FAIL 前置缺失：go test JSON 报告不可读（${report}）—— ${cause.code ?? cause.message}`)
  console.error('  —— 这不是通过：本判据必须先有 go test -json 报告；请检查上一步是否真的产出报告（路径/工作目录/tee 是否接上）')
  process.exit(2)
}

/**
 * 允许的"显式跳过"（**每条必须带理由**，且必须**真的仍然 skip** —— 条目不再跳过时判失败，
 * 防止白名单腐烂成"永久豁免"）。
 *
 * 背景：§13 判据 2 要求 `skipped == 0`，防的是"PG 不可达 ⇒ 全部 t.Skip ⇒ 0 断言的假绿"。
 * 但仓库里确实存在**取证/E2E 出口**型的用例：它们不是回归断言，只在脚本显式给环境变量时
 * 才有意义（例如把服务端真正下发的技能包字节写出来喂给 JS 安装器）。把这类用例与
 * "静默跳过"混为一谈，只会逼着大家把真判据删掉 —— 所以按名字显式登记、打印理由，
 * 而不是放宽整条规则。
 */
const OPT_IN_SKIPS = [
  {
    test: 'TestExportArchiveForE2E',
    reason: 'skillseed 的跨语言 E2E 取证出口（未设 SKILLSEED_E2E_OUT 即 skip），不是回归断言；跑法见 temp/skillseed-e2e/README.md',
  },
]

/**
 * **环境条件型**用例级 skip（第二档，2026-09-24 第六轮补）：用例真的是回归断言，
 * 但它需要宿主能力（这里是 `bwrap`），拿不到就自己 `t.Skip`。
 *
 * 为什么不能塞进 `OPT_IN_SKIPS`：那一档是"只在给环境变量时才有意义的取证出口"，
 * 而这一档在**有能力的机器上是真跑的**（本机 `/usr/bin/bwrap` 0.11.0 时全部 pass）
 * ⇒ 套用"不再跳过即陈旧"会把本地/开发机判红。反过来也不能放任：CI runner 上
 * 它们**总是** skip，若直接放过，"整包静默跳过"就从这条通道溜过去了。
 *
 * 所以每条登记必须给三样东西，缺一不可：
 *   · `requires`：缺的是什么能力（打进日志，"跳过"永远带着原因）；
 *   · `companion`：**同一能力面的形状判据**用例名 —— 它必须在本报告里真的 `pass`，
 *     否则该 skip 判失败（形状判据不需要 bwrap，能力缺席时它照样跑 ⇒ 一旦整包被
 *     静默跳过，companion 也拿不到 pass，这条通道立刻关闭）；
 *   · `reason`：为什么这个代价可接受。
 *
 * 陈旧口径：**报告里完全没出现**（改名/删除）判失败；真跑了并 pass 不判红。
 */
const ENV_CONDITIONAL_SKIPS = [
  {
    test: 'TestCompileUnderBwrapIsolation',
    requires: 'bwrap',
    companion: 'TestBwrapArgvShape',
    reason: '隔离的端到端验收（真的在 bwrap 里编译一个模块）；CI runner 无可用 bwrap 时用例自身 t.Skip，argv 形状由 companion 覆盖',
  },
  {
    test: 'TestBwrapBlocksWriteOutsideCacheDir',
    requires: 'bwrap',
    companion: 'TestBwrapArgvShape',
    reason: '隔离的写入边界端到端验收；无 bwrap 即跳过（argv 形状由 companion 覆盖）',
  },
  {
    test: 'TestCompileTimeoutUnderBwrapLeavesNoResidue',
    requires: 'bwrap',
    companion: 'TestBwrapArgvShape',
    reason: '隔离下超时击杀不留残留；无 bwrap 即跳过（隔离外路径由 TestCompileTimeoutKillsChild 覆盖）',
  },
  {
    test: 'TestBwrapCannotReadOutsideWhitelist',
    requires: 'bwrap',
    companion: 'TestBwrapArgvShape',
    reason: '隔离的读取白名单端到端验收；无 bwrap 即跳过（argv 形状由 companion 覆盖）',
  },
  {
    test: 'TestBwrapTmpIsWritable',
    requires: 'bwrap',
    companion: 'TestBwrapArgvShape',
    reason: '隔离下 tmp 可写端到端验收；无 bwrap 即跳过（argv 形状由 companion 覆盖）',
  },
]

const failures = []
const casePasses = new Set()
/** 报告里出现过的**全部**用例名（含失败/跳过）—— 用来区分"被改名"与"跑了但没过"。 */
const caseSeen = new Set()
const caseSkips = []
const packageSkips = new Set()
const testFailures = []
let events = 0
let malformed = 0
/** 被 `--scope` 排除掉的事件数（打印出来，避免"范围外的东西悄悄消失"）。 */
let outOfScope = 0
const scopedPackages = new Set()

for (const line of rawReport.split('\n')) {
  if (line.trim() === '') continue
  let event
  try {
    event = JSON.parse(line)
  } catch {
    malformed += 1
    continue
  }
  const test = typeof event.Test === 'string' && event.Test !== '' ? event.Test : null
  const pkg = typeof event.Package === 'string' ? event.Package : ''
  // `--scope`：只判范围内的事件（范围外的不参与计数/判定，见文件头"为什么 CI 需要它"）。
  if (scope.length > 0 && !scope.some(prefix => pkg.includes(prefix))) {
    outOfScope += 1
    continue
  }
  if (scope.length > 0 && pkg !== '') scopedPackages.add(pkg)
  events += 1
  if (test !== null) caseSeen.add(test)
  if (event.Action === 'pass' && test !== null) casePasses.add(test)
  if (event.Action === 'skip') {
    if (test !== null) caseSkips.push(`${pkg}::${test}${event.Output === undefined ? '' : ''}`)
    else packageSkips.add(pkg)
  }
  if (event.Action === 'fail') testFailures.push(`${pkg}${test === null ? '' : `::${test}`}`)
}

if (scope.length > 0 && scopedPackages.size === 0) {
  console.error(`  FAIL 前置缺失：--scope（${scope.join(', ')}）在报告里没有匹配到任何包`
    + `（报告 ${report}，共 ${events + outOfScope} 个事件）`)
  console.error('  —— 这不是通过：要么前缀写错，要么这份报告根本没覆盖判据面（范围外的东西不会替它变绿）')
  process.exit(2)
}
if (scope.length > 0) {
  console.log(`  --scope ${scope.join(', ')}：命中 ${scopedPackages.size} 个包，范围外事件 ${outOfScope} 个（不参与判定）`)
}
console.log(`  go test -json：${events} 个事件（无法解析 ${malformed} 行）；用例级 pass ${casePasses.size} 个`)
console.log(`  包级 skip ${packageSkips.size} 个（无测试文件的包，正常）${packageSkips.size === 0 ? '' : `：${[...packageSkips].join(' ')}`}`)

if (events === 0) failures.push('报告里没有任何事件（go test 没跑起来？）—— 不得当成通过')
if (casePasses.size === 0) failures.push('没有任何用例级 pass —— 零断言的门禁绿')

if (caseSkips.length > 0) {
  const allowed = []
  const envAllowed = []
  const unexpected = []
  for (const entry of caseSkips) {
    const name = entry.slice(entry.indexOf('::') + 2)
    if (OPT_IN_SKIPS.some(rule => rule.test === name)) {
      allowed.push(entry)
      continue
    }
    const envRule = ENV_CONDITIONAL_SKIPS.find(rule => rule.test === name)
    if (envRule !== undefined) {
      // 环境条件型：**必须**同时在报告里看到同能力面的形状判据 pass —— 否则不能证明
      // "只是缺能力"，而可能是整包被静默跳过（PG 不可达那类形态正是这么溜过去的）。
      if (casePasses.has(envRule.companion)) {
        envAllowed.push([entry, envRule])
      } else {
        unexpected.push(`${entry}（登记为环境条件型 skip，但同能力面的形状判据 ${envRule.companion} 本次没有 pass`
          + ` ⇒ 无法证明只是缺 ${envRule.requires}）`)
      }
      continue
    }
    unexpected.push(entry)
  }
  for (const entry of allowed) {
    const rule = OPT_IN_SKIPS.find(candidate => candidate.test === entry.slice(entry.indexOf('::') + 2))
    console.log(`  SKIP(opt-in) ${entry} —— ${rule?.reason ?? ''}`)
  }
  for (const [entry, rule] of envAllowed) {
    console.log(`  SKIP(env:${rule.requires}) ${entry} —— ${rule.reason}`
      + `（同能力面形状判据 ${rule.companion} 本次 pass ✅）`)
  }
  // 陈旧白名单：登记了"会跳过"，实际却跑了（说明用例改名/去掉了 skip）⇒ 必须清理登记项。
  const stale = OPT_IN_SKIPS.filter(rule => !caseSkips.some(entry => entry.endsWith(`::${rule.test}`)))
  if (stale.length > 0) {
    failures.push(`OPT_IN_SKIPS 里有不再跳过的陈旧条目（请删除或改名）：${stale.map(rule => rule.test).join(', ')}`)
  }
  // 环境条件型：**报告里完全没出现**才算陈旧（改名/删除）；真跑了并 pass 是更严的形态，不判红。
  const staleEnv = ENV_CONDITIONAL_SKIPS.filter(rule => !caseSeen.has(rule.test))
  if (staleEnv.length > 0) {
    failures.push(`ENV_CONDITIONAL_SKIPS 里登记的用例在报告里**不存在**（改名/删除 ⇒ 请同步登记）：${staleEnv.map(rule => rule.test).join(', ')}`)
  }
  const missingCompanion = [...new Set(ENV_CONDITIONAL_SKIPS.map(rule => rule.companion))]
    .filter(name => !caseSeen.has(name))
  if (missingCompanion.length > 0) {
    failures.push(`环境条件型 skip 的形状判据（companion）在报告里不存在：${missingCompanion.join(', ')}`
      + ' —— 没有它就无法把"缺能力"与"整包静默跳过"区分开')
  }
  if (unexpected.length > 0) {
    failures.push(`有未登记的用例级 skip ${unexpected.length} 个（PG 不可达/条件跳过 ⇒ 假绿，一律算失败）：${unexpected.slice(0, 20).join(' ')}`)
  }
}
if (testFailures.length > 0) {
  failures.push(`有失败事件 ${testFailures.length} 个：${testFailures.slice(0, 20).join(' ')}`)
}
for (const name of required) {
  // 子测试（`TestX/case`）pass 不能替代父用例的 pass 事件，但父用例 pass 一定能命中精确名。
  if (casePasses.has(name)) continue
  if (!caseSeen.has(name)) {
    // **被改名**与"跑了但没过"是两件事：前者要改这里的 `--require` 名单（或说明契约变更），
    // 后者是真失败。混在一起报会让人以为是缺陷（W1 改名 `TestClientFrameUser_*` 时踩过）。
    const stem = name.replace(/^Test/u, '').slice(0, 12)
    const candidates = [...caseSeen].filter(seen => seen.includes(stem)).slice(0, 5)
    failures.push(`关键用例在报告里**不存在**（可能已被改名 ⇒ 请同步 --require 名单）：${name}`
      + `${candidates.length === 0 ? '' : `；候选：${candidates.join(', ')}`}`)
  } else {
    failures.push(`关键用例未 pass（存在但没通过）：${name}`)
  }
}

if (failures.length > 0) {
  for (const message of failures) console.error(`  FAIL ${message}`)
  process.exit(1)
}
console.log(`  关键用例全部 pass：${required.join(', ')}`)
console.log('  go test 报告检查通过 ✅')
