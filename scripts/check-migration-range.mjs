#!/usr/bin/env node
/**
 * 迁移区间守卫（2026-09-20 新增；起因是一次实测漂移）。
 *
 * **漂移**：`server/docs/06-database.md` 与 `server/docs/08-development.md` 都写着「迁移
 * `0001–0060`」，而 `server/internal/serverstore/migrations-pg/` 实际已经到 **0076**。
 * "文档里的迁移区间"没有任何守卫，只能靠人记得改 —— 这条守卫把"记得"变成机器判据。
 *
 * 判据：
 *   1. 读 `server/internal/serverstore/migrations-pg/` 的实际文件名 ⇒ `MIN` / `MAX`（四位数）；
 *   2. 扫 `server/docs` 下的 md、`server/AGENTS.md`、根 `AGENTS.md`、`docs` 下递归的 md、
 *      **`site/src/content/docs` 下递归的 md** 里的区间表述
 *      （`0001–00NN`、`0001 与 00NN`、`0001~00NN`…）：**上限必须 == MAX**（或该行已显式列出 MAX）；
 *      官网（`site/**`）此前不在扫描面内 —— `architecture.md` 因此长期写着 `0001–0061`
 *      （实际已到 0080）而无人发现：同一份"文档区间"在 `docs/` 里红、在 `site/` 里绿，
 *      守卫的覆盖面本身成了假绿来源（2026-09-23 修复）。
 *   3. 另断言 `server/AGENTS.md` 里出现的四位数迁移号都在实际文件集合里（防写了不存在的迁移）；
 *   4. 豁免**只能**是：行内 `migration-range:allow` 标记，或**记录面**文档
 *      （`docs/planning|decisions|releases/**`、`docs/AUDIT-*.md` —— 它们记录的是"当时"的
 *       事实，要求它们跟着 MAX 走等于篡改历史；这条与 W5 文档判据的"记录面排除"同一原则）。
 *   5. 命中即红，输出「文件:行: 声称上限 X，实际 MAX Y」+ 修法提示。
 *
 * 用法：node scripts/check-migration-range.mjs [--root <dir>] [--json]
 * 退出码：0 = 文档与实际一致；1 = 有漂移 / 扫描面为 0；2 = 用法错误 / **扫描面缩水**（见 §6）。
 *
 * 6. **缩面判据**（2026-09-23 第四轮审计 R4-A-4）：`SCAN_PATHS` 是手写数组，旧实现只兜
 *    "扫描面为 0"（零点地板）与"`server/AGENTS.md` 存在"两条 ⇒ 把 `site/src/content/docs`
 *    从数组里删掉后，官网上那处**真实**区间漂移由 EXIT=1 变 EXIT=0 并打印"一致 ✅"。
 *    现在照 `scripts/wasm/check-authoring-claims.mjs` 的模式补三条**互相独立**的判据：
 *      ① 登记值：`SCAN_PATHS` 必须覆盖 `REQUIRED_SCAN_PATHS` 每一项（删任一项即红）；
 *      ② 派生真源：守卫**直接判定**的 `server/AGENTS.md` 必须在扫描面内（"判什么"与
 *         "扫什么"脱节即红，与①互相独立）；
 *      ③ 树派生：仓库里存在的用户可见文档真源（`site/src/content/docs`）必须在扫描面内。
 *    另加只在真仓形态的根上强制的绝对下限（每根 md 数 / 全仓 md 数 / 每根被判定的区间
 *    表达式条数）—— 防"根还在、内容被搬走/排除规则吃空"。任一条不成立即退出码 2。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const args = process.argv.slice(2)
let root = resolve(process.cwd())
let json = false
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--root') {
    const value = args[index + 1]
    if (value === undefined) {
      console.error('check-migration-range: --root 需要一个目录')
      process.exit(2)
    }
    root = resolve(value)
    index += 1
  } else if (args[index] === '--json') json = true
  else {
    console.error(`check-migration-range: 未知参数 ${args[index]}`)
    process.exit(2)
  }
}

const MIGRATION_DIR = 'server/internal/serverstore/migrations-pg'
// `site/src/content/docs`（官网 wiki，中英各一份）必须在内：它是**面向用户**的同一批
// 数字，漏扫 = 同一处漂移在 docs/ 里被拦住、在官网上照旧发布（2026-09-23 D-6）。
const SCAN_PATHS = ['server/docs', 'server/AGENTS.md', 'AGENTS.md', 'docs', 'site/src/content/docs']
/**
 * 缩面判据①（登记值）：`SCAN_PATHS` 必须**全覆盖**这份登记清单 —— 删掉任一项
 * （例如把 `site/src/content/docs` 去掉）都让"文档区间都有判据"变成假话，而"扫描面为 0"
 * 这道地板是零点，部分缩面永远触发不到。改扫描面必须同时改这里（进 diff、可评审）。
 */
