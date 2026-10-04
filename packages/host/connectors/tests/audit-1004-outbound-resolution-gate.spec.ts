/**
 * Audit v2.8.2 → HEAD (2026-10-04), two in-range findings in
 * `packages/host/connectors/src/outbound.ts`:
 *
 * **C3-06 (P1)** — the DNS resolution gate was fail-OPEN: `catch { return }`
 * (`:419-421` of the audited revision) let a name through whenever the
 * resolver failed or ran past the gate's own budget, and nothing downstream
 * re-checks the address class (`outboundFetch` hands the URL to the global
 * `fetch`, the MCP transport fence hands it to undici; neither judges where a
 * NAME points). The audit's probe printed, verbatim:
 * ```
 * A name -> 169.254.169.254: REFUSED (OutboundUrlBlockedError)
 * B resolver throws EAI_AGAIN: ALLOWED (fail-open)
 * C slow answer (200ms) with 50ms budget -> 10.0.0.5: ALLOWED (fail-open)
 * ```
 * The code comment justified it with "the connection has its own deadline and
 * reports its own failure" — untrue, because the connection stack never judges
 * address classes. The gate is now fail-closed: the three unverifiable shapes
 * (resolver error / gate deadline / empty answer) are refused as
 * {@link OutboundResolutionUnverifiedError}, a DIFFERENT class+code from the
 * "resolution succeeded and the address is non-public" verdict, so a user
 * reading a connector row can tell "fix your DNS" from "this URL is refused".
 *
 * **C3-07 (P2)** — both address tables missed four siblings of the
 * already-refused `64:ff9b::/96`: `2002::/16` (6to4, wraps the IPv4 gateway —
 * `2002:7f00:1::` reaches 127.0.0.1, `2002:a9fe:a9fe::` reaches
 * 169.254.169.254), `2001::/32` (Teredo), `64:ff9b:1::/48` (local-use NAT64),
 * `fec0::/10` (deprecated site-local). Both tables now refuse all four, in the
 * same "refuse the whole prefix" 口径 as the sibling (reasoning on
 * `buildBlockedList`).
 *
 * Everything here runs the real functions. The resolver is injected (or, for
 * the fence — which has no seam by design — `node:dns/promises` is proxied so
 * the DEFAULT resolver is the one being exercised), and `fetch` is stubbed so
 * a refusal is proven by "the network stub was never called", not by absence of
 * an exception alone.
 *
 * Follow-up (same audit, adversarial verification round 2026-10-04): the
 * verifier found two criteria gaps in THIS suite and closed them here.
 *  - **gap ①** — nothing pinned the DEFAULT `OUTBOUND_RESOLUTION_TIMEOUT_MS`:
 *    the timeout case above injects `timeoutMs: 50`, so widening the default to
 *    an hour left 27/27 green while a hung resolver parks the plugin's serial
 *    lifecycle chain (the conn-1 accident the deadline exists for). The budget
 *    is now asserted against the constants themselves (ratio to the request
 *    deadline + a product ceiling), and separately the DEFAULT budget must
 *    really fire with no override.
 *  - **gap ②** — an answer whose SHAPE cannot be read had no semantics of its
 *    own: a bare `TypeError` for a non-list / non-string entry, and the
 *    "resolves to a non-public address" verdict for `['not-an-ip']` (the
 *    predicate's fail-closed default). All three shapes are now
 *    `resolution-malformed` — a refusal in the same family as empty/failed, so
 *    the row says "your DNS answer is unusable", not "your target is private".
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createMcpOutboundFetch } from '../src/mcp-transport-fence.ts'
import {
  assertResolvedOutboundAddressAllowed,
  isBlockedResolvedAddress,
  isOutboundUrlAllowed,
  outboundFetch,
  OUTBOUND_REQUEST_TIMEOUT_MS,
  OUTBOUND_RESOLUTION_TIMEOUT_MS,
  OutboundResolutionUnverifiedError,
  OutboundUrlBlockedError,
  type OutboundHostResolver,
} from '../src/outbound.ts'

/**
 * This suite observes connector outbound traffic through a `globalThis.fetch`
 * stub — the shape it always had. Since the DNS-rebinding fix (2026-10-04) the
 * production transport dials the policy's verified addresses itself
 * (`src/pinned-http.ts`) instead of handing the URL to the global fetch, so the
 * stub is installed as THAT transport's seam: the same observation, one level
 * lower. Every policy gate still runs here — the mock replaces the connection,
 * not the judgement — and the real transport is covered end to end by
 * `tests/audit-1004-pinned-address.spec.ts`, which does not mock it.
 */
