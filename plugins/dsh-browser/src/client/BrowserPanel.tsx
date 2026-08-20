import { useCallback, useEffect, useRef, useState } from 'react'
import { t } from './locales.ts'

/**
 * Embedded browser modal: toolbar + tab strip + the native-view placeholder.
 * The native WebContentsView is layered over the placeholder by the host; the
 * panel reports the placeholder bounds so the host lays the view out over it.
 *
 * P1-fix: the panel is a fixed overlay (like the skill/connector centers),
 * NOT an inline block in the sidebar footer — the footer's auto-height
 * container collapsed the placeholder to 0 and hid the native view.
 */

interface TabInfo {
  id: number
  url: string
  title: string
  loading: boolean
  visible: boolean
}

interface BrowserState {
  tabs: TabInfo[]
  controlled: boolean
}

interface OpEntry {
  seq: number
  time: number
  tool: string
  tab: number
  summary: string
  failed: boolean
}

const POLL_INTERVAL_MS = 2000

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { error?: string } | null
    throw new Error(body?.error ?? `HTTP ${res.status}`)
  }
  return await res.json() as T
}

const OVERLAY: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 1000,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
}

const MASK: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  background: 'var(--dsw-alias-bg-mask-1)',
  backdropFilter: 'var(--dsw-mask-blur)',
}

const PANEL: React.CSSProperties = {
  position: 'relative',
  zIndex: 1,
  display: 'flex',
  flexDirection: 'column',
  width: 960,
  maxWidth: 'calc(100vw - 48px)',
  height: 'min(720px, calc(100vh - 48px))',
  borderRadius: 24,
  overflow: 'hidden',
  background: 'var(--dsw-alias-bg-layer-2)',
  boxShadow: 'var(--dsw-shadow-lv3)',
  padding: 12,
  boxSizing: 'border-box',
  gap: 8,
}

const HEADER: React.CSSProperties = {
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
}

const TITLE: React.CSSProperties = { margin: 0, fontSize: 16, lineHeight: '24px', fontWeight: 500, color: 'var(--dsw-alias-label-primary)' }

const CLOSE: React.CSSProperties = {
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  color: 'var(--dsw-alias-label-caption)',
  fontSize: 13,
  padding: '4px 8px',
  borderRadius: 6,
}

const toolbarButton: React.CSSProperties = {
  padding: '4px 8px',
  fontSize: 12,
  borderRadius: 4,
  border: '1px solid #8884',
  background: 'transparent',
  cursor: 'pointer',
  color: 'inherit',
}

const inputStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: '4px 8px',
  fontSize: 12,
  borderRadius: 4,
  border: '1px solid #8884',
  background: 'transparent',
  color: 'inherit',
}

