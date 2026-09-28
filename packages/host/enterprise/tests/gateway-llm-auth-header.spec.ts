/**
 * 能力判据：网关令牌**以 `Authorization: Bearer` 的形式出现在模型请求上**。
 *
 * 为什么必须是这样一条判据（而不是"配置里有这个字符串"）：
 *  · 2026-09-22 现场事故的形态就是"配置看着对、请求上没有头" —— 0.1.6 的 messages 适配器
 *    只发 `x-api-key`，我们的网关只认 `Bearer` ⇒ 每个请求 401，而设置里什么都不缺。
 *  · 0.1.7 把鉴权搬到 provider 注册面（`registerDeepSeekProvider(..., { resolveAuth })`），
 *    于是"令牌有没有上请求"完全由我们注册的那个插件决定 —— 这条判据就是那个决定的观测点。
 *
 * 判据的真实性（不是 mock 出来的形状）：
 *  · 真 `Cordis Context` + **真 `LlmRuntime`**（`@deepseek-ai/dsh-llm` 的服务本体）：
 *    provider 路由 `deepseek-official` 由**我们的 `gateway-llm` 插件**注册，走的就是
 *    上游 `registerDeepSeekProvider` → 上游 `DeepSeekAdapter` → 真 `fetch`。
 *  · 上游是本进程内的**真 HTTP 服务器**（`node:http`，记录收到的请求头与路径，回一段
 *    合法的 Messages SSE），不是替换过的 `fetch`。
 *  · 令牌来自 `credentials` 服务的桩（真实现要落盘/keyring，与"头里有没有它"无关）。
 *
 * 反向对照与变异见 `gateway-llm-reverse.spec.ts`：把 `Authorization` 换成 `x-api-key`
 * 会把伪造网关判红（真网关的 401 由 `temp/r4/gateway-bearer-probe.mjs` 对真 Go 服务端跑）。
 *
 * 2026-09-28 追加：**端点硬边界**（`endpointMismatch`）—— 令牌只允许发给**当前会话的
 * `<serverURL>/v1`**。因此本文件的组合必须提供 `picoSession`（生产里由 `picoaide-session`
 * 行提供）；"会话与端点不一致"的用例见文件末尾的 `describe`。
 */
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { MessageId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GATEWAY_LLM_ROW_ID, TOKEN_ENV } from '../src/gateway-contract.ts'
import * as gatewayLlm from '../src/gateway-llm.ts'

/** 网关令牌的假值（公开仓纪律：绝不使用真实凭据）。 */
const TOKEN = 'gw-token-not-a-real-credential'

/** 一段最小但合法的 Messages SSE（`translate()` 的完整生命周期）。 */
const MESSAGES_SSE = [
  ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'smoke', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 0 } } }],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'pong' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }],
  ['message_stop', { type: 'message_stop' }],
].map(([event, payload]) => `event: ${String(event)}\ndata: ${JSON.stringify(payload)}\n\n`).join('')

interface Recorded {
  method: string | undefined
  url: string | undefined
  headers: IncomingMessage['headers']
  body: string
}

/** 真 HTTP 上游：记录每个请求的头与正文，回 Messages SSE。 */
async function recordingUpstream(): Promise<{ origin: string, requests: Recorded[], close: () => Promise<void> }> {
  const requests: Recorded[] = []
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      requests.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(MESSAGES_SSE)
    })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('recording upstream did not bind a TCP port')
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()) }),
  }
}

const contexts: Context[] = []
const closers: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(closers.splice(0).map(close => close()))
})

/**
 * 真组合：真 `LlmRuntime` + 真 `gateway-llm` 插件 + settings/credentials 桩。
 * @param origin - 伪造网关的 origin（写成行 config 的 `baseURL`，与 `gateway-model.ts` 同形）。
 * @param credential - `credentials` 服务解析出的值；`undefined` 表示"没有会话令牌"。
 * @returns 根上下文与请求记录面。
 */
async function boot(
  origin: string,
  credential: string | undefined,
  sessionServerURL: string | null = origin,
): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  ctx.provide('settings', { configure: () => () => {} } as never)
  ctx.provide('credentials', { resolve: async () => (credential === undefined ? undefined : { value: credential, source: 'stub' }) } as never)
  // 端点硬边界的信任锚：当前会话的 serverURL（`gateway-model.ts` 就是用它推出行 baseURL 的）。
  ctx.provide('picoSession', {
    getSession: () => (sessionServerURL === null
      ? null
      : { serverURL: sessionServerURL, username: 'smoke', token: TOKEN }),
  } as never)
  // 行 id 与组装期 `cordis.patch.yml` 一致（`gateway-llm.ts` 会校验它）。
  await ctx.plugin({ name: GATEWAY_LLM_ROW_ID, inject: ['llm', 'credentials'], apply: gatewayLlm.apply } as never, { baseURL: `${origin}/v1` } as never)
  return ctx
}

