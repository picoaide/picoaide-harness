import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Card,
  Chip,
  EmptyState,
  IconTile,
  PANEL_GRID,
  PANEL_SEARCH,
  PANEL_TOOLBAR,
  PanelButton,
  PanelPage,
  SegmentedControl,
  icons,
} from '@picoaide/dsh-panel-surface/client'
import { t } from './locales.ts'
import { compareVersions } from './version-compare.ts'
import { builtinCardsForTab, planBuiltinCards, useBuiltinSkills, type BuiltinCard } from './BuiltinSkillsStrip.tsx'

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
 * - 同名冲突确认：安装前检测磁盘/installed 同名 → 弹「覆盖确认」（纯客户端交互）；
 * - 30s 静默轮询 + Tab focus trap（取旧 Agent 面板的更完善实现）。
 *
 * ⚠️ 安装端点**不带 `?force=1`**（R2-SK-5）：宿主按 pathname 分发、从不读这个参数，
 * 重装/更新靠安装器的"整树替换"语义；留一个宿主不读的参数面只会让人以为它能强制刷新。
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
  /** 质量(0059 起仅 featured;官方语义移交 official 属性)。 */
  quality?: '' | 'featured' | undefined
  /** 0059 官方:蓝标 + 仅管理员可上传(员工端更新禁用)。 */
  official?: boolean | undefined
  /** 市场排序评分(服务端计算 = calls*3+downloads),客户端直接按此排序。 */
  score?: number | undefined
  downloads?: number | undefined
  calls?: number | undefined
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
  /** 溯源（D6）：安装来源渠道（market/org）；本地原创时为空。 */
  originChannel?: string | undefined
  /** 溯源：来源应用 ID（即使用户改了目录名也能认出归属）。 */
  originAppId?: string | undefined
  /** 溯源：安装后内容被本地修改过。 */
  dirty?: boolean | undefined
  /** 运行时技能名（SKILL.md 的 name）；与 name 不同时需显式提示。 */
  runtimeName?: string | undefined
  /** 是否当前用户归属（2026-09-02 归属权：上传预检据此区分「我的」与「他人」同名）。 */
  isOwner?: boolean | undefined
}

/** 来源分区 tab(决策 2026-08-25:市场/组织合并为「市场」——仅 我的/市场)。 */
type SourceTab = 'mine' | 'market'
type TypeFilter = 'all' | CapabilityKind

/** 顶部 Tab 条：来源分区 + 类型筛选。 */
/**
 * 类型筛选片（全部 / 技能 / 智能体）。
 *
 * 只给几何：颜色与 `[data-active]` / `:hover` 反馈由共享样式表的 `.pico-chipbtn`
 * 负责 —— 颜色写进行内联样式就再也做不出悬停态（本仓的既定分工）。
 */
const FILTER: React.CSSProperties = {
  padding: '3px 11px',
  fontSize: 12,
  borderRadius: 999,
  margin: 0,
}



/** 网格里的一张能力卡（纵向排布，动作条贴底）。 */
const CARD: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: '14px 15px',
  borderRadius: 14,
}

const TITLE_ROW: React.CSSProperties = { display: 'flex', alignItems: 'flex-start', gap: 8, minWidth: 0 }
const NAME: React.CSSProperties = { fontSize: 14, fontWeight: 600, margin: 0, color: 'var(--dsw-alias-label-primary)', lineHeight: '20px' }
const META: React.CSSProperties = { fontSize: 12, color: 'var(--dsw-alias-label-caption)', margin: 0, lineHeight: '16px' }
const DESC: React.CSSProperties = {
  fontSize: 12,
  lineHeight: '18px',
  margin: 0,
  color: 'var(--dsw-alias-label-secondary)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  cursor: 'pointer',
}

/**
 * 卡片里的描述：**固定两行**。
 *
 * 2026-09-20 用户口径：「能力中心里描述超长」—— 原来是三行 + 点击就地展开，展开后
 * 卡片变高、把整行栅格一起撑开，同一行相邻卡片出现大片空白。现在卡片里只留两行，
 * **全文去详情弹层看**（网格高度恒定）。
 */
const DESC_CLAMP: React.CSSProperties = {
  ...DESC,
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
}

// 头像底色：直接用**会随主题翻转**的 alias token。
// 2026-09-16 审计：原先写成 `var(--dsw-static-deepseek-5, var(--dsw-alias-brand-primary))`
// 这种两层写法，外层名字在上游**不存在**（静态色板是 100/400/500 这类三位刻度，
// 没有 `-5`）⇒ 永远落到内层 alias，等于白写一层；直接写内层才是可读的真源，
// 也避免"看着像静态色、实际是主题色"的误导。
const AVATAR_COLORS = [
  'var(--dsw-alias-brand-primary)',
  'var(--dsw-alias-state-success-primary)',
  'var(--dsw-alias-state-warn-label)',
  'var(--dsw-alias-label-tertiary)',
]

/** 按名称+类型确定头像颜色（稳定；导出供单测）。 */
export function avatarColor(name: string): string {
  if (name === '') return AVATAR_COLORS[0] ?? 'var(--dsw-alias-brand-primary)'
  let hash = 0
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) >>> 0
  return AVATAR_COLORS[hash % AVATAR_COLORS.length] ?? AVATAR_COLORS[0]!
}

