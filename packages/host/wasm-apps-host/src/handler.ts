/**
 * 协议 handler：`picoaide-app://<app_id>/<path>?<query>` → 平台 JSON 信封 →
 * Chromium `Response`（契约 §2 的五步，逐字实现）。
 *
 * 这一层**只做传输与身份注入**：
 *  - 它不判定准入、不读静态、不执行 wasm（那些全在服务端 `appserver.serveApp`）；
 *  - 身份唯一来源是 `ctx.picoSession` 的员工令牌，以 `Authorization: Bearer`
 *    发给平台（**绝不**进信封 —— 信封会交给应用自己的请求管线）；
 *  - 它是本模型的**信任边界**：`Origin` 必须由它合成（§4.3：自定义协议下
 *    浏览器一个 Origin/Referer/Sec-Fetch-* 都不发），因此这里 fail-closed：
 *    畸形 URL / 超限体积 / 非信封响应一律给可读错误，绝不"尽力转发"。
 *
 * 依赖全部注入（`deps.fetch` / `deps.session` / `deps.clearSession`），所以本模块
 * 不 import electron、可在纯 Node 下单测。
 *
 * @module @picoaide/dsh-wasm-apps-host/handler
 */

import {
  APP_METHODS,
  APP_REQUEST_BODY_MAX_BYTES,
  APP_REQUEST_PATH,
  APP_REQUEST_TIMEOUT_MS,
  APP_RESPONSE_BODY_MAX_BYTES,
  appOrigin,
  buildRequestEnvelope,
  decodeBase64Body,
  isHtmlResponse,
  parseAppUrl,
  parseResponseEnvelope,
  responseHeadersOf,
  wantsHtml,
} from './app-protocol.ts'
import {
  frozenAppHint,
  frozenAppTitle,
  missingAppTitle,
  retiredAppTitle,
} from './app-window-copy.ts'
import { hostCopy, type HostLocale } from './locale.ts'
import { AI_CHAT_PATH, AI_CHAT_SSE_HEADERS, type AiChatOutcome } from './ai-chat.ts'
import { APP_PROOF_HEADER } from './app-proof.ts'
import { isReservedHostPath } from './host-request.ts'
import {
  appErrorPage,
  invalidRequestPage,
  readPlatformError,
  sessionExpiredPage,
  signInRequiredPage,
} from './pages.ts'
import type { AppSession } from './session.ts'

/** handler 的注入依赖（全部可替身，便于单测）。 */
export interface AppSchemeHandlerDeps {
  /**
   * 本安装的应用源 scheme（渠道包 `desktop.app_origin_scheme`，组装期注入）。
   *
   * §7.8 冻结：**不在这里写死** `picoaide-app`。它是 Origin 合成与 URL 校验的
   * 唯一依据，也是"别的渠道的链接进不来"的隔离面。
   */
  appOriginScheme: string
  /** 当前员工会话（探测式：缺席/残缺 = 未登录）。 */
  session: () => AppSession | null
  /** 出站 fetch（桌面适配器给 Chromium 栈；单测给假实现）。 */
  fetch: (url: string, init: RequestInit) => Promise<Response>
  /** 平台返回 401 时清掉本地会话（与 enterprise 出站约定一致）。 */
  clearSession: () => void
  /** 宿主语言解析（**按调用**，禁止模块级冻结）。 */
  hostLocale: (acceptLanguage: string | null) => HostLocale
  /**
   * 客户端持有性证明（§20.1/§23.1）：`request` 与 `open` 都必须带
   * `X-Pico-App-Proof`。缺席（异常宿主/单测）⇒ 不带该头，平台会拒（fail-closed）。
   */
  appProof?: { get(force?: boolean): Promise<string | null>, invalidate(): void } | undefined
  /** 应用 AI 桥（§21；本地处理 `/__picoaide/ai/chat`，绝不转发平台）。缺席 ⇒ 503。 */
  aiChat?: ((appId: string, body: Uint8Array, signal: AbortSignal) => Promise<AiChatOutcome>) | undefined
  /** 单次出站预算（毫秒）；缺省 {@link APP_REQUEST_TIMEOUT_MS}。 */
  timeoutMs?: number
  /** 诊断出口（缺省丢弃）。 */
  warn?: (message: string) => void
}

