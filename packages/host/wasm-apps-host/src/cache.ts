/**
 * 本机应用内容缓存（契约 §7.5 + §5.1b；台账 DAT-10/DAT-11/DAT-12、R1-SEC-3/SEC-4、R2C-3）。
 *
 * 它**拥有**什么：
 *  - 落盘布局 `<root>/<serverHash>/<userHash>/<appId>/<version>/<pathHash>.{json,bin}`，
 *    即键 = `session-scope + app_id + version + path`（§7.5「冻结」）；
 *  - 逐条写入策略（`no-store` / 非 2xx / 超容量）、LRU 淘汰、目录权限 0700、
 *    原子替换（临时文件 + `rename`）；
 *  - 「仅静态子资源可被本地直出短路」的判定（{@link WasmAppsCache.isStaticSubresource}）
 *    与缓存命中时的**宿主安全头重写**（{@link securityHeaders}）。
 *
 * 它**不拥有**什么（刻意不做，避免成为第二真源）：
 *  - 不解析应用 URL、不判准入/下架/冻结、不认识员工令牌 —— 那些在 handler 与平台侧；
 *  - **不推断版本**：`version` 只能来自平台响应的 `X-PicoAide-App-Version` 头（§5.1，
 *    DAT-12/CLI-3），缓存只把调用方给的版本当键；版本变化 = 另一个键，旧版本自然读不到；
 *  - 不算 `session-scope` 哈希：调用方给 `serverHash`/`userHash`（R1-SEC-3 的双作用域
 *    语义在调用方成立），缓存只保证**不同 scope 绝不互相命中**；
 *  - 不实现 HTTP 缓存语义的协商（`If-Modified-Since` 等）：{@link WasmAppsCache.conditional}
 *    只做 ETag 严格相等这一条，其余一律回源（R2C-3）。
 *
 * 依赖全部注入（`root`/`now`/`warn`），且只用 `node:fs/promises` + `node:crypto` ⇒
 * 不 import electron、可在纯 Node 下单测。任何**读**路径失败（缺失/损坏/权限）一律
 * 当 miss + 一条 warn，绝不抛给调用方：缓存损坏不得让应用打不开。
 *
 * 与 Chromium 自身 HTTP 缓存的取舍（§7.5）：以本缓存为唯一权威，应用协议页面的
 * 分区 HTTP 缓存不参与决策。
 *
 * @module @picoaide/dsh-wasm-apps-host/cache
 */

import { createHash, randomBytes } from 'node:crypto'
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'

/** 缓存容量缺省上限：256 MiB（§7.5）。 */
export const CACHE_DEFAULT_MAX_BYTES = 256 * 1024 * 1024

/**
 * 缓存目录权限：0700（§7.5）。
 *
 * 同一台机器上可能有别的本地账户 —— 缓存里装着员工的业务页面，目录必须私有。
 */
export const CACHE_DIR_MODE = 0o700

/** 写入缓存（{@link CacheEntryInput.headers}）时保留的宿主无关头白名单 */
const CACHEABLE_HEADERS = new Set([
  'etag',
  'cache-control',
  'content-type',
  'content-language',
  'last-modified',
  'vary',
])

/**
 * 绝不进缓存的头。
 *
 * 安全头按 §7.5/R1-SEC-4 在**读**的时候由 {@link securityHeaders} 重写，缓存里留着
 * 旧一份没有意义（还会在下一次安全策略收紧后继续生效）；`content-length` 必须丢，
 * body 在缓存里是原始字节、长度以文件为准。
 */
const UNCACHEABLE_HEADERS = new Set([
  'content-length',
  'transfer-encoding',
  'content-encoding',
  'connection',
  'set-cookie',
  'content-security-policy',
  'content-security-policy-report-only',
  'x-content-type-options',
  'x-frame-options',
  'referrer-policy',
  'strict-transport-security',
])

/** 静态子资源扩展名白名单（§7.5「仅静态子资源」）。 */
const STATIC_EXTENSIONS = new Set([
  'css',
  'js',
  'mjs',
  'cjs',
  'map',
  'json',
  'wasm',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'avif',
  'ico',
  'bmp',
  'svg',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'eot',
  'mp3',
  'mp4',
  'webm',
  'ogg',
  'wav',
  'txt',
  'xml',
  'csv',
  'pdf',
])

