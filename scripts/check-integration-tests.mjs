#!/usr/bin/env node
/**
 * `integration-tests/**` 的可执行守卫（2026-09-23 二轮审计 W3-02/W3-03/W3-04 后新增）。
 *
 * 为什么需要它：这两个集成测试脚本打的是**真实 IdP + 真实服务端**，需要 Docker +
 * Xvfb，因此**整跑不在 CI**（`integration-tests/README.md`：端到端跑需 Docker，可静态
 * 执行的那部分 2026-09-23 起进门禁 —— 就是这个守卫）。
 * 后果是它们长期脱离门禁，腐烂到"**永远不可能通过**"也没人发现：
 *   · `dex-sso-test.py` 的深链断言结构上不可达（urllib 无法跟随自定义 scheme）⇒
 *     全流程正常也 `RESULT: FAIL`；
 *   · `ldap-rbac-brand-test.py` 断言 2026-09-10 已被渠道配置取代的旧 `brand` 契约
 *     （`enabled` / `Acme AI`）⇒ 必然走 else 分支判失败；另一条"auditor 写面被拒
 *     (非 200)"用伪造 cookie ⇒ 恒 401 ⇒ `st != 200` 恒真（零判别力）。
 *
 * 本守卫把**可静态执行的那部分**接进门禁（不需要 Docker / PG / 显示器）：
 *   1. 语法：`integration-tests/**\/*.py` 逐个 `ast.parse`（等价 py_compile，不落 __pycache__）；
 *      同一层还有 `integration-tests/**\/*.mjs` 的 `node --check`；
 *   2. 判据自检：每个用例脚本的 `--self-test` 必须通过，且"判据夹具"条数达标 ——
 *      自检里每条判据都配了**负例**，负例不被拒就是判据退化（恒真）；
 *   2b. `electron-shots` 的**判据表**（第四轮审计 R4-A-17/R4-A-18）：判据本体外置到
 *      `integration-tests/electron-shots/assertions.mjs`，由本守卫做三层检查 ——
 *      ① 表形态（≥8 条判据、id 唯一、每条都有正例 + 负例夹具）；② 真跑 `--self-test`
 *      并把夹具条数与登记值对账；③ 接线（运行期脚本必须逐条引用表里的 id，且不得出现
 *      `check(x, true)` 这类常量判据）。此前该脚本的 8 条运行期断言**零守卫覆盖**：
 *      把它们改成常量、needle 全部保留，本守卫仍然 EXIT=0；
 *   3. **端到端存活**（假网关，本进程内起 http server，端口取 0）：
 *      · `good`：假网关按真契约应答 ⇒ 两个脚本必须 exit 0（证明"正常时应通过"）；
 *      · `skip`：provider 未配置 ⇒ 两个脚本必须 exit 77 且**不得**打印 PASS
 *        （证明 SKIP 与 PASS 可区分，不是"一律报错"也不是"静默通过"）；
 *      · `dex-http-deeplink`：回调 302 到 http 地址而不是深链 ⇒ dex 必须 exit 1
 *        （这正是旧脚本咬不到的那条契约）；
 *      · `ldap-legacy-channel`：`/channel` 回旧 brand 契约 ⇒ ldap 必须 exit 1；
 *      · `ldap-rbac-fall-open`：auditor 的写请求被放行(200) ⇒ ldap 必须 exit 1
 *        （旧脚本那条恒真断言在这里是绿的 —— 变异验证的靶子）。
 *
 *   4. **两个 `.py` 契约脚本的判据表 / 判定通道 / 端到端变异**（2026-09-23 第十三轮审计
 *      F-01，P0）：第 4–6 轮把上面第 2b/2c 段那套纪律**只加在 `electron-shots` 一条腿**上，
 *      两个 `.py` 停在"`--self-test` 夹具数 ≥15 + 3 条假网关负例"。现场：
 *
 *          dex 掏空运行期判据: 6 / ldap 掏空运行期判据: 8
 *          self-test: 24/24 条判据夹具符合预期   ← 夹具层完全看不出掏空
 *          check-integration-tests: OK — … 2 个契约脚本判据自检通过 …   REAL_GATE_EXIT=0
 *
 *      即"判据的自我陈述比它实际判的东西宽"。现在两个脚本的契约落进**判据表**
 *      （`CRITERIA`，唯一真源），运行期按 id 经 `contractkit.Reporter.report()` 求值，
 *      本守卫做四层检查：
 *        ① **登记值对账**：精确 id 集合 + **逐 id 正/负例条数**（`--dump-criteria`）——
 *           删判据、改 id、删夹具都必须同时改这里的登记清单；
 *        ② **运行期逐条引用**：每条判据 id 都必须有一个"以该 id 字面量为首参"的调用点，
 *           且被调方**逐字**是 `reporter.report`、观测非空（`{}` = 没把观测传进来）；
 *        ③ **判据本体自证**：`--self-test` 每条判据的正/负例夹具必须给出期望结论；
 *        ④ **判定通道自证 + 端到端变异**：`--self-check` 把全部夹具经**运行期那条
 *           `report()`** 求值；再在**变异副本**上复跑四种掏空形态 ——
 *           · `criteria-tautology`（逐条判据 × 两个脚本：把 `evaluate` 掏成 `return []`）
 *             ⇒ `--self-test` 必须非零，且必须**具名**咬住被掏空的那条；
 *           · `judge-tautology`（`judge()` 恒真）⇒ `--self-check` 必须非零，
 *             而 `--self-test` 照旧绿（证明两层互补，单靠夹具层是盲的 —— N7 的形态）；
 *           · `count-side-zero`（只改计票侧 `failures += 0`）⇒ `--self-check` 必须非零；
 *           · `runtime-wrapper`（运行期通道换成恒真包装，id 引用一字未改）
 *             ⇒ `--self-check` 必须非零。
 *
 *   5. **用例登记制 + 聚合层双向对账**（第十三轮 F-02 / F-03，P1）：
 *      `integration-tests/**` 下每个可执行体（`.py` / `.mjs` / `.sh`）都必须在
 *      `INTEGRATION_ENTRIES` 里登记角色；**登记了却不在 / 在却没登记都红**。
 *      聚合层 `run-all.sh` 的 `run "<名>" <runner> <路径>` 行与登记表里
 *      `aggregateName` 的条目**双向逐条对拍**（顺序也钉住）—— 此前只有
 *      `electron-shots` 的接线被钉住，两个 `.py` 从聚合层摘线**零判据**。
 *
 * 找不到 python3 时**判失败**（不是跳过）：本仓 CI runner（ubuntu-24.04）自带 python3，
 * "工具不在 ⇒ 静默不查"正是本守卫要根除的形态。
 *
 * 用法：`node scripts/check-integration-tests.mjs`；exit 0 通过、1 有失败。
 */

import { spawn, spawnSync } from 'node:child_process'
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const notes = []
const fail = message => failures.push(message)
/** 条件断言（失败即记一条原因，与 check-* 系列守卫同形）。 */
const check = (condition, message) => {
  if (!condition) fail(message)
  return condition
}

/** 本守卫自己造的临时目录（进程退出时统一清理）。 */
const scratchDirs = []

/** 造一个临时目录。 */
function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratchDirs.push(dir)
  return dir
}

/** 契约用例脚本（带 --self-test 与真实断言的那两个）。 */
const CONTRACT_TESTS = [
  { id: 'dex', path: 'integration-tests/dex/dex-sso-test.py', minCases: 32 },
  { id: 'ldap', path: 'integration-tests/openldap/ldap-rbac-brand-test.py', minCases: 35 },
]

/**
 * 两个 `.py` 契约脚本的**判据表登记值**（第十三轮审计 F-01 的修复）。
 *
 * 与 `ELECTRON_SHOTS_EXPECTED_ASSERTIONS` 同一手法，但多一列：**逐 id 的正/负例条数**。
 * 为什么必须有条数这一列 —— 只用"夹具总数 ≥ 下限"当棘轮时，实测 dex 可删 9/24（37.5%）、
 * ldap 可删 14/29（48%）而门禁全绿（第十三轮 F-04），且每次只删 1 条、分 9/14 次提交，
 * 任何单次 diff 都看不出退化。条数写进登记值之后，删任何一条夹具都必须改这里的数字
 * （登记值进 diff 才会被评审看见）。
 *
 * ⚠️ 改 `CRITERIA` / 增删夹具**必须**同步这张表。`positive >= 1 && negative >= 1` 已由
 * `--self-test` 自身强制（缺正例/负例都会红），这里记的是**精确条数**。
 */
const DEX_EXPECTED_CRITERIA = [
  { id: 'login-start', positive: 1, negative: 2 },
  { id: 'idp-login-page', positive: 1, negative: 2 },
  { id: 'submit-credentials', positive: 1, negative: 3 },
  { id: 'approval-advance', positive: 2, negative: 3 },
  { id: 'callback-reached', positive: 1, negative: 3 },
  { id: 'deep-link', positive: 2, negative: 6 },
  { id: 'deep-link-identity', positive: 2, negative: 3 },
]
const LDAP_EXPECTED_CRITERIA = [
  { id: 'employee-login', positive: 1, negative: 3 },
  { id: 'admin-login', positive: 1, negative: 3 },
  { id: 'auditor-employee-rejected', positive: 1, negative: 2 },
  { id: 'auditor-admin-login', positive: 1, negative: 1 },
  { id: 'auditor-permissions', positive: 1, negative: 2 },
  { id: 'auditor-read', positive: 1, negative: 1 },
  { id: 'auditor-write-forbidden', positive: 1, negative: 4 },
  { id: 'anonymous-write-control', positive: 1, negative: 1 },
  { id: 'channel-contract', positive: 1, negative: 6 },
  { id: 'portal-download-section', positive: 1, negative: 2 },
]

/** 逐用例的判据登记表（唯一真源：上面两张表）。 */
const CONTRACT_CRITERIA = new Map([
  [CONTRACT_TESTS[0].id, DEX_EXPECTED_CRITERIA],
  [CONTRACT_TESTS[1].id, LDAP_EXPECTED_CRITERIA],
])

/**
 * `electron-shots` 判据表的**登记值**（第四轮审计 R4-A-17/R4-A-18 的修复）。
 *
 * 与 `SELFTEST_EXPECTED_POLICIES` / `CHECK_*` 同一手法：声明一份清单，断言实际跑到的
 * 就是它 —— 删掉一条判据、改名、或把表换成别的东西都会红（"表还在但判据少了"是最容易
 * 被忽略的退化形态：判据数量掉下去没有任何函数签名会变）。
 *
 * ⚠️ 改判据表必须同步这里（这是有意的：登记值进 diff 才会被评审看见）。
 */
const ELECTRON_SHOTS_EXPECTED_ASSERTIONS = [
  'left-login-page',
  'method-picker',
  'screenshot-nonempty',
  'script-completed',
  'server-filled',
  'step1-login-page',
  'step2-brand',
  'step2-shot-differs-from-step1',
  'two-step-login-page',
]
/**
 * 夹具总数下限（当前 29 条 = 正例 + 负例）。
 *
 * 与 `minCases` 同一口径的棘轮：删夹具必须同时改这个常量并进 diff。
 * **诚实边界**：单个**冗余**负例夹具被删（同一判据还有别的负例）本条拦不住 —— 那种
 * 删除不降低判别力（剩下的负例照样会拒掉恒真判据），所以不为此加精确夹具清单
 * （精确清单会让每次补夹具都要改两处，代价大于收益）。
 */
const ELECTRON_SHOTS_MIN_FIXTURES = 24
/**
 * `electron-shots.mjs` 里"以判据 id 为首参的调用点"数量下限（当前 10 处）。
 *
 * 棘轮：删调用点 = 运行期不再判那条判据（既有的"id 必须出现在源码里"判据连**注释**里
 * 出现都算），所以必须按调用点计数。增删判据调用时同步改这个常量并进 diff。
 */
const ELECTRON_SHOTS_MIN_RUNTIME_CALLS = 10

/**
 * `run-all.sh` 里一条接线（`run "<名>" <runner> <路径> [额外实参…]`）的**唯一解析口径**。
 *
 * ## 为什么不能写 `\s`（第十三轮 V13-C R-5：新引入的真缺陷）
 *
 * 旧口径是 `/^run\s+"([^"]+)"\s+(\S+)\s+(\S+)(?:\s+.*)?$/gmu`。JS 的 `\s` **包含 `\n`**，
 * 而尾巴 `(?:\s+.*)?` 是可选的 ⇒ 一条**不带额外实参**的 `run` 行会把它的下一行整个吃掉：
 *
 * ```
 * run "1. A" python3 a.py      ← 这一行没有尾参
 * run "2. B" python3 b.py      ← 被上一行的 `\s+` 吃进尾巴，解析结果只有 1 条
 * ```
 *
 * 现场方向是**假红**（新插一条无尾参的接线时，守卫报"接线数与登记值不一致 / 缺第 N 条"，
 * 理由与真实缺陷无关），但它会让下一个人照着错误的方向修 —— 所以收紧成"行内水平空白"。
 * `[^\S\n]` = `\s` 去掉 `\n`（保留 `\r` 之外的制表符/空格/全角空格等）。
 *
 * **判据**（`aggregateParserSelfTest()`，每次跑守卫都执行）：两行相邻的 `run` 必须解析成
 * **两条**；带尾参的行不得吞掉下一行；缩进行 / 注释行不算接线。
 */
const AGGREGATE_RUN_LINE = /^run[^\S\n]+"([^"]+)"[^\S\n]+(\S+)[^\S\n]+(\S+)(?:[^\S\n]+.*)?$/gmu

/**
 * 解析 `run-all.sh` 的接线行 —— **唯一实现**（登记制对账与自检共用同一份）。
 * @param source - `run-all.sh` 的文本。
 * @returns `{{ name: string, runner: string, path: string }}[]`（按出现顺序）。
 */
function parseAggregateRuns(source) {
  return [...source.matchAll(AGGREGATE_RUN_LINE)]
    .map(match => ({ name: match[1], runner: match[2], path: match[3] }))
}

/**
 * 解析器自己的正/反用例（第十三轮 V13-C R-5 的回归判据）。
 *
 * 没有这一条时，"有人把 `[^\S\n]` 改回 `\s`"这件事**在真仓上不可见** —— 真仓三条接线
 * 恰好都带尾参（`"$SERVER_BASE"`），跨行合并不会发生，守卫照旧全绿。所以这条自检断言的是
 * **解析器的能力**（相邻两行 ⇒ 两条），而不是"当前这份 run-all.sh 恰好解析对了"。
 */
function aggregateParserSelfTest() {
  const adjacent = 'run "1. A" python3 a.py\nrun "2. B" python3 b.py\n'
  const parsedAdjacent = parseAggregateRuns(adjacent)
  check(parsedAdjacent.length === 2,
    '形态⑦: run-all.sh 解析器把**两行相邻的 `run`** 解析成了 '
      + `${parsedAdjacent.length} 条（必须 2 条）—— 正则里的空白类吃了换行（V13-C R-5 的形态），`
      + `实际：${JSON.stringify(parsedAdjacent)}`)
  check(parsedAdjacent.map(entry => entry.path).join(',') === 'a.py,b.py',
    '形态⑦: 两行相邻 `run` 的解析结果错位（必须按序 a.py / b.py）：'
      + JSON.stringify(parsedAdjacent.map(entry => entry.path)))
  const withTail = parseAggregateRuns('run "1. A" node a.mjs --server "$BASE"\nrun "2. B" python3 b.py\n')
  check(withTail.length === 2 && withTail[0].path === 'a.mjs' && withTail[1].path === 'b.py',
    '形态⑦: 带额外实参的接线不得吞掉下一行，也不得把尾参当成路径：' + JSON.stringify(withTail))
  const noise = parseAggregateRuns('# run "0. 注释里的调用" python3 ghost.py\n  run "1. A" python3 a.py\n')
  check(noise.length === 0,
    '形态⑦: 注释行与缩进行都不算接线（`^run` 必须锚在行首）：' + JSON.stringify(noise))
  notes.push(`聚合层解析器: 相邻两行 ⇒ 2 条、尾参不吞行、注释/缩进行不误判 ✓`)
}

/**
 * `integration-tests/**` 的**用例登记表**（第十三轮审计 F-03 的修复）。
 *
 * 现场：这个面**只有"减少"有判据、"增加"没有** —— 新增一个必然 `exit 77` 的用例
 * （或一个恒真断言的用例）接进 `run-all.sh`，门禁照 `EXIT=0`，还会计进
 * "3 个 Python 用例语法通过"。删掉已登记用例反而会红。这正是本仓已登记的假绿类
 * 「判据的语料完整性」。
 *
 * 角色（决定这条登记项还要满足哪些判据）：
 *   · `aggregate`      —— 聚合层脚本（`run-all.sh`）：必须有 SKIP(77) 契约。
 *   · `contract-test`  —— 带 `CRITERIA` 判据表的契约用例：必须有 `--self-test` /
 *     `--self-check` / `--dump-criteria` 三个入口，判据表与夹具受 `CONTRACT_CRITERIA`
 *     登记值对账，且**必须被聚合层调用**（`aggregateName`）。
 *   · `assertion-table`—— `electron-shots` 的判据表（被运行期脚本与门禁共同消费）。
 *   · `judge-channel`  —— 判据通道模块（被 `contract-test` 引用，不单独跑）。
 *   · `judged-runner`  —— 消费判据表的运行期脚本，**必须被聚合层调用**。
 *
 * `aggregateName` + `runner` + `aggregatePath` 就是 `run-all.sh` 里那一行的形状：
 *   `run "<aggregateName>" <runner> <aggregatePath>`
 * 双向对账（登记了却不在 ⇒ 红；在却没登记 ⇒ 红；顺序不同 ⇒ 红）见 §0。
 *
 * ## 判别力下限（第十三轮 V13-C R-2：F-03 的残留那一半）
 *
 * 登记制只买到**可见性**，买不到**阻止**：V13-C 实测（探针 `p07d`）把"必然 `exit 77`、
 * 什么都不验"的新用例**登记齐、顺序对**（`role: 'fixture'`）之后，守卫照旧 `EXIT=0` ——
 * `fixture` 这个角色在旧实现里**零角色要求**。所以每条登记项多两个字段：
 *
 *   · `minJudgments`  —— **运行期非 SKIP 的判定条数下限**（棘轮）。只有 1 条硬规矩：
 *     想**接进聚合层**（有 `aggregateName`）就必须声明它，且必须与这条腿**自己的机器可读
 *     判定清单**（`contract-test` 的 `--dump-criteria` / `judged-runner` 的判据表）逐数相等；
 *     非判定角色（`fixture` / `judge-channel` / `assertion-table` / `aggregate`）**不得**接进聚合层
 *     —— "登记了却零判定"于是变成一条当场红的结构判据，而不是靠评审看 diff。
 *   · `skipReasons`   —— 这条腿**允许**打出的 SKIP 原因码（闭集见 {@link SKIP_REASON_CODES}）。
 *
 * 组级再有 `GROUP_MIN_JUDGMENTS`（Σ `minJudgments` 的下限）：新增一条腿不能靠"多一条
 * 恒 SKIP 的接线"把总量撑住，也不能靠删判据把总量压下去。
 */
const INTEGRATION_ENTRIES = [
  { path: 'integration-tests/run-all.sh', role: 'aggregate', skipReasons: [] },
  { path: 'integration-tests/contractkit.py', role: 'judge-channel', skipReasons: [] },
  { path: 'integration-tests/dex/config.yaml', role: 'fixture', skipReasons: [] },
  {
    path: 'integration-tests/dex/dex-sso-test.py',
    role: 'contract-test',
    runner: 'python3',
    aggregatePath: 'dex/dex-sso-test.py',
    aggregateName: '1. Dex SSO 流程测试',
    minJudgments: DEX_EXPECTED_CRITERIA.length,
    skipOutlet: 'skip',
    skipReasons: ['missing-server', 'missing-provider'],
  },
  {
    path: 'integration-tests/openldap/ldap-rbac-brand-test.py',
    role: 'contract-test',
    runner: 'python3',
    aggregatePath: 'openldap/ldap-rbac-brand-test.py',
    aggregateName: '2. LDAP + RBAC + 渠道集成测试',
    minJudgments: LDAP_EXPECTED_CRITERIA.length,
    skipOutlet: 'skip',
    skipReasons: ['missing-server', 'missing-provider'],
  },
  { path: 'integration-tests/electron-shots/assertions.mjs', role: 'assertion-table', skipReasons: [] },
  { path: 'integration-tests/electron-shots/report.mjs', role: 'judge-channel', skipReasons: [] },
  {
    path: 'integration-tests/electron-shots/electron-shots.mjs',
    role: 'judged-runner',
    runner: 'node',
    aggregatePath: 'electron-shots/electron-shots.mjs',
    aggregateName: '3. Electron 截图验证(需打包 app)',
    minJudgments: ELECTRON_SHOTS_EXPECTED_ASSERTIONS.length,
    skipOutlet: 'skip',
    skipReasons: ['missing-app', 'missing-display', 'missing-server'],
  },
]

