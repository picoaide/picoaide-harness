import { afterEach, describe, expect, it, vi } from 'vitest'
import { installFavicon } from '../src/client/favicon.ts'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

interface FakeLink {
  href: string
  rel: string
}

function fixtureDocument(links: FakeLink[], manifest: FakeLink | null) {
  const doc = {
    head: { appendChild: vi.fn() },
    querySelectorAll: vi.fn((selector: string) => {
      expect(selector).toBe('link[rel="icon"]')
      return links
    }),
    querySelector: vi.fn((selector: string) => {
      expect(selector).toBe('link[rel="manifest"]')
      return manifest
    }),
  }
  return doc
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('installFavicon', () => {
  it('replaces every icon link with the brace-mark data URI', () => {
    const links: FakeLink[] = [{ href: '/favicon.svg', rel: 'icon' }]
    vi.stubGlobal('document', fixtureDocument(links, null))
    installFavicon()
    expect(links[0]!.href).toMatch(/^data:image\/svg\+xml,/)
    expect(decodeURIComponent(links[0]!.href)).toContain('<svg')
  })

  it('decodes to the exact product logo geometry (brace mark, 1.25×)', () => {
    const links: FakeLink[] = [{ href: '', rel: 'icon' }]
    vi.stubGlobal('document', fixtureDocument(links, null))
    installFavicon()
    const svg = decodeURIComponent(links[0]!.href.split(',')[1]!)
    // Authority derivation: the tile, the brace paths, connector and nodes
    // (see repo-root logo.svg geometry, enlarged 1.25×).
    expect(svg).toContain('rx="180"')
    expect(svg).toContain('translate(627 627) scale(1.25) translate(-627 -627)')
    expect(svg).toContain('M 334 409')
    expect(svg).toContain('M 920 409')
    expect(svg).toContain('x1="435" y1="627" x2="817" y2="627"')
    expect(svg).toContain('cx="435" cy="627" r="65"')
    expect(svg).toContain('cx="817" cy="627" r="65"')
  })

  it('matches the checked-in authored brand source', () => {
    // The brand folder logo is the single-authority artwork; the inline
    // favicon must be byte-identical in geometry (whitespace-insensitive).
    const authored = readFileSync(resolve(__dirname, '../../../../brands/official/logo.svg'), 'utf8')
    const links: FakeLink[] = [{ href: '', rel: 'icon' }]
    vi.stubGlobal('document', fixtureDocument(links, null))
    installFavicon()
    const inline = decodeURIComponent(links[0]!.href.split(',')[1]!)
    expect(inline.replace(/\s+/g, ' ').trim()).toBe(authored.replace(/\s+/g, ' ').trim())
  })

  it('clouds the manifest icons when a manifest link is present', async () => {
    const manifestData = { icons: [{ src: '/old.svg' }, { src: '/second.svg' }] }
    const manifest = { href: '/manifest.webmanifest' }
    const fetch = vi.fn(async () => ({ json: async () => manifestData }))
    vi.stubGlobal('document', fixtureDocument([], manifest))
    vi.stubGlobal('fetch', fetch)
    installFavicon()
    await vi.waitFor(() => {
      expect(manifestData.icons[0]!.src).toMatch(/^data:image\/svg\+xml,/)
      expect(manifestData.icons[1]!.src).toMatch(/^data:image\/svg\+xml,/)
    })
  })

  it('is best-effort when the manifest fetch fails', async () => {
    const manifest = { href: '/manifest.webmanifest' }
    const fetch = vi.fn(async () => { throw new Error('offline') })
    vi.stubGlobal('document', fixtureDocument([], manifest))
    vi.stubGlobal('fetch', fetch)
    expect(() => installFavicon()).not.toThrow()
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled())
  })
})
