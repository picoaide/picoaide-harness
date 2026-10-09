#!/usr/bin/env node
/**
 * 英文落地页（`/en/`）站内链接的 **locale 判据**（回归审计 v2.8.1→HEAD 的 E-04）。
 *
 * ## 现场
 *
 * `Header.astro` / `Footer.astro` 原先硬编码中文标签 + **根 locale** 链接（`首页 → /`、
 * `功能 → /#features`、`Wiki → /welcome/` …），而它们被新的英文落地页
 * `src/pages/en/index.astro` 挂载 ⇒ 产物面实测 `/en/index.html` 上有 **16 条站内锚点不以
 * `/en/` 开头**（15 条导航 + 品牌 logo 的 `/`），其中「功能」跳的还是**中文页**的
 * `id="features"`。同页 `:103` 自己写的是正确的 `/en/welcome/` —— 页内自相矛盾。
 *
 * ## 判据（四个面，全部必须过；每条都是"能被变异打坏"的）
 *
 *   A **数据面**（直接 `import` 组件真正消费的那份表 `src/components/site-nav.mjs`）：
 *     A1 英文表里每条**站内** href 都以 `/en/` 开头（纯锚点 `#…` 除外）；
 *     A2 英文表的标签/栏目标题/文案不含中日韩字符（英文页不得出现中文导航文案）；
 *     A3 `root` 表**逐字等于冻结的历史值** —— 中文站逐字节不变这条的回归判据
 *        （有意冻结：中文导航是产品决策，改它必须连本文件的期望值一起改）；
 *     A4 `root` 表的站内 href 反过来**不得**带 `/en/` 前缀（防两个 locale 串场）；
 *     A5 英文导航的**覆盖下限**（写死的必备落点清单）：清空列表不能把判据变绿。
 *   B **落点面**：两个 locale 的每条站内 href 都要解析到**真实源码**
 *     （`src/content/docs/**` 或 `src/pages/**`），带 `#fragment` 的必须命中目标页自己的
 *     `id="…"` —— 这条同时挡住"把链接指到一个不存在但前缀正确的路径"。
 *   C **接线面**（"数据对了但组件没用它"是独立的缺陷类）：
 *     C1 `Header.astro` 必须 import 同一个导航模块、并按 `locale` 取表（`headerNav(locale)`）；
 *     C2 `Footer.astro` 同理（`footerContent(locale)`）；
 *     C3 `/en/` 落地页必须显式传 `locale="en"`（两个组件各一次）；
 *     C4 `src/pages/**` 里凡挂载 Header/Footer 的页面，其 locale 必须与**页面路径前缀**一致
 *        （`src/pages/en/**` ⇒ `en`，其余 ⇒ `root`；不写 = `root`）—— 以后新增英文页忘了传
 *        参数，这里直接红。
 *   D **页面面**：`src/pages/en/index.astro` **自己写的**站内 href 字面量同样必须 `/en/` 前缀
 *     （这一页的 3 个 hero 按钮、6 张功能卡、8 张文档卡都在这里）。
 *
 * ## 覆盖边界（认账）
 *
 *   · **不做 Astro 渲染**：本判据读的是"组件真正消费的那份数据 + 组件与页面的接线"，
 *     不跑 `astro build`（慢、且需要 HOME 重定向），因此**看不见**框架在渲染期生成的链接
 *     （例如 Starlight 自己给每页渲染的 `/<locale>/` 站点标题）。产物面的死链判据是
 *     `scripts/check-site-links.mjs`（它自己跑构建、扫 `dist/**\/*.html`），两者是互补的：
 *     那条**会剥掉 `#fragment`、也不判 locale 前缀**，这条两条都判但只看源码面。
 *   · **只看 `<a href>` 一族**：`href=` / `href:` 的带引号字面量与导航表；
 *     `srcset`、CSS `url()`、运行期拼出来的地址不在面内。
 *
 * ## 退出码
 *
 *   0 = 全绿；1 = **判据红**（逐条打印 `EN-NAV <code> …`）；2 = **前置失败**
 *   （站点树不完整 / `astro.config.mjs` 的 locale 清单解析不出 / 断言数低于地板）——
 *   与"结论是红的"分开，绝不把"扫不到"当通过。
 *
 * 用法：`node site/scripts/check-en-landing-nav.mjs [--site <站点目录>] [--help]`
 * （`--site` 供变异验证/自测把判据指向一份**副本**；指向的目录必须是一棵完整站点树，
 * 否则 exit 2 —— 不允许用空目录换一个假绿。）
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))

/** 判据地板（R4-A 的教训：回归网自身要有断言下限，"零断言"不得等于通过）。 */
const MIN_ASSERTIONS = 30

