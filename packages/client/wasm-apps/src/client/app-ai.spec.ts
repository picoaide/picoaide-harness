/**
 * 应用 AI 前端桥（§21）的传输与错误分层判据。
 *
 * 这一套全部在 **node 环境**跑（纯逻辑，无 DOM）：SSE 读法、增量顺序、`done` 收尾、
 * 错误分层、本地请求闸门、取消、以及"按 用户×服务端×应用 记一次授权"。
 *
 * ---- 变异验证 ----
 *   - `readAppAiStream` 不检查 `done`（把截断当成功）⇒「没有 done 收尾 ⇒ 协议错误」红；
 *   - `parseAppAiFrame` 把畸形 delta 帧当 `ignore` ⇒「畸形帧必须报协议错误」红；
 *   - `failureFromEnvelope` 丢掉信封 code、只按状态码分流 ⇒「403 + 已知 code」红；
 *   - `validateAppAiRequest` 去掉 16 KiB 字节闸门（或按字符数判）⇒「超限本地拦下」红；
 *   - 取消分支被删（AbortError 当 transport）⇒「取消 ⇒ ai_cancelled」红；
 *   - `appAiConsentKey` 去掉 user 维度 ⇒「授权按用户隔离」红；
 *   - `appAiConsentKey` 去掉 server 维度（回到两段）⇒「换服务端必须重新问」红；
 *   - `loadAppAiIdentity` 在缺 `serverURL` 时仍返回作用域 ⇒ 它的 fail-closed 条红。
 */
import { describe, expect, it } from 'vitest'
import { HOST_PROOF_PATH, setHostProofToken } from './host-proof.ts'
import {
  APP_AI_CHAT_PATH,
  APP_AI_CONSENT_PATH,
  APP_AI_IDENTITY_PATH,
  APP_AI_ERROR_CODES,
  APP_AI_MESSAGE_MAX_BYTES,
  APP_AI_MESSAGES_MAX,
  appAiConsentKey,
  defaultAppAiConsentStore,
  failureFromEnvelope,
  grantAppAiConsent,
  hasAppAiConsent,
  loadAppAiIdentity,
  parseAppAiFrame,
  revokeAppAiConsent,
  streamAppAiChat,
  syncAppAiConsent,
  validateAppAiRequest,
  type AppAiConsentStore,
  type AppAiMessage,
  type AppAiScope,
} from './app-ai.ts'

/** 两台服务端（换租户场景：本仓测试/正式并存 + 同机第二栈是常态）。 */
const SERVER_A = 'https://a.harness.example.com'
const SERVER_B = 'https://b.harness.example.com'

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

