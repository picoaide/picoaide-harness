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
 *   1 = 报告**存在但不合格**（用例级 skip / 失败事件 / 关键用例缺失或未 pass / 零断言 /
 *       登记项与登记面的完整性检查不合格）；
 *   2 = **前置缺失或用法错误**（缺参数、报告文件不存在/不可读、`--scope` 没匹配到任何包、
 *       本脚本自检失败）—— 显式打印原因并明确"这不是通过"。缺报告时绝不静默绿：
 *       没有报告就没有判定，只有环境/接线错误。
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
 *
 * ## 登记项的**判定面**必须绑定**包**（2026-09-23 第七轮独立复审 R7-C P2-2 / R7-D P2-1）
 *
 * 现场（已复现）：三档登记检查（陈旧 OPT_IN / 登记项改名或删除 / companion 缺失）原本整块
 * 写在 `if (caseSkips.length > 0) { … }` 里 —— 而它们回答的是"**登记表本身还成立吗**"，
 * 与"本次有没有 skip"毫无关系。于是范围内**零**用例级 skip 时三条判据一条都不执行，
 * 脚本照打"检查通过 ✅"并 exit 0：把登记项改名/删掉、或让 companion 消失，都没人管。
 * 同一段里 `companion` 还只按**裸名字**在整份报告里找 pass（不绑包）⇒ 一条**别包的**
 * 恒过用例可以为任意包的任意 skip 背书（`--scope` 越宽越离谱）。
 *
 * 现在两条都收口：
 *   · 每条登记**必须声明 `owner`**（被登记用例所在的包前缀）；检查在此前缀被报告覆盖时
 *     **无条件执行**，不再依赖 `caseSkips`。报告**完全没覆盖** owner 包时如实打印
 *     `未判定`（判定面缺失不得伪装成"通过"，也不制造假红）—— 这也是合成报告夹具
 *     （`scripts/verify-ci-scripts.mjs` 只造 appserver 一个包）能继续使用的前提。
 *   · `companion` 必须声明 `companionPackage`，且必须与被跳过的用例**同包（同一前缀族）**；
 *     报告里必须在该前缀下看到它的 `pass`。别包的恒过用例不再能为它背书。
 *
 * ## 自检（每次运行都执行，2026-09-23 R7-C P2-2）
 *
 * 与 `scripts/check-workflows.mjs` 的 `selfTestPolicies()` 同一纪律：判据的失效形态是
 * **静默放行**（上面那三条判据被包进 `if` 就是活例子），所以脚本内置一组合成报告样本，
 * 每次运行都跑一遍；任一样本不符合预期 ⇒ 本脚本自己 exit 2 并点名样本 id。
 * 样本包括：零 skip 且登记项被删除 ⇒ 必红；companion 只在别包 pass ⇒ 必红；
 * companion 登记成别包 ⇒ 必红（登记表自身非法）；未登记 skip ⇒ 必红；
 * 报告未覆盖 owner 包 ⇒ 不判红（判定面缺失如实打印）。
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
 * 允许的"显式跳过"（**每条必须带理由**，且必须**真的仍然 skip** —— 条目不再跳过时判失败，
 * 防止白名单腐烂成"永久豁免"）。
 *
 * 背景：§13 判据 2 要求 `skipped == 0`，防的是"PG 不可达 ⇒ 全部 t.Skip ⇒ 0 断言的假绿"。
 * 但仓库里确实存在**取证/E2E 出口**型的用例：它们不是回归断言，只在脚本显式给环境变量时
 * 才有意义（例如把服务端真正下发的技能包字节写出来喂给 JS 安装器）。把这类用例与
 * "静默跳过"混为一谈，只会逼着大家把真判据删掉 —— 所以按名字显式登记、打印理由，
 * 而不是放宽整条规则。
 *
 * `owner`：被登记用例**所在的包前缀**（第六轮 R7-C P2-2 起必填）—— 它同时是"判定面"：
 * 报告覆盖了这个前缀，条目就**必须**被判定；完全没覆盖时打印"未判定"（见文件头）。
 */
