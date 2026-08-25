import { useEffect, useRef, useState } from 'react'
import { t } from './locales.ts'

interface Skill {
  name: string
  version: string
  description: string
  author: string
}

/** Shared-library row from `/api/pico/shared-skills` (approved + own). */
interface SharedSkill extends Skill {
  display_name?: string | undefined
  status?: 'pending' | 'approved' | 'rejected' | undefined
  reason?: string | undefined
}

/** Highest approved version of a shared skill (undefined when none). */
export function latestApprovedVersion(rows: readonly SharedSkill[], name: string): string | undefined {
  const versions = rows.filter(s => s.name === name && s.status === 'approved')
  if (versions.length === 0) return undefined
  versions.sort((a, b) => (a.version.localeCompare(b.version, undefined, { numeric: true })))
  return versions[versions.length - 1]!.version
}

/** Local disk skill row (SKILL.md under the skill root). */
interface LocalSkill {
  name: string
  displayName?: string | undefined
  description?: string | undefined
  version?: string | undefined
  /** Upload state from the gateway (pending/approved/rejected), when uploaded. */
  status?: 'pending' | 'approved' | 'rejected' | undefined
  reason?: string | undefined
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

/**
 * 技能卡片网格：面板已升级为卡片网格（auto-fill + minmax），单列卡片
 * 信息密度过低（一屏只见 6 条）。网格下卡片变窄，操作按钮改为底部全宽，
 * 避免名称行与按钮争抢宽度；颜色一律走 DSH 设计 token（含
 * --dsw-alias-button-primary-fill / --dsw-alias-label-inverted 兜底）。
 */
const BODY: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))',
  // 行高下限保证卡片等高（描述长短不一仍对齐），上限 auto 允许长描述撑高。
  gridAutoRows: 'minmax(150px, auto)',
  gap: 12,
  padding: 24,
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

/** 名称行：字母头像 + 名称/徽标一列，按钮下沉到卡片底部（信息密度优先）。 */
const TITLE_ROW: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 8,
  minWidth: 0,
}

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

/** 字母头像：从静态色板按名称哈希取色，色浅底 + 同色文字（深/浅主题均可读）。 */
const AVATAR_COLORS = [
  'var(--dsw-static-deepseek-5, var(--dsw-alias-brand-primary))',
  'var(--dsw-static-green-5, var(--dsw-alias-state-success-primary))',
  'var(--dsw-static-amber-5, var(--dsw-alias-state-warn-label))',
  'var(--dsw-static-neutral-5, var(--dsw-alias-label-tertiary))',
]

/** 按技能名确定头像颜色（稳定：同名恒同色；导出供单测）。 */
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

/** 名称右侧纵向列：名称 + 已安装徽标（同名行内的徽标不再与按钮争宽）。 */
const NAME_COL: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }

const NAME_WRAP: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  minWidth: 0,
}

const NAME_TEXT: React.CSSProperties = {
  minWidth: 0,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}

const BUTTON: React.CSSProperties = {
  width: '100%',
  height: 30,
  padding: '0 12px',
  borderRadius: 6,
  border: '1px solid transparent',
  // 企业版历史主色 #2563eb 作为主题 token 缺省时的兜底（本产品未配置品牌
  // token 时按钮仍保持品牌蓝；主题定义了 token 时自动采用主题色）。
  background: 'var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #2563eb))',
  color: 'var(--dsw-alias-label-inverted, #fff)',
  fontSize: 12,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}

const BUTTON_DISABLED: React.CSSProperties = { ...BUTTON, opacity: 0.6, cursor: 'default' }

const EMPTY: React.CSSProperties = { fontSize: 13, color: 'var(--dsw-alias-label-caption)', textAlign: 'center', padding: 24, gridColumn: '1 / -1' }

const BUTTON_SECONDARY: React.CSSProperties = {
  ...BUTTON,
  border: '1px solid var(--dsw-alias-border-l2)',
  background: 'transparent',
  color: 'var(--dsw-alias-label-secondary)',
}

