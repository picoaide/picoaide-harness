/**
 * 深链解析：`<渠道 scheme>://app/<app_id>`（契约 §4.5 的唯一可分享形态）。
 *
 * 两条纪律：
 *  1. **scheme 由桌面壳注入**（`channelProfilePatches` → 本行 config 的
 *     `deepLinkScheme`），本模块从不硬编码 `picoaide://`，也从不自己读随包
 *     `channel.json`（tsdown 内联后那个路径会指向不存在的目录）。
 *  2. **严格校验**：未知 scheme / 非 `app` host / 多余的路径段 / 非法 app_id
 *     一律返回 null —— 调用方**丢弃**（记一条日志），绝不回落到"登录页"或
 *     "首页"之类的默认动作。桌面壳的 `parseDesktopDeepLink` 是第一道严格闸门
 *     （`analyzeDesktopDeepLinkActions`），本函数是第二道。
 *
 * @module @picoaide/dsh-wasm-apps-host/deep-link
 */

import { isValidAppId } from './app-protocol.ts'
import { sanitizeAppPath } from './deep-link-queue.ts'

/** 深链 host（唯一合法值）：`<scheme>://app/<app_id>`。 */
export const APP_DEEP_LINK_HOST = 'app'

/** 一条深链的长度上限（深链是一次回调，不是载荷）。 */
export const APP_DEEP_LINK_MAX_LENGTH = 4_096

/** 解析结果。 */
export interface AppDeepLink {
  /** 目标应用。 */
  readonly appId: string
  /**
   * 应用内相对路径（`?path=`，已净化；缺省 `/`）。
   *
   * §5.3/UX-5 冻结：`?path=` 是深链的一部分（"打开这个应用的这一页"），必须在
   * 打开时带上；净化失败（协议相对、穿越、控制字符）⇒ 丢弃该参数而不是拒整条链接。
   */
  readonly path: string
  /**
   * 规范化后的内部 URL（内置浏览器/应用窗口加载的地址）。
   *
   * **scheme 是参数**（§7.8/CHN-3）：这里曾经写死 `picoaide-app://`，渠道客户端
   * 会打开一个自己都不认识的 origin。
   */
  readonly url: string
}

/**
 * 从**任意** scheme 的应用深链里取出 scheme 与 app_id（形状与 {@link parseAppDeepLink}
 * 完全一致，但不校验 scheme 是不是本安装的）。
 *
 * 用途只有一个：**判断"这条链接是不是别人家的客户端"**（§19 Q5 / 接缝 J13）——
 * 形状对、app_id 合法，但 scheme 不是我们注入的那个 ⇒ 那是另一家企业/渠道的链接，
 * 正确处置是给用户一句可读提示（事件 `pico/wasm-app-deep-link-foreign`），
 * 而不是静默丢弃（用户会以为链接坏了）。
 * @param raw - 候选串。
 * @returns `{scheme, appId}`；形状不符（不是 app 深链）时 null。
 */
export function parseForeignAppDeepLink(raw: unknown): { scheme: string, appId: string } | null {
  if (typeof raw !== 'string' || raw === '' || raw.length > APP_DEEP_LINK_MAX_LENGTH) return null
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }
  const scheme = parsed.protocol.replace(/:$/u, '').toLowerCase()
  if (scheme === '') return null
  const host = parsed.hostname !== '' ? parsed.hostname : (parsed.pathname.replace(/^\/+/u, '').split('/')[0] ?? '')
  if (host.toLowerCase() !== APP_DEEP_LINK_HOST) return null
  const segments = parsed.pathname.split('/').filter(segment => segment !== '')
  const rawAppId = parsed.hostname !== ''
    ? (segments[0] ?? '')
    : (segments[1] ?? '')
  if (parsed.hostname === '' && segments.length !== 2) return null
  if (parsed.hostname !== '' && segments.length !== 1) return null
  let appId: string
  try {
    appId = decodeURIComponent(rawAppId)
  } catch {
    return null
  }
  if (!isValidAppId(appId)) return null
  return { scheme, appId }
}

/**
 * 解析一条应用深链。
 *
 * 接受 `//app/<id>` 与 `:/app/<id>` / `:///app/<id>` 三种书写（与桌面壳的
 * `parseDesktopDeepLink` 一致：`hostname` 为空时退回第一个路径段），但**只**
 * 接受恰好一段 path：`<scheme>://app/<id>/extra` 是畸形，不是"更深的应用路径"
 * （应用内部路由走 `picoaide-app://` 协议，不走深链）。
 * @param raw - 候选串（来自 `pico/deep-link` 事件）。
 * @param scheme - 本安装的深链 scheme（渠道包决定）。
 * @param appOriginScheme - 本安装的应用源 scheme（渠道包决定；用于构造内部 URL）。
 * @returns 解析结果，或 null（调用方丢弃）。
 */
export function parseAppDeepLink(raw: unknown, scheme: string, appOriginScheme: string): AppDeepLink | null {
  if (typeof raw !== 'string' || raw === '' || raw.length > APP_DEEP_LINK_MAX_LENGTH) return null
  if (typeof scheme !== 'string' || scheme === '') return null
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }
  if (parsed.protocol.toLowerCase() !== `${scheme.toLowerCase()}:`) return null
  const host = parsed.hostname !== '' ? parsed.hostname : (parsed.pathname.replace(/^\/+/u, '').split('/')[0] ?? '')
  if (host.toLowerCase() !== APP_DEEP_LINK_HOST) return null
  const segments = parsed.pathname.split('/').filter(segment => segment !== '')
  const rawAppId = parsed.hostname !== ''
    ? (segments[0] ?? '')
    : (segments[1] ?? '')
  if (parsed.hostname === '' && segments.length !== 2) return null
  if (parsed.hostname !== '' && segments.length !== 1) return null
  let appId: string
  try {
    appId = decodeURIComponent(rawAppId)
  } catch {
    return null
  }
  if (!isValidAppId(appId)) return null
  if (typeof appOriginScheme !== 'string' || appOriginScheme === '') return null
  const path = sanitizeAppPath(parsed.searchParams.get('path'))
  return { appId, path, url: `${appOriginScheme}://${appId}${path}` }
}
