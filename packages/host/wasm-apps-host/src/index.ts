/**
 * 客户端专属 WASM 应用 origin（`<app-scheme>://<app_id>/`）的宿主插件。
 *
 * 契约：`docs/planning/2026-09-19-wasm-client-only-design.md`（§5/§7/§16.1/§20/§21/§22）。
 * 本插件只拥有**传输与生命周期**：把应用页发出的每个请求转成平台 JSON 信封、带员工
 * 令牌与 `X-Pico-App-Proof` POST 到 `/api/client/v2/apps/wasm/:app_id/request`、再把
 * 响应还原成 `Response`；准入/静态/执行/计量全部在服务端 `serveApp`，这里**不复制
 * 任何业务逻辑**。
 *
 * 本文件不 import electron（可单测、可在纯 Node 的 profile 冒烟里加载）：协议注册、
 * 分区注册与窗口创建经适配器注入（`wasmAppsHostAdapter`）。协议特权注册
 * （`app.whenReady()` 之前）由桌面壳显式调用新包导出的
 * `registerAppScheme(appOriginScheme)`（scheme 来自渠道包，见 `src/main.ts`）。
 *
 * 本机路由（**全部经 {@link createHostRequestSurface} 这一个 seam**，§22.2 R1/R2）：
 *   GET  /api/pico/wasm-apps/host-proof  引导：签发本机持有性令牌
 *   POST /api/pico/wasm-apps/open        {app_id, path?} -> {window, app_id, url}
 *   GET  /api/pico/wasm-apps/channel     {appOriginScheme, deepLinkScheme, productName}
 * 除引导外都要求请求头 `X-Pico-Host-Proof`（不用 Cookie/Host/Origin/端口）。
 *
 * @module @picoaide/dsh-wasm-apps-host
 */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { DEFAULT_APP_SCHEME, appOrigin, appSchemePrefix, isValidAppId } from './app-protocol.ts'
import { AI_CHAT_PATH, handleAiChat, type AiChatAuthorization, type AiChatTurnRunner } from './ai-chat.ts'
import { createAppProofProvider, type InstallKeyStore } from './app-proof.ts'
import { WasmAppsCache, type CacheScope } from './cache.ts'
import { createAppOpenGate } from './open-gate.ts'
import { createDeepLinkQueue, sanitizeAppPath } from './deep-link-queue.ts'
import { parseAppDeepLink, parseForeignAppDeepLink } from './deep-link.ts'
import type { AppSchemeRequestHandler, WasmAppsHostAdapter, WasmAppsWindowAdapter } from './electron-adapter.ts'
import { createAppSchemeHandler } from './handler.ts'
import { createHostRequestSurface, type SurfaceReply } from './host-request.ts'
import { hostCopy, hostLocaleFrom, type HostLocale } from './locale.ts'
import { browserPartitionFor } from './partition.ts'
import { readAppSession, subscribePicoSession, type PicoSessionLike } from './session.ts'
import { createWasmAppsWindows, type WorkArea } from './windows.ts'

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'pico-wasm-apps-host'

/**
 * 本插件需要的服务：员工会话（enterprise 提供）与本机 webServer（本机路由）。
 *
 * 适配器**不进 inject**：它是桌面壳 `provide` 进来的普通值，且允许缺席（纯 Node
 * 宿主/单测）—— 缺席时协议注册是 no-op 并记一条 warn，本机路由 fail-closed。
 */
export const inject = ['picoSession', 'webServer']

/** 桌面壳 `provide` 适配器用的服务名。 */
export const WASM_APPS_HOST_ADAPTER_SERVICE = 'wasmAppsHostAdapter'

/** 桌面壳 `provide` 窗口适配器用的服务名（窗口载体，§16.1）。 */
export const WASM_APPS_WINDOW_ADAPTER_SERVICE = 'wasmAppsWindowAdapter'

/** 桌面壳 `provide` 安装密钥仓库用的服务名（`safeStorage`，§23.1）。 */
export const WASM_APPS_INSTALL_KEY_SERVICE = 'wasmAppsInstallKeyStore'

