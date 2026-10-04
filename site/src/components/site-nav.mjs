/**
 * 顶栏 / 页脚导航的文案与链接（**唯一真源**，按 locale 取表）。
 *
 * ## 为什么单独一份数据
 *
 * `Header.astro` / `Footer.astro` 同时被中文页（`src/pages/index.astro` 等）与英文落地页
 * （`src/pages/en/index.astro`）挂载，而两站的**链接前缀不同**：中文站是根 locale
 * （`/…`），英文站是 `/en/…`（`astro.config.mjs` 的 Starlight `locales`）。
 * 组件里原先硬编码的是中文标签 + 根 locale 链接 ⇒ 英文落地页上的 15 条导航链接
 * **全部把访客送回中文站**，其中「功能 → `/#features`」甚至不回本页自己的
 * `id="features"`（回归审计 v2.8.1→HEAD 的 E-04）。现在组件按 `locale` 取表。
 *
 * ## 三条硬约束（改这个文件之前先读）
 *
 * 1. **缺省 `root` 表是冻结的历史值**：中文页不传 `locale`，渲染结果必须与改动前
 *    **逐字节一致**。`site/scripts/check-en-landing-nav.mjs` 把 `root` 表当成冻结契约
 *    逐条对拍 —— 要改中文导航，就连那条判据里的期望值一起改（有意为之：中文站导航是
 *    产品决策，不能顺手漂移）。
 * 2. **站内链接一律绝对路径 + 结尾斜杠**（本仓硬约定），英文表一律 `/en/` 前缀；
 *    锚点只用**本页自己的 id**（英文落地页有 `#features` / `#deployment` / `#docs`，
 *    没有 `#screenshots` / `#delivery`）⇒ 英文表不得出现指向中文页锚点的链接。
 * 3. **英文表里只放英文站真实存在的落点**：`/blog/`、`/about/` 只有中文页，截图墙也只长在
 *    中文落地页上 ⇒ 英文导航不列这三项（宁可少一项，也不把英文访客送回中文站）。
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
 * 顶栏导航项。
 * @typedef {{ label: string, href: string }} NavItem
 */

/**
 * 页脚内容：一句介绍 + 若干栏（栏内是链接）+ 页脚尾注。
 * `blank` = 新窗口打开（`target="_blank" rel="noopener"`；中文站历史上只有「版本归档」与
 * 「提交 Issue」两项带它，冻结契约照抄，不要"顺手统一"）。
 * @typedef {{ tagline: string, groups: { title: string, links: (NavItem & { blank?: boolean })[] }[], note: string }} FooterContent
 */

/**
 * 各 locale 的首页（品牌 logo 与顶栏「首页」项共用同一个落点）。
 * @type {Record<SiteLocale, string>}
 */
const SITE_HOME = {
  root: '/',
  en: '/en/',
}

/** @type {Record<SiteLocale, NavItem[]>} */
const HEADER_NAV = {
  // 冻结的历史值（中文站逐字节不变的判据锚点）。
  root: [
    { label: '首页', href: '/' },
    { label: '部署', href: '/deployment/' },
    { label: '功能', href: '/#features' },
    { label: '截图', href: '/#screenshots' },
    { label: '博客', href: '/blog/' },
    { label: 'Wiki', href: '/welcome/' },
  ],
  en: [
    { label: 'Home', href: '/en/' },
    { label: 'Deployment', href: '/en/deployment/' },
    { label: 'Features', href: '/en/#features' },
    { label: 'Wiki', href: '/en/welcome/' },
  ],
}

/** @type {Record<SiteLocale, FooterContent>} */
const FOOTER_CONTENT = {
  // 冻结的历史值（中文站逐字节不变的判据锚点）。
  root: {
    tagline: '企业级 DeepSeek Harness 一体化平台，支持私有化部署。',
    groups: [
      {
        title: '产品',
        links: [
          { label: '私有化部署', href: '/#deployment' },
          { label: '客户端交付', href: '/#delivery' },
          { label: '核心特性', href: '/#features' },
          { label: '界面截图', href: '/#screenshots' },
        ],
      },
      {
        title: '资源',
        links: [
          { label: '快速开始', href: '/getting-started/' },
          { label: '升级与回滚', href: '/deployment/upgrade/' },
          { label: '博客', href: '/blog/' },
          { label: 'Wiki 文档', href: '/welcome/' },
          { label: '关于我们', href: '/about/' },
        ],
      },
      {
        title: '社区',
        links: [
          { label: 'GitHub', href: 'https://github.com/picoaide/picoaide-harness' },
          {
            label: '版本归档',
            href: 'https://github.com/picoaide/picoaide-harness/releases',
            blank: true,
          },
          {
            label: '提交 Issue',
            href: 'https://github.com/picoaide/picoaide-harness/issues',
            blank: true,
          },
        ],
      },
    ],
    note: '基于 DeepSeek Harness 构建。',
  },
  en: {
    tagline: 'An enterprise AI platform built on DeepSeek Harness, deployed on your own network.',
    groups: [
      {
        title: 'Product',
        links: [
          { label: 'Private deployment', href: '/en/#deployment' },
          { label: 'Client delivery', href: '/en/deployment/client-delivery/' },
          { label: 'Core features', href: '/en/#features' },
        ],
      },
      {
        title: 'Resources',
        links: [
          { label: 'Quick start', href: '/en/getting-started/' },
          { label: 'Upgrade and rollback', href: '/en/deployment/upgrade/' },
          { label: 'Wiki documentation', href: '/en/welcome/' },
        ],
      },
      {
        title: 'Community',
        links: [
          { label: 'GitHub', href: 'https://github.com/picoaide/picoaide-harness' },
          {
            label: 'Release archive',
            href: 'https://github.com/picoaide/picoaide-harness/releases',
            blank: true,
          },
          {
            label: 'Report an issue',
            href: 'https://github.com/picoaide/picoaide-harness/issues',
            blank: true,
          },
        ],
      },
    ],
    note: 'Built on DeepSeek Harness.',
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
