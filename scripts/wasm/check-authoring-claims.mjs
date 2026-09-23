#!/usr/bin/env node
/**
 * 组 8（W5 文档与作者面判据）实现：**模式判据 + 按分句豁免 + 结论钉牢 + 合成负例回归网**。
 *
 * ## 为什么要单独一个脚本（第三轮审计 W-7 / W-9）
 *
 * 组 8 此前是 `scripts/verify-wasm-client-only.sh` 里的五条纯 grep，实测有四个洞：
 *   1. **反向判据是固定枚举**：④ `冻结与已下架都不列|下架都列出来|下架不列`、⑤ `内置浏览器加载|浏览器标签承载`
 *      —— 轻度改写即绕过（实测三句：`已下架的应用不会再出现在应用中心列表里…`、
 *      `应用由桌面客户端内的内置浏览器承载…`、`应用不能联网，这不等于说它不能显示外部网页…` 全部 EXIT=0）。
 *      台账 R2-L5-2 早已给出修法（改成**模式**：`内置浏览器[^，。；]{0,8}(加载|打开|承载|渲染|运行|呈现)`），
 *      但入库后的门禁用的是收窄前的枚举。
 *   2. **豁免是整行关键词**：① 的 `grep -vE '不要对外说成|不要写|不等于'` 只要**同一行**里出现 `不等于`，
 *      整行的"不能联网"宣称一并放行 ⇒ 豁免必须**按分句**（`，。；！？` 切分）。
 *   3. **正向判据只查关键词在不在**：② `grep -rq 'Cache Storage'` 把结论反转成
 *      `| ✅ **完全可用，鼓励依赖** |` 仍然 PASS；③ 同理只查 `window\.(ratio|width|height)` 出现过。
 *   4. **扫描根是自持字面量且含死条目 + 吞掉 grep 自身错误**：⑤ 的根清单里 `README.zh-CN.md`
 *      **不存在**（真实中文 README 是 `README.zh.md`，不在扫描面里），而 `2>/dev/null || true`
 *      把 rc=1（没命中）与 rc≥2（扫描本身坏了）抹成同一个 ⇒ 往 `README.zh.md` 写违规句仍 PASS。
 *
 * ## 本实现的口径
 *
 * - **扫描面是目录驱动 + 通配**（不是逐文件字面量）：`docs` / `site/src` / `server/docs` /
 *   `server/skills/app-builder` 四个目录 + 仓库根 `README*.md` 通配。**每个声明的根都必须存在**，
 *   每个根在 include/exclude 之后都必须**至少留下一个文件**，任何文件读取失败一律 fail-loud ——
 *   这三条是本脚本对 `grep rc≥2` 纪律的等价物：**扫描本身坏了不得当通过**
 *   （同款纪律见 `check-old-model-residue.mjs` 头注释）。
 * - **豁免按分句**：`，。；！？` 是分句边界；命中所在分句里出现豁免词，该分句放行，**同一行别的分句**里
 *   的命中照旧报（这正是"整行豁免"要修的形态）。
 * - **正向判据钉结论**：Cache Storage 断言的是**可用性取值**（出现"可用/鼓励依赖"型断言即失败，
 *   且每个提到它的文件必须给出"不可用/禁止依赖"型取值）；`window.ratio` 断言的是**同一行同时给出
 *   合法区间（0.25–4.0）与发布期错误码（APP_CONFIG_INVALID）**，不是"关键词出现过"。
 * - **合成负例回归网**：台账 R2-L5-2 里那 6 条"已闭合"的合成负例 + 本次审计 W-7a/W-7b 的原始躲过形态，
 *   在同一次运行里**用同一批判据函数**实跑（期望命中/期望不误报/取值分类逐条断言）——
 *   正则被削弱、豁免粒度被改回整行、可用性取值被反转，回归网自己先红。
 *
 * ## 报告协议（父脚本 `verify-wasm-client-only.sh` 据此计数）
 *
 * 每行三选一：`G8-PASS <文案>` / `G8-FAIL <文案>` / `G8-NOTE <文案>`（其余行也当 NOTE 打印）。
 * 父脚本把 PASS/FAIL 镜像进自己的组级计数，避免"子脚本说通过、父脚本说另一套"。
 *
 * 用法：`node scripts/wasm/check-authoring-claims.mjs [--root <仓库根>]`
 * 退出码：0 = 全部通过；1 = 有判据失败（含回归网）；2 = **前置缺失**（扫描根不存在 / 根下 0 个文件 /
 *         文件读不出 / 作者面主体文件缺失）—— 判据无处可查不等于通过。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
let ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--root') {
    const value = args[index + 1]
    if (value === undefined) {
      console.error('check-authoring-claims: --root 需要一个目录')
      process.exit(2)
    }
    ROOT = resolve(value)
    index += 1
  } else {
    console.error(`check-authoring-claims: 未知参数 ${args[index]}（用法：--root <仓库根>）`)
    process.exit(2)
  }
}

let failures = 0

/** 子脚本 → 父脚本的可解析回报（见文件头「报告协议」）。 */
function pass(message) { console.log(`G8-PASS ${message}`) }
function fail(message) { failures += 1; console.log(`G8-FAIL ${message}`) }
function note(message) { console.log(`G8-NOTE ${message}`) }
/** 前置缺失：整次判据不可信 ⇒ 退出码 2（不是"判据没通过"，而是"判据没法判"）。 */
function bail(message) { console.error(`G8-FAIL ${message}`); process.exit(2) }

