/**
 * 渠道化打包上下文：把渠道包翻译成 electron-builder 的覆盖参数与素材目录。
 *
 * 渠道编译期品牌的**唯一出口**。此前这些值全部硬编码在
 * `packages/host/desktop/package.json` 的 `build` 块里（productName / appId /
 * 四个 artifactName / nsis.shortcutName / linux maintainer+synopsis），
 * 而图标固定读 `brands/official/` —— 于是"渠道客户端"必然带着厂商品牌。
 *
 * 现在：
 *   - 渠道由环境变量 `DSH_BUILD_CHANNEL` 选择（CI 的渠道矩阵注入）；
 *   - 缺省 `official`，此时**全部输出与改造前一致**（官方默认值见下表）。
 *
 * 为什么用 `--config.*` CLI 覆盖而不是改 package.json：仓库里的一份
 * package.json 要同时服务官方与所有渠道，只有 CLI 覆盖才能让同一个检出
 * 产出不同渠道的包；也因此构建门禁里对官方值的断言继续有效。
 *
 * 运行时品牌（窗口标题 / 登录页 / 界面文案 / 默认域名）走
 * `src/desktop-channel.ts`，与本模块共用同一份 channel.json；两者必须自洽。
 *
 * @module dsh-plugin-desktop/scripts/channel-build
 */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 选择渠道的环境变量（CI 渠道矩阵注入）。 */
export const CHANNEL_ENV = 'DSH_BUILD_CHANNEL'

/** 渠道 id 合法形状（与客户端 CHANNEL_ID_PATTERN / 服务端 IsChannelID 同源）。 */
const CHANNEL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/u

/** 安装包名里的 slug：ASCII 字母数字与连字符，避免各平台文件名编码差异。 */
const SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/u

/** 深链 scheme 合法形状（RFC 3986）：字母开头，后跟字母/数字/+/-/.。 */
const DEEP_LINK_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]{1,31}$/u

/** 应用 id（bundle id / AppUserModelId）：反向域名形状。 */
const APP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]*$/u

/** 官方渠道的编译期默认值 = 改造前 package.json build 块里的字面量。 */
export const OFFICIAL_BUILD_DEFAULTS = {
  productName: 'PicoAide Harness',
  appId: 'ai.deepseek.dsh.desktop',
  slug: 'PicoAide-Harness',
  shortcutName: 'PicoAide Harness',
  linuxMaintainer: 'picoaide',
  linuxSynopsis: 'PicoAide Harness',
  deepLinkScheme: 'picoaide',
} as const

/** 安装包名模板：`${version}`/`${arch}`/`${ext}` 由 electron-builder 展开。 */
export interface ChannelArtifactNames {
  readonly mac: string
  readonly win: string
  readonly nsis: string
  readonly linux: string
}

function artifactNames(slug: string): ChannelArtifactNames {
  return {
    mac: `${slug}-\${version}-mac.\${ext}`,
    win: `${slug}-\${version}-\${arch}-Portable.\${ext}`,
    nsis: `${slug}-\${version}-\${arch}-Setup.\${ext}`,
    linux: `${slug}-\${version}-\${arch}.\${ext}`,
  }
}

/** 本次构建的渠道上下文。 */
export interface ChannelBuildContext {
  readonly channelId: string
  /** 是否官方渠道（官方 = 不做任何覆盖，产物与改造前一致）。 */
  readonly official: boolean
  /** `channels/<id>/`：渠道包（channel.json 与素材）所在目录。 */
  readonly channelDir: string
  /** 图标/安装器文案的素材目录（渠道缺素材时逐文件回落官方）。 */
  readonly brandDir: string
  readonly productName: string
  readonly appId: string
  readonly slug: string
  readonly shortcutName: string
  readonly linuxMaintainer: string
  readonly linuxSynopsis: string
  /** 深链 scheme（OIDC 回调跳回客户端；渠道构建用它自己的）。 */
  readonly deepLinkScheme: string
  /** 深链在操作系统里的注册名（Protocols 显示名）。 */
  readonly deepLinkName: string
  readonly artifactNames: ChannelArtifactNames
}

/** 取非空字符串，否则 undefined。 */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** 从任意 JSON 值里取对象（缺省空对象）。 */
function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

