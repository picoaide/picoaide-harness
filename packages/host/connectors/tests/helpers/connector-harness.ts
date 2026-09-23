/**
 * Shared harness for the connector spawn regressions.
 *
 * Two boundaries are deliberately REAL here:
 *  - the plugin under test runs through its own `apply()` entry point, its own
 *    HTTP routes (`approve` / `list`) and its own on-disk credential store;
 *  - the captured MCP config is executed through the REAL
 *    `@modelcontextprotocol/client` (v2 — the package `dsh-mcp-client@0.1.6`
 *    imports) client + stdio transport, which really spawns the fixture server,
 *    so every env assertion reads the child process' OWN environment.
 *
 * Only the cordis plumbing is faked (`ctx.plugin` records the config instead of
 * loading `@deepseek-ai/dsh-mcp-client`, whose peer dependencies are not
 * installed in this workspace package). The real bridge passes that same config
 * to `StdioClientTransport` with `{...scrubbedParentEnv(), ...config.env}` — the
 * config wins — which is why reading the child env is the meaningful check.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { vi } from 'vitest'
import { apply } from '../../src/index.ts'
import { ConnectorStore } from '../../src/store.ts'
import { connectorScopePath, unscopedConnectorPath } from '../../src/user-scope.ts'
import type { ConnectorDef } from '../../src/types.ts'

/** One MCP registration the plugin handed to `ctx.plugin`. */
export interface CapturedConfig {
  transport: 'stdio' | 'streamable-http'
  serverName: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
}

export interface Harness {
  /** MCP configs the plugin registered (empty while nothing was spawned). */
  readonly configs: CapturedConfig[]
  readonly fibers: Array<{ dispose: ReturnType<typeof vi.fn> }>
  readonly routes: WebRoute[]
  /** Local-confirmation prompts the plugin raised, in order. */
  readonly prompts: Array<Record<string, unknown>>
  /**
   * `ctx.logger.warn` / `ctx.logger.error` messages, in order.
   *
   * The restore pass reports things a user cannot see any other way (the
   * unscoped-credential wave of R6-B-2, for instance), so a case has to be able
   * to read the line it claims to produce.
   */
  readonly warns: string[]
  readonly errors: string[]
  readonly emitSession: (session: { username?: string; serverURL?: string } | null) => void
  /** Fire a host event (the plugin's own listeners run synchronously). */
  readonly emit: (event: string, ...args: unknown[]) => void
  readonly dispose: () => void
  /** 上游 `connection` 服务替身被问过几次（R7-RV-3：证明必须真的被检查）。 */
  readonly fence: { seen: number }
  /**
   * 切换桌面包探针 `desktopRuntime.locale`（2026-09-16 i18n）。
   *
   * 真机语义：用户在设置里切语言后 `DesktopRuntime.locale` 立即变化，而插件进程
   * 不重启。Host 文案必须**每次构消息时**重新解析，这个可变量就是回归探针——
   * 谁把语言冻结在模块级/apply 期常量上，两次调用就会给出同一种语言。
   */
  readonly setLocale: (locale: 'zh' | 'en') => void
  /** 当前宿主语言（供用例断言探针确实被读到）。 */
  readonly locale: () => 'zh' | 'en'
}

/**
 * 上游 `connection.requestRejection()` 的行为替身（`rpc-host.ts:97-100`）：
 * Host/Origin 围栏之后，只有持 `dsh-auth-*` cookie 的页面才通过。
 *
 * R7-RV-3 后连接器的写面要这份证明：产品里的调用点（`ConnectorsSection.tsx`）
 * 跑在主应用窗口里、经 launch token 换过票，cookie 恒在；测试里的
 * {@link callRoute} 因此**默认带上 cookie**（模拟真页面），
 * {@link callRouteForged} 不带（模拟本机任意进程伪造 Origin）。
 */
