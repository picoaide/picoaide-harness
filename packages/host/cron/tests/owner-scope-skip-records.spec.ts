/**
 * FIX-31（第二十六轮审计发现项，2026-09-26）: the scheduler block is account
 * scoped exactly like the job list.
 *
 * ## 缺陷
 *
 * `HostCronService.snapshot()` filtered `jobs[]` by `jobVisibleTo` but passed
 * `scheduler` through verbatim, and `eventPayload()` returned
 * `ledger.summary()` untouched. A skip record carries `jobId` **and `name`** —
 * the user-authored job name — so a second account (or a logged-out session on
 * the same machine) read the first account's job names out of
 * `GET /api/cron/state`, the action response and every SSE frame, and the panel
 * renders that name in a visible banner.
 *
 * ## 判据（红/绿同一句）
 *
 * With alice's job skipped and bob logged in, the string alice invented must not
 * appear on ANY of the three exits; alice herself must still see it (a filter
 * that hides the owner's own record — or hides owner-less legacy records — is
 * just as broken). The three exits run through the REAL route handlers, so the
 * objects asserted are the ones the HTTP and SSE faces serialize.
 *
 * ---- 变异验证（本次实跑，见 temp/r21/fix-31/probe）----
 *   - 只过滤 `jobs[]`（回到修前形态）⇒ 用例①红（三个出口都带 alice 的名字）；
 *   - 连 owner 自己的记录也过滤（判据写成 "永远返回空"）⇒ 用例①的两条正向断言红；
 *   - 把无主遗留记录也过滤掉 ⇒ 用例②红。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import { HostCronService } from '../src/host-service.ts'
import { HostCronLedger } from '../src/host-ledger.ts'
import { makeCronRoutes } from '../src/host-routes.ts'
import { latestMissedTrigger } from '../src/client/dst-notice.ts'
import { CRON_API_PREFIX } from '../src/protocol.ts'

/** The name alice typed. Nothing about it may reach bob. */
const SECRET_NAME = 'alice-acquisition-plan-Q3'
const ALICE_JOB = 'job-alice'
/** Fixed clock: every `detectedAt` lands inside the panel's notice window. */
const NOW = 1_800_000_000_000

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-cron-skip-scope-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const CREATE_INPUT = (name: string): Record<string, unknown> => ({
  name,
  cron: '0 9 * * *',
  action: { kind: 'agent', prompt: 'run the daily thing', workspaceId: 'ws-1' },
  enabled: true,
})

interface Rig {
  host: HostCronService
  ledger: HostCronLedger
  /** Switch the account the plugin reads (the ledger's owner callback too). */
  setUser: (user: string | null) => void
  /** Create a job, then roll its due instant past — the ordinary "missed" skip. */
  skipOnce: (id: string, name: string) => void
}

function rig(): Rig {
  let user: string | null = 'alice'
  // The clock is pinned on BOTH sides: the ledger stamps `detectedAt` with it
  // and the panel's notice window is evaluated at the same instant, so the case
  // measures visibility and not "the record went stale overnight".
  const ledger = new HostCronLedger({ dshHomeDir: dir, owner: () => user, now: () => NOW })
  const host = new HostCronService({} as unknown as ApiProxy, { ledger, now: () => NOW })
  const setUser = (next: string | null): void => {
    user = next
    host.setUsername(next)
  }
  host.setUsername('alice')
  return {
    host,
    ledger,
    setUser,
    skipOnce: (id, name) => {
      host.apply(`create-${id}`, { kind: 'create', id, input: CREATE_INPUT(name) } as never)
      const due = host.snapshot().jobs.find(job => job.id === id)?.nextRunAt
      expect(due, 'precondition: the job got a next run instant').toBeTypeOf('number')
      ledger.skipMissed(due! + 60_000)
    },
  }
}

// ---- the three real exits -------------------------------------------------

/** Handlers registered through `once()`, so an SSE case can close its stream. */
interface FakeRequest extends IncomingMessage {
  onceHandlers: Map<string, Array<() => void>>
}

function request(method: string, url: string, jsonBody?: unknown): FakeRequest {
  const payload = jsonBody === undefined ? '' : JSON.stringify(jsonBody)
  const onceHandlers = new Map<string, Array<() => void>>()
  const body = {
    async *[Symbol.asyncIterator]() {
      if (payload !== '') yield Buffer.from(payload, 'utf8')
    },
  }
  return {
    ...body,
    method,
    url,
    headers: {
      host: 'localhost:43120',
      origin: 'http://localhost:43120',
      ...(jsonBody === undefined ? {} : { 'content-type': 'application/json' }),
    },
    socket: { remoteAddress: '127.0.0.1' },
    onceHandlers,
    once: (event: string, handler: () => void) => {
      onceHandlers.set(event, [...(onceHandlers.get(event) ?? []), handler])
      return undefined
    },
  } as unknown as FakeRequest
}

function response(): ServerResponse & { body: string; fire: (event: string) => void } {
  const onceHandlers = new Map<string, Array<() => void>>()
  const res = {
    body: '',
    statusCode: 200,
    writeHead: vi.fn((status: number) => { res.statusCode = status }),
    write: vi.fn((chunk?: string) => { res.body += chunk ?? '' }),
    end: vi.fn((chunk?: string) => { res.body += chunk ?? '' }),
    once: (event: string, handler: () => void) => {
      onceHandlers.set(event, [...(onceHandlers.get(event) ?? []), handler])
      return undefined
    },
    fire: (event: string) => { for (const handler of onceHandlers.get(event) ?? []) handler() },
  }
  return res as unknown as ServerResponse & typeof res
}