/** 发一次真实模型调用（真适配器 → 真 fetch → 假上游），返回收到的块。 */
async function callModel(ctx: Context): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of ctx.llm.stream({
    provider: 'deepseek-official',
    model: 'smoke-model',
    messages: [{
      id: MessageId('message-user'),
      role: 'user',
      content: [{ type: 'text', text: 'ping' }],
      source: { kind: 'user' },
    }],
  })) chunks.push(chunk)
  return chunks
}

describe('gateway-llm: 网关令牌真的以 Authorization: Bearer 上了模型请求', () => {
  it('真模型调用把凭据放在 Authorization 上，且 not on x-api-key', async () => {
    const upstream = await recordingUpstream()
    closers.push(upstream.close)
    const ctx = await boot(upstream.origin, TOKEN)

    const chunks = await callModel(ctx)

    expect(upstream.requests).toHaveLength(1)
    const request = upstream.requests[0]
    // 端点就是网关的 Messages 路径（`baseURL` + `/messages`），不是别的协议路径。
    expect(request.url).toBe('/v1/messages')
    expect(request.method).toBe('POST')
    // 判据本体：令牌在 Authorization 上，且**不再**出现在 x-api-key 上。
    expect(request.headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(request.headers['x-api-key']).toBeUndefined()
    // 请求确实是一次完整的 Messages 调用（而不是中途失败的半截请求）。
    expect(request.body).toContain('"messages"')
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('令牌按请求从 credentials 解析（每次调用都读一次，不缓存）', async () => {
    const upstream = await recordingUpstream()
    closers.push(upstream.close)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    ctx.provide('settings', { configure: () => () => {} } as never)
    let served = 0
    const resolve = vi.fn(async () => ({ value: `gw-token-${served += 1}`, source: 'stub' }))
    ctx.provide('credentials', { resolve } as never)
    ctx.provide('picoSession', {
      getSession: () => ({ serverURL: upstream.origin, username: 'smoke', token: TOKEN }),
    } as never)
    await ctx.plugin({ name: GATEWAY_LLM_ROW_ID, inject: ['llm', 'credentials'], apply: gatewayLlm.apply } as never, { baseURL: `${upstream.origin}/v1` } as never)

    await callModel(ctx)
    await callModel(ctx)

    expect(resolve).toHaveBeenCalledTimes(2)
    expect(upstream.requests.map(request => request.headers.authorization))
      .toEqual(['Bearer gw-token-1', 'Bearer gw-token-2'])
  })

  it('变异：摘掉 credentials 里的令牌 ⇒ 调用失败，且**一个请求都没发出去**', async () => {
    const upstream = await recordingUpstream()
    closers.push(upstream.close)
    const ctx = await boot(upstream.origin, undefined)

    const chunks = await callModel(ctx)

    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error' } })
    // fail-closed：缺凭据不是"发一个没有 Authorization 的请求"（那正是 401 的形态）。
    expect(upstream.requests).toEqual([])
  })

  it('装配期：行 id 与组装期那一行不一致 ⇒ 判定为失败（命名空间会错位）', () => {
    // Loader 之外的挂载没有条目 id（无法判定 ⇒ 放行）；真组合里的行 id 由
    // `llm-gateway-protocol-pin.spec.ts` 的组装判据与组装期 YAML 对拍。
    expect(gatewayLlm.rowIdFailure(undefined)).toBeUndefined()
    expect(gatewayLlm.rowIdFailure(GATEWAY_LLM_ROW_ID)).toBeUndefined()
    expect(gatewayLlm.rowIdFailure('renamed-row')).toContain('must keep the id')
  })

  it('装配期：行 config 里带 `protocol`（0.1.7 已删除的键）⇒ 装载即抛错', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    ctx.provide('settings', { configure: () => () => {} } as never)
    ctx.provide('credentials', { resolve: async () => undefined } as never)
    ctx.provide('picoSession', { getSession: () => null } as never)
    const failure = await captureFailure(() => ctx.plugin(
      { name: GATEWAY_LLM_ROW_ID, inject: ['llm', 'credentials'], apply: gatewayLlm.apply } as never,
      { baseURL: 'https://harness.example.com/v1', protocol: 'chat-completions' } as never,
    ))
    expect(failure).toContain('protocol is not configurable')
  })
})

/**
 * 收一个装载失败的**消息**（而不是让 vitest 去打印 Cordis 的失败对象 ——
 * 它上面的 React-ish 字段会让 pretty-format 自己崩，把真正的判定掩盖掉）。
 * @param load - 触发装载的动作。
 * @returns 失败的 message；没有失败时返回 `undefined`。
 */
async function captureFailure(load: () => unknown): Promise<string | undefined> {
  try {
    await load()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  return undefined
}

/** 组装契约的字符串面（`TOKEN_ENV` 是公开契约，两个模块必须用同一个）。 */
describe('gateway-llm: 共享契约', () => {
  it('凭据引用名保持稳定（web-search 行的 apiKeyEnv 也指向它）', () => {
    expect(TOKEN_ENV).toBe('PICOAI_GATEWAY_TOKEN')
    expect(GATEWAY_LLM_ROW_ID).toBe('picoaide-gateway-llm')
  })

  it('行导出 Schemastery 的 `Config`（否则这一行不是可配置条目、设置命名空间写不进去）', () => {
    // `SettingsForms.schema()` 的判据是 `'toJSON' in entry.fiber.runtime.Config`；0.1.7 起
    // **设置命名空间 = profile 条目 id**，`gateway-model.ts`/`bootstrap.ts` 要往里写
    // `baseURL`/`models`/`reasoningEffort` ⇒ 行必须带着能投影成表单的 Config 导出。
    const schema = gatewayLlm.Config as unknown as { toJSON?: unknown }
    expect(typeof schema?.toJSON).toBe('function')
    // 三个被写入的键都在 schema 里（写不存在的键会以 `Config field "…" is not volatile` 抛错）。
    const resolved = (gatewayLlm.Config as unknown as (value: object) => Record<string, unknown>)({})
    for (const key of ['baseURL', 'models', 'reasoningEffort']) expect(Object.hasOwn(resolved, key)).toBe(true)
  })
})


// ── 端点硬边界（2026-09-28）────────────────────────────────────────────────────
// UPG-4 的认账残留：登出后 baseURL 回落 + "已登录但设置写入失败"这两种组合下，
// baseURL 可能是**旧值/回落值**而凭据仍在 ⇒ 员工令牌会被发到那个端点。判据是
// "令牌只发给当前会话的 `<serverURL>/v1`"，并且必须**一个请求都不发**（fail-closed）。
describe('gateway-llm: 网关令牌只发给当前会话的网关端点（硬边界）', () => {
  it('会话与端点一致 ⇒ 照常发送（正常路径逐字不变）', async () => {
    const upstream = await recordingUpstream()
    closers.push(upstream.close)
    // 尾斜杠差异必须被容忍（`https://host/v1/` 与 `https://host/v1` 是同一个端点）。
    const ctx = await boot(upstream.origin, TOKEN, `${upstream.origin}/`)

    const chunks = await callModel(ctx)

    expect(upstream.requests).toHaveLength(1)
    expect(upstream.requests[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('端点与会话不一致 ⇒ 拒绝，且一个请求都没发出去、错误里点名两端且不含令牌', async () => {
    const upstream = await recordingUpstream()
    closers.push(upstream.close)
    // 会话在别的服务器上（= 设置写入失败后留下的旧 baseURL / 登出后的回落值）。
    const ctx = await boot(upstream.origin, TOKEN, 'https://harness.example.com')

    const chunks = await callModel(ctx)

    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error' } })
    expect(upstream.requests).toEqual([])
    const failure = JSON.stringify(chunks.at(-1))
    expect(failure).toContain('https://harness.example.com/v1')
    expect(failure).toContain(upstream.origin)
    expect(failure).not.toContain(TOKEN)
  })

  it('没有登录会话（登出态）但凭据仍在 ⇒ 同样拒绝', async () => {
    const upstream = await recordingUpstream()
    closers.push(upstream.close)
    const ctx = await boot(upstream.origin, TOKEN, null)

    const chunks = await callModel(ctx)

    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error' } })
    expect(upstream.requests).toEqual([])
  })

  it('端点不可解析（相对地址 / 非 http(s) / 带 userinfo）⇒ 一律拒绝', () => {
    expect(gatewayLlm.normalizeGatewayEndpoint('/v1')).toBeUndefined()
    expect(gatewayLlm.normalizeGatewayEndpoint('file:///v1')).toBeUndefined()
    expect(gatewayLlm.normalizeGatewayEndpoint('https://user:pass@harness.example.com/v1')).toBeUndefined()
    expect(gatewayLlm.endpointMismatch('/v1', 'https://harness.example.com/v1')).toContain('unusable endpoint')
    expect(gatewayLlm.endpointMismatch(undefined, 'https://harness.example.com/v1')).toContain('unusable endpoint')
    // 会话缺席 ⇒ 连"允许的端点"都不存在。
    expect(gatewayLlm.allowedGatewayEndpoint(null)).toBeUndefined()
    expect(gatewayLlm.endpointMismatch('https://harness.example.com/v1', undefined)).toContain('no signed-in session')
  })
})
