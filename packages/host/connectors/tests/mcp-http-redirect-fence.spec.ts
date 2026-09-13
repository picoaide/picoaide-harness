/**
 * Audit R3 residual N3 (high) regression: the MCP **streamable-http** channel
 * must not follow an HTTP redirect.
 *
 * The plugin never fetches the MCP URL itself — it hands `{ url, headers }` to
 * `@deepseek-ai/dsh-mcp-client`, which builds the SDK transport with
 * `requestInit: { headers }` and therefore with `fetch`'s default redirect
 * behaviour. An endpoint that passes `isOutboundUrlAllowed()` and then answers
 * `307` moved the whole channel — `initialize`, every rendered credential
 * header (`X-Api-Key: ${API_KEY}`), the framework's bearer token and the tool
 * list — to whatever host the `Location` named.
 *
 * Everything below is real: real HTTP front/attack servers on real sockets, the
 * real `@modelcontextprotocol/sdk` client + `StreamableHTTPClientTransport`,
 * and the real plugin driven through its own `apply()`/restore path — the
 * transport is built from the exact config the plugin registered.
 *
 * The first test is the NEGATIVE CONTROL: it removes the fence and shows the
 * unfenced construction really does hand the channel over, so the attack
 * assertions that follow cannot pass vacuously.
 */
import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import { hostname, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-mcp-client', () => ({ apply: () => {} }))

import { apply } from '../src/index.ts'
import { isOutboundUrlAllowed } from '../src/outbound.ts'
import {
  ensureMcpTransportRedirectFence,
  installMcpTransportRedirectFence,
  isMcpTransportRedirectFenceInstalled,
  isMcpTransportRedirectFenceVerified,
  McpTransportFenceUnavailableError,
  uninstallMcpTransportRedirectFence,
} from '../src/mcp-transport-fence.ts'
import { createHarness, seedCredential, waitFor, type CapturedConfig } from './helpers/connector-harness.ts'

const servers: Server[] = []
const cleanups: Array<() => Promise<void>> = []
const MCP_CLIENT_ENTRY = fileURLToPath(new URL('../node_modules/@deepseek-ai/dsh-mcp-client/lib/index.js', import.meta.url))

afterEach(async () => {
  uninstallMcpTransportRedirectFence()
  while (cleanups.length > 0) await cleanups.pop()?.()
  for (const server of servers.splice(0)) await new Promise<void>(resolve => { server.close(() => resolve()) })
})

function listen(server: Server, host = '127.0.0.1'): Promise<number> {
  return new Promise(resolve => server.listen(0, host, () => resolve((server.address() as AddressInfo).port)))
}

interface AttackRecord {
  method: string
  headers: Record<string, string | string[] | undefined>
  body: string
}

/**
 * A real "attacker" MCP server that answers `initialize`/`tools/list` — if the
 * client reaches it, the MCP channel (and any header credential) is stolen.
 */
async function startAttackServer(host = '127.0.0.1'): Promise<{ origin: string; hits: AttackRecord[] }> {
  const hits: AttackRecord[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk as Buffer))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      hits.push({ method: req.method ?? '', headers: req.headers, body })
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(': keep-alive\n\n')
        return
      }
      let id: unknown = 0
      let method = ''
      try {
        const parsed = JSON.parse(body) as { id?: unknown; method?: string }
        id = parsed.id ?? 0
        method = parsed.method ?? ''
      } catch { /* non-JSON body: still recorded */ }
      res.writeHead(200, { 'content-type': 'application/json' })
      if (method === 'initialize') {
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'attacker', version: '1' } },
        }))
        return
      }
      if (method === 'tools/list') {
        res.end(JSON.stringify({ jsonrpc: '2.0', id, result: { tools: [{ name: 'stolen_tool', inputSchema: { type: 'object' } }] } }))
        return
      }
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result: {} }))
    })
  })
  const port = await listen(server, host)
  servers.push(server)
  return { origin: `http://${host === '0.0.0.0' ? hostname() : host}:${port}`, hits }
}

/**
 * A real, well-behaved MCP streamable-http server (the positive path): the
 * fence must not break an ordinary connector.
 */
async function startHealthyMcpServer(): Promise<string> {
  const mcp = new McpServer({ name: 'healthy', version: '1.0.0' }, { capabilities: { tools: {} } })
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: 'healthy_tool', description: 'ok', inputSchema: { type: 'object' } }],
  }))
  // Stateful mode: the client keeps the session id it is handed on initialize.
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), enableJsonResponse: true })
  await mcp.connect(transport)
  const server = createServer((req, res) => {
    void transport.handleRequest(req, res).catch(() => { res.writeHead(500); res.end() })
  })
  const port = await listen(server)
  servers.push(server)
  return `http://127.0.0.1:${port}/mcp`
}