describe('首次授权：按 **用户×服务端×应用** 记一次，可撤销（§21.1 第 9 条 / R21 FIX-7 ①）', () => {
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

  /** 测试用作用域（与宿主闸门同一形状：用户 + 服务端）。 */
  const onServer = (userId: string, serverURL = SERVER_A): AppAiScope => ({ userId, serverURL })

  it('未授权 ⇒ false；授权后 ⇒ true；撤销后 ⇒ false', () => {
    const store = memory()
    expect(hasAppAiConsent(onServer('alice'), 'roster', store)).toBe(false)
    grantAppAiConsent(onServer('alice'), 'roster', store)
    expect(hasAppAiConsent(onServer('alice'), 'roster', store)).toBe(true)
    revokeAppAiConsent(onServer('alice'), 'roster', store)
    expect(hasAppAiConsent(onServer('alice'), 'roster', store)).toBe(false)
  })

  it('三个维度都隔离：换用户、换应用、**换服务端**都必须重新问', () => {
    const store = memory()
    grantAppAiConsent(onServer('alice'), 'roster', store)
    expect(hasAppAiConsent(onServer('bob'), 'roster', store)).toBe(false)
    expect(hasAppAiConsent(onServer('alice'), 'invoice', store)).toBe(false)
    // 本条是 R21 FIX-7 ① 的核心：宿主闸门升成 (用户, 服务端, 应用) 之后，客户端这份
    // "已经问过"的 UI 记忆必须同域 —— 否则换过服务端的面板会**跳过说明卡**，
    // 用户发第一条消息才吃 403（静默失败）。
    expect(hasAppAiConsent(onServer('alice', SERVER_B), 'roster', store)).toBe(false)
    expect(appAiConsentKey(onServer('alice', SERVER_B), 'roster'))
      .not.toBe(appAiConsentKey(onServer('alice', SERVER_A), 'roster'))
    // 键里三个维度都在（不同顺序/拼接也不会撞：用 encodeURIComponent 分隔）。
    expect(appAiConsentKey(onServer('a:b'), 'c')).not.toBe(appAiConsentKey(onServer('a'), 'b:c'))
  })

  it('换服务端后重新授权**不会**动另一台服务端的记录（各段只影响自己那一段）', () => {
    const store = memory()
    grantAppAiConsent(onServer('alice', SERVER_A), 'roster', store)
    grantAppAiConsent(onServer('alice', SERVER_B), 'roster', store)
    expect(hasAppAiConsent(onServer('alice', SERVER_A), 'roster', store)).toBe(true)
    expect(hasAppAiConsent(onServer('alice', SERVER_B), 'roster', store)).toBe(true)
    revokeAppAiConsent(onServer('alice', SERVER_B), 'roster', store)
    expect(hasAppAiConsent(onServer('alice', SERVER_B), 'roster', store)).toBe(false)
    expect(hasAppAiConsent(onServer('alice', SERVER_A), 'roster', store)).toBe(true)
  })

  it('作用域缺任一段 / 存储不可用 ⇒ 一律"未授权"且零写入（fail-closed，不静默放行）', () => {
    const store = memory()
    // 拿不到服务端地址 ⇒ 当成"没问过"（宁可多问一次），**不是**"无服务端"的两段作用域。
    expect(hasAppAiConsent(onServer('alice', ''), 'roster', store)).toBe(false)
    expect(hasAppAiConsent({ userId: 'alice', serverURL: '   ' }, 'roster', store)).toBe(false)
    expect(hasAppAiConsent({ userId: '', serverURL: SERVER_A }, 'roster', store)).toBe(false)
    expect(hasAppAiConsent({ userId: 'alice', serverURL: SERVER_A }, '', store)).toBe(false)
    expect(hasAppAiConsent(null, 'roster', store)).toBe(false)
    expect(hasAppAiConsent(undefined, 'roster', store)).toBe(false)
    grantAppAiConsent(onServer('alice', ''), 'roster', store)
    grantAppAiConsent({ userId: '', serverURL: SERVER_A }, 'roster', store)
    grantAppAiConsent(null, 'roster', store)
    expect(store.values.size).toBe(0)
    expect(hasAppAiConsent(onServer('alice'), 'roster', null)).toBe(false)
    expect(() => { grantAppAiConsent(onServer('alice'), 'roster', null) }).not.toThrow()
    expect(() => { revokeAppAiConsent(onServer('alice'), 'roster', null) }).not.toThrow()
  })

  it('段内含 NUL ⇒ 构键为 null（与宿主同一条判据；不许静默变成"问过了"）', () => {
    const store = memory()
    expect(appAiConsentKey({ userId: 'a\u0000b', serverURL: SERVER_A }, 'roster')).toBeNull()
    expect(appAiConsentKey({ userId: 'alice', serverURL: `a\u0000b` }, 'roster')).toBeNull()
    expect(appAiConsentKey(onServer('alice'), 'a\u0000b')).toBeNull()
    grantAppAiConsent({ userId: 'a\u0000b', serverURL: SERVER_A }, 'roster', store)
    expect(store.values.size).toBe(0)
  })

  it('各段先 trim 再用（与宿主同一份归一化；纯空白不算"有值"）', () => {
    const store = memory()
    grantAppAiConsent({ userId: '  alice  ', serverURL: `  ${SERVER_A}  ` }, ' roster ', store)
    expect(hasAppAiConsent(onServer('alice'), 'roster', store)).toBe(true)
  })

  it('存储抛异常时不抛穿（按未授权处理）', () => {
    const broken: AppAiConsentStore = {
      getItem: () => { throw new Error('SecurityError') },
      setItem: () => { throw new Error('SecurityError') },
      removeItem: () => { throw new Error('SecurityError') },
    }
    expect(hasAppAiConsent(onServer('alice'), 'roster', broken)).toBe(false)
    expect(() => { grantAppAiConsent(onServer('alice'), 'roster', broken) }).not.toThrow()
    expect(() => { revokeAppAiConsent(onServer('alice'), 'roster', broken) }).not.toThrow()
  })

  it('默认存储实现：node 环境没有 localStorage ⇒ null（不抛）', () => {
    expect(defaultAppAiConsentStore()).toBeNull()
  })
})


