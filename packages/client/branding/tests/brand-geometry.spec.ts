/**
 * Brand-geometry drift guard (audit 2026-09-08 P2-39).
 *
 * `src/client/brand-geometry.ts` is the ONLY place the client surfaces read
 * the mark's numbers from. This test parses the single authority
 * (`brands/official/logo.svg`) and fails on any divergence, so a change to the
 * brand folder cannot leave the shipped React surface drawing the old artwork.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  BRAND_CONNECTOR,
  BRAND_MARK_BRACES,
  BRAND_MARK_STROKE_WIDTH,
  BRAND_MARK_TRANSFORM,
  BRAND_NODES,
  BRAND_TILE_RADIUS,
  BRAND_TILE_SIZE,
  BRAND_TILE_VIEWBOX,
} from '../src/client/brand-geometry.ts'

const REPO_ROOT = new URL('../../../..', import.meta.url)
const svg = readFileSync(new URL('brands/official/logo.svg', REPO_ROOT), 'utf8')

/** Canonical path form: one space between every command letter and number, so
 * `M 334 409` (SVG) and `M334 409` (constant) compare equal. */
const norm = (value: string): string => value.replace(/([A-Za-z])/gu, ' $1 ').replace(/\s+/gu, ' ').trim()

function attr(tag: string, name: string): string | undefined {
  return new RegExp(`${name}="([^"]*)"`, 'u').exec(tag)?.[1]
}

const braceTags = [...svg.matchAll(/<path\b[^>]*\/>/gu)].map(match => match[0])
const lineTag = /<line\b[^>]*\/>/u.exec(svg)?.[0] ?? ''
const circleTags = [...svg.matchAll(/<circle\b[^>]*\/>/gu)].map(match => match[0])

describe('brand geometry derives from brands/official/logo.svg', () => {
  it('viewBox and tile radius match the authoritative artwork', () => {
    const rect = /<rect\b[^>]*\/>/u.exec(svg)?.[0] ?? ''
    expect(Number(attr(rect, 'width'))).toBe(BRAND_TILE_SIZE)
    expect(Number(attr(rect, 'height'))).toBe(BRAND_TILE_SIZE)
    expect(Number(attr(rect, 'rx'))).toBe(BRAND_TILE_RADIUS)
    expect(BRAND_TILE_VIEWBOX).toBe(`0 0 ${String(BRAND_TILE_SIZE)} ${String(BRAND_TILE_SIZE)}`)
  })

  it('carries the approved 1.25x center transform', () => {
    expect(svg).toContain(BRAND_MARK_TRANSFORM)
  })

  it('brace paths, stroke width, connector and nodes match exactly', () => {
    const svgPaths = braceTags.map(tag => norm(attr(tag, 'd') ?? ''))
    expect(svgPaths).toHaveLength(BRAND_MARK_BRACES.length)
    for (const [index, brace] of BRAND_MARK_BRACES.entries()) {
      expect(svgPaths[index]).toBe(norm(brace))
    }
    for (const tag of braceTags) {
      expect(Number(attr(tag, 'stroke-width'))).toBe(BRAND_MARK_STROKE_WIDTH)
    }

    expect(Number(attr(lineTag, 'x1'))).toBe(BRAND_CONNECTOR.x1)
    expect(Number(attr(lineTag, 'y1'))).toBe(BRAND_CONNECTOR.y1)
    expect(Number(attr(lineTag, 'x2'))).toBe(BRAND_CONNECTOR.x2)
    expect(Number(attr(lineTag, 'y2'))).toBe(BRAND_CONNECTOR.y2)
    expect(Number(attr(lineTag, 'stroke-width'))).toBe(BRAND_CONNECTOR.strokeWidth)

    expect(circleTags).toHaveLength(BRAND_NODES.length)
    for (const [index, node] of BRAND_NODES.entries()) {
      const tag = circleTags[index]!
      expect(Number(attr(tag, 'cx'))).toBe(node.cx)
      expect(Number(attr(tag, 'cy'))).toBe(node.cy)
      expect(Number(attr(tag, 'r'))).toBe(node.r)
    }
  })
})
