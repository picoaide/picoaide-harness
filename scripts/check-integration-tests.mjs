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
 */
const INTEGRATION_ENTRIES = [
  { path: 'integration-tests/run-all.sh', role: 'aggregate' },
  { path: 'integration-tests/contractkit.py', role: 'judge-channel' },
  { path: 'integration-tests/dex/config.yaml', role: 'fixture' },
  {
    path: 'integration-tests/dex/dex-sso-test.py',
    role: 'contract-test',
    runner: 'python3',
    aggregatePath: 'dex/dex-sso-test.py',
    aggregateName: '1. Dex SSO 流程测试',
  },
  {
    path: 'integration-tests/openldap/ldap-rbac-brand-test.py',
    role: 'contract-test',
    runner: 'python3',
    aggregatePath: 'openldap/ldap-rbac-brand-test.py',
    aggregateName: '2. LDAP + RBAC + 渠道集成测试',
  },
  { path: 'integration-tests/electron-shots/assertions.mjs', role: 'assertion-table' },
  { path: 'integration-tests/electron-shots/report.mjs', role: 'judge-channel' },
  {
    path: 'integration-tests/electron-shots/electron-shots.mjs',
    role: 'judged-runner',
    runner: 'node',
    aggregatePath: 'electron-shots/electron-shots.mjs',
    aggregateName: '3. Electron 截图验证(需打包 app)',
  },
]

/**
 * 语法/判据面扫描的扩展名（`INTEGRATION_ENTRIES` 必须覆盖它们全部）。
 *
 * 为什么连 `.yaml` 也在内：`dex/config.yaml` 是**夹具**（Dex 的测试用户/客户端定义），
 * 改它等于改这个用例的前置，而此前它与"新增一个没人管的夹具"一样零判据。
 * 只登记可执行体、把夹具留在集合外，正是 F-03 那条"判据的语料完整性"的同族形态。
 */
const INTEGRATION_SCANNED_EXTENSIONS = ['.py', '.mjs', '.sh', '.yaml', '.yml']

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

  // ③ 聚合层双向对账：`run-all.sh` 的 `run "<名>" <runner> <路径>` 行 ↔ 登记表里
  //    带 aggregateName 的条目（顺序也钉住 —— 顺序变了同样是"聚合层被改过"）。
  const runner = existsSync(join(ROOT, 'integration-tests', 'run-all.sh'))
    ? readFileSync(join(ROOT, 'integration-tests', 'run-all.sh'), 'utf8')
    : ''
  // 允许路径之后还有额外实参（`"$SERVER_BASE"` 这类）；最少三段：名字 / runner / 路径。
  const aggregateLines = [...runner.matchAll(/^run\s+"([^"]+)"\s+(\S+)\s+(\S+)(?:\s+.*)?$/gmu)]
    .map(match => ({ name: match[1], runner: match[2], path: match[3] }))
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
  },
  {
    scenario: 'skip', test: CONTRACT_TESTS[1], expect: 77,
    must: /SKIP/u, mustNot: /RESULT: PASS/u, label: 'provider 未配置 ⇒ ldap 必须显式 SKIP(77) 且不得报 PASS',
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
    notes.push(`[${item.scenario}] ${item.test.id}: exit ${status} ✓`)
  } finally {
    await gateway.close()
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
// ---------------------------------------------------------------------------
const COVERED_LAYERS = [
  `语法（${pyFiles.length} 个 .py ast.parse / ${mjsFiles.length} 个 .mjs node --check）`,
  `登记制（${INTEGRATION_ENTRIES.length} 项：登记了不在 / 在却没登记 / 聚合层少调多调或换序 全红）`,
  `聚合层接线（${INTEGRATION_ENTRIES.filter(entry => entry.aggregateName !== undefined).length} 条逐字对拍）`,
  `契约判据表（${CONTRACT_TESTS.map(test => `${test.id} ${(CONTRACT_CRITERIA.get(test.id) ?? []).length} 条`).join(' / ')}：`
    + '精确 id 集合 + 逐 id 正负例条数 + 运行期逐条引用 + 观测非空）',
  `契约判据本体自证（--self-test，每条判据正/负例夹具）`,
  `契约判定通道自证（--self-check，全部夹具经**运行期** report() 求值）`,
  `契约端到端变异（逐条判据掏成恒真 / judge 恒真 / 只改计票侧 / 运行期通道换恒真包装 —— 全部必须变红）`,
  'electron-shots（接线 + SKIP(77) 契约 + 判据表自检 + 判定通道自检 + 4 条判定通道变异）',
  `假网关场景（${SCENARIOS.length} 条：正例必须绿 / 变异必须红 / 环境缺失必须 SKIP 且不得报 PASS）`,
  '聚合层三项全 SKIP ⇒ 77 且不报 PASS',
]
// 通过行自己也要被钉住：枚举条数必须等于登记项数（改一个而漏改另一个 ⇒ 红）。
const EXPECTED_COVERED_LAYERS = 10
if (COVERED_LAYERS.length !== EXPECTED_COVERED_LAYERS) {
  process.stderr.write(`\ncheck-integration-tests: 通过行的覆盖面枚举 ${COVERED_LAYERS.length} 项，`
    + `与登记值 ${EXPECTED_COVERED_LAYERS} 项不一致 —— 通过行的自我陈述必须与真实覆盖面一致\n`)
  return 1
}
process.stdout.write(
  `check-integration-tests: OK — 已覆盖 ${COVERED_LAYERS.length} 项：\n`
  + COVERED_LAYERS.map(layer => `  · ${layer}\n`).join('')
  + '  （**不在本守卫覆盖面内**：integration-tests 的真机端到端需要 Docker + 真实服务端 + 显示器，'
  + 'CI 语境下 0 执行；本守卫只判"可静态执行的那部分"，不声称端到端被门禁覆盖）\n',
)
return 0
}

export { CONTRACT_TESTS, INTEGRATION_ENTRIES, runTest, scriptPathFor, startGateway }

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(await main())
}
