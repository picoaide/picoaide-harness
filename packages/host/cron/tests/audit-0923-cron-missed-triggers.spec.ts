/**
 * Regression for the R4-B audit (2026-09-23), finding **R4-B-9**.
 *
 * The DST-gap fix (R3-B3 F2 / B-5) made ONE way of losing an occurrence
 * observable: a local wall clock that does not exist is recorded in the
 * scheduler state (`skippedOccurrences`), persisted with the ledger, surfaced in
 * the panel and logged. The other way — the app was closed (or the job was not
 * visible) when the trigger came due — rolled forward with no execution row, no
 * record and no log line, so neither the user nor an operator could tell
 * "the app was off" from "the scheduler is broken".
 *
 * The fix keeps the policy (missed triggers are rolled forward, never replayed)
 * and adds the trace: a `reason: 'missed'` record, a greppable Host log line,
 * and a panel notice of its own.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HostCronLedger } from '../src/host-ledger.ts'
import { HostCronScheduler } from '../src/host-scheduler.ts'
import type { CronAction } from '../src/protocol.ts'
import { DST_NOTICE_WINDOW_MS, latestDstSkip, latestMissedTrigger } from '../src/client/dst-notice.ts'

/** Fixed clock: the fixtures must not depend on the wall clock. */
const T0 = new Date(2026, 8, 23, 9, 0, 0).getTime()
const DAY = 24 * 60 * 60 * 1000

let home: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'r4b9-cron-')) })
afterEach(() => { vi.restoreAllMocks(); rmSync(home, { recursive: true, force: true }) })

function createAction(id: string): CronAction {
  return {
    kind: 'create',
    id,
    input: { name: id, cron: '0 9 * * *', action: { kind: 'agent', prompt: `prompt-of-${id}` }, enabled: true },
  }
}

/** The probe's local wall clock, formatted independently of the module. */
function wallClockAt(ms: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(ms))
  const field = (type: string): string => parts.find(part => part.type === type)?.value ?? ''
  return `${field('year')}-${field('month')}-${field('day')} ${field('hour')}:${field('minute')}`
}

describe('R4-B-9: an occurrence missed while the app was off leaves a trace', () => {
  it('records the skipped due instant in the ledger, logs it, and does NOT replay it', () => {
    const warnings: string[] = []
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warnings.push(args.map(String).join(' ')) })

    const host = new HostCronLedger({ dshHomeDir: home, now: () => T0 })
    host.applyRequest('r1', createAction('job-1'))
    const seeded = host.state().jobs[0]!.nextRunAt!
    // The app was closed for three days: the trigger came due while nothing ran.
    const now = T0 + 3 * DAY
    host.skipMissed(now)

    const job = host.state().jobs[0]!
    const skips = host.state().scheduler.skippedOccurrences ?? []
    expect(skips).toHaveLength(1)
    const record = skips[0]!
    expect(record.reason).toBe('missed')
    expect(record.jobId).toBe('job-1')
    expect(record.name).toBe('job-1')
    // The record points at the instant that was missed, not at the new one.
    expect(record.normalizedTo).toBe(seeded)
    expect(record.wallClock).toBe(wallClockAt(seeded, record.timeZone))
    expect(record.detectedAt).toBe(T0)
    // Policy unchanged: nothing ran, and the job is scheduled in the future.
    expect(job.executions).toHaveLength(0)
    expect(job.nextRunAt!).toBeGreaterThan(now)
    // The operator's side of the contract: one greppable line naming job + time.
    expect(warnings.join('\n')).toContain('[dsh-cron] missed trigger')
    expect(warnings.join('\n')).toContain(record.wallClock)
    host.dispose()
  })

  it('persists the record across a restart and keeps the list bounded', () => {
    const host = new HostCronLedger({ dshHomeDir: home, now: () => T0 })
    host.applyRequest('r1', createAction('job-1'))
    const due = host.state().jobs[0]!.nextRunAt!
    host.skipMissed(T0 + 3 * DAY)
    host.dispose()

    const restarted = new HostCronLedger({ dshHomeDir: home, now: () => T0 + 4 * DAY })
    const persisted = restarted.state().scheduler.skippedOccurrences ?? []
    expect(persisted).toHaveLength(1)
    expect(persisted[0]!.reason).toBe('missed')
    expect(persisted[0]!.normalizedTo).toBe(due)

    // Ten more boot cycles over the same ledger: the list stays bounded (the
    // newest records win) instead of growing with every roll.
    let previous = persisted.length
    for (let day = 5; day < 15; day += 1) {
      restarted.skipMissed(T0 + day * DAY)
      const count = (restarted.state().scheduler.skippedOccurrences ?? []).length
      expect(count).toBeLessThanOrEqual(8)
      expect(count).toBeGreaterThanOrEqual(previous)
      previous = count
    }
    expect(restarted.state().scheduler.skippedOccurrences!.length).toBe(8)
    restarted.dispose()
  })

  it('control: the DST-gap reason is still recorded separately', async () => {
    // A fresh process pins TZ (V8 caches the zone): reuse the suite's own child
    // probe, which drives the real ledger across the 2026-03-08 spring-forward.
    const probe = fileURLToPath(new URL('./helpers/dst-gap-probe.mjs', import.meta.url))
    const child = spawn(process.execPath, [probe, mkdtempSync(join(tmpdir(), 'r4b9-dst-'))], {
      env: { ...process.env, TZ: 'America/New_York' },
      encoding: 'utf8',
    } as never)
    const stdout: string[] = []
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk.toString()))
    const code = await new Promise<number | null>(resolve => child.on('close', resolve))
    expect(code).toBe(0)
    const report = JSON.parse(stdout.join('').trim().split('\n').filter(Boolean).at(-1) ?? '{}') as {
      gapDay?: { persistedSkips?: Array<{ reason?: string }> }
    }
    const persisted = report.gapDay?.persistedSkips ?? []
    expect(persisted).toHaveLength(1)
    expect(persisted[0]!.reason).toBe('dst-gap')
  }, 30_000)

  it('announces a missed trigger on the panel path, and not as a DST jump', () => {
    const now = T0
    const missed = {
      jobId: 'job-1', name: 'Nightly', reason: 'missed' as const,
      wallClock: '2026-09-22 09:00', timeZone: 'UTC', normalizedTo: now - DAY, detectedAt: now - 1_000,
    }
    const gap = {
      jobId: 'job-1', name: 'Nightly', reason: 'dst-gap' as const,
      wallClock: '2026-03-08 02:30', timeZone: 'America/New_York', normalizedTo: now - DAY, detectedAt: now - 2_000,
    }
    // The two stories must not be swapped: each accessor sees its own reason.
    expect(latestMissedTrigger({ skippedOccurrences: [missed] }, now)).toEqual(missed)
    expect(latestDstSkip({ skippedOccurrences: [missed] }, now)).toBeUndefined()
    expect(latestDstSkip({ skippedOccurrences: [gap, missed] }, now)).toEqual(gap)
    expect(latestMissedTrigger({ skippedOccurrences: [gap, missed] }, now)).toEqual(missed)
    // Same freshness window as the DST notice.
    expect(latestMissedTrigger({ skippedOccurrences: [gap, { ...missed, detectedAt: now - DST_NOTICE_WINDOW_MS - 1 }] }, now))
      .toBeUndefined()
    expect(latestMissedTrigger({ skippedOccurrences: [] }, now)).toBeUndefined()
  })
})

