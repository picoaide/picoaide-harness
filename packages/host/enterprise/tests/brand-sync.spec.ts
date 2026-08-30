import { describe, expect, it } from 'vitest'
import { resolveBrandLogoURLs, type BrandConfig } from '../src/brand-sync.ts'

describe('resolveBrandLogoURLs', () => {
  const brand: BrandConfig = {
    enabled: true,
    login: { logo_url: '/api/client/v2/brand/logo/login', display_name: 'Acme', tagline: '', welcome: '' },
    client: { logo_url: '/api/client/v2/brand/logo/client', display_name: 'Acme AI', tagline: '' },
    favicon_url: '/api/client/v2/brand/logo/favicon',
    title: 'Acme',
  }

  it('resolves relative logo URLs to absolute against the server URL', () => {
    const out = resolveBrandLogoURLs(brand, 'https://ai.example.com')
    expect(out.login?.logo_url).toBe('https://ai.example.com/api/client/v2/brand/logo/login')
    expect(out.client?.logo_url).toBe('https://ai.example.com/api/client/v2/brand/logo/client')
    expect(out.favicon_url).toBe('https://ai.example.com/api/client/v2/brand/logo/favicon')
  })

  it('trims trailing slashes from the server URL (no //path)', () => {
    const out = resolveBrandLogoURLs(brand, 'https://ai.example.com/')
    expect(out.client?.logo_url).toBe('https://ai.example.com/api/client/v2/brand/logo/client')
  })

  it('keeps absolute URLs untouched (defensive)', () => {
    const out = resolveBrandLogoURLs(
      { ...brand, client: { ...brand.client!, logo_url: 'https://cdn.example.com/logo.png' } },
      'https://ai.example.com',
    )
    expect(out.client?.logo_url).toBe('https://cdn.example.com/logo.png')
  })

  it('leaves empty/absent URLs alone', () => {
    const out = resolveBrandLogoURLs({ ...brand, login: { display_name: '', tagline: '', welcome: '' } }, 'https://ai.example.com')
    expect(out.login?.logo_url).toBeUndefined()
  })
})