const INSTALLED_CHIP: React.CSSProperties = {
  flex: 'none',
  padding: '1px 8px',
  borderRadius: 999,
  fontSize: 11,
  lineHeight: '18px',
  color: 'var(--dsw-alias-state-success-primary)',
  border: '1px solid var(--dsw-alias-state-success-primary)',
  whiteSpace: 'nowrap',
}

/** 本地徽标(本地发现技能与商店/共享库区分)。 */
const CHIP_LOCAL: React.CSSProperties = {
  flex: 'none',
  padding: '1px 8px',
  borderRadius: 999,
  fontSize: 11,
  lineHeight: '18px',
  color: 'var(--dsw-alias-label-secondary)',
  border: '1px solid var(--dsw-alias-border-l2)',
  whiteSpace: 'nowrap',
}

/** 审核中徽标。 */
const CHIP_PENDING: React.CSSProperties = {
  flex: 'none',
  padding: '1px 8px',
  borderRadius: 999,
  fontSize: 11,
  lineHeight: '18px',
  color: 'var(--dsw-alias-state-warn-label)',
  border: '1px solid var(--dsw-alias-state-warn-label)',
  whiteSpace: 'nowrap',
}

/** 已拒绝徽标。 */
const CHIP_REJECTED: React.CSSProperties = {
  flex: 'none',
  padding: '1px 8px',
  borderRadius: 999,
  fontSize: 11,
  lineHeight: '18px',
  color: 'var(--dsw-alias-state-error-primary)',
  border: '1px solid var(--dsw-alias-state-error-primary)',
  whiteSpace: 'nowrap',
}

/** 分区标题。 */
const SECTION_HEAD: React.CSSProperties = { margin: 0, fontSize: 13, fontWeight: 500, color: 'var(--dsw-alias-label-secondary)', padding: '0 0 4px' }

/** 通用徽标(共享库条目)。 */
const CHIP: React.CSSProperties = {
  flex: 'none',
  padding: '1px 8px',
  borderRadius: 999,
  fontSize: 11,
  lineHeight: '18px',
  color: 'var(--dsw-alias-state-success-primary)',
  border: '1px solid var(--dsw-alias-state-success-primary)',
  whiteSpace: 'nowrap',
}

/** 卡片底部操作区：分隔线 + 按钮（版本/作者信息并入描述下方，不再单独占用一行）。 */
const CARD_FOOT: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  marginTop: 'auto',
  paddingTop: 10,
  borderTop: '1px solid var(--dsw-alias-border-l)',
}

const NOTICE: React.CSSProperties = { fontSize: 13, margin: 0, textAlign: 'center', padding: 12 }

/** Per-skill action feedback: which skill is busy and the outcome. */
interface ActionState {
  name: string
  kind: 'installing' | 'uninstalling' | 'uploading' | 'done-install' | 'done-uninstall' | 'done-upload' | 'failed'
  /** Which action failed (for the failure notice copy). */
  failedKind?: 'install' | 'uninstall' | 'upload' | undefined
  error?: string | undefined
}

/**
 * Skill center modal: the gateway's skill store catalog with an install /
 * uninstall action per skill, fetched through the host's local proxy.
 * Installed state comes from the host (`installed` names in the catalog
 * response) and is kept in sync locally after each action.
 * Esc closes the modal; focus moves into the panel on open.
 * @param props.onClose - close the modal.
 */
