import { useEffect, useMemo, useRef, useState } from 'react'
import { t } from './locales.ts'

/**
 * 能力中心（Capability Hub）——技能商城 / 共享技能 / 共享 Agent 的归一入口。
 *
 * 信息架构：一个入口 + 两个维度（来源 × 类型）。
 * - 来源分区：我的（本地创作 + 上传状态）/ 市场（授权制商城）/ 组织（审核+授权共享库）
 * - 类型筛选：全部 / 技能 / 智能体
 *
 * 复合键：卡片 key 与操作一律用 `{kind}:{name}`——技能名与 preset id 允许同名
 * （如 codeql），合并后必须复合键避免串卡。
 *
 * 与旧面板的关键差异（决策文档 §五 Phase 1）：
 * - 卡片唯一位置：已安装条目只在来源分区渲染，本地创作只在「我的」；
 * - 多版本归并：同名（kind+name）归并一张卡，展示最高 approved 版本，
 *   历史版本点开可安装（降级/指定版本）；
 * - hasUpdate 修复：approved 最高版本 > 已装版本才提示更新（semver 比较）；
 * - 共享技能补齐卸载（旧面板只有安装/更新，无卸载入口）；
 * - 分区独立错误态：一个端点失败仅对应分区显示重试，其余照常；
 * - 同名冲突确认：安装前检测磁盘/installed 同名 → 弹「覆盖确认」→ ?force=1；
 * - 30s 静默轮询 + Tab focus trap（取旧 Agent 面板的更完善实现）。
 */

type CapabilityKind = 'skill' | 'agent'
type CapabilitySource = 'market' | 'org' | 'local'
type ItemStatus = 'pending' | 'approved' | 'rejected'

/** 统一视图模型：一个来源一条（同名多版本在服务端/host 已归并为一条，versions 展开）。 */
interface CapabilityItem {
  kind: CapabilityKind
  source: CapabilitySource
  name: string
  displayName: string
  /** 当前展示的版本（来源分区=最高 approved；我的=本地版本/上传版本）。 */
  version: string
  description: string
  author: string
  /** 组织库作者可见的非 approved 状态；undefined = 无上传记录。 */
  status?: ItemStatus | undefined
  reason?: string | undefined
  /** 组织库质量标记（0037）：仅 approved 行有展示语义。 */
  quality?: 'official' | 'featured' | undefined
  /** 该名全部 approved 版本（历史版本展开用；不含当前版本则单元素）。 */
  versions: string[]
  /** 已安装（磁盘存在同名目录，且并非本机创作）。 */
  installed: boolean
  /** 已装版本（hasUpdate 比较基准；本地创作时为其版本）。 */
  installedVersion?: string | undefined
  /** 是否本地创作（「我的」分区用）。 */
  isLocal?: boolean | undefined
  /** 本地创作时是否有上传状态记录（无 = 未上传过）。 */
  uploadStatus?: ItemStatus | undefined
}

/** 来源分区 tab(决策 2026-08-25:市场/组织合并为「市场」——仅 我的/市场)。 */
type SourceTab = 'mine' | 'market'
type TypeFilter = 'all' | CapabilityKind

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
  width: 860,
  maxWidth: 'calc(100vw - 48px)',
  height: 'min(820px, calc(100vh - 48px))',
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

/** 顶部 Tab 条：来源分区 + 类型筛选。 */
const TAB_BAR: React.CSSProperties = {
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  padding: '0 18px',
  borderBottom: '1px solid var(--dsw-alias-border-l)',
}

const TAB: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '10px 12px',
  fontSize: 13,
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  color: 'var(--dsw-alias-label-secondary)',
  borderBottom: '2px solid transparent',
  marginBottom: -1,
}

const TAB_ACTIVE: React.CSSProperties = { ...TAB, color: 'var(--dsw-alias-label-primary)', borderBottomColor: 'var(--dsw-alias-brand-primary)' }

const FILTER_SEP: React.CSSProperties = { width: 1, height: 14, background: 'var(--dsw-alias-border-l2)', margin: '0 6px' }

const FILTER: React.CSSProperties = {
  padding: '4px 10px',
  fontSize: 12,
  borderRadius: 999,
  border: '1px solid transparent',
  background: 'transparent',
  cursor: 'pointer',
  color: 'var(--dsw-alias-label-caption)',
}

