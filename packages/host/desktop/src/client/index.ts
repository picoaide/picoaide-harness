import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the UI slot registry + SlotMap row declarations (root/layout).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Type convergence only: locale/theme declarations expose settings slot rows.
// The desktop client does not load or register a settings surface.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import { applyAdvancedShell } from './advanced-shell.ts'
import { startRendererBootReporter } from './boot-health.ts'
import { applyUpdateBadge, applyUpdateStore } from './desktop-update.tsx'
import { installDesktopDirectoryPickerBridge } from './directory-picker.ts'
import { parseDesktopClientEnvironment } from './environment.ts'
import { applyLoopNotifyClient } from './loop-notify.tsx'
import { applyLegacyThemeTokens } from './legacy-theme-tokens.ts'
import { setActiveLocale } from './locales.ts'

export { applyAdvancedShell } from './advanced-shell.ts'
export {
  RENDERER_BOOT_REPORT_PATH,
  rendererBootReport,
  sendRendererBootReport,
  startRendererBootReporter,
} from './boot-health.ts'
export type { RendererBootLoader, RendererBootReport } from './boot-health.ts'
export { parseDesktopClientEnvironment } from './environment.ts'
export {
  applyUpdateBadge,
  applyUpdateStore,
  DESKTOP_UPDATE_SERVICE,
  desktopUpdateService,
  DesktopUpdateBadge,
  desktopUpdateBadgeView,
  fetchDesktopUpdateState,
  readDesktopUpdate,
  subscribeDesktopUpdate,
  triggerDesktopUpdateAction,
  triggerDesktopUpdateCheck,
  updateActionFor,
  useDesktopUpdateState,
} from './desktop-update.tsx'
export type {
  DesktopUpdateAction,
  DesktopUpdateBadgeView,
  DesktopUpdateService,
} from './desktop-update.tsx'
export type { DesktopClientEnvironment, DesktopClientMode, DesktopClientPlatform } from './environment.ts'

/** Services required by advanced presentation. */
export const inject = [
  'slots',
  'sessions',
  'theme',
  // Desktop-owned client copy (the update badge) needs the active locale. The
  // client dictionaries read a module-local value, so follow the service here
  // the same way the sibling packages do; every slot outlet re-renders on a
  // locale switch, which re-evaluates `t()` at the new language.
  'locale',
]

/** Register desktop-owned client surfaces for the current BrowserWindow mode. @param ctx - browser Cordis context. */
export function apply(ctx: ClientContext): void {
  const environment = parseDesktopClientEnvironment(window.location.search)
  if (!environment) return
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
  }, 'dsh-plugin-desktop: follow active locale')
  ctx.effect(
    () => startRendererBootReporter(ctx.loader),
    'dsh-plugin-desktop: renderer boot health report',
  )
  if (environment.platform === 'win32') {
    ctx.effect(
      () => installDesktopDirectoryPickerBridge(),
      'dsh-plugin-desktop: native directory picker bridge',
    )
  }
  applyLoopNotifyClient(ctx)
  // vendored memory-evolve 的旧色板适配层（见 legacy-theme-tokens.ts 的模块注释）：
  // 41 个上游不存在的 `--dsw-*` 名字在这里获得真实取值 —— 否则它们永远走 fallback
  // （37 条声明直接失效、其余颜色不随主题变化）。层是 effect 作用域：卸载即摘掉。
  ctx.effect(
    () => applyLegacyThemeTokens(ctx) ?? (() => { /* 主题服务缺席（最小启动）：无层可摘 */ }),
    'dsh-plugin-desktop: vendored legacy theme tokens',
  )
  // 更新快照是**一个窗口一份**的共享状态:三个展示面(侧边栏、设置「关于」、
  // 会话头部徽标)都从这里取,不再各起一个轮询(2026-09-12 用户报"两处不同步")。
  applyUpdateStore(ctx)
  if (environment.mode === 'advanced') {
    applyAdvancedShell(ctx, environment)
    applyUpdateBadge(ctx)
  }
}
