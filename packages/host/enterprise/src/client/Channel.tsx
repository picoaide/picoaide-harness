import { createElement, useState, type ReactElement } from 'react'
import {
  BRAND_CONNECTOR,
  BRAND_MARK_BRACES,
  BRAND_MARK_STROKE_WIDTH,
  BRAND_MARK_TRANSFORM,
  BRAND_NODES,
  BRAND_TILE_RADIUS_RATIO,
  BRAND_TILE_VIEWBOX,
} from '../channel-geometry.ts'
import { DEFAULT_CHANNEL, nonEmpty, type ChannelConfig } from '../channel-content.ts'
import { useChannel } from './channel-store.ts'
import { UpdateIndicator, useUpdateState } from './UpdateIndicator.tsx'

// build-time 版本注入(tsdown define 替换为字符串字面量);浏览器编译面无
// node types(tsconfig.client.json types:[]),声明最小面的 process 占位。
declare const process: { env: { PICOAI_PRODUCT_VERSION?: string } }

/**
 * Brace mark tile matching the app/tray icon: a rounded square carrying the
 * two braces, connector line, and node circles. Rendered at the upstream
 * brand slots (`sidebar.brand.mark`, `conversation.hero.brand.mark`) as a
 * single declarative occupant, so the upstream layout owns geometry and
 * fallbacks while this component owns only the artwork.
 *
 * Artwork matches `brands/official/logo.svg` exactly: the
 * braces sit on a full-bleed rounded square and are enlarged 1.25× around
 * the canvas center (translate/scale/translate of the source paths).
 *
 * Theme adaptation uses design tokens instead of a dark-theme body hook: the
 * tile takes the foreground ink (black on light, white on dark) and the
 * braces take the base surface, so the tile flips with the skin system.
 */
/** Braces + connector + nodes in brands/official/logo.svg coordinates, enlarged 1.25×.
 * The numbers come from ../channel-geometry.ts (drift-guarded against the SVG). */
function BraceGlyph() {
  return createElement(
    'svg',
    {
      viewBox: BRAND_TILE_VIEWBOX,
      width: '100%',
      height: '100%',
      fill: 'none',
      stroke: 'currentColor',
      'aria-hidden': true,
    },
    createElement(
      'g',
      { transform: BRAND_MARK_TRANSFORM },
      ...BRAND_MARK_BRACES.map(path => createElement('path', {
        key: path,
        d: path,
        strokeWidth: BRAND_MARK_STROKE_WIDTH,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      })),
      createElement('line', {
        x1: BRAND_CONNECTOR.x1,
        y1: BRAND_CONNECTOR.y1,
        x2: BRAND_CONNECTOR.x2,
        y2: BRAND_CONNECTOR.y2,
        strokeWidth: BRAND_CONNECTOR.strokeWidth,
        strokeLinecap: 'round',
      }),
      ...BRAND_NODES.map(node => createElement('circle', {
        key: `${String(node.cx)}-${String(node.cy)}`,
        cx: node.cx,
        cy: node.cy,
        r: node.r,
        fill: 'currentColor',
        stroke: 'none',
      })),
    ),
  )
}

/**
 * 渠道 logo 图（服务端下发，指向客户自己的服务器）。
 *
 * **加载失败必须回落**（2026-09-10）：服务端地址不可达（离线/内网 VPN 未连/
 * 服务端换域名）时，`<img>` 会留一个裂图图标 —— 品牌位是渠道客户第一眼看到的
 * 东西，宁可显示内置的花括号 mark，也不要一个破图。登录页早有同款兜底
 * （auth-gate 的 `onerror` 隐藏 img 换成 fallback），客户端这两处此前没有。
 *
 * 失败状态按 **URL** 记（不是布尔）：渠道内容换了新 logo 就该重试，而不是把
 * 上一次的失败一直带下去。
 */