vi.mock('../src/pinned-http.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/pinned-http.ts')>()
  return {
    ...actual,
    sendPinned: async (target: { url: URL }, init: RequestInit) => globalThis.fetch(target.url.href, init),
  }
})


/**
 * Proxy `node:dns/promises` so the module's DEFAULT resolver can be driven
 * deterministically, while every other import keeps the real implementation.
 * (The fence has no resolver seam ON PURPOSE — a connector definition must not
 * be able to replace the resolver the policy judges with — so breaking DNS
 * itself is the only way to exercise that call site. Delegating to the real
 * `lookup` when the state is untouched keeps the proxy honest.)
 */
const dnsState = vi.hoisted(() => ({
  fail: null as Error | null,
  answer: null as Array<{ address: string, family: number }> | null,
}))

vi.mock('node:dns/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns/promises')>()
  return {
    ...actual,
    lookup: (...args: unknown[]) => {
      if (dnsState.fail !== null) return Promise.reject(dnsState.fail)
      if (dnsState.answer !== null) return Promise.resolve(dnsState.answer)
      return (actual.lookup as (...forwarded: unknown[]) => unknown)(...args)
    },
  }
})

/** `fetch` stub that records what was requested; nothing leaves the process. */
function stubFetch(): string[] {
  const requested: string[] = []
  vi.stubGlobal('fetch', async (input: unknown) => {
    requested.push(String(input))
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  })
  return requested
}

afterEach(() => {
  dnsState.fail = null
  dnsState.answer = null
  vi.unstubAllGlobals()
})

describe('C3-06: an unverifiable NAME is refused, and nothing is fetched', () => {
  it('refuses when the resolver throws, and reports it as unverified', async () => {
    const requested = stubFetch()
    const error = await outboundFetch('https://idp.example.com/token', 'OAuth token 端点', {}, {
      resolve: async () => { throw Object.assign(new Error('getaddrinfo EAI_AGAIN'), { code: 'EAI_AGAIN' }) },
    }).catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(OutboundResolutionUnverifiedError)
    expect((error as OutboundResolutionUnverifiedError).code).toBe('resolution-failed')
    expect((error as Error).message, 'the refusal must name the host and the cause').toContain('idp.example.com')
    expect((error as Error).message).toContain('EAI_AGAIN')
    expect(requested, 'a refusal must happen before the request').toHaveLength(0)
  })

  it('refuses when the resolver outlives the gate budget', async () => {
    const requested = stubFetch()
    // Called directly, like the audit's probe: `outboundFetch`'s own
    // `timeoutMs` is the REQUEST deadline and deliberately does not shorten the
    // gate's separate 5 s resolution budget, so the short budget is injected
    // here rather than waiting 5 s.
    const error = await assertResolvedOutboundAddressAllowed(
      new URL('https://idp.example.com/token'),
      'OAuth token 端点',
      'zh',
      { resolve: () => new Promise<readonly string[]>(() => {}), timeoutMs: 50 },
    ).catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(OutboundResolutionUnverifiedError)
    expect((error as OutboundResolutionUnverifiedError).code).toBe('resolution-timeout')
    expect((error as Error).message).toContain('50ms')
    expect(requested).toHaveLength(0)
  })

  it('refuses when the resolver answers with no address at all', async () => {
    const requested = stubFetch()
    const error = await outboundFetch('https://idp.example.com/token', 'OAuth token 端点', {}, {
      resolve: async () => [],
    }).catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(OutboundResolutionUnverifiedError)
    expect((error as OutboundResolutionUnverifiedError).code).toBe('resolution-empty')
    expect(requested).toHaveLength(0)
  })

  it('still allows a NAME that resolves to a public address (the fix is not "refuse everything")', async () => {
    const requested = stubFetch()
    const response = await outboundFetch('https://idp.example.com/token', 'OAuth token 端点', {}, {
      resolve: async () => ['93.184.216.34'],
    })
    expect(response.status).toBe(200)
    expect(requested).toEqual(['https://idp.example.com/token'])
  })

  it('keeps the two refusal classes distinguishable (blocked address vs unverified name)', async () => {
    stubFetch()
    const blocked = await outboundFetch('https://idp.example.com/token', 'OAuth token 端点', {}, {
      resolve: async () => ['10.0.0.5'],
    }).catch((cause: unknown) => cause)
    const unverified = await outboundFetch('https://idp.example.com/token', 'OAuth token 端点', {}, {
      resolve: async () => { throw new Error('SERVFAIL') },
    }).catch((cause: unknown) => cause)

    expect(blocked).toBeInstanceOf(OutboundUrlBlockedError)
    expect(blocked, 'a blocked ADDRESS is not an unverified NAME').not.toBeInstanceOf(OutboundResolutionUnverifiedError)
    expect(unverified).toBeInstanceOf(OutboundResolutionUnverifiedError)
    expect(unverified, 'an unverified NAME is not a blocked ADDRESS').not.toBeInstanceOf(OutboundUrlBlockedError)
    expect((blocked as Error).message).not.toBe((unverified as Error).message)
    for (const message of [(blocked as Error).message, (unverified as Error).message]) {
      expect(message).toContain('idp.example.com')
    }
  })
})

