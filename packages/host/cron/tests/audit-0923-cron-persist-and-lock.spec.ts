/**
 * Regression for the R4-B audit (2026-09-23), findings **R4-B-11** and
 * **R4-B-12**.
 *
 * R4-B-11 — a failed `persist()` left its temporary file behind. That file holds
 * the COMPLETE document (job prompts included) and nothing ever removed it, so a
 * recurring write failure accumulated full copies of the user's prompts in
 * `$DSH_HOME/cron/`. The same failure also left the rejected mutation live in
 * memory: the caller was told the write failed, the panel showed the change, and
 * the next restart silently reverted it ("改了又变回去").
 *
 * R4-B-12 — `ledger.lock` recorded a bare pid, so a lock whose pid had been
 * recycled by an unrelated live process looked "owned" forever: every Host
 * construction threw and cron disappeared for the whole session, with a message
 * that named neither the file nor a remedy.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HostCronLedger } from '../src/host-ledger.ts'
import type { CronAction } from '../src/protocol.ts'

const T0 = new Date(2026, 8, 23, 9, 0, 0).getTime()

let home: string
const children: Array<{ kill: (signal: NodeJS.Signals) => boolean, pid?: number }> = []
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'r4b11-cron-')) })
afterEach(() => {
  vi.restoreAllMocks()
  while (children.length > 0) {
    const child = children.pop()
    try { child?.kill('SIGKILL') } catch { /* already gone */ }
  }
  rmSync(home, { recursive: true, force: true })
})

const cronDir = (): string => join(home, 'cron')
const ledgerPath = (): string => join(cronDir(), 'ledger.json')
const lockPath = (): string => join(cronDir(), 'ledger.lock')

function createAction(id: string): CronAction {
  return {
    kind: 'create',
    id,
    input: { name: id, cron: '0 9 * * *', action: { kind: 'agent', prompt: `prompt-of-${id}` }, enabled: true },
  }
}

/** Temp files a failed or partial persist would leave behind. */
function tempFiles(): string[] {
  return readdirSync(cronDir()).filter(name => name.includes('.tmp-'))
}

/** A live process that is NOT a ledger owner (the pid-reuse shape). */
async function liveBystander(): Promise<number> {
  const child = spawn('sleep', ['30'], { stdio: 'ignore' })
  children.push(child)
  await new Promise(resolve => setTimeout(resolve, 150))
  if (child.pid === undefined) throw new Error('spawn produced no pid')
  return child.pid
}

describe('R4-B-11: a failed write cleans up after itself and rolls the memory back', () => {
  it('leaves no temporary copy of the prompts and keeps memory equal to the disk', () => {
    const host = new HostCronLedger({ dshHomeDir: home, now: () => T0 })
    host.applyRequest('r1', createAction('job-1'))
    const committedBytes = readFileSync(ledgerPath())
    const committedRevision = host.state().revision
    expect(tempFiles()).toEqual([])

    // Make the atomic replace impossible: `ledger.json` becomes a NON-EMPTY
    // directory, so the final `renameSync(tmp, ledger.json)` fails the way an
    // ENOSPC/EACCES on the rename does — after the temp file was fully written.
    unlinkSync(ledgerPath())
    mkdirSync(ledgerPath())
    writeFileSync(join(ledgerPath(), 'keep'), 'x')

    expect(() => { host.applyRequest('r2', createAction('job-2')) }).toThrow()
    // The fix: the temp file (a complete copy, prompts included) is removed.
    expect(tempFiles(), 'the failed write must not leave its temporary document behind').toEqual([])
    // …and the rejected mutation is not visible in memory either.
    expect(host.state().jobs.map(job => job.id)).toEqual(['job-1'])
    expect(host.state().revision).toBe(committedRevision)

    // A second failure must not accumulate anything either.
    expect(() => { host.applyRequest('r3', createAction('job-3')) }).toThrow()
    expect(tempFiles()).toEqual([])
    expect(host.state().jobs.map(job => job.id)).toEqual(['job-1'])

    // The requestId was not claimed by the failed mutation: a retry is a real
    // retry, not an idempotent replay of something that never happened.
    expect(() => { host.applyRequest('r2', createAction('job-2')) }).toThrow(/EEXIST|ENOTEMPTY|EISDIR|ENOTDIR/u)

    // Restore the file so dispose() can finish cleanly, and prove the disk was
    // never touched by the failed attempts.
    rmSync(ledgerPath(), { recursive: true, force: true })
    writeFileSync(ledgerPath(), committedBytes)
    host.dispose()
    expect(readFileSync(ledgerPath())).toEqual(committedBytes)
  })

  it('control: a successful write still lands atomically with no leftovers', () => {
    const host = new HostCronLedger({ dshHomeDir: home, now: () => T0 })
    host.applyRequest('r1', createAction('job-1'))
    host.applyRequest('r2', createAction('job-2'))
    expect(host.state().jobs.map(job => job.id)).toEqual(['job-1', 'job-2'])
    expect(host.state().revision).toBe(2)
    expect(tempFiles()).toEqual([])
    host.dispose()
    const document = JSON.parse(readFileSync(ledgerPath(), 'utf8')) as { jobs: Array<{ id: string }>, revision: number }
    expect(document.jobs.map(job => job.id)).toEqual(['job-1', 'job-2'])
    expect(document.revision).toBe(2)
  })
})

