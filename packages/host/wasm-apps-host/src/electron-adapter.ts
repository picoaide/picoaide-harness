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

import { BrowserWindow, net, protocol, safeStorage, screen, session } from 'electron'
import type { ClientRequest, Session as ElectronSession } from 'electron'
// 权限守卫与请求闸门**只有一份实现**（在 browser 包里，§16.1 要求浏览器与应用窗口
// 共用）；本包通过 workspace 依赖使用它，不再自己写第二份。
import { ensureSessionGuard, installAppSchemeRequestGate, type NativeSession as NativeGuardSession, type NativeWebRequestSession } from '@picoaide/dsh-browser/guard'
import { DEFAULT_APP_SCHEME, isValidAppScheme } from './app-protocol.ts'
import { appWindowFailureCopy } from './app-window-copy.ts'
import { createAppWindowRecovery, type AppWindowRecovery } from './app-window-recovery.ts'
import { DEFAULT_HOST_LOCALE, type HostLocale } from './locale.ts'
// 窗口几何/生命周期/状态文件的**纯逻辑**在 `windows.ts`（无 Electron 依赖，单测覆盖）；
// 本模块只实现它的原生动作面。类型从那里**再导出**（不复制第二份声明：两份声明
// 会在"给契约加一个成员"时静默漂移，而漂移的方向是`webContentsId` 之类的闸门判据
// 在真实适配器上缺席）。
import { classifyAppWindowNavigation, type AppWindowHandle, type AppWindowHealth, type WasmAppsWindowAdapter } from './windows.ts'

export type { AppWindowFailure, AppWindowFailureKind } from './app-window-recovery.ts'
export type { AppWindowHandle, AppWindowHealth, WasmAppsWindowAdapter } from './windows.ts'

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
 * **声明在 `windows.ts`**（那里是实现它的纯逻辑的消费者），本模块只 `export type`
 * 转出去 —— 见文件头的 import 注释。
 *
 * @see {@link WasmAppsWindowAdapter}
 */

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
 * 同源重定向的最大跳数（跨源**一跳都不跟**，见 {@link createPlatformFetch}）。
 *
 * 取 5 是因为平台 API 不该有重定向链：留几跳给"尾斜杠 307""HTTP→HTTPS 同源升级"
 * 这类正常情况，同时保证畸形/恶意链不会无限循环。
 */
export const PLATFORM_FETCH_MAX_REDIRECTS = 5

/**
 * 平台出站（**唯一实现**）：`net.request`（主进程原始 HTTP 客户端），**不是**
 * `session.fetch`。
 *
 * ## 为什么不能用 `session.fetch`（2026-09-20 真机实测，探针
 * `temp/appwin/electron-fetch-probe.cjs`）
 *
 * 契约 §4.3/§20.2 要求协议 handler 为每个应用请求**合成**
 * `Origin: <app scheme>://<app_id>`（自定义协议下浏览器不发 Origin，而平台对非幂等
 * 请求强制校验它）。`session.fetch` 是**浏览器语义**的客户端：请求一旦带 `Origin`
 * 就被当作跨源请求，Chromium 先发 CORS 预检 `OPTIONS`；平台对该路径没有 OPTIONS
 * 路由 ⇒ 404 ⇒ 整个请求以 `net::ERR_FAILED` 失败（实测：同头同体下 A/C/D 三种带
 * Origin 的形态全部 ERR_FAILED，去掉 Origin 才 200/401）。
 *
 * 症状极具误导性：**窗口开了、应用页却永远显示"暂时连不上服务端"**，宿主日志只有
 * 一行 `gateway request for <app> failed (net::ERR_FAILED)`，而服务端访问日志里只有
 * 一串 `OPTIONS … 404`（没有任何 `POST …/request`）——
 * 也就是"看起来像网络故障，实际是客户端自己的 CORS 预检"。
 *
 * `net.request` 不做 CORS，`Origin` 与自定义头原样送出（同一探针 E 组实测：同样的
 * 头拿到 401 `AUTH_FAILED`，说明请求真的到达了平台）。仍绑定同一个
 * `Session`（证书校验策略/代理/缓存都是那个 session 的网络上下文）。
 *
 * ## 重定向：**只跟同源**（2026-09-20 审计 P2-2）
 *
 * 这条出站通道每次都带 `Authorization: Bearer <员工令牌>` 与
 * `X-Pico-App-Proof`，而平台 API **没有**任何合法的跨源重定向用途。此前用
 * `redirect: 'follow'`：一次 302 到别的 host 就把这两件凭据原样送过去（审计实测
 * `net.request` 与 `session.fetch` **两代都这样** ⇒ 不是本实现引入的回归，但本实现
 * 有能力关掉它）。现在改成 `redirect: 'manual'` + 在 `redirect` 事件里**同步**判源：
 *  - 目标 origin 与请求 origin 相同 ⇒ `followRedirect()`（正常同源跳转照旧）；
 *  - 不同源 / 目标 URL 解析不出来 / 跳数超限 ⇒ **不发第二个请求**，直接以
 *    `createPlatformFetch: refused a cross-origin redirect …` 拒绝（fail-closed）。
 *
 * 响应整体缓冲成 `Response`：本包的三个调用点（协议 handler / 打开校验 / proof 签发）
 * 全都读 `status` + `text()`/`json()`，没有流式消费；平台侧本身也有 8 MiB 响应上限。
 * @param target - 出站使用的 session（缺省默认 session）。
 * @returns 与 `fetch` 同形的出站函数（交给插件做 `adapter.fetch`）。
 */
