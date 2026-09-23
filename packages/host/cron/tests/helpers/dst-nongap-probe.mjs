/**
 * DST non-gap probe child (2026-09-23 R3-B3 F2 / B-5 regression, REVERSE case).
 *
 * Runs with `TZ=America/New_York` around the US spring-forward night
 * 2026-03-08 and drives the REAL ledger with a fixed clock for a schedule whose
 * occurrence on that very day DOES exist (09:00 — only 02:00–02:59 is missing).
 *
 * Deliberately free of the new gap-reporting API so the same probe also runs
 * against the pre-fix baseline: it is the "did the fix suppress anything?"
 * half of the pair (the positive half is `dst-gap-probe.mjs`).
 *
 * Not a spec file (vitest's include is `tests/**\/*.spec.ts`) and plain JS so
 * nothing type-checks or collects it: `node` type-strips the imported `.ts`
 * sources by itself.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { HostCronLedger } from '../../src/host-ledger.ts'

const base = process.argv[2]
mkdirSync(base, { recursive: true })

const at = (year, month, day, hour, minute) => new Date(year, month - 1, day, hour, minute, 0, 0)
const stamp = (ms) => {
  const d = new Date(ms)
  const pad = value => String(value).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const report = { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }

const home = join(base, 'same-day')
const clock = { value: at(2026, 3, 7, 9, 0).getTime() }
const ledger = new HostCronLedger({ dshHomeDir: home, now: () => clock.value })
ledger.applyRequest('nongap-create', {
  kind: 'create',
  id: 'job-morning',
  input: { name: 'Morning', cron: '0 9 * * *', action: { kind: 'agent', prompt: 'probe' }, enabled: true },
})

const seeded = ledger.state().jobs[0].nextRunAt
const due = at(2026, 3, 8, 9, 0)
clock.value = due.getTime()
const opened = ledger.openScheduled('job-morning', 'nongap-e1', clock.value)
const job = ledger.state().jobs[0]
ledger.settle('job-morning', 'nongap-e1', 'succeeded')
const settled = ledger.state().jobs[0].executions.at(-1)
const skips = ledger.state().scheduler.skippedOccurrences ?? []
ledger.dispose()

report.sameDay = {
  seededWallClock: seeded === undefined ? null : stamp(seeded),
  // The 09:00 wall clock on the spring-forward day exists in this zone.
  dueExists: due.getHours() === 9 && due.getMinutes() === 0,
  opened: opened !== undefined,
  triggeredWallClock: opened === undefined ? null : stamp(opened.execution.triggeredAt),
  nextWallClock: job.nextRunAt === undefined ? null : stamp(job.nextRunAt),
  result: settled?.result ?? null,
  skips,
}

process.stdout.write(`${JSON.stringify(report)}\n`)
