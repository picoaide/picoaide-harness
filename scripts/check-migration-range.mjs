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
 * 用法：node scripts/check-migration-range.mjs [--root <dir>] [--json] [--print-checksums]
 * 退出码：0 = 文档与实际一致；1 = 有漂移 / 扫描面为 0；2 = 用法错误 / **扫描面缩水**（见 §6）。
 *   · 默认扫描根 = **脚本自己的仓库根**（`import.meta.url` 相对推导，与 cwd 无关）；
 *   · `--print-checksums` 只把 `migrations-checksums.json` 的内容打到 stdout（不写盘），
 *     供"新增迁移"时重新生成登记表。
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
 *
 * 7. **内容不可变判据**（2026-09-26 第二十一轮 FIX-9）：本守卫同时判"迁移文件有没有被就地
 *    改写"（判据与依据见下方 `内容不可变判据` 段）。要点：
 *      · 登记表 = `server/internal/serverstore/migrations-checksums.json`（进 diff、可评审）；
 *      · 双向：改写 / 新增未登记 / 死条目 / 登记表缺失或不合规 / 空表，**全部**红（EXIT=1）；
 *      · 只做 sha256 与字节比较，**不做换行归一**（迁移正文是逐字节契约；跨平台一致由根
 *        `.gitattributes` 的 `* text=auto eol=lf` 提供，见该段注释）；
 *      · 判据作用域 = 仓库形态的根（有 `package.json`）或带登记表的根；合成夹具根上
 *        **不出结论并如实打印 `[CONTENT-SKIP]`**，通过行同步说明"该判据未参与"；
 *      · 真 git 工作树上再加一层：登记值必须等于 **HEAD 里那个文件的字节**，于是
 *        "改文件 + 顺手改登记值"这条绕过在**提交之前**也红（取不到 git 时只如实降级，
 *        不假装对上了）。
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 脚本自身所在的**仓库根**（`import.meta.url` 相对推导）。
 *
 * 为什么不用 `process.cwd()`：默认扫描根曾经是 `resolve(process.cwd())`，于是"从别的目录
 * 跑一次"就换了一棵树 —— 本仓历史上出现过"扫描根不是仓库根却 EXIT=0"的假绿
 * （`docs/AUDIT-2026-09-23-FULL.md` 的 C-6：合成树/错 cwd 上照样宣称"一致 ✅"）。
 * 现在默认根恒等于脚本自己的仓库根，与调用方的 cwd 无关。
 */
const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const args = process.argv.slice(2)
let root = SCRIPT_ROOT
let json = false
/** `--print-checksums`：把登记表内容打到 stdout（**只打印，不写盘**）；见 §内容不可变判据。 */
let printChecksums = false
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
  else if (args[index] === '--print-checksums') printChecksums = true
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

// ─────────────────────────────────────────────────────────────────────────────
// 内容不可变判据（2026-09-26 第二十一轮 FIX-9）：迁移文件的 sha256 逐条登记 + 双向对拍
//
// 起因（`temp/r21/fix-3/notes-4.md`，只读复核 441 行）：本仓至少 6 次**就地改写已应用迁移**
// （`0004` 2026-08-27、`0039`/`0054`/`0055` 2026-09-24 `e1e3b0155b`、`0063` 2026-09-16、
// `0042` 2026-09-20/09-21），而 `schema_migrations` 只有 `(version, applied_at)` 两列、
// `ApplyMigrations` 对已记录版本 `continue` ⇒ 每一条这样的改写**只对尚未执行过该版本的库生效**，
// 已部署库永远拿不到（`0054`/`0055` 那批修复对"从 v2.5.9 起升过级"的所有实例不可达）。
// `server/docs/06-database.md` 早在 2026-09-23 就把纪律写成"已应用的迁移文件永不原地修改"，
// 而写下它的**次日** `e1e3b0155b` 就违反了它 —— 原因是那条纪律**只有文字、没有判据**。
//
// 判据（与上面的区间判据**同一进程、同一 EXIT 语义**：1 = 有漂移，2 = 扫描面/前置缺失）：
//   ① 已登记文件被修改 ⇒ 红（点名版本号 + 期望/实际 sha256）；
//   ② 新增迁移未登记   ⇒ 红（点名文件 + 把 sha256 登记进登记表，让"新增迁移"这一步必须进 diff）；
//   ③ 登记表里的死条目（登记了但文件不存在）⇒ 红；
//   ④ 登记表缺失 / 解析不出 / 缺字段 / 空表 ⇒ 红（fail-closed，**绝不**静默当成空表）；
//   ⑤ 双向：既不能放过改写，也不能因为"登记表是空的"而静默通过。
//
// 登记表 = `server/internal/serverstore/migrations-checksums.json`（**进 diff、可评审**；
// 由 `--print-checksums` 生成，守卫本身只读、从不写盘）。判据真源 = **磁盘字节的 sha256**。
//
// 平台差异（CRLF）：**不做换行归一** —— 迁移正文是逐字节契约（`//go:embed migrations-pg/*.sql`
// 把字节原样带进二进制，runner 把它们原样交给 PG）。跨平台一致由根 `.gitattributes` 的
// `* text=auto eol=lf` 保证：`sql` 被判定为文本 ⇒ checkout 时强制 LF，Windows 上也是 LF 字节
// （`git check-attr -a` 对迁移文件回报 `eol: lf`），所以单纯检出不会误红。若哪天真的出现
// "只差 CRLF"的形态，守卫**照红**并额外提示这可能是检出配置（`.gitattributes` 被改）所致 ——
// 宁可让人看一眼，也不把字节契约降级成"差不多就行"。
// ─────────────────────────────────────────────────────────────────────────────
const CHECKSUMS_POINTER = 'server/internal/serverstore/migrations-checksums.json'
const CHECKSUMS_PATH = join(root, CHECKSUMS_POINTER)
const CHECKSUMS_SCHEMA = 'picoaide-migration-checksums/1'
/** 登记表表头里**必须**存在的字符串字段（谁生成 / 怎么更新 / 为什么）——删掉任何一个即红。 */
const CHECKSUMS_HEADER_FIELDS = ['schema', 'algorithm', 'generatedBy', 'howToUpdate', 'why']
const SQL_NAME = /^(\d{4})_.*\.sql$/u
const SHA256_HEX = /^[0-9a-f]{64}$/u
const REGENERATE_COMMAND = 'node scripts/check-migration-range.mjs --print-checksums'
const REGENERATE_HINT = `把该文件的 sha256 登记进 ${CHECKSUMS_POINTER}`
  + `（重新生成：\`${REGENERATE_COMMAND} > ${CHECKSUMS_POINTER}\`）`

