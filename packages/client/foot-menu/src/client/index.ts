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
import { en, setActiveLocale, type FootMenuKey, zh } from './locales.ts'

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
 * Register the foot lane: the one sidebar foot occupant plus the `picoFootMenu`
 * registry every sibling panel entry registers into.
 * @param ctx - browser Cordis context.
 */
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
