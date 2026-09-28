/**
 * 应用 AI 的**前端桥**（设计总纲 §21 冻结）。
 *
 * ## 链路（§21.2）
 *
 * ```
 * 应用页 / 应用详情页
 *   fetch('/__picoaide/ai/chat', {method:'POST', body:{messages, stream:true}})
 *         │  保留路径：本机协议 handler **本地**处理，绝不转发平台
 *         ▼
 *   ① 首次授权闸门（用户×服务端×应用；未授权 ⇒ 一次性说明卡；拒绝 ⇒ 403 app_ai_denied）
 *   ② 该账号在该应用上的**隐藏会话**（"app:<app_id>#<账号作用域>"；多轮上下文，
 *      不出现在侧边栏 —— 作用域含账号与服务端，换账号不会续用上一个人的对话）
 *   ③ 仅本次 messages（不注入记忆、不注入用户会话历史、工具集为空）
 *   ④ assistant 增量以 SSE 回给应用页；页面关闭/取消 ⇒ 该轮 cancel
 * ```
 *
 * ## 本模块的边界（客户端半边只做这些）
 *
 *  - **请求校验**：`messages` ≤64 条、单条 ≤16 KiB（超限**不发请求**，本地就拒）；
 *  - **SSE 读法**：`delta` 事件按序回调、`done` 收尾；畸形帧按协议错误报出
 *    （静默丢弃等于把"少了一段回复"说成"回复完了"）；
 *  - **错误分层**：§21.2 的五个信封 code（`app_ai_denied` / `app_ai_unavailable` /
 *    `ai_balance_insufficient` / `ai_rate_limited` / `ai_cancelled`）逐条可辨，
 *    另外两条客户端侧分类（`app_ai_transport` = 请求没到宿主、`app_ai_protocol` =
 *    响应/帧形状不符）用来避免"网络错"与"服务端说不行"混成一件事；
 *  - **首次授权**（§21.1 第 9 条，按 **用户×服务端×应用** 记；与宿主闸门逐段同源）；
 *    撤销入口只有应用详情页的
 *    AI 面板（`AppAiPanel` 的「撤销授权」按钮，宿主写路由 = `/api/pico/wasm-apps/ai/consent`）；
 *  - **取消**（§21.1 第 15 条：仅前台，页面关闭即取消）：调用方用 `AbortSignal`
 *    取消，本模块把它报成 `ai_cancelled`（不是错误弹窗，是"你停了"）。
 *
 * 不做（明确留给别的层）：隐藏会话的创建与元数据、`X-Pico-App-Id` 归因头、工具集为空、
 * 平台网关的计量 —— 那些在宿主的协议 handler 与服务端（§21.2/§21.4）。
 *
 * @module @picoaide/dsh-wasm-apps/client/app-ai
 */

import { fetchWithHostProof } from './host-proof.ts'

/**
 * 本机保留路径（§21.2 冻结：协议 handler 本地处理，绝不转发平台）。
 *
 * 这条路径**不是**平台 URL：它只在本机被消费（所以这里既不带服务端地址，也不带 token）。
 */
export const APP_AI_CHAT_PATH = '/__picoaide/ai/chat'

/** `messages` 条数上限（§21.2 冻结）。 */
export const APP_AI_MESSAGES_MAX = 64

/** 单条消息字节上限（§21.2 冻结：16 KiB）。 */
export const APP_AI_MESSAGE_MAX_BYTES = 16 * 1024

/** 对话角色（§21.2：只传 messages，没有 system/tool 面）。 */
export type AppAiRole = 'user' | 'assistant'

/** 一条对话消息。 */
export interface AppAiMessage {
  role: AppAiRole
  content: string
}

/** §21.2 冻结的五个错误信封 code。 */
export const APP_AI_ERROR_CODES = [
  'app_ai_denied',
  'app_ai_unavailable',
  'ai_balance_insufficient',
  'ai_rate_limited',
  'ai_cancelled',
] as const