export function browserFence(): { seen: number, requestRejection: (r: { headers: Record<string, unknown> }) => 401 | undefined } {
  const fence = {
    seen: 0,
    requestRejection: (request: { headers: Record<string, unknown> }) => {
      fence.seen += 1
      return request.headers['cookie'] === undefined ? (401 as const) : undefined
    },
  }
  return fence
}

/** Drive the real plugin `apply()` with a faked cordis context. */
export function createHarness(
  defs: ConnectorDef[],
  dir: string,
  options: Record<string, unknown> = {},
): Harness {
  const configs: CapturedConfig[] = []
  const fibers: Array<{ dispose: ReturnType<typeof vi.fn> }> = []
  const routes: WebRoute[] = []
  const prompts: Array<Record<string, unknown>> = []
  const warns: string[] = []
  const errors: string[] = []
  const sessionHandlers: Array<(next: unknown) => void> = []
  const eventHandlers = new Map<string, Array<(...args: unknown[]) => void>>()
  /** serverNames a live (not yet disposed) plugin instance owns. */
  const liveServerNames = new Set<string>()
  const effectDisposers: Array<() => void> = []
  let username: string | null = 'user-a'
  /**
   * The server the fake session points at.
   *
   * `null` (the default) is the "no address" case ⇒ the plugin resolves the
   * `servers/unscoped` scope. Cases that need two tenants on one machine emit a
   * session per server.
   */
  let serverURL: string | null = null
  /** 可变的宿主语言：插件只能通过 ctx.get('desktopRuntime') 读到它。 */
  let locale: 'zh' | 'en' = (options.locale as 'zh' | 'en' | undefined) ?? 'zh'

  // Record every confirmation prompt while keeping the caller's own callback
  // semantics (a headless embedder answers programmatically). A caller that
  // passes no hook keeps the panel path (pending request through the routes).
  const callerApproval = options.requestApproval as
    | ((request: never) => boolean | Promise<boolean>)
    | undefined
  const requestApproval = (request: never): boolean | Promise<boolean> => {
    prompts.push(request as unknown as Record<string, unknown>)
    return callerApproval === undefined ? true : callerApproval(request)
  }

  // `connectionFence: null` = 服务缺席（走 fail-closed 分支）；缺省 = 真页面替身。
  const fence = options.connectionFence === null
    ? undefined
    : (options.connectionFence as ReturnType<typeof browserFence> | undefined) ?? browserFence()

  const ctx = {
    get: (name: string) => {
      if (name === 'picoSession') {
        return {
          getSession: () => (username === null ? null : { username, ...(serverURL === null ? {} : { serverURL }) }),
        }
      }
      if (name === 'connection') return fence
      // 与桌面壳同形：只暴露 locale 字段，插件用结构探针读取（host-locale.ts）。
      if (name === 'desktopRuntime') return { get locale() { return locale } }
      return undefined
    },
    on: (event: string, handler: (next: unknown) => void) => {
      if (event === 'pico/session-changed') sessionHandlers.push(handler)
      const list = eventHandlers.get(event) ?? []
      list.push(handler as (...args: unknown[]) => void)
      eventHandlers.set(event, list)
      return () => {}
    },
    // The plugin emits `pico/connector-credentials-changed` after a refresh so
    // that stdio servers (whose token lives in the child environment) are
    // re-registered. The real host bus runs these listeners synchronously.
    emit: (event: string, ...args: unknown[]) => {
      for (const handler of eventHandlers.get(event) ?? []) handler(...args)
    },
    // The REAL bridge fails a load when another live instance owns the same
    // `serverName` (upstream mcp-client reserves it for the plugin lifetime:
    // `mcp-client: serverName "…" is already in use by another mcp-client
    // instance`). The fake must reproduce that contract, otherwise a
    // re-registration bug is invisible here while failing in the field
    // (2026-09-14: exactly that happened on Windows).
    plugin: vi.fn(async (_plugin: unknown, config: CapturedConfig) => {
      if (liveServerNames.has(config.serverName)) {
        throw new Error(
          `mcp-client: serverName "${config.serverName}" is already in use by another mcp-client instance — pick a unique serverName in cordis.yml`,
        )
      }
      liveServerNames.add(config.serverName)
      configs.push(config)
      const fiber = {
        dispose: vi.fn(() => { liveServerNames.delete(config.serverName) }),
      }
      fibers.push(fiber)
      return fiber
    }),
    logger: {
      info: vi.fn(),
      warn: vi.fn((message?: unknown) => { warns.push(String(message)) }),
      error: vi.fn((message?: unknown) => { errors.push(String(message)) }),
    },
    effect: (register: () => (() => void) | undefined) => {
      const dispose = register()
      if (typeof dispose === 'function') effectDisposers.push(dispose)
      return () => {}
    },
    webServer: { register: (route: WebRoute) => { routes.push(route); return () => {} } },
  } as unknown as Context

  apply(ctx, {
    connectors: defs,
    storeBaseDir: dir,
    ...options,
    // Only an explicit hook is forwarded: without it the plugin must take the
    // interactive panel path (pending request served by the routes).
    ...(callerApproval === undefined ? {} : { requestApproval }),
  })
  return {
    configs,
    fibers,
    routes,
    prompts,
    warns,
    errors,
    fence: fence ?? { seen: 0 },
    setLocale: (next) => { locale = next },
    locale: () => locale,
    emitSession: (session) => {
      username = session?.username ?? null
      serverURL = session?.serverURL ?? null
      for (const handler of [...sessionHandlers]) handler(session)
    },
    emit: (event: string, ...args: unknown[]) => {
      for (const handler of eventHandlers.get(event) ?? []) handler(...args)
    },
    dispose: () => { for (const dispose of effectDisposers) dispose() },
  }
}

