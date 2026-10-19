/**
 * 客户端半边：字典 + 提供 `picoFootMenu` 服务 + 注册**唯一**一个底部座位占用者。
 *
 * 座位（`sidebar.footer.action`）以前有五个占用者（定时任务 / 能力中心 / 连接器 /
 * 浏览器 / 应用中心，各一整行）。现在只有这一个：它渲染「更多」行 + 向上浮层，
 * 条目由兄弟插件经 `picoFootMenu` 登记（见 `contract.ts`）。
 *
 * 纪律：运行时的值导入只允许平台模块表里的包；`@deepseek-ai/*` 与兄弟包一律 type-only
 * 进入（跨插件协作只走 Cordis 服务与槽位）。
 *
 * @module @picoaide/dsh-foot-menu/client
 */

import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the slot runtime props + SlotMap into this compilation face.
import type {} from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: declares the sidebar foot action slot contract (`sidebar.footer.action`)
// and its `wide` runtime prop.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { createFootMenuService, installFootMenu } from './contract.ts'
import { FootMenuRow } from './FootMenuRow.tsx'
import { en, setActiveLocale, t, type FootMenuKey, zh } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Foot lane copy. */
    'foot-menu': FootMenuKey
  }
}

/** Stable Cordis plugin name for the foot lane client half. */
export const name = 'picoaide-foot-menu-client'

/** Locale namespace owning the foot lane copy. */
const LOCALE_NS = 'foot-menu'

/** Services required: the slot registry (the single foot seat) and locale. */
export const inject = ['slots', 'locale']

// 类型出口（**必须显式再导出**）：消费者用 `import type {} from
// '@picoaide/dsh-foot-menu/client'` 取 `declare module '@deepseek-ai/cordis'` 的
// `Context` 合并，而那个合并住在 `./contract.ts`。`apply` 的实现体里对
// contract 的引用会被声明生成擦掉，若不在这里再导出，`index.d.ts` 就不再引用
// contract.d.ts —— 消费者编译期拿不到 `ctx.picoFootMenu`（TS2339），而运行时
// 一切正常（最难查的一类漂移）。
export type { FootMenuEntry, FootMenuService } from './contract.ts'

/**
 * Open the official Schedule manager (registered in `main` under key
 * `schedules`). The official sidebar row is hidden by this plugin, so the
 * click is the supported way to select that panel without duplicating it.
 */
function openOfficialSchedulePanel(): void {
  if (typeof document === 'undefined') return
  const rows = [...document.querySelectorAll('button')].filter(button =>
    [...button.classList].some(token => token === 'panelRow' || token.endsWith('_panelRow')))
  const label = t('footMenu.schedule')
  const target = rows.find(button => button.getAttribute('aria-label') === label)
  // 找不到官方行时不要先关掉当前面板：那会让用户“点一下只剩空白”。
  if (target === undefined) return
  // 官方面板走 layout，而本产品的 panel-surface 用 html[data-dsh-panel-active]
  // 让位主列：不先关掉当前桌面面板，官方页会被 stylesheet 的 :not(...) 规则隐藏，
  // 表现为“点了没反应”。广播一个 null 激活事件让 panel-surface 走 close()。
  document.dispatchEvent(new CustomEvent('dsh-panel-activate', { detail: null }))
  target.click()
}

/**
 * Register the foot lane: the one sidebar foot occupant plus the `picoFootMenu`
 * registry every sibling panel entry registers into.
 * @param ctx - browser Cordis context.
 */
/**
 * Hide official client chrome that this product replaces. Exported for jsdom
 * regression tests: callers pass the document to keep the effect testable.
 *
 * - `sidebar.panellist` rows for 自动化任务 / 插件 (duplicate product entries);
 * - official AccountMenu's 登录 / 退出登录 / 意见反馈 items;
 * - settings navigation entries for 模型 / 内置插件.
 */
export function installProductChromeHiding(doc: Document): () => void {
  hideProductChrome(doc)
  const observer = new MutationObserver(() => hideProductChrome(doc))
  observer.observe(doc.body, { childList: true, subtree: true })
  return () => observer.disconnect()
}

