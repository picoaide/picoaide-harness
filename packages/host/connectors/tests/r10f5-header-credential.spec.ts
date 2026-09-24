/**
 * R10-F5 regressions — the connector outbound-header seam.
 *
 * Four round-10 findings, every one exercised on the PRODUCTION path: the
 * plugin's own `apply()`, its own credential store, its own `registerMcp`, the
 * real transport fence, the real pinned SDK and a real HTTP MCP endpoint behind
 * a real authorization server. Nothing here asserts an assignment this test
 * wrote itself: the judge is the bearer / header record that actually reached
 * the endpoint.
 *
 *  - R10-B-01 — an authorization declaration that carries NO credential
 *    (`'Bearer ${API_KEY}'` with the field unset or misnamed, `'   '`,
 *    `'Bearer   '`, non-ASCII blanks) must not shadow the provider's live token.
 *  - R10-B-02 — every HTTP header name is ONE slot whatever case it is declared
 *    in: one record entry, one wire header (never a comma-joined value).
 *  - R10-B-04 — the "apply in place or rebuild" decision has exactly one
 *    criterion (`liveHeaders`); the dead `providerSupplied` flag is gone.
 *  - R10-B-05 — prototype-named headers (`constructor`, …) are ordinary own
 *    entries that expire like any other; a declared `__proto__` is refused out
 *    loud instead of vanishing into a JavaScript assignment no-op.
 *
 * The pre-fix failures are the audit probe's, kept verbatim in shape: the audit
 * recorded `lastWireBearer="Bearer"`, a 401 on the handshake and on the retry,
 * and a row still claiming `connected`.
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-mcp-client', () => ({ apply: () => {} }))

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { callRoute, createHarness, seedCredential, waitFor } from './helpers/connector-harness.ts'
import { completeAuthorization, startRealMcpServer, type RealMcpServer } from './helpers/real-mcp-oauth-server.ts'
import { ConnectorStore } from '../src/store.ts'
import type { ConnectorDef } from '../src/types.ts'

const servers: RealMcpServer[] = []
afterEach(async () => { while (servers.length) await servers.pop()?.close() })

function oauthPart(origin: string): Pick<ConnectorDef, 'authMode' | 'auth'> {
  return {
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
  }
}

function def(origin: string, headers: Record<string, string>): ConnectorDef {
  return {
    id: 'probe-mcp',
    name: 'Probe MCP',
    description: 'r10f5',
    ...oauthPart(origin),
    tokenFields: [{ key: 'API_KEY', label: 'API key', type: 'password' }],
    mcp: [{ serverName: 'probe-a', transport: 'streamable-http', url: `${origin}/mcp`, headers }],
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
  if (!url) throw new Error('no authorize URL')
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

function recordOf(config: Record<string, unknown>): Record<string, string> {
  return (config.headers ?? {}) as Record<string, string>
}

/** One line of wire facts, so a failure names the token that actually arrived. */
function diagnostics(server: RealMcpServer, config: Record<string, unknown>, cause: unknown): string {
  return `rendered=${JSON.stringify(config.headers)} `
    + `lastWireBearer=${JSON.stringify(server.stats.mcpBearerTokens.at(-1))} `
    + `postUnauthorized=${server.stats.mcpUnauthorizedByMethod.POST ?? 0} `
    + `refreshGrants=${server.stats.grants.filter(grant => grant === 'refresh_token').length} `
    + `cause=${String((cause as Error | undefined)?.message ?? cause).slice(0, 160)}`
}

/** Header names of one raw `/mcp` request that normalize to `name`. */
function wireSlots(headers: Record<string, string | string[] | undefined>, name: string): string[] {
  return Object.keys(headers).filter(key => key.toLowerCase() === name)
}

interface CredentiallessCase {
  label: string
  declared: string
  /** Fields seeded BEFORE the flow (the `${FIELD}` value itself). */
  fields?: Record<string, string>
  /** Does this shape deserve the searchable "declared but ignored" line? */
  ignoredWarn: boolean
}

/**
 * Every spelling of "resolved to something that is not a credential" the brief
 * names: a missing field, a misnamed field (case mismatch), a blank field value,
 * a blank literal, a scheme word with whitespace, non-ASCII blanks, and the
 * scheme word's case variant.
 */
