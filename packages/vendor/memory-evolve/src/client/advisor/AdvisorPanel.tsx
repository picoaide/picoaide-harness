/**
 * 会话评审悬浮面板。
 *
 * AdvisorHost 是唯一 slot 入口：它在会话 header 中渲染开合按钮，并把面板
 * createPortal 到 document.body，从而避开会话子树可能形成的 containing block。
 * AdvisorPanel 只负责五区 UI；数据与副作用全部由 advisor-store.ts 管理。
 *
 * i18n（2026-09-16）：本文件此前**声明了 t 却只在 2 处使用**，其余面板文案
 * 硬编码中文，另有约 18 处状态/严重度/结果标签走手写的 `isEn()`
 * （读 `navigator.language` = 操作系统语言，无视应用内语言设置）。现在：
 *   - 一切文案经 `t`（由 index.ts 在 apply 期绑定，调用期解析语言）；
 *   - 状态/严重度/结果/耗时/相对时间等标签改成 `(t) => string` 的函数，
 *     不再有模块级常量（模块求值早于 apply，会把语言钉死）；
 *   - `t` 继续下传到 ReviewCard / ScopesTab / SettingsDisclosure 等子组件。
 */
import { Component, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { PropsRuntime, Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  levelLabel,
  type AdvisorConfig,
  type AdvisorScopes,
  type AdvisorHistoryFilters,
  type AdvisorNoteSeverity,
  type AdvisorReviewItem,
  type AdvisorRuntimeStatus,
  type AdvisorSeverity,
  type AdvisorSessionStore,
  type AdvisorStoreSnapshot,
  useAdvisorSessionStore,
} from './advisor-store.ts'

export type AdvisorHostProps = PropsRuntime<'conversation.session.header.actions'> & {
  /** index.ts 传入的插件 locale 翻译函数（面板文案全部经它取）。 */
  t: Translate
}

export interface AdvisorPanelProps {
  /** 插件 locale 翻译函数（i18n：面板文案一律经它取）。 */
  t: Translate
  store: AdvisorSessionStore
  snapshot: AdvisorStoreSnapshot
  onCollapse: () => void
}

type PanelTab = 'scopes' | 'live' | 'history' | 'settings'

/**
 * 悬浮胶囊位置持久化键（2026-08-17 issue #11 评论反馈：位置写死不可调）。
 * 2026-08-17 用户拍板：胶囊**只能吸附右边缘**、沿最右边上下移动（不允许
 * 拖到页面中间）——因此只持久化 top（垂直位置），水平方向固定贴右
 * （CSS right: 0），拖动时不做任何水平位移。清除键值/删除 key 即回默认
 * 位置（top 42%）。
 */
const CAPSULE_POS_KEY = 'dsh-memory-evolve:advisor-capsule-pos'

/** 单次指针会话的拖拽状态：记录起点用于区分"点击"与"拖拽"。 */
interface CapsuleDragState {
  pointerId: number
  startX: number
  startY: number
  /** 位移是否已超过阈值（4px）：超过才算拖拽，松手时才会持久化并抑制点击 */
  dragged: boolean
}

/**
 * 运行状态标签（函数式：语言在**调用期**解析，模块级常量会钉死默认语言）。
 * 图标/样式类与语言无关，文案走字典。
 */
const STATUS_META: Record<AdvisorRuntimeStatus, { icon: string; key: string; cls: string }> = {
  disabled: { icon: '✖', key: 'advisor.status.disabled', cls: 'advisor-status-disabled' },
  idle: { icon: '●', key: 'advisor.status.idle', cls: 'advisor-status-idle' },
  reviewing: { icon: '◐', key: 'advisor.status.reviewing', cls: 'advisor-status-reviewing' },
  quota_exhausted: { icon: '⏸', key: 'advisor.status.paused', cls: 'advisor-status-paused' },
  halted: { icon: '⚠', key: 'advisor.status.halted', cls: 'advisor-status-halted' },
}

/** 状态徽标文案（当次渲染语言）。 */
function statusMeta(status: AdvisorRuntimeStatus, t: Translate): { icon: string; label: string; cls: string } {
  const meta = STATUS_META[status]
  return { icon: meta.icon, label: t(meta.key), cls: meta.cls }
}

/** 严重度标签：前半段是稳定标识（info/nit/…），后半段走字典。 */
const SEVERITY_META: Record<AdvisorNoteSeverity, { key: string; cls: string }> = {
  // Q1：info 最低等级（默认仅记录不注入，面板照常展示）
  info: { key: 'advisor.severity.info', cls: 'advisor-severity-info' },
  nit: { key: 'advisor.severity.nit', cls: 'advisor-severity-nit' },
  concern: { key: 'advisor.severity.concern', cls: 'advisor-severity-concern' },
  blocker: { key: 'advisor.severity.blocker', cls: 'advisor-severity-blocker' },
  // Q4：问答回复（用户提问的直接回答，非评审建议）
  answer: { key: 'advisor.severity.answer', cls: 'advisor-severity-answer' },
}

/** 严重度徽标文案（当次渲染语言）。 */
function severityMeta(severity: AdvisorNoteSeverity, t: Translate): { label: string; cls: string } {
  const meta = SEVERITY_META[severity]
  return { label: t(meta.key), cls: meta.cls }
}

/** 终态结果标签的字典键。 */
const OUTCOME_KEYS = {
  delivered: 'advisor.outcome.delivered',
  // Q1：info 级默认仅记录（事件照发、面板可见，会话流不受打扰）
  recorded: 'advisor.outcome.recorded',
  // Q4：问答回答已注入会话流
  answered: 'advisor.outcome.answered',
  suppressed: 'advisor.outcome.suppressed',
  'no-note': 'advisor.outcome.noNote',
  dropped: 'advisor.outcome.dropped',
  failed: 'advisor.outcome.failed',
  cancelled: 'advisor.outcome.cancelled',
} as const

function outcomeLabel(outcome: keyof typeof OUTCOME_KEYS, t: Translate): string {
  return t(OUTCOME_KEYS[outcome])
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

function formatClock(ts: number): string {
  const date = new Date(ts)
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
}

function formatDateTime(ts: number): string {
  const date = new Date(ts)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${formatClock(ts)}`
}

function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1_000) return `${Math.round(ms)}ms`
  return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)}s`
}

function formatAgo(ts: number | null, t: Translate): string {
  if (ts === null) return t('advisor.ago.none')
  const delta = Math.max(0, Date.now() - ts)
  if (delta < 5_000) return t('advisor.ago.justNow')
  if (delta < 60_000) return t('advisor.ago.seconds', { count: Math.floor(delta / 1_000) })
  if (delta < 3_600_000) return t('advisor.ago.minutes', { count: Math.floor(delta / 60_000) })
  return t('advisor.ago.hours', { count: Math.floor(delta / 3_600_000) })
}

function shortSession(sessionId: string): string {
  return sessionId.length > 12 ? `${sessionId.slice(0, 8)}…` : sessionId
}

function timeCutoff(range: AdvisorHistoryFilters['timeRange']): number | null {
  const day = 24 * 60 * 60 * 1_000
  if (range === '24h') return Date.now() - day
  if (range === '7d') return Date.now() - 7 * day
  if (range === '30d') return Date.now() - 30 * day
  return null
}

/**
 * strict-session slot 入口。窄屏初始折叠；桌面初始展开。header 与 body portal
 * 共用同一个 session store，因此双入口开合不会造成第二份轮询。
 */
export function AdvisorHost(props: AdvisorHostProps): JSX.Element {
  const t = props.t
  const sessionId = String(props.sessionId)
  const { store, snapshot } = useAdvisorSessionStore(sessionId, t)
  const [expanded, setExpanded] = useState(() => (
    typeof window === 'undefined' ? false : !window.matchMedia('(max-width: 767px)').matches
  ))
  // 2026-08-13 用户反馈：用户是否手动操作过面板（打开/收起）——未启用
  // 评审的会话刷新后默认不主动显示（面板收起、无悬浮胶囊）；用户手动
  // 点头部 toggle 后视为"点出来"，胶囊恢复显示
  const [userToggled, setUserToggled] = useState(false)
  const preferredExpanded = useRef(true)
  const manuallyExpanded = useRef(false)

  // ---- 悬浮胶囊拖拽（2026-08-17 issue #11 评论反馈；用户拍板吸附右边缘） ----
  // capsuleTop：null = 未拖过（用 CSS 默认 top 42%）；否则存垂直位置 top
  // （水平固定贴右边缘 right: 0，不允许拖到页面中间——用户 2026-08-17 拍板）。
  // capsuleTopRef 同步镜像最新值：pointerup 持久化时 state 可能尚未
  // flush，读 ref 保证拿到最后一次 move 的位置。
  const [capsuleTop, setCapsuleTop] = useState<number | null>(null)
  const capsuleTopRef = useRef<number | null>(null)
  const capsuleDragRef = useRef<CapsuleDragState | null>(null)
  /** 拖拽刚结束的标记：click 事件在 pointerup 之后触发，用它抑制"拖拽完
   *  误触展开面板"（React 的 onClick 无法直接取消，只能检查标记后跳过）。 */
  const capsuleDraggedRef = useRef(false)
  const [capsuleDragging, setCapsuleDragging] = useState(false)
  const capsuleRef = useRef<HTMLButtonElement | null>(null)

  // 初始化：从 localStorage 恢复上次拖拽的垂直位置（数据损坏/不可用则
  // 静默用默认位置）。兼容首版 {x, y} 旧数据：只取 y（x 无意义，水平
  // 固定贴右），新版只存 {top}。
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      const raw = window.localStorage.getItem(CAPSULE_POS_KEY)
      if (raw === null) return
      const parsed = JSON.parse(raw) as { top?: unknown; y?: unknown }
      const top = typeof parsed.top === 'number' && Number.isFinite(parsed.top)
        ? parsed.top
        : (typeof parsed.y === 'number' && Number.isFinite(parsed.y) ? parsed.y : null)
      if (top !== null) {
        capsuleTopRef.current = top
        setCapsuleTop(top)
      }
    } catch {
      // localStorage 不可用或数据损坏：静默回退默认位置
    }
  }, [])

  // 拖拽开始：记录起点并捕获指针（指针移出按钮后 move/up 仍派发到按钮）
  const onCapsulePointerDown = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    // 鼠标只响应左键；触屏/笔第一触点 button 恒为 0，不额外过滤
    if (event.pointerType === 'mouse' && event.button !== 0) return
    capsuleDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      dragged: false,
    }
    try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* 捕获失败不阻塞 */ }
    // 阻止拖拽中触发原生行为（文本选择/图片拖拽等）
    event.preventDefault()
  }

  const onCapsulePointerMove = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const drag = capsuleDragRef.current
    if (drag === null || drag.pointerId !== event.pointerId) return
    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    // 位移未超过 4px 视为纯点击（可能微抖），不移动也不进入拖拽态
    if (!drag.dragged && Math.hypot(dx, dy) < 4) return
    drag.dragged = true
    if (!capsuleDragging) setCapsuleDragging(true)
    const height = event.currentTarget.offsetHeight
    // 吸附右边缘：只取垂直位移（水平一律贴右，right: 0 由 CSS 保证），
    // clamp 到视口内，禁止拖出屏幕上下缘导致拿不回来
    const top = Math.min(Math.max(0, event.clientY - height / 2), window.innerHeight - height)
    capsuleTopRef.current = top
    setCapsuleTop(top)
  }

  // 拖拽结束：释放指针捕获；拖过 → 标记供 click 抑制 + 持久化位置
  const finishCapsuleDrag = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const drag = capsuleDragRef.current
    if (drag === null || drag.pointerId !== event.pointerId) return
    capsuleDragRef.current = null
    setCapsuleDragging(false)
    try { event.currentTarget.releasePointerCapture(event.pointerId) } catch { /* 已释放则忽略 */ }
    if (drag.dragged) {
      capsuleDraggedRef.current = true
      const top = capsuleTopRef.current
      if (top !== null) {
        try { window.localStorage.setItem(CAPSULE_POS_KEY, JSON.stringify({ top })) } catch { /* 存储失败静默 */ }
      }
    }
  }

  // 点击展开面板；拖拽刚结束（pointerup 后触发的 click）直接跳过
  const onCapsuleClick = (): void => {
    if (capsuleDraggedRef.current) {
      capsuleDraggedRef.current = false
      return
    }
    toggle()
  }

  const panelEnabled = snapshot.config?.advisorPanelEnabled
    ?? snapshot.status?.panelEnabled
    ?? true

  // 2026-08-13 用户反馈（两轮迭代）：
  // 1. advisorEnabled 是模块**总闸**——总闸关闭时评审入口整体不渲染；
  //    status 未同步完成时用全局 config 兜底，避免刷新闪一下。
  // 2. 会话级开关只控制本会话是否评审，**不影响入口渲染**——会话级关闭
  //    后入口必须保留（否则用户无法再从面板把本会话开关打开；上一版把
  //    effectiveEnabled 当渲染条件引入了此回归）。
  const globalEnabled = snapshot.status?.defaultEnabled ?? (snapshot.config?.advisorEnabled === true)
  const enabled = snapshot.status?.effectiveEnabled ?? globalEnabled

  // 配置明确关闭面板时，首次加载自动收起；用户从 header 主动打开后仍可进入
  // 设置区恢复开关，避免“关闭后再也打不开”的死路。
  useEffect(() => {
    if (!panelEnabled && !userToggled) setExpanded(false)
  }, [panelEnabled, userToggled])

  // 2026-08-13 用户反馈：**本会话未启用评审时刷新页面不主动显示**——
  // status 同步后若 effectiveEnabled=false 且用户未手动操作过，自动收起
  // 面板（悬浮胶囊同样隐藏，见下方 portal 渲染条件）；用户手动点开后
  // 尊重用户选择，不再自动收起
  useEffect(() => {
    if (!enabled && !userToggled) setExpanded(false)
  }, [enabled, userToggled])

  // 窄屏自动收起仅是临时布局覆盖；返回桌面时恢复用户最后一次明确偏好。
  // 用户当前明确偏好展开时，后续进入窄屏不再强制折叠。
  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-width: 767px)')
    const onMediaChange = (event: MediaQueryListEvent): void => {
      // ME-7（2026-09-17 二审）：userToggled 必须在依赖数组里 —— 监听器只订阅
      // 一次，缺它时读到的永远是订阅那一刻的 false，于是「配置关闭面板 + 用户
      // 手动点开」后一次窗口缩放就把面板收起，与同文件 :294 的承诺矛盾。
      if (!panelEnabled && !userToggled) {
        setExpanded(false)
        return
      }
      if (event.matches) {
        if (!manuallyExpanded.current) setExpanded(false)
        return
      }
      setExpanded(preferredExpanded.current)
    }

    mediaQuery.addEventListener('change', onMediaChange)
    return () => mediaQuery.removeEventListener('change', onMediaChange)
  }, [panelEnabled, userToggled])

  useEffect(() => {
    store.setPanelVisible(expanded)
    return () => store.setPanelVisible(false)
  }, [expanded, store])

  const toggle = (): void => {
    setUserToggled(true)
    setExpanded((value) => {
      const next = !value
      preferredExpanded.current = next
      manuallyExpanded.current = next
      return next
    })
  }

  // 2026-08-12 用户反馈：悬浮按钮图标颜色反映评审状态——
  // disabled（灰）/ idle（绿）/ reviewing（蓝呼吸）/ quota·halted（橙红）
  const runtimeStatus = snapshot.status?.runtimeStatus ?? 'disabled'
  const capsuleStateClass = !enabled ? 'advisor-capsule-disabled'
    : runtimeStatus === 'reviewing' ? 'advisor-capsule-reviewing'
    : runtimeStatus === 'quota_exhausted' || runtimeStatus === 'halted' ? 'advisor-capsule-error'
    : 'advisor-capsule-idle'

  const headerTitle = panelEnabled
    ? t('advisor.header.toggle.title')
    : t('advisor.header.toggle.titleOff')

  // 2026-08-13 用户反馈：设置 Tab 的「会话评审（Advisor）」是模块总闸——
  // **总闸关闭**时评审入口（头部按钮、悬浮胶囊、面板）整体不渲染，模块
  // 在界面上彻底消失；开启总闸后恢复。会话级关闭（override=false）只停
  // 本会话评审，入口照常保留（面板里可重新打开本会话开关）。
  // ⚠️ React 规则：本 early-return 位于所有 hooks 之后，不影响 hooks 顺序。
  if (!globalEnabled) return null

  const portal = typeof document === 'undefined' ? null : createPortal(
    expanded ? (
      <AdvisorPanel t={t} store={store} snapshot={snapshot} onCollapse={toggle} />
    ) : panelEnabled ? (
      // 2026-08-14 用户反馈：「显示悬浮胶囊」开关开启时，胶囊应常驻显示
      // （作为打开面板的入口 + 评审状态指示灯），不再因「本会话未启用评审」
      // 或「刷新后 userToggled 归零」而消失。评审状态由胶囊颜色表达
      // （capsuleStateClass：灰=停用/绿=空闲/蓝呼吸=评审中/橙红=异常），
      // 而非用「显不显示」表达。
      <button
        type="button"
        ref={capsuleRef}
        className={`advisor-capsule ${capsuleStateClass}${capsuleDragging ? ' advisor-capsule-dragging' : ''}`}
        style={capsuleTop !== null ? { top: capsuleTop } : undefined}
        onClick={onCapsuleClick}
        onPointerDown={onCapsulePointerDown}
        onPointerMove={onCapsulePointerMove}
        onPointerUp={finishCapsuleDrag}
        onPointerCancel={finishCapsuleDrag}
        aria-label={t('advisor.capsule.aria')}
        title={t('advisor.capsule.title')}
      >
        <span className="advisor-capsule-icon" aria-hidden="true">◉</span>
        <span className="advisor-capsule-label">Advisor</span>
        {snapshot.unreadCount > 0 && (
          <span className="advisor-unread" aria-label={t('advisor.unread.aria', { count: snapshot.unreadCount })}>
            {snapshot.unreadCount > 99 ? '99+' : snapshot.unreadCount}
          </span>
        )}
      </button>
    ) : null,
    document.body,
  )

  return (
    <>
      <button
        type="button"
        className={`advisor-header-toggle${expanded ? ' advisor-header-toggle-active' : ''} ${capsuleStateClass}`}
        onClick={toggle}
        aria-expanded={expanded}
        aria-label={headerTitle}
        title={headerTitle}
      >
        <span aria-hidden="true">◉</span>
        <span>{t('advisor.header.toggle')}</span>
        {snapshot.unreadCount > 0 && (
          <span className="advisor-header-unread" aria-hidden="true">
            {snapshot.unreadCount > 99 ? '99+' : snapshot.unreadCount}
          </span>
        )}
      </button>
      {portal}
    </>
  )
}

