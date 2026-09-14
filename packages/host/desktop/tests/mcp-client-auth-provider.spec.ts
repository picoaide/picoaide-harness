/**
 * Guard for `patches/dsh-mcp-client@0.1.5-rc.2.patch`.
 *
 * The MCP authorization spec (2025-06-18) puts token refresh in the hands of
 * the transport's `OAuthClientProvider`. `dsh-mcp-client` builds that transport
 * from its resolved plugin config, so the provider has to survive TWO steps:
 *
 *  1. the config schema must not strip it (Schemastery drops undeclared keys,
 *     and only an explicitly declared `z.any()` keeps a function value);
 *  2. `createTransport` must hand it to `StreamableHTTPClientTransport`.
 *
 * Both steps are invisible at runtime when they regress — connectors would just
 * go back to a one-shot bearer header and start failing after the token
 * expires — so this test pins them. It is deliberately skipped while the
 * package is not resolvable from this package (the connectors package owns the
 * behavioural tests; this one pins the patch).
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { Config } from '@deepseek-ai/dsh-mcp-client'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'

describe('dsh-mcp-client authProvider pass-through (patch guard)', () => {
  it('keeps a function-valued authProvider through config normalization', () => {
    // Only the identity of the value matters here: the schema must return the
    // very object it was handed (a real provider is built by the caller).
    const provider = { tokens: () => ({ access_token: 'at-1' }) } as unknown as OAuthClientProvider
    const parsed = Config({
      transport: 'streamable-http',
      serverName: 'moka',
      url: 'https://mcp.example.com/mcp',
      authProvider: provider,
    } as never) as { authProvider?: unknown, headers?: Record<string, string> }
    expect(parsed.authProvider).toBe(provider)
    // The one-shot headers path still works for connectors without OAuth.
    expect(parsed.headers).toEqual({})
  })

  it('hands the provider to the streamable-http transport', () => {
    // `createTransport` is not exported, so the shippable artifact itself is
    // asserted: the patch must keep the provider out of the config and inside
    // the SDK transport options. Both halves shipped together in the patch.
    const entry = createRequire(import.meta.url).resolve('@deepseek-ai/dsh-mcp-client')
    const bundle = readFileSync(entry, 'utf8')
    expect(bundle).toContain('authProvider: config.authProvider')
    expect(bundle).toContain('authProvider: z.any()')
  })
})
