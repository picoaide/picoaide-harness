import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { t } from './locales.ts'

/** `/api/pico/auth/state` body (enterprise auth-gate). */
interface AuthState {
  loggedIn: boolean
  username?: string
  serverURL?: string
}

/** `/api/pico/account/usage` body (this plugin's host route). */
interface UsageResponse {
  data: {
    is_admin: boolean
    quota_tokens: number
    quota_money: number
    monthly_usage: number
    monthly_cost: number
    remaining_tokens: number | null
    remaining_money: number | null
    today_usage: number
    today_cost: number
    dept_budgets: { name: string; budget: number; used: number }[]
  } | null
  fetchedAt: number
  state: 'idle' | 'loading' | 'error'
  error: string | null
}

/** Card container: the sidebar foot area (below the Settings seat). */
const FOOT_AREA_SELECTOR = '[class$="_footArea"]'

/** Client polling cadence; the host refreshes the cache after every agent loop. */
const POLL_MS = 10_000

/** Warn (orange) once the remaining quota drops to 20%; danger (red) at 5%. */
const WARN_RATIO = 0.2
const DANGER_RATIO = 0.05

// ---- design tokens (official DSH alias set; adapts to light/dark) ----

const CARD: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  margin: '4px 10px 10px',
  padding: '10px 12px',
  borderRadius: 10,
  background: 'var(--dsw-alias-bg-layer-1)',
  border: '1px solid var(--dsw-alias-border-l1)',
}

const HEAD: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
}

const USER: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  minWidth: 0,
}

const AVATAR: React.CSSProperties = {
  flex: 'none',
  width: 24,
  height: 24,
  borderRadius: '50%',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--dsw-alias-label-primary)',
  background: 'var(--dsw-alias-interactive-bg-hover-accent)',
  userSelect: 'none',
}

const USERNAME: React.CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--dsw-alias-label-primary)',
}

const LOGOUT: React.CSSProperties = {
  flex: 'none',
  border: 'none',
  background: 'transparent',
  padding: '4px 8px',
  borderRadius: 6,
  fontSize: 12,
  cursor: 'pointer',
  color: 'var(--dsw-alias-label-secondary)',
}

const LOGOUT_HOVER: React.CSSProperties = {
  color: 'var(--dsw-alias-state-error-primary)',
  background: 'var(--dsw-alias-interactive-bg-hover-danger)',
}

const DIVIDER: React.CSSProperties = {
  height: 1,
  background: 'var(--dsw-alias-border-l1)',
}

const BALANCE_ROW: React.CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 6,
}

const BALANCE_AMOUNT: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 700,
  fontVariantNumeric: 'tabular-nums',
  color: 'var(--dsw-alias-label-primary)',
}

const BALANCE_CAPTION: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--dsw-alias-label-caption)',
}

const BAR_TRACK: React.CSSProperties = {
  height: 4,
  borderRadius: 2,
  background: 'var(--dsw-alias-bg-layer-3)',
  overflow: 'hidden',
}

const META_ROW: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
}

const META_TEXT: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--dsw-alias-label-caption)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const REFRESH: React.CSSProperties = {
  flex: 'none',
  border: 'none',
  background: 'transparent',
  padding: '2px 6px',
  borderRadius: 5,
  fontSize: 11,
  cursor: 'pointer',
  color: 'var(--dsw-alias-label-secondary)',
}

const RAIL_BUTTON: React.CSSProperties = {
  width: 32,
  height: 32,
  margin: '4px auto 8px',
  borderRadius: '50%',
  border: 'none',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--dsw-alias-label-primary)',
  background: 'var(--dsw-alias-interactive-bg-hover-accent)',
}

/** Initials: first character of the username, uppercased. */
function initial(username: string | undefined): string {
  return (username ?? '?').slice(0, 1).toUpperCase()
}

