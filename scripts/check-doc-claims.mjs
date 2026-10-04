#!/usr/bin/env node
/**
 * 文档数字守卫（2026-09-23 新增；起因 = 第二轮审计 W3 的 D-4 / D-5）。
 *
 * **两处真实漂移**（门禁全绿下漏过去，因为当时**没有任何守卫**看这两处）：
 *   · D-4：官网 FAQ / 理念页 4 处写「当前 pin `dsh-v0.1.5-rc.2`」，而 `upstream.json`
 *     的 `sourceVersion` 已是 `0.1.6-alpha.2`（`dsh-v0.1.6-alpha.2`）——升级上游时
 *     没人会想到去改官网散文。
 *   · D-5：插件开发页声称平台模块表「与上游**逐字一致**」并逐个列出，实际只列了
 *     8 项（漏 `@deepseek-ai/dsh-client-ui-dockkit`）；同句引用的
 *     `packages/client/web/src/platform.ts` 在本仓根本不存在（真源在子模块里）。
 *     数字漂移 + 路径失真两处都在同一句话上。
 *
 * ## 判据面（R13-GF 修复，2026-09-25）：两条 → **六项**，且通过行必须与覆盖面一致
 *
 * 修前的两个问题（对抗探针 `temp/r13/F/sub-docs/probe-adversarial.sh` 实测）：
 *   · **硬数字零判据**：官网「保留最近 **3** 个版本」「启动 **60** 秒后首次检查、之后每
 *     **6** 小时一次」「**三**平台安装包」改错之后本守卫与 `check:migration-range` **都
 *     EXIT=0**，还打印「文档数字与真源一致 ✅」；
 *   · **自我陈述比覆盖面宽**：只有两类 claim 有判据，通过行却声称"文档数字与真源一致"。
 *
 * 现在**每一项的真源都是代码里的量**（不是把字面量抄进守卫 —— 本仓已登记
 * 「各钉自己的字面量」是假绿形态）：
 *   1. 上游 pin：扫非记录面 md 里反引号包裹的 `dsh-v…` 断言，必须逐字等于
 *      `dsh-v${upstream.json:sourceVersion}`；
 *   2. 平台模块表：`site/src/content/docs/{,en/}plugin-development.md` 里提到
 *      `PLATFORM_MODULES` 的那一行，其反引号模块名集合必须与
 *      `scripts/platform-modules.mjs` 的 `PLATFORM_MODULES` **集合相等**；
 *      若同行写了「共 N 项」/「N entries」，N 也必须等于实际项数；
 *   3. **更新服务器保留版本数** ↔ `scripts/ci-publish-update-server.sh` 里 `KEEP=` 的
 *      取值（正则从源码解析；解析不出 / 赋值不唯一一律 fail-loud）；
 *   4. **客户端更新检查节奏**（首个延迟的秒数 / 周期的小时数）↔
 *      `packages/host/desktop/src/updates.ts` 的 `initialDelayMs` / `intervalMs` 缺省值。
 *      该文件是 TS + schemastery schema，**不能直接 import** ⇒ 正则取 `.default(…)` 的
 *      实参，只接受整数乘加表达式（`6 * 60 * 60 * 1000`），其余形态 fail-loud；
 *   5. **客户端平台数** ↔ `packages/host/desktop/package.json` 的 `build` 里
 *      声明了 `artifactName`（安装包产物名）的平台段数（`mac` / `win` / `linux`）。
 *
 * 数字断言的形式覆盖中文数字（`三平台`）、ASCII 数字（`3 平台`）与英文数词
 * （`three platforms`）。**同名不同源的数字不混判**：每条规则可带「上下文锚」，
 * 只有锚点命中的行（±1 行窗口）才算这条 claim —— 服务端保留策略调度器的
 * 「每 6 小时一次」与客户端更新周期同形但**不同源**，被锚点排除（守卫照样打印
 * 被排除的条数，不静默吞掉）。
 *
 * **通过行（`✅`）由登记表生成，且打印前被反解断言**：`已覆盖 N 项：<逐条标签>` 中的 N
 * 必须等于本轮**真正产出过断言**的项数、标签必须逐一出现、且不得再出现无边界措辞
 * 「文档数字与真源一致」。真仓形态下另要求「真正产出断言的项数 == 登记项数」
 * （某项真源或素材被摘空即 EXIT=2）—— 所以这条通过行不可能再声称它没判过的东西。
 *
 * 豁免：行内标记 `doc-claim:allow`（与 `check-migration-range.mjs` 的
 * `migration-range:allow` 同一约定）；**记录面**（docs/planning|decisions|releases、
 * docs/AUDIT-*、带日期文件名、server/docs/superpowers/**）照旧排除 —— 它们记录的是
 * "当时"的事实，要求它们跟着真源走等于篡改历史。
 *
 * 用法：node scripts/check-doc-claims.mjs [--root <dir>] [--json] [--selftest]
 * 退出码：0 = 全部一致；1 = 有漂移；2 = 用法错误 / **扫描面缩水（前置失败，见下）**
 *      / **外部设置了已废除的测试缝**（见下节）。
 *
 * ## 通过行探测：**独立子入口**，不是本入口上的开关（2026-09-25，第十四轮 V14-A + lane M）
 *
 * **现场一（CI run `36086661679` 的 `gate-guards` job，分支 `fix/round13-batch`）**：
 * `check:doc-claims` 与 `check:check-workspaces` 双双失败，日志逐字为
 *
 * ```
 * check-doc-claims: 通过行探测子进程 exit 2（同一份实现、同一棵树，本应同为通过）——
 *   拒绝出结论：check-doc-claims: 测试缝 CHECK_DOC_CLAIMS_VERDICT_PROBE 在 CI 语境下不得设置（实际 "1"）
 * ```
 *
 * **机制（自相矛盾）**：{@link printVerdict} 的第 ② 层判据要"跑一次真脚本、读真输出"，于是
 * **自己**用 `spawnSync(process.execPath, [本文件, …], { env: { ...process.env, [探测开关]: '1' } })`
 * 拉起子进程；子进程**继承 `CI=true`** ⇒ 撞上本文件那条"测试缝在 CI 语境下不得设置"的规则
 * （exit 2）⇒ 父进程判"探测子进程 exit 2"⇒ 守卫必然失败。**判据的判据在另一个语境下判它
 * 自己非法**：本地（`CI` 未设）全绿、CI 必红，PR 永远不可能绿。
 * 第一次修法把开关从 env 迁到 **argv**（`--verdict-probe`）。
 *
 * **现场二（第十四轮独立复审泳道 V14-A 的 VA-02-F2，P1）**：argv 同样是**外部输入面** ——
 * `NODE_OPTIONS="--import=<载荷>"`（纯环境变量）能在主模块求值前 `process.argv.push(...)`
 * 把开关塞进去。实测（V14-A §2.4，lane M 复跑）：把探测子进程的打印路径改成更宽的自述
 * （d6 形态）后，**朴素跑 EXIT=1、`--verdict-probe` 直跑 EXIT=0、
 * `NODE_OPTIONS=--import=…` 伪造 EXIT=0**（两种 CI 语境都是）—— 第 ② 层要保护的那条判据
 * 被从红翻绿，而 `NODE_OPTIONS` 正是第一次修法声明"已废除"的那条通道。
 *
 * **修法（V14-A 首选）：不要把"探测"做成被判对象**同一入口**上的开关。**
 *   ① 探测子进程拆成**独立入口** {@link PASS_LINE_CHILD_ENTRY}
 *      （`scripts/doc-claims-passline-child.mjs`）：它 **import 本模块**（拿的是同一份判据的
 *      导出面：`summaryLine` / `failures` / `hits` / `moduleHits` / `surfaceProblems`），
 *      **不接受任何改变行为的开关**（只透传 `--root <dir>`，其余参数一律 exit 2），
 *      干净就把通过行打出去、否则按同样的退出码拒绝；
 *   ② 本入口**再没有任何"探测模式"**：`--verdict-probe` 现在是**未知参数**（exit 2），
 *      argv 里被塞任何东西都只会让判据更严，翻不了绿；
 *   ③ 本模块的"打印 + 出结论"这一段用 **`import.meta.main`**（Node ≥24.2 的**加载器**判定，
 *      argv 改不动它）护住 —— 被 import 时只提供导出面，不打印、不出结论。
 *      旧 Node 上退回"独立子入口在 import 前设置的进程内标记"（同样不是 env/argv 通道）；
 *      两条路都**不会**因外部输入而跳过这一段。
 *   ④ {@link refuseRetiredTestSeam} 保持更强的规则：`CHECK_DOC_CLAIMS_VERDICT_PROBE`
 *      **任何语境**下被设置（含空串）⇒ exit 2（它没有任何合法来源）。
 *
 * **变异判据**：`--verdict-probe` 直跑 / `NODE_OPTIONS=--import=…` 伪造，在 d6 变异下都必须
 * **不再是 EXIT=0**（lane M 实跑见 `temp/r14/laneM/REPORT.md` §1）。
 *
 * **残余面（认账）**：能**在进程内执行任意代码**的对手（同一个 `NODE_OPTIONS=--import` 载荷
 * 改全局标记 / patch `import.meta`）不在本判据的拦截面里 —— 那是"控制进程启动"的对手。
 * 本判据拦的是**纯数据通道**（env / argv / 仓内文件）：前两者已被上面三条关掉，后者要过
 * `check-install-integrity.mjs` 的执行体锚定（子入口**逐字节 == HEAD**）。
 *
 * 同族排查（第十三轮一并做的）：`scripts/check-integration-tests.mjs` 的 `CHECK_IT_*_SCRIPT`、
 * `check-patch-pin.mjs` / `check-theme-tokens.mjs` 的 `*_SKIP_*`、`verify-glitchtip-ops-check.mjs`
 * 的 `CHECK_GLITCHTIP_SCRIPT` 都**没有**"自己也用该 env 拉子进程"的形态（见 REPORT.md 的逐条判定表），
 * 所以不跟着改语义。
 *
 * ## 缩面判据（2026-09-23 第四轮审计 R4-A-4）
 *
 * 扫描面是**手写路径数组**，而旧实现**不校验它是否仍覆盖登记面** ⇒ 把
 * `site/src/content/docs` 从 `SCAN_PATHS` 删掉后，官网上那处**真实** pin 漂移由 EXIT=1
 * 变成 EXIT=0 并打印"一致 ✅"（唯一的地板是 `scanned === 0`，零点，部分缩面永远触发不到）。
 * 现在照 `scripts/wasm/check-authoring-claims.mjs` 的模式补**三条互相独立**的判据：
 *   ① 登记值：`SCAN_PATHS` 必须覆盖 `REQUIRED_SCAN_PATHS` 的每一项（删任一项即红）；
 *   ② 派生真源（守卫**直接读**的文件）：`MODULE_DOCS` 必须在扫描面内 —— "判什么"与
 *      "扫什么"脱节时当场红，与①互相独立（同时改两份清单也躲不过它）；
 *   ③ 树派生：仓库里存在的 `DERIVED_SCAN_ROOTS`（用户可见文档真源）必须在扫描面内。
 * 另加**绝对下限**（`SCAN_PATH_MIN_FILES` / `MIN_SCANNED_FILES` / `MIN_PIN_CLAIMS` /
 * `MIN_PIN_CLAIMS_BY_PATH`），只在"真仓形态的根"上强制（合成树/自证夹具只需非空）——
 * 防"根还在、但内容被搬走或排除规则把文件吃空"。任一条不成立即**退出码 2**。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// ─────────────────────────────────────────────────────────────────────────────
// 通过行探测：**独立子入口**（不是一个开关）
//（2026-09-25 第二轮：env → argv → 拆入口；现场见文件头「通过行探测」小节）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 通过行探测的**独立子入口**（仓库相对路径）。
 *
 * 它 import 本模块（同一份判据的实现），干净就把通过行打出去；**不接受任何改变行为的开关**。
 * 父进程按这个路径 spawn 它（见 {@link printVerdict} 的第 ② 层）。
 *
 * 为什么不是"本入口上的一个 argv 开关"：argv 与 env 一样是**外部输入面**
 * （`NODE_OPTIONS=--import=<载荷>` 能在主模块求值前改写 `process.argv`）——
 * 第十四轮 V14-A 的 VA-02-F2 实测：d6 变异下伪造开关能把 EXIT=1 翻成 EXIT=0。
 */
export const PASS_LINE_CHILD_ENTRY = 'scripts/doc-claims-passline-child.mjs'

/**
 * 本文件自己被**当作入口**执行吗？
 *
 * 优先用 `import.meta.main`（Node ≥24.2：由**加载器**判定，`process.argv` 改不动它）。
 * 旧 Node 上没有这个属性 ⇒ 退回"独立子入口在 import 之前设置的进程内标记"
 * （{@link PASS_LINE_CHILD_MARK}）—— 那**不是** env/argv 通道，外部塞不进这个标记。
 * 两条路的默认值都是"我是主入口"：不确定时**多跑**判据（fail-closed），
 * 绝不在不确定时跳过"打印 + 出结论"这一段。
 */
export const PASS_LINE_CHILD_MARK = Symbol.for('picoaide.check-doc-claims.passline-child')

/** 见 {@link PASS_LINE_CHILD_MARK}：本进程是不是被独立子入口 import 的。 */
export const IS_PASS_LINE_CHILD = globalThis[PASS_LINE_CHILD_MARK] === true

/**
 * `import.meta.main`（Node ≥24.2）优先；旧 Node 退回子入口标记（标记缺席 = 主入口）。
 * @returns 本模块是不是被当作入口执行。
 */
function isEntryModule() {
  if (typeof import.meta.main === 'boolean') return import.meta.main
  return !IS_PASS_LINE_CHILD
}

/**
 * 已**废除**的环境变量开关（只留名字给"外部设置即攻击面"的判据用）。
 *
 * 修好之后**没有任何合法路径**会设置它：探测子进程走独立入口，拉子进程时 `env` 里不再出现
 * 这个名字。所以 {@link refuseRetiredTestSeam} 的规则比旧规则更强 —— **任何语境**下被设置
 * 都 exit 2（旧的"仅 CI 语境下拒绝"既放过了本地攻击，又让判据在 CI 下自杀）。
 */
const VERDICT_PROBE_ENV = 'CHECK_DOC_CLAIMS_VERDICT_PROBE'

/**
 * **已废除的测试缝**：{@link VERDICT_PROBE_ENV} 在**任何语境**下被设置 ⇒ exit 2。
 *
 * 为什么与语境无关（而旧实现只在 CI 下拒绝）：修好之后这个环境变量**没有任何合法来源**，
 * 于是"它被设上了"只剩一种解释 —— 有人想关掉"通过行必须钉在打印路径上"这条判据。
 * 旧规则的两个漏洞正是 2026-09-25 那次 CI 必红的成因：本地设它**完全无声**（攻击面），
 * CI 下它又杀死了判据**自己拉起的**子进程（自相矛盾）。
 *
 * **空串同样是"被设置"**（第十四轮 V14-A 的 VA-02-F1）：旧实现把 `''` 当成"没设置"，
 * 于是"任何语境下都不得设置"这句自述对空串不成立；它没有合法来源，一律 exit 2。
 * 诊断里保留固定短语 `测试缝已废除` 便于检索。
 */
function refuseRetiredTestSeam() {
  const value = process.env[VERDICT_PROBE_ENV]
  if (value === undefined) return
  console.error(`check-doc-claims: 测试缝已废除：环境变量 ${VERDICT_PROBE_ENV} **任何语境下都不得设置**`
    + `（实际 ${JSON.stringify(value)}）—— 通过行探测已改由独立子入口承担`
    + `（${PASS_LINE_CHILD_ENTRY}：父进程按路径 spawn 它，env 里不再注入任何探测开关）。`
    + '所以这个环境变量没有任何合法来源（**空串也算被设置**），外部设置它一律视为攻击面：'
    + '它唯一的效果是把"通过行必须钉在打印路径上"这条判据整个关掉。'
    + '环境（`$GITHUB_ENV` / `env` / 父进程继承）与 argv 都是外部可改的，独立入口不是 ——'
    + '详见文件头「通过行探测」小节。')
  process.exit(2)
}

refuseRetiredTestSeam()

const args = process.argv.slice(2)
let root = resolve(process.cwd())
let json = false
let selftest = false
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--root') {
    const value = args[index + 1]
    if (value === undefined) {
      console.error('check-doc-claims: --root 需要一个目录')
      process.exit(2)
    }
    root = resolve(value)
    index += 1
  } else if (args[index] === '--json') json = true
  else if (args[index] === '--selftest') selftest = true
  else {
    console.error(`check-doc-claims: 未知参数 ${args[index]}`)
    process.exit(2)
  }
}

/** 独立子入口的绝对路径（按**本文件自己的位置**解析 —— 与 cwd 无关）。 */
const childEntryPath = fileURLToPath(new URL('./doc-claims-passline-child.mjs', import.meta.url))

/**
 * 交给独立子入口的参数：**只透传 `--root <dir>`**（判定哪一棵树），其余一律不透传。
 *
 * 子入口不接受任何"改变行为"的开关：`--json` / `--selftest` 之类的取值不会让它少判一步，
 * 而父进程只信它 stdout 里那一行。所以"伪造 argv"在这里没有可伪造的东西 ——
 * 这一条正是第十四轮 V14-A 的 VA-02-F2（P1）的收口点。
 * @returns 子入口的参数数组。
 */
function rootArgsForChild() {
  const forwarded = []
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '--root') continue
    if (args[index + 1] !== undefined) forwarded.push('--root', args[index + 1])
    index += 1
  }
  return forwarded
}

/** 扫描面（与 check-migration-range.mjs 同形：文档 + 官网 wiki + 包内 README）。 */
const SCAN_PATHS = ['server/docs', 'server/AGENTS.md', 'AGENTS.md', 'docs', 'site/src/content/docs', 'packages', 'README.md', 'README.en.md', 'integration-tests']
/**
 * 缩面判据①（登记值）：`SCAN_PATHS` 必须**全覆盖**这份登记清单 —— 删掉任一项
 * （例如把 `site/src/content/docs` 去掉）都让"官方文档数字都有判据"变成假话，
 * 而"根不存在/扫描面为 0"这类存在性判据抓不到这种删法（目录还在，只是没人扫）。
 * 改扫描面必须同时改这里（进 diff、可评审），不是悄悄少扫一片。
 *
 * `integration-tests` 是 2026-09-25 第十四轮 lane E 的 E-05 补进来的：`integration-tests/README.md`
 * 的正文里写着"通过行逐项枚举它真的覆盖的 N 层"，而那个 N **当时就已经漂移**（README 写 10、
 * 代码登记值 13），且该目录此前**不在任何文档判据的扫描面内**（那片散文数字没人看）。
 */
const REQUIRED_SCAN_PATHS = ['server/docs', 'server/AGENTS.md', 'AGENTS.md', 'docs', 'site/src/content/docs', 'packages', 'README.md', 'README.en.md', 'integration-tests']
/**
 * 缩面判据③（树派生，与①②互相独立）：仓库里**存在**的用户可见文档真源必须在扫描面内。
 * 夹具树没有这个目录 ⇒ 天然放行；真仓删掉它却把 SCAN_PATHS 也删了 ⇒ 当场红。
 */
const DERIVED_SCAN_ROOTS = ['site/src/content/docs']
/**
 * 绝对下限（只在"真仓形态的根"上强制；合成树/自证夹具只需非空）。
 * 下界取当前实测值再留余量：文件数实测 server/docs=13 / docs=23 / site=34 / packages=24、
 * 合计 98 个 md、6 条 pin 断言（site 4 条 + packages 2 条）。
 * 只允许被"变多"越过 —— 变少说明根被搬空、排除规则把它吃空，或判据素材被摘掉。
 */
const SCAN_PATH_MIN_FILES = { 'server/docs': 8, docs: 15, 'site/src/content/docs': 20, packages: 15 }
const MIN_SCANNED_FILES = 70
const MIN_PIN_CLAIMS = 3
/** 按根计的**语义**地板：漂移最可能住的根必须仍在贡献断言（不只是"目录还在"）。 */
const MIN_PIN_CLAIMS_BY_PATH = { 'site/src/content/docs': 1, packages: 1 }
const RECORD_SURFACES = [
  /^docs\/planning\//u, /^docs\/decisions\//u, /^docs\/releases\//u, /^docs\/AUDIT-/u,
  /^server\/docs\/superpowers\//u,
  /\/\d{4}-\d{2}-\d{2}-[^/]*\.md$/u,
]
const ALLOW_MARKER = 'doc-claim:allow'
const MODULE_DOCS = ['site/src/content/docs/plugin-development.md', 'site/src/content/docs/en/plugin-development.md']

/** 反引号里的 pin 断言（正文里的「0.1.5 起…」这类版本泛指不算断言）。 */
const PIN_CLAIM = /`(dsh-v\d[A-Za-z0-9.+-]*)`/gu
/** 文档里列模块用的分隔符（中英各一）。 */
const MODULE_IGNORE = new Set(['clientBundle', 'PLATFORM_MODULES', 'tsdown'])

// ─────────────────────────────────────────────────────────────────────────────
// 真源 3/4/5（R13-GF）：硬数字的**代码真源**。
// 三条都只**解析源码文本**，不 import、不执行被读文件（守卫的可信根不交给被审对象）。
// ─────────────────────────────────────────────────────────────────────────────

/** 真源 3：更新服务器保留版本数（脚本里的 `KEEP=`）。 */
const KEEP_SOURCE = 'scripts/ci-publish-update-server.sh'
/** 真源 4：客户端更新检查节奏（`initialDelayMs` / `intervalMs` 的缺省值）。 */
const UPDATE_CADENCE_SOURCE = 'packages/host/desktop/src/updates.ts'
/** 真源 5：客户端平台数（桌面打包配置里声明了安装包产物名的平台段）。 */
const DESKTOP_MANIFEST_SOURCE = 'packages/host/desktop/package.json'
/**
 * `yarn prebuild` 构建的 workspace 包数真源（第三十轮 FIX-45 ⑤，2026-09-29）。
 *
 * 现场：`AGENTS.md:47` 写「`yarn prebuild` 一键构建全部 8 个 workspace 包」，真值 13；
 * 变异 `8 → 999` 时本守卫**两个方向都无感**（EXIT=0 且照打「全部与真源一致 ✅」）——
 * 这道守卫此前只覆盖它自己登记过的那几类硬数字。
 */