/** 面板本体：Header、状态条、实时/历史主区、指令区、设置 disclosure。 */
export function AdvisorPanel({ t, store, snapshot, onCollapse }: AdvisorPanelProps): JSX.Element {
  const [tab, setTab] = useState<PanelTab>('live')
  const [instruction, setInstruction] = useState('')
  const [pendingOpen, setPendingOpen] = useState(true)
  const [filters, setFilters] = useState<AdvisorHistoryFilters>(snapshot.recordsFilters)
  const [following, setFollowing] = useState(true)
  const flowRef = useRef<HTMLDivElement | null>(null)

  // 第一次进入历史 Tab 时加载；后续返回保留筛选和翻页结果。
  useEffect(() => {
    if (tab === 'history' && snapshot.records.length === 0 && !snapshot.recordsLoading) {
      void store.loadRecords(filters)
    }
  }, [tab])

  // 新卡片或 started→finished 补全后，只有在用户未上滚时才自动跟随到底部。
  useEffect(() => {
    if (tab !== 'live' || !following) return
    const node = flowRef.current
    if (node !== null) node.scrollTop = node.scrollHeight
  }, [snapshot.reviews, tab, following])

  const onFlowScroll = (): void => {
    const node = flowRef.current
    if (node === null) return
    setFollowing(node.scrollHeight - node.scrollTop - node.clientHeight < 28)
  }

  const identity = useMemo(() => {
    for (let i = snapshot.reviews.length - 1; i >= 0; i -= 1) {
      const item = snapshot.reviews[i]
      if (item.started !== null) {
        return { sessionName: item.started.sessionName, workspace: item.started.workspace }
      }
      if (item.record !== null) {
        return { sessionName: item.record.sessionName, workspace: item.record.workspace }
      }
    }
    return { sessionName: null, workspace: null }
  }, [snapshot.reviews])

  // Q3 重构：最近的评审员会话代数与上下文条数（取自最新 started 的输入快照）
  const latestEpoch = useMemo(() => {
    for (let i = snapshot.reviews.length - 1; i >= 0; i -= 1) {
      const epoch = snapshot.reviews[i].started?.input?.epoch
      if (epoch !== undefined) return epoch
    }
    return null
  }, [snapshot.reviews])
  const latestContextCount = useMemo(() => {
    // 2026-08-12 用户反馈：优先 status 实时统计（含评审员自己的输出/指令）
    if (snapshot.status?.conversationStats !== null && snapshot.status?.conversationStats !== undefined) {
      return snapshot.status.conversationStats.messageCount
    }
    for (let i = snapshot.reviews.length - 1; i >= 0; i -= 1) {
      const count = snapshot.reviews[i].started?.input?.contextCount
      if (count !== undefined) return count
    }
    return 0
  }, [snapshot.reviews])
  /** 评审员会话已占用上下文（字符数估算，用于决定是否新建评审会话）。
   * 2026-08-13 用户反馈：旧实现 Math.round(charCount/1000) 会把 <500
   * 字符直接显示成 "≈0 K"（4 条消息几百字符 → 0 K，不直观）——改为
   * <1K 显示具体字数，≥1K 显示 K（<10K 保留一位小数）。 */
  const contextChars = useMemo(() => {
    const stats = snapshot.status?.conversationStats
    if (stats === null || stats === undefined) return null
    const k = stats.charCount / 1000
    if (k < 1) return t('advisor.context.chars', { count: stats.charCount })
    return `${k >= 10 ? Math.round(k) : k.toFixed(1)} K`
  }, [snapshot.status?.conversationStats])

  const status = snapshot.status?.runtimeStatus ?? 'disabled'
  const statusInfo = statusMeta(status, t)
  // 2026-08-12 用户反馈：owner 优先用 status 兜底（评审卡片未产生时
  // 也能显示会话名/工作空间），再回退评审卡片的 identity
  const ownerLabel = `${snapshot.status?.sessionName ?? identity.sessionName ?? shortSession(snapshot.sessionId)} · ${snapshot.status?.workspace ?? identity.workspace ?? t('advisor.workspace.unknown')}`
  const workspaceOptions = useMemo(() => {
    const values = new Set<string>()
    for (const record of snapshot.records) {
      if (record.workspace !== null && record.workspace !== '') values.add(record.workspace)
    }
    for (const item of snapshot.reviews) {
      const value = item.started?.workspace ?? item.record?.workspace
      if (value !== null && value !== undefined && value !== '') values.add(value)
    }
    return [...values]
  }, [snapshot.records, snapshot.reviews])

  const visibleRecords = useMemo(() => {
    const cutoff = timeCutoff(filters.timeRange)
    return cutoff === null ? snapshot.records : snapshot.records.filter((record) => record.ts >= cutoff)
  }, [snapshot.records, filters.timeRange])

  const submitInstruction = async (): Promise<void> => {
    const text = instruction.trim()
    if (text === '') return
    await store.sendInstruction(text)
    if (store.getSnapshot().instructionsError === null) setInstruction('')
  }

  const onInstructionKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void submitInstruction()
    }
  }

  return (
    <aside className="advisor-panel" aria-label={t('advisor.panel.aria')}>
      <header className="advisor-panel-header">
        <div className="advisor-panel-heading">
          <div className="advisor-title-row">
            <strong className="advisor-title">{t('advisor.panel.title')}</strong>
            <span className={`advisor-status-badge ${statusInfo.cls}`} title={snapshot.status?.phase || statusInfo.label}>
              <span className="advisor-status-icon" aria-hidden="true">{statusInfo.icon}</span>
              {statusInfo.label}
            </span>
          </div>
          <div className="advisor-owner" title={ownerLabel}>{ownerLabel}</div>
        </div>
        <button type="button" className="advisor-icon-button" onClick={onCollapse} aria-label={t('advisor.panel.collapseAria')} title={t('advisor.panel.collapse')}>
          —
        </button>
      </header>

      <section className="advisor-status-strip" aria-label={t('advisor.statusStrip.aria')}>
        <button
          type="button"
          role="switch"
          aria-checked={snapshot.status?.effectiveEnabled ?? false}
          className={`advisor-switch${snapshot.status?.effectiveEnabled ? ' advisor-switch-on' : ''}`}
          disabled={snapshot.statusLoading || snapshot.status === null}
          onClick={() => void store.toggleSession(!(snapshot.status?.effectiveEnabled ?? false))}
          title={t('advisor.switch.title')}
        >
          <span className="advisor-switch-track"><span className="advisor-switch-thumb" /></span>
          <span>{snapshot.status?.effectiveEnabled ? t('advisor.switch.on') : t('advisor.switch.off')}</span>
        </button>
        <div className="advisor-status-facts">
          <span className="advisor-model" title={`${snapshot.status?.provider ?? '—'} / ${snapshot.status?.model ?? '—'}`}>
            {snapshot.status?.model ?? t('advisor.model.unresolved')}
          </span>
          <span>{formatAgo(snapshot.lastActivityAt, t)}</span>
          {(snapshot.status?.pendingCount ?? 0) > 0 && (
            <span className="advisor-pending-count">pending {snapshot.status?.pendingCount}</span>
          )}
        </div>
      </section>

      {snapshot.status?.gateStatus !== undefined && snapshot.status.gateStatus !== 'ok' && (
        <div className="advisor-warning" role="status">
          {t('advisor.gate.failed', { reason: snapshot.status.disabledReason ?? (snapshot.status.gateStatus === 'config-incomplete'
            ? t('advisor.gate.configIncomplete')
            : t('advisor.gate.modelUnavailable')) })}
        </div>
      )}
      {snapshot.statusError !== null && (
        <ErrorNotice t={t} text={t('advisor.error.statusLoad', { message: snapshot.statusError })} onRetry={() => void store.refreshStatus()} />
      )}
      {snapshot.notice !== null && (
        <div className={`advisor-notice advisor-notice-${snapshot.notice.kind}`} role="status">
          <span>{snapshot.notice.text}</span>
          <button type="button" className="advisor-notice-close" onClick={() => store.clearNotice()} aria-label={t('advisor.notice.dismiss')}>×</button>
        </div>
      )}

      <div className="advisor-tabs" role="tablist" aria-label={t('advisor.tabs.aria')}>
        {/* 2026-08-12 用户拍板：约束 Tab 放最前——对本会话评审员的层级约束 */}
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'scopes'}
          className={`advisor-tab${tab === 'scopes' ? ' advisor-tab-active' : ''}`}
          onClick={() => setTab('scopes')}
        >
          {t('advisor.tab.scopes')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'live'}
          className={`advisor-tab${tab === 'live' ? ' advisor-tab-active' : ''}`}
          onClick={() => setTab('live')}
        >
          {t('advisor.tab.live')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'history'}
          className={`advisor-tab${tab === 'history' ? ' advisor-tab-active' : ''}`}
          onClick={() => setTab('history')}
        >
          {t('advisor.tab.history')}
        </button>
        {/* 2026-08-12 用户反馈：设置移入独立 Tab（交互统一） */}
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'settings'}
          className={`advisor-tab${tab === 'settings' ? ' advisor-tab-active' : ''}`}
          onClick={() => setTab('settings')}
        >
          {t('advisor.tab.settings')}
        </button>
      </div>

      {tab === 'scopes' ? (
        <ScopesErrorBoundary t={t}>
          <ScopesTab t={t} store={store} snapshot={snapshot} />
        </ScopesErrorBoundary>
      ) : tab === 'live' ? (
        /* 2026-08-12 用户反馈：指令区（发指令/新建评审会话）只在实时 tab 显示 */
        <div className="advisor-live">
        <section ref={flowRef} className="advisor-flow" onScroll={onFlowScroll} aria-label={t('advisor.live.aria')}>
          {snapshot.eventsError !== null && (
            <ErrorNotice t={t} text={t('advisor.error.eventsLoad', { message: snapshot.eventsError })} onRetry={() => store.resetCursorAndLive()} />
          )}
          {snapshot.eventsLoading && snapshot.reviews.length === 0 && <LoadingBlock text={t('advisor.loading.events')} />}
          {!snapshot.eventsLoading && snapshot.reviews.length === 0 && snapshot.eventsError === null && (
            <div className="advisor-empty">
              {snapshot.status?.effectiveEnabled
                ? t('advisor.live.emptyEnabled')
                : t('advisor.live.emptyDisabled')}
            </div>
          )}
          {snapshot.reviews.map((item, index) => (
            <ReviewCard
              key={item.reviewId}
              t={t}
              item={item}
              defaultInputOpen={index === snapshot.reviews.length - 1}
            />
          ))}
          {!following && (
            <button
              type="button"
              className="advisor-follow-button"
              onClick={() => {
                setFollowing(true)
                const node = flowRef.current
                if (node !== null) node.scrollTop = node.scrollHeight
              }}
            >
              {t('advisor.live.backToLatest')}
            </button>
          )}
        </section>
                <section className="advisor-instructions" aria-label={t('advisor.instructions.aria')}>
        <div className="advisor-instruction-compose">
        <textarea
        className="advisor-textarea advisor-instruction-input"
        rows={2}
        maxLength={2_000}
        value={instruction}
        onChange={(event) => setInstruction(event.target.value)}
        onKeyDown={onInstructionKeyDown}
        placeholder={t('advisor.instructions.placeholder')}
        />
        <button
        type="button"
        className="advisor-button advisor-button-primary"
        disabled={snapshot.instructionMutating || instruction.trim() === ''}
        onClick={() => void submitInstruction()}
        >
        {t('advisor.instructions.send')}
        </button>
        </div>
        <div className="advisor-steer-hint">
        {t('advisor.instructions.hint')}
        </div>
        {/* Q3 重构：评审员会话管理——上下文统计 + 新建评审会话 */}
        <div className="advisor-conversation-bar">
        <span className="advisor-conversation-stats" title={t('advisor.conversation.statsTitle')}>
        {latestEpoch !== null ? t('advisor.conversation.epoch', { epoch: latestEpoch }) : t('advisor.conversation.label')} · {t('advisor.conversation.contextCount', { count: latestContextCount })}
        {contextChars !== null && ` · ≈${contextChars}`}
        </span>
        <button
        type="button"
        className="advisor-new-conversation"
        disabled={snapshot.instructionMutating}
        onClick={() => {
        if (window.confirm(t('advisor.conversation.resetConfirm'))) {
        void store.resetConversation()
        }
        }}
        title={t('advisor.conversation.resetTitle')}
        >
        🔄 {t('advisor.conversation.reset')}
        </button>
        </div>
        <button
        type="button"
        className="advisor-pending-toggle"
        aria-expanded={pendingOpen}
        onClick={() => setPendingOpen((value) => !value)}
        >
        <span>{t('advisor.pending.toggle', { count: snapshot.pending.length })}</span>
        <span aria-hidden="true">{pendingOpen ? '▴' : '▾'}</span>
        </button>
        {pendingOpen && (
        <div className="advisor-pending-list">
        {snapshot.instructionsLoading && <span className="advisor-muted">{t('advisor.loading.short')}</span>}
        {!snapshot.instructionsLoading && snapshot.pending.length === 0 && (
        <span className="advisor-muted">{t('advisor.pending.empty')}</span>
        )}
        {snapshot.pending.map((item) => (
        <div key={item.id} className="advisor-pending-item">
        <span className="advisor-pending-state">{item.state === 'reserved' ? t('advisor.pending.consuming') : t('advisor.pending.waiting')}</span>
        <span className="advisor-pending-text" title={item.text}>{item.text}</span>
        </div>
        ))}
        {snapshot.pending.length > 0 && (
        <button
        type="button"
        className="advisor-link advisor-link-danger"
        disabled={snapshot.instructionMutating}
        onClick={() => void store.clearInstructions()}
        >
        {t('advisor.pending.clear')}
        </button>
        )}
        </div>
        )}
        {snapshot.instructionsError !== null && (
        <div className="advisor-inline-error">
        {snapshot.instructionsError}
        <button type="button" className="advisor-link" onClick={() => void store.refreshInstructions()}>{t('advisor.action.retry')}</button>
        </div>
        )}
        </section>
        </div>
      ) : tab === 'settings' ? (
        /* 2026-08-12 用户反馈：会话评审设置移入独立 Tab（交互统一） */
        <SettingsDisclosure t={t} store={store} snapshot={snapshot} />
      ) : (
        <section className="advisor-history" aria-label={t('advisor.history.aria')}>
          <div className="advisor-history-filters">
            <select
              className="advisor-select"
              value={filters.session}
              onChange={(event) => setFilters({ ...filters, session: event.target.value as 'current' | 'all' })}
              aria-label={t('advisor.history.sessionFilter')}
            >
              <option value="current">{t('advisor.history.sessionCurrent')}</option>
              <option value="all">{t('advisor.history.sessionAll')}</option>
            </select>
            <select
              className="advisor-select"
              value={filters.severity}
              onChange={(event) => setFilters({ ...filters, severity: event.target.value as '' | AdvisorNoteSeverity })}
              aria-label={t('advisor.history.severityFilter')}
            >
              <option value="">{t('advisor.history.severityAll')}</option>
              <option value="info">info</option>
              <option value="nit">nit</option>
              <option value="concern">concern</option>
              <option value="blocker">blocker</option>
              <option value="answer">{t('advisor.history.severityAnswer')}</option>
            </select>
            <select
              className="advisor-select"
              value={filters.timeRange}
              onChange={(event) => setFilters({ ...filters, timeRange: event.target.value as AdvisorHistoryFilters['timeRange'] })}
              aria-label={t('advisor.history.timeFilter')}
            >
              <option value="all">{t('advisor.history.timeAll')}</option>
              <option value="24h">{t('advisor.history.time24h')}</option>
              <option value="7d">{t('advisor.history.time7d')}</option>
              <option value="30d">{t('advisor.history.time30d')}</option>
            </select>
            <div className="advisor-workspace-filter">
              <input
                className="advisor-input"
                list="advisor-workspaces"
                value={filters.workspace}
                onChange={(event) => setFilters({ ...filters, workspace: event.target.value })}
                placeholder={t('advisor.history.workspacePlaceholder')}
                aria-label={t('advisor.history.workspaceFilter')}
              />
              <datalist id="advisor-workspaces">
                {workspaceOptions.map((workspace) => <option key={workspace} value={workspace} />)}
              </datalist>
              <button type="button" className="advisor-button" onClick={() => void store.loadRecords(filters)}>
                {t('advisor.history.query')}
              </button>
            </div>
          </div>
          {snapshot.recordsError !== null && (
            <ErrorNotice t={t} text={t('advisor.error.recordsLoad', { message: snapshot.recordsError })} onRetry={() => void store.loadRecords(filters)} />
          )}
          {snapshot.recordsLoading && snapshot.records.length === 0 && <LoadingBlock text={t('advisor.loading.records')} />}
          {!snapshot.recordsLoading && visibleRecords.length === 0 && snapshot.recordsError === null && (
            <div className="advisor-empty">{t('advisor.history.empty')}</div>
          )}
          <div className="advisor-history-list">
            {visibleRecords.map((record, index) => (
              <ReviewCard
                key={record.reviewId}
                t={t}
                item={{ reviewId: record.reviewId, started: null, finished: null, record, arrivedAt: 0 }}
                defaultInputOpen={index === 0}
                history
              />
            ))}
          </div>
          {snapshot.recordsHasMore && (
            <button
              type="button"
              className="advisor-button advisor-load-more"
              disabled={snapshot.recordsLoading}
              onClick={() => void store.loadRecords(snapshot.recordsFilters, true)}
            >
              {snapshot.recordsLoading ? t('advisor.loading.short') : t('advisor.history.loadMore')}
            </button>
          )}
        </section>
      )}

    </aside>
  )
}

