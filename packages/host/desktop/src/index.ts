import type {} from '@deepseek-ai/dsh-client-connection'
/** PicoAide Harness Host plugin: owns the selected native shell generation. */

import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-cmdline'
import {
  LOCALE_SETTINGS_NAMESPACE,
  type LocaleSettings,
} from '@deepseek-ai/dsh-client-locale'
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  THEME_SETTINGS_NAMESPACE,
  type ThemeSettings,
} from '@deepseek-ai/dsh-client-ui-theme'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import {
  handleRendererBootRequest,
  RENDERER_BOOT_REPORT_PATH,
} from './renderer-boot.ts'
import { DESKTOP_DIRECTORY_PICKER_PATH } from './directory-picker-contract.ts'
import { handleDesktopDirectoryPickerRequest } from './directory-picker-route.ts'
import {
  DESKTOP_UPDATE_PATH,
  DESKTOP_UPDATE_CHECK_PATH,
  emptyDesktopUpdateState,
  type DesktopUpdateStateResponse,
} from './desktop-update-contract.ts'
import {
  handleDesktopUpdateRequest,
  handleDesktopUpdateCheckRequest,
} from './desktop-update-route.ts'
import {
  DESKTOP_LOOP_NOTIFY_SESSION_PATH,
  emptyDesktopLoopNotifySession,
  type DesktopLoopNotifySessionResponse,
} from './loop-notify-contract.ts'
import { handleDesktopLoopNotifySessionRequest } from './loop-notify-route.ts'
import type { DesktopLocale, DesktopShellMode } from './runtime.ts'
import type {} from './runtime.ts'

/** Stable Cordis plugin name. */
export const name = 'desktop-shell'

// picoaide:// deep-link event forwarded by the desktop shell (auth callback);
// the enterprise plugin listens and completes OIDC/OpenID login.
declare module '@deepseek-ai/cordis' {
  interface Events {
    'pico/deep-link'(url: string): void
  }
}

/** Services required before the shell can register its renderer generation. */
/** Services required by the desktop shell; `desktopRuntime` is probed, not required. */
export const inject = ['webServer', 'webRuntime', 'appExit', 'settings', 'connection']

/** Standard settings namespace shared by tray and configuration surfaces. */
export const DESKTOP_SETTINGS_NAMESPACE = 'dsh-desktop' as SettingsNamespace

const UI_THEME_SETTINGS_NAMESPACE = THEME_SETTINGS_NAMESPACE as SettingsNamespace
const UI_LOCALE_SETTINGS_NAMESPACE = LOCALE_SETTINGS_NAMESPACE as SettingsNamespace

/** Bin the upstream locale preference onto the desktop's supported pair. */
function normalizeDesktopLocale(value: string | undefined): DesktopLocale | undefined {
  if (value === 'zh' || value === 'en') return value
  return undefined
}

/** Desktop settings presented by the standard settings service. */
export interface DesktopSettings {
  /** Loopback Web port selected for the next application generation; zero requests a random port. */
  port: number
  /** Log verbosity threshold applied to the file logger. */
  logLevel: 'debug' | 'info' | 'warn' | 'error'
}

/** Schema registered with the standard settings service. */
export const DesktopSettingsSchema: z<DesktopSettings> = z.object({
  port: z.number().step(1).min(0).max(65_535).default(0),
  logLevel: z.union(['debug', 'info', 'warn', 'error'] as const).default('info'),
})

/** Native window configuration. */
export interface Config {
  /** Product name shown in the tray, menus, and update notifications. */
  productName: string
  /** BrowserWindow title shown while the Web surface is connected. */
  windowTitle: string
  /** Configured loopback Web port used to detect restart-applied settings changes. */
  port: number
  /** Initial window width in CSS pixels. */
  width: number
  /** Initial window height in CSS pixels. */
  height: number
  /** Minimum window width in CSS pixels. */
  minWidth: number
  /** Minimum window height in CSS pixels. */
  minHeight: number
}

/** Validated native window configuration. */
export const Config: z<Config> = z.object({
  productName: z.string().default('PicoAide Harness'),
  windowTitle: z.string().default('PicoAide Harness'),
  port: z.number().step(1).min(0).max(65_535).default(0),
  width: z.number().step(1).min(800).default(1280),
  height: z.number().step(1).min(600).default(840),
  minWidth: z.number().step(1).min(640).default(900),
  minHeight: z.number().step(1).min(480).default(640),
})

