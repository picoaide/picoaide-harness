/**
 * 面板的共享视觉语言（四个整页面板同一套骨架与控件）。
 *
 * ## 分工（改样式前先读这条）
 *
 * **颜色与交互反馈在样式表里**（`stylesheet.ts` 的 `.pico-*` 类：`:hover` /
 * `:focus-visible` / `:active` 没有内联表达方式，一旦把颜色写进行内联样式，悬停反馈
 * 就再也做不出来）；**几何在内联样式里**（尺寸/间距/圆角按调用点微调最方便）。
 *
 * 所以：不要在这些组件上写 `background` / `color` / `border-color` 的内联样式，
 * 需要新配色就加 `.pico-btn--xxx` / 用 `<Chip tone>`。
 *
 * @module @picoaide/dsh-panel-surface/client/ui
 */

import { forwardRef } from 'react'

import { IconBack } from './icons.tsx'

/** 语义色调（映射到会随主题翻转的 DSH alias token，不写死颜色）。 */
export type PanelTone = 'neutral' | 'brand' | 'success' | 'warn' | 'danger' | 'accent'

/** 色调 → 文字色（徽章底色由 `.pico-chip` 用 `currentColor` 派生）。 */
export const TONE_COLOR: Record<PanelTone, string> = {
  neutral: 'var(--dsw-alias-label-secondary)',
  brand: 'var(--dsw-alias-brand-primary)',
  success: 'var(--dsw-alias-state-success-primary)',
  warn: 'var(--dsw-alias-state-warn-label)',
  danger: 'var(--dsw-alias-state-error-primary)',
  accent: 'var(--dsw-alias-state-business-primary)',
}

/** 按钮变体 → `.pico-btn--*` 类。 */
export type PanelButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
/** 按钮尺寸（高度 / 横向内边距 / 字号 / 圆角）。 */
export type PanelButtonSize = 'sm' | 'md' | 'lg'

const BUTTON_SIZE: Record<PanelButtonSize, React.CSSProperties> = {
  sm: { height: 24, padding: '0 8px', fontSize: 12, borderRadius: 7 },
  md: { height: 30, padding: '0 12px', fontSize: 13, borderRadius: 9 },
  lg: { height: 34, padding: '0 14px', fontSize: 13, borderRadius: 10 },
}

export interface PanelButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: PanelButtonVariant | undefined
  size?: PanelButtonSize | undefined
  /** 按钮文字前的图标（已 size 好）。 */
  icon?: React.ReactNode | undefined
  /** 撑满可用宽度。 */
  block?: boolean | undefined
}

/**
 * 面板统一按钮。
 *
 * 用 `forwardRef` 而不是普通函数组件：调用方真的需要拿到底层 `<button>`
 * （应用中心的二次确认块把焦点移进确认按钮）—— 函数组件上的 `ref` 会被 React
 * 直接丢掉，并打印 "Function components cannot be given refs"。
 * @param props - 变体、尺寸、图标与原生 button 属性。
 */
export const PanelButton = forwardRef<HTMLButtonElement, PanelButtonProps>(function PanelButton(
  { variant = 'secondary', size = 'md', icon, block, children, style, className, type, ...rest },
  ref,
): JSX.Element {
  return (
    <button
      // `type` 必须**排在 `{...rest}` 之前**：渲染出的属性顺序决定 DOM 的字符串形状，
      // 而库外多个套件的守卫断言写的是 `/<button type="button"/`（要求 type 紧跟
      // `<button`）。把它放到 spread 之后会让那些断言在"功能完全正常"的情况下变红。
      type={type ?? 'button'}
      {...rest}
      ref={ref}
      className={`pico-btn pico-btn--${variant}${className === undefined ? '' : ` ${className}`}`}
      style={{ ...BUTTON_SIZE[size], ...(block === true ? { width: '100%' } : {}), ...style }}
    >
      {icon}
      {children}
    </button>
  )
})

export interface ChipProps {
  tone?: PanelTone | undefined
  /** 只描边不填底（信息量更低的一档）。 */
  plain?: boolean | undefined
  title?: string | undefined
  className?: string | undefined
  children: React.ReactNode
}

/**
 * 语义徽章。底色由 `currentColor` 派生，所以调用方只表达"什么语义"。
 * @param props - 色调、是否描边式、提示文案与内容。
 */
export function Chip({ tone = 'neutral', plain, title, className, children }: ChipProps): JSX.Element {
  return (
    <span
      className={`pico-chip${className === undefined ? '' : ` ${className}`}`}
      {...(plain === true ? { 'data-plain': 'true' } : {})}
      {...(title === undefined ? {} : { title })}
      style={{ color: TONE_COLOR[tone] }}
    >
      {children}
    </span>
  )
}

