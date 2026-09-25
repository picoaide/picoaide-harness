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
 *  - **换账号即释放**（R13-GB）：`pico/session-changed` ⇒ `releaseAll()`：在飞的那一轮
 *    被取消、全部活体会话 `dispose()`、排队中的轮次被拒。**磁盘上的会话不删**（它是
 *    那个账号自己的历史，同账号重登仍然续用；而换账号后新 id 已经指向另一个会话）。
 *    订阅走叶子包的 `subscribeSessionChanges`（唯一实现：先订阅 + 补发恢复型启动那一次）
 *    —— 裸 `ctx.on` 会漏掉"重启后带着有效会话"这条最常见的启动路径。
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
import { subscribeSessionChanges } from '@picoaide/dsh-host-locale/session-events'
import type {
  AiChatMessage,
  AiChatTurnResult,
  AiChatTurnRunner,
} from '@picoaide/dsh-wasm-apps-host/ai-chat'
import { WASM_APPS_AI_RUNNER_SERVICE } from '@picoaide/dsh-wasm-apps-host'

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

/**
 * 应用 AI 执行面的**自省与释放面**（判据用；`AiChatTurnRunner` 的生产超集）。
 *
 * 为什么把这些计数做成公开面：换账号后"活体会话与队列都清空"这条判据必须有**可观测**
 * 的输入 —— 否则只能靠"再跑一轮看看请求体里有没有别人的内容"这种间接证据（那正是
 * R13-E-04 探针的形态，能证明缺陷存在，却不适合当长期回归判据）。
 */
export interface AppAiRunnerState {
  /** 当前**活体**隐藏会话数（`live` 的条目数）。 */
  liveSessions(): number
  /** 当前**排队中**的隐藏会话数（`queues` 的条目数）。 */
  queuedSessions(): number
  /** 会话代次：每次释放 +1（0 = 从未释放）。 */
  generation(): number
  /**
   * 释放全部活体会话与队列（`pico/session-changed` 的生产路径）。
   *
   * 语义：在飞的那一轮被取消、每个活体 agent `dispose()`、排队中的轮次在起跑前被拒
   * （`AbortError` ⇒ 应用侧看到 `ai_cancelled`）。**磁盘会话不删**：它是那个账号自己的
   * 历史（同账号重登继续续用），而换账号后新 id 已经指向另一个会话文件。
   */
  releaseAll(reason: string): Promise<void>
}