/** 去掉尾斜杠（与 enterprise `normalizeServerURL` 同口径）。 */
function normalizeServerURL(input: string): string {
  let value = input.trim()
  while (value.length > 0 && value.endsWith('/')) value = value.slice(0, -1)
  return value
}

/** HTML 响应（本地页面）。 */
function htmlResponse(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
}

/** JSON 错误响应（应用自己的 fetch 读它；与平台信封同形）。 */
function jsonError(
  status: number,
  code: string,
  message: string,
  hints?: readonly string[],
): Response {
  const error: Record<string, unknown> = { code, message }
  if (hints !== undefined && hints.length > 0) error.hints = [...hints]
  return new Response(JSON.stringify({ error }), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
}

/**
 * 构造协议 handler。
 * @param deps - 会话/出站/语言/诊断。
 * @returns `protocol.handle(APP_SCHEME, handler)` 用的处理函数。
 */
export function createAppSchemeHandler(
  deps: AppSchemeHandlerDeps,
): (request: Request) => Promise<Response> {
  const warn = deps.warn ?? ((): void => {})
  const timeoutMs = deps.timeoutMs ?? APP_REQUEST_TIMEOUT_MS

  /** 本地错误：文档导航给可读 HTML，应用自己的 fetch 给 JSON 信封。 */
  const localError = (
    locale: HostLocale,
    navigation: boolean,
    options: {
      status: number
      code: string
      message: string
      hints?: readonly string[]
      detail?: string
      title?: string
    },
  ): Response => {
    if (!navigation) {
      return jsonError(options.status, options.code, options.message, options.hints)
    }
    return htmlResponse(options.status, appErrorPage(locale, {
      title: options.title ?? hostCopy(locale, '无法打开这个应用', 'This app cannot be opened'),
      message: options.message,
      ...(options.hints === undefined ? {} : { hints: options.hints }),
      ...(options.detail === undefined ? {} : { detail: options.detail }),
    }))
  }

  return async (request: Request): Promise<Response> => {
    const navigation = wantsHtml(request.headers)
    // 语言按**每次调用**解析（宿主语言可以在运行中改变）。
    const locale = deps.hostLocale(request.headers.get('accept-language'))
    const url = parseAppUrl(request.url, deps.appOriginScheme)
    if (url === null) {
      // 只记 pathname（query 可能带应用数据），且截断长度。
      const rawPath = (() => {
        try {
          return new URL(request.url).pathname.slice(0, 200)
        } catch {
          return ''
        }
      })()
      warn(`pico-wasm-apps-host: refused a malformed app URL (${rawPath})`)
      return htmlResponse(400, invalidRequestPage(locale, `url=${rawPath}`))
    }
    const method = request.method.toUpperCase()
    if (!(APP_METHODS as readonly string[]).includes(method)) {
      warn(`pico-wasm-apps-host: refused method ${method} for app ${url.appId}`)
      return localError(locale, navigation, {
        status: 405,
        code: 'METHOD_NOT_ALLOWED',
        message: hostCopy(locale, '不支持这个请求方法。', 'This request method is not supported.'),
        detail: `method=${method}`,
      })
    }
    if (method === 'OPTIONS') {
      // 自定义协议 corsEnabled:false ⇒ 不需要 CORS 预检；给一个明确答复，
      // 免得应用把 405 误读成"网关坏了"。
      return new Response(null, { status: 204, headers: { Allow: APP_METHODS.join(', ') } })
    }
    const session = deps.session()
    if (session === null) {
      // 契约 §2：一律要求登录，没有匿名面。这里给**可读页面**（不是空白页）。
      warn(`pico-wasm-apps-host: refused ${url.appId} without a session`)
      return htmlResponse(401, signInRequiredPage(locale))
    }

    // ---- `__picoaide` 命名空间是**宿主保留面**：只有 AI 桥这一条路径存在 ----
    // §21.2 规则②③（R2-X-3）：其余 `__picoaide/*` 一律 **404**，**绝不**当普通应用
    // 请求转发平台 —— 否则"保留路径"就成了一句空话（转发出去等于把宿主内部命名空间
    // 暴露成应用可探测/可打穿的面，且平台会把它当应用自己的路径处理）。
    //
    // R2-L2-3：**`/__picoaide`（无尾斜杠）也是保留面**。只判 `startsWith('/__picoaide/')`
    // 会把该形态漏进"普通应用请求"分支（转发平台）。判据集中在
    // {@link isReservedHostPath}，与服务端 `reservedPathPrefix` 的口径一致（两端一起改）。
    if (isReservedHostPath(url.path) && url.path !== AI_CHAT_PATH) {
      warn(`pico-wasm-apps-host: refused a reserved host path (${url.path.slice(0, 80)})`)
      return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'no such host bridge' } }), {
        status: 404,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      })
    }

    // ---- 应用 AI 桥（§21.2）：**保留路径，本地处理，绝不转发平台** ----
    if (url.path === AI_CHAT_PATH) {
      if (method !== 'POST') {
        return new Response(JSON.stringify({ error: { code: 'app_ai_invalid', message: 'POST is required for the AI bridge' } }), {
          status: 405,
          headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
        })
      }
      if (deps.aiChat === undefined) {
        return new Response(JSON.stringify({ error: { code: 'app_ai_unavailable', message: 'the application AI bridge is not available in this client' } }), {
          status: 503,
          headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
        })
      }
      let aiBody: Uint8Array
      try {
        aiBody = new Uint8Array(await request.arrayBuffer())
      } catch {
        return new Response(JSON.stringify({ error: { code: 'app_ai_invalid', message: 'the request body is unreadable' } }), {
          status: 400,
          headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
        })
      }
      if (aiBody.byteLength > APP_REQUEST_BODY_MAX_BYTES) {
        return new Response(JSON.stringify({ error: { code: 'app_ai_invalid', message: 'the AI request body is too large' } }), {
          status: 413,
          headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
        })
      }
      // 页面关闭 / 用户取消：把请求自身的 signal 传给 AI 桥（§21.6「页面关闭 ⇒ 该轮
      // 被 cancel，无孤儿循环」）。Electron 的 `Request.signal` 在导航离开/关闭时 abort。
      const outcome = await deps.aiChat(url.appId, aiBody, request.signal)
      return outcomeToResponse(outcome, request.signal)
    }

    // 体积闸门第一档：先看声明值，别把一个 100 MiB 的体读进内存。
    const declared = Number(request.headers.get('content-length') ?? '')
    if (Number.isFinite(declared) && declared > APP_REQUEST_BODY_MAX_BYTES) {
      return htmlResponse(413, invalidRequestPage(locale, `content-length=${String(declared)}`))
    }
    let body: Uint8Array
    try {
      body = new Uint8Array(await request.arrayBuffer())
    } catch (cause) {
      warn(`pico-wasm-apps-host: reading the app request body failed (${cause instanceof Error ? cause.message : String(cause)})`)
      return htmlResponse(400, invalidRequestPage(locale, 'request body unreadable'))
    }
    const built = buildRequestEnvelope({ scheme: deps.appOriginScheme, url, method, headers: request.headers, body })
    if (!built.ok) {
      warn(`pico-wasm-apps-host: refused an oversized app request (${built.reason} ${String(built.actual)} > ${String(built.limit)})`)
      return htmlResponse(413, invalidRequestPage(locale, `${built.reason}: ${String(built.actual)} > ${String(built.limit)}`))
    }

    const endpoint = `${normalizeServerURL(session.serverURL)}${APP_REQUEST_PATH}/${encodeURIComponent(url.appId)}/request`
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    /**
     * 出站预算**不依赖适配器是否尊重 AbortSignal**（Electron `net.fetch` 支持它，
     * 但那是实现细节）：与一个到点即 reject 的 promise 竞速，到点一定返回可读
     * 错误，而不是让应用页面永久转圈。
     */
    const budget = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new Error(`app request budget exceeded (${String(timeoutMs)}ms)`))
      }, timeoutMs)
    })

    /**
     * 一次出站尝试：带 `X-Pico-App-Proof`（§20.1/§23.1：`request` 与 `open` 都带）。
     * @param forceProof - true 时强制重新签发（401 重签一次再重试）。
     * @returns 平台响应。
     */
    const attempt = async (forceProof: boolean): Promise<Response> => {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        // §4.3：Origin 由 handler 合成（信封里的 origin 同源同值）。
        Origin: appOrigin(deps.appOriginScheme, url.appId),
        Authorization: `Bearer ${session.token}`,
      }
      const proof = await deps.appProof?.get(forceProof)
      if (typeof proof === 'string' && proof !== '') headers[APP_PROOF_HEADER] = proof
      const pending = deps.fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(built.envelope),
        signal: controller.signal,
      })
      // 竞速落败的一方（超时后 abort 触发的迟到 rejection）必须被消费掉：宿主把
      // 未处理的 promise rejection 当致命错误（installFailLoud），一次超时不该
      // 让整个应用退出。
      pending.catch(() => {})
      return await Promise.race([pending, budget])
    }

    let upstream: Response
    try {
      upstream = await attempt(false)
      if (upstream.status === 401 && deps.appProof !== undefined) {
        // §20/§23.1 + R2-X-5：**只有 proof 失效**才重签（会话失效的 401 重签毫无意义，
        // 而且会让"会话过期"多绕一次往返才报出来）。判据 = 平台错误码前缀 `proof_`。
        const peek = await upstream.clone().text().catch(() => '')
        const code = readPlatformError((() => {
          try {
            return peek === '' ? undefined : JSON.parse(peek) as unknown
          } catch {
            return undefined
          }
        })())?.code ?? ''
        if (code.startsWith('proof_')) {
          deps.appProof.invalidate()
          upstream = await attempt(true)
        }
      }
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      warn(`pico-wasm-apps-host: gateway request for ${url.appId} failed (${detail})`)
      const timeout = controller.signal.aborted
      return localError(locale, navigation, {
        status: 502,
        code: timeout ? 'GATEWAY_TIMEOUT' : 'GATEWAY_UNAVAILABLE',
        message: hostCopy(
          locale,
          '暂时连不上服务端，请稍后重试。',
          'The server is unreachable right now; please try again later.',
        ),
        hints: hostCopy(
          locale,
          ['确认客户端已连接到公司服务器（可在设置里查看服务端地址）。'],
          ['Check that the client is connected to your company server (see Settings).'],
        ),
        detail,
      })
    } finally {
      clearTimeout(timer)
    }

    const text = await upstream.text().catch(() => '')
    if (upstream.status === 401) {
      // 401 的两种来源必须分开：`proof_*` = 本机 proof 失效（重签已试过一次，仍失败
      // 说明是服务端不认这个安装/绑定），**不能**当成"会话过期"把用户踢下线；
      // 其余 401（`AUTH_REQUIRED`/`AUTH_FAILED`）= 会话失效，按既有约定清会话。
      const body = (() => {
        try {
          return text === '' ? undefined : JSON.parse(text) as unknown
        } catch {
          return undefined
        }
      })()
      const code = readPlatformError(body)?.code ?? ''
      if (code.startsWith('proof_')) {
        warn(`pico-wasm-apps-host: the platform rejected the app proof for ${url.appId} (${code})`)
        return localError(locale, navigation, {
          status: 401,
          code,
          message: hostCopy(locale, '客户端证明无效，请重新登录后再试。', 'This client could not prove it is genuine; please sign in again and retry.'),
          hints: hostCopy(
            locale,
            ['若反复出现，请在客户端重新登录；仍不行请联系管理员。'],
            ['If this keeps happening, sign out and sign in again; contact your administrator if it persists.'],
          ),
          detail: `status=401 code=${code}`,
        })
      }
      // 与 enterprise 出站约定一致：401 清会话（渲染层的 tripwire 会回登录页）。
      deps.clearSession()
      warn(`pico-wasm-apps-host: the platform rejected the session while serving ${url.appId}`)
      return htmlResponse(401, sessionExpiredPage(locale))
    }
    let parsed: unknown
    try {
      parsed = text === '' ? undefined : JSON.parse(text)
    } catch {
      parsed = undefined
    }
    // ① 平台自己的业务错误信封（外层 HTTP 状态 ≥ 400）。
    const platformError = readPlatformError(parsed)
    if (!upstream.ok && platformError !== null) {
      // §19 Q3（R2-X-2）：三档文案**不得塌缩**。平台给 `reason=app_frozen` ⇒ 说"已被
      // 管理员停用"（不是"应用不存在"）；410 = 已下架；404 = 不存在。文案真源在
      // `app-window-copy.ts`（逐字断言在那里）。
      const reason = platformError.reason ?? ''
      const title = reason === 'app_frozen' || platformError.code === 'app_frozen'
        ? frozenAppTitle(locale)
        : upstream.status === 410
          ? retiredAppTitle(locale)
          : upstream.status === 404
            ? missingAppTitle(locale)
            : undefined
      const extraHints = reason === 'app_frozen' ? [frozenAppHint(locale)] : undefined
      return localError(locale, navigation, {
        status: upstream.status,
        code: platformError.code,
        ...(title === undefined ? {} : { title }),
        // 冻结时**不**回显平台的英文/技术 message：可辨文案优先（用户看到的必须是"被停用"）。
        message: title === undefined ? platformError.message : title,
        ...(platformError.hints === undefined && extraHints === undefined
          ? {}
          : { hints: [...(platformError.hints ?? []), ...(extraHints ?? [])] }),
        detail: `status=${String(upstream.status)} code=${platformError.code}${reason === '' ? '' : ` reason=${reason}`}`,
      })
    }
    // ② 响应信封（§4.2）。
    const envelope = parseResponseEnvelope(parsed)
    if (!envelope.ok) {
      warn(`pico-wasm-apps-host: invalid platform response for ${url.appId} (${envelope.reason})`)
      return localError(locale, navigation, {
        status: 502,
        code: 'INVALID_PLATFORM_RESPONSE',
        message: hostCopy(locale, '服务端返回了无法识别的响应。', 'The server returned a response this client cannot read.'),
        hints: hostCopy(
          locale,
          ['客户端与服务端必须同版本升级（旧客户端无法再打开应用）。'],
          ['The client and the server must be upgraded to the same version (older clients can no longer open apps).'],
        ),
        detail: `status=${String(upstream.status)} ${envelope.reason}`,
      })
    }
    if (!upstream.ok) {
      // 外层非 2xx 但体是合法信封：按平台错误呈现（不回给渲染器一个"成功页面"）。
      return localError(locale, navigation, {
        status: upstream.status,
        code: 'PLATFORM_ERROR',
        message: hostCopy(locale, '服务端拒绝了这次请求。', 'The server rejected this request.'),
        detail: `status=${String(upstream.status)}`,
      })
    }
    const bytes = decodeBase64Body(envelope.envelope.body)
    if (bytes === null) {
      warn(`pico-wasm-apps-host: undecodable base64 body for ${url.appId}`)
      return localError(locale, navigation, {
        status: 502,
        code: 'INVALID_PLATFORM_RESPONSE',
        message: hostCopy(locale, '服务端返回了无法识别的响应。', 'The server returned a response this client cannot read.'),
        detail: 'body is not valid base64',
      })
    }
    if (envelope.envelope.truncated) {
      // §5.1 / R2S-10 冻结：兜底截断**不得**当成功交给渲染器 —— 截断的字节不是
      // 应用要的页面（半截 HTML 会渲染成乱码、半截 JSON 会解析失败），按 502/
      // `INVALID_PLATFORM_RESPONSE` 处理并给出可读错误页。
      warn(`pico-wasm-apps-host: the platform truncated the response body for ${url.appId}`)
      return localError(locale, navigation, {
        status: 502,
        code: 'INVALID_PLATFORM_RESPONSE',
        message: hostCopy(locale, '响应体不完整，已中止本次加载。', 'The response was incomplete, so this load was aborted.'),
        hints: hostCopy(
          locale,
          ['这通常是应用返回了过大的内容；请联系应用负责人。'],
          ['This usually means the app returned too much data; please contact the app owner.'],
        ),
        detail: 'truncated=true',
      })
    }
    const headers = responseHeadersOf(envelope.envelope.headers)
    const status = envelope.envelope.status
    let payload = bytes
    // 兜底截断（权威上限在服务端：超限整单失败；这里只保证不会把超过 8 MiB
    // 的字节交给渲染器）。
    if (payload.byteLength > APP_RESPONSE_BODY_MAX_BYTES) {
      warn(`pico-wasm-apps-host: truncating a ${String(payload.byteLength)}-byte response for ${url.appId}`)
      payload = payload.subarray(0, APP_RESPONSE_BODY_MAX_BYTES)
    }
    // ③ 应用自己的错误体 + 文档导航 ⇒ 渲染成可读页面（否则用户看到的是一屏裸 JSON）。
    if (status >= 400 && navigation && !isHtmlResponse(headers)) {
      const inner = readPlatformError(safeJson(payload))
      return htmlResponse(status, appErrorPage(locale, {
        title: hostCopy(locale, '应用返回了错误', 'The app returned an error'),
        message: inner?.message ?? hostCopy(locale, '应用无法处理这次请求。', 'The app could not handle this request.'),
        ...(inner?.hints === undefined ? {} : { hints: inner.hints }),
        detail: `status=${String(status)}${inner === null ? '' : ` code=${inner.code}`}`,
      }))
    }
    const bodyAllowed = method !== 'HEAD' && status !== 204 && status !== 304
    // 拷进一个独立的 ArrayBuffer：`decodeBase64Body` 返回的是 Node Buffer 池上的
    // 视图（`payload.buffer` 比视图大，且类型上是 `ArrayBufferLike`），直接交给
    // `Response` 既会带上别的字节、也过不了 `BodyInit` 的类型面。
    return new Response(bodyAllowed ? new Uint8Array(payload) : null, { status, headers })
  }
}