/**
 * 卡片属性：除两个自定义开关外，**透传原生 div 属性**（`data-*` / `role` / `aria-*`）。
 *
 * 透传是必须的：库外的自动化与真机探针全靠 `data-role` / `data-action` 这类稳定钩子
 * 定位元素，组件自己吃掉它们会让既有断言集体失效。
 */
export interface CardProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children'> {
  /** 可点击/可聚焦的卡片（加上浮起反馈）。 */
  interactive?: boolean | undefined
  /** 弱化展示（已下架/已停用这类）。 */
  muted?: boolean | undefined
  children?: React.ReactNode
}

/**
 * 面板统一卡片外框。
 * @param props - 交互态、弱化态、原生 div 属性与内容。
 */
export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { interactive, muted, className, children, ...rest },
  ref,
): JSX.Element {
  return (
    <div
      {...rest}
      ref={ref}
      className={`pico-card${className === undefined ? '' : ` ${className}`}`}
      {...(interactive === true ? { 'data-interactive': 'true' } : {})}
      {...(muted === true ? { 'data-muted': 'true' } : {})}
    >
      {children}
    </div>
  )
})

export interface IconTileProps {
  tone?: PanelTone | undefined
  size?: number | undefined
  radius?: number | undefined
  /** 方块里的字符（首字母头像用）。 */
  label?: string
  className?: string
  children?: React.ReactNode
}

/**
 * 圆角图标块（同时也是"首字母头像"：列表/卡片左侧的视觉锚点）。
 *
 * 底色用 `color-mix` 从色调派生 14% 的浅底 —— 硬编码浅色在暗色主题下会变成灰块
 * （本仓门户页与能力中心都踩过）。
 * @param props - 色调、尺寸与内容。
 */
export function IconTile({ tone = 'brand', size = 36, radius = 11, label, className, children }: IconTileProps): JSX.Element {
  const color = TONE_COLOR[tone]
  return (
    <span
      className={`pico-tile${className === undefined ? '' : ` ${className}`}`}
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        color,
        background: `color-mix(in srgb, ${color} 14%, transparent)`,
        fontSize: Math.round(size * 0.42),
      }}
    >
      {label ?? children}
    </span>
  )
}

export interface SegmentedControlOption<T extends string> {
  value: T
  label: string
  /** 可选的计数（渲染成标签后的弱化数字）。 */
  count?: number | undefined
}

export interface SegmentedControlProps<T extends string> {
  value: T
  options: ReadonlyArray<SegmentedControlOption<T>>
  onChange: (next: T) => void
  ariaLabel: string
}

/**
 * 分段切换（整页面板里代替标签页的那一条）。
 *
 * 用真实 `<button role="tab">` 而不是无样式 div：键盘可达性与读屏语义都不能省。
 * @param props - 当前值、选项与变更回调。
 */
export function SegmentedControl<T extends string>({ value, options, onChange, ariaLabel }: SegmentedControlProps<T>): JSX.Element {
  return (
    <div className="pico-seg" role="tablist" aria-label={ariaLabel}>
      {options.map(option => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={option.value === value}
          data-active={option.value === value ? 'true' : 'false'}
          onClick={() => { onChange(option.value) }}
        >
          {option.label}
          {option.count === undefined ? null : (
            <span style={{ marginLeft: 6, opacity: 0.6, fontSize: 11 }}>{option.count}</span>
          )}
        </button>
      ))}
    </div>
  )
}

export interface PanelPageProps {
  title: string
  subtitle?: string | undefined
  /** 标题左侧的图标（16–18px 的线条图标）。 */
  icon?: React.ReactNode | undefined
  /** 返回会话区的出口（整页面板的唯一出口，必填）。 */
  onClose: () => void
  backLabel: string
  /** 头部右侧的主操作区。 */
  actions?: React.ReactNode | undefined
  /** 头部下方的工具条（搜索 / 筛选），带自己的分隔线。 */
  toolbar?: React.ReactNode | undefined
  /** 正文内容宽度上限（默认 1120，窄面板可调小）。 */
  width?: number | undefined
  /** 正文是否自带内边距（表格类布局可关掉）。 */
  padded?: boolean | undefined
  children: React.ReactNode
}

/**
 * 整页面板的骨架：返回出口 + 标题区 + 工具条 + 可滚动正文。
 *
 * 四个面板共用它，所以"从会话区翻过来"的手感与信息层级在四个面板里一致 ——
 * 这正是这次改造要解决的原始问题（此前四个面板两套切换语义、三套卡片样式）。
 * @param props - 标题、返回出口、工具条与正文。
 */
