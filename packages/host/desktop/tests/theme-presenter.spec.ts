import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'
import { DesktopThemePresenter } from '../src/client/theme-presenter.ts'

interface FakeStyle {
  values: Map<string, string>
  removed: string[]
  setProperty(name: string, value: string): void
  removeProperty(name: string): void
}

function fakeStyle(): FakeStyle {
  const values = new Map<string, string>()
  const removed: string[] = []
  return {
    values,
    removed,
    setProperty: (name, value) => { values.set(name, value) },
    removeProperty: (name) => { removed.push(name); values.delete(name) },
  }
}

interface FakeMeta {
  name: string
  content: string
  isConnected: boolean
  remove: ReturnType<typeof vi.fn>
}

interface FakeDocument {
  documentElement: { style: FakeStyle & { colorScheme: string } }
  body: {
    style: FakeStyle
    attributes: Set<string>
    setAttribute: () => void
    removeAttribute: (name: string) => void
    isConnected: never
  }
  head: { appendChild: ReturnType<typeof vi.fn> }
  createElement: (tag: string) => FakeMeta
}

function fixture(): { doc: FakeDocument; meta: FakeMeta } {
  const meta: FakeMeta = { name: '', content: '', isConnected: false, remove: vi.fn() }
  const doc: FakeDocument = {
    documentElement: { style: { ...fakeStyle(), colorScheme: 'light' } },
    body: {
      style: fakeStyle(),
      attributes: new Set(),
      setAttribute: vi.fn(),
      removeAttribute: (name) => { doc.body.attributes.delete(name) },
      isConnected: true as never,
    },
    head: { appendChild: vi.fn() },
    createElement: () => meta,
  }
  // body.setAttribute must be a function that records names into attributes.
  doc.body.setAttribute = ((name: string, _value: string) => {
    doc.body.attributes.add(name)
  }) as unknown as () => void
  return { doc, meta }
}

function snapshot(partial: Record<string, unknown>): ThemeSnapshot {
  return {
    active: {
      colorScheme: 'light',
      tokens: {},
      ...partial,
    },
  } as unknown as ThemeSnapshot
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('DesktopThemePresenter', () => {
  it('applies the color scheme and dark-mode attribute', () => {
    const { doc } = fixture()
    vi.stubGlobal('document', doc)
    vi.stubGlobal('getComputedStyle', () => ({ backgroundColor: 'rgb(0, 0, 0)' }))

    const presenter = new DesktopThemePresenter()
    presenter.apply(snapshot({ colorScheme: 'dark' }))
    expect(doc.documentElement.style.colorScheme).toBe('dark')
    expect(doc.body.attributes.has('data-ds-dark-theme')).toBe(true)

    presenter.apply(snapshot({ colorScheme: 'light' }))
    expect(doc.documentElement.style.colorScheme).toBe('light')
    expect(doc.body.attributes.has('data-ds-dark-theme')).toBe(false)
  })

  it('projects token overrides on body style and cleans them on the next apply', () => {
    const { doc } = fixture()
    vi.stubGlobal('document', doc)
    vi.stubGlobal('getComputedStyle', () => ({ backgroundColor: 'rgb(0, 0, 0)' }))

    const presenter = new DesktopThemePresenter()
    presenter.apply(snapshot({ tokens: { '--x': '1', '--y': '2' } }))
    expect(doc.body.style.values.get('--x')).toBe('1')
    expect(doc.body.style.values.get('--y')).toBe('2')

    // Second apply with a disjoint token set must remove the stale ones.
    presenter.apply(snapshot({ tokens: { '--z': '3' } }))
    expect(doc.body.style.values.has('--x')).toBe(false)
    expect(doc.body.style.values.has('--y')).toBe(false)
    expect(doc.body.style.values.get('--z')).toBe('3')
  })

  it('publishes the body background as the theme-color meta', () => {
    const { doc, meta } = fixture()
    vi.stubGlobal('document', doc)
    vi.stubGlobal('getComputedStyle', () => ({ backgroundColor: 'rgb(12, 34, 56)' }))

    const presenter = new DesktopThemePresenter()
    presenter.apply(snapshot({ colorScheme: 'dark' }))
    expect(meta.name).toBe('theme-color')
    expect(meta.content).toBe('rgb(12, 34, 56)')
    expect(doc.head.appendChild).toHaveBeenCalledWith(meta)
    expect(meta.isConnected).toBe(false)
  })

  it('dispose removes only state owned by the presenter', () => {
    const { doc } = fixture()
    vi.stubGlobal('document', doc)
    vi.stubGlobal('getComputedStyle', () => ({ backgroundColor: 'rgb(0, 0, 0)' }))

    const presenter = new DesktopThemePresenter()
    presenter.apply(snapshot({ colorScheme: 'dark', tokens: { '--x': '1' } }))
    presenter.dispose()

    expect(doc.documentElement.style.removed).toContain('color-scheme')
    expect(doc.body.attributes.has('data-ds-dark-theme')).toBe(false)
    expect(doc.body.style.values.size).toBe(0)
    expect(doc.body.style.values.has('--x')).toBe(false)
  })
})