// ---------------------------------------------------------------------------
// 扫描面（目录驱动 + 通配；不是自持字面量）
// ---------------------------------------------------------------------------
/** 作者手册（①/②/③ 的对象之一）。 */
const AUTHOR_DOC = 'docs/wasm-app-authoring.md'
/** 作者面技能包（①/②/③ 的另一半；随包进服务端镜像）。 */
const AUTHOR_SKILL_DIR = 'server/skills/app-builder'
/** ④/⑤ 的全仓扫描根（**目录驱动**：新增/改名的文档目录写这里，改死条目由存在性校验兜住）。 */
const SCAN_DIR_ROOTS = ['docs', 'site/src', 'server/docs', AUTHOR_SKILL_DIR]
/** ④/⑤ 的仓库根通配（`README*.md` 覆盖 README.md / README.en.md / README.zh.md，
 *  不再写死单个文件名 —— 旧清单里的 `README.zh-CN.md` 在仓库里根本不存在）。 */
const SCAN_ROOT_GLOBS = ['README*.md']
/** 只看源文件（与原 `--include` 一致）；`dist`/`node_modules`/`.astro`/`build` 是构建产物。 */
const INCLUDE_FILE = /\.(?:md|mdx|astro|ts|tsx)$/u
/** 目录排除（`--exclude-dir` 语义：任意层级同名目录都跳过）。 */
const EXCLUDE_DIR_NAMES = new Set(['dist', 'node_modules', '.astro', 'build'])
/**
 * 记录面排除：`docs/planning|decisions|releases` 与 `docs/AUDIT-*.md` **必须**逐字保留旧措辞才有意义
 * （总纲/台账/早期契约要引用被推翻的原话，审计留痕是证据不是现行处方）。
 * 它们是"证据"，把它们算进来只会让判据因为记录本身永远红（它们仍被组 2 的零残留扫描覆盖）。
 */
const RECORD_EXCLUDE_DIR_NAMES = new Set(['planning', 'decisions', 'releases'])
const RECORD_EXCLUDE_FILE = /^AUDIT-.*\.md$/u

/**
 * 递归收集目录下的源文件（跳过排除目录）；读取失败 / 目录不存在一律返回 error（fail-loud）。
 * @param absoluteDir - 绝对目录。
 * @param options - `{ excludeRecords }`：是否套用记录面排除（作者面 ①/②/③ 不套用）。
 * @returns `{ files, errors }`（files 为绝对路径，排序稳定）。
 */
