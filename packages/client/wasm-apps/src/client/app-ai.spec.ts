/**
 * 应用 AI 前端桥（§21）的传输与错误分层判据。
 *
 * 这一套全部在 **node 环境**跑（纯逻辑，无 DOM）：SSE 读法、增量顺序、`done` 收尾、
 * 错误分层、本地请求闸门、取消、以及"按 用户×应用 记一次授权"。
 *
 * ---- 变异验证 ----
 *   - `readAppAiStream` 不检查 `done`（把截断当成功）⇒「没有 done 收尾 ⇒ 协议错误」红；
 *   - `parseAppAiFrame` 把畸形 delta 帧当 `ignore` ⇒「畸形帧必须报协议错误」红；
 *   - `failureFromEnvelope` 丢掉信封 code、只按状态码分流 ⇒「403 + 已知 code」红；
 *   - `validateAppAiRequest` 去掉 16 KiB 字节闸门（或按字符数判）⇒「超限本地拦下」红；
 *   - 取消分支被删（AbortError 当 transport）⇒「取消 ⇒ ai_cancelled」红；
 *   - `appAiConsentKey` 去掉 user 维度 ⇒「授权按用户隔离」红。
 */
import { describe, expect, it } from 'vitest'
import {
  APP_AI_CHAT_PATH,
  APP_AI_ERROR_CODES,
  APP_AI_MESSAGE_MAX_BYTES,
  APP_AI_MESSAGES_MAX,
  appAiConsentKey,
  defaultAppAiConsentStore,
  failureFromEnvelope,
  grantAppAiConsent,
  hasAppAiConsent,
  parseAppAiFrame,
  revokeAppAiConsent,
  streamAppAiChat,
  validateAppAiRequest,
  type AppAiConsentStore,
  type AppAiMessage,
} from './app-ai.ts'

/** 一段 SSE 文本的字节流（按给定分块切开，用来验证跨块的帧边界处理）。 */
function sseResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } })
}

/** 记一次请求的假 fetch。 */
function recordingFetch(reply: Response | (() => Response | Promise<Response>)): { fetch: typeof fetch, calls: Array<{ url: string, init: RequestInit }> } {
  const calls: Array<{ url: string, init: RequestInit }> = []
  return {
    calls,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} })
      return typeof reply === 'function' ? await reply() : reply
    }) as unknown as typeof fetch,
  }
}

const MESSAGES: AppAiMessage[] = [{ role: 'user', content: '你好' }]

