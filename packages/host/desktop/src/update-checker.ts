/** Headless version checks against the server the user is signed in to. */

import {
  parseReleaseManifest,
  readClientUnavailableReason,
  type DesktopReleaseManifest,
} from './desktop-release.ts'

export { serverChannelURL, serverManifestURL } from './desktop-release.ts'

/**
 * Maximum response body bytes accepted from the update service.
 * 2026-09-06 实测修复沿用:响应体超限会被 readLimitedBody 拒绝并静默降级,
 * 1MB 足以容纳清单及其后续扩展字段。
 */
export const MAX_VERSION_RESPONSE_BYTES = 1024 * 1024

/** Strictly parsed SemVer components. Numeric components remain strings to avoid overflow. */
export interface ParsedSemVer {
  /** Canonical version without the optional leading `v`. */
  readonly version: string
  /** Major numeric identifier. */
  readonly major: string
  /** Minor numeric identifier. */
  readonly minor: string
  /** Patch numeric identifier. */
  readonly patch: string
  /** Ordered prerelease identifiers, or an empty list for a stable version. */
  readonly prerelease: readonly string[]
  /** Build identifiers, ignored for version precedence. */
  readonly build: readonly string[]
}

/** Fetch-compatible request function used by the headless checker. */
export type UpdateRequest = (url: string, init: RequestInit) => Promise<Response>

/** Inputs for one version check. */
export interface UpdateCheckOptions {
  /** Installed application version, expressed as canonical SemVer. */
  readonly currentVersion: string
  /**
   * 服务端版本清单的绝对地址（`serverManifestURL(session.serverURL)`）。
   * 调用方必须先确认已登录 —— 没有登录的服务端就没有更新源。
   */
  readonly manifestURL: string
  /** Caller-owned cancellation signal; the checker does not create its own timeout. */
  readonly signal?: AbortSignal
  /** Optional fetch implementation for a host adapter or test. */
  readonly request?: UpdateRequest
  /**
   * 期望的渠道 id：**由服务端自己声明**（`GET /api/client/v2/channel` 的
   * `channel_id`），而不是客户端构建期注入的值。
   *
   * 作用:校验清单声明的渠道与该服务端对外宣称的渠道一致 —— 服务端配置出错
   * (镜像里的渠道内容与声明的渠道对不上)时立即失败,而不是静默放行。
   * 拿不到服务端渠道内容时省略(清单仍必须自带非空 `channel_id`)。
   */
  readonly expectedChannel?: string
}

/** Successful comparison returned by the version service. */
export type UpdateCheckResult = {
  /** Whether the service reports a version newer than the installed application. */
  readonly status: 'up-to-date' | 'update-available'
  /** Canonical installed version. */
  readonly currentVersion: string
  /** Canonical newest version reported by the selected channel service. */
  readonly latestVersion: string
}

const SEMVER_PATTERN =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u

/**
 * Parse strict SemVer with an optional lowercase `v` prefix.
 * @param input - complete version or release tag.
 * @returns parsed identifiers, or null when the input is not valid SemVer.
 */
export function parseSemVer(input: string): ParsedSemVer | null {
  const version = input.startsWith('v') ? input.slice(1) : input
  const match = SEMVER_PATTERN.exec(version)
  if (match === null) return null

  const prerelease = match[4]?.split('.') ?? []
  if (prerelease.some(identifier => isNumeric(identifier) && hasLeadingZero(identifier))) return null

  return {
    version,
    major: match[1]!,
    minor: match[2]!,
    patch: match[3]!,
    prerelease,
    build: match[5]?.split('.') ?? [],
  }
}

/**
 * Compare two strict SemVer strings without numeric overflow.
 * @param left - first strict SemVer value.
 * @param right - second strict SemVer value.
 * @returns negative, zero, or positive precedence, or null when either value is invalid.
 */
export function compareSemVerVersions(left: string, right: string): number | null {
  const leftVersion = parseSemVer(left)
  const rightVersion = parseSemVer(right)
  if (leftVersion === null || rightVersion === null) return null
  return compareParsedSemVer(leftVersion, rightVersion)
}