const CREDENTIALLESS: CredentiallessCase[] = [
  { label: 'template with the field unset', declared: 'Bearer ${API_KEY}', ignoredWarn: true },
  { label: 'template with a MISNAMED field', declared: 'Bearer ${api_key}', ignoredWarn: true },
  { label: 'whitespace-only literal', declared: '   ', ignoredWarn: false },
  { label: 'scheme word plus a single trailing space', declared: 'Bearer ', ignoredWarn: false },
  { label: 'scheme word plus trailing whitespace', declared: 'Bearer   ', ignoredWarn: false },
  { label: 'bare scheme word', declared: 'Bearer', ignoredWarn: false },
  { label: 'bare scheme word, lower case', declared: 'bearer', ignoredWarn: false },
  { label: 'bare scheme word, upper case, trailing space', declared: 'BEARER ', ignoredWarn: false },
  { label: 'non-ASCII whitespace (NBSP + ideographic space)', declared: '\u00a0\u3000', ignoredWarn: false },
  { label: 'lower-case scheme word in the template', declared: 'bearer ${API_KEY}', ignoredWarn: true },
  { label: 'field value is whitespace', declared: 'Bearer ${API_KEY}', fields: { API_KEY: '   ' }, ignoredWarn: true },
  { label: 'field value is a non-ASCII blank', declared: 'Bearer ${API_KEY}', fields: { API_KEY: '\u00a0' }, ignoredWarn: true },
]

describe('R10-B-01: a declaration that carries no credential must not blank the provider', () => {
  for (const item of CREDENTIALLESS) {
    it(`${item.label} (${JSON.stringify(item.declared)}): the live provider token still reaches the endpoint`, async () => {
      const server = await startRealMcpServer()
      servers.push(server)
      const dir = mkdtempSync(join(tmpdir(), 'r10f5-f1-'))
      const h = createHarness([def(server.origin, { Authorization: item.declared })], dir, { refreshSweepIntervalMs: 0 })
      try {
        if (item.fields !== undefined) await seedCredential(dir, 'probe-mcp', { fields: item.fields })
        const config = await connectAndAuthorize(h)
        const live = await (config.authProvider as { tokens: () => Promise<{ access_token?: string }> })
          .tokens().then(tokens => tokens?.access_token)
        expect(live, '前置：授权完成后 provider 必须有活令牌').toBeTruthy()

        const client = new Client({ name: 'r10f5-f1', version: '1' }, { capabilities: {} })
        try {
          await client.connect(productionTransport(config)).catch((cause: unknown) => {
            throw new Error(`声明 ${JSON.stringify(item.declared)} 把 provider 的活令牌挡掉了（握手）：${diagnostics(server, config, cause)}`)
          })
          const call = await client.callTool({ name: 'echo', arguments: { text: 'f1' } })
            .catch((cause: unknown): never => {
              throw new Error(`声明 ${JSON.stringify(item.declared)} 把 provider 的活令牌挡掉了（调用）：${diagnostics(server, config, cause)}`)
            }) as { content?: Array<{ text?: string }> }
          expect(call.content?.[0]?.text, '连接器必须在 provider 的活令牌下工作').toBe('echo:f1')
          expect(server.stats.mcpBearerTokens.at(-1), '线上必须是 provider 的活令牌').toBe(live)
          expect(
            server.stats.mcpUnauthorizedByMethod.POST ?? 0,
            '回归形态是握手 401 + 重试 401：POST 上不该出现任何 401',
          ).toBe(0)
          expect(
            server.stats.grants.filter(grant => grant === 'refresh_token').length,
            '一次空凭据声明不该再烧 refresh grant（轮换复用检测会吊销整个授权）',
          ).toBe(0)
          expect(
            Object.hasOwn(recordOf(config), 'Authorization'),
            '无凭据的声明不得作为「定义自己的凭据」留在记录里',
          ).toBe(false)
          if (item.ignoredWarn) {
            expect(
              h.warns.some(line => line.includes('[declared-authorization-ignored]')),
              '「声明了但没解析出凭据」必须留下可检索的一行（回归形态是完全静默）',
            ).toBe(true)
          }
        } finally { await client.close().catch(() => {}) }
      } finally { h.dispose() }
    }, 60_000)
  }

  it('control: the empty-resolution spelling the round-9 fix covers still works', async () => {
    const server = await startRealMcpServer()
    servers.push(server)
    const dir = mkdtempSync(join(tmpdir(), 'r10f5-f1c-'))
    const h = createHarness([def(server.origin, { Authorization: '${MISSING_FIELD}' })], dir, { refreshSweepIntervalMs: 0 })
    try {
      const config = await connectAndAuthorize(h)
      const client = new Client({ name: 'r10f5-f1c', version: '1' }, { capabilities: {} })
      await client.connect(productionTransport(config))
      try {
        const call = await client.callTool({ name: 'echo', arguments: { text: 'ctl' } }) as { content?: Array<{ text?: string }> }
        expect(call.content?.[0]?.text).toBe('echo:ctl')
      } finally { await client.close().catch(() => {}) }
    } finally { h.dispose() }
  }, 60_000)

  it('control: a declaration that DOES carry a credential still wins on the wire (V3A-N1 / R9A-4)', async () => {
    const server = await startRealMcpServer()
    servers.push(server)
    const dir = mkdtempSync(join(tmpdir(), 'r10f5-f1d-'))
    const h = createHarness(
      [def(server.origin, { authorization: 'ApiKey ${API_KEY}', AUTHORIZATION: '' })],
      dir,
      { refreshSweepIntervalMs: 0 },
    )
    try {
      await seedCredential(dir, 'probe-mcp', { fields: { API_KEY: 'k1' } })
      const config = await connectAndAuthorize(h)
      const authorizationSlots = Object.keys(recordOf(config)).filter(name => name.toLowerCase() === 'authorization')
      expect(authorizationSlots, '授权槽只允许一个拼写（R8-B-1 / V3A-N2）').toEqual(['Authorization'])
      expect(recordOf(config).Authorization, '解析出真值的声明必须原样保留').toBe('ApiKey k1')

      const client = new Client({ name: 'r10f5-f1d', version: '1' }, { capabilities: {} })
      try {
        // The endpoint only accepts its own bearer, so this attempt is EXPECTED
        // to fail — the fact under test is the header that really went out.
        await client.connect(productionTransport(config)).catch(() => {})
        const authorized = server.stats.mcpHeaders.filter(headers => headers.authorization !== undefined)
        expect(authorized.length, '前置：必须有带 Authorization 的请求真的到过线上').toBeGreaterThan(0)
        for (const headers of authorized) {
          expect(
            headers.authorization,
            '声明值必须原样上线（空拼写覆盖 / 逗号拼接都是回归）',
          ).toBe('ApiKey k1')
        }
        expect(
          h.warns.some(line => line.includes('[declared-authorization]')),
          '「声明值覆盖 provider 活令牌」必须可检索',
        ).toBe(true)
      } finally { await client.close().catch(() => {}) }
    } finally { h.dispose() }
  }, 60_000)
})