function collectDir(absoluteDir, { excludeRecords }) {
  const files = []
  const errors = []
  const walk = dir => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      errors.push(`${relative(ROOT, dir) || dir}: ${error.code ?? error.message}`)
      return
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (EXCLUDE_DIR_NAMES.has(entry.name)) continue
        if (excludeRecords && RECORD_EXCLUDE_DIR_NAMES.has(entry.name)) continue
        walk(absolute)
        continue
      }
      if (!entry.isFile()) continue
      if (!INCLUDE_FILE.test(entry.name)) continue
      if (excludeRecords && RECORD_EXCLUDE_FILE.test(entry.name)) continue
      files.push(absolute)
    }
  }
  walk(absoluteDir)
  return { files, errors }
}

/** 读取文本（读失败一律 fail-loud —— "文件读不出来"不是"没问题"）。 */
function readText(absolute) {
  try {
    return readFileSync(absolute, 'utf8')
  } catch (error) {
    bail(`读不到 ${relative(ROOT, absolute)}（${error.code ?? error.message}）—— 扫描面不完整，结论不可信`)
  }
}

// ---------------------------------------------------------------------------
// 判据原语：模式 + **按分句**豁免 + 取值分类
// ---------------------------------------------------------------------------
/** 分句边界：`，。；！？`。刻意**不**切 `：`/`、`（它们不构成独立命题，切开只会削弱豁免的判据力）。 */
const CLAUSE_SPLIT = /[，。；！？]/u

/** 按分句切分（保留顺序；空分句丢掉）。 */
function clausesOf(text) {
  return text.split(CLAUSE_SPLIT).map(clause => clause.trim()).filter(clause => clause !== '')
}

/**
 * 「禁止型」判据：找 `pattern` 的命中，命中所在**分句**含任一豁免词则放行。
 * @param text - 文件全文。
 * @param pattern - 判据模式（**不要带 `g` 标志**：带状态的 lastIndex 会让逐行判定串味）。
 * @param exemptions - 分句级豁免词。
 * @returns 命中列表 `{ line, clause }`（按行号升序）。
 */
function scanForbidden(text, pattern, exemptions = []) {
  const hits = []
  text.split('\n').forEach((line, index) => {
    if (!pattern.test(line)) return
    const offending = clausesOf(line).filter(clause =>
      pattern.test(clause) && !exemptions.some(marker => clause.includes(marker)))
    if (offending.length > 0) hits.push({ line: index + 1, clause: offending[0] })
  })
  return hits
}

/** 「可用」型断言：显式可用性词，或 ✅ 正向标记。 */
const AVAILABLE_CLAIM = /可用(?!性)|可以(?:用|使用|依赖)|鼓励依赖|推荐使用|放心依赖|✅/u
/** 「不可用」型断言（Cache Storage 的正确口径）。 */
const UNAVAILABLE_CLAIM = /不可用|不能使用|无法使用|不能用|不支持|禁止依赖|禁止使用|❌/u
/**
 * 同上的**全文替换**版本：判"可用性断言"之前必须先把否定型取值剥掉 ——
 * `不可用` 里含 `可用`，不剥就会把正确口径（`❌ 不可用，禁止依赖`）判成"说它可用"（本脚本第一版真实踩到）。
 */
const UNAVAILABLE_CLAIM_STRIP = /不可用|不能使用|无法使用|不能用|不支持|禁止依赖|禁止使用|❌/gu
/** 否定/告诫词：剥掉否定型取值后，分句里仍有这些词 ⇒ `可用` 是被否定或被引用（`不要把"可用"当成承诺`）。 */
const NEGATED_CLAUSE = /不要|不得|不能|不是|不等于|不宜|禁止|尚未/u

/**
 * 一行里有没有「Cache Storage 可用」型断言（**分句级**，避免把
 * `可用性证据强度…不要把"可用"当成跨平台承诺` 这类告诫句判成可用性结论）。
 * @param line - 单行文本。
 * @returns 命中可用性断言的分句（无则 null）。
 */
function availableClaimClause(line) {
  for (const clause of clausesOf(line)) {
    const stripped = clause.replace(UNAVAILABLE_CLAIM_STRIP, '')
    if (!AVAILABLE_CLAIM.test(stripped)) continue
    if (NEGATED_CLAUSE.test(stripped)) continue
    return clause
  }
  return null
}