/** 冻结的五个 code 之一。 */
export type AppAiErrorCode = (typeof APP_AI_ERROR_CODES)[number]

/**
 * 客户端侧分类（不在冻结的五个里，但必须与它们区分开）。
 *
 *  - `app_ai_transport`：请求根本没到宿主（网络层异常）；
 *  - `app_ai_protocol`：响应/帧形状不是契约承诺的那一个（含 HTTP 层非 2xx 但没有可识别信封）。
 */
export type AppAiFailureCode = AppAiErrorCode | 'app_ai_transport' | 'app_ai_protocol'

/** 失败（`code` 决定 UI 文案与下一步，`message` 是给维护者看的诊断细节）。 */
export interface AppAiFailure {
  code: AppAiFailureCode
  message: string
  /** HTTP 状态；`null` = 请求没到宿主。 */
  status: number | null
}

/** {@link streamAppAiChat} 的结果。 */
export type AppAiResult = { ok: true, content: string } | { ok: false, failure: AppAiFailure }

/** 可注入副作用（测试与真实调用共用同一条实现）。 */
export interface AppAiDeps {
  /** 取数实现（缺省全局 `fetch`）。 */
  fetch: typeof fetch
}

/**
 * 校验将要发出的 `messages`（本地闸门：超限不发请求）。
 *
 * 判据与 §21.2 逐条一致：条数 1–64、角色 ∈ {user, assistant}、内容为字符串且
 * **字节数** ≤16 KiB（按 UTF-8 计 —— 中文一个字 3 字节，按字符数判会放宽三倍）。
 * @param messages - 待发送的消息（不可信输入）。
 * @returns 失败信封；`null` = 可以发送。
 */
export function validateAppAiRequest(messages: unknown): AppAiFailure | null {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { code: 'app_ai_protocol', message: 'messages must be a non-empty array', status: null }
  }
  if (messages.length > APP_AI_MESSAGES_MAX) {
    return { code: 'app_ai_protocol', message: `messages holds at most ${String(APP_AI_MESSAGES_MAX)} entries`, status: null }
  }
  for (const [index, raw] of messages.entries()) {
    if (raw === null || typeof raw !== 'object') {
      return { code: 'app_ai_protocol', message: `messages[${String(index)}] is not an object`, status: null }
    }
    const row = raw as { role?: unknown, content?: unknown }
    if (row.role !== 'user' && row.role !== 'assistant') {
      return { code: 'app_ai_protocol', message: `messages[${String(index)}].role must be "user" or "assistant"`, status: null }
    }
    if (typeof row.content !== 'string') {
      return { code: 'app_ai_protocol', message: `messages[${String(index)}].content must be a string`, status: null }
    }
    const bytes = utf8Length(row.content)
    if (bytes > APP_AI_MESSAGE_MAX_BYTES) {
      return {
        code: 'app_ai_protocol',
        message: `messages[${String(index)}].content is ${String(bytes)} bytes, over the ${String(APP_AI_MESSAGE_MAX_BYTES)}-byte limit`,
        status: null,
      }
    }
  }
  return null
}

/**
 * UTF-8 字节数（不依赖 `TextEncoder` 是否存在：Node 与浏览器都有，但这条判断在纯函数里
 * 被大量调用，手算没有额外分配）。
 * @param text - 文本。
 * @returns 字节数。
 */
function utf8Length(text: string): number {
  let bytes = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code <= 0x7f) bytes += 1
    else if (code <= 0x7ff) bytes += 2
    else if (code <= 0xffff) bytes += 3
    else bytes += 4
  }
  return bytes
}

/** 一个已解析的 SSE 帧。 */
export type AppAiEvent =
  | { type: 'delta', delta: string }
  | { type: 'done' }
  | { type: 'error', failure: AppAiFailure }
  /** 注释/心跳/未知事件：按 SSE 规范忽略（不是错误）。 */
  | { type: 'ignore' }

