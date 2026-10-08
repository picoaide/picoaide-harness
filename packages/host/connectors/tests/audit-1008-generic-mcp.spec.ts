import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runAuth } from '../src/auth.ts'
import { autoOAuthConfig, resolveAuthMode } from '../src/policy.ts'
import type { ConnectorDef } from '../src/types.ts'

/**
 * Generic MCP connectors (2026-10-08): a definition that is nothing but a
 * standard `mcpServers` entry — a transport and a URL — must run end to end.
 *
 * The feature only exists because a spec-compliant MCP server describes its own
 * authorization in the 401 challenge, so most of this suite is about the
 * discovery chain and the scope request it produces. The seams are the same two
 * `tests/auth.spec.ts` uses (see the long comments there): the pinned transport
 * is redirected to the global fetch stub, and the DNS gate is answered by an
 * injected resolver so the suite does not depend on the runner's DNS.
 */
vi.mock('../src/pinned-http.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/pinned-http.ts')>()
  return {
    ...actual,
    sendPinned: async (target: { url: URL }, init: RequestInit) => globalThis.fetch(target.url.href, init),
  }
})

const dnsSeam = vi.hoisted(() => ({ resolutions: [] as string[] }))

vi.mock('node:dns/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns/promises')>()
  return {
    ...actual,
    lookup: async (hostname: string, options?: { all?: boolean }) => {
      dnsSeam.resolutions.push(String(hostname))
      // RFC 5737 TEST-NET-2: a NAME resolving here is an allowed deployment shape.
      return options?.all === true
        ? [{ address: '198.51.100.9', family: 4 }]
        : { address: '198.51.100.9', family: 4 }
    },
  }
})

beforeEach(() => { dnsSeam.resolutions.length = 0 })

/** A definition with nothing but the two standard fields, exactly as pasted. */
function standardDef(patch: Partial<ConnectorDef> = {}): ConnectorDef {
  return {
    id: 'neo-crm',
    name: 'NeoCRM',
    description: '官方 MCP',
    authMode: 'auto',
    mcp: [{ serverName: 'neo-crm', transport: 'streamable-http', url: 'https://mcp.example/mcp' }],
    ...patch,
  }
}

describe('auto auth mode resolution', () => {
  it('treats the MCP endpoint itself as the discovery URL', () => {
    const def = standardDef()
    expect(resolveAuthMode(def)).toBe('oauth')
    const auth = autoOAuthConfig(def)
    expect(auth?.discoveryUrl).toBe('https://mcp.example/mcp')
    // A public client with PKCE is the only shape a spec-compliant MCP server
    // accepts (`token_endpoint_auth_methods_supported: ["none"]`).
    expect(auth?.publicClient).toBe(true)
    expect(auth?.pkce).toBe(true)
  })

  it('uses the declared credential form instead of probing when fields exist', () => {
    const def = standardDef({
      tokenFields: [{ key: 'API_KEY', label: 'API Key', type: 'password', required: true }],
      mcp: [{
        serverName: 'neo-crm',
        transport: 'streamable-http',
        url: 'https://mcp.example/mcp',
        headers: { Authorization: 'Bearer ${API_KEY}' },
      }],
    })
    expect(resolveAuthMode(def)).toBe('token')
  })

  it('never bolts discovery onto a definition that named its own endpoints', () => {
    const def = standardDef({
      auth: {
        authorizeUrl: 'https://auth.example/authorize',
        tokenUrl: 'https://auth.example/token',
        clientId: 'static-client',
        redirectUri: '',
      },
    })
    const auth = autoOAuthConfig(def)
    expect(auth?.discoveryUrl).toBeUndefined()
    expect(auth?.clientId).toBe('static-client')
    expect(resolveAuthMode(def)).toBe('oauth')
  })

  it('has nothing to authorize for a local stdio server', () => {
    const def = standardDef({
      mcp: [{ serverName: 'local-tools', transport: 'stdio', command: 'npx', args: ['-y', 'foo-mcp'], env: {} }],
    })
    expect(resolveAuthMode(def)).toBe('none')
    expect(autoOAuthConfig(def)).toBeUndefined()
  })

  it('leaves the declared modes untouched', () => {
    const stdio = [{ serverName: 's', transport: 'stdio' as const, command: 'npx', args: [], env: {} }]
    expect(resolveAuthMode({ authMode: 'token', mcp: stdio })).toBe('token')
    expect(resolveAuthMode({ authMode: 'device', mcp: stdio })).toBe('device')
    expect(resolveAuthMode({ authMode: 'server-side', mcp: stdio })).toBe('server-side')
    expect(resolveAuthMode({ authMode: 'oauth', auth: { discoveryUrl: 'https://x.example/mcp' } })).toBe('oauth')
    // No mode at all stays the credential-less shape it has always been.
    expect(resolveAuthMode({ mcp: stdio })).toBe('none')
    // An unknown mode is never silently treated as a flow.
    expect(resolveAuthMode({ authMode: 'saml', mcp: stdio })).toBe('none')
  })
})

