/**
 * 应用 AI 执行面的**真实组合**用例（§21.6 判据 4/5/6/7，主控 2026-09-20 要求的 F2 闭环）。
 *
 * 这里跑的是**真的 agent-loop**：`Context` + `LlmRuntime` + `SessionStore` +
 * `SystemPrompt` + `ToolRuntime` + `AgentRegistry` + `AgentLoop`，模型是记录请求的
 * 假适配器（`MockAdapter` 同构：脚本化 chunk + 记录 `GenerateOptions`）。之所以不用
 * 手搓的 `ctx.agentLoop` 替身：本包要证的正是"跑一轮 agentLoop 时请求体里有什么"，
 * 替身会把被测对象换掉。
 *
 * 判据与用例的对应：
 *  - 判据 4（工具集为空）：注册一个**全局**工具 ⇒ 请求的 `tools` 必须为空；
 *  - 判据 5（隐藏会话）：会话 id 是 `app:<app_id>`、header.origin = 'subagent'
 *    （普通会话树按它排除）、带 cwd（诊断可查）；
 *  - 判据 6（仅本次 messages）：全局 `systemPrompt.context` 注入 + 全局 persona ⇒
 *    请求里只有平台提示与本轮对话；第二轮只带新增的那条用户消息；
 *  - 判据 7（增量顺序 + 取消）：`text-delta` 顺序回调、取消 ⇒ `AbortError` 且不留活体会话。
 */
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId, type GenerateOptions, type LlmModelReasoningInfo, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import { afterEach, describe, expect, it } from 'vitest'
import { APP_AI_PROMPT_SECTION, APP_AI_SYSTEM_PROMPT, createAppAiRunner } from '../src/app-ai-runner.ts'
import { provideAppAiRunner } from '../src/app-ai-runner.ts'
import { WASM_APPS_AI_RUNNER_SERVICE } from '@picoaide/dsh-wasm-apps-host'
import { readFileSync } from 'node:fs'
import type { AiChatTurnRunner } from '@picoaide/dsh-wasm-apps-host/ai-chat'
import { WAIT_BUDGETS } from './wait-budgets.ts'

/** 一段文本回答的流（字符级 `text-delta`，便于断言增量顺序）。 */
function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...Array.from(text, (char): StreamChunk => ({ type: 'text-delta', index: 0, text: char })),
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 11, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** 先流一段文本、然后一直挂着直到被取消（取消路径用）。 */
function hangingResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
  ]
}

/** 记录请求的假适配器（不碰网络）。 */
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
    if (entry === this.script[0]) return
  }
}

/** 记录请求、并在最后一段之后挂起的适配器（取消用例）。 */
class HangingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly prefix: StreamChunk[]) { super() }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    for (const chunk of this.prefix) yield chunk
    await new Promise<void>((_resolve, reject) => {
      if (options.signal?.aborted === true) { reject(new Error('aborted')); return }
      options.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
    })
  }
}

/** 最小但真实的 agent 平面（与上游 agent-loop 用例同一套插件 + 平台默认模型行）。 */
async function harness(adapter: LlmAdapter, persona = ''): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: persona })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  // 平台统一默认模型（§21.1 第 14 条）：桌面 profile 的 `agent-default-model` 行。
  await ctx.plugin(AgentDefaultModelConfig, { provider: 'mock', model: 'mock' })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

/** 一轮的驱动：把 runner 包成"给定 messages 就跑"的小工具。 */
async function turn(
  runner: AiChatTurnRunner,
  appId: string,
  messages: readonly { role: 'user' | 'assistant', content: string }[],
  signal = new AbortController().signal,
): Promise<{ content: string, deltas: string[] }> {
  const deltas: string[] = []
  const result = await runner.run({
    sessionId: `app:${appId}`,
    appId,
    messages,
    onDelta: (text) => { deltas.push(text) },
    signal,
  })
  return { content: result.content, deltas }
}

/** 请求的 system 消息正文。 */
function systemOf(request: GenerateOptions | undefined): string {
  const head = request?.messages[0]
  if (head?.role !== 'system') return ''
  return head.content.flatMap(block => (block.type === 'text' ? [block.text] : [])).join('')
}

