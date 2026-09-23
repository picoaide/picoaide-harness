/**
 * 本机持有性证明（**请求头**机制）——客户端半边（§22.2 R2 / `wasm-apps-host` 的 seam）。
 *
 * ## 为什么必须有它（R2-X-1，P0）
 *
 * 宿主的本机路由面（`packages/host/wasm-apps-host/src/host-request.ts`）对 `open` 与
 * `channel` 都要求 **`X-Pico-Host-Proof` 请求头**：缺 ⇒ 401 `proof_required`、
 * 过期 ⇒ 401 `proof_expired`。这是零端口迁移纪律 R2 的实现 —— 授权**不得**依赖
 * Cookie / Host / Origin / 端口（零端口下这些都不存在），所以"页面在 loopback 上"
 * 本身不是凭据。
 *
 * 客户端这一半因此要做三件事：
 *
 *  1. **引导**：`GET /api/pico/wasm-apps/host-proof` 取一枚短时令牌（宿主 TTL 5 min）；
 *  2. **携带**：每个本机调用带 `X-Pico-Host-Proof: <token>`；
 *  3. **过期重取一次**：调用收到 401 且错误码是 `proof_*` ⇒ 强制重取一枚并**重试一次**
 *     （仍失败就把可辨原因上抛，**绝不无限重试** —— 与平台 401 的"一次点击一次请求"
 *     同一纪律）。
 *
 * ## 令牌的存放（安全边界）
 *
 * **只在内存**：不落盘、不进日志、不进错误上报。页面刷新即丢（重新引导一次）。
 * 它对应的信任边界是"能读到本机响应并持有浏览器会话的同一个渲染层"——落盘会让
 * 本机其它进程有机会读到它，而那正是 R2 要挡的。
 *
 * ## 与平台 app-proof 的分工
 *
 * `X-Pico-Host-Proof` = **本机面**的持有性证明（防本机其它进程/页面）；
 * `X-Pico-App-Proof`（§20/§23）= **平台面**的持有性证明（防拿到 bearer 的第三方，
 * 由宿主携带，客户端不拼不签）。两者不是同一个东西，别互相替代。
 *
 * @module @picoaide/dsh-wasm-apps/client/host-proof
 */

/** 引导端点（宿主 `GET ${prefix}/host-proof`；冻结路径）。 */
export const HOST_PROOF_PATH = '/api/pico/wasm-apps/host-proof'

/**
 * 本机持有性证明的请求头名（§22.2 R2 冻结）。
 *
 * 与宿主 `HOST_PROOF_HEADER`（`x-pico-host-proof`）**同一个头**（HTTP 头名大小写不敏感，
 * 这里按惯例写标准形态）。`app-center.spec.tsx` 会与宿主源码逐字对拍。
 */
export const HOST_PROOF_HEADER = 'X-Pico-Host-Proof'

/**
 * 提前量：本地认为快过期的令牌就重取，避免"发出去时刚好过期"。
 * 宿主 TTL 5 min，这里提前 30 s。
 */
export const HOST_PROOF_SKEW_MS = 30_000

/** 一枚已签发的令牌（内存态）。 */
export interface HostProofToken {
  /** 令牌本体（**不得**写进日志/存储/上报）。 */
  token: string
  /** 过期时刻（宿主响应的 `expires_at`，epoch ms）。 */
  expiresAt: number
}

/** 引导失败的原因（机器可读；UI 与用例按它分派）。 */
export type HostProofFailureReason =
  /** 端点拒绝签发（403：浏览器会话证明缺失/不匹配）—— 页面不是宿主服务的那个会话。 */
  | 'refused'
  /** 端点不可用（503：宿主侧的围栏服务不可用 —— fail-closed）。 */
  | 'unavailable'
  /** 请求没到达宿主（网络层异常）。 */
  | 'transport'
  /** 到了宿主，但响应不是契约承诺的形状。 */
  | 'malformed'

/** 引导失败（带 HTTP 状态，便于排障）。 */
export interface HostProofFailure {
  reason: HostProofFailureReason
  status: number | null
  message: string
}

/** 当前令牌（内存持有）。 */
let current: HostProofToken | null = null

/** 进行中的引导（并发去重：挂载期与首次调用不会各发一次）。 */
let inFlight: Promise<HostProofToken | null> | null = null

/** 最近一次失败（供调用方给可辨原因，不抛异常）。 */
let lastFailure: HostProofFailure | null = null

