// @vitest-environment jsdom
import { useSyncExternalStore } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MarketCatalogResponse, MarketStateResponse } from '../src/api-types.js'
import { MarketSettingsTab, type MarketSettingsTabProps } from '../src/client/MarketSettingsTab.js'
import { MarketLauncher, type MarketLauncherProps } from '../src/client/MarketLauncher.js'
import { MarketOverlay, type MarketOverlayProps } from '../src/client/MarketOverlay.js'
import { createMarketViewStore } from '../src/client/market-view-store.js'
import { mutateMarketSource, readMarketCatalog, readMarketState } from '../src/client/api.js'
import { en, type MarketLocaleKey } from '../src/client/locales.js'

vi.mock('../src/client/api.js', () => ({
  mutateMarketSource: vi.fn(),
  readMarketCatalog: vi.fn(),
  readMarketState: vi.fn(),
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const t = ((key: MarketLocaleKey): string => en[key]) as MarketSettingsTabProps['t']
const props = { t, readLocale: () => 'en' } as MarketSettingsTabProps
const emptyState: MarketStateResponse = { sources: [], builtIns: [] }

const enabledState = {
  sources: [{
    sourceRecordId: '018f1f77-a5c4-7b73-a9ae-0242ac120002',
    registrationKind: 'built-in',
    adapterId: 'fixture',
    providerId: 'fixture',
    builtInProviderKey: 'fixture',
    enabled: true,
    order: 0,
    name: 'Fixture catalog',
    endpoint: 'https://catalog.example/v1/plugins',
    attribution: {
      name: 'Fixture provider',
      url: 'https://catalog.example',
      notice: 'Catalog metadata is maintained by Fixture provider.',
    },
    partnership: false,
  }],
  builtIns: [],
} as MarketStateResponse

const availableState = {
  sources: [],
  builtIns: [{
    key: 'fixture',
    adapterId: 'fixture',
    providerId: 'fixture',
    name: 'Fixture catalog',
    description: 'Fixture catalog description',
    endpoint: 'https://catalog.example/v1/plugins',
    attribution: {
      name: 'Fixture provider',
      url: 'https://catalog.example',
      notice: 'Built-in catalog attribution notice.',
    },
    partnership: false,
  }],
} as MarketStateResponse

const catalog = {
  query: {},
  fetchedAt: '2026-08-17T00:00:00Z',
  results: [{
    source: enabledState.sources[0],
    stale: false,
    snapshot: {
      schemaVersion: '1.0',
      source: { providerId: 'fixture', revision: '1', generatedAt: '2026-08-17T00:00:00Z' },
      items: [{
        id: 'fixture-plugin',
        displayName: 'Fixture Plugin',
        summary: 'A plugin used by the settings page test.',
        description: 'Fixture details',
        repository: { url: 'https://github.com/example/fixture-plugin' },
        media: {
          icon: {
            assetRef: 'mktimg_0123456789abcdefghijklmnopqrstuv',
            role: 'plugin-icon',
            alt: 'Fixture Plugin icon',
          },
        },
        provenance: { sourceRecordId: enabledState.sources[0]!.sourceRecordId, itemId: 'fixture-plugin', fetchedAt: '2026-08-17T00:00:00Z' },
      }],
    },
  }],
} as unknown as MarketCatalogResponse

function catalogFor(state: MarketStateResponse): MarketCatalogResponse {
  return {
    ...catalog,
    results: state.sources.map((source, index) => ({
      source,
      stale: false,
      snapshot: {
        ...catalog.results[0]!.snapshot!,
        source: { providerId: source.providerId, revision: '1', generatedAt: '2026-08-17T00:00:00Z' },
        items: [{
          ...catalog.results[0]!.snapshot!.items[0]!,
          id: `fixture-plugin-${index + 1}`,
          displayName: `Fixture Plugin ${index + 1}`,
          provenance: {
            sourceRecordId: source.sourceRecordId,
            itemId: `fixture-plugin-${index + 1}`,
            fetchedAt: '2026-08-17T00:00:00Z',
          },
        }],
      },
    })),
  } as unknown as MarketCatalogResponse
}

describe('MarketSettingsTab', () => {
  it('loads source state on mount and avoids catalog I/O when none are enabled', async () => {
    vi.mocked(readMarketState).mockResolvedValue(emptyState)
    render(<MarketSettingsTab {...props} />)

    expect(await screen.findByRole('heading', { name: en.emptyTitle })).toBeTruthy()
    expect(readMarketState).toHaveBeenCalledOnce()
    expect(readMarketCatalog).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: en.sources }))
    expect(screen.getByRole('heading', { name: en.sources })).toBeTruthy()
  })

  it('renders normalized catalog data and opens details in the official modal', async () => {
    vi.mocked(readMarketState).mockResolvedValue(enabledState)
    vi.mocked(readMarketCatalog).mockResolvedValue(catalog)
    render(<MarketSettingsTab {...props} />)

    const plugin = await screen.findByRole('button', { name: /Fixture Plugin/u })
    expect(screen.getByText(`${en.source}: Fixture catalog · Fixture provider`)).toBeTruthy()
    expect(plugin.querySelector('img')?.getAttribute('src')).toBe('/api/community-market/assets?ref=mktimg_0123456789abcdefghijklmnopqrstuv')
    expect(readMarketCatalog).toHaveBeenCalledWith('', 'en', expect.any(AbortSignal))
    fireEvent.click(plugin)
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Fixture Plugin' })).toBeTruthy()
    expect(screen.getByText('Fixture details')).toBeTruthy()
    expect(screen.getAllByText(`${en.source}: Fixture catalog · Fixture provider`)).toHaveLength(2)
  })

  it('keeps the official plugin glyph when a same-origin icon cannot be loaded', async () => {
    vi.mocked(readMarketState).mockResolvedValue(enabledState)
    vi.mocked(readMarketCatalog).mockResolvedValue(catalog)
    render(<MarketSettingsTab {...props} />)

    const plugin = await screen.findByRole('button', { name: /Fixture Plugin/u })
    const image = plugin.querySelector('img')
    expect(image).not.toBeNull()
    fireEvent.error(image!)
    expect(plugin.querySelector('img')).toBeNull()
    expect(plugin.querySelector('[aria-hidden="true"]')).not.toBeNull()
  })

  it('shows source attribution, endpoint, adapter type, and last result', async () => {
    vi.mocked(readMarketState).mockResolvedValue(enabledState)
    vi.mocked(readMarketCatalog).mockResolvedValue(catalog)
    render(<MarketSettingsTab {...props} />)

    await screen.findByRole('button', { name: /Fixture Plugin/u })
    fireEvent.click(screen.getByRole('button', { name: en.sources }))
    const attribution = screen.getByRole('link', { name: 'Fixture provider' }) as HTMLAnchorElement
    expect(attribution.href).toBe('https://catalog.example/')
    expect(attribution.target).toBe('_blank')
    expect(attribution.rel).toContain('noopener')
    expect(screen.getByText('Catalog metadata is maintained by Fixture provider.')).toBeTruthy()
    expect(screen.getByText('catalog.example')).toBeTruthy()
    expect(screen.getByText(en.builtIn)).toBeTruthy()
    expect(screen.getByText(en.available)).toBeTruthy()
  })

  it('shows attribution text and notice without creating an unsafe external link', async () => {
    const unsafe = {
      sources: [{
        ...enabledState.sources[0]!,
        enabled: false,
        attribution: {
          name: 'Unsafe provider claim',
          url: 'javascript:alert(1)',
          notice: 'This notice remains visible.',
        },
      }],
      builtIns: [],
    } as MarketStateResponse
    vi.mocked(readMarketState).mockResolvedValue(unsafe)
    render(<MarketSettingsTab {...props} />)

    await screen.findByRole('heading', { name: en.emptyTitle })
    fireEvent.click(screen.getByRole('button', { name: en.sources }))
    expect(screen.getByText('Unsafe provider claim')).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Unsafe provider claim' })).toBeNull()
    expect(screen.getByText('This notice remains visible.')).toBeTruthy()
  })

  it('moves sources in either direction and disables controls at the list boundaries', async () => {
    const first = { ...enabledState.sources[0]!, enabled: false, order: 0, name: 'First catalog' }
    const second = {
      ...first,
      sourceRecordId: '028f1f77-a5c4-7b73-a9ae-0242ac120003',
      providerId: 'fixture-second',
      builtInProviderKey: 'fixture-second',
      name: 'Second catalog',
      order: 1,
    }
    const initial = { sources: [first, second], builtIns: [] } as MarketStateResponse
    const movedUp = [{ ...second, order: 0 }, { ...first, order: 1 }]
    vi.mocked(readMarketState).mockResolvedValue(initial)
    vi.mocked(mutateMarketSource)
      .mockResolvedValueOnce(movedUp)
      .mockResolvedValueOnce(initial.sources)
    render(<MarketSettingsTab {...props} />)

    await screen.findByRole('heading', { name: en.emptyTitle })
    fireEvent.click(screen.getByRole('button', { name: en.sources }))
    let up = screen.getAllByRole('button', { name: en.moveUp }) as HTMLButtonElement[]
    let down = screen.getAllByRole('button', { name: en.moveDown }) as HTMLButtonElement[]
    expect(up.map(button => button.disabled)).toEqual([true, false])
    expect(down.map(button => button.disabled)).toEqual([false, true])

    fireEvent.click(up[1]!)
    await waitFor(() => {
      expect(mutateMarketSource).toHaveBeenNthCalledWith(1, {
        action: 'move',
        sourceRecordId: second.sourceRecordId,
        direction: 'up',
      }, expect.any(AbortSignal))
    })
    await waitFor(() => {
      expect(screen.getAllByRole('heading', { level: 3 }).map(heading => heading.textContent))
        .toEqual(['Second catalog', 'First catalog'])
    })
    up = screen.getAllByRole('button', { name: en.moveUp }) as HTMLButtonElement[]
    down = screen.getAllByRole('button', { name: en.moveDown }) as HTMLButtonElement[]
    expect(up.map(button => button.disabled)).toEqual([true, false])
    expect(down.map(button => button.disabled)).toEqual([false, true])

    fireEvent.click(down[0]!)
    await waitFor(() => {
      expect(mutateMarketSource).toHaveBeenNthCalledWith(2, {
        action: 'move',
        sourceRecordId: second.sourceRecordId,
        direction: 'down',
      }, expect.any(AbortSignal))
    })
  })

  it('immediately reorders retained enabled results while the post-move refresh is pending or fails', async () => {
    const first = { ...enabledState.sources[0]!, order: 0, name: 'First catalog' }
    const second = {
      ...first,
      sourceRecordId: '028f1f77-a5c4-7b73-a9ae-0242ac120003',
      providerId: 'fixture-second',
      builtInProviderKey: 'fixture-second',
      name: 'Second catalog',
      order: 1,
    }
    const initial = { sources: [first, second], builtIns: [] } as MarketStateResponse
    const moved = [
      { ...first, order: 1 },
      { ...second, order: 0, name: 'Second catalog moved' },
    ]
    let rejectRefresh: ((cause: Error) => void) | undefined
    const pendingRefresh = new Promise<MarketCatalogResponse>((_resolve, reject) => { rejectRefresh = reject })
    vi.mocked(readMarketState).mockResolvedValue(initial)
    vi.mocked(readMarketCatalog)
      .mockResolvedValueOnce(catalogFor(initial))
      .mockReturnValueOnce(pendingRefresh)
    vi.mocked(mutateMarketSource).mockResolvedValueOnce(moved)
    render(<MarketSettingsTab {...props} />)

    expect((await screen.findAllByRole('button', { name: /Fixture Plugin/u }))
      .map(button => button.textContent?.match(/Fixture Plugin \d/u)?.[0]))
      .toEqual(['Fixture Plugin 1', 'Fixture Plugin 2'])
    fireEvent.click(screen.getByRole('button', { name: en.sources }))
    fireEvent.click(screen.getAllByRole('button', { name: en.moveUp })[1]!)
    await waitFor(() => { expect(readMarketCatalog).toHaveBeenCalledTimes(2) })

    fireEvent.click(screen.getByRole('button', { name: en.discover }))
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /Fixture Plugin/u }).map(button => button.textContent?.match(/Fixture Plugin \d/u)?.[0]))
        .toEqual(['Fixture Plugin 2', 'Fixture Plugin 1'])
    })
    expect(screen.getByText(`${en.source}: Second catalog moved · Fixture provider`)).toBeTruthy()

    await act(async () => {
      rejectRefresh?.(new Error('offline'))
      await Promise.resolve()
    })
    expect(await screen.findByRole('heading', { name: en.catalogError })).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /Fixture Plugin/u }).map(button => button.textContent?.match(/Fixture Plugin \d/u)?.[0]))
      .toEqual(['Fixture Plugin 2', 'Fixture Plugin 1'])
    expect(screen.getByText(`${en.source}: Second catalog moved · Fixture provider`)).toBeTruthy()
  })

  it('adds an available source without fetching it, then fetches only after explicit enablement', async () => {
    const disabledSource = { ...enabledState.sources[0]!, enabled: false }
    vi.mocked(readMarketState).mockResolvedValue(availableState)
    vi.mocked(mutateMarketSource)
      .mockResolvedValueOnce([disabledSource])
      .mockResolvedValueOnce(enabledState.sources)
    vi.mocked(readMarketCatalog).mockResolvedValue(catalog)
    render(<MarketSettingsTab {...props} />)

    await screen.findByRole('heading', { name: en.emptyTitle })
    fireEvent.click(screen.getByRole('button', { name: en.sources }))
    expect(screen.getByRole('link', { name: 'Fixture provider' }).getAttribute('href')).toBe('https://catalog.example/')
    expect(screen.getByText('Built-in catalog attribution notice.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.add }))
    await waitFor(() => {
      expect(mutateMarketSource).toHaveBeenCalledWith(
        { action: 'add-builtin', key: 'fixture' },
        expect.any(AbortSignal),
      )
    })
    expect(readMarketCatalog).not.toHaveBeenCalled()

    fireEvent.click(await screen.findByRole('button', { name: en.enable }))
    await waitFor(() => { expect(readMarketCatalog).toHaveBeenCalledOnce() })
    fireEvent.click(screen.getByRole('button', { name: en.discover }))
    expect(await screen.findByRole('button', { name: /Fixture Plugin/u })).toBeTruthy()
  })

  it('shows a bounded failure, retries, and aborts an unfinished read on unmount', async () => {
    vi.mocked(readMarketState)
      .mockRejectedValueOnce(new Error('private transport detail'))
      .mockResolvedValueOnce(emptyState)
    const view = render(<MarketSettingsTab {...props} />)

    expect(await screen.findByRole('heading', { name: en.catalogError })).toBeTruthy()
    expect(screen.queryByText('private transport detail')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    expect(await screen.findByRole('heading', { name: en.emptyTitle })).toBeTruthy()
    expect(readMarketState).toHaveBeenCalledTimes(2)
    view.unmount()

    let signal: AbortSignal | undefined
    vi.mocked(readMarketState).mockImplementationOnce((nextSignal) => {
      signal = nextSignal
      return new Promise<MarketStateResponse>(() => {})
    })
    const pending = render(<MarketSettingsTab {...props} />)
    await waitFor(() => { expect(signal).toBeDefined() })
    await act(async () => { pending.unmount() })
    expect(signal?.aborted).toBe(true)
  })

  it('drops disabled-source results before a failed refresh can leave them visible', async () => {
    const secondSource = {
      ...enabledState.sources[0]!,
      sourceRecordId: '028f1f77-a5c4-7b73-a9ae-0242ac120003',
      providerId: 'fixture-second',
      builtInProviderKey: 'fixture-second',
      name: 'Second catalog',
      order: 1,
    }
    const initial = { ...enabledState, sources: [enabledState.sources[0]!, secondSource] }
    const afterDisable = { ...initial, sources: [{ ...initial.sources[0]!, enabled: false }, secondSource] }
    vi.mocked(readMarketState).mockResolvedValue(initial)
    vi.mocked(readMarketCatalog)
      .mockResolvedValueOnce(catalogFor(initial))
      .mockRejectedValueOnce(new Error('offline'))
    vi.mocked(mutateMarketSource).mockResolvedValue(afterDisable.sources)
    render(<MarketSettingsTab {...props} />)

    expect(await screen.findByRole('button', { name: /Fixture Plugin 1/u })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Fixture Plugin 2/u })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.sources }))
    fireEvent.click(screen.getAllByRole('button', { name: en.disable })[0]!)
    await waitFor(() => { expect(readMarketCatalog).toHaveBeenCalledTimes(2) })
    fireEvent.click(screen.getByRole('button', { name: en.discover }))

    await waitFor(() => { expect(screen.queryByRole('button', { name: /Fixture Plugin 1/u })).toBeNull() })
    expect(screen.getByRole('button', { name: /Fixture Plugin 2/u })).toBeTruthy()
  })

  it('does not let reads interrupt a pending source mutation and aborts it on unmount', async () => {
    vi.mocked(readMarketState).mockResolvedValue(enabledState)
    vi.mocked(readMarketCatalog).mockResolvedValue(catalog)
    let signal: AbortSignal | undefined
    vi.mocked(mutateMarketSource).mockImplementation((_mutation, nextSignal) => {
      signal = nextSignal
      return new Promise(() => {})
    })
    const view = render(<MarketSettingsTab {...props} />)
    await screen.findByRole('button', { name: /Fixture Plugin/u })
    fireEvent.click(screen.getByRole('button', { name: en.sources }))
    fireEvent.click(screen.getByRole('button', { name: en.disable }))
    await waitFor(() => { expect(signal).toBeDefined() })
    expect((screen.getByRole('button', { name: en.disable }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: en.discover }))
    expect((screen.getByRole('button', { name: en.refresh }) as HTMLButtonElement).disabled).toBe(true)
    expect(readMarketState).toHaveBeenCalledOnce()

    view.unmount()
    expect(signal?.aborted).toBe(true)
  })

  it('opens and closes the shared Market surface from the sidebar launcher', async () => {
    vi.mocked(readMarketState).mockResolvedValue(emptyState)
    const instance = createMarketViewStore().create()
    const useStore = <T,>(selector: (state: { open: boolean }) => T): T => useSyncExternalStore(
      instance.subscribe,
      () => selector(instance.getSnapshot()),
    )
    const shared = { actions: instance.actions, useStore }
    const launcherProps = { ...shared, wide: true, t } as unknown as MarketLauncherProps
    const overlayProps = { ...shared, readLocale: () => 'en', t } as unknown as MarketOverlayProps
    render(<>
      <MarketLauncher {...launcherProps} />
      <MarketOverlay {...overlayProps} />
    </>)

    expect(screen.queryByRole('dialog', { name: en.title })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.tab }))
    expect(await screen.findByRole('dialog', { name: en.title })).toBeTruthy()
    expect(await screen.findByRole('heading', { name: en.emptyTitle })).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: en.close })[1]!)
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: en.title })).toBeNull() })
  })
})
