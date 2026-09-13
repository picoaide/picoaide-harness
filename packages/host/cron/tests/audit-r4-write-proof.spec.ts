/**
 * R4-RV3a 回归（第四轮收尾）：R7-RV-3 家族收口 —— cron 写面的持有性证明。
 *
 * 缺陷面（`packages/host/cron/src/host-routes.ts` 的 `POST /api/cron/action`）此前
 * 只有 `guard()`（`browserSameOriginMarker && isLoopbackRequest`），而
 * `loopback.ts` 自述其边界就是"伪造 Origin 的 curl 也能过"：本机任意进程伪造
 * `Host`/`Origin`/`Sec-Fetch-Site` 即可
 *
 *   - `create` 一个 `* * * * *` 任务并落盘 `cron/ledger.json`（跨重启生效）；
 *   - `run` 立即执行一次（`executions[]` 落账）；
 *   - `delete`/`disable` 抹掉用户自己的定时任务。
 *
 * 修法与 browser/connectors 第三轮的 `proofOfPossession` / `requireWriteProof`
 * 同形：写面经 `connection.requestRejection()` 要一份 BrowserAuth cookie；
 * fence 缺席 ⇒ fail-closed 503；读面 `state`/`events` 维持 `guard()`。
 *
 * 本文件用**真实 HostCronService + 真实 HostCronLedger**（临时 DSH_HOME）驱动真实
 * 路由，fence 替身与上游 `rpc-host.ts:97-100` 同判据（Host/Origin 围栏 → 403，
 * authority 绑定的 cookie 验签 → 401）。断言的是"写动作没有发生"（ledger 未落盘 /
 * 任务未被改动），不只是状态码。
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HostCronLedger } from '../src/host-ledger.ts'
import { makeCronRoutes, type CronRouteOptions } from '../src/host-routes.ts'
import { HostCronService } from '../src/host-service.ts'
import { CRON_API_PREFIX } from '../src/protocol.ts'
import type { ConnectionTrustFence } from '../src/write-proof.ts'

const AUTHORITY = '127.0.0.1:3080'
const REAL_COOKIE = `dsh-auth-${AUTHORITY}=v1.signature`

interface FenceDouble extends ConnectionTrustFence {
  seen: number
}

/**
 * 上游 `connection.requestRejection()` 的行为替身（`rpc-host.ts:97-100`）：
 * Host/Origin 围栏不通过 ⇒ 403；围栏通过但拿不出本 authority 的验签 cookie ⇒ 401。
 * cookie 名由 Host 派生（`dsh-auth-<authority>`），因此别的端口/别的拼写签发的
 * cookie 都不是证明。
 */
function browserFence(): FenceDouble {
  const fence = {
    seen: 0,
    requestRejection: (request: { headers: IncomingMessage['headers'] }): 401 | 403 | undefined => {
      fence.seen += 1
      const headers = request.headers as Record<string, unknown>
      const host = headers['host']
      if (typeof host !== 'string' || !/^(?:127\.0\.0\.1|localhost):3080$/.test(host)) return 403
      if (headers['sec-fetch-site'] === 'cross-site') return 403
      const origin = headers['origin']
      if (typeof origin === 'string' && new URL(origin).host !== host) return 403
      return headers['cookie'] === `dsh-auth-${host}=v1.signature` ? undefined : 401
    },
  }
  return fence as FenceDouble
}

interface RequestOptions {
  body?: string
  /** 缺省 = 不带 cookie（本机任意进程伪造头的原始形态）。 */
  cookie?: string
  host?: string
  /** `null` = 不带 Origin（伪造者最省事的一种写法）。 */
  origin?: string | null
  /** `null` = 不带 Sec-Fetch-Site。 */
  secFetchSite?: string | null
}

