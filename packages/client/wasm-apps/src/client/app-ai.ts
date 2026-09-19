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
 *   ① 首次授权闸门（用户×应用；未授权 ⇒ 一次性说明卡；拒绝 ⇒ 403 app_ai_denied）
 *   ② 该应用的**隐藏会话**（"app:<app_id>"；多轮上下文，不出现在侧边栏）
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
 *  - **首次授权**（§21.1 第 9 条，按 **用户×应用** 记，可撤销）；
 *  - **取消**（§21.1 第 15 条：仅前台，页面关闭即取消）：调用方用 `AbortSignal`
 *    取消，本模块把它报成 `ai_cancelled`（不是错误弹窗，是"你停了"）。
 *
 * 不做（明确留给别的层）：隐藏会话的创建与元数据、`X-Pico-App-Id` 归因头、工具集为空、
 * 平台网关的计量 —— 那些在宿主的协议 handler 与服务端（§21.2/§21.4）。
 *
 * @module @picoaide/dsh-wasm-apps/client/app-ai
 */

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
// 首次授权（§21.1 第 9 条：按 **用户×应用** 记一次，可在设置里撤销）
// ---------------------------------------------------------------------------

/** 授权键前缀（存储里 `…:<user>:<app>` = `'granted'`）。 */
export const APP_AI_CONSENT_PREFIX = 'picoaide.wasm-apps.ai-consent.v1'

/**
 * 本机登录态路由（既有的客户端路由；只读，用来拿"授权作用域"里的用户维度）。
 *
 * 为什么需要它：§21.1 第 9 条要求授权按 **用户×应用** 记；客户端半边不持 bearer、
 * 也没有会话服务可注入，而这条路由返回的是宿主会话快照
 * （`{loggedIn, username, serverURL, …}`，见 `packages/host/enterprise/src/auth-gate.ts`）。
 * 取不到就返回空串 ⇒ 授权不被记住（每次都问一次），绝不退化成"所有人都已授权"。
 */
export const APP_AI_IDENTITY_PATH = '/api/pico/auth/state'

/**
 * 取当前登录身份（`<username>@<serverURL>` 形态的作用域串）。
 *
 * 维度取 **用户名 + 服务端地址**（与 §7.5 的 `session-scope` 同一精神）：同一台机器上
 * 换账号或换服务端都不得继承上一个人的 AI 授权。
 * @param deps - 可注入 fetch（测试用）。
 * @returns 作用域串；未登录 / 形状不符 / 网络失败 ⇒ `''`（fail-closed）。
 */
export async function loadAppAiIdentity(deps: AppAiDeps = { fetch: (...args: Parameters<typeof fetch>) => fetch(...args) }): Promise<string> {
  try {
    const response = await deps.fetch(APP_AI_IDENTITY_PATH, {
      method: 'GET',
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
    })
    if (!response.ok) return ''
    const payload = await response.json()
    if (payload === null || typeof payload !== 'object') return ''
    const row = payload as { loggedIn?: unknown, username?: unknown, serverURL?: unknown }
    if (row.loggedIn !== true) return ''
    const username = typeof row.username === 'string' ? row.username.trim() : ''
    const serverURL = typeof row.serverURL === 'string' ? row.serverURL.trim() : ''
    if (username === '') return ''
    return serverURL === '' ? username : `${username}@${serverURL}`
  } catch {
    return ''
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
 * 授权键（用户×应用）。
 *
 * 两个维度都编码：换账号后**不得**继承上一个人的授权（与缓存/分区同一条纪律）。
 * @param userId - 当前登录用户标识（服务端 `user.id`）。
 * @param appId - 应用标识。
 * @returns 存储键。
 */
export function appAiConsentKey(userId: string, appId: string): string {
  return `${APP_AI_CONSENT_PREFIX}:${encodeURIComponent(userId)}:${encodeURIComponent(appId)}`
}

/**
 * 这个用户是否已授权这个应用使用 AI。
 * @param userId - 用户标识；空串 ⇒ `false`（拿不到身份就不给授权，fail-closed）。
 * @param appId - 应用标识。
 * @param store - 存储实现（缺省 {@link defaultAppAiConsentStore}）。
 * @returns true = 已授权（不再弹说明卡）。
 */
export function hasAppAiConsent(userId: string, appId: string, store: AppAiConsentStore | null = defaultAppAiConsentStore()): boolean {
  if (store === null || userId === '' || appId === '') return false
  try {
    return store.getItem(appAiConsentKey(userId, appId)) === 'granted'
  } catch {
    return false
  }
}

/**
 * 记下"允许这个应用使用 AI"（一次性说明卡的"允许"按钮）。
 * @param userId - 用户标识。
 * @param appId - 应用标识。
 * @param store - 存储实现。
 */
export function grantAppAiConsent(userId: string, appId: string, store: AppAiConsentStore | null = defaultAppAiConsentStore()): void {
  if (store === null || userId === '' || appId === '') return
  try {
    store.setItem(appAiConsentKey(userId, appId), 'granted')
  } catch { /* 写失败 = 下次再问一次：可接受 */ }
}

/**
 * 撤销授权（§21.1 第 9 条：设置里可撤销；撤销后再调 ⇒ 403）。
 * @param userId - 用户标识。
 * @param appId - 应用标识。
 * @param store - 存储实现。
 */
export function revokeAppAiConsent(userId: string, appId: string, store: AppAiConsentStore | null = defaultAppAiConsentStore()): void {
  if (store === null || userId === '' || appId === '') return
  try {
    store.removeItem(appAiConsentKey(userId, appId))
  } catch { /* 同上 */ }
}