const FILTER_ACTIVE: React.CSSProperties = {
  ...FILTER,
  borderColor: 'var(--dsw-alias-border-l2)',
  color: 'var(--dsw-alias-label-primary)',
  background: 'var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.04))',
}

const BODY: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
  gridAutoRows: 'minmax(160px, auto)',
  gap: 12,
  padding: 20,
  alignContent: 'start',
}

const CARD: React.CSSProperties = {
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 10,
  padding: 14,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  background: 'var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-layer-2))',
}

const TITLE_ROW: React.CSSProperties = { display: 'flex', alignItems: 'flex-start', gap: 8, minWidth: 0 }
const NAME: React.CSSProperties = { fontSize: 14, fontWeight: 600, margin: 0, color: 'var(--dsw-alias-label-primary)', lineHeight: '20px' }
const META: React.CSSProperties = { fontSize: 12, color: 'var(--dsw-alias-label-caption)', margin: 0, lineHeight: '16px' }
const DESC: React.CSSProperties = {
  fontSize: 12,
  lineHeight: '18px',
  margin: 0,
  color: 'var(--dsw-alias-label-secondary)',
  display: '-webkit-box',
  WebkitLineClamp: 3,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
}

const AVATAR_COLORS = [
  'var(--dsw-static-deepseek-5, var(--dsw-alias-brand-primary))',
  'var(--dsw-static-green-5, var(--dsw-alias-state-success-primary))',
  'var(--dsw-static-amber-5, var(--dsw-alias-state-warn-label))',
  'var(--dsw-static-neutral-5, var(--dsw-alias-label-tertiary))',
]

/** 按名称+类型确定头像颜色（稳定；导出供单测）。 */
export function avatarColor(name: string): string {
  if (name === '') return AVATAR_COLORS[0] ?? 'var(--dsw-alias-brand-primary)'
  let hash = 0
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) >>> 0
  return AVATAR_COLORS[hash % AVATAR_COLORS.length] ?? AVATAR_COLORS[0]!
}

const AVATAR: React.CSSProperties = {
  flex: 'none',
  width: 34,
  height: 34,
  borderRadius: 10,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 14,
  fontWeight: 600,
  lineHeight: 1,
  textTransform: 'uppercase',
}

const NAME_COL: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }
const NAME_WRAP: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flexWrap: 'wrap' }
const NAME_TEXT: React.CSSProperties = { minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }

const BUTTON: React.CSSProperties = {
  width: '100%',
  height: 30,
  padding: '0 12px',
  borderRadius: 6,
  border: '1px solid transparent',
  background: 'var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #2563eb))',
  color: 'var(--dsw-alias-label-inverted, #fff)',
  fontSize: 12,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}

const BUTTON_DISABLED: React.CSSProperties = { ...BUTTON, opacity: 0.6, cursor: 'default' }
const BUTTON_SECONDARY: React.CSSProperties = {
  ...BUTTON,
  border: '1px solid var(--dsw-alias-border-l2)',
  background: 'transparent',
  color: 'var(--dsw-alias-label-secondary)',
}

const EMPTY: React.CSSProperties = { fontSize: 13, color: 'var(--dsw-alias-label-caption)', textAlign: 'center', padding: 24, gridColumn: '1 / -1' }
const CARD_FOOT: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  marginTop: 'auto',
  paddingTop: 10,
  borderTop: '1px solid var(--dsw-alias-border-l)',
}
const NOTICE: React.CSSProperties = { fontSize: 13, margin: 0, textAlign: 'center', padding: 12 }

/** 徽章基础样式（来源/类型/状态共用）。 */
function chipStyle(color: string): React.CSSProperties {
  return {
    flex: 'none',
    padding: '1px 8px',
    borderRadius: 999,
    fontSize: 11,
    lineHeight: '18px',
    color,
    border: `1px solid ${color}`,
    whiteSpace: 'nowrap',
  }
}

const CHIP_NEUTRAL = chipStyle('var(--dsw-alias-label-secondary)')
const CHIP_BRAND = chipStyle('var(--dsw-alias-brand-primary)')
const CHIP_SUCCESS = chipStyle('var(--dsw-alias-state-success-primary)')
const CHIP_WARN = chipStyle('var(--dsw-alias-state-warn-label)')
const CHIP_ERROR = chipStyle('var(--dsw-alias-state-error-primary)')

