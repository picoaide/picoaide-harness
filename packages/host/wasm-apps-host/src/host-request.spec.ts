/**
 * 本机请求面（R1/R2）的行为判据。变异验证：把 `proof` 改成 `'bootstrap'`（去掉证明闸）
 * ⇒ "不带证明头 ⇒ 401" 必红；把 `verify` 的 TTL 比较去掉 ⇒ 过期用例必红。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  HOST_PROOF_HEADER,
  createHostProofAuthority,
  createHostRequestSurface,
  type SurfaceReply,
  type SurfaceRequest,
} from './host-request.ts'

/** 极简上下文替身（只用到 get/register）。 */
function fakeContext(services: Record<string, unknown>) {
  const routes: Array<{ kind: string, path: string, handler: (req: IncomingMessage, res: ServerResponse) => void }> = []
  const ctx = {
    get: (name: string) => services[name],
    webServer: services.webServer === undefined
      ? undefined
      : {
        port: 12_345,
        register: (route: { kind: string, path: string, handler: (req: IncomingMessage, res: ServerResponse) => void }) => {
          routes.push(route)
          return () => { routes.length = 0 }
        },
      },
  } as unknown as Context
  return { ctx, routes }
}

const PREFIX = '/api/pico/wasm-apps'

function request(pathname: string, method = 'POST', headers: Record<string, string> = {}): SurfaceRequest {
  return {
    method,
    pathname,
    query: new URLSearchParams(),
    headers,
    body: new Uint8Array(0),
  }
}

describe('host proof authority (R2: 请求头持有性令牌，不用 Cookie/Host/Origin/端口)', () => {
  it('issues short-lived tokens and rejects a missing / unknown header', () => {
    let instant = 1_000
    const authority = createHostProofAuthority({ ttlMs: 1_000, now: () => instant, randomToken: () => 't0ken' })
    expect(authority.verify({})).toEqual({ status: 401, code: 'proof_required' })
    expect(authority.verify({ [HOST_PROOF_HEADER]: 'nope' })).toEqual({ status: 401, code: 'proof_required' })
    const issued = authority.issue()
    expect(issued.expiresAt).toBe(1_000 + 1_000)
    expect(authority.verify({ [HOST_PROOF_HEADER]: issued.proof })).toBeNull()
    // 大小写不敏感（单测直接给大写头名；真实 node 已小写化，但未来传输不该假定）。
    expect(authority.verify({ 'X-Pico-Host-Proof': issued.proof })).toBeNull()
  })

  it('distinguishes expiry from a missing proof', () => {
    let instant = 5_000
    const authority = createHostProofAuthority({ ttlMs: 100, now: () => instant, randomToken: () => 'tok' })
    const issued = authority.issue()
    instant = 5_100
    expect(authority.verify({ [HOST_PROOF_HEADER]: issued.proof })).toEqual({ status: 401, code: 'proof_expired' })
  })

  it('keeps the pending set bounded (界内 LRU)', () => {
    const authority = createHostProofAuthority({ maxPending: 3, now: () => 0, randomToken: (() => {
      let n = 0
      return () => `t${String(++n)}`
    })() })
    for (let i = 0; i < 10; i += 1) authority.issue()
    expect(authority.size()).toBe(3)
    expect(authority.verify({ [HOST_PROOF_HEADER]: 't1' })).toEqual({ status: 401, code: 'proof_required' })
    expect(authority.verify({ [HOST_PROOF_HEADER]: 't10' })).toBeNull()
  })
})