const NAME_COL: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }
const NAME_WRAP: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flexWrap: 'wrap' }
const CARD_FOOT: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  marginTop: 'auto',
  paddingTop: 10,
  borderTop: '1px solid var(--dsw-alias-border-l1)',
}

/** 自制徽章(紫, 与官方蓝/来源灰区分)。 */
// 自制/本地来源徽章：原先写死紫色 #7C3AED，两主题同值 —— 暗色下面板底
// (bg-layer-2 = rgb(44,44,46)) 上只有 2.45:1（2026-09-16 暗色审计）。
// 上游没有紫色语义 token，改用会翻转的三级文字色，靠文案「自制」区分来源。

/**
 * 单测用：数值感知版本比较 —— 实现已抽到 `version-compare.ts`（内置技能区
 * BuiltinSkillsStrip 也要用它，而 panel 渲染 strip，反向 import 会成环）。
 * 这里 re-export 保持既有调用面不变。
 */
export { compareVersions } from './version-compare.ts'

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

/**
 * 「哪个 tab 显示哪些条目」的唯一实现（2026-09-15 抽出，行为不变）。
 *
 * 决策 2026-08-25：**卡片唯一位置** —— 本地创作只在「我的」，来源条目（市场/组织）
 * 只在「市场」；已安装的来源条目同时出现在「我的」（便于卸载/更新）。
 * 这条规则是"作者上传完在「我的」看不到安装按钮"的原因（本地卡只管上传），
 * 抽出来是为了让回归用例能钉住它，而不是让后来者以为是 bug 随手改掉。
 */
export function itemsForTab<T extends { source?: string, installed?: boolean }>(items: readonly T[], tab: 'mine' | 'market'): T[] {
  return tab === 'market'
    ? items.filter(i => i.source !== 'local')
    : items.filter(i => i.source === 'local' || i.installed === true)
}

/** 单测用：按（kind, source）解析安装端点。
 * 市场技能只存在于服务端 skills/marketplace 表,必须走 /api/pico/skills 代理
 * (网关 marketplace /archive);共享技能走 shared-skills 代理(带版本);
 * 智能体走 agent-presets 代理。合并面板时(57aeffecbb)曾把市场技能误路由
 * 到 shared-skills 端点 → 网关 404 → 面板「操作失败:gateway error」。
 *
 * ⚠️ 端点**不带 query 参数**（R2-SK-5）：宿主按 pathname 分发（auth-gate），
 * 从不读 `?force=1`；"覆盖已装同名内容"是**客户端确认条**决定要不要发这一发请求
 * （见 `install()` 的 installConfirmKey），不是一个服务端开关。此前拼上的
 * `?force=1` 是死面：谁都没读它，却让人以为宿主支持"强制刷新"。
 */
export function installEndpoint(item: CapabilityItem, version: string): string {
  let base: string
  if (item.kind === 'skill') {
    base = item.source === 'market'
      ? `/api/pico/skills/${encodeURIComponent(item.name)}/install`
      : `/api/pico/shared-skills/${encodeURIComponent(item.name)}/${encodeURIComponent(version)}/install`
  } else {
    base = `/api/pico/agent-presets/${encodeURIComponent(item.name)}/install`
  }
  return base
}

/** 分区里的一条可见卡：内置入口卡（builtin）或普通条目卡（item）。 */
export type SectionCard =
  | { type: 'builtin'; card: BuiltinCard }
  | { type: 'item'; item: CapabilityItem }

/**
 * 「我的」分区最终渲染的卡片清单（**唯一真源**：渲染层只做 map，不再自己拼数组）。
 *
 * 去重口径（R2-SK-6）：内置入口已经为某个技能出卡（「安装」或「更新到 vX」）时，
 * 本机技能库里那张**同名技能**普通卡不再渲染 —— 否则"可更新"的技能会在「我的」里
 * 显示两张卡：一张 `[更新到 v1.1.0]`，另一张是 provenance=builtin 的本地卡（页脚
 * 还带一个误导性的 `[上传]`）。planBuiltinCards 只处理了"已装且同版本不出卡"，
 * 可更新这一档两张都出。
 *
 * 只吞 `kind === 'skill'` 的同名项：技能与智能体允许同名（复合键语义），不能互相吞。
 * 顺序不变：内置卡在前（平台自带、数量少），其余保持调用方给出的既有排序。
 *
 * 变异验证：去掉这里的过滤（回到 `[...builtinCards, ...rows]` 直接拼接）⇒
 * `capability-center-panel.spec.ts` 的「同一技能只出一张卡（数量断言）」必红。
 */
export function planSectionCards(options: {
  rows: readonly CapabilityItem[]
  builtinCards: readonly BuiltinCard[]
}): SectionCard[] {
  const claimed = new Set(options.builtinCards.map(card => card.skill.name))
  const rows = options.rows.filter(item => item.kind !== 'skill' || !claimed.has(item.name))
  return [
    ...options.builtinCards.map(card => ({ type: 'builtin' as const, card })),
    ...rows.map(item => ({ type: 'item' as const, item })),
  ]
}