/** 站点树里必须存在的路径（缺一条 ⇒ exit 2，不当通过）。 */
const REQUIRED_PATHS = [
  'astro.config.mjs',
  'src/pages/index.astro',
  'src/pages/en/index.astro',
  'src/components/Header.astro',
  'src/components/Footer.astro',
  'src/components/site-nav.mjs',
  'src/content/docs',
  'src/content/docs/en',
]

/**
 * 冻结的 root（中文站）导航 —— `site-nav.mjs` 里 `root` 表必须逐字等于它。
 * 出处 = 本次官网改版时**有意定稿**的中文导航（版块 id 与 `/en/` 一一对应）。
 * **要改中文导航就连这里一起改**（有意为之：这是"中文站导航不顺手漂移"的锚）。
 */
const FROZEN_ROOT_HEADER = [
  { label: '首页', href: '/' },
  { label: '功能', href: '/#capabilities' },
  { label: '部署', href: '/#deployment' },
  { label: '安全', href: '/#security' },
  { label: '截图', href: '/#screenshots' },
  { label: 'Wiki', href: '/welcome/' },
]

const FROZEN_ROOT_FOOTER = {
  tagline: '企业级 AI 一体化平台：桌面客户端、本地智能体引擎与企业管理后台，一个镜像完成私有化部署。',
  groups: [
    {
      title: '产品',
      links: [
        { label: '平台能力', href: '/#capabilities' },
        { label: '企业管控', href: '/#control' },
        { label: '安全与合规', href: '/#security' },
        { label: '界面预览', href: '/#screenshots' },
      ],
    },
    {
      title: '部署',
      links: [
        { label: '部署总览', href: '/deployment/' },
        { label: '容器化部署', href: '/deployment/compose/' },
        { label: '升级与回滚', href: '/deployment/upgrade/' },
        { label: '客户端分发', href: '/deployment/client-delivery/' },
        { label: '渠道与白标', href: '/deployment/channels/' },
        { label: '离线部署', href: '/deployment/offline/' },
      ],
    },
    {
      title: '文档',
      links: [
        { label: '快速开始', href: '/getting-started/' },
        { label: '桌面客户端', href: '/desktop/' },
        { label: '管理后台', href: '/admin/' },
        { label: '系统架构', href: '/architecture/' },
        { label: 'API 参考', href: '/api-reference/' },
        { label: '常见问题', href: '/faq/' },
      ],
    },
    {
      title: '社区',
      links: [
        { label: 'GitHub', href: 'https://github.com/picoaide/picoaide-harness' },
        { label: '版本归档', href: 'https://github.com/picoaide/picoaide-harness/releases', blank: true },
        { label: '提交 Issue', href: 'https://github.com/picoaide/picoaide-harness/issues', blank: true },
        { label: '关于我们', href: '/about/' },
      ],
    },
  ],
  note: '基于 DeepSeek Harness 构建 · MIT License',
}

/**
 * 英文导航的**覆盖下限**（写死的必备落点）。目的不是钉死实现，而是让"把英文表清空/砍到
 * 一条"这种"改绿法"直接红：英文站的核心落点必须都能从顶栏或页脚走到。
 */
