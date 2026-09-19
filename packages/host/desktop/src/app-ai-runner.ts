/**
 * 应用 AI 的**执行面**（设计总纲 §21.2 步骤③）：在应用的隐藏会话上跑一轮
 * `ctx.agentLoop`，把 assistant 增量交给协议 handler（`ai-chat.ts` 的 `runTurn`）。
 *
 * ## 本模块拥有什么
 *
 *  - **隐藏会话**：会话 id 是 `app:<app_id>`（`ai-chat.ts` 的冻结前缀），元数据带
 *    `origin: 'subagent'` —— 那是 DSH 已有的"不进侧边栏"标记
 *    （`ui-workspace/tree.ts` 的 `sessionVisible` 把 `origin === 'subagent'` 排除在
 *    普通会话树之外），而落到磁盘的会话仍然**可诊断**（诊断包/会话清单照常列出）。
 *  - **工具集为空**：`agentCtx.tools.restrict({ allow: [] })`。用**白名单空集**而不是
 *    逐个 deny：deny 名单会随上游新增工具而过期，空 allow 永远等于"一个都不给"。
 *  - **仅本次 messages**：装配瀑布里清掉 `contexts`（记忆/时间等运行时上下文全部在此
 *    注入），并把系统提示收敛成平台给的那一条 ⇒ 请求体里只有平台提示 + 会话日志里的
 *    对话消息。
 *  - **增量与取消**：`agent/assistant-stream` 的 `text-delta` 按序回调；`AbortSignal`
 *    触发 `agent.cancel({kind:'user'})`。
 *  - **无孤儿循环**：一轮结束（成功/失败/取消）即 `dispose()` 该 agent —— 会话退出
 *    活体、循环收敛；下一次调用按持久化会话恢复（多轮上下文来自隐藏会话自身）。
 *
 * ## 上下文对账（为什么不是"把 messages 原样喂进去"）
 *
 * DSH 的模型请求是**会话日志的纯函数**（`agent-loop` 的 reconstructability 契约）：
 * 要让请求体等于应用这次传来的 `messages`，日志里就必须已经有这份对话。应用每次传的
 * 是**累积历史**（本仓的 `AppAiPanel` 就是如此），所以本模块取"应用 messages 与会话
 * 日志对话的最长公共前缀"，只把**新增的尾巴**入队 ⇒
 *  ① 首轮：日志为空 ⇒ 整个列表都是新增；
 *  ② 第二轮：应用重发 `[u1,a1,u2]`，日志里已有 `[u1,a1]` ⇒ 只入队 `u2`。
 * 两边不一致（应用改写了历史）时以应用的最新尾巴为准并记一条 warn —— 会话日志是
 * **追加**的，改写历史没有原地替换的语义。
 *
 * @module dsh-plugin-desktop/app-ai-runner
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentOptions, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionId as SessionIdType } from '@deepseek-ai/dsh-session'
import type {
  AiChatMessage,
  AiChatTurnResult,
  AiChatTurnRunner,
} from '@picoaide/dsh-wasm-apps-host/ai-chat'

/**
 * 应用 AI 的系统提示（§21.1 第 14 条：应用**不得**声明提示，平台统一给）。
 *
 * 只描述"你是什么、能做什么、不能做什么"：没有工具、没有文件系统、看不到该员工的
 * 其它会话 —— 与应用页面的用户看到的行为一致。
 */
export const APP_AI_SYSTEM_PROMPT = [
  'You are the AI assistant embedded in an application window of a desktop client.',
  'Answer the conversation you are given, in the language the user writes in.',
  'You have no tools: you cannot read or write files, run commands, search the web, or look at anything outside this conversation.',
  'You cannot see the user\'s other conversations or any stored memory. Only the messages in this conversation are available to you.',
  'If a request needs something outside this conversation, say so plainly instead of guessing.',
].join('\n')

/** 平台系统提示的分段名（装配瀑布按它收敛 sections）。 */
export const APP_AI_PROMPT_SECTION = 'pico-app-ai'

/** 隐藏会话的工作目录（`{{cwd}}` 变量必须有值；AI 没有文件面，这个路径只是元数据）。 */
export interface AppAiRunnerOptions {
  /** 隐藏会话的 `cwd` 元数据（绝对路径；缺省会话不带 cwd 时 persona 模板会渲染失败）。 */
  cwd: string
  /** 诊断出口。 */
  warn?: ((message: string) => void) | undefined
}