/**
 * 解析一个 SSE 帧（`event:` + `data:` 行）。
 *
 * `delta` 事件的数据必须是 `{"delta":"…"}`；`error` 事件的数据必须是错误信封
 * （`{"error":{"code","message"}}` 或 `{"code","message"}`）。已知事件的载荷畸形 ⇒
 * `error` 帧（协议错误）——**不**当成"忽略"，否则缺一段回复会被当成正常收尾。
 * @param frame - 帧原文（不含结束的空行）。
 * @returns 解析结果。
 */
export function parseAppAiFrame(frame: string): AppAiEvent {
  let event = 'message'
  const dataLines: string[] = []
  for (const line of frame.split(/\r?\n/u)) {
    if (line === '' || line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /u, '')
    if (field === 'event') event = value
    else if (field === 'data') dataLines.push(value)
  }
  if (dataLines.length === 0) {
    return event === 'done' ? { type: 'done' } : { type: 'ignore' }
  }
  const data = dataLines.join('\n')
  let payload: unknown
  try {
    payload = JSON.parse(data)
  } catch {
    return { type: 'error', failure: { code: 'app_ai_protocol', message: `SSE ${event} frame is not JSON: ${clip(data)}`, status: null } }
  }
  if (event === 'delta') {
    const delta = (payload as { delta?: unknown } | null)?.delta
    if (typeof delta !== 'string') {
      return { type: 'error', failure: { code: 'app_ai_protocol', message: `SSE delta frame has no string delta: ${clip(data)}`, status: null } }
    }
    return { type: 'delta', delta }
  }
  if (event === 'done') return { type: 'done' }
  if (event === 'error') {
    return { type: 'error', failure: failureFromEnvelope(payload, null) }
  }
  return { type: 'ignore' }
}

/**
 * 把服务端错误信封翻译成客户端失败分类（**外层优先**：信封里的 code 说了算，
 * 只有信封不可识别时才按 HTTP 状态就近归属）。
 * @param payload - 响应体 / `error` 帧的载荷。
 * @param status - HTTP 状态（帧内错误为 `null`）。
 * @returns 失败信封。
 */
export function failureFromEnvelope(payload: unknown, status: number | null): AppAiFailure {
  const row = payload === null || typeof payload !== 'object' ? {} : payload as Record<string, unknown>
  const nested = row.error !== null && typeof row.error === 'object' ? row.error as Record<string, unknown> : undefined
  const rawCode = typeof nested?.code === 'string' ? nested.code : (typeof row.code === 'string' ? row.code : '')
  const rawMessage = typeof nested?.message === 'string' ? nested.message : (typeof row.message === 'string' ? row.message : '')
  if ((APP_AI_ERROR_CODES as readonly string[]).includes(rawCode)) {
    return { code: rawCode as AppAiErrorCode, message: rawMessage === '' ? rawCode : rawMessage, status }
  }
  // 信封不可识别：按状态就近归属（只做粗分流，绝不把 5xx 说成"你被拒绝了"）。
  if (status === 403) return { code: 'app_ai_denied', message: rawMessage === '' ? `HTTP 403${rawCode === '' ? '' : ` (${rawCode})`}` : rawMessage, status }
  if (status === 429) return { code: 'ai_rate_limited', message: rawMessage === '' ? 'HTTP 429' : rawMessage, status }
  if (status === 401 || status === 402) {
    return { code: status === 402 ? 'ai_balance_insufficient' : 'app_ai_unavailable', message: rawMessage === '' ? `HTTP ${String(status)}` : rawMessage, status }
  }
  if (status !== null && status >= 500) return { code: 'app_ai_unavailable', message: rawMessage === '' ? `HTTP ${String(status)}` : rawMessage, status }
  return {
    code: 'app_ai_protocol',
    message: rawMessage === '' ? `unrecognized error envelope${status === null ? '' : ` (HTTP ${String(status)})`}: ${clip(JSON.stringify(payload))}` : rawMessage,
    status,
  }
}