export function hideProductChrome(doc: Document): void {
  // 官方 sidebar.panellist 的重复入口：自动化任务（自研 cron 的替身入口已移到
  // 「更多」浮层）与插件（本产品不暴露官方插件管理页）。
  const panelLabels = new Set(['自动化任务', 'Automation tasks', '插件', 'Plugins'])
  // 官方账户菜单里的认证/反馈项：本产品用自己的账户卡与渠道反馈入口。
  const accountItemLabels = new Set([
    '登录', '退出登录', '意见反馈',
    'Sign in', 'Sign out', 'Feedback',
  ])
  const visibleText = (el: Element): string => (el.textContent ?? '').replace(/\s+/gu, ' ').trim()
  const hidePanelRows = (): void => {
    for (const button of doc.querySelectorAll('button')) {
      const tokens = [...button.classList]
      if (!tokens.some(token => token === 'panelRow' || token.endsWith('_panelRow'))) continue
      if (panelLabels.has(button.getAttribute('aria-label') ?? '')) button.style.display = 'none'
    }
  }
  const settingsNavLabels = new Set(['模型', 'Models', '内置插件', 'Built-in plugins'])
  const hideSettingsNav = (): void => {
    const generals = [...doc.querySelectorAll('button')].filter(button => /^(通用设置|General)$/u.test(visibleText(button)))
    for (const general of generals) {
      const container = general.closest('[role="dialog"]') ?? general.parentElement?.parentElement
      if (container == null) continue
      for (const button of container.querySelectorAll('button')) {
        if (settingsNavLabels.has(visibleText(button))) button.style.display = 'none'
      }
    }
  }
  const hideAccountItems = (): void => {
    // 只处理同时含「设置」的菜单：那是官方 AccountMenu；本产品自己的 foot-menu
    // 浮层与账户卡浮层都没有「设置」项，不会被误伤。
    for (const menu of doc.querySelectorAll('[role="menu"]')) {
      const items = [...menu.querySelectorAll('button, [role="menuitem"]')]
      const hasSettings = items.some((item) => {
        const text = visibleText(item)
        return text.startsWith('设置') || text.startsWith('Settings')
      })
      if (!hasSettings) continue
      for (const item of items) {
        const text = visibleText(item)
        if ([...accountItemLabels].some(label => text === label || text.startsWith(`${label} `))) {
          (item as HTMLElement).style.display = 'none'
        }
      }
    }
  }
  hidePanelRows()
  hideSettingsNav()
  hideAccountItems()
}

export function apply(ctx: ClientContext): void {
  // Foot lane dictionaries (zh key source, en mirror).
  ctx.effect(() => {
    const off = ctx.locale.register(LOCALE_NS, { zh, en })
    return () => { off() }
  }, 'foot-menu: client dictionaries')

  // Follow the active locale so the module-level `t()` renders in English when
  // that is the user's choice instead of always reading the zh key source.
  ctx.effect(() => {
    const locale = ctx.locale as unknown as {
      getLocale?: () => { active?: unknown }
      subscribe?: (listener: () => void) => () => void
    }
    const sync = (): void => {
      try {
        const active = locale.getLocale?.()?.active
        if (typeof active === 'string') setActiveLocale(active)
      } catch { /* keep the last known locale */ }
    }
    sync()
    if (typeof locale.subscribe !== 'function') return () => {}
    return locale.subscribe(sync)
  }, 'foot-menu: follow active locale')

  // Hover/focus feedback for the row and the popover items (行内几何 + 注入的少量
  // 全局样式：与浏览器/连接器插件原先的 `.pico-*-trigger:hover` 写法同源)。
  //
  // **透明底必须与 hover 底同处一张样式表**：行内 `background: transparent` 的
  // 优先级高于任何选择器规则，写进行内联样式就等于把 `:hover` 永久压死
  //（2026-09-21 行查发现的真实缺陷，账户行同一根因）。类名留在元素上，
  // `:hover` 规则靠特异性取胜。
  ctx.effect(() => {
    // 宿主半边可能在无 DOM 环境里被加载（SSR 预渲染 / node 单测）。
    if (typeof document === 'undefined') return () => {}
    const style = document.createElement('style')
    style.textContent = [
      '.pico-foot-menu-trigger { background: transparent; }',
      '.pico-foot-menu-trigger:hover { background: var(--dsw-alias-interactive-bg-hover); }',
      '.pico-foot-menu-item { background: transparent; }',
      '.pico-foot-menu-item:hover, .pico-foot-menu-item:focus-visible { background: var(--dsw-alias-interactive-bg-hover); }',
    ].join('\n')
    document.head.appendChild(style)
    return () => { style.remove() }
  }, 'foot-menu: hover styles')

  // 登记表：条目跨 bundle 传数据（ReactNode 不过界），兄弟插件在各自的 apply 里
  // 用 `ctx.picoFootMenu.add(...)` 登记，注销函数由它们的 `ctx.effect` 调用。
  const service = createFootMenuService()
  ctx.effect(() => installFootMenu(ctx, service), 'foot-menu: menu registry')

  // 官方「自动化任务」（0.2.1）：取代自研 cron，入口固定在「更多」浮层的原来第一位
  // （order -10）。官方自己在 `sidebar.panellist` 还渲染一行同名入口；本插件把它隐藏，
  // 保证同一功能只有这一个入口、位置不变。
  ctx.effect(() => service.add({
    id: 'schedules',
    order: -10,
    title: () => t('footMenu.schedule'),
    activate: openOfficialSchedulePanel,
  }), 'foot-menu: official automation entry')
  ctx.effect(() => {
    if (typeof document === 'undefined') return () => {}
    return installProductChromeHiding(document)
  }, 'foot-menu: hide official duplicate entries and account menu auth/feedback items')

  // 唯一占用者：整个底部功能区只剩这一行（账目卡与设置各自在别的座位）。
  ctx.effect(
    () => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
      name: 'sidebar.footer.action',
      id: 'pico-foot-menu',
      order: 10,
    }, FootMenuRow)),
    'foot-menu: sidebar row',
  )
}