/** The three exits, driven through the real handlers. */
function exits(host: HostCronService): {
  state: () => Promise<string>
  action: () => Promise<string>
  sse: () => Promise<string>
} {
  // The write face needs the BrowserAuth proof; a fence that always passes is
  // the harness stand-in for a real page holding the cookie.
  const routes = makeCronRoutes(host, { fence: () => ({ requestRejection: () => undefined }) })
  const route = (path: string): { handler: unknown } =>
    routes.find(entry => entry.path === path) as unknown as { handler: unknown }
  return {
    state: async () => {
      const res = response()
      ;(route(`${CRON_API_PREFIX}/state`).handler as (req: IncomingMessage, res: ServerResponse) => void)(
        request('GET', `${CRON_API_PREFIX}/state`),
        res,
      )
      return res.body
    },
    action: async () => {
      const res = response()
      await (route(`${CRON_API_PREFIX}/action`).handler as (
        req: IncomingMessage,
        res: ServerResponse,
      ) => Promise<void>)(
        // A create of bob's OWN job: the response is a full snapshot, which is
        // exactly how the leak reached the action caller.
        request('POST', `${CRON_API_PREFIX}/action`, {
          requestId: 'bob-create',
          action: { kind: 'create', id: 'job-bob', input: CREATE_INPUT('bob weekly report') },
        }),
        res,
      )
      return res.body
    },
    sse: async () => {
      const res = response()
      const req = request('GET', `${CRON_API_PREFIX}/events`)
      ;(route(`${CRON_API_PREFIX}/events`).handler as (req: IncomingMessage, res: ServerResponse) => void)(req, res)
      const frame = res.body
      // Close the stream the way the peer does: the route stops its heartbeat
      // and drops the subscription (otherwise the interval outlives the case).
      for (const handler of req.onceHandlers.get('close') ?? []) handler()
      res.fire('close')
      return frame
    },
  }
}

describe('skip records obey the same account scope as the job list (FIX-31)', () => {
  it('hides another account\'s job name on the state, action and SSE exits — and keeps it for its owner', async () => {
    const { host, setUser, skipOnce } = rig()
    skipOnce(ALICE_JOB, SECRET_NAME)

    // Positive control FIRST: alice's own session still sees the record on the
    // state and SSE exits (the filter must not be "hide everything").
    const alice = exits(host)
    for (const body of [await alice.state(), await alice.sse()]) {
      expect(body, 'the owner must still see her own skip record').toContain(SECRET_NAME)
    }
    const aliceState = JSON.parse(await alice.state()) as { scheduler: { skippedOccurrences?: unknown[] } }
    expect(latestMissedTrigger(aliceState.scheduler, NOW)?.name).toBe(SECRET_NAME)

    // The account switches (same machine, same DSH home).
    setUser('bob')
    const bob = exits(host)
    const bobState = await bob.state()
    const bobAction = await bob.action()
    const bobSse = await bob.sse()

    for (const [label, body] of [['state', bobState], ['action', bobAction], ['SSE', bobSse]] as const) {
      expect(body, `${label} exit must not carry another account's job name`).not.toContain(SECRET_NAME)
      expect(body, `${label} exit must not carry another account's job id`).not.toContain(ALICE_JOB)
    }
    const parsed = JSON.parse(bobState) as { jobs: unknown[]; scheduler: { skippedOccurrences?: unknown[] } }
    expect(parsed.jobs).toEqual([])
    expect(parsed.scheduler.skippedOccurrences ?? []).toEqual([])
    expect(latestMissedTrigger(parsed.scheduler, NOW), 'no banner for another account\'s skip').toBeUndefined()

    // …and alice gets it back on her next read: the filter is per session, the
    // record itself was never destroyed.
    setUser('alice')
    expect(await exits(host).state()).toContain(SECRET_NAME)
    host.dispose()
  })

  it('keeps owner-less legacy records visible to every session', async () => {
    const { host, setUser, skipOnce } = rig()
    // A record created before the owner field existed: stamped by a logged-out
    // host, hence visible to everyone (the pre-upgrade semantics `jobVisibleTo`
    // still documents).
    setUser(null)
    skipOnce('job-legacy', 'legacy nightly')
    setUser('bob')
    const state = await exits(host).state()
    // Assert the SCHEDULER block, not the raw body: the legacy job itself is
    // visible to bob too, so a body-wide `toContain` would pass even with the
    // skip record filtered out (that is exactly the assertion the M3 mutation
    // proved toothless).
    const parsed = JSON.parse(state) as { scheduler: { skippedOccurrences?: Array<{ jobId: string; name: string }> } }
    expect(
      parsed.scheduler.skippedOccurrences?.map(entry => `${entry.jobId}:${entry.name}`),
      'a legacy record is not one account\'s private data',
    ).toEqual(['job-legacy:legacy nightly'])
    expect(latestMissedTrigger(parsed.scheduler, NOW)?.name).toBe('legacy nightly')
    host.dispose()
  })

  it('drops a record whose job is gone instead of guessing its owner', async () => {
    const { host, ledger, setUser, skipOnce } = rig()
    skipOnce(ALICE_JOB, SECRET_NAME)
    // The job disappears (delete); the skip record stays in the ledger.
    ledger.applyRequest('delete-alice', { kind: 'delete', jobId: ALICE_JOB })
    setUser('bob')
    const state = await exits(host).state()
    expect(state).not.toContain(SECRET_NAME)
    expect(state).not.toContain(ALICE_JOB)
    host.dispose()
  })
})