/**
 * 截断诊断串（错误信息进 UI 与日志，不能无限长）。
 * @param text - 原文。
 * @returns 截断后的文本。
 */
function clip(text: string): string {
  const MAX = 300
  return text.length <= MAX ? text : `${text.slice(0, MAX)}…(truncated)`
}

/** {@link streamAppAiChat} 的选项。 */
export interface AppAiStreamOptions {
  /** 可注入 fetch（缺省全局 `fetch`）。 */
  deps?: AppAiDeps
  /** 取消信号（页面关闭 / 用户点"取消"）。 */
  signal?: AbortSignal
  /** 每收到一段增量回调一次（参数是增量与累计正文）。 */
  onDelta?: (delta: string, content: string) => void
  /** 是否要求流式（缺省 true；`false` = 非流式，读 `{content}`）。 */
  stream?: boolean
}

/**
 * 发一次应用 AI 对话（流式），把增量按序回调。
 *
 * 失败**永不抛**：每一种失败都是一个带 `code` 的结果。
 * @param messages - 对话消息（会先过 {@link validateAppAiRequest}）。
 * @param options - 依赖 / 取消信号 / 增量回调。
 * @returns 累计正文，或结构化失败。
 */
export async function streamAppAiChat(messages: readonly AppAiMessage[], options: AppAiStreamOptions = {}): Promise<AppAiResult> {
  const invalid = validateAppAiRequest(messages)
  if (invalid !== null) return { ok: false, failure: invalid }

  const deps = options.deps ?? { fetch: (...args: Parameters<typeof fetch>) => fetch(...args) }
  const stream = options.stream !== false
  let response: Response
  try {
    response = await deps.fetch(APP_AI_CHAT_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', accept: stream ? 'text/event-stream' : 'application/json' },
      body: JSON.stringify({ messages, stream }),
      credentials: 'same-origin',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
  } catch (cause) {
    // 取消不是"错误"：页面关闭/用户点取消就走这一支（§21.1 第 15 条）。
    if (isAbort(cause) || options.signal?.aborted === true) {
      return { ok: false, failure: { code: 'ai_cancelled', message: 'the app AI turn was cancelled', status: null } }
    }
    return {
      ok: false,
      failure: { code: 'app_ai_transport', message: `the local app AI bridge is unreachable: ${cause instanceof Error ? cause.message : String(cause)}`, status: null },
    }
  }

  if (!response.ok) {
    let payload: unknown = null
    try {
      const text = await response.text()
      payload = text === '' ? null : JSON.parse(text)
    } catch { payload = null }
    return { ok: false, failure: failureFromEnvelope(payload, response.status) }
  }

  if (!stream) {
    let payload: unknown
    try {
      payload = await response.json()
    } catch (cause) {
      return { ok: false, failure: { code: 'app_ai_protocol', message: `non-stream app AI reply is not JSON: ${cause instanceof Error ? cause.message : String(cause)}`, status: response.status } }
    }
    const content = (payload as { content?: unknown } | null)?.content
    if (typeof content !== 'string') {
      return { ok: false, failure: { code: 'app_ai_protocol', message: `non-stream app AI reply has no string content: ${clip(JSON.stringify(payload))}`, status: response.status } }
    }
    options.onDelta?.(content, content)
    return { ok: true, content }
  }

  const body = response.body
  if (body === null) {
    return { ok: false, failure: { code: 'app_ai_protocol', message: 'the app AI bridge answered text/event-stream without a body', status: response.status } }
  }

  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let done = false
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      // SSE 帧以空行分隔；把**完整**的帧依次消费掉，最后一段留在 buffer 里等下一块。
      for (;;) {
        const boundary = findFrameBoundary(buffer)
        if (boundary === -1) break
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary).replace(/^(\r?\n){1,2}/u, '')
        const event = parseAppAiFrame(frame)
        if (event.type === 'delta') {
          content += event.delta
          options.onDelta?.(event.delta, content)
        } else if (event.type === 'error') {
          return { ok: false, failure: event.failure }
        } else if (event.type === 'done') {
          done = true
        }
      }
      if (done) break
    }
  } catch (cause) {
    if (isAbort(cause) || options.signal?.aborted === true) {
      return { ok: false, failure: { code: 'ai_cancelled', message: 'the app AI turn was cancelled', status: null } }
    }
    return { ok: false, failure: { code: 'app_ai_transport', message: `reading the app AI stream failed: ${cause instanceof Error ? cause.message : String(cause)}`, status: null } }
  } finally {
    // 流被提前结束（done / error / 取消）时释放底层流：否则连接会一直挂着。
    void reader.cancel().catch(() => undefined)
  }

  if (!done) {
    // 没有 done 收尾就结束 = 传输被截断。**不得**当成正常回复（§21.2"以 done 收尾"）。
    return { ok: false, failure: { code: 'app_ai_protocol', message: 'the app AI stream ended without a done event', status: response.status } }
  }
  return { ok: true, content }
}

