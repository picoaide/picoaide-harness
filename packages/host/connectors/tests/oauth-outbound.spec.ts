/**
 * FIX-20 (P1) regression: OAuth discovery must not follow remote-supplied URLs
 * to private / link-local / metadata targets.
 *
 * The whole chain is remote-controlled: the MCP endpoint answers 401 with a
 * `WWW-Authenticate: resource_metadata=…` URL, that document names an
 * `authorization_servers[0]`, and the RFC 8414 document names the authorize and
 * token endpoints. Before the fix every one of those URLs went straight into
 * `fetch`, so the authorization code plus the PKCE verifier were POSTed to
 * whatever host the first hop chose.
 *
 * The tests stub `fetch` for the remote hops but use the REAL loopback callback
 * server the flow opens, exactly like the audit reproduction.
 */
import { describe, expect, it, vi } from 'vitest'
import { runAuth } from '../src/auth.ts'
import type { ConnectorDef } from '../src/types.ts'

interface Recorder {
  calls: Array<{ url: string; body: string }>
  restore: () => void
}

/** Stub global fetch, recording every call (the real loopback server is still hit through it). */
function stubFetch(handler: (url: string, init?: RequestInit) => Response): Recorder {
  const originalFetch = globalThis.fetch
  const recorder: Recorder = {
    calls: [],
    restore: () => { globalThis.fetch = originalFetch },
  }
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    recorder.calls.push({ url, body: typeof init?.body === 'string' ? init.body : String(init?.body ?? '') })
    // The flow's own loopback callback server is real: let that traffic through.
    if (url.startsWith('http://127.0.0.1')) return originalFetch(input, init)
    return handler(url, init)
  }) as typeof fetch
  return recorder
}

function mcpDef(discoveryUrl: string): ConnectorDef {
  return {
    id: 'evil-mcp',
    name: 'Evil MCP',
    description: 'x',
    authMode: 'oauth',
    auth: {
      authorizeUrl: '',
      tokenUrl: '',
      clientId: 'static-client',
      redirectUri: 'http://127.0.0.1/callback',
      pkce: true,
      publicClient: true,
      discoveryUrl,
    },
    mcp: [{ serverName: 'evil-mcp', transport: 'streamable-http', url: discoveryUrl }],
  }
}

/**
 * The hostile chain: the MCP endpoint advertises its metadata through the
 * link-local address (the AWS/GCP metadata service), which then "issues" a
 * complete RFC 8414 document pointing back at the same host.
 */
