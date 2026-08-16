import { useEffect, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

interface AuthState {
  loggedIn: boolean
  username?: string
  serverURL?: string
}

const ROW: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
}

const LABEL: React.CSSProperties = { fontSize: 13, margin: 0, color: '#c9ccd3' }

const VALUE: React.CSSProperties = { fontSize: 15, margin: 0, fontWeight: 600 }

const BUTTON: React.CSSProperties = {
  marginTop: 8,
  padding: '8px 14px',
  borderRadius: 6,
  border: '1px solid #dc2626',
  background: 'transparent',
  color: '#f87171',
  fontSize: 13,
  cursor: 'pointer',
  alignSelf: 'flex-start',
}

/**
 * Account page: the logged-in username and server, with a logout action that
 * returns the main window to the login page.
 */
export function AccountSection(_props: PropsRuntime<'settings.section'>) {
  const [state, setState] = useState<AuthState | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/pico/auth/state')
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${String(res.status)}`)
        const data = (await res.json()) as AuthState
        if (!cancelled) setState(data)
      })
      .catch(() => { if (!cancelled) setState({ loggedIn: false }) })
    return () => { cancelled = true }
  }, [])

  if (state === null) return null

  const logout = async (): Promise<void> => {
    try {
      await fetch('/api/pico/auth/logout', { method: 'POST' })
    } finally {
      location.reload()
    }
  }

  if (!state.loggedIn) {
    return <p style={LABEL}>未登录</p>
  }

  return (
    <div style={ROW}>
      <div>
        <p style={LABEL}>当前账号</p>
        <p style={VALUE}>{state.username ?? '未知'}</p>
      </div>
      <div>
        <p style={LABEL}>服务端地址</p>
        <p style={VALUE}>{state.serverURL ?? '未知'}</p>
      </div>
      <button type="button" style={BUTTON} onClick={() => { void logout() }}>
        退出登录
      </button>
    </div>
  )
}
