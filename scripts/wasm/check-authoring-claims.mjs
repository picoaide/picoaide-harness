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
 *   `server/skills/app-builder` / **`packages`（workspace 源码）** / **`community`** 六个目录
 *   + 仓库根 `README*.md` 通配。**每个声明的根都必须存在**，
 *   每个根在 include/exclude 之后都必须**至少留下一个文件**，任何文件读取失败一律 fail-loud ——
 *   这三条是本脚本对 `grep rc≥2` 纪律的等价物：**扫描本身坏了不得当通过**
 *   （同款纪律见 `check-old-model-residue.mjs` 头注释）。
 * - **不得静默缩小扫描面**（第三轮 W-7 收口，2026-09-23）：`packages/**` 此前不在面内，而那里
 *   有 9 处源码注释仍把应用说成"内置浏览器加载"（`open-app.ts` / `deep-link.ts` /
 *   `AppCenterPanel.tsx` / `wasm-apps-host/README.md` …）—— 判据写着"全仓"，实际只覆盖文档面。
 *   现在有**两条独立**的缩面判据（任一不成立即 `bail()` / 退出码 2）：
 *     ① `REQUIRED_SCAN_DIR_ROOTS` 登记值必须被 `SCAN_DIR_ROOTS` **全覆盖**（删登记项即静默缩面）；
 *     ② 仓库根 `package.json` 的 `workspaces` 每个 glob 的**顶层段**必须被扫描根覆盖
 *        （新增 workspace 根却忘了纳入扫描面 ⇒ 当场红；这是与登记值互相独立的第二个真源）。
 * - **产物/第三方排除要精确**：`lib`（tsdown/tsc 产物）与 `__snapshots__`（测试快照）按目录名排除，
 *   但 vendored 包的 `lib`（如 `packages/vendor/memory-evolve/lib`）是**入库源码**（无构建步骤）
 *   ⇒ 由 `KEEP_DIR_PATHS` 显式反向覆盖，避免"一刀切排 lib"把真源码一起排除。
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
import { dirname, join, relative, resolve, sep } from 'node:path'
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
/**
 * ④/⑤ 的全仓扫描根（**目录驱动**：新增/改名的文档目录写这里，改死条目由存在性校验兜住）。
 *
 * `packages` 与 `community` 是**源码/文档面**（第三轮 W-7 收口）：`packages/**` 里有应用打开
 * 链路与宿主包的源码注释、`community/**` 是随仓发布的协作文档 —— 两处都会对读者描述
 * "应用在哪里打开"，属本判据的对象。生成的 `lib/**` 由 `EXCLUDE_DIR_NAMES` 排除（产物不是文案）。
 */
const SCAN_DIR_ROOTS = ['docs', 'site/src', 'server/docs', AUTHOR_SKILL_DIR, 'packages', 'community']
/**
 * **不许静默缩小扫描面**（登记值，2026-09-23 W-7 收口）：这些根必须出现在 `SCAN_DIR_ROOTS` 里。
 * 与下面基于 `package.json#workspaces` 的派生校验是**两条独立的**判据 —— 只删本清单的某一项
 * 会被它抓住；只删派生面（改了 workspaces 却忘了纳入）会被派生校验抓住。任一不成立即 `bail()`。
 */
const REQUIRED_SCAN_DIR_ROOTS = ['docs', 'site/src', 'server/docs', AUTHOR_SKILL_DIR, 'packages', 'community']
/** ④/⑤ 的仓库根通配（`README*.md` 覆盖 README.md / README.en.md / README.zh.md，
 *  不再写死单个文件名 —— 旧清单里的 `README.zh-CN.md` 在仓库里根本不存在）。 */
const SCAN_ROOT_GLOBS = ['README*.md']
/** 只看源文件（与原 `--include` 一致）；`dist`/`node_modules`/`.astro`/`build` 是构建产物。 */
const INCLUDE_FILE = /\.(?:md|mdx|astro|ts|tsx)$/u
/** 目录排除（`--exclude-dir` 语义：任意层级同名目录都跳过）。
 *  `lib` 是 workspace 包的构建产物（tsdown/tsc 输出，含 .d.ts —— 它只是 `src/**` 的副本，
 *  扫它等于用产物给源码背书）；`__snapshots__` 是测试快照。源码面始终由 `src/**` 覆盖。 */
