/**
 * Brand prepare: derive every desktop build icon from the channel's brand folder.
 *
 *   brands/official/          (authority for the official channel, committed)
 *     ├─ logo.svg             → generate-tray-icons   → build/tray-icon*.png
 *     │                       → build/web-brand/favicon.svg（本次构建的品牌）
 *     │                       → build/web-brand/official.svg（官方几何兜底,P1-12）
 *     ├─ logo-dark.svg        → (dark theme surface; not rasterized here)
 *     ├─ app-icon.png         → build/app-icon.png (win/linux icon + mac pipeline)
 *     │                       → generate-mac-app-icon → build/app-icon-mac.png
 *     └─ brand.json           → validated (schema marker)
 *
 * 渠道化构建（`DSH_BUILD_CHANNEL=<id>`）改用私有仓里该渠道的目录
 * `channels/<id>/`：**公共渠道**（official/beta）逐文件回落到 `brands/official/`
 * —— beta 只提供 logo 也是合法的，其余素材沿用官方几何（品牌图形的单一权威规则
 * 不变，渠道 logo 必须由 `brands/official/logo.svg` 派生，见 AGENTS.md），
 * 但每一次回落都记一条可检索日志。
 *
 * **品牌渠道（official/beta 之外）不允许任何回落**（2026-09-26 审计 Z3-3）：
 * 没声明 `assets.logo`、或缺 `logo.svg` / `app-icon.png`，一律**抛错**。逐文件静默
 * 回落官方的后果是安装器/Dock/任务栏图标、或服务端不可达时的登录页标识变成
 * **厂商品牌**，而白标门禁（`verify-channel-package.ts`）用**同一个**
 * `prepareBrandAssets()` 重新派生再逐字节比对 —— 两边都回落官方就恒等，
 * 结构上不可能发现。
 *
 * Output under packages/host/desktop/build/ is derived and never committed
 * (see root .gitignore). Run via `yarn workspace dsh-plugin-desktop build`.
 */

import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CHANNEL_ASSET_FILES,
  assetExists,
  isPublicChannelId,
  readDeclaredAssetFileName,
  resolveChannelBuildContext,
  stageChannelProfile,
} from './channel-build.ts'
import { generateMacAppIcon } from './generate-mac-app-icon.mjs'
import { generateTrayIcons } from './generate-tray-icons.mjs'
import { isDirectInvocation } from './direct-invocation.mjs'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const repoRoot = resolve(packageRoot, '..', '..', '..')
const officialRoot = join(repoRoot, 'brands', 'official')
const buildRoot = join(packageRoot, 'build')

/**
 * 派生图标需要的最小素材集（文件名与 `CHANNEL_ASSET_FILES` 同源）。
 *
 * 品牌渠道缺任一件即 **fail-loud**（见 `prepareBrandAssets`）；公共渠道
 * （official/beta）的品牌就是厂商自己的，回落官方是正当的，但要显式记日志。
 */
const REQUIRED_ASSETS = [CHANNEL_ASSET_FILES.logo, CHANNEL_ASSET_FILES.appIcon]

/**
 * 取某个品牌素材的**实际**来源：渠道目录优先，缺失则回落官方。
 *
 * 逐文件回落而不是"整个目录要么全用要么全不用"：公共渠道（official/beta）
 * 通常只换 logo，要求复制一整套只会让配置更容易漂移。
 * **品牌渠道不允许任何一件回落**（调用方 `prepareBrandAssets` 负责 fail-loud）。
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
 * @throws 品牌渠道（official/beta 之外）缺素材、或没声明 `assets.logo` 时抛错 ——
 *   逐文件静默回落官方会让交付物带**厂商品牌**，而白标门禁用同一个派生函数自证，
 *   结构上咬不到（2026-09-26 审计 Z3-3）。
 */