describe('host request surface (seam)', () => {
  const route = (handler: (req: SurfaceRequest, reply: SurfaceReply) => void) => ({
    method: 'POST' as const,
    path: `${PREFIX}/open`,
    proof: 'required' as const,
    handler,
  })

  it('rejects a local call without the proof header (R2 判据)', async () => {
    const { ctx } = fakeContext({})
    const surface = createHostRequestSurface(ctx, { prefix: PREFIX, bodyLimit: 1024, routes: [route((_req, reply) => { reply.send(200, { ok: true }) })] })
    const denied = await surface.dispatch(request(`${PREFIX}/open`))
    expect(denied.status).toBe(401)
    expect(JSON.parse(Buffer.from(denied.body).toString())).toEqual({ error: 'proof_required' })
  })

  it('accepts a call carrying a freshly issued proof and dispatches to the handler', async () => {
    const { ctx } = fakeContext({})
    const handler = vi.fn((_req: SurfaceRequest, reply: SurfaceReply) => { reply.send(200, { ok: true }) })
    const surface = createHostRequestSurface(ctx, { prefix: PREFIX, bodyLimit: 1024, routes: [route(handler)] })
    const issued = surface.issueProof()
    const ok = await surface.dispatch(request(`${PREFIX}/open`, 'POST', { [HOST_PROOF_HEADER]: issued.proof }))
    expect(ok.status).toBe(200)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('404s an unknown path under the prefix (frozen semantics, never falls into a handler)', async () => {
    const { ctx } = fakeContext({})
    const handler = vi.fn()
    const surface = createHostRequestSurface(ctx, { prefix: PREFIX, bodyLimit: 1024, routes: [route(handler)] })
    const issued = surface.issueProof()
    const missing = await surface.dispatch(request(`${PREFIX}/nope`, 'POST', { [HOST_PROOF_HEADER]: issued.proof }))
    expect(missing.status).toBe(404)
    const wrongMethod = await surface.dispatch(request(`${PREFIX}/open`, 'GET', { [HOST_PROOF_HEADER]: issued.proof }))
    expect(wrongMethod.status).toBe(405)
    expect(handler).not.toHaveBeenCalled()
  })

  it('issues a bootstrap token over the proof route (and never over a write)', async () => {
    const { ctx } = fakeContext({})
    const surface = createHostRequestSurface(ctx, { prefix: PREFIX, bodyLimit: 1024, routes: [route(() => {})] })
    const issued = await surface.dispatch(request(surface.proofRoute, 'GET'))
    expect(issued.status).toBe(200)
    const body = JSON.parse(Buffer.from(issued.body).toString()) as { proof: string }
    expect(typeof body.proof).toBe('string')
    expect(surface.verify({ [HOST_PROOF_HEADER]: body.proof })).toBeNull()
    const viaPost = await surface.dispatch(request(surface.proofRoute, 'POST'))
    expect(viaPost.status).toBe(405)
  })

  it('fails the bootstrap closed when the connection fence rejects it', async () => {
    const { ctx } = fakeContext({ connection: { requestRejection: () => 403 } })
    const surface = createHostRequestSurface(ctx, { prefix: PREFIX, bodyLimit: 1024, routes: [route(() => {})] })
    const refused = await surface.dispatch(request(surface.proofRoute, 'GET'))
    expect(refused.status).toBe(403)
  })

  it('fails the bootstrap closed (503) when a loopback server exists but no fence does', async () => {
    const warn = vi.fn()
    const { ctx } = fakeContext({ webServer: {} })
    const surface = createHostRequestSurface(ctx, { prefix: PREFIX, bodyLimit: 1024, routes: [route(() => {})], warn })
    const refused = await surface.dispatch(request(surface.proofRoute, 'GET'))
    expect(refused.status).toBe(503)
    expect(warn).toHaveBeenCalled()
  })

  it('stays dispatch-only when no loopback server is available (zero-port ready, R1)', async () => {
    const warn = vi.fn()
    const { ctx, routes } = fakeContext({})
    const surface = createHostRequestSurface(ctx, { prefix: PREFIX, bodyLimit: 1024, routes: [route((_req, reply) => { reply.send(200, { ok: true }) })], warn })
    expect(routes).toHaveLength(0)
    const issued = surface.issueProof()
    const ok = await surface.dispatch(request(`${PREFIX}/open`, 'POST', { [HOST_PROOF_HEADER]: issued.proof }))
    expect(ok.status).toBe(200)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dispatch-only'))
  })

  it('registers exactly one prefix route on the loopback server (R1: 唯一 seam)', async () => {
    const { ctx, routes } = fakeContext({ webServer: {} })
    createHostRequestSurface(ctx, { prefix: PREFIX, bodyLimit: 1024, routes: [route(() => {})] })
    expect(routes).toHaveLength(1)
    expect(routes[0]?.kind).toBe('prefix')
    expect(routes[0]?.path).toBe(PREFIX)
  })

  it('turns a throwing handler into a 500 instead of leaking the exception', async () => {
    const warn = vi.fn()
    const { ctx } = fakeContext({})
    const surface = createHostRequestSurface(ctx, {
      prefix: PREFIX,
      bodyLimit: 1024,
      warn,
      routes: [route(() => { throw new Error('boom') })],
    })
    const issued = surface.issueProof()
    const failed = await surface.dispatch(request(`${PREFIX}/open`, 'POST', { [HOST_PROOF_HEADER]: issued.proof }))
    expect(failed.status).toBe(500)
    expect(warn).toHaveBeenCalled()
  })
})
