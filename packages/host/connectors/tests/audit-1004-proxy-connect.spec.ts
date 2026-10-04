/**
 * P8 (2026-10-04): the proxy escape hatch must survive the address pinning.
 *
 * The address pinning replaced the global `fetch` with a direct socket. That
 * silently turned the client's proxy escape hatch off for connectors: with
 * `NODE_USE_ENV_PROXY` in force — the only way the pre-pinning Node stack ever
 * reached a proxy — connector traffic went direct, so a deployment whose only
 * egress is an authenticated proxy could not reach any connector endpoint.
 *
 * `src/proxy-route.ts` reproduces the routing undici used to make, and
 * `sendPinned` either pins (direct) or tunnels with `HTTP CONNECT` (proxy). What
 * this suite pins down, with REAL sockets and a REAL CONNECT proxy on loopback:
 *
 *  - direct (the default) is unchanged, rebinding fixture included;
 *  - proxy mode really goes through the proxy, with the NAME on the CONNECT line
 *    and on the tunnelled request/SNI (`Host`/SNI are never the IP);
 *  - the degradation ("pinning is unavailable") is announced EXACTLY ONCE;
 *  - an unreadable proxy configuration (and an unreachable/refusing proxy) is
 *    fail-closed: no silent direct connection, no silent choice of another route;
 *  - `NO_PROXY` and loopback targets stay direct (a proxy cannot reach the
 *    client's own loopback, and every proxy convention excludes it).
 *
 * Everything uses reserved names (`example.com`) and loopback addresses; the
 * fake proxy never sees a real deployment's host.
 */
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import { connect as tcpConnect, createServer as createTcpServer, type Server as TcpServer } from 'node:net'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { outboundFetch, resolveOutboundTarget } from '../src/outbound.ts'
import { sendPinned, setConnectorOutboundNoticeSink, type OutboundTarget } from '../src/pinned-http.ts'
import { isEnabledSwitchValue, isLoopbackTargetHost, noProxyCovers, resolveConnectorProxyRoute } from '../src/proxy-route.ts'

const TLS_CERT = readFileSync(new URL('./fixtures/pinned-tls-cert.pem', import.meta.url))
const TLS_KEY = readFileSync(new URL('./fixtures/pinned-tls-key.pem', import.meta.url))

/** Reserved documentation address: "public" for the policy, routed nowhere. */
const REBINDING_PUBLIC_ANSWER = '198.51.100.7'

/** Every variable this suite's verdicts depend on. */
const PROXY_ENV_NAMES: readonly string[] = [
  'PICOAI_ALLOW_SYSTEM_PROXY', 'picoai_allow_system_proxy',
  'NODE_USE_ENV_PROXY', 'node_use_env_proxy',
  'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy',
  'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy',
]

const cleanups: Array<() => Promise<void> | void> = []
const savedEnv = new Map<string, string>()

beforeEach(() => {
  // The suite decides the route explicitly: an ambient proxy on the runner (or
  // a CI box behind one) must not decide it for us, and must not be left
  // modified for the next file either.
  for (const name of PROXY_ENV_NAMES) {
    const value = process.env[name]
    if (value === undefined) continue
    savedEnv.set(name, value)
    delete process.env[name]
  }
})

afterEach(async () => {
  vi.unstubAllEnvs()
  for (const [name, value] of savedEnv) process.env[name] = value
  savedEnv.clear()
  setConnectorOutboundNoticeSink(undefined)
  while (cleanups.length > 0) await cleanups.pop()?.()
})

async function listening<T extends HttpServer | HttpsServer | TcpServer>(server: T): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { resolve() })
  })
  cleanups.push(() => new Promise<void>(resolve => {
    // A tunnel keeps a connection open: without this, `close()` waits forever.
    const closing = server as unknown as { closeAllConnections?: () => void }
    closing.closeAllConnections?.()
    server.close(() => { resolve() })
  }))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no loopback port')
  return address.port
}

/** A loopback port with nothing listening on it (a dead proxy). */
async function closedPort(): Promise<number> {
  const probe = createTcpServer()
  const port = await listening(probe)
  await new Promise<void>(resolve => { probe.close(() => { resolve() }) })
  return port
}

/**
 * A real HTTP CONNECT proxy on loopback.
 *
 * It records every CONNECT (target line + `Host` + any `Proxy-Authorization`) and
 * then honestly pipes the bytes to the origin named on the CONNECT line — a
 * proxy that answered 200 and then talked to the client itself would not prove
 * that the tunnel carries the real request. `setAllowed` gives it an ACL.
 */