describe('C3-06: the legal fast paths survive (the hot path does not resolve what it must not)', () => {
  it('never resolves an IP literal, 127/8 or localhost', async () => {
    const requested = stubFetch()
    let calls = 0
    const resolve: OutboundHostResolver = async () => {
      calls += 1
      throw new Error('the resolver must not be reached for a literal or localhost')
    }
    // 93.184.216.34 is a public LITERAL: the syntax rule already classified it.
    await expect(outboundFetch('https://93.184.216.34/token', 'OAuth token 端点', {}, { resolve }))
      .resolves.toBeInstanceOf(Response)
    await expect(outboundFetch('http://127.0.0.1:9/mcp', 'MCP 端点', {}, { resolve }))
      .resolves.toBeInstanceOf(Response)
    // `localhost` / `*.localhost` are RFC 6761 loopback names (the syntax rule
    // returns `loopback`, which is what allows plain http to a local server).
    await expect(outboundFetch('http://localhost:9/mcp', 'MCP 端点', {}, { resolve }))
      .resolves.toBeInstanceOf(Response)

    expect(calls, 'none of the three fast paths may touch DNS').toBe(0)
    expect(requested).toHaveLength(3)
  })
})

describe('C3-06: the fence call site (every MCP transport request) shares the same verdict', () => {
  it('refuses a request whose name cannot be verified, before the base fetch', async () => {
    const seen: string[] = []
    const base = async (input: unknown): Promise<Response> => {
      seen.push(String(input))
      return new Response('', { status: 200 })
    }
    const fenced = createMcpOutboundFetch({
      base,
      ownUrl: () => new URL('http://127.0.0.1:9/mcp'),
      locale: () => 'zh',
    })

    dnsState.fail = Object.assign(new Error('getaddrinfo EAI_AGAIN'), { code: 'EAI_AGAIN' })
    await expect(fenced('https://unverifiable.example/mcp', { method: 'GET' }))
      .rejects.toBeInstanceOf(OutboundResolutionUnverifiedError)
    expect(seen, 'the transport must not reach the base fetch').toHaveLength(0)

    // Control A — the mock really is the resolver this gate consults: an answer
    // of 10.0.0.5 must be judged (and refused as a blocked ADDRESS, the other
    // class), which cannot happen if the gate never looked at the answer.
    dnsState.fail = null
    dnsState.answer = [{ address: '10.0.0.5', family: 4 }]
    await expect(fenced('https://unverifiable.example/mcp', { method: 'GET' }))
      .rejects.toBeInstanceOf(OutboundUrlBlockedError)
    expect(seen).toHaveLength(0)

    // Control B — with a public answer the very same wrapper lets the request
    // through, so the refusals above are the verdict and not a broken wrapper.
    dnsState.answer = [{ address: '93.184.216.34', family: 4 }]
    await expect(fenced('https://unverifiable.example/mcp', { method: 'GET' })).resolves.toBeInstanceOf(Response)
    expect(seen).toEqual(['https://unverifiable.example/mcp'])
  })
})