/** 单测用：数值感知版本比较（对齐服务端 util.CompareSemVer 语义）。 */
export function compareVersions(left: string, right: string): number {
  if (left === right) return 0
  const tokenize = (v: string): Array<{ text: string; numeric: boolean }> | null => {
    const out: Array<{ text: string; numeric: boolean }> = []
    let run = ''
    let numeric = false
    let have = false
    const flush = (): void => {
      if (have) { out.push({ text: run, numeric }); run = ''; have = false }
    }
    for (const ch of v) {
      if (ch === '.' || ch === '-' || ch === '_') { flush(); continue }
      if (ch >= '0' && ch <= '9') { if (have && !numeric) flush(); run += ch; numeric = true; have = true; continue }
      if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')) { if (have && numeric) flush(); run += ch; numeric = false; have = true; continue }
      return null
    }
    flush()
    return out.length === 0 ? null : out
  }
  const lt = tokenize(left)
  const rt = tokenize(right)
  if (lt === null || rt === null) return left < right ? -1 : left > right ? 1 : 0
  const n = Math.max(lt.length, rt.length)
  for (let i = 0; i < n; i += 1) {
    const l = lt[i]
    const r = rt[i]
    if (l !== undefined && r !== undefined) {
      if (l.numeric !== r.numeric) return l.numeric ? -1 : 1
      if (l.numeric) {
        const ln = Number(l.text) || 0
        const rn = Number(r.text) || 0
        if (ln < rn) return -1
        if (ln > rn) return 1
        continue
      }
      if (l.text !== r.text) return l.text < r.text ? -1 : 1
      continue
    }
    const extra = l ?? r
    if (extra !== undefined && !extra.numeric) return l === undefined ? 1 : -1
    return l === undefined ? -1 : 1
  }
  return 0
}

/** 根据（kind, name）取最高 approved 版本（数值感知）。 */
export function latestApprovedVersionByName(items: readonly CapabilityItem[], kind: CapabilityKind, name: string): string | undefined {
  const versions = items.filter(i => i.kind === kind && i.name === name && i.status === 'approved').map(i => i.version)
  if (versions.length === 0) return undefined
  return versions.reduce((best, v) => (compareVersions(v, best) > 0 ? v : best), versions[0]!)
}

/** 是否应显示「更新到 vX」：approved 最高版本 > 已装版本。 */
export function hasUpdateFor(item: CapabilityItem): boolean {
  if (!item.installed) return false
  const latest = item.versions.length > 0 ? item.versions[item.versions.length - 1] : undefined
  if (latest === undefined || item.installedVersion === undefined) return false
  return compareVersions(latest, item.installedVersion) > 0
}

/** 单测用：把同名（kind+name）条目归并成一张卡（保留最高 approved 版本为当前）。 */
export function mergeItems(items: readonly CapabilityItem[]): CapabilityItem[] {
  const byKey = new Map<string, CapabilityItem>()
  for (const item of items) {
    const key = `${item.kind}:${item.name}`
    const existing = byKey.get(key)
    if (existing === undefined) {
      byKey.set(key, { ...item, versions: item.versions.length > 0 ? [...item.versions] : [item.version] })
      continue
    }
    // 合并 versions（去重、升序）。
    const all = new Set([...existing.versions, ...item.versions, item.version])
    const sorted = [...all].sort(compareVersions)
    // 取 approved 最高版作为当前展示；无 approved 保留原样。
    const approved = [...all].filter(v => items.some(x => x.kind === item.kind && x.name === item.name && x.version === v && x.status === 'approved'))
    const display = approved.length > 0 ? approved.reduce((best, v) => (compareVersions(v, best) > 0 ? v : best), approved[0]!) : existing.version
    byKey.set(key, { ...existing, version: display, versions: sorted })
  }
  return [...byKey.values()]
}

/** 每个（来源,类型）的加载状态（分区独立错误态）。 */
type SectionStatus = 'idle' | 'loading' | 'ok' | 'error'
interface SectionState {
  status: SectionStatus
  error: string
}

interface ActionState {
  key: string
  kind: 'installing' | 'uninstalling' | 'uploading' | 'done-install' | 'done-uninstall' | 'done-upload' | 'failed'
  error?: string | undefined
  name?: string | undefined
}

