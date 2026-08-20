import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Embedded browser panel: toolbar + tab strip + the native-view placeholder.
 * The native WebContentsView is layered over the placeholder by the host; the
 * panel reports the placeholder bounds so the host lays the view out over it.
 * UI is deliberately minimal — final styling follows the product UI design.
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
  const [error, setError] = useState<string | null>(null)
  const viewRef = useRef<HTMLDivElement | null>(null)

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
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 8, padding: 8, boxSizing: 'border-box' }}>
      {/* Tab strip */}
      <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
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
          >
            {tab.title || tab.url || `Tab ${tab.id}`}
            {tab.loading ? '…' : ''}
            {' '}
            <span
              onClick={(e) => { e.stopPropagation(); void post('close-tab', { tab: tab.id }) }}
              style={{ marginLeft: 4, opacity: 0.6 }}
            >
              ×
            </span>
          </button>
        ))}
        <button style={toolbarButton} onClick={() => { void post('open') }} title="New tab">+</button>
      </div>

      {/* Toolbar */}
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <button style={toolbarButton} disabled={visibleTab === undefined} onClick={() => { void post('back') }} title="Back">←</button>
        <button style={toolbarButton} disabled={visibleTab === undefined} onClick={() => { void post('forward') }} title="Forward">→</button>
        <button style={toolbarButton} disabled={visibleTab === undefined} onClick={() => { void post('reload') }} title="Reload">⟳</button>
        <input
          style={inputStyle}
          value={address}
          onChange={(e) => { setAddress(e.target.value) }}
          onKeyDown={(e) => { if (e.key === 'Enter') openAddress() }}
          placeholder="Enter a URL and press Enter"
        />
        <button style={toolbarButton} onClick={openAddress}>Go</button>
        <button
          style={{
            ...toolbarButton,
            background: state.controlled ? '#e5484d' : undefined,
            color: state.controlled ? 'white' : undefined,
          }}
          onClick={() => { void post('takeover', { active: !state.controlled }) }}
          title="Toggle manual control (blocks agent browser actions)"
        >
          {state.controlled ? '接管中·释放' : '接管'}
        </button>
        <button
          style={toolbarButton}
          onClick={() => { void post('clear-data').then(() => { void post('close-all') }) }}
          title="Clear browsing data and close"
        >
          清除
        </button>
        <button style={toolbarButton} onClick={onClose} title="Close panel">✕</button>
      </div>

      {state.controlled && (
        <div style={{ fontSize: 12, color: '#e5484d' }}>用户接管中：agent 的浏览器操作已暂停</div>
      )}
      {error !== null && <div style={{ fontSize: 12, color: '#e5484d' }}>{error}</div>}

      {/* Native view placeholder — the host layers the WebContentsView here. */}
      <div ref={viewRef} style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden' }} />

      {/* Op log */}
      <div style={{ fontSize: 11, opacity: 0.7, maxHeight: 90, overflowY: 'auto', fontFamily: 'monospace' }}>
        {ops.map((op) => (
          <div key={op.seq} style={{ color: op.failed ? '#e5484d' : undefined }}>
            {new Date(op.time).toLocaleTimeString()} [{op.tool}] {op.summary}
          </div>
        ))}
      </div>
    </div>
  )
}
