import { useEffect, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { t } from './locales.ts'

interface AuthState {
  loggedIn: boolean
  username?: string
  serverURL?: string
  // 0057: 账号来源与可改密标志(服务端 login 响应透传)。
  source?: string
  password_changeable?: boolean
  must_change_password?: boolean
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

const ACTION_BUTTON: React.CSSProperties = {
  marginTop: 8,
  padding: '8px 14px',
  borderRadius: 6,
  border: '1px solid var(--dsw-alias-state-info-primary, #4176E6)',
  background: 'transparent',
  color: 'var(--dsw-alias-state-info-primary, #4176E6)',
  fontSize: 13,
  cursor: 'pointer',
  alignSelf: 'flex-start',
}

const INPUT: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '8px 10px',
  borderRadius: 6,
  border: '1px solid var(--dsw-alias-border-primary, #D0D5DD)',
  background: 'var(--dsw-alias-bg-elevated, #FFFFFF)',
  color: 'var(--dsw-alias-text-primary, #1A1D24)',
  fontSize: 13,
}

const HINT: React.CSSProperties = { fontSize: 12, margin: 0, color: 'var(--dsw-alias-label-caption)' }

const ERROR: React.CSSProperties = { fontSize: 12, margin: 0, color: 'var(--dsw-alias-state-error-primary)' }

/** Unknown-state text while the auth state is still loading (kept short to
 * avoid layout shift when the settings section first mounts). */
const LOADING_LABEL: React.CSSProperties = { fontSize: 13, margin: 0, color: 'var(--dsw-alias-label-caption)' }

/**
 * Account page: the logged-in username and server, with a logout action that
 * revokes the gateway token server-side (via the local API) and returns the
 * main window to the login page.
 * 0057: 本地认证(local)用户新增内联「修改密码」表单; 外部认证(LDAP/OIDC)
 * 用户显示 IdP 管理提示。改密成功后服务端吊销全部令牌 —— 本地会话被清除,
 * 页面刷新回登录页。
 */
export function AccountSection(_props: PropsRuntime<'settings.section'>) {
  const [state, setState] = useState<AuthState | null>(null)
  const [failed, setFailed] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)
  // 0057 改密表单状态
  const [pwOpen, setPwOpen] = useState(false)
  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [pwErr, setPwErr] = useState('')
  const [pwBusy, setPwBusy] = useState(false)

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

  const submitPassword = async (): Promise<void> => {
    if (pwBusy) return
    setPwErr('')
    if (newPassword.length < 10) { setPwErr(t('account.password.errShort')); return }
    if (newPassword !== confirmPassword) { setPwErr(t('account.password.errMismatch')); return }
    if (newPassword === oldPassword) { setPwErr(t('account.password.errSame')); return }
    setPwBusy(true)
    try {
      const res = await fetch('/api/pico/auth/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ old_password: oldPassword, new_password: newPassword }),
      })
      const data = (await res.json().catch(() => null)) as { error?: string } | null
      if (!res.ok) {
        const raw = String(data?.error ?? '')
        const msg = raw.includes('原密码') ? t('account.password.errOld') : raw || t('account.password.errFailed', { error: String(res.status) })
        setPwErr(msg)
        return
      }
      // 服务端已吊销全部令牌(本地会话被清除): 刷新回登录页, 提示用新密码登录。
      location.reload()
    } catch {
      setPwErr(t('account.password.errFailed', { error: 'network' }))
    } finally {
      setPwBusy(false)
    }
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
      {/* 0057 修改密码: 仅本地认证用户; 外部认证由企业 IdP 管理 */}
      {state.password_changeable ? (
        <div>
          <button
            type="button"
            style={pwOpen ? BUTTON_DISABLED : ACTION_BUTTON}
            disabled={pwOpen}
            onClick={() => { setPwOpen(!pwOpen); setPwErr('') }}
          >
            {t('account.password.title')}
          </button>
          {pwOpen && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
              <div>
                <p style={LABEL}>{t('account.password.old')}</p>
                <input style={INPUT} type="password" value={oldPassword} autoComplete="current-password"
                  onChange={(e) => setOldPassword(e.target.value)} />
              </div>
              <div>
                <p style={LABEL}>{t('account.password.new')}</p>
                <input style={INPUT} type="password" value={newPassword} autoComplete="new-password"
                  onChange={(e) => setNewPassword(e.target.value)} />
              </div>
              <div>
                <p style={LABEL}>{t('account.password.confirm')}</p>
                <input style={INPUT} type="password" value={confirmPassword} autoComplete="new-password"
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void submitPassword() }} />
              </div>
              {pwErr && <p style={ERROR}>{pwErr}</p>}
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" style={pwBusy ? BUTTON_DISABLED : ACTION_BUTTON} disabled={pwBusy}
                  onClick={() => void submitPassword()}>
                  {pwBusy ? t('account.password.submitting') : t('account.password.submit')}
                </button>
                <button type="button" style={BUTTON} onClick={() => { setPwOpen(false); setPwErr('') }}>
                  {t('account.password.cancel')}
                </button>
              </div>
              <p style={HINT}>{t('account.password.forceHint')}</p>
            </div>
          )}
        </div>
      ) : (
        state.source === 'external' && (
          <p style={HINT}>{t('account.password.external')}</p>
        )
      )}
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