export function createPlatformFetch(target: ElectronSession = session.defaultSession): (url: string, init: RequestInit) => Promise<Response> {
  return async (url, init) => {
    const method = (init.method ?? 'GET').toUpperCase()
    const headers = new Headers(init.headers ?? undefined)
    const body = requestBodyBytes(init.body)
    return await new Promise<Response>((resolve, reject) => {
      const signal = init.signal ?? undefined
      if (signal?.aborted === true) {
        reject(signal.reason instanceof Error ? signal.reason : new Error('the request was aborted'))
        return
      }
      let request: ClientRequest
      try {
        // methods 之外的选项：`redirect: 'manual'`（**不**让 Chromium 自己跟跳：
        // 每一次重定向都要过下面的同源判据）、显式 session（证书校验策略/代理仍走该
        // session 的网络上下文）。
        request = net.request({ method, url, session: target, redirect: 'manual' })
      } catch (cause) {
        reject(cause instanceof Error ? cause : new Error(String(cause)))
        return
      }
      let settled = false
      let redirects = 0
      /** 初始 origin：所有被放行的跳都必须留在它上面（跨源一跳都不跟）。 */
      let origin: string | null
      try {
        origin = new URL(url).origin
      } catch {
        origin = null
      }
      const fail = (cause: unknown): void => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        reject(cause instanceof Error ? cause : new Error(String(cause)))
      }
      const onAbort = (): void => {
        try {
          request.abort()
        } catch {
          // 已经结束的请求 abort 会抛：忽略（结果由 fail() 给出）。
        }
        fail(signal?.reason instanceof Error ? signal.reason : new Error('the request was aborted'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      request.on('error', fail)
      request.on('redirect', (status, _method, redirectUrl) => {
        // 判据唯一实现（`sameOriginRedirect`）：跨源一律 fail-closed，**不** follow。
        // 目标 URL 解析失败也按跨源处理（"看不懂就不跟"）。
        if (!sameOriginRedirect(origin, redirectUrl)) {
          fail(new Error(
            `createPlatformFetch: refused a cross-origin redirect (${status} ${url} -> ${redirectUrl}): `
            + 'credentials are never replayed to another origin',
          ))
          try {
            request.abort()
          } catch {
            // 同上：abort 的异常不影响已给出的结论。
          }
          return
        }
        redirects += 1
        if (redirects > PLATFORM_FETCH_MAX_REDIRECTS) {
          fail(new Error(`createPlatformFetch: too many redirects (> ${PLATFORM_FETCH_MAX_REDIRECTS})`))
          try {
            request.abort()
          } catch {
            // 同上。
          }
          return
        }
        try {
          // 必须在 `redirect` 事件里**同步**调用（Electron 的契约）：晚一步请求就以
          // "Redirect was cancelled" 结束。
          request.followRedirect()
        } catch (cause) {
          fail(cause)
        }
      })
      request.on('response', (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => { chunks.push(Buffer.from(chunk)) })
        response.on('error', fail)
        response.on('end', () => {
          if (settled) return
          // **先构造、再置 settled**（2026-09-20 审计 P2-1）：反过来的话
          // `buildResponse` 抛错时 `settled` 已是 true，`fail()` 直接 return —— promise
          // 永久 pending，调用方的 AbortSignal 也被摘掉，一次失败被放大成"永不返回"。
          // 触发面：status ∉ [200,599]（RangeError）或 statusText 含非 0x20–0x7E 字符
          // （TypeError）。
          let built: Response
          try {
            built = buildResponse(response.statusCode, response.statusMessage, response.headers, Buffer.concat(chunks))
          } catch (cause) {
            fail(cause)
            return
          }
          settled = true
          signal?.removeEventListener('abort', onAbort)
          resolve(built)
        })
      })
      try {
        for (const [name, value] of headers) request.setHeader(name, value)
        if (body !== undefined) request.write(body)
        request.end()
      } catch (cause) {
        fail(cause)
      }
    })
  }
}

/**
 * 重定向目标是否与**初始请求**同源（`createPlatformFetch` 的唯一判据）。
 *
 * 同源 = 协议 + 主机 + 端口完全一致；相对 `Location`（`/next`）按初始 origin 解析。
 * 解析失败返回 false（"看不懂就不跟"，fail-closed）。
 * @param origin - 初始请求的 origin（`new URL(requestUrl).origin`）；null ⇒ 一律 false。
 * @param redirectUrl - `net.request` 的 `redirect` 事件给出的目标 URL。
 * @returns 是否可以继续跟随。
 */
function sameOriginRedirect(origin: string | null, redirectUrl: unknown): boolean {
  if (origin === null || typeof redirectUrl !== 'string' || redirectUrl === '') return false
  try {
    return new URL(redirectUrl, origin).origin === origin
  } catch {
    return false
  }
}

/**
 * 把 `RequestInit.body` 规范成 `ClientRequest.write` 能吃的字节。
 *
 * 只支持本包实际用到的三种（JSON 字符串 / `Uint8Array` / `ArrayBuffer`）：流式 body
 * 会与"整体缓冲响应"的实现假设打架，遇到就直接抛（fail-loud，而不是悄悄丢掉 body
 * 让平台回一个莫名其妙的 400）。
 * @param body - `RequestInit.body`。
 * @returns 字节，或 undefined（无 body）。
 * @throws 当 body 是不支持的形态时。
 */
function requestBodyBytes(body: RequestInit['body']): Buffer | undefined {
  if (body === undefined || body === null) return undefined
  if (typeof body === 'string') return Buffer.from(body, 'utf8')
  if (body instanceof Uint8Array) return Buffer.from(body)
  if (body instanceof ArrayBuffer) return Buffer.from(new Uint8Array(body))
  throw new Error('createPlatformFetch: unsupported request body (only string, Uint8Array and ArrayBuffer are supported)')
}

/**
 * 用 `net.request` 的响应三元组构造标准 `Response`。
 *
 * 逐跳/传输层头必须丢掉：`net.request` 交出来的体**已经解压**，而
 * `content-encoding`/`content-length`/`transfer-encoding` 描述的仍是线上形态 —— 原样
 * 带进 `Response` 会让消费者的解码与长度校验对不上（最典型的是 body 被截断或抛
 * `TypeError: incorrect header check`）。
 * @param status - HTTP 状态码。
 * @param statusMessage - HTTP 原因短语（可能为空）。
 * @param raw - `net.request` 的 `response.headers`（值可能是数组或单串）。
 * @param body - 已缓冲的响应体。
 * @returns 标准 `Response`。
 */
function buildResponse(status: number, statusMessage: string, raw: Record<string, string | string[]>, body: Buffer): Response {
  const headers = new Headers()
  const dropped = new Set(['content-encoding', 'content-length', 'transfer-encoding'])
  for (const [name, values] of Object.entries(raw)) {
    if (dropped.has(name.toLowerCase())) continue
    for (const value of (Array.isArray(values) ? values : [values])) headers.append(name, value)
  }
  // 204/304 与空体在 `Response` 构造上语义不同：带 body 会直接抛。
  const empty = body.length === 0 || status === 204 || status === 304
  return new Response(empty ? null : new Uint8Array(body), {
    status,
    ...(statusMessage === '' ? {} : { statusText: statusMessage }),
    headers,
  })
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
    // 出站**不走** `session.fetch`：见 createPlatformFetch 的注释（Origin ⇒ CORS 预检
    // ⇒ 平台没有 OPTIONS 路由 ⇒ 应用页永远"连不上服务端"）。
    fetch: createPlatformFetch(),
    // OS 钥匙串（§23.1）：Windows DPAPI / macOS Keychain / Linux libsecret。
    // 不可用时 `isEncryptionAvailable()` 为 false，插件侧回落 0600 明文并记 warn。
    safeStorage: {
      isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
      encryptString: plainText => safeStorage.encryptString(plainText),
      decryptString: encrypted => safeStorage.decryptString(encrypted),
    },
  }
}