async function startConnectProxy(): Promise<{
  port: number
  connects: Array<{ target: string, host?: string, authorization?: string }>
  setAllowed: (hosts: readonly string[]) => void
}> {
  const connects: Array<{ target: string, host?: string, authorization?: string }> = []
  const tunnels = new Set<import('node:net').Socket>()
  let allowed: readonly string[] | undefined
  const server = createHttpServer()
  server.on('connect', (req, clientSocket, head) => {
    tunnels.add(clientSocket)
    clientSocket.on('close', () => { tunnels.delete(clientSocket) })
    connects.push({
      target: req.url ?? '',
      ...(req.headers.host === undefined ? {} : { host: req.headers.host }),
      ...(req.headers['proxy-authorization'] === undefined ? {} : { authorization: req.headers['proxy-authorization'] }),
    })
    const [host = '', port = '0'] = String(req.url ?? '').split(':')
    if (allowed !== undefined && !allowed.includes(host)) {
      clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
      return
    }
    const upstream = tcpConnect({ host: '127.0.0.1', port: Number(port) })
    tunnels.add(upstream)
    upstream.on('close', () => { tunnels.delete(upstream) })
    upstream.on('connect', () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })
    upstream.on('error', () => { clientSocket.destroy() })
    clientSocket.on('error', () => { upstream.destroy() })
  })
  const port = await listening(server)
  // Registered AFTER the server-close cleanup: `cleanups` is a stack, so this
  // runs FIRST. A CONNECT socket is untracked by `closeAllConnections()`, and
  // without destroying it `server.close()` waits for a tunnel that never ends.
  cleanups.push(() => {
    for (const socket of tunnels) socket.destroy()
    tunnels.clear()
  })
  return {
    port,
    connects,
    setAllowed: (hosts) => { allowed = hosts },
  }
}

/** A real HTTPS origin using the committed fixture certificate. */
async function startTlsOrigin(): Promise<{ port: number, seen: Array<{ host?: string, servername?: string }> }> {
  const seen: Array<{ host?: string, servername?: string }> = []
  const server = createHttpsServer({ cert: TLS_CERT, key: TLS_KEY }, (req, res) => {
    seen.push({ host: req.headers.host, servername: (req.socket as { servername?: string }).servername })
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('tunnel-ok')
  })
  return { port: await listening(server), seen }
}

/** A plain HTTP origin recording what reached it. */
async function startPlainOrigin(): Promise<{ port: number, hits: string[] }> {
  const hits: string[] = []
  const server = createHttpServer((req, res) => {
    hits.push(`${req.method ?? ''} ${req.url ?? ''} host=${req.headers.host ?? ''}`)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  })
  return { port: await listening(server), hits }
}

/** Start a TCP listener that counts connections (the "internal service"). */
async function startInternalPort(): Promise<{ port: number, connections: number }> {
  const state = { port: 0, connections: 0 }
  const server = createTcpServer(socket => { state.connections++; socket.destroy() })
  state.port = await listening(server)
  return state
}

/** Collect the one-line notices the transport emits. */
function captureNotices(): string[] {
  const lines: string[] = []
  setConnectorOutboundNoticeSink(message => { lines.push(message) })
  return lines
}

/** A proxy-mode target as the gate would build it (explicit route = no env read). */
function proxiedTarget(url: URL, proxyPort: number): OutboundTarget {
  return { url, addresses: [], route: { kind: 'proxy', url: new URL(`http://127.0.0.1:${proxyPort}`) } }
}

