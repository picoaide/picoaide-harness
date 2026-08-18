// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MarketStateResponse } from '../src/api-types.js'
import type { MarketCatalogResponse, MarketSourceView } from '../src/api-types.js'
import type {} from '../src/client/index.js'
import { MarketController } from '../src/client/controller.js'
import { MarketOverlay, type MarketOverlayProps } from '../src/client/MarketOverlay.js'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => {
  const passthrough = ({ children }: { children?: ReactNode }) => <>{children}</>
  const Button = ({
    children,
    icon,
    type = 'button',
    ...props
  }: { children?: ReactNode; icon?: ReactNode; type?: 'button' | 'submit'; [key: string]: unknown }) => (
    <button type={type} {...props}>{icon}{children}</button>
  )
  const Input = ({ icon: _icon, ...props }: { icon?: ReactNode; [key: string]: unknown }) => <input {...props} />
  const Modal = ({
    open,
    title,
    children,
    footer,
  }: { open: boolean; title: string; children?: ReactNode; footer?: ReactNode }) => open
    ? <div role="dialog"><h2>{title}</h2>{children}{footer}</div>
    : null
  const icon = () => null
  return {
    Button,
    Input,
    Modal,
    Tooltip: passthrough,
    IconCheckOutline16: icon,
    IconCloseOutline16: icon,
    IconCordisPluginOutline14: icon,
    IconDataOutline16: icon,
    IconGlobeOutline14: icon,
    IconLoadingOutline16: icon,
    IconPlusOutline16: icon,
    IconRefreshOutline16: icon,
    IconRightUpOutline16: icon,
    IconSearchOutline16: icon,
    IconSettingsOutline16: icon,
    IconTrashOutline16: icon,
    IconWarningOutline16: icon,
  }
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const t = ((key: string) => key) as PropsLocale<'community-market'>['t']

function props(controller: MarketController): MarketOverlayProps {
  return {
    controller,
    readLocale: () => 'en',
    t,
    useSessions: (() => undefined) as MarketOverlayProps['useSessions'],
    useWorkspaces: (() => undefined) as MarketOverlayProps['useWorkspaces'],
  }
}

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const source: MarketSourceView = {
  sourceRecordId: '018f1f77-a5c4-7b73-a9ae-0242ac120002',
  registrationKind: 'built-in',
  adapterId: 'market.dsh-1024store-v1',
  providerId: 'com.deepseek1024.catalog',
  builtInProviderKey: 'dsh-1024store',
  enabled: true,
  order: 0,
  name: 'DSH 1024Store',
  endpoint: 'https://api.deepseek1024.com/v1/plugins/search',
  partnership: true,
}

const stateWithSource: MarketStateResponse = {
  sources: [source],
  builtIns: [],
}

const catalogWithItem: MarketCatalogResponse = {
  query: {},
  fetchedAt: '2026-08-18T04:00:00.000Z',
  results: [{
    source,
    stale: false,
    snapshot: {
      schemaVersion: '1.0.0',
      source: {
        sourceRecordId: source.sourceRecordId,
        providerId: source.providerId,
        adapterId: source.adapterId,
        registrationKind: source.registrationKind,
        fetchedAt: '2026-08-18T04:00:00.000Z',
        finalUrl: source.endpoint,
      },
      items: [{
        id: 'example/better-sidebar',
        name: 'dsh-plugin-better-sidebar',
        displayName: 'Better Sidebar',
        summary: 'Adds a configurable sidebar panel.',
        repository: { url: 'https://github.com/example/better-sidebar' },
        provenance: {
          sourceRecordId: source.sourceRecordId,
          providerId: source.providerId,
          itemId: 'example/better-sidebar',
        },
      }],
      page: { total: 1 },
    },
  }],
}

describe('community market overlay', () => {
  it('shows the empty source state without requesting a catalog', async () => {
    const state: MarketStateResponse = { sources: [], builtIns: [] }
    const request = vi.fn<typeof fetch>(async () => response(state))
    vi.stubGlobal('fetch', request)
    const controller = new MarketController()

    render(<MarketOverlay {...props(controller)} />)
    controller.open()

    expect(await screen.findByRole('heading', { name: 'emptyTitle' })).toBeTruthy()
    expect(request).toHaveBeenCalledTimes(1)
    expect(String(request.mock.calls[0]?.[0])).toContain('/api/community-market/state')
    expect(screen.getByText('emptyBody')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'chooseSources' }))
    await waitFor(() => { expect(screen.getByRole('heading', { name: 'sources' })).toBeTruthy() })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('loads and renders plugin cards when a source is enabled', async () => {
    const request = vi.fn<typeof fetch>(async (input) => (
      String(input).includes('/state') ? response(stateWithSource) : response(catalogWithItem)
    ))
    vi.stubGlobal('fetch', request)
    const controller = new MarketController()

    render(<MarketOverlay {...props(controller)} />)
    controller.open()

    expect(await screen.findByText('Better Sidebar')).toBeTruthy()
    expect(screen.getByText('Adds a configurable sidebar panel.')).toBeTruthy()
    expect(request).toHaveBeenCalledTimes(2)
    expect(String(request.mock.calls[0]?.[0])).toContain('/api/community-market/state')
    expect(String(request.mock.calls[1]?.[0])).toContain('/api/community-market/catalog')
  })

  it('submits a trimmed search query to the catalog route', async () => {
    const request = vi.fn<typeof fetch>(async (input) => (
      String(input).includes('/state') ? response(stateWithSource) : response(catalogWithItem)
    ))
    vi.stubGlobal('fetch', request)
    const controller = new MarketController()

    render(<MarketOverlay {...props(controller)} />)
    controller.open()
    await screen.findByText('Better Sidebar')

    fireEvent.change(screen.getByPlaceholderText('search'), { target: { value: '  sidebar  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'searchAction' }))

    await waitFor(() => { expect(request).toHaveBeenCalledTimes(3) })
    const catalogUrl = new URL(String(request.mock.calls[2]?.[0]))
    expect(catalogUrl.searchParams.get('q')).toBe('sidebar')
    expect(catalogUrl.searchParams.get('locale')).toBe('en')
  })
})