const migrationPath = join(root, MIGRATION_DIR)
if (!existsSync(migrationPath)) {
  console.error(`check-migration-range: 找不到迁移目录 ${MIGRATION_DIR}（root=${root}）—— 拒绝把"扫不到"当通过`)
  process.exit(1)
}
/**
 * `readdirSync` 出来的目录项**是不是普通文件**（R23 FIX-22 / W4-09 的唯一实现）。
 *
 * 修前这里直接 `statSync(...).isFile()`：**悬空符号链接**会让 `statSync` 抛 `ENOENT`，
 * 守卫以**未捕获堆栈**退出（`Error: ENOENT: no such file or directory, stat '…/0080_…sql'`，
 * `EXIT=1`）—— fail-closed 方向是对的，但诊断指向 `stat` 内部而不是"迁移文件不可用"这一类
 * 可操作结论，而且它与"扫描面缺失"共用 exit 1，读者分不清是"内容被改写"还是"根本扫不动"。
 * 现在：坏条目逐个**具名**收集，随后以 **EXIT=2（扫描面前置失败）** 报出。
 * @param name - `migrations-pg/` 下的目录项名。
 * @returns `true` = 可以按普通文件读。
 */
function migrationEntryIsFile(name) {
  try {
    return statSync(join(migrationPath, name)).isFile()
  } catch (error) {
    brokenMigrationEntries.push({ name, code: error?.code ?? 'UNKNOWN', message: error?.message ?? String(error) })
    return false
  }
}
/** 读不动的目录项（悬空符号链接 / 权限 / 其它 ENOENT 形态）——见 {@link migrationEntryIsFile}。 */
const brokenMigrationEntries = []
const numbers = readdirSync(migrationPath)
  // **R22 FIX-14**：与下面的 `sqlFiles` 同一口径 —— 必须过 `isFile()`。修前只按**文件名**
  // 取数，于是一个名叫 `0090_x.sql` 的**目录**会把"实际 MAX"顶到 0090（迫使改多处文档区间），
  // 而同一份输出里还能同时出现"75 个"（按名字数）与"74 个 .sql"（`sqlFiles` 过了 `isFile()`）
  // —— 计数口径不一致本身就是可诊断性缺陷（V4 泳道 N3）。
  .filter(name => migrationEntryIsFile(name))
  .map(name => /^(\d{4})_.*\.sql$/u.exec(name)?.[1])
  .filter(value => value !== undefined)
  .map(Number)
  .sort((a, b) => a - b)
// **R23 FIX-22 / W4-09**：扫不动的目录项是**扫描面前置失败**（EXIT=2），先于任何内容判据报出。
if (brokenMigrationEntries.length > 0) {
  for (const entry of brokenMigrationEntries) {
    console.error(`  [SURFACE] ${MIGRATION_DIR}/${entry.name} 读不动（${entry.code}）：${entry.message}`)
  }
  console.error(`\ncheck-migration-range: ${MIGRATION_DIR} 里有 ${brokenMigrationEntries.length} 个目录项读不动 ——`
    + ' 悬空符号链接 / 权限 / 权限以外的 ENOENT 都会让"内容不可变"这一层根本扫不动。'
    + '修法：把该路径恢复成**普通文件**（迁移只能是仓内文件，`//go:embed migrations-pg/*.sql` 读的就是它），'
    + '或删掉这个悬空链接。\n')
  process.exit(2)
}
if (numbers.length === 0) {
  console.error(`check-migration-range: ${MIGRATION_DIR} 里没解析出任何 00NN_*.sql —— 拒绝把空集当通过`)
  process.exit(1)
}
const MIN = numbers[0]
const MAX = numbers.at(-1)
const present = new Set(numbers.map(value => String(value).padStart(4, '0')))
const pad = value => String(value).padStart(4, '0')

