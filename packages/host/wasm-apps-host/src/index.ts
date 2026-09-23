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
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { BROWSER_SURFACE_SERVICE } from '@picoaide/dsh-browser/surface'
import { DEFAULT_APP_SCHEME, appOrigin, appSchemePrefix, isValidAppId } from './app-protocol.ts'
import { AI_CHAT_PATH, handleAiChat, type AiChatAuthorization, type AiChatTurnRunner } from './ai-chat.ts'
import { AI_CONSENT_FILE_NAME, createAiChatAuthorization } from './ai-authorization.ts'
import { createAppProofProvider, type InstallKeyStore } from './app-proof.ts'
import { frozenAppHint, frozenAppTitle } from './app-window-copy.ts'
import { WasmAppsCache, type CacheScope } from './cache.ts'
import { createAppOpenGate, type AppOpenCounts, type AppOpenOutcome } from './open-gate.ts'
import { createDeepLinkQueue, sanitizeAppPath } from './deep-link-queue.ts'
import { parseAppDeepLink, parseForeignAppDeepLink } from './deep-link.ts'
import type { AppSchemeRequestHandler, WasmAppsHostAdapter, WasmAppsWindowAdapter } from './electron-adapter.ts'
import { createAppSchemeHandler } from './handler.ts'
import { createHostRequestSurface, type SurfaceReply } from './host-request.ts'
import { hostCopy, hostLocaleFrom, type HostLocale } from './locale.ts'
import { browserPartitionFor, serverPartitionHash } from './partition.ts'
import { readAppSession, subscribePicoSession, type PicoSessionLike } from './session.ts'
import { createWindowCatalog } from './window-catalog.ts'
import {
  createWasmAppsWindows,
  parseDeclaredWindowGeometry,
  type AppSurfaceRegistrar,
  type DeclaredWindowGeometry,
} from './windows.ts'

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

/**
 * 本机写路由：应用 AI 的**首次授权**记录（§21.1 Q9 的"允许"与"撤销"）。
 *
 * 为什么必须有一条宿主路由：授权闸门在宿主（`ai-chat.ts` 的 `AiChatAuthorization`），
 * 而渲染层的"允许/撤销"只写 `localStorage` —— 两边不连通就等于"勾了允许但每次仍然
 * 403"。这条路由是两端唯一的连接点（证明头闸门与 `open` 同一条）。
 */
export const WASM_APP_AI_CONSENT_ROUTE = `${WASM_APPS_LOCAL_PREFIX}/ai/consent`

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

/**
 * 本机路由错误信封里"**平台**拒绝了这次调用"的码前缀（**跨端契约**；客户端按它把
 * "哪一层拒的"分流，见 `packages/client/wasm-apps/src/client/host-proof.ts`）。
 *
 * 为什么必须加前缀：平台的证明码与**本机证明闸**的码字面相同（都是
 * `proof_required` / `proof_expired`），而两者该给用户的下一步完全不同 ——
 * 本机码 = "客户端本机服务的凭据没通过"（重取令牌/重启客户端），平台码 =
 * "服务端拒绝了这次打开"（升级/联系管理员）。原样透传时客户端只能二选一：
 * 2026-09-20 的真实故障里它选了本机那一支，把一次**平台**拒绝显示成
 * 「本页面无法证明自己属于这个客户端窗口（因此没有发出任何请求）」—— 请求其实
 * 发出去了，界面却说没发，维护者与用户都被指错了方向。
 *
 * 信封里同时保留**原码**（`platform_code`），诊断不受前缀影响。
 */
