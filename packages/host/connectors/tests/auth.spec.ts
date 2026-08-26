import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:net'
import { ConnectorStore } from '../src/store.ts'
import { runAuth, refreshOAuthToken } from '../src/auth.ts'
import type { ConnectorDef } from '../src/types.ts'

function oauthDef(): ConnectorDef {
  return {
    id: 'test-oauth',
    name: 'Test OAuth',
    description: 'x',
    authMode: 'oauth',
    auth: {
      authorizeUrl: 'https://auth.example/authorize',
      tokenUrl: 'https://auth.example/token',
      registrationEndpoint: 'https://auth.example/register',
      clientId: '',
      redirectUri: '',
      scopes: 'offline_access',
      pkce: true,
      publicClient: true,
    },
    mcp: [{ serverName: 'test', transport: 'streamable-http', url: 'https://mcp.example/mcp' }],
  }
}

describe('connector auth', () => {
  it('runs the PKCE oauth flow end to end', async () => {
    const def = oauthDef()
    const requests: Array<{ url: string; body: string | null }> = []
    let authorizeUrl = ''

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('http://127.0.0.1')) return originalFetch(input, init)
      if (url.includes('/register')) {
        requests.push({ url, body: typeof init?.body === 'string' ? init.body : null })
        return new Response(JSON.stringify({ client_id: 'dyn-client-1' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url.includes('/token')) {
        requests.push({ url, body: String(init?.body ?? '') })
        return new Response(JSON.stringify({ access_token: 'at-1', refresh_token: 'rt-1' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response('{}', { status: 404 })
    }) as typeof fetch

    try {
      // Capture the authorize URL the flow emits, then hit its callback
      // (the loopback server) with a code and the flow's state.
      const flow = runAuth(def, {
        onRequest: (request) => {
          authorizeUrl = request.authorizeUrl ?? ''
          if (authorizeUrl) {
            const callback = new URL(authorizeUrl).searchParams.get('redirect_uri') ?? ''
            const state = new URL(authorizeUrl).searchParams.get('state') ?? ''
            void fetch(`${callback}?code=auth-code-1&state=${encodeURIComponent(state)}`)
          }
        },
        signal: new AbortController().signal,
      })
      const patch = await flow

      expect(authorizeUrl).toContain('https://auth.example/authorize')
      expect(new URL(authorizeUrl).searchParams.get('code_challenge_method')).toBe('S256')
      expect(new URL(authorizeUrl).searchParams.get('code_challenge')).toBeTruthy()
      expect(new URL(authorizeUrl).searchParams.get('client_id')).toBe('dyn-client-1')
      expect(patch.accessToken).toBe('at-1')
      expect(patch.refreshToken).toBe('rt-1')
      expect(patch.clientId).toBe('dyn-client-1')

      const tokenBody = requests.find((r) => r.url.includes('/token'))?.body ?? ''
      expect(tokenBody).toContain('grant_type=authorization_code')
      expect(tokenBody).toContain('code_verifier=')
      expect(tokenBody).toContain('code=auth-code-1')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('survives a keep-alive second request after the oauth callback (browser favicon race)', async () => {
    const def = oauthDef()
    let authorizeUrl = ''
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('http://127.0.0.1')) return originalFetch(input, init)
      if (url.includes('/register')) {
        return new Response(JSON.stringify({ client_id: 'dyn-client-2' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url.includes('/token')) {
        return new Response(JSON.stringify({ access_token: 'at-2' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response('{}', { status: 404 })
    }) as typeof fetch

    try {
      const flow = runAuth(def, {
        onRequest: (request) => {
          authorizeUrl = request.authorizeUrl ?? ''
        },
        signal: new AbortController().signal,
      })
      const deadline = Date.now() + 3000
      while (authorizeUrl === '' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      const callback = new URL(authorizeUrl).searchParams.get('redirect_uri') ?? ''
      const state = new URL(authorizeUrl).searchParams.get('state') ?? ''
      const callbackUrl = new URL(callback)
      const callbackPort = Number(callbackUrl.port)

      // Mimic the browser: the callback navigation followed by /favicon.ico on
      // the same keep-alive socket. The handler closes the server after the
      // first response, so this second request used to hit the handler with
      // server.address() === null and throw an uncaught exception (killing the
      // whole host). The flow must still resolve with the token.
      const socket = connect(callbackPort, callbackUrl.hostname)
      let responseHead = ''
      socket.on('data', (chunk: Buffer) => { responseHead += chunk.toString() })
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve)
        socket.once('error', reject)
      })
      const send = (raw: string): Promise<void> => new Promise((resolve) => {
        socket.write(raw)
        setTimeout(resolve, 250)
      })
      await send(`GET /callback?code=keep-alive-code&state=${encodeURIComponent(state)} HTTP/1.1\r\nHost: 127.0.0.1:${callbackPort}\r\nConnection: keep-alive\r\n\r\n`)
      await send(`GET /favicon.ico HTTP/1.1\r\nHost: 127.0.0.1:${callbackPort}\r\nConnection: close\r\n\r\n`)
      socket.destroy()

      const patch = await flow
      expect(responseHead).toContain('200 OK')
      expect(patch.accessToken).toBe('at-2')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('refreshes an access token with the stored client id', async () => {
    const def = oauthDef()
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = String(init?.body ?? '')
      expect(body).toContain('grant_type=refresh_token')
      expect(body).toContain('client_id=dyn-client-1')
      return new Response(JSON.stringify({ access_token: 'at-2', refresh_token: 'rt-2' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch
    try {
      const patch = await refreshOAuthToken(def, { accessToken: 'stale', refreshToken: 'rt-1', clientId: 'dyn-client-1', updatedAt: 0 })
      expect(patch?.accessToken).toBe('at-2')
      expect(patch?.refreshToken).toBe('rt-2')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('persists credentials through the store', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'connectors-'))
    try {
      const store = new ConnectorStore({ baseDir: dir })
      await store.updateCredential('sales-easy', { accessToken: 'at', fields: { clientId: 'c1' } })
      const read = await store.readCredential('sales-easy')
      expect(read?.accessToken).toBe('at')
      expect(read?.fields?.clientId).toBe('c1')
      await store.clearCredential('sales-easy')
      expect(await store.readCredential('sales-easy')).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects path-escaping connector ids and writes private files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'connectors-'))
    try {
      const store = new ConnectorStore({ baseDir: dir })
      for (const bad of ['../escape', 'a/b', '..', '.', '', 'x'.repeat(128)]) {
        await expect(store.updateCredential(bad, { accessToken: 'at', updatedAt: 0 })).rejects.toThrow()
      }
      await store.updateCredential('sales-easy', { accessToken: 'at', updatedAt: 0 })
      const stats = await import('node:fs').then((fs) => fs.promises.stat(join(dir, 'sales-easy.json')))
      expect(stats.mode & 0o777).toBe(0o600)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('connects a public MCP endpoint without OAuth', async () => {
    const calls: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calls.push(String(input))
      return new Response('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/initialized"}', { status: 200 })
    }) as typeof fetch
    try {
      const def: ConnectorDef = {
        id: 'public-mcp',
        name: 'Public',
        description: 'x',
        authMode: 'oauth',
        auth: {
          discoveryUrl: 'https://mcp.example/mcp',
          clientId: '',
          authorizeUrl: '',
          tokenUrl: '',
          redirectUri: '',
          pkce: true,
          publicClient: true,
        },
        mcp: [{ serverName: 'pub', transport: 'streamable-http', url: 'https://mcp.example/mcp' }],
      }
      const patch = await runAuth(def, {
        onRequest: () => {},
        signal: new AbortController().signal,
      })
      expect(patch.updatedAt).toBeTruthy()
      expect(calls).toEqual(['https://mcp.example/mcp'])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('resolves the authorization server through RFC 9728 + RFC 8414 metadata', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      // Let loopback callback requests reach the real callback server.
      if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) {
        return originalFetch(input, init)
      }
      const json = (body: object, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
      if (url === 'https://mcp.example/mcp') {
        return new Response('', { status: 401, headers: { 'WWW-Authenticate': 'Bearer resource_metadata="https://mcp.example/.well-known/oauth-protected-resource"' } })
      }
      if (url === 'https://mcp.example/.well-known/oauth-protected-resource') {
        return json({ authorization_servers: ['https://auth.example'] })
      }
      if (url === 'https://auth.example/.well-known/oauth-authorization-server') {
        return json({ authorization_endpoint: 'https://auth.example/authorize', token_endpoint: 'https://auth.example/token', registration_endpoint: 'https://auth.example/register', scopes_supported: ['offline_access', 'calendar.read'] })
      }
      if (url === 'https://auth.example/register') {
        return json({ client_id: 'dyn-1' })
      }
      if (url === 'https://auth.example/authorize') return json({})
      if (url === 'https://auth.example/token') {
        return json({ access_token: 'at-1', refresh_token: 'rt-1' })
      }
      return new Response('unexpected ' + url, { status: 500 })
    }) as typeof fetch
    try {
      const def: ConnectorDef = {
        id: 'protected-mcp',
        name: 'Protected',
        description: 'x',
        authMode: 'oauth',
        auth: {
          discoveryUrl: 'https://mcp.example/mcp',
          clientId: '',
          authorizeUrl: '',
          tokenUrl: '',
          redirectUri: '',
          pkce: true,
          publicClient: true,
        },
        mcp: [{ serverName: 'prot', transport: 'streamable-http', url: 'https://mcp.example/mcp' }],
      }
      const requests: Array<{ authorizeUrl?: string }> = []
      const signal = new AbortController().signal
      const runPromise = runAuth(def, {
        onRequest: (request) => {
          if (request.authorizeUrl) requests.push({ authorizeUrl: request.authorizeUrl })
        },
        signal,
        tokenUrlOverride: 'https://auth.example/token',
      })
      const deadline = Date.now() + 3000
      while (requests.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      const redirectUri = new URL(requests[0]?.authorizeUrl ?? '').searchParams.get('redirect_uri')
      expect(redirectUri).toBeTruthy()
      const state = new URL(requests[0]?.authorizeUrl ?? '').searchParams.get('state') ?? ''
      await fetch(`${String(redirectUri)}?code=test-code&state=${encodeURIComponent(state)}`)
      const patch = await runPromise
      const authorize = new URL(requests[0]?.authorizeUrl ?? '')
      expect(authorize.searchParams.get('resource')).toBe('https://mcp.example/mcp')
      expect(authorize.searchParams.get('state')).toBeTruthy()
      expect(patch.accessToken).toBe('at-1')
      expect(patch.clientId).toBe('dyn-1')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('fails with a clear error when the protected resource has no metadata', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      const url = String(input)
      if (url === 'https://mcp.example/mcp') return new Response('', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="mcp"' } })
      return new Response('not found', { status: 404 })
    }) as typeof fetch
    try {
      const def: ConnectorDef = {
        id: 'no-metadata',
        name: 'No Metadata',
        description: 'x',
        authMode: 'oauth',
        auth: {
          discoveryUrl: 'https://mcp.example/mcp',
          clientId: '',
          authorizeUrl: '',
          tokenUrl: '',
          redirectUri: '',
          pkce: true,
          publicClient: true,
        },
        mcp: [],
      }
      await expect(runAuth(def, { onRequest: () => {}, signal: new AbortController().signal })).rejects.toThrow('MCP OAuth 发现失败')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('refreshes a discovery-mode token through the discovered endpoint with the resource parameter', async () => {
    const originalFetch = globalThis.fetch
    let tokenBody: string | null = null
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      const json = (body: object, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
      if (url === 'https://mcp.example/mcp') {
        return new Response('', { status: 401, headers: { 'WWW-Authenticate': 'Bearer resource_metadata="https://mcp.example/.well-known/oauth-protected-resource"' } })
      }
      if (url === 'https://mcp.example/.well-known/oauth-protected-resource') {
        return json({ authorization_servers: ['https://auth.example'] })
      }
      if (url === 'https://auth.example/.well-known/oauth-authorization-server') {
        return json({ authorization_endpoint: 'https://auth.example/authorize', token_endpoint: 'https://auth.example/token', scopes_supported: ['offline_access'] })
      }
      if (url === 'https://auth.example/token') {
        tokenBody = init?.body != null ? String(init.body) : null
        return json({ access_token: 'at-2', refresh_token: 'rt-2' })
      }
      return new Response('unexpected ' + url, { status: 500 })
    }) as typeof fetch
    try {
      const def: ConnectorDef = {
        id: 'refresh-mcp',
        name: 'Refresh',
        description: 'x',
        authMode: 'oauth',
        auth: {
          discoveryUrl: 'https://mcp.example/mcp',
          clientId: '',
          authorizeUrl: '',
          tokenUrl: '',
          redirectUri: '',
          pkce: true,
          publicClient: true,
        },
        mcp: [],
      }
      const refreshed = await refreshOAuthToken(def, { accessToken: 'old', refreshToken: 'rt-1', clientId: 'dyn-1', updatedAt: 0 })
      expect(refreshed?.accessToken).toBe('at-2')
      expect(tokenBody).toContain('grant_type=refresh_token')
      expect(tokenBody).toContain('resource=https%3A%2F%2Fmcp.example%2Fmcp')
      expect(tokenBody).toContain('client_id=dyn-1')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
