/**
 * WASM 应用平台**客户端侧创作链路**的发布编排、本地路由与宿主工具面的共用实现
 * （设计基线 `docs/planning/2026-09-17-wasm-app-platform.md` §4.2 / §6.2 / §8 第 10 项）。
 *
 * 这一层解决三个问题，缺任何一个"发布"都跑不通：
 *
 *  1. **凭据不出客户端**：员工令牌只存在于 Host（`ctx.picoSession`），浏览器页面与
 *     应用都拿不到它 —— 因此 `/api/pico/apps/wasm/*` 是本机唯一入口，由 Host 持票
 *     转发到 `/api/client/v2/apps/wasm/*`。
 *  2. **90 s 超时**（§4.2/§10.5 第 58 项）：服务端 `ReadTimeout` 是 60 s，客户端
 *     必须比它长（`CLIENT_UPLOAD_TIMEOUT_MS`）；沿用既有技能上传的 `timeoutMs: 30000`
 *     会让 32 MiB 载荷必然超时。
 *  3. **>8 MiB 走分片 + 续传**（§4.2）：一次 44 MiB 的 base64 请求在 60 s 内传完
 *     需要 ≈6.7 Mbps 保底，弱网必失败；分片后每片 ≤8 MiB，且断线可以只补缺失片。
 *
 * ## 一份编排，两个调用面（§6.5b）
 *
 * 编排（`publishApp` / `validateApp` / `listCatalog` / `proxyApp`）**不依赖 HTTP**：
 * 入参是普通对象，回参是结构化信封 {@link WasmResponse}。两个调用面共用它：
 *
 *  - **本机路由**（{@link createWasmAppsRoute}）：解析请求 → 调编排 → 按信封逐字节写响应。
 *    它是**薄壳**，且必须薄：写面围栏（持有性证明）是 HTTP 层的事，编排不该知道。
 *  - **宿主工具**（`wasm-app-tools.ts` 的 `wasm_app_validate` / `wasm_app_publish` /
 *    `wasm_app_list`）：模型在宿主进程内直接调同一批函数，不经 HTTP —— 因此既不需要
 *    浏览器持有性证明（AI 的 bash/curl 拿不到那张票），也不会把令牌交给任何调用方。
 *
 * **不要复制编排**：复制一份 = 两条链路的超时/分片/错误信封迟早给出不同答案
 * （`docs/planning/2026-09-17-wasm-app-platform-implementation.md` §6.5b 明写）。
 * `tests/wasm-app-tools.spec.ts` 有一条"路由与工具命中同一个实现"的结构断言守着它。
 *
 * 纪律（与 auth-gate 的 `/api/pico/skills` 同口径，不另立一套）：
 *  - 写面（非 GET）一律要**持有性证明**（`requireWriteProof`，fence 缺席 fail-closed）；
 *  - 服务端的**业务错误信封** `{error:{code,message,details,hints}}` 原样透传 ——
 *    第一消费者是 AI，丢掉 hints 等于让它自己猜（§8 原话）；
 *  - 只有**传输层**失败（连不上/超时）才回落 `gateway error` 系文案。
 *
 * 本模块**不做**编译（R40/R42：工具链与本地编译是 skill/AI 的职责）、不做任何
 * 业务规则判定（`app_id`/版本号/配置文件合法性全部由服务端裁决）。
 *
 * @module @picoaide/dsh-enterprise/wasm-apps
 */

import type { Context } from '@deepseek-ai/cordis'
import { dshHomeSafe } from 'dsh-plugin-desktop/desktop-home'
import { hostCopy, type HostLocale } from 'dsh-plugin-desktop/host-locale'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { open, realpath, stat } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { gatewayFetch, normalizeServerURL } from './server-connector/auth.ts'
import type { Session } from './server-connector/config.ts'

/** 本地路由前缀（唯一入口；管理面只在主站，§4.7 的 F-52e）。 */
export const WASM_APPS_PREFIX = '/api/pico/apps/wasm'

/** 本地/服务端 JSON 响应的 Content-Type（两处必须一致：路由逐字节写出上游原文）。 */
export const WASM_JSON_CONTENT_TYPE = 'application/json; charset=utf-8'

// ---------------------------------------------------------------------------
// 客户端侧上限常量（**唯一真源**）
// ---------------------------------------------------------------------------
//
// ⚠️ 与 `server/internal/wasmapp/limits/limits.go` **同源**：客户端不能 import 服务端
// 的 Go 包，所以这几个数值在两侧各有一份 —— **改一处必须改两处**。
//
// 为什么必须在客户端也留一份：这些数字决定客户端的**行为**（何时分片、超时设多长、
// 本地提前拒绝多大的载荷），不是服务端的实现细节。设计文档 §4.2 原话：
// 「客户端上传超时 90 s（必须 > 服务端 `ReadTimeout 60 s`）；>8 MiB 走分片 + 续传」。
//
// 变异性（谁改回危险默认值会让哪条用例红）：见 `tests/wasm-apps.spec.ts` 顶部
// 的"变异验证"清单；其中 `CLIENT_UPLOAD_TIMEOUT_MS > SERVER_READ_TIMEOUT_MS` 是
// §10.5 第 58 项的配置断言，`>8 MiB 必走分片` 是同一项的后半句。

/** `.wasm` 体积上限（§4.2，R33）：32 MiB。 */
export const WASM_MAX_BYTES = 32 * 1024 * 1024
/** 上传请求体上限（base64 JSON，§4.2/R21）：48 MiB。 */
export const UPLOAD_BODY_MAX_BYTES = 48 * 1024 * 1024
/** 客户端上传超时（§4.2）：90 s，**必须**大于服务端读取超时。 */
export const CLIENT_UPLOAD_TIMEOUT_MS = 90_000
/** 服务端 `http.Server.ReadTimeout`（§4.2）：60 s。仅用于断言序关系，客户端不消费。 */
export const SERVER_READ_TIMEOUT_MS = 60_000
/** 分片上传的单片上限（§4.2）：8 MiB；同时是"超过它就切分"的阈值。 */
export const UPLOAD_CHUNK_MAX_BYTES = 8 * 1024 * 1024
/**
 * 分片上传的单片下限（limits.go `UploadChunkMinBytes`）：64 KiB。
 *
 * 客户端不主动产生小于它的分片 —— 见 {@link planChunks} 的均分策略，
 * 否则"最后一片只剩几 KB"会被服务端按元数据攻击拒掉。
 */
export const UPLOAD_CHUNK_MIN_BYTES = 64 * 1024

/**
 * 客户端侧全量上限快照（供 UI/skill 读取，避免各自硬编码数字）。
 *
 * 冻结：这些值同时出现在注释、错误 hints 与测试断言里，运行期改写它们会让
 * "本地提前拒绝"与"服务端裁决"给出互相矛盾的答案。
 */
/**
 * 一次**分片**发布的**总**出站预算（毫秒）。
 *
 * 为什么必须有它（独立审计 2026-09-18 P2-1）：分片链路是**多次**出站
 * （开会话 + N 片 PUT + 可能的 received[] 刷新 + complete），每条各自拿
 * {@link CLIENT_UPLOAD_TIMEOUT_MS} 的话，聚合墙钟最坏是 `5 × 90 s = 450 s`
 * —— 远超宿主工具 120 s 的 deadline。那时上游超时策略会把整条结果**替换**成
 * `tool call timed out`，`UPLOAD_INCOMPLETE` 里的 `upload_id` 一个字都送不到模型，
 * 续传路径彻底失明（本仓已有"闸门预算必须小于工具预算"的教训）。
 *
 * 取值 = {@link CLIENT_UPLOAD_TIMEOUT_MS}：分片不是"更大包的额外额度"，它只是
 * 把同一个 90 s 预算分摊到多跳上；工具预算仍严格大于它（120 s > 90 s），
 * 所以先到点的永远是这里，模型拿到的是可续传的结构化错误。
 */
export const CHUNKED_PUBLISH_BUDGET_MS = CLIENT_UPLOAD_TIMEOUT_MS

export const CLIENT_UPLOAD_LIMITS = Object.freeze({
  /** §4.2：`.wasm` 上限 32 MiB。 */
  wasmMaxBytes: WASM_MAX_BYTES,
  /** §4.2：上传请求体上限 48 MiB（base64 JSON）。 */
  uploadBodyMaxBytes: UPLOAD_BODY_MAX_BYTES,
  /** §4.2：单次上传超时 90 s（> 服务端 60 s）。 */
  clientUploadTimeoutMs: CLIENT_UPLOAD_TIMEOUT_MS,
  /** §4.2：服务端读取超时 60 s（只用于断言序关系）。 */
  serverReadTimeoutMs: SERVER_READ_TIMEOUT_MS,
  /** §4.2：分片阈值/单片上限 8 MiB。 */
  uploadChunkMaxBytes: UPLOAD_CHUNK_MAX_BYTES,
  /** limits.go：单片下限 64 KiB。 */
  uploadChunkMinBytes: UPLOAD_CHUNK_MIN_BYTES,
})

// ---------------------------------------------------------------------------
// 结构化结果（HTTP 无关：路由与宿主工具读同一套字段）
// ---------------------------------------------------------------------------

/**
 * 一次调用的**完整响应信封**。
 *
 * 为什么带 `text` 而不是解析好的对象：§8 要求服务端业务错误 `details`/`hints`
 * **原样**到达第一消费者（AI），而"解析再重新序列化"正好是丢掉它们的经典方式
 * （键序变化、`undefined` 被抹掉、非 JSON 响应被吞）。因此编排层只搬运字节，
 * 想读字段的一方自己解析（{@link parseWasmBody} / {@link errorEnvelopeOf}）。
 */
export interface WasmResponse {
  /** HTTP 状态码（上游原样，或本地错误自己的 4xx/5xx）。 */
  readonly status: number
  /** 响应体**原文**。调用方按它逐字节写出，不重新序列化。 */
  readonly text: string
  /** `Content-Type`（本地错误与解析成功都是 {@link WASM_JSON_CONTENT_TYPE}）。 */
  readonly contentType: string
}

