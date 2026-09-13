/**
 * Audit R3 residual N4: the client-side outbound-URL verdict table.
 *
 * R3 measured 24 divergences between this policy and the Go
 * `connectorURLAllowed` mirror. Every divergence in the "Go is wider" direction
 * is a segment the CLIENT must refuse; this table pins the client's verdict for
 * all of them (plus the loopback/metadata/scheme/authority families the policy
 * exists for), so the client side can be compared against the server side case
 * by case without re-deriving it from the implementation.
 *
 * The second, stronger assertion is the invariant that makes the
 * normalization-driven divergences harmless: the verdict is computed on the
 * WHATWG-parsed URL, i.e. on the exact host `fetch` will connect to. A raw
 * spelling that normalizes onto a refused host is refused, and one that
 * normalizes onto loopback is judged as loopback — never the other way round.
 */
import { hostname } from 'node:os'
import { describe, expect, it } from 'vitest'
import { assertOutboundUrlAllowed, isOutboundUrlAllowed, OutboundUrlBlockedError } from '../src/outbound.ts'

type Verdict = 'allow' | 'deny'

interface Case {
  url: string
  verdict: Verdict
  /** Why this verdict — the category the policy decision comes from. */
  why: string
}

/** Loopback names/literals over http: the one non-public range that is allowed. */
const LOOPBACK: Case[] = [
  { url: 'http://localhost/', verdict: 'allow', why: 'RFC 6761 loopback name' },
  { url: 'http://localhost:3000/mcp', verdict: 'allow', why: 'loopback name with port' },
  { url: 'http://LOCALHOST/', verdict: 'allow', why: 'case-insensitive loopback name' },
  { url: 'http://LocalHost.:9090/', verdict: 'allow', why: 'FQDN root dot' },
  { url: 'http://sub.localhost/mcp', verdict: 'allow', why: '*.localhost' },
  { url: 'http://a.b.localhost/', verdict: 'allow', why: 'nested *.localhost' },
  { url: 'http://127.0.0.1/mcp', verdict: 'allow', why: '127/8 literal' },
  { url: 'http://127.0.0.1:8923/mcp', verdict: 'allow', why: '127/8 literal with port' },
  { url: 'http://127.255.255.254/', verdict: 'allow', why: 'last address of 127/8' },
  { url: 'http://[::1]/mcp', verdict: 'allow', why: 'IPv6 loopback' },
  { url: 'http://[::ffff:127.0.0.1]/mcp', verdict: 'allow', why: 'IPv4-mapped loopback' },
  { url: 'http://127.1', verdict: 'allow', why: 'WHATWG shorthand normalizes to 127.0.0.1' },
  { url: 'http://2130706433', verdict: 'allow', why: 'WHATWG integer form normalizes to 127.0.0.1' },
  { url: 'http://0x7f000001', verdict: 'allow', why: 'WHATWG hex form normalizes to 127.0.0.1' },
  { url: 'http://0177.0.0.1', verdict: 'allow', why: 'WHATWG octal form normalizes to 127.0.0.1' },
  { url: 'http://ⓛocalhost/mcp', verdict: 'allow', why: 'IDN normalizes to localhost' },
  { url: 'http://１２７.0.0.1/mcp', verdict: 'allow', why: 'fullwidth digits normalize to 127.0.0.1' },
]

/** Public https endpoints — the intended target of a connector. */
const PUBLIC: Case[] = [
  { url: 'https://example.com/mcp', verdict: 'allow', why: 'public DNS name over https' },
  { url: 'https://api.example.com/mcp', verdict: 'allow', why: 'public DNS name over https' },
  { url: 'https://8.8.8.8/mcp', verdict: 'allow', why: 'public IPv4 literal over https' },
  { url: 'https://[2606:4700:4700::1111]/mcp', verdict: 'allow', why: 'public IPv6 literal over https' },
  { url: 'https://127.0.0.1/mcp', verdict: 'allow', why: 'loopback is allowed over https too' },
  { url: 'https://[::1]/mcp', verdict: 'allow', why: 'IPv6 loopback over https' },
]

/** http towards anything that is not loopback. */
const HTTP_NOT_LOOPBACK: Case[] = [
  { url: 'http://example.com/mcp', verdict: 'deny', why: 'http only for loopback' },
  { url: 'http://8.8.8.8/mcp', verdict: 'deny', why: 'http only for loopback' },
]

