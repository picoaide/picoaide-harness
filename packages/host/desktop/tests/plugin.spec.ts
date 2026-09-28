import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { LocaleId } from '@deepseek-ai/dsh-client-locale'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { ThemePreference } from '@deepseek-ai/dsh-client-ui-theme'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  apply,
  Config,
  DESKTOP_SETTINGS_ENTRY_ID,
  DESKTOP_SETTINGS_NAMESPACE,
  desktopRendererUrl,
  DesktopSettingsSchema,
  inject,
  type Config as DesktopConfig,
  type DesktopSettingsDocument,
  type DesktopShellConfigDocument,
} from '../src/index.ts'
import { resolvedDesktopConfig } from './helpers/desktop-config.ts'
import { DESKTOP_DIRECTORY_PICKER_PATH } from '../src/directory-picker-contract.ts'
import { DESKTOP_LOOP_NOTIFY_SESSION_PATH } from '../src/loop-notify-contract.ts'
import type { DesktopRuntime, DesktopShellSpec } from '../src/runtime.ts'
import { RENDERER_BOOT_REPORT_PATH, type RendererBootReport } from '../src/renderer-boot-contract.ts'

const config: DesktopConfig = resolvedDesktopConfig()

/** R4-RV3a：写路由要一份 BrowserAuth cookie；合法 renderer 持有它。 */
const PROOF_COOKIE = 'dsh-auth-127.0.0.1:43120=v1.signature'

afterEach(() => { vi.useRealTimers() })

interface PluginHarness {
  ctx: Context
  runtime: DesktopRuntime
  shell(): DesktopShellSpec | undefined
  update: ReturnType<typeof vi.fn<(patch: object) => Promise<void>>>
  restart: ReturnType<typeof vi.fn<() => Promise<void>>>
  setLocalePreference: ReturnType<typeof vi.fn<(locale: LocaleId | undefined) => void>>
  emit: ReturnType<typeof vi.fn<(event: string, payload?: unknown) => void>>
  setThemeSource: ReturnType<typeof vi.fn<(source: ThemePreference) => void>>
  rendererBoot: ReturnType<typeof vi.fn<(report: RendererBootReport) => void>>
  pickDirectory: ReturnType<typeof vi.fn<() => Promise<string | null>>>
  route(path: string): WebRoute | undefined
  /** Emit one `settings/document-updated` revision for a profile entry id. */
  publish(namespace: string): Promise<void>
  /** Publish a desktop-shell revision whose form now reports `port`. */
  publishDesktopPort(port: number): Promise<void>
  notifyLocale(preference: LocaleId | undefined): void
  notifyTheme(preference: ThemePreference): void
  deepLinkHandler(): ((url: string) => void) | undefined
  sessionOpenHandler(): ((sessionId: string) => void) | undefined
}

