import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { t } from './locales.ts'
import type { UsagePayload } from '../usage-contract.ts'

/** `/api/pico/auth/state` body (enterprise auth-gate). */
interface AuthState {
  loggedIn: boolean
  username?: string
  serverURL?: string
}

/** `/api/pico/account/usage` body (this plugin's host route).
 *  data 的类型来自唯一契约 usage-contract.ts(不再就地重复声明)。 */
interface UsageResponse {
  data: UsagePayload | null
  fetchedAt: number
  state: 'idle' | 'loading' | 'error'
  error: string | null
  /** 审计 2026-09-12 P1-5:令牌失效(路由层 401)。 */
  authExpired?: boolean
}

/** Card container: the sidebar foot area (below the Settings seat). */
const FOOT_AREA_SELECTOR = '[class$="_footArea"]'

/** Client polling cadence; the host refreshes the cache after every agent loop. */
const POLL_MS = 10_000

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
  // UX-1: danger actions are consistently red-encoded (matches the settings
  // account page) — a grey logout looked like a disabled control and left
  // the destructive semantics unclear.
  color: 'var(--dsw-alias-state-error-primary)',
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

/** Guard: value is a finite number (excludes null/undefined/NaN/Infinity). */
function isMoney(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
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
        if (usageRes.status === 401) {
          // 审计 2026-09-12 P1-5:令牌失效 —— 服务端不会再给余额,卡片必须
          // 立刻转"余额不可用",而不是继续显示上一次成功取的金额。
          setUsage({ data: null, fetchedAt: 0, state: 'error', error: 'auth expired', authExpired: true })
        } else if (usageBody !== null) {
          setUsage(usageBody as UsageResponse)
        }
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
  // 审计 2026-09-12 P1-5:旧判据 `state === 'error' && data === null` 要求 data
  // 恰好为 null —— 而失败路径**保留旧快照**(`{...this.snapshot}`),有旧数据
  // 时 data 非空 ⇒ stale 恒 false ⇒ 卡片照常渲染过期余额(令牌失效后
  // 这就是静默错数)。现在 state==='error' 即视为不可信并渲染占位,
  // authExpired(路由层 401,旧数据已被丢弃)再兜一层。
  // 取舍:网络抖动期间也不再显示上一次的金额(改为"余额获取失败"占位),
  // 下一次成功轮询即恢复 —— 余额属于计费口径,宁可短暂留白不可展示错数。
  const stale = usage !== null && (usage.state === 'error' || usage.authExpired === true)

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

  // 余额解析(2026-09-11 收敛:员工唯一可花的钱 = 账户余额)。
  //  /auth/usage 的形状已由 usage-contract.parseUsagePayload 校验过,这里只需
  //  区分"未开通余额账户"(不渲染余额行)与"已开通"。
  //  未开通 = 从未入账 → 网关闸门也不约束他,展示"未开通"而不是 ¥0.00
  //  (否则会出现"显示 0 却能用"的矛盾界面)。
  const admin = data?.is_admin === true
  const activated = data !== null && data.balance_activated === true
  const balanceMoney = activated && isMoney(data!.balance_money) ? data!.balance_money : null
  const monthly = data !== null && isMoney(data.balance_monthly) ? data.balance_monthly : 0

  const metaParts: string[] = []
  if (data !== null) {
    // 审计修复: 字段缺省/非法时跳过,不再进入 formatMoney(undefined)
    if (isMoney(data.monthly_cost)) metaParts.push(`${t('account.usedThisMonth')} ${formatMoney(data.monthly_cost)}`)
    if (isMoney(data.today_cost)) metaParts.push(`${t('account.today')} ${formatMoney(data.today_cost)}`)
  }

  return createPortal(
    <div style={CARD}>
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
      ) : balanceMoney !== null ? (
        <>
          <div style={BALANCE_ROW}>
            <span style={{ ...BALANCE_AMOUNT, color: balanceMoney <= 0 ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-primary)' }}>
              {formatMoney(balanceMoney)}
            </span>
            <span style={BALANCE_CAPTION}>{t('account.balance')}</span>
          </div>
          {balanceMoney <= 0 ? (
            <div style={{ fontSize: 11, color: 'var(--dsw-alias-state-error-primary)' }}>{t('account.lowBalance')}</div>
          ) : monthly > 0 ? (
            <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-secondary)' }}>
              {t('account.monthlyGrant')} {formatMoney(monthly)}
            </div>
          ) : null}
        </>
      ) : (
        <div style={BALANCE_ROW}>
          <span style={{ ...BALANCE_AMOUNT, color: 'var(--dsw-alias-label-secondary)' }}>—</span>
          <span style={BALANCE_CAPTION}>{admin ? t('account.admin') : t('account.notActivated')}</span>
        </div>
      )}
      <div style={META_ROW}>
        <span style={META_TEXT}>
          {metaParts.length > 0 ? metaParts.join(' · ') : ' '}
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
      <div style={DIVIDER} />
      {/* 用户信息行:用户名 + 退出登录 置于卡片底部(刷新按钮之下) */}
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
    </div>,
    anchor,
  )
}