/** 桌面壳 `provide` 应用 AI loop 用的服务名（§21.2；缺席 ⇒ `app_ai_unavailable`）。 */
export const WASM_APPS_AI_RUNNER_SERVICE = 'wasmAppsAiRunner'

/** 桌面壳 `provide` AI 授权记录用的服务名（§21.1 Q9）。 */
export const WASM_APPS_AI_AUTHORIZATION_SERVICE = 'wasmAppsAiAuthorization'

/**
 * 本机应用面路由前缀（**唯一入口**）：写面（打开）与只读面（渠道 scheme、本机证明
 * 引导）都挂在这一个前缀下，seam 内按 pathname + method 分发。
 */
export const WASM_APPS_LOCAL_PREFIX = '/api/pico/wasm-apps'

/** 本机"打开应用"路由（**冻结路径**；契约 §5.2）。 */
export const WASM_APP_OPEN_ROUTE = `${WASM_APPS_LOCAL_PREFIX}/open`

/** 本机只读路由：渲染进程需要的渠道信息（§16.1 冻结；CHN-4/R2I-15）。 */
export const WASM_APP_CHANNEL_ROUTE = `${WASM_APPS_LOCAL_PREFIX}/channel`

/** 打开一个应用时在宿主内部广播的事件（客户端面据此给反馈/开面板）。 */
export const WASM_APP_OPEN_EVENT = 'pico/wasm-app-open'

/**
 * **异渠道**应用深链事件（接缝 J13，事件名逐字冻结）：链接形状是应用深链、app_id 合法，
 * 但 scheme 不是本安装注入的那个 ⇒ 那是另一家企业/渠道的客户端链接。
 *
 * 为什么必须**广播**而不是静默丢弃：两端各自只测自己那一半时，"宿主不发/客户端不听"
 * 谁都不会红（本仓历史上 5 个 P0 的同一失效模式）。客户端面收到后弹一次性 toast
 * （§19 Q5 的冻结文案由客户端包持有）。
 */
export const WASM_APP_DEEP_LINK_FOREIGN_EVENT = 'pico/wasm-app-deep-link-foreign'

/** 本机路由请求体上限（只有一个 app_id + path，不需要更多）。 */
const OPEN_REQUEST_BODY_MAX_BYTES = 64 * 1024

/** 插件配置（组装期注入；见 desktop `src/profile.ts` 的 channelProfilePatches）。 */
export interface Config {
  /**
   * 本安装的应用源 scheme（渠道包 `desktop.app_origin_scheme`）。
   *
   * 由桌面壳注入，**不在这里写死**（§7.8）；缺席时用官方缺省
   * {@link DEFAULT_APP_SCHEME} —— 官方构建本来就是这个值，渠道构建缺注入等于
   * 注入链断裂（CI 硬校验会先拦住）。
   */
  appOriginScheme?: string
  /**
   * 本安装的深链 scheme（渠道包 `desktop.deep_link_scheme`）。
   *
   * 缺席时深链一律丢弃（fail-closed，并记一条 warn）—— 猜 scheme 等于接受别的
   * 安装的链接。
   */
  deepLinkScheme?: string
  /** 产品名（窗口标题 `<应用名> · <产品名>`，§7.2 防伪装）。 */
  productName?: string
  /**
   * 覆盖内置浏览器分区名（缺省按登录用户推导，见 `src/partition.ts`）。
   *
   * 只在部署侧真的改了分区命名时使用；平时留空。
   */
  partition?: string
  /** 单次应用请求的出站预算（毫秒）；缺省 {@link APP_REQUEST_TIMEOUT_MS}。 */
  requestTimeoutMs?: number
  /** 窗口状态文件所在目录（缺省不从 Electron 取：由桌面壳注入 `<userData>`）。 */
  userDataDir?: string
}

