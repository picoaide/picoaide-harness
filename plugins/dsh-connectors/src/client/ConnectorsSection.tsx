import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { friendlyConnectorError, t } from './locales.ts'


/**
 * Connectors settings section: registered connectors as a card grid with
 * search + status filter, driving the auth flow (OAuth redirect / device-code
 * / token form) against the loopback HTTP API, mirroring WorkBuddy's
 * connector settings experience.
 */

interface ConnectorEntry {
  id: string
  name: string
  description: string
  icon: string | null
  authMode: string
  examples: string[]
  status: 'disconnected' | 'connecting' | 'connected' | 'unauthorized' | 'error'
  error?: string
  everConnected: boolean
  request?: {
    authorizeUrl?: string
    verificationUrl?: string
    userCode?: string
    message?: string
    fields?: { key: string; label: string; type: string; required?: boolean }[]
  } | null
}

const GRID: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
  gap: 12,
}

const CARD: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: '14px 16px',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 12,
  minWidth: 0,
}

const HEAD: React.CSSProperties = { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }

const TITLE: React.CSSProperties = { fontSize: 15, margin: 0, fontWeight: 600, color: 'var(--dsw-alias-label-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }

const DESC: React.CSSProperties = {
  fontSize: 13,
  margin: 0,
  color: 'var(--dsw-alias-label-secondary)',
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
  minHeight: 36,
}

const STATUS: React.CSSProperties = { fontSize: 12, margin: 0, flex: 'none', paddingTop: 2 }

const BUTTON: React.CSSProperties = {
  padding: '6px 12px',
  borderRadius: 6,
  border: 'none',
  fontSize: 13,
  cursor: 'pointer',
  background: '#2563eb',
  color: '#fff',
}

const INPUT: React.CSSProperties = {
  padding: '6px 10px',
  borderRadius: 6,
  border: '1px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-layer-2)',
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 13,
}

const LABEL: React.CSSProperties = { fontSize: 12, margin: 0, color: 'var(--dsw-alias-label-caption)' }

const TOOLBAR: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }

const FILTER_BUTTON: React.CSSProperties = {
  padding: '5px 10px',
  borderRadius: 6,
  border: '1px solid var(--dsw-alias-border-l2)',
  background: 'transparent',
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: 12,
  cursor: 'pointer',
}

const FILTER_ACTIVE: React.CSSProperties = { ...FILTER_BUTTON, background: 'var(--dsw-alias-bg-layer-3)', color: 'var(--dsw-alias-label-primary)' }

const statusText: Record<string, string> = {
  disconnected: t('status.disconnected'),
  connecting: t('status.connecting'),
  connected: t('status.connected'),
  unauthorized: t('status.unauthorized'),
  error: t('status.error'),
}

// Design-token colors: adapt automatically to the light and dark themes.
const statusColor: Record<string, string> = {
  disconnected: 'var(--dsw-alias-label-caption)',
  connecting: 'var(--dsw-alias-state-warn-primary)',
  connected: 'var(--dsw-alias-state-success-primary)',
  unauthorized: 'var(--dsw-alias-state-warn-primary)',
  error: 'var(--dsw-alias-state-error-primary)',
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? `HTTP ${String(res.status)}`)
  }
  return (await res.json()) as T
}