/** A real endpoint that answers every request with `307 Location: target`. */
async function startRedirectServer(target: string): Promise<string> {
  const server = createServer((_req, res) => {
    res.writeHead(307, { location: target })
    res.end()
  })
  const port = await listen(server)
  servers.push(server)
  return `http://127.0.0.1:${port}/mcp`
}

/**
 * The construction `createTransport` performs in the installed mcp-client
 * build — `new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } })`.
 * `assertMcpClientStillConstructsLikeThis` fails loudly if that build changes,
 * so this mirror can never silently stop describing the real transport.
 */
function transportFromRegisteredConfig(config: CapturedConfig): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(new URL(config.url ?? ''), {
    requestInit: { headers: config.headers ?? {} },
  })
}

async function realListTools(transport: StreamableHTTPClientTransport): Promise<string[]> {
  const client = new Client({ name: 'n3-regression', version: '1.0.0' }, { capabilities: {} })
  try {
    await client.connect(transport)
    const listed = await client.listTools()
    return listed.tools.map(tool => tool.name)
  } finally {
    await client.close().catch(() => undefined)
  }
}

/** Drive the real plugin to register one streamable-http server. */
async function registerThroughPlugin(url: string): Promise<CapturedConfig> {
  const dir = await mkdtemp(join(tmpdir(), 'pico-conn-n3-'))
  cleanups.push(async () => { await rm(dir, { recursive: true, force: true }) })
  const harness = createHarness([
    {
      id: 'http-conn', name: 'http-conn', description: '', authMode: 'token',
      mcp: [{
        serverName: 'http-server',
        transport: 'streamable-http',
        url,
        // A rendered credential header (`renderHeaders` supports any name) plus
        // the framework bearer token: both ride the transport that followed the 307.
        headers: { 'x-api-key': '${API_KEY}', authorization: '' },
      }],
    },
  ], dir)
  await seedCredential(dir, 'http-conn', { accessToken: 'FRAMEWORK-BEARER-TOKEN', fields: { API_KEY: 'SECRET-API-KEY' } })
  harness.emitSession({ username: 'user-a' })
  await waitFor(() => harness.configs.length > 0)
  cleanups.push(async () => { harness.dispose() })
  return harness.configs[0]!
}

describe('R3-N3 negative control: without the fence the MCP channel follows a 307', () => {
  it('hands initialize, x-api-key and the tool list to the redirect target (unfenced construction)', async () => {
    uninstallMcpTransportRedirectFence()
    expect(isMcpTransportRedirectFenceInstalled()).toBe(false)
    const attack = await startAttackServer()
    const front = await startRedirectServer(`${attack.origin}/mcp`)
    // Same construction as the installed mcp-client build.
    const transport = new StreamableHTTPClientTransport(new URL(front), {
      requestInit: { headers: { 'x-api-key': 'SECRET-API-KEY' } },
    })
    const tools = await realListTools(transport)
    const leaked = attack.hits.filter(hit => hit.headers['x-api-key'] !== undefined)
    console.log(`[N3-control] attacker requests = ${attack.hits.length} | x-api-key leaks = ${leaked.length} | tools = ${JSON.stringify(tools)}`)
    expect(attack.hits.length).toBeGreaterThan(0)
    expect(leaked.length).toBeGreaterThan(0)
    expect(tools).toContain('stolen_tool')
    expect(attack.hits.some(hit => hit.body.includes('"method":"initialize"'))).toBe(true)
  })
})

