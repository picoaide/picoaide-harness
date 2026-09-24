/**
 * R10 N3 regression — `${FIELD}` must resolve against the credential's OWN
 * fields, never through the prototype chain.
 *
 * The audit (V3 `v3-proto-field.spec.ts`) recorded the pre-fix wire facts on a
 * real MCP endpoint:
 *
 * ```
 * ${constructor}      wire="function Object() { [native code] }"
 * ${toString}         wire="function toString() { [native code] }"
 * ${valueOf}          wire="Bearer function valueOf() { [native code] }"
 * ```
 *
 * A mistyped field name is the most common source of these declarations, and the
 * prototype lookup made it a **non-empty** value: `carriesCredential` said "this
 * declaration has a credential", so it replaced the provider's live bearer and
 * shipped a piece of JavaScript runtime internals to the endpoint. Not a secret
 * leak — but "misconfigured, yet quietly online with a wrong value", the exact
 * family R10-B-05 closed for header NAMES.
 *
 * The judge here is the raw header record of a REAL `/mcp` request (the fake
 * server captures every request's headers) reached through the REAL pinned SDK
 * transport and the plugin's own registration — nothing asserts an assignment
 * this test wrote itself.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-mcp-client', () => ({ apply: () => {} }))

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { callRoute, createHarness, seedCredential, waitFor } from './helpers/connector-harness.ts'
import { completeAuthorization, startRealMcpServer, type RealMcpServer } from './helpers/real-mcp-oauth-server.ts'
import type { ConnectorDef } from '../src/types.ts'

const servers: RealMcpServer[] = []
afterEach(async () => { while (servers.length) await servers.pop()?.close() })

/** The declared header; `Authorization` is deliberately NOT used (it has its own rules). */
const PROBE_HEADER = 'x-probe-key'

function def(origin: string, declared: string): ConnectorDef {
  return {
    id: 'probe-mcp',
    name: 'Probe MCP',
    description: 'r10 n3',
    authMode: 'oauth',
    auth: {
      authorizeUrl: `${origin}/oauth/authorize`,
      tokenUrl: `${origin}/oauth/token`,
      clientId: '',
      redirectUri: 'http://127.0.0.1/callback',
      pkce: true,
      publicClient: true,
      discoveryUrl: `${origin}/mcp`,
      scopes: 'mcp.read offline_access',
    },
    tokenFields: [{ key: 'API_KEY', label: 'API key', type: 'password' }],
    mcp: [{ serverName: 'probe-a', transport: 'streamable-http', url: `${origin}/mcp`, headers: { 'X-Probe-Key': declared } }],
  }
}

async function connectAndAuthorize(h: ReturnType<typeof createHarness>): Promise<Record<string, unknown>> {
  await callRoute(h, '/api/pico/connectors/probe-mcp/connect', 'POST')
  const deadline = Date.now() + 8000
  let url: string | undefined
  while (Date.now() < deadline) {
    const res = await callRoute(h, '/api/pico/connectors/probe-mcp/state', 'GET')
    url = (JSON.parse(res.body) as { request?: { authorizeUrl?: string } }).request?.authorizeUrl
    if (url) break
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  if (url === undefined) throw new Error('no authorize URL')
  await completeAuthorization(url)
  await waitFor(() => h.configs.length === 1, 10_000)
  return h.configs[0] as unknown as Record<string, unknown>
}

/** The construction the installed `dsh-mcp-client` performs (see the bridge). */
function productionTransport(config: Record<string, unknown>): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(new URL(String(config.url ?? '')), {
    requestInit: { headers: { ...((config.headers ?? {}) as Record<string, string>) } },
    ...(config.authProvider === undefined ? {} : { authProvider: config.authProvider as never }),
  })
}

/** Every value of one header slot, across every `/mcp` request the server saw. */
function wireValues(server: RealMcpServer, name: string): string[] {
  const values: string[] = []
  for (const record of server.stats.mcpHeaders) {
    for (const [key, value] of Object.entries(record)) {
      if (key.toLowerCase() !== name) continue
      for (const item of Array.isArray(value) ? value : [value]) if (item !== undefined) values.push(item)
    }
  }
  return values
}