/** `migrations-pg/` 下**每一个** `.sql`（不只 `00NN_*.sql`：名字不合规的也要进对拍面）。 */
const sqlFiles = readdirSync(migrationPath)
  .filter(name => name.endsWith('.sql'))
  .filter(name => migrationEntryIsFile(name))
  .sort()
/** 一段字节的 sha256（小写 hex）。 */
const sha256 = data => createHash('sha256').update(data).digest('hex')

/**
 * 登记表的**规范文本**（`--print-checksums` 与"重新生成"提示共用同一个实现，
 * 所以"文档说的生成方式"与"实际生成物"不可能漂移）。
 * @returns 可直接落盘/进 diff 的 JSON 文本（含尾换行）。
 */
function renderChecksums() {
  // **R22 FIX-14**：生成与校验**必须同源** —— 登记表的 schema 只收 `00NN_名字.sql`
  // （见 `checksumEntryProblems`），而修前 `--print-checksums` 会把 `foo.sql` 一起写进表里，
  // 于是守卫给的"重新生成"指引**不可执行**：照着做一次，登记表立刻因为条目不合规而红
  // （两段文案互相矛盾，V4 泳道 N3 实测）。正确出路是**改名/删掉那个文件**，不是把它登记进去。
  const invalid = sqlFiles.filter(name => !SQL_NAME.test(name))
  if (invalid.length > 0) {
    console.error(`check-migration-range: 拒绝为**不合规文件名**生成登记表：${invalid.join('、')}`
      + ` —— 登记表只登记 \`00NN_名字.sql\`（${MIGRATION_DIR} 下的迁移文件名是运行期契约：`
      + '`//go:embed migrations-pg/*.sql` 与 runner 都按这个形态认版本号）。'
      + '请把文件改名成规范形态（或删掉它），**不要**把它写进登记表。')
    process.exit(2)
  }
  const entries = sqlFiles.map((name) => {
    const bytes = readFileSync(join(migrationPath, name))
    return {
      version: SQL_NAME.exec(name)?.[1] ?? name.replace(/\.sql$/u, ''),
      file: name,
      bytes: bytes.length,
      sha256: sha256(bytes),
    }
  })
  return `${JSON.stringify({
    schema: CHECKSUMS_SCHEMA,
    algorithm: 'sha256',
    generatedBy: 'node scripts/check-migration-range.mjs --print-checksums',
    why: '已应用的迁移会被 `ApplyMigrations` 按版本号跳过、正文不再参与判定'
      + '（`schema_migrations` 只有 (version, applied_at) 两列），所以"文件被就地改写"'
      + '在运行期完全不可见：旧的已部署库永远拿不到改写后的内容。本表把每个迁移文件的字节'
      + '摘要冻结下来，让"改写历史迁移"这件事在任何一次门禁里都必须显式出现在 diff 中。',
    howToUpdate: '只在**新增**迁移时更新：跑 `node scripts/check-migration-range.mjs --print-checksums`'
      + ` 覆盖本文件，把新增行与迁移文件放在同一个 PR 里评审。**永不**为了让守卫变绿而改已有条目的 sha256`
      + ' —— 那正是本判据要拦的事；要改数据请加新迁移。',
    entries,
  }, null, 2)}\n`
}

if (printChecksums) {
  // 只打印、不写盘：写入必须经过人评审的 diff（与 `check-guard-parser-integrity --print-digests` 同纪律）。
  process.stdout.write(renderChecksums())
  process.exit(0)
}

/**
 * 内容判据的**作用域**：登记表存在，或扫描根本身是仓库形态（有 `package.json`）。
 *
 * - 真仓（默认根 = `SCRIPT_ROOT`）：必然在作用域内 —— 登记表缺失即红。
 * - 仓库形态副本（`git archive HEAD | tar -x` 的深拷贝，供变异/回归）：在作用域内 ⇒
 *   对副本的改写照样能被判红（这正是"判据可被杀死"的前提）。
 * - 合成夹具树（`verify-check-workspaces.mjs` 的 `--root <tree>`，只有 `server/**` 没有
 *   `package.json`）：**不在**作用域内。此时守卫**不宣称**内容不可变（见通过行与
 *   `[CONTENT-SKIP]` 提示），绝不打印一句它没检查过的"内容一致 ✅"。
 */
const rootIsRepoShaped = existsSync(join(root, 'package.json'))
const contentInScope = existsSync(CHECKSUMS_PATH) || rootIsRepoShaped
/** 红（与区间漂移同一桶 ⇒ EXIT=1）。 */
const contentProblems = []
/** 如实降级/提示（不判红，但必须打印出来，不许静默）。 */
const contentNotices = []
/**
 * "登记值 vs 已提交字节"（第⑥层）**这次是否真的参与**（R22 FIX-14）。
 * 只影响**通过行的措辞**：没参与就不得宣称"与提交态一致"。
 */
let headLayerRan = false
/**
 * **"基线 tag 字节 vs 磁盘"这一层这次是否真的参与**（R23 FIX-22 / W4-03）—— 只影响通过行措辞。
 */
let baselineLayerRan = false