/** Format a money amount (`¥1,234.50`). */
function formatMoney(value: number): string {
  return `¥${value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** Format a token count with thousands separators. */
function formatTokens(value: number): string {
  return value.toLocaleString('en-US')
}

/**
 * Bottom sidebar account card: username + logout + live gateway balance.
 * Rendered through the `sidebar.footer.action` slot (so it mounts with the
 * sidebar and receives the column state) but portalled into the foot area
 * BELOW the Settings seat — the slot itself sits above Settings, and the
 * sidebar shell declares no below-Settings hole. The foot-area class suffix
 * match mirrors the enterprise BRAND_CSS approach (fragile against upstream
 * CSS-module renames, documented there).
 * @param props - sidebar column state from the foot slot owner.
 */
export function AccountCard({ wide }: PropsRuntime<'sidebar.footer.action'>) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [auth, setAuth] = useState<AuthState | null>(null)
  const [usage, setUsage] = useState<UsageResponse | null>(null)
  const [loggingOut, setLoggingOut] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  // Locate the sidebar foot area; retry briefly (the sidebar mounts before
  // the first poll, but the client bundle can land mid-mount).
  useEffect(() => {
    let raf = 0
    let attempts = 0
    const find = (): void => {
      const el = document.querySelector<HTMLElement>(FOOT_AREA_SELECTOR)
      if (el !== null) {
        setAnchor(el)
        return
      }
      attempts += 1
      if (attempts < 120) raf = requestAnimationFrame(find)
    }
    find()
    return () => { cancelAnimationFrame(raf) }
  }, [])

  // Poll auth state + cached usage; the host refreshes the usage cache after
  // every completed agent loop, so the card converges within one poll window.
  useEffect(() => {
    let cancelled = false
    const poll = async (): Promise<void> => {
      try {
        const [authRes, usageRes] = await Promise.all([
          fetch('/api/pico/auth/state'),
          fetch('/api/pico/account/usage'),
        ])
        const [authBody, usageBody] = await Promise.all([
          authRes.json(),
          usageRes.json().catch(() => null),
        ])
        if (cancelled) return
        setAuth(authBody as AuthState)
        if (usageBody !== null) setUsage(usageBody as UsageResponse)
      } catch {
        /* keep the last known state on transient failures */
      }
    }
    void poll()
    const timer = window.setInterval(() => { void poll() }, POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  const logout = async (): Promise<void> => {
    if (loggingOut) return
    setLoggingOut(true)
    try {
      await fetch('/api/pico/auth/logout', { method: 'POST' })
    } finally {
      location.reload()
    }
  }

  const refreshNow = async (): Promise<void> => {
    if (refreshing) return
    setRefreshing(true)
    try {
      const res = await fetch('/api/pico/account/usage?refresh=1')
      if (res.ok) {
        const body = (await res.json()) as UsageResponse
        setUsage(body)
      }
    } finally {
      setRefreshing(false)
    }
  }

  // Not logged in (or unknown yet): render nothing — the login page owns that state.
  if (anchor === null || auth === null || !auth.loggedIn) return null

  const username = auth.username ?? '?'
  const data = usage?.data ?? null
  const stale = usage !== null && usage.state === 'error' && data === null

  // ---- rail: single avatar dot with a username tooltip ----
  if (!wide) {
    return createPortal(
      <Tooltip label={username} delayMs={500}>
        <button type="button" style={RAIL_BUTTON} aria-label={username}>
          {initial(username)}
        </button>
      </Tooltip>,
      anchor,
    )
  }

  // ---- wide card: username + logout + balance ----

  // Balance resolution: money quota first, then token quota, then unlimited.
  const remainingMoney = data !== null ? data.remaining_money : null
  const remainingTokens = data !== null ? data.remaining_tokens : null
  const admin = data?.is_admin === true

  let amount: string | null = null
  let quota: number | null = null
  let used: number | null = null
  let unit: string | null = null
  if (remainingMoney !== null) {
    amount = formatMoney(remainingMoney)
    quota = data!.quota_money
    used = data!.monthly_cost
    unit = null
  } else if (remainingTokens !== null) {
    amount = formatTokens(remainingTokens)
    quota = data!.quota_tokens
    used = data!.monthly_usage
    unit = t('account.tokens')
  }

  const ratio = quota !== null && quota > 0 && used !== null ? used / quota : null
  const danger = ratio !== null && 1 - ratio <= DANGER_RATIO
  const warn = ratio !== null && 1 - ratio <= WARN_RATIO
  const fillColor = danger
    ? 'var(--dsw-alias-state-error-primary)'
    : warn
      ? 'var(--dsw-alias-state-warn-primary)'
      : 'var(--dsw-alias-brand-primary)'
  const amountColor = danger
    ? 'var(--dsw-alias-state-error-primary)'
    : warn
      ? 'var(--dsw-alias-state-warn-primary)'
      : 'var(--dsw-alias-label-primary)'

  const metaParts: string[] = []
  if (data !== null) {
    metaParts.push(`${t('account.usedThisMonth')} ${formatMoney(data.monthly_cost)}`)
    metaParts.push(`${t('account.today')} ${formatMoney(data.today_cost)}`)
  }

  return createPortal(
    <div style={CARD}>
      <div style={HEAD}>
        <div style={USER}>
          <span style={AVATAR}>{initial(username)}</span>
          <span style={USERNAME} title={username}>{username}</span>
        </div>
        <button
          type="button"
          style={LOGOUT}
          onMouseEnter={(e) => { Object.assign(e.currentTarget.style, LOGOUT_HOVER) }}
          onMouseLeave={(e) => { Object.assign(e.currentTarget.style, LOGOUT) }}
          disabled={loggingOut}
          onClick={() => { void logout() }}
        >
          {loggingOut ? t('account.loggingOut') : t('account.logout')}
        </button>
      </div>
      <div style={DIVIDER} />
      {stale ? (
        <div style={BALANCE_ROW}>
          <span style={{ ...BALANCE_AMOUNT, color: 'var(--dsw-alias-label-secondary)' }}>—</span>
          <span style={BALANCE_CAPTION}>{t('account.stale')}</span>
        </div>
      ) : data === null ? (
        <div style={BALANCE_ROW}>
          <span style={{ ...BALANCE_AMOUNT, color: 'var(--dsw-alias-label-secondary)' }}>…</span>
          <span style={BALANCE_CAPTION}>{t('account.loading')}</span>
        </div>
      ) : admin || amount === null ? (
        <div style={BALANCE_ROW}>
          <span style={BALANCE_AMOUNT}>{t('account.unlimited')}</span>
          <span style={BALANCE_CAPTION}>{admin ? t('account.admin') : ''}</span>
        </div>
      ) : (
        <>
          <div style={BALANCE_ROW}>
            <span style={{ ...BALANCE_AMOUNT, color: amountColor }}>
              {amount}{unit !== null ? ` ${unit}` : ''}
            </span>
            {quota !== null && quota > 0 && (
              <span style={BALANCE_CAPTION}>{t('account.budget')} {formatMoney(quota)}</span>
            )}
          </div>
          {ratio !== null && (
            <div style={BAR_TRACK} role="progressbar" aria-valuenow={Math.round(ratio * 100)} aria-valuemin={0} aria-valuemax={100}>
              <div style={{ height: '100%', width: `${Math.min(100, ratio * 100)}%`, background: fillColor }} />
            </div>
          )}
          {warn && !danger && (
            <div style={{ fontSize: 11, color: 'var(--dsw-alias-state-warn-primary)' }}>{t('account.lowBalance')}</div>
          )}
          {danger && (
            <div style={{ fontSize: 11, color: 'var(--dsw-alias-state-error-primary)' }}>{t('account.lowBalance')}</div>
          )}
        </>
      )}
      <div style={META_ROW}>
        <span style={META_TEXT}>
          {metaParts.length > 0 ? metaParts.join(' · ') : (stale || data === null ? ' ' : t('account.unlimited'))}
        </span>
        <button
          type="button"
          style={REFRESH}
          disabled={refreshing}
          onClick={() => { void refreshNow() }}
        >
          {refreshing ? '…' : `↻ ${t('account.refresh')}`}
        </button>
      </div>
    </div>,
    anchor,
  )
}
