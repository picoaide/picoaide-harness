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
 *       `--require` 的名字没登记 / 它的登记包没被报告覆盖、本脚本自检失败）—— 显式打印
 *       原因并明确"这不是通过"。缺报告时绝不静默绿：没有报告就没有判定，只有环境/接线错误。
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
 *
 * ## 自检本身也必须是**有下限**的（2026-09-24 第八轮对抗审计 R8-C-5 / C-6）
 *
 * 现场（已复现）：把 `selfTest()` 改成 `return []`（一行）之后，脚本照打「检查通过 ✅」
 * 并对任何报告 exit 0 —— 全量 `verify-ci-scripts.mjs`（= 根守卫 `check:ci-scripts`，
 * `yarn check` 的一员）同样 EXIT=0。也就是说"判据失效时唯一会说话的东西"被掏空之后，
 * 第 7 轮修的那个 bug（三条登记检查退回 `if (caseSkips.length > 0)`）可以原样复发而
 * 门禁全绿。同一轮的 `check-workflows.mjs` 有四条 `SELFTEST_*_ASSERTIONS` 下限，
 * 这里此前**一条都没有**。现在补两条**在主流程里**（= 在 `selfTest()` 之外）执行的判据：
 *
 *   · `SELFTEST_SAMPLE_IDS` 是样本 id 的**登记表**：实际执行的 id 集合必须与它逐个相等
 *     （少一个 ⇒ 红；多一个未登记的 ⇒ 也红），且 `assertions` 计数必须等于登记数
 *     —— 掏空 `selfTest()`（返回 `[]` / 少了字段 / 少跑样本）一律 exit 2；
 *   · **退出码矩阵**（R8-C-6）：真起子进程、用真夹具跑**本脚本自己**，逐条断言
 *     `0 = 通过 / 1 = 报告不合格 / 2 = 前置缺失`（含 `--scope` 未命中与报告不可读两条
 *     前置分支）。此前把 `precondition: true` 改成 `false`（2 退化回 1）没有任何判据会响
 *     —— 文档与 `ci.yml` 注释都写着三段可区分，而它零覆盖。
 *
 * ## 包身份 / 范围身份是**结构化**匹配（2026-09-24 R8-C-11 / R8-C-12 / GATE-5c）
 *
 * 旧实现一律 `pkg.includes(prefix)`：`…/internal/wasmapp/compilehelpers` 被当成
 * `…/internal/wasmapp/compile`（别包为 companion 背书）、`…/internal/routerx` 被当成
 * `…/internal/router`（伪造报告冒充判定面），且 `Action: skip` 而缺 `Package` 的事件被
 * 静默当成"范围外"。现在按**路径段**匹配（逐段相等且连续，尾斜杠自动归一）：
 * `internal/wasmapp` 仍命中 `…/internal/wasmapp/api`（片段语义不变），但不再命中
 * `…/internal/wasmapp_legacy`；`skip`/`fail` 事件缺 `Package` 直接判**报告损坏**。
 *
 * ## `--require` 必须**绑包**（2026-09-24 R8-D-23 / GATE-5）
 *
 * 旧实现是 `casePassPackages.has(name)` —— **裸用例名**，任何包里有一条同名 pass 就算数。
 * 现场（已复现）：三条关键用例只在 `internal/router` pass、其真实所属包
 * `internal/wasmapp/appserver` 只贡献一条无关 pass，脚本仍报「关键用例全部 pass ✅」。
 * 第 7 轮把 `companion` 绑到了 `companionPackage`，`--require` 漏了。现在三条关键用例
 * 登记在 `REQUIRED_CASES`（`owner` = 必须看到 pass 的包前缀，附理由）：未登记的
 * `--require` 名 = 配置错误（exit 2）；登记包**完全没被报告覆盖** = 前置缺失（exit 2，
 * 判定面缺失不得算通过）；只在别包 pass = 不合格（exit 1）。
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
 * 自检样本 id 的**登记表**（R8-C-5：自检本身必须有完整性下限）。
 *
 * 为什么需要它：`selfTest()` 的失效形态与它守护的判据一模一样 —— **静默放行**。
 * 把 `selfTest()` 改成 `return []` 一行，脚本就对任何报告说"检查通过 ✅"，而全量
 * `verify-ci-scripts.mjs`（根守卫 `check:ci-scripts`）同样 EXIT=0。所以主流程在
 * `selfTest()` **之外**核对：实际执行的样本 id 集合必须与这份登记表逐个相等、且
 * `assertions` 计数必须等于登记数 —— 少一个样本、多一个未登记样本、或返回值形状变了，
 * 一律 exit 2（详见文件头"自检本身也必须是有下限的"）。
 *
 * 纪律与其它登记表一致：**加了样本就要登记**（未登记的 id 会被判红），
 * **删样本就要删登记**（登记了却没跑同样判红）—— 两边都不许悄悄漂移。
 *
 * 分两段：`s*` 是纯函数样本（`analyzeReport` 的合成报告）；`e*` 是**退出码矩阵**
 * （真起子进程跑本脚本自己，见文件头 R8-C-6）。子进程只跑 `s*`（否则会无限递归），
 * 所以两段分开登记、主流程按当前进程是不是子进程取对应的登记表。
 */
