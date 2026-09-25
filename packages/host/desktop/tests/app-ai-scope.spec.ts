/**
 * 应用 AI 隐藏会话的**账号作用域**与**换账号释放**（R13-GB；收编第十三轮审计
 * B-P0-1 / R13-E-04 的真 agent-loop 探针）。
 *
 * 缺陷形态（两路独立命中，修复前实测）：隐藏会话 id 只有应用维度（`app:<app_id>`），
 * 而它同时是 ①本机多轮上下文的键、②`live`/`queues` 的键。桌面壳的 runner **进程级
 * provide 一次**、且全文件没有任何 `pico/session-changed` 释放路径 ⇒ 同一台机器上
 * **先 A 后 B**（共用工作站的常见形态）时，B 那一轮的**真实模型请求里带着 A 的 user
 * 消息与 assistant 回复**；反向，B 的取消会 `dispose` 掉 A 的活体会话。
 *
 * 本文件把探针收成正式判据，四条：
 *  - ①两个账号（同一个应用、同一个服务端）拿到**不同**的 sessionId；
 *    同名账号在**不同服务端**上也是不同的会话（测试/正式并存的租户维度）；
 *  - ②B 的第一轮请求体**不含** A 的内容（真 agent-loop + 记录请求体的假适配器）；
 *  - ③`pico/session-changed` 之后 `live`/`queues` 清空，且**排队中的那一轮被拒**
 *    （不是"清完记账又把它跑起来"）；
 *  - ④反向对照：**同账号**第二轮仍带第一轮上下文（多轮不能被"修好作用域"顺手砍掉）。
 *
 * 变异验证（拆掉即红）：
 *  - 把 `hiddenSessionId` 的账号作用域去掉（退回 `app:<app_id>`）⇒ ①②红；
 *  - 去掉 `createAppAiRunner` 里的 `subscribeSessionChanges` ⇒ ③红；
 *  - 把 `run()` 里的代次检查去掉 ⇒ ③的"排队轮次被拒"红。
 */
import { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import { afterEach, describe, expect, it } from 'vitest'
import { createAppAiRunner } from '../src/app-ai-runner.ts'
import { gateAppAi, type AiChatAuthorization, type AiChatMessage, type AiChatScope } from '@picoaide/dsh-wasm-apps-host/ai-chat'
import { WAIT_BUDGETS } from './wait-budgets.ts'

const SERVER = 'https://harness.example.com'
const OTHER_SERVER = 'https://second.example.com'

const ALICE: AiChatScope = { userId: 'alice', serverURL: SERVER }
const BOB: AiChatScope = { userId: 'bob', serverURL: SERVER }
/** 同名、另一个服务端（测试/正式并存形态）。 */
const ALICE_ELSEWHERE: AiChatScope = { userId: 'alice', serverURL: OTHER_SERVER }

/** 一段文本回答的流。 */
function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...Array.from(text, (char): StreamChunk => ({ type: 'text-delta', index: 0, text: char })),
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** 记录请求的假适配器（不碰网络）；`hangWhenExhausted` = 脚本跑完后一直挂着（取消用例）。 */
class RecordingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private readonly script: StreamChunk[][]
  private readonly hangWhenExhausted: boolean
  constructor(script: StreamChunk[][], hangWhenExhausted = false) {
    super()
    this.script = script
    this.hangWhenExhausted = hangWhenExhausted
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script.shift()
    if (entry === undefined) {
      if (!this.hangWhenExhausted) throw new Error('RecordingAdapter: script exhausted')
      await new Promise<void>((_resolve, reject) => {
        if (options.signal?.aborted === true) { reject(new Error('aborted')); return }
        options.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
      })
      return
    }
    for (const chunk of entry) {
      if (options.signal?.aborted === true) throw new Error('aborted')
      yield chunk
    }
  }
}

/** 最小但真实的 agent 平面（与 `app-ai-runner.spec.ts` 同一套插件 + 平台默认模型行）。 */
async function plane(adapter: LlmAdapter): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(AgentDefaultModelConfig, { provider: 'mock', model: 'mock' })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

/** 授权记录（(账号 × 应用) 粒度，与生产 `aiConsentKey` 同形）。 */
function authorizationOf(...keys: string[]): AiChatAuthorization {
  const granted = new Set(keys)
  return {
    isGranted: (userId, appId) => Promise.resolve(granted.has(`${userId}|${appId}`)),
    grant: (userId, appId) => { granted.add(`${userId}|${appId}`); return Promise.resolve() },
    revoke: (userId, appId) => { granted.delete(`${userId}|${appId}`); return Promise.resolve() },
  }
}

/** 请求体里的对话（去掉 system）。 */
function dialogueOf(request: GenerateOptions | undefined): string {
  return (request?.messages ?? [])
    .filter(message => message.role !== 'system')
    .map(message => `${message.role}:${message.content.flatMap(block => (block.type === 'text' ? [block.text] : [])).join('')}`)
    .join('|')
}

const live: Context[] = []
afterEach(async () => {
  for (const ctx of live.splice(0)) await ctx.fiber.dispose()
})