/**
 * 一行的 Cache Storage 可用性取值分类（把结论**钉成取值**，不是"关键词在不在"）。
 * @param line - 含 `Cache Storage` 的单行。
 * @returns `'available' | 'unavailable' | 'unclassified'`。
 */
function cacheStorageVerdict(line) {
  if (availableClaimClause(line) !== null) return 'available'
  return UNAVAILABLE_CLAIM.test(line) ? 'unavailable' : 'unclassified'
}

/** `window.ratio` 的结论是否钉在同一行：合法区间 + 越界语义 + 发布期错误码。 */
const RATIO_INTERVAL = /0\.25/u
const RATIO_INTERVAL_UPPER = /4\.0/u
const RATIO_REJECTION = /越界|超出|不合法|非法|拒绝|拒/u
const RATIO_ERROR_CODE = /APP_CONFIG_INVALID/u
/**
 * @param line - 含 `window.ratio` 的单行。
 * @returns 缺哪几项（空数组 = 结论完整）。
 */
function ratioConclusionGaps(line) {
  const gaps = []
  if (!RATIO_INTERVAL.test(line) || !RATIO_INTERVAL_UPPER.test(line)) gaps.push('合法区间 0.25–4.0')
  if (!RATIO_REJECTION.test(line)) gaps.push('越界语义')
  if (!RATIO_ERROR_CODE.test(line)) gaps.push('APP_CONFIG_INVALID')
  return gaps
}

// ---------------------------------------------------------------------------
// 判据定义（同一条判据同时用于真扫描与回归网 —— 回归网保护的正是这里）
// ---------------------------------------------------------------------------
/**
 * ① 作者面不得再宣称"不能联网 / 零网络"（§6 订正：真实边界是"不能主动发起 XHR/fetch"，
 * 顶层导航/弹窗由窗口闸门兜底）。豁免**按分句**：只有"不要对外说成…"/"不等于…"所在的那一分句放行。
 */
const RULE_OFFLINE = {
  pattern: /不能联网|无法联网|不能访问网络|零网络|不联网/u,
  exemptions: ['不要对外写', '不要对外说成', '不要写', '不要宣称', '不等于', '不得写成'],
}
/**
 * ④ 目录口径（R1-L5-14 订正）：一律列出（下架仍列、冻结不列）——
 * "下架 ⇒ 不列/不再出现"的表述必须红。**模式判据**（不是固定枚举），
 * 并刻意排除"冻结不列"这一句（那句是**正确**处方：冻结不进目录）。
 */
const RULE_DELISTED = {
  pattern: /(?:已下架|下架)(?:(?!冻结)[^，。；]){0,12}(?:不列|不再列|不再出现|不会再出现|不出现在|不会出现在|不展示|不显示|移除|下掉)/u,
  exemptions: [],
}
/**
 * ⑤ 载体口径（§2.1/§4）：应用只在客户端内的**独立窗口**打开，不得再被描述成
 * "内置浏览器加载 / 浏览器标签承载"。模式照台账 R2-L5-2 的写法（刻意不允许插入"的"，
 * 以免把"内置浏览器的页面缩放"这类**产品功能句**判成违规）。豁免按分句：
 * 明确否定这种说法的句子（"不是内置浏览器标签加载"）放行。
 */
const RULE_CARRIER = {
  pattern: /内置浏览器(?:(?!的)[^，。；]){0,8}(?:加载|打开|承载|渲染|运行|呈现)|浏览器标签(?:(?!的)[^，。；]){0,6}(?:承载|加载|打开|渲染|运行|呈现)/u,
  exemptions: ['不是', '不得', '不要', '禁止', '不再', '非'],
}

