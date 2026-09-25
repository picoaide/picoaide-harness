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
 * ## 守卫的 **argv** 也是登记面（2026-09-24 第八轮对抗审计 R8-D-22 / GATE-9）
 *
 * 现场（第 8 轮，已复现）：本文件此前只用根 `package.json` 的 scripts 校验
 * `guard.name`，`guard.args` **一个字节都不校验**，而 `:186` 直接
 * `spawn('corepack', ['yarn', ...guard.args])`。把编排器表里 16 条的 `args` 全部改成
 * `['--version']`（`name` 一字不改）之后，输出仍是「16 个根守卫：16 通过」——
 * EXIT=0（第 8 轮审计实测 2.1s，本泳道复现 3.2s）、**零守卫执行**；同一张表也被 `yarn check` 消费 ⇒ 一次编辑就能把整条
 * 门禁（含这条**永不跳过**的 docs-only 路径）变成静默成功。同族通道还有
 * `package.json` 的脚本体被换成 `true` / `echo ok` / `node -e ""`：名字与 argv 都对，
 * 跑起来的却是什么都不判的壳。
 *
 * 所以 argv 与"名字在不在 scripts 里"同级校验（三条一起，缺一条就有一个绕过口）：
 *   ① `args[0] === 'run'` 且 `args[1] === <条目名>` —— argv 与条目名同源；
 *   ② 其余参数逐字等于 `REGISTERED_GUARD_ARG_TAILS` 的登记值（缺省 = 空尾巴）；
 *   ③ 任何位置出现 `SEMANTICS_CHANGING_FLAGS` 里的旗标一律拒（**包括**想把它登记进来）；
 *   ④ 根 `package.json` 的脚本体必须是**直接执行一个脚本文件**的形态（`node scripts/…` /
 *      `bash scripts/…`），否则同样是"名字还在、判据没了"。
 * 四条都是**配置错误 ⇒ exit 2**（与本文件其它登记错误同码），绝不是"跳过这一条"。
 *
 * ## 执行体入口：守卫**不经 yarn** 起（2026-09-24 第十一轮审计 I1 泳道 · P0-1）
 *
 * 登记面（名字 / argv 尾 / 脚本路径 / 内容摘要）都齐了，**谁把它跑起来**仍是下一层：
 * `.yarnrc.yml` 的 `plugins:`（或 `yarnPath:`）能在 **yarn 进程内部**往每个被 spawn 的
 * 脚本环境里注入 `NODE_OPTIONS`/`BASH_ENV`，而子进程环境清洗发生在 yarn **之前**
 * ⇒ 实测 `corepack yarn check` EXIT 1→0、本运行器 `3 通过、14 失败` → `17 通过、0 失败`。
 * 现在守卫按登记脚本**直接 spawn**（`process.execPath` / `bash`），回落 yarn 只在
 * "登记脚本文件不存在"（合成/探针树）且 `yarnEntryTrustProblems()` 为空时发生。
 * 见下面的「执行体入口」段。
 *
 * ## 用法与退出码
 *
 * 用法：node scripts/check-root-guards.mjs [--list] [--concurrency N] [--full-output] [--allow-advisory]
 * 退出码：0 = 守卫全部通过；1 = 有守卫失败；2 = 用法/解析/登记错误。
 *
 * **`advisory` 默认在本脚本里不生效**（2026-09-23 第六轮审计 R6-C-1）：这里是不跳过的那条
 * 路径，只有显式传 `--allow-advisory` 才会把失败降级成告警 —— CI 的任何调用都不得带它。
 * 这一点由 `scripts/check-workflows.mjs` 的 **[SK-16]** 钉住（2026-09-23 第七轮审计
 * R7-C P2-1 补的：此前只钉了"守卫运行步真的在跑"，把这个开关加进 `ci.yml` 实测 EXIT=0）：
 * 任何 workflow 的可执行文本、以及守卫/编排器调用步的 `env:` 出现 `allow-advisory` 即红。
 * 另外，`advisory` 还必须先登记在编排器的 `ADVISORY_REGISTRY` 里，否则这里直接 exit 2。
 */

import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
// **失败的判定行扫描 + 有界输出 = 唯一实现**（2026-09-24 第十轮复审 V1 的 P1 / 审计 C-08）。
//
// 契约（F1 ↔ F2 的接缝）：本运行器**不得**再有一份自己的"头 N + 省略 + 尾 N"摘要 ——
// 那样判定行落在输出的中段时，它在 CI 日志里出现 **0** 次（独立探针实测；两条门禁的实现
// 逐字节相同意味着"修了口径但没接线"）。`check-workspaces.mjs` 是编排器 CLI，但它在
// 文件末尾用 `isEntryPoint()` 守卫了 `main()` ⇒ **被 import 时零副作用**（同一轮修复里
// 也把本文件改成同样的形态：`check-root-guards.mjs` 被 import 时同样什么都不跑）。
import {
  SEMANTICS_CHANGING_FLAGS,
  contaminatedRunnerKeys,
  formatFailureReport,
  refuseUntrustedRunner,
  runnerTrustProblems,
  sanitizeGuardEnvironment,
  selfTestVerdictClassifier,
  spawnRegisteredGuard,
  spawnYarnFallbackGuard,
} from './check-workspaces.mjs'

// **共享实现的兼容导出面**（2026-09-24 第十一轮审计 I1）：`sanitizeGuardEnvironment` /
// `contaminatedRunnerKeys` 的实现已按依赖方向搬进编排器（那里是两者共同的下游，
// 且"只拷编排器"的合成树不能 import 本文件 —— 详见 `check-workspaces.mjs` 的头注释），
// 但外部判据（`scripts/verify-check-workspaces.mjs` 的 `typeof … === 'function'` 断言）
// 仍按本模块取它们 ⇒ 这里原样重导出，导出面不变。
export { contaminatedRunnerKeys, sanitizeGuardEnvironment }

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const ORCHESTRATOR = join(ROOT, 'scripts', 'check-workspaces.mjs')

/** `selfTestGuardEnvironment()` 至少执行的断言条数(3 条键表 + 2 条真子进程行为)。 */
const SELFTEST_GUARD_ENV_ASSERTIONS = 5
/**
 * `selfTestVerdictClassifier()` 至少执行的断言条数（下限，防"把断言表掏空"）。
 *
 * 为什么同一份自检在**两个**调用方各接一次：本运行器是 **docs-only PR 的唯一防线**
 * （那条路径上编排器根本不跑），而失败详情走的就是这套形态表 —— 形态表失效时
 * "守卫失败"在日志里会退化成「未找到判定行」或干脆整行不见。编排器侧（`yarn check` /
 * CI gate job）也接了一处，见 `check-workspaces.mjs` 的 `main()`。
 */