const REQUIRED_SCAN_PATHS = ['server/docs', 'server/AGENTS.md', 'AGENTS.md', 'docs', 'site/src/content/docs']
/**
 * 缩面判据②（派生真源）：本守卫**直接判定**的文件（AGENTS.md 的迁移号判据）必须落在
 * 扫描面内 —— "判什么"与"扫什么"脱节时当场红，与①互相独立（同时改两份清单也躲不过）。
 */
const DIRECTLY_JUDGED_FILES = ['server/AGENTS.md']
/**
 * 缩面判据③（树派生）：仓库里**存在**的用户可见文档真源必须在扫描面内。
 * 夹具树没有这个目录 ⇒ 天然放行；真仓删掉它却把 SCAN_PATHS 也删了 ⇒ 当场红。
 */
const DERIVED_SCAN_ROOTS = ['site/src/content/docs']
/**
 * 绝对下限（只在"真仓形态的根"上强制；合成树夹具只需非空）。
 * 下界取当前实测值再留余量：实测 server/docs=13 / docs=23 / site=34（合计 72 个 md），
 * 被判定的区间表达式 server/docs 2 条、site 2 条、server/AGENTS.md 2 条。
 * 只允许被"变多"越过 —— 变少说明根被搬空、或判据素材被摘掉。
 */
const SCAN_PATH_MIN_FILES = { 'server/docs': 8, docs: 15, 'site/src/content/docs': 20 }
const MIN_SCANNED_FILES = 50
/** 按根计的**语义**地板：漂移最可能住的根必须仍在贡献被判定的区间表达式。 */
const MIN_RANGE_CANDIDATES_BY_PATH = { 'server/docs': 1, 'site/src/content/docs': 1 }
/**
 * 记录面：记录"当时"的事实，不跟随 MAX（理由见头注释第 4 条）。
 *   · `docs/planning|decisions|releases`、`docs/AUDIT-*`：计划/决策/发布/审计留痕；
 *   · `server/docs/superpowers/**`：上游同源的计划与清账记录；
 *   · **带日期文件名**（`YYYY-MM-DD-*.md`）：按命名即"某一天的记录"（实测踩到
 *     `server/docs/superpowers/plans/2026-08-12-audit-findings-fix-plan.md` 里
 *     "迁移 0001-0016 过时(实际 0001-0017)" —— 那句正是**当时**的审计发现）。
 * 记录面之外一律硬判（改不动就加行内 `migration-range:allow`）。
 */
const RECORD_SURFACES = [
  /^docs\/planning\//u, /^docs\/decisions\//u, /^docs\/releases\//u, /^docs\/AUDIT-/u,
  /^server\/docs\/superpowers\//u,
  /\/\d{4}-\d{2}-\d{2}-[^/]*\.md$/u,
]
const ALLOW_MARKER = 'migration-range:allow'

const migrationPath = join(root, MIGRATION_DIR)
if (!existsSync(migrationPath)) {
  console.error(`check-migration-range: 找不到迁移目录 ${MIGRATION_DIR}（root=${root}）—— 拒绝把"扫不到"当通过`)
  process.exit(1)
}
const numbers = readdirSync(migrationPath)
  .map(name => /^(\d{4})_.*\.sql$/u.exec(name)?.[1])
  .filter(value => value !== undefined)
  .map(Number)
  .sort((a, b) => a - b)
if (numbers.length === 0) {
  console.error(`check-migration-range: ${MIGRATION_DIR} 里没解析出任何 00NN_*.sql —— 拒绝把空集当通过`)
  process.exit(1)
}
const MIN = numbers[0]
const MAX = numbers.at(-1)
const present = new Set(numbers.map(value => String(value).padStart(4, '0')))
const pad = value => String(value).padStart(4, '0')

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

