/**
 * 渠道包在客户端侧的读取与派生（渠道化构建的运行时出口）。
 *
 * **渠道包**指私有仓 `picoaide/channels/<channel-id>/` 里的那份配置
 * （`channel.json` + logo 等素材）。服务端镜像在构建时把它打进
 * `/opt/picoaide/channel/`；客户端构建则把它打进应用资源，于是同一个渠道的
 * 客户端与服务端来自**同一份**配置，不会各说各话。
 *
 * 客户端需要在**登录之前**就知道三件事，所以它们必须随包而非随服务端下发
 * （服务端地址是鸡生蛋问题，登录前拿不到；窗口标题与品牌文案在登录页出现时
 * 就已经可见）：
 *
 *   1. 服务端地址（`defaults.server_url`）—— 配了就让客户端开机直连，
 *      用户不必手输自己公司的地址；
 *   2. 产品名/窗口标题（`desktop.product_name` / `desktop.window_title`）；
 *   3. 品牌文案（`identity.*` / `copy.*`）—— 登录页品牌区、侧边栏与关于页。
 *      取值链与服务端 `channel.go` 的 `applyDefaults` **同序**，避免"登录页
 *      一个名、登录后另一个名"。
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
import { channelDshHomeDir } from './desktop-home.ts'

/** 渠道包在应用资源里的位置（随包分发，构建时由 CI 从渠道仓复制）。 */
const CHANNEL_PROFILE_FILE = new URL('../build/channel.json', import.meta.url)

/** 渠道 id 合法形状：与客户端 CHANNEL_ID_PATTERN / 服务端 IsChannelID 同源。 */
const CHANNEL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/u

/** 官方渠道的深链 scheme(改造前的硬编码值)。 */
export const DEFAULT_DEEP_LINK_SCHEME = 'picoaide'

/** 官方产品名（没有渠道包时的内置兜底；渠道构建必须由渠道包给出）。 */
export const OFFICIAL_PRODUCT_NAME = 'PicoAide Harness'

/** 应用 id（bundle id / AppUserModelId）形状：反向域名。 */
const APP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]*$/u

/**
 * 渠道包没配品牌时的中性占位（与服务端 `fallbackBrandName` 同值）。
 *
 * 刻意**不含厂商品牌**：这条路径只在"包里没有品牌内容"时走到，而在渠道构建里
 * 那等于注入链断了 —— 显示一个中性名，好过把厂商名显示给渠道客户（那正是白标
 * 要防的事故）。正常渠道构建到不了这里：`ci-channels.sh` 强制每个渠道必须写
 * `identity.display_name`，缺了直接中止构建。
 */
export const NEUTRAL_BRAND_NAME = 'Harness'

/**
 * 产品名（`desktop.product_name`）的形状（2026-09-12 审计 P1-13）。
 *
 * 这个字段不只是显示名，它同时是**路径型字段**：渠道构建的 Electron userData
 * 目录名（`desktop-user-data.ts`）与 mac 的 `<产品名>.app` 目录名都由它派生。
 * 同批字段里它是唯一没有形状校验的（slug / app_id / deep_link_scheme / home_dir
 * 都有），于是一份渠道包写 `"../evil"` 就能把整个数据根挪出 `appData`。
 *
 * 规则（与 home_dir / app_id 同口径）：1–64 字符；禁路径分隔符与控制字符；
 * 禁 Windows 非法字符（`<>:"|?*`，Windows 上含它们的目录名直接建不出来）；
 * 不以空白开头、不以点或空格结尾（`..`、`Acme.` 是它的子集）。
 * 允许非 ASCII（中文产品名合法）与内部空格（`Acme Harness`）。
 * 构建期同款校验在 `scripts/ci-channels.sh`（fail-loud 在客户机器之前）。
 */
const PRODUCT_NAME_PATTERN = /^[^\s/\\:*?"<>|\u0000-\u001F\u007F][^/\\:*?"<>|\u0000-\u001F\u007F]{0,63}$/u

/**
 * 是否是形状合法的产品名（`undefined`/`''`/畸形值一律 false）。
 * @param value - 渠道包里的 `desktop.product_name`（不可信输入）。
 * @returns 合法时为 true。
 */
export function isSafeProductName(value: unknown): value is string {
  return typeof value === 'string' && PRODUCT_NAME_PATTERN.test(value) && !/[. ]$/u.test(value)
}

/**
 * 依次取第一个形状合法的产品名（`desktop.product_name` → `identity.display_name`）。
 *
 * 为什么校验的是**最终取值**而不是只校验 product_name：`display_name` 是
 * product_name 的回落来源，只校验前者的话 `display_name: "../evil"` 会从后门拿到
 * 同一个路径型出口。两个都不合形状时给中性占位（`NEUTRAL_BRAND_NAME`）——
 * 绝不回落到厂商名，也绝不让畸形值进路径。
 * @param candidates - 候选值（按优先级）。
 * @returns 产品名（永不为空串）。
 */
