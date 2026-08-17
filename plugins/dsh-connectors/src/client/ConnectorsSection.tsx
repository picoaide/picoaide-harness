import { useCallback, useEffect, useRef, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

/**
 * Connectors settings section: list registered connectors with their
 * connection state, and drive the auth flow (OAuth redirect / device-code /
 * token form) against the loopback HTTP API, mirroring WorkBuddy's
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
    fields?: { key: string; label: string; type: string; required?: boolean }[]
  } | null
}

const ROW: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
}

const CARD: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: '12px 14px',
  border: '1px solid #333',
  borderRadius: 8,
}

const HEAD: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }

const TITLE: React.CSSProperties = { fontSize: 15, margin: 0, fontWeight: 600 }

const DESC: React.CSSProperties = { fontSize: 13, margin: 0, color: '#c9ccd3' }

const STATUS: React.CSSProperties = { fontSize: 12, margin: 0 }

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
  border: '1px solid #444',
  background: '#1a1d24',
  color: '#e6e6e6',
  fontSize: 13,
}

const LABEL: React.CSSProperties = { fontSize: 12, margin: 0, color: '#c9ccd3' }

const statusText: Record<string, string> = {
  disconnected: '未连接',
  connecting: '连接中…',
  connected: '已连接',
  unauthorized: '需要授权',
  error: '连接失败',
}

const statusColor: Record<string, string> = {
  disconnected: '#c9ccd3',
  connecting: '#eab308',
  connected: '#22c55e',
  unauthorized: '#f59e0b',
  error: '#f87171',
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
    setError(null)
    try {
      await fetchJson<{ ok: boolean }>(
        `/api/pico/connectors/${encodeURIComponent(entry.id)}/connect`,
        { method: 'POST' },
      )
      if (entry.request?.fields && entry.request.fields.length > 0) setFormValues({})
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [entry.id, onChanged])

  const submitForm = useCallback(async (): Promise<void> => {
    setError(null)
    try {
      await fetchJson(`/api/pico/connectors/${encodeURIComponent(entry.id)}/auth-submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: formValues }),
      })
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [entry.id, formValues, onChanged])

  const disconnect = useCallback(async (): Promise<void> => {
    setError(null)
    try {
      await fetchJson(`/api/pico/connectors/${encodeURIComponent(entry.id)}/disconnect`, { method: 'POST' })
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [entry.id, onChanged])

  const polling = entry.status === 'connecting' && (entry.request?.authorizeUrl || entry.request?.verificationUrl)
  const needsForm = entry.status === 'connecting' && Boolean(entry.request?.fields?.length)
  const isConnected = entry.status === 'connected'

  return (
    <div style={CARD}>
      <div style={HEAD}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
          <p style={TITLE}>{entry.name}</p>
          <p style={DESC}>{entry.description}</p>
        </div>
        <p style={{ ...STATUS, color: statusColor[entry.status] ?? '#c9ccd3' }}>{statusText[entry.status] ?? entry.status}</p>
      </div>

      {entry.request?.verificationUrl && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <p style={LABEL}>请在浏览器中打开以下地址并登录授权：</p>
          <a href={entry.request.verificationUrl} target="_blank" rel="noreferrer" style={{ fontSize: 13, color: '#60a5fa', wordBreak: 'break-all' }}>
            {entry.request.verificationUrl}
          </a>
          {entry.request.userCode && (
            <p style={LABEL}>授权码：{entry.request.userCode}</p>
          )}
        </div>
      )}

      {entry.request?.authorizeUrl && !entry.request.verificationUrl && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <p style={LABEL}>授权页已在浏览器中打开；若未弹出请点击：</p>
          <a href={entry.request.authorizeUrl} target="_blank" rel="noreferrer" style={{ fontSize: 13, color: '#60a5fa', wordBreak: 'break-all' }}>
            {entry.request.authorizeUrl}
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
          <button type="button" style={BUTTON} onClick={() => { void submitForm() }}>提交</button>
        </div>
      )}

      {polling && <p style={LABEL}>等待授权完成…</p>}
      {entry.error && !isConnected && <p style={{ ...STATUS, color: statusColor.error }}>{entry.error}</p>}
      {error && <p style={{ ...STATUS, color: statusColor.error }}>{error}</p>}

      <div>
        {isConnected ? (
          <button type="button" style={{ ...BUTTON, background: '#dc2626' }} onClick={() => { void disconnect() }}>断开</button>
        ) : (
          <button type="button" style={BUTTON} disabled={entry.status === 'connecting'} onClick={() => { void connect() }}>
            {entry.status === 'connecting' ? '连接中…' : '连接'}
          </button>
        )}
      </div>
    </div>
  )
}

export function ConnectorsSection(_props: PropsRuntime<'settings.section'>) {
  const [connectors, setConnectors] = useState<ConnectorEntry[] | null>(null)

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

  if (connectors === null) return null

  return (
    <div style={ROW}>
      {connectors.length === 0 && <p style={DESC}>暂无连接器</p>}
      {connectors.map((entry) => (
        <ConnectorCard key={entry.id} entry={entry} onChanged={refresh} />
      ))}
    </div>
  )
}