const EXCLUDE_DIR_NAMES = new Set(['dist', 'node_modules', '.astro', 'build', 'lib', '__snapshots__'])
/**
 * `EXCLUDE_DIR_NAMES` 的**反向覆盖**（仓库相对 POSIX 路径）：vendored 包把 JS 直接写在 `lib/`
 * 里且**没有构建步骤**（`packages/vendor/memory-evolve/VENDORED.md`：入库即为源码，跑了
 * `scripts/build.mjs` 反而会覆盖本地加固）⇒ 它不是产物，不得被"一刀切排 lib"排除。
 */
const KEEP_DIR_PATHS = new Set(['packages/vendor/memory-evolve/lib'])
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
  /** 仓库相对 POSIX 路径（`KEEP_DIR_PATHS` 用同一口径比较；Windows 上 `\\` → `/`）。 */
  const relPosix = absolute => relative(ROOT, absolute).split(sep).join('/')
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
        if (EXCLUDE_DIR_NAMES.has(entry.name) && !KEEP_DIR_PATHS.has(relPosix(absolute))) continue
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
 *
 * `options.exemptionGuard`（2026-09-23 第五轮追加：判据④ 的管辖范围收窄）：
 * 豁免只在**同一分句里不含"目录面标识"**时生效 —— 它是"豁免护栏"，防的是
 * 「给一句真正违规的应用目录口径挂一个'分发面'词就整句放行」这种豁免洗白。
 * 粒度仍然是**分句**（同一行别的分句里的命中照旧报）。
 * @param text - 文件全文。
 * @param pattern - 判据模式（**不要带 `g` 标志**：带状态的 lastIndex 会让逐行判定串味）。
 * @param exemptions - 分句级豁免词。
 * @param options - `{ exemptionGuard, exemptionScope }`：豁免护栏模式（命中则该分句**不**享受豁免）；
 *   `exemptionScope` = `'clause'`（缺省，**按分句**）或 `'line'`（按整行）。
 *   **粒度是显式契约**：按整行豁免会漏掉"同一行别的分句里仍然违规"的句子
 *   （`分发面不列；应用中心下架不列。`），所以它写成可登记、可被回归网钉住的一档。
 * @returns 命中列表 `{ line, clause }`（按行号升序）。
 */