describe('应用 AI 隐藏会话的账号作用域（R13-GB）', () => {
  it('①两个账号 / 两个服务端 ⇒ 同一个应用上是不同的 sessionId（带账号作用域）', async () => {
    const adapter = new RecordingAdapter([textResponse('ok'), textResponse('ok'), textResponse('ok'), textResponse('ok')])
    const ctx = await plane(adapter)
    live.push(ctx)
    const authorization = authorizationOf('alice|demo', 'bob|demo', 'alice|other-app')
    const runner = createAppAiRunner(ctx, { cwd: '/tmp/app-ai' })
    const turn = async (scope: AiChatScope, appId = 'demo'): Promise<string> => {
      const gate = await gateAppAi(authorization, scope, appId)
      if (!gate.ok) throw new Error('gate refused')
      await runner.run({
        sessionId: gate.sessionId,
        appId,
        messages: [{ role: 'user', content: `hi from ${scope.userId}` }] satisfies readonly AiChatMessage[],
        onDelta: () => {},
        signal: new AbortController().signal,
      })
      return gate.sessionId
    }
    const alice = await turn(ALICE)
    const bob = await turn(BOB)
    const aliceElsewhere = await turn(ALICE_ELSEWHERE)
    const aliceOtherApp = await turn(ALICE, 'other-app')
    // 形状：前缀 + 应用 + 账号作用域（账号@32 位服务端哈希）。
    expect(alice).toMatch(/^app:demo#alice@[0-9a-f]{32}$/u)
    expect(aliceOtherApp).toMatch(/^app:other-app#alice@[0-9a-f]{32}$/u)
    // 变异：把账号作用域去掉（`app:<app_id>`）⇒ 下面三条断言全红。
    expect(bob).not.toBe(alice)
    expect(aliceElsewhere).not.toBe(alice)
    expect(new Set([alice, bob, aliceElsewhere]).size).toBe(3)
    // 应用维度仍在（服务端按 `app:` 前缀派生归因，见 Go 侧用例）。
    expect(alice.startsWith('app:demo')).toBe(true)
  })

  it('②A 跑一轮后换 B：B 的第一轮请求体不含 A 的内容（真 agent-loop）', async () => {
    const adapter = new RecordingAdapter([textResponse('A 的回复'), textResponse('B 的回复')])
    const ctx = await plane(adapter)
    live.push(ctx)
    const authorization = authorizationOf('alice|demo', 'bob|demo')
    const runner = createAppAiRunner(ctx, { cwd: '/tmp/app-ai' })
    const turn = async (scope: AiChatScope, content: string): Promise<string> => {
      const gate = await gateAppAi(authorization, scope, 'demo')
      if (!gate.ok) throw new Error('gate refused')
      await runner.run({
        sessionId: gate.sessionId,
        appId: 'demo',
        messages: [{ role: 'user', content }] satisfies readonly AiChatMessage[],
        onDelta: () => {},
        signal: new AbortController().signal,
      })
      return gate.sessionId
    }
    const aliceId = await turn(ALICE, 'ALICE_SECRET_42')
    const bobId = await turn(BOB, 'BOB_QUESTION')
    expect(adapter.requests).toHaveLength(2)
    expect(aliceId).not.toBe(bobId)
    // 修复前：B 那一轮的请求体是 `user:ALICE_SECRET_42|assistant:A 的回复|user:BOB_QUESTION`。
    expect(dialogueOf(adapter.requests[1])).not.toContain('ALICE_SECRET_42')
    expect(dialogueOf(adapter.requests[1])).toBe('user:BOB_QUESTION')
    // 两条会话各自落在自己的 id 上（A 的那条仍可诊断地存在）。
    expect(ctx.sessions.get(SessionId(aliceId))).toBeDefined()
    expect(ctx.sessions.get(SessionId(bobId))).toBeDefined()
  })

  it('④反向对照：同账号第二轮仍带第一轮上下文（多轮不能被顺手砍掉）', async () => {
    const adapter = new RecordingAdapter([textResponse('第一答'), textResponse('第二答')])
    const ctx = await plane(adapter)
    live.push(ctx)
    const authorization = authorizationOf('alice|demo')
    const runner = createAppAiRunner(ctx, { cwd: '/tmp/app-ai' })
    const gate = await gateAppAi(authorization, ALICE, 'demo')
    if (!gate.ok) throw new Error('gate refused')
    const run = async (messages: readonly AiChatMessage[]): Promise<void> => {
      await runner.run({ sessionId: gate.sessionId, appId: 'demo', messages, onDelta: () => {}, signal: new AbortController().signal })
    }
    await run([{ role: 'user', content: 'u1' }])
    await run([{ role: 'user', content: 'u1' }, { role: 'assistant', content: '第一答' }, { role: 'user', content: 'u2' }])
    expect(dialogueOf(adapter.requests[1])).toBe('user:u1|assistant:第一答|user:u2')
  })
})

describe('换账号/登出释放（pico/session-changed，R13-GB）', () => {
  /** 造一个带假 `picoSession`（未恢复完成 ⇒ 不触发补发）的平面。 */
  async function planeWithSession(adapter: LlmAdapter): Promise<Context> {
    const ctx = await plane(adapter)
    ctx.provide('picoSession', { isRestored: () => false, getSession: () => null })
    return ctx
  }

  it('③释放清空 live/queues，并拒掉排队中的那一轮（不把已释放的会话又拉起来）', async () => {
    const adapter = new RecordingAdapter([textResponse('慢回复')], true)
    const ctx = await planeWithSession(adapter)
    live.push(ctx)
    const authorization = authorizationOf('alice|demo')
    const runner = createAppAiRunner(ctx, { cwd: '/tmp/app-ai' })
    const gate = await gateAppAi(authorization, ALICE, 'demo')
    if (!gate.ok) throw new Error('gate refused')
    const sessionId = gate.sessionId

    // 第一轮：脚本打完就挂着（活体会话留在 `live` 里）。
    const first = runner.run({
      sessionId,
      appId: 'demo',
      messages: [{ role: 'user', content: '长回复' }],
      onDelta: () => {},
      signal: new AbortController().signal,
    })
    // 现象：模型开始流之后活体会话才出现在 `live` 里（状态传播，不是同步副作用）⇒ 轮询等待。
    await expect.poll(() => runner.liveSessions(), { timeout: WAIT_BUDGETS.STATE_PROPAGATION_MS }).toBe(1)

    // 第二轮：同一会话 ⇒ 排队（同一时刻只跑一轮）。
    const second = runner.run({
      sessionId,
      appId: 'demo',
      messages: [{ role: 'user', content: '排队的那一轮' }],
      onDelta: () => {},
      signal: new AbortController().signal,
    })
    expect(runner.queuedSessions()).toBe(1)

    // 换账号/登出。
    const before = runner.generation()
    ctx.emit('pico/session-changed', null)
    // 现象：释放要先取消在飞那一轮再逐个 `dispose()`（异步）⇒ 轮询等到代次真的翻过去。
    await expect.poll(() => runner.generation(), { timeout: WAIT_BUDGETS.STATE_PROPAGATION_MS }).toBe(before + 1)
    // 变异：去掉 `subscribeSessionChanges` ⇒ 这两条红（live/queues 仍是 1）。
    await expect.poll(() => runner.liveSessions(), { timeout: WAIT_BUDGETS.STATE_PROPAGATION_MS }).toBe(0)
    expect(runner.queuedSessions()).toBe(0)
    // 在飞的那一轮被取消（干净收尾，不是留着写一半的会话）。
    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    // 排队的那一轮**起跑即拒**（变异：去掉 `run()` 里的代次检查 ⇒ 它真跑起来，这里不 reject）。
    await expect(second).rejects.toMatchObject({ name: 'AbortError' })
    // 释放之后活体会话不再存在（agent 已退出注册表）。
    expect(ctx.agents.get(SessionId(sessionId))).toBeUndefined()
    // 而且**没有**多出第三次模型调用（排队的那一轮没有真的跑）。
    expect(adapter.requests.filter(request => JSON.stringify(request.messages).includes('排队的那一轮'))).toHaveLength(0)
  })

  it('③释放不是"永久失效"：同一个账号下一轮仍能跑（重新建立会话）', async () => {
    const adapter = new RecordingAdapter([textResponse('释放前'), textResponse('释放后')])
    const ctx = await planeWithSession(adapter)
    live.push(ctx)
    const authorization = authorizationOf('alice|demo')
    const runner = createAppAiRunner(ctx, { cwd: '/tmp/app-ai' })
    const gate = await gateAppAi(authorization, ALICE, 'demo')
    if (!gate.ok) throw new Error('gate refused')
    const sessionId = gate.sessionId
    await runner.run({ sessionId, appId: 'demo', messages: [{ role: 'user', content: 'u1' }], onDelta: () => {}, signal: new AbortController().signal })
    await runner.releaseAll('probe')
    expect(runner.liveSessions()).toBe(0)
    // 释放只清**活体**：下一次调用重新建立（生产上有持久化面时按磁盘会话 `resume`，所以
    // 同账号重登不会因为这次释放丢上下文；本用例的平面没有持久化面 ⇒ 重新 create）。
    await runner.run({ sessionId, appId: 'demo', messages: [{ role: 'user', content: 'u2' }], onDelta: () => {}, signal: new AbortController().signal })
    expect(adapter.requests).toHaveLength(2)
    expect(dialogueOf(adapter.requests[1])).toBe('user:u2')
  })

  it('③释放是幂等的：没有活体会话时不报错、也不误换代次之外的语义', async () => {
    const adapter = new RecordingAdapter([])
    const ctx = await planeWithSession(adapter)
    live.push(ctx)
    const runner = createAppAiRunner(ctx, { cwd: '/tmp/app-ai' })
    const before = runner.generation()
    await runner.releaseAll('probe')
    await runner.releaseAll('probe')
    expect(runner.generation()).toBe(before + 2)
    expect(runner.liveSessions()).toBe(0)
    expect(runner.queuedSessions()).toBe(0)
  })
})
