/**
 * R3-B3 F1（P1）回归 —— 2026-09-23 第三轮审计（报告
 * `temp/round3-2026-09-23/R3-B3-cron.md` §2 F1）。
 *
 * 缺陷：`HostCronLedger.dispose()` 只 `closeSync` + `unlinkSync(ledger.lock)`，
 * **不封笔**。于是 dispose 之后的写路径仍会 tmp + fsync + `renameSync` 覆盖同一个
 * `ledger.json`，而锁已经交给继任世代（HMR 重载 / 同进程重建）——既没有互斥、也不
 * 报错：
 *
 *   - 路径 ①：`HostCronScheduler.fire()` 的 `.then` 在 teardown 之后才结算
 *     （`attachSession`/`attachPrompt`/`settle` 都是 `mutate`）；
 *   - 路径 ②：`POST /api/cron/action` 的 body 还在读时插件被 dispose，
 *     请求随后落在已释放锁的账本上，且 HTTP 面回 200。
 *
 * 判据分三层（都能咬到实现，而不是只钉字符串）：
 *   1. **封笔**：dispose 之后任何写路径必须 fail-loud（抛错 + 日志点名文件与原因），
 *      且磁盘**逐字节不变** —— 同时钉住"被拒"与"仍在写盘"两个世界；
 *   2. **顺序**：先 flush 再封笔、封笔先于放锁。load 期推迟到"下一次成功写"的收敛
 *      （崩溃遗留执行结算 / owner 规范化 / 损坏重置）必须在放锁前落盘，否则继任世代
 *      读到的是未被解释的旧字节；
 *   3. **反向（防过度修复）**：正常生命周期照常持久化 —— 首次写落盘、跨世代（含
 *      真实子进程）替换后仍能读回；空账本 dispose 不得凭空造出 `ledger.json`。
 */
import { spawnSync } from 'node:child_process'
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HostCronLedger } from '../src/host-ledger.ts'
import { HostCronScheduler } from '../src/host-scheduler.ts'
import { HostCronService } from '../src/host-service.ts'
import { makeCronRoutes } from '../src/host-routes.ts'
import { CRON_API_PREFIX, type CronAction } from '../src/protocol.ts'

const PROBE = fileURLToPath(new URL('./helpers/ledger-generation-probe.mjs', import.meta.url))

/** Fixed clock: the fixtures must not depend on the wall clock. */
const T0 = new Date(2026, 8, 23, 9, 0, 0).getTime()
const DAY = 24 * 60 * 60 * 1000

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-cron-dispose-seal-'))
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

const ledgerPath = (): string => join(dir, 'cron', 'ledger.json')
const lockPath = (): string => join(dir, 'cron', 'ledger.lock')

/** Leftovers a failed/partial write would leave behind. */
function tempFiles(): string[] {
  return readdirSync(join(dir, 'cron')).filter(name => name.includes('.tmp-'))
}

function documentOnDisk(): {
  revision: number
  jobs: Array<{ id: string; executions: Array<{ id: string; result?: string; endedAt?: number }> }>
} {
  return JSON.parse(readFileSync(ledgerPath(), 'utf8'))
}

function createAction(id: string): CronAction {
  return {
    kind: 'create',
    id,
    input: { name: id, cron: '0 9 * * *', action: { kind: 'agent', prompt: 'p' }, enabled: true },
  }
}

/** Silence (and capture) the loud refusal so the suite output stays readable. */
function captureConsoleError(): string[] {
  const lines: string[] = []
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(arg => (arg instanceof Error ? arg.message : String(arg))).join(' '))
  })
  return lines
}

/** A stored document whose execution was left pending by a crashed Host. */
function writeDocumentWithPendingExecution(): void {
  mkdirSync(join(dir, 'cron'), { recursive: true })
  writeFileSync(ledgerPath(), JSON.stringify({
    schemaVersion: 2,
    revision: 4,
    jobs: [{
      id: 'job-crashed',
      name: 'crashed',
      cron: '0 9 * * *',
      action: { kind: 'agent', prompt: 'p' },
      enabled: true,
      executions: [{ id: 'exec-crashed', triggeredAt: T0 - 60_000 }],
      createdAt: 1,
      updatedAt: 1,
      nextRunAt: T0 + DAY,
    }],
    scheduler: { timeZone: 'UTC' },
    recentRequests: [],
  }), 'utf8')
}