function request(method: string, url: string, cookie = true, jsonBody?: unknown): IncomingMessage {
  // Handlers that read a JSON body (auth-submit) iterate the request; a plain
  // object has no async iterator, so provide one over the encoded payload.
  const payload = jsonBody === undefined ? '' : JSON.stringify(jsonBody)
  const body = {
    async *[Symbol.asyncIterator]() {
      if (payload !== '') yield Buffer.from(payload, 'utf8')
    },
  }
  return {
    ...body,
    method,
    url,
    headers: {
      host: 'localhost:43120',
      origin: 'http://localhost:43120',
      // R7-RV-3：真页面持有 BrowserAuth cookie；伪造进程拿不出（见 callRouteForged）。
      ...(cookie ? { cookie: 'dsh-auth-localhost:43120=v1.signature' } : {}),
    },
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as IncomingMessage
}

function response(): ServerResponse & { body: string } {
  const res = {
    body: '',
    statusCode: 200,
    writeHead: vi.fn((status: number) => { res.statusCode = status }),
    write: vi.fn(),
    end: vi.fn((body?: string) => { res.body += body ?? '' }),
  }
  return res as unknown as ServerResponse & typeof res
}

/** Call one registered connector route (the real HTTP handler path). */
export async function callRoute(
  harness: Harness,
  path: string,
  method = 'POST',
  jsonBody?: unknown,
): Promise<{ status: number; body: string }> {
  return await routeCall(harness, path, method, true, jsonBody)
}

/**
 * Call one route the way a **forged local process** would: same-origin headers
 * without the BrowserAuth cookie (R7-RV-3 regression face).
 */
export async function callRouteForged(
  harness: Harness,
  path: string,
  method = 'POST',
): Promise<{ status: number; body: string }> {
  return await routeCall(harness, path, method, false)
}

async function routeCall(
  harness: Harness,
  path: string,
  method: string,
  cookie: boolean,
  jsonBody?: unknown,
): Promise<{ status: number; body: string }> {
  const res = response()
  for (const route of harness.routes) {
    const matches = route.kind === 'exact' ? route.path === path : path.startsWith(route.path)
    if (!matches) continue
    // Handlers may be async (the list route reads the credential store for the
    // token-lifetime fields): await it, like the real HTTP server does, so the
    // response body is complete before it is read.
    await (route.handler as unknown as (req: IncomingMessage, res: ServerResponse) => unknown)(
      request(method, path, cookie, jsonBody),
      res,
    )
    return { status: res.statusCode, body: res.body }
  }
  throw new Error(`no route registered for ${path}`)
}

/** Write one credential through the plugin's own store. */
export async function seedCredential(
  dir: string,
  id: string,
  credential: Record<string, unknown>,
): Promise<void> {
  const store = new ConnectorStore({ baseDir: dir })
  await store.writeCredential(id, { updatedAt: Date.now(), ...credential } as never)
}

/**
 * The credential directory the plugin itself resolves for one (account, server)
 * pair — the SAME function the plugin uses, so a case never hand-rolls the
 * layout (hand-rolled expectations are how a layout change silently turns a
 * "seeded where the plugin reads" precondition into a no-op).
 * @param username - the account (null = the anonymous scope).
 * @param serverURL - the session's server address (null = `servers/unscoped`).
 * @returns the absolute live credential directory.
 */
export function scopeDir(username: string | null, serverURL?: string | null): string {
  return connectorScopePath(username, serverURL ?? null)
}

/**
 * The pre-2026-09-24 (unscoped) directory, i.e. where an upgraded install left
 * its credentials. The plugin never adopts what is in here.
 * @param username - the account that owned the old store.
 * @returns the absolute legacy credential directory.
 */
export function legacyScopeDir(username: string | null): string {
  return unscopedConnectorPath(username)
}

// 默认预算 15s（原 5s）：这些用例等的是**后台轮询 / 子进程回传 / 真实 socket 往返**，
// 在 CI（4 vCPU + 多包并发）上被调度拉开到 5s 以上是常态，而不是被测行为出错。
// 2026-09-15 实测：4 路并发下 `h.configs.length === 1` 这类注册等待也会撞满 5s。
export async function waitFor(check: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  if (!check()) throw new Error('condition not reached in time')
}

export async function waitForFile(path: string, timeoutMs = 15_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(path)) return await readFile(path, 'utf8')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`file never appeared: ${path}`)
}

