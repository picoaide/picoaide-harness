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
 * 退出码：0 = 全部一致；1 = 有漂移；2 = 用法错误 / **扫描面缩水（前置失败，见下）**。
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

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

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

/** 扫描面（与 check-migration-range.mjs 同形：文档 + 官网 wiki + 包内 README）。 */
const SCAN_PATHS = ['server/docs', 'server/AGENTS.md', 'AGENTS.md', 'docs', 'site/src/content/docs', 'packages', 'README.md', 'README.en.md']
/**
 * 缩面判据①（登记值）：`SCAN_PATHS` 必须**全覆盖**这份登记清单 —— 删掉任一项
 * （例如把 `site/src/content/docs` 去掉）都让"官方文档数字都有判据"变成假话，
 * 而"根不存在/扫描面为 0"这类存在性判据抓不到这种删法（目录还在，只是没人扫）。
 * 改扫描面必须同时改这里（进 diff、可评审），不是悄悄少扫一片。
 */
const REQUIRED_SCAN_PATHS = ['server/docs', 'server/AGENTS.md', 'AGENTS.md', 'docs', 'site/src/content/docs', 'packages', 'README.md', 'README.en.md']
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
 * 硬数字判据表（每条 = **一份代码真源** + 一组文档形态 + 一个下限）。
 *
 * `truth` 由 {@link resolveNumericRules} 从真源解析后填入；`forms[].pattern` 的第 1 个
 * 捕获组就是数字 token；`anchor` 是可选上下文锚（在该行 ±`window` 行内匹配，用于把
 * 同形但不同源的句子排除掉）；`min` 是**真仓形态**下必须命中的条数下限（素材被摘空
 * ⇒ EXIT=2，不是静默通过）。
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
    min: 20,
    forms: [
      // `(?<![\d.])`：排除「2.3 平台」这种被版本号尾巴带出来的假命中。
      { pattern: /(?<![\d.])([0-9]+|[一二三四五六七八九十两]+)\s*平台/gu },
      { pattern: /\b([0-9]+|one|two|three|four|five|six|seven|eight|nine|ten)\s+platforms\b/giu },
    ],
  },
]

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
]
const PASS_LINE_PREFIX = 'check-doc-claims: 已覆盖 '
const PASS_LINE_SUFFIX = ' —— 全部与真源一致 ✅'
/**
 * 修前那条**无边界**的通过行措辞：它声称"文档数字与真源一致"，而当时只判了两类 claim。
 * 收敛后不得再出现（出现即红）。
 */
const RETIRED_PASS_CLAIM = '文档数字与真源一致'