describe('授权同步：允许/撤销真的写到宿主（§21.1 第 9 条 / §21.6 判据 3）', () => {
  /** 造一个"宿主机"：引导端点发令牌，授权路由记录请求体。 */
  function hostStub(consentStatus = 200): { calls: Array<{ url: string, body: unknown }>, fetch: typeof fetch } {
    const calls: Array<{ url: string, body: unknown }> = []
    const impl = (async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      if (url === HOST_PROOF_PATH) {
        return new Response(JSON.stringify({ proof: 'p', expires_at: Date.now() + 300_000 }), { status: 200 })
      }
      calls.push({ url, body: JSON.parse(String(init?.body ?? 'null')) })
      return new Response(JSON.stringify(consentStatus === 200 ? { app_id: 'demo', granted: true } : { error: 'nope' }), { status: consentStatus })
    }) as unknown as typeof fetch
    return { calls, fetch: impl }
  }

  it('allow ⇒ POST 到本机授权路由，带 app_id 与 granted:true', async () => {
    const host = hostStub()
    const result = await syncAppAiConsent('demo', true, { fetch: host.fetch })
    expect(result).toEqual({ ok: true })
    expect(host.calls).toEqual([{ url: APP_AI_CONSENT_PATH, body: { app_id: 'demo', granted: true } }])
  })

  it('revoke ⇒ 同一个路由、granted:false', async () => {
    const host = hostStub()
    await syncAppAiConsent('demo', false, { fetch: host.fetch })
    expect(host.calls).toEqual([{ url: APP_AI_CONSENT_PATH, body: { app_id: 'demo', granted: false } }])
  })

  it('宿主拒绝（500）⇒ ok:false（界面据此**不得**显示"已允许"）', async () => {
    const host = hostStub(500)
    const result = await syncAppAiConsent('demo', true, { fetch: host.fetch })
    expect(result.ok).toBe(false)
  })

  it('拿不到持有性证明 ⇒ 一个业务请求都不发，返回 ok:false', async () => {
    // 令牌在模块内存里缓存（页面级），先清掉：本用例要证的是"拿不到"这一支。
    setHostProofToken(null)
    const calls: string[] = []
    const refused = (async (input: unknown) => {
      calls.push(String(input))
      return new Response('{}', { status: 403 })
    }) as unknown as typeof fetch
    const result = await syncAppAiConsent('demo', true, { fetch: refused })
    expect(result.ok).toBe(false)
    expect(calls).toEqual([HOST_PROOF_PATH])
  })
})

