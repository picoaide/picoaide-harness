import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, statSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HostCronLedger } from '../src/host-ledger.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-cron-ledger-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function ledger(options: { dshHomeDir?: string } = {}): HostCronLedger {
  return new HostCronLedger({ dshHomeDir: options.dshHomeDir ?? dir })
}

const CREATE = {
  kind: 'create' as const,
  id: 'job-1',
  input: {
    name: 'Daily',
    cron: '0 9 * * *',
    action: { kind: 'agent' as const, prompt: 'do the daily thing', workspaceId: 'ws-1', agentPreset: 'default' },
    enabled: true,
  },
}

describe('HostCronLedger', () => {
  it('persists a document with 0600 permissions', () => {
    const host = ledger()
    host.applyRequest('r1', CREATE)
    host.dispose()

    const path = join(dir, 'cron', 'ledger.json')
    expect(existsSync(path)).toBe(true)
    const mode = statSync(path).mode & 0o777
    expect(mode).toBe(0o600)
    const document = JSON.parse(readFileSync(path, 'utf8'))
    expect(document.schemaVersion).toBe(2)
    expect(document.revision).toBe(1)
    expect(document.jobs).toHaveLength(1)
    expect(document.jobs[0]!.name).toBe('Daily')
  })

  it('loads a persisted document and bumps revision monotonically', () => {
    const first = ledger()
    first.applyRequest('r1', CREATE)
    first.dispose()

    const second = ledger()
    const state = second.state()
    expect(state.revision).toBe(1)
    expect(state.jobs[0]!.enabled).toBe(true)
    second.applyRequest('r2', { kind: 'disable', jobId: 'job-1' })
    expect(second.state().revision).toBe(2)
    expect(second.state().jobs[0]!.enabled).toBe(false)
    second.dispose()
  })

  it('is idempotent per requestId across instances (restart retry)', () => {
    const first = ledger()
    first.applyRequest('r1', CREATE)
    first.dispose()

    // A retried request after restart must not create a duplicate job.
    const second = ledger()
    second.applyRequest('r1', CREATE)
    expect(second.state().jobs).toHaveLength(1)
    second.dispose()
  })

  it('isolates corrupt documents and starts empty with a visible error', () => {
    const path = join(dir, 'cron', 'ledger.json')
    mkdirSync(join(dir, 'cron'), { recursive: true })
    writeFileSync(path, '{ not json', 'utf8')

    const host = ledger()
    const state = host.state()
    expect(state.jobs).toHaveLength(0)
    expect(state.scheduler.error).toMatch(/corrupt/)
    expect(existsSync(path)).toBe(false) // renamed away
    host.dispose()
  })

  it('seeds nextRunAt when a job is enabled', () => {
    const host = ledger()
    host.applyRequest('r1', { ...CREATE, input: { ...CREATE.input, enabled: false } })
    expect(host.state().jobs[0]!.nextRunAt).toBeUndefined()
    host.applyRequest('r2', { kind: 'enable', jobId: 'job-1' })
    expect(host.state().jobs[0]!.nextRunAt).toBeDefined()
    host.dispose()
  })

  it('openScheduled skips disabled or already-running jobs', () => {
    const host = ledger()
    host.applyRequest('r1', { ...CREATE, input: { ...CREATE.input, enabled: false } })
    expect(host.openScheduled('job-1', 'sched-1', Date.now())).toBeUndefined()
    host.applyRequest('r2', { kind: 'enable', jobId: 'job-1' })

    const opened = host.openScheduled('job-1', 'sched-2', Date.now())
    expect(opened).toBeDefined()
    // Second open while running: refused, nextRunAt already rolled.
    expect(host.openScheduled('job-1', 'sched-3', Date.now())).toBeUndefined()
    host.dispose()
  })

  it('settle writes the result into the execution record', () => {
    const host = ledger()
    host.applyRequest('r1', { ...CREATE, input: { ...CREATE.input, enabled: true } })
    const opened = host.openScheduled('job-1', 'sched-1', 1000)!
    host.settle('job-1', opened.execution.id, 'failed', 'boom')
    const execution = host.state().jobs[0]!.executions[0]!
    expect(execution.endedAt).toBeDefined()
    expect(execution.result).toBe('failed')
    expect(execution.error).toBe('boom')
    host.dispose()
  })

  it('skipMissed rolls nextRunAt forward without executing', () => {
    const host = ledger()
    host.applyRequest('r1', { ...CREATE, input: { ...CREATE.input, enabled: true } })
    const job = host.state().jobs[0]!
    const before = job.nextRunAt!
    // Simulate a long downtime past the trigger.
    host.skipMissed(before + 60_000)
    const after = host.state().jobs[0]!.nextRunAt!
    expect(after).toBeGreaterThan(before + 60_000)
    expect(host.state().jobs[0]!.executions).toHaveLength(0)
    host.dispose()
  })

  it('refuses concurrent ownership via the lock file', () => {
    const first = ledger()
    expect(() => ledger()).toThrow(/another Host process/)
    first.dispose()
    // After dispose the lock is released.
    const second = ledger()
    expect(second.state().revision).toBe(0)
    second.dispose()
  })
})

