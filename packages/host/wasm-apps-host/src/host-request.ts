/**
 * 本机请求面（**唯一 seam**）—— 零端口迁移就绪规则 R1/R2 的实现（设计总纲 §22.2）。
 *
 * R1：宿主侧所有本机路由经**这一个** seam 注册；今天它映射到 `ctx.webServer.register`
 * （loopback 端口），将来映射到上游零端口形态（`dsh-app://` + fd3/fd4 帧管道）时
 * **只换这一处实现**，业务 handler 一行不改。因此本模块是 `packages/host/wasm-apps-host/src`
 * 里**唯一**允许出现 `ctx.webServer` / 端口 / `127.0.0.1` / `dsh-auth` 字面量的文件。
 *
 * R2：本机 API 的授权**不得依赖 Cookie / Host / Origin / 端口** —— 零端口下这些
 * 全都不存在。授权 = 请求头 `X-Pico-Host-Proof`（宿主签发的持有性令牌，与 §20 的
 * app-proof 同族）：
 *
 * ```
 * 渲染层（客户端 UI）                 宿主（本 seam）
 *   GET  <prefix>/host-proof   ──────►  签发一枚短时令牌（今天额外过 connection 围栏：
 *                                       那是**引导**路径，零端口下换成帧管道握手）
 *   POST <prefix>/open         ──────►  X-Pico-Host-Proof: <token> ⇒ 放行
 *                                       缺/错/过期 ⇒ 401 proof_required|proof_expired
 * ```
 *
 * 为什么令牌放请求头而不是 cookie：cookie 会被浏览器自动携带（任意被浏览的页面都能
 * 触发带身份的请求），而自定义请求头只有**能读到响应的同源页面**才发得出来；零端口
 * 形态下更没有 cookie 语义。这也是 §20.2「发起者绑定」在客户端一侧的对应物。
 *
 * 传输无关：handler 拿到的是 {@link SurfaceRequest}/{@link SurfaceReply}（不是
 * node 的 IncomingMessage/ServerResponse），所以换传输不需要改 handler。
 *
 * @module @picoaide/dsh-wasm-apps-host/host-request
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import type {} from '@deepseek-ai/dsh-host-webserver'

/**
 * 宿主**保留命名空间**的路径前缀（§21.2 规则②③；**唯一实现**）。
 *
 * 用法是"是不是保留面"，不是"是不是某条具体桥"：`/__picoaide`（无尾斜杠）与
 * `/__picoaide/...` 都属于保留面（R2-L2-3）。服务端 `internal/wasmapp` 的
 * `reservedPathPrefix = "__picoaide/"` 是同一口径的另一半 —— 改这里必须同步改那里。
 */
export const RESERVED_HOST_PREFIX = '/__picoaide'

/**
 * 这个 pathname 是否落在宿主保留命名空间里（**含无尾斜杠的裸前缀**）。
 *
 * 判据写成"等于前缀 或 以前缀 + '/' 开头"，而不是 `startsWith('/__picoaide/')`：
 * 后者会把 `/__picoaide` 漏进普通应用请求分支（转发平台）—— 那是 R2-L2-3 实测的缺口。
 * 也不写成 `startsWith('/__picoaide')`：那会连 `/__picoaidex` 一起吞掉（过度拦截同样
 * 是缺陷：应用有合法路径叫这个名字时会被莫名 404）。
 * @param path - 已解析的 pathname（含 `/` 前缀）。
 * @returns true = 保留面（除 AI 桥之外一律 404，绝不转发）。
 */
export function isReservedHostPath(path: string): boolean {
  return path === RESERVED_HOST_PREFIX || path.startsWith(`${RESERVED_HOST_PREFIX}/`)
}

/** 持有性证明请求头（§22.2 R2 冻结）。 */
export const HOST_PROOF_HEADER = 'x-pico-host-proof'

/** 令牌缺省寿命（毫秒）：短到"页面关掉就基本失效"，长到不必每次调用都重取。 */
export const HOST_PROOF_TTL_MS = 5 * 60_000

/** 同时有效的令牌上限（界内 LRU：每个渲染层实例一枚，正常只有 1–2 枚）。 */
export const HOST_PROOF_MAX_PENDING = 32

/** 证明闸的拒绝语义（HTTP 状态 + 机器可读错误码）。 */
export interface HostProofRejection {
  status: 401
  /** `proof_required`（没带/带错）｜`proof_expired`（过期）。 */
  code: 'proof_required' | 'proof_expired'
}

