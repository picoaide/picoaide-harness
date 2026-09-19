/**
 * 应用的可分享形态 = **渠道深链** `<channel scheme>://app/<app_id>`
 * （冻结契约 `2026-09-19-wasm-client-internal-origin.md` §4.5）。
 *
 * 应用没有 web 地址（它只在客户端内以 `picoaide-app://<app_id>/` 打开），能发给同事
 * 的就是这条深链：对方客户端（同渠道）收到后走自己的链接解析 → 确认协议与分区就绪
 * → 内置浏览器加载该应用。未知 app_id 由客户端给可读错误，**不回落登录页**。
 *
 * ## scheme 从哪来（**不得写死**）
 *
 * scheme 的真源是随渠道构建的 `channel.json` 的 `desktop.deep_link_scheme`
 * （官方 = `picoaide`，品牌渠道各自不同，例如渠道自己的产品前缀）。客户端 bundle 读不到
 * 渠道包，所以这里把它做成**注入点**：{@link setAppShareScheme} 由
 * `channel-seam.ts` 在取到宿主只读路由 `GET /api/pico/wasm-apps/channel` 的响应后调用
 * （应用中心挂载时 / 首次需要时）；本模块只负责拼串与形状校验。
 *
 * ## fail-closed：未注入 ⇒ **不产出链接**（§19 Q6 冻结）
 *
 * 旧实现把 {@link OFFICIAL_APP_SHARE_SCHEME} 当回落值：品牌渠道一旦漏注入，界面照样
 * 渲染一条 `picoaide://app/…` —— 一条在**本安装里根本打不开**的链接。产品口径已改为
 * "未注入渠道 scheme 时分享入口不渲染"：宁可少一行，也不给一条错的链接。
 * 因此 {@link appShareScheme} 返回 `null` 而不是官方值，{@link appShareLink} 随之为
 * `null`（调用方据此不渲染）。
 *
 * {@link OFFICIAL_APP_SHARE_SCHEME} 仍然保留为**官方渠道的声明值**（跨端对拍用：
 * 渠道包 official/beta 的 `deep_link_scheme` 就是它），但它不再是一条自动回落。
 *
 * @module @picoaide/dsh-wasm-apps/client/deep-link
 */

import { APP_ID_MAX_LENGTH, APP_ID_PATTERN } from './appcfg-contract.ts'

/** 深链的路径段（契约 §4.5：`<scheme>://app/<app_id>`，可选 `?path=/相对路径`）。 */
export const APP_DEEP_LINK_HOST = 'app'

/**
 * **官方渠道**的深链 scheme（`channel.json` 对 official/beta 的声明值）。
 *
 * 只作为跨端对拍的参照（渠道包 official/beta 必须声明它；`app-center.spec.tsx`
 * 与 `packages/host/desktop/src/desktop-channel.ts` 的 `DEFAULT_DEEP_LINK_SCHEME`
 * 逐字比），**不是**运行期回落：品牌渠道必须经 {@link setAppShareScheme} 注入自己的
 * scheme，注入缺席时 {@link appShareScheme} 返回 `null`（fail-closed，见模块注释）。
 */
export const OFFICIAL_APP_SHARE_SCHEME = 'picoaide'

/** RFC 3986 scheme 形状（与 `packages/host/desktop/src/desktop-channel.ts` 同一判据）。 */
const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*$/u

/** 注入的 scheme；`undefined` = 还没注入（此时**不产出任何链接**，没有回落值）。 */
let injectedScheme: string | undefined

/**
 * 注入本安装的深链 scheme（渠道真源 = `channel.json` 的 `desktop.deep_link_scheme`）。
 *
 * 形状非法（空串/含非法字符/带 `:`）**不采纳**并清空注入（fail-closed：宁可不渲染分享
 * 入口，也不给一条打不开的链接）——**不回落任何官方值**：品牌渠道漏注入时那条链接在
 * 本安装里打不开（§19 Q6）。要在测试里恢复"未注入"状态就传 `null`/`undefined`。
 * @param scheme - 渠道深链 scheme（不含 `://`）。
 */
export function setAppShareScheme(scheme: unknown): void {
  const value = typeof scheme === 'string' ? scheme.trim().toLowerCase() : ''
  injectedScheme = SCHEME_PATTERN.test(value) ? value : undefined
}

/**
 * 当前生效的深链 scheme（**只认注入值**；未注入 ⇒ `null`）。
 * @returns 可安全拼进深链的 scheme（不含 `://`），或 `null`（调用方不渲染分享入口）。
 */
export function appShareScheme(): string | null {
  return injectedScheme ?? null
}

/**
 * 一条应用的分享深链。
 *
 * app_id 是路径段，必须按不可信输入编码（服务端只为合法 app_id 下发目录行，但分享
 * 串是从目录行拼出来的，任何一环漂移都不该产出一条能指向别处路径的链接）。
 * @param appId - 应用标识。
 * @param scheme - 覆盖注入值（测试/多安装场景）；缺省 {@link appShareScheme}。
 * @returns 深链字符串；app_id 非法、或**没有生效的渠道 scheme** 时 `null`
 *   （不拼一条假链接 —— §19 Q6 的 fail-closed）。
 */
export function appShareLink(appId: unknown, scheme: string | null = appShareScheme()): string | null {
  const id = typeof appId === 'string' ? appId.trim() : ''
  if (id === '' || id.length > APP_ID_MAX_LENGTH || !APP_ID_PATTERN.test(id)) return null
  if (scheme === null || !SCHEME_PATTERN.test(scheme)) return null
  return `${scheme}://${APP_DEEP_LINK_HOST}/${encodeURIComponent(id)}`
}