const SELFTEST_VERDICT_ASSERTIONS = 60
/** `selfTestCorepackGuidance()` 至少执行的断言条数（下限，防"把断言表掏空"）。 */
const SELFTEST_COREPACK_GUIDANCE_ASSERTIONS = 4

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
 * 每条根守卫的**逐条登记**：`{ script, argvTail }`（第九轮审计 B 泳道 P1-5 收紧）。
 *
 * 为什么"形态对"还不够（P1-5 的现场）：`GUARD_SCRIPT_INVOCATION` 只证明脚本体长得像
 * "直接执行一个脚本文件"。于是把**任意**守卫的脚本体换成另一个"能通过"的守卫
 * （`"check:theme-tokens": "node scripts/check-workflows.mjs"`）之后 —— 名字、argv、
 * 形态三者全对，`check-root-guards.mjs` 照报 `✓ check:theme-tokens`，而这条守卫的判据
 * 一次都没跑（实测：本副本环境里正在失败的 `check:theme-tokens` 被重定向后转绿）。
 *
 * 所以三者必须绑在同一条链上：**名字**（argv[1]）→ **argv 尾**（`argvTail`）→
 * **脚本路径**（`script`，逐字）。新守卫必须登记进本表，否则 fail-loud（exit 2）。
 * 第二判据在 `scripts/verify-check-workspaces.mjs`（它另有一份**独立**的登记表：
 * 两处同时被改才会静默，导入本表等于把两个判据合并成一个）。
 *
 * ## `digest` = 脚本**内容**的摘要（2026-09-24 第十轮审计 C-06）
 *
 * 第九轮把「守卫 → argv → 脚本路径」绑在一条链上（对，且实测有效），但**脚本内容本身仍无
 * 判据**：把 `scripts/check-theme-tokens.mjs` 的内容整段换成 `process.exit(0)`、或把它换成
 * 同名**符号链接**指向另一个能通过的守卫之后，运行器照报 `✓ check:theme-tokens`
 * （审计在副本里实测：这一条从 ✗ 翻成 ✓，两条门禁都看不出区别）。
 *
 * 所以每条登记多一个 `digest`（该脚本文件的 sha256，**64 位小写 hex**），由
 * `scripts/check-guard-parser-integrity.mjs` 复算对拍；第二判据在
 * `scripts/verify-check-workspaces.mjs`（独立复算 + 符号链接断言）。本文件只校验**字段形态**
 * （缺字段 / 不是 64 位 hex ⇒ exit 2）—— 比较留给那两条判据，避免把比较逻辑也塞进运行器。
 * 换守卫脚本的内容 = 必须在同一个 PR 里更新这里的 digest（可评审的 diff）；
 * 重新生成：`node scripts/check-guard-parser-integrity.mjs --print-digests`。
 */
const REGISTERED_GUARD_ENTRIES = new Map([
  ['check:layout', { script: 'node scripts/verify-layout.mjs', argvTail: [], digest: 'b087a84463044cef0abe22327a6604aed5eac4e09a01cc793c313ac92744c565' }],
  ['check:workflows', { script: 'node scripts/check-workflows.mjs', argvTail: [], digest: '823521b553f426441fbd08366332359dbb6cba143d44ed4d224746f55ea1bb6a' }],
  ['check:ci-scripts', { script: 'node scripts/verify-ci-scripts.mjs', argvTail: [], digest: 'e66d7a45a66035d6ac7855f289a677309143f6f0ee88da3f8de62a0f61f26fe2' }],
  ['check:patch-resolutions', { script: 'node scripts/verify-patch-resolutions.mjs', argvTail: [], digest: '6dcde2281311235a57722608d91e6a1fa59734411ad65cda76ea2bdc43145c83' }],
  ['check:patch-pin', { script: 'node scripts/check-patch-pin.mjs', argvTail: [], digest: 'a8fe5b45df5dfadd7a87332b31f9e14c4a6722a41f21cf0f0d9afa6450a3ba84' }],
  ['check:patches', { script: 'node scripts/verify-patches.mjs', argvTail: [], digest: '22131d86472ff930f22687192b07216c5cf74ab594d0091a6766e661a2c24683' }],
  ['check:inventories', { script: 'node scripts/verify-inventories.mjs', argvTail: [], digest: '39528c7984ee7baf0cad92faaa3b421f7f64e4d08b524d63417e896abb57267d' }],
  ['check:theme-tokens', { script: 'node scripts/check-theme-tokens.mjs', argvTail: [], digest: '1523cdf07984516d5696ee76aaa87cdb12cf5c94c69908b27ac4ec7e210bc5e4' }],
  ['check:glitchtip', { script: 'node scripts/verify-glitchtip-ops-check.mjs', argvTail: [], digest: 'f73f2ebcecbfeaaa57c069ca2e662dc1842b9d37d53eb413fc36bb85a987be3e' }],
  ['check:check-workspaces', { script: 'node scripts/verify-check-workspaces.mjs', argvTail: [], digest: '7db5a2078ca7bba40c5fb5cb9c3ccc7269342691b9fe0d08527a1a24591ceb9a' }],
  ['check:no-leftover-mutants', { script: 'node scripts/check-no-leftover-mutants.mjs', argvTail: [], digest: 'c1a84c22a47bea2c1368bfba32f33b20feca66deb30abcbbc0eb40318f807285' }],
  ['check:migration-range', { script: 'node scripts/check-migration-range.mjs', argvTail: [], digest: 'fad3de592353ad16751906c25b2181a6adf3fc164a889fa3adfd6847645b7803' }],
  ['check:doc-claims', { script: 'node scripts/check-doc-claims.mjs', argvTail: [], digest: 'c0c96344f00d2745ae8dd53d9958403e0c9f76b7eb384a7435dac52702a0c680' }],
  ['check:no-real-domains', { script: 'node scripts/check-no-real-domains.mjs', argvTail: [], digest: 'b6b4011f3f0be476a2800821c06e35fc4e749331e947326bb569acf2e5725244' }],
  // `--portable`：只跑便携子集（需要真 PG / 显示器的组归 server job 与 W6 三平台）。
  ['check:wasm-client-only', { script: 'bash scripts/verify-wasm-client-only.sh', argvTail: ['--portable'], digest: '00fd8c90848089613226c7dc8c5213eb016a37ce4586aeb2dcd5cfb63ef5e091' }],
  ['check:integration-tests', { script: 'node scripts/check-integration-tests.mjs', argvTail: [], digest: '3f1f821cd6c7fa643a367a40bed7c5b49d1608c9844a783275994b8faf958648' }],
  // 守卫脚本**内容**的判据（第十轮审计 C-06/C-17）。它的判据面里同时包含:
  //   · 本表每条 `digest` ↔ 该守卫脚本的 sha256(内容替换/符号链接替换都红);
  //   · 门禁自己依赖的解析器(`node_modules/yaml`)的**文件集** sha256 ↔ 登记值。
  ['check:guard-parser-integrity', { script: 'node scripts/check-guard-parser-integrity.mjs', argvTail: [], digest: '5806cb67bc82d2940ad1bed3a5efdba116ff212bac4edf63368f59754feb9969' }],
])

/**
 * 每条守卫**允许的参数尾**（`['run', <守卫名>]` 之后的部分）—— 登记制（R8-D-22 / GATE-9）。
 *
 * 缺省 = **空尾巴**。想加尾巴就是放宽/改变判据面，必须在这里逐条登记并写明理由
 * （与 `ADVISORY_REGISTRY`、"下限守卫"同一套纪律：一个词/一个参数就能改变门禁语义的
 * 东西，不能是无登记的）。
 *
 * 取值来自 `REGISTERED_GUARD_ENTRIES`（唯一真源）—— 两张表各写一份会漂移。
 */
const REGISTERED_GUARD_ARG_TAILS = new Map(
  [...REGISTERED_GUARD_ENTRIES].map(([name, entry]) => [name, entry.argvTail]),
)

