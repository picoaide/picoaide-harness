import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { spawn } from 'node:child_process'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { browserSameOriginMarker, isLoopbackRequest } from './loopback.ts'
import { ConnectorStore } from './store.ts'
import { runAuth, refreshOAuthToken } from './auth.ts'
import { CliRuntime } from './cli-runtime.ts'
import { salesEasyDef } from './sales-easy.ts'
import { dingTalkDef } from './dingtalk.ts'
import { marketplaceDefs } from './defs/index.ts'
import type { ConnectorAuthRequest, ConnectorDef, ConnectorMcp, ConnectorState } from './types.ts'
import type { ConnectorCredential } from './store.ts'

/**
 * Connector framework (mirrors WorkBuddy's connector service):
 * a registry of connector definitions, per-connector auth orchestration
 * (oauth redirect / device-code poll / token form / cli / server-side),
 * local token persistence, and dynamic MCP registration through
 * `ctx.plugin` once a connector connects.
 *
 * Exposes a loopback HTTP API consumed by the client settings UI:
 *   GET  /api/pico/connectors                -> list with states
 *   POST /api/pico/connectors/:id/connect    -> start auth flow
 *   POST /api/pico/connectors/:id/auth-submit-> token form values
 *   GET  /api/pico/connectors/:id/state      -> poll status + pending request
 *   POST /api/pico/connectors/:id/disconnect -> stop and forget
 */

export const name = 'pico-connectors'
export const inject = ['webServer']

export interface ConnectorsOptions {
  /** Extra connector definitions to register. */
  connectors?: ConnectorDef[]
  /** Override the token store directory (tests). */
  storeBaseDir?: string
  /** Override the CLI download cache directory (tests). */
  cliCacheDir?: string
}

type JsonHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void

/** Cap on connector API request bodies (settings forms are small). */
const MAX_REQUEST_BODY_BYTES = 1024 * 1024

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let received = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    received += buffer.byteLength
    if (received > MAX_REQUEST_BODY_BYTES) return null
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return null
  }
}

/** Decode one path segment, rejecting malformed escapes instead of throwing. */
function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}

function exact(handler: JsonHandler): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => { void handler(req, res) }
}