/** 传给 handler 的请求（**传输无关**）。 */
export interface SurfaceRequest {
  readonly method: string
  /** 完整 pathname（已解析，不含 query）。 */
  readonly pathname: string
  readonly query: URLSearchParams
  readonly headers: IncomingHttpHeaders
  /** 请求体（已读完；超限时由 seam 直接 413，不调用 handler）。 */
  readonly body: Uint8Array
}

/** handler 用来写响应（**传输无关**）。 */
export interface SurfaceReply {
  /** 设置响应头（同名多次调用以最后一次为准）。 */
  header(name: string, value: string): void
  /** 写响应（字符串按 UTF-8；对象按 JSON）。 */
  send(status: number, body: string | Uint8Array | Record<string, unknown>): void
}

/** 一个本机路由。 */
export interface HostSurfaceRoute {
  /** 精确 method（大写）。 */
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** 完整 pathname（含 seam 前缀）。 */
  readonly path: string
  /**
   * 是否要求 `X-Pico-Host-Proof`。
   * `bootstrap` = 免证明（只允许签发令牌的那一条，且它自己另有过闸）。
   */
  readonly proof: 'required' | 'bootstrap'
  readonly handler: (req: SurfaceRequest, reply: SurfaceReply) => void | Promise<void>
}

/** 本机请求面。 */
export interface HostRequestSurface {
  /** 注册前缀（loopback 形态下就是它）。 */
  readonly prefix: string
  /** 令牌签发路由的完整 pathname（渲染层引导用）。 */
  readonly proofRoute: string
  /** 签发一枚令牌（**只有 bootstrap 路由与单测调用**）。 */
  issueProof(): { proof: string, expiresAt: number }
  /**
   * 校验证明头。
   * @param headers - 请求头（大小写不敏感：node 已归一为小写，这里再兜一次）。
   * @returns 通过返回 null；否则给出拒绝语义。
   */
  verify(headers: IncomingHttpHeaders): HostProofRejection | null
  /** 手动派发（单测与将来的帧管道用；loopback 注册的内部实现也走它）。 */
  dispatch(request: SurfaceRequest): Promise<{ status: number, headers: Record<string, string>, body: Uint8Array }>
  /** 注销 loopback 路由（插件卸载）。 */
  dispose(): void
}

/** 持有性令牌的签发/校验（单飞、界内、常量时间比较）。 */
export interface HostProofAuthority {
  issue(): { proof: string, expiresAt: number }
  verify(headers: IncomingHttpHeaders): HostProofRejection | null
  /** 当前有效令牌数（单测/诊断）。 */
  size(): number
}

/** 令牌签发/校验的构造参数。 */
export interface HostProofAuthorityOptions {
  ttlMs?: number | undefined
  maxPending?: number | undefined
  now?: (() => number) | undefined
  randomToken?: (() => string) | undefined
}

/** 取头（大小写不敏感；node 已小写化，但单测与未来传输不该假定这件事）。 */
function headerOf(headers: IncomingHttpHeaders, name: string): string | undefined {
  const direct = headers[name]
  if (typeof direct === 'string') return direct
  if (Array.isArray(direct)) return direct[0]
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue
    if (typeof value === 'string') return value
    if (Array.isArray(value)) return value[0]
  }
  return undefined
}

/** 常量时间比较（长度不同直接不等；不泄漏"前缀对了多少"）。 */
function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.byteLength !== right.byteLength) return false
  return timingSafeEqual(left, right)
}

/**
 * 构造令牌权威。
 * @param options - TTL / 上限 / 时钟 / 随机源（后两者可注入，测试用）。
 * @returns 签发与校验。
 */
export function createHostProofAuthority(options: HostProofAuthorityOptions = {}): HostProofAuthority {
  const ttlMs = options.ttlMs ?? HOST_PROOF_TTL_MS
  const maxPending = options.maxPending ?? HOST_PROOF_MAX_PENDING
  const now = options.now ?? ((): number => Date.now())
  const randomToken = options.randomToken ?? ((): string => randomBytes(32).toString('hex'))
  /** 有效令牌（插入序 = LRU 序；超上限时淘汰最旧）。 */
  const pending = new Map<string, number>()
  const prune = (instant: number): void => {
    for (const [token, expiresAt] of pending) {
      if (expiresAt <= instant) pending.delete(token)
    }
    while (pending.size > maxPending) {
      const oldest = pending.keys().next()
      if (oldest.done === true) break
      pending.delete(oldest.value)
    }
  }
  return {
    issue() {
      const instant = now()
      prune(instant)
      const proof = randomToken()
      const expiresAt = instant + ttlMs
      pending.set(proof, expiresAt)
      return { proof, expiresAt }
    },
    verify(headers) {
      const raw = headerOf(headers, HOST_PROOF_HEADER)
      if (raw === undefined || raw === '') return { status: 401, code: 'proof_required' }
      const instant = now()
      // 先匹配再清理：**过期**与**没见过**是两种语义（渲染层据此决定"重取令牌"
      // 还是"重新登录"），清理在前会把两者混成同一个 401。
      for (const [token, expiresAt] of pending) {
        if (!sameSecret(token, raw)) continue
        return expiresAt > instant ? null : { status: 401, code: 'proof_expired' }
      }
      prune(instant)
      return { status: 401, code: 'proof_required' }
    },
    size() {
      prune(now())
      return pending.size
    },
  }
}