describe('C3-07: the IPv6 transition/translation prefixes are refused on the resolved-name path', () => {
  const refused: ReadonlyArray<readonly [string, string]> = [
    ['2002:7f00:1::', '6to4 wrapping 127.0.0.1'],
    ['2002:a9fe:a9fe::', '6to4 wrapping 169.254.169.254'],
    ['2001::1', 'Teredo'],
    ['64:ff9b:1::1', 'local-use NAT64 (RFC 8215)'],
    ['fec0::1', 'deprecated site-local (RFC 3879)'],
    ['64:ff9b::a00:1', 'well-known NAT64 — refused since v2.8.1, kept as the sibling baseline'],
  ]
  it.each(refused)('refuses %s (%s)', (address) => {
    expect(isBlockedResolvedAddress(address)).toBe(true)
  })

  const allowed: ReadonlyArray<readonly [string, string]> = [
    ['2606:4700:4700::1111', 'Cloudflare'],
    ['2001:4860:4860::8888', 'public address INSIDE 2001::/16 but outside the Teredo /32'],
    ['2a00:1450:4001:80a::200e', 'Google'],
    ['198.18.0.1', 'fake-IP range the resolved-name table deliberately allows'],
    ['2001:db8::1', 'documentation range: refused as a LITERAL, allowed for a resolved NAME (the two tables stay different on purpose)'],
    ['93.184.216.34', 'public IPv4'],
  ]
  it.each(allowed)('still allows %s (%s)', (address) => {
    expect(isBlockedResolvedAddress(address)).toBe(false)
  })

  it('the 6to4 fixtures really wrap the private targets the finding named', () => {
    // Fixture self-check (not a re-implementation of the policy): C3-07's
    // evidence is about the EMBEDDED address, so the wrapped forms used above
    // must be shown to carry 127.0.0.1 / 169.254.169.254 and not some harmless
    // address that would make the refusal above vacuous.
    const embedded = (address: string): string => {
      const groups = address.split(':').slice(1, 3).map(group => Number.parseInt(group, 16))
      return [groups[0] >> 8, groups[0] & 0xff, groups[1] >> 8, groups[1] & 0xff].join('.')
    }
    expect(embedded('2002:7f00:1::')).toBe('127.0.0.1')
    expect(embedded('2002:a9fe:a9fe::')).toBe('169.254.169.254')
  })
})

describe('C3-07: the same spellings are refused as URL literals and never leave the process', () => {
  const literals = [
    'https://[2002:7f00:1::]/',
    'https://[2002:a9fe:a9fe::]/',
    'https://[2001::1]/',
    'https://[64:ff9b:1::1]/',
    'https://[fec0::1]/',
  ]
  it.each(literals)('isOutboundUrlAllowed(%s) === false', (url) => {
    expect(isOutboundUrlAllowed(url)).toBe(false)
  })

  it('does not refuse public IPv6 literals (the tables are not "block all IPv6")', () => {
    expect(isOutboundUrlAllowed('https://[2606:4700:4700::1111]/')).toBe(true)
    expect(isOutboundUrlAllowed('https://[2001:4860:4860::8888]/')).toBe(true)
  })

  it('outboundFetch refuses them by the syntax rule, without resolving and without fetching', async () => {
    const requested = stubFetch()
    let calls = 0
    const resolve: OutboundHostResolver = async () => {
      calls += 1
      return ['93.184.216.34']
    }
    for (const url of ['https://[2002:7f00:1::]/', 'https://[fec0::1]/']) {
      const error = await outboundFetch(url, 'MCP 端点', {}, { resolve }).catch((cause: unknown) => cause)
      expect(error, url).toBeInstanceOf(OutboundUrlBlockedError)
      expect(error, url).not.toBeInstanceOf(OutboundResolutionUnverifiedError)
    }
    expect(calls, 'a blocked literal is decided before DNS').toBe(0)
    expect(requested).toHaveLength(0)
  })
})

