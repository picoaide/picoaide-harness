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

/** 托盘位图的固定渲染色（macOS 模板图 / Windows 固定黑；下面变体表里的 color 即它）。 */
const BRAND_COLOR = '#000000'

/**
 * 取源 SVG 里**托盘方块**的填充色：第一个带 6 位十六进制 `fill` 的 `<rect>`。
 *
 * 为什么不能硬要求 `fill="#000000"`（2026-09-11 实测踩到）：托盘位图是把**方块色
 * 替换成变体色**渲染出来的，真正的前提只是"方块用一个平坦的十六进制色"。官方
 * logo 恰好是黑色，早先实现就把它写成了硬性要求 —— 于是**渠道用自己的品牌色画
 * logo 时直接打包失败**（报错只说"必须用 #000000"，看不出是托盘派生的限制）。
 * 现在按方块自身的颜色替换：官方路径逐字节不变（#000000 → 变体色），渠道品牌色
 * 也能正常派生。
 * @param {string} source - logo SVG 源文本。
 * @returns {string | undefined} 形如 `#006AFF` 的方块色；没有平坦方块时为 undefined。
 */
function tileFillColor(source) {
  return /<rect\b[^>]*\bfill="(#[0-9A-Fa-f]{6})"/u.exec(source)?.[1]
}

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
  const tileColor = tileFillColor(source)
  if (tileColor === undefined || /<style\b/iu.test(source)) {
    throw new Error(
      'generate-tray-icons: source must draw the tile as <rect fill="#RRGGBB"> with inline attributes (no <style>)',
    )
  }

  const rendered = []
  await Promise.all(variants.map(async ({ file, size, color }) => {
    // 方块色 → 变体色（官方源是 #000000，逐字节与改造前一致）。
    const tinted = source.replaceAll(tileColor, color)
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