function safeProductName(...candidates: readonly unknown[]): string {
  for (const candidate of candidates) {
    const value = nonEmptyString(candidate)
    if (value !== undefined && isSafeProductName(value)) return value
  }
  return NEUTRAL_BRAND_NAME
}

/**
 * 渠道包在客户端侧生效的品牌文案（登录前就要用，所以必须随包）。
 *
 * 与 `ChannelConfig`（服务端下发）**同形但不是同一来源**：这份是构建期随包
 * 分发的兜底内容，服务端可达时以后者为准。两者字段口径一致，客户端合并时
 * 逐字段覆盖即可。空串表示"渠道没配这一项"，消费方自行决定是否显示。
 *
 * `displayName` 一定有值（缺失时是中性占位 `NEUTRAL_BRAND_NAME`，绝不是厂商
 * 品牌）；`shortName`/`tagline` 允许是空串 —— 它们是**提示**，消费方拿不到就
 * 回落到显示名或不显示。
 */
export interface ChannelBrand {
  /** 渠道 id（仅供排查/对账）。 */
  readonly channelId: string
  /** 页面标题用的名字（登录页/恢复页，避免无处可读时露出厂商名）。 */
  readonly title: string
  /** 登录页品牌区。 */
  readonly login: { readonly displayName: string; readonly shortName: string; readonly tagline: string; readonly welcome: string }
  /** 客户端界面品牌区（侧边栏/顶栏/关于）。 */
  readonly client: { readonly displayName: string; readonly shortName: string; readonly tagline: string }
  /**
   * 随包 logo（`data:` URI，来自渠道目录的 `assets.logo`）。
   *
   * 服务端可达时以服务端下发的 URL 为准；服务端不可达、或服务端还是旧版（没有
   * `/api/client/v2/channel`）时，客户端与登录页显示的就是它 —— 没有它就只能回落
   * 到编译期内置的**官方**花括号 mark（白标客户看到厂商图形）。2026-09-11 实测。
   */
  readonly logoURL?: string
  /** 深色场景的随包 logo（`assets.logo_dark`），同上。 */
  readonly logoDarkURL?: string
}

/**
 * 深链 scheme 合法形状(RFC 3986 scheme):字母开头,后跟字母/数字/+/-/.。
 * 长度另限 2–32,避免病态值。
 */
const DEEP_LINK_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]{1,31}$/u

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
  /**
   * 数据目录名（`~` 下的那一段）—— **本次渠道构建的隔离标识**。
   *
   * 渠道包没写 `desktop.home_dir` 时由 `desktop.slug` 派生、再退到
   * `.picoaide-harness-<channelId>`；**任何情况下都不会等于官方目录**
   * （见 desktop-home.ts 的 `channelDshHomeDir`）。官方构建没有渠道包，
   * 走调用方的官方缺省，行为不变。
   */
  readonly homeDir: string
  /**
   * 应用 id（`desktop.app_id`）：Windows 的 AppUserModelId 用它。
   *
   * 必须与 electron-builder 写进快捷方式的那个值一致，否则渠道客户端的
   * 通知在 Windows 上对不上身份（不弹/不归组）；未配置时为 undefined。
   */
  readonly appId: string | undefined
  /**
   * 深链 scheme（OIDC/OpenID 浏览器回调把 token 交回客户端用的那个）。
   *
   * 渠道构建必须用它自己的 scheme:浏览器在跳回客户端时会弹出
   * "打开 <scheme>?" 的确认框,渠道客户不该在这里看到 `picoaide`。
   * 未配置时回落官方 scheme —— 官方行为逐字节不变。
   */
  readonly deepLinkScheme: string
  /** 深链在操作系统里的注册名（Protocols 显示名）；未配置时为 undefined。 */
  readonly deepLinkName: string | undefined
  /**
   * 随包分发的品牌文案（登录页/客户端界面用）。
   *
   * 登录页在**认证之前**就渲染品牌区，那一刻还没有服务端可问（服务端地址可能
   * 正是用户要输入的东西），所以品牌文案必须随包。渠道包没写品牌时这里是中性
   * 占位，绝不是厂商品牌。
   */
  readonly brand: ChannelBrand
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
 * 只接受 `data:` URI（渠道包是不可信输入：远程 URL 会被当成"客户端开机就请求任意
 * 地址"的能力，因此一律忽略）。
 * @param value - `assets.*_inline` 的取值。
 * @returns 合法的 data URI，或 undefined。
 */
function dataURI(value: unknown): string | undefined {
  const raw = nonEmptyString(value)
  return raw !== undefined && raw.startsWith('data:') ? raw : undefined
}

