/** Desktop loop-notify Host plugin tests. */

import { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import type { DesktopNotification, DesktopRuntime } from '../src/runtime.ts'
import { apply, Config, type Config as LoopNotifyConfig } from '../src/loop-notify.ts'

const config: LoopNotifyConfig = {
  enabled: true,
  notifyWhenFocused: false,
  cooldownMs: 10,
}

interface FakeAgent {
  id: SessionId
  session: { header: { id: SessionId; delegationDepth?: number; origin?: 'subagent' } }
}

function agent(id: string, delegationDepth?: number, origin?: 'subagent'): FakeAgent {
  return {
    id: id as SessionId,
    session: { header: { id: id as SessionId, ...(delegationDepth === undefined ? {} : { delegationDepth }), ...(origin === undefined ? {} : { origin }) } },
  }
}

async function createHarness(options: {
  focused?: boolean
  config?: Partial<LoopNotifyConfig>
} = {}) {
  const notifications: DesktopNotification[] = []
  const ctx = new Context()
  const runtime = {
    locale: 'en',
    updates: {
      notify: (notification: DesktopNotification) => { notifications.push(notification) },
    },
    isFocused: () => options.focused ?? false,
  } as unknown as DesktopRuntime
  ctx.provide('desktopRuntime', runtime)
  ctx.provide('sessionTitle', {
    get: () => ({ title: 'Test Session' }),
  })
  // Load through a real plugin fiber so `ctx.on` registrations attach to the
  // fiber effect chain and actually fire (bare `ctx.on` outside a fiber is a
  // no-op dispatch target).
  const fiber = ctx.plugin(apply, { ...config, ...options.config })
  await fiber
  return { ctx, notifications }
}

/** Notify a loop completion through the plugin's listener registration. */
function emitIdle(ctx: Context, id: string, delegationDepth?: number, origin?: 'subagent'): void {
  ctx.emit('agent/status', { agent: agent(id, delegationDepth, origin), status: 'idle' } as never)
}

/** Dispatch a `tools/execute` waterfall with a real next callback. */
async function dispatchTool(ctx: Context, name: string, args: unknown, execAgent: FakeAgent | undefined): Promise<void> {
  const exec = {
    name,
    arguments: args,
    agent: execAgent,
    signal: new AbortController().signal,
  }
  const call = [exec, () => ({ content: [] })] as unknown as Parameters<typeof ctx.waterfall>[0] extends never ? never : unknown[]
  void call
  const result = await (ctx as unknown as { waterfall(name: string, ...args: unknown[]): Promise<unknown> }).waterfall('tools/execute', exec, () => ({ content: [] }))
  expect(result).toEqual({ content: [] })
}

/** Dispatch `approval/request` with a real next callback. */
function dispatchApproval(ctx: Context, payload: unknown): Promise<unknown> {
  return (ctx as unknown as { waterfall(name: string, ...args: unknown[]): Promise<unknown> }).waterfall('approval/request', payload, () => 'allowed-once')
}

describe('desktop loop notification Host plugin', () => {
  it('notifies once on abstract loop completion (sub-agents filtered)', async () => {
    const { ctx, notifications } = await createHarness()
    emitIdle(ctx, 'root-1')
    emitIdle(ctx, 'sub-1', 1, 'subagent')
    await vi.waitFor(() => { expect(notifications.length).toBe(1) })
    expect(notifications[0]).toMatchObject({
      title: 'Task finished',
      sessionId: 'root-1',
    })
  })

  it('debounces concurrent loop completions into one multi-task notification', async () => {
    const { ctx, notifications } = await createHarness()
    emitIdle(ctx, 'a')
    emitIdle(ctx, 'b')
    await vi.waitFor(() => { expect(notifications.length).toBe(1) })
    expect(notifications[0]?.title).toBe('2 tasks finished')
  })

  it('notifies on ask_user_question and passes the question as body', async () => {
    const { ctx, notifications } = await createHarness()
    await dispatchTool(ctx, 'ask_user_question', {
      questions: [{ id: 'q1', question: 'Which API should I use?' }],
    }, agent('root-2'))
    await vi.waitFor(() => { expect(notifications.length).toBe(1) })
    expect(notifications[0]).toMatchObject({
      title: 'Your input is needed',
      body: 'Which API should I use?',
      sessionId: 'root-2',
    })
  })

  it('notifies on exit_plan_mode plan review', async () => {
    const { ctx, notifications } = await createHarness()
    await dispatchTool(ctx, 'exit_plan_mode', {
      plan: '# Plan',
      questions: [],
    }, agent('root-3'))
    await vi.waitFor(() => { expect(notifications.length).toBe(1) })
    expect(notifications[0]?.title).toBe('Your input is needed')
  })

  it('notifies on approval/request and keeps the waterfall chain intact', async () => {
    const { ctx, notifications } = await createHarness()
    const outcome = await dispatchApproval(ctx, {
      agent: agent('root-4'),
      toolName: 'bash',
      reason: 'Run rm -rf',
    })
    expect(outcome).toBe('allowed-once')
    await vi.waitFor(() => { expect(notifications.length).toBe(1) })
    expect(notifications[0]).toMatchObject({
      title: 'Approval needed',
      body: 'Tool bash requests approval: Run rm -rf',
      sessionId: 'root-4',
    })
  })

  it('suppresses all notifications when the window is focused (notifyWhenFocused false)', async () => {
    const { ctx, notifications } = await createHarness({ focused: true })
    emitIdle(ctx, 'root-5')
    await dispatchTool(ctx, 'ask_user_question', {
      questions: [{ id: 'q2', question: 'Proceed?' }],
    }, agent('root-5'))
    await dispatchApproval(ctx, {
      agent: agent('root-5'),
      toolName: 'bash',
    })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(notifications).toEqual([])
  })

  it('honors notifyWhenFocused true and a disabled config', async () => {
    const enabled = await createHarness({ config: { notifyWhenFocused: true } })
    emitIdle(enabled.ctx, 'root-6')
    await vi.waitFor(() => { expect(enabled.notifications.length).toBe(1) })
    expect(enabled.notifications[0]?.title).toBe('Task finished')

    const disabled = await createHarness({ config: { enabled: false } })
    emitIdle(disabled.ctx, 'root-7')
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(disabled.notifications).toEqual([])
  })

  it('validates the config schema', () => {
    expect(Config({} as LoopNotifyConfig)).toEqual({
      enabled: true,
      notifyWhenFocused: false,
      cooldownMs: 3000,
    })
    expect(() => Config({ enabled: 'x' } as unknown as LoopNotifyConfig)).toThrow()
  })

  it('stays inert without desktopRuntime and logs a launcher reminder', () => {
    const ctx = new Context()
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    apply(ctx, config)
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('inactive without the desktop launcher'))
    stderr.mockRestore()
  })
})
