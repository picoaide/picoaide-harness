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
  /**
   * 本机那一份的来源（宿主按磁盘上的 provenance 判定，审计 2026-09-23 A2/A3）：
   * `store` = 能力中心装的（更新/卸载直接做）；`local` = 本机自制或来源不明
   * （覆盖/删除前**必须**由用户确认，宿主也会在缺 `?overwrite=1` 时 409 拒绝）。
   */
  installedOrigin?: 'store' | 'local' | undefined
  /**
   * 本机那一份**能不能算作当前账号的**（宿主按服务端「我的」视图下发的归属判据，
   * 第六轮审计 R6-B-1）。
   *
   * 技能库/预设目录是**机器作用域**的（`<DSH_HOME>/skills`，不按账号分目录），
   * 而同机换账号是被支持的操作 ⇒ 磁盘上这一份可能是**别的账号**装的。宿主手里唯一
   * 能证明的事实是：服务端 `?source=own`（author-own 任意状态）里有没有同名同 kind
   * 的行 —— 有 ⇒ 这个名字属于当前账号（`'mine'`）；没有 ⇒ **证明不了**
   * （`'unknown'`：既可能是别人装的，也可能是我装的别人的内容）。
   *
   * 为什么**不发** `'other'`：宿主没有任何事实能证明"这一份是第三方装的"，编一个
   * 出来就是本条 finding 的同一个错（拿未知当已知）。
   *
   * 消费纪律（见 {@link isDelistedItem} 第 3 条）：只有 `'mine'` 才允许走"目录里没有
   * 它 ⇒ 判已下架"的推断，并因此给出**删除本机那一份**的动作；`'unknown'` 一律不判、
   * 不删（判据只回答"能不能从目录更新/上传"，不回答"这份内容还能不能用"）。
   */
  localOwnership?: 'mine' | 'unknown' | undefined
  /** 是否本地创作（「我的」分区用）。 */
  isLocal?: boolean | undefined
  /** 本地创作时是否有上传状态记录（无 = 未上传过）。 */
  uploadStatus?: ItemStatus | undefined
  /** 溯源（D6）：安装来源渠道（market/org）；本地原创时为空。 */
  originChannel?: string | undefined
  /** 溯源：来源应用 ID（即使用户改了目录名也能认出归属）。 */
  originAppId?: string | undefined
  /**
   * 溯源：来源**服务端**——只在"这一份是另一台服务端（另一个部署/租户）装的"时下发
   * （R17B-04）。此时宿主已把它按本机内容处理（更新/删除都要确认），面板只负责把
   * 事实说出来：同名同版本在别的服务端上"已安装"是假象，模型读的是上一租户的内容。
   */
  originServer?: string | undefined
  /** 溯源：安装后内容被本地修改过。 */
  dirty?: boolean | undefined
  /**
   * 本机那一份是库根里的**符号链接**（R17B-01）：运行时照旧加载它，但
   * `packSkill` 有意拒收链接形态（避免把链接目标里的库外文件打进上传包）⇒
   * 这一格不给「上传」按钮，只标"符号链接"。
   */
  originSymlink?: boolean | undefined
  /** 运行时技能名（SKILL.md 的 name）；与 name 不同时需显式提示。 */
  runtimeName?: string | undefined
  /**
   * 是否当前用户归属（2026-09-02 归属权：上传预检据此区分「我的」与「他人」同名）。
   *
   * **三态**（R5-B-2）：`true` = 服务端说归你；`false` = 服务端**明确**说不是你的
   * （归属被转走就是这一档）；`undefined` = 这一行没有下发该字段（本地磁盘行就是
   * 这种情况）—— 未知**不得**被当成"我的"（上传预检仍是 `!== true` 就拦住），
   * 也不得被当成"已转交"（没有事实就不下这个判词）。
   */
  isOwner?: boolean | undefined
  /**
   * 服务端行上的归属人账号（`is_owner === false` 时用来说明"转给谁了"）。
   *
   * ⚠️ **当前员工面契约里没有这个字段**（2026-09-23 核对 `server/internal/capabilities`：
   * `owner` 只在管理端的 `ApprovalRow` 上，员工面的 `CapabilityItem` 只有 `is_owner`）。
   * 保留它是因为"已转交"的**文案**（转给了谁）需要它：服务端一旦在员工面行上补
   * `owner`（json `owner`），客户端不需要再改（{@link isTransferredItem} 的判据仍以
   * `is_owner === false` 为主，本字段只用于显示）。缺省 = 未下发，不编造名字。
   */
  owner?: string | undefined
  /**
   * 服务端在**作者自己的行**上下发的下架标记（`server/internal/capabilities` 的
   * `CapabilityItem.Delisted`，json `delisted`；第五轮审计 R5-B-1 的权威字段）。
   *
   * 语义（服务端泳道的定义）：下架 = **不可分发**，但归属人自己的「我的」分区仍会
   * 返回该行并带 `delisted:true` —— 作者需要看到这个状态，否则管控动作在作者面
   * 没有任何反馈。分发面列出的行恒为 `false`。缺省 = 未下发（不得读成"上架"）。
   */
  delisted?: boolean | undefined
  /**
   * 上架标志（`apps.enabled`）的**兼容**读取口。
   *
   * ⚠️ 当前能力中心的员工面契约用的是 `delisted`（服务端 2026-09-23 定的字段），
   * **没有** `enabled`；这里保留是因为"目录行带 `apps.enabled`"是同一产品另一处
   * （应用中心 `AppCenterItem.enabled`）的既有形态 —— 一旦哪条目录行带它，判据立即
   * 生效，不用再改客户端。缺省是 `undefined` 而不是 `true`：能力中心没有"这一行默认
   * 上架"的知识，把未下发读成"上架"就是拿未知当可用（R5-B-1 的纪律）。
   */
  enabled?: boolean | undefined
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

/** 取数分区：市场（市场+组织合并结果）与我的。 */
export type SectionKey = 'mine' | 'market'

/**
 * 一次分区取数回来后如何并进现有列表（**唯一实现**）。
 *
 * 决策 2026-08-25：「市场」tab 承载 market+org 合并结果 —— 加载 market 时清除
 * 两源旧条目；「我的」只清 local（其余保留：`?source=local` 的载荷里同时带
 * 商店已装行与本机行）。
 *
 * 抽成纯函数是为了让「两种到达顺序」可被单测直接驱动（独立复审 2026-09-23 N1）：
 * 本包没有 jsdom/渲染测试面，而这条归约是两次并发取数唯一的合流点 —— 它在
 * `setItems` 的 updater 里时，谁也没法在没有 React 的情况下复现 market-first /
 * mine-first 两种到达顺序。
 * @param prev - 当前列表。
 * @param key - 回来的那个分区。
 * @param rows - 该分区的行。
 * @returns 合并后的列表。
 */
export function applySectionRows(
  prev: readonly CapabilityItem[],
  key: SectionKey,
  rows: readonly CapabilityItem[],
): CapabilityItem[] {
  const drop = key === 'market'
    ? (i: CapabilityItem) => i.source !== 'local'
    : (i: CapabilityItem) => i.source === 'local'
  return [...prev.filter(i => !drop(i)), ...rows]
}

/** 单测用：按（kind, source）解析安装端点。
 * 市场技能只存在于服务端 skills/marketplace 表,必须走 /api/pico/skills 代理
 * (网关 marketplace /archive);共享技能走 shared-skills 代理(带版本);
 * 智能体走 agent-presets 代理。合并面板时(57aeffecbb)曾把市场技能误路由
 * 到 shared-skills 端点 → 网关 404 → 面板「操作失败:gateway error」。
 *
 * ⚠️ 端点**本身不带 query 参数**（R2-SK-5）：路径由本函数拼，`?overwrite=1` 由
 * {@link withOverwrite} 在"用户已在确认条上确认过"之后加上 —— 宿主**真的读**它
 * （审计 2026-09-23 A2/A3/A15 的两端契约），缺它时拒绝覆盖本机自制内容（409
 * `LOCAL_CONTENT`）。这与历史上的 `?force=1` 不同：那一个谁都没读，是死面。
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

/**
 * 「按版本安装」是否真的能装到指定版本（审计 2026-09-23 A11）。
 *
 * 只有**组织共享技能**的端点把版本写进路径
 * （`/api/pico/shared-skills/:name/:version/install`）。市场技能与智能体的端点
 * 都不带版本（市场归档端点只按"当前 approved 最高版"取），所以对它们渲染
 * 「v1 / v2」按钮是**假入口**：点 v1 装到的还是最新版，界面却按 v1 记账。
 * @param item - 能力中心的一行。
 * @returns 支持按版本安装为 true。
 */
export function versionInstallSupported(item: CapabilityItem): boolean {
  return item.kind === 'skill' && item.source === 'org'
}

