/**
 * R14 C-04（P2 · 诊断面）：应用 AI 的 `warn` 出口在**生产接线**上必须真的接上。
 *
 * 缺陷形态：`AppAiRunnerOptions.warn` 的缺省是 **no-op**（`app-ai-runner.ts`：
 * `const warn = options.warn ?? ((): void => {})`），而 `main.ts` 的
 * `provideAppAiRunner(hostCtx, { cwd: … })` **没有传** `warn` ⇒ 这一族诊断在生产
 * 全部被丢弃：
 *  - `releasing the application AI session failed after …`（释放失败 —— C-02 的同族症状
 *    就只有这条日志能看见）；
 *  - `the application sent messages that rewrite the hidden conversation …`（应用改写
 *    历史，上下文被悄悄截断）；
 *  - `disposing the application AI session failed` / `cancelling … failed`。
 *
 * 判据两半（缺一半就有假绿）：
 *  ① **行为半**：`provideAppAiRunner(ctx, { cwd, warn })` 真的把 `warn` 交给 runner ——
 *     用真 Cordis + 真 agent loop 跑一轮"应用改写历史"的请求，断言 spy 收到那条消息
 *     （不是钉字符串，是驱动产品路径）；
 *  ② **接线半**：`main.ts` 的 `provideAppAiRunner(hostCtx, { … })` 选项对象里有 `warn`，
 *     且它转发到桌面宿主的主进程日志 `electronLogger.error`（与应用窗口载体
 *     `provideWasmAppsWindows` 同一口径）。`main.ts` 是 Electron 引导、单测跑不到，
 *     所以这一半只能做源码级对拍（本仓既有惯例：`wasm-app-open-route-parity.spec.ts`）。
 *
 * 变异验证（拆掉即红）：删掉 `main.ts` 里的 `warn:` 行 ⇒ ②红（①仍绿，因为它测的是
 * runner 本身）；把 `provideAppAiRunner` 改成丢弃 `options.warn`（`createAppAiRunner(ctx,
 * { cwd: options.cwd })`）⇒ ①红。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
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
import { afterEach, describe, expect, it } from 'vitest'
import { provideAppAiRunner } from '../src/app-ai-runner.ts'
import { WASM_APPS_AI_RUNNER_SERVICE } from '@picoaide/dsh-wasm-apps-host'

const REPO = fileURLToPath(new URL('../../../../', import.meta.url))

function read(rel: string): string {
  return readFileSync(join(REPO, rel), 'utf8')
}

/**
 * 取 `main.ts` 里 `provideAppAiRunner(<ctx>, { … })` 的**选项对象字面量**（按花括号配对）。
 *
 * 为什么不用正则一把梭：对象里有嵌套（`app.getPath('userData')` 的括号、注释里的花括号），
 * 正则要么截断要么跨到下一个调用点 —— 那正是"判据空转"的经典形态。取不到就**抛**，
 * 绝不静默返回空串（空串会让"必须包含 warn"这类断言变成恒真）。
 */
function appAiRunnerOptionsSource(): string {
  const source = read('packages/host/desktop/src/main.ts')
  const call = source.indexOf('provideAppAiRunner(hostCtx, {')
  expect(call, 'main.ts 里找不到 provideAppAiRunner(hostCtx, { … }) 调用点').toBeGreaterThan(-1)
  const open = source.indexOf('{', source.indexOf('provideAppAiRunner(hostCtx,', call))
  expect(open).toBeGreaterThan(-1)
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    const char = source[index]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open, index + 1)
    }
  }
  throw new Error('provideAppAiRunner 的选项对象没有闭合（main.ts 结构已变？）')
}

/** 一段文本回答的流。 */
function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** 最简假适配器（不碰网络；脚本按顺序作答）。 */
class ScriptedAdapter extends LlmAdapter {
  private readonly script: StreamChunk[][]
  constructor(script: StreamChunk[][]) {
    super()
    this.script = script
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    const entry = this.script.shift()
    if (entry === undefined) throw new Error('ScriptedAdapter: script exhausted')
    for (const chunk of entry) yield chunk
  }
}

const live: Context[] = []
afterEach(async () => {
  for (const ctx of live.splice(0)) await ctx.fiber.dispose()
})

describe('R14 C-04：应用 AI 的 warn 出口', () => {
  it('①行为：provideAppAiRunner 把 warn 交给 runner（驱动真实路径，不是钉字符串）', async () => {
    const ctx = new Context()
    live.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt, { personaPrefix: '' })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(AgentDefaultModelConfig, { provider: 'mock', model: 'mock' })
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([textResponse('第一答'), textResponse('第二答')]))

    const seen: string[] = []
    const runner = provideAppAiRunner(ctx, { cwd: '/tmp/app-ai', warn: message => { seen.push(message) } })
    // provide 真的发生了（不是"返回了一个 runner 但没挂进 ctx"）。
    expect(ctx.get(WASM_APPS_AI_RUNNER_SERVICE)).toBe(runner)

    const sessionId = 'app:demo#alice@0123456789abcdef0123456789abcdef'
    const run = async (messages: readonly { role: 'user' | 'assistant', content: string }[]): Promise<void> => {
      await runner.run({ sessionId, appId: 'demo', messages, onDelta: () => {}, signal: new AbortController().signal })
    }
    await run([{ role: 'user', content: 'u1' }])
    expect(seen).toEqual([])
    // 第二轮把历史里的 assistant 正文改写（应用侧重放/编辑）⇒ 产品路径必须报一条 warn。
    await run([{ role: 'user', content: 'u1' }, { role: 'assistant', content: '被改写的回答' }, { role: 'user', content: 'u2' }])
    expect(seen.length, '`warn` 没被交给 runner（选项被丢弃？）').toBeGreaterThan(0)
    expect(seen.join('\n')).toContain('rewrite the hidden conversation')
  })

  it('②接线：main.ts 传了 warn，且转发到桌面主进程日志（electronLogger）', () => {
    const options = appAiRunnerOptionsSource()
    // 反空转：抽出来的必须真是那个选项对象（而不是空串/半截）。
    expect(options).toContain('cwd: app.getPath(\'userData\')')
    expect(options.startsWith('{')).toBe(true)
    expect(options.endsWith('}')).toBe(true)
    // 判据：必须传 warn，且是函数、且落到宿主日志（与 provideWasmAppsWindows 同口径）。
    expect(options, 'main.ts 没给应用 AI 传 warn ⇒ 释放/改写告警在生产全部丢弃').toMatch(/warn\s*:/u)
    expect(options).toMatch(/warn\s*:\s*\w+\s*=>/u)
    expect(options).toContain('electronLogger.error(message)')
  })
})