export const Config: z<Config> = z.object({
  appOriginScheme: z.string(),
  deepLinkScheme: z.string(),
  productName: z.string(),
  partition: z.string(),
  requestTimeoutMs: z.number(),
  userDataDir: z.string(),
})

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * 一个应用需要被打开（深链或本机路由触发）。
     *
     * 载荷是**内部 URL**（`<scheme>://<app_id>/`）：消费者（客户端面的入口提示）
     * 可直接用它做展示或对账。
     */
    'pico/wasm-app-open'(request: { app_id: string, url: string }): void
    /**
     * 收到**另一家企业/渠道**客户端的应用深链（接缝 J13）。
     * 客户端面据此弹一次性提示；载荷只用于诊断，不用于拼接任何 URL。
     */
    'pico/wasm-app-deep-link-foreign'(request: { app_id: string, scheme: string }): void
  }
}

/** 打开请求的载荷。 */
export interface WasmAppOpenRequest {
  app_id: string
  url: string
}

/**
 * 应用内部 URL 的构造（**唯一实现**）。
 * @param appScheme - 渠道注入的应用源 scheme。
 * @param appId - 已校验的 app_id。
 * @param path - 已净化的相对路径（缺省 `/`）。
 * @returns `<scheme>://<app_id><path>`。
 */
export function wasmAppUrl(appScheme: string, appId: string, path = '/'): string {
  return `${appOrigin(appScheme, appId)}${path}`
}

/** 读一个 JSON 响应体。 */
function json(reply: SurfaceReply, status: number, body: Record<string, unknown>): void {
  reply.header('content-type', 'application/json; charset=utf-8')
  reply.send(status, body)
}

/** 解析请求体（空体当 `{}`；畸形当 undefined）。 */
function parseJsonBody(body: Uint8Array): unknown {
  if (body.byteLength === 0) return {}
  try {
    return JSON.parse(Buffer.from(body).toString('utf8'))
  } catch {
    return undefined
  }
}

/**
 * 注册协议 origin 插件。
 * @param ctx - Cordis 上下文（注入 `picoSession` 与 `webServer`）。
 * @param config - scheme / 产品名 / 分区覆盖 / 出站预算。
 */