const REQUIRED_EN_HREFS = [
  '/en/',
  '/en/deployment/',
  '/en/#capabilities',
  '/en/welcome/',
  '/en/deployment/client-delivery/',
  '/en/getting-started/',
  '/en/deployment/upgrade/',
]

/** 中日韩字符（英文表里出现即红：英文页不得渲染中文导航文案）。 */
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3000-\u303F\uFF00-\uFFEF]/u

const problems = []
let assertions = 0

/**
 * @param {boolean} ok
 * @param {string} code
 * @param {string} message
 */
function check(ok, code, message) {
  assertions += 1
  if (!ok) problems.push(`${code} ${message}`)
}

/** @param {string} message */
function precondition(message) {
  console.error(`EN-NAV-PRECONDITION ${message}`)
  process.exit(2)
}

function usage() {
  console.log('用法：node site/scripts/check-en-landing-nav.mjs [--site <站点目录>]')
  console.log('  判据：英文落地页（/en/）用到的每一条站内 href 都必须以 /en/ 开头（纯锚点除外），')
  console.log('        且 root（中文站）导航逐字不变、接线必须按 locale 取表。')
}

/** 命令行解析：只认 `--site <dir>` 与 `--help`，未知参数即前置失败（不静默忽略）。 */
function parseArgs(argv) {
  let site = resolve(SCRIPT_DIR, '..')
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      usage()
      process.exit(0)
    } else if (arg === '--site') {
      const value = argv[index + 1]
      if (value === undefined) precondition('--site 需要一个目录参数。')
      site = resolve(value)
      index += 1
    } else {
      precondition(`未知参数 ${arg}（只接受 --site <dir> / --help）。`)
    }
  }
  return site
}

const siteRoot = parseArgs(process.argv.slice(2))

// ── 前置：站点树必须完整（"扫不到"不等于"没有违规"） ────────────────────────────────
for (const relative of REQUIRED_PATHS) {
  if (!existsSync(join(siteRoot, relative))) {
    precondition(`站点树缺少 ${relative}（root=${siteRoot}）—— 拒绝把"扫不到"当通过。`)
  }
}

/**
 * 站内 href（以 `/` 开头）→ 是否英文站。
 * @param {string} href
 */
const isInternal = href => href.startsWith('/')
/** @param {string} href */
const isAnchorOnly = href => href.startsWith('#')
/** @param {string} href */
const isExternal = href => /^[a-z][a-z0-9+.-]*:/iu.test(href)

// ── 读源码 ────────────────────────────────────────────────────────────────────────────
/**
 * @param {string} relative
 * @returns {string}
 */
function read(relative) {
  const absolute = join(siteRoot, relative)
  if (!existsSync(absolute)) precondition(`读不到 ${relative}（root=${siteRoot}）。`)
  return readFileSync(absolute, 'utf8')
}

const headerSource = read('src/components/Header.astro')
const footerSource = read('src/components/Footer.astro')
const enPageSource = read('src/pages/en/index.astro')
const astroConfigSource = read('astro.config.mjs')

// ── 导航数据（组件真正消费的那份表；直接 import，不做正则解析） ─────────────────────────
const navModulePath = join(siteRoot, 'src', 'components', 'site-nav.mjs')
const nav = await import(pathToFileURL(navModulePath).href).catch(error => {
  precondition(`import src/components/site-nav.mjs 失败：${error.message}`)
})

const LOCALES = nav.SITE_LOCALES
check(Array.isArray(LOCALES) && LOCALES.length > 0, 'A0', 'SITE_LOCALES 必须是至少一个 locale 的数组。')

// 与 `astro.config.mjs` 的 Starlight locales 键**双向对拍**（新增 locale 不同步导航即红）。
const configLocales = parseStarlightLocales(astroConfigSource)
check(
  configLocales !== null,
  'A6',
  'astro.config.mjs 的 Starlight `locales` 解析不出（形态变了）—— 本判据拒绝猜。',
)
if (configLocales !== null && Array.isArray(LOCALES)) {
  const fromModule = [...LOCALES].sort()
  const fromConfig = [...configLocales].sort()
  check(
    fromModule.length === fromConfig.length && fromModule.every((value, index) => value === fromConfig[index]),
    'A6',
    `SITE_LOCALES (${fromModule.join(', ')}) 与 astro.config.mjs 的 locales (${fromConfig.join(', ')}) 不一致。`,
  )
}