/** Absolute path of the real MCP server fixture. */
export const FAKE_MCP_SERVER = fileURLToPath(new URL('../fixtures/fake-mcp-server.mjs', import.meta.url))

export interface McpCallOutcome {
  /** Raw tool names the server advertised. */
  toolNames: string[]
  /** Text of the first content block returned by `probe_echo`. */
  text: string
  /** The environment the CHILD process actually ran with. */
  childEnv: Record<string, string>
}

/**
 * Connect to the configured stdio server through the real MCP SDK, list its
 * tools and call `probe_echo`. `envOut` is where the fixture dumps the child's
 * own environment.
 */
export async function realMcpCall(config: CapturedConfig, text: string): Promise<McpCallOutcome> {
  const transport = new StdioClientTransport({
    command: config.command ?? '',
    args: config.args ?? [],
    ...(config.env === undefined ? {} : { env: config.env }),
    ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
    stderr: 'pipe',
  })
  const client = new Client({ name: 'regression-probe', version: '1.0.0' }, { capabilities: {} })
  await client.connect(transport)
  try {
    const tools = await client.listTools()
    const result = await client.callTool({ name: 'probe_echo', arguments: { text } }) as {
      content?: Array<{ type: string; text?: string }>
    }
    const envOut = config.env?.PROBE_ENV_OUT ?? ''
    const childEnv = envOut === '' ? {} : JSON.parse(await waitForFile(envOut)) as Record<string, string>
    return {
      toolNames: tools.tools.map(tool => tool.name),
      text: result.content?.[0]?.text ?? '',
      childEnv,
    }
  } finally {
    await client.close()
  }
}