/** 尽力把字节解析成 JSON（失败给 undefined）。 */
function safeJson(bytes: Uint8Array): unknown {
  if (bytes.byteLength === 0) return undefined
  try {
    return JSON.parse(Buffer.from(bytes).toString('utf8'))
  } catch {
    return undefined
  }
}

/**
 * 把 AI 桥的处理结果变成 `Response`（§21.2：非流式 JSON / 流式 SSE）。
 * @param outcome - 桥的结论。
 * @param signal - 页面请求的取消信号（关闭页面 ⇒ 流自然结束）。
 * @returns Chromium `Response`。
 */
function outcomeToResponse(outcome: AiChatOutcome, signal: AbortSignal): Response {
  if (outcome.kind === 'json') {
    return new Response(JSON.stringify(outcome.body), {
      status: outcome.status,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    })
  }
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const frame of outcome.frames) {
          if (signal.aborted) break
          controller.enqueue(encoder.encode(frame))
        }
      } catch {
        // 帧生成失败：连接已建立，只能结束（错误帧由生成器负责发）。
      } finally {
        try {
          controller.close()
        } catch {
          // 已经关闭（页面在期间离开）：忽略。
        }
      }
    },
  })
  return new Response(stream, { status: 200, headers: { ...AI_CHAT_SSE_HEADERS } })
}