const headerRoot = nav.headerNav('root')
const headerEn = nav.headerNav('en')
const footerRoot = nav.footerContent('root')
const footerEn = nav.footerContent('en')
const homeRoot = nav.homeHref('root')
const homeEn = nav.homeHref('en')

// ── A 数据面 ─────────────────────────────────────────────────────────────────────────
/** @param {{label:string,href:string}} item @param {string} locale @param {string} where */
function checkItemHref(item, locale, where) {
  const { label, href } = item
  check(typeof label === 'string' && label.trim() !== '', 'A0', `${where} 的 label 为空。`)
  check(typeof href === 'string' && href.trim() !== '', 'A0', `${where} 的 href 为空。`)
  if (isInternal(href)) {
    if (locale === 'en') {
      check(href.startsWith('/en/'), 'A1', `英文表 ${where} 的站内链接 ${href} 不以 /en/ 开头`
        + `（"${label}" 会把英文访客送回中文站）。`)
    } else {
      check(!href.startsWith('/en/'), 'A4', `root 表 ${where} 的站内链接 ${href} 带了 /en/ 前缀`
        + '（locale 串场）。')
    }
  } else {
    check(isAnchorOnly(href) || isExternal(href), 'A0', `${where} 的 href ${href} 既不是站内绝对路径、`
      + '也不是锚点或外链。')
  }
}

for (const item of headerRoot) checkItemHref(item, 'root', 'header(root)')
for (const item of headerEn) checkItemHref(item, 'en', 'header(en)')
for (const group of footerRoot.groups) for (const link of group.links) checkItemHref(link, 'root', `footer(root)/${group.title}`)
for (const group of footerEn.groups) for (const link of group.links) checkItemHref(link, 'en', `footer(en)/${group.title}`)

check(homeRoot === '/' && homeEn === '/en/', 'A1', `homeHref: root=${homeRoot} en=${homeEn}（英文首页必须是 /en/）。`)

// A7：顶栏动作区（主 CTA / 语言切换 / 仓库入口）——与导航同一套前缀规则。
// 这一组是 2026-10 改版新增的：模板里任何一条硬编码链接都会重新引入 E-04 的形态。
const actionsRoot = nav.headerActions('root')
const actionsEn = nav.headerActions('en')
checkItemHref(actionsRoot.cta, 'root', 'actions(root).cta')
checkItemHref(actionsEn.cta, 'en', 'actions(en).cta')
checkItemHref(actionsRoot.repo, 'root', 'actions(root).repo')
checkItemHref(actionsEn.repo, 'en', 'actions(en).repo')
checkTarget(actionsRoot.cta, 'actions(root).cta')
checkTarget(actionsEn.cta, 'actions(en).cta')
check(actionsRoot.repo.href === actionsEn.repo.href, 'A7', '两个 locale 的仓库入口必须是同一条外链。')
check(
  actionsRoot.switchHref === '/en/' && actionsEn.switchHref === '/',
  'A7',
  `语言切换必须互为对方的首页：root=${actionsRoot.switchHref} en=${actionsEn.switchHref}。`,
)
checkTarget({ label: 'actions(root).switch', href: actionsRoot.switchHref }, 'actions(root).switch')
checkTarget({ label: 'actions(en).switch', href: actionsEn.switchHref }, 'actions(en).switch')