export function apply(ctx: Context, options: ConnectorsOptions = {}): void {
  const defs = dedupeById([...marketplaceDefs, ...(options.connectors ?? [])], [salesEasyDef, dingTalkDef])
  const store = new ConnectorStore(options.storeBaseDir ? { baseDir: options.storeBaseDir } : {})
  const cliRuntime = new CliRuntime(options.cliCacheDir ? { cacheDir: options.cliCacheDir } : undefined)
  const states = new Map<string, ConnectorState>()
  const pendingRequests = new Map<string, ConnectorAuthRequest>()
  const mcpDisposers = new Map<string, () => void>()
  /** In-flight auth flows keyed by connector id: disconnect/cancel aborts them. */
  const pendingFlows = new Map<string, AbortController>()

  const setState = (id: string, patch: Partial<ConnectorState>): void => {
    const current = states.get(id) ?? { status: 'disconnected', everConnected: false }
    states.set(id, { ...current, ...patch })
  }

  const getDef = (id: string): ConnectorDef | undefined => defs.find((def) => def.id === id)

  const emitRequest = (request: ConnectorAuthRequest): void => {
    pendingRequests.set(request.connectorId, request)
  }

  /** Run a command whose stdout yields the MCP endpoint URL (e.g. `dws mcp url get <id>`). */
  const resolveUrlCommand = async (args: string[]): Promise<string> => {
    const [command, ...rest] = args
    if (command === undefined) throw new Error('urlCommand is empty')
    const resolved = await cliRuntime.resolve(command, rest)
    const spawnCommand = resolved?.command ?? command
    const spawnArgs = resolved?.args ?? rest
    return new Promise((resolve, reject) => {
      const child = spawn(spawnCommand, spawnArgs, {
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: resolved?.shell,
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
      child.on('error', (error) => reject(error))
      child.on('exit', (code) => {
        if (code !== 0) {
          reject(new Error(stderr.trim() || `命令退出码 ${String(code)}`))
          return
        }
        const match = /https?:\/\/[^\s"'<>]+/u.exec(stdout)
        if (!match) {
          reject(new Error(`无法从命令输出中解析 URL: ${stdout.trim().slice(0, 200)}`))
          return
        }
        const url = match[0]
        // P3-5: never send stored credentials to an arbitrary host. The CLI
        // output must be https and must not point at a loopback/private
        // address (SSRF-style token exfiltration guard).
        try {
          const parsed = new URL(url)
          if (parsed.protocol !== 'https:') {
            reject(new Error(`MCP URL 必须是 https: ${url.slice(0, 80)}`))
            return
          }
          const host = parsed.hostname.toLowerCase()
          const isPrivate = host === 'localhost' || host === '::1'
            || /^127\./.test(host)
            || /^(10|172\.(1[6-9]|2\d|3[01])|192\.168)\./.test(host)
          if (isPrivate) {
            reject(new Error(`MCP URL 指向本地/私网地址，已拒绝: ${url.slice(0, 80)}`))
            return
          }
        } catch {
          reject(new Error(`MCP URL 无效: ${url.slice(0, 80)}`))
          return
        }
        resolve(url)
      })
    })
  }

  /** Render request headers: static `${FIELD}` templates from credential fields, empty Authorization -> Bearer token, and the default Bearer injection for OAuth/token credentials. */
  const renderHeaders = (server: ConnectorMcp, credential: ConnectorCredential | null): Record<string, string> => {
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(server.headers ?? {})) {
      if (value === '') {
        if (credential?.accessToken) headers[name] = `Bearer ${credential.accessToken}`
        continue
      }
      headers[name] = value.replace(/\$\{([^}]+)\}/g, (_, key: string) => credential?.fields?.[key] ?? '')
    }
    // OAuth/token connectors without static headers still authenticate with
    // the stored access token.
    if (Object.keys(headers).length === 0 && credential?.accessToken) {
      headers.Authorization = `Bearer ${credential.accessToken}`
    }
    return headers
  }


/** Merge connector definitions, keeping the hand-written ones when ids collide with generated defs. */
function dedupeById(generated: ConnectorDef[], handWritten: ConnectorDef[]): ConnectorDef[] {
  const ids = new Set(handWritten.map((def) => def.id))
  return [...handWritten, ...generated.filter((def) => !ids.has(def.id))]
}

  /** Register the connector's MCP servers through the mcp-client plugin. */
  const registerMcp = async (def: ConnectorDef): Promise<void> => {
    const credential = await store.readCredential(def.id)
    const { apply: applyMcpClient } = await import('@deepseek-ai/dsh-mcp-client')
    for (const server of def.mcp) {
      const config = server.transport === 'streamable-http'
        ? {
            transport: 'streamable-http' as const,
            serverName: server.serverName,
            url: server.urlCommand
              ? await resolveUrlCommand(server.urlCommand)
              : (server.url ?? ''),
            headers: renderHeaders(server, credential),
            toolCallTimeoutMs: 120_000,
            failOnStartupError: false,
          }
        : {
            transport: 'stdio' as const,
            serverName: server.serverName,
            command: server.command ?? '',
            args: server.args ?? [],
            env: {
              ...(server.env ?? {}),
              ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
              ...(credential?.accessToken ? { PICOAIDE_CONNECTOR_ACCESS_TOKEN: credential.accessToken } : {}),
              ...(credential?.refreshToken ? { PICOAIDE_CONNECTOR_REFRESH_TOKEN: credential.refreshToken } : {}),
              ...(credential?.fields ?? {}),
            },
            cwd: process.cwd(),
            toolCallTimeoutMs: 120_000,
            failOnStartupError: false,
          }
      const fiber = await ctx.plugin(
        { inject: ['tools'], apply: applyMcpClient, name: 'mcp-client' },
        config,
      )
      mcpDisposers.set(server.serverName, () => { void fiber?.dispose?.() })
    }
  }

  const unregisterMcp = async (def: ConnectorDef): Promise<void> => {
    for (const server of def.mcp) {
      const dispose = mcpDisposers.get(server.serverName)
      if (dispose) {
        dispose()
        mcpDisposers.delete(server.serverName)
      }
    }
  }

  /** Start the auth flow for a connector (background for poll-based modes). */
  const startConnect = async (id: string): Promise<void> => {
    const def = getDef(id)
    if (!def) throw new Error(`unknown connector: ${id}`)
    // P0-1: re-entrancy guard — a second connect on the same connector while
    // a flow is in flight must not start a duplicate authorization flow
    // (two callback ports, two browser windows, credential writeback race).
    if (pendingFlows.has(id)) return
    const existing = await store.readCredential(id)
    setState(id, { status: 'connecting', everConnected: Boolean(existing) || Boolean(states.get(id)?.everConnected) })

    // Pre-connect settings: if required fields are missing, emit the form and
    // wait for auth-submit before starting the actual auth flow.
    if (def.settings?.length) {
      const missing = def.settings.filter((field) => field.required && !existing?.fields?.[field.key]?.trim())
      if (missing.length > 0) {
        emitRequest({ connectorId: id, fields: def.settings })
        return
      }
    }
    pendingRequests.delete(id)
    const controller = new AbortController()
    pendingFlows.set(id, controller)
    try {
      const patch = await runAuth(def, {
        onRequest: emitRequest,
        signal: controller.signal,
        cli: cliRuntime,
        ...(existing?.fields ? { fields: existing.fields } : {}),
      })
      // Token-form flows finish on auth-submit; runAuth only emitted the fields.
      if (def.authMode === 'token') {
        setState(id, { status: 'connecting' })
        return
      }
      const current = await store.readCredential(id)
      await store.updateCredential(id, { ...current, ...patch })
      await registerMcp(def)
      setState(id, { status: "connected", everConnected: true, connectedAt: Date.now(), error: undefined })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const unauthorized = message.includes('授权') || message.includes('token') || message.includes('登录')
      // A user-initiated abort maps to the neutral 'disconnected' state, not
      // an error (the cancel button must not leave a scary red row behind).
      if (controller.signal.aborted) {
        setState(id, { status: 'disconnected', everConnected: Boolean(states.get(id)?.everConnected), error: undefined })
      } else {
        setState(id, { status: unauthorized ? 'unauthorized' : 'error', error: message })
      }
    } finally {
      pendingFlows.delete(id)
    }
  }

  const submitAuth = async (id: string, fields: Record<string, string>): Promise<void> => {
    const def = getDef(id)
    if (!def) throw new Error(`unknown connector: ${id}`)
    const current = await store.readCredential(id)
    await store.updateCredential(id, { fields: { ...(current?.fields ?? {}), ...fields } })
    if (def.authMode === 'token') {
      await registerMcp(def)
      setState(id, { status: "connected", everConnected: true, connectedAt: Date.now(), error: undefined })
      pendingRequests.delete(id)
      return
    }
    // Device/cli/oauth flows continue after the settings form is submitted.
    await startConnect(id)
  }

  const disconnect = async (id: string): Promise<void> => {
    const def = getDef(id)
    if (def) await unregisterMcp(def)
    // P0-1: a disconnect must also abort any in-flight authorization flow —
    // otherwise the completed OAuth/device flow would "resurrect" the
    // connector and write back credentials after the user disconnected.
    const flow = pendingFlows.get(id)
    if (flow) flow.abort(
      new Error('用户在连接过程中断开了连接'),
    )
    await store.clearCredential(id)
    setState(id, { status: 'disconnected', everConnected: false, error: undefined, connectedAt: undefined })
    pendingRequests.delete(id)
  }

  ctx.effect(() => {
    for (const def of defs) {
      void (async () => {
        try {
          const credential = await store.readCredential(def.id)
          if (!credential) return
          // Refresh OAuth tokens before restoring, then register the MCP servers.
          const refreshed = await refreshOAuthToken(def, credential)
          const effective = refreshed ? await store.updateCredential(def.id, refreshed) : credential
          if (effective.accessToken) {
            await registerMcp(def)
            setState(def.id, { status: 'connected', everConnected: true })
          }
        } catch (error) {
          // A restore failure (network, missing dependency, MCP connect) must
          // not become an unhandled rejection: the host treats those as fatal
          // and exits the whole app. Surface it on the connector row instead.
          const message = error instanceof Error ? error.message : String(error)
          ctx.logger.error(`pico-connectors: failed to restore ${def.id}: ${message}`)
          setState(def.id, { status: 'error', error: message })
        }
      })()
    }
    return () => {
      for (const dispose of mcpDisposers.values()) dispose()
      // P0-1: teardown must abort any in-flight authorization flow — a
      // lingering OAuth/device flow would keep the callback server up and
      // (on a later disconnect) could write back credentials after teardown.
      for (const flow of pendingFlows.values()) flow.abort(new Error('插件卸载，连接流程中止'))
      pendingFlows.clear()
    }
  }, 'pico connectors: restore + cleanup')

  ctx.effect(() => {
    const list: JsonHandler = (_req, res) => {
      const body = defs.map((def) => {
        const state = states.get(def.id) ?? { status: 'disconnected' as const, everConnected: false }
        return {
          id: def.id,
          name: def.name,
          description: def.description,
          icon: def.icon ?? null,
          authMode: def.authMode,
          examples: def.examples ?? [],
          request: pendingRequests.get(def.id) ?? null,
          ...state,
        }
      })
      json(res, 200, { connectors: body })
    }

    const connect: JsonHandler = (req, res) => {
      const rawId = decodeSegment(req.url?.split('/')[4] ?? '')
      if (rawId === null) return json(res, 400, { error: 'malformed connector id' })
      const id = rawId
      const def = getDef(id)
      if (!def) return json(res, 404, { error: `unknown connector: ${id}` })
      // P0-1: a re-connect while a flow is in flight means the user closed
      // the authorization popup (or abandoned it) and wants a fresh flow —
      // abort the stale one first so the new connect is never swallowed and
      // old authorize URL is never re-opened. A fast double-click still
      // races: the second connect sees the first flow (just started) and
      // aborts it — the client's own busy guard prevents that on the happy
      // path; the abort here is the safety net for an abandoned flow.
      const stale = pendingFlows.get(id)
      if (stale) {
        stale.abort(new Error('连接器重新连接，旧授权流程已取消'))
        pendingFlows.delete(id)
        pendingRequests.delete(id)
      }
      const request: ConnectorAuthRequest = { connectorId: id }
      emitRequest(request)
      void startConnect(id).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        setState(id, { status: 'error', error: message })
      })
      // The pending request may gain fields once the flow starts; poll the
      // state endpoint for the final shape.
      json(res, 200, { ok: true, request })
    }

    const cancel: JsonHandler = (req, res) => {
      const rawId = decodeSegment(req.url?.split('/')[4] ?? '')
      if (rawId === null) return json(res, 400, { error: 'malformed connector id' })
      const id = rawId
      if (!getDef(id)) return json(res, 404, { error: `unknown connector: ${id}` })
      // P0-1: explicit user cancel of an in-flight authorization flow. The
      // flow's abort listener closes the callback server and rejects the
      // code promise; startConnect's catch maps the abort to 'disconnected'.
      const flow = pendingFlows.get(id)
      if (flow) flow.abort(new Error('用户取消了连接'))
      setState(id, { status: 'disconnected', everConnected: Boolean(states.get(id)?.everConnected), error: undefined })
      pendingRequests.delete(id)
      json(res, 200, { ok: true })
    }

    const authSubmit: JsonHandler = async (req, res) => {
      const rawId = decodeSegment(req.url?.split('/')[4] ?? '')
      if (rawId === null) return json(res, 400, { error: 'malformed connector id' })
      const id = rawId
      const raw = await readJson(req)
      if (!raw || typeof raw !== 'object' || typeof (raw as { fields?: unknown }).fields !== 'object') {
        return json(res, 400, { error: 'missing fields' })
      }
      // P0-1/P2-17: only string values are meaningful for auth headers; a
      // number/object/array would crash renderHeaders on the MCP registration
      // path with an obscure TypeError.
      const fields = (raw as { fields: Record<string, unknown> }).fields
      for (const [key, value] of Object.entries(fields)) {
        if (typeof value !== 'string') return json(res, 400, { error: `field '${key}' must be a string` })
      }
      try {
        void submitAuth(id, fields as Record<string, string>).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          setState(id, { status: 'error', error: message })
        })
        // Return immediately: token form flows complete fast, but OAuth/device
        // flows can run for minutes — the fetch must not hang the panel's
        // busy state on "提交中…" for the whole authorization.
        json(res, 200, { ok: true })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        json(res, 400, { error: message })
      }
    }

    const state: JsonHandler = (req, res) => {
      const rawId = decodeSegment(req.url?.split('/')[4] ?? '')
      if (rawId === null) return json(res, 400, { error: 'malformed connector id' })
      const id = rawId
      const def = getDef(id)
      if (!def) return json(res, 404, { error: `unknown connector: ${id}` })
      const current = states.get(id) ?? { status: 'disconnected' as const, everConnected: false }
      json(res, 200, { ...current, request: pendingRequests.get(id) ?? null })
    }

    const disconnectHandler: JsonHandler = async (req, res) => {
      const rawId = decodeSegment(req.url?.split('/')[4] ?? '')
      if (rawId === null) return json(res, 400, { error: 'malformed connector id' })
      const id = rawId
      if (!getDef(id)) return json(res, 404, { error: `unknown connector: ${id}` })
      await disconnect(id)
      json(res, 200, { ok: true })
    }

    // Trust fence for every connector route: loopback socket + Host +
    // same-origin markers. State-changing endpoints below also enforce POST.
    const guard = (req: IncomingMessage, res: ServerResponse): boolean => {
      if (browserSameOriginMarker(req) && isLoopbackRequest(req)) return true
      json(res, 403, { error: 'forbidden' })
      return false
    }

    const disposers = [
      ctx.webServer.register({ kind: 'exact', path: '/api/pico/connectors', handler: (req, res) => {
        if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
        if (!guard(req, res)) return
        list(req, res)
      } }),
      ctx.webServer.register({ kind: 'prefix', path: '/api/pico/connectors', handler: (req, res) => {
        const segments = req.url?.split('/') ?? []
        const action = segments[5]?.split('?')[0]
        const handlers: Record<string, JsonHandler> = {
          connect: exact(connect),
          cancel: exact(cancel),
          'auth-submit': exact(authSubmit),
          state: exact(state),
          disconnect: exact(disconnectHandler),
        }
        if (!guard(req, res)) return
        const method = req.method ?? 'GET'
        const allowedMethods: Record<string, string> = {
          connect: 'POST',
          cancel: 'POST',
          'auth-submit': 'POST',
          state: 'GET',
          disconnect: 'POST',
        }
        const expected = action ? allowedMethods[action] : undefined
        if (expected !== undefined && method !== expected) {
          return json(res, 405, { error: 'method not allowed' })
        }
        const handler = action ? handlers[action] : undefined
        if (handler) handler(req, res)
        else json(res, 404, { error: 'not found' })
      } }),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, 'pico connectors: http routes')
}

export type { ConnectorDef, ConnectorState, ConnectorAuthRequest } from './types.ts'
