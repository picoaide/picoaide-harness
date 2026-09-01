/**
 * Desktop Host plugin: native system notifications for agent-loop lifecycle
 * and human-interaction moments. Three signals:
 *  - loop completion (`agent/status` → `idle`, sub-agent sessions filtered,
 *    concurrent completions debounced into one notification);
 *  - model questions (`ask_user_question` / `exit_plan_mode` tool calls);
 *  - permission approvals (`approval/request`).
 * Notifications carry the owning session id so a native click can focus the
 * window and open that session. All runtime capability reads are defensive:
 * headless launcher smokes provide a stub `desktopRuntime` without the
 * update adapter, and the plugin must never break a loop over a notification.
 * @module dsh-plugin-desktop/loop-notify
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-loop'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'
import type { ToolDispatchExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import type { ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type { Session } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
import type { DesktopNotification, DesktopRuntime } from './runtime.ts'

/** Stable Cordis plugin name. */
export const name = 'desktop-loop-notify'

const MAX_TIMER_DELAY_MS = 2_147_483_647
const MAX_NOTIFY_TEXT = 120
const MAX_LISTED_TITLES = 3

/** Native notification policy. */
export interface Config {
  /** Master switch for all loop notifications. */
  enabled: boolean
  /**
   * When false (default), notifications are suppressed while the native
   * window has keyboard focus — the user is already looking at the loop.
   */
  notifyWhenFocused: boolean
  /**
   * Merge window for concurrent loop completions (parallel sessions finishing
   * together collapse into one notification carrying the first titles).
   */
  cooldownMs: number
}

/** Validated notification policy. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  notifyWhenFocused: z.boolean().default(false),
  cooldownMs: z.number().step(1).min(0).max(MAX_TIMER_DELAY_MS).default(3_000),
})

/** Bilingual notification copy (locale follows the desktop shell preference). */
interface LoopNotifyCopy {
  readonly doneTitle: string
  readonly doneBody: (title: string | undefined) => string
  readonly doneManyTitle: (count: number) => string
  readonly doneManyBody: (titles: readonly string[]) => string
  readonly askTitle: string
  readonly askBody: (question: string) => string
  readonly approveTitle: string
  readonly approveBody: (toolName: string, reason: string | undefined) => string
}

const COPY: Record<'zh' | 'en', LoopNotifyCopy> = {
  zh: {
    doneTitle: '任务完成',
    doneBody: title => title === undefined ? '会话已完成一次完整执行。'
      : `会话「${title}」已完成执行。`,
    doneManyTitle: count => `${count} 个任务完成`,
    doneManyBody: titles => `${titles.join('、')} 的会话已完成执行。`,
    askTitle: '需要你的回答',
    askBody: question => question,
    approveTitle: '需要你的授权',
    approveBody: (toolName, reason) => reason === undefined
      ? `工具 ${toolName} 请求授权。`
      : `工具 ${toolName} 请求授权：${reason}`,
  },
  en: {
    doneTitle: 'Task finished',
    doneBody: title => title === undefined ? 'A session finished a complete run.'
      : `Session "${title}" finished.`,
    doneManyTitle: count => `${count} tasks finished`,
    doneManyBody: titles => `Sessions ${titles.join(', ')} finished.`,
    askTitle: 'Your input is needed',
    askBody: question => question,
    approveTitle: 'Approval needed',
    approveBody: (toolName, reason) => reason === undefined
      ? `Tool ${toolName} requests approval.`
      : `Tool ${toolName} requests approval: ${reason}`,
  },
}

/** Tool names that block on a human answer inside the turn. */
const QUESTION_TOOLS = new Set(['ask_user_question', 'exit_plan_mode'])

/** Sub-agent sessions never notify: their completions surface with the root session. */
function isDelegated(agent: Agent): boolean {
  const header = agent.session.header
  return (header.delegationDepth ?? 0) > 0 || header.origin === 'subagent'
}