describe('R4-B-12: a ledger lock owned by a recycled pid no longer disables cron', () => {
  it('reclaims a legacy bare-pid lock whose live pid started long after it', async () => {
    mkdirSync(cronDir(), { recursive: true })
    const bystanderPid = await liveBystander()
    writeFileSync(lockPath(), `${String(bystanderPid)}\n`)
    // The lock is hours old while the process that owns that pid started a
    // moment ago: the pid was recycled, this is not the ledger owner.
    const old = (Date.now() - 6 * 60 * 60 * 1000) / 1000
    utimesSync(lockPath(), old, old)

    const warnings: string[] = []
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warnings.push(args.map(String).join(' ')) })
    const host = new HostCronLedger({ dshHomeDir: home, now: () => T0 })
    expect(host.state().revision).toBe(0)
    host.dispose()
    expect(warnings.join('\n')).toContain('recycled pid')
  }, 30_000)

  it('reclaims a payload lock whose recorded owner started after the lock was written', async () => {
    mkdirSync(cronDir(), { recursive: true })
    const bystanderPid = await liveBystander()
    writeFileSync(lockPath(), `${JSON.stringify({
      pid: bystanderPid,
      // Six hours before the bystander process even existed.
      startedAt: Date.now() - 6 * 60 * 60 * 1000,
      host: hostname(),
    })}\n`)

    const warnings: string[] = []
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warnings.push(args.map(String).join(' ')) })
    const host = new HostCronLedger({ dshHomeDir: home, now: () => T0 })
    expect(host.state().revision).toBe(0)
    host.dispose()
    expect(warnings.join('\n')).toContain('recycled pid')
  }, 30_000)

  it('refuses a lock whose owner really is alive — and says which file, who holds it, and what to do', () => {
    mkdirSync(cronDir(), { recursive: true })
    // This process is genuinely alive and it really did write the lock now.
    writeFileSync(lockPath(), `${JSON.stringify({ pid: process.pid, startedAt: Date.now(), host: hostname() })}\n`)

    let failure: unknown
    try {
      new HostCronLedger({ dshHomeDir: home, now: () => T0 })
    } catch (error) {
      failure = error
    }
    const message = String(failure)
    expect(message).toContain('another Host process owns the cron ledger')
    expect(message, 'the message must name the lock file').toContain(lockPath())
    expect(message, 'and the recorded owner').toContain(`pid ${String(process.pid)}`)
    expect(message, 'and the manual remedy').toMatch(/delete that lock file/u)
    // The refusal must not have stolen the lock.
    expect(existsSync(lockPath())).toBe(true)
  })

  it('does not compare pids across machines: a foreign-host lock is left to the operator', async () => {
    mkdirSync(cronDir(), { recursive: true })
    const bystanderPid = await liveBystander()
    writeFileSync(lockPath(), `${JSON.stringify({
      pid: bystanderPid,
      startedAt: Date.now() - 6 * 60 * 60 * 1000,
      host: 'another-machine.example',
    })}\n`)

    expect(() => new HostCronLedger({ dshHomeDir: home, now: () => T0 })).toThrow(/another Host process owns the cron ledger/u)
    expect(existsSync(lockPath())).toBe(true)
  }, 30_000)

  it('a live successor process still gets the lock after dispose (no regression)', () => {
    const first = new HostCronLedger({ dshHomeDir: home, now: () => T0 })
    first.applyRequest('r1', createAction('job-1'))
    first.dispose()
    expect(existsSync(lockPath())).toBe(false)

    // A real second process is the honest shape of the successor generation.
    const probe = fileURLToPath(new URL('./helpers/ledger-generation-probe.mjs', import.meta.url))
    const report = spawnSync(process.execPath, [probe, home, 'job-2'], { encoding: 'utf8' })
    expect(report.status, report.stderr).toBe(0)
    expect(JSON.parse(report.stdout.trim().split('\n').at(-1) ?? '{}')).toMatchObject({ opened: true, jobsAfter: 2 })
  })
})
