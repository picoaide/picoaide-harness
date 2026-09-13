/**
 * Shared harness for the connector spawn regressions.
 *
 * Two boundaries are deliberately REAL here:
 *  - the plugin under test runs through its own `apply()` entry point, its own
 *    HTTP routes (`approve` / `list`) and its own on-disk credential store;
 *  - the captured MCP config is executed through the REAL
 *    `@modelcontextprotocol/sdk` client + stdio transport, which really spawns
 *    the fixture server, so every env assertion reads the child process' OWN
 *    environment.
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
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { vi } from 'vitest'
import { apply } from '../../src/index.ts'
import { ConnectorStore } from '../../src/store.ts'
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
  readonly emitSession: (session: { username?: string } | null) => void
  readonly dispose: () => void
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
  const sessionHandlers: Array<(next: unknown) => void> = []
  const effectDisposers: Array<() => void> = []
  let username: string | null = 'user-a'

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

  const ctx = {
    get: (name: string) => name === 'picoSession'
      ? { getSession: () => (username === null ? null : { username }) }
      : undefined,
    on: (event: string, handler: (next: unknown) => void) => {
      if (event === 'pico/session-changed') sessionHandlers.push(handler)
      return () => {}
    },
    plugin: vi.fn(async (_plugin: unknown, config: CapturedConfig) => {
      configs.push(config)
      const fiber = { dispose: vi.fn() }
      fibers.push(fiber)
      return fiber
    }),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
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
    emitSession: (session) => {
      username = session?.username ?? null
      for (const handler of [...sessionHandlers]) handler(session)
    },
    dispose: () => { for (const dispose of effectDisposers) dispose() },
  }
}

function request(method: string, url: string): IncomingMessage {
  return {
    method,
    url,
    headers: { host: 'localhost:43120', origin: 'http://localhost:43120' },
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
): Promise<{ status: number; body: string }> {
  const res = response()
  for (const route of harness.routes) {
    const matches = route.kind === 'exact' ? route.path === path : path.startsWith(route.path)
    if (!matches) continue
    await route.handler(request(method, path), res)
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

export async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  if (!check()) throw new Error('condition not reached in time')
}

export async function waitForFile(path: string, timeoutMs = 5000): Promise<string> {
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