/** 业务错误信封（服务端 §8 与本模块本地错误共用的形状）。 */
export type WasmErrorEnvelope = {
  /** 稳定的错误码（AI 按它分流：`RATE_LIMITED` / `COMPILE_BUSY` / `APP_CONFIG_INVALID` …）。 */
  code: string
  /** 给人（与 AI）看的一句话。 */
  message: string
  /**
   * 结构化明细（哪个字段、哪个符号、边界值…）。
   *
   * 类型取无损 JSON：这个信封会被宿主工具**原样**作为工具结果回给模型，而工具的输出
   * 契约就是无损 JSON（`output.schema = {type:'json'}`）—— 用 `unknown` 的话，
   * "服务端的 details 能不能直接进工具结果"就得靠一层没人看得住的断言。
   *
   * 刻意用类型别名而不是 interface：interface 没有隐式索引签名，赋不进
   * `{[key: string]: JsonValue}`。
   */
  details?: JsonValue
  /** 可直接照做的建议（第一消费者是 AI：没有 hints 它只能猜）。 */
  hints?: string[]
}

/** 本地错误信封的构造入参。 */
export interface WasmErrorOptions {
  code: string
  message: string
  status: number
  details?: JsonValue
  hints?: string[]
}

/**
 * 构造本地错误信封（**唯一实现**：路由与工具读同一套字段）。
 *
 * 键序与 `auth-gate.json()` 逐字一致（code → message → details → hints），
 * 因为路由侧的历史实现就是按这个顺序 `JSON.stringify` 的，而"逐字节不变"是
 * 这次重构的验收条件之一。
 * @param options - 错误码/文案/状态码/明细/建议。
 * @returns 结构化的响应信封。
 */
export function wasmError(options: WasmErrorOptions): WasmResponse {
  const error: Record<string, unknown> = { code: options.code, message: options.message }
  if (options.details !== undefined) error.details = options.details
  if (options.hints !== undefined && options.hints.length > 0) error.hints = options.hints
  return { status: options.status, text: JSON.stringify({ error }), contentType: WASM_JSON_CONTENT_TYPE }
}

/**
 * 解析响应体（JSON 可解析时给对象，否则 null）。
 * @param response - 编排层返回的信封。
 * @returns 解析结果或 null。
 */
export function parseWasmBody(response: WasmResponse): JsonValue | null {
  try {
    return JSON.parse(response.text) as JsonValue
  } catch {
    return null
  }
}

/**
 * 从信封里取出**业务错误**（不是业务错误时返回 null）。
 *
 * 判据有两条，缺一不可：①状态码 ≥ 400；②体是 `{error:{code,message,…}}`。
 * 只有一条成立时（网关 HTML、代理劫持、上游 200 但体畸形）返回 null —— 调用方
 * 必须把原文带出去，而不是伪造一个错误码。
 * @param response - 编排层返回的信封。
 * @returns 结构化错误，或 null。
 */
export function errorEnvelopeOf(response: WasmResponse): WasmErrorEnvelope | null {
  if (response.status < 400) return null
  const parsed = parseWasmBody(response)
  if (parsed === null || typeof parsed !== 'object') return null
  const raw = (parsed as { error?: unknown }).error
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  if (typeof record.code !== 'string' || typeof record.message !== 'string') return null
  const envelope: WasmErrorEnvelope = { code: record.code, message: record.message }
  // `record.details` 来自 `JSON.parse`：能落在 JSON 里的值就是无损 JSON（信封的形状由
  // 服务端保证），因此这一次断言是**收敛类型**，不是"放宽校验"。
  if (record.details !== undefined) envelope.details = record.details as JsonValue
  if (Array.isArray(record.hints)) {
    const hints = record.hints.filter((hint): hint is string => typeof hint === 'string')
    if (hints.length > 0) envelope.hints = hints
  }
  return envelope
}

// ---------------------------------------------------------------------------
// 装配面
// ---------------------------------------------------------------------------

/**
 * auth-gate 已有的信任原语与读写助手。
 *
 * 通过参数注入而**不是**在本模块重写一份：`guard`/`requireWriteProof` 的边界
 * （回环 socket + Host + 同源标记 + `connection.requestRejection` 的持有性证明）
 * 只允许一个实现 —— 本机任意进程伪造 Origin 就能过 `guard()`，所以"写面到底
 * 证明了什么"这件事绝不能出现两种口径（见 auth-gate 的 `proofOfPossession` 注释）。
 */
export interface WasmAppsFence {
  /** 回环 + 同源围栏（所有方法都要过）。 */
  guard(req: IncomingMessage, res: ServerResponse): boolean
  /** 写面持有性证明（GET 直接放行，非 GET 在 fence 缺席时 fail-closed 503）。 */
  requireWriteProof(req: IncomingMessage, res: ServerResponse): boolean
  /** 第二道保险：auditor 不得触发任何写面（§4.5）。 */
  writeGuard(): boolean
  /** 当前员工会话（令牌 + 服务端地址）。 */
  session(): Session | null
  /** 本地 JSON 响应（路由自己的围栏错误用它写出，与 {@link wasmError} 同字节）。 */
  json(res: ServerResponse, status: number, body: unknown): void
  /** 本地请求体收集（带上限，超限抛错）。 */
  collectBody(req: IncomingMessage, limit: number): Promise<Buffer>
  /** 宿主语言（本地文案按请求解析，禁止模块级冻结）。 */
  hostLocale(req?: IncomingMessage): HostLocale
}

/** 本模块向 `ctx.webServer.register` 交付的路由（方法分发在 handler 内）。 */
export interface WasmAppsRoute {
  kind: 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
}

/**
 * 允许读取 `wasm_path` 的根目录（会话工作区 + **数据根下的 `apps/` 子目录**）。
 *
 * **数据根根目录本身不放行**（FIX-39，2026-09-18 安全收敛）：`$DSH_HOME` 里同时住着
 * `session.json`（无 keyring 平台上的**明文员工登录令牌**，0600）与 `.credentials.yaml`
 * （含 browser-session 的签名 secret）—— 把整根当上传源等于给"页面脚本 / 被劫持的页面"
 * 开了一条"把凭据读出来发走"的路。应用数据面（`<数据根>/apps`，平台与应用自己的落点、
 * 编译缓存）本来就在那里，因此收敛后两类正当来源都还在。
 */
export interface WasmPathRoots {
  /**
   * 数据根（`$DSH_HOME`）：**只用于诊断与报错回显，不参与放行**。
   * null = 数据根不可信（`dshHomeSafe()` 拒绝）⇒ `appsRoot` 也为 null。
   */
  readonly dataRoot: string | null
  /**
   * **唯一放行的数据根子目录**：`<数据根>/apps`（平台自己的应用数据面）。
   * null = 数据根不可信 ⇒ 该根不存在（不回落任何目录）。
   */
  readonly appsRoot: string | null
  /** 会话工作区根（可能 0 个：没有任何工作区时只有 `appsRoot` 可读）。 */
  readonly workspaces: readonly string[]
}

// ---------------------------------------------------------------------------
// 纯函数（可单测，无 IO）
// ---------------------------------------------------------------------------

/** base64 编码后的字节数（不需要真的编码，用于"要不要分片"的判定）。 */
export function base64Length(bytes: number): number {
  if (bytes <= 0) return 0
  return Math.ceil(bytes / 3) * 4
}

/**
 * 规划分片：**均分**而不是"装满一片再装下一片"。
 *
 * 为什么均分：`limits.go` 的 `UploadChunkMinBytes = 64 KiB` 是服务端接受单片的
 * 下限（片数本身要有界，见 `UploadMaxChunks`）。贪心切片会留下一个远小于下限的
 * 尾片（例如 8 MiB + 3 KB），那一片会被服务端当成畸形元数据拒掉；均分保证
 * "每片 ≤ max 且 ≥ total/ceil(total/max)"，在真实触发区间（base64 > 8 MiB ⇒
 * 二进制 > 6 MiB）里每片都远大于 64 KiB。
 *
 * 确定性：同一份字节永远得到同一组边界 —— 续传时 `received[]` 的下标才有意义
 * （换一次切法就等于把已上传的片全部作废）。
 * @param total - 二进制字节数。
 * @param max - 单片上限（缺省 {@link UPLOAD_CHUNK_MAX_BYTES}）。
 * @returns 每片的 `[start, end)` 边界；空载荷返回空数组。
 */
export function planChunks(
  total: number,
  max: number = UPLOAD_CHUNK_MAX_BYTES,
): Array<{ start: number, end: number }> {
  if (total <= 0) return []
  const count = Math.max(1, Math.ceil(total / max))
  const size = Math.ceil(total / count)
  const slices: Array<{ start: number, end: number }> = []
  for (let start = 0; start < total; start += size) {
    slices.push({ start, end: Math.min(start + size, total) })
  }
  return slices
}

/**
 * 绝对化目录条目的入口链接。
 *
 * 服务端 `appOrigin()` 正常下发绝对地址；这里只处理"相对路径"这一种退化形态
 * （服务端为旧版本 / 未来改下发路径时）：按当前会话的服务端源补齐。
 * **不发明链接**：拿不到服务端地址、或字段本身为空时，保持原样（宁可不显示）。
 * @param serverURL - 当前会话的服务端地址。
 * @param value - 服务端下发的 `entry_url`。
 * @returns 绝对 URL，或原值。
 */
export function absolutizeEntryURL(serverURL: string, value: unknown): unknown {
  if (typeof value !== 'string' || value.trim() === '') return value
  const raw = value.trim()
  // 已有 scheme（含 `data:`/`mailto:` 这类非 http）一律原样返回：不猜服务端的意图。
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(raw)) return raw
  let base: URL
  try {
    base = new URL(normalizeServerURL(serverURL))
  } catch {
    return value
  }
  try {
    return new URL(raw.startsWith('/') ? raw : `/${raw}`, base.origin).toString()
  } catch {
    return value
  }
}