/**
 * 覆盖确认的判据（审计 A2/A3/A15 + 第四轮 R4-B-3）。
 *
 * 返回 true 时面板先出确认条、用户点过之后才把 `?overwrite=1` 发给宿主；
 * 宿主侧对同一种情形没有标记就 409 `LOCAL_CONTENT`（两端同一份规则，见
 * auth-gate 的 `/api/pico/skills` 分支注释与安装器的
 * `requiresOverwriteConfirmation`）。
 *
 * 两档成因（**同一份事实的两种读法，不是两套判据**）：
 *  - `installedOrigin !== 'store'`：本机那一份不是能力中心装的（用户自制 /
 *    来源不明）；
 *  - `dirty === true`（R4-B-3）：**商店来源但被本地修改过** —— 磁盘上的内容哈希
 *    与安装时记的 `archiveChecksum` 不一致。它同时是"商店来源"和"里面装着用户的
 *    字节"：旧判据只看来源，于是「更新到 vX」一次单击就把用户加的文件与改过的正文
 *    整树删掉 —— 而卡片上还挂着「已本地修改」徽章（有徽章、无后果提示）。
 *    `dirty` 由宿主按磁盘事实算出（`isInstalledSkillDirty`，与宿主闸门同源）。
 * @param item - 能力中心的一行。
 * @returns 覆盖前需要用户确认。
 */
export function needsOverwriteConfirm(item: CapabilityItem): boolean {
  return item.installed === true && (item.installedOrigin !== 'store' || item.dirty === true)
}

/** 覆盖确认条的措辞档位（三选一，见 {@link overwriteConfirmReason}）。 */
export type OverwriteConfirmReason = 'local' | 'dirty' | 'store'

/**
 * 确认条该说哪一句（**唯一判定**）。
 *
 * 抽成纯函数的理由与 `needsOverwriteConfirm` 相同：措辞决定用户是否知道"按下去会
 * 丢什么"。`dirty` 档（R4-B-3）必须与"用户自制"分开 —— 前者丢的是**你自己改过的
 * 那部分**，后者丢的是**你写的一整份技能**，用户要据此决定按不按。
 * @param item - 能力中心的一行。
 * @returns `local` / `dirty` / `store`。
 */
export function overwriteConfirmReason(item: CapabilityItem): OverwriteConfirmReason {
  if (item.installedOrigin !== 'store') return 'local'
  return item.dirty === true ? 'dirty' : 'store'
}

/** 确认条要显示的那一行状态（{@link PendingInstall} 的最小子集，便于单测）。 */
export interface ConfirmStripInput {
  name: string
  /** 兼容字段：没有 `reason` 的历史调用按它推档（true ⇒ `local`）。 */
  localConflict: boolean
  reason?: OverwriteConfirmReason | undefined
}

/** 确认条的措辞档位（`reason` 优先；缺省按 `localConflict` 推）。 */
function confirmStripReason(input: ConfirmStripInput): OverwriteConfirmReason {
  return input.reason ?? (input.localConflict ? 'local' : 'store')
}

/**
 * 确认条正文（**唯一实现**；三档措辞见 {@link overwriteConfirmReason}）。
 * @param input - 待确认的那一发。
 * @returns 当前界面语言下的提示文案。
 */
export function confirmStripText(input: ConfirmStripInput): string {
  const reason = confirmStripReason(input)
  if (reason === 'local') return t('capability.conflictConfirmLocal', { name: input.name })
  if (reason === 'dirty') return t('capability.conflictConfirmDirty', { name: input.name })
  return t('capability.conflictConfirm', { name: input.name })
}

/**
 * 确认条的按钮文案（与 {@link confirmStripText} 同档）。
 * @param input - 待确认的那一发。
 * @returns 当前界面语言下的按钮标签。
 */
export function confirmStripAction(input: ConfirmStripInput): string {
  const reason = confirmStripReason(input)
  if (reason === 'local') return t('capability.forceInstallLocal')
  if (reason === 'dirty') return t('capability.forceInstallDirty')
  return t('capability.forceInstall')
}

/** 给写面端点加上"用户已确认覆盖/删除本机内容"的显式标记。 */
export function withOverwrite(url: string, overwrite: boolean): string {
  if (!overwrite) return url
  return `${url}${url.includes('?') ? '&' : '?'}overwrite=1`
}

/**
 * 这一发安装是否必须先弹确认条（**唯一判定入口**）。
 *
 * 抽成纯函数是为了让"确认条可达"这条契约可被单测打坏（审计 A15：旧实现里
 * 更新按钮硬编码 force，确认条永远是死代码，而纯渲染层没有任何用例能抓到）。
 * @param item - 能力中心的一行。
 * @param opts - 调用方的选项（`overwrite: true` = 用户已在确认条上点过）。
 * @returns 需要先确认。
 */
export function installNeedsConfirm(item: CapabilityItem, opts?: { overwrite?: boolean | undefined }): boolean {
  return opts?.overwrite !== true && needsOverwriteConfirm(item)
}

/**
 * 一次安装请求的 URL（**唯一拼装入口**）。
 *
 * `?overwrite=1` 只在"用户已确认"时出现 —— 宿主缺它就会拒绝覆盖本机自制内容
 * （409 `LOCAL_CONTENT`）。版本取用户点选的那一个，否则取当前展示版本。
 * @param item - 能力中心的一行。
 * @param opts - 调用方的选项（overwrite / 用户点选的版本）。
 * @returns 请求 URL。
 */
export function installRequestUrl(
  item: CapabilityItem,
  opts?: { overwrite?: boolean | undefined, version?: string | undefined },
): string {
  const version = opts?.version ?? item.version
  return withOverwrite(installEndpoint(item, version), opts?.overwrite === true)
}

/**
 * 本机技能库里那一份"来源是随包/平台"的技能，卸载走哪条端点（审计 A6 + 跨泳道契约 S2）。
 *
 *  - `builtin`（平台内置，服务端下发）⇒ `POST /api/pico/skills/builtin/:name/uninstall`
 *    —— 这条路由是本次新增的（此前内置技能只能装不能卸）；
 *  - `plugin`（随客户端内置，如随包插件同步进来的技能）⇒ `POST /api/pico/skills/:name/uninstall`
 *    —— 该端点本就是纯本地删除。
 * @param item - 能力中心的一行。
 * @returns 端点路径；不适用（不是这两种来源）时为 undefined。
 */
export function localRemoveEndpoint(item: CapabilityItem): string | undefined {
  if (item.kind !== 'skill') return undefined
  const name = encodeURIComponent(item.name)
  if (item.originChannel === 'builtin') return `/api/pico/skills/builtin/${name}/uninstall`
  if (item.originChannel === 'plugin') return `/api/pico/skills/${name}/uninstall`
  return undefined
}

/** 卡片页脚那一格该出什么（{@link planCardAction} 的返回值）。 */
export type CardActionPlan =
  | { kind: 'uninstall', endpoint: string, localContent: boolean }
  | { kind: 'update', version: string }
  | { kind: 'install' }
  | { kind: 'upload' }
  | { kind: 'reupload' }
  | { kind: 'review', status: ItemStatus }
  /** 归属已转交（R5-B-2）：这一格没有可达动作，只报状态。 */
  | { kind: 'transferred' }
  /** 已下架且本机没有可卸的那一份（R5-B-1）：同样只报状态。 */
  | { kind: 'delisted' }
  /** 库根里的**符号链接**形态（R17B-01）：运行时会加载，但打包/上传入口有意拒收 ⇒ 不给假按钮。 */
  | { kind: 'linked' }

/**
 * 本机这一份是不是"从目录装进来的那一份"（{@link isDelistedItem} 推断判据的一半）。
 *
 * 只认**目录渠道**（`market` / `org`）：`builtin` / `plugin` 是随包内容，
 * 本来就不在能力中心目录里，把它们算进来会让平台内置技能恒显示「已下架」。
 * 两个字段都是磁盘 provenance 的消费端（auth-gate 的本机行），与安装器/卸载器的
 * `isStoreProvenance` 同源。
 */
function catalogSourcedLocal(item: Pick<CapabilityItem, 'installedOrigin' | 'originChannel'>): boolean {
  return item.installedOrigin === 'store' && (item.originChannel === 'market' || item.originChannel === 'org')
}

