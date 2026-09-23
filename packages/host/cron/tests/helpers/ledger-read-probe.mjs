/**
 * CR-1 probe child (2026-09-23 audit, report `temp/audit-2026-09-23/D-browser-wasm-host.md` §4.1).
 *
 * Opens the cron ledger of the given DSH home as the *current* uid and reports
 * what happened on stdout as one JSON line. The regression spec runs this under
 * a uid that cannot read the prepared `ledger.json` (real `EACCES`) so the
 * "unreadable ledger must never be overwritten" contract is pinned with a real
 * syscall errno instead of a stubbed error string.
 *
 * Not a spec file (vitest's include is `tests/**\/*.spec.ts`), and plain JS so
 * nothing type-checks or collects it: `node` type-strips the imported `.ts`
 * sources by itself.
 */
import { HostCronLedger } from '../../src/host-ledger.ts'

const home = process.argv[2]

/** @type {{ uid?: number, opened?: boolean, openError?: string, loadMode?: string, readOnlyReason?: string | null, mutationThrew?: boolean, mutationError?: string, jobsAfter?: number }} */
const report = {}
report.uid = typeof process.getuid === 'function' ? process.getuid() : undefined

let ledger
try {
  ledger = new HostCronLedger({ dshHomeDir: home, owner: () => 'alice' })
  report.opened = true
} catch (error) {
  report.opened = false
  report.openError = String(error)
}

if (ledger !== undefined) {
  report.loadMode = ledger.loadMode()
  report.readOnlyReason = ledger.readOnlyReason() ?? null
  try {
    ledger.applyRequest('probe-create', {
      kind: 'create',
      id: 'job-probe',
      input: { name: 'probe', cron: '0 9 * * *', action: { kind: 'agent', prompt: 'p' }, enabled: true },
    })
    report.mutationThrew = false
  } catch (error) {
    report.mutationThrew = true
    report.mutationError = String(error)
  }
  report.jobsAfter = ledger.state().jobs.length
  ledger.dispose()
}

process.stdout.write(`${JSON.stringify(report)}\n`)