/**
 * Construct the unmodified upstream Web root URL.
 * @param port - active loopback Web server port.
 * @param mode - active native presentation mode.
 * @param platform - active Electron platform.
 * @returns the URL loaded by the BrowserWindow.
 */
export function desktopRendererUrl(
  port: number,
  mode: DesktopShellMode,
  platform: Context['desktopRuntime']['platform'],
): string {
  const url = new URL(`http://127.0.0.1:${String(port)}/`)
  url.searchParams.set('dsh-desktop-mode', mode)
  url.searchParams.set('dsh-desktop-platform', platform)
  return url.href
}

/** Renderer URL carrying the 0.1.2 launch token plus the desktop presentation parameters. */
function desktopRendererUrlWithToken(ctx: Context, port: number, platform: Context['desktopRuntime']['platform']): string {
  // The upstream token exchange clears the query string, so mint the token on
  // the bare origin first, then restore the desktop presentation parameters
  // the client shell parses (mode/platform).
  const authed = ctx.connection.authenticatedUrl(`http://127.0.0.1:${String(port)}/`)
  const url = new URL(authed)
  url.searchParams.set('dsh-desktop-mode', 'advanced')
  url.searchParams.set('dsh-desktop-platform', platform)
  console.error('[desktop] renderer url:', url.href)
  return url.href
}

/**
 * Register the Electron shell from active Web carrier values.
 * @param ctx - Host context carrying the Electron adapter and Web carrier.
 * @param config - validated native window values.
 */
