/**
 * 应用 AI 桥（§21）：线上契约、首次授权闸门、隐藏会话寻址、SSE 帧与取消。
 *
 * 变异验证：把 `gateAppAi` 的顺序反过来（先跑一轮再查授权）⇒ "未授权不消耗 token"
 * 必红；把 `parseAiChatRequest` 的未知字段检查去掉 ⇒ 严格校验用例必红。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  AI_CHAT_MAX_CONTENT_BYTES,
  AI_CHAT_MAX_MESSAGES,
  AI_CHAT_PATH,
  gateAppAi,
  handleAiChat,
  hiddenSessionId,
  parseAiChatRequest,
  sseFrame,
  type AiChatAuthorization,
  type AiChatTurnRunner,
} from './ai-chat.ts'

/** 授权记录替身。 */
function authorizationOf(granted: boolean): AiChatAuthorization & { granted: Set<string> } {
  const grantedKeys = new Set<string>(granted ? ['alice|my-notes'] : [])
  return {
    granted: grantedKeys,
    isGranted: async (userId, appId) => grantedKeys.has(`${userId}|${appId}`),
    grant: async (userId, appId) => { grantedKeys.add(`${userId}|${appId}`) },
    revoke: async (userId, appId) => { grantedKeys.delete(`${userId}|${appId}`) },
  }
}

/** 一轮 AI 替身（逐字回显 + 两个增量）。 */
function runnerOf(overrides: Partial<AiChatTurnRunner> = {}): AiChatTurnRunner & { calls: number } {
  const state = { calls: 0 }
  return {
    get calls() { return state.calls },
    async run(input) {
      state.calls += 1
      input.onDelta('a')
      input.onDelta('b')
      return { content: `echo:${input.messages.map(message => message.content).join('')}`, usage: { promptTokens: 1, completionTokens: 2 } }
    },
    ...overrides,
  }
}

const body = (value: unknown): Uint8Array => Buffer.from(JSON.stringify(value))

/** 读完一个 SSE 结果的全部帧。 */
async function framesOf(outcome: Awaited<ReturnType<typeof handleAiChat>>): Promise<string[]> {
  if (outcome.kind !== 'sse') throw new Error('expected an SSE outcome')
  const frames: string[] = []
  for await (const frame of outcome.frames) frames.push(frame)
  return frames
}

describe('frozen wire contract (§21.2)', () => {
  it('keeps the reserved path and the hidden session id', () => {
    expect(AI_CHAT_PATH).toBe('/__picoaide/ai/chat')
    expect(hiddenSessionId('my-notes')).toBe('app:my-notes')
  })

  it('rejects unknown fields, bad roles, oversize and empty payloads', () => {
    expect(parseAiChatRequest({ messages: [{ role: 'user', content: 'hi' }] }).ok).toBe(true)
    expect(parseAiChatRequest({ messages: [{ role: 'user', content: 'hi' }], system: 'x' }).ok).toBe(false)
    expect(parseAiChatRequest({ messages: [{ role: 'user', content: 'hi', extra: 1 }] }).ok).toBe(false)
    expect(parseAiChatRequest({ messages: [{ role: 'tool', content: 'hi' }] }).ok).toBe(false)
    expect(parseAiChatRequest({ messages: [] }).ok).toBe(false)
    expect(parseAiChatRequest({ messages: 'x' }).ok).toBe(false)
    expect(parseAiChatRequest({ messages: [{ role: 'user', content: 'x'.repeat(AI_CHAT_MAX_CONTENT_BYTES + 1) }] }).ok).toBe(false)
    expect(parseAiChatRequest({
      messages: Array.from({ length: AI_CHAT_MAX_MESSAGES + 1 }, () => ({ role: 'user', content: 'x' })),
    }).ok).toBe(false)
    expect(parseAiChatRequest({ messages: [{ role: 'user', content: 'hi' }], stream: 'yes' }).ok).toBe(false)
    // `stream` 缺省 = 流式（应用侧最常用的形态）。
    const parsed = parseAiChatRequest({ messages: [{ role: 'user', content: 'hi' }] })
    expect(parsed.ok && parsed.request.stream).toBe(true)
    expect(parsed.ok && parsed.request.messages.length).toBe(1)
  })

  it('frames SSE events as event + single-line JSON data', () => {
    expect(sseFrame('delta', { delta: 'a\nb' })).toBe('event: delta\ndata: {"delta":"a\\nb"}\n\n')
    expect(sseFrame('done', { content: '' })).toBe('event: done\ndata: {"content":""}\n\n')
  })
})

