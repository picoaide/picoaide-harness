/**
 * 在**客户端内**打开一个 WASM 应用（冻结契约
 * `docs/decisions/2026-09-19-wasm-client-internal-origin.md` §1/§4.5）。
 *
 * 应用只有一种打开方式：桌面客户端注册的自定义协议
 * `<app-origin-scheme>://<app_id>/`。因此本模块**没有** http(s) 入口链接、**没有**系统
 * 浏览器兜底（契约 §5 的删除清单）—— 那两条路是结构性错误，不是"暂时禁用"：
 * 服务端已不再下发 `entry_url`，应用也没有可贴进浏览器的地址。
 *
 * ## scheme 是**运行期**的渠道变量（CHN-2 / R2I-15 / UX-2）
 *
 * scheme 由渠道包 `desktop.app_origin_scheme` 决定（官方与每个品牌渠道各不相同），
 * 客户端 bundle 读不到渠道包 ⇒ 它来自宿主的本机只读路由
 * `GET /api/pico/wasm-apps/channel`（`channel-seam.ts`）。本模块**不再有**写死的
 * `APP_PROTOCOL` 常量：拿不到 scheme 就当"还开不了"，给一个可辨的 reason
 * （{@link OpenFailureReason} 的 `scheme-unavailable`）并**一次请求都不发**。
 *
 * 客户端这一侧只做一件事：调**本机路由**（冻结接口，C3 实现）
 *
 * ```
 * POST /api/pico/wasm-apps/open     body: {"app_id":"<app_id>"}
 *   → 200 {"url":"<app-origin-scheme>://<app_id>/", "opens":{"today":{"pv":N,"uv":M}}?}
 * ```
 *
 * 由宿主确保协议 handler 与分区就绪并让内置浏览器加载该应用；URL **由本机按
 * app_id 拼**，不接受调用方传入。本模块不复制任何服务端/协议逻辑（准入、静态、
 * 执行都在别处），只做五件事：本地预检、发一次请求、把失败翻译成**机器可读的
 * reason**、断言成功返回的是不是那个协议 URL、把 F16 的打开计数读出来。
 *
 * ## 持有性证明（**请求头**机制，2026-09-20 P0 订正）
 *
 * 本机写面要求 **`X-Pico-Host-Proof` 请求头**（宿主 seam 的实现，见
 * `packages/host/wasm-apps-host/src/host-request.ts` 与 §22.2 R2）：渲染层先用
 * `GET /api/pico/wasm-apps/host-proof` 引导一枚短时令牌（内存持有），再在每个本机调用上
 * 带着它。**不是** cookie 机制 —— 旧注释写的"证明随同源 cookie 自动发出"是错的
 * （那是上一版 `write-proof.ts` 的形态，改成请求头正是 R2 的要求：零端口下没有
 * Cookie/Host/Origin/端口）。
 *
 * 由此三条推论写进了实现：
 *  - **拿不到令牌 ⇒ 不发请求**（发出去必然 401，还会把"证明没拿到"掩盖成"接口拒绝"）
 *    ⇒ reason `host-proof-unavailable`；
 *  - 调用回来 401 且错误码是 `proof_*` ⇒ **强制重取一枚令牌并重放一次**（只一次，
 *    绝不无限重试）；
 *  - 页面侧仍保留一条**形态预检**（{@link pageHoldsWriteProof}）：应用页/`file:`/`data:`
 *    文档根本不可能持有本机会话，这时一次请求都不发。
 *
 * ## 平台侧的 app-proof（§20/§23）与"客户端不重试"
 *
 * 平台端点 `request` / `open` 都要求 `X-Pico-App-Proof`
 * （{@link APP_PROOF_HEADER}，值由宿主持有并**只存内存**：客户端半边不持 bearer、
 * 也不签发 proof）。因此本模块：①发的是**本机**路由（宿主自己给平台请求带上 proof）；
 * ②**永不重试**：401 只翻译成 `not-signed-in`（会话过期/被吊销交给宿主与重登流程），
 * 不在这里静默重发、不自己续签 —— 重试与续签的落点是宿主层（§23.1）。
 *
 * ## 结果形态
 *
 * `{ok:true,url,counts?}` 或 `{ok:false,reason,error}`。`reason` 是稳定判据（UI 据此选文案、
 * 测试据此断言），`error` 是英文诊断细节（面向维护者；用户可见文案由面板从字典取）。
 * **成功时断言的是协议 URL 本身**（scheme 必须等于本安装的应用 origin scheme、host 必须
 * 等于请求的 app_id）—— 退回"fetch 没抛错就算打开"就是存在性断言，正是本仓点名的
 * 假绿形态。
 *
 * @module @picoaide/dsh-wasm-apps/client/open-app
 */

