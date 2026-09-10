/**
 * 渠道包在客户端侧的读取与派生（渠道化构建的运行时出口）。
 *
 * **渠道包**指私有仓 `picoaide/channels/<channel-id>/` 里的那份配置
 * （`channel.json` + logo 等素材）。服务端镜像在构建时把它打进
 * `/opt/picoaide/channel/`；客户端构建则把它打进应用资源，于是同一个渠道的
 * 客户端与服务端来自**同一份**配置，不会各说各话。
 *
 * 客户端需要在**登录之前**就知道两件事，所以它们必须随包而非随服务端下发
 * （服务端地址是鸡生蛋问题，登录前拿不到；窗口标题与产品名在登录页出现时
 * 就已经可见）：
 *
 *   1. 服务端地址（`defaults.server_url`）—— 配了就让客户端开机直连，
 *      用户不必手输自己公司的地址；
 *   2. 产品名/窗口标题（`desktop.product_name` / `desktop.window_title`）。
 *
 * 文件缺失（本地开发、未渠道化的构建）时返回 undefined，调用方沿用原有
 * 行为 —— 渠道化是增量，不是新的必填项。
 *
 * 编译期品牌（appId / 协议 scheme / 安装包名 / 应用图标）**不在这里**：
 * 那些由 electron-builder 在打包时决定，属于 CI 的渠道矩阵参数，
 * 运行时读文件来不及改。见 docs/planning/2026-09-04-enterprise-channel-branding.md。
 * @module dsh-plugin-desktop/desktop-channel
 */

import { readFileSync } from 'node:fs'

/** 渠道包在应用资源里的位置（随包分发，构建时由 CI 从渠道仓复制）。 */
const CHANNEL_PROFILE_FILE = new URL('../build/channel.json', import.meta.url)

/** 渠道 id 合法形状：与客户端 CHANNEL_ID_PATTERN / 服务端 IsChannelID 同源。 */
const CHANNEL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/u

/** 渠道包在客户端侧生效的那部分内容。 */
export interface DesktopChannelProfile {
  /** 渠道 id（与镜像、R2 目录、服务端渠道内容同源）。 */
  readonly channelId: string
  /** 渠道配置的默认服务端地址（已校验；未配置时为 undefined）。 */
  readonly defaultServerURL: string | undefined
  /** 桌面产品名（未配置时为 undefined，调用方沿用自身默认值）。 */
  readonly productName: string | undefined
  /** 桌面窗口标题（未配置时回落到 productName）。 */
  readonly windowTitle: string | undefined
}

/**
 * 判定渠道包里的服务端地址是否可接受。
 *
 * 与 auth-gate 的用户输入校验同一口径：**必须 https，回环地址允许 http**
 * （内网自签/本机调试）。渠道包是自家构建产物，但仍然校验 —— 防的是渠道配置
 * 写错把整批客户端指向明文端点，而不是防攻击者。
 * @param value - 渠道包里的 `defaults.server_url`。
 * @returns 可接受时返回规范化后的地址（去尾斜杠）；否则 undefined。
 */
export function normalizeDefaultServerURL(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  let trimmed = value.trim()
  while (trimmed.endsWith('/')) trimmed = trimmed.slice(0, -1)
  if (trimmed === '') return undefined
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return undefined
  }
  if (parsed.protocol === 'https:') return trimmed
  if (parsed.protocol !== 'http:') return undefined
  const host = parsed.hostname
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1'
  return loopback ? trimmed : undefined
}

/** 取非空字符串（渠道包字段可能缺失或类型不对）。 */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * 严格解析渠道包内容。任何结构不符都返回 undefined（调用方沿用默认行为）。
 * @param input - `JSON.parse` 之后的对象。
 * @returns 客户端需要的渠道内容，或 undefined。
 */
export function parseDesktopChannelProfile(input: unknown): DesktopChannelProfile | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined
  const record = input as Record<string, unknown>
  const channelId = nonEmptyString(record.channel_id)
  // 渠道 id 形状不对等于"这份配置不是给我们的"：宁可当作没有渠道包,
  // 也不要拿一个畸形 id 去拼路径或参与对账。
  if (channelId === undefined || !CHANNEL_ID_PATTERN.test(channelId)) return undefined

  const defaults = record.defaults
  const desktop = record.desktop
  const identity = record.identity
  const defaultServerURL = normalizeDefaultServerURL(
    typeof defaults === 'object' && defaults !== null
      ? (defaults as Record<string, unknown>).server_url
      : undefined,
  )
  const desktopRecord = typeof desktop === 'object' && desktop !== null && !Array.isArray(desktop)
    ? desktop as Record<string, unknown>
    : {}
  const identityRecord = typeof identity === 'object' && identity !== null && !Array.isArray(identity)
    ? identity as Record<string, unknown>
    : {}
  const productName = nonEmptyString(desktopRecord.product_name)
    ?? nonEmptyString(identityRecord.display_name)
  const windowTitle = nonEmptyString(desktopRecord.window_title) ?? productName

  return { channelId, defaultServerURL, productName, windowTitle }
}

/**
 * 读取随包分发的渠道包内容。
 *
 * 文件不存在（本地开发/未渠道化的构建）或内容损坏时返回 undefined：
 * 渠道化是增量能力，缺失不能变成启动失败。
 * @returns 客户端渠道内容，或 undefined。
 */
export function readDesktopChannelProfile(): DesktopChannelProfile | undefined {
  let raw: string
  try {
    raw = readFileSync(CHANNEL_PROFILE_FILE, 'utf8')
  } catch {
    return undefined
  }
  if (raw.length > 64 * 1024) return undefined
  try {
    return parseDesktopChannelProfile(JSON.parse(raw))
  } catch {
    return undefined
  }
}