const OPT_IN_SKIPS = [
  {
    test: 'TestExportArchiveForE2E',
    owner: 'internal/wasmapp/skillseed',
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
 * 所以每条登记必须给五样东西，缺一不可：
 *   · `requires`：缺的是什么能力（打进日志，"跳过"永远带着原因）；
 *   · `owner`：被跳过用例**所在的包前缀**（判定面 —— 报告覆盖它就必须判定，见文件头）；
 *   · `companion`：**同一能力面**的形状判据用例名 —— 它必须在本报告里、**且在
 *     `companionPackage` 这个包前缀下**真的 `pass`，否则该 skip 判失败（形状判据不需要
 *     bwrap，能力缺席时它照样跑 ⇒ 一旦整包被静默跳过，companion 也拿不到 pass，
 *     这条通道立刻关闭）；
 *   · `companionPackage`：companion 必须所在的包前缀。**必须与 `owner` 同包（同一前缀族）**
 *     —— 2026-09-23 第七轮 R7-C P2-2 的现场就是"companion 只按裸名字在整份报告里找
 *     pass"，于是一条别包的恒过用例可以为任意包的任意 skip 背书。跨包登记在这里是
 *     **配置错误**（fail-loud），不是"更宽松的形态"。
 *   · `companionWhy`：**为什么这个 companion 与被跳过的能力同面**（一句话，打进日志）
 *     —— 没有它就没法评审"companion 到底证不证明得了这件事"。
 *   · `reason`：为什么这个代价可接受。
 *
 * 陈旧口径：报告覆盖了 owner 包、但该用例名**完全没出现**（改名/删除）判失败；
 * 真跑了并 pass 不判红（更严的形态）。
 */
const ENV_CONDITIONAL_SKIPS = [
  {
    test: 'TestCompileUnderBwrapIsolation',
    requires: 'bwrap',
    owner: 'internal/wasmapp/compile',
    companion: 'TestBwrapArgvShape',
    companionPackage: 'internal/wasmapp/compile',
    companionWhy: '同包同文件 isolation_test.go：它断言喂给 bwrap 的 argv 形状（隔离参数的唯一真源），'
      + '不需要 bwrap 就能跑 —— 隔离真的被跳掉时它仍会 pass，而"整包被静默跳过"时它也拿不到 pass。',
    reason: '隔离的端到端验收（真的在 bwrap 里编译一个模块）；CI runner 无可用 bwrap 时用例自身 t.Skip，argv 形状由 companion 覆盖',
  },
  {
    test: 'TestBwrapBlocksWriteOutsideCacheDir',
    requires: 'bwrap',
    owner: 'internal/wasmapp/compile',
    companion: 'TestBwrapArgvShape',
    companionPackage: 'internal/wasmapp/compile',
    companionWhy: '同包：写边界由 argv 里的 ro-bind 列表决定，companion 断言的正是那份列表的形状。',
    reason: '隔离的写入边界端到端验收；无 bwrap 即跳过（argv 形状由 companion 覆盖）',
  },
  {
    test: 'TestCompileTimeoutUnderBwrapLeavesNoResidue',
    requires: 'bwrap',
    owner: 'internal/wasmapp/compile',
    companion: 'TestBwrapArgvShape',
    companionPackage: 'internal/wasmapp/compile',
    companionWhy: '同包：超时击杀同样跑在 bwrap 下，隔离参数形状由 companion 覆盖（隔离外的超时路径另有 TestCompileTimeoutKillsChild）。',
    reason: '隔离下超时击杀不留残留；无 bwrap 即跳过（隔离外路径由 TestCompileTimeoutKillsChild 覆盖）',
  },
  {
    test: 'TestBwrapCannotReadOutsideWhitelist',
    requires: 'bwrap',
    owner: 'internal/wasmapp/compile',
    companion: 'TestBwrapArgvShape',
    companionPackage: 'internal/wasmapp/compile',
    companionWhy: '同包：读白名单就是 argv 里的 ro-bind 集合，companion 逐条断言它。',
    reason: '隔离的读取白名单端到端验收；无 bwrap 即跳过（argv 形状由 companion 覆盖）',
  },
  {
    test: 'TestBwrapTmpIsWritable',
    requires: 'bwrap',
    owner: 'internal/wasmapp/compile',
    companion: 'TestBwrapArgvShape',
    companionPackage: 'internal/wasmapp/compile',
    companionWhy: '同包：tmp 绑定与隔离参数同一份 argv，companion 覆盖形状。',
    reason: '隔离下 tmp 可写端到端验收；无 bwrap 即跳过（argv 形状由 companion 覆盖）',
  },
]

/** 报错前缀（自检与主流程共用，便于样本断言）。 */
const BIG = '  FAIL '

/**
 * 登记表自身的**形态校验**（与"报告里有没有"无关，永远执行）。
 *
 * 为什么单列：跨包 companion 是"用别包的恒过用例为这条 skip 背书"的登记形态，属配置错误；
 * 缺 `owner` / `companionPackage` / `companionWhy` 会让判定面退化成"整份报告里同名即可"。
 * 这类错误必须在**读报告之前**就说话（否则报告一干净就没人再看登记表）。
 *
 * @param options - `{ optInSkips, envConditionalSkips }`（自检可注入变异登记表）。
 * @returns 失败项列表。
 */
function validateRegistry({ optInSkips, envConditionalSkips }) {
  const failures = []
  for (const rule of optInSkips) {
    if (typeof rule.owner !== 'string' || rule.owner.trim() === '') {
      failures.push(`OPT_IN_SKIPS 的 \`${rule.test}\` 缺 \`owner\`（被登记用例所在的包前缀）`
        + ' —— 没有它，这条登记就没有判定面：报告零 skip 时它永远不会被检查')
    }
  }
  for (const rule of envConditionalSkips) {
    for (const field of ['requires', 'owner', 'companion', 'companionPackage', 'companionWhy', 'reason']) {
      if (typeof rule[field] !== 'string' || rule[field].trim() === '') {
        failures.push(`ENV_CONDITIONAL_SKIPS 的 \`${rule.test}\` 缺 \`${field}\``
          + '（owner/companionPackage 是判定面，companionWhy 是"同面"的评审依据）')
      }
    }
    if (typeof rule.owner !== 'string' || typeof rule.companionPackage !== 'string') continue
    // 同包（同一前缀族）：owner 与 companionPackage 必须互为前缀/相等。
    const sameFamily = rule.owner.includes(rule.companionPackage) || rule.companionPackage.includes(rule.owner)
    if (!sameFamily) {
      failures.push(`ENV_CONDITIONAL_SKIPS 的 \`${rule.test}\` 把 companion 登记到了**另一个包**`
        + `（owner=${rule.owner} / companionPackage=${rule.companionPackage}）`
        + '\n  ⇒ 别包的恒过用例不能为这条 skip 背书（2026-09-23 R7-C P2-2 的现场：companion'
        + ' 只按裸名字在整份报告里找 pass）—— 要么把 companion 挪回同包，要么说明这一条为什么'
        + '真的需要跨包（那种情况应改判据本身，不是放宽登记）。')
    }
  }
  return failures
}

/**
 * 判定一份 `go test -json` 报告（纯函数：自检与主流程共用，不落任何文件）。
 *
 * @param rawReport - 报告原文（NDJSON）。
 * @param options - `{ required, scope, optInSkips, envConditionalSkips }`。
 * @returns `{ failures, log, coveredOwners, unjudged, precondition }`
 *   - `failures`：不合格原因（空 = 通过）；
 *   - `log`：正常输出行（主流程打印，自检丢弃）；
 *   - `coveredOwners`：本次真的执行了判定的登记项；
 *   - `unjudged`：因报告未覆盖 owner 包而**无法判定**的登记项；
 *   - `precondition`：true = 这是**前置/接线**错误（调用方按退出码 2 处理），
 *     不是"报告不合格"（1）—— `--scope` 一个包都没匹配到就属于这一档。
 */
function analyzeReport(rawReport, options) {
  const { required: requiredNames, scope: scopePrefixes } = options
  const optInSkips = options.optInSkips ?? OPT_IN_SKIPS
  const envConditionalSkips = options.envConditionalSkips ?? ENV_CONDITIONAL_SKIPS
  const failures = [...validateRegistry({ optInSkips, envConditionalSkips })]
  const log = []

  /** 报告里出现过的**全部**用例名（含失败/跳过）—— 区分"被改名"与"跑了但没过"。 */
  const caseSeen = new Set()
  /** 用例级 pass：`测试名 → 出现 pass 的包集合`（companion 必须**绑包**，不再按裸名字）。 */
  const casePassPackages = new Map()
  /** 用例级 skip：`{ pkg, test }`。 */
  const caseSkips = []
  const packageSkips = new Set()
  const testFailures = []
  /** 范围内出现过的包（登记项判定面的前置：报告覆盖了 owner 包才判定）。 */
  const observedPackages = new Set()
  let events = 0
  let malformed = 0
  /** 被 `--scope` 排除掉的事件数（打印出来，避免"范围外的东西悄悄消失"）。 */
  let outOfScope = 0

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
    if (scopePrefixes.length > 0 && !scopePrefixes.some(prefix => pkg.includes(prefix))) {
      outOfScope += 1
      continue
    }
    events += 1
    if (pkg !== '') observedPackages.add(pkg)
    if (test !== null) caseSeen.add(test)
    if (event.Action === 'pass' && test !== null) {
      if (!casePassPackages.has(test)) casePassPackages.set(test, new Set())
      casePassPackages.get(test).add(pkg)
    }
    if (event.Action === 'skip') {
      if (test !== null) caseSkips.push({ pkg, test })
      else packageSkips.add(pkg)
    }
    if (event.Action === 'fail') testFailures.push(`${pkg}${test === null ? '' : `::${test}`}`)
  }

  if (scopePrefixes.length > 0 && observedPackages.size === 0) {
    failures.push(`前置缺失：--scope（${scopePrefixes.join(', ')}）在报告里没有匹配到任何包`
      + `（共 ${events + outOfScope} 个事件）`
      + ' —— 这不是通过：要么前缀写错，要么这份报告根本没覆盖判据面（范围外的东西不会替它变绿）')
    return { failures, log, coveredOwners: [], unjudged: [], precondition: true }
  }
  if (scopePrefixes.length > 0) {
    log.push(`  --scope ${scopePrefixes.join(', ')}：命中 ${observedPackages.size} 个包，范围外事件 ${outOfScope} 个（不参与判定）`)
  }
  log.push(`  go test -json：${events} 个事件（无法解析 ${malformed} 行）；用例级 pass ${casePassPackages.size} 个`)
  log.push(`  包级 skip ${packageSkips.size} 个（无测试文件的包，正常）${packageSkips.size === 0 ? '' : `：${[...packageSkips].join(' ')}`}`)

  if (events === 0) failures.push('报告里没有任何事件（go test 没跑起来？）—— 不得当成通过')
  if (casePassPackages.size === 0) failures.push('没有任何用例级 pass —— 零断言的门禁绿')

  // ===== 用例级 skip =====
  const envAllowed = []
  const unexpected = []
  for (const entry of caseSkips) {
    if (optInSkips.some(rule => rule.test === entry.test)) {
      const rule = optInSkips.find(candidate => candidate.test === entry.test)
      log.push(`  SKIP(opt-in) ${entry.pkg}::${entry.test} —— ${rule?.reason ?? ''}`)
      continue
    }
    const envRule = envConditionalSkips.find(rule => rule.test === entry.test)
    if (envRule !== undefined) {
      // 环境条件型：**必须**在同一能力面（登记包前缀）里看到 companion 的 `pass` ——
      // 否则不能证明"只是缺能力"，而可能是整包被静默跳过（PG 不可达那类形态正是这么溜过去的）。
      const passPackages = [...(casePassPackages.get(envRule.companion) ?? [])]
        .filter(pkg => pkg.includes(envRule.companionPackage))
      if (passPackages.length > 0) {
        envAllowed.push([entry, envRule, passPackages])
      } else {
        const elsewhere = [...(casePassPackages.get(envRule.companion) ?? [])]
        unexpected.push(`${entry.pkg}::${entry.test}`
          + `（登记为环境条件型 skip，但同能力面的形状判据 ${envRule.companion} 本次没有在包 `
          + `${envRule.companionPackage} 下 pass`
          + `${elsewhere.length === 0 ? '（全报告都没有它的 pass 事件）' : `（只在别包 pass：${elsewhere.join(', ')} —— 别包不能为它背书）`}`
          + ` ⇒ 无法证明只是缺 ${envRule.requires}）`)
      }
      continue
    }
    unexpected.push(`${entry.pkg}::${entry.test}`)
  }
  for (const [entry, rule, passPackages] of envAllowed) {
    log.push(`  SKIP(env:${rule.requires}) ${entry.pkg}::${entry.test} —— ${rule.reason}`
      + `（同包形状判据 ${rule.companion} 本次在 ${passPackages.join(', ')} pass ✅；${rule.companionWhy}）`)
  }
  if (unexpected.length > 0) {
    failures.push(`有未登记的用例级 skip ${unexpected.length} 个（PG 不可达/条件跳过 ⇒ 假绿，一律算失败）：${unexpected.slice(0, 20).join(' ')}`)
  }

  // ===== 登记表的完整性（**与"本次有没有 skip"无关**，2026-09-23 R7-C P2-2）=====
  //
  // 判定面 = 报告覆盖了该条登记的 `owner` 包。覆盖不到时**如实打印"未判定"**：
  // 判定面缺失既不能冒充通过（旧实现整块被 `if (caseSkips.length > 0)` 包住，零 skip
  // 时三条判据一条都不跑、照打"检查通过 ✅"），也不该制造假红（合成报告夹具只造一两个包）。
  const covers = prefix => [...observedPackages].some(pkg => pkg.includes(prefix))
  const coveredOwners = []
  const unjudged = []

  // OPT_IN 陈旧：登记了"会跳过"，实际却跑了 / 报告里压根没有（改名/删除）⇒ 必须清理登记项。
  for (const rule of optInSkips) {
    if (typeof rule.owner !== 'string' || rule.owner.trim() === '') continue // 已在 validateRegistry 报过
    if (!covers(rule.owner)) {
      unjudged.push(`OPT_IN_SKIPS \`${rule.test}\`（owner 包 ${rule.owner} 不在本次报告范围内）`)
      continue
    }
    coveredOwners.push(`OPT_IN_SKIPS:${rule.test}`)
    const skipping = caseSkips.some(entry => entry.test === rule.test)
    if (skipping) continue
    failures.push(caseSeen.has(rule.test)
      ? `OPT_IN_SKIPS 里的 \`${rule.test}\` 本次**不再跳过**（它真的跑了）—— 这条登记已经陈旧，请删除或改名`
      : `OPT_IN_SKIPS 里的 \`${rule.test}\` 在报告里**完全不存在**（改名/删除？owner 包 ${rule.owner} 本次被报告覆盖）`
        + ' —— 登记面与真实用例脱节，请同步登记（或删除该条）')
  }

  for (const rule of envConditionalSkips) {
    if (typeof rule.owner !== 'string' || rule.owner.trim() === '') continue
    if (typeof rule.companionPackage !== 'string' || rule.companionPackage.trim() === '') continue
    if (!covers(rule.owner)) {
      unjudged.push(`ENV_CONDITIONAL_SKIPS \`${rule.test}\`（owner 包 ${rule.owner} 不在本次报告范围内）`)
      continue
    }
    coveredOwners.push(`ENV_CONDITIONAL_SKIPS:${rule.test}`)
    // ① 登记项改名/删除：owner 包被覆盖，但用例名完全没出现。
    if (!caseSeen.has(rule.test)) {
      failures.push(`ENV_CONDITIONAL_SKIPS 里登记的用例在报告里**不存在**（改名/删除 ⇒ 请同步登记）：`
        + `${rule.test}（owner 包 ${rule.owner} 本次被报告覆盖）`)
      continue
    }
    // ② companion 缺失：形状判据必须在**登记的包**里拿到 pass（别包不算）。
    const passPackages = [...(casePassPackages.get(rule.companion) ?? [])]
      .filter(pkg => pkg.includes(rule.companionPackage))
    if (passPackages.length === 0) {
      const elsewhere = [...(casePassPackages.get(rule.companion) ?? [])]
      failures.push(`环境条件型 skip 的形状判据（companion）\`${rule.companion}\` 在登记包 `
        + `${rule.companionPackage} 下没有 pass`
        + `${elsewhere.length === 0 ? '（全报告都没有它的 pass 事件：改名/删除/整包被跳过）' : `（只在别包 pass：${elsewhere.join(', ')}）`}`
        + ' —— 没有它就无法把"缺能力"与"整包静默跳过"区分开，也不能用别包的恒过用例背书'
        + `（登记项 ${rule.test}，requires ${rule.requires}）`)
    }
  }

  if (unjudged.length > 0) {
    log.push(`  登记项判定面：${unjudged.length} 条本次**未判定**（报告没有覆盖它们所在的包 —— 既不算通过也不算失败）：`)
    for (const item of unjudged) log.push(`    · ${item}`)
  }
  if (coveredOwners.length > 0) {
    log.push(`  登记项判定面：${coveredOwners.length} 条本次已判定（覆盖即判定，与"有没有 skip"无关）：`
      + `${coveredOwners.join(', ')}`)
  }

  if (testFailures.length > 0) {
    failures.push(`有失败事件 ${testFailures.length} 个：${testFailures.slice(0, 20).join(' ')}`)
  }
  for (const name of requiredNames) {
    // 子测试（`TestX/case`）pass 不能替代父用例的 pass 事件，但父用例 pass 一定能命中精确名。
    if (casePassPackages.has(name)) continue
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

  return { failures, log, coveredOwners, unjudged }
}

/**
 * 合成一份 `go test -json` 报告（自检用；只造事件，不跑 Go）。
 * @param events - `{ Action, Package, Test? }[]`。
 * @returns NDJSON 文本。
 */
function syntheticReport(events) {
  return `${events.map(event => JSON.stringify(event)).join('\n')}\n`
}

/** 自检共用的包名。 */
const ST_PKG = {
  compile: 'picoaide/server/internal/wasmapp/compile',
  skillseed: 'picoaide/server/internal/wasmapp/skillseed',
  router: 'picoaide/server/internal/router',
  appserver: 'picoaide/server/internal/wasmapp/appserver',
}
/** 自检共用的 `--require` 名单（与合成报告里的 pass 事件对应）。 */
const ST_REQUIRED = ['TestAlpha', 'TestBeta']
/** 自检共用的 `--scope`（覆盖上面全部包）。 */
const ST_SCOPE = ['internal/wasmapp', 'internal/router']

/**
 * 造一份"完全健康"的合成报告：登记项都在、companion 在同包 pass、关键用例 pass。
 *
 * @param overrides - 事件级覆盖：
 *   · `remove`：按用例名删掉事件（模拟"改名/删除"）；
 *   · `companionPackage`：companion 的 pass 出现在哪个包（默认同包）；
 *   · `zeroSkips`：true = 把环境条件型登记项改成 `pass`、并**不**发 OPT_IN 的 skip
 *     （整份报告**零**用例级 skip —— 这正是 R7-C P2-2 里"三条判据一条都不跑"的形态）。
 * @returns 报告文本。
 */
function healthyReport(overrides = {}) {
  const remove = new Set(overrides.remove ?? [])
  const zeroSkips = overrides.zeroSkips === true
  const events = [
    { Action: 'pass', Package: ST_PKG.appserver, Test: ST_REQUIRED[0] },
    { Action: 'pass', Package: ST_PKG.appserver, Test: ST_REQUIRED[1] },
    { Action: 'pass', Package: ST_PKG.appserver },
    // companion 的 pass：默认在同包；换包即"别包的恒过用例"形态。
    { Action: 'pass', Package: overrides.companionPackage ?? ST_PKG.compile, Test: 'TestBwrapArgvShape' },
    { Action: 'pass', Package: ST_PKG.skillseed, Test: 'TestBuiltinSkillVersionTracksContent' },
  ]
  for (const rule of ENV_CONDITIONAL_SKIPS) {
    events.push({ Action: zeroSkips ? 'pass' : 'skip', Package: ST_PKG.compile, Test: rule.test })
  }
  if (!zeroSkips) events.push({ Action: 'skip', Package: ST_PKG.skillseed, Test: 'TestExportArchiveForE2E' })
  return syntheticReport(events.filter(event => !remove.has(event.Test ?? '')))
}

/**
 * 内置自检：合成报告样本必须按预期红/绿（**每次运行都执行**）。
 *
 * 为什么内置（与 `scripts/check-workflows.mjs` 的 `selfTestPolicies()` 同一纪律）：这些
 * 判据的失效形态是**静默放行** —— 2026-09-23 R7-C P2-2 的现场就是"三条登记检查被
 * `if (caseSkips.length > 0)` 包住，零 skip 时一条都不跑、照打检查通过 ✅"。把整块
 * 挪出 `if` 之后，还要有人盯着"它真的在咬"：样本里既有必须红的（零 skip + 登记项被删、
 * companion 只在别包 pass、companion 登记成别包、未登记 skip），也有必须绿的
 * （报告没覆盖 owner 包 ⇒ 不判红），任一条不符 ⇒ 本脚本 exit 2。
 *
 * @returns 自检失败项列表（空 = 通过）。
 */
function selfTest() {
  const failures = []
  const run = (report, options = {}) => analyzeReport(report, {
    required: ST_REQUIRED,
    scope: ST_SCOPE,
    optInSkips: options.optInSkips ?? OPT_IN_SKIPS,
    envConditionalSkips: options.envConditionalSkips ?? ENV_CONDITIONAL_SKIPS,
  })
  const expect = (id, ok, detail) => {
    if (!ok) failures.push(`[selftest] 样本 \`${id}\`：${detail}`)
  }
  const expectGreen = (id, report, options) => {
    const result = run(report, options)
    expect(id, result.failures.length === 0,
      `期望绿，实际被判失败：\n${result.failures.map(item => `      ${item.split('\n')[0]}`).join('\n')}`)
  }
  const expectRed = (id, report, needle, options) => {
    const result = run(report, options)
    const ok = result.failures.some(item => item.includes(needle))
    expect(id, ok, `期望判失败且点名 \`${needle}\`，实际：${JSON.stringify(result.failures.map(item => item.split('\n')[0]))}`)
  }

  // ① 正例：登记项齐、companion 同包 pass、关键用例 pass ⇒ 必须绿（否则会逼着放宽判据）。
  expectGreen('s1-healthy-green', healthyReport())

  // ② **零 skip** 且登记项被删除 ⇒ 必须红（R7-C P2-2 的现场：旧实现整块在
  //    `if (caseSkips.length > 0)` 里，这种报告一条判据都不跑、照打"检查通过 ✅"）。
  expectRed('s2-zero-skip-env-registration-deleted',
    healthyReport({ zeroSkips: true, remove: ['TestBwrapTmpIsWritable'] }),
    'ENV_CONDITIONAL_SKIPS 里登记的用例在报告里')
  //    同一形态的另两条：OPT_IN 登记项被改名（零 skip）/ companion 缺失（零 skip）。
  expectRed('s3-zero-skip-optin-registration-deleted', healthyReport({ zeroSkips: true }),
    'OPT_IN_SKIPS 里的 `TestExportArchiveForE2E` 在报告里')
  expectRed('s4-zero-skip-companion-missing',
    healthyReport({ zeroSkips: true, remove: ['TestBwrapArgvShape'] }),
    'companion')

  // ③ companion 只在**别包** pass ⇒ 必须红（别包的恒过用例不能为这条 skip 背书）。
  expectRed('s5-companion-in-other-package', healthyReport({ companionPackage: ST_PKG.router }),
    '别包')

  // ④ companion 被**登记**到别包 ⇒ 登记表自身非法，必须红（不依赖报告内容）。
  expectRed('s6-registry-cross-package-companion', healthyReport(), '另一个包', {
    envConditionalSkips: ENV_CONDITIONAL_SKIPS.map((rule, index) => (index === 0
      ? { ...rule, companionPackage: 'internal/router' }
      : rule)),
  })

  // ⑤ 未登记的用例级 skip 仍然一律算失败（第三轮 W-4 的老判据不能在本轮改动里退化）。
  expectRed('s7-unregistered-skip',
    `${healthyReport()}\n${JSON.stringify({ Action: 'skip', Package: ST_PKG.router, Test: 'TestSomethingSkipped' })}\n`,
    '未登记的用例级 skip')

  // ⑥ 报告**没覆盖** owner 包时不判红，但必须如实打印"未判定"（合成报告夹具依赖这条：
  //    `scripts/verify-ci-scripts.mjs` 只造 appserver 一个包）。
  const uncovered = run(syntheticReport([
    { Action: 'pass', Package: ST_PKG.appserver, Test: ST_REQUIRED[0] },
    { Action: 'pass', Package: ST_PKG.appserver, Test: ST_REQUIRED[1] },
    { Action: 'pass', Package: ST_PKG.appserver },
  ]))
  expect('s8-uncovered-owner-not-red', uncovered.failures.length === 0,
    `报告未覆盖 owner 包时不得判红（判定面缺失 ≠ 不合格）：${JSON.stringify(uncovered.failures.map(item => item.split('\n')[0]))}`)
  expect('s9-uncovered-owner-reported', uncovered.unjudged.length === OPT_IN_SKIPS.length + ENV_CONDITIONAL_SKIPS.length
    && uncovered.log.some(line => line.includes('未判定')),
    `未覆盖的登记项必须如实打印"未判定"（实际 unjudged=${uncovered.unjudged.length}）`)

  return failures
}

// ===== 主流程 =====
const selfTestFailures = selfTest()
if (selfTestFailures.length > 0) {
  console.error(`${BIG}本脚本自检失败（判据可能已经形同不存在）—— 这不是报告的问题，先修判据脚本：`)
  for (const message of selfTestFailures) console.error(`  ${message}`)
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
  console.error(`${BIG}前置缺失：go test JSON 报告不可读（${report}）—— ${cause.code ?? cause.message}`)
  console.error('  —— 这不是通过：本判据必须先有 go test -json 报告；请检查上一步是否真的产出报告（路径/工作目录/tee 是否接上）')
  process.exit(2)
}

const result = analyzeReport(rawReport, { required, scope })
for (const line of result.log) console.log(line)
if (result.failures.length > 0) {
  for (const message of result.failures) console.error(`${BIG}${message}`)
  // 前置/接线错误（`--scope` 一个包都没匹配到）按 2 退出：调用方只能看到"非零"，
  // 但排障要能一眼区分"报告不合格"（1）与"这份报告与判据面不一致"（2）。
  process.exit(result.precondition === true ? 2 : 1)
}
console.log(`  关键用例全部 pass：${required.join(', ')}`)
console.log('  go test 报告检查通过 ✅')