/**
 * 这一行当前**不在可用目录中**（下架 / 授权撤回 / 已转走）—— 三条判据，前两条是
 * 服务端下发的事实，第三条是**只在能证明属于当前账号时**才允许的客户端推断：
 *
 *  1. **权威判据（作者面）**：服务端在作者自己的行上下发了 `delisted: true`
 *     （`CapabilityItem.Delisted`，R5-B-1 的服务端泳道新增字段）；
 *  2. **权威判据（目录面）**：服务端在行上下发了 `enabled: false`（下架行不再被
 *     服务端滤掉时就是这一档，客户端无需再改）；
 *  3. **推断判据**：这是一张**归并后 `source === 'local'`** 的本机行，带着目录渠道的
 *     商店溯源（{@link catalogSourcedLocal}），**且宿主能证明它属于当前账号**
 *     （`localOwnership === 'mine'`）。
 *
 * 第 2 条为什么成立：{@link mergeItems} 的权威序是 市场 > 组织 > 本机 —— 只要目录里
 * 还有同名同 kind 的一行，归并结果的 `source` 就**不可能**是 `local`。于是
 * "source === 'local' + 商店溯源"等价于"这份内容是从目录装进来的、而目录里已经没有
 * 它了"（R5-B-1：下架后员工面 market/org/own 三个来源同时为空，只剩磁盘本机行）。
 *
 * ⚠️ **第 3 条为什么必须加归属这一维（第六轮审计 R6-B-1）**：技能库是**机器作用域**
 * 的（`<DSH_HOME>/skills`，不按账号分目录），同机换账号又是被支持的操作。于是"本机有
 * 一份商店内容、当前账号在 own/market 两个视图里都看不到它"这个形状**同时**对应两种
 * 完全不同的处境：
 *   - 它确实是当前账号的内容（作者面 `delisted` 未下发的旧服务端；或授权被撤回），
 *     或
 *   - 它是**另一个账号**在这台机器上装的（当前账号既不是作者、也没有授权）。
 * 只看"目录里没有它"无法区分两者，修复前的版本会把后者也说成"可能已被管理员下架"，
 * 并把页脚换成**删除本机那一份**——一个跨账号的破坏性动作。归属判据由宿主下发
 * （{@link CapabilityItem.localOwnership}，来自服务端 `?source=own` 的匹配结果），
 * 证明不了（`'unknown'`）就**不下判词**：不标已下架、也不给删除类动作。
 *
 * 判据只回答"还能不能从目录更新/上传"，**不**回答"这份内容还能不能用"：磁盘上这一份
 * 照常可用、照常渲染，只是不再出现"上传/更新"这种已达不成的动作。
 * @param item - 能力中心的一行（必须是**归并后**的行，见上）。
 * @returns 明确不在目录中且属于当前账号 ⇒ `true`；其余（含未知）⇒ `false`。
 */
export function isDelistedItem(
  item: Pick<
    CapabilityItem,
    'source' | 'delisted' | 'enabled' | 'installedOrigin' | 'originChannel' | 'localOwnership'
  >,
): boolean {
  if (item.delisted === true) return true
  if (item.enabled === false) return true
  return item.source === 'local' && catalogSourcedLocal(item) && item.localOwnership === 'mine'
}

/**
 * 归属已被转交给别人（R5-B-2）：服务端**明确**说这一行不归当前用户
 * （`is_owner === false`），而本机还留着"我上传过"的记录
 * （{@link CapabilityItem.uploadStatus} 有值）。
 *
 * 为什么必须同时看 `uploadStatus`：任何"别人上传、我装进来"的商店行
 * `is_owner` 同样是 `false`，只看它会把每一份装来的内容都写成「已转交」。
 *
 * **不拿 `author` 兜底**（R5-B-2 的纪律）：`author` 是发布者，归属转移之后它仍然是
 * 旧作者的名字 —— 用本地这份缓存去推归属正是这条 finding 的成因。
 * @param item - 能力中心的一行（归并后的行）。
 * @returns 已转交 ⇒ `true`。
 */
export function isTransferredItem(item: Pick<CapabilityItem, 'isOwner' | 'uploadStatus'>): boolean {
  return item.isOwner === false && item.uploadStatus !== undefined
}

/**
 * 卡片页脚动作的**唯一判定实现**（渲染层只按它 map，不再自己算一遍）。
 *
 * 抽成纯函数的理由（独立复审 2026-09-23 A6/N1）：本包没有 jsdom/渲染测试面，
 * 而这正是 A6 的验收点 ——「同名商店行存在时仍渲染「随客户端内置」徽章 + 卸载按钮」。
 * 埋成 JSX 嵌套三元时，`mergeItems` 吞掉本机行字段造成的"页脚退化成「安装」"
 * 没有任何用例能打坏（审计探针只能逐字复刻这两处分支）。
 *
 * 两条口径（与 {@link localRemoveEndpoint} / `needsOverwriteConfirm` 同源）：
 *  - `source === 'local'`（本机创作，含 builtin/plugin 同步进来的那一份）：
 *    平台/随包内置的技能出「卸载」（审计 A6）；**已转交**（R5-B-2）与**不在目录中**
 *    （R5-B-1/B-3，**且能证明属于当前账号**，R6-B-1）两态各自出状态/卸载，
 *    **绝不出「上传」**；其余按上传状态出上传/等审/重传；
 *  - 商店行：未装出「安装」，有新版出「更新到 vX」（**不传 force**，A15），
 *    否则出「卸载」。
 *
 * 删除类动作的**准入条件**（R6-B-1）：本机那一份必须能证明属于当前账号
 * （{@link CapabilityItem.localOwnership} = `'mine'`，或服务端下发了权威的
 * `delisted`/`enabled`）。证明不了的行**一律不出**「卸载」—— 技能库是机器作用域的，
 * 删掉的很可能是同机**另一个账号**装的那一份。
 * @param item - 能力中心的一行（归并后的行）。
 * @returns 页脚动作。
 */
export function planCardAction(item: CapabilityItem): CardActionPlan {
  if (item.source === 'local') {
    const removable = localRemoveEndpoint(item)
    if (removable !== undefined) {
      return { kind: 'uninstall', endpoint: removable, localContent: needsOverwriteConfirm(item) }
    }
    // R5-B-2 先于上传档：归属已经不在自己名下（服务端 `is_owner:false`）时，
    // 「上传 / 重新上传」是**已达不成**的动作（服务端 409 NAME_TAKEN）。这一格
    // 只报状态，不再造假按钮。
    if (isTransferredItem(item)) return { kind: 'transferred' }
    // R5-B-1/B-3：目录里已经没有这一行（下架 / 授权撤回）时，本机这一份**仍然
    // 可用**，但"上传"要么注定失败、要么（下架期间服务端放行上传时）只是让作者
    // 在完全不知情的状态下反复提交。改成**真的可达**的那一个动作：本地卸载
    // （{@link uninstallEndpoint} 对技能走 shared-skills、对智能体走
    // agent-presets —— 两条都是既有端点，零新增接口）。是否为"用户自己的内容"
    // 仍由 needsOverwriteConfirm 决定要不要先确认一次。
    //
    // ⚠️ 这一格**只在能证明本机那一份属于当前账号时**才可能命中（R6-B-1）：
    // `isDelistedItem` 的第 3 条判据要求 `localOwnership === 'mine'`。证明不了
    // （`'unknown'`，例如"同事在这台机器上装的商店技能"）时落到下面的上传档：
    // 那是一个**无副作用**的动作（服务端会以名称占用拒掉），而删除**别人**装在
    // 这台机器上的那一份是有后果的跨账号动作。
    if (isDelistedItem(item)) {
      return {
        kind: 'uninstall',
        endpoint: uninstallEndpoint(item, item.version),
        localContent: needsOverwriteConfirm(item),
      }
    }
    // R17B-01：符号链接形态（运行时加载得到、但打包入口有意拒收）⇒ 只报事实。
    // 位置在"转让/下架/可卸载"三档之后：本机若真有规范落点可卸，卸载仍是可达动作。
    if (item.originSymlink === true) return { kind: 'linked' }
    if (item.uploadStatus === 'rejected') return { kind: 'reupload' }
    if (item.uploadStatus === 'pending') return { kind: 'review', status: 'pending' }
    if (item.uploadStatus === 'approved') return { kind: 'review', status: 'approved' }
    return { kind: 'upload' }
  }
  if (isDelistedItem(item)) {
    // 目录行上的下架（服务端 `enabled:false`）：**不给**「安装」—— 装了也不会与
    // 目录一致，而下架对使用者等价于"不存在"；本机已经有一份时给「卸载」（可达），
    // 否则这一格只报状态（与应用中心「已下架 + 禁用打开」同形态）。
    return item.installed
      ? { kind: 'uninstall', endpoint: uninstallEndpoint(item, item.version), localContent: needsOverwriteConfirm(item) }
      : { kind: 'delisted' }
  }
  if (!item.installed) return { kind: 'install' }
  if (hasUpdateFor(item)) {
    return { kind: 'update', version: item.versions[item.versions.length - 1] ?? item.version }
  }
  return {
    kind: 'uninstall',
    endpoint: uninstallEndpoint(item, item.version),
    localContent: needsOverwriteConfirm(item),
  }
}

/** 「来源」徽章可能用到的字典键（**六选一**，见 {@link capabilitySourceBadgeKey}）。 */
export type CapabilitySourceBadgeKey =
  | 'capability.sourceLocal'
  | 'capability.sourceOrg'
  | 'capability.sourceBuiltin'
  | 'capability.sourcePlugin'
  | 'capability.sourceMarket'
  | 'capability.sourceOther'

