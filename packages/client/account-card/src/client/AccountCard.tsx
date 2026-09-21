import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { t } from './locales.ts'
import { formatMoney } from './money.ts'
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

/** Row container: the sidebar foot area (below the Settings seat). */
const FOOT_AREA_SELECTOR = '[class$="_footArea"]'

/** Client polling cadence; the host refreshes the cache after every agent loop. */
const POLL_MS = 10_000

/** Popover: gap to the row, width floor, viewport margin, stacking order (spec §6). */
const POPOVER_GAP = 6
const POPOVER_MIN_WIDTH = 200
const POPOVER_VIEWPORT_MARGIN = 8
const POPOVER_Z_INDEX = 1100

/** 警示态配色：与侧边栏其余警示圆点一致（浏览器「AI 在等你」同色）。 */
const ATTENTION_COLOR = '#d97706'

// ---- design tokens (official DSH alias set; adapts to light/dark) ----

const CARD: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: '10px 12px',
  borderRadius: 10,
  background: 'var(--dsw-alias-bg-layer-1)',
  border: '1px solid var(--dsw-alias-border-l1)',
  // The card floats above the sidebar now, so it needs the elevated shadow
  // (the in-flow card sat on the sidebar fill and had none).
  boxShadow: 'var(--dsw-shadow-lv3)',
}

const HEAD: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
}

const USER: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  minWidth: 0,
}

const AVATAR: CSSProperties = {
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

const USERNAME: CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--dsw-alias-label-primary)',
}

const LOGOUT: CSSProperties = {
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

const LOGOUT_HOVER: CSSProperties = {
  color: 'var(--dsw-alias-state-error-primary)',
  background: 'var(--dsw-alias-interactive-bg-hover-danger)',
}

const DIVIDER: CSSProperties = {
  height: 1,
  background: 'var(--dsw-alias-border-l1)',
}

const BALANCE_ROW: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 6,
}

const BALANCE_AMOUNT: CSSProperties = {
  fontSize: 18,
  fontWeight: 700,
  fontVariantNumeric: 'tabular-nums',
  color: 'var(--dsw-alias-label-primary)',
}

const BALANCE_CAPTION: CSSProperties = {
  fontSize: 12,
  color: 'var(--dsw-alias-label-caption)',
}


const META_ROW: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
}

const META_TEXT: CSSProperties = {
  fontSize: 11,
  color: 'var(--dsw-alias-label-caption)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const REFRESH: CSSProperties = {
  flex: 'none',
  border: 'none',
  background: 'transparent',
  padding: '2px 6px',
  borderRadius: 5,
  fontSize: 11,
  cursor: 'pointer',
  color: 'var(--dsw-alias-label-secondary)',
}

/**
 * 收起态的行几何：与侧边栏底部其余行（「更多」/ 各面板触发行）逐字一致 ——
 * 34px 行高 + 同款负外边距（抵掉侧栏 12px 内边距，两端对齐）。
 *
 * 底色**故意不在这里**：行内联样式优先级高于样式表，写 `background` 会把注入的
 * `.pico-account-row:hover` 顶掉（hover 变成死规则）。基准底与 hover 一起由
 * `index.ts` 注入的样式表给（窄轨例外：它要保留着色头像底，见 ROW_RAIL）。
 */
const ROW: CSSProperties = {
  position: 'relative',
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  width: 'calc(100% + 8px)',
  height: 34,
  margin: '4px -4px 4px',
  padding: '6px 2px 6px 10px',
  boxSizing: 'border-box',
  border: 'none',
  borderRadius: 12,
  cursor: 'pointer',
  overflow: 'hidden',
  color: 'var(--dsw-alias-label-primary)',
  fontFamily: 'inherit',
  fontSize: 13,
  lineHeight: '22px',
  textAlign: 'left',
}

