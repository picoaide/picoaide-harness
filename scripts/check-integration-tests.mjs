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
/**
 * 覆盖层的**执行见证**（第十八轮 R18A-G-07 的收口件②）。
 *
 * 为什么需要它：`COVERED_LAYERS` 是**自己声明**的覆盖面，而"层数自洽"修前只对拍条数
 * （`COVERED_LAYERS.length === EXPECTED_COVERED_LAYERS`）—— 把某一层的 `check(...)`
 * 掏空、只留标签，条数不变、两条守卫全绿，而通过行照旧宣称"已覆盖 14 项"。
 *
 * 现在每条"静态标签"层都必须在**自己的实现里**写入一个见证值（见下面各处的 `+=` / `=`），
 * 通过行把它们写进标签，收尾再断言"见证存在且形态正确"：
 *   · 删掉该层的断言 ⇒ 见证保持初值 ⇒ **红**（不是"标签还在所以绿"）；
 *   · 改标签/换层序 ⇒ {@link COVERED_LAYER_LABELS} 的逐条前缀对拍当场红。
 */
const coverageWitness = {
  /** `--self-test` 实跑的判据夹具总数（层 8）。 */
  contractSelfTestFixtures: 0,
  /** `--self-check` 经运行期通道求值的夹具总数（层 9）。 */
  contractSelfCheckFixtures: 0,
  /** 真的跑过的"逐条判据掏成恒真"变异条数（层 10）。 */
  contractMutations: 0,
  /** electron-shots 判据表的判据条数（层 11）。 */
  electronShotsAssertions: 0,
  /** 聚合层"三项全 SKIP"实跑的退出码（层 13；必须是 77）。 */
  aggregateSkipExit: undefined,
}
/**
 * 覆盖层的**判决观测**（第十九轮 R19A-03 的收口）。
 *
 * ## 现场（为什么"尝试计数"不够）
 *
 * R18A-G-07 的见证是"我跑了几次"：`coverageWitness.contractMutations += 1` 数的是**尝试**，
 * 而真正咬人的是紧跟其后那句 `check(mutant.status !== 0, …)`。审计实测：**保留 `+= 1`、
 * 把判决掏成 `check(true, …)`** ⇒ 守卫 EXIT=0，而通过行照旧宣称"17 条判据逐条掏成恒真
 * —— 全部必须变红"。同族：9 个**无见证层**可以整层掏空（`for (const item of SCENARIOS)` →
 * `for (const item of [])`、`for (const file of pyFiles)` 同），标签里的动态计数
 * （`SCENARIOS.length` / `pyFiles.length`）**不变**，因为它们是表长、不是执行痕迹。
 *
 * ## 判据（两层，缺一不可）
 *
 * ① **每层交出原始观测**（`recordLayerVerdict`，必须写在**该层自己的实现里**，循环层写在
 *    循环体内），收尾用 `LAYER_VERDICT_RULES` **重新判决**一遍 —— 观测里存的是原始事实
 *    （子进程退出码、命中数、违规列表），不是"我 check 过了"。于是：
 *      · 把某一层的循环掏空 ⇒ 观测条数 0（或少于该层的登记下限）⇒ 红；
 *      · 把循环体的判决掏成恒真 ⇒ 原始事实没变、收尾的重新判决照样红。
 * ② **判决句逐字登记**（`REQUIRED_JUDGMENT_SITES`）：上面那条修不掉"事实没变、只是守卫
 *    不再看它"的那一格（把 `check(mutant.status !== 0, …)` 换成 `check(true, …)` 时，
 *    仓里的事实一个字都没变）—— 只有"判决句必须在场"这条静态判据能发现它。
 * @type {Map<string, object[]>}
 */
const coverageVerdicts = new Map()
/**
 * 记一条**判决观测**（原始事实；收尾重新判决）。
 * @param {string} layer - 覆盖层标签（必须逐字等于 `COVERED_LAYER_LABELS` 的一项）。
 * @param {object} observation - 原始事实（各层的字段见收尾的 `LAYER_VERDICT_RULES`）。
 */
const recordLayerVerdict = (layer, observation) => {
  const list = coverageVerdicts.get(layer)
  if (list === undefined) coverageVerdicts.set(layer, [observation])
  else list.push(observation)
}
/**
 * 汇总行（`notes`）的**符号必须按结论选**（第十五轮 R15A-08，P3）。
 *
 * 现场：修前无论红绿一律 `…）✓`，于是同一轮输出里出现过
 * `CI 执行面闭包: …（真实 0 / 合成 SKIP 探针 1 / **未登记 1**）✓` 与 `形态⑨ … 判红` 并排 ——
 * 只看汇总行的读者会以为这一层是绿的。这正是本仓"通过行必须与覆盖面一致"那条规矩的另一半：
 * 符号也是陈述。
 *
 * 口径：一条汇总行绿，当且仅当**自上一条汇总行以来没有新增失败**。这样归因是"这一行
 * 覆盖的那段断言"，而不是"整轮有没有红"；两段之间确实没有汇总行的失败会被保守地算到
 * 下一行头上（宁可多打一个 ✗，也不假绿）。
 */
let noteFailuresAtLastPush = 0
const note = text => {
  notes.push({ text: String(text).replace(/\s*✓$/u, ''), ok: failures.length === noteFailuresAtLastPush })
  noteFailuresAtLastPush = failures.length
}
const fail = message => failures.push(message)
/** 条件断言（失败即记一条原因，与 check-* 系列守卫同形）。 */
const check = (condition, message) => {
  if (!condition) fail(message)
  return condition
}

/**
 * **判决见证的计数表**（R20A-04 建立；键 = 判决点 id，值 = `{ runs, passed, failed }`）。
 * 语义、收口与边界见 {@link witnessed}。
 */
const JUDGMENT_RUNS = new Map()
/**
 * 判决见证的**契约违约**（非布尔判决值）——收尾与 `judgmentSitesWithoutRuns` 一起判红。
 * @type {string[]}
 */
const JUDGMENT_CONTRACT_VIOLATIONS = []
/**
 * **判决见证**（R20A-04 建立；**R21 fix-6 / E-02 收口**）——记的是**判决值**，不是"调用发生过"。
 *
 * ## 现场（E 泳道，15 个登记点逐个实跑）
 *
 * 修前这里只做 `JUDGMENT_RUNS.set(site, (… ?? 0) + 1)` 再 `return verdict`，收口断言是
 * "该 id 的**调用计数** ≥ 1"。于是"判决表达式是否经过它"与"这个 id 是否被调用过一次"
 * 并不等价：**保留判决句原文**、把它包进 `if (false) …`，再在**任何**会执行到的地方补一行
 * `witnessed('<id>', true)`（诱饵：只计数、不判决）⇒ 两段判据同时满足、守卫 `EXIT=0`，
 * 15 个点里 13 个静默失效（另 2 个是被 R19A-03 的收尾重新判决咬住的，不是见证层）。
 * 同族第二个变体连诱饵都不需要：把本函数按 id 特判 `return true`（**一行**）⇒ `EXIT=0`。
 *
 * ## 收口（三层，缺一不可）
 *
 * ① **计数 + 判决值分开记**：`runs` / `passed` / `failed` 三个量都记 —— "跑过"与"判成什么"
 *    不再可分离；`verdict` 不是布尔（少传参 / 传对象）当场记违约（那不是一个判决）。
 * ② **判决位必须是"行首的独立语句"**（见收尾第一段的 `judgmentNeedleStatementProblem`）：
 *    `if (false) check(witnessed(…))` 与"上一行悬挂 `if (…)`"两种掏空形态当场红。
 * ③ **返回契约逐 id 自证**（见收尾第三段）：对**每一个**登记点探测
 *    `witnessed(id, false) === false` 与 `witnessed(id, true) === true` ⇒ 按 id 特判
 *    `return true` 的写法在这里露出来。
 *
 * ## 边界（认账，勿夸大）
 *
 * 这是**判据的判据**：攻击者对这个文件有完全控制权，任何"同一文件内的自证"都可以被
 * 同步改掉（例如把 ③ 的探测循环一起掏空）。真正的兜底仍是 `scripts/check-root-guards.mjs`
 * 对**本文件字节**的 sha256 登记值（任何改动都必须同步登记值、进 diff 才会被评审看见）。
 * 本条能做到的是：**最自然的两种编辑（`if (false)` 掏空 + 一行诱饵、按 id 特判返回值）
 * 当场红**，而不是"单文件不可伪造"。
 * @param site - 判决点 id（必须与 {@link REQUIRED_JUDGMENT_SITES} 的 `id` 一致）。
 * @param verdict - 判决结果（**必须是布尔**；原样交回 `check()` / `if (!…)`）。
 * @returns `verdict`（原样）；非布尔返回 `false` 并记违约。
 */
const witnessed = (site, verdict) => {
  if (typeof verdict !== 'boolean') {
    JUDGMENT_CONTRACT_VIOLATIONS.push(`判决点 \`${site}\` 的见证收到**非布尔**判决值`
      + `（${verdict === undefined ? '缺参数' : typeof verdict}）—— 见证必须绑**判决结果**，`
      + '不是"调用发生过"（`witnessed(id)` 这种只计数的调用不是一个判决）')
    return false
  }
  const record = JUDGMENT_RUNS.get(site) ?? { runs: 0, passed: 0, failed: 0 }
  record.runs += 1
  if (verdict) record.passed += 1
  else record.failed += 1
  JUDGMENT_RUNS.set(site, record)
  return verdict
}
/**
 * 登记的判决点里**一次都没执行过**的那些（R20A-04 的判据本体；纯函数，配了自检样本）。
 * @param sites - `REQUIRED_JUDGMENT_SITES` 同形（至少要有 `id`）。
 * @param runs - 执行计数表（生产路径传 {@link JUDGMENT_RUNS}）。
 * @returns 未执行的判决点数组。
 */
const judgmentSitesWithoutRuns = (sites, runs) =>
  sites.filter(site => (runs.get(site.id)?.runs ?? 0) < 1)

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
  note(`聚合层解析器: 相邻两行 ⇒ 2 条、尾参不吞行、注释/缩进行不误判 ✓`)
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
  note('integration-tests 引用面扩展名对账自证: 面外未登记必红 / 登记后放行 / 面内不误报 / 未落盘不算缺口 ✓')
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
  // **Location 的两种形态都要有一条腿**（第三十轮 FIX-45 ①）：
  //   · 默认（`good` 等）⇒ **绝对** Location（`http://host/dex/approval?…`），历史上唯一的形态；
  //   · `dex-relative-location` ⇒ IdP **自己内部**的跳转用**相对** Location，与真 Dex 逐字同形
  //     （真 Dex 的 `/auth` 用 302 + `/auth/local?…` 跳自己的登录页）。
  // 只留绝对形态正是"判据自洽型假绿"的来源：`follow()` 把相对 Location 当桌面深链也永远绿。
  const relativeRedirects = scenario === 'dex-relative-location'
  /** 这个网关**真的发出去过**的 Location（形态覆盖判据的原始事实，不是常量表）。 */
  const emittedLocations = []
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
      emittedLocations.push(location)
      res.writeHead(status, { Location: location, ...headers })
      res.end()
    }
    /** 同源目标按场景决定写绝对还是相对（跨 origin 的那一跳必须绝对）。 */
    const sameOrigin = target => (relativeRedirects ? target : `${origin}${target}`)
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
      // 真 Dex 在这一跳用的是**相对** Location（`/auth/local` → `/dex/approval`）；
      // `dex-relative-location` 场景复刻它，`good` 场景维持历史形态（绝对）。
      return redirect(303, sameOrigin(`/dex/approval?req=${state}&state=${state}`))
    }
    if (path === '/dex/approval' && req.method === 'GET') return html(200, APPROVAL_HTML)
    if (path === '/dex/approval' && req.method === 'POST') {
      const state = url.searchParams.get('state') ?? ''
      return redirect(303, sameOrigin(`/api/client/v2/auth/oidc/callback?code=code-42&state=${state}`))
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
      // **行为级判据的夹具**（第三十轮 FIX-45 ②）：`dex-wrong-identity` 让深链 token 是**有效**的、
      // 但 `/auth/me` 回的是**别人** ⇒ "深链身份必须是本次登录账号"这条契约被破坏，dex 必须
      // FAIL。把该调用点变成不可达（`if False:` / 早退）时这条腿会从 FAIL 变成 PASS ⇒ 当场红。
      if (scenario === 'dex-wrong-identity') {
        return json(200, { user: { username: 'intruder', email: 'intruder@example.invalid', role: 'user' } })
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
        // 收尾判"两种 Location 形态都真的被发出去过"用的**原始事实**（每个场景各自一份）。
        emittedLocations,
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
    // **判决观测**（R19A-03）：原始事实（这个登记项在不在磁盘上），收尾重新判决。
    recordLayerVerdict('登记制', {
      check: 'registered-on-disk', path: entry.path, onDisk: existsSync(join(ROOT, entry.path)),
    })
    check(witnessed('registered-on-disk', existsSync(join(ROOT, entry.path))),
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
  recordLayerVerdict('登记制', {
    check: 'disk-registry-diff', onDisk: onDisk.length,
    unregistered: unregistered.length, stale: staleEntries.length,
  })
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
    check(witnessed('scope-unregistered', scope.unregistered.length === 0),
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
    // **判决观测**（R19A-03）：原始事实 = 未登记 / 死条目 / 落盘引用条数。
    recordLayerVerdict('引用面扩展名对账', {
      check: 'reference-scope', present: scope.present.length,
      unregistered: scope.unregistered.length, dead: scope.deadEntries.length,
    })
    note(`integration-tests 引用面: 落盘引用 ${scope.present.length} 条、`
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
  check(witnessed('aggregate-wiring', aggregateLines.length === expectedAggregate.length),
    `形态⑦: run-all.sh 里有 ${aggregateLines.length} 条 \`run "…"\` 调用，登记表要求 `
      + `${expectedAggregate.length} 条 —— 聚合层的接线数与登记值不一致`
      + `\n  实际:${aggregateLines.map(line => line.path).join(', ') || '(空)'}`
      + `\n  登记:${expectedAggregate.map(line => line.path).join(', ') || '(空)'}`)
  for (const [index, expected] of expectedAggregate.entries()) {
    const actual = aggregateLines[index]
    // **判决观测**（R19A-03）：原始事实 = 这一条接线的三个字段是否逐字对上。
    const wiringMatched = actual !== undefined && actual.name === expected.name
      && actual.runner === expected.runner && actual.path === expected.path
    for (const layer of ['登记制', '聚合层接线']) {
      recordLayerVerdict(layer, {
        check: 'aggregate-wiring', index, path: expected.path, wired: wiringMatched,
      })
    }
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
    recordLayerVerdict('登记制', { check: 'aggregate-reverse', path: line.path, matched })
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
    recordLayerVerdict('登记制', {
      check: 'contract-flags', path: entry.path,
      missing: ['--self-test', '--self-check', '--dump-criteria'].filter(flag => !source.includes(flag)).length,
    })
  }
  recordLayerVerdict('登记制', { check: 'registry-summary', onDisk: onDisk.length, wired: aggregateLines.length })
  note(`登记制: ${onDisk.length} 个可执行体全部登记、聚合层 ${aggregateLines.length} 条接线双向对账 ✓`)

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
    check(witnessed('skip-outlet', outlets.length === 1),
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
    // **判决观测**（R19A-03）：原始事实 = 声明/调用点/唯一出口/裸 SKIP 的计数与集合。
    recordLayerVerdict('环境缺失的原因码登记制', {
      check: 'skip-reasons', path: entry.path,
      declared: [...declaredSkip].sort().join(','),
      used: typeof outlet === 'string' && outlet !== ''
        ? [...new Set([...entrySource.matchAll(new RegExp(`\\b${outlet}\\(\\s*'([a-z][a-z-]*)'`, 'gu'))].map(match => match[1]))].sort().join(',')
        : '<无出口>',
      outlets: codeLines.filter(line => line.includes('SKIP[')).length,
      bare: codeLines.filter(line => /SKIP:(?!\])/u.test(line)).length,
    })
    note(`${entry.path.split('/').pop()}: SKIP 原因码 ${declaredSkip.join('/')} 声明/使用/唯一出口双向对账 ✓`)
  }

  // ---- ⑥d 组级判别力下限 ------------------------------------------------
  const groupJudgments = INTEGRATION_ENTRIES
    .filter(entry => typeof entry.aggregateName === 'string' && Number.isInteger(entry.minJudgments))
    .reduce((sum, entry) => sum + entry.minJudgments, 0)
  recordLayerVerdict('判别力下限', {
    check: 'group-floor', judgments: groupJudgments, floor: GROUP_MIN_JUDGMENTS,
  })
  check(witnessed('group-floor', groupJudgments >= GROUP_MIN_JUDGMENTS),
    `形态⑥: 聚合层的判定条数下限合计 ${groupJudgments} 条 < 登记下限 ${GROUP_MIN_JUDGMENTS} 条`
      + ' —— 判据被删/被换成恒 SKIP（棘轮只允许被"变多"越过；真要下调必须同时改 '
      + 'GROUP_MIN_JUDGMENTS 并写明理由）')
  // **R22 FIX-14 / E-02 常量折叠**：上面那条判据的分量全在 `GROUP_MIN_JUDGMENTS` 上 ——
  // 判决句一字不动、只把常量改成 0，`groupJudgments >= 0` 就恒真（第二十二轮 V7 泳道实测
  // `EXIT=0`）。判据：常量必须**等于登记表逐条算出的下限**且为正数（判定/记账同源），
  // 于是"改成恒真值"与"只改一侧"都当场红。
  const declaredGroupFloor = INTEGRATION_ENTRIES
    .filter(entry => typeof entry.aggregateName === 'string' && Number.isInteger(entry.minJudgments))
    .reduce((sum, entry) => sum + entry.minJudgments, 0)
  recordLayerVerdict('判别力下限', {
    check: 'group-floor-definition', floor: GROUP_MIN_JUDGMENTS, declared: declaredGroupFloor,
  })
  check(witnessed('group-floor-definition',
    GROUP_MIN_JUDGMENTS === declaredGroupFloor && GROUP_MIN_JUDGMENTS > 0),
    `形态⑥: 组级下限常量 GROUP_MIN_JUDGMENTS=${GROUP_MIN_JUDGMENTS} 与登记表逐条算出的 `
      + `${declaredGroupFloor} 不一致（或不是正数）—— 判决句原文在场不等于判据还在：`
      + '把常量改成 0/恒真值等于把这条判据掏空（R22 FIX-14 / E-02 的常量折叠形态）。'
      + '真要与登记表脱钩，必须同时改**常量定义**与这里的口径并写明理由。')

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
    recordLayerVerdict('判别力下限', {
      check: 'contract-rows', path: entry.path, minJudgments: entry.minJudgments, rows: registryRows.length,
    })
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
    recordLayerVerdict('判别力下限', {
      check: 'judged-runner-rows', path: entry.path, minJudgments: entry.minJudgments, rows: count,
    })
    if (count !== null) {
      check(entry.minJudgments === count,
        `形态⑥: ${entry.path} 的 \`minJudgments\`=${entry.minJudgments}，而判据表 ${table} 有 ${count} 条判据`
          + ' —— 判别力下限必须与判据表逐数相等（改判据表必须同步登记值）')
    }
  }
  note(`判别力下限: 聚合层 ${groupJudgments} 条判定（下限 ${GROUP_MIN_JUDGMENTS}）、`
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

/**
 * `python3` 的 **ast.parse 判决**（R19A-03：判决逻辑独立成函数，负例自证与真跑共用它）。
 * @param file - 绝对路径。
 * @returns 问题文本；通过时 `undefined`。
 */
function pythonSyntaxProblem(file) {
  const parsed = spawnSync('python3', [
    '-c',
    'import ast,sys;ast.parse(open(sys.argv[1],encoding="utf-8").read(),filename=sys.argv[1])',
    file,
  ], { encoding: 'utf8' })
  if (!witnessed('py-ast-parse', parsed.error === undefined && parsed.status === 0)) {
    return `${file}: Python 语法解析失败（${parsed.error?.message ?? parsed.stderr?.trim().slice(0, 200)}）`
  }
  return undefined
}
/**
 * `node --check` 的**判决**（与 {@link pythonSyntaxProblem} 同款：负例自证与真跑共用）。
 * @param file - 绝对路径。
 * @returns 问题文本；通过时 `undefined`。
 */
function moduleSyntaxProblem(file) {
  const parsed = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  if (!witnessed('node-check', parsed.status === 0)) {
    return `${file}: Node 语法解析失败（${(parsed.stderr ?? '').trim().split('\n').slice(0, 3).join(' / ')}）`
  }
  return undefined
}
const pyFiles = existsSync(join(ROOT, 'integration-tests')) ? pythonFiles(join(ROOT, 'integration-tests')) : []
if (pyFiles.length === 0) {
  fail('integration-tests/ 下一个 .py 都没有 —— 扫描面为 0，拒绝以"无可检查"当通过')
}
for (const file of pyFiles) {
  // **判决观测**（R19A-03，写在循环体内）：掏空这个循环 ⇒ 观测条数为 0 ⇒ 收尾红。
  const problem = pythonSyntaxProblem(join(ROOT, file))
  recordLayerVerdict('语法', { file, tool: 'python3 ast.parse', problem })
  if (problem !== undefined) fail(problem)
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
  const problem = moduleSyntaxProblem(join(ROOT, file))
  recordLayerVerdict('语法', { file, tool: 'node --check', problem })
  if (problem !== undefined) fail(problem)
}
/**
 * **负例自证**（R19A-03）：拿两个**故意写坏**的文件喂给上面那两个判决函数，必须都判红 ——
 * "这一层真的会红"因此有正向证据，而不是靠"我调用过它"（那正是 R19A-03 的现场形态）。
 */
{
  const controlDir = tempDir('check-integration-syntax-control-')
  const brokenPython = join(controlDir, 'broken.py')
  writeFileSync(brokenPython, 'def broken(:\n')
  const brokenModule = join(controlDir, 'broken.mjs')
  writeFileSync(brokenModule, 'const = ;\n')
  recordLayerVerdict('语法', {
    file: 'negative-control:broken.py', tool: 'python3 ast.parse',
    expectRed: true, redFlagged: pythonSyntaxProblem(brokenPython) !== undefined,
  })
  recordLayerVerdict('语法', {
    file: 'negative-control:broken.mjs', tool: 'node --check',
    expectRed: true, redFlagged: moduleSyntaxProblem(brokenModule) !== undefined,
  })
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
    coverageWitness.electronShotsAssertions = assertions.length
    recordLayerVerdict('electron-shots', {
      check: 'assertions-table', assertions: assertions.length, fixtures: fixtures.length,
      selfTestStatus: selfTest.status, selfTestOk: ok, selfTestTotal: total,
    })
    note(`electron-shots 判据表: --self-test ${ok}/${total} 条夹具、${assertions.length} 条判据`)
  }

  // 接线:运行期脚本必须逐条引用表里的 id，且不得自带常量真判据。
  //
  // 第三十轮 FIX-45 ②：`shotsSource.includes(id)` 证明的是"**文本在场**"—— 把
  // `report('deep-link-identity', …)` 包进 `if (false) { … }`（字面量一字不改）⇒ 本守卫
  // EXIT=0（第二十九轮 AC2 的 F-04，M6 变异实测）。改成**可达性**判据（形态与
  // {@link judgmentNeedleStatementProblem} 同源）。
  const shotsSource = existsSync(shotsPath) ? readFileSync(shotsPath, 'utf8') : ''
  for (const id of ids) {
    const reachability = typeof id === 'string'
      ? callSiteReachabilityProblem(shotsSource, id, 'js', 'report')
      : '判据 id 不是字符串'
    check(reachability === undefined,
      `形态⑤: electron-shots.mjs 的判据 ${JSON.stringify(id)} 在运行期**不可达** —— ${reachability}`
        + '\n  ⇒ 表里声明了但运行期真的不判（"文本在场"≠"运行期求值过"；'
        + '`if (false) { report(…) }` 保留字面量的形态在第三十轮 FIX-45 前是 EXIT=0）')
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
    note(`electron-shots 判定通道: --self-check ${ok}/${total} 条夹具经 report() 求值 ✓`)
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
    check(witnessed('runtime-mutation', mutantRun.status !== 0),
      `形态⑤: 变异 \`${breakCase.id}\`（${breakCase.label}）之后 \`--self-check\` 仍然 exit 0 `
      + `⇒ 判定通道的判据是假绿：${mutantOutput.trim().slice(-200)}`)
    check(breakCase.expect.test(mutantOutput),
      `形态⑤: 变异 \`${breakCase.id}\` 必须被**具名**咬住（期望输出匹配 ${breakCase.expect}）`
      + `：${mutantOutput.trim().slice(-200)}`)
    recordLayerVerdict('electron-shots', {
      check: 'runtime-mutation', case: breakCase.id,
      status: mutantRun.status, named: breakCase.expect.test(mutantOutput),
    })
    note(`electron-shots 判定通道: 变异「${breakCase.label}」⇒ --self-check 非零 ✓`)
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
  coverageWitness.aggregateSkipExit = aggregate.status
  // **判决观测**（R19A-03）：原始事实 = 实跑退出码 + 输出里有没有 RESULT: SKIP/PASS。
  recordLayerVerdict('聚合层三项全 SKIP ⇒ 77 且不报 PASS', {
    check: 'aggregate-skip', status: aggregate.status,
    reportedSkip: output.includes('RESULT: SKIP'), reportedPass: output.includes('RESULT: PASS'),
  })
  check(witnessed('aggregate-77', aggregate.status === 77), `形态⑥: 三项全 SKIP 时 run-all.sh 必须 exit 77（实际 ${aggregate.status}）：${detail}`)
  check(output.includes('RESULT: SKIP'), `形态⑥: 聚合层必须打印 RESULT: SKIP，实际 ${detail}`)
  check(!output.includes('RESULT: PASS'), `形态⑥: 一项都没跑起来时不得打印 RESULT: PASS，实际 ${detail}`)
  note('聚合层：三项全 SKIP ⇒ exit 77 / RESULT: SKIP ✓')
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
  if (!witnessed('self-test-total', ok === total)) fail(`${test.path} --self-test: ${ok}/${total} —— 有判据夹具不符合预期`)
  if (total < test.minCases) {
    fail(`${test.path} --self-test 只有 ${total} 条判据夹具（下限 ${test.minCases}）—— 判据被删到没有判别力`)
  }
  coverageWitness.contractSelfTestFixtures += total
  // **判决观测**（R19A-03）：原始事实 = 实跑退出码 / 夹具通过数 / 下限。
  recordLayerVerdict('契约判据本体自证', {
    check: 'self-test', id: test.id, status: selfTestRun.status, ok, total, minCases: test.minCases,
  })
  note(`${test.id}: --self-test ${ok}/${total} 条夹具`)

  // ---- ③b 纯单元级：`follow()` 对 Location **三种形态**的解析（FIX-45 ①③）--------
  //
  // 假网关是**端到端**腿，一轮只跑得到一种 Location 形态；而 `follow()` 的形态判定是三选一
  // （相对 / 绝对 / 深链）—— 只跑一两种时第三种回归就静默（这正是 F-01 的成因：真 Dex 用
  // 相对 Location，而夹具只发绝对 Location）。这个入口**不碰网络**：桩 opener 驱动**真实的**
  // `follow()`，三种形态各自钉一遍。去掉 `resolve_location()` 里的 `urljoin` ⇒ 相对那一例当场红
  // （实测：`redirect-form probe: 0/3`、exit 1）。
  if (test.id === 'dex') {
    const probe = runContractScript(scriptPathFor(test), ['--probe-redirect-forms'], ROOT)
    const probeSummary = /redirect-form probe: (\d+)\/(\d+) 种 Location 形态符合预期/u.exec(probe.output)
    const probeOk = probe.status === 0 && probeSummary !== null
      && probeSummary[1] === probeSummary[2] && Number(probeSummary[2]) >= 3
    check(probeOk,
      `${test.path} --probe-redirect-forms 必须 exit 0 且**三种** Location 形态（相对/绝对/深链）`
        + `逐条符合预期（实际 exit=${probe.status}）：${probe.output.trim().slice(-400)}`)
    recordLayerVerdict('契约判据本体自证', {
      check: 'redirect-forms', id: test.id, status: probe.status,
      formsJudged: probeSummary === null ? 0 : Number(probeSummary[2]),
      formsPassed: probeSummary === null ? -1 : Number(probeSummary[1]),
    })
    if (probeOk) {
      note(`${test.id}: --probe-redirect-forms ${probeSummary[1]}/${probeSummary[2]} 种 Location 形态 ✓`)
    }
  }

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
    check(witnessed('criteria-ids', observedIds.join(',') === expectedIds.join(',')),
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
    recordLayerVerdict('契约判据表', {
      check: 'criteria-table', id: test.id, rows: criteria.length,
      idsMatch: observedIds.join(',') === expectedIds.join(','),
      reportedFixtures: Number(dumped.fixtures), fixtures: total,
    })
    note(`${test.id}: 判据表 ${criteria.length} 条 / 逐 id 正负例条数对账 ✓`)
  }

  // ---- ② 运行期逐条引用（**可达性**，不是文本存在性）------------------------
  //
  // 第三十轮 FIX-45 ②：原判据只证明"以该 id 为首参的调用点在**文本**里"，证明不了
  // "这条判据在**运行期**真的被求值"。现场（第二十九轮 AC2 的 F-04，P1，两处实跑）：
  //   `reporter.report('deep-link-identity', …)` 的字面量保留、只包进 `if False:` ⇒ 本守卫
  //   **EXIT=0**；而同一条腿对**错误身份**的 SSO 报 `RESULT: PASS`（6 ✓ 而非 7 ✓），
  //   原件对同一网关正确 FAIL。⇒ 文本面照旧逐个报红，可达性面由
  //   {@link callSiteReachabilityProblem} 判；**行为面**由 `dex-wrong-identity` 场景判。
  const callSites = [...source.matchAll(
    /([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\(\s*(['"])([^'"]+)\2\s*,/gu,
  )].filter(match => expectedIds.includes(match[3]))
  const citedIds = new Set(callSites.map(match => match[3]))
  for (const id of expectedIds) {
    check(citedIds.has(id),
      `形态⑧: ${test.path} 没有引用判据 ${JSON.stringify(id)}`
        + ' ⇒ 表里声明了但运行期不判（掏空的另一种写法）')
    const reachability = callSiteReachabilityProblem(source, id, 'py', 'reporter.report')
    check(reachability === undefined,
      `形态⑧: ${test.path} 的判据 ${JSON.stringify(id)} 在运行期**不可达** —— ${reachability}`
        + '\n  ⇒ "字面量在场"不等于"运行期求值过"（第三十轮 FIX-45 ②：`if False:` 包住调用点，'
        + '保留字面量，守卫曾 EXIT=0 且该条腿对错误身份报 PASS）')
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
  check(witnessed('self-check-status', selfCheckRun.status === 0),
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
    coverageWitness.contractSelfCheckFixtures += checkTotal
    recordLayerVerdict('契约判定通道自证', {
      check: 'self-check', id: test.id, status: selfCheckRun.status, ok: checkOk, total: checkTotal,
    })
    note(`${test.id}: 判定通道 --self-check ${checkOk}/${checkTotal} 条夹具经 report() 求值 ✓`)
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
    coverageWitness.contractMutations += 1
    const mutant = runContractScript(tree.script, ['--self-test'], tree.dir)
    // **判决观测**（R19A-03①）：原始事实 = 变异体的退出码 + 输出里有没有具名判据 id。
    // 收尾会**重新判决**这些原始事实 —— 于是"保留 `+= 1`、把下面那句 check 掏成 `check(true)`"
    // 这种最自然的编辑动作会当场红（观测里的 status/named 没变，收尾的判决不成立）。
    recordLayerVerdict('契约端到端变异', {
      check: 'criteria-tautology', case: `${test.id}:${id}`,
      status: mutant.status, named: new RegExp(id, 'u').test(mutant.output),
    })
    check(witnessed('criteria-tautology', mutant.status !== 0),
      `形态⑧: 变异 \`criteria-tautology:${test.id}:${id}\`（把判据 ${id} 的 evaluate 掏成 `
      + '`return []`）之后 `--self-test` 仍然 exit 0 ⇒ 判据是假绿（这正是 F-01 的现场形态）')
    check(new RegExp(id, 'u').test(mutant.output),
      `形态⑧: 变异 \`criteria-tautology:${test.id}:${id}\` 必须被**具名**咬住`
        + `（期望输出里出现判据 id）:${mutant.output.trim().slice(-200)}`)
  }
  note(`${test.id}: 变异「逐条判据 evaluate 掏成 return []」×${expectedIds.length} ⇒ --self-test 全部非零且具名 ✓`)

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
    recordLayerVerdict('契约端到端变异', {
      check: 'kit-break', case: breakCase.id,
      status: mutant.status, named: breakCase.expect.test(mutant.output),
    })
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
    note(`${test.id}: 变异「${breakCase.label}」⇒ ${breakCase.command} 非零 ✓`)
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
      note(`${test.id}: 变异「${CONTRACT_RUNTIME_WRAPPER_BREAK.label}」⇒ --self-check 非零 ✓`)
    }
  }
}

/**
 * 一个 `Location` 头的**形态**（第三十轮 FIX-45 ①③ 的取值域）。
 *
 * 三档，与 `follow()` 的形态判定一一对应：
 *   · `http-absolute` —— 带 `http(s)://` scheme（跨 origin 那一跳只能是它）；
 *   · `deep-link`     —— **自定义 scheme**（`picoaide://auth?token=…`）= 桌面深链；
 *   · `relative`      —— 路径 / 查询 / 片段（`/dex/approval?…`）⇒ **必须按当前 URL 归一化**，
 *                        它不是深链（真 Dex 的 `/auth` → `/auth/local` 就是这一档）。
 * @param location - `Location` 头的原值。
 * @returns 形态名。
 */
function locationFormOf(location) {
  const text = String(location ?? '')
  if (/^https?:\/\//iu.test(text)) return 'http-absolute'
  if (/^[a-z][a-z0-9+.-]*:/iu.test(text)) return 'deep-link'
  return 'relative'
}

/** 把可能很长的子进程输出压成一行（诊断用，不参与判据）。 */
function selfTestOutputFree(output) {
  return JSON.stringify(String(output).trim().slice(-200))
}

// ---------------------------------------------------------------------------
// 2b. **可达性判据的自证**（第三十轮 FIX-45 ②）
//
// 真仓里的调用点**全部可达**（否则门禁本来就是红的）⇒ "判据退化成 `return undefined`"
// 这种掏空在真仓上**不可见**（与 `constantBlockHeaderProbeProblem` 同一处境）。这里把该红/
// 该绿的形态做成合成样本，逐条喂给**生产路径上的同一个函数**：
//   · 该红：`if False:` / `while False:` / 早退死代码 / `for _ in []:` / `if (false) {`
//     / `for (const _ of []) {` / `if (false) report(…)` / `cond && report(…)`；
//   · 该绿（**误红会让判据无法使用**）：`if not reporter.report(…)`（调用点就是条件）、
//     `if approval_required:` / `if (twoStep) {`（自由变量求不出常量）、`} else {` 分支里的
//     调用点（真仓 `electron-shots.mjs:712` 就在 else 里）、顶层语句。
// ---------------------------------------------------------------------------
{
  const py = body => `def main():\n${body}\n`
  const js = body => `function f() {\n${body}\n}\n`
  const cases = [
    ['py · if False: 包住调用点', py("    if False:\n        reporter.report('probe', {'x': 1})"),
      'py', 'reporter.report', 'probe', true],
    ['py · while False: 包住调用点', py("    while False:\n        reporter.report('probe', {'x': 1})"),
      'py', 'reporter.report', 'probe', true],
    ['py · 无条件早退之后的死代码', py("    return finish()\n    reporter.report('probe', {'x': 1})"),
      'py', 'reporter.report', 'probe', true],
    ['py · for _ in []: 包住调用点', py("    for _ in []:\n        reporter.report('probe', {'x': 1})"),
      'py', 'reporter.report', 'probe', true],
    ['py · 正当：`if not reporter.report(…)`（调用点就是条件）',
      py("    if not reporter.report('probe', {'x': 1}):\n        return finish()"),
      'py', 'reporter.report', 'probe', false],
    ['py · 正当：自由变量的条件分支',
      py("    if approval_required:\n        reporter.report('probe', {'x': 1})"),
      'py', 'reporter.report', 'probe', false],
    ['py · 正当：顶层语句', py("    reporter.report('probe', {'x': 1})"),
      'py', 'reporter.report', 'probe', false],
    ['js · if (false) { 包住调用点', js("  if (false) {\n    report('probe', { x: 1 })\n  }"),
      'js', 'report', 'probe', true],
    ['js · for (const _ of []) { 包住调用点', js("  for (const _ of []) {\n    report('probe', { x: 1 })\n  }"),
      'js', 'report', 'probe', true],
    ['js · 同一行恒假条件（`if (false) report(…)`）', js("  if (false) report('probe', { x: 1 })"),
      'js', 'report', 'probe', true],
    ['js · 悬空运算符（`cond && report(…)`）', js("  cond &&\n    report('probe', { x: 1 })"),
      'js', 'report', 'probe', true],
    ['js · 正当：`} else {` 分支里的调用点（真仓 electron-shots.mjs:712 就是这个形态）',
      js("  if (step1) {\n    report('other', { x: 1 })\n  } else {\n    report('probe', { x: 2 })\n  }"),
      'js', 'report', 'probe', false],
    ['js · 正当：自由变量的条件块', js("  if (twoStep) {\n    report('probe', { x: 1 })\n  }"),
      'js', 'report', 'probe', false],
    ['js · 正当：顶层语句', js("  report('probe', { x: 1 })"),
      'js', 'report', 'probe', false],
  ]
  const wrong = []
  for (const [why, text, language, callee, id, expectProblem] of cases) {
    const problem = callSiteReachabilityProblem(text, id, language, callee)
    if ((problem !== undefined) !== expectProblem) {
      wrong.push(`${why} ⇒ ${problem === undefined ? '放行（漏）' : `判红（误红）：${problem}`}`)
    }
  }
  check(wrong.length === 0,
    'FIX-45 ② 可达性判据自证不成立（该红的没红 / 正当的误红）：\n    ' + wrong.join('\n    '))
  if (wrong.length === 0) {
    note(`可达性判据自证: ${cases.length} 条合成样本（恒假块头 / 空迭代域 / 早退死代码 / 行内恒假 / `
      + '悬空运算符 必红；`if not report(…)` / else 分支 / 自由变量条件 / 顶层 必绿）✓')
  }
}

// ---------------------------------------------------------------------------
// 3. 假网关：按真契约应答（不需要 Docker / PG / IdP）
// ---------------------------------------------------------------------------
const SCENARIOS = [
  {
    scenario: 'good', test: CONTRACT_TESTS[0], expect: 0,
    // **Location 形态的登记值**（第三十轮 FIX-45 ①③）：这一腿的假网关必须在运行期**真的**
    // 发出过该形态的 Location，否则判红 —— 只写"我声明了"等于把覆盖面的自我陈述当判据。
    locationForm: 'http-absolute',
    label: '按真契约应答（IdP 内部跳转用**绝对** Location）⇒ dex 必须通过',
  },
  {
    scenario: 'dex-relative-location', test: CONTRACT_TESTS[0], expect: 0,
    locationForm: 'relative',
    must: /✓ \[2\]/u,
    label: '真 Dex 形态：IdP 内部跳转用**相对** Location ⇒ dex 必须通过'
      + '（`follow()` 少了 `urljoin` 就把它当桌面深链，这条腿当场红）',
  },
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
    // **行为级判据**（第三十轮 FIX-45 ②）：`deep-link-identity` 是 dex 里唯一一条
    // **安全相关**的判据（深链 token 必须能登录**且身份必须是本次登录账号**）。这条场景让
    // token **有效**、`/auth/me` 回**别人** ⇒ 判据必须 FAIL。把该调用点变成不可达
    // （`if False:` / 早退 / 条件化）时，这条腿会从 FAIL 变成 PASS ⇒ 当场红。
    // 判据面（可达性）与行为面互为补充：前者判"文本形态"，后者判"结论真的变了"。
    scenario: 'dex-wrong-identity', test: CONTRACT_TESTS[0], expect: 1,
    must: /身份/u, locationForm: 'http-absolute',
    label: '深链 token 有效但 /auth/me 回的是**别人** ⇒ dex 必须失败'
      + '（把 deep-link-identity 弄成不可达时这条腿会变 PASS —— 行为级判据）',
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

/**
 * 一个假网关场景的**判决**（R19A-03：判决本体独立成函数，真跑与负例自证共用）。
 *
 * 为什么必须独立成函数：见证如果只是"我跑过这条场景"，那么"把判决掏空、循环照跑"就既能
 * 保住见证、又能让守卫全绿（R19A-03 的现场）。现在的见证是**原始事实**
 * （`status` 与 `violations`），收尾按同一套规则重新判决 —— 掏空判决 ⇒ 违规照样被记下 ⇒ 红。
 * @param item - {@link SCENARIOS} 的一项。
 * @param status - 契约脚本的真实退出码。
 * @param output - 契约脚本的完整输出。
 * @param emittedForms - 这一轮假网关**真的发出去过**的 Location 形态（第三十轮 FIX-45 ①；
 *   不传 = 不判该格，负例自证的合成观测就是这么调的）。
 * @returns 违规原因列表（空 = 通过）。
 */
function scenarioViolations(item, status, output, emittedForms) {
  const detail = String(output).trim().split('\n').slice(-6).join(' / ')
  const violations = []
  if (status !== item.expect) {
    violations.push(`期望 exit ${item.expect}，实际 ${status}：${detail}`)
    return violations
  }
  if (item.locationForm !== undefined && emittedForms !== undefined) {
    const forms = Array.isArray(emittedForms) ? emittedForms : []
    if (!forms.includes(item.locationForm)) {
      violations.push(`这一腿声明的 Location 形态是 \`${item.locationForm}\`，而假网关这一轮`
        + `**一次都没发出过**该形态（实际 ${forms.length > 0 ? forms.join(', ') : '没有任何重定向'}）`
        + ' ⇒ 夹具被改成单一形态后，"两种形态都被覆盖"就只剩一句自我陈述')
      return violations
    }
  }
  if (item.must !== undefined && !item.must.test(output)) {
    violations.push(`输出里没有 ${item.must}：${detail}`)
    return violations
  }
  if (item.mustNot !== undefined && item.mustNot.test(output)) {
    violations.push(`输出里出现了不该有的 ${item.mustNot}：${detail}`)
    return violations
  }
  if (item.mustCode !== undefined) {
    // SKIP 必须**具名**（V13-C R-2）：输出的 SKIP 行必须带上登记过的原因码，
    // 且必须是这个触发条件对应的那一个（拿别的原因码顶替 ⇒ 红）。
    const emitted = [...String(output).matchAll(/SKIP\[([a-z][a-z-]*)\]/gu)].map(match => match[1])
    if (!emitted.includes(item.mustCode)) {
      violations.push(`输出里的 SKIP 没有登记过的原因码 `
        + `\`SKIP[${item.mustCode}]:\`（实际 ${emitted.length > 0 ? emitted.map(code => `SKIP[${code}]`).join(', ') : '没有任何具名 SKIP'}）：${detail}`)
      return violations
    }
    const unknown = emitted.filter(code => !SKIP_REASON_CODES.has(code))
    if (unknown.length > 0) {
      violations.push(`输出了**未登记**的 SKIP 原因码：${unknown.join(', ')}`
        + `（已登记：${[...SKIP_REASON_CODES.keys()].join(', ')}）`)
    }
  }
  return violations
}
// **负例自证**（R19A-03）：同一套判决喂一个**故意做坏**的观测（退出码与期望不符），必须判红。
recordLayerVerdict('假网关场景', {
  check: 'negative-control',
  scenario: SCENARIOS[0].scenario, test: SCENARIOS[0].test.id,
  status: SCENARIOS[0].expect === 0 ? 1 : 0, expect: SCENARIOS[0].expect,
  violations: scenarioViolations(SCENARIOS[0], SCENARIOS[0].expect === 0 ? 1 : 0, ''),
})
/**
 * dex 各腿**运行期真的发出去过**的 Location 形态（第三十轮 FIX-45 ①③ 的事实来源）。
 * 注意它记的是 Location 头本身，不是 `SCENARIOS` 的表长。
 * @type {Set<string>}
 */
const observedDexLocationForms = new Set()
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
    // 形态覆盖的**原始事实**：这一轮这个假网关真的发出去过哪些形态的 Location。
    const emittedForms = (gateway.emittedLocations ?? []).map(locationFormOf)
    if (item.test === CONTRACT_TESTS[0]) {
      for (const form of emittedForms) observedDexLocationForms.add(form)
    }
    const violations = scenarioViolations(item, status, output, emittedForms)
    recordLayerVerdict('假网关场景', {
      check: 'scenario', scenario: item.scenario, test: item.test.id, status, expect: item.expect, violations,
    })
    if (!witnessed('scenario-violations', violations.length === 0)) {
      for (const violation of violations) fail(`[${item.scenario}] ${item.label} —— ${violation}`)
      continue
    }
    note(`[${item.scenario}] ${item.test.id}: exit ${status} ✓`)
  } finally {
    await gateway.close()
  }
}

// ---------------------------------------------------------------------------
// 3b. **Location 的两种形态都被覆盖**（第三十轮 FIX-45 ①③）
//
// 现场（第二十九轮 AC2 的 F-01，P1）：真 Dex 的 `/auth` 用 **302 + 相对 Location**
// （`/auth/local?…`），而 `follow()` 把"非 http(s) 的 Location"一律当桌面深链 ⇒ 判据 [2]
// 拿到 `Found` 中间页、`RESULT: FAIL`；**而守卫的假网关一律返回绝对 Location ⇒ 门禁永远绿**
// （判据自洽型假绿：夹具与判据出自同一份假设）。
//
// 判据三条腿，缺一不可：
//   ① 每条腿的形态是**登记值**（`SCENARIOS[].locationForm`），且该腿的假网关必须在运行期
//      **真的发出过**该形态 —— 已经并进 {@link scenarioViolations}（与退出码同一套判决）；
//   ② 跨腿：dex 的腿合起来必须同时覆盖 `http-absolute` 与 `relative`（下面这一格）；
//   ③ 纯单元级：`dex-sso-test.py --probe-redirect-forms` 用桩 opener 驱动**真实的**
//      `follow()`，把相对 / 绝对 / 深链三种形态各自钉一遍（不碰网络）。
// 注意 ② 的事实来源是**运行期发出的 Location 头**，不是 `SCENARIOS` 表长 —— 删掉相对那条腿，
// 集合里少了 `relative`（而不是"表短了一条"）。
// ---------------------------------------------------------------------------
{
  const required = ['http-absolute', 'relative']
  const missing = required.filter(form => !observedDexLocationForms.has(form))
  const violations = missing.length === 0
    ? []
    : [`dex 假网关这一轮**没有覆盖**这些 Location 形态：${missing.join(', ')}`
      + `（实际发出过 ${[...observedDexLocationForms].join(', ') || '(无)'}）`]
  recordLayerVerdict('假网关场景', { check: 'location-forms', forms: [...observedDexLocationForms], violations })
  if (violations.length === 0) {
    note(`Location 形态覆盖: ${[...observedDexLocationForms].sort().join(' / ')}（绝对 + 相对各一条腿）✓`)
  } else {
    for (const violation of violations) fail(`[Location 形态覆盖] ${violation}`)
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
// 第十六轮（R16-W）把这条判据的**语义反过来**（`temp/r16/A/REPORT.md` 的 18 种形态证明
// "枚举我认识的包装词"不闭合）：命令位改成**登记制**（{@link CI_COMMAND_REGISTRY}：未登记即红、
// 死条目也红），跟随面从 5 个目录前缀扩到"仓内任何被跟踪路径"，载体扩到 Makefile 的
// `$(shell …)`、compose 的锚点/插值/`--entrypoint=`、`python -m` 模块、`node -e` 源码。
//
// **诚实边界（认账）**：闭包只跟随上面这些**执行形态** —— 不做 JS 语义分析、不跟随 `import`
// 边、不解析变量拼接出来的路径（`bash "$SOMEWHERE/run-all.sh"`、`spawn(cmd)` 看不见）。
// 它比"workflow 文本字面量"宽得多（别名/复合 action/包装链/载体的每一层都在面内），但不是
// "任意可执行路径"的完全覆盖；"文本面"（{@link E2E_CI_REFERENCE_PATTERN}）作为**独立第二张网**
// 保留：它形态无关（只要文本里出现就红），与执行面互补。**逐词登记只罩入口形态的命令位** ——
// 被跟随脚本正文里的"新工具名"不在登记面内（见凭据行的第 ③ 条口径）。
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
/**
 * 扫描面里**不是可执行脚本**的数据扩展名（显式口径：闭包不跟随它们）。
 *
 * `.yaml` 进扫描面是**语料**口径（`integration-tests/dex/config.yaml` 是夹具）——
 * 它不是"能被执行的东西"，闭包跟随它没有意义。
 */
const INTEGRATION_DATA_EXTENSIONS = ['.yaml', '.yml']
/**
 * 闭包**可跟随**的脚本扩展名 —— **从 {@link INTEGRATION_SCANNED_EXTENSIONS} 派生**。
 *
 * ## 为什么必须派生（第十四轮 V14-A 的 VA-05-F2，P1）
 *
 * 现场：`ci.yml` 加一步 `- run: python3 scripts/wrap-e2e.py`，脚本内
 * `subprocess.run(['bash','integration-tests/run-all.sh'])` ⇒ 三个守卫全 EXIT=0、
 * workflow 文本 0 token。原因：闭包只跟随 `.sh|bash|mjs|cjs|js|ts`，而
 * `check-install-integrity.mjs` 的**执行点推导**（从本文件的文本里抽
 * `INTEGRATION_SCANNED_EXTENSIONS`）**显式**把 `integration-tests/*.py` 当判据执行体 ——
 * **两个守卫的扩展名集合不一致**，`.py` 就从两张网之间掉了出去。
 *
 * 收口：闭包的跟随集**由本文件自己的扫描面派生**（`扫描面 ∖ 数据面`），
 * 于是"新增一个可执行扩展名"只有**一处**要改，而 `check-install-integrity.mjs`
 * 从同一份 `INTEGRATION_SCANNED_EXTENSIONS` 字面量派生它的执行点集合 —— 两处同源。
 * JS/TS 家族（`.bash` / `.cjs` / `.js` / `.ts`）不在语法扫描面里（它们的语法闸门是
 * `node --check` / `tsc`），所以显式列在这里，并写清它们为什么可跟随。
 */
const CI_SURFACE_SCRIPT_EXTENSIONS = [
  ...INTEGRATION_SCANNED_EXTENSIONS.filter(extension => !INTEGRATION_DATA_EXTENSIONS.includes(extension)),
  '.bash', '.cjs', '.js', '.ts',
].sort()
/**
 * 闭包可跟随的**仓内文件路径**形态（命令位 / 参数位 / 实参窗口里的裸路径）。
 *
 * ## R16-W：跟随面从"5 个目录前缀"扩到"仓内任何路径"
 *
 * 修前它逐字要求 `scripts|integration-tests|packages|server|community` 前缀，于是
 * **仓根脚本**（`node r16a_runner.cjs`）、`cmd/`、`tools/`、`*.mk`、`justfile`、
 * `compose*.yml` 这些位置上的载体整族落在跟随面之外（R16A-09/10）。
 * 现在只要求"相对路径 + 属于闭包可跟随的扩展名"（{@link CI_SURFACE_SCRIPT_EXTENSIONS}），
 * 由调用方用 `options.exists()` 判定它是否真的在仓里；仓内**其它**形态的文件
 * （`.yml`/`.mk`/`Makefile`/无扩展名）由 `carrierKindOf()` 归类成 `makefile`/`data` 后同样跟随。
 */
const CI_SURFACE_SCRIPT_PATTERN = new RegExp(
  `^(?:[A-Za-z0-9_][A-Za-z0-9_@+.-]*/)*[A-Za-z0-9_@+.-]+\\.`
  + `(?:${CI_SURFACE_SCRIPT_EXTENSIONS.map(extension => extension.slice(1)).join('|')})$`, 'u')
/**
 * **包装链尽头的变量命令位**：闭包判不了它跑什么 ⇒ fail-closed 记红 —— 除非这一处
 * 逐字登记在这里（登记制 + **死条目双向对账**：登记项必须仍然真的命中，否则红）。
 *
 * 为什么需要这张表而不是"看见 `$` 就一律判红"：`timeout 60 "$SOME_BIN" …` 这种写法在本仓
 * 已有先例（`scripts/verify-wasm-client-only.sh` 拉 Electron 探针），把它判红等于让判据
 * 无法使用；而"把 `make` 藏进一个变量再经包装链调用"（`timeout 900 $R15A_TARGET`）确实是
 * 同族旁路。两者的形态**逐字相同** ⇒ 只能靠登记制区分：新出现的一律红，已认账的留痕。
 *
 * 每条 = `{ file, word, why }`；`word` 是包装链尽头那一位的**首词**（含 `$`）。
 *
 * **R18A-01（2026-09-25）**：这张表同时承担 {@link shellScriptPositionShape} 那一族
 * （`kind: 'shell-argument-unreadable'`，shell/`find -exec` 的**脚本位**读不懂）的登记 ——
 * 两族的判据形态不同（命令位 / 脚本位），但纪律相同：**逐处登记 + 死条目双向对账**。
 * 于是"解析不出名字就放过"依然没有分支，唯一的出口是**显式登记**（进 diff、可评审）。
 */
const CI_SURFACE_VARIABLE_COMMAND_ACK = [
  {
    file: 'scripts/verify-wasm-client-only.sh',
    word: '$@',
    why: '`run_with_timeout` 一类的实参转发（`timeout "$seconds" "$@"`）—— 被包装的是这个'
      + '**函数自己的参数**，不是"把端到端入口藏进变量"；调用点在同一文件的字面量行上，'
      + '由 token 网 / 文本网覆盖（该文件不在端到端入口的接线链上）。',
  },
  {
    file: 'scripts/ci-package-clients.sh',
    word: '$VERIFY_SCRIPT',
    why: '`node "$VERIFY_SCRIPT" …`：`VERIFY_SCRIPT` 在同一文件顶部由字面量赋值'
      + '（`VERIFY_SCRIPT="${CI_CHANNEL_VERIFY_SCRIPT:-packages/host/desktop/scripts/verify-channel-package.ts}"`），'
      + '那个字面量路径由 token 网跟随，所以闭包**看得到**它跑什么；变量只是为了本地回归注入桩。',
  },
  {
    file: 'scripts/verify-wasm-client-only.sh',
    word: '$ELECTRON_BIN',
    why: '真机探针用 `timeout "$PROBE_TIMEOUT" "$ELECTRON_BIN" --no-sandbox …` 拉起打包版'
      + ' Electron（第 6 组）—— 被包装的是 Electron 二进制，变量在同一脚本顶部由 `ELECTRON_BIN=` 赋值；'
      + '不接端到端入口（`integration-tests/run-all.sh` 不在这条链上）。',
  },
]
/**
 * **"先构建/生成、再执行"的脚本位登记表**（R20A-05）。
 *
 * ## 现场（R20A-05，P3 —— 静态判据 + 运行期生成的固有边界）
 *
 * ```bash
 * base64 -d scripts/u20-payload.b64 > scripts/u20-generated.sh
 * bash scripts/u20-generated.sh
 * ```
 *
 * 生成物在**检查期不存在**（载体跟随跟不出仓内文件 ⇒ 不跟随），载荷是不透明数据
 * （token 网里没有语义）⇒ 修前守卫 `EXIT=0`，而 tripwire 证明运行期真的执行了端到端入口。
 *
 * ## 判据（禁止"路径不存在就一律放过"）
 *
 * **命令位 / 脚本位**指向一个"字面、仓内相对、但**当前不存在**"的路径 ⇒ fail-closed 记红
 * （`missing-script-carrier`）。这一位与"参数位上跟不出的数据文件"不同：它是
 * "**要执行的程序**"，闭包读不到它就等于这一层看不见。
 * **R21 fix-6 / E-01 起不再区分"路径里有没有 `/`"**：`bash gen.sh` / `source gen.sh` /
 * `python3 gen.py`（生成物落在 CWD、按**裸文件名**执行）与 `bash scripts/gen.sh` **同判**
 * —— 修前那两个站点各带一个 `includes('/')` 前置条件，于是裸文件名整族隐形（实测三种形态
 * `EXIT=0`，而 tripwire 证明运行期真的执行了端到端入口）。
 *
 * 这一族**无法与"先构建再执行"区分**（`bash dist/x.sh` 是同样形态的正当写法），
 * 所以出路是**逐处登记**这张表（写明"由谁生成 + 哪一步生成"）—— 与
 * {@link CI_SURFACE_VARIABLE_COMMAND_ACK} 同款纪律：**死条目双向对账**（登记了却一次都没
 * 命中 ⇒ 红），登记项不会变成"看起来管得很宽"的摆设。
 *
 * 每条 = `{ file, word, why, approvedBy }`；`word` 是脚本位那一位**逐字**。
 */
const CI_SURFACE_GENERATED_SCRIPT_ACK = []
/**
 * **命令位"读不懂的形态"的登记表**（R17-X，R17A-01 的收口通道）。
 *
 * `{@link isUnreadableCommandShape}` 把"含 `$`/反引号且常量传播解析不出字面量"的命令位
 * 一律 fail-closed。这条规则会碰到**闭包结构上解析不了、但形态本身合法**的写法 ——
 * 本仓的现场是 GitHub Actions 表达式：`"${{ steps.frozen-launchers.outputs.node }}" <脚本>`
 * （ci.yml 有 16 处），取值由 `scripts/check-frozen-launchers.mjs` 那个 step 的输出提供，
 * 是**冻结过的绝对路径**。闭包不解析 GitHub 表达式（那要读整个 workflow 的数据流），
 * 所以这类写法**逐处登记**：新出现的一律红，已认账的留痕。
 *
 * 与 {@link CI_SURFACE_VARIABLE_COMMAND_ACK} 同款纪律：**死条目双向对账**（登记了却
 * 一次都没命中 ⇒ 红），所以这张表不会变成"看起来管得很宽"的摆设。
 *
 * 每条 = `{ file, word, why, approvedBy }`；`word` 是命令位首词**逐字**。
 */
const CI_SURFACE_COMMAND_SHAPE_ACK = [
  {
    file: '.github/workflows/ci.yml',
    word: '${{ steps.frozen-launchers.outputs.node }}',
    why: '冻结启动器探针给的 **node 绝对路径**（`scripts/check-frozen-launchers.mjs` 的 step 输出）：'
      + '它的作用正是"此后的每一步都用冻结过的 node"，所以命令位上出现它是这条判据的**设计意图**，'
      + '而不是"把命令藏进变量"。闭包不解析 GitHub 表达式 ⇒ 逐处登记。',
    approvedBy: 'R17-X（本泳道）',
  },
  {
    file: '.github/workflows/ci.yml',
    word: '${{ steps.frozen-launchers.outputs.git }}',
    why: '同上，冻结的 **git 绝对路径**（`git show HEAD:<文件>` / `git fetch` 两处）。',
    approvedBy: 'R17-X（本泳道）',
  },
  {
    file: '.github/workflows/ci.yml',
    word: '${{ steps.frozen-launchers.outputs.interp }}',
    why: '同上，冻结的 **shell 解释器绝对路径**（`<解释器> scripts/ci-release-*.sh` 三处 + '
      + '`scripts/verify-wasm-client-only.sh` 一处）。',
    approvedBy: 'R17-X（本泳道）',
  },
]
/**
 * **包运行器**（`npx` / `bunx` / `npm exec` / `yarn dlx` / `pnpm dlx` / `bun x`）的语义。
 *
 * 它后面那一位是**包名 / 包内 bin**（由包管理器在外部命名空间里解析），不是本仓的
 * 可执行名 —— 所以它不过 {@link CI_COMMAND_REGISTRY} 的逐词登记（修前 `npx eslint .`
 * 会被判成"未登记的可执行名 `eslint`"，属 R17A-04 的误报）。
 *
 * 但**遮蔽真命令名**是另一回事：`npx make …` / `npx bash -c …` 这种"用包运行器把真命令
 * 换个名字"的形态仍然 fail-closed（`package-runner-command`）—— 判据是"这一位是不是闭包
 * 认识的命令词"。`npm exec -- <命令>` 的 `--` 之后是**真命令**，照常走登记制。
 */
const PACKAGE_RUNNER_WORDS = new Set([
  'npx', 'bunx', 'npm exec', 'npm x', 'yarn dlx', 'yarn exec', 'pnpm exec', 'pnpm dlx', 'bun x',
])
/**
 * **命令位上的外部 Python 模块**（`python3 -m <模块>`）—— R17A-04 的另一半。
 *
 * `-m` 的取值是模块名，绝大多数是**标准库/第三方**（`pip` / `json.tool` / `pytest` / `http.server`），
 * 仓内本来就没有对应文件；修前一律按"仓内载体"解析，找不到 `*.py`/`__main__.py` 就红
 * （`carrier-module-missing`）。现在的判据是**仓内归属**：模块的顶层段在仓里**存在**
 * （`<段>.py` / `<段>/__init__.py` / `<段>/`）⇒ 必须解析出载体，否则红；不存在 ⇒ 按外部模块
 * 处理（闭包结构上跟随不了，但它是"运行期从 site-packages 里来的"，不是端到端入口的载体）。
 * 不设白名单枚举：那要么是死条目（本仓当前没有这类写法 ⇒ 加进去就红），要么只是换个名字的
 * "永远放行"（`python3 -m <任何东西>` 都能过）。
 */
/** 闭包深度上限与节点上限（超限 fail-loud）。 */
const CI_SURFACE_MAX_HOPS = 8
const CI_SURFACE_MAX_NODES = 400
/**
 * **文本第二张网**适用的脚本体扩展名：shell 与 Python 的正体本身就是"脚本"，
 * 里面**逐字**写出端到端入口就是执行意图（与 `run-all.sh` 里的写法同族）。
 *
 * 为什么 JS/TS 不在内：JS 正体里的字符串绝大多数是数据/夹具（本守卫自己的
 * `INTEGRATION_ENTRIES` 就是反例），把它算进"提到"会让判据退化成文本判据。
 * `CI_SURFACE_TEXT_NET_SCRIPT_EXTENSIONS` 上必须有自证：扫描面里的**非 JS 家族**
 * 可执行扩展名一个都不能少（R15A-03 的 C5/C6 正是 `.py` 缺在这里）。
 */
const CI_SURFACE_TEXT_NET_SCRIPT_EXTENSIONS = [...INTEGRATION_SCANNED_EXTENSIONS, '.bash']
  .filter(extension => !INTEGRATION_DATA_EXTENSIONS.includes(extension))
  .filter(extension => !['.mjs', '.cjs', '.js', '.ts'].includes(extension))
/** JS 正文里"执行调用"的实参窗口长度 / 调用名。 */
const CI_SURFACE_ARG_WINDOW = 400
const CI_SURFACE_EXEC_CALL = /\b(?:spawn|spawnSync|execFile|execFileSync|exec|execSync|fork)\s*\(/gu
/** Python 正文里"执行调用"的形态（`subprocess.run(['bash', …])` / `os.system(…)`）。 */
const CI_SURFACE_PY_EXEC_CALL = /\b(?:subprocess\.(?:run|call|check_call|check_output|Popen)|os\.(?:system|popen|execv|execve|execvp|execvpe|execv|execl|execle|execlp|execlpe|spawnv|spawnve|spawnvp|spawnvpe)|runpy\.run_path|runpy\.run_module|importlib\.import_module|importlib\.util\.spec_from_file_location|exec|eval|compile|__import__)\s*\(/gu
/**
 * `make` 调用的**递归词**：`$(MAKE)` 在解析前先归一成它，于是"命令位是不是 make"
 * 与"`-C` / `-f` 的值位"两件事都能在同一套词法里判。
 */
const MAKE_RECURSIVE_WORD = '\u0000MAKE\u0000'
/** `make` 的值位旗标：**其后一个 token 是取值，不是目标**。 */
const MAKE_VALUE_FLAGS = new Set([
  '-C', '-f', '-I', '-o', '-W', '--directory', '--file', '--makefile', '--include-dir',
  '--old-file', '--new-file', '--assume-old', '--assume-new', '--eval', '--load-average', '--max-load',
])
/**
 * 命令位**包装链**的登记表（第十五轮 R15A-03 建立、第十六轮 R16-W **语义反转**）。
 *
 * ## 判据反过来之前（R16-A 的 18 种形态，全部实测"守卫绿而 CI 真的执行"）
 *
 * 这张表修前是一份**黑名单**：登记二十个包装词逐层剥到命令位，剥不到就把那一位当普通
 * 命令放过。`temp/r16/A/REPORT.md` 证明这个方向**不闭合**，缺口分三类：
 *
 *   ① **已登记词的语法被建模错**：`env -S '<命令文本>'` 的取值就是命令、`flock <文件>` /
 *      `taskset <掩码>` 的位置参数没建、`npm exec --call='…'` 被 `!word.includes('=')`
 *      静默丢弃、`bash --noprofile --norc -c` 被长选项打断（循环只看 `-` 开头的短选项）；
 *   ② **未登记的词整族漏网**：`xargs -a F -I{} make …` / `find … -exec make … \;` /
 *      `poetry run make …` / `just <recipe>` —— 命令藏在**参数位**；
 *   ③ **载体与间接层**：仓根脚本、`python3 -m <模块>`、`node -e "$(cat …)"`、Makefile 顶层
 *      `$(shell …)`、compose 的 `*锚点` / `${VAR}` 插值 / `--entrypoint=`。
 *
 * ## 现在的语义（登记制 + 读不懂就红）
 *
 * {@link unwrapCommandWords} 走到命令位之后，那一位必须满足三者之一，否则 **fail-closed
 * 记 problem**：
 *   · 在 {@link CI_COMMAND_REGISTRY} 里登记（每条带"为什么合法 + 由谁批准"）；
 *   · 是一条闭包能**跟随**的仓内脚本路径 / manifest 别名（由调用方扩张）；
 *   · 是闭包**自己会跟随的载体词**（`make` / compose / 解释器 / shell，见
 *     {@link COMMAND_CARRIER_WORDS}）。
 *
 * 所以这张表只回答"**这一位要不要继续剥、怎么剥**"，不再承担"我认不认识它" ——
 * 认不认识由登记表判，而"没登记"本身就是红。
 *
 * `valueFlags` = 该旗标**带走下一个词**（`timeout -k 5 …`）；`execFlags` = 该旗标的取值
 * **就是命令文本**（`npm exec -c "make …"`），按内层 shell 文本递归；`codeFlags` = 该旗标
 * 的取值是**另一种语言的源码文本**（`node -e '…'`）；`lookupFlags` = 这一位不是执行而是
 * 查询（`command -v make`），整条命令就此结束；`positional` = 固定个数的**位置参数**
 * （`timeout <时长>` / `flock <锁文件>` / `taskset <掩码>` / `chrt <优先级>`）；
 * `assignments` = 还要吃掉前缀里的 `VAR=值`（`env`）；`attachedOptionalFlags` = 取值可附着
 * 也可分离的旗标（`xargs -I{}` 与 `xargs -I {}` 都合法）。
 */
const COMMAND_WRAPPER_SPECS = new Map([
  // 直通型：`<词> [旗标…] <命令>`
  ['sudo', { valueFlags: ['-u', '-g', '-p', '-C', '-D', '-R', '-T', '-U', '-h', '--user', '--group', '--prompt', '--chdir', '--close-from', '--host', '--other-user', '--role', '--type'] }],
  ['doas', { valueFlags: ['-u', '-C'] }],
  ['time', { valueFlags: ['-o', '-f', '--output', '--format'] }],
  ['command', { valueFlags: [], lookupFlags: ['-v', '-V'] }],
  ['nohup', { valueFlags: [] }],
  ['exec', { valueFlags: ['-a'] }],
  ['nice', { valueFlags: ['-n', '--adjustment'] }],
  ['ionice', { valueFlags: ['-c', '-n', '-p', '-P', '-u'] }],
  ['setsid', { valueFlags: [] }],
  ['stdbuf', { valueFlags: ['-i', '-o', '-e'] }],
  // `chrt [选项] <优先级> <命令>` / `chrt [选项] -p <pid>`：**优先级是位置参数**，不是旗标取值。
  // R16A-03 的反证：修前 `-r` 被当成"带取值的旗标"，顺手吃掉了优先级 10，于是
  // `chrt -r 10 make …` 的命令位**恰好**落回 `make` —— 同一张表既能漏（flock）也能蒙对（chrt）。
  ['chrt', {
    valueFlags: ['-T', '-P', '-D', '-m', '--sched-runtime', '--sched-period', '--sched-deadline', '--max'],
    lookupFlags: ['-p', '--pid'], positional: 1,
  }],
  // `taskset [选项] <掩码> <命令>`：掩码是位置参数（R16A-03）。
  ['taskset', { valueFlags: ['-c'], lookupFlags: ['-p'], positional: 1 }],
  // `flock [选项] <文件|目录|fd> <命令>`：锁文件是位置参数；`-c` 的取值才是命令文本（R16A-02）。
  ['flock', {
    valueFlags: ['-w', '-E', '--wait', '--conflict-exit-code'], execFlags: ['-c'], positional: 1,
  }],
  ['watch', { valueFlags: ['-n', '-d', '-i', '--interval', '--differences'] }],
  // 取值型：旗标之后还有**固定个数**的位置参数（`timeout <时长> <命令>`）
  ['timeout', { valueFlags: ['-k', '-s', '--signal', '--kill-after'], positional: 1 }],
  // `env [-i] [-u 名] [名=值…] [-S '<命令文本>'] <命令>`：`-S/--split-string` 的**取值就是
  // 命令文本**（R16A-01：修前它在 valueFlags 里 ⇒ 命令文本被当普通取值吃掉、`heads` 变空、
  // 而且**连 problem 都不报**）。
  ['env', {
    valueFlags: ['-u', '-C', '--unset', '--chdir'], execFlags: ['-S', '--split-string'], assignments: true,
  }],
  // `xargs [选项] [命令 [初始参数…]]`：命令在**参数位**（R16A-06）。`-I/--replace` 的取值可附着。
  ['xargs', {
    valueFlags: ['-a', '-E', '-L', '-n', '-P', '-s', '-d', '--arg-file', '--eof', '--max-lines',
      '--max-args', '--max-procs', '--max-chars', '--delimiter', '--process-slot-var'],
    attachedOptionalFlags: ['-I', '--replace'],
  }],
  // `find … [-exec|-execdir|-ok|-okdir <命令> … {;|+}]`：命令在**参数位**（R16A-07）。
  ['find', { findExecFlags: ['-exec', '-execdir', '-ok', '-okdir'] }],
  // 解释器：`<词> [旗标…] [脚本 [参数…]]`。脚本路径由调用方按**参数位**规则跟随
  // （命令位的 `node file.mjs` / `python3 x.py` / `bash y.sh` 全走同一条路）。
  ['node', {
    valueFlags: ['-r', '--require', '--loader', '--import', '-C', '--conditions', '--env-file',
      '--env-file-if-exists', '--input-type', '--openssl-config', '--icu-data-dir', '--dns-result-order',
      '--redirect-warnings', '--inspect-port', '--disable-proto', '--watch-path', '--title'],
    codeFlags: ['-e', '--eval', '-p', '--print'], scriptPositional: true,
  }],
  ['python3', {
    valueFlags: ['-W', '-X', '--check-hash-based-pycs'], codeFlags: ['-c'], moduleFlags: ['-m'],
    scriptPositional: true,
  }],
  ['python', {
    valueFlags: ['-W', '-X', '--check-hash-based-pycs'], codeFlags: ['-c'], moduleFlags: ['-m'],
    scriptPositional: true,
  }],
  // 包运行器的 exec 面：`npx <命令>` / `bunx <命令>`（`--` 由通用规则吃掉）
  ['npx', { valueFlags: ['-p', '--package'], execFlags: ['-c', '--call'], packageRunnerBin: true }],
  ['bunx', { valueFlags: ['-p', '--package', '--bun'], packageRunnerBin: true }],
  // **字符串参数执行面**（R17-X，R17A-02）：`eval '<命令文本>'` / `trap '<命令文本>' <信号…>`。
  // 修前这两个词只在 `CI_STANDARD_COMMANDS` 里（"shell 内建"），包装表里没有 ⇒ 它们的**取值**
  // 不进任何一张网：`eval 'make -C <目录> <目标>'` 守卫 EXIT=0 而 CI 真的执行到入口（实测 5/5）。
  // `shellTextArgs` = "剩余全部实参拼起来就是一段 shell 文本"；`trapText` = "第一个实参是命令文本、
  // 其余是信号名"。
  ['eval', { valueFlags: [], shellTextArgs: true }],
  ['trap', { valueFlags: [], lookupFlags: ['-l', '-p'], trapText: true }],
  // **远端命令位**（R17-X，R17A-05）：`ssh [选项] <主机> <命令> [参数…]` —— 主机名是**位置参数**，
  // 它之后那一位才是命令位（`ssh <主机> make -C <目录> <目标>`）。
  ['ssh', {
    valueFlags: ['-o', '-i', '-p', '-l', '-F', '-J', '-L', '-R', '-D', '-b', '-c', '-m', '-e', '-E',
      '-Q', '-S', '-W', '-w', '-B', '-I', '-O', '--option', '--identity-file', '--port', '--login-name',
      '--jump-host', '--local-forward', '--remote-forward', '--dynamic-forward'],
    positional: 1,
  }],
])
/**
 * **容器运行器的子命令命令位**（R17-X，R17A-05）：`docker|podman run <镜像> <命令>` /
 * `exec <容器> <命令>`。修前 `docker` 是登记过的词、`run`/`exec` 又不是包装表成员 ⇒
 * 参数位上的命令位**不在任何一张网内**（`docker exec <容器> <命令>` 三形态守卫 EXIT=0）。
 *
 * 只建模 `run`/`exec`：其余子命令（`ps` / `logs` / `compose` / `rm` / `cp` / …）保持原样 ——
 * 其中 `docker compose … run` 另有专门跟随（{@link composeRunInvocations}）。
 * `positional` 是"命令之前还要吃掉的位置参数个数"（镜像 / 容器名）。
 *
 * `--entrypoint` 的取值**本身就是一段要跑的命令**（与 compose 那条同源），所以它在
 * `execFlags` 里：取值按内层 shell 文本递归，剩下的实参归它（不再当命令位判）。
 */
const CONTAINER_RUNNER_SPECS = new Map([
  ['docker', {
    valueFlags: ['-c', '-H', '--context', '--host', '--log-level', '-l', '--config',
      '--tlscacert', '--tlscert', '--tlskey'],
    subcommands: {
      run: {
        valueFlags: ['-e', '--env', '--env-file', '-v', '--volume', '--mount', '-p', '--publish',
          '-u', '--user', '-w', '--workdir', '--name', '--network', '--net', '--platform', '--label',
          '-h', '--hostname', '--add-host', '--dns', '--restart', '--health-cmd', '--log-driver',
          '--ulimit', '--cap-add', '--cap-drop', '--device', '--tmpfs', '--sysctl', '--stop-signal',
          '-a', '--attach', '--pull', '--cpus', '-m', '--memory', '--pid', '--ipc', '--shm-size'],
        execFlags: ['--entrypoint'],
        positional: 1,
      },
      exec: {
        valueFlags: ['-e', '--env', '--env-file', '-u', '--user', '-w', '--workdir',
          '--detach-keys', '--privileged'],
        positional: 1,
      },
    },
  }],
  ['podman', {
    valueFlags: ['-c', '-H', '--context', '--host', '--log-level', '-l', '--config'],
    subcommands: {
      run: {
        valueFlags: ['-e', '--env', '--env-file', '-v', '--volume', '--mount', '-p', '--publish',
          '-u', '--user', '-w', '--workdir', '--name', '--network', '--net', '--platform', '--label',
          '-h', '--hostname', '--add-host', '--dns', '--restart', '--health-cmd', '--log-driver',
          '--ulimit', '--cap-add', '--cap-drop', '--device', '--tmpfs', '--sysctl',
          '-a', '--attach', '--pull', '--cpus', '-m', '--memory'],
        execFlags: ['--entrypoint'],
        positional: 1,
      },
      exec: {
        valueFlags: ['-e', '--env', '--env-file', '-u', '--user', '-w', '--workdir', '--detach-keys'],
        positional: 1,
      },
    },
  }],
])
/** 两词包装（`<词1> <词2> …`）：登记表与单词表同形，命中后一起吃掉两个词。 */
const COMMAND_MULTI_WORD_WRAPPERS = new Map([
  ['npm exec', { valueFlags: ['-p', '--package'], execFlags: ['-c', '--call'], packageRunnerBin: true }],
  ['npm x', { valueFlags: ['-p', '--package'], execFlags: ['-c', '--call'], packageRunnerBin: true }],
  ['yarn dlx', { valueFlags: [], packageRunnerBin: true }],
  ['yarn exec', { valueFlags: [], packageRunnerBin: true }],
  ['pnpm exec', { valueFlags: ['-c', '--shell-mode'], packageRunnerBin: true }],
  ['pnpm dlx', { valueFlags: [], packageRunnerBin: true }],
  ['bun x', { valueFlags: ['-p', '--package', '--bun'], packageRunnerBin: true }],
  // 语言/任务运行器的 `run` 面（R16A-08）：`poetry run <命令>` —— 命令在**参数位**。
  ['poetry run', { valueFlags: ['--with', '--without', '-E', '--directory'] }],
  ['pipenv run', { valueFlags: ['-d', '--directory'] }],
  ['pdm run', { valueFlags: ['-p', '--project'] }],
  ['uv run', { valueFlags: ['--with', '--python', '--index', '--directory', '--project'] }],
  ['hatch run', {}],
  ['rye run', {}],
  ['conda run', { valueFlags: ['-n', '--name', '-p', '--prefix'] }],
])
/** shell 词：带 `-c` 时它的取值是**另一段 shell 文本**，要按同一套词法递归解析。 */
const COMMAND_SHELL_WORDS = new Set(['bash', 'sh', 'dash', 'zsh', 'ksh', 'ash'])
/** Python 解释器词（决定 `-c` 的取值按哪种语言的抽取器读）。 */
const COMMAND_PYTHON_WORDS = new Set(['python', 'python3'])
/**
 * 闭包**自己会跟随**的命令载体词 —— 它们出现在命令位时不需要登记表再写一遍理由，
 * 因为它们不是"放过"，而是"继续跟随"：`make` 走目标体、compose 走 compose 文件、
 * 解释器走**参数位**上的仓内脚本。{@link ciExecutionSurfaceSelfTest} 会断言这些词
 * 同时出现在 {@link CI_COMMAND_REGISTRY} 里（两张表不许漂移）。
 */
const COMMAND_CARRIER_WORDS = new Set([
  'make', 'gmake', 'docker', 'docker-compose', 'podman', 'node', 'python3', 'python',
  'npx', 'bunx', 'npm', 'yarn', 'pnpm', 'bun', 'corepack', 'go', 'cargo', 'rustup',
])
/**
 * 命令位**可执行名**的登记表（第十六轮 R16-W 的语义反转本体）。
 *
 * ## 它判什么
 *
 * 闭包命令位上的**每一个**可执行名都要在这里出现一次，条目自带"为什么合法 + 由谁批准"。
 * 没登记 ⇒ `unregistered-command` problem ⇒ 守卫红。这与
 * {@link E2E_CI_SURFACE_REGISTRY} 同款纪律：**死条目双向对账**（登记了却没在命令位上
 * 出现过 ⇒ 也红），所以这张表不会慢慢变成一份"看起来管得很宽"的摆设。
 *
 * ## 为什么这张表是"闭合"的，而旧的包装词黑名单不是
 *
 * 旧表枚举的是"**我认识哪些包装词**"—— 那是个无限集（任何能把命令放进参数位的程序都算
 * 包装：`xargs`/`find -exec`/`parallel`/`ssh`/`just`/`poetry`/…），漏一个就静默放行。
 * 这张表枚举的是"**本仓 CI 执行面上真的出现过哪些命令**"—— 这是个**有限且可枚举**的集
 * （由闭包自己算出来），而"没出现过的新词"默认红。
 *
 * ## 边界（认账）
 *
 * 登记只表示"这个词本身不是把命令藏进参数位的载体"的**人工判断**：例如 `docker` 被登记
 * 是因为本仓 CI 里它的参数位只有镜像名与 compose 子命令，而 `docker compose … run` 另有
 * 专门跟随（{@link composeServiceCommands}）。带 `$` 的参数位路径、路径形态的载体、
 * 以及所有 `.sh`/`.py` 正文里的字面量仍由各自的判据兜（见
 * {@link ciExecutionSurface} 的 `generic` 扫描）。
 *
 * 每条 = `{ word, class, why, approvedBy }`；`class` 只用于诊断输出。
 */
const CI_STANDARD_COMMANDS = new Set([
  // shell 内建 / 关键字（作用于 shell 自身状态，参数位不接受"可执行名"）
  'echo', 'printf', 'read', 'cd', 'pwd', 'export', 'unset', 'set', 'shift', 'local', 'declare',
  'trap', 'true', 'false', 'test', '[', ':', 'exit', 'return', 'eval', 'source', '.', 'type',
  'hash', 'ulimit', 'umask', 'wait', 'kill', 'jobs', 'bg', 'fg', 'break', 'continue', 'alias',
  'dirs', 'pushd', 'popd', 'let', 'mapfile', 'readarray', 'getopts', 'times', 'suspend',
  'logout', 'history', 'help', 'enable', 'bind', 'caller', 'compgen', 'complete', 'disown',
  'fc', 'shopt', 'exec', 'expr', 'sleep', 'seq', 'date', 'env', 'printenv', 'command', 'which',
  // POSIX / GNU coreutils 与标准工具（参数位是数据：文件名 / 模式 / 数值）
  'cat', 'head', 'tail', 'sed', 'awk', 'gawk', 'mawk', 'grep', 'egrep', 'fgrep', 'rg', 'cut',
  'tr', 'sort', 'uniq', 'wc', 'tee', 'basename', 'dirname', 'realpath', 'readlink', 'stat',
  'ls', 'cp', 'mv', 'rm', 'mkdir', 'rmdir', 'ln', 'touch', 'chmod', 'chown', 'chgrp', 'install',
  'mktemp', 'dd', 'sync', 'df', 'du', 'id', 'whoami', 'uname', 'hostname', 'nproc', 'getconf',
  'bc', 'diff', 'cmp', 'patch', 'sha256sum', 'sha1sum', 'sha512sum', 'md5sum', 'cksum', 'base64',
  'base32', 'xxd', 'od', 'gzip', 'gunzip', 'zcat', 'xz', 'bzip2', 'split', 'join', 'paste',
  'fold', 'nl', 'rev', 'tac', 'comm', 'shuf', 'truncate', 'logger', 'yes', 'column', 'tsort',
  'ps', 'pkill', 'killall', 'ldd', 'file', 'strings', 'readelf', 'nm', 'objdump',
  // 语言运行时与包管理器（参数位是脚本路径 / 包名 / 旗标取值 —— 脚本路径另有载体跟随）
  'sh', 'bash', 'dash', 'zsh', 'ksh', 'ash', 'python', 'python3', 'pip', 'pip3', 'ruby', 'perl',
  'node', 'nodejs', 'npm', 'npx', 'pnpm', 'yarn', 'corepack', 'bun', 'bunx', 'deno',
  'go', 'gofmt', 'govet', 'cargo', 'rustup', 'rustc', 'java', 'mvn', 'gradle', 'dotnet',
  // 通用系统/容器/网络工具
  'time', 'sudo', 'doas', 'su', 'su-exec', 'gosu', 'nice', 'ionice', 'nohup', 'setsid', 'stdbuf',
  'timeout', 'watch', 'flock', 'taskset', 'chrt', 'xargs', 'find', 'tar', 'zip', 'unzip',
  'git', 'docker', 'docker-compose', 'podman', 'ssh', 'scp', 'sftp', 'rsync', 'curl', 'wget',
  'openssl', 'jq', 'yq', 'gpg', 'aws', 'gh', 'make', 'gmake', 'cmake', 'ninja', 'meson',
])
/**
 * 本仓 CI 命令位的**逐词登记表**（第十六轮 R16-W 的语义反转本体）。
 *
 * ## 它判什么
 *
 * CI **入口形态**（workflow `run:` 块 / manifest 别名值 / Makefile 目标体与 `$(shell …)` /
 * compose `command`·`entrypoint`）的命令位上，**每一个**不在
 * {@link CI_STANDARD_COMMANDS} 里的可执行名都要在这里出现一次，条目自带
 * "为什么合法 + 由谁批准"。没登记 ⇒ `unregistered-command` ⇒ 守卫红。
 *
 * ## 双向对账（死条目也红）
 *
 * 与 {@link E2E_CI_SURFACE_REGISTRY} 同款纪律：登记了却在**这次闭包扫描里一次都没被命中**
 * ⇒ 同样红。所以这张表不会慢慢变成"看起来管得很宽"的摆设；加一条假条目、或把某个工具
 * 从 CI 里删掉，都会当场被打出来（`commandWords` 由闭包自己收集，不由人抄）。
 *
 * ## 为什么它是"闭合"的，而旧的包装词黑名单不是
 *
 * 旧表枚举"**我认识哪些包装词**"—— 那是无限集（任何能把命令放进参数位的程序都算包装：
 * `xargs`/`find -exec`/`parallel`/`ssh`/`just`/`poetry`/…），漏一个就静默放行。
 * 这张表枚举"**本仓 CI 入口命令位上真的出现过哪些非标准命令**"—— 有限的、由闭包算出来的
 * 集合；新出现的词默认红（R16A-06/07/08/11 的整族缺口就是这么闭合的）。
 *
 * ## 覆盖边界（认账，见凭据行与 `temp/r16/W/REPORT.md` 的诚实边界节）
 *
 * 登记制只罩**入口形态**的命令位。**被跟随的仓内脚本正文**不逐词登记（`strict = false`）：
 * 那里的命令位含脚本自定义函数（`fail()` / `brand_run_best_effort()`）、shell 语法构件与
 * `case` 模式，逐词登记等于要求为 shell 语言本身背书。它们由**载体跟随（命令/参数位上的
 * 仓内路径、`python -m` 模块、`node -e` 源码、recipe 文件）+ token 网 + 文本网 +
 * make/compose 扩张**覆盖；这几张网对"仓内脚本把端到端藏起来"是红，但对"脚本里出现一个
 * 未登记的新工具"不红 —— 后者的判据面在入口形态。
 */
const CI_COMMAND_REGISTRY = [
  { word: 'apt-get', how: 'Debian/Ubuntu 包管理器', why: 'CI 里只用 `apt-get install -y <包>`；参数位是包名，不接受可执行名', approvedBy: 'R16-W（本泳道）' },
  { word: 'choco', how: 'Windows 包管理器', why: 'CI 里只用 `choco install <包> -y`；参数位是包名，不接受可执行名', approvedBy: 'R16-W（本泳道）' },
  {
    word: 'Xvfb',
    how: 'X 虚拟显示服务器（无头跑 Electron/E2E 用）',
    why: 'ci.yml 里只用 `Xvfb :99 -screen 0 <几何> &` 形态：参数位是显示号与屏幕几何，'
      + '不接受可执行名（真机端到端本身在 CI 内 0 执行，凭据行已声明 static-only）',
    approvedBy: 'R16-W（本泳道）',
  },
  {
    word: 'xcrun',
    how: 'macOS 开发工具定位器（notarytool 公证探针）',
    why: 'notary-probe.yml 里只用 `xcrun notarytool history|log <子命令与旗标>`：'
      + '参数位是 notarytool 的子命令与旗标取值，不接受可执行名',
    approvedBy: 'R16-W（本泳道）',
  },
  {
    word: 'postgres',
    how: 'PostgreSQL 服务端（容器内的 entrypoint 命令）',
    why: 'ci.yml 里只用 `docker run … postgres:18-alpine postgres -c max_connections=500`：'
      + '`postgres` 是 **`docker run <镜像> <命令>` 的命令位**（R17-X 把这一位纳入网内），'
      + '参数位是 `-c <配置>`，不接受可执行名',
    approvedBy: 'R17-X（本泳道）',
  },
  {
    word: 'pg_isready',
    how: 'PostgreSQL 就绪探针（容器内的命令）',
    why: 'ci.yml 里只用 `docker exec pg-ci pg_isready -U postgres`：它是 '
      + '**`docker exec <容器> <命令>` 的命令位**（R17-X 把这一位纳入网内），'
      + '参数位是连接选项，不接受可执行名',
    approvedBy: 'R17-X（本泳道）',
  },
]
/** 命令位可执行名 ⇒ 登记项（`undefined` = 未登记 ⇒ 调用方 fail-closed）。 */
const CI_COMMAND_REGISTRY_BY_WORD = new Map(CI_COMMAND_REGISTRY.map(entry => [entry.word, entry]))
/**
 * **shell 语言自身的保留字/运算符**（不是本仓的命令登记）—— 命令词法是"按分隔符切词"的，
 * `if [[ … ]]; then` 会切出 `if` / `[[` / `then` 这些**语言构件**。它们是 shell 语法，
 * 不是"可执行名"，登记表不该为语言本身背书（否则每写一个 `for` 循环都要登记一次）。
 *
 * 这是**语言定义**（POSIX sh 的保留字 + bash 的复合命令词），与"本仓 CI 用了哪些工具"
 * 无关；判据不在这里放行任何**可执行名**。
 */
const SHELL_RESERVED_PREFIXES = new Set([
  'if', 'then', 'else', 'elif', 'while', 'until', 'do', '!', 'time', '{',
])
const SHELL_RESERVED_WORDS = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac',
  'in', 'function', 'select', 'coproc', 'time', '{', '}', '!', '[[', ']]', 'declare', 'local',
])
/**
 * 剥掉 **make 配方的前缀符**（`@true` / `-rm` / `+cmd`）。
 *
 * `-` / `+` 只在其后紧跟**名字**时才算前缀：否则 `--flag` 会被剥成 `flag`，
 * 把"旗标位"读成一个可执行名（真仓 make 配方里有 `-rm -rf …` 这类写法）。
 * @param word - 词。
 * @returns 剥掉前缀符后的词。
 */
function stripRecipePrefix(word) {
  if (word.startsWith('@')) return word.replace(/^@+/u, '')
  const single = /^[-+]([A-Za-z_].*)$/u.exec(word)
  return single === null ? word : single[1]
}
/**
 * 一个词**像不像可执行名**（决定它走不走登记制）。
 *
 * 只有"纯标识符形态"（字母/数字/`_`/`.`/`+`/`-`）才可能是可执行名；`${VAR}` / `*.md` /
 * `[[` / `a=b` / `-flag` 这些是**取值、通配、语法构件**，不是命令名 —— 它们各自另有判据
 * （{@link isUnreadableCommandShape} 的 fail-closed / 载体路径读不懂 / token 网）。
 * 另外剥掉 make 配方的前缀符（见 {@link stripRecipePrefix}），它们修饰的是**配方回显**。
 * @param word - 命令位首词。
 * @returns 纯标识符形态的词（已剥前缀符）；不是则返回 `undefined`。
 */
function executableNameCandidate(word) {
  if (word === undefined) return undefined
  const stripped = stripRecipePrefix(word)
  if (stripped === '' || stripped.startsWith('-')) return undefined
  if (!/^[A-Za-z_][A-Za-z0-9_.+-]*$/u.test(stripped)) return undefined
  return stripped
}
/**
 * 命令位上"**读不懂的形态**"（R17-X 的收口，R17A-01 的根因）。
 *
 * ## 修前的语义漏洞
 *
 * `isRegisteredCommandWord` 对"取不出可执行名"的词**直接 `return true`**（"不是可执行名
 * ⇒ 放行"）。于是命令位首词含 `$` / 反引号时（`$(echo make)`、`` `echo make` ``、`${M}ke`、
 * `$MAKE`）整族落在登记制之外：守卫 EXIT=0，而 CI 真的执行到端到端入口（R17A-01 实测 4/4）。
 *
 * ## 现在的判据
 *
 * 命令位上含**间接层**（`$` / 反引号）的词，若常量传播（{@link substituteShellWord}）
 * 解析不出字面量，就必须 fail-closed 记红 —— **不允许"取不出名字就放行"**。
 * 两类例外（各自另有判据，不是"放行"）：
 *   · **路径形态**（含 `/`）：由载体跟随 / 文本面判（`"$DIR/run-all.sh"` 那一族）；
 *   · **通配/`case` 模式**（含 `*` `?` `[` `]`）：可执行名里不可能有通配符。
 * @param word - 命令位首词。
 * @returns `true` = 读不懂 ⇒ 调用方 fail-closed。
 */
function isUnreadableCommandShape(word) {
  if (word === undefined || word === '') return false
  if (!SHELL_INDIRECTION_PATTERN.test(word)) return false
  if (word.includes('/')) return false
  if (SHELL_GLOB_PATTERN.test(word)) return false
  return true
}
/**
 * **shell 解释器的"取值的旗标"表**（R20A-01）。
 *
 * ## 现场（R20A-01，P2）
 *
 * 修前的"旗标跳过循环"写的是 `while (cursor < words.length && words[cursor] !== '--'
 * && words[cursor].startsWith('-'))`：它把**每一个以 `-` 开头的词**都当旗标跳过，于是
 *   · `bash -- "$P"` 停在 `--` 上 —— `scriptWord === '--'`，而 {@link shellScriptPositionShape}
 *     的第一条 `if (word.startsWith('-')) return undefined` 直接放行 ⇒ 整条 fail-closed 失效；
 *   · `bash -O extglob "$P"` 停在取值位 `extglob` 上（`-O` 是**带取值**的旗标）⇒ 同族。
 * 两处都让真正的脚本身份（`"$P"`）从不进入判据 —— 路径用普通常量拼出来就能让 CI 执行
 * 端到端入口而守卫打印 `VERDICT PASS`（审计夹具 `d-param`/`d-oflag`/`wf-dashdash` 实测
 * 修前全 `EXIT=0`）。
 *
 * ## 覆盖的形态（按 `bash --help` / `man bash` 的 OPTIONS 段）
 *
 *   · 短旗标簇里的 **`-c`**（命令文本）、**`-o`/`+o`**（set 选项名）、**`-O`/`+O`**
 *     （shopt 选项名，bash）—— 这三个是 bash/dash/ksh/ash/zsh 共有的"带取值"短旗标；
 *     附着形态（`-Oextglob`）与分离形态（`-O extglob`）都按元数吃词；
 *   · bash 的长选项 **`--init-file <file>`** / **`--rcfile <file>`**（以及 `--rcfile=<file>`
 *     这种自带 `=` 的形态）；
 *   · **`--`** 是**选项结束标记**：消费掉它，后面一律按位置参数取词。
 *
 * ## 未覆盖的形态如何仍然 fail-closed
 *
 * 表里没有的旗标按"元数 0"处理 ⇒ 它**自己**被跳过，但它后面那一位会落进脚本位 ——
 * 于是三种结果都不是"放行"：① 那一位是闭包能读的仓内字面路径 ⇒ 照常跟随；
 * ② 是变量/通配/含空白 ⇒ {@link shellScriptPositionShape} 记红；③ 取不到（越界）⇒
 * 调用方按"脚本位缺失"记红（见 {@link shellScriptWordIndex} 的 `missing`）。
 * 换句话说：**猜错元数只会把脚本位取错位置，而取错位置的词几乎必然读不懂**（它要么是
 * 旗标取值那样的普通词——那会落到"缺脚本位"或跟随面——要么是间接层），不存在
 * "因为表不全所以放行"的通路。反过来，表里多登记一条"带取值的旗标"才是危险方向
 * （会把真脚本位吃掉 ⇒ 变绿），所以这张表只收**手册里明写带取值**的形态。
 */
const SHELL_VALUE_SHORT_FLAGS = new Set(['c', 'o', 'O'])
/** 见 {@link SHELL_VALUE_SHORT_FLAGS}：bash 长选项里**明写带取值**的两个。 */
const SHELL_VALUE_LONG_FLAGS = new Set(['--init-file', '--rcfile'])
/**
 * shell 解释器的**旗标段**：从 `index`（解释器词）之后开始跳旗标，返回脚本位。
 *
 * 与 {@link shellScriptPositionShape} 的分工：这一个只回答"**哪一位**是脚本位"
 * （纯位置，不看词的形态），那一个回答"这一位读不读得懂"。R20A-01 的根因正是
 * "位置"有两份实现（解释器分支与 `find -exec` 分支各写一遍，口径不一致）——
 * 现在两处、以及 `source`/`.` 与 {@link shellProcsubIsScriptPosition} 都用这一个。
 * @param words - 一条命令的词数组（命令位起）。
 * @param index - 解释器/宿主词的下标。
 * @returns `{ scriptIndex, commandText, terminated }`：
 *   · `scriptIndex` —— 脚本位下标；`-1` = 旗标段之后**没有**脚本位（越界）；
 *   · `commandText` —— `-c` 那类"取值就是一段脚本文本"的旗标（`{ flag, text }`），没有则 `null`；
 *   · `terminated` —— 是否遇到了 `--`（诊断用）。
 */
function shellScriptWordIndex(words, index) {
  let cursor = index + 1
  let commandText = null
  let terminated = false
  while (cursor < words.length) {
    const word = words[cursor]
    // **选项结束标记**：消费掉它，之后的词一律是位置参数（R20A-01 的现场就在这一条上）。
    if (word === '--') { terminated = true; cursor += 1; break }
    // 只把 `-`/`+` 开头的词当旗标：别的词就是脚本位（`bash script.sh`）。
    if (!word.startsWith('-') && !word.startsWith('+')) break
    const equals = word.indexOf('=')
    if (word.startsWith('--')) {
      const name = equals >= 0 ? word.slice(0, equals) : word
      cursor += 1
      if (equals < 0 && SHELL_VALUE_LONG_FLAGS.has(name)) cursor += 1
      continue
    }
    // 短旗标簇：`-O extglob`（元数 1）/ `-Oextglob`（取值附着）/ `-eo pipefail`（簇末带取值）。
    const cluster = word.slice(1)
    let takesNextWord = false
    for (let at = 0; at < cluster.length; at += 1) {
      const flag = cluster[at]
      if (!SHELL_VALUE_SHORT_FLAGS.has(flag)) continue
      const attached = cluster.slice(at + 1)
      if (flag === 'c') commandText = { flag: word, text: attached === '' ? words[cursor + 1] : attached }
      if (attached === '') takesNextWord = true
      break
    }
    cursor += 1
    if (takesNextWord) cursor += 1
  }
  return { scriptIndex: cursor < words.length ? cursor : -1, commandText, terminated }
}
/**
 * shell 词的**脚本位读不懂**（R17-X 建立；**R18A-01 收口**）。
 *
 * `bash` / `sh` 之后的第一个非旗标实参是"要执行的脚本"。它有几类形态闭包判不了：
 *   · 通配（`bash *.sh` / `bash <目录>/*`）—— 到底哪个文件由运行期决定；
 *   · 含空白/引号残留的字面量（`bash 'make -C x y'`）—— 那不是路径，而是被 shell 当文件名
 *     用的**命令文本**（here-string / 进程替换在词法层的同族残留）；
 *   · **含间接层（`$` / 反引号）且常量传播解析不出字面量**（`bash "$SCRIPT"`、
 *     `bash "$D/run-all.sh"`）—— 这是 R18A-01 的现场：修前这里有一句
 *     `if (word.includes('/')) return false`（"路径形态交给载体跟随"），而载体跟随对
 *     含 `$` 的词**同样**是 `continue` ⇒ `bash "$D/x.sh"`（`D="$(pwd)/scripts"`）**同时**
 *     落在两张网之外：既不 fail-closed，也不被跟随，那份脚本正文从未被读，
 *     于是 CI 真的执行端到端入口而守卫 EXIT=0、凭据行照旧写 `static-only`。
 *     **收口口径：含 `/` 不再豁免** —— 解析不出字面量就是读不懂（路径形态也一样），
 *     除非它是下面的**根变量形态**（`$GITHUB_WORKSPACE/…`，见 {@link stripRootVariablePrefix}）。
 *   · 仓库外的绝对路径（`bash /tmp/x.sh`、`bash ~/x.sh`）：闭包结构上跟不了仓内载体 ⇒ 同判红。
 * @param word - 脚本位那一位。
 * @returns 读不懂的**形态名**（诊断里点名）；读得懂返回 `undefined`。
 */
function shellScriptPositionShape(word) {
  if (word === undefined || word === '') return undefined
  // **R20A-01**：脚本位由 {@link shellScriptWordIndex} 取（旗标段已被消费掉），所以走到这里
  // 的 `-`/`+` 开头的词只可能是"`--` 之后的那一位"—— 那是被 shell 当**文件名**用的词，
  // 闭包判不了它到底指哪个文件（`bash -- -e`）。修前这一条是 `return undefined`
  // （"旗标 ⇒ 不是脚本位"的旧启发式），而旧启发式正是 `--` 掩蔽整条判据的入口 ⇒ 改成 fail-closed。
  if (word.startsWith('-') || word.startsWith('+')) return '`--` 之后以 `-`/`+` 开头的词'
  if (SHELL_GLOB_PATTERN.test(word)) return '通配'
  if (stripRootVariablePrefix(word) !== undefined) return undefined
  if (SHELL_INDIRECTION_PATTERN.test(word)) {
    return word.includes('/') ? '含 `/` 的变量/命令替换路径' : '变量/命令替换'
  }
  if (word.startsWith('/') || word.startsWith('~/')) return '仓库外的绝对路径'
  if (word.includes('/')) return undefined
  return /[\s;|&<>(){}'"]/u.test(word) ? '含空白/引号/括弧的字面量' : undefined
}
/**
 * @param word - 脚本位那一位。
 * @returns `true` = 读不懂。
 */
function unreadableShellScriptArgument(word) {
  return shellScriptPositionShape(word) !== undefined
}
/**
 * **根变量前缀**的脚本位（`$GITHUB_WORKSPACE/scripts/x.sh` / `${PWD}/x.mjs`）。
 *
 * 这两个变量是 GitHub Actions 运行器的**内置工作区变量**：取值就是 checkout 根
 * （= 本判据的 `ROOT`，`working-directory:` 步骤下 `PWD` 则是那个子目录 —— 候选目录
 * 里本来就同时试 `node.dir` / `working-directory` / 仓根，见 `workingDirsFor`）。
 * 于是"变量前缀"在这里不构成间接层：后面那段仍然是**仓内相对路径**，按正常载体跟随
 * 处理即可（跟得上就跟随、跟不上就按 `carrier-command-missing` 记红）。
 *
 * 这不是"放行分支"：`stripRootVariablePrefix` 只剥这一个已知前缀，其余任何间接层
 * （`$D/…`、`${{ … }}`、`$( … )`）一律走 fail-closed。
 * @param word - 脚本位那一位。
 * @returns 剥掉根变量前缀后的仓内相对路径；不适用时返回 `undefined`。
 */
function stripRootVariablePrefix(word) {
  if (word === undefined) return undefined
  for (const name of SHELL_ROOT_VARIABLES) {
    const forms = [`$${name}/`, `\${${name}}/`]
    for (const form of forms) {
      if (!word.startsWith(form)) continue
      const rest = word.slice(form.length)
      if (rest === '' || SHELL_INDIRECTION_PATTERN.test(rest) || SHELL_GLOB_PATTERN.test(rest)) return undefined
      return rest
    }
  }
  return undefined
}
/**
 * **根变量**（GitHub Actions 的内置工作区变量，见 {@link stripRootVariablePrefix}）。
 * 只登记"取值恒等于 checkout 根 / 步骤工作目录"的两个；其余变量不在这里"猜值"。
 */
const SHELL_ROOT_VARIABLES = ['GITHUB_WORKSPACE', 'PWD']
/**
 * shell 的**自指**写法片段（`$0` / `${BASH_SOURCE[0]}` / `$BASH_SOURCE`）—— R19A-04；
 * **R20A-02 按"取值是否等于本文件"分成两族**。
 *
 * 这两种写法在 shell 里**不等价**，而 R19A-04 把它们当成同一族：
 *   · `$0` —— **只在脚本被"执行"时**才是脚本自身；脚本被 `source`（`.`）时 `$0` 仍是**调用者**；
 *   · `${BASH_SOURCE[0]}` / `$BASH_SOURCE` —— **被 source 时也是本文件**（这正是它存在的理由）。
 * 所以：
 *   · {@link SHELL_SELF_EXECUTED_PATTERN}（`$0` 族）只在"被执行"上下文中求值；
 *   · {@link SHELL_SELF_SOURCE_SAFE_PATTERN}（`BASH_SOURCE` 族）在两种上下文都成立。
 * 见 {@link selfReferentialScriptCandidates} 的现场说明。
 */
const SHELL_SELF_EXECUTED_PATTERN = String.raw`\$(?:\{)?0(?:\})?`
/** `BASH_SOURCE` 族：被 source 时仍指本文件 ⇒ 两种上下文都可求值。 */
const SHELL_SELF_SOURCE_SAFE_PATTERN = String.raw`\$(?:\{)?BASH_SOURCE(?:\[0\])?(?:\})?`
/** 两族的并集（诊断/文档用）。 */
const SHELL_SELF_REFERENCE = String.raw`\$(?:\{)?(?:0|BASH_SOURCE(?:\[0\])?)(?:\})?`
/** `$(dirname <自指>)/<尾段>` —— 仓内脚本位最常见的写法（`bash "$(dirname "$0")/x.sh"`）。 */
const SHELL_SELF_DIRNAME_PATTERN = new RegExp(
  String.raw`^\$\(\s*dirname\s+(${SHELL_SELF_REFERENCE})\s*\)\/(.+)$`, 'u')
/**
 * `${<自指>%/*}/<尾段>` —— 免 fork 的同义写法（`${BASH_SOURCE[0]%/*}/x.sh`）。
 * 注意花括号**里面**那一份没有前导 `$`（`${0%/*}` / `${BASH_SOURCE[0]%/*}`）。
 */
const SHELL_SELF_BRACED_PATTERN = String.raw`(?:0|BASH_SOURCE(?:\[0\])?)`
const SHELL_SELF_STRIP_PATTERN = new RegExp(
  String.raw`^\$\{(${SHELL_SELF_BRACED_PATTERN})%\/\*\}\/(.+)$`, 'u')
/** **裸自指**（`bash $0` / `node ${BASH_SOURCE[0]}`）—— 指的是脚本自身。 */
const SHELL_BARE_SELF_PATTERN = new RegExp(String.raw`^(${SHELL_SELF_REFERENCE})$`, 'u')
/**
 * 一段自指片段 → **变量名**（`$0` / `${0}` / `0` / `${BASH_SOURCE[0]}` / `$BASH_SOURCE` →
 * `0` / `BASH_SOURCE`）—— 三种写法在三种 pattern 里捕获到的字面形状不同，判"是不是 `$0` 族"
 * 之前先归一（见 {@link shellSelfReferenceNeedsExecution}）。
 */
const shellSelfReferenceVariable = reference =>
  String(reference ?? '').replace(/\$/gu, '').replace(/^\{/u, '').replace(/\}$/u, '').replace(/\[0\]/u, '')
/** 判一段自指片段是不是 `$0` 族（见 {@link SHELL_SELF_EXECUTED_PATTERN}）。 */
const shellSelfReferenceNeedsExecution = reference => shellSelfReferenceVariable(reference) === '0'
/**
 * 自指脚本位 → **仓内候选路径**（纯函数，不判存在性；存在性由调用方的载体解析判）。
 *
 * ## 现场（R19A-04，P3 误报风险）
 *
 * `bash "$(dirname "$0")/x.sh"` 是**脚本位**的既有惯用写法（本仓 `scripts/ci-channels.sh`、
 * `integration-tests/run-all.sh` 都有同族形态，只是那两处在语句位）。R18A-01 把"含 `/` 的
 * 变量/命令替换路径"整族 fail-closed 之后，这一族在脚本位就变成**误报**：闭包明明知道
 * 当前脚本是谁（`node.file`），却不拿这个信息去求值。
 *
 * ## R20A-02：`$0` 只在"被执行"时成立（漏判方向）
 *
 * 自指求值假设 `$0` == 被跟随脚本。但**被 `source` 的脚本里 `$0` 仍是调用者**
 * （`BASH_SOURCE[0]` 才是本文件）。审计现场：
 *
 * ```bash
 * scripts/u20-outer.sh     : source scripts/u20-sub/inner.sh     # CI 步骤跑的就是它
 * scripts/u20-sub/inner.sh : bash "$(dirname "$0")/decoy.sh"     # $0 = u20-outer.sh（被 source）
 * scripts/u20-sub/decoy.sh : echo ok                             # ← 闭包跟随的"诱饵"（清白）
 * scripts/decoy.sh         : bash integration-tests/run-all.sh   # ← 运行期真正执行的（从没被读）
 * ```
 *
 * 修前：`inner.sh` 被 `source` 进来，闭包仍按"本文件目录"求值 ⇒ 跟随 `u20-sub/decoy.sh`
 * （清白）⇒ 守卫 `EXIT=0`，而 tripwire 证明运行期执行了端到端入口。
 *
 * ## 判据（不是"放行"）
 *
 * 求值出**仓内真实存在**的候选 ⇒ 按普通载体跟随（跟到的东西照旧进 token/文本网，
 * 命中端到端入口一样要登记）；求值不出 ⇒ **保持 fail-closed**（词一个字都不改）。
 * 于是"自指 + 指向仓内脚本"不再误报，而"自指 + 指向仓外/不存在的东西"仍然是红。
 * `$0` 族在**被 source** 的上下文里**不求值**（候选为空 ⇒ 词原样保留 ⇒ 词法阶段按
 * "变量/命令替换"记红）；`BASH_SOURCE` 族在两种上下文都求值（`legit-selfstrip` 保持绿）。
 * @param word - 脚本位那一位（词法器已剥引号）。
 * @param selfFile - 当前被跟随的仓内脚本路径（仓库相对）；不是仓内 shell 脚本时 `undefined`。
 * @param options - `{ executed }`：这份正文是**被执行**（默认 `true`）还是**被 source**。
 * @returns 候选路径数组（仓库相对，按可信度排序）；不适用时返回 `[]`。
 */
function selfReferentialScriptCandidates(word, selfFile, options = {}) {
  if (word === undefined || word === '' || selfFile === undefined) return []
  if (!/\.(?:sh|bash)$/u.test(selfFile)) return []
  const executed = options.executed !== false
  const selfDir = selfFile.includes('/') ? selfFile.slice(0, selfFile.lastIndexOf('/')) : ''
  /** 尾段 → 相对当前脚本目录的仓内候选（越出仓库根的 `..` 一律不求值）。 */
  const joined = tail => {
    const rest = String(tail).replace(/^\.\//u, '')
    if (rest === '' || rest.startsWith('/') || SHELL_INDIRECTION_PATTERN.test(rest)) return undefined
    const path = selfDir === '' ? rest : `${selfDir}/${rest}`
    return path.split('/').includes('..') ? undefined : path
  }
  const candidates = []
  for (const pattern of [SHELL_SELF_DIRNAME_PATTERN, SHELL_SELF_STRIP_PATTERN]) {
    const match = pattern.exec(word)
    if (match === null) continue
    // **R20A-02**：`$0` 族在被 source 的正文里不代表本文件 ⇒ 不求值（保持 fail-closed）。
    if (!executed && shellSelfReferenceNeedsExecution(match[1])) continue
    const path = joined(match[2])
    if (path !== undefined) candidates.push(path)
  }
  if (SHELL_BARE_SELF_PATTERN.test(word)) {
    const reference = SHELL_BARE_SELF_PATTERN.exec(word)[1]
    if (executed || !shellSelfReferenceNeedsExecution(reference)) candidates.push(selfFile)
  }
  return candidates
}
/**
 * 一份正文的**词数组**，带**自指脚本位求值**（R19A-04）；`context` 缺席时与
 * {@link shellCommandWordLists} 逐字同义。
 *
 * 为什么要有这个"带上下文"的入口：`bash "$(dirname "$0")/x.sh"` 的词法问题由
 * **三个**扫描器各自产生（载体跟随 / make 扩张 / compose 扩张），而"当前脚本是谁"这个
 * 上下文只有闭包节点知道 ⇒ 三处必须看到**同一份**求值后的词数组，否则修了载体跟随、
 * make 扫描器照样把同一句判红（R19A-04 第一次修法实测就踩在这里）。
 * @param text - 正文。
 * @param context - `{ selfFile, resolve, executed }`；`resolve` 把候选路径判成仓内路径或
 *   `undefined`；`executed === false` 表示这份正文是**被 `source`** 的（R20A-02：`$0` 族
 *   不求值，`BASH_SOURCE` 族照旧求值）。
 * @returns 词数组的数组（已做常量传播）。
 */
const SHELL_WORDS_FOR_CACHE = new Map()
function shellCommandWordListsFor(text, context = undefined) {
  if (context === undefined || context.selfFile === undefined || typeof context.resolve !== 'function') {
    return shellCommandWordLists(text)
  }
  // 记忆化：同一段正文会被 make / compose / 载体三个扫描器各问一次（性能，不是语义）。
  // 缓存键必须带 `executed`（同一个文件可能既被执行又被 source，两份词数组不等价）。
  const cacheKey = `${context.selfFile}\u0000${context.executed === false ? 'sourced' : 'exec'}\u0000${text}`
  const cached = SHELL_WORDS_FOR_CACHE.get(cacheKey)
  if (cached !== undefined) return cached
  const rewritten = rawShellCommandWordLists(text).map(words => words.map(word => {
    for (const candidate of selfReferentialScriptCandidates(word, context.selfFile, { executed: context.executed !== false })) {
      const resolved = context.resolve(candidate)
      if (resolved !== undefined) return resolved
    }
    return word
  }))
  const commands = resolveShellIndirections(rewritten).commands
  if (SHELL_WORDS_FOR_CACHE.size < SHELL_WORDS_CACHE_MAX) SHELL_WORDS_FOR_CACHE.set(cacheKey, commands)
  return commands
}
/**
 * **容器运行器**（`docker|podman run|exec`）的参数解析：找**命令位**的下标。
 *
 * 只做三件事：跳过运行器级旗标（带取值的按表吃）、读子命令、跳过子命令的旗标与
 * `positional` 个位置参数（`run` 是镜像、`exec` 是容器名）。返回 `null` = 这不是
 * `run`/`exec` 形态（调用方原样落回通用分支）。
 * @param words - 这条命令的词数组。
 * @param start - 运行器词的下标。
 * @param spec - {@link CONTAINER_RUNNER_SPECS} 的一项。
 * @returns `{ subcommand, commandIndex, entrypoint }`；不是 `run`/`exec` 时返回 `null`。
 */
function containerRunnerCommandIndex(words, start, spec) {
  let index = start + 1
  /** 跳过一段旗标：`--flag=值` 自带取值，`--flag 值` 按表吃下一个词。 */
  const skipFlags = valueFlags => {
    while (index < words.length && words[index].startsWith('-') && words[index] !== '--') {
      const word = words[index]
      const equals = word.indexOf('=')
      const name = equals >= 0 ? word.slice(0, equals) : word
      index += 1
      if (equals < 0 && valueFlags.includes(name)) index += 1
    }
  }
  skipFlags(spec.valueFlags)
  const subcommand = words[index]
  const subSpec = subcommand === undefined ? undefined : spec.subcommands[subcommand]
  if (subSpec === undefined) return null
  index += 1
  let entrypoint
  while (index < words.length && words[index].startsWith('-') && words[index] !== '--') {
    const word = words[index]
    const equals = word.indexOf('=')
    const name = equals >= 0 ? word.slice(0, equals) : word
    index += 1
    if ((subSpec.execFlags ?? []).includes(name)) {
      entrypoint = equals >= 0 ? word.slice(equals + 1) : words[index]
      if (equals < 0) index += 1
      continue
    }
    if (equals < 0 && subSpec.valueFlags.includes(name)) index += 1
  }
  for (let taken = 0; taken < (subSpec.positional ?? 0) && words[index] !== undefined; taken += 1) index += 1
  return { subcommand, commandIndex: index, entrypoint }
}
/**
 * 一个词归一后的**仓内相对路径形态**（R22 FIX-14 / E-01 形态 B 的唯一实现）。
 *
 * ## 现场（第二十二轮 V7 泳道，形态 B）
 *
 * `printf … > gen.sh; chmod +x gen.sh; ./gen.sh` 在 CI 里真实执行了端到端入口，而
 * `check-integration-tests.mjs` **EXIT=0** 且凭据行照旧写 `static-only / 真实接线 0 处`。
 * 根因是同一格判据的**入口条件**：
 *   · 跟随面（`scanCarrierPaths` ①，命令位）要求 `isRepoRelativePathWord(command)`，
 *     而它的字符类首字符是 `[A-Za-z0-9_]`（`.` 不在其中）⇒ `./gen.sh` 整条分支被跳过；
 *   · 落到登记制（{@link isRegisteredCommandWord}）又被 `word.includes('/')` 短路放行。
 * 于是 `./x` 既不被跟随、也不进登记制、也不进"仓内不存在 ⇒ 生成物"那一格 ——
 * 同一个目标只多写一个 `bash`（`bash ./gen.sh`）就 EXIT=1，说明判据本体是对的。
 *
 * ## 归一口径
 *
 * 只归一**前导 `./`**（`./x`、`.//x`）：`./x` 与 `x` 在命令位/脚本位上是同一个语义。
 * `.` 与 `..` 本身**不是**载体路径（`.` 还是 `source` 的别名）；`../x` 的解析依赖这条
 * 命令的工作目录，交给既有的 `resolveCarrierPath()` / `expandTokens()` 口径，不在这里猜。
 * @param word - 命令位/脚本位上的词。
 * @returns 归一后的仓内相对路径；形态不是仓内相对路径时返回 `undefined`。
 */
function normalizeRepoRelativeWord(word) {
  if (typeof word !== 'string' || word === '') return undefined
  if (word.startsWith('/') || word.startsWith('~') || word.startsWith('-')) return undefined
  const cleaned = word.replace(/^(?:\.?\/)+/u, '')
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return undefined
  if (!/^[A-Za-z0-9_][A-Za-z0-9_./@+-]*$/u.test(cleaned)) return undefined
  return cleaned
}
function isRegisteredCommandWord(word) {
  if (word === undefined || word === '') return true
  // **R22 FIX-14（E-01 形态 B）**：含 `/` 一律算"已登记"是**命令位**的放行口径
  // （"路径形态交给载体跟随/文本面"）—— 它没错，错的是"一个词到底算不算仓内相对路径"
  // 用的是另一套（不含 `.`）的字符类。现在两侧共用 {@link normalizeRepoRelativeWord}：
  // 仓内相对路径形态 ⇒ **不在登记制里放行**（返回 `false`，由跟随面/生成物判据回答
  // "跟不跟得上"）；其余含 `/` 的词（绝对路径 / 变量 / 通配 / 仓外）维持原口径。
  if (word.includes('/')) return normalizeRepoRelativeWord(word) === undefined
  if (word === MAKE_RECURSIVE_WORD) return true
  if (SHELL_RESERVED_WORDS.has(word)) return true
  const candidate = executableNameCandidate(word)
  // **R17-X**：取不出可执行名**不再**自动放行 —— 由 {@link isUnreadableCommandShape}
  // 判"含间接层且解析不出字面量"的那一族，其余（语法构件/通配/取值）按下面各自的分支。
  if (candidate === undefined) return !isUnreadableCommandShape(word) && !SHELL_RESERVED_PREFIXES.has(word)
  if (CI_COMMAND_REGISTRY_BY_WORD.has(candidate)) return true
  if (CI_STANDARD_COMMANDS.has(candidate)) return true
  return COMMAND_CARRIER_WORDS.has(candidate)
}
/** 位置参数/旗标取值读不懂时的**统一拒绝口径**（fail-closed）。 */
function isUnreadableCommandWord(value) {
  return value === undefined || value.includes('$') || value.includes('{{') || value.includes(MAKE_RECURSIVE_WORD)
}
/**
 * 一段内层 shell 文本的**命令位**能不能读。
 *
 * 判据是"**命令本身**是不是变量拼出来的"，不是"文本里有没有 `$`"：
 * `bash -c 'set -e; make -C server x'` 里的 `$`/`${VAR}` 是脚本内的变量引用（正常），
 * 而 `sh -c "$(cat wrapper.sh)"` / `bash -c "$CMD"` 的命令位本身就是替换 ⇒ 判不了跑什么。
 * @param text - 内层 shell 文本。
 * @returns `true` = 命令位读不懂（调用方 fail-closed）。
 */
function nestedCommandUnreadable(text) {
  if (text === undefined || text.includes('{{')) return true
  const first = shellCommandWordLists(text)[0]?.[0]
  if (first === undefined) return false // 空脚本：没有命令可藏
  return first.startsWith('$') || first.includes('$(') || first.includes('${')
}
/**
 * 一段**语言源码文本**（`node -e '<js>'` / `python3 -c '<py>'`）能不能读。
 *
 * 与 {@link nestedCommandUnreadable} 的区别：这里的 `$` 是源码里的合法字符，真正读不懂的
 * 是"取值本身由**另一层替换**拼出来"——`node -e "$(cat payload.js)"`（shell 命令替换）、
 * `` node -e "`cat payload.js`" ``（反引号）、`node -e "${SRC}"`（变量展开）。
 * @param text - 源码文本。
 * @returns `true` = 读不懂（调用方 fail-closed）。
 */
function nestedCodeUnreadable(text) {
  if (text === undefined) return true
  if (text.includes('{{')) return true
  // 只判"**取值本身**是一次替换/反引号"（R16A-10 的形态：`node -e "$(cat payload.js)"`）。
  // 不能按"文本里有没有 `$(`/反引号"判：JS 模板字面量与脚本内部的命令替换都是合法写法
  // （真仓 `scripts/ci-channels.sh` 的多行 `node -e '…'` 里就有），按字面判会把它们全打成红。
  const head = text.trimStart()
  return head.startsWith('$(') || head.startsWith('${') || head.startsWith('`')
}
/**
 * 命令 → **包装链的尽头** + **命令位的登记制**（纯词法，不做语义分析）。
 *
 * 第十六轮 R16-W 的语义反转见 {@link COMMAND_WRAPPER_SPECS} 的头注释：走到命令位之后，
 * 那一位必须**登记过**（{@link isRegisteredCommandWord}）或是一条闭包能跟随的仓内路径；
 * 未登记 ⇒ `unregistered-command` problem ⇒ 守卫红。
 *
 * @param words - 一条命令的词数组（{@link shellCommandWordLists} 的输出）。
 * @returns `{ heads, nestedTexts, problems }`：
 *   · `heads` —— 真正可能被执行的命令（**残余词数组**：命令位起、到这条命令末尾）；
 *   · `nestedTexts` —— 内层 shell 文本（`bash -c '<文本>'` / `npm exec -c '<文本>'` /
 *     `env -S '<文本>'`），调用方递归解析；
 *   · `problems` —— 读不懂的包装位 / **未登记的命令位**（调用方 fail-closed）。
 */
const UNWRAP_CACHE = new Map()
const UNWRAP_CACHE_MAX = 20000
function unwrapCommandWords(words, strict = true) {
  const cacheKey = `${strict ? '1' : '0'}\u0000${words.join('\u0000')}`
  const cached = UNWRAP_CACHE.get(cacheKey)
  if (cached !== undefined) return cached
  const result = unwrapCommandWordsUncached(words, strict)
  if (UNWRAP_CACHE.size < UNWRAP_CACHE_MAX) UNWRAP_CACHE.set(cacheKey, result)
  return result
}
/**
 * 包装链 + 命令位登记制的**真实现**（{@link unwrapCommandWords} 的带记忆化外壳）。
 *
 * 记忆化是**性能**需要，不是语义需要：同一条命令会被 make / compose / 载体三个扫描器
 * 各走一遍，而 `pushHead` 还会对后缀递归调用 —— 不记忆化时真仓上的闭包会从 3s 级涨到
 * 10s 级。函数是**纯**的（只吃词数组与 `strict`），返回值只被调用方迭代、不被改写。
 */
function unwrapCommandWordsUncached(words, strict = true) {
  const heads = []
  const nestedTexts = []
  /** `python3 -m <模块>` 的模块名 —— 调用方换算成仓内 `.py` 路径再跟随（R16A-09）。 */
  const modules = []
  /** 命令位上出现过的**可执行名**（含已登记的）—— 供登记表的**死条目双向对账**用。 */
  const commandWords = []
  const problems = []
  let index = 0
  /** 是否已经吃掉了至少一层**已登记**的包装（决定"命令位是变量"要不要 fail-closed）。 */
  let wrapped = false
  const stop = () => ({ heads, nestedTexts, modules, commandWords, problems })
  // **进程替换** `<(...)` / `>(...)`（R17-X，R17A-02；**R19A-01 收口**）：`bash <(echo '<命令文本>')`
  // 里真正被执行的是那个**子进程的输出**，闭包结构上判不了它 ⇒ 见到就 fail-closed（不是"没看见"）。
  //
  // ## 修前的语义漏洞（R19A-01，P2）
  //
  // 上面那句 fail-closed 只在 **`strict` 面**生效（`if (procsub !== undefined && strict)`），
  // 而被跟随的仓内脚本正文走 `strict = false` —— 于是把同一句话搬进包装脚本正文
  // （`bash <(cat scripts/cmd.txt)`）就重新落回两张网**之间**：既不判红、内层 `.txt` 也不被
  // 跟随（哨兵词不是路径）⇒ CI 真的执行端到端入口而守卫 EXIT=0（R19A 三个探针实测）。
  //
  // ## 现在的判据（按**位置**分，不是按模式分）
  //
  // · **脚本位**（解释器 / `source` 之后的第一个非旗标实参，或命令位本身）：被执行的就是那个
  //   子进程的**输出** ⇒ **所有模式**下 fail-closed（与"读不懂的脚本文本"同族）。
  // · **流/参数位**（`done < <(cmd)`、`diff <(a) <(b)`）：子进程的输出是**数据**，不是脚本 ——
  //   入口形态（`strict`）维持 R17-X 的既有口径（一律 fail-closed，不放松），
  //   被跟随的脚本正文里则**把内层子命令当闭包节点继续扫**（内层命令本身会执行：
  //   `done < <(make -f evil.mk e2e)` 的目标体照旧要被读到）—— 这样既不把本仓既有的
  //   `< <(printf|sort)` 惯用写法（`scripts/ci-channels.sh` / `scripts/verify-wasm-client-only.sh`）
  //   打成误报，也不给"把执行面藏进进程替换"留第二条缝。
  {
    const procsubIndex = words.findIndex(word => word.startsWith(SHELL_PROCSUB_MARKER))
    const procsub = procsubIndex < 0 ? undefined : words[procsubIndex]
    const scriptPosition = procsub !== undefined && shellProcsubIsScriptPosition(words, procsubIndex)
    if (procsub !== undefined && (strict || scriptPosition)) {
      const shown = procsub.slice(SHELL_PROCSUB_MARKER.length)
      problems.push({
        kind: 'process-substitution',
        word: shown,
        raw: renderShellWords(words),
        message: `进程替换 \`${shown}\` 的执行面读不懂（${renderShellWords(words)}）——`
          + ` 它把子进程的**输出**当文件/脚本文本用（\`bash <(echo '<命令>')\`）`
          + `（位置：${scriptPosition ? '**脚本位**' : '入口形态'}），`
          + '闭包判不了子进程会输出什么 ⇒ fail-closed 记红（请把载体写成仓内脚本文件，'
          + '或把命令写成字面量）。'
          + ' 注（R19A-01）：这条 fail-closed 现在**不分模式** —— 被跟随的仓内脚本正文里'
          + '同样的写法一样红；只有"输出当**数据**用"的流/参数位（`done < <(…)`）在'
          + '被跟随的脚本正文里不按本条判红，它的**内层子命令**另有闭包节点继续扫。',
      })
      return stop()
    }
    // 流/参数位（只在宽松面走得到这里）：内层子命令**本身会执行** ⇒ 入队成真正的闭包节点，
    // 让载体跟随 / make / compose / 文本网照常罩住它（R19A-01 的"要么被跟随"那一半）。
    if (procsub !== undefined) {
      for (const word of words) {
        if (!word.startsWith(SHELL_PROCSUB_MARKER)) continue
        nestedTexts.push({
          language: 'shell',
          text: word.slice(SHELL_PROCSUB_MARKER.length + 2, -1),
          flag: `${word[SHELL_PROCSUB_MARKER.length]}(…)`,
          node: NESTED_SHELL_LENIENT,
          procsub: true,
        })
      }
    }
  }
  /** 吃掉选项终止符 `--` 与前导环境赋值 `VAR=值`（它们都不是命令）。 */
  const skipNoise = () => {
    while (index < words.length
      && (words[index] === '--' || /^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[index]))) index += 1
  }
  /**
   * **命令位的登记制**（R16-W 的语义反转）：这一位要么登记过、要么是路径形态
   * （由调用方按 `resolveCarrierPath()` 判跟得上还是红）、要么是变量展开（另一条判据）。
   * @param word - 命令位首词。
   * @param rawWords - 这条命令的残余词（用于诊断定位）。
   */
  const requireRegistered = (word, rawWords) => {
    const candidate = executableNameCandidate(word)
    if (strict && candidate !== undefined && !SHELL_RESERVED_WORDS.has(candidate)) commandWords.push(candidate)
    if (isRegisteredCommandWord(word)) return
    // **R22 FIX-14（E-01 形态 B）**：仓内相对路径形态（`./x.sh` / `gen.sh` / `scripts/x.sh`）
    // 不是"可执行名"，它是**载体路径** —— 判据在跟随面：存在 ⇒ 跟随；不存在 ⇒
    // `missing-script-carrier`；同一段文本里被写过 ⇒ 同样记红（见 `runtimeWrittenCarriers`）。
    // 在这里记 `unregistered-command` 会与跟随面**重复计红**，也会把"检查期不存在的生成物"
    // 误诊成"未登记的可执行名"（两者要的修法完全不同：一个要登记，一个要改写成仓内脚本）。
    // 条件与跟随面①的入口**逐字相同**（`/` 或 `.` + 仓内相对路径形态）：没有这两个字符的
    // 裸词（`r16a-unknown-runner`）仍然是"可执行名"，照旧走登记制（R16-W 的自证样本）。
    if (/[/.]/u.test(word) && normalizeRepoRelativeWord(word) !== undefined) return
    if (!strict) return
    // **读不懂的形态**（含 `$`/反引号且常量传播解析不出字面量）与**未登记的可执行名**是
    // 两种不同的红：前者要"写成字面量或逐处登记进 `CI_SURFACE_COMMAND_SHAPE_ACK`"，
    // 后者要"登记进 `CI_COMMAND_REGISTRY` 或换成闭包能跟随的形态"（R17-X，R17A-01）。
    if (isUnreadableCommandShape(word)) {
      problems.push({
        kind: 'command-shape-unreadable',
        word,
        raw: rawWords.join(' '),
        message: `命令位上的首词 \`${word}\` 读不懂（${rawWords.join(' ')}）—— 它由变量展开 / 命令替换 / `
          + '拼接拼出来，闭包不解析它就等于"取不出名字就放行"（R17A-01 的整族旁路）：'
          + '请把可执行名写成字面量（同一段文本内的简单赋值 `VAR=值` 与 `$(echo <字面量>)` 会被'
          + '常量传播解析），或把这一处逐字登记进 `CI_SURFACE_COMMAND_SHAPE_ACK`（写明'
          + '"为什么合法 + 由谁批准"）。',
      })
      return
    }
    problems.push({
      kind: 'unregistered-command',
      word,
      raw: rawWords.join(' '),
      message: `命令位上的可执行名 \`${word}\` 没有登记（${rawWords.join(' ')}）—— `
        + '闭包只跟随它认识的包装/载体，认不出的一律按 fail-closed 记红：'
        + '请把这一处登记进 `CI_COMMAND_REGISTRY`（写明"为什么合法 + 由谁批准"），'
        + '或把它换成闭包能跟随的形态（`make -C <dir> <目标>` / compose `run` / 仓内脚本路径）',
    })
  }
  /**
   * 吃掉一段旗标；`execFlags` / `codeFlags` 的取值是命令/源码文本，`lookupFlags` 命中
   * ⇒ 这一位不是执行，`attachedOptionalFlags` 的取值可附着。
   *
   * 旗标位上的**变量展开**（`sudo $OPTS make …`）不在这里猜"它吃掉几个词"：循环遇到它就
   * 停下，由下面的"命令位是变量展开"判据记 problem（fail-closed）—— 一次展开吃掉几个词
   * 不可知，正是"把 make 藏进参数位"的同族形态。
   */
  const skipFlags = spec => {
    const execTexts = []
    const codeTexts = []
    let lookup = false
    while (index < words.length && words[index].startsWith('-') && words[index] !== '--') {
      const word = words[index]
      const equals = word.indexOf('=')
      const name = equals >= 0 ? word.slice(0, equals) : word
      const attached = equals >= 0 ? word.slice(equals + 1) : null
      index += 1
      if ((spec.lookupFlags ?? []).includes(name)) lookup = true
      // `--flag=<文本>` 形态：**取值就在同一个词里**。R16A-04 的现场是
      // `!word.includes('=')` 让 `npm exec --call='make …'` 既不解析也不 fail-closed。
      if ((spec.execFlags ?? []).includes(name)) {
        const text = attached !== null ? attached : words[index]
        if (attached === null) index += 1
        execTexts.push({ flag: `${name}`, text })
        continue
      }
      if ((spec.codeFlags ?? []).includes(name)) {
        const text = attached !== null ? attached : words[index]
        if (attached === null) index += 1
        codeTexts.push({ flag: `${name}`, text })
        continue
      }
      if ((spec.moduleFlags ?? []).includes(name)) {
        const text = attached !== null ? attached : words[index]
        if (attached === null) index += 1
        // 模块名（`python3 -m pkg.mod`）→ 仓内 `.py` 路径，由调用方按路径跟随。
        if (text !== undefined && !isUnreadableCommandWord(text)) modules.push(text)
        continue
      }
      if ((spec.valueFlags ?? []).includes(name) && attached === null) { index += 1; continue }
      if ((spec.attachedOptionalFlags ?? []).includes(name) && attached === null) { index += 1; continue }
    }
    return { execTexts, codeTexts, lookup }
  }
  /**
   * 内层命令文本必须能读（变量拼出来的命令 ⇒ fail-closed）。
   * @param flag - 包装位的名字（诊断用）。
   * @param text - 内层 shell 文本。
   * @param node - 该文本在闭包里的**严格度**（见 {@link NESTED_SHELL_STRICT}）；
   *   省略 = 维持既有口径（只按 make 递归）。
   */
  const acceptNested = (flag, text, node = undefined) => {
    if (nestedCommandUnreadable(text)) {
      problems.push(`包装位 \`${flag}\` 的内层命令读不懂（${text ?? '(缺参数)'}）—— `
        + '变量/表达式拼出来的命令闭包判不了它跑什么，按 fail-closed 记红（请把它写成字面量）')
      return false
    }
    nestedTexts.push({ flag, language: 'shell', text, node })
    return true
  }
  /**
   * **包运行器的包内 bin**（`npx <工具>` / `yarn dlx <工具>` / …）。
   *
   * 这一位是**包名/包内 bin**（外部命名空间），不是本仓的可执行名 ⇒ 不过逐词登记
   * （修前 `npx eslint .` 被判成"未登记的可执行名 `eslint`"，是 R17A-04 的误报）。
   * 但两种形态仍然红：
   *   · 这一位**遮蔽了闭包认识的命令词**（`npx make …` / `npx bash -c …`）——「用包运行器
   *     把真命令换个名字」；
   *   · `--` 之后那一位：那是**真命令**（`npm exec -- make …`），照常走登记制 + 包装链。
   * @param label - 运行器词（诊断用）。
   * @param afterTerminator - 这一位是否紧跟在 `--` 之后。
   * @returns `true` = 已经处理完这条命令（调用方 `return stop()`）。
   */
  const consumePackageRunnerBin = (label, afterTerminator = false) => {
    if (words[index] === '--') { afterTerminator = true; index += 1 }
    const bin = words[index]
    if (bin === undefined) return true
    if (afterTerminator) return false // 真命令：落回通用分支（登记制 + 包装链）
    index += 1
    const candidate = executableNameCandidate(bin)
    if (candidate !== undefined && isRegisteredCommandWord(bin)) {
      problems.push({
        kind: 'package-runner-command',
        word: bin,
        raw: words.join(' '),
        message: `包运行器 \`${label}\` 后面那一位 \`${bin}\` 是闭包认识的**命令名**`
          + `（${words.join(' ')}）—— 「用包运行器把真命令换个名字」是命令位登记制的同族旁路，`
          + '按 fail-closed 记红（请直接调用它，或把这一处登记进 `CI_COMMAND_REGISTRY`）。',
      })
      return true
    }
    pushHead(words.slice(index - 1), { checkRegistry: false })
    return true
  }
  /**
   * 内层**语言源码**（`node -e` / `python3 -c`）必须能读。
   * 语言由旗标所在的命令位推（`python3 -c` ⇒ Python，其余按 JS）—— 抽取器按语言选，
   * 拿 JS 的调用名去读 `.py` 会一条都抽不到（VA-05-F2 的同类教训）。
   */
  const acceptCode = (flag, text) => {
    const language = COMMAND_PYTHON_WORDS.has(flag.split(' ')[0]) ? 'py' : 'js'
    if (nestedCodeUnreadable(text)) {
      problems.push(`包装位 \`${flag}\` 的源码文本读不懂（${text ?? '(缺参数)'}）——`
        + ' 取值由另一层替换/变量拼出来（`$(cat …)`、反引号、`${…}`），闭包判不了它跑什么，'
        + '按 fail-closed 记红（请把它写成字面量，或把载体落成仓内脚本文件再由闭包跟随）')
      return false
    }
    nestedTexts.push({ flag, language, text })
    return true
  }
  /**
   * 这一位**是不是包装链的起点**（单词包装 / 双词包装 / shell 词 / `find`）。
   * @param argv - 残余词数组。
   * @param at - 位置。
   * @returns `true` = 从这一位起是一条新的包装链。
   */
  const wrapperStartsAt = (argv, at) => {
    const word = argv[at]
    if (word === undefined) return false
    const isWrapper = COMMAND_SHELL_WORDS.has(word) || word === 'find'
      || COMMAND_WRAPPER_SPECS.has(word)
      || COMMAND_MULTI_WORD_WRAPPERS.has(`${word} ${argv[at + 1] ?? ''}`)
    if (!isWrapper) return false
    // **只有"前面是旗标/赋值"才算新的包装链起点**：包装词也可能是**别的命令的子命令或取值**
    // （`docker exec <容器> <命令>` / `kubectl exec` / `git … exec`）—— 真仓 ci.yml 的
    // `if docker exec pg-ci pg_isready …` 实测会被读成"命令位是容器名 `pg-ci`"。
    // 包装链的真实形态是 `xvfb-run -a … env A=1 timeout 5 <命令>`（前面全是旗标/赋值）。
    const previous = argv[at - 1]
    if (at === 0) return true
    if (previous === undefined) return false
    return previous.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/u.test(previous)
      || COMMAND_SHELL_WORDS.has(previous)
  }
  /**
   * 记下一条命令的残余词，并**继续剥它参数位上的包装词**。
   *
   * R16-W：包装词出现在**参数位**时同样是包装 —— `xvfb-run … env HOME=… timeout "$T" "$BIN" …`
   * 里真正的命令位在 `env`/`timeout` 之后（真仓 `scripts/verify-wasm-client-only.sh` 就是
   * 这个形态）。不剥它，"把命令藏进参数位"这一族只是换了个外壳：`xvfb-run make -C …` /
   * `nohup env A=1 bash -c '…'` 都会从新表里溜走。
   * 递归调用吃的词数组**严格更短**，所以一定终止。
   * @param argv - 这条命令的残余词（命令位起）。
   */
  const pushHead = (argv, options = {}) => {
    heads.push(argv)
    if (options.checkRegistry === false) {
      // 解释器的脚本位：只继续剥它参数位上的包装词，不做命令名登记。
      for (let at = 1; at < argv.length; at += 1) {
        if (!wrapperStartsAt(argv, at)) continue
        const inner = unwrapCommandWords(argv.slice(at), strict)
        heads.push(...inner.heads)
        nestedTexts.push(...inner.nestedTexts)
        modules.push(...inner.modules)
        commandWords.push(...inner.commandWords)
        problems.push(...inner.problems)
      }
      return
    }
    for (let at = 1; at < argv.length; at += 1) {
      if (!wrapperStartsAt(argv, at)) continue
      const inner = unwrapCommandWords(argv.slice(at), strict)
      heads.push(...inner.heads)
      nestedTexts.push(...inner.nestedTexts)
      modules.push(...inner.modules)
      commandWords.push(...inner.commandWords)
      problems.push(...inner.problems)
    }
  }
  for (let hops = 0; hops <= CI_SURFACE_MAX_HOPS; hops += 1) {
    skipNoise()
    const head = words[index]
    if (head === undefined) return stop()
    // ⓪ shell 的**前缀保留字**是透明的（`if docker exec …` / `while ! cmd` / `{ cmd; }`）：
    //    跳过它继续找命令位。不跳的话 `if`/`while` 会被当成命令名，真正的命令整条不进判据。
    //    `for` / `case` / `in` / `select` / `coproc` **不跳** —— 它们后面跟的是**取值列表**。
    if (SHELL_RESERVED_PREFIXES.has(head)) { index += 1; wrapped = true; continue }
    // ⓪b **容器运行器的子命令命令位**（R17-X，R17A-05）：`docker|podman run <镜像> <命令>` /
    //     `exec <容器> <命令>` —— 命令在**参数位**。命中时把 `index` 移到命令位并继续外层循环
    //     （于是它走同一套登记制 + 包装链 + 载体跟随）；否则原样落回下面的通用分支。
    {
      const runnerSpec = CONTAINER_RUNNER_SPECS.get(head)
      if (runnerSpec !== undefined) {
        const probe = containerRunnerCommandIndex(words, index, runnerSpec)
        if (probe !== null) {
          if (probe.entrypoint !== undefined) {
            // **`--entrypoint <程序>` 的真实 argv**（R20A-01 的伴随修法）：docker/podman 的语义是
            // "用 `<程序>` **替换**镜像的 ENTRYPOINT，镜像之后那些词作为它的**参数**"——
            // 也就是 `docker run --entrypoint sh <镜像> -c '<文本>'` 真正执行的是
            // `sh -c '<文本>'`。修前只把 `<程序>` 那一个词交给递归（`acceptNested(…, 'sh')`）：
            //   · `sh` 单独成一条命令 ⇒ 被 R20A-01 的"解释器脚本位缺失"判红（真仓
            //     `scripts/ci-build-channel-images.sh` 的 `--entrypoint sh … -c '…'` 实测撞上）；
            //   · 而且 `-c` 的取值（真正被执行的那段文本）**从来没进过任何一张网**。
            // 按真实 argv 拼接后，两条都收口：`-c` 的取值按内层 shell 文本递归（与解释器同口径）。
            const argv = [probe.entrypoint, ...words.slice(probe.commandIndex)]
            const inner = unwrapCommandWords(argv, strict)
            heads.push(...inner.heads)
            nestedTexts.push(...inner.nestedTexts)
            modules.push(...inner.modules)
            commandWords.push(...inner.commandWords)
            problems.push(...inner.problems)
            return stop()
          }
          index = probe.commandIndex
          wrapped = true
          continue
        }
      }
    }
    // ① shell 的 `-c <内层文本>`：内层是**另一段 shell 文本**（R15A-03 的 C3）。
    //    `-c` 之前的长选项必须一起跳过（R16A-05：修前循环条件 `!startsWith('--')` 直接退出，
    //    于是 `bash --noprofile --norc -c '<cmd>'` 整条不再递归）。
    if (COMMAND_SHELL_WORDS.has(head)) {
      // **R20A-01**：旗标段（含"带取值的旗标"与选项结束标记 `--`）的消费**只允许一份实现** ——
      // 就是 {@link shellScriptWordIndex}。修前这里是手写循环：遇到 `--` 就停、也不认
      // `-O extglob` 的取值位 ⇒ 脚本位被掩蔽（`bash -- "$P"` / `bash -O extglob "$P"` 实测 EXIT=0）。
      const { scriptIndex, commandText } = shellScriptWordIndex(words, index)
      if (commandText !== null) {
        acceptNested(`${head} ${commandText.flag}`, commandText.text)
        return stop()
      }
      const scriptWord = scriptIndex < 0 ? undefined : words[scriptIndex]
      // **here-string**（`bash <<< '<脚本文本>'`）：取值就是被执行的脚本文本（R17A-02）。
      if (scriptWord === SHELL_HERESTRING_MARKER) {
        acceptNested(`${head} <<<`, words[scriptIndex + 1])
        return stop()
      }
      // **脚本位缺失**（`bash` / `bash -e` / `bash --`）：读不到脚本位 ≠ 没有执行面 ——
      // 不带脚本位的 shell 会**从 stdin 读命令**（`cat scripts/x.sh | bash`、`bash < x.sh`），
      // CI 的 stdin 完全可以是仓内内容 ⇒ 与"脚本位读不懂"同一口径 fail-closed
      // （R20A-01 的收口③："越界/只有旗标"不得静默当成"这一层没有端到端"）。
      if (scriptWord === undefined) {
        problems.push({
          kind: 'shell-argument-unreadable',
          word: '',
          raw: words.slice(index).join(' '),
          message: `\`${head}\` 的**脚本位缺失**（${words.slice(index).join(' ')}）—— 旗标段之后没有`
            + '任何脚本位，而 shell 这时会**从 stdin 读命令**（`cat <文件> | bash` / `bash < <文件>`），'
            + '闭包判不了 stdin 里是什么 ⇒ fail-closed 记红（修前这一格是"取不到脚本位就放行"，'
            + 'R20A-01）。请把脚本写成**字面路径**（`bash <仓内相对路径>`），或把这一处登记进 '
            + '`CI_SURFACE_VARIABLE_COMMAND_ACK`。',
        })
        return stop()
      }
      // **脚本位读不懂**（`bash 'a b'` / `bash *.sh` / `bash "$D/x.sh"` / `bash /tmp/x.sh`）：
      // 闭包判不了它跑什么 ⇒ fail-closed（R18A-01：含 `/` **不再**豁免）。
      // 唯一的"可读"路径形态是根变量前缀（`$GITHUB_WORKSPACE/scripts/x.sh`）：剥掉前缀后
      // 按正常载体跟随处理（跟得上就跟随、跟不上按 `carrier-command-missing` 记红）。
      const rootRelative = stripRootVariablePrefix(scriptWord)
      const scriptShape = rootRelative === undefined ? shellScriptPositionShape(scriptWord) : undefined
      if (scriptShape !== undefined) {
        problems.push({
          kind: 'shell-argument-unreadable',
          word: scriptWord,
          raw: words.slice(index).join(' '),
          message: `\`${head}\` 的脚本位读不懂（${words.slice(index).join(' ')}）—— 形态：`
            + `**${scriptShape}**。这一位闭包判不了它到底执行哪个文件或哪段文本`
            + '（`bash <<< \'<命令>\'`、`bash <(…)`、`bash *.sh`、`bash "$D/x.sh"`、'
            + '`bash -- "$P"` 同族），'
            + '所以按 fail-closed 记红，不再"解析不出名字就放过"（R18A-01 的现场正是'
            + '`bash "$D/x.sh"` 既不被跟随也不记红）。请把它写成仓内脚本的**字面路径**'
            + '（或 `$GITHUB_WORKSPACE/<仓内相对路径>`），或把这一处登记进 '
            + '`CI_SURFACE_VARIABLE_COMMAND_ACK`。'
            + '\n  注：`$(dirname "$0")/<尾段>` / `${BASH_SOURCE[0]%/*}/<尾段>` / 裸 `$0` 这类'
            + '**自指脚本位**会在被跟随的仓内 shell 脚本正文里按"当前脚本所在目录"求值'
            + '（R19A-04；**R20A-02 收口**：`$0` 系只在脚本被**执行**时成立，被 `source` 时'
            + '`$0` 仍是调用者 ⇒ 那里不求值、维持 fail-closed）；'
            + '这条仍然是红的，说明求值出的候选**不在仓内**（或越出了仓库根）——'
            + '请把尾段写成仓内真实存在的相对路径，或按上面两条出路处理。',
        })
        return stop()
      }
      pushHead(rootRelative === undefined
        ? words.slice(index)
        : [head, rootRelative, ...words.slice(scriptIndex + 1)])
      return stop()
    }
    // ①a2 `source <脚本>` / `. <脚本>`（**R20A-01 的同族站点**）：`source`/`.` 是标准词，
    //     不走上面的解释器分支 —— 修前它们的脚本位**从来没被取过词**（`source -- "$P"` 的
    //     `--` 落在参数位扫描里被当旗标跳过，脚本位读不懂也不记红；审计夹具 `d-param-src` 实测
    //     EXIT=0，而 tripwire 证明运行期真的执行了端到端入口）。
    //     取词与形态判据与解释器**同一份**（同一个 {@link shellScriptWordIndex}）。
    if (head === 'source' || head === '.') {
      const { scriptIndex, commandText } = shellScriptWordIndex(words, index)
      // `source -c '<文本>'` 不是合法形态：脚本位取不到就是读不懂（fail-closed，不特判）。
      const scriptWord = commandText === null && scriptIndex >= 0 ? words[scriptIndex] : undefined
      if (scriptWord === SHELL_HERESTRING_MARKER) {
        acceptNested(`${head} <<<`, words[scriptIndex + 1])
        return stop()
      }
      const rootRelative = stripRootVariablePrefix(scriptWord)
      const scriptShape = rootRelative === undefined ? shellScriptPositionShape(scriptWord) : undefined
      if (scriptShape !== undefined) {
        problems.push({
          kind: 'shell-argument-unreadable',
          word: scriptWord ?? '',
          raw: words.slice(index).join(' '),
          message: `\`${head}\` 的**被 source 的脚本位**读不懂（${words.slice(index).join(' ')}）—— 形态：`
            + `**${scriptShape}**。 \`source <脚本>\`（\`.\` 同义）的脚本位与解释器的脚本位同义，`
            + '都是"要执行的文件的文本"，只是执行发生在**当前 shell** 里；闭包读不懂它就读不到那份'
            + '脚本文本 ⇒ 按 fail-closed 记红（R20A-01：修前 `source -- "$P"` 的脚本位被 `--` 掩蔽，'
            + '整条判据失效）。请把它写成仓内脚本的**字面路径**'
            + '（或 `$GITHUB_WORKSPACE/<仓内相对路径>`），或把这一处登记进 '
            + '`CI_SURFACE_VARIABLE_COMMAND_ACK`。'
            + '\n  注（R20A-02）：被 `source` 的脚本里 `$0` **仍是调用者**，所以'
            + '`$(dirname "$0")/<尾段>` 在那里不求值（`${BASH_SOURCE[0]%/*}/<尾段>` 才是自指）。',
        })
        return stop()
      }
      pushHead(rootRelative === undefined
        ? words.slice(index)
        : [head, rootRelative, ...words.slice(scriptIndex + 1)])
      return stop()
    }
    // ①b `find … -exec <命令> … {;|+}`：命令在**参数位**（R16A-07）。
    if (head === 'find') {
      const execFlags = COMMAND_WRAPPER_SPECS.get('find').findExecFlags
      let cursor = index + 1
      while (cursor < words.length) {
        if (!execFlags.includes(words[cursor])) { cursor += 1; continue }
        const rest = words.slice(cursor + 1)
        // 终止符：`\;`（shell 里转义过的分号）/ `;` / GNU 的 `+`。
        const terminator = rest.findIndex(word => word === ';' || word === '\\;' || word === '+')
        const argv = terminator >= 0 ? rest.slice(0, terminator) : rest
        if (argv.length > 0) {
          requireRegistered(argv[0], argv)
          // **R18A-02**：`-exec <shell> <脚本位> …` 的脚本位与命令行上的脚本位**同义**
          // （都是"要执行的文件"），所以同一套 fail-closed 必须罩到它。修前的现场：
          // `find scripts -maxdepth 1 -name 'x.sh' -exec bash {} \;` 的 `{}` 既不解析、
          // 也不跟随、也不判红（同族的 `xargs -I{} bash {}` 早就红了）⇒ 被 `-exec` 执行的
          // 那份包装脚本整份不可见，而 CI 真的会跑它。
          if (COMMAND_SHELL_WORDS.has(argv[0]) || argv[0] === 'source' || argv[0] === '.') {
            // **R20A-01**：脚本位的**取词**与命令行上的解释器分支共用同一份实现
            // （{@link shellScriptWordIndex}）—— 修前这里直接读 `argv[1]`，于是
            // `find … -exec bash -- {} \;` 的 `argv[1]` 是 `--`（被 `startsWith('-')` 放行）、
            // `find … -exec bash -O extglob {} \;` 的 `argv[1]` 是取值位 `extglob`
            // ⇒ 与解释器分支口径不一致，正是本条的根因。
            const { scriptIndex, commandText } = shellScriptWordIndex(argv, 0)
            if (commandText !== null) {
              // `find … -exec bash -c '<文本>' …`：与解释器分支同口径（取值是内层 shell 文本）。
              acceptNested(`find … -exec ${argv[0]} ${commandText.flag}`, commandText.text)
              cursor += 1
              continue
            }
            const scriptWord = scriptIndex < 0 ? undefined : argv[scriptIndex]
            const rootRelative = stripRootVariablePrefix(scriptWord)
            const scriptShape = rootRelative === undefined ? shellScriptPositionShape(scriptWord) : undefined
            if (scriptShape !== undefined) {
              problems.push({
                kind: 'shell-argument-unreadable',
                word: scriptWord ?? '',
                raw: argv.join(' '),
                message: `\`find … -exec ${argv.join(' ')}\` 的脚本位读不懂 —— 形态：`
                  + `**${scriptShape}**。 \`-exec\` 的脚本位与命令行上的脚本位同义，`
                  + '`{}` 是 find 的占位符（到底执行哪些文件由运行期决定），闭包读不到那份脚本文本 ⇒ '
                  + '按 fail-closed 记红。请改成闭包能读到的字面路径（例如把循环写进一个仓内脚本），'
                  + '或把这一处登记进 `CI_SURFACE_VARIABLE_COMMAND_ACK`。',
              })
              return stop()
            }
            if (rootRelative !== undefined) {
              pushHead([argv[0], rootRelative, ...argv.slice(scriptIndex + 1)])
              cursor += 1
              continue
            }
          }
          pushHead(argv)
        }
        cursor += 1
      }
      return stop()
    }
    // ② 两词包装（`npm exec -- <命令>` / `yarn dlx <命令>` / `poetry run <命令>`）。
    const multi = COMMAND_MULTI_WORD_WRAPPERS.get(`${head} ${words[index + 1] ?? ''}`)
    if (multi !== undefined) {
      const label = `${head} ${words[index + 1]}`
      index += 2
      wrapped = true
      const { execTexts, codeTexts, lookup } = skipFlags(multi)
      for (const { flag, text } of execTexts) acceptNested(`${label} ${flag}`, text)
      for (const { flag, text } of codeTexts) acceptCode(`${label} ${flag}`, text)
      if (execTexts.length > 0 || codeTexts.length > 0) return stop()
      if (lookup) return stop()
      // 包运行器的**包内 bin**（`yarn dlx <工具>`）：见 {@link PACKAGE_RUNNER_WORDS}。
      if (multi.packageRunnerBin === true && consumePackageRunnerBin(label)) return stop()
      continue
    }
    // ③ 单词包装。
    const spec = COMMAND_WRAPPER_SPECS.get(head)
    if (spec === undefined) {
      // **包装链尽头是变量展开**（`timeout 60 $RUNNER …` / `sudo $OPTS make …`）：跑什么不可知
      // ⇒ fail-closed。只对"经已登记包装走到的位"生效 —— 裸命令位上的 `"$@"` / `$line` 这类
      // 循环变量是 shell 常规写法（本仓多处如此），把它们一律判红会让判据无法使用，
      // 而它们并不属于"包装链把 make 藏起来"这一族。
      if (wrapped && (head.startsWith('$') || head.includes('$('))) {
        problems.push({
          kind: 'variable-command',
          word: head,
          raw: words.slice(index).join(' '),
          message: `包装链尽头的命令位是变量展开（${words.slice(index).join(' ')}）——`
            + ' 闭包判不了它跑什么，按 fail-closed 记红（请把它写成字面量，'
            + `或把这一处逐字登记进 \`CI_SURFACE_VARIABLE_COMMAND_ACK\`）`,
        })
        return stop()
      }
      const argv = words.slice(index)
      if (!(wrapped && (head.startsWith('$') || head.includes('$(')))) requireRegistered(head, argv)
      pushHead(argv)
      return stop()
    }
    const label = head
    index += 1
    wrapped = true
    // **R21 fix-6 / E-01**：`-m <模块>` 会把模块名推进 `modules`（那不是脚本位）——
    // 记下 `skipFlags` 之前的条数，下面据此区分"脚本位"与"模块名"。
    const modulesBefore = modules.length
    const { execTexts, codeTexts, lookup } = skipFlags(spec)
    for (const { flag, text } of execTexts) acceptNested(`${label} ${flag}`, text)
    for (const { flag, text } of codeTexts) acceptCode(`${label} ${flag}`, text)
    if (execTexts.length > 0 || codeTexts.length > 0) return stop()
    if (lookup) return stop()
    if (spec.assignments === true) skipNoise()
    // **字符串参数执行面**（R17-X，R17A-02）：`eval '<命令文本>'` —— 剩余全部实参拼起来就是
    // 一段要执行的 shell 文本，按**入口形态**（严格面）递归。
    if (spec.shellTextArgs === true) {
      acceptNested(label, words.slice(index).join(' '), NESTED_SHELL_STRICT)
      return stop()
    }
    // `trap '<命令文本>' <信号…>`：第一个非旗标实参是命令文本，其余是信号名。钩子体里
    // 常见的是**同文件的清理函数**（`trap cleanup EXIT`），逐词登记等于要求为函数名背书
    // ⇒ 用 lenient 面（载体跟随 + make/compose 扩张 + token/文本网，不开逐词登记）。
    if (spec.trapText === true) {
      while (words[index] === '--') index += 1
      const text = words[index]
      if (text === undefined || text === '-' || text === "''" || text === '""') return stop()
      acceptNested(label, text, NESTED_SHELL_LENIENT)
      return stop()
    }
    // 包运行器的**包内 bin**（`npx <工具>`）：见 {@link PACKAGE_RUNNER_WORDS}。
    if (spec.packageRunnerBin === true && consumePackageRunnerBin(label)) return stop()
    // **解释器**（`node <脚本> [参数…]` / `python3 <脚本>`）：脚本是**参数位上的载体**，
    // 由调用方的通用扫描跟随；它不是新的命令位（把 `x.mjs` 当命令名去登记是错的 ——
    // 真仓实测 `node r16a_runner.cjs` 会被判"未登记的可执行名"而不是"跟随到了载体"）。
    if (spec.scriptPositional === true) {
      const rest = words.slice(index)
      if (rest.length > 0) {
        // **根变量前缀**（`node "$GITHUB_WORKSPACE/scripts/x.mjs"`）：剥掉前缀就是仓内相对
        // 路径，按正常载体跟随处理（与 shell 脚本位同一口径，见 {@link stripRootVariablePrefix}）。
        const rootRelative = stripRootVariablePrefix(rest[0])
        if (rootRelative !== undefined) {
          pushHead([rootRelative, ...rest.slice(1)], { checkRegistry: false })
          return stop()
        }
        // 脚本位是**变量**（`node "$VERIFY_SCRIPT"`）：闭包判不了它跑什么 ⇒ 同一族 problem
        // （可逐处登记进 `CI_SURFACE_VARIABLE_COMMAND_ACK`）。
        if (rest[0].startsWith('$') || rest[0].includes('$(')) {
          problems.push({
            kind: 'variable-command', word: rest[0], raw: rest.join(' '),
            message: `解释器的脚本位是变量展开（${rest.join(' ')}）—— 闭包判不了它跑什么，`
              + '按 fail-closed 记红（请把它写成字面量，或把这一处逐字登记进 '
              + '`CI_SURFACE_VARIABLE_COMMAND_ACK`）',
          })
          return stop()
        }
        // **R21 fix-6 / E-01**：脚本**存在**时把解释器词一起入 head（`[node, <脚本>, …]`），
        // 否则这一位只是一个"光秃秃的词"，下游只按 `isRepoRelativePathWord(command) &&
        // (command.includes('/') || command.includes('.'))` 才认它是命令位 —— 于是
        // **无扩展名的脚本**（`node gen` / `python3 gen`，生成物落在 CWD 的另一种写法）
        // 整族隐形。带上解释器词之后，②b 的脚本位判据（与 `bash gen.sh` 同一份）照常生效。
        // 只在"确实取到脚本位"时这么做：`python3 -m <模块>` 的 `rest[0]` 是模块**之后的参数**
        // （不是脚本位），带上解释器词会让它被当成脚本位 ⇒ 假红（`python3 -m http.server 8000`）。
        const scriptPosition = modules.length === modulesBefore
        pushHead(scriptPosition ? [label, ...rest] : rest, { checkRegistry: false })
      }
      return stop()
    }
    // 位置参数的**个数是固定的**（`timeout <时长>` / `flock <锁文件>` / `taskset <掩码>`）：
    // 取值读不懂也不影响"它跑哪条命令"，按个数跳过即可（时长/锁文件/掩码不是命令）。
    for (let taken = 0; taken < (spec.positional ?? 0); taken += 1) {
      if (words[index] === undefined) break
      index += 1
    }
  }
  problems.push(`命令位的包装链超过深度上限 ${CI_SURFACE_MAX_HOPS}（${words.join(' ')}）——`
    + ' 读不懂 ⇒ fail-closed（不把"解析不了"当成"这一层没有端到端"）')
  return stop()
}

/** 同一目录下 Makefile 的候选名（GNU make 的查找顺序）。 */
const MAKEFILE_NAMES = ['Makefile', 'makefile', 'GNUmakefile']

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
  /**
   * 一个原始片段 → token（两端按**字符类**线性裁剪）。
   * 不用 `^[^…]+` / `[^…]+$` 这类锚定正则：长 token 上它们会退化成 O(n²) 的回溯
   * —— 真仓实测这一处占闭包总时间的四分之一。
   * @param raw - 片段。
   */
  const pushToken = raw => {
    let start = 0
    let end = raw.length
    while (start < end && !/[A-Za-z0-9_$@./:-]/u.test(raw[start])) start += 1
    while (end > start && !/[A-Za-z0-9_$@./:-]/u.test(raw[end - 1])) end -= 1
    const token = raw.slice(start, end)
    if (token === '' || token.startsWith('-') || token.includes('$')) return
    if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(token)) return
    tokens.push(token)
  }
  for (const rawLine of String(source).split('\n')) {
    const line = rawLine.replace(/(?:^|\s)#.*$/u, '').trim()
    if (line === '') continue
    for (const raw of line.split(/[\s|&;()<>]+/u)) {
      // `$` 保留在字符集里：变量拼出来的路径（`"$DIR/run-all.sh"`）必须能被**判成解析不了**
      // 并跳过，而不是把 `$` 连同前缀一起剥掉之后当成一条真路径记进 `reached`。
      pushToken(raw)
    }
  }
  // **R17-X**：把"字面量只出现在赋值里"的词也当 token 交出去。现场（R17A-03）：
  // `D=integration; N=run; bash "$D-tests/$N-all.sh"` —— 正文里逐字既没有 `integration-tests`
  // 也没有 `run-all.sh`，于是文本网 0 命中、token 网无路径可跟随、命令位是登记过的 `bash`
  // ⇒ 三张网同时绕过而 CI 真的执行到入口。只有**真的发生了替换**的词补进来（逐字未变的词
  // 原扫描已经收过；把注释词/散文也塞进 token 面只会制造新的假阳性）。
  if (SHELL_INDIRECTION_PATTERN.test(String(source))) {
    for (const { resolved } of shellCommandAnalysis(source).substitutions) pushToken(resolved)
  }
  return tokens
}

/**
 * **here-doc 的正文不是命令、终止词不是路径** —— 命令位扫描前先把它们收进
 * `-c '<正文>'`（R22 FIX-14 / V7-06 的误红面）。
 *
 * ## 现场
 *
 * CI 里完全良性的两种写法（本仓当前没有，但都是标准 shell）：
 *
 * ```yaml
 * - run: |
 *     python3 - <<'PY'
 *     import json
 *     print(json.dumps({}))
 *     PY
 *     bash -s <<'EOF'
 *     echo hello
 *     EOF
 * ```
 *
 * 修前 `check-integration-tests.mjs` 在这一段上打出 **8 条**诊断：正文里的 `import` /
 * `print` / `json.dumps` 被读成"命令位上未登记的可执行名"，终止词 `PY` / `EOF` 被读成命令名、
 * 又被读成"**脚本位指向仓内不存在的路径** `PY`（python3 PY）"。**正文是数据、终止词是流标记，
 * 都不是仓库里的路径** —— 这一格修前也是红的（不是绿/红翻转），但诊断是错的：它把"判据读不懂
 * 这个形态"说成了"仓里少了一个脚本"，会把人引向完全错误的修法（去建一个叫 `PY` 的文件）。
 *
 * ## 口径
 *
 * 行级重写（只用于**命令位扫描**；文本网/token 网仍读原文 —— 那是"提到过就算"的方向）：
 *   · 认出 `<<` / `<<-` 后面的终止词，吃掉正文与终止词行；
 *   · 命令词是 **shell / python 解释器**时，把正文交回去当**程序文本**：
 *     `bash -s <<'EOF' …` → `bash -c '<正文>'`、`python3 - <<'PY' …` → `python3 -c '<正文>'`
 *     （两者在闭包里都有既有的"内层文本/源码"通道，正文里的执行调用照常被跟随、照常判）；
 *   · 其它命令（`cat > x <<EOF`）：正文只是数据，去掉即可（写目标由重定向那一路照常记录）。
 * `cat <<'EOF' | bash` 这类"正文经管道喂给 shell"的形态**不在**这里的识别面内 —— 去掉正文后
 * 命令行上是"`bash` 没有脚本位"，仍按既有口径 fail-closed（那是"stdin 里是什么判不了"，
 * 与"路径不存在"是两回事，诊断也不再指向一个不存在的文件）。
 *
 * 边界（认账）：行级扫描器 —— 命令词取该行第一个词（`if bash -s <<EOF` 这种带语法构件的写法
 * 按"其它命令"处理：正文被去掉、命令行上留下"脚本位缺失"的 fail-closed）；一行多个 here-doc
 * 时只有第一个正文被内联（其余按数据去掉）；引号里出现的 `<<` 若后面恰好跟标识符也会被当作
 * here-doc（宁可少读一段命令文本，也不把正文读成命令）。
 * @param source - 一段 shell 文本。
 * @returns 重写后的文本（here-doc 正文不再出现在命令行上）。
 */
function inlineHeredocs(source) {
  const lines = String(source).split('\n')
  const out = []
  let cursor = 0
  while (cursor < lines.length) {
    const line = lines[cursor]
    const operators = [...line.matchAll(HEREDOC_OPERATOR)]
    if (operators.length === 0) {
      out.push(line)
      cursor += 1
      continue
    }
    let stripped = line
    let body = null
    let scan = cursor + 1
    for (const [at, match] of operators.entries()) {
      const collected = []
      while (scan < lines.length && lines[scan].trim() !== match[2]) {
        if (at === 0) collected.push(match[1] === '-' ? lines[scan].replace(/^\t+/u, '') : lines[scan])
        scan += 1
      }
      if (scan < lines.length) scan += 1 // 终止词那一行
      if (at === 0) body = collected.join('\n')
      stripped = stripped.replace(match[0], '')
    }
    const command = stripped.trim().split(/\s+/u)[0] ?? ''
    if (body !== null && body !== '' && HEREDOC_PROGRAM_WORDS.has(command)) {
      out.push(`${stripped.trimEnd()} -c ${shellSingleQuote(body)}`)
    } else {
      out.push(stripped)
    }
    cursor = scan
  }
  return out.join('\n')
}

/**
 * JS/TS 源码 → **同文件内的常量绑定表**（`const|let|var NAME = <表达式>`）—— R18A-03 的收口件。
 *
 * ## 现场
 *
 * 修前 JS/TS 的"跑什么"只由 {@link jsExecArgumentLiterals} 的**实参窗口里的引号字面量**回答
 * （`E2E` 文本网对 `.mjs/.cjs/.js/.ts` 显式关闭，见 {@link CI_SURFACE_TEXT_NET_SCRIPT_EXTENSIONS}）。
 * 于是 Node 里**最常规**的两种写法整族不可见 —— 路径先解析、再执行：
 *
 *   · `const T = 'integration-tests/run-all.sh'; spawnSync('bash', [T])`      ⇒ 修前 EXIT=0
 *   · `const target = join(ROOT, 'integration-tests', 'run-all.sh')` + `[target]` ⇒ 修前 EXIT=0
 *   · `const parts = ['integration','tests','run-all.sh']` + `parts[0]+'-'+…`  ⇒ 修前 EXIT=0
 *
 * （只有把字面量**直接写进调用实参**才红 —— 那正是"最不像真实代码"的写法。）
 *
 * ## 判据
 *
 * 收集同文件里的 `const|let|var` 绑定（模块级与函数级都收 —— 解析是**按需**的：
 * 只有出现在执行调用实参里的标识符才会被展开），再把实参表达式解析成候选字面量：
 * 字符串/模板字面量、标识符（递归展开）、`join|resolve|normalize` 拼接、数组字面量与下标、
 * 对象字面量的成员访问（"常量表"形态）、`+` 拼接、`NAME.join('/')`。
 * 候选字面量回到既有的 token 网 / `reached` 判据 ⇒ 命中端到端入口一样要登记。
 *
 * **诚实边界**：不做跨文件/跨函数（形参）传播 —— `spawnSync('bash', [script])` 里 `script`
 * 是形参时不展开（本仓 `scripts/verify-ci-scripts.mjs` 大量如此，若一律 fail-closed 就是
 * 误报工厂）。这一层覆盖的是"同文件常量 + 拼接"这一族；**没有**对 JS 实参做 blanket
 * fail-closed，理由与 {@link jsExecArgumentLiterals} 头注释同：解析得出的候选回到
 * token 网/`reached` 判据后，"被执行的包装脚本"也会被跟随并继续扫描，缺口面因此收敛到
 * "整条链都靠运行期取值"这一族（那一族属闭包声明面之外，见 `ciExecutionSurface` 头注释）。
 * @param source - JS/TS 源码文本。
 * @returns `Map<名字, { expression, ambiguous }>`。
 */
function jsConstantBindings(source) {
  const text = String(source)
  const bindings = new Map()
  /** 记一条绑定；同名再赋值 ⇒ **歧义**（作用域不同/被改写）⇒ 不展开：宁可"看不见"也不猜错。 */
  const record = (name, expression) => {
    if (expression === undefined || expression.trim() === '') return
    const previous = bindings.get(name)
    if (previous !== undefined) { bindings.set(name, { expression: previous.expression, ambiguous: true }); return }
    bindings.set(name, { expression: expression.trim(), ambiguous: false })
  }
  const pattern = /(?:^|[\s;{}(])(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*/gu
  for (const match of text.matchAll(pattern)) {
    record(match[1], readJsExpressionAt(text, match.index + match[0].length))
  }
  // **数组解构**（R19A-02 ①）：`const [CMD, ARGS] = ['bash', '…']` —— 每个名字绑到右侧
  // 数组的**对应元素表达式**上。只认"右侧是数组字面量"这一形态（其余运行期取值不猜）。
  const destructuring = /(?:^|[\s;{}(])(?:const|let|var)\s*\[([^\]]*)\]\s*=\s*/gu
  for (const match of text.matchAll(destructuring)) {
    const expression = readJsExpressionAt(text, match.index + match[0].length)
    if (expression === undefined) continue
    const arrayExpression = expression.trim()
    if (!arrayExpression.startsWith('[') || balancedJsClose(arrayExpression, 0) !== arrayExpression.length - 1) continue
    const names = splitJsTopLevel(match[1], ',')
    const items = splitJsTopLevel(arrayExpression.slice(1, -1), ',')
    for (const [index, name] of names.entries()) {
      // 跳过 hole / 嵌套模式 / 默认值（`[A = 'x']` 的取值另有语义，不在这里猜）。
      if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(name)) continue
      record(name, items[index])
    }
  }
  return bindings
}
/**
 * JS/TS 源码 → **局部常量绑定 + import 名表**（R19A-02 ①）。
 *
 * 与 {@link jsConstantBindings} 的两点增量：
 *   · **数组解构**（`const [CMD, ARGS] = ['bash', '…']` / `const [X] = someArray`）——
 *     每个名字绑到右侧数组的**对应元素表达式**上，于是 `spawnSync(CMD, ARGS)` 这类
 *     "先解构再执行"的写法与直接下标同族可见；
 *   · **import 名表**（`import { ENTRY as E } from './paths.mjs'` / `import DEF from './x.mjs'`）——
 *     名字的**取值不在本文件里**，交给调用方注入的 `resolveImport` 惰性求值（只在它真的
 *     出现在执行调用实参里才去读被 import 的仓内模块）。
 * @param source - JS/TS 源码文本。
 * @param resolveImport - 可选：`(specifier, importedName) => { expression } | { unreadable } | undefined`。
 * @param reportUnreadable - 可选：`(detail) => void`，把"import 了仓内模块却解析不出该导出常量"
 *   记成 fail-closed（读不懂就不许当成"这一层没有端到端"）。
 * @returns 绑定表（`get(name)` 语义：局部优先、其次惰性 import）。
 */
function jsImportBindings(source, resolveImport = undefined, reportUnreadable = undefined) {
  const text = String(source)
  const local = jsConstantBindings(text)
  /** `import { A, B as C } from '<spec>'` / `import DEF from '<spec>'` / `import * as NS from '<spec>'`。 */
  const imports = new Map()
  /**
   * 记一条"取值在别的模块里"的名字（惰性求值，见返回值的 `get`）。
   *
   * 名字允许**一个点**：命名空间成员按复合键 `NS.成员` 登记（R20A-03 ①），
   * 普通 import 名是一个标识符。多于一层的成员访问（`NS.a.b`）不登记 —— 那是二级取值，
   * 闭包的常量表不建模（认账边界）。
   */
  const recordImport = (name, specifier, imported) => {
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)?$/u.test(name)) return
    imports.set(name, { specifier, imported })
  }
  /**
   * **命名空间绑定**（`import * as NS` / `const NS = (await )?import('…')` /
   * `const NS = require('…')`）—— R20A-03 ①。
   *
   * 命名空间对象本身不是路径（`spawnSync('bash', [NS])` 判不了），但它**静态可见的成员**
   * （`NS.ENTRY` / `NS['ENTRY']`）等价于"从那个模块命名导入 ENTRY"。所以：把正文里所有
   * `NS.<成员>` 的成员登记成**复合键** `NS.<成员>`（{@link resolveJsExpression} 的成员访问
   * 分支按这个键查表），取值仍然惰性求值 —— 只有真的被用到才去读被 import 的仓内模块。
   */
  const recordNamespace = (name, specifier) => {
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(name)) return
    namespaces.set(name, specifier)
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    for (const match of text.matchAll(new RegExp(`\\b${escaped}\\s*\\.\\s*([A-Za-z_$][A-Za-z0-9_$]*)`, 'gu'))) {
      recordImport(`${name}.${match[1]}`, specifier, match[1])
    }
    for (const match of text.matchAll(new RegExp(`\\b${escaped}\\s*\\[\\s*(['"])([A-Za-z_$][A-Za-z0-9_$]*)\\1\\s*\\]`, 'gu'))) {
      recordImport(`${name}.${match[2]}`, specifier, match[2])
    }
  }
  /** 被登记为"命名空间"的名字（这些名字本身不求值，见返回值的 `get`）。 */
  const namespaces = new Map()
  /** `import { A, B as C } from '<spec>'` 的**子句** → 逐名登记（`{ }` / 默认 / 命名空间三种）。 */
  const recordImportClause = (clause, specifier) => {
    const named = /\{([^}]*)\}/u.exec(clause)
    if (named !== null) {
      for (const entry of named[1].split(',')) {
        const parts = entry.split(/\s+as\s+/u).map(part => part.trim()).filter(part => part !== '')
        if (parts.length === 0) continue
        recordImport(parts[parts.length - 1], specifier, parts[0])
      }
    }
    const namespace = /^\s*\*\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*$/u.exec(clause.split(',')[0])
    if (namespace !== null) {
      recordNamespace(namespace[1], specifier)
      return
    }
    const defaultName = clause.split(',')[0].replace(/\{[^}]*\}/u, '').trim()
    if (defaultName !== '') recordImport(defaultName, specifier, 'default')
  }
  for (const match of text.matchAll(/(?:^|[\s;])import\s+([^;'"]*?)\s+from\s*(['"])([^'"]+)\2/gu)) {
    recordImportClause(match[1], match[3])
  }
  // **动态 `import('…')` 与 CJS `require('…')`**（R20A-03 ①的同族）：两者都是
  // "取值在**另一个模块**里"，只是形态不同 ——
  //   · `const mod = await import('./paths.mjs')` / `const mod = require('./paths.cjs')`
  //     ⇒ 命名空间绑定（成员按复合键惰性求值）；
  //   · `const { ENTRY } = await import('./paths.mjs')` / `const { ENTRY } = require('./paths.cjs')`
  //     ⇒ 逐名绑定。
  // 修前这两族整族隐形（连"模块存在"都不知道 ⇒ 从不被读、字面量从不进任何网）。
  const dynamicImport = /(?:^|[\s;{}])(?:const|let|var)\s+(\{[^}]*\}|[A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:await\s+)?(?:import|require)\s*\(\s*(['"])([^'"]+)\2\s*\)/gu
  for (const match of text.matchAll(dynamicImport)) {
    const target = match[1]
    if (target.startsWith('{')) {
      for (const entry of target.slice(1, -1).split(',')) {
        const parts = entry.split(/\s*:\s*/u).map(part => part.trim()).filter(part => part !== '')
        if (parts.length === 0) continue
        recordImport(parts[0], match[3], parts[parts.length - 1])
      }
      continue
    }
    recordNamespace(target, match[3])
  }
  const imported = new Map()
  return {
    /** 局部绑定优先；未命中且是 import 名 ⇒ 惰性求值（每个名字只求一次）。 */
    get(name) {
      const hit = local.get(name)
      if (hit !== undefined) return hit
      // **命名空间对象本身**不是字面量（`spawnSync('bash', [NS])` 这一形态判不了它跑什么，
      // 也**不记红**：那是形参/运行期取值同族的边界，见 {@link jsExecArgumentLiterals} 的
      // 误报面）。它的成员走上面的复合键，仍按 fail-closed 口径处理。
      if (namespaces.has(name)) return undefined
      const spec = imports.get(name)
      if (spec === undefined || resolveImport === undefined) return undefined
      if (imported.has(name)) return imported.get(name)
      const resolved = resolveImport(spec.specifier, spec.imported, name)
      let entry
      if (resolved !== undefined && resolved.expression !== undefined) {
        entry = { expression: resolved.expression, ambiguous: false }
      } else if (resolved !== undefined && resolved.unreadable !== undefined) {
        // **fail-closed**：import 的是**仓内**模块、而这个导出常量读不懂 ⇒ 记红
        // （外部包不在此列：它的取值来自 node_modules，闭包结构上跟随不了，见 resolveImport 的文档）。
        reportUnreadable?.(resolved.unreadable)
        entry = undefined
      }
      imported.set(name, entry)
      return entry
    },
    /** 写入（调用方只需读；保留 set 是为了与 Map 的既有用法同形）。 */
    set(name, value) { local.set(name, value) },
  }
}
/**
 * 从 `start` 起读一个 JS 表达式（到语句结束：深度回到 0 时的换行 / `;` / `,`）。
 * 字符串、模板字面量、注释都按字面跳过（不做解析，只要边界正确）。
 * @param text - 源码。
 * @param start - 表达式起点下标。
 * @returns 表达式文本（未 trim）；读不到返回 `undefined`。
 */
function readJsExpressionAt(text, start) {
  let depth = 0
  let index = start
  const limit = Math.min(text.length, start + 4000)
  for (; index < limit; index += 1) {
    const character = text[index]
    if (character === '/' && text[index + 1] === '/') {
      const end = text.indexOf('\n', index)
      if (end < 0) break
      index = end
      continue
    }
    if (character === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2)
      if (end < 0) break
      index = end + 1
      continue
    }
    if (character === "'" || character === '"' || character === '`') {
      index += 1
      while (index < limit && text[index] !== character) {
        if (text[index] === '\\') index += 1
        index += 1
      }
      continue
    }
    if (character === '(' || character === '[' || character === '{') { depth += 1; continue }
    if (character === ')' || character === ']' || character === '}') {
      if (depth === 0) break
      depth -= 1
      continue
    }
    if (depth === 0 && (character === '\n' || character === ';')) break
  }
  const expression = text.slice(start, index)
  return expression === '' ? undefined : expression
}
/**
 * 在**顶层**（不在括号/字符串/模板里）按分隔符切分一段 JS 文本。
 * @param text - 文本（调用实参表 / 数组 / 对象字面量的内部）。
 * @param separators - 分隔符集合（如 `,` 或 `+`）。
 * @returns 片段列表（已 trim、去掉空片段）。
 */
function splitJsTopLevel(text, separators) {
  const parts = []
  let depth = 0
  let start = 0
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (character === "'" || character === '"' || character === '`') {
      index += 1
      while (index < text.length && text[index] !== character) {
        if (text[index] === '\\') index += 1
        index += 1
      }
      continue
    }
    if (character === '(' || character === '[' || character === '{') { depth += 1; continue }
    if (character === ')' || character === ']' || character === '}') { depth -= 1; continue }
    if (depth === 0 && separators.includes(character)) {
      parts.push(text.slice(start, index))
      start = index + 1
    }
  }
  parts.push(text.slice(start))
  return parts.map(part => part.trim()).filter(part => part !== '')
}
/** 字符串字面量的**内容**（只处理常见转义；反引号模板另行处理）。 */
function jsStringLiteralValue(raw) {
  const match = /^(['"])([\s\S]*)\1$/u.exec(raw.trim())
  if (match === null) return undefined
  return match[2].replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/gu, (whole, escape) => {
    switch (escape) {
      case 'n': return '\n'
      case 't': return '\t'
      case 'r': return '\r'
      case '0': return '\0'
      case '\\': return '\\'
      case "'": return "'"
      case '"': return '"'
      case '`': return '`'
      default: return escape.startsWith('u') || escape.startsWith('x') ? whole : escape
    }
  })
}
/** `join|resolve|normalize` 一类的**路径拼接调用**的尾段名。 */
const JS_PATH_JOIN_CALLEES = new Set(['join', 'resolve', 'normalize', 'relative'])
/**
 * JS 表达式 → 候选字面量（R18A-03 的解析器）。
 *
 * 返回 `{ exact, parts }`：`exact` = 全解析出来时的取值；`parts` = 解析到的**字面量片段**
 * （含从绑定里展开出来的），供"拼接后才是路径"的形态（`join(ROOT,'a','b')`）使用。
 * @param expression - 表达式文本。
 * @param bindings - {@link jsConstantBindings} 的结果。
 * @param depth - 递归深度（展开标识符时 +1）。
 * @returns `{ exact, parts }`。
 */
function resolveJsExpression(expression, bindings, depth = 0) {
  const empty = { exact: undefined, parts: [] }
  if (expression === undefined || depth > 6) return empty
  let expr = expression.trim()
  while (expr.startsWith('(') && balancedJsClose(expr, 0) === expr.length - 1) expr = expr.slice(1, -1).trim()
  if (expr === '') return empty
  const literal = jsStringLiteralValue(expr)
  if (literal !== undefined) return { exact: literal, parts: [literal] }
  // 模板字面量：字面块 + `${…}`（各自递归解析）。
  if (expr.startsWith('`') && expr.endsWith('`') && expr.length >= 2) {
    const inner = expr.slice(1, -1)
    const parts = []
    let exact = ''
    let known = true
    let index = 0
    while (index < inner.length) {
      if (inner[index] === '\\') { exact += inner[index + 1] ?? ''; parts.push(inner[index + 1] ?? ''); index += 2; continue }
      if (inner[index] === '$' && inner[index + 1] === '{') {
        const end = balancedJsClose(inner, index + 1)
        if (end < 0) return { exact: undefined, parts }
        const nested = resolveJsExpression(inner.slice(index + 2, end), bindings, depth + 1)
        if (nested.exact === undefined) known = false
        else exact += nested.exact
        parts.push(...nested.parts)
        index = end + 1
        continue
      }
      const next = inner.indexOf('${', index)
      const end = next < 0 ? inner.length : next
      const chunk = inner.slice(index, end)
      exact += chunk
      if (chunk !== '') parts.push(chunk)
      index = end
    }
    return { exact: known ? exact : undefined, parts }
  }
  // `+` 拼接。
  const addition = splitJsTopLevel(expr, '+')
  if (addition.length > 1) {
    const resolved = addition.map(part => resolveJsExpression(part, bindings, depth + 1))
    const parts = resolved.flatMap(item => item.parts)
    const known = resolved.every(item => item.exact !== undefined)
    return { exact: known ? resolved.map(item => item.exact).join('') : undefined, parts }
  }
  // 数组字面量。
  if (expr.startsWith('[') && balancedJsClose(expr, 0) === expr.length - 1) {
    const items = splitJsTopLevel(expr.slice(1, -1), ',')
    const resolved = items.map(item => resolveJsExpression(item, bindings, depth + 1))
    return { exact: undefined, parts: resolved.flatMap(item => item.parts) }
  }
  // **数组常量的 `.slice()` / `.concat()`**（R19A-02 ①）：`spawnSync(CMD[0], CMD.slice(1))`
  // 是 Node 里最常见的"命令 + 参数数组"写法，修前整族不可见（`.slice()` 不是下标、也不是 join）。
  const arrayMethod = /^(.*?)\s*\.\s*(slice|concat)\s*\((.*)\)$/su.exec(expr)
  if (arrayMethod !== null) {
    const items = resolveJsArrayItems(expr, bindings, depth)
    if (items === undefined) return empty
    return { exact: undefined, parts: jsArrayItemParts(items, bindings, depth) }
  }
  // 调用表达式（`join(…)` / `resolve(…)` / `path.join(…)`）。
  const call = /^([A-Za-z_$][A-Za-z0-9_$.]*)\s*\(/u.exec(expr)
  if (call !== null && balancedJsClose(expr, call[0].length - 1) === expr.length - 1) {
    const callee = call[1].split('.').pop()
    const args = splitJsTopLevel(expr.slice(call[0].length, -1), ',')
    const resolved = args.map(arg => resolveJsExpression(arg, bindings, depth + 1))
    const parts = resolved.flatMap(item => item.parts)
    if (JS_PATH_JOIN_CALLEES.has(callee)) {
      const known = resolved.every(item => item.exact !== undefined)
      return {
        // 全部解析得出 ⇒ 按路径拼接口径给出精确值；有解析不出的实参（`ROOT`/`process.cwd()`）
        // ⇒ 退化成"**字面量片段按 `/` 拼起来**"的候选（`join(ROOT,'integration-tests','run-all.sh')`
        // ⇒ `integration-tests/run-all.sh`）。方向是 fail-closed：候选命中端到端入口同样要登记。
        exact: known ? resolved.map(item => item.exact).join('/') : parts.join('/'),
        parts,
      }
    }
    // 其它调用（`String(x)` / `process.cwd()`…）：只交出实参里的字面量片段。
    return { exact: undefined, parts }
  }
  // `NAME.join('/')`（字面量数组）与 `NAME[i]`（字面量数组下标）。
  const joinCall = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*\.\s*join\s*\((.*)\)$/u.exec(expr)
  if (joinCall !== null) {
    const rawItems = resolveJsArrayItems(joinCall[1], bindings, depth)
    if (rawItems !== undefined) {
      const items = rawItems.map(item => resolveJsExpression(item, bindings, depth + 1))
      const separator = resolveJsExpression(joinCall[2], bindings, depth + 1)
      const parts = items.flatMap(item => item.parts)
      if (items.every(item => item.exact !== undefined) && separator.exact !== undefined) {
        return { exact: items.map(item => item.exact).join(separator.exact), parts }
      }
      return { exact: undefined, parts }
    }
  }
  const indexAccess = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*\[\s*(\d+)\s*\]$/u.exec(expr)
  if (indexAccess !== null) {
    const items = resolveJsArrayItems(indexAccess[1], bindings, depth)
    const item = items === undefined ? undefined : items[Number(indexAccess[2])]
    return item === undefined ? empty : resolveJsExpression(item, bindings, depth + 1)
  }
  // 对象字面量的成员访问（"常量表"形态：`const TARGETS = { e2e: 'integration-tests/run-all.sh' }`）。
  const memberAccess = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*\.\s*([A-Za-z_$][A-Za-z0-9_$]*)$/u.exec(expr)
  if (memberAccess !== null) {
    // **命名空间 import 的成员**（R20A-03 ①）：`import * as PATHS from './paths.mjs'` /
    // `const mod = require('./paths.cjs')` 之后，`PATHS.ENTRY` 等价于"从那个模块命名导入
    // ENTRY"。这类绑定在 {@link jsImportBindings} 里按**复合键** `PATHS.ENTRY` 登记
    // （惰性求值，只有真被用到才读被 import 的仓内模块）。
    const namespaceMember = bindings.get(`${memberAccess[1]}.${memberAccess[2]}`)
    if (namespaceMember !== undefined && !namespaceMember.ambiguous) {
      return resolveJsExpression(namespaceMember.expression, bindings, depth + 1)
    }
    const objectValue = resolveJsBindingValue(memberAccess[1], bindings, depth)
    if (objectValue !== undefined && objectValue.trim().startsWith('{')) {
      for (const entry of splitJsTopLevel(objectValue.trim().slice(1, -1), ',')) {
        const separator = entry.indexOf(':')
        if (separator < 0) continue
        const key = jsStringLiteralValue(entry.slice(0, separator).trim()) ?? entry.slice(0, separator).trim()
        if (key !== memberAccess[2]) continue
        return resolveJsExpression(entry.slice(separator + 1), bindings, depth + 1)
      }
    }
    return empty
  }
  // **对象字面量**（常量表形态）：`{ entry: 'integration-tests/run-all.sh' }` 本身不是路径，
  // 但它的取值要在**跨文件 import 的常量表**里能被成员访问读到（R19A-02 ②：`PATHS.entry`），
  // 所以这里把各成员的取值片段一并交出（精确值仍然只有成员访问那一条路能给）。
  if (expr.startsWith('{') && balancedJsClose(expr, 0) === expr.length - 1) {
    const parts = []
    for (const entry of splitJsTopLevel(expr.slice(1, -1), ',')) {
      const separator = entry.indexOf(':')
      if (separator < 0) continue
      const resolved = resolveJsExpression(entry.slice(separator + 1), bindings, depth + 1)
      if (resolved.exact !== undefined) parts.push(resolved.exact)
      parts.push(...resolved.parts)
    }
    return { exact: undefined, parts }
  }
  // 标识符 ⇒ 展开同文件常量（或惰性 import 的仓内导出常量）。
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(expr)) {
    const value = resolveJsBindingValue(expr, bindings, depth)
    if (value === undefined) return empty
    return resolveJsExpression(value, bindings, depth + 1)
  }
  return empty
}
/**
 * 一个**数组字面量**文本 → 元素表达式列表（不是数组字面量时 `undefined`）。
 * @param value - 表达式文本。
 * @returns 元素表达式数组；不是数组字面量时 `undefined`。
 */
function jsArrayLiteralItems(value) {
  if (value === undefined) return undefined
  const text = value.trim().replace(/^\((.*)\)$/su, '$1').trim()
  if (!text.startsWith('[') || balancedJsClose(text, 0) !== text.length - 1) return undefined
  return splitJsTopLevel(text.slice(1, -1), ',')
}
/**
 * 一个**数组值表达式** → 元素表达式列表（R19A-02 ①）。
 *
 * 覆盖"先算出来、再切片/拼接"的常见写法，而不是只认最朴素的数组字面量：
 *   · 数组字面量 `['bash', '…']`；
 *   · 标识符（沿绑定表展开，`const CMD = […]`）；
 *   · `X.slice(a[, b])`（JS 语义：负下标从尾部数）；
 *   · `X.concat(字面量数组 / 另一个数组值 / 单个元素)`。
 * 认不出（运行期取值）⇒ `undefined`：不猜。
 * @param expression - 数组值表达式文本。
 * @param bindings - 绑定表。
 * @param depth - 递归深度。
 * @returns 元素表达式数组；认不出时 `undefined`。
 */
function resolveJsArrayItems(expression, bindings, depth = 0) {
  if (expression === undefined || depth > 6) return undefined
  const expr = String(expression).trim()
  const literal = jsArrayLiteralItems(expr)
  if (literal !== undefined) return literal
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(expr)) {
    return resolveJsArrayItems(resolveJsBindingValue(expr, bindings, depth), bindings, depth + 1)
  }
  const method = /^(.*?)\s*\.\s*(slice|concat)\s*\((.*)\)$/su.exec(expr)
  if (method === null) return undefined
  const items = resolveJsArrayItems(method[1], bindings, depth + 1)
  if (items === undefined) return undefined
  if (method[2] === 'slice') {
    const args = splitJsTopLevel(method[3], ',')
    if (args.length === 0 || args.length > 2) return undefined
    const bounds = args.map(argument => (/^-?\d+$/u.test(argument.trim()) ? Number(argument.trim()) : undefined))
    if (bounds.some(bound => bound === undefined)) return undefined
    const size = items.length
    const normalize = index => (index < 0 ? Math.max(size + index, 0) : Math.min(index, size))
    const start = normalize(bounds[0])
    const end = bounds[1] === undefined ? size : Math.max(normalize(bounds[1]), start)
    return items.slice(start, end)
  }
  const out = [...items]
  for (const argument of splitJsTopLevel(method[3], ',')) {
    const nested = resolveJsArrayItems(argument, bindings, depth + 1)
    if (nested !== undefined) { out.push(...nested); continue }
    out.push(argument)
  }
  return out
}
/**
 * 数组元素表达式列表 → 候选字面量片段（逐元素解析，元素解析不出就跳过它）。
 * @param items - 元素表达式列表。
 * @param bindings - 绑定表。
 * @param depth - 递归深度。
 * @returns 字面量片段列表。
 */
function jsArrayItemParts(items, bindings, depth) {
  const parts = []
  for (const item of items) {
    const resolved = resolveJsExpression(item, bindings, depth + 1)
    if (resolved.exact !== undefined) parts.push(resolved.exact)
    parts.push(...resolved.parts)
  }
  return parts
}
/**
 * 展开一个标识符的绑定取值（歧义/未绑定 ⇒ `undefined`）。
 * @param name - 标识符。
 * @param bindings - 绑定表。
 * @param depth - 递归深度。
 * @returns 绑定的表达式文本；不可用返回 `undefined`。
 */
function resolveJsBindingValue(name, bindings, depth) {
  if (depth > 6) return undefined
  const entry = bindings.get(name)
  if (entry === undefined || entry.ambiguous) return undefined
  return entry.expression
}
/**
 * `balancedJsClose` 的括号配对（字符串/模板感知）。
 * @param text - 文本。
 * @param openIndex - 开括号下标。
 * @returns 闭括号下标；不配对返回 `-1`。
 */
function balancedJsClose(text, openIndex) {
  const pairs = { '(': ')', '[': ']', '{': '}' }
  const closer = pairs[text[openIndex]]
  if (closer === undefined) return -1
  let depth = 0
  for (let index = openIndex; index < text.length; index += 1) {
    const character = text[index]
    if (character === "'" || character === '"' || character === '`') {
      index += 1
      while (index < text.length && text[index] !== character) {
        if (text[index] === '\\') index += 1
        index += 1
      }
      continue
    }
    if (character === '(' || character === '[' || character === '{') depth += 1
    else if (character === ')' || character === ']' || character === '}') {
      depth -= 1
      if (depth === 0) return character === closer ? index : -1
    }
  }
  return -1
}
/**
 * JS/TS 正文 → `spawn|exec|fork` **实参表达式**里的候选字面量（R18A-03 加入常量传播）。
 *
 * 两半合起来才闭合：
 *   · **窗口内的引号字面量**（第十四轮起的既有口径）—— 字面量直接写在调用实参里；
 *   · **实参表达式的解析结果**（R18A-03）—— 标识符/`join`/模板/数组成员/对象常量表，
 *     解析不出的实参不产出候选，但**脚本位**那一半由
 *     {@link jsShellScriptPositionProblems} 兜（见其头注释）。
 * @param source - JS/TS 源码文本。
 * @param importContext - 可选：`{ resolveImport, report }` —— **跨文件 import 常量**（R19A-02 ②）；
 *   缺席时只做同文件常量（既有行为，逐字不变）。
 * @returns 候选字面量列表。
 */
function jsExecArgumentLiterals(source, importContext = undefined) {
  const text = String(source)
  const literals = []
  const bindings = importContext === undefined
    ? jsConstantBindings(text)
    : jsImportBindings(
      text,
      (specifier, imported) => importContext.resolveImport(specifier, imported),
      detail => importContext.report(detail),
    )
  for (const match of text.matchAll(CI_SURFACE_EXEC_CALL)) {
    const window = text.slice(match.index, match.index + CI_SURFACE_ARG_WINDOW)
    for (const literal of window.matchAll(/['"`]([^'"`\n]+)['"`]/gu)) literals.push(literal[1])
    const open = window.indexOf('(')
    if (open < 0) continue
    const close = balancedJsClose(window, open)
    if (close < 0) continue
    for (const argument of splitJsTopLevel(window.slice(open + 1, close), ',')) {
      const resolved = resolveJsExpression(argument, bindings)
      if (resolved.exact !== undefined) literals.push(resolved.exact)
      literals.push(...resolved.parts.filter(part => part.length >= 3))
    }
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
 * Python 正文 → `subprocess.*` / `os.*` **实参窗口**里的字符串字面量。
 *
 * 与 {@link jsExecArgumentLiterals} 同口径（只看执行调用、不扫全文），只是调用名换一族：
 * `.py` 进了闭包的跟随面（VA-05-F2），就必须有能读懂 `.py` 里"跑什么"的抽取器 ——
 * 否则"跟随 `.py`"只是把文件读进来却看不见它的执行形态。
 * @param source - Python 源码文本。
 * @returns 字面量列表。
 */
function pythonExecArgumentLiterals(source) {
  const text = String(source)
  const literals = []
  for (const match of text.matchAll(CI_SURFACE_PY_EXEC_CALL)) {
    const window = text.slice(match.index, match.index + CI_SURFACE_ARG_WINDOW)
    for (const literal of window.matchAll(/['"`]([^'"`\n]+)['"`]/gu)) literals.push(literal[1])
  }
  return literals
}

/**
 * 一份"可跟随脚本"的正文 → **执行形态里的字符串**（按语言选抽取器）。
 *
 * 为什么要分语言：`spawn('bash', …)` 是 JS 的写法，`subprocess.run([…])` 是 Python 的，
 * 拿 JS 的调用名去读 `.py` 会一条都抽不到（VA-05-F2 的现场就是"扩展名不在跟随面"，
 * 补上扩展名却用错抽取器会变成同一个洞换一个形态）。
 * @param file - 脚本的仓库相对路径。
 * @param text - 正文。
 * @param scriptKeys - manifest 脚本键集合（JS/TS 家族才会用到）。
 * @param importContext - 可选：跨文件 `import` 常量的解析上下文（R19A-02 ②）。
 * @returns 字面量 / token 列表。
 */
function scriptExecutionLiterals(file, text, scriptKeys, importContext = undefined) {
  if (/\.(?:sh|bash)$/u.test(file)) return shellCommandTokens(text)
  if (/\.py$/u.test(file)) return pythonExecArgumentLiterals(text)
  return [...jsExecArgumentLiterals(text, importContext), ...jsManifestKeyLiterals(text, scriptKeys)]
}

/**
 * **进程替换** `<(...)` / `>(...)` 的标记词（R17-X）。
 *
 * 它不是重定向，而是一段**会执行的子命令**：`bash <(echo '<命令文本>')` 里 bash 真正执行的
 * 是那个子进程的**输出**。闭包判不了子进程会输出什么 ⇒ 见到它一律 fail-closed，而不是
 * 把它当成"一个普通实参"（R17A-02 的现场：修前这种写法守卫 EXIT=0 而 CI 真的执行到入口）。
 */
const SHELL_PROCSUB_MARKER = '\u0000PROCSUB\u0000'
/**
 * **进程替换的脚本宿主**（R19A-01）：这些命令后面那一位是"要被执行的**文件内容**"，
 * 所以 `bash <(…)` / `python3 <(…)` / `source <(…)` 里被执行的是**子进程的输出**。
 *
 * 不在表里的命令（`cat` / `diff` / `sort` / shell 保留字 `done`…）拿到的是**数据**：
 * `done < <(printf …)` 的输出是循环的输入流，不是脚本文本 —— 这一族的"内层命令本身会执行"
 * 由闭包节点继续扫（见 {@link unwrapCommandWordsUncached} 的进程替换分支）。
 */
const SHELL_PROCSUB_SCRIPT_HOSTS = new Set([
  ...COMMAND_SHELL_WORDS, 'source', '.', ...COMMAND_PYTHON_WORDS,
  'node', 'nodejs', 'ruby', 'perl', 'deno', 'bun', 'php',
])
/**
 * 进程替换的哨兵词在**脚本位**吗（R19A-01）。
 *
 * 判据三条（都不猜语义，只看位置）：
 *   ① 命令位本身就是它（`<(echo make) -C x y`）⇒ 子进程输出被当命令名 ⇒ 脚本位；
 *   ② 紧邻其前的词是脚本宿主（`bash <(…)` / `timeout 60 bash <(…)`）⇒ 脚本位；
 *   ③ 命令位是脚本宿主且它是宿主**第一个非旗标实参**（`bash -e <(…)`）⇒ 脚本位；
 *      反过来 `bash -c '<文本>' <(…)` 里的那一位是 `$0`，不是脚本位。
 * @param words - 这条命令的词数组。
 * @param index - 进程替换哨兵词的下标。
 * @returns `true` = 被执行的是子进程的输出（fail-closed）。
 */
function shellProcsubIsScriptPosition(words, index) {
  if (index <= 0) return true
  const previous = words[index - 1]
  if (previous !== undefined && SHELL_PROCSUB_SCRIPT_HOSTS.has(previous)) return true
  const command = words[0]
  if (command === undefined || SHELL_RESERVED_WORDS.has(command)) return false
  if (!SHELL_PROCSUB_SCRIPT_HOSTS.has(command)) return false
  // **R20A-01**：旗标段的消费与解释器分支共用同一份实现（含 `--` 与"带取值的旗标"）。
  // `bash -c '<文本>' <(…)` 里的那一位是 `$0`（不是脚本位）—— `-c` 的取值就是命令文本，
  // 所以 `commandText !== null` 时直接判"不是脚本位"。
  const { scriptIndex, commandText } = shellScriptWordIndex(words, 0)
  if (commandText !== null) return false
  return scriptIndex === index
}
/**
 * **here-string** `<<<` 的标记词（R17-X）：它的取值是**另一段文本**
 * （`bash <<< '<脚本文本>'`）—— 对 shell 解释器来说那就是"要执行的脚本"，必须按内层
 * shell 文本递归（R17A-02）。标记成独立词是为了让命令词法看得见它（`<` 原本只是词分隔符）。
 */
const SHELL_HERESTRING_MARKER = '\u0000HERESTRING\u0000'
/**
 * shell 的**内层文本实参**（`eval '<命令文本>'` / `trap '<命令文本>' <信号>`）—— 与
 * `bash -c '<命令文本>'` 同族，但闭包在修前**完全不认识**它们（R17A-02 的现场：
 * `eval`/`trap` 在标准词表里、却不在包装表里 ⇒ 取值不进任何一张网）。
 * 取值按内层 shell 文本递归的三种严格度：
 *   · `strict`  —— `eval`：它与 workflow 的 `run:` 块**同义**，按入口形态判（登记制也开）；
 *   · `lenient` —— `trap`：钩子体通常是清理函数（`trap cleanup EXIT`），逐词登记等于要求
 *     为"函数名"背书；它的端到端接线由载体跟随 + make/compose 扩张 + token/文本网覆盖；
 *   · `undefined` —— `bash -c`：维持既有口径（只按 make 递归）。
 */
const NESTED_SHELL_STRICT = 'strict'
const NESTED_SHELL_LENIENT = 'lenient'
/**
 * 词数组 → 诊断文本（把内部哨兵词还原成人能读的形态）。
 * @param words - 词数组。
 * @returns 空格拼接的诊断文本。
 */
function renderShellWords(words) {
  return words.map(word => word
    .split(SHELL_PROCSUB_MARKER).join('')
    .split(SHELL_HERESTRING_MARKER).join('<<<')).join(' ')
}
/** 赋值内建（它们的实参是 `NAME=值`，同样是**同一段文本内**的常量来源）。 */
const BINDING_BUILTIN_WORDS = new Set(['export', 'declare', 'local', 'readonly', 'typeset'])
/** `NAME=值` 形态（常量传播的唯一识别形态）。 */
const SHELL_ASSIGNMENT_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/su
/** 词里出现 `$` / 反引号 = 含**间接层**（变量展开 / 命令替换）。 */
const SHELL_INDIRECTION_PATTERN = /[$`]/u
/** 词里出现通配元字符 = 路径模式（`case` 分支 / glob），不是可执行名。 */
const SHELL_GLOB_PATTERN = /[*?[\]]/u
/**
 * **"这段文本写过哪些文件"**的识别形态（R22 FIX-14 / E-01 形态 A；**R23 FIX-22 收口形态 A-2**）。
 *
 * · {@link WRITE_REDIRECT_TARGET}：重定向的**目标词**（`> x` / `>> x` / `2> x` / `&> x` / `>| x`）。
 *   `2>&1`（后面是 `&`）与 `<<`（here-doc，另由 `inlineHeredocs` 处理）都不命中。
 * · {@link WRITE_COMMAND_WORDS}：把目标放在**最后一个非旗标实参**上的写命令。
 * 两者都只产出"候选词"，是不是仓内路径由 `resolveCarrierPath()` 回答 ——
 * 所以 `/dev/null`、`$GITHUB_ENV`、仓外路径天然不进集合。
 *
 * **R23 FIX-22 / W4-02**：`WRITE_COMMAND_WORDS` 那一支的取词必须在**剥掉重定向**的文本上做。
 * 修前它在原文本上取"最后一个非旗标词"，于是
 * `tee -a scripts/ci-brand-mask.sh >/dev/null` 取到的是 `/dev/null`、
 * `cp /tmp/p.sh scripts/ci-brand-mask.sh > /dev/null` 同样取到 `/dev/null`
 * ⇒ 目标整族不可见（`tee`/`cp` 就在这张词表里），而**去掉那个尾随重定向的同一条命令**判红
 * （第二十三轮 W4 实测：`b5-tee-append` / `b2-cp-redirect` `EXIT=0`，`b1-tee-plain` / `a7-cp` `EXIT=1`）。
 *
 * **R23 FIX-22 / W4-09**：重定向目标也要吃**同一套常量传播**。修前重定向一侧走
 * {@link WRITE_REDIRECT_TARGET} 正则，`note()` 一遇 `$` 就 `return`，于是
 * `T=scripts/ci-brand-mask.sh; printf … > "$T"; bash "$T"` 里"能执行的路径"认得出来
 * （脚本位有常量传播）、"被写过的路径"认不出来 ⇒ `EXIT=0`。现在重定向目标改由
 * {@link tagWriteRedirections} 打标后走 `shellCommandWordListsFor()`（与命令位同一份
 * 常量传播），标记词后紧跟的那一位就是目标。正则那一路保留，只作**文本面**兜底
 * （tokenizer 覆盖不到的正文，例如命令替换内部）。
 */
const WRITE_REDIRECT_TARGET = /(?:^|[\s;&|(])(?:\d*>>?|\d*<>|&>|>\|)[ \t]*("[^"]*"|'[^']*'|[^\s;&|()<>]+)/gu
/** 写命令词（目标是最后一个非旗标实参）；要扩面就加这里，并在 FIX-14/FIX-22 报告里写明边界。 */
const WRITE_COMMAND_WORDS = new Set(['tee', 'cp', 'mv', 'install', 'rsync', 'ln'])
/**
 * **解释器内联脚本里的写操作**（R24 FIX-26 / X3-01① 的唯一实现）。
 *
 * ## 现场（第二十四轮 X3 泳道）
 *
 * `runtimeWrittenCarriers` 的两条取词路径都是 **shell 语法**（`>`/`>>` 重定向 +
 * `tee`/`cp`/`mv`… 命令词），于是"写"换一种**同等常规**的写法就整族隐形：
 *
 * ```yaml
 * - run: python3 -c "import base64,pathlib;
 *          pathlib.Path('scripts/ci-brand-mask.sh').write_bytes(base64.b64decode('…'))"
 * - run: bash scripts/ci-brand-mask.sh        # 执行的是被写进去的内容
 * ```
 *
 * `check-integration-tests` 照印 `VERDICT PASS … 真实接线 0 处`、`check-workflows EXIT=0`，
 * 而 tripwire 证明运行期真的执行了端到端入口。三种解释器形态（`python3 -c` / `node -e` /
 * 变量间接）实测全绿。
 *
 * ## 判据（**可判定子集**：写目标是字面量）
 *
 * 只认"**第一实参是字面量字符串**"的写调用 —— 路径由变量拼出来的、经 `join()` 计算的、
 * 或载荷本身不透明的，这里认不出来（那属于"运行期生成 + 不透明编码"的固有边界，
 * 由脚本位那一格与 `CI_SURFACE_GENERATED_SCRIPT_ACK` 登记制兜）。认出**之后**仍然要过
 * `resolveCarrierPath()`：`/tmp/x`、仓外路径、`$GITHUB_ENV` 天然不进集合。
 *
 * 覆盖面（每条对应一种实测/等价写法）：
 *   · Python：`Path('X').write_text/write_bytes/open/touch`、`open('X','w…')`、
 *     `shutil.copy*` / `shutil.move(_, 'X')`、`os.replace/rename(_, 'X')`；
 *   · JS 家族：`writeFileSync/writeFile/appendFileSync/appendFile/createWriteStream/
 *     truncateSync('X', …)`；
 *   · Perl：`open(FH, '>', 'X')` / `open(FH, ">X")`。
 *
 * 不按语言分派（内联文本的语言标签只区分 shell/py/js，`perl -e` 落在 js 上）——
 * 这些调用名足够特异，混用不会互相误伤。
 * @type {Array<{ re: RegExp, group: number }>}
 */
const INLINE_SCRIPT_WRITE_PATTERNS = [
  // JS 家族：第一实参是字面量的写调用。
  {
    re: /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|truncateSync)\s*\(\s*(['"`])([^'"`\n]+)\1/gu,
    group: 2,
  },
  // Python pathlib：路径在被调方法的**宿主**上。
  {
    re: /\bPath\s*\(\s*(['"`])([^'"`\n]+)\1\s*\)\s*\.\s*(?:write_text|write_bytes|open|touch|unlink)\s*\(/gu,
    group: 2,
  },
  // Python 内建 open：mode 必须以写标志开头（`o`pen 第三参 / 关键字参数不在此列，
  // 宁漏不误 —— 只读 `open('X')` 绝不能算写）。
  {
    re: /\bopen\s*\(\s*(['"`])([^'"`\n]+)\1\s*,\s*(['"`])([wax+][^'"`\n]*)\3/gu,
    group: 2,
  },
  // Python shutil / os：目标在**第二**实参。
  {
    re: /\b(?:shutil\s*\.\s*(?:copy|copy2|copyfile|move)|os\s*\.\s*(?:replace|rename))\s*\(\s*[^,()\n]+,\s*(['"`])([^'"`\n]+)\1/gu,
    group: 2,
  },
  // Perl：`open(FH, '>', 'X')`（目标在第三实参）。
  {
    re: /\bopen\s*\(\s*[^,)\n]+,\s*(['"])(?:>>?|\+>?)\1\s*,\s*(['"])([^'"]+)\2/gu,
    group: 3,
  },
  // Perl：`open(FH, '>X')`（模式与路径同一个串）。
  {
    re: /\bopen\s*\(\s*[^,)\n]+,\s*(['"])(?:>>?|\+>?)([^'"]+)\1/gu,
    group: 2,
  },
]
/**
 * 一段**内联语言源码** → 它写过的字面量路径（去重，保持出现顺序）。
 *
 * @param source - `python3 -c '<源码>'` / `node -e '<源码>'` 的源码文本。
 * @returns 字面量写目标（**未**做仓内归属判定 —— 那由 `resolveCarrierPath()` 负责）。
 */
function inlineScriptWriteTargets(source) {
  const text = String(source ?? '')
  if (text === '') return []
  const found = new Set()
  for (const { re, group } of INLINE_SCRIPT_WRITE_PATTERNS) {
    // 正则带 `g` 且是**共享常量**：`matchAll` 内部会克隆，不会污染 `lastIndex`。
    for (const match of text.matchAll(re)) {
      const target = match[group]
      if (typeof target === 'string' && target !== '') found.add(target)
    }
  }
  return [...found]
}
/**
 * **`$GITHUB_ENV` / `$GITHUB_OUTPUT` 导出的名字 → 值**（R24 FIX-26 / X3-01② 的唯一实现）。
 *
 * ## 现场
 *
 * `note()` 一遇 `$` 就 `return`（常量传播只覆盖**同一段文本内**），于是把写目标经
 * `$GITHUB_ENV` 递给下一步就整条不可见：
 *
 * ```yaml
 * - run: echo "V7T=scripts/ci-brand-mask.sh" >> "$GITHUB_ENV"
 * - run: printf '%s' "$PAYLOAD" | base64 -d > "$V7T"   # 写目标不可见
 * - run: bash scripts/ci-brand-mask.sh                 # ⇒ 判据看不见"被写过"
 * ```
 *
 * ## 判据
 *
 * 逐行找"**真的在写 `$GITHUB_ENV`/`$GITHUB_OUTPUT`**"的行（出现关键字 ∧ 有 `>`/`>>`/`tee`），
 * 把行内的 `NAME=VALUE` 字面量收进 job 作用域 —— **语义与 GitHub 一致：只影响后续 step**
 * （调用方在扫完当前块之后才调用它，所以同一步里"先 export 再用"不会被当成已生效）。
 * @param source - 一段 `run:` 块（已去 here-doc 正文）。
 * @param into - 目标 `Map<名字, 值>`（就地更新）。
 */
function collectExportedEnvAssignments(source, into) {
  if (!(into instanceof Map)) return
  for (const line of String(source).split('\n')) {
    if (!/GITHUB_(?:ENV|OUTPUT)/u.test(line)) continue
    if (!/(?:>>?|\|\s*tee\b)/u.test(line)) continue
    for (const match of line.matchAll(/(?:^|[\s"'])([A-Za-z_][A-Za-z0-9_]*)=([^\s"']+)/gu)) {
      into.set(match[1], match[2])
    }
  }
}
/**
 * 把 `$GITHUB_ENV` 传过来的名字代进一个词（{@link collectExportedEnvAssignments} 的取用侧）。
 *
 * 只在词**含 `$`** 时介入：不含则原样返回（保持既有语义）；含而查不到值 / 展开后仍残留 `$`
 * 一律返回 `undefined`（= "读不懂"，调用方按原来的 fail-closed 处理，**不是**放行）。
 * @param word - 一个词（可能带引号，调用方已去引号）。
 * @param env - job 作用域的导出名字表。
 * @returns 展开后的词；读不懂返回 `undefined`。
 */
function expandExportedEnvWord(word, env) {
  const text = String(word)
  if (!text.includes('$')) return text
  if (!(env instanceof Map) || env.size === 0) return undefined
  let unresolved = false
  const expanded = text.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/gu,
    (match, braced, bare) => {
      const value = env.get(braced ?? bare)
      if (value === undefined) { unresolved = true; return match }
      return value
    })
  if (unresolved || expanded.includes('$')) return undefined
  return expanded
}
/** 载体写面**闭包跟随**的深度上限（`bash scripts/a.sh` 里再 `bash scripts/b.sh` …）。 */
const WRITE_CARRIER_FOLLOW_MAX_HOPS = 4
/**
 * 一段 yaml/shell 文本 → 它**本地复合 action** 的目录（`uses: ./x` → `x`，去重）。
 *
 * 与闭包节点那一支（`scanClosure` 的 `uses:` 分支）同口径：只认 `./` 开头的本地 action
 * （远端 `uses: actions/checkout@v4` 的正文不在本仓，跟随不了也不该管）。
 * @param text - yaml / shell 文本。
 * @returns 去重后的目录名（保持出现顺序）。
 */
function localCompositeActionDirs(text) {
  const found = new Set()
  for (const uses of String(text).matchAll(/^[^\S\n]*(?:-[^\S\n]+)?uses:[^\S\n]*(\S+)[^\S\n]*$/gmu)) {
    if (!uses[1].startsWith('./')) continue
    found.add(uses[1].replace(/^\.\//u, ''))
  }
  return [...found]
}
/**
 * 写重定向的**标记词**（{@link tagWriteRedirections} 用）。
 *
 * 词法器会把重定向操作符 `>` 当**命令分隔符**丢掉、只留下目标词
 * （实测 `printf x > scripts/x.sh` → `["printf","x","scripts/x.sh"]`），于是"哪个词是重定向
 * 目标"在词数组里不可见 —— `cp src dst` 与 `cp src dst >/dev/null` 给出同一个词数组。
 * 修法是**在取词之前把标记词插在操作符前面**：`tee -a X >/dev/null`
 * → `tee -a X __SENT__ >/dev/null` → 词数组 `["tee","-a","X","__SENT__","/dev/null"]`
 * ⇒ 标记词的下一位就是目标，而且它已经过同一套常量传播（`> "$T"` → `scripts/x.sh`）。
 * 标记词用下划线开头、不含 `=`，不会被词法器当成赋值或旗标。
 */
const WRITE_REDIRECT_SENTINEL = '__picoaide_write_redirect_target__'
/** fd 复制（`2>&1` / `>&2`）：**没有文件目标**，取词前整段删掉（否则 `2` 会被当成目标词）。 */
const WRITE_FD_DUPLICATION = /(?:^|[\s;&|(])\d*>&\d*/gu
/**
 * 写重定向操作符 + 它后面的目标词（`> x` / `>> x` / `>| x` / `&> x` / `N> x` / `N<> x`，
 * 目标可缺省）。
 *
 * **R24 FIX-26 / X3-01⑦**：`N<>`（以读写方式打开，`exec 3<>file` 的形态）此前不在操作符
 * 集合里 ⇒ `exec 3<>scripts/x; printf … >&3; exec 3>&-; bash scripts/x` 整条不可见
 * （第二十四轮 X3 泳道实测 `EXIT=0`）。`<<`（here-doc）与 `<<<`（here-string）不会命中
 * 这条：`\d*<>` 要求 `<` 紧跟 `>`。
 */
const WRITE_REDIRECTION = /(^|[\s;&|(])(\d*&>>|\d*&>|\d*>>\||\d*<>|\d*>>|\d*>\||\d*>)[ \t]*("[^"]*"|'[^']*'|[^\s;&|()<>]+)?/gu
/**
 * 一段 shell 文本 → **剥掉写重定向（连同目标词）**的文本（R23 FIX-22 / W4-02 的唯一实现）。
 * @param source - 一段 shell 文本。
 * @returns 去掉 `> x` / `>> x` / `>| x` / `&> x` / `2>&1` 之后的文本（其余逐字保留）。
 */
function stripWriteRedirections(source) {
  return String(source)
    .replace(WRITE_FD_DUPLICATION, ' ')
    .replace(WRITE_REDIRECTION, '$1 ')
}
/**
 * 一段 shell 文本 → **写重定向的操作符前面插入标记词**的文本（R23 FIX-22 / W4-09 的唯一实现）。
 * @param source - 一段 shell 文本。
 * @returns 每个写重定向前面都带 {@link WRITE_REDIRECT_SENTINEL} 的文本。
 */
function tagWriteRedirections(source) {
  return String(source)
    .replace(WRITE_FD_DUPLICATION, ' ')
    // 目标词**必须留下**（`$3` 缺省时不能写成字面 `undefined`）—— 标记词只是插在操作符前面，
    // 词法器随后丢掉操作符，于是"标记词的下一位"正好是目标词。
    .replace(WRITE_REDIRECTION, (match, lead, operator, target) =>
      `${lead} ${WRITE_REDIRECT_SENTINEL} ${operator}${target === undefined ? '' : ` ${target}`}`)
}
/**
 * here-doc 操作符 + 终止词（`<<EOF` / `<<-'EOF'` / `<< "EOF"`）。
 * 两侧的 `(?<!<)`/`(?!<)` 是必须的：`<<<` 是 **here-string**（`bash <<< '<脚本文本>'`），
 * 它有自己的一条判据（{@link SHELL_HERESTRING_MARKER}）—— 少了这两个断言，`<<< 'make x'`
 * 会被读成 here-doc 起始（从第二个 `<` 起匹配）并把脚本正文搅进命令行。
 */
const HEREDOC_OPERATOR = /(?<!<)<<(?!<)(-?)[ \t]*(?:['"]?)([A-Za-z_][A-Za-z0-9_]*)(?:['"]?)/gu
/**
 * "正文就是**要执行的程序**"的解释器词（`bash -s <<EOF` / `python3 - <<PY`）——
 * 其余命令的 here-doc 正文是数据（见 {@link inlineHeredocs}）。
 * `COMMAND_PYTHON_WORDS` 在文件后面才声明，但本表只在运行期求值，不存在 TDZ。
 */
const HEREDOC_PROGRAM_WORDS = new Set([...COMMAND_SHELL_WORDS, ...COMMAND_PYTHON_WORDS])
/** 一段文本 → 单引号 shell 字面量（内部单引号按 `'\''` 断开，与 shell 语义一致）。 */
function shellSingleQuote(text) {
  return `'${String(text).split("'").join("'\\''")}'`
}

/**
 * 文本 → **命令**（每条 = 词数组）。**逐字符**切分（不是按行近似）：
 * 分隔符 = 换行 / `;` / `&&` / `||` / `|` / `&` / `(` / `)`，`>` `<` 是词分隔符，
 * `#` 在词首时吃掉该行剩余（shell 注释），引号内的分隔符不生效。
 *
 * 与 {@link shellCommandTokens} 的区别只有两点，都是为 `make` 判据服务的：
 *   · **保留旗标与 `$(VAR)` 形态的词**（`-C` / `-f` / `$(TARGET)` 都要能看见 —— 后者
 *     要能被判成"这一位读不懂"并 fail-closed，而不是被剥成一个看不出问题的碎片）；
 *   · `$(MAKE)` 先归一成 {@link MAKE_RECURSIVE_WORD}，递归 make 与普通 make 同形处理。
 *
 * R17-X 之后它返回的是**解析过同一段文本内间接层**的词（见 {@link shellCommandAnalysis}）：
 * `D=integration; N=run; bash "$D-tests/$N-all.sh"` 的第三条命令在这里已经是
 * `bash integration-tests/run-all.sh` —— 否则闭包的 token 网 / 载体跟随 / 文本网三张网
 * **同时**依赖"正文里出现可识别的路径形态"，把路径拆成两个变量片段就能整族绕过（R17A-03）。
 * @param text - shell / Makefile 正文。
 * @returns 词数组的数组（按出现顺序，已做常量传播）。
 */
const SHELL_WORDS_CACHE = new Map()
const SHELL_WORDS_CACHE_MAX = 4000
function shellCommandWordLists(text) {
  return shellCommandAnalysis(text).commands
}
/**
 * 文本 → `{ commands, substitutions }`（{@link shellCommandWordLists} 的真源）。
 *
 * `substitutions` 只收**真的发生了替换**的词对（`"$D-tests/$N-all.sh"` → `integration-tests/run-all.sh`）——
 * {@link shellCommandTokens} 用它把"字面量只出现在赋值里"的路径补进 token 网。逐字未变的词
 * 不进这张表：原文扫描已经收过它们，重复加入只会把注释词/散文带进判据面。
 * @param text - shell / Makefile 正文（已 `String()` 归一）。
 * @returns `{ commands, substitutions }`。
 */
const SHELL_ANALYSIS_CACHE = new Map()
function shellCommandAnalysis(text) {
  const key = String(text)
  const cached = SHELL_ANALYSIS_CACHE.get(key)
  if (cached !== undefined) return cached
  const analysis = resolveShellIndirections(rawShellCommandWordLists(key))
  if (SHELL_ANALYSIS_CACHE.size < SHELL_WORDS_CACHE_MAX) SHELL_ANALYSIS_CACHE.set(key, analysis)
  return analysis
}
/**
 * 逐字符切词的**真实现**（只做词法，不做替换）。
 * 记忆化只为性能：同一条命令会被 make / compose / 载体三个扫描器各走一遍。
 * 返回值只被迭代、不被改写（调用方一律用 `for…of` / `slice`）。
 * @param text - shell / Makefile 正文（已 `String()` 归一）。
 * @returns 词数组的数组。
 */
const SHELL_RAW_WORDS_CACHE = new Map()
function rawShellCommandWordLists(text) {
  const key = String(text)
  const cached = SHELL_RAW_WORDS_CACHE.get(key)
  if (cached !== undefined) return cached
  const commands = rawShellCommandWordListsUncached(key)
  if (SHELL_RAW_WORDS_CACHE.size < SHELL_WORDS_CACHE_MAX) SHELL_RAW_WORDS_CACHE.set(key, commands)
  return commands
}
/**
 * 逐字符切词的**不带记忆化的真实现**（见 {@link rawShellCommandWordLists}）。
 * @param text - shell / Makefile 正文。
 * @returns 词数组的数组。
 */
function rawShellCommandWordListsUncached(text) {
  const commands = []
  const source = String(text).replace(/\$\(MAKE\)/gu, MAKE_RECURSIVE_WORD)
  let words = []
  let current = ''
  let quote = null
  const flushWord = () => { if (current !== '') { words.push(current); current = '' } }
  const flushCommand = () => { flushWord(); if (words.length > 0) commands.push(words); words = [] }
  /**
   * 括号配对扫描（字符串感知）：`$( … )` / `<( … )` / 反引号里的引号不参与配对。
   * @param from - 开括号的下标。
   * @param open - 开字符。
   * @param close - 闭字符。
   * @returns 闭字符的下标；不配对时返回 `source.length`。
   */
  const scanBalanced = (from, open, close) => {
    let depth = 0
    let cursor = from
    for (; cursor < source.length; cursor += 1) {
      const character = source[cursor]
      if (character === '\\') { cursor += 1; continue }
      if (character === open) depth += 1
      else if (character === close) { depth -= 1; if (depth === 0) break }
    }
    return cursor
  }
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (quote !== null) {
      if (character === quote) { quote = null; continue }
      current += character
      continue
    }
    if (character === '"' || character === "'") { quote = character; continue }
    if (character === '#' && current === '' && words.length === 0) {
      while (index < source.length && source[index] !== '\n') index += 1
      flushCommand()
      continue
    }
    // 行继续（`\` + 换行）：shell / make 都把它当"同一行"，**不是**命令分隔符。
    // 不认它时 `for ID in \\\n  <值1> \\\n  <值2>; do` 会被切成三条命令，第二、三条的
    // 命令位变成**列表取值**（真仓 notary-probe.yml 实测：一个 submission UUID 被读成命令名）。
    if (character === '\\' && source[index + 1] === '\n') { index += 1; flushWord(); continue }
    if (character === '\n' || character === ';') { flushCommand(); continue }
    if (character === '&' || character === '|') { flushCommand(); if (source[index + 1] === character) index += 1; continue }
    // 反引号是**命令替换**，不是命令分隔符（R17-X 的 R17A-01）：修前它 `flushCommand()`，
    // 于是 `` `echo make` -C <目录> <目标> `` 被切成 `echo make` 与 `-C <目录> <目标>` 两条
    // "命令"——后者的命令位是旗标 ⇒ 登记制永远看不到真正被执行的那个命令名。
    if (character === '`') {
      const end = source.indexOf('`', index + 1)
      if (end < 0) { current += source.slice(index); index = source.length; break }
      current += source.slice(index, end + 1)
      index = end
      continue
    }
    if (character === '$' && source[index + 1] === '(') {
      // `$(VAR)` 整块保留（含 `$(shell …)` 这类嵌套）：它的"读不懂"由调用方判，不是在这里撕碎。
      const cursor = scanBalanced(index + 1, '(', ')')
      current += source.slice(index, cursor + 1)
      index = cursor
      continue
    }
    // 进程替换 `<(...)` / `>(...)`：标成哨兵词（见 {@link SHELL_PROCSUB_MARKER}）。
    if ((character === '<' || character === '>') && source[index + 1] === '(') {
      const cursor = scanBalanced(index + 1, '(', ')')
      flushWord()
      words.push(`${SHELL_PROCSUB_MARKER}${source.slice(index, cursor + 1)}`)
      index = cursor
      continue
    }
    // here-string `<<<`：标成哨兵词（见 {@link SHELL_HERESTRING_MARKER}）。
    if (character === '<' && source[index + 1] === '<' && source[index + 2] === '<') {
      flushWord()
      words.push(SHELL_HERESTRING_MARKER)
      index += 2
      continue
    }
    if (character === '(' || character === ')') { flushCommand(); continue }
    if (character === ' ' || character === '\t' || character === '\r' || character === '>' || character === '<') {
      flushWord()
      continue
    }
    current += character
  }
  flushCommand()
  // `[[ … || … ]]` / `[[ … && … ]]` 的**合并**（R17-X）：词法器不认识 `[[` 语法，`||`/`&&`
  // 会被当命令分隔符 ⇒ `[[ -z "${BASE}" || "${BASE}" =~ ^0+$ ]]` 会切出一条以 `${BASE}` 打头的
  // 假命令，命令位登记制把它读成"变量命令位"（真仓 ci.yml:65 实测假红）。这里把 `[[` 未闭合的
  // 命令并入后一条，直到出现 `]]` 为止：测试表达式里的词一律回到**参数位**。
  const merged = []
  let pendingTest = false
  for (const command of commands) {
    if (pendingTest) {
      merged[merged.length - 1].push(...command)
      if (command.includes(']]')) pendingTest = false
      continue
    }
    merged.push(command)
    if (command.includes('[[') && !command.includes(']]')) pendingTest = true
  }
  return merged
}
/**
 * 命令列表 → **解析过同一段文本内间接层**的命令列表（常量传播）+ 替换留痕。
 *
 * 支持（刻意保守，其余一律留给调用方 fail-closed）：
 *   · `NAME=字面量` 前缀赋值 / 独立赋值行 / `export NAME=字面量`；
 *   · `$NAME` / `${NAME}` / `$NAME后缀`（`D=integration` + `$D-tests` ⇒ `integration-tests`）；
 *   · `$(echo <字面量…>)` / `` `echo <字面量…>` `` / `$(which <名>)` / `$(command -v <名>)`。
 * **不**支持（⇒ 词保持原样，命令位上按 fail-closed 判红）：`$(cat …)`、`$(…)` 里跑别的命令、
 * `$1`/`$@` 这类特殊参数、`${NAME:-默认}` 等参数展开变体。
 * @param commands - {@link rawShellCommandWordLists} 的输出。
 * @returns `{ commands, substitutions }`。
 */
function resolveShellIndirections(commands) {
  const bindings = new Map()
  const resolved = []
  const substitutions = []
  for (const words of commands) {
    const current = []
    for (const word of words) {
      const value = substituteShellWord(word, bindings)
      if (value === undefined || value === word) { current.push(word); continue }
      substitutions.push({ raw: word, resolved: value })
      current.push(value)
    }
    resolved.push(current)
    recordShellBindings(current, bindings)
  }
  return { commands: resolved, substitutions }
}
/**
 * 记下一条命令里的**常量赋值**（供后续命令的常量传播用）。
 * @param words - 一条命令的词数组（已做过替换）。
 * @param bindings - 变量表（就地更新）。
 */
function recordShellBindings(words, bindings) {
  let index = BINDING_BUILTIN_WORDS.has(words[0]) ? 1 : 0
  for (; index < words.length; index += 1) {
    const match = SHELL_ASSIGNMENT_PATTERN.exec(words[index])
    if (match === null) break
    // **只记字面量取值**：`VERIFY_SCRIPT="${CI_CHANNEL_VERIFY_SCRIPT:-…}"` 这种"值里还带间接层"
    // 的赋值记下来只会把后续的 `"$VERIFY_SCRIPT"` **改写成另一个变量形态** —— 于是
    // `CI_SURFACE_VARIABLE_COMMAND_ACK` 的登记项（逐字 `$VERIFY_SCRIPT`）当场变成死条目，
    // 而判据本身并没有变准（值仍然读不懂）。不记它，词保持原样，由既有的变量位判据处理。
    if (SHELL_INDIRECTION_PATTERN.test(match[2])) break
    bindings.set(match[1], match[2])
  }
}
/**
 * 一个词里的变量/命令替换 → 字面量。
 * @param word - 词（引号已被词法器剥掉）。
 * @param bindings - 同一段文本内已解析出的常量表。
 * @returns 字面量；**读不懂时返回 `undefined`**（调用方保持原词并 fail-closed）。
 */
function substituteShellWord(word, bindings) {
  if (word === undefined) return undefined
  if (!SHELL_INDIRECTION_PATTERN.test(word)) return word
  let out = ''
  let index = 0
  while (index < word.length) {
    const character = word[index]
    if (character === '\\') { out += word[index + 1] ?? ''; index += 2; continue }
    if (character === '`') {
      const end = word.indexOf('`', index + 1)
      if (end < 0) return undefined
      const value = literalSubstitutionValue(word.slice(index + 1, end), bindings)
      if (value === undefined) return undefined
      out += value
      index = end + 1
      continue
    }
    if (character === '$' && word[index + 1] === '{') {
      const end = word.indexOf('}', index + 2)
      if (end < 0) return undefined
      const name = word.slice(index + 2, end)
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) return undefined
      const value = bindings.get(name)
      if (value === undefined) return undefined
      out += value
      index = end + 1
      continue
    }
    if (character === '$' && word[index + 1] === '(') {
      const end = balancedCloseIndex(word, index + 1)
      if (end < 0) return undefined
      const value = literalSubstitutionValue(word.slice(index + 2, end), bindings)
      if (value === undefined) return undefined
      out += value
      index = end + 1
      continue
    }
    if (character === '$') {
      const match = /^\$([A-Za-z_][A-Za-z0-9_]*)/u.exec(word.slice(index))
      if (match === null) return undefined
      const value = bindings.get(match[1])
      if (value === undefined) return undefined
      out += value
      index += match[0].length
      continue
    }
    out += character
    index += 1
  }
  return out
}
/**
 * 字符串感知的括号配对（供 {@link substituteShellWord} 切 `$( … )`）。
 * @param text - 文本。
 * @param openIndex - 开括号下标。
 * @returns 闭括号下标；不配对返回 `-1`。
 */
function balancedCloseIndex(text, openIndex) {
  let depth = 0
  for (let index = openIndex; index < text.length; index += 1) {
    const character = text[index]
    if (character === '\\') { index += 1; continue }
    if (character === '(') depth += 1
    else if (character === ')') { depth -= 1; if (depth === 0) return index }
  }
  return -1
}
/**
 * `$(…)` / 反引号的取值 → 字面量（**只认"输出即字面量"的两种形态**）。
 *
 * 这是 R17A-01 里 `$(echo make)` 那一族的正面修法：**能解析就解析出可执行名**，解析不出
 * 就返回 `undefined`（命令位上按 fail-closed 判红），绝不"取不出名字就放行"。
 * @param inner - 替换内部的文本。
 * @param bindings - 常量表。
 * @returns 字面量；不认识的形态返回 `undefined`。
 */
function literalSubstitutionValue(inner, bindings) {
  // **廉价预筛**：绝大多数 `$(…)` 不是 `echo`（`$(git rev-parse …)` / `$(dirname …)` /
  // `$(cd … && pwd)`），先按首词挡掉再分词 —— 真仓实测"给每个 `$(…)` 都分词一遍"是这一处
  // 新开销的大头（闭包总耗时 +35%）。
  if (!/^\s*echo(?:\s|$)/u.test(String(inner))) return undefined
  const commands = shellCommandWordLists(inner)
  if (commands.length !== 1 || commands[0].length === 0) return undefined
  const words = commands[0].map(word => substituteShellWord(word, bindings))
  if (words.some(word => word === undefined)) return undefined
  const head = words[0]
  if (head === 'echo') {
    // `echo -n x` / `echo -e 'x'`：只剥"只由旗标字符组成"的取值。
    return words.slice(1).filter(word => !/^-[neE]+$/u.test(word)).join(' ')
  }
  return undefined
}

/**
 * workflow 文本 → `run:` **块**（块标量 `|` / `>` 与其变体，以及行内形态）。
 *
 * 为什么 `make` 判据只在 `run:` 块上跑，而不是整份 YAML：`name: make sure the build passes`
 * 这类**步骤名**里的 `make` 是散文，不是命令 —— 在整份 YAML 上找 `make` 会把它当成一次调用，
 * 再去 Makefile 里找不到目标 ⇒ 假红。与 `check-install-integrity.mjs` 的同名抽取同形
 * （那边用它取"命令位"，这里用它取"命令文本"），但独立实现（判据不 import 被它判的东西）。
 * @param text - workflow 全文。
 * @returns 块文本数组（块标量的公共缩进已剥掉）。
 */
function workflowRunBlocks(text) {
  const lines = String(text).split('\n')
  const blocks = []
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^([ \t]*)(?:-[ \t]+)?run:[ \t]*(.*)$/u.exec(lines[index])
    if (match === null) continue
    const indent = match[1].length
    const rest = match[2].trim()
    if (rest !== '' && !/^[|>][-+]?[0-9]*$/u.test(rest)) { blocks.push(rest); continue }
    const body = []
    let cursor = index + 1
    for (; cursor < lines.length; cursor += 1) {
      const line = lines[cursor]
      if (line.trim() === '') { body.push(''); continue }
      if (line.length - line.trimStart().length <= indent) break
      body.push(line)
    }
    const indents = body.filter(line => line.trim() !== '').map(line => line.length - line.trimStart().length)
    const cut = indents.length > 0 ? Math.min(...indents) : 0
    blocks.push(body.map(line => line.slice(cut)).join('\n'))
    index = cursor - 1
  }
  return blocks
}
/**
 * workflow 文本 → **按 job 分组的 `run:` 块**（R23 FIX-22 / W4-01 的唯一实现）。
 *
 * 为什么不能只按文件顺序拿一串块：{@link workflowRunBlocks} 是**扁平**的，于是"写过该路径"
 * 的判定只能落在"单个 `run:` 块内"。而同一个 job 的所有 step 跑在**同一个工作树**上
 * （step① 写文件、step② 执行文件是 CI 里最普通的写法），所以跨 step 的"先写后执行"
 * 必须按 **job 作用域**判。修前实测（第二十三轮 W4-01，`probe/logs/a2-two-steps.txt`）：
 * 同一 job 相邻两个 step（step① 写、step② 执行）`EXIT=0` 且凭据行照旧
 * `VERDICT PASS static-only`，而**把两段合并成一个块**就 `EXIT=1` —— 判据没错，作用域错了。
 * 修复头注释里那句"跨 step 的值要经 `$GITHUB_ENV`、那条路已经 fail-closed"只覆盖**值**，
 * 不覆盖**文件写**：`bash scripts/x.sh` 的脚本位是**字面路径**，不需要任何变量跨 step。
 *
 * 分组口径：`jobs:` 的**直接子键**（与 `jobs:` 的第一个非空子行同缩进层级的 `键:` 行）切分；
 * 每个 job 的片段交给 {@link workflowRunBlocks} 抽块。job 名只用于诊断与"跨 job 不共享"
 * 这条不变式（不同 job 可能跑在不同 runner 上，**不**共享工作树）。取不到 `jobs:` 或
 * 取不到 job 子键时**退化成单组**（作用域仍然成立，只是标成 `(未知)`，绝不静默当成"没有写"）。
 * @param text - workflow 全文。
 * @returns `{ job, blocks }` 数组（按文件顺序）。
 */
function workflowJobRunBlocks(text) {
  return workflowJobSections(text).map(section => ({
    job: section.job,
    blocks: workflowRunBlocks(section.text),
  }))
}
/**
 * workflow 文本 → **按 job 分组的 job 正文**（{@link workflowJobRunBlocks} 的取段实现，
 * 抽出来是为了让 {@link workflowJobSteps} 复用同一份分组口径 —— 两处各写一份必然漂移）。
 * @param text - workflow 全文。
 * @returns `{ job, text }` 数组（按文件顺序）；取不到 `jobs:` 时退化成单组 `(未知)`。
 */
function workflowJobSections(text) {
  const lines = String(text).split('\n')
  let jobsIndent = null
  let jobsLine = -1
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^([ \t]*)jobs:[ \t]*$/u.exec(lines[index])
    if (match !== null) { jobsIndent = match[1].length; jobsLine = index; break }
  }
  const fallback = [{ job: '(未知)', text: String(text) }]
  if (jobsLine < 0) return fallback
  let jobIndent = null
  for (let index = jobsLine + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '' || /^[ \t]*#/u.test(line)) continue
    const indent = line.length - line.trimStart().length
    if (indent <= jobsIndent) break
    jobIndent = indent
    break
  }
  if (jobIndent === null) return fallback
  const groups = []
  let current = null
  for (let index = jobsLine + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() !== '' && !/^[ \t]*#/u.test(line)) {
      const indent = line.length - line.trimStart().length
      if (indent <= jobsIndent) break
      if (indent === jobIndent) {
        const header = /^[ \t]*([^\s:#][^:]*):/u.exec(line)
        current = {
          job: header === null ? `(job#${groups.length + 1})` : header[1].trim(),
          lines: [line],
        }
        groups.push(current)
        continue
      }
    }
    if (current !== null) current.lines.push(line)
  }
  if (groups.length === 0) return fallback
  return groups.map(group => ({ job: group.job, text: group.lines.join('\n') }))
}
/**
 * 一个 job 的正文 → **按 step 顺序切开的单元**（R24 FIX-26 / X3-01③ 的唯一实现）。
 *
 * ## 为什么需要"按 step 顺序"
 *
 * R23 FIX-22 把写面作用域从"一段 `run:` 块"扩到了"整个 job"，但 job 里的载体**不止 `run:`
 * 块**：本地复合 action（`uses: ./.github/actions/x`）的 `steps[].run` 同样跑在**同一个工作树**
 * 上。`workflowRunBlocks` 只抽 `run:` ⇒ `uses:` 那一步在结构上不存在，写也就无从归属
 * （第二十四轮 X3 泳道实测：`uses` + 后续 `bash` 执行 ⇒ `EXIT=0`）。
 *
 * 切分口径：`steps:` 之下**与首个列表项同缩进**的 `- ` 行开启一个新 step；`steps:` 之前/之外
 * 的行不属于任何 step（`runs-on:` / `env:` 等不是 step，它们不产生"被执行"的动作）。
 * 取不到 `steps:` 时退化成"整个 job 一个单元"（与 {@link workflowJobRunBlocks} 同形，
 * 绝不静默丢块）。
 *
 * **对账**：调用方（真树那一节）逐 workflow 断言
 * `扁平化(workflowJobSteps(x).steps[].runs) === workflowJobRunBlocks(x)[].blocks` ——
 * 切分器与久经考验的抽取器一旦分叉就红，不允许"两套解析各说各话"。
 * @param text - workflow 全文。
 * @returns `{ job, steps }` 数组；每个 step 是 `{ text, runs, uses }`。
 */
function workflowJobSteps(text) {
  return workflowJobSections(text).map(section => ({
    job: section.job,
    steps: splitWorkflowSteps(section.text),
  }))
}
/**
 * 一个 job 正文 → step 单元数组（{@link workflowJobSteps} 的切分实现）。
 * @param jobText - job 正文（含 `steps:`）。
 * @returns `{ text, runs, uses }` 数组。
 */
function splitWorkflowSteps(jobText) {
  const whole = String(jobText)
  const lines = whole.split('\n')
  let stepsIndent = null
  let listIndent = null
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^([ \t]*)steps:[ \t]*$/u.exec(lines[index])
    if (match === null) continue
    stepsIndent = match[1].length
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor]
      if (line.trim() === '' || /^[ \t]*#/u.test(line)) continue
      if (line.length - line.trimStart().length <= stepsIndent) break
      const item = /^([ \t]*)-[ \t]/u.exec(line)
      if (item !== null) listIndent = item[1].length
      break
    }
    break
  }
  if (listIndent === null) {
    return [{ text: whole, runs: workflowRunBlocks(whole), uses: localCompositeActionDirs(whole) }]
  }
  const chunks = []
  let current = null
  const header = []
  for (const line of lines) {
    const item = /^([ \t]*)-[ \t]/u.exec(line)
    if (item !== null && item[1].length === listIndent) {
      current = [line]
      chunks.push(current)
      continue
    }
    if (current !== null) current.push(line)
    else header.push(line)
  }
  // `steps:` 之前的行也要成一块：那里可能有 `defaults: { run: … }` 这类**同名键**
  // （`workflowRunBlocks` 会把它当成一个 `run:` 块读出来）。把它并进同一串，
  // 切分器才与久经考验的抽取器**逐字同形**（对账判据因此可以严格到"逐字节相同"）。
  // 它**不**贡献 `uses`：job 级 `uses:` 是复用工作流，不是 step。
  const units = [{ text: header.join('\n'), runs: workflowRunBlocks(header.join('\n')), uses: [] }]
  for (const chunk of chunks) {
    const text_ = chunk.join('\n')
    units.push({ text: text_, runs: workflowRunBlocks(text_), uses: localCompositeActionDirs(text_) })
  }
  return units
}

/**
 * 一段文本 → **`docker compose … run <服务>` 调用**（第十五轮 R15A-03 的 C8）。
 *
 * 现场（修前）：把命令写进 compose 文件、`ci.yml` 里只留
 * `docker compose -f ci-r15a.yml run e2e` ⇒ 闭包三张网全绿（命令在数据文件里）。
 * compose 是**第三种载体**（前两种是 Makefile 与包装脚本），所以它必须进闭包。
 *
 * 与 {@link makeInvocations} 同源：同样先走 {@link unwrapCommandWords} 的包装链
 * （`env FOO=1 docker compose …` / `timeout 60 docker compose …` 也要能读），
 * 然后只认 `docker|podman compose` 或 `docker-compose` 的 `run` 子命令。
 * `-f/--file` 的取值与 service 名读不懂（变量/表达式）时记 `problems`（fail-closed）。
 * @param text - shell / Makefile / 配方正文。
 * @returns `{ invocations, problems }`；每项 `{ raw, files, service, override }`。
 */
function composeRunInvocations(text, strict = true, context = undefined) {
  const invocations = []
  const commandWords = []
  const problems = []
  for (const words of shellCommandWordListsFor(text, context)) {
    const chain = unwrapCommandWords(words, strict)
    commandWords.push(...chain.commandWords)
    problems.push(...chain.problems)
    for (const head of chain.heads) {
      const isComposeWrapper = head[0] === 'docker-compose'
      const isComposeSubcommand = (head[0] === 'docker' || head[0] === 'podman') && head[1] === 'compose'
      if (!isComposeWrapper && !isComposeSubcommand) continue
      const invocation = {
        raw: head.join(' '), files: [], projectDir: undefined, service: undefined, override: [], envFiles: [],
      }
      let index = isComposeWrapper ? 1 : 2
      let subcommand = null
      for (; index < head.length; index += 1) {
        const word = head[index]
        if (word === '-f' || word === '--file') {
          const value = head[index + 1]
          index += 1
          if (isUnreadableCommandWord(value)) invocation.files.push(undefined)
          else invocation.files.push(value)
          continue
        }
        if (word.startsWith('--file=')) { invocation.files.push(word.slice('--file='.length)); continue }
        if (word === '--project-directory') {
          invocation.projectDir = isUnreadableCommandWord(head[index + 1]) ? undefined : head[index + 1]
          index += 1
          continue
        }
        if (word.startsWith('--project-directory=')) { invocation.projectDir = word.slice('--project-directory='.length); continue }
        if (word === '--env-file') {
          const value = head[index + 1]
          invocation.envFiles.push(isUnreadableCommandWord(value) ? undefined : value)
          index += 1
          continue
        }
        if (word.startsWith('--env-file=')) {
          invocation.envFiles.push(word.slice('--env-file='.length))
          continue
        }
        // 其余 compose 级旗标：`-p` / `--profile` / `--ansi` / `--project-name` 带取值。
        if (['-p', '--project-name', '--profile', '--ansi', '--progress'].includes(word)) { index += 1; continue }
        if (word.startsWith('-')) continue
        subcommand = word
        break
      }
      if (subcommand !== 'run') continue // `config -q` / `up -d` 之类不是"执行文件里的命令"
      for (index += 1; index < head.length; index += 1) {
        const word = head[index]
        if (word === '--') continue
        if (word.startsWith('-')) {
          // `run --entrypoint=<命令>`：它**替换**镜像入口，本身就是一段要跑的命令（R16A-15）。
          if (word === '--entrypoint') {
            const value = head[index + 1]
            if (value !== undefined) invocation.override.push(value)
            index += 1
            continue
          }
          if (word.startsWith('--entrypoint=')) {
            invocation.override.push(word.slice('--entrypoint='.length))
            continue
          }
          // `run` 的旗标里 `-e/--env` / `-v/--volume` / `-u/--user` / `-w/--workdir` 带取值。
          if (['-e', '--env', '-v', '--volume', '-u', '--user', '-w', '--workdir', '-p', '--publish', '-l', '--label', '--name'].includes(word)) index += 1
          continue
        }
        invocation.service = word
        invocation.override = head.slice(index + 1)
        break
      }
      invocations.push(invocation)
    }
  }
  return { invocations, commandWords, problems }
}

/**
 * 极简 compose 读取器：取 `services.<服务>.command` / `.entrypoint`（第十五轮 R15A-03 的 C8）。
 *
 * 只做这一件事（不引 YAML 依赖，闭包保持"纯文本 + 谓词"的形态），但**读不懂就 fail-closed**：
 * 找不到 `services:`、找不到该服务、`command:` 的取值形态不认识 —— 一律记 problem，
 * 绝不把"解析不了"当成"这个服务没跑端到端"。
 * @param text - compose 文件正文。
 * @param service - 目标服务名。
 * @returns `{ commands, problems }`（`commands` = 该服务的命令文本列表，含 `entrypoint`）。
 */
function composeServiceCommands(text, service, env = new Map()) {
  const problems = []
  const commands = []
  const lines = []
  for (const rawLine of String(text).split('\n')) {
    const trimmed = rawLine.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    lines.push({ indent: rawLine.length - rawLine.trimStart().length, text: trimmed })
  }
  /** 取 `key: value` 形态（只认**块式** YAML：顶层键冒号后可以有值）。 */
  const keyOf = line => {
    const match = /^([A-Za-z0-9_.\-"']+):(?:[ \t]+(.*))?$/u.exec(line.text)
    if (match === null) return null
    return { key: match[1].replace(/^["']|["']$/gu, ''), value: (match[2] ?? '').trim() }
  }
  const indexOfKey = (key, from, until, indent) => {
    for (let index = from; index < until; index += 1) {
      if (indent !== undefined && lines[index].indent !== indent) continue
      const parsed = keyOf(lines[index])
      if (parsed !== null && parsed.key === key) return index
    }
    return -1
  }
  const blockEnd = (start, indent) => {
    let end = start + 1
    while (end < lines.length && lines[end].indent > indent) end += 1
    return end
  }
  /**
   * YAML **锚点**（`x-e2e-cmd: &e2e-cmd` + `command: *e2e-cmd`）。
   *
   * R16A-13 的现场：修前只读 `command:` 那一格的字面量，`*e2e-cmd` 被当成普通取值 ⇒
   * 锚点正文（真正的命令）从不进闭包，而 `docker compose config` 解出来就是
   * `bash integration-tests/run-all.sh`。锚点正文是**字面路径**，没有理由不跟随。
   */
  const anchors = new Map()
  for (let index = 0; index < lines.length; index += 1) {
    const match = /[&]([A-Za-z0-9_-]+)/u.exec(lines[index].text)
    if (match === null) continue
    const inline = lines[index].text.slice(match.index + match[0].length).trim()
    if (inline !== '') { anchors.set(match[1], inline); continue }
    const body = []
    for (let cursor = index + 1; cursor < lines.length && lines[cursor].indent > lines[index].indent; cursor += 1) {
      body.push(lines[cursor].text.replace(/^-\s*/u, ''))
    }
    anchors.set(match[1], body.join(' '))
  }
  /**
   * `${VAR}` / `${VAR:-缺省}` / `$VAR` 的插值（R16A-14/15）。
   *
   * `env` 由调用方从 `--env-file <字面量>` 与项目目录的 `.env` 读出来（见
   * {@link ciExecutionSurface} 的 `expandComposeCalls`）。**插不出字面量 ⇒ 记 problem**：
   * 命令文本里有读不懂的间接层时，闭包判不了它跑什么，绝不静默当成"这个服务没跑端到端"。
   * @param value - compose 里的取值文本。
   * @returns 插值后的文本。
   */
  const interpolate = value => {
    const substituted = String(value).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?-(.*?))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/gu,
      (whole, braced, fallback, bare) => {
        const name = braced ?? bare
        if (env.has(name)) return env.get(name)
        if (fallback !== undefined) return fallback
        problems.push(`compose 文件里的 \`${whole}\` 插不出字面量（环境里没有 \`${name}\`，`
          + '也没有 `--env-file` / 同目录 `.env` 提供它）—— 读不懂它跑什么，按 fail-closed 记红')
        return whole
      })
    return substituted
  }
  const servicesIndex = indexOfKey('services', 0, lines.length, 0)
  if (servicesIndex < 0) {
    problems.push('compose 文件里找不到顶层 `services:` —— 服务命令读不出来，按 fail-closed 记红')
    return { commands, problems }
  }
  const servicesEnd = blockEnd(servicesIndex, lines[servicesIndex].indent)
  const serviceIndex = indexOfKey(service, servicesIndex + 1, servicesEnd, undefined)
  if (serviceIndex < 0) {
    problems.push(`compose 文件里找不到服务 \`${service}\`（\`services:\` 块内只有 `
      + `${lines.slice(servicesIndex + 1, servicesEnd).map(line => keyOf(line)?.key).filter(Boolean).join('、') || '(空)'}）`
      + ' —— 读不到它的命令 ⇒ fail-closed')
    return { commands, problems }
  }
  const serviceEnd = blockEnd(serviceIndex, lines[serviceIndex].indent)
  for (const key of ['command', 'entrypoint']) {
    const commandIndex = indexOfKey(key, serviceIndex + 1, serviceEnd, undefined)
    if (commandIndex < 0) continue
    const { value } = keyOf(lines[commandIndex])
    if (value !== '' && !/^[|>][-+]?[0-9]*$/u.test(value)) {
      // 锚点别名（`command: *e2e-cmd`）：正文在锚点定义处。
      const alias = /^\*([A-Za-z0-9_-]+)$/u.exec(value)
      if (alias !== null) {
        if (!anchors.has(alias[1])) {
          problems.push(`compose 文件里 \`${key}: ${value}\` 引用的锚点 \`${alias[1]}\` 找不到 ——`
            + '锚点正文就是命令，读不到它 ⇒ fail-closed 记红')
          continue
        }
        commands.push(interpolate(anchors.get(alias[1])))
        continue
      }
      // 行内标量或行内列表（`command: [bash, x.sh]`）。
      commands.push(interpolate(value.replace(/^\[/u, '').replace(/\]$/u, '').replace(/,\s*/gu, ' ').replace(/["']/gu, '')))
      continue
    }
    // 块标量（`|` / `>`）或嵌套列表（`- item`）：取该键之后、缩进更深的那些行。
    const items = []
    for (let index = commandIndex + 1; index < serviceEnd && lines[index].indent > lines[commandIndex].indent; index += 1) {
      items.push(lines[index].text.replace(/^-\s*/u, ''))
    }
    if (items.length === 0) {
      problems.push(`compose 文件里 \`${key}:\` 的取值形态读不懂（${lines[commandIndex].text}）——`
        + ' 闭包判不了它跑什么，按 fail-closed 记红（请把它写成行内标量或 `- ` 列表）')
      continue
    }
    commands.push(interpolate(items.join(' ')))
  }
  return { commands, problems }
}

/**
 * 一段文本 → **`make` 调用**（含 `$(MAKE)` 递归、`cd <dir> && make …`、任意深度的包装链）。
 *
 * 命令位由 {@link unwrapCommandWords} 解析：**包装链**（`sudo`/`timeout`/`env`/`npx`/
 * `npm exec --`/`bash -c` 等已登记形态，任意深度）走到尽头之后，若那一位是
 * `make`/`gmake`/`$(MAKE)`，就给出 `-C` 目录、`-f` 文件与目标表；`bash -c '<文本>'`
 * 的内层按**同一套词法递归**（第十五轮 R15A-03：这三种形态修前全部漏网）。
 * **读不懂的位不猜**：包装位、值位、目标位里出现变量或 GitHub 表达式时记进
 * `unresolved` / `problems`，由调用方 fail-closed（VA-05-F1 的收口纪律）。
 * @param text - shell / Makefile 正文（workflow 的 `run:` 块 / `.sh` 正体 / Makefile 配方）。
 * @param depth - 内层 shell 文本的递归深度（`bash -c` / `npm exec -c`）。
 * @returns `{ invocations, problems }`：每项 `{ raw, dir, makefile, targets, unresolved, cwd }`。
 */
function makeInvocations(text, depth = 0, strict = true, context = undefined) {
  const invocations = []
  const commandWords = []
  const problems = []
  /** `cd <dir> && make …`：上一条命令的 `cd` 是下一条命令的工作目录。 */
  let cwd = null
  for (const words of shellCommandWordListsFor(text, context)) {
    if (words[0] === 'cd' && words.length === 2 && !words[1].includes('$')) { cwd = words[1]; continue }
    const chain = unwrapCommandWords(words, strict)
    commandWords.push(...chain.commandWords)
    problems.push(...chain.problems)
    if (chain.nestedTexts.length > 0) {
      if (depth >= CI_SURFACE_MAX_HOPS) {
        problems.push(`\`bash -c\` 一类内层 shell 文本的嵌套超过深度上限 ${CI_SURFACE_MAX_HOPS}`
          + `（${words.join(' ')}）—— 读不懂 ⇒ fail-closed`)
      } else {
        for (const nested of chain.nestedTexts) {
          // 非 shell 的载体（`node -e '<js>'` / `python3 -c '<py>'`）由
          // {@link ciExecutionSurface} 的通用扫描按该语言的抽取器处理，这里只递归 shell 文本。
          if (nested.language !== 'shell') continue
          const inner = makeInvocations(nested.text, depth + 1, strict, context)
          invocations.push(...inner.invocations)
          commandWords.push(...inner.commandWords)
          problems.push(...inner.problems)
        }
      }
    }
    for (const head of chain.heads) {
      const command = head[0]
      if (command !== 'make' && command !== 'gmake' && command !== MAKE_RECURSIVE_WORD) continue
      const invocation = {
        raw: head.join(' '), dir: undefined, makefile: undefined, targets: [], unresolved: [], cwd,
      }
      for (let cursor = 1; cursor < head.length; cursor += 1) {
        const word = head[cursor]
        if (word.includes('$') || word.includes(MAKE_RECURSIVE_WORD) || word.includes('{{')) {
          invocation.unresolved.push(word)
          continue
        }
        const assign = (key, value) => {
          if (key === 'dir') invocation.dir = value
          else invocation.makefile = value
        }
        if (MAKE_VALUE_FLAGS.has(word)) {
          const value = head[cursor + 1]
          cursor += 1
          if (value === undefined || value.includes('$')) invocation.unresolved.push(word)
          else assign(word === '-C' || word === '--directory' ? 'dir' : 'file', value)
          continue
        }
        // `-j` / `-l` 的参数是**可选**的（`make -j 4 t` 与 `make -j t` 都合法）：
        // 只把"看起来是数字"的下一个词当取值，免得把目标名吃掉。
        if ((word === '-j' || word === '-l') && /^[0-9.]+$/u.test(head[cursor + 1] ?? '')) { cursor += 1; continue }
        const attached = /^(--(?:directory|file|makefile))=(.+)$/u.exec(word)
        if (attached !== null) { assign(attached[1].startsWith('--directory') ? 'dir' : 'file', attached[2]); continue }
        if (/^-C.+/u.test(word)) { invocation.dir = word.slice(2); continue }
        if (/^-f.+/u.test(word)) { invocation.makefile = word.slice(2); continue }
        if (word.startsWith('-')) continue // 其余旗标（`-s` / `-n` / `-k` …）不影响目标表
        if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(word)) continue // `VAR=value`
        invocation.targets.push(word)
      }
      invocations.push(invocation)
    }
  }
  return { invocations, commandWords, problems }
}

/**
 * Makefile 正文 → **规则表**（目标 → 前置 + 配方行）与 `include` 指令。
 *
 * 只认三种行：`include…`、规则行（`目标…: 前置…[; 配方]`）、TAB 起的配方行；其余
 * （变量赋值 / 条件指令 / 注释）不进规则表。`.PHONY` 这类以 `.` 开头的特殊目标不算目标
 * （它没有配方）。多目标行（`a b: c`）的每个目标都拿到同一份配方。
 * @param text - Makefile 正文。
 * @returns `{ rules, includes, variables }`。
 */
function makefileRules(text) {
  const rules = new Map()
  const includes = []
  const variables = new Map()
  let currentRules = []
  for (const rawLine of String(text).split('\n')) {
    if (/^\t/u.test(rawLine)) {
      const recipe = rawLine.slice(1)
      for (const rule of currentRules) rule.recipe.push(recipe)
      continue
    }
    const line = rawLine.replace(/(?:^|\s)#.*$/u, '').trimEnd()
    if (line.trim() === '') { currentRules = []; continue }
    const includeMatch = /^(?:-?include|sinclude)\s+(.+)$/u.exec(line.trim())
    if (includeMatch !== null) {
      includes.push(...includeMatch[1].trim().split(/\s+/u).filter(Boolean))
      currentRules = []
      continue
    }
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)\s*[:?+]?=\s*(.*)$/u.exec(line.trim())
    if (assignment !== null) {
      // 只留"最后一次赋值"（与 make 的语义近似；`+=` 按覆盖处理 —— 判据只需要能解析
      // 常见的 `RUNNER := bash` 这类常量，解析不出就保持原样、物化成"看不见的 token"）。
      variables.set(assignment[1], assignment[2].trim())
      currentRules = []
      continue
    }
    const ruleMatch = /^([^=]*?):(?!=)(.*)$/u.exec(line)
    if (ruleMatch === null || ruleMatch[1].trim() === '') { currentRules = []; continue }
    const names = ruleMatch[1].trim().split(/\s+/u).filter(name => name !== '' && !name.startsWith('.'))
    const tail = ruleMatch[2]
    const semicolon = tail.indexOf(';')
    const prereqs = (semicolon >= 0 ? tail.slice(0, semicolon) : tail).trim().split(/\s+/u).filter(Boolean)
    const inline = semicolon >= 0 ? [tail.slice(semicolon + 1).trim()] : []
    currentRules = []
    for (const name of names) {
      const rule = rules.get(name) ?? { prereqs: [], recipe: [] }
      rule.prereqs.push(...prereqs)
      rule.recipe.push(...inline)
      rules.set(name, rule)
      currentRules.push(rule)
    }
  }
  return { rules, includes, variables }
}

/**
 * 把 Makefile 里的 `$(VAR)` / `${VAR}` 展开成字面量（只展开**已赋值**的变量；其余原样保留
 * ⇒ 那些 token 含 `$`，闭包的 token 口径本来就会跳过它们 —— 与 shell 的既有边界同一句认账）。
 * @param text - 待展开的文本。
 * @param variables - `makefileRules()` 给的变量表。
 * @param depth - 递归深度（缺省 0）。
 * @returns 展开后的文本。
 */
function expandMakeVariables(text, variables, depth = 0) {
  if (depth > 4) return String(text)
  const replaced = String(text).replace(/\$[({]([A-Za-z_][A-Za-z0-9_]*)[)}]/gu, (whole, name) => {
    const value = variables.get(name)
    return value === undefined ? whole : value
  })
  return replaced === String(text) ? replaced : expandMakeVariables(replaced, variables, depth + 1)
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
  /** `options.exists` 的记忆化（同一棵树里对同一路径的反复询问很多）。 */
  const existsCache = new Map()
  const existsOnce = path => {
    if (existsCache.has(path)) return existsCache.get(path)
    const value = options.exists(path)
    existsCache.set(path, value)
    return value
  }
  const resolveScript = (token, dir) => {
    const candidates = typeof dir === 'string' && dir !== '' ? [`${dir}/${token}`, token] : [token]
    for (const candidate of candidates) {
      const normalized = candidate.replace(/^\.\//u, '')
      if (normalized === '' || normalized.startsWith('/') || normalized.startsWith('~')) continue
      if (normalized.split('/').includes('..')) continue
      if (CI_SURFACE_SCRIPT_PATTERN.test(normalized) && existsOnce(normalized)) return normalized
    }
    return undefined
  }
  const mentioning = new Map()
  const reached = new Map()
  /**
   * **E-01 写目标识别器的最近一次实现**（R23 FIX-22 / W4-06）。
   *
   * `runtimeWrittenCarriers` 与 `scanCarrierPaths` 一样定义在节点处理循环体内（它依赖同一层
   * 作用域里的 `resolveCarrierPath`），所以收尾的判决级见证拿不到它 —— 这里在每轮循环里把
   * 当前实现挂出来，`writeTargets` 再转交给 `runtimeWriteDetectorProblem()` 在合成样本上自证。
   * 掏空被指向的那份实现时这个引用仍然指向掏空版 ⇒ 见证必然失败（这正是要的语义）。
   * @type {((source: string) => Set<string>) | null}
   */
  let writeTargetsImpl = null
  const problems = []
  /** 严格面上命令位**出现过**的可执行名集合（{@link CI_COMMAND_REGISTRY} 的死条目对账用）。 */
  const commandWords = new Set()
  /** 命中的"包装链尽头是变量命令位"（`{ file, word, raw }`）—— 用于**死条目对账**。 */
  const variableCommands = []
  /** 命中的"命令位形态读不懂"（`{ file, word, raw, acked }`）—— 用于**死条目对账**。 */
  const commandShapes = []
  /** 命中的"脚本位读不懂"（`{ file, word, raw, acked }`，R18A-01）—— 用于**死条目对账**。 */
  const shellArguments = []
  /** 命中的"脚本位指向**仓内不存在**的字面路径"（`{ file, word, raw, acked }`，R20A-05）。 */
  const generatedScripts = []
  const seenStructuredProblems = new Set()
  const nodes = []
  const seen = new Set()
  let truncated = false
  /** 定义别名表的 manifest（当前只有根 manifest 一处；执行面的别名都从它解析）。 */
  const manifestOwner = options.rootManifestPath ?? 'package.json'
  const queue = []
  /** 因**深度超限**被拒绝入队的节点（R18A-04）：与 `truncated` 同款 fail-loud，不静默丢弃。 */
  const hopsExceeded = new Set()
  const enqueue = item => {
    if (item.hops <= CI_SURFACE_MAX_HOPS) { queue.push(item); return }
    // **R18A-04**：修前这里是 `if (item.hops <= CI_SURFACE_MAX_HOPS) queue.push(item)` ——
    // 超限节点**直接消失**，而"9 层包装链"恰好因此在闭包外（守卫 EXIT=0 而 CI 真的执行）。
    // 深度上限存在的意义是"闭包异常扩张时 fail-loud"，所以超限必须记红（与节点上限
    // `truncated` 同一口径），并把**链**打出来（诊断要点名是哪一层超的）。
    const key = `${item.key}\u0000${item.hops}`
    if (hopsExceeded.has(key)) return
    hopsExceeded.add(key)
    problems.push(`${item.file}：载体/包装链的深度超过上限 ${CI_SURFACE_MAX_HOPS} 层`
      + `（链：${item.via.join(' → ')}）—— 超过上限的节点**不静默丢弃**：`
      + '越深的包装链正是"把端到端入口藏起来"最容易的形态（R18A-04：9 层链在修前完全在闭包外），'
      + '所以按 fail-closed 记红。请把链缩短，或把这一处的跟随面写进登记表。')
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
    // "正文提到"面：只对 shell / YAML / manifest 与**脚本语言**的正体生效
    // （JS/TS 正体里的字符串是数据，不算执行 —— 本守卫自己的登记表就是反例）。
    //
    // R15A-03 的 C5/C6：修前这里**显式排除**了非 `.sh/.bash` 的脚本体，于是
    // `scripts/x.py` 里**逐字**写着 `integration-tests/run-all.sh`（`runpy.run_path` /
    // `exec(open(...).read())`）时，它在"执行形态抽取"与"正文文本网"**两张网之间**掉了出去
    // （抽取器只认 `subprocess.*` / `os.*`；文本网又把它排除）⇒ 守卫绿而 CI 真的会执行。
    const textNetApplies = node.kind !== 'script'
      || CI_SURFACE_TEXT_NET_SCRIPT_EXTENSIONS.some(extension => node.file.endsWith(extension))
    if (textNetApplies && E2E_END_TO_END_PATTERN.test(text)) mentioning.set(node.file, node.via)
    /** 一条命令**可能**在哪些目录里跑：节点自己的 dir ∪ workflow 声明的 `working-directory`。 */
    const workingDirsFor = raw => {
      const dirs = new Set()
      if (typeof node.dir === 'string' && node.dir !== '') dirs.add(node.dir)
      if (node.kind === 'yaml') {
        // 仓库根也是一个候选：`run:` 块可能跑在没有 `working-directory` 的 job 里，而"每个
        // run 块属于哪个 job"要解析 job/step 两层 YAML —— 这里不去猜，把两种解释**都跟随**
        // （所有解析得出的候选 Makefile 都跟），只在**全都解析不出目标**时才 fail-closed。
        dirs.add('')
        for (const match of String(raw).matchAll(/^[^\S\n]*(?:-[^\S\n]+)?working-directory:[^\S\n]*(\S+)[^\S\n]*$/gmu)) {
          if (!match[1].includes('$')) dirs.add(match[1].replace(/^\.\//u, ''))
        }
      }
      return [...dirs]
    }
    /**
     * 闭包 problem 的**唯一落点**：字符串 ⇒ 直接记红；结构化项（`{ kind, word, message }`）
     * ⇒ 先过 {@link CI_SURFACE_VARIABLE_COMMAND_ACK} 的登记制，未登记才记红（并记下命中，
     * 供"死条目双向对账"用）。
     * @param problem - `string` 或 `{ kind, word, message }`。
     */
    const reportClosureProblem = problem => {
      if (typeof problem === 'string') { problems.push(`${node.file}：${problem}`); return }
      // **去重**：同一条命令会被 `make` / `docker compose` / 通用载体三个扫描器各走一遍
      // （它们的输入是同一段文本），同一个命令位只算一次 —— 否则"登记 1 处、命中 3 次"
      // 会让死条目对账永远算不平。
      const key = `${node.file}\u0000${problem.kind}\u0000${problem.word}\u0000${problem.raw}`
      if (seenStructuredProblems.has(key)) return
      seenStructuredProblems.add(key)
      // 两族**可逐处登记**的 fail-closed（各自一张登记表 + 死条目双向对账）：
      //   · `variable-command`          —— 包装链尽头的变量命令位（R16-W）；
      //   · `command-shape-unreadable`  —— 命令位首词含间接层且解析不出字面量（R17-X / R17A-01）。
      if (problem.kind === 'variable-command') {
        const acked = CI_SURFACE_VARIABLE_COMMAND_ACK.some(entry => entry.file === node.file && entry.word === problem.word)
        variableCommands.push({ file: node.file, word: problem.word, raw: problem.raw, acked })
        if (!acked) problems.push(`${node.file}：${problem.message}`)
        return
      }
      if (problem.kind === 'shell-argument-unreadable') {
        const acked = CI_SURFACE_VARIABLE_COMMAND_ACK.some(entry => entry.file === node.file && entry.word === problem.word)
        shellArguments.push({ file: node.file, word: problem.word, raw: problem.raw, acked })
        if (!acked) problems.push(`${node.file}：${problem.message}`)
        return
      }
      if (problem.kind === 'missing-script-carrier') {
        const acked = CI_SURFACE_GENERATED_SCRIPT_ACK.some(entry => entry.file === node.file && entry.word === problem.word)
        generatedScripts.push({ file: node.file, word: problem.word, raw: problem.raw, acked })
        if (!acked) problems.push(`${node.file}：${problem.message}`)
        return
      }
      if (problem.kind === 'command-shape-unreadable') {
        const acked = CI_SURFACE_COMMAND_SHAPE_ACK.some(entry => entry.file === node.file && entry.word === problem.word)
        commandShapes.push({ file: node.file, word: problem.word, raw: problem.raw, acked })
        if (!acked) problems.push(`${node.file}：${problem.message}`)
        return
      }
      problems.push(`${node.file}：${problem.message ?? String(problem)}`)
    }
    /**
     * `make` 间接的扩张（VA-05-F1）。**读不懂就 fail-closed**：值位/目标位含变量、
     * Makefile 不存在 / 读不出、`include` 解析不出、目标在 Makefile 里找不到 ——
     * 一律记一条 problem（判据红且诊断点名文件与形态），不静默当成"这一层没有端到端"。
     * @param raw - 可能含 `make` 调用的正文。
     * @param dirs - 这条命令可能的工作目录（`-C` 缺席时按它们逐个找 Makefile）。
     */
    const expandMakeCalls = (raw, dirs, strict = true, context = undefined) => {
      const scanned = makeInvocations(raw, 0, strict, context)
      for (const word of scanned.commandWords) commandWords.add(word)
      // 包装位读不懂（`timeout $T make …` / `bash -c "$CMD"` / 包装链过深）**同样是** fail-closed：
      // R15A-03 的形态正是"把 make 藏进参数位"，只报 unresolved 会让它静默溜走。
      for (const problem of scanned.problems) reportClosureProblem(problem)
      for (const invocation of scanned.invocations) {
        if (invocation.unresolved.length > 0) {
          problems.push(`${node.file} 里的 \`make\` 调用读不懂（${invocation.raw}）：`
            + `这些位是变量/表达式 \`${invocation.unresolved.join(' ')}\` —— 值位或目标位含变量时`
            + '闭包无法判定它跑什么，按 fail-closed 记红（请把它写成字面量）。')
          continue
        }
        if (invocation.targets.length === 0) {
          problems.push(`${node.file} 里的 \`make\` 调用没有目标（${invocation.raw}）——`
            + ' 它跑的是 Makefile 的第一个目标，闭包判不了 ⇒ fail-closed。')
          continue
        }
        // 工作目录：`cd <dir> &&` 优先，其次 `-C <dir>`，最后是这条命令可能的工作目录们。
        // 候选（工作目录 × Makefile 名）**逐个都跟随**，只在**一个都解析不出目标**时才红。
        const cdBase = invocation.cwd !== null && invocation.cwd !== undefined
          ? (dirs.length > 0 ? dirs : ['']).map(base => joinSurfacePath(base, invocation.cwd))
          : dirs.length > 0 ? dirs : ['']
        const baseDirs = invocation.dir !== undefined
          ? cdBase.map(base => joinSurfacePath(base, invocation.dir))
          : cdBase
        const candidates = []
        for (const base of baseDirs) {
          if (invocation.makefile !== undefined) candidates.push(joinSurfacePath(base, invocation.makefile))
          else for (const name of MAKEFILE_NAMES) candidates.push(joinSurfacePath(base, name))
        }
        const existing = [...new Set(candidates)].filter(candidate => options.exists(candidate))
        if (existing.length === 0) {
          problems.push(`${node.file} 里的 \`make\` 调用（${invocation.raw}）找不到 Makefile：`
            + `试过 ${[...new Set(candidates)].join('、')} —— 读不到 Makefile 就没法知道这个目标跑什么，`
            + '按 fail-closed 记红（把 `-C <dir>` / `-f <file>` 写成闭包能解析的字面量）。')
          continue
        }
        let resolved = 0
        for (const makefile of existing) {
          const parsed = followMakefile(options, makefile)
          if (parsed.problems.length > 0) {
            problems.push(...parsed.problems.map(message => `${node.file} → ${makefile}：${message}`))
            continue
          }
          // `$(shell …)` / `!=` 是**解析期**执行：与目标是什么无关，一律跟随（R16A-12）。
          for (const [shellIndex, shell] of (parsed.shells ?? []).entries()) {
            enqueue({
              key: `${makefile}#shell:${shellIndex}`, file: makefile, kind: 'shell-value', text: shell,
              dir: makefile.includes('/') ? makefile.slice(0, makefile.lastIndexOf('/')) : '',
              via: [...node.via, `${makefile} $(shell …)`], hops: node.hops + 1,
            })
          }
          for (const target of invocation.targets) {
            const body = makeTargetBody(target, parsed.rules, parsed.variables)
            if (body.text === undefined) continue // 这个候选里没有这个目标 ⇒ 换下一个候选
            resolved += 1
            enqueue({
              key: `${makefile}#make:${target}`, file: makefile, kind: 'makefile', text: body.text,
              dir: makefile.includes('/') ? makefile.slice(0, makefile.lastIndexOf('/')) : '',
              via: [...node.via, `${makefile} make ${target}`], hops: node.hops + 1,
            })
          }
        }
        if (resolved === 0) {
          problems.push(`${node.file} 里的 \`make\` 调用（${invocation.raw}）的目标 `
            + `\`${invocation.targets.join(' ')}\` 在候选 Makefile（${existing.join('、')}）里都找不到 ——`
            + ' 按 fail-closed 记红：读不到目标体就无法判定它是否触达端到端入口。')
        }
      }
    }
    /**
     * `docker compose … run <服务>` 的扩张（R15A-03 的 C8）：命令写在 **compose 文件**里时，
     * `ci.yml` 的 run 块只有 `docker compose -f <文件> run <服务>` —— 闭包必须读那个文件。
     * **读不懂就 fail-closed**：compose 文件不存在 / 服务名读不出 / `command:` 形态不认识 /
     * `-f` 的取值是变量 —— 一律记 problem。
     * @param raw - 可能含 `docker compose … run` 调用的正文。
     * @param dirs - 这条命令可能的工作目录（`-f` 是相对路径时按它们逐个找）。
     */
    const expandComposeCalls = (raw, dirs, strict = true, context = undefined) => {
      const scanned = composeRunInvocations(raw, strict, context)
      for (const word of scanned.commandWords) commandWords.add(word)
      for (const problem of scanned.problems) reportClosureProblem(problem)
      for (const invocation of scanned.invocations) {
        if (invocation.service === undefined) {
          problems.push(`${node.file} 里的 \`docker compose … run\` 没有服务名（${invocation.raw}）——`
            + ' 读不到服务名就不知道它跑哪条命令，按 fail-closed 记红。')
          continue
        }
        if (invocation.files.some(file => file === undefined)) {
          problems.push(`${node.file} 里的 \`docker compose ${invocation.raw}\` 的 \`-f\` 取值是变量 ——`
            + ' 闭包无法判定它读哪份 compose 文件，按 fail-closed 记红（请把它写成字面量）。')
          continue
        }
        const bases = invocation.projectDir !== undefined
          ? [invocation.projectDir]
          : dirs.length > 0 ? dirs : ['']
        const requested = invocation.files.length > 0
          ? invocation.files
          : ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml']
        const candidates = [...new Set(bases.flatMap(base => requested
          .map(file => (/^\.\.?\//u.test(file) || file.includes('/') ? joinSurfacePath(base, file) : file))))]
        const existing = candidates.filter(candidate => options.exists(candidate))
        if (existing.length === 0) {
          problems.push(`${node.file} 里的 \`docker compose … run ${invocation.service}\` 找不到 compose 文件：`
            + `试过 ${candidates.join('、')} —— 读不到文件就没法知道它跑什么，按 fail-closed 记红。`)
          continue
        }
        // compose 的插值来源：`--env-file <字面量>` 与 compose 文件同目录的 `.env`
        // （docker compose 的缺省行为）。**读不出**的取值留给 `composeServiceCommands`
        // 记 problem（fail-closed），不在这里猜。
        const composeEnv = new Map()
        for (const envFile of invocation.envFiles) {
          if (envFile === undefined) continue
          for (const candidate of bases.map(base => joinSurfacePath(base, envFile))) {
            const text = options.exists(candidate) ? readCarrier(candidate) : undefined
            if (text === undefined) continue
            for (const line of text.split('\n')) {
              const entry = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line)
              if (entry === null) continue
              composeEnv.set(entry[1], entry[2].trim().replace(/^["']|["']$/gu, ''))
            }
          }
        }
        let followed = 0
        for (const composeFile of existing) {
          const dotEnv = joinSurfacePath(composeFile.includes('/') ? composeFile.slice(0, composeFile.lastIndexOf('/')) : '', '.env')
          if (!composeEnv.size && options.exists(dotEnv)) {
            const text = readCarrier(dotEnv)
            for (const line of String(text ?? '').split('\n')) {
              const entry = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line)
              if (entry !== null) composeEnv.set(entry[1], entry[2].trim().replace(/^["']|["']$/gu, ''))
            }
          }
          const parsed = composeServiceCommands(options.read(composeFile), invocation.service, composeEnv)
          problems.push(...parsed.problems.map(message => `${node.file} → ${composeFile}：${message}`))
          for (const [index, command] of parsed.commands.entries()) {
            followed += 1
            enqueue({
              key: `${composeFile}#service:${invocation.service}:${index}`, file: composeFile, kind: 'shell-value',
              text: command, dir: composeFile.includes('/') ? composeFile.slice(0, composeFile.lastIndexOf('/')) : '',
              via: [...node.via, `${composeFile} services.${invocation.service}.command`], hops: node.hops + 1,
            })
          }
        }
        // `docker compose run <服务> <命令…>` 的命令行覆盖项同样必须跟随（它优先级最高）。
        if (invocation.override.length > 0) {
          followed += 1
          enqueue({
            key: `${existing[0]}#service:${invocation.service}:override`, file: existing[0], kind: 'shell-value',
            text: invocation.override.join(' '), dir: '',
            via: [...node.via, `${invocation.raw} 的命令行覆盖`], hops: node.hops + 1,
          })
        }
        if (followed === 0) {
          problems.push(`${node.file} 里的 \`docker compose … run ${invocation.service}\` 在 `
            + `${existing.join('、')} 里既没有 \`command:\`/\`entrypoint:\`、也没有命令行覆盖命令 ——`
            + ' 按 fail-closed 记红：读不到命令就无法判定它是否触达端到端入口。')
        }
      }
    }
    /**
     * 本节点里扫到的**内层 shell 文本**（`eval` / `trap` 的取值）—— `scanCarrierPaths` 收集、
     * 节点处理末尾统一入队（见 {@link NESTED_SHELL_STRICT}）。与节点绑定，所以每轮循环重建。
     */
    const nestedShellTexts = []
    /**
     * 一个 `python3 -m <模块>` 的模块名是不是**仓内**的（R17-X / R17A-04）。
     *
     * 判据只看顶层段：仓里有 `<段>.py`、`<段>/__init__.py` 或 `<段>/` 目录 ⇒ 它是本仓的模块，
     * 闭包必须能解析出载体（解析不出就红）；否则是标准库/第三方模块（`pip` / `json.tool` / …），
     * 跟随不了也不该按"缺失的仓内载体"判红。
     * @param moduleName - `-m` 的取值（`pkg.mod`）。
     * @param dirs - 这条命令可能的工作目录。
     * @returns `true` = 仓内模块。
     */
    const isRepoOwnedPythonModule = (moduleName, dirs) => {
      const top = String(moduleName).split('.')[0]
      if (top === '') return false
      const bases = dirs.length > 0 ? dirs : ['']
      for (const base of bases) {
        for (const candidate of [`${top}.py`, `${top}/__init__.py`, `${top}/`, top]) {
          const path = joinSurfacePath(base, candidate)
          if (path !== '' && existsOnce(path)) return true
        }
      }
      return false
    }
    /**
     * 仓内**载体文件**的读取（读不出/是目录 ⇒ `undefined`）。
     *
     * 闭包现在会跟随"仓内任何路径"，而 `options.exists()` 对目录也为真 —— 直接 `read` 会
     * 抛 `EISDIR` 把守卫自己打挂。读不出只表示"这条路径不是可跟随的载体"，不是红。
     * @param path - 仓库相对路径。
     * @returns 正文；读不出返回 `undefined`。
     */
    /**
     * 一个词**像不像仓内相对路径**（决定"命令位是路径形态"那条判据要不要开口）。
     *
     * `docs/*` / `refs/tags/v*` / `/app/picoaide-server` / `1 静态守卫（…）` 这些是**通配**、
     * **绝对路径**、**散文** —— 它们不是"仓内载体路径"，各自的判据在别处（`mentioning` 文本网、
     * token 网）。不加这一层会把真仓的 glob 与中文提示语读成"读不懂的载体"。
     * @param word - 命令位/参数位上的词。
     * @returns `true` = 形态上是仓内相对路径。
     */
    const isRepoRelativePathWord = word => {
      if (word === undefined || word === '') return false
      if (word.startsWith('/') || word.startsWith('~') || word.startsWith('-')) return false
      // **R22 FIX-14（E-01 形态 B）**：与 {@link normalizeRepoRelativeWord} 共用同一份形态口径
      // —— 修前这里是 `^[A-Za-z0-9_][A-Za-z0-9_./@+-]*$`，`.` 不在首字符类里，于是
      // `./gen.sh` 让整条"命令位是路径形态"的分支被跳过（既不被跟随、也不判生成物）。
      // 归一后 `./x` 与 `x` 同判；`. `/`..`/`../x` 的形态语义不变（见该函数头注释）。
      return normalizeRepoRelativeWord(word) !== undefined
    }
    const readCarrierCache = new Map()
    const readCarrier = path => {
      if (readCarrierCache.has(path)) return readCarrierCache.get(path)
      let text
      try {
        const value = options.read(path)
        text = typeof value === 'string' ? value : undefined
      } catch { text = undefined }
      readCarrierCache.set(path, text)
      return text
    }
    /**
     * 仓内路径 ⇒ 闭包的**节点类型**（决定用什么词法读它）。
     *
     * `undefined` = 读不出（目录/无权限）—— 调用方按"不是载体"处理。
     * 其余一律给一个类型：**仓内任何被跟踪文件出现在命令/参数位都要么跟随、要么登记**
     * （R16-W 的跟随面收口），所以"扩展名不认识"的默认值是 `data`（只过文本网），
     * 而不是"忽略"。
     * @param path - 仓库相对路径。
     * @returns `'makefile' | 'script' | 'data' | undefined`。
     */
    const carrierKindOf = path => {
      if (readCarrier(path) === undefined) return undefined
      // Makefile / `*.mk` **不在这里跟随**：它们由 `make -C/-f` 那条路读（`followMakefile`
      // 按"目标 → 配方"解析）。把整份 Makefile 当 shell 文本喂给命令词法会把 `e2e:` 读成
      // 一条命令（真仓实测：自证夹具立刻误红）。
      if (/(?:^|\/)(?:Makefile|makefile|GNUmakefile)$/u.test(path) || path.endsWith('.mk')) return undefined
      if (/\.(?:mjs|cjs|js|ts|sh|bash|py)$/u.test(path)) return 'script'
      return 'data'
    }
    /**
     * 一条**载体 token**（命令位或参数位上的路径）⇒ 仓内路径。
     *
     * 相对路径按这条命令可能的工作目录归一化（`../integration-tests/run-all.sh` 在
     * `server/` 的配方里）；绝对路径、`~` 开头、越出仓库根的 `..` 一律不算仓内载体。
     * @param token - 词。
     * @param dirs - 这条命令可能的工作目录。
     * @returns 仓库相对路径；解析不出返回 `undefined`。
     */
    const resolveCarrierPath = (token, dirs) => {
      if (token === undefined || token === '') return undefined
      if (token.includes('{{') || token.includes('$')) return undefined
      if (token.startsWith('/') || token.startsWith('~') || token.startsWith('-')) return undefined
      const candidates = []
      for (const dir of (dirs.length > 0 ? dirs : [''])) {
        candidates.push(dir === '' ? token : joinSurfacePath(dir, token))
      }
      candidates.push(token.replace(/^\.\//u, ''))
      for (const candidate of [...new Set(candidates)]) {
        if (candidate === '' || candidate.startsWith('/') || candidate.startsWith('~')) continue
        if (candidate.split('/').includes('..')) continue
        if (carrierKindOf(candidate) === undefined) continue
        return candidate
      }
      return undefined
    }
    /**
     * **自指脚本位**（R19A-04）的扫描上下文：`{ selfFile, resolve, executed }`。
     *
     * `selfFile` 只在"当前节点是仓内 shell 脚本"时才给 —— `$0`/`${BASH_SOURCE[0]}` 的取值
     * 就是那个文件；workflow `run:` 块（`.yml`）里的 `$0` 是运行器的临时脚本，不是仓内文件，
     * 所以那里**不给**上下文，`bash "$(dirname "$0")/x.sh"` 维持 fail-closed。
     * `resolve` 复用载体解析（存在 + 可读才算仓内候选）。
     *
     * **R20A-02**：`executed` 回答"这份正文是**被执行**还是被 **`source`**"——
     * 闭包节点自己知道它是怎么被到达的（`node.sourced`，由 {@link followCarrierToken}
     * 在 `source`/`.` 的参数位上打标）。被 source 时 `$0` 仍是**调用者**，按本文件目录求值
     * 会跟随诱饵文件（审计夹具 `s0-outer`：守卫绿而运行期真的执行了端到端入口）。
     * @param node - 闭包节点。
     * @returns 上下文；不适用时 `undefined`。
     */
    const selfScanContextFor = node => {
      if (typeof node.file !== 'string' || !/\.(?:sh|bash)$/u.test(node.file)) return undefined
      return {
        selfFile: node.file,
        resolve: candidate => resolveCarrierPath(candidate, ['']),
        executed: node.sourced !== true,
      }
    }
    /** **自指脚本位**的扫描上下文（R19A-04）：本节点是仓内 shell 脚本时才有。 */
    const selfContext = selfScanContextFor(node)
    /**
     * **跨文件 `import` 常量**的解析（R19A-02 ②）。
     *
     * ## 现场
     *
     * `import { ENTRY } from './paths.mjs'; spawnSync('bash', [ENTRY])` 是"路径常量按模块拆分"
     * 的常规写法；R18A-03 的展开只做**同文件**常量，于是这一族整条隐形（守卫 EXIT=0 而 CI
     * 真的执行端到端入口 —— R19A 探针 `js-cross-file` 实测）。
     *
     * ## 判据
     *
     * 说明符是**相对路径**（`./x.mjs` / `../a/b`）⇒ 按当前文件所在目录解析成仓内模块、读它的
     * 正文、在**它自己的绑定表**里求那个导出常量（`export const` / `export {x as y}` /
     * `export default` / 再 import，链深上限 {@link JS_IMPORT_MAX_DEPTH}）；求出的值回填成
     * 字面量表达式交给发起方的解析器。说明符不是相对路径（`node:child_process` / `zod`）⇒
     * 取值来自 `node_modules`，闭包结构上跟随不了，**不判**（认账的边界，不是"放行分支"）。
     * 相对路径但求不出来（模块读不到 / 没有这个导出常量 / 链太深）⇒ **fail-closed 记红**：
     * 这一族正是"命令文本不在本文件里"，读不懂就不许当成"这一层没有端到端"。
     */
    const jsImportCache = new Map()
    const JS_IMPORT_MAX_DEPTH = 4
    /** `import './x'` 的候选扩展名（含 TS 的 `./x.js` → `x.ts` 映射）。 */
    const JS_MODULE_EXTENSIONS = ['.mjs', '.cjs', '.js', '.ts', '.mts', '.cts', '.tsx', '.jsx']
    /**
     * 相对说明符 → **仓内模块路径**（解析不出返回 `undefined`）。
     * @param specifier - `import … from '<说明符>'` 的说明符。
     * @param fromFile - 发起 import 的仓内文件（仓库相对）。
     * @returns 仓内模块路径；仓外/外部包返回 `undefined`。
     */
    const resolveJsModulePath = (specifier, fromFile) => {
      if (typeof specifier !== 'string' || !/^\.{1,2}\//u.test(specifier)) return undefined
      const baseDir = typeof fromFile === 'string' && fromFile.includes('/')
        ? fromFile.slice(0, fromFile.lastIndexOf('/')) : ''
      if (baseDir === '' && specifier.startsWith('../')) return undefined
      const joined = joinSurfacePath(baseDir, specifier)
      if (joined === '' || joined.split('/').includes('..')) return undefined
      const candidates = [joined, ...JS_MODULE_EXTENSIONS.map(extension => `${joined}${extension}`),
        ...JS_MODULE_EXTENSIONS.map(extension => `${joined}/index${extension}`)]
      // TS 的 ESM 写法：`import './x.js'` 实际落在 `x.ts` 上。
      if (/\.js$/u.test(joined)) {
        const stem = joined.replace(/\.js$/u, '')
        candidates.push(...['.ts', '.tsx'].map(extension => `${stem}${extension}`))
      }
      for (const candidate of candidates) {
        if (carrierKindOf(candidate) === 'script') return candidate
      }
      return undefined
    }
    /**
     * 求一个仓内模块的导出常量（结果是 `{ exact, parts }`，见 {@link resolveJsExpression}）。
     * @param path - 模块的仓内路径。
     * @param name - 导出名（`default` 表示默认导出）。
     * @param source - 模块正文。
     * @param depth - import 链深度。
     * @returns `{ exact, parts }`；求不出返回 `undefined`。
     */
    const jsModuleConstantValue = (path, name, source, depth) => {
      const bindings = jsImportBindings(
        source,
        // 链式 import（模块自己的 import / `export { X } from './y.mjs'`）：递归下去，带上深度。
        (specifier, imported) => jsModuleExport(specifier, imported, path, depth + 1),
        () => {},
      )
      if (name === 'default') {
        const match = /(?:^|[\s;{}])export\s+default\s+/u.exec(source)
        if (match === null) return undefined
        const expression = readJsExpressionAt(source, match.index + match[0].length)
        if (expression === undefined) return undefined
        const resolved = resolveJsExpression(expression, bindings)
        return expression.trim().startsWith('{') ? { ...resolved, expression } : resolved
      }
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
      const declared = new RegExp(`(?:^|[\\s;{}])export\\s+(?:const|let|var)\\s+${escaped}\\s*=`, 'u')
      if (declared.test(source)) {
        const binding = bindings.get(name)
        if (binding !== undefined && !binding.ambiguous) {
          const resolved = resolveJsExpression(binding.expression, bindings)
          // **对象字面量直通**：`export const PATHS = { entry: '…' }` 的取值要用**表达式原文**
          // 回填，发起方的成员访问（`PATHS.entry`）才能在常量表里查到那一条（R19A-02 ②）。
          return binding.expression.trim().startsWith('{')
            ? { ...resolved, expression: binding.expression }
            : resolved
        }
      }
      // `export { local as name }` / `export { name }`，以及 `export { name } from './y.mjs'`
      // （后者把 `local` 当"再 import 的名字"递归求值）。
      for (const clause of source.matchAll(/export\s*\{([^}]*)\}(?:\s*from\s*(['"])([^'"]+)\2)?/gu)) {
        const fromSpecifier = clause[3]
        for (const entry of clause[1].split(',')) {
          const segments = entry.split(/\s+as\s+/u).map(segment => segment.trim()).filter(segment => segment !== '')
          if (segments.length === 0 || segments[segments.length - 1] !== name) continue
          const local = segments[0]
          if (fromSpecifier !== undefined) {
            const value = jsModuleExport(fromSpecifier, local, path, depth + 1)
            if (value === undefined || value.expression === undefined) return undefined
            return { exact: undefined, parts: [JSON.parse(value.expression)].flat().map(String) }
          }
          const localPattern = new RegExp(
            `(?:^|[\\s;{}])(?:const|let|var)\\s+${local.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\s*=`, 'u')
          if (!localPattern.test(source)) return undefined
          const binding = bindings.get(local)
          if (binding === undefined || binding.ambiguous) return undefined
          return resolveJsExpression(binding.expression, bindings)
        }
      }
      // **CJS 导出形态**（R20A-03 ①的同族）：`exports.ENTRY = <表达式>` /
      // `module.exports.ENTRY = <表达式>` / `module.exports = { ENTRY: <表达式> }`。
      // 修前只认 ESM 的 `export` 形态 ⇒ `const { ENTRY } = require('./paths.cjs')` 里的
      // 字面量从不进任何一张网（模块从不被读）。三种形态都按"读那个赋值右侧的表达式"处理，
      // 求值口径与 ESM 分支**同一份**（{@link resolveJsExpression}）。
      {
        const assigned = new RegExp(`(?:^|[\\s;{}])(?:module\\.)?exports\\.${escaped}\\s*=`, 'u').exec(source)
        if (assigned !== null) {
          const expression = readJsExpressionAt(source, assigned.index + assigned[0].length)
          if (expression !== undefined) return resolveJsExpression(expression, bindings)
        }
        const objectExport = /(?:^|[\s;{}])module\.exports\s*=\s*\{/u.exec(source)
        if (objectExport !== null) {
          const expression = readJsExpressionAt(source, objectExport.index + objectExport[0].length - 1)
          const text = expression === undefined ? '' : expression.trim()
          if (text.startsWith('{') && balancedJsClose(text, 0) === text.length - 1) {
            for (const entry of splitJsTopLevel(text.slice(1, -1), ',')) {
              const separator = entry.indexOf(':')
              if (separator < 0) continue
              const key = jsStringLiteralValue(entry.slice(0, separator).trim()) ?? entry.slice(0, separator).trim()
              if (key !== name) continue
              return resolveJsExpression(entry.slice(separator + 1), bindings)
            }
          }
        }
      }
      return undefined
    }
    /**
     * import 说明符 + 导出名 → **可回填的字面量表达式**。
     *
     * 为什么回填成 `JSON.stringify(值)`：求出来的值必须放回**发起方**的解析器（那里的
     * `exact`/`parts` 判据是既有口径），而"一个字符串 / 一个字符串数组 / 一组片段"恰好能被
     * `JSON.stringify` 序列化成合法的 JS 字面量。只有片段（解析不出精确值）时序列化**片段数组**
     * —— 消费方只把这些片段当候选字面量集合用，口径因此一致（不会因为跨文件凭空多出候选）。
     * @param specifier - import 说明符。
     * @param imported - 导出名。
     * @param fromFile - 发起 import 的仓内文件。
     * @param depth - import 链深度。
     * @returns `{ expression }` / `{ unreadable }` / `undefined`（外部命名空间）。
     */
    const jsModuleExport = (specifier, imported, fromFile, depth) => {
      if (depth > JS_IMPORT_MAX_DEPTH) return { unreadable: `跨文件 import 链超过 ${JS_IMPORT_MAX_DEPTH} 层` }
      const path = resolveJsModulePath(specifier, fromFile)
      if (path === undefined) return undefined
      const key = `${path}\u0000${imported}`
      if (jsImportCache.has(key)) return jsImportCache.get(key)
      const source = readCarrier(path)
      let value
      if (source === undefined) {
        value = { unreadable: `仓内模块 ${path} 读不出来` }
      } else {
        const found = jsModuleConstantValue(path, imported, source, depth)
        if (found === undefined) {
          value = { unreadable: `${path} 里没有可静态求值的导出常量 \`${imported}\`` }
        } else if (found.expression === undefined
          && found.exact === undefined && (found.parts ?? []).length === 0) {
          // **R20A-03 ②**：模块找到了、导出**也存在**，但取值静态上求不出来
          // （典型：`export const ENTRY = process.env.CI ? 'integration-tests/run-all.sh'
          // : 'scripts/noop.sh'` —— 条件表达式在常量传播里既不是精确值、也不产出任何片段）。
          // 修前这里回填成 `JSON.stringify([])` = `'[]'` ⇒ 消费方**一个候选都拿不到，而且
          // 既不判红也不跟随** —— 与文档口径（"同仓相对 import 读不懂即 fail-closed"）不符，
          // 也与本守卫的既有教义（"读不懂 ≠ 这一层没有端到端"）不符。现在按读不懂记红。
          value = {
            unreadable: `${path} 的导出 \`${imported}\` **存在但取值求不出来**`
              + `（既没有精确值、也没有任何字面量片段）—— 条件表达式 / 运行期取值不算静态常量；`
              + '请把它写成字面量、模板字面量、`join|resolve` 拼接、`+` 拼接或对象常量表',
          }
        } else {
          value = { expression: found.expression ?? JSON.stringify(found.exact ?? found.parts) }
        }
      }
      jsImportCache.set(key, value)
      return value
    }
    /**
     * 本节点的 JS/TS **跨文件 import 上下文**（供 {@link scriptExecutionLiterals} 用）。
     * @param source - 闭包节点。
     * @returns `{ resolveImport, report }`。
     */
    const jsImportContextFor = source => ({
      resolveImport: (specifier, imported) => jsModuleExport(specifier, imported, source.file, 0),
      report: detail => reportClosureProblem({
        kind: 'js-import-unreadable',
        word: String(source.file ?? ''),
        raw: detail,
        message: `跨文件 import 的常量读不懂（${source.file}）：${detail} —— `
          + '被 import 的**仓内**模块里那个导出常量必须在静态上可求值（字面量 / 模板字面量 / '
          + '`join|resolve` 拼接 / `+` 拼接 / 数组与下标 / 对象常量表 / 再 import）；'
          + '闭包读不懂它就无法判定"这次执行跑的是什么"，按 fail-closed 记红（R19A-02 的收口②）。'
          + '请把该导出写成上面这些形态，或把要执行的路径直接写进调用实参。',
      }),
    })
    /**
     * 跟随一条载体 token（命中即入队，节点类型由 `carrierKindOf` 决定）。
     * @param token - 命令位/参数位上的词。
     * @param dirs - 这条命令可能的工作目录。
     * @param options - `{ sourced }`：这条载体是 `source`/`.` 的目标（**R20A-02**）——
     *   被 source 的脚本文本里 `$0` 仍是调用者，节点必须记住这一点（`$0` 族不求值）。
     * @returns `true` = 真的跟随了一个仓内载体。
     */
    const followCarrierToken = (token, dirs, options = {}) => {
      const resolved = resolveCarrierPath(token, dirs)
      if (resolved === undefined) return false
      const kind = carrierKindOf(resolved)
      const sourced = options.sourced === true
      enqueue({
        // `source` 与"执行"是两种上下文（词数组求值不同）⇒ 同一个文件的两份节点必须分开
        // （否则先入队的那个上下文会把另一个吃掉，R20A-02 的收口会被"enqueue 顺序"左右）。
        key: sourced ? `${resolved}\u0000source` : resolved,
        file: resolved, kind, text: readCarrier(resolved), sourced,
        dir: resolved.includes('/') ? resolved.slice(0, resolved.lastIndexOf('/')) : '',
        via: [...node.via, sourced ? `source ${resolved}` : resolved], hops: node.hops + 1,
      })
      return true
    }
    /**
     * **"这段文本写过哪些仓内路径"**（R22 FIX-14 / E-01 形态 A 的唯一实现；
     * **R23 FIX-22** 收口形态 A-2 与残余写面）。
     *
     * ## 现场（第二十二轮 V7 泳道 + 第二十三轮 W4 泳道）
     *
     * 脚本位判据的**唯一事实前提**是"该路径在检查期是否存在"，于是"先让目标路径在检查期
     * 就存在（良性内容），运行期用不透明载荷覆写再执行"整类绕过它，而且**不需要新增文件、
     * 不需要新增登记项**：
     *
     * ```yaml
     * - run: |
     *     P='<base64 的 "bash integration-tests/run-all.sh">'
     *     printf "%s" "$P" | base64 -d > scripts/ci-brand-mask.sh   # 覆写**仓内已跟踪**脚本
     *     bash scripts/ci-brand-mask.sh                            # 闭包跟随到的是仓里那份良性文本
     * ```
     *
     * 判据不能只问"检查期在不在"，还要问"**它在执行之前是否被写过**"。这里把写目标
     * （重定向 `>`/`>>`/`>|`/`&>`、`tee`/`cp`/`mv`/`install`/`rsync`/`ln` 的最后一个非旗标实参）
     * 解析成**仓内相对路径**；命令位/脚本位解析到这些路径时另记一条红
     * （`reportRuntimeWrittenScript`，与"路径不存在"共用 `CI_SURFACE_GENERATED_SCRIPT_ACK`
     * 登记表与死条目对账）。
     *
     * ## 三条收口（第二十三轮 W4 实测的三个绕过）
     *
     * ① **W4-02（尾随重定向）**：写命令词那一支在 {@link stripWriteRedirections} 之后的文本上
     *    取词 —— 修前 `tee -a X >/dev/null` 取到 `/dev/null`。
     * ② **W4-09（常量传播出来的写目标）**：重定向目标那一支走
     *    {@link tagWriteRedirections} + `shellCommandWordListsFor()`（与命令位同一份常量传播）——
     *    修前 `T=scripts/x.sh; … > "$T"` 一遇 `$` 就 `return`。
     * ③ **W4-01（跨 step）**：作用域由调用方给（{@link workflowJobRunBlocks} 按 job 累积），
     *    本函数只回答"**这一段文本**写过哪些路径"。
     *
     * ## 第二十四轮 X3 泳道的三处收口（R24 FIX-26 / X3-01）
     *
     * ① **解释器内联脚本**（`python3 -c` / `node -e` / `perl -e`）：两条取词路径都是 shell 语法 ⇒
     *    `Path('scripts/x.sh').write_bytes(…)` 整族隐形。现在内层语言源码也过一遍
     *    {@link inlineScriptWriteTargets}（只认"第一实参是字面量"的写调用）。
     * ② **`$GITHUB_ENV` 传过来的写目标**：`note()` 一遇 `$` 就 `return` ⇒ 跨 step 的
     *    `echo "V7T=scripts/x.sh" >> "$GITHUB_ENV"` + `> "$V7T"` 整条不可见。现在 `note()`
     *    先过 {@link expandExportedEnvWord}（作用域由调用方经 `scope.carriedEnv` 给）。
     * ④ **`N<>` 读写打开**（`exec 3<>scripts/x`）：见 {@link WRITE_REDIRECTION}。
     *
     * 边界（认账）：`sed -i` / `git checkout <ref> -- <路径>` / `dd of=<路径>` 这类等价
     * 改写面仍未建模（要扩面就把命令词加进 {@link WRITE_COMMAND_WORDS}，或再补一条形态判据）；
     * 解释器写面只覆盖**字面量**目标（路径拼出来的仍看不见）；
     * 运行期生成 + 不透明编码仍是固有边界（见通过行的 ⑥）。
     * @param source - 一段 shell 文本（已去 here-doc 正文）。
     * @param dirs - 这条命令可能的工作目录。
     * @param context - 自指脚本位的扫描上下文（`undefined` = 不开）。
     * @param strict - 是否开逐词登记（影响 `unwrapCommandWords` 的包装链展开）。
     * @param env - **job 作用域的 `$GITHUB_ENV`/`$GITHUB_OUTPUT` 导出表**（`Map<名字, 值>`，可省）。
     * @returns 被写过的仓内相对路径集合。
     */
    const runtimeWrittenCarriers = (source, dirs, context, strict = true, env = undefined) => {
      const written = new Set()
      const note = word => {
        if (typeof word !== 'string' || word === '') return
        const unquoted = word.replace(/^["']|["']$/gu, '')
        if (unquoted === '' || unquoted.includes('{{')) return
        // 根变量前缀（`$GITHUB_WORKSPACE/…` / `${PWD}/…`）剥掉后仍是仓内相对路径 ——
        // 与脚本位判据（`stripRootVariablePrefix`）同一口径，否则 `> $GITHUB_WORKSPACE/x.sh`
        // 与 `> x.sh` 会被当成两种东西（V7 的 `$GITHUB_WORKSPACE/…` 形态）。
        // **R24 FIX-26 / X3-01②**：`$` 先由 job 作用域的导出表展开一次（修前一律 return ⇒
        // `$GITHUB_ENV` 递过来的写目标整条不可见）；展开不出仍按原样 fail-closed（return）。
        const preExpanded = expandExportedEnvWord(unquoted, env)
        if (preExpanded === undefined) return
        const cleaned = stripRootVariablePrefix(preExpanded) ?? preExpanded
        if (cleaned === '' || cleaned.includes('$')) return
        const resolved = resolveCarrierPath(cleaned, dirs) ?? resolveCarrierPath(cleaned, [''])
        if (resolved !== undefined) written.add(resolved)
      }
      const text = String(source)
      // ① 重定向目标（**含常量传播出来的目标**，R23 FIX-22 / W4-09）。
      const tagged = shellCommandWordListsFor(tagWriteRedirections(text), context)
      for (let index = 0; index < tagged.length; index += 1) {
        const words = tagged[index]
        for (let cursor = 0; cursor < words.length; cursor += 1) {
          if (words[cursor] !== WRITE_REDIRECT_SENTINEL) continue
          const sameCommand = words[cursor + 1]
          // `&>` 会被词法器切成两条命令（`&` 是分隔符）⇒ 标记词落在上一条的末尾时，
          // 目标在**下一条**的首位。
          note(sameCommand !== undefined && sameCommand !== WRITE_REDIRECT_SENTINEL
            ? sameCommand
            : tagged[index + 1]?.[0])
        }
      }
      // 文本面兜底：词法器覆盖不到的正文（命令替换内部等）由正则那一路补。
      for (const match of text.matchAll(WRITE_REDIRECT_TARGET)) note(match[1])
      // ② 写命令词：**在剥掉重定向的文本上**取"最后一个非旗标、非赋值词"
      //    （`cp 载荷 gen.sh` / `tee -a gen.sh` / `install -m 755 x gen.sh`）；取不出就不猜。
      //    **R24 FIX-26 / X3-01①**：同一次取词里把**内层语言源码**（`python3 -c` / `node -e`）
      //    的写操作也读出来 —— 修前这一支只把字面量当 token 跟随，不认"写"。
      for (const words of shellCommandWordListsFor(stripWriteRedirections(text), context)) {
        const chain = unwrapCommandWords(words, strict)
        for (const nested of chain.nestedTexts) {
          if (nested.language === 'shell') continue
          for (const target of inlineScriptWriteTargets(nested.text)) note(target)
        }
        for (const head of chain.heads) {
          if (!WRITE_COMMAND_WORDS.has(head[0] ?? '')) continue
          const target = [...head].reverse().find(word => word !== ''
            && !word.startsWith('-') && !/^[A-Za-z_][A-Za-z0-9_]*=/u.test(word))
          if (target !== undefined) note(target)
        }
      }
      return written
    }
    /**
     * 一段 shell 文本 → 它**调用的仓内脚本载体**（`bash x.sh` / `source x.sh` / `node x.mjs` /
     * `python3 x.py` 的脚本位，能解析成仓内相对路径的那些）。去重，保持出现顺序。
     *
     * 与 `scanCarrierPaths` 的脚本位取词**同一份实现**（`shellScriptWordIndex` + 同一个
     * `COMMAND_WRAPPER_SPECS.scriptPositional` 判据）—— 两处各写一份必然漂移。
     * @param text - 一段 shell 文本。
     * @param dirs - 这条命令可能的工作目录。
     * @returns 仓内相对路径（去重）。
     */
    const carrierScriptTargets = (text, dirs) => {
      const found = new Set()
      for (const words of shellCommandWordListsFor(text, undefined)) {
        for (const head of unwrapCommandWords(words, true).heads) {
          const command = head[0] ?? ''
          const isShellHost = COMMAND_SHELL_WORDS.has(command) || command === 'source' || command === '.'
          const isInterpreterHost = COMMAND_WRAPPER_SPECS.get(command)?.scriptPositional === true
          if (!isShellHost && !isInterpreterHost) continue
          const host = shellScriptWordIndex(head, 0)
          if (host === null || host.commandText !== null || host.scriptIndex < 0) continue
          const word = head[host.scriptIndex]
          if (word === undefined || word.includes('$') || word.includes('{{')) continue
          const resolved = resolveCarrierPath(word, dirs) ?? resolveCarrierPath(word, [''])
          if (resolved !== undefined) found.add(resolved)
        }
      }
      return [...found]
    }
    /**
     * **这一段文本（连同它调用的仓内载体）写过哪些仓内路径**（R24 FIX-26 / X3-01③）。
     *
     * ## 现场
     *
     * `carriedWrites` 只在**当前 yaml 节点**的 job 分组内累积（R23 FIX-22 把作用域从
     * "一段 `run:` 块"扩到了"整个 job"），但**被跟随的脚本与本地复合 action 是别的节点** ——
     * 在那里面发生的写不会回灌到 job 作用域。于是"把写藏进一层包装"就整族隐形：
     *
     * ```yaml
     * - run: bash scripts/v7write.sh          # v7write.sh 里写 scripts/ci-brand-mask.sh
     * - run: bash scripts/ci-brand-mask.sh    # ⇒ 判据看不见"被写过"
     * ```
     *
     * 同一形态还有本地复合 action（`uses: ./.github/actions/x`）——它的 `steps[].run` 块
     * 跑在**同一个工作树**上，写同样生效。
     *
     * ## 判据
     *
     * 在 {@link runtimeWrittenCarriers} 之外再**急切**跟随一层：命令位/脚本位指向的**仓内**
     * 载体（shell 脚本 / 解释器脚本）读它的正文并把里面的写并进来；`uses: ./x` 读
     * `x/action.yml` 的 `run:` 块同理。深度上限 {@link WRITE_CARRIER_FOLLOW_MAX_HOPS} +
     * `seen` 去重（自引用脚本不会无限递归）。读不到 / 仓内不存在 / 变量拼出来的路径一律
     * **不猜**（那些形态由 `scanCarrierPaths` 的载体跟随与 fail-closed 判据负责）。
     * @param text - 一段 shell / yaml 文本。
     * @param dirs - 这条命令可能的工作目录。
     * @param context - 自指脚本位的扫描上下文（`undefined` = 不开）。
     * @param depth - 当前跟随深度（调用方省略）。
     * @param seen - 已经读过的载体路径（防环，调用方省略）。
     * @param env - job 作用域的 `$GITHUB_ENV` 导出表（可省）。
     * @returns 被写过的仓内相对路径集合。
     */
    const eagerWrittenCarriers = (text, dirs, context, depth = 0, seen = new Set(), env = undefined) => {
      const out = new Set(runtimeWrittenCarriers(text, dirs, context, true, env))
      if (depth >= WRITE_CARRIER_FOLLOW_MAX_HOPS) return out
      /** 读一份仓内载体（读不到 ⇒ `undefined`，绝不猜）。 */
      const readCarrier = path => {
        try {
          if (!options.exists(path)) return undefined
          const body = options.read(path)
          return typeof body === 'string' ? body : undefined
        } catch {
          return undefined
        }
      }
      for (const carrier of carrierScriptTargets(text, dirs)) {
        if (seen.has(carrier)) continue
        seen.add(carrier)
        const body = readCarrier(carrier)
        if (body === undefined) continue
        const nestedDirs = [carrier.includes('/') ? carrier.slice(0, carrier.lastIndexOf('/')) : '']
        for (const written of eagerWrittenCarriers(body, nestedDirs, undefined, depth + 1, seen, env)) {
          out.add(written)
        }
      }
      for (const target of localCompositeActionDirs(text)) {
        for (const candidate of [`${target}/action.yml`, `${target}/action.yaml`]) {
          if (seen.has(candidate)) break
          const body = readCarrier(candidate)
          if (body === undefined) continue
          seen.add(candidate)
          for (const block of workflowRunBlocks(body)) {
            for (const written of eagerWrittenCarriers(block, [target], undefined, depth + 1, seen, env)) {
              out.add(written)
            }
          }
          break
        }
      }
      return out
    }
    // R23 FIX-22 / W4-06：把当前实现挂给收尾的判决级见证（见 `writeTargetsImpl` 的注释）。
    writeTargetsImpl = (source, env) => runtimeWrittenCarriers(source, [''], undefined, true, env)
    /**
     * 一个**本地复合 action**（`uses: ./.github/actions/x` → 目录 `x`）写过的仓内路径
     * （R24 FIX-26 / X3-01③）。
     *
     * 读 `action.yml` / `action.yaml` 的每个 `run:` 块，交给 {@link eagerWrittenCarriers}
     * （它继续跟随块里调用的包装脚本 / 嵌套复合 action）。文件不存在或读不出来 ⇒ 空集合
     * ——"读不到"不是判据面（本地 action 不存在时 `uses:` 本身由别的判据负责），这里不猜。
     * @param target - action 目录（仓内相对，已去 `./`）。
     * @param env - job 作用域的 `$GITHUB_ENV` 导出表。
     * @returns 仓内相对路径集合。
     */
    const compositeActionWrittenCarriers = (target, env) => {
      const out = new Set()
      for (const candidate of [`${target}/action.yml`, `${target}/action.yaml`]) {
        let body
        try {
          body = options.exists(candidate) ? options.read(candidate) : undefined
        } catch {
          body = undefined
        }
        if (typeof body !== 'string') continue
        for (const block of workflowRunBlocks(body)) {
          for (const written of eagerWrittenCarriers(block, [target], undefined, 1, new Set(), env)) {
            out.add(written)
          }
        }
        break
      }
      return out
    }
    /**
     * **命令位 + 参数位的载体跟随**（R16-W 语义反转里"跟随"的那一半）。
     *
     * 三层判据：
     *   ① 包装链走到的**命令位**：登记制（{@link CI_COMMAND_REGISTRY}，未登记即红）已在
     *      {@link unwrapCommandWords} 里判过；这里补"命令位是**路径形态**时跟不跟得上"——
     *      对不上 ⇒ `carrier-command-missing`（红）；
     *   ② **参数位**上的仓内路径（`node x.mjs` / `bash y.sh` / `python3 -m pkg` /
     *      `docker compose -f z.yml`）逐条跟随，节点类型按扩展名分派
     *      （R16A-09/10：修前这些位置的载体整体落在 5 个目录前缀之外）；
     *   ③ **参数位是变量/通配拼出来的端到端路径**（`"$DIR/integration-tests/run-all.sh"`）
     *      ⇒ 红：闭包判不了它指向哪（R16A-10 的同族）。
     * 内层**语言源码**（`node -e '<js>'` / `python3 -c '<py>'`）按其语言的抽取器读出
     * 执行调用的字面量再回到 ②（R16A-10：修前 `-e` 的取值根本不进任何一张网）。
     * @param raw - 一段 shell 文本。
     * @param dirs - 这条命令可能的工作目录。
     * @param strict - 是否开逐词登记（入口形态开、被跟随的脚本正文关）。
     * @param scope - **跨 step 的写面作用域**（`{ carriedWrites, carriedJob, carriedEnv }`）：同一 job
     *   的 step 顺序共享同一个 `carriedWrites`（`Map<路径, job>`）与 `carriedEnv`
     *   （`Map<名字, 值>`，来自 `$GITHUB_ENV`/`$GITHUB_OUTPUT`），见 {@link workflowJobRunBlocks}
     *   与 {@link runtimeWrittenCarriers}。
     */
    const scanCarrierPaths = (raw, dirs, strict = true, scope = undefined) => {
      const carriedWrites = scope?.carriedWrites instanceof Map ? scope.carriedWrites : undefined
      const carriedJob = scope?.carriedJob
      /** **job 作用域的 `$GITHUB_ENV` 导出表**（R24 FIX-26 / X3-01②）。 */
      const carriedEnv = scope?.carriedEnv instanceof Map ? scope.carriedEnv : undefined
      // **自指脚本位**（`bash "$(dirname "$0")/x.sh"`，R19A-04）：被跟随的仓内 shell 脚本
      // 正文里，`$0`/`${BASH_SOURCE[0]}` 的取值就是**本节点自己**（`node.file`），
      // 于是 `$(dirname …)` 可以在闭包里求值 —— 词法阶段把它换成**仓内候选路径**，
      // 让下面的载体跟随照常工作。求值不出（候选不存在 / 越出仓库根）⇒ 词原样保留，
      // 仍走词法阶段的 fail-closed（这条不是"放行分支"）。
      const context = selfScanContextFor(node)
      const record = (kind, word, rest) => reportClosureProblem({
        kind, word, raw: `${word} ${rest}`.trim(),
        message: `命令/参数位上的载体 \`${word}\` 读不懂（${`${word} ${rest}`.trim()}）——`
          + ' 闭包只跟随**仓内存在**的载体，或逐词登记过的可执行名；'
          + '请把它写成闭包能解析的字面量，或把这一处登记进 `CI_COMMAND_REGISTRY`。',
      })
      /**
       * 这一位是不是"**字面的仓内相对路径**"——只有它才允许按"仓内不存在 ⇒ 运行期生成物"判红。
       *
       * 变量 / GitHub 表达式 / 根变量前缀 / 通配 / 绝对路径都不在这里判：它们的 fail-closed
       * 在词法阶段（`shell-argument-unreadable`）或命令位形态判据里，别在这里重复计红
       * （重复计红会让同一条命令产生两条诊断，也会让登记表的死条目对账算不平）。
       * @param word - 命令位/脚本位上的词（原样，可带一个前导 `./`）。
       * @returns `true` = 字面、仓内相对、形态读得懂。
       */
      const isLiteralRepoRelativeScript = word => {
        if (word === undefined) return false
        const cleaned = word.replace(/^\.\//u, '')
        if (cleaned === '' || cleaned.includes('$') || cleaned.includes('{{')) return false
        if (!isRepoRelativePathWord(cleaned)) return false
        if (stripRootVariablePrefix(cleaned) !== undefined) return false
        if (SHELL_GLOB_PATTERN.test(cleaned)) return false
        return true
      }
      /**
       * **命令位 / 脚本位指向"检查期仓内不存在"的字面路径**的**唯一**判据（**R21 fix-6 / E-01**）。
       *
       * 三个站点共用它（命令位的裸命令与 `./x.sh`、解释器 / `source` 的脚本位）：
       *   · 修前这条判据在**两个**站点上带 `includes('/')` 前置条件（① 命令位记红、
       *     ②b 脚本位记红），而 `:6046` 的诊断文案点名要拦的反例正是
       *     `base64 -d payload.b64 > gen.sh; bash gen.sh`（**不带** `/`）—— 代码与自述反例相反；
       *   · 实测三种"裸文件名"形态（`bash gen.sh` / `source gen.sh` / `python3 gen.py`，
       *     载荷 base64 不透明、零 token）修前**全部 EXIT=0**，而 tripwire 证明运行期真的
       *     执行了 `integration-tests/run-all.sh`；同一夹具只把目标改成 `scripts/gen.sh`
       *     就 EXIT=1（对照）。
       *   ⇒ **裸文件名与带目录的写法是同一个语义**（命令位指向一个检查期不存在的程序），
       *     判据不许按"路径里有没有 `/`"分叉；合法出路是逐处登记
       *     `CI_SURFACE_GENERATED_SCRIPT_ACK`（写明由谁生成、哪一步生成；死条目也红）。
       * @param word - 命令位/脚本位上的词（原样）。
       * @param raw - 诊断里的那条命令原文。
       * @param where - `命令位` / `脚本位` / `\`source\` 的脚本位`（诊断措辞）。
       */
      const reportGeneratedScript = (word, raw, where) => reportClosureProblem({
        kind: 'missing-script-carrier', word, raw,
        message: `${where}指向**仓内不存在的路径** \`${word}\`（${raw}）—— `
          + '这一位是"要执行的程序"，闭包读不到它的正文就等于这一层看不见；'
          + '而"检查期不存在"正是**运行期生成物**的形态'
          + '（`base64 -d payload.b64 > gen.sh; bash gen.sh`：修前它既不跟随、也不判红，'
          + '守卫 EXIT=0 且凭据行照旧写 `static-only`，R20A-05 的现场）。'
          + '脚本位是字面路径 ⇒ 这里**不许**用"路径不存在就放过"：'
          + '要么把它写成仓内**真实存在**的脚本（把生成物改成仓库里的包装脚本），'
          + '要么把这一处逐字登记进 `CI_SURFACE_GENERATED_SCRIPT_ACK`'
          + '（写明由谁生成、哪一步生成 —— "先构建再执行"只能逐处认账，登记项死了也红）。'
          + '**裸文件名（`gen.sh`）与带目录的写法（`scripts/gen.sh`）同判**（R21 fix-6 / E-01）。',
      })
      /** 命令位 / 脚本位解析到"**运行期被改写过的**"路径时的唯一诊断（E-01 形态 A / A-2）。 */
      const reportRuntimeWrittenScript = (word, rawCommand, where, writtenWhere) => reportClosureProblem({
        kind: 'missing-script-carrier', word, raw: rawCommand,
        message: `${where}指向**运行期被改写过的**仓内路径 \`${word}\`（${rawCommand}）—— `
          + `这一位之前（${writtenWhere}）已经有 \`>\`/\`>>\`/\`tee\`/\`cp\` … 把它`
          + '改写成了运行期载荷，而闭包跟随到的是仓库里那一份（通常完全良性）。'
          + '**检查期存在**不等于**运行期是这份内容**。'
          + '修前这条判据只问"该路径在检查期是否存在"（R21 fix-6 / E-01），于是'
          + '`base64 -d > <仓内已存在路径>; bash <该路径>` 这一族两张网全绿 ——'
          + '**不需要新增文件、不需要新增登记项**（第二十二轮 V7 泳道实测，'
          + '运行期真的执行了端到端入口）。'
          + '要么把它写成仓内**真实存在且不被这段脚本改写**的脚本，要么把这一处逐字登记进'
          + ' `CI_SURFACE_GENERATED_SCRIPT_ACK`（写明由谁生成、哪一步生成 —— 死条目也红）。',
      })
      // **R23 FIX-22 / W4-01**：写目标的作用域是**整个 job**，不再是"这一段 `run:` 块"。
      // 同一个 job 的所有 step 跑在**同一个工作树**上（step① 写、step② 执行是 CI 里最普通的
      // 写法），所以"被写过的路径"必须按 job 内 step 顺序累积；`$GITHUB_ENV` 那条 fail-closed
      // 只覆盖**值**，不覆盖**文件写**（`bash scripts/x.sh` 的脚本位是字面路径，不需要任何变量）。
      //
      // **R24 FIX-26 / X3-01①③**：改用 {@link eagerWrittenCarriers} —— 它在本段文本之外**急切**
      // 跟随本段调用的仓内载体（包装脚本 / 本地复合 action），把那里的写也并进来。修前
      // "把写藏进一层包装"整族隐形（`bash scripts/v7write.sh` + `bash scripts/ci-brand-mask.sh`）。
      const localWrites = eagerWrittenCarriers(raw, dirs, context, 0, new Set(), carriedEnv)
      const writtenCarriers = carriedWrites === undefined
        ? localWrites
        : new Set([...carriedWrites.keys(), ...localWrites])
      const writtenWhere = resolved => (localWrites.has(resolved)
        ? '同一段脚本里'
        : `同一 job 的**更早步骤**里（job \`${carriedJob ?? '(未知)'}\`，step 顺序）`)
      if (carriedWrites !== undefined) {
        for (const carrier of localWrites) {
          if (!carriedWrites.has(carrier)) carriedWrites.set(carrier, carriedJob)
        }
      }
      for (const words of shellCommandWordListsFor(raw, context)) {
        const chain = unwrapCommandWords(words, strict)
        for (const word of chain.commandWords) commandWords.add(word)
        for (const problem of chain.problems) reportClosureProblem(problem)
        // `python3 -m pkg.mod`：模块名换算成仓内 `.py` 路径再跟随（R16A-09）。
        //
        // **R17-X（R17A-04）**：解析不出载体时先问"这个模块是不是**仓内**的"——
        // 顶层段在仓里存在（`<段>.py` / `<段>/__init__.py` / `<段>/`）⇒ 必须解析出来，否则红；
        // 不存在 ⇒ 它是标准库/第三方模块（`pip` / `json.tool` / `pytest` / `http.server`），
        // 闭包结构上跟随不了它，也不该把它当端到端载体（修前一律红 = 下一个正当用法被误伤）。
        for (const moduleName of chain.modules) {
          const base = moduleName.replace(/\./gu, '/')
          const resolved = resolveCarrierPath(`${base}.py`, dirs)
            ?? resolveCarrierPath(`${base}/__main__.py`, dirs)
          if (resolved === undefined) {
            if (isRepoOwnedPythonModule(moduleName, dirs)) record('carrier-module-missing', `-m ${moduleName}`, words.join(' '))
            continue
          }
          followCarrierToken(resolved, dirs)
        }
        // 内层**语言源码**：按语言选抽取器，再把字面量当 token 跟随。
        for (const nested of chain.nestedTexts) {
          if (nested.language === 'shell') {
            // **进程替换的内层子命令**（R19A-01）：流/参数位的 `<(...)` 输出是数据，
            // 但那个子命令**真的会执行** ⇒ 不管严格面都入队（`done < <(make -f evil.mk e2e)`
            // 的目标体因此照旧被读到）。深度由闭包的 hop 上限兜（每层 +1，超限 fail-loud）。
            if (nested.procsub === true) {
              nestedShellTexts.push({
                text: nested.text, flag: nested.flag, node: NESTED_SHELL_LENIENT,
                index: nestedShellTexts.length, dirs,
              })
              continue
            }
            // **内层 shell 文本**（`eval '<命令文本>'` / `trap '<命令文本>' <信号>`，R17A-02）：
            // 按 `node` 声明的严格度入队成真正的闭包节点 —— 光靠 `makeInvocations` 的递归
            // 只能看见 `make`，`eval 'bash integration-tests/run-all.sh'` 会整族漏掉。
            if (strict && nested.node !== undefined) {
              nestedShellTexts.push({
                text: nested.text, flag: nested.flag, node: nested.node,
                index: nestedShellTexts.length, dirs,
              })
            }
            continue
          }
          const literals = nested.language === 'py'
            ? pythonExecArgumentLiterals(nested.text)
            : jsExecArgumentLiterals(nested.text, jsImportContextFor(node))
          for (const literal of literals) {
            for (const token of shellCommandTokens(literal)) followCarrierToken(token, dirs)
            if (E2E_END_TO_END_PATTERN.test(literal)) reached.set(node.file, node.via)
          }
        }
        for (const head of chain.heads) {
          const command = head[0] ?? ''
          // ① 命令位是路径形态：必须跟得上（仓内存在且可读），否则红。
          //    变量/表达式拼出来的路径（`"$DIR/x.sh"`）不在这里判 —— 那是**正文文本网**的
          //    责任（`mentioning` 必须登记成 `data-reference`，未登记即红），两条网不重复计红。
          if (isRepoRelativePathWord(command) && (command.includes('/') || command.includes('.'))) {
            // 跟得上就跟随（解释器的脚本位：`node x.mjs` / `python3 x.py`）；
            // **R21 fix-6 / E-01**：跟不上一律红 —— 修前这里写的是"带 `/` 的仓内相对路径
            // 跟不上一律红；裸文件名（`x.mjs`）跟不出仓内文件时不红"，而审计反过来正是用
            // **裸文件名**绕过的（`python3 gen.py`：解释器的脚本位作为 head[0] 落到这一位，
            // 载荷 base64 不透明 ⇒ 两张网全漏，而 tripwire 证明运行期真的执行了端到端入口）。
            // 这里与 ②b（`bash gen.sh` / `source gen.sh`）共用同一个判据
            // `reportGeneratedScript`（登记表同一张，死条目对账同一份）。
            //
            // **R22 FIX-14 / E-01 形态 A**：跟得上**不等于**运行期执行的就是仓里那一份 ——
            // 同一段文本前文写过它时另记一条红（`reportRuntimeWrittenScript`），
            // 判定顺序与前两格一致：写过 ⇒ 红；存在 ⇒ 跟随；不存在 ⇒ 生成物红。
            const resolved = resolveCarrierPath(command, dirs)
            if (resolved !== undefined) {
              if (writtenCarriers.has(resolved)) {
                reportRuntimeWrittenScript(command, command, '命令位', writtenWhere(resolved))
                continue
              }
              followCarrierToken(command, dirs)
              continue
            }
            if (isLiteralRepoRelativeScript(command)) reportGeneratedScript(command, command, '命令位')
            continue
          }
          // ② 参数位上的仓内载体（`node x.mjs` / `bash y.sh` / `-f z.yml` / recipe 文件）。
          //
          // **R20A-02**：`source <脚本>` / `. <脚本>` 的目标不是"被执行"而是"被读进当前 shell"
          // —— 这个区别只在自指脚本位（`$0`）上可见，但它决定闭包跟随的是哪个文件：
          // 被 source 的正文里 `$(dirname "$0")` 求值到**调用者**的目录，而闭包若按本文件
          // 目录求值就会跟随**诱饵**文件（审计夹具 `s0-outer`：守卫 EXIT=0，运行期真的执行
          // 了端到端入口）。所以这两条命令的脚本位单独跟随、并打上 `sourced` 标记，
          // 不再走下面那条通用的"参数位一律按 executed 跟随"。
          const sourceTarget = command === 'source' || command === '.'
            ? shellScriptWordIndex(head, 0)
            : null
          if (sourceTarget !== null && sourceTarget.commandText === null && sourceTarget.scriptIndex >= 0) {
            const sourcedWord = head[sourceTarget.scriptIndex]
            // **R22 FIX-14 / E-01 形态 A**：`source` 的目标**跟得上**并不代表运行期读到的就是仓里
            // 那一份 —— 同一段文本前文写过它时，这里先判"被写过"（与命令位/脚本位同一判据）。
            // 修前这一支只看"跟不跟得上"，于是 `printf … > scripts/x.sh; source scripts/x.sh`
            // 与"覆写后 `bash`"是同一族却分属两格（前者全绿）。
            const sourcedResolved = resolveCarrierPath(sourcedWord, dirs)
            if (sourcedResolved !== undefined && writtenCarriers.has(sourcedResolved)) {
              reportRuntimeWrittenScript(sourcedWord, `source ${sourcedWord}`, '`source` 的脚本位', writtenWhere(sourcedResolved))
              continue
            }
            // **R21 fix-6 / E-01**：这一支修前只 `followCarrierToken` 然后 `continue` ——
            // 跟不出仓内文件时**静默**（`source gen.sh` 实测 EXIT=0，而运行期真的执行了
            // 生成物里的端到端入口）。`source` 的脚本位与解释器的脚本位同义，判据同一份。
            if (!followCarrierToken(sourcedWord, dirs, { sourced: true })
              && isLiteralRepoRelativeScript(sourcedWord)) {
              reportGeneratedScript(sourcedWord, `source ${sourcedWord}`, '`source` 的脚本位')
            }
            continue
          }
          // ②b **脚本位指向"仓内不存在的字面路径"**（**R20A-05**）：解释器 / `source` 的脚本位
          //     是"要执行的程序"，它跟不出仓内文件时**不再是静默的"没跟随"** ——
          //     `base64 -d payload.b64 > gen.sh; bash gen.sh` 这一族（生成物在检查期不存在、
          //     载荷是不透明数据）修前两张网全漏（审计夹具 `p-gen-runtime`：守卫 EXIT=0，
          //     tripwire 证明运行期真的执行了端到端入口）。
          //     判据咬"**字面、仓内相对**"的形态（**裸文件名也算** —— R21 fix-6 / E-01：
          //     修前这里有一个 `scriptLiteral.includes('/')` 前置条件，而它自己的诊断文案
          //     点名的反例正是**不带 `/`** 的 `bash gen.sh`）；变量/通配/绝对路径在词法阶段
          //     已经 fail-closed（`shell-argument-unreadable`），别在这里重复计红。
          //     与"先构建再执行 `bash dist/x.sh`"**无法静态区分** ⇒ 出路是逐处登记
          //     `CI_SURFACE_GENERATED_SCRIPT_ACK`（写明由谁生成、哪一步生成），死条目也红。
          // 脚本宿主 = shell 词 / `source`·`.` /**带脚本位的解释器**（`node` / `python3`，
          // R21 fix-6 / E-01：它们的 head 由 `scriptPositional` 分支造成 `[解释器, 脚本, …]`）。
          // 这些解释器在包装表里已经没有旗标可跳（旗标段在入队前就被 `skipFlags` 吃掉了），
          // 所以与 shell 共用同一个取词函数不会取错位。
          const scriptHost = (COMMAND_SHELL_WORDS.has(command) || command === 'source' || command === '.'
            || COMMAND_WRAPPER_SPECS.get(command)?.scriptPositional === true)
            ? shellScriptWordIndex(head, 0)
            : null
          const scriptWord = scriptHost === null || scriptHost.commandText !== null || scriptHost.scriptIndex < 0
            ? undefined
            : head[scriptHost.scriptIndex]
          if (scriptWord !== undefined && isLiteralRepoRelativeScript(scriptWord)) {
            // **R22 FIX-14 / E-01 形态 A**：路径在检查期存在，但**同一段文本前文写过它**
            // ⇒ 运行期执行的是被写进去的内容（闭包跟随到的是仓里那份良性文本）。
            const scriptResolved = resolveCarrierPath(scriptWord, dirs) ?? resolveCarrierPath(scriptWord, [''])
            if (scriptResolved !== undefined) {
              if (writtenCarriers.has(scriptResolved)) {
                reportRuntimeWrittenScript(
                  scriptWord,
                  head.slice(0, scriptHost.scriptIndex + 1).join(' '),
                  '脚本位',
                  writtenWhere(scriptResolved),
                )
                continue
              }
            } else {
              reportGeneratedScript(
                scriptWord,
                head.slice(0, scriptHost.scriptIndex + 1).join(' '),
                '脚本位',
              )
              continue
            }
          }
          for (let cursor = 1; cursor < head.length; cursor += 1) {
            const word = head[cursor]
            if (word.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/u.test(word)) continue
            if (word.includes('$') || word.includes('{{')) continue
            if (!/[./]/u.test(word)) continue
            followCarrierToken(word, dirs)
          }
        }
      }
    }
    /** 把"命令位 token / 实参字面量"继续扩张成节点；命中端到端入口的记进 `reached`。 */
    const expandTokens = (tokens, dir) => {
      for (const token of tokens) {
        // 相对路径（`../integration-tests/run-all.sh`）按**这条命令的工作目录**归一化后再判，
        // 否则 make 配方里的相对路径既命中不了端到端入口、也跟随不了包装脚本。
        const relative = dir === '' || !/^\.\.?\//u.test(token) ? token : joinSurfacePath(dir, token)
        if (E2E_END_TO_END_PATTERN.test(token) || E2E_END_TO_END_PATTERN.test(relative)) {
          reached.set(node.file, node.via)
        }
        const script = resolveScript(token, dir) ?? resolveScript(relative, '')
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
      // 命令词法（`make` / compose / 登记制 / 参数位载体）**只在 `run:` 块**上跑：
      // 步骤名、`name:`、注释里的 `make`、`with:` 里的 JSON 都是散文/数据，不是命令。
      // **R23 FIX-22 / W4-01**：命令词法按 **job** 分组跑，同一 job 的 step 顺序共享一份
      // "被写过的仓内路径"（`carriedWrites`）—— 跨 step 的"先写后执行"因此与同块形态同判。
      //
      // **R24 FIX-26 / X3-01②③**：作用域再补两样（都按 **step 顺序**）——
      //   · `carriedEnv`：`$GITHUB_ENV`/`$GITHUB_OUTPUT` 导出的名字 → 值（同 step 语义一致：
      //     扫完本块才收集，所以"同一步里先 export 再用"不会被当成已生效）；
      //   · 本地复合 action（`uses: ./.github/actions/x`）：它的 `steps[].run` 写**同一个
      //     工作树**，所以它在**那一步**把写并进 job 作用域（修前 `uses:` 那一步在结构上
      //     不存在 ⇒ "复合 action 里写、下一步执行"整族隐形）。
      for (const { job, steps } of workflowJobSteps(text)) {
        const dirs = workingDirsFor(text)
        const carriedWrites = new Map()
        const carriedEnv = new Map()
        for (const step of steps) {
          for (const target of step.uses) {
            for (const carrier of compositeActionWrittenCarriers(target, carriedEnv)) {
              if (!carriedWrites.has(carrier)) carriedWrites.set(carrier, job)
            }
          }
          for (const block of step.runs) {
            // **R22 FIX-14 / V7-06**：here-doc 的**正文是数据**、终止词是流标记 —— 拿命令词法去读
            // 它们会把 `import json` / `print(...)` 读成"未登记的可执行名"、把终止词 `PY` 读成
            // "脚本位指向仓内不存在的路径"（实测 8 条误红）。命令位扫描读去正文的版本；
            // 文本网/token 网（`expandTokens`，在下面按**原文**跑）不受影响。
            const script = inlineHeredocs(block)
            expandMakeCalls(script, dirs, true, selfContext)
            expandComposeCalls(script, dirs, true, selfContext)
            scanCarrierPaths(script, dirs, true, { carriedWrites, carriedJob: job, carriedEnv })
            collectExportedEnvAssignments(script, carriedEnv)
          }
        }
      }
    } else if (node.kind === 'shell-value') {
      // 别名值 / compose 的 `command:` —— 都是**shell 文本**。
      const dirs = workingDirsFor(text)
      expandTokens(shellCommandTokens(text), node.dir)
      expandMakeCalls(text, dirs, true, selfContext)
      expandComposeCalls(text, dirs, true, selfContext)
      scanCarrierPaths(text, dirs, true, selfContext)
    } else if (node.kind === 'manifest' || node.kind === 'data') {
      // `package.json` / 被当作数据跟随的仓内文件：**只过 token 网与文本网**。
      // 它们是 JSON/YAML/数据，不是 shell —— 拿命令词法去读会把 `"name": "x"` 读成
      // 一条名为 `name` 的命令，登记制会立刻误红。
      expandTokens(shellCommandTokens(text), node.dir)
    } else if (node.kind === 'script') {
      // 按语言选抽取器：`.sh` 走命令位、`.py` 走 `subprocess.*`/`runpy`/`exec` 实参窗口、
      // 其余走 JS 家族。命令词法（登记制/载体跟随）**只对 shell 正文**开：
      // 拿 shell 词法读 Python/JS 源码会把 `import subprocess` 读成一条命令。
      expandTokens(scriptExecutionLiterals(node.file, text, scriptKeys, jsImportContextFor(node)), node.dir)
      if (/\.(?:sh|bash)$/u.test(node.file)) {
        const dirs = workingDirsFor(text)
        // **被跟随的仓内脚本正文不逐词登记**（`strict = false`）：那里的命令位包含脚本
        // 自定义函数（`fail()` / `brand_run_best_effort()`）、shell 语法构件与大小写模式，
        // 逐词登记等于要求为 shell 语言本身背书；它们的端到端接线由**载体跟随 + token 网 +
        // 文本网 + make/compose 扩张**四张网覆盖（见 {@link ciExecutionSurface} 头注释）。
        expandMakeCalls(text, dirs, false, selfContext)
        expandComposeCalls(text, dirs, false, selfContext)
        scanCarrierPaths(text, dirs, false, selfContext)
      }
    } else if (node.kind === 'makefile') {
      // 目标的配方体（已含前置目标的配方）：按 shell 口径继续闭包，并跟随其中的 `$(MAKE)` 递归。
      expandTokens(shellCommandTokens(text), node.dir)
      expandMakeCalls(text, [node.dir], true, selfContext)
      expandComposeCalls(text, [node.dir], true, selfContext)
      scanCarrierPaths(text, [node.dir], true, selfContext)
    } else if (node.kind === 'nested-shell') {
      // **lenient 内层 shell 文本**（`trap '<命令文本>' <信号>`，R17A-02）：与"被跟随的仓内
      // 脚本正文"同口径 —— 载体跟随 + token/文本网 + make/compose 扩张都开，**逐词登记不开**
      // （钩子体里常见的是同文件的清理函数名）。端到端接线仍然被这四张网覆盖。
      const dirs = workingDirsFor(text)
      expandTokens(shellCommandTokens(text), node.dir)
      expandMakeCalls(text, dirs, false, selfContext)
      expandComposeCalls(text, dirs, false, selfContext)
      scanCarrierPaths(text, dirs, false, selfContext)
    }
    // `eval '<命令文本>'` 一类的**内层 shell 文本**入队（R17A-02）：它们是与 `run:` 块同义的
    // 执行面，必须当成真正的闭包节点（光靠 `makeInvocations` 的递归只看得到 `make`）。
    for (const nested of nestedShellTexts) {
      enqueue({
        key: `${node.key}#nested-shell:${nested.index}`,
        file: node.file,
        kind: nested.node === NESTED_SHELL_STRICT ? 'shell-value' : 'nested-shell',
        text: nested.text,
        dir: node.dir,
        via: [...node.via, `${nested.flag} '<内层 shell 文本>'`],
        hops: node.hops + 1,
      })
    }
  }
  return {
    mentioning, reached, problems, nodes, truncated, variableCommands, commandShapes, shellArguments,
    generatedScripts, commandWords,
    // **R23 FIX-22 / W4-06**：把 E-01 的"写过哪些仓内路径"识别器**交出去**，供收尾的
    // 判决级见证（`runtimeWriteDetectorProblem`）在合成样本上自证 —— 修前这一层没有任何
    // 观测量反映它，`runtimeWrittenCarriers` 首行一行早退（`return written`）就能让整层失效
    // 而守卫仍 `EXIT=0`（W4-06 实测，连 V7 的 a1 夹具也一起变绿）。
    writeTargets: (source, env) => writeTargetsImpl?.(source, env) ?? new Set(),
  }
}

/**
 * Makefile 正文 → **解析期就会执行的 shell 片段**（R16A-12）。
 *
 * 现场：`X := $(shell bash ../integration-tests/run-all.sh)` —— GNU make 在**读文件时**就执行
 * 它，与"目标是什么"完全无关；而闭包把 Makefile 当"目标 → 配方"的映射读，于是
 * `make -C server <任何目标>` 都已经跑过端到端而守卫全绿。
 *
 * 收两族形态：`$(shell …)`（`${shell …}` 同义）与 `!=` 赋值（GNU make 的 shell 赋值）。
 * 括弧要**配对**扫（`$(shell $(shell …))` 这类嵌套），扫不到配对的收尾 ⇒ 记 problem。
 * @param text - Makefile 正文（根文件与每个 `include` 进来的文件各调一次）。
 * @returns `{ bodies, problems }`（`bodies` = 待跟随的 shell 文本）。
 */
function makeShellBodies(text) {
  const bodies = []
  const problems = []
  const source = String(text)
  for (let index = 0; index < source.length; index += 1) {
    const opener = source.startsWith('$(shell', index) ? '$(' : source.startsWith('${shell', index) ? '${' : null
    if (opener === null) continue
    // `$(shell` 之后必须是空白或收尾（`$(shell…)` 才是函数调用；`$(shellx)` 不是）。
    if (!/[\s)]/u.test(source[index + opener.length + 'shell'.length] ?? ')')) continue
    const start = index
    let depth = 0
    let cursor = index + 1
    for (; cursor < source.length; cursor += 1) {
      if (source[cursor] === opener[1]) depth += 1
      else if (source[cursor] === (opener === '$(' ? ')' : '}')) {
        depth -= 1
        if (depth === 0) break
      }
    }
    if (cursor >= source.length) {
      problems.push('Makefile 里的 `$(shell …)` 括号不配对 —— 读不出它跑什么，按 fail-closed 记红。')
      break
    }
    const body = source.slice(start + opener.length + 'shell'.length, cursor).trim()
    if (body.includes('$(') || body.includes('${')) {
      problems.push(`Makefile 里的 \`$(shell ${body})\` 的取值里还有变量/函数 ——`
        + ' 读不懂它跑什么，按 fail-closed 记红（请把它写成字面命令）。')
    } else if (body !== '') {
      bodies.push(body)
    }
    index = cursor
  }
  // `NAME != <shell 命令>`（GNU make 的 shell 赋值）：只在**行首**认，避免把配方里的 `!=`
  // 读成赋值（配方行以 TAB 起，不是行首）。
  for (const line of source.split('\n')) {
    if (/^\t/u.test(line)) continue
    const match = /^\s*[A-Za-z_][A-Za-z0-9_]*\s*!=?\s*(.+)$/u.exec(line)
    if (match === null || !line.includes('!=')) continue
    const body = match[1].trim()
    if (body === '' || body.includes('$(') || body.includes('${')) {
      problems.push(`Makefile 里的 \`${line.trim()}\` 是 shell 赋值但取值读不懂 —— 按 fail-closed 记红。`)
      continue
    }
    bodies.push(body)
  }
  return { bodies, problems }
}

/**
 * 读一个 Makefile 并跟随它的 `include` 链（深度受限）。
 * @param options - 闭包的 `{ exists, read }` 谓词。
 * @param makefile - Makefile 的仓库相对路径。
 * @returns `{ rules, variables, problems }`。
 */
function followMakefile(options, makefile) {
  const { rules, includes, variables } = makefileRules(options.read(makefile))
  const problems = []
  /** 解析期就会执行的 shell 片段（R16A-12）：根文件与每个 included 文件都要收。 */
  const shells = []
  const rootShells = makeShellBodies(options.read(makefile))
  shells.push(...rootShells.bodies)
  problems.push(...rootShells.problems)
  const pending = [...includes]
  const visited = new Set([makefile])
  let hops = 0
  while (pending.length > 0) {
    if (hops >= CI_SURFACE_MAX_HOPS) { problems.push('`include` 链超过深度上限 —— 按 fail-closed 记红。'); break }
    hops += 1
    const requested = pending.shift()
    const resolved = expandMakeVariables(requested, variables)
    if (resolved.includes('$')) {
      problems.push(`\`include ${requested}\` 的路径是变量且展开不出字面量 ——`
        + ' 闭包无法判定它把哪些规则包含进来，按 fail-closed 记红。')
      continue
    }
    const path = joinSurfacePath(makefile.includes('/') ? makefile.slice(0, makefile.lastIndexOf('/')) : '', resolved)
    if (visited.has(path)) continue
    visited.add(path)
    if (!options.exists(path)) {
      problems.push(`\`include ${requested}\` 指向的 ${path} 不在仓库里（或读不到）——`
        + ' 按 fail-closed 记红：包含文件里的目标体对闭包不可见。')
      continue
    }
    const includedShells = makeShellBodies(options.read(path))
    shells.push(...includedShells.bodies)
    problems.push(...includedShells.problems)
    const included = makefileRules(options.read(path))
    for (const [name, rule] of included.rules) {
      const existing = rules.get(name) ?? { prereqs: [], recipe: [] }
      existing.prereqs.push(...rule.prereqs)
      existing.recipe.push(...rule.recipe)
      rules.set(name, existing)
    }
    for (const [name, value] of included.variables) if (!variables.has(name)) variables.set(name, value)
    pending.push(...included.includes)
  }
  return { rules, variables, problems, shells }
}

/**
 * 取一个目标（含其前置目标）的**配方体**（展开变量后）。
 *
 * 前置目标的配方也会被执行（先于目标本身），所以一起收进来；找不到目标 / 目标没有配方
 * ⇒ 返回 `{ text: undefined }`，由调用方在"候选 Makefile 全都不成立"时记一条 fail-closed
 * 诊断（单看某一个候选文件时"没有这个目标"是正常的：另一个候选才是它真正属于的那个）。
 * 前置里的**文件名**（不是本 Makefile 的目标）只当依赖，不当作配方来源。
 * @param target - 目标名。
 * @param rules - 规则表。
 * @param variables - 变量表。
 * @returns `{ text }`（`text === undefined` = 这个 Makefile 里没有可用的目标体）。
 */
function makeTargetBody(target, rules, variables) {
  if (!rules.has(target)) return { text: undefined }
  const collected = []
  const visited = new Set()
  const walk = (name, depth) => {
    if (depth > CI_SURFACE_MAX_HOPS || visited.has(name)) return
    visited.add(name)
    const rule = rules.get(name)
    if (rule === undefined) return
    for (const prereq of rule.prereqs) walk(prereq, depth + 1)
    if (rule.recipe.length > 0) collected.push(expandMakeVariables(rule.recipe.join('\n'), variables))
  }
  walk(target, 0)
  if (collected.length === 0) return { text: undefined }
  return { text: collected.join('\n') }
}

/**
 * 仓库相对路径拼接 + `..` / `.` / 重复斜杠折叠（纯字符串，不碰文件系统）。
 * @param parts - 路径片段。
 * @returns 归一化后的路径。
 */
function joinSurfacePath(...parts) {
  const segments = []
  for (const part of parts.join('/').split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') { segments.pop(); continue }
    segments.push(part)
  }
  return segments.join('/')
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
 * E-01「写过哪些仓内路径」识别器的**合成样本**（R23 FIX-22 / W4-06 的判决级见证）。
 *
 * 每条的 `want` 必须被识别出来；`want: []` 的那条反过来要求**不得**凭空认出写目标
 * （防止"把一切都当成写过"这种廉价通过）。样本逐条对应实测过的一个绕过形态：
 *   · 第二十三轮 W4：`tee -a X >/dev/null`（W4-02）、`cp src dst > /dev/null`（W4-02）、
 *     `T=…; > "$T"`（W4-09）；
 *   · **第二十四轮 X3（R24 FIX-26 / X3-01）**：`python3 -c` 里 `Path(X).write_bytes`、
 *     `node -e` 里 `fs.writeFileSync(X)`、`exec 3<>X`、经 `$GITHUB_ENV` 递过来的 `> "$V7T"`
 *     —— 修前这四族都不进任何一张网（`EXIT=0` 而 tripwire 证明运行期真的执行了端到端入口）。
 * `env` 是这一条样本需要的 `$GITHUB_ENV` 导出表（省略 = 空）。
 * @type {Array<{ source: string, want: string[], env?: Map<string, string> }>}
 */
const RUNTIME_WRITE_DETECTOR_PROBES = [
  {
    source: "P='x'\nprintf \"%s\" \"$P\" | base64 -d | tee -a scripts/ci-brand-mask.sh >/dev/null",
    want: ['scripts/ci-brand-mask.sh'],
  },
  { source: 'cp /tmp/payload.sh scripts/ci-brand-mask.sh > /dev/null', want: ['scripts/ci-brand-mask.sh'] },
  { source: 'T=scripts/ci-brand-mask.sh\nprintf "%s" "$P" | base64 -d > "$T"', want: ['scripts/ci-brand-mask.sh'] },
  { source: 'printf "%s" x > scripts/ci-brand-mask.sh\nbash scripts/ci-brand-mask.sh', want: ['scripts/ci-brand-mask.sh'] },
  { source: 'bash scripts/ci-brand-mask.sh', want: [] },
  // ---- R24 FIX-26 / X3-01 的四族（各对应一个实测夹具）--------------------------------
  {
    source: "python3 -c \"import base64,pathlib;pathlib.Path('scripts/ci-brand-mask.sh')"
      + ".write_bytes(base64.b64decode('eA=='))\"",
    want: ['scripts/ci-brand-mask.sh'],
  },
  {
    source: "node -e \"require('node:fs').writeFileSync('scripts/ci-brand-mask.sh','x')\"",
    want: ['scripts/ci-brand-mask.sh'],
  },
  {
    source: "exec 3<>scripts/ci-brand-mask.sh\nprintf '%s' \"$P\" >&3\nexec 3>&-\nbash scripts/ci-brand-mask.sh",
    want: ['scripts/ci-brand-mask.sh'],
  },
  {
    // 写目标由**上一步**经 `$GITHUB_ENV` 递过来（同一步内的赋值走既有常量传播，不在此列）。
    source: 'printf "%s" "$P" | base64 -d > "$V7T"',
    want: ['scripts/ci-brand-mask.sh'],
    env: new Map([['V7T', 'scripts/ci-brand-mask.sh']]),
  },
  // 反向：只读的 `open('X')`（没有写标志）绝不能被算成写（否则判据变成误报工厂）。
  { source: "python3 -c \"print(open('scripts/ci-brand-mask.sh').read())\"", want: [] },
]
/**
 * E-01 识别器的**判决级见证**（R23 FIX-22 / W4-06）：合成样本必须逐条认对。
 *
 * 修前这一层**没有任何判据级见证** —— `runtimeWrittenCarriers` 首行插一句
 * `return written`（判据文本与 16 条判决句 needle 一字未动）⇒ 守卫 `EXIT=0`，
 * 且在同一个掏空版守卫下**连 V7 的 `a1-single-block` 夹具也变绿**（W4-06 实测）。
 * 现在 `writeTargets` 每次运行都要在合成样本上自证，"掏空该层"必然可见。
 * @param detect - `source => Set<路径>`（生产路径传 `ciExecutionSurface(...).writeTargets`）。
 * @returns 不合规的原因；全部通过返回 `undefined`。
 */
function runtimeWriteDetectorProblem(detect) {
  if (typeof detect !== 'function') return 'E-01 的写目标识别器没有交出来（`writeTargets` 缺失）'
  for (const probe of RUNTIME_WRITE_DETECTOR_PROBES) {
    const found = detect(probe.source, probe.env)
    if (!(found instanceof Set)) {
      return `E-01 的写目标识别器对样本 ${JSON.stringify(probe.source.slice(0, 60))} 返回的不是集合`
    }
    for (const path of probe.want) {
      if (!found.has(path)) {
        return `E-01 的写目标识别器没有认出样本 ${JSON.stringify(probe.source.slice(0, 72))} 里的 `
          + `\`${path}\`（实际 ${JSON.stringify([...found])}）—— 这一格对应第二十三轮 W4 实测的`
          + '绕过形态（`tee -a X >/dev/null` / `cp src dst > /dev/null` / `T=…; > "$T"`）'
      }
    }
    if (probe.want.length === 0 && found.size > 0) {
      return `E-01 的写目标识别器在**没有写操作**的样本 `
        + `${JSON.stringify(probe.source.slice(0, 72))} 上认出了 ${JSON.stringify([...found])}`
    }
  }
  return undefined
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
    ['scripts/probe-wrapper.sh',
      '#!/usr/bin/env bash\nnode scripts/probe-runner.mjs\nnode scripts/probe-dynamic.sh\n'
      + 'node scripts/probe-computed.mjs\nnode scripts/probe-consttable.mjs\n'],
    ['scripts/probe-runner.mjs', "spawnSync('bash', ['integration-tests/run-all.sh'], { cwd: ROOT })\n"],
    // **R18A-03**：JS 包装脚本里"先解析、后执行"的两种常规写法（修前它们整族不可见：
    // `.mjs` 不进文本网，而实参窗口只看得到写在调用里的字面量）：
    //   · `const T = '<路径>'` + `spawnSync('bash', [T])`（同文件常量）；
    //   · `const TARGETS = { e2e: join(ROOT, 'a', 'b') }` + `[TARGETS.e2e]`
    //     （常量表 + `join` 拼接 + 成员访问）。
    ['scripts/probe-consttable.mjs',
      "import { spawnSync } from 'node:child_process'\n"
      + "const T = 'integration-tests/run-all.sh'\nspawnSync('bash', [T], { stdio: 'inherit' })\n"],
    ['scripts/probe-computed.mjs',
      "import { spawnSync } from 'node:child_process'\nimport { join } from 'node:path'\n"
      + "const TARGETS = { e2e: join(ROOT, 'integration-tests', 'run-all.sh') }\n"
      + "spawnSync('bash', [TARGETS.e2e], { stdio: 'inherit' })\n"],
    // 只有**正文提到**、执行形态解析不出来的那一半：token 含 `$`（变量拼路径）⇒
    // 归 `mentioning ∖ reached`，必须登记成 `data-reference` 才算"看见并认账"。
    // **R18A-01 之后**这一条必须是"只说、不执行"的形态：修前它是
    // `bash "$DIR/run-all.sh"`（变量拼路径）—— 那在 R18A-01 的收口里已经变成
    // **fail-closed**（脚本位含 `/` 的间接层不再豁免），所以它不能再扮演
    // "`mentioning ∖ reached` 的数据引用"这一半。现在它只在正文里**逐字提到**入口
    // （注释/printf 数据），执行形态里没有它 ⇒ 仍归 `data-reference`。
    ['scripts/probe-dynamic.sh',
      '#!/usr/bin/env bash\n'
      + '# 说明：integration-tests/run-all.sh 需要 Docker + 真实服务端，CI 内不跑（操作员手动执行）。\n'
      + 'exit 0\n'],
    // `make` 目标间接（VA-05-F1）：闭包必须跟随到 `server/Makefile` 那个**目标体**里。
    ['.github/workflows/maketarget.yml',
      'name: maketarget\njobs:\n  a:\n    steps:\n      - run: make -C server probe-e2e\n'],
    ['server/Makefile', 'BIN := bin/x\n.PHONY: probe-e2e\nprobe-e2e: probe-dep\n\tbash ../integration-tests/run-all.sh\nprobe-dep:\n\t@true\n'],
    ['.github/workflows/makefile-flag.yml',
      'name: makefile-flag\njobs:\n  a:\n    steps:\n      - run: make -f ci-probe.mk e2e\n'],
    ['ci-probe.mk', 'e2e:\n\tbash integration-tests/run-all.sh\n'],
    // `.py` 包装脚本（VA-05-F2）：扩展名由扫描面派生 ⇒ 必须被跟随，且要用 Python 的抽取器。
    ['.github/workflows/python-wrap.yml',
      'name: python-wrap\njobs:\n  a:\n    steps:\n      - run: python3 scripts/probe-wrapper.py\n'],
    ['scripts/probe-wrapper.py',
      "import subprocess\n\nsubprocess.run(['bash', 'integration-tests/run-all.sh'], check=True)\n"],
    // **包装链**（R15A-03）：`timeout`/`bash -c`/`npm exec --` 把目标藏在参数位里 ——
    // 修前这三种形态全 EXIT=0（闭包不触达），而 CI 真的会执行它。
    ['.github/workflows/wrapper-chain.yml',
      'name: wrapper-chain\njobs:\n  a:\n    steps:\n'
      + '      - run: timeout 900 make -f wrapper-timeout.mk e2e\n'
      + '      - run: bash -c "make -f wrapper-bashc.mk e2e"\n'
      + '      - run: npm exec -- make -f wrapper-npmexec.mk e2e\n'],
    ['wrapper-timeout.mk', 'e2e:\n\tbash integration-tests/run-all.sh\n'],
    ['wrapper-bashc.mk', 'e2e:\n\tbash integration-tests/run-all.sh\n'],
    ['wrapper-npmexec.mk', 'e2e:\n\tbash integration-tests/run-all.sh\n'],
    // **compose 载体**（R15A-03 的 C8）：命令写在 compose 文件里。
    ['.github/workflows/compose-run.yml',
      'name: compose-run\njobs:\n  a:\n    steps:\n      - run: docker compose -f ci-probe.compose.yml run e2e\n'],
    ['ci-probe.compose.yml',
      'services:\n  e2e:\n    image: example/e2e:latest\n    command: bash integration-tests/run-all.sh\n'],
    // **`.py` 正文文本网**（R15A-03 的 C5/C6）：`runpy` / `exec(open(...))` 两条都不在
    // `subprocess.*` 抽取器里，修前它们在"抽取器"与"文本网"之间掉出去。
    ['.github/workflows/python-runpy.yml',
      'name: python-runpy\njobs:\n  a:\n    steps:\n      - run: python3 scripts/probe-runpy.py\n'],
    ['scripts/probe-runpy.py', "import runpy\nrunpy.run_path('integration-tests/run-all.sh')\n"],
    ['.github/workflows/python-exec.yml',
      'name: python-exec\njobs:\n  a:\n    steps:\n      - run: python3 scripts/probe-exec.py\n'],
    ['scripts/probe-exec.py', "exec(open('integration-tests/run-all.sh').read())\n"],
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
    ['scripts/probe-consttable.mjs', '`.mjs` 里**同文件常量**（`const T = …` + `spawnSync(\'bash\', [T])`）指向的端到端入口'],
    ['scripts/probe-computed.mjs', '`.mjs` 里**常量表 + `join` 拼接**（`{ e2e: join(ROOT, …) }`）指向的端到端入口'],
    ['scripts/probe-dynamic.sh', '只有正文提到、执行形态解析不出来的 `.sh`（`data-reference` 那一半）'],
  ]) {
    check(seenFiles.has(file),
      `形态⑨自证: CI 执行面闭包没认出${label}（${file}）—— 判据的输入面又退回了"workflow 文本"，`
        + `别名/复合 action/包装链这些同类物会再次隐形。实际触及：${[...seenFiles].join(', ')}`)
  }
  check(surface.nodes.includes('scripts/probe-wrapper.sh') && surface.nodes.includes('scripts/probe-dynamic.sh'),
    '形态⑨自证: 命令位上的 `.sh` 包装脚本必须被**跟随**（否则包装链把端到端藏起来就看不见）：'
      + `闭包节点 ${surface.nodes.join(', ')}`)
  for (const [file, label] of [
    ['server/Makefile', '`make -C server <目标>` 展开到的目标体（VA-05-F1 的形态）'],
    ['ci-probe.mk', '`make -f <文件> <目标>` 的候选 Makefile'],
    ['scripts/probe-wrapper.py', '`.py` 包装脚本（VA-05-F2 的形态）'],
    ['ci-probe.compose.yml', '`docker compose -f <文件> run <服务>` 的 compose 载体（R15A-03 的 C8）'],
    ['scripts/probe-runpy.py', '`.py` 里 `runpy.run_path(<字面量>)` 的包装脚本（R15A-03 的 C5）'],
    ['scripts/probe-exec.py', '`.py` 里 `exec(open(<字面量>).read())` 的包装脚本（R15A-03 的 C6）'],
  ]) {
    check(surface.reached.has(file),
      `形态⑨自证: CI 执行面闭包没认出${label}（${file}）—— 补上扩展名/跟随规则但抽取器不认，`
        + `等于把同一个洞换个写法。实际 reached：${[...surface.reached.keys()].join(', ')}`)
  }
  // R15A-03 的 5 种同族形态：**每一种**都必须让闭包触达端到端入口（否则守卫又会"没扫到 = 0 接线"）。
  // 载体文件**两两不同**，这样每一条断言都只能被它对应的那种形态满足（共用 `server/Makefile`
  // 时，四种形态里只要有一种能解析就全绿 —— 那是"自证覆盖之外"）。
  for (const [file, label] of [
    ['wrapper-timeout.mk', '`timeout 900 make -f <文件> <目标>`（包装词在 make 之前）'],
    ['wrapper-bashc.mk', '`bash -c "make -f <文件> <目标>"`（内层 shell 文本）'],
    ['wrapper-npmexec.mk', '`npm exec -- make -f <文件> <目标>`（包运行器的 exec 面）'],
    ['ci-probe.compose.yml', '`docker compose -f <文件> run <服务>`（命令写在 compose 文件里）'],
    ['scripts/probe-runpy.py', '`python3 <包装脚本>`（内含 `runpy.run_path`）'],
    ['scripts/probe-exec.py', '`python3 <包装脚本>`（内含 `exec(open(...).read())`）'],
  ]) {
    check(surface.reached.has(file),
      `形态⑨自证: 包装链形态「${label}」没有被认成"触达端到端入口"（${file}）——`
        + ' 这正是第十五轮 R15A-03 的现场：目标藏在**参数位**里而闭包只认"命令位就是 make"。'
        + ` 实际 reached：${[...surface.reached.keys()].join(', ')}`)
  }
  // 反面对照：登记过的包装词**不得**因为"看见 `timeout`"就误报（记 problem 会让真仓变红）。
  check(surface.problems.length === 0,
    '形态⑨自证: 包装链夹具（`timeout 900 make …` / `bash -c "make …"` / `npm exec -- make …` /'
      + ` compose run）不得产生"读不懂"的 problem：${JSON.stringify(surface.problems)}`)
  // **包装链尽头的变量命令位**：fail-closed（未登记即 problem）+ 登记制（登记后放行）。
  const ackProbeFixture = new Map([
    ['.github/workflows/var-command.yml',
      'name: var-command\njobs:\n  a:\n    steps:\n      - run: timeout 900 $R15A_RUNNER --target\n'],
  ])
  const ackProbe = ciExecutionSurface({
    workflowTexts: [['.github/workflows/var-command.yml', ackProbeFixture.get('.github/workflows/var-command.yml')]],
    rootManifest: {}, rootManifestText: '{}', workspaceManifests: [],
    exists: path => ackProbeFixture.has(path), read: path => ackProbeFixture.get(path) ?? '',
  })
  check(ackProbe.problems.some(message => message.includes('变量展开')),
    '形态⑨自证: `timeout 900 $RUNNER …`（包装链尽头是变量）必须 fail-closed 记 problem ——'
      + ' 否则"把 make 藏进一个变量再经包装链调用"就是新的旁路：'
      + ` 实际 problems=${JSON.stringify(ackProbe.problems)}`)
  check(ackProbe.variableCommands.length === 1 && ackProbe.variableCommands[0].acked === false,
    '形态⑨自证: 变量命令位必须被记进 `variableCommands` 且标成**未登记**（死条目对账的另一半）：'
      + ` 实际 ${JSON.stringify(ackProbe.variableCommands)}`)
  // **R18A-01 的登记通道**：shell 脚本位那一族同样"fail-closed + 可逐处登记"。
  // 两半都要自证：未登记 ⇒ problem（不给"解析不出名字就放过"留分支）；登记后 ⇒ 不再 problem。
  {
    const shellAckFixture = new Map([
      ['.github/workflows/shell-arg.yml',
        'name: shell-arg\njobs:\n  a:\n    steps:\n      - run: |\n'
        + '          D="$(pwd)/scripts"\n          bash "$D/probe-inner.sh"\n'],
      ['scripts/probe-inner.sh', '#!/usr/bin/env bash\nbash integration-tests/run-all.sh\n'],
    ])
    const shellSurface = () => ciExecutionSurface({
      workflowTexts: [['.github/workflows/shell-arg.yml', shellAckFixture.get('.github/workflows/shell-arg.yml')]],
      rootManifest: {}, rootManifestText: '{}', workspaceManifests: [],
      exists: path => shellAckFixture.has(path), read: path => shellAckFixture.get(path) ?? '',
    })
    const unacked = shellSurface()
    check(unacked.problems.some(message => message.includes('脚本位读不懂')),
      '形态⑨自证: `bash "$D/x.sh"`（脚本位是含 `/` 的间接层）必须 fail-closed 记 problem ——'
        + ' 修前它既不跟随也不判红（R18A-01 的现场）：'
        + ` 实际 problems=${JSON.stringify(unacked.problems)}`)
    check(unacked.shellArguments.length === 1 && unacked.shellArguments[0].acked === false,
      '形态⑨自证: 脚本位读不懂必须被记进 `shellArguments` 且标成**未登记**（死条目对账的另一半）：'
        + ` 实际 ${JSON.stringify(unacked.shellArguments)}`)
    CI_SURFACE_VARIABLE_COMMAND_ACK.push({
      file: '.github/workflows/shell-arg.yml', word: '$D/probe-inner.sh',
      why: '自证：登记之后这一处必须放行（登记制而不是"一律放行"）',
    })
    try {
      const acked = shellSurface()
      check(acked.problems.length === 0,
        '形态⑨自证: 逐处登记之后脚本位那一族必须放行（登记制：新出现的一律红、已认账的留痕）：'
          + ` 实际 problems=${JSON.stringify(acked.problems)}`)
      check(acked.shellArguments.length === 1 && acked.shellArguments[0].acked === true,
        '形态⑨自证: 登记命中后 `shellArguments.acked` 必须是 true（死条目对账靠它）：'
          + ` 实际 ${JSON.stringify(acked.shellArguments)}`)
    } finally {
      CI_SURFACE_VARIABLE_COMMAND_ACK.pop()
    }
  }
  // **R20A-05 的登记通道**：脚本位指向"仓内不存在的字面路径"（运行期生成物）同样
  // "fail-closed + 可逐处登记"。两半都要自证：未登记 ⇒ problem（不给"路径不存在就放过"留分支）；
  // 登记后 ⇒ 不再 problem（这就是"先构建再执行 `bash dist/x.sh`"的正当出路）。
  {
    const generatedFixture = new Map([
      ['.github/workflows/generated.yml',
        'name: generated\njobs:\n  a:\n    steps:\n      - run: |\n'
        + '          base64 -d scripts/probe-payload.b64 > scripts/probe-generated.sh\n'
        + '          bash scripts/probe-generated.sh\n'
        + '          bash ./scripts/probe-generated.sh\n'
        // **R21 fix-6 / E-01**：裸文件名（生成物落在 CWD、按裸名执行）—— 修前这一族
        // 整族隐形（`:6033` 的 `scriptLiteral.includes('/')` 与 ① 的 `command.includes('/')`）。
        + '          bash probe-bare.sh\n'
        // 解释器的脚本位：有扩展名时 head[0] 就是脚本（命令位判据），无扩展名时由
        // `scriptPositional` 分支造成 `[解释器, 脚本, …]`（脚本位判据）—— 两条都要红。
        + '          python3 probe-bare.py\n'
        + '          node probe-extless\n'
        + '          python3 probe-extless-py\n'
        + '          source probe-sourced.sh\n'],
      ['scripts/probe-payload.b64', 'YmFzaCBpbnRlZ3JhdGlvbi10ZXN0cy9ydW4tYWxsLnNoCg==\n'],
    ])
    const generatedSurface = () => ciExecutionSurface({
      workflowTexts: [['.github/workflows/generated.yml', generatedFixture.get('.github/workflows/generated.yml')]],
      rootManifest: {}, rootManifestText: '{}', workspaceManifests: [],
      exists: path => generatedFixture.has(path),
      // 真树的 `read` 是 `readFileSync`：**不存在的路径会抛**（读不出 ⇒ 不是载体）。
      // 夹具必须同形，否则"空字符串 = 读到了"会让每个路径都被当成仓内载体（假绿）。
      read: path => {
        if (!generatedFixture.has(path)) throw new Error(`ENOENT: no such file or directory, open '${path}'`)
        return generatedFixture.get(path)
      },
    })
    const unacked = generatedSurface()
    check(unacked.problems.some(message => message.includes('脚本位指向仓内不存在的路径')
      || message.includes('不存在')),
      '形态⑨自证: `bash scripts/probe-generated.sh`（脚本位指向**仓内不存在**的字面路径）必须'
        + ' fail-closed 记 problem —— 修前它是"跟不出载体 ⇒ 静默放过"（R20A-05 的现场：'
        + ` 生成物 + 不透明载荷 ⇒ 守卫 EXIT=0 而运行期真的执行了端到端入口）：实际 problems=${JSON.stringify(unacked.problems)}`)
    // **R21 fix-6 / E-01 的三条裸文件名形态**：脚本位（`bash probe-bare.sh`）、命令位
    // （`python3 probe-bare.py`）、`source` 的脚本位（`source probe-sourced.sh`）——
    // 三种都必须与带 `/` 的写法**同判**（修前三种全 EXIT=0，而 tripwire 证明运行期真的执行）。
    for (const [word, where] of [['probe-bare.sh', '脚本位'], ['probe-bare.py', '命令位'],
      ['probe-extless', '解释器的**无扩展名**脚本位'], ['probe-extless-py', '解释器的**无扩展名**脚本位'],
      ['probe-sourced.sh', '`source` 的脚本位']]) {
      check(unacked.generatedScripts.some(item => item.word === word && item.acked === false),
        `形态⑨自证（R21/E-01）: **裸文件名** ${where} \`${word}\` 必须与带 \`/\` 的写法**同判**`
          + '（修前这一族整族隐形：`base64 -d … > gen.sh; bash gen.sh` 守卫 EXIT=0 而运行期真的'
          + ` 执行了端到端入口）：实际 ${JSON.stringify(unacked.generatedScripts)}`)
    }
    check(unacked.generatedScripts.length === 7
      && unacked.generatedScripts.every(item => item.acked === false)
      && unacked.generatedScripts.some(item => item.word === 'scripts/probe-generated.sh')
      && unacked.generatedScripts.some(item => item.word === './scripts/probe-generated.sh'),
      '形态⑨自证: "脚本位指向仓内不存在的路径"必须被记进 `generatedScripts` 且标成**未登记**'
        + `（死条目对账的另一半）：实际 ${JSON.stringify(unacked.generatedScripts)}`)
    CI_SURFACE_GENERATED_SCRIPT_ACK.push({
      file: '.github/workflows/generated.yml', word: 'scripts/probe-generated.sh',
      why: '自证：登记之后这一处必须放行（"先构建/生成、再执行"的正当写法只能逐处认账）',
      approvedBy: 'R20A-05（本泳道）',
    })
    CI_SURFACE_GENERATED_SCRIPT_ACK.push({
      file: '.github/workflows/generated.yml', word: './scripts/probe-generated.sh',
      why: '自证：`./` 前缀是同一条判据的另一种字面写法（必须与不带前缀的那条分别登记）',
      approvedBy: 'R20A-05（本泳道）',
    })
    for (const [word, where] of [['probe-bare.sh', '脚本位'], ['probe-bare.py', '命令位'],
      ['probe-extless', '解释器的**无扩展名**脚本位'], ['probe-extless-py', '解释器的**无扩展名**脚本位'],
      ['probe-sourced.sh', '`source` 的脚本位']]) {
      CI_SURFACE_GENERATED_SCRIPT_ACK.push({
        file: '.github/workflows/generated.yml', word,
        why: `自证（R21/E-01）：裸文件名的${where}与带 \`/\` 的写法共用同一张登记表`,
        approvedBy: 'R21 fix-6（E-01）',
      })
    }
    try {
      const acked = generatedSurface()
      check(acked.problems.length === 0,
        '形态⑨自证: 逐处登记之后"生成物脚本位"必须放行（登记制：新出现的一律红、已认账的留痕）：'
          + ` 实际 problems=${JSON.stringify(acked.problems)}`)
      check(acked.generatedScripts.length === 7 && acked.generatedScripts.every(item => item.acked === true),
        '形态⑨自证: 登记命中后 `generatedScripts.acked` 必须是 true（死条目对账靠它）：'
          + ` 实际 ${JSON.stringify(acked.generatedScripts)}`)
    } finally {
      for (let popped = 0; popped < 7; popped += 1) CI_SURFACE_GENERATED_SCRIPT_ACK.pop()
    }
  }
  // **R21/E-01 的误报面自证**：解释器的 `-m <模块>` / `-c <源码>` 不是脚本位 ——
  // 无扩展名硬化（把解释器词一起入 head）若不分"脚本位 vs 模块之后的参数"，`python3 -m
  // http.server 8000` 的 `8000` 会被当成脚本位 ⇒ 假红（真实写法里的 `-m pytest` 同族）。
  {
    const moduleFixture = new Map([
      ['.github/workflows/interp.yml',
        'name: interp\njobs:\n  a:\n    steps:\n      - run: |\n'
        + '          python3 -m http.server 8000\n'
        + '          python3 -m pytest --version\n'
        + '          python3 -c "print(1)"\n'
        + '          node -e "console.log(1)"\n'],
    ])
    const moduleSurface = ciExecutionSurface({
      workflowTexts: [['.github/workflows/interp.yml', moduleFixture.get('.github/workflows/interp.yml')]],
      rootManifest: {}, rootManifestText: '{}', workspaceManifests: [],
      exists: path => moduleFixture.has(path),
      read: path => {
        if (!moduleFixture.has(path)) throw new Error(`ENOENT: no such file or directory, open '${path}'`)
        return moduleFixture.get(path)
      },
    })
    check(moduleSurface.generatedScripts.length === 0,
      '形态⑨自证（R21/E-01 负例）: `python3 -m <模块>` / `python3 -c` / `node -e` 的实参**不是脚本位**'
        + '（`-m` 的取值已经进了 `modules`），不得被"无扩展名脚本位"硬化误判成生成物：'
        + ` 实际 ${JSON.stringify(moduleSurface.generatedScripts)}`)
  }
  // **R20A-02 的接线自证**（`source` 上下文一路传到词数组求值）：被 `source` 的脚本里
  // `$(dirname "$0")` 求值到的是**调用者**的目录 —— 闭包若按"本文件目录"求值就会跟随诱饵文件
  // （审计夹具 `s0-outer`：守卫 EXIT=0 而运行期真的执行了端到端入口）。正例（`$0` 族 ⇒ 红）
  // 与负例（`BASH_SOURCE` 族 ⇒ 照常求值、不红）都要成立。
  {
    const sourcedFixture = new Map([
      ['.github/workflows/sourced.yml',
        'name: sourced\njobs:\n  a:\n    steps:\n      - run: bash scripts/probe-outer.sh\n'],
      ['scripts/probe-outer.sh', '#!/usr/bin/env bash\nsource scripts/probe-inner.sh\nsource scripts/probe-inner-bs.sh\n'],
      // `$0` 在被 source 的正文里仍是调用者 ⇒ 不求值 ⇒ 脚本位读不懂（fail-closed）。
      ['scripts/probe-inner.sh', '#!/usr/bin/env bash\nbash "$(dirname "$0")/probe-decoy.sh"\n'],
      // `BASH_SOURCE` 族在被 source 时仍指本文件 ⇒ 照常求值（负例：不得误报）。
      ['scripts/probe-inner-bs.sh', '#!/usr/bin/env bash\nbash "${BASH_SOURCE[0]%/*}/probe-ok.sh"\n'],
      ['scripts/probe-decoy.sh', '#!/usr/bin/env bash\necho decoy\n'],
      ['scripts/probe-ok.sh', '#!/usr/bin/env bash\necho ok\n'],
    ])
    const sourcedSurface = ciExecutionSurface({
      workflowTexts: [['.github/workflows/sourced.yml', sourcedFixture.get('.github/workflows/sourced.yml')]],
      rootManifest: {}, rootManifestText: '{}', workspaceManifests: [],
      exists: path => sourcedFixture.has(path),
      read: path => {
        if (!sourcedFixture.has(path)) throw new Error(`ENOENT: no such file or directory, open '${path}'`)
        return sourcedFixture.get(path)
      },
    })
    check(sourcedSurface.problems.some(message =>
      message.includes('scripts/probe-inner.sh') && message.includes('脚本位读不懂')),
      '形态⑨自证: 被 `source` 的脚本里 `$(dirname "$0")/<尾段>` 必须 fail-closed（`$0` 是**调用者**，'
        + ' 不能按本文件目录求值 —— R20A-02 的现场就是"跟随了诱饵文件、真正被执行的那份从不被读"）：'
        + ` 实际 problems=${JSON.stringify(sourcedSurface.problems)}`)
    check(!sourcedSurface.problems.some(message => message.includes('probe-inner-bs.sh')),
      '形态⑨自证（负例）: 被 `source` 的脚本里 `${BASH_SOURCE[0]%/*}/<尾段>` **仍然求值**'
        + `（\`legit-selfstrip\` 那一族不得变成误报）：实际 problems=${JSON.stringify(sourcedSurface.problems)}`)
  }
  // **R20A-03 的三种"同等常规"跨文件写法 + "求值失败不得静默"**（自证）：
  // 每个夹具都是一条"路径常量按模块拆分"的真实写法；修前 `import * as` / `await import()` /
  // CJS `require` 三种整族隐形（模块从不被读），而"导出存在但值求不出"被静默当成没有候选。
  {
    const jsFixture = new Map([
      ['.github/workflows/js-imports.yml',
        'name: js-imports\njobs:\n  a:\n    steps:\n'
        + '      - run: node scripts/probe-ns.mjs\n'
        + '      - run: node scripts/probe-dyn.mjs\n'
        + '      - run: node scripts/probe-cjs.cjs\n'
        + '      - run: node scripts/probe-cond.mjs\n'],
      ['scripts/probe-paths.mjs', "export const ENTRY = 'integration-tests/run-all.sh'\n"],
      ['scripts/probe-paths.cjs', "exports.ENTRY = 'integration-tests/run-all.sh'\n"],
      ['scripts/probe-ns.mjs',
        "import { spawnSync } from 'node:child_process'\n"
        + "import * as PATHS from './probe-paths.mjs'\n"
        + "spawnSync('bash', [PATHS.ENTRY], { stdio: 'inherit' })\n"],
      ['scripts/probe-dyn.mjs',
        "import { spawnSync } from 'node:child_process'\n"
        + "const mod = await import('./probe-paths.mjs')\n"
        + "spawnSync('bash', [mod.ENTRY], { stdio: 'inherit' })\n"],
      ['scripts/probe-cjs.cjs',
        "const { spawnSync } = require('node:child_process')\n"
        + "const { ENTRY } = require('./probe-paths.cjs')\n"
        + "spawnSync('bash', [ENTRY], { stdio: 'inherit' })\n"],
      ['scripts/probe-cond.mjs',
        "import { spawnSync } from 'node:child_process'\n"
        + "import { ENTRY } from './probe-conditional.mjs'\n"
        + "spawnSync('bash', [ENTRY], { stdio: 'inherit' })\n"],
      ['scripts/probe-conditional.mjs',
        "export const ENTRY = process.env.CI ? 'integration-tests/run-all.sh' : 'scripts/probe-noop.sh'\n"],
    ])
    const jsSurface = ciExecutionSurface({
      workflowTexts: [['.github/workflows/js-imports.yml', jsFixture.get('.github/workflows/js-imports.yml')]],
      rootManifest: {}, rootManifestText: '{}', workspaceManifests: [],
      exists: path => jsFixture.has(path),
      read: path => {
        if (!jsFixture.has(path)) throw new Error(`ENOENT: no such file or directory, open '${path}'`)
        return jsFixture.get(path)
      },
    })
    for (const file of ['scripts/probe-ns.mjs', 'scripts/probe-dyn.mjs', 'scripts/probe-cjs.cjs']) {
      check(jsSurface.reached.has(file),
        `形态⑨自证: ${file} 里的跨文件常量（\`import * as\` / \`await import()\` / CJS \`require\`）`
          + '解析出的端到端入口必须被记成 reached —— 修前这三种写法整族隐形（模块从不被读）：'
          + ` 实际 reached=${[...jsSurface.reached.keys()].join(', ')}`)
    }
    check(jsSurface.problems.some(message => message.includes('probe-conditional.mjs')
      && message.includes('求不出来')),
      '形态⑨自证: "模块找到、导出存在、值求不出来"（条件表达式）必须 fail-closed 记 problem ——'
        + ' 修前它被回填成 `[]` ⇒ 既不判红也不跟随（R20A-03 ②）：'
        + ` 实际 problems=${JSON.stringify(jsSurface.problems)}`)
  }
  // 深度上限：包装链超过 {@link CI_SURFACE_MAX_HOPS} 层（`timeout 1` 套 `timeout 1` …）⇒
  // fail-closed（记 problem），**不静默**。
  {
    const layers = CI_SURFACE_MAX_HOPS + 2
    const nested = `${'timeout 1 '.repeat(layers)}make -f wrapper-timeout.mk e2e`
    const deepNest = ciExecutionSurface({
      workflowTexts: [['.github/workflows/deep.yml',
        `name: deep\njobs:\n  a:\n    steps:\n      - run: ${nested}\n`]],
      rootManifest: {}, rootManifestText: '{}', workspaceManifests: [],
      exists: () => false, read: () => '',
    })
    check(deepNest.problems.some(message => message.includes('深度上限')),
      '形态⑨自证: 包装链的层数超过深度上限时必须 fail-closed（记 problem），不静默丢弃：'
        + ` 实际 problems=${JSON.stringify(deepNest.problems)}`)
  }
  // **登记表与包装/载体表不许漂移**（R16-W）：命令位的登记制只认 `CI_COMMAND_REGISTRY` ∪
  // `CI_STANDARD_COMMANDS`，所以包装表里出现的每个词都必须在登记侧出现过一次 —— 否则闭包
  // 一边"会剥它"，一边又判它"未登记"，两张表各说各话。
  {
    const known = word => CI_COMMAND_REGISTRY_BY_WORD.has(word) || CI_STANDARD_COMMANDS.has(word)
    const missing = [...COMMAND_WRAPPER_SPECS.keys(), ...COMMAND_SHELL_WORDS, ...COMMAND_CARRIER_WORDS]
      .filter(word => !known(word))
    check(missing.length === 0,
      '形态⑨自证: 这些词闭包**会剥/会跟随**，却没有出现在命令登记侧（`CI_COMMAND_REGISTRY` ∪ '
        + `\`CI_STANDARD_COMMANDS\`）里：${missing.join(', ')} —— 两张表漂移时，同一个词会一边被当成`
        + '包装、一边被判"未登记"，判据自相矛盾。')
    const duplicated = CI_COMMAND_REGISTRY
      .map(entry => entry.word)
      .filter((word, index, all) => all.indexOf(word) !== index)
    check(duplicated.length === 0,
      `形态⑨自证: \`CI_COMMAND_REGISTRY\` 里有重复词（${duplicated.join(', ')}）—— 登记值必须一一对应`)
    const incomplete = CI_COMMAND_REGISTRY.filter(entry => !entry.why || !entry.approvedBy)
    check(incomplete.length === 0,
      '形态⑨自证: `CI_COMMAND_REGISTRY` 的每条都必须写明"为什么合法 + 由谁批准"：'
        + `${incomplete.map(entry => entry.word).join(', ')}`)
    // R17-X：新加的两张登记表同款纪律（形态读不懂的登记项 + 变量命令位登记项）。
    for (const [label, table] of [
      ['CI_SURFACE_COMMAND_SHAPE_ACK', CI_SURFACE_COMMAND_SHAPE_ACK],
      ['CI_SURFACE_VARIABLE_COMMAND_ACK', CI_SURFACE_VARIABLE_COMMAND_ACK],
    ]) {
      const bad = table.filter(entry => !entry.file || !entry.word || !entry.why
        || (table === CI_SURFACE_COMMAND_SHAPE_ACK && !entry.approvedBy))
      check(bad.length === 0,
        `形态⑨自证: \`${label}\` 的每条都必须写明"哪一处 + 为什么合法 + 由谁批准"：`
          + `${bad.map(entry => `${entry.file}:${entry.word}`).join(', ')}`)
    }
  }
  // 命令位的**登记制**本身必须咬得到（R16-W 的语义反转）：未登记的可执行名 ⇒ problem。
  {
    const unregisteredProbe = ciExecutionSurface({
      workflowTexts: [['.github/workflows/unregistered.yml',
        `name: unregistered\njobs:\n  a:\n    steps:\n      - run: ${'r16a-unknown-runner'} --target\n`]],
      rootManifest: {}, rootManifestText: '{}', workspaceManifests: [],
      exists: path => fixture.has(path), read: path => fixture.get(path) ?? '',
    })
    check(unregisteredProbe.problems.some(message => message.includes('没有登记')),
      '形态⑨自证: 命令位上的**未登记可执行名**必须 fail-closed 记 problem ——'
        + ' 否则"枚举我认识的包装词"还是那个不闭合的黑名单（R16A-06/07/08/11 的根因）：'
        + ` 实际 problems=${JSON.stringify(unregisteredProbe.problems)}`)
  }
  // ---------------------------------------------------------------------
  // **R16-W 的命令位语义自证**（第十六轮：`temp/r16/A/REPORT.md` 的 18 种形态）
  //
  // 修前的判据是"登记一批包装词逐层剥到命令位"，18 种形态证明它不闭合。这一组夹具把
  // **每一种形态**都做成一条独立可归因的接线（各自一个载体文件），拆掉对应修法时，
  // 只有那一条断言会红 —— 免得"四种形态共用一份文件"式的自证被任意一种满足。
  // ---------------------------------------------------------------------
  {
    const r16w = new Map([
      ['.github/workflows/r16w.yml', 'name: r16w\njobs:\n  a:\n    steps:\n'
        + '      - run: env -S "make -f r16w-env.mk e2e"\n'
        + '      - run: env --split-string="make -f r16w-env-eq.mk e2e"\n'
        + '      - run: flock /tmp/r16w.lock make -f r16w-flock.mk e2e\n'
        + '      - run: taskset 0x1 make -f r16w-taskset.mk e2e\n'
        + '      - run: npm exec --call="make -f r16w-calleq.mk e2e"\n'
        + '      - run: npx --call="make -f r16w-npxeq.mk e2e"\n'
        + '      - run: bash --noprofile --norc -c "make -f r16w-longopt.mk e2e"\n'
        + '      - run: xargs -a r16w-args.txt -I{} make -f r16w-xargs.mk e2e\n'
        + '      - run: find . -maxdepth 1 -name README.md -exec make -f r16w-findexec.mk e2e \\;\n'
        + '      - run: poetry run make -f r16w-poetry.mk e2e\n'
        + '      - run: python3 -m r16w_module\n'
        + '      - run: node r16w-runner.cjs\n'
        + '      - run: node -e "$(cat r16w-payload.js)"\n'
        + '      - run: make -f r16w-shellfn.mk e2e\n'
        + '      - run: docker compose -f r16w-anchor.compose.yml run e2e\n'
        + '      - run: docker compose --env-file r16w.env -f r16w-var.compose.yml run e2e\n'],
      ['r16w-args.txt', 'e2e\n'],
      ['r16w_module.py', "import subprocess\nsubprocess.run(['bash', 'integration-tests/run-all.sh'])\n"],
      ['r16w-runner.cjs', "require('node:child_process').spawnSync('bash', ['integration-tests/run-all.sh'])\n"],
      ['r16w-payload.js', "require('node:child_process').spawnSync('bash', ['integration-tests/run-all.sh'])\n"],
      ['r16w.env', 'E2E_ENTRY=integration-tests/run-all.sh\n'],
      ['r16w-anchor.compose.yml',
        'x-cmd: &c\n  - bash\n  - integration-tests/run-all.sh\nservices:\n  e2e:\n'
        + '    image: example/e2e:latest\n    command: *c\n'],
      ['r16w-var.compose.yml',
        'services:\n  e2e:\n    image: example/e2e:latest\n    command: bash ${E2E_ENTRY}\n'],
      ['r16w-shellfn.mk', 'V := $(shell bash integration-tests/run-all.sh)\ne2e:\n\t@true\n'],
    ])
    for (const name of ['env', 'env-eq', 'flock', 'taskset', 'calleq', 'npxeq', 'longopt', 'xargs', 'findexec', 'poetry']) {
      r16w.set(`r16w-${name}.mk`, 'e2e:\n\tbash integration-tests/run-all.sh\n')
    }
    const surface = ciExecutionSurface({
      workflowTexts: [['.github/workflows/r16w.yml', r16w.get('.github/workflows/r16w.yml')]],
      rootManifest: {}, rootManifestText: '{}', workspaceManifests: [],
      exists: path => r16w.has(path), read: path => r16w.get(path) ?? '',
    })
    for (const [file, label] of [
      ['r16w-env.mk', '`env -S \'<命令文本>\'`（R16A-01）'],
      ['r16w-env-eq.mk', '`env --split-string=\'<命令文本>\'`（R16A-01）'],
      ['r16w-flock.mk', '`flock <锁文件> make …`（R16A-02）'],
      ['r16w-taskset.mk', '`taskset <掩码> make …`（R16A-03）'],
      ['r16w-calleq.mk', '`npm exec --call=\'…\'`（R16A-04）'],
      ['r16w-npxeq.mk', '`npx --call=\'…\'`（R16A-04）'],
      ['r16w-longopt.mk', '`bash --noprofile --norc -c \'…\'`（R16A-05）'],
      ['r16w-xargs.mk', '`xargs -a <文件> -I{} make …`（R16A-06）'],
      ['r16w-findexec.mk', '`find … -exec make … \\;`（R16A-07）'],
      ['r16w-poetry.mk', '`poetry run make …`（R16A-08）'],
      ['r16w_module.py', '`python3 -m <模块>`（R16A-09）'],
      ['r16w-runner.cjs', '`node <仓根脚本>`（R16A-09）'],
      ['r16w-shellfn.mk', 'Makefile 顶层 `$(shell …)`（R16A-12）'],
      ['r16w-anchor.compose.yml', 'compose `command: *锚点`（R16A-13）'],
      ['r16w-var.compose.yml', 'compose `command: bash ${VAR}` + `--env-file`（R16A-14）'],
    ]) {
      check(surface.reached.has(file),
        `形态⑨自证: R16-W 形态「${label}」没有被认成"触达端到端入口"（${file}）——`
          + ' 这 18 种形态正是"守卫绿而 CI 真的执行"的现场：'
          + ` 实际 reached=[${[...surface.reached.keys()].join(', ')}]`)
    }
    check(surface.problems.some(message => message.includes('node -e')),
      '形态⑨自证: `node -e "$(cat <文件>)"`（R16A-10）必须 fail-closed（取值来自另一层替换）：'
        + ` 实际 problems=${JSON.stringify(surface.problems).slice(0, 300)}`)
  }
  // ---------------------------------------------------------------------
  // **R17-X 的命令位/间接层自证**（第十七轮 R17A-01…05 的现场）
  //
  // 这一组把**每一种形态做成一条独立可归因的接线**（各自一个载体 Makefile）：拆掉对应修法时
  // 只有那一条断言会红。修前的语义是"取不出可执行名就 `return true`"，于是下面这些形态
  // 守卫全绿而 CI 真的执行到端到端入口（R17A-01/02/03/05 各自实测）：
  //   · R17A-01 —— 命令位首词含 `$`/反引号（`$(echo make)` / `` `echo make` `` / `${M}ke` / `$MAKE`）；
  //   · R17A-02 —— 字符串参数执行面（`eval` / `trap` / here-string / 进程替换 / `command eval`）；
  //   · R17A-03 —— 路径拆词（`D=integration; N=run; bash "$D-tests/$N-all.sh"`）；
  //   · R17A-05 —— 参数位命令位（`ssh <主机> <命令>` / `docker run <镜像> <命令>` / `exec <容器> <命令>`）。
  // ---------------------------------------------------------------------
  {
    const r17x = new Map([
      ['.github/workflows/r17x.yml', 'name: r17x\njobs:\n  a:\n    steps:\n'
        + '      - run: $(echo make) -f r17x-cmdsub.mk e2e\n'
        + '      - run: `echo make` -f r17x-backtick.mk e2e\n'
        + '      - run: M=ma; ${M}ke -f r17x-concat.mk e2e\n'
        + '      - run: |\n          MAKE=make\n          $MAKE -f r17x-varword.mk e2e\n'
        + '      - run: eval \'make -f r17x-eval.mk e2e\'\n'
        + '      - run: trap \'make -f r17x-trap.mk e2e\' EXIT\n'
        + '      - run: bash <<< \'make -f r17x-herestring.mk e2e\'\n'
        + '      - run: command eval \'make -f r17x-command-eval.mk e2e\'\n'
        + '      - run: |\n          D=integration\n          N=run\n          bash "$D-tests/$N-all.sh"\n'
        + '      - run: ssh ci-host make -f r17x-ssh.mk e2e\n'
        + '      - run: docker run --rm example/e2e:latest make -f r17x-docker-run.mk e2e\n'
        + '      - run: docker exec ci-ctr make -f r17x-docker-exec.mk e2e\n'
        + '      - run: python3 -m r17x_mod\n'
        + '      - run: python3 -m pip install --user yamllint\n'
        + '      - run: npx eslint .\n'],
      ['r17x_mod.py', "import subprocess\nsubprocess.run(['bash', 'integration-tests/run-all.sh'])\n"],
      ['integration-tests/run-all.sh', '#!/usr/bin/env bash\nexit 77\n'],
    ])
    for (const name of ['cmdsub', 'backtick', 'concat', 'varword', 'eval', 'trap', 'herestring',
      'command-eval', 'ssh', 'docker-run', 'docker-exec']) {
      r17x.set(`r17x-${name}.mk`, 'e2e:\n\tbash integration-tests/run-all.sh\n')
    }
    const surface = ciExecutionSurface({
      workflowTexts: [['.github/workflows/r17x.yml', r17x.get('.github/workflows/r17x.yml')]],
      rootManifest: {}, rootManifestText: '{}', workspaceManifests: [],
      exists: path => r17x.has(path), read: path => r17x.get(path) ?? '',
    })
    for (const [file, label] of [
      ['r17x-cmdsub.mk', '`$(echo make) <目标>`（命令位是**字面量命令替换**，R17A-01）'],
      ['r17x-backtick.mk', '`` `echo make` <目标> ``（命令位是反引号命令替换，R17A-01）'],
      ['r17x-concat.mk', '`M=ma; ${M}ke <目标>`（**同一段文本内**的赋值 + 拼接，R17A-01）'],
      ['r17x-varword.mk', '`MAKE=make` + `$MAKE <目标>`（整词变量，R17A-01）'],
      ['r17x-eval.mk', '`eval \'<命令文本>\'`（字符串参数执行面，R17A-02）'],
      ['r17x-trap.mk', '`trap \'<命令文本>\' EXIT`（EXIT 钩子，R17A-02）'],
      ['r17x-herestring.mk', '`bash <<< \'<命令文本>\'`（here-string，R17A-02）'],
      ['r17x-command-eval.mk', '`command eval \'<命令文本>\'`（组合形态，R17A-02）'],
      ['r17x-ssh.mk', '`ssh <主机> make <目标>`（参数位命令位，R17A-05）'],
      ['r17x-docker-run.mk', '`docker run <镜像> make <目标>`（参数位命令位，R17A-05）'],
      ['r17x-docker-exec.mk', '`docker exec <容器> make <目标>`（参数位命令位，R17A-05）'],
      ['r17x_mod.py', '`python3 -m <**仓内**模块>`（仓内模块必须解析出载体，R16A-09 不退化）'],
    ]) {
      check(surface.reached.has(file),
        `形态⑨自证: R17-X 形态「${label}」没有被认成"触达端到端入口"（${file}）——`
          + ' 这一族正是 R17A-01/02/05 的现场：命令位/参数位上的可执行名或内层文本**不在任何一张网里**，'
          + ` 守卫绿而 CI 真的执行。实际 reached=[${[...surface.reached.keys()].join(', ')}]`)
    }
    // R17A-03：路径拆成两个变量片段后**正文里逐字既没有 `integration-tests` 也没有 `run-all.sh`**，
    // 常量传播必须把字面量还原出来（否则文本网 0 命中、token 网无路径可跟随、命令位是登记过的 `bash`）。
    check(surface.reached.has('.github/workflows/r17x.yml'),
      '形态⑨自证: 路径拆词（`D=integration; N=run; bash "$D-tests/$N-all.sh"`，R17A-03）没有被认出来 ——'
        + ' 赋值里的字面量必须经**同一段文本内的常量传播**还原成路径，'
        + `否则三张网同时绕过。实际 reached=[${[...surface.reached.keys()].join(', ')}]`)
    // R17A-04 的**误报**面：正当写法（外部 Python 模块 / 包运行器的包内 bin）不得产生 problem。
    check(surface.problems.length === 0,
      '形态⑨自证: R17-X 夹具本身不该产生"读不懂"的 problem（`python3 -m pip` / `npx eslint` 这类'
        + `**正当写法**被误判成未登记/缺载体正是 R17A-04）：实际 problems=${JSON.stringify(surface.problems)}`)
    // fail-closed 的另一半：解析不出来的形态必须**具名**判红（不是"取不出名字就放行"）。
    const r17xBad = new Map([
      ['.github/workflows/r17x-bad.yml', 'name: r17x-bad\njobs:\n  a:\n    steps:\n'
        + '      - run: ${R17X_UNKNOWN}ke -f r17x-bad.mk e2e\n'
        + '      - run: bash <(echo \'make -f r17x-bad.mk e2e\')\n'
        + '      - run: eval "$R17X_UNKNOWN_TEXT"\n'
        + '      - run: npx make -f r17x-bad.mk e2e\n'],
      ['r17x-bad.mk', 'e2e:\n\tbash integration-tests/run-all.sh\n'],
    ])
    const bad = ciExecutionSurface({
      workflowTexts: [['.github/workflows/r17x-bad.yml', r17xBad.get('.github/workflows/r17x-bad.yml')]],
      rootManifest: {}, rootManifestText: '{}', workspaceManifests: [],
      exists: path => r17xBad.has(path), read: path => r17xBad.get(path) ?? '',
    })
    for (const [needle, label] of [
      ['命令位上的首词', '`${UNKNOWN}ke <目标>`（命令位形态读不懂 ⇒ fail-closed）'],
      ['进程替换', '`bash <(echo \'<命令文本>\')`（进程替换的执行面读不懂 ⇒ fail-closed）'],
      ['内层命令读不懂', '`eval "$VAR"`（内层文本读不懂 ⇒ fail-closed）'],
      ['包运行器', '`npx make <目标>`（包运行器遮蔽真命令名 ⇒ fail-closed）'],
    ]) {
      check(bad.problems.some(message => message.includes(needle)),
        `形态⑨自证: R17-X 的反面形态「${label}」必须 fail-closed 且**具名**（诊断里出现 \`${needle}\`）——`
          + ' 这正是 R17A-01 的根因：修前"取不出可执行名"一律放行。'
          + ` 实际 problems=${JSON.stringify(bad.problems).slice(0, 400)}`)
    }
    check(bad.reached.size === 0,
      '形态⑨自证: R17-X 的反面夹具不得触达端到端入口（fail-closed 的意义就在这里）：'
        + ` 实际 reached=[${[...bad.reached.keys()].join(', ')}]`)
  }
  // 闭包的**跟随集**必须覆盖扫描面里的可执行扩展名（VA-05-F2 的同源口径）：
  // 少一个（例如把 `.py` 从派生里摘掉）即红，不需要另一条判据盯着。
  for (const extension of INTEGRATION_SCANNED_EXTENSIONS) {
    if (INTEGRATION_DATA_EXTENSIONS.includes(extension)) continue
    check(CI_SURFACE_SCRIPT_EXTENSIONS.includes(extension),
      `形态⑨自证: 扫描面里的可执行扩展名 \`${extension}\` 不在闭包的跟随集里（`
        + `${CI_SURFACE_SCRIPT_EXTENSIONS.join(', ')}）—— 它会在两张网之间掉出去（VA-05-F2）`)
  }
  // `make` 的**读不懂**必须 fail-closed（否则"把端到端藏进 $() 里"就是新的旁路）。
  const unresolvedMake = ciExecutionSurface({
    workflowTexts: [['.github/workflows/bad-make.yml',
      'name: bad-make\njobs:\n  a:\n    steps:\n      - run: make -C server $(TARGET)\n']],
    rootManifest: JSON.parse(fixture.get('package.json')),
    rootManifestText: fixture.get('package.json'),
    workspaceManifests: [],
    exists: path => fixture.has(path),
    read: path => fixture.get(path) ?? '',
  })
  check(unresolvedMake.problems.length > 0,
    '形态⑨自证: `make` 的目标位写成 `$(TARGET)` 时必须 fail-closed（记 problem），'
      + `实际 problems=${JSON.stringify(unresolvedMake.problems)}`)
  check(surface.problems.length === 0,
    '形态⑨自证: 自证夹具本身不该产生"读不懂"的 problem：'
      + `${JSON.stringify(surface.problems)}`)
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
  note('CI 执行面闭包自证: 直接接线 / `package.json` 别名 / 复合 action / `.sh` 包装链 /'
    + ' `.mjs` spawn 目标 / 变量拼路径的 `.sh` 六种形态全部可区分 ✓')
  // **R18A 的三条 fail-closed**（2026-09-25 第十八轮对抗审计的收口）：三条都必须
  // 具名记 problem，且**不得**触达端到端入口（"没看见"不许当成"这一层没有端到端"）。
  {
    /** 逐层加深的载体链：第 0 层就是端到端入口，越往上越深（用来撞 `CI_SURFACE_MAX_HOPS`）。 */
    const hopChain = new Map()
    const depth = CI_SURFACE_MAX_HOPS + 2
    for (let index = 0; index < depth; index += 1) {
      hopChain.set(`scripts/probe-hop${index}.sh`,
        '#!/usr/bin/env bash\n'
        + (index === 0 ? 'bash integration-tests/run-all.sh\n' : `bash scripts/probe-hop${index - 1}.sh\n`))
    }
    const r18a = new Map([
      ['.github/workflows/r18a.yml', 'name: r18a\njobs:\n  a:\n    steps:\n'
        // ① 脚本位含 `/` 的间接层（R18A-01：修前既不跟随也不判红）
        + '      - run: bash scripts/probe-varpath.sh\n'
        // ② `find -exec` 的脚本位（R18A-02：`{}` 是占位符 ⇒ 读不到那份脚本文本）
        + "      - run: find scripts -maxdepth 1 -name 'probe-varpath.sh' -exec bash {} \\;\n"
        // ③ 超过深度上限的载体链（R18A-04：修前超限节点被静默丢弃）
        + `      - run: bash scripts/probe-hop${depth - 1}.sh\n`],
      ['scripts/probe-varpath.sh', '#!/usr/bin/env bash\nD="$(pwd)/scripts"\nbash "$D/probe-inner.sh"\n'],
      ['scripts/probe-inner.sh', '#!/usr/bin/env bash\nbash integration-tests/run-all.sh\n'],
      ...hopChain,
    ])
    const bad = ciExecutionSurface({
      workflowTexts: [['.github/workflows/r18a.yml', r18a.get('.github/workflows/r18a.yml')]],
      rootManifest: {}, rootManifestText: '{}', workspaceManifests: [],
      exists: path => r18a.has(path), read: path => r18a.get(path) ?? '',
    })
    for (const [needle, label] of [
      ['含 `/` 的变量/命令替换路径', '`bash "$D/x.sh"`（脚本位含 `/` 的间接层 ⇒ fail-closed，R18A-01）'],
      ['`find … -exec', '`find … -exec bash {} \\;`（`-exec` 的脚本位读不到脚本文本 ⇒ fail-closed，R18A-02）'],
      ['深度超过上限', `载体链超过 ${CI_SURFACE_MAX_HOPS} 层（超限节点不得静默丢弃 ⇒ fail-closed，R18A-04）`],
    ]) {
      check(bad.problems.some(message => message.includes(needle)),
        `形态⑨自证: R18A 的收口形态「${label}」必须 fail-closed 且**具名**（诊断里出现 \`${needle}\`）——`
          + ' 修前这三族都是"守卫 EXIT=0 而 CI 真的执行到端到端入口"。'
          + ` 实际 problems=${JSON.stringify(bad.problems).slice(0, 400)}`)
    }
    check(bad.reached.size === 0,
      '形态⑨自证: R18A 的收口形态不得触达端到端入口（fail-closed 的意义就在这里）：'
        + ` 实际 reached=[${[...bad.reached.keys()].join(', ')}]`)
  }
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
    recordLayerVerdict('端到端覆盖面 ↔ CI 执行面：', {
      check: 'text-face', hits: workflowHits.length, declared: E2E_CI_TEXT_HITS_DECLARED,
    })
    check(workflowHits.length === E2E_CI_TEXT_HITS_DECLARED,
      `形态⑨: \`.github/workflows/**\` 对 \`${E2E_CI_REFERENCE_PATTERN.source}\` 的**文本命中** `
        + `${workflowHits.length} 处，而登记值（E2E_CI_TEXT_HITS_DECLARED）是 ${E2E_CI_TEXT_HITS_DECLARED} 处`
        + `\n  命中:${workflowHits.join(', ') || '(无)'}`
        + '\n  ⇒ 本守卫的绿只覆盖**静态面**。命中数变了就必须显式做决定：'
        + '\n     · 接了真机 job（0 → 1）：把 E2E_CI_TEXT_HITS_DECLARED 改成实际命中数，'
        + '并把通过行的 `static-only` 与"CI 内 0 执行"的措辞一起改掉（口径要进 diff 才可评审）；'
        + '\n     · 真机 job 被摘线（1 → 0）：同上反向改回，或恢复那条接线。'
        + '\n     不允许"命中数悄悄变了、通过行照旧写 static-only"。')
    note(`端到端覆盖面（文本面）: \`.github/workflows/**\` 命中 ${workflowHits.length} 处`
      + `（登记 ${E2E_CI_TEXT_HITS_DECLARED}）✓`)
  }

  // ---- 执行面闭包 ---------------------------------------------------------
  // 判据的能力先自证（四/五种执行形态必须被认出来），再在真树上跑。
  ciExecutionSurfaceSelfTest()
  // **R24 FIX-26 / X3-01③**：`workflowJobSteps`（按 **step** 切开 job —— 复合 action 的
  // `uses:` 那一步在 `workflowRunBlocks` 里结构上不存在）与久经考验的 `workflowJobRunBlocks`
  // **逐 workflow 对拍**：两者抽出的 `run:` 块序列必须**逐字节相同**。
  // 切分器是新的（它决定"写在哪一步生效"），一旦与抽取器分叉就必须当场红 ——
  // 不允许"两套解析各说各话"（漂移的后果是写面静默漏判，正是本条缺陷的形态）。
  {
    const drifted = []
    for (const [file, text] of workflowTexts) {
      const legacy = workflowJobRunBlocks(text)
      const stepped = workflowJobSteps(text)
      if (legacy.length !== stepped.length) {
        drifted.push(`${file}: job 数 ${legacy.length} ≠ ${stepped.length}`)
        continue
      }
      legacy.forEach((group, index) => {
        const flat = stepped[index].steps.flatMap(step => step.runs)
        if (group.blocks.join('\u0000') !== flat.join('\u0000')) {
          drifted.push(`${file} job \`${group.job}\`: run 块序列 ${JSON.stringify(group.blocks.map(b => b.slice(0, 24)))}`
            + ` ≠ ${JSON.stringify(flat.map(b => b.slice(0, 24)))}`)
        }
      })
    }
    check(drifted.length === 0,
      `形态⑨: \`workflowJobSteps\`（按 step 切分，写面作用域用它定"哪一步生效"）与 `
        + `\`workflowJobRunBlocks\`（久经考验的抽取器）在 ${drifted.length} 处对不上：\n    `
        + drifted.join('\n    ')
        + '\n  ⇒ 两套解析必须给出同一串 run 块；分叉意味着写面按错的 step 归属判"先写后执行"'
        + '（漏判方向正是 R24 FIX-26 / X3-01 的现场）。')
    note(`写面作用域: workflowJobSteps ↔ workflowJobRunBlocks 对拍 ${workflowTexts.length} 个 workflow 逐字一致 ✓`)
  }
  // **R23 FIX-22 / W4-06**：E-01「写过哪些仓内路径」那一层的**判决级见证** ——
  // 用一份最小的合成 surface（只认样本里出现的路径）跑一遍识别器。
  // 修前这一层没有观测量，`runtimeWrittenCarriers` 首行一行早退即可整层失效（W4-06）。
  const writeDetectorSurface = ciExecutionSurface({
    workflowTexts: [], rootManifest: {}, rootManifestText: '{}', workspaceManifests: [],
    exists: path => RUNTIME_WRITE_DETECTOR_PROBES.some(probe => probe.want.includes(path)),
    read: path => (RUNTIME_WRITE_DETECTOR_PROBES.some(probe => probe.want.includes(path))
      ? '#!/usr/bin/env bash\n'
      : undefined),
  })
  check(witnessed('runtime-write-detector',
    runtimeWriteDetectorProblem(writeDetectorSurface.writeTargets) === undefined),
  '形态⑨: E-01 的**写目标识别器**合成样本自证不成立 ——'
    + ` ${runtimeWriteDetectorProblem(writeDetectorSurface.writeTargets)}`
    + '\n  ⇒ 这一格是"先写后执行"那一族的唯一实现；把它掏空（首行 `return written` 之类）'
    + '必须当场可见，而不是只靠 `scripts/check-root-guards.mjs` 的字节登记值兜'
    + '（R23 FIX-22 / W4-06：修前掏空该层仍 `EXIT=0`）。')
  // **R23 FIX-22 / W4-04 / W4-07**：E-02 两条新子判据的**判决级见证** —— 修前它们各自
  // 一行早退（`return undefined` / `const witnessCalls = 1`）即可整层失效而 `EXIT=0`。
  check(witnessed('constant-block-header', constantBlockHeaderProbeProblem() === undefined),
    '形态⑨: E-02 的**块头常量折叠**判据合成样本自证不成立 ——'
      + ` ${constantBlockHeaderProbeProblem()}`
      + "\n  ⇒ 这一格必须能挡住 `if (false) {` / `if (process.env.X === 'never') {` /"
      + ' `} else {` / `for (const x of []) {` 四种容器（R23 FIX-22 / W4-04）。')
  check(witnessed('witness-callsite-counter', witnessCallSiteProbeProblem() === undefined),
    '形态⑨: E-02 的**见证调用点计数**判据合成样本自证不成立 ——'
      + ` ${witnessCallSiteProbeProblem()}`
      + '\n  ⇒ 折行诱饵（把 `witnessed(` 与 id 折成两行）必须算作第二个调用点'
      + '（R23 FIX-22 / W4-04）。')
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
            note(`CI 执行面闭包: ${dir}/package.json 解析失败（非 JSON）—— 该工作区的别名未纳入闭包`)
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
      // `make` 间接的**读不懂**必须 red（VA-05-F1 的收口纪律）：闭包只跟随它能静态解析的
      // 执行形态，解析不出的（值位/目标位含变量、Makefile 读不到、目标找不到、`include`
      // 解析不出）一律 fail-closed —— 否则"把端到端藏进一层 make"就只是换了个写法。
      check(surface.problems.length === 0,
        `形态⑨: CI 执行面闭包里有 ${surface.problems.length} 处**读不懂的执行形态**（fail-closed）：`
          + `\n    ${surface.problems.join('\n    ')}`
          + '\n  ⇒ 闭包跟随 `make [-C <dir>] [-f <file>] <目标>` 一层层读到配方体；'
          + ' 读不懂的形态不许当成"这一层没有端到端"（第十四轮 V14-A 的 VA-05-F1 正是'
          + ' "多一层 make ⇒ 三张网全绿"）。把它写成字面量，或把目标体搬到闭包能读到的 Makefile 里。')
      // 反向（**死条目双向对账**，与 `E2E_CI_SURFACE_REGISTRY` 同款纪律）：命令位登记表里的
      // 每一条都必须**这次真的被闭包命中过** —— 某个工具从 CI 里删掉、或登记表里塞了一条
      // 假条目，都会让这张表看起来比实际宽，必须跟着改。
      const deadCommands = CI_COMMAND_REGISTRY.filter(entry => !surface.commandWords.has(entry.word))
      check(deadCommands.length === 0,
        `形态⑨: \`CI_COMMAND_REGISTRY\` 里这些登记项**这次闭包扫描一次都没命中**（${deadCommands.length} 条）：`
          + ` ${deadCommands.map(entry => entry.word).join(', ')}`
          + '\n  ⇒ 登记表只允许登记"CI 入口命令位上真的出现过"的非标准命令：'
          + '某个工具被删掉/改名之后，这条认账就成了"说自己还在看着一个早就不存在的用法"，'
          + '请同步删掉它（死条目会让登记表看起来比实际宽）。')
      // 正向的另一半：闭包这次真的见过多少**非标准**命令（读者一眼能看出登记表的覆盖面）。
      const observedNonStandard = [...surface.commandWords]
        .filter(word => !CI_STANDARD_COMMANDS.has(word) && !COMMAND_CARRIER_WORDS.has(word)).sort()
      check(observedNonStandard.every(word => CI_COMMAND_REGISTRY_BY_WORD.has(word)),
        '形态⑨: CI 入口命令位上出现了**未登记**的非标准可执行名：'
          + ` ${observedNonStandard.filter(word => !CI_COMMAND_REGISTRY_BY_WORD.has(word)).join(', ')}`)
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
      recordLayerVerdict('端到端覆盖面 ↔ CI 执行面：', {
        check: 'execution-face', real: classified.real.length,
        declared: E2E_CI_REAL_SURFACE_FILES_DECLARED, reached: surface.reached.size,
        mentioning: surface.mentioning.size,
      })
      check(witnessed('real-surface', classified.real.length === E2E_CI_REAL_SURFACE_FILES_DECLARED),
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
      // 反向（**死条目双向对账**，与 E2E_CI_SURFACE_REGISTRY 同款纪律）：包装链尽头的变量
      // 命令位登记项必须**仍然真的命中** —— 变量被改名/那行被删掉之后，这条认账就成了
      // "说自己还在看着一个早就不存在的洞"，必须跟着删。
      const hitVariableCommands = new Set([
        ...surface.variableCommands.map(item => `${item.file}\u0000${item.word}`),
        // R18A-01：脚本位那一族共用同一张登记表（命令位 / 脚本位都是"读不懂的执行位"）。
        ...surface.shellArguments.map(item => `${item.file}\u0000${item.word}`),
        // R20A-05：同一张表的第三个来源 —— "脚本位指向仓内不存在的字面路径"
        // （登记表不同、命中集合并入这里，死条目对账的写法保持一份）。
        ...surface.generatedScripts.map(item => `${item.file}\u0000${item.word}`),
      ])
      for (const entry of CI_SURFACE_VARIABLE_COMMAND_ACK) {
        check(hitVariableCommands.has(`${entry.file}\u0000${entry.word}`),
          `形态⑨: \`CI_SURFACE_VARIABLE_COMMAND_ACK\` 里的登记项 ${entry.file} 的 \`${entry.word}\` `
            + '已经不再命中（那一行被删/被改名/被写成字面量）—— 死条目会让认账表看起来比实际宽，'
            + '请在改掉那处写法时同步删掉这条登记。')
      }
      for (const entry of CI_SURFACE_GENERATED_SCRIPT_ACK) {
        check(hitVariableCommands.has(`${entry.file}\u0000${entry.word}`),
          `形态⑨: \`CI_SURFACE_GENERATED_SCRIPT_ACK\` 里的登记项 ${entry.file} 的 \`${entry.word}\` `
            + '已经不再命中（那一行被删/被改名，或那个路径现在真的存在于仓里了）—— 死条目会让认账表'
            + '看起来比实际宽，请在改掉那处写法时同步删掉这条登记。')
      }
      // 同上（R17-X）：**命令位形态读不懂**的登记项也要真的命中过。
      const hitCommandShapes = new Set(surface.commandShapes.map(item => `${item.file}\u0000${item.word}`))
      for (const entry of CI_SURFACE_COMMAND_SHAPE_ACK) {
        check(hitCommandShapes.has(`${entry.file}\u0000${entry.word}`),
          `形态⑨: \`CI_SURFACE_COMMAND_SHAPE_ACK\` 里的登记项 ${entry.file} 的 \`${entry.word}\` `
            + '已经不再命中（那一行被删/被改名/被写成闭包能解析的字面量）—— 死条目会让认账表看起来'
            + '比实际宽，请在改掉那处写法时同步删掉这条登记。')
      }
      note(`CI 执行面闭包: ${surface.nodes.length} 个节点、`
        + `触达端到端入口的来源 ${new Set([...surface.mentioning.keys(), ...surface.reached.keys()]).size} 个（真实 ${classified.real.length} / `
        + `合成 SKIP 探针 ${classified.synthetic.length} / 未登记 ${classified.unregistered.length}）、`
        + `命令位可执行名 ${surface.commandWords.size} 个（非标准 ${observedNonStandard.length} 个，登记 ${CI_COMMAND_REGISTRY.length} 条）✓`)
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

/**
 * **判决观测的重新判决表**（R19A-03 的收口①）：覆盖层标签 → `{ judge, min }`。
 *
 * `judge(observation)` 判"这条命令**成立**吗"，`min()` 给出该层**至少**要交出多少条原始观测
 * （表长、腿数、场景数…）。两条都不看 `coverageWitness` 的尝试计数 —— 计数只说明"我跑过"。
 *
 * 为什么每层都要有：R19A 实测 9 个无见证层可以整层掏空（循环改 `of []`）而标签里的动态计数
 * 一字不变（那些数字是**表长**，不是执行痕迹）。观测写在循环体内之后，掏空循环 ⇒ 观测为 0 ⇒
 * 收尾的 `min()` 判红。
 */
const LAYER_VERDICT_RULES = new Map([
  ['语法', {
    min: () => pyFiles.length + mjsFiles.length + 2,
    judge: o => (o.expectRed === true ? o.redFlagged === true : o.problem === undefined),
  }],
  ['登记制', {
    min: () => INTEGRATION_ENTRIES.length + 2,
    judge: o => {
      if (o.check === 'registered-on-disk') return o.onDisk === true
      if (o.check === 'disk-registry-diff') return o.unregistered === 0 && o.stale === 0
      if (o.check === 'aggregate-wiring' || o.check === 'aggregate-reverse') return o.wired === true || o.matched === true
      if (o.check === 'contract-flags') return o.missing === 0
      return o.check === 'registry-summary' && o.onDisk > 0
    },
  }],
  ['引用面扩展名对账', {
    min: () => 1,
    judge: o => o.unregistered === 0 && o.dead === 0 && o.present > 0,
  }],
  ['聚合层接线', {
    min: () => INTEGRATION_ENTRIES.filter(entry => typeof entry.aggregateName === 'string').length,
    judge: o => o.wired === true,
  }],
  ['判别力下限', {
    min: () => 1,
    judge: o => {
      if (o.check === 'group-floor') return o.judgments >= o.floor
      // R22 FIX-14 / E-02：常量必须与登记表逐条算出的下限同源且为正（收尾重新判决一份）。
      if (o.check === 'group-floor-definition') return o.floor === o.declared && o.floor > 0
      if (o.check === 'contract-rows') return o.minJudgments === o.rows
      return o.check === 'judged-runner-rows' && o.rows !== null && o.minJudgments === o.rows
    },
  }],
  ['环境缺失的原因码登记制', {
    min: () => INTEGRATION_ENTRIES.filter(entry => Array.isArray(entry.skipReasons) && entry.skipReasons.length > 0).length,
    judge: o => o.outlets === 1 && o.bare === 0 && o.declared === o.used && o.used !== '',
  }],
  ['契约判据表', {
    min: () => CONTRACT_TESTS.length,
    judge: o => o.idsMatch === true && o.reportedFixtures === o.fixtures,
  }],
  ['契约判据本体自证', {
    min: () => CONTRACT_TESTS.length,
    judge: o => {
      // FIX-45 ①③：`follow()` 对 Location 三形态（相对/绝对/深链）的**纯单元级**自证。
      if (o.check === 'redirect-forms') {
        return o.status === 0 && o.formsJudged >= 3 && o.formsPassed === o.formsJudged
      }
      return o.status === 0 && o.ok === o.total && o.total >= o.minCases
    },
  }],
  ['契约判定通道自证', {
    min: () => CONTRACT_TESTS.length,
    judge: o => o.status === 0 && o.ok === o.total && o.total > 0,
  }],
  ['契约端到端变异', {
    // 逐条判据变异（`expectedIds` 的合计）+ 判定通道变异；两类都必须逐条留痕。
    min: () => [...CONTRACT_CRITERIA.values()].reduce((sum, rows) => sum + rows.length, 0) + 1,
    judge: o => o.status !== 0 && o.named === true,
  }],
  ['electron-shots', {
    min: () => 2,
    judge: o => (o.check === 'assertions-table'
      ? o.assertions >= 8 && o.fixtures >= o.assertions * 2 && o.selfTestStatus === 0 && o.selfTestOk === o.selfTestTotal
      : o.status !== 0 && o.named === true),
  }],
  ['假网关场景', {
    min: () => SCENARIOS.length + 1,
    // `negative-control` 那一条**必须**有违规（"这一层真的会红"的正向证据）；真跑的场景相反。
    judge: o => (o.check === 'negative-control' ? o.violations.length > 0 : o.violations.length === 0),
  }],
  ['聚合层三项全 SKIP ⇒ 77 且不报 PASS', {
    min: () => 1,
    judge: o => o.status === 77 && o.reportedSkip === true && o.reportedPass === false,
  }],
  ['端到端覆盖面 ↔ CI 执行面：', {
    min: () => 2,
    judge: o => (o.check === 'text-face' ? o.hits === o.declared : o.real === o.declared),
  }],
])
// **R19A 自检样本**（R19A-01/02/04 三处修法的回归判据 + R19A-03 的判决规则负例自证）：
// 放在**失败判定之前**跑 —— 否则自检失败的 `fail()` 会落在已经打印过的失败清单之外。
roundNineteenSelfTest()
// **R20A 自检样本**（R20A-01 脚本位取词 / R20A-02 被 source 的 `$0` / R20A-04 判决见证）：
// 同样放在失败判定之前。R20A-03 的集成面自证在 `ciExecutionSurfaceSelfTest` 里（那片夹具
// 机制就在那里），R20A-05 也是。
roundTwentySelfTest()

// ---------------------------------------------------------------------------
for (const dir of scratchDirs) {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // 清理失败不影响判据结论
  }
}
for (const item of notes) {
  process.stdout.write(`check-integration-tests: ${item.text} ${item.ok ? '✓' : '✗'}\n`)
}
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
/**
 * 覆盖层的**稳定标签**（按序，唯一真源）——第十八轮 R18A-G-07 的收口件①。
 *
 * ## 现场
 *
 * 修前"层数自洽"只绑**条数**（`COVERED_LAYERS.length === EXPECTED_COVERED_LAYERS`）：
 * 把某一层的声明换成**无关散文**、或把某一层复制一份，条数都不变 ⇒
 * `check-integration-tests` 与 `check-doc-claims` 全绿，而通过行照旧宣称"已覆盖 14 项"。
 * 条数是"有几层"，不是"哪几层"—— 通过了条数对拍不等于这些层还在判东西。
 *
 * ## 判据
 *
 * 下面这张表是**层标签集合**（逐条、按序）；通过行的枚举必须**逐条以对应标签开头**，
 * 且条数与登记值 {@link EXPECTED_COVERED_LAYERS} 一致。于是：
 *   · 换标签、换层序、复制某一层、把某一层换成散文 ⇒ 逐条对拍当场红；
 *   · 把某一层的 `check(...)` 掏空只留标签 ⇒ 该层的**执行见证**
 *     （{@link coverageWitness}，由该层实现自己写入、写进标签）停在初值 ⇒ 红。
 */
const COVERED_LAYER_LABELS = [
  '语法',
  '登记制',
  '引用面扩展名对账',
  '聚合层接线',
  '判别力下限',
  '环境缺失的原因码登记制',
  '契约判据表',
  '契约判据本体自证',
  '契约判定通道自证',
  '契约端到端变异',
  'electron-shots',
  '假网关场景',
  '聚合层三项全 SKIP ⇒ 77 且不报 PASS',
  '端到端覆盖面 ↔ CI 执行面：',
]
const COVERED_LAYERS = [
  `语法（${pyFiles.length} 个 .py ast.parse / ${mjsFiles.length} 个 .mjs node --check）`,
  `登记制（${INTEGRATION_ENTRIES.length} 项：登记了不在 / 在却没登记 / 聚合层少调多调或换序 全红）`,
  `引用面扩展名对账（本守卫引用的 ${INTEGRATION_SCANNED_EXTENSIONS.join('/')} 之外的落盘路径必须逐条登记，否则红）`,
  `聚合层接线（${INTEGRATION_ENTRIES.filter(entry => entry.aggregateName !== undefined).length} 条逐字对拍）`,
  `判别力下限（聚合层 ${GROUP_MIN_JUDGMENTS} 条判定：接进聚合层的腿必须给出机器可读判定清单，零判定的条目红）`,
  `环境缺失的原因码登记制（闭集 ${SKIP_REASON_CODES.size} 个：源码声明 / 调用点 / 唯一出口 双向对账 + 真跑一次确认具名）`,
  `契约判据表（${CONTRACT_TESTS.map(test => `${test.id} ${(CONTRACT_CRITERIA.get(test.id) ?? []).length} 条`).join(' / ')}：`
    + '精确 id 集合 + 逐 id 正负例条数 + 运行期逐条引用 + 观测非空）',
  `契约判据本体自证（--self-test，${coverageWitness.contractSelfTestFixtures} 条夹具逐条正/负例）`,
  `契约判定通道自证（--self-check，${coverageWitness.contractSelfCheckFixtures} 条夹具经**运行期** report() 求值）`,
  `契约端到端变异（${coverageWitness.contractMutations} 条判据逐条掏成恒真、judge 恒真 / 只改计票侧 / 运行期通道换恒真包装 —— 全部必须变红）`,
  `electron-shots（${coverageWitness.electronShotsAssertions} 条判据：接线 + SKIP(77) 契约 + 判据表自检 + 判定通道自检 + 4 条判定通道变异）`,
  `假网关场景（${SCENARIOS.length} 条：正例必须绿 / 变异必须红 / 环境缺失必须 SKIP 且不得报 PASS）`,
  `聚合层三项全 SKIP ⇒ 77 且不报 PASS（实测 exit ${coverageWitness.aggregateSkipExit}）`,
  `端到端覆盖面 ↔ CI 执行面：文本面命中 ${E2E_CI_TEXT_HITS_DECLARED} 处、`
    + `执行面闭包（workflow \`run:\` 命令位 → 本地复合 action → manifest scripts 别名 → 仓内包装脚本/`
    + `\`spawn\`·\`exec\` 目标）真实接线 ${E2E_CI_REAL_SURFACE_FILES_DECLARED} 处（均为登记值，变了即红）；`
    + `同一条判据下的**命令位登记制**（${CI_COMMAND_REGISTRY.length} 条本仓非标准命令 + `
    + `${CI_STANDARD_COMMANDS.size} 个标准词：未登记即红、登记了却不再命中（死条目）也红）与`
    + '**闭包跟随面**（仓内任何被跟踪路径出现在命令/参数位都要么跟随要么登记：make 目标体与 '
    + '`$(shell …)`、compose `command`·`entrypoint`·锚点·插值、仓内脚本、`python -m` 模块、`node -e` 源码）；'
    + `**命令位形态**（R17-X：含 \`$\`/反引号的词按**同一段文本内的常量传播**解析，解析不出即 `
    + `fail-closed；字符串参数执行面 \`eval\`/\`trap\`/here-string/进程替换、参数位命令位 `
    + `\`ssh\`/\`docker run\`·\`exec\` 同网；形态读不懂的登记项 ${CI_SURFACE_COMMAND_SHAPE_ACK.length} 条、`
    + `包运行器的包内 bin 与外部 \`python -m\` 模块按"外部命名空间"处理）`,
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
// **层标签集合**（R18A-G-07）：条数对上还不够 —— 逐条标签必须**按序**出现在通过行里。
// 修前只绑条数，于是"把某一层换成无关散文 / 复制某一层"都能让守卫照旧宣称"已覆盖 14 项"。
if (COVERED_LAYER_LABELS.length !== EXPECTED_COVERED_LAYERS
  || COVERED_LAYERS.length !== COVERED_LAYER_LABELS.length) {
  process.stderr.write(`\ncheck-integration-tests: 层标签登记表 ${COVERED_LAYER_LABELS.length} 项 / `
    + `通过行枚举 ${COVERED_LAYERS.length} 项 / 登记值 ${EXPECTED_COVERED_LAYERS} 项 —— `
    + '三者必须一致（层数是"有几层"，标签集合才是"哪几层"）\n')
  return 1
}
for (const [index, label] of COVERED_LAYER_LABELS.entries()) {
  if (String(COVERED_LAYERS[index]).startsWith(label)) continue
  process.stderr.write(`\ncheck-integration-tests: 通过行第 ${index + 1} 层不是登记的层标签 ——\n`
    + `  期望以 ${JSON.stringify(label)} 开头\n  实际 ${JSON.stringify(COVERED_LAYERS[index])}\n`
    + '  ⇒ 覆盖层是**逐条登记**的：换标签、换层序、复制一层、把某一层换成散文，都会让'
    + '"已覆盖 N 项"这句话与实际判过的层不一致（R18A-G-07 的现场）\n')
  return 1
}
// **执行见证**（R18A-G-07 的第二半）：静态标签层必须由**自己的实现**写出见证明细 ——
// 把某一层的 `check(...)` 掏空、只留标签时，这里的值会停在初值 ⇒ 红（不是"标签还在所以绿"）。
for (const [id, expected, witness] of [
  ['契约判据本体自证', '合同脚本 --self-test 实跑的夹具总数 > 0', coverageWitness.contractSelfTestFixtures > 0],
  ['契约判定通道自证', '合同脚本 --self-check 经运行期通道求值的夹具总数 > 0', coverageWitness.contractSelfCheckFixtures > 0],
  ['契约端到端变异', '真的跑过的逐条判据变异数 > 0', coverageWitness.contractMutations > 0],
  ['electron-shots', '判据表的判据条数 ≥ 1', coverageWitness.electronShotsAssertions >= 1],
  ['聚合层三项全 SKIP ⇒ 77 且不报 PASS', '聚合层实跑退出码 = 77', coverageWitness.aggregateSkipExit === 77],
]) {
  if (witness) continue
  process.stderr.write(`\ncheck-integration-tests: 覆盖层「${id}」没有**执行见证**（${expected}）——\n`
    + `  实际 ${JSON.stringify(coverageWitness)}\n`
    + '  ⇒ 通过行可以宣称这一层，但它必须由该层的实现自己写出见证值：'
    + '把 check(...) 掏空、只留标签的形态，靠"标签还在"是拦不住的（R18A-G-07）\n')
  return 1
}
/**
 * **第二十轮 R20A 三条收口的自检样本**（R20A-01 脚本位取词 / R20A-02 被 source 的 `$0` /
 * R20A-04 判决见证）。
 *
 * 与 {@link roundNineteenSelfTest} 同款纪律：样本都喂给**生产路径上的同一个函数**，
 * 任一格不成立即 `fail()` ⇒ 守卫红。每一族都配**正例 + 负例**：
 *   · R20A-01：`--` / 带取值的旗标必须被消费掉（正例），而"不带取值的旗标"不得吃掉脚本位、
 *     正当的 `bash scripts/x.sh` 不得记红（负例）；
 *   · R20A-02：被 source 时 `$0` 族不求值（正例 = 红），`BASH_SOURCE` 族照旧求值（负例 = 绿）；
 *   · R20A-04：`witnessed` 必须真的记一次执行并把判决原样交回。
 */
function roundTwentySelfTest() {
  const cases = []
  const procsub = text => `${SHELL_PROCSUB_MARKER}${text}`
  // ---- R20A-01：脚本位取词（`--` 与"带取值的旗标"）------------------------------------
  cases.push(['脚本位取词：`--` 是**选项结束标记**（必须消费掉再取脚本位）',
    shellScriptWordIndex(['bash', '--', '$P'], 0).scriptIndex === 2
    && shellScriptWordIndex(['bash', '--', '$P'], 0).terminated === true])
  cases.push(['脚本位取词：**带取值的旗标**要连取值一起跳过'
    + '（`-O extglob` / `-Oextglob` / `--rcfile 文件` / `--rcfile=文件` / `-o 选项`）',
    shellScriptWordIndex(['bash', '-O', 'extglob', '$P'], 0).scriptIndex === 3
    && shellScriptWordIndex(['bash', '-Oextglob', '$P'], 0).scriptIndex === 2
    && shellScriptWordIndex(['bash', '--rcfile', '/x', '$P'], 0).scriptIndex === 3
    && shellScriptWordIndex(['bash', '--rcfile=/x', '$P'], 0).scriptIndex === 2
    && shellScriptWordIndex(['dash', '-o', 'posix', '$P'], 0).scriptIndex === 3])
  cases.push(['脚本位取词：`-c` 的取值是**命令文本**（不是脚本位）',
    shellScriptWordIndex(['bash', '-c', 'make x'], 0).commandText?.text === 'make x'
    && shellScriptWordIndex(['bash', '-lc', 'make x'], 0).commandText?.text === 'make x'
    && shellScriptWordIndex(['bash', '-c', 'make x'], 0).scriptIndex === -1])
  cases.push(['脚本位取词（负例）：**不带取值**的旗标不得吃掉脚本位',
    shellScriptWordIndex(['bash', '-e', 'scripts/x.sh'], 0).scriptIndex === 2
    && shellScriptWordIndex(['bash', '--noprofile', '--norc', 'scripts/x.sh'], 0).scriptIndex === 3
    && shellScriptWordIndex(['sh', '-eu', 'scripts/x.sh'], 0).scriptIndex === 2])
  cases.push(['脚本位缺失（`bash` / `bash -e` / `bash --`）⇒ fail-closed 且具名',
    ['bash', 'bash -e', 'bash --'].every(line =>
      unwrapCommandWords(line.split(' '), false).problems
        .some(problem => problem.kind === 'shell-argument-unreadable' && problem.message.includes('脚本位缺失')))])
  cases.push(['脚本位被 `--` / 取值位掩蔽（`bash -- "$P"` / `bash -O extglob "$P"`）'
    + '⇒ 解释器分支 fail-closed（R20A-01 的现场：修前两者都不进判据）',
    unwrapCommandWords(['bash', '--', '$P'], false).problems.some(problem => problem.kind === 'shell-argument-unreadable')
    && unwrapCommandWords(['bash', '-O', 'extglob', '$P'], false).problems.some(problem => problem.kind === 'shell-argument-unreadable')
    && unwrapCommandWords(['bash', '-O', 'extglob', '$P'], false).problems
      .some(problem => problem.message.includes('变量/命令替换'))])
  cases.push(['`source` / `.` 的脚本位与解释器**同一份取词**：`source -- "$P"` 红、'
    + '`source scripts/x.sh` 绿（负例：正当写法不得误报）',
    unwrapCommandWords(['source', '--', '$P'], false).problems.some(problem => problem.kind === 'shell-argument-unreadable')
    && unwrapCommandWords(['source', 'scripts/x.sh'], false).problems.length === 0
    && unwrapCommandWords(['.', 'scripts/x.sh'], false).problems.length === 0])
  cases.push(['`find … -exec <shell> <脚本位>` 与解释器**同一份取词**：'
    + '`-exec bash -- {} \\;` 红、`-exec bash {} \\;` 红（`{}` 是占位符）、`-exec bash x.sh \\;` 绿',
    unwrapCommandWords(['find', 'scripts', '-maxdepth', '1', '-exec', 'bash', '--', '{}', ';'], false)
      .problems.some(problem => problem.kind === 'shell-argument-unreadable')
    && unwrapCommandWords(['find', 'scripts', '-exec', 'bash', '{}', ';'], false)
      .problems.some(problem => problem.kind === 'shell-argument-unreadable')
    && unwrapCommandWords(['find', 'scripts', '-exec', 'bash', 'scripts/x.sh', ';'], false).problems.length === 0])
  cases.push(['进程替换的脚本位判定复用同一份取词（`bash -c \'<文本>\' <(…)` 的那一位是 `$0`，'
    + '不是脚本位；`bash -- <(…)` 是脚本位）',
    shellProcsubIsScriptPosition(['bash', '-c', 'make x', procsub('<(cat f)')], 3) === false
    && shellProcsubIsScriptPosition(['bash', '--', procsub('<(cat f)')], 2) === true])
  // ---- R20A-02：`$0` 只在**被执行**时成立 ----------------------------------------------
  cases.push(['自指脚本位：`$0` 族在**被 source** 的正文里不求值（`$0` 是调用者，R20A-02）',
    selfReferentialScriptCandidates('$(dirname $0)/x.sh', 'a/b/w.sh', { executed: false }).length === 0
    && selfReferentialScriptCandidates('$0', 'a/b/w.sh', { executed: false }).length === 0])
  cases.push(['自指脚本位（负例）：`BASH_SOURCE` 族在**被 source** 时**仍然求值**'
    + '（`legit-selfstrip` 必须保持绿）',
    selfReferentialScriptCandidates('${BASH_SOURCE[0]%/*}/x.sh', 'a/b/w.sh', { executed: false }).join(',') === 'a/b/x.sh'
    && selfReferentialScriptCandidates('$(dirname ${BASH_SOURCE[0]})/x.sh', 'a/b/w.sh', { executed: false }).join(',') === 'a/b/x.sh'])
  cases.push(['自指脚本位（负例）：**被执行**时 `$0` 族照旧求值（`legit-dirname0` 必须保持绿）',
    selfReferentialScriptCandidates('$(dirname $0)/x.sh', 'a/b/w.sh', { executed: true }).join(',') === 'a/b/x.sh'
    && selfReferentialScriptCandidates('$(dirname $0)/x.sh', 'a/b/w.sh').join(',') === 'a/b/x.sh'])
  cases.push(['词数组入口：被 source 的正文里 `$0` 族的词**原样保留**（⇒ 词法阶段 fail-closed），'
    + '`BASH_SOURCE` 族被换成仓内候选',
    (() => {
      const context = executed => ({
        selfFile: 'a/b/w.sh', executed,
        resolve: path => (path === 'a/b/x.sh' ? path : undefined),
      })
      const dollar = shellCommandWordListsFor('bash "$(dirname "$0")/x.sh"', context(false))[0]
      const source = shellCommandWordListsFor('bash "${BASH_SOURCE[0]%/*}/x.sh"', context(false))[0]
      const executed = shellCommandWordListsFor('bash "$(dirname "$0")/x.sh"', context(true))[0]
      return dollar.includes('$(dirname $0)/x.sh') && source.includes('a/b/x.sh') && executed.includes('a/b/x.sh')
    })()])
  // ---- R20A-04：判决见证（`witnessed`）--------------------------------------------------
  {
    const before = JUDGMENT_RUNS.get('self-test-witness-probe') ?? { runs: 0, passed: 0, failed: 0 }
    const verdict = witnessed('self-test-witness-probe', true)
    const after = JUDGMENT_RUNS.get('self-test-witness-probe') ?? { runs: 0, passed: 0, failed: 0 }
    cases.push(['判决见证：`witnessed` 必须**记一次执行 + 记判决值**并把判决**原样交回**（R20A-04；'
      + 'R21 fix-6 / E-02 把"只记次数"改成"`runs`/`passed`/`failed` 分开记"）',
    verdict === true && after.runs === before.runs + 1 && after.passed === before.passed + 1
      && witnessed('self-test-witness-probe', false) === false])
    // **R21 fix-6 / E-02 的自证**：三条新收口各自的负例。
    {
      const failedBefore = JUDGMENT_RUNS.get('self-test-witness-probe')?.failed ?? 0
      witnessed('self-test-witness-probe', false)
      cases.push(['判决见证：`false` 判决必须记进 `failed`（"判成什么"与"跑过没有"分开记）',
        (JUDGMENT_RUNS.get('self-test-witness-probe')?.failed ?? 0) === failedBefore + 1])
    }
    {
      const violationsBefore = JUDGMENT_CONTRACT_VIOLATIONS.length
      const nonBoolean = witnessed('self-test-witness-nonboolean', undefined)
      cases.push(['判决见证（负例）：**非布尔判决值**必须当场记违约（`witnessed(id)` 这种只计数的'
        + '调用不是一个判决）',
      nonBoolean === false && JUDGMENT_CONTRACT_VIOLATIONS.length === violationsBefore + 1])
      JUDGMENT_CONTRACT_VIOLATIONS.pop()
    }
    cases.push(['判决见证（负例）：**没执行过**的判决点必须被认出来（"文本在场、判决没跑"）',
      judgmentSitesWithoutRuns([{ id: 'self-test-witness-probe' }], JUDGMENT_RUNS).length === 0
      && judgmentSitesWithoutRuns([{ id: 'self-test-never-run' }], JUDGMENT_RUNS).length === 1])
    // **判决位形态**（R21 fix-6 / E-02 的第二段b）：三种掏空形态逐条自证，
    // 以及一条正例（行首的独立语句不得误报）。
    {
      const needle = "check(witnessed('x', ok),"
      const legit = `{\n  // 注释\n  ${needle}\n    'why')\n}\n`
      const sameLine = `{\n  if (false) ${needle}\n    'why')\n}\n`
      const danglingIf = `{\n  if (false)\n  ${needle}\n    'why')\n}\n`
      const danglingAnd = `{\n  ok &&\n  ${needle}\n    'why')\n}\n`
      cases.push(['判决见证（R21/E-02）：判决句必须是**行首的独立语句** —— '
        + '`if (false) check(witnessed(…))` / 上一行悬挂 `if (…)` / 上一行以 `&&` 结尾 三种掏空形态'
        + '逐条判红，行首的正常写法不误报',
      judgmentNeedleStatementProblem(legit, needle) === undefined
        && judgmentNeedleStatementProblem(sameLine, needle) !== undefined
        && judgmentNeedleStatementProblem(danglingIf, needle) !== undefined
        && judgmentNeedleStatementProblem(danglingAnd, needle) !== undefined])
    }
  }
  const broken = cases.filter(([, ok]) => !ok)
  for (const [label, ok] of cases) {
    if (!ok) fail(`R20A 自检样本不成立：${label}`)
  }
  check(cases.length >= 12, `R20A 自检样本只有 ${cases.length} 条（下限 12）—— 自检被删到没有判别力`)
  if (broken.length === 0) {
    note(`R20A 自检样本: ${cases.length} 条（R20A-01 脚本位取词 / R20A-02 被 source 的 \`$0\` / `
      + 'R20A-04 判决见证 —— 含 **R21 fix-6 / E-02** 的三条新收口：判决值分开记、判决位必须是'
      + '行首的独立语句、返回契约逐 id 自证）✓')
  }
}
/**
 * 第十九轮 R19A 三条收口的**自检样本**（R19A-01 / R19A-02 / R19A-04）。
 *
 * 为什么单独成节：这三条修的都是"闭包读一份文本"的能力，而真仓里**恰好没有**这些形态
 * （`bash <(cat 仓内文件)` / 跨文件 import 的路径常量 / `$(dirname "$0")/x.sh` 在脚本位）——
 * 只靠真仓跑一遍，修法退化了也看不出来（R19A 的攻击就是"加一个包装脚本"，真仓永远绿）。
 * 样本都喂给**生产路径上的同一个函数**（不是另写一份等价逻辑），任一格不成立即红。
 */
function roundNineteenSelfTest() {
  const cases = []
  const procsub = text => `${SHELL_PROCSUB_MARKER}${text}`
  // ---- R19A-01：进程替换的**位置分类** + 宽松面（被跟随脚本正文）的 fail-closed ----------
  cases.push(['进程替换·脚本位（`bash <(…)` / `sh -e <(…)`）',
    shellProcsubIsScriptPosition(['bash', procsub('<(cat f.txt)')], 1) === true
    && shellProcsubIsScriptPosition(['sh', '-e', procsub('<(cat f)')], 2) === true
    && shellProcsubIsScriptPosition([procsub('<(echo make)'), '-C', 'x'], 0) === true])
  cases.push(['进程替换·流/参数位（`done < <(…)` / `diff <(a) <(b)`）不是脚本位',
    shellProcsubIsScriptPosition(['done', procsub('<(printf x)')], 1) === false
    && shellProcsubIsScriptPosition(['diff', procsub('<(a)'), procsub('<(b)')], 1) === false])
  {
    const loose = unwrapCommandWords(['bash', procsub('<(cat scripts/cmd.txt)')], false)
    cases.push(['进程替换·**宽松面**的脚本位 ⇒ fail-closed（R19A-01 的现场：修前 EXIT=0）',
      loose.problems.some(problem => problem.kind === 'process-substitution')])
    const stream = unwrapCommandWords(['done', procsub('<(printf %s x)')], false)
    cases.push(['进程替换·宽松面的流位 ⇒ 不判红，但**内层子命令**入队继续扫',
      stream.problems.length === 0
      && stream.nestedTexts.some(nested => nested.procsub === true && nested.text.includes('printf'))])
    const inEntry = unwrapCommandWords(['bash', procsub('<(echo make)')], true)
    cases.push(['进程替换·入口形态（`strict`）照旧 fail-closed（不放松 R17-X）',
      inEntry.problems.some(problem => problem.kind === 'process-substitution')])
  }
  // ---- R19A-02：数组 `.slice()` / `.concat()` / 解构 + 跨文件 import 常量 ------------------
  const jsLiterals = (source, context) => jsExecArgumentLiterals(source, context)
  cases.push(['JS 数组 `.slice()`（R19A-02 ①：`spawnSync(CMD[0], CMD.slice(1))`）',
    jsLiterals("const CMD = ['bash', 'integration-tests/run-all.sh']\nspawnSync(CMD[0], CMD.slice(1))")
      .includes('integration-tests/run-all.sh')])
  cases.push(['JS 数组 `.concat()` + `.slice()`',
    jsLiterals("const CMD = ['bash'].concat(['integration-tests/run-all.sh'])\nspawnSync(CMD[0], CMD.slice(1))")
      .includes('integration-tests/run-all.sh')])
  cases.push(['JS 数组解构（`const [BIN, ENTRY] = <字面量数组>`）',
    jsLiterals("const [BIN, ENTRY] = ['bash', 'integration-tests/run-all.sh']\nspawnSync(BIN, [ENTRY])")
      .includes('integration-tests/run-all.sh')])
  {
    const moduleTable = new Map([['./paths.mjs', new Map([['ENTRY', "'integration-tests/run-all.sh'"]])]])
    const resolveImport = (specifier, imported) => {
      const entry = moduleTable.get(specifier)?.get(imported)
      return entry === undefined ? { unreadable: `假模块 ${specifier} 没有导出 ${imported}` } : { expression: entry }
    }
    cases.push(['JS 跨文件 import 常量（R19A-02 ②：`import { ENTRY } from \'./paths.mjs\'`）',
      jsLiterals("import { ENTRY } from './paths.mjs'\nspawnSync('bash', [ENTRY])", { resolveImport, report: () => {} })
        .includes('integration-tests/run-all.sh')])
    const reported = []
    jsLiterals("import { X } from './paths.mjs'\nspawnSync('bash', [X])",
      { resolveImport: () => ({ unreadable: '没有这个导出' }), report: detail => reported.push(detail) })
    cases.push(['JS 跨文件 import **读不懂 ⇒ fail-closed**（不是静默看不见）', reported.length === 1])
    const untouched = []
    const formal = jsLiterals("function run(script) { return spawnSync('bash', [script]) }\nrun('scripts/x.sh')",
      { resolveImport, report: detail => untouched.push(detail) })
    cases.push(['JS 形参/运行期取值**不展开、也不记红**（R19A-02 的误报面：33 处 `spawnSync(\'bash\', …)`）',
      !formal.includes('integration-tests/run-all.sh') && untouched.length === 0])
  }
  // ---- R19A-04：自指脚本位 --------------------------------------------------------------
  cases.push(['自指脚本位 `$(dirname $0)/x.sh` → 当前脚本所在目录（R19A-04）',
    selfReferentialScriptCandidates('$(dirname $0)/r19a-ok.sh', 'scripts/wrap.sh').join(',') === 'scripts/r19a-ok.sh'
    && selfReferentialScriptCandidates('$(dirname ${BASH_SOURCE[0]})/x.sh', 'scripts/wrap.sh').join(',') === 'scripts/x.sh'
    && selfReferentialScriptCandidates('${BASH_SOURCE[0]%/*}/x.sh', 'a/b/w.sh').join(',') === 'a/b/x.sh'
    && selfReferentialScriptCandidates('$0', 'a/b/w.sh').join(',') === 'a/b/w.sh'])
  cases.push(['自指脚本位只在**仓内 shell 脚本**里求值（workflow `run:` 块的 `$0` 不是仓内文件）'
    + '，且越出仓库根不求值',
    selfReferentialScriptCandidates('$(dirname $0)/x.sh', '.github/workflows/ci.yml').length === 0
    && selfReferentialScriptCandidates('$(dirname $0)/../../x.sh', 'a/b/w.sh').length === 0])
  // ---- R19A-03：收尾重新判决的**负例自证** ------------------------------------------------
  {
    const rule = LAYER_VERDICT_RULES.get('契约端到端变异')
    const scenarioRule = LAYER_VERDICT_RULES.get('假网关场景')
    cases.push(['覆盖层判决规则：只保留尝试计数、把判决掏空 ⇒ 收尾重新判决**不成立**（R19A-03 ①）',
      rule !== undefined && rule.judge({ status: 0, named: true }) === false
      && rule.judge({ status: 1, named: false }) === false
      && rule.judge({ status: 1, named: true }) === true])
    cases.push(['覆盖层判决规则：负例自证那条必须在收尾被判**成立**（"这一层真的会红"有正向证据）',
      scenarioRule !== undefined
      && scenarioRule.judge({ check: 'negative-control', violations: ['x'] }) === true
      && scenarioRule.judge({ check: 'negative-control', violations: [] }) === false
      && scenarioRule.judge({ check: 'scenario', violations: [] }) === true])
  }
  const broken = cases.filter(([, ok]) => !ok)
  for (const [label, ok] of cases) {
    if (!ok) fail(`R19A 自检样本不成立：${label}`)
  }
  check(cases.length >= 14, `R19A 自检样本只有 ${cases.length} 条（下限 14）—— 自检被删到没有判别力`)
  if (broken.length === 0) note(`R19A 自检样本: ${cases.length} 条（R19A-01 位置分类与宽松面 fail-closed / R19A-02 数组展开与跨文件 import / R19A-04 自指脚本位 / R19A-03 判决规则）✓`)
}

// **逐层重新判决**（R19A-03）：观测是原始事实，这里是唯一权威的判决 —— 与各层里的
// `check(...)` 相互印证。把某层的判决掏成恒真 ⇒ 这里的原始事实不变、判决照样不成立 ⇒ 红。
{
  const missingRules = COVERED_LAYER_LABELS.filter(label => !LAYER_VERDICT_RULES.has(label))
  if (missingRules.length > 0) {
    process.stderr.write(`\ncheck-integration-tests: 这些覆盖层没有**判决规则**（R19A-03）：`
      + `${missingRules.map(label => JSON.stringify(label)).join(', ')}\n`
      + '  ⇒ 每一层都必须交出原始观测并由收尾重新判决 —— "我跑过这条命令"不算见证。\n')
    return 1
  }
  const problemsSeen = []
  for (const label of COVERED_LAYER_LABELS) {
    const { judge, min } = LAYER_VERDICT_RULES.get(label)
    const observations = coverageVerdicts.get(label) ?? []
    if (observations.length < min()) {
      problemsSeen.push(`覆盖层「${label}」只交出 ${observations.length} 条判决观测（下限 ${min()}）——`
        + '把这一层的循环掏空（`for (… of [])`）会让观测归零，而那正是 R19A-03 的现场：'
        + '标签里的动态计数是**表长**，不是执行痕迹')
      continue
    }
    const broken = observations.filter(observation => !judge(observation))
    if (broken.length > 0) {
      problemsSeen.push(`覆盖层「${label}」有 ${broken.length} 条判决观测**不成立**：`
        + broken.slice(0, 3).map(observation => JSON.stringify(observation)).join(' / '))
    }
  }
  if (problemsSeen.length > 0) {
    process.stderr.write('\ncheck-integration-tests: 覆盖层的**判决见证**不成立（R19A-03）——\n'
      + problemsSeen.map(item => `  · ${item}\n`).join('')
      + '  ⇒ 见证必须绑**判决结果**（原始观测 + 收尾重新判决），只有尝试次数不够。\n')
    return 1
  }
}
/**
 * **判决句登记表**（R19A-03 的收口②）：每一层**真正咬人**的那一句必须逐字在场。
 *
 * ## 为什么还需要这一条（观测 + 重新判决都修不掉的那一格）
 *
 * 把 `check(mutant.status !== 0, …)` 掏成 `check(true, …)` 时，**仓里的事实一个字都没变**
 * （变异体确实是被咬住的），只是守卫不再看它 —— 任何"观测仓里的事实"的判据都不可能发现这种
 * 编辑。能发现的只有"判决句必须在场"这条静态判据：判决句一改，这里逐字登记的子串就消失。
 *
 * ## 边界（认账）
 *
 * 这是**判据的判据**：把整张表连同下面那段循环一起删掉，本层就重新失效 —— 那一层由
 * `scripts/check-root-guards.mjs` 对**本文件字节**的 sha256 登记值兜（任何改动都必须同步
 * 登记值，登记值进 diff 才会被评审看见）。这里做的是"最自然的编辑动作（掏空 check）当场红"。
 *
 * 每条 = `{ layer, id, needle }`；`needle` 必须是**本文件里恰好出现一次**的判决句片段。
 *
 * **R20A-04 起**把 needle 从判决条件本身换成 {@link witnessed} 的调用点：判决表达式必须
 * **经过见证函数**才成立（否则即便文本在场，执行计数也是 0 ⇒ 下面第二段判红）。
 * 于是 `if (false) check(<原文>)` 这种"文本保留、判决不再执行"的编辑**只改这一个文件**
 * 就会被发现（修前它要等 `scripts/check-root-guards.mjs` 的跨文件 sha256 登记值兜）。
 *
 * **R21 fix-6 / E-02 起再加两段**（E 泳道实测：只加"计数 ≥ 1"这一条时，15 个登记点里
 * 13 个可以被"`if (false)` 掏空 + 一行 `witnessed('<id>', true)` 诱饵"静默掉）：
 *   · 第二段b **判决位必须是行首的独立语句**（`judgmentNeedleStatementProblem`）——
 *     `if (false) check(witnessed(…))` 与"上一行悬挂 `if (…)`"两种形态当场红；
 *   · 第三段 **返回契约逐 id 自证** —— 对每个登记点探测 `witnessed(id, false) === false`
 *     与 `witnessed(id, true) === true`，按 id 特判 `return true` 的写法在这里露出来。
 */
const REQUIRED_JUDGMENT_SITES = [
  { layer: '语法', id: 'py-ast-parse', needle: "if (!witnessed('py-ast-parse', parsed.error === undefined && parsed.status === 0)) {" },
  { layer: '语法', id: 'node-check', needle: "if (!witnessed('node-check', parsed.status === 0)) {" },
  { layer: '登记制', id: 'registered-on-disk', needle: "check(witnessed('registered-on-disk', existsSync(join(ROOT, entry.path)))," },
  { layer: '引用面扩展名对账', id: 'scope-unregistered', needle: "check(witnessed('scope-unregistered', scope.unregistered.length === 0)," },
  { layer: '聚合层接线', id: 'aggregate-wiring', needle: "check(witnessed('aggregate-wiring', aggregateLines.length === expectedAggregate.length)," },
  { layer: '判别力下限', id: 'group-floor', needle: "check(witnessed('group-floor', groupJudgments >= GROUP_MIN_JUDGMENTS)," },
  { layer: '判别力下限', id: 'group-floor-definition', needle: "check(witnessed('group-floor-definition',\n    GROUP_MIN_JUDGMENTS === declaredGroupFloor && GROUP_MIN_JUDGMENTS > 0)," },
  { layer: '环境缺失的原因码登记制', id: 'skip-outlet', needle: "check(witnessed('skip-outlet', outlets.length === 1)," },
  { layer: '契约判据表', id: 'criteria-ids', needle: "check(witnessed('criteria-ids', observedIds.join(',') === expectedIds.join(','))," },
  { layer: '契约判据本体自证', id: 'self-test-total', needle: "if (!witnessed('self-test-total', ok === total)) fail(`${test.path} --self-test: ${ok}/${total}" },
  { layer: '契约判定通道自证', id: 'self-check-status', needle: "check(witnessed('self-check-status', selfCheckRun.status === 0)," },
  { layer: '契约端到端变异', id: 'criteria-tautology', needle: "check(witnessed('criteria-tautology', mutant.status !== 0),\n      `形态⑧: 变异 \\`criteria-tautology" },
  { layer: 'electron-shots', id: 'runtime-mutation', needle: "check(witnessed('runtime-mutation', mutantRun.status !== 0)," },
  { layer: '假网关场景', id: 'scenario-violations', needle: "if (!witnessed('scenario-violations', violations.length === 0)) {\n      for (const violation of violations) fail(" },
  { layer: '聚合层三项全 SKIP ⇒ 77 且不报 PASS', id: 'aggregate-77', needle: "check(witnessed('aggregate-77', aggregate.status === 77)," },
  { layer: '端到端覆盖面 ↔ CI 执行面：', id: 'real-surface', needle: "check(witnessed('real-surface', classified.real.length === E2E_CI_REAL_SURFACE_FILES_DECLARED)," },
  // **R23 FIX-22**：三条新登记点 —— 每条都是「上一层判据自己的判据」（掏空它必然可见）。
  { layer: '端到端覆盖面 ↔ CI 执行面：', id: 'runtime-write-detector', needle: "  check(witnessed('runtime-write-detector'," },
  { layer: '端到端覆盖面 ↔ CI 执行面：', id: 'constant-block-header', needle: "  check(witnessed('constant-block-header', constantBlockHeaderProbeProblem() === undefined)," },
  { layer: '端到端覆盖面 ↔ CI 执行面：', id: 'witness-callsite-counter', needle: "  check(witnessed('witness-callsite-counter', witnessCallSiteProbeProblem() === undefined)," },
]
/**
 * **块头是不是"恒不执行"的**（R22 FIX-14 / E-02 的块形态收口）。
 *
 * ## 现场
 *
 * 上一格判据把 `{` 当成"正常的语句边界"（对 `for (…) {` / 函数体是对的），于是
 * `if (false) { <判决句原字节> }` + 一行 `witnessed('<id>', true)` 诱饵三条子判据全不命中：
 * 同行前缀没有、上一行是 `if (false) {`（末字符 `{` 被放行）、needle 仍恰好 1 次、
 * 见证确实被调用过 ⇒ `EXIT=0`（实测 3 个站点，含修复自检点名的 `criteria-tautology`）。
 *
 * ## 判据
 *
 * 块头（`{` 之前那段）带条件时，条件必须是**求不出常量**的表达式：
 *   · `if (false) {` / `while (0) {` / `if (true === false) {` ⇒ 常量假 ⇒ 红；
 *   · `for (const _ of []) {` ⇒ 迭代域是空数组字面量 ⇒ 红（"循环体一次都不进"）；
 *   · `else {` ⇒ 条件分支的另一半 ⇒ 红；
 *   · `for (const entry of INTEGRATION_ENTRIES) {` / `if (dumped !== null) {` ⇒ 自由变量求不出
 *     ⇒ 放行（这正是本文件里 15 个登记点的**真实**上下文，误红会让判据无法使用）。
 * 常量求值只在**字面量 + 本文件里的字面量常量绑定**范围内做（`const X = false` 这类），
 * 求不出就放行 —— 宁可漏"把常量藏进函数返回值"这种更费劲的形态，也不误红正当的层。
 * @param headerText - `{` 之前的那段文本（同一行）。
 * @param source - 守卫自己的正文（用于解析本文件内的字面量常量绑定）。
 * @returns 不合规的原因；正常块头返回 `undefined`。
 */
/**
 * `for (const x of <域>)` 的**迭代域可证为空**吗（R23 FIX-22 补的**活**分支）。
 *
 * 修前 {@link constantBlockHeaderProblem} 里那段 `empty` 判断是**死代码**：它把整段
 * `const x of []` 交给 {@link evaluateConstantExpression}，而后者不认识 `for` 的绑定形态 ⇒
 * 永远返回 `undefined` ⇒ `Array.isArray(undefined)` 为假。也就是说"`for (const _ of []) {`
 * 会被判红"这句只活在注释里（实测：`for (const probeItem of []` → `undefined`）。
 * 这里把迭代域**剥出来**再求值，让那条承诺真的成立。
 * @param condition - 循环头括号内的原文（`const x of []` / `x < 3` / `;;`）。
 * @param source - 守卫自己的正文（取字面量常量绑定）。
 * @returns `true` = 迭代域可证为空数组字面量。
 */
function provenEmptyIterationDomain(condition, source) {
  const text = String(condition)
  const stripped = text.replace(/^\s*(?:const|let|var)\s+[A-Za-z_$][A-Za-z0-9_$]*\s+(?:of|in)\s+/u, '')
  if (stripped === text) return false
  const value = evaluateConstantExpression(stripped, source)
  return Array.isArray(value) && value.length === 0
}
/**
 * 恒不执行块头的**统一诊断**（{@link constantBlockHeaderProblem} 的两个分支共用）。
 * @param headerText - `{` 之前那段文本（同一行）。
 * @returns 诊断文本。
 */
function EMPTY_BLOCK_HEADER_PROBLEM(headerText) {
  return `上一非空行是**恒不执行**的块头（${JSON.stringify(headerText.slice(0, 60))}）——`
    + ' 判决句被包在"条件恒假/循环体一次都不进"的块里（`if (false) { <判决句> }` + 一行'
    + " 诱饵 \`witnessed('<id>', true)\` 是第二十二轮 V7 泳道实测的掏空形态）"
}
function constantBlockHeaderProblem(headerText, source) {
  if (headerText === '') return undefined
  if (/^\}\s*else\b/u.test(headerText)) {
    return `上一非空行是 \`} else {\`（判决句被挂在条件分支的另一半上）`
  }
  const keyword = /^(?:\}\s*)?(if|while|for|switch)\b/u.exec(headerText)
  if (keyword === null) return undefined
  const open = headerText.indexOf('(')
  const close = headerText.lastIndexOf(')')
  if (open < 0 || close < open) return undefined
  const condition = headerText.slice(open + 1, close)
  const value = evaluateConstantExpression(condition, source)
  // **R23 FIX-22**：`empty` 必须在"求不出就放行"**之前**算 —— 修前这一段的顺序让整条
  // "迭代域为空"分支**不可达**（`const x of []` 求不出常量 ⇒ 提前 return），而注释里一直
  // 写着"`for (const _ of []) {` ⇒ 红"。实测：`for (const probeItem of []` → `undefined`。
  const empty = (keyword[1] === 'for' || keyword[1] === 'while')
    ? provenEmptyIterationDomain(condition, source)
    : false
  if (value === undefined) return empty ? EMPTY_BLOCK_HEADER_PROBLEM(headerText) : undefined
  if (value !== false && value !== 0 && value !== '' && value !== null && !empty) return undefined
  return EMPTY_BLOCK_HEADER_PROBLEM(headerText)
}

/**
 * **常量表达式求值**（{@link constantBlockHeaderProblem} 用）：只在"字面量 + 本文件里的
 * 字面量 `const` 绑定"范围内做，求不出返回 `undefined`（= 不是常量 ⇒ 不判红）。
 *
 * 为什么不做完整求值：判据的目的是"恒不执行的块"，不是"实现一个 JS 解释器"。
 * `dumped !== null` / `INTEGRATION_ENTRIES` 这类自由变量求不出 ⇒ 放行；把常量藏进函数
 * 返回值、`process.env` 之类的形态这一格看不见（认账边界，与"任意死代码形态"同一取向 ——
 * 它们由执行计数、见证返回契约与 `scripts/check-root-guards.mjs` 的字节登记值兜）。
 * @param expression - 条件原文。
 * @param source - 守卫自己的正文（取字面量常量绑定）。
 * @returns 求出的常量值；求不出返回 `undefined`。
 */
function evaluateConstantExpression(expression, source) {
  /**
   * 只做**字面量 + 四则比较**范围内的折叠（不 eval、不用 `Function`）：
   * 判据要回答的是"这个条件是不是恒定不成立"，不是"实现一个 JS 解释器"。
   * @param text - 表达式原文。
   * @param depth - 常量绑定递归深度（防自指）。
   * @returns 常量值；求不出返回 `undefined`（= 不是常量 ⇒ 不判红）。
   */
  const evaluate = (text, depth) => {
    const trimmed = String(text ?? '').trim().replace(/^\s*\(([\s\S]*)\)\s*$/u, '$1').trim()
    if (trimmed === '') return undefined
    if (depth > 4) return undefined
    if (trimmed === 'true') return true
    if (trimmed === 'false') return false
    if (trimmed === 'null') return null
    if (trimmed === 'undefined') return undefined
    if (/^-?\d+(?:\.\d+)?$/u.test(trimmed)) return Number(trimmed)
    if (/^'[^']*'$/u.test(trimmed) || /^"[^"]*"$/u.test(trimmed)) return trimmed.slice(1, -1)
    if (/^\[[\s\S]*\]$/u.test(trimmed)) {
      const inner = trimmed.slice(1, -1).trim()
      return inner === '' ? [] : inner.split(',')
    }
    if (/^\[[\s\S]*\]$/u.test(trimmed)) return []
    if (trimmed.startsWith('!')) {
      const inner = evaluate(trimmed.slice(1), depth)
      return inner === undefined ? undefined : !inner
    }
    // `A === B` / `A !== B` / `A == B` / `A != B`：两边都能折叠才折叠。
    for (const operator of ['===', '!==', '==', '!=']) {
      const at = trimmed.indexOf(operator)
      if (at <= 0) continue
      const left = evaluate(trimmed.slice(0, at), depth)
      const right = evaluate(trimmed.slice(at + operator.length), depth)
      if (left === undefined || right === undefined) return undefined
      if (operator === '===') return left === right
      if (operator === '!==') return left !== right
      if (operator === '==') return left === right
      return left !== right
    }
    // 标识符 ⇒ 本文件里"名字 = 字面量"的绑定（**只认 `const`**）。
    // **R23 FIX-22**：修前这里把 `let`/`var` 也当常量折叠，于是 `let dumped = null`
    // （随后在运行期被 `JSON.parse` 赋值）被判成"恒 null"，连带把
    // `if (dumped !== null) {` 这个**正当**容器读成恒假 —— 那会把真仓里 3 个登记点误红。
    // 可重新赋值的绑定不是常量，折叠它得到的结论一定是错的。
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(trimmed)) {
      const pattern = new RegExp(`(?:^|[\\s;{}])const\\s+${trimmed}\\s*=\\s*([^\\n;]+)`, 'u')
      const match = pattern.exec(source)
      return match === null ? undefined : evaluate(match[1], depth + 1)
    }
    return undefined
  }
  return evaluate(expression, 0)
}

/**
 * `needle` 在正文里是不是**判决位**（R21 fix-6 / E-02 的第二段b）。
 *
 * ## 现场
 *
 * 判据只要求"needle 在判决本体里恰好出现一次"+"该 id 的见证计数 ≥ 1"。两条都是
 * **子串级**的：`if (false) check(witnessed('criteria-tautology', …), …)` 里那个 needle
 * 仍是原文的子串（前缀 `if (false) ` 不影响子串匹配），而诱饵行 `witnessed('<id>', true)`
 * 让计数照旧 ≥ 1 ⇒ 判决被中和、守卫 `EXIT=0`（E 泳道 13/15 实测）。
 *
 * ## 判据（两条，都是"这一位是不是独立语句"）
 *
 *   ① needle 必须在**行首**（同一行前面只有缩进）—— `if (false) check(…)` 这种"挂在前面"
 *      的形态当场红；
 *   ② 上一**非空、非注释**行不得是"把下一条语句挂住"的构造（`if (…)` / `else` / 结尾的
 *      `&&`、`||`、`(`、`,`、`=`、`?`、`[`、`{`）—— 把 `if (false)` 单独写成一行的变体
 *      同样红。
 *
 * ## 边界（认账）
 *
 * 这是**语法形态**判据，不是语义判据：其它死代码形态（`if (0)`、把一个永不被调用的函数
 * 包起来…）不在这里判 —— 它们由 {@link witnessed} 的返回契约自证（第三段）与
 * `scripts/check-root-guards.mjs` 的文件字节 sha256 登记值兜。宁可写明边界，也不假装语法
 * 判据能代替语义判据。
 * @param source - 守卫自己的正文（已排除登记表那一段）。
 * @param needle - `REQUIRED_JUDGMENT_SITES` 的 `needle`。
 * @returns 不合规的**原因**（诊断里点名）；合规返回 `undefined`。
 */
/**
 * **判决句所在语句的"直接容器"是不是条件块**（R23 FIX-22 / W4-04 的结构判据）。
 *
 * ## 现场（第二十三轮 W4 实测，6 条变异 `EXIT=0`）
 *
 * 上一格判据只看"**紧邻的上一非空行**"，于是四种改法各差一句就全身而过：
 *   · `if (false) {` + **插一句普通语句**（`const v7unused = 1`）+ 判决句 + `}`；
 *   · `if (process.env.V7_NEVER === 'never') {` + 判决句 + `}`（常量求值求不出 ⇒ 旧版放行）；
 *   · `} else {` + 判决句 + `}`；以及 `function v7NeverCalled() {` + 判决句 + `}`（永不调用）。
 * 这些都配一行**折行**的诱饵见证调用，于是两条子判据同时被绕过 ⇒ `EXIT=0`
 * （`probe/logs/m1-procenv.txt`…`m8-criteria-tautology.txt`）。
 *
 * ## 判据（"顶层可达路径"的结构形态）
 *
 * 从判决句所在位置**向上回溯**，用"闭合花括号计数"找到**真正包住它的那个块头**：
 * 先数到 N 个 `}`，再遇到第 N+1 个以 `{` 结尾的行就是容器（回溯期间遇到普通语句不影响
 * 容器识别 —— 这正是"紧邻上一行"那一版的漏洞）。
 *   · 容器是 `else` 分支 / `if (…)` / `switch (…)` ⇒ **红**，除非条件能**证为真**
 *     （`evaluateConstantExpression` 返回 `true`）；
 *   · 容器是 `for` / `while (…)` ⇒ 红，仅当迭代域是**可证为空**的常量（`for (const x of [])`）；
 *   · 容器是函数体 / `try` / 裸块 / 顶层 ⇒ 放行（本仓 `REQUIRED_JUDGMENT_SITES` 里各登记点的
 *     真实上下文；R23 FIX-22 起共 19 个点，其中 3 个是本次新增的『判据自己的判据』）。
 *
 * ## 边界（认账）
 *
 * 仍是**文本**判据：花括号按行首/行尾形态数，"把判决句塞进一个被调用的辅助函数、
 * 而那个函数只在死分支里被调用"这种更绕的形态不在这里判（它由执行计数与见证返回契约兜）。
 * 回溯只跳过**注释行**与空行，不做字符串掩码 —— 句法形态足够稳定，且误判方向是"多报"
 * （宁可多报一条，也不放行一个恒假容器）。
 * @param source - 守卫自己的正文（已排除登记表那一段）。
 * @param at - 判决句在 `source` 里的下标。
 * @returns 不合规的原因；容器不是条件块（或条件可证为真）时返回 `undefined`。
 */
function enclosingBlockHeaderProblem(source, at) {
  const lines = String(source).slice(0, at).split('\n')
  let pending = 0
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const trimmed = lines[index].trim()
    if (trimmed === '' || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue
    if (trimmed.endsWith('}')) { pending += 1; continue }
    const header = /^(.*?)\{\s*$/u.exec(trimmed)
    if (header === null) continue
    if (pending > 0) { pending -= 1; continue }
    // 这一行就是**真正包住判决句的那个块头**（回溯期间经过的普通语句不影响容器识别 ——
    // 这正是旧版"只看紧邻上一非空行"的漏洞：m6 只多插一句 `const v7unused = 1` 就绕过）。
    const container = header[1].trim()
    // **R24 FIX-26 / X3-02**：**裸块与 `try` 是"透明边界"，不是"顶层可达路径"的证据。**
    //
    // 现场（第二十四轮 X3 泳道，19 个登记点通用）：回溯只找**最内层**容器，而裸块 `{ … }`
    // 被当成"不是条件块 ⇒ 放行"（旧版这里是 `if (container === '') return undefined`）。
    // 于是把死容器里的判决句再包一层花括号（`if (false) { { 判决句 } }`）就能把"最内层容器"
    // 洗成裸块 ⇒ 容器判据整层失效；再配一行诱饵 `witnessed('id', true)` 补回执行计数 ⇒
    // `EXIT=0`。修法 = 裸块与 `try {` **继续向上回溯**，直到第一个真正的控制流容器
    // （`if`/`for`/`while`/`switch`/`else`），或函数体/顶层（那两类的块头带非空、非控制流
    // 关键字 ⇒ 落到下面的放行分支，仍是"可达路径"的边界）。
    if (container === '') continue
    if (/^try\b/u.test(container)) continue
    const keyword = /^(?:\}\s*)?(if|while|for|switch)\b/u.exec(container)
    const isElse = /^(?:\}\s*)?else\b/u.test(container)
    if (keyword === null && !isElse) return undefined
    if (isElse) {
      return `判决句所在语句的**直接容器**是 \`else\` 分支（${JSON.stringify(container.slice(0, 50))}）——`
        + ' 条件分支的另一半不属于"顶层可达路径"'
    }
    const open = container.indexOf('(')
    const close = container.lastIndexOf(')')
    if (open < 0 || close < open) {
      return `判决句所在语句的直接容器是条件块（${JSON.stringify(container.slice(0, 50))}）——`
        + ' 读不出它的条件，按 fail-closed 处理'
    }
    const condition = container.slice(open + 1, close)
    const value = evaluateConstantExpression(condition, source)
    const constantFalse = value === false || value === 0 || value === '' || value === null
    if (keyword[1] === 'if' || keyword[1] === 'switch') {
      if (constantFalse) {
        return `判决句所在语句的**直接容器**是条件恒假的块（${JSON.stringify(container.slice(0, 60))}）——`
          + ' 判决因此不在"顶层可达路径"上（第二十三轮 W4 的 m6 形态正是在这个块头与判决句之间'
          + '多插了一句普通语句，从而骗过旧版"只看紧邻上一行"的实现）'
      }
      // 条件求不出的（`if (dumped !== null) {` / `if (wired) {`）放行 —— 本仓有登记点真的在
      // 这类"只有采集到了才判"的容器里，一律判红会让判据无法使用（误红正当层的代价更高）。
      return undefined
    }
    if (constantFalse || provenEmptyIterationDomain(condition, source)) {
      return `判决句所在语句的直接容器是**循环体一次都不会进**的循环`
        + `（${JSON.stringify(container.slice(0, 60))}）`
    }
    return undefined
  }
  return undefined
}
/**
 * **判决见证调用点的唯一计数实现**（R23 FIX-22 / W4-04 的"归一化折行"）。
 *
 * ## 现场
 *
 * 上一格判据按**行**数 `witnessed('<id>',` 的出现次数，于是把诱饵写成
 * `witnessed(\n  '<id>', true)`（折在 `(` 之后）时该行不含那个子串 ⇒ 计数仍是 1 ⇒ 诱饵隐形
 * （第二十三轮 W4 的 6 条变异都带这一行折行诱饵，实测 `EXIT=0`）。
 *
 * ## 判据
 *
 * 计数前先**掩掉注释**、再把**所有空白折叠掉**，然后数归一化后的**调用点**。折行在哪个位置
 * 都逃不掉；注释里的同一片段不算（本表的 JSDoc 天然含同样的片段，不掩注释会自伤）。
 *
 * **R24 FIX-26 / X3-02：第一实参的写法必须归一化。** 第二十三轮的归一化只覆盖"折行"，仍然
 * 只认单引号字面量 ⇒ 诱饵换成**反引号**`witnessed(\`<id>\`, true)`、**双引号**
 * `witnessed("<id>", true)`、或**先绑再传**（`const v7id='<id>'; witnessed(v7id, true)`）时
 * 计数照旧是 1 ⇒ 诱饵隐形、判决死在花括号里而 19 个登记点全绿（第二十四轮 X3 泳道实测）。
 * 三种写法在运行期都是**同一个调用点**（`witnessed` 只认第一实参的取值），所以这里把它们
 * 与单引号字面量合并计数：**"调用点唯一"这条语义不变**，只是不再按引号形态分岔。
 * @param id - 判决点 id。
 * @param code - 守卫的**判决本体**正文（已排除登记表那一段）。
 * @returns 归一化后的调用点个数。
 */
function witnessCallSiteCount(id, code) {
  const masked = String(code)
    .split('\n')
    // 整行注释**按行**滤掉（与第一段 b 的注释跳过同一口径）：折行诱饵不可能藏进被滤掉的行里，
    // 而"注释里恰好出现同样的片段"这一类假命中也不会被算进来（本表的 JSDoc 天然含同样的片段）。
    .filter(line => {
      const trimmed = line.trim()
      return trimmed !== '' && !trimmed.startsWith('//')
        && !trimmed.startsWith('*') && !trimmed.startsWith('/*')
    })
    .join('\n')
  const normalized = masked.replace(/\s+/gu, '')
  const countOf = spelling => normalized.split(`witnessed(${spelling},`).length - 1
  // ① 字面量第一实参：单引号 / 双引号 / 模板字符串（反引号）三种写法同判。
  let count = countOf(`'${id}'`) + countOf(`"${id}"`) + countOf(`\`${id}\``)
  // ② 先绑再传的诱饵（`const v7id='<id>'; … witnessed(v7id, true)`）：标识符文法受
  //    JS 限制（不含 `-`），所以按"本段正文里把 id 字面量绑给哪个标识符"反查。
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const binding = new RegExp(
    `(?:const|let|var)\\s+([A-Za-z_$][A-Za-z0-9_$]*)\\s*=\\s*(?:'${escaped}'|"${escaped}"|\`${escaped}\`)`, 'gu')
  for (const match of masked.matchAll(binding)) count += countOf(match[1])
  return count
}
/**
 * {@link constantBlockHeaderProblem} 的**判决级见证**（R23 FIX-22 / W4-07）。
 *
 * 修前这条子判据**没有见证**：首行插一句 `return undefined` ⇒ 守卫 `EXIT=0`（判据文本与
 * needle 一字未动）。这里在每次运行时用合成样本自证"该红的一定红、该绿的一定绿"。
 * @returns 不合规的原因；全部通过返回 `undefined`。
 */
function constantBlockHeaderProbeProblem() {
  const guardSource = readFileSync(fileURLToPath(import.meta.url), 'utf8')
  /**
   * 造一段"块头 + 判决句"的合成正文。
   * @param header - 块头行（含 `{`）。
   * @param insertStatement - 是否在块头与判决句之间多插一句普通语句（W4-04 的 m6 形态）。
   * @returns 合成正文。
   */
  const synthetic = (header, insertStatement = false) => `${header}\n`
    + (insertStatement ? '  const probeUnused = 1\n' : '')
    + "  check(witnessed('probe-block', probeUnused))\n}\n"
  // ---- 第一层：**常量折叠**（`constantBlockHeaderProblem`）单独自证 ----------------------
  // 逐个直接问这一层：**不许**靠第二层兜（否则把这一层掏成 `return undefined` 时
  // 第二层刚好也认得同一个块头 ⇒ 掏空不可见，W4-07 的形态就会复发）。
  for (const header of ['if (false)', 'if (0 === 1)', '} else', 'for (const probeItem of [])']) {
    if (constantBlockHeaderProblem(header, guardSource) === undefined) {
      return `\`constantBlockHeaderProblem\` 自己放过了 ${JSON.stringify(header)} ——`
        + ' 这一层是"块头条件恒假 / 迭代域为空 / else 分支"的唯一常量折叠实现（W4-04 的 m2/m5/m7 形态）'
    }
  }
  // ---- 第二层：**结构容器**（`enclosingBlockHeaderProblem`）单独自证 --------------------
  // 关键样本 = **块头与判决句之间还有一句普通语句**（旧版"只看紧邻上一行"在这里是绿的）。
  // 注意分工（别把不属于这一层的形态算在它头上）：**条件求不出**的紧邻块头
  // （`if (process.env.X === 'never') {`）这一层**故意放行** —— 它由"见证调用点归一化计数"
  // 那一层兜（`witnessCallSiteProbeProblem` 覆盖折行诱饵），两层各证各的。
  for (const header of ['if (false) {', 'for (const probeItem of []) {', '} else {']) {
    const text = synthetic(header, true)
    if (enclosingBlockHeaderProblem(text, text.indexOf('check(')) === undefined) {
      return `\`enclosingBlockHeaderProblem\` 没有认出 ${JSON.stringify(header)}`
        + ' 与判决句之间还夹着一句普通语句的容器 —— 这正是 W4-04 的 m6 形态'
        + '（只多插一句 `const v7unused = 1` 就骗过旧版"只看紧邻上一行"的实现）'
    }
  }
  // ---- 反向：正当块头两层都不得误红 ------------------------------------------------
  for (const header of ['for (const entry of INTEGRATION_ENTRIES) {', 'if (dumped !== null) {']) {
    const text = synthetic(header)
    const problem = constantBlockHeaderProblem(header.replace(/\{$/u, '').trim(), guardSource)
      ?? enclosingBlockHeaderProblem(text, text.indexOf('check('))
    if (problem !== undefined) return `块形态判据误红了正当块头 ${JSON.stringify(header)}：${problem}`
  }
  const topLevel = synthetic('')
  if (enclosingBlockHeaderProblem(topLevel, topLevel.indexOf('check(')) !== undefined) {
    return '`enclosingBlockHeaderProblem` 误红了顶层（裸块）里的判决句'
  }
  return undefined
}
function witnessCallSiteProbeProblem() {
  const cases = [
    { code: "check(witnessed('probe-id', value), 'm')\n", id: 'probe-id', expect: 1 },
    { code: "check(witnessed(\n  'probe-id', value), 'm')\n", id: 'probe-id', expect: 1 },
    {
      code: "if (false) { check(witnessed('probe-id', value), 'm') }\nwitnessed(\n  'probe-id', true)\n",
      id: 'probe-id', expect: 2,
    },
    { code: "// witnessed('probe-id', true)\ncheck(witnessed('probe-id', value))\n", id: 'probe-id', expect: 1 },
    // **R24 FIX-26 / X3-02**：同一个调用点的三种"换皮"写法都必须计入 —— 反引号模板字符串、
    // 双引号、以及"先把 id 绑给标识符再当第一实参"。修前它们各自让诱饵隐形（计数仍是 1）。
    { code: 'check(witnessed(\'probe-id\', value))\nwitnessed(`probe-id`, true)\n', id: 'probe-id', expect: 2 },
    { code: 'check(witnessed(\'probe-id\', value))\nwitnessed("probe-id", true)\n', id: 'probe-id', expect: 2 },
    {
      code: "const probeAlias = 'probe-id'\ncheck(witnessed('probe-id', value))\nwitnessed(probeAlias, true)\n",
      id: 'probe-id', expect: 2,
    },
    // 反向：别的 id 的调用点不算在本 id 头上（否则"计数唯一"会变成"总数"）。
    { code: "check(witnessed('probe-id', value))\nwitnessed(`probe-other`, true)\n", id: 'probe-id', expect: 1 },
  ]
  for (const probe of cases) {
    const count = witnessCallSiteCount(probe.id, probe.code)
    if (count !== probe.expect) {
      return `\`witnessCallSiteCount\` 对样本 ${JSON.stringify(probe.code.slice(0, 60))} 给出 ${count}`
        + `（期望 ${probe.expect}）—— 折行 / 反引号 / 双引号 / 先绑再传四种写法在运行期是**同一个`
        + '调用点**，诱饵必须算作第二个（W4-04 的折行绕过；R24 FIX-26 / X3-02 的换皮绕过）'
    }
  }
  return undefined
}
function judgmentNeedleStatementProblem(source, needle) {
  const at = source.indexOf(needle)
  if (at < 0) return 'needle 不在判决本体里'
  const lineStart = source.lastIndexOf('\n', at) + 1
  const beforeOnLine = source.slice(lineStart, at)
  if (beforeOnLine.trim() !== '') {
    return `needle 不在**行首**（同一行前面还有代码：${JSON.stringify(beforeOnLine.trim().slice(0, 60))}）`
      + ' —— 判决句被挂在了别的构造上（`if (false) check(witnessed(…))` 的同族）'
  }
  const lines = source.slice(0, lineStart).split('\n')
  for (let index = lines.length - 2; index >= 0; index -= 1) {
    const trimmed = lines[index].trim()
    if (trimmed === '' || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue
    if (/^(?:\}\s*)?(?:if|for|while|switch)\b[^{;]*$/u.test(trimmed)) {
      return `上一非空行是**悬挂的条件**（${JSON.stringify(trimmed.slice(0, 60))}）—— 判决句会被它条件化`
    }
    if (/^(?:\}\s*)?else\s*$/u.test(trimmed)) return '上一非空行是 `else`（判决句被条件化）'
    // **R22 FIX-14 / E-02 块形态**：`{` 是正常的语句边界（`for (…) {` / 函数体 / `try {`），
    // 但"**条件恒假**的块"不是 —— `if (false) { <判决句原字节> }` + 一行
    // `witnessed('<id>', true)` 诱饵实测 EXIT=0（三个站点，第二十二轮 V7 泳道）。
    // 判据：块头带条件时，条件不许是**常量假**（`false` / `0` / `''` / `true === false` /
    // 本文件里被字面量常量绑定的名字）；`else {` 一律拒（它是条件分支的另一半）。
    const header = /^(.*?)\{\s*$/u.exec(trimmed)
    if (header !== null) {
      const problem = constantBlockHeaderProblem(header[1].trim(), source)
      if (problem !== undefined) return problem
    }
    // 其余结尾字符都会把下一条语句挂住。
    if (/[&|?,=([\]]$/u.test(trimmed)) {
      return `上一非空行以悬挂运算符结尾（${JSON.stringify(trimmed.slice(-24))}）—— 判决句不是一个独立语句`
    }
    break
  }
  return undefined
}

/**
 * **运行期逐条引用的「可达性」判据**（第三十轮 FIX-45 ②；形态与
 * {@link judgmentNeedleStatementProblem} / {@link constantBlockHeaderProblem} 同源，
 * 常量求值复用 {@link evaluateConstantExpression}，不另起一套）。
 *
 * ## 现场（第二十九轮 AC2 的 F-04，P1，两处实跑）
 *
 * `reporter.report('deep-link-identity', …)` 的**字面量保留**、只把它包进 `if False:` ⇒
 * 本守卫 **EXIT=0**；而同一条腿对**错误身份**的 SSO 报 `RESULT: PASS`（6 ✓ 而非 7 ✓），
 * 原件对同一网关正确 FAIL。`electron-shots` 同族同样漏（`M6` 变异也是 EXIT=0）。
 * 即：原来的 `citedIds.has(id)` / `shotsSource.includes(id)` 证明的是"**文本在场**"，
 * 不是"**运行期求值过**"。
 *
 * ## 判据（AC2 点名的那几档）
 *
 *   · **恒假块头**：调用点的**外层块头**（Python 按缩进、JS 按 `{`）条件不得是常量假 ——
 *     `if False:` / `if (false) {` / `while (false) {` / `if (true === false) {`；
 *     常量求值求不出就**放行**（`if (twoStep) {` / `if approval_required:` 这类正当分支
 *     不得误红）；
 *   · **空迭代域**：`for _ in []:` / `for (const _ of []) {`（复用
 *     {@link provenEmptyIterationDomain} 的 Python 版）；
 *   · **同一行条件化**：`if (false) report(…)`（JS 前缀里带 `(…)` 的条件直接求值）；
 *   · **悬空运算符**：`cond && report(…)` / `… and report(…)`（调用点不是独立语句）；
 *   · **早退之后的死代码**：紧邻的**同层**上一非空行是**无条件** `return` / `raise` /
 *     `throw` / `break` / `continue` / `sys.exit(`。
 *
 * ## 边界（认账，勿夸大）
 *
 * 这**不是**完整的控制流分析：条件表达式（`report(…) if False else None`）、把常量藏进函数
 * 返回值、跨函数跳转这一格看不见。它们由**行为级判据**兜 —— `SCENARIOS` 的
 * `dex-wrong-identity`（对**错误身份**的 SSO 必须 FAIL）：把调用点弄成不可达，那条腿的结论
 * 必然从 FAIL 变成 PASS，当场红。两层互补，缺一不可。
 * @param source - 运行期脚本正文（`.py` / `.mjs`）。
 * @param id - 判据 id。
 * @param language - `'py'` 或 `'js'`（只影响注释前缀 / 块头 / 早退词 / 悬空运算符的形态）。
 * @param callee - 调用方（`'reporter.report'` / `'report'`）。
 * @returns 不可达的原因；可达返回 `undefined`。
 */
function callSiteReachabilityProblem(source, id, language, callee) {
  const text = String(source)
  const escaped = String(id).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const calleePattern = String(callee).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const sites = [...text.matchAll(new RegExp(`${calleePattern}\\(\\s*(['"])${escaped}\\1\\s*,`, 'gu'))]
  if (sites.length === 0) {
    return `找不到以判据 id 为首参的调用点（\`${callee}(<id>, …)\`）`
  }
  const py = language === 'py'
  const comment = py ? '#' : '//'
  const controlFlow = py ? /^(?:if|elif|while|for)\b/u : /^(?:if|while|for|switch)\b/u
  const earlyExit = py
    ? /^(?:return|raise|break|continue)\b|^sys\.exit\(/u
    : /^(?:return|throw|break|continue)\b/u
  const dangling = py
    ? /(?:[,=([{+\-*/%&|^]|\b(?:and|or|not|is|in))\s*$/u
    : /(?:[,=([?&|+\-*/%^.]|\b(?:await|typeof|instanceof))\s*$/u
  const problems = []
  for (const site of sites) {
    const at = site.index
    const lineStart = text.lastIndexOf('\n', at) + 1
    const leading = text.slice(lineStart, at)
    const prefix = leading.trim()
    if (prefix !== '' && !(py && controlFlow.test(prefix))) {
      // 同一行前缀。两种语言的**合法**条件化写法不同：
      //   · Python：`if not reporter.report(…)` —— 调用点就是条件本身；"恒假条件里带调用点"
      //     在这门语言里写不出来（`if False: report(…)` 是语法错误）；
      //   · JS：`if (false) report(…)` 是完全合法的语句 —— 条件必须**真的求值**。
      const condition = jsInlineCondition(prefix)
      const value = condition === undefined ? undefined : evaluateConstantExpression(condition, text)
      if (value === false || value === 0 || value === '' || value === null) {
        problems.push(`调用点被同一行的**恒假条件**条件化（${JSON.stringify(prefix.slice(0, 60))}）`)
        continue
      }
      if (condition === undefined && dangling.test(prefix)) {
        problems.push('调用点不是独立语句（同一行前缀以悬空运算符结尾：'
          + `${JSON.stringify(prefix.slice(-24))}）`)
        continue
      }
    }
    const container = py
      ? pythonUnreachableContainerProblem(text, at)
      : jsUnreachableContainerProblem(text, at)
    if (container !== undefined) {
      problems.push(container)
      continue
    }
    const sibling = previousSameLevelStatement(text, lineStart, leading.length, py)
    if (sibling !== undefined && earlyExit.test(sibling)) {
      problems.push('调用点的上一条同层语句是**无条件早退**'
        + `（${JSON.stringify(sibling.slice(0, 60))}）⇒ 死代码`)
      continue
    }
    const danglingLine = danglingPreviousLineProblem(text, lineStart, language)
    if (danglingLine !== undefined) problems.push(danglingLine)
  }
  return problems.length === 0 ? undefined : problems.join('；')
}

/**
 * 调用点的**上一非空行**是不是以悬挂运算符结尾（`cond &&` / `x =` / `… +`）。
 *
 * 形态与 {@link judgmentNeedleStatementProblem} 的最后一格同源（那边判的是守卫自己的判决句）。
 * 这里只需要"上一条语句把调用点挂住了"这一个事实 —— 判不出来就放行，误红会让判据不可用。
 * @param source - 运行期脚本正文。
 * @param lineStart - 调用点所在行的起始下标。
 * @param language - `'py'` / `'js'`。
 * @returns 不合规的原因；正常返回 `undefined`。
 */
function danglingPreviousLineProblem(source, lineStart, language) {
  const py = language === 'py'
  const comment = py ? '#' : '//'
  const dangling = py
    ? /(?:[,=([{+\-*/%&|^]|\b(?:and|or|not|is|in))\s*$/u
    : /(?:[,=([?&|+\-*/%^.]|\b(?:await|typeof|instanceof))\s*$/u
  const lines = String(source).slice(0, lineStart).split('\n')
  for (let index = lines.length - 2; index >= 0; index -= 1) {
    const trimmed = lines[index].trim()
    if (trimmed === '' || trimmed.startsWith(comment)
      || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue
    if (dangling.test(trimmed)) {
      return `上一非空行以**悬挂运算符**结尾（${JSON.stringify(trimmed.slice(-24))}）——`
        + ' 调用点不是一个独立语句（`cond &&` / `x =` 会把下一条语句挂住，运行期不保证求值）'
    }
    return undefined
  }
  return undefined
}

/**
 * JS：调用点是否被**条件恒假 / 迭代域为空**的块包着。
 *
 * 形态与 {@link enclosingBlockHeaderProblem} 同源（同一套"回溯找容器"的写法与同一份常量
 * 求值 {@link evaluateConstantExpression}），两处**有意的差别**：
 *   · 这里要**逐层往外看**（`if (false) { if (x) { 调用 } }` 的内层容器条件求不出，
 *     但外层恒假 —— 只看最内层会漏）；
 *   · `} else {` / `try {` / 裸块在这里是**可达边界**（真实存在正当调用点落在 `else` 分支，
 *     例如 `electron-shots.mjs:712` 的 `report('two-step-login-page', { phaseOk: false })`），
 *     所以继续往外走而**不**判红 —— 与 {@link enclosingBlockHeaderProblem} 的取向相反是
 *     因为两者的被守护面不同：那边守的是"守卫自己的顶层判决句"，这边守的是"运行期脚本的
 *     每一条判据调用"。
 * @param source - 运行期脚本正文。
 * @param at - 调用点在正文里的下标。
 * @returns 不可达的原因；可达返回 `undefined`。
 */
function jsUnreachableContainerProblem(source, at) {
  const lines = String(source).slice(0, at).split('\n')
  let pending = 0
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const trimmed = lines[index].trim()
    if (trimmed === '' || trimmed.startsWith('//')
      || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue
    if (trimmed.endsWith('}')) { pending += 1; continue }
    const header = /^(.*?)\{\s*$/u.exec(trimmed)
    if (header === null) continue
    if (pending > 0) { pending -= 1; continue }
    const container = header[1].trim()
    // 裸块 / `try` / 条件分支的另一半：透明边界，继续往外找真正的控制流容器。
    if (container === '' || /^try\b/u.test(container)
      || /^(?:\}\s*)?(?:else|catch|finally)\b/u.test(container)) continue
    const keyword = /^(?:\}\s*)?(if|while|for|switch)\b/u.exec(container)
    if (keyword === null) break  // 函数体 / 类体 / 对象字面量 ⇒ 出了语句作用域
    const open = container.indexOf('(')
    const close = container.lastIndexOf(')')
    if (open < 0 || close < open) {
      return `调用点所在语句的外层容器读不出条件（${JSON.stringify(container.slice(0, 50))}）`
        + ' ⇒ 按 fail-closed 处理'
    }
    const condition = container.slice(open + 1, close)
    const value = evaluateConstantExpression(condition, source)
    const empty = (keyword[1] === 'for' || keyword[1] === 'while')
      ? provenEmptyIterationDomain(condition, source)
      : false
    const constantFalse = value === false || value === 0 || value === '' || value === null
    if (constantFalse || empty) {
      return `调用点被**恒不执行**的块包着（${JSON.stringify(container.slice(0, 60))}）——`
        + ' 条件恒假 / 循环体一次都不进 ⇒ 该判据在运行期不会被求值'
    }
  }
  return undefined
}

/**
 * Python：调用点是否被**条件恒假 / 迭代域为空**的块包着（按缩进找容器，逐层往外）。
 * @param source - 运行期脚本正文。
 * @param at - 调用点在正文里的下标。
 * @returns 不可达的原因；可达返回 `undefined`。
 */
function pythonUnreachableContainerProblem(source, at) {
  const lineStart = source.lastIndexOf('\n', at) + 1
  const callIndent = /^[ \t]*/u.exec(source.slice(lineStart, at))[0].length
  const lines = source.slice(0, lineStart).split('\n')
  let level = callIndent
  for (let index = lines.length - 2; index >= 0; index -= 1) {
    const raw = lines[index]
    const trimmed = raw.trim()
    if (trimmed === '' || trimmed.startsWith('#')
      || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue
    const lineIndent = /^[ \t]*/u.exec(raw)[0].length
    if (lineIndent > level) continue          // 续行 / 更深块：不属于本层
    if (lineIndent === level) continue        // 同层兄弟语句：不改变容器
    const header = /^(.*?):\s*$/u.exec(trimmed)
    if (header === null) break
    const headerText = header[1].trim()
    if (!/^(?:if|elif|while|for)\b/u.test(headerText)) break  // def/class/with/try → 出作用域
    const problem = pythonBlockHeaderProblem(headerText, source)
    if (problem !== undefined) return problem
    level = lineIndent
  }
  return undefined
}

/**
 * 调用点往上第一条**同层**语句（跳过更深缩进的续行/子块与空行、注释）。
 *
 * 只用来判"死代码"那一格（`return finish()` 直接写在调用点上一行）。判不出来没关系 ——
 * 那一格由行为级判据（`dex-wrong-identity`）兜，不必为它做完整的 CFG。
 * @param source - 运行期脚本正文。
 * @param lineStart - 调用点所在行的起始下标。
 * @param callIndent - 调用点的缩进宽度。
 * @param py - 是否 Python（只影响注释前缀）。
 * @returns 那条语句的原文；找不到返回 `undefined`。
 */
function previousSameLevelStatement(source, lineStart, callIndent, py) {
  const comment = py ? '#' : '//'
  const lines = String(source).slice(0, lineStart).split('\n')
  for (let index = lines.length - 2; index >= 0; index -= 1) {
    const raw = lines[index]
    const trimmed = raw.trim()
    if (trimmed === '' || trimmed.startsWith(comment)
      || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue
    const lineIndent = /^[ \t]*/u.exec(raw)[0].length
    if (lineIndent > callIndent) continue
    return lineIndent === callIndent ? trimmed : undefined
  }
  return undefined
}

/**
 * 同一行前缀里的 JS 条件（`if (false) ` / `while (0) `）—— 抽取括号内原文。
 *
 * 只在**前缀整体就是一个条件块头**时返回条件；否则 `undefined`（= 调用点不是被前缀里的
 * 条件条件化的，交给悬空运算符那一档判）。
 * @param prefix - 调用点之前的同一行文本（已 trim）。
 * @returns 条件原文；形态不符返回 `undefined`。
 */
function jsInlineCondition(prefix) {
  const match = /^(?:\}\s*)?(?:if|while|switch)\s*\(([\s\S]*)\)\s*$/u.exec(String(prefix).trim())
  return match === null ? undefined : match[1]
}

/**
 * Python 块头（`if False:` / `while False:` / `for x in []:`）的**恒不执行**判据。
 *
 * 与 {@link constantBlockHeaderProblem} 同形，只把方言差异收在这里：条件里的
 * `True` / `False` / `None` 先归一成 JS 字面量（`evaluateConstantExpression` 只认后者），
 * 空迭代域按 `for <目标> in <域>` 剥出来。`else:` / `try:` / `with:` / `def:` / `class:`
 * 一律放行（它们不构成"条件恒假"）。
 * @param headerText - 去掉尾部 `:` 的块头原文。
 * @param source - 运行期脚本正文（常量求值用）。
 * @returns 不合规的原因；正常块头返回 `undefined`。
 */
function pythonBlockHeaderProblem(headerText, source) {
  if (headerText === '') return undefined
  const keyword = /^(?:if|elif|while|for)\b/u.exec(headerText)
  if (keyword === null) return undefined
  let condition = headerText.slice(keyword[0].length).trim().replace(/^\(([\s\S]*)\)$/u, '$1').trim()
  condition = condition.replace(/\b(True|False|None)\b/gu, word =>
    ({ True: 'true', False: 'false', None: 'null' })[word])
  const value = evaluateConstantExpression(condition, source)
  const empty = pythonEmptyIterationDomain(keyword[0], condition, source)
  if (value === undefined) return empty ? EMPTY_BLOCK_HEADER_PROBLEM(headerText) : undefined
  if (value !== false && value !== 0 && value !== '' && value !== null && !empty) return undefined
  return EMPTY_BLOCK_HEADER_PROBLEM(headerText)
}

/**
 * Python 的 `for <目标> in <域>:` 里迭代域**可证为空**吗（{@link provenEmptyIterationDomain}
 * 的方言版：JS 是 `const x of []`，Python 是 `x in []`）。
 * @param keyword - 块头关键字（`for` / `while` / …）。
 * @param condition - 去掉关键字后的条件原文。
 * @param source - 运行期脚本正文（常量求值用）。
 * @returns `true` = 迭代域可证为空。
 */
function pythonEmptyIterationDomain(keyword, condition, source) {
  if (keyword !== 'for' && keyword !== 'while') return false
  const stripped = String(condition).replace(/^[^:]*?\bin\b\s*/u, '')
  if (stripped === String(condition)) return false
  const value = evaluateConstantExpression(stripped, source)
  return Array.isArray(value) && value.length === 0
}
{
  // ---- 第一段：**判决句逐字在场**（R19A-03 ②）--------------------------------------
  const guardSource = readFileSync(fileURLToPath(import.meta.url), 'utf8')
  // 只扫**判决本体**那一段：本表自己的字面量天然包含同样的片段，不排除它就成了自证同义反复
  // （每个 needle 都能在表里"命中"自己）。
  const registryStart = guardSource.indexOf('const REQUIRED_JUDGMENT_SITES = [')
  const registryEnd = guardSource.indexOf('\n]', registryStart)
  const guardCode = registryStart < 0 || registryEnd < 0
    ? guardSource
    : guardSource.slice(0, registryStart) + guardSource.slice(registryEnd)
  const labelsWithoutSites = COVERED_LAYER_LABELS.filter(label =>
    !REQUIRED_JUDGMENT_SITES.some(site => site.layer === label))
  const sitesSeen = []
  // **只数代码行**：本表自己的 JSDoc 里出现过 `witnessed('criteria-tautology', …)` 这类片段，
  // 把注释算进来会让"见证调用点唯一"这条判据自伤（与 `judgmentNeedleStatementProblem` 的
  // 注释跳过同一口径）。
  const guardCodeLines = guardCode.split('\n').filter(line => {
    const trimmed = line.trim()
    return trimmed !== '' && !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*')
  })
  for (const site of REQUIRED_JUDGMENT_SITES) {
    // **判决本体里恰好一次**：掏空真判决（`check(mutant.status !== 0,` → `check(true,`）⇒ 归零 ⇒ 红。
    const occurrences = guardCode.split(site.needle).length - 1
    if (occurrences === 1) {
      // ---- 第一段b：**这一位必须是行首的独立语句**（R21 fix-6 / E-02）------------------
      //
      // 只看"needle 是不是子串"会让 `if (false) check(witnessed(…))` 全身而过（前缀不影响
      // 子串匹配），而它正是 E 泳道实测的掏空形态（配一行 `witnessed('<id>', true)` 诱饵）。
      // **R22 FIX-14 / E-02 块形态的另一半**：`if (false) { <判决句原字节> }` 必须再补一行
      // 诱饵 `witnessed('<id>', true)` 才能把"执行计数 ≥ 1"骗过去（判决句被包进恒假块之后
      // 它自己不会执行）—— 所以"**同一 id 的见证调用点唯一**"正是那一族的收口：多一个调用点
      // 就红，且它与块头判据、执行计数、返回契约三格互相独立（实测三个站点全被咬住）。
      // **R23 FIX-22 / W4-04**：调用点计数必须**归一化折行**（见 {@link witnessCallSiteCount}）——
      // 修前按**行**数 `witnessed('<id>',`，把诱饵写成 `witnessed(` + 换行 + `'<id>', true)` 就隐形。
      const witnessCalls = witnessCallSiteCount(site.id, guardCode)
      if (witnessCalls !== 1) {
        sitesSeen.push(`「${site.layer}」的判决点 ${site.id} 的**见证调用点**在判决本体里出现 `
          + `${witnessCalls} 次（必须恰好 1 次）—— \`if (false) { <判决句原字节> }\` 这类`
          + '"文本保留、判决不再执行"的编辑要靠一行诱饵 '
          + `\`witnessed('${site.id}', true)\` 才能骗过执行计数，而诱饵就是一个**多出来的调用点**。`
          + '（R22 FIX-14 / E-02 块形态；**R23 FIX-22 / W4-04**：计数已**掩掉注释并折叠空白**，'
          + '把诱饵折成多行也照样算第二个调用点）')
      }
      // **R23 FIX-22 / W4-04**：结构判据 —— 判决句所在语句的**直接容器**不许是条件块
      // （`if (…)` / `else` / `switch` / 迭代域可证为空的循环）。旧版只看"紧邻的上一非空行"，
      // 块头与判决句之间插一句普通语句即可绕过（W4-04 的 m6）。
      const containerProblem = enclosingBlockHeaderProblem(guardCode, guardCode.indexOf(site.needle))
      if (containerProblem !== undefined) {
        sitesSeen.push(`「${site.layer}」的判决点 ${site.id} **不在顶层可达路径上**：${containerProblem}`
          + `\n      期望片段：${JSON.stringify(site.needle.slice(0, 90))}`
          + '\n      ⇒ 判决句必须是**直属语句**（`check(witnessed(…))` / `if (!witnessed(…)) {`），'
          + '不许被 `if`/`else`/循环容器条件化（R23 FIX-22 / W4-04）。')
        continue
      }
      const statementProblem = judgmentNeedleStatementProblem(guardCode, site.needle)
      if (statementProblem === undefined) continue
      sitesSeen.push(`「${site.layer}」的判决点 ${site.id} **不在判决位上**：${statementProblem}`
        + `\n      期望片段：${JSON.stringify(site.needle.slice(0, 90))}`
        + '\n      ⇒ 判决句必须是**行首的独立语句**：`if (false) check(witnessed(…))` 这种"文本保留、'
        + '判决被挂在别的构造上"的编辑与"把判决掏成恒真"同属一种（R21 fix-6 / E-02）。')
      continue
    }
    sitesSeen.push(`「${site.layer}」的判决句 ${site.id} 在判决本体里出现 ${occurrences} 次`
      + `（必须恰好 1 次）—— 期望片段：${JSON.stringify(site.needle.slice(0, 90))}`)
  }
  if (labelsWithoutSites.length > 0) {
    sitesSeen.push(`这些覆盖层没有登记任何判决句：${labelsWithoutSites.map(label => JSON.stringify(label)).join(', ')}`)
  }
  // ---- 第二段：**判决真的执行过**（R20A-04）----------------------------------------
  //
  // 第一段只看文本：`if (false) check(<判决句原文>)` 能让 15 条 needle 全部在场、
  // 原始观测照记、收尾重新判决照样成立 ⇒ 修前守卫自己 `EXIT=0`（审计 MUT-B 实测）。
  // 见证计数写在判决的取值路径上（`witnessed(id, 判决表达式)`），所以"文本在、判决没跑"
  // 与"判决跑了但没经过见证"两种编辑都会让计数缺失 ⇒ 当场红，且**只改这一个文件就能发现**。
  for (const site of judgmentSitesWithoutRuns(REQUIRED_JUDGMENT_SITES, JUDGMENT_RUNS)) {
    sitesSeen.push(`「${site.layer}」的判决点 ${site.id} **一次都没有执行过**（执行计数 0）——`
      + ` 判决表达式必须经过 \`witnessed('${site.id}', …)\` 才成立：`
      + ' 把判决包进 `if (false) …`（文本还在、意思没了）与把判决掏成恒真同属一种编辑，'
      + '两条路都必须红（R20A-04：修前这一格只被另一个文件的 sha256 登记值兜）')
  }
  // ---- 第三段：**见证的返回契约**（R21 fix-6 / E-02）-------------------------------
  //
  // 现场：把 {@link witnessed} 改成"按 id 特判 `return true`"（**一行**）⇒ 每个登记点的判决
  // 表达式照常求值，但 `check(witnessed(…))` 收到的永远是 `true` ⇒ 判决被中和，而 15 条
  // needle、执行计数、原始观测全部照旧成立（E 泳道实测 `EXIT=0`）。修前 `roundTwentySelfTest`
  // 只探测 `self-test-witness-probe` **一个** id，所以"按 id 特判"不会被它发现。
  //
  // 判据：**逐个登记点**探测 `witnessed(id, false) === false` 与 `witnessed(id, true) === true`
  // （探测完回滚计数，不影响上面第二段的"执行过"对账）—— 任何按 id / 按层特判返回值的写法
  // 都会在这里当场露出来。
  {
    const snapshot = new Map([...JUDGMENT_RUNS].map(([key, value]) => [key, { ...value }]))
    const probed = []
    for (const site of REQUIRED_JUDGMENT_SITES) {
      probed.push(site.id)
      const before = snapshot.get(site.id) ?? { runs: 0, passed: 0, failed: 0 }
      if (witnessed(site.id, false) !== false) {
        sitesSeen.push(`判决点 ${site.id} 的见证**返回契约**不成立：\`witnessed('${site.id}', false)\``
          + ' 没有原样交回 `false` —— 判决表达式的结果被改写了（按 id 特判 `return true` 的同族）')
      }
      // **判决值必须真的落进计数**（否则"分开记 `passed`/`failed`"只是装饰）：
      // 探测 `false` 之后 `failed`/`runs` 各 +1，探测 `true` 之后 `passed` +1 ——
      // 把 `witnessed` 退回"只记次数"（`JUDGMENT_RUNS.set(site, n + 1)`）会让这两条当场红。
      const afterFalse = JUDGMENT_RUNS.get(site.id) ?? { runs: 0, passed: 0, failed: 0 }
      if (afterFalse.failed !== before.failed + 1 || afterFalse.runs !== before.runs + 1) {
        sitesSeen.push(`判决点 ${site.id} 的**判决值没有记进 \`failed\`**（探测 \`false\` 后 `
          + `failed ${before.failed}→${afterFalse.failed}、runs ${before.runs}→${afterFalse.runs}，`
          + '期望各 +1）—— 见证必须记"判成什么"，不能只记"调用过几次"（R21 fix-6 / E-02）')
      }
      if (witnessed(site.id, true) !== true) {
        sitesSeen.push(`判决点 ${site.id} 的见证**返回契约**不成立：\`witnessed('${site.id}', true)\``
          + ' 没有原样交回 `true`')
      }
      const afterTrue = JUDGMENT_RUNS.get(site.id) ?? { runs: 0, passed: 0, failed: 0 }
      if (afterTrue.passed !== before.passed + 1 || afterTrue.runs !== before.runs + 2) {
        sitesSeen.push(`判决点 ${site.id} 的**判决值没有记进 \`passed\`**（探测 \`true\` 后 `
          + `passed ${before.passed}→${afterTrue.passed}、runs ${before.runs}→${afterTrue.runs}，`
          + '期望分别 +1 / +2）—— 同上')
      }
    }
    JUDGMENT_RUNS.clear()
    for (const [key, value] of snapshot) JUDGMENT_RUNS.set(key, value)
    if (probed.length !== REQUIRED_JUDGMENT_SITES.length) {
      sitesSeen.push(`见证返回契约只探测了 ${probed.length}/${REQUIRED_JUDGMENT_SITES.length} 个登记点`
        + ' —— 探测循环被短路（"逐点自证"必须罩住整张表）')
    }
  }
  for (const violation of JUDGMENT_CONTRACT_VIOLATIONS) sitesSeen.push(violation)
  if (sitesSeen.length > 0) {
    process.stderr.write('\ncheck-integration-tests: **判决句登记表**不成立'
      + '（R19A-03 ② / R20A-04 / R21 fix-6 E-02）——\n'
      + sitesSeen.map(item => `  · ${item}\n`).join('')
      + '  ⇒ 保留尝试计数、把判决掏成 `check(true, …)`、包进 `if (false) …`、或用一行'
      + ' `witnessed(\'<id>\', true)` 诱饵伪造计数时，仓里的事实一个字都没变 ——'
      + ' 只有"判决句逐字在场"+"判决在行首的独立语句里真的执行过"+"见证原样交回判决值"'
      + ' 三条一起，才能发现这些编辑。\n')
    return 1
  }
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
  + '\n  **判据的语义（第十八轮 R18A 之后的逐字口径；R17-X 的语义保留）**：'
  + '① **命令位是登记制** —— CI **入口形态**（workflow `run:` 块、manifest 别名值、Makefile 目标体与'
  + ' `$(shell …)`、compose `command`/`entrypoint`、`eval`/`trap` 的**字符串取值**、'
  + ' `ssh <主机> <命令>` 与 `docker|podman run|exec` 的**参数位命令位**）的命令位上，每个不在'
  + ` \`CI_STANDARD_COMMANDS\`（${CI_STANDARD_COMMANDS.size} 个标准词）里的可执行名都必须在`
  + ` \`CI_COMMAND_REGISTRY\`（${CI_COMMAND_REGISTRY.length} 条）里登记；**未登记即红**，`
  + '登记了却不再命中（死条目）也红。'
  + '② **命令位形态必须能解析出字面量**（R17A-01 的收口）—— 首词含 `$`/反引号时，'
  + '闭包按**同一段文本内的常量传播**解析（`NAME=字面量`、`$NAME`/`${NAME}`/`$NAME后缀`、'
  + '`$(echo <字面量>)`、反引号同形）；**解析不出即 fail-closed 并具名点名**（`command-shape-unreadable`），'
  + '**不再"取不出名字就放行"**。两条例外都不是放行：路径形态（含 `/`）交给载体跟随/文本面，'
  + '通配形态（含 `*?[]`）交给 `case`/glob 的既有口径；确实合法但闭包结构上解析不了的'
  + `（本仓 = GitHub 表达式）逐处登记进 \`CI_SURFACE_COMMAND_SHAPE_ACK\`（${CI_SURFACE_COMMAND_SHAPE_ACK.length} 条，死条目也红）。`
  + '③ **字符串参数执行面在网内**（R17A-02；**R19A-01 收口**）—— `eval` 的取值（按入口形态递归）、'
  + '`trap` 的取值（按被跟随脚本的宽松面递归）、`bash <<< <文本>`（取值即脚本文本）、'
  + '进程替换 `<(...)`：**脚本位**（解释器 / `source` 之后的第一个非旗标实参，或命令位本身）'
  + '**不分模式**一律 fail-closed（被执行的是子进程的输出；R19A-01 的现场就是"只在 strict 面'
  + 'fail-closed"⇒ 被跟随的脚本正文里 `bash <(cat 仓内文件)` 两张网同时漏），'
  + '**流/参数位**（`done < <(…)`）在入口形态下维持 R17-X 口径、在被跟随的脚本正文里则把'
  + '**内层子命令**入队成闭包节点继续扫（输出是数据，但那条命令真的会执行）；'
  + '`bash <含空白>` / `bash *.sh`'
  + '（脚本位读不懂 ⇒ fail-closed：**含 `/` 的间接层不再豁免** —— `bash "$D/x.sh"`、'
  + ' `bash /tmp/x.sh` 与 `bash *.sh` 同判，R18A-01；`find … -exec <shell> <脚本位>` 的脚本位'
  + ' 同网，R18A-02）。**脚本位取词只有一份实现**（**R20A-01 收口**）：`--` 是**选项结束标记**'
  + '（`bash -- "$P"` 的脚本位是 `"$P"`）、**带取值的旗标**连取值一起跳过（`-O extglob` / `-o 选项` /'
  + ' `--rcfile 文件`），`source` / `.` 与 `find -exec` 走**同一个**取词函数；'
  + '旗标段之后**没有脚本位**（`bash` / `bash -e` / `bash --`）也 fail-closed（shell 那时从 stdin'
  + ' 读命令）；**脚本位指向仓内不存在的字面路径**（运行期生成物，R20A-05）同样记红，'
  + ' "先构建再执行"只能逐处登记进 `CI_SURFACE_GENERATED_SCRIPT_ACK`（死条目也红）。'
  + '**自指脚本位**（R19A-04；**R20A-02 收口**）不是"读不懂"：在被跟随的仓内 shell 脚本正文里，'
  + '`$(dirname "$0")/<尾段>` / `${BASH_SOURCE[0]%/*}/<尾段>` / 裸 `$0` 按**当前脚本所在目录**'
  + '求值（求值出仓内存在的路径 ⇒ 照常跟随并继续扫描；求值不出 ⇒ 仍 fail-closed）——但 **`$0` 族'
  + '只在脚本被"执行"时成立**：`source` / `.` 进来的正文里 `$0` 仍是**调用者**，那里不求值'
  + '（`BASH_SOURCE` 族照旧求值），所以"跟随诱饵文件"这条旁路是红的。'
  + '④b **JS/TS 包装脚本里的"先解析、后执行"在网内**（R18A-03；**R19A-02 收口**）：'
  + '`spawn|exec|fork` 的实参表达式按常量展开（`const T = \'…\'`、`join|resolve` 拼接、'
  + '模板字面量、数组/对象常量表 + 下标/成员、`+` 拼接、**数组 `.slice()`/`.concat()`**、'
  + '**数组解构 `const [A, B] = […]`**、**同仓跨文件 `import` 的导出常量**'
  + '（含 `export {x as y}` / `export default` / `export {x} from \'./y\'` 链，深度上限 4））'
  + '——解析出的候选回到 token 网/`reached` 判据，所以"路径先算出来再传给 spawn"不再隐形。'
  + '**误报面（不得变成误报工厂）**：形参 / 运行期取值不展开也不记红（本仓 33 处 '
  + '`spawnSync(\'bash\', …)` 的同族形态），`node:|` 外部包的 import 不判；'
  + '**同仓相对 import 读不懂即 fail-closed**（模块读不到 / 没有那个导出常量 / 链过深 /'
  + ' **导出存在但取值求不出来** —— 条件表达式那类"`process.env.X ? a : b`"不再被静默当成'
  + '"没有候选"，R20A-03 ②）。**三种同等常规的跨文件写法同样在网内**（R20A-03 ①）：'
  + '`import * as NS from \'./x.mjs\'`（成员按 `NS.成员` 惰性求值）、`await import(\'./x.mjs\')`、'
  + 'CJS `const { ENTRY } = require(\'./x.cjs\')` / `exports.ENTRY = …`。'
  + '④c **载体链深度超限 fail-loud**（R18A-04）：超过上限的节点不再静默丢弃，'
  + ' 而是记红并打出链（越深的包装链正是"把端到端入口藏起来"最容易的形态）。'
  + '④ **跟随面是"仓内任何路径"** —— 命令位/参数位上的仓内文件（脚本 / `.mjs`·`.py` / `python -m` 模块 /'
  + ' `node -e` 源码 / compose 文件 / `.env`）都要么被跟随、要么被登记；带 `$`/`{{ }}` 拼出来的'
  + '**端到端路径**由文本面强制登记（`data-reference`）。'
  + '⑤ **外部命名空间**（R17A-04 的误报收口）—— `python3 -m <模块>` 只在模块的**顶层段确实属于本仓**'
  + '（`<段>.py` / `<段>/__init__.py` / `<段>/`）时才要求解析出载体；否则按标准库/第三方模块处理。'
  + '包运行器（`npx`/`bunx`/`npm exec`/`yarn dlx|exec`/`pnpm dlx|exec`/`bun x`）后面那一位是'
  + '**包内 bin**（外部命名空间）⇒ 不过逐词登记，但它**遮蔽闭包认识的命令名**时（`npx make …`）'
  + '仍 fail-closed；`--` 之后是真命令，照常走登记制。'
  + '⑦ **覆盖层的判决见证绑"判决结果"**（R19A-03）：通过行列出的每一层都要交出**原始观测**'
  + '（子进程退出码 / 命中数 / 违规列表，写在**该层自己的实现里**，循环层写在循环体内），'
  + '收尾按逐层登记规则**重新判决**一遍 —— 把某一层整层掏空（`for (… of [])`）会让观测归零 ⇒ 红；'
  + '把循环体的判决掏成恒真（事实没变、只是守卫不再看它）则由**判决句登记表**兜：'
  + '每层真正咬人的那一句 `check(...)` 必须逐字在场（改判决必须同步登记值，进 diff 才会被评审看见）。'
  + '**R20A-04 起再加一层**：判决表达式必须经过 `witnessed(<判决点 id>, …)` —— 收尾逐个断言'
  + '"这个判决点**真的执行过**（执行计数 ≥ 1）"，于是"保留判决句原文、把它包进 `if (false) …`"'
  + '这种编辑**只改这一个文件**就会被发现（修前它只被另一个文件的 sha256 登记值兜）。'
  + `**R21 fix-6 / E-02 起这一层再收紧成三条**（${REQUIRED_JUDGMENT_SITES.length} 个登记点逐个判）：`
  + '① 见证记的是**判决值**（`runs`/`passed`/`failed` 分开记，非布尔判决值当场记违约）而不只是'
  + '"调用发生过"；② 判决句必须是**行首的独立语句** —— `if (false) check(witnessed(…))` 与'
  + '"上一行悬挂 `if (…)`"两种掏空形态当场红（修前它配一行 `witnessed(\'<id>\', true)` 诱饵即可'
  + '静默，15 点里 13 点实测失效）；③ **返回契约逐 id 自证** —— 对每个登记点探测'
  + '`witnessed(id, false) === false` / `witnessed(id, true) === true`，按 id 特判 `return true`'
  + '的写法在这里露出来。**无见证不是"静默通过"**：登记表里没有判决句的层、计数为 0 的点、'
  + '返回契约不成立的点，三条中任意一条都当场红（`EXIT=1`），不会只写在散文里。'
  + '⑥ **覆盖边界（认账）**：登记制只罩**入口形态**的命令位；**被跟随的仓内脚本正文不逐词登记**'
  + '（那里的命令位含脚本自定义函数与 shell 语法构件），它们由"载体跟随 + token 网 + 文本网 +'
  + ' make/compose 扩张"覆盖 —— 因此"新增一个未登记的**工具**并只在某个脚本正文里调用它"这条判据'
  + '看不出来（它与"CI 是否执行端到端入口"无关）；而"把端到端入口藏进任何一层载体"是红的。'
  + '**常量传播只覆盖同一段文本内的简单赋值与字面量命令替换**：`$(cat <文件>)`、`$1`/`$@`、'
  + '`${VAR:-默认}`、GitHub 表达式都解析不了 —— 命令位上遇到它们一律'
  + 'fail-closed（不是"没看见"），参数位上由文本面/载体跟随兜；'
  + '**R24 FIX-26 / X3-01 起写面另加三条**（"先写后执行"那一格的覆盖面）：'
  + '⑦ **解释器内联脚本里的写**（`python3 -c` / `node -e` / `perl -e` 的 `Path(X).write_bytes`、'
  + '`writeFileSync(X)`、`open(FH, \'>\', X)` …）按 {@link INLINE_SCRIPT_WRITE_PATTERNS} 进网 ——'
  + '只覆盖**第一实参是字面量**的写调用，路径拼出来的仍看不见；'
  + '⑧ **`$GITHUB_ENV`/`$GITHUB_OUTPUT` 递过来的写目标**参与 job 作用域的常量传播'
  + '（`echo "V7T=scripts/x.sh" >> "$GITHUB_ENV"` + `> "$V7T"` 同判），'
  + '但**同一步里**先 export 再用不算（语义与 GitHub 一致）；'
  + '⑨ **写面作用域跨闭包节点回灌**：被调用的仓内包装脚本与本地复合 action 里发生的写并进'
  + '**同一个 job**（`bash scripts/write.sh` / `uses: ./.github/actions/x` 之后执行同一路径 ⇒ 红）——'
  + '跟随深度上限 ' + `${WRITE_CARRIER_FOLLOW_MAX_HOPS} 层，读不到 / 变量拼出来的载体不猜（由别的格 fail-closed）。`
  + '`sed -i` / `dd of=` / `git checkout <ref> -- <路径>` 这类等价改写面**仍未建模**（认账边界）。'
  + '**运行期生成 + 不透明编码是固有边界**（载荷里没有 token 可读）—— 那条路只能靠'
  + '"脚本位指向仓内不存在路径"那一格 + `CI_SURFACE_GENERATED_SCRIPT_ACK` 逐处认账（R20A-05）。'
  + '本守卫只判"可静态执行的那部分"，不声称端到端被门禁覆盖）\n',
)
return 0
}

export { CONTRACT_TESTS, INTEGRATION_ENTRIES, runTest, scriptPathFor, startGateway }

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(await main())
}