/**
 * **已发布基线 tag** 的选择（R23 FIX-22 / W4-03 的唯一实现）。
 *
 * ## 为什么参照物不能是 `HEAD`
 *
 * 修前反向断言的参照物是 `HEAD`，而 PR 的变异**就是** HEAD：改完提交之后 HEAD 与磁盘自洽，
 * `git ls-tree -r HEAD` 的集合包含关系恒成立、登记表与 HEAD 的逐文件对拍同样自洽。实测
 * （第二十三轮 W4，真 git 仓）：`git mv 0080_x.sql 0080_x_r.sql` + 改正文 + 重新生成登记表
 * + `git commit` ⇒ `EXIT=0`，而通过行照旧印"74 个迁移文件的 sha256 与 …逐条一致 ✅"；
 * 只改正文 + 同步登记值 + commit、删文件 + 同步登记表 + commit 同样绿。
 *
 * ## 选择规则（写死在代码里；改它必须进 diff，改完要同步本文件的注释与报告）
 *
 *   1. 候选 = `git tag --list 'v*'` 里**是 HEAD 祖先**、且**不指向 HEAD 自身**的 tag
 *      —— 后者排除掉"tag 构建"（HEAD 就是那个 tag）时的自证同义反复；
 *   2. 取**版本最高**的一个：`v<主>.<次>.<修订>[-预发]` 逐字段数值比较，
 *      同版本号时**预发 < 正式**（semver 口径），预发之间按后缀字符串倒序（beta.2 > beta.1）；
 *   3. 一个都没有 / git 不可用 / tag 里没有迁移目录 ⇒ **响亮降级**（{@link contentNotices}
 *      的 `[CONTENT-SKIP]` + 通过行不得宣称"逐条一致"，见 `baselineLayerClause`）。
 *      绝不静默绿：这条判据的全部价值就在"基线不受本 PR 影响"。
 *
 * ## 判据
 *
 * 基线 tag 里出现过的**每一个**迁移路径，今天都必须在磁盘上、且**字节逐字不变**
 * （`git show <tag>:<路径>` 的 sha256 vs 磁盘 sha256）。**新增文件允许** —— 这正是
 * "迁移只能新增"这句承诺的机械形态。
 * @returns `{ tag, version }`；取不到基线时返回 `null`。
 */
function publishedMigrationBaselineTag() {
  const listed = spawnSync('git', ['-C', root, 'tag', '--list', 'v*'], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  })
  if (listed.error !== undefined || listed.status !== 0 || typeof listed.stdout !== 'string') return null
  const parse = tag => {
    const match = /^v(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/u.exec(tag)
    return match === null ? null : {
      tag, major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]),
      pre: match[4] ?? null,
    }
  }
  const candidates = []
  for (const tag of listed.stdout.split('\n').map(line => line.trim()).filter(line => line !== '')) {
    const parsed = parse(tag)
    if (parsed === null) continue
    // 是 HEAD 的祖先、且不指向 HEAD 自身（`git merge-base --is-ancestor` 的退出码语义）。
    const ancestor = spawnSync('git', ['-C', root, 'merge-base', '--is-ancestor', tag, 'HEAD'], { encoding: 'utf8' })
    if (ancestor.status !== 0) continue
    const pointsAtHead = spawnSync('git', ['-C', root, 'rev-parse', `${tag}^{commit}`], { encoding: 'utf8' })
    const head = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD^{commit}'], { encoding: 'utf8' })
    if (pointsAtHead.status === 0 && head.status === 0
      && String(pointsAtHead.stdout).trim() === String(head.stdout).trim()) continue
    candidates.push(parsed)
  }
  if (candidates.length === 0) return null
  candidates.sort((a, b) => (a.major - b.major) || (a.minor - b.minor) || (a.patch - b.patch)
    || ((a.pre === null ? 1 : 0) - (b.pre === null ? 1 : 0))
    || String(a.pre ?? '').localeCompare(String(b.pre ?? '')))
  const best = candidates.at(-1)
  // tag 里必须有迁移目录（否则基线取错了 ⇒ 按"取不到"降级，而不是当成"没有要保的路径"）。
  const probe = spawnSync('git', ['-C', root, 'ls-tree', '-r', '--name-only', best.tag, '--', MIGRATION_DIR], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  })
  if (probe.error !== undefined || probe.status !== 0) return null
  const paths = String(probe.stdout ?? '').split('\n').map(line => line.trim()).filter(line => line !== '')
  if (paths.length === 0) return null
  return { tag: best.tag, version: `v${best.major}.${best.minor}.${best.patch}${best.pre === null ? '' : `-${best.pre}`}`, paths }
}

