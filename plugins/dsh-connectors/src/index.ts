import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { spawn } from 'node:child_process'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { ConnectorStore } from './store.ts'
import { runAuth, refreshOAuthToken } from './auth.ts'
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
}

type JsonHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
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
  const states = new Map<string, ConnectorState>()
  const pendingRequests = new Map<string, ConnectorAuthRequest>()
  const mcpDisposers = new Map<string, () => void>()

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
    return new Promise((resolve, reject) => {
      const child = spawn(command, rest, {
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
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
        resolve(match[0])
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
    try {
      const controller = new AbortController()
      const patch = await runAuth(def, {
        onRequest: emitRequest,
        signal: controller.signal,
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
      setState(id, { status: unauthorized ? 'unauthorized' : 'error', error: message })
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
    await store.clearCredential(id)
    setState(id, { status: 'disconnected', everConnected: false, error: undefined, connectedAt: undefined })
    pendingRequests.delete(id)
  }

  ctx.effect(() => {
    for (const def of defs) {
      void (async () => {
        const credential = await store.readCredential(def.id)
        if (!credential) return
        // Refresh OAuth tokens before restoring, then register the MCP servers.
        const refreshed = await refreshOAuthToken(def, credential)
        const effective = refreshed ? await store.updateCredential(def.id, refreshed) : credential
        if (effective.accessToken) {
          await registerMcp(def)
          setState(def.id, { status: 'connected', everConnected: true })
        }
      })()
    }
    return () => {
      for (const dispose of mcpDisposers.values()) dispose()
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
      const id = decodeURIComponent(req.url?.split('/')[4] ?? '')
      const def = getDef(id)
      if (!def) return json(res, 404, { error: `unknown connector: ${id}` })
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

    const authSubmit: JsonHandler = async (req, res) => {
      const id = decodeURIComponent(req.url?.split('/')[4] ?? '')
      const raw = await readJson(req)
      if (!raw || typeof raw !== 'object' || typeof (raw as { fields?: unknown }).fields !== 'object') {
        return json(res, 400, { error: 'missing fields' })
      }
      try {
        await submitAuth(id, (raw as { fields: Record<string, string> }).fields)
        json(res, 200, { ok: true })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        json(res, 400, { error: message })
      }
    }

    const state: JsonHandler = (req, res) => {
      const id = decodeURIComponent(req.url?.split('/')[4] ?? '')
      const def = getDef(id)
      if (!def) return json(res, 404, { error: `unknown connector: ${id}` })
      const current = states.get(id) ?? { status: 'disconnected' as const, everConnected: false }
      json(res, 200, { ...current, request: pendingRequests.get(id) ?? null })
    }

    const disconnectHandler: JsonHandler = async (req, res) => {
      const id = decodeURIComponent(req.url?.split('/')[4] ?? '')
      if (!getDef(id)) return json(res, 404, { error: `unknown connector: ${id}` })
      await disconnect(id)
      json(res, 200, { ok: true })
    }

    const disposers = [
      ctx.webServer.register({ kind: 'exact', path: '/api/pico/connectors', handler: list }),
      ctx.webServer.register({ kind: 'prefix', path: '/api/pico/connectors', handler: (req, res) => {
        const segments = req.url?.split('/') ?? []
        const action = segments[5]?.split('?')[0]
        const handlers: Record<string, JsonHandler> = {
          connect: exact(connect),
          'auth-submit': exact(authSubmit),
          state: exact(state),
          disconnect: exact(disconnectHandler),
        }
        const handler = action ? handlers[action] : undefined
        if (handler) handler(req, res)
        else json(res, 404, { error: 'not found' })
      } }),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, 'pico connectors: http routes')
}

export { ConnectorStore } from './store.ts'
export type { ConnectorDef, ConnectorState, ConnectorAuthRequest } from './types.ts'
