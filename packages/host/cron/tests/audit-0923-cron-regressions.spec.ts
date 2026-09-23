/**
 * 2026-09-23 独立审计 cron 修复回归（报告
 * `temp/audit-2026-09-23/D-browser-wasm-host.md` §4.7/§4.8，子报告 `probes/host/subcron.md`）。
 *
 *   CR-2 —— 删除正在执行的任务：工具面有闸，GUI/HTTP 直连 `ledger.applyRequest` 没有，
 *           删掉后 `settle()` 静默 no-op ⇒ 执行记录（会话 id/prompt/结果）无声消失。
 *   CR-4 —— `HostCronService.start()` 无视 `active` 总开关：`apply()` 里
 *           `setConfiguration(false, catchUpMissed)` → `start()` 仍会跑 `tick(true)`，
 *           其补跑分支在 `sync()` 关停调度器之前就 spawn 会话。
 *   CR-6 —— "错过即跳过"只在重启路径成立：停用多日再启用（旧 `nextRunAt` 留在过去）
 *           与"账号未登录期间到期"都会在下一个普通 tick 迟到补跑。
 *   CR-7 —— owner 键是客户端输入的登录字符串：同账号换大小写 ⇒ 任务看不见、
 *           也不再执行（记录还在盘上）。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import { HostCronLedger } from '../src/host-ledger.ts'
import { HostCronScheduler } from '../src/host-scheduler.ts'
import { HostCronService } from '../src/host-service.ts'
import { jobIsRunning, jobVisibleTo } from '../src/jobs.ts'
import { makeCronRoutes } from '../src/host-routes.ts'
import { CRON_API_PREFIX } from '../src/protocol.ts'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
/** 2026-09-23 09:00 local — a deterministic clock for the scheduling cases. */
const T0 = new Date(2026, 8, 23, 9, 0, 0).getTime()

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-cron-0923-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const ledgerPath = (): string => join(dir, 'cron', 'ledger.json')

const createAction = (id: string, cron = '0 9 * * *', enabled = true) => ({
  kind: 'create' as const,
  id,
  input: { name: id, cron, action: { kind: 'agent' as const, prompt: `prompt of ${id}` }, enabled },
})

/** Minimal same-origin POST to the real action route (write proof stubbed open). */
function fakePost(body: string): IncomingMessage {
  const chunks = [Buffer.from(body)]
  return {
    method: 'POST',
    url: `${CRON_API_PREFIX}/action`,
    headers: {
      host: '127.0.0.1:3080',
      origin: 'http://127.0.0.1:3080',
      'content-type': 'application/json',
      'sec-fetch-site': 'same-origin',
    },
    socket: { remoteAddress: '127.0.0.1' },
    once: () => {},
    [Symbol.asyncIterator]: async function* () { for (const chunk of chunks) yield chunk },
  } as unknown as IncomingMessage
}

function fakeResponse(): { res: ServerResponse; read: () => { code: number; body: string } } {
  const state = { code: 0, body: '' }
  const res = {
    writeHead: (code: number) => { state.code = code },
    write: (chunk?: string) => { state.body += chunk ?? '' },
    end: (chunk?: string) => { state.body += chunk ?? '' },
    once: () => {},
  } as unknown as ServerResponse
  return { res, read: () => ({ ...state }) }
}