/**
 * Gap ② of the adversarial verification (2026-10-04): the gate must answer for
 * EVERY shape a resolver can hand back, and the answer for an unreadable one is
 * "could not verify" — never a crash, and never a verdict about the target.
 *
 * The three illegal shapes the verifier exercised, each as its own fixture:
 *  1. the answer is not a list at all;
 *  2. a list entry is not a string;
 *  3. a list entry is a string that is not an IP literal (`['not-an-ip']`).
 */
describe('C3-06 gap ②: an unreadable ANSWER SHAPE is refused as unverified, never as a blocked address', () => {
  const illegalAnswers: Array<[unknown, string]> = [
    // 1. not a list
    [undefined, 'undefined'],
    [null, 'null'],
    [123, 'a number'],
    ['93.184.216.34', 'a bare string, which is not a list of one'],
    [{ address: '93.184.216.34', family: 4 }, 'a single lookup record instead of a list'],
    // 2. a list entry that is not a string
    [[undefined], 'a list holding undefined'],
    [[123], 'a list holding a number'],
    [[null], 'a list holding null'],
    [[{ address: '10.0.0.5', family: 4 }], 'a list holding an object'],
    [['93.184.216.34', 42], 'a public address followed by junk'],
    // 3. a string entry that is not an IP literal
    [['not-an-ip'], 'a string that is not an IP'],
    [['93.184.216.34', 'not-an-ip'], 'a public address followed by a non-IP string'],
    [[''], 'an empty string entry'],
  ]

  it.each(illegalAnswers)('refuses %j (%s) as resolution-malformed, before any fetch', async (answer) => {
    const requested = stubFetch()
    const error = await outboundFetch('https://idp.example.com/token', 'OAuth token 端点', {}, {
      resolve: async () => answer as readonly string[],
    }).catch((cause: unknown) => cause)

    expect(error, 'a bare TypeError is not an outcome the row can report').toBeInstanceOf(OutboundResolutionUnverifiedError)
    expect((error as OutboundResolutionUnverifiedError).code).toBe('resolution-malformed')
    expect(error, 'an unreadable answer is not a verdict about the target')
      .not.toBeInstanceOf(OutboundUrlBlockedError)
    expect((error as Error).message.split('->'), 'the row must not claim the host resolved somewhere')
      .toHaveLength(1)
    expect((error as Error).message).toContain('idp.example.com')
    expect(requested, 'a refusal must happen before the request').toHaveLength(0)
  })

  it('keeps the malformed refusal distinguishable from an empty answer and from a blocked address', async () => {
    stubFetch()
    const malformed = await outboundFetch('https://idp.example.com/token', 'OAuth token 端点', {}, {
      resolve: async () => ['not-an-ip'],
    }).catch((cause: unknown) => cause)
    const empty = await outboundFetch('https://idp.example.com/token', 'OAuth token 端点', {}, {
      resolve: async () => [],
    }).catch((cause: unknown) => cause)
    const blocked = await outboundFetch('https://idp.example.com/token', 'OAuth token 端点', {}, {
      resolve: async () => ['10.0.0.5'],
    }).catch((cause: unknown) => cause)

    const codes = [malformed, empty, blocked].map((error: unknown) => (error as { code?: string }).code)
    expect(codes, 'three different facts, three different reports').toEqual([
      'resolution-malformed',
      'resolution-empty',
      undefined, // OutboundUrlBlockedError carries no `code`
    ])
    for (const error of [malformed, empty]) {
      expect(error).toBeInstanceOf(OutboundResolutionUnverifiedError)
      expect(error).not.toBeInstanceOf(OutboundUrlBlockedError)
    }
    expect(blocked).toBeInstanceOf(OutboundUrlBlockedError)
  })

  it('keeps the exported predicate fail-closed for a value it cannot read', () => {
    // The gate no longer routes unreadable entries here (they are classified
    // above), but a direct caller of the predicate must still be refused rather
    // than told "this value is fine".
    expect(isBlockedResolvedAddress('not-an-ip')).toBe(true)
    expect(isBlockedResolvedAddress('10.0.0.5')).toBe(true)
    expect(isBlockedResolvedAddress('93.184.216.34')).toBe(false)
  })
})