describe('R3-B3 F1 ledger dispose seal', () => {
  it('refuses every write after dispose, loudly, without touching the disk', () => {
    const host = new HostCronLedger({ dshHomeDir: dir, now: () => T0 })
    host.applyRequest('r1', createAction('job-1'))
    host.dispose()

    const authoritative = readFileSync(ledgerPath())
    const logged = captureConsoleError()

    // Every write path funnels through the same gate: the public action API
    // (even an idempotent replay), the scheduler-owned writes, and the service
    // upsert surface.
    expect(() => host.applyRequest('r1', createAction('job-1'))).toThrowError(/ledger is disposed/)
    expect(() => host.applyRequest('r2', createAction('job-2'))).toThrowError(/write refused/)
    expect(() => host.setScheduler({ lastTickAt: T0 })).toThrowError(/ledger is disposed/)
    expect(() => host.openScheduled('job-1', 'exec-late', T0)).toThrowError(/ledger is disposed/)
    expect(() => host.upsertJob({ id: 'job-3', name: 'j3', cron: '0 9 * * *', action: { kind: 'agent', prompt: 'p' } }))
      .toThrowError(/ledger is disposed/)

    // Fail-loud, not fail-silent: the log names the ledger file and the reason.
    expect(logged.join('\n')).toMatch(/ledger is disposed/)
    expect(logged.join('\n')).toMatch(/write refused/)
    expect(logged.join('\n')).toContain(ledgerPath())

    // …and nothing reached the disk: no rename, no tmp leftovers, no revision
    // bump. This is the half that separates "refused" from "wrote anyway".
    expect(readFileSync(ledgerPath())).toEqual(authoritative)
    expect(tempFiles()).toEqual([])
  })

  it('cannot rewrite the successor generation: a late scheduled settlement is refused', async () => {
    const ledger1 = new HostCronLedger({ dshHomeDir: dir, now: () => T0 })
    ledger1.applyRequest('seed', createAction('job-1'))

    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    const scheduler = new HostCronScheduler(ledger1, {
      execute: async () => ({ result: 'succeeded' as const, sessionId: 'sess-1', prompt: 'p' }),
    } as never, { now: () => T0 })

    // A scheduled run is open and its execution only settles after teardown.
    const opened = ledger1.openScheduled('job-1', 'exec-1', T0)!
    const fireDone = scheduler.fire(opened.job, opened.execution)

    scheduler.dispose()
    ledger1.dispose()
    // The lock really was handed over (not merely "intended"): the file is gone.
    expect(existsSync(lockPath())).toBe(false)

    const ledger2 = new HostCronLedger({ dshHomeDir: dir, now: () => T0 })
    ledger2.applyRequest('seed2', createAction('job-2'))
    const successor = documentOnDisk()
    expect(successor.jobs.map(job => job.id)).toEqual(['job-1', 'job-2'])
    const successorBytes = readFileSync(ledgerPath())

    const logged = captureConsoleError()
    release()
    await fireDone
    await new Promise(resolve => setTimeout(resolve, 0))

    // Refused loudly…
    expect(logged.join('\n')).toMatch(/ledger is disposed/)
    // …and the successor's document survives byte-for-byte (pre-fix this is
    // where `job-2` disappeared and its revision jumped backwards).
    expect(readFileSync(ledgerPath())).toEqual(successorBytes)
    expect(documentOnDisk()).toEqual(successor)
    expect(ledger2.state().jobs.map(job => job.id)).toEqual(['job-1', 'job-2'])
    expect(tempFiles()).toEqual([])
    ledger2.dispose()
  })

  it('lands the pending (memory-only) state before sealing', () => {
    writeDocumentWithPendingExecution()
    const before = documentOnDisk()
    expect(before.jobs[0]!.executions[0]!.endedAt).toBeUndefined()

    const host = new HostCronLedger({ dshHomeDir: dir, now: () => T0 })
    // The reconcile is memory-only by design ("the next successful write
    // persists it"): that is exactly the pending write dispose must flush.
    expect(host.state().jobs[0]!.executions[0]!.result).toBe('cancelled')
    expect(documentOnDisk().jobs[0]!.executions[0]!.endedAt).toBeUndefined()

    host.dispose()

    // Flush ran BEFORE the seal: the converge reached the disk…
    const after = documentOnDisk()
    expect(after.jobs[0]!.executions[0]!.result).toBe('cancelled')
    expect(after.jobs[0]!.executions[0]!.endedAt).toBeDefined()
    // …without being a mutation: no revision bump, no tmp leftovers.
    expect(after.revision).toBe(before.revision)
    expect(tempFiles()).toEqual([])
    // And the seal is still in force afterwards.
    expect(() => host.applyRequest('late', createAction('job-late'))).toThrowError(/ledger is disposed/)
  })

  it('disposes idempotently and never touches a successor generation', () => {
    const first = new HostCronLedger({ dshHomeDir: dir, now: () => T0 })
    first.applyRequest('r1', createAction('job-1'))
    first.dispose()
    expect(() => first.dispose()).not.toThrow()

    const second = new HostCronLedger({ dshHomeDir: dir, now: () => T0 })
    second.applyRequest('r2', createAction('job-2'))
    const bytes = readFileSync(ledgerPath())
    expect(existsSync(lockPath())).toBe(true)

    // A repeated dispose must not re-release the lock (both generations share
    // this pid, so the pid check inside the release cannot save us) nor rewrite
    // the successor's document.
    expect(() => first.dispose()).not.toThrow()
    expect(existsSync(lockPath())).toBe(true)
    expect(readFileSync(ledgerPath())).toEqual(bytes)
    expect(second.state().jobs.map(job => job.id)).toEqual(['job-1', 'job-2'])

    second.dispose()
    expect(existsSync(lockPath())).toBe(false)
  })
})

