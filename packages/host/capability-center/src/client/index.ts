/**
 * 能力中心（技能商店）的**客户端半边**。
 *
 * 2026-10-13 从 `@picoaide/dsh-enterprise` 的 `src/client/index.ts` 搬出：整页面板
 * （能力中心）、它依赖的数据模块（内置技能区 / 版本比较）与全部 `capability.*` 文案，
 * 现在随**本包**进出产物 —— 将来"关掉技能商店"只要把本包从 profile 的 bundle 层里
 * 去掉，宿主与客户端两侧都不会再有任何技能商店代码。
 *
 * 行为零变化是这次搬迁的硬约束（逐条对照）：
 *   - 面板 id 仍是 `'capability'`（`@picoaide/dsh-panel-surface` 的 PanelId）；
 *   - 底部「更多」条目的 id/order/文案/activate 与搬前逐字相同；
 *   - 条目仍登记在**子 fiber** 里等 `picoFootMenu`（不写进硬 `inject`）：提供它的那一行
 *     可以被渠道覆盖层 / `$DSH_HOME/cordis.patch.yml` 禁用，硬 inject 会让整条 fiber
 *     永久 pending（无报错），把面板一起带走（P1-7 教训）；
 *   - 字典键路径与取值一字未改（只换了注册命名空间，见 `./locales.ts`）。
 *
 * @module @picoaide/dsh-capability-center/client
 */

import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the foot-lane registry contract (`ctx.picoFootMenu`). The single
// sidebar foot row belongs to `@picoaide/dsh-foot-menu` and reaches this bundle
// as a Cordis service — never as a module import.
import type {} from '@picoaide/dsh-foot-menu/client'
import { mountCapabilityCenter, openCapabilityCenter } from './capability-surface.tsx'
import { installSkillCardStyle } from './skill-card-style.ts'
import { en, setActiveLocale, t, type CapabilityKey, zh } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Capability-center client surface copy. */
    capability: CapabilityKey
  }
}

/** Stable Cordis plugin name for the capability-center client half. */
export const name = 'picoaide-capability-center-client'

/** Locale namespace owning the capability-center copy. */
const LOCALE_NS = 'capability'

/** Services required: the slot registry (the page surface) and locale. `picoFootMenu` is waited on from a child scope. */
export const inject = ['slots', 'locale']

/**
 * Register the capability-center surfaces: the `capability` client dictionary,
 * the sidebar foot action that opens the page surface, and the middle-column
 * page itself (mounted once per plugin instance).
 * @param ctx - browser Cordis context.
 */
export function apply(ctx: ClientContext): void {
  // Capability-center dictionaries (zh key source, en mirror).
  ctx.effect(() => {
    const off = ctx.locale.register(LOCALE_NS, { zh, en })
    return () => { off() }
  }, 'capability-center: client dictionaries')

  // Follow the active locale so the module-level `t()` (used by components
  // that do not receive PropsLocale) renders in English when that is the
  // user's choice, instead of always reading the zh key source.
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
  }, 'capability-center: follow active locale')

  // 底部「更多」浮层条目（唯一的底栏行由 `@picoaide/dsh-foot-menu` 拥有）：
  // id 就是 panel-surface 的 PanelId，行因此在能力中心激活时显示「更多 · 能力中心」。
  //
  // 登记放在**子 fiber** 里等服务到位，而不是把 `picoFootMenu` 写进 `inject`：
  // 提供它的那一行可以被渠道覆盖层 / `$DSH_HOME/cordis.patch.yml` 禁用，硬 inject
  // 会让整条 fiber 永久 pending（无报错），把能力中心面板一起带走（P1-7 教训）。
  // 只有"登记这一个条目"等它。
  ctx.inject(['picoFootMenu'], (scope: ClientContext) => {
    scope.effect(() => scope.picoFootMenu.add({
      id: 'capability',
      order: -1,
      title: () => t('capability.title'),
      activate: openCapabilityCenter,
    }), 'capability-center: capability center foot menu entry')
  })

  // 中列整页（插件启动时挂一次；容器常驻会话列、在 React 树之外）。切换语义与
  // 连接器/应用中心/定时任务共用 `@picoaide/dsh-panel-surface`。
  ctx.effect(() => mountCapabilityCenter(), 'capability-center: capability center surface')

  // 技能卡的悬停/焦点反馈（CSS-only，随面板一起搬来时的那三条规则）。
  ctx.effect(() => installSkillCardStyle(), 'capability-center: skill card style')
}