/**
 * 与 `packages/host/desktop/src/write-proof.ts` 同形的 trust fence（**只用于引导路径**）。
 *
 * 为什么引导路径还留着它：今天渲染层在 loopback 页面上，"谁能拿令牌"必须有个当日
 * 可用的判据；零端口形态下渲染层与宿主之间是帧管道（不存在第三方读取者），这条
 * 依赖随之消失 —— 这正是 R2 允许它只出现在 seam 里的原因。
 */
interface ConnectionTrustFence {
  requestRejection(request: { headers: IncomingHttpHeaders }): 401 | 403 | undefined
}

/** fence 是否可用（`requestRejection` 必须是函数）。 */
function connectionFenceReady(service: unknown): service is ConnectionTrustFence {
  return service !== null && service !== undefined
    && typeof (service as { requestRejection?: unknown }).requestRejection === 'function'
}

/** 本机请求面的构造参数。 */
export interface HostRequestSurfaceOptions {
  /** 前缀（唯一入口；缺省用调用方给的值）。 */
  prefix: string
  /** 路由表。 */
  routes: readonly HostSurfaceRoute[]
  /** 请求体上限（超过则 413，不调用 handler）。 */
  bodyLimit: number
  /** 诊断出口。 */
  warn?: ((message: string) => void) | undefined
  /** 令牌权威（缺省新建；测试可注入固定时钟）。 */
  authority?: HostProofAuthority | undefined
}

/** 把 node 请求读成 `SurfaceRequest`（超限返回 null）。 */
async function readSurfaceRequest(req: IncomingMessage, bodyLimit: number): Promise<SurfaceRequest | null> {
  const chunks: Buffer[] = []
  let received = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    received += buffer.byteLength
    if (received > bodyLimit) return null
    chunks.push(buffer)
  }
  const raw = req.url ?? '/'
  const parsed = new URL(raw, 'http://localhost')
  return {
    method: (req.method ?? 'GET').toUpperCase(),
    pathname: parsed.pathname,
    query: parsed.searchParams,
    headers: req.headers,
    body: Buffer.concat(chunks),
  }
}

/**
 * 构造本机请求面。
 *
 * `ctx.webServer` 在这里**只出现一次**（R1 的机器判据就是这一条）：其它模块只能
 * 通过 {@link HostRequestSurface} 的语义面说话。
 * @param ctx - Cordis 上下文（用到 `webServer` 与引导路径的 `connection`）。
 * @param options - 前缀/路由/体积上限。
 * @returns 本机请求面（含 dispatch，便于单测与将来的帧管道）。
 */
