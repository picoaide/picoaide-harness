import type {} from '@deepseek-ai/dsh-client-connection'
/** PicoAide Harness Host plugin: owns the selected native shell generation. */

import { fileURLToPath } from 'node:url'
import type { Context, Volatile } from '@deepseek-ai/cordis'
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
import { DESKTOP_TITLEBAR_DOUBLE_CLICK_PATH } from './desktop-window-contract.ts'
import { handleDesktopTitleBarDoubleClickRequest } from './desktop-window-route.ts'
import {
  handleRendererBootRequest,
  RENDERER_BOOT_REPORT_PATH,
} from './renderer-boot.ts'
import { DESKTOP_DIRECTORY_PICKER_PATH } from './directory-picker-contract.ts'
import { handleDesktopDirectoryPickerRequest } from './directory-picker-route.ts'
import {
  DESKTOP_UPDATE_PATH,
  DESKTOP_UPDATE_CHECK_PATH,
  DESKTOP_UPDATE_INSTALL_PATH,
  emptyDesktopUpdateState,
  type DesktopUpdateStateResponse,
} from './desktop-update-contract.ts'
import {
  handleDesktopUpdateRequest,
  handleDesktopUpdateCheckRequest,
  handleDesktopUpdateInstallRequest,
} from './desktop-update-route.ts'
import {
  DESKTOP_LOOP_NOTIFY_SESSION_PATH,
  emptyDesktopLoopNotifySession,
  type DesktopLoopNotifySessionResponse,
} from './loop-notify-contract.ts'
import { handleDesktopLoopNotifySessionRequest } from './loop-notify-route.ts'
import {
  handleVoiceMicRequest,
  handleVoiceMicStatusRequest,
  VOICE_MIC_REQUEST_PATH,
  VOICE_MIC_STATUS_PATH,
  type VoiceMicDeps,
} from './voice-mic-route.ts'
import {
  BRAND_FAVICON_PATH,
  BRAND_MANIFEST_PATH,
  buildBrandWebAssets,
  handleBrandAssetRequest,
} from './brand-web-route.ts'
import { readDesktopChannelProfile } from './desktop-channel.ts'
import type { ConnectionTrustFence, WriteProofDeps } from './write-proof.ts'
import type { DesktopLocale, DesktopShellMode } from './runtime.ts'
import { desktopLocaleFromPreference } from './desktop-locale.ts'
import { readSettingsNamespace } from './settings-forms.ts'
import type {} from './runtime.ts'

/** Stable Cordis plugin name. */
export const name = 'desktop-shell'

// picoaide:// deep-link event forwarded by the desktop shell (auth callback);
// the enterprise plugin listens and completes OIDC/OpenID login.
declare module '@deepseek-ai/cordis' {
  interface Events {
    'pico/deep-link'(url: string): void
    /**
     * The user-visible language actually changed (in-app locale setting).
     *
     * Host-rendered surfaces that are served per request (the embedded browser's
     * chrome pages) are already open by then and cannot re-render themselves;
     * they listen for this event and re-serve (2026-09-16 R9 audit).
     */
    'pico/locale-changed'(locale: DesktopLocale): void
  }
}

/** Services required before the shell can register its renderer generation. */
/** Services required by the desktop shell; `desktopRuntime` is probed, not required. */
export const inject = ['webServer', 'webRuntime', 'appExit', 'settings', 'connection']

/**
 * Retired settings namespace.
 *
 * Up to DSH 0.1.6 this was the section of `$DSH_HOME/settings.yaml` carrying the
 * desktop's own settings. Upstream 0.1.7 removed that document and made a
 * profile **entry id** the settings namespace, so the live namespace is
 * {@link DESKTOP_SETTINGS_ENTRY_ID}; this constant survives only as the legacy
 * section name the launcher still reads once as a migration fallback.
 */
export const DESKTOP_SETTINGS_NAMESPACE = 'dsh-desktop' as SettingsNamespace

/**
 * Profile entry id that owns the desktop's user-editable settings.
 *
 * The entry is this plugin's own row (`name`, i.e. `desktop-shell`), which is
 * why the fields below are declared `volatile`: the settings form projects a
 * volatile field into the profile patch and edits it without remounting the
 * row.
 */
export const DESKTOP_SETTINGS_ENTRY_ID = name

const UI_THEME_SETTINGS_NAMESPACE = THEME_SETTINGS_NAMESPACE as SettingsNamespace
const UI_LOCALE_SETTINGS_NAMESPACE = LOCALE_SETTINGS_NAMESPACE as SettingsNamespace

