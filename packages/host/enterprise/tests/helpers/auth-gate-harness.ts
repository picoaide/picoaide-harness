/**
 * 技能库本机路由的**测试装具**（R18B-01/R18B-04 的两个新判据共用）。
 *
 * 形状与 `auth-gate-local-write-proof.spec.ts` 里的同款装具一致：装一个真的 auth-gate
 * （`apply(ctx, config)`），按 prefix 取出路由 handler，然后用伪造的回环请求打进去。
 * 差别只有两点，都是本批判据需要的能力：
 *   - `workspaceRegistry` 可注入（宿主侧权威的**已登记工作区**，R18B-01 的项目根来源）；
 *   - `ctx.logger.warn` 是**可观测**的 mock（R18B-04：安装器的清理/自愈记录必须经
 *     logger 出口，而不是 `console.warn`）。
 *
 * 网关 fetch 由调用方 stub（`stubGateway`），所以判据里没有任何真实出网。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { vi } from 'vitest'
import { apply, type Config } from '../../src/auth-gate.ts'
import type { Session } from '../../src/server-connector/config.ts'

/** 一条被注册的路由（`webServer.register` 的入参形状）。 */
export interface RegisteredRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void
}

/** 装具：按 prefix 取 handler + 可观测的日志出口。 */
export interface AuthGateHarness {
  /** 取某条路由的 handler（找不到即抛：判据失去输入必须红）。 */
  handler: (path: string) => RegisteredRoute['handler']
  /** `ctx.logger.warn` 的 mock（R18B-04 的判据面）。 */
  loggerWarn: ReturnType<typeof vi.fn>
  /** 出站过的 URL（网关替身记录）。 */
  gateway: string[]
  /** 出站用过的 Authorization 头。 */
  auth: Array<string | undefined>
}

/**
 * 装一个 auth-gate。
 * @param session - 当前会话（null = 未登录）。
 * @param options - `workspaces` = 已登记工作区目录（`workspaceRegistry.list()` 的形状）；
 *   `withConnection` = 是否提供 `connection` 服务（缺省提供：持有性证明可用）。
 * @returns 装具。
 */
export function harness(
  session: Session | null,
  options: { workspaces?: readonly string[], withConnection?: boolean } = {},
): AuthGateHarness {
  const routes: RegisteredRoute[] = []
  const gateway: string[] = []
  const auth: Array<string | undefined> = []
  const loggerWarn = vi.fn()
  const fence = {
    requestRejection: (request: { headers: Record<string, unknown> }) =>
      request.headers['cookie'] === undefined ? (401 as const) : undefined,
  }
  const ctx = {
    effect: (fn: () => unknown) => { fn() },
    get: (name: string) => {
      if (name === 'connection') return options.withConnection === false ? undefined : fence
      if (name === 'workspaceRegistry') {
        return { list: () => (options.workspaces ?? []).map(path => ({ path })) }
      }
      return undefined
    },
    logger: { info: vi.fn(), warn: loggerWarn, error: vi.fn() },
    picoSession: {
      isRestored: () => true,
      isLoggedIn: () => session !== null,
      getSession: () => session,
      setSession: vi.fn(),
      clear: vi.fn(),
    },
    webServer: {
      tapIndex: () => () => {},
      register: (route: RegisteredRoute) => { routes.push(route); return () => {} },
    },
  }
  apply(ctx as never, {} as Config)
  return {
    loggerWarn,
    gateway,
    auth,
    handler: (path: string) => {
      const route = routes.find(r => r.kind === 'prefix' && r.path === path)
        ?? routes.find(r => r.kind === 'exact' && r.path === path)
      if (route === undefined) throw new Error(`no route ${path}`)
      return route.handler
    },
  }
}

/**
 * 伪造一个**带持有性证明**的回环请求（本机页面的形状）。
 * @param method - HTTP 方法。
 * @param url - 请求 URL。
 * @param body - 请求体（给了就带 content-length）。
 * @returns 可直接喂给路由 handler 的请求。
 */
export function fakeReq(method: string, url: string, body?: string): IncomingMessage {
  const chunks = body === undefined ? [] : [Buffer.from(body)]
  return {
    method,
    url,
    headers: {
      origin: 'http://127.0.0.1:3080',
      host: '127.0.0.1:3080',
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
      cookie: 'dsh-auth-127.0.0.1:3080=v1.signature',
      ...(body === undefined ? {} : { 'content-length': String(Buffer.byteLength(body)) }),
    },
    socket: { remoteAddress: '127.0.0.1' },
    [Symbol.asyncIterator]: async function* () { for (const chunk of chunks) yield chunk },
  } as unknown as IncomingMessage
}

/** 收集响应的假 res（`read()` 返回状态码与解析后的 JSON 体）。 */
export function fakeRes(): { res: ServerResponse, read: () => { code: number, body: any } } {
  let code = 0
  let body: unknown
  const res = {
    writeHead: (value: number) => { code = value },
    end: (chunk?: string | Buffer) => {
      body = chunk === undefined ? undefined : JSON.parse(chunk.toString())
    },
  } as unknown as ServerResponse
  return { res, read: () => ({ code, body }) }
}

/**
 * 网关替身：`/archive` 返回给定的归档字节，其余返回 `{ok:true}` JSON。
 * @param harness - 装具（记录出站）。
 * @param archive - 归档内容。
 * @param headers - 归档响应上额外的头（例如 `x-skill-checksum`）。
 */
export function stubGateway(
  harness: AuthGateHarness,
  archive: Buffer,
  headers: Record<string, string> = {},
): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
    const href = String(url)
    harness.gateway.push(href)
    harness.auth.push(new Headers(init?.headers).get('authorization') ?? undefined)
    if (href.includes('/archive')) {
      return new Response(new Uint8Array(archive), {
        status: 200,
        headers: { 'content-type': 'application/gzip', 'x-skill-version': '1.0.0', ...headers },
      })
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
  }))
}