describe('auto auth mode end to end', () => {
  it('authorizes a URL-only connector through RFC 9728 + RFC 8414 + DCR', async () => {
    const originalFetch = globalThis.fetch
    const authorizeRequests: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) {
        return originalFetch(input, init)
      }
      const json = (body: object, status = 200): Response =>
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
      if (url === 'https://mcp.example/mcp') {
        return new Response('', {
          status: 401,
          headers: { 'WWW-Authenticate': 'Bearer resource_metadata="https://mcp.example/.well-known/oauth-protected-resource/mcp"' },
        })
      }
      if (url === 'https://mcp.example/.well-known/oauth-protected-resource/mcp') {
        // The resource names two scopes and no offline_access — the shape that
        // used to be truncated to a single scope.
        return json({
          resource: 'https://mcp.example/mcp',
          authorization_servers: ['https://auth.example'],
          scopes_supported: ['mcp:tools', 'people:read'],
        })
      }
      if (url === 'https://auth.example/.well-known/oauth-authorization-server') {
        return json({
          authorization_endpoint: 'https://auth.example/authorize',
          token_endpoint: 'https://auth.example/token',
          registration_endpoint: 'https://auth.example/register',
          scopes_supported: ['mcp:tools', 'people:read', 'offline_access'],
        })
      }
      if (url === 'https://auth.example/register') return json({ client_id: 'dyn-auto-1' })
      if (url === 'https://auth.example/authorize') return json({})
      if (url === 'https://auth.example/token') return json({ access_token: 'at-auto', refresh_token: 'rt-auto' })
      return new Response('unexpected ' + url, { status: 500 })
    }) as typeof fetch
    try {
      const signal = new AbortController().signal
      const runPromise = runAuth(standardDef(), {
        onRequest: (request) => { if (request.authorizeUrl) authorizeRequests.push(request.authorizeUrl) },
        signal,
        tokenUrlOverride: 'https://auth.example/token',
      })
      const deadline = Date.now() + 3000
      while (authorizeRequests.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      const authorize = new URL(authorizeRequests[0] ?? '')
      const redirectUri = authorize.searchParams.get('redirect_uri') ?? ''
      const state = authorize.searchParams.get('state') ?? ''
      await originalFetch(`${redirectUri}?code=auto-code&state=${encodeURIComponent(state)}`)
      const patch = await runPromise
      expect(patch.accessToken).toBe('at-auto')
      expect(patch.clientId).toBe('dyn-auto-1')
      // RFC 8707: the token is bound to the MCP resource, and the resource
      // indicator comes from discovery (there is no URL in the config for it).
      expect(authorize.searchParams.get('resource')).toBe('https://mcp.example/mcp')
      // Both resource scopes are requested, plus offline_access because the
      // authorization server advertises it (without it there is no refresh
      // token, and the row would demand a fresh sign-in on every expiry).
      expect(authorize.searchParams.get('scope')).toBe('mcp:tools people:read offline_access')
      expect(dnsSeam.resolutions.length).toBeGreaterThan(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('connects a public endpoint without any authorization step', async () => {
    const originalFetch = globalThis.fetch
    let authorizeSeen = false
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) {
        return originalFetch(input, init)
      }
      if (url === 'https://mcp.example/mcp') return new Response('', { status: 200 })
      return new Response('unexpected ' + url, { status: 500 })
    }) as typeof fetch
    try {
      const patch = await runAuth(standardDef(), {
        onRequest: () => { authorizeSeen = true },
        signal: new AbortController().signal,
      })
      // The discovery result IS the credential for a public endpoint (no token
      // is issued); losing this marker is what made public connectors demand a
      // re-authorization on every restart (2026-09-15 audit, BUG-06).
      expect(patch.publicMcp).toBe(true)
      expect(patch.accessToken).toBeUndefined()
      expect(authorizeSeen).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('does not run any network flow for a credential-less stdio connector', async () => {
    const originalFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calls += 1
      return originalFetch(input, init)
    }) as typeof fetch
    try {
      const patch = await runAuth(standardDef({
        mcp: [{ serverName: 'local-tools', transport: 'stdio', command: 'npx', args: ['-y', 'foo-mcp'], env: {} }],
      }), { onRequest: () => {}, signal: new AbortController().signal })
      expect(calls).toBe(0)
      expect(patch.accessToken).toBeUndefined()
      expect(typeof patch.updatedAt).toBe('number')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