/** Drive one tool call through a real transport and return the server's view. */
async function callThrough(server: RealMcpServer, config: Record<string, unknown>): Promise<string> {
  const client = new Client({ name: 'r10-n3', version: '1' }, { capabilities: {} })
  try {
    await client.connect(productionTransport(config))
    const result = await client.callTool({ name: 'echo', arguments: { text: 'n3' } }) as { content?: Array<{ text?: string }> }
    return result.content?.[0]?.text ?? ''
  } finally {
    await client.close().catch(() => {})
  }
}

/**
 * The prototype-member names that are NOT credential fields. `constructor` /
 * `toString` / `valueOf` are the three the audit measured on the wire;
 * `hasOwnProperty` proves the rule is "own property", not "a name we blacklist".
 */
const PROTO_NAMES = ['constructor', 'toString', 'valueOf', 'hasOwnProperty']

describe('R10 N3: ${FIELD} never resolves through the prototype chain', () => {
  for (const name of PROTO_NAMES) {
    it(`declared "\${${name}}" must not put runtime internals on the wire`, async () => {
      const server = await startRealMcpServer()
      servers.push(server)
      const dir = mkdtempSync(join(tmpdir(), 'r10-n3-'))
      const h = createHarness([def(server.origin, `\${${name}}`)], dir, { refreshSweepIntervalMs: 0 })
      try {
        // `fields` 必须是一个真实存在的记录：原型链判据只在"凭据里有字段对象"时才泄漏出
        // 函数源码（`fields` 为 undefined 时可选链会给出 undefined，判据就咬不到了）。
        await seedCredential(dir, 'probe-mcp', { fields: { API_KEY: 'seeded-for-prototype-probe' } })
        const config = await connectAndAuthorize(h)
        const rendered = String((config.headers as Record<string, string> | undefined)?.['X-Probe-Key'] ?? '')
        expect(rendered, `\${${name}} 在渲染记录里就解析成了函数源码`).not.toContain('[native code]')
        expect(rendered, `\${${name}} 在渲染记录里就解析成了函数源码`).not.toContain('function ')
        expect(await callThrough(server, config), '连接器必须照常可用（这一头不是凭据）').toBe('echo:n3')

        const values = wireValues(server, PROBE_HEADER)
        expect(values.length, '前置：该声明必须真的上线过（否则这条用例空转）').toBeGreaterThan(0)
        for (const value of values) {
          expect(value, `\${${name}} 把函数源码发到了线上`).not.toContain('[native code]')
          expect(value, `\${${name}} 把函数源码发到了线上`).not.toContain('function ')
        }
        // 解析成一个未知字段 ⇒ 这一槽位不携带凭据 ⇒ 框架按"留空自动填 bearer"处理
        // （与"从没声明过"同一条规则），因此线上是活令牌而不是被删掉的头。
        const live = await (config.authProvider as { tokens: () => Promise<{ access_token?: string }> })
          .tokens().then(tokens => tokens?.access_token)
        expect(live, '前置：授权完成后 provider 必须有活令牌').toBeTruthy()
        expect(values.at(-1), '未知字段必须等价于"没解析出凭据"').toBe(`Bearer ${String(live)}`)
      } finally { h.dispose() }
    })
  }

  it('control: a REAL field name still resolves exactly, and an unknown one does not shadow the provider', async () => {
    const server = await startRealMcpServer()
    servers.push(server)
    const dir = mkdtempSync(join(tmpdir(), 'r10-n3-ctl-'))
    const h = createHarness([def(server.origin, 'Token ${API_KEY}')], dir, { refreshSweepIntervalMs: 0 })
    try {
      await seedCredential(dir, 'probe-mcp', { fields: { API_KEY: 'field-value-1' } })
      const config = await connectAndAuthorize(h)
      expect(config.headers).toMatchObject({ 'X-Probe-Key': 'Token field-value-1' })
      expect(await callThrough(server, config)).toBe('echo:n3')
      expect(wireValues(server, PROBE_HEADER).at(-1), '真实字段必须逐字上线').toBe('Token field-value-1')
      // 认证仍然靠 provider（`Authorization` 未被这一头影响）:线上必须真的带过活令牌。
      expect(server.stats.mcpBearerTokens.filter(token => token !== '').length).toBeGreaterThan(0)
      expect(server.stats.mcpUnauthorizedByMethod.POST ?? 0).toBe(0)
    } finally { h.dispose() }
  })
})