/** {@link createRealElectronWindowAdapter} 的构造参数。 */
export interface RealAppWindowAdapterOptions {
  /**
   * 本安装的应用源 scheme（渠道注入，§10/§16.1）。
   *
   * 导航闸门按它判"同 app origin"；非法值一律**构造期**抛（fail-loud 比"窗口打开
   * 后每一个导航都被拒"早得多，也清楚得多）。
   */
  appScheme: string
  /** 诊断出口（拒绝导航 / 加载失败）。缺省丢弃。 */
  warn?: ((message: string) => void) | undefined
  /**
   * 宿主语言（**函数**，按调用求值）。
   *
   * 为什么是 thunk 而不是值：失败页文案要跟随应用内语言切换，而适配器是**启动期**
   * 构造的（那时用户还没法改语言）。任何把首次解析结果钉进闭包常量的写法都会让
   * "切了语言但失败页还是旧语言"（本仓已记录两次同根因 bug）。
   *
   * 缺席 ⇒ 产品缺省语言（`DEFAULT_HOST_LOCALE`）。
   */
  locale?: (() => HostLocale) | undefined
}

/**
 * 真实 Electron 应用窗口适配器（W-C 裁决的"独立窗口"原生面，§16.1）。
 *
 * 这里**只有原生动作**：几何计算、单应用单窗口、尺寸/比例记忆、状态文件都在
 * `windows.ts`（纯 Node 可测）。本函数是那条逻辑与 Electron 之间唯一的缝 ——
 * 所以它自己也要能被离线钉住（`electron-adapter.spec.ts` 用替身 `BrowserWindow`）。
 *
 * 冻结条款（逐条对应实现）：
 *  - **默认 session**：应用协议 handler 与 `onBeforeRequest` 闸门都由插件装在
 *    **默认 session**（`registerDefault()`）上；应用窗口跟着走同一个 session，
 *    否则页面直接 `ERR_UNKNOWN_URL_SCHEME`（§16.1「注册面 = 默认 session + 分区」）。
 *  - **标题不可被页面改写**（§7.2 防伪装）：`page-title-updated` 一律
 *    `preventDefault()`，窗口标题恒为宿主给的 `<应用名> · <产品名>`。
 *  - **同 app origin 的导航闸门**：`will-navigate` / `will-frame-navigate` /
 *    `setWindowOpenHandler` 三处都按 {@link classifyAppWindowNavigation} 判
 *    （跨 app = 换壳钓鱼 ⇒ 拒；http(s) 外链不在应用窗口导航 ⇒ 拒）。
 *  - **权限守卫**：建窗前 `ensureSessionGuard()` 显式确保（幂等；Electron 缺 check
 *    handler 时默认放行 camera/mic）。
 *  - **存活判据**（`isAlive`）：用户手动关窗后窗口管理器必须**重新建窗**，而不是
 *    聚焦一个已销毁的句柄（否则第二次 `open` 会回 `focused` 而**屏幕上一个窗口都
 *    没有**——正是本模块要消灭的那类"契约对、现象空"的缺陷）。
 *  - **崩溃 / 加载失败恢复**（R16B-19）：`render-process-gone` 与顶层 `did-fail-load`
 *    经 `app-window-recovery.ts` 的**单飞状态机**处理 —— 至多自动重载一次，之后显示
 *    带「重试」按钮的失败页（形态与 shell 窗口的 `reloadOrShowCrashFallback` 一致）。
 *  - **原生生命周期订阅**（R16B-20）：`win 'closed'` 与健康状态变化经
 *    {@link WasmAppsWindowAdapter.onAppWindowClosed} /
 *    {@link WasmAppsWindowAdapter.onAppWindowHealth} 即时通知窗口管理器；没有它，
 *    用户自己关掉的窗口只能靠 `isAlive()` 被"问一次"才发现。
 * @param options - 应用源 scheme、诊断出口与宿主语言。
 * @returns 交给桌面壳 `provide('wasmAppsWindowAdapter', …)` 的适配器实例。
 * @throws 当 `appScheme` 不是合法应用源 scheme 时。
 */
