/**
 * 打开校验（F16 / §5.1b）——「每次打开都先问平台一次」的那一半（宿主侧）。
 *
 * 为什么必须在宿主：客户端半边**不持 bearer**（§5.1b「谁调用」冻结），所以 `open`
 * 只能由宿主的本机打开路由去调；面板只调本机路由。
 *
 * 冻结口径：
 *  - **每次「打开」动作调一次**（新建窗口或聚焦前）；应用窗口内的后续请求不再调；
 *  - 响应 `{version, release_id?, title?, changed, opens?}`：`changed=true` ⇔ 平台版本
 *    ≠ 客户端手里的 `current_version` ⇒ 调用方**清掉该应用在当前 session-scope 下的
 *    全部版本缓存**；
 *  - **闸门强度**：新建窗口 = 硬闸门（拿不到版本 ⇒ 不打开）；聚焦已有窗口 = 软闸门
 *    （保留内容 + 提示"无法确认最新版本"，不把正常应用打成错误页）；
 *  - `opens`（当日 PV/UV，**含本次**）是**best-effort 遥测**：缺省/`null` 一律**不渲染**，
 *    绝不当成 0，也绝不因此阻断打开（J7b）；
 *  - **计数失败不影响打开**（平台侧 best-effort，宿主侧同样不因它失败）。
 *
 * 滚动升级窗口：`open` 端点是本版新增的。服务端还没有它时（404/405/501）宿主记一条
 * warn 并**按"不支持"继续打开** —— 否则升级期会出现"客户端一升、应用全打不开"。
 *
 * @module @picoaide/dsh-wasm-apps-host/open-gate
 */

import { APP_PROOF_HEADER } from './app-proof.ts'

/** 平台应用端点前缀（与 `app-protocol.ts` 的 `APP_REQUEST_PATH` 同源）。 */
export const APP_OPEN_PATH = '/api/client/v2/apps/wasm'

/** 版本头（§5.1：缓存键的唯一来源；客户端只剔逐跳头，天然透传）。 */
export const APP_VERSION_HEADER = 'X-PicoAide-App-Version'

/** 当日打开计数（§5.1b：pv = 每次 +1 不去重含本次；uv = 当日按 user 去重）。 */
export interface AppOpenCounts {
  readonly today: { readonly pv: number, readonly uv: number }
}

/** 打开校验的结论。 */
export type AppOpenOutcome =
  | {
    kind: 'ok'
    version: string
    releaseId?: number
    title?: string
    changed: boolean
    /** 平台给的当日计数；缺省/畸形 ⇒ 不出现（**不渲染**，J7b）。 */
    opens?: AppOpenCounts
  }
  /** 服务端还没有这个端点（滚动升级窗口）：按"不阻塞"处理。 */
  | { kind: 'unsupported' }
  /** 平台明确拒绝（401 未登录/403 审计账号/404 不存在/410 下架/503 关停中）。 */
  | {
    kind: 'denied'
    status: number
    code: string
    /**
     * 平台的结构化原因（`details.reason`，缺省 ⇒ 不出现）。
     *
     * 消费点唯一且关键：`app_frozen` 与 `app_not_found` 共用 404 + `NOT_FOUND`，
     * 而两者的处置**相反**（冻结 = 只读快照，保留窗口与缓存并给可辨文案；
     * 不存在/软删 = 关窗 + 清缓存）。见 `index.ts` 的生命周期分支。
     */
    reason?: string
  }
  /** 网络/超时：拿不到版本。 */
  | { kind: 'unreachable', detail: string }

/** 打开校验的依赖（全部注入，便于单测）。 */
export interface AppOpenGateDeps {
  /** 当前员工会话（未登录 ⇒ 不调用）。 */
  session: () => { readonly token: string, readonly serverURL: string } | null
  /** 出站（桌面适配器给 Chromium 栈）。 */
  fetch: (url: string, init: RequestInit) => Promise<Response>
  /** 客户端持有性证明（§23.1；`open` 端点同样要求它，且**按 app_id 绑定**）。 */
  appProof?: { get(appId: string, force?: boolean): Promise<string | null>, invalidate(): void } | undefined
  /** 单次预算（毫秒）；缺省 30 s（与请求面同源）。 */
  timeoutMs?: number | undefined
  /** 诊断出口。 */
  warn?: ((message: string) => void) | undefined
}

/** 打开校验器。 */
export interface AppOpenGate {
  /**
   * 调平台的 `open` 端点。
   * @param appId - 已校验的 app_id。
   * @param currentVersion - 客户端当前缓存的版本（不知道时给空串 ⇒ 平台回 changed=true）。
   */
  check(appId: string, currentVersion: string): Promise<AppOpenOutcome>
}