function fakeRequest(method: string, path: string, options: RequestOptions = {}): IncomingMessage {
  const host = options.host ?? AUTHORITY
  const headers: Record<string, string> = { host, 'content-type': 'application/json' }
  const origin = options.origin === undefined ? `http://${host}` : options.origin
  if (origin !== null) headers['origin'] = origin
  const site = options.secFetchSite === undefined ? 'same-origin' : options.secFetchSite
  if (site !== null) headers['sec-fetch-site'] = site
  if (options.cookie !== undefined && options.cookie !== '') headers['cookie'] = options.cookie
  const chunks = options.body === undefined ? [] : [Buffer.from(options.body)]
  return {
    method,
    url: path,
    headers,
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

let home = ''
let host: HostCronService
let fence: FenceDouble
let routes: ReturnType<typeof makeCronRoutes>

function boot(options: { fence?: FenceDouble | false } = {}): void {
  fence = browserFence()
  host = new HostCronService({} as never, {
    ledger: new HostCronLedger({ dshHomeDir: home, now: () => 1_800_000_000_000 }),
    now: () => 1_800_000_000_000,
  })
  host.setUsername('user-a')
  const routeOptions: CronRouteOptions = {
    permissions: () => ['agent'],
    fence: () => (options.fence === false ? undefined : (options.fence ?? fence)),
  }
  routes = makeCronRoutes(host, routeOptions)
}

function handlerFor(path: string): (req: IncomingMessage, res: ServerResponse) => void | Promise<void> {
  const route = routes.find(candidate => candidate.path === path)
  if (route === undefined) throw new Error(`no route for ${path}`)
  return route.handler
}

async function call(method: string, path: string, options: RequestOptions = {}): Promise<{ code: number; body: string }> {
  const out = fakeResponse()
  await handlerFor(path)(fakeRequest(method, path, options), out.res)
  await new Promise(resolve => setTimeout(resolve, 0))
  return out.read()
}

function envelope(requestId: string, action: unknown): string {
  return JSON.stringify({ requestId, action })
}

const CREATE_EVIL = envelope('attacker-create', {
  kind: 'create',
  id: 'evil-job',
  input: { name: 'evil', cron: '* * * * *', action: { kind: 'agent', prompt: 'run something privileged' }, enabled: true },
})

/** 每条写动作一个代表形态：伪造头必须全部打不动。 */
const FORGED_WRITES: Array<{ label: string; action: string }> = [
  { label: 'create', action: CREATE_EVIL },
  { label: 'run', action: envelope('attacker-run', { kind: 'run', jobId: 'seed-job' }) },
  { label: 'rerun', action: envelope('attacker-rerun', { kind: 'rerun', jobId: 'seed-job' }) },
  { label: 'enable', action: envelope('attacker-enable', { kind: 'enable', jobId: 'seed-job' }) },
  { label: 'disable', action: envelope('attacker-disable', { kind: 'disable', jobId: 'seed-job' }) },
  { label: 'update', action: envelope('attacker-update', { kind: 'update', jobId: 'seed-job', patch: { name: 'hijacked' } }) },
  { label: 'delete', action: envelope('attacker-delete', { kind: 'delete', jobId: 'seed-job' }) },
]

function seedJob(): void {
  host.apply('seed', {
    kind: 'create',
    id: 'seed-job',
    input: { name: 'seed', cron: '0 9 * * *', action: { kind: 'agent', prompt: 'hello' }, enabled: true },
  })
}

/** 轮询 ledger 落盘：伪造请求必须一个新 id 都不出现。 */
async function ledgerContains(id: string): Promise<boolean> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const dir = join(home, 'cron')
    const files = readdirSync(dir).filter(name => name.endsWith('.json'))
    if (files.some(name => readFileSync(join(dir, name), 'utf8').includes(id))) return true
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return false
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'pico-cron-proof-'))
  mkdirSync(join(home, 'cron'), { recursive: true })
  boot()
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('R4-RV3a cron:写动作要求持有性证明', () => {
  it('forged local writes without the browser proof are refused and never reach the ledger', async () => {
    seedJob()
    const before = JSON.stringify(host.snapshot().jobs)

    for (const write of FORGED_WRITES) {
      const out = await call('POST', `${CRON_API_PREFIX}/action`, { body: write.action })
      expect(out.code, `${write.label} must be refused without browser proof`).toBe(403)
      expect(JSON.parse(out.body)).toMatchObject({ ok: false, error: 'browser session proof required' })
    }

    // 真实副作用为零：任务列表逐字节未变，攻击者任务从未落盘。
    expect(JSON.stringify(host.snapshot().jobs)).toBe(before)
    expect(await ledgerContains('evil-job')).toBe(false)
    expect(fence.seen).toBeGreaterThanOrEqual(FORGED_WRITES.length)
  })

  it('the same actions pass once the page holds the BrowserAuth cookie (no friendly fire)', async () => {
    const create = await call('POST', `${CRON_API_PREFIX}/action`, {
      body: envelope('panel-create', {
        kind: 'create',
        id: 'panel-job',
        input: { name: 'panel', cron: '0 9 * * *', action: { kind: 'agent', prompt: 'hello' }, enabled: true },
      }),
      cookie: REAL_COOKIE,
    })
    expect(create.code).toBe(200)
    expect(host.snapshot().jobs.map(job => job.id)).toContain('panel-job')
    expect(await ledgerContains('panel-job')).toBe(true)

    const run = await call('POST', `${CRON_API_PREFIX}/action`, {
      body: envelope('panel-run', { kind: 'run', jobId: 'panel-job' }),
      cookie: REAL_COOKIE,
    })
    expect(run.code).toBe(200)
    expect(host.snapshot().jobs.find(job => job.id === 'panel-job')?.executions.length).toBeGreaterThan(0)

    const disable = await call('POST', `${CRON_API_PREFIX}/action`, {
      body: envelope('panel-disable', { kind: 'disable', jobId: 'panel-job' }),
      cookie: REAL_COOKIE,
    })
    expect(disable.code).toBe(200)
    expect(host.snapshot().jobs.find(job => job.id === 'panel-job')?.enabled).toBe(false)

    const remove = await call('POST', `${CRON_API_PREFIX}/action`, {
      body: envelope('panel-delete', { kind: 'delete', jobId: 'panel-job' }),
      cookie: REAL_COOKIE,
    })
    expect(remove.code).toBe(200)
    expect(host.snapshot().jobs.map(job => job.id)).not.toContain('panel-job')
  })

  it('read routes keep the guard-only contract (state and events stay readable for the panel)', async () => {
    const state = await call('GET', `${CRON_API_PREFIX}/state`)
    expect(state.code).toBe(200)
    expect(JSON.parse(state.body).schemaVersion).toBe(2)

    const events = await call('GET', `${CRON_API_PREFIX}/events`)
    expect(events.code).toBe(200)
    expect(events.body).toContain('data:')

    // 跨站伪造仍然被 guard 拦下（与证明无关的既有围栏不得退化）。
    const crossSite = await call('GET', `${CRON_API_PREFIX}/state`, {
      host: 'attacker.example',
      origin: 'https://attacker.example',
      secFetchSite: 'cross-site',
    })
    expect(crossSite.code).toBe(403)
  })

  it('fails closed when the connection service is absent (no proof mechanism, no write)', async () => {
    host.dispose()
    boot({ fence: false })
    const out = await call('POST', `${CRON_API_PREFIX}/action`, { body: CREATE_EVIL, cookie: REAL_COOKIE })
    expect(out.code).toBe(503)
    expect(JSON.parse(out.body)).toMatchObject({ ok: false, error: 'browser session proof unavailable' })
    expect(host.snapshot().jobs).toHaveLength(0)
  })
})