function ReviewCard(props: {
  t: Translate
  item: AdvisorReviewItem
  defaultInputOpen: boolean
  history?: boolean
}): JSX.Element {
  const { t, item, history = false } = props
  // ME-6（2026-09-17 二审）：defaultInputOpen 是「由列表位置派生的默认值」
  // （调用点传 index === reviews.length - 1），不能当受控值回灌 —— 新评审到达
  // 时旧卡从 last 变 last-1，这个 effect 会把用户正在读的输入快照自己折叠
  // （即便用户此前手动点开过也会被覆盖）。取挂载初值即可。
  const [inputOpen, setInputOpen] = useState(props.defaultInputOpen)

  const terminal = item.finished ?? item.record
  const ts = item.started?.ts ?? terminal?.ts ?? 0
  const note = terminal?.note ?? null
  const severity = note === null ? null : severityMeta(note.severity, t)
  const inProgress = terminal === null
  const identity = item.started === null && item.record !== null
    ? `${item.record.sessionName ?? shortSession(item.record.sessionId)} · ${item.record.workspace ?? t('advisor.workspace.unknown')}`
    : null

  return (
    <article
      className={`advisor-review-card${inProgress ? ' advisor-review-card-running' : ''}${history ? ' advisor-review-card-history' : ''}`}
      tabIndex={0}
      aria-label={t('advisor.card.aria', { reviewId: item.reviewId })}
    >
      <div className="advisor-review-meta">
        <time dateTime={new Date(ts).toISOString()} title={formatDateTime(ts)}>{history ? formatDateTime(ts) : formatClock(ts)}</time>
        {severity !== null && <span className={`advisor-severity ${severity.cls}`}>{severity.label}</span>}
        {terminal !== null && <span>{formatElapsed(terminal.elapsedMs)}</span>}
        {terminal?.delivery === 'steer' && <span className="advisor-delivery">{t('advisor.delivery.steer')}</span>}
        {terminal?.delivery === 'inject' && <span className="advisor-delivery">{t('advisor.delivery.inject')}</span>}
        {terminal !== null && terminal.delivery === null && <span>{outcomeLabel(terminal.outcome, t)}</span>}
      </div>

      {identity !== null && <div className="advisor-record-owner" title={identity}>{identity}</div>}

      {(terminal?.instructions.length ?? 0) > 0 && (
        <div className="advisor-consumed-instructions">
          <span className="advisor-instruction-tag">📋 {t('advisor.card.instructions', { count: terminal?.instructions.length ?? 0 })}</span>
          {terminal?.instructions.map((text, index) => (
            <span key={`${index}-${text}`} className="advisor-consumed-text" title={text}>{text}</span>
          ))}
        </div>
      )}

      {item.started !== null ? (
        <div className="advisor-input-block">
          <button
            type="button"
            className="advisor-input-summary"
            aria-expanded={inputOpen}
            onClick={() => setInputOpen((value) => !value)}
          >
            {/* Q3 重构：上下文统计（历史条数 + 会话代数）+ 本轮增量条数 */}
            <span>
              {t('advisor.card.sessionEpoch', { epoch: item.started.input.epoch })} · {t('advisor.conversation.contextCount', { count: item.started.input.contextCount })}
              {item.started.input.mode === 'qa' ? t('advisor.card.qa') : t('advisor.card.thisRound', { count: item.started.input.messageCount })}
            </span>
            <span aria-hidden="true">{inputOpen ? t('advisor.card.collapse') : t('advisor.card.expand')}</span>
          </button>
          {inputOpen && <pre className="advisor-input-markdown">{item.started.input.markdown}</pre>}
        </div>
      ) : history ? (
        <div className="advisor-input-unavailable">{t('advisor.card.noInputSnapshot')}</div>
      ) : null}

      {inProgress ? (
        <div className="advisor-reviewing" aria-live="polite">
          <span>{t('advisor.card.reviewing')}</span>
          <span className="advisor-skeleton-line" />
          <span className="advisor-skeleton-line advisor-skeleton-line-short" />
        </div>
      ) : note !== null ? (
        <div className="advisor-note">
          {/* 2026-08-12 用户反馈：说明"已抑制"含义（闸门拦截、未注入主会话） */}
          {terminal?.outcome === 'suppressed' && (
            <div className="advisor-note-meta">{t('advisor.card.suppressedNote')}</div>
          )}
          {note.text}
        </div>
      ) : (
        <div className="advisor-outcome-empty">{outcomeLabel(terminal.outcome, t)}</div>
      )}

      {terminal?.error !== null && terminal?.error !== undefined && (
        <div className="advisor-card-error">
          {terminal.error.code}{t('advisor.card.errorSep')}{terminal.error.message}
          {terminal.error.retryable && <span>{t('advisor.card.retryable')}</span>}
        </div>
      )}
    </article>
  )
}

