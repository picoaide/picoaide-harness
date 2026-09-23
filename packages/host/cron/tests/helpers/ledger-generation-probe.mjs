/**
 * Cross-process generation probe (2026-09-23 R3-B3 F1 regression, report
 * `temp/round3-2026-09-23/R3-B3-cron.md` §2 F1).
 *
 * Opens the cron ledger of the given DSH home as a **separate process** — the
 * shape of a real successor generation, which can only acquire `ledger.lock`
 * after the previous generation released it — creates one job, and disposes.
 * Reports the outcome as one JSON line so the spec can tell "the successor
 * inherited a usable ledger" apart from "a disposal had sealed the file for
 * everyone" (over-fix).
 *
 * Not a spec file (vitest's include is `tests/**\/*.spec.ts`) and plain JS so
 * nothing type-checks or collects it: `node` type-strips the imported `.ts`
 * sources by itself.
 */
import { HostCronLedger } from '../../src/host-ledger.ts'

const home = process.argv[2]
const jobId = process.argv[3]

/** @type {{ opened: boolean, error?: string, jobsAfter: number, revision: number, loadMode?: string }} */
const report = { opened: false, jobsAfter: 0, revision: 0 }

let ledger
try {
  ledger = new HostCronLedger({ dshHomeDir: home })
  report.opened = true
  report.loadMode = ledger.loadMode()
  ledger.applyRequest(`probe-create-${jobId}`, {
    kind: 'create',
    id: jobId,
    input: { name: jobId, cron: '0 9 * * *', action: { kind: 'agent', prompt: 'p' }, enabled: true },
  })
  const state = ledger.state()
  report.jobsAfter = state.jobs.length
  report.revision = state.revision
  ledger.dispose()
} catch (error) {
  report.error = String(error)
}

process.stdout.write(`${JSON.stringify(report)}\n`)