// A2：英文文案里不得有中日韩字符。
/** @param {unknown} value @param {string} where */
function checkNoCjk(value, where) {
  if (typeof value !== 'string') return
  check(!CJK.test(value), 'A2', `英文表 ${where} 含中日韩字符："${value}"。`)
}
for (const item of headerEn) {
  checkNoCjk(item.label, `header(en) ${item.href}`)
  checkNoCjk(item.href, `header(en) ${item.label}`)
}
for (const group of footerEn.groups) {
  checkNoCjk(group.title, 'footer(en) 栏目标题')
  for (const link of group.links) {
    checkNoCjk(link.label, `footer(en) ${link.href}`)
    checkNoCjk(link.href, `footer(en) ${link.label}`)
  }
}
checkNoCjk(footerEn.tagline, 'footer(en) tagline')
checkNoCjk(footerEn.note, 'footer(en) note')

// A3：root 表逐字等于冻结值（中文站逐字节不变的回归判据）。
check(
  JSON.stringify(headerRoot) === JSON.stringify(FROZEN_ROOT_HEADER),
  'A3',
  `root 顶栏表与冻结的历史值不一致：\n    实际 ${JSON.stringify(headerRoot)}\n    期望 ${JSON.stringify(FROZEN_ROOT_HEADER)}`,
)
check(
  JSON.stringify(footerRoot) === JSON.stringify(FROZEN_ROOT_FOOTER),
  'A3',
  `root 页脚表与冻结的历史值不一致：\n    实际 ${JSON.stringify(footerRoot)}\n    期望 ${JSON.stringify(FROZEN_ROOT_FOOTER)}`,
)

// A5：覆盖下限（清空/砍半不能变绿）+ 两个 locale 的栏目结构一致。
const enHrefs = new Set([
  homeEn,
  ...headerEn.map(item => item.href),
  ...footerEn.groups.flatMap(group => group.links.map(link => link.href)),
])
for (const href of REQUIRED_EN_HREFS) {
  check(enHrefs.has(href), 'A5', `英文导航缺少必备落点 ${href}（覆盖下限清单在 REQUIRED_EN_HREFS）。`)
}
check(headerEn.length >= 4, 'A5', `英文顶栏只有 ${headerEn.length} 条（下限 4 条）。`)
check(
  footerEn.groups.length === footerRoot.groups.length
    && footerEn.groups.every((group, index) => group.links.length > 0 && group.links.length <= footerRoot
      .groups[index].links.length),
  'A5',
  '英文页脚的栏目数必须与中文一致，且每栏非空、条目数不超过中文栏（不许多塞）。',
)

// ── B 落点面：站内 href 必须解析到真实源码；fragment 必须命中目标页自己的 id ─────────────
/**
 * 把一个站内 href 解析成"候选源码文件"（返回第一个存在的）。
 * @param {string} href
 * @returns {{ file: string, fragment: string | null } | null}
 */
function resolveTarget(href) {
  const [rawPath, fragment = null] = href.split('#')
  const path = rawPath === undefined ? '' : rawPath
  const segments = path.split('/').filter(segment => segment !== '')
  const candidates = []
  if (segments.length === 0) {
    candidates.push(join('src', 'pages', 'index.astro'))
  } else {
    candidates.push(join('src', 'pages', ...segments, 'index.astro'))
    candidates.push(join('src', 'pages', `${segments.join('/')}.astro`))
    candidates.push(join('src', 'content', 'docs', `${segments.join('/')}.md`))
    candidates.push(join('src', 'content', 'docs', ...segments, 'index.md'))
  }
  for (const candidate of candidates) {
    if (existsSync(join(siteRoot, candidate))) return { file: candidate, fragment }
  }
  return null
}

/** @param {{label:string,href:string}} item @param {string} where */
function checkTarget(item, where) {
  if (!isInternal(item.href)) return
  const target = resolveTarget(item.href)
  check(target !== null, 'B1', `${where} 的 ${item.href} 解析不到任何源码文件（死链）。`)
  if (target === null || target.fragment === null) return
  const targetSource = read(target.file)
  check(
    targetSource.includes(`id="${target.fragment}"`),
    'B2',
    `${where} 的 ${item.href} 指向 ${target.file}，但该页没有 id="${target.fragment}"`
      + '（英文页的锚点必须用**本页自己的** id）。',
  )
}