describe('HostCronLedger recovery', () => {
  it('settles pending executions as cancelled and rolls nextRunAt after a crash', () => {
    const host = ledger()
    host.applyRequest('r1', { ...CREATE, input: { ...CREATE.input, enabled: true } })
    // Open a scheduled run but never settle it (simulates a Host crash
    // between open and settle).
    const opened = host.openScheduled('job-1', 'sched-crash', Date.now())!
    expect(opened.execution.endedAt).toBeUndefined()
    host.dispose()

    // A fresh ledger (restart) must reconcile the dangling execution.
    const restarted = ledger()
    const job = restarted.state().jobs[0]!
    expect(job.executions[0]!.endedAt).toBeDefined()
    expect(job.executions[0]!.result).toBe('cancelled')
    expect(job.executions[0]!.error).toMatch(/host restarted/)
    // nextRunAt rolled forward, so the job can trigger again.
    expect(job.nextRunAt).toBeDefined()
    expect(job.nextRunAt!).toBeGreaterThan(opened.execution.triggeredAt)
    restarted.dispose()
  })

  it('does not pin a job forever after a crash: a fresh run opens', () => {
    const host = ledger()
    host.applyRequest('r1', { ...CREATE, input: { ...CREATE.input, enabled: true } })
    host.openScheduled('job-1', 'sched-crash', Date.now())
    host.dispose()

    const restarted = ledger()
    const opened = restarted.openScheduled('job-1', 'sched-2', Date.now())
    expect(opened).toBeDefined()
    restarted.dispose()
  })
})

describe('HostCronLedger idempotency', () => {
  it('rejects a reused requestId with a different payload', () => {
    const host = ledger()
    host.applyRequest('r1', CREATE)
    expect(() => host.applyRequest('r1', { ...CREATE, id: 'job-2' })).toThrow(/reused with a different action/)
    host.dispose()
  })

  it('restores the idempotency cache across a restart (same requestId retried)', () => {
    const host = ledger()
    host.applyRequest('r1', CREATE)
    host.dispose()

    // A client retry after restart: same requestId, same payload → no-op.
    const restarted = ledger()
    restarted.applyRequest('r1', CREATE)
    expect(restarted.state().jobs).toHaveLength(1)
    restarted.dispose()
  })

  it('unregister can run repeatedly across attach/detach cycles', () => {
    const host = ledger()
    host.applyRequest('r1', CREATE)
    // Simulate a sibling-plugin upsert flow: attach → detach → attach → detach.
    host.upsertJob({ id: 'task-t1', name: 't', cron: '0 9 * * *', action: { kind: 'agent', prompt: 'p' }, enabled: true })
    host.applyRequest('u1', { kind: 'delete', jobId: 'task-t1' })
    host.upsertJob({ id: 'task-t1', name: 't', cron: '0 9 * * *', action: { kind: 'agent', prompt: 'p' }, enabled: true })
    host.applyRequest('u2', { kind: 'delete', jobId: 'task-t1' })
    expect(host.state().jobs.some(job => job.id === 'task-t1')).toBe(false)
    host.dispose()
  })
})

