/**
 * Wire primitives for the client-only WASM app origin (`picoaide-app://`).
 *
 * 这一层是**纯函数**：URL 解析、信封编解码、头过滤、base64 与体积闸门，全部不碰
 * Electron、不碰 HTTP、不做任何业务判定（准入/静态/执行都在服务端 `serveApp`）。
 * 契约见 `docs/decisions/2026-09-19-wasm-client-internal-origin.md` §4.2：
 *
 * ```
 * 请求 {"method":"GET","path":"/notes","query":"page=2",
 *       "host":"picoaide-app://demo",
 *       "headers":{"origin":"picoaide-app://demo","content-type":"application/json"},
 *       "body":"<base64，可空>"}
 * 响应 {"status":200,"headers":{"Content-Type":["text/html; charset=utf-8"]},
 *       "body":"<base64>","truncated":false}
 * ```
 *
 * 三条不变量（改错任何一条都是安全缺陷，见 §4.2/§4.3）：
 *  1. `host` 只接受 `picoaide-app://<app_id>`；app_id 来自 URL 的 host 段，
 *     **绝不从 Host 头反解**；
 *  2. 请求体 ≤ 1 MiB、信封 ≤ `1 MiB*4/3 + 64 KiB`（与 `limits.go` 同源）；
 *     响应体权威上限 8 MiB 在服务端，这里只做兜底截断；
 *  3. `Set-Cookie` 整体丢弃（自定义协议没有 cookie 语义）、逐跳头与
 *     `Content-Length` 剔除。
 *
 * @module @picoaide/dsh-wasm-apps-host/shared
 */

/**
 * **官方构建**的应用源 scheme（渠道参数化的缺省值）。
 *
 * §7.8/§10 冻结：真实取值来自渠道包 `desktop.app_origin_scheme`，由桌面壳在组装期
 * 经 profile 行 config 注入（`src/profile.ts` 的 channelProfilePatches），本包
 * **不得**用它去覆盖已注入的值。这个常量只在"没有任何渠道配置"的官方构建/单测里
 * 作为缺省，与 desktop 的 `DEFAULT_DEEP_LINK_SCHEME` 同一精神。
 */
export const DEFAULT_APP_SCHEME = 'picoaide-app'

/**
 * 应用源 scheme 的合法形状（§8.3 冻结，与 Go 侧逐字一致）：
 * `^[a-z][a-z0-9+.-]{1,31}$` —— 不是无上界的宽松版本。
 */
export const APP_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]{1,31}$/u

/** 任何安装都不得占用的保留 scheme（§10：不得是这些）。 */
export const RESERVED_APP_SCHEMES: ReadonlySet<string> = new Set([
  'http', 'https', 'file', 'data', 'javascript', 'about', 'blob', 'ws', 'wss', 'ftp',
])

/**
 * 一个 scheme 能否作为应用源 scheme（形状 + 保留名）。
 * @param value - 候选 scheme（不含 `:`）。
 * @returns 合法时为 true。
 */
export function isValidAppScheme(value: unknown): value is string {
  return typeof value === 'string'
    && APP_SCHEME_PATTERN.test(value)
    && !RESERVED_APP_SCHEMES.has(value)
}

/** `<scheme>://` 前缀（唯一实现，避免各处自行拼串）。 */
export function appSchemePrefix(scheme: string): string {
  return `${scheme}://`
}

/** 平台应用请求端点前缀（§4.1 的唯一入口）。 */
export const APP_REQUEST_PATH = '/api/client/v2/apps/wasm'

/**
 * `app_id` 规则，与 `server/internal/wasmapp/limits/limits.go` 的 `AppIDPattern`
 * **同源**：小写、无连续/首尾连字符。客户端不能 import 服务端的 Go 包，因此
 * 两处各有一份 —— 改一处必须改两处（`src/app-protocol.spec.ts` 钉住形状）。
 */
