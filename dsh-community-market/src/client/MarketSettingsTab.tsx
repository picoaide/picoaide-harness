import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Button,
  IconCheckOutline16,
  IconChevronDownOutline14,
  IconChevronUpOutline14,
  IconCordisPluginOutline14,
  IconDataOutline16,
  IconGlobeOutline14,
  IconPlusOutline16,
  IconRefreshOutline16,
  IconRightUpOutline16,
  IconSearchOutline16,
  IconSettingsOutline16,
  IconTrashOutline16,
  Input,
  Modal,
  Pill,
  StateDot,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CatalogSnapshot } from '../contracts/generated/catalog-snapshot.js'
import type {
  MarketBuiltInProvider,
  MarketCatalogResponse,
  MarketCatalogSourceResult,
  MarketSourceMutation,
  MarketSourceView,
  MarketStateResponse,
} from '../api-types.js'
import { marketMediaAssetUrl } from '../media/ref.js'
import { mutateMarketSource, readMarketCatalog, readMarketState, readMoreMarketCatalog } from './api.js'

type MarketItem = CatalogSnapshot['items'][number]
type MarketView = 'discover' | 'sources'

interface VisibleItem {
  readonly item: MarketItem
  readonly source: MarketSourceView
  readonly stale: boolean
}

function PluginIcon({ item, large = false }: { item: MarketItem; large?: boolean }) {
  const icon = item.media?.icon
  return (
    <div className={large ? 'dshMarketGlyph dshMarketGlyphLarge' : 'dshMarketGlyph'}>
      <IconCordisPluginOutline14 size={large ? 28 : 20} />
      {icon !== undefined && (
        <img
          src={marketMediaAssetUrl(icon.assetRef)}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={event => { event.currentTarget.remove() }}
        />
      )}
    </div>
  )
}

export type MarketSettingsTabProps = PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'community-market'>
  & { readLocale: () => string }

export interface MarketSurfaceProps {
  readonly readLocale: () => string
  readonly t: MarketSettingsTabProps['t']
  readonly showHeader?: boolean
}

function retainEnabledCatalog(
  catalog: MarketCatalogResponse | undefined,
  sources: readonly MarketSourceView[],
): MarketCatalogResponse | undefined {
  if (catalog === undefined) return undefined
  const selected = [...sources]
    .filter(source => source.enabled)
    .sort((left, right) => left.order - right.order)
    .at(0)
  if (selected === undefined) return undefined
  const result = catalog.results.find(value => value.source.sourceRecordId === selected.sourceRecordId)
  return result === undefined ? undefined : { ...catalog, results: [{ ...result, source: selected }] }
}

function selectedSource(sources: readonly MarketSourceView[]): MarketSourceView | undefined {
  return [...sources]
    .filter(source => source.enabled)
    .sort((left, right) => left.order - right.order)
    .at(0)
}

function categoriesFromCatalog(catalog: MarketCatalogResponse): readonly string[] {
  const categories = new Set<string>()
  for (const result of catalog.results) {
    for (const item of result.snapshot?.items ?? []) {
      for (const category of item.categories ?? []) categories.add(category)
    }
  }
  return [...categories]
}

function mergeCatalogPages(
  catalog: MarketCatalogResponse | undefined,
  pages: readonly MarketCatalogSourceResult[],
): MarketCatalogResponse | undefined {
  if (catalog === undefined || pages.length === 0) return catalog
  const updates = new Map(pages.map(page => [page.source.sourceRecordId, page]))
  const results = catalog.results.map(current => {
    const next = updates.get(current.source.sourceRecordId)
    if (current.snapshot === undefined || next?.snapshot === undefined) return current
    const seen = new Set<string>()
    const items = [...current.snapshot.items, ...next.snapshot.items].filter(item => {
      if (seen.has(item.id)) return false
      seen.add(item.id)
      return true
    })
    return {
      ...next,
      source: current.source,
      snapshot: { ...next.snapshot, items, page: next.snapshot.page },
    }
  })
  return { ...catalog, results, fetchedAt: new Date().toISOString() }
}