for (const item of headerRoot) checkTarget(item, 'header(root)')
for (const item of headerEn) checkTarget(item, 'header(en)')
for (const group of footerRoot.groups) for (const link of group.links) checkTarget(link, `footer(root)/${group.title}`)
for (const group of footerEn.groups) for (const link of group.links) checkTarget(link, `footer(en)/${group.title}`)
checkTarget({ label: 'home(root)', href: homeRoot }, 'home(root)')
checkTarget({ label: 'home(en)', href: homeEn }, 'home(en)')

// ── C 接线面：组件必须按 locale 取表，页面必须传对 locale ──────────────────────────────
/** @param {string} source @param {string} specifier @returns {boolean} */
function importsNavModule(source, specifier) {
  const pattern = new RegExp(`from\\s+['"]${specifier.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}['"]`, 'u')
  return pattern.test(source)
}

check(importsNavModule(headerSource, './site-nav.mjs'), 'C1', 'Header.astro 没有从 ./site-nav.mjs 取导航表'
  + '（硬编码标签/链接 = E-04 的原形态）。')
check(/headerNav\(\s*locale\s*\)/u.test(headerSource), 'C1', 'Header.astro 没有按 locale 取表'
  + '（必须调用 headerNav(locale)）。')
check(/headerActions\(\s*locale\s*\)/u.test(headerSource), 'C1', 'Header.astro 没有按 locale 取动作区'
  + '（必须调用 headerActions(locale)：CTA 与语言切换的落点同样随 locale 变）。')
check(!/\bhref\s*[:=]\s*['"]\//u.test(headerSource), 'C1', 'Header.astro 模板里出现了硬编码的站内 href'
  + '（站内链接一律走 ./site-nav.mjs 的表 —— 与 Footer 同一条纪律）。')
check(/const\s*\{[^}]*locale[^}]*\}\s*=\s*Astro\.props/u.test(headerSource), 'C1',
  'Header.astro 没有从 Astro.props 取 locale（缺省 root 的默认值也在这里）。')

check(importsNavModule(footerSource, './site-nav.mjs'), 'C2', 'Footer.astro 没有从 ./site-nav.mjs 取导航表。')
check(/footerContent\(\s*locale\s*\)/u.test(footerSource), 'C2', 'Footer.astro 没有按 locale 取表'
  + '（必须调用 footerContent(locale)）。')
check(/const\s*\{[^}]*locale[^}]*\}\s*=\s*Astro\.props/u.test(footerSource), 'C2',
  'Footer.astro 没有从 Astro.props 取 locale。')

check(/<Header\s+locale="en"\s*\/?>/u.test(enPageSource), 'C3',
  'src/pages/en/index.astro 没有给 <Header> 传 locale="en"（顶栏会把访客送回中文站）。')
check(/<Footer\s+locale="en"\s*\/?>/u.test(enPageSource), 'C3',
  'src/pages/en/index.astro 没有给 <Footer> 传 locale="en"（页脚会把访客送回中文站）。')

// C4：所有挂载 Header/Footer 的页面，locale 必须与页面路径前缀一致。
for (const page of listPageFiles(join(siteRoot, 'src', 'pages'))) {
  const relative = normalizeSlashes(page.slice(join(siteRoot, 'src', 'pages').length + 1))
  const expected = relative === 'en' || relative.startsWith('en/') ? 'en' : 'root'
  const source = readFileSync(page, 'utf8')
  for (const component of ['Header', 'Footer']) {
    const usage = new RegExp(`<${component}\\b[^>]*>`, 'u').exec(source)
    if (usage === null) continue
    const declared = /locale="([^"]*)"/u.exec(usage[0])?.[1] ?? 'root'
    check(
      declared === expected,
      'C4',
      `${relative} 挂载了 <${component}> 但 locale=${declared}（该页在 ${expected} 站，应为 ${expected}）。`,
    )
  }
}

