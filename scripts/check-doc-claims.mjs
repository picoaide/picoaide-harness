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
 * 判据（两条都要求**双向**相等；扫描器失效一律 fail-loud，绝不静默通过）：
 *   1. 上游 pin：扫非记录面 md 里反引号包裹的 `dsh-v…` 断言，必须逐字等于
 *      `dsh-v${upstream.json:sourceVersion}`；
 *   2. 平台模块表：`site/src/content/docs/{,en/}plugin-development.md` 里提到
 *      `PLATFORM_MODULES` 的那一行，其反引号模块名集合必须与
 *      `scripts/platform-modules.mjs` 的 `PLATFORM_MODULES` **集合相等**；
 *      若同行写了「共 N 项」/「N entries」，N 也必须等于实际项数。
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

/** 自检：解析器与判据本身的正反用例（防"扫描器悄悄失效 ⇒ 恒绿"）。 */
function selfTest() {
  const good = '平台模块表（`PLATFORM_MODULES`，共 2 项：`react`、`react-dom`）与 `scripts/platform-modules.mjs`'
  const bad = '平台模块表（`PLATFORM_MODULES`，共 3 项：`react`、`react-dom`）与 `react-dom/client`'
  const noAnchor = '无关的一行 `react`'
  const cases = [
    [modulesFromDocLine(good).modules?.join(',') === 'react,react-dom', 'selftest: 正常列表应解析出 2 项'],
    [modulesFromDocLine(good).declaredCount === 2, 'selftest: 应解析出声明项数 2'],
    [modulesFromDocLine(bad).declaredCount === 3, 'selftest: 应解析出声明项数 3'],
    [modulesFromDocLine(noAnchor).modules === undefined, 'selftest: 非锚点行必须返回 undefined'],
    [/`(dsh-v\d[A-Za-z0-9.+-]*)`/u.exec('pin `dsh-v0.1.5-rc.2`')?.[1] === 'dsh-v0.1.5-rc.2', 'selftest: pin 正则应命中'],
    [!/`(dsh-v\d[A-Za-z0-9.+-]*)`/u.test('上游 0.1.5 起'), 'selftest: 版本泛指不应命中'],
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
    }
  }
}

/** 模块表断言：两篇插件开发页（中英）各一行。 */
const moduleHits = []
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
/** 真仓形态：既做合成树夹具又要绝对下限时，夹具会被自己的下限判死（不区分两者 = 假红）。 */
const strictSurface = existsSync(join(root, 'upstream.json')) && existsSync(join(root, 'package.json'))

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
}

if (json) {
  console.log(JSON.stringify({
    root, expectedPin, expectedModules, scanned, pinClaims,
    perScanPath: Object.fromEntries(perScanPath), hits, moduleHits, failures, surfaceProblems,
  }, null, 2))
} else {
  console.log(`check-doc-claims: 上游 pin ${expectedPin}；平台模块表 ${expectedModules.length} 项；扫描 ${scanned} 个 md / ${pinClaims} 条 pin 断言`)
  console.log(`  扫描面：${SCAN_PATHS.map(target => `${target} ${perScanPath.get(target)?.files ?? 0}`
    + `(pin ${perScanPath.get(target)?.pinClaims ?? 0})`).join(' / ')}${strictSurface ? '' : '（夹具树：只查非空，不查绝对下限）'}`)
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
    + '`scripts/platform-modules.mjs`）；若该行是**记录当时事实**的历史文档，'
    + `请加行内标记 \`${ALLOW_MARKER}\`（不要改扫描面）。`)
  process.exit(1)
}

console.log(`check-doc-claims: 文档数字与真源一致（pin=${expectedPin}，平台模块表 ${expectedModules.length} 项）✅`)
