import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import { applyAdvancedShell } from './advanced-shell.ts'
import { registerDesktopSettings } from './desktop-settings.tsx'
import { parseDesktopClientEnvironment } from './environment.ts'

export { applyAdvancedShell } from './advanced-shell.ts'
export {
  DESKTOP_SETTINGS_LOCALE_NAMESPACE,
  registerDesktopSettings,
  setDesktopMode,
} from './desktop-settings.tsx'
export type { DesktopSettings, DesktopSettingsSectionProps } from './desktop-settings.tsx'
export { parseDesktopClientEnvironment } from './environment.ts'
export type { DesktopClientEnvironment, DesktopClientMode, DesktopClientPlatform } from './environment.ts'

/** Services required by desktop settings and advanced presentation. */
export const inject = [
  'slots',
  'sessions',
  'workspaces',
  'locale',
  'theme',
]

/** Register desktop-owned client surfaces for the current BrowserWindow mode. @param ctx - browser Cordis context. */
export function apply(ctx: ClientContext): void {
  const environment = parseDesktopClientEnvironment(window.location.search)
  registerDesktopSettings(ctx, environment)
  if (environment.mode === 'advanced') applyAdvancedShell(ctx, environment)
}