/** 去掉尾斜杠（与 `handler.ts` 同口径）。 */
function normalizeServerURL(input: string): string {
  let value = input.trim()
  while (value.length > 0 && value.endsWith('/')) value = value.slice(0, -1)
  return value
}

/** 读一个正整数计数（畸形 ⇒ undefined：计数是 best-effort，绝不猜 0）。 */
function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

/**
 * 从响应体里取 `opens`（缺省/畸形 ⇒ undefined）。
 *
 * **不做默认值**：把缺省当 0 会把"平台没报"渲染成"今天 0 次打开"，那是错误信息。
 * @param value - `JSON.parse` 之后的值。
 * @returns 合法的计数，或 undefined。
 */
export function parseAppOpenCounts(value: unknown): AppOpenCounts | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const today = (value as Record<string, unknown>).today
  if (typeof today !== 'object' || today === null || Array.isArray(today)) return undefined
  const record = today as Record<string, unknown>
  const pv = nonNegativeInt(record.pv)
  const uv = nonNegativeInt(record.uv)
  if (pv === undefined || uv === undefined) return undefined
  return { today: { pv, uv } }
}

/**
 * 严格解析 `open` 响应体。
 * @param value - `JSON.parse` 之后的值。
 * @returns 解析结果，或 null（形状不符 ⇒ 调用方按 unavailable 处理）。
 */
export function parseAppOpenResponse(value: unknown): { version: string, releaseId?: number, title?: string, changed: boolean, opens?: AppOpenCounts } | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const version = record.version
  if (typeof version !== 'string' || version === '') return null
  const changed = record.changed
  if (typeof changed !== 'boolean') return null
  const releaseId = typeof record.release_id === 'number' && Number.isInteger(record.release_id) ? record.release_id : undefined
  const title = typeof record.title === 'string' && record.title !== '' ? record.title : undefined
  const opens = parseAppOpenCounts(record.opens)
  return {
    version,
    ...(releaseId === undefined ? {} : { releaseId }),
    ...(title === undefined ? {} : { title }),
    changed,
    ...(opens === undefined ? {} : { opens }),
  }
}

/**
 * 读平台错误信封里的错误码（`{"error":{"code":…}}` / `{"error":"code"}`）。
 *
 * 只有**对象形态的 `error.code`** 才算信封 —— 这一条同时用来分辨"端点缺失的 404"
 * （无信封）与"应用级拒绝的 404"（有信封），放宽会把两者混成一件事。
 * @param body - 已解析的响应体（解析失败传 `undefined`）。
 * @returns 错误码，或 `null`（不是平台错误信封）。
 */
export function platformErrorCode(body: unknown): string | null {
  if (body === null || typeof body !== 'object') return null
  const error = (body as { error?: unknown }).error
  if (typeof error === 'string' && error !== '') return error
  if (typeof error !== 'object' || error === null) return null
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && code !== '' ? code : null
}

/**
 * 读平台错误信封里的**结构化原因**（`{"error":{"details":{"reason":"app_frozen"}}}`）。
 *
 * 为什么必须有它：平台把「冻结」与「软删/未登记」放在**同一个 HTTP 404 + 同一个
 * `code=NOT_FOUND`** 里（§18.1 R2-L1-2 主控裁定：两档，不是三档），区分它们的唯一
 * 凭据就是 `details.reason`。只看 status 会把"只读快照（数据仍在）"当成"应用没了"
 * ⇒ 关窗 + 清缓存 + 客户端显示"不存在"，与 §19 Q3 的冻结文案直接冲突。
 *
 * 宽容读取：`details` 也可以是顶层 `reason`（旧/中间形态），两者都没有 ⇒ `null`
 * （调用方按"没有额外信息"处理，**不猜**）。
 * @param body - 已解析的响应体。
 * @returns `reason` 字符串，或 `null`。
 */
export function platformErrorReason(body: unknown): string | null {
  if (body === null || typeof body !== 'object') return null
  const error = (body as { error?: unknown }).error
  const containers: unknown[] = [error, body]
  if (typeof error === 'object' && error !== null) containers.unshift((error as { details?: unknown }).details)
  for (const container of containers) {
    if (typeof container !== 'object' || container === null) continue
    const reason = (container as { reason?: unknown }).reason
    if (typeof reason === 'string' && reason !== '') return reason
  }
  return null
}

/**
 * 构造一条 `denied` 结论（**唯一构造点**：状态 + 码 + 结构化原因必须同时来自同一次
 * 响应，否则会出现"冻结的 404 配不存在的语义"这类错配 —— 2026-09-20 真机实测过
 * "重试的 404 配第一次响应的 `proof_replayed`"）。
 * @param status - 外层 HTTP 状态。
 * @param body - 该次响应的已解析体。
 * @param code - 已判定的错误码（`platformErrorCode(body)` 的调用方结果）。
 * @returns `denied` 结论。
 */