describe('authorization gate (§21.1 Q9 / §21.6)', () => {
  it('refuses with 403 app_ai_denied and consumes no tokens', async () => {
    const runner = runnerOf()
    const outcome = await handleAiChat(
      { authorization: authorizationOf(false), runner, userId: () => 'alice' },
      'my-notes',
      body({ messages: [{ role: 'user', content: 'hi' }] }),
      new AbortController().signal,
    )
    expect(outcome).toMatchObject({ kind: 'json', status: 403 })
    expect(JSON.stringify(outcome)).toContain('app_ai_denied')
    // 判据顺序是契约的一部分：**先**查授权再碰模型。
    expect(runner.calls).toBe(0)
  })

  it('serves after the user granted once, and revoking refuses again', async () => {
    const authorization = authorizationOf(false)
    const runner = runnerOf()
    const deps = { authorization, runner, userId: () => 'alice' }
    const request = body({ messages: [{ role: 'user', content: 'hi' }], stream: false })
    expect((await handleAiChat(deps, 'my-notes', request, new AbortController().signal)).kind).toBe('json')
    await authorization.grant('alice', 'my-notes')
    const granted = await handleAiChat(deps, 'my-notes', request, new AbortController().signal)
    expect(granted).toMatchObject({ kind: 'json', status: 200, body: { content: 'echo:hi' } })
    expect(runner.calls).toBe(1)
    await authorization.revoke('alice', 'my-notes')
    await expect(gateAppAi(authorization, 'alice', 'my-notes')).resolves.toMatchObject({ ok: false, code: 'app_ai_denied' })
  })

  it('reports a readable unavailable error instead of silently returning an empty answer', async () => {
    const outcome = await handleAiChat(
      { authorization: authorizationOf(true), runner: undefined, userId: () => 'alice' },
      'my-notes',
      body({ messages: [{ role: 'user', content: 'hi' }] }),
      new AbortController().signal,
    )
    expect(outcome).toMatchObject({ kind: 'json', status: 503 })
    expect(JSON.stringify(outcome)).toContain('app_ai_unavailable')
  })
})

describe('streaming and cancellation (§21.6)', () => {
  it('streams delta frames in order and closes with done', async () => {
    const outcome = await handleAiChat(
      { authorization: authorizationOf(true), runner: runnerOf(), userId: () => 'alice' },
      'my-notes',
      body({ messages: [{ role: 'user', content: 'hi' }] }),
      new AbortController().signal,
    )
    const frames = await framesOf(outcome)
    expect(frames).toEqual([
      sseFrame('delta', { delta: 'a' }),
      sseFrame('delta', { delta: 'b' }),
      sseFrame('done', { content: 'echo:hi', usage: { promptTokens: 1, completionTokens: 2 } }),
    ])
  })

  it('passes the app session id and only this turn\'s messages (无工具/无记忆注入面)', async () => {
    const seen: Array<{ sessionId: string, appId: string, messages: readonly unknown[] }> = []
    const runner: AiChatTurnRunner = {
      async run(input) {
        seen.push({ sessionId: input.sessionId, appId: input.appId, messages: input.messages })
        return { content: 'ok' }
      },
    }
    await handleAiChat(
      { authorization: authorizationOf(true), runner, userId: () => 'alice' },
      'my-notes',
      body({ messages: [{ role: 'user', content: 'hi' }], stream: false }),
      new AbortController().signal,
    )
    expect(seen).toEqual([{ sessionId: 'app:my-notes', appId: 'my-notes', messages: [{ role: 'user', content: 'hi' }] }])
  })

  it('aborts the turn when the page goes away and reports ai_cancelled', async () => {
    const controller = new AbortController()
    const runner: AiChatTurnRunner = {
      async run(input) {
        input.signal.addEventListener('abort', () => {})
        if (input.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
        controller.abort()
        throw Object.assign(new Error('page closed'), { name: 'AbortError' })
      },
    }
    const outcome = await handleAiChat(
      { authorization: authorizationOf(true), runner, userId: () => 'alice' },
      'my-notes',
      body({ messages: [{ role: 'user', content: 'hi' }], stream: false }),
      controller.signal,
    )
    expect(JSON.stringify(outcome)).toContain('ai_cancelled')
  })

  it('maps balance / rate-limit failures to the frozen error codes', async () => {
    const failing = (message: string): AiChatTurnRunner => ({ run: async () => { throw new Error(message) } })
    const deps = (runner: AiChatTurnRunner) => ({ authorization: authorizationOf(true), runner, userId: () => 'alice' })
    const request = body({ messages: [{ role: 'user', content: 'hi' }], stream: false })
    const balance = await handleAiChat(deps(failing('insufficient balance')), 'my-notes', request, new AbortController().signal)
    expect(JSON.stringify(balance)).toContain('ai_balance_insufficient')
    const limited = await handleAiChat(deps(failing('rate limited: too many requests')), 'my-notes', request, new AbortController().signal)
    expect(JSON.stringify(limited)).toContain('ai_rate_limited')
    const broken = await handleAiChat(deps(failing('socket hang up')), 'my-notes', request, new AbortController().signal)
    expect(JSON.stringify(broken)).toContain('app_ai_unavailable')
  })

  it('rejects a malformed body without touching the runner', async () => {
    const runner = runnerOf()
    const outcome = await handleAiChat(
      { authorization: authorizationOf(true), runner, userId: () => 'alice' },
      'my-notes',
      Buffer.from('{ not json'),
      new AbortController().signal,
    )
    expect(outcome).toMatchObject({ kind: 'json', status: 400 })
    expect(runner.calls).toBe(0)
    const warn = vi.fn()
    const signedOut = await handleAiChat(
      { authorization: authorizationOf(true), runner, userId: () => null, warn },
      'my-notes',
      body({ messages: [{ role: 'user', content: 'hi' }] }),
      new AbortController().signal,
    )
    expect(signedOut).toMatchObject({ kind: 'json', status: 401 })
    expect(runner.calls).toBe(0)
  })
})