export function SkillCenterPanel({ onClose }: { onClose: () => void }) {
  const [skills, setSkills] = useState<Skill[] | null>(null)   // marketplace (授权制)
  const [shared, setShared] = useState<SharedSkill[]>([])      // shared-skills approved+own
  const [local, setLocal] = useState<LocalSkill[]>([])         // disk skills + upload state
  const [installed, setInstalled] = useState<ReadonlySet<string>>(new Set())
  const [error, setError] = useState('')
  const [action, setAction] = useState<ActionState | null>(null)
  const [loading, setLoading] = useState(true)
  /** 待确认卸载的技能名（面板内确认条，替代原生 window.confirm）。 */
  const [confirmName, setConfirmName] = useState<string | null>(null)
  // fetch sequence guard: only the newest load may write state (retry can
  // race the initial load).
  const loadSeqRef = useRef(0)
  const panelRef = useRef<HTMLDivElement | null>(null)

  // UX-3: load errors must be retryable — a transient failure previously
  // left the panel stuck on an error line with no way back but reopen.
  const loadSkills = (): void => {
    const seq = ++loadSeqRef.current
    setLoading(true)
    setError('')
    Promise.all([
      fetch('/api/pico/skills').then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${String(res.status)}`)
        return await res.json() as { skills?: Skill[]; installed?: string[] }
      }),
      fetch('/api/pico/shared-skills').then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${String(res.status)}`)
        return await res.json() as { skills?: SharedSkill[]; installed?: string[]; local?: LocalSkill[] }
      }),
    ]).then(([market, sharedData]) => {
        if (seq !== loadSeqRef.current) return
        setSkills(market.skills ?? [])
        setShared(sharedData.skills ?? [])
        setLocal(sharedData.local ?? [])
        // installed 合并两个数据源(商城 installed + 本地存在的)
        setInstalled(new Set([...(market.installed ?? []), ...(sharedData.installed ?? [])]))
        setLoading(false)
      })
      .catch(() => {
        if (seq !== loadSeqRef.current) return
        setError(t('skill.loadError'))
        setLoading(false)
      })
  }

  useEffect(() => {
    loadSkills()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Esc closes; initial focus lands on the panel so keyboard users can act.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    panelRef.current?.focus()
    return () => { window.removeEventListener('keydown', onKey) }
  }, [onClose])

  const install = async (name: string): Promise<void> => {
    if (action !== null && (action.kind === 'installing' || action.kind === 'uninstalling')) return
    setAction({ name, kind: 'installing' })
    try {
      const res = await fetch(`/api/pico/skills/${encodeURIComponent(name)}/install`, { method: 'POST' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error((data as { error?: string }).error ?? `HTTP ${String(res.status)}`)
      }
      setInstalled(prev => new Set(prev).add(name))
      setAction({ name, kind: 'done-install' })
    } catch (cause) {
      setAction({ name, kind: 'failed', failedKind: 'install', error: cause instanceof Error ? cause.message : undefined })
    }
  }

  const uninstall = async (name: string): Promise<void> => {
    if (action !== null && (action.kind === 'installing' || action.kind === 'uninstalling')) return
    // UX-3: an uninstall is one-click destructive — confirm inline (replacing
    // the blocking window.confirm) so a misclick does not remove a skill
    // silently and the panel stays keyboard/assistive-friendly.
    const target = confirmName === name ? name : null
    if (target === null) {
      setConfirmName(name)
      return
    }
    setConfirmName(null)
    setAction({ name, kind: 'uninstalling' })
    try {
      const res = await fetch(`/api/pico/skills/${encodeURIComponent(name)}/uninstall`, { method: 'POST' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error((data as { error?: string }).error ?? `HTTP ${String(res.status)}`)
      }
      setInstalled(prev => {
        const next = new Set(prev)
        next.delete(name)
        return next
      })
      setAction({ name, kind: 'done-uninstall' })
    } catch (cause) {
      setAction({ name, kind: 'failed', failedKind: 'uninstall', error: cause instanceof Error ? cause.message : undefined })
    }
  }

  /** Upload a local skill to the shared store (starts review). */
  const upload = async (name: string): Promise<void> => {
    if (action !== null) return
    setAction({ name, kind: 'uploading' })
    try {
      const res = await fetch('/api/pico/shared-skills/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error((data as { error?: string }).error ?? `HTTP ${String(res.status)}`)
      }
      setAction({ name, kind: 'done-upload' })
    } catch (cause) {
      setAction({ name, kind: 'failed', failedKind: 'upload', error: cause instanceof Error ? cause.message : undefined })
    }
    loadSkills()
  }

  /** Install (or update to) a shared-library version. */
  const installShared = async (name: string, version: string): Promise<void> => {
    if (action !== null) return
    setAction({ name, kind: 'installing' })
    try {
      const res = await fetch(`/api/pico/shared-skills/${encodeURIComponent(name)}/${encodeURIComponent(version)}/install`, { method: 'POST' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error((data as { error?: string }).error ?? `HTTP ${String(res.status)}`)
      }
      setInstalled(prev => new Set(prev).add(name))
      setAction({ name, kind: 'done-install' })
    } catch (cause) {
      setAction({ name, kind: 'failed', failedKind: 'install', error: cause instanceof Error ? cause.message : undefined })
    }
    loadSkills()
  }

  /** Highest approved version of a shared skill ('' when none). */
  const latestApproved = (name: string): SharedSkill | undefined => {
    const versions = shared.filter(s => s.name === name && s.status === 'approved')
    if (versions.length === 0) return undefined
    versions.sort((a, b) => (a.version.localeCompare(b.version, undefined, { numeric: true })))
    return versions[versions.length - 1]
  }

  /** Whether an installed local skill has a newer approved shared version. */
  const hasUpdate = (name: string): boolean => {
    if (!installed.has(name)) return false
    const latest = latestApproved(name)
    if (latest === undefined) return false
    return true // presence of an approved row for an installed skill ⇒ 可升级
  }

  let content: React.ReactNode
  if (error !== '') {
    content = (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: 24, gridColumn: '1 / -1' }}>
        <p style={EMPTY}>{error}</p>
        <button type="button" style={BUTTON_SECONDARY} onClick={() => { loadSkills() }}>
          {t('skill.retry')}
        </button>
      </div>
    )
  } else if (loading || skills === null) {
    content = (
      <div style={{ gridColumn: '1 / -1', display: 'flex', justifyContent: 'center', padding: 48 }}>
        <p style={EMPTY}>{t('skill.loading')}</p>
      </div>
    )
  } else if (skills === null || (skills.length === 0 && shared.length === 0 && local.length === 0)) {
    content = <p style={EMPTY}>{t('skill.empty')}</p>
  } else {
    const renderHeader = (text: string, count: number) => (
      <h3 style={{ ...SECTION_HEAD, gridColumn: '1 / -1' }}>{text}（{count}）</h3>
    )

    const renderLocalCard = (row: LocalSkill) => {
      const name = row.name
      const busy = action?.name === name && action.kind === 'uploading'
      const title = row.displayName ?? name
      return (
        <div key={`local-${name}`} className="pico-skill-card" style={CARD}>
          <div style={TITLE_ROW}>
            <span style={{ ...AVATAR, color: avatarColor(name), background: `color-mix(in srgb, ${avatarColor(name)} 14%, transparent)` }} aria-hidden="true">
              {name.charAt(0)}
            </span>
            <div style={NAME_COL}>
              <div style={NAME_WRAP}>
                <p style={{ ...NAME, ...NAME_TEXT }} title={title}>{title}</p>
                <span style={CHIP_LOCAL}>{t('skill.localBadge')}</span>
                {row.status === 'pending' && <span style={CHIP_PENDING}>{t('skill.reviewing')}</span>}
                {row.status === 'approved' && <span style={CHIP}>{t('skill.shared')}</span>}
                {row.status === 'rejected' && <span style={CHIP_REJECTED}>{t('skill.rejected')}</span>}
              </div>
              <p style={META}>{row.version !== undefined ? `v${row.version}` : t('skill.versionUnknown')}</p>
            </div>
          </div>
          {row.description !== undefined && row.description !== '' && <p style={DESC}>{row.description}</p>}
          {row.status === 'rejected' && row.reason !== undefined && row.reason !== '' && (
            <p style={{ ...META, color: 'var(--dsw-alias-state-error-primary)', whiteSpace: 'pre-wrap' }}>
              {t('skill.rejectReason', { reason: row.reason })}
            </p>
          )}
          <div style={CARD_FOOT}>
            {row.status === 'rejected'
              ? <button type="button" style={busy ? BUTTON_DISABLED : BUTTON_SECONDARY} disabled={busy} onClick={() => { void upload(name) }}>{t('skill.reupload')}</button>
              : row.status === 'pending'
                ? <span style={{ ...CHIP_PENDING, flex: 1, textAlign: 'center' }}>{t('skill.awaitingReview')}</span>
                : row.status === 'approved'
                  ? <span style={{ ...CHIP, flex: 1, textAlign: 'center' }}>{t('skill.sharedDone')}</span>
                  : <button type="button" style={busy ? BUTTON_DISABLED : BUTTON} disabled={busy} onClick={() => { void upload(name) }}>{t('skill.upload')}</button>}
          </div>
        </div>
      )
    }

    const renderSharedCard = (row: SharedSkill) => {
      const name = row.name
      const latest = latestApproved(name)
      const busy = action?.name === name && action.kind === 'installing'
      const isInstalled = installed.has(name)
      return (
        <div key={`shared-${name}-${row.version}`} className="pico-skill-card" style={CARD}>
          <div style={TITLE_ROW}>
            <span style={{ ...AVATAR, color: avatarColor(name), background: `color-mix(in srgb, ${avatarColor(name)} 14%, transparent)` }} aria-hidden="true">
              {name.charAt(0)}
            </span>
            <div style={NAME_COL}>
              <div style={NAME_WRAP}>
                <p style={{ ...NAME, ...NAME_TEXT }} title={row.display_name || name}>{row.display_name || name}</p>
                <span style={CHIP}>{t('skill.sharedBadge')}</span>
                {isInstalled && <span style={INSTALLED_CHIP}>{t('skill.installedBadge')}</span>}
              </div>
              <p style={META}>v{row.version}{row.author !== '' ? ` · ${row.author}` : ''}</p>
            </div>
          </div>
          {row.description !== '' && <p style={DESC}>{row.description}</p>}
          <div style={CARD_FOOT}>
            {isInstalled ? (
              latest !== undefined && latest.version !== row.version && hasUpdate(name)
                ? <button type="button" style={busy ? BUTTON_DISABLED : BUTTON} disabled={busy} onClick={() => { void installShared(name, latest.version) }}>{t('skill.update', { version: latest.version })}</button>
                : <span style={{ ...CHIP, flex: 1, textAlign: 'center' }}>{t('skill.installed')}</span>
            ) : (
              <button type="button" style={busy ? BUTTON_DISABLED : BUTTON} disabled={busy} onClick={() => { void installShared(name, row.version) }}>{t('skill.install')}</button>
            )}
          </div>
        </div>
      )
    }

    const renderMarketCard = (skill: Skill) => {
      const busy = action?.name === skill.name && (action.kind === 'installing' || action.kind === 'uninstalling')
      const isInstalled = installed.has(skill.name)
      return (
        <div key={skill.name} className="pico-skill-card" style={CARD}>
          <div style={TITLE_ROW}>
            <span style={{ ...AVATAR, color: avatarColor(skill.name), background: `color-mix(in srgb, ${avatarColor(skill.name)} 14%, transparent)` }} aria-hidden="true">
              {skill.name.charAt(0)}
            </span>
            <div style={NAME_COL}>
              <div style={NAME_WRAP}>
                <p style={{ ...NAME, ...NAME_TEXT }} title={skill.name}>{skill.name}</p>
                {isInstalled && <span style={INSTALLED_CHIP}>{t('skill.installedBadge')}</span>}
              </div>
              <p style={META}>v{skill.version}{skill.author !== '' ? ` · ${skill.author}` : ''}</p>
            </div>
          </div>
          {skill.description !== '' && <p style={DESC}>{skill.description}</p>}
          <div style={CARD_FOOT}>
            {isInstalled ? (
              confirmName === skill.name ? (
                <div style={{ display: 'flex', gap: 8, width: '100%' }}>
                  <button
                    type="button"
                    style={{ ...BUTTON, background: 'var(--dsw-alias-state-error-primary)', color: 'var(--dsw-alias-label-inverted, #fff)' }}
                    disabled={busy}
                    onClick={() => { void uninstall(skill.name) }}
                  >
                    {busy && action?.kind === 'uninstalling' ? t('skill.uninstalling') : t('skill.confirmUninstall')}
                  </button>
                  <button
                    type="button"
                    style={{ ...BUTTON_SECONDARY, flex: 1 }}
                    disabled={busy}
                    onClick={() => { setConfirmName(null) }}
                  >
                    {t('skill.cancel')}
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  style={busy ? BUTTON_DISABLED : BUTTON_SECONDARY}
                  disabled={busy}
                  onClick={() => { void uninstall(skill.name) }}
                >
                  {busy && action?.kind === 'uninstalling' ? t('skill.uninstalling') : t('skill.uninstall')}
                </button>
              )
            ) : (
              <button
                type="button"
                style={busy ? BUTTON_DISABLED : BUTTON}
                disabled={busy}
                onClick={() => { void install(skill.name) }}
              >
                {busy ? t('skill.installing') : t('skill.install')}
              </button>
            )}
          </div>
        </div>
      )
    }

    content = (
      <>
        {local.length > 0 && (
          <>
            {renderHeader(t('skill.localSection'), local.length)}
            {local.map(renderLocalCard)}
          </>
        )}
        {shared.length > 0 && (
          <>
            {renderHeader(t('skill.sharedSection'), shared.length)}
            {shared.map(renderSharedCard)}
          </>
        )}
        {skills.length > 0 && (
          <>
            {renderHeader(t('skill.marketSection'), skills.length)}
            {skills.map(renderMarketCard)}
          </>
        )}
      </>
    )
  }

  return (
    <div style={OVERLAY} role="presentation">
      <div style={MASK} aria-hidden="true" onClick={onClose} />
      <div style={PANEL} role="dialog" aria-modal="true" aria-label={t('skill.title')} tabIndex={-1} ref={panelRef}>
        <div style={HEADER}>
          <h2 style={TITLE}>{t('skill.title')}</h2>
          <button type="button" style={CLOSE} onClick={onClose}>{t('skill.close')}</button>
        </div>
        <div style={BODY}>{content}</div>
        {action !== null && action.kind !== 'installing' && action.kind !== 'uninstalling' && action.kind !== 'uploading' && (
          <p style={{ ...NOTICE, color: action.kind === 'failed' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-success-primary)' }}>
            {action.kind === 'done-install'
              ? t('skill.installed', { name: action.name })
              : action.kind === 'done-uninstall'
                ? t('skill.uninstalled', { name: action.name })
                : action.kind === 'done-upload'
                  ? t('skill.uploaded', { name: action.name })
                  : action.failedKind === 'install'
                    ? action.error !== undefined && action.error !== ''
                      ? `${t('skill.failed')}：${action.error}`
                      : t('skill.failed')
                    : action.failedKind === 'upload'
                      ? action.error !== undefined && action.error !== ''
                        ? `${t('skill.uploadFail')}：${action.error}`
                        : t('skill.uploadFail')
                      : action.error !== undefined && action.error !== ''
                        ? `${t('skill.uninstallFailed')}：${action.error}`
                        : t('skill.uninstallFailed')}
          </p>
        )}
      </div>
    </div>
  )
}