export function MarketSurface({ readLocale, t, showHeader = true }: MarketSurfaceProps) {
  const [view, setView] = useState<MarketView>('discover')
  const [state, setState] = useState<MarketStateResponse>()
  const [catalog, setCatalog] = useState<MarketCatalogResponse>()
  const [query, setQuery] = useState('')
  const [appliedQuery, setAppliedQuery] = useState('')
  const [categoryOptions, setCategoryOptions] = useState<readonly string[]>([])
  const [selectedCategories, setSelectedCategories] = useState<readonly string[]>([])
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string>()
  const [loadMoreError, setLoadMoreError] = useState<string>()
  const [selected, setSelected] = useState<VisibleItem>()
  const [addOpen, setAddOpen] = useState(false)
  const [manifestUrl, setManifestUrl] = useState('')
  const [mutationError, setMutationError] = useState<string>()
  const [mutationPending, setMutationPending] = useState(false)
  const readRequest = useRef<AbortController>()
  const pageRequest = useRef<AbortController>()
  const mutationRequest = useRef<AbortController>()

  const rememberCategories = useCallback((next: MarketCatalogResponse) => {
    const discovered = categoriesFromCatalog(next)
    if (discovered.length === 0) return
    setCategoryOptions(current => [...new Set([...current, ...discovered])]
      .sort((left, right) => left.localeCompare(right, 'en', { sensitivity: 'base' })))
  }, [])

  const loadCatalog = useCallback(async (
    nextState: MarketStateResponse,
    q: string,
    categories: readonly string[],
  ) => {
    readRequest.current?.abort()
    pageRequest.current?.abort()
    pageRequest.current = undefined
    setLoadingMore(false)
    setLoadMoreError(undefined)
    const selected = selectedSource(nextState.sources)
    if (selected === undefined) {
      readRequest.current = undefined
      setCatalog(undefined)
      setQuery('')
      setAppliedQuery('')
      setCategoryOptions([])
      setSelectedCategories([])
      setError(undefined)
      setLoading(false)
      return
    }
    const effectiveQuery = q.trim()
    const request = new AbortController()
    readRequest.current = request
    setLoading(true)
    setError(undefined)
    try {
      const next = await readMarketCatalog(selected.sourceRecordId, effectiveQuery, readLocale(), categories, request.signal)
      if (!request.signal.aborted && readRequest.current === request) {
        const retained = retainEnabledCatalog(next, nextState.sources)
        const result = retained?.results[0]
        if (retained === undefined || result?.snapshot === undefined) {
          setError(t('catalogError'))
          return
        }
        rememberCategories(retained)
        setAppliedQuery(effectiveQuery)
        setSelectedCategories([...categories])
        setCatalog(retained)
      }
    } catch {
      if (!request.signal.aborted && readRequest.current === request) setError(t('catalogError'))
    } finally {
      if (readRequest.current === request) {
        readRequest.current = undefined
        setLoading(false)
      }
    }
  }, [readLocale, rememberCategories, t])

  const loadState = useCallback(async (q: string, categories: readonly string[]) => {
    if (mutationRequest.current !== undefined) return
    readRequest.current?.abort()
    pageRequest.current?.abort()
    pageRequest.current = undefined
    setLoadingMore(false)
    setLoadMoreError(undefined)
    const request = new AbortController()
    readRequest.current = request
    setLoading(true)
    setError(undefined)
    try {
      const next = await readMarketState(request.signal)
      if (request.signal.aborted || readRequest.current !== request) return
      setState(next)
      setCatalog(current => retainEnabledCatalog(current, next.sources))
      readRequest.current = undefined
      await loadCatalog(next, q, categories)
    } catch {
      if (!request.signal.aborted && readRequest.current === request) setError(t('catalogError'))
    } finally {
      if (readRequest.current === request) {
        readRequest.current = undefined
        setLoading(false)
      }
    }
  }, [loadCatalog, t])

  useEffect(() => {
    setQuery('')
    void loadState('', [])
    return () => {
      readRequest.current?.abort()
      pageRequest.current?.abort()
      mutationRequest.current?.abort()
      readRequest.current = undefined
      pageRequest.current = undefined
      mutationRequest.current = undefined
    }
  }, [loadState])

  const items = useMemo(() => catalog?.results.flatMap(result =>
    (result.snapshot?.items ?? []).map(item => ({ item, source: result.source, stale: result.stale }))) ?? [], [catalog])
  const pageTarget = useMemo(() => catalog?.results.flatMap(result => {
    const cursor = result.snapshot?.page?.nextCursor
    return cursor === undefined ? [] : [{ sourceRecordId: result.source.sourceRecordId, cursor }]
  }).at(0), [catalog])
  const partialFailure = catalog?.results.some(result => result.error !== undefined) ?? false
  const currentSource = state === undefined ? undefined : selectedSource(state.sources)

  const mutate = async (mutation: MarketSourceMutation): Promise<boolean> => {
    if (mutationRequest.current !== undefined) return false
    readRequest.current?.abort()
    pageRequest.current?.abort()
    readRequest.current = undefined
    pageRequest.current = undefined
    setLoading(false)
    setLoadingMore(false)
    setLoadMoreError(undefined)
    const request = new AbortController()
    mutationRequest.current = request
    setMutationPending(true)
    setMutationError(undefined)
    try {
      const sources = await mutateMarketSource(mutation, request.signal)
      if (request.signal.aborted || mutationRequest.current !== request) return false
      const next = { sources, builtIns: state?.builtIns ?? [] }
      const sourceChanged = selectedSource(state?.sources ?? [])?.sourceRecordId
        !== selectedSource(sources)?.sourceRecordId
      setState(next)
      if (sourceChanged) {
        setCatalog(undefined)
        setQuery('')
        setAppliedQuery('')
        setCategoryOptions([])
        setSelectedCategories([])
        setSelected(undefined)
      } else {
        setCatalog(current => retainEnabledCatalog(current, sources))
      }
      mutationRequest.current = undefined
      setMutationPending(false)
      await loadCatalog(next, sourceChanged ? '' : appliedQuery, sourceChanged ? [] : selectedCategories)
      return true
    } catch {
      if (!request.signal.aborted && mutationRequest.current === request) setMutationError(t('sourceError'))
      return false
    } finally {
      if (mutationRequest.current === request) {
        mutationRequest.current = undefined
        setMutationPending(false)
      }
    }
  }

  const toggleCategory = (category: string) => {
    if (state === undefined) return
    const categories = selectedCategories.includes(category)
      ? selectedCategories.filter(value => value !== category)
      : [...selectedCategories, category]
    setSelected(undefined)
    void loadCatalog(state, appliedQuery, categories)
  }

  const loadMore = async () => {
    if (pageRequest.current !== undefined || pageTarget === undefined) return
    const request = new AbortController()
    pageRequest.current = request
    setLoadingMore(true)
    setLoadMoreError(undefined)
    try {
      const next = await readMoreMarketCatalog(
        pageTarget.sourceRecordId,
        pageTarget.cursor,
        appliedQuery,
        readLocale(),
        selectedCategories,
        request.signal,
      )
      if (request.signal.aborted || pageRequest.current !== request) return
      const page = next.results.find(value => value.source.sourceRecordId === pageTarget.sourceRecordId)
      if (page?.snapshot === undefined || page.error !== undefined) {
        setLoadMoreError(t('loadMoreError'))
        return
      }
      rememberCategories(next)
      setCatalog(current => mergeCatalogPages(current, [page]))
    } catch {
      if (!request.signal.aborted && pageRequest.current === request) setLoadMoreError(t('loadMoreError'))
    } finally {
      if (pageRequest.current === request) {
        pageRequest.current = undefined
        setLoadingMore(false)
      }
    }
  }

  return (
    <section className="dshMarketRoot" aria-label={t('title')} aria-busy={loading || loadingMore || mutationPending}>
      {showHeader && (
        <header className="dshMarketHeader">
          <div className="dshMarketHeaderTitle">
            <h2>{t('title')}</h2>
            <p>{t('subtitle')}</p>
          </div>
        </header>
      )}
      <div className="dshMarketViewBar">
        <div className="dshMarketViewSwitch" role="group" aria-label={t('title')}>
          <Pill active={view === 'discover'} aria-pressed={view === 'discover'} onClick={() => setView('discover')}>
            <IconDataOutline16 size={14} /><span>{t('discover')}</span>
          </Pill>
          <Pill active={view === 'sources'} aria-pressed={view === 'sources'} onClick={() => setView('sources')}>
            <IconSettingsOutline16 size={14} /><span>{t('sources')}</span>
          </Pill>
        </div>
        <Pill>{currentSource === undefined ? t('noSourceSelected') : `${t('currentSource')}: ${currentSource.name}`}</Pill>
      </div>
      <main className="dshMarketMain">
        {view === 'discover' ? (
          <DiscoverView
            state={state}
            items={items}
            query={query}
            categoryOptions={categoryOptions}
            selectedCategories={selectedCategories}
            loading={loading}
            loadingMore={loadingMore}
            mutationPending={mutationPending}
            error={error}
            loadMoreError={loadMoreError}
            partialFailure={partialFailure}
            onQuery={setQuery}
            onSearch={() => state !== undefined && void loadCatalog(state, query, selectedCategories)}
            onRefresh={() => void loadState(appliedQuery, selectedCategories)}
            onToggleCategory={toggleCategory}
            onLoadMore={() => { void loadMore() }}
            hasMore={pageTarget !== undefined}
            onSources={() => setView('sources')}
            onSelect={setSelected}
            t={t}
          />
        ) : (
          <SourcesView
            state={state}
            catalog={catalog}
            error={mutationError}
            pending={mutationPending}
            onMutation={mutation => { void mutate(mutation) }}
            onAddStandard={() => setAddOpen(true)}
            t={t}
          />
        )}
      </main>
      {selected !== undefined && <DetailsModal value={selected} onClose={() => setSelected(undefined)} t={t} />}
      <Modal
        open={addOpen}
        onClose={() => { if (!mutationPending) setAddOpen(false) }}
        title={t('addStandard')}
        closeLabel={t('cancel')}
        description={t('sourceNotice')}
        footer={<>
          <Button variant="ghost" disabled={mutationPending} onClick={() => setAddOpen(false)}>{t('cancel')}</Button>
          <Button
            variant="primary"
            icon={<IconPlusOutline16 />}
            disabled={mutationPending || !manifestUrl.trim()}
            onClick={() => {
              void mutate({ action: 'add-standard', manifestUrl: manifestUrl.trim() }).then(succeeded => {
                if (!succeeded) return
                setManifestUrl('')
                setAddOpen(false)
              })
            }}
          >{t('confirmAdd')}</Button>
        </>}
      >
        <div className="dshMarketModalField">
          <label htmlFor="dsh-market-manifest">{t('standardSource')}</label>
          <Input
            id="dsh-market-manifest"
            value={manifestUrl}
            disabled={mutationPending}
            placeholder={t('manifestPlaceholder')}
            onChange={event => setManifestUrl(event.currentTarget.value)}
          />
          {mutationError !== undefined && <div className="dshMarketError" role="alert">{mutationError}</div>}
        </div>
      </Modal>
    </section>
  )
}