export function PanelPage({ title, subtitle, icon, onClose, backLabel, actions, toolbar, width = 1120, padded = true, children }: PanelPageProps): JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minWidth: 0,
        fontSize: 13,
        color: 'var(--dsw-alias-label-primary)',
      }}
    >
      <header
        style={{
          flex: 'none',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '11px 20px',
          borderBottom: '1px solid var(--dsw-alias-border-l2)',
        }}
      >
        <PanelButton variant="secondary" size="sm" icon={<IconBack size={14} />} onClick={onClose} aria-label={backLabel}>
          {backLabel}
        </PanelButton>
        {icon === undefined ? null : <IconTile size={30} radius={9} tone="brand">{icon}</IconTile>}
        <div style={{ minWidth: 0, flex: 1 }}>
          <h2 style={{ margin: 0, fontSize: 15, lineHeight: '22px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {title}
          </h2>
          {subtitle === undefined ? null : (
            <p style={{ margin: '1px 0 0', fontSize: 12, lineHeight: '16px', color: 'var(--dsw-alias-label-caption)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {subtitle}
            </p>
          )}
        </div>
        {actions === undefined ? null : <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 'none' }}>{actions}</div>}
      </header>
      {toolbar === undefined ? null : (
        <div style={{ flex: 'none', padding: '10px 20px', borderBottom: '1px solid var(--dsw-alias-border-l2)' }}>{toolbar}</div>
      )}
      <div className="pico-scroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        <div style={{ maxWidth: width, margin: '0 auto', padding: padded ? '18px 20px 34px' : 0 }}>{children}</div>
      </div>
    </div>
  )
}

export interface PanelStatsProps {
  items: ReadonlyArray<{ label: string; value: string; tone?: PanelTone | undefined }>
}

/**
 * 顶部的一行统计块（给整页面板一个"仪表盘"的视觉锚点）。
 *
 * 只放**已有事实**的聚合：不新增任何数据源，也不放额度/用量口径以外的编造数字。
 * @param props - 统计项。
 */
export function PanelStats({ items }: PanelStatsProps): JSX.Element {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 16 }}>
      {items.map(item => (
        <div
          key={item.label}
          className="pico-card"
          style={{ flex: '1 1 150px', minWidth: 0, borderRadius: 12, padding: '10px 14px' }}
        >
          <div style={{ fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-caption)' }}>{item.label}</div>
          <div style={{ marginTop: 2, fontSize: 18, lineHeight: '26px', fontWeight: 600, color: item.tone === undefined ? 'var(--dsw-alias-label-primary)' : TONE_COLOR[item.tone] }}>
            {item.value}
          </div>
        </div>
      ))}
    </div>
  )
}

export interface EmptyStateProps {
  icon?: React.ReactNode | undefined
  tone?: PanelTone | undefined
  title: string
  description?: string | undefined
  action?: React.ReactNode | undefined
}

/**
 * 空态（所有"没有内容"的分支统一走它，不要各写一段灰字）。
 * @param props - 图标、标题、说明与主操作。
 */
export function EmptyState({ icon, tone = 'neutral', title, description, action }: EmptyStateProps): JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 8,
        padding: '42px 24px',
        textAlign: 'center',
      }}
    >
      {icon === undefined ? null : <IconTile size={46} radius={15} tone={tone}>{icon}</IconTile>}
      <div style={{ fontSize: 14, lineHeight: '22px', fontWeight: 600 }}>{title}</div>
      {description === undefined ? null : (
        <div style={{ fontSize: 12, lineHeight: '19px', color: 'var(--dsw-alias-label-secondary)', maxWidth: 420 }}>{description}</div>
      )}
      {action === undefined ? null : <div style={{ marginTop: 6, display: 'flex', gap: 8 }}>{action}</div>}
    </div>
  )
}

/** 主体内容栅格（自适应列数；卡片区的默认布局）。 */
export const PANEL_GRID: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(268px, 1fr))',
  gap: 12,
  alignContent: 'start',
}

/** 工具条里的一行控件（左侧筛选 + 右侧搜索的默认排布）。 */
export const PANEL_TOOLBAR: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  flexWrap: 'wrap',
}

/** 面板里统一尺寸的搜索框外观（几何在这里，颜色在样式表）。 */
export const PANEL_SEARCH: React.CSSProperties = {
  flex: '1 1 220px',
  minWidth: 0,
  maxWidth: 320,
  boxSizing: 'border-box',
  height: 30,
  padding: '0 11px',
  borderRadius: 9,
  border: '1px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-layer-1, transparent)',
  color: 'var(--dsw-alias-label-primary)',
  fontFamily: 'inherit',
  fontSize: 13,
  outline: 'none',
}
