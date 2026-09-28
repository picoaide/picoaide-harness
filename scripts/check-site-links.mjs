#!/usr/bin/env node
/**
 * 官网**产物面**死链判据（第三十二轮 FIX-47 ④e；起因 = 审计方 AD2 真跑的 AD2-07）。
 *
 * ## 现场（真跑，不是设想）
 *
 * `site/`（Astro + Starlight 官网）的 `astro.config.mjs` 声明了两个 locale：
 * `locales: { root: 简体中文, en: English }`，英文内容树 `site/src/content/docs/en/**`
 * 有 17 篇文档，**但没有英文落地页** —— 中文首页来自自定义 `src/pages/index.astro`，
 * 而 `src/pages/en/` 不存在、Starlight 也不会替它生成。于是：
 *
 * ```
 * $ node dist-probe.mjs                      # 扫 dist/**\/*.html 里的站内 href|src
 * html=43 internal_refs=1417 external_refs=1142 broken=17
 *   BROKEN en/admin/index.html -> /en        # 17 条**全部**是 `-> /en`
 * $ test -f site/dist/en/index.html || echo MISSING   # MISSING（=/en 404）
 * ```
 *
 * 那 17 条死链**不在源码里**：Starlight 给每一页渲染的**页头站点标题 logo**（`.site-title`，
 * 就是"回首页"）指向 `/<locale>/`，源码面一个 `](/en)` 都搜不到。`astro build`
 * 对此**零报告**（Astro/Starlight 默认不做链接完整性检查），`site/` 也不在 root yarn
 * workspace 里 ⇒ 仓库既有的门禁**结构上看不见这条**。
 *
 * ## 为什么这条判据必须在**产物面**
 *
 * 源码面探针（扫 `](/…)` 形态）只能看见**作者手写**的链接；本缺陷是**框架生成**的链接 ——
 * 它只存在于构建产物里，且随 Starlight 版本、主题、`locales` 配置而变（今天改一个 locale
 * 键就多/少一组死链）。同理，只有产物面能回答"某个路由**真的**产出了一个页面吗"：
 * （`src/pages/en/index.astro` 在不在、`<loc>` 路由有没有被 Starlight 认下来、构建有没有
 * 被静默跳过）—— 所以本脚本自己跑 `astro build`，再扫 `site/dist/**\/*.html`。
 *
 * ## 判据（双向，两条都要过）
 *
 *   ① **链接 → 落盘文件**：`dist/**\/*.html` 里每条**站内**引用（`href` / `src`）解析成
 *      落盘路径后必须真的存在（`X` → 文件、`X/` → `X/index.html`、`X` → `X.html` 三种形态），
 *      缺页即红、逐条打印 `BROKEN <html 相对路径> -> <目标>`；
 *   ② **每个 locale 的根路由必须真的产出落地页**：`locales` 从 `site/astro.config.mjs`
 *      **解析**（唯一真源，不另抄一份清单）：`root` → `dist/index.html`，
 *      `<loc>` → `dist/<loc>/index.html`。缺即红、逐条打印 `MISSING-ROOT …`。
 *      这一格正是本次缺陷：源码面完全干净、产物面 17 页全带死链。
 *
 * ## 构建方式（与仓库既有本地构建口径一致）
 *
 * `cwd = site/`，`npx astro build`，`env` 必须带 `HOME=<临时目录>`、
 * `XDG_CONFIG_HOME=<临时目录>/.config`、`ASTRO_TELEMETRY_DISABLED=1`（`/root/.config`
 * 只读，不重定向 HOME 时 telemetry 直接 ENOENT 失败）；先 `rm -rf .astro dist`
 * （陈旧缓存会让构建打出 `Duplicate id` 之类的**假象告警**）。实测本机约 6 秒、离线可跑。
 *
 * `--no-build` 复用已有 `dist/`（快速复跑）；`--help` 打印用法。
 *
 * ## 退出码
 *
 *   0 = 全绿（链接全部落盘 + 每个 locale 根路由都有落地页）
 *   1 = **判据红**：有 `BROKEN` / `MISSING-ROOT`
 *   2 = **前置失败**（`site/node_modules` 缺失 / 构建失败 / 参数不合法 / `--no-build` 但没有
 *       `dist/`）—— "跑不出结论"与"结论是红的"分开，绝不静默通过
 *
 * ## 已知边界（认账，都是**不做**而不是"忘了"）
 *
 *   · **外链不判**：`http(s)://`、协议相对 `//host/…` 只计数不校验（判它就要联网，
 *     而本脚本必须离线可跑、确定性可复跑）；
 *   · **不建模 `<base href>` / 服务端重写**：解析只按"产物目录树"做，Caddy/Cloudflare 上
 *     的 rewrite、trailing-slash 重定向、SPA 回落一律不模拟（本仓官网是纯静态产物，
 *     上线侧没有为它配重写；真要配了，这条判据会在"产物里缺页"上照旧报红 —— 是**偏严**，
 *     此时应当把页补进产物，而不是放宽判据）；
 *   · **不做锚点校验**：`#fragment` 只用于**剥掉**（`/x/#a` → `/x/`），标题锚点是否真的
 *     存在不在判据面内（成本与收益都不同，属另一条判据）；
 *   · **query 不判**：`?a=b` 剥掉后判路径（静态产物里 query 不改变命中文件）；
 *   · **正则抽属性，不是完整 HTML 解析器**：只认带引号的 `href=` / `src=`（前一个字符不是
 *     `-` / 单词字符 / `:`，所以 `data-src`、`xlink:href` 不进面）；`srcset`、CSS `url()`、
 *     运行期由 JS 拼出来的地址不在面内。Astro/Starlight 的产物是静态带引号属性，够用；
 *   · **大小写按文件系统**：macOS/Windows 上大小写不敏感，`/En/` 这类错拼在那些平台上
 *     可能"命中"而在 Linux 上 404（本判据在 CI 上跑 Linux，偏严的那一侧）；
 *   · **locale 清单是解析出来的**：`astro.config.mjs` 的 `locales` 对象解析不出（形态变了）
 *     即 **exit 2**（拒绝把"扫不到"当通过），不猜、不回落默认值。
 *
 * 用法：`node scripts/check-site-links.mjs [--no-build] [--help]`
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, posix, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 仓库根（按**本文件自己的位置**解析 —— 与 cwd 无关）。 */
const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const SITE_DIR = join(REPO_ROOT, 'site')
const DIST_DIR = join(SITE_DIR, 'dist')
const ASTRO_CONFIG = 'astro.config.mjs'
/** 构建预算：实测 ~6s，留 10 分钟给冷缓存/慢机器；超时按前置失败（exit 2）。 */
const BUILD_TIMEOUT_MS = 10 * 60 * 1000