/**
 * 解析渠道 id（环境变量）。
 * @param env - 进程环境。
 * @returns 渠道 id；非法即抛错（构建期 fail-loud，不产出错误渠道的包）。
 */
export function resolveBuildChannelId(env: NodeJS.ProcessEnv = process.env): string {
  const raw = text(env[CHANNEL_ENV])
  if (raw === undefined) return 'official'
  if (!CHANNEL_ID_PATTERN.test(raw)) {
    throw new Error(
      `channel-build: ${CHANNEL_ENV}=${JSON.stringify(raw)} 不是合法渠道 id`
      + '（期望 ^[a-z0-9][a-z0-9-]{0,31}$）',
    )
  }
  return raw
}

/** 渠道包里与编译期品牌相关的字段（全部可选）。 */
export interface ChannelDesktopBranding {
  readonly productName?: string
  readonly slug?: string
  readonly appId?: string
  readonly shortcutName?: string
  readonly linuxMaintainer?: string
  readonly linuxSynopsis?: string
  readonly deepLinkScheme?: string
  readonly deepLinkName?: string
}

/**
 * 读取渠道包里与**编译期品牌**相关的字段。
 * @param channelDir - `channels/<id>/` 目录（不存在时返回空对象：本地开发）。
 * @returns 覆盖值；缺失字段一律 undefined，由调用方回落官方默认。
 * @throws 渠道包存在但不可解析时抛错（构建期 fail-loud）。
 */