export const APP_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** `app_id` 长度上限（DNS label 上限，limits.go 同源）：63。 */
export const APP_ID_MAX_LENGTH = 63

/**
 * 一条应用 URL 的长度上限。
 *
 * 契约没有规定它：这是 handler 自己的**畸形输入闸门**（一个 8 KiB 的 URL 不可能
 * 来自应用页面，只会来自构造出来的请求），超限一律 400，不转发。
 */
export const APP_URL_MAX_LENGTH = 8 * 1024

/** 请求体上限（§4.2/R21）：1 MiB，base64 解码后判。 */
export const APP_REQUEST_BODY_MAX_BYTES = 1 << 20

/** 信封上限（§4.2）：`1 MiB * 4 / 3 + 64 KiB`。 */
export const APP_ENVELOPE_MAX_BYTES = Math.ceil(APP_REQUEST_BODY_MAX_BYTES * 4 / 3) + (64 << 10)

/** 响应体权威上限（§4.2）：8 MiB；handler 只在捕获层做兜底截断。 */
export const APP_RESPONSE_BODY_MAX_BYTES = 8 << 20

/** 方法白名单（§4.2）。 */
export const APP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const

/** 白名单里的一个方法。 */
export type AppMethod = (typeof APP_METHODS)[number]

/** 出站预算：一次应用请求的默认墙钟上限（毫秒）。 */
export const APP_REQUEST_TIMEOUT_MS = 30_000

/**
 * 逐跳头（RFC 9110 §7.6.1）+ 本模型自己管理的传输头。
 *
 * `content-length` 必须剔除：body 在信封里是 base64，原值对不上；`set-cookie`
 * 由 {@link responseHeadersOf} 单独丢弃（§4.2 明写"整体丢弃"）。
 */
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
])

/**
 * **转发白名单**（§5.1 冻结；单一真源 = `server/internal/wasmapp/api/headerspec.go`
 * 生成的 `wasm-app-headers.json` 的 `request_headers`）。
 *
 * 为什么从"短黑名单"改成白名单（R1-CLI-5）：Chromium 每个请求都自带
 * `sec-ch-ua*`、`priority`、`accept-encoding` 这类头，黑名单**永远列不全** ⇒ 它们
 * 被塞进信封 ⇒ 服务端按自己的白名单拒 ⇒ **整次导航 400**（本地开发很难撞上，真机必现）。
 * 白名单的失效方向是安全的：多列的头会被服务端再拒一次（本轮修的就是这个），
 * 少列的头只是不透传（应用读不到它，不会 400）。
 *
 * `origin` 在白名单里但**由 handler 合成并覆盖**（§4.3：自定义协议下浏览器不发
 * Origin）；`authorization`/`cookie`/`host`/`referer`/`sec-fetch-*` 永远不在名单里
 * —— 员工令牌只由 handler 以 `Authorization: Bearer` 发给平台，信封里出现它等于把
 * 令牌交给应用自己的请求体。
 *
 * 与生成物的逐字对拍在 `src/header-spec-parity.spec.ts`（删掉名单里任一项即红）。
 */
export const FORWARDED_REQUEST_HEADERS: readonly string[] = [
  'origin',
  'content-type',
  'accept',
  'accept-language',
  'if-none-match',
  'if-modified-since',
  'user-agent',
  'x-requested-with',
]

/** 头表闸门（与生成物 `limits` 同源）：条数上限 24。 */
export const REQUEST_HEADER_COUNT_MAX = 24

/** 头表闸门：单值字节上限 8 KiB。 */
export const REQUEST_HEADER_VALUE_MAX_BYTES = 8 * 1024

/** 永不透传的头（白名单之外的第二道闸；即使有人误把某项加进白名单也拦住）。 */
const NEVER_FORWARDED_REQUEST_HEADERS = new Set([
  'authorization',
  'cookie',
  'host',
  'referer',
  'accept-encoding',
  'sec-fetch-site',
  'sec-fetch-mode',
  'sec-fetch-dest',
  'sec-fetch-user',
])

