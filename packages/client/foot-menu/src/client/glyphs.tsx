/**
 * 「更多」行与浮层条目的图标表。
 *
 * 五个面板图标是**逐字**从被替换的五个 trigger 组件搬来的 SVG 几何（2026-09-21
 * 并道改造）：图标不再住在各自的插件里 —— 条目只跨 bundle 传数据（id / 文案 /
 * 动作），ReactNode 不过界。
 *
 * 新增条目时：id 与 panel-surface 的 PanelId 同名即可拿到对应图标；未登记的 id
 * 落到 {@link FALLBACK_GLYPH}（不是"没有图标"，而是"这个 id 还没有专属图形"）。
 *
 * @module @picoaide/dsh-foot-menu/client/glyphs
 */

import type { CSSProperties, ReactNode } from 'react'

/** 图标盒：不参与伸缩，行内块由外层 flex 控制。 */
const GLYPH_STYLE: CSSProperties = { flex: 'none', display: 'block' }

/** 「定时任务」（原 CronTrigger）。 */
const CRON: ReactNode = (
  <>
    <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.3" />
    <path d="M8 4.5V8l2.2 1.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </>
)

/** 「能力中心」（原 CapabilityCenterTrigger）。 */
const CAPABILITY: ReactNode = (
  <>
    <rect x="2" y="2" width="12" height="12" rx="2.5" stroke="currentColor" strokeWidth="1.3" />
    <path d="M5 5h6M5 8h6M5 11h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </>
)

/** 「连接器」（原 ConnectorTrigger）。 */
const CONNECTORS: ReactNode = (
  <>
    <rect x="2.5" y="6.5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
    <path d="M6 6.5V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v1.5M6 10.5h2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </>
)

/** 「浏览器」（原 BrowserTrigger）。 */
const BROWSER: ReactNode = (
  <>
    <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.3" />
    <circle cx="8" cy="8" r="2.4" stroke="currentColor" strokeWidth="1.3" />
    <path d="M8 1.8v2.4M8 11.8v2.4M1.8 8h2.4M11.8 8h2.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </>
)

/** 「应用中心」（原 AppCenterTrigger）。 */
const APPS: ReactNode = (
  <>
    <rect x="1.8" y="1.8" width="5.4" height="5.4" rx="1.4" stroke="currentColor" strokeWidth="1.3" />
    <rect x="8.8" y="1.8" width="5.4" height="5.4" rx="1.4" stroke="currentColor" strokeWidth="1.3" />
    <rect x="1.8" y="8.8" width="5.4" height="5.4" rx="1.4" stroke="currentColor" strokeWidth="1.3" />
    <rect x="8.8" y="8.8" width="5.4" height="5.4" rx="1.4" stroke="currentColor" strokeWidth="1.3" />
  </>
)

/** 「更多」行自己的图标：三个点（⋯，与文案同级）。 */
export const MORE_GLYPH: ReactNode = (
  <>
    <circle cx="3.4" cy="8" r="1.3" fill="currentColor" />
    <circle cx="8" cy="8" r="1.3" fill="currentColor" />
    <circle cx="12.6" cy="8" r="1.3" fill="currentColor" />
  </>
)

/** 未登记 id 的兜底图形（通用面板标记，不是"无图标"）。 */
export const FALLBACK_GLYPH: ReactNode = (
  <>
    <rect x="2.5" y="2.5" width="11" height="11" rx="2.5" stroke="currentColor" strokeWidth="1.3" />
    <path d="M5.5 8h5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </>
)

/** 条目 id → 图标（id 与 panel-surface 的 PanelId 同名）。 */
const GLYPHS: Record<string, ReactNode> = {
  cron: CRON,
  capability: CAPABILITY,
  connectors: CONNECTORS,
  browser: BROWSER,
  apps: APPS,
}

/** 浮层条目里的 ✓（当前激活项）。 */
export const CHECK_GLYPH: ReactNode = (
  <path d="M3.5 8.6 6.4 11.5 12.5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
)

/** 「更多」行的尾部 chevron（展开时朝上 = 旋转 180°）。 */
export const CHEVRON_GLYPH: ReactNode = (
  <path d="M4 6.5 8 10.5 12 6.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
)

/**
 * 渲染一个 16×16 视图盒里的图标。
 * @param props.id - 条目 id；未登记时用兜底图形。
 * @param props.size - 边长（宽栏 16 / 窄轨 18 / 浮层条目 16）。
 * @param props.glyph - 覆盖用图形（行自己的「更多」图标与 ✓）。
 * @param props.style - 追加到 svg 上的行内样式（尾部 chevron 用它做展开旋转）。
 * @returns 图标元素（`currentColor` 上色，随文字颜色）。
 */
export function FootMenuGlyph({ id, size, glyph, style }: { id?: string, size: number, glyph?: ReactNode, style?: CSSProperties }): JSX.Element {
  const content = glyph ?? (id === undefined ? FALLBACK_GLYPH : GLYPHS[id] ?? FALLBACK_GLYPH)
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ ...GLYPH_STYLE, ...style }}>
      {content}
    </svg>
  )
}
