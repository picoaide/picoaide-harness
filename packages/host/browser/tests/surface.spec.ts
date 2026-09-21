/**
 * Surface seam 的行为判据（§16.1 冻结三条：配额只算浏览器标签 / 默认寻址只指向
 * 浏览器当前标签 / 应用窗口必须显式 app_id）。
 *
 * 变异验证：把 `resolve()` 的默认分支改成"返回任意一个 surface" ⇒ 默认寻址用例必红；
 * 把 `browserTabCount` 改成数全部 surface ⇒ 配额用例必红。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  MAX_BROWSER_TABS,
  appSurfaceForUrl,
  createSurfaceRegistry,
  surfaceLabel,
} from '../src/surface.ts'

/** 建一个"当前标签"可变的注册表。 */
function harness(active?: number) {
  let current = active
  const warn = vi.fn()
  const registry = createSurfaceRegistry({ activeBrowserTab: () => current, warn })
  return { registry, warn, setActive: (id: number | undefined) => { current = id } }
}

describe('surface registry (§16.1)', () => {
  it('keeps application windows out of the browser tab quota (maxTabs 只算浏览器标签)', () => {
    const { registry } = harness()
    for (let id = 1; id <= MAX_BROWSER_TABS; id += 1) registry.registerBrowserTab(id)
    expect(registry.browserTabCount()).toBe(MAX_BROWSER_TABS)
    expect(registry.canOpenBrowserTab()).toBe(false)
    // 应用窗口不进配额：开 10 个应用窗口，浏览器配额仍然是满的、也没被撑爆。
    for (let i = 1; i <= 10; i += 1) registry.registerApp({ id: 10_000 + i, appId: `app-${String(i)}`, appScheme: 'harness-app' })
    expect(registry.browserTabCount()).toBe(MAX_BROWSER_TABS)
    expect(registry.appSurfaces()).toHaveLength(10)
    expect(registry.browserTabs()).toHaveLength(MAX_BROWSER_TABS)
  })

  it('keeps application windows out of the browser ledger listing', () => {
    const { registry } = harness()
    registry.registerBrowserTab(1)
    registry.registerApp({ id: 10_001, appId: 'my-notes', appScheme: 'harness-app' })
    // 台账/列表只认浏览器标签；应用窗口在 appSurfaces() 里（list_tabs 的 kind='app' 行）。
    expect(registry.browserTabs().map(surface => surface.id)).toEqual([1])
    expect(registry.appSurfaces().map(surface => surface.appId)).toEqual(['my-notes'])
  })

  it('defaults to the active browser tab and never to an application window', () => {
    const { registry, setActive } = harness(7)
    registry.registerBrowserTab(7)
    registry.registerApp({ id: 10_001, appId: 'my-notes', appScheme: 'harness-app' })
    expect(registry.resolve({})).toEqual({ ok: true, surface: expect.objectContaining({ kind: 'browser-tab', id: 7 }) })
    // 没有当前标签 ⇒ 明确失败，**不**回落到应用窗口（那是危险默认）。
    setActive(undefined)
    expect(registry.resolve({})).toEqual({ ok: false, reason: 'no-browser-tab' })
    // 应用窗口只能显式寻址。
    expect(registry.resolve({ appId: 'my-notes' })).toEqual({
      ok: true,
      surface: expect.objectContaining({ kind: 'app', appId: 'my-notes', appScheme: 'harness-app' }),
    })
    expect(registry.resolve({ appId: 'nope' })).toEqual({ ok: false, reason: 'unknown-app' })
  })

  it('refuses ambiguous addressing instead of picking one (tab + app_id)', () => {
    const { registry, warn } = harness(1)
    registry.registerBrowserTab(1)
    registry.registerApp({ id: 10_001, appId: 'my-notes', appScheme: 'harness-app' })
    expect(registry.resolve({ tab: 1, appId: 'my-notes' })).toEqual({ ok: false, reason: 'app-not-addressable-by-tab' })
    expect(warn).toHaveBeenCalled()
  })

  it('rejects an unknown browser tab id and keeps app surfaces out of the tab namespace', () => {
    const { registry } = harness()
    registry.registerApp({ id: 10_001, appId: 'my-notes', appScheme: 'harness-app' })
    expect(registry.resolve({ tab: 10_001 })).toEqual({ ok: false, reason: 'unknown-browser-tab' })
    expect(registry.resolve({ tab: 99 })).toEqual({ ok: false, reason: 'unknown-browser-tab' })
  })

  it('re-registering an app replaces its window instead of stacking (单应用单窗口 §7.2)', () => {
    const { registry } = harness()
    const first = registry.registerApp({ id: 10_001, appId: 'my-notes', appScheme: 'harness-app' })
    const second = registry.registerApp({ id: 10_002, appId: 'my-notes', appScheme: 'harness-app' })
    expect(registry.appSurfaces()).toHaveLength(1)
    expect(registry.get(first.id)).toBeUndefined()
    expect(registry.appSurface('my-notes')).toEqual(second)
  })

  it('never lets an app surface id collide with a browser tab id', () => {
    const { registry } = harness()
    registry.registerBrowserTab(10_001)
    const surface = registry.registerApp({ id: 10_001, appId: 'my-notes', appScheme: 'harness-app' })
    expect(surface.id).not.toBe(10_001)
    expect(registry.get(10_001)?.kind).toBe('browser-tab')
  })

  it('clears everything on account switch', () => {
    const { registry } = harness()
    registry.registerBrowserTab(1)
    registry.registerApp({ id: 10_001, appId: 'my-notes', appScheme: 'harness-app' })
    registry.clear()
    expect(registry.browserTabCount()).toBe(0)
    expect(registry.appSurfaces()).toHaveLength(0)
  })

  it('unregistering an app surface drops its app_id mapping too', () => {
    const { registry } = harness()
    const surface = registry.registerApp({ id: 10_001, appId: 'my-notes', appScheme: 'harness-app' })
    registry.unregister(surface.id)
    expect(registry.appSurface('my-notes')).toBeUndefined()
  })
})

describe('app scheme lookup by URL (浏览器面拒绝时的定位，§22.2 R4)', () => {
  it('finds the surface whose channel-injected scheme the URL uses', () => {
    const { registry } = harness()
    const surface = registry.registerApp({ id: 10_001, appId: 'my-notes', appScheme: 'example-harness-app' })
    expect(appSurfaceForUrl('example-harness-app://my-notes/', registry)).toEqual(surface)
    expect(appSurfaceForUrl('https://evil.example/', registry)).toBeUndefined()
    expect(appSurfaceForUrl('picoaide-app://my-notes/', registry)).toBeUndefined()
    expect(appSurfaceForUrl('not a url', registry)).toBeUndefined()
  })

  it('labels surfaces without echoing URLs', () => {
    expect(surfaceLabel({ kind: 'browser-tab', id: 3 })).toBe('tab:3')
    expect(surfaceLabel({ kind: 'app', id: 10_001, appId: 'my-notes', appScheme: 'harness-app' })).toBe('app:my-notes')
  })
})
