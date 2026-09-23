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
 * 退出码：0 = 文档与实际一致；1 = 有漂移；2 = 用法错误。
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

/** 区间表述：`0001–0060` / `0001-0060` / `0001 与 0060` / `0001~0060` / `0001 到 0060`。 */
const RANGE = /(\d{4})\s*(?:[–—~-]|到|至|与|和|、)\s*(\d{4})/gu
const MIGRATION_WORD = /迁移|migration|schema|migrations-pg/iu

for (const target of SCAN_PATHS) {
  for (const file of walk(target)) {
    if (RECORD_SURFACES.some(pattern => pattern.test(file))) continue
    scanned += 1
    const lines = readFileSync(join(root, file), 'utf8').split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      if (line.includes(ALLOW_MARKER)) continue
      for (const match of line.matchAll(RANGE)) {
        const lower = Number(match[1])
        const upper = Number(match[2])
        // 只把"迁移区间"当判据：下界是 MIN，或该行出现迁移相关词。
        if (lower !== MIN && !MIGRATION_WORD.test(line)) continue
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

if (json) {
  console.log(JSON.stringify({ root, min: pad(MIN), max: pad(MAX), scanned, hits, unknownIds }, null, 2))
} else {
  console.log(`check-migration-range: 实际迁移 ${pad(MIN)}–${pad(MAX)}（${numbers.length} 个）；扫描 ${scanned} 个 md（root=${root}）`)
}

for (const hit of hits) {
  console.error(`  [RANGE] ${hit.file}:${hit.line}: ${hit.reason}`)
  console.error(`          ${hit.text}`)
}
for (const unknown of unknownIds) {
  console.error(`  [UNKNOWN-ID] ${unknown.file}:${unknown.line}: 迁移号 ${unknown.id} 在实际目录里不存在`)
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