function deniedFrom(status: number, body: unknown, code: string): Extract<AppOpenOutcome, { kind: 'denied' }> {
  const reason = platformErrorReason(body)
  return { kind: 'denied', status, code, ...(reason === null ? {} : { reason }) }
}

/**
 * 构造打开校验器。
 * @param deps - 会话/出站/证明/预算。
 * @returns 校验器。
 */
export function createAppOpenGate(deps: AppOpenGateDeps): AppOpenGate {
  const warn = deps.warn ?? ((): void => {})
  const timeoutMs = deps.timeoutMs ?? 30_000
  return {
    async check(appId, currentVersion) {
      const session = deps.session()
      if (session === null) return { kind: 'denied', status: 401, code: 'AUTH_REQUIRED' }
      const endpoint = `${normalizeServerURL(session.serverURL)}${APP_OPEN_PATH}/${encodeURIComponent(appId)}/open`
      const controller = new AbortController()
      const timer = setTimeout(() => { controller.abort() }, timeoutMs)
      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${session.token}`,
        }
        const proof = await deps.appProof?.get(appId, false)
        if (typeof proof === 'string' && proof !== '') headers[APP_PROOF_HEADER] = proof
        const response = await deps.fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify({ current_version: currentVersion }),
          signal: controller.signal,
        })
        // 端点还不存在（滚动升级窗口）：405/501 一律按"不支持"继续打开。
        if (response.status === 405 || response.status === 501) {
          warn(`pico-wasm-apps-host: the platform has no app open endpoint yet (HTTP ${String(response.status)}); opening without a version check`)
          return { kind: 'unsupported' }
        }
        let body: unknown
        try {
          body = await response.json()
        } catch {
          body = undefined
        }
        // 404 有两种语义，必须看响应体分开（R2-L2-2）：
        //  · **平台错误信封**（`{"error":{"code","message"}}`）= 端点存在、它明确说
        //    "没有这个应用"（服务端 `open.go` 的冻结/退役/未登记三档都是 404 + 信封）；
        //  · 非信封（HTML/空体/路由不存在）= 旧平台还没有这条端点 ⇒ 继续打开（滚动升级）。
        // 不分开的后果是**冻结/下架的应用在真实适配器下永远关不掉窗口**：404 被当成
        // "端点缺失"，路由拿到 `unsupported` 就照常打开。
        if (response.status === 404 && platformErrorCode(body) === null) {
          warn('pico-wasm-apps-host: the platform has no app open endpoint yet (HTTP 404 without an error envelope); opening without a version check')
          return { kind: 'unsupported' }
        }
        if (!response.ok) {
          const code = platformErrorCode(body) ?? `HTTP_${String(response.status)}`
          // 401：proof 失效时重签一次再试（与请求面同口径）。
          if (response.status === 401 && deps.appProof !== undefined) {
            deps.appProof.invalidate()
            const retryProof = await deps.appProof.get(appId, true)
            if (typeof retryProof === 'string' && retryProof !== '') {
              const retry = await deps.fetch(endpoint, {
                method: 'POST',
                headers: { ...headers, [APP_PROOF_HEADER]: retryProof },
                body: JSON.stringify({ current_version: currentVersion }),
                signal: controller.signal,
              })
              if (retry.ok) {
                const parsedRetry = parseAppOpenResponse(await retry.json().catch(() => undefined))
                if (parsedRetry !== null) return { kind: 'ok', ...parsedRetry }
              } else if (retry.status !== 401) {
                // **必须是重试响应的码**：第一张 proof 被平台消费掉之后，重试才拿到真正的
                // 结论。原实现把第一次响应的 `code`（`proof_replayed`）配着重试的 status
                // 一起返回 ⇒ 真机实测"冻结后的下一次打开"报成 `PLATFORM_PROOF_REPLAYED`，
                // 平台真正给的 `NOT_FOUND`（冻结/不存在）被丢掉，客户端拿不到可辨结论。
                const retryBody = await retry.json().catch(() => undefined)
                return deniedFrom(retry.status, retryBody, platformErrorCode(retryBody) ?? code)
              }
            }
          }
          return deniedFrom(response.status, body, code)
        }
        const parsed = parseAppOpenResponse(body)
        if (parsed === null) {
          warn(`pico-wasm-apps-host: the app open response for ${appId} was malformed`)
          return { kind: 'unreachable', detail: 'malformed open response' }
        }
        return { kind: 'ok', ...parsed }
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause)
        warn(`pico-wasm-apps-host: the app open check for ${appId} failed (${detail})`)
        return { kind: 'unreachable', detail }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