const PREBUILD_DEPS_SOURCE = 'packages/host/desktop/scripts/prebuild-workspace-deps.ts'
/**
 * **真源 6：官网 locale 的落地页源文件**（第三十二轮 FIX-47 ④e）。
 *
 * 现场（审计方 AD2 真跑的 AD2-07）：`site/astro.config.mjs` 声明 `locales: { root, en }`，
 * 英文内容树 `site/src/content/docs/en/**` 有 17 篇文档，**却没有英文落地页** ——
 * 中文首页来自自定义 `src/pages/index.astro`，`src/pages/en/` 不存在、Starlight 也不会替它
 * 生成 ⇒ `/en/` 404，而 Starlight 给**每一页**渲染的页头站点标题 logo 都链到 `/<locale>/`
 * ⇒ 英文站 **17 页全部**带一条死链，`astro build` 对这类**生成型**链接**零报告**
 * （源码面一个 `](/en)` 都搜不到）。
 *
 * ## 这条判据**属于哪一类**（别把它读成产物面判据）
 *
 * 它是**源码面的近似判据**：证明"落地页**源文件**在"（存在才**可能**产出 `/<loc>/`），
 * **不**证明产物里那 1417 条站内链接都落盘 —— 产物面由 `scripts/check-site-links.mjs` 负责
 * （它自己跑 `astro build` 再扫 `site/dist/**\/*.html`）。
 *
 * 为什么产物面那一半进不了**本守卫**（门禁）：`site/` **不是** root yarn workspace
 * （根 `package.json` 的 `workspaces` 只有 `packages/<scope>/<pkg>` 与 `community/<name>`），
 * CI 的 gate job 里没有 `site/node_modules` ⇒ 跑不了 `astro build`。而"缺落地页源文件"恰好是
 * 这条缺陷在**源码面唯一能确定性判定**的一格，所以它留在这里、产物面那半留给独立脚本。
 *
 * locale 清单**只从 `astro.config.mjs` 解析**（唯一真源）：本守卫**不**另抄一份 locale 列表
 * ——抄一份就会在"加/删 locale"时静默漂移，那正是本文件存在的理由。解析不出 ⇒ fail-loud。
 */
const ASTRO_CONFIG_SOURCE = 'site/astro.config.mjs'

// ─────────────────────────────────────────────────────────────────────────────
// 真源 7–10（2026-10-05 收口轮，分区 C 的 E-09/E-10/E-12/E-13 + `voice.intro` 前提 +
// README 体积数字）。这六条此前的共同形态是**事实已改对、仓内没有任何判据**
// （E-P2-verify §4.2 如实登记；分区 C 用三条变异 EXIT=0 复现了"改坏不会红"）。
//
// 纪律与上面几条一致：只**解析源码/配置文本**，不 import、不执行被读文件；
// 解析不出真源 = fail-loud（真仓形态下 EXIT=1），绝不回落成"那就别判了"。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 真源 7：迁移文件数（E-10 的 `server/AGENTS.md:112`「重放 74 个迁移」）。
 *
 * 真源是**目录里的实际文件**（`server/internal/serverstore/migrations-pg/*.sql`），
 * 不是任何守卫里再抄一份常量 —— `check-migration-range.mjs` 也从同一批文件算区间，
 * 两边同源。这条判据此前不存在：`52 → 74` 那次修复只改了数字，没有任何东西盯着它
 * （E-P2-batch §E-10 登记为"本条无判据"；区间判据只判**区间**与"提到的迁移号存在"）。
 */
const MIGRATION_COUNT_SOURCE = 'server/internal/serverstore/migrations-pg'
/** 迁移文件名的形状（与 `check-migration-range.mjs` 的 `SQL_NAME` 同源口径）。 */
const MIGRATION_FILE_NAME = /^(\d{4})_.*\.sql$/u

/**
 * 数出 `migrations-pg/` 下的迁移文件数。
 * @param root - 仓库根。
 * @returns 文件数；目录不存在返回 undefined（调用方 fail-loud）。
 */
function migrationCountFrom(root) {
  const directory = join(root, MIGRATION_COUNT_SOURCE)
  if (!existsSync(directory)) return undefined
  const names = readdirSync(directory).filter(name => MIGRATION_FILE_NAME.test(name))
  return names.length === 0 ? undefined : names.length
}

/**
 * 真源 8：语音识别模型的**随包载荷**（README 的「权重本身约 230MiB」）。
 *
 * 真源 = 上游钉死的 `runtime/assets.json`（`int8` 权重 + `tokens.txt` + `silero_vad`
 * 三个文件的 `bytes` 相加）。`docs/releases/v2.8.2-beta.3.md` 的实测增量表（+139.7～252.5
 * MiB，随平台压缩率）说明 **载荷 ≠ 安装包增量** —— 这条真源的用途正是把"载荷数字"
 * 钉住，同时由 `readme-installer-increment` 判据禁止把载荷冒充成增量。
 */
const VOICE_ASSETS_SOURCE = 'deepseek-harness/packages/experimental/speech-to-text-sensevoice/runtime/assets.json'

/**
 * 从 assets.json 算随包载荷（MiB，四舍五入到整数）。
 *
 * 形态（2026-10-05 实测）：`{ models: { int8: {bytes}, fp32: {bytes} }, tokens: {bytes},
 * vad: {bytes} }` —— **随包的是 int8 那份**（fp32 不随包），加上 `tokens.txt` 与
 * `silero_vad.onnx`：239233841 + 315894 + 1807522 = 241357257 B = **230.2 MiB**。
 * @param source - `runtime/assets.json` 的文本。
 * @returns MiB；形态变了/字段缺失返回 undefined（fail-loud）。
 */
function voiceModelPayloadMiBFrom(source) {
  let manifest
  try {
    manifest = JSON.parse(source)
  } catch {
    return undefined
  }
  if (typeof manifest !== 'object' || manifest === null) return undefined
  const parts = [manifest.models?.int8?.bytes, manifest.tokens?.bytes, manifest.vad?.bytes]
  if (parts.some(value => typeof value !== 'number' || !Number.isFinite(value) || value <= 0)) return undefined
  return Math.round(parts.reduce((sum, value) => sum + value, 0) / (1024 * 1024))
}

/**
 * 真源 9：语音模型下载源允许的 scheme 形状（E-12）。
 *
 * 真源 = `packages/host/desktop/src/desktop-channel.ts` 的 `SPEECH_ORIGIN_PATTERN`
 * （它与上游 `speech-to-text-sensevoice` 的 Config schema、`scripts/ci-channels.sh`
 * 的构建期校验、`docs/decisions/2026-09-29-voice-input-default-on.md` 四处同源）。
 * 判据只问一件事：**代码接不接受明文 `http://`** —— 文档必须与它同向。
 */
const SPEECH_ORIGIN_SOURCE = 'packages/host/desktop/src/desktop-channel.ts'

/**
 * 把正则体按**顶层** `|` 切成候选项（字符类 `[…]` 与分组 `(…)` 里的 `|` 不是分隔符）。
 *
 * 为什么必须字符感知（收口轮 P1，V-P4 的 T10c）：修前的判据是
 * `body.startsWith('^https?://')` —— 把正则改写成**语义等价**的
 * `/^https:\/\/…$|^http:\/\/…$/` 之后，`startsWith` 只看第一个候选，
 * 于是"接受明文 http"被判成"https-only"，结论与事实相反（两页文档都写 https-only 时全绿）。
 *
 * @param body - 正则体（已把 `\/` 还原成 `/`）。
 * @returns 候选项数组；括号/字符类不配对时返回 undefined（fail-loud，不猜）。
 */
function splitRegexAlternatives(body) {
  const parts = []
  let buffer = ''
  let inClass = false
  let depth = 0
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]
    if (char === '\\') {
      buffer += char + (body[index + 1] ?? '')
      index += 1
      continue
    }
    if (inClass) {
      buffer += char
      if (char === ']') inClass = false
      continue
    }
    if (char === '[') { inClass = true; buffer += char; continue }
    if (char === '(') { depth += 1; buffer += char; continue }
    if (char === ')') {
      depth -= 1
      if (depth < 0) return undefined
      buffer += char
      continue
    }
    if (char === '|' && depth === 0) { parts.push(buffer); buffer = ''; continue }
    buffer += char
  }
  if (inClass || depth !== 0) return undefined
  parts.push(buffer)
  return parts
}

/**
 * 从一个候选项里解析出它**允许的 scheme 集合**（结构化判定，E-12 收口轮）。
 *
 * 只认这几种可判读的形状（其余一律 undefined ⇒ fail-loud，"形态不认识"绝不静默当通过）：
 *   · `^https://…`   → `https`
 *   · `^https?://…`  → `https` + 末字符可选 ⇒ `http`
 *   · `^http(s)?://…` → 同上（**单字符**可选分组）
 *   · `^http://…`    → `http`
 * 字符类（`^http[s]?://`）、"整个前缀可选"（`^(?:https)?://`）、括号不配对
 * 一律判"不认识"。
 *
 * @param alternative - 一个顶层候选项。
 * @returns scheme 数组；读不懂返回 undefined。
 */
function originSchemesFromAlternative(alternative) {
  const trimmed = alternative.trim()
  if (trimmed === '') return []
  const body = trimmed.startsWith('^') ? trimmed.slice(1) : trimmed
  const separator = body.indexOf('://')
  if (separator <= 0) return undefined
  const prefix = body.slice(0, separator)
  // `https?`：末字符可选（`https` → `http` + `https`）。
  const optionalTail = /^([A-Za-z][A-Za-z0-9+.\-]*)\?$/u.exec(prefix)
  if (optionalTail !== null) return [optionalTail[1], optionalTail[1].slice(0, -1)]
  // `http(s)?`：前缀里带一个**单字符**可选分组（展开成"有/无"两种）。
  //   刻意不认 `(?:https)?` / `(https)?` 这类"整个前缀可选"的形态：它连 scheme 本身都能省
  //   （`://host`），语义与"http/https 二选一"不是一回事 ⇒ 返回 undefined（fail-loud，不猜）。
  const inlineGroup = /^([A-Za-z0-9+.\-]*)\(([^()]*)\)\?$/u.exec(prefix)
  if (inlineGroup !== null) {
    const base = inlineGroup[1]
    const inner = inlineGroup[2].startsWith('?:') ? inlineGroup[2].slice(2) : inlineGroup[2]
    if (!/^[A-Za-z]$/u.test(inner) || !/^[A-Za-z][A-Za-z0-9+.\-]*$/u.test(base)) return undefined
    return [base, `${base}${inner}`]
  }
  if (!/^[A-Za-z][A-Za-z0-9+.\-]*$/u.test(prefix)) return undefined
  return [prefix]
}

/**
 * 取出 `SPEECH_ORIGIN_PATTERN = /…/` 的**正则体**（收口轮：换成字符类感知的扫描）。
 *
 * 为什么不能用 `/((?:\\.|[^/\\\n])*)/`（修前的写法）：那个字符类**在 `[` 里遇到 `/` 就停**
 * （`[^/\\\n]` 排除 `/`）⇒ `[^/]+` 这种**没转义斜杠**的字符类会让捕获在类中间断掉、
 * 把类里的 `/` 当成正则的收尾斜杠。实测：`/^https:\/\/[^/]+$/` 被截成 `^https:\/\/[^`
 * ⇒ 结构化解析判"形态不认识"（安全方向，但结论变成了误报）。
 * 现在按 JS 词法扫：转义、字符类、行尾都按规则走；扫不到收尾 `/` ⇒ undefined（fail-loud）。
 *
 * @param source - `desktop-channel.ts` 的文本。
 * @returns 正则体（`\/` 已还原成 `/`）；读不出返回 undefined。
 */
function speechOriginPatternBody(source) {
  const masked = maskComments(source)
  const anchor = /const\s+SPEECH_ORIGIN_PATTERN\s*=\s*/u.exec(masked)
  if (anchor === null) return undefined
  let index = anchor.index + anchor[0].length
  if (masked[index] !== '/') return undefined
  index += 1
  let body = ''
  let inClass = false
  for (; index < masked.length; index += 1) {
    const char = masked[index]
    if (char === '\n') return undefined
    if (char === '\\') {
      body += char + (masked[index + 1] ?? '')
      index += 1
      continue
    }
    if (inClass) {
      body += char
      if (char === ']') inClass = false
      continue
    }
    if (char === '[') { inClass = true; body += char; continue }
    if (char === '/') return body.replace(/\\\//gu, '/')
    body += char
  }
  return undefined
}

/**
 * 从 `desktop-channel.ts` 解析"是否接受明文 http"。
 *
 * 收口轮（2026-10-05，独立核验 V-P4 的 T10/T10c）：**判据从"字符串前缀"改成"结构化 scheme 集合"**
 * —— 先把正则体按顶层 `|` 拆开、逐个候选解析出 scheme 集合、再与文档声明逐项对拍。
 * 解析不出（形态不认识 / 括号不配对）返回 undefined，调用方按**前置失败**（EXIT=2）拒绝出结论。
 *
 * @param source - 该文件的文本。
 * @returns `{ allowsPlainHttp, schemes }`；形态读不懂返回 undefined（fail-loud）。
 */
function speechOriginAcceptsPlainHttp(source) {
  const body = speechOriginPatternBody(source)
  if (body === undefined) return undefined
  const alternatives = splitRegexAlternatives(body)
  if (alternatives === undefined) return undefined
  const schemes = new Set()
  for (const alternative of alternatives) {
    const found = originSchemesFromAlternative(alternative)
    if (found === undefined) return undefined
    for (const scheme of found) schemes.add(scheme)
  }
  if (schemes.size === 0) return undefined
  return { allowsPlainHttp: schemes.has('http'), schemes: [...schemes] }
}

/**
 * 从**文档行**里解析出它声明的 scheme 集合（`http(s)://` → `{http, https}`、`https://` → `{https}`、
 * `wss://` → `{wss}`）。
 *
 * 为什么需要它（收口轮②，独立核验 V-P10P11 的 D6）：修前的判词只问两件事
 * （"文档是否比实现宽" / "实现是否 https-only"），**不判"实现比文档多一个 scheme"** ——
 * 实测 `^https?:\/\/…|^wss:\/\/…`（实现多一个 `wss`）+ 文档只写 `http(s)://` ⇒ **EXIT=0**。
 * 现在按**集合相等**判：文档声明的 scheme 集合必须与真源解析出的集合逐项相同。
 *
 * @param line - 文档行。
 * @returns scheme 集合（小写；`X(s)://` 展开成 `{x, xs}`）；一个都没写时返回空集合。
 */
function docSchemeSet(line) {
  const schemes = new Set()
  for (const match of line.matchAll(/([A-Za-z][A-Za-z0-9+.-]*)(\(s\))?:\/\//gu)) {
    const base = match[1].toLowerCase()
    schemes.add(base)
    if (match[2] !== undefined) schemes.add(`${base}s`)
  }
  return schemes
}

/**
 * 真源 10：语音模型**默认是否随包**（`voice.intro` 前提面的真源）。
 *
 * 真源 = `packages/host/desktop/scripts/channel-build.ts` 的
 * `speechBundleModel: branding.speechBundleModel !== false` —— 即**缺省 true（随包）**，
 * 只有渠道包显式写布尔 `false` 才回到"首次使用下载"。`voice-setup.tsx` 无条件渲染
 * `voice.intro`（不分 phase）⇒ 这句话对两种渠道都必须成立。
 */
const VOICE_BUNDLE_SOURCE = 'packages/host/desktop/scripts/channel-build.ts'
/** `voice.intro` 的两处文案（zh / en），格式面由 desktop 的 i18n spec 守着，**前提面**在这里。 */
const VOICE_LOCALE_SOURCE = 'packages/host/desktop/src/client/locales.ts'

/**
 * 从 `channel-build.ts` 解析"随包是不是缺省"。
 * @param source - 该文件的文本。
 * @returns `{ bundledByDefault }`；形态变了返回 undefined（fail-loud）。
 */
function voiceBundleDefaultFrom(source) {
  const masked = maskComments(source)
  const match = /speechBundleModel\s*:\s*branding\.speechBundleModel\s*!==\s*(false|true)/u.exec(masked)
  if (match === null) return undefined
  return { bundledByDefault: match[1] === 'false' }
}

/**
 * 真源 11（E-13）：官网源码里**不得硬编码发布版本号**。
 *
 * 这条没有"外部真源文件"——它判的是"官网不写死版本号"这条**形态契约**（写死必然漂；
 * E-13 的现场是 `site/src/pages/index.astro` 的 `2.7.0` 三处，读者复制即 404）。
 *
 * 扫描面 = `site/src/**` 的 `.md` + `.astro`，**排除 `content/blog/**`**（发布公告写的是
 * "当时"的版本号，属记录面 —— 与 `docs/releases/**` 同一口径）。
 *
 * ## 判据面（收口轮 2026-10-05 收紧：发布版本号 vs 第三方/依赖版本号）
 *
 * 修前是**形状判据**（见到 `2.x.y` 就红），两个方向都错（独立核验 V-P4 的 T1/T3）：
 *   · 假红：正当的第三方组件版本（`需要 Caddy 2.7.6 及以上`）被判成"硬编码发布版本号"；
 *   · 假阴：下一个大版本（`3.0.0`）不在 `2.` 形状里 ⇒ 完全不可见。
 * 现在一个裸号要满足**三条之一**才进判据面：
 *   ① 形状 + **行级发布语境**（本行命中 {@link RELEASE_CONTEXT_MARKERS} 之一 —— `latest.json`、
 *      `server.version|image_tag`、中文「发布版本」、`release version`、`tag`）；
 *   ② 形状 + **发布面的号邻接**（{@link RELEASE_NUMBER_AFFIXES} 之一**紧挨着这个号** ——
 *      `releases/<号>/…`、`picoaide-server-<号>`、`picoaide-harness-server:<号>`、
 *      `PicoAide-Harness-<号>`、`SERVER_IMAGE=<号>`）；
 *   ③ 形状 + **落在本项目发布线上**（major.minor 与 root `package.json` 的版本真源一致 ——
 *      真源读不到时这一条自动关闭）。
 * `Caddy 2.7.6`（无行级语境、号也不挨着发布面 token、不在本项目发布线上）⇒ **不再误伤**；
 * `当前发布版本 3.0.0`（「发布版本」是行级语境）⇒ **红**（V-P4 的 T1 从假阴变红）。
 *
 * ## 收口轮②（2026-10-05，独立核验 V-P10P11 的 E7/E10）：语境内标记拆成两类
 *
 * 修前把 `releases/` / `picoaide-server-` 这类**发布面 token** 当成"行级标记" ⇒ 只要同一行
 * 提到它们，行里**任何**裸号都红。实测两种散文被误伤：
 *   · `说明写在 releases/ 目录，内容涉及 Caddy 2.7.6 的升级。` ⇒ **假红**（号与发布面无关）。
 *     收口后：`releases/` 只按**号邻接**算（`releases/2.7.0/picoaide-server-2.7.0-…` 仍然红），
 *     这一句 ⇒ **绿**（本轮修掉的假红）。
 *   · `自发布版本 2.7.0 起，镜像内已内置 Caddy。` ⇒ **仍然红** —— 判为**正当收紧**
 *     （行级语境 = 这句话讲的就是发布版本；本仓既有约定是历史版本一律写 `vX.Y.Z`，
 *     全站 28 处如此）。修法见命中信息：写成 `v2.7.0`，或对记录面加行内 `doc-claim:allow`。
 *     这条边界由 `siteVersionSelftestCases()` 的两格**逐字钉住**（免得下次又被当新发现）。
 */
const SITE_VERSION_SOURCE_ROOT = 'site/src'
const SITE_VERSION_WALK_EXCLUDE = [/^site\/src\/content\/blog\//u]
/**
 * 发布版本号字面量（**裸号** `X.Y.Z`）。
 *
 * 边界（认账）：**只认裸号**，不认 `vX.Y.Z`（带 `v` 的串在站点里是历史引用/页脚徽标，
 * 全站 28 处，纳入会要求改写十几处正文，而本单只授权改 `scripts/**`）。
 * 词界用 `(?<![\w.])` / `(?![\w.])`：`dsh-v0.1.5-rc.2`（上游 pin）与 `172.28.0.1`（IP）
 * 都不命中 —— 判据误伤这两类会把"收紧过度"变成新的假红源。**形状本身不再是判据**
 * （任何大版本都在面内），判不判由下面的"发布语境"决定。
 */
const RELEASE_VERSION_LITERAL = /(?<![\w.])\d+\.\d+\.\d+(?![\w.])/gu
/**
 * **行级发布语境**标记：本行命中任一即"这一行的版本号讲的是发布版本"（与号的位置无关）。
 *
 * 只收**语义上就在讲版本**的词：更新清单与其字段 / 中英"发布版本" / `tag`。
 * **刻意不收**「镜像」「版本」这类泛词（`需要 Caddy 2.7.6 及以上（官方镜像已内置）`
 * 正是被泛词误伤的现场形态），也**不再收** `releases/` / `picoaide-server-` 这类
 * **发布面 token** —— 它们改成"必须紧挨着号"才作数（见 {@link RELEASE_NUMBER_AFFIXES}），
 * 否则 `说明写在 releases/ 目录，内容涉及 Caddy 2.7.6 的升级。` 这类散文会被误判（V-P10P11 的 E10）。
 */
const RELEASE_CONTEXT_MARKERS = [
  /latest\.json/u,
  /server\.(?:version|image_tag)/u,
  /发布版本/u,
  /release version/iu,
  /\btag\b/iu,
]
/**
 * **发布面 token**：出现在号**紧邻处**（同一个"词"，见 {@link releaseTokenAround}）才算发布版本号。
 *
 * 这些 token 的语义正是"发布物/发布路径 + 版本号"：R2 对象路径 / 服务端镜像与归档名 /
 * 客户端安装包名 / `.env` 的镜像键。E-13 的现场形态
 * （`…/releases/2.7.0/picoaide-server-2.7.0-amd64.zip` 与 `picoaide-harness-server:2.7.0`）
 * 三条都在这一类里，故收紧后**真牙不变**。
 */
const RELEASE_NUMBER_AFFIXES = [
  /releases?\//u,
  /picoaide-server-/u,
  /picoaide-harness-server[:/]/u,
  /PicoAide-Harness-/u,
  /\bSERVER_IMAGE[=:]?/u,
]
/** 号周围"词"的字符集（用来把号扩成一个 token 再判发布面 token 是否邻接）。 */
const RELEASE_TOKEN_CHARS = /[A-Za-z0-9._/:\-]/u

/**
 * 把某个号在行内扩成**一个 token**（左右都吃 {@link RELEASE_TOKEN_CHARS}）——
 * 用来判"发布面 token 是否紧挨着这个号"（`releases/2.7.0/…` 里的 `releases/` 邻接，
 * 而 `说明写在 releases/ 目录 … Caddy 2.7.6` 里的 `releases/` 不邻接）。
 *
 * @param line - 整行文本。
 * @param start - 号在该行里的起始下标。
 * @param length - 号的长度。
 * @returns 该号所在的 token（含号本身）。
 */
function releaseTokenAround(line, start, length) {
  let left = start
  while (left > 0 && RELEASE_TOKEN_CHARS.test(line[left - 1])) left -= 1
  let right = start + length
  while (right < line.length && RELEASE_TOKEN_CHARS.test(line[right])) right += 1
  return line.slice(left, right)
}
/**
 * 官网里**允许**保留发布版本号字面量的文件（逐条登记 + **逐字面量**登记 + 死条目红）。
 *
 * 当前两处都是 `deployment/upgrade.md` 的 **shell 注释**里的示例值/形状说明
 * （`# 镜像里 2.7.0 与 v2.7.0 两个 tag 都在…`），**不是可复制命令**（可执行的两条
 * `sed`/`grep` 与 `docker run` 用的都是 `${IMAGE}:${VER}`）—— 分区 C 的勘误 §勘误 3
 * 逐处判定为"无害、只需登记"。这两处归 E-03-R 泳道所有（本单只改 `scripts/**`，
 * 不动站点正文），所以在守卫里登记而不是直接改掉。
 *
 * ## 三个方向（收口轮：修前是"整文件豁免 + 零余量死条目"）
 *
 *   ① 允准面里**没登记**的字面量 ⇒ 红（修前整文件豁免：往 `upgrade.md` 里塞 `2.9.9` 全绿）；
 *   ② **死条目**：登记的号在该文件里**连"带 v 的写法"都找不到** ⇒ EXIT=2（豁免必须随事实收缩）；
 *   ③ **正当余量**：把裸号改写成 `v` 号（语义不变）**不再**触发死条目 —— 判"还在不在讲这个号"
 *      时接受 `v?` 前缀，于是正当文案改动不会被"拒绝出结论"（V-P4 的 T5 现场）。
 */
const SITE_VERSION_ALLOW = [
  {
    file: 'site/src/content/docs/deployment/upgrade.md',
    literals: ['2.7.0'],
    why: '回滚/多栈段的 shell 注释里用 `2.7.0 与 v2.7.0` 说明"镜像里裸号与 v 号两个 tag 都在"'
      + '（讲的是 tag **形状**，与具体版本无关；命令本身用的是 `${IMAGE}:${VER}`）',
  },
  {
    file: 'site/src/content/docs/en/deployment/upgrade.md',
    literals: ['2.7.0'],
    why: '中文页的英文对照（同一句话、同一判定）',
  },
]
/** 官网版本号扫描面的**绝对下限**（真仓形态）：文件被搬空/排除规则吃空 ⇒ EXIT=2。 */
const SITE_VERSION_MIN_FILES = 25
/** 本项目发布线（`major.minor`）的真源：root `package.json` 的 `version`（读不到则该分支关闭）。 */
const PROJECT_VERSION_SOURCE = 'package.json'
/**
 * 从 `package.json` 解析本项目的**发布线前缀**（`2.8.2-beta.3` → `2.8.`）。
 * @param source - 该文件的文本。
 * @returns 前缀（含结尾点）；解析不出返回 undefined（此时只按发布语境判，不 fail-loud ——
 *   本判据的主判据是语境，"与真源同线"只是**加严**的那一半）。
 */
function projectReleaseLinePrefix(source) {
  let manifest
  try {
    manifest = JSON.parse(source)
  } catch {
    return undefined
  }
  const version = manifest?.version
  if (typeof version !== 'string') return undefined
  const match = /^(\d+)\.(\d+)\./u.exec(version)
  return match === null ? undefined : `${match[1]}.${match[2]}.`
}
/**
 * E-13 的官网版本号判据在「已覆盖」登记表里的身份（**形态契约**：没有"外部真源文件"，
 * 见 {@link SITE_VERSION_ALLOW}）。它照样进登记表 —— 通过行声称的覆盖面必须等于真判过的项。
 */
const SITE_VERSION_RULE = { id: 'site-release-versions', label: '官网源码不得硬编码发布版本号' }

/**
 * 解析 `KEEP=3` 形态的保留版本数。
 *
 * 赋值必须**唯一**：0 处（被别人改名/改成别的形态）或 >1 处（有歧义）都返回 undefined，
 * 由调用方 fail-loud —— 守卫不猜"大概是哪个"。
 * @param source - `scripts/ci-publish-update-server.sh` 的源码。
 * @returns 保留版本数；解析失败返回 undefined。
 */
function keepVersionsFrom(source) {
  const matches = [...source.matchAll(/^[ \t]*KEEP=(?:\$\{KEEP:-)?(\d+)\}?[ \t]*$/gmu)]
  if (matches.length !== 1) return undefined
  return Number(matches[0][1])
}

/**
 * 求值「整数乘加表达式」（`60_000`、`6 * 60 * 60 * 1000`）。
 *
 * **刻意不用 `eval`**：只接受数字 / 下划线 / 空白 / `*` / `+`，其余形态返回 undefined。
 * @param expression - 源码里的表达式文本。
 * @returns 整数值；不是这种形态返回 undefined。
 */
function integerExpressionValue(expression) {
  const cleaned = expression.replace(/[_\s]/gu, '')
  if (!/^\d+(?:\*\d+)*(?:\+\d+(?:\*\d+)*)*$/u.test(cleaned)) return undefined
  return cleaned
    .split('+')
    .reduce((total, term) => total + term.split('*').reduce((product, factor) => product * Number(factor), 1), 0)
}

/**
 * 从 `updates.ts` 抽客户端更新检查的两个常量（秒 / 小时口径）。
 * @param source - `packages/host/desktop/src/updates.ts` 的源码。
 * @returns `{ initialSeconds, intervalHours }`；任一解析失败返回 undefined。
 */
function updateCadenceFrom(source) {
  const initial = /initialDelayMs\s*:[^\n]*?\.default\(\s*([^)]*?)\s*\)/u.exec(source)
  const interval = /intervalMs\s*:[^\n]*?\.default\(\s*([^)]*?)\s*\)/u.exec(source)
  if (initial === null || interval === null) return undefined
  const initialMs = integerExpressionValue(initial[1])
  const intervalMs = integerExpressionValue(interval[1])
  if (initialMs === undefined || intervalMs === undefined) return undefined
  if (initialMs <= 0 || intervalMs <= 0) return undefined
  return { initialSeconds: initialMs / 1000, intervalHours: intervalMs / 3_600_000 }
}

/**
 * 从桌面打包配置里数出**安装包平台数**：`build.{mac,win,linux}` 中声明了
 * `artifactName`（产物名模板）的段数。渠道客户端就是按这三段各出一份安装包。
 * @param source - `packages/host/desktop/package.json` 的源码。
 * @returns 平台 id 列表；读不出/形状不对返回 undefined。
 */
function installerPlatformsFrom(source) {
  let manifest
  try {
    manifest = JSON.parse(source)
  } catch {
    return undefined
  }
  const build = manifest?.build
  if (typeof build !== 'object' || build === null) return undefined
  const platforms = ['mac', 'win', 'linux'].filter(key => {
    const section = build[key]
    return typeof section === 'object' && section !== null && typeof section.artifactName === 'string'
  })
  return platforms.length === 0 ? undefined : platforms
}

/**
 * 把源码里的**注释**逐字符替换成空格（换行保留）—— 输出与输入**等长**，于是后续所有
 * `indexOf` / 行号计算都仍然对得上原文。
 *
 * 为什么需要它：`locales:` 的锚点判据是"命中必须唯一"，而注释掉的 `// locales: { … }`
 * 不该算一个锚点（否则一句注释就能让判据 fail-loud）；同理块注释里的花括号不该被当成对象边界。
 * @param text - 源码全文。
 * @returns 等长的掩码文本。
 */
function maskComments(text) {
  const chars = text.split('')
  let quote = null
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index]
    if (quote !== null) {
      if (char === '\\') index += 1
      else if (char === quote) quote = null
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
      continue
    }
    if (char === '/' && chars[index + 1] === '/') {
      while (index < chars.length && chars[index] !== '\n') {
        chars[index] = ' '
        index += 1
      }
      continue
    }
    if (char === '/' && chars[index + 1] === '*') {
      while (index < chars.length && !(chars[index] === '*' && chars[index + 1] === '/')) {
        if (chars[index] !== '\n') chars[index] = ' '
        index += 1
      }
      if (index < chars.length) {
        chars[index] = ' '
        chars[index + 1] = ' '
        index += 1
      }
    }
  }
  return chars.join('')
}

