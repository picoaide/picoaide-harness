/**
 * 渠道参数在**渲染进程**里的运行期来源（设计总纲 §16.1「渲染进程 scheme 注入」）。
 *
 * ## 为什么必须有这一层（CHN-2 / R2I-15 / UX-2）
 *
 * 应用 origin 的 scheme 是**渠道变量**（设计总纲 F15/§10）：官方是 `picoaide-app`，
 * 品牌渠道随 `channel.json` 的 `desktop.app_origin_scheme` 各不同。客户端 bundle 是
 * **一份代码多份渠道**构建，读不到渠道包，所以任何写死的 `picoaide-app:` 都会让品牌渠道
 * 全线失配：拿到的 URL 认不出来（打开失败）、分享出去的链接指向别的安装（打不开）。
 *
 * 真源 = 宿主的**本机只读路由** `GET /api/pico/wasm-apps/channel`
 * （§16.1 冻结：返回 `{appOriginScheme, deepLinkScheme, productName}`）。本模块只做四件事：
 *
 *  1. 取一次（挂载时 / 首次需要时；并发去重，避免每个消费者各发一次）；
 *  2. **严格解析**：scheme 形状、保留 scheme 名单、两个 scheme 不得相同（§8.3/§10）
 *     —— 任何一条不满足都按"没拿到"处理；
 *  3. 把深链 scheme 交给 {@link setAppShareScheme}（分享入口的唯一来源）；
 *  4. 把应用 origin scheme 暴露给 {@link appOriginProtocol}（打开链路的校验依据）。
 *
 * ## fail-closed（不是"回落官方值"）
 *
 * 拿不到渠道参数时**不得**假定官方 scheme：那会产出一条在品牌渠道里打不开的分享链接，
 * 也会把"本机返回的协议 URL 到底是不是本安装的"这件事变成猜测。§19 Q6 的冻结口径是
 * **未注入渠道 scheme 时分享入口不渲染**；打开链路同样停下并给可读原因
 * （`open-app.ts` 的 `scheme-unavailable`）。
 *
 * @module @picoaide/dsh-wasm-apps/client/channel-seam
 */

import { setAppShareScheme } from './deep-link.ts'
import { fetchWithHostProof, hostProofFailure, isHostProofErrorCode, readHostErrorCode } from './host-proof.ts'

/**
 * 宿主本机只读路由（§16.1 冻结路径；宿主侧前缀注册在
 * `packages/host/wasm-apps-host/src/index.ts` 的 `WASM_APPS_LOCAL_PREFIX` 之下）。
 */
export const APP_CHANNEL_PATH = '/api/pico/wasm-apps/channel'

/**
 * **官方渠道**的应用 origin scheme（`channel.json` 对 official/beta 的声明值）。
 *
 * 与 {@link ./deep-link.OFFICIAL_APP_SHARE_SCHEME} 一样，它只是**对拍参照**：
 * 运行期取值永远来自宿主的渠道路由，这里不参与任何回落。
 * `app-center.spec.tsx` 会把它与 `packages/host/desktop/src/desktop-channel.ts` 的
 * `DEFAULT_APP_ORIGIN_SCHEME` 逐字对拍（两处都声明官方值 ⇒ 必须一致）。
 */
export const OFFICIAL_APP_ORIGIN_SCHEME = 'picoaide-app'

/**
 * scheme 形状（与设计总纲 §8.3 冻结的正则**逐字一致**：`^[a-z][a-z0-9+.-]{1,31}$`）。
 *
 * 注意它不是"无上界"的 RFC 3986 形状：本仓两端共用这一条，改一处必须改两处
 * （服务端 `channel.AppOriginScheme()` 的校验）。
 */
export const CHANNEL_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]{1,31}$/u

/**
 * 不得作为应用 origin / 深链的保留 scheme（设计总纲 §10 明确列出的名单 + 同族的
 * 浏览器内部 scheme）。这些取值一旦被采纳，等于把应用页挂到 Web 或本地文档的
 * 命名空间上 —— 不是"配置写错了"，是安全边界。
 */
const RESERVED_SCHEMES: ReadonlySet<string> = new Set([
  'http', 'https', 'file', 'data', 'javascript', 'about', 'blob', 'filesystem',
  'ws', 'wss', 'ftp', 'chrome', 'chrome-extension', 'devtools', 'view-source',
])

/** 渠道参数（宿主只读路由的响应体；字段名与 §16.1 冻结契约逐字一致）。 */
export interface AppChannel {
  /** 应用 origin 的 scheme（不含 `:`；`<app_origin_scheme>://<app_id>`）。 */
  appOriginScheme: string
  /** 深链 scheme（不含 `:`；`<scheme>://app/<app_id>`）。 */
  deepLinkScheme: string
  /** 渠道产品名（窗口标题 `<应用名> · <产品名>` 用；缺失时为空串，不编造）。 */
  productName: string
}