/** 解析后的应用 URL。 */
export interface AppUrl {
  /** URL host 段（= `app_id`；只接受小写合法标识）。 */
  readonly appId: string
  /** 以 `/` 开头的路径（永远非空，`/` 是合法根路径）。 */
  readonly path: string
  /** 查询串（**不含**前导 `?`，可空）。 */
  readonly query: string
}

/** 请求信封（§4.2）。 */
export interface AppRequestEnvelope {
  method: string
  path: string
  query: string
  host: string
  headers: Record<string, string>
  /** base64；无请求体时是空串（不是 `null`）。 */
  body: string
}

/** 响应信封（§4.2）。 */
export interface AppResponseEnvelope {
  status: number
  headers: Record<string, string | string[]>
  /** base64 响应体。 */
  body: string
  /** 服务端是否标记了截断（权威截断在服务端，见 §4.2）。 */
  truncated: boolean
}

/**
 * `app_id` 是否合法（形状 + 长度）。
 * @param value - 待判定的值（任意类型：URL 段来自外部输入）。
 * @returns 合法时为 true。
 */
export function isValidAppId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= APP_ID_MAX_LENGTH
    && APP_ID_PATTERN.test(value)
}

/**
 * 合成应用 origin（**唯一实现**：它既是 `host` 字段也是补出来的 `Origin`）。
 *
 * §4.3：自定义协议下的请求不带任何 `Origin`/`Referer`/`Sec-Fetch-*`，所以
 * handler 必须补一个自源 Origin，否则平台的非幂等写防护必然全拒。
 * @param scheme - 本安装的应用源 scheme（渠道注入；见 {@link DEFAULT_APP_SCHEME}）。
 * @param appId - 已校验的 app_id。
 * @returns `<scheme>://<app_id>`。
 */
export function appOrigin(scheme: string, appId: string): string {
  return `${appSchemePrefix(scheme)}${appId}`
}

/**
 * 解析应用请求 URL（严格：scheme/app_id/路径形状任一不符即 null）。
 * @param raw - `request.url` 原文（Chromium 已解析过，这里再独立校验一遍）。
 * @param scheme - 本安装的应用源 scheme（**不匹配即 null**：至少两个不同渠道的
 *   客户端就是靠它把对方的 origin 拒之门外的，绝不做"任意自定义协议都收"）。
 * @returns 解析结果，或 null（调用方按可读错误页处理）。
 */
export function parseAppUrl(raw: unknown, scheme: string): AppUrl | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > APP_URL_MAX_LENGTH) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== `${scheme}:`) return null
  // app_id **只**来自 URL 的 host 段：绝不用 Host 头或查询参数兜底。
  const appId = url.hostname
  if (!isValidAppId(appId)) return null
  const path = url.pathname === '' ? '/' : url.pathname
  if (!path.startsWith('/')) return null
  const query = url.search.startsWith('?') ? url.search.slice(1) : url.search
  return { appId, path, query }
}

/**
 * 过滤请求头（**白名单口径**，§5.1）：只转发 {@link FORWARDED_REQUEST_HEADERS} 里
 * 那 8 项，其余（Chromium 的 `sec-ch-ua*`/`priority`、任何身份头、cookie、逐跳头）
 * 一律不进信封。`origin` 也在这里被丢掉 —— handler 之后会用合成值覆盖它。
 * @param headers - 原始请求头。
 * @returns 归一化（小写名）后的头表。
 */
export function forwardableRequestHeaders(headers: Headers): Record<string, string> {
  const allowed = new Set(FORWARDED_REQUEST_HEADERS)
  const out: Record<string, string> = {}
  for (const [name, value] of headers) {
    const key = name.toLowerCase()
    if (!allowed.has(key)) continue
    if (NEVER_FORWARDED_REQUEST_HEADERS.has(key)) continue
    if (HOP_BY_HOP_HEADERS.has(key)) continue
    out[key] = value
  }
  return out
}