/**
 * 约束区错误边界（2026-08-12 用户反馈：约束 Tab 抛错曾导致整个弹窗被
 * DSH 的 SlotErrorBoundary 移除）。这里兜底：约束区域出错只显示错误条，
 * 面板其余部分（实时/记录/指令区）不受影响；错误详情打印到 console。
 */
class ScopesErrorBoundary extends Component<{ t: Translate; children: ReactNode }, { failed: string | null }> {
  override state: { failed: string | null } = { failed: null }

  static getDerivedStateFromError(error: unknown): { failed: string | null } {
    return { failed: error instanceof Error ? error.message : String(error) }
  }

  override componentDidCatch(error: unknown): void {
    console.error('advisor scopes tab crashed:', error)
  }

  override render(): ReactNode {
    if (this.state.failed !== null) {
      return (
        <section className="advisor-scopes" aria-label={this.props.t('advisor.scopes.aria')}>
          <div className="advisor-card-error">{this.props.t('advisor.scopes.boundaryError', { message: this.state.failed })}</div>
        </section>
      )
    }
    return this.props.children
  }
}

/**
 * 约束 Tab（2026-08-12 用户拍板四层级）：从上往下 = 本次评审会话约束 /
 * 本会话约束 / 本项目约束。每个输入框多行（可同时放多条指令），保存后
 * 下次评审立即生效（后端动态拼接，无需重建）。
 * 生命周期：评审会话约束随「新建评审会话」清空；会话/项目约束持久化。
 */