// ---------------------------------------------------------------------------
// 前置：扫描面校验（根存在 / 根下非空 / 文件可读 / 作者面主体在位）
// ---------------------------------------------------------------------------
const authorDocPath = join(ROOT, AUTHOR_DOC)
const authorSkillPath = join(ROOT, AUTHOR_SKILL_DIR)
if (!existsSync(authorDocPath) || !statSync(authorDocPath).isFile()) {
  bail(`作者面主体文件缺失（${AUTHOR_DOC}）—— 判据无处可查不等于通过`)
}
if (!existsSync(authorSkillPath) || !statSync(authorSkillPath).isDirectory()) {
  bail(`作者面技能包目录缺失（${AUTHOR_SKILL_DIR}）—— 判据无处可查不等于通过`)
}

/** ④/⑤ 的扫描面：目录根 + 仓库根通配，逐个校验存在性与非空（W-9①③）。 */
const scanFiles = []
const rootSummary = []
for (const rel of SCAN_DIR_ROOTS) {
  const absolute = join(ROOT, rel)
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
    bail(`扫描根不存在或不是目录：${rel} —— 根清单必须与仓库结构一致（缺根 = 判据静默缩水）`)
  }
  const { files, errors } = collectDir(absolute, { excludeRecords: true })
  if (errors.length > 0) bail(`扫描根 ${rel} 读不完整：${errors.join('；')}`)
  if (files.length === 0) {
    bail(`扫描根 ${rel} 在 include/exclude 之后 0 个文件 —— 扫描面被静默吃空（拒绝空集通过）`)
  }
  scanFiles.push(...files)
  rootSummary.push(`${rel} ${files.length}`)
}
{
  let matched = 0
  const rootEntries = readdirSync(ROOT, { withFileTypes: true })
  for (const glob of SCAN_ROOT_GLOBS) {
    const regex = new RegExp(`^${glob.replace(/[.]/gu, '\\.').replace(/[*]/gu, '.*')}$`, 'u')
    for (const entry of rootEntries) {
      if (!entry.isFile() || !regex.test(entry.name)) continue
      matched += 1
      scanFiles.push(join(ROOT, entry.name))
    }
  }
  if (matched === 0) bail(`扫描根通配 ${SCAN_ROOT_GLOBS.join(' ')} 一个文件都没匹配到 —— 仓库根结构异常`)
  rootSummary.push(`${SCAN_ROOT_GLOBS.join(' ')} ${matched}`)
}
const uniqueScanFiles = [...new Set(scanFiles)].sort()
note(`扫描面（目录驱动 + 通配）：${rootSummary.join(' / ')} ⇒ 去重后 ${uniqueScanFiles.length} 个文件（排除 ${[...EXCLUDE_DIR_NAMES].join('/')} 与记录面 ${[...RECORD_EXCLUDE_DIR_NAMES].join('/')}+AUDIT-*.md）`)