describe('R10-B-02: one HTTP header name is one slot, whatever case it is declared in', () => {
  /** Connect + call, and return the raw header record of the last `/mcp` request. */
  async function callAndReadWire(
    h: ReturnType<typeof createHarness>,
    server: RealMcpServer,
    config: Record<string, unknown>,
    text: string,
  ): Promise<Record<string, string | string[] | undefined>> {
    const client = new Client({ name: `r10f5-f2-${text}`, version: '1' }, { capabilities: {} })
    await client.connect(productionTransport(config))
    try {
      const call = await client.callTool({ name: 'echo', arguments: { text } }) as { content?: Array<{ text?: string }> }
      expect(call.content?.[0]?.text).toBe(`echo:${text}`)
      return server.stats.mcpHeaders.at(-1) ?? {}
    } finally { await client.close().catch(() => {}) }
  }

  for (const [label, headers, expected] of [
    ['non-empty first, empty second', { 'x-probe-key': 'A', 'X-Probe-Key': '' }, 'A'],
    ['empty first, non-empty second', { 'X-Probe-Key': '', 'x-probe-key': 'A' }, 'A'],
    ['two non-empty spellings (declaration order decides)', { 'x-probe-key': 'A', 'X-Probe-Key': 'B' }, 'B'],
  ] as Array<[string, Record<string, string>, string]>) {
    it(`${label}: one record entry, one wire header`, async () => {
      const server = await startRealMcpServer()
      servers.push(server)
      const dir = mkdtempSync(join(tmpdir(), 'r10f5-f2-'))
      const h = createHarness([def(server.origin, headers)], dir, { refreshSweepIntervalMs: 0 })
      try {
        const config = await connectAndAuthorize(h)
        const slots = Object.keys(recordOf(config)).filter(name => name.toLowerCase() === 'x-probe-key')
        expect(slots.length, `同一 HTTP 头只能有一个拼写：${JSON.stringify(recordOf(config))}`).toBe(1)
        expect(recordOf(config)[slots[0]!], '非空者胜：空拼写不得顶掉已声明的值').toBe(expected)

        const wire = await callAndReadWire(h, server, config, 'f2')
        const wireNames = wireSlots(wire, 'x-probe-key')
        expect(wireNames.length, `线上每个头名只能出现一次：${JSON.stringify(wire)}`).toBe(1)
        expect(
          wire[wireNames[0]!],
          '回归形态是两个拼写被 new Headers() 拼成一条逗号值，谁都解析不了',
        ).toBe(expected)
      } finally { h.dispose() }
    }, 60_000)
  }
})

