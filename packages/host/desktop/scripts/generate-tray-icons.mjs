/**
 * Derive native tray bitmaps from the repository brand folder (single authority).
 *
 * Source: brands/official/logo.svg — the black rounded tile with the white
 * brace/connector mark (1.25× enlarged), exactly as the repo authority.
 * The dark theme surface uses brands/official/logo-dark.svg (inverted colors),
 * but tray bitmaps keep the fixed brand color (system template on macOS,
 * fixed black on Windows/Linux) — unchanged behavior.
 */

import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const repoRoot = resolve(packageRoot, '..', '..', '..')
const brandRoot = join(repoRoot, 'brands', 'official')
const buildRoot = join(packageRoot, 'build')

/** Brand tile fill color that tray sources must use (fixed brand color). */
const BRAND_COLOR = '#000000'

/** @typedef {{ file: string, size: number, color?: string }} TrayVariant */

/** @type {TrayVariant[]} Default official tray variant table. */
const DEFAULT_VARIANTS = [
  { file: 'tray-iconTemplate.png', size: 16, color: '#000000' },
  { file: 'tray-iconTemplate@2x.png', size: 32, color: '#000000' },
  { file: 'tray-icon-blue.png', size: 16, color: BRAND_COLOR },
  { file: 'tray-icon-blue@1.25x.png', size: 20, color: BRAND_COLOR },
  { file: 'tray-icon-blue@1.5x.png', size: 24, color: BRAND_COLOR },
  { file: 'tray-icon-blue@2x.png', size: 32, color: BRAND_COLOR },
]

/**
 * Render all tray bitmaps from the authoritative brand SVG.
 * @param {{ source?: string, buildRoot?: string, variants?: TrayVariant[] }} [options]
 * @returns {Promise<string[]>} rendered filenames.
 */
export async function generateTrayIcons(options = {}) {
  const sourcePath = options.source ?? join(brandRoot, 'logo.svg')
  const outputRoot = options.buildRoot ?? buildRoot
  const variants = options.variants ?? DEFAULT_VARIANTS

  const source = await readFile(sourcePath, 'utf8')
  if (!source.includes(`fill="${BRAND_COLOR}"`) || /<style\b/iu.test(source)) {
    throw new Error(
      `generate-tray-icons: source must use the fixed brand color ${BRAND_COLOR} and inline attributes (no <style>)`,
    )
  }

  const rendered = []
  await Promise.all(variants.map(async ({ file, size, color }) => {
    const tinted = source.replaceAll(BRAND_COLOR, color)
    await sharp(Buffer.from(tinted))
      .resize({ width: size, height: size, fit: 'contain' })
      .png({ compressionLevel: 9 })
      .toFile(join(outputRoot, file))
    rendered.push(file)
  }))
  return rendered
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  await generateTrayIcons()
  console.log('generate-tray-icons: rendered tray bitmaps from brands/official/logo.svg')
}
