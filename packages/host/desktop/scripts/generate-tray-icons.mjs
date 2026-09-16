/**
 * Derive native tray bitmaps from the repository brand folder (single authority).
 *
 * Source: brands/official/logo.svg — the black rounded tile with the white
 * brace/connector mark (1.25× enlarged), exactly as the repo authority.
 *
 * 两种形状，因为两个平台消费位图的方式根本不同（2026-09-16 修复）：
 *
 *   - **Windows/Linux 位图**（`tray-icon-blue*`）：原样绘制，所以保留完整品牌图形
 *     —— 方块 + mark（方块色替换成变体色）。
 *   - **macOS 模板图**（`tray-iconTemplate*`）：系统**只拿 alpha 通道当遮罩**，
 *     再按当前外观填成黑/白（Electron 文档：模板图由 black + clear 组成）。
 *     所以模板图必须是 **mark-only、背景透明**：早先直接拿整块方块去当模板图，
 *     方块满画布不透明 ⇒ 菜单栏里只剩一个实心方块，花括号 mark 永远不可能显示
 *     （2026-09-16 真机现象：暗色菜单栏里一个白色方块）。
 *
 * 两者的几何都来自同一份品牌 SVG（模板图只是**去掉方块**那一层，并把 mark
 * 规整成黑色），不引入任何新画法。
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

/** 方块 `<rect>` 的标记：`(1)` 是它的平坦填充色。 */
const TILE_RECT_PATTERN = /<rect\b[^>]*\bfill="(#[0-9A-Fa-f]{6})"[^>]*(?:\/>|>\s*<\/rect>)/u

/**
 * 取源 SVG 里**托盘方块**那个 `<rect>`：元素标记 + 它的填充色。
 *
 * 为什么不能硬要求 `fill="#000000"`（2026-09-11 实测踩到）：Windows/Linux 位图是把
 * **方块色替换成变体色**渲染出来的，真正的前提只是"方块用一个平坦的十六进制色"。
 * 官方 logo 恰好是黑色，早先实现就把它写成了硬性要求 —— 于是**渠道用自己的品牌色
 * 画 logo 时直接打包失败**（报错只说"必须用 #000000"，看不出是托盘派生的限制）。
 * 现在按方块自身的颜色替换：官方路径逐字节不变（#000000 → 变体色），渠道品牌色也能
 * 正常派生。macOS 模板图（{@link renderTemplateIcon}）则要**整块删掉**这个元素。
 * @param {string} source - logo SVG 源文本。
 * @returns {{ markup: string, color: string } | undefined} 方块标记与形如 `#006AFF`
 * 的颜色；没有平坦方块时为 undefined。
 */
function tileRect(source) {
  const match = TILE_RECT_PATTERN.exec(source)
  if (match === null) return undefined
  return { markup: match[0], color: match[1] }
}

/** @typedef {{ file: string, size: number, color?: string, template?: boolean }} TrayVariant */

/** @type {TrayVariant[]} Default official tray variant table. */
const DEFAULT_VARIANTS = [
  // macOS：模板图 = 只有 mark（背景透明、颜色规整成黑），见文件头注释。
  { file: 'tray-iconTemplate.png', size: 16, color: '#000000', template: true },
  { file: 'tray-iconTemplate@2x.png', size: 32, color: '#000000', template: true },
  // Windows/Linux：完整品牌图形（方块 + mark），原样绘制。
  { file: 'tray-icon-blue.png', size: 16, color: BRAND_COLOR },
  { file: 'tray-icon-blue@1.25x.png', size: 20, color: BRAND_COLOR },
  { file: 'tray-icon-blue@1.5x.png', size: 24, color: BRAND_COLOR },
  { file: 'tray-icon-blue@2x.png', size: 32, color: BRAND_COLOR },
]

/**
 * 渲染一张 macOS 模板图：**只有 mark**、背景透明、颜色规整成黑。
 *
 * 为什么必须去掉方块（2026-09-16 真机 P1）：`nativeImage.setTemplateImage(true)`
 * 之后 AppKit 只用 **alpha 通道当遮罩**、RGB 一律忽略，所以"整块不透明的方块 +
 * 白色 mark"在菜单栏里画出来就是一个实心方块（暗色菜单栏上是白方块），mark 消失。
 * 模板图规范是 black + clear：这里把方块那一层删掉，剩下的 mark 强制写成黑色。
 * @param {string} source - logo SVG 源文本。
 * @param {string} tileMarkup - 底板 `<rect>` 的原始标记（整块删除）。
 * @param {number} size - 输出边长（像素）。
 * @param {string} outputPath - 输出文件路径。
 */
async function renderTemplateIcon(source, tileMarkup, size, outputPath) {
  // 只删**底板那一层**：mark 的几何、坐标、相对大小全部保持不变。
  const glyph = source.replace(tileMarkup, '')
  const { data, info } = await sharp(Buffer.from(glyph))
    .resize({ width: size, height: size, fit: 'contain' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  let opaque = 0
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] > 0) opaque += 1
    // 模板图规范是"黑 + 透明"：颜色信息对系统无意义，写字面黑避免别的渲染路径
    // 按亮度解释它（渠道 logo 的 mark 可能是白/彩色）。
    data[i] = 0
    data[i + 1] = 0
    data[i + 2] = 0
  }
  if (opaque === 0) {
    throw new Error(
      'generate-tray-icons: the logo draws nothing outside its tile — a macOS template '
      + 'bitmap would be fully transparent (an invisible menu bar icon). Draw the brand mark '
      + 'in logo.svg or ship a mark-only logo.',
    )
  }
  await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toFile(outputPath)
}

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
  const tile = tileRect(source)
  if (tile === undefined || /<style\b/iu.test(source)) {
    throw new Error(
      'generate-tray-icons: source must draw the tile as <rect fill="#RRGGBB"> with inline attributes (no <style>)',
    )
  }

  const rendered = []
  await Promise.all(variants.map(async ({ file, size, color, template }) => {
    const outputPath = join(outputRoot, file)
    if (template === true) {
      await renderTemplateIcon(source, tile.markup, size, outputPath)
      rendered.push(file)
      return
    }
    // 方块色 → 变体色（官方源是 #000000，逐字节与改造前一致）。
    const tinted = source.replaceAll(tile.color, color ?? BRAND_COLOR)
    await sharp(Buffer.from(tinted))
      .resize({ width: size, height: size, fit: 'contain' })
      .png({ compressionLevel: 9 })
      .toFile(outputPath)
    rendered.push(file)
  }))
  return rendered
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  await generateTrayIcons()
  console.log('generate-tray-icons: rendered tray bitmaps from brands/official/logo.svg')
}