describe('R10-B-05: prototype-named headers are ordinary entries; __proto__ is refused out loud', () => {
  it('a header named after an Object.prototype member expires with the credential', async () => {
    const server = await startRealMcpServer()
    servers.push(server)
    const dir = mkdtempSync(join(tmpdir(), 'r10f5-f5-'))
    const h = createHarness(
      [def(server.origin, { constructor: '', 'X-Probe-Key': '' })],
      dir,
      { refreshSweepIntervalMs: 0 },
    )
    try {
      const config = await connectAndAuthorize(h)
      const record = recordOf(config)
      expect(
        Object.keys(record).filter(name => name.toLowerCase() === 'constructor'),
        '定义的 constructor 头必须真的进记录（自有属性，不是查不到的原型成员）',
      ).toEqual(['constructor'])
      expect(record.constructor, '空声明 ⇒ 框架填 bearer').toMatch(/^Bearer at-/u)
      expect(Object.hasOwn(record, 'X-Probe-Key'), '对照头：普通名字同样进记录').toBe(true)

      // The credential loses its token (an API-key-only credential on disk) and
      // the production hand-off re-renders the live record in place. A header the
      // render no longer produces must be REMOVED — including the prototype name.
      const store = new ConnectorStore({ baseDir: dir })
      const current = await store.readCredential('probe-mcp')
      await store.writeCredential('probe-mcp', {
        updatedAt: Date.now(),
        ...(current?.fields === undefined ? {} : { fields: current.fields }),
      })
      h.emit('pico/connector-credentials-changed', { id: 'probe-mcp' })

      // The contrast header proves the deletion sweep really ran (otherwise the
      // second assertion could be vacuous), and the record must not be replaced:
      // a provider-backed transport is refreshed in place (R9-D-1 / R10-B-04).
      await waitFor(() => !Object.hasOwn(recordOf(config), 'X-Probe-Key'), 10_000)
      expect(h.configs.length, '凭据变更不得重建 provider-backed 传输').toBe(1)
      expect(
        Object.hasOwn(recordOf(config), 'constructor'),
        '原型名头必须与普通头一起过期：`name in next` 在原型链上永远为真，它因此永不过期',
      ).toBe(false)
      // …and the shape that makes an own-property sweep exact in the first place.
      expect(
        Object.getPrototypeOf(recordOf(config)),
        '渲染记录必须是 null 原型：没有任何名字可以从原型链上被看见',
      ).toBeNull()
    } finally { h.dispose() }
  }, 60_000)

  it('a declared __proto__ is refused with a searchable line, and touches no prototype', async () => {
    const server = await startRealMcpServer()
    servers.push(server)
    const dir = mkdtempSync(join(tmpdir(), 'r10f5-f5b-'))
    // An OWN `__proto__` key — an object literal would set the prototype
    // instead, so it has to be defined explicitly. That is exactly the shape the
    // admin console's free-form KV produces from JSON.
    const headers: Record<string, string> = { 'X-Probe-Key': 'static' }
    Object.defineProperty(headers, '__proto__', { value: 'sneaky', enumerable: true, configurable: true, writable: true })
    const h = createHarness([def(server.origin, headers)], dir, { refreshSweepIntervalMs: 0 })
    try {
      const config = await connectAndAuthorize(h)
      const record = recordOf(config)
      expect(Object.getPrototypeOf(record), '任何声明都不得触碰渲染记录的原型').toBeNull()
      expect(Object.hasOwn(record, '__proto__'), '无法表示的声明不得被静默塞进记录').toBe(false)
      expect(Object.keys(record), '记录里只有真正要发出的头').toEqual(['X-Probe-Key'])
      expect(
        h.warns.some(line => line.includes('[unsupported-header]') && line.includes('__proto__')),
        '拒绝必须留下可检索的一行（回归形态是完全静默地消失）',
      ).toBe(true)

      const client = new Client({ name: 'r10f5-f5b', version: '1' }, { capabilities: {} })
      await client.connect(productionTransport(config))
      try {
        const call = await client.callTool({ name: 'echo', arguments: { text: 'f5b' } }) as { content?: Array<{ text?: string }> }
        expect(call.content?.[0]?.text, '一个被拒的声明不得让连接器整体不可用').toBe('echo:f5b')
      } finally { await client.close().catch(() => {}) }
    } finally { h.dispose() }
  }, 60_000)
})