describe('R3-B3 F1 dispose does not break the normal lifecycle (reverse cases)', () => {
  it('writes nothing on dispose when no state is pending', () => {
    // An empty first-run ledger must not leave an invented `ledger.json` behind.
    const empty = new HostCronLedger({ dshHomeDir: dir, now: () => T0 })
    expect(empty.loadMode()).toBe('first-run')
    empty.dispose()
    expect(existsSync(ledgerPath())).toBe(false)

    const first = new HostCronLedger({ dshHomeDir: dir, now: () => T0 })
    first.applyRequest('r1', createAction('job-1'))
    first.dispose()
    const bytes = readFileSync(ledgerPath())

    // A clean reload has nothing deferred: dispose is a pure lock release.
    const clean = new HostCronLedger({ dshHomeDir: dir, now: () => T0 })
    expect(clean.loadMode()).toBe('loaded')
    clean.dispose()
    expect(readFileSync(ledgerPath())).toEqual(bytes)
    expect(tempFiles()).toEqual([])
  })

  it('never flushes a read-only ledger at dispose (the unreadable bytes must survive)', () => {
    mkdirSync(join(dir, 'cron'), { recursive: true })
    // `ledger.json -> .` (its own directory): open(2) succeeds, read(2) fails
    // with a real EISDIR, while `renameSync(tmp, ledger.json)` would replace the
    // *link* — the CR-1 fixture. The new flush-before-seal path must not become
    // a second way to rename over bytes the ledger could not read.
    symlinkSync('.', ledgerPath())
    const logged = captureConsoleError()

    const host = new HostCronLedger({ dshHomeDir: dir, now: () => T0 })
    expect(host.loadMode()).toBe('read-only')
    host.dispose()

    expect(lstatSync(ledgerPath()).isSymbolicLink()).toBe(true)
    expect(tempFiles()).toEqual([])
    // The load degradation is logged (CR-1); dispose added nothing on top —
    // no flush attempt, no refusal, no failure to report.
    expect(logged.join('\n')).toMatch(/ledger stays read-only/)
    expect(logged.join('\n')).not.toMatch(/dispose could not persist/)
  })

  it('keeps persisting across generations, including a real successor process', () => {
    const g1 = new HostCronLedger({ dshHomeDir: dir, now: () => T0 })
    g1.applyRequest('r1', createAction('job-1'))
    // The first write reaches the disk immediately (not only at dispose).
    expect(documentOnDisk().jobs.map(job => job.id)).toEqual(['job-1'])
    g1.dispose()
    expect(existsSync(lockPath())).toBe(false)

    // A *separate process* is the honest shape of the successor generation:
    // it can only get the lock because dispose released it, and the seal must
    // not have sealed the file for everyone.
    const probe = spawnSync(process.execPath, [PROBE, dir, 'job-2'], { encoding: 'utf8' })
    expect(probe.status, probe.stderr).toBe(0)
    const report = JSON.parse(probe.stdout.trim().split('\n').at(-1)!) as {
      opened: boolean
      error?: string
      jobsAfter: number
      revision: number
      loadMode?: string
    }
    expect(report.opened, report.error).toBe(true)
    expect(report.loadMode).toBe('loaded')
    expect(report.jobsAfter).toBe(2)
    expect(report.revision).toBe(2)

    // In-process generation 3 reads both jobs back.
    const g3 = new HostCronLedger({ dshHomeDir: dir, now: () => T0 })
    expect(g3.state().jobs.map(job => job.id)).toEqual(['job-1', 'job-2'])
    expect(g3.state().revision).toBe(2)
    g3.applyRequest('r3', createAction('job-3'))
    g3.dispose()
    expect(documentOnDisk().jobs.map(job => job.id)).toEqual(['job-1', 'job-2', 'job-3'])
  })
})