// ---------------------------------------------------------------------------
// 回归网：台账里"已闭合"的合成负例 + 本次审计的原始躲过形态（用**同一批**判据函数）
// ---------------------------------------------------------------------------
const REGRESSION_CASES = [
  // 载体词（台账 R2-L5-2 ① 的三条合成负例：固定枚举时代 3/3 NOMATCH）
  { rule: 'carrier', expect: 'hit', text: '应用放在内置浏览器标签里打开' },
  { rule: 'carrier', expect: 'hit', text: '应用由内置浏览器窗口承载' },
  { rule: 'carrier', expect: 'hit', text: '应用在浏览器标签页中运行' },
  // 本次审计 W-7a 的原始躲过形态（⑤ 与 W-9 的 README 变体）
  { rule: 'carrier', expect: 'hit', text: '应用由桌面客户端内的内置浏览器承载，点击卡片即在该容器里打开。' },
  { rule: 'carrier', expect: 'hit', text: '应用由内置浏览器加载，浏览器标签承载全部应用页面。' },
  // 反向对照：明确否定该说法的句子不算违规；"的"隔开的产品功能句不算违规
  { rule: 'carrier', expect: 'miss', text: '应用不是由内置浏览器标签加载的（只在独立窗口里打开）' },
  { rule: 'carrier', expect: 'miss', text: '内置浏览器的手势操作与页面缩放（与本平台的应用窗口无关）' },
  // 下架口径（W-7a 的原始躲过形态 + 旧的固定枚举形态）
  { rule: 'delisted', expect: 'hit', text: '已下架的应用不会再出现在应用中心列表里，员工看不到也就不会点开。' },
  { rule: 'delisted', expect: 'hit', text: '冻结与已下架都不列。' },
  { rule: 'delisted', expect: 'hit', text: '下架不列。' },
  { rule: 'delisted', expect: 'hit', text: '应用下架后不再出现。' },
  // 反向对照：现行正确处方（冻结不列、下架仍列）不得被误报
  { rule: 'delisted', expect: 'miss', text: '已下架的应用仍然列在目录里，只是带「已下架」标记（冻结不列）。' },
  // 联网口径（W-7a 的原始躲过形态：豁免词在**别的分句**里，整行豁免时代被一并放行）
  { rule: 'offline', expect: 'hit', text: '应用不能联网，这不等于说它不能显示外部网页（顶层导航不受限）。' },
  { rule: 'offline', expect: 'miss', text: '⚠️ **不要对外说成"不能联网"**：CSP 不管顶层导航与弹窗。' },
  { rule: 'offline', expect: 'miss', text: '应用自己发起的 fetch/XHR 一律被拦；**但这不等于"不能联网"**。' },
  // Cache Storage 结论（W-7b：把可用性取值反转 ⇒ 必须判成 available）
  { rule: 'cache', expect: 'unavailable', text: '| **`Cache Storage`** | ❌ **不可用，禁止依赖** | — | `caches.open()` 会成功，写入必失败 |' },
  { rule: 'cache', expect: 'unavailable', text: '| **`Cache Storage`**（caches.open / SW 缓存） | ❌ **禁止依赖** | — | 不要写"离线优先" |' },
  { rule: 'cache', expect: 'available', text: '| **`Cache Storage`** | ✅ **完全可用，鼓励依赖** | — | 直接依赖即可 |' },
  { rule: 'cache', expect: 'available', text: 'Cache Storage 可用，可以放心依赖。' },
  // Cache Storage 告诫句不得被误判成"可用性结论"（现行文档里真实存在的形态：它既不是可用断言，
  // 也不是否定型取值 ⇒ 只能记 unclassified，不能污染取值判定）
  { rule: 'cache', expect: 'unclassified', text: '> ⚠️ **可用性证据强度（如实认账）**：上表结论来自单平台实测（`Cache Storage` 的失败形态已最小复现）；三平台复核前，不要把"可用"当成跨平台承诺 —— 关键路径请以应用库为准。' },
  // window.ratio 结论（③：反转成"任意值都接受"⇒ 结论不完整）
  { rule: 'ratio', expect: 'complete', text: '| `window.ratio` | 字符串或浮点 | **合法区间 `0.25`–`4.0`**；越界（含 `0`、负数、非数字）⇒ **发布期直接拒**，`APP_CONFIG_INVALID` |' },
  { rule: 'ratio', expect: 'incomplete', text: '| `window.ratio` | 字符串或浮点 | 任意值都接受，不做校验 |' },
  { rule: 'ratio', expect: 'incomplete', text: '| `window.ratio` | 字符串或浮点 | **合法区间 `0.25`–`4.0`**；越界时按默认比例回落 |' },
]

/** 用真判据函数跑一条合成用例，返回归一化后的实得值。 */
function regressionOutcome(testCase) {
  const { text } = testCase
  switch (testCase.rule) {
    case 'carrier': return scanForbidden(text, RULE_CARRIER.pattern, RULE_CARRIER.exemptions).length > 0 ? 'hit' : 'miss'
    case 'delisted': return scanForbidden(text, RULE_DELISTED.pattern, RULE_DELISTED.exemptions).length > 0 ? 'hit' : 'miss'
    case 'offline': return scanForbidden(text, RULE_OFFLINE.pattern, RULE_OFFLINE.exemptions).length > 0 ? 'hit' : 'miss'
    case 'cache': return cacheStorageVerdict(text)
    case 'ratio': return ratioConclusionGaps(text).length === 0 ? 'complete' : 'incomplete'
    default: throw new Error(`回归网里出现未知判据 ${testCase.rule}`)
  }
}