/** 窄轨（56px rail）：几何与今天的头像圆按钮一致，只是换成行样式 + 圆角。 */
const ROW_RAIL: CSSProperties = {
  ...ROW,
  width: 32,
  height: 32,
  margin: '4px auto 8px',
  padding: 0,
  gap: 0,
  justifyContent: 'center',
  borderRadius: '50%',
  // 窄轨没有用户名，头像圆点本身就是入口 —— 保留原来的着色底，不能变成
  // 透明底的一个字母。
  fontSize: 12,
  fontWeight: 600,
  background: 'var(--dsw-alias-interactive-bg-hover-accent)',
}

const ROW_AVATAR: CSSProperties = {
  ...AVATAR,
  width: 22,
  height: 22,
  fontSize: 11,
}

const ROW_USERNAME: CSSProperties = {
  flex: '0 1 auto',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontWeight: 600,
}

const ROW_SEPARATOR: CSSProperties = {
  flex: 'none',
  color: 'var(--dsw-alias-label-caption)',
}

const ROW_BALANCE: CSSProperties = {
  flex: 'none',
  fontVariantNumeric: 'tabular-nums',
}

const ROW_CHEVRON: CSSProperties = {
  flex: 'none',
  display: 'inline-flex',
  color: 'var(--dsw-alias-label-secondary)',
}

const ATTENTION_DOT: CSSProperties = {
  position: 'absolute',
  top: 4,
  right: 4,
  width: 7,
  height: 7,
  borderRadius: '50%',
  background: ATTENTION_COLOR,
  pointerEvents: 'none',
}

/** Initials: first character of the username, uppercased. */
function initial(username: string | undefined): string {
  return (username ?? '?').slice(0, 1).toUpperCase()
}

