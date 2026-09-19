/**
 * Browser surface seam（§16.1「surface 抽象」冻结）—— 浏览器插件对外的**唯一**
 * 目标注册面，`@picoaide/dsh-browser/surface` 子路径导出。
 *
 * 背景（W-C 裁决）：应用窗口是**独立 `BrowserWindow`**，但它要和内置浏览器**共享
 * 同一套工具实现与胶囊/遮罩** —— 否则 `browser_*` 工具面会长出第二份实现，两份
 * 实现必然漂移。做法是把"工具作用在什么上"抽成 surface：
 *
 * ```
 * { kind: 'browser-tab' | 'app', id, webContents }   // §16.1 逐字
 * ```
 *
 * 三条**冻结语义**（写错就是缺陷）：
 *  1. **配额只算浏览器标签**：应用窗口不占 `maxTabs`（16），也不进浏览器台账
 *     （`browser_list_tabs` 的浏览器分区、活动面板、`ledger`）；
 *  2. **默认寻址只指向浏览器当前标签**：应用窗口必须**显式**给 `app_id` —— 没有
 *     目标时"顺手操作应用窗口"是最危险的行为（用户可能正拿着控制权）；
 *  3. **按 surface 记控制权**：每个应用窗口独立"人/AI"归属，不再依赖池级
 *     `pool.controlled`。
 *
 * 本模块是**纯注册表 + 寻址规则**（不 import electron）：Electron 侧只把
 * `webContents` 当不透明句柄传进来。
 *
 * @module @picoaide/dsh-browser/surface
 */

/** Surface 种类（§16.1 冻结：只有这两种）。 */
export type SurfaceKind = 'browser-tab' | 'app'

/** 浏览器标签配额（§16.1：应用窗口**不**吃这个配额）。 */
export const MAX_BROWSER_TABS = 16

/** Cordis 服务名：浏览器插件 `provide` 出去的 surface 注册表（`windows.ts` 的 inject）。 */
export const BROWSER_SURFACE_SERVICE = 'browserSurface'

/** 一个 surface。`webContents` 在本模块里是不透明句柄（不 import electron）。 */
export interface BrowserSurface {
  readonly kind: SurfaceKind
  /** 唯一 id（浏览器标签用 tab id；应用窗口用宿主分配的 surface id）。 */
  readonly id: number
  /** 原生 `webContents`（不透明；由驱动方解释）。 */
  readonly webContents?: unknown
  /** 应用 id（`kind === 'app'` 必填）。 */
  readonly appId?: string
  /** 应用源 scheme（`kind === 'app'` 必填；渠道参数化，不写死官方值）。 */
  readonly appScheme?: string
  /** 会话/分区标识（切账号时按它清理；可选）。 */
  readonly scope?: string
}

/** 寻址输入（工具参数的语义面）。 */
export interface SurfaceAddress {
  /** 浏览器标签 id（模型给的 `tab`）。 */
  readonly tab?: number | undefined
  /** 应用 id（模型给的 `app_id`；**唯一**能指向应用窗口的方式）。 */
  readonly appId?: string | undefined
}

/** 寻址结论。 */
export type SurfaceResolution =
  | { ok: true, surface: BrowserSurface }
  | { ok: false, reason: 'no-browser-tab' | 'unknown-browser-tab' | 'unknown-app' | 'app-not-addressable-by-tab' }

/** 注册表的依赖。 */
export interface SurfaceRegistryOptions {
  /** 浏览器当前标签（默认寻址的唯一来源）。 */
  activeBrowserTab: () => number | undefined
  /** 诊断出口（缺省丢弃）。 */
  warn?: ((message: string) => void) | undefined
}

/** Surface 注册表。 */
export interface SurfaceRegistry {
  /** 注册/更新一个浏览器标签（配额只算它们）。 */
  registerBrowserTab(id: number, webContents?: unknown): void
  /** 注销（关标签）。 */
  unregister(id: number): void
  /** 注册一个应用窗口 surface。 */
  registerApp(input: { id: number, appId: string, appScheme: string, webContents?: unknown, scope?: string }): BrowserSurface
  /** 按 id 取。 */
  get(id: number): BrowserSurface | undefined
  /** 按 app_id 取应用 surface。 */
  appSurface(appId: string): BrowserSurface | undefined
  /** 浏览器标签（台账/列表/配额只认它们）。 */
  browserTabs(): readonly BrowserSurface[]
  /** 应用 surface（不在浏览器台账里）。 */
  appSurfaces(): readonly BrowserSurface[]
  /** 浏览器标签数（配额）。 */
  browserTabCount(): number
  /** 还能开浏览器标签吗（`maxTabs` 只约束浏览器标签）。 */
  canOpenBrowserTab(): boolean
  /**
   * 解析模型给的寻址（**默认只指向浏览器当前标签**）。
   * @param address - `tab` / `app_id`（都可缺省）。
   */
  resolve(address: SurfaceAddress): SurfaceResolution
  /** 清空（登出/切账号/切分区：应用窗口随宿主关闭，这里只留注册表一致）。 */
  clear(): void
}

