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
 * 第四件东西也在这里：**分区名公式的唯一实现**（{@link browserPartitionFor}）。
 * `persist:` 分区名跨包镜像过一次（`@picoaide/dsh-wasm-apps-host/partition` 是同一
 * 公式的副本），两份实现发散的症状是"协议 handler 注册在一个没人用的分区上 ⇒ 应用
 * 页面空白"。把公式放在本子路径导出，宿主侧才可以只保留一份。
 *
 * @module @picoaide/dsh-browser/surface
 */

import { createHash } from 'node:crypto'

/** Surface 种类（§16.1 冻结：只有这两种）。 */
export type SurfaceKind = 'browser-tab' | 'app'

/** 浏览器标签配额（§16.1：应用窗口**不**吃这个配额）。 */
export const MAX_BROWSER_TABS = 16

/** Cordis 服务名：浏览器插件 `provide` 出去的 surface 注册表（`windows.ts` 的 inject）。 */
export const BROWSER_SURFACE_SERVICE = 'browserSurface'

/**
 * 分区名里一个段的编码（与 `@picoaide/dsh-connectors` 的 `user-scope.ts`
 * `encodeSegment` 逐字一致）：`A-Za-z0-9_-` 原样、其余 `~<HEX>~`，空输入回落
 * `anonymous`。编码必须是**单射**：两个用户名编码成同一个段会让两个人的分区相撞。
 * @param segment - 原始用户名（或空）。
 * @returns 可安全放进分区名的串。
 */
export function encodePartitionSegment(segment: string): string {
  let out = ''
  for (const char of segment) {
    const code = char.codePointAt(0)!
    if ((code >= 0x30 && code <= 0x39)
      || (code >= 0x41 && code <= 0x5a)
      || (code >= 0x61 && code <= 0x7a)
      || char === '-' || char === '_') {
      out += char
    } else {
      out += `~${code.toString(16).toUpperCase()}~`
    }
  }
  return out.length === 0 ? 'anonymous' : out
}

/**
 * 服务端地址 → 分区名后缀（sha256 前 32 位 hex）。
 *
 * 归一化 = 去首尾空白 + 去**全部**尾斜杠：分区名是磁盘目录名，`https://a.example`
 * 与 `https://a.example/` 必须落在同一个分区里（否则一次地址写成带斜杠就换一个空
 * 分区，用户看到的是"里面的存储突然没了"）；而换服务端必须换分区（同机测试/正式
 * 并存是真实拓扑，`persist:` 分区跨租户共用会让同名应用 origin 的 localStorage /
 * IndexedDB 串味）。
 *
 * 返回 `undefined`（未登录 / 空地址）⇒ 调用方**不带**哈希后缀。
 * @param serverURL - 当前会话的服务端地址。
 * @returns 32 位 hex 摘要，或 undefined。
 */
export function serverPartitionHash(serverURL: string | null | undefined): string | undefined {
  if (typeof serverURL !== 'string') return undefined
  let value = serverURL.trim()
  while (value.endsWith('/')) value = value.slice(0, -1)
  if (value === '') return undefined
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32)
}

/**
 * 某个员工（或缺省匿名）的内置浏览器分区名 —— **跨包唯一实现**。
 *
 *     persist:agent-browser-<encoded-user>[@<server-hash>]
 *
 * 匿名（未登录）没有租户可隔离 ⇒ **不带**后缀（`persist:agent-browser-anonymous`
 * 逐字节不变：应用窗口与浏览器标签共用它，改一个字两边就落在不同 session 上）。
 *
 * `@picoaide/dsh-wasm-apps-host/partition` 是同一公式的镜像（该包不允许反向依赖
 * 本包）；`tests/partition-parity.spec.ts` 用真实 Node 跑那份实现并逐例对拍，漂移
 * 即红。
 * @param username - 当前登录用户名；null/undefined/空串 = 未登录。
 * @param serverHash - {@link serverPartitionHash} 的结果；未登录/取不到时缺省。
 * @returns Electron partition 名（`persist:` 前缀 = 持久化）。
 */
export function browserPartitionFor(username: string | null | undefined, serverHash?: string | undefined): string {
  const key = username !== undefined && username !== null && username.length > 0 ? username : 'anonymous'
  const base = `persist:agent-browser-${encodePartitionSegment(key)}`
  const suffix = key === 'anonymous' ? undefined : serverHash
  return suffix === undefined || suffix === '' ? base : `${base}@${suffix}`
}

/** 控制权归属：`user` = 人类拿着（我来操作），`agent` = AI 可用（缺省）。 */
export type SurfaceControlOwner = 'user' | 'agent'

/**
 * 一个 surface 的 `webContents` 在本模块里的**最小可驱动面**（宿主交过来的是真
 * Electron `webContents`，这里只声明驱动方真正用到的方法）。
 *
 * 为什么不直接声明成 Electron 类型：本模块（以及 runtime 的 surface 路径）刻意不
 * import electron；`tests/` 里的替身只需要实现这几项。
 */
export interface SurfaceWebContents {
  /** 导航（唯一必需项 —— 没有它这个 surface 不可驱动）。 */
  loadURL(url: string): Promise<void>
  on?(event: string, listener: (...args: unknown[]) => void): unknown
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown
  isLoading?(): boolean
  getURL?(): string
  getTitle?(): string
  stop?(): void
  isDestroyed?(): boolean
}

