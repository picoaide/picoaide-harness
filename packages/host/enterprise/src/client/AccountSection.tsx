import { useEffect, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { t } from './locales.ts'

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

// Design-token colors: adapt automatically to the light and dark themes.
const LABEL: React.CSSProperties = { fontSize: 13, margin: 0, color: 'var(--dsw-alias-label-caption)' }

const VALUE: React.CSSProperties = { fontSize: 15, margin: 0, fontWeight: 600 }

const BUTTON: React.CSSProperties = {
  marginTop: 8,
  padding: '8px 14px',
  borderRadius: 6,
  border: '1px solid var(--dsw-alias-state-error-primary)',
  background: 'transparent',
  color: 'var(--dsw-alias-state-error-primary)',
  fontSize: 13,
  cursor: 'pointer',
  alignSelf: 'flex-start',
}

const BUTTON_DISABLED: React.CSSProperties = { ...BUTTON, opacity: 0.6, cursor: 'default' }

/** Unknown-state text while the auth state is still loading (kept short to
 * avoid layout shift when the settings section first mounts). */
const LOADING_LABEL: React.CSSProperties = { fontSize: 13, margin: 0, color: 'var(--dsw-alias-label-caption)' }

/**
 * Account page: the logged-in username and server, with a logout action that
 * revokes the gateway token server-side (via the local API) and returns the
 * main window to the login page.
 */
export function AccountSection(_props: PropsRuntime<'settings.section'>) {
  const [state, setState] = useState<AuthState | null>(null)
  const [failed, setFailed] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch('/api/pico/auth/state')
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${String(res.status)}`)
        const data = (await res.json()) as AuthState
        if (!cancelled) setState(data)
      })
      .catch(() => {
        // Distinguish "not logged in" from "could not reach the local API":
        // showing 未登录 for a network hiccup would mislead a logged-in user.
        if (!cancelled) {
          setState({ loggedIn: false })
          setFailed(true)
        }
      })
    return () => { cancelled = true }
  }, [])

  if (state === null) {
    return <p style={LOADING_LABEL}>{t('account.loading')}</p>
  }

  const logout = async (): Promise<void> => {
    if (loggingOut) return
    setLoggingOut(true)
    try {
      await fetch('/api/pico/auth/logout', { method: 'POST' })
    } finally {
      location.reload()
    }
  }

  if (!state.loggedIn) {
    return <p style={LABEL}>{failed ? t('account.stateFailed') : t('account.notLoggedIn')}</p>
  }

  return (
    <div style={ROW}>
      <div>
        <p style={LABEL}>{t('account.current')}</p>
        <p style={VALUE}>{state.username ?? t('account.unknown')}</p>
      </div>
      <div>
        <p style={LABEL}>{t('account.server')}</p>
        <p style={VALUE}>{state.serverURL ?? t('account.unknown')}</p>
      </div>
      <button
        type="button"
        style={loggingOut ? BUTTON_DISABLED : BUTTON}
        disabled={loggingOut}
        onClick={() => { void logout() }}
      >
        {loggingOut ? t('account.loggingOut') : t('account.logout')}
      </button>
    </div>
  )
}
