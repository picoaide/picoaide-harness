/**
 * 应用 AI 桥（设计总纲 §21，冻结）：`POST /__picoaide/ai/chat` 由**协议 handler 本地
 * 处理**，绝不转发平台。
 *
 * ```
 * 应用页 fetch('/__picoaide/ai/chat', {messages, stream})
 *         │  协议 handler 本地拦截（这一条路径不进信封、不出站）
 *         ▼
 * ① 首次授权闸门（用户 × 应用；未授权 ⇒ 403 app_ai_denied，不消耗任何 token）
 * ② 取该应用的**隐藏会话** `app:<app_id>`（侧边栏不出现，诊断可查）
 * ③ 跑一轮**仅对话**的 AI（无工具、无记忆、只带本次 messages）—— 经 `runTurn` 注入
 * ④ assistant 增量以 SSE 回给应用页；页面关闭/取消 ⇒ 该轮被 cancel（不留孤儿循环）
 * ```
 *
 * 本模块拥有**线上契约与闸门**（被 L1/L3 依赖的那一半）：请求校验、授权记录、
 * 隐藏会话寻址、SSE 帧、错误码、取消。真正"跑一轮模型"由 `runTurn` 注入 —— 它属于
 * 客户端 AI loop（宿主面），本模块不复制任何 LLM 逻辑。
 *
 * @module @picoaide/dsh-wasm-apps-host/ai-chat
 */

/** 保留路径（§21.2 冻结；协议 handler 本地处理，绝不外发）。 */
export const AI_CHAT_PATH = '/__picoaide/ai/chat'

/** 隐藏会话前缀（§21.1 Q5：每应用一个隐藏会话 `app:<app_id>`）。 */
export const AI_HIDDEN_SESSION_PREFIX = 'app:'

/** `messages` 条数上限（§21.2 冻结：≤64 条）。 */
export const AI_CHAT_MAX_MESSAGES = 64

/** 单条 `content` 上限（§21.2 冻结：≤16 KiB）。 */
export const AI_CHAT_MAX_CONTENT_BYTES = 16 * 1024

/** 允许的角色（仅对话：没有 tool/system 的注入面）。 */
const AI_ROLES = ['user', 'assistant'] as const

/** 一条对话消息。 */
export interface AiChatMessage {
  readonly role: 'user' | 'assistant'
  readonly content: string
}

/** 已校验的请求。 */
export interface AiChatRequest {
  readonly messages: readonly AiChatMessage[]
  readonly stream: boolean
}

/** 校验失败（一律 JSON 信封，HTTP 400）。 */
export interface AiChatInvalid {
  readonly code: 'app_ai_invalid'
  readonly message: string
}

/**
 * 隐藏会话 id（**唯一实现**）：`app:<app_id>`。
 * @param appId - 已校验的 app_id。
 * @returns 会话 id。
 */
export function hiddenSessionId(appId: string): string {
  return `${AI_HIDDEN_SESSION_PREFIX}${appId}`
}

/**
 * 严格校验请求体（§21.2：未知字段拒；条数/单条上限）。
 * @param value - `JSON.parse` 之后的值。
 * @returns 校验结果。
 */
export function parseAiChatRequest(value: unknown): { ok: true, request: AiChatRequest } | { ok: false, error: AiChatInvalid } {
  const invalid = (message: string): { ok: false, error: AiChatInvalid } => ({ ok: false, error: { code: 'app_ai_invalid', message } })
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid('the request body must be a JSON object')
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (key !== 'messages' && key !== 'stream') return invalid(`unknown field ${JSON.stringify(key)}`)
  }
  const rawMessages = record.messages
  if (!Array.isArray(rawMessages)) return invalid('messages must be an array')
  if (rawMessages.length === 0) return invalid('messages must not be empty')
  if (rawMessages.length > AI_CHAT_MAX_MESSAGES) return invalid(`messages must not exceed ${String(AI_CHAT_MAX_MESSAGES)} entries`)
  const messages: AiChatMessage[] = []
  for (const entry of rawMessages) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return invalid('each message must be an object')
    const message = entry as Record<string, unknown>
    for (const key of Object.keys(message)) {
      if (key !== 'role' && key !== 'content') return invalid(`unknown message field ${JSON.stringify(key)}`)
    }
    const role = message.role
    if (typeof role !== 'string' || !(AI_ROLES as readonly string[]).includes(role)) return invalid('role must be "user" or "assistant"')
    const content = message.content
    if (typeof content !== 'string') return invalid('content must be a string')
    if (Buffer.byteLength(content, 'utf8') > AI_CHAT_MAX_CONTENT_BYTES) {
      return invalid(`a single message must not exceed ${String(AI_CHAT_MAX_CONTENT_BYTES)} bytes`)
    }
    messages.push({ role: role as AiChatMessage['role'], content })
  }
  const stream = record.stream === undefined ? true : record.stream
  if (typeof stream !== 'boolean') return invalid('stream must be a boolean')
  return { ok: true, request: { messages, stream } }
}