/** 会话日志里的一条对话（只有 user/assistant 的文本面）。 */
interface ConversationTurn {
  readonly role: 'user' | 'assistant'
  readonly content: string
}

/** 把内容块投影成纯文本（非文本块不参与对账：AI 桥的 `messages` 只有字符串）。 */
function textOf(content: readonly ContentBlock[]): string {
  return content.flatMap(block => (block.type === 'text' ? [block.text] : [])).join('')
}

/**
 * 读会话日志里的对话面（**只读普通用户消息**）。
 *
 * `user/message` 还承载注入的上下文（source 不是 `user`），它们不属于对话；把它们算进
 * 对账会让"应用重发历史"永远对不上。
 * @param agent - 隐藏会话上的 agent。
 * @returns 按日志顺序的对话。
 */
function conversationOf(agent: Agent): ConversationTurn[] {
  const turns: ConversationTurn[] = []
  for (const event of agent.session.snapshotEvents()) {
    if (event.type === 'user/message') {
      if (event.data.source.kind !== 'user') continue
      turns.push({ role: 'user', content: textOf(event.data.content) })
      continue
    }
    if (event.type === 'assistant/message') {
      turns.push({ role: 'assistant', content: textOf(event.data.message.content) })
    }
  }
  return turns
}

/** 最长公共前缀长度（role + 正文逐字相同）。 */
function commonPrefixLength(logged: readonly ConversationTurn[], incoming: readonly ConversationTurn[]): number {
  let index = 0
  while (index < logged.length && index < incoming.length) {
    const left = logged[index] as ConversationTurn
    const right = incoming[index] as ConversationTurn
    if (left.role !== right.role || left.content !== right.content) break
    index += 1
  }
  return index
}

/** 最近一条 assistant 正文（日志里没有 ⇒ `null`）。 */
function lastAssistant(agent: Agent): { content: string, usage?: { promptTokens?: number, completionTokens?: number } } | null {
  const events = agent.session.snapshotEvents()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'assistant/message') continue
    const usage = event.data.usage
    return {
      content: textOf(event.data.message.content),
      ...(usage === undefined
        ? {}
        : { usage: { promptTokens: usage.inputTokens, completionTokens: usage.outputTokens } }),
    }
  }
  return null
}

/** 取消错误（`handleAiChat` 按 `name === 'AbortError'` 映射成 `ai_cancelled`）。 */
function aborted(): Error {
  const error = new Error('the application AI turn was cancelled')
  error.name = 'AbortError'
  return error
}

/**
 * 构造应用 AI 的执行面。
 *
 * 需要 `ctx.agents`（`@deepseek-ai/dsh-agent` 的注册表）与 `ctx.agentLoop`
 * （`@deepseek-ai/dsh-agent-loop`）；两者都由桌面宿主 profile 的 `agent-loop` 行提供。
 * 缺席 ⇒ 这里**抛错**（调用方 `handleAiChat` 已经用 runner 缺席表达
 * `app_ai_unavailable`，不缺也不假装能跑）。
 * @param ctx - 宿主 Cordis 上下文（同一棵树里的 agent 平面）。
 * @param options - 隐藏会话元数据与诊断出口。
 * @returns 一轮对话的执行面。
 */