function ScopesTab({ t, store, snapshot }: {
  t: Translate
  store: AdvisorSessionStore
  snapshot: AdvisorStoreSnapshot
}): JSX.Element {
  const [draft, setDraft] = useState<AdvisorScopes | null>(null)

  useEffect(() => {
    if (snapshot.scopes === null) return
    setDraft({
      global: { text: snapshot.scopes.global.text },
      project: { workspace: snapshot.scopes.project.workspace, text: snapshot.scopes.project.text },
      session: { text: snapshot.scopes.session.text },
      conversation: { text: snapshot.scopes.conversation.text },
    })
  }, [snapshot.scopes])

  if (draft === null) {
    return (
      <section className="advisor-scopes" aria-label={t('advisor.scopes.aria')}>
        {snapshot.scopesLoading && <LoadingBlock text={t('advisor.loading.scopes')} />}
        {snapshot.scopesError !== null && (
          <ErrorNotice t={t} text={t('advisor.error.scopesLoad', { message: snapshot.scopesError })} onRetry={() => void store.refreshScopes()} />
        )}
      </section>
    )
  }

  const save = (level: 'global' | 'project' | 'session' | 'conversation', text: string): void => {
    void store.saveScope(level, text)
  }

  return (
    <section className="advisor-scopes" aria-label={t('advisor.scopes.aria')}>
      {snapshot.scopesError !== null && (
        <ErrorNotice t={t} text={t('advisor.error.scopesSave', { message: snapshot.scopesError })} onRetry={() => void store.refreshScopes()} />
      )}
      <div className="advisor-scope-hint">
        {t('advisor.scopes.hint')}
      </div>

      {/* 第 4 层：本次评审会话约束（新建评审会话即清空） */}
      <ScopeField
        label={t('advisor.scopes.conversationLabel', { level: levelLabel('conversation', t) })}
        value={draft.conversation.text}
        placeholder={t('advisor.scopes.conversationPlaceholder')}
        t={t}
        saving={snapshot.scopesSaving}
        onSave={(text) => save('conversation', text)}
      />

      {/* 第 3 层：本会话约束（跨新建评审会话保留） */}
      <ScopeField
        label={t('advisor.scopes.sessionLabel', { level: levelLabel('session', t) })}
        value={draft.session.text}
        placeholder={t('advisor.scopes.sessionPlaceholder')}
        t={t}
        saving={snapshot.scopesSaving}
        onSave={(text) => save('session', text)}
      />

      {/* 第 2 层：本项目约束（本工作区所有会话共享） */}
      <ScopeField
        label={t('advisor.scopes.projectLabel', { level: levelLabel('project', t), workspace: draft.project.workspace ?? t('advisor.workspace.unknownShort') })}
        value={draft.project.text}
        placeholder={t('advisor.scopes.projectPlaceholder')}
        t={t}
        saving={snapshot.scopesSaving}
        onSave={(text) => save('project', text)}
      />

      {/* 第 0 层：全局约束（所有项目所有会话生效）——2026-08-12 用户拍板：
          系统提示词一般不改，全局约束词是日常层 */}
      <ScopeField
        label={t('advisor.scopes.globalLabel', { level: levelLabel('global', t) })}
        value={draft.global.text}
        placeholder={t('advisor.scopes.globalPlaceholder')}
        t={t}
        saving={snapshot.scopesSaving}
        onSave={(text) => save('global', text)}
      />
    </section>
  )
}