function ConnectorCard({ entry, onChanged }: { entry: ConnectorEntry; onChanged: () => void }) {
  const [formValues, setFormValues] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'connect' | 'submit' | 'disconnect' | null>(null)
  const openedUrl = useRef<string | null>(null)

  // The authorize URL is produced asynchronously by the flow; open it once
  // when it appears (popup blockers tolerate a click-adjacent open).
  useEffect(() => {
    if (entry.request?.authorizeUrl && openedUrl.current !== entry.request.authorizeUrl) {
      openedUrl.current = entry.request.authorizeUrl
      window.open(entry.request.authorizeUrl, '_blank')
    }
  }, [entry.request?.authorizeUrl])

  const connect = useCallback(async (): Promise<void> => {
    if (busy !== null) return
    setError(null)
    setBusy('connect')
    try {
      await fetchJson<{ ok: boolean }>(
        `/api/pico/connectors/${encodeURIComponent(entry.id)}/connect`,
        { method: 'POST' },
      )
      if (entry.request?.fields && entry.request.fields.length > 0) setFormValues({})
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? friendlyConnectorError(e.message) : String(e))
    } finally {
      setBusy(null)
    }
  }, [busy, entry.id, entry.request?.fields, onChanged])

  const submitForm = useCallback(async (): Promise<void> => {
    if (busy !== null) return
    setError(null)
    setBusy('submit')
    try {
      await fetchJson(`/api/pico/connectors/${encodeURIComponent(entry.id)}/auth-submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: formValues }),
      })
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? friendlyConnectorError(e.message) : String(e))
    } finally {
      setBusy(null)
    }
  }, [busy, entry.id, formValues, onChanged])

  const disconnect = useCallback(async (): Promise<void> => {
    if (busy !== null) return
    setError(null)
    setBusy('disconnect')
    try {
      await fetchJson(`/api/pico/connectors/${encodeURIComponent(entry.id)}/disconnect`, { method: 'POST' })
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? friendlyConnectorError(e.message) : String(e))
    } finally {
      setBusy(null)
    }
  }, [busy, entry.id, onChanged])

  const polling = entry.status === 'connecting' && (entry.request?.authorizeUrl || entry.request?.verificationUrl)
  const needsForm = entry.status === 'connecting' && Boolean(entry.request?.fields?.length)
  const isConnected = entry.status === 'connected'
  const downloading = entry.status === 'connecting' && Boolean(entry.request?.message)

  return (
    <div style={CARD}>
      <div style={HEAD}>
        <p style={TITLE} title={entry.name}>{entry.name}</p>
        <p style={{ ...STATUS, color: statusColor[entry.status] ?? '#c9ccd3' }}>{statusText[entry.status] ?? entry.status}</p>
      </div>
      <p style={DESC}>{entry.description}</p>

      {entry.request?.verificationUrl && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <p style={LABEL}>{t('auth.verificationHint')}</p>
          <a href={entry.request.verificationUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: 'var(--dsw-alias-state-business-primary)', wordBreak: 'break-all' }}>
            {t('auth.authorizeLink')}
          </a>
          {entry.request.userCode && (
            <p style={LABEL}>{t('auth.code', { code: entry.request.userCode })}</p>
          )}
        </div>
      )}

      {entry.request?.authorizeUrl && !entry.request.verificationUrl && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <p style={LABEL}>{t('auth.authorizeOpened')}</p>
          <a href={entry.request.authorizeUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: 'var(--dsw-alias-state-business-primary)', wordBreak: 'break-all' }}>
            {t('auth.authorizeLink')}
          </a>
        </div>
      )}

      {needsForm && entry.request?.fields && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {entry.request.fields.map((field) => (
            <div key={field.key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={LABEL} htmlFor={`${entry.id}-${field.key}`}>{field.label}{field.required ? ' *' : ''}</label>
              <input
                id={`${entry.id}-${field.key}`}
                style={INPUT}
                type={field.type === 'password' ? 'password' : 'text'}
                value={formValues[field.key] ?? ''}
                onChange={(e) => setFormValues((v) => ({ ...v, [field.key]: e.target.value }))}
              />
            </div>
          ))}
          <button type="button" style={BUTTON} disabled={busy === 'submit'} onClick={() => { void submitForm() }}>
            {busy === 'submit' ? t('action.connecting') : t('action.submit')}
          </button>
        </div>
      )}

      {downloading && entry.request?.message && <p style={LABEL}>{entry.request.message}</p>}
      {polling && <p style={LABEL}>{t('auth.waiting')}</p>}
      {entry.error && !isConnected && <p style={{ ...STATUS, color: statusColor.error }}>{friendlyConnectorError(entry.error)}</p>}
      {error && <p style={{ ...STATUS, color: statusColor.error }}>{error}</p>}

      <div style={{ marginTop: 'auto', paddingTop: 4 }}>
        {isConnected ? (
          <button type="button" style={{ ...BUTTON, background: 'var(--dsw-alias-state-error-primary)' }} disabled={busy === 'disconnect'} onClick={() => { void disconnect() }}>
            {busy === 'disconnect' ? t('action.disconnecting') : t('action.disconnect')}
          </button>
        ) : (
          <button type="button" style={BUTTON} disabled={entry.status === 'connecting' || busy === 'connect'} onClick={() => { void connect() }}>
            {entry.status === 'connecting' || busy === 'connect' ? t('action.connecting') : t('action.connect')}
          </button>
        )}
      </div>
    </div>
  )
}

type StatusFilter = 'all' | 'connected' | 'disconnected'

export function ConnectorsList() {
  const [connectors, setConnectors] = useState<ConnectorEntry[] | null>(null)
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')

  const refresh = useCallback((): void => {
    fetchJson<{ connectors: ConnectorEntry[] }>('/api/pico/connectors')
      .then((data) => setConnectors(data.connectors))
      .catch(() => setConnectors([]))
  }, [])

  useEffect(() => {
    refresh()
    const timer = setInterval(() => { void refresh() }, 2000)
    return () => clearInterval(timer)
  }, [refresh])

  const visible = useMemo(() => {
    if (!connectors) return []
    const q = query.trim().toLowerCase()
    return connectors.filter((c) => {
      if (statusFilter === 'connected' && c.status !== 'connected') return false
      if (statusFilter === 'disconnected' && c.status === 'connected') return false
      if (!q) return true
      return c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q)
    })
  }, [connectors, query, statusFilter])

  const connectedCount = useMemo(() => (connectors ?? []).filter((c) => c.status === 'connected').length, [connectors])

  if (connectors === null) return <p style={DESC}>{t('status.connecting')}</p>

  return (
    <div>
      <div style={TOOLBAR}>
        <input
          style={{ ...INPUT, flex: 1, minWidth: 0 }}
          placeholder={t('search.placeholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="button" style={statusFilter === 'all' ? FILTER_ACTIVE : FILTER_BUTTON} onClick={() => setStatusFilter('all')}>{t('filter.all')}</button>
        <button type="button" style={statusFilter === 'connected' ? FILTER_ACTIVE : FILTER_BUTTON} onClick={() => setStatusFilter('connected')}>{t('filter.connected')}</button>
        <button type="button" style={statusFilter === 'disconnected' ? FILTER_ACTIVE : FILTER_BUTTON} onClick={() => setStatusFilter('disconnected')}>{t('filter.disconnected')}</button>
        <span style={{ ...LABEL, flex: 'none' }}>{t('filter.count', { connected: String(connectedCount), total: String(connectors.length) })}</span>
      </div>
      {visible.length === 0 && <p style={DESC}>{t('empty.noMatch')}</p>}
      <div style={GRID}>
        {visible.map((entry) => (
          <ConnectorCard key={entry.id} entry={entry} onChanged={refresh} />
        ))}
      </div>
    </div>
  )
}