export function MarketSettingsTab({ readLocale, t }: MarketSettingsTabProps) {
  return <MarketSurface readLocale={readLocale} t={t} />
}

function DiscoverView(props: {
  state?: MarketStateResponse | undefined
  items: readonly VisibleItem[]
  query: string
  categoryOptions: readonly string[]
  selectedCategories: readonly string[]
  loading: boolean
  loadingMore: boolean
  mutationPending: boolean
  error?: string | undefined
  loadMoreError?: string | undefined
  partialFailure: boolean
  hasMore: boolean
  onQuery: (value: string) => void
  onSearch: () => void
  onRefresh: () => void
  onToggleCategory: (category: string) => void
  onLoadMore: () => void
  onSources: () => void
  onSelect: (value: VisibleItem) => void
  t: MarketSettingsTabProps['t']
}) {
  const noSources = props.state !== undefined && !props.state.sources.some(source => source.enabled)
  if (noSources) return (
    <div className="dshMarketEmpty">
      <div className="dshMarketEmptyIcon"><IconGlobeOutline14 size={24} /></div>
      <h2>{props.t('emptyTitle')}</h2>
      <p>{props.t('emptyBody')}</p>
      <Button variant="primary" icon={<IconSettingsOutline16 />} onClick={props.onSources}>{props.t('chooseSources')}</Button>
    </div>
  )
  return (
    <div className="dshMarketContent">
      <form className="dshMarketToolbar" onSubmit={event => { event.preventDefault(); props.onSearch() }}>
        <Input
          className="dshMarketSearch"
          icon={<IconSearchOutline16 />}
          value={props.query}
          disabled={props.mutationPending}
          placeholder={props.t('search')}
          onChange={event => props.onQuery(event.currentTarget.value)}
        />
        <Button type="submit" variant="primary" disabled={props.mutationPending} icon={<IconSearchOutline16 />}>{props.t('searchAction')}</Button>
        <Tooltip label={props.t('refresh')}>
          <Button
            type="button"
            size="sm"
            variant="toolbar"
            aria-label={props.t('refresh')}
            disabled={props.loading || props.loadingMore || props.mutationPending}
            icon={<IconRefreshOutline16 />}
            onClick={props.onRefresh}
          />
        </Tooltip>
        <Pill>{props.items.length}</Pill>
      </form>
      {props.categoryOptions.length > 0 && (
        <div className="dshMarketCategories" role="group" aria-label={props.t('categories')}>
          <span>{props.t('categories')}</span>
          {props.categoryOptions.map(category => (
            <Pill
              key={category}
              active={props.selectedCategories.includes(category)}
              aria-pressed={props.selectedCategories.includes(category)}
              disabled={props.mutationPending}
              onClick={() => props.onToggleCategory(category)}
            >{category}</Pill>
          ))}
        </div>
      )}
      {props.partialFailure && <div className="dshMarketBanner" role="status"><StateDot state="warning" />{props.t('partialFailure')}</div>}
      {props.error !== undefined && (
        <div className="dshMarketEmpty" role="alert">
          <StateDot state="error" size={14} />
          <h2>{props.t('catalogError')}</h2><p>{props.error}</p>
          <Button variant="outline" icon={<IconRefreshOutline16 />} onClick={props.onRefresh}>{props.t('retry')}</Button>
        </div>
      )}
      {props.error === undefined && props.loading && props.items.length === 0 && (
        <div className="dshMarketEmpty"><StateDot state="ongoing" size={16} /><p>{props.t('loading')}</p></div>
      )}
      {props.error === undefined && !props.loading && props.items.length === 0 && (
        <div className="dshMarketEmpty"><h2>{props.t('noResults')}</h2></div>
      )}
      <div className="dshMarketGrid">
        {props.items.map(value => <PluginCard key={`${value.source.sourceRecordId}:${value.item.id}`} value={value} onClick={() => props.onSelect(value)} t={props.t} />)}
      </div>
      {(props.hasMore || props.loadMoreError !== undefined) && (
        <div className="dshMarketPagination">
          {props.loadMoreError !== undefined && <div className="dshMarketPaginationError" role="status">{props.loadMoreError}</div>}
          {props.hasMore && (
            <Button
              type="button"
              variant="outline"
              disabled={props.loading || props.loadingMore || props.mutationPending}
              onClick={props.onLoadMore}
            >{props.loadingMore ? props.t('loadingMore') : props.t('loadMore')}</Button>
          )}
        </div>
      )}
    </div>
  )
}