/** 应用 AI 的错误码（§21.2 冻结集合）。 */
export type AiChatErrorCode =
  | 'app_ai_denied'
  | 'app_ai_unavailable'
  | 'app_ai_invalid'
  | 'ai_balance_insufficient'
  | 'ai_rate_limited'
  | 'ai_cancelled'

/** SSE 帧（`event:` + `data:`，以空行结束；`data` 永远是单行 JSON）。 */
export function sseFrame(event: 'delta' | 'done' | 'error', data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

/** 一轮对话的执行结果。 */
export interface AiChatTurnResult {
  readonly content: string
  readonly usage?: { readonly promptTokens?: number, readonly completionTokens?: number }
}

/** 一轮对话的执行面（由客户端 AI loop 注入）。 */
export interface AiChatTurnRunner {
  /**
   * 跑一轮**仅对话**的 AI（无工具、无记忆、只带 `messages`）。
   * @param input - 会话 id（`app:<app_id>`）、本次消息、增量回调、取消信号。
   * @returns 最终结果（流式下 `onDelta` 已经发过增量）。
   */
  run(input: {
    sessionId: string
    appId: string
    messages: readonly AiChatMessage[]
    onDelta: (text: string) => void
    signal: AbortSignal
  }): Promise<AiChatTurnResult>
  /** 取消该会话当前的一轮（页面关闭/用户取消）。 */
  cancel?(sessionId: string): void
}

/** 用户 × 应用的授权记录（§21.1 Q9：首次调用授权一次，可在设置里撤销）。 */
export interface AiChatAuthorization {
  /** 是否已授权。 */
  isGranted(userId: string, appId: string): Promise<boolean>
  /** 记下授权（首次说明卡确认后调用）。 */
  grant(userId: string, appId: string): Promise<void>
  /** 撤销（设置里的入口；撤销后再调 ⇒ 403）。 */
  revoke(userId: string, appId: string): Promise<void>
}

/** 授权闸结论。 */
export type AiChatGateResult =
  | { ok: true, sessionId: string }
  | { ok: false, status: 403, code: 'app_ai_denied' }

/**
 * 首次授权闸（§21.6 判据：未授权 ⇒ 403 `app_ai_denied` 且**不消耗任何 token**）。
 *
 * 判据顺序是契约的一部分：**先**查授权，**再**碰任何模型调用 —— 反过来就会出现
 * "没授权也花了一次 token"。
 * @param authorization - 授权记录。
 * @param userId - 当前员工。
 * @param appId - 应用。
 * @returns 通过时给出隐藏会话 id。
 */
export async function gateAppAi(authorization: AiChatAuthorization, userId: string, appId: string): Promise<AiChatGateResult> {
  if (!await authorization.isGranted(userId, appId)) return { ok: false, status: 403, code: 'app_ai_denied' }
  return { ok: true, sessionId: hiddenSessionId(appId) }
}

/** SSE 响应的头（与 `Response` 构造共用，便于单测断言）。 */
export const AI_CHAT_SSE_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-store',
  Connection: 'keep-alive',
  // 自定义协议下 CSP 由宿主给（见 handler），这里只标 SSE 语义。
  'X-Accel-Buffering': 'no',
}

/** AI 桥的注入依赖。 */
export interface AiChatBridgeDeps {
  /** 授权闸。 */
  authorization: AiChatAuthorization
  /** 一轮对话的执行面（客户端 AI loop）。 */
  runner: AiChatTurnRunner | undefined
  /** 当前员工 id（未登录 ⇒ 不服务）。 */
  userId: () => string | null
  /** 诊断出口。 */
  warn?: ((message: string) => void) | undefined
}

/** 一次 AI 请求的处理结果（传输无关：handler 把它变成 `Response`）。 */
export type AiChatOutcome =
  | { kind: 'json', status: number, body: Record<string, unknown> }
  | { kind: 'sse', status: 200, frames: AsyncIterable<string> }

/**
 * 处理一次应用 AI 请求（本地；**不转发平台**）。
 * @param deps - 授权/执行面/当前用户。
 * @param rawBody - 请求体原文（JSON）。
 * @param signal - 取消信号（页面关闭时由 handler abort）。
 * @returns JSON 或 SSE 结果。
 */