export function readChannelDesktopBranding(channelDir: string): ChannelDesktopBranding {
  const file = join(channelDir, 'channel.json')
  if (!existsSync(file)) return {}
  const raw = readFileSync(file, 'utf8')
  if (raw.length > 64 * 1024) throw new Error(`channel-build: ${file} 超过 64KB`)
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (cause) {
    throw new Error(`channel-build: ${file} 不是合法 JSON: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`channel-build: ${file} 必须是对象`)
  }
  const root = record(value)
  const desktop = record(root.desktop)
  const identity = record(root.identity)
  const productName = text(desktop.product_name) ?? text(identity.display_name)
  const slug = text(desktop.slug)
  const appId = text(desktop.app_id)
  const maintainer = text(desktop.maintainer)
  const result: {
    productName?: string
    slug?: string
    appId?: string
    shortcutName?: string
    linuxMaintainer?: string
    linuxSynopsis?: string
    deepLinkScheme?: string
    deepLinkName?: string
  } = {}
  if (productName !== undefined) result.productName = productName
  if (slug !== undefined) result.slug = slug
  if (appId !== undefined) result.appId = appId
  if (maintainer !== undefined) result.linuxMaintainer = maintainer
  // 快捷方式名/发行版描述缺省跟随产品名：渠道只写一个名字也应该处处一致。
  const shortcutName = text(desktop.shortcut_name) ?? productName
  if (shortcutName !== undefined) result.shortcutName = shortcutName
  const synopsis = text(desktop.synopsis) ?? productName
  if (synopsis !== undefined) result.linuxSynopsis = synopsis
  const deepLinkScheme = text(desktop.deep_link_scheme)
  if (deepLinkScheme !== undefined) result.deepLinkScheme = deepLinkScheme
  const deepLinkName = text(desktop.deep_link_name)
  if (deepLinkName !== undefined) result.deepLinkName = deepLinkName
  return result
}

/** `resolveChannelBuildContext` 的可覆盖输入（测试用）。 */
export interface ChannelBuildOptions {
  readonly env?: NodeJS.ProcessEnv
  readonly repoRoot?: string
}

/** 仓库根（本文件位于 packages/host/desktop/scripts/）。 */
function defaultRepoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
}

/**
 * 解析本次构建的渠道上下文。
 *
 * 官方渠道（未设 `DSH_BUILD_CHANNEL`）返回的全是官方默认值，且 `brandDir`
 * 指向 `brands/official/` —— 与改造前一致。
 * @param options - 环境与仓库根（测试可覆盖）。
 * @returns 渠道 id、素材目录与 electron-builder 覆盖参数。
 * @throws 渠道 id 非法、或渠道包里的 slug/appId 形状不对时抛错。
 */
export function resolveChannelBuildContext(
  options: ChannelBuildOptions = {},
): ChannelBuildContext {
  const env = options.env ?? process.env
  const repoRoot = options.repoRoot ?? defaultRepoRoot()
  const channelId = resolveBuildChannelId(env)
  const official = channelId === 'official'
  const channelDir = join(repoRoot, 'channels', channelId)
  const branding = official ? {} : readChannelDesktopBranding(channelDir)

  const slug = branding.slug ?? OFFICIAL_BUILD_DEFAULTS.slug
  if (!SLUG_PATTERN.test(slug)) {
    throw new Error(
      `channel-build: 渠道 ${channelId} 的 desktop.slug=${JSON.stringify(slug)} 非法`
      + '（期望 ASCII 字母/数字/连字符）—— 它决定安装包名与可执行名，必须是纯 ASCII',
    )
  }
  // 构建期对畸形 scheme **fail-loud**(与 slug/appId 同规格):畸形 scheme 会让
  // 浏览器回调打不开客户端,这种包不该被生产出来。运行期(desktop-channel.ts)
  // 则回落官方值 —— 那里没有"拒绝构建"这个选项,能用比报错好。
  const deepLinkScheme = branding.deepLinkScheme ?? OFFICIAL_BUILD_DEFAULTS.deepLinkScheme
  if (!DEEP_LINK_SCHEME_PATTERN.test(deepLinkScheme)) {
    throw new Error(
      `channel-build: 渠道 ${channelId} 的 desktop.deep_link_scheme=${JSON.stringify(deepLinkScheme)} 非法`
      + '（期望 RFC 3986 scheme：字母开头，后跟字母/数字/+/-/.）—— 畸形 scheme 会让浏览器回调打不开客户端',
    )
  }
  const appId = branding.appId ?? OFFICIAL_BUILD_DEFAULTS.appId
  if (!APP_ID_PATTERN.test(appId)) {
    throw new Error(`channel-build: 渠道 ${channelId} 的 desktop.app_id=${JSON.stringify(appId)} 非法`)
  }

  // 渠道目录里没有 channel.json（本地开发）时回落官方素材，而不是构建失败。
  const brandDir = official || !existsSync(join(channelDir, 'channel.json'))
    ? join(repoRoot, 'brands', 'official')
    : channelDir

  return {
    channelId,
    official,
    channelDir,
    brandDir,
    productName: branding.productName ?? OFFICIAL_BUILD_DEFAULTS.productName,
    appId,
    slug,
    shortcutName: branding.shortcutName ?? OFFICIAL_BUILD_DEFAULTS.shortcutName,
    linuxMaintainer: branding.linuxMaintainer ?? OFFICIAL_BUILD_DEFAULTS.linuxMaintainer,
    linuxSynopsis: branding.linuxSynopsis ?? OFFICIAL_BUILD_DEFAULTS.linuxSynopsis,
    deepLinkScheme,
    deepLinkName: branding.deepLinkName ?? `${branding.productName ?? OFFICIAL_BUILD_DEFAULTS.productName} Deep Link`,
    artifactNames: artifactNames(slug),
  }
}

/**
 * 把渠道上下文翻译成 electron-builder 的 `--config.*` 覆盖参数。
 *
 * 官方渠道返回**空数组**：不做任何覆盖，产物与改造前一致。
 * @param context - `resolveChannelBuildContext()` 的结果。
 * @returns 追加到 electron-builder 命令行的参数。
 */
export function channelBuilderConfigArgs(
  context: ChannelBuildContext,
  configFilePath?: string,
): string[] {
  if (context.official) return []
  if (configFilePath === undefined) {
    throw new Error('channel-build: 渠道构建需要生成的 electron-builder 配置文件路径')
  }
  // 全部覆盖都放进配置文件:标量本可以用 `--config.x=y`,但 protocols 这类
  // 数组**只能**走配置文件(CLI 点号覆盖不支持数组下标,见
  // writeChannelBuilderConfig 的说明),混用两套来源只会增加出错面。
  return ['--config', configFilePath]
}

/**
 * 打包脚本的统一入口:按渠道生成配置文件并返回要追加的 electron-builder 参数。
 *
 * 官方渠道返回 `[]`(不做任何覆盖,产物与改造前一致),也不会写任何文件。
 * @param context - 渠道上下文。
 * @param workDir - 生成文件写到哪里(缺省 package 根的 build/)。
 * @returns 追加到 electron-builder 命令行的参数。
 */
export function prepareChannelBuilderOverrides(
  context: ChannelBuildContext,
  workDir?: string,
): string[] {
  // 应用资源目录 = 生成的配置文件与**随包分发的渠道包**共同的落点。两者必须
  // 同进同出:工作目录是测试/临时构建的覆盖点(见各打包脚本的 channelConfigArgs)。
  const appDir = workDir ?? join(defaultRepoRoot(), 'packages/host/desktop', 'build')
  // 先就位**运行期**渠道包，再谈编译期覆盖:两者缺一，渠道构建就是半成品
  // (见 stageChannelProfile 的说明)。官方渠道也要走一遍 —— 它的作用是**清掉**
  // 上一次渠道构建留下的文件。
  stageChannelProfile(context, appDir)
  if (context.official) return []
  const target = join(appDir, 'channel-electron-builder.cjs')
  return channelBuilderConfigArgs(context, writeChannelBuilderConfig(context, target))
}

/**
 * 本次打包产物**声明**的产品名 —— 打包、验证、E2E 共用的唯一解析。
 *
 * 真源与运行期完全一致：随包 `build/channel.json` 的
 * `desktop.product_name ?? identity.display_name`；没有渠道包（官方/本地）时
 * 用官方默认值。
 *
 * **为什么验证脚本必须走它**：窗口标题/应用名是白标最直观的一面，历史上
 * 多处验证脚本硬编码 `'PicoAide Harness'` 或只读 `package.json` —— 渠道构建下
 * 那是客户的名字，于是这些"门禁"要么永远红（渠道矩阵被卡死），要么把厂商名
 * 反向锁进发布链。断言应当对齐"这次构建声明了什么"，而不是某个具体品牌。
 * @param buildDir - `packages/host/desktop/build` 目录（默认仓库内该目录）。
 * @returns 非空产品名。
 * @throws 渠道包存在但不可解析时抛错（验证期 fail-loud，不猜）。
 */
export function packagedProductName(buildDir?: string): string {
  const dir = buildDir ?? join(defaultRepoRoot(), 'packages/host/desktop', 'build')
  if (existsSync(join(dir, 'channel.json'))) {
    // 与运行期同源:同一个文件名、同一套解析(readChannelDesktopBranding)。
    const name = readChannelDesktopBranding(dir).productName
    if (name !== undefined) return name
  }
  return OFFICIAL_BUILD_DEFAULTS.productName
}

/**
 * 把渠道包就位到客户端应用资源里（`build/channel.json`）。
 *
 * **为什么必须有这一步**：`src/desktop-channel.ts` 的 `readDesktopChannelProfile()`
 * 在**运行时**读的就是这个文件，它决定登录前才知道的东西 —— 默认服务端地址
 * （配了就让客户端开机直连，用户不必手输自家域名）、产品名/窗口标题、登录页与
 * 侧边栏的品牌文案、深链 scheme。这些**不能**由 electron-builder 的编译期参数
 * 决定（那是另一套：appId/图标/安装包名），只能随包分发。
 *
 * 2026-09-10 实测发现这条链此前是**死的**：整个仓库没有任何地方写这个文件，
 * 于是渠道构建里 `readDesktopChannelProfile()` 永远返回 undefined —— 客户端
 * 不直连渠道域名、窗口标题回落厂商品牌、登录页显示厂商名。与此前
 * `CLIENT-RELEASE.json` 放错目录（服务端清单缺 client 块）是同一类事故：
 * 链路缺一环，但不报错。
 *
 * **官方渠道必须走删除分支**：渠道构建写下的文件若残留，下一次本地/官方构建
 * 会继承那个渠道的品牌 —— 比"没生效"更糟。所以这里不做"存在才写"，
 * 而是每次构建都明确二选一。
 * @param context - 渠道上下文。
 * @param buildDir - `packages/host/desktop/build` 目录。
 * @returns 就位后的文件路径；官方渠道（或渠道无包）返回 undefined。
 * @throws 渠道包缺失/不可解析/`channel_id` 与所选渠道不一致时抛错。
 */
export function stageChannelProfile(
  context: ChannelBuildContext,
  buildDir: string,
): string | undefined {
  const target = join(buildDir, 'channel.json')
  const source = join(context.channelDir, 'channel.json')
  if (context.official || !existsSync(source)) {
    // 本地开发（没有渠道目录）走这里:必须清掉残留，否则会用错品牌。
    rmSync(target, { force: true })
    return undefined
  }
  const raw = readFileSync(source, 'utf8')
  if (raw.length > 64 * 1024) {
    throw new Error(`channel-build: ${source} 超过 64KB（客户端侧上限，见 desktop-channel.ts）`)
  }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (cause) {
    throw new Error(`channel-build: ${source} 不是合法 JSON: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  const declared = text(record(value).channel_id)
  // 目录名与 channel_id 不一致 = 渠道包放错了位置:装出来的客户端会声称自己是
  // 另一个渠道（服务端镜像按 channel_id 对账，两边就此各说各话）。
  if (declared !== context.channelId) {
    throw new Error(
      `channel-build: ${source} 的 channel_id=${JSON.stringify(declared)} 与构建渠道 ${context.channelId} 不一致`,
    )
  }
  mkdirSync(buildDir, { recursive: true })
  writeFileSync(target, raw)
  return target
}

/**
 * 生成渠道构建专用 electron-builder 配置文件。
 *
 * **为什么不用 `--config.protocols[0].schemes[0]=…`**:2026-09-10 实测,
 * electron-builder 的 CLI 点号覆盖**不支持数组下标** —— 它把 `protocols[0]`
 * 当成一个顶层属性名,直接以
 * `configuration has an unknown property 'protocols[0]'` 拒绝整次构建。
 * 数组型字段(protocols)只能走配置文件。
 *
 * 配置对象 = package.json 的 build 块 **深展开** + 渠道覆盖,因此无论
 * electron-builder 把 `--config <file>` 当作"替换"还是"合并",结果都一致。
 * @param context - 渠道上下文。
 * @param outputPath - 写到哪里(相对仓库根或绝对路径)。
 * @returns 写出的绝对路径。
 */
export function writeChannelBuilderConfig(context: ChannelBuildContext, outputPath: string): string {
  if (context.official) {
    throw new Error('channel-build: 官方渠道不需要生成配置文件(不做任何覆盖)')
  }
  const manifest = JSON.parse(
    readFileSync(join(defaultRepoRoot(), 'packages/host/desktop/package.json'), 'utf8'),
  ) as { build?: Record<string, unknown> }
  const names = context.artifactNames
  const config = {
    ...manifest.build,
    productName: context.productName,
    appId: context.appId,
    // 数组整体替换:CLI 下标覆盖不可用(见上),配置文件里直接给完整数组。
    protocols: [{ name: context.deepLinkName, schemes: [context.deepLinkScheme] }],
    mac: { ...record(manifest.build?.mac), artifactName: names.mac },
    win: { ...record(manifest.build?.win), artifactName: names.win },
    nsis: { ...record(manifest.build?.nsis), artifactName: names.nsis, shortcutName: context.shortcutName },
    linux: {
      ...record(manifest.build?.linux),
      artifactName: names.linux,
      maintainer: context.linuxMaintainer,
      synopsis: context.linuxSynopsis,
    },
  }
  const target = isAbsolute(outputPath) ? outputPath : join(defaultRepoRoot(), outputPath)
  writeFileSync(target, `// 由 scripts/channel-build.ts 生成 —— 渠道 ${context.channelId} 的打包配置。
module.exports = ${JSON.stringify(config, null, 2)}\n`)
  return target
}

/** 展开安装包名模板。 */
export interface ArtifactNameValues {
  readonly version: string
  readonly arch: string
  readonly ext: string
}

/**
 * 本次构建的安装包文件名（post-pack 校验脚本用）。
 *
 * 与 package.json 里的模板同源：`${version}`/`${arch}`/`${ext}` 展开。
 * @param context - 渠道上下文。
 * @param kind - `mac` / `win` / `nsis` / `linux`。
 * @param values - 展开值。
 * @returns 展开后的文件名。
 */
export function channelArtifactName(
  context: ChannelBuildContext,
  kind: keyof ChannelArtifactNames,
  values: ArtifactNameValues,
): string {
  return context.artifactNames[kind]
    .replaceAll('${version}', values.version)
    .replaceAll('${arch}', values.arch)
    .replaceAll('${ext}', values.ext)
}

/** 判断路径是否是可读的普通文件（brand-prepare 的逐文件回落用）。 */
export function assetExists(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}