/**
 * 从 `site/astro.config.mjs` 的源码里解析 starlight 的 `locales` 对象**键与声明行号**
 * （真源 6；见 {@link ASTRO_CONFIG_SOURCE}）。
 *
 * 与仓内其它守卫同一纪律：只**解析源码文本**，不 import 被审对象（`astro.config.mjs` 会拉
 * `astro/config` 与 `@astrojs/starlight`，且 `defineConfig` 之外还有副作用面）。
 * fail-loud 口径与 {@link keepVersionsFrom} 同源：找不到 `locales:` / 命中不唯一（有歧义）/
 * 花括号不闭合 / 一个键都取不到，一律返回 `undefined`，由调用方判红 —— **绝不回落默认清单**。
 * @param source - `site/astro.config.mjs` 全文。
 * @returns `[{ key, line }]`（声明顺序；`line` 为 1 起行号）；解析失败返回 `undefined`。
 */
function starlightLocalesFrom(source) {
  // 注释先掩码（等长替换）⇒ 锚点唯一性与花括号配对都只看**真的代码**，
  // 而行号/偏移仍与原文逐字对应（finding 要落在 `astro.config.mjs` 的真实行上）。
  const text = maskComments(String(source))
  const anchors = [...text.matchAll(/(?:^|[\s,{])locales\s*:\s*\{/gmu)]
  if (anchors.length !== 1) return undefined
  const open = text.indexOf('{', anchors[0].index)
  if (open < 0) return undefined
  const lineOf = offset => text.slice(0, offset).split('\n').length
  const keys = []
  let depth = 0
  let quote = null
  let pending = ''
  let pendingAt = -1
  for (let index = open; index < text.length; index += 1) {
    const char = text[index]
    if (quote !== null) {
      if (char === '\\') index += 1
      else if (char === quote) quote = null
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
      pending = ''
      continue
    }
    if (char === '{') {
      depth += 1
      pending = ''
      continue
    }
    if (char === '}') {
      depth -= 1
      pending = ''
      if (depth === 0) break
      continue
    }
    if (depth !== 1) continue
    if (/[A-Za-z0-9_$]/u.test(char)) {
      if (pending === '') pendingAt = index
      pending += char
      continue
    }
    if (char === ':' && pending !== '') {
      keys.push({ key: pending, line: lineOf(pendingAt) })
      pending = ''
      continue
    }
    pending = ''
  }
  if (depth !== 0) return undefined
  return keys.length > 0 ? keys : undefined
}

/** 中文数字（本仓文档面只用到 1–10；`两` 与 `二` 同义）。 */
const CHINESE_NUMERALS = new Map([
  ['一', 1], ['二', 2], ['两', 2], ['三', 3], ['四', 4], ['五', 5],
  ['六', 6], ['七', 7], ['八', 8], ['九', 9], ['十', 10],
])
/** 英文数词（同上）。 */
const ENGLISH_NUMERALS = new Map([
  ['one', 1], ['two', 2], ['three', 3], ['four', 4], ['five', 5],
  ['six', 6], ['seven', 7], ['eight', 8], ['nine', 9], ['ten', 10],
])

/**
 * 把文档里的数字 token 归一成整数：ASCII 数字 / 中文数字 / 英文数词。
 * @param token - 正则捕获到的数字文本。
 * @returns 整数；不认识的形态返回 undefined（调用方 fail-loud，不静默跳过）。
 */
function numberFromToken(token) {
  const trimmed = token.trim()
  if (/^\d+$/u.test(trimmed)) return Number(trimmed)
  if (CHINESE_NUMERALS.has(trimmed)) return CHINESE_NUMERALS.get(trimmed)
  if (ENGLISH_NUMERALS.has(trimmed.toLowerCase())) return ENGLISH_NUMERALS.get(trimmed.toLowerCase())
  return undefined
}

/**
 * 集成守卫通过行层数的**代码真源**（E-05）：
 * `check-integration-tests.mjs` 里 `COVERED_LAYERS.length === EXPECTED_COVERED_LAYERS`
 * 是运行期断言；本规则把文档侧的自述绑到同一个登记值上。
 */
const INTEGRATION_COVERAGE_SOURCE = 'scripts/check-integration-tests.mjs'

/**
 * 硬数字判据表（每条 = **一份代码真源** + 一组文档形态 + 一个下限）。
 *
 * `truth` 由 {@link resolveNumericRules} 从真源解析后填入；`forms[].pattern` 的第 1 个
 * 捕获组就是数字 token；`anchor` 是可选上下文锚（在该行 ±`window` 行内匹配，用于把
 * 同形但不同源的句子排除掉）；`min` 是**真仓形态**下必须命中的条数下限（素材被摘空
 * ⇒ EXIT=2，不是静默通过）。
 *
 * `required` 是**claim 定位点**（2026-09-25 第十四轮 lane E 的 E-04 收口）：这条规则必须
 * 在列出的文件里**至少命中一条**（锚内），否则 EXIT=2。没有它时，`min` 只是一句"这类短语
 * 还剩 N 条"的空保证 —— 把真正该判的那句话删掉/改写，余下的同形句子照样满足下限
 * （= 真声明可以静默消失，claim 不可定位）。
 */
const NUMBER_CLAIM_RULES = [
  {
    id: 'update-keep',
    label: '更新服务器保留版本数',
    source: KEEP_SOURCE,
    read: source => keepVersionsFrom(source),
    min: 2,
    forms: [
      { pattern: /只保留最近\s*([0-9]+|[一二三四五六七八九十两]+)\s*个版本/gu },
      { pattern: /keeps only the\s+([0-9]+|[A-Za-z]+)\s+most recent versions/giu },
    ],
  },
  {
    id: 'update-initial-delay',
    label: '客户端更新首检延迟（秒）',
    source: UPDATE_CADENCE_SOURCE,
    read: source => updateCadenceFrom(source)?.initialSeconds,
    min: 4,
    forms: [
      { pattern: /启动\s*([0-9]+|[一二三四五六七八九十两]+)\s*秒后/gu },
      { pattern: /\b([0-9]+|[A-Za-z]+)\s+seconds after (?:startup|launch)\b/giu },
    ],
  },
  {
    id: 'update-interval',
    label: '客户端更新检查周期（小时）',
    source: UPDATE_CADENCE_SOURCE,
    read: source => updateCadenceFrom(source)?.intervalHours,
    min: 3,
    // 上下文锚：只有"更新检查"语境的「每 N 小时」才算这条 claim。服务端保留策略
    // 调度器的「每 6 小时一次」同形但不同源（`internal/{audit,usage}retention`），
    // 被这里排除；被排除的条数照样打印（不静默吞）。
    anchor: /首次检查|检查时机|检查更新|updates\/manifest|Check for Updates|手动检查|托盘|seconds after (?:startup|launch)|once every/u,
    window: 1,
    forms: [
      { pattern: /每\s*([0-9]+|[一二三四五六七八九十两]+)\s*小时(?:一次)?/gu },
      { pattern: /\bonce every\s+([0-9]+|[A-Za-z]+)\s+hours\b/giu },
    ],
  },
  {
    id: 'client-platforms',
    label: '客户端平台数',
    source: DESKTOP_MANIFEST_SOURCE,
    read: source => installerPlatformsFrom(source)?.length,
    // 下限 = 锚后实测条数（2026-09-25：36 条）再留 6 条余量给措辞改写；**定位**由下面的
    // `required` 负责（canonical 文档里那句被删 ⇒ EXIT=2）。
    min: 30,
    // 上下文锚（E-04）：这条规则的真源是"桌面打包配置里声明了产物名的平台段数"，
    // 只有**安装包/下载/门户/镜像**语境的「N 平台」才是它的 claim。同形但不同源的句子
    // （"客户端在同**一平台**上运行"、"单平台实测"、"三平台窗口选项"）被排除；被排除的条数
    // 照样打印（不静默吞）。
    //
    // `window: 0` 是**刻意**的：锚必须在**同一行**。留 ±1 行时，邻行出现"安装包"就会为
    // 这一行的无关「N 平台」背书 —— 第十四轮 lane E 的假红现场正是把一句无关的话追加到
    // 文档末尾（前一行恰好是安装包段落的一部分）。
    anchor: /安装包|下载|门户|镜像|installers?\b|downloads?\b|portal\b/iu,
    window: 0,
    required: [
      { file: 'site/src/content/docs/deployment/client-delivery.md', note: '客户端交付面（中文）' },
      { file: 'site/src/content/docs/en/deployment/client-delivery.md', note: '客户端交付面（英文）' },
      { file: 'site/src/content/docs/deployment.md', note: '部署总览：镜像里带三平台客户端安装包' },
      { file: 'site/src/content/docs/en/deployment.md', note: '部署总览（英文）' },
      { file: 'site/src/content/docs/getting-started.md', note: '快速开始：门户列出三平台下载入口' },
      { file: 'site/src/content/docs/en/getting-started.md', note: '快速开始（英文）' },
    ],
    forms: [
      // `(?<![\d.])`：排除「2.3 平台」这种被版本号尾巴带出来的假命中。
      { pattern: /(?<![\d.])([0-9]+|[一二三四五六七八九十两]+)\s*平台/gu },
      { pattern: /\b([0-9]+|one|two|three|four|five|six|seven|eight|nine|ten)\s+platforms\b/giu },
    ],
  },
  {
    id: 'integration-covered-layers',
    label: '集成守卫通过行的覆盖面层数',
    // 真源 = 守卫里那两条**互钉**的量：`COVERED_LAYERS` 数组长度必须等于
    // `EXPECTED_COVERED_LAYERS`（由 `check-integration-tests.mjs` 自己在运行期断言）。
    // 这里读登记值那一行 —— 它进 diff、可评审。
    source: INTEGRATION_COVERAGE_SOURCE,
    read: source => integrationCoveredLayersFrom(source),
    min: 2,
    // 上下文锚（同 E-04 的纪律）：只有"**通过行**逐项枚举/覆盖的 N 层"才是这条 claim。
    // 同形的「三层覆盖：单测 / verify 脚本 / E2E 自动化」（`COVERAGE-MATRIX.md`，讲的是
    // 另一件事）必须被排除 —— 它讲的层数与集成守卫无关。
    anchor: /通过行|逐项枚举/u,
    window: 0,
    required: [
      { file: 'integration-tests/README.md', note: '集成测试 README 的覆盖面自述（E-05 的现场）' },
    ],
    forms: [
      { pattern: /([0-9]+|[一二三四五六七八九十两]+)\s*层/gu },
    ],
  },
  {
    id: 'prebuild-workspace-packages',
    label: '`yarn prebuild` 构建的 workspace 包数',
    // 真源 = `prebuild-workspace-deps.ts` 的 `WORKSPACE_PACKAGES` 数组条数（进 diff、可评审）。
    source: PREBUILD_DEPS_SOURCE,
    read: source => workspacePackagesFrom(source),
    min: 1,
    // 上下文锚（同 E-04 的纪律）：只有"`yarn prebuild` 构建的包数"才是这条 claim。
    // 同形的「N 个 workspace 包」若讲的是别的口径（例如验收判据行 `planned=32` 里的
    // "15 个包 + 17 条守卫"，那里刻意不写"workspace 包"以免与这条同源混淆）会被排除；
    // 被排除的条数照样打印（不静默吞）。
    anchor: /prebuild|WORKSPACE_PACKAGES/u,
    window: 0,
    required: [
      { file: 'AGENTS.md', note: '门禁自述：`yarn prebuild` 一键构建的 workspace 包数（FIX-45 ⑤ 的现场）' },
    ],
    forms: [
      // markdown 着重号（`**13 个** workspace 包`）不算差异。
      { pattern: /\*{0,2}([0-9]+)\s*个\*{0,2}\s*workspace\s*包/gu },
    ],
  },
  {
    id: 'migration-count',
    label: '迁移文件数（`server/AGENTS.md` 的「重放 N 个迁移」）',
    // 真源 = `migrations-pg/` 目录里的实际文件数（`readRoot`：真源不是**一个文件**）。
    source: MIGRATION_COUNT_SOURCE,
    readRoot: root => migrationCountFrom(root),
    min: 1,
    // 上下文锚（同 E-04 的纪律）：只有"重放 N 个迁移"这句测试库提速自述才是这条 claim。
    // 同形的「N 个迁移」若讲的是别的口径（`docs/planning` 里的历史记录、`server/docs`
    // 的预算旋钮）会被排除；被排除的条数照样打印（不静默吞）。
    anchor: /重放/u,
    window: 0,
    required: [
      { file: 'server/AGENTS.md', note: '测试库自述：「不再逐用例重放 N 个迁移」（E-10 的现场）' },
    ],
    forms: [
      { pattern: /重放\s*([0-9]+)\s*个迁移/gu },
      { pattern: /\breplays?\s+([0-9]+)\s+migrations?\b/giu },
    ],
  },
  {
    id: 'voice-model-payload',
    label: '语音模型随包载荷（MiB）',
    // 真源 = 上游钉死的 `runtime/assets.json`（三个随包文件 bytes 之和）。
    // 用途：把 README 的「权重本身约 230MiB」钉住 —— **载荷**数字。
    // "安装包增量"是另一件事（随平台压缩率，+139.7～252.5 MiB），由
    // `readme-installer-increment` 判据禁止把前者冒充成后者。
    source: VOICE_ASSETS_SOURCE,
    read: source => voiceModelPayloadMiBFrom(source),
    min: 2,
    required: [
      { file: 'README.md', note: '语音输入一节：随包载荷数字（E-P2 item 1 的现场）' },
      { file: 'README.en.md', note: '同上（英文）' },
    ],
    forms: [
      { pattern: /权重(?:本身)?约\s*([0-9]+)\s*MiB/gu },
      { pattern: /weights are about\s*([0-9]+)\s*MiB/giu },
    ],
  },
]

/**
 * 从集成守卫源码抽"通过行的覆盖面层数"登记值（`const EXPECTED_COVERED_LAYERS = 14`）。
 *
 * 赋值必须**唯一**：0 处（被改名/改成别的形态）或 >1 处（有歧义）都返回 undefined，
 * 由调用方 fail-loud —— 与 `keepVersionsFrom` 同一套口径。
 * @param source - `scripts/check-integration-tests.mjs` 的源码。
 * @returns 层数；解析失败返回 undefined。
 */
function integrationCoveredLayersFrom(source) {
  const matches = [...String(source).matchAll(/^const EXPECTED_COVERED_LAYERS = (\d+)$/gmu)]
  if (matches.length !== 1) return undefined
  return Number(matches[0][1])
}

/**
 * 从 `prebuild-workspace-deps.ts` 抽 `WORKSPACE_PACKAGES` 的**条数**（FIX-45 ⑤ 的真源）。
 *
 * fail-loud 口径与 {@link keepVersionsFrom} / {@link integrationCoveredLayersFrom} 同源：
 * 找不到数组、括号不闭合、剥不出元素都返回 `undefined`，由调用方判红 ——
 * 拒绝把"解析失败"当通过。
 * @param source - `packages/host/desktop/scripts/prebuild-workspace-deps.ts` 源码。
 * @returns 包数；解析失败返回 undefined。
 */
function workspacePackagesFrom(source) {
  const start = String(source).indexOf('export const WORKSPACE_PACKAGES')
  if (start < 0) return undefined
  // ⚠️ 先跳掉**类型标注**里的 `[`（`readonly WorkspacePackage[]`）——直接找第一个 `[`
  // 会命中类型方括号，剥出来是个空体（实测：解析出 0 条）。
  const assign = String(source).indexOf('=', start)
  if (assign < 0) return undefined
  const open = String(source).indexOf('[', assign)
  if (open < 0) return undefined
  let depth = 0
  let end = -1
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '[') depth += 1
    else if (ch === ']') {
      depth -= 1
      if (depth === 0) { end = i; break }
    }
  }
  if (end < 0) return undefined
  // 条目是**单行对象**（`{ workspace: '…', dir: '…', deps: [] },`）⇒ `dir:` 不在行首，
  // 不能用 `^\s*dir:`（实测只数到 6/13）。按出现次数计。
  const count = [...String(source).slice(open, end).matchAll(/\bdir:\s*'[^']+'/gu)].length
  return count > 0 ? count : undefined
}

/**
 * 从 `scripts/platform-modules.mjs` 抽出 `NAME = [ ... ]` 里的字符串字面量。
 * @param source - 脚本源码。
 * @param name - 目标数组名。
 * @returns 字面量列表；解析失败返回 undefined（调用方 fail-loud）。
 */
function stringArrayFrom(source, name) {
  const match = new RegExp(`${name}\\s*=\\s*\\[([\\s\\S]*?)\\]`, 'u').exec(source)
  if (match === null) return undefined
  return [...match[1].matchAll(/'([^']*)'/gu)].map(entry => entry[1])
}

/**
 * 从提到 `PLATFORM_MODULES` 的那一行里抽模块名（反引号包裹、且不是路径/命令/预设名）。
 * @param line - 文档里的一行。
 * @returns `{ modules, declaredCount }`；该行不含锚点时 `modules` 为 undefined。
 */
function modulesFromDocLine(line) {
  if (!line.includes('PLATFORM_MODULES')) return { modules: undefined, declaredCount: undefined }
  const modules = [...line.matchAll(/`([^`]+)`/gu)]
    .map(match => match[1])
    .filter(token => /^(@[a-z0-9][a-z0-9-]*\/)?[a-z0-9][a-z0-9._/-]*$/u.test(token))
    .filter(token => !MODULE_IGNORE.has(token))
    .filter(token => !/\.(?:mjs|ts|js|md)$/u.test(token))
  const count = /共\s*(\d+)\s*项/u.exec(line) ?? /(\d+)\s+entr(?:y|ies)/u.exec(line)
  return { modules, declaredCount: count === null ? undefined : Number(count[1]) }
}

/** @returns 扫描面下的相对路径列表（跳过 node_modules 与隐藏目录）。 */
function* walk(target) {
  const absolute = join(root, target)
  if (!existsSync(absolute)) return
  if (statSync(absolute).isFile()) {
    if (absolute.endsWith('.md')) yield relative(root, absolute)
    return
  }
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    yield* walk(join(target, entry.name))
  }
}

/**
 * 与 {@link walk} 同形的**宽扩展名**遍历（官网版本号判据要连 `.astro` 一起扫，
 * 而 `walk()` 只 yield `.md` —— E-13 的现场正是 `site/src/pages/index.astro`）。
 * @param root - 仓库根。
 * @param target - 仓库相对目录/文件。
 * @param extensions - 允许的扩展名（如 `['.md', '.astro']`）。
 * @returns 相对路径列表（跳过 node_modules 与隐藏目录）。
 */
function walkWithExtensions(root, target, extensions) {
  const found = []
  const visit = relativePath => {
    const absolute = join(root, relativePath)
    if (!existsSync(absolute)) return
    if (statSync(absolute).isFile()) {
      if (extensions.some(extension => absolute.endsWith(extension))) found.push(relativePath)
      return
    }
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      visit(join(relativePath, entry.name))
    }
  }
  visit(target)
  return found
}

/**
 * **文本 claim 判据表**（2026-10-05 收口轮，分区 C 的 E-12 / `voice.intro` 前提 /
 * README 体积数字）。
 *
 * 与 {@link NUMBER_CLAIM_RULES} 的分工：那张表判"文档里的数字 == 真源里的数字"；
 * 这张表判"**一句断言**与真源同向"（例如"这个字段接受明文 http" ↔ 代码里的 scheme 正则、
 * "模型随客户端附带" ↔ 构建期缺省、以及**不得**把载荷数字冒充成安装包增量）。
 *
 * 共同纪律（与前一张表逐条一致）：
 *   · 真源只**解析文本**，不 import / 不执行被审对象；解析不出 ⇒ `failures`（fail-loud）；
 *   · `sites` 是**逐条登记的落点**（claim 定位点）—— 文件缺失 = 前置失败，不是"没判"；
 *   · `hits` = 命中的**断言行数**（含被判红的那一行）用于「已覆盖」自我陈述与 `min` 地板；
 *     违规行另走 `hits`（全局）通道 ⇒ EXIT=1；
 *   · 行内 `doc-claim:allow` 标记同样适用（记录面例外）。
 */
const TEXT_CLAIM_RULES = [
  {
    id: 'speech-origin-scheme',
    label: '语音模型源允许的 scheme（文档 ↔ 代码常量）',
    source: SPEECH_ORIGIN_SOURCE,
    read: source => speechOriginAcceptsPlainHttp(source),
    // 两个站点页面各一行（zh / en）—— 定位点必须都在（E-04 的 `required` 同一口径）。
    min: 2,
    sites: [
      { file: 'site/src/content/docs/deployment/channels.md', note: '渠道包字段表（中文）' },
      { file: 'site/src/content/docs/en/deployment/channels.md', note: '渠道包字段表（英文）' },
    ],
    /** claim = 提到 `speech_model_origin` 的那一行（字段的取值形状声明）。 */
    claim: line => line.includes('speech_model_origin'),
    /**
     * E-12：`desktop.speech_model_origin` 的取值形状必须与代码常量同向。
     * 修前文档写「只写 `https://host[:port]`」，而代码/上游 schema/构建期校验三处都是 `https?`
     * ⇒ 明文 `http://` 其实可用，文档却说不可用（分区 C 实测：改回旧句后三条桌面包用例 67/67 全绿）。
     */
    judge: (line, index, context) => {
      if (!line.includes('speech_model_origin')) return null
      const implSchemes = Array.isArray(context.truth.schemes) ? [...context.truth.schemes].sort() : undefined
      if (implSchemes === undefined) {
        // 防御性分支：真源解析器形态变了（正常路径上 `read()` 会先返回 undefined ⇒ EXIT=2）。
        return { reason: `真源没有给出 scheme 集合（解析器形态变了？真源 ${SPEECH_ORIGIN_SOURCE}）` }
      }
      const docSchemes = docSchemeSet(line)
      if (docSchemes.size === 0) {
        return {
          reason: '这一行是 `desktop.speech_model_origin` 的取值形状声明，但没有写出任何 scheme '
            + '⇒ claim 定位不到、读者无从判断（真源 '
            + `${SPEECH_ORIGIN_SOURCE} 的 \`SPEECH_ORIGIN_PATTERN\`：${implSchemes.join(' / ')}）`,
        }
      }
      // **集合相等**（收口轮②）：既要判"文档比实现宽"（extra），也要判"实现比文档多"（missing）。
      const missing = implSchemes.filter(scheme => !docSchemes.has(scheme))
      const extra = [...docSchemes].sort().filter(scheme => !implSchemes.includes(scheme))
      if (missing.length === 0 && extra.length === 0) return null
      const shape = `\`${implSchemes.map(scheme => `${scheme}://`).join(' | ')}\``
      const docShape = `\`${[...docSchemes].sort().map(scheme => `${scheme}://`).join(' | ')}\``
      return {
        reason: `文档声明的 scheme 集合与代码常量**不一致**：文档 ${docShape}，真源 ${shape}`
          + `${missing.length > 0 ? `；**实现还接受** ${missing.join('、')}（文档没写 ⇒ 读者会以为不可用）` : ''}`
          + `${extra.length > 0 ? `；**文档多写了** ${extra.join('、')}（实现不接受 ⇒ 照文档写会被拒）` : ''}`
          + `（真源 ${SPEECH_ORIGIN_SOURCE} 的 \`SPEECH_ORIGIN_PATTERN\`）`,
      }
    },
  },
  {
    id: 'voice-intro-copy',
    label: '语音输入引导语的前提（随包 vs 首次下载）',
    source: VOICE_BUNDLE_SOURCE,
    read: source => voiceBundleDefaultFrom(source),
    min: 2,
    sites: [{ file: VOICE_LOCALE_SOURCE, note: '`voice.intro` 的中英两条（`voice-setup.tsx` 无条件渲染）' }],
    /** claim = `voice.intro` 的两条文案本身（`voice.privacy` 等同族键不算）。 */
    claim: line => line.includes("'voice.intro'"),
    /**
     * `voice.intro` 在任何 phase 下都渲染 ⇒ 它必须对"随包渠道"与"关掉随包的渠道"**都**成立。
     * 修前两种语言都写"首次使用需要先下载识别模型"，而构建期缺省是**随包**
     * （`speechBundleModel !== false`），分区 C 实测：改回旧话术 ⇒ 三条桌面包用例 67/67 全绿。
     */
    judge: (line, index, context) => {
      if (!line.includes("'voice.intro'")) return null
      const chinese = /[\u4e00-\u9fff]/u.test(line)
      const oldPremise = chinese
        ? /首次使用需要先下载|首次使用时下载|首次使用下载|需要先下载/u.test(line)
        : /download(?:ed|s)? on first use|first[- ]use download|on-demand download/iu.test(line)
      const bundledClaim = chinese
        ? /随客户端|随包/u.test(line)
        : /ships with the client|bundl/iu.test(line)
      const downloadClaim = chinese ? /首次使用/u.test(line) : /first use/iu.test(line)
      if (context.truth.bundledByDefault === true) {
        if (oldPremise) {
          return {
            reason: '文案断言"首次使用需要先下载识别模型"，而构建期缺省是**随包**'
              + '（`speechBundleModel: branding.speechBundleModel !== false`）⇒ 对官方渠道是错的前提；'
              + '这句话由 `voice-setup.tsx` **无条件渲染**（不分 phase）'
              + `（真源 ${VOICE_BUNDLE_SOURCE}）`,
          }
        }
        if (!bundledClaim) {
          return {
            reason: '文案没有说明"模型随客户端附带"（缺省形态），而 `voice.intro` 对随包渠道'
              + '是唯一的前提说明 ⇒ 读者会以为必须下载'
              + `（真源 ${VOICE_BUNDLE_SOURCE}：缺省 true，只有显式布尔 false 才回到下载）`,
          }
        }
        return null
      }
      if (!downloadClaim) {
        return {
          reason: '构建期缺省已是**不随包**（`speechBundleModel` 缺省翻成 false），'
            + '而这条文案没有说明"首次使用需要下载" ⇒ 与现默认相反'
            + `（真源 ${VOICE_BUNDLE_SOURCE}）`,
        }
      }
      return null
    },
  },
  {
    id: 'readme-installer-increment',
    label: 'README 不得把随包载荷冒充成安装包增量',
    source: VOICE_ASSETS_SOURCE,
    read: source => voiceModelPayloadMiBFrom(source),
    min: 2,
    sites: [
      { file: 'README.md', note: '语音输入一节（中文）' },
      { file: 'README.en.md', note: '语音输入一节（英文）' },
    ],
    /**
     * claim = 写出**随包载荷**的那一行（`权重约 230MiB` / `weights are about 230MiB`）。
     *
     * 判据刻意**不把载荷数字本身**当 claim 的一部分：数字写错由
     * `voice-model-payload` 那条**硬数字**规则判（它有自己的真源与容差），
     * 这条只判"载荷数字被当成了什么" —— 两者分工，互不掩盖。
     */
    claim: line => /权重|weights/iu.test(line) && /\d+\s*(?:MiB|MB)/u.test(line),
    /**
     * E-P2 item 1：`+230MiB` 是**载荷**，不是安装包增量（实测三平台 +139.7～252.5 MiB）。
     * 修前 README 写「代价是安装包约 +230MiB」——单值表述对 macOS 高估约 90MiB。
     * 判据：出现"安装包 + <载荷数字> MiB"这种**把载荷当增量**的写法即红（区间/分平台写法放行）。
     */
    judge: (line, index, context) => {
      const payload = Number(context.truth)
      if (!new RegExp(`(?<![\\d.])${payload}(?![\\d.])`, 'u').test(line)) return null
      const zh = new RegExp(`安装包[^。\\n]{0,12}?${payload}\\s*(?:MiB|MB)`, 'u')
      const en = new RegExp(`installer[^.\\n]{0,24}?${payload}\\s*(?:MiB|MB)`, 'iu')
      if (!zh.test(line) && !en.test(line)) return null
      return {
        reason: `把**随包载荷**（约 ${payload}MiB 的权重）写成了**安装包增量**`
          + '（实测三平台增量 +139.7～252.5 MiB，随各打包格式的压缩率而变）'
          + `（真源 ${VOICE_ASSETS_SOURCE} 的 bytes 之和；分平台数据见 docs/releases 的实测表）`,
      }
    },
  },
]

