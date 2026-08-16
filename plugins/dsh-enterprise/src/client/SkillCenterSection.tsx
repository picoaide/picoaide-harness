import { useEffect, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

interface Skill {
  name: string
  version: string
  description: string
  author: string
}

const CARD: React.CSSProperties = {
  border: '1px solid #333',
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

const NAME: React.CSSProperties = { fontSize: 15, fontWeight: 600, margin: 0 }

const META: React.CSSProperties = { fontSize: 12, color: '#8a8f98', margin: 0 }

const DESC: React.CSSProperties = { fontSize: 13, margin: 0, color: '#c9ccd3' }

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

const EMPTY: React.CSSProperties = { fontSize: 13, color: '#8a8f98', textAlign: 'center', padding: 24 }

/**
 * Skill center page: the gateway's skill store catalog with an archive
 * download action per skill, fetched through the host's local proxy.
 */
export function SkillCenterSection(_props: PropsRuntime<'settings.section'>) {
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

  if (error !== '') {
    return <p style={EMPTY}>{error}</p>
  }
  if (skills === null) {
    return <p style={EMPTY}>加载中…</p>
  }
  if (skills.length === 0) {
    return <p style={EMPTY}>暂无可用技能</p>
  }

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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {skills.map(skill => (
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
      ))}
    </div>
  )
}
