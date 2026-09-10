/**
 * Authoritative brand-mark geometry for the enterprise (desktop) surfaces.
 *
 * The single authority is `brands/official/logo.svg` (AGENTS.md: never
 * hand-draw, never copy geometry from memory). The desktop assembly does NOT
 * include `@picoaide/dsh-branding` (web-only), and client bundles must not
 * import another package's client code, so this package keeps its own parsed
 * copy — `tests/channel-geometry.spec.ts` parses the SVG and fails on any drift
 * (audit 2026-09-08 P2-39).
 * @module @picoaide/dsh-enterprise/channel-geometry
 */

/** Canvas size of the authoritative artwork (square). */
export const BRAND_TILE_SIZE = 1254

/** `viewBox` of the tile. */
export const BRAND_TILE_VIEWBOX = `0 0 ${String(BRAND_TILE_SIZE)} ${String(BRAND_TILE_SIZE)}`

/** Corner radius of the rounded square (px in the 1254 canvas). */
export const BRAND_TILE_RADIUS = 180

/** Corner-radius ratio for percentage-based styling (React surfaces). */
export const BRAND_TILE_RADIUS_RATIO = BRAND_TILE_RADIUS / BRAND_TILE_SIZE

/** The approved 1.25× enlargement around the canvas center. */
export const BRAND_MARK_TRANSFORM = 'translate(627 627) scale(1.25) translate(-627 -627)'

/** The two brace paths (left, right) in logo.svg coordinates. */
export const BRAND_MARK_BRACES = [
  'M 334 409 C 300 409 273 431 273 466 V 548 C 273 582 254 607 220 620 C 254 633 273 658 273 692 V 775 C 273 810 300 843 334 843',
  'M 920 409 C 954 409 981 431 981 466 V 548 C 981 582 1000 607 1034 620 C 1000 633 981 658 981 692 V 775 C 981 810 954 843 920 843',
] as const

/** Stroke width of the braces. */
export const BRAND_MARK_STROKE_WIDTH = 40

/** The connector line between the two node circles. */
export const BRAND_CONNECTOR = { x1: 435, y1: 627, x2: 817, y2: 627, strokeWidth: 20 } as const

/** The two node circles on the connector line. */
export const BRAND_NODES = [
  { cx: 435, cy: 627, r: 65 },
  { cx: 817, cy: 627, r: 65 },
] as const

/** The mark's inner elements (braces + connector + nodes), no <svg> wrapper.
 * `color` is a CSS colour or `currentColor` (React/CSS surfaces). The layout
 * (newlines + 2-space indent) mirrors `brands/official/logo.svg` so the
 * authored artwork and the generated markup compare equal after whitespace
 * normalization (tests/favicon.spec.ts). */
function markInner(color: string, indent: string): string {
  const braces = BRAND_MARK_BRACES
    .map(path => `${indent}  <path d="${path}" fill="none" stroke="${color}" stroke-width="${String(BRAND_MARK_STROKE_WIDTH)}" stroke-linecap="round" stroke-linejoin="round"/>`)
    .join('\n')
  const nodes = BRAND_NODES
    .map(node => `${indent}  <circle cx="${String(node.cx)}" cy="${String(node.cy)}" r="${String(node.r)}" fill="${color}"/>`)
    .join('\n')
  return `${indent}<g transform="${BRAND_MARK_TRANSFORM}">\n${braces}\n`
    + `${indent}  <line x1="${String(BRAND_CONNECTOR.x1)}" y1="${String(BRAND_CONNECTOR.y1)}" x2="${String(BRAND_CONNECTOR.x2)}" y2="${String(BRAND_CONNECTOR.y2)}" stroke="${color}" stroke-width="${String(BRAND_CONNECTOR.strokeWidth)}" stroke-linecap="round"/>\n`
    + `${nodes}\n${indent}</g>`
}

/**
 * The mark as a standalone inline SVG string. The mark uses `currentColor` so
 * the caller supplies the colour (white on the dark tile, black on the light
 * tile) — never a third chromatic variant.
 */
export function brandMarkSvg(color = 'currentColor'): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${BRAND_TILE_VIEWBOX}" width="100%" height="100%" fill="none" aria-hidden="true">\n`
    + markInner(color, '') + '\n</svg>'
}

/** The full tile (rounded square + mark) as an inline SVG string. */
export function brandTileSvg(markColor = '#FFFFFF'): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${String(BRAND_TILE_SIZE)}" height="${String(BRAND_TILE_SIZE)}" viewBox="${BRAND_TILE_VIEWBOX}">\n`
    + `  <rect x="0" y="0" width="${String(BRAND_TILE_SIZE)}" height="${String(BRAND_TILE_SIZE)}" rx="${String(BRAND_TILE_RADIUS)}" fill="#000000"/>\n`
    + markInner(markColor, '  ') + '\n</svg>'
}
