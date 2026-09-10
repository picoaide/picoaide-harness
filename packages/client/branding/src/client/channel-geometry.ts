/**
 * Authoritative brand-mark geometry for the client surfaces.
 *
 * The single authority is `brands/official/logo.svg` (see AGENTS.md: never
 * hand-draw, never copy geometry from memory). This module holds the parsed
 * numbers ONCE so the React surfaces do not each re-transcribe the paths
 * (audit 2026-09-08 P2-39 counted 4 hand-copied sites). `tests/channel-geometry.spec.ts`
 * parses the SVG and fails if any constant drifts from it.
 * @module @picoaide/dsh-branding/channel-geometry
 */

/** Canvas size of the authoritative artwork (square). */
export const BRAND_TILE_SIZE = 1254

/** `viewBox` of the tile. */
export const BRAND_TILE_VIEWBOX = `0 0 ${BRAND_TILE_SIZE} ${BRAND_TILE_SIZE}`

/** Corner radius of the rounded square (px in the 1254 canvas). */
export const BRAND_TILE_RADIUS = 180

/** Corner-radius ratio for percentage-based styling. */
export const BRAND_TILE_RADIUS_RATIO = BRAND_TILE_RADIUS / BRAND_TILE_SIZE

/** The approved 1.25× enlargement around the canvas center. */
export const BRAND_MARK_TRANSFORM = 'translate(627 627) scale(1.25) translate(-627 -627)'

/** The two brace paths (left, right) in logo.svg coordinates. */
export const BRAND_MARK_BRACES = [
  'M334 409 C300 409 273 431 273 466 V548 C273 582 254 607 220 620 C254 633 273 658 273 692 V775 C273 810 300 843 334 843',
  'M920 409 C954 409 981 431 981 466 V548 C981 582 1000 607 1034 620 C1000 633 981 658 981 692 V775 C981 810 954 843 920 843',
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