/** 单测用：按（kind, source）解析卸载端点(与安装同一来源规则)。 */
export function uninstallEndpoint(item: CapabilityItem, version: string): string {
  if (item.kind === 'skill') {
    return item.source === 'market'
      ? `/api/pico/skills/${encodeURIComponent(item.name)}/uninstall`
      : `/api/pico/shared-skills/${encodeURIComponent(item.name)}/${encodeURIComponent(version)}/uninstall`
  }
  return `/api/pico/agent-presets/${encodeURIComponent(item.name)}/uninstall`
}

/**
 * 上传预检撞上同名内容时的提示文案（**必须走字典**）。
 *
 * 抽成纯函数的原因与 connectors 的 `status-label.ts` 相同：文案取自模块级
 * `t()`，只有"切语言后跟着变"这种断言才有判别力 —— 写成硬编码字符串时，
 * 渲染测试照样全绿（2026-09-16 审计：本文件已用 t() 74 次，只有这一条漏网，
 * 英文界面下整句是中文）。
 * @param displayName - 占用该名称的条目展示名（调用方已回退到 name）。
 * @returns 当前界面语言下的提示文案。
 */
export function nameTakenError(displayName: string): string {
  return t('capability.nameTaken', { name: displayName })
}

/** 单测用：把同名（kind+name）条目归并成一张卡（保留最高 approved 版本为当前）。 */
export function mergeItems(items: readonly CapabilityItem[]): CapabilityItem[] {
  const byKey = new Map<string, CapabilityItem>()
  // 决策 2026-08-25(市场/组织合并) + bug 修复:同名 (kind+name) 归并时
  // (a) 展示行保留 market 来源(市场优先,跨源同名的权威行);
  // (b) displayName/description 取「较新」的(非空优先,避免 market 行
  //      覆盖 org 的中文标题);
  // (c) version 展示最高 approved(与来源无关的版本事实),installed 等
  //      状态保留现有逻辑。
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
    // 展示行来源:market 优先(跨源同名权威);否则保留已有。
    const source = existing.source === 'market' || item.source === 'market' ? 'market' : existing.source
    // displayName/description:非空优先(market 常与 name 同值,org 常带中文标题)。
    const displayName = (item.displayName && item.displayName !== item.name) ? item.displayName : existing.displayName
    const description = (item.description && item.description !== '') ? item.description : existing.description
    byKey.set(key, { ...existing, source, displayName, description, version: display, versions: sorted })
  }
  return [...byKey.values()]
}

/**
 * 详情弹层的目标：普通条目（能力中心聚合面的行）或内置技能入口卡。
 *
 * 两者都进同一个弹层 —— 用户看到的差异只是"徽章不同、动作不同"，弹层形状与
 * 交互不该因此分叉。
 */
type DetailTarget =
  | { kind: 'item', item: CapabilityItem }
  | { kind: 'builtin', card: BuiltinCard }

/** 弹层骨架的几何（颜色由 `.pico-card` / 共享按钮类负责）。 */
const DIALOG_MASK: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 60,
  background: 'var(--dsw-alias-bg-mask-1)',
  backdropFilter: 'var(--dsw-mask-blur)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 24,
}

const DIALOG_BOX: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  width: 'min(640px, 100%)',
  maxHeight: 'min(78vh, 720px)',
  borderRadius: 18,
  padding: '18px 20px',
  boxShadow: 'var(--dsw-shadow-lv3)',
  // 弹层容器是**程序化聚焦**的（给读屏一个上下文锚点），不是用户 Tab 过来的 ——
  // 保留 Chromium 的默认焦点环会在弹层外圈画一道很重的黑框（截图实测）。
  outline: 'none',
}

/**
 * 描述全文 + 历史版本的详情弹层。
 *
 * 存在的理由只有一条：**卡片里的描述必须定高**。把全文做成就地展开会把网格整行
 * 撑高，相邻卡片出现大片空白（用户报的"描述超长"）；弹层里则可以随便长，还能
 * 顺带放下历史版本与状态说明。
 *
 * 交互：Esc 关闭、点遮罩关闭、初始焦点落进弹层。**Esc 必须由弹层自己处理** ——
 * 面板是整页不是模态，装载器的 Esc 在检测到 `[role=dialog][aria-modal=true]`
 * 时会让位（"面板里开着真模态时 Esc 归模态"）。
 * @param props - 目标、忙碌态、按版本安装回调与关闭回调。
 */