export async function prepareBrandAssets(options = {}) {
  const context = options.context ?? resolveChannelBuildContext()
  const brandDir = options.brandDir ?? context.brandDir
  const outputDir = options.outputDir ?? buildRoot
  await mkdir(outputDir, { recursive: true })

  // 渠道来源（不是"文件在不在"）决定回落是否正当：official/beta 的品牌就是厂商
  // 自己的，回落官方 = 预期行为（显式记日志）；品牌渠道回落 = 交付物带厂商品牌。
  const publicChannel = isPublicChannelId(context.channelId)

  // 品牌渠道必须**声明** `assets.logo`（与 ci-channels.sh 的输入侧判据同一条规则）：
  // 随包内联（channel-build.ts 的 inlineChannelAssets）只认这个字段，不声明时包里
  // 没有 `logo_inline` ⇒ 服务端不可达 / 服务端还是旧版时，登录页与侧边栏回落
  // 编译期内置的**厂商花括号 mark**（2026-09-11 在客户线上实测过的形态）。
  const declaredLogo = context.official || !publicChannel
    ? readDeclaredAssetFileName(context.channelDir, 'logo')
    : undefined
  if (!publicChannel && declaredLogo === undefined) {
    throw new Error(
      `brand-prepare: 品牌渠道的渠道包没有声明 assets.logo（${join(context.channelDir, 'channel.json')}）。`
      + '它是随包内联 logo 的唯一来源：不声明时服务端不可达/旧版服务端下登录页会回落厂商标识。'
      + `请在渠道包里写 assets.logo: "${CHANNEL_ASSET_FILES.logo}"。`,
    )
  }
  // 声明的名字必须与打包侧消费的文件名一致（唯一真源 = CHANNEL_ASSET_FILES）：
  // 不一致时随包内联用的是声明的那个、托盘位图与随包 favicon 用的是另一个
  // ⇒ **同一个包里两套品牌**。
  if (declaredLogo !== undefined && declaredLogo !== CHANNEL_ASSET_FILES.logo) {
    throw new Error(
      `brand-prepare: 渠道包的 assets.logo 不是 ${CHANNEL_ASSET_FILES.logo}（声明的文件名与打包侧消费的不一致）。`
      + '托盘位图与随包 favicon 只按 ' + CHANNEL_ASSET_FILES.logo + ' 派生，声明别的名字会让同一个包装上两套品牌。'
      + `修法：把渠道目录里的 logo 素材改名为 ${CHANNEL_ASSET_FILES.logo} 并同步 assets.logo。`,
    )
  }

  const sources = {}
  const officialFallbacks = []
  for (const asset of REQUIRED_ASSETS) {
    const source = await resolveAsset(brandDir, asset)
    if (source === undefined) {
      throw new Error(`brand-prepare: 素材 ${asset} 在 ${brandDir} 与 ${officialRoot} 都不存在`)
    }
    // 品牌渠道的素材**必须来自渠道目录**（2026-09-26 审计 Z3-3）：回落官方 =
    // 安装器/Dock/任务栏/窗口图标是厂商图标、或服务端不可达时登录页厂商标识。
    // **必须在构建期 fail-loud**：白标门禁（verify-channel-package.ts）的整组断言
    // 就是"用同一个 prepareBrandAssets 重新派生再逐字节比对"，两边都回落官方 ⇒
    // 恒等 ⇒ 结构上不可能发现。
    if (!publicChannel && source === join(officialRoot, asset)) {
      throw new Error(
        `brand-prepare: 品牌渠道的素材 ${asset} 回落到了官方 ${officialRoot}（渠道目录 ${brandDir} 里没有）。`
        + '品牌渠道的交付物必须是客户自己的品牌：安装器/Dock/任务栏图标与随包 favicon 都由它派生，'
        + '回落官方等于把厂商品牌交付给客户。请在渠道目录里放入该素材'
        + (asset === CHANNEL_ASSET_FILES.logo
          ? '（托盘位图要求 logo 内含平坦十六进制 <rect> 方块）'
          : '（1024×1024、16 位 RGBA、内嵌 ICC）'),
      )
    }
    // 公共渠道的回落是**正当**的，但必须显式登记：这条日志是"本包用的是官方几何"
    // 的唯一可检索凭据（而不是靠比对猜）。official 构建本身不走这条分支
    // （`context.official`：它用的就是官方权威源，谈不上"回落"）。
    if (publicChannel && !context.official && brandDir !== officialRoot && source === join(officialRoot, asset)) {
      officialFallbacks.push(asset)
    }
    sources[asset] = source
  }
  for (const asset of officialFallbacks) {
    console.warn(
      `brand-prepare: 公共渠道 ${context.channelId} 缺素材 ${asset}，回落官方 brands/official（公共渠道允许，已登记）`,
    )
  }

  // 官方渠道目录是入库的权威源，保持改造前的严格性（少了任何一件都是事故）。
  // 公共渠道目录只要求 logo + app-icon：其余逐文件回落官方，避免"必须复制一整套"
  // 造成配置漂移；渠道素材本身的合规性由私有仓审核，不在构建期重复把关。
  if (brandDir === officialRoot) {
    for (const asset of ['logo-dark.svg', 'assistedMessages.yml', 'brand.json']) {
      if (!assetExists(join(officialRoot, asset))) {
        throw new Error(`brand-prepare: 官方品牌目录缺少 ${asset}`)
      }
    }
  }

  // Win/Linux application icon (also the mac icon pipeline source).
  await copyFile(sources[CHANNEL_ASSET_FILES.appIcon], join(outputDir, 'app-icon.png'))

  // NSIS assisted installer messages (electron-builder reads buildResources)。
  // 官方渠道必须给；渠道没给则回落官方文案文件 —— 否则 electron-builder
  // 读不到安装器引导语，NSIS 会显示自己的默认英文而非渠道文案。
  const assisted = await resolveAsset(brandDir, 'assistedMessages.yml')
  if (assisted !== undefined) {
    await copyFile(assisted, join(outputDir, 'assistedMessages.yml'))
  }

  // macOS Dock icon (824/1024 safe-area), generated from the same app icon.
  await generateMacAppIcon(
    sources[CHANNEL_ASSET_FILES.appIcon],
    join(outputDir, 'app-icon-mac.png'),
  )

  // Tray bitmaps (mac template + fixed-color windows/linux).
  const trayFiles = await generateTrayIcons({ source: sources[CHANNEL_ASSET_FILES.logo], buildRoot: outputDir })

  // 浏览器面品牌资源（favicon 源文件）：客户端前端 dist 里那份 favicon 是上游
  // DeepSeek 鱼形、manifest 写着厂商名 —— Electron 窗口图标挡住了，但 `dsh web`
  // 标签页 / PWA「安装为应用」直接读它们。桌面 host 用 exact 路由覆盖
  // `/favicon.svg` 与 `/manifest.webmanifest`（见 src/brand-web-route.ts）；
  // 路由在打包产物里读不到仓库品牌目录，所以这里把**本次构建的品牌几何**
  // 落盘成 build/web-brand/favicon.svg（渠道 logo 优先，缺失则官方 logo）。
  //
  // 另外落一份**官方**几何成 build/web-brand/official.svg（2026-09-12 审计 P1-12）：
  // 运行时候选链的最后一级是官方兜底，而它原先指向 `brands/official/logo.svg` ——
  // 那个路径在 src/lib/app.asar 三套布局下都不存在（包内没有 brands/**），于是
  // "渠道 logo 不可信时回落官方"这条链是死的。凡是随包分发的品牌图形都必须落在
  // build/（electron-builder 的 buildResources），这里就是那个唯一真源。
  const webBrandDir = join(outputDir, 'web-brand')
  await mkdir(webBrandDir, { recursive: true })
  await copyFile(sources[CHANNEL_ASSET_FILES.logo], join(webBrandDir, 'favicon.svg'))
  await copyFile(join(officialRoot, 'logo.svg'), join(webBrandDir, 'official.svg'))

  const files = ['app-icon.png', 'app-icon-mac.png', 'web-brand/favicon.svg', 'web-brand/official.svg', ...trayFiles]
  if (assisted !== undefined) files.push('assistedMessages.yml')
  return { channelId: context.channelId, files }
}

if (isDirectInvocation(import.meta)) {
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
