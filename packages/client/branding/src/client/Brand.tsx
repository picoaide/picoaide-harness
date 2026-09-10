import { createElement } from 'react'
import {
  BRAND_CONNECTOR,
  BRAND_MARK_BRACES,
  BRAND_MARK_STROKE_WIDTH,
  BRAND_MARK_TRANSFORM,
  BRAND_NODES,
  BRAND_TILE_RADIUS_RATIO,
  BRAND_TILE_VIEWBOX,
} from './channel-geometry.ts'

// build-time 版本注入(tsdown define 替换为字符串字面量);浏览器编译面无
// node types,声明最小面的 process 占位。
declare const process: { env: { PICOAI_PRODUCT_VERSION?: string } }

/**
 * Brace mark tile matching the brand folder icon (`brands/official/logo.svg`):
 * a rounded square carrying the two braces, connector line, and node circles.
 * Rendered at the upstream brand slots (`sidebar.brand.mark`,
 * `conversation.hero.brand.mark`) as a single declarative occupant.
 *
 * NOTE: this component is intentionally duplicated from
 * `packages/host/enterprise/src/client/Channel.tsx` (same artwork, same tokens):
 * the web profile deploys this package standalone and cross-package client
 * imports are disallowed by the plugin convention. Keep both in sync.
 *
 * Theme adaptation uses design tokens instead of a dark-theme body hook: the
 * tile takes the foreground ink (black on light, white on dark) and the
 * braces take the base surface, so the tile flips with the skin system.
 *
 * Artwork matches `brands/official/logo.svg` exactly: the
 * braces sit on a full-bleed rounded square and are enlarged 1.25× around
 * the canvas center (translate/scale/translate of the source paths).
 */
const BRACE_TILE_VIEWBOX = BRAND_TILE_VIEWBOX
const BRACE_TILE_RADIUS_RATIO = BRAND_TILE_RADIUS_RATIO

/** Braces + connector + nodes in brands/official/logo.svg coordinates, enlarged 1.25×. */
function BraceGlyph() {
  return createElement(
    'svg',
    {
      viewBox: BRACE_TILE_VIEWBOX,
      width: '100%',
      height: '100%',
      fill: 'none',
      stroke: 'currentColor',
      'aria-hidden': true,
    },
    createElement(
      'g',
      { transform: BRAND_MARK_TRANSFORM },
      ...BRAND_MARK_BRACES.map(brace => createElement('path', {
        key: brace,
        d: brace,
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
        key: `${node.cx}-${node.cy}`,
        cx: node.cx,
        cy: node.cy,
        r: node.r,
        fill: 'currentColor',
        stroke: 'none',
      })),
    ),
  )
}

/** The brace-mark tile; `className` rides along (upstream slot geometry). */
export function BraceMark({ size, className }: { size: number; className?: string | undefined }) {
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
        borderRadius: Math.max(4, Math.round(size * BRACE_TILE_RADIUS_RATIO)),
        backgroundColor: 'var(--dsw-alias-fg-primary, #000000)',
        color: 'var(--dsw-alias-bg-base, #ffffff)',
      },
    },
    BraceGlyph(),
  )
}

/**
 * Sidebar brand name occupant. The upstream brand-name container owns
 * typography; this component supplies only the product name text, plus a
 * small product-version label next to it (build-time injected via
 * `process.env.PICOAI_PRODUCT_VERSION` define in tsdown.config.ts).
 */
export function BrandName() {
  const version = process.env.PICOAI_PRODUCT_VERSION as string | undefined
  return createElement(
    'span',
    { style: { display: 'inline-flex', alignItems: 'center', gap: '6px', fontWeight: 700, letterSpacing: '0.3px' } },
    'PicoAide',
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
  )
}