function PluginCard({ value, onClick, t }: { value: VisibleItem; onClick: () => void; t: MarketSettingsTabProps['t'] }) {
  const publisher = value.item.publisher?.name ?? value.source.name
  const attribution = value.source.attribution?.name
  const sourceLabel = attribution === undefined || attribution === value.source.name
    ? value.source.name
    : `${value.source.name} · ${attribution}`
  return (
    <button type="button" className="dshMarketCard" onClick={onClick}>
      <div className="dshMarketCardTop">
        <PluginIcon item={value.item} />
        <div className="dshMarketCardName"><strong>{value.item.displayName}</strong><span>{publisher}</span></div>
      </div>
      <p className="dshMarketSummary">{value.item.summary}</p>
      <div className="dshMarketTags">
        <Pill>{t('source')}: {sourceLabel}</Pill>
        {value.stale && <Pill>{t('stale')}</Pill>}
        {value.item.categories?.slice(0, 2).map(category => <Pill key={category}>{category}</Pill>)}
      </div>
    </button>
  )
}

function SourceAttribution({ attribution }: {
  attribution: NonNullable<MarketSourceView['attribution']>
}) {
  const href = (() => {
    try {
      const url = new URL(attribution.url)
      if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443')) {
        return undefined
      }
      return url.href
    } catch {
      return undefined
    }
  })()
  return (
    <div className="dshMarketSourceAttribution">
      {href === undefined
        ? <span>{attribution.name}</span>
        : <a href={href} target="_blank" rel="noopener noreferrer">{attribution.name}</a>}
      {attribution.notice !== undefined && <span>{attribution.notice}</span>}
    </div>
  )
}