const failures = []
const hits = []
let scanned = 0
/** 每个扫描根的实际产出（缩面判据的绝对下限按它判，不是靠"总数看着还行"）。 */
const perScanPath = new Map()

/** 区间表述：`0001–0060` / `0001-0060` / `0001 与 0060` / `0001~0060` / `0001 到 0060`。 */
const RANGE = /(\d{4})\s*(?:[–—~-]|到|至|与|和|、)\s*(\d{4})/gu
const MIGRATION_WORD = /迁移|migration|schema|migrations-pg/iu

for (const target of SCAN_PATHS) {
  const stats = { files: 0, rangeCandidates: 0 }
  perScanPath.set(target, stats)
  for (const file of walk(target)) {
    if (RECORD_SURFACES.some(pattern => pattern.test(file))) continue
    scanned += 1
    stats.files += 1
    const lines = readFileSync(join(root, file), 'utf8').split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      if (line.includes(ALLOW_MARKER)) continue
      for (const match of line.matchAll(RANGE)) {
        const lower = Number(match[1])
        const upper = Number(match[2])
        // 只把"迁移区间"当判据：下界是 MIN，或该行出现迁移相关词。
        if (lower !== MIN && !MIGRATION_WORD.test(line)) continue
        stats.rangeCandidates += 1
        if (upper === MAX) continue
        // 行内已显式列出 MAX（例如 `0001–0072 与 0075、0076`）⇒ 区间不是上限断言。
        if (new RegExp(`\\b${pad(MAX)}\\b`, 'u').test(line)) continue
        hits.push({
          file,
          line: index + 1,
          claimed: pad(upper),
          text: line.trim().slice(0, 200),
          reason: `声称上限 ${pad(upper)}，实际 MAX ${pad(MAX)}`,
        })
      }
    }
  }
}