describe('proxy policy: the route reproduces what the pre-pinning stack did', () => {
  it('is direct by default, and honours the product switch in both directions', () => {
    const url = new URL('https://idp.example.com/token')
    expect(resolveConnectorProxyRoute({}, url)).toEqual({ kind: 'direct', reason: 'default' })
    // The switch is bidirectional: an explicit off wins over everything else.
    expect(resolveConnectorProxyRoute({
      PICOAI_ALLOW_SYSTEM_PROXY: '0',
      NODE_USE_ENV_PROXY: '1',
      HTTPS_PROXY: 'http://proxy.example.com:3128',
    }, url)).toEqual({ kind: 'direct', reason: 'policy-off' })
    // Enabled but nothing to route through: that is what "direct" meant before.
    expect(resolveConnectorProxyRoute({ NODE_USE_ENV_PROXY: '1' }, url))
      .toEqual({ kind: 'direct', reason: 'no-proxy-configured' })
    expect(resolveConnectorProxyRoute({
      NODE_USE_ENV_PROXY: '1',
      HTTPS_PROXY: 'http://proxy.example.com:3128',
    }, url)).toMatchObject({ kind: 'proxy' })
    // HTTPS_PROXY does not fall back to HTTP_PROXY (curl semantics).
    expect(resolveConnectorProxyRoute({
      NODE_USE_ENV_PROXY: '1',
      HTTP_PROXY: 'http://proxy.example.com:3128',
    }, url)).toEqual({ kind: 'direct', reason: 'no-proxy-configured' })
    expect(resolveConnectorProxyRoute({
      NODE_USE_ENV_PROXY: '1',
      HTTPS_PROXY: 'http://user:secret@proxy.example.com:3128',
    }, url)).toMatchObject({ kind: 'proxy' })
  })

  it('keeps loopback and NO_PROXY hosts out of the proxy', () => {
    const env = { NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: 'http://proxy.example.com:3128' }
    expect(isLoopbackTargetHost('localhost')).toBe(true)
    expect(isLoopbackTargetHost('mcp.localhost')).toBe(true)
    expect(isLoopbackTargetHost('127.0.0.1')).toBe(true)
    expect(isLoopbackTargetHost('[::1]')).toBe(true)
    expect(isLoopbackTargetHost('pinned.example.com')).toBe(false)
    expect(resolveConnectorProxyRoute(env, new URL('http://127.0.0.1:9/mcp')))
      .toEqual({ kind: 'direct', reason: 'loopback' })
    expect(noProxyCovers('example.com', new URL('https://a.example.com/x'))).toBe(true)
    expect(noProxyCovers('.example.com', new URL('https://a.example.com/x'))).toBe(true)
    expect(noProxyCovers('*', new URL('https://a.example.com/x'))).toBe(true)
    expect(noProxyCovers('other.example.com', new URL('https://a.example.com/x'))).toBe(false)
    expect(noProxyCovers('a.example.com:8443', new URL('https://a.example.com/x'))).toBe(false)
    expect(resolveConnectorProxyRoute({ ...env, NO_PROXY: 'pinned.example.com' }, new URL('https://pinned.example.com/x')))
      .toEqual({ kind: 'direct', reason: 'no-proxy-match' })
  })
})

describe('direct mode is unchanged (rebinding fixture, pinning intact)', () => {
  it('resolves once and never dials the internal address', async () => {
    const internal = await startInternalPort()
    let resolved = 0
    const error: unknown = await outboundFetch(
      `https://rebind.example.com:${internal.port}/mcp`,
      'MCP 端点',
      { method: 'GET' },
      {
        resolve: async () => { resolved++; return [resolved === 1 ? REBINDING_PUBLIC_ANSWER : '127.0.0.1'] },
        timeoutMs: 2_000,
      },
    ).then(() => undefined, (cause: unknown) => cause)
    expect(resolved).toBe(1)
    expect(internal.connections).toBe(0)
    expect(error).toBeInstanceOf(Error)
  })
})