{
  const mismatches = []
  for (const testCase of REGRESSION_CASES) {
    const actual = regressionOutcome(testCase)
    if (actual !== testCase.expect) {
      mismatches.push(`[${testCase.rule}] 期望 ${testCase.expect} 实得 ${actual}：${testCase.text.slice(0, 60)}`)
    }
  }
  if (mismatches.length > 0) {
    fail(`合成负例回归网 ${mismatches.length}/${REGRESSION_CASES.length} 条不符合期望 —— 判据被削弱或误报：${mismatches.join(' ｜ ')}`)
  } else {
    const hits = REGRESSION_CASES.filter(testCase => testCase.expect === 'hit' || testCase.expect === 'available').length
    pass(`合成负例回归网 ${REGRESSION_CASES.length}/${REGRESSION_CASES.length} 条符合期望（${hits} 条必须命中/必须判成违规；台账 R2-L5-2 的 6 条合成负例与 W-7a/W-7b 的原始躲过形态在内）`)
  }
}

// ---------------------------------------------------------------------------
// ① 作者面不得再宣称"不能联网 / 零网络"
// ---------------------------------------------------------------------------
{
  const targets = [AUTHOR_DOC, join(AUTHOR_SKILL_DIR, 'SKILL.md')]
  const hits = []
  for (const rel of targets) {
    const absolute = join(ROOT, rel)
    if (!existsSync(absolute)) bail(`作者面判据的目标文件缺失：${rel}`)
    for (const hit of scanForbidden(readText(absolute), RULE_OFFLINE.pattern, RULE_OFFLINE.exemptions)) {
      hits.push(`${rel}:${hit.line}: ${hit.clause.slice(0, 120)}`)
    }
  }
  if (hits.length > 0) {
    fail(`作者面仍宣称「不能联网/零网络」（模式判据 + 按分句豁免）：${hits.join(' ｜ ')}`)
  } else {
    pass('作者面没有「不能联网/零网络」的错误宣称（§6 订正；模式判据 + **按分句**豁免）')
  }
}

// ---------------------------------------------------------------------------
// ② 作者面必须写明 Cache Storage 的**可用性取值**（不是"关键词在不在"）
// ---------------------------------------------------------------------------
{
  const surfaces = [
    { label: '作者手册', files: [authorDocPath] },
    { label: '作者面技能包', files: collectDir(authorSkillPath, { excludeRecords: false }).files },
  ]
  const problems = []
  const summaries = []
  for (const surface of surfaces) {
    let unavailable = 0
    for (const absolute of surface.files) {
      const rel = relative(ROOT, absolute)
      const text = readText(absolute)
      if (!text.includes('Cache Storage')) continue
      text.split('\n').forEach((line, index) => {
        if (!line.includes('Cache Storage')) return
        const verdict = cacheStorageVerdict(line)
        if (verdict === 'available') {
          problems.push(`${rel}:${index + 1} 把 Cache Storage 说成可用（取值必须是否定口径）：${availableClaimClause(line)?.slice(0, 100) ?? line.trim().slice(0, 100)}`)
        } else if (verdict === 'unavailable') {
          unavailable += 1
        }
      })
    }
    summaries.push(`${surface.label} ${unavailable} 条否定口径`)
    if (unavailable === 0) {
      problems.push(`${surface.label}没有给出 Cache Storage 的否定型可用性取值（§3 F13：可 open、不可 put ⇒ 禁止依赖）`)
    }
  }
  if (problems.length > 0) {
    fail(`Cache Storage 可用性结论不合格（§3 F13；${summaries.join('，')}）：${problems.join(' ｜ ')}`)
  } else {
    pass(`作者面写明 Cache Storage 的可用性取值 = 不可用/禁止依赖，且无"可用"型断言（§3 F13；${summaries.join('，')}）`)
  }
}