function ChannelLogo({ url, size, alt, radius, fallback }: {
  url: string
  size: number
  alt: string
  radius: number
  fallback: () => ReactElement | null
}): ReactElement | null {
  const [failedUrl, setFailedUrl] = useState<string | undefined>(undefined)
  if (url === failedUrl) return fallback()
  return createElement('img', {
    src: url,
    alt,
    onError: () => { setFailedUrl(url) },
    style: { width: size, height: size, objectFit: 'contain', borderRadius: radius },
  })
}

/**
 * 品牌槽位的**归属标记**：本组件渲染的每一个占用者都带它，上游厂商 mark 没有。
 *
 * 为什么需要它（2026-09-12）：自动化只能用 DOM 判断"这个单占位品牌槽是谁占的"。
 * 早先的断言写成"槽位里的内联 svg 必须含 1.25× 缩放"——那只在**未配渠道 logo**
 * 时成立；渠道包一旦提供 logo（`stageChannelProfile()` 内联成 data: URI），
 * 槽位渲染的是 `<img>`，于是同一个提交在官方构建绿、渠道构建红，直接卡住发布。
 * 渠道会越来越多，逐个枚举合法图形不可维护，所以改为**断言归属**：
 * 有且仅有一个占用者，且它来自我们的品牌层（带本属性）。
 * 图形本身是否等于权威 logo 由 `tests/channel-geometry.spec.ts` 对着
 * `brands/official/logo.svg` 守卫，渠道素材由渠道包与构建期校验负责。
 */
export const BRAND_SEAT_ATTR = 'data-brand-mark'
/** 归属标记的取值（消费方：`scripts/e2e-right-sidebar.mjs` 与单测）。 */
export const BRAND_SEAT_OWNER = 'app'

/**
 * The brace-mark tile; `className` rides along (upstream slot geometry).
 * When a server logo_url is provided (dynamic channel content), an <img> is
 * rendered instead of the brace artwork; failures fall back to the brace.
 */
export function BraceMark({ size, className }: { size: number; className?: string | undefined }) {
  const channel = useChannel()
  const logoUrl = resolveClientLogo(channel)
  const name = resolveClientName(channel)
  const radius = Math.max(4, Math.round(size * BRAND_TILE_RADIUS_RATIO))
  const seat = { [BRAND_SEAT_ATTR]: BRAND_SEAT_OWNER } as const
  // 内置品牌图形（权威 brands/official/logo.svg 的几何，见 channel-geometry.ts）：
  // 既是"渠道没配 logo"时的显示内容，也是 logo 加载失败时的兜底 —— 两者同款。
  const tile = createElement(
    'span',
    {
      className,
      ...seat,
      style: {
        display: 'inline-flex',
        flex: 'none',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
        borderRadius: radius,
        backgroundColor: 'var(--dsw-alias-fg-primary, #000000)',
        color: 'var(--dsw-alias-bg-base, #ffffff)',
      },
    },
    BraceGlyph(),
  )
  if (logoUrl !== undefined) {
    return createElement(
      'span',
      {
        className,
        ...seat,
        style: { display: 'inline-flex', flex: 'none', alignItems: 'center', justifyContent: 'center', width: size, height: size },
      },
      createElement(ChannelLogo, { url: logoUrl, size, alt: name, radius, fallback: () => tile }),
    )
  }
  return tile
}

/**
 * 侧边栏品牌名的**行**样式（导出仅为让测试钉住：这几个值决定它折不折行）。
 *
 * 上游槽位（`ui-sidebar` 的 `.brandName`）是 18px 字号、**24px 定高**的行：
 * 名字一折行就把行撑到 48px，整个侧边栏头部跟着错位（2026-09-11 实测）。
 * `minWidth: 0` 是因为 flex 项默认 `min-width: auto` 不肯收缩 —— 不写它，
 * 内层 `text-overflow: ellipsis` 永远没机会生效。
 */
export const BRAND_NAME_ROW_STYLE = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  fontWeight: 700,
  letterSpacing: '0.3px',
  minWidth: 0,
  maxWidth: '100%',
} as const

/** 品牌名**文本**样式：永远单行，放不下就省略号（全名挂在 `title` 上）。 */
export const BRAND_NAME_TEXT_STYLE = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
} as const