/** 登记表条目形状校验；任何一处不成立都返回问题（fail-closed）。 */
function checksumEntryProblems(entries) {
  const problems = []
  if (!Array.isArray(entries)) return ['`entries` 必须是数组']
  if (entries.length === 0) return ['`entries` 是空数组 —— 空表等于"没有任何迁移被冻结"，拒绝当成通过']
  const byName = new Map()
  const byVersion = new Map()
  for (const [index, entry] of entries.entries()) {
    const at = `entries[${index}]`
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      problems.push(`${at} 不是对象`)
      continue
    }
    const { version, file, bytes, sha256: digest } = entry
    if (typeof version !== 'string' || !/^\d{4}$/u.test(version)) problems.push(`${at}.version 必须是四位字符串（实际 ${JSON.stringify(version ?? null)}）`)
    if (typeof file !== 'string' || !SQL_NAME.test(file)) problems.push(`${at}.file 必须是 00NN_*.sql（实际 ${JSON.stringify(file ?? null)}）`)
    if (typeof digest !== 'string' || !SHA256_HEX.test(digest)) problems.push(`${at}.sha256 必须是 64 位小写 hex（实际 ${JSON.stringify(digest ?? null)}）`)
    if (!Number.isSafeInteger(bytes) || bytes < 0) problems.push(`${at}.bytes 必须是非负整数（实际 ${JSON.stringify(bytes ?? null)}）`)
    if (typeof file === 'string' && typeof version === 'string') {
      const prefix = SQL_NAME.exec(file)?.[1]
      if (prefix !== undefined && prefix !== version) problems.push(`${at} 的 version(${version}) 与文件名前缀(${prefix}) 不一致`)
    }
    if (typeof file === 'string') {
      if (byName.has(file)) problems.push(`${at} 与 entries[${byName.get(file)}] 重复登记同一个文件 ${file}`)
      else byName.set(file, index)
    }
    if (typeof version === 'string') {
      if (byVersion.has(version)) problems.push(`${at} 与 entries[${byVersion.get(version)}] 重复登记同一个版本 ${version}`)
      else byVersion.set(version, index)
    }
  }
  return problems
}