/**
 * 解析宿主只读路由的响应体。
 *
 * 判据（全部满足才算拿到）：
 *  - 两个 scheme 都过 {@link CHANNEL_SCHEME_PATTERN}；
 *  - 都不在 {@link RESERVED_SCHEMES}；
 *  - **两者不相同**（§10：`app_origin_scheme` 不得等于 `deep_link_scheme`）；
 *  - `productName` 不是必需项（窗口标题由宿主用，客户端不依赖它）。
 *
 * @param payload - 路由响应体（不可信输入：它来自本机服务，但契约漂移与畸形值都要挡住）。
 * @returns 归一化后的渠道参数；任一条不满足 ⇒ `null`（调用方 fail-closed）。
 */
export function parseAppChannel(payload: unknown): AppChannel | null {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null
  const row = payload as Record<string, unknown>
  const appOriginScheme = normalizeScheme(row.appOriginScheme)
  const deepLinkScheme = normalizeScheme(row.deepLinkScheme)
  if (appOriginScheme === null || deepLinkScheme === null) return null
  if (RESERVED_SCHEMES.has(appOriginScheme) || RESERVED_SCHEMES.has(deepLinkScheme)) return null
  if (appOriginScheme === deepLinkScheme) return null
  return {
    appOriginScheme,
    deepLinkScheme,
    productName: typeof row.productName === 'string' ? row.productName.trim() : '',
  }
}

/**
 * 归一化一个 scheme 候选值（小写 + trim；形状/保留名单不过 ⇒ `null`）。
 * @param raw - 路由下发的原始值。
 * @returns 合法 scheme（不含 `:`），或 `null`。
 */
function normalizeScheme(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim().toLowerCase()
  return CHANNEL_SCHEME_PATTERN.test(value) ? value : null
}

/** 当前安装的渠道参数；`null` = 还没拿到（fail-closed 的判据）。 */
let injected: AppChannel | null = null

/** 进行中的取数（并发去重：挂载 + 首次打开不会各发一次）。 */
let inFlight: Promise<AppChannelResult> | null = null

/**
 * 注入渠道参数（解析成功后调用；测试用它造状态/复位）。
 *
 * 同时把深链 scheme 交给分享模块 —— 分享链接的 scheme **只**允许来自这里，
 * 客户端不再有"缺省官方值"这条回落（§19 Q6 的 fail-closed）。
 * @param channel - 渠道参数；`null` = 清空注入（未拿到）。
 */
export function setAppChannel(channel: AppChannel | null): void {
  injected = channel
  setAppShareScheme(channel === null ? null : channel.deepLinkScheme)
}

/**
 * 当前已注入的渠道参数。
 * @returns 渠道参数，或 `null`（未拿到）。
 */
export function appChannel(): AppChannel | null {
  return injected
}

/**
 * 当前安装的应用 origin scheme（打开链路校验协议 URL 的依据）。
 * @returns scheme（不含 `:`），或 `null`（未拿到 ⇒ 调用方 fail-closed）。
 */
export function appOriginScheme(): string | null {
  return injected === null ? null : injected.appOriginScheme
}

/**
 * 当前安装的应用协议前缀（`<scheme>:`）。
 * @returns 协议前缀，或 `null`（未拿到）。
 */
export function appOriginProtocol(): string | null {
  return injected === null ? null : `${injected.appOriginScheme}:`
}

/** {@link refreshAppChannel} 的可注入依赖（测试用；缺省走全局 `fetch`）。 */
export interface AppChannelDeps {
  /** 取数实现（缺省 `globalThis.fetch`）。 */
  fetch?: typeof fetch
}

/**
 * 拿不到渠道参数的**原因分档**（R2-X-1 第 6 条：别把"证明问题"说成"配置问题"）。
 *
 *  - `host-proof-unavailable`：本机持有性令牌没拿到（引导 403/503/网络）⇒ 排障方向是
 *    "页面/会话"，不是渠道配置；
 *  - `host-proof-rejected`：令牌带了但被拒（401 `proof_required|proof_expired`，重取一次后
 *    仍然如此）⇒ 排障方向同上，但更可能是宿主侧的证明服务异常；
 *  - `scheme-not-configured`：端点 200 但没有可用的 `appOriginScheme`（或返回 503）⇒
 *    排障方向是**渠道配置**（`desktop.app_origin_scheme`）；
 *  - `malformed`：响应不是契约形状；
 *  - `transport`：请求没到达宿主。
 */