/**
 * 取一条已登记守卫的「直接执行」参数（编排器侧用；登记表是**唯一真源**）。
 *
 * 为什么编排器不自己读 `package.json`：`yarn run <name>` 的语义就是「跑 package.json 的那一行」，
 * 而本轮 P0-1 之后守卫不再经 yarn ⇒ 那一步必须由**登记表**承担（登记表与 package.json 的
 * 一致性由 `guardScriptProblem()` 校验，两侧各自 fail-loud）。
 * @param name - 守卫名（= 根 `package.json` 里的脚本名）。
 * @returns `{ script, argvTail }`；未登记时 `null`（调用方必须拒绝执行）。
 */
export function registeredGuardEntry(name) {
  const entry = REGISTERED_GUARD_ENTRIES.get(name)
  if (entry === undefined) return null
  return { script: entry.script, argvTail: [...(entry.argvTail ?? [])] }
}



/**
 * 根 `package.json` 里守卫脚本**允许的形态**：直接执行 `scripts/` 下的一个脚本文件。
 *
 * 为什么不是"存在即可"：`"check:layout": "true"` / `"echo ok"` / `"node -e \"\""` /
 * `"yarn --version"` 都会让守卫"通过"而什么都没判；带参数（`scripts/x.mjs --list`）同样
 * 一律拒 —— 要加参数就走 `REGISTERED_GUARD_ARG_TAILS`，那里有登记与理由。
 */
const GUARD_SCRIPT_INVOCATION = /^(?:node|bash)\s+scripts\/\S+$/u

/**
 * 校验一条守卫的 argv（R8-D-22）。返回问题描述；`null` = 通过。
 *
 * @param name - 条目名（= 根 `package.json` 里的脚本名）。
 * @param args - 条目声明的参数向量。
 * @returns 问题描述或 `null`。
 */
export function guardArgsProblem(name, args) {
  if (!Array.isArray(args) || args.length === 0) {
    return `\`${name}\` 的 args 不是非空数组（实际 ${JSON.stringify(args)}）`
      + ' —— 没有 argv 就没有守卫，缺参数必须当场红。'
  }
  const weakening = args.filter(arg => SEMANTICS_CHANGING_FLAGS.includes(arg))
  if (weakening.length > 0) {
    return `\`${name}\` 的 args 里有"会改变语义"的旗标 ${weakening.map(flag => `\`${flag}\``).join('、')}`
      + ' —— 它们让守卫**跑起来却什么都不判**（只打印清单/版本/演算），或把失败降级成告警。'
  }
  if (args[0] !== 'run') {
    return `\`${name}\` 的 args 必须以 \`'run'\` 开头（实际 ${JSON.stringify(args)}）`
      + ' —— `yarn --version` 这类"不是跑脚本"的向量恒退出 0，而运行器会把它当成"守卫通过"'
      + '（R8-D-22 的现场：16 条全改成 `--version` ⇒「16 通过」且零守卫执行）。'
  }
  if (args[1] !== name) {
    return `\`${name}\` 的 args[1] 必须等于守卫名本身（实际 ${JSON.stringify(args[1] ?? null)}）`
      + ' —— argv 与条目名必须同源，否则"名字还在、跑的是别的东西"。'
  }
  const tail = args.slice(2)
  const registered = REGISTERED_GUARD_ARG_TAILS.get(name) ?? []
  if (tail.join('\u0000') !== registered.join('\u0000')) {
    return `\`${name}\` 的参数尾 ${JSON.stringify(tail)} 与登记值 ${JSON.stringify(registered)} 不一致`
      + ' —— 参数会改变判据的语义（少跑/多跑/换判据面），必须逐字匹配 `REGISTERED_GUARD_ARG_TAILS`'
      + '（缺省 = 空尾巴）；确实需要新尾巴时登记它并写明理由。'
  }
  return null
}

/**
 * 校验根 `package.json` 里某条守卫脚本的**形态 + 指向**（R8-D-22 的同族通道；P1-5 收紧）。
 *
 * 三层判据，缺一层就有一个绕过口：
 *   ① 有脚本体、且形态是"直接执行一个脚本文件"（`true` / `echo ok` / `node -e ""` 一律拒）；
 *   ② 该守卫**登记在** `REGISTERED_GUARD_ENTRIES` 里（新守卫不登记 = 没人看着它跑哪个脚本）；
 *   ③ 脚本体**逐字等于**登记值（"跑一个脚本"不够，必须是**那一个**脚本 —— 把正在失败的
 *      `check:theme-tokens` 换成 `node scripts/check-workflows.mjs` 时，名字/argv/形态全对，
 *      旧判据全绿而运行器照报 `✓`）。
 *
 * @param name - 守卫名。
 * @param body - 根 `package.json` 的 `scripts[name]` 取值。
 * @returns 问题描述或 `null`。
 */
export function guardScriptProblem(name, body) {
  if (typeof body !== 'string' || body.trim() === '') {
    return `\`${name}\` 在根 package.json 里没有脚本体`
  }
  if (!GUARD_SCRIPT_INVOCATION.test(body.trim())) {
    return `\`${name}\` 的脚本体 ${JSON.stringify(body)} 不是"直接执行一个脚本文件"的形态`
      + '（允许的形态只有 `node scripts/<file>` / `bash scripts/<file>`，不接受任何参数）'
      + ' —— `true` / `echo ok` / `node -e ""` 这类壳会让守卫"通过"而什么都没判。'
  }
  const registered = REGISTERED_GUARD_ENTRIES.get(name)
  if (registered === undefined) {
    return `\`${name}\` 没有登记在 \`REGISTERED_GUARD_ENTRIES\` 里`
      + ' —— 每条根守卫都必须逐字登记"它跑的是哪个脚本"（名字 / argv 尾 / 脚本路径三者同源），'
      + '否则把任意守卫的脚本体重定向到另一个"能通过"的守卫，运行器会照报 `✓` 而判据一次没跑。'
  }
  if (body.trim() !== registered.script) {
    return `\`${name}\` 的脚本体 ${JSON.stringify(body)} 与登记值 ${JSON.stringify(registered.script)} 不一致`
      + ' —— "跑一个脚本"这个形态还不够，必须**是那一个**脚本：重定向到别的守卫时，名字与 argv'
      + '一字不改、运行器照报 `✓ <名字>`，而这条守卫的判据一次都没跑（第九轮审计 B 泳道 P1-5 的现场）。'
  }
  // ④ `digest` 必须存在且是 64 位小写 hex（第十轮审计 C-06）。**只校验形态**：比较在
  // `scripts/check-guard-parser-integrity.mjs`（本表是它的输入）与
  // `scripts/verify-check-workspaces.mjs`（独立复算）里做 —— 三个地方各留一份比较逻辑
  // 只会漂移。缺字段 ⇒ 那两条判据读不到登记值，等于内容判据静默消失，所以这里 fail-loud。
  if (typeof registered.digest !== 'string' || !/^[0-9a-f]{64}$/u.test(registered.digest)) {
    return `\`${name}\` 的登记项缺少合法的 \`digest\`（实际 ${JSON.stringify(registered.digest ?? null)}）`
      + ' —— `digest` 必须是该守卫脚本 sha256 的 64 位小写 hex：'
      + '把守卫脚本内容掏空（`process.exit(0)`）或换成同名符号链接时，名字/argv/形态三者全对，'
      + '运行器照报 `✓` 而判据一次没跑（第十轮审计 C-06 在副本里实测）。'
      + '重新生成：`node scripts/check-guard-parser-integrity.mjs --print-digests`。'
  }
  return null
}