const USAGE = `用法：node scripts/check-site-links.mjs [--no-build] [--help]

  （无参数）   先 rm -rf site/.astro site/dist，再在 site/ 里跑 \`npx astro build\`，
               然后扫 site/dist/**/*.html 的站内 href|src 并检查 locale 根路由落地页。
  --no-build   复用已有 site/dist（快速复跑；没有 dist 即 exit 2）。
  --help       打印本说明。

退出码：0 = 全绿；1 = 有 BROKEN / MISSING-ROOT；2 = 前置失败（依赖未装 / 构建失败 / 参数非法）。`

/**
 * 解析参数（未知参数 fail-loud —— 与仓内守卫同一纪律）。
 * @param argv - `process.argv.slice(2)`。
 * @returns `{ help, build }`；参数非法时直接 exit 2。
 */
function parseArgs(argv) {
  let help = false
  let build = true
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') help = true
    else if (arg === '--no-build') build = false
    else {
      console.error(`check-site-links: 未知参数 ${arg}\n\n${USAGE}`)
      process.exit(2)
    }
  }
  return { help, build }
}

/**
 * 跑一次官网构建（口径见文件头）。
 *
 * `HOME` / `XDG_CONFIG_HOME` 重定向到临时目录：`/root/.config` 只读，不重定向时
 * astro 的 telemetry 写配置直接 ENOENT 失败（本仓既有本地构建口径）。
 * 失败 ⇒ 打印 stderr（不得静默）+ exit 2。
 */