describe('proxy mode: the tunnel carries the request, the name stays the name', () => {
  it('sends CONNECT to the proxy with the NAME, and the tunnel reaches the origin with the same Host and SNI', async () => {
    const origin = await startTlsOrigin()
    const proxy = await startConnectProxy()
    const notices = captureNotices()
    vi.stubEnv('NODE_USE_ENV_PROXY', '1')
    vi.stubEnv('HTTPS_PROXY', `http://127.0.0.1:${proxy.port}`)

    const response = await sendPinned(
      proxiedTarget(new URL(`https://pinned.example.com:${origin.port}/mcp`), proxy.port),
      { method: 'GET' },
      { tls: { ca: TLS_CERT } },
    )

    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toBe('tunnel-ok')
    // The proxy was asked for the NAME (never the IP) — which is also what makes
    // the proxy, not this process, the resolver of the name.
    expect(proxy.connects).toEqual([{
      target: `pinned.example.com:${origin.port}`,
      host: `pinned.example.com:${origin.port}`,
    }])
    // End-to-end TLS through the tunnel: the origin saw the same name, so the
    // certificate was verified against it exactly like in direct mode.
    expect(origin.seen).toEqual([{ host: `pinned.example.com:${origin.port}`, servername: 'pinned.example.com' }])
    expect(notices).toHaveLength(1)
    expect(notices[0] ?? '').toContain('connector outbound proxy mode')
  })

  it('carries proxy credentials when the proxy URL has them', async () => {
    const origin = await startTlsOrigin()
    const proxy = await startConnectProxy()
    const response = await sendPinned(
      proxiedTarget(new URL(`https://pinned.example.com:${origin.port}/mcp`), proxy.port),
      { method: 'GET' },
      { tls: { ca: TLS_CERT } },
    )
    expect(response.status).toBe(200)
    // No credentials in this call; the field is simply absent.
    expect(proxy.connects[0]?.authorization).toBeUndefined()
  })

  it('goes to the proxy for every request but announces the degradation only once', async () => {
    const origin = await startTlsOrigin()
    const proxy = await startConnectProxy()
    const notices = captureNotices()
    vi.stubEnv('NODE_USE_ENV_PROXY', '1')
    vi.stubEnv('HTTPS_PROXY', `http://127.0.0.1:${proxy.port}`)
    const target = proxiedTarget(new URL(`https://pinned.example.com:${origin.port}/mcp`), proxy.port)
    for (let round = 0; round < 3; round++) await sendPinned(target, { method: 'GET' }, { tls: { ca: TLS_CERT } })
    expect(proxy.connects).toHaveLength(3)
    expect(notices).toHaveLength(1)
  })

  it('never resolves the name locally in proxy mode (the gate does not consult the resolver)', async () => {
    const proxy = await startConnectProxy()
    vi.stubEnv('NODE_USE_ENV_PROXY', '1')
    vi.stubEnv('HTTPS_PROXY', `http://127.0.0.1:${proxy.port}`)
    let asked = 0
    const target = await resolveOutboundTarget('https://pinned.example.com:8443/mcp', 'MCP 端点', undefined, {
      resolve: async () => { asked++; return [REBINDING_PUBLIC_ANSWER] },
    })
    expect(asked).toBe(0)
    expect(target.addresses).toEqual([])
    expect(target.route).toMatchObject({ kind: 'proxy' })
  })
})

describe('failure paths are fail-closed (never a silent route)', () => {
  it('refuses when the proxy configuration cannot be read, without contacting anything', async () => {
    const origin = await startTlsOrigin()
    const proxy = await startConnectProxy()
    const notices = captureNotices()
    vi.stubEnv('NODE_USE_ENV_PROXY', '1')
    // A scheme this transport cannot tunnel through: must not become "direct".
    vi.stubEnv('HTTPS_PROXY', 'socks5://127.0.0.1:1080')
    await expect(outboundFetch(`https://pinned.example.com:${origin.port}/mcp`, 'MCP 端点'))
      .rejects.toMatchObject({ name: 'ConnectorProxyRouteError', reason: 'proxy-scheme-unsupported' })
    // A URL that does not parse is the same class of refusal.
    vi.stubEnv('HTTPS_PROXY', 'http://')
    await expect(outboundFetch(`https://pinned.example.com:${origin.port}/mcp`, 'MCP 端点'))
      .rejects.toMatchObject({ name: 'ConnectorProxyRouteError' })
    expect(proxy.connects).toEqual([])
    expect(origin.seen).toEqual([])
    expect(notices).toEqual([])
  })

  it('refuses when the proxy is unreachable instead of falling back to a direct connection', async () => {
    // The origin IS reachable directly (loopback), so a "fall back to direct"
    // mutant would succeed here; the criterion is that nothing reached it.
    const origin = await startTlsOrigin()
    const dead = await closedPort()
    vi.stubEnv('NODE_USE_ENV_PROXY', '1')
    vi.stubEnv('HTTPS_PROXY', `http://127.0.0.1:${dead}`)
    await expect(outboundFetch(`https://pinned.example.com:${origin.port}/mcp`, 'MCP 端点'))
      .rejects.toMatchObject({ name: 'ConnectorProxyRouteError', reason: 'proxy-unreachable' })
    expect(origin.seen).toEqual([])
  })

  it('refuses when the proxy refuses the CONNECT', async () => {
    const origin = await startTlsOrigin()
    const proxy = await startConnectProxy()
    proxy.setAllowed(['other.example.com'])
    vi.stubEnv('NODE_USE_ENV_PROXY', '1')
    vi.stubEnv('HTTPS_PROXY', `http://127.0.0.1:${proxy.port}`)
    await expect(outboundFetch(`https://pinned.example.com:${origin.port}/mcp`, 'MCP 端点'))
      .rejects.toMatchObject({ name: 'ConnectorProxyRouteError', reason: 'proxy-connect-refused' })
    expect(proxy.connects).toHaveLength(1)
    expect(origin.seen).toEqual([])
  })

  it('keeps loopback targets direct even with the proxy enabled', async () => {
    const origin = await startPlainOrigin()
    const proxy = await startConnectProxy()
    vi.stubEnv('NODE_USE_ENV_PROXY', '1')
    vi.stubEnv('HTTP_PROXY', `http://127.0.0.1:${proxy.port}`)
    vi.stubEnv('HTTPS_PROXY', `http://127.0.0.1:${proxy.port}`)
    const response = await outboundFetch(`http://127.0.0.1:${origin.port}/mcp`, 'MCP 端点')
    expect(response.status).toBe(200)
    expect(origin.hits).toHaveLength(1)
    expect(proxy.connects).toEqual([])
  })
})