export async function handleAiChat(
  deps: AiChatBridgeDeps,
  appId: string,
  rawBody: Uint8Array,
  signal: AbortSignal,
): Promise<AiChatOutcome> {
  const warn = deps.warn ?? ((): void => {})
  const fail = (status: number, code: AiChatErrorCode, message: string): AiChatOutcome =>
    ({ kind: 'json', status, body: { error: { code, message } } })
  let parsedBody: unknown
  try {
    parsedBody = rawBody.byteLength === 0 ? undefined : JSON.parse(Buffer.from(rawBody).toString('utf8'))
  } catch {
    return fail(400, 'app_ai_invalid', 'the request body is not valid JSON')
  }
  const parsed = parseAiChatRequest(parsedBody)
  if (!parsed.ok) return fail(400, parsed.error.code, parsed.error.message)
  if (deps.runner === undefined) {
    // 没有 AI loop（宿主未接线 / 该构建不含 AI）：如实报不可用，**不**静默返回空答案。
    return fail(503, 'app_ai_unavailable', 'the application AI bridge is not available in this client')
  }
  const userId = deps.userId()
  if (userId === null) return fail(401, 'app_ai_unavailable', 'not signed in')
  const gate = await gateAppAi(deps.authorization, userId, appId)
  if (!gate.ok) return fail(gate.status, gate.code, 'the user has not authorized AI use for this application')

  const sessionId = gate.sessionId
  if (!parsed.request.stream) {
    try {
      const result = await deps.runner.run({
        sessionId,
        appId,
        messages: parsed.request.messages,
        onDelta: () => {},
        signal,
      })
      return { kind: 'json', status: 200, body: { content: result.content, ...(result.usage === undefined ? {} : { usage: result.usage }) } }
    } catch (cause) {
      return mapTurnFailure(cause, warn)
    }
  }

  // 流式：把 runner 的增量包成 SSE 帧。每条 delta 一个 `delta` 事件，最后一帧是
  // `done`；中途失败给 `error` 帧（**连接不 200-后静默断**，否则应用无法区分
  // "正常结束"与"上游挂了"）。
  const queue: string[] = []
  let notify: (() => void) | undefined
  let finished = false
  let failure: unknown
  const wake = (): void => {
    const resume = notify
    notify = undefined
    resume?.()
  }
  const frames: AsyncIterable<string> = {
    async *[Symbol.asyncIterator]() {
      const pending = (async (): Promise<void> => {
        try {
          const result = await deps.runner!.run({
            sessionId,
            appId,
            messages: parsed.request.messages,
            onDelta: (text) => {
              if (text === '') return
              queue.push(sseFrame('delta', { delta: text }))
              wake()
            },
            signal,
          })
          queue.push(sseFrame('done', { content: result.content, ...(result.usage === undefined ? {} : { usage: result.usage }) }))
        } catch (cause) {
          failure = cause
        } finally {
          finished = true
          wake()
        }
      })()
      while (!finished || queue.length > 0) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => { notify = resolve })
          continue
        }
        yield queue.shift() as string
      }
      await pending
      if (failure !== undefined) {
        const mapped = mapTurnFailure(failure, warn)
        yield sseFrame('error', mapped.body)
      }
      if (signal.aborted) {
        yield sseFrame('error', { error: { code: 'ai_cancelled', message: 'the application page closed this request' } })
      }
    },
  }
  return { kind: 'sse', status: 200, frames }
}

/** 把 runner 的失败映射成契约里的错误码（不泄漏上游细节）。 */
function mapTurnFailure(cause: unknown, warn: (message: string) => void): { kind: 'json', status: number, body: Record<string, unknown> } {
  const message = cause instanceof Error ? cause.message : String(cause)
  warn(`pico-wasm-apps-host: an application AI turn failed (${message})`)
  if (cause instanceof Error && cause.name === 'AbortError') {
    return { kind: 'json', status: 499, body: { error: { code: 'ai_cancelled', message: 'the turn was cancelled' } } }
  }
  if (/insufficient|balance/iu.test(message)) {
    return { kind: 'json', status: 402, body: { error: { code: 'ai_balance_insufficient', message: 'the account balance is insufficient for AI usage' } } }
  }
  if (/rate|quota|too many/iu.test(message)) {
    return { kind: 'json', status: 429, body: { error: { code: 'ai_rate_limited', message: 'the AI service is rate limited right now' } } }
  }
  return { kind: 'json', status: 502, body: { error: { code: 'app_ai_unavailable', message: 'the AI service is unavailable right now' } } }
}
