/**
 * Embedded agent-driven browser for DSH Desktop: owns the WebContentsView tab
 * pool, the CDP sessions, the `browser_*` tool suite, and the loopback panel
 * API consumed by the client browser panel.
 *
 * HTTP API (loopback, mirroring the connectors plugin):
 *   GET  /api/pico/browser/state          -> tabs + panel + control + ops
 *   POST /api/pico/browser/panel          -> { visible, bounds? }
 *   POST /api/pico/browser/open           -> { url? }
 *   POST /api/pico/browser/navigate       -> { tab, url }
 *   POST /api/pico/browser/reload|back|forward -> { tab? }
 *   POST /api/pico/browser/close-tab      -> { tab }
 *   POST /api/pico/browser/close-all
 *   POST /api/pico/browser/takeover       -> { active }
 *   POST /api/pico/browser/clear-data
 *   GET  /api/pico/browser/ops            -> recent op log
 * @module @picoaide/dsh-browser
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createRequire } from 'node:module'
import type { IncomingMessage, ServerResponse } from 'node:http'
// Type-only: makes `ctx.get('approval')` resolve to the ApprovalService type.
import type {} from '@deepseek-ai/dsh-user-approval'
// Type-only: makes `ctx.webServer` resolve to the host webserver contract.
import type {} from '@deepseek-ai/dsh-host-webserver'
import { createRealElectronAdapter } from './electron-adapter.ts'
import { BrowserRuntime } from './runtime.ts'
import { applyBrowserTools } from './tools.ts'
import type { BrowserGuard } from './guard.ts'
import type { CredentialResolver } from './types.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'pico-browser'

/** Services required by the embedded browser. */
export const inject = ['webServer', 'tools', 'systemPrompt', 'attachments']

/** Plugin config: runtime caps and enablement. */
export interface Config {
  /** Maximum simultaneous tabs (default 8). */
  maxTabs?: number
  /** Cooperative tool-call timeout budget ms (default 30000). */
  timeoutMs?: number
  /** Cap on waiting for Electron's loadURL promise ms (default 20000). */
  loadTimeoutMs?: number
  /** Whether `browser_eval` is enabled (default true). */
  evalEnabled?: boolean
  /** Cap on snapshot entries per call (default 200). */
  snapshotLimit?: number
  /** Cap on extracted text characters per call (default 32768). */
  textLimit?: number
  /** Screenshot max width in CSS pixels (default 1280). */
  screenshotMaxWidth?: number
  /** Screenshot JPEG quality 0-100 (default 70). */
  screenshotQuality?: number
}

export const Config: z<Config> = z.object({
  maxTabs: z.number(),
  timeoutMs: z.number(),
  loadTimeoutMs: z.number(),
  evalEnabled: z.boolean(),
  snapshotLimit: z.number(),
  textLimit: z.number(),
  screenshotMaxWidth: z.number(),
  screenshotQuality: z.number(),
})

/** Cap on browser API request bodies. */
const MAX_REQUEST_BODY_BYTES = 1024 * 1024

type JsonHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void

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

function decodeSegment(segment: string | undefined): string | null {
  if (segment === undefined) return null
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}

/**
 * Register the embedded browser plugin.
 * @param ctx - Cordis context carrying the webServer, tools, systemPrompt and
 *   attachments services.
 * @param config - runtime caps and enablement.
 */
