/**
 * Guard for `patches/dsh-mcp-client@<pin>.patch` — the SHIPPED bridge.
 *
 * The MCP authorization spec (2025-06-18) puts token refresh in the hands of
 * the transport's `OAuthClientProvider`. `dsh-mcp-client` builds that transport
 * from its resolved plugin config, so the provider has to survive TWO steps:
 *
 *  1. the config schema must not strip it (Schemastery drops undeclared keys,
 *     and only an explicitly declared `z.any()` keeps a function value);
 *  2. `createTransport` must hand it to `StreamableHTTPClientTransport` —
 *     together with `requestInit: { headers: config.headers }`, in the SAME
 *     options object.
 *
 * Both steps are invisible at runtime when they regress — connectors would just
 * go back to a one-shot bearer header and start failing after the token expires
 * — so this test pins them.
 *
 * The SUBJECT of this file is the resolved artefact
 * (`createRequire(import.meta.url).resolve('@deepseek-ai/dsh-mcp-client')`, the
 * patched install the packager copies into `app.asar`), never a re-transcription
 * of the construction inside the test: a test that rebuilds the transport out of
 * `config.headers` asserts its own copy of the shape, and does so even while the
 * shipped bundle has lost the half it is checking. That is not hypothetical —
 * R8-B-3 mutated the artefact's `requestInit` half and every repo test,
 * including this file's two original assertions, stayed green, while a
 * static-token connector got 401 on its FIRST request (the only other place the
 * header can come from is `requestInit`). The negative controls at the bottom
 * run the same verdict over mutated copies of that artefact text, so the guard
 * itself proves it has teeth instead of only claiming it.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { Config } from '@deepseek-ai/dsh-mcp-client'
// Upstream 0.1.6-alpha.2 moved `dsh-mcp-client` from `@modelcontextprotocol/sdk@1.x`
// to `@modelcontextprotocol/client@2.0.0`, so the provider this patch hands to
// `StreamableHTTPClientTransport` is the v2 `OAuthClientProvider` (the root entry
// exports it; v2 has no `./client/*` subpaths).
import type { OAuthClientProvider } from '@modelcontextprotocol/client'

/**
 * The ONE streamable-http transport construction, as the patch writes it.
 *
 * Non-greedy on purpose: it captures the options literal up to the literal's
 * own closing `});`, so "both halves are in the same object" is a property of
 * the capture rather than of the whole file. A bundle that constructs the
 * transport some other way (a helper, an options object built earlier) cannot be
 * located at all — which the verdict below treats as a failure, not as a pass.
 */
const STREAMABLE_HTTP_CALL =
  /case "streamable-http":\s*return new StreamableHTTPClientTransport\(new URL\(config\.url\),\s*\{([\s\S]*?)\}\);/u

/** What the shipped construction carries. */
export interface StreamableHttpShape {
  /** The options literal of that construction, verbatim. */
  options: string
  /** `requestInit: { headers: config.headers }` present inside that literal. */
  headersHalf: boolean
  /** `authProvider: config.authProvider` present inside the SAME literal. */
  providerHalf: boolean
}

/**
 * Read the shipped construction out of a bundle text.
 * @param bundle - the bridge artefact's source.
 * @returns the options literal plus which halves it carries.
 * @throws when the construction cannot be located (a reshaped bundle).
 */
