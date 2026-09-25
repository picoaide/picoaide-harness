/**
 * R14 lane N 判据：释放窗口闸门的两条修补（VB-N2 所有权栅栏 / VB-N3 有界且看 signal 的等待）。
 *
 * 全部跑在**真平面**上：真 Cordis Context、真 agent loop、真 `SessionPersistenceJsonl`
 * （真实磁盘会话根）、真 `createAppAiRunner`。只有 LLM 适配器是本地替身 —— 它可以被要求
 * "卡住"或"永不结束"（模拟上游读无超时/连接半开，abort 到了也收不了尾）。
 *
 * ## VB-N2：被放弃那一轮的 `finally` 不许动新轮的句柄
 *
 * 机制：`runTurn` 的 `finally` 无条件 `dropAgent(sessionId)`，而修复前的 `dropAgent`
 * 无条件 `live.get(sessionId)`。于是"被放弃那一轮的收尾"只要晚于"闸门放行 + 新轮发布句柄"，
 * 就会 dispose 掉**新轮**的句柄（`live` 清空、agent 从注册表消失；流式中途被偷则整轮以
 * `the application AI turn produced no assistant message` 失败）。V14-B 在冻结态 12/12
 * 未命中、把窗口加宽一个 macrotask 后 6/6 命中。
 *
 * 本文件把那个"加宽"**搬进判据**（不动产品源码）：包装第一个句柄的 `agent.whenIdle`，在它
 * 真正结算后再多跨一个宏任务 —— 即"旧轮的 `finally` 落得比闸门晚"。加宽**只打在第 1 次调用**
 * 上，因为 `whenIdle` 有两个调用者：`runTurn`（我们要推迟的那一个，它在 `followup` 之后同步
 * 调用）与 `dispose()` 内部的等待（**不能**推迟 —— 推迟它等于把闸门一起推迟，窗口反而消失。
 * 实测：两次都推迟时 dispose 在 +629ms 才落地、旧轮收尾在 +618ms 已经跑完 ⇒ 永远偷不到，
 * 判据变成空转；只推迟第 1 次时 dispose 在 +465ms 落地、新轮 +497ms 开跑、旧轮收尾 +578ms
 * 才到 ⇒ 窗口稳定打开）。
 *
 * ## VB-N3：闸门等待必须有界、必须看 signal
 *
 * 修复前 `openAgent` 里 `await releasing.get(sessionId)` 既没有上限也不看 `signal`：上游读
 * 永不结束时**该隐藏会话 id 的每一轮**都永久挂住（页面关闭/超时也解不开），直到进程重启。
 * 现在：abort 立刻退出（`ai_cancelled`），超预算抛显式错误码
 * （`app_ai_session_release_pending`），且**不放行第二个写句柄**；卡住的上游一旦收尾，
 * 闸门自动放行（无需重启）。
 *
 * 变异验证（拆掉即红，逐条实跑见报告）：
 *  - 去掉 `dropAgent` 的 `owner` 栅栏（恢复无条件 `live.delete`）⇒ ①②红；
 *  - `waitForRelease` 改回 `await settling`（无预算、不看 signal）⇒ ③④红；
 *  - 把超预算分支改成"忽略闸门继续开"⇒ ③红（会看到第二次模型调用 / 撞写句柄）；
 *  - 改掉错误类的 `name` ⇒ ⑤红（协议层映射靠 `name` 认它）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { SessionId as SessionIdType } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { afterEach, describe, expect, it } from 'vitest'
// 判据打的就是这次改动的源码（走 lib 会拿旧产物测出假绿，本仓登记过的"本地绿、CI 红"形态）。
import {
  APP_AI_SESSION_RELEASE_PENDING,
  AppAiSessionReleasePendingError,
  createAppAiRunner,
} from '../src/app-ai-runner.ts'
import { handleAiChat } from '../../wasm-apps-host/src/ai-chat.ts'

const SESSION_ID = 'app:demo#alice@0123456789abcdef0123456789abcdef'
const OTHER_SESSION_ID = 'app:demo#bob@0123456789abcdef0123456789abcdef'

const sleep = async (ms: number): Promise<void> => { await new Promise<void>((resolve) => { setTimeout(resolve, ms) }) }

/** 等到谓词为真（**不用 `expect.poll`**：这里等的是调度现象，判据在断言里给）。 */
async function waitFor(predicate: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (!predicate() && Date.now() < deadline) await sleep(5)
  return predicate()
}