/**
 * **SKIP 原因的闭集**（第十三轮 V13-C R-2 的第二条修法：`SKIP` 只能来自登记过的原因码）。
 *
 * 现场：`exit 77` 此前是一张**无记名**的免检牌 —— 脚本可以因为任何理由（包括"我什么都不想验"）
 * 打一句 `SKIP: 环境缺失` 走人，聚合层照记 SKIP，门禁照绿。现在每条腿必须：
 *   ① 在自己的源码里声明 `SKIP_REASONS`（= 它的原因码清单），且与本登记表的 `skipReasons` 逐字相等；
 *   ② 只经**唯一出口**（`skipOutlet`）打 SKIP，出口必须校验原因码 ∈ `SKIP_REASONS`；
 *   ③ 调用点给出的原因码**双向**对账（声明了没用 / 用了没声明 都红）；
 *   ④ 真跑一次 SKIP 路径，断言输出里真的是 `SKIP[<已登记原因码>]:`。
 * 未登记的原因码在任何一层都过不去 ⇒ "恒 SKIP 的新用例"不再是一张免检牌。
 */
const SKIP_REASON_CODES = new Map([
  ['missing-server', '服务端 /healthz 不可达/非 200（Docker / PG / 服务端没起，或地址不对）'],
  ['missing-provider', '服务端没配置本用例要求的 IdP / LDAP provider'],
  ['missing-app', '缺打包产物（Electron app 目录不存在）'],
  ['missing-display', '没有可用的 X 显示（DISPLAY 与 X socket 都不可用）'],
])

/** 能提供"机器可读判定清单"的角色 —— 只有它们可以接进聚合层。 */
const JUDGMENT_BEARING_ROLES = new Set(['contract-test', 'judged-runner'])
/**
 * 组级判别力下限（棘轮 = 当前 Σ `minJudgments`）。
 * 新增一条腿**不能**靠"多一条恒 SKIP 的接线"把总量撑住，删判据也不能把总量压下去。
 */
const GROUP_MIN_JUDGMENTS = DEX_EXPECTED_CRITERIA.length
  + LDAP_EXPECTED_CRITERIA.length + ELECTRON_SHOTS_EXPECTED_ASSERTIONS.length

/**
 * 语法/判据面扫描的扩展名（`INTEGRATION_ENTRIES` 必须覆盖它们全部）。
 *
 * 为什么连 `.yaml` 也在内：`dex/config.yaml` 是**夹具**（Dex 的测试用户/客户端定义），
 * 改它等于改这个用例的前置，而此前它与"新增一个没人管的夹具"一样零判据。
 * 只登记可执行体、把夹具留在集合外，正是 F-03 那条"判据的语料完整性"的同族形态。
 */
const INTEGRATION_SCANNED_EXTENSIONS = ['.py', '.mjs', '.sh', '.yaml', '.yml']

/**
 * 本守卫**引用的** `integration-tests/**` 路径里，扩展名不在
 * {@link INTEGRATION_SCANNED_EXTENSIONS} 内、但**明确不是判据面**的登记项（B-04 修法）。
 *
 * 现场（第十四轮 lane B 的 B-04，已实跑复现）：`scripts/check-install-integrity.mjs` 从
 * **本守卫的文本**抽"它 `spawn`/枚举的目标"（`integrationReferencedPaths(guardText)`），
 * 再用 `extensions.includes(extensionOf(path))` 过滤 —— 扩展名集合正是上面这份
 * `INTEGRATION_SCANNED_EXTENSIONS`。于是**引用面被悄悄收窄**：在本守卫里引用
 * `integration-tests/extra-probe.ts`（并让该文件真的存在）之后，
 * `check-install-integrity` 照打 `VERDICT PASS`（EXIT=0），那个文件既不在语法面、也不在
 * 执行体全集里 —— "派生集合的取值面被收窄而登记表看不出来"。
 *
 * 收口：本守卫自己判"我引用的每个 `integration-tests/**` 路径，要么扩展名在扫描面内
 * （于是它进 `INTEGRATION_ENTRIES` 登记制 + 语法闸门 + 执行体全集），要么**逐条登记在这张
 * 表里**并说明为什么它不是判据面"（例如纯图片/二进制夹具）。未登记即红 —— 口径与实现
 * 于是在**同一个文件**里对齐，`extensions.includes()` 的过滤不再是静默的。
 */
const INTEGRATION_REFERENCE_SCOPE_REGISTRY = []

/**
 * 从一段源码文本抽"引用的仓内 `integration-tests/**` 路径"（`'integration-tests/x.ts'` 形态
 * 与 `join(ROOT, 'integration-tests', 'x', 'y')` 形态，与 `check-install-integrity.mjs` 的
 * 同名抽取**同形**，但独立实现 —— 判据不能 import 被它判的东西）。
 * @param source - 源码文本。
 * @returns 归一化后的路径列表（去重、排序）。
 */