function hostileChain(tokenHost = '169.254.169.254'): (url: string) => Response {
  return (url: string): Response => {
    if (url.includes('/.well-known/oauth-protected-resource') || url.includes('meta-data')) {
      return new Response(JSON.stringify({ authorization_servers: [`http://${tokenHost}`] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (url.includes('/.well-known/oauth-authorization-server')) {
      return new Response(JSON.stringify({
        authorization_endpoint: `http://${tokenHost}/authorize`,
        token_endpoint: `http://${tokenHost}/token`,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    // The MCP probe: 401 with the attacker-chosen metadata URL.
    return new Response('unauthorized', {
      status: 401,
      headers: {
        'WWW-Authenticate': 'Bearer resource_metadata="http://169.254.169.254/latest/meta-data/oauth-protected-resource"',
        'Content-Type': 'text/plain',
      },
    })
  }
}

describe('FIX-20 oauth discovery outbound policy', () => {
  it('refuses a resource_metadata URL aimed at the link-local metadata service', async () => {
    const recorder = stubFetch(hostileChain())
    try {
      const flow = runAuth(mcpDef('https://mcp.evil.example/mcp'), {
        onRequest: () => { /* must never emit an attacker authorize URL */ },
        signal: new AbortController().signal,
      })
      await expect(flow).rejects.toThrow(/出站|内网|链路本地|元数据/)
      expect(recorder.calls.filter(call => call.url.includes('169.254.169.254'))).toEqual([])
    } finally {
      recorder.restore()
    }
  })

  it('never POSTs the authorization code or PKCE verifier to a private-network token endpoint', async () => {
    const recorder = stubFetch(hostileChain('10.11.12.13'))
    try {
      const flow = runAuth(mcpDef('https://mcp.evil.example/mcp'), {
        onRequest: (request) => {
          // If an authorize URL ever escaped, drive the real loopback callback
          // so the token exchange (the leak) actually happens.
          const authorizeUrl = request.authorizeUrl
          if (authorizeUrl === undefined) return
          const callback = new URL(authorizeUrl).searchParams.get('redirect_uri') ?? ''
          const state = new URL(authorizeUrl).searchParams.get('state') ?? ''
          if (callback !== '') void fetch(`${callback}?code=THE-AUTH-CODE&state=${encodeURIComponent(state)}`)
        },
        signal: new AbortController().signal,
      })
      await expect(flow).rejects.toThrow(/出站|内网|链路本地|元数据/)
      const leaked = recorder.calls.filter(call => call.body.includes('code_verifier') || call.body.includes('THE-AUTH-CODE'))
      expect(leaked).toEqual([])
      expect(recorder.calls.filter(call => call.url.includes('10.11.12.13'))).toEqual([])
    } finally {
      recorder.restore()
    }
  })

  it('blocks a hostile authorize endpoint before the browser is sent anywhere', async () => {
    const recorder = stubFetch((url: string) => {
      if (url.endsWith('/.well-known/oauth-protected-resource')) {
        return new Response(JSON.stringify({ authorization_servers: ['https://as.example'] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url.endsWith('/.well-known/oauth-authorization-server')) {
        return new Response(JSON.stringify({
          authorization_endpoint: 'http://192.168.0.10/authorize',
          token_endpoint: 'https://as.example/token',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response('unauthorized', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Bearer resource_metadata="https://mcp.evil.example/.well-known/oauth-protected-resource"' },
      })
    })
    const seen: string[] = []
    try {
      const flow = runAuth(mcpDef('https://mcp.evil.example/mcp'), {
        onRequest: (request) => { if (request.authorizeUrl) seen.push(request.authorizeUrl) },
        signal: new AbortController().signal,
      })
      await expect(flow).rejects.toThrow(/出站|内网|链路本地|元数据/)
      expect(seen).toEqual([])
    } finally {
      recorder.restore()
    }
  })

  it('refuses a remote registration endpoint outside the policy', async () => {
    const recorder = stubFetch((url: string) => {
      if (url.endsWith('/.well-known/oauth-protected-resource')) {
        return new Response(JSON.stringify({ authorization_servers: ['https://as.example'] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url.endsWith('/.well-known/oauth-authorization-server')) {
        return new Response(JSON.stringify({
          authorization_endpoint: 'https://as.example/authorize',
          token_endpoint: 'https://as.example/token',
          registration_endpoint: 'http://127.0.0.1:1/register',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response('unauthorized', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Bearer resource_metadata="https://mcp.evil.example/.well-known/oauth-protected-resource"' },
      })
    })
    try {
      // A loopback registration endpoint is allowed by the policy, but it must
      // be *checked*: the flow reaches the (nonexistent) local server and fails
      // there instead of registering with a remote host.
      const flow = runAuth(mcpDef('https://mcp.evil.example/mcp'), {
        onRequest: () => {},
        signal: new AbortController().signal,
      })
      await expect(flow).rejects.toThrow()
      expect(recorder.calls.some(call => call.url.includes('127.0.0.1:1/register'))).toBe(true)
    } finally {
      recorder.restore()
    }
  })

  it('still completes a legitimate public https discovery flow', async () => {
    const recorder = stubFetch((url: string) => {
      if (url.endsWith('/.well-known/oauth-protected-resource')) {
        return new Response(JSON.stringify({ authorization_servers: ['https://as.example'] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url.endsWith('/.well-known/oauth-authorization-server')) {
        return new Response(JSON.stringify({
          authorization_endpoint: 'https://as.example/authorize',
          token_endpoint: 'https://as.example/token',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url.endsWith('/token')) {
        return new Response(JSON.stringify({ access_token: 'at-discovered' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response('unauthorized', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Bearer resource_metadata="https://mcp.example/.well-known/oauth-protected-resource"' },
      })
    })
    try {
      const flow = runAuth(mcpDef('https://mcp.example/mcp'), {
        onRequest: (request) => {
          const authorizeUrl = request.authorizeUrl
          if (authorizeUrl === undefined) return
          const callback = new URL(authorizeUrl).searchParams.get('redirect_uri') ?? ''
          const state = new URL(authorizeUrl).searchParams.get('state') ?? ''
          void fetch(`${callback}?code=GOOD-CODE&state=${encodeURIComponent(state)}`)
        },
        signal: new AbortController().signal,
      })
      const patch = await flow
      expect(patch.accessToken).toBe('at-discovered')
      expect(recorder.calls.some(call => call.url === 'https://as.example/token' && call.body.includes('GOOD-CODE'))).toBe(true)
    } finally {
      recorder.restore()
    }
  })
})
