import { createElement } from 'react'
import type { BrandConfig } from '../brand-sync.ts'
import { useBrand } from './brand-store.ts'

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
 * Artwork matches `packages/host/desktop/build/tray-icon.svg` exactly: the
 * braces sit on a full-bleed rounded square and are enlarged 1.25× around
 * the canvas center (translate/scale/translate of the source paths).
 *
 * Theme adaptation uses design tokens instead of a dark-theme body hook: the
 * tile takes the foreground ink (black on light, white on dark) and the
 * braces take the base surface, so the tile flips with the skin system.
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

/**
 * The brace-mark tile; `className` rides along (upstream slot geometry).
 * When a server logo_url is provided (dynamic server brand), an <img> is
 * rendered instead of the brace artwork; failures fall back to the brace.
 */
export function BraceMark({ size, className }: { size: number; className?: string | undefined }) {
  const brand = useBrand()
  const logoUrl = resolveClientLogo(brand)
  const name = resolveClientName(brand)
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
      style: { width: size, height: size, objectFit: 'contain', borderRadius: Math.max(4, Math.round(size * BRACE_TILE_RADIUS_RATIO)) },
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
        borderRadius: Math.max(4, Math.round(size * BRACE_TILE_RADIUS_RATIO)),
        backgroundColor: 'var(--dsw-alias-fg-primary, #000000)',
        color: 'var(--dsw-alias-bg-base, #ffffff)',
      },
    },
    BraceGlyph(),
  )
}

export function BrandName() {
  const brand = useBrand()
  const version = process.env.PICOAI_PRODUCT_VERSION as string | undefined
  const name = resolveClientName(brand) === 'PicoAide Harness' ? 'PicoAide' : resolveClientName(brand)
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
  )
}

/** Right-top brand badge (conversation.session.header.actions slot). */
export function BrandBadge() {
  const brand = useBrand()
  const logo = resolveClientLogo(brand)
  const name = resolveClientName(brand)
  if (!logo && !brand?.enabled) return null
  return createElement(
    'span',
    { style: { display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--dsw-alias-fg-secondary, #666)', opacity: 0.85 } },
    logo ? createElement('img', { src: logo, alt: '', style: { width: 16, height: 16, objectFit: 'contain', borderRadius: 3 } }) : null,
    name,
  )
}

/** Resolve the client-side display name from a brand config (or default). */
function resolveClientName(brand: BrandConfig | null | undefined): string {
  return brand?.client?.display_name && brand.client.display_name !== '' ? brand.client.display_name : 'PicoAide Harness'
}

/** Resolve the client logo URL from a brand config. */
function resolveClientLogo(brand: BrandConfig | null | undefined): string | undefined {
  return brand?.enabled ? brand.client?.logo_url : undefined
}