/** 竞速观察：预算内结算就返回结果串，否则 `'PENDING'`。 */
async function settle<T>(promise: Promise<T>, ms: number): Promise<string> {
  const tag = 'PENDING'
  return await Promise.race([
    promise.then(() => 'resolved', (cause: unknown) => `rejected:${cause instanceof Error ? cause.name : String(cause)}`),
    sleep(ms).then(() => tag),
  ])
}

/**
 * 第一路调用可以"卡住"或"永不结束"的假适配器。
 *
 * `endless` = 上游读永不结束（abort 也收不了尾）——VB-N3 的形态；`stallMs` = 卡一段再抛错
 * ——VB-N2 的形态。
 */
class ProbeAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private releaseHung: (() => void) | undefined
  constructor(private readonly options: { stallMs?: number, endless?: boolean, secondStreamMs?: number } = {}) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  /** 放行被卡住的第一路（`endless` 形态）。 */
  release(): void {
    this.releaseHung?.()
    this.releaseHung = undefined
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const index = this.requests.push(options)
    if (index === 1 && this.options.endless === true) {
      await new Promise<void>((resolve) => { this.releaseHung = resolve })
      throw new Error('upstream released after hang')
    }
    if (index === 1 && (this.options.stallMs ?? 0) > 0) {
      await sleep(this.options.stallMs ?? 0)
      throw new Error('upstream stalled')
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    if (index > 1 && (this.options.secondStreamMs ?? 0) > 0) await sleep(this.options.secondStreamMs ?? 0)
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const roots: string[] = []
const live: Context[] = []
afterEach(async () => {
  for (const ctx of live.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** 与生产同形的最小 agent 平面 + **真 jsonl 持久化**（写句柄的持有者就是它）。 */
async function plane(adapter: LlmAdapter): Promise<Context> {
  const root = mkdtempSync(join(tmpdir(), 'r14laneN-gate-'))
  roots.push(root)
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
  await ctx.plugin(SessionPersistenceJsonl, { root })
  ctx.llm.registerAdapter(['mock'], adapter)
  ctx.provide('picoSession', { isRestored: () => false, getSession: () => null })
  return ctx
}

/** 句柄处置账本（判"谁被 dispose 了"）+ `whenIdle` 加宽的**自校准**证据。 */
interface Ledger {
  readonly handles: Array<{ readonly sessionId: string, disposedAt: number | undefined }>
  /**
   * 加宽窗口的**自校准**证据：加宽那一次 `whenIdle` 恢复之后，新一轮的句柄是否**已经**发布。
   *
   * 不校准就会出现"判据空转"：如果加宽打错了调用者（例如打到 `dispose()` 内部的等待上），
   * 旧轮的收尾会一直早于闸门放行 ⇒ 无论栅栏在不在，断言都恒绿。这个布尔值把那种情况变成
   * 一条**响亮的红**（"判据不再咬得住"），而不是静默变弱。
   */
  wipeWindowOpen: boolean
}

/**
 * 包装句柄工厂：记账每次 `dispose()`，并给**指定会话的第一个句柄**的 `whenIdle` 加一个宏任务。
 *
 * 为什么加宽要打在 `whenIdle` 上：`runTurn` 在 `await agent.whenIdle()` 之后**同步**走到
 * `finally` ⇒ 让这个 await 多跨一个宏任务，就等价于"被放弃那一轮的 `finally` 晚于闸门放行
 * 落地"（V14-B 在源码里加的正是这一句 `setTimeout`）。直接赋值是安全的：Agent 是普通对象
 * （探针实测 `Object.isFrozen(agent) === false`、原型方法 `writable`），且**对象身份不变**
 * ——`runTurn` 的 `agent/assistant-stream` 处理器按 `subject !== agent` 过滤，换 Proxy 会把
 * 增量全丢掉。
 * @param ctx - agent 平面。
 * @param widenedSessionId - 需要加宽收尾的会话 id（`undefined` = 不加宽）。
 * @param widenMs - 加宽的宏任务时长。
 * @returns 处置账本。
 */
function instrument(ctx: Context, widenedSessionId: string | undefined, widenMs = 120): Ledger {
  const ledger: Ledger = { handles: [], wipeWindowOpen: false }
  let widened = false
  const wrap = (sessionId: string, handle: AgentHandle): AgentHandle => {
    const record = { sessionId, disposedAt: undefined as number | undefined }
    ledger.handles.push(record)
    if (!widened && widenedSessionId !== undefined && sessionId === widenedSessionId) {
      widened = true
      const realWhenIdle = handle.agent.whenIdle.bind(handle.agent)
      let calls = 0
      handle.agent.whenIdle = async (): Promise<void> => {
        calls += 1
        const widenedCall = calls === 1
        await realWhenIdle()
        if (!widenedCall) return
        await sleep(widenMs)
        // 自校准：加宽窗口真的开着吗（新一轮的句柄此刻已经发布）？
        ledger.wipeWindowOpen = ledger.handles.length >= 2
      }
    }
    const realDispose = handle.dispose.bind(handle)
    return {
      agent: handle.agent,
      dispose: async (): Promise<void> => {
        record.disposedAt = Date.now()
        await realDispose()
      },
    }
  }
  const realCreate = ctx.agents.create.bind(ctx.agents)
  const realResume = ctx.agents.resume.bind(ctx.agents)
  ctx.agents.create = async (options: CreateAgentOptions): Promise<AgentHandle> =>
    wrap(String(options.sessionId), await realCreate(options))
  ctx.agents.resume = async (options: { resumeSessionId: SessionIdType } & Record<string, unknown>): Promise<AgentHandle> =>
    wrap(String(options.resumeSessionId), await realResume(options as Parameters<typeof realResume>[0]))
  return ledger
}

describe('R14 VB-N2：被放弃那一轮的 finally 不许 dispose 新轮的句柄', () => {
  it('①闸门放行 + 新轮发布句柄之后，旧轮收尾不得动它（live/注册表/句柄账本三处都要干净）', async () => {
    const adapter = new ProbeAdapter({ stallMs: 400 })
    const ctx = await plane(adapter)
    const ledger = instrument(ctx, SESSION_ID)
    const warnings: string[] = []
    const runner = createAppAiRunner(ctx, { cwd: '/tmp/app-ai', warn: (message) => warnings.push(message) })
    const run = async (content: string): Promise<unknown> =>
      await runner.run({ sessionId: SESSION_ID, appId: 'demo', messages: [{ role: 'user', content }], onDelta: () => {}, signal: new AbortController().signal })

    const first = run('first')
    first.catch(() => {})
    // 现象：第一轮真的进到模型流（"被放弃的那一轮握着写句柄"这个前提才成立）。
    expect(await waitFor(() => adapter.requests.length === 1, 3000), '第一轮没有进到模型流').toBe(true)

    const release = runner.releaseAll('session-changed')
    const second = run('second')
    second.catch(() => {})

    // 等第二轮**真的发布了自己的句柄**（它必须等到闸门放行，也就是第一轮的写句柄释放之后）。
    expect(await waitFor(() => ledger.handles.length === 2, 5000), '第二轮没能在闸门放行后开出自已的句柄').toBe(true)
    // 再加宽的窗口：给"旧轮的 finally"足够时间落地（加宽就打在旧轮的 whenIdle 上）。
    await sleep(240)
    // 自校准前提：加宽的那一刻新一轮的句柄必须**已经**发布（否则本用例是空转的）。
    expect(ledger.wipeWindowOpen, '加宽窗口没有打开（判据不再咬得住 VB-N2）：加宽打到了错误的 whenIdle 调用者').toBe(true)

    // 判据本体（修复前：`live` 被清空、agent 从注册表消失、第二轮的句柄被 dispose）。
    expect(runner.liveSessions(), '旧轮的收尾把新轮从 live 里摘掉了（VB-N2）').toBe(1)
    expect(ctx.agents.get(SESSION_ID as unknown as SessionIdType), '新轮的 agent 被旧轮 dispose 掉了（VB-N2）').toBeDefined()
    expect(ledger.handles[1]?.disposedAt, '新轮的句柄被旧轮 dispose 掉了（VB-N2）').toBeUndefined()

    await release
    expect(await settle(second, 8000), '第二轮必须正常跑完').toBe('resolved')
    expect(await settle(first, 2000), '被放弃的那一轮必须收场（不挂住）').toMatch(/^rejected/u)
    // 修复前的症状之一：撞写句柄（`already owned by an active write handle`）。
    expect(warnings.filter((message) => /already owned|SessionAlreadyOwned/u.test(message)), '出现了写句柄相撞').toEqual([])
    // 收尾之后 live 里留下的是第二轮那一代（不是被清空）。
    expect(runner.liveSessions()).toBe(1)
  })

  it('②流式中途被偷则整轮失败：第二轮必须把正文交付出来', async () => {
    const adapter = new ProbeAdapter({ stallMs: 400, secondStreamMs: 400 })
    const ctx = await plane(adapter)
    const ledger = instrument(ctx, SESSION_ID)
    const runner = createAppAiRunner(ctx, { cwd: '/tmp/app-ai', warn: () => {} })
    const run = async (content: string): Promise<{ content: string }> =>
      await runner.run({ sessionId: SESSION_ID, appId: 'demo', messages: [{ role: 'user', content }], onDelta: () => {}, signal: new AbortController().signal }) as { content: string }

    const first = run('first')
    first.catch(() => {})
    expect(await waitFor(() => adapter.requests.length === 1, 3000), '第一轮没有进到模型流').toBe(true)
    const release = runner.releaseAll('session-changed')
    const second = run('second')
    second.catch(() => {})

    // 现象：第二轮的模型流已经开始（中途）而旧轮的收尾还没落地。
    expect(await waitFor(() => adapter.requests.length === 2, 5000), '第二轮没能开始模型流').toBe(true)
    await sleep(240)
    // 自校准前提：同①（加宽窗口必须真的开着，否则本用例空转）。
    expect(ledger.wipeWindowOpen, '加宽窗口没有打开（判据不再咬得住 VB-N2）').toBe(true)

    // 修复前这里会以 `the application AI turn produced no assistant message` 失败（流被偷断）。
    await expect(second, '流式中途被上一轮的收尾偷走了句柄（VB-N2）').resolves.toEqual({ content: 'ok' })
    await release
    expect(ledger.handles[1]?.disposedAt).toBeUndefined()
  })
})

describe('R14 VB-N3：闸门等待有界、看 signal、不放行第二个写句柄', () => {
  it('①收尾永不结算：releaseAll 有界返回，新一轮拿到显式错误码，且不会撞写句柄', async () => {
    const adapter = new ProbeAdapter({ endless: true })
    const ctx = await plane(adapter)
    const warnings: string[] = []
    const runner = createAppAiRunner(ctx, {
      cwd: '/tmp/app-ai',
      warn: (message) => warnings.push(message),
      releaseBudgetMs: 300,
      releaseReturnBudgetMs: 300,
    })
    const run = async (content: string, signal = new AbortController().signal): Promise<unknown> =>
      await runner.run({ sessionId: SESSION_ID, appId: 'demo', messages: [{ role: 'user', content }], onDelta: () => {}, signal })

    const first = run('first')
    first.catch(() => {})
    expect(await waitFor(() => adapter.requests.length === 1, 3000), '第一轮没有进到模型流').toBe(true)

    const startedAt = Date.now()
    // 判据一：`releaseAll` 是订阅回调里的清理路径 —— 不许被一条永不结束的上游读挂住。
    expect(await settle(runner.releaseAll('session-changed'), 3000), 'releaseAll 被永不结算的收尾挂住了（VB-N3）').toBe('resolved')
    expect(Date.now() - startedAt, 'releaseAll 没有在有界预算内返回').toBeLessThan(3000)
    // 判据一的后半：有界放弃必须**留下一条带显式错误码的 warn**（否则运维看到的只是"什么都没发生"，
    // 而调用方也没法把它和"释放成功"区分开 —— 静默的放弃就是这条缺陷最初的样子）。
    expect(
      warnings.filter((message) => message.includes('did not settle within') && message.includes(APP_AI_SESSION_RELEASE_PENDING)).length,
      'releaseAll 的有界放弃没有留下可检索的诊断行',
    ).toBeGreaterThan(0)

    // 判据二：新一轮拿到**显式错误码**，而不是永久挂住、也不是撞写句柄。
    const second = run('second')
    second.catch(() => {})
    const outcome = await settle(second, 3000)
    expect(outcome, '新一轮被永久挂住了（VB-N3）').toBe('rejected:AppAiSessionReleasePendingError')
    await expect(second).rejects.toMatchObject({ name: 'AppAiSessionReleasePendingError', code: APP_AI_SESSION_RELEASE_PENDING })
    // 判据三：**没有开第二个写句柄** ⇒ 适配器只被调用过一次（撞句柄的形态是"调用两次后第二个失败"）。
    expect(adapter.requests, '超预算后放行了第二个写句柄（会把 SessionAlreadyOwnedError 引回来）').toHaveLength(1)
    expect(warnings.filter((message) => message.includes(APP_AI_SESSION_RELEASE_PENDING)).length, '超预算必须留下带显式错误码的 warn').toBeGreaterThan(0)

    // 判据四：卡住的上游一旦收尾，闸门自动放行 —— 不需要重启进程。
    adapter.release()
    const third = run('third')
    third.catch(() => {})
    expect(await settle(third, 8000), '上游收尾之后该会话必须自动恢复').toBe('resolved')
  })

  it('②等待期间 abort（页面关闭/超时）必须立刻退出，而不是等满预算', async () => {
    const adapter = new ProbeAdapter({ endless: true })
    const ctx = await plane(adapter)
    const runner = createAppAiRunner(ctx, {
      cwd: '/tmp/app-ai',
      warn: () => {},
      // 预算给得很大：唯一能在 2s 内退出的路径就是 abort（否则这条用例会以错误原因红）。
      releaseBudgetMs: 20_000,
      releaseReturnBudgetMs: 20_000,
    })
    const run = async (content: string, signal: AbortSignal): Promise<unknown> =>
      await runner.run({ sessionId: SESSION_ID, appId: 'demo', messages: [{ role: 'user', content }], onDelta: () => {}, signal })

    const first = run('first', new AbortController().signal)
    first.catch(() => {})
    expect(await waitFor(() => adapter.requests.length === 1, 3000), '第一轮没有进到模型流').toBe(true)
    try {
      void runner.releaseAll('session-changed')

      const controller = new AbortController()
      const second = run('second', controller.signal)
      second.catch(() => {})
      await sleep(120)
      const startedAt = Date.now()
      controller.abort()
      const outcome = await settle(second, 4000)
      expect(outcome, 'abort 没有把等待闸门的那一轮解开（VB-N3）').toBe('rejected:AbortError')
      expect(Date.now() - startedAt, 'abort 之后退出得太慢（看起来是预算而不是 signal 在起作用）').toBeLessThan(2000)
    } finally {
      // 收工前放行被卡住的上游：否则真平面的 `dispose()` 会等这条永不结束的流（用例尾部挂住）。
      adapter.release()
    }
  })

  it('③键隔离：被卡住的那个会话不许影响别的隐藏会话', async () => {
    const adapter = new ProbeAdapter({ endless: true })
    const ctx = await plane(adapter)
    const runner = createAppAiRunner(ctx, { cwd: '/tmp/app-ai', warn: () => {}, releaseBudgetMs: 200, releaseReturnBudgetMs: 200 })
    const run = async (sessionId: string, content: string): Promise<unknown> =>
      await runner.run({ sessionId, appId: 'demo', messages: [{ role: 'user', content }], onDelta: () => {}, signal: new AbortController().signal })

    const stuck = run(SESSION_ID, 'first')
    stuck.catch(() => {})
    expect(await waitFor(() => adapter.requests.length === 1, 3000), '第一轮没有进到模型流').toBe(true)
    try {
      void runner.releaseAll('session-changed')
      expect(await settle(run(SESSION_ID, 'second'), 3000)).toBe('rejected:AppAiSessionReleasePendingError')
      // B 账号没有被 releaseAll 波及（它本来就不在 live 里）⇒ 照常跑完。
      expect(await settle(run(OTHER_SESSION_ID, 'other'), 8000)).toBe('resolved')
    } finally {
      // 收工前放行被卡住的上游（同②：不然真平面的 dispose 会挂在永不结束的流上）。
      adapter.release()
    }
  })
})

describe('R14 VB-N3：协议层的显式映射（真 handleAiChat × 真错误类）', () => {
  it('收尾未落地的失败映射成 503 + 明确的"还在关闭中"文案（不是笼统的 502）', async () => {
    const failure = new AppAiSessionReleasePendingError(SESSION_ID, 15_000)
    const warnings: string[] = []
    const outcome = await handleAiChat(
      {
        authorization: { isGranted: async () => true, grant: async () => {}, revoke: async () => {} },
        runner: {
          async run(): Promise<never> { throw failure },
        },
        scope: () => ({ userId: 'alice', serverURL: 'https://harness.example.com' }),
        warn: (message) => warnings.push(message),
      },
      'demo',
      Buffer.from(JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], stream: false })),
      new AbortController().signal,
    )
    expect(outcome.kind).toBe('json')
    if (outcome.kind !== 'json') return
    expect(outcome.status).toBe(503)
    // 信封 code 留在冻结集合内（§21.2 不减项），可区分性由文案与宿主 warn 承担。
    expect(outcome.body).toMatchObject({
      error: {
        code: 'app_ai_unavailable',
        message: 'the previous AI turn on this application is still shutting down; retry in a moment',
      },
    })
    // 宿主日志必须带**显式错误码**（这正是修复前完全缺失的可诊断出口）。
    expect(warnings.join('\n')).toContain(APP_AI_SESSION_RELEASE_PENDING)
    // 错误类自身的身份（协议层按 `name` 认它：改名而不同步 mapper 即红）。
    expect(failure.name).toBe('AppAiSessionReleasePendingError')
    expect(failure.code).toBe(APP_AI_SESSION_RELEASE_PENDING)
  })
})