export function apply(ctx: Context, config: Config = {}): void {
  // Fail closed: without the approval service every sensitive action is
  // rejected (the desktop profile always composes it; tests inject their own).
  const askApproval: BrowserGuard['askApproval'] = async (request) => {
    const approval = ctx.get('approval')
    if (approval === undefined) return 'rejected'
    return await approval.request({
      agent: request.agent as never,
      toolName: request.toolName,
      ...request.callId !== undefined ? { callId: request.callId as import('@deepseek-ai/dsh-llm/brand').CallId } : {},
      reason: request.reason,
      ...request.signal !== undefined ? { signal: request.signal } : {},
    })
  }

  // Credential injection resolves through the connectors store (per-user
  // private files); the lookup is defensive and never logs values.
  const credentialResolver: CredentialResolver | undefined = (() => {
    try {
      // Lazy require: the connectors package must be present in the profile.
      const require = createRequire(import.meta.url)
      const { ConnectorStore } = require('@picoaide/dsh-connectors/store') as typeof import('@picoaide/dsh-connectors/store')
      const store = new ConnectorStore()
      return async (connectorId) => {
        const credential = await store.readCredential(connectorId)
        if (credential === null) return null
        const fields = credential.fields ?? {}
        const username = typeof fields.username === 'string' ? fields.username : undefined
        const password = typeof fields.password === 'string' ? fields.password : undefined
        return {
          ...username !== undefined ? { username } : {},
          ...password !== undefined ? { password } : {},
        }
      }
    } catch {
      return undefined
    }
  })()

  const runtime = new BrowserRuntime(createRealElectronAdapter(), config, askApproval, credentialResolver)

  // Tool registrations are fiber-scoped: the tools/systemPrompt registries
  // clean them up on plugin dispose, so no manual disposer is needed here.
  applyBrowserTools(ctx, runtime)

  ctx.effect(() => {
    const action = (req: IncomingMessage, res: ServerResponse): void => {
      const rawAction = decodeSegment(req.url?.split('/')[4]?.split('?')[0])
      void handleAction(rawAction, req, res).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        json(res, 400, { error: message })
      })
    }

    const handleAction = async (action: string | null, req: IncomingMessage, res: ServerResponse): Promise<void> => {
      const raw = await readJson(req)
      const body = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>

      switch (action) {
        case 'panel': {
          const visible = body.visible === true
          const b = body.bounds as Record<string, unknown> | null | undefined
          runtime.setPanel({
            visible,
            ...(visible && b !== null && typeof b === 'object'
              ? {
                  bounds: {
                    x: numberOr(b.x, 0),
                    y: numberOr(b.y, 0),
                    width: Math.max(0, numberOr(b.width, 0)),
                    height: Math.max(0, numberOr(b.height, 0)),
                  },
                }
              : {}),
          })
          json(res, 200, { ok: true })
          return
        }
        case 'open': {
          const url = typeof body.url === 'string' ? body.url : undefined
          const tab = await runtime.open(url)
          json(res, 200, { tab })
          return
        }
        case 'navigate': {
          const tab = numberOr(body.tab, 0)
          const url = typeof body.url === 'string' ? body.url : ''
          if (tab <= 0) return json(res, 400, { error: 'tab is required' })
          await runtime.navigate(tab, url)
          json(res, 200, { ok: true })
          return
        }
        case 'reload': {
          await runtime.reload(tabOf(runtime, body))
          json(res, 200, { ok: true })
          return
        }
        case 'back': {
          await runtime.goBack(tabOf(runtime, body))
          json(res, 200, { ok: true })
          return
        }
        case 'forward': {
          await runtime.goForward(tabOf(runtime, body))
          json(res, 200, { ok: true })
          return
        }
        case 'close-tab': {
          const tab = numberOr(body.tab, 0)
          if (tab <= 0) return json(res, 400, { error: 'tab is required' })
          await runtime.closeTab(tab)
          json(res, 200, { ok: true })
          return
        }
        case 'close-all': {
          await runtime.closeAll()
          json(res, 200, { ok: true })
          return
        }
        case 'takeover': {
          runtime.setUserControl(body.active === true)
          json(res, 200, { ok: true })
          return
        }
        case 'clear-data': {
          await runtime.clearData()
          json(res, 200, { ok: true })
          return
        }
        default:
          json(res, 404, { error: 'not found' })
      }
    }

    const state: JsonHandler = (_req, res) => {
      json(res, 200, {
        tabs: runtime.listTabs(),
        panel: runtime.panelState,
        controlled: runtime.controlled,
      })
    }

    const ops: JsonHandler = (_req, res) => {
      json(res, 200, { ops: runtime.opLog })
    }

    const disposers = [
      ctx.webServer.register({ kind: 'exact', path: '/api/pico/browser/state', handler: state }),
      ctx.webServer.register({ kind: 'exact', path: '/api/pico/browser/ops', handler: ops }),
      ctx.webServer.register({ kind: 'prefix', path: '/api/pico/browser', handler: action }),
    ]
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'pico browser: panel api')

  ctx.effect(() => {
    return () => {
      runtime.dispose()
    }
  }, 'pico browser: teardown')
}

/** Read a number from a JSON field with a fallback. */
function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** Resolve the tab id from a body, defaulting to the visible tab. */
function tabOf(runtime: BrowserRuntime, body: Record<string, unknown>): number {
  const explicit = numberOr(body.tab, 0)
  if (explicit > 0) return explicit
  const current = runtime.currentTabId()
  if (current === undefined) throw new Error('browser: no tab open')
  return current
}

export type { BrowserRuntime } from './runtime.ts'
export type { BrowserOpLogEntry, BrowserPanelState, BrowserSnapshotElement, BrowserTabState, BrowserToolOptions } from './types.ts'