import { APP_ID_MAX_LENGTH, APP_ID_PATTERN } from './appcfg-contract.ts'
import { appOriginProtocol, refreshAppChannel } from './channel-seam.ts'
import {
  ensureHostProof,
  fetchWithHostProof,
  hostProofFailure,
  isHostProofErrorCode,
  readHostErrorCode,
} from './host-proof.ts'

/**
 * 本机打开路由（**冻结接口**：契约 §5.2 的表格；与 C3 的 `/api/pico/wasm-apps`
 * 前缀路由逐字一致，两端不得各写一份路径）。
 *
 * 它是**路径**而不是渠道变量（§22.2 R1 的 `hostRequestSurface` seam：今天映射到
 * loopback 的 `ctx.webServer.register`，将来映射到零端口的宿主请求通道，路径不变），
 * 所以这里保留字面量常量 —— 与宿主常量的跨包对拍在
 * `packages/host/desktop/tests/wasm-app-open-route-parity.spec.ts`。
 * 会随渠道变的是 **scheme**（见模块注释），不是这条路径。
 */
export const OPEN_APP_PATH = '/api/pico/wasm-apps/open'

/**
 * 平台 app-proof 头名（§20.1/§23.1 冻结）。
 *
 * 这个头**不由客户端设置**：值是宿主内存里的短时证明，客户端半边既不持 bearer 也不
 * 签发 proof（§5.1b：谁调用 = 宿主的本机打开路由）。这里导出它，是为了让"客户端这一侧
 * 没有第二份拼装点"可被断言（用例同时断言本模块源码里不出现它）。
 */
export const APP_PROOF_HEADER = 'X-Pico-App-Proof'

/** 失败原因（机器可读；UI 与用例都按它分派，不要匹配 message 文本）。 */
export type OpenFailureReason =
  /** 本地预检就否掉了 app_id（形态不对）⇒ 一次请求都没发。 */
  | 'invalid-app-id'
  /** 本页面不可能持有写面证明（应用页/本地文档）⇒ 一次请求都没发。 */
  | 'proof-unavailable'
  /** 本机持有性令牌没拿到（引导 403/503/网络）⇒ **一次业务请求都没发**。 */
  | 'host-proof-unavailable'
  /**
   * 还没拿到本安装的应用 origin scheme（宿主只读路由未就绪 / 响应非法）
   * ⇒ 一次请求都没发（CHN-2：scheme 是渠道变量，猜不得）。
   */
  | 'scheme-unavailable'
  /** 客户端未登录（本机路由 401 AUTH_REQUIRED）。 */
  | 'not-signed-in'
  /** 本机路由 401 `proof_required`（重取令牌重放一次后仍然如此）。 */
  | 'proof-required'
  /** 本机路由 401 `proof_expired`（重取令牌重放一次后仍然如此）。 */
  | 'proof-expired'
  /** 本机路由 404：应用不存在（或已被软删）。 */
  | 'app-not-found'
  /** 本机路由 503：协议 handler / 分区还没就绪（不降级到浏览器）。 */
  | 'protocol-not-ready'
  /** 请求没到达宿主（网络层失败 / 宿主未启动）。 */
  | 'host-unreachable'
  /** 响应形状不是冻结接口承诺的那一个（含非 2xx 的其它状态码）。 */
  | 'unexpected-response'

/**
 * F16 的打开计数（服务端 `open` 端点在同一次调用里记账并回传）。
 *
 * 形状冻结在客户端这一侧：`{"opens":{"today":{"pv":N,"uv":M}}}`。**没有**它就是"服务端
 * 这一版还没给计数" ⇒ 界面不显示这一行（绝不拿别处的数字凑）。
 */
export interface AppOpenCounts {
  /** 今日打开次数（PV 式，每次打开 +1）。 */
  todayPv: number
  /** 今日打开人数（按 user 去重）。 */
  todayUv: number
}