export function createAppAiRunner(ctx: Context, options: AppAiRunnerOptions): AiChatTurnRunner {
  const warn = options.warn ?? ((): void => {})
  /** 每会话串行化：一个隐藏会话同一时刻只能跑一轮（第二个请求排队而不是撞进度）。 */
  const queues = new Map<string, Promise<unknown>>()

  const serialize = async <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const previous = queues.get(key) ?? Promise.resolve()
    const run = previous.then(task, task)
    const settled = run.catch(() => undefined)
    queues.set(key, settled)
    try {
      return await run
    } finally {
      // 只有队尾还是自己时才出队：后来的等待者已经把自己的 promise 放进 map。
      if (queues.get(key) === settled) queues.delete(key)
    }
  }

  /** 该 agent 的装配收敛：空工具集、平台提示、无运行时上下文。 */
  const compose = (agentCtx: Context): void => {
    // 白名单空集 = 一个全局工具都不给（deny 名单会随上游新增工具而过期）。
    agentCtx.tools.restrict({ allow: [] })
    // 运行时上下文（记忆快照走这里）在 agent 作用域内整体抑制：比"清空装配结果"
    // 更早、更结构化，且不依赖瀑布顺序。
    agentCtx.systemPrompt.suppressRuntimeContext()
    // `complete: true` = 这一条就是完整系统提示：装配瀑布照常跑（工具/变量仍解析），
    // 之后**恢复**本段为唯一的 sections ⇒ persona/工具指引/记忆段落一个都进不来。
    agentCtx.systemPrompt.section({
      name: APP_AI_PROMPT_SECTION,
      order: 1_000_000,
      text: APP_AI_SYSTEM_PROMPT,
      complete: true,
    })
  }

  /**
   * 平台统一模型（§21.1 第 14 条：应用不得声明提示/模型/温度）。
   *
   * 取值来自 `agentDefaultModel` 服务（桌面 profile 的 `agent-default-model` 行；
   * enterprise 登录后把服务端下发的默认模型写进它的 settings）——与用户自己新建会话
   * 用的是同一个缺省，所以"应用 AI 花的是使用者的账、走平台统一模型"。
   * @returns agent 选项；没有该服务时返回空（让 agent-loop 自己报"没有模型"）。
   */
  const agentOptions = (): AgentOptions => {
    const selection = (ctx.get('agentDefaultModel') as { currentSelection?: () => ModelSelection } | undefined)?.currentSelection?.()
    if (selection === undefined || selection.provider === '' || selection.model === '') return {}
    return {
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
    }
  }

  /**
   * 打开（或复用）隐藏会话。
   *
   * 会话在两次调用之间**保持活着**：它就是该应用的对话本体（§21.1 Q5 的多轮上下文），
   * 每轮结束就 dispose + 下一轮 resume 会把"读日志"变成每次调用的固定成本，也让
   * "没有持久化的宿主"（纯 Node 冒烟）丢掉上下文。**取消/出错**时才丢弃它（见
   * `dropAgent`）——那两条路径必须保证不留活体循环。
   */
  const live = new Map<string, Promise<AgentHandle>>()

  const openAgent = async (sessionId: string): Promise<AgentHandle> => {
    const cached = live.get(sessionId)
    if (cached !== undefined) {
      const handle = await cached
      // 活体判据：agent 已经离开注册表（被别处 dispose）= 缓存过期，重开一次。
      if ((ctx.get('agents') as { get?: (id: SessionIdType) => Agent | undefined } | undefined)?.get?.(SessionId(sessionId)) !== undefined) {
        return handle
      }
      live.delete(sessionId)
    }
    const pending = openAgentUncached(sessionId)
    live.set(sessionId, pending)
    try {
      return await pending
    } catch (cause) {
      if (live.get(sessionId) === pending) live.delete(sessionId)
      throw cause
    }
  }

  const openAgentUncached = async (sessionId: string): Promise<AgentHandle> => {
    const agents = ctx.get('agents') as {
      create?: (options: CreateAgentOptions) => Promise<AgentHandle>
      resume?: (options: {
        resumeSessionId: SessionIdType
        agentOptions?: AgentOptions
        setup?: (agentCtx: Context, agent: Agent) => void
      }) => Promise<AgentHandle>
    } | undefined
    if (agents?.create === undefined || agents.resume === undefined) {
      throw new Error('the application AI bridge needs the agent registry (agent-loop) in this client')
    }
    const id = SessionId(sessionId)
    const persistence = ctx.get('sessionPersistence') as { stat?: (id: SessionIdType) => Promise<unknown> } | undefined
    const stored = persistence?.stat === undefined ? undefined : await persistence.stat(id)
    if (stored !== undefined && stored !== null) {
      return await agents.resume({ resumeSessionId: id, agentOptions: agentOptions(), setup: compose })
    }
    return await agents.create({
      sessionId: id,
      // 隐藏会话元数据：`origin: 'subagent'` = 不进普通会话树（§21.1 Q6「隐藏但可查」），
      // `cwd` 只为了让 persona 模板的 `{{cwd}}` 有值（AI 没有文件面）。
      meta: { cwd: options.cwd, origin: 'subagent' },
      agentOptions: agentOptions(),
      setup: compose,
    })
  }

  /** 丢弃隐藏会话（取消/出错路径：不留活体循环，也不留半截状态）。 */
  const dropAgent = async (sessionId: string): Promise<void> => {
    const cached = live.get(sessionId)
    live.delete(sessionId)
    if (cached === undefined) return
    try {
      const handle = await cached
      await handle.dispose()
    } catch (cause) {
      warn(`dsh-plugin-desktop: disposing the application AI session failed (${cause instanceof Error ? cause.message : String(cause)})`)
    }
  }

  /** 一轮对话（已在会话串行队列里）。 */
  const runTurn = async (
    sessionId: string,
    messages: readonly AiChatMessage[],
    onDelta: (text: string) => void,
    signal: AbortSignal,
  ): Promise<AiChatTurnResult> => {
    if (signal.aborted) throw aborted()
    const handle = await openAgent(sessionId)
    const agent = handle.agent
    const disposeStream = agent.ctx.on('agent/assistant-stream', ({ agent: subject, frame }) => {
      if (subject !== agent) return
      if (frame.type !== 'chunk') return
      const chunk = frame.chunk
      if (chunk.type !== 'text-delta') return
      onDelta(chunk.text)
    })
    /**
     * 这一轮里 agent 报出的第一个错误。
     *
     * 必须留住它：上游把"余额不足/限流"作为 `agent/error` 报告，而 `handleAiChat`
     * 的错误码（`ai_balance_insufficient` / `ai_rate_limited`）是**按错误消息**映射的 ——
     * 吞掉它，应用侧就只会看到笼统的 `app_ai_unavailable`（把"没钱了"说成"服务挂了"）。
     */
    let failure: unknown
    const disposeErrors = agent.ctx.on('agent/error', ({ agent: subject, error }) => {
      if (subject !== agent) return
      failure ??= error
    })
    const onAbort = (): void => { agent.cancel({ kind: 'user' }) }
    signal.addEventListener('abort', onAbort, { once: true })
    let finished = false
    try {
      const logged = conversationOf(agent)
      const incoming: ConversationTurn[] = messages.map(message => ({ role: message.role, content: message.content }))
      const common = commonPrefixLength(logged, incoming)
      let pending = incoming.slice(common).filter(message => message.role === 'user')
      if (incoming.length - common > pending.length) {
        warn('dsh-plugin-desktop: the application sent messages that rewrite the hidden conversation; only the new user messages were queued')
      }
      if (pending.length === 0) {
        // 应用原样重发了已完成的对话（重试/重放）：不消耗任何 token，直接回上一次的回答。
        const previous = lastAssistant(agent)
        if (previous !== null) {
          finished = true
          return previous
        }
        pending = logged.at(-1)?.role === 'user' ? [{ role: 'user', content: logged.at(-1)?.content ?? '' }] : []
      }
      if (pending.length === 0) {
        throw new Error('the application AI request carried no message the hidden session has not already answered')
      }
      // 一轮 = 最后一条用户消息；更早的（应用改写历史时才可能出现）只记 warn：
      // 一条 followup 就是一轮，把它们逐个入队会把一次请求变成多次模型调用。
      if (pending.length > 1) {
        warn(`dsh-plugin-desktop: the application AI request carried ${String(pending.length)} unanswered user messages; only the last one drives this turn`)
      }
      const driver = pending.at(-1) as ConversationTurn
      agent.followup(createUserMessage({ content: [{ type: 'text', text: driver.content }], source: { kind: 'user' } }))
      await agent.whenIdle()
      if (signal.aborted) throw aborted()
      if (failure !== undefined) throw failure
      const final = lastAssistant(agent)
      if (final === null) throw new Error('the application AI turn produced no assistant message')
      // 正文以**日志里的已提交消息**为准（增量只用于"边跑边显示"）：重试过一次的
      // attempt 会让增量流里出现重复前缀，而日志里只有最后提交的那一条。
      finished = true
      return final
    } finally {
      signal.removeEventListener('abort', onAbort)
      disposeStream()
      disposeErrors()
      // 只有"这一轮正常收尾"才留着会话：取消与出错都丢弃（前者是页面关闭/用户停止，
      // 后者是会话可能停在半截状态）。
      if (!finished) await dropAgent(sessionId)
    }
  }

  return {
    async run({ sessionId, messages, onDelta, signal }): Promise<AiChatTurnResult> {
      return await serialize(sessionId, async () => await runTurn(sessionId, messages, onDelta, signal))
    },
    cancel(sessionId: string): void {
      const agent = (ctx.get('agents') as { get?: (id: SessionIdType) => Agent | undefined } | undefined)?.get?.(SessionId(sessionId))
      agent?.cancel({ kind: 'user' })
      // 取消后立刻丢弃：下一次调用重新建立会话（活体只服务"正在跑的那一轮"）。
      void dropAgent(sessionId)
    },
  }
}