/** 单层约束输入框（多行 + 保存按钮）。 */
function ScopeField(props: {
  t: Translate
  label: string
  value: string
  placeholder: string
  saving: boolean
  onSave: (text: string) => void
}): JSX.Element {
  const [value, setValue] = useState(props.value)
  const [dirty, setDirty] = useState(false)
  useEffect(() => {
    setValue(props.value)
    setDirty(false)
  }, [props.value])

  return (
    <label className="advisor-scope-field">
      <span className="advisor-scope-label">{props.label}</span>
      <textarea
        className="advisor-textarea advisor-scope-textarea"
        rows={4}
        maxLength={4_000}
        value={value}
        onChange={(event) => {
          setValue(event.target.value)
          setDirty(true)
        }}
        placeholder={props.placeholder}
      />
      <button
        type="button"
        className="advisor-button advisor-scope-save"
        disabled={props.saving || (!dirty && value === props.value)}
        onClick={() => props.onSave(value)}
      >
        {props.saving ? props.t('advisor.action.saving') : props.t('advisor.action.save')}
      </button>
    </label>
  )
}

function SettingsDisclosure({ t, store, snapshot }: {
  t: Translate
  store: AdvisorSessionStore
  snapshot: AdvisorStoreSnapshot
}): JSX.Element {
  const [draft, setDraft] = useState<Pick<AdvisorConfig,
    'advisorProvider' | 'advisorModel' | 'advisorSystemPrompt' | 'advisorPanelEnabled'
    | 'advisorInfoInject'
  > | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)

  useEffect(() => {
    if (snapshot.config === null) return
    setDraft({
      advisorProvider: snapshot.config.advisorProvider,
      advisorModel: snapshot.config.advisorModel,
      advisorSystemPrompt: snapshot.config.advisorSystemPrompt,
      advisorPanelEnabled: snapshot.config.advisorPanelEnabled,
      advisorInfoInject: snapshot.config.advisorInfoInject,
    })
  }, [snapshot.config])

  const save = async (): Promise<void> => {
    if (draft === null) return
    const provider = draft.advisorProvider?.trim() ?? ''
    const model = draft.advisorModel?.trim() ?? ''
    if ((provider === '') !== (model === '')) {
      setLocalError(t('advisor.settings.providerModelPair'))
      return
    }
    // Q5：提示词与内置默认相同 → 存 ''（等价内置，未来升级默认提示词自动跟随）；
    // 不同 → 存自定义（下次评审立即生效）
    const defaultPrompt = snapshot.config?.defaultSystemPrompt ?? ''
    const prompt = draft.advisorSystemPrompt.trim() === '' || draft.advisorSystemPrompt.trim() === defaultPrompt.trim()
      ? ''
      : draft.advisorSystemPrompt
    setLocalError(null)
    await store.saveConfig({
      ...draft,
      advisorProvider: provider === '' ? null : provider,
      advisorModel: model === '' ? null : model,
      advisorSystemPrompt: prompt,
    })
  }

  return (
    /* 2026-08-12 用户反馈：设置默认直接显示（去掉 details 折叠箭头） */
    <div className="advisor-settings">
      <div className="advisor-settings-title">{t('advisor.settings.title')}</div>
      <div className="advisor-settings-body">
        {/* 2026-08-14 用户拍板：总闸开关收敛到 Memory Evolve 设置 Tab（此处
            曾与其重复）；面板设置只保留本模块的运行参数，不再重复总闸。 */}
        <div className="advisor-muted">{t('advisor.settings.masterSwitchHint')}</div>
        {snapshot.configLoading && draft === null && <LoadingBlock text={t('advisor.loading.settings')} />}
        {snapshot.configError !== null && (
          <ErrorNotice t={t} text={t('advisor.error.configLoad', { message: snapshot.configError })} onRetry={() => void store.refreshConfig()} />
        )}
        {draft !== null && (
          <>
            <div className="advisor-settings-switches">
              <label className="advisor-check-row">
                <input
                  type="checkbox"
                  checked={draft.advisorPanelEnabled}
                  onChange={(event) => setDraft({ ...draft, advisorPanelEnabled: event.target.checked })}
                />
                <span>{t('advisor.settings.showCapsule')}</span>
              </label>
              {/* Q1：info 级建议默认仅记录不注入（面板可见、会话流零打扰） */}
              <label className="advisor-check-row" title={t('advisor.settings.infoInjectTitle')}>
                <input
                  type="checkbox"
                  checked={draft.advisorInfoInject}
                  onChange={(event) => setDraft({ ...draft, advisorInfoInject: event.target.checked })}
                />
                <span>{t('advisor.settings.infoInject')}</span>
              </label>
            </div>
            <div className="advisor-settings-grid">
              <label className="advisor-field">
                <span>{t('advisor.settings.provider')}</span>
                <input
                  className="advisor-input"
                  value={draft.advisorProvider ?? ''}
                  onChange={(event) => setDraft({ ...draft, advisorProvider: event.target.value })}
                  placeholder={t('advisor.settings.inheritPlaceholder')}
                />
              </label>
              <label className="advisor-field">
                <span>{t('advisor.settings.model')}</span>
                <input
                  className="advisor-input"
                  value={draft.advisorModel ?? ''}
                  onChange={(event) => setDraft({ ...draft, advisorModel: event.target.value })}
                  placeholder={t('advisor.settings.inheritPlaceholder')}
                />
              </label>
            </div>
            {/* Q5：提示词——空配置时回填显示内置默认全文，可编辑保存（=自定义），可一键恢复默认 */}
            <label className="advisor-field">
              <span>
                {t('advisor.settings.systemPrompt')}
                <span className="advisor-prompt-mode">
                  {draft.advisorSystemPrompt === '' ? t('advisor.settings.promptBuiltin') : t('advisor.settings.promptCustom')}
                </span>
              </span>
              <textarea
                className="advisor-textarea advisor-prompt-textarea"
                rows={22}
                maxLength={8_192}
                value={draft.advisorSystemPrompt === '' ? (snapshot.config?.defaultSystemPrompt ?? '') : draft.advisorSystemPrompt}
                onChange={(event) => setDraft({ ...draft, advisorSystemPrompt: event.target.value })}
                placeholder={t('advisor.settings.promptPlaceholder')}
              />
              <button
                type="button"
                className="advisor-link"
                disabled={draft === null || snapshot.configSaving}
                onClick={() => {
                  // 2026-08-13 用户反馈：恢复默认按钮不可点（配置为空时
                  // 禁用）。改为**始终可点**——点击即保存空配置（空=使用
                  // 内置默认）并立即生效；saveConfig 会刷新 config，
                  // 输入框随即显示 API 返回的最新内置默认提示词
                  void (async () => {
                    setDraft({ ...draft, advisorSystemPrompt: '' })
                    await store.saveConfig({ advisorSystemPrompt: '' })
                  })()
                }}
                title={t('advisor.settings.restoreTitle')}
              >
                {t('advisor.settings.restore')}
              </button>
            </label>
            <div className="advisor-settings-hint">
              {t('advisor.settings.overrideHint')}
            </div>
            {(localError ?? snapshot.configError) !== null && (
              <div className="advisor-inline-error">{localError ?? snapshot.configError}</div>
            )}
            <button
              type="button"
              className="advisor-button advisor-button-primary advisor-settings-save"
              disabled={snapshot.configSaving}
              onClick={() => void save()}
            >
              {snapshot.configSaving ? t('advisor.action.saving') : t('advisor.settings.save')}
            </button>
          </>
        )}
      </div>
    </div>
  )
}

function ErrorNotice({ t, text, onRetry }: { t: Translate; text: string; onRetry: () => void }): JSX.Element {
  return (
    <div className="advisor-error" role="alert">
      <span>{text}</span>
      <button type="button" className="advisor-link" onClick={onRetry}>{t('advisor.action.retry')}</button>
    </div>
  )
}

function LoadingBlock({ text }: { text: string }): JSX.Element {
  return (
    <div className="advisor-loading" role="status">
      <span className="advisor-loading-dot" aria-hidden="true" />
      <span>{text}</span>
    </div>
  )
}