/**
 * 「来源」徽章该显示哪一个（**唯一实现**）。
 *
 * 2026-09-20 修的真实 UI bug：原先「我的」分区同时渲染 `source` 徽章与
 * `mineSourceBadge`，匿名路径下两张都写「自制」—— 卡片上出现两个一模一样的胶囊。
 * 现在按分区二选一：市场分区用来源（市场/组织），我的分区用「这份内容是怎么来的」
 * （自制 / 来自组织 / 平台内置 / 来自市场 / 其它）。
 *
 * 抽成纯函数的理由（独立复审 2026-09-23 A6）：这两条分支此前埋在 `renderBadges`
 * 的 JSX 里，而本包没有 jsdom/渲染测试面 ⇒「同名商店行存在时还渲染得出
 * 「随客户端内置」徽章吗」这件事**没有任何用例能打坏**。现在判据可被单测直接钉住，
 * 与 {@link localRemoveEndpoint}（同一个 `originChannel` 的另一个消费点）成对。
 * @param item - 能力中心的一行（归并后的行）。
 * @param tab - 所在分区。
 * @returns 徽章文案的字典键。
 */
export function capabilitySourceBadgeKey(
  item: Pick<CapabilityItem, 'source' | 'originChannel'>,
  tab: 'mine' | 'market',
): CapabilitySourceBadgeKey {
  if (tab === 'market') {
    return item.source === 'market'
      ? 'capability.sourceMarket'
      : item.source === 'org' ? 'capability.sourceOrg' : 'capability.sourceLocal'
  }
  if (item.source === 'local') return 'capability.sourceLocal'
  // 「我的」里的非本地行 = 从商店装进来的那一份；`originChannel` 来自磁盘 provenance。
  switch (item.originChannel) {
    case 'org': return 'capability.sourceOrg'
    case 'builtin': return 'capability.sourceBuiltin'
    // 随客户端内置（随包插件同步进技能库的技能，跨泳道契约 S2）：
    // 它不是用户作品，也不是市场/组织内容 —— 面板给它「卸载」，不给「上传」。
    case 'plugin': return 'capability.sourcePlugin'
    case 'market': return 'capability.sourceMarket'
    default: return 'capability.sourceOther'
  }
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
  // 平台内置 / 随客户端内置（不随市场/组织目录走）的技能优先（审计 A6 + 跨泳道契约 S2）。
  const local = localRemoveEndpoint(item)
  if (local !== undefined) return local
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

/**
 * 上传被服务端拒绝时的用户可见文案（**按稳定错误码映射，不看 HTTP 状态码**）。
 *
 * 为什么判据必须是 `code` 而不是 `status`（R5-B-1 的客户端尾巴，2026-09-23 跨泳道
 * 补齐）：本机写面（`auth-gate` 的 `/api/pico/shared-skills/upload` 与
 * `/api/pico/agent-presets/upload`）会**透传服务端原始状态码**，而 409 同时是
 * `NAME_TAKEN` / `VERSION_*` / `CONFLICT` / `ARCHIVE_CLEARED` / `APP_DELISTED`
 * 的码 —— 按 409 一律说「名称已被占用」会把「已下架冻结」说成重名（本仓踩过同形的坑）。
 * 因此只有 `APP_DELISTED` 走专用文案；**其它任何码都逐字沿用本函数引入前的行为**
 * （服务端 message 优先，缺省回落 `HTTP <status>`），不被这条分支吞掉。
 *
 * 抽成纯函数的理由与 {@link nameTakenError} 相同：文案取自模块级 `t()`，只有
 * "切语言后跟着变"的断言才有判别力，且"其它码不被吞"需要能被直接打坏。
 * @param failure - 本机写面返回的错误信封（`code` 缺省 = 旧宿主 / 非信封错误）。
 * @returns 当前界面语言下的提示文案。
 */
export function uploadFailureText(
  failure: { code?: string | undefined; message?: string | undefined; status: number },
): string {
  if (failure.code === 'APP_DELISTED') return t('capability.delistedFrozen')
  if (failure.message !== undefined && failure.message !== '') return failure.message
  return `HTTP ${String(failure.status)}`
}

/**
 * 跨源同名行的**权威序**：市场 > 组织 > 本机（2026-08-25 决策"跨源同名的展示行
 * 保留市场"）。返回值只取决于行的 `source`，与数组到达顺序无关。
 * @param item - 能力中心的一行。
 * @returns 排序权重（越小越权威）。
 */
function sourceRank(item: CapabilityItem): number {
  return item.source === 'market' ? 0 : item.source === 'org' ? 1 : 2
}

/** 同源多行时的稳定次级键：同等级的行按内容定序，与到达顺序无关。 */
function stableRowKey(item: CapabilityItem): string {
  return JSON.stringify(item)
}

/** 按权威序取第一个可用值（`usable` 不成立就继续往后找），没有则 undefined。 */
function pickByAuthority<T>(
  ordered: readonly CapabilityItem[],
  read: (item: CapabilityItem) => T | undefined,
  usable: (value: T) => boolean,
): T | undefined {
  for (const item of ordered) {
    const value = read(item)
    if (value !== undefined && usable(value)) return value
  }
  return undefined
}

/** 数值字段取各行的最大值（全部缺失时保持 undefined）。 */
function maxOf(ordered: readonly CapabilityItem[], read: (item: CapabilityItem) => number | undefined): number | undefined {
  const values = ordered.map(read).filter((v): v is number => v !== undefined)
  return values.length === 0 ? undefined : Math.max(...values)
}

/**
 * 归并**同一张卡**的多行（同名 kind+name 的跨源/跨分区载荷）。
 *
 * 三条硬约定（独立复审 2026-09-23 A6 + N1 的修复面）：
 *
 *  1. **结果只取决于行集合，不取决于到达顺序**。面板 mount 时并发发
 *     `?source=market` 与 `?source=local` 两次取数（后者内部还要打 3 次上游），
 *     谁先回来不定。旧实现是"先到的行说了算"（`{...existing}` 打底、逐行覆写），
 *     于是同一份数据会渲染成两种卡：market-first 丢本机行的 `originChannel` ⇒
 *     **「随客户端内置」徽章与本机卸载入口都渲染不出来**（A6 的卸载入口在这个
 *     形态下不可达）；mine-first 则把已装技能渲染成「安装」。现在每个字段都有
 *     显式、与顺序无关的取值规则。
 *  2. **本机那一行是"这台机器上是什么"的权威**（A6）：`originChannel` /
 *     `originAppId` / `dirty` / `installedOrigin` 一律取 `source === 'local'` 行的
 *     值 —— 它们来自磁盘上的 provenance，只有本机行有，旧实现会被商店行吞掉。
 *  3. **磁盘上真有这一份 ⇒ 已安装**：存在本机行（`?source=local` 的本地行由
 *     `listLocalSkills`/`listLocalPresets` 扫盘得到）即 `installed: true`，
 *     否则「我的」里的本机卡会被渲染成「安装」。
 *
 * 其余口径保持 2026-08-25 决策：展示行来源市场优先；`displayName`/`description`
 * 取「较新」（版本高者优先）的非空值，避免市场行用与 name 同值的标题盖掉组织行的
 * 中文标题；`version` 展示最高 approved 版本（与来源无关的版本事实）。
 * @param items - 各来源的行（同一条可来自多个载荷）。
 * @returns 每个（kind, name）一行，按 `kind:name` 升序（面板随后自行排序）。
 */
export function mergeItems(items: readonly CapabilityItem[]): CapabilityItem[] {
  const groups = new Map<string, CapabilityItem[]>()
  for (const item of items) {
    const key = `${item.kind}:${item.name}`
    const bucket = groups.get(key)
    if (bucket === undefined) groups.set(key, [item])
    else bucket.push(item)
  }
  return [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, rows]) => mergeItemGroup(rows))
}