/** 生成通过行（`covered` = 本轮**真正产出过断言**的项，按登记顺序）。 */
function passLineFor(covered) {
  return `${PASS_LINE_PREFIX}${covered.length} 项：${covered.map(item => item.label).join('、')}${PASS_LINE_SUFFIX}`
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

/** 自检：解析器与判据本身的正反用例（防"扫描器悄悄失效 ⇒ 恒绿"）。 */
function selfTest() {
  const good = '平台模块表（`PLATFORM_MODULES`，共 2 项：`react`、`react-dom`）与 `scripts/platform-modules.mjs`'
  const bad = '平台模块表（`PLATFORM_MODULES`，共 3 项：`react`、`react-dom`）与 `react-dom/client`'
  const noAnchor = '无关的一行 `react`'
  const cadenceSample = '  initialDelayMs: z.number().step(1).max(X).default(60_000),\n'
    + '  intervalMs: z.number().step(1).max(X).default(6 * 60 * 60 * 1000),'
  const cadence = updateCadenceFrom(cadenceSample)
  const coveredSample = COVERAGE_ITEMS.slice(0, 2)
  const cases = [
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
    // 通过行反解断言（自我陈述与覆盖面必须一致）
    [passLineProblems(passLineFor(coveredSample), coveredSample).length === 0, 'selftest: 生成的通过行必须自洽'],
    [passLineProblems('check-doc-claims: 已覆盖 9 项：上游 pin、平台模块表 —— 全部与真源一致 ✅', coveredSample).length > 0,
      'selftest: 通过行的项数与实际不符必须被拒'],
    [passLineProblems(`check-doc-claims: ${RETIRED_PASS_CLAIM}（pin=…）✅`, coveredSample).length > 0,
      'selftest: 无边界的旧措辞必须被拒'],
    [passLineProblems(passLineFor(coveredSample).replace('平台模块表', '别的东西'), coveredSample).length > 0,
      'selftest: 通过行张冠李戴必须被拒'],
  ]
  const failed = cases.filter(([ok]) => !ok).map(([, name]) => name)
  if (failed.length > 0) {
    for (const name of failed) console.error(`  [SELFTEST] ${name}`)
    console.error(`check-doc-claims: 自检 ${failed.length}/${cases.length} 项失败 —— 守卫自身失效`)
    process.exit(1)
  }
  console.log(`check-doc-claims: 自检 ${cases.length}/${cases.length} 项通过 ✅`)
  process.exit(0)
}

if (selftest) selfTest()

const failures = []
const hits = []

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
const numericRules = NUMBER_CLAIM_RULES.map(rule => ({ ...rule, truth: undefined, hits: 0, excluded: 0 }))
for (const rule of numericRules) {
  const path = join(root, rule.source)
  if (!existsSync(path)) {
    if (strictSurface) {
      failures.push(`${rule.source}: 找不到硬数字真源（${rule.label}）—— 拒绝把"读不到真源"当通过`)
    }
    continue
  }
  const value = rule.read(readFileSync(path, 'utf8'))
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    failures.push(`${rule.source}: 解析不出 ${rule.label} 的真源（该文件的形态变了？）`
      + ' —— 拒绝把"解析失败"当通过，请同步本守卫的解析器')
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
      // ---- 硬数字断言（真源见 NUMBER_CLAIM_RULES）----
      for (const rule of numericRules) {
        if (rule.truth === undefined) continue
        for (const form of rule.forms) {
          if (rule.anchor !== undefined) {
            const span = rule.window ?? 0
            const context = lines.slice(Math.max(0, index - span), index + span + 1).join('\n')
            if (!rule.anchor.test(context)) {
              // 同形但**不同源**的句子（例如保留策略调度器也写「每 6 小时一次」）：
              // 排除，但把条数记下来照实打印，不做静默吞掉。
              rule.excluded += [...line.matchAll(form.pattern)].length
              continue
            }
          }
          for (const match of line.matchAll(form.pattern)) {
            rule.hits += 1
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
// 通过行（自我陈述）—— R13-GF 的第二条修法：**✅ 行的口径必须等于真实覆盖面**。
// 「覆盖了」= 本轮真的拿真源比过至少一条 claim（不是"登记表里写了"）。数量与标签都
// 由登记表生成，打印前再反解断言一遍；真仓形态下另要求"判过的项数 == 登记项数"。
// ─────────────────────────────────────────────────────────────────────────────
const declaredCoverageIds = COVERAGE_ITEMS.map(item => item.id)
const judgedCoverageIds = ['pin', 'platform-modules', ...NUMBER_CLAIM_RULES.map(rule => rule.id)]
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
const summaryLine = passLineFor(coveredItems)
for (const message of passLineProblems(summaryLine, coveredItems)) {
  failures.push(`通过行自证失败：${message}`)
}

/**
 * ✅ 行的**唯一出口**：打印前再反解断言一次（与上面覆盖率汇总处同一份实现）。
 * 双保险的理由：断言与打印若各写一份，"改打印不改断言"就能让通过行说谎 ——
 * 「自我陈述」类判据必须钉在**打印**这条路径上。
 */
function printVerdict() {
  const problems = passLineProblems(summaryLine, coveredItems)
  if (problems.length > 0) {
    for (const message of problems) console.error(`  [PASS-LINE] ${message}`)
    console.error('check-doc-claims: 通过行与真实覆盖面不一致 —— 拒绝打印"一致 ✅"')
    process.exit(1)
  }
  console.log(summaryLine)
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
  }
  if (coveredItems.length !== COVERAGE_ITEMS.length) {
    const missing = COVERAGE_ITEMS.filter(item => !coveredItems.includes(item)).map(item => item.label)
    surfaceProblems.push(`真仓形态下只有 ${coveredItems.length}/${COVERAGE_ITEMS.length} 项产出了断言`
      + `（缺：${missing.join('、')}）—— 通过行的「已覆盖 N 项」不得声称没判过的项`)
  }
}

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
if (!json) printVerdict()
