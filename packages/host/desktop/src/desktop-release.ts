/**
 * Single authority for the PicoAide update server surface.
 *
 * 2026-09-10 起更新源**只有**我方更新服务器（Cloudflare R2 静态对象，经
 * https://release.picoaide.com 对外），GitHub Releases 更新通道已彻底移除：
 * 匿名 API 限流（60 次/小时/IP，企业出口共用一个 IP 必然触发）与国内不可达
 * 是两个绕不过去的硬伤。
 *
 * 客户端有两类渠道：
 *   - 官方渠道：base = https://release.picoaide.com/official（本文件默认值）
 *   - 企业渠道：base = 渠道自己的更新面（客户自部署服务端 / 渠道专属目录），
 *     由构建期注入渠道配置覆盖 `resolveUpdateBaseURL`。
 *
 * 协议见 docs/planning/2026-09-10-r2-update-server-runbook.md §6。
 * @module dsh-plugin-desktop/desktop-release
 */

/** 官方渠道 id（稳定版）。 */
export const OFFICIAL_CHANNEL = 'official'

/** 预发渠道 id（我们自己内测；与官方渠道**互不升级**）。 */
export const BETA_CHANNEL = 'beta'

/** 渠道 id 合法形状：小写字母/数字/连字符，1–32 位（与品牌文件夹命名同源）。 */
export const CHANNEL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/u

/** 默认更新服务器 base（官方渠道目录）。 */
export const DESKTOP_UPDATE_BASE_URL = 'https://release.picoaide.com/official'

/**
 * 组装某渠道的更新面 base。
 * @param channel - 渠道 id（`beta` / `official` / 品牌渠道 id）。
 * @returns 该渠道在更新服务器上的目录地址；非法渠道回落到官方目录。
 */
export function channelBaseURL(channel: string = OFFICIAL_CHANNEL): string {
  const id = CHANNEL_ID_PATTERN.test(channel) ? channel : OFFICIAL_CHANNEL
  return `https://release.picoaide.com/${id}`
}

/** 版本清单文件名（更新服务器上的固定入口，内容随版本覆盖）。 */
export const UPDATE_MANIFEST_FILE = 'latest.json'

/** 清单协议版本；不匹配即拒绝，避免旧客户端误读新结构。 */
export const UPDATE_MANIFEST_SCHEMA = 1

/** 客户端安装包支持的平台标识。 */
export type DesktopReleasePlatform = 'darwin' | 'win32' | 'linux'

/** 清单里单个平台安装包的描述。 */
export interface DesktopReleaseAsset {
  /** 安装包绝对下载地址。 */
  readonly url: string
  /** 安装包 SHA-256（小写十六进制）。 */
  readonly sha256: string
  /** 安装包字节数；清单未提供时为 0。 */
  readonly size: number
}

/** 解析后的版本清单（客户端升级所需的全部信息）。 */
export interface DesktopReleaseManifest {
  /** 清单协议版本。 */
  readonly schema: number
  /** 渠道标识（排查与归因用）。 */
  readonly channelId: string
  /** 客户端版本（权威）。 */
  readonly clientVersion: string
  /** 各平台安装包。 */
  readonly assets: Readonly<Partial<Record<DesktopReleaseAssetKey, DesktopReleaseAsset>>>
}

/** 清单 assets 的键（与服务端 manifest 同源，独立类型以便索引收窄）。 */
export type DesktopReleaseAssetKey = 'mac-universal' | 'win-x64' | 'linux-x64'

/**
 * 平台 → 清单 assets 的键。
 * 与服务端 `GET /api/client/v2/updates/manifest` 使用同一套键名。
 */
export const PLATFORM_ASSET_KEYS: Readonly<Record<DesktopReleasePlatform, DesktopReleaseAssetKey>> = {
  darwin: 'mac-universal',
  win32: 'win-x64',
  linux: 'linux-x64',
}

/**
 * 取某平台的安装包描述。
 * @param manifest - 已解析的清单。
 * @param platform - 目标平台。
 * @returns 资产描述；该平台未发布时为 undefined。
 */
export function releaseAssetFor(
  manifest: DesktopReleaseManifest,
  platform: DesktopReleasePlatform,
): DesktopReleaseAsset | undefined {
  return manifest.assets[PLATFORM_ASSET_KEYS[platform]]
}

/**
 * 组装版本清单地址。
 * @param baseURL - 渠道更新面 base（末尾斜杠容错）；缺省为官方渠道。
 * @returns 绝对 URL。
 */
export function updateManifestURL(baseURL: string = DESKTOP_UPDATE_BASE_URL): string {
  return `${baseURL.replace(/\/+$/u, '')}/${UPDATE_MANIFEST_FILE}`
}

const SHA256_HEX = /^[0-9a-f]{64}$/u

/**
 * 严格解析版本清单。任何结构不符都返回 null（调用方静默降级为「无更新」）。
 *
 * 只接受**绝对 https** URL 与非空 sha256：清单是安全边界 —— 拼接式下载地址
 * 与缺失哈希（等于放弃完整性校验）都必须拒绝，而不是尽力猜测。
 *
 * `channel_id` **必填**，且给了 `expectedChannel` 时必须精确相等：渠道隔离是
 * 正确性要求 —— 品牌客户端若接受官方渠道的清单，升级后会被"洗"成官方客户端、
 * 品牌丢失；反之官方客户端接受品牌清单会装到定制版。缺失/串渠道一律拒绝。
 * @param input - JSON.parse 之后的对象。
 * @param expectedChannel - 本安装所属渠道；省略则不校验渠道值（仍要求字段存在）。
 * @returns 解析结果或 null。
 */
export function parseReleaseManifest(
  input: unknown,
  expectedChannel?: string,
): DesktopReleaseManifest | null {
  if (!isRecord(input)) return null
  if (input.schema !== UPDATE_MANIFEST_SCHEMA) return null

  const channelId = input.channel_id
  if (typeof channelId !== 'string' || channelId === '') return null
  if (expectedChannel !== undefined && channelId !== expectedChannel) return null

  const client = input.client
  if (!isRecord(client) || typeof client.version !== 'string' || client.version === '') return null

  const rawAssets = client.assets
  if (!isRecord(rawAssets)) return null

  const assets: Partial<Record<DesktopReleaseAssetKey, DesktopReleaseAsset>> = {}
  const platforms: readonly DesktopReleasePlatform[] = ['darwin', 'win32', 'linux']
  for (const platform of platforms) {
    const entry = rawAssets[PLATFORM_ASSET_KEYS[platform]]
    if (entry === undefined) continue
    if (!isRecord(entry)) return null
    const { url, sha256, size } = entry
    if (typeof url !== 'string' || !isHttpsURL(url)) return null
    if (typeof sha256 !== 'string' || !SHA256_HEX.test(sha256)) return null
    if (size !== undefined && (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0)) {
      return null
    }
    assets[PLATFORM_ASSET_KEYS[platform]] = { url, sha256, size: typeof size === 'number' ? size : 0 }
  }
  if (Object.keys(assets).length === 0) return null

  return {
    schema: UPDATE_MANIFEST_SCHEMA,
    channelId,
    clientVersion: client.version,
    assets,
  }
}

function isHttpsURL(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