/**
 * 版本检查的完整结果。
 *
 * `unavailable` 与"没有新版本"必须分开：服务端推不出安全的对外地址时会**明确**
 * 说明原因（`client_unavailable`，见 server 的 `internal/clientrelease`）。把它
 * 当成"已是最新"就是审计里那条"界面永远显示已是最新、而链路其实断了"的静默故障。
 *
 * `transport` 与 `invalid` 也必须分开：请求抛错（连接重置/DNS/超时）与 5xx 是
 * **可重试**的瞬时故障，而清单结构不符、schema 不匹配、版本号非法重试多少次都
 * 一样 —— 协调器只对 `transport` 做退避重试（2026-09-12 更新健壮化）。
 */
export type UpdateCheckOutcome =
  | { readonly kind: 'result'; readonly result: UpdateCheckResult }
  | { readonly kind: 'unavailable'; readonly reason: string }
  | { readonly kind: 'transport'; readonly status?: number; readonly cause?: unknown }
  | { readonly kind: 'invalid' }

/**
 * Check the signed-in server for a newer client release.
 *
 * 单一模式:GET 服务端的 `/api/client/v2/updates/manifest` 得到版本清单,
 * 再按严格 SemVer 比较。更新源是**它登录的那台服务端**,不是任何分发面 ——
 * 「客户端属于哪个渠道」由服务端在结构上决定,错乱不可能发生。
 * @param options - installed version, manifest URL, caller-owned signal, and request adapter.
 * @returns a successful comparison, or null when any request or validation step fails.
 */
export async function checkForUpdate(
  options: UpdateCheckOptions,
): Promise<UpdateCheckResult | null> {
  const outcome = await checkForUpdateDetailed(options)
  return outcome.kind === 'result' ? outcome.result : null
}

/**
 * 同 `checkForUpdate()`,但保留"服务端明确说给不出下载地址"这一分支。
 * @param options - installed version, manifest URL, caller-owned signal, and request adapter.
 * @returns 区分成功 / 服务端不可用(带原因) / 其它失败的完整结果。
 */
export async function checkForUpdateDetailed(
  options: UpdateCheckOptions,
): Promise<UpdateCheckOutcome> {
  const current = parseSemVer(options.currentVersion)
  // 本地构建(如 "dev")不是合法 SemVer:不提示更新,也不发请求。
  if (current === null || current.version !== options.currentVersion) return { kind: 'invalid' }

  const outcome = await fetchReleaseManifestDetailed(options)
  if (outcome.kind !== 'manifest') return outcome

  const latest = parseSemVer(outcome.manifest.clientVersion)
  if (latest === null || latest.version !== outcome.manifest.clientVersion) return { kind: 'invalid' }

  return {
    kind: 'result',
    result: {
      status: compareParsedSemVer(latest, current) > 0 ? 'update-available' : 'up-to-date',
      currentVersion: current.version,
      latestVersion: latest.version,
    },
  }
}

/** 一次清单请求失败后是否值得重试：只有传输层失败是瞬时的。 */
export function isRetriableManifestOutcome(outcome: UpdateCheckOutcome | ManifestOutcome): boolean {
  if (outcome.kind === 'transport') {
    // 5xx / 408 是服务端瞬时故障；其余带状态码的失败（4xx）重试没有意义。
    return outcome.status === undefined || outcome.status >= 500 || outcome.status === 408
  }
  return false
}

/** 清单拉取的完整结果（内部类型：把"服务端说给不出地址"与"拉取失败"分开）。 */
type ManifestOutcome =
  | { readonly kind: 'manifest'; readonly manifest: DesktopReleaseManifest }
  | { readonly kind: 'unavailable'; readonly reason: string }
  | { readonly kind: 'transport'; readonly status?: number; readonly cause?: unknown }
  | { readonly kind: 'invalid' }

/**
 * 拉取并严格解析服务端版本清单(更新检查与安装包下载共用的唯一入口)。
 * @param options - manifest URL, request adapter, and caller-owned cancellation.
 * @returns 解析后的清单,或 null(网络/状态码/结构/超限任一失败)。
 */
export async function fetchReleaseManifest(
  options: Pick<UpdateCheckOptions, 'manifestURL' | 'request' | 'signal' | 'expectedChannel'>,
): Promise<DesktopReleaseManifest | null> {
  const outcome = await fetchReleaseManifestDetailed(options)
  return outcome.kind === 'manifest' ? outcome.manifest : null
}

/**
 * `fetchReleaseManifest()` 的详细版:多一个"服务端明确给不出下载地址"的出口。
 * @param options - manifest URL, request adapter, and caller-owned cancellation.
 * @returns 清单 / 不可用原因 / 传输失败(可重试) / 其它失败。
 */
