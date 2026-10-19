import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { apply } from '@deepseek-ai/dsh-skill-badge'

interface BadgeProvider {
  list: () => Promise<Array<{ name: string, description: string }>>
  get: (candidate: { name: string }) => Promise<{ content: string, description: string }>
}

async function first(list: Promise<Array<{ name: string, description: string }>>): Promise<{ name: string, description: string }> {
  const [candidate] = await list
  if (candidate === undefined) throw new Error('no badge candidate')
  return candidate
}

function load(name: string): BadgeProvider {
  let provider: BadgeProvider | undefined
  apply({
    get: (service: string) => (service === 'desktopRuntime' ? { productName: name } : undefined),
    skills: { registerProvider: (factory: () => BadgeProvider) => { provider = factory() } },
  } as never)
  if (provider === undefined) throw new Error('badge provider was not registered')
  return provider
}

describe('badge skill OEM branding', () => {
  it('uses the current product name and does not expose upstream branding', async () => {
    const provider = load('Acme OEM')
    const candidate = await first(provider.list())
    const loaded = await provider.get(candidate)
    expect(candidate.name).toBe('badge')
    expect(candidate.description).toContain('Powered by Acme OEM')
    expect(loaded.content).toContain('Powered by Acme OEM')
    expect(loaded.content).not.toMatch(/dsh|deepseek/iu)
    expect(loaded.content).toContain('https://img.shields.io/badge/Powered_by-Acme%20OEM-')
  })

  it('resolves the product name lazily (after the desktop shell publishes it)', async () => {
    let name: string | undefined
    let provider: BadgeProvider | undefined
    apply({
      get: () => ({ get productName() { return name } }),
      skills: { registerProvider: (factory: () => BadgeProvider) => { provider = factory() } },
    } as never)
    if (provider === undefined) throw new Error('badge provider was not registered')
    const candidate = await first(provider.list())
    expect(candidate.description).toContain('PicoAide Harness')
    name = 'Acme OEM'
    expect((await provider.get(candidate)).content).toContain('Powered by Acme OEM')
  })

  it('percent-encodes characters that would break the Markdown/Shields path', async () => {
    for (const [name, encoded] of [['Foo)OEM', 'Foo%29OEM'], ['Foo(OEM', 'Foo%28OEM'], ['Foo-Bar_Baz', 'Foo%2DBar%5FBaz']] as const) {
      const provider = load(name)
      const loaded = await provider.get(await first(provider.list()))
      expect(loaded.content).toContain(`Powered_by-${encoded}-`)
      expect(loaded.content).not.toContain(`Powered_by-${name}-`)
    }
  })

  it('truncates by code point (no split surrogate pairs)', async () => {
    const provider = load(`${'A'.repeat(79)}😀`)
    const loaded = await provider.get(await first(provider.list()))
    expect(loaded.content).toContain('Powered by')
    expect(() => encodeURIComponent(loaded.content)).not.toThrow()
  })

  it('drops control characters/backticks and keeps a bounded name', async () => {
    const provider = load(`Acme\n\`OEM\`${'x'.repeat(200)}`)
    const loaded = await provider.get(await first(provider.list()))
    expect(loaded.content).not.toContain('Acme\n`OEM`')
    expect(loaded.content).toContain('Powered by Acme OEM')
    expect(loaded.content.length).toBeLessThan(2000)
  })

  it('excludes the upstream DSH badge PNG from the packaged files', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { build: { files: string[] } }
    expect(pkg.build.files).toContain('!**/node_modules/@deepseek-ai/dsh-skill-badge/assets/dsh-badge.png')
  })
})