/** {@link ensureHostProof} 的可注入依赖。 */
export interface HostProofDeps {
  /** 取数实现（缺省全局 `fetch`）。 */
  fetch?: typeof fetch
  /** 当前时间（测试注入）。 */
  now?: () => number
}

/**
 * 直接注入一枚令牌（测试与已知令牌场景）；`null` = 清空。
 * @param token - 令牌；`null` 清空。
 */
export function setHostProofToken(token: HostProofToken | null): void {
  current = token
  if (token !== null) lastFailure = null
}

/**
 * 清空令牌（登出/切账号/切分区时调用：上一个会话的令牌不该被下一个复用）。
 */
export function clearHostProofToken(): void {
  current = null
}

/**
 * 当前可用令牌（未过期、且留出 {@link HOST_PROOF_SKEW_MS} 提前量）。
 * @param now - 当前时间（缺省 `Date.now()`）。
 * @returns 令牌串，或 `null`（没有 / 过期）。
 */
export function hostProofToken(now: number = Date.now()): string | null {
  if (current === null) return null
  return current.expiresAt - HOST_PROOF_SKEW_MS > now ? current.token : null
}

/**
 * 最近一次引导失败（成功引导会清空它）。
 * @returns 失败，或 `null`。
 */
export function hostProofFailure(): HostProofFailure | null {
  return lastFailure
}

/**
 * 解析引导响应。
 * @param payload - 响应体（`{proof, expires_at}`）。
 * @returns 令牌；形状不符 ⇒ `null`。
 */
export function parseHostProof(payload: unknown): HostProofToken | null {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null
  const row = payload as { proof?: unknown, expires_at?: unknown }
  const token = typeof row.proof === 'string' ? row.proof.trim() : ''
  const expiresAt = row.expires_at
  if (token === '') return null
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return null
  return { token, expiresAt }
}

/**
 * 确保持有一枚可用令牌（缓存命中直接返回；否则引导一次）。
 *
 * `force` 用于"调用方刚被 401 打回"的场景：**强制**重取一枚（但并发仍去重 ——
 * 同一时刻只会有一枚请求在飞，避免重试风暴）。
 * @param options - `force`（强制重取）与可注入依赖。
 * @returns 令牌；失败 ⇒ `null`（原因见 {@link hostProofFailure}）。
 */
export async function ensureHostProof(options: HostProofDeps & { force?: boolean } = {}): Promise<HostProofToken | null> {
  const now = options.now ?? (() => Date.now())
  if (options.force !== true) {
    const cached = hostProofToken(now())
    if (cached !== null) return { token: cached, expiresAt: current?.expiresAt ?? 0 }
  }
  if (inFlight !== null) return inFlight
  const doFetch = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  const task = (async (): Promise<HostProofToken | null> => {
    let response: Response
    try {
      response = await doFetch(HOST_PROOF_PATH, {
        method: 'GET',
        headers: { accept: 'application/json' },
        // 引导路径当日仍需浏览器会话（宿主侧的 connection 围栏）——它是**唯一**允许
        // 依赖 cookie 的一步；业务调用一律只看请求头（R2）。
        credentials: 'same-origin',
      })
    } catch (cause) {
      lastFailure = { reason: 'transport', status: null, message: `the host proof endpoint is unreachable: ${cause instanceof Error ? cause.message : String(cause)}` }
      return null
    }
    if (!response.ok) {
      let body = ''
      try { body = await response.text() } catch { body = '' }
      lastFailure = {
        reason: response.status === 403 ? 'refused' : (response.status >= 500 ? 'unavailable' : 'malformed'),
        status: response.status,
        message: `the host proof endpoint refused (HTTP ${String(response.status)}): ${body.slice(0, 200)}`,
      }
      return null
    }
    let payload: unknown
    try {
      payload = await response.json()
    } catch (cause) {
      lastFailure = { reason: 'malformed', status: response.status, message: `the host proof endpoint returned a non-JSON body: ${cause instanceof Error ? cause.message : String(cause)}` }
      return null
    }
    const parsed = parseHostProof(payload)
    if (parsed === null) {
      lastFailure = { reason: 'malformed', status: response.status, message: `the host proof endpoint must answer {"proof":…,"expires_at":…}; got ${JSON.stringify(payload).slice(0, 200)}` }
      return null
    }
    current = parsed
    lastFailure = null
    return parsed
  })()
  inFlight = task
  void task.finally(() => { if (inFlight === task) inFlight = null })
  return task
}