/**
 * **禁止写死的条数**（FIX-47④d）—— "写不出真源"的那类数字要反过来判。
 *
 * ## 现场（第三十一轮 AD2-06，真跑）
 *
 * `AGENTS.md:82` 写着 E2E「**25** assertions」，而同一轮真跑 `e2e:client` 得到的
 * `.e2e-report.md` 自述是 **41/41 通过**；`docs/ci-and-branch-plan.md:79` 的 ASCII 图还写着
 * 「e2e:client（**13** 断言）」、`:75` 写着「webadmin npm test(**109**)」（实测 50 files /
 * 723 tests）。第三十轮 FIX-45⑤ 已经把 `ci-and-branch-plan.md` 的同一句话改成"不写死"，
 * **但 `AGENTS.md` 与同文件的 ASCII 图漏了** —— 同族只收口了一条。
 *
 * ## 为什么这三条不能进 {@link NUMBER_CLAIM_RULES}
 *
 * 硬数字规则要一份**静态真源**（读一个文件算出一个数）。E2E 断言条数**结构上不是静态
 * 常量**：`reportStep(` 调用点里 7 个在 `for (const item of pagePanels)`（3 项）循环里，
 * 运行期真值 = 41 ≠ 调用点数 36 ≠ 字面量出现次数 37 —— 写死任何一个都会漂。这类数字的
 * 唯一真源是**运行期产物** `packages/host/desktop/.e2e-report.md` 的「结果：N/N 通过」，
 * 而它不入库。webadmin 用例条数同理（每加一条测试就漂）。
 *
 * ⇒ 判据是**禁止形态**：文档里出现这些句式即红；指着真源写（"条数见 …"）就绿。
 * `files` 白名单只列**权威口径文档**（AGENTS.md 与 CI 计划图），避免误伤历史记录面。
 */