function createHarness(platform: DesktopRuntime['platform'] = 'darwin'): PluginHarness {
  let shell: DesktopShellSpec | undefined
  const update = vi.fn(async (_patch: object) => {})
  const restart = vi.fn(async () => {})
  const setLocalePreference = vi.fn<(locale: LocaleId | undefined) => void>()
  const emit = vi.fn<(event: string, payload?: unknown) => void>()
  const setThemeSource = vi.fn<(source: ThemePreference) => void>()
  const rendererBoot = vi.fn<(report: RendererBootReport) => void>()
  const pickDirectory = vi.fn(async () => null)
  const routes = new Map<string, WebRoute>()
  // R4-RV3a：写面的 BrowserAuth 持有性证明替身（与上游 requestRejection 同判据）。
  const fence = {
    requestRejection: (request: { headers: Record<string, unknown> }): 401 | undefined =>
      request.headers['cookie'] === PROOF_COOKIE ? undefined : 401,
  }
  const settingsUpdated = new Set<(namespace: unknown) => void>()
  let localePreference: LocaleId | undefined
  let themePreference: ThemePreference = 'system'
  // Live value the desktop-shell settings form reports; the restart watcher
  // compares it against the port this generation was composed with.
  let desktopFormPort = config.port.get()
  let deepLinkHandler: ((url: string) => void) | undefined = undefined
  let sessionOpenHandler: ((sessionId: string) => void) | undefined = undefined
  const runtime: DesktopRuntime = {
    platform,
    locale: 'en',
    // native 文案(托盘/通知)的产品名:渠道构建下由 profile 组装成渠道名。
    productName: 'PicoAide Harness',
    updates: {
      isPackaged: false,
      canDownload: platform === 'darwin' || platform === 'win32',
      currentVersion: '2.0.0',
      userDataPath: '/tmp/dsh-desktop-user-data',
      statePath: '/tmp/dsh-desktop-update-state.json',
      request: async () => new Response(null, { status: 304 }),
      showManualCheckResult: async () => {},
      downloadUpdate: async () => '/tmp/installer',
      announceUpdateReady: async () => {},
      installUpdate: async () => {},
      notify: () => {},
    },
    schedule: (spec) => {
      shell = spec
      return async () => {}
    },
    mountScheduled: async () => {},
    show: () => {},
    performTitleBarDoubleClick: () => {},
    registerTrayItem: () => ({ refresh: () => {}, dispose: () => {} }),
    exportDiagnostics: async () => {},
    pickDirectory,
    reportRendererBoot: rendererBoot,
    setLocalePreference,
    setThemeSource,
    requestRestart: restart,
    prepareToQuit: () => {},
    setDeepLinkHandler: (handler) => {
      deepLinkHandler = handler
    },
    setSessionOpenRequestHandler: (handler) => {
      sessionOpenHandler = handler
    },
  }
  // Upstream 0.1.7: the settings service is a **form projection over profile
  // entries** — the namespace is the entry id and the live value is read through
  // `describe()`. Live changes arrive as `settings/document-updated`.
  const settings = {
    describe: vi.fn(() => [
      { ns: 'desktop-shell', value: { port: desktopFormPort, logLevel: 'info' }, revision: 0 },
      { ns: 'ui-theme', value: { preference: themePreference }, revision: 0 },
      { ns: 'locale', value: { preference: localePreference }, revision: 0 },
    ]),
    update,
    replace: vi.fn(async () => {}),
  }
  const ctx = {
    desktopRuntime: runtime,
    webServer: {
      host: '127.0.0.1',
      port: 43120,
      register: vi.fn((route: WebRoute) => {
        routes.set(route.path, route)
        return () => { if (routes.get(route.path) === route) routes.delete(route.path) }
      }),
    },
    settings,
    connection: { authenticatedUrl: (url: string) => url },
    logger: { warn: vi.fn(), error: vi.fn() },
    get: vi.fn((key: unknown) => {
      if (String(key) === 'desktopRuntime') return runtime
      if (String(key) === 'connection') return fence
      return () => {}
    }),
    effect: vi.fn((register: () => unknown) => register()),
    on: vi.fn((event: string, listener: (namespace: unknown) => void) => {
      if (event === 'settings/document-updated') settingsUpdated.add(listener)
      return () => { settingsUpdated.delete(listener) }
    }),
    emit,
  } as unknown as Context
  // 真实 runtime 的 setLocalePreference 会改 `runtime.locale`（同值早退）；
  // `pico/locale-changed` 的发射条件依赖这个语义。
  // `DesktopRuntime.locale` is readonly in the interface; the mock mutates it.
  setLocalePreference.mockImplementation((locale) => { (runtime as { locale: string }).locale = locale ?? 'en' })
  return {
    ctx,
    runtime,
    emit,
    shell: () => shell,
    update,
    restart,
    setLocalePreference,
    setThemeSource,
    rendererBoot,
    pickDirectory,
    route: path => routes.get(path),
    publish: async (namespace) => {
      for (const listener of settingsUpdated) listener(namespace)
    },
    publishDesktopPort: async (port) => {
      desktopFormPort = port
      for (const listener of settingsUpdated) listener('desktop-shell' as SettingsNamespace)
    },
    notifyLocale: (preference) => {
      localePreference = preference
      for (const listener of settingsUpdated) listener('locale' as SettingsNamespace)
    },
    notifyTheme: (preference) => {
      themePreference = preference
      for (const listener of settingsUpdated) listener('ui-theme' as SettingsNamespace)
    },
    deepLinkHandler: () => deepLinkHandler,
    sessionOpenHandler: () => sessionOpenHandler,
  }
}

