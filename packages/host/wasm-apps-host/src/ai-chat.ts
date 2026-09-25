/**
 * 应用 AI 桥（设计总纲 §21，冻结）：`POST /__picoaide/ai/chat` 由**协议 handler 本地
 * 处理**，绝不转发平台。
 *
 * ```
 * 应用页 fetch('/__picoaide/ai/chat', {messages, stream})
 *         │  协议 handler 本地拦截（这一条路径不进信封、不出站）
 *         ▼
 * ① 首次授权闸门（用户 × 应用；未授权 ⇒ 403 app_ai_denied，不消耗任何 token）
 * ② 取该应用的**隐藏会话** `app:<app_id>#<账号作用域>`（侧边栏不出现，诊断可查）
 * ③ 跑一轮**仅对话**的 AI（无工具、无记忆、只带本次 messages）—— 经 `runTurn` 注入
 * ④ assistant 增量以 SSE 回给应用页；页面关闭/取消 ⇒ 该轮被 cancel（不留孤儿循环）
 * ```
 *
 * 本模块拥有**线上契约与闸门**（被 L1/L3 依赖的那一半）：请求校验、授权记录、
 * 隐藏会话寻址、SSE 帧、错误码、取消。真正"跑一轮模型"由 `runTurn` 注入 —— 它属于
 * 客户端 AI loop（宿主面），本模块不复制任何 LLM 逻辑。
 *
 * ## 隐藏会话 id 的**账号作用域**（2026-09-24，R13-GB）
 *
 * 隐藏会话 id = `app:<app_id>#<账号作用域>`，作用域 = `<编码用户名>[@<服务端哈希>]`。
 * 三条理由（缺一条都会复发同一个缺陷）：
 *
 *  ① 授权是 **(用户 × 应用)** 粒度的（`aiConsentKey`），而隐藏会话承载的是**某个账号的
 *     对话本体** —— 键里没有账号，同一台机器上换账号（共用工作站的常见形态）就会让
 *     第二个账号续用第一个账号的对话：实测第二个账号那一轮的模型请求里带着第一个账号
 *     的用户消息与 assistant 回复（R13-E-04 / B-P0-1，真 agent-loop 探针）；
 *  ② 服务端哈希是**同一台机器上的多租户**维度：`persist:` / 数据根都在机器级，测试与
 *     正式服务端并存时同名用户名是两个人（与 `2026-09-21` 分区哈希 P1-10 同源）；
 *  ③ app_id **必须挨着前缀**（`app:<app_id>#…`）而不是 `app:<user>:<app_id>`：服务端归因
 *     按前缀派生（`server/internal/llmgateway/app_session_id.go`），"取第一个分隔符之前
 *     的那段"是可判定的；"从右往左数第二段"在用户名含分隔符时就只能猜。
 *
 * 编码表与分区名**共用一份实现**（`partition.ts` 的 `encodePartitionSegment`，与
 * browser/connectors 逐字一致）；形状的唯一真源是
 * `server/internal/llmgateway/app-session-id.json`，两端由
 * `app-session-id-contract.spec.ts` 用同一份语料对拍。
 *
 * **历史形态** `app:<app_id>`（无账号维度）不再被本模块构造，但磁盘上可能已存在：
 * 按"**读得到、不复用**"处理 —— 新 id 永远不等于旧 id，所以旧会话不会被任何账号
 * `resume`（它反而**不能**迁移：那份日志里已经混进了多个账号的对话，迁移到任何一个
 * 账号头上都是把别人的内容记成他的）。它仍是该机的历史记录，诊断包照常列出。
 *
 * @module @picoaide/dsh-wasm-apps-host/ai-chat
 */

import { encodePartitionSegment, serverPartitionHash } from './partition.ts'

/** 保留路径（§21.2 冻结；协议 handler 本地处理，绝不外发）。 */
export const AI_CHAT_PATH = '/__picoaide/ai/chat'

/** 隐藏会话前缀（§21.1 Q5 / 契约 `app-session-id.json`：`app:`）。 */
export const AI_HIDDEN_SESSION_PREFIX = 'app:'

/** 隐藏会话 id 里"前缀之后"的**账号作用域**分隔符（契约 `scope_separator`）。 */
export const AI_HIDDEN_SESSION_SCOPE_SEPARATOR = '#'

/** app_id 形态镜像（契约 `app_id_pattern`；真源 = `wasmapp/limits` 的 `AppIDPattern`）。 */
export const AI_APP_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

/** app_id 长度上限镜像（契约 `app_id_max_length` = DNS label 上限）。 */
export const AI_APP_ID_MAX_LENGTH = 63

/**
 * 出站会话 id 头名（契约 `session_id_header`）。
 *
 * 服务端**按它派生应用维度归因**（`app:` 前缀 ⇒ `app_id`）：上游 `llm-deepseek` 的两个
 * 适配器都无条件按 `options.sessionId` 带上这个头，所以隐藏会话 id 就是归因链路本身，
 * 不需要额外的自报头（§21.7⑤）。
 */