const FORBIDDEN_DOC_NUMBERS = [
  {
    id: 'e2e-assertion-count',
    label: 'E2E 断言条数不得写死',
    truthSource: '运行期 `packages/host/desktop/.e2e-report.md` 的「结果：N/N 通过」'
      + '（`reportStep(` 调用点 36 个、其中 7 个在 3 次迭代的循环里 ⇒ 不是静态常量）',
    files: ['AGENTS.md', 'docs/ci-and-branch-plan.md'],
    // 负向前视排除**引号/反引号里被引述的**数字（`曾写"25 assertions"` 这类"记录当时事实"
    // 的引述不该被这条判据抓住 —— 本仓已经有一处这样的引述，判据误伤它就会逼人加 allow 标记，
    // 反而把痕迹抹掉）。
    patterns: [
      /(?<![\d.'"\u2018\u2019\u201c\u201d`])([0-9]+)\s*assertions?\b/giu,
      /e2e(?::client)?[^\n]{0,40}?(?<![\d.'"\u2018\u2019\u201c\u201d`])([0-9]+)\s*断言/giu,
      /(?<![\d.'"\u2018\u2019\u201c\u201d`])([0-9]+)\s*断言[^\n]{0,40}?e2e/giu,
    ],
  },
  {
    id: 'webadmin-test-count',
    label: 'webadmin 用例条数不得写死',
    truthSource: '`cd server/webadmin && npm test` 的输出（每加一条用例就漂）',
    files: ['AGENTS.md', 'docs/ci-and-branch-plan.md'],
    patterns: [
      /webadmin\s+npm\s+test\s*\(\s*([0-9]+)\s*\)/giu,
      /webadmin\s+npm\s+test\s*\(\s*([0-9]+)\s*(?:files?|tests?)\s*\)/giu,
    ],
  },
].map(rule => ({ ...rule, hits: 0 }))

/**
 * **通过行（`✅`）的登记表 —— 唯一真源**（R13-GF 的第二条修法）。
 *
 * 通过行由它**生成**，打印前被 {@link passLineProblems} 反解断言（数量 + 逐条标签 +
 * 不得出现无边界的旧措辞）。`id` 必须与 `NUMBER_CLAIM_RULES[*].id` 及 `pin` /
 * `platform-modules` 对齐；漏登记 / 多登记都在主流程里对拍打红。
 */
const COVERAGE_ITEMS = [
  { id: 'pin', label: '上游 pin' },
  { id: 'platform-modules', label: '平台模块表' },
  ...NUMBER_CLAIM_RULES.map(rule => ({ id: rule.id, label: rule.label })),
  ...TEXT_CLAIM_RULES.map(rule => ({ id: rule.id, label: rule.label })),
  SITE_VERSION_RULE,
]
const PASS_LINE_PREFIX = 'check-doc-claims: 已覆盖 '
const PASS_LINE_SUFFIX = ' —— 全部与真源一致 ✅'
/**
 * 修前那条**无边界**的通过行措辞：它声称"文档数字与真源一致"，而当时只判了两类 claim。
 * 收敛后不得再出现（出现即红）。
 */
const RETIRED_PASS_CLAIM = '文档数字与真源一致'
/**
 * **"像通过行"的断言语气**（第十五轮 R15A-01 的收口）—— 通过行探测的**识别面**。
 *
 * 修前这里只认两个字面量（{@link PASS_LINE_PREFIX} 与 {@link RETIRED_PASS_CLAIM}），
 * 于是"换一套措辞写同样宽的结论"就不是嫌疑行。实测（`temp/r15/A/probe/mut-battery3.py`
 * 的 C1/C4）：在**真通过行之前**多打一行
 * `check-doc-claims: 全部文档、脚本、CI 配置与渠道包均与真源一致（含 12 类未登记 claim）✅`
 * —— 层②（子进程 stdout）与层③（本进程 stdout）都放过，EXIT=0。
 *
 * 收紧后的口径是**断言语气**而不是某一句措辞：只要一行里出现"通过/一致的自我陈述"的
 * 三个记号之一，它就是嫌疑行，必须**恰好 1 行**、且必须就是真行。这是一张白名单式
 * 的网（判据自己打印的那一行也必须落在里面），不是"再多认两个词"。
 */
const VERDICT_CLAIM_TOKENS = ['✅', PASS_LINE_PREFIX.trim(), '与真源一致']

/** 生成通过行（`covered` = 本轮**真正产出过断言**的项，按登记顺序）。 */
function passLineFor(covered) {
  return `${PASS_LINE_PREFIX}${covered.length} 项：${covered.map(item => item.label).join('、')}${PASS_LINE_SUFFIX}`
}

/**
 * 通过行探测的**子进程开关**见文件头：`VERDICT_PROBE_ARG`（argv）/ `VERDICT_PROBE_ENV`（已废除）
 * 都声明在文件顶部 —— 开关的语义、现场与"为什么 argv 安全"写在那里。
 */

/** 取 stdout 里的**非空行**（通过行探测用）。 */
function verdictLines(stdout) {
  return String(stdout).split('\n').map(line => line.trimEnd()).filter(line => line.trim() !== '')
}

/** 取 stdout 里**最后一行非空**（= 真正被当成"通过行"打出去的那一行）。 */
function verdictLineFrom(stdout) {
  const lines = verdictLines(stdout)
  return lines.length === 0 ? '' : lines[lines.length - 1]
}

/**
 * 反解**真正打印出去的那一行**（而不是断言内部变量）。
 *
 * 现场（第十三轮 V13-C R-1，探针 `d6`）：`printVerdict()` 先 `passLineProblems(summaryLine)`
 * 再 `console.log(summaryLine)` —— 断言钉的是**变量**。把 `console.log(summaryLine)` 换成
 * `console.log('check-doc-claims: 文档数字与真源一致（覆盖 2 项）✅')` 之后，守卫 **EXIT=0 且
 * 打印一句比判据面宽的自述**，与函数自己的注释（"必须钉在打印这条路径上"）相反。
 *
 * 判据：喂进来的必须是**进程真实打出去的那段 stdout**（子进程捕获 / 本进程 `write` 拦截），
 * 然后只认它。
 * @param stdout - 真实 stdout 片段。
 * @param covered - 本轮真正产出过断言的项。
 * @returns 问题列表（空 = 通过）。
 */
function printedVerdictProblems(stdout, covered) {
  const problems = []
  const line = verdictLineFrom(stdout)
  if (line === '') {
    problems.push('通过行探测：真实 stdout 里一行都没有 —— 通过凭据没有真的被打印出去')
    return problems
  }
  // 「打出去的那一行」还必须**唯一**：先打真行再补一句更宽的自述，读者拿到的仍是宽于事实的结论。
  //
  // 识别面 = {@link VERDICT_CLAIM_TOKENS}（断言语气），**不是**某一套具体措辞 ——
  // "宽自述打在真行之前"（R15A-01 的 C1/C4）就是靠这条收口的：任何含 ✅ / `已覆盖 ` /
  // `与真源一致` 的行都是嫌疑行，出现两行即红（无论谁在前谁在后）。
  const suspects = verdictLines(stdout).filter(candidate =>
    VERDICT_CLAIM_TOKENS.some(token => candidate.includes(token)))
  if (suspects.length !== 1) {
    problems.push(`通过行探测：真实 stdout 里有 ${suspects.length} 行"像通过行"的文字（必须恰好 1 行）：`
      + suspects.map(candidate => JSON.stringify(candidate.trim().slice(0, 160))).join(' | '))
  }
  problems.push(...passLineProblems(line, covered))
  return problems
}

/**
 * **反解断言通过行本身**（不是断言它存在）：① `已覆盖 N 项` 的 N 必须等于本轮真正
 * 产出断言的项数；② 逐条标签必须**按序**出现（数量对但张冠李戴也红）；③ 不得出现
 * 无边界的旧措辞。
 * @param line - 待打印的通过行。
 * @param covered - 本轮真正产出过断言的项。
 * @returns 问题列表（空 = 通过）。
 */
function passLineProblems(line, covered) {
  const problems = []
  if (line.includes(RETIRED_PASS_CLAIM)) {
    problems.push(`通过行用了无边界的旧措辞「${RETIRED_PASS_CLAIM}」—— 它声称的范围比判据面宽`)
  }
  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const match = new RegExp(`^${escape(PASS_LINE_PREFIX)}(\\d+) 项：([\\s\\S]*?)${escape(PASS_LINE_SUFFIX)}$`, 'u').exec(line)
  if (match === null) {
    problems.push(`通过行不是「${PASS_LINE_PREFIX}N 项：<逐条标签>${PASS_LINE_SUFFIX}」形态：${line}`)
    return problems
  }
  const declared = Number(match[1])
  if (declared !== covered.length) {
    problems.push(`通过行写「已覆盖 ${declared} 项」，实际本轮判过 ${covered.length} 项`)
  }
  const listed = match[2].split('、')
  const expected = covered.map(item => item.label)
  if (listed.length !== expected.length || listed.some((label, index) => label !== expected[index])) {
    problems.push(`通过行列出的项与登记项不符：行里 [${listed.join('、')}] / 实际 [${expected.join('、')}]`)
  }
  return problems
}

/**
 * **上下文锚判定（唯一实现）**：规则带 `anchor` 时，锚必须在该行 ±`window` 行内命中
 * （`window` 缺省 0 = **同一行**；见 `client-platforms` 的注释：留 ±1 行会让邻行的
 * "安装包"为无关的「N 平台」背书 —— 第十四轮 E-04 的假红现场）。
 *
 * 抽成函数是为了让自检能直接断言"锚的判别力"，而不是断言"当前这份文档恰好解析对了"。
 * `anchor` **不得**带 `g` 旗标（带 `g` 的 `test()` 有 lastIndex 状态，跨行判定会抖动）。
 * @param rule - 规则（读 `anchor` / `window`）。
 * @param lines - 全文按行切分。
 * @param index - 当前行下标。
 * @returns 该行是否落在锚内（没有 `anchor` 时恒真）。
 */
function anchorAccepts(rule, lines, index) {
  if (rule.anchor === undefined) return true
  const span = rule.window ?? 0
  const context = lines.slice(Math.max(0, index - span), index + span + 1).join('\n')
  return rule.anchor.test(context)
}

/**
 * 取该规则在某个文件里的**锚内**命中条数（`hitsByFile` 由扫描循环填充）。
 *
 * `required`（claim 定位点）靠它判：某个 canonical 文档里一条锚内命中都没有 ⇒ 那条 claim
 * 已经不可定位（被删 / 被改写成别的语境）。
 * @param rule - 扫描后的规则状态。
 * @param file - 仓库相对路径。
 * @returns 命中条数（缺省 0）。
 */
function ruleHitsInFile(rule, file) {
  return rule.hitsByFile instanceof Map ? (rule.hitsByFile.get(file) ?? 0) : 0
}

/**
 * 文本 claim 判据的**自检用例**（2026-10-05 收口轮）。
 *
 * 单独成函数是刻意的：`selfTest()` 里那批用例只做"取值比较"，而这个函数把三条规则的
 * **解析器**与**判词**各跑正反两态 —— 判词被写成恒真/恒假时这里当场红（不再需要靠
 * 端到端变异才能发现）。
 * @returns `[ok, message]` 二元组数组（与 `selfTest()` 的 `cases` 同形）。
 */
function textClaimSelftestCases() {
  const rule = id => TEXT_CLAIM_RULES.find(entry => entry.id === id)
  const judge = (id, line, truth) => {
    const found = rule(id)
    if (found === undefined) return undefined
    return found.judge(line, 0, { truth, file: 'selftest.md', lines: [line] })
  }
  return [
    [rule('speech-origin-scheme') !== undefined && rule('voice-intro-copy') !== undefined
      && rule('readme-installer-increment') !== undefined,
      'selftest: 文本 claim 判据表里必须有 speech-origin-scheme / voice-intro-copy / '
      + 'readme-installer-increment 三条规则（删掉它们 = 三条 NO-TEETH 又回来了）'],
    // E-12：真源解析（两种形态 + fail-loud）
    [speechOriginAcceptsPlainHttp('const SPEECH_ORIGIN_PATTERN = /^https?:\\/\\/[^/\\s?#@]+\\/?$/u')
      ?.allowsPlainHttp === true,
      'selftest: `https?` 常量必须解析成"接受明文 http"'],
    [speechOriginAcceptsPlainHttp('const SPEECH_ORIGIN_PATTERN = /^https:\\/\\/[^/]+$/u')
      ?.allowsPlainHttp === false,
      'selftest: https-only 常量必须解析成"不接受明文 http"'],
    [speechOriginAcceptsPlainHttp('const OTHER_PATTERN = /^ftp:/u') === undefined,
      'selftest: 常量被改名/删掉必须 fail-loud（返回 undefined）'],
    // E-12 收口轮（V-P4 的 T10/T10c）：**等价改写**不能翻转结论，**形态不认识**必须 fail-loud。
    [speechOriginAcceptsPlainHttp('const SPEECH_ORIGIN_PATTERN = /^https:\\/\\/[^/\\s?#@]+\\/?$|^http:\\/\\/[^/\\s?#@]+\\/?$/u')
      ?.allowsPlainHttp === true,
      'selftest: 顶层 `|` 的等价改写（`^https://…$|^http://…$`）必须仍解析成"接受明文 http"'
      + '（修前按 `startsWith` 只看第一个候选 ⇒ 结论与事实相反，T10c 假阴性）'],
    [speechOriginAcceptsPlainHttp('const SPEECH_ORIGIN_PATTERN = /^http:\\/\\/[^/]+$/u')
      ?.allowsPlainHttp === true,
      'selftest: 只有 `http://` 一个候选时也必须解析出"接受明文 http"'],
    [speechOriginAcceptsPlainHttp('const SPEECH_ORIGIN_PATTERN = /^http(s)?:\\/\\/[^/]+$/u')
      ?.allowsPlainHttp === true,
      'selftest: 可选**分组** `(s)?` 形态必须解析成 http + https'],
    [speechOriginAcceptsPlainHttp('const SPEECH_ORIGIN_PATTERN = /^http[s]?:\\/\\/[^/]+$/u') === undefined,
      'selftest: 字符类 `[s]?` 这类**形态不认识**的写法必须 fail-loud（返回 undefined ⇒ EXIT=2）'],
    [speechOriginAcceptsPlainHttp('const SPEECH_ORIGIN_PATTERN = /^(?:https?:\\/\\/[^/]+$/u') === undefined,
      'selftest: 括号不配对的残缺正则必须 fail-loud（不猜）'],
    // E-12：判词正反（现场句 = 修前那句）
    [judge('speech-origin-scheme', '| `desktop.speech_model_origin` | 内网镜像源 | 只写 `https://host[:port]`，**不能带路径** |',
      { allowsPlainHttp: true, schemes: ['http', 'https'] }) !== null,
      'selftest: 「只写 `https://host[:port]`」在代码接受 http 时必须判红（E-12 的现场形态）'],
    [judge('speech-origin-scheme', '| `desktop.speech_model_origin` | 内网镜像源 | `http(s)://host[:port]` only（明文 `http://` 也接受） |',
      { allowsPlainHttp: true, schemes: ['http', 'https'] }) === null,
      'selftest: `http(s)://` 形态必须放行（防"一刀切成见到 https 就红"）'],
    [judge('speech-origin-scheme', '| `desktop.speech_model_origin` | 内网镜像源 | `http(s)://host[:port]` only |',
      { allowsPlainHttp: false, schemes: ['https'] }) !== null,
      'selftest: 代码改成 https-only 后，文档里的 `http(s)://` 必须跟着红（双向）'],
    // 收口轮②（V-P10P11 的 D6）：**实现比文档多一个 scheme** 也必须红（集合相等，不是"文档 ⊆ 实现"）。
    [judge('speech-origin-scheme', '| `desktop.speech_model_origin` | 内网镜像源 | `http(s)://host[:port]` only |',
      { allowsPlainHttp: true, schemes: ['http', 'https', 'wss'] }) !== null,
      'selftest: 实现多出一个 scheme（`wss`）而文档只写 `http(s)://` 时必须判红（集合相等）'],
    [judge('speech-origin-scheme', '| `desktop.speech_model_origin` | 内网镜像源 | `http(s)://` 与 `wss://` 都接受 |',
      { allowsPlainHttp: true, schemes: ['http', 'https', 'wss'] }) === null,
      'selftest: 文档把三个 scheme 都写全时必须放行（防过度收紧）'],
    [judge('speech-origin-scheme', '| `desktop.speech_model_origin` | 内网镜像源 | 只写 `https://host[:port]`，**不能带路径** |',
      { allowsPlainHttp: true, schemes: ['http', 'https', 'wss'] }) !== null,
      'selftest: 文档少写 scheme 时也必须红（`only` 不等于"写全"）'],
    [judge('speech-origin-scheme', '| 无关的字段 | x | `https://example.com` |', { allowsPlainHttp: true, schemes: ['http', 'https'] }) === null,
      'selftest: 不含 `speech_model_origin` 的行不是这条规则的 claim'],
    // `voice.intro` 前提面：真源解析 + 判词正反
    [voiceBundleDefaultFrom('    speechBundleModel: branding.speechBundleModel !== false,')
      ?.bundledByDefault === true,
      'selftest: `!== false` 必须解析成"缺省随包"'],
    [voiceBundleDefaultFrom('    speechBundleModel: branding.speechBundleModel !== true,')
      ?.bundledByDefault === false,
      'selftest: `!== true` 必须解析成"缺省不随包"'],
    [voiceBundleDefaultFrom('const unrelated = 1') === undefined,
      'selftest: 缺 `speechBundleModel` 必须 fail-loud（返回 undefined）'],
    [judge('voice-intro-copy', "  'voice.intro': '识别模型首次使用需要先下载识别模型，之后可离线使用。',",
      { bundledByDefault: true }) !== null,
      'selftest: 旧前提（"首次使用需要先下载"）在缺省随包时必须判红'],
    [judge('voice-intro-copy', "  'voice.intro': '识别模型默认随客户端附带，装上即可用、无需下载；只有关掉随包的渠道才需要首次下载。',",
      { bundledByDefault: true }) === null,
      'selftest: "随客户端附带 + 关掉随包才下载"必须放行（本仓现文案）'],
    [judge('voice-intro-copy', "  'voice.intro': 'The recognition model ships with the client, so it works right away with no download; only channels that opt out of bundling need a one-time download.',",
      { bundledByDefault: true }) === null,
      'selftest: 英文现文案必须放行'],
    [judge('voice-intro-copy', "  'voice.intro': 'The model ships with the client.',",
      { bundledByDefault: false }) !== null,
      'selftest: 缺省不随包时，"只说随包"的文案必须判红（双向）'],
    // README 体积数字：载荷 ≠ 安装包增量
    [judge('readme-installer-increment', '- **语音输入**：…代价是安装包约 +230MiB；', 230) !== null,
      'selftest: 「安装包约 +230MiB」必须判红（把载荷冒充成增量 —— E-P2 item 1 的现场）'],
    [judge('readme-installer-increment', '- **语音输入**：…权重本身约 230MiB，安装包增幅视平台打包格式的压缩率而定，约 +140～250 MiB）；',
      230) === null,
      'selftest: 现文案（载荷 + 区间增量）必须放行'],
    [judge('readme-installer-increment', '- **Voice input**: the weights are about 230MiB and the installer grows by roughly +140–250 MiB depending on compression);',
      230) === null,
      'selftest: 英文现文案必须放行'],
    // E-13：版本字面量正则（含"不该命中的两种"）
    ['发布 2.7.0 与 2.8.0 两个版本'.match(RELEASE_VERSION_LITERAL)?.length === 2,
      'selftest: 裸版本号（`2.7.0`）都应命中'],
    ['dsh-v0.1.5-rc.2 与 172.28.0.1'.match(RELEASE_VERSION_LITERAL) === null,
      'selftest: 上游 pin `0.1.5` 与 IP `172.28.0.1` 都不得命中（否则判据会误伤）'],
    [SITE_VERSION_ALLOW.length >= 1 && SITE_VERSION_ALLOW.every(entry => typeof entry.why === 'string' && entry.why !== ''),
      'selftest: 官网版本号允准面必须逐条写明理由（空理由 = 任意豁免）'],
  ]
}

/**
 * E-13 判据的**命中路径**自检（收口轮 P1，独立核验 V-P4 的 G1）。
 *
 * 现场：掏空这段扫描里的 `hits.push`（计数还在、正则还在、死条目与覆盖面全绿）之后，
 * 站点写回 `2.9.9` 不再被咬，而 `--selftest` **一格都不走这条路径** ⇒ 掏空完全静默。
 * 修法：把扫描抽成 {@link scanSiteReleaseVersions}，在这里对**合成站点树**断言：
 *   · 发布语境的裸号 ⇒ 必须产出命中（`hits.push` 的路径真的通）；
 *   · 允准面里登记的字面量 ⇒ 不算命中；
 *   · 允准面文件里**未登记**的字面量 ⇒ 算命中（修前整文件豁免，V-P4 的 T4）；
 *   · 第三方组件版本（无发布语境、非本项目发布线）⇒ **不得**命中（V-P4 的 T3 假红）；
 *   · 登记的字面量被改写成 `v` 号 ⇒ **不算死条目**（正当余量，V-P4 的 T5）；
 *   · 什么都没讲 ⇒ 死条目。
 * @returns `[ok, message]` 二元组数组（与 `selfTest()` 的 `cases` 同形）。
 */
function siteVersionSelftestCases() {
  const tree = mkdtempSync(join(tmpdir(), 'doc-claims-e13-'))
  const write = (relativePath, content) => {
    const absolute = join(tree, relativePath)
    mkdirSync(join(absolute, '..'), { recursive: true })
    writeFileSync(absolute, content)
  }
  try {
    write('site/src/pages/index.astro', [
      'curl -fL -O https://release.picoaide.com/official/releases/9.9.9/picoaide-server-9.9.9-amd64.zip',
      '<p>当前发布版本 3.0.0</p>',
      '<p>需要 Caddy 2.7.6 及以上（官方镜像已内置）。</p>',
      '<p>上游自 0.1.5 起保留该 profile 名。</p>',
      '<p>最新发布线 2.8.7 的说明</p>',
      // 收口轮②（V-P10P11 的 E10/E7）：两条"发布语境 + 号"的边界散文，逐字钉住。
      '<p>说明写在 releases/ 目录，内容涉及 Caddy 2.7.6 的升级。</p>',
      '<p>自发布版本 2.7.0 起，镜像内已内置 Caddy。</p>',
    ].join('\n'))
    write('site/src/content/docs/deployment/upgrade.md', [
      '# 镜像里 2.7.0 与 v2.7.0 两个 tag 都在',
      '# 另一处 tag 语境里写着没登记的 2.9.9',
    ].join('\n'))
    const scanned = scanSiteReleaseVersions(tree, {
      allowEntries: SITE_VERSION_ALLOW,
      releaseLinePrefix: '2.8.',
    })
    const literals = scanned.entries.map(entry => `${entry.file.split('/').pop()}:${entry.literal}`)
    const inIndex = scanned.entries.filter(entry => entry.file.endsWith('index.astro')).map(entry => entry.literal)
    const inUpgrade = scanned.entries.filter(entry => entry.file.endsWith('upgrade.md'))
    // 死条目：把文件里那句 `2.7.0 … v2.7.0` 整个删掉（登记的事实没了 ⇒ 必须报死条目）。
    write('site/src/content/docs/deployment/upgrade.md', '# 这里不再讲任何版本号\n')
    const dead = scanSiteReleaseVersions(tree, { releaseLinePrefix: '2.8.' })
    // 正当余量：裸号 → `v` 号（语义不变）⇒ **不是**死条目。
    write('site/src/content/docs/deployment/upgrade.md', '# 镜像里 v2.7.0 与 v2.8.0 两个 tag 都在\n')
    const rewritten = scanSiteReleaseVersions(tree, { releaseLinePrefix: '2.8.' })
    return [
      [scanned.files === 2, `selftest: E-13 合成树应扫到 2 个 .md/.astro（实际 ${scanned.files}）`],
      [inIndex.includes('9.9.9') && inIndex.includes('3.0.0'),
        'selftest: E-13 的**命中路径**必须有牙 —— 发布语境里的裸号（`releases/9.9.9/…` 与'
        + `「当前发布版本 3.0.0」）都必须产出命中（实际 ${JSON.stringify(inIndex)}）`],
      [scanned.hitCount > 0 && literals.length > 0,
        `selftest: E-13 扫描必须产出命中记录（实际 ${JSON.stringify(literals)}）`],
      // **命中路径**（报告投影）本身：它必须把命中变成 `hits` 通道的对象。
      // 掏空这一层（例如 `return []`）= 判据形同不存在，而计数/覆盖面仍全绿（V-P4 的 G1）。
      [(reports => reports.length >= 3
        && reports.length === scanned.entries.filter(entry => !entry.allowed).length
        && reports.every(report => report.kind === 'SITE-VERSION'
          && scanned.entries.some(entry => entry.file === report.file && entry.line === report.line
            && report.reason.includes(`\`${entry.literal}\``))))(siteVersionHitReports(scanned)),
        `selftest: E-13 的**命中路径必须有牙** —— 发布语境里的裸号（\`releases/9.9.9/…\` 与`
        + `「当前发布版本 3.0.0」）都必须产出命中（实际 ${JSON.stringify(inIndex)}）`],
      [siteVersionHitReports(scanned).every(report => !report.reason.includes('undefined')),
        'selftest: E-13 的报告对象必须带可读的理由（不得出现 undefined 占位）'],
      // 主路径的**接线**：投影出来的命中必须真的进 `hits`（否则上面那格只是"函数有牙、
      // 主路径不接"）。needle 由**分段拼接**得到，避免这条断言自己命中自己。
      [(() => {
        const needle = ['hits.push(...siteVersion', 'HitReports(siteVersionScan))'].join('')
        const source = readFileSync(fileURLToPath(import.meta.url), 'utf8')
        const lines = source.split('\n').filter(line => line.includes(needle))
        return lines.length === 1 && !lines[0].trim().startsWith('//')
      })(),
        'selftest: E-13 的命中必须在主路径上被接进 `hits`（`hits.push(...siteVersionHitReports(...))` '
        + '缺失/被注释 = 判据形同不存在，而自检与覆盖面仍会全绿）'],
      [inIndex.includes('2.8.7'),
        'selftest: 落在本项目发布线（`2.8.`，来自 root package.json）上的裸号即使没有语境标记也必须命中'],
      [!inIndex.includes('2.7.6') && !inIndex.includes('0.1.5'),
        `selftest: 第三方组件版本（\`Caddy 2.7.6\`）与上游 pin（\`0.1.5\`）都**不得**命中`
        + `（实际 ${JSON.stringify(inIndex)}）`],
      // ---- 收口轮②（V-P10P11 的 E10）：**行里提到 `releases/` 但号与发布面无关**的散文 ⇒ 不得误伤 ----
      [inIndex.filter(entry => entry === '2.7.6').length === 0
        && scanned.entries.every(entry => !entry.text.includes('内容涉及')),
        'selftest: 「说明写在 releases/ 目录，内容涉及 Caddy 2.7.6 的升级。」这类散文**不得**判红'
        + '（`releases/` 只在**紧挨着号**时才算发布面 token —— V-P10P11 的 E10 假红）'],
      // ---- 收口轮②（V-P10P11 的 E7）：**行级发布语境 + 历史裸号** ⇒ 判为正当收紧，逐字钉住 ----
      [scanned.entries.some(entry => entry.literal === '2.7.0' && entry.text.includes('自发布版本')),
        'selftest: 「自发布版本 2.7.0 起…」**判红是正当收紧**（行级语境「发布版本」+ 历史裸号）——'
        + '修法是写成 `v2.7.0`（本仓既有约定）或加行内 `doc-claim:allow`；这条边界不得再被当成新发现'],
      [inUpgrade.some(entry => entry.literal === '2.7.0' && entry.allowed)
        && inUpgrade.some(entry => entry.literal === '2.9.9' && !entry.allowed),
        'selftest: 允准面必须**按字面量**判 —— 登记的 `2.7.0` 放行，同文件里的 `2.9.9` 照样命中'],
      [dead.deadEntries.some(entry => entry.file === SITE_VERSION_ALLOW[0].file),
        `selftest: 允准面文件不再讲登记的号时必须报死条目（实际 ${JSON.stringify(dead.deadEntries)}）`],
      [!rewritten.deadEntries.some(entry => entry.file === SITE_VERSION_ALLOW[0].file),
        'selftest: 裸号正当改写成 `v` 号**不得**触发死条目（允准面余量，V-P4 的 T5 假红）'],
    ]
  } finally {
    rmSync(tree, { recursive: true, force: true })
  }
}

/**
 * `--selftest` 用例**条数地板**（棘轮，收口轮 2026-10-05）。
 *
 * 现场（独立核验 V-P4 的 G3）：`--selftest` 打印的 `自检 N/N 项通过` 里 N = `cases.length`
 * ⇒ 删掉 21 条用例之后它照旧打印「自检 54/54 项通过 ✅」并 EXIT=0。取值 = 当前实测条数的
 * ratchet（只允许被"变多"越过）：成批删除 / 清空当场红。
 *
 * ⚠️ 与 `check-workflows.mjs` 的 `SELFTEST_MIN_SAMPLES` 同一手法：**地板本身不写在用例表里**
 * —— 它由 `selfTest()` 里那个独立的 `if` 判，掏空 `cases` 数组不能顺手掏空它。
 */
const SELFTEST_MIN_CASES = 91
/**
 * **定向用例点名对账**（与 `check-workflows.mjs` 的 `SELFTEST_REQUIRED_SAMPLES` 同形）：
 * 每条 `needle` 必须在某一格用例的说明文字里出现 —— 只删"这一格样本"（条数地板可能还过得去）
 * 也会具名报红。收口轮补的是三条本轮新加的牙 + 既有牙的关键格。
 */
const SELFTEST_REQUIRED_CASES = [
  { needle: '文本 claim 判据表里必须有 speech-origin-scheme', why: '三条文本 claim 规则的存在性（删规则 = NO-TEETH 回来）' },
  { needle: '`https?` 常量必须解析成"接受明文 http"', why: 'E-12 真源解析：`https?` 形态' },
  { needle: 'https-only 常量必须解析成"不接受明文 http"', why: 'E-12 真源解析：https-only 形态' },
  { needle: '常量被改名/删掉必须 fail-loud', why: 'E-12 真源解析：形态不认识 ⇒ undefined' },
  { needle: '顶层 `|` 的等价改写', why: 'E-12 收口轮：等价改写不得翻转结论（V-P4 T10c 假阴性）' },
  { needle: '字符类 `[s]?` 这类**形态不认识**的写法必须 fail-loud', why: 'E-12 收口轮：读不懂 ⇒ EXIT=2' },
  { needle: '「只写 `https://host[:port]`」在代码接受 http 时必须判红', why: 'E-12 判词（现场句）' },
  { needle: '`http(s)://` 形态必须放行', why: 'E-12 判词（防一刀切）' },
  { needle: '代码改成 https-only 后，文档里的 `http(s)://` 必须跟着红', why: 'E-12 判词双向' },
  { needle: '旧前提（"首次使用需要先下载"）在缺省随包时必须判红', why: '`voice.intro` 前提面判词' },
  { needle: '`!== true` 必须解析成"缺省不随包"', why: '`voice.intro` 真源解析（双向）' },
  { needle: '「安装包约 +230MiB」必须判红', why: 'README 载荷 ≠ 安装包增量' },
  { needle: '英文现文案必须放行', why: 'README 判词反向对照' },
  { needle: '上游 pin `0.1.5` 与 IP `172.28.0.1` 都不得命中', why: 'E-13 正则词界（防误伤）' },
  { needle: '官网版本号允准面必须逐条写明理由', why: 'E-13 允准面理由非空' },
  { needle: 'E-13 的**命中路径必须有牙', why: 'E-13 收口轮：掏空命中投影必须被自检咬住（V-P4 G1）' },
  { needle: '第三方组件版本（`Caddy 2.7.6`）与上游 pin（`0.1.5`）都**不得**命中', why: 'E-13 收紧：第三方版本不误伤（V-P4 T3）' },
  { needle: '允准面必须**按字面量**判', why: 'E-13 收紧：允准面文件里未登记的号照样红（V-P4 T4）' },
  { needle: '裸号正当改写成 `v` 号**不得**触发死条目', why: 'E-13 允准面余量（V-P4 T5 假红）' },
  { needle: '实现多出一个 scheme（`wss`）而文档只写', why: 'E-12 集合相等（收口轮② V-P10P11 的 D6）' },
  { needle: '文档把三个 scheme 都写全时必须放行', why: 'E-12 集合相等的反向对照（防过度收紧）' },
  { needle: '这类散文**不得**判红', why: 'E-13 发布面 token 必须与号**邻接**（收口轮② V-P10P11 的 E10 假红）' },
  { needle: '判红是正当收紧', why: 'E-13 行级语境 + 历史裸号 = 正当收紧，边界逐字钉住（V-P10P11 的 E7）' },
  { needle: '通过行张冠李戴必须被拒', why: '通过行反解断言' },
  { needle: '真 stdout 里的自洽通过行必须被接受', why: '打印路径判据（真 stdout）' },
  { needle: '通过行探测的独立子入口必须存在', why: '探测入口形态（独立入口，不是开关）' },
  { needle: '判据表里必须有 starlightLocalesFrom', why: '真源 6 的解析器存在性' },
  { needle: '花括号不闭合必须返回 undefined', why: '真源 6 fail-loud' },
]
/** `SELFTEST_REQUIRED_CASES` 自身的条数地板（棘轮：拆点名对账必须同时改这里并进 diff）。 */
const SELFTEST_MIN_REQUIRED_CASES = 28

/** 自检：解析器与判据本身的正反用例（防"扫描器悄悄失效 ⇒ 恒绿"）。 */
function selfTest() {  const good = '平台模块表（`PLATFORM_MODULES`，共 2 项：`react`、`react-dom`）与 `scripts/platform-modules.mjs`'
  const bad = '平台模块表（`PLATFORM_MODULES`，共 3 项：`react`、`react-dom`）与 `react-dom/client`'
  const noAnchor = '无关的一行 `react`'
  const cadenceSample = '  initialDelayMs: z.number().step(1).max(X).default(60_000),\n'
    + '  intervalMs: z.number().step(1).max(X).default(6 * 60 * 60 * 1000),'
  const cadence = updateCadenceFrom(cadenceSample)
  const coveredSample = COVERAGE_ITEMS.slice(0, 2)
  /**
   * 下面几条锚判据直接用规则本体（改 id / 删规则 ⇒ 这些用例当场红）。
   *
   * `?? {}` 是**故意的**：判据表被拆掉一条规则时，这些用例必须**具名报红**（"判据表里必须有
   * client-platforms…"），而不是在 `rule.anchor` 上抛 TypeError —— 崩溃也是非零，但
   * `verify-check-workspaces` 的独立自证要求"副本红了**且**被这条判据咬住"（具名），
   * 抛异常会让那条对账变成"红了但咬不住"（第十五轮 R15A-02 的接线口径）。
   */
  const platformRule = NUMBER_CLAIM_RULES.find(rule => rule.id === 'client-platforms')
  const integrationLayersRule = NUMBER_CLAIM_RULES.find(rule => rule.id === 'integration-covered-layers')
  /**
   * 真源 6 的样本（FIX-47 ④e）。用 `typeof` 取解析器：判据表里没有这个名字时**不抛**，
   * 而是落成 `undefined` ⇒ 下面第一条具名报红（与 `platformRule ?? {}` 同一口径）。
   */
  const localeParser = typeof starlightLocalesFrom === 'function' ? starlightLocalesFrom : undefined
  /** `locales:` 在第 5 行、`root` 在第 6 行、`en` 在第 7 行（断言行号用）。 */
  const LOCALE_SAMPLE = [
    'export default defineConfig({',
    "  site: 'https://example.com',",
    '  integrations: [',
    '    starlight({',
    '      locales: {',
    "        root: { label: '简体中文', lang: 'zh-CN' },",
    "        en: { label: 'English', lang: 'en' },",
    '      },',
    '    }),',
    '  ],',
    '})',
  ].join('\n')
  /** 注释里的假锚点 + 字符串里的花括号：都不得影响解析（掩码后才做锚点与配对）。 */
  const LOCALE_SAMPLE_COMMENTED = [
    '// 曾经写过 locales: { fake: { label: "x" } }',
    '/* 块注释里也有一个 locales: { fake2: {} } 与不配对的花括号 { */',
    'export default defineConfig({',
    "  site: 'https://example.com',",
    '  locales: {',
    "    root: { label: 'a' },",
    "    en: { label: 'b' },",
    '  },',
    '})',
  ].join('\n')
  const cases = [
    [platformRule !== undefined && integrationLayersRule !== undefined,
      'selftest: 判据表里必须有 client-platforms 与 integration-covered-layers 两条规则'],
    [modulesFromDocLine(good).modules?.join(',') === 'react,react-dom', 'selftest: 正常列表应解析出 2 项'],
    [modulesFromDocLine(good).declaredCount === 2, 'selftest: 应解析出声明项数 2'],
    [modulesFromDocLine(bad).declaredCount === 3, 'selftest: 应解析出声明项数 3'],
    [modulesFromDocLine(noAnchor).modules === undefined, 'selftest: 非锚点行必须返回 undefined'],
    [/`(dsh-v\d[A-Za-z0-9.+-]*)`/u.exec('pin `dsh-v0.1.5-rc.2`')?.[1] === 'dsh-v0.1.5-rc.2', 'selftest: pin 正则应命中'],
    [!/`(dsh-v\d[A-Za-z0-9.+-]*)`/u.test('上游 0.1.5 起'), 'selftest: 版本泛指不应命中'],
    // 真源 3：KEEP 解析（正常 / 有歧义 / 带缺省展开三种形态）
    [keepVersionsFrom('x\nKEEP=3\ny\n') === 3, 'selftest: 应解析出 KEEP=3'],
    [keepVersionsFrom('KEEP=3\nKEEP=5\n') === undefined, 'selftest: KEEP 赋值不唯一必须 fail-loud（返回 undefined）'],
    [keepVersionsFrom('KEEP=${KEEP:-7}\n') === 7, 'selftest: 应解析出 KEEP=${KEEP:-7}'],
    // 真源 4：整数乘加表达式（不接受任意表达式）
    [integerExpressionValue('6 * 60 * 60 * 1000') === 21_600_000, 'selftest: 应求值 6 * 60 * 60 * 1000'],
    [integerExpressionValue('60_000') === 60_000, 'selftest: 应求值 60_000'],
    [integerExpressionValue('process.exit(0)') === undefined, 'selftest: 非整数乘加表达式必须返回 undefined'],
    [cadence?.initialSeconds === 60 && cadence?.intervalHours === 6, 'selftest: 应解析出 60 秒 / 6 小时'],
    [updateCadenceFrom('const x = 1') === undefined, 'selftest: 缺常量必须返回 undefined'],
    // 真源 5：平台段计数
    [installerPlatformsFrom('{"build":{"mac":{"artifactName":"a"},"win":{"artifactName":"b"},"linux":{"artifactName":"c"}}}')?.length === 3,
      'selftest: 应数出 3 个声明了产物名的平台段'],
    [installerPlatformsFrom('{"build":{"mac":{"artifactName":"a"}}}')?.length === 1, 'selftest: 只声明一个平台时应数出 1'],
    [installerPlatformsFrom('{"build":{}}') === undefined, 'selftest: 没有任何平台段必须返回 undefined'],
    // 数字 token 归一
    [numberFromToken('三') === 3 && numberFromToken('3') === 3 && numberFromToken('three') === 3, 'selftest: 中文/ASCII/英文数词应归一为 3'],
    [numberFromToken('①') === undefined, 'selftest: 不认识的数字形态必须返回 undefined'],
    // 平台正则：版本号尾巴不算平台数
    [/(?<![\d.])([0-9]+|[一二三四五六七八九十两]+)\s*平台/u.exec('### 2.3 平台保留列') === null,
      'selftest: 「2.3 平台」不应被当成平台数 claim'],
    [/(?<![\d.])([0-9]+|[一二三四五六七八九十两]+)\s*平台/u.exec('列出三平台下载入口')?.[1] === '三',
      'selftest: 中文数字平台数应命中'],
    // ---- 上下文锚的**判别力**（第十四轮 E-04 的回归判据）----------------------
    // 断言的是"锚能不能区分"，不是"当前这份文档恰好是绿的"：删掉 `client-platforms`
    // 的 anchor ⇒ 下面第一条立刻红。
    [anchorAccepts(platformRule ?? {}, ['镜像里已含三平台客户端安装包。'], 0),
      'selftest: 「三平台安装包」必须落在 client-platforms 的上下文锚内'],
    [!anchorAccepts(platformRule ?? {}, ['客户端在**同一平台**上运行。'], 0),
      'selftest: 无关的同形句「同一平台」必须被 client-platforms 的锚排除（E-04 的假红现场）'],
    [!anchorAccepts(platformRule ?? {}, ['上一行提到安装包与下载入口', '客户端在**同一平台**上运行。'], 1),
      'selftest: 锚必须在**同一行**（window 0）—— 邻行的「安装包」不得为这一行的无关「N 平台」背书'],
    [!anchorAccepts(platformRule ?? {}, ['单平台、单次运行的实测'], 0),
      'selftest: 「单平台实测」这类不同源的句子必须被锚排除'],
    // ---- 集成守卫层数的真源解析（E-05 的回归判据）----------------------------
    [integrationCoveredLayersFrom('const EXPECTED_COVERED_LAYERS = 14\n') === 14,
      'selftest: 应解析出 EXPECTED_COVERED_LAYERS = 14'],
    [integrationCoveredLayersFrom('const EXPECTED_COVERED_LAYERS = 13\nconst EXPECTED_COVERED_LAYERS = 14\n') === undefined,
      'selftest: EXPECTED_COVERED_LAYERS 赋值不唯一必须 fail-loud（返回 undefined）'],
    [integrationCoveredLayersFrom('const EXPECTED = 14') === undefined,
      'selftest: 形态变了（改名/改成别的写法）必须返回 undefined'],
    [anchorAccepts(integrationLayersRule ?? {}, ['> · 守卫不得声称端到端被覆盖（通过行逐项枚举它真的判了的 14 层）；'], 0),
      'selftest: 「通过行逐项枚举…N 层」必须落在集成层数规则的锚内'],
    [!anchorAccepts(integrationLayersRule ?? {}, ['三层覆盖：单测、verify 脚本、E2E 自动化'], 0),
      'selftest: COVERAGE-MATRIX 的「三层覆盖」是另一件事，必须被锚排除'],
    // ---- 文本 claim 的真源解析 + 判词（2026-10-05 收口轮：E-12 / voice.intro / README 体积）----
    //
    // 每条都钉"解析器/判词本身有没有牙"：真源形态变了必须 fail-loud（返回 undefined），
    // 正反两态各一格（否则"把判词写成恒真"这类掏空会静默通过）。
    ...textClaimSelftestCases(),
    // ---- E-13 判据的**命中路径**（收口轮 P1，V-P4 的 G1：掏空 `hits.push` 曾全绿）----
    ...siteVersionSelftestCases(),
    // 通过行反解断言（自我陈述与覆盖面必须一致）
    [passLineProblems(passLineFor(coveredSample), coveredSample).length === 0, 'selftest: 生成的通过行必须自洽'],
    [passLineProblems('check-doc-claims: 已覆盖 9 项：上游 pin、平台模块表 —— 全部与真源一致 ✅', coveredSample).length > 0,
      'selftest: 通过行的项数与实际不符必须被拒'],
    [passLineProblems(`check-doc-claims: ${RETIRED_PASS_CLAIM}（pin=…）✅`, coveredSample).length > 0,
      'selftest: 无边界的旧措辞必须被拒'],
    [passLineProblems(passLineFor(coveredSample).replace('平台模块表', '别的东西'), coveredSample).length > 0,
      'selftest: 通过行张冠李戴必须被拒'],
    // 打印路径判据（第十三轮 V13-C R-1）：断言必须吃"真 stdout"，且只认最后一行。
    [verdictLineFrom('诊断行\n\n   \ncheck-doc-claims: 已覆盖 2 项：上游 pin、平台模块表 —— 全部与真源一致 ✅\n')
      === passLineFor(coveredSample), 'selftest: 通过行探测应取最后一行非空'],
    [printedVerdictProblems(`${passLineFor(coveredSample)}\n`, coveredSample).length === 0,
      'selftest: 真 stdout 里的自洽通过行必须被接受'],
    [printedVerdictProblems('check-doc-claims: 文档数字与真源一致（覆盖 2 项）✅\n', coveredSample).length > 0,
      'selftest: 打印路径被换成**写死的假自述**（V13-C d6 原形态）必须被拒'],
    [printedVerdictProblems('check-doc-claims: 已覆盖 7 项：上游 pin、平台模块表 —— 全部与真源一致 ✅\n', coveredSample).length > 0,
      'selftest: 打印路径声称的项数与实际不符必须被拒'],
    [printedVerdictProblems(`${passLineFor(coveredSample)}\ncheck-doc-claims: 文档数字与真源一致 ✅\n`, coveredSample).length > 0,
      'selftest: 真行之后再补一句更宽的自述（"像通过行"的行必须恰好 1 行）必须被拒'],
    // ---- 宽自述的位置矩阵（R15A-01 的 C1/C4/C5：修前这三种全 EXIT=0）----------------
    [printedVerdictProblems('check-doc-claims: 全部文档、脚本、CI 配置与渠道包均与真源一致（含 12 类未登记 claim）✅\n'
      + `${passLineFor(coveredSample)}\n`, coveredSample).length > 0,
      'selftest: 宽自述（另措辞、含 ✅）打在真行**之前**必须被拒（R15A-01 的 C4）'],
    [printedVerdictProblems('check-doc-claims: 已覆盖 99 项：上游 pin、平台模块表 ✅\n'
      + `${passLineFor(coveredSample)}\n`, coveredSample).length > 0,
      'selftest: 含 `已覆盖 ` 前缀的伪通过行打在真行**之前**必须被拒（R15A-01 的 C5）'],
    [printedVerdictProblems('check-doc-claims: 文档数字与真源一致（覆盖 2 项）✅\n'
      + `${passLineFor(coveredSample)}\n`, coveredSample).length > 0,
      'selftest: 无边界的旧措辞打在真行**之前**必须被拒（R15A-01 的 C1 在主入口的同一形态）'],
    [printedVerdictProblems('诊断行\n', coveredSample).length > 0,
      'selftest: 没有任何通过凭据被打印出去时必须被拒'],
    // 探测开关的**载体**（2026-09-25）：只看 argv，且**不看环境** —— 环境里出现那个
    // 已废除的名字时本进程早已 exit 2（`refuseRetiredTestSeam`），绝不会被当成"我是子进程"。
    // 通过行探测的**载体**（第十四轮 V14-A 的 VA-02-F2 收口）：**独立入口**，不是一个开关。
    // 三条断言都是行为级的：子入口真的在盘上 / 主入口不自称探测子进程 /
    // `--verdict-probe` 这个旧开关名现在是**未知参数**（exit 2，翻不了绿）。
    [existsSync(fileURLToPath(new URL('./doc-claims-passline-child.mjs', import.meta.url))),
      `selftest: 通过行探测的独立子入口必须存在（${PASS_LINE_CHILD_ENTRY}）`],
    [IS_PASS_LINE_CHILD === false && isEntryModule(),
      'selftest: 主入口下不得自称探测子进程（入口判定必须来自加载器/进程内标记，不是 env/argv）'],
    [spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--verdict-probe'], { encoding: 'utf8' }).status === 2,
      'selftest: `--verdict-probe` 必须是未知参数（exit 2）—— 本入口不再有任何"探测模式"开关'],
    // ---- 真源 6（FIX-47 ④e）：官网 locale 落地页判据的**解析器**正反例 ----------------
    // 断言的是"解析器能不能区分"，不是"当前这份 astro.config.mjs 恰好解析对了"：
    // 把 `locales` 的解析拆掉 ⇒ 下面第一条立刻红（具名）。
    // `localeParser` 用 `typeof` 取（判据表里没有这个名字时**不抛**，而是落成 undefined
    // ⇒ 具名报红，与上面 `platformRule ?? {}` 的口径一致）。
    [localeParser !== undefined,
      'selftest: 判据表里必须有 starlightLocalesFrom（官网 locale 落地页判据的解析器）'],
    [localeParser?.(LOCALE_SAMPLE)?.map(entry => entry.key).join(',') === 'root,en',
      'selftest: 应解析出 locales 的键（root,en，按声明顺序）'],
    [localeParser?.(LOCALE_SAMPLE)?.[1]?.line === 7,
      'selftest: 应解析出 locale 键的**声明行号**（finding 要落在那一行）'],
    [localeParser?.(LOCALE_SAMPLE_COMMENTED)?.map(entry => entry.key).join(',') === 'root,en',
      'selftest: 行注释/块注释里的 `locales:` 与花括号不得被当成真锚点'],
    [localeParser?.('export default { site: "https://example.com" }') === undefined,
      'selftest: 没有 locales 必须返回 undefined（调用方 fail-loud）'],
    [localeParser?.('locales: { root: { label: "a" }, en: { label: "b" }') === undefined,
      'selftest: 花括号不闭合必须返回 undefined（拒绝把残缺形态当解析成功）'],
    [localeParser?.(`${LOCALE_SAMPLE}\n${LOCALE_SAMPLE}`) === undefined,
      'selftest: `locales:` 出现两处（有歧义）必须 fail-loud（返回 undefined）'],
  ]
  const failed = cases.filter(([ok]) => !ok).map(([, name]) => name)
  // ───────────────────────────────────────────────────────────────────────────
  // 自检**自身**的下限与逐条点名对账（收口轮 P1，独立核验 V-P4 的 G3）。
  //
  // 现场：`--selftest` 打印的 `自检 N/N 项通过` 里 N 就是 `cases.length` —— 删掉 21 条用例
  // 之后它照旧打印「自检 54/54 项通过 ✅」（自洽、EXIT=0）。修法照 `check-workflows.mjs`
  // 的两条既有手法：
  //   ① **条数地板**（棘轮，只允许被"变多"越过）：取值 = 当前实测条数；
  //   ② **逐条点名对账**：{@link SELFTEST_REQUIRED_CASES} 里每条 needle 必须在某一格用例的
  //      文案里出现（删掉那一格 ⇒ 具名报红），且该表自身也有条数地板。
  //
  // ⚠️ 这三条失败必须走**不经过 `failed` 数组**的通道（否则"掏空断言"会连自检一起吞掉）：
  // 它们直接追加进 `failed` 之后仍由同一段打印，但**判定自己**也在 `cases` 之外，
  // 所以删用例 / 删 needle 都不可能让它们消失。
  // ───────────────────────────────────────────────────────────────────────────
  const names = cases.map(([, name]) => name)
  if (cases.length < SELFTEST_MIN_CASES) {
    failed.push(`自检用例只剩 ${cases.length} 条，至少要有 ${SELFTEST_MIN_CASES} 条`
      + ' —— 用例表被成批删除（本仓第四轮 R4-A 已登记的形态："回归网自身无下限"）')
  }
  if (SELFTEST_REQUIRED_CASES.length < SELFTEST_MIN_REQUIRED_CASES) {
    failed.push(`定向用例登记表只剩 ${SELFTEST_REQUIRED_CASES.length} 条，`
      + `至少要有 ${SELFTEST_MIN_REQUIRED_CASES} 条 —— 点名对账被拆掉`)
  }
  for (const required of SELFTEST_REQUIRED_CASES) {
    if (names.some(name => name.includes(required.needle))) continue
    failed.push(`定向用例登记表里的「${required.needle}」没有任何用例带着它 ——`
      + ` 那一格样本被删/被改写（${required.why}）`)
  }
  if (failed.length > 0) {
    for (const name of failed) console.error(`  [SELFTEST] ${name}`)
    console.error(`check-doc-claims: 自检 ${failed.length}/${cases.length} 项失败 —— 守卫自身失效`)
    process.exit(1)
  }
  console.log(`check-doc-claims: 自检 ${cases.length}/${cases.length} 项通过 ✅`
    + `（定向用例 ${SELFTEST_REQUIRED_CASES.length} 条逐条点名对账）`)
  process.exit(0)
}

if (selftest) selfTest()

// 测试缝的判据在文件顶部（`refuseRetiredTestSeam()`，随 argv 开关一起迁走了）：
// 这里刻意不留"CI 语境下不得设置"那类已失效的表述 —— 新规则与语境无关。

const failures = []
const hits = []
/**
 * **真源解析失败**（"形态不认识"）的收集面 —— 与 `failures`（扫描面问题，EXIT=1）分开：
 * 读不懂真源 = **前置失败**（EXIT=2，"没判"不是"一致"），与"有漂移"（EXIT=1）区分开。
 *
 * 收口轮（2026-10-05，独立核验 V-P4 的 T10c）：E-12 的真源解析从"字符串前缀"改成结构化
 * scheme 集合之后，"形态不认识"必须有**明确的出口**，而不是回落成"某一边更宽"的假结论。
 * 本数组在打印前并入 `surfaceProblems`（那里是 EXIT=2 的唯一通道）。
 */
const truthProblems = []

/**
 * 真仓形态 = 根上同时有 `upstream.json` 与 `package.json`（既有语义，2026-09-23 缩面判据）。
 * 绝对下限与"硬数字真源必须存在"都只在真仓形态上强制；合成/自证夹具树（`--root` 指到
 * 临时树）没有这些文件属正常，缺项**只影响通过行的项数**（自我陈述照样诚实）。
 */
const strictSurface = existsSync(join(root, 'upstream.json')) && existsSync(join(root, 'package.json'))

// ---- 真源 1：上游 pin ----
const upstreamPath = join(root, 'upstream.json')
if (!existsSync(upstreamPath)) {
  console.error('check-doc-claims: 找不到 upstream.json —— 拒绝把"读不到真源"当通过')
  process.exit(1)
}
const upstream = JSON.parse(readFileSync(upstreamPath, 'utf8'))
if (typeof upstream.sourceVersion !== 'string' || upstream.sourceVersion.length === 0) {
  console.error('check-doc-claims: upstream.json 缺 sourceVersion —— 拒绝把"真源不完整"当通过')
  process.exit(1)
}
const expectedPin = `dsh-v${upstream.sourceVersion}`

// ---- 真源 2：平台模块表 ----
const modulesScript = 'scripts/platform-modules.mjs'
if (!existsSync(join(root, modulesScript))) {
  console.error(`check-doc-claims: 找不到 ${modulesScript} —— 拒绝把"读不到真源"当通过`)
  process.exit(1)
}
const expectedModules = stringArrayFrom(readFileSync(join(root, modulesScript), 'utf8'), 'PLATFORM_MODULES')
if (expectedModules === undefined || expectedModules.length === 0) {
  console.error(`check-doc-claims: 无法从 ${modulesScript} 解析 PLATFORM_MODULES —— 拒绝把"扫不到"当通过`)
  process.exit(1)
}

// ---- 真源 3/4/5：硬数字（R13-GF）。真源是**代码里的量**，不是守卫里的副本 ----
//
// 两种真源形态：`read(source 文本)`（真源是**一个文件**）与 `readRoot(root)`（真源是
// **一批文件/一个目录**，例如 `migrations-pg/` 的文件数 —— 见 `migration-count`）。
const numericRules = NUMBER_CLAIM_RULES.map(rule => ({
  ...rule, truth: undefined, hits: 0, excluded: 0, hitsByFile: new Map(),
}))
for (const rule of numericRules) {
  let value
  if (typeof rule.readRoot === 'function') {
    value = rule.readRoot(root)
  } else {
    const path = join(root, rule.source)
    if (!existsSync(path)) {
      if (strictSurface) {
        failures.push(`${rule.source}: 找不到硬数字真源（${rule.label}）—— 拒绝把"读不到真源"当通过`)
      }
      continue
    }
    value = rule.read(readFileSync(path, 'utf8'))
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    if (typeof rule.readRoot !== 'function' || strictSurface) {
      failures.push(`${rule.source}: 解析不出 ${rule.label} 的真源（该文件的形态变了？）`
        + ' —— 拒绝把"解析失败"当通过，请同步本守卫的解析器')
    }
    continue
  }
  rule.truth = value
}

let scanned = 0
let pinClaims = 0
/** 每个扫描根的实际产出（缩面判据的绝对下限按它判，不是靠"总数看着还行"）。 */
const perScanPath = new Map()
for (const target of SCAN_PATHS) {
  const stats = { files: 0, pinClaims: 0 }
  perScanPath.set(target, stats)
  for (const file of walk(target)) {
    if (RECORD_SURFACES.some(pattern => pattern.test(file))) continue
    scanned += 1
    stats.files += 1
    const lines = readFileSync(join(root, file), 'utf8').split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      if (line.includes(ALLOW_MARKER)) continue
      for (const match of line.matchAll(PIN_CLAIM)) {
        pinClaims += 1
        stats.pinClaims += 1
        if (match[1] !== expectedPin) {
          hits.push({
            kind: 'PIN',
            file,
            line: index + 1,
            reason: `写着 ${match[1]}，实际 pin ${expectedPin}`,
            text: line.trim().slice(0, 200),
          })
        }
      }
      // ---- 禁止写死的条数（FIX-47④d；见 FORBIDDEN_DOC_NUMBERS）----
      for (const rule of FORBIDDEN_DOC_NUMBERS) {
        if (!rule.files.includes(file)) continue
        for (const pattern of rule.patterns) {
          for (const match of line.matchAll(pattern)) {
            rule.hits += 1
            hits.push({
              kind: 'HARD-COUNT',
              file,
              line: index + 1,
              reason: `${rule.label}：文档里不得写死这个数字（真源 = ${rule.truthSource}）—— `
                + '指着真源写（"条数见 …"）即可，写死必然漂',
              text: line.trim().slice(0, 200),
            })
          }
        }
      }
      // ---- 硬数字断言（真源见 NUMBER_CLAIM_RULES）----
      for (const rule of numericRules) {
        if (rule.truth === undefined) continue
        for (const form of rule.forms) {
          if (!anchorAccepts(rule, lines, index)) {
            // 同形但**不同源**的句子（例如保留策略调度器也写「每 6 小时一次」、或
            // "客户端在同一平台上运行"）：排除，但把条数记下来照实打印，不做静默吞掉。
            rule.excluded += [...line.matchAll(form.pattern)].length
            continue
          }
          for (const match of line.matchAll(form.pattern)) {
            rule.hits += 1
            rule.hitsByFile.set(file, (rule.hitsByFile.get(file) ?? 0) + 1)
            const got = numberFromToken(match[1])
            if (got !== rule.truth) {
              hits.push({
                kind: 'NUMBER',
                file,
                line: index + 1,
                reason: `${rule.label}：写着「${match[0].trim()}」`
                  + `${got === undefined ? '（数字无法识别）' : `（${got}）`}，`
                  + `真源是 ${rule.truth}（${rule.source}）`,
                text: line.trim().slice(0, 200),
              })
            }
          }
        }
      }
    }
  }
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 判据 7bis：**文本 claim**（E-12 / `voice.intro` 前提 / README 体积数字）。
 *
 * 与上面"硬数字"那一段同形：先解真源（失败 = fail-loud），再在**逐条登记的落点**上判；
 * `hits` = 命中的断言行数（用于「已覆盖」与 `min` 地板），违规行走全局 `hits`（EXIT=1）。
 * ─────────────────────────────────────────────────────────────────────────────
 */
const textRules = TEXT_CLAIM_RULES.map(rule => ({
  ...rule, truth: undefined, hits: 0, hitsByFile: new Map(),
}))
for (const rule of textRules) {
  const path = join(root, rule.source)
  if (!existsSync(path)) {
    if (strictSurface) {
      failures.push(`${rule.source}: 找不到文本 claim 的真源（${rule.label}）—— 拒绝把"读不到真源"当通过`)
    }
    continue
  }
  const value = rule.read(readFileSync(path, 'utf8'))
  if (value === undefined) {
    truthProblems.push(`${rule.source}: 解析不出 ${rule.label} 的真源（该文件的形态变了？）`
      + ' —— 拒绝把"解析失败"当通过（**前置失败**：读不懂真源就不出结论，'
      + '既不算一致、也不算"某一边更宽"），请同步本守卫的解析器')
    continue
  }
  rule.truth = value
}
for (const rule of textRules) {
  if (rule.truth === undefined) continue
  for (const site of rule.sites) {
    const absolute = join(root, site.file)
    if (!existsSync(absolute)) {
      failures.push(`${site.file}: 文件不存在（${rule.label} 的 claim 定位点：${site.note}）`
        + ' —— 扫描面写错或文档被移动（守卫必须跟着改）')
      continue
    }
    const lines = readFileSync(absolute, 'utf8').split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      if (line.includes(ALLOW_MARKER)) continue
      // `claim()` 与 `judge()` 分开是**刻意**的：命中数（`hits`，用于「已覆盖」与 `min`
      // 地板）必须数"这一行是不是本规则的 claim"，而 `judge()` 返回 null 既可能是
      // "不是 claim"也可能是"是 claim 且合规" —— 两者混用会让地板在合规时归零。
      if (!rule.claim(line, index, rule.truth)) continue
      rule.hits += 1
      rule.hitsByFile.set(site.file, (rule.hitsByFile.get(site.file) ?? 0) + 1)
      const verdict = rule.judge(line, index, { truth: rule.truth, file: site.file, lines })
      if (verdict === null || verdict === undefined) continue
      hits.push({
        kind: 'TEXT',
        file: site.file,
        line: index + 1,
        reason: verdict.reason,
        text: line.trim().slice(0, 200),
      })
    }
  }
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 判据 8：官网源码里**不得硬编码发布版本号**（E-13，2026-10-05 收口轮）。
 *
 * 现场（E-P2-batch §E-13）：`site/src/pages/index.astro` 的部署块写死 `2.7.0` 三处，
 * 而同一段注释自己写着"版本以 latest.json 的 server.version 为准" ⇒ 读者复制即 404，
 * 且**不在任何判据面内**（分区 C 实测：把占位符改回 `2.7.0` 后
 * `check-doc-claims` / `verify-layout` / `check-no-real-domains` 全绿）。
 *
 * 判据面 = `site/src/**` 的 `.md` + `.astro`（排除 `content/blog/**` 这条记录面）：
 * **发布语境**（或本项目发布线）上的裸号，在 {@link SITE_VERSION_ALLOW} 里没登记 ⇒ 红；
 * 允准面按**字面量**登记、**死条目红**、且对"裸号 → `v` 号"的正当改写留余量。
 * 全部口径见 {@link RELEASE_CONTEXT_MARKERS} / {@link SITE_VERSION_ALLOW} 的注释。
 *
 * **抽成函数是为了让 `--selftest` 能在合成站点树上断言"命中路径有牙"**（收口轮 P1：
 * 独立核验 V-P4 的 G1 实测 —— 掏空这段里的 `hits.push` 之后，自检与面判据**全绿**）：
 * 自检直接调它，命中路径一被掏空那条样本当场红。
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * 扫一遍站点源码，返回命中事实（本函数**不**打印、不退出 —— 判定在调用方）。
 *
 * @param scanRoot - 扫描根（真仓 = root；自检 = 合成临时树）。
 * @param options - `{ allowEntries, releaseLinePrefix }`。
 * @returns `{ files, entries, hitCount, allowedHits, deadEntries, unlisted }`：
 *   · `entries` —— 每条命中 `{ file, line, literal, allowed, text }`（`allowed` = 该字面量在允准面里）；
 *   · `hitCount` —— 命中总数（含允准面）；`allowedHits` —— 每个允准文件的命中数；
 *   · `unlisted` —— **允准文件里未登记**的字面量命中（那是判红项，不是豁免）；
 *   · `deadEntries` —— 登记的号在该文件里连"带 v 的写法"都找不到了。
 */
function scanSiteReleaseVersions(scanRoot, { allowEntries = SITE_VERSION_ALLOW, releaseLinePrefix } = {}) {
  const allowByFile = new Map(allowEntries.map(entry => [entry.file, entry]))
  const allowedHits = new Map(allowEntries.map(entry => [entry.file, 0]))
  /** 每个允准文件里"还在被讲"的登记字面量（`v` 前缀也算 —— 正当余量，见 SITE_VERSION_ALLOW）。 */
  const mentioned = new Map(allowEntries.map(entry => [entry.file, new Set()]))
  const entries = []
  let files = 0
  for (const file of walkWithExtensions(scanRoot, SITE_VERSION_SOURCE_ROOT, ['.md', '.astro'])) {
    if (SITE_VERSION_WALK_EXCLUDE.some(pattern => pattern.test(file))) continue
    files += 1
    const text = readFileSync(join(scanRoot, file), 'utf8')
    const allow = allowByFile.get(file)
    const lines = text.split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      if (line.includes(ALLOW_MARKER)) continue
      // 两类语境分开判：**行级**标记与号在哪无关；**发布面 token** 必须紧挨着号（见常量注释）。
      const inReleaseContext = RELEASE_CONTEXT_MARKERS.some(pattern => pattern.test(line))
      RELEASE_VERSION_LITERAL.lastIndex = 0
      for (const match of line.matchAll(RELEASE_VERSION_LITERAL)) {
        const literal = match[0]
        const onReleaseToken = RELEASE_NUMBER_AFFIXES
          .some(pattern => pattern.test(releaseTokenAround(line, match.index, literal.length)))
        const onProjectLine = releaseLinePrefix !== undefined && literal.startsWith(releaseLinePrefix)
        if (!inReleaseContext && !onReleaseToken && !onProjectLine) continue
        entries.push({
          file,
          line: index + 1,
          literal,
          // 允准面按**字面量**判：登记了 `2.7.0` 不等于"这个文件里写什么都行"。
          allowed: allow !== undefined && allow.literals.includes(literal),
          text: line.trim().slice(0, 200),
        })
        if (allow !== undefined && allow.literals.includes(literal)) {
          allowedHits.set(file, (allowedHits.get(file) ?? 0) + 1)
        }
      }
    }
    if (allow !== undefined) {
      for (const literal of allow.literals) {
        // `v` 前缀也算"还在讲这个号" ⇒ 把裸号正当改写成 `v` 号不会让豁免变死条目（余量）。
        // 词界与 `RELEASE_VERSION_LITERAL` 同源（`(?<![\w.])` / `(?![\w.])`）——
        // 否则 `12.7.0` / `x2.7.0` 这类**别的号**会替这条豁免"续命"（那是假活）。
        const escaped = literal.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
        const pattern = new RegExp(`(?<![\\w.])v?${escaped}(?![\\w.])`, 'u')
        if (pattern.test(text)) mentioned.get(file).add(literal)
      }
    }
  }
  const deadEntries = allowEntries.filter(entry => (mentioned.get(entry.file)?.size ?? 0) === 0)
  const unlisted = entries.filter(entry => !entry.allowed
    && allowByFile.has(entry.file))
  return { files, entries, hitCount: entries.length, allowedHits, deadEntries, unlisted }
}

const projectVersionPath = join(root, PROJECT_VERSION_SOURCE)
const siteVersionScan = scanSiteReleaseVersions(root, {
  releaseLinePrefix: existsSync(projectVersionPath)
    ? projectReleaseLinePrefix(readFileSync(projectVersionPath, 'utf8'))
    : undefined,
})
const siteVersionFiles = siteVersionScan.files
/** 命中的版本字面量**总数**（含允准面）—— 「已覆盖」与地板按它算。 */
const siteVersionHits = siteVersionScan.hitCount
const siteVersionAllowedHits = siteVersionScan.allowedHits
/**
 * E-13 的命中 → **报告对象**（唯一投影点；收口轮把 `hits.push` 的载荷搬进函数里，
 * 让 `--selftest` 能在合成树上**功能性**地断言"这条路径真的产出命中"）。
 *
 * 为什么必须抽出来（V-P4 的 G1）：修前 `hits.push({kind:'SITE-VERSION'…})` 是主路径里的
 * 内联代码 —— 自检一格都不走它 ⇒ 把 `hits.push` 掏空（计数仍在）之后，自检与面判据全绿，
 * 站点写回 `2.9.9` 不再被咬。现在投影在本函数里（自检直接调它断言产出），
 * 主路径的接线另有**源码级 needle** 盯着（见 `siteVersionSelftestCases` 的最后两格）。
 *
 * @param scan - {@link scanSiteReleaseVersions} 的结果。
 * @returns `hits` 通道的报告对象数组。
 */
function siteVersionHitReports(scan) {
  return scan.entries.filter(entry => !entry.allowed).map(entry => {
    const unlistedInAllowFile = scan.unlisted.includes(entry)
    return {
      kind: 'SITE-VERSION',
      file: entry.file,
      line: entry.line,
      reason: `官网源码里硬编码了发布版本号 \`${entry.literal}\`（真源是发布时的 `
        + '`release.picoaide.com/<渠道>/latest.json` 的 `server.version`）\n'
        + '          ⇒ 读者复制这段命令就会拿到已下架的版本（E-13 的现场）。'
        + '修法：换成站内既有占位符（zh `<版本>` / en `<version>`）；'
        + '**历史版本引用**写成 `v` 号（本仓既有约定，全站 28 处如此）；'
        + `确属记录面（讲"当时"的版本、且改不得）请加行内 \`${ALLOW_MARKER}\` 标记。`
        + (unlistedInAllowFile
          ? '\n          ⚠️ 这个文件在允准面里，但允准面**按字面量**登记：'
            + `登记的只有 ${JSON.stringify(SITE_VERSION_ALLOW.find(item => item.file === entry.file)?.literals ?? [])}，`
            + '未登记的号照样红（修前是"整文件豁免"，往里面塞任何版本号都不可见）。'
          : ''),
      text: entry.text,
    }
  })
}

hits.push(...siteVersionHitReports(siteVersionScan))

/** 模块表断言：两篇插件开发页（中英）各一行。 */
const moduleHits = []
/** 真正**判过**的模块表行数（通过行的覆盖面按它算，不是按"文件在不在"）。 */
let moduleClaims = 0
for (const file of MODULE_DOCS) {
  const absolute = join(root, file)
  if (!existsSync(absolute)) {
    failures.push(`${file}: 文件不存在 —— 扫描面写错或文档被移动（守卫必须跟着改）`)
    continue
  }
  const lines = readFileSync(absolute, 'utf8').split('\n')
  const anchor = lines.findIndex(line => line.includes('PLATFORM_MODULES') && !line.includes(ALLOW_MARKER))
  if (anchor === -1) {
    failures.push(`${file}: 找不到提到 PLATFORM_MODULES 的正文行 —— 守卫的锚点失效，请同步本脚本`)
    continue
  }
  const { modules, declaredCount } = modulesFromDocLine(lines[anchor])
  if (modules === undefined || modules.length === 0) {
    failures.push(`${file}:${anchor + 1}: 锚点行没有解析出任何模块名（反引号列表被改写？）`)
    continue
  }
  const missing = expectedModules.filter(value => !modules.includes(value))
  const extra = modules.filter(value => !expectedModules.includes(value))
  moduleClaims += 1
  if (missing.length > 0 || extra.length > 0) {
    moduleHits.push({
      file,
      line: anchor + 1,
      reason: `文档列 ${modules.length} 项（真源 ${expectedModules.length} 项）`
        + `${missing.length > 0 ? `；缺少 ${missing.join(', ')}` : ''}`
        + `${extra.length > 0 ? `；多出 ${extra.join(', ')}` : ''}`,
      text: lines[anchor].trim().slice(0, 200),
    })
  }
  if (declaredCount !== undefined && declaredCount !== expectedModules.length) {
    moduleHits.push({
      file,
      line: anchor + 1,
      reason: `文档写「${declaredCount} 项」，真源是 ${expectedModules.length} 项`,
      text: lines[anchor].trim().slice(0, 200),
    })
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 判据 7：官网每个 locale 的**落地页源文件**必须存在（第三十二轮 FIX-47 ④e）
//
// 判据面：`ASTRO_CONFIG_SOURCE`（唯一真源）里 `locales` 的每个非 `root` 键 `<loc>`，
// 必须有 `site/src/pages/<loc>/index.astro`（存在才**可能**产出 `/<loc>/`）。
//
// 为什么缺它 = 真缺陷（现场见 `ASTRO_CONFIG_SOURCE` 的注释）：Starlight 给**每一页**渲染的
// 页头站点标题 logo 都链到 `/<locale>/`，缺落地页 ⇒ 该 locale **全部**页面带死链，
// `astro build` 零报告，源码面探针（扫 `](/…)`）也看不见（那是生成型链接）。
//
// 通道选择（照本文件既有口径）：这是一条**真实缺陷的 finding**（有确切落点 file:line），
// 走 `hits` —— 与 `PIN` / `NUMBER` / `MODULES` 同一打印与退出码通道（主入口与独立子入口
// 都按 `hits.length > 0` 判 exit 1）。"解析不出真源"才是 `failures`（同真源 1/2 的口径）。
//
// 覆盖面口径（认账）：本判据**不登记**进 `COVERAGE_ITEMS` —— 登记要同时改
// `passLineProblems` 的对齐断言与 `strictSurface` 的"每项都产出过断言"那一段（三处），
// 超出"只加这一条判据"的授权。影响面是**声明的范围窄于判据**（绿时通过行不声称它），
// 而不是声称了没判过的东西 —— 安全方向；红了照走 `hits` 通道 exit 1。
// ─────────────────────────────────────────────────────────────────────────────
const astroConfigPath = join(root, ASTRO_CONFIG_SOURCE)
if (!existsSync(astroConfigPath)) {
  // 自证/合成夹具树（`--root` 指到临时树）没有官网配置属正常 —— 那里根本不该红。
  // **真仓形态**缺它则是"判据的真源没了"（同 `upstream.json` / `platform-modules.mjs` 的口径）。
  if (strictSurface) {
    failures.push(`${ASTRO_CONFIG_SOURCE}: 找不到官网配置 —— locale 清单的唯一真源就是它`
      + '（另抄一份必然漂移），拒绝把"读不到真源"当通过')
  }
} else {
  const astroConfigSource = readFileSync(astroConfigPath, 'utf8')
  const astroConfigLines = astroConfigSource.split('\n')
  const locales = starlightLocalesFrom(astroConfigSource)
  if (locales === undefined) {
    failures.push(`${ASTRO_CONFIG_SOURCE}: 解析不出 starlight 的 locales —— 拒绝把"解析失败"当通过`
      + '（请修回 `locales: { … }` 形态，或同步本守卫的解析器；本守卫**不**回落默认 locale 清单）')
  } else {
    for (const locale of locales) {
      // `root` 是 Starlight 的缺省 locale 键：它的落地页是自定义首页 `src/pages/index.astro`，
      // 不在本判据面内（缺了它整站首页都没了，那是产物面判据抓得到的另一种形态）。
      if (locale.key === 'root') continue
      const landing = `site/src/pages/${locale.key}/index.astro`
      if (existsSync(join(root, landing))) continue
      const declared = astroConfigLines[locale.line - 1] ?? ''
      hits.push({
        kind: 'SITE-LOCALE',
        file: ASTRO_CONFIG_SOURCE,
        line: locale.line,
        reason: `声明了 locale \`${locale.key}\`，却没有落地页源文件 ${landing} ——`
          + ` Starlight 给**每一页**渲染的页头站点标题 logo（「回首页」）都链到 \`/${locale.key}/\`，`
          + `缺这个文件 ⇒ 该 locale 的**全部**页面都会出现死链（本次缺陷：英文站 17 页全是 \`-> /en\`），`
          + '而 `astro build` 对这类**生成型**链接**零报告**（Astro/Starlight 默认不做链接完整性检查）。'
          + ` 修法：新增 ${landing}（真实可用的落地页，不是占位页）。`
          + ' 产物面（链接是否真的落盘）由 scripts/check-site-links.mjs 判定 —— 它要跑 astro build，'
          + '而 site/ 不是 root yarn workspace，CI 的 gate job 里没有 site/node_modules。',
        text: declared.trim().slice(0, 200),
      })
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 通过行（自我陈述）—— R13-GF 的第二条修法：**✅ 行的口径必须等于真实覆盖面**。
// 「覆盖了」= 本轮真的拿真源比过至少一条 claim（不是"登记表里写了"）。数量与标签都
// 由登记表生成，打印前再反解断言一遍；真仓形态下另要求"判过的项数 == 登记项数"。
// ─────────────────────────────────────────────────────────────────────────────
const declaredCoverageIds = COVERAGE_ITEMS.map(item => item.id)
const judgedCoverageIds = [
  'pin', 'platform-modules',
  ...NUMBER_CLAIM_RULES.map(rule => rule.id),
  ...TEXT_CLAIM_RULES.map(rule => rule.id),
  SITE_VERSION_RULE.id,
]
if (declaredCoverageIds.join(' | ') !== judgedCoverageIds.join(' | ')) {
  failures.push(`通过行登记表（COVERAGE_ITEMS）与判据面不对齐：`
    + `[${declaredCoverageIds.join(', ')}] vs [${judgedCoverageIds.join(', ')}]`
    + ' —— 新增/删除判据必须同步登记表，否则通过行的项数会说谎')
}
const coveredItems = []
/** 取登记项；登记表里缺这一项时**不抛** —— 让上面那条"不对齐"断言给出可读的诊断。 */
const coverItem = id => {
  const item = COVERAGE_ITEMS.find(entry => entry.id === id)
  if (item !== undefined) coveredItems.push(item)
}
if (pinClaims > 0) coverItem('pin')
if (moduleClaims > 0) coverItem('platform-modules')
for (const rule of NUMBER_CLAIM_RULES) {
  const state = numericRules.find(entry => entry.id === rule.id)
  if (state.truth !== undefined && state.hits > 0) coverItem(rule.id)
}
// 文本 claim（E-12 / `voice.intro` / README 体积数字）：判过 ≥1 条断言行才算覆盖。
for (const rule of TEXT_CLAIM_RULES) {
  const state = textRules.find(entry => entry.id === rule.id)
  if (state.truth !== undefined && state.hits > 0) coverItem(rule.id)
}
// 官网版本号（E-13）：扫到 ≥1 处版本字面量才算"这条判据真的在判东西"
// （一处都没有时下面的"死条目"与地板会另外报出来，不靠「已覆盖」兜）。
if (siteVersionHits > 0) coverItem(SITE_VERSION_RULE.id)
const summaryLine = passLineFor(coveredItems)
for (const message of passLineProblems(summaryLine, coveredItems)) {
  failures.push(`通过行自证失败：${message}`)
}

/**
 * ✅ 行的**唯一出口**：必须在**打印这条路径上**被反解断言（第十三轮 V13-C R-1 的收口）。
 *
 * 三层，缺一不可：
 *   ① 进程内先按变量断言一遍（与覆盖率汇总处同一份 `passLineProblems`）；
 *   ② **跑一次真脚本、读真输出**：spawn **独立子入口** {@link PASS_LINE_CHILD_ENTRY}
 *      （它 import 本模块、跑同一份判据，只把通过行打出去 —— 见文件头），
 *      把它 stdout 里**最后一行非空**抓回来 —— 那是"真实运行会打出去的通过行"。
 *      这是唯一能咬住"改打印不改断言"的层：断言钉的是子进程真正写出的字节，不是变量。
 *   ③ 本进程打出去的那一段字节同样被拦截并反解断言（打印与断言是同一个字符串）。
 *
 * 自己的 stdout 用 `process.stdout.write` 拦截（`console.log` 最终走的就是它）——
 * 于是"断言过的"与"打出去的"是同一段字节，而不是各写一份。
 */
function printVerdict() {
  // ① 变量层（同一份实现被调用两次；②③ 才是真正的打印路径判据）。
  const problems = passLineProblems(summaryLine, coveredItems)
  if (problems.length > 0) {
    for (const message of problems) console.error(`  [PASS-LINE] ${message}`)
    console.error('check-doc-claims: 通过行与真实覆盖面不一致 —— 拒绝打印"一致 ✅"')
    process.exit(1)
  }

  // ② 真脚本、真 stdout：**独立子入口**这次运行真的打出去的是哪一行？
  //
  // 子进程按**路径**拉起（不是"本文件 + 一个开关"）：argv 与 env 都是外部输入面
  // （`NODE_OPTIONS=--import=<载荷>` 能在主模块求值前改写 `process.argv`），把探测做成
  // 同一入口上的开关 ⇒ 伪造开关就能跳过这一层（第十四轮 V14A 的 VA-02-F2 实测）。
  // 参数只透传 `--root`：子入口的其他参数一律 exit 2（见它自己的参数解析）。
  // `env` 只原样继承（子进程要在同一语境下复算：`CI=true` 时也必须能起来）。
  const probe = spawnSync(process.execPath, [childEntryPath, ...rootArgsForChild()], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env },
  })
  if (probe.error !== undefined) {
    console.error(`check-doc-claims: 无法跑通过行探测子进程（${probe.error.message}）`
      + ' —— 不把"探测跑不起来"当通过')
    process.exit(1)
  }
  if (probe.status !== 0) {
    // ⚠️ 这里曾经是**坏的模板串拼接**（模板串没断，`'` + 换行 + `+ '` 被当成字面文本打进日志，
    // 于是真实 stderr 被淹在乱码里）—— 报错文案本身不可读，正是本次 CI 排查的障碍之一。
    console.error(`check-doc-claims: 通过行探测子进程 exit ${probe.status}（同一份实现、同一棵树，`
      + `本应同为通过）—— 拒绝出结论：${String(probe.stderr ?? '').trim().slice(-300)}`)
    process.exit(1)
  }
  const captured = verdictLineFrom(probe.stdout ?? '')
  const capturedProblems = printedVerdictProblems(probe.stdout ?? '', coveredItems)
  if (capturedProblems.length > 0) {
    for (const message of capturedProblems) console.error(`  [PASS-LINE] ${message}`)
    console.error('check-doc-claims: **真实 stdout 里打出去的那一行**过不了通过行断言 —— '
      + '这正是"改打印不改断言"的形态（第十三轮 V13-C R-1 的探针 d6）：'
      + '断言必须钉在打印路径上，不是钉在变量上。')
    process.exit(1)
  }

  // ③ 打印，并把"打出去的那一段字节"抓回来再反解一次 —— 断言与打印必须是同一个字符串。
  const original = process.stdout.write
  // **累积全部 stdout 字节**（R15A-01）：修前只留"最后一次 write"，于是在真行**之前**
  // 多打的任何一行都看不见 —— 连含 `PASS_LINE_PREFIX` 的伪通过行也照旧 EXIT=0（C5）。
  let emitted = ''
  process.stdout.write = (chunk, ...rest) => {
    emitted += String(chunk)
    return original.call(process.stdout, chunk, ...rest)
  }
  try {
    console.log(captured)
  } finally {
    process.stdout.write = original
  }
  const emittedProblems = printedVerdictProblems(emitted, coveredItems)
  if (emittedProblems.length > 0) {
    for (const message of emittedProblems) console.error(`  [PASS-LINE] ${message}`)
    console.error('check-doc-claims: 本进程**实际写出去**的通过行过不了断言 —— 拒绝以"一致 ✅"收尾')
    process.exit(1)
  }
}

// 最低扫描量：空扫描/扫描面失效必须红（本仓守卫的既定纪律）。
if (scanned === 0) failures.push('扫描到 0 个 md 文件 —— 扫描面失效，拒绝把"扫不到"当通过')
if (pinClaims === 0) failures.push(`扫描到 0 条 \`${expectedPin}\` pin 断言 —— 断言面失效（官网 FAQ/理念页至少应各有一条）`)

// ─────────────────────────────────────────────────────────────────────────────
// 缩面判据（R4-A-4）：扫描面被改窄**必须 fail-loud**，不能靠"总数看起来还行"。
// 三条判据互相独立（任一缺项即退出码 2）：① 登记清单全覆盖（代码级，与树无关）；
// ② "判什么"⊆"扫什么"（守卫直接读的 MODULE_DOCS 必须在扫描面内）；③ 树里存在的
// 用户可见文档真源必须在扫描面内。绝对下限只在**真仓形态的根**上强制：
// 自证/合成树夹具（没有 upstream.json + package.json）只需非空即可。
// ─────────────────────────────────────────────────────────────────────────────
const surfaceProblems = []

// 真源解析失败（"形态不认识"）在**任何形态的根**上都算前置失败（EXIT=2）：
// 它既不是"扫描面缩水"、也不是"有漂移"，而是"这条判据本轮根本没判" —— 见 `truthProblems`。
surfaceProblems.push(...truthProblems)

for (const required of REQUIRED_SCAN_PATHS) {
  if (!SCAN_PATHS.includes(required)) {
    surfaceProblems.push(`SCAN_PATHS 缺少登记项 ${required}（REQUIRED_SCAN_PATHS）—— 判据静默缩水，拒绝出结论`)
  }
}
for (const file of MODULE_DOCS) {
  const covered = SCAN_PATHS.some(target => file === target || file.startsWith(`${target}/`))
  if (!covered) {
    surfaceProblems.push(`守卫直接读取的 ${file} 不在 SCAN_PATHS 内 —— "判什么"与"扫什么"脱节`
      + `（当前扫描面：${SCAN_PATHS.join('、')}）`)
  }
}
for (const derived of DERIVED_SCAN_ROOTS) {
  if (existsSync(join(root, derived)) && !SCAN_PATHS.includes(derived)) {
    surfaceProblems.push(`仓库里存在 ${derived}（用户可见文档真源）却不在 SCAN_PATHS 内 ——`
      + ' 同一处数字漂移会在别处被拦住、在官网上照旧发布（2026-09-23 D-4/D-6 的形态）')
  }
}
if (strictSurface) {
  for (const target of SCAN_PATHS) {
    if (!existsSync(join(root, target))) surfaceProblems.push(`扫描根不存在：${target}（真仓扫描面必须完整）`)
  }
  for (const [target, minimum] of Object.entries(SCAN_PATH_MIN_FILES)) {
    const got = perScanPath.get(target)?.files ?? 0
    if (got < minimum) {
      surfaceProblems.push(`扫描根 ${target} 只产出 ${got} 个 md（下限 ${minimum}）——`
        + ' 根还在但内容被搬走/排除规则把文件吃空（下限只允许被"变多"越过）')
    }
  }
  if (scanned < MIN_SCANNED_FILES) {
    surfaceProblems.push(`全仓扫描面只剩 ${scanned} 个 md（下限 ${MIN_SCANNED_FILES}）——扫描面被静默缩窄`)
  }
  if (pinClaims < MIN_PIN_CLAIMS) {
    surfaceProblems.push(`全仓只剩 ${pinClaims} 条 \`${expectedPin}\` pin 断言（下限 ${MIN_PIN_CLAIMS}）——判据素材被摘掉`)
  }
  for (const [target, minimum] of Object.entries(MIN_PIN_CLAIMS_BY_PATH)) {
    const got = perScanPath.get(target)?.pinClaims ?? 0
    if (got < minimum) {
      surfaceProblems.push(`扫描根 ${target} 只贡献 ${got} 条 pin 断言（下限 ${minimum}）——`
        + ' 漂移最可能住的根已经从判据里消失，剩下来的"一致 ✅"是空话')
    }
  }
  // 硬数字素材下限（每条规则各自的下限）：真源还在、但文档侧素材被摘空 ⇒ 这条判据
  // 其实已经不再判任何东西，通过行不得把它算进"已覆盖 N 项"。
  for (const rule of numericRules) {
    if (rule.truth === undefined) continue
    if (rule.hits < rule.min) {
      surfaceProblems.push(`${rule.label}：全仓只命中 ${rule.hits} 条断言（下限 ${rule.min}）——`
        + ' 判据素材被摘掉/规则正则失效，这条"已覆盖"是空话')
    }
    // claim **定位点**（E-04）：`min` 只保证"这类短语还剩 N 条"，定位不了"该判的那句话"。
    // 列进 `required` 的文件必须至少有 1 条**锚内**命中 —— 删掉/改写成别的语境 ⇒ 红。
    for (const required of rule.required ?? []) {
      if (ruleHitsInFile(rule, required.file) === 0) {
        surfaceProblems.push(`${rule.label}：${required.file}（${required.note}）里一条锚内声明都没有 ——`
          + ' 这条 claim 已经**不可定位**（被删 / 被改写成别的语境 / 锚不再命中）。'
          + ` 该文件必须仍然明写这条数字（真源 ${rule.source}），或者把 \`required\` 定位点改到`
          + '新的落点并说明理由（改定位点要进 diff）。')
      }
    }
  }
  // 文本 claim 素材下限 + 定位点（E-12 / `voice.intro` / README 体积数字）：
  // 与上面硬数字同一套对账 —— 真源还在、但落点被删/改写 ⇒ 这条"已覆盖"是空话。
  for (const rule of textRules) {
    if (rule.truth === undefined) continue
    if (rule.hits < rule.min) {
      surfaceProblems.push(`${rule.label}：全仓只命中 ${rule.hits} 条断言（下限 ${rule.min}）——`
        + ' 判据素材被摘掉/规则判据失效，这条"已覆盖"是空话')
    }
    for (const site of rule.sites) {
      if (ruleHitsInFile(rule, site.file) > 0) continue
      surfaceProblems.push(`${rule.label}：${site.file}（${site.note}）里一条 claim 都没有 ——`
        + ' 这条 claim 已经**不可定位**（被删 / 被改写 / 字段名换了）。'
        + ` 该文件必须仍然明写这条 claim（真源 ${rule.source}），或把 \`sites\` 定位点改到`
        + '新的落点并说明理由（改定位点要进 diff）。')
    }
  }
  // 官网版本号判据（E-13）：三个方向 —— 扫描面够不够、判据素材在不在、允准面是不是死条目。
  if (siteVersionFiles < SITE_VERSION_MIN_FILES) {
    surfaceProblems.push(`官网版本号判据只扫到 ${siteVersionFiles} 个 .md/.astro（下限 `
      + `${SITE_VERSION_MIN_FILES}）—— 扫描面被搬空/排除规则吃空（下限只允许被"变多"越过）`)
  }
  if (siteVersionHits === 0) {
    surfaceProblems.push('官网源码里一处发布版本号字面量都没有 —— 该判据的"素材"整个消失'
      + '（文件被移走/正则失效）。要么把扫描面修回来，要么解释这条判据还在判什么。')
  }
  for (const entry of siteVersionScan.deadEntries) {
    surfaceProblems.push(`官网版本号允准面的**死条目**：${entry.file} 里已经找不到 `
      + `${entry.literals.map(literal => `\`${literal}\``).join('、')} 了（连 \`v\` 前缀的写法都没有）——`
      + ` 请把这条登记删掉（理由：${entry.why}）`
      + '。豁免必须逐条登记且随事实收缩，否则它会腐化成"整个文件随便写版本号"。'
      + '（注：把裸号正当改写成 `v` 号**不会**触发本条 —— 判据接受 `v?` 前缀，余量是有意的。）')
  }
  if (coveredItems.length !== COVERAGE_ITEMS.length) {
    const missing = COVERAGE_ITEMS.filter(item => !coveredItems.includes(item)).map(item => item.label)
    surfaceProblems.push(`真仓形态下只有 ${coveredItems.length}/${COVERAGE_ITEMS.length} 项产出了断言`
      + `（缺：${missing.join('、')}）—— 通过行的「已覆盖 N 项」不得声称没判过的项`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 打印 + 出结论：**只有主入口**做这一段（第十四轮 V14-A 的 VA-02-F2 收口）。
//
// 独立子入口（`scripts/doc-claims-passline-child.mjs`）import 本模块时：
//   · 上面的**判据本体**（扫描 / 断言 / 缩面判据 / 通过行自证）已经跑完，结果挂在导出面上；
//   · 这一段（打印诊断 + 出结论 + 打印通过行）**不跑** —— 由子入口按导出面自己出结论。
// 入口判定用 `import.meta.main`（Node 的**加载器**给的，argv 改不动）；旧 Node 退回
// 独立子入口在 import 之前设置的**进程内标记**（同样不是 env/argv 通道）。
// **不确定时默认"我是主入口"**：多跑判据是 fail-closed，跳过这一段才是漏洞。
// ─────────────────────────────────────────────────────────────────────────────
if (isEntryModule()) {
  if (json) {
    console.log(JSON.stringify({
      root, expectedPin, expectedModules, scanned, pinClaims, moduleClaims,
      numericRules: numericRules.map(rule => ({
        id: rule.id, label: rule.label, source: rule.source,
        truth: rule.truth ?? null, hits: rule.hits, excluded: rule.excluded, min: rule.min,
      })),
      coverage: { declared: COVERAGE_ITEMS.map(item => item.label), judged: coveredItems.map(item => item.label), passLine: summaryLine },
      perScanPath: Object.fromEntries(perScanPath), hits, moduleHits, failures, surfaceProblems,
    }, null, 2))
  } else {
    console.log(`check-doc-claims: 上游 pin ${expectedPin}；平台模块表 ${expectedModules.length} 项；扫描 ${scanned} 个 md / ${pinClaims} 条 pin 断言`)
    console.log(`  扫描面：${SCAN_PATHS.map(target => `${target} ${perScanPath.get(target)?.files ?? 0}`
      + `(pin ${perScanPath.get(target)?.pinClaims ?? 0})`).join(' / ')}${strictSurface ? '' : '（夹具树：只查非空，不查绝对下限）'}`)
    const truthLines = numericRules.filter(rule => rule.truth !== undefined)
      .map(rule => `${rule.label} ${rule.truth}（${rule.source}）`)
    console.log(`  数字真源：${truthLines.length > 0 ? truthLines.join('；') : '（夹具树：无硬数字真源，对应项不计入覆盖面）'}`)
    console.log(`  禁止写死的条数：${FORBIDDEN_DOC_NUMBERS.map(rule => `${rule.label} ${rule.hits} 处`).join(' / ')}`)
    console.log(`  数字断言：${numericRules.map(rule => `${rule.label} ${rule.hits} 条`).join(' / ')}`
      + `${numericRules.some(rule => rule.excluded > 0)
        ? `（另有 ${numericRules.map(rule => rule.excluded).reduce((a, b) => a + b, 0)} 条同形语句因上下文锚不符被排除，不计入本项）` : ''}`)
  }

  for (const hit of [...hits, ...moduleHits]) {
    console.error(`  [${hit.kind ?? 'MODULES'}] ${hit.file}:${hit.line}: ${hit.reason}`)
    console.error(`          ${hit.text}`)
  }
  for (const message of failures) console.error(`  [SCAN] ${message}`)

  // 扫描面缩水 = **前置失败**：此时"一致 ✅"是一个没被检查过的结论，退出码 2 与
  // "有漂移"（1）区分开（与 check-authoring-claims 的 0/1/2 同款语义）。
  if (surfaceProblems.length > 0) {
    for (const message of surfaceProblems) console.error(`  [SURFACE] ${message}`)
    console.error(`\ncheck-doc-claims: 扫描面缩水/前置缺失 ${surfaceProblems.length} 处 —— 拒绝把"没扫到"当"一致"。\n`
      + '  修法：把被删的扫描根加回 SCAN_PATHS（要真的收窄口径，必须同时改 REQUIRED_SCAN_PATHS 并进 diff）；'
      + '夹具树请只放被扫文档，绝对值下限只在真仓形态的根上强制。')
    process.exit(2)
  }

  if (hits.length > 0 || moduleHits.length > 0 || failures.length > 0) {
    console.error(`\n文档数字漂移 ${hits.length + moduleHits.length} 处 / 扫描器问题 ${failures.length} 处。`
      + '修法：把文档里的数字改成真源值（上游 pin 见 `upstream.json`，平台模块表见 '
      + '`scripts/platform-modules.mjs`，硬数字的真源见上面每条断言里点名的文件）；'
      + '若该行是**记录当时事实**的历史文档，'
      + `请加行内标记 \`${ALLOW_MARKER}\`（不要改扫描面）。`)
    process.exit(1)
  }

  // 通过行由登记表生成、且刚刚被 `passLineProblems` 反解断言过（数量 + 逐条标签）——
  // 它只声称本轮**真的判过**的项。`--json` 模式只出 JSON（否则那份输出不是合法 JSON）。
  //
  // 探测子进程走的是**独立入口**（`scripts/doc-claims-passline-child.mjs`，见文件头）：
  // 它 import 本模块拿的是同一份判据的导出面，本入口上**没有任何探测开关**可伪造。
  if (!json) {
    printVerdict()
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 导出面（**只有**通过行探测的独立子入口用）。
//
// 判据本体在上面已经跑完（import 本模块即执行），这里交出去的是**它的结果**：
// 子入口只允许"干净 ⇒ 打印通过行 / 有问题 ⇒ 按同样的退出码拒绝"，不得用它重新实现判据。
// `summaryLine` 就是主入口打印路径上那一行的生成结果（`passLineFor(coveredItems)`）。
// ─────────────────────────────────────────────────────────────────────────────
export { coveredItems, summaryLine, failures, hits, moduleHits, surfaceProblems, scanned, pinClaims }