/**
 * 从编排器的源码里解析 `GUARDS` 表（name / args / advisory）。
 *
 * 用正则而不是 import 表的**运行时对象**：本文件已经从 `check-workspaces.mjs` import 失败摘要的
 * 共享实现（`formatFailureReport`），但**守卫清单**仍旧按源码文本解析 —— 那是因为清单是
 * `check-workspaces.mjs` 的模块内常量、且"解析失败"必须能被独立复算（两处各自解析、各自拒绝，
 * 才能在一侧被改坏时仍然咬住）。解析是**有判据**的：条数对不上（name 与 args 数量不等、条目切分数量
 * 对不上）就是 fail-loud，而不是"解析到几条算几条"；`args` 还必须过 `guardArgsProblem`
 * 的登记校验（argv 与条目名同源、无"会改变语义"的旗标、参数尾逐字等于登记值 —— R8-D-22）。
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
    // argv 也是登记面（R8-D-22）：只校验 name 时，16 条 args 全改成 `--version` 仍是
    // 「16 通过」+ 零守卫执行。这里是**逐条**校验，第一条出问题就 fail-loud。
    const argsProblem = guardArgsProblem(name, args)
    if (argsProblem !== null) return { error: `GUARDS 表的 args 校验失败：${argsProblem}` }
    guards.push({ name, args, advisory: /advisory:\s*true/u.test(chunk) })
  }
  if (guards.length === 0) return { error: 'GUARDS 表解析出 0 条守卫（表结构变了？）' }
  return { guards }
}

/**
 * `expiresOn` 必须是 `YYYY-MM-DD` 形式的**真实**日期（第六轮复审 V2 边界②）。
 *
 * 与编排器 `check-workspaces.mjs` 的 `validateAdvisoryRegistry` 是**同一条规则的两份独立实现**
 * （本运行器只 import 它导出的纯函数 `formatFailureReport`，**不**复用这条规则的实现 ——
 * 两边各自解析、各自拒绝才叫双通道；import 一份实现等于把两个判据合并成一个）。
 * 独立实现是这类"双通道"判据的**要求**而非重复代码：两边各自解析、各自拒绝，
 * 才能在一侧被改坏时仍然咬住。
 *
 * 为什么必须判格式：`expiresOn` 只判"有没有"时，一个乱字符串会让 `expiresOn < 今天`
 * **静默不成立** ⇒ 豁免变成"永不过期"。`2026-02-31` 这类会被 `Date.parse` 滚到 3 月 3 日，
 * 所以第三档用 UTC 往返逐字比对挡掉它。
 *
 * @param value - 登记表里的 `expiresOn` 取值。
 * @returns 是否是真实日历日。
 */
function isAdvisoryExpiresOn(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false
  const parsed = Date.parse(`${value}T00:00:00Z`)
  if (Number.isNaN(parsed)) return false
  return new Date(parsed).toISOString().slice(0, 10) === value
}

/**
 * 从编排器的源码里解析 `ADVISORY_REGISTRY`（advisory 的**登记制**，R6-C-1）。
 *
 * `advisory` 曾经是条目上的一个自由字段：加一个词就能让任一条守卫在 `yarn check` 与
 * 本运行器里同时变成"只告警"。现在它必须在编排器里逐条登记，本运行器**独立**复核
 * 这份登记（不依赖编排器是否跑过 —— docs-only 的 PR 上编排器根本不跑）。
 *
 * 解析是**有判据**的：找不到登记表 = fail-loud（不是"当作没有 advisory"）；`expiresOn`
 * 取值非法同样是配置错误（`exit 2`），不得当成"没有到期日"放过。
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
    const expiresOn = /expiresOn:\s*'([^']*)'/u.exec(chunk)?.[1]
    if (expiresOn !== undefined && expiresOn !== '' && !isAdvisoryExpiresOn(expiresOn)) {
      return {
        error: `ADVISORY_REGISTRY 的 \`${name}\` 的 \`expiresOn\`（${JSON.stringify(expiresOn)}）不是`
          + ' `YYYY-MM-DD` 形式的真实日期 ⇒ 到期判据（`expiresOn < 今天`）会**静默不成立**，'
          + '豁免变成"永不过期"（第六轮复审 V2 边界②）。请写成真实日历日（例：`2026-10-31`）。',
      }
    }
    entries.push({
      name,
      reason: /reason:\s*'([^']*)'/u.exec(chunk)?.[1],
      approvedBy: /approvedBy:\s*'([^']*)'/u.exec(chunk)?.[1],
      expiresOn,
    })
  }
  if (entries.length === 0) return { error: 'ADVISORY_REGISTRY 表解析出 0 条（表结构变了？）' }
  return { entries }
}

/**
 * 子进程环境清洗的**自证**（第十轮审计 D-03 的后半条）。
 *
 * 为什么必须有:**清洗**是本条修复的唯一"与层无关"的收口,而它的失效是完全静默的 ——
 * 把 `env: { ...GUARD_CHILD_ENV.env, … }` 改回 `{ ...process.env, … }` 之后,门禁照样
 * 打印「16 个根守卫:16 通过、0 失败」(审计实测)。所以这里用**真子进程**证明两件事:
 *   ① 未清洗的环境里,注入的退出钩子确实能把 `process.exitCode = 1` 改写成 0(现场复现);
 *   ② 清洗后的环境里,同一个子进程如实退出 1(**清洗真的咬到了**,不是形状断言)。
 * 另加两组键表断言(危险族必丢 / 普通键必留),防止"一刀切把整个环境清空"这种反向破坏。
 *
 * @returns `{ failures, assertions }`。
 */