const SELFTEST_ANALYSIS_SAMPLE_IDS = Object.freeze([
  's1-healthy-green',
  's2-zero-skip-env-registration-deleted',
  's3-zero-skip-optin-registration-deleted',
  's4-zero-skip-companion-missing',
  's5-companion-in-other-package',
  's6-registry-cross-package-companion',
  's7-unregistered-skip',
  's8-uncovered-owner-not-red',
  's9-uncovered-owner-reported',
  's10-require-other-package-only',
  's11-require-owner-not-covered',
  's12-require-unregistered',
  's13-malformed-line-fails',
  's14-skip-without-package-fails',
  's15-companion-prefix-spoof',
  's16-scope-prefix-spoof',
  's17-skip-out-of-scope-boundary',
])
const SELFTEST_MATRIX_SAMPLE_IDS = Object.freeze([
  'e1-exit-0-clean',
  'e2-exit-1-bad-report',
  'e3-exit-2-scope-miss',
  'e4-exit-2-report-missing',
  'e5-exit-1-truncated-report',
  'e6-exit-2-require-unregistered',
  'e7-exit-1-require-other-package',
])
const SELFTEST_SAMPLE_IDS = Object.freeze([...SELFTEST_ANALYSIS_SAMPLE_IDS, ...SELFTEST_MATRIX_SAMPLE_IDS])
/** 退出码矩阵的子进程用它跳过"再起子进程"那一段（唯一的用途，见 `selfTest()`）。 */
const SELFTEST_CHILD_ENV = 'CHECK_GO_TEST_JSON_SELFTEST_CHILD'
/** 当前进程是不是退出码矩阵的子进程。 */
const IS_SELFTEST_CHILD = process.env[SELFTEST_CHILD_ENV] === '1'

/**
 * `--require` 的**关键用例登记表**：每条必须绑定它**真实所属的包**（R8-D-23 / GATE-5）。
 *
 * 现场（第 8 轮，已复现）：`--require` 此前只按**裸用例名**在整份报告里找 pass
 * （`casePassPackages.has(name)`），于是三条契约用例可以在自己的包里被删除/改名、由
 * **另一个包**里的同名平凡用例顶替，而门禁照打「关键用例全部 pass ✅」。第 7 轮把
 * `ENV_CONDITIONAL_SKIPS` 的 `companion` 绑到了 `companionPackage`，`--require` 漏了。
 *
 * 三条判据（缺一条就有一个绕过口）：
 *   ① `--require` 的名字必须在本表登记（`owner` + 理由）—— 没登记 = 配置错误（exit 2），
 *      因为"没有登记就没有判定面"，而裸名字可以被任意包满足；
 *   ② 该名字的 pass 必须出现在 `owner` 这个包前缀**之下**（按路径段匹配，见
 *      `packageMatchesPrefix`：`compilehelpers` 不能再冒充 `compile`）；
 *   ③ 报告**完全没有覆盖** `owner` 包 = 前置缺失（exit 2，判定面缺失不得算通过；
 *      也覆盖"go test 的包清单被改窄"这种接线退化）。
 *
 * 与 `scripts/check-workflows.mjs` 的 `WASM_CASE_GATE_REQUIRED`、
 * `scripts/verify-wasm-client-only.sh` 组 3 是**同一份名单**：改名/增删必须三处同步
 * （`scripts/check-workflows.mjs` 的静态策略会红）。
 */
const REQUIRED_CASES = [
  {
    test: 'TestClientRequest_LoginRequiredWithoutIdentityIs401',
    owner: 'internal/wasmapp/appserver',
    why: '宿主 client 面的身份准入契约（未携带身份 ⇒ 401）；与下两条同在 '
      + 'server/internal/wasmapp/appserver/client_test.go',
  },
  {
    test: 'TestCheckClientOrigin',
    owner: 'internal/wasmapp/appserver',
    why: '渠道命名空间守卫（A-8）的 origin 契约；同包 client_test.go',
  },
  {
    test: 'TestClientFrameUser_ProjectsUserRowAndPublisherFlag',
    owner: 'internal/wasmapp/appserver',
    why: 'URL 帧 → 用户行/发布者标志的投影契约（W1 由 TestClientFrameUser_MatchesSessionProjection 改名而来）；同包 client_test.go',
  },
]