describe('desktop Host plugin', () => {
  it('validates schemas without a presentation mode knob', () => {
    const validated = Config({} as DesktopShellConfigDocument)
    expect({
      ...validated,
      // Volatile fields are references in the resolved config; the document
      // values (what the settings form projects) are what the defaults test
      // compares.
      port: validated.port.get(),
      logLevel: validated.logLevel.get(),
    }).toEqual({
      productName: 'PicoAide Harness',
      windowTitle: 'PicoAide Harness',
      port: 0,
      width: 1280,
      height: 840,
      minWidth: 900,
      minHeight: 640,
      logLevel: 'info',
    })
    expect(DesktopSettingsSchema({} as DesktopSettingsDocument)).toEqual({ port: 0, logLevel: 'info' })
    expect(() => DesktopSettingsSchema({ port: -1 } as DesktopSettingsDocument)).toThrow()
    expect(() => DesktopSettingsSchema({ port: 1.5 } as DesktopSettingsDocument)).toThrow()
    expect(() => DesktopSettingsSchema({ port: 65_536 } as DesktopSettingsDocument)).toThrow()
    expect(String(DESKTOP_SETTINGS_NAMESPACE)).toBe('dsh-desktop')
    // 0.1.7: the live namespace is the profile entry id this plugin's row owns.
    expect(String(DESKTOP_SETTINGS_ENTRY_ID)).toBe('desktop-shell')
  })

  it('prints a launcher reminder and registers nothing without desktopRuntime', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const registerRoute = vi.fn()
    const ctx = {
      webServer: { host: '127.0.0.1', port: 43120, register: registerRoute },
      connection: { authenticatedUrl: (url: string) => url },
      settings: {
        describe: vi.fn(() => []),
        update: vi.fn(async () => {}),
      },
      logger: { warn: vi.fn(), error: vi.fn() },
      get: vi.fn(() => undefined),
      effect: vi.fn((register: () => unknown) => register()),
      on: vi.fn(() => () => {}),
    } as unknown as Context

    apply(ctx, config)

    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('desktop launcher'))
    expect(registerRoute).not.toHaveBeenCalled()
    // 0.1.7: nothing is registered with the settings service any more — the
    // desktop's own form is this plugin's profile entry.
    expect(vi.mocked(ctx.settings.describe)).not.toHaveBeenCalled()
    stderr.mockRestore()
  })

  it('builds the loopback root with validated renderer mode and platform markers', () => {
    const url = new URL(desktopRendererUrl(43120, 'advanced', 'darwin'))
    expect(url.origin).toBe('http://127.0.0.1:43120')
    expect(url.pathname).toBe('/')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      'dsh-desktop-mode': 'advanced',
      'dsh-desktop-platform': 'darwin',
    })
  })

  it('projects the active Web port without re-entering Loader settlement', async () => {
    const harness = createHarness()
    const loaderAwait = vi.fn(() => new Promise<void>(() => {}))
    Object.assign(harness.ctx, { loader: { await: loaderAwait } })

    apply(harness.ctx, config)

    // `settings` stays injected: the shell reads the theme/locale/desktop forms
    // through it. It must NOT await the loader during activation (the settings
    // service's own `describe()` waits for settlement; a Host row that awaited
    // it here would deadlock against its own activation).
    expect(inject).toContain('settings')
    expect(inject).not.toContain('loader')
    expect(loaderAwait).not.toHaveBeenCalled()
    expect(harness.shell()).toEqual(expect.objectContaining({
      url: 'http://127.0.0.1:43120/?dsh-desktop-mode=advanced&dsh-desktop-platform=darwin',
      productName: 'PicoAide Harness',
      windowTitle: 'PicoAide Harness',
      iconPath: expect.stringMatching(/\/build\/app-icon-mac\.png$/u),
      trayIcons: {
        templatePath: expect.stringMatching(/\/build\/tray-iconTemplate\.png$/u),
        bluePath: expect.stringMatching(/\/build\/tray-icon-blue\.png$/u),
      },
      readThemeSource: expect.any(Function),
    }))
    expect(harness.shell()?.iconPath.endsWith(join('build', 'app-icon-mac.png'))).toBe(true)
    expect(harness.shell()?.trayIcons.templatePath.endsWith(join('build', 'tray-iconTemplate.png'))).toBe(true)
    expect(harness.shell()?.trayIcons.bluePath.endsWith(join('build', 'tray-icon-blue.png'))).toBe(true)
    expect(harness.shell()?.readThemeSource()).toBe('system')
    harness.notifyTheme('dark')
    expect(harness.setThemeSource).toHaveBeenCalledWith('dark')
  })

  it('forwards same-origin renderer boot reports through the Host route', async () => {
    const harness = createHarness()
    apply(harness.ctx, config)
    const route = harness.route(RENDERER_BOOT_REPORT_PATH)
    expect(route).toEqual(expect.objectContaining({
      kind: 'exact',
      path: RENDERER_BOOT_REPORT_PATH,
    }))
    const report = { status: 'failed', plugins: ['dsh-vision-router'], error: 'slot conflict' } as const
    const req = {
      method: 'POST',
      headers: {
        origin: 'http://127.0.0.1:43120',
        'content-type': 'application/json',
        cookie: PROOF_COOKIE,
      },
      async * [Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(report)) },
    } as unknown as IncomingMessage
    const res = { statusCode: 200, end: vi.fn() } as unknown as ServerResponse

    await route?.handler(req, res)

    expect(harness.rendererBoot).toHaveBeenCalledWith(report)
    expect(res.statusCode).toBe(204)
  })

  it('serves the Windows native picker through a same-origin desktop route', async () => {
    const harness = createHarness('win32')
    harness.pickDirectory.mockResolvedValue('C:\\Work')
    apply(harness.ctx, config)
    const route = harness.route(DESKTOP_DIRECTORY_PICKER_PATH)
    expect(route).toEqual(expect.objectContaining({
      kind: 'exact',
      path: DESKTOP_DIRECTORY_PICKER_PATH,
    }))
    const req = {
      method: 'POST',
      headers: { origin: 'http://127.0.0.1:43120', cookie: PROOF_COOKIE },
    } as unknown as IncomingMessage
    let body = ''
    const res = {
      statusCode: 200,
      setHeader: vi.fn(),
      end: vi.fn((value?: string) => { body = value ?? '' }),
    } as unknown as ServerResponse

    await route?.handler(req, res)

    expect(harness.pickDirectory).toHaveBeenCalledOnce()
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(body)).toEqual({ path: 'C:\\Work' })
  })

  it.each(['win32', 'linux'] as const)(
    'keeps the full-size application icon on %s',
    (platform) => {
      const harness = createHarness(platform)

      apply(harness.ctx, config)

      expect(harness.shell()?.iconPath.endsWith(join('build', 'app-icon.png'))).toBe(true)
    },
  )

  it('requests one orderly restart after the configured Web port changes', async () => {
    vi.useFakeTimers()
    const harness = createHarness()
    apply(harness.ctx, config)

    // A revision that keeps the composed port must not restart anything, and a
    // revision of an unrelated namespace must not either.
    await harness.publishDesktopPort(0)
    await harness.publish('ui-theme')
    await vi.runAllTimersAsync()
    expect(harness.restart).not.toHaveBeenCalled()

    harness.restart.mockImplementation(() => new Promise<void>(() => {}))
    await harness.publishDesktopPort(43_189)
    await vi.runAllTimersAsync()
    expect(harness.restart).toHaveBeenCalledOnce()
  })

  it('projects live built-in theme changes into the advanced native material', () => {
    const harness = createHarness()
    apply(harness.ctx, config)

    expect(harness.shell()?.readThemeSource()).toBe('system')
    harness.notifyTheme('dark')
    expect(harness.setThemeSource).toHaveBeenCalledWith('dark')
  })

  it('projects the Host-backed locale preference into the native tray', () => {
    const harness = createHarness('win32')
    apply(harness.ctx, config)

    expect(harness.shell()?.readLocalePreference()).toBeUndefined()
    expect(harness.setLocalePreference).not.toHaveBeenCalled()

    harness.notifyLocale('zh')
    expect(harness.shell()?.readLocalePreference()).toBe('zh')
    expect(harness.setLocalePreference).toHaveBeenCalledWith('zh')

    harness.notifyLocale(undefined)
    expect(harness.setLocalePreference).toHaveBeenLastCalledWith(undefined)
  })

  it('announces a REAL language change so open host-rendered pages can re-serve', () => {
    // 2026-09-16 R9 审计：浏览器 chrome 两页是按请求渲染的，已经开着的窗口不会
    // 再请求一次 —— 宿主必须在语言真变化时发信号（同值写入不得触发重载）。
    const harness = createHarness()
    apply(harness.ctx, config)
    harness.emit.mockClear()

    harness.notifyLocale('zh')
    expect(harness.emit).toHaveBeenCalledWith('pico/locale-changed', 'zh')

    harness.emit.mockClear()
    harness.notifyLocale('zh')
    expect(harness.emit).not.toHaveBeenCalled()

    harness.notifyLocale('en')
    expect(harness.emit).toHaveBeenCalledWith('pico/locale-changed', 'en')
  })

  it('requires the desktop Web carrier to remain loopback-only', () => {
    const harness = createHarness()
    Object.assign(harness.ctx.webServer, { host: '0.0.0.0' })

    expect(() => apply(harness.ctx, config)).toThrow('requires a loopback Web server')
  })

  it('forwards notification clicks to the renderer session route', async () => {
    const harness = createHarness()
    apply(harness.ctx, config)

    const handler = harness.sessionOpenHandler()
    expect(handler).toBeDefined()
    handler?.('session-abc')

    const route = harness.route(DESKTOP_LOOP_NOTIFY_SESSION_PATH)
    expect(route).toEqual(expect.objectContaining({
      kind: 'exact',
      path: DESKTOP_LOOP_NOTIFY_SESSION_PATH,
    }))
    const req = {
      method: 'GET',
      // FIX-36：消费是写，走真实注册的处理器也要带 BrowserAuth 证明；
      // 渲染层的同源轮询由 Chromium 自动带上这个 cookie。
      headers: { origin: 'http://127.0.0.1:43120', cookie: PROOF_COOKIE },
    } as unknown as IncomingMessage
    let body = ''
    const res = {
      statusCode: 200,
      setHeader: vi.fn(),
      end: vi.fn((value?: string) => { body = value ?? '' }),
    } as unknown as ServerResponse
    await route?.handler(req, res)

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(body)).toEqual({
      sessionId: 'session-abc',
      requestedAt: expect.any(Number),
    })

    // P2-24: the GET consumes the request — the next poll must not re-open it.
    let secondBody = ''
    const secondRes = {
      statusCode: 200,
      setHeader: vi.fn(),
      end: vi.fn((value?: string) => { secondBody = value ?? '' }),
    } as unknown as ServerResponse
    await route?.handler(req, secondRes)
    expect(secondRes.statusCode).toBe(200)
    expect(JSON.parse(secondBody)).toEqual({ sessionId: null, requestedAt: 0 })
  })

  it('rejects cross-origin and proof-less session-open route requests', async () => {
    const harness = createHarness()
    apply(harness.ctx, config)
    const route = harness.route(DESKTOP_LOOP_NOTIFY_SESSION_PATH)
    const req = {
      method: 'GET',
      headers: { origin: 'https://evil.example' },
    } as unknown as IncomingMessage
    let body = ''
    const res = {
      statusCode: 200,
      setHeader: vi.fn(),
      end: vi.fn((value?: string) => { body = value ?? '' }),
    } as unknown as ServerResponse
    await route?.handler(req, res)
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(body)).toEqual({ error: 'forbidden' })

    // FIX-36：伪造同源头（Origin 就是渲染层 origin）但没有 BrowserAuth cookie
    // ⇒ 消费被拒，且 404/403 的响应里没有待跳转会话。
    const forged = {
      method: 'GET',
      headers: { origin: 'http://127.0.0.1:43120' },
    } as unknown as IncomingMessage
    let forgedBody = ''
    const forgedRes = {
      statusCode: 200,
      setHeader: vi.fn(),
      end: vi.fn((value?: string) => { forgedBody = value ?? '' }),
    } as unknown as ServerResponse
    await route?.handler(forged, forgedRes)
    expect(forgedRes.statusCode).toBe(403)
    expect(JSON.parse(forgedBody)).toEqual(expect.objectContaining({ error: 'browser session proof required' }))
  })
})