/** 取对象（数组/null/标量一律当空对象——渠道包是不可信输入）。 */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
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
  const copy = record.copy
  const defaultServerURL = normalizeDefaultServerURL(
    typeof defaults === 'object' && defaults !== null
      ? (defaults as Record<string, unknown>).server_url
      : undefined,
  )
  const desktopRecord = asRecord(desktop)
  const identityRecord = asRecord(identity)
  const copyRecord = asRecord(copy)
  // 形状校验的是**最终取值**(P1-13):product_name → display_name 是取值链,只校验
  // 前者的形状会让 `display_name: "../evil"` 从后门拿到同一个路径型出口(userData
  // 目录名 / mac `.app` 目录名)。两个都不合形状 → 中性占位,绝不回落厂商名。
  const productName = safeProductName(desktopRecord.product_name, identityRecord.display_name)
  const windowTitle = nonEmptyString(desktopRecord.window_title) ?? productName
  const rawScheme = nonEmptyString(desktopRecord.deep_link_scheme)
  // 形状不对就回落官方 scheme:一个畸形 scheme 会让浏览器回调彻底打不开客户端,
  // 静默降级成"官方 scheme"至少还能用(官方构建本来就是这个值)。
  const deepLinkScheme = rawScheme !== undefined && DEEP_LINK_SCHEME_PATTERN.test(rawScheme)
    ? rawScheme
    : DEFAULT_DEEP_LINK_SCHEME
  const deepLinkName = nonEmptyString(desktopRecord.deep_link_name) ?? productName
  // 数据目录名：渠道包显式配的家目录（形状校验）> slug 派生 > `.picoaide-harness-<id>`。
  // 运行期**不**因为畸形值而拒绝启动：渠道化是增量能力，最差也要落到一个
  // 只属于本渠道的目录（回落官方目录才是不可接受的 —— 那是跨租户共享）。
  const declaredHomeDir = nonEmptyString(desktopRecord.home_dir)
  const homeDir = channelDshHomeDir(channelId, {
    homeDir: declaredHomeDir,
    slug: nonEmptyString(desktopRecord.slug),
  })
  const rawAppId = nonEmptyString(desktopRecord.app_id)
  const appId = rawAppId !== undefined && APP_ID_PATTERN.test(rawAppId) ? rawAppId : undefined

  // 品牌文案的取值链必须与服务端 channel.go 的 applyDefaults **同序**：
  // 同一个渠道包在客户端自带兜底与服务端下发之间不能给出不同名字，否则
  // 登录页会出现"标题一个名、登录后另一个名"。服务端缺省链见
  // server/internal/channel/channel.go 的 applyDefaults。
  const shortName = nonEmptyString(identityRecord.short_name)
  const displayName = nonEmptyString(identityRecord.display_name)
  const tagline = nonEmptyString(identityRecord.tagline)
  // 随包 logo：`stageChannelProfile()` 把渠道目录里的 logo 内联成 data: URI。
  // 只认 data: 前缀 —— 渠道包是不可信输入，别让它往 <img src> 里塞远程地址
  // （那等于给渠道包一个"客户端开机就请求任意 URL"的能力）。
  const assetsRecord = asRecord(record.assets)
  const logoURL = dataURI(assetsRecord.logo_inline)
  const logoDarkURL = dataURI(assetsRecord.logo_dark_inline)
  const brand: ChannelBrand = {
    channelId,
    title: nonEmptyString(identityRecord.title) ?? displayName ?? NEUTRAL_BRAND_NAME,
    login: {
      displayName: nonEmptyString(copyRecord.login_display_name) ?? shortName ?? NEUTRAL_BRAND_NAME,
      // 短名是**提示字段**（消费方拿不到就回落到显示名），所以缺失时留空串而不是
      // 填中性名 —— 填了中性名会让"渠道只配了 display_name"的侧边栏显示
      // "Harness" 而不是渠道名（消费方无法区分"提示"与"内容"）。
      shortName: shortName ?? '',
      // 标语/欢迎语允许为空：渠道没配就不显示，而不是编一句。
      tagline: nonEmptyString(copyRecord.login_tagline) ?? tagline ?? '',
      welcome: nonEmptyString(copyRecord.login_welcome) ?? '',
    },
    client: {
      displayName: nonEmptyString(copyRecord.client_display_name) ?? displayName ?? NEUTRAL_BRAND_NAME,
      shortName: shortName ?? '',
      tagline: nonEmptyString(copyRecord.client_tagline) ?? tagline ?? '',
    },
    ...(logoURL === undefined ? {} : { logoURL }),
    ...(logoDarkURL === undefined ? {} : { logoDarkURL }),
  }

  return {
    channelId,
    defaultServerURL,
    productName,
    windowTitle,
    homeDir,
    appId,
    deepLinkScheme,
    deepLinkName,
    brand,
  }
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
