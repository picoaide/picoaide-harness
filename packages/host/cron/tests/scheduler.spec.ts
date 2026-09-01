import { describe, expect, it, vi } from 'vitest'
import { nextRunAtMs } from '../src/cron.ts'
import { HostCronScheduler } from '../src/host-scheduler.ts'
import type { ExecutionRecord, JobRecord } from '../src/jobs.ts'

/** Structural fake of the ledger: only what the scheduler touches. */
function fakeLedger(initial: JobRecord[] = []) {
  const jobs: JobRecord[] = JSON.parse(JSON.stringify(initial)) as JobRecord[]
  const opened: Array<{ job: JobRecord; execution: ExecutionRecord }> = []
  let lastTick: number | undefined
  return {
    jobs,
    opened,
    state: () => ({ revision: 1, jobs, scheduler: { timeZone: 'UTC' } }),
    setScheduler: vi.fn((patch: { lastTickAt?: number }) => { lastTick = patch.lastTickAt }),
    lastTick,
    openScheduled: vi.fn((jobId: string, executionId: string, now: number) => {
      const job = jobs.find(candidate => candidate.id === jobId)
      if (job === undefined || !job.enabled) return undefined
      if (job.executions.some(execution => execution.endedAt === undefined)) return undefined
      const execution: ExecutionRecord = { id: executionId, triggeredAt: now }
      job.executions.push(execution)
      job.nextRunAt = nextRunAtMs(job.cron, now)
      opened.push({ job: JSON.parse(JSON.stringify(job)) as JobRecord, execution })
      return opened[opened.length - 1]!
    }),
    skipMissed: vi.fn((now: number) => {
      for (const job of jobs) {
        if (job.enabled && job.nextRunAt !== undefined && job.nextRunAt <= now) {
          job.nextRunAt = nextRunAtMs(job.cron, now)
        }
      }
    }),
    skipMissedFor: vi.fn((jobId: string, now: number) => {
      const job = jobs.find(candidate => candidate.id === jobId)
      if (job !== undefined && job.nextRunAt !== undefined && job.nextRunAt <= now) {
        job.nextRunAt = nextRunAtMs(job.cron, now)
      }
    }),
    settle: vi.fn(),
  }
}

/** Executor stub: resolves immediately as succeeded. */
function fakeExecutor() {
  return {
    execute: vi.fn(async () => ({ result: 'succeeded' as const })),
  }
}

function job(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: 'job-1',
    name: 'Daily',
    cron: '0 9 * * *',
    action: { kind: 'agent', prompt: 'do the daily thing' },
    enabled: true,
    nextRunAt: new Date(2026, 7, 19, 9, 0, 0).getTime(),
    executions: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

describe('HostCronScheduler', () => {
  it('fires due jobs exactly once and rolls their nextRunAt', async () => {
    const ledger = fakeLedger([job()])
    const executor = fakeExecutor()
    const now = new Date(2026, 7, 19, 9, 1, 0).getTime() // past 09:00
    const scheduler = new HostCronScheduler(ledger as never, executor as never, { now: () => now })
    await scheduler['tick'](false)
    expect(ledger.opened).toHaveLength(1)
    expect(executor.execute).toHaveBeenCalledTimes(1)
    expect(ledger.settle).toHaveBeenCalledWith('job-1', ledger.opened[0]!.execution.id, 'succeeded', undefined)
    scheduler.dispose()
  })

  it('skips jobs whose nextRunAt is in the future', async () => {
    const ledger = fakeLedger([job()])
    const now = new Date(2026, 7, 19, 8, 0, 0).getTime() // before 09:00
    const scheduler = new HostCronScheduler(ledger as never, fakeExecutor() as never, { now: () => now })
    await scheduler['tick'](false)
    expect(ledger.opened).toHaveLength(0)
    scheduler.dispose()
  })

  it('does not re-fire while a job has an open execution', async () => {
    const running = job({ executions: [{ id: 'e1', triggeredAt: 1 }] })
    const ledger = fakeLedger([running])
    const now = new Date(2026, 7, 19, 9, 1, 0).getTime()
    const scheduler = new HostCronScheduler(ledger as never, fakeExecutor() as never, { now: () => now })
    await scheduler['tick'](false)
    expect(ledger.opened).toHaveLength(0)
    scheduler.dispose()
  })

  it('skips missed triggers on recovery (first tick)', async () => {
    const ledger = fakeLedger([job()])
    const now = new Date(2026, 7, 20, 10, 0, 0).getTime() // a day later
    const scheduler = new HostCronScheduler(ledger as never, fakeExecutor() as never, { now: () => now })
    await scheduler['tick'](true)
    expect(ledger.opened).toHaveLength(0)
    expect(ledger.skipMissed).toHaveBeenCalledWith(now)
    scheduler.dispose()
  })

  it('catches up the most recent missed occurrence when enabled', async () => {
    const ledger = fakeLedger([job()])
    const now = new Date(2026, 7, 20, 10, 0, 0).getTime()
    const scheduler = new HostCronScheduler(ledger as never, fakeExecutor() as never, {
      now: () => now,
      catchUpMissed: true,
    })
    await scheduler['tick'](true)
    expect(ledger.opened).toHaveLength(1)
    // Triggered at the last matching instant (yesterday 09:00), not "now".
    expect(ledger.opened[0]!.execution.triggeredAt).toBe(new Date(2026, 7, 20, 9, 0, 0).getTime())
    scheduler.dispose()
  })
})

describe('HostCronScheduler idle settlement (审计 2026-09)', () => {
  it('keeps a session-launched execution pending and settles on agent idle', async () => {
    const ledger = fakeLedger([job()])
    ledger.attachSession = vi.fn()
    ledger.attachPrompt = vi.fn()
    const executor = {
      execute: vi.fn(async () => ({
        result: 'succeeded' as const,
        sessionId: 'sess-abc',
        prompt: 'do task',
      })),
    }
    const now = new Date(2026, 7, 19, 9, 1, 0).getTime()
    const scheduler = new HostCronScheduler(ledger as never, executor as never, { now: () => now })
    await scheduler['tick'](false)
    // 会话已启动: 不得立即 settle succeeded(旧行为是「入队即完成」)。
    expect(ledger.settle).not.toHaveBeenCalled()
    expect(ledger.attachSession).toHaveBeenCalledWith('job-1', expect.any(String), 'sess-abc')
    // agent/status idle 到来 → 真实结算 succeeded。
    scheduler.onAgentStatus('sess-abc', 'idle')
    expect(ledger.settle).toHaveBeenCalledWith('job-1', ledger.opened[0]!.execution.id, 'succeeded')
    // 重复 idle / 其它 session 的 idle 不再影响。
    scheduler.onAgentStatus('sess-abc', 'idle')
    scheduler.onAgentStatus('sess-other', 'idle')
    expect(ledger.settle).toHaveBeenCalledTimes(1)
    scheduler.dispose()
  })

  it('still settles failed immediately when session launch fails', async () => {
    const ledger = fakeLedger([job()])
    ledger.attachSession = vi.fn()
    ledger.attachPrompt = vi.fn()
    const executor = {
      execute: vi.fn(async () => ({ result: 'failed' as const, error: 'launch failed' })),
    }
    const now = new Date(2026, 7, 19, 9, 1, 0).getTime()
    const scheduler = new HostCronScheduler(ledger as never, executor as never, { now: () => now })
    await scheduler['tick'](false)
    expect(ledger.settle).toHaveBeenCalledWith('job-1', ledger.opened[0]!.execution.id, 'failed', 'launch failed')
    scheduler.dispose()
  })
})