export const AI_SESSION_ID_HEADER = 'x-deepseek-harness-session-id'

/** `messages` 条数上限（§21.2 冻结：≤64 条）。 */
export const AI_CHAT_MAX_MESSAGES = 64

/** 单条 `content` 上限（§21.2 冻结：≤16 KiB）。 */
export const AI_CHAT_MAX_CONTENT_BYTES = 16 * 1024

/** 允许的角色（仅对话：没有 tool/system 的注入面）。 */
const AI_ROLES = ['user', 'assistant'] as const

/**
 * 隐藏会话的**账号作用域**：谁 + 哪个服务端。
 *
 * 两个字段都不可省：用户名区分同一台机器上的两个人，服务端地址区分同名用户在两个
 * 租户（测试/正式并存）里的身份。
 */
export interface AiChatScope {
  /** 当前员工（`picoSession` 的 `username`）。 */
  readonly userId: string
  /** 当前服务端地址（取不到 ⇒ 只按账号分域，不影响会话可用性）。 */
  readonly serverURL?: string | null
}

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
 * 账号作用域段（**唯一实现**）：`<编码用户名>[@<服务端哈希>]`。
 *
 * 编码表来自 `partition.ts` 的 `encodePartitionSegment`（与 browser 分区名、connectors
 * 的用户目录同一张表：`A-Za-z0-9_-` 原样，其余 `~<HEX>~`）—— 账号名进名字段只允许有
 * 一份实现，抄第二份就会在"用户名里有点号/中文/大写"时算出两个不同的作用域。
 * @param scope - 当前账号 + 服务端地址。
 * @returns 可安全放进会话 id 的作用域段（非空）。
 */
export function hiddenSessionScope(scope: AiChatScope): string {
  const user = encodePartitionSegment(scope.userId.trim())
  const server = serverPartitionHash(scope.serverURL ?? undefined)
  return server === undefined ? user : `${user}@${server}`
}

/**
 * 隐藏会话 id（**唯一实现**）：`app:<app_id>#<账号作用域>`。
 *
 * 两个 fail-loud 的入参校验都指向同一个后果：**id 一旦不可归因/可共享，就不该被构造**。
 * 非法 app_id 会让服务端派生不出归因（用量静默丢失），空账号会让两个账号落进同一个
 * 作用域（正是本函数要杜绝的缺陷）——所以这里抛错，而不是悄悄产出一个"看起来能用"的 id。
 * @param scope - 当前账号 + 服务端地址。
 * @param appId - 已校验的 app_id（平台域名标签形态）。
 * @returns 会话 id。
 * @throws app_id 不是平台 app_id、或账号为空时。
 */
export function hiddenSessionId(scope: AiChatScope, appId: string): string {
  if (appId.length > AI_APP_ID_MAX_LENGTH || !AI_APP_ID_PATTERN.test(appId)) {
    throw new Error(`the hidden session id needs a platform app_id (got ${JSON.stringify(appId)}); an unusable id would silently lose the usage attribution`)
  }
  if (scope.userId.trim() === '') {
    throw new Error('the hidden session id needs an account scope (empty user id); a shared scope would leak one account\'s conversation into another')
  }
  return `${AI_HIDDEN_SESSION_PREFIX}${appId}${AI_HIDDEN_SESSION_SCOPE_SEPARATOR}${hiddenSessionScope(scope)}`
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
 *
 * 授权是 (账号 × 应用) 粒度；隐藏会话是 (账号 × 服务端 × 应用) 粒度。两者**不共键**也
 * 不该共键：授权回答"许不许可"，作用域回答"这份对话属于谁" —— 用授权粒度当会话键正是
 * R13-E-04 的缺陷（换账号后被授权过 ≠ 该续用前一个账号的对话）。
 * @param authorization - 授权记录。
 * @param scope - 当前账号 + 服务端地址。
 * @param appId - 应用。
 * @returns 通过时给出该账号在该应用上的隐藏会话 id。
 */
export async function gateAppAi(authorization: AiChatAuthorization, scope: AiChatScope, appId: string): Promise<AiChatGateResult> {
  if (!await authorization.isGranted(scope.userId, appId)) return { ok: false, status: 403, code: 'app_ai_denied' }
  return { ok: true, sessionId: hiddenSessionId(scope, appId) }
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
  /**
   * 当前员工的**作用域**（账号 + 服务端地址；未登录 ⇒ `null`）。
   *
   * 一次调用只解析一次：隐藏会话的键必须取自**同一个**会话快照 —— 分两次读（授权读一次、
   * 会话 id 再读一次）会在请求中途换账号时拼出"甲的授权 + 乙的会话"。
   */
  scope: () => AiChatScope | null
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
  const scope = deps.scope()
  if (scope === null || scope.userId.trim() === '') {
    // 空账号**不是**"匿名作用域"：那会让所有未登录/半登录状态共用一个隐藏会话
    // （跨账号复用的一条侧门）。宁可不服务。
    return fail(401, 'app_ai_unavailable', 'not signed in')
  }
  const gate = await gateAppAi(deps.authorization, scope, appId)
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
