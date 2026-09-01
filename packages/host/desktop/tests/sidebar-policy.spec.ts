import { afterEach, describe, expect, it, vi } from 'vitest'
import { applySidebarBrowserPolicy } from '../src/client/sidebar-policy.ts'

type JsonFetch = (input: string, init?: RequestInit) => Promise<{
  ok: boolean
  json: () => Promise<unknown>
}>

function fetchSequence(...responses: Array<{ ok: boolean; body: unknown }>): JsonFetch {
  let index = 0
  return vi.fn(async () => {
    const next = responses[Math.min(index, responses.length - 1)]!
    index += 1
    if (next.ok) return { ok: true, json: async () => next.body }
    return { ok: false, json: async () => ({}) }
  }) as unknown as JsonFetch
}

/** Flush the fire-and-forget async policy. */
function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 10))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('applySidebarBrowserPolicy', () => {
  it('writes tabsEnabled.browser = false when the setting is absent', async () => {
    const fetch = fetchSequence(
      { ok: true, body: { ok: true, value: { value: { tabsEnabled: {} }, revision: 3 } } },
      { ok: true, body: { ok: true } },
    )
    vi.stubGlobal('fetch', fetch)
    applySidebarBrowserPolicy()
    await flush()

    expect(fetch).toHaveBeenCalledTimes(2)
    const getCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(getCall[0]).toBe('/sidebar/api/settings.get')
    const updateCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[1]!
    expect(updateCall[0]).toBe('/sidebar/api/settings.update')
    const body = JSON.parse(String(updateCall[1]!.body))
    expect(body).toEqual({ patch: { tabsEnabled: { browser: false } }, expectedRevision: 3 })
  })

  it('is a no-op when the user already set tabsEnabled.browser', async () => {
    for (const browser of [true, false]) {
      const fetch = fetchSequence(
        { ok: true, body: { ok: true, value: { value: { tabsEnabled: { browser } }, revision: 1 } } },
      )
      vi.stubGlobal('fetch', fetch)
      applySidebarBrowserPolicy()
      await flush()
      expect(fetch).toHaveBeenCalledTimes(1)
    }
  })

  it('writes the policy when the setting is explicitly undefined (missing key)', async () => {
    const fetch = fetchSequence(
      { ok: true, body: { ok: true, value: { value: { tabsEnabled: { browser: undefined } }, revision: 1 } } },
      { ok: true, body: { ok: true } },
    )
    vi.stubGlobal('fetch', fetch)
    applySidebarBrowserPolicy()
    await flush()
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('is a silent no-op when the sidebar plugin is absent (route 404)', async () => {
    const fetch = fetchSequence({ ok: false, body: {} })
    vi.stubGlobal('fetch', fetch)
    applySidebarBrowserPolicy()
    await flush()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('is a silent no-op when the settings response is null/undefined', async () => {
    const fetch = fetchSequence({ ok: true, body: { ok: true, value: null } })
    vi.stubGlobal('fetch', fetch)
    applySidebarBrowserPolicy()
    await flush()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('tolerates a network failure without throwing', async () => {
    const fetch = vi.fn(async () => { throw new Error('network down') })
    vi.stubGlobal('fetch', fetch)
    expect(() => applySidebarBrowserPolicy()).not.toThrow()
    await flush()
  })

  it('tolerates a failed update (non-ok response) without throwing', async () => {
    const fetch = fetchSequence(
      { ok: true, body: { ok: true, value: { value: { tabsEnabled: {} }, revision: 5 } } },
      { ok: false, body: {} },
    )
    vi.stubGlobal('fetch', fetch)
    expect(() => applySidebarBrowserPolicy()).not.toThrow()
    await flush()
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