/**
 * 头表的条数/单值闸门（与服务端 `limits` 同口径）。
 *
 * 超限**本地拒绝**（不静默截断）：截断的头会让服务端看到一份"看起来合法但内容变了"
 * 的请求，症状比 400 难查得多。服务端自己的判据在 `clientreq.go`。
 * @param headers - 已过滤的头表（小写名）。
 * @returns 通过时为 null；否则给出原因与实测值。
 */
export function headerGateViolation(headers: Record<string, string>): { reason: 'too-many-headers' | 'header-value-too-large', limit: number, actual: number } | null {
  const names = Object.keys(headers)
  if (names.length > REQUEST_HEADER_COUNT_MAX) {
    return { reason: 'too-many-headers', limit: REQUEST_HEADER_COUNT_MAX, actual: names.length }
  }
  for (const name of names) {
    const bytes = Buffer.byteLength(headers[name] ?? '', 'utf8')
    if (bytes > REQUEST_HEADER_VALUE_MAX_BYTES) {
      return { reason: 'header-value-too-large', limit: REQUEST_HEADER_VALUE_MAX_BYTES, actual: bytes }
    }
  }
  return null
}

/** 组装信封的结果。 */
export type EnvelopeBuildResult =
  | { ok: true, envelope: AppRequestEnvelope }
  | { ok: false, reason: 'body-too-large' | 'envelope-too-large' | 'too-many-headers' | 'header-value-too-large', limit: number, actual: number }

/**
 * 组请求信封（§4.2）。
 *
 * `Origin` 在这里**补**上（覆盖任何应用自己带的 origin，见 §4.3）；体积闸门按
 * "body ≤ 1 MiB（解码后）"与"信封 ≤ 1 MiB*4/3 + 64 KiB（序列化后）"两档判，
 * 与服务端 `limits.go` 同源。
 * @param input - 已解析 URL、方法、原始头与请求体字节。
 * @returns 信封，或超限原因。
 */
export function buildRequestEnvelope(input: {
  /** 本安装的应用源 scheme（渠道注入；Origin 与 host 都由它合成）。 */
  scheme: string
  url: AppUrl
  method: string
  headers: Headers
  body: Uint8Array
}): EnvelopeBuildResult {
  if (input.body.byteLength > APP_REQUEST_BODY_MAX_BYTES) {
    return {
      ok: false,
      reason: 'body-too-large',
      limit: APP_REQUEST_BODY_MAX_BYTES,
      actual: input.body.byteLength,
    }
  }
  const headers = forwardableRequestHeaders(input.headers)
  const headerViolation = headerGateViolation(headers)
  if (headerViolation !== null) return { ok: false, ...headerViolation }
  // `origin` 是白名单里唯一**合成**项：应用自带的值在过滤阶段已被丢掉，这里写入
  // 由 handler 计算的自源（§4.3）。断言"合成值胜出"在 `app-protocol.spec.ts`。
  headers.origin = appOrigin(input.scheme, input.url.appId)
  const envelope: AppRequestEnvelope = {
    method: input.method,
    path: input.url.path,
    query: input.url.query,
    host: appOrigin(input.scheme, input.url.appId),
    headers,
    body: input.body.byteLength === 0 ? '' : Buffer.from(input.body).toString('base64'),
  }
  // 信封体积按**真实序列化结果**判（不是估算）：契约给的上限就是线上字节数。
  const actual = Buffer.byteLength(JSON.stringify(envelope), 'utf8')
  if (actual > APP_ENVELOPE_MAX_BYTES) {
    return { ok: false, reason: 'envelope-too-large', limit: APP_ENVELOPE_MAX_BYTES, actual }
  }
  return { ok: true, envelope }
}

