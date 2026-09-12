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
]

/** Register desktop-owned client surfaces for the current BrowserWindow mode. @param ctx - browser Cordis context. */
export function apply(ctx: ClientContext): void {
  const environment = parseDesktopClientEnvironment(window.location.search)
  if (!environment) return
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
  // 更新快照是**一个窗口一份**的共享状态:三个展示面(侧边栏、设置「关于」、
  // 会话头部徽标)都从这里取,不再各起一个轮询(2026-09-12 用户报"两处不同步")。
  applyUpdateStore(ctx)
  if (environment.mode === 'advanced') {
    applyAdvancedShell(ctx, environment)
    applyUpdateBadge(ctx)
  }
}