/**
 * 包导入路径的**结构化**匹配（R8-C-11 / R8-C-12 / GATE-5c）。
 *
 * 旧实现一律 `pkg.includes(prefix)`，于是"前缀像同族的包"可以互相背书：
 * `…/internal/wasmapp/compilehelpers` 被当成 `…/internal/wasmapp/compile`、
 * `…/internal/routerx` 被当成 `…/internal/router`。现在按**路径段**匹配
 * （逐段相等且**连续**），保留"片段"语义（`internal/wasmapp` 仍命中
 * `…/internal/wasmapp/api` 与 `…/internal/wasmapp` 本身），但不再允许段内前缀。
 * 尾斜杠由 `filter(Boolean)` 归一（`internal/router/` 不再需要调用方手工去掉）。
 *
 * @param pkg - 报告里的包导入路径（可能为空串）。
 * @param prefix - 登记/传入的包前缀（片段）。
 * @returns 是否命中。
 */
function packageMatchesPrefix(pkg, prefix) {
  if (typeof pkg !== 'string' || pkg === '') return false
  const pkgSegments = pkg.split('/').filter(Boolean)
  const prefixSegments = prefix.split('/').filter(Boolean)
  if (prefixSegments.length === 0 || prefixSegments.length > pkgSegments.length) return false
  for (let start = 0; start + prefixSegments.length <= pkgSegments.length; start += 1) {
    let matched = true
    for (let offset = 0; offset < prefixSegments.length; offset += 1) {
      if (pkgSegments[start + offset] !== prefixSegments[offset]) {
        matched = false
        break
      }
    }
    if (matched) return true
  }
  return false
}

/**
 * 登记表自身的**形态校验**（与"报告里有没有"无关，永远执行）。
 *
 * 为什么单列：跨包 companion 是"用别包的恒过用例为这条 skip 背书"的登记形态，属配置错误；
 * 缺 `owner` / `companionPackage` / `companionWhy` 会让判定面退化成"整份报告里同名即可"。
 * 这类错误必须在**读报告之前**就说话（否则报告一干净就没人再看登记表）。
 *
 * 这里同时校验 `--require`（R8-D-23）：名字必须在 `REQUIRED_CASES` 里登记、且登记的
 * `owner`/`why` 必须是**非空字符串** —— 没有 owner 就退化成"裸名字"，正是被修掉的那个洞。
 *
 * @param options - `{ optInSkips, envConditionalSkips, requiredNames, requiredCases }`
 *   （自检可注入变异登记表）。
 * @returns 失败项列表（配置错误 ⇒ 调用方按退出码 2 处理）。
 */
function validateRegistry({ optInSkips, envConditionalSkips, requiredNames, requiredCases }) {
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
    const sameFamily = packageMatchesPrefix(rule.owner, rule.companionPackage)
      || packageMatchesPrefix(rule.companionPackage, rule.owner)
    if (!sameFamily) {
      failures.push(`ENV_CONDITIONAL_SKIPS 的 \`${rule.test}\` 把 companion 登记到了**另一个包**`
        + `（owner=${rule.owner} / companionPackage=${rule.companionPackage}）`
        + '\n  ⇒ 别包的恒过用例不能为这条 skip 背书（2026-09-23 R7-C P2-2 的现场：companion'
        + ' 只按裸名字在整份报告里找 pass）—— 要么把 companion 挪回同包，要么说明这一条为什么'
        + '真的需要跨包（那种情况应改判据本身，不是放宽登记）。')
    }
  }
  // `--require` 的名字必须有登记（owner + 理由），否则"判定面"就是整份报告（R8-D-23）。
  for (const name of requiredNames) {
    const rule = requiredCases.find(candidate => candidate.test === name)
    if (rule === undefined) {
      failures.push(`--require 的 \`${name}\` 没有登记（REQUIRED_CASES 里找不到它）`
        + ' ⇒ 它没有**绑包**：任何包里一条同名 pass 都能满足它（R8-D-23 / GATE-5 的现场：'
        + '三条契约用例只在 internal/router pass，真实所属包只贡献一条无关 pass，脚本照报'
        + '"关键用例全部 pass ✅"）。请在 `REQUIRED_CASES` 里登记 `owner`（必须看到 pass 的包前缀）'
        + '与理由，或从 `--require` 名单里去掉它。')
      continue
    }
    for (const field of ['owner', 'why']) {
      if (typeof rule[field] !== 'string' || rule[field].trim() === '') {
        failures.push(`REQUIRED_CASES 的 \`${name}\` 缺 \`${field}\``
          + '（owner 是判定面：必须在它之下看到 pass；why 是"为什么是包"的评审依据）')
      }
    }
  }
  return failures
}