export function BrowserPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [state, setState] = useState<BrowserState>({ tabs: [], controlled: false })
  const [ops, setOps] = useState<OpEntry[]>([])
  const [address, setAddress] = useState('')
  // Once the user edits the address bar, stop overwriting it with the
  // visible tab's URL until it is submitted (UX: the bar normally mirrors
  // the current page; typing hands it over to the user).
  const addressDirtyRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const viewRef = useRef<HTMLDivElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)

  // Report the view placeholder bounds so the host lays the native view over it.
  useEffect(() => {
    const el = viewRef.current
    if (el === null) return
    const report = (): void => {
      const rect = el.getBoundingClientRect()
      void fetchJson('/api/pico/browser/panel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          visible: true,
          bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        }),
      }).catch(() => {})
    }
    report()
    const observer = new ResizeObserver(report)
    observer.observe(el)
    window.addEventListener('resize', report)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', report)
      void fetchJson('/api/pico/browser/panel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visible: false }),
      }).catch(() => {})
    }
  }, [])

  // Poll browser state + op log.
  useEffect(() => {
    let alive = true
    const poll = async (): Promise<void> => {
      try {
        const next = await fetchJson<BrowserState>('/api/pico/browser/state')
        if (!alive) return
        setState(next)
        // Mirror the visible tab's URL into the address bar unless the user
        // is typing (UX: the bar reflects where the browser actually is).
        const visible = next.tabs.find((t) => t.visible)
        if (!addressDirtyRef.current) setAddress(visible?.url ?? '')
        const log = await fetchJson<{ ops: OpEntry[] }>('/api/pico/browser/ops')
        if (!alive) return
        setOps(log.ops.slice(0, 20))
        setError(null)
      } catch (cause) {
        if (alive) setError(cause instanceof Error ? cause.message : String(cause))
      }
    }
    void poll()
    const timer = setInterval(() => { void poll() }, POLL_INTERVAL_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])

  // Esc closes; initial focus lands on the panel so keyboard users can act.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    panelRef.current?.focus()
    return () => { window.removeEventListener('keydown', onKey) }
  }, [onClose])

  const post = useCallback(async (action: string, body?: Record<string, unknown>): Promise<void> => {
    try {
      await fetchJson(`/api/pico/browser/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  const openAddress = (): void => {
    const url = address.trim()
    if (url === '') return
    const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url) ? url : `https://${url}`
    if (state.tabs.length === 0) void post('open', { url: withScheme })
    else void post('navigate', { tab: state.tabs.find((t) => t.visible)?.id, url: withScheme })
    setAddress('')
  }

  const visibleTab = state.tabs.find((t) => t.visible)?.id

  return (
    <div style={OVERLAY} role="presentation">
      <div style={MASK} aria-hidden="true" onClick={onClose} />
      <div style={PANEL} role="dialog" aria-modal="true" aria-label={t('panel.title')} tabIndex={-1} ref={panelRef}>
        <div style={HEADER}>
          <h2 style={TITLE}>{t('panel.title')}</h2>
          <button type="button" style={CLOSE} onClick={onClose} aria-label={t('panel.close')}>{t('panel.close')}</button>
        </div>

        {/* Tab strip */}
        <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap', flex: 'none' }}>
          {state.tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => { void post('switch-tab', { tab: tab.id }) }}
              style={{
                ...toolbarButton,
                fontWeight: tab.visible ? 700 : 400,
                maxWidth: 160,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={tab.url}
              aria-label={`${t('panel.tab')} ${tab.id}${tab.loading ? ` (${t('panel.loading')})` : ''}`}
            >
              {tab.title || tab.url || `${t('panel.tab')} ${tab.id}`}
              {tab.loading ? '…' : ''}
              {' '}
              <span
                role="button"
                tabIndex={0}
                aria-label={t('panel.closeTab')}
                onClick={(e) => { e.stopPropagation(); void post('close-tab', { tab: tab.id }) }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.stopPropagation()
                    void post('close-tab', { tab: tab.id })
                  }
                }}
                style={{ marginLeft: 4, opacity: 0.6, cursor: 'pointer' }}
              >
                ×
              </span>
            </button>
          ))}
          <button style={toolbarButton} onClick={() => { void post('open') }} title={t('panel.newTab')} aria-label={t('panel.newTab')}>+</button>
        </div>

        {/* Toolbar */}
        <div style={{ display: 'flex', gap: 4, alignItems: 'center', flex: 'none' }}>
          <button style={toolbarButton} disabled={visibleTab === undefined} onClick={() => { void post('back') }} title={t('panel.back')} aria-label={t('panel.back')}>←</button>
          <button style={toolbarButton} disabled={visibleTab === undefined} onClick={() => { void post('forward') }} title={t('panel.forward')} aria-label={t('panel.forward')}>→</button>
          <button style={toolbarButton} disabled={visibleTab === undefined} onClick={() => { void post('reload') }} title={t('panel.reload')} aria-label={t('panel.reload')}>⟳</button>
          <input
            style={inputStyle}
            value={address}
            onChange={(e) => { addressDirtyRef.current = true; setAddress(e.target.value) }}
            onKeyDown={(e) => { if (e.key === 'Enter') { addressDirtyRef.current = false; openAddress() } }}
            placeholder={t('panel.addressPlaceholder')}
            aria-label={t('panel.addressPlaceholder')}
          />
          <button style={toolbarButton} onClick={openAddress} aria-label={t('panel.go')}>{t('panel.go')}</button>
          <button
            style={{
              ...toolbarButton,
              background: state.controlled ? 'var(--dsw-alias-state-error-primary)' : undefined,
              color: state.controlled ? 'white' : undefined,
            }}
            onClick={() => { void post('takeover', { active: !state.controlled }) }}
            title={t('panel.takeoverTitle')}
            aria-label={t('panel.takeoverTitle')}
          >
            {state.controlled ? t('panel.release') : t('panel.takeover')}
          </button>
          <button
            style={toolbarButton}
            onClick={() => { void post('clear-data').then(() => { void post('close-all') }) }}
            title={t('panel.clearTitle')}
            aria-label={t('panel.clearTitle')}
          >
            {t('panel.clear')}
          </button>
        </div>

        {state.controlled && (
          <div style={{ fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' }}>{t('panel.controlledNotice')}</div>
        )}
        {error !== null && <div style={{ fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' }}>{error}</div>}

        {/* Native view placeholder — the host layers the WebContentsView here. */}
        <div ref={viewRef} style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden' }} />

        {/* Op log */}
        <div style={{ fontSize: 11, opacity: 0.7, maxHeight: 90, overflowY: 'auto', fontFamily: 'monospace', flex: 'none' }}>
          {ops.map((op) => (
            <div key={op.seq} style={{ color: op.failed ? 'var(--dsw-alias-state-error-primary)' : undefined }}>
              {new Date(op.time).toLocaleTimeString()} [{op.tool}] {op.summary}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