/**
 * 把注册表里的不透明 `webContents` 收窄成 {@link SurfaceWebContents}。
 *
 * 判据只有一条：有 `loadURL` 函数 —— 那是"能不能被驱动"的分界（宿主适配器缺席
 * `webContents()` 时 surface 仍然注册、`app_id` 仍可寻址，只是不可驱动；这时工具面
 * 必须报明确错误，绝不能回落到浏览器标签）。
 * @param handle - surface 的 `webContents`。
 * @returns 收窄后的句柄，或 undefined。
 */
export function asSurfaceWebContents(handle: unknown): SurfaceWebContents | undefined {
  if (handle === null || typeof handle !== 'object') return undefined
  const candidate = handle as { loadURL?: unknown }
  return typeof candidate.loadURL === 'function' ? handle as SurfaceWebContents : undefined
}

/**
 * URL 是否落在该应用 surface 自己的 origin 内（`<appScheme>://<appId>/…`）。
 *
 * 这是宿主 `windows.ts` 导航闸门（`will-navigate`/`will-redirect`/`will-frame-navigate`
 * 共用的那个 verdict）在**浏览器侧**的同一判据：应用窗口只在自己 origin 内导航，
 * 跨 origin 一律拒（302 与直接导航同等对待）。两份判据的存在理由：宿主那份是**执行**
 * 闸门（原生层，拦一切来源），这份是**模型面**闸门（在 webContents 被碰之前就把
 * `browser_navigate{app_id, <外站 URL>}` 变成明确错误，而不是让模型看到一次原生拒绝）。
 * @param surface - 一个 `kind:'app'` 的 surface。
 * @param rawUrl - 候选 URL。
 * @returns true = 允许该 surface 导航过去。
 */
export function appSurfaceAllowsUrl(surface: BrowserSurface, rawUrl: string): boolean {
  if (surface.kind !== 'app' || surface.appScheme === undefined || surface.appId === undefined) return false
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return false
  }
  if (parsed.protocol !== `${surface.appScheme}:`) return false
  return parsed.hostname === surface.appId
}

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
  registerApp(input: {
    id: number
    appId: string
    appScheme: string
    webContents?: unknown
    scope?: string
    /**
     * 初始控制权归属。
     *
     * 缺省 `'agent'`，**与设计总纲 §7.2 的冻结条款（应用窗口默认由人操作）有意不同**：
     * 那条默认成立的前提是应用窗口自带胶囊挂载点（同一按钮双向）。挂载点尚不存在
     * （宿主侧待做）时把它改成 `'user'`，等于每个应用窗口**永久**不可被 AI 驱动
     * （没有任何入口把控制权交回来）—— 比今天的默认更坏。宿主实现挂载点时把
     * `'user'` 传进来即可，工具面/闸门无需再改（它们只读归属）。
     */
    control?: SurfaceControlOwner
  }): BrowserSurface
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
   * 设某个 surface 的控制权归属（§16.1 第 3 条：**按 surface** 记，不再依赖池级
   * `pool.controlled`）。
   *
   * 语义与浏览器窗口上的胶囊**同一个**：用户点「我来操作」= `'user'`，同一个按钮
   * （「交给 AI」）= `'agent'`。空白处点击 / Esc / 面板都不得调用它。
   * @param id - surface id。
   * @param owner - 新的归属。
   * @returns 更新后的 surface；id 未知 ⇒ undefined（调用方不记录任何状态）。
   */
  setSurfaceControl(id: number, owner: SurfaceControlOwner): BrowserSurface | undefined
  /** 某个 surface 的控制权归属（未知 id ⇒ undefined；已知 id 缺省 `'agent'`）。 */
  surfaceControl(id: number): SurfaceControlOwner | undefined
  /** 当前由**用户**持有控制权的 surface（池级投影用；空数组 = 没有）。 */
  userHeldSurfaces(): readonly BrowserSurface[]
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
  /**
   * 控制权归属（§16.1 第 3 条）。**缺省 `agent`**（不在表里 = AI 可用）：新建窗口/
   * 标签的初始状态必须是"AI 可以操作"，否则用户每次开窗都要先点一次按钮。
   *
   * 与 surface 同生命周期：`unregister`/`clear` 一并删除（重开的窗口拿回缺省值，
   * 而不是继承上一个窗口被用户按住的状态）。
   */
  const control = new Map<number, SurfaceControlOwner>()

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
      // 控制权随 surface 一起消失（重开的窗口回到缺省 `'agent'`）。
      control.delete(id)
      byId.delete(id)
    },
    registerApp(input) {
      // 单应用单窗口（§7.2）：同一个 app_id 再注册一次 = 换 webContents（重建窗口），
      // 不新增 surface，也不进浏览器台账。
      const previous = appIds.get(input.appId)
      if (previous !== undefined) {
        byId.delete(previous)
        // 重建的窗口是一张新窗口：不继承旧窗口被按住的「我来操作」。
        control.delete(previous)
      }
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
      // 初始归属：缺省 `'agent'`（见 `registerApp` 的 `control` 注释）。
      if (input.control === 'user') control.set(id, 'user')
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
    setSurfaceControl(id, owner) {
      const surface = byId.get(id)
      if (surface === undefined) return undefined
      if (owner === 'user') control.set(id, 'user')
      else control.delete(id)
      return surface
    },
    surfaceControl(id) {
      if (!byId.has(id)) return undefined
      return control.get(id) ?? 'agent'
    },
    userHeldSurfaces() {
      return [...byId.values()].filter(surface => surface.kind === 'app' && control.get(surface.id) === 'user')
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
      control.clear()
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