export function createRealElectronWindowAdapter(options: RealAppWindowAdapterOptions): WasmAppsWindowAdapter {
  const { appScheme } = options
  if (!isValidAppScheme(appScheme)) {
    throw new Error(`createRealElectronWindowAdapter: ${JSON.stringify(appScheme)} is not a valid application origin scheme`)
  }
  const warn = options.warn ?? ((): void => {})
  const locale = options.locale ?? ((): HostLocale => DEFAULT_HOST_LOCALE)
  /** 句柄 → 原生窗口。用注册表而不是 `instanceof`：单测的替身也是合法句柄。 */
  const handles = new WeakMap<object, BrowserWindow>()

  /**
   * 每个原生窗口的**恢复记账 + 诊断订阅**（R16B-19 / R16B-20）。
   *
   * 为什么挂在原生窗口对象上（WeakMap）而不是句柄上：句柄就是 `BrowserWindow` 本身
   * （见 {@link remember}），两者同生命周期；用 WeakMap 是为了不在窗口销毁后留下
   * 强引用。
   */
  interface AppWindowBookkeeping {
    /** 这台窗口的崩溃恢复状态机（单飞 + 至多自动重载一次 + 失败页）。 */
    recovery: AppWindowRecovery
    /**
     * **最近一次请求加载的应用 URL**（失败页的重试目标）。
     *
     * 为什么必须自己记：失败页显示期间 `webContents.getURL()` 是 `data:` 文档，
     * 拿它当重试目标会让第二次失败页的按钮变成禁用的（用户再无出路）。
     */
    desiredUrl: string
    /** 宿主的健康订阅（模型面 `crashed` 的消费者）。 */
    health: Set<(snapshot: AppWindowHealth) => void>
    /** 宿主的销毁订阅（R16B-20：用户点窗口自己的关闭按钮）。 */
    closed: Set<() => void>
    /**
     * 最近一次加载请求的序号（健康状态的**排序判据**）。
     *
     * 为什么必须有它：`loadURL` 的 promise 是按微任务结算的，而崩溃事件可能先到 ——
     * "崩溃前发出的那次加载成功了"于是会在崩溃之后把 `crashed` 抹回 false（用户与
     * 模型看到的是"窗口好好的"，而它其实已经崩了）。规则：加载结果只在它**仍是
     * 最新一次请求**时才作数；崩溃事件前移序号，作废所有在飞结果。
     */
    loadSeq: number
  }

  const books = new WeakMap<BrowserWindow, AppWindowBookkeeping>()

  /**
   * 一个 URL 是否是**本安装的应用文档**（`<scheme>://…`）。
   *
   * 用途只有一个：区分"应用真的加载好了"与"我们自己塞进去的失败页也加载完了"——
   * 后者是 `data:` 文档，绝不能把 `crashed` 抹回 false。
   * @param rawUrl - `webContents.getURL()` 的取值。
   * @returns 是否是应用文档 URL。
   */
  const isAppDocumentUrl = (rawUrl: unknown): rawUrl is string => {
    if (typeof rawUrl !== 'string' || rawUrl === '') return false
    try {
      return new URL(rawUrl).protocol === `${appScheme}:`
    } catch {
      return false
    }
  }

  /**
   * 解析应用窗口要落地的 session（**分区必填**）。
   *
   * 为什么在这里 fail-loud：Electron 把空/缺失的 `partition` 当"用默认 session"，
   * 于是"忘记传分区"这种缺陷的表现是**窗口照常打开**（只是跑在默认 session 上），
   * 离线单测与真机都看不出来 —— 这正是 2026-09-20 审计的 P1-2。宁可在建窗时抛。
   * @param partition - 插件按当前用户算出的分区名（`persist:...`）。
   * @returns 该分区的 Electron session。
   * @throws 当分区是空串/非字符串时。
   */
  const sessionForPartition = (partition: string): ElectronSession => {
    if (typeof partition !== 'string' || partition === '') {
      throw new Error('createRealElectronWindowAdapter: an explicit session partition is required for an application window')
    }
    return session.fromPartition(partition)
  }

  /**
   * 被后续导航顶掉的加载（`ERR_ABORTED`）不是故障。
   *
   * 真实序列：`createAppWindow` 发起的 `loadURL('/')` 还没完成，第二次 `open`（聚焦到
   * `/notes`）就把它顶掉 —— 第一次加载的 promise 以 `ERR_ABORTED (-3)` reject。把它当
   * "加载失败"记进日志会让诊断包出现一条永远存在的假故障（真机实测踩到）。
   * @param cause - `loadURL` 的 rejection。
   * @returns 是否是"被顶掉"。
   */
  const supersededLoad = (cause: unknown): boolean => {
    if (typeof cause !== 'object' || cause === null) return false
    const record = cause as { code?: unknown, errno?: unknown, message?: unknown }
    if (record.code === 'ERR_ABORTED' || record.errno === -3) return true
    return typeof record.message === 'string' && record.message.includes('ERR_ABORTED')
  }

  /** 统一的加载失败出口（被顶掉的不记）。 */
  const reportLoadFailure = (url: string, cause: unknown): void => {
    if (supersededLoad(cause)) return
    warn(`pico-wasm-apps-host: loading ${url} in the application window failed (${cause instanceof Error ? cause.message : String(cause)})`)
  }

  const windowOf = (handle: AppWindowHandle): BrowserWindow | undefined =>
    (typeof handle === 'object' && handle !== null) ? handles.get(handle) : undefined

  /** 记录一个句柄并返回它（句柄就是 `BrowserWindow` 本身）。 */
  const remember = (win: BrowserWindow): AppWindowHandle => {
    handles.set(win, win)
    return win
  }

  /**
   * 在一个应用窗口里加载**应用 URL**（建窗与聚焦导航的唯一入口）。
   *
   * 加载结果同时决定健康状态（R16B-19）：成功 ⇒ `loaded()`（窗口真的好了）、失败 ⇒
   * `fail()`（进恢复路径）。**失败页不经过这里** —— 它由恢复状态机直接
   * `win.loadURL('data:text/html…')`，因此既不改 `desiredUrl`、也不算"应用加载成功"。
   * @param win - 原生窗口。
   * @param url - 应用 URL。
   * @returns 加载完成（失败已内部消化，调用方 `void` 掉即可）。
   */
  const loadAppUrl = async (win: BrowserWindow, url: string): Promise<void> => {
    const book = books.get(win)
    if (book === undefined) {
      try {
        await win.loadURL(url)
      } catch (cause) {
        reportLoadFailure(url, cause)
      }
      return
    }
    book.desiredUrl = url
    book.loadSeq += 1
    const seq = book.loadSeq
    try {
      await win.loadURL(url)
      // 只有"仍是最新一次请求"的加载成功才算窗口好了（见 `loadSeq` 的注释）。
      if (book.loadSeq === seq) book.recovery.loaded()
    } catch (cause) {
      if (supersededLoad(cause)) return
      reportLoadFailure(url, cause)
      // 事件源之一：`loadURL` 的 rejection 比 `did-fail-load` 更早、也更可靠地
      // 覆盖"平台不可达"这类失败（两者都到达时由状态机的单飞合并）。
      if (book.loadSeq === seq) void book.recovery.fail({ kind: 'did-fail-load', reason: cause instanceof Error ? cause.message : String(cause) })
    }
  }

  /**
   * 建窗时挂上**故障 / 销毁 / 健康**三类原生订阅（R16B-19 / R16B-20）。
   *
   * 这是本模块与 `windows.ts` 之间唯一的生命周期缝：宿主（窗口管理器）订阅的是
   * "这个窗口坏了/没了"，而不是自己去轮询 `isAlive()` —— 后者只在被问到时才发现，
   * 于是用户自己关掉的窗口会以幽灵 surface 的形式继续留在模型面上。
   * @param win - 刚建好的原生窗口。
   * @param appId - 应用 id（诊断文案用）。
   * @returns 该窗口的记账对象。
   */
  const watchAppWindow = (win: BrowserWindow, appId: string): AppWindowBookkeeping => {
    const book: AppWindowBookkeeping = {
      desiredUrl: '',
      health: new Set(),
      closed: new Set(),
      loadSeq: 0,
      // 先占位、马上覆盖：`createAppWindowRecovery` 的 `onCrashStateChange` 需要
      // 引用 `book`，而 `book` 又需要 recovery —— 用两层赋值打破这个环。
      recovery: undefined as unknown as AppWindowRecovery,
    }
    books.set(win, book)
    book.recovery = createAppWindowRecovery({
      host: {
        isDestroyed: () => win.isDestroyed(),
        currentUrl: () => {
          if (win.isDestroyed()) return ''
          const current = win.webContents.getURL()
          // 当前文档是失败页（`data:`）时回落到"最近一次请求的应用 URL"。
          return isAppDocumentUrl(current) ? current : book.desiredUrl
        },
        load: async (url) => { await win.loadURL(url) },
      },
      copy: () => appWindowFailureCopy(locale()),
      warn,
      onCrashStateChange: (crashed) => {
        for (const listener of book.health) listener({ crashed })
      },
    })

    // 故障源 1：渲染进程消失（崩溃/OOM/被杀）。`clean-exit`/`killed` 是正常收尾，
    // 不是故障 —— 把它们也当崩溃会让"关闭窗口时进程正常退出"弹出一张失败页。
    win.webContents.on('render-process-gone', (_event, details) => {
      const reason = typeof details?.reason === 'string' ? details.reason : 'unknown'
      warn(`pico-wasm-apps-host: the renderer process of an application window is gone (app=${appId}, reason=${reason}, exitCode=${String(details?.exitCode ?? '')})`)
      if (reason === 'clean-exit' || reason === 'killed') return
      // 崩溃前发出的那次加载即使"成功"也不能算窗口好了（见 `loadSeq`）。
      book.loadSeq += 1
      void book.recovery.fail({ kind: 'render-process-gone', reason })
    })

    // 故障源 2：顶层文档加载失败。
    //
    // 第 5 参 `isMainFrame` 才是"顶层文档"的判据（Electron 的签名是
    // `(event, errorCode, errorDescription, validatedURL, isMainFrame, …)`）。子框架
    // 失败**只记一行**：应用页里一个 `<iframe>` 挂掉就重载整窗（第二次再换成失败页）
    // 会把用户的草稿与视图状态掀掉 —— shell 窗口那边为同一件事写过长注释（B-01）。
    // 防御性判空（只认严格 `true`）：旧/新 Electron 少给参数时宁可少一次自动恢复。
    //
    // `errorCode === -3`（ERR_ABORTED）是"被后续导航顶掉"，不是故障。
    win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      const target = typeof validatedURL === 'string' ? validatedURL : ''
      if (isMainFrame !== true) {
        warn(`pico-wasm-apps-host: a subframe failed to load in an application window (${String(errorCode)}: ${String(errorDescription)}) ${target}`)
        return
      }
      if (errorCode === -3) return
      warn(`pico-wasm-apps-host: the main frame of an application window failed to load (${String(errorCode)}: ${String(errorDescription)}) ${target}`)
      // 同上：这次失败作废所有在飞的加载结果（否则"导航失败但上一次加载成功"
      // 的结算顺序会把状态抹回健康）。
      book.loadSeq += 1
      void book.recovery.fail({ kind: 'did-fail-load', reason: `${String(errorCode)}: ${String(errorDescription)}` })
    })

    // 恢复的唯一判据："**应用文档**加载完成"。失败页自己也是 `did-finish-load`，
    // 但它是 `data:` 文档 ⇒ 不算（否则失败页一渲染出来就把 crashed 抹成 false，
    // 模型会以为窗口恢复了）。用户点失败页上的「重试」成功时走的就是这一条。
    win.webContents.on('did-finish-load', () => {
      if (win.isDestroyed()) return
      if (isAppDocumentUrl(win.webContents.getURL())) book.recovery.loaded()
    })

    // R16B-20：用户点窗口自己的关闭按钮 ⇒ Electron 销毁窗口并派发 `closed`；
    // 宿主此前收不到任何回调（只能靠 `isAlive()` 被动发现）。
    win.on('closed', () => {
      for (const listener of book.closed) listener()
    })
    return book
  }

  return {
    createAppWindow(geometry) {
      // 分区先解析（非法值在这里就抛，不建窗）：窗口必须落在**插件指定的按用户分区**
      // 上，既与内置浏览器共用 cookie/存储，又不再与主窗口共享默认 session。
      const target = sessionForPartition(geometry.partition)
      const win = new BrowserWindow({
        width: geometry.width,
        height: geometry.height,
        x: geometry.x,
        y: geometry.y,
        minWidth: geometry.minimumWidth,
        minHeight: geometry.minimumHeight,
        title: geometry.title,
        // 先开窗（骨架屏），内容随后加载：§19 Q12 的"先开窗再加载"以窗口可见为准。
        show: true,
        backgroundColor: '#ffffff',
        autoHideMenuBar: true,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          // 应用窗口在前台/后台都可能被 AI 操作，别让后台节流冻住它。
          backgroundThrottling: false,
          // §7.2/R2S-8 冻结：应用窗口复用内置浏览器的**按用户分区**（分区名由插件显式
          // 传入，适配器不猜用户）。协议 handler / 权限守卫 / 请求闸门都注册在同一个
          // session 上（插件侧 `ensurePartition`），三处对上才不会出现
          // `ERR_UNKNOWN_URL_SCHEME` 或"守卫装在一个没人用的 session 上"。
          partition: geometry.partition,
          // 兜底：session 与 webPreferences 必须指向同一个分区（`session.fromPartition`
          // 是幂等的，这里只是把"两者同源"写成断言，防将来有人只改一处）。
          session: target,
        },
      })
      win.setMenuBarVisibility(false)
      // 标题恒为宿主给的 `<应用名> · <产品名>`：应用 HTML 的 `<title>` 不得改写它
      // （否则应用可以伪装成"设置""登录"等宿主界面）。
      win.on('page-title-updated', (event) => { event.preventDefault() })
      // 订阅必须在**第一次加载之前**挂好：崩溃可以发生在首帧（正是"首次加载失败"）。
      watchAppWindow(win, geometry.appId)
      const handle = remember(win)
      void loadAppUrl(win, geometry.url)
      win.focus()
      return handle
    },
    focusAppWindow(handle, url) {
      const win = windowOf(handle)
      if (win === undefined || win.isDestroyed()) return
      const current = win.webContents.getURL()
      if (current !== url) {
        void loadAppUrl(win, url)
      }
      // 最小化/隐藏状态下"聚焦"必须先把窗口带回来，否则用户点了打开却什么都没发生。
      if (win.isMinimized()) win.restore()
      if (!win.isVisible()) win.show()
      win.focus()
    },
    onAppWindowHealth(handle, listener) {
      const win = windowOf(handle)
      if (win === undefined) return
      const book = books.get(win)
      if (book === undefined) return
      book.health.add(listener)
      // 订阅即回报当前状态：崩溃可以发生在宿主订阅之前（建窗与订阅不是同一个调用），
      // 只报"变化"会让那一次崩溃永久不可见。
      listener({ crashed: book.recovery.crashed() })
    },
    onAppWindowClosed(handle, listener) {
      const win = windowOf(handle)
      if (win === undefined) return
      const book = books.get(win)
      if (book === undefined) return
      book.closed.add(listener)
      // 已经销毁的窗口（订阅晚于关窗）必须**立刻**回报，否则宿主要等到下一次
      // `isAlive()` 才发现 —— 那正是"幽灵 surface"的窗口期。
      if (win.isDestroyed()) listener()
    },
    closeAppWindow(handle) {
      const win = windowOf(handle)
      if (win === undefined || win.isDestroyed()) return
      win.close()
    },
    setAspectRatio(handle, ratio, extraSize) {
      const win = windowOf(handle)
      if (win === undefined || win.isDestroyed()) return
      win.setAspectRatio(ratio, extraSize)
    },
    installAppWindowGuards(handle, appId) {
      const win = windowOf(handle)
      if (win === undefined || win.isDestroyed()) return
      const contents = win.webContents
      /**
       * 导航闸门（**三处事件共用这一份判据**）：顶层与子框架都过
       * {@link classifyAppWindowNavigation}。
       * @param event - Electron 事件（`preventDefault` 即取消该次导航）。
       * @param url - 目标 URL。
       * @param isMainFrame - 是否顶层文档。
       */
      const refuse = (event: { preventDefault: () => void }, url: unknown, isMainFrame: boolean): void => {
        const verdict = classifyAppWindowNavigation(url, appId, appScheme, isMainFrame)
        if (verdict.verdict === 'allow') return
        event.preventDefault()
        warn(`pico-wasm-apps-host: refused a ${verdict.reason} navigation in an application window (app=${appId})`)
      }
      contents.on('will-navigate', (details) => { refuse(details, details.url, details.isMainFrame !== false) })
      contents.on('will-frame-navigate', (details) => {
        refuse(details, details.url, details.isMainFrame !== false)
      })
      // **重定向也要过同一道闸门**（2026-09-20 审计 P1-1）：`will-navigate` 只覆盖
      // 发起方直接发起的导航，302/303/307 是**服务端**发起的第二次导航 —— 只挂前两个
      // 钩子时，一次 302 就能把窗口换到外站或**另一个应用**的 origin（换壳）。时序上
      // `will-redirect` 在 `will-navigate` 之后、导航真正发生之前触发，
      // `preventDefault()` 取消的是整个导航（窗口留在原页面）。子框架的重定向同样
      // 走这里（`details.isMainFrame` 为假时按子框架规则判）。
      contents.on('will-redirect', (details) => { refuse(details, details.url, details.isMainFrame !== false) })
      contents.setWindowOpenHandler(() => {
        // §20.2：应用窗口不得弹窗（外链改走内置浏览器新标签 + 提示条，§19 Q9）。
        warn(`pico-wasm-apps-host: refused a window.open from an application window (app=${appId})`)
        return { action: 'deny' }
      })
    },
    ensureSessionGuard(partition) {
      // 幂等（browser 包按 session 记）；这里再要求一次是**显式**保证：应用窗口可以
      // 在一张浏览器标签都没开过时创建（深链、应用中心直达）。
      //
      // 装的是**应用窗口真正落地的那个分区**（不是默认 session）：默认 session 上
      // 主窗口装着剪贴板白名单（desktop `electron-runtime.ts`），而 Electron 的
      // `setPermissionRequestHandler` 是 last-wins —— 装错 session 会一边保护不到应用
      // 窗口，一边静默废掉主窗口的剪贴板（2026-09-20 审计点名的无判据耦合）。
      ensureSessionGuard(sessionForPartition(partition) as unknown as NativeGuardSession)
    },
    webContentsId(handle) {
      const win = windowOf(handle)
      if (win === undefined || win.isDestroyed()) return undefined
      return win.webContents.id
    },
    webContents(handle) {
      // surface 注册用（§16.1）：把**真实** webContents 交给 browser runtime 的 CDP
      // 附着路径。它是唯一能让 `browser_*` 工具真正驱动应用窗口的句柄 —— 只传 id
      // 是驱动不了的（CdpSession 要的是 webContents.debugger）。
      const win = windowOf(handle)
      if (win === undefined || win.isDestroyed()) return undefined
      return win.webContents
    },
    isAlive(handle) {
      const win = windowOf(handle)
      return win !== undefined && !win.isDestroyed()
    },
    workArea() {
      // 每次打开重新求值（多显示器）：鼠标所在显示器的工作区，取不到时回落主显示器。
      const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
      return { x: area.x, y: area.y, width: area.width, height: area.height }
    },
  }
}