function SourcesView({ state, catalog, error, pending, onMutation, onAddStandard, t }: {
  state?: MarketStateResponse | undefined
  catalog?: MarketCatalogResponse | undefined
  error?: string | undefined
  pending: boolean
  onMutation: (mutation: MarketSourceMutation) => void
  onAddStandard: () => void
  t: MarketSettingsTabProps['t']
}) {
  const selectedKeys = new Set(state?.sources.map(source => source.builtInProviderKey).filter(Boolean))
  const available = state?.builtIns.filter(provider => !selectedKeys.has(provider.key)) ?? []
  return (
    <div className="dshMarketContent">
      <div className="dshMarketSectionHead">
        <div><h2>{t('sources')}</h2><p>{t('sourceNotice')}</p></div>
        <Button variant="outline" disabled={pending} icon={<IconPlusOutline16 />} onClick={onAddStandard}>{t('addStandard')}</Button>
      </div>
      {error !== undefined && <div className="dshMarketBanner" role="alert"><StateDot state="error" />{error}</div>}
      <div className="dshMarketSources" role="radiogroup" aria-label={t('sourceSelection')}>
        {state?.sources.map((source, index, sources) => (
          <SourceRow
            key={source.sourceRecordId}
            source={source}
            result={catalog?.results.find(result => result.source.sourceRecordId === source.sourceRecordId)}
            pending={pending}
            canMoveUp={index > 0}
            canMoveDown={index < sources.length - 1}
            onMoveUp={() => onMutation({ action: 'move', sourceRecordId: source.sourceRecordId, direction: 'up' })}
            onMoveDown={() => onMutation({ action: 'move', sourceRecordId: source.sourceRecordId, direction: 'down' })}
            onSelect={() => {
              if (!source.enabled) onMutation({ action: 'select', sourceRecordId: source.sourceRecordId })
            }}
            onRemove={() => onMutation({ action: 'remove', sourceRecordId: source.sourceRecordId })}
            t={t}
          />
        ))}
      </div>
      {available.length > 0 && <div className="dshMarketSources dshMarketAvailableSources">
        {available.map(provider => (
          <AvailableSource
            key={provider.key}
            provider={provider}
            pending={pending}
            onAdd={() => onMutation({ action: 'add-builtin', key: provider.key })}
            t={t}
          />
        ))}
      </div>}
    </div>
  )
}