if (contentInScope) {
  if (!existsSync(CHECKSUMS_PATH)) {
    contentProblems.push(`登记表缺失：${CHECKSUMS_POINTER}（root=${root} 是仓库形态）——`
      + ` 没有它就**无法**判断"已应用迁移有没有被就地改写"，拒绝静默通过。生成：\`${REGENERATE_COMMAND} > ${CHECKSUMS_POINTER}\``)
  } else {
    let parsed = null
    let rawText = null
    try {
      rawText = readFileSync(CHECKSUMS_PATH, 'utf8')
    } catch (error) {
      contentProblems.push(`登记表读不出：${CHECKSUMS_POINTER}（${error.message}）`)
    }
    if (rawText !== null) {
      try {
        parsed = JSON.parse(rawText)
      } catch (error) {
        contentProblems.push(`登记表不是合法 JSON：${CHECKSUMS_POINTER} —— ${error.message}`
          + `（**不**当成空表；重新生成：\`${REGENERATE_COMMAND} > ${CHECKSUMS_POINTER}\`）`)
      }
    }
    if (parsed !== null) {
      if (typeof parsed !== 'object' || Array.isArray(parsed)) {
        contentProblems.push(`登记表顶层必须是对象：${CHECKSUMS_POINTER}`)
      } else {
        const missing = CHECKSUMS_HEADER_FIELDS.filter(field => typeof parsed[field] !== 'string' || parsed[field].trim() === '')
        if (missing.length > 0) {
          contentProblems.push(`登记表表头缺字段：${CHECKSUMS_POINTER} 缺 ${missing.join('、')}`
            + '（表头写明"谁生成 / 怎么更新 / 为什么"，缺了就没人知道该不该动它）')
        }
        if (typeof parsed.schema === 'string' && parsed.schema !== CHECKSUMS_SCHEMA) {
          contentProblems.push(`登记表 schema 不认识：${parsed.schema}（期望 ${CHECKSUMS_SCHEMA}）`)
        }
        if (typeof parsed.algorithm === 'string' && parsed.algorithm !== 'sha256') {
          contentProblems.push(`登记表 algorithm 只支持 sha256（实际 ${parsed.algorithm}）`)
        }
        const entryProblems = checksumEntryProblems(parsed.entries)
        for (const problem of entryProblems) contentProblems.push(`登记表条目不合规：${CHECKSUMS_POINTER} 的 ${problem}`)
        if (entryProblems.length === 0) {
          const registered = new Map(parsed.entries.map(entry => [entry.file, entry]))
          const onDisk = new Set(sqlFiles)
          for (const entry of parsed.entries) {
            if (!onDisk.has(entry.file)) {
              contentProblems.push(`登记表死条目：${entry.file}（版本 ${entry.version}，root=${root}）在`
                + ` ${MIGRATION_DIR} 里不存在 —— 迁移**只能新增**，删/改名同样是"改写历史"，`
                + `请把文件恢复；确属误登记才重新生成：\`${REGENERATE_COMMAND} > ${CHECKSUMS_POINTER}\``)
              continue
            }
            const bytes = readFileSync(join(migrationPath, entry.file))
            const actual = sha256(bytes)
            if (actual === entry.sha256) continue
            // 只在**真的**"只差 CRLF 且去掉 CRLF 后恰好等于登记值"时才提示检出配置，
            // 避免把普通改写误诊成平台差异（判据仍是红：迁移正文是逐字节契约）。
            const hasCrlf = bytes.includes(0x0d)
            const crlfOnly = hasCrlf
              && sha256(Buffer.from(bytes.toString('utf8').replace(/\r\n/gu, '\n'), 'utf8')) === entry.sha256
              ? '（注意：去掉 CRLF 后**恰好**与登记值一致 ⇒ 先怀疑检出/`.gitattributes` 被改，不是内容被改）'
              : ''
            contentProblems.push(`已登记迁移被就地修改（版本 ${entry.version}）：${entry.file}\n`
              + `          期望 sha256 ${entry.sha256}（${CHECKSUMS_POINTER} 登记值）\n`
              + `          实际 sha256 ${actual}（磁盘 ${bytes.length} 字节；登记 ${entry.bytes} 字节）${crlfOnly}\n`
              + '          —— 已应用迁移永不原地修改；要改数据请**加新迁移**（幂等 + 可重放）。')
          }
          for (const name of sqlFiles) {
            if (registered.has(name)) continue
            if (!SQL_NAME.test(name)) {
              // **R22 FIX-14**：非规范名**不能**靠"登记进表"变绿（表 schema 拒收它）——
              // 修前这里给的 REGENERATE_HINT 是不可执行的指引（照做一次仍然红，两段文案
              // 互相矛盾）。诊断必须指向真正可行的修法。
              contentProblems.push(`新增迁移文件名不合规：${name}（版本号前缀取不出）—— `
                + `${MIGRATION_DIR} 下的文件名是运行期契约（\`00NN_名字.sql\`），`
                + 'runner 也认不出它。请把它**改名**成规范形态（或删掉），不要试图登记进登记表 —— '
                + `\`--print-checksums\` 会拒绝为不合规文件名生成登记表。`)
              continue
            }
            contentProblems.push(`新增迁移未登记：${name} —— ${REGENERATE_HINT}`
              + '，让"新增迁移"这一步必须进 diff 被评审')
          }
          // 追加一层：**"把文件与登记值一起改"这条最省事的绕过**也要红。
          // 只在真 git 工作树里判（`git archive` 深拷贝与合成夹具没有 `.git` ⇒ 天然跳过），
          // 判据 = HEAD 里那个 blob 的字节 sha256 必须等于登记值。于是"改历史迁移"这件事
          // 无法在**提交之前**把门禁弄绿：要么登记值与 HEAD 不一致（本条命中），要么
          // 登记值的改动必须进 diff（那正是本判据要的可见性）。
          // 取不到 git 输出（环境问题）时**不判红**、只如实打印降级 —— 判据的可靠性不该
          // 依赖"git 一定可用"，但"取不到"绝不等同于"对上了"。
          // **R22 FIX-14（V4 N1）**：第⑥层修前是**以登记表为驱动的一向遍历** ——
          // `if (typeProbe.status !== 0) continue // HEAD 里还没有它 ⇒ 新增迁移` 把"该路径在
          // HEAD 里不存在"一律当成"新增"，而**没有任何反向判据**（"HEAD 里有的迁移路径，
          // 今天还在不在、字节还一样不一样"）。于是一次 `git mv 0055_x.sql 0055_y.sql`
          // + 改正文 + 重新生成登记表 ⇒ 真 git 仓里 **EXIT=0**，通过行照旧印
          // "74 个迁移文件的 sha256 与 …逐条一致 ✅"（V4 最小反例 `mut/final-minimal`）。
          // 迁移**只能新增**：删/改名/移出索引都要红。
          const headLayerAvailable = existsSync(join(root, '.git'))
          if (headLayerAvailable) {
            let gitUsable = true
            headLayerRan = true
            // ⑥a **反向遍历**：HEAD 里的迁移路径集合必须 ⊆ 磁盘（少一个即红）。用
            // `git ls-tree -r --name-only HEAD -- <目录>`（**树证据**，不看提交图，
          // 也不受任何历史改写影响）。
            const listed = spawnSync('git', ['-C', root, 'ls-tree', '-r', '--name-only', 'HEAD', '--', MIGRATION_DIR], {
              encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
            })
            if (listed.error !== undefined || listed.status !== 0 || typeof listed.stdout !== 'string') {
              gitUsable = false
            } else {
              const headPaths = listed.stdout.split('\n')
                .map(line => line.trim())
                .filter(line => line !== '')
              const onDiskPaths = new Set(sqlFiles.map(name => `${MIGRATION_DIR}/${name}`))
              for (const path of headPaths) {
                if (onDiskPaths.has(path)) continue
                const name = path.startsWith(`${MIGRATION_DIR}/`) ? path.slice(MIGRATION_DIR.length + 1) : path
                contentProblems.push(`已提交的迁移文件在磁盘上不存在（改名 / 删除 / 移出索引）：${name}\n`
                  + `          HEAD 里有 \`${path}\`，而 ${MIGRATION_DIR} 下没有它`
                  + '（登记表可能被"顺手同步"过了）—— 迁移**只能新增**：删/改名同样是"改写历史"，'
                  + '已部署库按版本号记录过它，路径变了不会让任何库重跑，只会让新库与旧库分叉。\n'
                  + '          ⇒ 请把文件恢复成 HEAD 里的原名与内容；确属误提交才用 `git rm` 走评审。')
              }
            }
            for (const entry of parsed.entries) {
              if (!onDisk.has(entry.file)) continue
              const relativePath = `${MIGRATION_DIR}/${entry.file}`
              const typeProbe = spawnSync('git', ['-C', root, 'cat-file', '-e', `HEAD:${relativePath}`], { encoding: 'utf8' })
              if (typeProbe.error !== undefined || typeProbe.status === null) {
                gitUsable = false
                break
              }
              if (typeProbe.status !== 0) continue // HEAD 里还没有它 ⇒ 新增迁移，另一条判据管
              const committed = spawnSync('git', ['-C', root, 'show', `HEAD:${relativePath}`], {
                encoding: 'buffer', maxBuffer: 64 * 1024 * 1024,
              })
              if (committed.error !== undefined || committed.status !== 0 || !Buffer.isBuffer(committed.stdout)) {
                gitUsable = false
                break
              }
              const committedSha = sha256(committed.stdout)
              if (committedSha === entry.sha256) continue
              contentProblems.push(`登记值与**已提交字节**不一致（版本 ${entry.version}）：${entry.file}\n`
                + `          ${CHECKSUMS_POINTER} 登记 sha256 ${entry.sha256}\n`
                + `          HEAD 里该文件 sha256 ${committedSha}\n`
                + '          —— 文件与登记值被**一起**改过（否则上面那条"已登记迁移被就地修改"就已经红了）。'
                + '改写历史迁移没有"顺手更新校验和"这条出路：要改数据请加新迁移。')
            }
            // ── 已发布基线（**R23 FIX-22 / W4-03**）──────────────────────────────
            //
            // HEAD 只能回答"未提交的改动"，**不能**回答"这次提交有没有改写历史迁移"——
            // PR 的变异就是 HEAD。基线必须取一个**不受本 PR 影响**的参照物：最近的
            // 已发布 `v*` tag（选择规则见 `publishedMigrationBaselineTag()`）。
            const baseline = publishedMigrationBaselineTag()
            if (baseline === null) {
              contentNotices.push(`root=${root} 里取不到**已发布基线**（"是 HEAD 祖先且不指向 HEAD"的`
                + ' `v*` tag 一个都没有，或 git 读不出 tag 列表 / tag 里没有迁移目录）⇒'
                + ' "迁移路径与字节 vs **已发布基线**"这一层**未参与**（其余判据照常）。'
                + ' 别把这次 EXIT=0 读成"历史迁移没被改写"——要判这一层请在带 `v*` tag 的 git 工作树上跑'
                + "（`git tag --list 'v*'` 自查）。")
            } else {
              baselineLayerRan = true
              for (const path of baseline.paths) {
                const name = path.startsWith(`${MIGRATION_DIR}/`) ? path.slice(MIGRATION_DIR.length + 1) : path
                if (!onDisk.has(name)) {
                  contentProblems.push(`已发布基线（${baseline.tag}）里的迁移文件在磁盘上不存在`
                    + `（改名 / 删除 / 移出索引）：${name}\n`
                    + `          ${baseline.tag} 里有 \`${path}\`，而 ${MIGRATION_DIR} 下没有它`
                    + '（登记表可能被"顺手同步"过了）—— 迁移**只能新增**：删/改名同样是"改写历史"，'
                    + '已部署库按版本号记录过它，路径变了不会让任何库重跑，只会让新库与旧库分叉。\n'
                    + `          ⇒ 请把文件恢复成 ${baseline.tag} 里的原名与内容；确属误提交才用 \`git rm\` 走评审。`)
                  continue
                }
                const committed = spawnSync('git', ['-C', root, 'show', `${baseline.tag}:${path}`], {
                  encoding: 'buffer', maxBuffer: 64 * 1024 * 1024,
                })
                if (committed.error !== undefined || committed.status !== 0 || !Buffer.isBuffer(committed.stdout)) {
                  baselineLayerRan = false
                  contentNotices.push(`root=${root} 的基线 tag ${baseline.tag} 读不出 \`${path}\` 的字节 ⇒`
                    + ' "迁移字节 vs 已发布基线"这一层**未参与**（其余判据照常）。')
                  break
                }
                const baselineSha = sha256(committed.stdout)
                const diskSha = sha256(readFileSync(join(migrationPath, name)))
                if (baselineSha === diskSha) continue
                contentProblems.push(`已发布基线（${baseline.tag}）里的迁移被改写（版本 ${name.slice(0, 4)}）：${name}\n`
                  + `          ${baseline.tag} 里该文件 sha256 ${baselineSha}\n`
                  + `          磁盘上实际 sha256 ${diskSha}\n`
                  + '          —— 已应用迁移永不原地修改（`ApplyMigrations` 按版本号跳过，改正文对'
                  + '已部署库完全不可见），要改数据请**加新迁移**。\n'
                  + '          （把登记表里的 sha256 一起改掉也绕不过这一条：基线 tag 不受本 PR 影响。）')
              }
            }
            if (!gitUsable) {
              contentNotices.push(`root=${root} 是 git 工作树，但 git 读取 HEAD 失败 ⇒`
                + ' "登记值 vs 已提交字节"与"HEAD 侧路径集合 ⊆ 磁盘"这一层**未参与**（其余判据照常）。'
                + '别把这次通过读成"登记值与提交态一致"。')
            }
          } else {
            // **R22 FIX-14（V4 N2/④）**：修前这条提示在 `if (existsSync(join(root, '.git')))`
            // 的**内层**（只有"`.git` 在场但 git 读不出"才打印），于是"仓库形态但没有 `.git`"
            // 的根（`git archive HEAD | tar -x` 深拷贝、源码 tarball、Docker 构建上下文、
            // `--root <导出树>`）上第⑥层**静默跳过**、一条提示都不打，而通过行照旧宣称
            // "逐条一致 ✅"。降级必须在两种形态下**同口径**披露。
            contentNotices.push(`root=${root} 是仓库形态但**没有 \`.git\`**（不是 git 工作树）⇒`
              + ' "登记值 vs 已提交字节"与"HEAD 侧路径集合 ⊆ 磁盘"这一层**未参与**（其余判据照常）。'
              + ' 别把这次 EXIT=0 读成"登记值与提交态一致"——要判这一层请在 git 工作树里跑。')
          }
        }
      }
    }
  }
} else {
  contentNotices.push(`root=${root} 既不是仓库根（没有 package.json）也不是带登记表的仓库形态副本 ⇒`
    + ` **迁移内容不可变判据本次未参与**（只在仓库根或 \`git archive HEAD\` 深拷贝上成立）。`
    + ` 别把这次 EXIT=0 读成"迁移文件没被动过"。`)
}

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
    contentInScope, contentProblems, contentNotices, migrationFiles: sqlFiles.length,
  }, null, 2))
} else {
  console.log(`check-migration-range: 实际迁移 ${pad(MIN)}–${pad(MAX)}（${numbers.length} 个）；扫描 ${scanned} 个 md（root=${root}）`)
  console.log(`  扫描面：${SCAN_PATHS.map(target => `${target} ${perScanPath.get(target)?.files ?? 0}`
    + `(区间候选 ${perScanPath.get(target)?.rangeCandidates ?? 0})`).join(' / ')}${strictSurface ? '' : '（夹具树：只查非空，不查绝对下限）'}`)
  console.log(contentInScope
    ? `  迁移内容：${sqlFiles.length} 个 .sql 逐条对拍 ${CHECKSUMS_POINTER}`
    : `  迁移内容：**未判**（root=${root} 不是仓库形态，见下方 [CONTENT-SKIP]）`)
}

