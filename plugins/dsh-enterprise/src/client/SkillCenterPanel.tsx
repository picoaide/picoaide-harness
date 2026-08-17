import { useEffect, useState } from 'react'

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
  padding: '18px 24px',
  borderBottom: '1px solid var(--dsw-alias-border-l2)',
}

const TITLE: React.CSSProperties = { margin: 0, fontSize: 16, lineHeight: 24, fontWeight: 500, color: 'var(--dsw-alias-label-primary)' }

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

const EMPTY: React.CSSProperties = { fontSize: 13, color: 'var(--dsw-alias-label-caption)', textAlign: 'center', padding: 24 }

/**
 * Skill center modal: the gateway's skill store catalog with an archive
 * download action per skill, fetched through the host's local proxy.
 * @param props.onClose - close the modal.
 */
export function SkillCenterPanel({ onClose }: { onClose: () => void }) {
  const [skills, setSkills] = useState<Skill[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    fetch('/api/pico/skills')
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${String(res.status)}`)
        const data = (await res.json()) as { skills?: Skill[] }
        if (!cancelled) setSkills(data.skills ?? [])
      })
      .catch(() => { if (!cancelled) setError('技能列表加载失败') })
    return () => { cancelled = true }
  }, [])

  const download = async (name: string): Promise<void> => {
    try {
      const res = await fetch(`/api/pico/skills/${encodeURIComponent(name)}/archive`)
      if (!res.ok) return
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${name}.tar.gz`
      anchor.click()
      URL.revokeObjectURL(url)
    } catch { /* download failed; stay on the page */ }
  }

  let content: React.ReactNode
  if (error !== '') {
    content = <p style={EMPTY}>{error}</p>
  } else if (skills === null) {
    content = <p style={EMPTY}>加载中…</p>
  } else if (skills.length === 0) {
    content = <p style={EMPTY}>暂无可用技能</p>
  } else {
    content = skills.map(skill => (
      <div key={skill.name} style={CARD}>
        <div style={TITLE_ROW}>
          <p style={NAME}>{skill.name}</p>
          <button type="button" style={BUTTON} onClick={() => { void download(skill.name) }}>
            获取
          </button>
        </div>
        <p style={META}>v{skill.version}{skill.author !== '' ? ` · ${skill.author}` : ''}</p>
        {skill.description !== '' && <p style={DESC}>{skill.description}</p>}
      </div>
    ))
  }

  return (
    <div style={OVERLAY} role="presentation">
      <div style={MASK} aria-hidden="true" onClick={onClose} />
      <div style={PANEL} role="dialog" aria-modal="true" aria-label="技能中心">
        <div style={HEADER}>
          <h2 style={TITLE}>技能中心</h2>
          <button type="button" style={CLOSE} onClick={onClose}>关闭</button>
        </div>
        <div style={BODY}>{content}</div>
      </div>
    </div>
  )
}