/** {@link mergeItems} 的单组归并（行的到达顺序不得影响返回值）。 */
function mergeItemGroup(rows: readonly CapabilityItem[]): CapabilityItem {
  // 权威序：来源优先 + **内容**定序（`rows` 本身的到达顺序不得参与）。
  const byAuthority = [...rows].sort((a, b) => {
    const rank = sourceRank(a) - sourceRank(b)
    return rank !== 0 ? rank : stableRowKey(a).localeCompare(stableRowKey(b))
  })
  // 「较新」序：版本高的先；同版本时按内容定序 —— displayName/description 用它取值。
  const byFreshness = [...rows].sort((a, b) => {
    const byVersion = compareVersions(b.version, a.version)
    return byVersion !== 0 ? byVersion : stableRowKey(a).localeCompare(stableRowKey(b))
  })
  /** 本机那一行（磁盘事实的唯一来源）；没有本机行时为 undefined。 */
  const local = rows.find(row => row.source === 'local')

  const all = new Set<string>()
  for (const row of rows) {
    for (const version of row.versions) all.add(version)
    if (row.version !== '') all.add(row.version)
  }
  const versions = [...all].sort(compareVersions)
  const approved = versions.filter(v => rows.some(row => row.version === v && row.status === 'approved'))
  const version = approved[approved.length - 1] ?? versions[versions.length - 1] ?? byAuthority[0]!.version
  const name = byAuthority[0]!.name
  const displayName = pickByAuthority(byFreshness, row => row.displayName, v => v !== '' && v !== name)
    ?? pickByAuthority(byFreshness, row => row.displayName, v => v !== '')
    ?? ''
  const description = pickByAuthority(byFreshness, row => row.description, v => v !== '') ?? ''
  // 状态徽章是"用户自己的上传进度"：pending/rejected 优先透出（市场行常是
  // approved，按权威序取会把用户自己的待审状态吞掉）。
  const progress = byAuthority.find(row => row.status === 'pending' || row.status === 'rejected')
  const status = progress?.status ?? pickByAuthority(byAuthority, row => row.status, () => true)
  const reason = (progress?.reason !== undefined && progress.reason !== '')
    ? progress.reason
    : pickByAuthority(byAuthority, row => row.reason, v => v !== '')

  return {
    // 打底只为了带上宿主未来新增的透传字段（声明的字段全部在下面显式赋值，
    // 结果不依赖哪一行打底）。权威序首行 = 内容定序 ⇒ 与到达顺序无关。
    ...byAuthority[0]!,
    kind: byAuthority[0]!.kind,
    name,
    source: pickByAuthority(byAuthority, row => row.source, () => true) ?? 'local',
    displayName,
    description,
    author: pickByAuthority(byAuthority, row => row.author, v => v !== '') ?? '',
    version,
    versions,
    // 磁盘上真有这一份（本机行由扫盘得到）⇒ 已安装。
    installed: rows.some(row => row.installed === true || row.source === 'local'),
    installedVersion: pickByAuthority(byAuthority, row => row.installedVersion, () => true),
    // 本机行优先：来源判定只有磁盘上的 provenance 说得准（A2/A3/A6）。
    installedOrigin: local?.installedOrigin ?? pickByAuthority(byAuthority, row => row.installedOrigin, () => true),
    // 归属判据（R6-B-1）：只有宿主下发在本机行上，**只认本机行那一份**，且不做
    // "任一行有就取"的归并 —— 它描述的是"磁盘上这一份算不算当前账号的"，目录行
    // 上的任何字段都回答不了这个问题。
    //
    // **缺省必须归一化成 `'unknown'`（证明不了），绝不读成 `'mine'`**（第六轮独立复审
    // V2 边界①：`?? 'mine'` 这个变异此前没有任何判据，存活）。读成 `'mine'` 会让
    // "宿主根本没下发这个字段"（旧宿主 / 字段被裁剪 / 未来新增的调用点）与"宿主证明
    // 属于当前账号"在 {@link isDelistedItem} 第 3 条判据里完全等价，于是页脚又给出
    // **删除本机那一份** —— 正是 R6-B-1 要挡的那个跨账号破坏性动作。
    // 归一化成显式取值（而不是留在 `undefined`）是为了让"证明不了"在数据里就是一个
    // 取值：下游（含测试与探针）不必再区分"没这个字段"与"字段值是 undefined"。
    localOwnership: local?.localOwnership ?? 'unknown',
    originChannel: local?.originChannel ?? pickByAuthority(byAuthority, row => row.originChannel, () => true),
    originAppId: local?.originAppId ?? pickByAuthority(byAuthority, row => row.originAppId, () => true),
    originServer: local?.originServer ?? pickByAuthority(byAuthority, row => row.originServer, () => true),
    dirty: local?.dirty ?? pickByAuthority(byAuthority, row => row.dirty, () => true),
    originSymlink: local?.originSymlink ?? pickByAuthority(byAuthority, row => row.originSymlink, () => true),
    runtimeName: pickByAuthority(byAuthority, row => row.runtimeName, v => v !== ''),
    isLocal: rows.some(row => row.isLocal === true) ? true : undefined,
    uploadStatus: local?.uploadStatus ?? pickByAuthority(byAuthority, row => row.uploadStatus, () => true),
    quality: pickByAuthority(byAuthority, row => row.quality, v => v === 'featured')
      ?? pickByAuthority(byAuthority, row => row.quality, () => true),
    status,
    reason,
    official: rows.some(row => row.official === true) ? true : undefined,
    // 归属三态必须**如实**下发（R5-B-2）：`mergeItemGroup` 里原来的
    // `some(isOwner === true) ? true : undefined` 会把服务端明确说的 `false`
    // 抹成"未知"，于是"这一行已经转给别人了"在客户端**永远表达不出来**。
    // 归并语义：任一行说"是你的"⇒ 是你的；否则任一行明确说"不是你的"⇒ 不是你的；
    // 都没有该字段 ⇒ 未知（本机磁盘行）。
    isOwner: rows.some(row => row.isOwner === true)
      ? true
      : rows.some(row => row.isOwner === false) ? false : undefined,
    // 归属人账号（服务端下发时透出，供「已转交」说明用；缺省不编造）。
    owner: pickByAuthority(byAuthority, row => row.owner, v => v !== ''),
    // 下架标记（R5-B-1）：**任一行说下架就是下架**（它是 App 级事实，不是行级偏好）；
    // 没有任何一行带该字段 ⇒ undefined（未知，不得读成"上架"）。
    delisted: rows.some(row => row.delisted === true) ? true : undefined,
    // 上下架（R5-B-1）：**false 优先**（任一行说下架 ⇒ 下架）；没有该字段 ⇒
    // undefined（未知，不得读成"上架"）。
    enabled: rows.some(row => row.enabled === false)
      ? false
      : rows.some(row => row.enabled === true) ? true : undefined,
    downloads: maxOf(rows, row => row.downloads),
    calls: maxOf(rows, row => row.calls),
    score: maxOf(rows, row => row.score),
  }
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
  // `box-sizing: border-box`：没有它时 `max-height` 只约束内容盒，弹层实际能长到
  // 78vh + 上下 padding 36px（2026-09-21 审计）。滚动链本身是有界的，这条只是把上限收紧。
  boxSizing: 'border-box',
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
 * @param props - 目标、忙碌态、站级闸、按版本安装回调与关闭回调。
 */
export function CapabilityDetailDialog({ target, busy, blocked, onInstallVersion, onClose }: {
  target: DetailTarget
  busy: boolean
  /**
   * 站级闸（另有动作在飞）。审计 C-03：`install()` 第一行对"有动作在飞"是**静默
   * return**，而弹层里的按版本按钮此前只收到 own-key 的 `busy` ⇒ 别的卡片在安装时
   * 这两个按钮仍是启用态，点下去不发请求、不改状态、不报错 = **死按钮**。
   * 闸门必须与"点下去会被吞掉"的条件同源，并且以**禁用 + 说明**呈现。
   */
  blocked: boolean
  onInstallVersion: (version: string) => void
  onClose: () => void
}): JSX.Element {
  const boxRef = useRef<HTMLDivElement | null>(null)
  /**
   * `onClose` 是父组件里的内联箭头函数 ⇒ 每次父渲染都是新引用。把它固定进 ref，
   * 下面两个 effect 才能是**只挂载一次**的：否则每 30s 轮询/每次 busy 翻转都会重跑
   * （重跑会做两件坏事：把焦点从用户正在操作的版本按钮上抢回弹层、卸载时把焦点还原到
   * 已经被替换掉的"上一个活动元素"即弹层自己）。
   */
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const previousFocusRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    // 记下"打开弹层的那个元素"，并在卸载时把焦点还回去。
    const previous = document.activeElement
    previousFocusRef.current = previous instanceof HTMLElement ? previous : null
    boxRef.current?.focus()
    return () => {
      const target = previousFocusRef.current
      if (target !== null && target.isConnected) target.focus()
    }
  }, [])
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        // 不让这次 Esc 冒到面板装载器（那里会"返回聊天"）。
        event.stopPropagation()
        onCloseRef.current()
        return
      }
      // Tab 环（2026-09-21 审计）：弹层声明了 `aria-modal=true`，但遮罩后面的侧边栏/
      // 面板控件仍然可聚焦 —— Tab 会把焦点带到看不见的地方，回车能激活看不见的按钮。
      if (event.key !== 'Tab') return
      const box = boxRef.current
      if (box === null) return
      const focusables = [...box.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      if (focusables.length === 0) return
      const first = focusables[0]!
      const last = focusables[focusables.length - 1]!
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [])

  const skill = target.kind === 'builtin' ? target.card.skill : undefined
  const item = target.kind === 'item' ? target.item : undefined
  const title = skill !== undefined
    ? (skill.title !== undefined && skill.title !== '' ? skill.title : skill.name)
    : (item!.displayName || item!.name)
  const description = skill !== undefined ? (skill.description ?? '') : item!.description
  const meta = skill !== undefined
    ? `v${skill.version}${skill.author !== undefined && skill.author !== '' ? ` · ${skill.author}` : ''}`
    : `v${item!.version}${item!.author !== '' ? ` · ${item!.author}` : ''}`
  // 「按版本安装」只在端点**真的接受版本**时出现（审计 A11）：市场技能/智能体的
  // 端点不带版本，点了「v1」装到的还是最新版，界面却按 v1 记账 ⇒ 常驻「更新到 vX」。
  const versions = item !== undefined && versionInstallSupported(item) ? item.versions : []
  /** 市场技能只能装最新版：把这件事写在弹层里，而不是给一排假按钮。 */
  const marketLatestOnly = item !== undefined && item.kind === 'skill' && item.source === 'market'

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
          {marketLatestOnly && (
            <p style={{ ...META, marginTop: 12 }} data-role="market-latest-only">{t('capability.marketLatestOnly')}</p>
          )}
          {versions.length > 1 && (
            <div style={{ marginTop: 14 }}>
              <div style={{ ...LABEL_SM }}>{t('capability.viewVersions', { count: String(versions.length) })}</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                {versions.map(version => (
                  <PanelButton
                    key={version}
                    variant={version === item!.version ? 'primary' : 'secondary'}
                    size="sm"
                    // `busy` = 本弹层目标自己的动作在飞；`blocked` = 站级闸（另有动作在飞）。
                    // 两者都要禁用：`install()` 对后者是静默 return（审计 C-03）。
                    disabled={busy || blocked}
                    title={blocked && !busy ? t('capability.busyHint') : undefined}
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

/** 待用户确认的一发安装（普通条目卡与内置技能卡共用）。 */
interface PendingInstall {
  /** `{kind}:{name}` 或 `builtin:{name}`（与 action.key 同口径）。 */
  key: string
  /** 展示用的技能名。 */
  name: string
  /**
   * 本机那一份不是"内容未改的商店内容" ⇒ 要走"会被覆盖"的措辞（**不是**第二套判据，
   * 就是 {@link needsOverwriteConfirm} 的结果；保留字段是为了兼容既有断言）。
   */
  localConflict: boolean
  /**
   * 确认条的措辞档位（唯一判据见 {@link overwriteConfirmReason}）：
   *  - `local`：本机那一份不是能力中心装的 ⇒ "自制内容"措辞 + 「仍要覆盖」；
   *  - `dirty`：商店来源但**被本地修改过**（R4-B-3）⇒ 明说"更新会丢掉你改过的内容"；
   *  - `store`：商店来源、内容未改、只是换渠道 ⇒ 通用覆盖措辞。
   */
  reason?: OverwriteConfirmReason | undefined
  /** 用户在详情弹层里点选的版本（内置卡没有这一项）。 */
  version?: string | undefined
  /** 用户确认后真正执行的那一发（`overwrite` = 把 `?overwrite=1` 交给宿主）。 */
  run: (overwrite: boolean) => Promise<void>
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
  /**
   * 覆盖确认：待用户确认的那一发安装。
   *
   * 存"意图"（而不是只存一个 key）有三个理由（审计 A15/A11/A2）：
   *  ①确认条要重放**同一发**安装，包括详情弹层里点的那一个版本（旧实现只存 key，
   *    确认后会退回 item.version）；
   *  ②措辞要按本机那一份的来源分档（用户自制 vs 商店）；
   *  ③**两个安装入口共用同一条确认条**：普通条目卡与内置技能入口卡（`run` 闭包
   *    分别指向 `performInstall` / `builtin.install`），否则内置技能的「更新到 vX」
   *    会绕过确认直接打到宿主（被 409 挡下 = 用户只看到一条报错）。
   */
  const [installConfirm, setInstallConfirm] = useState<PendingInstall | null>(null)
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
  /**
   * 站内是否有动作在飞（安装/卸载/上传）。
   *
   * `install()` / `uninstall()` / `upload()` 的第一行都是"有动作在飞就 return"，但按钮此前
   * 只按**自己这张卡**的 key 置灰 ⇒ 慢安装期间其它卡片的按钮外观仍是可点的启用态，
   * 点下去被静默吞掉（用户以为按钮坏了，2026-09-21 审计）。现在其它卡片一起置灰。
   */
  const inFlight = action !== null && (action.kind === 'installing' || action.kind === 'uninstalling' || action.kind === 'uploading')
  /**
   * 动作结果条 / 覆盖确认条在**滚动区顶部**，列表滚到下方时看不见它们。
   * 任何一条出现或内容变化就把它滚进视口，否则用户点完按钮"界面零变化"。
   */
  const noticeRef = useRef<HTMLDivElement | null>(null)
  const noticeKey = action === null ? '' : `${action.kind}|${action.key}|${action.error ?? ''}`
  useEffect(() => {
    if (noticeRef.current === null) return
    if (noticeKey === '' && installConfirm === null) return
    noticeRef.current.scrollIntoView({ block: 'nearest' })
  }, [noticeKey, installConfirm])

  const setSection = (key: string, state: Partial<SectionState>): void => {
    setSections(prev => ({ ...prev, [key]: { status: prev[key]?.status ?? 'idle', error: prev[key]?.error ?? '', ...state } }))
  }

  const loadSection = async (key: SectionKey, fetcher: () => Promise<CapabilityItem[]>): Promise<void> => {
    const seq = loadSeqRef.current
    setSection(key, { status: 'loading', error: '' })
    try {
      const rows = await fetcher()
      if (seq !== loadSeqRef.current) return
      setItems(prev => applySectionRows(prev, key, rows))
      setSection(key, { status: 'ok' })
    } catch (cause) {
      if (seq !== loadSeqRef.current) return
      // R16B-26（2026-09-25，与 R16B-08 同族）：catch 把 cause **整个丢掉** ⇒ 用户
      // 只看到「加载失败」+ 重试，401/403/404/5xx/形状漂移一律不可区分，而且**零日志**
      // （打包版没有可见控制台，连支持都拿不到线索）。两个 fetcher 抛的都是
      // `HTTP <status>`（服务端业务信封原文优先），带上它：可见文案走带占位符的那条
      // 字典键（用户仍读到本地化的"加载失败"，机器可读的部分跟在后面），同时打一条
      // 可检索的 warn 供诊断包取用。
      const detail = cause instanceof Error ? cause.message : ''
      if (detail !== '') {
        console.warn(`[capability] loading the ${key} section failed: ${detail}`)
        setSection(key, { status: 'error', error: t('capability.loadErrorDetail', { error: detail }) })
        return
      }
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

  // Esc / 初始焦点 / 焦点陷阱**都不在这里做**（2026-09-21 删除）。
  //
  // 这里原来有一段 window 级 keydown：`Escape ⇒ onClose()` + 一个 Tab 焦点陷阱。
  // 真机实测它有两个问题：
  //   ① 详情弹层打开时按 Esc：弹层自己也在 window 上注册了 Esc（并且 stopPropagation），
  //      但**同一个 target 上的监听器不会被 stopPropagation 拦住**（那要
  //      stopImmediatePropagation），而面板这段注册更早 ⇒ 先执行 onClose()，
  //      结果是"关弹层"变成"整页被踢回会话区"。
  //   ② 焦点陷阱的 `panelRef` 从未挂到任何元素上（全文件只有声明与读取），
  //      所以陷阱与 `panelRef.current?.focus()` 都是死代码；而整页面板的键盘语义本来
  //      就不该把 Tab 圈死（侧边栏是同一个可键盘到达的面板出口）。
  //
  // 现在的唯一权威是装载器 `@picoaide/dsh-panel-surface`：它在 document 上处理 Esc
  // （检测到 `[role=dialog][aria-modal=true]` 时让给内层模态），并在激活时把焦点移到
  // 面板容器上。弹层自己负责它那一层的 Esc（见 CapabilityDetailDialog）。

  // 30s 静默轮询:市场(合并)审批状态/质量变化后台刷新。
  useEffect(() => {
    const timer = setInterval(() => {
      const seq = loadSeqRef.current
      void fetch('/api/pico/capabilities?source=market').then(async (res) => {
        if (!res.ok) return
        const data = await res.json() as { items?: CapabilityItem[] }
        if (seq !== loadSeqRef.current) return
        // 与 loadSection 同一条归约（唯一实现），不在这里另写一份 filter。
        setItems(prev => applySectionRows(prev, 'market', data.items ?? []))
        // 后台刷新成功即退出先前 error 态——否则首次加载失败后,错误提示与
        // 重试按钮会遮住已刷新的数据(2026-09-01 深挖)。
        setSection('market', { status: 'ok', error: '' })
      }).catch(() => {})
    }, 30000)
    return () => { clearInterval(timer) }
  }, [])

  /**
   * 真正发请求的那一发安装（**不含**确认闸门 —— 闸门在 {@link install}）。
   * @param item - 能力中心的一行。
   * @param opts - overwrite / 用户点选的版本。
   */
  const performInstall = async (item: CapabilityItem, opts?: { overwrite?: boolean; version?: string }): Promise<void> => {
    if (action !== null && (action.kind === 'installing' || action.kind === 'uninstalling' || action.kind === 'uploading')) return
    const key = `${item.kind}:${item.name}`
    setInstallConfirm(null)
    setAction({ key, kind: 'installing' })
    try {
      const url = installRequestUrl(item, opts)
      const res = await fetch(url, { method: 'POST' })
      // 宿主说"目标是本机内容，需要确认"（面板缓存的来源过期 / 多窗口竞争）⇒
      // 回到确认条，而不是把一条 409 当成失败丢给用户。
      if (res.status === 409) {
        setAction(null)
        setInstallConfirm({
          key, name: item.name, localConflict: true,
          ...opts?.version === undefined ? {} : { version: opts.version },
          run: async (overwrite) => { await performInstall(item, { ...opts, overwrite }) },
        })
        return
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error((data as { error?: string }).error ?? `HTTP ${String(res.status)}`)
      }
      // 记账用**响应里的真实版本**（审计 A11）：市场归档端点只按当前 approved
      // 最高版取，请求里那个版本号可能根本没被采纳。拿不到版本就留 undefined
      // （宁可不提示更新，也不误报），并按磁盘事实重载一次。
      const data = await res.json().catch(() => ({})) as { version?: unknown }
      const appliedVersion = typeof data.version === 'string' && data.version !== '' ? data.version : undefined
      setItems(prev => prev.map(i => (i.kind === item.kind && i.name === item.name
        // `dirty: false`（R4-B-3）：装完之后磁盘上的内容就是商店那一份（安装器会重算
        // 内容哈希），「已本地修改」徽章必须同时熄灭 —— 否则覆盖成功后卡片还在说
        // "已本地修改"，用户会以为自己的改动还在。
        ? { ...i, installed: true, installedVersion: appliedVersion, installedOrigin: 'store', dirty: false }
        : i)))
      setAction({ key, kind: 'done-install', name: item.name })
      if (appliedVersion === undefined) loadAll()
    } catch (cause) {
      setAction({ key, kind: 'failed', error: cause instanceof Error ? cause.message : undefined, name: item.name })
    }
  }

  /**
   * 安装入口（带覆盖确认闸门）。
   *
   * 审计 A2/A3/A15 + R4-B-3：**本机已装、且那一份不是"内容未改的商店内容"** ⇒
   * 先出确认条，用户点过之后才把 `?overwrite=1` 交给宿主。旧实现把"已装"一律当成
   * 要覆盖、更新按钮又硬编码 force ⇒ 确认条是死代码，用户手写的同名技能被静默整树
   * 替换；R4-B-3 补上第二档：商店来源但**被本地修改过**（dirty）同样必须先确认 ——
   * 否则一次单击「更新」就把用户加的文件与改过的正文整树删掉。
   * @param item - 能力中心的一行。
   * @param opts - overwrite（用户已确认）/ version（用户点选的版本）。
   */
  const install = async (item: CapabilityItem, opts?: { overwrite?: boolean; version?: string }): Promise<void> => {
    if (installNeedsConfirm(item, opts)) {
      setInstallConfirm({
        key: `${item.kind}:${item.name}`,
        name: item.name,
        localConflict: true,
        reason: overwriteConfirmReason(item),
        ...opts?.version === undefined ? {} : { version: opts.version },
        run: async (overwrite) => { await performInstall(item, { overwrite, ...opts?.version === undefined ? {} : { version: opts.version } }) },
      })
      return
    }
    await performInstall(item, opts)
  }

  /**
   * 内置技能入口卡的动作（安装 / 更新到 vX）。
   *
   * 与普通卡**共用同一条确认条与同一份判据**（{@link needsOverwriteConfirm}）：
   * 本机同名那一份是用户自制、或是**被本地修改过的**商店内容时，先确认再带
   * `?overwrite=1` 打宿主。
   *
   * R4-B-5（第四轮）：**面板的预检不是权威** —— 本机同名技能来自**另一条商店渠道**
   * （如组织库）时，`installedOrigin` 仍是 `store`、`dirty` 也是 false，于是这一发
   * 不带 `?overwrite=1`；宿主按"换渠道"正确地回 409，而内置卡此前只把服务端那句
   * 英文拒绝文案贴在卡片上、右边只有一个「重试」按钮 —— 点多少次都是同一发请求，
   * **没有任何路径能补上 `?overwrite=1`**（普通卡有确认条回落，内置卡漏了）。
   * 现在 `builtin.install` 把 409 如实报回来（`'conflict'`），这里落到同一条确认条。
   * @param card - 内置技能卡。
   */
  const activateBuiltinCard = (card: BuiltinCard): void => {
    const local = items.find(i => i.kind === 'skill' && i.name === card.skill.name && i.source === 'local')
    const key = `builtin:${card.skill.name}`
    /** 本机同名那一份需要覆盖确认（自制 / 已本地修改）⇒ 出确认条（唯一通道）。 */
    const ask = (reason: OverwriteConfirmReason): void => {
      setInstallConfirm({
        key, name: card.skill.name, localConflict: true, reason,
        run: async (overwrite) => { await builtin.install(card.skill, overwrite) },
      })
    }
    if (local !== undefined && needsOverwriteConfirm({ ...local, installed: true })) {
      ask(overwriteConfirmReason({ ...local, installed: true }))
      return
    }
    void builtin.install(card.skill).then((result) => {
      // 宿主说"目标是另一条渠道的同名内容，需要确认"（R4-B-5）⇒ 与普通卡的 409
      // 处理同形：回到确认条，而不是把一条拒绝文案永远贴在卡片上。
      if (result === 'conflict') ask('store')
    })
  }

  const uninstall = async (item: CapabilityItem): Promise<void> => {
    if (action !== null && (action.kind === 'installing' || action.kind === 'uninstalling' || action.kind === 'uploading')) return
    const key = `${item.kind}:${item.name}`
    if (uninstallConfirmKey !== key) { setUninstallConfirmKey(key); return }
    setUninstallConfirmKey(null)
    setAction({ key, kind: 'uninstalling' })
    try {
      // 第二步（用户已确认）才带 `?overwrite=1`：本机自制内容没有它宿主会 409 拒绝
      // （审计 A3）。商店来源不需要它，多带一个显式确认也无害。
      const base = uninstallEndpoint(item, item.version)
      const res = await fetch(withOverwrite(base, true), { method: 'POST' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error((data as { error?: string }).error ?? `HTTP ${String(res.status)}`)
      }
      setItems(prev => prev.map(i => (i.kind === item.kind && i.name === item.name ? { ...i, installed: false, installedVersion: undefined, installedOrigin: undefined } : i)))
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
        const data = await res.json().catch(() => ({})) as { error?: unknown; code?: unknown }
        // R5-B-1 的客户端尾巴：下架冻结（409 APP_DELISTED）说清"为什么没成 + 怎么解"，
        // 而不是把服务端 message 原样（或 `HTTP 409`）丢给用户。判据**只看错误码**
        // （409 同时是 NAME_TAKEN/VERSION_*/CONFLICT 的码），其它码逐字沿用原行为。
        throw new Error(uploadFailureText({
          ...typeof data.code === 'string' ? { code: data.code } : {},
          ...typeof data.error === 'string' ? { message: data.error } : {},
          status: res.status,
        }))
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
     * 「已下架」徽章（R5-B-1）：形态照**应用中心**那一套（`AppCenterPanel` 的
     * `appCenter.disabled` 中性胶囊 + 卡片置灰 + 说明文字），不另创一套。
     */
    const delistedBadge = isDelistedItem(item) ? <Chip tone="neutral" plain>{t('capability.delisted')}</Chip> : null
    /** 「已转交」徽章（R5-B-2）：归属已不在自己名下（服务端 `is_owner:false`）。 */
    const transferredBadge = isTransferredItem(item) ? <Chip tone="warn">{t('capability.transferred')}</Chip> : null
    /**
     * 「来源」徽章**只出一个**（选键的唯一实现在 {@link capabilitySourceBadgeKey}）。
     */
    const sourceBadge = <Chip tone="neutral" plain>{t(capabilitySourceBadgeKey(item, isMineSection ? 'mine' : 'market'))}</Chip>
    return (
      <>
        <Chip tone={item.kind === 'skill' ? 'brand' : 'neutral'}>
          {item.kind === 'skill' ? t('capability.typeSkill') : t('capability.typeAgent')}
        </Chip>
        {sourceBadge}
        {officialBadge}
        {qualityBadge}
        {statusBadge}
        {delistedBadge}
        {transferredBadge}
        {item.source === 'local' && item.originChannel !== undefined && item.originChannel !== 'builtin' && (
          <Chip tone="neutral" plain>{`v${item.version}`}</Chip>
        )}
        {item.dirty === true && <Chip tone="warn">{t('capability.dirty')}</Chip>}
        {item.originServer !== undefined && <Chip tone="warn">{t('capability.originOtherServer')}</Chip>}
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
              <PanelButton variant="primary" size="md" disabled={inFlight} onClick={() => { activateBuiltinCard(card) }}>
                {t('capability.builtinRetry')}
              </PanelButton>
            </>
          ) : (
            <PanelButton variant="primary" size="md" block disabled={inFlight} onClick={() => { activateBuiltinCard(card) }}>{label}</PanelButton>
          )}
        </div>
      </Card>
    )
  }

  /**
   * 「卸载」按钮区（两段式确认）。商店已装行与"本机内置（builtin/plugin）"行共用。
   * 本机自制内容那一档用 danger 文案与「仍要删除」按钮（审计 A3）。
   */
  const renderUninstall = (item: CapabilityItem, key: string, busy: boolean, blocked: boolean): React.ReactNode => {
    if (uninstallConfirmKey !== key) {
      return <PanelButton variant="secondary" size="md" block disabled={blocked} onClick={() => { void uninstall(item) }}>{t('capability.uninstall')}</PanelButton>
    }
    return (
      <div style={{ display: 'flex', gap: 8, width: '100%' }}>
        <PanelButton variant="danger" size="md" style={{ flex: 1 }} disabled={blocked} onClick={() => { void uninstall(item) }}>
          {busy && action?.kind === 'uninstalling'
            ? t('capability.uninstalling')
            : needsOverwriteConfirm(item) ? t('capability.deleteLocal') : t('capability.confirmUninstall')}
        </PanelButton>
        <PanelButton variant="secondary" size="md" style={{ flex: 1 }} disabled={busy} onClick={() => { setUninstallConfirmKey(null) }}>{t('capability.cancel')}</PanelButton>
      </div>
    )
  }

  const renderCard = (item: CapabilityItem): React.ReactNode => {
    const key = `${item.kind}:${item.name}`
    const busy = action?.key === key && (action.kind === 'installing' || action.kind === 'uninstalling' || action.kind === 'uploading')
    // 别的卡片正在装/卸/上传时，本卡片的按钮必须**置灰**：`install()`/`uninstall()`/`upload()`
    // 第一行是 `action 在飞就 return`，此前按钮外观仍是可点的启用态 ⇒ 慢安装期间其它卡片
    // 表现为"死按钮"（点了没反应、也没有任何提示，2026-09-21 审计）。
    const blocked = busy || inFlight
    const title = item.displayName || item.name
    const isLocal = item.source === 'local'
    // 页脚动作的唯一判定（A6/N1）：本机内置（builtin/plugin）行与商店行都不在这里各判一次。
    const plan = planCardAction(item)
    /**
     * 两态说明（R5-B-1 / R5-B-2）都在这里取一次 —— 徽章、置灰、说明文字必须同源，
     * 否则会出现"卡片说已下架、按钮却是上传"的自相矛盾（正是这两条 finding 的形态）。
     */
    const delisted = isDelistedItem(item)
    const transferred = isTransferredItem(item)
    return (
      <Card key={key} interactive muted={item.status === 'rejected' || delisted} style={CARD} className="pico-skill-card">
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
        {/* 状态说明（R5-B-1 / R5-B-2）：徽章只给结论，这一行走的是"为什么 + 还能做什么"。
            应用中心同款位置（`appCenter.publishNewDisabled` 也是卡片里的说明段）。 */}
        {(delisted || transferred) && (
          <p
            style={{ ...META, whiteSpace: 'normal', overflow: 'visible', textOverflow: 'clip' }}
            data-role={transferred ? 'card-transferred-reason' : 'card-delisted-reason'}
          >
            {transferred ? t('capability.transferredHint') : t('capability.delistedHint')}
          </p>
        )}
        {uninstallConfirmKey === key && needsOverwriteConfirm(item) && (
          <p style={{ ...META, color: 'var(--dsw-alias-state-error-primary)', whiteSpace: 'pre-wrap' }} data-role="local-remove-warning">
            {/* 两档成因走两句话（R4-B-3）：本机自制 vs 商店装来但被你改过 ——
                后者说成"本机自制技能"是错的，会让用户以为这份不是从能力中心装的。 */}
            {overwriteConfirmReason(item) === 'dirty'
              ? t('capability.confirmUninstallDirty', { name: item.name })
              : t('capability.confirmUninstallLocal', { name: item.name })}
          </p>
        )}
        <div style={CARD_FOOT}>
          {/* 页脚动作由 planCardAction 唯一决定（A6/N1）；这里只做按钮映射。 */}
          {plan.kind === 'uninstall' ? renderUninstall(item, key, busy, blocked)
            : plan.kind === 'update' ? (
              // 更新按钮**不传 force**（审计 A15）：走 install() 自己的来源判定 ——
              // 商店那一份直接更新，本机自制同名内容则先出确认条。
              <PanelButton variant="primary" size="md" block disabled={blocked || item.official} title={item.official ? t('capability.officialLocked') : undefined} onClick={() => { void install(item) }}>
                {t('capability.updateTo', { version: plan.version })}
              </PanelButton>
            )
              : plan.kind === 'reupload'
                ? <PanelButton variant="secondary" size="md" block disabled={blocked} onClick={() => { void upload(item) }}>{t('capability.reupload')}</PanelButton>
                : plan.kind === 'review'
                  ? <span style={{ flex: 1, display: 'flex', justifyContent: 'center' }}><Chip tone={plan.status === 'pending' ? 'warn' : 'success'}>{plan.status === 'pending' ? t('capability.awaitingReview') : t('capability.approved')}</Chip></span>
                  // 已转交（R5-B-2）：这一格**没有**可达动作 —— 上传会被服务端 409 挡下，
                  // 所以给状态胶囊而不是假按钮（形态与「等待审核」那一档一致）。
                  : plan.kind === 'transferred'
                    ? <span style={{ flex: 1, display: 'flex', justifyContent: 'center' }}><Chip tone="warn">{t('capability.transferred')}</Chip></span>
                    // 已下架且本机没有可卸的一份（R5-B-1）：同样只报状态。
                    : plan.kind === 'delisted'
                      ? <span style={{ flex: 1, display: 'flex', justifyContent: 'center' }}><Chip tone="neutral" plain>{t('capability.delisted')}</Chip></span>
                      // 符号链接形态（R17B-01）：`packSkill` 有意拒收（避免把链接目标里的
                      // 库外文件打进上传包）⇒ 上传按钮点了必然失败，这一格只标事实。
                      : plan.kind === 'linked'
                        ? <span style={{ flex: 1, display: 'flex', justifyContent: 'center' }}><Chip tone="neutral" plain>{t('capability.originSymlink')}</Chip></span>
                      : plan.kind === 'upload'
                      ? <PanelButton variant="primary" size="md" block disabled={blocked} onClick={() => { void upload(item) }}>{t('capability.upload')}</PanelButton>
                      : <PanelButton variant="primary" size="md" block disabled={blocked} onClick={() => { void install(item) }}>{t('capability.install')}</PanelButton>}
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
                setInstallConfirm(null)
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
        {/* 结果条/确认条挂在滚动区顶部，出现时滚进视口（见 noticeRef 的注释）。 */}
        <div ref={noticeRef}>
        {installConfirm !== null && (
          <Card style={{ padding: '10px 14px', borderRadius: 12, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <icons.IconAlert size={15} style={{ color: 'var(--dsw-alias-state-warn-label)' }} />
            <span style={{ flex: 1, minWidth: 200, fontSize: 13 }}>
              {confirmStripText(installConfirm)}
            </span>
            <PanelButton variant="primary" size="sm" onClick={() => {
              const pending = installConfirm
              setInstallConfirm(null)
              // 重放的是**同一发**安装（含用户在详情弹层里点选的版本，审计 A11），
              // 并且只有这里才把 `?overwrite=1` 交给宿主（用户确认过的唯一凭据）。
              void pending.run(true)
            }}>{confirmStripAction(installConfirm)}</PanelButton>
            <PanelButton variant="secondary" size="sm" onClick={() => { setInstallConfirm(null) }}>{t('capability.cancel')}</PanelButton>
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
        </div>
        <div style={PANEL_GRID} data-role="capability-grid">{content}</div>
      </PanelPage>
      {detail !== null && (
        <CapabilityDetailDialog
          target={detail}
          busy={action?.key === (detail.kind === 'item' ? `${detail.item.kind}:${detail.item.name}` : `builtin:${detail.card.skill.name}`)}
          // 站级闸：`install()` 对"有动作在飞"静默 return，弹层按钮必须与它同源禁用
          //（审计 C-03）。详情本身仍可打开 —— 看详情不该被别的动作禁止。
          blocked={inFlight}
          onInstallVersion={version => {
            if (detail.kind !== 'item') return
            // 不传 overwrite：本机自制同名时先出确认条（审计 A15）；版本随意图一起
            // 存进确认条，确认后重放的还是这一个版本（A11）。
            void install(detail.item, { version })
          }}
          onClose={() => { setDetail(null) }}
        />
      )}
    </div>
  )
}
