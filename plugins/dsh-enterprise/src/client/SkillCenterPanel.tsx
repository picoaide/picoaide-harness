import { useEffect, useRef, useState } from 'react'
import { t } from './locales.ts'

interface Skill {
  name: string
  version: string
  description: string
  author: string
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
  gap: 10,
  padding: 24,
}

const CARD: React.CSSProperties = {
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 8,
  padding: '12px 14px',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
}

const TITLE_ROW: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
}

const NAME: React.CSSProperties = { fontSize: 15, fontWeight: 600, margin: 0, color: 'var(--dsw-alias-label-primary)' }

const META: React.CSSProperties = { fontSize: 12, color: 'var(--dsw-alias-label-caption)', margin: 0 }

const DESC: React.CSSProperties = { fontSize: 13, margin: 0, color: 'var(--dsw-alias-label-secondary)' }

const BUTTON: React.CSSProperties = {
  padding: '5px 12px',
  borderRadius: 6,
  border: '1px solid #2563eb',
  background: '#2563eb',
  color: '#fff',
  fontSize: 12,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}

const BUTTON_DISABLED: React.CSSProperties = { ...BUTTON, opacity: 0.6, cursor: 'default' }

const EMPTY: React.CSSProperties = { fontSize: 13, color: 'var(--dsw-alias-label-caption)', textAlign: 'center', padding: 24 }

const BUTTON_SECONDARY: React.CSSProperties = {
  ...BUTTON,
  border: '1px solid var(--dsw-alias-border-l2)',
  background: 'transparent',
  color: 'var(--dsw-alias-label-secondary)',
}

const INSTALLED_CHIP: React.CSSProperties = {
  marginLeft: 8,
  padding: '1px 8px',
  borderRadius: 999,
  fontSize: 11,
  lineHeight: '18px',
  color: 'var(--dsw-alias-state-success-primary)',
  border: '1px solid var(--dsw-alias-state-success-primary)',
  whiteSpace: 'nowrap',
}

const NOTICE: React.CSSProperties = { fontSize: 13, margin: 0, textAlign: 'center', padding: 12 }

/** Per-skill action feedback: which skill is busy and the outcome. */
interface ActionState {
  name: string
  kind: 'installing' | 'uninstalling' | 'done-install' | 'done-uninstall' | 'failed'
  /** Which action failed (for the failure notice copy). */
  failedKind?: 'install' | 'uninstall' | undefined
  error?: string | undefined
}

/**
 * Skill center modal: the gateway's skill store catalog with an install /
 * uninstall action per skill, fetched through the host's local proxy.
 * Installed state comes from the host (`installed` names in the catalog
 * response) and is kept in sync locally after each action.
 * Esc closes the modal; focus moves into the panel on open.
 * @param props.onClose - close the modal.
 */