// server/AGENTS.md：四位数迁移号必须都真实存在（写了不存在的迁移会误导施工）。
const agentsPath = join(root, 'server/AGENTS.md')
const unknownIds = []
let agentsScanned = false
if (existsSync(agentsPath)) {
  agentsScanned = true
  const lines = readFileSync(agentsPath, 'utf8').split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.includes(ALLOW_MARKER) || !MIGRATION_WORD.test(line)) continue
    for (const match of line.matchAll(/\b(0\d{3})\b/gu)) {
      if (!present.has(match[1])) unknownIds.push({ file: 'server/AGENTS.md', line: index + 1, id: match[1] })
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 缩面判据（R4-A-4）：扫描面被改窄**必须 fail-loud**。三条互相独立（任一缺项即退出码 2）：
//   ① 登记清单全覆盖（代码级，与树无关）；② 守卫直接判定的文件必须在扫描面内；
//   ③ 树里存在的用户可见文档真源必须在扫描面内。绝对下限只在**真仓形态的根**上强制
//   （夹具树只需非空）——否则`--root` 合成树会被这些下限判死（那是假红，不是判据）。
// ─────────────────────────────────────────────────────────────────────────────
const surfaceProblems = []
const strictSurface = existsSync(join(root, 'package.json')) && existsSync(migrationPath)

for (const required of REQUIRED_SCAN_PATHS) {
  if (!SCAN_PATHS.includes(required)) {
    surfaceProblems.push(`SCAN_PATHS 缺少登记项 ${required}（REQUIRED_SCAN_PATHS）—— 判据静默缩水，拒绝出结论`)
  }
}
for (const file of DIRECTLY_JUDGED_FILES) {
  const covered = SCAN_PATHS.some(target => file === target || file.startsWith(`${target}/`))
  if (!covered) {
    surfaceProblems.push(`守卫直接判定的 ${file} 不在 SCAN_PATHS 内 —— "判什么"与"扫什么"脱节`
      + `（当前扫描面：${SCAN_PATHS.join('、')}）`)
  }
}
for (const derived of DERIVED_SCAN_ROOTS) {
  if (existsSync(join(root, derived)) && !SCAN_PATHS.includes(derived)) {
    surfaceProblems.push(`仓库里存在 ${derived}（用户可见文档真源）却不在 SCAN_PATHS 内 ——`
      + ' 同一处区间漂移会在 docs/ 里被拦住、在官网上照旧发布（2026-09-23 D-6 的形态）')
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
  for (const [target, minimum] of Object.entries(MIN_RANGE_CANDIDATES_BY_PATH)) {
    const got = perScanPath.get(target)?.rangeCandidates ?? 0
    if (got < minimum) {
      surfaceProblems.push(`扫描根 ${target} 只贡献 ${got} 条被判定的迁移区间表达式（下限 ${minimum}）——`
        + ' 漂移最可能住的根已经从判据里消失，剩下来的"一致 ✅"是空话')
    }
  }
}

if (json) {
  console.log(JSON.stringify({
    root, min: pad(MIN), max: pad(MAX), scanned,
    perScanPath: Object.fromEntries(perScanPath), hits, unknownIds, surfaceProblems,
  }, null, 2))
} else {
  console.log(`check-migration-range: 实际迁移 ${pad(MIN)}–${pad(MAX)}（${numbers.length} 个）；扫描 ${scanned} 个 md（root=${root}）`)
  console.log(`  扫描面：${SCAN_PATHS.map(target => `${target} ${perScanPath.get(target)?.files ?? 0}`
    + `(区间候选 ${perScanPath.get(target)?.rangeCandidates ?? 0})`).join(' / ')}${strictSurface ? '' : '（夹具树：只查非空，不查绝对下限）'}`)
}

for (const hit of hits) {
  console.error(`  [RANGE] ${hit.file}:${hit.line}: ${hit.reason}`)
  console.error(`          ${hit.text}`)
}
for (const unknown of unknownIds) {
  console.error(`  [UNKNOWN-ID] ${unknown.file}:${unknown.line}: 迁移号 ${unknown.id} 在实际目录里不存在`)
}

// 扫描面缩水 = **前置失败**（退出码 2，与"有漂移"的 1 区分）：此时"一致 ✅"是一个
// 没被检查过的结论。
if (surfaceProblems.length > 0) {
  for (const message of surfaceProblems) console.error(`  [SURFACE] ${message}`)
  console.error(`\ncheck-migration-range: 扫描面缩水/前置缺失 ${surfaceProblems.length} 处 —— 拒绝把"没扫到"当"一致"。\n`
    + '  修法：把被删的扫描根加回 SCAN_PATHS（要真的收窄口径，必须同时改 REQUIRED_SCAN_PATHS 并进 diff）；'
    + '夹具树请只放被扫文档，绝对值下限只在真仓形态的根上强制。')
  process.exit(2)
}

if (hits.length > 0 || unknownIds.length > 0) {
  console.error(`\n迁移区间漂移 ${hits.length} 处 / 不存在的迁移号 ${unknownIds.length} 处。`
    + `修法：把区间上限改成 ${pad(MAX)}；若该行是**记录当时事实**的历史文档，`
    + `请加行内标记 \`${ALLOW_MARKER}\`（不要改整条规则）。`)
  process.exit(1)
}

// 扫描面不完整一律 fail-loud：零文档、或缺 server/AGENTS.md 时，下面那句"一致 ✅"是在
// 宣称一件**根本没检查**的事（第三轮审计 C-6 的形态：给一棵有迁移目录、零文档可扫的树，
// 它照样打印"文档区间与实际一致"并 exit 0，连那棵树里并不存在的 `server/AGENTS.md`
// 也一并宣称"迁移号都存在"）。`--root` 合成树/夹具同样适用：夹具必须自带被扫文档。
if (scanned === 0 || !agentsScanned) {
  console.error(`check-migration-range: 扫描面不完整（扫描 ${scanned} 个 md、`
    + `server/AGENTS.md ${agentsScanned ? '已扫' : '未找到'}，root=${root}）—— 拒绝把"没检查"当通过。`
    + '修法：确认扫描面存在（' + SCAN_PATHS.join('、') + '），或在合成树夹具里补齐被扫文档。')
  process.exit(1)
}

if (!json) console.log(`check-migration-range: 文档区间与实际一致（${pad(MIN)}–${pad(MAX)}），且 server/AGENTS.md 的迁移号都存在 ✅`)