export function createHostRequestSurface(ctx: Context, options: HostRequestSurfaceOptions): HostRequestSurface {
  const warn = options.warn ?? ((): void => {})
  const authority = options.authority ?? createHostProofAuthority()
  const proofRoute = `${options.prefix}/host-proof`
  const routes = new Map<string, HostSurfaceRoute>()
  for (const route of options.routes) routes.set(`${route.method} ${route.path}`, route)

  const jsonReply = (reply: SurfaceReply, status: number, body: Record<string, unknown>): void => {
    reply.header('content-type', 'application/json; charset=utf-8')
    reply.send(status, body)
  }

  /**
   * 引导路径：签发令牌。
   *
   * 两条闸（当日形态）：①方法必须是 GET（写面一律要证明，否则就成了"用写面换令牌"）；
   * ②`connection` 围栏可用时必须过（不可用 ⇒ fail-closed 503，绝不"没有围栏就放行"）。
   */
  const bootstrap = (req: SurfaceRequest, reply: SurfaceReply): void => {
    if (req.method !== 'GET') {
      jsonReply(reply, 405, { error: 'method not allowed' })
      return
    }
    const fence = ctx.get('connection')
    if (connectionFenceReady(fence)) {
      let rejection: 401 | 403 | undefined
      try {
        rejection = fence.requestRejection({ headers: req.headers })
      } catch (cause) {
        warn(`pico-wasm-apps-host: the bootstrap proof check failed (${cause instanceof Error ? cause.message : String(cause)})`)
        rejection = 403
      }
      if (rejection !== undefined) {
        warn(`pico-wasm-apps-host: refused to issue a host proof without browser proof (${String(rejection)})`)
        jsonReply(reply, 403, { error: 'browser session proof required' })
        return
      }
    } else if (ctx.get('webServer') !== undefined) {
      // 有 loopback 服务器却没有任何围栏服务：不能凭"页面在 loopback 上"发令牌
      // （本机任意进程都能 GET）。fail-closed 是契约，不是保守。
      warn('pico-wasm-apps-host: the connection fence is unavailable; refusing to issue a host proof (fail-closed)')
      jsonReply(reply, 503, { error: 'browser session proof unavailable' })
      return
    }
    const issued = authority.issue()
    jsonReply(reply, 200, { proof: issued.proof, expires_at: issued.expiresAt })
  }

  const dispatch = async (request: SurfaceRequest): Promise<{ status: number, headers: Record<string, string>, body: Uint8Array }> => {
    const headers: Record<string, string> = {}
    let status = 200
    let body: Uint8Array = new Uint8Array()
    const reply: SurfaceReply = {
      header(name, value) { headers[name.toLowerCase()] = value },
      send(next, content) {
        status = next
        if (typeof content === 'string') body = Buffer.from(content, 'utf8')
        else if (content instanceof Uint8Array) body = content
        else {
          if (headers['content-type'] === undefined) headers['content-type'] = 'application/json; charset=utf-8'
          body = Buffer.from(JSON.stringify(content), 'utf8')
        }
      },
    }
    if (request.pathname === proofRoute) {
      bootstrap(request, reply)
      return { status, headers, body }
    }
    const route = routes.get(`${request.method} ${request.pathname}`)
    if (route === undefined) {
      // 前缀路由会收到 `<prefix>/*` 下的**全部**路径 ⇒ 未知路径必须 404（不得落进
      // 任何 handler 的处理逻辑；这条是 §5.2「冻结语义判据」的一部分）。
      const known = [...routes.values()].some((candidate) => candidate.path === request.pathname)
      jsonReply(reply, known ? 405 : 404, { error: known ? 'method not allowed' : 'not found' })
      return { status, headers, body }
    }
    if (route.proof === 'required') {
      const rejection = authority.verify(request.headers)
      if (rejection !== null) {
        warn(`pico-wasm-apps-host: refused a local call without a host proof (${rejection.code}) [${request.method} ${request.pathname}]`)
        jsonReply(reply, rejection.status, { error: rejection.code })
        return { status, headers, body }
      }
    }
    try {
      await route.handler(request, reply)
    } catch (cause) {
      warn(`pico-wasm-apps-host: local route ${request.pathname} failed (${cause instanceof Error ? cause.message : String(cause)})`)
      headers['content-type'] = 'application/json; charset=utf-8'
      status = 500
      body = Buffer.from(JSON.stringify({ error: 'internal error' }), 'utf8')
    }
    return { status, headers, body }
  }

  // ---- loopback 注册（今天唯一的传输；零端口时换掉这一段即可） ----
  let disposeRegistration: (() => void) | undefined
  const webServer = ctx.webServer as { register?: (route: { kind: 'prefix', path: string, handler: (req: IncomingMessage, res: ServerResponse) => void }) => () => void } | undefined
  if (typeof webServer?.register === 'function') {
    disposeRegistration = webServer.register({
      kind: 'prefix',
      path: options.prefix,
      handler: (req, res) => {
        void (async (): Promise<void> => {
          const request = await readSurfaceRequest(req, options.bodyLimit)
          if (request === null) {
            res.writeHead(413, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ error: 'payload too large' }))
            return
          }
          const result = await dispatch(request)
          res.writeHead(result.status, result.headers)
          res.end(Buffer.from(result.body))
        })().catch((cause: unknown) => {
          warn(`pico-wasm-apps-host: the local request surface failed (${cause instanceof Error ? cause.message : String(cause)})`)
          if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: 'internal error' }))
        })
      },
    })
  } else {
    // 零端口宿主：暂不监听任何端口，路由表仍可用（`dispatch` 由帧管道调用）。
    warn('pico-wasm-apps-host: no local web server is available; the host request surface stays dispatch-only')
  }

  return {
    prefix: options.prefix,
    proofRoute,
    issueProof: () => authority.issue(),
    verify: headers => authority.verify(headers),
    dispatch,
    dispose: () => { disposeRegistration?.() },
  }
}