/** 文档导航的 `Content-Type`（这类响应背后可能是准入/下架页，必须回源）。 */
const HTML_CONTENT_TYPE = 'text/html'

/** 单个作用域/应用/版本目录名的长度上限（防构造出的超长键把路径撑爆）。 */
const MAX_SEGMENT_LENGTH = 128

/** 扫描缓存占用时跳过的写入中间态文件后缀（`<uuid>.tmp`）。 */
const TEMP_SUFFIX = '.tmp'


/** 缓存构造参数（全部可注入，便于单测与宿主装配）。 */
export interface WasmAppsCacheOptions {
  /** 缓存根目录（宿主给 `<userData>/wasm-apps-cache`）。 */
  root: string
  /** 容量上限（字节）；缺省 {@link CACHE_DEFAULT_MAX_BYTES}。 */
  maxBytes?: number
  /** 可注入时钟（毫秒）；缺省 `Date.now`。 */
  now?: () => number
  /** 诊断出口（缺省丢弃）。 */
  warn?: (message: string) => void
}

/**
 * 会话作用域（§7.5 R1-SEC-3「冻结」）：`<serverURL 哈希> + <用户名哈希>`。
 *
 * 两段都必须由调用方算好；**跨服务端与跨账号都不许命中彼此的缓存**（同一台机器换
 * 账号登录读到上一个人的应用页面 = 数据泄漏）。
 */
export interface CacheScope {
  serverHash: string
  userHash: string
}

/** 一次写入请求（handler 从平台响应投影而来）。 */
export interface CacheEntryInput {
  appId: string
  /** **只来自** `X-PicoAide-App-Version` 响应头；缓存不推断版本。 */
  version: string
  /** 应用 URL 的 path + query（调用方已规范化的形态），是缓存键的一部分。 */
  path: string
  body: Uint8Array
  /** 只保留 {@link CACHEABLE_HEADERS} 白名单里的头。 */
  headers: Record<string, string>
  status: number
}

/** 缓存命中时交回调用方的响应（`headers` 已叠加当前宿主安全头）。 */
export interface CachedResponse {
  status: number
  headers: Record<string, string>
  body: Uint8Array
}

/** 本地短路判定：`'miss'` = 必须回源。 */
export type CacheConditionalResult = { status: 304 } | 'miss'

/**
 * 当前宿主安全头（§7.5/R1-SEC-4）。
 *
 * 每次调用重新构造（调用方改了返回值不影响下一次），且**只在读出时叠加**：
 * 缓存的字节里不存宿主安全头，所以哪怕历史版本把旧 CSP 写进过缓存，读出时也一定
 * 是当前这一份。
 *
 * 这里**不放 `Cache-Control`**：资源级缓存语义属于平台响应，`securityHeaders()` 若
 * 自带 `no-store`，宿主一旦把安全头并进条目再 `put`，这条响应就会被自己的
 * {@link WasmAppsCache.put} 当成平台 `no-store` 而永不缓存（本文件的回归用例钉住了
 * 这个边界）。「本地已有副本、别再让 Chromium 存一份」由宿主在直出时决定。
 */