/** Cloud metadata services, by name. */
const METADATA: Case[] = [
  { url: 'https://metadata.google.internal/mcp', verdict: 'deny', why: 'metadata hostname' },
  { url: 'https://METADATA.GOOGLE.INTERNAL/mcp', verdict: 'deny', why: 'metadata hostname, uppercase' },
  { url: 'https://metadata.google.internal./mcp', verdict: 'deny', why: 'metadata hostname with root dot' },
  { url: 'https://METADATA.GOOGLE.INTERNAL./mcp', verdict: 'deny', why: 'uppercase + root dot' },
  { url: 'https://metadata.goog/mcp', verdict: 'deny', why: 'metadata hostname' },
  { url: 'https://metadata/mcp', verdict: 'deny', why: 'metadata hostname' },
  { url: 'https://instance-data/mcp', verdict: 'deny', why: 'metadata hostname' },
  { url: 'https://instance-data.ec2.internal/mcp', verdict: 'deny', why: 'EC2 metadata hostname' },
  { url: 'https://ⓜetadata.google.internal/mcp', verdict: 'deny', why: 'IDN normalizes onto the metadata hostname' },
]

/** The IPv4 reserve/private segments the Go mirror was wider on (R3 N4). */
const IPV4_RESERVED: Case[] = [
  { url: 'https://0.0.0.0/mcp', verdict: 'deny', why: '0.0.0.0/8 unspecified' },
  { url: 'https://0.1.2.3/mcp', verdict: 'deny', why: '0.0.0.0/8 unspecified' },
  { url: 'https://10.0.0.1/mcp', verdict: 'deny', why: '10/8 private' },
  { url: 'https://100.64.0.1/mcp', verdict: 'deny', why: '100.64/10 CGNAT' },
  { url: 'https://100.127.255.255/mcp', verdict: 'deny', why: '100.64/10 CGNAT, last address' },
  { url: 'https://169.254.169.254/mcp', verdict: 'deny', why: '169.254/16 link-local metadata' },
  { url: 'https://172.16.0.1/mcp', verdict: 'deny', why: '172.16/12 private' },
  { url: 'https://192.0.0.1/mcp', verdict: 'deny', why: '192.0.0.0/24 IETF protocol assignments' },
  { url: 'https://192.0.2.1/mcp', verdict: 'deny', why: '192.0.2/24 documentation' },
  { url: 'https://192.168.1.1/mcp', verdict: 'deny', why: '192.168/16 private' },
  { url: 'https://198.18.0.1/mcp', verdict: 'deny', why: '198.18/15 benchmarking' },
  { url: 'https://198.51.100.7/mcp', verdict: 'deny', why: '198.51.100/24 documentation' },
  { url: 'https://203.0.113.5/mcp', verdict: 'deny', why: '203.0.113/24 documentation' },
  { url: 'https://224.0.0.1/mcp', verdict: 'deny', why: '224/4 multicast' },
  { url: 'https://239.255.255.255/mcp', verdict: 'deny', why: '224/4 multicast, last address' },
  { url: 'https://240.0.0.1/mcp', verdict: 'deny', why: '240/4 reserved' },
  { url: 'https://255.255.255.255/mcp', verdict: 'deny', why: '240/4 broadcast' },
]

/** The IPv6 reserve/private segments the Go mirror was wider on (R3 N4). */
const IPV6_RESERVED: Case[] = [
  { url: 'https://[::]/mcp', verdict: 'deny', why: 'unspecified' },
  { url: 'https://[64:ff9b::a9fe:a9fe]/mcp', verdict: 'deny', why: 'NAT64 64:ff9b::/96 onto metadata' },
  { url: 'https://[64:ff9b::7f00:1]/mcp', verdict: 'deny', why: 'NAT64 64:ff9b::/96 onto loopback' },
  { url: 'https://[100::1]/mcp', verdict: 'deny', why: '100::/64 discard-only' },
  { url: 'https://[2001:db8::1]/mcp', verdict: 'deny', why: '2001:db8::/32 documentation' },
  { url: 'https://[fc00::1]/mcp', verdict: 'deny', why: 'fc00::/7 unique-local' },
  { url: 'https://[fd12:3456::1]/mcp', verdict: 'deny', why: 'fc00::/7 unique-local' },
  { url: 'https://[fe80::1]/mcp', verdict: 'deny', why: 'fe80::/10 link-local' },
  { url: 'https://[ff02::1]/mcp', verdict: 'deny', why: 'ff00::/8 multicast' },
  { url: 'https://[::ffff:10.0.0.1]/mcp', verdict: 'deny', why: 'IPv4-mapped private' },
  { url: 'https://[::ffff:169.254.169.254]/mcp', verdict: 'deny', why: 'IPv4-mapped link-local metadata' },
  { url: 'https://[fe80::1%25eth0]/mcp', verdict: 'deny', why: 'IPv6 zone id: not parseable, refused outright' },
  { url: 'https://[fe80::1%eth0]/mcp', verdict: 'deny', why: 'IPv6 zone id (raw %): not parseable, refused outright' },
]