export function CapabilityCenterPanel({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<SourceTab>('mine')
  const [filter, setFilter] = useState<TypeFilter>('all')
  const [items, setItems] = useState<CapabilityItem[]>([])
  const [sections, setSections] = useState<Record<string, SectionState>>({})
  const [loading, setLoading] = useState(true)
  const [action, setAction] = useState<ActionState | null>(null)
  const [confirmKey, setConfirmKey] = useState<string | null>(null)
  const [expandedVersions, setExpandedVersions] = useState<Record<string, boolean>>({})
  const loadSeqRef = useRef(0)
  const panelRef = useRef<HTMLDivElement | null>(null)

  const setSection = (key: string, state: Partial<SectionState>): void => {
    setSections(prev => ({ ...prev, [key]: { status: prev[key]?.status ?? 'idle', error: prev[key]?.error ?? '', ...state } }))
  }

  const loadSection = async (key: string, fetcher: () => Promise<CapabilityItem[]>): Promise<void> => {
    const seq = loadSeqRef.current
    setSection(key, { status: 'loading', error: '' })
    try {
      const rows = await fetcher()
      if (seq !== loadSeqRef.current) return
      // 决策 2026-08-25:「市场」tab 承载 market+org 合并结果——加载 market
      // 时清除两源旧条目;「我的」只清 local。
      const drop = key === 'market' ? (i: CapabilityItem) => i.source !== 'local' : (i: CapabilityItem) => i.source === 'local'
      setItems(prev => [...prev.filter(i => !drop(i)), ...rows])
      setSection(key, { status: 'ok' })
    } catch {
      if (seq !== loadSeqRef.current) return
      setSection(key, { status: 'error', error: t('capability.loadError') })
    }
  }

  const loadAll = (): void => {
    ++loadSeqRef.current
    setLoading(true)
    // 决策 2026-08-25:市场/组织合并为「市场」——?source=market 由服务端
    // 合并返回(市场+组织,各自 source 徽章保留);「我的」仍走 local。
    void loadSection('market', async () => {
      const res = await fetch('/api/pico/capabilities?source=market')
      if (!res.ok) throw new Error(`HTTP ${String(res.status)}`)
      return (await res.json() as { items?: CapabilityItem[] }).items ?? []
    })
    void loadSection('mine', async () => {
      const res = await fetch('/api/pico/capabilities?source=local')
      if (!res.ok) throw new Error(`HTTP ${String(res.status)}`)
      return (await res.json() as { items?: CapabilityItem[] }).items ?? []
    })
    setLoading(false)
  }

  useEffect(() => {
    loadAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Esc close + initial focus + Tab focus trap（取旧 Agent 面板的更完善实现）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { onClose(); return }
      if (e.key !== 'Tab' || panelRef.current === null) return
      const focusables = panelRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )
      if (focusables.length === 0) return
      const first = focusables[0]!
      const last = focusables[focusables.length - 1]!
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    panelRef.current?.focus()
    return () => { window.removeEventListener('keydown', onKey) }
  }, [onClose])

  // 30s 静默轮询:市场(合并)审批状态/质量变化后台刷新。
  useEffect(() => {
    const timer = setInterval(() => {
      const seq = loadSeqRef.current
      void fetch('/api/pico/capabilities?source=market').then(async (res) => {
        if (!res.ok) return
        const data = await res.json() as { items?: CapabilityItem[] }
        if (seq !== loadSeqRef.current) return
        setItems(prev => [...prev.filter(i => i.source === 'local'), ...(data.items ?? [])])
      }).catch(() => {})
    }, 30000)
    return () => { clearInterval(timer) }
  }, [])

  const install = async (item: CapabilityItem, opts?: { force?: boolean; version?: string }): Promise<void> => {
    if (action !== null && (action.kind === 'installing' || action.kind === 'uninstalling' || action.kind === 'uploading')) return
    const key = `${item.kind}:${item.name}`
    // 同名冲突确认（磁盘/installed 已有同名目录且非覆盖安装）。
    if (!opts?.force && (item.installed || (item.source !== 'local' && item.isLocal))) {
      setConfirmKey(key)
      return
    }
    setConfirmKey(null)
    setAction({ key, kind: 'installing' })
    try {
      const targetVersion = opts?.version ?? item.version
      const base = item.kind === 'skill'
        ? `/api/pico/shared-skills/${encodeURIComponent(item.name)}/${encodeURIComponent(targetVersion)}/install`
        : `/api/pico/agent-presets/${encodeURIComponent(item.name)}/install`
      const url = opts?.force ? `${base}?force=1` : base
      const res = await fetch(url, { method: 'POST' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error((data as { error?: string }).error ?? `HTTP ${String(res.status)}`)
      }
      setItems(prev => prev.map(i => (i.kind === item.kind && i.name === item.name ? { ...i, installed: true, installedVersion: targetVersion } : i)))
      setAction({ key, kind: 'done-install', name: item.name })
    } catch (cause) {
      setAction({ key, kind: 'failed', error: cause instanceof Error ? cause.message : undefined, name: item.name })
    }
  }

  const uninstall = async (item: CapabilityItem): Promise<void> => {
    if (action !== null && (action.kind === 'installing' || action.kind === 'uninstalling' || action.kind === 'uploading')) return
    const key = `${item.kind}:${item.name}`
    if (confirmKey !== key) { setConfirmKey(key); return }
    setConfirmKey(null)
    setAction({ key, kind: 'uninstalling' })
    try {
      const base = item.kind === 'skill'
        ? `/api/pico/shared-skills/${encodeURIComponent(item.name)}/${encodeURIComponent(item.version)}/uninstall`
        : `/api/pico/agent-presets/${encodeURIComponent(item.name)}/uninstall`
      const res = await fetch(base, { method: 'POST' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error((data as { error?: string }).error ?? `HTTP ${String(res.status)}`)
      }
      setItems(prev => prev.map(i => (i.kind === item.kind && i.name === item.name ? { ...i, installed: false, installedVersion: undefined } : i)))
      setAction({ key, kind: 'done-uninstall', name: item.name })
    } catch (cause) {
      setAction({ key, kind: 'failed', error: cause instanceof Error ? cause.message : undefined, name: item.name })
    }
  }

  const upload = async (item: CapabilityItem): Promise<void> => {
    if (action !== null) return
    setAction({ key: `${item.kind}:${item.name}`, kind: 'uploading' })
    try {
      const path = item.kind === 'skill' ? '/api/pico/shared-skills/upload' : '/api/pico/agent-presets/upload'
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: item.name }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error((data as { error?: string }).error ?? `HTTP ${String(res.status)}`)
      }
      setAction({ key: `${item.kind}:${item.name}`, kind: 'done-upload', name: item.name })
      loadAll()
    } catch (cause) {
      setAction({ key: `${item.kind}:${item.name}`, kind: 'failed', error: cause instanceof Error ? cause.message : undefined, name: item.name })
    }
  }

  const visibleByTab = useMemo(() => {
    const base = tab === 'market' ? items.filter(i => i.source !== 'local') : items.filter(i => i.source === 'local')
    const merged = mergeItems(base)
    return filter === 'all' ? merged : merged.filter(i => i.kind === filter)
  }, [items, tab, filter])

  const sectionStatus = (source: CapabilitySource): SectionState => sections[source] ?? { status: 'idle', error: '' }

  const renderBadges = (item: CapabilityItem): React.ReactNode => {
    const statusBadge = item.status === 'pending' ? <span style={CHIP_WARN}>{t('capability.pending')}</span>
      : item.status === 'rejected' ? <span style={CHIP_ERROR}>{t('capability.rejected')}</span>
        : item.source === 'org' && item.installed ? <span style={CHIP_SUCCESS}>{t('capability.installed')}</span>
          : item.installed ? <span style={CHIP_SUCCESS}>{t('capability.installed')}</span> : null
    const qualityBadge = item.quality === 'official' ? <span style={CHIP_BRAND}>{t('capability.official')}</span>
      : item.quality === 'featured' ? <span style={CHIP_WARN}>{t('capability.featured')}</span> : null
    return (
      <>
        <span style={chipStyle(item.kind === 'skill' ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)')}>
          {item.kind === 'skill' ? t('capability.typeSkill') : t('capability.typeAgent')}
        </span>
        {item.source === 'market' ? <span style={CHIP_NEUTRAL}>{t('capability.sourceMarket')}</span>
          : item.source === 'org' ? <span style={CHIP_NEUTRAL}>{t('capability.sourceOrg')}</span>
            : <span style={CHIP_NEUTRAL}>{t('capability.sourceLocal')}</span>}
        {qualityBadge}
        {statusBadge}
      </>
    )
  }

  const renderCard = (item: CapabilityItem): React.ReactNode => {
    const key = `${item.kind}:${item.name}`
    const busy = action?.key === key && (action.kind === 'installing' || action.kind === 'uninstalling' || action.kind === 'uploading')
    const title = item.displayName || item.name
    const isLocal = item.source === 'local'
    const needUpdate = hasUpdateFor(item)
    const expanded = expandedVersions[key] === true
    return (
      <div key={key} className="pico-skill-card" style={CARD}>
        <div style={TITLE_ROW}>
          <span style={{ ...AVATAR, color: avatarColor(item.name), background: `color-mix(in srgb, ${avatarColor(item.name)} 14%, transparent)` }} aria-hidden="true">
            {item.name.charAt(0)}
          </span>
          <div style={NAME_COL}>
            <div style={NAME_WRAP}>
              <p style={{ ...NAME, ...NAME_TEXT }} title={title}>{title}</p>
              {renderBadges(item)}
            </div>
            <p style={META}>{item.author !== '' ? `v${item.version} · ${item.author}` : `v${item.version}`}</p>
          </div>
        </div>
        {item.description !== '' && <p style={DESC}>{item.description}</p>}
        {item.status === 'rejected' && item.reason !== undefined && item.reason !== '' && (
          <p style={{ ...META, color: 'var(--dsw-alias-state-error-primary)', whiteSpace: 'pre-wrap' }}>{t('capability.rejectReason', { reason: item.reason })}</p>
        )}
        <div style={CARD_FOOT}>
          {isLocal ? (
            item.uploadStatus === 'rejected'
              ? <button type="button" style={busy ? BUTTON_DISABLED : BUTTON_SECONDARY} disabled={busy} onClick={() => { void upload(item) }}>{t('capability.reupload')}</button>
              : item.uploadStatus === 'pending'
                ? <span style={{ ...CHIP_WARN, flex: 1, textAlign: 'center' }}>{t('capability.awaitingReview')}</span>
                : item.uploadStatus === 'approved'
                  ? <span style={{ ...CHIP_SUCCESS, flex: 1, textAlign: 'center' }}>{t('capability.approved')}</span>
                  : <button type="button" style={busy ? BUTTON_DISABLED : BUTTON} disabled={busy} onClick={() => { void upload(item) }}>{t('capability.upload')}</button>
          ) : item.installed ? (
            needUpdate ? (
              <button type="button" style={busy ? BUTTON_DISABLED : BUTTON} disabled={busy} onClick={() => { void install(item, { force: true }) }}>
                {t('capability.updateTo', { version: item.versions[item.versions.length - 1] ?? item.version })}
              </button>
            ) : confirmKey === key ? (
              <div style={{ display: 'flex', gap: 8, width: '100%' }}>
                <button type="button" style={{ ...BUTTON, background: 'var(--dsw-alias-state-error-primary)', color: 'var(--dsw-alias-label-inverted, #fff)' }} disabled={busy} onClick={() => { void uninstall(item) }}>
                  {busy && action?.kind === 'uninstalling' ? t('capability.uninstalling') : t('capability.confirmUninstall')}
                </button>
                <button type="button" style={{ ...BUTTON_SECONDARY, flex: 1 }} disabled={busy} onClick={() => { setConfirmKey(null) }}>{t('capability.cancel')}</button>
              </div>
            ) : (
              <button type="button" style={busy ? BUTTON_DISABLED : BUTTON_SECONDARY} disabled={busy} onClick={() => { void uninstall(item) }}>{t('capability.uninstall')}</button>
            )
          ) : (
            <button type="button" style={busy ? BUTTON_DISABLED : BUTTON} disabled={busy} onClick={() => { void install(item) }}>{t('capability.install')}</button>
          )}
        </div>
        {/* 历史版本展开（同名多版本归并后，点开可安装指定版本）。 */}
        {!isLocal && item.versions.length > 1 && (
          <button
            type="button"
            style={{ ...BUTTON_SECONDARY, height: 24, fontSize: 11, width: '100%' }}
            onClick={() => { setExpandedVersions(prev => ({ ...prev, [key]: !prev[key] })) }}
          >
            {expanded ? t('capability.viewVersions', { count: String(item.versions.length) }) + ' ▾' : t('capability.viewVersions', { count: String(item.versions.length) }) + ' ▸'}
          </button>
        )}
        {expanded && item.versions.length > 1 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {item.versions.map(v => (
              <button key={v} type="button" style={{ ...BUTTON_SECONDARY, height: 24, fontSize: 11, width: 'auto', padding: '0 8px' }} onClick={() => { void install(item, { force: true, version: v }) }} disabled={busy}>
                v{v}
              </button>
            ))}
          </div>
        )}
      </div>
    )
  }

  const renderEmpty = (text: string): React.ReactNode => <p style={EMPTY}>{text}</p>

  const renderSection = (key: CapabilitySource, emptyText: string): React.ReactNode => {
    const st = sectionStatus(key)
    if (st.status === 'error') {
      return <div style={{ gridColumn: '1 / -1', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: 24 }}><p style={EMPTY}>{st.error}</p><button type="button" style={BUTTON_SECONDARY} onClick={() => { void loadAll() }}>{t('capability.retry')}</button></div>
    }
    const rows = visibleByTab
    if (rows.length === 0) return renderEmpty(filter === 'all' ? emptyText : t('capability.emptyFilter'))
    return rows.map(renderCard)
  }

  let content: React.ReactNode
  if (loading) {
    content = <div style={{ gridColumn: '1 / -1', display: 'flex', justifyContent: 'center', padding: 48 }}><p style={EMPTY}>{t('capability.loading')}</p></div>
  } else {
    content = renderSection(tab === 'market' ? 'market' : 'local', tab === 'market' ? t('capability.emptyMarket') : t('capability.emptyMine'))
  }

  return (
    <div style={OVERLAY} role="presentation">
      <div style={MASK} aria-hidden="true" onClick={onClose} />
      <div style={PANEL} role="dialog" aria-modal="true" aria-label={t('capability.title')} tabIndex={-1} ref={panelRef}>
        <div style={HEADER}>
          <h2 style={TITLE}>{t('capability.title')}</h2>
          <button type="button" style={CLOSE} onClick={onClose}>{t('capability.close')}</button>
        </div>
        <div style={TAB_BAR}>
          {(['mine', 'market'] as const).map(s => (
            <button key={s} type="button" style={tab === s ? TAB_ACTIVE : TAB} onClick={() => { setTab(s); setConfirmKey(null) }}>
              {s === 'mine' ? t('capability.tabMine') : t('capability.tabMarket')}
            </button>
          ))}
          <span style={FILTER_SEP} aria-hidden="true" />
          {(['all', 'skill', 'agent'] as const).map(f => (
            <button key={f} type="button" style={filter === f ? FILTER_ACTIVE : FILTER} onClick={() => { setFilter(f) }}>
              {f === 'all' ? t('capability.filterAll') : f === 'skill' ? t('capability.filterSkill') : t('capability.filterAgent')}
            </button>
          ))}
        </div>
        <div style={BODY}>{content}</div>
        {confirmKey !== null && (
          <div style={{ padding: '0 20px 12px' }}>
            <p style={{ ...NOTICE, color: 'var(--dsw-alias-state-warn-label)' }}>
              {t('capability.conflictConfirm', { name: confirmKey.split(':')[1] ?? '' })}
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
              <button type="button" style={BUTTON} onClick={() => {
                const item = items.find(i => `${i.kind}:${i.name}` === confirmKey)
                setConfirmKey(null)
                if (item !== undefined) void install(item, { force: true })
              }}>{t('capability.forceInstall')}</button>
              <button type="button" style={BUTTON_SECONDARY} onClick={() => { setConfirmKey(null) }}>{t('capability.cancel')}</button>
            </div>
          </div>
        )}
        {action !== null && action.kind !== 'installing' && action.kind !== 'uninstalling' && action.kind !== 'uploading' && (
          <p style={{ ...NOTICE, color: action.kind === 'failed' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-success-primary)' }}>
            {action.kind === 'done-install'
              ? t('capability.installedName', { name: action.name ?? '' })
              : action.kind === 'done-uninstall'
                ? t('capability.uninstalledName', { name: action.name ?? '' })
                : action.kind === 'done-upload'
                  ? t('capability.uploadedName', { name: action.name ?? '' })
                  : t('capability.failed', { error: action.error ?? '' })}
          </p>
        )}
      </div>
    </div>
  )
}