describe('R10-F5 review: an opaque single-token credential is NOT a scheme word', () => {
  /**
   * Register + authorize + connect, and return the Authorization values the real
   * endpoint received. A declaration of the definition's own SHADOWS the provider
   * token on purpose (V3A-N1), so the handshake against this fixture is EXPECTED
   * to fail — the fact under test is what really went out.
   */
  async function declaredAuthorizationOnTheWire(
    declared: string,
    fields?: Record<string, string>,
  ): Promise<{ wire: string[], record: Record<string, string> }> {
    const server = await startRealMcpServer()
    servers.push(server)
    const dir = mkdtempSync(join(tmpdir(), 'r10f5-f3-'))
    const h = createHarness([def(server.origin, { Authorization: declared })], dir, { refreshSweepIntervalMs: 0 })
    try {
      if (fields !== undefined) await seedCredential(dir, 'probe-mcp', { fields })
      const config = await connectAndAuthorize(h)
      const client = new Client({ name: 'r10f5-f3', version: '1' }, { capabilities: {} })
      try {
        await client.connect(productionTransport(config)).catch(() => {})
        return {
          wire: server.stats.mcpHeaders
            .filter(headers => headers.authorization !== undefined)
            .map(headers => String(headers.authorization)),
          record: recordOf(config),
        }
      } finally { await client.close().catch(() => {}) }
    } finally { h.dispose() }
  }

  // Not one of the registered scheme words ⇒ the definition's own opaque
  // credential. A shape test ("single RFC 7230 token") used to swallow these:
  // with a stored token they were replaced by the framework bearer, and with no
  // stored token the header was DELETED — the R10-B-01 fault in reverse.
  for (const declared of ['abc123', 'sk-live-1234', 'mytoken']) {
    it(`declared ${JSON.stringify(declared)}: sent exactly as written`, async () => {
      const { wire, record } = await declaredAuthorizationOnTheWire(declared)
      expect(wire.length, '前置：必须有带 Authorization 的请求真的到过线上').toBeGreaterThan(0)
      for (const value of wire) {
        expect(
          value,
          '定义自己的不透明令牌必须原样发出（回归形态：被换成框架 bearer，或无令牌时被删掉）',
        ).toBe(declared)
      }
      expect(record.Authorization, '记录里也必须原样保留').toBe(declared)
    }, 60_000)
  }

  it('control: `Bearer ${FIELD}` WITH a field value is still sent exactly as written', async () => {
    const { wire, record } = await declaredAuthorizationOnTheWire('Bearer ${API_KEY}', { API_KEY: 'k1' })
    expect(wire.length, '前置：必须有带 Authorization 的请求真的到过线上').toBeGreaterThan(0)
    for (const value of wire) expect(value, '方案名 + 真凭据必须原样发出').toBe('Bearer k1')
    expect(record.Authorization).toBe('Bearer k1')
  }, 60_000)
})

describe('R10-B-04: one criterion decides "refresh in place" vs "rebuild"', () => {
  it('the dead providerSupplied flag is gone from the plugin source', () => {
    // A structural fact about a DELETION, so it is read from the source: the
    // behaviour it used to duplicate (a provider-backed transport is refreshed
    // in place, a provider-less one is rebuilt) is asserted above and by
    // tests/audit-r9-connector-headers.spec.ts, which this suite runs beside.
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
    expect(
      source.includes('providerSupplied'),
      'providerSupplied 是第九轮留下的只写不读死字段：判据只有 liveHeaders 一处（R10-B-04）',
    ).toBe(false)
  })
})