describe('CR-2 deleting a running job is refused at the mutation point', () => {
  it('the ledger refuses the delete, keeps the job, and the HTTP route answers 400', async () => {
    const service = new HostCronService({} as unknown as ApiProxy, {
      ledger: new HostCronLedger({ dshHomeDir: dir, owner: () => 'alice' }),
      now: () => T0,
    })
    service.setUsername('alice')
    service.apply('seed', createAction('job-1'))
    // Open a run without launching a session (a real `service.apply('run')`
    // would spawn the executor and settle the record within the same tick).
    service.ledger.applyRequest('open', { kind: 'run', jobId: 'job-1' })
    expect(jobIsRunning(service.ledger.state().jobs[0]!)).toBe(true)
    const revision = service.ledger.state().revision

    const route = makeCronRoutes(service, { fence: () => ({ requestRejection: () => undefined }) })
      .find(candidate => candidate.path === `${CRON_API_PREFIX}/action`)!
    const out = fakeResponse()
    await route.handler(fakePost(JSON.stringify({ requestId: 'ui-delete', action: { kind: 'delete', jobId: 'job-1' } })), out.res)
    const answer = out.read()
    expect(answer.code).toBe(400)
    expect(answer.body).toContain('is running')

    // Nothing was lost: the job and its live execution record are still there.
    expect(service.ledger.state().jobs.map(job => job.id)).toEqual(['job-1'])
    expect(service.ledger.state().revision).toBe(revision)

    // …and once the run settles, the delete goes through.
    const execution = service.ledger.state().jobs[0]!.executions[0]!
    service.ledger.settle('job-1', execution.id, 'succeeded')
    service.apply('ui-delete-2', { kind: 'delete', jobId: 'job-1' })
    expect(service.ledger.state().jobs).toHaveLength(0)
    service.dispose()
  })

  it('the panel button shares the same judgement (disabled while running + own copy)', () => {
    const source = readFileSync(new URL('../src/client/CronJobTab.tsx', import.meta.url), 'utf8')
    // One predicate for tool face, ledger guard and panel (jobs.ts jobIsRunning).
    expect(source).toContain('const running = jobIsRunning(job)')
    expect(source).toContain('disabled={pending || running}')
    expect(source).toContain("title={running ? t('job.deleteRunning') : undefined}")
    const copy = readFileSync(new URL('../src/client/locales.ts', import.meta.url), 'utf8')
    expect(copy).toContain("'job.deleteRunning'")
  })
})

describe('CR-4 the master switch gates start()', () => {
  it('start() with the configuration off launches nothing and mutates nothing', async () => {
    const clock = { value: T0 }
    const fired: string[] = []
    const ledger = new HostCronLedger({ dshHomeDir: dir, owner: () => 'alice', now: () => clock.value })
    ledger.applyRequest('seed', createAction('job-due', '0 * * * *'))
    // The job is now overdue by 90 minutes (as if the app had been closed).
    clock.value = T0 + 90 * 60 * 1000
    const revision = ledger.state().revision
    const service = new HostCronService({} as unknown as ApiProxy, {
      ledger,
      executor: { execute: async (job: { id: string }) => { fired.push(job.id); return { result: 'succeeded' as const } } } as never,
      now: () => clock.value,
    })
    service.setUsername('alice')
    // The exact `apply()` order: setConfiguration first, start() second.
    service.setConfiguration(false, true)
    service.start()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(fired).toEqual([])
    expect(ledger.state().revision).toBe(revision)

    // The switch still works: flipping it on resumes and does catch up.
    service.setConfiguration(true, true)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(fired).toEqual(['job-due'])
    service.dispose()
  })
})