describe('R3-B3 F1 the product write face (POST /api/cron/action)', () => {
  it('answers a late request with an error instead of a lying 200', async () => {
    const home = dir
    let gateRelease: () => void = () => {}
    const gate = new Promise<void>(resolve => { gateRelease = resolve })

    function fakeRequest(body: string): IncomingMessage {
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
        [Symbol.asyncIterator]: async function* () {
          await gate
          for (const chunk of chunks) yield chunk
        },
      } as unknown as IncomingMessage
    }

    const answer = { code: 0, body: '' }
    const res = {
      writeHead: (code: number) => { answer.code = code },
      write: (chunk?: string) => { answer.body += chunk ?? '' },
      end: (chunk?: string) => { answer.body += chunk ?? '' },
      once: () => {},
    } as unknown as ServerResponse

    const service = new HostCronService({} as never, {
      ledger: new HostCronLedger({ dshHomeDir: home, now: () => T0 }),
      executor: { execute: async () => ({ result: 'succeeded' as const }) } as never,
      now: () => T0,
    })
    service.apply('seed', createAction('job-1'))

    // The write face's possession proof is not what this case is about: the
    // audit probe passes it too, because a page served by this process is the
    // normal user path (see R4-RV3a spec for the proof's own regressions).
    const route = makeCronRoutes(service, { fence: () => ({ requestRejection: () => undefined }) })
      .find(candidate => candidate.path === `${CRON_API_PREFIX}/action`)!
    const inFlight = route.handler(fakeRequest(JSON.stringify({ requestId: 'ui-create-2', action: createAction('job-2') })), res)
    // Park the handler in `await readBody(...)`.
    await new Promise(resolve => setImmediate(resolve))

    service.dispose()
    expect(existsSync(lockPath())).toBe(false)

    const successor = new HostCronLedger({ dshHomeDir: home, now: () => T0 })
    successor.applyRequest('seed2', createAction('job-3'))
    const successorBytes = readFileSync(ledgerPath())

    gateRelease()
    await inFlight

    // Pre-fix: HTTP 200 carrying a full snapshot of the *previous* generation,
    // while the successor's `job-3` was renamed away underneath.
    expect(answer.code).toBe(400)
    expect(JSON.parse(answer.body)).toMatchObject({ ok: false })
    expect(JSON.parse(answer.body).error).toMatch(/disposed/)

    expect(readFileSync(ledgerPath())).toEqual(successorBytes)
    expect(documentOnDisk().jobs.map(job => job.id)).toEqual(['job-1', 'job-3'])
    expect(tempFiles()).toEqual([])

    // The service front door refuses replays too (the generation is over).
    expect(() => service.apply('seed', createAction('job-1'))).toThrowError(/disposed/)
    expect(() => service.registerJob({ id: 'job-x', name: 'x', cron: '0 9 * * *', action: { kind: 'agent', prompt: 'p' } }))
      .toThrowError(/disposed/)
    expect(() => service.unregisterJob('job-1')).toThrowError(/disposed/)
    expect(documentOnDisk().jobs.map(job => job.id)).toEqual(['job-1', 'job-3'])
    successor.dispose()
  })
})