describe('SSE 读法：delta 保序 + done 收尾（§21.2）', () => {
  it('按序回调增量，累计正文与各段拼接一致，且打到保留路径', async () => {
    const h = recordingFetch(sseResponse([
      'event: delta\ndata: {"delta":"你"}\n\n',
      'event: delta\ndata: {"delta":"好"}\n\n',
      'event: done\ndata: {}\n\n',
    ]))
    const deltas: string[] = []
    const result = await streamAppAiChat(MESSAGES, { deps: { fetch: h.fetch }, onDelta: delta => { deltas.push(delta) } })
    expect(result).toEqual({ ok: true, content: '你好' })
    expect(deltas).toEqual(['你', '好'])
    expect(h.calls).toHaveLength(1)
    // 保留路径 + 请求体形状（只有 messages 与 stream；未知字段会被服务端拒）。
    expect(h.calls[0]!.url).toBe(APP_AI_CHAT_PATH)
    expect(JSON.parse(String(h.calls[0]!.init.body))).toEqual({ messages: MESSAGES, stream: true })
  })

  it('帧跨字节块切开也能正确解析（SSE 边界不是"每次 read 一帧"）', async () => {
    const h = recordingFetch(sseResponse([
      'event: del',
      'ta\ndata: {"delta":"甲"}\n',
      '\nevent: delta\ndata: {"delta":"乙"}\n\nevent: done\ndata: {}\n\n',
    ]))
    const result = await streamAppAiChat(MESSAGES, { deps: { fetch: h.fetch } })
    expect(result).toEqual({ ok: true, content: '甲乙' })
  })

  it('注释/心跳/未知事件被忽略，不影响内容', async () => {
    const h = recordingFetch(sseResponse([
      ': keep-alive\n\n',
      'event: delta\ndata: {"delta":"甲"}\n\n',
      'event: something-new\ndata: {"x":1}\n\n',
      'event: done\ndata: {}\n\n',
    ]))
    expect(await streamAppAiChat(MESSAGES, { deps: { fetch: h.fetch } })).toEqual({ ok: true, content: '甲' })
  })

  it('没有 done 收尾 ⇒ 协议错误（**不得**把截断当完整回复）', async () => {
    const h = recordingFetch(sseResponse(['event: delta\ndata: {"delta":"半句"}\n\n']))
    const result = await streamAppAiChat(MESSAGES, { deps: { fetch: h.fetch } })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.failure.code).toBe('app_ai_protocol')
    expect(result.failure.message).toContain('done')
  })

  it('畸形 delta 帧 ⇒ 协议错误（不是静默丢弃）', async () => {
    const h = recordingFetch(sseResponse(['event: delta\ndata: {"nope":1}\n\nevent: done\ndata: {}\n\n']))
    const result = await streamAppAiChat(MESSAGES, { deps: { fetch: h.fetch } })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.failure.code).toBe('app_ai_protocol')
  })

  it('非流式（stream:false）读 {content}', async () => {
    const h = recordingFetch(new Response(JSON.stringify({ content: '整段回复' }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const result = await streamAppAiChat(MESSAGES, { deps: { fetch: h.fetch }, stream: false })
    expect(result).toEqual({ ok: true, content: '整段回复' })
    expect(JSON.parse(String(h.calls[0]!.init.body))).toEqual({ messages: MESSAGES, stream: false })
  })
})

describe('错误分层（§21.2 的五个信封 code + 两条客户端分类）', () => {
  it('五个冻结 code 都能从 JSON 信封读出（外层优先：信封 code 说了算）', async () => {
    for (const code of APP_AI_ERROR_CODES) {
      const h = recordingFetch(new Response(JSON.stringify({ error: { code, message: `msg:${code}` } }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }))
      const result = await streamAppAiChat(MESSAGES, { deps: { fetch: h.fetch } })
      expect(result.ok, code).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.failure.code, code).toBe(code)
      expect(result.failure.message).toBe(`msg:${code}`)
      expect(result.failure.status).toBe(403)
    }
  })

  it('信封 code 可识别时不按状态码改写（403 + ai_rate_limited 仍是限流）', async () => {
    expect(failureFromEnvelope({ error: { code: 'ai_rate_limited', message: 'slow down' } }, 403))
      .toEqual({ code: 'ai_rate_limited', message: 'slow down', status: 403 })
  })

  it('信封不可识别时按状态就近归属（401/402 ⇒ 不可用/账号不可用，5xx ⇒ 不可用）', () => {
    expect(failureFromEnvelope({ error: { code: 'SOMETHING_NEW' } }, 401).code).toBe('app_ai_unavailable')
    expect(failureFromEnvelope({}, 402).code).toBe('ai_balance_insufficient')
    expect(failureFromEnvelope({}, 503).code).toBe('app_ai_unavailable')
    // 都不是 ⇒ 协议错误（绝不把认不出的东西说成"被拒绝"）。
    expect(failureFromEnvelope({ error: { code: 'SOMETHING_NEW' } }, 400).code).toBe('app_ai_protocol')
  })

  it('流中 error 帧按同一套分层读出', async () => {
    const h = recordingFetch(sseResponse([
      'event: delta\ndata: {"delta":"半"}\n\n',
      'event: error\ndata: {"error":{"code":"ai_balance_insufficient","message":"no funds"}}\n\n',
    ]))
    const result = await streamAppAiChat(MESSAGES, { deps: { fetch: h.fetch } })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.failure.code).toBe('ai_balance_insufficient')
  })

  it('网络层异常 ⇒ transport（与"服务端说不行"区分开）', async () => {
    const h = recordingFetch(() => { throw new TypeError('ECONNREFUSED') })
    const result = await streamAppAiChat(MESSAGES, { deps: { fetch: h.fetch } })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.failure.code).toBe('app_ai_transport')
    expect(result.failure.status).toBeNull()
  })

  it('取消 ⇒ ai_cancelled（不是错误弹窗）', async () => {
    const controller = new AbortController()
    const h = recordingFetch(() => { controller.abort(); throw Object.assign(new Error('aborted'), { name: 'AbortError' }) })
    const result = await streamAppAiChat(MESSAGES, { deps: { fetch: h.fetch }, signal: controller.signal })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.failure.code).toBe('ai_cancelled')
  })
})

describe('本地请求闸门（§21.2：messages ≤64 条、单条 ≤16 KiB）', () => {
  it('合法请求通过', () => {
    expect(validateAppAiRequest(MESSAGES)).toBeNull()
    expect(validateAppAiRequest([{ role: 'assistant', content: 'ok' }])).toBeNull()
  })

  it('条数上限 64（65 条本地就拒，不发请求）', async () => {
    const many = Array.from({ length: APP_AI_MESSAGES_MAX + 1 }, () => ({ role: 'user' as const, content: 'x' }))
    expect(validateAppAiRequest(many)?.code).toBe('app_ai_protocol')
    const h = recordingFetch(sseResponse(['event: done\ndata: {}\n\n']))
    const result = await streamAppAiChat(many, { deps: { fetch: h.fetch } })
    expect(result.ok).toBe(false)
    expect(h.calls).toEqual([])
  })

  it('单条 16 KiB 按 UTF-8 **字节**判（中文 3 字节 ⇒ 6000 字已超限）', async () => {
    const asciiOk = 'a'.repeat(APP_AI_MESSAGE_MAX_BYTES)
    expect(validateAppAiRequest([{ role: 'user', content: asciiOk }])).toBeNull()
    const asciiOver = validateAppAiRequest([{ role: 'user', content: 'a'.repeat(APP_AI_MESSAGE_MAX_BYTES + 1) }])
    expect(asciiOver).not.toBeNull()
    expect(asciiOver?.message).toContain('over the')
    const cjk = '字'.repeat(Math.floor(APP_AI_MESSAGE_MAX_BYTES / 3) + 1)
    expect(validateAppAiRequest([{ role: 'user', content: cjk }])?.message).toContain('over the')
  })

  it('角色/形状不对也本地拒（不发请求）', () => {
    expect(validateAppAiRequest([])?.code).toBe('app_ai_protocol')
    expect(validateAppAiRequest('nope')?.code).toBe('app_ai_protocol')
    expect(validateAppAiRequest([{ role: 'system', content: 'x' }])?.code).toBe('app_ai_protocol')
    expect(validateAppAiRequest([{ role: 'user', content: 42 }])?.code).toBe('app_ai_protocol')
    expect(validateAppAiRequest([null])?.code).toBe('app_ai_protocol')
  })
})