function clips(text: string, max = MAX_NOTIFY_TEXT): string {
  const normalized = text.trim().replace(/\s+/g, ' ')
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`
}

/** Extract the first question text from `ask_user_question` arguments. */
function firstQuestionText(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const questions = (args as Record<string, unknown>).questions
  if (!Array.isArray(questions) || questions.length === 0) return undefined
  const first = questions[0]
  if (typeof first !== 'object' || first === null) return undefined
  const text = (first as Record<string, unknown>).question
  return typeof text === 'string' && text.trim() !== '' ? clips(text) : undefined
}

/** Extract the review detail from `exit_plan_mode` arguments (its `plan` field). */
function planReviewText(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const plan = (args as Record<string, unknown>).plan
  return typeof plan === 'string' && plan.trim() !== '' ? clips(plan) : undefined
}

/** Latest folded title of one session, when a session-title service is composed. */
function sessionTitleOf(
  service: { get(session: Session): { readonly title: string } | undefined } | undefined,
  session: Session,
): string | undefined {
  try {
    return service?.get(session)?.title
  } catch {
    return undefined
  }
}

/**
 * Register loop-completion, question, and approval notifications.
 * @param ctx - Host context (desktopRuntime probed, not required).
 * @param config - validated notification policy.
 */
export function apply(ctx: Context, config: Config): void {
  const runtime = ctx.get('desktopRuntime') as DesktopRuntime | undefined
  if (runtime === undefined) {
    process.stderr.write(
      'dsh-plugin-desktop: desktop-loop-notify inactive without the desktop launcher (desktopRuntime).\n',
    )
    return
  }
  // Probe rather than inject: headless smokes and the loader smoke stub often
  // omit the update adapter; the plugin must never take a loop down for a bell.
  const updates = runtime.updates
  const locale = (): 'zh' | 'en' => runtime.locale === 'zh' ? 'zh' : 'en'
  const copy = (): LoopNotifyCopy => COPY[locale()]
  const shouldNotify = (): boolean => {
    if (!config.enabled) return false
    if (config.notifyWhenFocused) return true
    return runtime.isFocused?.() !== true
  }
  const notify = (notification: DesktopNotification): void => {
    try {
      updates?.notify?.(notification)
    } catch {
      // A failed native bell must never break an agent loop.
    }
  }
  const sessionTitle = ctx.get('sessionTitle') as
    | { get(session: Session): { readonly title: string } | undefined }
    | undefined

  ctx.effect(() => {
    const disposers: Array<() => void> = []
    let flushTimer: ReturnType<typeof setTimeout> | undefined
    let pending: Array<{ sessionId: string; title: string | undefined }> = []

    const flushCompletions = (): void => {
      flushTimer = undefined
      if (pending.length === 0) return
      const entries = pending
      pending = []
      const c = copy()
      if (entries.length === 1) {
        const entry = entries[0]!
        notify({
          title: c.doneTitle,
          body: c.doneBody(entry.title),
          sessionId: entry.sessionId,
        })
        return
      }
      const titles = entries
        .map(entry => entry.title)
        .filter((title): title is string => title !== undefined)
        .slice(0, MAX_LISTED_TITLES)
      notify({
        title: c.doneManyTitle(entries.length),
        body: titles.length === 0
          ? c.doneManyBody([])
          : c.doneManyBody(titles),
      })
    }

    const scheduleFlush = (): void => {
      if (flushTimer !== undefined) clearTimeout(flushTimer)
      flushTimer = setTimeout(flushCompletions, config.cooldownMs)
    }

    // --- loop completion ---
    disposers.push(ctx.on('agent/status', ({ agent, status }) => {
      if (status !== 'idle' || !shouldNotify()) return
      if (isDelegated(agent)) return
      pending.push({
        sessionId: String(agent.session.header.id),
        title: sessionTitleOf(sessionTitle, agent.session),
      })
      scheduleFlush()
    }))

    // --- model questions (blocking tool calls) ---
    disposers.push(ctx.on('tools/execute', async (exec: ToolDispatchExecution, next) => {
      try {
        if (QUESTION_TOOLS.has(exec.name) && shouldNotify() && !exec.signal.aborted) {
          const agent = exec.agent
          if (agent !== undefined && !isDelegated(agent)) {
            const text = exec.name === 'exit_plan_mode'
              ? planReviewText(exec.arguments)
              : firstQuestionText(exec.arguments)
            if (text !== undefined) {
              notify({
                title: copy().askTitle,
                body: copy().askBody(text),
                sessionId: String(agent.session.header.id),
              })
            }
          }
        }
      } catch {
        // Observation must never block the tool pipeline.
      }
      return next()
    }))

    // --- permission approvals ---
    disposers.push(ctx.on('approval/request', (req: ApprovalRequest, next) => {
      try {
        if (shouldNotify() && req.signal?.aborted !== true && !isDelegated(req.agent)) {
          notify({
            title: copy().approveTitle,
            body: copy().approveBody(clips(req.toolName, 40), req.reason === undefined ? undefined : clips(req.reason)),
            sessionId: String(req.agent.session.header.id),
          })
        }
      } catch {
        // Observation must never block the answerer chain.
      }
      return next()
    }))

    return () => {
      if (flushTimer !== undefined) clearTimeout(flushTimer)
      flushTimer = undefined
      for (const dispose of disposers) dispose()
    }
  }, 'dsh-plugin-desktop: loop completion, question, and approval notifications')
}

/** Resolve the waterfall return type for the `next` callback signature. */
export type ToolExecuteNext = () => Promise<ToolExecutionResult>