export function apply(ctx: Context, config: Config = {}): void {
  const warn = (message: string): void => { ctx.logger?.warn?.(message) }
  const service = (): PicoSessionLike | undefined => ctx.get('picoSession') as PicoSessionLike | undefined
  const currentSession = (): ReturnType<typeof readAppSession> => readAppSession(service())
  /**
   * 宿主语言**按调用**解析（`desktopRuntime.locale` → `Accept-Language` → zh）：
   * 语言可以在运行中改变，禁止模块级冻结（本仓已记录两次同 bug）。
   */
  const hostLocale = (acceptLanguage?: string | null): HostLocale =>
    hostLocaleFrom(ctx.get('desktopRuntime') as { readonly locale?: unknown } | undefined, acceptLanguage)

  /** 应用源 scheme：渠道注入，官方缺省（§7.8 不得在包里写死渠道值）。 */
  const appScheme = config.appOriginScheme !== undefined && config.appOriginScheme !== ''
    ? config.appOriginScheme
    : DEFAULT_APP_SCHEME
  const productName = config.productName !== undefined && config.productName !== ''
    ? config.productName
    : 'PicoAide Harness'
  const deepLinkScheme = config.deepLinkScheme

  const adapter = ctx.get(WASM_APPS_HOST_ADAPTER_SERVICE) as WasmAppsHostAdapter | undefined
  const fetchImpl = adapter?.fetch ?? ((url: string, init: RequestInit) => fetch(url, init))

  // ---- 客户端持有性证明（§20.1/§23.1）：惰性签发，只在内存 ----
  const installKeyStore = ctx.get(WASM_APPS_INSTALL_KEY_SERVICE) as InstallKeyStore | undefined
  const appProof = installKeyStore === undefined
    ? undefined
    : createAppProofProvider({
      store: installKeyStore,
      fetch: fetchImpl,
      session: () => {
        const session = currentSession()
        return session === null ? null : { token: session.token, serverURL: session.serverURL }
      },
      warn,
    })

  // ---- 打开校验（F16/§5.1b）：每次打开先问平台一次；版本变化 ⇒ 清该应用缓存 ----
  const openGate = createAppOpenGate({
    session: () => {
      const session = currentSession()
      return session === null ? null : { token: session.token, serverURL: session.serverURL }
    },
    fetch: fetchImpl,
    ...(appProof === undefined ? {} : { appProof }),
    ...(config.requestTimeoutMs === undefined ? {} : { timeoutMs: config.requestTimeoutMs }),
    warn,
  })
  const cache = config.userDataDir === undefined
    ? undefined
    : new WasmAppsCache({ root: `${config.userDataDir}/wasm-apps-cache`, warn })
  /**
   * 本会话内各应用的已知版本（缓存键的一部分；登录/切账号即作废）。
   *
   * 首次打开某应用时给空串 ⇒ 平台回 `changed=true` ⇒ 清一次缓存（正确：新会话本就
   * 不该复用上一个会话的内容，缓存路径里也有 session-scope，这里是双保险）。
   */
  const knownVersions = new Map<string, string>()
  /** 平台给的应用名（窗口标题 `<应用名> · <产品名>`，§7.2 防伪装）。 */
  const knownTitles = new Map<string, string>()
  /**
   * 会话作用域（§7.5 R1-SEC-3）：服务端地址哈希 + 用户名哈希。
   *
   * 哈希口径与 `cache.ts` 一致（sha256 前 16 字节 hex）——两边各一份实现会让
   * "同一个 scope 在两个模块里算出不同值"，那是缓存永不复用/永不清理的经典 bug。
   */
  const sessionScope = (): CacheScope | undefined => {
    const session = currentSession()
    if (session === null) return undefined
    const hash = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32)
    return { serverHash: hash(session.serverURL), userHash: hash(session.username ?? '') }
  }

  // ---- 应用 AI 桥（§21）：本地处理，绝不转发平台 ----
  const aiRunner = ctx.get(WASM_APPS_AI_RUNNER_SERVICE) as AiChatTurnRunner | undefined
  const aiAuthorization = ctx.get(WASM_APPS_AI_AUTHORIZATION_SERVICE) as AiChatAuthorization | undefined
  const aiChat = aiRunner === undefined || aiAuthorization === undefined
    ? undefined
    : async (appId: string, body: Uint8Array, signal: AbortSignal) =>
      await handleAiChat(
        {
          authorization: aiAuthorization,
          runner: aiRunner,
          userId: () => currentSession()?.username ?? null,
          warn,
        },
        appId,
        body,
        signal,
      )

  const handler = createAppSchemeHandler({
    appOriginScheme: appScheme,
    session: currentSession,
    fetch: fetchImpl,
    clearSession: () => {
      try {
        service()?.clear?.()
      } catch (cause) {
        warn(`pico-wasm-apps-host: clearing the session failed (${cause instanceof Error ? cause.message : String(cause)})`)
      }
    },
    hostLocale,
    ...(config.requestTimeoutMs === undefined ? {} : { timeoutMs: config.requestTimeoutMs }),
    ...(appProof === undefined ? {} : { appProof }),
    ...(aiChat === undefined ? {} : { aiChat }),
    warn,
  })

  // ---- 协议 handler 注册：默认 session + 每个用户分区（§2、§6 W2） ----
  const registeredPartitions = new Set<string>()
  let defaultRegistered = false
  /**
   * 只有应用窗口能发起应用 scheme 请求（§23.2 N6）：判据来自窗口管理器维护的
   * webContents 白名单；窗口管理器缺席（纯 Node 宿主）⇒ 一律 false（fail-closed）。
   */
  const isAppSurfaceWebContents = (webContentsId: number | undefined): boolean =>
    windows?.isAppSurfaceWebContents(webContentsId) ?? false

  const registerDefault = (): boolean => {
    if (adapter === undefined || defaultRegistered) return defaultRegistered
    try {
      adapter.handleAppScheme(appScheme, handler as AppSchemeRequestHandler)
      // 权限守卫 + 请求闸门与协议 handler **同批**（§16.1：不能出现"注册了 handler
      // 却没装闸门"的缝）：默认 session 也要装，深链/应用中心可以在浏览器窗口
      // 从未创建时就打开应用。
      adapter.ensureSessionGuard?.()
      adapter.installAppSchemeRequestGate?.(appScheme, isAppSurfaceWebContents)
      defaultRegistered = true
    } catch (cause) {
      warn(`pico-wasm-apps-host: registering the app protocol on the default session failed (${cause instanceof Error ? cause.message : String(cause)})`)
    }
    return defaultRegistered
  }
  /**
   * 确保某个分区也注册了协议 handler（**分区跟随**：内置浏览器的分区按用户切换，
   * 新分区没有 handler 时应用页面只会得到 `ERR_UNKNOWN_URL_SCHEME` 空白页）。
   * @param partition - Electron session 分区名。
   */
  const ensurePartition = (partition: string): boolean => {
    if (adapter === undefined) return false
    if (registeredPartitions.has(partition)) return true
    try {
      adapter.handleInSession(appScheme, partition, handler as AppSchemeRequestHandler)
      adapter.ensureSessionGuard?.(partition)
      adapter.installAppSchemeRequestGate?.(appScheme, isAppSurfaceWebContents, partition)
      registeredPartitions.add(partition)
      return true
    } catch (cause) {
      warn(`pico-wasm-apps-host: registering the app protocol on partition ${JSON.stringify(partition)} failed (${cause instanceof Error ? cause.message : String(cause)})`)
      return false
    }
  }
  const partitionFor = (username: string | null | undefined): string =>
    config.partition !== undefined && config.partition !== ''
      ? config.partition
      : browserPartitionFor(username)

  if (adapter === undefined) {
    warn('pico-wasm-apps-host: no Electron adapter was provided; the application protocol stays unregistered')
  } else {
    registerDefault()
  }
  /** 当前会话对应的分区（+ 匿名分区：未登录时内置浏览器用的是那一个）。 */
  const syncPartitions = (): void => {
    const session = currentSession()
    ensurePartition(partitionFor(session?.username ?? null))
    if (session === null) ensurePartition(partitionFor(null))
  }
  syncPartitions()

  // ---- 窗口载体（§16.1：独立窗口 + surface；单应用单窗口、尺寸记忆、比例锁定） ----
  const windowAdapter = ctx.get(WASM_APPS_WINDOW_ADAPTER_SERVICE) as WasmAppsWindowAdapter | undefined
  const windows = windowAdapter === undefined || config.userDataDir === undefined
    ? undefined
    : createWasmAppsWindows({
      adapter: windowAdapter,
      appScheme,
      productName,
      userDataDir: config.userDataDir,
      urlFor: (appId, path) => wasmAppUrl(appScheme, appId, path),
      titleFor: (appId) => knownTitles.get(appId),
      workArea: () => (
        (ctx.get(WASM_APPS_WINDOW_ADAPTER_SERVICE) as { workArea?: () => WorkArea } | undefined)?.workArea?.()
        ?? { x: 0, y: 0, width: 1280, height: 800 }
      ),
      warn,
    })

  // ---- 深链队列（§7.6：≤8 条 / TTL 5 min / 未登录入队，登录后按序消费） ----
  const pendingLinks = createDeepLinkQueue({ warn })

  /** 未登录 ⇒ 入队；已登录 ⇒ 立刻打开。返回是否已打开。 */
  const requestOpen = async (appId: string, path: string): Promise<'opened' | 'queued' | 'unavailable'> => {
    const session = currentSession()
    if (session === null) {
      pendingLinks.enqueue(appId, path)
      return 'queued'
    }
    if (windows === undefined) {
      // 没有窗口载体（纯 Node 宿主/单测）：保留事件出口，让客户端面自行处理。
      if (!registerDefault()) return 'unavailable'
      syncPartitions()
      ctx.emit(WASM_APP_OPEN_EVENT, { app_id: appId, url: wasmAppUrl(appScheme, appId, path) })
      return 'opened'
    }
    const result = await windows.open(appId, path)
    ctx.emit(WASM_APP_OPEN_EVENT, { app_id: appId, url: result.url })
    return 'opened'
  }

  /** 登录成功后按 FIFO 消费待打开队列（一条失败不阻塞后面的）。 */
  const drainPendingLinks = (): void => {
    if (currentSession() === null) return
    for (;;) {
      const next = pendingLinks.shift()
      if (next === undefined) return
      void requestOpen(next.appId, next.path).catch((cause: unknown) => {
        warn(`pico-wasm-apps-host: opening a queued app link failed (${cause instanceof Error ? cause.message : String(cause)})`)
      })
    }
  }

  // ---- 深链：<渠道 scheme>://app/<app_id>[?path=]（严格校验，未知一律丢弃） ----
  if (deepLinkScheme === undefined || deepLinkScheme === '') {
    warn('pico-wasm-apps-host: no deep-link scheme was injected; app deep links will be ignored')
  }
  ctx.on('pico/deep-link', (url: unknown) => {
    if (typeof url !== 'string') return
    if (deepLinkScheme === undefined || deepLinkScheme === '') return
    const link = parseAppDeepLink(url, deepLinkScheme, appScheme)
    if (link === null) {
      // 形状是应用深链、但 scheme 不是我们注入的那个 ⇒ **异渠道链接**：给用户可读提示
      // （J13），而不是让"点了没反应"。跨渠道深链不工作属预期（§5.3）。
      const foreign = parseForeignAppDeepLink(url)
      if (foreign !== null && foreign.scheme !== deepLinkScheme.toLowerCase()) {
        warn(`pico-wasm-apps-host: a deep link for another channel's client was received (scheme mismatch)`)
        ctx.emit(WASM_APP_DEEP_LINK_FOREIGN_EVENT, { app_id: foreign.appId, scheme: foreign.scheme })
        return
      }
      // 未知 host 或畸形路径：丢弃，**不回落**任何默认动作。
      warn(`pico-wasm-apps-host: ignored a deep link that is not an app link (${url.slice(0, 200)})`)
      return
    }
    // §23.2 N8：深链同样过闸门（未登录 ⇒ 入队，登录后消费）。
    void requestOpen(link.appId, link.path).catch((cause: unknown) => {
      warn(`pico-wasm-apps-host: opening a deep link failed (${cause instanceof Error ? cause.message : String(cause)})`)
    })
  })

  // ---- 会话跟随：分区随用户切换；登录后消费待打开队列 ----
  ctx.effect(() => subscribePicoSession(ctx, service, () => {
    syncPartitions()
    drainPendingLinks()
    if (currentSession() === null) {
      // 登出/切账号：上一个用户的待打开目标不得在新用户下打开（§7.2 同精神）。
      pendingLinks.clear()
      appProof?.invalidate()
      void windows?.closeAll()
    }
  }), 'pico wasm apps host: partition follow')

  // ---- 本机请求面（唯一 seam；§22.2 R1/R2） ----
  ctx.effect(() => {
    const surface = createHostRequestSurface(ctx, {
      prefix: WASM_APPS_LOCAL_PREFIX,
      bodyLimit: OPEN_REQUEST_BODY_MAX_BYTES,
      warn,
      routes: [
        {
          method: 'POST',
          path: WASM_APP_OPEN_ROUTE,
          proof: 'required',
          handler: async (req, reply) => {
            const locale = hostLocale(req.headers['accept-language'])
            const session = currentSession()
            if (session === null) {
              json(reply, 401, {
                error: { code: 'AUTH_REQUIRED', message: hostCopy(locale, '未登录', 'not logged in') },
              })
              return
            }
            const parsed = parseJsonBody(req.body)
            const appId = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
              ? (parsed as Record<string, unknown>).app_id
              : undefined
            const rawPath = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
              ? (parsed as Record<string, unknown>).path
              : undefined
            if (typeof appId !== 'string' || !isValidAppId(appId.trim())) {
              json(reply, 400, {
                error: {
                  code: 'VALIDATION',
                  message: hostCopy(locale, 'app_id 不合法', 'app_id is invalid'),
                  hints: ['app_id 由小写字母/数字/单个连字符组成（例如 my-notes）'],
                },
              })
              return
            }
            const target = appId.trim()
            if (windows === undefined && !registerDefault()) {
              json(reply, 503, {
                error: {
                  code: 'PROTOCOL_UNAVAILABLE',
                  message: hostCopy(locale, '应用协议未就绪', 'the app protocol is not available'),
                  hints: ['客户端未以 Electron 宿主启动（缺少协议/窗口适配器）'],
                },
              })
              return
            }
            syncPartitions()
            const path = sanitizeAppPath(rawPath)
            // F16 硬/软闸门：新窗口 = 硬（拿不到版本就不打开）；聚焦已有窗口 = 软
            // （保留内容 + 提示，不把正常应用打成错误页）。§5.1b 冻结。
            const alreadyOpen = windows?.has(target) === true
            const gate = await openGate.check(target, knownVersions.get(target) ?? '')
            if (gate.kind === 'denied') {
              json(reply, gate.status === 401 ? 401 : gate.status, {
                error: { code: gate.code, message: hostCopy(locale, '平台拒绝了这次打开。', 'The platform refused this open request.') },
              })
              return
            }
            if (gate.kind === 'unreachable' && !alreadyOpen) {
              json(reply, 502, {
                error: {
                  code: 'OPEN_CHECK_FAILED',
                  message: hostCopy(locale, '无法确认应用版本，请稍后重试。', 'The app version could not be confirmed; please retry.'),
                  hints: hostCopy(locale, ['检查客户端与服务端的连接后重试。'], ['Check the client-to-server connection and retry.']),
                },
              })
              return
            }
            let warning: string | undefined
            if (gate.kind === 'ok') {
              if (gate.changed) {
                const scope = sessionScope()
                if (scope !== undefined) await cache?.clearApp(scope, target)
                knownVersions.set(target, gate.version)
              }
              if (gate.title !== undefined) knownTitles.set(target, gate.title)
            } else if (gate.kind === 'unreachable') {
              // 软闸门：聚焦已有窗口时保留内容，只回一条提示（客户端渲染横幅）。
              warning = 'version-unverified'
            }
            const outcome = await requestOpen(target, path)
            if (outcome === 'unavailable') {
              json(reply, 503, { error: { code: 'PROTOCOL_UNAVAILABLE', message: hostCopy(locale, '应用协议未就绪', 'the app protocol is not available') } })
              return
            }
            const url = wasmAppUrl(appScheme, target, path)
            if (outcome === 'queued') {
              // 未登录不会走到这里（上面已 401）；留一条兜底，防止将来改闸门时静默。
              json(reply, 200, { window: 'queued', app_id: target, url })
              return
            }
            // J7b：`opens`（当日 PV/UV，含本次）**原样透传** —— 不做字段投影、不补
            // 默认值；缺省时字段整个不出现，客户端据此**不渲染**该行（不当成 0）。
            const opens = gate.kind === 'ok' ? gate.opens : undefined
            json(reply, 200, {
              window: windows?.has(target) === true ? 'focused' : 'opened',
              app_id: target,
              url,
              ...(opens === undefined ? {} : { opens }),
              ...(warning === undefined ? {} : { warning }),
            })
          },
        },
        {
          method: 'GET',
          path: WASM_APP_CHANNEL_ROUTE,
          proof: 'required',
          handler: (_req, reply) => {
            // 渲染进程需要的渠道信息（§16.1）：客户端半边**不得**读随包 channel.json
            // （tsdown 内联后路径不成立），只能经这一条只读路由拿。
            // 未注入 scheme ⇒ fail-closed 503：让客户端自己猜 scheme 等于把渠道隔离
            // 交给渲染层，那是错的（§16.1「未拿到 ⇒ 分享入口不渲染」）。
            const scheme = config.appOriginScheme
            if (scheme === undefined || scheme === '') {
              json(reply, 503, { error: 'app origin scheme is not configured' })
              return
            }
            json(reply, 200, {
              appOriginScheme: scheme,
              deepLinkScheme: deepLinkScheme ?? '',
              productName,
            })
          },
        },
      ],
    })
    return () => { surface.dispose() }
  }, 'pico wasm apps host: local request surface')
}

/** 应用源 scheme 前缀（导出给跨包对拍用例：渲染层拼接分享链接时必须用它）。 */
export { appSchemePrefix }

/** AI 桥保留路径（导出给跨包对拍：客户端/作者文档与协议 handler 必须用同一个值）。 */
export { AI_CHAT_PATH }
