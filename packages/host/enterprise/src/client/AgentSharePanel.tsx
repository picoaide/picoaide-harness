import { useEffect, useRef, useState } from 'react'
import { t } from './locales.ts'

interface CatalogPreset {
  name: string
  display_name: string
  description: string
  version: string
  author: string
  status: 'pending' | 'approved' | 'rejected' | 'local'
  created_at: string
}

interface Catalog {
  presets?: CatalogPreset[]
  installed?: string[]
  /** Locally authored presets (创造模式 roster) keyed by id; status when uploaded. */
  local?: Record<string, { name: string; displayName?: string; description?: string; status?: 'pending' | 'approved' | 'rejected' }>
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
  width: 800,
  maxWidth: 'calc(100vw - 48px)',
  height: 'min(800px, calc(100vh - 48px))',
  borderRadius: 24,
  overflow: 'hidden',
  background: 'var(--dsw-alias-bg-layer-2)',
  boxShadow: 'var(--dsw-shadow-lv3)',
}

const HEADER: React.CSSProperties = {
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  height: 54,
  boxSizing: 'border-box',
  padding: '14px 18px',
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

const BODY: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
  padding: 24,
}

const SECTION_HEAD: React.CSSProperties = { margin: 0, fontSize: 13, fontWeight: 500, color: 'var(--dsw-alias-label-secondary)' }

const CARD: React.CSSProperties = {
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 10,
  padding: 14,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  background: 'var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-layer-2))',
}

const TITLE_ROW: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 8,
  minWidth: 0,
}

const NAME: React.CSSProperties = { fontSize: 14, fontWeight: 600, margin: 0, color: 'var(--dsw-alias-label-primary)', lineHeight: '20px', minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }

const META: React.CSSProperties = { fontSize: 12, color: 'var(--dsw-alias-label-caption)', margin: 0, lineHeight: '16px' }

const DESC: React.CSSProperties = {
  fontSize: 12,
  lineHeight: '18px',
  margin: 0,
  color: 'var(--dsw-alias-label-secondary)',
  display: '-webkit-box',
  WebkitLineClamp: 3,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
}

const BUTTON: React.CSSProperties = {
  width: '100%',
  height: 30,
  padding: '0 12px',
  borderRadius: 6,
  border: '1px solid transparent',
  background: 'var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #2563eb))',
  color: 'var(--dsw-alias-label-inverted, #fff)',
  fontSize: 12,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}

const BUTTON_DISABLED: React.CSSProperties = { ...BUTTON, opacity: 0.6, cursor: 'default' }

const BUTTON_SECONDARY: React.CSSProperties = {
  ...BUTTON,
  border: '1px solid var(--dsw-alias-border-l2)',
  background: 'transparent',
  color: 'var(--dsw-alias-label-secondary)',
}

const CHIP: React.CSSProperties = {
  flex: 'none',
  padding: '1px 8px',
  borderRadius: 999,
  fontSize: 11,
  lineHeight: '18px',
  color: 'var(--dsw-alias-state-success-primary)',
  border: '1px solid var(--dsw-alias-state-success-primary)',
  whiteSpace: 'nowrap',
}

const CHIP_PENDING: React.CSSProperties = {
  ...CHIP,
  color: 'var(--dsw-alias-state-warn-label)',
  borderColor: 'var(--dsw-alias-state-warn-label)',
}

const CHIP_REJECTED: React.CSSProperties = {
  ...CHIP,
  color: 'var(--dsw-alias-state-error-primary)',
  borderColor: 'var(--dsw-alias-state-error-primary)',
}

const CARD_FOOT: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  marginTop: 'auto',
  paddingTop: 10,
  borderTop: '1px solid var(--dsw-alias-border-l)',
}

const EMPTY: React.CSSProperties = { fontSize: 13, color: 'var(--dsw-alias-label-caption)', textAlign: 'center', padding: 16 }

const NOTICE: React.CSSProperties = { fontSize: 13, margin: 0, textAlign: 'center', padding: 12 }

/** Per-item action feedback: which preset is busy and the outcome. */
interface ActionState {
  name: string
  kind: 'uploading' | 'installing' | 'uninstalling' | 'done-upload' | 'done-install' | 'done-uninstall' | 'failed'
  error?: string | undefined
}

/** Split the catalog into the caller's own rows (any status) and the shared (approved) library. */
export function splitCatalog(presets: readonly CatalogPreset[]): { own: CatalogPreset[]; shared: CatalogPreset[] } {
  return {
    own: presets.filter(p => p.status !== 'approved'),
    shared: presets.filter(p => p.status === 'approved'),
  }
}

/**
 * Shared-agent modal: the gateway's shared preset store (approved presets)
 * plus the user's own local presets (uploadable from 创造模式). Installed
 * state is kept locally and synced after each action.
 * @param props.onClose - close the modal.
 */