/**
 * 找到 buffer 里第一个 SSE 帧边界（空行）的位置。
 * @param buffer - 已解码但未消费的文本。
 * @returns 边界起始下标；没有完整帧 ⇒ `-1`。
 */
function findFrameBoundary(buffer: string): number {
  const lf = buffer.indexOf('\n\n')
  const crlf = buffer.indexOf('\r\n\r\n')
  if (lf === -1) return crlf
  if (crlf === -1) return lf
  return Math.min(lf, crlf)
}

/**
 * 异常是不是取消（`AbortError` 在浏览器与 Node 里的形状不同，按名判）。
 * @param cause - 捕获到的异常。
 * @returns true = 取消。
 */
function isAbort(cause: unknown): boolean {
  return cause instanceof Error && (cause.name === 'AbortError' || cause.name === 'TimeoutError')
}

// ---------------------------------------------------------------------------
// 首次授权（§21.1 第 9 条：按 **用户×服务端×应用** 记一次；撤销入口只有应用详情页的 AI 面板）
// ---------------------------------------------------------------------------

/**
 * 授权键前缀（存储里 `…:<user>:<server>:<app>` = `'granted'`）。
 *
 * **v1 → v2**（R21 FIX-7 ①）：v1 的键只有 `(用户, 应用)` 两段，而宿主闸门现在是
 * `(用户, 服务端, 应用)` 三段（`ai-authorization.ts` 的落盘 `version: 2`）。
 * 形状变了就换前缀：老键**永远不可能**被新键命中 —— 与宿主"v1 记录一律判未授权"同向，
 * 绝不把一段没有服务端维度的 UI 记忆读成"已经问过"。
 */
export const APP_AI_CONSENT_PREFIX = 'picoaide.wasm-apps.ai-consent.v2'

/**
 * 本机登录态路由（既有的客户端路由；只读，用来拿授权作用域的两个身份段）。
 *
 * 为什么需要它：§21.1 第 9 条要求授权按 **用户×服务端×应用** 记；客户端半边不持
 * bearer、也没有会话服务可注入，而这条路由返回的是宿主会话快照
 * （`{loggedIn, username, serverURL, …}`，见 `packages/host/enterprise/src/auth-gate.ts`）
 * —— 宿主闸门用的正是**同一份**快照（`wasm-apps-host/src/session.ts` 的
 * `readAppSession` 也读 `getSession()`）。取不到就返回 `null` ⇒ 授权不被记住
 * （每次都问一次），绝不退化成"所有人都已授权"。
 */
export const APP_AI_IDENTITY_PATH = '/api/pico/auth/state'