/** 本机对"这次打开究竟做了什么"的回答（§5.2 冻结字段 `window`）。 */
export type OpenWindowOutcome = 'opened' | 'focused'

/** 打开成功：`url` 是本机确认的协议 URL。 */
export interface OpenSuccess {
  ok: true
  /** `<app-origin-scheme>://<app_id>/`（由本机返回，客户端只读不改）。 */
  url: string
  /** 本次调用记账后的今日打开计数；服务端未下发 ⇒ `undefined`（不编造）。 */
  counts?: AppOpenCounts
  /**
   * 本机开了新窗口（`opened`）还是聚焦了已有窗口（`focused`）。
   * 服务端未下发该字段 ⇒ `undefined`（界面就不说"已打开/已聚焦"）。
   */
  window?: OpenWindowOutcome
}

/** 打开失败：`reason` 决定 UI 文案，`error` 是诊断细节。 */
export interface OpenFailure {
  ok: false
  reason: OpenFailureReason
  error: string
  /** HTTP 状态；`null` = 请求根本没到达宿主。 */
  status: number | null
}

/** {@link openAppEntry} 的结果。 */
export type OpenResult = OpenSuccess | OpenFailure

/** 可注入副作用（测试与 UI 共用同一条实现）。 */
export interface OpenAppDeps {
  fetch: typeof fetch
  /**
   * 页面侧可判定的"本页面不可能持有写面证明"判据（缺省
   * {@link pageHoldsWriteProof}）。返回 false 时**不发请求**。
   */
  holdsWriteProof: () => boolean
  /**
   * 本安装的应用协议前缀（缺省 {@link appOriginProtocol}，即渠道 seam 的注入值）。
   * 返回 `null` ⇒ `scheme-unavailable`（不发请求）。
   */
  protocol?: () => string | null
  /**
   * scheme 还没拿到时的**一次**补齐机会（缺省取一次宿主渠道路由）。缺席或仍拿不到
   * ⇒ `scheme-unavailable`。
   */
  ensureChannel?: () => Promise<unknown>
}

/** 默认依赖：真实 `fetch` + 页面 scheme 判据 + 渠道 seam。 */
function defaultDeps(): OpenAppDeps {
  return {
    fetch: (...args) => fetch(...args),
    holdsWriteProof: () => pageHoldsWriteProof(),
    protocol: () => appOriginProtocol(),
    ensureChannel: () => refreshAppChannel(),
  }
}

/**
 * 这个页面是否**可能**持有本机写面的持有性证明。
 *
 * 判据只有一条：文档是不是由本机宿主服务的 http(s) 页面。HttpOnly cookie 本身读不到，
 * 所以这里刻意**不**假装能验证证明 —— 它只拦下**明确不可能**持有证明的文档：
 *
 *  - 应用页自己（`<本安装的 app scheme>://…`）：协议页面没有 http(s) origin，也不该有能力驱动
 *    客户端的本机写面（契约 §3 的隔离实测）；
 *  - `file:` / `data:` / `blob:` 等本地文档：没有宿主服务，也就没有证明。
 *
 * 其余情况（正常的桌面客户端窗口 / `dsh web` 页面）交给服务端的证明闸判定，403 与
 * 503 分别是 `proof-required` 与 `protocol-not-ready`。
 * @param page - 只用到 `protocol` 的文档位置（缺省取 `window.location`）。
 * @returns true = 可以发请求（证明是否存在由服务端裁决）。
 */
export function pageHoldsWriteProof(
  page: { protocol?: unknown } | undefined = typeof window === 'undefined' ? undefined : window.location,
): boolean {
  const protocol = typeof page?.protocol === 'string' ? page.protocol : ''
  return protocol === 'http:' || protocol === 'https:'
}

/**
 * 校验 App 协议 URL 是否是"这个 app 的入口"。
 *
 * 冻结接口承诺 `<本安装的 app origin scheme>://<app_id>/`：scheme 必须**等于本安装的
 * 渠道 scheme**（`protocol`；不是任何写死的常量），host 必须**等于**请求的 app_id
 * （返回别的应用 = 本机拼错了，客户端不得替它圆场）。
 * @param raw - 本机路由返回的 `url`。
 * @param appId - 本次请求的 app_id。
 * @param protocol - 本安装的应用协议前缀；`null`/缺省时取渠道 seam 的注入值。
 * @returns 规范化后的 URL，或 null（形状不对）。
 */