export function AgentSharePanel({ onClose }: { onClose: () => void }) {
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [installed, setInstalled] = useState<ReadonlySet<string>>(new Set())
  const [error, setError] = useState('')
  const [action, setAction] = useState<ActionState | null>(null)
  const [loading, setLoading] = useState(true)
  const [confirmName, setConfirmName] = useState<string | null>(null)
  const loadSeqRef = useRef(0)
  const panelRef = useRef<HTMLDivElement | null>(null)

  const load = (): void => {
    const seq = ++loadSeqRef.current
    setLoading(true)
    setError('')
    fetch('/api/pico/agent-presets')
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${String(res.status)}`)
        if (seq !== loadSeqRef.current) return
        const data = (await res.json()) as Catalog
        setCatalog(data)
        setInstalled(new Set(data.installed ?? []))
        setLoading(false)
      })
      .catch(() => {
        if (seq !== loadSeqRef.current) return
        setError(t('agent.loadError'))
        setLoading(false)
      })
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    panelRef.current?.focus()
    return () => { window.removeEventListener('keydown', onKey) }
  }, [onClose])

  const post = async (path: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      const res = await fetch(path, { method: 'POST' })
      if (res.ok) return { ok: true }
      const data = await res.json().catch(() => ({}))
      const err = (data as { error?: string }).error ?? `HTTP ${String(res.status)}`
      return { ok: false, error: err }
    } catch (cause) {
      const err = cause instanceof Error ? cause.message : String(cause)
      return { ok: false, error: err }
    }
  }

  const upload = async (name: string): Promise<void> => {
    if (action !== null && (action.kind === 'uploading' || action.kind === 'installing' || action.kind === 'uninstalling')) return
    setAction({ name, kind: 'uploading' })
    try {
      const res = await fetch('/api/pico/agent-presets/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (res.ok) {
        setAction({ name, kind: 'done-upload' })
      } else {
        const data = await res.json().catch(() => ({}))
        setAction({ name, kind: 'failed', error: (data as { error?: string }).error ?? `HTTP ${String(res.status)}` })
      }
    } catch (cause) {
      setAction({ name, kind: 'failed', error: cause instanceof Error ? cause.message : undefined })
    }
    load()
  }

  const install = async (name: string): Promise<void> => {
    if (action !== null && (action.kind === 'uploading' || action.kind === 'installing' || action.kind === 'uninstalling')) return
    setAction({ name, kind: 'installing' })
    const result = await post(`/api/pico/agent-presets/${encodeURIComponent(name)}/install`)
    if (result.ok) {
      setInstalled(prev => new Set(prev).add(name))
      setAction({ name, kind: 'done-install' })
    } else {
      setAction({ name, kind: 'failed', error: result.error })
    }
    load()
  }

  const uninstall = async (name: string): Promise<void> => {
    if (action !== null && (action.kind === 'uploading' || action.kind === 'installing' || action.kind === 'uninstalling')) return
    const target = confirmName === name ? name : null
    if (target === null) {
      setConfirmName(name)
      return
    }
    setConfirmName(null)
    setAction({ name, kind: 'uninstalling' })
    const result = await post(`/api/pico/agent-presets/${encodeURIComponent(name)}/uninstall`)
    if (result.ok) {
      setInstalled(prev => {
        const next = new Set(prev)
        next.delete(name)
        return next
      })
      setAction({ name, kind: 'done-uninstall' })
    } else {
      setAction({ name, kind: 'failed', error: result.error })
    }
    load()
  }

  const presets = catalog?.presets ?? []
  const { shared } = splitCatalog(presets)
  // Local rows: disk presets keyed by id, each with the gateway upload state
  // (undefined = not uploaded yet; pending/approved/rejected otherwise).
  const localRows = Object.entries(catalog?.local ?? {}).map(([id, row]) => ({ id, ...row }))
  localRows.sort((a, b) => a.id.localeCompare(b.id))
  const busy = action !== null && (action.kind === 'uploading' || action.kind === 'installing' || action.kind === 'uninstalling')

  const renderCard = (p: CatalogPreset, mode: 'own' | 'shared'): React.ReactNode => {
    const isInstalled = installed.has(p.name)
    const title = p.display_name || p.name
    return (
      <div key={p.name} style={CARD}>
        <div style={TITLE_ROW}>
          <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
              <p style={{ ...NAME, ...{ flex: '1 1 auto' } }} title={title}>{title}</p>
              {mode === 'own' && p.status === 'pending' && <span style={CHIP_PENDING}>{t('agent.pending')}</span>}
              {mode === 'own' && p.status === 'rejected' && <span style={CHIP_REJECTED}>{t('agent.rejected')}</span>}
              {isInstalled && <span style={CHIP}>{t('skill.installedBadge')}</span>}
            </div>
            <p style={META}>{t('agent.version', { version: p.version })}{p.author !== '' ? ` · ${t('agent.author', { author: p.author })}` : ''}</p>
          </div>
        </div>
        {p.description !== '' && <p style={DESC}>{p.description}</p>}
        <div style={CARD_FOOT}>
          {mode === 'own' ? (
            p.status === 'rejected'
              ? <button type="button" style={action?.name === p.name && action.kind === 'uploading' ? BUTTON_DISABLED : BUTTON_SECONDARY} disabled={busy} onClick={() => { void upload(p.name) }}>{t('agent.reupload')}</button>
              : p.status === 'approved'
                ? <span style={CHIP}>{t('agent.approved')}</span>
                : p.status === 'pending'
                  ? <span style={CHIP_PENDING}>{t('agent.pending')}</span>
                  : <button type="button" style={action?.name === p.name && action.kind === 'uploading' ? BUTTON_DISABLED : BUTTON} disabled={busy} onClick={() => { void upload(p.name) }}>{t('agent.upload')}</button>
          ) : isInstalled ? (
            confirmName === p.name ? (
              <div style={{ display: 'flex', gap: 8, width: '100%' }}>
                <button
                  type="button"
                  style={{ ...BUTTON, background: 'var(--dsw-alias-state-error-primary)', color: 'var(--dsw-alias-label-inverted, #fff)' }}
                  disabled={busy}
                  onClick={() => { void uninstall(p.name) }}
                >
                  {action?.name === p.name && action.kind === 'uninstalling' ? t('agent.uninstalling') : t('agent.confirmUninstall')}
                </button>
                <button type="button" style={{ ...BUTTON_SECONDARY, flex: 1 }} disabled={busy} onClick={() => { setConfirmName(null) }}>{t('skill.cancel')}</button>
              </div>
            ) : (
              <button type="button" style={action?.name === p.name && action.kind === 'uninstalling' ? BUTTON_DISABLED : BUTTON_SECONDARY} disabled={busy} onClick={() => { void uninstall(p.name) }}>{t('agent.uninstall')}</button>
            )
          ) : (
            <button type="button" style={action?.name === p.name && action.kind === 'installing' ? BUTTON_DISABLED : BUTTON} disabled={busy} onClick={() => { void install(p.name) }}>{t('agent.install')}</button>
          )}
        </div>
      </div>
    )
  }

  let body: React.ReactNode
  if (error !== '') {
    body = (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
        <p style={EMPTY}>{error}</p>
        <button type="button" style={BUTTON_SECONDARY} onClick={() => { load() }}>{t('agent.retry')}</button>
      </div>
    )
  } else if (loading || catalog === null) {
    body = <p style={EMPTY}>{t('agent.loading')}</p>
  } else {
    body = (
      <>
        <div>
          <h3 style={SECTION_HEAD}>{t('agent.localSection')}</h3>
          {localRows.length === 0
            ? <p style={EMPTY}>{t('agent.emptyLocal')}</p>
            : <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{localRows.map(p => renderCard({
              name: p.id,
              display_name: p.displayName ?? '',
              description: p.description ?? '',
              version: '1.0.0',
              author: '',
              status: p.status === undefined ? 'local' : p.status,
              created_at: '',
            }, 'own'))}</div>}
        </div>
        <div>
          <h3 style={SECTION_HEAD}>{t('agent.librarySection')}</h3>
          {shared.length === 0
            ? <p style={EMPTY}>{t('agent.empty')}</p>
            : <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{shared.map(p => renderCard(p, 'shared'))}</div>}
        </div>
      </>
    )
  }

  return (
    <div style={OVERLAY} role="presentation">
      <div style={MASK} aria-hidden="true" onClick={onClose} />
      <div style={PANEL} role="dialog" aria-modal="true" aria-label={t('agent.title')} tabIndex={-1} ref={panelRef}>
        <div style={HEADER}>
          <h2 style={TITLE}>{t('agent.title')}</h2>
          <button type="button" style={CLOSE} onClick={onClose}>{t('agent.close')}</button>
        </div>
        <div style={BODY}>{body}</div>
        {action !== null && (action.kind === 'done-upload' || action.kind === 'done-install' || action.kind === 'done-uninstall') && (
          <p style={{ ...NOTICE, color: 'var(--dsw-alias-state-success-primary)' }}>
            {action.kind === 'done-upload' ? t('agent.uploaded', { name: action.name })
              : action.kind === 'done-install' ? t('agent.installDone', { name: action.name })
                : t('agent.uninstalled', { name: action.name })}
          </p>
        )}
        {action !== null && action.kind === 'failed' && (
          <p style={{ ...NOTICE, color: 'var(--dsw-alias-state-error-primary)' }}>
            {action.error !== undefined ? t('agent.installFail', { error: action.error }) : t('agent.installFail', { error: '' })}
          </p>
        )}
      </div>
    </div>
  )
}