for (const notice of contentNotices) console.error(`  [CONTENT-SKIP] ${notice}`)
for (const hit of hits) {
  console.error(`  [RANGE] ${hit.file}:${hit.line}: ${hit.reason}`)
  console.error(`          ${hit.text}`)
}
for (const unknown of unknownIds) {
  console.error(`  [UNKNOWN-ID] ${unknown.file}:${unknown.line}: 迁移号 ${unknown.id} 在实际目录里不存在`)
}
for (const problem of contentProblems) console.error(`  [CONTENT] ${problem}`)

// 扫描面缩水 = **前置失败**（退出码 2，与"有漂移"的 1 区分）：此时"一致 ✅"是一个
// 没被检查过的结论。
if (surfaceProblems.length > 0) {
  for (const message of surfaceProblems) console.error(`  [SURFACE] ${message}`)
  console.error(`\ncheck-migration-range: 扫描面缩水/前置缺失 ${surfaceProblems.length} 处 —— 拒绝把"没扫到"当"一致"。\n`
    + '  修法：把被删的扫描根加回 SCAN_PATHS（要真的收窄口径，必须同时改 REQUIRED_SCAN_PATHS 并进 diff）；'
    + '夹具树请只放被扫文档，绝对值下限只在真仓形态的根上强制。')
  process.exit(2)
}