/** File-logger verbosity thresholds the desktop settings form offers. */
export type DesktopLogLevel = 'debug' | 'info' | 'warn' | 'error'

/** Desktop settings in the resolved config the plugin receives (volatile references). */
export interface DesktopSettings {
  /** Loopback Web port; zero requests a random port. */
  port: Volatile<number>
  /** File-logger verbosity threshold. */
  logLevel: Volatile<DesktopLogLevel>
}

/**
 * Plain (document) shape of {@link Config}: what a config document holds, and
 * therefore what the schema validates.
 */
export interface DesktopShellConfigDocument {
  /** Product name shown in the tray, menus, and update notifications. */
  productName: string
  /** BrowserWindow title shown while the Web surface is connected. */
  windowTitle: string
  /** Configured loopback Web port. */
  port: number
  /** Initial window width in CSS pixels. */
  width: number
  /** Initial window height in CSS pixels. */
  height: number
  /** Minimum window width in CSS pixels. */
  minWidth: number
  /** Minimum window height in CSS pixels. */
  minHeight: number
  /** File-logger verbosity threshold. */
  logLevel: DesktopLogLevel
}

/**
 * Desktop settings **as the settings form reports them**.
 *
 * The form projection resolves every volatile reference before handing the
 * value out (`SettingsForms.describe()` → `plainConfig`), so readers see plain
 * data; the `Volatile` wrappers exist only in the config the plugin itself
 * receives.
 */
export interface DesktopSettingsDocument {
  /** Loopback Web port selected for the next application generation; zero requests a random port. */
  port: number
  /** Log verbosity threshold applied to the file logger. */
  logLevel: DesktopLogLevel
}

/** Volatile subset of {@link Config} the settings form edits and persists. */
export const DesktopSettingsSchema = z.object({
  port: z.number().step(1).min(0).max(65_535).default(0),
  logLevel: z.union(['debug', 'info', 'warn', 'error'] as const).default('info'),
})

/** Native window configuration. */
export interface Config {
  /** Product name shown in the tray, menus, and update notifications. */
  productName: string
  /** BrowserWindow title shown while the Web surface is connected. */
  windowTitle: string
  /**
   * Configured loopback Web port used to detect restart-applied settings changes.
   *
   * Volatile: the Web server binds it **before** this row mounts, so a live
   * change cannot take effect in the running generation — the host watches the
   * form for a new value and requests one orderly restart instead.
   */
  port: Volatile<number>
  /** Initial window width in CSS pixels. */
  width: number
  /** Initial window height in CSS pixels. */
  height: number
  /** Minimum window width in CSS pixels. */
  minWidth: number
  /** Minimum window height in CSS pixels. */
  minHeight: number
  /** File-logger verbosity threshold; volatile so the settings form can edit it. */
  logLevel: Volatile<DesktopLogLevel>
}

/**
 * Validated native window configuration.
 *
 * Deliberately **unannotated** (upstream's volatile-bearing plugins do the
 * same): `z<T>`'s first type parameter is the *input* shape, so annotating it
 * with {@link Config} — whose volatile fields hold references — contradicts the
 * plain defaults the schema declares. The inferred type is nameable from this
 * file because the workspace resolves exactly one schemastery copy (the version
 * the pinned upstream vendors); a second copy is what made TS2883 fire here.
 */