describe('CR-6 missed triggers stay missed', () => {
  it('re-enabling a job disabled for days resumes from now instead of replaying the past instant', () => {
    const clock = { value: T0 }
    const host = new HostCronLedger({ dshHomeDir: dir, owner: () => 'alice', now: () => clock.value })
    host.applyRequest('seed', createAction('job-1'))
    const seeded = host.state().jobs[0]!.nextRunAt!
    expect(seeded).toBe(T0 + DAY)

    clock.value = T0 + 3 * DAY
    host.applyRequest('d1', { kind: 'disable', jobId: 'job-1' })
    host.applyRequest('e1', { kind: 'enable', jobId: 'job-1' })
    const next = host.state().jobs[0]!.nextRunAt!
    // Pre-fix: the stale instant (T0 + DAY) stayed and the next tick fired it.
    expect(next).toBeGreaterThan(clock.value)
    expect(next).toBe(T0 + 4 * DAY)

    // The `update` path that switches a stale job back on behaves the same.
    clock.value = T0 + 5 * DAY
    host.applyRequest('u1', { kind: 'update', jobId: 'job-1', patch: { enabled: false } })
    clock.value = T0 + 6 * DAY
    host.applyRequest('u2', { kind: 'update', jobId: 'job-1', patch: { enabled: true } })
    expect(host.state().jobs[0]!.nextRunAt!).toBeGreaterThan(clock.value)
    host.dispose()
  })

  it('a job that came due while invisible is skipped, not replayed late, when it becomes visible again', async () => {
    // 30 s ticks (well inside RESUME_GAP_MS = 45 s) so the scenario exercises the
    // ordinary path, not the "long gap" recovery branch.
    const at = (h: number, m: number, s: number): number => new Date(2026, 8, 23, h, m, s).getTime()
    const clock = { value: at(10, 0, 20) }
    const host = new HostCronLedger({ dshHomeDir: dir, owner: () => 'alice', now: () => clock.value })
    host.applyRequest('seed', createAction('job-1', '* * * * *'))
    const fired: Array<{ id: string; triggeredAt: number }> = []
    const executor = {
      execute: async (job: { id: string }) => {
        const execution = host.state().jobs.find(candidate => candidate.id === job.id)!.executions.at(-1)!
        fired.push({ id: job.id, triggeredAt: execution.triggeredAt })
        return { result: 'succeeded' as const }
      },
    }
    let visible = true
    const scheduler = new HostCronScheduler(host, executor as never, { now: () => clock.value, visible: () => visible })
    const tick = (first: boolean): Promise<void> => (scheduler as unknown as { tick: (f: boolean) => Promise<void> }).tick(first)

    await tick(true) // boot at 10:00:20: nextRunAt = 10:01:00, not due yet
    expect(fired).toEqual([])
    expect(host.state().jobs[0]!.nextRunAt!).toBe(at(10, 1, 0))

    visible = false // the owner is signed out while the job comes due
    clock.value = at(10, 0, 50)
    await tick(false)
    clock.value = at(10, 1, 20)
    await tick(false)
    expect(fired).toEqual([])
    expect(host.state().jobs[0]!.nextRunAt!).toBe(at(10, 1, 0)) // still the missed instant

    visible = true // signed back in
    clock.value = at(10, 1, 50)
    await tick(false)
    // Pre-fix: one run fired now (triggeredAt == now). Post-fix: skipped and
    // rolled forward, exactly like a restart.
    expect(fired).toEqual([])
    expect(host.state().jobs[0]!.nextRunAt!).toBe(at(10, 2, 0))

    scheduler.dispose()
    host.dispose()
  })

  it('with catch-up enabled the missed instant is fired (not "now") after visibility returns', async () => {
    const at = (h: number, m: number, s: number): number => new Date(2026, 8, 23, h, m, s).getTime()
    const clock = { value: at(10, 0, 20) }
    const host = new HostCronLedger({ dshHomeDir: dir, owner: () => 'alice', now: () => clock.value })
    host.applyRequest('seed', createAction('job-1', '* * * * *'))
    const fired: number[] = []
    const executor = {
      execute: async (job: { id: string }) => {
        fired.push(host.state().jobs.find(candidate => candidate.id === job.id)!.executions.at(-1)!.triggeredAt)
        return { result: 'succeeded' as const }
      },
    }
    let visible = true
    const scheduler = new HostCronScheduler(host, executor as never, {
      now: () => clock.value,
      visible: () => visible,
      catchUpMissed: true,
    })
    const tick = (first: boolean): Promise<void> => (scheduler as unknown as { tick: (f: boolean) => Promise<void> }).tick(first)
    await tick(true)

    visible = false
    clock.value = at(10, 0, 50)
    await tick(false)
    clock.value = at(10, 1, 20)
    await tick(false)
    visible = true
    clock.value = at(10, 1, 50)
    await tick(false)

    // The opt-in policy fires the occurrence that was actually missed…
    expect(fired).toEqual([at(10, 1, 0)])
    // …and rolls past now so it is not fired twice.
    expect(host.state().jobs[0]!.nextRunAt!).toBe(at(10, 2, 0))
    scheduler.dispose()
    host.dispose()
  })
})