// ---------------------------------------------------------------------------
// ③ 作者面必须有 window.ratio/width/height，且 ratio 的**结论**完整
// ---------------------------------------------------------------------------
{
  const surfaces = [
    { label: '作者手册', files: [authorDocPath] },
    { label: '作者面技能包', files: collectDir(authorSkillPath, { excludeRecords: false }).files },
  ]
  const problems = []
  for (const surface of surfaces) {
    let ratioMentions = 0
    let complete = 0
    let widths = 0
    let heights = 0
    const gaps = new Set()
    for (const absolute of surface.files) {
      const rel = relative(ROOT, absolute)
      const text = readText(absolute)
      if (!/window\.(?:ratio|width|height)/u.test(text)) continue
      text.split('\n').forEach((line, index) => {
        const structural = /window\.(?:ratio|width|height)/u.test(line)
        if (/window\.width/u.test(line)) widths += 1
        if (/window\.height/u.test(line)) heights += 1
        if (!/window\.ratio/u.test(line)) return
        ratioMentions += 1
        const missing = ratioConclusionGaps(line)
        if (missing.length === 0) complete += 1
        else if (structural) gaps.add(`${rel}:${index + 1} 缺 ${missing.join('、')}`)
      })
    }
    if (ratioMentions === 0) problems.push(`${surface.label}完全没有提到 window.ratio`)
    else if (complete === 0) problems.push(`${surface.label}提到 window.ratio 但没有任何一行把结论钉全（${[...gaps].join('；') || '缺合法区间/越界语义/APP_CONFIG_INVALID'}）`)
    if (widths === 0 || heights === 0) problems.push(`${surface.label}缺 window.width/window.height（§6 作者契约）`)
  }
  if (problems.length > 0) {
    fail(`window.* 作者契约不合格（§6/§13.2）：${problems.join(' ｜ ')}`)
  } else {
    pass('作者面写明 window.ratio/width/height，且 ratio 的合法区间（0.25–4.0）与越界 ⇒ 发布期 APP_CONFIG_INVALID 钉在同一行（§6/§13.2）')
  }
}

// ---------------------------------------------------------------------------
// ④ 目录口径（全仓扫描面；模式判据）
// ---------------------------------------------------------------------------
{
  const hits = []
  for (const absolute of uniqueScanFiles) {
    for (const hit of scanForbidden(readText(absolute), RULE_DELISTED.pattern, RULE_DELISTED.exemptions)) {
      hits.push(`${relative(ROOT, absolute)}:${hit.line}: ${hit.clause.slice(0, 120)}`)
    }
  }
  if (hits.length > 0) {
    fail(`仍有「下架 ⇒ 不列/不再出现」类口径（R1-L5-14 订正：目录一律列出，仅不可打开）：${hits.slice(0, 12).join(' ｜ ')}${hits.length > 12 ? `（共 ${hits.length} 处，此处只列前 12）` : ''}`)
  } else {
    pass(`目录口径统一（下架仍列出；R1-L5-14）—— 扫描 ${uniqueScanFiles.length} 个文件，模式判据 + 排除「冻结不列」正确处方`)
  }
}

// ---------------------------------------------------------------------------
// ⑤ 载体口径（全仓扫描面；模式判据）
// ---------------------------------------------------------------------------
{
  const hits = []
  for (const absolute of uniqueScanFiles) {
    for (const hit of scanForbidden(readText(absolute), RULE_CARRIER.pattern, RULE_CARRIER.exemptions)) {
      hits.push(`${relative(ROOT, absolute)}:${hit.line}: ${hit.clause.slice(0, 120)}`)
    }
  }
  if (hits.length > 0) {
    fail(`仍有把应用描述成「内置浏览器加载 / 浏览器标签承载」的文案（§2.1/§4：应用只在客户端内的独立窗口打开）：${hits.slice(0, 12).join(' ｜ ')}${hits.length > 12 ? `（共 ${hits.length} 处，此处只列前 12）` : ''}`)
  } else {
    pass(`载体口径统一（独立窗口；§2.1/§4）—— 扫描 ${uniqueScanFiles.length} 个文件，模式判据（含 README*.md 通配）`)
  }
}

console.log(`G8-NOTE 结论：${failures === 0 ? '作者面判据全部通过 ✅' : `作者面判据存在 ${failures} 条失败 ❌`}`)
process.exit(failures === 0 ? 0 : 1)