export function CapabilityDetailDialog({ target, busy, onInstallVersion, onClose }: {
  target: DetailTarget
  busy: boolean
  onInstallVersion: (version: string) => void
  onClose: () => void
}): JSX.Element {
  const boxRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      // 不让这次 Esc 冒到面板装载器（那里会"返回聊天"）。
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey)
    boxRef.current?.focus()
    return () => { window.removeEventListener('keydown', onKey) }
  }, [onClose])

  const skill = target.kind === 'builtin' ? target.card.skill : undefined
  const item = target.kind === 'item' ? target.item : undefined
  const title = skill !== undefined
    ? (skill.title !== undefined && skill.title !== '' ? skill.title : skill.name)
    : (item!.displayName || item!.name)
  const description = skill !== undefined ? (skill.description ?? '') : item!.description
  const meta = skill !== undefined
    ? `v${skill.version}${skill.author !== undefined && skill.author !== '' ? ` · ${skill.author}` : ''}`
    : `v${item!.version}${item!.author !== '' ? ` · ${item!.author}` : ''}`
  const versions = item !== undefined && item.source !== 'local' ? item.versions : []

  return (
    <div
      style={DIALOG_MASK}
      role="presentation"
      onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}
    >
      <Card
        ref={boxRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`${t('capability.detail')} ${title}`}
        style={DIALOG_BOX}
        data-role="capability-detail"
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <IconTile size={38} radius={12} tone="brand" label={(skill?.name ?? item!.name).charAt(0)} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={NAME_WRAP}>
              <p style={{ ...NAME, whiteSpace: 'normal' }}>{title}</p>
              {skill !== undefined && <Chip tone="neutral" plain>{t('capability.builtinBadge')}</Chip>}
            </div>
            <p style={META}>{meta}</p>
          </div>
          <PanelButton variant="ghost" size="sm" aria-label={t('capability.close')} onClick={onClose}>{'✕'}</PanelButton>
        </div>
        <div className="pico-scroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto', marginTop: 12 }}>
          <div style={{ ...LABEL_SM }}>{t('capability.detailDescription')}</div>
          <p style={{ ...DESC, whiteSpace: 'pre-wrap', marginTop: 4 }} data-role="detail-description">
            {description === '' ? t('capability.detailNoDescription') : description}
          </p>
          {versions.length > 1 && (
            <div style={{ marginTop: 14 }}>
              <div style={{ ...LABEL_SM }}>{t('capability.viewVersions', { count: String(versions.length) })}</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                {versions.map(version => (
                  <PanelButton
                    key={version}
                    variant={version === item!.version ? 'primary' : 'secondary'}
                    size="sm"
                    disabled={busy}
                    onClick={() => { onInstallVersion(version) }}
                  >
                    v{version}
                  </PanelButton>
                ))}
              </div>
            </div>
          )}
        </div>
      </Card>
    </div>
  )
}