/** 执行面 + 自省面（`createAppAiRunner` / `provideAppAiRunner` 的返回类型）。 */
export type AppAiRunnerHandle = AiChatTurnRunner & AppAiRunnerState

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
export function createAppAiRunner(ctx: Context, options: AppAiRunnerOptions): AppAiRunnerHandle {
  const warn = options.warn ?? ((): void => {})
  /** 每会话串行化：一个隐藏会话同一时刻只能跑一轮（第二个请求排队而不是撞进度）。 */
  const queues = new Map<string, Promise<unknown>>()
  /**
   * 会话**代次**：换账号/登出（`releaseAll`）时 +1。
   *
   * 排队中的轮次在起跑前比对它 —— 一句 `queues.clear()` 只是清了记账，`serialize` 手里
   * 的 promise 链仍会把这批任务跑到（它们属于**上一个账号**的请求，会重新 `resume` 那个
   * 账号的会话）。代次让它们在起跑时被拒，而不是把已释放的会话又拉起来。
   */
  let generation = 0

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

  /**
   * 每个会话 id 上「上一个活体正在收尾」的 promise —— **释放窗口的闸门**（R14 C-02）。
   *
   * 为什么必须有它：`dropAgent`/`releaseAll` 都是"先从 `live` 里摘掉，再 `await dispose()`"，
   * 而 `dispose()` 要等被放弃那一轮的模型流真正收尾（真机上是一段可观测的时间：释放窗口
   * 实测 1.5 s 量级）。窗口里同一个隐藏会话 id 的新一轮会因为 `live` 已空而走
   * `openAgentUncached` ⇒ 上一个写句柄还没释放 ⇒ 持久化平面直接拒绝：
   *
   *	SessionAlreadyOwnedError: session "app:demo#alice@…" is already owned by an active write handle
   *
   * （没有持久化平面的宿主同形：`session "…" already exists`。窗口之外重试就成功 ——
   * 这正是"偶发失败、重试即好"的形态，应用侧只看到一张错误卡片。）
   *
   * 记账口径：登记发生在**任何 await 之前**（`dropAgent`/`releaseAll` 同步段），所以新一轮
   * 只要进 `openAgent` 就一定看得到它；收尾完成即从表里摘掉（不留长期引用）。
   */
  const releasing = new Map<string, Promise<void>>()

  /** 记账一次"某会话正在收尾"（同 id 多次收尾按顺序串起来，后一次不会先于前一次完成）。 */
  const trackReleasing = (sessionId: string, disposal: Promise<void>): void => {
    const previous = releasing.get(sessionId) ?? Promise.resolve()
    const chained = previous.then(() => disposal, () => disposal).catch(() => undefined)
    releasing.set(sessionId, chained)
    void chained.then(() => {
      if (releasing.get(sessionId) === chained) releasing.delete(sessionId)
    })
  }

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
    // 释放窗口闸门（R14 C-02）：同一个会话 id 的上一个活体必须**真的收尾**（写句柄已
    // 释放）之后才允许开下一个。没有这道闸门时，`releaseAll` 的窗口里到达的新一轮会
    // 撞上还没释放的写句柄 —— 真 jsonl 持久化实测
    // `SessionAlreadyOwnedError: session "…" is already owned by an active write handle`
    // （无持久化平面同形：`session "…" already exists`），窗口外重试才成功。
    const settling = releasing.get(sessionId)
    if (settling !== undefined) await settling
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
    const disposal = (async (): Promise<void> => {
      try {
        const handle = await cached
        await handle.dispose()
      } catch (cause) {
        warn(`dsh-plugin-desktop: disposing the application AI session failed (${cause instanceof Error ? cause.message : String(cause)})`)
      }
    })()
    // 登记在**任何 await 之前**（R14 C-02）：`cancel()` 是 fire-and-forget 调用本函数的，
    // 紧接着到来的新一轮必须看得见"这个会话还在收尾"。
    trackReleasing(sessionId, disposal)
    await disposal
  }

  /** 该会话当前的活体 agent（可能已经不在注册表里）。 */
  const agentOf = (sessionId: string): Agent | undefined =>
    (ctx.get('agents') as { get?: (id: SessionIdType) => Agent | undefined } | undefined)?.get?.(SessionId(sessionId))

  /**
   * 释放全部活体会话与队列（`pico/session-changed` 的生产路径；见 {@link AppAiRunnerState}）。
   *
   * 三步，顺序不能反：① 换代次（让排队中的轮次起跑即拒）→ ② 取消在飞的那一轮
   * （`agent.cancel({kind:'user'})`：循环立刻收尾，**不留写一半的会话**）→ ③ `dispose()`
   * 每个活体（会话退出注册表、循环收敛）。
   *
   * **磁盘上的隐藏会话一律不删**：那是那个账号自己的对话本体（同账号重登仍要续用它的
   * 多轮上下文），而"换账号"在新 id 形态下已经天然指向另一个会话文件（账号作用域）。
   * 删它才是错的：既毁掉历史，又会在同一账号重登时把上下文清空。
   *
   * **收尾窗口有闸门**（R14 C-02）：`live`/`queues` 是同步清空的，而 `dispose()` 要等被
   * 放弃那一轮的模型流收尾。窗口里到达的**同一个隐藏会话 id** 的新一轮会在 `openAgent`
   * 里等本次收尾落地（{@link trackReleasing}），而不是撞上还没释放的写句柄。
   */
  const releaseAll = async (reason: string): Promise<void> => {
    generation += 1
    const released = [...live.entries()]
    live.clear()
    queues.clear()
    if (released.length === 0) return
    for (const [sessionId] of released) {
      try {
        agentOf(sessionId)?.cancel({ kind: 'user' })
      } catch (cause) {
        warn(`dsh-plugin-desktop: cancelling the application AI turn failed after ${reason} (${cause instanceof Error ? cause.message : String(cause)})`)
      }
    }
    const disposals = released.map(async ([, cached]): Promise<void> => {
      try {
        const handle = await cached
        await handle.dispose()
      } catch (cause) {
        warn(`dsh-plugin-desktop: releasing the application AI session failed after ${reason} (${cause instanceof Error ? cause.message : String(cause)})`)
      }
    })
    // 登记在**任何 await 之前**（上面 `live.clear()` 到这里的同步段）：窗口里到来的新一轮
    // 必须看得见"这些会话还在收尾"。
    released.forEach(([sessionId], index) => {
      const disposal = disposals[index]
      if (disposal !== undefined) trackReleasing(sessionId, disposal)
    })
    await Promise.all(disposals)
  }

  /** 一轮对话（已在会话串行队列里）。 */
  const runTurn = async (
    sessionId: string,
    messages: readonly AiChatMessage[],
    onDelta: (text: string) => void,
    signal: AbortSignal,
    startedAt: number,
  ): Promise<AiChatTurnResult> => {
    if (signal.aborted) throw aborted()
    const handle = await openAgent(sessionId)
    // 等上一个活体收尾期间又换代（再次换账号/登出）⇒ 这一轮已不属于任何人：
    // 丢弃刚开的会话并按取消收场（`openAgent` 的等待是有时长的，代次检查必须复检）。
    if (startedAt !== generation) {
      await dropAgent(sessionId)
      throw aborted()
    }
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
      // 这一轮跑完之前被 `releaseAll` 释放（换账号/登出）⇒ 结果不再属于任何人的请求。
      if (startedAt !== generation) throw aborted()
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

  /**
   * 换账号/登出 ⇒ 释放全部活体会话（R13-GB 的第二半）。
   *
   * 订阅用叶子包的 {@link subscribeSessionChanges}（**唯一实现**：先订阅 + 用
   * `isRestored()` 补发"恢复型启动"那一次）。裸 `ctx.on` 在这里尤其危险：`provide` 发生在
   * profile 树挂载之前，恢复完成的那一刻恰好可能早于/晚于本订阅，漏掉它就等于"换账号后
   * 前一个账号的活体会话一直留着"。
   *
   * 回调里的失败只记日志：释放是一条尽力而为的清理路径，它不该把桌面主进程的
   * fail-loud 处理器（未处理拒绝 = 致命）牵进来。
   */
  subscribeSessionChanges(ctx, () => {
    void releaseAll('session-changed').catch((cause: unknown) => {
      warn(`dsh-plugin-desktop: releasing the application AI sessions failed (${cause instanceof Error ? cause.message : String(cause)})`)
    })
  })

  return {
    async run({ sessionId, messages, onDelta, signal }): Promise<AiChatTurnResult> {
      const startedAt = generation
      return await serialize(sessionId, async () => {
        // 排队期间被释放（换账号/登出）⇒ 起跑即拒：这一轮属于**上一个**账号的请求，
        // 放它跑就是"释放之后又把那个账号的会话拉起来"。
        if (startedAt !== generation) throw aborted()
        return await runTurn(sessionId, messages, onDelta, signal, startedAt)
      })
    },
    cancel(sessionId: string): void {
      agentOf(sessionId)?.cancel({ kind: 'user' })
      // 取消后立刻丢弃：下一次调用重新建立会话（活体只服务"正在跑的那一轮"）。
      void dropAgent(sessionId)
    },
    releaseAll,
    liveSessions: (): number => live.size,
    queuedSessions: (): number => queues.size,
    generation: (): number => generation,
  }
}

/**
 * 把应用 AI 执行面装进宿主 ctx —— §21.2 步骤③ 的**生产接线**。
 *
 * 为什么要单独一个函数：这段接线原先内联在 `main.ts` 的 boot 回调里，而 `main.ts`
 * 是 Electron 引导、单测跑不到 ⇒ **删掉 `provide` 全部用例照样绿，而生产环境每次
 * 应用 AI 调用都静默回 503 `app_ai_unavailable`**（2026-09-20 独立复核指出
 * "宿主接线无判据"）。抽成函数后由 `tests/app-ai-runner.spec.ts` 用**真实 Cordis
 * `Context`** 断言 `ctx.get(WASM_APPS_AI_RUNNER_SERVICE)` 确实拿得到 runner——
 * 这就是"接线存在"的行为判据，而不是钉字符串。
 */
export function provideAppAiRunner(ctx: Context, options: AppAiRunnerOptions): AppAiRunnerHandle {
  const runner = createAppAiRunner(ctx, options)
  ctx.provide(WASM_APPS_AI_RUNNER_SERVICE, runner)
  return runner
}