function integrationReferencedPathsIn(source) {
  const text = String(source)
  const found = new Set()
  for (const match of text.matchAll(/['"]([A-Za-z0-9_.@/-]*integration-tests\/[A-Za-z0-9_.@/-]+)['"]/gu)) {
    found.add(match[1].replace(/^\.\//u, ''))
  }
  for (const match of text.matchAll(/join\(\s*ROOT\s*,\s*((?:'[^']*'|"[^"]*")(?:\s*,\s*(?:'[^']*'|"[^"]*"))*)\s*\)/gu)) {
    const parts = [...match[1].matchAll(/'([^']*)'|"([^"]*)"/gu)].map(quote => quote[1] ?? quote[2])
    if (parts.length > 0 && parts[0] === 'integration-tests') found.add(parts.join('/'))
  }
  return [...found].sort()
}

/**
 * 引用面与判据面的**扩展名对账**（纯函数，供自证与真跑共用）。
 * @param source - 本守卫自己的源码文本。
 * @param options - `{ exists, registry }`：`exists(path)` 判"该路径是否真的落盘"、
 *   `registry` = {@link INTEGRATION_REFERENCE_SCOPE_REGISTRY} 形态的登记表。
 * @returns `{ referenced, outOfScope, unregistered, deadEntries }`；`unregistered` 非空即红。
 */
function integrationReferenceScope(source, options) {
  const registry = options.registry ?? []
  const registered = new Set(registry.map(entry => entry.path))
  const referenced = integrationReferencedPathsIn(source)
  // 只有**真的落在磁盘上**的引用才有"看不见的执行体"这回事：尚未创建的目标
  // （自证夹具里的 `__probe__` 路径、未来才加的文件）不构成缺口。
  // 目录本身（`join(ROOT, 'integration-tests')`，没有文件名段）不是执行体，跳过。
  const present = referenced.filter(path => path !== 'integration-tests' && options.exists(path))
  const outOfScope = present.filter(path => !INTEGRATION_SCANNED_EXTENSIONS.some(ext => path.endsWith(ext)))
  const unregistered = outOfScope.filter(path => !registered.has(path))
  const deadEntries = [...registered].filter(path => !present.includes(path))
  return { referenced, present, outOfScope, unregistered, deadEntries }
}

/**
 * 引用面对账的**能力自证**：扫描面外的引用（未登记）必须被抓到，登记后必须放行，
 * 扫描面内的引用不得误报，未落盘的目标不得误报。
 */
function integrationReferenceScopeSelfTest() {
  const extension = '.ts'
  const probe = `const EXTRA_TARGET = 'integration-tests/__probe__/extra-probe${extension}'`
  const exists = path => path === `integration-tests/__probe__/extra-probe${extension}`
  const bare = integrationReferenceScope(probe, { exists, registry: [] })
  check(bare.unregistered.length === 1 && bare.unregistered[0] === `integration-tests/__probe__/extra-probe${extension}`,
    '形态⑩自证: 引用了扩展名在扫描面外的 `integration-tests/**` 路径却没登记时必须红 ——'
      + `实际 unregistered=[${bare.unregistered.join(', ')}]（B-04 的现场形态）`)
  const registered = integrationReferenceScope(probe, {
    exists, registry: [{ path: `integration-tests/__probe__/extra-probe${extension}`, why: '自证' }],
  })
  check(registered.unregistered.length === 0,
    `形态⑩自证: 登记之后必须放行 —— 实际 unregistered=[${registered.unregistered.join(', ')}]`)
  const absent = integrationReferenceScope(probe, { exists: () => false, registry: [] })
  check(absent.unregistered.length === 0 && absent.deadEntries.length === 0,
    '形态⑩自证: 没落盘的目标不算缺口（只有真的存在、却看不见的执行体才是缺口）')
  const inScope = `const P = 'integration-tests/__probe__/in-scope.mjs'`
  const ok = integrationReferenceScope(inScope, { exists: () => true, registry: [] })
  check(ok.unregistered.length === 0 && ok.present.length === 1,
    '形态⑩自证: 扫描面扩展名内的引用不得误报 ——'
      + `实际 unregistered=[${ok.unregistered.join(', ')}] present=[${ok.present.join(', ')}]`)
  notes.push('integration-tests 引用面扩展名对账自证: 面外未登记必红 / 登记后放行 / 面内不误报 / 未落盘不算缺口 ✓')
}

/**
 * 判据被掏成恒真的**注入锚点**：每条 `evaluate` 的第一句。
 *
 * 锚点是**契约**而不是巧合：`contractkit.observation_of()` 的文档里写明了门禁靠它做
 * 端到端变异。锚点消失时下面的变异会 `fail(...)` 而不是静默跳过（"判据还在不在"这件事
 * 不能因为源码形状变了就没人管）。
 * @param criterionId - 判据 id。
 * @returns 该判据 `evaluate` 里必须逐字出现的那一行。
 */
const criteriaAnchor = criterionId => `obs = observation_of(obs, '${criterionId}')`

/**
 * 判定通道（`contractkit.py`）的**掏空形态**变异表 —— 与 `electron-shots` 的
 * `BREAK_CASES` 同形：每条都必须在**变异副本**上被 `--self-check` 咬住。
 */
const CONTRACT_KIT_BREAK_CASES = [
  {
    id: 'judge-tautology',
    label: 'judge() 恒真（N7 原形态）',
    needle: "    problems = item['evaluate'](observation)",
    replacement: '    problems = []',
    command: '--self-check',
    expect: /经 report\(\) 求值期望/u,
    // 夹具层对这条形态是**盲的**（--self-test 直接调 evaluate）—— 这条变异存在的意义
    // 就是证明"两层互补"：单靠夹具层看不出运行期已经不再按表判。
    fixtureLayerStillGreen: true,
  },
  {
    id: 'count-side-zero',
    label: '只改计票侧（failures += 0，R5-D-4 原形态）',
    needle: '            self._failures += 1',
    replacement: '            self._failures += 0',
    command: '--self-check',
    expect: /判定结论.*与失败计数.*不一致/u,
  },
]

/**
 * 运行期通道被**整体替换**的变异（注入在脚本的 `_new_reporter()` 里；id 引用一字未改）。
 * 静态判据只钉"调用点还在、还走 `reporter.report`、还传了观测"，管道被换掉只有动态能咬。
 */
const CONTRACT_RUNTIME_WRAPPER_BREAK = {
  id: 'runtime-wrapper',
  label: '运行期通道换成恒真包装（D-1 原形态）',
  needle: '    return Reporter(CRITERIA)',
  replacement: '    return type(\'M\', (), {\n'
    + '        \'report\': lambda self, criterion_id, observation: True,\n'
    + '        \'failures\': lambda self: 0,\n'
    + '        \'events\': lambda self: [],\n'
    + '        \'lines\': lambda self: [],\n'
    + '        \'exit_code\': lambda self: 0,\n'
    + '    })()',
  expect: /经 report\(\) 求值期望|只打了/u,
}


/**
 * 用例脚本的绝对路径。
 *
 * 测试缝（**CI 不得设置**）：`CHECK_IT_DEX_SCRIPT` / `CHECK_IT_LDAP_SCRIPT` 可把某个 id
 * 指向别处的副本 —— 用来做"修复前副本 / 变异体"的对照取证（`temp/` 下的探针靠它复用
 * 本文件里的假网关），默认永远是仓库里的真脚本。
 * @param {{ id: string, path: string }} test - 用例条目。
 * @returns {string} 脚本绝对路径。
 */
function scriptPathFor(test) {
  const override = process.env[`CHECK_IT_${test.id.toUpperCase()}_SCRIPT`]
  return override === undefined || override === '' ? join(ROOT, test.path) : resolve(ROOT, override)
}

/**
 * 跑一个用例脚本，返回 { status, output }。
 *
 * ⚠️ 必须**异步** spawn：假网关跑在**本进程**里，`spawnSync` 会把事件循环钉死，
 * 子进程的 HTTP 请求永远等不到应答（实测挂死到 60s 超时）。
 * @param {string} testPath - 用例脚本**绝对路径**（由 {@link scriptPathFor} 给出）。
 * @param {string} base - 假网关地址。
 * @returns {Promise<{ status: number | null, output: string }>} 退出码与合并输出。
 */
function runTest(testPath, base) {
  return new Promise(resolvePromise => {
    const child = spawn('python3', [testPath, base], { cwd: ROOT })
    let output = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), 90_000)
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    // 没有 python3 / 无法执行时 spawn 会抛 'error'（而不是 close）：必须落成一条可读的
    // 失败，别让守卫以未捕获异常收尾 —— 但**仍然判失败**（"工具不在 ⇒ 不查"是禁止的）。
    child.on('error', error => {
      clearTimeout(timer)
      output += `\n[无法执行 ${testPath}] ${error.message}\n`
      resolvePromise({ status: null, output })
    })
    child.on('close', status => {
      clearTimeout(timer)
      resolvePromise({ status, output })
    })
  })
}

const SESSION_COOKIE = 'picoaide_session'
const OIDC_STATE_COOKIE = 'picoaide_oidc_state_oidc'
const DEEP_LINK_TOKEN = 't0ken-' + 'a1b2c3d4'.repeat(5)
const CHANNEL_GOOD = {
  channel_id: 'official',
  title: 'Example Harness',
  login: {
    display_name: 'Example',
    tagline: 'tagline',
    welcome: 'welcome',
    logo_url: '/api/client/v2/channel/logo',
  },
  client: { display_name: 'Example', logo_url: '/api/client/v2/channel/logo' },
  favicon_url: '/api/client/v2/channel/favicon',
}
// 门户页假响应：既含新版结构断言要的「客户端下载」一节，也含品牌名
// （旧脚本的判据是 `'下载客户端' in body or 'PicoAide' in body` —— 让"修复前"的
// 失败**只剩**渠道契约那一条，取证才没有噪音）。
const PORTAL_HTML = '<!doctype html><html><body><h1>PicoAide Harness</h1><h2>客户端下载</h2>'
  + '<a class="dl" href="/updates/client/example.AppImage">下载</a></body></html>'
const LOGIN_FORM_HTML = '<!doctype html><html><body><form method="post" action="/dex/auth/local?req=x">'
  + '<input type="text" name="login"><input type="password" name="password"></form></body></html>'
const APPROVAL_HTML = '<!doctype html><html><body><form method="post" action="/dex/approval?req=x">'
  + '<input type="hidden" name="approve" value="true"></form></body></html>'

/** 读掉请求体（不读会让 keep-alive 请求挂住）。 */
function readBody(req) {
  return new Promise(resolve => {
    let raw = ''
    req.on('data', chunk => { raw += chunk })
    req.on('end', () => resolve(raw))
  })
}

/** 解析 Cookie 头。 */
function cookies(req) {
  const out = {}
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const index = part.indexOf('=')
    if (index > 0) out[part.slice(0, index).trim()] = part.slice(index + 1).trim()
  }
  return out
}

/**
 * 起一个按场景应答的假网关。
 * @param {string} scenario - good | skip | dex-http-deeplink | ldap-legacy-channel | ldap-rbac-fall-open
 * @returns {Promise<{ base: string, close: () => Promise<void> }>} 监听地址与关闭函数。
 */
function startGateway(scenario) {
  const providerConfigured = scenario !== 'skip'
  const server = createServer(async (req, res) => {
    const origin = `http://${req.headers.host}`
    const url = new URL(req.url, origin)
    const path = url.pathname
    const json = (status, payload, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
      res.end(JSON.stringify(payload))
    }
    const html = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(body)
    }
    const redirect = (status, location, headers = {}) => {
      res.writeHead(status, { Location: location, ...headers })
      res.end()
    }
    const cookie = cookies(req)
    const body = await readBody(req)

    if (path === '/healthz') return json(200, { status: 'ok' })
    if (path === '/api/server/admin/auth/methods') {
      return json(200, {
        methods: [
          { name: 'local', configured: true, browser: false, hidden: false },
          { name: 'ldap', configured: providerConfigured, browser: false, hidden: false },
          { name: 'oidc', configured: providerConfigured, browser: true, hidden: false },
        ],
      })
    }

    // ---- 员工面登录（LDAP 用例）----
    if (path === '/api/client/v2/auth/login' && req.method === 'POST') {
      const payload = JSON.parse(body === '' ? '{}' : body)
      if (payload.username === 'alice' && payload.password === 'alice123') {
        return json(200, { token: 'tok-alice', user: { username: 'alice', role: 'user' } })
      }
      if (payload.username === 'audit01') {
        return json(401, { error: { code: 'AUDITOR_NOT_ALLOWED', message: '审计账号不可登录客户端' } })
      }
      return json(401, { error: { code: 'AUTH_FAILED', message: '用户名或密码错误' } })
    }

    // ---- 管理面登录（LDAP 用例）----
    if (path === '/api/server/admin/login' && req.method === 'POST') {
      const payload = JSON.parse(body === '' ? '{}' : body)
      if (payload.username === 'admin' && payload.password === 'admin123456') {
        return json(200, {
          csrf_token: 'csrf-admin',
          user: { username: 'admin', role: 'super_admin', permissions: ['auth:read', 'auth:write', 'user:write'] },
        }, { 'Set-Cookie': [`${SESSION_COOKIE}=sid-admin; Path=/; HttpOnly`] })
      }
      if (payload.username === 'audit01' && payload.password === 'audit12345') {
        return json(200, {
          csrf_token: 'csrf-auditor',
          user: { username: 'audit01', role: 'auditor', permissions: ['audit:read', 'usage:read', 'user:read'] },
        }, { 'Set-Cookie': [`${SESSION_COOKIE}=sid-auditor; Path=/; HttpOnly`] })
      }
      return json(401, { error: { code: 'AUTH_FAILED', message: '用户名或密码错误' } })
    }

    // ---- auditor 读面（audit:read）----
    if (path === '/api/server/admin/audit' && req.method === 'GET') {
      if (cookie[SESSION_COOKIE] === undefined) {
        return json(401, { error: { code: 'AUTH_REQUIRED', message: '未登录' } })
      }
      return json(200, { items: [], total: 0 })
    }

    // ---- 写面（user:write，auditor 没有）：RBAC 与 CSRF 两道闸 ----
    if (path === '/api/server/admin/users' && req.method === 'POST') {
      const session = cookie[SESSION_COOKIE]
      if (session === undefined) return json(401, { error: { code: 'AUTH_REQUIRED', message: '未登录' } })
      const csrf = String(req.headers['x-csrf-token'] ?? '')
      const expected = session === 'sid-admin' ? 'csrf-admin' : 'csrf-auditor'
      if (csrf !== expected) return json(403, { error: { code: 'CSRF_EXPIRED', message: 'CSRF 校验失败' } })
      if (session === 'sid-auditor') {
        // fall-open 场景 = 权限闸门缺失（auditor 的写请求落到 handler）。
        if (scenario === 'ldap-rbac-fall-open') return json(200, { user: { id: 1, username: '' } })
        return json(403, { error: { code: 'FORBIDDEN', message: '没有权限执行该操作' } })
      }
      return json(400, { error: { code: 'VALIDATION', message: '用户名和密码必填' } })
    }

    // ---- 渠道内容（免登录）----
    if (path === '/api/client/v2/channel' && req.method === 'GET') {
      if (scenario === 'ldap-legacy-channel') return json(200, { enabled: false })
      return json(200, CHANNEL_GOOD)
    }

    // ---- 门户首页 ----
    if (path === '/' && req.method === 'GET') return html(200, PORTAL_HTML)

    // ---- OIDC：登录发起 → IdP 登录页 → approve → 回调 → 深链 ----
    if (path === '/api/client/v2/auth/oidc/login' && req.method === 'GET') {
      const state = 'state-' + 'f'.repeat(16)
      return redirect(302, `${origin}/dex/auth/local?req=${state}&state=${state}`, {
        'Set-Cookie': [`${OIDC_STATE_COOKIE}=${state}; Path=/api/client/v2/auth/oidc; HttpOnly`],
      })
    }
    if (path === '/dex/auth/local' && req.method === 'GET') return html(200, LOGIN_FORM_HTML)
    if (path === '/dex/auth/local' && req.method === 'POST') {
      const state = url.searchParams.get('state') ?? url.searchParams.get('req') ?? ''
      return redirect(303, `${origin}/dex/approval?req=${state}&state=${state}`)
    }
    if (path === '/dex/approval' && req.method === 'GET') return html(200, APPROVAL_HTML)
    if (path === '/dex/approval' && req.method === 'POST') {
      const state = url.searchParams.get('state') ?? ''
      return redirect(303, `${origin}/api/client/v2/auth/oidc/callback?code=code-42&state=${state}`)
    }
    if (path === '/api/client/v2/auth/oidc/callback' && req.method === 'GET') {
      const state = url.searchParams.get('state') ?? ''
      if (state === '' || cookie[OIDC_STATE_COOKIE] !== state) {
        return json(400, { error: { code: 'VALIDATION', message: 'state 与登录浏览器不匹配' } })
      }
      if (scenario === 'dex-http-deeplink') {
        // 变异：回调目标不是深链（旧脚本的恒假断言在"正常"场景下也照红，
        // 这里换成"真契约被破坏"的形态 ⇒ 新判据必须咬住）。
        return redirect(302, `${origin}/not-a-deep-link?token=${DEEP_LINK_TOKEN}`)
      }
      return redirect(302, `picoaide://auth?token=${DEEP_LINK_TOKEN}&user=admin`)
    }
    if (path === '/api/client/v2/auth/me' && req.method === 'GET') {
      const bearer = String(req.headers.authorization ?? '')
      if (bearer !== `Bearer ${DEEP_LINK_TOKEN}`) {
        return json(401, { error: { code: 'AUTH_REQUIRED', message: '未认证' } })
      }
      return json(200, { user: { username: 'admin', email: 'admin@example.com', role: 'user' } })
    }

    return json(404, { error: { code: 'NOT_FOUND', message: `未实现的假网关路由 ${req.method} ${path}` } })
  })
  return new Promise((resolvePromise, rejectPromise) => {
    server.on('error', rejectPromise)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolvePromise({
        base: `http://127.0.0.1:${port}`,
        close: () => new Promise(done => server.close(() => done())),
      })
    })
  })
}

/** 场景表：每个场景断言"谁是主角、期望退出码、输出里必须/不得出现什么"。 */
/** 主流程：语法闸门 → 判据自检 → 假网关正/反例。返回 0/1。 */
async function main() {
// ---------------------------------------------------------------------------
// 0. 用例登记制 + 聚合层双向对账（第十三轮审计 F-02 / F-03，P1）
//
// 现场（两条都在本轮实测可复跑）：
//   · F-02：删掉 `run-all.sh` 里两个 `.py` 的调用行 ⇒ 门禁 `EXIT=0`
//           （只有 `electron-shots` 的接线被钉住 —— 同一个文件里的两种接线，只有一种有判据）；
//   · F-03：新增一个必然 `exit 77` 的用例（或恒真断言用例）并接进 `run-all.sh` ⇒ `EXIT=0`，
//           还会计进"3 个 Python 用例语法通过"。删掉已登记用例反而红
//           ⇒ 这个面**只有"减少"有判据、"增加"没有**。
//
// 处置：登记表（`INTEGRATION_ENTRIES`）+ **双向**对账 —— 登记了却不在 ⇒ 红、
// 在却没登记 ⇒ 红、聚合层少调/多调/顺序不对 ⇒ 红。
// ---------------------------------------------------------------------------
{
  const registered = new Map(INTEGRATION_ENTRIES.map(entry => [entry.path, entry]))
  check(registered.size === INTEGRATION_ENTRIES.length,
    '登记表 INTEGRATION_ENTRIES 里有重复路径 —— 登记值必须一一对应')
  // 聚合层解析器自己的能力自检（V13-C R-5 的回归判据；真仓三条接线恰好都带尾参，
  // 不跑这一条的话"正则改回 `\s`"在真仓上不可见）。
  aggregateParserSelfTest()

  // ① 登记了却不在磁盘上 ⇒ 红（"登记表指向一个已经不存在的用例"）。
  for (const entry of INTEGRATION_ENTRIES) {
    check(existsSync(join(ROOT, entry.path)),
      `形态⑦: 登记表里的 ${entry.path}（角色 ${entry.role}）在磁盘上不存在 —— `
      + '登记了却不在 ⇒ 红（先删登记项，或把用例补回来）')
  }

  // ② 在磁盘上却没登记 ⇒ 红（"新增用例不登记"的现场形态）。
  const integrationDir = join(ROOT, 'integration-tests')
  /** 递归收集登记面内的全部文件（扩展名见 INTEGRATION_SCANNED_EXTENSIONS）。 */
  const walkRegistered = dir => {
    const out = []
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '__pycache__' || entry === '.git') continue
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) out.push(...walkRegistered(path))
      else if (INTEGRATION_SCANNED_EXTENSIONS.some(ext => entry.endsWith(ext))) out.push(relative(ROOT, path))
    }
    return out
  }
  const onDisk = (existsSync(integrationDir) ? walkRegistered(integrationDir) : []).sort()
  const unregistered = onDisk.filter(path => !registered.has(path))
  check(unregistered.length === 0,
    `形态⑦: integration-tests/ 下这些可执行体没有登记（角色）: ${unregistered.join(', ')}`
      + '\n  ⇒ 新增用例**必须**在 scripts/check-integration-tests.mjs 的 INTEGRATION_ENTRIES 里登记'
      + '（登记值进 diff 才会被评审看见；"新增用例不登记"正是第十三轮 F-03 的假绿通道）')
  const staleEntries = [...registered.keys()].filter(path => !onDisk.includes(path)).sort()
  check(staleEntries.length === 0,
    `形态⑦: 登记表里这些条目不在扫描面内（扩展名不在 ${INTEGRATION_SCANNED_EXTENSIONS.join('/')} 里？）: `
      + `${staleEntries.join(', ')}`)

  // ②b **引用面 ↔ 判据面的扩展名对账**（第十四轮 lane B 的 B-04，P2）。
  //
  // `check-install-integrity.mjs` 从**本守卫的文本**抽"它 spawn/枚举的目标"，再用
  // `INTEGRATION_SCANNED_EXTENSIONS` 过滤 ⇒ 在本守卫里引用一个扩展名在面外的路径
  // （`integration-tests/x.ts` 并让它真的存在）时，那个文件既不进语法面、也不进执行体全集，
  // 而 `check-install-integrity` 照旧 `VERDICT PASS`。收口：本守卫自己判"我引用的每个
  // 落盘路径，要么扩展名在扫描面内，要么逐条登记为非判据面（见
  // {@link INTEGRATION_REFERENCE_SCOPE_REGISTRY}）"。
  integrationReferenceScopeSelfTest()
  {
    const scope = integrationReferenceScope(readFileSync(fileURLToPath(import.meta.url), 'utf8'), {
      exists: path => existsSync(join(ROOT, path)),
      registry: INTEGRATION_REFERENCE_SCOPE_REGISTRY,
    })
    check(scope.unregistered.length === 0,
      `形态⑩: 本守卫引用了这些 \`integration-tests/**\` 路径，它们的扩展名不在扫描面 `
        + `（${INTEGRATION_SCANNED_EXTENSIONS.join('/')}）内、也没有在 `
        + `INTEGRATION_REFERENCE_SCOPE_REGISTRY 里登记：${scope.unregistered.join(', ')}`
        + '\n  ⇒ 这类路径既不在语法闸门里、也不在 `check-install-integrity` 的执行体全集里'
        + '（它的派生面就是按这份扩展名集合过滤的）—— "引用了却没人判"的静默缺口。'
        + '\n     两条出路：① 把该扩展名纳入扫描面（同时进 INTEGRATION_ENTRIES 登记制与语法闸门）；'
        + '\n     ② 在本表登记它是**非判据面**的引用（纯资源/图片夹具），并写明理由。')
    check(scope.deadEntries.length === 0,
      `形态⑩: 这些登记项在本守卫的正文里已经不再被引用（死条目）：${scope.deadEntries.join(', ')}`
        + ' —— 登记表比实际引用面宽，同样是"自述与事实不一致"')
    notes.push(`integration-tests 引用面: 落盘引用 ${scope.present.length} 条、`
      + `面外登记 ${INTEGRATION_REFERENCE_SCOPE_REGISTRY.length} 条、`
      + `扩展名全部落在判据面（${INTEGRATION_SCANNED_EXTENSIONS.join('/')}）或已登记 ✓`)
  }

  // ③ 聚合层双向对账：`run-all.sh` 的 `run "<名>" <runner> <路径>` 行 ↔ 登记表里
  //    带 aggregateName 的条目（顺序也钉住 —— 顺序变了同样是"聚合层被改过"）。
  const runner = existsSync(join(ROOT, 'integration-tests', 'run-all.sh'))
    ? readFileSync(join(ROOT, 'integration-tests', 'run-all.sh'), 'utf8')
    : ''
  // 允许路径之后还有额外实参（`"$SERVER_BASE"` 这类）；最少三段：名字 / runner / 路径。
  // 解析口径见 `AGGREGATE_RUN_LINE`（`\s` 吃换行的缺陷已收紧，并带回归自检）。
  const aggregateLines = parseAggregateRuns(runner)
  const expectedAggregate = INTEGRATION_ENTRIES
    .filter(entry => typeof entry.aggregateName === 'string')
    .map(entry => ({ name: entry.aggregateName, runner: entry.runner, path: entry.aggregatePath }))
  check(aggregateLines.length === expectedAggregate.length,
    `形态⑦: run-all.sh 里有 ${aggregateLines.length} 条 \`run "…"\` 调用，登记表要求 `
      + `${expectedAggregate.length} 条 —— 聚合层的接线数与登记值不一致`
      + `\n  实际:${aggregateLines.map(line => line.path).join(', ') || '(空)'}`
      + `\n  登记:${expectedAggregate.map(line => line.path).join(', ') || '(空)'}`)
  for (const [index, expected] of expectedAggregate.entries()) {
    const actual = aggregateLines[index]
    if (actual === undefined) {
      fail(`形态⑦: run-all.sh 缺少第 ${index + 1} 条接线 —— 必须逐字是 `
        + `\`run "${expected.name}" ${expected.runner} ${expected.path}\``
        + '\n  ⇒ 两个 .py 从聚合层摘线此前**零判据**（F-02），现在少一条、改一行、换顺序都红')
      continue
    }
    check(actual.name === expected.name && actual.runner === expected.runner && actual.path === expected.path,
      `形态⑦: run-all.sh 第 ${index + 1} 条接线与登记值不一致`
        + `\n  实际:run "${actual.name}" ${actual.runner} ${actual.path}`
        + `\n  登记:run "${expected.name}" ${expected.runner} ${expected.path}`)
  }
  // ④ 反向：聚合层里出现的调用必须都能在登记表里找到（"在却没登记"）。
  for (const line of aggregateLines) {
    const matched = expectedAggregate.some(expected => expected.path === line.path
      && expected.runner === line.runner && expected.name === line.name)
    check(matched,
      `形态⑦: run-all.sh 调用了未登记的 \`${line.runner} ${line.path}\` —— `
      + '聚合层里出现的调用必须都能在 INTEGRATION_ENTRIES 里找到（否则它是个没人管的用例）')
  }

  // ⑤ contract-test 的三个入口必须真的存在（登记角色 = 承诺）。
  for (const entry of INTEGRATION_ENTRIES.filter(item => item.role === 'contract-test')) {
    const source = readFileSync(join(ROOT, entry.path), 'utf8')
    for (const [flag, why] of [
      ['--self-test', '判据本体自证（每条判据的正/负例夹具）'],
      ['--self-check', '判定通道自证（全部夹具经运行期 report() 求值）'],
      ['--dump-criteria', '判据表登记值（供本守卫做精确 id 集合与逐 id 条数对账）'],
    ]) {
      check(source.includes(flag), `形态⑦: ${entry.path}（contract-test）必须实现 ${flag} —— ${why}`)
    }
  }
  notes.push(`登记制: ${onDisk.length} 个可执行体全部登记、聚合层 ${aggregateLines.length} 条接线双向对账 ✓`)

  // -------------------------------------------------------------------------
  // ⑥ **判别力下限 + SKIP 原因码登记制**（第十三轮 V13-C R-2）
  //
  // 现场（探针 `p07d`，V13-C 实跑 `EXIT=0`）：新增 `integration-tests/extra/always-skip.py`
  // —— 打印一句 `SKIP: 环境缺失` 就 `sys.exit(77)`，**什么都不验** —— 只要在
  // `INTEGRATION_ENTRIES` 里登记成 `role: 'fixture'`（并在 `run-all.sh` 里接一条线），
  // 旧登记制就照报「9 个可执行体全部登记、聚合层 4 条接线双向对账 ✓」并 `EXIT=0`：
  // `fixture` 这个角色当时**零角色要求**。也就是说 F-03 的修法拿到的是"可见性"而不是"阻止"。
  //
  // 现在两条结构性判据（都能被打坏 —— 变异证据见报告 §H2）：
  //   · **接进聚合层 = 必须提供判定**：`aggregateName` 只允许出现在 `JUDGMENT_BEARING_ROLES`
  //     的角色上，且 `minJudgments` 必须与该腿**自己的机器可读判定清单**逐数相等；
  //   · **SKIP 必须具名**：原因码闭集 + 声明/使用双向对账 + 唯一出口 + 真跑一次。
  // -------------------------------------------------------------------------
  const expectedAggregateByPath = new Map(expectedAggregate.map(entry => [entry.path, entry]))
  for (const entry of INTEGRATION_ENTRIES) {
    const wired = typeof entry.aggregateName === 'string'
    const label = `${entry.path}（角色 ${entry.role}）`

    // ---- ⑥a 角色 ↔ 判别力 ------------------------------------------------
    if (wired) {
      check(JUDGMENT_BEARING_ROLES.has(entry.role),
        `形态⑥: ${label} 接进了聚合层，但它的角色不提供判定清单（可判定的角色只有 `
          + `${[...JUDGMENT_BEARING_ROLES].join(' / ')}）`
          + '\n  ⇒ "登记齐、顺序对、但恒 SKIP（什么都验不了）"的新用例在旧实现里是一条'
          + ' `EXIT=0` 的通道（V13-C 探针 p07d）：`fixture` 零角色要求。'
          + '零判定的东西不得出现在聚合层 —— 真要跑它，就给它一份判定清单并把 `minJudgments` 写进登记表。')
      check(Number.isInteger(entry.minJudgments) && entry.minJudgments > 0,
        `形态⑥: ${label} 接进了聚合层却没有 \`minJudgments\`（运行期非 SKIP 判定条数下限，正整数）`
          + ' —— 没有下限的接线等于"跑不跑、验没验都不影响门禁"')
    } else {
      check(entry.minJudgments === undefined,
        `形态⑥: ${label} 没有接进聚合层却声明了 \`minJudgments\` —— 判定条数只能来自聚合层里真的跑起来的腿`)
    }

    const entrySource = existsSync(join(ROOT, entry.path)) ? readFileSync(join(ROOT, entry.path), 'utf8') : ''
    const declaredSkip = Array.isArray(entry.skipReasons) ? entry.skipReasons : null
    check(declaredSkip !== null,
      `形态⑥: ${label} 缺 \`skipReasons\`（数组；不能 SKIP 的腿写 \`[]\`）`
        + ' —— 原因码清单必须进登记表才可能被评审看见')
    if (declaredSkip === null) continue
    check(new Set(declaredSkip).size === declaredSkip.length,
      `形态⑥: ${label} 的 \`skipReasons\` 有重复项：${declaredSkip.join(', ')}`)
    for (const code of declaredSkip) {
      check(SKIP_REASON_CODES.has(code),
        `形态⑥: ${label} 声明了**未登记**的 SKIP 原因码 ${JSON.stringify(code)}`
          + `\n  ⇒ 已登记的原因码：${[...SKIP_REASON_CODES.keys()].join(', ')}`
          + '（新增原因码必须同时进 SKIP_REASON_CODES 并写明含义 —— 否则它是无记名免检牌）')
    }

    if (declaredSkip.length === 0) {
      // 不声明任何原因码 = 这条腿**不得**打 SKIP（少了这一条，新增的夹具/通道类条目
      // 仍可以偷偷 `exit 77` 混过聚合层）。
      const stray = sourceCodeLines(entrySource).filter(line => line.includes('SKIP[') || /SKIP:(?!\])/u.test(line))
      check(stray.length === 0,
        `形态⑥: ${label} 没有声明任何 SKIP 原因码，代码里却有 SKIP 输出：`
          + `${stray.map(line => JSON.stringify(line.trim().slice(0, 120))).join(' | ')}`
          + '\n  ⇒ 要么给它登记原因码（`skipReasons` + 源码里的 `SKIP_REASONS`），要么别打 SKIP')
      continue
    }

    // ---- ⑥b 源码声明 ↔ 登记表（双向逐字） -------------------------------
    const codeLines = sourceCodeLines(entrySource)
    const declaredInSource = skipReasonsFromSource(codeLines.join('\n'))
    check(declaredInSource !== null,
      `形态⑥: ${label} 在登记表里声明了 SKIP 原因码，源码里却没有 \`SKIP_REASONS\` 声明`
        + `（登记：${declaredSkip.join(', ')}）—— SKIP 原因码必须由脚本自己声明，`
        + '否则"打的是哪个原因"只存在于守卫的登记表里，脚本怎么改都不会红')
    if (declaredInSource !== null) {
      const sorted = values => [...values].sort().join(',')
      check(sorted(declaredInSource) === sorted(declaredSkip),
        `形态⑥: ${label} 的 SKIP 原因码声明与登记表不一致`
          + `\n  源码:${sorted(declaredInSource) || '(空)'}\n  登记:${sorted(declaredSkip) || '(空)'}`)
    }

    // ---- ⑥c 唯一出口 + 无裸 SKIP ----------------------------------------
    const outlet = entry.skipOutlet
    check(typeof outlet === 'string' && outlet !== '',
      `形态⑥: ${label} 声明了 SKIP 原因码却没有 \`skipOutlet\`（唯一出口的函数名）`
        + ' —— 没有唯一出口就无法保证"原因码必须登记"这件事在运行期成立')
    const outlets = codeLines.filter(line => line.includes('SKIP['))
    check(outlets.length === 1,
      `形态⑥: ${label} 的代码里有 ${outlets.length} 处 \`SKIP[\` —— 必须恰好 1 处（唯一出口）`
        + `\n  实际:${outlets.map(line => line.trim().slice(0, 120)).join(' | ') || '(空)'}`)
    const bareSkip = codeLines.filter(line => /SKIP:(?!\])/u.test(line))
    check(bareSkip.length === 0,
      `形态⑥: ${label} 里出现了**不带原因码**的 \`SKIP:\` 输出：`
        + `${bareSkip.map(line => JSON.stringify(line.trim().slice(0, 120))).join(' | ')}`
        + '\n  ⇒ 未登记的原因（含"什么都不说"）不得成为免检牌；所有 SKIP 必须经唯一出口带上登记过的原因码')
    if (typeof outlet === 'string' && outlet !== '') {
      const used = [...entrySource.matchAll(new RegExp(`\\b${outlet}\\(\\s*'([a-z][a-z-]*)'`, 'gu'))]
        .map(match => match[1])
      const usedSet = [...new Set(used)]
      const sorted = values => [...values].sort().join(',')
      check(sorted(usedSet) === sorted(declaredSkip),
        `形态⑥: ${label} 的 SKIP 调用点原因码与登记表不一致（双向：声明了没用 / 用了没声明 都红）`
          + `\n  调用点:${sorted(usedSet) || '(空)'}\n  登记:${sorted(declaredSkip) || '(空)'}`)
      const guardLines = codeLines.filter(line => line.includes('SKIP_REASONS'))
      check(guardLines.length >= 2,
        `形态⑥: ${label} 声明了 SKIP_REASONS 却只有 ${guardLines.length} 处代码引用它`
          + ' —— 出口必须拿它做校验（未登记的原因码要在运行期就被拒，而不是只写在注释里）')
    }
    notes.push(`${entry.path.split('/').pop()}: SKIP 原因码 ${declaredSkip.join('/')} 声明/使用/唯一出口双向对账 ✓`)
  }

  // ---- ⑥d 组级判别力下限 ------------------------------------------------
  const groupJudgments = INTEGRATION_ENTRIES
    .filter(entry => typeof entry.aggregateName === 'string' && Number.isInteger(entry.minJudgments))
    .reduce((sum, entry) => sum + entry.minJudgments, 0)
  check(groupJudgments >= GROUP_MIN_JUDGMENTS,
    `形态⑥: 聚合层的判定条数下限合计 ${groupJudgments} 条 < 登记下限 ${GROUP_MIN_JUDGMENTS} 条`
      + ' —— 判据被删/被换成恒 SKIP（棘轮只允许被"变多"越过；真要下调必须同时改 '
      + 'GROUP_MIN_JUDGMENTS 并写明理由）')

  // ---- ⑥e 角色 ↔ 门禁的判据面（不许"新登记一条腿就绕开门禁"）----------
  const contractEntries = INTEGRATION_ENTRIES.filter(entry => entry.role === 'contract-test')
  check(contractEntries.map(entry => entry.path).sort().join(',') === CONTRACT_TESTS.map(test => test.path).sort().join(','),
    '形态⑥: `role: contract-test` 的登记项与门禁的 `CONTRACT_TESTS`（判据面）不是同一集合'
      + `\n  登记:${contractEntries.map(entry => entry.path).join(', ')}`
      + `\n  判据面:${CONTRACT_TESTS.map(test => test.path).join(', ')}`
      + '\n  ⇒ 新增一条 contract-test 必须同时在 CONTRACT_TESTS 里登记它的判据面'
      + '（否则这条腿只是"登记了"却在门禁里零判据）')
  for (const entry of contractEntries) {
    const test = CONTRACT_TESTS.find(candidate => candidate.path === entry.path)
    const registryRows = test === undefined ? [] : (CONTRACT_CRITERIA.get(test.id) ?? [])
    check(entry.minJudgments === registryRows.length,
      `形态⑥: ${entry.path} 的 \`minJudgments\`=${entry.minJudgments}，而判据表登记 ${registryRows.length} 条判据`
        + ' —— 判别力下限必须与判据表逐数相等（`--dump-criteria` 已另行与登记值对账）')
  }
  for (const entry of INTEGRATION_ENTRIES.filter(item => item.role === 'judged-runner')) {
    const table = entry.assertionTable ?? 'integration-tests/electron-shots/assertions.mjs'
    let count = null
    try {
      const mod = await import(pathToFileURL(join(ROOT, table)).href)
      count = Array.isArray(mod?.SHOTS_ASSERTIONS) ? mod.SHOTS_ASSERTIONS.length : null
    } catch (err) {
      fail(`形态⑥: ${entry.path}（judged-runner）的判据表 ${table} 读不出来（${err?.message ?? err}）`
        + ' —— 判据条数不可见时不得把这条腿算进判别力下限')
    }
    if (count !== null) {
      check(entry.minJudgments === count,
        `形态⑥: ${entry.path} 的 \`minJudgments\`=${entry.minJudgments}，而判据表 ${table} 有 ${count} 条判据`
          + ' —— 判别力下限必须与判据表逐数相等（改判据表必须同步登记值）')
    }
  }
  notes.push(`判别力下限: 聚合层 ${groupJudgments} 条判定（下限 ${GROUP_MIN_JUDGMENTS}）、`
    + `SKIP 原因码闭集 ${SKIP_REASON_CODES.size} 个 ✓`)
}