function runBuild() {
  const home = mkdtempSync(join(tmpdir(), 'check-site-links-home-'))
  try {
    mkdirSync(join(home, '.config'), { recursive: true })
    // 陈旧缓存会让构建打出 `Duplicate id` 之类的假象告警（与既有本地构建口径一致）。
    rmSync(join(SITE_DIR, '.astro'), { recursive: true, force: true })
    rmSync(DIST_DIR, { recursive: true, force: true })
    const result = spawnSync('npx', ['astro', 'build'], {
      cwd: SITE_DIR,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: join(home, '.config'),
        ASTRO_TELEMETRY_DISABLED: '1',
      },
      timeout: BUILD_TIMEOUT_MS,
    })
    if (result.error !== undefined) {
      console.error(`check-site-links: 无法启动 \`npx astro build\`（${result.error.message}）`
        + ' —— 拒绝把"构建跑不起来"当通过（exit 2）')
      process.exit(2)
    }
    if (result.status !== 0) {
      const tail = value => String(value ?? '').trim().split('\n').slice(-40).join('\n')
      console.error(`check-site-links: \`npx astro build\` 失败（exit ${result.status}）——`
        + ' 构建不成功就没有产物面可判，拒绝静默通过')
      if (tail(result.stdout) !== '') console.error(`--- astro stdout ---\n${tail(result.stdout)}`)
      if (tail(result.stderr) !== '') console.error(`--- astro stderr ---\n${tail(result.stderr)}`)
      process.exit(2)
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

/**
 * 递归列出 `dist/**\/*.html`（相对 dist 的 POSIX 路径，排序后返回，输出可复现）。
 * @param directory - 绝对目录。
 * @returns 相对路径列表。
 */
function listHtml(directory) {
  const found = []
  const walk = current => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = join(current, entry.name)
      if (entry.isDirectory()) walk(absolute)
      else if (entry.isFile() && entry.name.endsWith('.html')) {
        found.push(relative(directory, absolute).split(/[\\/]/u).join('/'))
      }
    }
  }
  walk(directory)
  return found.sort()
}

/**
 * 抽一个 HTML 文件里的 `href=` / `src=`（带引号；`(?<![-\w:])` 让 `data-src` /
 * `xlink:href` 这类复合属性名不进面）。
 * @param html - 文件全文。
 * @returns 原始取值列表（保持出现顺序，允许重复 —— 计数按**出现次数**）。
 */