/**
 * 这个错误码是不是"证明问题"（值得重取令牌后重试一次）。
 *
 * 宿主的证明闸回 `{"error":"proof_required"|"proof_expired"}`（**字符串** error）；
 * 宿主业务面的未登录回 `{"error":{"code":"AUTH_REQUIRED"}}`（**对象**）—— 两者都是 401，
 * 但前者该重取令牌、后者该去登录。这就是本函数存在的理由。
 * @param code - 解析出的错误码（`null` = 没解析出来）。
 * @returns true = 证明问题。
 */
export function isHostProofErrorCode(code: string | null): boolean {
  return code === 'proof_required' || code === 'proof_expired' || code === 'proof_mismatch'
}

/**
 * 从错误响应体里读错误码（两种形态：`{"error":"proof_required"}` 与
 * `{"error":{"code":"AUTH_REQUIRED"}}`；也接受顶层 `code`）。
 * @param payload - 已解析的响应体。
 * @returns 错误码，或 `null`。
 */
export function readHostErrorCode(payload: unknown): string | null {
  if (payload === null || typeof payload !== 'object') return null
  const row = payload as { error?: unknown, code?: unknown }
  if (typeof row.error === 'string') return row.error
  if (row.error !== null && typeof row.error === 'object') {
    const code = (row.error as { code?: unknown }).code
    if (typeof code === 'string') return code
  }
  return typeof row.code === 'string' ? row.code : null
}

/**
 * 带令牌请求本机路由；**证明问题只重试一次**（R2-X-1 第 3 条）。
 *
 * 语义：
 *  - 没有可用令牌 ⇒ 先引导一次；仍没有 ⇒ 返回 `null` 并让调用方给可辨原因
 *    （**不发业务请求** —— 发出去必然 401，还会把"证明没拿到"掩盖成"接口拒绝"）；
 *  - 业务请求 401 且错误码是 `proof_*` ⇒ 强制重取一枚并**重放一次**；
 *  - 第二次仍失败 ⇒ 原样返回第二次响应（调用方按同一套错误码分层）。
 *
 * @param url - 本机路径。
 * @param init - fetch init（headers 会被补上证明头）。
 * @param deps - 可注入依赖与强制重取标记。
 * @returns 响应，或 `null`（令牌拿不到 ⇒ 没发业务请求）。
 */
export async function fetchWithHostProof(
  url: string,
  init: RequestInit,
  deps: HostProofDeps = {},
): Promise<Response | null> {
  const doFetch = deps.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  const send = async (token: string): Promise<Response> => await doFetch(url, {
    ...init,
    headers: { ...(init.headers as Record<string, string> | undefined ?? {}), [HOST_PROOF_HEADER]: token },
  })

  let issued = await ensureHostProof(deps)
  if (issued === null) return null
  let response = await send(issued.token)
  if (response.status !== 401) return response

  // 只有"证明问题"才值得重取令牌重放一次；`AUTH_REQUIRED`（未登录）走登录流程。
  const code = readHostErrorCode(await readJsonQuietly(response))
  if (!isHostProofErrorCode(code)) return response
  issued = await ensureHostProof({ ...deps, force: true })
  if (issued === null) return null
  response = await send(issued.token)
  return response
}

/**
 * 本机路由错误信封里"**平台**拒绝了这次调用"的码前缀（与宿主
 * `packages/host/wasm-apps-host/src/index.ts` 的 `PLATFORM_REFUSAL_CODE_PREFIX` 逐字一致；
 * `app-center.spec.tsx` 会与宿主源码逐字对拍）。
 *
 * 为什么客户端要单独认它：平台的证明码（`proof_required`/`proof_expired`/…）与
 * **本机**证明闸的码字面相同，但两者的下一步完全不同。宿主把平台码包成
 * `PLATFORM_<CODE>` 之后，客户端才能把"本机凭据被拒"与"服务端拒绝了这次打开"
 * 分流到不同的 reason 与文案。
 */
export const PLATFORM_REFUSAL_CODE_PREFIX = 'PLATFORM_'

/**
 * 这个错误信封是不是"平台（服务端）拒绝了本次调用"；是则给出**原码**。
 *
 * 两种形态都认：宿主封装后的 `{code:"PLATFORM_X", platform_code:"x"}`，以及
 * 只有原码的 `{code:"PLATFORM_X"}`（`platform_code` 摘掉前缀小写还原）。
 * @param payload - 已解析的响应体。
 * @returns 平台原码（小写）；不是平台拒绝 ⇒ `null`。
 */