function SourceRow({ source, result, pending, canMoveUp, canMoveDown, onMoveUp, onMoveDown, onSelect, onRemove, t }: {
  source: MarketSourceView
  result?: MarketCatalogSourceResult | undefined
  pending: boolean
  canMoveUp: boolean
  canMoveDown: boolean
  onMoveUp: () => void
  onMoveDown: () => void
  onSelect: () => void
  onRemove: () => void
  t: MarketSettingsTabProps['t']
}) {
  const endpointHost = (() => {
    try { return new URL(source.endpoint).host }
    catch { return source.endpoint }
  })()
  const resultLabel = result === undefined
    ? t('notChecked')
    : result.error !== undefined && result.snapshot === undefined
      ? t('unavailable')
      : result.stale
        ? t('lastStale')
        : t('available')
  const resultState = result === undefined
    ? 'ongoing'
    : result.error !== undefined && result.snapshot === undefined
      ? 'error'
      : result.stale
        ? 'warning'
        : 'done'
  return (
    <div className="dshMarketSource">
      <div>
        <h3>{source.name}{source.partnership && <Pill>{t('partner')}</Pill>}</h3>
        <p>{source.description ?? source.endpoint}</p>
        {source.attribution !== undefined && <SourceAttribution attribution={source.attribution} />}
        <div className="dshMarketSourceMeta">
          {source.attribution === undefined && <span>{source.providerId}</span>}
          <span>{endpointHost}</span>
          <span>{source.registrationKind === 'built-in' ? t('builtIn') : t('standardAdapter')}</span>
          <span><StateDot state={resultState} size={10} />{resultLabel}</span>
        </div>
      </div>
      <div className="dshMarketSourceActions">
        <Tooltip label={t('moveUp')}>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={t('moveUp')}
            disabled={pending || !canMoveUp}
            icon={<IconChevronUpOutline14 />}
            onClick={onMoveUp}
          />
        </Tooltip>
        <Tooltip label={t('moveDown')}>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={t('moveDown')}
            disabled={pending || !canMoveDown}
            icon={<IconChevronDownOutline14 />}
            onClick={onMoveDown}
          />
        </Tooltip>
        <Button
          variant="outline"
          size="sm"
          role="radio"
          aria-checked={source.enabled}
          disabled={pending}
          icon={source.enabled ? <IconCheckOutline16 /> : undefined}
          onClick={onSelect}
        >{source.enabled ? t('selectedSource') : t('selectSource')}</Button>
        <Tooltip label={t('remove')}>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={t('remove')}
            disabled={pending}
            icon={<IconTrashOutline16 />}
            onClick={onRemove}
          />
        </Tooltip>
      </div>
    </div>
  )
}