function extractRefs(html) {
  const refs = []
  for (const match of html.matchAll(/(?<![-\w:])(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/giu)) {
    refs.push(match[1] ?? match[2] ?? '')
  }
  return refs
}

/**
 * 把一条原始引用分类（**站内**判据的全部输入面就在这里）。
 * @param raw - 属性原文。
 * @returns `{ kind: 'internal' | 'external' | 'skip', target?: string, why?: string }`。
 */
function classify(raw) {
  const value = raw.trim()
  if (value === '') return { kind: 'skip', why: 'empty' }
  // 协议相对（`//host/x`）：与 `http(s)` 同类，属外链。
  if (value.startsWith('//')) return { kind: 'external', why: 'protocol-relative' }
  const scheme = /^([a-z][a-z0-9+.-]*):/iu.exec(value)
  if (scheme !== null) {
    return /^https?$/iu.test(scheme[1])
      ? { kind: 'external', why: scheme[1].toLowerCase() }
      : { kind: 'skip', why: scheme[1].toLowerCase() }
  }
  // 纯片段：同页锚点（锚点校验不在本判据面内，见文件头）。
  if (value.startsWith('#')) return { kind: 'skip', why: 'fragment' }
  return { kind: 'internal', target: value }
}

/**
 * 剥掉 fragment / query，并做百分号解码。
 * @param target - 站内引用原文。
 * @returns 落盘路径片段（POSIX 形态）；剥完为空（纯 `#`/`?`）时返回 `undefined`。
 */
function normalizeTarget(target) {
  let value = target
  for (const marker of ['#', '?']) {
    const index = value.indexOf(marker)
    if (index >= 0) value = value.slice(0, index)
  }
  if (value === '') return undefined
  try {
    return decodeURIComponent(value)
  } catch {
    // 非法百分号转义：原样用（落盘查找多半会红，正是我们要的"看得见"）。
    return value
  }
}

/**
 * 站内引用是否真的**有页面落在盘上**。
 *
 * 三种形态：`X` → 文件；`X/`（目录）→ `X/index.html`；`X`（无扩展名）→ `X.html`
 * （Astro 缺省 `build.format: 'directory'`，第三条只是兜底，避免对 `.html` 形态假红）。
 * @param absolute - 解析出来的绝对路径。
 * @returns 命中时 `true`。
 */
function landsOnDisk(absolute) {
  const isFile = candidate => existsSync(candidate) && statSync(candidate).isFile()
  if (isFile(absolute)) return true
  if (isFile(join(absolute, 'index.html'))) return true
  if (isFile(`${absolute}.html`)) return true
  return false
}

/**
 * 把站内引用解析成 dist 下的落盘路径。
 * @param pageRel - 引用所在 html 的 dist 相对路径（POSIX）。
 * @param target - 站内引用原文。
 * @returns `{ absolute, escapes }`；`escapes` = 解析结果跑到 dist 之外（`/../../etc/passwd`
 *   这类）—— 那是"站点根之外"的引用，产品上不可能命中，按红处理。
 */
function resolveTarget(pageRel, target) {
  const relativeCandidate = target.startsWith('/')
    ? target.replace(/^\/+/u, '')
    : posix.join(posix.dirname(pageRel), target)
  const absolute = resolve(DIST_DIR, relativeCandidate)
  const relToDist = relative(DIST_DIR, absolute)
  const escapes = relToDist !== '' && (relToDist.startsWith('..') || isAbsolute(relToDist))
  return { absolute, escapes }
}

/**
 * 从 `site/astro.config.mjs` 的源码里解析 starlight 的 `locales` 对象键（**唯一真源**）。
 *
 * 与仓内其它守卫同一纪律：只**解析源码文本**，不 import 被审对象（`astro.config.mjs` 会拉
 * `astro/config` 与 `@astrojs/starlight`，且 `defineConfig` 之外还有副作用面）。
 * 解析不出（找不到 `locales:` / 花括号不闭合 / 一个键都取不到）⇒ 返回 `undefined`，
 * 由调用方 fail-loud（exit 2），**绝不回落默认 locale 清单**。
 * @param source - `astro.config.mjs` 全文。
 * @returns locale 键列表（声明顺序）；解析失败返回 `undefined`。
 */
function localesFromAstroConfig(source) {
  const text = String(source)
  const anchors = [...text.matchAll(/(?:^|[\s,{])locales\s*:\s*\{/gmu)]
  if (anchors.length !== 1) return undefined
  const open = text.indexOf('{', anchors[0].index)
  if (open < 0) return undefined
  const keys = []
  let depth = 0
  let quote = null
  let pending = ''
  for (let index = open; index < text.length; index += 1) {
    const char = text[index]
    if (quote !== null) {
      if (char === '\\') index += 1
      else if (char === quote) quote = null
      continue
    }
    if (char === '/' && text[index + 1] === '/') {
      const end = text.indexOf('\n', index)
      index = end < 0 ? text.length : end
      continue
    }
    if (char === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2)
      index = end < 0 ? text.length : end + 1
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
      pending += char
      continue
    }
    if (char === ':' && pending !== '') {
      keys.push(pending)
      pending = ''
      continue
    }
    pending = ''
  }
  if (depth !== 0) return undefined
  return keys.length > 0 ? keys : undefined
}

/**
 * locale 根路由 → 期望产出的落地页（dist 相对路径）。
 * @param locale - locale 键（`root` 是 Starlight 的缺省 locale 键）。
 * @returns dist 相对路径。
 */
function landingPageFor(locale) {
  return locale === 'root' ? 'index.html' : `${locale}/index.html`
}

const { help, build } = parseArgs(process.argv.slice(2))
if (help) {
  console.log(USAGE)
  process.exit(0)
}

// ---- 前置：site 依赖（缺 ⇒ exit 2，**绝不**静默跳过、绝不报通过）------------
if (!existsSync(join(SITE_DIR, 'node_modules'))) {
  console.error('check-site-links: site 依赖未安装（找不到 site/node_modules）——'
    + ' 产物面判据跑不起来，拒绝静默通过（exit 2）\n'
    + '  修法：cd site && npm install')
  process.exit(2)
}

// ---- 前置：astro 配置里必须有可解析的 locales（唯一真源）-------------------
const astroConfigPath = join(SITE_DIR, ASTRO_CONFIG)
if (!existsSync(astroConfigPath)) {
  console.error(`check-site-links: 找不到 site/${ASTRO_CONFIG} —— locale 根路由判据没有真源，`
    + '拒绝把"读不到真源"当通过（exit 2）')
  process.exit(2)
}
const locales = localesFromAstroConfig(readFileSync(astroConfigPath, 'utf8'))
if (locales === undefined) {
  console.error(`check-site-links: 解析不出 site/${ASTRO_CONFIG} 里 starlight 的 locales ——`
    + ' 拒绝把"解析失败"当通过（exit 2）；请同步本脚本的解析器或修回 `locales: { … }` 形态')
  process.exit(2)
}

if (build) runBuild()

if (!existsSync(DIST_DIR)) {
  console.error('check-site-links: 没有 site/dist —— `--no-build` 复用不了不存在的产物，'
    + '请先跑一次构建（不带 --no-build，或 `cd site && npx astro build`）（exit 2）')
  process.exit(2)
}

// ---- 判据①：站内链接 → 落盘文件 -------------------------------------------
const pages = listHtml(DIST_DIR)
const broken = []
let internalRefs = 0
let externalRefs = 0
let skippedRefs = 0
for (const page of pages) {
  const html = readFileSync(join(DIST_DIR, page), 'utf8')
  for (const raw of extractRefs(html)) {
    const verdict = classify(raw)
    if (verdict.kind === 'external') {
      externalRefs += 1
      continue
    }
    if (verdict.kind === 'skip') {
      skippedRefs += 1
      continue
    }
    internalRefs += 1
    const target = normalizeTarget(verdict.target)
    if (target === undefined) {
      skippedRefs += 1
      internalRefs -= 1
      continue
    }
    const { absolute, escapes } = resolveTarget(page, target)
    if (escapes || !landsOnDisk(absolute)) {
      broken.push({ page, target: verdict.target, escapes })
    }
  }
}

// ---- 判据②：每个 locale 的根路由必须真的产出一个落地页 ---------------------
const missingRoots = []
for (const locale of locales) {
  const expected = landingPageFor(locale)
  if (!existsSync(join(DIST_DIR, expected))) missingRoots.push({ locale, expected })
}

// ---- 输出（判定行 + 逐条 finding；都在 stdout，便于日志与 grep）------------
for (const item of broken) {
  console.log(`BROKEN ${item.page} -> ${item.target}`
    + `${item.escapes ? '（解析到 dist 之外）' : ''}`)
}
for (const item of missingRoots) {
  console.log(`MISSING-ROOT locale=${item.locale} -> ${item.expected}`
    + `（locale 根路由 /${item.locale === 'root' ? '' : `${item.locale}/`} 必须产出一个落地页：`
    + 'Starlight 给每一页渲染的页头站点标题 logo 链到它 —— 缺了它，该 locale **全部**页面'
    + '都会带一条死链，而 `astro build` 对这类**生成型**链接零报告）')
}
console.log(`site-links: mode=${build ? 'build' : 'reuse-dist'} html=${pages.length}`
  + ` internal_refs=${internalRefs} external_refs=${externalRefs} skipped_refs=${skippedRefs}`
  + ` broken=${broken.length} missing_roots=${missingRoots.length}`)

if (broken.length > 0 || missingRoots.length > 0) {
  console.error(`check-site-links: 产物面判据未通过（broken=${broken.length} missing_roots=${missingRoots.length}）`
    + ' —— 修法：把缺的页面真的产出来（英文站就是 `site/src/pages/en/index.astro`），'
    + '不要靠放宽本判据或加服务端重写把红翻绿。')
  process.exit(1)
}

console.log(`check-site-links: 产物面死链判据通过（html=${pages.length} internal_refs=${internalRefs}）✅`)
process.exit(0)