/**
 * 取"代码行"（丢掉整行注释）—— 供 SKIP 出口 / 裸 `SKIP:` 的静态扫描用。
 *
 * 为什么必须丢注释：三个腿的**文档块**里就有 `SKIP: 前置环境缺失` 这类示例（它们正是
 * "原因码此前无登记"的历史写法）；把注释算进去会让判据对着文档打架。
 * @param source - 文件全文。
 * @returns 去掉整行注释后的行数组。
 */
function sourceCodeLines(source) {
  return source.split('\n').filter(line => !/^\s*(?:#|\/\/|\*|\/\*)/u.test(line))
}

/**
 * 从腿自己的源码里取它声明的 SKIP 原因码（`SKIP_REASONS = ('a', 'b')` / `= ['a', 'b']`）。
 * @param source - 文件全文。
 * @returns 原因码数组；没有这一行时返回 `null`（调用方据此 fail-loud）。
 */
function skipReasonsFromSource(source) {
  const match = /SKIP_REASONS\s*=\s*[[(]([^\])]*)[\])]/u.exec(source)
  if (match === null) return null
  return [...match[1].matchAll(/'([a-z][a-z-]*)'|"([a-z][a-z-]*)"/gu)].map(item => item[1] ?? item[2])
}

// ---------------------------------------------------------------------------
// 1. 语法闸门：integration-tests 下所有 .py 必须能解析
// ---------------------------------------------------------------------------
/** 递归列出目录下的 `*.py`（相对 ROOT，POSIX 分隔）。 */
function pythonFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__pycache__' || entry === '.git') continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) out.push(...pythonFiles(path))
    else if (entry.endsWith('.py')) out.push(relative(ROOT, path))
  }
  return out.sort()
}

const pyFiles = existsSync(join(ROOT, 'integration-tests')) ? pythonFiles(join(ROOT, 'integration-tests')) : []
if (pyFiles.length === 0) {
  fail('integration-tests/ 下一个 .py 都没有 —— 扫描面为 0，拒绝以"无可检查"当通过')
}
for (const file of pyFiles) {
  const parsed = spawnSync('python3', [
    '-c',
    'import ast,sys;ast.parse(open(sys.argv[1],encoding="utf-8").read(),filename=sys.argv[1])',
    join(ROOT, file),
  ], { encoding: 'utf8' })
  if (parsed.error !== undefined || parsed.status !== 0) {
    fail(`${file}: Python 语法解析失败（${parsed.error?.message ?? parsed.stderr?.trim().slice(0, 200)}）`)
  }
}

// ---------------------------------------------------------------------------
// 1b. 语法闸门：integration-tests 下所有 .mjs（六处形态⑤）
//
// 第三个集成脚本 `electron-shots.mjs` 在 2026-09-23 之前**没有任何自动化覆盖**：
// 它要打包产物 + Xvfb + CDP，谁也不会顺手跑；语法/接线一坏就烂在那里（本轮实测它
// 的 `--server` 缺值会静默变成 `undefined`）。这里先补最便宜的一层：`node --check`。
// ---------------------------------------------------------------------------

/** 递归列出目录下的 `*.mjs`（相对 ROOT，POSIX 分隔）。 */
function moduleFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__pycache__' || entry === '.git') continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) out.push(...moduleFiles(path))
    else if (entry.endsWith('.mjs')) out.push(relative(ROOT, path))
  }
  return out.sort()
}

const mjsFiles = existsSync(join(ROOT, 'integration-tests')) ? moduleFiles(join(ROOT, 'integration-tests')) : []
if (mjsFiles.length === 0) {
  fail('integration-tests/ 下一个 .mjs 都没有 —— 扫描面为 0，拒绝以"无可检查"当通过')
}
for (const file of mjsFiles) {
  const parsed = spawnSync(process.execPath, ['--check', join(ROOT, file)], { encoding: 'utf8' })
  if (parsed.status !== 0) {
    fail(`${file}: Node 语法解析失败（${(parsed.stderr ?? '').trim().split('\n').slice(0, 3).join(' / ')}）`)
  }
}

// ---------------------------------------------------------------------------
// 1c. electron-shots 的**接线**与 **SKIP 语义**（六处形态⑤⑥）
//
// 判据分三层：① `run-all.sh` 必须真的调用它（否则"接线"只是文件存在）；
// ② 脚本里必须有可判定的断言与退出码契约（截图非空、失败非零、缺前置 77）；
// ③ 缺前置时**真的**以 77 退出且不打印 PASS（端到端跑一次，用不存在的 --app 驱动）。
// ---------------------------------------------------------------------------

{
  const runnerPath = join(ROOT, 'integration-tests', 'run-all.sh')
  const shotsPath = join(ROOT, 'integration-tests', 'electron-shots', 'electron-shots.mjs')
  check(existsSync(shotsPath), '形态⑤: integration-tests/electron-shots/electron-shots.mjs 必须存在')
  const runner = existsSync(runnerPath) ? readFileSync(runnerPath, 'utf8') : ''
  check(runner.includes('electron-shots/electron-shots.mjs'),
    '形态⑤: run-all.sh 必须真的调用 electron-shots/electron-shots.mjs（"接线"不是"文件存在"）')
  check(/electron-shots[^\n]*\|[^\n]*77|77\)[^\n]*electron/u.test(runner) || runner.includes('77'),
    '形态⑥: run-all.sh 必须把 77 当 SKIP 记账（聚合层退出码契约）')

  const source = existsSync(shotsPath) ? readFileSync(shotsPath, 'utf8') : ''
  // 说明(2026-09-23 第四轮审计 R4-A-17):`size > 1000` 这条 **needle 已被更强的语义判据
  // 取代** —— 截图非空的下界现在住在判据表(assertions.mjs)里,由 `--self-test` 的负例
  // (0 B / 500 B / 尺寸不可读)证明它真的会拒。needle 只能证明"文件里有这句话",而它是
  // 本轮审计判定"判别力止于字面量"的那一条,所以这里**升级**而不是删除(判别力变强)。
  for (const [needle, why] of [
    ['Page.captureScreenshot', '截图必须真的抓帧（而不是只 console.log）'],
    ['RESULT: FAIL', '断言失败必须以 RESULT: FAIL 收尾'],
    ['EXIT_SKIP', '缺前置必须走显式 SKIP(77) 而不是 FAIL(1)'],
    ['./assertions.mjs', '判据必须来自共用的判据表（运行期与门禁同一份）'],
  ]) {
    check(source.includes(needle), `形态⑤: electron-shots 必须保留「${why}」（找不到 ${JSON.stringify(needle)}）`)
  }

  // 端到端：`--app` 指向不存在的路径 ⇒ SKIP(77) 且不得打印 PASS。
  const skipRun = spawnSync(process.execPath, [shotsPath, '--app', join(tempDir('shots-skip-'), 'no-such-app'), '--shots', tempDir('shots-out-')], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, DISPLAY: '' },
  })
  const skipOutput = `${skipRun.stdout ?? ''}${skipRun.stderr ?? ''}`
  check(skipRun.status === 77, `形态⑥: 缺打包产物必须 exit 77(SKIP)（实际 ${skipRun.status}）：${skipOutput.slice(0, 200)}`)
  check(skipOutput.includes('SKIP'), `形态⑥: 必须打印 SKIP 原因，实际 ${JSON.stringify(skipOutput.slice(0, 200))}`)
  // SKIP 必须**具名**（V13-C R-2）：原因码来自登记闭集，且必须是这个触发条件对应的那一个。
  check(skipOutput.includes('SKIP[missing-app]:'),
    `形态⑧: 缺打包产物的 SKIP 必须带登记过的原因码 \`SKIP[missing-app]:\`（V13-C R-2：无记名的 `
      + `\`SKIP:\` 是免检牌），实际 ${JSON.stringify(skipOutput.split('\n').find(line => line.includes('SKIP'))?.slice(0, 200))}`)
  check(!skipOutput.includes('RESULT: PASS'), `形态⑥: SKIP 时不得打印 RESULT: PASS，实际 ${JSON.stringify(skipOutput.slice(0, 200))}`)

  // 端到端：未知参数 ⇒ 用法错误 2（不要让它变成"静默用默认值跑下去"）。
  const usageRun = spawnSync(process.execPath, [shotsPath, '--definitely-unknown'], { cwd: ROOT, encoding: 'utf8' })
  check(usageRun.status === 2, `形态⑤: 未知参数必须 exit 2（实际 ${usageRun.status}）`)
}

// ---------------------------------------------------------------------------
// 1c-2. electron-shots 的**判据表**必须真的在判（第四轮审计 R4-A-17 / R4-A-18）
//
// 现场:`electron-shots.mjs` 的 8 条运行期断言**零守卫覆盖** —— 把
// `check('Step2 品牌 Acme AI', brand === true)` 改成 `check('Step2 品牌 Acme AI', true)`
// (4 个 needle 字面量全部保留)之后,本守卫仍然 **EXIT=0**;而同一处断言还钉着已退役的
// 旧品牌夹具 `Acme AI`(当前实现渲染服务端渠道的 `login.display_name`,回落 `PicoAide`)
// ⇒ 在今天的正确环境里**永远不可能 PASS**。
//
// 处置(三层,缺一不可):
//   ① **判据本体外置**到 `integration-tests/electron-shots/assertions.mjs`,运行期脚本按 id
//      求值同一张表 ⇒ 判据只有一份,掏空判据 = 掏空两边;
//   ② **逐条判据配正例 + 负例夹具**,由本守卫真跑 `--self-test`(与两个 `.py` 同一套口径:
//      夹具条数对账 + 负例不被拒即红)⇒ "把判据改成常量"在负例上当场红;
//   ③ **接线判据**:运行期脚本必须逐条引用表里的每个 id(表里加判据但运行期不判 ⇒ 红),
//      且不得自带常量真判据(`check(x, true)` / `report(id, { ok: true })` 这类形态)。
// ---------------------------------------------------------------------------