describe('R4-RV3a cron:等价伪造形态（同族绕过面）', () => {
  it('refuses a request that omits Origin entirely', async () => {
    const out = await call('POST', `${CRON_API_PREFIX}/action`, { body: CREATE_EVIL, origin: null })
    expect(out.code).toBe(403)
    expect(host.snapshot().jobs).toHaveLength(0)
  })

  it('refuses the localhost spelling that carries a cookie signed for 127.0.0.1', async () => {
    const out = await call('POST', `${CRON_API_PREFIX}/action`, {
      body: CREATE_EVIL,
      host: 'localhost:3080',
      origin: 'http://localhost:3080',
      cookie: REAL_COOKIE,
    })
    expect(out.code).toBe(403)
    expect(host.snapshot().jobs).toHaveLength(0)
  })

  it('refuses cookies signed for another port and cookies with a forged signature', async () => {
    const otherPort = await call('POST', `${CRON_API_PREFIX}/action`, {
      body: CREATE_EVIL,
      cookie: 'dsh-auth-127.0.0.1:9999=v1.signature',
    })
    expect(otherPort.code).toBe(403)

    const forgedSignature = await call('POST', `${CRON_API_PREFIX}/action`, {
      body: CREATE_EVIL,
      cookie: `dsh-auth-${AUTHORITY}=v1.forged`,
    })
    expect(forgedSignature.code).toBe(403)

    const empty = await call('POST', `${CRON_API_PREFIX}/action`, { body: CREATE_EVIL, cookie: '' })
    expect(empty.code).toBe(403)

    expect(host.snapshot().jobs).toHaveLength(0)
  })

  it('does not let a non-POST verb through the write route', async () => {
    for (const method of ['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE']) {
      const out = await call(method, `${CRON_API_PREFIX}/action`, { body: CREATE_EVIL })
      expect([403, 405], `${method} must not write`).toContain(out.code)
    }
    expect(host.snapshot().jobs).toHaveLength(0)
  })

  it('keeps the guard tripwire for cookie-less reads of a forged cross-site caller', async () => {
    const out = await call('GET', `${CRON_API_PREFIX}/events`, {
      host: 'attacker.example',
      origin: null,
      secFetchSite: null,
      cookie: REAL_COOKIE,
    })
    expect(out.code).toBe(403)
  })

  it('never lets a caller rewrite the ledger file the proof gate protects', async () => {
    // 攻击者先写一个诱饵文件也没有用：伪造的 delete 打不动已有任务。
    seedJob()
    writeFileSync(join(home, 'cron', 'attacker-note.json'), '{"note":"not a job"}', 'utf8')
    const out = await call('POST', `${CRON_API_PREFIX}/action`, {
      body: envelope('attacker-delete', { kind: 'delete', jobId: 'seed-job' }),
    })
    expect(out.code).toBe(403)
    expect(host.snapshot().jobs.map(job => job.id)).toEqual(['seed-job'])
  })
})