function AvailableSource({ provider, pending, onAdd, t }: {
  provider: MarketBuiltInProvider
  pending: boolean
  onAdd: () => void
  t: MarketSettingsTabProps['t']
}) {
  return (
    <div className="dshMarketSource">
      <div>
        <h3>{provider.name}{provider.partnership && <Pill>{t('partner')}</Pill>}</h3>
        <p>{provider.description}</p>
        <SourceAttribution attribution={provider.attribution} />
      </div>
      <Button variant="outline" size="sm" disabled={pending} icon={<IconPlusOutline16 />} onClick={onAdd}>{t('add')}</Button>
    </div>
  )
}

function DetailsModal({ value, onClose, t }: { value: VisibleItem; onClose: () => void; t: MarketSettingsTabProps['t'] }) {
  const attribution = value.source.attribution?.name
  const sourceLabel = attribution === undefined || attribution === value.source.name
    ? value.source.name
    : `${value.source.name} · ${attribution}`
  return (
    <Modal
      open
      onClose={onClose}
      title={value.item.displayName}
      closeLabel={t('close')}
      description={`${t('source')}: ${sourceLabel}`}
      footer={value.item.repository === undefined ? undefined : (
        <Button
          variant="outline"
          icon={<IconRightUpOutline16 />}
          onClick={() => window.open(value.item.repository!.url, '_blank', 'noopener,noreferrer')}
        >
          {t('repository')}
        </Button>
      )}
    >
      <div className="dshMarketDetails">
        <div className="dshMarketDetailsIntro">
          <PluginIcon item={value.item} large />
          <p>{value.item.description ?? value.item.summary}</p>
        </div>
        <div>{t('readOnly')}</div>
      </div>
    </Modal>
  )
}
