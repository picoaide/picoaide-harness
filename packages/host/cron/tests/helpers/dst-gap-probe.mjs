/**
 * DST-gap probe child (2026-09-23 R3-B3 F2 / B-5 regression).
 *
 * Runs with `TZ=America/New_York` (the spec spawns it with a fixed `TZ`; V8
 * caches the zone, so a fresh process is the only reliable way to pin it) around
 * the US spring-forward night 2026-03-08, drives the REAL ledger with a fixed
 * clock, and reports what happened as one JSON line. The spec asserts on the
 * report — keeping the facts here and the judgements there.
 *
 * Not a spec file (vitest's include is `tests/**\/*.spec.ts`) and plain JS so
 * nothing type-checks or collects it: `node` type-strips the imported `.ts`
 * sources by itself.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { HostCronLedger } from '../../src/host-ledger.ts'
import { nextRunAtMsWithGaps } from '../../src/cron.ts'

const base = process.argv[2]
mkdirSync(base, { recursive: true })

/** Local wall clock as a Date (the probe's own construction, not the module's). */
const at = (year, month, day, hour, minute) => new Date(year, month - 1, day, hour, minute, 0, 0)

/** `YYYY-MM-DD HH:MM` in the probe's local zone — an independent formatter. */
const stamp = (ms) => {
  const d = new Date(ms)
  const pad = value => String(value).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const logs = []
const originalWarn = console.warn
console.warn = (...args) => { logs.push(args.map(String).join(' ')) }

const create = (id, name, cron) => ({
  kind: 'create',
  id,
  input: { name, cron, action: { kind: 'agent', prompt: 'probe' }, enabled: true },
})

const report = {
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  gapDay: null,
  scan: null,
  fallBack: null,
  logs,
}

try {
  // ---- A. the gap: fire the day before, roll across the missing minute -----
  const homeA = join(base, 'gap')
  const clockA = { value: at(2026, 3, 6, 12, 0).getTime() }
  const ledgerA = new HostCronLedger({ dshHomeDir: homeA, now: () => clockA.value })
  ledgerA.applyRequest('a-create', create('job-a', 'Nightly', '30 2 * * *'))
  const seeded = ledgerA.state().jobs[0].nextRunAt
  clockA.value = at(2026, 3, 7, 2, 30).getTime()
  const opened = ledgerA.openScheduled('job-a', 'a-e1', clockA.value)
  const jobA = ledgerA.state().jobs[0]
  const skipsA = ledgerA.state().scheduler.skippedOccurrences ?? []
  ledgerA.settle('job-a', 'a-e1', 'succeeded')
  ledgerA.dispose()


  // The record must survive a restart (a new generation reads the same home).
  const ledgerA2 = new HostCronLedger({ dshHomeDir: homeA, now: () => at(2026, 3, 8, 12, 0).getTime() })
  const persistedA = ledgerA2.state().scheduler.skippedOccurrences ?? []
  ledgerA2.dispose()

  report.gapDay = {
    seededWallClock: seeded === undefined ? null : stamp(seeded),
    opened: opened !== undefined,
    nextWallClock: jobA.nextRunAt === undefined ? null : stamp(jobA.nextRunAt),
    skips: skipsA,
    // The roll's own clock, formatted by the probe (the spec process runs in
    // another timezone, so it cannot derive this instant itself).
    detectedWallClock: skipsA[0] === undefined ? null : stamp(skipsA[0].detectedAt),
    persistedSkips: persistedA,
    logs: logs.filter(line => line.includes('job-a')),
  }

  // ---- C. the pure scan: same instant as before, plus the gap record -------
  const scan = nextRunAtMsWithGaps('30 2 * * *', at(2026, 3, 7, 2, 30).getTime())
  report.scan = {
    atWallClock: scan.at === undefined ? null : stamp(scan.at),
    gaps: scan.gaps.map(gap => gap.wallClock),
    normalizedToWallClock: scan.gaps[0] === undefined ? null : stamp(scan.gaps[0].normalizedTo),
  }

  // ---- D. a fall-back (repeated hour) is NOT a gap ------------------------
  const fallBack = nextRunAtMsWithGaps('30 1 * * *', at(2026, 11, 1, 0, 0).getTime())
  report.fallBack = {
    atWallClock: fallBack.at === undefined ? null : stamp(fallBack.at),
    gaps: fallBack.gaps.map(gap => gap.wallClock),
  }
} finally {
  console.warn = originalWarn
}

process.stdout.write(`${JSON.stringify(report)}\n`)