export async function fetchReleaseManifestDetailed(
  options: Pick<UpdateCheckOptions, 'manifestURL' | 'request' | 'signal' | 'expectedChannel'>,
): Promise<ManifestOutcome> {
  const url = options.manifestURL
  const init: RequestInit = {
    method: 'GET',
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    // 清单必须直接返回 200:跳转属于配置错误(服务端/反代把清单做了重定向),
    // 静默跟随会把"通道断了"伪装成"没有新版本"。
    redirect: 'error',
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }

  let response: Response
  try {
    response = await (options.request ?? defaultRequest)(url, init)
  } catch (cause) {
    // 主动取消必须向上传播:吞掉会让"用户点了取消"显示成"网络错误"。
    if (options.signal?.aborted === true || isAbortFailure(cause)) throw cause
    // 请求抛错 = 传输失败(连接重置/DNS/超时)。这不是"清单不存在",协调器要据此重试。
    return { kind: 'transport', cause }
  }
  if (response.status !== 200) return { kind: 'transport', status: response.status }

  let body: string
  try {
    body = await readLimitedBody(response)
  } catch {
    return { kind: 'invalid' }
  }

  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    return { kind: 'invalid' }
  }
  // 渠道校验:清单声明的渠道必须与服务端自报的渠道一致(拿不到服务端渠道
  // 内容时省略该比对,但清单仍必须自带非空 channel_id)。
  const manifest = parseReleaseManifest(value, options.expectedChannel)
  if (manifest !== null) return { kind: 'manifest', manifest }
  // 解析不出清单时,**服务端明确说明的原因**优先于"结构不符":这是
  // "部署没配对外地址"与"清单坏了"两种完全不同的故障。
  const reason = readClientUnavailableReason(value)
  return reason === undefined ? { kind: 'invalid' } : { kind: 'unavailable', reason }
}

/**
 * 判定一个失败是否来自调用方取消(abort)。
 * 与 update-download 的同名判定保持同一语义:标准 AbortError 或错误码为
 * 'aborted' 的下载错误;用于把"取消"与"网络失败"区分开。
 * @param value - 捕获到的异常值。
 * @returns 是取消类失败时为 true。
 */
export function isAbortFailure(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  if (!('name' in value)) return false
  return (value as { name?: unknown }).name === 'AbortError'
}

async function defaultRequest(url: string, init: RequestInit): Promise<Response> {
  return globalThis.fetch(url, init)
}

async function readLimitedBody(response: Response): Promise<string> {
  const declaredLength = response.headers.get('content-length')
  if (declaredLength !== null
    && /^[0-9]+$/u.test(declaredLength)
    && BigInt(declaredLength) > BigInt(MAX_VERSION_RESPONSE_BYTES)) {
    throw new Error('version response is too large')
  }

  if (response.body === null) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let bytesRead = 0
  let body = ''
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytesRead += chunk.value.byteLength
      if (bytesRead > MAX_VERSION_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new Error('version response is too large')
      }
      body += decoder.decode(chunk.value, { stream: true })
    }
    return body + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

function compareParsedSemVer(left: ParsedSemVer, right: ParsedSemVer): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    const comparison = compareNumeric(left[key], right[key])
    if (comparison !== 0) return comparison
  }
  if (left.prerelease.length === 0) return right.prerelease.length === 0 ? 0 : 1
  if (right.prerelease.length === 0) return -1

  const length = Math.max(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = left.prerelease[index]
    const rightIdentifier = right.prerelease[index]
    if (leftIdentifier === undefined) return -1
    if (rightIdentifier === undefined) return 1
    if (leftIdentifier === rightIdentifier) continue

    const leftNumeric = isNumeric(leftIdentifier)
    const rightNumeric = isNumeric(rightIdentifier)
    if (leftNumeric && rightNumeric) return compareNumeric(leftIdentifier, rightIdentifier)
    if (leftNumeric) return -1
    if (rightNumeric) return 1
    return leftIdentifier < rightIdentifier ? -1 : 1
  }
  return 0
}

function compareNumeric(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1
  if (left === right) return 0
  return left < right ? -1 : 1
}

function isNumeric(identifier: string): boolean {
  return /^[0-9]+$/u.test(identifier)
}

function hasLeadingZero(identifier: string): boolean {
  return identifier.length > 1 && identifier.startsWith('0')
}