/** 解析响应信封的结果。 */
export type EnvelopeParseResult =
  | { ok: true, envelope: AppResponseEnvelope }
  | { ok: false, reason: string }

/**
 * 解析平台响应信封（畸形即拒：宁可给可读错误页，也不把半个页面交给渲染器）。
 * @param value - `JSON.parse` 之后的响应体。
 * @returns 信封，或拒绝原因。
 */
export function parseResponseEnvelope(value: unknown): EnvelopeParseResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'response envelope is not a JSON object' }
  }
  const record = value as Record<string, unknown>
  const status = record.status
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) {
    return { ok: false, reason: 'response envelope has no valid status' }
  }
  const body = record.body
  if (typeof body !== 'string') return { ok: false, reason: 'response envelope has no base64 body' }
  const rawHeaders = record.headers
  const headers: Record<string, string | string[]> = {}
  if (rawHeaders !== undefined) {
    if (rawHeaders === null || typeof rawHeaders !== 'object' || Array.isArray(rawHeaders)) {
      return { ok: false, reason: 'response envelope headers are not an object' }
    }
    for (const [name, headerValue] of Object.entries(rawHeaders as Record<string, unknown>)) {
      if (typeof headerValue === 'string') {
        headers[name] = headerValue
        continue
      }
      if (Array.isArray(headerValue) && headerValue.every(entry => typeof entry === 'string')) {
        headers[name] = headerValue as string[]
        continue
      }
      return { ok: false, reason: `response envelope header ${name} is not a string or string[]` }
    }
  }
  return { ok: true, envelope: { status, headers, body, truncated: record.truncated === true } }
}

/**
 * 解码 base64 响应体，并在超过兜底上限时截断。
 *
 * 校验字母表与长度：`Buffer.from(x,'base64')` 对畸形输入是"尽力解码"，会把半张
 * 页面当成正常内容交给渲染器。
 * @param text - base64 文本。
 * @returns 字节；畸形输入返回 null。
 */
export function decodeBase64Body(text: string): Uint8Array | null {
  const normalized = text.replace(/\s+/gu, '')
  if (normalized === '') return new Uint8Array(0)
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(normalized) || normalized.length % 4 !== 0) return null
  const bytes = Buffer.from(normalized, 'base64')
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

/**
 * 把平台响应头还原成 `Headers`（丢弃 `Set-Cookie`、逐跳头与 `Content-Length`）。
 * @param headers - 信封里的头表。
 * @returns 可直接交给 `Response` 的头对象。
 */
export function responseHeadersOf(headers: Record<string, string | string[]>): Headers {
  const out = new Headers()
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase()
    // §4.2：`Set-Cookie` **整体丢弃**（自定义协议无 cookie 语义）。
    if (key === 'set-cookie') continue
    if (HOP_BY_HOP_HEADERS.has(key)) continue
    if (Array.isArray(value)) {
      for (const entry of value) out.append(name, entry)
      continue
    }
    out.set(name, value)
  }
  return out
}

/**
 * 该请求是不是一次**文档导航**（据此决定错误呈现方式）。
 *
 * 应用自己的 `fetch()` 必须拿到平台原样的 JSON 信封（它按 code 分流）；只有
 * 顶层导航才把错误渲染成可读 HTML —— 否则用户在浏览器里看到的是一屏裸 JSON。
 * @param headers - 请求头。
 * @returns 接受 text/html 时为 true。
 */
export function wantsHtml(headers: Headers): boolean {
  const accept = headers.get('accept')
  return accept !== null && accept.toLowerCase().includes('text/html')
}

/**
 * 该响应体是不是 HTML（据此决定要不要替换成可读错误页）。
 * @param headers - 响应头。
 * @returns `Content-Type` 前缀为 `text/html` 时为 true。
 */
export function isHtmlResponse(headers: Headers): boolean {
  const contentType = headers.get('content-type')
  return contentType !== null && contentType.toLowerCase().startsWith('text/html')
}