export const PLATFORM_REFUSAL_CODE_PREFIX = 'PLATFORM_'

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
   * 窗口几何的目录兜底来源（F3/§6；见 `window-catalog.ts`）。
   *
   * 只在"本机打开路由的请求体没带 `window`"且"要新建窗口"时才发一次请求（每个会话
   * 只拉一次目录）。客户端把目录行里的 `window` 放进请求体之后，这条路径自然不再触发。
   */
  const windowCatalog = createWindowCatalog({
    session: () => {
      const session = currentSession()
      return session === null ? null : { token: session.token, serverURL: session.serverURL }
    },
    fetch: fetchImpl,
    ...(config.requestTimeoutMs === undefined ? {} : { timeoutMs: config.requestTimeoutMs }),
    warn,
  })
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
  /**
   * 会话**作用域键**（2026-09-23 审计 WS-1）：服务端地址 + 用户名。
   *
   * 为什么不是"是否登录"：登出会走到 `currentSession() === null`，而**直接换账号**
   * （A→B，不经过登出）两边都非 null —— 旧实现在那种情况下什么都不做，于是 B 聚焦并
   * 继续使用 A 分区里的窗口。分区是 `persist:` 的、且 Electron 的 session 在
   * webContents 创建后**不能改指**，所以这不是"下次打开时再判"能补救的事。
   */
  const scopeKey = (): string | null => {
    const session = currentSession()
    return session === null ? null : `${session.serverURL}\u0000${session.username ?? ''}`
  }

  // ---- 应用 AI 桥（§21）：本地处理，绝不转发平台 ----
  const aiRunner = ctx.get(WASM_APPS_AI_RUNNER_SERVICE) as AiChatTurnRunner | undefined
  /**
   * 授权记录：桌面壳可以 `provide` 自己的一份（多进程/多账户形态），否则本插件用
   * `userDataDir` 下的私有文件（0600，原子写）。
   *
   * 为什么默认由本插件持有：授权是**闸门**的一部分，而闸门在本模块（`handleAiChat`）。
   * 闸门依赖一个"别人碰巧 provide 了才有"的服务 ⇒ 未接线时每一次调用都 403/503，
   * 而客户端会把 403 读成"用户拒绝了"（错误的分层）。文件路径缺席（纯 Node 宿主/
   * 单测）时退化为内存记录：仍然 fail-closed，且**不假装**记得住。
   */
  const providedAuthorization = ctx.get(WASM_APPS_AI_AUTHORIZATION_SERVICE) as AiChatAuthorization | undefined
  const aiAuthorization = providedAuthorization ?? createAiChatAuthorization({
    ...(config.userDataDir === undefined ? {} : { file: join(config.userDataDir, AI_CONSENT_FILE_NAME) }),
    warn,
  })
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
    // ---- F11 内容缓存（§7.5）：读/写半环的**唯一**接线点 ----
    //
    // 此前只接了"失效"半环（`clearApp`），`get`/`put`/`conditional` 在 `cache.ts`
    // 之外**零调用点** ⇒ 28 条缓存用例全绿而 F11 零效果（2026-09-21 审计 P0-3）。
    // 三处判据（能不能缓存 / 版本 / 会话作用域）都在 `handler.ts` 里按**每次请求**
    // 求值：作用域随登录变化、版本随平台响应头变化，任何一个在构造期冻结都会让
    // 缓存永不命中或跨租户命中。
    ...(cache === undefined ? {} : { cache }),
    cacheScope: sessionScope,
    cacheVersion: (appId: string) => knownVersions.get(appId),
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
  const partitionFor = (session: ReturnType<typeof readAppSession>): string =>
    config.partition !== undefined && config.partition !== ''
      ? config.partition
      // §7.2/R2S-8 冻结（2026-09-21 审计 P1-10 证据②补齐）：分区名必须含**服务端地址
      // 哈希**（`persist:agent-browser-<user>@<hash>`）。分区是 `persist:` 的，同机切
      // 服务端（测试/正式并存是真实拓扑）时新旧租户会共用同一个分区 —— 同名应用 origin
      // 的 localStorage/IndexedDB 于是跨租户串味。未登录（anonymous）不带哈希。
      : browserPartitionFor(session?.username ?? null, serverPartitionHash(session?.serverURL ?? null))
  /**
   * 当前登录用户对应的应用窗口分区（**唯一实现**）。
   *
   * 同一个值有三个消费者，必须是同一份：①协议 handler 注册（`ensurePartition`）；
   * ②权限守卫（`ensureSessionGuard`）；③建窗（`createAppWindow`）。任何一处用了别的
   * 值，表现都是"窗口开了但页面空白"或"守卫装在一个没人用的 session 上"。
   */
  const currentPartition = (): string => partitionFor(currentSession())

  if (adapter === undefined) {
    warn('pico-wasm-apps-host: no Electron adapter was provided; the application protocol stays unregistered')
  } else {
    registerDefault()
  }
  /** 当前会话对应的分区（未登录 ⇒ 匿名分区，与内置浏览器的启动分区逐字相同）。 */
  const syncPartitions = (): void => {
    ensurePartition(partitionFor(currentSession()))
  }
  syncPartitions()

  // ---- 窗口载体（§16.1：独立窗口 + surface；单应用单窗口、尺寸记忆、比例锁定） ----
  const windowAdapter = ctx.get(WASM_APPS_WINDOW_ADAPTER_SERVICE) as WasmAppsWindowAdapter | undefined
  /**
   * browser runtime 的应用窗口 surface 注册表（§16.1，`kind:'app'`）。
   *
   * 取值方式是 `inject`（不是 `ctx.get`）：`browserSurface` 由 `@picoaide/dsh-browser`
   * **provide**，而 profile 里 browser 行在本插件**之后**加载 —— 用 `ctx.get` 会永久拿到
   * `undefined`（这正是"`registerApp` 零生产调用点"的结构性原因之一）。`inject` 的回调
   * 在服务出现时执行；回调里补注册已经开着的窗口（深链可以在那之前就把窗口开出来）。
   *
   * 不用 `export const inject = [..., 'browserSurface']`：那会让本插件在没有 browser 的
   * 宿主（纯 Node 冒烟、单测）里**整行加载不了** —— 而应用窗口本身不依赖 surface。
   */
  let browserSurfaces: AppSurfaceRegistrar | undefined
  const windows = windowAdapter === undefined || config.userDataDir === undefined
    ? undefined
    : createWasmAppsWindows({
      adapter: windowAdapter,
      appScheme,
      productName,
      userDataDir: config.userDataDir,
      // §7.2/R2S-8：应用窗口复用内置浏览器的**按用户分区**。分区在**每次 open** 时按
      // 当前会话求值（登录态会变），由本插件显式传给适配器 —— 原生面不猜用户。
      partition: currentPartition,
      urlFor: (appId, path) => wasmAppUrl(appScheme, appId, path),
      titleFor: (appId) => knownTitles.get(appId),
      // thunk：注册表可能晚到（见上面的注释）。
      surfaces: () => browserSurfaces,
      workArea: () => windowAdapter.workArea?.() ?? { x: 0, y: 0, width: 1280, height: 800 },
      warn,
    })
  ctx.inject(['browserSurface'], (surfaceCtx) => {
    const registry = surfaceCtx.get(BROWSER_SURFACE_SERVICE) as AppSurfaceRegistrar | undefined
    if (registry === undefined) return
    browserSurfaces = registry
    // 注册表晚到时把**已经开着**的应用窗口补注册进去（深链/本机路由可能早于它）。
    windows?.registerOpenWindows()
  })

  // ---- 深链队列（§7.6：≤8 条 / TTL 5 min / 未登录入队，登录后按序消费） ----
  const pendingLinks = createDeepLinkQueue({ warn })

  /** {@link requestOpen} 的结论（`refused` 带闸门结论供本机路由渲染错误信封）。 */
  type OpenRequestOutcome =
    | {
      kind: 'opened' | 'focused'
      url: string
      warning?: 'version-unverified'
      /** 平台给的当日 PV/UV（J7b：缺省即不出现，绝不补 0）。 */
      opens?: AppOpenCounts
    }
    | { kind: 'queued' }
    | { kind: 'unavailable' }
    | { kind: 'refused'; gate: Extract<AppOpenOutcome, { kind: 'denied' } | { kind: 'unreachable' }> }

  /**
   * 打开一个应用的**唯一入口**：本机打开路由 / 深链 / 登录后队列消费三条路径都走它。
   *
   * 未登录 ⇒ 入队（登录后消费时再过闸门）；已登录 ⇒ **先过 F16 打开闸门**，再建窗/聚焦。
   *
   * 为什么闸门必须在这一层（R4-B-16，审计 2026-09-23）：`openGate.check` 此前只有本机
   * 路由调，深链与队列消费完全绕过它 ⇒ ① 拿不到 `changed`，不清该应用在本 session-scope
   * 下的版本缓存，而 `handler.ts` 会把宿主的旧版本写进 `X-PicoAide-App-Version` **覆盖
   * 平台下发的版本头**；② 不产生打开计数（PV/UV 偏低）；③ 404/410 的生命周期反应（关窗 +
   * 清缓存）与"版本无法确认则不打开"的硬闸门都不执行。冻结设计 §5.1b 明写「每次「打开」
   * 动作调一次；**深链打开同样调用**」，因此判据只能是"这一层调了"，不是"路由里调了"。
   *
   * 返回值带上窗口管理器的结论（`opened` = 新建，`focused` = 聚焦已有）—— §5.2 的
   * `window` 字段是客户端"已打开/已聚焦"反馈的唯一来源，**不能**在路由里按
   * `windows.has(appId)` 重新推导：新建完成后它当然是 `true`，于是每次都说"已聚焦"
   * （真实窗口适配器下的必然结果，纯 Node 宿主反而看不出来）。
   * @param appId - 已校验的 app_id。
   * @param path - 已净化的相对路径。
   * @param geometry - 作者声明的窗口几何（F3）；传 `undefined` = "还没问过"，本函数会
   *   在**新建窗口**时去目录兜底取一次；传 `null` = "确定没有声明"（不再兜底）。
   * @param catalogWarm - 本机路由已并发发起的目录兜底查询（省一次串行 RTT）。
   * @returns 打开结论；`refused` 带上闸门结论，供本机路由渲染错误信封。
   */
  const requestOpen = async (
    appId: string,
    path: string,
    geometry?: DeclaredWindowGeometry | null,
    catalogWarm?: Promise<DeclaredWindowGeometry | undefined> | undefined,
  ): Promise<OpenRequestOutcome> => {
    const session = currentSession()
    if (session === null) {
      pendingLinks.enqueue(appId, path)
      return { kind: 'queued' }
    }
    const alreadyOpen = windows?.has(appId) === true
    // F16 硬/软闸门：新窗口 = 硬（拿不到版本就不打开）；聚焦已有窗口 = 软
    //（保留内容 + 提示，不把正常应用打成错误页）。§5.1b 冻结。
    const gate = await openGate.check(appId, knownVersions.get(appId) ?? '')
    if (gate.kind === 'denied') {
      // 生命周期反应（§7.2 / §16.1「触发源 = open 端点响应」；R2-L2-2）：
      // 平台说这个应用**没了**（404 未登记/软删/无可用版本，410 = 已下架）⇒
      // 关掉还开着的窗口并丢掉缓存。触发点只能是这里（服务端不会主动推），
      // 且只有"没了"才关：401/403（未登录/白名单）是**可恢复**的拒绝，关窗
      // 会把一次登录过期变成"应用被卸载"。
      //
      // **冻结是例外，且必须按 `details.reason` 判**（P2-3，主控 2026-09-20）：
      // 冻结是**只读快照**（数据保留，§19 Q3），平台为了不泄露存在性把它与
      // 软删/未登记放在**同一个 404 + `NOT_FOUND`** 里，唯一区分凭据是
      // `reason`。只看 status 会把"被管理员停用"做成"应用消失"：关窗 + 清
      // 缓存 + 回一个不可辨的码，`frozenAppTitle` 的可辨文案永远不可达。
      const frozen = gate.reason === 'app_frozen'
      if (!frozen && (gate.status === 404 || gate.status === 410)) {
        const scope = sessionScope()
        if (scope !== undefined) await cache?.clearApp(scope, appId)
        knownVersions.delete(appId)
        knownTitles.delete(appId)
        warn(`pico-wasm-apps-host: the platform reported ${appId} as unavailable (HTTP ${String(gate.status)} ${gate.code}); closing its window and dropping its cache`)
        await windows?.close(appId)
      } else if (frozen) {
        // 窗口与缓存一律保留（只读快照仍是可看的内容）；只记一条诊断。
        warn(`pico-wasm-apps-host: the platform reported ${appId} as frozen (HTTP ${String(gate.status)} ${gate.code}); keeping its window and cache`)
      }
      return { kind: 'refused', gate }
    }
    if (gate.kind === 'unreachable' && !alreadyOpen) {
      // 硬闸门：连平台都问不到版本就不建窗（深链/队列同样不打开，只记一条 warn）。
      warn(`pico-wasm-apps-host: refusing to open ${appId}: the app version could not be confirmed (${gate.detail})`)
      return { kind: 'refused', gate }
    }
    if (gate.kind === 'ok') {
      if (gate.changed) {
        const scope = sessionScope()
        if (scope !== undefined) await cache?.clearApp(scope, appId)
        knownVersions.set(appId, gate.version)
      }
      if (gate.title !== undefined) knownTitles.set(appId, gate.title)
    }
    // 软闸门（`unreachable` + 窗口已开着）在这里继续：内容保留，只回一条提示。
    const warning = gate.kind === 'unreachable' ? 'version-unverified' as const : undefined
    const opens = gate.kind === 'ok' ? gate.opens : undefined
    const extras = { ...(warning === undefined ? {} : { warning }), ...(opens === undefined ? {} : { opens }) }
    if (windows === undefined) {
      // 没有窗口载体（纯 Node 宿主/单测）：保留事件出口，让客户端面自行处理。
      if (!registerDefault()) return { kind: 'unavailable' }
      syncPartitions()
      const url = wasmAppUrl(appScheme, appId, path)
      ctx.emit(WASM_APP_OPEN_EVENT, { app_id: appId, url })
      return { kind: 'opened', url, ...extras }
    }
    // 建窗**之前**确保当前用户的分区已注册（协议 handler + 权限守卫 + 请求闸门）：
    // 应用窗口就落在这个 session 上，注册晚于建窗会让首次加载撞
    // `ERR_UNKNOWN_SCHEME`（空白窗口）。幂等，正常路径下这里是 no-op。
    ensurePartition(currentPartition())
    // 作者声明的窗口几何（F3/§6）：**只对新建窗口**求值（聚焦已有窗口用的是记忆尺寸）。
    // 三态语义（与路由的 `declared` 逐字对齐）：显式几何 ⇒ 用它；`undefined`（"还没问过"）
    // 或 `null`（"请求体没带"）⇒ 新建窗口时问一次目录兜底（每个 session 只发一次请求）。
    const declared = geometry === undefined || geometry === null
      ? (alreadyOpen ? null : await (catalogWarm ?? windowCatalog.lookup(appId)) ?? null)
      : geometry
    const result = await windows.open(appId, path, declared)
    ctx.emit(WASM_APP_OPEN_EVENT, { app_id: appId, url: result.url })
    return { kind: result.window, url: result.url, ...extras }
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
  //
  // §7.2 冻结：登出 / **切账号** / 切渠道 ⇒ 关闭全部应用窗口并清空映射。
  // 2026-09-23 审计 WS-1：判据必须是"**作用域**变了"而不是"变成未登录" ——
  // `enterprise/src/auth-gate.ts` 的 `/login` 允许同一服务端直接换账号（`setSession`
  // 不经 `clear` ⇒ 事件载荷非 null），旧实现的 `currentSession() === null` 分支走不到，
  // 于是：探针 probe-a-user-switch.mjs 实测 A→B 后 `closeAppWindow` 调用 0 次，B
  // `open()` 命中 A 的窗口走 `focusAppWindow`，B 就落在 **A 的分区**上（那份 jar 里是
  // A 在该应用里的 cookie/localStorage/IndexedDB）。
  let lastScope = scopeKey()
  ctx.effect(() => subscribePicoSession(ctx, service, () => {
    syncPartitions()
    // 目录兜底按（服务端 + 令牌）缓存：会话一变就必须作废（切租户不得复用上一台的目录）。
    windowCatalog.invalidate()
    const scope = scopeKey()
    if (scope !== lastScope) {
      const previous = lastScope
      lastScope = scope
      // 窗口是**作用域资产**：webContents 与它的 session 分区创建即固定，留在映射里
      // 等于"新用户继续用上一个用户的身份"。关掉（`closeAll` 同时注销 surface 与
      // webContents 映射）之后，下一次 open 才会按当前分区新建。
      void windows?.closeAll()
      appProof?.invalidate()
      // 会话作用域内的目录缓存（版本/应用名）同样作废：它们是上一个账号的可见信息。
      knownVersions.clear()
      knownTitles.clear()
      // 下面两件只在**离开一个已登录作用域**时做（登出/切账号）：待打开队列里的目标
      // 属于上一个用户；落盘内容也不该留着（`cache.ts` 的路径里另有 session-scope
      // 双保险）。未登录→登录 **不清**：§7.6 明确要求"未登录入队、登录后打开"，
      // 清掉等于把用户点过的深链吞了；每次登录都 rm -rf 也会打掉热缓存。
      if (previous !== null) {
        pendingLinks.clear()
        void cache?.clearAll()
      }
    }
    // 消费待打开队列必须放在**拆卸之后**：换号时的 `closeAll` 会把刚按新账号打开的
    // 窗口一起关掉（深链在未登录时入队，登录后应立即打开一次）。
    drainPendingLinks()
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
            // 作者声明的窗口几何（F3/§6）：客户端把**目录行里那份**原样放进请求体
            // （`{window: {ratio?, width?, height?}}`，形状与目录行的 `window` 逐字相同）。
            // 解析失败/缺席一律当"没声明"，绝不让一块畸形几何挡住打开。
            const declared = parseDeclaredWindowGeometry(
              parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
                ? (parsed as Record<string, unknown>).window
                : undefined,
            )
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
            // 目录兜底与本函数内部的打开校验**并发**（两条都是同一台服务端的一次往返；
            // 串行会让首次打开白白多等一个 RTT）。请求体已经带了 `window`、或窗口已开着
            // ⇒ 不查。
            const alreadyOpen = windows?.has(target) === true
            const catalogWarm = declared === null && !alreadyOpen
              ? windowCatalog.lookup(target)
              : undefined
            // F16 闸门、生命周期反应与版本缓存维护都在 requestOpen 里（唯一入口，R4-B-16）。
            const outcome = await requestOpen(target, path, declared, catalogWarm)
            if (outcome.kind === 'refused') {
              const gate = outcome.gate
              if (gate.kind === 'unreachable') {
                json(reply, 502, {
                  error: {
                    code: 'OPEN_CHECK_FAILED',
                    message: hostCopy(locale, '无法确认应用版本，请稍后重试。', 'The app version could not be confirmed; please retry.'),
                    hints: hostCopy(locale, ['检查客户端与服务端的连接后重试。'], ['Check the client-to-server connection and retry.']),
                  },
                })
                return
              }
              // 平台的码一律加前缀（见 PLATFORM_REFUSAL_CODE_PREFIX 的注释）：原样透传会与
              // **本机**证明闸的码撞名，客户端只能误归因。`reason` 是"冻结 vs 不存在"的
              // **唯一**区分凭据（同码同状态）：缺它客户端只能显示笼统的"平台拒绝了这次打开"。
              const frozen = gate.reason === 'app_frozen'
              json(reply, gate.status === 401 ? 401 : gate.status, {
                error: {
                  code: `${PLATFORM_REFUSAL_CODE_PREFIX}${gate.code.toUpperCase()}`,
                  platform_code: gate.code,
                  ...(gate.reason === undefined ? {} : { platform_reason: gate.reason }),
                  message: frozen
                    ? frozenAppTitle(locale)
                    : hostCopy(locale, '平台拒绝了这次打开。', 'The platform refused this open request.'),
                  ...(frozen ? { hints: [frozenAppHint(locale)] } : {}),
                },
              })
              return
            }
            if (outcome.kind === 'unavailable') {
              json(reply, 503, { error: { code: 'PROTOCOL_UNAVAILABLE', message: hostCopy(locale, '应用协议未就绪', 'the app protocol is not available') } })
              return
            }
            const url = wasmAppUrl(appScheme, target, path)
            if (outcome.kind === 'queued') {
              // 未登录不会走到这里（上面已 401）；留一条兜底，防止将来改闸门时静默。
              json(reply, 200, { window: 'queued', app_id: target, url })
              return
            }
            // J7b：`opens`（当日 PV/UV，含本次）**原样透传** —— 不做字段投影、不补
            // 默认值；缺省时字段整个不出现，客户端据此**不渲染**该行（不当成 0）。
            // 闸门结论只在 `requestOpen` 内部可读，所以计数经返回值带出来。
            json(reply, 200, {
              // §5.2：`window` 是**窗口管理器的结论**（新建/聚焦已有），不是在路由里
              // 按"管理器里有没有这个 app"重推 —— 新建成功后它总是 true ⇒ 会说成
              // "已聚焦"（真实适配器下必现）。
              window: outcome.kind,
              app_id: target,
              url,
              ...(outcome.opens === undefined ? {} : { opens: outcome.opens }),
              ...(outcome.warning === undefined ? {} : { warning: outcome.warning }),
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
        {
          method: 'POST',
          path: WASM_APP_AI_CONSENT_ROUTE,
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
            const row = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
              ? parsed as Record<string, unknown>
              : undefined
            const rawAppId = row?.app_id
            if (typeof rawAppId !== 'string' || !isValidAppId(rawAppId.trim())) {
              json(reply, 400, {
                error: {
                  code: 'VALIDATION',
                  message: hostCopy(locale, 'app_id 不合法', 'app_id is invalid'),
                  hints: ['app_id 由小写字母/数字/单个连字符组成（例如 my-notes）'],
                },
              })
              return
            }
            if (typeof row?.granted !== 'boolean') {
              json(reply, 400, {
                error: {
                  code: 'VALIDATION',
                  message: hostCopy(locale, 'granted 必须是布尔值', 'granted must be a boolean'),
                },
              })
              return
            }
            const user = session.username ?? ''
            if (user === '') {
              // 授权维度是 **用户 × 应用**：拿不到用户名时写入一条"谁都不是"的记录
              // 比拒绝更糟（下一次换账号可能撞上它）。fail-closed。
              json(reply, 401, {
                error: { code: 'AUTH_REQUIRED', message: hostCopy(locale, '未登录', 'not logged in') },
              })
              return
            }
            const appId = rawAppId.trim()
            try {
              if (row.granted) await aiAuthorization.grant(user, appId)
              else await aiAuthorization.revoke(user, appId)
            } catch (cause) {
              // 写失败**必须**让用户看到：静默成功会让下一次调用仍然 403（"点了允许
              // 还是不行"），而那看起来像 AI 坏了。
              warn(`pico-wasm-apps-host: persisting the app AI consent failed (${cause instanceof Error ? cause.message : String(cause)})`)
              json(reply, 500, {
                error: {
                  code: 'CONSENT_NOT_PERSISTED',
                  message: hostCopy(locale, '授权未能保存', 'the AI consent could not be saved'),
                },
              })
              return
            }
            json(reply, 200, { app_id: appId, granted: row.granted })
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
