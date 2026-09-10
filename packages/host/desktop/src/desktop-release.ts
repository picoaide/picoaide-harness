/**
 * Single authority for the desktop update source.
 *
 * 2026-09-10 定案（用户拍板）：**客户端只从它登录的那台服务端取更新**，
 * 不直接访问 `release.picoaide.com`。
 *
 * 为什么不能直连分发面（这是本文件的核心约束，改设计前先读完）：
 *   - **渠道版本错乱**：分发面按渠道分目录（`<channel>/latest.json`），客户端
 *     一旦直连就必须自带渠道身份；而渠道身份只能靠构建期注入，注入错了、
 *     漏了或畸形，客户端就变成另一个渠道的客户端，会被别的渠道的清单升级
 *     并"洗"成那个渠道（最严重的一类错）。
 *   - **内网/隔离网部署**：产品的主要形态是企业内网部署，员工机器不该、
 *     也常常不能访问任何外网。
 *   - 改走服务端后，「客户端属于哪个渠道」由**它登录的服务端**在结构上决定，
 *     客户端不需要（也不再）知道自己属于哪个渠道 —— 错乱不可能发生。
 *
 * 于是本文件只保留两件事：①服务端更新清单的地址拼装；②清单结构的严格校验。
 * 分发面（R2）只服务端自己的"检查更新"用（给管理员提示），与客户端无关，
 * 因此不在本模块表达。
 *
 * 服务端的清单端点与服务端自己的检查同形状（`GET /api/client/v2/updates/manifest`
 * 与 R2 上的 `latest.json` 字段一致），所以解析逻辑只有一份。
 * @module dsh-plugin-desktop/desktop-release
 */

/** 渠道 id 合法形状：小写字母/数字/连字符，1–32 位（与品牌文件夹命名同源）。 */
export const CHANNEL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/u

/** 服务端下发客户端安装包清单的路径（公开端点，登录前也可取）。 */
export const SERVER_UPDATE_MANIFEST_PATH = '/api/client/v2/updates/manifest'

/** 服务端下发渠道内容（渠道 id / 名称 / 标语）的路径（公开端点）。 */
export const SERVER_CHANNEL_PATH = '/api/client/v2/channel'

/**
 * 去掉 URL 末尾的斜杠（兼容写入时带斜杠的服务端地址）。
 * 不用正则：尾斜杠剥离曾被 CodeQL 标为多项式回溯（见 channel-sync 同款注释）。
 * @param value - 原始地址。
 * @returns 去掉尾部斜杠的地址。
 */
function trimTrailingSlashes(value: string): string {
  let trimmed = value
  while (trimmed.endsWith('/')) trimmed = trimmed.slice(0, -1)
  return trimmed
}

/**
 * 组装服务端的版本清单地址。
 * @param serverURL - 已登录的服务端地址（调用方负责 https/回环校验）。
 * @returns 绝对 URL。
 */
export function serverManifestURL(serverURL: string): string {
  return `${trimTrailingSlashes(serverURL)}${SERVER_UPDATE_MANIFEST_PATH}`
}

/**
 * 组装服务端的渠道内容地址（用于交叉校验清单声明的渠道）。
 * @param serverURL - 已登录的服务端地址。
 * @returns 绝对 URL。
 */
export function serverChannelURL(serverURL: string): string {
  return `${trimTrailingSlashes(serverURL)}${SERVER_CHANNEL_PATH}`
}

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

/**
 * 读取清单里的"服务端给不出下载地址"说明（`client_unavailable`）。
 *
 * 服务端在**推不出安全（https）对外地址**时不下发 `client` 段，而是给一个原因
 * （见 server 的 `internal/clientrelease`）—— 那与"没有新版本"是两件事：前者要
 * 提示用户/管理员去修配置，后者才是"已是最新"。只认非空字符串，其余一律 undefined。
 * @param input - 清单 JSON（`JSON.parse` 之后）。
 * @returns 原因文本，或 undefined。
 */
export function readClientUnavailableReason(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined
  const reason = input.client_unavailable
  return typeof reason === 'string' && reason.trim() !== '' ? reason.trim() : undefined
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