/**
 * 授权作用域：**用户 × 服务端**（应用是第三个维度，由调用点单独传）。
 *
 * 这两段与宿主闸门的 `AiChatScope` 逐段同源：`userId` = 会话 `username`，
 * `serverURL` = 会话 `serverURL`（同一份 `/api/pico/auth/state` 快照，宿主那份来自
 * `getSession()`）。
 */
export interface AppAiScope {
  /** 当前登录用户标识（会话 `username`）。 */
  readonly userId: string
  /** 当前服务端地址（会话 `serverURL`）。 */
  readonly serverURL: string
}

/**
 * 取当前登录身份（= **宿主闸门的作用域**：用户 + 服务端）。
 *
 * ## 为什么带服务端段（R21 FIX-7 ①，取代审计 C-25 的旧口径）
 *
 * 真正的闸门在宿主：`wasm-apps-host/src/ai-authorization.ts` 的 `aiConsentKey` 按
 * **用户 ⊕ 服务端 ⊕ 应用** 构键（第二十一轮 B2-R21-01 把闸门从两段升成三段，落盘
 * `version: 2`），`handleAiChat` 先查它再碰模型。本函数返回的**只用于渲染层那份 UI
 * 记忆**（决定"还要不要再弹一次说明卡"）。
 *
 * 审计 C-25 当时让这里对齐宿主的 `username`（丢掉 `serverURL`）是对的 —— 那时的闸门
 * 就是两段。闸门升成三段之后，"面板记忆三段、宿主闸门两段"就反了过来：换过服务端
 * 之后面板会跳过说明卡、用户发出第一条消息才吃 403（**静默失败**）。两端的授权作用域
 * 必须**逐段同源**（同顺序、同归一化、同"拿不到就拒绝"方向），本函数与
 * {@link appAiConsentKey} 因此与宿主那份构键点对齐；`consent-key-parity.spec.ts`
 * 直接读宿主源码逐段对拍，两端各改各的会当场变红。
 *
 * **拿不到服务端地址 ⇒ `null`**（= 面板当成"没问过"，宁可多问一次）：绝不退化成
 * "无服务端"的两段作用域 —— 那等于把服务端维度整个删掉，正是本条要修的形态。
 * @param deps - 可注入 fetch（测试用）。
 * @returns 作用域；未登录 / 缺任一段 / 形状不符 / 网络失败 ⇒ `null`（fail-closed）。
 */
export async function loadAppAiIdentity(deps: AppAiDeps = { fetch: (...args: Parameters<typeof fetch>) => fetch(...args) }): Promise<AppAiScope | null> {
  try {
    const response = await deps.fetch(APP_AI_IDENTITY_PATH, {
      method: 'GET',
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
    })
    if (!response.ok) return null
    const payload = await response.json()
    if (payload === null || typeof payload !== 'object') return null
    const row = payload as { loggedIn?: unknown, username?: unknown, serverURL?: unknown }
    if (row.loggedIn !== true) return null
    const userId = typeof row.username === 'string' ? row.username.trim() : ''
    const serverURL = typeof row.serverURL === 'string' ? row.serverURL.trim() : ''
    // 两段都由**同一份**归一化判据把关（缺任一段 ⇒ 面板当成"没问过"）。
    const scope = { userId, serverURL }
    return normalizeAppAiScope(scope) === null ? null : scope
  } catch {
    return null
  }
}