/**
 * 判定一份 `go test -json` 报告（纯函数：自检与主流程共用，不落任何文件）。
 *
 * @param rawReport - 报告原文（NDJSON）。
 * @param options - `{ required, scope, optInSkips, envConditionalSkips, requiredCases }`。
 * @returns `{ failures, blockers, log, coveredOwners, unjudged, precondition }`
 *   - `failures`：不合格原因（空 = 通过）；
 *   - `blockers`：**前置/配置/接线**错误（登记表非法、`--scope` 未命中、`--require` 的
 *     登记包没被报告覆盖）—— 调用方按退出码 2 处理，不是"报告不合格"（1）；
 *   - `log`：正常输出行（主流程打印，自检丢弃）；
 *   - `coveredOwners`：本次真的执行了判定的登记项；
 *   - `unjudged`：因报告未覆盖 owner 包而**无法判定**的登记项；
 *   - `precondition`：`blockers.length > 0`（= 前面那两件事的合计）。
 */
function analyzeReport(rawReport, options) {
  const { required: requiredNames, scope: scopePrefixes } = options
  const optInSkips = options.optInSkips ?? OPT_IN_SKIPS
  const envConditionalSkips = options.envConditionalSkips ?? ENV_CONDITIONAL_SKIPS
  const requiredCases = options.requiredCases ?? REQUIRED_CASES
  /** 前置/配置/接线错误（⇒ exit 2）；`failures` 是"报告不合格"（⇒ exit 1）。 */
  const blockers = [...validateRegistry({ optInSkips, envConditionalSkips, requiredNames, requiredCases })]
  const failures = []
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
  /** 损坏事件（`skip`/`fail` 却没有 `Package`）—— 报告被裁剪/拼接，不是"范围外"（R8-C-12）。 */
  const corruptEvents = []
  let events = 0
  let malformed = 0
  let firstMalformed = null
  /** 被 `--scope` 排除掉的事件数（打印出来，避免"范围外的东西悄悄消失"）。 */
  let outOfScope = 0

  for (const line of rawReport.split('\n')) {
    if (line.trim() === '') continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      malformed += 1
      if (firstMalformed === null) firstMalformed = line.trim().slice(0, 160)
      continue
    }
    const test = typeof event.Test === 'string' && event.Test !== '' ? event.Test : null
    const pkg = typeof event.Package === 'string' ? event.Package : ''
    // 报告损坏（R8-C-12 / GATE-5c A4）：`skip`/`fail` 却缺 `Package` 的事件此前被
    // `''.includes(prefix) === false` 静默归到"范围外"，于是被裁剪/伪造的报告照样绿。
    // 真 `go test -json` 的包级事件恒带 `Package`（只有 `build-output`/`build-fail`
    // 用 `ImportPath`，而它们的 `Action` 不是 skip/fail），所以这一档只可能是坏报告。
    if (pkg === '' && (event.Action === 'skip' || event.Action === 'fail')) {
      corruptEvents.push(`${event.Action} 事件缺 Package（ImportPath=${JSON.stringify(event.ImportPath ?? null)}）`)
      continue
    }
    // `--scope`：只判范围内的事件（范围外的不参与计数/判定，见文件头"为什么 CI 需要它"）。
    if (scopePrefixes.length > 0 && !scopePrefixes.some(prefix => packageMatchesPrefix(pkg, prefix))) {
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

  // 报告被截断/拼接（磁盘满、`tee` 接错、写入方被杀）⇒ 尾部的判定行会**整段消失**。
  // 旧实现只把行数打出来（"无法解析 1 行"）然后照打"检查通过 ✅"（R8-D-25 / GATE-5b）。
  if (malformed > 0) {
    failures.push(`报告有 ${malformed} 行不是合法 JSON（首个：${JSON.stringify(firstMalformed ?? '')}）`
      + ' —— 报告被截断/拼接（磁盘满、tee 接错、写入方被 kill）时尾部的判定行会整段消失，'
      + '不得当成通过；请检查 go test -json 的落盘与报告体积。')
  }
  if (corruptEvents.length > 0) {
    failures.push(`报告有 ${corruptEvents.length} 个损坏事件（${corruptEvents.slice(0, 5).join('；')}）`
      + ' —— `skip`/`fail` 事件缺 `Package` 不是"范围外"，而是报告被裁剪/伪造（R8-C-12）')
  }

  if (scopePrefixes.length > 0 && observedPackages.size === 0) {
    blockers.push(`前置缺失：--scope（${scopePrefixes.join(', ')}）在报告里没有匹配到任何包`
      + `（共 ${events + outOfScope} 个事件）`
      + ' —— 这不是通过：要么前缀写错，要么这份报告根本没覆盖判据面（范围外的东西不会替它变绿）')
    return {
      failures: [...blockers, ...failures],
      blockers,
      log,
      coveredOwners: [],
      unjudged: [],
      precondition: true,
    }
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
        .filter(pkg => packageMatchesPrefix(pkg, envRule.companionPackage))
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
  const covers = prefix => [...observedPackages].some(pkg => packageMatchesPrefix(pkg, prefix))
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
      .filter(pkg => packageMatchesPrefix(pkg, rule.companionPackage))
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
    // **绑包**（R8-D-23 / GATE-5）：裸名字可以被任意包的同名平凡用例满足，所以每条
    // `--require` 都必须在 `REQUIRED_CASES` 里登记它**真实所属的包前缀**，并在那儿拿到 pass。
    const rule = requiredCases.find(candidate => candidate.test === name)
    if (rule === undefined || typeof rule.owner !== 'string' || rule.owner.trim() === '') {
      // 未登记 / owner 非法已在 validateRegistry 里报过（⇒ exit 2）：这里不重复报，也**不**
      // 退回"裸名字"语义（那正是被修掉的洞）。
      continue
    }
    const ownerPass = [...(casePassPackages.get(name) ?? [])]
      .filter(pkg => packageMatchesPrefix(pkg, rule.owner))
    if (ownerPass.length > 0) continue
    // 判定面缺失（报告完全没有覆盖登记包）⇒ 前置/接线错误，不得算通过：这正是
    // "把 go test 的包清单改窄"或"报道路径接到别的报告上"的形态。
    if (!covers(rule.owner)) {
      blockers.push(`前置缺失：--require 的 \`${name}\` 登记包 ${rule.owner} 本次报告**完全没有覆盖**`
        + `（报告里共 ${observedPackages.size} 个包）—— 判定面缺失不得算通过：要么报告范围`
        + '（go test 的包清单 / --scope）被改窄了，要么读的不是这次的报告（R8-D-23）。')
      continue
    }
    const elsewhere = [...(casePassPackages.get(name) ?? [])]
    if (elsewhere.length > 0) {
      failures.push(`关键用例只在**别包** pass：${name} —— 登记包 ${rule.owner} 下没有它的 pass`
        + `（实际 pass 在：${elsewhere.join(', ')}）`
        + ' ⇒ 别包的同名用例不能为它背书（R8-D-23 / GATE-5：真实所属包被改名/删除后，'
        + '另一包里的同名平凡用例顶替即可让门禁全绿）。')
      continue
    }
    // 子测试（`TestX/case`）pass 不能替代父用例的 pass 事件，但父用例 pass 一定能命中精确名。
    if (!caseSeen.has(name)) {
      // **被改名**与"跑了但没过"是两件事：前者要改这里的 `--require` 名单（或说明契约变更），
      // 后者是真失败。混在一起报会让人以为是缺陷（W1 改名 `TestClientFrameUser_*` 时踩过）。
      const stem = name.replace(/^Test/u, '').slice(0, 12)
      const candidates = [...caseSeen].filter(seen => seen.includes(stem)).slice(0, 5)
      failures.push(`关键用例在报告里**不存在**（可能已被改名 ⇒ 请同步 --require 名单与 REQUIRED_CASES 登记）：${name}`
        + `（登记包 ${rule.owner} 本次被报告覆盖）`
        + `${candidates.length === 0 ? '' : `；候选：${candidates.join(', ')}`}`)
    } else {
      failures.push(`关键用例未 pass（存在但没通过）：${name}（登记包 ${rule.owner}）`)
    }
  }

  return {
    failures: [...blockers, ...failures],
    blockers,
    log,
    coveredOwners,
    unjudged,
    precondition: blockers.length > 0,
  }
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
  // 只差一个后缀的**兄弟包**：`includes('…/compile')` 会把它当成 compile（R8-C-11 / A2）。
  compileHelpers: 'picoaide/server/internal/wasmapp/compilehelpers',
  skillseed: 'picoaide/server/internal/wasmapp/skillseed',
  router: 'picoaide/server/internal/router',
  // 同上：`includes('internal/router')` 会把它当成 router（R8-C-11 / A3）。
  routerSpoof: 'picoaide/server/thirdparty/internal/routerx',
  // 段内前缀的**范围**形态：`includes('internal/wasmapp')` 会把它算进 --scope（假红）。
  wasmappLegacy: 'picoaide/server/internal/wasmapp_legacy',
  appserver: 'picoaide/server/internal/wasmapp/appserver',
}
/** 自检共用的 `--require` 名单（与合成报告里的 pass 事件对应）。 */
const ST_REQUIRED = ['TestAlpha', 'TestBeta']
/** 自检用的关键用例登记（把合成名单绑到 appserver；真实登记表见 `REQUIRED_CASES`）。 */
const ST_REQUIRED_CASES = ST_REQUIRED.map(test => ({
  test,
  owner: 'internal/wasmapp/appserver',
  why: '自检合成样本（真实名单见 REQUIRED_CASES）',
}))
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
 * 内置自检：合成报告样本 + **退出码矩阵**必须按预期红/绿（**每次运行都执行**）。
 *
 * 为什么内置（与 `scripts/check-workflows.mjs` 的 `selfTestPolicies()` 同一纪律）：这些
 * 判据的失效形态是**静默放行** —— 2026-09-23 R7-C P2-2 的现场就是"三条登记检查被
 * `if (caseSkips.length > 0)` 包住，零 skip 时一条都不跑、照打检查通过 ✅"。把整块
 * 挪出 `if` 之后，还要有人盯着"它真的在咬"：样本里既有必须红的（零 skip + 登记项被删、
 * companion 只在别包 pass、companion 登记成别包、未登记 skip、报告被截断、关键用例只在
 * 别包 pass），也有必须绿的（报告没覆盖 owner 包 ⇒ 不判红），任一条不符 ⇒ 本脚本 exit 2。
 *
 * 返回值是 `{ failures, assertions, samples }`（**不是**裸数组）：主流程要能区分
 * "自检跑了但失败"与"自检被掏空"（返回 `[]` / 少了字段 / 少跑样本）—— 后者同样 exit 2。
 *
 * @returns `{ failures, assertions, samples }`：失败项列表、断言数、实际执行的样本 id。
 */
function selfTest() {
  const failures = []
  const samples = []
  const run = (report, options = {}) => analyzeReport(report, {
    required: options.required ?? ST_REQUIRED,
    scope: options.scope ?? ST_SCOPE,
    optInSkips: options.optInSkips ?? OPT_IN_SKIPS,
    envConditionalSkips: options.envConditionalSkips ?? ENV_CONDITIONAL_SKIPS,
    requiredCases: options.requiredCases ?? ST_REQUIRED_CASES,
  })
  const expect = (id, ok, detail) => {
    samples.push(id)
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
  const expectBlocked = (id, report, needle, options) => {
    const result = run(report, options)
    const ok = result.precondition === true && result.blockers.some(item => item.includes(needle))
    expect(id, ok, `期望按**前置/配置错误**判（点名 \`${needle}\`），实际 precondition=${String(result.precondition)}：`
      + JSON.stringify(result.failures.map(item => item.split('\n')[0])))
  }

  // ① 正例：登记项齐、companion 同包 pass、关键用例在登记包 pass ⇒ 必须绿（否则会逼着放宽判据）。
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

  // ⑦ `--require` **绑包**（R8-D-23 / GATE-5）：只在别包 pass ⇒ 必红；登记包没被覆盖 ⇒ 前置
  //    错误（exit 2）；名字没登记 ⇒ 配置错误（exit 2）——三条缺一条就退回"裸名字"。
  expectRed('s10-require-other-package-only', syntheticReport([
    ...ST_REQUIRED.map(test => ({ Action: 'pass', Package: ST_PKG.router, Test: test })),
    { Action: 'pass', Package: ST_PKG.appserver, Test: 'TestUnrelated' },
    { Action: 'pass', Package: ST_PKG.appserver },
  ]), '别包')
  expectBlocked('s11-require-owner-not-covered', syntheticReport([
    ...ST_REQUIRED.map(test => ({ Action: 'pass', Package: ST_PKG.router, Test: test })),
    { Action: 'pass', Package: ST_PKG.router },
  ]), '完全没有覆盖')
  expectBlocked('s12-require-unregistered', healthyReport(), '没有登记', {
    required: [ST_REQUIRED[0], 'TestNotRegisteredAnywhere'],
  })

  // ⑧ 报告被截断 / 拼接（R8-D-25 / GATE-5b）：旧实现只打"无法解析 1 行"仍 exit 0。
  expectRed('s13-malformed-line-fails',
    `${healthyReport()}{"Action":"fail","Package":"picoaide/server/internal/`,
    '不是合法 JSON')
  //    `skip`/`fail` 缺 `Package` 不是"范围外"，是报告损坏（R8-C-12 / A4）。
  expectRed('s14-skip-without-package-fails',
    `${healthyReport()}\n${JSON.stringify({ Action: 'skip', Test: 'TestWithoutPackage' })}\n`,
    '损坏事件')

  // ⑨ 包身份是**结构化**匹配（R8-C-11）：前缀相近的兄弟包不能再互相背书 / 冒充范围。
  expectRed('s15-companion-prefix-spoof',
    healthyReport({ companionPackage: ST_PKG.compileHelpers }), 'companion')
  expectBlocked('s16-scope-prefix-spoof', syntheticReport([
    { Action: 'pass', Package: ST_PKG.routerSpoof, Test: ST_REQUIRED[0] },
    { Action: 'pass', Package: ST_PKG.routerSpoof, Test: ST_REQUIRED[1] },
    { Action: 'pass', Package: ST_PKG.routerSpoof },
  ]), '没有匹配到任何包')
  //    反向：段内前缀的兄弟包不得被误算进 `--scope`（否则它是"每次必红的假红"）。
  expectGreen('s17-skip-out-of-scope-boundary', syntheticReport([
    ...ST_REQUIRED.map(test => ({ Action: 'pass', Package: ST_PKG.appserver, Test: test })),
    { Action: 'pass', Package: ST_PKG.appserver },
    { Action: 'skip', Package: ST_PKG.wasmappLegacy, Test: 'TestSomethingSkipped' },
  ]))

  // ⑩ 退出码矩阵（R8-C-6）：真起子进程跑**本脚本自己**，逐条断言 0/1/2 三段契约。
  //    为什么要子进程：退出码是 main 流程决定的，纯函数样本测不到 `precondition` 分支
  //    （此前把 `precondition: true` 改成 `false` ⇒ 2 退化回 1，零判据）。
  //    子进程用 `SELFTEST_CHILD_ENV` 跳过这一段（唯一的用途），避免无限递归；它仍然跑
  //    上面全部 `s*` 样本，所以"掏空自检"在子进程里一样会红。
  if (!IS_SELFTEST_CHILD) {
    let dir = null
    try {
      dir = mkdtempSync(join(tmpdir(), 'gtj-selftest-'))
      const write = (name, text) => {
        const path = join(dir, name)
        writeFileSync(path, text)
        return path
      }
      const cleanPath = write('clean.json', syntheticReport([
        ...REQUIRED_CASES.map(rule => ({ Action: 'pass', Package: ST_PKG.appserver, Test: rule.test })),
        { Action: 'pass', Package: ST_PKG.appserver },
      ]))
      const badPath = write('bad.json', syntheticReport([
        ...REQUIRED_CASES.map(rule => ({ Action: 'pass', Package: ST_PKG.appserver, Test: rule.test })),
        { Action: 'pass', Package: ST_PKG.appserver },
        { Action: 'fail', Package: ST_PKG.appserver, Test: 'TestBoom' },
      ]))
      const truncatedPath = write('truncated.json',
        `${syntheticReport([{ Action: 'pass', Package: ST_PKG.appserver, Test: REQUIRED_CASES[0].test }])}`
        + '{"Action":"fail","Package":"picoaide/server/internal/')
      const decoyPath = write('decoy.json', syntheticReport([
        ...REQUIRED_CASES.map(rule => ({ Action: 'pass', Package: ST_PKG.router, Test: rule.test })),
        { Action: 'pass', Package: ST_PKG.appserver, Test: 'TestUnrelated' },
        { Action: 'pass', Package: ST_PKG.appserver },
      ]))
      const requiredList = REQUIRED_CASES.map(rule => rule.test).join(',')
      const probe = (id, expected, argv) => {
        const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...argv], {
          encoding: 'utf8',
          env: { ...process.env, [SELFTEST_CHILD_ENV]: '1' },
        })
        const tail = `${child.stdout ?? ''}${child.stderr ?? ''}`.trim().split('\n').slice(-2).join(' | ')
        expect(id, child.status === expected,
          `退出码矩阵：期望 exit ${expected}，实际 ${String(child.status)}（argv=${JSON.stringify(argv)}）`
          + `；输出尾部：${tail.slice(0, 300)}`)
      }
      probe('e1-exit-0-clean', 0,
        [cleanPath, '--scope', 'internal/wasmapp', '--require', requiredList])
      probe('e2-exit-1-bad-report', 1,
        [badPath, '--scope', 'internal/wasmapp', '--require', requiredList])
      probe('e3-exit-2-scope-miss', 2, [cleanPath, '--scope', 'internal/definitely-not-a-real-package'])
      probe('e4-exit-2-report-missing', 2, [join(dir, 'does-not-exist.json')])
      probe('e5-exit-1-truncated-report', 1, [truncatedPath, '--scope', 'internal/wasmapp'])
      probe('e6-exit-2-require-unregistered', 2, [cleanPath, '--require', 'TestNotRegisteredAnywhere'])
      probe('e7-exit-1-require-other-package', 1,
        [decoyPath, '--scope', 'internal/wasmapp,internal/router', '--require', requiredList])
    } catch (cause) {
      expect('e0-exit-matrix-setup', false,
        `退出码矩阵的前置（临时目录/写夹具）失败：${cause.message}`)
    } finally {
      if (dir !== null) rmSync(dir, { recursive: true, force: true })
    }
  }

  return { failures, assertions: samples.length, samples }
}