/** Authority credentials and non-http schemes. */
const AUTHORITY_AND_SCHEME: Case[] = [
  { url: 'https://user:pass@example.com/mcp', verdict: 'deny', why: 'credentials in the authority' },
  { url: 'https://user@example.com/mcp', verdict: 'deny', why: 'username in the authority' },
  { url: 'ftp://example.com/mcp', verdict: 'deny', why: 'non-http scheme' },
  { url: 'file:///etc/passwd', verdict: 'deny', why: 'non-http scheme' },
  { url: 'javascript:alert(1)', verdict: 'deny', why: 'non-http scheme' },
  { url: 'ws://example.com/mcp', verdict: 'deny', why: 'non-http scheme' },
  { url: 'data:text/plain,hi', verdict: 'deny', why: 'non-http scheme' },
]

/** Shapes the WHATWG parser rewrites; the verdict follows the parsed host. */
const NORMALIZED_SHAPES: Case[] = [
  { url: 'https:///mcp', verdict: 'allow', why: 'WHATWG treats this as https://mcp/ (public name)' },
  { url: 'https://example.com\\@evil.com/mcp', verdict: 'allow', why: 'backslash is a path separator: host stays example.com' },
  { url: 'https:///@evil.com', verdict: 'allow', why: 'path, not authority: host evil.com' },
  { url: 'https://exa\tmple.com/mcp', verdict: 'allow', why: 'TAB is stripped: host example.com' },
  { url: 'https://exa\nmple.com/mcp', verdict: 'allow', why: 'LF is stripped: host example.com' },
  { url: 'https://exa mple.com/mcp', verdict: 'deny', why: 'space is not stripped: unparseable' },
  { url: 'https://', verdict: 'deny', why: 'no host' },
  { url: 'not a url', verdict: 'deny', why: 'unparseable' },
  { url: '//example.com/mcp', verdict: 'deny', why: 'protocol-relative: scheme missing' },
]

const HOSTNAME = hostname()

const CORPUS: Case[] = [
  ...LOOPBACK,
  ...PUBLIC,
  ...HTTP_NOT_LOOPBACK,
  ...METADATA,
  { url: `https://${HOSTNAME}/mcp`, verdict: 'deny', why: 'the machine\u2019s own hostname' },
  { url: `https://${HOSTNAME.toUpperCase()}/mcp`, verdict: 'deny', why: 'own hostname, uppercase' },
  ...IPV4_RESERVED,
  ...IPV6_RESERVED,
  ...AUTHORITY_AND_SCHEME,
  ...NORMALIZED_SHAPES,
]

describe('R3-N4: client outbound-URL verdict table', () => {
  it('covers a corpus of at least 56 cases', () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(56)
  })

  it.each(CORPUS.map(item => [item.url, item.verdict, item.why] as const))(
    'isOutboundUrlAllowed(%s) === %s  (%s)',
    (url, verdict, why) => {
      const allowed = isOutboundUrlAllowed(url)
      expect(allowed, `${url} — ${why}`).toBe(verdict === 'allow')
      if (verdict === 'deny') {
        expect(() => assertOutboundUrlAllowed(url, 'probe')).toThrow(OutboundUrlBlockedError)
      } else {
        expect(assertOutboundUrlAllowed(url, 'probe')).toBeInstanceOf(URL)
      }
    },
  )

  it('refuses every reserved segment the reviewer listed as GO-WIDER (N4 list)', () => {
    const goWider = [
      'https://100.64.0.1/mcp', // CGNAT 100.64/10
      'https://0.1.2.3/mcp', // 0.0.0.0/8
      'https://192.0.0.1/mcp', // 192.0.0.0/24
      'https://192.0.2.1/mcp', // documentation
      'https://198.51.100.1/mcp', // documentation
      'https://203.0.113.1/mcp', // documentation
      'https://198.18.0.1/mcp', // benchmarking
      'https://240.0.0.1/mcp', // reserved
      'https://[64:ff9b::a9fe:a9fe]/mcp', // NAT64
      'https://[100::1]/mcp', // discard-only
      'https://[2001:db8::1]/mcp', // documentation
      'https://[fe80::1%25eth0]/mcp', // zone-id link-local
    ]
    const accepted = goWider.filter(url => isOutboundUrlAllowed(url))
    console.log(`[N4] go-wider corpus = ${goWider.length} | accepted by the client = ${JSON.stringify(accepted)}`)
    expect(accepted).toEqual([])
  })

  it('decides on the WHATWG-normalized URL, so no raw spelling can flip a verdict', () => {
    const rewritten = CORPUS
      .map(item => item.url)
      .map((url) => {
        try { return { url, normalized: new URL(url).toString() } } catch { return null }
      })
      .filter((item): item is { url: string, normalized: string } => item !== null)
      .filter(item => item.url !== item.normalized)
    console.log(`[N4] corpus = ${CORPUS.length} | rewritten spellings checked = ${rewritten.length}`)
    expect(rewritten.length).toBeGreaterThan(5)
    for (const { url, normalized } of rewritten) {
      expect(isOutboundUrlAllowed(url), `${url} must be judged as ${normalized}`).toBe(isOutboundUrlAllowed(normalized))
    }
  })
})