/** 弹层里的小节标题。 */
const LABEL_SM: React.CSSProperties = { fontSize: 12, color: 'var(--dsw-alias-label-caption)' }

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
  const [search, setSearch] = useState('')
  // 平台内置技能：与普通技能**同一张卡片、同一个网格**（2026-09-18 用户口径：
  // "这里渲染应该是一个普通技能，而不是这种置顶的"）。
  // 已安装的那些**不在这里渲染** —— 它们本来就在「我的」列表里（本机技能库扫描
  // 出来的普通卡片，带「平台内置」来源徽章）；重复渲染会让同一个技能出现两张卡。
  // 装成功后刷新分区，让普通卡片立刻出现、这张"安装入口"卡片同时消失。
  const builtin = useBuiltinSkills(() => { loadAllRef.current?.() })
  const loadAllRef = useRef<(() => void) | null>(null)
  const [items, setItems] = useState<CapabilityItem[]>([])
  const [sections, setSections] = useState<Record<string, SectionState>>({})
  const [action, setAction] = useState<ActionState | null>(null)
  /** 安装覆盖确认 key（{kind}:{name}）；与卸载确认分离，避免互串。 */
  const [installConfirmKey, setInstallConfirmKey] = useState<string | null>(null)
  /** 卸载确认 key（{kind}:{name}）。 */
  const [uninstallConfirmKey, setUninstallConfirmKey] = useState<string | null>(null)
  /**
   * 正在看详情的那张卡；null = 关闭。
   *
   * 描述全文与历史版本都收在弹层里，**卡片本身高度恒定**（就地展开会把整行栅格
   * 一起撑高，2026-09-20 用户口径："能力中心里描述超长"）。
   */
  const [detail, setDetail] = useState<DetailTarget | null>(null)
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
    // 决策 2026-08-25:市场/组织合并为「市场」——?source=market 由服务端
    // 合并返回(市场+组织,各自 source 徽章保留);「我的」仍走 local。
    // loading 由两个分区各自的状态驱动（renderSection 按 tab 显示对应分区
    // 的 loading/错误/空态）；此处不再翻转全局 loading。
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
        // 后台刷新成功即退出先前 error 态——否则首次加载失败后,错误提示与
        // 重试按钮会遮住已刷新的数据(2026-09-01 深挖)。
        setSection('market', { status: 'ok', error: '' })
      }).catch(() => {})
    }, 30000)
    return () => { clearInterval(timer) }
  }, [])

  const install = async (item: CapabilityItem, opts?: { force?: boolean; version?: string }): Promise<void> => {
    if (action !== null && (action.kind === 'installing' || action.kind === 'uninstalling' || action.kind === 'uploading')) return
    const key = `${item.kind}:${item.name}`
    // 同名冲突确认（磁盘/installed 已有同名目录且用户还没确认）。`force` 只表示
    // "用户已在确认条上点过覆盖" —— 它**不进 URL**（宿主不读 `?force=1`，R2-SK-5），
    // 安装器本身就是整树替换语义。
    if (!opts?.force && (item.installed || (item.source !== 'local' && item.isLocal))) {
      setInstallConfirmKey(key)
      return
    }
    setInstallConfirmKey(null)
    setAction({ key, kind: 'installing' })
    try {
      const targetVersion = opts?.version ?? item.version
      const url = installEndpoint(item, targetVersion)
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
    if (uninstallConfirmKey !== key) { setUninstallConfirmKey(key); return }
    setUninstallConfirmKey(null)
    setAction({ key, kind: 'uninstalling' })
    try {
      const base = uninstallEndpoint(item, item.version)
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
    // 只拦进行中的动作（与 install/uninstall 守卫一致）；done-*/failed 是
    // 终态展示,不得阻断后续上传——此前 `action !== null` 会在动作终态后
    // 永久锁死「我的」分区的上传/重新上传按钮。
    if (action !== null && (action.kind === 'installing' || action.kind === 'uninstalling' || action.kind === 'uploading')) return
    const key = `${item.kind}:${item.name}`
    // 归属权预检(2026-09-02):同名同类型已在能力中心存在且非本人归属 →
    // 不发送请求,直接提示「名称已被占用」。服务端仍是权威(他人待审行不可见,
    // 预检可能漏网,由 409 NAME_TAKEN「名称已被占用」兜底)。
    const clash = items.find(i => i.kind === item.kind && i.name === item.name && i.source !== 'local')
    if (clash !== undefined && clash.isOwner !== true) {
      setAction({
        key, kind: 'failed',
        error: nameTakenError(clash.displayName || clash.name),
        name: item.name,
      })
      return
    }
    setAction({ key, kind: 'uploading' })
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
      setAction({ key, kind: 'done-upload', name: item.name })
      loadAll()
    } catch (cause) {
      setAction({ key, kind: 'failed', error: cause instanceof Error ? cause.message : undefined, name: item.name })
    }
  }

  const visibleByTab = useMemo(() => {
    const base = itemsForTab(items, tab)
    const merged = mergeItems(base)
    // 搜索: name/displayName/description 关键词(大小写不敏感)。
    const q = search.trim().toLowerCase()
    const searched = q === '' ? merged : merged.filter(i =>
      (i.name ?? '').toLowerCase().includes(q)
      || (i.displayName ?? '').toLowerCase().includes(q)
      || (i.description ?? '').toLowerCase().includes(q),
    )
    const kindFiltered = filter === 'all' ? searched : searched.filter(i => i.kind === filter)
    // 0059 排序定案: 市场 = 官方→精选→score 降序;「我的」= 已安装(score 降序→名称),
    // 自制组在后(名称升序)。
    const sortScore = (a: CapabilityItem, b: CapabilityItem): number => (b.score ?? 0) - (a.score ?? 0)
    if (tab === 'market') {
      return [...kindFiltered].sort((a, b) => {
        if (!!a.official !== !!b.official) return a.official ? -1 : 1
        const af = a.quality === 'featured'; const bf = b.quality === 'featured'
        if (af !== bf) return af ? -1 : 1
        if (sortScore(a, b) !== 0) return sortScore(a, b)
        return a.name.localeCompare(b.name)
      })
    }
    return [...kindFiltered].sort((a, b) => {
      const aLocal = a.source === 'local'; const bLocal = b.source === 'local'
      if (aLocal !== bLocal) return aLocal ? 1 : -1
      return aLocal ? a.name.localeCompare(b.name) : (sortScore(a, b) !== 0 ? sortScore(a, b) : a.name.localeCompare(b.name))
    })
  }, [items, tab, filter, search])

  // 让内置技能的"安装成功"回调拿到最新的 loadAll（hook 在 loadAll 之前调用）。
  loadAllRef.current = loadAll

  const sectionStatus = (key: 'mine' | 'market'): SectionState => sections[key] ?? { status: 'idle', error: '' }

  const isMineSection = tab === 'mine'
  /** 本机技能库已有的技能名（含已安装的平台内置技能）—— 用来避免重复渲染。 */
  const localSkillNames = useMemo(
    () => new Set(items.filter(i => i.kind === 'skill' && i.source === 'local').map(i => i.name)),
    [items],
  )
  const renderBadges = (item: CapabilityItem): React.ReactNode => {
    const statusBadge = item.status === 'pending' ? <Chip tone="warn">{t('capability.pending')}</Chip>
      : item.status === 'rejected' ? <Chip tone="danger">{t('capability.rejected')}</Chip>
        : item.installed ? <Chip tone="success">{t('capability.installed')}</Chip> : null
    const officialBadge = item.official === true ? <Chip tone="brand">{t('capability.official')}</Chip> : null
    const qualityBadge = item.quality === 'featured' ? <Chip tone="warn">{t('capability.featured')}</Chip> : null
    /**
     * 「来源」徽章**只出一个**。
     *
     * 2026-09-20 修的真实 UI bug：原先「我的」分区同时渲染 `source` 徽章与
     * `mineSourceBadge`，匿名路径下两张都写「自制」—— 卡片上出现两个一模一样的胶囊。
     * 现在按分区二选一：市场分区用来源（市场/组织），我的分区用「这份内容是怎么来的」
     * （自制 / 来自组织 / 平台内置 / 来自市场 / 其它）。
     */
    const sourceBadge = isMineSection
      ? (item.source === 'local'
          ? <Chip tone="neutral" plain>{t('capability.sourceLocal')}</Chip>
          : item.originChannel === 'org'
            ? <Chip tone="neutral" plain>{t('capability.sourceOrg')}</Chip>
            : item.originChannel === 'builtin'
              ? <Chip tone="neutral" plain>{t('capability.sourceBuiltin')}</Chip>
              : item.originChannel === 'market'
                ? <Chip tone="neutral" plain>{t('capability.sourceMarket')}</Chip>
                : <Chip tone="neutral" plain>{t('capability.sourceOther')}</Chip>)
      : (item.source === 'market'
          ? <Chip tone="neutral" plain>{t('capability.sourceMarket')}</Chip>
          : item.source === 'org'
            ? <Chip tone="neutral" plain>{t('capability.sourceOrg')}</Chip>
            : <Chip tone="neutral" plain>{t('capability.sourceLocal')}</Chip>)
    return (
      <>
        <Chip tone={item.kind === 'skill' ? 'brand' : 'neutral'}>
          {item.kind === 'skill' ? t('capability.typeSkill') : t('capability.typeAgent')}
        </Chip>
        {sourceBadge}
        {officialBadge}
        {qualityBadge}
        {statusBadge}
        {item.source === 'local' && item.originChannel !== undefined && item.originChannel !== 'builtin' && (
          <Chip tone="neutral" plain>{`v${item.version}`}</Chip>
        )}
        {item.dirty === true && <Chip tone="warn">{t('capability.dirty')}</Chip>}
      </>
    )
  }

  /**
   * 内置技能卡 → 与普通技能同构的卡片（同一套 CARD / 标题行 / 徽章 / 页脚按钮）。
   *
   * 判定全部由 `planBuiltinCards` 做完（含"已装且清单更新 ⇒ 出更新卡"，R1-pm-8）：
   * 这里只按它给出的 `action` / `state` / `endpoint` 渲染，不再自己算一遍
   * ——两处各判一次就会出现"卡片渲染了但没有按钮"这种死代码。
   */
  const renderBuiltinCard = (card: BuiltinCard): React.ReactNode => {
    const skill = card.skill
    const key = `builtin:${skill.name}`
    const label = card.action === 'update'
      ? t('capability.updateTo', { version: skill.version })
      : t('capability.builtinInstall')
    const title = skill.title !== undefined && skill.title !== '' ? skill.title : skill.name
    return (
      <Card key={key} interactive style={CARD} className="pico-skill-card">
        <div style={TITLE_ROW}>
          <IconTile size={38} radius={12} tone="brand" label={skill.name.charAt(0)} />
          <div style={NAME_COL}>
            <div style={NAME_WRAP}>
              <p style={{ ...NAME }} title={title}>{title}</p>
              <Chip tone="neutral" plain>{t('capability.builtinBadge')}</Chip>
              <Chip tone="brand">{t('capability.filterSkill')}</Chip>
            </div>
            <p style={META}>{skill.author !== undefined && skill.author !== '' ? `v${skill.version} · ${skill.author}` : `v${skill.version}`}</p>
          </div>
        </div>
        {skill.description !== undefined && skill.description !== '' && (
          <p style={DESC_CLAMP} title={skill.description} data-role="card-description">{skill.description}</p>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
          <PanelButton
            variant="ghost"
            size="sm"
            icon={<icons.IconInfo size={13} />}
            onClick={() => { setDetail({ kind: 'builtin', card }) }}
          >
            {t('capability.detail')}
          </PanelButton>
        </div>
        <div style={CARD_FOOT}>
          {card.state === 'busy' ? (
            <PanelButton variant="primary" size="md" block disabled>{label}</PanelButton>
          ) : card.state === 'failed' && card.failure !== null ? (
            <>
              <span style={{ ...META, flex: 1, color: 'var(--dsw-alias-state-error-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={card.failure}>
                {card.failure}
              </span>
              <PanelButton variant="primary" size="md" onClick={() => { void builtin.install(skill) }}>
                {t('capability.builtinRetry')}
              </PanelButton>
            </>
          ) : (
            <PanelButton variant="primary" size="md" block onClick={() => { void builtin.install(skill) }}>{label}</PanelButton>
          )}
        </div>
      </Card>
    )
  }

  const renderCard = (item: CapabilityItem): React.ReactNode => {
    const key = `${item.kind}:${item.name}`
    const busy = action?.key === key && (action.kind === 'installing' || action.kind === 'uninstalling' || action.kind === 'uploading')
    const title = item.displayName || item.name
    const isLocal = item.source === 'local'
    const needUpdate = hasUpdateFor(item)
    return (
      <Card key={key} interactive muted={item.status === 'rejected'} style={CARD} className="pico-skill-card">
        <div style={TITLE_ROW}>
          <IconTile size={38} radius={12} tone={item.kind === 'skill' ? 'brand' : 'neutral'} label={item.name.charAt(0)} />
          <div style={NAME_COL}>
            <div style={NAME_WRAP}>
              <p style={{ ...NAME }} title={title}>{title}</p>
              {renderBadges(item)}
            </div>
            <p style={META}>
              {item.author !== '' ? `v${item.version} · ${item.author}` : `v${item.version}`}
              {/* 运行时名与应用 ID 不一致时显式提示：模型里要 @ 的是运行时名，
                  此前用户只能装完才发现（如 workspace-cli → dws）。 */}
              {item.runtimeName !== undefined && item.runtimeName !== '' && item.runtimeName !== item.name
                ? ` · ${t('capability.runtimeName')}: ${item.runtimeName}`
                : ''}
            </p>
          </div>
        </div>
        {item.description !== '' && (
          <p style={DESC_CLAMP} title={item.description} data-role="card-description">{item.description}</p>
        )}
        {item.status === 'rejected' && item.reason !== undefined && item.reason !== '' && (
          <p style={{ ...META, color: 'var(--dsw-alias-state-error-primary)', whiteSpace: 'pre-wrap' }}>{t('capability.rejectReason', { reason: item.reason })}</p>
        )}
        <div style={CARD_FOOT}>
          {isLocal ? (
            item.uploadStatus === 'rejected'
              ? <PanelButton variant="secondary" size="md" block disabled={busy} onClick={() => { void upload(item) }}>{t('capability.reupload')}</PanelButton>
              : item.uploadStatus === 'pending'
                ? <span style={{ flex: 1, display: 'flex', justifyContent: 'center' }}><Chip tone="warn">{t('capability.awaitingReview')}</Chip></span>
                : item.uploadStatus === 'approved'
                  ? <span style={{ flex: 1, display: 'flex', justifyContent: 'center' }}><Chip tone="success">{t('capability.approved')}</Chip></span>
                  : <PanelButton variant="primary" size="md" block disabled={busy} onClick={() => { void upload(item) }}>{t('capability.upload')}</PanelButton>
          ) : item.installed ? (
            needUpdate ? (
              <PanelButton variant="primary" size="md" block disabled={busy || item.official} title={item.official ? t('capability.officialLocked') : undefined} onClick={() => { void install(item, { force: true }) }}>
                {t('capability.updateTo', { version: item.versions[item.versions.length - 1] ?? item.version })}
              </PanelButton>
            ) : uninstallConfirmKey === key ? (
              <div style={{ display: 'flex', gap: 8, width: '100%' }}>
                <PanelButton variant="danger" size="md" style={{ flex: 1 }} disabled={busy} onClick={() => { void uninstall(item) }}>
                  {busy && action?.kind === 'uninstalling' ? t('capability.uninstalling') : t('capability.confirmUninstall')}
                </PanelButton>
                <PanelButton variant="secondary" size="md" style={{ flex: 1 }} disabled={busy} onClick={() => { setUninstallConfirmKey(null) }}>{t('capability.cancel')}</PanelButton>
              </div>
            ) : (
              <PanelButton variant="secondary" size="md" block disabled={busy} onClick={() => { void uninstall(item) }}>{t('capability.uninstall')}</PanelButton>
            )
          ) : (
            <PanelButton variant="primary" size="md" block disabled={busy} onClick={() => { void install(item) }}>{t('capability.install')}</PanelButton>
          )}
        </div>
        {/* 历史版本、描述全文都收在详情弹层里（就地展开会把整行栅格撑高）。 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
          <PanelButton variant="ghost" size="sm" icon={<icons.IconInfo size={13} />} onClick={() => { setDetail({ kind: 'item', item }) }}>
            {t('capability.detail')}
          </PanelButton>
          {!isLocal && item.versions.length > 1 && (
            <span style={{ ...META, margin: 0 }}>{t('capability.viewVersions', { count: String(item.versions.length) })}</span>
          )}
        </div>
      </Card>
    )
  }

  const renderEmpty = (text: string): React.ReactNode => (
    <div style={{ gridColumn: '1 / -1' }}>
      <EmptyState icon={<icons.IconCapability size={22} />} tone="neutral" title={text} />
    </div>
  )

  const renderSection = (key: 'mine' | 'market', emptyText: string): React.ReactNode => {
    const st = sectionStatus(key)
    // idle = 尚未发起加载(初始态),与 loading 同样显示 spinner;
    // error = 错误态 + 重试;ok/loading = 列表或继续等待(可见 byId 更新)。
    if (st.status === 'idle' || st.status === 'loading') {
      return <div style={{ gridColumn: '1 / -1' }}><EmptyState icon={<icons.IconRefresh size={22} />} title={t('capability.loading')} /></div>
    }
    if (st.status === 'error') {
      return (
        <div style={{ gridColumn: '1 / -1' }}>
          <EmptyState
            icon={<icons.IconAlert size={22} />}
            tone="danger"
            title={st.error}
            action={<PanelButton variant="secondary" size="md" onClick={() => { void loadAll() }}>{t('capability.retry')}</PanelButton>}
          />
        </div>
      )
    }
    const rows = visibleByTab
    /**
     * 内置技能按**动作**分派到两个分区（2026-09-20 用户口径：「默认没安装的应该在
     * 市场里看到，而不是在『我的』里」）：
     *   - **`install`（本机还没装）⇒ 「市场」**：它的语义与市场条目一样 ——
     *     "平台提供了、你可以装"，不属于"我的东西"；
     *   - **`update`（本机已装、清单有新版）⇒ 「我的」**：本机确实有这一份，
     *     只是要升级，属于"我的"里的动作。
     *
     * 出卡口径（含"已装且清单同版本 ⇒ 不出卡"）全在 `planBuiltinCards` 里；这里只按
     * 它给出的 `action` 分流，不再自己判定一次（两处各判一次就会出现"某张卡两个
     * 分区都不出"或"两张同名卡"）。
     */
    const builtinCards = builtinCardsForTab(planBuiltinCards({
      rows: builtin.rows,
      // 两个事实源取并集：服务端下发的 installed[] + 面板「我的」列表里的本地技能名。
      installedNames: new Set([...builtin.installed, ...localSkillNames]),
      // 本机已装版本（provenance 的安装时版本）——"已装且更旧"就靠它与清单版本对比。
      installedVersions: builtin.versions,
      query: search,
      kindFilter: filter,
      busy: builtin.busy,
      failed: builtin.failed,
    }), key)
    const cards = planSectionCards({ rows, builtinCards })
    if (cards.length === 0) {
      return renderEmpty(filter === 'all' ? emptyText : t('capability.emptyFilter'))
    }
    // 内置技能排在前面（数量少且是平台自带），其余按既有排序；同名技能的重复卡
    // 已在 planSectionCards 里去掉（R2-SK-6）——这里只做渲染，不再自己拼数组。
    return cards.map(card => (card.type === 'builtin' ? renderBuiltinCard(card.card) : renderCard(card.item)))
  }

  // 分区状态驱动内容;全局 loading 已移除(旧实现 setLoading(true) 后同步置
  // false,React 批处理下 spinner 不可见且掩盖分区错误)。
  const content = renderSection(tab === 'market' ? 'market' : 'mine', tab === 'market' ? t('capability.emptyMarket') : t('capability.emptyMine'))

  return (
    <div className="pico-capability" data-role="capability-page">
      <PanelPage
        icon={<icons.IconCapability size={16} />}
        title={t('capability.title')}
        subtitle={t('capability.subtitle')}
        backLabel={t('capability.backToChat')}
        onClose={onClose}
        width={1180}
        toolbar={(
          <div style={PANEL_TOOLBAR}>
            <SegmentedControl
              ariaLabel={t('capability.title')}
              value={tab}
              options={[
                { value: 'mine' as const, label: t('capability.tabMine') },
                { value: 'market' as const, label: t('capability.tabMarket') },
              ]}
              onChange={next => {
                setTab(next)
                setFilter('all')
                setInstallConfirmKey(null)
                setUninstallConfirmKey(null)
              }}
            />
            <span style={{ display: 'flex', gap: 4 }}>
              {(['all', 'skill', 'agent'] as const).map(f => (
                <button
                  key={f}
                  type="button"
                  className="pico-chipbtn"
                  data-active={filter === f ? 'true' : 'false'}
                  style={FILTER}
                  onClick={() => { setFilter(f) }}
                >
                  {f === 'all' ? t('capability.filterAll') : f === 'skill' ? t('capability.filterSkill') : t('capability.filterAgent')}
                </button>
              ))}
            </span>
            <span style={{ flex: 1 }} aria-hidden="true" />
            <input
              type="search"
              value={search}
              onChange={e => { setSearch(e.target.value) }}
              placeholder={t('capability.searchPlaceholder')}
              aria-label={t('capability.searchPlaceholder')}
              style={PANEL_SEARCH}
            />
          </div>
        )}
      >
        {installConfirmKey !== null && (
          <Card style={{ padding: '10px 14px', borderRadius: 12, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <icons.IconAlert size={15} style={{ color: 'var(--dsw-alias-state-warn-label)' }} />
            <span style={{ flex: 1, minWidth: 200, fontSize: 13 }}>
              {t('capability.conflictConfirm', { name: installConfirmKey.split(':')[1] ?? '' })}
            </span>
            <PanelButton variant="primary" size="sm" onClick={() => {
              const item = items.find(i => `${i.kind}:${i.name}` === installConfirmKey)
              setInstallConfirmKey(null)
              if (item !== undefined) void install(item, { force: true })
            }}>{t('capability.forceInstall')}</PanelButton>
            <PanelButton variant="secondary" size="sm" onClick={() => { setInstallConfirmKey(null) }}>{t('capability.cancel')}</PanelButton>
          </Card>
        )}
        {action !== null && action.kind !== 'installing' && action.kind !== 'uninstalling' && action.kind !== 'uploading' && (
          <Card style={{ padding: '9px 14px', borderRadius: 12, marginBottom: 12, fontSize: 13, color: action.kind === 'failed' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-success-primary)' }}>
            {action.kind === 'done-install'
              ? t('capability.installedName', { name: action.name ?? '' })
              : action.kind === 'done-uninstall'
                ? t('capability.uninstalledName', { name: action.name ?? '' })
                : action.kind === 'done-upload'
                  ? t('capability.uploadedName', { name: action.name ?? '' })
                  : t('capability.failed', { error: action.error ?? '' })}
          </Card>
        )}
        <div style={PANEL_GRID} data-role="capability-grid">{content}</div>
      </PanelPage>
      {detail !== null && (
        <CapabilityDetailDialog
          target={detail}
          busy={action?.key === (detail.kind === 'item' ? `${detail.item.kind}:${detail.item.name}` : `builtin:${detail.card.skill.name}`)}
          onInstallVersion={version => {
            if (detail.kind !== 'item') return
            void install(detail.item, { force: true, version })
          }}
          onClose={() => { setDetail(null) }}
        />
      )}
    </div>
  )
}