/** 当前进程应当执行的样本登记表（子进程没有 `e*` 那一段）。 */
const SELFTEST_EXPECTED_SAMPLE_IDS = IS_SELFTEST_CHILD ? SELFTEST_ANALYSIS_SAMPLE_IDS : SELFTEST_SAMPLE_IDS

// ===== 主流程 =====
//
// 自检的**完整性下限**（R8-C-5）：这段判据刻意写在 `selfTest()` **之外** —— 它要回答的
// 正是"自检本身还在不在"。把 `selfTest()` 改成 `return []`（一行）之后，旧实现在这里
// 看到"没有失败"就继续跑，并对任何报告说"检查通过 ✅"（全量 `verify-ci-scripts.mjs`
// 同样 EXIT=0）。所以这里逐个核对**样本 id 集合**与**断言计数**：少跑一个样本、多一个
// 未登记的样本、返回值形状变了（`[]` / 缺字段），一律 exit 2。
const selfCheck = selfTest()
const selfCheckProblems = []
if (selfCheck === null || typeof selfCheck !== 'object' || Array.isArray(selfCheck)
  || !Array.isArray(selfCheck.failures) || !Array.isArray(selfCheck.samples)
  || !Number.isSafeInteger(selfCheck.assertions)) {
  selfCheckProblems.push('selfTest() 没有返回 `{ failures, assertions, samples }`'
    + `（实际 ${Array.isArray(selfCheck) ? '数组' : typeof selfCheck}）`
    + ' —— 自检被掏空或改了形状；判据失效的形态就是静默放行，所以这里必须红')
} else {
  const executed = new Set(selfCheck.samples)
  const missing = SELFTEST_EXPECTED_SAMPLE_IDS.filter(id => !executed.has(id))
  const unexpected = [...executed].filter(id => !SELFTEST_EXPECTED_SAMPLE_IDS.includes(id))
  if (missing.length > 0) {
    selfCheckProblems.push(`自检样本没有全部执行：缺 ${missing.join(', ')}`
      + `（登记 ${SELFTEST_EXPECTED_SAMPLE_IDS.length} 条，实际执行 ${executed.size} 条）`
      + ' —— 少跑一个样本就是少一条判据，必须补回来或同步登记表')
  }
  if (unexpected.length > 0) {
    selfCheckProblems.push(`自检执行了未登记的样本 id：${unexpected.join(', ')}`
      + ' —— 新增样本必须登记进 `SELFTEST_SAMPLE_IDS`（否则"样本数"这条下限会被悄悄改写）')
  }
  if (selfCheck.assertions !== SELFTEST_EXPECTED_SAMPLE_IDS.length) {
    selfCheckProblems.push(`自检断言数 ${String(selfCheck.assertions)} ≠ 登记数 ${SELFTEST_EXPECTED_SAMPLE_IDS.length}`
      + ' —— 计数不符说明样本表与执行路径已经漂移')
  }
  selfCheckProblems.push(...selfCheck.failures)
}
if (selfCheckProblems.length > 0) {
  console.error(`${BIG}本脚本自检失败（判据可能已经形同不存在）—— 这不是报告的问题，先修判据脚本：`)
  for (const message of selfCheckProblems) console.error(`  ${message}`)
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