/**
 * 侧边栏品牌名（`sidebar.brand.name` 槽）。
 *
 * 两条约束，缺一个就出事（2026-09-11 现场）：
 *  1. **用短名**（`client.short_name`）—— 服务端不下发这一项，它是随包品牌独有的
 *     字段（`/api/pico/channel` 出口会把它叠回来）；拿不到就会回落到显示名
 *     "PicoAide Harness"，在 184px 的行里折成两行。
 *  2. **不折行**：见上面两个样式常量。
 */
export function BrandName() {
  const channel = useChannel()
  const version = process.env.PICOAI_PRODUCT_VERSION as string | undefined
  const updateState = useUpdateState()
  const name = resolveClientShortName(channel)
  return createElement(
    'span',
    // 归属标记与 BraceMark 同源（见 BRAND_SEAT_ATTR 的说明）：品牌**名字**槽同样是
    // single 占位槽，上游兜底会渲染 `brand.localBuild`（"DSH 本地构建"）—— 自动化要
    // 判断"这一格是谁占的"只能靠这个属性（2026-09-12 打包版 e2e 实测：名字槽因缺标记
    // 被判成 FOREIGN，与真实渲染无关）。
    { title: name, style: BRAND_NAME_ROW_STYLE, [BRAND_SEAT_ATTR]: BRAND_SEAT_OWNER },
    createElement('span', { style: BRAND_NAME_TEXT_STYLE }, name),
    version != null && version !== ''
      ? createElement('span', {
          style: {
            flex: 'none',
            fontSize: 10,
            fontWeight: 600,
            lineHeight: 1,
            letterSpacing: '0',
            padding: '2px 5px',
            borderRadius: '4px',
            color: 'var(--dsw-alias-bg-base, #ffffff)',
            backgroundColor: 'var(--dsw-alias-fg-primary, #000000)',
            opacity: 0.75,
          },
        }, `v${version}`)
      : null,
    createElement(UpdateIndicator, { state: updateState }),
  )
}

/** Right-top brand badge (conversation.session.header.actions slot). */
export function BrandBadge() {
  const channel = useChannel()
  const logo = resolveClientLogo(channel)
  const name = resolveClientName(channel)
  return createElement(
    'span',
    { style: { display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--dsw-alias-fg-secondary, #666)', opacity: 0.85 } },
    // 加载失败只是不显示这张小图（名字还在），不占位破图。
    logo ? createElement(ChannelLogo, { url: logo, size: 16, alt: '', radius: 3, fallback: () => null }) : null,
    name,
  )
}

/**
 * Resolve the client-side display name from a channel config (or default).
 *
 * 兜底是**内置官方内容**（`DEFAULT_CHANNEL`）：渠道构建下走不到这里 ——
 * 组装期注入的随包品牌先落地（`channel-store` 的 seed），服务端可达后再覆盖。
 */
function resolveClientName(channel: ChannelConfig | null | undefined): string {
  return nonEmpty(channel?.client?.display_name) ?? DEFAULT_CHANNEL.client?.display_name ?? ''
}

/**
 * Resolve the sidebar/短名 from a channel config.
 *
 * 侧边栏空间窄，用的是短名（`identity.short_name`，官方渠道即官方短名）；
 * 服务端不下发这一项，所以它来自随包品牌（`/api/pico/channel` 出口叠加），
 * 缺省回落到显示名 —— 宁可显示长名字（截断），也不显示别人家的短名。
 * 导出供测试（`tests/channel-brand-name.spec.ts`）。
 */
export function resolveClientShortName(channel: ChannelConfig | null | undefined): string {
  return nonEmpty(channel?.client?.short_name)
    ?? nonEmpty(channel?.client?.display_name)
    ?? DEFAULT_CHANNEL.client?.short_name
    ?? ''
}

/** Resolve the client logo URL from a channel config. */
function resolveClientLogo(channel: ChannelConfig | null | undefined): string | undefined {
  return channel?.client?.logo_url
}