export function parseAppProtocolURL(
  raw: unknown,
  appId: string,
  protocol: string | null = appOriginProtocol(),
): string | null {
  if (protocol === null || protocol === '') return null
  if (typeof raw !== 'string' || raw.trim() === '') return null
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }
  if (url.protocol !== protocol) return null
  if (url.hostname === '' || url.hostname !== appId) return null
  return url.toString()
}

/**
 * 从成功响应里读 F16 的打开计数。
 *
 * 单一权威形状（见 {@link AppOpenCounts}）：`{"opens":{"today":{"pv":N,"uv":M}}}`。
 * 任何一个数字缺失/非法/为负 ⇒ 整块读作"没有"（`undefined`）—— 半块计数（只有 pv 没有
 * uv）渲染出来只会让人以为数据是真的。
 * @param payload - `open` 路由的响应体。
 * @returns 计数，或 `null`（服务端未下发 / 形状不符）。
 */
export function parseAppOpenCounts(payload: unknown): AppOpenCounts | null {
  if (payload === null || typeof payload !== 'object') return null
  const opens = (payload as { opens?: unknown }).opens
  if (opens === null || typeof opens !== 'object') return null
  const today = (opens as { today?: unknown }).today
  if (today === null || typeof today !== 'object') return null
  const pv = (today as { pv?: unknown }).pv
  const uv = (today as { uv?: unknown }).uv
  if (!isCount(pv) || !isCount(uv)) return null
  return { todayPv: pv, todayUv: uv }
}

/**
 * 从成功响应里读 §5.2 的 `window` 字段。
 * @param payload - `open` 路由的响应体。
 * @returns `'opened' | 'focused'`；缺席 / 取值不认识 ⇒ `null`（不猜）。
 */
export function parseOpenWindow(payload: unknown): OpenWindowOutcome | null {
  const value = (payload as { window?: unknown } | null)?.window
  return value === 'opened' || value === 'focused' ? value : null
}

/**
 * 计数是不是一个合法的非负整数。
 * @param value - 响应里的原始值。
 * @returns true = 可用作计数。
 */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/**
 * 本机路由失败状态 → reason（冻结接口只定义了 401/400/503，其余按语义就近归属）。
 *
 * 401 的两义性在调用点已经分流：`proof_*` ⇒ `proof-required|proof-expired`；
 * 其余 401（宿主的 `AUTH_REQUIRED`）⇒ `not-signed-in`。所以这里保持最保守的映射。
 */