export const Config = z.object({
  productName: z.string().default('PicoAide Harness'),
  windowTitle: z.string().default('PicoAide Harness'),
  port: z.number().step(1).min(0).max(65_535).default(0).volatile(),
  width: z.number().step(1).min(800).default(1280),
  height: z.number().step(1).min(600).default(840),
  minWidth: z.number().step(1).min(640).default(900),
  minHeight: z.number().step(1).min(480).default(640),
  logLevel: z.union(['debug', 'info', 'warn', 'error'] as const).default('info').volatile(),
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
  // The settings document **is** this row's `config` (upstream 0.1.7): the
  // volatile `port`/`logLevel` fields above are the form, and persistence goes
  // through the profile patch. Nothing is registered here any more; reads below
  // go through `readSettingsNamespace`.
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
  /**
   * R4-RV3a：写面路由的 BrowserAuth 持有性证明依赖（由各写路由自己在方法/Origin
   * 检查之后强制执行；服务缺席 ⇒ fail-closed 503）。**只读** GET 面（更新徽章 /
   * 品牌资源）不消费它；循环通知跳转虽然是 GET，但它消费待跳转会话（P2-24）＝写，
   * 因此也接这一份依赖（FIX-36，见 `loop-notify-route.ts` 的模块头）。
   */
  const proofDeps: WriteProofDeps = {
    fence: (): ConnectionTrustFence | undefined => ctx.get('connection') as ConnectionTrustFence | undefined,
    label: 'dsh-plugin-desktop',
    warn: (message: string) => { ctx.logger?.warn?.(message) },
  }
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: DESKTOP_LOOP_NOTIFY_SESSION_PATH,
      handler: (req, res) => handleDesktopLoopNotifySessionRequest(
        req,
        res,
        rendererOrigin,
        // GET consumes the request (P2-24): return the pending jump and clear
        // it, so the next poll (or a renderer reload) cannot re-open a session
        // the user already visited. Consuming is a write, so it runs only after
        // the BrowserAuth proof gate (FIX-36).
        () => {
          const pending = loopNotifySession
          loopNotifySession = emptyDesktopLoopNotifySession()
          return pending
        },
        proofDeps,
      ),
    }),
    'dsh-plugin-desktop: loop-notify session jump route',
  )
  // 麦克风系统授权（2026-09-30）：渲染层拿不到"TCC 被拒"这件事（设备列表同样为空），
  // 只能由宿主给出；POST 会弹系统对话框 ⇒ 过写面证明。
  const voiceMicDeps: VoiceMicDeps = {
    platform: runtime.platform,
    // 宿主插件不直接 import Electron（无头冒烟里根本没有 electron 模块）：
    // TCC 那两步由 `desktopRuntime` 适配器提供，缺席就是"这台平台没有这一步"。
    ...(runtime.microphone === undefined
      ? {}
      : {
          getMediaAccessStatus: () => runtime.microphone!.permission(),
          askForMediaAccess: () => runtime.microphone!.request(),
        }),
  }
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: VOICE_MIC_STATUS_PATH,
      handler: (req, res) => handleVoiceMicStatusRequest(req, res, voiceMicDeps),
    }),
    'dsh-plugin-desktop: voice mic status route',
  )
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: VOICE_MIC_REQUEST_PATH,
      handler: (req, res) => handleVoiceMicRequest(req, res, { ...voiceMicDeps, ...proofDeps }),
    }),
    'dsh-plugin-desktop: voice mic permission request route',
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
        proofDeps,
      ),
    }),
    'dsh-plugin-desktop: update badge check route',
  )
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: DESKTOP_UPDATE_INSTALL_PATH,
      handler: (req, res) => handleDesktopUpdateInstallRequest(
        req,
        res,
        rendererOrigin,
        () => { runtime.updates?.installNow?.() },
        proofDeps,
      ),
    }),
    'dsh-plugin-desktop: update install route',
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
        proofDeps,
      ),
    }),
    'dsh-plugin-desktop: renderer boot report route',
  )
  // 标题栏双击（macOS）：自绘拖拽条拿不到原生双击行为（electron#16385），
  // renderer 检测到拖拽区上的 dblclick 后 POST 这里，宿主按系统偏好缩放/最小化。
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: DESKTOP_TITLEBAR_DOUBLE_CLICK_PATH,
      handler: (req, res) => handleDesktopTitleBarDoubleClickRequest(
        req,
        res,
        rendererOrigin,
        () => { runtime.performTitleBarDoubleClick() },
        proofDeps,
      ),
    }),
    'dsh-plugin-desktop: titlebar double-click route',
  )
  // 品牌静态资源（favicon / manifest）覆盖上游 fallback 席位里那份厂商图形与厂商名。
  // 只在真的解析到图形时注册图标路由：宁可继续服务上游文件，也不裂图。
  {
    const brandAssets = buildBrandWebAssets({
      profile: readDesktopChannelProfile(),
      brandWebDir: fileURLToPath(new URL('../build/web-brand/', import.meta.url)),
      // 官方兜底必须是**随包**的那一份（`brand-prepare.mjs` 落的官方几何）。
      // 旧值是 `../../../brands/official/logo.svg` —— 仓库品牌目录不进包，
      // 在 src/lib/app.asar 三套布局下都不存在（2026-09-12 审计 P1-12），
      // 于是"渠道 logo 不可信时回落官方"这条链是死的。build/ 是打包态唯一
      // 可靠的真源，与上面的 brandWebDir 同源。
      officialLogoPath: fileURLToPath(new URL('../build/web-brand/official.svg', import.meta.url)),
    })
    const favicon = brandAssets.favicon
    if (favicon !== undefined) {
      ctx.effect(
        () => ctx.webServer.register({
          kind: 'exact',
          path: BRAND_FAVICON_PATH,
          handler: (req, res) => handleBrandAssetRequest(req, res, rendererOrigin, favicon),
        }),
        'dsh-plugin-desktop: brand favicon route',
      )
    }
    ctx.effect(
      () => ctx.webServer.register({
        kind: 'exact',
        path: BRAND_MANIFEST_PATH,
        handler: (req, res) => handleBrandAssetRequest(req, res, rendererOrigin, brandAssets.manifest),
      }),
      'dsh-plugin-desktop: brand manifest route',
    )
  }
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
          proofDeps,
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
    // Restart-applied setting: the Web server already bound the port this
    // generation was composed with, so a form edit that changes it can only take
    // effect after one orderly relaunch. Revisions of *other* namespaces
    // (`ui-theme`, `locale`, …) arrive on the same event and are ignored.
    const onDocumentUpdated = (namespace: string): void => {
      if (namespace !== DESKTOP_SETTINGS_ENTRY_ID) return
      const next = readSettingsNamespace<DesktopSettingsDocument>(ctx.settings, DESKTOP_SETTINGS_ENTRY_ID)
      if (next?.port === config.port.get()) {
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
    }
    // Registered inside this effect: Cordis unwinds the listener with the effect,
    // so no manual `off` is needed (and `Context` has none).
    ctx.on('settings/document-updated', onDocumentUpdated)
    return () => {
      if (pending !== undefined) clearImmediate(pending)
    }
  }, 'dsh-plugin-desktop: restart after startup setting change')
  ctx.on('settings/document-updated', (namespace) => {
    if (namespace !== UI_THEME_SETTINGS_NAMESPACE) return
    const theme = readSettingsNamespace<ThemeSettings>(ctx.settings, UI_THEME_SETTINGS_NAMESPACE)
    if (theme !== undefined) runtime.setThemeSource(theme.preference)
  })
  ctx.on('settings/document-updated', (namespace) => {
    if (namespace !== UI_LOCALE_SETTINGS_NAMESPACE) return
    const next = readSettingsNamespace<LocaleSettings>(ctx.settings, UI_LOCALE_SETTINGS_NAMESPACE)
    if (next === undefined) return
    const before = runtime.locale
    runtime.setLocalePreference(desktopLocaleFromPreference(next.preference))
    // Tell Host surfaces that render per request but are already open (the
    // embedded browser's chrome) to re-serve in the new language. Only on a real
    // change: a settings write that keeps the same preference must not reload
    // anything.
    if (runtime.locale !== before) ctx.emit('pico/locale-changed', runtime.locale)
  })
  // picoaide:// deep links (auth callback): forward to Host consumers.
  // The enterprise plugin listens for 'pico/deep-link' and completes the
  // OIDC/OpenID login by storing the token from the link.
  runtime.setDeepLinkHandler(url => {
    ctx.emit('pico/deep-link', url)
  })
  ctx.effect(
    () => runtime.schedule({
      // Only the durable window geometry travels into the native spec: the
      // volatile `port`/`logLevel` fields are settings-form state and must not
      // leak a `Volatile` wrapper into the shell spec.
      width: config.width,
      height: config.height,
      minWidth: config.minWidth,
      minHeight: config.minHeight,
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
        const locale = readSettingsNamespace<LocaleSettings>(ctx.settings, UI_LOCALE_SETTINGS_NAMESPACE)
        return desktopLocaleFromPreference(locale?.preference)
      },
      readThemeSource: () => {
        const theme = readSettingsNamespace<ThemeSettings>(ctx.settings, UI_THEME_SETTINGS_NAMESPACE)
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

// 冒烟脚本（`scripts/verify-profile-boot.mjs` / `scripts/verify-session-restart.mjs`）读设置
// 走的就是这里导出的**同一个**读取器 —— 0.1.7 起 settings 的命名空间是 **profile 条目 id**
// 且读取入口是 `describe()`（`ctx.settings.get(ns)` 已不存在）。把实现重写一遍会让
// "门禁读的值"与"插件读的值"分叉，所以直接复用。
export { readSettingsNamespace, type SettingsFormDescriptor, type SettingsFormsReader } from './settings-forms.ts'