export function readHostPlatformRefusal(payload: unknown): string | null {
  if (payload === null || typeof payload !== 'object') return null
  const error = (payload as { error?: unknown }).error
  if (error === null || typeof error !== 'object') return null
  const row = error as { code?: unknown, platform_code?: unknown }
  // 一律**摘前缀小写还原**：宿主给 `code` 加的是 `toUpperCase()`（`PLATFORM_NOT_FOUND`），
  // 而 `platform_code` 原样透传平台码 —— 平台的码表是**混合大小写**的
  // （`NOT_FOUND` 大写、`proof_required` 小写，见 `server/internal/wasmapp/apperr`）。
  // 不归一化就会出现"同一个码看大小写分流"：`platform_code:"PROOF_REQUIRED"` 落不进
  // `proof_` 前缀判定 ⇒ 平台拒绝被显示成"未登录"。
  if (typeof row.platform_code === 'string' && row.platform_code.trim() !== '') {
    return row.platform_code.trim().toLowerCase()
  }
  const code = typeof row.code === 'string' ? row.code : ''
  return code.startsWith(PLATFORM_REFUSAL_CODE_PREFIX)
    ? code.slice(PLATFORM_REFUSAL_CODE_PREFIX.length).toLowerCase()
    : null
}

/**
 * 平台错误信封里"应用被**冻结**"这一档 `platform_reason` 的**唯一字面量**。
 *
 * 真源在服务端 `server/internal/wasmapp/api/open.go`：冻结（只读快照、数据保留）与
 * "不存在"（软删 / 从未登记）被平台刻意放进**同一个 HTTP 404 + 同一个 `NOT_FOUND`**
 * 里（不泄露存在性），唯一区分凭据就是 `details.reason`；宿主把它原样搬到
 * `error.platform_reason`。客户端只认这一个字面量，不认它的地方一律按"不存在"回落。
 */
export const PLATFORM_APP_FROZEN_REASON = 'app_frozen'

/**
 * 读平台错误信封里的**结构化原因** `error.platform_reason`（"冻结 vs 不存在"的
 * **唯一**凭据）。与 {@link readHostPlatformRefusal} 并列导出，是因为这两个字段必须
 * 出自**同一份**判定与**同一处**读取 —— 分流点各读一遍就会出现"码说平台拒绝、原因
 * 说本机证明"的错配。
 *
 * 两种形态都容忍：
 *  - 宿主封装后的 `{error:{code:"PLATFORM_X", platform_code:"x", platform_reason:"y"}}`
 *    ⇒ `"y"`（归一化为小写、去首尾空白）；
 *  - 只有前缀码的 `{error:{code:"PLATFORM_X"}}`（旧宿主）⇒ `null` —— 原因**不可从码里
 *    还原**，调用方按"没有额外信息"做确定性回落，绝不猜。
 *
 * 只在**平台拒绝**信封上读：非平台信封（本机证明闸的 `{"error":"proof_required"}`）
 * 即使带同名字段也不认，否则一个本机信封就能改写平台分流。
 * @param payload - 已解析的响应体。
 * @returns 平台结构化原因（小写）；不是平台拒绝 / 没带原因 ⇒ `null`。
 */
export function readHostPlatformReason(payload: unknown): string | null {
  if (readHostPlatformRefusal(payload) === null) return null
  if (payload === null || typeof payload !== 'object') return null
  const error = (payload as { error?: unknown }).error
  if (error === null || typeof error !== 'object') return null
  const reason = (error as { platform_reason?: unknown }).platform_reason
  return typeof reason === 'string' && reason.trim() !== '' ? reason.trim().toLowerCase() : null
}

/**
 * 读响应体为 JSON（失败 ⇒ `null`），**不改动**调用方后续的读取（用 clone）。
 *
 * 2026-09-23：本函数是本包（`src/client/`）的**唯一实现** —— `channel-seam.ts` 与
 * `open-app.ts` 原先各持一份逐字节相同的副本，三份互为独立实现意味着「一次收口
 * （例如给 clone 失败加兜底、或把 `JSON.parse` 换成带 reviver 的版本）只改到一处」。
 * 那两处现在都从这里 import。导出面因此变大（原来是模块私有），属纯增量。
 *
 * @param response - 原始响应。
 * @returns 解析结果，或 `null`。
 */
export async function readJsonQuietly(response: Response): Promise<unknown> {
  try {
    const text = await response.clone().text()
    return text === '' ? null : JSON.parse(text)
  } catch {
    return null
  }
}