export function selfTestGuardEnvironment() {
  const failures = []
  let assertions = 0
  const dangerous = {
    NODE_OPTIONS: '--max-old-space-size=64',
    BASH_ENV: '/tmp/hooks.sh',
    COREPACK_HOME: '/tmp/yc',
    LD_PRELOAD: '/tmp/x.so',
    LD_LIBRARY_PATH: '/tmp/lib',
    'BASH_FUNC_node%%': '() { return 0; }',
    ENV: '/tmp/sh-env',
    SHELLOPTS: 'errexit',
    BASHOPTS: 'extglob',
    PROMPT_COMMAND: 'true',
    YARN_CACHE_FOLDER: '/tmp/cache',
    NPM_CONFIG_FUND: 'false',
    npm_config_yes: 'true',
    PYTHONSTARTUP: '/tmp/py',
  }
  const harmless = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? '/tmp',
    CHECK_CONCURRENCY: '2',
    PG_DSN_TEST: 'postgres://example/db',
    R2_BUCKET: 'artifacts',
    CHANNELS_REPO_TOKEN: 'token',
    DSH_TELEMETRY_DISABLED: '1',
    FORCE_COLOR: '0',
  }
  const { env: cleaned, dropped } = sanitizeGuardEnvironment({ ...dangerous, ...harmless })
  assertions += 1
  const leaked = Object.keys(dangerous).filter(key => Object.hasOwn(cleaned, key))
  if (leaked.length > 0) {
    failures.push(`[guard-env-selftest] 危险族键没有被清洗掉:${leaked.join('、')}`
      + ' ⇒ 守卫子进程会继承它们(第十轮审计 D-03:NODE_OPTIONS 的退出钩子让"1 项未通过"却 EXIT=0)。')
  }
  assertions += 1
  const lost = Object.keys(harmless).filter(key => !Object.hasOwn(cleaned, key))
  if (lost.length > 0) {
    failures.push(`[guard-env-selftest] 普通键被误清:${lost.join('、')}`
      + ' ⇒ 清洗不能一刀切(守卫要靠 PATH/HOME/环境里的凭据与开关跑起来)。')
  }
  assertions += 1
  const expectedDropped = Object.keys(dangerous).sort()
  if (dropped.join(',') !== expectedDropped.join(',')) {
    failures.push(`[guard-env-selftest] 丢弃清单与预期不符:实际 ${dropped.join('、') || '(空)'}`
      + ` / 预期 ${expectedDropped.join('、')}(丢弃清单是打印给 CI 看的证据,不能与实际不一致)。`)
  }
  // 行为判据:真子进程 + 真退出钩子。
  const directory = mkdtempSync(join(tmpdir(), 'dsh-guard-env-selftest-'))
  try {
    const hook = join(directory, 'hook.mjs')
    writeFileSync(hook, 'process.on("exit", () => { process.exitCode = 0 })\n')
    const program = ['-e', 'process.exitCode = 1']
    const injected = spawnSync(process.execPath, program, {
      env: { ...cleaned, NODE_OPTIONS: `--import=${hook}` },
      stdio: 'ignore',
    })
    assertions += 1
    if (injected.status !== 0) {
      failures.push(`[guard-env-selftest] 校准失败:未清洗环境里注入退出钩子后子进程没有退 0`
        + `(实际 ${injected.status})⇒ 本机复现不出 D-03 的现场,这条自证的**后半条**不成立。`)
    }
    const sanitized = spawnSync(process.execPath, program, {
      env: { ...sanitizeGuardEnvironment({ ...cleaned, NODE_OPTIONS: `--import=${hook}` }).env },
      stdio: 'ignore',
    })
    assertions += 1
    if (sanitized.status !== 1) {
      failures.push(`[guard-env-selftest] 清洗后再注入同一个钩子,子进程仍然退 ${sanitized.status}`
        + '(期望 1)⇒ 清洗没有真的拦住 NODE_OPTIONS,守卫的判定还是会被改写。')
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
  return { failures, assertions }
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

/**
 * 起一条**已登记**的守卫（运行器侧）。
 *
 * `guardChildEnv`（= `main()` 里算好的清洗结果）**必须显式传入**：本文件被 import 时
 * 不许跑任何东西，所以那份环境不在模块作用域上求值（第十轮复审 V1 的 P1 附带要求：
 * `check-root-guards.mjs` 也要能被 import）。探针树实测过这条接缝 —— 漏传时 `runGuard`
 * 会在 `ReferenceError` 上崩掉（守卫一个都没跑，退出码 1 却指不到病根）。
 * @param guard - 守卫条目（`{ name, args, advisory }`）。
 * @param guardChildEnv - `sanitizeGuardEnvironment()` 的结果（`{ env, dropped }`）。
 * @returns 守卫结果（含合并后的 stdout+stderr 与退出码）。
 */
function runGuard(guard, guardChildEnv) {
  return spawnRegisteredGuard(
    REGISTERED_GUARD_ENTRIES.get(guard.name)?.script ?? '',
    REGISTERED_GUARD_ENTRIES.get(guard.name)?.argvTail ?? guard.args.slice(2),
    { cwd: ROOT, env: guardChildEnv.env, name: guard.name },
  ).then(result => ({ ...result, guard }))
}

/**
 * `COREPACK_HOME` 被清洗掉时的**离线处置指引**（第十轮复审 V1 的 P3-D4，二选一的第②条；
 * 第十轮复审 W1 的 N3 订正第①条的操作）。
 *
 * 取舍与理由（**不许**改成"静默放行"）：
 *   · 第①条（把 `COREPACK_HOME` 加进 `GUARD_CHILD_ENV_ALLOWED` 并做内容对拍）被否决 ——
 *     它的前提是"我们能在运行期证明那个目录里的 `yarn.js` 可信"，而 **corepack 自己不复验
 *     预热缓存**：审计方在副本里用只含 `process.exit(0)` 的 `v1/yarn/4.18.0/yarn.js` 预置
 *     `COREPACK_HOME`，16 个守卫**全部换成攻击者的解释器**跑而判据侧零反应（C-01 的现场）。
 *     要做内容对拍只能由我们比对"注册摘要"，而那在**离线 runner 的默认缓存同样为空**时
 *     没有参照物（正是这条指引要救的场景），且每次 yarn 升级都要改登记值。
 *   · 第②条（保持清洗 + 明说处置）：fail-closed 不变，把代价写进**失败文案** ——
 *     靠 `COREPACK_HOME` 预置、不允许出网的 runner 必须改为预热**默认**缓存
 *     （`$HOME/.cache/node/corepack`）或把 yarn 装进镜像。
 *
 * 文案必须**可执行**（W1 复审 N3 的 P3：旧文案括号里写「`corepack enable` 或一次
 * `yarn install` 即可」，而 `corepack enable` **不预热任何东西**）：
 *   · 实测（W1 探针，`HOME` 与 `--install-directory` 都指向临时目录）：`corepack enable`
 *     EXIT=0 之后 `$HOME/.cache/node/corepack` **仍不存在**，而 `corepack install -g
 *     yarn@4.18.0` 真的把它写出来、之后 `corepack yarn --version` = `4.18.0`；
 *   · 静态佐证：corepack 的 `enable` 只走 `generateLink()`（建 shim 软链，不下载），
 *     默认缓存路径的真源是 `getCorepackHomeFolder() = COREPACK_HOME ?? (XDG_CACHE_HOME ??
 *     $HOME/.cache) + /node/corepack`；
 *   · 所以第①条改成"**需要联网跑一次** `corepack install -g yarn@4.18.0`"（等价写法：在
 *     runner 上跑一次 `yarn install` —— 它同样会按 `packageManager` 字段把 4.18.0 拉进默认
 *     缓存），并把 `corepack enable` **明确标成做不到这件事**。为什么这样在离线 runner 上
 *     成立：预热发生在**构建/准备阶段**（镜像构建或首次联网启动），运行期只剩读缓存；
 *     缓存一旦就位，corepack 不再访问 registry（`corepack yarn --version` 实测可用）。
 */
const COREPACK_HOME_GUIDANCE = [
  '注意：本次运行**丢弃了 `COREPACK_HOME`**（它属于"谁能解释 `yarn`"的危险族 —— 保留它等于',
  '保留一条已被端到端验证过的解释器替换通道：预置的 `v1/yarn/<ver>/yarn.js` 只要内容被替换，',
  '全部根守卫就会**换成那个解释器**跑而判据侧零反应）。',
  '⇒ 离线 / 自托管 runner 的正当做法（二选一，都不需要放开清洗）：',
  '   ① **联网跑一次**，把 yarn 4.18.0 预热进**默认**缓存 `$HOME/.cache/node/corepack`：',
  '      `corepack install -g yarn@4.18.0`（等价：在 runner 上跑一次 `yarn install`）——',
  '      预热放在构建/准备阶段即可，之后运行期只读缓存、不再访问 registry。',
  '      ⚠️ `corepack enable` **做不到这件事**（它只创建 shim 软链、不下载任何东西）⇒',
  '      照它做缓存仍为空，corepack 照样去 registry 取 yarn，症状与这条指引想避免的完全一致。',
  '   ② 把 yarn 4.18.0 直接装进镜像（例如在 Dockerfile 里跑 `corepack install -g yarn@4.18.0`，',
  '      或让基础镜像自带），使 runner 完全不需要预热缓存。',
  '  靠 `COREPACK_HOME=<预热目录>` 供网的 runner 请改走上面两条，否则 corepack 会去 npmjs 取 yarn。',
].join('\n')

/** 失败详情 = 编排器导出的**唯一实现**（见上面的说明）。 */
const summarize = output => formatFailureReport(output)

/**
 * `COREPACK_HOME_GUIDANCE` 的**内容自检**（第十轮复审 W1 的 N3）：文案本身也要有判据。
 *
 * 为什么需要（而不是"文案改对了就行"）：这条指引是在**离线 runner 上唯一可执行的补救**，
 * 而它上一版恰好写了一条**做不到的操作**（`corepack enable` —— 实测只建 shim、不预热默认
 * 缓存）。文案不是代码，但它的错误代价与代码等价：照做的人在断网 runner 上会得到与
 * "没有指引"完全一样的失败。判据分两侧：
 *   · **正**：必须给出 W1 实测可执行的那条命令（`corepack install -g yarn@4.18.0`）与默认
 *     缓存路径 `$HOME/.cache/node/corepack`、"装进镜像"这条退路；
 *   · **负**：`corepack enable` 只允许以"**做不到这件事**"的形态出现 —— 一旦它又被写成
 *     "即可/就行"（旧文案的形态），本自检当场红。
 *
 * 判据是**文本级**的（不是执行级）：跑一次 `corepack install` 需要出网 + 可写 HOME，
 * 门禁里不能做。文案的真实性由一次性实测取证（见 REPORT 的探针日志），这里守的是"别再退回
 * 那条被证伪的说法"。纯函数：不读磁盘、不 spawn、不抛异常。
 * @returns `{ failures, assertions }`。
 */
export function selfTestCorepackGuidance() {
  const failures = []
  let assertions = 0
  const check = (ok, message) => {
    assertions += 1
    if (!ok) failures.push(message)
  }
  check(COREPACK_HOME_GUIDANCE.includes('corepack install -g yarn@4.18.0'),
    '[corepack-guidance] 指引必须给出**实测可执行**的预热命令 `corepack install -g yarn@4.18.0`'
    + '（W1 实测：它真的把 4.18.0 写进默认缓存；旧文案那条 `corepack enable` 不预热任何东西）')
  check(COREPACK_HOME_GUIDANCE.includes('$HOME/.cache/node/corepack')
    && COREPACK_HOME_GUIDANCE.includes('装进镜像'),
  '[corepack-guidance] 指引必须同时给出默认缓存路径 `$HOME/.cache/node/corepack` 与'
  + '"把 yarn 装进镜像"这条退路（只清洗不给出路 = 把离线 runner 静默推向 npmjs）')
  check(/corepack enable[^\n]*做不到/u.test(COREPACK_HOME_GUIDANCE),
    '[corepack-guidance] `corepack enable` 必须以"**做不到**（只建 shim、不下载）"的形态出现 ——'
    + '它是这条指引里唯一被实测证伪的操作')
  check(!/corepack enable[^\n]*(?:即可|就行|即可预热|也可以)/u.test(COREPACK_HOME_GUIDANCE),
    '[corepack-guidance] 不得再把 `corepack enable` 写成"即可/就行"（W1 N3 的原始缺陷：'
    + '照它做默认缓存仍为空，corepack 照样去 registry 取 yarn）')
  return { failures, assertions }
}

async function runPool(tasks, concurrency, results, guardChildEnv) {
  let cursor = 0
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, tasks.length)) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      const task = tasks[index]
      if (task === undefined) return
      const result = await runGuard(task, guardChildEnv)
      results.push(result)
      console.log(`${result.ok ? '✓' : '✗'} ${task.name} ${(result.ms / 1000).toFixed(1)}s`)
    }
  })
  await Promise.all(workers)
}