export type AppChannelFailureReason =
  | 'host-proof-unavailable'
  | 'host-proof-rejected'
  | 'scheme-not-configured'
  | 'malformed'
  | 'transport'

/** 拿不到渠道参数时的可辨原因。 */
export interface AppChannelFailure {
  reason: AppChannelFailureReason
  status: number | null
  message: string
}

/** {@link loadAppChannel} 的结果：渠道参数或**为什么没有**。 */
export interface AppChannelResult {
  channel: AppChannel | null
  failure: AppChannelFailure | null
}

/**
 * 从宿主只读路由取一次渠道参数，并**带上本机持有性证明**（R2-X-1）。
 *
 * 失败（非 2xx / 非 JSON / 形状非法 / 网络异常）**不清空已有注入**：渠道参数在一次
 * 安装里是常量，一次瞬时失败不该让已经在用的会话失去 scheme（而"从未拿到"仍是
 * fail-closed，因为 `injected` 一直是 `null`）。并发调用共享同一次请求。
 *
 * 失败时**分档**返回原因（见 {@link AppChannelFailureReason}）：401（证明问题）与
 * "200 但没有 scheme"（配置问题）必须能被区分，否则排障会被指错方向。
 * @param deps - 可注入的 fetch（测试与真实调用共用同一条实现）。
 * @returns 渠道参数或失败原因（两者必有其一）。
 */
export function loadAppChannel(deps: AppChannelDeps = {}): Promise<AppChannelResult> {
  if (inFlight !== null) return inFlight
  const task = (async (): Promise<AppChannelResult> => {
    // 证明走请求头（`X-Pico-Host-Proof`，宿主 seam 冻结）：拿不到令牌就**不发**业务
    // 请求（发出去必然 401，还会把"证明没拿到"掩盖成"渠道接口拒绝"）。
    let response: Response | null
    try {
      response = await fetchWithHostProof(APP_CHANNEL_PATH, {
        method: 'GET',
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      }, deps.fetch === undefined ? {} : { fetch: deps.fetch })
    } catch (cause) {
      return { channel: null, failure: { reason: 'transport', status: null, message: `the channel route is unreachable: ${cause instanceof Error ? cause.message : String(cause)}` } }
    }
    if (response === null) {
      const proof = hostProofFailure()
      return {
        channel: null,
        failure: {
          reason: 'host-proof-unavailable',
          status: proof?.status ?? null,
          message: `no host proof could be obtained, so the channel route was not called: ${proof?.message ?? 'unknown'}`,
        },
      }
    }
    if (!response.ok) {
      const code = readHostErrorCode(await readJsonQuietly(response))
      // 503 = 宿主侧"渠道 scheme 未配置"（§16.1 的 fail-closed）；401 + proof_* = 证明问题。
      const reason: AppChannelFailureReason = response.status === 503
        ? 'scheme-not-configured'
        : isHostProofErrorCode(code) ? 'host-proof-rejected' : 'malformed'
      return {
        channel: null,
        failure: {
          reason,
          status: response.status,
          message: `the channel route refused (HTTP ${String(response.status)}${code === null ? '' : `, ${code}`})`,
        },
      }
    }
    let payload: unknown
    try {
      payload = await response.json()
    } catch (cause) {
      return { channel: null, failure: { reason: 'malformed', status: response.status, message: `the channel route returned a non-JSON body: ${cause instanceof Error ? cause.message : String(cause)}` } }
    }
    const parsed = parseAppChannel(payload)
    if (parsed === null) {
      // **配置问题**（不是证明问题）：端点答应了，但没有可用的 scheme。
      return {
        channel: null,
        failure: {
          reason: 'scheme-not-configured',
          status: response.status,
          message: `the channel route answered without a usable appOriginScheme: ${JSON.stringify(payload).slice(0, 200)}`,
        },
      }
    }
    setAppChannel(parsed)
    return { channel: parsed, failure: null }
  })()
  inFlight = task
  void task.finally(() => { if (inFlight === task) inFlight = null })
  return task
}

/**
 * 取一次渠道参数并注入（{@link loadAppChannel} 的"只要结果"包装）。
 * @param deps - 可注入的 fetch。
 * @returns 渠道参数；失败 ⇒ `null`。
 */
export async function refreshAppChannel(deps: AppChannelDeps = {}): Promise<AppChannel | null> {
  return (await loadAppChannel(deps)).channel
}

/**
 * 读响应体为 JSON（失败 ⇒ `null`，用 clone 不消费原响应）。
 * @param response - 原始响应。
 * @returns 解析结果，或 `null`。
 */
async function readJsonQuietly(response: Response): Promise<unknown> {
  try {
    const text = await response.clone().text()
    return text === '' ? null : JSON.parse(text)
  } catch {
    return null
  }
}