/** Guard: value is a finite number (excludes null/undefined/NaN/Infinity). */
function isMoney(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/** 尾部 chevron：收起朝下，展开朝上（与「更多」行同一条规则）。 */
function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      style={open ? { transform: 'rotate(180deg)' } : undefined}
    >
      <path
        d="M4 6.5 8 10.5 12 6.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/**
 * 向上浮层的定位：`position:fixed`，行上方 6px，宽度下限 200，并夹在视口内
 * （窄轨 56px 下浮层会比行宽得多，必须靠定位而不是父容器裁切）。
 *
 * 打开时、窗口 resize、以及锚点元素本身变化时重算。锚点必须按**元素**而不是
 * 稳定 ref 传进来：宽栏渲染的是裸行、窄轨渲染的是 `<Tooltip>` 包着的行，两边的
 * React 元素类型不同 ⇒ 收起/展开侧栏时 React 会换掉 DOM 节点，只依赖 ref 会让
 * 观测器盯着一个已脱离文档的旧节点、浮层留在旧几何上（2026-09-21 审计 P2）。
 * 行在底部固定区，会话列表滚动不影响它。
 * @param anchor - 行按钮元素（宽窄栏都是它），未挂载时为 null。
 * @param open - 浮层是否可见；关闭时不监听。
 * @returns 浮层的内联定位样式，或未测量出时的 null。
 */
function useUpwardPopover(anchor: HTMLElement | null, open: boolean): CSSProperties | null {
  const [placement, setPlacement] = useState<CSSProperties | null>(null)
  useLayoutEffect(() => {
    if (!open || anchor === null) {
      setPlacement(null)
      return
    }
    const measure = (): void => {
      const rect = anchor.getBoundingClientRect()
      const viewportWidth = window.innerWidth
      const width = Math.min(
        Math.max(rect.width, POPOVER_MIN_WIDTH),
        Math.max(POPOVER_MIN_WIDTH, viewportWidth - POPOVER_VIEWPORT_MARGIN * 2),
      )
      // Space above the row; only clamp when the row was actually measured
      // (jsdom reports a zero rect, and a zero max-height would hide the card).
      const spaceAbove = rect.top - POPOVER_GAP - POPOVER_VIEWPORT_MARGIN
      setPlacement({
        position: 'fixed',
        left: Math.min(
          Math.max(rect.left, POPOVER_VIEWPORT_MARGIN),
          Math.max(POPOVER_VIEWPORT_MARGIN, viewportWidth - width - POPOVER_VIEWPORT_MARGIN),
        ),
        bottom: Math.max(POPOVER_VIEWPORT_MARGIN, window.innerHeight - rect.top + POPOVER_GAP),
        width,
        zIndex: POPOVER_Z_INDEX,
        boxSizing: 'border-box',
        ...(spaceAbove > 0 ? { maxHeight: spaceAbove, overflowY: 'auto' } : null),
      })
    }
    measure()
    window.addEventListener('resize', measure)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(anchor)
    return () => {
      window.removeEventListener('resize', measure)
      observer?.disconnect()
    }
  }, [anchor, open])
  return placement
}

/**
 * 一个元素同时要"同步判据"和"副作用依赖"时的标准写法：可变 ref 给事件回调
 * 里的即时判断（外部点击要立刻拿到当前节点），state 给 effect 依赖（节点换了
 * 要重算/重建监听）。回调 ref 每次挂载/卸载都会被 React 调用，因此换节点
 * （宽栏 ↔ 窄轨）时 state 一定跟着变。
 * @returns `[ref, 回调 ref, 当前元素]`。
 */
function useElementRef<T extends HTMLElement>(): [RefObject<T | null>, (element: T | null) => void, T | null] {
  const ref = useRef<T | null>(null)
  const [element, setElement] = useState<T | null>(null)
  const attach = useCallback((next: T | null) => {
    ref.current = next
    setElement(next)
  }, [])
  return [ref, attach, element]
}

/**
 * 外部交互关闭浮层：落在行与浮层之外才算"外部"。
 *
 * 捕获阶段监听 `document`，并且**同时听 `pointerdown` 与 `click`**（与「更多」行
 * 同一套刺激）：真实鼠标/触控的第一跳是 pointerdown，而程序化/键盘激活
 * （`.click()`、`Enter`/`Space` 在按钮上）**只有 click** —— 只听 pointerdown 时，
 * 用户用键盘激活旁边的「更多」行会留下两个同时打开的 body 浮层。
 * 捕获阶段是因为侧栏里任何一层在冒泡阶段 `stopPropagation`，冒泡监听就收不到。
 * @param root - 锚点（行按钮）。
 * @param open - 是否展开；收起时不挂监听。
 * @param setOpen - 关闭时置 false。
 * @param panel - body portal 出来的浮层，算"内部"。
 */
function useOutsidePointerDismissal(
  root: RefObject<HTMLElement | null>,
  open: boolean,
  setOpen: (open: boolean) => void,
  panel: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (!open) return
    const onOutside = (event: Event): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (root.current?.contains(target) === true) return
      if (panel.current?.contains(target) === true) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', onOutside, true)
    document.addEventListener('click', onOutside, true)
    return () => {
      document.removeEventListener('pointerdown', onOutside, true)
      document.removeEventListener('click', onOutside, true)
    }
  }, [root, open, setOpen, panel])
}

/**
 * Bottom sidebar account row: username + live gateway balance, and the card it
 * expands. Rendered through the `sidebar.footer.action` slot (so it mounts with
 * the sidebar and receives the column state) but portalled into the foot area
 * BELOW the Settings seat — the slot itself sits above Settings, and the
 * sidebar shell declares no below-Settings hole. The foot-area class suffix
 * match mirrors the enterprise BRAND_CSS approach (fragile against upstream
 * CSS-module renames, documented there).
 *
 * 2026-09-21：收缩为一行（34px，几何同「更多」行），原 140px 卡片内容**逐字**
 * 搬进点击后向上弹出的 `role="dialog"` 浮层；数据/轮询/退出/刷新语义不变。
 * @param props - sidebar column state from the foot slot owner.
 */
