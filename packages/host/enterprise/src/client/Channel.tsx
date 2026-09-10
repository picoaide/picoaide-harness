import { createElement } from 'react'
import {
  BRAND_CONNECTOR,
  BRAND_MARK_BRACES,
  BRAND_MARK_STROKE_WIDTH,
  BRAND_MARK_TRANSFORM,
  BRAND_NODES,
  BRAND_TILE_RADIUS_RATIO,
  BRAND_TILE_VIEWBOX,
} from '../channel-geometry.ts'
import { DEFAULT_CHANNEL, type ChannelConfig } from '../channel-content.ts'
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
 * The brace-mark tile; `className` rides along (upstream slot geometry).
 * When a server logo_url is provided (dynamic channel content), an <img> is
 * rendered instead of the brace artwork; failures fall back to the brace.
 */
export function BraceMark({ size, className }: { size: number; className?: string | undefined }) {
  const channel = useChannel()
  const logoUrl = resolveClientLogo(channel)
  const name = resolveClientName(channel)
  if (logoUrl) {
    return createElement('span', {
      className,
      style: {
        display: 'inline-flex',
        flex: 'none',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
      },
    }, createElement('img', {
      src: logoUrl,
      alt: name,
      style: { width: size, height: size, objectFit: 'contain', borderRadius: Math.max(4, Math.round(size * BRAND_TILE_RADIUS_RATIO)) },
    }))
  }
  return createElement(
    'span',
    {
      className,
      style: {
        display: 'inline-flex',
        flex: 'none',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
        borderRadius: Math.max(4, Math.round(size * BRAND_TILE_RADIUS_RATIO)),
        backgroundColor: 'var(--dsw-alias-fg-primary, #000000)',
        color: 'var(--dsw-alias-bg-base, #ffffff)',
      },
    },
    BraceGlyph(),
  )
}

export function BrandName() {
  const channel = useChannel()
  const version = process.env.PICOAI_PRODUCT_VERSION as string | undefined
  const updateState = useUpdateState()
  const name = resolveClientShortName(channel)
  return createElement(
    'span',
    { style: { display: 'inline-flex', alignItems: 'center', gap: '6px', fontWeight: 700, letterSpacing: '0.3px' } },
    name,
    version != null && version !== ''
      ? createElement('span', {
          style: {
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
    logo ? createElement('img', { src: logo, alt: '', style: { width: 16, height: 16, objectFit: 'contain', borderRadius: 3 } }) : null,
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
 * 服务端不下发这一项，所以它来自随包品牌，缺省回落到显示名。
 */
function resolveClientShortName(channel: ChannelConfig | null | undefined): string {
  return nonEmpty(channel?.client?.short_name)
    ?? nonEmpty(channel?.client?.display_name)
    ?? DEFAULT_CHANNEL.client?.short_name
    ?? ''
}

/** 非空字符串（'' 是"渠道没配这一项"，等同于缺失）。 */
function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value !== '' ? value : undefined
}

/** Resolve the client logo URL from a channel config. */
function resolveClientLogo(channel: ChannelConfig | null | undefined): string | undefined {
  return channel?.client?.logo_url
}