function reasonForStatus(status: number): OpenFailureReason {
  switch (status) {
    case 401: return 'not-signed-in'
    case 400: return 'invalid-app-id'
    case 403: return 'proof-required'
    case 404: return 'app-not-found'
    case 503: return 'protocol-not-ready'
    default: return 'unexpected-response'
  }
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

/**
 * 在客户端内打开一个应用（唯一的打开路径）。
 *
 * 失败**永不抛**：每一种失败都是一个带 `reason` 的结果（UI 据此给出可读原因）。
 * @param rawAppId - 应用标识（服务端目录行里的 `app_id`；不是可信输入，先本地预检）。
 * @param deps - 可注入的 fetch / 证明判据（测试与 UI 共用同一条实现）。
 * @returns 成功（含协议 URL）或结构化失败。
 */
export async function openAppEntry(rawAppId: unknown, deps: OpenAppDeps = defaultDeps()): Promise<OpenResult> {
  const appId = typeof rawAppId === 'string' ? rawAppId.trim() : ''
  // 本地预检只做**加法**（与发布表单同一口径）：形态不对的 app_id 必然是服务端
  // 也会拒的（400 VALIDATION），提前拦下可以省一次往返、也不让请求带着垃圾出去。
  if (appId === '' || appId.length > APP_ID_MAX_LENGTH || !APP_ID_PATTERN.test(appId)) {
    return {
      ok: false,
      reason: 'invalid-app-id',
      error: `refusing to open ${JSON.stringify(rawAppId)}: not a valid app id (expected ${APP_ID_PATTERN.source})`,
      status: null,
    }
  }
  // 证明预检：明确不可能持有证明的文档不发请求（见 pageHoldsWriteProof）。
  if (!deps.holdsWriteProof()) {
    return {
      ok: false,
      reason: 'proof-unavailable',
      error: 'the app center must run in the client window: this document cannot hold the browser-session proof the local open route requires, so no request was sent',
      status: null,
    }
  }
  // scheme 预检（CHN-2）：应用协议 scheme 是渠道变量，必须先从宿主只读路由拿到。
  // 拿不到就**不发请求**——猜一个 scheme 既会让校验失效，也会让一次真实打开变成 404。
  // 先给一次补齐机会（挂载期取数失败/尚未完成时），仍拿不到才停。
  const readProtocol = deps.protocol ?? (() => appOriginProtocol())
  let protocol = readProtocol()
  if (protocol === null && deps.ensureChannel !== undefined) {
    try {
      await deps.ensureChannel()
    } catch { /* 补齐失败按"没拿到"处理，不把异常抛给调用方 */ }
    protocol = readProtocol()
  }
  if (protocol === null || protocol === '') {
    return {
      ok: false,
      reason: 'scheme-unavailable',
      error: 'the app origin scheme for this installation is unknown: the host channel route (/api/pico/wasm-apps/channel) has not answered with a usable appOriginScheme, so no request was sent',
      status: null,
    }
  }

  // 本机持有性证明（§22.2 R2）：引导一次拿令牌 ⇒ 带上头 ⇒ 401 `proof_*` 时重取一次。
  // 先确保有令牌：拿不到就**不发业务请求**（见模块注释的三条推论）。
  if (await ensureHostProof(deps.fetch === undefined ? {} : { fetch: deps.fetch }) === null) {
    const failure = hostProofFailure()
    return {
      ok: false,
      reason: 'host-proof-unavailable',
      error: `no host proof could be obtained, so the open route was not called: ${failure?.message ?? 'unknown'}`,
      status: failure?.status ?? null,
    }
  }

  let response: Response | null
  try {
    response = await fetchWithHostProof(OPEN_APP_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId }),
      credentials: 'same-origin',
    }, deps.fetch === undefined ? {} : { fetch: deps.fetch })
  } catch (cause) {
    return {
      ok: false,
      reason: 'host-unreachable',
      error: `the local open route is unreachable: ${cause instanceof Error ? cause.message : String(cause)}`,
      status: null,
    }
  }
  if (response === null) {
    // 重取令牌也没成功（重放前的那一次引导失败）。
    const failure = hostProofFailure()
    return {
      ok: false,
      reason: 'host-proof-unavailable',
      error: `the host proof could not be refreshed after a rejection: ${failure?.message ?? 'unknown'}`,
      status: failure?.status ?? null,
    }
  }

  if (!response.ok) {
    const code = readHostErrorCode(await readJsonQuietly(response))
    const reason = response.status === 401 && isHostProofErrorCode(code)
      ? (code === 'proof_expired' ? 'proof-expired' : 'proof-required')
      : reasonForStatus(response.status)
    return {
      ok: false,
      reason,
      error: `the local open route refused ${JSON.stringify(appId)} (HTTP ${String(response.status)}${code === null ? '' : `, ${code}`}): ${reason}`,
      status: response.status,
    }
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch (cause) {
    return {
      ok: false,
      reason: 'unexpected-response',
      error: `the local open route returned a non-JSON body: ${cause instanceof Error ? cause.message : String(cause)}`,
      status: response.status,
    }
  }
  const rawURL = (payload as { url?: unknown } | null)?.url
  const url = parseAppProtocolURL(rawURL, appId, protocol)
  if (url === null) {
    return {
      ok: false,
      reason: 'unexpected-response',
      error: `the local open route must answer {"url":"${protocol}//${appId}/"}; got ${JSON.stringify(rawURL)}`,
      status: response.status,
    }
  }
  // F16 的打开计数：服务端在这同一次调用里记账并回传（形状见 parseAppOpenCounts）；
  // 没下发就不带 —— 界面据此决定要不要渲染"今日已被打开 N 次"。
  const counts = parseAppOpenCounts(payload)
  const window = parseOpenWindow(payload)
  // 成功 = 本机确认协议 URL 已就绪，且内置浏览器正在加载它（契约 §5.2 的打开路径）。
  return {
    ok: true,
    url,
    ...(counts === null ? {} : { counts }),
    ...(window === null ? {} : { window }),
  }
}