/**
 * Gap ① of the adversarial verification (2026-10-04): the gate's DEFAULT budget
 * is a product bound, not an implementation detail.
 *
 * The gate runs BEFORE the request's own deadline (`outboundFetch` resolves the
 * name, then arms `AbortSignal.timeout`) and on the plugin's single serial
 * lifecycle chain, so a default widened to "an hour" parks exactly the work the
 * deadline exists to protect — while every other case in this suite stays green,
 * because they all inject `timeoutMs` (the fence and `outboundFetch` sites never
 * pass one). Both halves below therefore read the REAL constants; the ceiling is
 * the only literal, on purpose (see its comment).
 */
describe('C3-06 gap ①: the DEFAULT resolution budget is bounded, and it really fires', () => {
  /**
   * Product ceiling for the gate's own budget, in milliseconds.
   *
   * Deliberately a literal of THIS file and not `OUTBOUND_RESOLUTION_TIMEOUT_MS`:
   * a criterion that waits/advances by the constant under test scales with the
   * mutation it is supposed to catch — with the default widened to an hour, a
   * fake clock advanced by "the constant + 1" would fire the timer and stay
   * green. That is precisely how the verifier's mutation ③ passed 27/27.
   */
  const RESOLUTION_BUDGET_CEILING_MS = 10_000

  it('keeps the gate budget a fraction of ONE request deadline, and under the ceiling', () => {
    expect(OUTBOUND_RESOLUTION_TIMEOUT_MS).toBeGreaterThan(0)
    expect(
      OUTBOUND_RESOLUTION_TIMEOUT_MS,
      'the gate runs inside the request deadline: it must stay well below it',
    ).toBeLessThanOrEqual(OUTBOUND_REQUEST_TIMEOUT_MS / 2)
    expect(OUTBOUND_RESOLUTION_TIMEOUT_MS).toBeLessThanOrEqual(RESOLUTION_BUDGET_CEILING_MS)
  })

  it('refuses a never-answering resolver inside the DEFAULT budget (no timeoutMs override)', async () => {
    vi.useFakeTimers()
    try {
      let outcome: unknown = 'still-pending'
      void assertResolvedOutboundAddressAllowed(
        new URL('https://hung.example/token'),
        'OAuth token 端点',
        'zh',
        { resolve: () => new Promise<readonly string[]>(() => {}) },
      ).then(
        () => { outcome = 'resolved' },
        (cause: unknown) => { outcome = cause },
      )

      // Bounded by the CEILING, never by the constant under test.
      await vi.advanceTimersByTimeAsync(RESOLUTION_BUDGET_CEILING_MS + 1)
      await Promise.resolve()

      expect(
        outcome,
        'the default budget must fire on its own; a still-pending gate parks the serial lifecycle chain',
      ).toBeInstanceOf(OutboundResolutionUnverifiedError)
      const error = outcome as OutboundResolutionUnverifiedError
      expect(error.code).toBe('resolution-timeout')
      expect(
        error.message,
        'the budget that fired must be the DECLARED default',
      ).toContain(`${OUTBOUND_RESOLUTION_TIMEOUT_MS}ms`)
    } finally {
      vi.useRealTimers()
    }
  })
})