/**
 * 构造 surface 注册表。
 * @param options - 当前标签来源与诊断出口。
 * @returns 注册表。
 */
export function createSurfaceRegistry(options: SurfaceRegistryOptions): SurfaceRegistry {
  const warn = options.warn ?? ((): void => {})
  const byId = new Map<number, BrowserSurface>()
  let appIds = new Map<string, number>()
  let surfaceSeq = 0

  return {
    registerBrowserTab(id, webContents) {
      const existing = byId.get(id)
      byId.set(id, {
        kind: 'browser-tab',
        id,
        ...(webContents === undefined ? {} : { webContents }),
        ...(existing?.scope === undefined ? {} : { scope: existing.scope }),
      })
    },
    unregister(id) {
      const surface = byId.get(id)
      if (surface?.kind === 'app' && surface.appId !== undefined) {
        appIds.delete(surface.appId)
      }
      byId.delete(id)
    },
    registerApp(input) {
      // 单应用单窗口（§7.2）：同一个 app_id 再注册一次 = 换 webContents（重建窗口），
      // 不新增 surface，也不进浏览器台账。
      const previous = appIds.get(input.appId)
      if (previous !== undefined) byId.delete(previous)
      let id = input.id
      // 保证 id 空间与浏览器标签不撞（调用方给的 id 与标签 id 相同时往上让）。
      while (byId.has(id) && byId.get(id)?.kind === 'browser-tab') {
        surfaceSeq += 1
        id = 10_000 + surfaceSeq
      }
      const surface: BrowserSurface = {
        kind: 'app',
        id,
        appId: input.appId,
        appScheme: input.appScheme,
        ...(input.webContents === undefined ? {} : { webContents: input.webContents }),
        ...(input.scope === undefined ? {} : { scope: input.scope }),
      }
      byId.set(id, surface)
      appIds.set(input.appId, id)
      return surface
    },
    get(id) {
      return byId.get(id)
    },
    appSurface(appId) {
      const id = appIds.get(appId)
      return id === undefined ? undefined : byId.get(id)
    },
    browserTabs() {
      return [...byId.values()].filter(surface => surface.kind === 'browser-tab')
    },
    appSurfaces() {
      return [...byId.values()].filter(surface => surface.kind === 'app')
    },
    browserTabCount() {
      return [...byId.values()].filter(surface => surface.kind === 'browser-tab').length
    },
    canOpenBrowserTab() {
      return this.browserTabCount() < MAX_BROWSER_TABS
    },
    resolve(address) {
      // 显式 app_id：唯一能指向应用窗口的方式（默认寻址永不指向它）。
      if (address.appId !== undefined && address.appId !== '') {
        const surface = this.appSurface(address.appId)
        if (surface === undefined) return { ok: false, reason: 'unknown-app' }
        if (address.tab !== undefined) {
          // 同时给了 tab 与 app_id 是矛盾的寻址：宁可拒绝，也不要"随便挑一个"
          // （工具面宁可让模型重问一次，也不要在错的窗口上执行动作）。
          warn(`pico-browser: refusing an ambiguous surface address (tab=${String(address.tab)} app_id=${address.appId})`)
          return { ok: false, reason: 'app-not-addressable-by-tab' }
        }
        return { ok: true, surface }
      }
      if (address.tab !== undefined) {
        const surface = byId.get(address.tab)
        if (surface === undefined || surface.kind !== 'browser-tab') {
          return { ok: false, reason: 'unknown-browser-tab' }
        }
        return { ok: true, surface }
      }
      // **默认寻址 = 浏览器当前标签**（§16.1 冻结）：应用窗口必须显式给 app_id。
      const active = options.activeBrowserTab()
      if (active === undefined) return { ok: false, reason: 'no-browser-tab' }
      const surface = byId.get(active)
      if (surface === undefined || surface.kind !== 'browser-tab') return { ok: false, reason: 'no-browser-tab' }
      return { ok: true, surface }
    },
    clear() {
      byId.clear()
      appIds = new Map()
    },
  }
}

/**
 * 该 URL 是否属于某个应用 surface 的 origin（`<scheme>://<app_id>`）。
 *
 * 用途只有一个：**浏览器面拒绝导航到应用 scheme 时的文案与审计**（§22.2 R4）。
 * 判定不看 scheme 名单（不写死任何渠道值），只看"这个 URL 的 scheme 等于某个已
 * 注册应用 surface 的 scheme"。
 * @param rawUrl - 候选 URL。
 * @param registry - surface 注册表。
 * @returns 命中的应用 surface，或 undefined。
 */
export function appSurfaceForUrl(rawUrl: unknown, registry: SurfaceRegistry): BrowserSurface | undefined {
  if (typeof rawUrl !== 'string' || rawUrl === '') return undefined
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return undefined
  }
  const scheme = parsed.protocol.replace(/:$/u, '')
  return registry.appSurfaces().find(surface => surface.appScheme === scheme)
}

/** surface 的可读标签（错误文案/日志用；绝不回显 URL）。 */
export function surfaceLabel(surface: BrowserSurface): string {
  return surface.kind === 'app' ? `app:${surface.appId ?? 'unknown'}` : `tab:${String(surface.id)}`
}
