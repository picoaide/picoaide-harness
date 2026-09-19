/**
 * Electron seam for the `picoaide-app://` origin — the ONLY module in this
 * package that touches Electron.
 *
 * `electron` 走 **peerDependencies**（照 `packages/host/browser` 的做法）：插件
 * 主体（`src/index.ts`）在纯 Node 下也要能加载（单测、profile 冒烟），所以它只
 * 依赖 {@link WasmAppsHostAdapter} 这个结构接口，由桌面壳在装配期把真实适配器
 * `provide` 进来。本模块是唯一静态 `import { protocol, session } from 'electron'`
 * 的地方，因此**只允许 Electron 主进程加载它**（desktop `src/main.ts`）。
 *
 * 两个入口的时序要求不同，都在这里给出：
 *  1. {@link registerAppScheme} 必须在 `app.whenReady()` **之前**执行
 *     （Electron 的 `registerSchemesAsPrivileged` 是启动期 API，晚于 ready 调用
 *     会静默无效或抛错），所以 desktop 壳在 `start()` 里、boot 之前调它；
 *  2. `protocol.handle` 是 per-session 的：默认 session 与每一个 `persist:` 分区
 *     都要注册，缺一个的表现是该分区里的应用页面直接
 *     `ERR_UNKNOWN_URL_SCHEME`（空白页）。
 *
 * @module @picoaide/dsh-wasm-apps-host/electron-adapter
 */

import { protocol, safeStorage, session } from 'electron'
// 权限守卫与请求闸门**只有一份实现**（在 browser 包里，§16.1 要求浏览器与应用窗口
// 共用）；本包通过 workspace 依赖使用它，不再自己写第二份。
import { ensureSessionGuard, installAppSchemeRequestGate, type NativeSession as NativeGuardSession, type NativeWebRequestSession } from '@picoaide/dsh-browser/guard'
import { DEFAULT_APP_SCHEME, isValidAppScheme } from './app-protocol.ts'

/** 协议 handler 的形状（Electron `protocol.handle` 的回调）。 */
export type AppSchemeRequestHandler = (request: Request) => Promise<Response> | Response

/**
 * 应用 scheme 请求闸门（§16.1 导航闸门 / §23.2 N6）：只有**应用窗口**发出的
 * `<scheme>://…` 请求可以抵达协议 handler；任意 http(s) 页面里的
 * `<img src="<scheme>://…">`、`sendBeacon`、`prefetch`、SW 一律取消。
 *
 * 归属：与协议 handler **同一批注册点**（避免"注册了 handler 却没装闸门"的缝）。
 */
export interface AppSchemeRequestGate {
  /**
   * 该 `webContentsId` 是否是应用窗口（由窗口管理面维护）。
   * @param webContentsId - Electron `webRequest` details 里的发起者 id。
   */
  (webContentsId: number | undefined): boolean
}

/** 协议 handler 注册的入口（默认 session 与分区两类）。 */
export interface AppSchemeRegistrar {
  /** 在**默认 session** 上注册应用协议 handler。 */
  handleAppScheme(scheme: string, handler: AppSchemeRequestHandler): void
  /** 在指定分区（`persist:...`）的 session 上注册应用协议 handler。 */
  handleInSession(scheme: string, partition: string, handler: AppSchemeRequestHandler): void
  /**
   * 确保该 session（默认 session 或某个分区）的**权限守卫**已装（§16.1：归属 = 分区
   * 初始化，不是建 tab 时；幂等）。缺席 ⇒ 宿主记一条 warn（该 session 的 camera/mic
   * 面就没有守卫，而 Electron 缺 check handler 时默认放行）。
   */
  ensureSessionGuard?(partition?: string): void
  /**
   * 在指定 session 上装**应用 scheme 请求闸门**（§23.2 N6；幂等语义由调用方保证：
   * 与协议 handler 同一批注册点，每个 session 只装一次）。
   */
  installAppSchemeRequestGate?(scheme: string, isAppSurfaceWebContents: AppSchemeRequestGate, partition?: string): void
  /** 出站请求（缺省时插件用全局 fetch）。 */
  fetch?: (url: string, init: RequestInit) => Promise<Response>
  /**
   * OS 钥匙串（§23.1：安装私钥优先存 `safeStorage`；不可用时 0600 明文 + warn）。
   * 由桌面壳给真实实现；纯 Node 宿主缺席 ⇒ 走明文兜底。
   */
  safeStorage?: {
    isEncryptionAvailable(): boolean
    encryptString(plainText: string): Buffer
    decryptString(encrypted: Buffer): string
  }
}

/**
 * 应用窗口载体（§16.1「建窗适配器扩 `WasmAppsHostAdapter`」）。
 *
 * 由桌面壳实现（真实 `BrowserWindow`），单测给替身：窗口几何/生命周期/闸门这些
 * "容易写错又难验证"的规则在 `windows.ts` 里是纯逻辑，这里只留原生动作。
 */