/** `realpath` 之后的包含判定（**不是**字符串前缀比较：`/a/bc` 不以 `/a/b` 为父）。 */
export function isInsideRoot(root: string, candidate: string): boolean {
  if (candidate === root) return true
  const rel = relative(root, candidate)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * `realpath()`，失败时回落原值（根目录不存在/不可读时仍然要能参与比对面）。
 *
 * **唯一实现**：允许面判定里有三处需要"解析根目录但别让 ENOENT 把整次调用打断"
 * —— 三处各写一遍 `try/catch` 就会漂移（其中一处忘了 catch 就会让一个不存在的
 * 根把发布打成 500）。语义与 {@link readWasmFromPath} 里对 `allowed` 的处理一致。
 * @param path - 待解析的路径。
 * @returns 解析后的真实路径，或原值。
 */
async function realpathOrSelf(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return path
  }
}

/**
 * `stat` 结果的类型名（只用于错误 `details`，让 AI 一眼看出"目录不是产物"）。
 * @param info - `fs.stat` / `FileHandle.stat` 的结果。
 * @returns `directory` / `file` / `fifo` / `socket` / `device`。
 */
export function fileKindOf(info: Pick<Stats, 'isDirectory' | 'isFile' | 'isFIFO' | 'isSocket'>): string {
  if (info.isDirectory()) return 'directory'
  if (info.isFile()) return 'file'
  if (info.isFIFO()) return 'fifo'
  if (info.isSocket()) return 'socket'
  return 'device'
}

/**
 * 解析路径里的**段**：百分号转义非法时回结构化错误，而不是让 `URIError` 抛穿
 * handler（FIX-40）。
 *
 * 为什么必须在这里兜住：上游 webserver 的兜底只发 `writeHead(400); res.end()` ——
 * **无 body**。而本模块的整个错误口径（§8）是"code/message/details/hints 原样给
 * AI"，一个空 body 等于让它完全无法判断该改什么。
 * @param rest - 去掉前缀后的路径串（未解码）。
 * @returns 解码后的段数组，或 null（含非法转义）。
 */