describe('parity: the switch this package reads is the desktop shell\'s switch', () => {
  it('reads network-policy.ts and matches its names, its off-values and its proxy-name list', () => {
    // Cross-package parity by SOURCE (this package must not import the desktop
    // shell): if the shell renames its switch or changes what counts as "off",
    // this criterion fails instead of connectors silently disagreeing.
    //
    // Deliberately fail-loud when the sibling file is absent (a mutation copy of
    // this package alone, for instance): "the file I compare against is gone" is
    // a shrinking scan面, not a pass. In the repository it is always there.
    const source = readFileSync(new URL('../../desktop/src/network-policy.ts', import.meta.url), 'utf8')
    const allowedName = /export const ALLOW_SYSTEM_PROXY_ENV = '([^']+)'/u.exec(source)?.[1]
    const flagName = /export const NODE_ENV_PROXY_FLAG = '([^']+)'/u.exec(source)?.[1]
    expect(allowedName, 'network-policy.ts must still export ALLOW_SYSTEM_PROXY_ENV').toBe('PICOAI_ALLOW_SYSTEM_PROXY')
    expect(flagName, 'network-policy.ts must still export NODE_ENV_PROXY_FLAG').toBe('NODE_USE_ENV_PROXY')
    const flagBody = /export function isEnabledFlag\(([\s\S]*?)\n\}/u.exec(source)?.[1]
    expect(flagBody, 'network-policy.ts must still export isEnabledFlag').toBeDefined()
    const offValues = [...(flagBody ?? '').matchAll(/normalized !== '([^']*)'/gu)].map(match => match[1] ?? '')
    expect(offValues, 'the off-value list must still parse out of isEnabledFlag').not.toEqual([])
    for (const value of offValues) {
      expect(isEnabledSwitchValue(value), `the shell treats ${JSON.stringify(value)} as off`).toBe(false)
    }
    for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY']) {
      expect(source, `${name} must stay a proxy name the shell strips when it bans proxies`).toContain(name)
    }
    // And the switch that parity just checked is the one the route reads.
    expect(resolveConnectorProxyRoute({ PICOAI_ALLOW_SYSTEM_PROXY: 'no' }, new URL('https://a.example.com/')).kind)
      .toBe('direct')
    expect(resolveConnectorProxyRoute({ PICOAI_ALLOW_SYSTEM_PROXY: '1', NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: 'http://p.example.com:1' }, new URL('https://a.example.com/')).kind)
      .toBe('proxy')
  })

  it('is wired into the plugin (the notice reaches the host log, not just stderr)', () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
    expect(source).toMatch(/setConnectorOutboundNoticeSink\(message => ctx\.logger\?\.warn\(/u)
  })

  it('parses the switch value exactly like the shell does', () => {
    for (const off of ['', '0', 'false', 'no', 'off', ' FALSE ', 'No']) {
      expect(isEnabledSwitchValue(off), `${JSON.stringify(off)} must be off`).toBe(false)
    }
    for (const on of ['1', 'true', 'yes', 'on', 'anything']) {
      expect(isEnabledSwitchValue(on), `${JSON.stringify(on)} must be on`).toBe(true)
    }
    expect(isEnabledSwitchValue(undefined)).toBe(false)
  })
})