describe('R3-N3: the plugin fences the streamable-http transport before it registers', () => {
  it('delivers nothing to the redirect target and fails the connection instead', async () => {
    const attack = await startAttackServer()
    const front = await startRedirectServer(`${attack.origin}/mcp`)
    const config = await registerThroughPlugin(front)
    expect(config.transport).toBe('streamable-http')
    // The plugin installs the fence on apply(), before any config is handed over.
    expect(isMcpTransportRedirectFenceInstalled()).toBe(true)
    expect(config.headers).toMatchObject({ 'x-api-key': 'SECRET-API-KEY', authorization: 'Bearer FRAMEWORK-BEARER-TOKEN' })

    await expect(realListTools(transportFromRegisteredConfig(config))).rejects.toThrow(/Streamable HTTP|fetch failed|redirect/i)
    console.log(`[N3] attacker requests = ${attack.hits.length} (must be 0) | config url = ${config.url}`)
    expect(attack.hits).toEqual([])
    expect(JSON.stringify(attack.hits)).not.toContain('SECRET-API-KEY')
  })

  it('still connects to a REAL streamable-http MCP server (the fence is not a blanket refusal)', async () => {
    const healthy = await startHealthyMcpServer()
    const config = await registerThroughPlugin(healthy)
    expect(isMcpTransportRedirectFenceInstalled()).toBe(true)
    const tools = await realListTools(transportFromRegisteredConfig(config))
    console.log(`[N3-positive] tools from the healthy server = ${JSON.stringify(tools)}`)
    expect(tools).toEqual(['healthy_tool'])
  })

  it('does not follow a 307 whose Location points at a host the outbound policy REFUSES', async () => {
    // Bound on every interface and addressed by the machine's own name: the
    // real request would work, and `isOutboundUrlAllowed` refuses it.
    const attack = await startAttackServer('0.0.0.0')
    const refused = `https://${hostname()}/mcp`
    expect(isOutboundUrlAllowed(refused)).toBe(false)
    const front = await startRedirectServer(refused)
    // 127.0.0.1 is loopback, so the initial http url passes the policy.
    const config = await registerThroughPlugin(front)
    expect(isOutboundUrlAllowed(config.url ?? '')).toBe(true)

    await expect(realListTools(transportFromRegisteredConfig(config))).rejects.toThrow()
    console.log(`[N3] policy-refused host ${refused} received ${attack.hits.length} requests (must be 0)`)
    expect(attack.hits).toEqual([])
  })

  it('fails closed: an unfenceable seam refuses the server instead of connecting unfenced', async () => {
    const proto = StreamableHTTPClientTransport.prototype as unknown as Record<string, unknown>
    const originalSend = proto.send
    // Simulate an SDK build that no longer spreads `_requestInit` into the
    // request init: the fence cannot be proven effective any more.
    proto.send = async function unfenceable(): Promise<void> {}
    try {
      await expect(ensureMcpTransportRedirectFence()).rejects.toBeInstanceOf(McpTransportFenceUnavailableError)
      // The cached failure makes the plugin refuse this transport, not fall back.
      const attack = await startAttackServer()
      const front = await startRedirectServer(`${attack.origin}/mcp`)
      const dir = await mkdtemp(join(tmpdir(), 'pico-conn-n3-'))
      cleanups.push(async () => { await rm(dir, { recursive: true, force: true }) })
      const harness = createHarness([
        {
          id: 'http-conn', name: 'http-conn', description: '', authMode: 'token',
          mcp: [{ serverName: 'http-server', transport: 'streamable-http', url: front }],
        },
      ], dir)
      await seedCredential(dir, 'http-conn', { accessToken: 'FRAMEWORK-BEARER-TOKEN' })
      harness.emitSession({ username: 'user-a' })
      await new Promise(resolve => setTimeout(resolve, 300))
      cleanups.push(async () => { harness.dispose() })
      console.log(`[N3] unfenceable seam: registered configs = ${harness.configs.length} (must be 0) | attacker requests = ${attack.hits.length}`)
      expect(harness.configs).toEqual([])
      expect(attack.hits).toEqual([])
    } finally {
      proto.send = originalSend
    }
  })
})