describe('帧解析的边界（纯函数）', () => {
  it('parseAppAiFrame：delta / done / error / 忽略', () => {
    expect(parseAppAiFrame('event: delta\ndata: {"delta":"x"}')).toEqual({ type: 'delta', delta: 'x' })
    expect(parseAppAiFrame('event: done\ndata: {}')).toEqual({ type: 'done' })
    expect(parseAppAiFrame('event: done')).toEqual({ type: 'done' })
    expect(parseAppAiFrame(': comment')).toEqual({ type: 'ignore' })
    expect(parseAppAiFrame('event: other\ndata: {"a":1}')).toEqual({ type: 'ignore' })
    const error = parseAppAiFrame('event: error\ndata: {"error":{"code":"app_ai_denied","message":"no"}}')
    expect(error.type).toBe('error')
  })

  it('data 字段不带空格 / 多行 data 也能读（SSE 规范）', () => {
    expect(parseAppAiFrame('event: delta\ndata:{"delta":"y"}')).toEqual({ type: 'delta', delta: 'y' })
    expect(parseAppAiFrame('event: delta\ndata: {"delta"\ndata: :"z"}')).toEqual({ type: 'delta', delta: 'z' })
  })
})

describe('首次授权：按 **用户×应用** 记一次，可撤销（§21.1 第 9 条）', () => {
  /** 内存存储。 */
  function memory(): AppAiConsentStore & { values: Map<string, string> } {
    const values = new Map<string, string>()
    return {
      values,
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value) },
      removeItem: key => { values.delete(key) },
    }
  }

  it('未授权 ⇒ false；授权后 ⇒ true；撤销后 ⇒ false', () => {
    const store = memory()
    expect(hasAppAiConsent('alice', 'roster', store)).toBe(false)
    grantAppAiConsent('alice', 'roster', store)
    expect(hasAppAiConsent('alice', 'roster', store)).toBe(true)
    revokeAppAiConsent('alice', 'roster', store)
    expect(hasAppAiConsent('alice', 'roster', store)).toBe(false)
  })

  it('两个维度都隔离：换用户、换应用都必须重新问', () => {
    const store = memory()
    grantAppAiConsent('alice', 'roster', store)
    expect(hasAppAiConsent('bob', 'roster', store)).toBe(false)
    expect(hasAppAiConsent('alice', 'invoice', store)).toBe(false)
    // 键里两个维度都在（用不同的顺序/拼接也不会撞：用 encodeURIComponent 分隔）。
    expect(appAiConsentKey('a:b', 'c')).not.toBe(appAiConsentKey('a', 'b:c'))
  })

  it('身份为空 / 存储不可用 ⇒ 一律"未授权"（fail-closed，不静默放行）', () => {
    const store = memory()
    expect(hasAppAiConsent('', 'roster', store)).toBe(false)
    expect(hasAppAiConsent('alice', '', store)).toBe(false)
    grantAppAiConsent('', 'roster', store)
    expect(store.values.size).toBe(0)
    expect(hasAppAiConsent('alice', 'roster', null)).toBe(false)
    expect(() => { grantAppAiConsent('alice', 'roster', null) }).not.toThrow()
    expect(() => { revokeAppAiConsent('alice', 'roster', null) }).not.toThrow()
  })

  it('存储抛异常时不抛穿（按未授权处理）', () => {
    const broken: AppAiConsentStore = {
      getItem: () => { throw new Error('SecurityError') },
      setItem: () => { throw new Error('SecurityError') },
      removeItem: () => { throw new Error('SecurityError') },
    }
    expect(hasAppAiConsent('alice', 'roster', broken)).toBe(false)
    expect(() => { grantAppAiConsent('alice', 'roster', broken) }).not.toThrow()
    expect(() => { revokeAppAiConsent('alice', 'roster', broken) }).not.toThrow()
  })

  it('默认存储实现：node 环境没有 localStorage ⇒ null（不抛）', () => {
    expect(defaultAppAiConsentStore()).toBeNull()
  })
})