export function streamableHttpShape(bundle: string): StreamableHttpShape {
  const match = STREAMABLE_HTTP_CALL.exec(bundle)
  if (match === null) {
    throw new Error('no `case "streamable-http": return new StreamableHTTPClientTransport(new URL(config.url), { … });` in the bundle')
  }
  const options = match[1] ?? ''
  return {
    options,
    headersHalf: /requestInit:\s*\{\s*headers:\s*config\.headers,?\s*\}/u.test(options),
    providerHalf: /(?:^|[\s{,])authProvider:\s*config\.authProvider\b/u.test(options),
  }
}

/**
 * What this file's assertions conclude about one bridge artefact.
 * @param bundle - the bridge artefact's source.
 * @returns `ok` plus the reason it is not ok (used in the failure message).
 */
export function guardVerdict(bundle: string): { ok: boolean, reason: string } {
  try {
    const shape = streamableHttpShape(bundle)
    if (!shape.headersHalf) return { ok: false, reason: 'requestInit.headers 半边不在 options 里' }
    if (!shape.providerHalf) return { ok: false, reason: 'authProvider 半边不在同一个 options 里' }
    return { ok: true, reason: 'ok' }
  } catch (error) {
    return { ok: false, reason: String(error) }
  }
}

describe('dsh-mcp-client authProvider pass-through (patch guard)', () => {
  it('keeps a function-valued authProvider through config normalization', () => {
    // Only the identity of the value matters here: the schema must return the
    // very object it was handed (a real provider is built by the caller).
    const provider = { tokens: () => ({ access_token: 'at-1' }) } as unknown as OAuthClientProvider
    const parsed = Config({
      transport: 'streamable-http',
      serverName: 'example-mcp',
      url: 'https://mcp.example.com/mcp',
      authProvider: provider,
    } as never) as { authProvider?: unknown, headers?: Record<string, string> }
    expect(parsed.authProvider).toBe(provider)
    // The one-shot headers path still works for connectors without OAuth.
    expect(parsed.headers).toEqual({})
  })

  it('the SHIPPED bundle carries BOTH halves in one options object', () => {
    // `createRequire` resolves from THIS file, so the subject is the installed,
    // patched artefact — the same bytes electron-builder copies into app.asar.
    const entry = createRequire(import.meta.url).resolve('@deepseek-ai/dsh-mcp-client')
    const bundle = readFileSync(entry, 'utf8')
    expect(bundle).toContain('authProvider: z.any()')
    // `createTransport` is not exported, so the shippable artefact itself is
    // asserted: the patch must keep the provider out of the config and inside
    // the SDK transport options. Both halves shipped together in the patch.
    expect(bundle).toContain('authProvider: config.authProvider')
    const shape = streamableHttpShape(bundle)
    expect(shape.headersHalf, '随包 bridge 丢了 requestInit.headers 半边').toBe(true)
    expect(shape.providerHalf, '随包 bridge 丢了 authProvider 半边').toBe(true)
    // The header value must still be the CONFIG's headers (the object the host
    // renders, including the framework's own bearer removal) — `{}` would make
    // the static-token/ApiKey class unauthenticated on its first request.
    expect(shape.options).toContain('headers: config.headers')
  })

  it('every mutation of those halves turns the guard red (negative controls)', () => {
    const entry = createRequire(import.meta.url).resolve('@deepseek-ai/dsh-mcp-client')
    const shipped = readFileSync(entry, 'utf8')
    const mutations: Array<{ name: string, bundle: string }> = [
      { name: 'requestInit 被清空', bundle: shipped.replace('requestInit: { headers: config.headers }', 'requestInit: {}') },
      { name: 'requestInit.headers 指向空对象', bundle: shipped.replace('requestInit: { headers: config.headers }', 'requestInit: { headers: {} }') },
      { name: 'requestInit 整个键被删掉', bundle: shipped.replace(/\s*requestInit: \{ headers: config\.headers \},/u, '') },
      { name: 'authProvider 半边被删掉', bundle: shipped.replace(/\s*\.\.\.config\.authProvider === undefined \? \{\} : \{ authProvider: config\.authProvider \}/u, '') },
      { name: '构造被搬进辅助函数（形状无法定位）', bundle: shipped.replace('case "streamable-http": return new StreamableHTTPClientTransport(new URL(config.url), {', 'case "streamable-http": return makeStreamableHttp(config, {') },
    ]
    // Positive control first: the unmutated artefact passes the SAME verdict.
    expect(guardVerdict(shipped).ok, '未变异的随包产物必须通过判据').toBe(true)
    for (const { name, bundle } of mutations) {
      expect(bundle, `mutation「${name}」必须真的改动产物文本`).not.toBe(shipped)
      const verdict = guardVerdict(bundle)
      expect(verdict.ok, `mutation「${name}」必须让守卫红（实际判定：${verdict.reason}）`).toBe(false)
    }
  })
})