export function securityHeaders(): Record<string, string> {
  return {
    'Content-Security-Policy': [
      "default-src 'self'",
      // 渠道化（CHN-3/UX-2 同类）：**不得**出现任何写死的 scheme 字面量。在应用
      // origin 下 `'self'` 就解析成该应用自己的 origin（= 协议 handler），语义与
      // "允许应用页 fetch 自己的 handler" 等价，同时仍然禁止对外的 XHR/fetch。
      "connect-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "media-src 'self' data: blob:",
      "worker-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  }
}

/** 小写化 + 去空白后的头名；畸形值（非字符串）返回空串（= 丢弃）。 */
function headerName(input: string): string {
  return typeof input === 'string' ? input.trim().toLowerCase() : ''
}

/** 取头值（大小写不敏感）；缺席/空串返回 undefined。 */
function headerValue(headers: Record<string, string>, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (headerName(key) !== name) continue
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
  }
  return undefined
}

/** `Cache-Control` 里是否含 `no-store` 指令（按逗号/分号切指令，大小写不敏感）。 */
function hasNoStore(headers: Record<string, string>): boolean {
  const value = headerValue(headers, 'cache-control')
  if (value === undefined) return false
  return value
    .split(/[,;]/)
    .map((directive) => directive.trim().toLowerCase())
    .some((directive) => directive === 'no-store')
}

/** 规范化 path：去首尾空白（缓存键是字符串键，不解析 URL —— 那是 app-protocol 的事）。 */
function normalizePath(path: string): string {
  return path.trim()
}

/** 目录/文件名安全段：非空、限长、不含分隔符与点前缀（`.`/`..` 一律拒绝）。 */
function safeSegment(segment: string): string | null {
  const value = segment.trim()
  if (value.length === 0 || value.length > MAX_SEGMENT_LENGTH) return null
  if (value.startsWith('.')) return null
  if (/[/\\\0]/.test(value)) return null
  return value
}

/** 键段 → 目录名（sha256，落盘不含原文 ⇒ 文件系统里看不到账号/应用名）。 */
function segmentHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/** 判定扩展名是否在静态资源白名单内。 */
function isStaticExtension(extension: string): boolean {
  return STATIC_EXTENSIONS.has(extension.toLowerCase())
}

/** 一个待淘汰的文件（淘汰以「记录」为单位聚合，见 {@link WasmAppsCache}）。 */
interface CacheFile {
  path: string
  name: string
  bytes: number
  mtimeMs: number
}

/** 递归收集缓存占用（跳过写入中间态 `*.tmp`）。 */
async function collectFiles(directory: string, out: CacheFile[]): Promise<void> {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    // 目录消失（并发 clearApp/clearAll）⇒ 它的占用就是 0，不是错误。
    return
  }
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      await collectFiles(path, out)
      continue
    }
    if (!entry.isFile()) continue
    if (entry.name.endsWith(TEMP_SUFFIX)) continue
    try {
      const info = await stat(path)
      out.push({ path, name: entry.name, bytes: info.size, mtimeMs: Number(info.mtimeMs) })
    } catch {
      // 读不到就当它不存在（同一轮里可能刚被别的清理删掉）。
    }
  }
}

/** 同名的另一半（`.json` ⇄ `.bin`）。 */
function siblingPath(path: string): string {
  return path.endsWith('.json')
    ? `${path.slice(0, -'.json'.length)}.bin`
    : `${path.slice(0, -'.bin'.length)}.json`
}

/** 文件名是否属于成对的一条记录。 */
function isPairFile(name: string): boolean {
  return name.endsWith('.json') || name.endsWith('.bin')
}

/** 原子替换：临时文件（同一目录，保证 `rename` 不跨设备）→ `rename` 覆盖目标。 */
async function replaceFile(path: string, data: Uint8Array | string): Promise<void> {
  const temp = `${path}.${randomBytes(8).toString('hex')}${TEMP_SUFFIX}`
  try {
    await writeFile(temp, data)
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

/** 创建一个 0700 的目录（递归）。 */
async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: CACHE_DIR_MODE })
}

/**
 * 本机应用内容缓存。
 *
 * 并发语义：本类不做跨进程/跨实例加锁 —— 单写者（宿主）内的并发写最坏结果是
 * 互相淘汰，不会让读路径看到半条记录（先写 body、再 `rename` meta，meta 才是
 * 「这条记录存在」的提交点）。
 */
export class WasmAppsCache {
  readonly #root: string
  readonly #maxBytes: number
  readonly #now: () => number
  readonly #warn: (message: string) => void

  constructor(options: WasmAppsCacheOptions) {
    this.#root = options.root
    this.#maxBytes = options.maxBytes ?? CACHE_DEFAULT_MAX_BYTES
    this.#now = options.now ?? Date.now
    this.#warn = options.warn ?? (() => undefined)
  }

  /** 缓存根目录（宿主诊断用）。 */
  get root(): string {
    return this.#root
  }