/**
 * 本模块是"被直接执行"还是"被 import"（第十轮复审 V1 的 P1：被 import 时**零副作用**）。
 *
 * 与 `check-workspaces.mjs` 末尾同一实现：Node ≥24.2 用 `import.meta.main`；Node 22.19
 * 回退到 `process.argv[1]` 与自身 realpath 的比较（两条都不成立 ⇒ 视为被 import）。
 * 为什么必须判：本运行器现在 `import` 编排器取共享的失败摘要实现，**它也反过来会被
 * 判据文件 import**（例如回归门禁要直接调 `sanitizeGuardEnvironment()`）——
 * 那时跑守卫、spawn 子进程、退出进程都是错的（"被 import 时跑任何东西"就是 P1 的同族缺陷）。
 * @returns 是否应当执行 `main()`。
 */
function isEntryPoint() {
  // Node ≥24.2 的原生判据（本仓 CI 与本地都是 24.x）：精确、无路径形态歧义。
  if (typeof import.meta.main === 'boolean') return import.meta.main
  // 回退（Node 22.19 线）：`process.argv[1]` 是**已解析**的入口绝对路径（Node 会解析
  // 符号链接，除非显式 `--preserve-symlinks-main`）。两条比较都不成立 ⇒ 被 import。
  const entry = process.argv[1]
  if (entry === undefined) return false
  const self = fileURLToPath(import.meta.url)
  try {
    if (resolve(entry) === self) return true
  } catch {
    // 比较失败只会让它落到下面的 realpath 比较，不改变结论方向
  }
  try {
    return realpathSync(entry) === realpathSync(self)
  } catch {
    return false
  }
}

