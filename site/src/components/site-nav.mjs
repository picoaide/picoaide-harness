/**
 * 顶栏 / 页脚导航的文案与链接（**唯一真源**，按 locale 取表）。
 *
 * ## 为什么单独一份数据
 *
 * `Header.astro` / `Footer.astro` 同时被中文页（`src/pages/index.astro` 等）与英文落地页
 * （`src/pages/en/index.astro`）挂载，而两站的**链接前缀不同**：中文站是根 locale
 * （`/…`），英文站是 `/en/…`（`astro.config.mjs` 的 Starlight `locales`）。
 * 组件里硬编码中文标签 + 根 locale 链接，会让英文页上的每条导航都把访客送回中文站
 * （回归审计 v2.8.1→HEAD 的 E-04）。**所有会渲染成链接的东西都放在这里**：
 * 顶栏、页脚、以及顶栏右侧的动作区（`headerActions`）—— 组件模板里不得出现站内 href 字面量。
 *
 * ## 三条硬约束（改这个文件之前先读）
 *
 * 1. **站内链接一律绝对路径 + 结尾斜杠**（本仓硬约定），英文表一律 `/en/` 前缀；
 *    锚点只用**本页自己的 id**（英文落地页与中文首页的版块 id 一一对应）。
 * 2. **英文表里只放英文站真实存在的落点**：`/blog/`、`/about/` 只有中文页，
 *    截图墙与更新说明也只长在中文落地页上 ⇒ 英文导航不列这几项
 *    （宁可少一项，也不把英文访客送回中文站）。
 * 3. **`root` 表是判据锚点**：`site/scripts/check-en-landing-nav.mjs` 里的
 *    `FROZEN_ROOT_HEADER` / `FROZEN_ROOT_FOOTER` 逐字对拍本文件 —— 改中文导航必须
 *    连那份期望值一起改（有意为之：中文导航是产品决策，不能顺手漂移）。
 *
 * ## 为什么是 `.mjs` 而不是 `.ts`
 *
 * 静态判据（`site/scripts/check-en-landing-nav.mjs`）要**直接 import 这份数据**来断言
 * "英文落地页真的会渲染出哪些链接"，用纯 ESM 就不需要任何转译步骤：Astro/Vite 与 node
 * 都能直接吃（`.ts` 需要 node 的类型剥离，那会把判据绑到 node 版本上）。
 */

/** @typedef {'root' | 'en'} SiteLocale */

/**
 * 站点 locale 全集（与 `astro.config.mjs` 的 Starlight `locales` 键一一对应，不要另抄一份）。
 * @type {ReadonlyArray<SiteLocale>}
 */
export const SITE_LOCALES = ['root', 'en']

/**
 * 导航项。
 * @typedef {{ label: string, href: string }} NavItem
 */

/**
 * 页脚内容：一句介绍 + 若干栏（栏内是链接）+ 页脚尾注。
 * `blank` = 新窗口打开。
 * @typedef {{ tagline: string, groups: { title: string, links: (NavItem & { blank?: boolean })[] }[], note: string }} FooterContent
 */

/**
 * 顶栏右侧动作区：主 CTA、语言切换、仓库入口。
 * `switchHref` 是**另一个 locale 的首页**（语言切换按钮）。
 * @typedef {{ cta: NavItem, switchLabel: string, switchHref: string, switchTitle: string, repo: NavItem }} HeaderActions
 */

/**
 * 各 locale 的首页（品牌 logo 与顶栏「首页」项共用同一个落点）。
 * @type {Record<SiteLocale, string>}
 */
const SITE_HOME = {
  root: '/',
  en: '/en/',
}

/** 源码仓库（两个 locale 同一个落点，只在这里写一次）。 */
const REPOSITORY = 'https://github.com/picoaide/picoaide-harness'

/** @type {Record<SiteLocale, NavItem[]>} */
const HEADER_NAV = {
  root: [
    { label: '首页', href: '/' },
    { label: '功能', href: '/#capabilities' },
    { label: '部署', href: '/#deployment' },
    { label: '安全', href: '/#security' },
    { label: '截图', href: '/#screenshots' },
    { label: 'Wiki', href: '/welcome/' },
  ],
  en: [
    { label: 'Home', href: '/en/' },
    { label: 'Features', href: '/en/#capabilities' },
    { label: 'Deployment', href: '/en/#deployment' },
    { label: 'Security', href: '/en/#security' },
    { label: 'Wiki', href: '/en/welcome/' },
  ],
}

