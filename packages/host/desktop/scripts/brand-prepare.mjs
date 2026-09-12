/**
 * Brand prepare: derive every desktop build icon from the channel's brand folder.
 *
 *   brands/official/          (authority for the official channel, committed)
 *     ├─ logo.svg             → generate-tray-icons   → build/tray-icon*.png
 *     ├─ logo-dark.svg        → (dark theme surface; not rasterized here)
 *     ├─ app-icon.png         → build/app-icon.png (win/linux icon + mac pipeline)
 *     │                       → generate-mac-app-icon → build/app-icon-mac.png
 *     └─ brand.json           → validated (schema marker)
 *
 * 渠道化构建（`DSH_BUILD_CHANNEL=<id>`）改用私有仓里该渠道的目录
 * `channels/<id>/`：**逐文件回落**到 `brands/official/` —— 渠道只提供
 * logo 也是合法的，其余素材沿用官方几何（品牌图形的单一权威规则不变，
 * 渠道 logo 必须由 `brands/official/logo.svg` 派生，见 AGENTS.md）。
 *
 * Output under packages/host/desktop/build/ is derived and never committed
 * (see root .gitignore). Run via `yarn workspace dsh-plugin-desktop build`.
 */

import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assetExists, resolveChannelBuildContext, stageChannelProfile } from './channel-build.ts'
import { generateMacAppIcon } from './generate-mac-app-icon.mjs'
import { generateTrayIcons } from './generate-tray-icons.mjs'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const repoRoot = resolve(packageRoot, '..', '..', '..')
const officialRoot = join(repoRoot, 'brands', 'official')
const buildRoot = join(packageRoot, 'build')

/** 派生图标需要的最小素材集（渠道缺失时逐项回落官方）。 */
const REQUIRED_ASSETS = ['logo.svg', 'app-icon.png']

/**
 * 取某个品牌素材的**实际**来源：渠道目录优先，缺失则回落官方。
 *
 * 逐文件回落而不是"整个目录要么全用要么全不用"：渠道通常只换 logo，
 * 要求它复制一份 app-icon.png 只会让配置更容易漂移。
 * @param brandDir - 渠道品牌目录（官方渠道时等于 officialRoot）。
 * @param name - 素材文件名。
 * @returns 该素材的绝对路径；两处都没有时返回 undefined。
 */
async function resolveAsset(brandDir, name) {
  for (const candidate of brandDir === officialRoot ? [officialRoot] : [brandDir, officialRoot]) {
    const path = join(candidate, name)
    if (assetExists(path)) return path
  }
  return undefined
}

/**
 * Validate the brand folder, then derive every build-time icon.
 * @param options - 品牌目录与输出目录（缺省按 `DSH_BUILD_CHANNEL` 解析）。
 * @returns {Promise<{ channelId: string, files: string[] }>} 渠道 id 与派生出的文件。
 */
export async function prepareBrandAssets(options = {}) {
  const context = options.context ?? resolveChannelBuildContext()
  const brandDir = options.brandDir ?? context.brandDir
  const outputDir = options.outputDir ?? buildRoot
  await mkdir(outputDir, { recursive: true })

  const sources = {}
  for (const asset of REQUIRED_ASSETS) {
    const source = await resolveAsset(brandDir, asset)
    if (source === undefined) {
      throw new Error(`brand-prepare: 素材 ${asset} 在 ${brandDir} 与 ${officialRoot} 都不存在`)
    }
    sources[asset] = source
  }

  // 官方渠道目录是入库的权威源，保持改造前的严格性（少了任何一件都是事故）。
  // 渠道目录只要求 logo + app-icon：其余逐文件回落官方，避免"必须复制一整套"
  // 造成配置漂移；渠道素材本身的合规性由私有仓审核，不在构建期重复把关。
  if (brandDir === officialRoot) {
    for (const asset of ['logo-dark.svg', 'assistedMessages.yml', 'brand.json']) {
      if (!assetExists(join(officialRoot, asset))) {
        throw new Error(`brand-prepare: 官方品牌目录缺少 ${asset}`)
      }
    }
  }

  // Win/Linux application icon (also the mac icon pipeline source).
  await copyFile(sources['app-icon.png'], join(outputDir, 'app-icon.png'))

  // NSIS assisted installer messages (electron-builder reads buildResources)。
  // 官方渠道必须给；渠道没给则回落官方文案文件 —— 否则 electron-builder
  // 读不到安装器引导语，NSIS 会显示自己的默认英文而非渠道文案。
  const assisted = await resolveAsset(brandDir, 'assistedMessages.yml')
  if (assisted !== undefined) {
    await copyFile(assisted, join(outputDir, 'assistedMessages.yml'))
  }

  // macOS Dock icon (824/1024 safe-area), generated from the same app icon.
  await generateMacAppIcon(
    sources['app-icon.png'],
    join(outputDir, 'app-icon-mac.png'),
  )

  // Tray bitmaps (mac template + fixed-color windows/linux).
  const trayFiles = await generateTrayIcons({ source: sources['logo.svg'], buildRoot: outputDir })

  // 浏览器面品牌资源（favicon 源文件）：客户端前端 dist 里那份 favicon 是上游
  // DeepSeek 鱼形、manifest 写着厂商名 —— Electron 窗口图标挡住了，但 `dsh web`
  // 标签页 / PWA「安装为应用」直接读它们。桌面 host 用 exact 路由覆盖
  // `/favicon.svg` 与 `/manifest.webmanifest`（见 src/brand-web-route.ts）；
  // 路由在打包产物里读不到仓库品牌目录，所以这里把**本次构建的品牌几何**
  // 落盘成 build/web-brand/favicon.svg（渠道 logo 优先，缺失则官方 logo）。
  const webBrandDir = join(outputDir, 'web-brand')
  await mkdir(webBrandDir, { recursive: true })
  await copyFile(sources['logo.svg'], join(webBrandDir, 'favicon.svg'))

  const files = ['app-icon.png', 'app-icon-mac.png', 'web-brand/favicon.svg', ...trayFiles]
  if (assisted !== undefined) files.push('assistedMessages.yml')
  return { channelId: context.channelId, files }
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  // 这一步与 channel-prepare.ts 的 prepareChannelPackaging() 是同一件事的两半：
  // `yarn build` 必须让 build/ 与**本次渠道**自洽 —— 官方构建要删掉上一次渠道
  // 构建留下的 channel.json（残留会把客户品牌染进官方包），渠道构建要就位它。
  // 少了这一步，`yarn check` 里的 verify:channel 会在残留时失败（那正是它要抓的）。
  const context = resolveChannelBuildContext()
  stageChannelProfile(context, buildRoot)
  const { channelId, files } = await prepareBrandAssets({ context })
  console.log(`brand-prepare: 渠道 ${channelId} 的品牌素材 → build/`)
  for (const file of files) console.log(`  ✓ ${file}`)
}