export function apply(ctx: Context, config: Config): void {
  const runtime = ctx.get('desktopRuntime')
  if (runtime === undefined) {
    process.stderr.write(
      'dsh-plugin-desktop: this profile is composed with the PicoAide Harness shell, which requires the desktop launcher (desktopRuntime).\n'
      + 'Start it with `dsh-desktop`, or select this profile inside the packaged PicoAide Harness application.\n'
      + 'The desktop terminal, profile, and update rows stay inactive in an ordinary DSH boot.\n',
    )
    return
  }
  const appExit = ctx.get('appExit')
  if (appExit === undefined) {
    throw new Error('dsh-plugin-desktop: the launcher did not provide ctx.appExit')
  }
  if (ctx.webServer.host !== '127.0.0.1') {
    throw new Error('dsh-plugin-desktop: desktop shell requires a loopback Web server')
  }
  const iconFilename = runtime.platform === 'darwin'
    ? 'app-icon-mac.png'
    : 'app-icon.png'
  const iconPath = fileURLToPath(new URL(`../build/${iconFilename}`, import.meta.url))
  const trayIcons = {
    templatePath: fileURLToPath(new URL('../build/tray-iconTemplate.png', import.meta.url)),
    bluePath: fileURLToPath(new URL('../build/tray-icon-blue.png', import.meta.url)),
  }
  const settings = ctx.settings.register(
    DESKTOP_SETTINGS_NAMESPACE,
    DesktopSettingsSchema,
    {
      applies: 'restart',
    },
  )
  const rendererOrigin = `http://127.0.0.1:${String(ctx.webServer.port)}`
  let desktopUpdateState: DesktopUpdateStateResponse = {
    ...emptyDesktopUpdateState(),
    // Headless loader smokes provide a stub desktopRuntime without an update
    // adapter; the badge route then serves empty state (renderer hides it).
    isPackaged: runtime.updates?.isPackaged ?? false,
    canDownload: runtime.updates?.canDownload ?? false,
    currentVersion: runtime.updates?.currentVersion ?? '',
  }
  // Route publishes the latest update-coordinator transition; before the
  // coordinator starts, the badge serves the static packaged facts.
  if (runtime.updates !== undefined) {
    runtime.updates.publishState = (snapshot) => {
      desktopUpdateState = { ...snapshot }
    }
  }
  let loopNotifySession: DesktopLoopNotifySessionResponse = emptyDesktopLoopNotifySession()
  runtime.setSessionOpenRequestHandler?.(sessionId => {
    loopNotifySession = { sessionId, requestedAt: Date.now() }
  })
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: DESKTOP_LOOP_NOTIFY_SESSION_PATH,
      handler: (req, res) => handleDesktopLoopNotifySessionRequest(
        req,
        res,
        rendererOrigin,
        () => loopNotifySession,
      ),
    }),
    'dsh-plugin-desktop: loop-notify session jump route',
  )
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: DESKTOP_UPDATE_PATH,
      handler: (req, res) => handleDesktopUpdateRequest(
        req,
        res,
        rendererOrigin,
        () => desktopUpdateState,
      ),
    }),
    'dsh-plugin-desktop: update badge state route',
  )
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: DESKTOP_UPDATE_CHECK_PATH,
      handler: (req, res) => handleDesktopUpdateCheckRequest(
        req,
        res,
        rendererOrigin,
        () => { runtime.updates?.checkNow?.() },
      ),
    }),
    'dsh-plugin-desktop: update badge check route',
  )
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: RENDERER_BOOT_REPORT_PATH,
      handler: (req, res) => handleRendererBootRequest(
        req,
        res,
        rendererOrigin,
        report => { runtime.reportRendererBoot(report) },
      ),
    }),
    'dsh-plugin-desktop: renderer boot report route',
  )
  if (runtime.platform === 'win32') {
    ctx.effect(
      () => ctx.webServer.register({
        kind: 'exact',
        path: DESKTOP_DIRECTORY_PICKER_PATH,
        handler: (req, res) => handleDesktopDirectoryPickerRequest(
          req,
          res,
          rendererOrigin,
          () => runtime.pickDirectory(),
          cause => {
            ctx.logger.error(`dsh-plugin-desktop: native directory picker failed: ${cause instanceof Error ? cause.message : String(cause)}`)
          },
        ),
      }),
      'dsh-plugin-desktop: native directory picker route',
    )
  }
  ctx.effect(() => {
    let pending: ReturnType<typeof setImmediate> | undefined
    const stopWatching = settings.watch((next) => {
      if (next.port === config.port) {
        if (pending !== undefined) clearImmediate(pending)
        pending = undefined
        return
      }
      pending ??= setImmediate(() => {
        pending = undefined
        void runtime.requestRestart().catch((cause: unknown) => {
          ctx.logger.error('dsh-plugin-desktop: failed to restart after startup setting change')
          ctx.logger.error(cause)
        })
      })
    })
    return () => {
      stopWatching()
      if (pending !== undefined) clearImmediate(pending)
    }
  }, 'dsh-plugin-desktop: restart after startup setting change')
  ctx.on('settings/updated', (namespace, next) => {
    if (namespace !== UI_THEME_SETTINGS_NAMESPACE) return
    runtime.setThemeSource((next as ThemeSettings).preference)
  })
  ctx.on('settings/updated', (namespace, next) => {
    if (namespace !== UI_LOCALE_SETTINGS_NAMESPACE) return
    runtime.setLocalePreference(normalizeDesktopLocale((next as LocaleSettings).preference))
  })
  // picoaide:// deep links (auth callback): forward to Host consumers.
  // The enterprise plugin listens for 'pico/deep-link' and completes the
  // OIDC/OpenID login by storing the token from the link.
  runtime.setDeepLinkHandler(url => {
    ctx.emit('pico/deep-link', url)
  })
  ctx.effect(
    () => runtime.schedule({
      ...config,
      // Upstream 0.1.2: the Web index requires a process launch-token exchange
      // (`authorizeIndex`); the shell must load the token-bearing URL so the
      // renderer gets index bytes instead of a 401. The connection service is
      // optional here (minimal boot smokes omit the Web carrier); the full
      // desktop profile always composes it.
      url: desktopRendererUrlWithToken(ctx, ctx.webServer.port, runtime.platform),
      productName: config.productName,
      windowTitle: config.windowTitle,
      iconPath,
      trayIcons,
      readLocalePreference: () => {
        return normalizeDesktopLocale((ctx.settings.get(UI_LOCALE_SETTINGS_NAMESPACE) as LocaleSettings | undefined)?.preference)
      },
      readThemeSource: () => {
        const theme = ctx.settings.get(UI_THEME_SETTINGS_NAMESPACE) as ThemeSettings | undefined
        if (theme === undefined) {
          throw new Error('dsh-plugin-desktop: advanced shell requires the ui-theme settings namespace')
        }
        return theme.preference
      },
      requestQuit: appExit,
    }),
    'dsh-plugin-desktop: native shell generation',
  )
}