export function AccountCard({ wide }: PropsRuntime<'sidebar.footer.action'>) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [auth, setAuth] = useState<AuthState | null>(null)
  const [usage, setUsage] = useState<UsageResponse | null>(null)
  const [loggingOut, setLoggingOut] = useState(false)
  const [logoutError, setLogoutError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [open, setOpen] = useState(false)
  // 行/浮层元素同时以 ref（同步判据）与 state（副作用依赖）持有：宽栏 ↔ 窄轨
  // 会换掉 DOM 节点，只靠 ref 的 effect 不会重跑（审计 P2）。
  const [rowRef, attachRow, rowElement] = useElementRef<HTMLButtonElement>()
  const [popoverRef, attachPopover, popoverElement] = useElementRef<HTMLDivElement>()
  // 重入闸用 ref 而不是 state：state 在同一个事件批次里还是旧值，连点两次
  // 会各发一次请求（审计 P2 覆盖缺口 c/d）。
  const refreshingRef = useRef(false)
  const loggingOutRef = useRef(false)

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

  // Outside pointerdown (row and popover both count as inside) closes it.
  useOutsidePointerDismissal(rowRef, open, setOpen, popoverRef)

  // Escape closes it and hands focus back to the row.
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setOpen(false)
      rowRef.current?.focus()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [open])

  const placement = useUpwardPopover(rowElement, open)

  // 打开时把焦点移进浮层：浮层是 body 的最后一个子节点，不搬焦点的话键盘用户
  // 要 tab 穿过整个文档才够得到「刷新 / 退出登录」。焦点落在容器（tabIndex=-1）
  // 而不是第一个控件上 —— 刷新按钮在请求期间是 disabled，聚焦容器永远可行，
  // 也让读屏先读到 `role="dialog"` 的名字。**不加 `aria-modal`**：兄弟「更多」
  // 行的 Esc 守卫会礼让 `[role="dialog"][aria-modal="true"]`，标成模态会让那一行
  // 的 Esc 静默失效。
  useEffect(() => {
    if (open && popoverElement !== null) popoverElement.focus()
  }, [open, popoverElement])

  const logout = async (): Promise<void> => {
    if (loggingOutRef.current) return
    loggingOutRef.current = true
    setLoggingOut(true)
    setLogoutError('')
    try {
      const response = await fetch('/api/pico/auth/logout', { method: 'POST' })
      if (!response.ok) {
        setLogoutError(t('account.logoutFailed', { error: `HTTP ${String(response.status)}` }))
        loggingOutRef.current = false
        setLoggingOut(false)
        return
      }
      location.reload()
    } catch (cause) {
      setLogoutError(t('account.logoutFailed', { error: cause instanceof Error ? cause.message : 'network' }))
      loggingOutRef.current = false
      setLoggingOut(false)
    }
  }

  const refreshNow = async (): Promise<void> => {
    if (refreshingRef.current) return
    refreshingRef.current = true
    setRefreshing(true)
    try {
      const res = await fetch('/api/pico/account/usage?refresh=1')
      if (res.ok) {
        const body = (await res.json()) as UsageResponse
        setUsage(body)
      }
    } finally {
      refreshingRef.current = false
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

  // 余额解析(2026-09-11 收敛:员工唯一可花的钱 = 账户余额)。
  //  /auth/usage 的形状已由 usage-contract.parseUsagePayload 校验过,这里只需
  //  区分"未开通余额账户"(不渲染余额行)与"已开通"。
  //  未开通 = 从未入账 → 网关闸门也不约束他,展示"未开通"而不是 ¥0.00
  //  (否则会出现"显示 0 却能用"的矛盾界面)。
  const admin = data?.is_admin === true
  const activated = data !== null && data.balance_activated === true
  const balanceMoney = activated && isMoney(data!.balance_money) ? data!.balance_money : null
  const monthly = data !== null && isMoney(data.balance_monthly) ? data.balance_monthly : 0
  const low = balanceMoney !== null && balanceMoney <= 0

  const metaParts: string[] = []
  if (data !== null) {
    // 审计修复: 字段缺省/非法时跳过,不再进入 formatMoney(undefined)
    if (isMoney(data.monthly_cost)) metaParts.push(`${t('account.usedThisMonth')} ${formatMoney(data.monthly_cost)}`)
    if (isMoney(data.today_cost)) metaParts.push(`${t('account.today')} ${formatMoney(data.today_cost)}`)
  }

  // 行内余额三态（+ 未开通）与无障碍文案共用同一份判定。
  const rowBalanceText = stale || (data !== null && balanceMoney === null)
    ? '—'
    : data === null
      ? '…'
      : formatMoney(balanceMoney!)
  const rowBalanceColor = low
    ? 'var(--dsw-alias-state-error-primary)'
    : stale || data === null || balanceMoney === null
      ? 'var(--dsw-alias-label-secondary)'
      : 'var(--dsw-alias-label-primary)'
  // 行内只有 `—`/金额，说不清的部分（加载中/取数失败/未开通/余额不足）走
  // title + aria-label，不塞进这一行。
  const balanceStateText = stale
    ? t('account.stale')
    : data === null
      ? t('account.loading')
      : balanceMoney === null
        ? (admin ? t('account.admin') : t('account.notActivated'))
        : formatMoney(balanceMoney)
  const rowLabel = t(low ? 'account.rowLabelLow' : 'account.rowLabel', { username, balance: balanceStateText })
  // 行内已经是金额时不需要 tooltip；`—`（取数失败/未开通）与余额不足才需要文字解释。
  const rowTitle = stale || low || balanceMoney === null ? rowLabel : undefined

  const row = (
    <button
      ref={attachRow}
      type="button"
      className="pico-account-row"
      // 窄轨可观测：Tooltip 在测试里是替身，行本身得能自证处在窄轨形态。
      data-rail={wide ? undefined : 'true'}
      style={wide ? ROW : ROW_RAIL}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={rowLabel}
      title={wide ? rowTitle : undefined}
      onClick={() => { setOpen((current) => !current) }}
    >
      {wide ? (
        <>
          <span style={ROW_AVATAR} aria-hidden="true">{initial(username)}</span>
          <span style={ROW_USERNAME}>{username}</span>
          <span style={ROW_SEPARATOR} aria-hidden="true">·</span>
          <span style={{ ...ROW_BALANCE, color: rowBalanceColor }}>{rowBalanceText}</span>
          <span style={ROW_CHEVRON}><Chevron open={open} /></span>
        </>
      ) : initial(username)}
      {low && <span data-attention="true" style={ATTENTION_DOT} aria-hidden="true" />}
    </button>
  )

  // ---- 向上浮层：内容与改造前的 140px 卡片逐字一致，只是改成按需浮出 ----
  const popover = open && placement !== null
    ? createPortal(
        <div
          ref={attachPopover}
          role="dialog"
          aria-label={t('account.title')}
          tabIndex={-1}
          style={{ ...placement, ...CARD }}
        >
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
                <span style={{ ...BALANCE_AMOUNT, color: low ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-primary)' }}>
                  {formatMoney(balanceMoney)}
                </span>
                <span style={BALANCE_CAPTION}>{t('account.balance')}</span>
              </div>
              {low ? (
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
          {logoutError !== '' && (
            <div style={{ fontSize: 11, color: 'var(--dsw-alias-state-error-primary)' }}>{logoutError}</div>
          )}
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
        document.body,
      )
    : null

  // ---- rail: avatar button + tooltip; the same popover opens beside it ----
  if (!wide) {
    return createPortal(
      <>
        <Tooltip label={username} delayMs={500} disabled={open}>
          {row}
        </Tooltip>
        {popover}
      </>,
      anchor,
    )
  }

  return createPortal(
    <>
      {row}
      {popover}
    </>,
    anchor,
  )
}