  /**
   * 读缓存；未命中/失效/属于别的 scope ⇒ `null`。
   *
   * 命中时刷新 mtime（LRU 的「最近使用」）并叠加当前宿主安全头。
   */
  async get(
    scope: CacheScope,
    appId: string,
    version: string,
    path: string,
  ): Promise<CachedResponse | null> {
    const entry = await this.#read(scope, appId, version, path)
    if (entry === null) return null
    // 命中即「最近使用」（best-effort：刷新失败不影响返回内容）。
    await utimes(entry.bodyPath, new Date(this.#now()), new Date(this.#now())).catch(() => undefined)
    return {
      status: entry.meta.status,
      headers: { ...securityHeaders(), ...entry.meta.headers },
      body: entry.body,
    }
  }

  /** 写缓存；`no-store` / 非 2xx / 超容量策略在这里判定。 */
  async put(scope: CacheScope, entry: CacheEntryInput): Promise<void> {
    const body = entry.body instanceof Uint8Array ? entry.body : new Uint8Array(entry.body)
    if (hasNoStore(entry.headers)) {
      this.#warn(`wasm-apps-cache: 跳过 no-store 响应（${describe(scope, entry.appId, entry.version, entry.path)}）`)
      return
    }
    if (!(entry.status >= 200 && entry.status < 300)) {
      this.#warn(`wasm-apps-cache: 跳过非 2xx 响应（status=${entry.status}，${describe(scope, entry.appId, entry.version, entry.path)}）`)
      return
    }
    if (body.byteLength > this.#maxBytes) {
      this.#warn(`wasm-apps-cache: 跳过超容量响应（${body.byteLength} > ${this.#maxBytes}）`)
      return
    }
    const files = this.#files(scope, entry.appId, entry.version, entry.path)
    if (files === null) {
      this.#warn(`wasm-apps-cache: 键形态非法，拒绝落盘（${describe(scope, entry.appId, entry.version, entry.path)}）`)
      return
    }
    try {
      await ensureDir(files.dir)
      // 先 body 后 meta：meta 的 rename 是这一条记录的提交点，读路径看不到半条。
      await replaceFile(files.body, body)
      await replaceFile(files.meta, JSON.stringify(metaOf(entry)))
      await utimes(files.meta, new Date(this.#now()), new Date(this.#now())).catch(() => undefined)
      await this.#evict(files.meta)
    } catch (error) {
      // 缓存写失败不是应用的错：记 warning 并放行（下一次读就是 miss）。
      this.#warn(`wasm-apps-cache: 写入失败（${String(error)}）`)
    }
  }

  /**
   * 本地 304 判定（§7.5 DAT-11/R2C-3）：**只有静态子资源**且 ETag 严格一致才返回
   * `{status:304}` 语义；其余（文档导航、`/api/*`、无缓存、ETag 不一致）一律
   * `'miss'` = 回源。
   *
   * 这是「本地缓存不得成为绕过准入/下架/吊销的第二入口」的唯一实现点。
   */
  async conditional(
    scope: CacheScope,
    appId: string,
    version: string,
    path: string,
    ifNoneMatch: string | undefined,
  ): Promise<CacheConditionalResult> {
    if (ifNoneMatch === undefined) return 'miss'
    if (!this.isStaticSubresource(path, {})) return 'miss'
    const entry = await this.#read(scope, appId, version, path)
    if (entry === null) return 'miss'
    const etag = headerValue(entry.meta.headers, 'etag')
    if (etag === undefined) return 'miss'
    if (normalizeETag(etag) !== normalizeETag(ifNoneMatch)) return 'miss'
    await utimes(entry.bodyPath, new Date(this.#now()), new Date(this.#now())).catch(() => undefined)
    return { status: 304 }
  }

  /**
   * `changed=true`（§5.1b open 端点）⇒ 清掉该应用在**当前 scope** 下的全部版本缓存。
   *
   * 只删 `<root>/<serverHash>/<userHash>/<appId>`：其它 scope（别的账号/别的服务端）
   * 与别的应用一律不动。
   */
  async clearApp(scope: CacheScope, appId: string): Promise<void> {
    const server = safeSegment(scope.serverHash)
    const user = safeSegment(scope.userHash)
    const app = safeSegment(appId)
    if (server === null || user === null || app === null) return
    await rm(join(this.#root, segmentHash(server), segmentHash(user), segmentHash(app)), {
      recursive: true,
      force: true,
    }).catch((error: unknown) => this.#warn(`wasm-apps-cache: 清理应用缓存失败（${String(error)}）`))
  }

  /** 登出/切账号/切渠道 ⇒ 清空整个缓存根（并保证根目录仍以 0700 存在）。 */
  async clearAll(): Promise<void> {
    try {
      await rm(this.#root, { recursive: true, force: true })
      await ensureDir(this.#root)
    } catch (error) {
      this.#warn(`wasm-apps-cache: 清空缓存失败（${String(error)}）`)
    }
  }

  /**
   * 仅静态子资源可被 304/本地直出短路（§7.5 冻结）。
   *
   * `false` 的三种情形：`/api/*`（一律回源，否则本地缓存成了 API 的第二入口）、
   * 文档导航（`Accept: text/html` 的请求或 `Content-Type: text/html` 的响应 ——
   * 背后可能是准入/下架页）、既没有静态扩展名也不是静态 `Content-Type` 的路径。
   */
  isStaticSubresource(path: string, headers: Record<string, string>): boolean {
    const raw = typeof path === 'string' ? path.trim() : ''
    if (raw.length === 0) return false
    // 只取 path 段判形态：query 里的 `.html`/`.js` 不改变资源类型。
    const pathname = raw.split(/[?#]/, 1)[0] ?? ''
    if (pathname.length === 0) return false
    if (pathname === '/api' || pathname.startsWith('/api/')) return false

    const accept = headerValue(headers, 'accept')
    const contentType = headerValue(headers, 'content-type')
    // 文档导航：只要有一侧声明 HTML 就不许短路（含 `*/*` 与 `text/html` 并存的浏览器导航）。
    if (accept !== undefined && accept.toLowerCase().includes(HTML_CONTENT_TYPE)) return false
    if (contentType !== undefined && contentType.toLowerCase().includes(HTML_CONTENT_TYPE)) return false

    const last = pathname.split('/').filter((segment) => segment.length > 0).pop()
    if (last === undefined) return true
    const dot = last.lastIndexOf('.')
    if (dot > 0 && dot < last.length - 1 && isStaticExtension(last.slice(dot + 1))) return true
    if (contentType !== undefined) {
      const mime = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? ''
      if (mime.startsWith('image/') || mime.startsWith('font/') || mime.startsWith('audio/') || mime.startsWith('video/')) return true
      if (mime === 'application/wasm' || mime === 'application/javascript' || mime === 'text/javascript') return true
      if (mime === 'application/json' || mime === 'text/css') return true
    }
    return false
  }

  /** 键 → 落盘路径（含键合法性判定；非法 ⇒ `null`）。 */
  #files(
    scope: CacheScope,
    appId: string,
    version: string,
    path: string,
  ): { dir: string, meta: string, body: string } | null {
    const server = safeSegment(scope.serverHash)
    const user = safeSegment(scope.userHash)
    const app = safeSegment(appId)
    const release = safeSegment(version)
    const target = normalizePath(path)
    if (server === null || user === null || app === null || release === null) return null
    if (target.length === 0) return null
    const dir = join(
      this.#root,
      segmentHash(server),
      segmentHash(user),
      segmentHash(app),
      segmentHash(release),
    )
    const file = segmentHash(target)
    return { dir, meta: join(dir, `${file}.json`), body: join(dir, `${file}.bin`) }
  }

  /** 读一条记录（缺 meta / 缺 body / 损坏 ⇒ `null` + warn）。 */
  async #read(
    scope: CacheScope,
    appId: string,
    version: string,
    path: string,
  ): Promise<{ meta: CacheMeta, body: Uint8Array, bodyPath: string } | null> {
    const files = this.#files(scope, appId, version, path)
    if (files === null) return null
    let raw: string
    try {
      raw = await readFile(files.meta, 'utf8')
    } catch {
      // 未命中（ENOENT）是最常见路径，不打 warning。
      return null
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      this.#warn(`wasm-apps-cache: 元数据不是合法 JSON，按 miss 处理（${files.meta}，${String(error)}）`)
      return null
    }
    const meta = readMeta(parsed)
    if (meta === null) {
      this.#warn(`wasm-apps-cache: 元数据缺字段，按 miss 处理（${files.meta}）`)
      return null
    }
    let body: Uint8Array
    try {
      body = await readFile(files.body)
    } catch (error) {
      this.#warn(`wasm-apps-cache: 响应体读不到，按 miss 处理（${files.body}，${String(error)}）`)
      return null
    }
    return { meta, body, bodyPath: files.body }
  }

  /**
   * 超容量 ⇒ 按 mtime 从最旧开始淘汰，直到放得下（或只剩刚写的那一条）。
   *
   * 淘汰单位是**一条记录**：只删 meta 会把 `.bin` 留成看不见的永久占用，只删 body
   * 会留下一条读不出来的 meta（两者都踩过）。同一条记录内的文件一起收集、一起删、
   * 一起计费 —— 判新旧用 meta/body 的较新 mtime（写入与命中都会刷新 body）。
   */
  async #evict(keep: string): Promise<void> {
    const files: CacheFile[] = []
    await collectFiles(this.#root, files)
    let total = files.reduce((sum, file) => sum + file.bytes, 0)
    if (total <= this.#maxBytes) return

    // 分组：成对文件归到同一组（键 = 记录标识），其它文件各自成组。
    const groups = new Map<string, CacheFile[]>()
    for (const file of files) {
      const key = isPairFile(file.name) ? siblingPath(file.path) : file.path
      const group = groups.get(key)
      if (group === undefined) groups.set(key, [file])
      else group.push(file)
    }
    const ordered = [...groups.entries()]
      .map(([key, group]) => ({
        key,
        group,
        bytes: group.reduce((sum, file) => sum + file.bytes, 0),
        mtimeMs: Math.max(...group.map((file) => file.mtimeMs)),
      }))
      .sort((left, right) => left.mtimeMs - right.mtimeMs || left.key.localeCompare(right.key))

    for (const candidate of ordered) {
      if (total <= this.#maxBytes) break
      // 刚写的那一条永不淘汰：它的 body 是 `keep` 的兄弟文件（否则超限的单条响应
      // 会先把缓存清空、再因为超限不落盘，等于白白丢光别人的缓存）。
      if (candidate.group.some((file) => file.path === keep || file.path === siblingPath(keep))) continue
      for (const file of candidate.group) {
        const removed = await rm(file.path, { force: true }).then(() => true, () => false)
        if (removed) total -= file.bytes
      }
    }
    if (total > this.#maxBytes) {
      this.#warn(`wasm-apps-cache: 淘汰后仍超容量（${total} > ${this.#maxBytes}）`)
    }
  }
}

/** 落盘元数据（响应体在旁边的 `.bin` 里）。 */
interface CacheMeta {
  status: number
  headers: Record<string, string>
}

/** 写入前把元数据投影成落盘形态。 */
function metaOf(entry: CacheEntryInput): CacheMeta {
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(entry.headers)) {
    const name = headerName(key)
    if (name.length === 0) continue
    if (UNCACHEABLE_HEADERS.has(name)) continue
    if (!CACHEABLE_HEADERS.has(name)) continue
    if (typeof value !== 'string' || value.trim().length === 0) continue
    headers[name] = value
  }
  return { status: entry.status, headers }
}

/** 校验读到的元数据（缺字段/类型不符 ⇒ `null`）。 */
function readMeta(input: unknown): CacheMeta | null {
  if (typeof input !== 'object' || input === null) return null
  const candidate = input as { status?: unknown, headers?: unknown }
  if (typeof candidate.status !== 'number' || !Number.isInteger(candidate.status)) return null
  if (typeof candidate.headers !== 'object' || candidate.headers === null) return null
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(candidate.headers as Record<string, unknown>)) {
    if (typeof key !== 'string' || key.length === 0) return null
    if (typeof value !== 'string') return null
    headers[key] = value
  }
  return { status: candidate.status, headers }
}

/** ETag 归一（弱校验符 `W/` 不参与相等判定）。 */
function normalizeETag(value: string): string {
  const trimmed = value.trim()
  return trimmed.startsWith('W/') ? trimmed.slice(2).trim() : trimmed
}

/** 诊断用的键描述（**只用于日志**，落盘路径不含原文）。 */
function describe(scope: CacheScope, appId: string, version: string, path: string): string {
  return `server=${scope.serverHash} user=${scope.userHash} app=${appId} version=${version} path=${path}`
}