/** @type {Record<SiteLocale, HeaderActions>} */
const HEADER_ACTIONS = {
  root: {
    cta: { label: '私有化部署', href: '/deployment/' },
    switchLabel: 'EN',
    switchHref: '/en/',
    switchTitle: 'English site',
    repo: { label: 'GitHub', href: REPOSITORY },
  },
  en: {
    cta: { label: 'Deploy privately', href: '/en/deployment/' },
    switchLabel: '中文',
    switchHref: '/',
    switchTitle: '简体中文站点',
    repo: { label: 'GitHub', href: REPOSITORY },
  },
}

/** @type {Record<SiteLocale, FooterContent>} */
const FOOTER_CONTENT = {
  root: {
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
          { label: 'GitHub', href: REPOSITORY },
          { label: '版本归档', href: `${REPOSITORY}/releases`, blank: true },
          { label: '提交 Issue', href: `${REPOSITORY}/issues`, blank: true },
          { label: '关于我们', href: '/about/' },
        ],
      },
    ],
    note: '基于 DeepSeek Harness 构建 · MIT License',
  },
  en: {
    tagline: 'An enterprise AI platform — desktop client, local agent engine and admin console — deployed on your own network from a single image.',
    groups: [
      {
        title: 'Product',
        links: [
          { label: 'Platform capabilities', href: '/en/#capabilities' },
          { label: 'Enterprise control', href: '/en/#control' },
          { label: 'Security', href: '/en/#security' },
        ],
      },
      {
        title: 'Deployment',
        links: [
          { label: 'Overview', href: '/en/deployment/' },
          { label: 'Containers', href: '/en/deployment/compose/' },
          { label: 'Upgrade and rollback', href: '/en/deployment/upgrade/' },
          { label: 'Client delivery', href: '/en/deployment/client-delivery/' },
          { label: 'Channels and white-label', href: '/en/deployment/channels/' },
          { label: 'Air-gapped', href: '/en/deployment/offline/' },
        ],
      },
      {
        title: 'Documentation',
        links: [
          { label: 'Quick start', href: '/en/getting-started/' },
          { label: 'Desktop client', href: '/en/desktop/' },
          { label: 'Admin console', href: '/en/admin/' },
          { label: 'Architecture', href: '/en/architecture/' },
          { label: 'API reference', href: '/en/api-reference/' },
          { label: 'FAQ', href: '/en/faq/' },
        ],
      },
      {
        title: 'Community',
        links: [
          { label: 'GitHub', href: REPOSITORY },
          { label: 'Release archive', href: `${REPOSITORY}/releases`, blank: true },
          { label: 'Report an issue', href: `${REPOSITORY}/issues`, blank: true },
        ],
      },
    ],
    note: 'Built on DeepSeek Harness · MIT License',
  },
}

/**
 * 取顶栏导航（`locale` 未知即抛 —— 页面写错 locale 要在构建期炸掉，不要静默回落到中文）。
 * @param {SiteLocale} locale
 * @returns {NavItem[]}
 */
export function headerNav(locale) {
  return table(HEADER_NAV, locale, 'header')
}

/**
 * 取顶栏右侧动作区（主 CTA / 语言切换 / 仓库入口）。
 * @param {SiteLocale} locale
 * @returns {HeaderActions}
 */
export function headerActions(locale) {
  return table(HEADER_ACTIONS, locale, 'header actions')
}

/**
 * 取页脚内容（同上，未知 `locale` 即抛）。
 * @param {SiteLocale} locale
 * @returns {FooterContent}
 */
export function footerContent(locale) {
  return table(FOOTER_CONTENT, locale, 'footer')
}

/**
 * 取该 locale 的首页路径（品牌 logo 的落点；顶栏「首页」项在表里，值相同）。
 * @param {SiteLocale} locale
 * @returns {string}
 */
export function homeHref(locale) {
  return table(SITE_HOME, locale, 'home')
}

/**
 * @template T
 * @param {Record<SiteLocale, T>} tables
 * @param {SiteLocale} locale
 * @param {string} what
 * @returns {T}
 */
function table(tables, locale, what) {
  const value = tables[locale]
  if (value === undefined) {
    throw new Error(
      `未知 locale "${locale}"（${what} 导航）：已知取值 = ${SITE_LOCALES.join(' / ')}。`
        + '英文页请传 locale="en"。',
    )
  }
  return value
}