export interface WasmAppsWindowAdapter {
  /** 建窗（几何已按契约算好）。 */
  createAppWindow(options: {
    appId: string
    url: string
    title: string
    width: number
    height: number
    x: number
    y: number
    ratio?: number
    minimumWidth: number
    minimumHeight: number
  }): unknown
  /** 聚焦并导航（已有窗口）。 */
  focusAppWindow(handle: unknown, url: string): void
  /** 关窗。 */
  closeAppWindow(handle: unknown): void
  /** 锁定宽高比（`extraSize` = 自绘 chrome 的额外高度）。 */
  setAspectRatio(handle: unknown, ratio: number, extraSize: { width: number, height: number }): void
  /** 安装应用面导航闸门（`will-navigate`/`setWindowOpenHandler` + session 级
   * `onBeforeRequest`，归属 = 应用窗口模块，§16.1）。 */
  installAppWindowGuards?(handle: unknown, appId: string): void
  /** 当前显示器工作区（多显示器：每次打开重新求值）。 */
  workArea?(): { x: number, y: number, width: number, height: number }
}

/**
 * 桌面壳交给插件的最小 Electron 面。
 *
 * `handleAppScheme` / `handleInSession` 对应"默认 session"与"某个持久分区"两次
 * 注册；`fetch` 是出站通道（Chromium 栈，与 enterprise `gatewayFetch` 同源，
 * 走系统代理与证书策略）。`fetch` 可缺席：单测替身与极简宿主可以不给，此时
 * 插件回落到全局 `fetch`。
 */
export type WasmAppsHostAdapter = AppSchemeRegistrar

/** 已做过特权注册的 scheme（**按 scheme 记**，不是模块级布尔：渠道参数化后同一个
 * 进程里可能出现多个 scheme——热重载、单测与将来的多窗口宿主都会重复进入）。 */
const privilegedSchemes = new Set<string>()

/**
 * 把渠道注入的应用源 scheme 注册为特权 scheme（**必须在 `app.whenReady()` 之前调用**）。
 *
 * 权限位与契约 §2 逐字一致：`standard`（有 origin 语义，`<scheme>://demo` 是一个
 * origin）、`secure`（安全上下文，`isSecureContext === true`）、`supportFetchAPI`
 * （应用内 `fetch`/XHR 可达 handler）、`corsEnabled: false`（跨应用与"客户端 UI →
 * 应用"两个方向都必须被拦）、`stream`（流式响应体）、`codeCache`（V8 代码缓存，
 * 需 `standard`）。
 *
 * **scheme 是参数**（§7.8/§10/§16.1）：取值来自渠道包 `desktop.app_origin_scheme`
 * （desktop 壳在模块作用域读随包 channel.json），这里**不得**回落到任何猜出来的
 * 值。缺省参数只为官方构建/单测保留；非法 scheme 一律抛（启动期 fail-loud，
 * 比"页面打不开"早得多也清楚得多）。
 * @param scheme - 本安装的应用源 scheme（不含 `:`）。
 * @throws 当 scheme 形状非法或是保留 scheme 时。
 */
export function registerAppScheme(scheme: string = DEFAULT_APP_SCHEME): void {
  if (!isValidAppScheme(scheme)) {
    throw new Error(`registerAppScheme: ${JSON.stringify(scheme)} is not a valid application origin scheme`)
  }
  if (privilegedSchemes.has(scheme)) return
  protocol.registerSchemesAsPrivileged([{
    scheme,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: false,
      stream: true,
      codeCache: true,
    },
  }])
  privilegedSchemes.add(scheme)
}

/**
 * 真实 Electron 适配器（默认 session + 任意分区 + Chromium 外出栈）。
 *
 * scheme 是**每次调用**的参数（不是适配器字段）：协议注册与 handler 注册必须用
 * 同一个值，把它放在调用参数上可以让"两处用了不同的 scheme"这类缺陷在类型层
 * 就无法表达。
 * @returns 交给插件（`provide('wasmAppsHostAdapter', …)`）的适配器实例。
 */
export function createRealElectronAdapter(): WasmAppsHostAdapter {
  return {
    handleAppScheme(scheme, handler) {
      session.defaultSession.protocol.handle(scheme, handler)
    },
    handleInSession(scheme, partition, handler) {
      session.fromPartition(partition).protocol.handle(scheme, handler)
    },
    ensureSessionGuard(partition) {
      const target = partition === undefined ? session.defaultSession : session.fromPartition(partition)
      ensureSessionGuard(target as unknown as NativeGuardSession)
    },
    installAppSchemeRequestGate(scheme, isAppSurfaceWebContents, partition) {
      const target = partition === undefined ? session.defaultSession : session.fromPartition(partition)
      installAppSchemeRequestGate(target as unknown as NativeWebRequestSession, {
        scheme,
        isAppSurfaceWebContents,
      })
    },
    fetch: async (url, init) => await session.defaultSession.fetch(url, init),
    // OS 钥匙串（§23.1）：Windows DPAPI / macOS Keychain / Linux libsecret。
    // 不可用时 `isEncryptionAvailable()` 为 false，插件侧回落 0600 明文并记 warn。
    safeStorage: {
      isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
      encryptString: plainText => safeStorage.encryptString(plainText),
      decryptString: encrypted => safeStorage.decryptString(encrypted),
    },
  }
}