/** 请求里的对话消息（去掉 system）。 */
function dialogueOf(request: GenerateOptions | undefined): Array<{ role: string, text: string }> {
  return (request?.messages ?? [])
    .filter(message => message.role !== 'system')
    .map(message => ({
      role: message.role,
      text: message.content.flatMap(block => (block.type === 'text' ? [block.text] : [])).join(''),
    }))
}

const live: Context[] = []
afterEach(async () => {
  for (const ctx of live.splice(0)) await ctx.fiber.dispose()
})

describe('应用 AI 执行面（隐藏会话 + 仅对话）', () => {
  it('判据 4：注册了全局工具，该轮请求的 tools 仍然为空（白名单空集）', async () => {
    const adapter = new RecordingAdapter([textResponse('好的')])
    const ctx = await harness(adapter, 'You are a coding agent in {{cwd}}.')
    live.push(ctx)
    ctx.tools.register(defineContentToolFixture({
      name: 'dangerous_tool',
      description: 'reads files',
      parameters: { path: { type: 'string' } },
      async execute() { return [] },
    }))

    const runner = createAppAiRunner(ctx, { cwd: '/tmp/app-ai' })
    const result = await turn(runner, 'demo-app', [{ role: 'user', content: '你好' }])

    expect(result.content).toBe('好的')
    expect(adapter.requests).toHaveLength(1)
    // 变异：去掉 `tools.restrict({allow: []})` ⇒ 这里变成 ['dangerous_tool']。
    expect(adapter.requests[0]?.tools ?? []).toEqual([])
  })

  it('判据 6：全局 prompt 注入（记忆走 contexts）不进入请求体；系统提示只有平台那一条', async () => {
    const adapter = new RecordingAdapter([textResponse('收到')])
    const ctx = await harness(adapter, 'You are a coding agent in {{cwd}}.')
    live.push(ctx)
    ctx.systemPrompt.context({ name: 'memory-snapshot', order: 1, text: 'SECRET MEMORY: the user likes tea' })

    const runner = createAppAiRunner(ctx, { cwd: '/tmp/app-ai' })
    await turn(runner, 'demo-app', [{ role: 'user', content: '记住我喜欢茶' }])

    const request = adapter.requests[0]
    const rendered = JSON.stringify(request?.messages ?? [])
    // 变异：装配瀑布里不清 contexts ⇒ 这两条断言变红。
    expect(rendered).not.toContain('SECRET MEMORY')
    expect(systemOf(request)).toBe(APP_AI_SYSTEM_PROMPT)
    expect(systemOf(request)).not.toContain('You are a coding agent')
    expect(dialogueOf(request)).toEqual([{ role: 'user', text: '记住我喜欢茶' }])
  })

  it('判据 6：第二轮只补新增的那条用户消息（应用重发累积历史不产生重复）', async () => {
    const adapter = new RecordingAdapter([textResponse('第一答'), textResponse('第二答')])
    const ctx = await harness(adapter)
    live.push(ctx)
    const runner = createAppAiRunner(ctx, { cwd: '/tmp/app-ai' })

    const first = await turn(runner, 'demo-app', [{ role: 'user', content: 'u1' }])
    expect(first.content).toBe('第一答')
    const second = await turn(runner, 'demo-app', [
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: '第一答' },
      { role: 'user', content: 'u2' },
    ])
    expect(second.content).toBe('第二答')
    expect(adapter.requests).toHaveLength(2)
    expect(dialogueOf(adapter.requests[1])).toEqual([
      { role: 'user', text: 'u1' },
      { role: 'assistant', text: '第一答' },
      { role: 'user', text: 'u2' },
    ])
  })

  it('判据 5：隐藏会话的 id 是 app:<app_id>、origin=subagent（不进普通会话树）、带 cwd', async () => {
    const adapter = new RecordingAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    live.push(ctx)
    const runner = createAppAiRunner(ctx, { cwd: '/tmp/app-ai' })
    await turn(runner, 'demo-app', [{ role: 'user', content: 'hi' }])

    const session = ctx.sessions.get(SessionId('app:demo-app'))
    expect(session?.id).toBe('app:demo-app')
    // 侧边栏可见性判据（上游 `ui-workspace/tree.ts` 的 `sessionVisible`）：
    // `origin !== 'subagent'` 是唯一的"隐藏"位。
    expect(session?.header.origin).toBe('subagent')
    expect(session?.header.cwd).toBe('/tmp/app-ai')
    // 模型请求带着同一个会话身份出站（归因链路的客户端半边）。
    expect(adapter.requests[0]?.sessionId).toBe('app:demo-app')
  })

  it('判据 5（第二半）：会话进行中可见于会话存储，且 origin=subagent / 非空 cwd', async () => {
    const adapter = new HangingAdapter(hangingResponse('部分'))
    const ctx = await harness(adapter)
    live.push(ctx)
    const runner = createAppAiRunner(ctx, { cwd: '/tmp/app-ai' })
    const controller = new AbortController()
    const pending = runner.run({
      sessionId: 'app:demo-app',
      appId: 'demo-app',
      messages: [{ role: 'user', content: 'hi' }],
      onDelta: () => {},
      signal: controller.signal,
    })
    // 等到活体会话出现（模型已开始流）。
    // 现象：模型开始流之后活体会话可见于会话存储（状态传播）。
    await expect.poll(() => ctx.sessions.get(SessionId('app:demo-app'))?.header.origin, { timeout: WAIT_BUDGETS.STATE_PROPAGATION_MS }).toBe('subagent')
    const session = ctx.sessions.get(SessionId('app:demo-app'))
    expect(session?.header.cwd).toBe('/tmp/app-ai')
    expect(session?.header.delegationDepth).toBeUndefined()
    controller.abort()
    await expect(pending).rejects.toThrow(/cancel/iu)
    // 现象：取消后活体会话从会话存储消失（状态传播）。
    await expect.poll(() => ctx.sessions.get(SessionId('app:demo-app')), { timeout: WAIT_BUDGETS.STATE_PROPAGATION_MS }).toBeUndefined()
  })

  it('判据 7：增量按序回调、done 的正文来自日志；取消 ⇒ AbortError 且不留活体会话', async () => {
    const adapter = new RecordingAdapter([textResponse('一二三')])
    const ctx = await harness(adapter)
    live.push(ctx)
    const runner = createAppAiRunner(ctx, { cwd: '/tmp/app-ai' })
    const deltas: string[] = []
    const result = await runner.run({
      sessionId: 'app:demo-app',
      appId: 'demo-app',
      messages: [{ role: 'user', content: '数数' }],
      onDelta: (text) => { deltas.push(text) },
      signal: new AbortController().signal,
    })
    expect(deltas.join('')).toBe('一二三')
    expect(result.content).toBe('一二三')
    expect(result.usage).toEqual({ promptTokens: 11, completionTokens: 3 })
  })

  it('判据 7（取消）：页面关闭 ⇒ 该轮被 cancel（AbortError），会话与循环都不留', async () => {
    const adapter = new HangingAdapter(hangingResponse('半句'))
    const ctx = await harness(adapter)
    live.push(ctx)
    const runner = createAppAiRunner(ctx, { cwd: '/tmp/app-ai' })
    const controller = new AbortController()
    const deltas: string[] = []
    const pending = runner.run({
      sessionId: 'app:demo-app',
      appId: 'demo-app',
      messages: [{ role: 'user', content: '长回复' }],
      onDelta: (text) => { deltas.push(text) },
      signal: controller.signal,
    })
    // 现象：增量回调把"半句"累积出来（状态传播）。
    await expect.poll(() => deltas.join(''), { timeout: WAIT_BUDGETS.STATE_PROPAGATION_MS }).toBe('半句')
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    // 现象：取消后会话从存储消失（状态传播）。
    await expect.poll(() => ctx.sessions.get(SessionId('app:demo-app')), { timeout: WAIT_BUDGETS.STATE_PROPAGATION_MS }).toBeUndefined()
    expect(ctx.agents.get(SessionId('app:demo-app'))).toBeUndefined()
  })

  it('取消信号在开跑前已中止 ⇒ 直接 AbortError，一次模型调用都不发生', async () => {
    const adapter = new RecordingAdapter([textResponse('不该发生')])
    const ctx = await harness(adapter)
    live.push(ctx)
    const runner = createAppAiRunner(ctx, { cwd: '/tmp/app-ai' })
    const controller = new AbortController()
    controller.abort()
    await expect(runner.run({
      sessionId: 'app:demo-app',
      appId: 'demo-app',
      messages: [{ role: 'user', content: 'hi' }],
      onDelta: () => {},
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(adapter.requests).toHaveLength(0)
  })

  it('同一条 answered 对话重复提交 ⇒ 不消耗 token（回上一次的回答）', async () => {
    const adapter = new RecordingAdapter([textResponse('答过了')])
    const ctx = await harness(adapter)
    live.push(ctx)
    const runner = createAppAiRunner(ctx, { cwd: '/tmp/app-ai' })
    await turn(runner, 'demo-app', [{ role: 'user', content: 'hi' }])
    const repeat = await turn(runner, 'demo-app', [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '答过了' },
    ])
    expect(repeat.content).toBe('答过了')
    expect(adapter.requests).toHaveLength(1)
  })

  it('agent 平面缺席 ⇒ 抛错（不静默返回空答案）', async () => {
    const ctx = new Context()
    live.push(ctx)
    const runner = createAppAiRunner(ctx, { cwd: '/tmp/app-ai' })
    await expect(turn(runner, 'demo-app', [{ role: 'user', content: 'hi' }]))
      .rejects.toThrow(/agent registry/u)
  })

  it('导出面：平台提示与分段名是稳定的（客户端/宿主对拍用）', () => {
    expect(APP_AI_PROMPT_SECTION).toBe('pico-app-ai')
    expect(APP_AI_SYSTEM_PROMPT).toContain('no tools')
  })
})

/** 工具名与调用 id 的占位（避免未使用导入被 lint 判死）。 */
void ToolCallId
void ((): LlmModelReasoningInfo | undefined => undefined)

describe('宿主接线（§21.2 步骤③ 的生产 provide；2026-09-20 独立复核补的判据）', () => {
  /**
   * 为什么要有这两条：这段接线原先**内联在 `main.ts` 的 boot 回调里**，而 `main.ts`
   * 是 Electron 引导、单测跑不到 ⇒ 复核实测「把 `provide(...)` 删掉，29 条用例全绿」，
   * 而生产环境每次应用 AI 调用都会回 503 `app_ai_unavailable`。
   * 判据分两层：①**行为**（真实 Cordis `provide`/`get` 往返）；②**链接**（`main.ts`
   * 确实走这个函数，而不是又内联回去）。
   */
  it('provideAppAiRunner 之后 ctx.get(WASM_APPS_AI_RUNNER_SERVICE) 必须拿得到同一个 runner', async () => {
    const adapter = new RecordingAdapter([textResponse('你好')])
    const ctx = await harness(adapter)
    live.push(ctx)
    // 正对照：provide 之前必须取不到 —— 否则下面的断言可能因为别处已 provide 而恒真。
    expect(ctx.get(WASM_APPS_AI_RUNNER_SERVICE)).toBeUndefined()

    const runner = provideAppAiRunner(ctx, { cwd: '/tmp/picoaide-app-ai-接线判据' })
    expect(typeof runner.run).toBe('function')
    // 关键：**从 ctx 取回来的**就是被 provide 的那个对象（真实 provide/get 往返）。
    expect(ctx.get(WASM_APPS_AI_RUNNER_SERVICE)).toBe(runner)
  })

  it('main.ts 必须经 provideAppAiRunner 接线（内联 provide 会让上一条判据失守）', () => {
    const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
    expect(main).toContain("import { provideAppAiRunner } from './app-ai-runner.ts'")
    expect(main).toContain('provideAppAiRunner(hostCtx, {')
    // 反向：不得再出现"内联 hostCtx.provide(服务名…)"的形态。
    expect(main).not.toMatch(/hostCtx\.provide\(\s*WASM_APPS_AI_RUNNER_SERVICE/)
  })
})