function scanForbidden(text, pattern, exemptions = [], options = {}) {
  const guard = options.exemptionGuard
  const scope = options.exemptionScope ?? 'clause'
  const isExempt = clause => exemptions.some(marker => clause.includes(marker))
    && !(guard !== undefined && guard.test(clause))
  const hits = []
  text.split('\n').forEach((line, index) => {
    if (!pattern.test(line)) return
    if (scope === 'line' && isExempt(line)) return
    const offending = clausesOf(line).filter(clause => pattern.test(clause) && !isExempt(clause))
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
 * ④ 目录口径（R1-L5-14 订正）：**应用目录**一律列出（下架仍列、冻结不列）——
 * "下架 ⇒ 不列/不再出现"的表述必须红。**模式判据**（不是固定枚举），
 * 并刻意排除"冻结不列"这一句（那句是**正确**处方：冻结不进目录）。
 *
 * ## 管辖范围 = 应用目录（2026-09-23 第五轮追加：收窄 + 分句级登记豁免）
 *
 * 现场：判据把这条规则推广到了它**并不管辖**的面。两处真实文本被判红（同一根因）：
 *   · `packages/host/enterprise/tests/capability-catalog-proxy.spec.ts` 的注释
 *     `分发面（org/market）：下架行不列 —— 与 serverstore.ListVisibleSharedSkills 同口径`；
 *   · `server/docs/03-api-reference.md` 里 `GET /api/client/v2/shared-skills` 的可见清单说明
 *     （下架行在此面一律不列（与「不存在」同语义），作者的「已下架」态由能力中心「我的」分区表达）。
 * 两处**语义正确**：`shared-skills` 是**授权制安装面/可见清单**（严格默认拒绝、未授权即 404
 * 不泄露存在性，"不列"= 不可安装），与"应用目录一律列出（仅不可打开）"是两个面、两条规则。
 * 为了过判据去改写这两处措辞 = 绕过判据，本仓刚修过一整类，所以处置是**收窄判据**：
 *
 *   · `exemptions`（**分句级**登记豁免）：命中所在分句含"分发面/安装面/可见清单/授权面/授权制"
 *     之一的，放行 —— 这些词是**面的标识**，出现它们说明谈的不是应用目录；
 *   · `exemptionGuard`（豁免护栏）：同一分句里若同时出现**目录面标识**
 *     （应用中心/应用目录/应用列表/应用市场/目录），豁免**不生效** ——
 *     防止"给一句真正违规的应用目录口径挂一个分发面词"就整句放行；
 *   · 粒度是**分句**：`分发面不列；应用中心下架不列。` 仍然报（整行豁免会漏掉它，
 *     回归网里有一条样本专门盯这个粒度）。
 *
 * 新增豁免词必须登记在这里并写明依据（与白名单同一套纪律）；反例见回归网：
 * `已下架的应用不会再出现在应用中心列表里` / `冻结与已下架都不列` / `下架不列` /
 * `应用下架后不再出现` / `下架的应用不出现在应用中心` 五条必须继续红。
 */
const RULE_DELISTED = {
  pattern: /(?:已下架|下架)(?:(?!冻结)[^，。；]){0,12}(?:不列|不再列|不再出现|不会再出现|不出现在|不会出现在|不展示|不显示|移除|下掉)/u,
  exemptions: ['分发面', '安装面', '可见清单', '授权面', '授权制'],
  exemptionGuard: /应用中心|应用目录|应用列表|应用市场|目录/u,
  // 粒度**显式登记**为按分句：整行豁免会漏掉"同一行别的分句仍违规"的句子（回归网有样本钉它）。
  exemptionScope: 'clause',
}
// **已知边界（如实认账，不是本轮引入）**：模式只覆盖「下架 ⇒ 不列」这一**语序**；
// 反语序形态（如「不列出已下架的应用」）不在判据内。要覆盖它需要另写一条模式并重扫
// 真实面（本轮范围是"收窄管辖范围"，不做扩张）。
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
// 缩面判据 ①（登记值）：登记根必须被实际根清单全覆盖 —— 删掉 `SCAN_DIR_ROOTS` 里的任一项
// （例如把 `packages` 去掉）都让"全仓"这三个字变成假话，而存在性校验抓不到这种删法
// （目录还在，只是没人扫）。
for (const required of REQUIRED_SCAN_DIR_ROOTS) {
  if (!SCAN_DIR_ROOTS.includes(required)) {
    bail(`扫描根清单缺少登记项 ${required}（REQUIRED_SCAN_DIR_ROOTS）—— 判据静默缩水，拒绝出结论`)
  }
}
// 缩面判据 ②（派生真源，与登记值互相独立）：workspace 声明的每个 glob 的顶层段都必须在
// 扫描面内。新增一个 workspace 根却忘了纳入扫描面时，这条会立刻红 —— 而 ① 因为登记值没动
// 是抓不到的（反过来，只删 ① 的登记项也躲不过它）。
{
  const rootPkgPath = join(ROOT, 'package.json')
  if (!existsSync(rootPkgPath)) bail('仓库根 package.json 缺失 —— 无法校验 workspace 扫描面覆盖')
  let workspaces = []
  try {
    const parsed = JSON.parse(readFileSync(rootPkgPath, 'utf8'))
    workspaces = Array.isArray(parsed?.workspaces) ? parsed.workspaces : []
  } catch (error) {
    bail(`仓库根 package.json 解析失败（${error.message}）—— 无法校验 workspace 扫描面覆盖`)
  }
  if (workspaces.length === 0) bail('仓库根 package.json 没有 workspaces 声明 —— 无法校验扫描面覆盖')
  for (const glob of workspaces) {
    const top = String(glob).split('/')[0]
    if (top === '' || top === '.' || top === '..') continue
    if (!SCAN_DIR_ROOTS.some(root => root === top || root.startsWith(`${top}/`))) {
      bail(`workspace 根 ${glob} 的顶层目录 ${top} 不在扫描根清单里（${SCAN_DIR_ROOTS.join(' / ')}）`
        + ' —— workspace 源码面必须纳入载体口径判据，缺一个根 = 判据静默缩水')
    }
  }
}

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
    // 逐段转义后再把 `*` 展开成 `.*`：旧写法只转义 `.`（`[.]`），反斜杠与 `+?()[]{}|^$`
    // 都会原样进正则 —— 一旦根通配里出现这些字符，判据会**静默变成另一个模式**
    // （CodeQL js/incomplete-sanitization 报的正是这条；此处按段转义从构造上消除）。
    const pattern = String(glob)
      .split('*')
      .map(segment => segment.replace(/[.*+?^${}()|[\]\\]/gu, character => `\\${character}`))
      .join('.*')
    const regex = new RegExp(`^${pattern}$`, 'u')
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
note(`扫描面（目录驱动 + 通配）：${rootSummary.join(' / ')} ⇒ 去重后 ${uniqueScanFiles.length} 个文件（排除 ${[...EXCLUDE_DIR_NAMES].join('/')} 与记录面 ${[...RECORD_EXCLUDE_DIR_NAMES].join('/')}+AUDIT-*.md；反向保留 ${[...KEEP_DIR_PATHS].join('/')}）`)
note(`缩面判据：登记根 ${REQUIRED_SCAN_DIR_ROOTS.length} 项全覆盖 ✅ / package.json#workspaces 顶层段全覆盖 ✅（两条判据互相独立，任一缺项即退出码 2）`)

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
  // 五条反例（第五轮追加两条"应用目录"语境的真实形态）：判据收窄后仍必须全红
  { rule: 'delisted', expect: 'hit', text: '下架的应用不出现在应用中心。' },
  { rule: 'delisted', expect: 'hit', text: '下架的应用不再出现在应用中心列表里。' },
  // 反向对照：现行正确处方（冻结不列、下架仍列）不得被误报
  { rule: 'delisted', expect: 'miss', text: '已下架的应用仍然列在目录里，只是带「已下架」标记（冻结不列）。' },
  // **管辖范围收窄**（第五轮）：授权制安装面/可见清单/分发面的"下架 ⇒ 不列"是**正确**口径
  // —— 这三条是真实文本（逐字取自仓库里那两处）+ 一条合成正向，必须绿。
  {
    rule: 'delisted',
    expect: 'miss',
    text: '// 分发面（org/market）：下架行不列 —— 与 `serverstore.ListVisibleSharedSkills` 同口径，',
  },
  {
    rule: 'delisted',
    expect: 'miss',
    text: '可见清单(**分发面**):approved 且**已授权** 且**已上架**(apps.enabled=1);下架行在此面一律不列(与「不存在」同语义,归属人也不例外)',
  },
  { rule: 'delisted', expect: 'miss', text: '技能分发面（授权制安装面）看不到下架行；作者的「已下架」态由「我的」分区表达。' },
  // 豁免护栏：给**应用目录**口径挂一个"分发面"词不得放行（豁免洗白）
  { rule: 'delisted', expect: 'hit', text: '应用中心的分发面：下架不列。' },
  // 粒度：豁免在**别的分句**里时，本分句照旧报（整行豁免会漏掉它）——
  // 这一条**不含目录面词**，所以它只由"按分句"这一档兜住（豁免护栏管不到它）：
  // 把 `exemptionScope` 改成 `'line'` 这条样本立刻变 miss。
  { rule: 'delisted', expect: 'hit', text: '分发面不列；下架不列。' },
  // 豁免护栏：目录面词与豁免词同句 ⇒ 豁免不生效（防"给违规句挂分发面词"）
  { rule: 'delisted', expect: 'hit', text: '分发面不列；应用中心下架不列。' },
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
    case 'delisted': return scanForbidden(text, RULE_DELISTED.pattern, RULE_DELISTED.exemptions,
      {
        exemptionGuard: RULE_DELISTED.exemptionGuard,
        exemptionScope: RULE_DELISTED.exemptionScope,
      }).length > 0 ? 'hit' : 'miss'
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
    for (const hit of scanForbidden(readText(absolute), RULE_DELISTED.pattern, RULE_DELISTED.exemptions,
      { exemptionGuard: RULE_DELISTED.exemptionGuard, exemptionScope: RULE_DELISTED.exemptionScope })) {
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