if (hits.length > 0 || unknownIds.length > 0 || contentProblems.length > 0) {
  console.error(`\n迁移区间漂移 ${hits.length} 处 / 不存在的迁移号 ${unknownIds.length} 处 /`
    + ` 迁移内容不可变 ${contentProblems.length} 处。`
    + `修法：区间上限改成 ${pad(MAX)}（记录当时事实的历史文档加行内标记 \`${ALLOW_MARKER}\`）；`
    + `迁移文件与登记表以**新增**方式保持一致（\`${REGENERATE_HINT}），`
    + '**永不**为让守卫变绿而改已有条目的 sha256 —— 要改数据请加新迁移。')
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

if (!json) {
  // 通过行**只说做过的判据**：合成夹具根上不宣称"迁移内容没被改过"（那件事本次没判）。
  // **R22 FIX-14**：通过行只说**做过的判据** —— 第⑥层（登记值 vs 已提交字节 / HEAD 侧路径
  // 集合 ⊆ 磁盘）没跑时必须在同一行里写明，否则读者会把"登记表与磁盘一致"读成"与提交态一致"。
  // **R23 FIX-22 / W4-03**：通过行必须同时说出**两层**参照物各自有没有参与 ——
  // "登记值 vs 已提交字节（HEAD）"与"路径/字节 vs **已发布基线 tag**"是两件事，
  // 只跑了前者时**不得**让读者以为历史迁移没被改写（修前正是这句话导致 W4 判它假绿）。
  const headLayerClause = contentInScope && headLayerRan
    ? ''
    : '（**但"登记值 vs 已提交字节"这一层未参与**：见 [CONTENT-SKIP]）'
  const baselineLayerClause = contentInScope && baselineLayerRan
    ? ''
    : '（**但"路径/字节 vs 已发布基线 tag"这一层未参与**：见 [CONTENT-SKIP]）'
  const contentClause = contentInScope
    ? `，且 ${sqlFiles.length} 个迁移文件的 sha256 与 ${CHECKSUMS_POINTER} 逐条一致`
      + `${headLayerClause}${baselineLayerClause}`
    : '（迁移内容不可变判据**未参与**：root 不是仓库形态，见 [CONTENT-SKIP]）'
  console.log(`check-migration-range: 文档区间与实际一致（${pad(MIN)}–${pad(MAX)}），`
    + `且 server/AGENTS.md 的迁移号都存在${contentClause} ✅`)
}
