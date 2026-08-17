import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
      // (the loopback server) with a code.
      const flow = runAuth(def, {
        onRequest: (request) => {
          authorizeUrl = request.authorizeUrl ?? ''
          if (authorizeUrl) {
            const callback = new URL(authorizeUrl).searchParams.get('redirect_uri') ?? ''
            void fetch(callback + '?code=auth-code-1')
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

  it('parses the dingtalk device flow from the CLI output and surfaces it', async () => {
    const def: ConnectorDef = {
      id: 'dingtalk',
      name: 'DingTalk',
      description: 'x',
      authMode: 'cli',
      auth: {
        command: process.execPath,
        args: [join(import.meta.dirname, 'fixtures', 'device-flow-cli.mjs')],
        deviceFlow: {
          uriPattern: 'https://login\\.dingtalk\\.com/oauth2/device/verify\\.htm[^\\s\\n\\r"\'<>]*',
          codePattern: '(?:授权码|user_code=|user_code：)\\s*:?\\s*([A-Z0-9][A-Z0-9-]*)',
        },
        authWaitForExit: true,
      },
      mcp: [],
    }
    const requests: Array<{ verificationUrl?: string; userCode?: string }> = []
    const patch = await runAuth(def, {
      onRequest: (request) => {
        if (request.verificationUrl) requests.push({ verificationUrl: request.verificationUrl, userCode: request.userCode })
      },
      signal: new AbortController().signal,
    })
    expect(requests.length).toBe(1)
    expect(requests[0]?.verificationUrl).toBe('https://login.dingtalk.com/oauth2/device/verify.htm')
    expect(requests[0]?.userCode).toBe('CCBP-BNLQ')
    expect(patch.updatedAt).toBeTruthy()
  })
})