describe('CR-7 owner key normalisation', () => {
  it('stamps the canonical key and matches every spelling of the same account', () => {
    let typed: string | null = 'Alice'
    const host = new HostCronLedger({ dshHomeDir: dir, owner: () => typed })
    host.applyRequest('r1', createAction('job-1'))
    expect(host.state().jobs[0]!.owner).toBe('alice')

    for (const spelling of ['alice', 'ALICE', '  Alice  ', 'aLiCe']) {
      expect(jobVisibleTo(host.state().jobs[0]!, spelling), spelling).toBe(true)
      typed = spelling
      // Visible AND mutable: the ledger's own target-action check uses the same
      // canonical comparison, so the job is not a read-only ghost either.
      expect(() => host.applyRequest(`d-${spelling}`, { kind: 'disable', jobId: 'job-1' })).not.toThrow()
      expect(() => host.applyRequest(`e-${spelling}`, { kind: 'enable', jobId: 'job-1' })).not.toThrow()
    }
    // A different account is still locked out.
    typed = 'bob'
    expect(() => host.applyRequest('bob-disable', { kind: 'disable', jobId: 'job-1' })).toThrow(/another account/)
    host.dispose()
  })

  it('keeps legacy records stamped with a raw spelling without a destructive migration', () => {
    mkdirSync(join(dir, 'cron'), { recursive: true })
    writeFileSync(ledgerPath(), JSON.stringify({
      schemaVersion: 2,
      revision: 4,
      jobs: [{
        id: 'job-legacy',
        name: 'legacy payroll',
        cron: '0 9 * * *',
        action: { kind: 'agent', prompt: 'precious prompt' },
        enabled: true,
        owner: 'Alice', // stored by the previous build from the typed login string
        nextRunAt: T0 + DAY,
        executions: [],
        createdAt: 1,
        updatedAt: 1,
      }],
      scheduler: { timeZone: 'UTC' },
      recentRequests: [],
    }), 'utf8')

    const host = new HostCronLedger({ dshHomeDir: dir, owner: () => 'alice', now: () => T0 })
    expect(host.loadMode()).toBe('loaded')
    // Converged in memory (same record, canonical key) and immediately visible
    // to the account that typed a different spelling.
    expect(host.state().jobs).toHaveLength(1)
    expect(host.state().jobs[0]!.owner).toBe('alice')
    expect(host.state().jobs.filter(job => jobVisibleTo(job, '  ALICE '))).toHaveLength(1)

    // The convergence reaches the disk on the next successful write, with the
    // record otherwise untouched.
    host.applyRequest('disable', { kind: 'disable', jobId: 'job-legacy' })
    const document = JSON.parse(readFileSync(ledgerPath(), 'utf8')) as { jobs: Array<{ owner?: string, name: string, action: { prompt: string } }> }
    expect(document.jobs[0]!.owner).toBe('alice')
    expect(document.jobs[0]!.name).toBe('legacy payroll')
    expect(document.jobs[0]!.action.prompt).toBe('precious prompt')
    host.dispose()
  })

  it('the service sees and runs the account jobs across login spellings', async () => {
    const fired: string[] = []
    const service = new HostCronService({} as unknown as ApiProxy, {
      ledger: new HostCronLedger({ dshHomeDir: dir, owner: () => service.currentUsername(), now: () => T0 }),
      executor: { execute: async (job: { id: string }) => { fired.push(job.id); return { result: 'succeeded' as const } } } as never,
      now: () => T0,
    })
    service.setUsername('Alice')
    service.apply('seed', createAction('job-1', '0 * * * *'))
    expect(service.snapshot().jobs).toHaveLength(1)
    expect(service.listVisibleJobs()).toHaveLength(1)

    // Same account, different spelling: still visible, still executable.
    service.setUsername('alice')
    expect(service.snapshot().jobs.map(job => job.id)).toEqual(['job-1'])
    expect(service.listVisibleJobs()).toHaveLength(1)
    service.apply('run', { kind: 'run', jobId: 'job-1' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(fired).toEqual(['job-1'])
    service.dispose()
  })
})