// ── D 页面面：/en/ 落地页自己写的站内 href 字面量 ──────────────────────────────────────
const pageHrefLiterals = [...enPageSource.matchAll(/\bhref\s*[:=]\s*['"]([^'"]+)['"]/gu)].map(match => match[1])
check(pageHrefLiterals.length >= 10, 'D0', `只从 /en/ 落地页里抽到 ${pageHrefLiterals.length} 条 href 字面量`
  + '（形态变了？本判据拒绝在抽不到东西时通过）。')
for (const href of pageHrefLiterals) {
  if (!isInternal(href)) continue
  check(href.startsWith('/en/'), 'D1', `/en/ 落地页自己写的站内链接 ${href} 不以 /en/ 开头。`)
  const target = resolveTarget(href)
  check(target !== null, 'D2', `/en/ 落地页自己写的站内链接 ${href} 解析不到源码文件（死链）。`)
  if (target !== null && target.fragment !== null) {
    check(
      read(target.file).includes(`id="${target.fragment}"`),
      'D2',
      `/en/ 落地页的锚点 ${href} 在 ${target.file} 里没有对应 id="${target.fragment}"。`,
    )
  }
}

// ── 收尾：断言地板 + 结论 ─────────────────────────────────────────────────────────────
if (assertions < MIN_ASSERTIONS) {
  precondition(`只跑了 ${assertions} 条断言（地板 ${MIN_ASSERTIONS}）—— 判据面缩水，拒绝当通过。`)
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`EN-NAV ${problem}`)
  console.error(`EN-NAV-FAIL ${problems.length} 条问题（共 ${assertions} 条断言，root=${siteRoot}）`)
  process.exit(1)
}

console.log(`EN-NAV-OK ${assertions} 条断言全过：/en/ 落地页的站内链接全部 /en/ 前缀、`
  + 'root 导航逐字未变、组件接线按 locale 取表'
  + `（locales=${Array.isArray(LOCALES) ? LOCALES.join('/') : '?'}，root=${siteRoot}）`)

// ── 工具函数 ─────────────────────────────────────────────────────────────────────────
/**
 * 把平台路径分隔符归一成 `/`（判据里的页面前缀比较必须与平台无关）。
 * @param {string} value
 */
function normalizeSlashes(value) {
  return value.split('\\').join('/')
}

/**
 * 递归列出 `src/pages/**` 下的 `.astro` 页面。
 * @param {string} directory
 * @returns {string[]}
 */
function listPageFiles(directory) {
  const out = []
  for (const entry of readdirSyncSafe(directory)) {
    const absolute = join(directory, entry.name)
    if (entry.isDirectory()) out.push(...listPageFiles(absolute))
    else if (entry.isFile() && entry.name.endsWith('.astro')) out.push(absolute)
  }
  return out
}

/**
 * @param {string} directory
 */
function readdirSyncSafe(directory) {
  try {
    return readdirSync(directory, { withFileTypes: true })
  } catch (error) {
    precondition(`读不到目录 ${directory}：${error.message}`)
  }
}

/**
 * 从 `astro.config.mjs` 里解析 Starlight 的 `locales` **键**（唯一真源，不另抄清单）。
 * 解析不出返回 `null`（调用方判红 + 前置失败语义由断言表达）。
 * @param {string} source
 * @returns {string[] | null}
 */
function parseStarlightLocales(source) {
  const start = source.search(/locales\s*:\s*\{/u)
  if (start === -1) return null
  let index = source.indexOf('{', start)
  let depth = 0
  const keys = []
  for (; index < source.length; index += 1) {
    const char = source[index]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return keys
    } else if (depth === 1 && /[A-Za-z_$]/u.test(char)) {
      const match = /^([A-Za-z_$][\w$]*)\s*:/u.exec(source.slice(index))
      if (match !== null) {
        keys.push(match[1])
        index += match[1].length - 1
      } else {
        // 跳过不是"键"的标识符（例如值里的标识符）。
        const word = /^[A-Za-z_$][\w$]*/u.exec(source.slice(index))
        if (word !== null) index += word[0].length - 1
      }
    }
  }
  return null
}