export function SkillCenterPanel({ onClose }: { onClose: () => void }) {
  const [skills, setSkills] = useState<Skill[] | null>(null)
  const [installed, setInstalled] = useState<ReadonlySet<string>>(new Set())
  const [error, setError] = useState('')
  const [action, setAction] = useState<ActionState | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/pico/skills')
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${String(res.status)}`)
        const data = (await res.json()) as { skills?: Skill[]; installed?: string[] }
        if (!cancelled) {
          setSkills(data.skills ?? [])
          setInstalled(new Set(data.installed ?? []))
        }
      })
      .catch(() => { if (!cancelled) setError(t('skill.loadError')) })
    return () => { cancelled = true }
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

  const install = async (name: string): Promise<void> => {
    if (action !== null && (action.kind === 'installing' || action.kind === 'uninstalling')) return
    setAction({ name, kind: 'installing' })
    try {
      const res = await fetch(`/api/pico/skills/${encodeURIComponent(name)}/install`, { method: 'POST' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error((data as { error?: string }).error ?? `HTTP ${String(res.status)}`)
      }
      setInstalled(prev => new Set(prev).add(name))
      setAction({ name, kind: 'done-install' })
    } catch (cause) {
      setAction({ name, kind: 'failed', failedKind: 'install', error: cause instanceof Error ? cause.message : undefined })
    }
  }

  const uninstall = async (name: string): Promise<void> => {
    if (action !== null && (action.kind === 'installing' || action.kind === 'uninstalling')) return
    setAction({ name, kind: 'uninstalling' })
    try {
      const res = await fetch(`/api/pico/skills/${encodeURIComponent(name)}/uninstall`, { method: 'POST' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error((data as { error?: string }).error ?? `HTTP ${String(res.status)}`)
      }
      setInstalled(prev => {
        const next = new Set(prev)
        next.delete(name)
        return next
      })
      setAction({ name, kind: 'done-uninstall' })
    } catch (cause) {
      setAction({ name, kind: 'failed', failedKind: 'uninstall', error: cause instanceof Error ? cause.message : undefined })
    }
  }

  let content: React.ReactNode
  if (error !== '') {
    content = <p style={EMPTY}>{error}</p>
  } else if (skills === null) {
    content = <p style={EMPTY}>{t('skill.loading')}</p>
  } else if (skills.length === 0) {
    content = <p style={EMPTY}>{t('skill.empty')}</p>
  } else {
    content = skills.map(skill => {
      const busy = action?.name === skill.name && (action.kind === 'installing' || action.kind === 'uninstalling')
      const isInstalled = installed.has(skill.name)
      return (
        <div key={skill.name} style={CARD}>
          <div style={TITLE_ROW}>
            <p style={NAME}>
              {skill.name}
              {isInstalled && <span style={INSTALLED_CHIP}>{t('skill.installedBadge')}</span>}
            </p>
            {isInstalled ? (
              <button
                type="button"
                style={busy ? BUTTON_DISABLED : BUTTON_SECONDARY}
                disabled={busy}
                onClick={() => { void uninstall(skill.name) }}
              >
                {busy && action?.kind === 'uninstalling' ? t('skill.uninstalling') : t('skill.uninstall')}
              </button>
            ) : (
              <button
                type="button"
                style={busy ? BUTTON_DISABLED : BUTTON}
                disabled={busy}
                onClick={() => { void install(skill.name) }}
              >
                {busy ? t('skill.installing') : t('skill.install')}
              </button>
            )}
          </div>
          <p style={META}>v{skill.version}{skill.author !== '' ? ` · ${skill.author}` : ''}</p>
          {skill.description !== '' && <p style={DESC}>{skill.description}</p>}
        </div>
      )
    })
  }

  return (
    <div style={OVERLAY} role="presentation">
      <div style={MASK} aria-hidden="true" onClick={onClose} />
      <div style={PANEL} role="dialog" aria-modal="true" aria-label={t('skill.title')} tabIndex={-1} ref={panelRef}>
        <div style={HEADER}>
          <h2 style={TITLE}>{t('skill.title')}</h2>
          <button type="button" style={CLOSE} onClick={onClose}>{t('skill.close')}</button>
        </div>
        <div style={BODY}>{content}</div>
        {action !== null && action.kind !== 'installing' && action.kind !== 'uninstalling' && (
          <p style={{ ...NOTICE, color: action.kind === 'failed' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-success-primary)' }}>
            {action.kind === 'done-install'
              ? t('skill.installed', { name: action.name })
              : action.kind === 'done-uninstall'
                ? t('skill.uninstalled', { name: action.name })
                : action.failedKind === 'install'
                  ? action.error !== undefined && action.error !== ''
                    ? `${t('skill.failed')}：${action.error}`
                    : t('skill.failed')
                  : action.error !== undefined && action.error !== ''
                    ? `${t('skill.uninstallFailed')}：${action.error}`
                    : t('skill.uninstallFailed')}
          </p>
        )}
      </div>
    </div>
  )
}
