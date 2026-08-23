import { createElement } from 'react'

/**
 * Brace mark tile matching the app/tray icon (`packages/host/desktop/build/tray-icon.svg`):
 * a rounded square carrying the two braces, connector line, and node circles.
 * Rendered at the upstream brand slots (`sidebar.brand.mark`,
 * `conversation.hero.brand.mark`) as a single declarative occupant.
 *
 * NOTE: this component is intentionally duplicated from
 * `packages/host/enterprise/src/client/Brand.tsx` (same artwork, same tokens):
 * the web profile deploys this package standalone and cross-package client
 * imports are disallowed by the plugin convention. Keep both in sync.
 *
 * Theme adaptation uses design tokens instead of a dark-theme body hook: the
 * tile takes the foreground ink (black on light, white on dark) and the
 * braces take the base surface, so the tile flips with the skin system.
 *
 * Artwork matches `packages/host/desktop/build/tray-icon.svg` exactly: the
 * braces sit on a full-bleed rounded square and are enlarged 1.25× around
 * the canvas center (translate/scale/translate of the source paths).
 */
const BRACE_TILE_VIEWBOX = '0 0 1254 1254'
const BRACE_TILE_RADIUS_RATIO = 180 / 1254

/** Braces + connector + nodes in tray-icon.svg coordinates, enlarged 1.25×. */
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
      { transform: 'translate(627 627) scale(1.25) translate(-627 -627)' },
      createElement('path', {
        d: 'M334 409 C300 409 273 431 273 466 V548 C273 582 254 607 220 620 C254 633 273 658 273 692 V775 C273 810 300 843 334 843',
        strokeWidth: 40,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }),
      createElement('path', {
        d: 'M920 409 C954 409 981 431 981 466 V548 C981 582 1000 607 1034 620 C1000 633 981 658 981 692 V775 C981 810 954 843 920 843',
        strokeWidth: 40,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }),
      createElement('line', { x1: 435, y1: 627, x2: 817, y2: 627, strokeWidth: 20, strokeLinecap: 'round' }),
      createElement('circle', { cx: 435, cy: 627, r: 65, fill: 'currentColor', stroke: 'none' }),
      createElement('circle', { cx: 817, cy: 627, r: 65, fill: 'currentColor', stroke: 'none' }),
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
 * typography; this component supplies only the product name text.
 */
export function BrandName() {
  return createElement('span', { style: { fontWeight: 700, letterSpacing: '0.3px' } }, 'PicoAide')
}