describe('HostCronLedger reconcile nextRunAt preservation', () => {
  it('preserves a future nextRunAt across a crash (does not skip the next trigger)', () => {
    const at = new Date(2026, 7, 19, 9, 0, 0).getTime()
    // Ledger with a fixed clock: create seeds nextRunAt from `at`.
    const host = new HostCronLedger({ dshHomeDir: dir, now: () => at })
    host.applyRequest('r1', { ...CREATE, input: { ...CREATE.input, enabled: true } })
    // The job's nextRunAt was seeded at the next 09:00 matching instant.
    const seeded = host.state().jobs[0]!.nextRunAt!
    // Fire the run at that instant: nextRunAt rolls forward past it.
    const opened = host.openScheduled('job-1', 'sched-1', seeded)!
    const rolled = host.state().jobs[0]!.nextRunAt!
    // Daily 09:00 rolls to the NEXT day 09:00 (strictly after the fired run).
    expect(rolled - seeded).toBe(24 * 60 * 60 * 1000)
    host.dispose()

    // Restart shortly after with a per-minute schedule preserved by roll.
    const restarted = new HostCronLedger({ dshHomeDir: dir, now: () => seeded + 5 * 60 * 1000 })
    const job = restarted.state().jobs[0]!
    expect(job.executions[0]!.result).toBe('cancelled')
    // The future nextRunAt (still ahead of restart) is preserved verbatim.
    expect(job.nextRunAt).toBe(rolled)
    restarted.dispose()
  })
})

describe('HostCronLedger schema v1→v2 migration', () => {
  it('drops v1 task/prompt jobs and keeps agent jobs', () => {
    const path = join(dir, 'cron', 'ledger.json')
    mkdirSync(join(dir, 'cron'), { recursive: true })
    const document = {
      schemaVersion: 1,
      revision: 5,
      jobs: [
        { id: 'legacy-task', name: 'Old task', cron: '0 9 * * *', action: { kind: 'task', taskId: 't1' }, enabled: true, executions: [], createdAt: 1, updatedAt: 1 },
        { id: 'legacy-prompt', name: 'Old ping', cron: '* * * * *', action: { kind: 'prompt', sessionId: 's1', text: 'hi' }, enabled: true, executions: [{ id: 'e1', triggeredAt: 1, result: 'succeeded', endedAt: 2 }], createdAt: 1, updatedAt: 1 },
        { id: 'agent-keep', name: 'Agent job', cron: '0 9 * * *', action: { kind: 'agent', prompt: 'go' }, enabled: true, executions: [], createdAt: 1, updatedAt: 1 },
      ],
      scheduler: { timeZone: 'UTC' },
      recentRequests: [],
    }
    writeFileSync(path, JSON.stringify(document), 'utf8')

    const host = ledger()
    const state = host.state()
    expect(state.revision).toBe(5)
    expect(state.jobs.map(job => job.id)).toEqual(['agent-keep'])
    host.dispose()
  })
})

describe('HostCronLedger lock recovery', () => {
  it('reclaims an empty lock file once it is older than the stale threshold', () => {
    const path = join(dir, 'cron', 'ledger.lock')
    mkdirSync(join(dir, 'cron'), { recursive: true })
    writeFileSync(path, '', 'utf8') // empty lock: crashed before writing pid
    // Backdate the mtime beyond the stale age.
    const old = new Date(Date.now() - 60_000)
    const { utimesSync } = require('node:fs') as typeof import('node:fs')
    utimesSync(path, old, old)

    // Should not throw: the stale empty lock is reclaimed.
    const host = ledger()
    expect(host.state().revision).toBe(0)
    host.dispose()
  })
})

describe('HttpBrowserCronService upsert semantics', () => {
  it('routes registerJob to update when the job already exists', () => {
    // Structural check: the browser service must not send `create` for an
    // existing id (Host create is a no-op, so toggles would silently fail).
    const source = readFileSync(new URL('../src/client/browser-service.ts', import.meta.url), 'utf8')
    expect(source).toContain("kind: 'update'")
    expect(source).toContain('existing !== undefined')
  })
})

describe('cron client execution detail', () => {
  it('renders an open-session jump for execution session ids', () => {
    const source = readFileSync(new URL('../src/client/CronJobTab.tsx', import.meta.url), 'utf8')
    expect(source).toContain("openSession(execution.sessionId!)")
    expect(source).toContain("'job.execution.openSession'")
  })

  it('wires the sessions service into the panel for the jump', () => {
    const source = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')
    expect(source).toContain("ctx.get('sessions')")
    expect(source).toContain('openSession')
  })
})