describe('R4-B-9: the scheduler paths agree about what was skipped', () => {
  it('a recovery tick with the default policy records the missed trigger', async () => {
    let clock = T0
    const ledger = new HostCronLedger({ dshHomeDir: home, now: () => clock })
    ledger.applyRequest('r1', createAction('job-1'))
    const due = ledger.state().jobs[0]!.nextRunAt!
    const executor = { execute: vi.fn(async () => ({ result: 'succeeded' as const })) }
    const scheduler = new HostCronScheduler(ledger, executor as never, { now: () => clock, tickMs: 30_000 })
    // Three days later, with the app freshly started (the recovered tick).
    clock = T0 + 3 * DAY
    scheduler.start()
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline && (ledger.state().scheduler.skippedOccurrences ?? []).length === 0) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    scheduler.dispose()

    const skips = ledger.state().scheduler.skippedOccurrences ?? []
    expect(skips.map(entry => entry.reason)).toEqual(['missed'])
    expect(skips[0]!.normalizedTo).toBe(due)
    expect(executor.execute, 'the missed occurrence must not be replayed').not.toHaveBeenCalled()
    ledger.dispose()
  })

  it('a caught-up occurrence is reported by its execution row, not as a missed trigger', async () => {
    let clock = T0
    const ledger = new HostCronLedger({ dshHomeDir: home, now: () => clock })
    ledger.applyRequest('r1', createAction('job-1'))
    const executor = { execute: vi.fn(async () => ({ result: 'succeeded' as const, sessionId: 'sess-1', prompt: 'p' })) }
    const scheduler = new HostCronScheduler(ledger, executor as never, {
      now: () => clock, tickMs: 30_000, catchUpMissed: true,
    })
    clock = T0 + 3 * DAY
    scheduler.start()
    const deadline = Date.now() + 8_000
    while (Date.now() < deadline && executor.execute.mock.calls.length === 0) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    scheduler.dispose()

    expect(executor.execute, 'the catch-up policy really fired the occurrence').toHaveBeenCalledTimes(1)
    expect(ledger.state().jobs[0]!.executions).toHaveLength(1)
    expect((ledger.state().scheduler.skippedOccurrences ?? []).filter(entry => entry.reason === 'missed'))
      .toEqual([])
    ledger.dispose()
  })
})