export function decodePathSegments(rest: string): string[] | null {
  if (rest === '') return []
  try {
    return rest.split('/').map(segment => decodeURIComponent(segment))
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 出站基础（模块级：路由与工具共用同一条链路）
// ---------------------------------------------------------------------------

/** 出站请求的初始参数。 */
interface GatewayInit {
  method?: string
  headers?: Record<string, string>
  body?: BodyInit
}

/**
 * 出站请求：**统一 90 s 预算**（§4.2）。
 *
 * 为什么不是 `fetchJSON`：它把错误压成 `ApiError(code,message)`，`details`/`hints`
 * 会在这一层丢掉（§8 明确要求原样回给 AI）；而且它的缺省 15 s 对本链路必然超时。
 * 因此这里直接拿 `Response`，由调用方按"业务错误原样透传"处理。
 *
 * `signal`（可选）来自**工具调用方**（`exec.signal`）：模型取消时立刻中断，
 * 不让一次已放弃的 32 MiB 上传继续占着连接。路由不传它（HTTP 请求的取消由
 * socket 自己表达）。
 * @param session - 员工会话（令牌 + 服务端地址）。
 * @param path - 服务端路径（含 `/api/client/v2` 前缀）。
 * @param init - method/headers/body。
 * @param timeoutMs - 单次预算（缺省 {@link CLIENT_UPLOAD_TIMEOUT_MS}）。
 * @param signal - 调用方取消信号。
 * @returns 上游响应（**不**判定 ok：业务错误要原样透传）。
 */
async function gatewayRequest(
  session: Session,
  path: string,
  init: GatewayInit = {},
  timeoutMs: number = CLIENT_UPLOAD_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, timeoutMs)
  const forward = (): void => { controller.abort() }
  signal?.addEventListener('abort', forward, { once: true })
  try {
    return await gatewayFetch(`${normalizeServerURL(session.serverURL)}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(init.headers ?? {}),
        Authorization: `Bearer ${session.token}`,
      },
      ...(init.body === undefined ? {} : { body: init.body }),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', forward)
  }
}

/**
 * 传输层失败的统一出口（`gateway error` 系文案，与既有 `/api/pico/*` 一致）。
 *
 * 业务错误**不走这里**：它们带着服务端的 code/details/hints 原样回去。
 * @param cause - `fetch` 抛出的异常。
 * @returns 502 信封（超时给 `GATEWAY_TIMEOUT`，其余给 `GATEWAY_UNAVAILABLE`）。
 */
function gatewayFailure(cause: unknown): WasmResponse {
  const detail = cause instanceof Error ? cause.message : String(cause)
  const timeout = cause instanceof Error && /abort/iu.test(cause.name + cause.message)
  return wasmError({
    code: timeout ? 'GATEWAY_TIMEOUT' : 'GATEWAY_UNAVAILABLE',
    message: `gateway error: ${detail}`,
    status: 502,
    hints: timeout
      ? [`单次上传预算 ${String(CLIENT_UPLOAD_TIMEOUT_MS / 1000)} 秒（§4.2）；大包请改用 wasm_path + 分片续传，断线后重发只会补缺失片`]
      : ['检查网络与服务端地址；网络恢复后重发同一条 publish —— 分片续传会从 received[] 之后接着传'],
  })
}

/** 上游响应 → 信封：状态码 + **原始 JSON 文本**（details/hints 一字不改）。 */
async function upstreamResponse(upstream: Response): Promise<WasmResponse> {
  const text = await upstream.text().catch(() => '')
  return {
    status: upstream.status,
    text,
    contentType: upstream.headers.get('content-type') ?? WASM_JSON_CONTENT_TYPE,
  }
}

/**
 * 透传上游响应，并在 401 时清掉本地会话（渲染层的 tripwire 会回登录页）。
 *
 * `ctx.picoSession.clear()` 放在这里而不是调用方：**每一条**出站路径都要这一条
 * （直传/分片/续传/代理），分开放迟早漏一条 —— 而漏掉的表现是"令牌过期后界面
 * 一直停在错误页"，很难与业务错误区分。
 * @param ctx - Host 上下文（只用到 `picoSession`）。
 * @param upstream - 上游响应。
 * @returns 信封。
 */
async function forwardAuthAware(ctx: Context, upstream: Response): Promise<WasmResponse> {
  if (upstream.status === 401) ctx.picoSession.clear()
  return await upstreamResponse(upstream)
}

/** 请求体 → JSON 文本（键序由调用方决定，与重构前逐字一致）。 */
function jsonBody(value: unknown): string {
  return JSON.stringify(value)
}

// ---------------------------------------------------------------------------
// 请求体读取（HTTP 无关：路由把 `collectBody` 包成回调传进来）
// ---------------------------------------------------------------------------

/** 请求体收集器（路由传 `fence.collectBody`，工具面不会用到）。 */
export type BodyCollector = (limit: number) => Promise<Buffer>

/**
 * 读本地 JSON body（带上限）；返回结构化结果而不是写 `res`。
 *
 * 上限 = 服务端请求体上限（§4.2/R21）。超限不等于"服务端会拒"：这条本地闸门
 * 只是不让一个 200 MiB 的 body 先把 Host 进程内存吃掉。
 * @param collect - 请求体收集器。
 * @param limit - 字节上限。
 * @param locale - 宿主语言（本地文案按调用解析，禁止模块级冻结）。
 * @returns 解析后的对象，或结构化错误信封。
 */
export async function readJSONObject(
  collect: BodyCollector,
  limit: number,
  locale: HostLocale,
): Promise<{ ok: true, value: Record<string, unknown> } | { ok: false, response: WasmResponse }> {
  let raw: Buffer
  try {
    raw = await collect(limit)
  } catch {
    return {
      ok: false,
      response: wasmError({
        code: 'UPLOAD_TOO_LARGE',
        message: hostCopy(locale, 'publish 请求体超过上限', 'the publish request body exceeds the size limit'),
        status: 413,
        details: { limit_bytes: limit },
        hints: [
          `§4.2 上限 ${String(limit / (1024 * 1024))} MiB（base64 JSON）；与服务端 limits.go 同源`,
          '大载荷改用 wasm_path（本地绝对路径）：绕开 base64 的 33% 膨胀，客户端自动分片续传',
        ],
      }),
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.toString('utf8'))
  } catch {
    parsed = undefined
  }
  if (parsed === null || parsed === undefined || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      response: wasmError({
        code: 'INVALID_JSON',
        message: hostCopy(locale, 'publish 请求体不是合法 JSON 对象', 'the publish request body is not a JSON object'),
        status: 400,
      }),
    }
  }
  return { ok: true, value: parsed as Record<string, unknown> }
}

// ---------------------------------------------------------------------------
// wasm 来源（二选一：base64 文本 / 本地绝对路径）
// ---------------------------------------------------------------------------

/**
 * wasm 字节的来源。
 *
 * `path` 是 AI 与 UI 的主路径（省掉 base64 的 33% 膨胀与 48 MiB 请求体上限），
 * `base64` 保留给"调用方已经持有 base64"的场景（HTTP 请求体）。
 */
export type WasmSource =
  | { readonly kind: 'base64', readonly value: string }
  | { readonly kind: 'path', readonly value: string }

/** {@link resolveWasmSource} 的结果。 */
export type WasmBytesResult =
  | { ok: true, bytes: Buffer }
  | { ok: false, response: WasmResponse }

/**
 * 解析 wasm 来源（`wasm_base64` 或 `wasm_path`，二选一）。
 * @param ctx - Host 上下文（`wasm_path` 要读工作区注册表）。
 * @param source - 来源。
 * @param locale - 宿主语言。
 * @returns 字节，或结构化错误。
 */
export async function resolveWasmSource(
  ctx: Context,
  source: WasmSource,
  locale: HostLocale,
): Promise<WasmBytesResult> {
  if (source.kind === 'base64') {
    const inline = source.value
    let bytes: Buffer
    try {
      bytes = Buffer.from(inline, 'base64')
    } catch {
      return {
        ok: false,
        response: wasmError({
          code: 'WASM_SOURCE_INVALID',
          message: hostCopy(locale, 'wasm_base64 不是合法 base64', 'wasm_base64 is not valid base64'),
          status: 400,
        }),
      }
    }
    // Buffer.from 对非法 base64 是"尽力解码"（遇到非法字符就截断）而不是抛错，
    // 于是半个模块会被送到服务端，换回一个指向编译器的误导性错误。这里按
    // 字母表 + 长度双重判定：不合法就当输入错误拒掉（本地拒，不浪费一次编译）。
    const normalized = inline.replace(/\s+/gu, '')
    if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(normalized) || normalized.length % 4 !== 0
      || base64Length(bytes.byteLength) !== normalized.length) {
      return {
        ok: false,
        response: wasmError({
          code: 'WASM_SOURCE_INVALID',
          message: hostCopy(locale, 'wasm_base64 长度与 base64 规则不符', 'wasm_base64 length does not match base64 encoding'),
          status: 400,
        }),
      }
    }
    return { ok: true, bytes }
  }
  return await readWasmFromPath(ctx, source.value, locale)
}

/**
 * 读取 wasm 来源（供调用方在出站前拿到字节；`publishPathOf` 之外的入口也用它）。
 *
 * 越界一律 400 并把原因写清（"哪条根、解析后的真实路径"），因为这第一消费者是
 * AI：模糊的"路径非法"会让它反复重试同一个值。
 *
 * 顺序有意：先 `realpath`（消掉 symlink）再判包含 —— 只做字符串前缀比较的话，
 * 工作区里的一个软链就能读到任意文件。
 *
 * **数据根根目录不放行**：`$DSH_HOME` 下有 `session.json`（无 keyring 平台上的
 * 明文员工令牌）与 `.credentials.yaml`（browser-session 签名 secret）；把它们
 * 当上传源等于给页面脚本开一条"读凭据 → 发走"的路。应用数据面在 `<数据根>/apps`，
 * 正当来源一个不少。
 *
 * 读取前必须确认是**普通文件**（FIX-41）：目录 / 设备 / 管道在 `readFile()` 上抛
 * 裸异常，向上兜底会退化成无 body 的 400。
 * @param ctx - Host 上下文。
 * @param requested - 调用方给出的路径（必须绝对）。
 * @param locale - 宿主语言。
 * @returns 字节，或结构化错误。
 */
export async function readWasmFromPath(
  ctx: Context,
  requested: string,
  locale: HostLocale,
): Promise<WasmBytesResult> {
  if (!isAbsolute(requested)) {
    return {
      ok: false,
      response: wasmError({
        code: 'WASM_PATH_NOT_ABSOLUTE',
        message: hostCopy(locale, 'wasm_path 必须是绝对路径', 'wasm_path must be an absolute path'),
        status: 400,
        details: { wasm_path: requested },
        hints: ['用会话工作区内的绝对路径，例如 /workspace/app/main.wasm'],
      }),
    }
  }
  const roots = await readRoots(ctx)
  // **允许面 = 会话工作区 + `<数据根>/apps`**：数据根根目录（含 session.json /
  // .credentials.yaml 这些凭据文件）不参与放行 —— 见 {@link WasmPathRoots}。
  const allowed = [roots.appsRoot, ...roots.workspaces].filter((root): root is string => root !== null)
  let resolved: string
  try {
    resolved = await realpath(requested)
  } catch {
    return {
      ok: false,
      response: wasmError({
        code: 'WASM_PATH_NOT_FOUND',
        message: hostCopy(locale, 'wasm_path 指向的文件不可读', 'the file named by wasm_path is not readable'),
        status: 400,
        details: { wasm_path: requested },
        hints: ['先确认本机编译产物已落盘（skill 的黄金路径第 4 步）'],
      }),
    }
  }
  const realRoots = await Promise.all(allowed.map(async root => await realpathOrSelf(root)))
  if (!realRoots.some(root => isInsideRoot(root, resolved))) {
    return {
      ok: false,
      response: wasmError({
        code: 'WASM_PATH_OUTSIDE_ALLOWED_ROOTS',
        message: hostCopy(
          locale,
          'wasm_path 超出允许的读取面（会话工作区 / 数据根的 apps 目录）',
          'wasm_path is outside the allowed read roots (session workspace / the data root apps directory)',
        ),
        status: 400,
        // 只回根目录与解析后的路径，不回文件内容；根目录对调用方本就是已知信息。
        details: { wasm_path: requested, resolved, allowed_roots: realRoots },
        hints: [
          '把产物编译到会话工作区内再发布（skill 硬约束第 9 条：编译器状态目录也要落在工作区）',
          `数据根只有 apps 子目录是上传源${roots.dataRoot === null ? '' : `（${roots.dataRoot}/apps）`}；数据根根目录（含登录令牌与凭据文件）一律不放行`,
          '不要把 $HOME / 系统目录当作发布源',
        ],
      }),
    }
  }
  // **数据根子树整体否决**（独立审计 2026-09-18 P1-1）：上面那条"包含"判定只保证
  // 落点在某条允许根内，而 `dataRoot` 自己的那一层（`session.json` 明文员工令牌、
  // `.credentials.yaml`、`data/master.key`）从来不是合法上传源。只做包含判定时，
  // 只要**工作区等于数据根 / 是它的祖先 / 是指向它的软链**（用户完全可以把家目录
  // 选成工作区），凭据就落进了允许面 —— 与 FIX-39 的安全意图直接冲突。
  // `appsRoot` 是数据根下**唯一**放行的子目录，所以这里的否决要把它排除在外。
  if (roots.dataRoot !== null) {
    const realDataRoot = await realpathOrSelf(roots.dataRoot)
    const realAppsRoot = roots.appsRoot === null ? null : await realpathOrSelf(roots.appsRoot)
    const insideDataRoot = isInsideRoot(realDataRoot, resolved)
    const insideAppsRoot = realAppsRoot !== null && isInsideRoot(realAppsRoot, resolved)
    if (insideDataRoot && !insideAppsRoot) {
      return {
        ok: false,
        response: wasmError({
          code: 'WASM_PATH_OUTSIDE_ALLOWED_ROOTS',
          message: hostCopy(
            locale,
            'wasm_path 落在数据根里但不是 apps 子目录：平台数据根只放行 apps/ 作为上传源',
            'wasm_path is inside the data root but not under apps/: only apps/ is an allowed upload source',
          ),
          status: 400,
          details: { wasm_path: requested, resolved, data_root: realDataRoot, apps_root: realAppsRoot },
          hints: [
            '把产物编译到会话工作区，或放到数据根的 apps/ 下；数据根根目录（含登录令牌与凭据文件）一律不放行',
            '如果工作区就是数据根（或它的上级 / 软链），换个工作区目录再发布',
          ],
        }),
      }
    }
  }
  // 必须是**普通文件**：目录 / 设备 / 管道在 `readFile()` 上会抛 EISDIR/ENXIO 之类的
  // 裸异常，向上兜底会退化成"无 body 的 400"（AI 拿不到 code/hints 只能瞎猜）。
  // AI 最可能的误用之一就是把目录当产物路径（FIX-41）。
  let info: Stats
  try {
    info = await stat(resolved)
  } catch {
    return {
      ok: false,
      response: wasmError({
        code: 'WASM_PATH_NOT_FOUND',
        message: hostCopy(locale, 'wasm_path 指向的文件不可读', 'the file named by wasm_path is not readable'),
        status: 400,
        details: { wasm_path: requested },
      }),
    }
  }
  if (!info.isFile()) {
    return {
      ok: false,
      response: wasmError({
        code: 'WASM_PATH_NOT_A_FILE',
        message: hostCopy(
          locale,
          'wasm_path 指向的不是普通文件',
          'wasm_path does not point at a regular file',
        ),
        status: 400,
        details: { wasm_path: requested, resolved, kind: fileKindOf(info) },
        hints: [
          'wasm_path 要填**编译产物文件**（例如 <工作区>/main.wasm），不是它所在的目录',
          '目录 / 设备 / 管道都不接受：客户端只上传单个 .wasm 文件',
        ],
      }),
    }
  }
  const size = info.size
  if (size > WASM_MAX_BYTES) {
    return {
      ok: false,
      response: wasmError({
        code: 'UPLOAD_TOO_LARGE',
        message: hostCopy(locale, 'wasm 体积超过上限', 'the wasm payload exceeds the size limit'),
        status: 413,
        details: { size_bytes: size, limit_bytes: WASM_MAX_BYTES },
        hints: [`§4.2 上限 ${String(WASM_MAX_BYTES / (1024 * 1024))} MiB；与服务端 limits.go 同源`],
      }),
    }
  }
  // 从 fd 读（先 fstat 再读），避免 stat→read 之间被换成一个巨大的文件。
  let handle: FileHandle
  try {
    handle = await open(resolved, 'r')
  } catch {
    return {
      ok: false,
      response: wasmError({
        code: 'WASM_PATH_NOT_FOUND',
        message: hostCopy(locale, 'wasm_path 指向的文件不可读', 'the file named by wasm_path is not readable'),
        status: 400,
        details: { wasm_path: requested },
      }),
    }
  }
  try {
    const fdInfo = await handle.stat()
    if (!fdInfo.isFile()) {
      return {
        ok: false,
        response: wasmError({
          code: 'WASM_PATH_NOT_A_FILE',
          message: hostCopy(locale, 'wasm_path 指向的不是普通文件', 'wasm_path does not point at a regular file'),
          status: 400,
          details: { wasm_path: requested, resolved, kind: fileKindOf(fdInfo) },
          hints: ['wasm_path 要填编译产物文件，不是目录'],
        }),
      }
    }
    if (fdInfo.size > WASM_MAX_BYTES) {
      return {
        ok: false,
        response: wasmError({
          code: 'UPLOAD_TOO_LARGE',
          message: hostCopy(locale, 'wasm 体积超过上限', 'the wasm payload exceeds the size limit'),
          status: 413,
          details: { size_bytes: fdInfo.size, limit_bytes: WASM_MAX_BYTES },
        }),
      }
    }
    return { ok: true, bytes: await handle.readFile() }
  } catch (cause) {
    // 兜住"读的那一瞬间文件被换掉/被删"这类竞态：绝不让裸异常穿过 handler
    // （退化成无 body 的 400 会让 AI 完全无法自修）。
    return {
      ok: false,
      response: wasmError({
        code: 'WASM_PATH_UNREADABLE',
        message: hostCopy(locale, 'wasm_path 读取失败', 'reading the file named by wasm_path failed'),
        status: 400,
        details: { wasm_path: requested, resolved, cause: cause instanceof Error ? cause.message : String(cause) },
        hints: ['重新编译产物后重发；分片续传只补缺失片，不会从头再来'],
      }),
    }
  } finally {
    await handle.close()
  }
}

// ---------------------------------------------------------------------------
// 发布编排（§4.2 的客户端契约）
// ---------------------------------------------------------------------------

/**
 * 一次发布的入参（HTTP 无关：路由从请求体构造，宿主工具从工具参数构造）。
 *
 * `version` 有意保留**原样**（不 trim）：重构前的直传路径就是把 `body.version`
 * 原样放进载荷的，trim 只发生在"分片开会话"那一处（服务端与路径的一致性由
 * 服务端裁决）。改掉它属于行为变更，不在这次"只换调用形态"的范围里。
 */
export interface PublishInput {
  /** 应用标识（`app_id`）。 */
  appId: string
  /** 版本号（原样：直传路径不 trim，分片开会话时 trim）。 */
  version: string
  /** 应用标题（首版必填；缺省不带该键，服务端沿用现有标题）。 */
  title?: unknown
  /** 更新说明（非首版必填）。 */
  changelog?: unknown
  /** `picoaide.app.json` 的配置对象（字段由服务端 appcfg 裁决）。 */
  config?: unknown
  /** 续传用的分片会话 id（缺省=新开一次上传会话）。 */
  uploadId?: string
  /** wasm 来源。 */
  wasm: WasmSource
  /** 宿主语言（本地文案）。 */
  locale: HostLocale
  /** 调用方取消信号（宿主工具的 `exec.signal`；路由不传）。 */
  signal?: AbortSignal
}

/** {@link publishInputOf} 的结果。 */
export type PublishInputResult =
  | { ok: true, input: PublishInput }
  | { ok: false, response: WasmResponse }

/**
 * 从已解析的请求体构造 {@link PublishInput}（缺 `app_id`/`version` ⇒ 结构化 400）。
 *
 * 路由与工具共用：**字段级校验只允许一份实现**，否则"路由拒了工具放过"这种
 * 分叉会直接变成"AI 以为能发、实际发不出去"。
 * @param body - 已解析的请求体。
 * @param locale - 宿主语言。
 * @returns 入参，或结构化错误。
 */
export function publishInputOf(body: Record<string, unknown>, locale: HostLocale): PublishInputResult {
  const appID = typeof body.app_id === 'string' ? body.app_id.trim() : ''
  if (appID === '') {
    return {
      ok: false,
      response: wasmError({
        code: 'MISSING_FIELD',
        message: hostCopy(locale, '缺少 app_id', 'app_id is required'),
        status: 400,
        hints: ['app_id 既是应用标识也是域名标签（§4.1）'],
      }),
    }
  }
  if (typeof body.version !== 'string' || body.version.trim() === '') {
    return {
      ok: false,
      response: wasmError({
        code: 'MISSING_FIELD',
        message: hostCopy(locale, '缺少 version', 'version is required'),
        status: 400,
      }),
    }
  }
  const uploadId = typeof body.upload_id === 'string' && body.upload_id.trim() !== ''
    ? body.upload_id.trim()
    : undefined
  const inline = typeof body.wasm_base64 === 'string' ? body.wasm_base64 : ''
  const rawPath = typeof body.wasm_path === 'string' ? body.wasm_path.trim() : ''
  let wasm: WasmSource | null = null
  if (inline.trim() !== '') wasm = { kind: 'base64', value: inline }
  else if (rawPath !== '') wasm = { kind: 'path', value: rawPath }
  if (wasm === null) {
    // 与重构前逐字一致：两个来源都缺席时 `resolveWasmBytes` 给出的信封。
    return {
      ok: false,
      response: wasmError({
        code: 'MISSING_FIELD',
        message: hostCopy(locale, 'wasm_base64 与 wasm_path 必须二选一', 'exactly one of wasm_base64 or wasm_path is required'),
        status: 400,
        hints: [
          '大文件（>8 MiB）推荐 wasm_path：本地绝对路径，省掉 base64 的 33% 膨胀与 48 MiB 请求体上限',
          '客户端不做编译（R40/R42）：产物由 skill/AI 在本机编译（GOOS=wasip1 GOARCH=wasm）',
        ],
      }),
    }
  }
  const version = body.version
  const input: PublishInput = {
    appId: appID,
    version,
    wasm,
    locale,
    // `title`/`changelog`/`config` **原样搬运**（不 trim、不做类型转换）：类型与合法性
    // 由服务端裁决，客户端改写调用方给的值只会让"两边看到的载荷不一样"。
    ...(body.title === undefined ? {} : { title: body.title }),
    ...(body.changelog === undefined ? {} : { changelog: body.changelog }),
    ...(body.config === undefined ? {} : { config: body.config }),
    ...(uploadId === undefined ? {} : { uploadId }),
  }
  return { ok: true, input }
}

/**
 * 发布一个版本（**唯一编排实现**：路由与 `wasm_app_publish` 工具共用）。
 *
 * 顺序与重构前逐字一致：解析来源 → 分片判定（阈值 = **base64 之后**的长度，
 * §4.2 原话「>8 MiB 走分片 + 续传」）→ 直传或分片。
 * @param ctx - Host 上下文（401 清会话、`wasm_path` 读取面）。
 * @param session - 员工会话。
 * @param input - 发布入参。
 * @returns 信封（成功=上游原文，失败=业务信封或本地信封）。
 */
export async function publishApp(ctx: Context, session: Session, input: PublishInput): Promise<WasmResponse> {
  const resolved = await resolveWasmSource(ctx, input.wasm, input.locale)
  if (!resolved.ok) return resolved.response
  const bytes = resolved.bytes
  if (base64Length(bytes.byteLength) > UPLOAD_CHUNK_MAX_BYTES) {
    return await publishChunked(ctx, session, input, bytes)
  }
  const inline = input.wasm.kind === 'base64' ? input.wasm.value.trim() : ''
  return await publishInline(ctx, session, input, inline !== '' ? inline : bytes.toString('base64'))
}

/** 单次直传：`POST :app_id/releases`（含 wasm_base64）。 */
async function publishInline(
  ctx: Context,
  session: Session,
  input: PublishInput,
  wasmBase64: string,
): Promise<WasmResponse> {
  const payload: Record<string, unknown> = { app_id: input.appId, version: input.version }
  if (input.title !== undefined) payload.title = input.title
  if (input.changelog !== undefined) payload.changelog = input.changelog
  if (input.config !== undefined) payload.config = input.config
  payload.wasm_base64 = wasmBase64
  let upstream: Response
  try {
    upstream = await gatewayRequest(
      session,
      `/api/client/v2/apps/wasm/${encodeURIComponent(input.appId)}/releases`,
      { method: 'POST', body: jsonBody(payload) },
      CLIENT_UPLOAD_TIMEOUT_MS,
      input.signal,
    )
  } catch (cause) {
    return gatewayFailure(cause)
  }
  return await forwardAuthAware(ctx, upstream)
}

/** 从上游错误响应里取出可读文本（分片失败时用于回给调用方）。 */
async function readUpstreamError(upstream: Response): Promise<{ status: number, text: string }> {
  return { status: upstream.status, text: await upstream.text().catch(() => '') }
}

/**
 * 分片上传（§4.2：>8 MiB 自动切分 + 续传）。
 *
 * **契约逐字对齐服务端** `server/internal/wasmapp/api/upload.go`（FIX-43：以前这里是
 * 客户端单方面假定的 `{app_id,size,chunks}`，与服务端 `uploadCreateRequest` 对不上，
 * 真实服务端会直接 400）：
 * ```
 * POST /uploads                      {app_id,version,total_bytes,chunk_bytes}
 *                                    -> 201 {upload_id,received[],chunk_bytes,expires_at}
 * PUT  /uploads/:id/chunks/:index    application/octet-stream -> 200 {received,received_bytes}
 * GET  /uploads/:id                                            -> 200 {received,received_bytes,total_bytes,expires_at}
 * POST /uploads/:id/complete         {title,changelog,config}  -> 201（不带 app_id/version/wasm_base64）
 * ```
 * 锚点（改服务端契约时这段与 `tests/wasm-apps.spec.ts` 的契约用例一起红）：
 * upload.go:97-102（`uploadCreateRequest`）、:140-145（201 体）、:186-189（PUT 200 体）、
 * :272-277（GET 200 体）、:328/334-353（complete 只读 title/changelog/config）、
 * :381-401（`checkCompletePayload`：complete 带 wasm_base64 即拒；app_id/version 与会话
 * 定死，`app_id`/`version` **取会话元数据**而不是请求体）。
 *
 * **续传语义**：每次重试前先 `GET` 一次 `received[]`，只补缺失片 —— 断线后重发
 * 同一条 publish 不会从头再来（带 `upload_id` 可以跨请求续传）。
 * @param ctx - Host 上下文。
 * @param session - 员工会话。
 * @param input - 发布入参。
 * @param bytes - 已解析的模块字节。
 * @returns 信封。
 */
async function publishChunked(
  ctx: Context,
  session: Session,
  input: PublishInput,
  bytes: Buffer,
): Promise<WasmResponse> {
  const locale = input.locale
  const slices = planChunks(bytes.byteLength)
  const base = '/api/client/v2/apps/wasm/uploads'
  // 整条链路共用一个 deadline（见 {@link CHUNKED_PUBLISH_BUDGET_MS}）：每次出站
  // 只用**剩余额度**，所以无论分几片、重试几轮，聚合墙钟都不超过总预算 ——
  // 到点后走下面的 `UPLOAD_INCOMPLETE` 分支，把 upload_id 交给模型续传。
  const deadline = Date.now() + CHUNKED_PUBLISH_BUDGET_MS
  /** 剩余额度（毫秒，可为负）。 */
  const budgetLeft = (): number => deadline - Date.now()
  /**
   * 单次出站的预算：剩余额度，初值下界 1 s。
   *
   * 下界不是"放宽"：调用点前面已经用 {@link budgetLeft} 判过是否还有额度，
   * 这里只为避免把 0/负数传给 `gatewayRequest`（那是"立即超时"还是"不限时"
   * 取决于实现，两种都不想要）。
   */
  const perCallBudget = (): number => Math.max(1_000, budgetLeft())
  // 服务端开会话时要的是**切分大小**（不是片数）：均分后的单片字节数。
  // `planChunks` 保证每片都 ∈ [64 KiB, 8 MiB]（见 planChunks 注释与 §10.5 第 58 项），
  // 因此这个声明值天然落在服务端 `Create` 的合法区间里。
  const declaredChunkBytes = slices.length > 0 ? slices[0]!.end - slices[0]!.start : 0
  let uploadId = input.uploadId ?? ''
  let received = new Set<number>()
  // 传输层失败（网络中断 / 出站超时）：发生在**会话已开之后**时，这次调用的正确结论
  // 不是"网关挂了"，而是"可续传" —— 见下面 UPLOAD_INCOMPLETE 分支。
  let transportFailure: WasmResponse | null = null

  const parseReceived = (payload: unknown): Set<number> => {
    const source = (payload ?? {}) as Record<string, unknown>
    const list = Array.isArray(source.received)
      ? source.received
      : Array.isArray(source.received_chunks) ? source.received_chunks : []
    const set = new Set<number>()
    for (const value of list) {
      const n = typeof value === 'number' ? value : Number(value)
      if (Number.isInteger(n) && n >= 0 && n < slices.length) set.add(n)
    }
    return set
  }

  /**
   * 刷新已收片。
   *
   * 三态而不是"信封或 null"（独立验证 2026-09-18 P2-1）：
   *   - `ok` —— 拿到了最新的 `received[]`；
   *   - `response` —— 服务端的**业务**错误（如会话过期/被回收），原样回给调用方；
   *   - `transport` —— 传输层失败，已记进 {@link transportFailure}，调用方应当**落到
   *     `UPLOAD_INCOMPLETE` 分支**：会话还在，`upload_id` 必须送到模型手里；回一个笼统的
   *     网关信封会让续传路径失明（那正是 P2-1 要修的东西）。
   */
  const refreshReceived = async (): Promise<
    { kind: 'ok' } | { kind: 'response', response: WasmResponse } | { kind: 'transport' }
  > => {
    let upstream: Response
    try {
      upstream = await gatewayRequest(
        session,
        `${base}/${encodeURIComponent(uploadId)}`,
        {},
        perCallBudget(),
        input.signal,
      )
    } catch (cause) {
      transportFailure = gatewayFailure(cause)
      return { kind: 'transport' }
    }
    if (!upstream.ok) {
      // 会话过期/被回收：把服务端的原话回给调用方（它可能带 RETRY 类 hints）。
      return { kind: 'response', response: await forwardAuthAware(ctx, upstream) }
    }
    received = parseReceived(await upstream.json().catch(() => null))
    return { kind: 'ok' }
  }

  if (uploadId === '') {
    let upstream: Response
    try {
      upstream = await gatewayRequest(session, base, {
        method: 'POST',
        // 字段名与顺序逐字对齐服务端 `uploadCreateRequest`（upload.go:97-102）：
        // `total_bytes` 必须**恰好等于各片之和**（upload/upload.go:903-912），
        // `chunk_bytes` 必须 ∈ [64 KiB, 8 MiB]（upload/upload.go:479-487）。
        // 我们声明的是**均分后的单片大小**，这样 `ceil(total_bytes/chunk_bytes)`
        // 恰好等于我们实际发出的片数（服务端用它算片序号上界）。
        body: jsonBody({
          app_id: input.appId,
          version: input.version.trim(),
          total_bytes: bytes.byteLength,
          chunk_bytes: declaredChunkBytes,
        }),
      }, perCallBudget(), input.signal)
    } catch (cause) {
      return gatewayFailure(cause)
    }
    if (!upstream.ok) return await forwardAuthAware(ctx, upstream)
    const opened = (await upstream.json().catch(() => null)) as Record<string, unknown> | null
    const id = opened?.upload_id ?? opened?.id
    if (typeof id !== 'string' || id.trim() === '') {
      return wasmError({
        code: 'UPLOAD_SESSION_INVALID',
        message: hostCopy(locale, '分片上传会话未返回 upload_id', 'the upload session response carried no upload_id'),
        status: 502,
        details: { response_keys: opened === null ? [] : Object.keys(opened) },
        hints: ['服务端 /apps/wasm/uploads 契约变更；按 §4.2 的 upload_id 字段返回'],
      })
    }
    uploadId = id
    received = parseReceived(opened)
  } else {
    const refreshed = await refreshReceived()
    if (refreshed.kind === 'response') return refreshed.response
    // `transport` ⇒ 不早退：落到下面的 UPLOAD_INCOMPLETE（upload_id 已在手，可续传）。
  }

  /** 单次 PUT；返回 null 表示成功，否则返回要处理的失败形态。 */
  const putChunk = async (
    index: number,
  ): Promise<{ kind: 'upstream', status: number, text: string } | { kind: 'gateway', response: WasmResponse } | null> => {
    const { start, end } = slices[index]!
    let upstream: Response
    try {
      upstream = await gatewayRequest(session, `${base}/${encodeURIComponent(uploadId)}/chunks/${String(index)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(bytes.subarray(start, end)),
      }, perCallBudget(), input.signal)
    } catch (cause) {
      return { kind: 'gateway', response: gatewayFailure(cause) }
    }
    if (upstream.ok || upstream.status === 204) return null
    const detail = await readUpstreamError(upstream)
    if (upstream.status === 401) ctx.picoSession.clear()
    return { kind: 'upstream', status: detail.status, text: detail.text }
  }

  // 每片最多尝试 3 次；两次尝试之间先刷新 received[]（断线续传的核心）。
  const MAX_ATTEMPTS_PER_CHUNK = 3
  let lastError: { status: number, text: string } | null = null
  for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_CHUNK; attempt += 1) {
    // 总预算耗尽：不再开新一轮（开了也只会被上游超时策略整条替换掉，
    // 模型反而拿不到 upload_id）。直接落到 UPLOAD_INCOMPLETE。
    if (budgetLeft() <= 0) break
    const missing = slices.map((_, index) => index).filter(index => !received.has(index))
    if (missing.length === 0) break
    for (const index of missing) {
      const outcome = await putChunk(index)
      if (outcome === null) {
        received.add(index)
        continue
      }
      // 传输层失败 ⇒ 记下来，落到 UPLOAD_INCOMPLETE 分支。
      //
      // 重构前这里是"先写一次 502 再继续重试、最后又写一次 UPLOAD_INCOMPLETE"——
      // 第二次写永远到不了线上（Node 在 headers 已发后 `writeHead` 抛
      // ERR_HTTP_HEADERS_SENT），调用方实际收到的就是这一份网关信封。这里仍然
      // **只写一次**，但写的是更有用的那一次：会话已经开好、片也收了一部分，
      // 这条调用是可续传的，`upload_id` 必须送到模型手里（独立审计 2026-09-18
      // P2-1：原先回笼统的 GATEWAY_TIMEOUT ⇒ 模型丢掉 upload_id、只能从头再来，
      // 而从头再来往往撞上同一堵墙）。网关信封本身仍原样出现在 details 里。
      if (outcome.kind === 'gateway') {
        transportFailure = outcome.response
        break
      }
      lastError = { status: outcome.status, text: outcome.text }
      break
    }
    if (slices.every((_, index) => received.has(index))) break
    // 传输层失败的**重试取舍**（独立验证 2026-09-18 P2-1 修正）：
    //   - **快速**失败（ECONNRESET / DNS 抖动 / TLS 重置）几乎不消耗预算 ⇒ 保留本轮重试
    //     是免费的（下一次尝试只会用剩余额度），无条件退出等于把可自愈的抖动变成
    //     "必须让模型再发一次调用"；
    //   - **超时**类失败本身就把预算耗到 ≤ 0 ⇒ 下一轮开头 `budgetLeft() <= 0` 自然退出；
    //   - 预算已耗尽 ⇒ 退出。
    // 三条一起保证"聚合墙钟有界"这条不变量不变（见 CHUNKED_PUBLISH_BUDGET_MS）。
    if (transportFailure !== null && (budgetLeft() <= 0 || isTimeoutEnvelope(transportFailure))) break
    if (attempt + 1 < MAX_ATTEMPTS_PER_CHUNK) {
      const refreshed = await refreshReceived()
      if (refreshed.kind === 'response') return refreshed.response
      // 连"查已收片"都传输失败 ⇒ 网络确实断了，落 UPLOAD_INCOMPLETE（带 upload_id）。
      if (refreshed.kind === 'transport') break
    }
  }

  if (!slices.every((_, index) => received.has(index))) {
    const error = lastError
    // 传输层失败的**业务 code**（`GATEWAY_TIMEOUT` / `GATEWAY_UNAVAILABLE`）原样
    // 带进 details：模型据此区分"网络/超时"与"服务端拒了某一片"，但结论都是
    // 同一句可执行的话 —— 带同一个 upload_id 重发。
    const transport = transportFailure === null ? null : errorEnvelopeOf(transportFailure)
    return wasmError({
      code: 'UPLOAD_INCOMPLETE',
      message: hostCopy(
        locale,
        `分片上传未完成（已收到 ${String(received.size)}/${String(slices.length)} 片）`,
        `chunked upload incomplete (${String(received.size)}/${String(slices.length)} chunks received)`,
      ),
      status: transportFailure?.status ?? error?.status ?? 502,
      details: {
        upload_id: uploadId,
        received: [...received].sort((a, b) => a - b),
        chunks: slices.length,
        upstream: error?.text ?? null,
        ...(transport === null ? {} : { transport_code: transport.code, transport_message: transport.message }),
      },
      hints: [
        '带同一个 upload_id 重发 publish：续传只会补缺失片（会话 TTL 内有效）',
        ...(transport === null
          ? []
          : [`这一跳是传输失败（${transport.code}）：网络恢复后用**同一个** upload_id 重发即可，不要重开会话`]),
        'upstream 字段是服务端的原话（含它自己的 code/hints）',
      ],
    })
  }

  let upstream: Response
  try {
    upstream = await gatewayRequest(session, `${base}/${encodeURIComponent(uploadId)}/complete`, {
      method: 'POST',
      // 服务端 complete 只接受 `{title,changelog,config}`（upload.go:328 的
      // `uploadPayload` + :381-401 的 checkCompletePayload）：`app_id`/`version`
      // 在开会话时已经定死、从**会话元数据**取；带上它们只多一个可能与元数据
      // 不一致的自由度（带 `wasm_base64` 则直接被拒）。因此这里**只**发这三个字段。
      body: jsonBody(completeManifestOf(input)),
    }, perCallBudget(), input.signal)
  } catch (cause) {
    return gatewayFailure(cause)
  }
  return await forwardAuthAware(ctx, upstream)
}

/**
 * 该信封是不是**超时类**传输失败（`GATEWAY_TIMEOUT`）。
 *
 * 用于分片链路的重试取舍：超时会把单次预算耗到 ≤0，靠预算判定即可退出；
 * 快速失败（连接重置等）则值得再用剩余额度试一次（独立验证 2026-09-18 P2-1）。
 * @param response - 传输失败信封。
 * @returns 是超时类为 true。
 */
function isTimeoutEnvelope(response: WasmResponse): boolean {
  return errorEnvelopeOf(response)?.code === 'GATEWAY_TIMEOUT'
}

/**
 * 分片链路 `complete` 的请求体：**只有** `title` / `changelog` / `config`。
 *
 * 与服务端 `checkCompletePayload`（upload.go:381-401）同一口径：`app_id`/`version`
 * 在开会话时已定死并取会话元数据，`wasm_base64` 出现即拒（模块字节来自分片）。
 * @param input - 发布入参。
 * @returns complete 的请求体。
 */
function completeManifestOf(input: PublishInput): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (input.title !== undefined) out.title = input.title
  if (input.changelog !== undefined) out.changelog = input.changelog
  if (input.config !== undefined) out.config = input.config
  return out
}

// ---------------------------------------------------------------------------
// 预检（validate）
// ---------------------------------------------------------------------------

/** 一次预检的入参。 */
export interface ValidateInput {
  /** 应用标识（`app_id`）。 */
  appId: string
  /** wasm 来源。 */
  wasm: WasmSource
  /** 版本号（可选：validate 不占号，服务端允许缺省）。 */
  version?: string
  /** 应用标题（可选）。 */
  title?: string
  /** 更新说明（可选）。 */
  changelog?: string
  /** 应用配置（可选；带上它会一起校验，首版声明缺失/access 取值错都能在这里发现）。 */
  config?: unknown
  /** 宿主语言。 */
  locale: HostLocale
  /** 调用方取消信号。 */
  signal?: AbortSignal
}

/**
 * 预检一个产物（`POST /api/client/v2/apps/wasm/validate`）。
 *
 * 与本地路由的 `/validate` 分支同一个出站实现，但它**多走一步**：把
 * `wasm_path` 读成字节并按服务端载荷字段拼装 —— 因为工具面的调用方给的是本地
 * 路径，而路由的 `/validate` 是"调用方自带 base64"的原样透传（`proxyApp`）。
 * 两者共用 {@link resolveWasmSource} 的读取面校验（FIX-39/FIX-41）与
 * {@link gatewayRequest} 的 90 s 预算，不存在第二条上传链路。
 * @param ctx - Host 上下文。
 * @param session - 员工会话。
 * @param input - 预检入参。
 * @returns 信封（200 = `{validation:{…}}`）。
 */
export async function validateApp(ctx: Context, session: Session, input: ValidateInput): Promise<WasmResponse> {
  const resolved = await resolveWasmSource(ctx, input.wasm, input.locale)
  if (!resolved.ok) return resolved.response
  const payload: Record<string, unknown> = { app_id: input.appId }
  if (input.version !== undefined) payload.version = input.version
  if (input.title !== undefined) payload.title = input.title
  if (input.changelog !== undefined) payload.changelog = input.changelog
  if (input.config !== undefined) payload.config = input.config
  payload.wasm_base64 = resolved.bytes.toString('base64')
  let upstream: Response
  try {
    upstream = await gatewayRequest(
      session,
      '/api/client/v2/apps/wasm/validate',
      { method: 'POST', body: jsonBody(payload) },
      CLIENT_UPLOAD_TIMEOUT_MS,
      input.signal,
    )
  } catch (cause) {
    return gatewayFailure(cause)
  }
  return await forwardAuthAware(ctx, upstream)
}

// ---------------------------------------------------------------------------
// 目录（R34/R38）
// ---------------------------------------------------------------------------

/**
 * `GET /api/client/v2/apps/wasm/catalog`：代理服务端目录并绝对化入口链接。
 *
 * 展示范围完全由服务端裁决（R38：**客户端不自己过滤** —— 这里再筛一次就会产生
 * "两份可见性规则"，而两份规则迟早给出不同答案）。本函数只做地址补全。
 * R36：目录**不得**出现额度/用量字段 —— 客户端也不去补，只原样转发服务端给的字段。
 * @param ctx - Host 上下文（401 时要清本地会话）。
 * @param session - 员工会话。
 * @param signal - 调用方取消信号（宿主工具的 `exec.signal`；路由不传）。
 * @returns 信封（成功 = 绝对化后的目录 JSON）。
 */
export async function listCatalog(ctx: Context, session: Session, signal?: AbortSignal): Promise<WasmResponse> {
  let upstream: Response
  try {
    upstream = await gatewayRequest(session, '/api/client/v2/apps/wasm/catalog', {}, CLIENT_UPLOAD_TIMEOUT_MS, signal)
  } catch (cause) {
    return gatewayFailure(cause)
  }
  if (!upstream.ok) return await forwardAuthAware(ctx, upstream)
  const text = await upstream.text().catch(() => '')
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    // 服务端返回的不是 JSON（门户 HTML / 代理劫持）⇒ 原样透传，让上层看见真实字节。
    return {
      status: upstream.status,
      text,
      contentType: upstream.headers.get('content-type') ?? WASM_JSON_CONTENT_TYPE,
    }
  }
  const apps = (payload as { apps?: unknown }).apps
  if (Array.isArray(apps)) {
    for (const row of apps) {
      if (row === null || typeof row !== 'object') continue
      const entry = row as Record<string, unknown>
      if ('entry_url' in entry) entry.entry_url = absolutizeEntryURL(session.serverURL, entry.entry_url)
    }
  }
  return { status: upstream.status, text: JSON.stringify(payload), contentType: WASM_JSON_CONTENT_TYPE }
}

// ---------------------------------------------------------------------------
// 代理面（生命周期 / 只读 / 删除）
// ---------------------------------------------------------------------------

/** 一次原样转发的入参。 */
export interface ProxyInput {
  /** 上游路径（含 `/api/client/v2` 前缀与已编码的 app_id）。 */
  upstreamPath: string
  /** HTTP 方法（原样转发）。 */
  method: string
  /** 原始请求体；undefined = 无 body（GET/DELETE）。 */
  body?: BodyInit
  /** 宿主语言。 */
  locale: HostLocale
  /** 调用方取消信号。 */
  signal?: AbortSignal
}

/**
 * 原样转发（method + body + content-type 全部保持）。
 * @param ctx - Host 上下文。
 * @param session - 员工会话。
 * @param input - 转发入参。
 * @returns 信封。
 */
export async function proxyApp(ctx: Context, session: Session, input: ProxyInput): Promise<WasmResponse> {
  let upstream: Response
  try {
    upstream = await gatewayRequest(session, input.upstreamPath, {
      method: input.method,
      // 只在真的有 body 时声明 Content-Type（GET/DELETE 带一个空 JSON 头对严格
      // 上游是噪音；`gatewayRequest` 本身也只在有 body 时才补缺省头）。
      ...(input.body === undefined
        ? {}
        : { headers: { 'Content-Type': 'application/json' }, body: input.body }),
    }, CLIENT_UPLOAD_TIMEOUT_MS, input.signal)
  } catch (cause) {
    return gatewayFailure(cause)
  }
  return await forwardAuthAware(ctx, upstream)
}

// ---------------------------------------------------------------------------
// 路由（薄壳：解析请求 → 调编排 → 写响应）
// ---------------------------------------------------------------------------

/**
 * 构造 `/api/pico/apps/wasm` 的本地路由。
 *
 * 方法分发全部在**一个 handler** 内（路由表没有 per-method 匹配，与
 * `/api/pico/skills` 一致）：
 *
 * | method | path | 语义 |
 * |---|---|---|
 * | GET | `/` | 应用中心目录（代理 `catalog` + 绝对化 `entry_url`） |
 * | POST | `/validate` | 预检代理（AI/UI 用来"不占版本号地试一发"） |
 * | POST | `/publish` | **发布编排**：`wasm_base64`/`wasm_path` → 直传或分片续传 |
 * | POST | `/:app_id/publish\|unpublish\|freeze` | 生命周期代理（原样转发 body） |
 * | GET | `/:app_id/diagnostics\|schema\|export` | 只读代理 |
 * | DELETE | `/:app_id` | 删除代理（R37 冻结→导出→真删） |
 *
 * 这个函数只做**四件 HTTP 层的事**：围栏（guard/持有性证明/auditor）、路径分发、
 * 请求体收集、把编排返回的信封逐字节写出。业务编排一律在模块级函数里
 * （见文件头"一份编排，两个调用面"）。
 * @param ctx - Host 上下文（只用到 `picoSession` 与 `logger`）。
 * @param fence - auth-gate 的信任原语与助手。
 * @returns 交给 `ctx.webServer.register` 的前缀路由。
 */
export function createWasmAppsRoute(ctx: Context, fence: WasmAppsFence): WasmAppsRoute {
  /** 把编排/围栏的信封按原样写出（状态码 + Content-Type + 原始字节）。 */
  const write = (res: ServerResponse, response: WasmResponse): void => {
    res.writeHead(response.status, { 'Content-Type': response.contentType })
    res.end(response.text)
  }

  /** 路由自己（围栏/分发层）的错误：走 fence.json，与 `wasmError` 逐字节同形。 */
  const fail = (res: ServerResponse, options: WasmErrorOptions): void => {
    const error: Record<string, unknown> = { code: options.code, message: options.message }
    if (options.details !== undefined) error.details = options.details
    if (options.hints !== undefined && options.hints.length > 0) error.hints = options.hints
    fence.json(res, options.status, { error })
  }

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!fence.guard(req, res)) return
    // 写面持有性证明：GET 自动放行（只读不改盘、不换会话），其余 fail-closed。
    if (!fence.requireWriteProof(req, res)) return
    const session = fence.session()
    if (session === null) {
      return fail(res, {
        code: 'AUTH_REQUIRED',
        message: hostCopy(fence.hostLocale(req), '未登录', 'not logged in'),
        status: 401,
      })
    }
    if (req.method !== 'GET' && !fence.writeGuard()) {
      return fail(res, {
        code: 'FORBIDDEN',
        message: hostCopy(fence.hostLocale(req), '审计账号不能修改应用', 'audit accounts cannot modify apps'),
        status: 403,
      })
    }

    let pathname: string
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    } catch {
      return fail(res, { code: 'NOT_FOUND', message: 'not found', status: 404 })
    }
    // 前缀路由会把 `/api/pico/apps/wasmx` 这类**同前缀但不同路径**也送进来：
    // 必须按段边界判定，否则 `/wasmfoo` 会被当成 `:app_id` 而回 405（误导）。
    if (pathname !== WASM_APPS_PREFIX && !pathname.startsWith(`${WASM_APPS_PREFIX}/`)) {
      return fail(res, { code: 'NOT_FOUND', message: 'not found', status: 404 })
    }
    const rest = pathname.slice(WASM_APPS_PREFIX.length).replace(/^\/+/u, '').replace(/\/+$/u, '')
    // FIX-40：`decodeURIComponent('%zz')` 抛 `URIError`。以前它抛穿 handler，
    // 被上游兜底成**无 body 的 400** —— AI 与 UI 都拿不到 code/hints。
    const segments = decodePathSegments(rest)
    if (segments === null) {
      return fail(res, {
        code: 'INVALID_PATH',
        message: hostCopy(fence.hostLocale(req), '路径里含非法百分号转义', 'the path contains an invalid percent escape'),
        status: 400,
        details: { path: pathname },
        hints: [
          '路径段必须是合法 URI 编码（例如 app_id 里的空格写成 %20）；%zz / %E0%A4%A / 单独的 % 都是畸形转义',
          'app_id 只用 [a-z0-9-]：大多数情况下根本不需要百分号编码',
        ],
      })
    }
    const method = req.method ?? 'GET'
    const locale = fence.hostLocale(req)

    /** 收集原始请求体（`undefined` = 无 body）。 */
    const collect = async (): Promise<{ ok: true, raw: Buffer } | { ok: false, response: WasmResponse }> => {
      try {
        return { ok: true, raw: await fence.collectBody(req, UPLOAD_BODY_MAX_BYTES) }
      } catch {
        return {
          ok: false,
          response: wasmError({
            code: 'UPLOAD_TOO_LARGE',
            message: hostCopy(locale, '请求体超过上限', 'the request body exceeds the size limit'),
            status: 413,
            details: { limit_bytes: UPLOAD_BODY_MAX_BYTES },
          }),
        }
      }
    }

    // GET /            → 应用中心目录
    if (segments.length === 0) {
      if (method !== 'GET') return fail(res, { code: 'METHOD_NOT_ALLOWED', message: 'method not allowed', status: 405 })
      return write(res, await listCatalog(ctx, session))
    }
    // POST /validate   → 预检代理（原样转发请求体：调用方自带 wasm_base64）
    if (segments.length === 1 && segments[0] === 'validate') {
      if (method !== 'POST') return fail(res, { code: 'METHOD_NOT_ALLOWED', message: 'method not allowed', status: 405 })
      const body = await collect()
      if (!body.ok) return write(res, body.response)
      return write(res, await proxyApp(ctx, session, {
        upstreamPath: '/api/client/v2/apps/wasm/validate',
        method: 'POST',
        body: new Uint8Array(body.raw),
        locale,
      }))
    }
    // POST /publish    → 发布编排（解析请求体 → 共享编排 → 写响应）
    if (segments.length === 1 && segments[0] === 'publish') {
      if (method !== 'POST') return fail(res, { code: 'METHOD_NOT_ALLOWED', message: 'method not allowed', status: 405 })
      const read = await readJSONObject(limit => fence.collectBody(req, limit), UPLOAD_BODY_MAX_BYTES, locale)
      if (!read.ok) return write(res, read.response)
      const built = publishInputOf(read.value, locale)
      if (!built.ok) return write(res, built.response)
      return write(res, await publishApp(ctx, session, built.input))
    }

    const appID = segments[0] ?? ''
    if (appID === '') return fail(res, { code: 'NOT_FOUND', message: 'not found', status: 404 })
    const appPath = `/api/client/v2/apps/wasm/${encodeURIComponent(appID)}`

    // POST /:app_id/(publish|unpublish|freeze) —— 生命周期（body 原样转发）
    if (segments.length === 2 && ['publish', 'unpublish', 'freeze'].includes(segments[1] ?? '')) {
      if (method !== 'POST') return fail(res, { code: 'METHOD_NOT_ALLOWED', message: 'method not allowed', status: 405 })
      const body = await collect()
      if (!body.ok) return write(res, body.response)
      return write(res, await proxyApp(ctx, session, {
        upstreamPath: `${appPath}/${segments[1]!}`,
        method: 'POST',
        body: new Uint8Array(body.raw),
        locale,
      }))
    }
    // GET /:app_id/(diagnostics|schema|export) —— 只读
    if (segments.length === 2 && ['diagnostics', 'schema', 'export'].includes(segments[1] ?? '')) {
      if (method !== 'GET') return fail(res, { code: 'METHOD_NOT_ALLOWED', message: 'method not allowed', status: 405 })
      return write(res, await proxyApp(ctx, session, {
        upstreamPath: `${appPath}/${segments[1]!}`,
        method: 'GET',
        locale,
      }))
    }
    // DELETE /:app_id
    if (segments.length === 1) {
      if (method !== 'DELETE') return fail(res, { code: 'METHOD_NOT_ALLOWED', message: 'method not allowed', status: 405 })
      return write(res, await proxyApp(ctx, session, { upstreamPath: appPath, method: 'DELETE', locale }))
    }
    return fail(res, { code: 'NOT_FOUND', message: 'not found', status: 404 })
  }

  return { kind: 'prefix', path: WASM_APPS_PREFIX, handler: handle }
}

/**
 * 解析允许读取 `wasm_path` 的根目录。
 *
 * 两条根，都是"这个进程有权读、且用户本来就能写"的位置：
 *  - **`<数据根>/apps`**：`$DSH_HOME/apps` 是平台自己的应用数据面（应用库、编译缓存、
 *    上传暂存都在这棵树里）。**只有这个子目录放行** —— 数据根根目录住着 `session.json`
 *    （无 keyring 平台上的明文员工令牌）与 `.credentials.yaml`（browser-session 签名
 *    secret），把整根当上传源等于给页面脚本开一条"读凭据 → 发走"的路（FIX-39）；
 *  - **会话工作区**：`ctx.workspaceRegistry` 的登记项（Host 侧权威）。服务缺席
 *    （最小组合/测试）时退化为"只有 `<数据根>/apps`"，而不是放行任意路径。
 *
 * 结构类型而不是 import：workspace 服务由上游提供，本包不需要为它增加依赖
 * （与 cron 处理 `sessions`/`permissionPresets` 同款做法）。
 * @param ctx - Host 上下文。
 * @returns 数据根（仅诊断）+ 放行的 `apps` 子目录 + 全部已登记工作区根。
 */
export async function readRoots(ctx: Context): Promise<WasmPathRoots> {
  let dataRoot: string | null
  try {
    dataRoot = dshHomeSafe()
  } catch {
    // DSH_HOME 指向系统关键目录（dshHomeSafe 会抛）⇒ **不把任何目录**当数据根。
    // 此时若连工作区也没有，`wasm_path` 一律被拒（fail-closed），
    // 而不是回落到 cwd 这种"看起来能用"的放开。
    dataRoot = null
  }
  const appsRoot = dataRoot === null ? null : join(dataRoot, 'apps')
  const registry = (ctx as unknown as {
    get?: (name: string) => unknown
  }).get?.('workspaceRegistry') as { list?: () => Array<{ path?: unknown }> } | undefined
  const workspaces: string[] = []
  try {
    const listed = registry?.list?.() ?? []
    for (const item of listed) {
      const path = item?.path
      if (typeof path === 'string' && path.trim() !== '') workspaces.push(path)
    }
  } catch {
    // 注册表尚未就绪：只保留 <数据根>/apps（fail-closed，不放行任意路径）。
  }
  return { dataRoot, appsRoot, workspaces }
}