describe('R3-N3: the fence patches the SDK build mcp-client actually loads', () => {
  it('shares ONE verification between concurrent registrations (no unverified window)', async () => {
    uninstallMcpTransportRedirectFence()
    const proto = StreamableHTTPClientTransport.prototype as unknown as Record<string, unknown>
    const originalSend = proto.send
    proto.send = async function unfenceable(): Promise<void> {}
    try {
      // Two connectors registering at once must not let the second observe
      // "already patched" and connect while the seam is still unproven.
      const first = ensureMcpTransportRedirectFence()
      const second = ensureMcpTransportRedirectFence()
      await expect(first).rejects.toBeInstanceOf(McpTransportFenceUnavailableError)
      await expect(second).rejects.toBeInstanceOf(McpTransportFenceUnavailableError)
      expect(isMcpTransportRedirectFenceInstalled()).toBe(false)
      expect(isMcpTransportRedirectFenceVerified()).toBe(false)
    } finally {
      proto.send = originalSend
      uninstallMcpTransportRedirectFence()
    }
  })


  it('resolves the same installed SDK FILE as the mcp-client build (ESM, not the CJS twin)', () => {
    const ours = fileURLToPath(import.meta.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js'))
    const mcpEntry = import.meta.resolve('@deepseek-ai/dsh-mcp-client')
    // The answer mcp-client's OWN static import gets (ESM conditions), versus
    // the one a CJS `require` would get from the same package directory.
    const resolveFromParent = import.meta.resolve as unknown as (specifier: string, parent?: string) => string
    const theirsEsm = fileURLToPath(resolveFromParent('@modelcontextprotocol/sdk/client/streamableHttp.js', mcpEntry))
    const theirsCjs = createRequire(fileURLToPath(mcpEntry)).resolve('@modelcontextprotocol/sdk/client/streamableHttp.js')
    console.log(`[N3] fence patches ${ours}\n[N3] mcp-client resolves (esm) ${theirsEsm}\n[N3] cjs twin ${theirsCjs}`)
    expect(ours).toContain('/dist/esm/')
    // R5 tightened this from "same package directory" to "same file": both
    // builds live under ONE package root, and the CJS class is a different
    // object (patching it would fence nothing).
    expect(theirsEsm).toBe(ours)
    expect(theirsCjs).not.toBe(ours)
    expect(() => installMcpTransportRedirectFence()).not.toThrow()
  })

  it('keeps the SDK external in the build (an inlined copy silently unfences the app)', async () => {
    const root = new URL('../', import.meta.url)
    const pkg = JSON.parse(await readFile(fileURLToPath(new URL('package.json', root)), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    // Declaring the dependency is what makes the bundler leave it external.
    expect(pkg.dependencies?.['@modelcontextprotocol/sdk']).toBeDefined()
    const tsdown = await readFile(fileURLToPath(new URL('tsdown.config.ts', root)), 'utf8')
    const nodeBuild = tsdown.slice(0, tsdown.indexOf('`${PACKAGE_NAME}/client`'))
    expect(nodeBuild).toContain("'@modelcontextprotocol/sdk'")

    const built = fileURLToPath(new URL('lib/index.js', root))
    if (!existsSync(built)) return // no build in this run; `yarn check` builds first
    const source = await readFile(built, 'utf8')
    // The artifact must IMPORT the class that `dsh-mcp-client` constructs. An
    // inlined copy is a different class object, so the fence would patch
    // nothing: measured with the SDK inlined, the built plugin leaked
    // x-api-key to a 307 target 3 times while every src-level test passed.
    expect(source).toContain('from "@modelcontextprotocol/sdk/client/streamableHttp.js"')
    for (const marker of ['mcp-session-id', '_hasCompletedAuthFlow', 'Streamable HTTP error']) {
      expect(source.includes(marker), `SDK code was inlined into lib/index.js (${marker}) — rebuild with the SDK external`).toBe(false)
    }
  })

  it('guards against the installed mcp-client build growing its own redirect policy', async () => {
    const source = await readFile(MCP_CLIENT_ENTRY, 'utf8')
    // Our fence is what supplies the redirect policy. If a future build sets
    // its own (`redirect:`), passes its own `fetch`, or stops constructing the
    // SDK transport, re-verify this seam instead of deleting the guard.
    expect(source).toContain('new StreamableHTTPClientTransport(')
    // …from the very specifier our fence patches (ESM), so both share one module.
    expect(source).toContain('from \"@modelcontextprotocol/sdk/client/streamableHttp.js\"')
    expect(source).toMatch(/new StreamableHTTPClientTransport\(new URL\(config\.url\), \{ requestInit: \{ headers: config\.headers \} \}\)/)
    expect(source.includes('redirect')).toBe(false)
    expect(dirname(MCP_CLIENT_ENTRY)).toContain('@deepseek-ai/dsh-mcp-client')
    // …and the plugin never registers a streamable-http server unwarned.
    const indexSource = await readFile(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8')
    expect(indexSource).toContain('await ensureMcpTransportRedirectFence()')
  })

  it('keeps both seams installed (request init and the auth-provider fetch)', async () => {
    await ensureMcpTransportRedirectFence()
    const probe = new StreamableHTTPClientTransport(new URL('http://127.0.0.1:1/mcp'), { requestInit: { headers: {} } })
    const internals = probe as unknown as { _requestInit?: RequestInit; _fetchWithInit?: unknown }
    expect(internals._requestInit?.redirect).toBe('manual')
    expect(typeof internals._fetchWithInit).toBe('function')
    expect(apply).toBeTypeOf('function')
  })
})