/** 读/写/删所需的存储子集（`localStorage` 满足它）。 */
export interface AppAiConsentStore {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

/**
 * 默认授权存储（渲染进程 `localStorage`；不可用 ⇒ `null`）。
 * @returns 存储实现，或 `null`。
 */
export function defaultAppAiConsentStore(): AppAiConsentStore | null {
  try {
    const storage = (globalThis as { localStorage?: AppAiConsentStore }).localStorage
    return storage === undefined || storage === null ? null : storage
  } catch {
    return null
  }
}

/**
 * NUL 会不会出现在这一段里（授权键的分隔符；与宿主那份构键点同一条判据）。
 *
 * 分隔符出现在**段内**会让一个键被切成更多段。宿主侧因此直接拒绝该作用域
 * （`aiConsentKey` 返回 `null` = 未授权）；客户端这半边若接受了它，UI 记忆就会认为
 * "已经问过"而宿主闸门仍然拒绝 —— 正是本条要消灭的静默失败形态。所以同样
 * **构造期拒绝**（fail-closed），不靠序列化期兜底。
 * @param value - 候选段。
 * @returns true = 含 NUL。
 */
const hasNul = (value: string): boolean => value.includes('\u0000')

/**
 * 身份两段的归一化（**唯一实现**：读身份、构键都只走这里）。
 *
 * 三条与宿主 `aiConsentKey` 逐条同源（改这里必须同步改那边，反之亦然；
 * `consent-key-parity.spec.ts` 读宿主源码对拍）：
 *  1. **同归一化**：每段先 `trim()`，纯空白不算"有值"；
 *  2. **同拒绝方向**：任一段拿不到 ⇒ `null`（读面 = 未授权、写面 = 拒绝）；
 *  3. **同 NUL 口径**：段内含 NUL ⇒ `null`。
 * @param scope - 用户 + 服务端；`null`/`undefined` = 拿不到。
 * @returns 归一化后的两段；任一段缺失/含 NUL ⇒ `null`。
 */
function normalizeAppAiScope(scope: AppAiScope | null | undefined): AppAiScope | null {
  if (scope === null || scope === undefined) return null
  const user = typeof scope.userId === 'string' ? scope.userId.trim() : ''
  const server = typeof scope.serverURL === 'string' ? scope.serverURL.trim() : ''
  if (user === '' || server === '') return null
  if (hasNul(user) || hasNul(server)) return null
  return { userId: user, serverURL: server }
}

/**
 * 授权键（**段序与宿主逐段同源**：用户 → 服务端 → 应用）。
 *
 * 三个维度都编码：换账号、换应用、**换服务端**都不得继承上一条授权
 * （与缓存/分区同一条纪律 —— 宿主那份闸门就是这么分域的）。
 * 分隔符与宿主不同（宿主的记录是 NUL 分隔的内部键，这边是 `localStorage` 的键名），
 * 但**段数、段序、归一化与拒绝方向逐条一致**，由 `consent-key-parity.spec.ts` 读
 * 宿主源码 `ai-authorization.ts` 的 `aiConsentKey` 对拍。
 * @param scope - 用户 + 服务端；`null`/`undefined` = 拿不到 ⇒ `null`。
 * @param appId - 应用标识。
 * @returns 存储键；任一段缺失/含 NUL ⇒ `null`（= 不匹配、不写）。
 */
export function appAiConsentKey(scope: AppAiScope | null | undefined, appId: string): string | null {
  const normalized = normalizeAppAiScope(scope)
  if (normalized === null) return null
  const app = typeof appId === 'string' ? appId.trim() : ''
  if (app === '') return null
  if (hasNul(app)) return null
  return `${APP_AI_CONSENT_PREFIX}:${encodeURIComponent(normalized.userId)}:${encodeURIComponent(normalized.serverURL)}:${encodeURIComponent(app)}`
}

/**
 * 这个用户在**这台服务端上**是否已授权这个应用使用 AI。
 * @param scope - 用户 + 服务端；`null`/缺任一段 ⇒ `false`（拿不到身份就不给授权，fail-closed）。
 * @param appId - 应用标识。
 * @param store - 存储实现（缺省 {@link defaultAppAiConsentStore}）。
 * @returns true = 已授权（不再弹说明卡）。
 */
export function hasAppAiConsent(scope: AppAiScope | null | undefined, appId: string, store: AppAiConsentStore | null = defaultAppAiConsentStore()): boolean {
  const key = appAiConsentKey(scope, appId)
  if (store === null || key === null) return false
  try {
    return store.getItem(key) === 'granted'
  } catch {
    return false
  }
}

/**
 * 记下"允许这个应用使用 AI"（一次性说明卡的"允许"按钮）。
 * @param scope - 用户 + 服务端（宿主闸门的作用域）。
 * @param appId - 应用标识。
 * @param store - 存储实现。
 */
export function grantAppAiConsent(scope: AppAiScope | null | undefined, appId: string, store: AppAiConsentStore | null = defaultAppAiConsentStore()): void {
  const key = appAiConsentKey(scope, appId)
  if (store === null || key === null) return
  try {
    store.setItem(key, 'granted')
  } catch { /* 写失败 = 下次再问一次：可接受 */ }
}

/**
 * 撤销授权（§21.1 第 9 条：撤销后再调 ⇒ 403；唯一入口是应用详情页的 AI 面板）。
 * @param scope - 用户 + 服务端（宿主闸门的作用域）。
 * @param appId - 应用标识。
 * @param store - 存储实现。
 */
export function revokeAppAiConsent(scope: AppAiScope | null | undefined, appId: string, store: AppAiConsentStore | null = defaultAppAiConsentStore()): void {
  const key = appAiConsentKey(scope, appId)
  if (store === null || key === null) return
  try {
    store.removeItem(key)
  } catch { /* 同上 */ }
}

/**
 * 宿主侧的授权路由（**唯一入口**；`wasm-apps-host` 的 `WASM_APP_AI_CONSENT_ROUTE`）。
 *
 * 为什么需要它：本模块上面那三个函数只写渲染层的 `localStorage` —— 那是**UI 记忆**
 * （决定"要不要再弹一次说明卡"），而真正的闸门在宿主（`ai-chat.ts` 的
 * `AiChatAuthorization`，`handleAiChat` 先查它再碰模型）。两边不连通就会出现
 * "点了允许、界面上也不再问，但每次调用仍然 403" —— 一条只在真机上才看得见的缝。
 */
export const APP_AI_CONSENT_PATH = '/api/pico/wasm-apps/ai/consent'

/** 授权同步的结果（失败时 `message` 是给维护者看的诊断细节）。 */
export type AppAiConsentSync = { ok: true } | { ok: false, message: string }

/**
 * 把"允许/撤销"写到宿主（本机写路由，带持有性证明；**不是**平台调用）。
 *
 * 失败**永不抛**：返回结构化结果，调用方据此决定是否放行 UI —— 宿主没记住的授权
 * 不能让界面看起来"已经允许"（下一次调用会 403）。
 * @param appId - 应用标识。
 * @param granted - true = 允许，false = 撤销。
 * @param deps - 可注入 fetch（测试用）。
 * @returns 同步结果。
 */
export async function syncAppAiConsent(
  appId: string,
  granted: boolean,
  deps: AppAiDeps = { fetch: (...args: Parameters<typeof fetch>) => fetch(...args) },
): Promise<AppAiConsentSync> {
  let response: Response | null
  try {
    response = await fetchWithHostProof(APP_AI_CONSENT_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ app_id: appId, granted }),
      credentials: 'same-origin',
    }, { fetch: deps.fetch })
  } catch (cause) {
    return { ok: false, message: `the host consent route is unreachable: ${cause instanceof Error ? cause.message : String(cause)}` }
  }
  // `null` = 拿不到持有性证明（宿主 fail-closed）；调用方按"没同步"处理。
  if (response === null) return { ok: false, message: 'the host proof could not be issued; the consent was not persisted' }
  if (!response.ok) {
    let body = ''
    try { body = (await response.text()).slice(0, 200) } catch { body = '' }
    return { ok: false, message: `the host refused the consent (HTTP ${String(response.status)}): ${body}` }
  }
  return { ok: true }
}