/**
 * 授权作用域必须与**宿主闸门**同源（审计 C-25 的判据在 R21 FIX-7 ① 换了方向）。
 *
 * 宿主（`wasm-apps-host/src/ai-authorization.ts`）现在按
 * `aiConsentKey({userId, serverURL}, appId)` 记授权（用户 ⊕ 服务端 ⊕ 应用，落盘
 * `version: 2`，第二十一轮 B2-R21-01 从两段升成三段）。客户端这份**只决定"还要不要
 * 再弹一次说明卡"**的 UI 记忆若还停在 `(用户, 应用)`：换过服务端之后面板会**跳过**
 * 说明卡，用户发第一条消息才吃 403 —— 静默失败。修法＝两段都取、逐段同源。
 *
 * 逐段/段序的对拍在 `consent-key-parity.spec.ts`（它读宿主源码）；本组钉行为：
 * 身份解析的 fail-closed 方向 + 换服务端必须重新问。
 *
 * 变异验证：`loadAppAiIdentity` 在缺 `serverURL` 时仍返回作用域 ⇒ 本条红；
 * `appAiConsentKey` 丢掉服务端段 ⇒「换服务端必须重新问」红。
 */
describe('loadAppAiIdentity：授权作用域与宿主同源（R21 FIX-7 ①）', () => {
  const respond = (body: unknown, status = 200): typeof fetch =>
    (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch

  it('返回用户 + 服务端两段（与宿主闸门同一份会话快照）', async () => {
    const identity = await loadAppAiIdentity({ fetch: respond({ loggedIn: true, username: 'alice', serverURL: 'https://harness.example.com' }) })
    expect(identity).toEqual({ userId: 'alice', serverURL: 'https://harness.example.com' })
  })

  it('两端各自 trim（与宿主 `aiConsentKey` 的归一化一致）', async () => {
    const identity = await loadAppAiIdentity({ fetch: respond({ loggedIn: true, username: '  alice  ', serverURL: '  https://harness.example.com  ' }) })
    expect(identity).toEqual({ userId: 'alice', serverURL: 'https://harness.example.com' })
  })

  it('未登录 / 缺任一段 ⇒ null（fail-closed：宁可多问一次，也不静默跳过说明卡）', async () => {
    expect(await loadAppAiIdentity({ fetch: respond({ loggedIn: false }) })).toBeNull()
    expect(await loadAppAiIdentity({ fetch: respond({ loggedIn: true, username: '   ', serverURL: 'https://harness.example.com' }) })).toBeNull()
    // 本条是"拿不到服务端地址 ⇒ 当成没问过"的判据（不得退化成两段作用域）。
    expect(await loadAppAiIdentity({ fetch: respond({ loggedIn: true, username: 'alice' }) })).toBeNull()
    expect(await loadAppAiIdentity({ fetch: respond({ loggedIn: true, username: 'alice', serverURL: '   ' }) })).toBeNull()
    expect(await loadAppAiIdentity({ fetch: respond({ loggedIn: true, username: 'alice', serverURL: null }) })).toBeNull()
    expect(await loadAppAiIdentity({ fetch: respond({ loggedIn: true }) })).toBeNull()
    expect(await loadAppAiIdentity({ fetch: respond({ loggedIn: true, username: 'alice', serverURL: 'https://harness.example.com' }, 500) })).toBeNull()
    expect(await loadAppAiIdentity({ fetch: (async () => { throw new Error('offline') }) as unknown as typeof fetch })).toBeNull()
  })

  it('段内含 NUL ⇒ null（与宿主同判据）', async () => {
    expect(await loadAppAiIdentity({ fetch: respond({ loggedIn: true, username: 'a\u0000b', serverURL: 'https://harness.example.com' }) })).toBeNull()
    expect(await loadAppAiIdentity({ fetch: respond({ loggedIn: true, username: 'alice', serverURL: 'https://harness.example.com\u0000x' }) })).toBeNull()
  })

  it('读身份的路由是本机只读的 /api/pico/auth/state', async () => {
    let seen = ''
    const spy = (async (input: unknown) => {
      seen = String(input)
      return new Response(JSON.stringify({ loggedIn: true, username: 'alice', serverURL: 'https://harness.example.com' }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    await loadAppAiIdentity({ fetch: spy })
    expect(seen).toBe(APP_AI_IDENTITY_PATH)
  })
})