/** 运行器主体（只在"被直接执行"时调用 —— 见 `isEntryPoint()`）。 */
async function main() {
  // R11 P0-1（I1 泳道）：**本进程自己的判决可信吗** —— 环境里有"能改写解释器/退出码"的键
  // （`NODE_OPTIONS=--import=…` / 动态链接器预载 / `BASH_FUNC_*`）时直接拒绝运行。
  // 放在一切判据之前：这类键能在本进程内执行代码，实测能把 `process.exit(3)` 改写成 0，
  // 所以"跑完再报"的每一条结论都不可信（`--list` 也一样拒 —— 它正是各判据的输入面）。
  const runnerTrust = runnerTrustProblems()
  if (runnerTrust.length > 0) refuseUntrustedRunner('check-root-guards', runnerTrust)

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

  // 子进程环境清洗的**自证**(D-03):危险族必丢 / 普通键必留 / 丢弃清单与实际一致 /
  // 真子进程在注入退出钩子时"未清洗 ⇒ 0、清洗后 ⇒ 1"。任何一条不成立 ⇒ exit 2
  // (配置错误:清洗失效是静默的,不能降级成告警)。
  const guardEnvSelftest = selfTestGuardEnvironment()
  if (!Array.isArray(guardEnvSelftest?.failures) || typeof guardEnvSelftest?.assertions !== 'number') {
    console.error('check-root-guards: selfTestGuardEnvironment() 的返回形状不对(需要 {failures, assertions})')
    process.exit(2)
  }
  if (guardEnvSelftest.failures.length > 0 || guardEnvSelftest.assertions < SELFTEST_GUARD_ENV_ASSERTIONS) {
    for (const detail of guardEnvSelftest.failures) console.error(`check-root-guards: ${detail}`)
    if (guardEnvSelftest.assertions < SELFTEST_GUARD_ENV_ASSERTIONS) {
      console.error(`check-root-guards: 环境清洗自检只执行了 ${guardEnvSelftest.assertions} 条断言`
        + `(期望 ≥ ${SELFTEST_GUARD_ENV_ASSERTIONS}) ⇒ 自检被掏空。`)
    }
    console.error('  ⇒ 拒绝在"子进程环境清洗失效"的情况下继续:它失效时门禁会打印'
      + '「16 个根守卫:16 通过、0 失败」而守卫的退出码全被改写(第十轮审计 D-03)。')
    process.exit(2)
  }

  // 判定形态表的**逐形态自检**(第十轮复审 W1 的 N4/N5):本运行器是 docs-only PR 的
  // 唯一防线,而它的失败详情就是这套形态表 —— 表失效时诊断面整行消失,门禁却仍 EXIT=1。
  // 与上一条同一取向:配置/自检失败 ⇒ exit 2,不降级成告警。
  const verdictSelftest = selfTestVerdictClassifier()
  if (!Array.isArray(verdictSelftest?.failures) || typeof verdictSelftest?.assertions !== 'number') {
    console.error('check-root-guards: selfTestVerdictClassifier() 的返回形状不对(需要 {failures, assertions})')
    process.exit(2)
  }
  if (verdictSelftest.failures.length > 0 || verdictSelftest.assertions < SELFTEST_VERDICT_ASSERTIONS) {
    for (const detail of verdictSelftest.failures) console.error(`check-root-guards: ${detail}`)
    if (verdictSelftest.assertions < SELFTEST_VERDICT_ASSERTIONS) {
      console.error(`check-root-guards: 判定形态自检只执行了 ${verdictSelftest.assertions} 条断言`
        + `(期望 ≥ ${SELFTEST_VERDICT_ASSERTIONS}) ⇒ 自检被掏空。`)
    }
    console.error('  ⇒ 拒绝在"失败详情看不见"的情况下继续:形态表少一条,那种失败行就会在'
      + 'CI 日志里整行消失(PR #146 的现场),而"看不见"与"没有失败"几乎同形。')
    process.exit(2)
  }

  // `COREPACK_HOME` 离线指引的**内容自检**(第十轮复审 W1 的 N3):这条指引是离线 runner 上
  // 唯一可执行的补救,而它上一版写的是一条**做不到的操作**(`corepack enable` 不预热缓存)。
  // 文案错误的代价与代码等价:照做的人在断网 runner 上得到与"没有指引"一样的失败。
  const corepackGuidanceSelftest = selfTestCorepackGuidance()
  if (!Array.isArray(corepackGuidanceSelftest?.failures)
    || typeof corepackGuidanceSelftest?.assertions !== 'number') {
    console.error('check-root-guards: selfTestCorepackGuidance() 的返回形状不对(需要 {failures, assertions})')
    process.exit(2)
  }
  if (corepackGuidanceSelftest.failures.length > 0
    || corepackGuidanceSelftest.assertions < SELFTEST_COREPACK_GUIDANCE_ASSERTIONS) {
    for (const detail of corepackGuidanceSelftest.failures) console.error(`check-root-guards: ${detail}`)
    if (corepackGuidanceSelftest.assertions < SELFTEST_COREPACK_GUIDANCE_ASSERTIONS) {
      console.error(`check-root-guards: 离线指引自检只执行了 ${corepackGuidanceSelftest.assertions} 条断言`
        + `(期望 ≥ ${SELFTEST_COREPACK_GUIDANCE_ASSERTIONS}) ⇒ 自检被掏空。`)
    }
    console.error('  ⇒ 拒绝在"给离线 runner 的补救指引不成立"的情况下继续(W1 复审 N3:'
      + ' 旧文案让人跑 `corepack enable`,而它只建 shim、不预热默认缓存)。')
    process.exit(2)
  }

  // 子进程环境**只算一次**（第十轮审计 D-03）：守卫的判定必须在干净环境里跑。
  const GUARD_CHILD_ENV = sanitizeGuardEnvironment()
  const CONTAMINATED_KEYS = contaminatedRunnerKeys()

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

  // 守卫名必须真的是根 package.json 里的脚本（改名/删除 ⇒ 这里红，而不是"跑了个不存在的东西"）；
  // 脚本体还必须是"直接执行一个脚本文件"的形态 —— 名字与 argv 都对、实现被换成 `true` /
  // `echo ok` / `node -e ""` 时，守卫会"通过"而什么都没判（R8-D-22 的同族通道）。
  const rootPackage = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const rootScripts = Object.keys(rootPackage.scripts ?? {})
  const unknown = guards.filter(guard => !rootScripts.includes(guard.name)).map(guard => guard.name)
  if (unknown.length > 0) {
    console.error(`check-root-guards: 编排器表里的守卫在 package.json scripts 里不存在：${unknown.join(', ')}`)
    process.exit(2)
  }
  const hollowScripts = guards
    .map(guard => ({ name: guard.name, problem: guardScriptProblem(guard.name, rootPackage.scripts?.[guard.name]) }))
    .filter(entry => entry.problem !== null)
  if (hollowScripts.length > 0) {
    console.error('check-root-guards: 根 package.json 里的守卫脚本不是"真的在跑一个脚本"：')
    for (const entry of hollowScripts) console.error(`  · ${entry.problem}`)
    console.error('  ⇒ 名字与 argv 都对、实现是壳（`true`/`echo ok`/`node -e ""`/带参数）时，'
      + '本运行器会报"守卫通过"而实际零判定。请把脚本体改回 `node scripts/<file>` / `bash scripts/<file>`。')
    process.exit(2)
  }
  // 反向对拍（第九轮审计 B 泳道 P1-5）：登记了却不在编排器表里的条目同样 fail-loud ——
  // 陈旧登记留着，下一个人就能把某个"已删守卫"的名字重新指到一个能通过的脚本上。
  const staleRegistered = [...REGISTERED_GUARD_ENTRIES.keys()].filter(name => !guards.some(guard => guard.name === name))
  if (staleRegistered.length > 0) {
    console.error(`check-root-guards: REGISTERED_GUARD_ENTRIES 里的这些守卫不在编排器表里：${staleRegistered.join(', ')}`)
    console.error('  ⇒ 守卫被删/改名后登记项必须一起清掉（陈旧登记 = 一个可复用的重定向目标）。')
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

  // 环境清洗的**证据**(不是"存在性断言"):真的丢了哪些键,逐条打出来。
  if (GUARD_CHILD_ENV.dropped.length > 0) {
    console.log(`check-root-guards: 子进程环境已清洗 —— 丢弃 ${GUARD_CHILD_ENV.dropped.length} 个"会改写解释器"
      的键:${GUARD_CHILD_ENV.dropped.join('、')}(守卫子进程不再继承它们;登记表见 GUARD_CHILD_ENV_ALLOWED)`)
  } else {
    console.log('check-root-guards: 子进程环境已清洗 —— 本次没有命中危险族键(丢弃 0 个)')
  }
  // 被清洗掉的键里有 `COREPACK_HOME` ⇒ **当场**给出离线 runner 的处置指引（P3-D4 的第②条：
  // 清洗 fail-closed 不变，但代价必须可见、可照做 —— "静默让离线 runner 去 npmjs 取 yarn" 不许）。
  const droppedCorepackHome = GUARD_CHILD_ENV.dropped.includes('COREPACK_HOME')
  if (droppedCorepackHome) {
    console.error(`check-root-guards: WARNING — ${COREPACK_HOME_GUIDANCE}`)
  }
  // 本进程自己被污染时**明说**（不静默）:退出钩子在模块求值前就装好了,进程内卸不掉,
  // 但子进程环境已清洗 + 退出路径已加固(removeAllListeners + process.exit)。
  //
  // **两类键必须分开说**（第十一轮复审 J1 的 N3）：`CONTAMINATED_KEYS` 是"清洗清单"（子进程不继承），
  // 而"判决可不可信"由 `runnerTrustProblems()` 按**能力**判（`NODE_OPTIONS` 看内容）。
  // 原来一律按"注入面"告警 ⇒ 正当的 `NODE_OPTIONS=--max-old-space-size=…` 会被说成"守卫跑而恒绿"，
  // 那是把一条已经判定无害的配置讲成攻击。
  if (runnerTrustProblems().length > 0) {
    // 理论上不可达（`main()` 开头的 `refuseUntrustedRunner()` 已经拦掉）—— 留着是为了"万一判据漂移"。
    console.error(`check-root-guards: WARNING — 本进程自己的环境里有**判决不可信**的键(${CONTAMINATED_KEYS.join('、')});`
      + '\n  这是"守卫跑而恒绿"的注入面(第十轮审计 D-03)。子进程环境已清洗,退出路径已加固,'
      + '但**判据面的第一道**在 scripts/check-workflows.mjs 的 [SK-17](被钉单元的 env/步骤体白名单)。')
  } else if (CONTAMINATED_KEYS.length > 0) {
    console.log(`check-root-guards: 提示 —— 本进程环境里有 ${CONTAMINATED_KEYS.length} 个键（${CONTAMINATED_KEYS.join('、')}）`
      + '**不会**传给守卫子进程；它们已由 `runnerTrustProblems()` 判过"改不了本进程的解释器行为/退出码"'
      + '（例：正当的 `NODE_OPTIONS=--max-old-space-size=…`），因此不构成注入面（J1 复审 N3 的两类之分）。')
  }

  console.log(`check-root-guards — 并发 ${concurrency}；docs-only 的 PR 也必须跑到的根守卫（${guards.length} 个）`
    + `${options.allowAdvisory ? '；**--allow-advisory**：advisory 失败只告警' : ''}`)
  console.log(`check-root-guards: argv 登记校验通过 —— ${guards.length} 条守卫的 argv 全部是 \`run <条目名>\``
    + `（登记的参数尾：${REGISTERED_GUARD_ARG_TAILS.size === 0
      ? '无'
      : [...REGISTERED_GUARD_ARG_TAILS].map(([name, tail]) => `${name} ${tail.join(' ')}`).join('；')}）`)
  console.log('check-root-guards: 执行体入口 —— 守卫按登记脚本**直接 spawn**（不经 yarn）'
    + '；只有"登记脚本文件不存在"时才回落到 `corepack yarn run`，且回落前必须过'
    + ' `yarnEntryTrustProblems()`（禁 yarnPath/plugins/生命周期钩子）。')
  const startedAt = Date.now()
  const results = []
  await runPool(guards, concurrency, results, GUARD_CHILD_ENV)

  // **默认不放行 advisory**（R6-C-1③）：这条路径是 docs-only PR 的唯一防线，"一个词让红变绿"
  // 在这里尤其危险。只有显式 `--allow-advisory` 才降级成告警 —— CI 的任何调用都不许带它。
  const toleratesAdvisory = options.allowAdvisory
  const failed = results.filter(result => !result.ok
    && !(result.guard.advisory === true && toleratesAdvisory))
  const advisory = results.filter(result => !result.ok && result.guard.advisory === true)
  const tolerated = toleratesAdvisory ? advisory : []
  console.log(`──── ${results.length} 个根守卫：${results.length - failed.length - tolerated.length} 通过、`
    + `${failed.length} 失败、${tolerated.length} 告警(advisory)，总耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`)
  // R11-J1 N1（把判定权从"被审进程"上移到父进程/CI）：与编排器的 `VERDICT PASS` 同一凭据口径。
  // 只有"**每个**登记守卫都真的跑过、且没有一条失败"才打印 PASS —— `refuseUntrustedRunner()`
  // 在打印它之前就结束进程（连"清单"那一行都还没打），`--allow-advisory` 这类显式降级也拿不到它。
  // 诚实边界：进程内做不到绝对（钩子能改写 `kill`/`abort`/`reallyExit` ⇒ 最后一层是"阻塞不返回"），
  // 所以父进程/CI 请**认这一行**，不要只认退出码。
  if (results.length > 0 && failed.length === 0 && tolerated.length === 0) {
    console.log(`check-root-guards: VERDICT PASS guards=${results.length}`
      + '（每个登记的根守卫都跑过且通过 —— 这是"根守卫跑过了"的唯一凭据）')
  } else {
    console.error(`check-root-guards: VERDICT FAIL guards=${results.length} failed=${failed.length}`
      + `${tolerated.length > 0 ? ` tolerated=${tolerated.length}` : ''}`
      + '（这一行与通过行互斥：唯一的凭据是以 `check-root-guards: ` 开头的通过行；非通过的行里刻意不出现那个词）')
  }
  if (!toleratesAdvisory && advisory.length > 0) {
    console.error(`\n提示：有 ${advisory.length} 条失败落在 advisory 守卫上，但本运行器**默认不认 advisory**`
      + '（docs-only 的 PR 只有这条路）。要让它们不拦门禁，必须显式传 `--allow-advisory`。')
  }

  for (const result of failed) {
    console.error(`\n===== ${result.guard.name} 失败 =====`)
    console.error(options.fullOutput ? result.output.trimEnd() : summarize(result.output))
  }
  // 失败文案里**再给一次**离线指引（P3-D4）：守卫失败 + `COREPACK_HOME` 被清洗 = 现场最需要
  // 知道"我该预热默认缓存还是把 yarn 装进镜像"的时刻（只在真的丢了它时打印，不刷屏）。
  if (failed.length > 0 && droppedCorepackHome) {
    console.error(`\n${COREPACK_HOME_GUIDANCE}`)
  }
  for (const result of tolerated) {
    console.error(`\n===== ${result.guard.name} 失败(advisory，--allow-advisory 下不拦门禁) =====`)
    console.error(options.fullOutput ? result.output.trimEnd() : summarize(result.output))
  }
  // **显式且加固的退出**(第十轮审计 D-03):只设 `process.exitCode` 会被 `--import` 注入的
  // 退出钩子改写(实测:`NODE_OPTIONS=--import=<hook>` + `process.exitCode = 1` ⇒ EXIT=0)。
  // 光调 `process.exit(1)` 同样会被改写 —— 因为钩子的 `process.on('exit')` 处理器在退出前
  // 仍然跑得到,它把 `process.exitCode` 改回 0(本机 Node 24.16.0 实测)。所以先摘掉**所有**
  // 退出钩子(本运行器自己不注册任何 `exit`/`beforeExit` 监听器,摘掉是安全的),再显式退出。
  // 诚实边界:钩子若改写 `process.exit` 本身,进程内无解(实测 `process.exit = () => {}` 之后
  // 连 `process.exit(1)` 都是 no-op)—— 那由 [SK-17] 的静态白名单负责拦在 CI 之外。
  process.removeAllListeners('exit')
  process.removeAllListeners('beforeExit')
  process.exit(failed.length > 0 ? 1 : 0)

}

if (isEntryPoint()) await main()
