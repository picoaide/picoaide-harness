/**
 * R14 C-02（P2）判据：**释放窗口内到达的同 id 新一轮必须等写句柄真的释放**。
 *
 * 缺陷形态（真 jsonl 持久化后端实测，修复前）：
 *
 *	[race] releaseAll resolved after 1510ms; live=0 agent=false
 *	[race] T2 => rejected: SessionAlreadyOwnedError session "app:demo#alice@…" is already owned by an active write handle
 *	[race] third turn => resolved                      ← 窗口之外重试就成功
 *
 * 机制：`releaseAll` **同步**清空 `live`/`queues` 之后才 `await dispose()`，而 `dispose()`
 * 要等被放弃那一轮的模型流真正收尾（真机上是可观测的一段时间）。窗口里同一个隐藏会话 id
 * 的新一轮看到 `live` 已空 ⇒ 走 `openAgentUncached` ⇒ 上一个写句柄还在 ⇒ 持久化平面拒绝。
 * 应用侧只看到一张错误卡片（`packages/client/wasm-apps` 没有自动重试），手动重试即好 ——
 * "偶发失败、重试就对"的经典形态。没有持久化平面的宿主同形（`session "…" already exists`）。
 *
 * 判据：
 *  - ①`releaseAll` 之后**立刻**发起同一 id 的一轮：旧写句柄还没释放时它**不得**开工
 *    （模型调用次数保持 1），放行旧流之后必须 **resolved**（修复前这里是
 *    `SessionAlreadyOwnedError`）；
 *  - ②同族的 `cancel()`（fire-and-forget 丢弃活体）之后立刻一轮：同样必须 resolved
 *    （它走 `dropAgent`，同一份收尾闸门）。
 *
 * 变异验证（拆掉即红）：把 `openAgent` 里的 `await releasing.get(sessionId)` 去掉 ⇒ ①红
 * （形态就是 `already owned by an active write handle`）；把 `dropAgent` 里的
 * `trackReleasing` 去掉 ⇒ ②红。
 */
import { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAppAiRunner } from '../src/app-ai-runner.ts'
import { WAIT_BUDGETS } from './wait-budgets.ts'

/** 手动放行的闸门（`resolve` 幂等）。 */
function deferred(): { promise: Promise<void>, resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((settle) => { resolve = settle })
  return { promise, resolve }
}

/**
 * 第一路模型调用**一直挂着直到放行**的假适配器（故意忽略 `options.signal` —— 上游读卡住
 * 时就是这个形态：abort 到了也收不了尾，于是 `dispose()` 留在窗口里）。
 */
class StallingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private readonly gate: Promise<void>
  constructor(gate: Promise<void>) {
    super()
    this.gate = gate
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const index = this.requests.push(options)
    if (index === 1) {
      await this.gate
      throw new Error('upstream stalled')
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const sessionsRoots: string[] = []
const live: Context[] = []
afterEach(async () => {
  for (const ctx of live.splice(0)) await ctx.fiber.dispose()
  for (const root of sessionsRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * 与生产同形的最小 agent 平面 + **真 jsonl 持久化**（写句柄的持有者就是它）。
 *
 * 用真后端而不是替身：C-02 的症状正是"持久化平面拒绝第二个写句柄"
 * （`SessionAlreadyOwnedError`），替身只会把这条判据变成"我们自己的假设"。
 */
async function planeWithPersistence(adapter: LlmAdapter): Promise<Context> {
  const root = mkdtempSync(join(tmpdir(), 'r14c02-release-window-'))
  sessionsRoots.push(root)
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(AgentDefaultModelConfig, { provider: 'mock', model: 'mock' })
  await ctx.plugin(SessionPersistenceJsonl, { root })
  ctx.llm.registerAdapter(['mock'], adapter)
  ctx.provide('picoSession', { isRestored: () => false, getSession: () => null })
  return ctx
}

const SESSION_ID = 'app:demo#alice@0123456789abcdef0123456789abcdef'
const SIGNAL = new AbortController().signal

describe('R14 C-02：释放窗口内的同一隐藏会话', () => {
  it('①releaseAll 之后立刻一轮：等在写句柄释放之后，而不是撞 SessionAlreadyOwnedError', async () => {
    const gate = deferred()
    const adapter = new StallingAdapter(gate.promise)
    const ctx = await planeWithPersistence(adapter)
    live.push(ctx)
    const runner = createAppAiRunner(ctx, { cwd: '/tmp/app-ai' })
    const run = async (content: string): Promise<unknown> =>
      await runner.run({ sessionId: SESSION_ID, appId: 'demo', messages: [{ role: 'user', content }], onDelta: () => {}, signal: SIGNAL })

    const first = run('first')
    first.catch(() => {})
    // 现象：第一轮**进到模型流**（open 链 stat → resume/create → 装配 → 首次 stream 调用）。
    // 必须等到这一步，"被放弃的那一轮真的握着写句柄"这个前提才成立：活体会话在首次 stream
    // 之前就已登记，此刻取消掉它则没人握句柄 —— 那会把下面的判据变成"两次假适配器调用的
    // 顺序"，而不是 C-02 的写句柄窗口。
    await expect.poll(() => adapter.requests.length, { timeout: WAIT_BUDGETS.STATE_PROPAGATION_MS }).toBe(1)
    expect(runner.liveSessions()).toBe(1)

    const release = runner.releaseAll('session-changed')
    const second = run('second')
    second.catch(() => {})
    try {
      // 调度余量：让 `second` 走到"开写句柄"那一步（修复前它在这一步就被拒绝；窗口由未放行
      // 的 `gate` 一直held住，所以这段时间里旧写句柄绝不会自己释放）。
      await new Promise<void>((resolve) => { setTimeout(resolve, 200) })
      // 判据的一半：旧写句柄还没释放时，新一轮**不得**开工（模型调用数仍是 1）。
      expect(adapter.requests, '新一轮在旧写句柄还没释放时就开始跑模型了').toHaveLength(1)

      gate.resolve()
      // 判据的另一半（修复前红在这里）：放行旧流之后，新一轮必须真的跑起来。
      await expect(second).resolves.toBeDefined()
      await release
      // 被放弃的那一轮必须失败（形态随上游而定：取消 / 适配器报错 / 没有 assistant 结果）。
      await expect(first).rejects.toThrow()
      expect(runner.liveSessions()).toBe(1)
    } finally {
      gate.resolve()
    }
  })

  it('②cancel() 之后紧接 releaseAll()：`live` 已空 ⇒ 新一轮只能靠"收尾闸门"等，不得撞写句柄', async () => {
    const gate = deferred()
    const adapter = new StallingAdapter(gate.promise)
    const ctx = await planeWithPersistence(adapter)
    live.push(ctx)
    const runner = createAppAiRunner(ctx, { cwd: '/tmp/app-ai' })
    const run = async (content: string): Promise<unknown> =>
      await runner.run({ sessionId: SESSION_ID, appId: 'demo', messages: [{ role: 'user', content }], onDelta: () => {}, signal: SIGNAL })

    const first = run('first')
    first.catch(() => {})
    // 现象：第一轮**进到模型流**（open 链 stat → resume/create → 装配 → 首次 stream 调用）。
    // 必须等到这一步，"被放弃的那一轮真的握着写句柄"这个前提才成立：活体会话在首次 stream
    // 之前就已登记，此刻取消掉它则没人握句柄 —— 那会把下面的判据变成"两次假适配器调用的
    // 顺序"，而不是 C-02 的写句柄窗口。
    await expect.poll(() => adapter.requests.length, { timeout: WAIT_BUDGETS.STATE_PROPAGATION_MS }).toBe(1)
    expect(runner.liveSessions()).toBe(1)

    // 这一步是本用例与①的分工所在：`cancel()` 先把 `live` 摘空，紧接着的 `releaseAll` 于是
    // **找不到活体**（`released.length === 0`，不登记任何收尾），但它照样 `queues.clear()` ——
    // 也就是说"旧一轮的串行链"与"releaseAll 的收尾登记"这两道等待同时没了，只剩
    // `dropAgent` 自己登记的收尾闸门。拆掉 `dropAgent` 的 `trackReleasing` 即红。
    runner.cancel?.(SESSION_ID)
    const release = runner.releaseAll('session-changed')
    const second = run('second')
    second.catch(() => {})
    try {
      // 调度余量：让 `second` 走到"开写句柄"那一步（旧写句柄被未放行的 gate 一直held住）。
      await new Promise<void>((resolve) => { setTimeout(resolve, 200) })
      expect(adapter.requests, 'cancel 之后的下一轮在旧写句柄还没释放时就开始跑模型了').toHaveLength(1)
      gate.resolve()
      await expect(second).resolves.toBeDefined()
      await release
      // 被放弃的那一轮必须失败（形态随上游而定：取消 / 适配器报错 / 没有 assistant 结果）。
      await expect(first).rejects.toThrow()
    } finally {
      gate.resolve()
    }
  })
})