{
  const tablePath = join(ROOT, 'integration-tests', 'electron-shots', 'assertions.mjs')
  const shotsPath = join(ROOT, 'integration-tests', 'electron-shots', 'electron-shots.mjs')
  check(existsSync(tablePath), '形态⑤: integration-tests/electron-shots/assertions.mjs（判据表）必须存在')
  const table = existsSync(tablePath) ? await import(pathToFileURL(tablePath).href) : null
  const assertions = Array.isArray(table?.SHOTS_ASSERTIONS) ? table.SHOTS_ASSERTIONS : []
  const fixtures = Array.isArray(table?.SELF_TEST_FIXTURES) ? table.SELF_TEST_FIXTURES : []
  check(assertions.length >= 8,
    `形态⑤: 判据表必须至少 8 条判据（原运行期有 8 条 check;实际 ${assertions.length} 条 ⇒ 判据被删到没有判别力）`)
  const ids = assertions.map(assertion => assertion?.id)
  check(new Set(ids).size === ids.length, `形态⑤: 判据 id 必须唯一（实际 ${ids.join(', ')}）`)
  // 登记值对账（精确集合相等）：删判据 / 改名 / 换表都会红。
  const observedIds = [...new Set(ids)].filter(id => typeof id === 'string').sort()
  check(observedIds.join(',') === [...ELECTRON_SHOTS_EXPECTED_ASSERTIONS].sort().join(','),
    '形态⑤: 判据表的 id 集合与登记值不一致'
      + `\n  实际:${observedIds.join(', ') || '(空)'}`
      + `\n  登记:${[...ELECTRON_SHOTS_EXPECTED_ASSERTIONS].sort().join(', ')}`
      + '\n  ⇒ 改判据表必须同步 check-integration-tests.mjs 的登记清单（登记值进 diff 才会被评审看见）')
  for (const assertion of assertions) {
    check(typeof assertion?.id === 'string' && assertion.id !== '' && typeof assertion?.evaluate === 'function',
      `形态⑤: 判据 ${JSON.stringify(assertion?.id)} 必须形如 { id, name, evaluate() }`)
    const cases = fixtures.filter(fixture => fixture?.id === assertion?.id)
    check(cases.some(fixture => fixture.expect === true), `形态⑤: 判据 ${assertion?.id} 缺**正例**夹具`)
    check(cases.some(fixture => fixture.expect === false),
      `形态⑤: 判据 ${assertion?.id} 缺**负例**夹具 —— 没有负例就无法区分"还在判"和"恒真"`)
  }
  check(fixtures.length >= assertions.length * 2,
    `形态⑤: 夹具条数必须 ≥ 判据数 × 2（正例 + 负例;实际 ${fixtures.length} 条 / ${assertions.length} 条判据）`)
  check(fixtures.length >= ELECTRON_SHOTS_MIN_FIXTURES,
    `形态⑤: 夹具只剩 ${fixtures.length} 条（下限 ${ELECTRON_SHOTS_MIN_FIXTURES}）⇒ 夹具被删到没有判别力；`
      + '确实要下调请同时改 ELECTRON_SHOTS_MIN_FIXTURES 并写明理由')

  // 端到端跑自检(与两个 .py 的 --self-test 同一套解析口径)。
  const selfTest = spawnSync(process.execPath, [tablePath, '--self-test'], { cwd: ROOT, encoding: 'utf8' })
  const selfTestOutput = `${selfTest.stdout ?? ''}${selfTest.stderr ?? ''}`
  check(selfTest.status === 0,
    `形态⑤: assertions.mjs --self-test 必须 exit 0（实际 ${selfTest.status}）：${selfTestOutput.trim().slice(-400)}`)
  const summary = /self-test: (\d+)\/(\d+) 条判据夹具符合预期/u.exec(selfTestOutput)
  if (summary === null) {
    fail(`形态⑤: assertions.mjs --self-test 没有打印夹具汇总结论（判据数量不可见）：${selfTestOutput.trim().slice(-200)}`)
  } else {
    const [, ok, total] = summary.map(Number)
    check(ok === total, `形态⑤: assertions.mjs --self-test: ${ok}/${total} —— 有判据夹具不符合预期（判据被改成常量?）`)
    check(total === fixtures.length,
      `形态⑤: --self-test 实跑 ${total} 条夹具,而判据表登记 ${fixtures.length} 条 ⇒ 有夹具没被跑（自检被掏空）`)
    notes.push(`electron-shots 判据表: --self-test ${ok}/${total} 条夹具、${assertions.length} 条判据`)
  }

  // 接线:运行期脚本必须逐条引用表里的 id,且不得自带常量真判据。
  const shotsSource = existsSync(shotsPath) ? readFileSync(shotsPath, 'utf8') : ''
  for (const id of ids) {
    check(typeof id === 'string' && shotsSource.includes(id),
      `形态⑤: electron-shots.mjs 没有引用判据 ${JSON.stringify(id)} ⇒ 表里声明了但运行期不判(掏空的另一种写法)`)
  }
  const constantJudge = /(?:check|report)\(\s*(?:'[^']*'|"[^"]*"|[A-Za-z_$][\w$]*)\s*,\s*(?:true|false)\b/u.exec(shotsSource)
  check(constantJudge === null,
    '形态⑤: electron-shots.mjs 里出现了**常量真/假判据**'
      + `（${JSON.stringify(constantJudge?.[0])}）—— 这正是 R4-A-17 的现场形态(断言永远成立)`)

  // -------------------------------------------------------------------------
  // 1c-3. **运行期真的按表判**（2026-09-23 第五轮审计 R5-D / R4-A N7）
  //
  // 现场:判据表外置之后,"运行期有没有真的按表判"仍只是 `electron-shots.mjs` 里的
  // 一段可变代码。把 `report()` 内部改成 `const { ok, detail } = { ok: true, … }`
  // (9 处 id 引用一字未改)⇒ 本守卫 EXIT=0、`--self-test 29/29` 照旧。
  //
  // 处置(两层):
  //   ① 判定与失败计数**下沉**到 `integration-tests/electron-shots/report.mjs`;
  //      运行期脚本只接线(`const report = (id, obs) => reporter.report(id, obs)`)。
  //   ② **端到端夹具**:运行期脚本新增 `--self-check`,把全部夹具经**同一条 report()
  //      路径**求值(不需要 app/X/服务端)。本守卫真跑它,并在**变异副本**上复跑:
  //      把 `report()` 掏成恒真 ⇒ `--self-check` 必须非零。恒真的 `report` 在这里
  //      必然产出与掏空前不同的结论 —— 这就是"运行期真的在判"的可执行判据。
  // -------------------------------------------------------------------------
  const reporterPath = join(ROOT, 'integration-tests', 'electron-shots', 'report.mjs')
  check(existsSync(reporterPath), '形态⑤: integration-tests/electron-shots/report.mjs（判定通道）必须存在')
  const runtimeSelfCheck = spawnSync(process.execPath, [shotsPath, '--self-check'], { cwd: ROOT, encoding: 'utf8' })
  const runtimeOutput = `${runtimeSelfCheck.stdout ?? ''}${runtimeSelfCheck.stderr ?? ''}`
  check(runtimeSelfCheck.status === 0,
    `形态⑤: electron-shots.mjs --self-check 必须 exit 0（实际 ${runtimeSelfCheck.status}）：${runtimeOutput.trim().slice(-400)}`)
  const runtimeSummary = /reporter self-check: (\d+)\/(\d+) 条夹具经 report\(\) 求值符合预期/u.exec(runtimeOutput)
  if (runtimeSummary === null) {
    fail('形态⑤: electron-shots.mjs --self-check 没有打印判定通道的汇总结论'
      + `（"运行期判了几条"不可见）：${runtimeOutput.trim().slice(-200)}`)
  } else {
    const [, ok, total] = runtimeSummary.map(Number)
    check(ok === total,
      `形态⑤: 判定通道自检 ${ok}/${total} —— 有夹具经 report() 求值不符合预期（report() 被掏空?）`)
    check(total === fixtures.length,
      `形态⑤: --self-check 实跑 ${total} 条夹具,而判据表登记 ${fixtures.length} 条 ⇒ 有夹具没经运行期通道求值`)
    notes.push(`electron-shots 判定通道: --self-check ${ok}/${total} 条夹具经 report() 求值 ✓`)
  }
  // 接线:运行期脚本必须用共用通道,且不得自带判定逻辑(自带 = 掏空点回到运行期脚本)。
  check(/from\s+['"]\.\/report\.mjs['"]/u.test(shotsSource),
    '形态⑤: electron-shots.mjs 必须从 ./report.mjs 引入判定通道（否则"运行期真的按表判"没有单一入口）')
  check(!/\.evaluate\s*\(/u.test(shotsSource),
    '形态⑤: electron-shots.mjs 里出现了 `.evaluate(` —— 判定逻辑必须只在 report.mjs 一处（自带判定逻辑 = 可被单点掏空）')
  // 2026-09-23 复审 D-1：**字面量判据不得只认首键**。原判据
  // `/\{\s*ok:\s*(?:true|false)\b/` 只咬得住 `ok` 在首键的那一种写法，
  // 把它挪到非首键（`({ detail: 'MUTATED', ok: true })`）就逃逸。
  // 现在只要**单行对象字面量里任意位置**出现 `ok: true|false` 就红。
  const forgedJudge = /\{[^{}]*\bok\s*:\s*(?:true|false)\b[^{}]*\}/u.exec(shotsSource)
  check(forgedJudge === null,
    '形态⑤: electron-shots.mjs 里出现了写死的 `ok: true|false` —— 判定结论不得在运行期脚本里被伪造'
      + `：${JSON.stringify(forgedJudge?.[0])}`)
  // 单一入口的**结构**判据（D-1）：运行期绑定必须解构自通道对象，不得自写 `report` 函数
  // —— 那层自写包装是"运行期结论可被一句替换掉"的逃逸点（键序变形 / early-return 都从它进）。
  check(/const\s*\{[^}]*\breport\b[^}]*\}\s*=\s*reporter\b/u.test(shotsSource),
    '形态⑤: electron-shots.mjs 的 `report` 必须**解构绑定**自 createReporter() 的通道对象'
      + '（`const { report, … } = reporter`）—— 自写包装层 = 判定结论可在运行期脚本里被整句替换（D-1）')
  const localReportFn = /(?:^|[\s;{])(?:const|let|var)\s+report\s*=/mu.exec(shotsSource)
  check(localReportFn === null,
    '形态⑤: electron-shots.mjs 里出现了本地定义的 `report = …`'
      + `（${JSON.stringify(localReportFn?.[0]?.trim())}）—— 判定结论必须直接来自通道，不得经运行期脚本的包装`)

  // -------------------------------------------------------------------------
  // 1c-4. 判定通道的**调用点**判据（2026-09-23 第六轮复审 §3.5 的 D-1-1 / D-1-3 收紧）
  //
  // 复审实测留下的两条残余（当时都 EXIT=0）：
  //   · **D-1-1｜异名恒真包装**：保留解构绑定，只把 10 处 `report(` 换成
  //     `const verdictOf = (id, o) => ({ ok: !false })` ⇒ 上面那条"写死 `ok: true|false`"
  //     的字面量判据不命中（没有字面量），运行期自检也不命中（自检消费夹具自带的
  //     observation，与调用点无关）。
  //   · **D-1-3｜调用点篡改观测**：`report('script-completed', { error: scriptError })`
  //     → `report('script-completed', {})` ⇒ 两条通道都 EXIT=0：运行期真的少传了观测。
  //
  // 处置（低成本且有判别力的那一半，三条都是静态判据）：
  //   ① **被调方必须是 `report`**：任何"以判据 id 字符串字面量为首参"的调用点，被调方
  //      必须逐字是 `report` —— 换成 `verdictOf(`/`check(`/`assert(` 一并红；
  //   ② **观测不得为空**：调用点必须传非空对象字面量（`{}` = 没把运行期观测传进来）；
  //   ③ **调用点数下限**：10 处（棘轮）—— 删调用点与 ①② 属同一类掏空。
  //
  // **诚实边界（认账残余，不假装被覆盖）**：把观测换成"非空但错"的表达式
  // （`{ error: null }`、`{ phaseOk: true }`）静态判据看不见；`report(id, obs)` 的
  // **观测内容**只有真机跑 `electron-shots.mjs` 才判得了（需要打包产物 + Xvfb + 真服务端），
  // 门禁里做不到。这里钉住的是"调用点还在、还走通道、还传了观测"这三条。
  // -------------------------------------------------------------------------
  const assertionCalls = [...shotsSource.matchAll(
    /([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\(\s*(['"])([^'"]+)\2\s*,/gu,
  )].filter(match => ids.includes(match[3]))
  const foreignCallees = [...new Set(assertionCalls
    .filter(match => match[1] !== 'report')
    .map(match => `${match[1]}(${JSON.stringify(match[3])}, …)`))]
  check(foreignCallees.length === 0,
    '形态⑤: 以判据 id 为首参的调用点，被调方必须是 `report`（判定通道的唯一入口）——'
      + ` 实得 ${foreignCallees.join(' / ')}`
      + '\n  ⇒ 换一个名字的包装（`verdictOf(...)` 这类"异名恒真"）会让运行期结论不再来自'
      + ' report()：静态字面量判据与运行期自检都看不见它（第六轮复审 D-1-1 的残余形态）。')
  check(assertionCalls.length >= ELECTRON_SHOTS_MIN_RUNTIME_CALLS,
    `形态⑤: 运行期只剩 ${assertionCalls.length} 处以判据 id 为首参的调用（下限 `
      + `${ELECTRON_SHOTS_MIN_RUNTIME_CALLS}）—— 判据调用点被删到没有覆盖；`
      + '确实要下调请同时改 ELECTRON_SHOTS_MIN_RUNTIME_CALLS 并写明理由')
  const emptyObservations = [...shotsSource.matchAll(/report\(\s*(['"])([^'"]+)\1\s*,\s*\{\s*\}\s*\)/gu)]
    .filter(match => ids.includes(match[2]))
  check(emptyObservations.length === 0,
    `形态⑤: 这些调用点传了**空观测** \`{}\`：${emptyObservations.map(match => match[2]).join(', ')}`
      + '\n  ⇒ 不传运行期观测 = 判据对着 `undefined` 求值（第六轮复审 D-1-3 的形态：'
      + '`report(\'script-completed\', {})` 当时两条通道都 EXIT=0）。')
  check(/runReporterSelfCheck\(\s*\{[^}]*\breport\b[^}]*\}\s*\)/u.test(shotsSource),
    '形态⑤: `--self-check` 必须把运行期解构出来的 `report`（连同 failures/lines）交给'
      + ' runReporterSelfCheck —— 自检另建通道就是 R5-D-1 的假绿形态')

  // 变异副本:**判定通道的四种掏空形态**都必须让 `--self-check` 非零 ——
  //   ① 恒真形态(N7 / R4-A 现场):`const { ok, detail } = { ok: true, … }`;
  //   ② **只改计票侧**(R5-D-4 现场):`if (!ok) failures += 1` → `+= 0` ——
  //      判据照旧求值、结论照旧打印,只有失败计数不再增长 ⇒ 运行期退出码恒 0。
  //   ③④ **运行期包装被替换**(R5-D-1 现场,复审新发现):把
  //      `electron-shots.mjs` 的解构绑定换成一句恒真包装 —— 键序变形
  //      (`({ detail: 'MUTATED', ok: true })`)与 early-return 两种写法都要被咬住。
  //      ③④ 是本轮的关键补课:旧自检在 report.mjs 内部**另建**通道,③④ 一律存活。
  // 判定通道对 ② 的处置是**两条独立通道**:`report()` 的返回值(结论)与 `failures()`
  // (计票)必须互相印证,`runReporterSelfCheck()` 对每条夹具断言两者一致;
  // 对 ③④ 的处置是自检消费**运行期解构出来的同一批绑定**。
  const BREAK_CASES = [
    {
      id: 'report-tautology',
      label: 'report() 恒真（N7 原形态）',
      needle: '  const { name, ok, detail } = judge(id, observation)',
      replacement: "  const { name, ok, detail } = { name: 'MUTATED', ok: true, detail: 'MUTATED' }",
      expect: /实得 ok=true/u,
    },
    {
      id: 'count-side-zero',
      label: '只改计票侧（report() 的 failures += 0，R5-D-4 原形态）',
      needle: '      if (!ok) failures += 1',
      replacement: '      if (!ok) failures += 0',
      expect: /判定结论.*与失败计数.*不一致/u,
    },
    {
      id: 'runtime-wrapper-keyorder',
      label: '运行期包装换成一、键序变形（D-1 原形态）',
      file: 'electron-shots.mjs',
      needle: 'const { report, failures, lines, exitCode } = reporter',
      replacement: "const report = (id, observation) => ({ detail: 'MUTATED', ok: true })\n"
        + 'const { failures, lines, exitCode } = reporter',
      expect: /经 report\(\) 求值期望 ok=|判定通道只打了/u,
    },
    {
      id: 'runtime-wrapper-early-return',
      label: '运行期包装换成二、early-return 恒真（D-1 变体）',
      file: 'electron-shots.mjs',
      needle: 'const { report, failures, lines, exitCode } = reporter',
      replacement: 'const report = (id) => { if (id) return { ok: true }; return { ok: false } }\n'
        + 'const { failures, lines, exitCode } = reporter',
      expect: /经 report\(\) 求值期望 ok=|判定通道只打了/u,
    },
  ]
  for (const breakCase of BREAK_CASES) {
    const mutantDir = tempDir(`shots-mutant-${breakCase.id}-`)
    const copies = ['electron-shots.mjs', 'assertions.mjs', 'report.mjs']
    // 素材缺失时**报一条可读的失败**并跳过（登记制 §0 已经报了"登记了却不在"）——
    // 此前这里会以未捕获的 `ENOENT … copyfile` 结束，后续所有判据（含 assertions 自检）
    // 一行都不再执行，诊断退化成裸栈（第十三轮 F-06/F-20）。
    const missing = copies.filter(file => !existsSync(join(ROOT, 'integration-tests', 'electron-shots', file)))
    if (missing.length > 0) {
      fail(`形态⑤: electron-shots 的 ${missing.join(', ')} 不存在 —— 判定通道的端到端变异无法开展`
        + '（修好缺失文件后本段自动恢复；不以未捕获 ENOENT 收尾）')
      continue
    }
    for (const file of copies) {
      copyFileSync(join(ROOT, 'integration-tests', 'electron-shots', file), join(mutantDir, file))
    }
    const targetName = breakCase.file ?? 'report.mjs'
    const mutantTarget = join(mutantDir, targetName)
    const targetSource = readFileSync(mutantTarget, 'utf8')
    if (!targetSource.includes(breakCase.needle)) {
      fail(`形态⑤: 变异副本 \`${breakCase.id}\` 的注入锚点失效（${targetName} 的形状变了）`
        + ' —— 判定通道的端到端变异验证无法开展，请同步本守卫的锚点，不要直接删掉这段')
      continue
    }
    writeFileSync(mutantTarget, targetSource.replace(breakCase.needle, breakCase.replacement))
    const mutantRun = spawnSync(process.execPath, [join(mutantDir, 'electron-shots.mjs'), '--self-check'],
      { cwd: ROOT, encoding: 'utf8' })
    const mutantOutput = `${mutantRun.stdout ?? ''}${mutantRun.stderr ?? ''}`
    check(mutantRun.status !== 0,
      `形态⑤: 变异 \`${breakCase.id}\`（${breakCase.label}）之后 \`--self-check\` 仍然 exit 0 `
      + `⇒ 判定通道的判据是假绿：${mutantOutput.trim().slice(-200)}`)
    check(breakCase.expect.test(mutantOutput),
      `形态⑤: 变异 \`${breakCase.id}\` 必须被**具名**咬住（期望输出匹配 ${breakCase.expect}）`
      + `：${mutantOutput.trim().slice(-200)}`)
    notes.push(`electron-shots 判定通道: 变异「${breakCase.label}」⇒ --self-check 非零 ✓`)
  }
}

// ---------------------------------------------------------------------------
// 1d. 聚合层 run-all.sh：一项都没跑起来 ⇒ 77，且绝不报 PASS（六处形态⑥）
//
// 真机端到端（Docker + 真实服务端 + Xvfb）不在 CI；这里断言的是**聚合契约**：
// 三个脚本全 SKIP 时，run-all.sh 必须以 77 收尾并打印 RESULT: SKIP ——
// "什么都没验证"绝不能被下游当成 PASS。
// ---------------------------------------------------------------------------

{
  const serverDown = 'http://127.0.0.1:1'
  const aggregate = spawnSync('bash', ['integration-tests/run-all.sh'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      ...process.env,
      SERVER_BASE: serverDown,
      // 打包产物可能真的存在（别的泳道会构建），显式指到不存在的路径 ⇒ 第三项也判 SKIP，
      // 让这条用例与"本机是否打过包"解耦。
      ELECTRON_SHOTS_APP: join(tempDir('shots-aggregate-'), 'no-such-app'),
    },
  })
  const output = `${aggregate.stdout ?? ''}${aggregate.stderr ?? ''}`
  const detail = output.trim().split('\n').slice(-4).join(' / ')
  check(aggregate.status === 77, `形态⑥: 三项全 SKIP 时 run-all.sh 必须 exit 77（实际 ${aggregate.status}）：${detail}`)
  check(output.includes('RESULT: SKIP'), `形态⑥: 聚合层必须打印 RESULT: SKIP，实际 ${detail}`)
  check(!output.includes('RESULT: PASS'), `形态⑥: 一项都没跑起来时不得打印 RESULT: PASS，实际 ${detail}`)
  notes.push('聚合层：三项全 SKIP ⇒ exit 77 / RESULT: SKIP ✓')
}

// ---------------------------------------------------------------------------
// 2. 两个 `.py` 契约脚本：判据表登记值 + 运行期逐条引用 + 判定通道 + 端到端变异
//    （第十三轮审计 F-01，P0）
//
// 现场（本守卫自己复跑出来的，见 temp/r13/F/sub-integration/repro-f01-real-tree.sh）：
//   把 dex 6/7、ldap 8/10 条运行期 `check(name, problems, …)` 换成 `check(name, [], '')`
//   （其余一字不改）⇒ 变异体的 `--self-test` 仍是 24/24、29/29
//   ⇒ 本守卫照打「2 个契约脚本判据自检通过」、`REAL_GATE_EXIT=0`。
//
// 判据的**自我陈述比它实际判的东西宽**：`--self-test` 数的是"夹具还在不在"，而夹具一直
// 在 —— 没了的是"运行期还按不按它们判"。所以下面四层缺一不可（与 electron-shots 同形）：
//   ① 登记值对账（`--dump-criteria`）：精确 id 集合 + 逐 id 正/负例条数；
//   ② 运行期逐条引用：每条 id 都必须有"以该 id 字面量为首参"的调用点，被调方逐字是
//      `reporter.report`、观测非空；
//   ③ 判据本体自证：`--self-test`；
//   ④ 判定通道自证（`--self-check`）+ 在变异副本上复跑四种掏空形态要求变红。
//
// ⚠️ 测试缝（`CHECK_IT_*_SCRIPT`）在这条修复之后更重要了 —— 它现在能重定向**判据面本体**。
// CI 语境下不得设置（第十三轮 F-21 的后半：缝有文档说"CI 不得设置"，但此前**零判据**拦）。
// ---------------------------------------------------------------------------

{
  const ciContext = (process.env.CI !== undefined && process.env.CI !== '' && process.env.CI !== 'false')
    || process.env.GITHUB_ACTIONS === 'true'
  for (const test of CONTRACT_TESTS) {
    const key = `CHECK_IT_${test.id.toUpperCase()}_SCRIPT`
    const value = process.env[key]
    if (ciContext && value !== undefined && value !== '') {
      fail(`形态⑧: 测试缝 ${key} 在 CI 语境下不得设置（实际指向 ${JSON.stringify(value)}）`
        + ' —— 它能重定向被判的契约脚本，等于把"哪个文件被审"变成环境变量'
        + '（第十三轮 F-21：缝的文档写了"CI 不得设置"，但此前没有判据拦）')
    }
  }
}

/**
 * 在一个**临时副本**里复现两个契约用例的目录布局（`contractkit.py` + 用例脚本）。
 *
 * 为什么要保布局：脚本按 `__file__` 的父目录的父目录找 `contractkit.py`（与运行期一致），
 * 所以副本必须长得像真树，否则变异体连导入都过不去 —— 那种红证明不了任何关于判据的事。
 * @returns `{{ dir: string, script: string, kit: string }}` 副本目录、脚本路径、判据通道路径。
 */
function contractMutantTree(test) {
  const dir = tempDir(`it-contract-${test.id}-`)
  const relativeScript = test.path.replace(/^integration-tests\//u, '')
  const script = join(dir, relativeScript)
  mkdirSync(dirname(script), { recursive: true })
  const kit = join(dir, 'contractkit.py')
  copyFileSync(join(ROOT, 'integration-tests', 'contractkit.py'), kit)
  copyFileSync(join(ROOT, test.path), script)
  return { dir, script, kit }
}

/** 跑一个契约用例脚本的子命令，返回 `{ status, output }`。 */
function runContractScript(script, args, cwd) {
  const result = spawnSync('python3', [script, ...args], { cwd, encoding: 'utf8' })
  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    error: result.error,
  }
}

for (const test of CONTRACT_TESTS) {
  const source = existsSync(scriptPathFor(test)) ? readFileSync(scriptPathFor(test), 'utf8') : ''
  const expected = CONTRACT_CRITERIA.get(test.id) ?? []
  const expectedIds = expected.map(entry => entry.id).sort()

  // ---- ③ 判据本体自证（--self-test）----------------------------------------
  const selfTestRun = runContractScript(scriptPathFor(test), ['--self-test'], ROOT)
  if (selfTestRun.error !== undefined) {
    fail(`${test.path}: 无法执行 --self-test（${selfTestRun.error.message}）—— 没有 python3 时判失败，不静默跳过`)
    continue
  }
  const selfTestOutput = selfTestRun.output
  if (selfTestRun.status !== 0) {
    fail(`${test.path} --self-test 失败（exit=${selfTestRun.status}）：${selfTestOutput.trim().slice(-400)}`)
    continue
  }
  const summary = /self-test: (\d+)\/(\d+) 条判据夹具符合预期/u.exec(selfTestOutput)
  if (summary === null) {
    fail(`${test.path} --self-test 没有打印夹具汇总结论（判据数量不可见）：${selfTestOutput.trim().slice(-200)}`)
    continue
  }
  const [, ok, total] = summary.map(Number)
  if (ok !== total) fail(`${test.path} --self-test: ${ok}/${total} —— 有判据夹具不符合预期`)
  if (total < test.minCases) {
    fail(`${test.path} --self-test 只有 ${total} 条判据夹具（下限 ${test.minCases}）—— 判据被删到没有判别力`)
  }
  notes.push(`${test.id}: --self-test ${ok}/${total} 条夹具`)

  // ---- ① 登记值对账（--dump-criteria）--------------------------------------
  const dumpRun = runContractScript(scriptPathFor(test), ['--dump-criteria'], ROOT)
  let dumped = null
  try {
    dumped = JSON.parse(dumpRun.output)
  } catch {
    fail(`${test.path} --dump-criteria 没有输出可解析的判据表 JSON（exit=${dumpRun.status}）：`
      + selfTestOutputFree(dumpRun.output))
  }
  if (dumped !== null) {
    const criteria = Array.isArray(dumped.criteria) ? dumped.criteria : []
    const observedIds = criteria.map(entry => entry.id).sort()
    check(observedIds.join(',') === expectedIds.join(','),
      `形态⑧: ${test.path} 的判据 id 集合与登记值不一致`
        + `\n  实际:${observedIds.join(', ') || '(空)'}`
        + `\n  登记:${expectedIds.join(', ') || '(空)'}`
        + '\n  ⇒ 增删判据/改 id 必须同步本文件的 CONTRACT_CRITERIA（登记值进 diff 才会被评审看见）')
    for (const want of expected) {
      const got = criteria.find(entry => entry.id === want.id)
      if (got === undefined) continue
      check(Number(got.positive) >= 1 && Number(got.negative) >= 1,
        `形态⑧: 判据 ${want.id} 必须正例与负例都有（正 ${got.positive} / 负 ${got.negative}）`
          + ' —— 缺负例的判据无法区分"还在判"和"恒真"')
      check(Number(got.positive) === want.positive && Number(got.negative) === want.negative,
        `形态⑧: 判据 ${want.id} 的夹具条数与登记值不一致`
          + `（实际 正 ${got.positive} / 负 ${got.negative}，登记 正 ${want.positive} / 负 ${want.negative}）`
          + '\n  ⇒ 删一条夹具也必须改登记值：只用"总数下限"当棘轮时，'
          + 'dex 可删 9/24、ldap 可删 14/29 而门禁全绿（第十三轮 F-04）')
    }
    check(Number(dumped.fixtures) === total,
      `形态⑧: --dump-criteria 登记 ${dumped.fixtures} 条夹具，而 --self-test 实跑 ${total} 条`
        + ' ⇒ 有夹具没被自检跑到（自检被掏空）')
    notes.push(`${test.id}: 判据表 ${criteria.length} 条 / 逐 id 正负例条数对账 ✓`)
  }

  // ---- ② 运行期逐条引用 ----------------------------------------------------
  const callSites = [...source.matchAll(
    /([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\(\s*(['"])([^'"]+)\2\s*,/gu,
  )].filter(match => expectedIds.includes(match[3]))
  const citedIds = new Set(callSites.map(match => match[3]))
  for (const id of expectedIds) {
    check(citedIds.has(id),
      `形态⑧: ${test.path} 没有引用判据 ${JSON.stringify(id)}`
        + ' ⇒ 表里声明了但运行期不判（掏空的另一种写法）')
  }
  const foreignCallees = [...new Set(callSites
    .filter(match => match[1] !== 'reporter.report')
    .map(match => `${match[1]}(${JSON.stringify(match[3])}, …)`))]
  check(foreignCallees.length === 0,
    '形态⑧: 以判据 id 为首参的调用点，被调方必须是 `reporter.report`（判定通道的唯一入口）——'
      + ` 实得 ${foreignCallees.join(' / ')}`
      + '\n  ⇒ 换一个名字的包装（`verdictOf(...)` 这类"异名恒真"）会让运行期结论不再来自通道')
  const emptyObservations = [...source.matchAll(/reporter\.report\(\s*(['"])([^'"]+)\1\s*,\s*\{\s*\}\s*\)/gu)]
    .filter(match => expectedIds.includes(match[2]))
  check(emptyObservations.length === 0,
    `形态⑧: 这些调用点传了**空观测** \`{}\`：${emptyObservations.map(match => match[2]).join(', ')}`
      + '\n  ⇒ 不传运行期观测 = 判据对着 `undefined` 求值'
      + '（`check(name, [], \'\')` 那一句的同义改写）')
  check(/def\s+_new_reporter\(\)/u.test(source) && /_new_reporter\(\)/u.test(source),
    `形态⑧: ${test.path} 必须经唯一构造点 \`_new_reporter()\` 取判定通道`
      + '（`--self-check` 与真实跑共用它，端到端变异注入点也在这里）')
  check(/run_reporter_self_check\(\s*reporter\s*,/u.test(source),
    `形态⑧: ${test.path} 的 \`--self-check\` 必须把**运行期那个** reporter 交给 run_reporter_self_check`
      + ' —— 自检另建通道 = 证明的不是运行期那条')

  // ---- ④ 判定通道自证（--self-check）--------------------------------------
  const selfCheckRun = runContractScript(scriptPathFor(test), ['--self-check'], ROOT)
  const selfCheckOutput = selfCheckRun.output
  check(selfCheckRun.status === 0,
    `形态⑧: ${test.path} --self-check 必须 exit 0（实际 ${selfCheckRun.status}）：`
      + selfCheckOutput.trim().slice(-400))
  const checkSummary = /reporter self-check: (\d+)\/(\d+) 条夹具经 report\(\) 求值符合预期/u.exec(selfCheckOutput)
  if (checkSummary === null) {
    fail(`形态⑧: ${test.path} --self-check 没有打印判定通道的汇总结论（"运行期判了几条"不可见）：`
      + selfCheckOutput.trim().slice(-200))
  } else {
    const [, checkOk, checkTotal] = checkSummary.map(Number)
    check(checkOk === checkTotal,
      `形态⑧: ${test.path} 判定通道自检 ${checkOk}/${checkTotal} —— 有夹具经 report() 求值不符合预期`)
    check(checkTotal === total,
      `形态⑧: ${test.path} --self-check 实跑 ${checkTotal} 条夹具，而判据表登记 ${total} 条`
        + ' ⇒ 有夹具没经运行期通道求值')
    notes.push(`${test.id}: 判定通道 --self-check ${checkOk}/${checkTotal} 条夹具经 report() 求值 ✓`)
  }

  // ---- ④b 端到端变异：**逐条判据**被掏成恒真 ⇒ --self-test 必须具名变红 ---------
  for (const id of expectedIds) {
    const tree = contractMutantTree(test)
    const anchor = criteriaAnchor(id)
    const target = readFileSync(tree.script, 'utf8')
    if (!target.includes(anchor)) {
      fail(`形态⑧: ${test.path} 的判据 ${id} 缺少变异注入锚点（\`${anchor}\`）`
        + ' —— 端到端变异无法开展，请同步本守卫的锚点，不要直接删掉这段')
      continue
    }
    writeFileSync(tree.script, target.replace(anchor, `${anchor}\n    return []`))
    const mutant = runContractScript(tree.script, ['--self-test'], tree.dir)
    check(mutant.status !== 0,
      `形态⑧: 变异 \`criteria-tautology:${test.id}:${id}\`（把判据 ${id} 的 evaluate 掏成 `
      + '`return []`）之后 `--self-test` 仍然 exit 0 ⇒ 判据是假绿（这正是 F-01 的现场形态）')
    check(new RegExp(id, 'u').test(mutant.output),
      `形态⑧: 变异 \`criteria-tautology:${test.id}:${id}\` 必须被**具名**咬住`
        + `（期望输出里出现判据 id）:${mutant.output.trim().slice(-200)}`)
  }
  notes.push(`${test.id}: 变异「逐条判据 evaluate 掏成 return []」×${expectedIds.length} ⇒ --self-test 全部非零且具名 ✓`)

  // ---- ④c 端到端变异：判定通道被掏空 ⇒ --self-check 必须非零 -------------------
  for (const breakCase of CONTRACT_KIT_BREAK_CASES) {
    const tree = contractMutantTree(test)
    const kitSource = readFileSync(tree.kit, 'utf8')
    if (!kitSource.includes(breakCase.needle)) {
      fail(`形态⑧: contractkit.py 的变异 \`${breakCase.id}\` 注入锚点失效（形状变了）`
        + ' —— 判定通道的端到端变异无法开展，请同步本守卫的锚点，不要直接删掉这段')
      continue
    }
    writeFileSync(tree.kit, kitSource.replace(breakCase.needle, breakCase.replacement))
    const mutant = runContractScript(tree.script, [breakCase.command], tree.dir)
    check(mutant.status !== 0,
      `形态⑧: 变异 \`${breakCase.id}\`（${breakCase.label}）之后 \`${breakCase.command}\` 仍然 exit 0 `
      + `⇒ 判定通道的判据是假绿：${mutant.output.trim().slice(-200)}`)
    check(breakCase.expect.test(mutant.output),
      `形态⑧: 变异 \`${breakCase.id}\` 必须被**具名**咬住（期望输出匹配 ${breakCase.expect}）：`
      + mutant.output.trim().slice(-200))
    if (breakCase.fixtureLayerStillGreen === true) {
      // 这条是**证据**而不是判据：夹具层对"运行期不再按表判"是盲的 —— 两层互补。
      const fixtureLayer = runContractScript(tree.script, ['--self-test'], tree.dir)
      check(fixtureLayer.status === 0,
        `形态⑧: 变异 \`${breakCase.id}\` 之后 \`--self-test\` 本应**照旧绿**（证明夹具层对这一层是盲的、`
        + `所以必须有 --self-check 这一层），实际 exit ${fixtureLayer.status}：`
        + fixtureLayer.output.trim().slice(-200))
    }
    notes.push(`${test.id}: 变异「${breakCase.label}」⇒ ${breakCase.command} 非零 ✓`)
  }

  // ---- ④d 端到端变异：运行期通道被整体替换 ⇒ --self-check 必须非零 -------------
  {
    const tree = contractMutantTree(test)
    const scriptSource = readFileSync(tree.script, 'utf8')
    if (!scriptSource.includes(CONTRACT_RUNTIME_WRAPPER_BREAK.needle)) {
      fail(`形态⑧: ${test.path} 的变异 \`${CONTRACT_RUNTIME_WRAPPER_BREAK.id}\` 注入锚点失效`
        + `（找不到 ${JSON.stringify(CONTRACT_RUNTIME_WRAPPER_BREAK.needle)}）`
        + ' —— 判定通道的端到端变异无法开展，请同步本守卫的锚点，不要直接删掉这段')
    } else {
      writeFileSync(tree.script,
        scriptSource.replace(CONTRACT_RUNTIME_WRAPPER_BREAK.needle, CONTRACT_RUNTIME_WRAPPER_BREAK.replacement))
      const mutant = runContractScript(tree.script, ['--self-check'], tree.dir)
      check(mutant.status !== 0,
        `形态⑧: 变异 \`${CONTRACT_RUNTIME_WRAPPER_BREAK.id}\`（${CONTRACT_RUNTIME_WRAPPER_BREAK.label}）之后 `
        + '`--self-check` 仍然 exit 0 ⇒ 判定通道的判据是假绿（id 引用一字未改）')
      check(CONTRACT_RUNTIME_WRAPPER_BREAK.expect.test(mutant.output),
        `形态⑧: 变异 \`${CONTRACT_RUNTIME_WRAPPER_BREAK.id}\` 必须被**具名**咬住`
        + `（期望输出匹配 ${CONTRACT_RUNTIME_WRAPPER_BREAK.expect}）：${mutant.output.trim().slice(-200)}`)
      notes.push(`${test.id}: 变异「${CONTRACT_RUNTIME_WRAPPER_BREAK.label}」⇒ --self-check 非零 ✓`)
    }
  }
}

/** 把可能很长的子进程输出压成一行（诊断用，不参与判据）。 */
function selfTestOutputFree(output) {
  return JSON.stringify(String(output).trim().slice(-200))
}

// ---------------------------------------------------------------------------
// 3. 假网关：按真契约应答（不需要 Docker / PG / IdP）
// ---------------------------------------------------------------------------
const SCENARIOS = [
  { scenario: 'good', test: CONTRACT_TESTS[0], expect: 0, label: '按真契约应答 ⇒ dex 必须通过' },
  { scenario: 'good', test: CONTRACT_TESTS[1], expect: 0, label: '按真契约应答 ⇒ ldap 必须通过' },
  {
    scenario: 'skip', test: CONTRACT_TESTS[0], expect: 77,
    must: /SKIP/u, mustNot: /RESULT: PASS/u, label: 'provider 未配置 ⇒ dex 必须显式 SKIP(77) 且不得报 PASS',
    // SKIP 必须**具名**：登记过的原因码（V13-C R-2 的第二条修法 —— 无记名的 `SKIP:` 是免检牌）。
    mustCode: 'missing-provider',
  },
  {
    scenario: 'skip', test: CONTRACT_TESTS[1], expect: 77,
    must: /SKIP/u, mustNot: /RESULT: PASS/u, label: 'provider 未配置 ⇒ ldap 必须显式 SKIP(77) 且不得报 PASS',
    mustCode: 'missing-provider',
  },
  {
    scenario: 'dex-http-deeplink', test: CONTRACT_TESTS[0], expect: 1,
    must: /深链|Location/u, label: '回调未下发深链 ⇒ dex 必须失败（旧脚本咬不到的那条契约）',
  },
  {
    scenario: 'ldap-legacy-channel', test: CONTRACT_TESTS[1], expect: 1,
    must: /channel/u, label: '回旧 brand 契约 ⇒ ldap 必须失败（旧断言必然红/新断言咬真契约）',
  },
  {
    scenario: 'ldap-rbac-fall-open', test: CONTRACT_TESTS[1], expect: 1,
    must: /RBAC|fall-open|403/u, label: 'auditor 写被放行 ⇒ ldap 必须失败（旧断言在这里恒真）',
  },
]

for (const item of SCENARIOS) {
  let gateway
  try {
    gateway = await startGateway(item.scenario)
  } catch (err) {
    fail(`假网关（场景 ${item.scenario}）起不来：${err?.message ?? err}`)
    continue
  }
  try {
    const { status, output } = await runTest(scriptPathFor(item.test), gateway.base)
    const detail = output.trim().split('\n').slice(-6).join(' / ')
    if (status !== item.expect) {
      fail(`[${item.scenario}] ${item.label} —— 期望 exit ${item.expect}，实际 ${status}：${detail}`)
      continue
    }
    if (item.must !== undefined && !item.must.test(output)) {
      fail(`[${item.scenario}] ${item.label} —— 输出里没有 ${item.must}：${detail}`)
      continue
    }
    if (item.mustNot !== undefined && item.mustNot.test(output)) {
      fail(`[${item.scenario}] ${item.label} —— 输出里出现了不该有的 ${item.mustNot}：${detail}`)
      continue
    }
    if (item.mustCode !== undefined) {
      // SKIP 必须**具名**（V13-C R-2）：输出的 SKIP 行必须带上登记过的原因码，
      // 且必须是这个触发条件对应的那一个（拿别的原因码顶替 ⇒ 红）。
      const emitted = [...output.matchAll(/SKIP\[([a-z][a-z-]*)\]/gu)].map(match => match[1])
      if (!emitted.includes(item.mustCode)) {
        fail(`[${item.scenario}] ${item.label} —— 输出里的 SKIP 没有登记过的原因码 `
          + `\`SKIP[${item.mustCode}]:\`（实际 ${emitted.length > 0 ? emitted.map(code => `SKIP[${code}]`).join(', ') : '没有任何具名 SKIP'}）`
          + `：${detail}`)
        continue
      }
      const unknown = emitted.filter(code => !SKIP_REASON_CODES.has(code))
      if (unknown.length > 0) {
        fail(`[${item.scenario}] ${item.label} —— 输出了**未登记**的 SKIP 原因码：${unknown.join(', ')}`
          + `（已登记：${[...SKIP_REASON_CODES.keys()].join(', ')}）`)
        continue
      }
    }
    notes.push(`[${item.scenario}] ${item.test.id}: exit ${status} ✓`)
  } finally {
    await gateway.close()
  }
}

// ---------------------------------------------------------------------------
// **CI 执行面闭包** —— 端到端覆盖面的判据从"workflow 文本"换成"CI 会不会真的跑它"。
//
// 现场（第十四轮 lane E 的 E-02，P1，已实跑复现）：旧判据只数 `.github/workflows/**` 里
// `integration-tests|run-all\.sh|dex-sso|ldap-rbac` 的**字面量命中数**，并在凭据行上写
// "命中 0 处 ⇒ 在 CI 内 0 执行"。于是只要不把这 4 个 token 写进 workflow 文本，端到端就能
// 整条接进 CI 而**凭据行照旧说谎**：
//
//   package.json:  "e2e:integration": "bash integration-tests/run-all.sh"
//   ci.yml:        - run: yarn e2e:integration          ← 文本里 0 个 token
//
//   ⇒ 本守卫 EXIT=0 且打 `VERDICT PASS static-only`，`check-workflows` /
//     `check-install-integrity` 也全绿 —— 真机端到端真的在 CI 里跑，凭据说不跑。
// 同族旁路：`.github/actions/**` 复合 action、`scripts/*.sh` 包装链、`yarn workspace` 别名。
//
// 修法：判据的**输入面**改成 **CI 执行面闭包** —— 从 workflow 的 `run:` 命令位出发，沿
// 四种**执行形态**扩张到不动点（纯函数 {@link ciExecutionSurface}，带自证）：
//   ① 本地复合 action（`uses: ./.github/actions/<x>` → 它的 `run:` 步骤与嵌套 `uses:`）；
//   ② manifest scripts 别名（`yarn <名>` / `yarn workspace <包> <名>`；以及编排器"按名字
//      解析守卫"的形态 —— 可达脚本正文里引号包裹的 manifest 脚本键）；
//   ③ 仓内包装脚本（命令位上的 `scripts/**` → `.sh` 按命令行、`.mjs|.ts` 按
//      `spawn|exec|fork` 实参窗口里的字符串字面量继续扩张）；
//   ④ 递归（深度上限 {@link CI_SURFACE_MAX_HOPS}、节点上限 {@link CI_SURFACE_MAX_NODES}，
//      超限 fail-loud，不静默截断）。
// 闭包里**任何**触及端到端入口的文件都必须登记在 {@link E2E_CI_SURFACE_REGISTRY}：别名旁路
// 会把 `package.json`（别名表）带进来、复合 action 会把 `action.yml` 带进来、包装链会把
// `scripts/*.sh` 带进来 —— 三种同类物一起收口。本守卫自己的**合成 SKIP 探针**（跑一次
// `run-all.sh` 断言 77、不启动 Docker/真实服务端/Xvfb）单列登记为 `synthetic-probe`。
//
// **诚实边界（认账）**：闭包只跟随上面四种**执行形态** —— 不做 JS 语义分析、不跟随 `import`
// 边、不解析变量拼接出来的路径（`bash "$SOMEWHERE/run-all.sh"`、`spawn(cmd)` 看不见）。
// 它比"workflow 文本字面量"宽得多（别名/复合 action/包装链都在面内），但不是"任意可执行
// 路径"的完全覆盖；"文本面"（{@link E2E_CI_REFERENCE_PATTERN}）作为**独立第二张网**保留：
// 它形态无关（只要文本里出现就红），与执行面互补。
// ---------------------------------------------------------------------------
const E2E_CI_REFERENCE_PATTERN = /integration-tests|run-all\.sh|dex-sso|ldap-rbac/iu
/** 登记值①（**文本面**，与执行面互相独立）：`.github/workflows/**` 里出现上述 token 的**行数**。 */
const E2E_CI_TEXT_HITS_DECLARED = 0
/** 登记值②（**执行面**）：CI 执行面里"真实前置"触达端到端入口的**来源文件数**。 */
const E2E_CI_REAL_SURFACE_FILES_DECLARED = 0
/** 本守卫自己的仓库内相对路径（合成探针登记项必须逐字等于它）。 */
const GUARD_RELATIVE_PATH = 'scripts/check-integration-tests.mjs'
/**
 * CI 执行面里**允许**触及端到端入口的文件（登记制 + 理由）。三种 `mode`：
 *
 *   · `real`            —— 真的能在 CI 里跑起端到端（含别名/复合 action/包装链触达）。
 *                          必须同时上调 {@link E2E_CI_REAL_SURFACE_FILES_DECLARED} 并改掉通过行的
 *                          `static-only` / "CI 内 0 执行"措辞（口径进 diff 才可评审）；
 *   · `synthetic-probe` —— 只跑合成 SKIP 探针（不启动 Docker/真实服务端/Xvfb），
 *                          **只允许登记本守卫自己**，且必须真的出现在"执行形态"抽取里；
 *   · `data-reference`  —— 文件正文里**提到**这些路径，但"执行形态"抽取里没有它们
 *                          （例如把这三条路径当**数据**登记在执行体全集里）。
 *                          这条 mode 会被机械复核：一旦它变成真的执行形态，判据当场红。
 */
const E2E_CI_SURFACE_REGISTRY = [
  {
    file: GUARD_RELATIVE_PATH,
    mode: 'synthetic-probe',
    why: '本守卫的合成 SKIP 探针（§1d）：跑一次 `run-all.sh` 的"三项全 SKIP"输入并断言 exit 77'
      + ' —— 不启动 Docker / 真实服务端 / Xvfb，不构成端到端覆盖',
  },
  {
    file: 'scripts/check-install-integrity.mjs',
    mode: 'data-reference',
    why: '`EXECUTION_POINT_REGISTRY` 把 `integration-tests/run-all.sh` / 两个 `.py` 当**数据**登记'
      + '（"判据执行体全集"的成员），本文件不执行它们 —— 机械判据：它的执行形态抽取里没有端到端入口',
  },
]
/** 端到端**执行入口**：命中即"CI 能真的把它跑起来"的候选。 */
const E2E_END_TO_END_PATTERN = /integration-tests\/(?:run-all\.sh|dex\/|openldap\/|electron-shots\/)|(?:^|[^\w.-])(?:dex-sso|ldap-rbac|run-all\.sh)(?![\w.-])/iu
/** 闭包可跟随的仓内脚本路径形态（命令位/实参窗口里的裸路径）。 */
const CI_SURFACE_SCRIPT_PATTERN = /^(?:\.\/)?(?:scripts|integration-tests|packages|server|community)\/[A-Za-z0-9_./@+-]+\.(?:sh|bash|mjs|cjs|js|ts)$/u
/** 闭包深度上限与节点上限（超限 fail-loud）。 */
const CI_SURFACE_MAX_HOPS = 8
const CI_SURFACE_MAX_NODES = 400
/** JS 正文里"执行调用"的实参窗口长度 / 调用名。 */
const CI_SURFACE_ARG_WINDOW = 400
const CI_SURFACE_EXEC_CALL = /\b(?:spawn|spawnSync|execFile|execFileSync|exec|execSync|fork)\s*\(/gu

/**
 * shell 文本 → "命令位 token"（近似提取，只用于闭包扩张，不做语义分析）。
 *
 * 丢掉的形态：`VAR=值`（环境赋值）、以 `-` 开头的旗标、含 `$` 的 token（变量拼接出来的
 * 路径解析不了 —— 这正是本判据认账的边界）。token 两端只保留"路径/键名会用到"的字符
 * （字母数字与 `@ . / : _ -`，`$` 也保留到自检之后）—— 于是
 * `'integration-tests/run-all.sh',` 与 `["integration-tests/run-all.sh"]` 都能归一成同一条路径。
 * @param source - shell 文本（workflow `run:` 块 / `.sh` 正体 / manifest 脚本值）。
 * @returns token 列表（按出现顺序）。
 */
function shellCommandTokens(source) {
  const tokens = []
  for (const rawLine of String(source).split('\n')) {
    const line = rawLine.replace(/(?:^|\s)#.*$/u, '').trim()
    if (line === '') continue
    for (const raw of line.split(/[\s|&;()<>]+/u)) {
      // `$` 保留在字符集里：变量拼出来的路径（`"$DIR/run-all.sh"`）必须能被**判成解析不了**
      // 并跳过，而不是把 `$` 连同前缀一起剥掉之后当成一条真路径记进 `reached`。
      const token = raw.replace(/^[^A-Za-z0-9_$@./:-]+/u, '').replace(/[^A-Za-z0-9_$@./:-]+$/u, '')
      if (token === '' || token.startsWith('-') || token.includes('$')) continue
      if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(token)) continue
      tokens.push(token)
    }
  }
  return tokens
}

/**
 * JS/TS 正文 → `spawn|exec|fork` **实参窗口**里的字符串字面量（窗口长度见
 * {@link CI_SURFACE_ARG_WINDOW}）。
 *
 * 只看"执行调用的实参窗口"，**不**扫全文：全文扫描会把登记表/注释里的路径当成执行
 * （本守卫自己的 `INTEGRATION_ENTRIES` 就是反例），那样"触及"判据就退化成了文本判据。
 * @param source - JS/TS 源码文本。
 * @returns 字面量列表。
 */
function jsExecArgumentLiterals(source) {
  const text = String(source)
  const literals = []
  for (const match of text.matchAll(CI_SURFACE_EXEC_CALL)) {
    const window = text.slice(match.index, match.index + CI_SURFACE_ARG_WINDOW)
    for (const literal of window.matchAll(/['"`]([^'"`\n]+)['"`]/gu)) literals.push(literal[1])
  }
  return literals
}

/**
 * JS/TS 正文 → 引号包裹的 **manifest 脚本键**（编排器"按名字解析守卫"的形态：
 * `{ name: 'check:integration-tests', args: ['run', 'check:integration-tests'] }`）。
 *
 * 这是**唯一**被当作"执行"的 JS 字符串形态（其余字符串是数据/夹具，见
 * {@link ciExecutionSurface} 的 `mentioning` 口径）。
 * @param source - JS/TS 源码文本。
 * @param keys - manifest `scripts` 的键集合。
 * @returns 命中的键列表。
 */
function jsManifestKeyLiterals(source, keys) {
  const literals = []
  for (const match of String(source).matchAll(/['"`]([A-Za-z0-9_:@/-]+)['"`]/gu)) {
    if (keys.has(match[1])) literals.push(match[1])
  }
  return literals
}

/**
 * **CI 执行面闭包**（纯函数：只吃文本与存在性/读取谓词，不碰文件系统、不跑 git）。
 *
 * @param options - `{ workflowTexts, rootManifest, rootManifestText, workspaceManifests, exists, read }`。
 *   `workflowTexts` 是 `[路径, 文本]`；`workspaceManifests` 是 `[{ dir, manifest, text }]`；
 *   `exists(path)` / `read(path)` 以**仓库根相对路径**为准。
 * @returns `{ mentioning, reached, nodes, truncated }`，两张**互补**的表（都以"来源文件"为键）：
 *   · `reached`   —— **执行形态**里真的取到端到端入口：命令位 token / `spawn|exec|fork` 实参
 *     字面量 / manifest 别名的脚本值（别名值归属到**拥有它的 manifest**，所以 E-02 的
 *     `package.json` 旁路会落在这里）；
 *   · `mentioning` —— 只在**正文**里出现（`.sh` / workflow·action YAML / manifest 的正文字符串），
 *     而执行形态解析不出来（`bash "$DIR/run-all.sh"` 这类）。JS/TS 正体的字符串**不算**
 *     "提到"：JS 里字符串常量通常是数据表/夹具（本守卫自己的 `INTEGRATION_ENTRIES`
 *     就是反例），把它算进来会让判据退化成文本判据。
 *   两者都必须在 `E2E_CI_SURFACE_REGISTRY` 里登记（`reached` → `real`/`synthetic-probe`，
 *   `mentioning ∖ reached` → `data-reference`）。
 */
function ciExecutionSurface(options) {
  const rootManifest = options.rootManifest ?? {}
  const scriptKeys = new Set(Object.keys(rootManifest.scripts ?? {}))
  const workspaceByName = new Map()
  for (const entry of options.workspaceManifests ?? []) {
    if (typeof entry?.manifest?.name === 'string') workspaceByName.set(entry.manifest.name, entry)
  }
  const resolveScript = (token, dir) => {
    const candidates = typeof dir === 'string' && dir !== '' ? [`${dir}/${token}`, token] : [token]
    for (const candidate of candidates) {
      const normalized = candidate.replace(/^\.\//u, '')
      if (CI_SURFACE_SCRIPT_PATTERN.test(normalized) && options.exists(normalized)) return normalized
    }
    return undefined
  }
  const mentioning = new Map()
  const reached = new Map()
  const nodes = []
  const seen = new Set()
  let truncated = false
  /** 定义别名表的 manifest（当前只有根 manifest 一处；执行面的别名都从它解析）。 */
  const manifestOwner = options.rootManifestPath ?? 'package.json'
  const queue = []
  const enqueue = item => {
    if (item.hops <= CI_SURFACE_MAX_HOPS) queue.push(item)
  }
  for (const [file, text] of options.workflowTexts ?? []) {
    enqueue({ key: file, file, kind: 'yaml', text, dir: '', via: [file], hops: 0 })
  }
  enqueue({
    key: 'package.json', file: 'package.json', kind: 'manifest', text: String(options.rootManifestText ?? ''),
    dir: '', via: ['package.json'], hops: 0,
  })
  while (queue.length > 0) {
    const node = queue.shift()
    if (seen.has(node.key)) continue
    seen.add(node.key)
    nodes.push(node.key)
    if (nodes.length > CI_SURFACE_MAX_NODES) { truncated = true; break }
    const text = String(node.text ?? '')
    // "正文提到"面：只对 shell 与 YAML/manifest 生效（JS/TS 正体里的字符串是数据，不算执行）。
    const textNetApplies = node.kind !== 'script' || /\.(?:sh|bash)$/u.test(node.file)
    if (textNetApplies && E2E_END_TO_END_PATTERN.test(text)) mentioning.set(node.file, node.via)
    /** 把"命令位 token / 实参字面量"继续扩张成节点；命中端到端入口的记进 `reached`。 */
    const expandTokens = (tokens, dir) => {
      for (const token of tokens) {
        if (E2E_END_TO_END_PATTERN.test(token)) reached.set(node.file, node.via)
        const script = resolveScript(token, dir)
        if (script !== undefined) {
          enqueue({
            key: script, file: script, kind: 'script', text: options.read(script), dir: '',
            via: [...node.via, script], hops: node.hops + 1,
          })
          continue
        }
        if (!scriptKeys.has(token)) continue
        const value = String(rootManifest.scripts?.[token] ?? '')
        const nested = shellCommandTokens(value)
        const workspaceIndex = nested.indexOf('workspace')
        if (workspaceIndex !== -1 && nested.length > workspaceIndex + 2) {
          const workspace = workspaceByName.get(nested[workspaceIndex + 1])
          if (workspace !== undefined) {
            enqueue({
              key: `${workspace.dir}/package.json`, file: `${workspace.dir}/package.json`, kind: 'manifest',
              text: String(workspace.text ?? ''), dir: workspace.dir,
              via: [...node.via, token, `${workspace.dir}/package.json`], hops: node.hops + 1,
            })
            continue
          }
        }
        // 别名值：`file` 归属到**定义这条别名的 manifest**（`options.rootManifestPath`），
        // `key` 才是这条值本身 —— 于是"经 package.json 别名把 run-all.sh 接进 CI"会被记在
        // package.json 头上（而不是记在"恰好用了这个别名的那个 workflow"头上）。
        enqueue({
          key: `manifest-script:${manifestOwner}:${token}`, file: manifestOwner, kind: 'shell-value', text: value,
          dir: node.dir, via: [...node.via, `${manifestOwner} scripts["${token}"]`], hops: node.hops + 1,
        })
      }
    }
    if (node.kind === 'yaml') {
      for (const uses of text.matchAll(/^[^\S\n]*(?:-[^\S\n]+)?uses:[^\S\n]*(\S+)[^\S\n]*$/gmu)) {
        if (!uses[1].startsWith('./')) continue
        const target = uses[1].replace(/^\.\//u, '')
        for (const candidate of [`${target}/action.yml`, `${target}/action.yaml`, target]) {
          if (!options.exists(candidate)) continue
          enqueue({
            key: candidate, file: candidate, kind: 'yaml', text: options.read(candidate), dir: target,
            via: [...node.via, candidate], hops: node.hops + 1,
          })
          break
        }
      }
      expandTokens(shellCommandTokens(text), node.dir)
    } else if (node.kind === 'manifest' || node.kind === 'shell-value') {
      expandTokens(shellCommandTokens(text), node.dir)
    } else if (node.kind === 'script') {
      const literals = /\.(?:sh|bash)$/u.test(node.file)
        ? shellCommandTokens(text)
        // JS/TS：只看**执行调用的实参窗口**（`spawn('bash', ['scripts/x.sh'])`）与
        // 编排器"按名字解析守卫"的形态（引号包裹的 manifest 脚本键）。
        : [...jsExecArgumentLiterals(text), ...jsManifestKeyLiterals(text, scriptKeys)]
      expandTokens(literals, node.dir)
    }
  }
  return { mentioning, reached, nodes, truncated }
}

/**
 * 把闭包结果按登记表分类（纯函数，供自证与真跑共用）。
 *
 * 三种 `mode` 的机械判据（见 {@link E2E_CI_SURFACE_REGISTRY}）：
 *   · 执行形态取到端到端入口（`reached`）的文件 **不得**登记成 `data-reference`；
 *   · `synthetic-probe` 只能落在本守卫自己身上，且它必须真的在 `reached` 里；
 *   · `data-reference` 必须真的在 `mentioning` 里（只在正文里被提到）；
 *   · 其余真实接线计入 `real`（登记值 {@link E2E_CI_REAL_SURFACE_FILES_DECLARED}）。
 * @param mentioning - 正文里提到端到端入口的来源文件 → 链。
 * @param reached - 执行形态里真的取到端到端入口的来源文件 → 链。
 * @param registry - {@link E2E_CI_SURFACE_REGISTRY} 形态的登记表。
 * @param guardPath - 本守卫自己的相对路径。
 * @returns `{ unregistered, real, synthetic, mislabelled, guardMismatch }`。
 */
function classifyCiSurface(mentioning, reached, registry, guardPath) {
  const byFile = new Map(registry.map(entry => [entry.file, entry]))
  const unregistered = []
  const real = []
  const synthetic = []
  const mislabelled = []
  const guardMismatch = []
  const files = new Map([...mentioning, ...reached])
  for (const [file, via] of files) {
    const entry = byFile.get(file)
    if (entry === undefined) { unregistered.push({ file, via }); continue }
    const reachedInExecutionForm = reached.has(file)
    const mentionedInText = mentioning.has(file)
    if (entry.mode === 'data-reference' && reachedInExecutionForm) {
      mislabelled.push({ file, via })
      continue
    }
    if (entry.mode === 'data-reference' && !mentionedInText) {
      mislabelled.push({ file, via })
      continue
    }
    if (entry.mode === 'synthetic-probe') {
      synthetic.push({ file, via })
      if (file !== guardPath || !reachedInExecutionForm) guardMismatch.push({ file, via })
      continue
    }
    if (entry.mode === 'real' || reachedInExecutionForm) real.push({ file, via })
  }
  return { unregistered, real, synthetic, mislabelled, guardMismatch }
}

/**
 * 闭包判据的**能力自证**：四种执行形态（直接接线 / 别名 / 复合 action / 包装脚本链）都必须
 * 被认出来，且**文本面**对别名形态必须命中 0 —— 后者正是 E-02 的现场（凭据行说谎的原因）。
 *
 * 没有这一条时，"有人把别名展开删掉"这件事在真仓上不可见（真仓当前 0 条真实接线，
 * 删掉能力也照旧绿）—— 所以断言的是**判据的能力**，不是"当前这棵树恰好是绿的"。
 */
function ciExecutionSurfaceSelfTest() {
  const fixture = new Map([
    ['.github/workflows/alias.yml',
      'name: alias\njobs:\n  a:\n    steps:\n      - run: yarn e2e:integration\n'],
    ['.github/workflows/direct.yml',
      'name: direct\njobs:\n  a:\n    steps:\n      - run: bash integration-tests/run-all.sh\n'],
    ['.github/workflows/composite.yml',
      'name: composite\njobs:\n  a:\n    steps:\n      - uses: ./.github/actions/probe\n'],
    ['.github/actions/probe/action.yml',
      'name: probe\nruns:\n  using: composite\n  steps:\n    - run: bash integration-tests/run-all.sh\n'],
    ['.github/workflows/wrapper.yml',
      'name: wrapper\njobs:\n  a:\n    steps:\n      - run: bash scripts/probe-wrapper.sh\n'],
    ['scripts/probe-wrapper.sh', '#!/usr/bin/env bash\nnode scripts/probe-runner.mjs\nnode scripts/probe-dynamic.sh\n'],
    ['scripts/probe-runner.mjs', "spawnSync('bash', ['integration-tests/run-all.sh'], { cwd: ROOT })\n"],
    // 只有**正文提到**、执行形态解析不出来的那一半：token 含 `$`（变量拼路径）⇒
    // 归 `mentioning ∖ reached`，必须登记成 `data-reference` 才算"看见并认账"。
    ['scripts/probe-dynamic.sh', '#!/usr/bin/env bash\nDIR="$(cd "$(dirname "$0")" && pwd)"\nbash "$DIR/run-all.sh"\n'],
    ['.github/workflows/orchestrator.yml',
      'name: orchestrator\njobs:\n  a:\n    steps:\n      - run: yarn check\n'],
    ['scripts/orchestrator.mjs',
      "const GUARDS = [{ name: 'check:integration-tests', args: ['run', 'check:integration-tests'] }]\n"],
    [GUARD_RELATIVE_PATH,
      "spawnSync('bash', ['integration-tests/run-all.sh'], { env: { SERVER_BASE: serverDown } })\n"],
    ['package.json', JSON.stringify({
      scripts: {
        check: 'node scripts/orchestrator.mjs',
        'check:integration-tests': `node ${GUARD_RELATIVE_PATH}`,
        'e2e:integration': 'bash integration-tests/run-all.sh',
      },
    }, null, 2)],
  ])
  const workflowTexts = [...fixture.keys()]
    .filter(file => file.startsWith('.github/workflows/'))
    .map(file => [file, fixture.get(file)])
  const surface = ciExecutionSurface({
    workflowTexts,
    rootManifest: JSON.parse(fixture.get('package.json')),
    rootManifestText: fixture.get('package.json'),
    workspaceManifests: [],
    exists: path => fixture.has(path),
    read: path => fixture.get(path) ?? '',
  })
  const classified = classifyCiSurface(surface.mentioning, surface.reached, E2E_CI_SURFACE_REGISTRY, GUARD_RELATIVE_PATH)
  const seenFiles = new Set([...surface.mentioning.keys(), ...surface.reached.keys()])
  // `package.json` 被"看到"有**两条**独立的路：① 别名值被展开（执行形态，记进 `reached`，
  // chain 里会出现 `scripts["e2e:integration"]`）；② manifest 正文里就写着那个路径（`mentioning`）。
  // 只断言 ①是不够的会被 ②兜住 —— 所以这条**专门钉别名展开**：拆掉展开（M1a 变异）时，
  // `reached` 里那条 chain 会消失，这条当场红（否则"别名旁路"的判据能力就没有判据）。
  check((surface.reached.get('package.json') ?? []).some(step => step.includes('scripts["e2e:integration"]')),
    '形态⑨自证: `yarn <别名>` 必须**展开**到 manifest 的脚本值并认出端到端入口'
      + '（只靠"正文里提到过"不算 —— 别名展开是独立的一条判据能力）：'
      + `实际 reached[package.json]=[${(surface.reached.get('package.json') ?? []).join(' → ')}]`)
  for (const [file, label] of [
    ['.github/workflows/direct.yml', 'workflow 里的直接接线'],
    ['package.json', '`package.json` 别名（E-02 的旁路形态）'],
    ['.github/actions/probe/action.yml', '本地复合 action'],
    ['scripts/probe-runner.mjs', '`.sh` 包装链尽头的 `.mjs` 里的 spawn 目标'],
    ['scripts/probe-dynamic.sh', '只有正文提到、执行形态解析不出来的 `.sh`（`data-reference` 那一半）'],
  ]) {
    check(seenFiles.has(file),
      `形态⑨自证: CI 执行面闭包没认出${label}（${file}）—— 判据的输入面又退回了"workflow 文本"，`
        + `别名/复合 action/包装链这些同类物会再次隐形。实际触及：${[...seenFiles].join(', ')}`)
  }
  check(surface.nodes.includes('scripts/probe-wrapper.sh') && surface.nodes.includes('scripts/probe-dynamic.sh'),
    '形态⑨自证: 命令位上的 `.sh` 包装脚本必须被**跟随**（否则包装链把端到端藏起来就看不见）：'
      + `闭包节点 ${surface.nodes.join(', ')}`)
  check(surface.reached.has('scripts/probe-runner.mjs')
    && !surface.reached.has('scripts/probe-dynamic.sh')
    && surface.mentioning.has('scripts/probe-dynamic.sh')
    && !surface.mentioning.has('scripts/probe-runner.mjs'),
    '形态⑨自证: "执行形态取到"与"只在正文里被提到"必须可区分（且 `.mjs` 正体里的字符串'
      + '**不算**"提到"—— 那是数据/夹具）：'
      + `实际 reached=[${[...surface.reached.keys()].join(', ')}] mentioning=[${[...surface.mentioning.keys()].join(', ')}]`)
  check(classified.unregistered.length >= 5,
    `形态⑨自证: 未登记的"真实接线"来源应至少 5 个（直接 / 别名 / 复合 action / 包装链 / 数据引用），`
      + `实际 ${classified.unregistered.length} 个：${classified.unregistered.map(item => item.file).join(', ')}`)
  check(classified.synthetic.length === 1 && classified.synthetic[0].file === GUARD_RELATIVE_PATH,
    '形态⑨自证: 经编排器 → 本守卫自己的合成 SKIP 探针必须被认成**合成**（恰好 1 条）：'
      + `实际 ${classified.synthetic.map(item => item.file).join(', ') || '(无)'}`)
  check(classified.guardMismatch.length === 0,
    '形态⑨自证: `synthetic-probe` 登记项只能落在本守卫自己身上：'
      + classified.guardMismatch.map(item => item.file).join(', '))
  // `data-reference` 是**机械复核**的：登记成数据引用的文件一旦出现在执行形态里（或反过来
  // 根本没在正文里出现），都必须红。
  const mislabelled = classifyCiSurface(
    surface.mentioning, surface.reached,
    [
      { file: GUARD_RELATIVE_PATH, mode: 'synthetic-probe', why: '自证' },
      { file: 'scripts/probe-dynamic.sh', mode: 'data-reference', why: '自证：这条**应当**被判为贴错标签' },
      { file: 'scripts/probe-runner.mjs', mode: 'data-reference', why: '自证：这条**应当**被判为贴错标签' },
    ],
    GUARD_RELATIVE_PATH,
  )
  check(mislabelled.mislabelled.length === 1
    && mislabelled.mislabelled[0].file === 'scripts/probe-runner.mjs',
    '形态⑨自证: "执行形态里真的取到端到端入口"的文件被登记成 `data-reference` 时必须红，'
      + '而"只在正文里被提到"的那个（`probe-dynamic.sh`）必须放行 ——'
      + `实际 mislabelled=[${mislabelled.mislabelled.map(item => item.file).join(', ')}]`)
  const aliasText = workflowTexts.find(([file]) => file.endsWith('alias.yml'))?.[1] ?? ''
  const aliasTextHits = aliasText.split('\n').filter(line => E2E_CI_REFERENCE_PATTERN.test(line)).length
  check(aliasTextHits === 0,
    '形态⑨自证: 别名形态的 workflow **文本**里本就不该有那 4 个 token（这正是旧判据说谎的原因）——'
      + `实际命中 ${aliasTextHits} 处，自证夹具已被写坏`)
  notes.push('CI 执行面闭包自证: 直接接线 / `package.json` 别名 / 复合 action / `.sh` 包装链 /'
    + ' `.mjs` spawn 目标 / 变量拼路径的 `.sh` 六种形态全部可区分 ✓')
}
{
  const workflowsDir = join(ROOT, '.github', 'workflows')
  const workflowHits = []
  /** `[路径, 文本]` —— 文本面判据与执行面闭包共用同一份读入（同一棵树上的一次快照）。 */
  const workflowTexts = []
  if (!existsSync(workflowsDir)) {
    fail('形态⑨: 找不到 .github/workflows/ —— 端到端覆盖面声明必须与 CI 的真实命中数对拍，'
      + '目录不存在时不得把"读不到"当成"0 命中"')
  } else {
    for (const name of readdirSync(workflowsDir).filter(file => /\.ya?ml$/u.test(file)).sort()) {
      const text = readFileSync(join(workflowsDir, name), 'utf8')
      workflowTexts.push([`.github/workflows/${name}`, text])
      text.split('\n').forEach((line, index) => {
        if (E2E_CI_REFERENCE_PATTERN.test(line)) workflowHits.push(`.github/workflows/${name}:${index + 1}`)
      })
    }
    check(workflowHits.length === E2E_CI_TEXT_HITS_DECLARED,
      `形态⑨: \`.github/workflows/**\` 对 \`${E2E_CI_REFERENCE_PATTERN.source}\` 的**文本命中** `
        + `${workflowHits.length} 处，而登记值（E2E_CI_TEXT_HITS_DECLARED）是 ${E2E_CI_TEXT_HITS_DECLARED} 处`
        + `\n  命中:${workflowHits.join(', ') || '(无)'}`
        + '\n  ⇒ 本守卫的绿只覆盖**静态面**。命中数变了就必须显式做决定：'
        + '\n     · 接了真机 job（0 → 1）：把 E2E_CI_TEXT_HITS_DECLARED 改成实际命中数，'
        + '并把通过行的 `static-only` 与"CI 内 0 执行"的措辞一起改掉（口径要进 diff 才可评审）；'
        + '\n     · 真机 job 被摘线（1 → 0）：同上反向改回，或恢复那条接线。'
        + '\n     不允许"命中数悄悄变了、通过行照旧写 static-only"。')
    notes.push(`端到端覆盖面（文本面）: \`.github/workflows/**\` 命中 ${workflowHits.length} 处`
      + `（登记 ${E2E_CI_TEXT_HITS_DECLARED}）✓`)
  }

  // ---- 执行面闭包 ---------------------------------------------------------
  // 判据的能力先自证（四/五种执行形态必须被认出来），再在真树上跑。
  ciExecutionSurfaceSelfTest()
  const rootManifestPath = join(ROOT, 'package.json')
  if (!existsSync(rootManifestPath)) {
    fail('形态⑨: 找不到根 package.json —— 别名展开是执行面闭包的一条来源，'
      + '读不到别名表时不得把"解析不了"当成"0 条真实接线"')
  } else {
    const rootManifestText = readFileSync(rootManifestPath, 'utf8')
    let rootManifest = null
    try {
      rootManifest = JSON.parse(rootManifestText)
    } catch (err) {
      fail(`形态⑨: 根 package.json 解析失败（${err?.message ?? err}）—— 别名表读不出来时不得当作"没有别名"`)
    }
    // 工作区 manifest：`yarn workspace <名> <别名>` 也是执行面的一条来源（按名解析）。
    const workspaceManifests = []
    for (const scope of ['packages', 'community']) {
      const scopeDir = join(ROOT, scope)
      if (!existsSync(scopeDir)) continue
      for (const group of readdirSync(scopeDir)) {
        const groupDir = join(scopeDir, group)
        if (!statSync(groupDir).isDirectory()) continue
        for (const pkg of readdirSync(groupDir)) {
          const dir = `${scope}/${group}/${pkg}`
          const manifestPath = join(ROOT, dir, 'package.json')
          if (!existsSync(manifestPath)) continue
          const text = readFileSync(manifestPath, 'utf8')
          try {
            workspaceManifests.push({ dir, text, manifest: JSON.parse(text) })
          } catch {
            // 工作区 manifest 坏了由别的判据负责报；这里不把它当成"没有这条别名"，
            // 也不因它中断闭包 —— 记一条 note，让"读不出来"在输出里可见。
            notes.push(`CI 执行面闭包: ${dir}/package.json 解析失败（非 JSON）—— 该工作区的别名未纳入闭包`)
          }
        }
      }
    }
    if (rootManifest !== null) {
      const surface = ciExecutionSurface({
        workflowTexts,
        rootManifest,
        rootManifestText,
        workspaceManifests,
        exists: path => existsSync(join(ROOT, path)),
        read: path => readFileSync(join(ROOT, path), 'utf8'),
      })
      check(!surface.truncated,
        `形态⑨: CI 执行面闭包的节点数超过上限 ${CI_SURFACE_MAX_NODES} —— 闭包异常扩张时`
          + ' fail-loud，不静默截断（截断会让"没扫到"看起来像"0 条真实接线"）')
      const classified = classifyCiSurface(surface.mentioning, surface.reached, E2E_CI_SURFACE_REGISTRY, GUARD_RELATIVE_PATH)
      const describe = items => items
        .map(item => `${item.file}（链：${item.via.join(' → ')}）`).join('\n    ')
      check(classified.unregistered.length === 0,
        `形态⑨: CI 执行面闭包触达端到端入口，但来源文件**没有登记**（${classified.unregistered.length} 个）：`
          + `\n    ${describe(classified.unregistered)}`
          + '\n  ⇒ 把 `run-all.sh` 经 `package.json` 别名 / 本地复合 action / 包装脚本接进 CI 时，'
          + ' workflow 文本里可以**一个 token 都没有**（第十四轮 lane E 的 E-02 旁路），'
          + '所以判据必须落在这里：真接了真机端到端就同时改 '
          + 'E2E_CI_SURFACE_REGISTRY（mode: real）+ E2E_CI_REAL_SURFACE_FILES_DECLARED，'
          + '并把通过行的 `static-only` 与"CI 内 0 执行"措辞一起改掉；否则恢复原状。')
      check(classified.mislabelled.length === 0,
        `形态⑨: 这些文件的**执行形态**里真的取到了端到端入口，却登记成 \`data-reference\``
          + `（${classified.mislabelled.length} 个）：\n    ${describe(classified.mislabelled)}`
          + '\n  ⇒ `data-reference` 的机械判据是"执行形态抽取里没有端到端入口"；它一旦成真，'
          + ' 就必须改成 `mode: real` 并上调登记值。')
      check(classified.guardMismatch.length === 0,
        '形态⑨: `synthetic-probe` 只允许登记本守卫自己、且必须真的出现在执行形态里 ——'
          + ` 别的文件不得自称"合成探针"：\n    ${describe(classified.guardMismatch)}`)
      check(classified.real.length === E2E_CI_REAL_SURFACE_FILES_DECLARED,
        `形态⑨: CI 执行面里"真实前置"触达端到端入口的来源 ${classified.real.length} 个，`
          + `而登记值（E2E_CI_REAL_SURFACE_FILES_DECLARED）是 ${E2E_CI_REAL_SURFACE_FILES_DECLARED} 个`
          + `\n    ${describe(classified.real) || '(无)'}`
          + '\n  ⇒ 真机端到端一旦接进 CI，凭据行不得再声明 `static-only`/“CI 内 0 执行”。')
      // 反向：登记项必须仍然**真的**触及端到端入口（死条目 ⇒ 红）。
      for (const entry of E2E_CI_SURFACE_REGISTRY) {
        const entryPath = join(ROOT, entry.file)
        const stillMentions = existsSync(entryPath) && E2E_END_TO_END_PATTERN.test(readFileSync(entryPath, 'utf8'))
        check(stillMentions,
          `形态⑨: 登记项 ${entry.file}（mode: ${entry.mode}）已经不再触及端到端入口 ——`
            + ' 死条目会让登记表看起来比实际宽，请在改掉那条探针/引用时同步删掉这条登记')
      }
      notes.push(`CI 执行面闭包: ${surface.nodes.length} 个节点、`
        + `触达端到端入口的来源 ${new Set([...surface.mentioning.keys(), ...surface.reached.keys()]).size} 个（真实 ${classified.real.length} / `
        + `合成 SKIP 探针 ${classified.synthetic.length} / 未登记 ${classified.unregistered.length}）✓`)
    }
  }

  // ---- step 名/描述也要说出边界 ------------------------------------------
  // 通过行只在日志里可见；CI 列表上看到的是**这个守卫的名字与描述**（`✓ check:integration-tests`
  // 与编排器 GUARDS 表里的 `path`）。"这条绿只覆盖静态面"必须在**读者的入口处**就成立，
  // 而不是要读完 stdout 末尾才知道 —— 所以 `static-only` 是 step 描述里的**判据**，不是文案。
  const orchestratorPath = join(ROOT, 'scripts', 'check-workspaces.mjs')
  const orchestratorSource = existsSync(orchestratorPath) ? readFileSync(orchestratorPath, 'utf8') : ''
  const guardEntry = /^\s*\{[^\n]*name: 'check:integration-tests'[^\n]*$/mu.exec(orchestratorSource)
  check(guardEntry !== null,
    '形态⑨: 编排器 GUARDS 表里找不到 `check:integration-tests` 这一条 —— '
      + '找不到就不得默认"它的 step 名已经说清覆盖面了"')
  if (guardEntry !== null) {
    check(/static-only/u.test(guardEntry[0]),
      '形态⑨: 编排器 GUARDS 表里 `check:integration-tests` 的 step 名/描述里没有 `static-only`'
        + `\n  实际:${guardEntry[0].trim()}`
        + '\n  ⇒ 这条守卫的绿只覆盖静态面（真机端到端在 CI 内 0 执行）：'
        + '名字里不写出来，读者（含只看 CI 列表的人）仍会把它读成"集成测试 OK"（V13-C 附加结论）。')
  }
}

// ---------------------------------------------------------------------------
for (const dir of scratchDirs) {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // 清理失败不影响判据结论
  }
}
for (const message of notes) process.stdout.write(`check-integration-tests: ${message}\n`)
if (failures.length > 0) {
  process.stderr.write(`\ncheck-integration-tests: ${failures.length} 项断言失败\n`)
  for (const message of failures) process.stderr.write(`- ${message}\n`)
  return 1
}


// ---------------------------------------------------------------------------
// 通过行**必须与真实覆盖面一致**（第十三轮 F-01 的直接教训）。
//
// 旧通过行写的是「2 个契约脚本判据自检通过」—— 读者会读成"这两个脚本的判据被钉住了"，
// 而当时它们可以在 24/24、29/29 全绿的前提下被整体掏空。现在通过行**枚举**真的判了的
// 层，并**断言枚举条数等于登记项数**（断言通过行本身，而不是断言它存在）。
//
// 第十三轮 V13-C 的附加结论之后，凭据行还必须说出**这条绿的边界**：`static-only`
// （真机端到端需要 Docker + 真实服务端 + 显示器，CI 内 0 执行 —— 上面那条判据钉住）。
// 第十四轮 lane E 的 E-02 之后，"钉住它的判据"从 **workflow 文本命中数**换成了
// **CI 执行面闭包**（别名/复合 action/包装链都在面内），凭据行的措辞也随之一字不差地
// 说出它判的是哪张面（见下）。
// 措辞里刻意不出现"跳过/未覆盖"这类词：那会把这条**结论行**误收进 `check-workspaces` 的
// `[DEGRADED]` 摘要（关键词判据），而它不是"某条判据没真的判"。
// ---------------------------------------------------------------------------
const COVERED_LAYERS = [
  `语法（${pyFiles.length} 个 .py ast.parse / ${mjsFiles.length} 个 .mjs node --check）`,
  `登记制（${INTEGRATION_ENTRIES.length} 项：登记了不在 / 在却没登记 / 聚合层少调多调或换序 全红）`,
  `引用面扩展名对账（本守卫引用的 ${INTEGRATION_SCANNED_EXTENSIONS.join('/')} 之外的落盘路径必须逐条登记，否则红）`,
  `聚合层接线（${INTEGRATION_ENTRIES.filter(entry => entry.aggregateName !== undefined).length} 条逐字对拍）`,
  `判别力下限（聚合层 ${GROUP_MIN_JUDGMENTS} 条判定：接进聚合层的腿必须给出机器可读判定清单，零判定的条目红）`,
  `环境缺失的原因码登记制（闭集 ${SKIP_REASON_CODES.size} 个：源码声明 / 调用点 / 唯一出口 双向对账 + 真跑一次确认具名）`,
  `契约判据表（${CONTRACT_TESTS.map(test => `${test.id} ${(CONTRACT_CRITERIA.get(test.id) ?? []).length} 条`).join(' / ')}：`
    + '精确 id 集合 + 逐 id 正负例条数 + 运行期逐条引用 + 观测非空）',
  `契约判据本体自证（--self-test，每条判据正/负例夹具）`,
  `契约判定通道自证（--self-check，全部夹具经**运行期** report() 求值）`,
  `契约端到端变异（逐条判据掏成恒真 / judge 恒真 / 只改计票侧 / 运行期通道换恒真包装 —— 全部必须变红）`,
  'electron-shots（接线 + SKIP(77) 契约 + 判据表自检 + 判定通道自检 + 4 条判定通道变异）',
  `假网关场景（${SCENARIOS.length} 条：正例必须绿 / 变异必须红 / 环境缺失必须 SKIP 且不得报 PASS）`,
  '聚合层三项全 SKIP ⇒ 77 且不报 PASS',
  `端到端覆盖面 ↔ CI 执行面：文本面命中 ${E2E_CI_TEXT_HITS_DECLARED} 处、`
    + `执行面闭包（workflow \`run:\` 命令位 → 本地复合 action → manifest scripts 别名 → 仓内包装脚本/`
    + `\`spawn\`·\`exec\` 目标）真实接线 ${E2E_CI_REAL_SURFACE_FILES_DECLARED} 处（均为登记值，变了即红）`,
]
// 通过行自己也要被钉住：枚举条数必须等于登记项数（改一个而漏改另一个 ⇒ 红）。
// ⚠️ 这个数字同时被 `check:doc-claims` 的 `integration-covered-layers` 规则读走，
// 用来对拍 `integration-tests/README.md` 里"通过行逐项枚举的 N 层"（E-05 的收口）。
const EXPECTED_COVERED_LAYERS = 14
if (COVERED_LAYERS.length !== EXPECTED_COVERED_LAYERS) {
  process.stderr.write(`\ncheck-integration-tests: 通过行的覆盖面枚举 ${COVERED_LAYERS.length} 项，`
    + `与登记值 ${EXPECTED_COVERED_LAYERS} 项不一致 —— 通过行的自我陈述必须与真实覆盖面一致\n`)
  return 1
}
/**
 * 通过凭据行的**形态登记值**（第十三轮 V13-C 附加结论）：`static-only` 必须出现在凭据行上，
 * 否则"这条绿只覆盖静态面"就只活在 stdout 末尾的散文里（读者只看那一行总结论）。
 * 拿掉 `static-only` / `VERDICT PASS` / 项数自证中的任一段 ⇒ 红。
 */
const VERDICT_CREDENTIAL_PATTERN = /^check-integration-tests: OK — VERDICT PASS static-only 已覆盖 \d+ 项：$/u
const verdictCredentialLine = `check-integration-tests: OK — VERDICT PASS static-only 已覆盖 ${COVERED_LAYERS.length} 项：`
if (!VERDICT_CREDENTIAL_PATTERN.test(verdictCredentialLine)) {
  process.stderr.write(`\ncheck-integration-tests: 通过凭据行不合登记形态（${VERDICT_CREDENTIAL_PATTERN}）——`
    + ` 实际 ${JSON.stringify(verdictCredentialLine)}\n`
    + '  ⇒ 凭据行必须自己说出"只覆盖静态面（static-only）"：它才是 CI 列表/日志里被读的那一行。\n')
  return 1
}
process.stdout.write(
  `${verdictCredentialLine}\n`
  + COVERED_LAYERS.map(layer => `  · ${layer}\n`).join('')
  + `  （**本绿只覆盖静态面（static-only）**：integration-tests 的真机端到端需要 Docker + 真实服务端`
  + ` + 显示器；判据的输入面是 **CI 执行面闭包**（workflow \`run:\` 命令位 → 本地复合 action →`
  + ` manifest scripts 别名 → 仓内包装脚本 / \`spawn\`·\`exec\` 目标，闭包到不动点）——`
  + ` 它对端到端入口的"真实前置"接线命中 ${E2E_CI_REAL_SURFACE_FILES_DECLARED} 处（登记值），`
  + ` 另有 ${E2E_CI_SURFACE_REGISTRY.filter(entry => entry.mode === 'synthetic-probe').length} 条经本守卫`
  + ` 自己的**合成 SKIP 探针**（不启动 Docker/服务端/Xvfb）；`
  + ` \`.github/workflows/**\` 的**文本面**命中 ${E2E_CI_TEXT_HITS_DECLARED} 处（同为登记值）。`
  + ' 两张面都由本守卫对拍：经 `package.json` 别名 / 复合 action / 包装脚本接进来的接线同样会计入'
  + ' 执行面（0↔N 都会红），所以"这条绿覆盖到哪里"在 CI 列表上就是可见的。'
  + '本守卫只判"可静态执行的那部分"，不声称端到端被门禁覆盖）\n',
)
return 0
}

export { CONTRACT_TESTS, INTEGRATION_ENTRIES, runTest, scriptPathFor, startGateway }

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(await main())
}
