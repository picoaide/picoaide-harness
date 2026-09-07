/**
 * Embedded agent-driven browser for PicoAide Harness (v4): owns the
 * WebContentsView tab pool (session-grouped), the CDP sessions, the
 * `browser_*` tool suite (32), the loopback shell API + SSE push, and the
 * local stores (bookmarks/history/downloads/group ledger).
 *
 * HTTP API (loopback, same-origin fenced):
 *   GET  /api/pico/browser/state          -> groups + window + control
 *   GET  /api/pico/browser/ops            -> recent op log
 *   GET  /api/pico/browser/stream         -> SSE (state-change signals)
 *   POST /api/pico/browser/open           -> { url? } (foreground/user group)
 *   POST /api/pico/browser/navigate       -> { url } (foreground group)
 *   POST /api/pico/browser/reload|back|forward -> (foreground active tab)
 *   POST /api/pico/browser/switch-tab     -> { tab }
 *   POST /api/pico/browser/switch-group   -> { group }
 *   POST /api/pico/browser/close-tab      -> { tab }
 *   POST /api/pico/browser/close-group    -> { group }
 *   POST /api/pico/browser/show|hide|takeover|clear-data
 *   GET  /api/pico/browser/bookmarks [+ POST {url,title} / DELETE ?id=]
 *   GET  /api/pico/browser/history        -> ?q=&group=&limit=
 *   GET  /api/pico/browser/downloads [DELETE ?id=]
 *   GET  /browser-shell                   -> the browser window shell (v4)
 * @module @picoaide/dsh-browser
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createRequire } from 'node:module'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { browserPartitionFor, createRealElectronAdapter } from './electron-adapter.ts'
import { browserSameOriginMarker, isLoopbackRequest } from './loopback.ts'
import { BrowserRuntime } from './runtime.ts'
import { GroupRegistry, type GroupLedger } from './registry.ts'
import { SessionLineage } from './resolve.ts'
import { BrowserStore } from './store.ts'
import { applyBrowserTools, parseToolGroups } from './tools.ts'
import { BROWSER_SHELL_HTML } from './shell-pages.ts'
import type { CredentialResolver } from './types.ts'

// Type-only: declare the enterprise session event so `ctx.on` resolves it.
declare module '@deepseek-ai/cordis' {
  interface Events {
    'pico/session-changed'(session: { username?: string; token?: string; serverURL?: string } | null): void
    'pico/session-archived'(session: { id?: string; username?: string } | null): void
    'pico/session-reopened'(session: { id?: string; username?: string } | null): void
  }
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'pico-browser'

/** Services required by the embedded browser. */
export const inject = ['webServer', 'tools', 'systemPrompt', 'attachments']

/** Plugin config: runtime caps and enablement. */
export interface Config {
  maxTabs?: number
  timeoutMs?: number
  loadTimeoutMs?: number
  evalEnabled?: boolean
  snapshotLimit?: number
  textLimit?: number
  screenshotMaxWidth?: number
  screenshotQuality?: number
  maxGroups?: number
  maxTabsPerGroup?: number
  maxTabsTotal?: number
  waitTimeoutMs?: number
  archiveRetentionMs?: number
  downloadDir?: string
  /** Tool groups to enable (navigate/interact/read/memory/artifacts/control); default all. */
  toolGroups?: string[]
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
  maxGroups: z.number(),
  maxTabsPerGroup: z.number(),
  maxTabsTotal: z.number(),
  waitTimeoutMs: z.number(),
  archiveRetentionMs: z.number(),
  downloadDir: z.string(),
  toolGroups: z.array(z.string()),
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

/** Resolve Electron userData dir for the browser store (host-only). */
function resolveUserDataDir(): string | undefined {
  try {
    const electron = require('electron') as typeof import('electron')
    return electron.app?.getPath?.('userData')
  } catch {
    return undefined
  }
}

/**
 * Register the embedded browser plugin (v4).
 * @param ctx - Cordis context carrying webServer/tools/systemPrompt/attachments.
 * @param config - runtime caps and enablement.
 */
export function apply(ctx: Context, config: Config = {}): void {
  // 2026-08-26 product decision: browser actions run with no user-approval
  // prompt; browser use is granted through the workspace permission and the
  // browser window shows every live action (v4: activity panel).

  const currentUser = (): string | null => {
    try {
      const pico = ctx.get('picoSession') as { getSession?: () => { username?: string } | null } | undefined
      return pico?.getSession?.()?.username ?? null
    } catch {
      return null
    }
  }

  const credentialResolver: CredentialResolver | undefined = (() => {
    try {
      const require = createRequire(import.meta.url)
      const { ConnectorStore } = require('@picoaide/dsh-connectors/store') as typeof import('@picoaide/dsh-connectors/store')
      const resolveCredentials = async (connectorId: string): Promise<{ username?: string; password?: string } | null> => {
        const store = new ConnectorStore({ username: currentUser() })
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
      // List credential ids + usernames (no secrets) through the user-scope dir.
      resolveCredentials.list = async (): Promise<Array<{ id: string; username?: string }>> => {
        try {
          const { userScopePath } = require('@picoaide/dsh-connectors/user-scope') as typeof import('@picoaide/dsh-connectors/user-scope')
          const dir = join(userScopePath(currentUser()), 'connectors')
          const names: string[] = []
          try {
            for (const file of readdirSync(dir)) {
              if (file.endsWith('.json')) names.push(file.slice(0, -5))
            }
          } catch {
            return []
          }
          const store = new ConnectorStore({ username: currentUser() })
          const out: Array<{ id: string; username?: string }> = []
          for (const id of names) {
            const credential = await store.readCredential(id)
            const username = typeof credential?.fields?.username === 'string' ? credential.fields.username : undefined
            out.push({ id, ...username !== undefined ? { username } : {} })
          }
          return out
        } catch {
          return []
        }
      }
      return resolveCredentials
    } catch {
      return undefined
    }
  })()

  const userDataDir = resolveUserDataDir()
  const usernameForStore = currentUser() ?? 'anonymous'
  const store = new BrowserStore({
    dir: userDataDir !== undefined
      ? join(userDataDir, 'browser-store', encodePartitionSegment(usernameForStore))
      : join(process.cwd(), '.browser-store', encodePartitionSegment(usernameForStore)),
  })
  const registry = new GroupRegistry({
    ...(config.maxGroups !== undefined ? { maxGroups: config.maxGroups } : {}),
    ...(config.maxTabsPerGroup !== undefined || config.maxTabs !== undefined ? { maxTabsPerGroup: config.maxTabsPerGroup ?? config.maxTabs } : {}),
    ...(config.maxTabsTotal !== undefined ? { maxTabsTotal: config.maxTabsTotal } : {}),
    ...(config.waitTimeoutMs !== undefined ? { waitTimeoutMs: config.waitTimeoutMs } : {}),
    ...(config.archiveRetentionMs !== undefined ? { archiveRetentionMs: config.archiveRetentionMs } : {}),
  })
  const lineage = new SessionLineage()
  const runtime = new BrowserRuntime(
    createRealElectronAdapter(),
    config,
    credentialResolver,
    browserPartitionFor(currentUser()),
    { registry, lineage, store, currentUsername: currentUser },
  )
  runtime.setShellOrigin(`http://127.0.0.1:${String(ctx.webServer.port)}`)
  // Restore persisted group ledger (archived until reopened, v4 §10).
  runtime.restoreLedger()
  const saveLedger = (): void => {
    registry.saveLedger = (ledger: GroupLedger) => { store.saveGroupLedger(ledger) }
  }
  saveLedger()
  registry.onChange(() => saveLedger())

  // User switch: close every tab (old user's pages/login state), point new
  // tabs at the new user's partition, swap the store to the new user.
  ctx.on('pico/session-changed', (next) => {
    const username = (next as { username?: string } | null)?.username ?? null
    void (async () => {
      await runtime.closeAllGroups()
      runtime.setPartition(browserPartitionFor(username))
    })().catch((cause: unknown) => {
      ctx.logger?.error('pico-browser: session change handling failed', cause)
    })
  })

  // Session archived → archive its group (24h retention); reopened → restore.
  ctx.on('pico/session-archived', (session) => {
    const id = (session as { id?: string } | null)?.id
    if (id === undefined) return
    void runtime.archiveFor(id).catch((cause: unknown) => {
      ctx.logger?.error('pico-browser: session archive handling failed', cause)
    })
  })
  ctx.on('pico/session-reopened', (session) => {
    const id = (session as { id?: string } | null)?.id
    if (id === undefined) return
    void runtime.reactivateFor(id).catch((cause: unknown) => {
      ctx.logger?.error('pico-browser: session reopen handling failed', cause)
    })
  })
  // Lineage: subagent sessions inherit their top-level parent's group.
  const captureLineage = (sessionEvent: { id?: string; parentSession?: string; origin?: string } | null): void => {
    const id = sessionEvent?.id
    const parent = sessionEvent?.parentSession
    if (id !== undefined && parent !== undefined && sessionEvent?.origin === 'subagent') {
      lineage.registerLineage(id, parent)
    }
  }
  ctx.on('session/created' as never, captureLineage as never)

  applyBrowserTools(ctx, runtime, parseToolGroups(config.toolGroups))

  ctx.effect(() => {
    const guard = (req: IncomingMessage, res: ServerResponse): boolean => {
      if (browserSameOriginMarker(req) && isLoopbackRequest(req)) return true
      json(res, 403, { error: 'forbidden' })
      return false
    }

    const action = (req: IncomingMessage, res: ServerResponse): void => {
      const rawAction = decodeSegment(req.url?.split('/')[4]?.split('?')[0])
      void handleAction(rawAction, req, res).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        json(res, 400, { error: message })
      })
    }

    const foregroundRequired = (): string => {
      const fg = runtime.foreground
      if (fg === undefined) throw new Error('browser: no session group — open a tab first')
      return fg
    }

    const handleAction = async (actionName: string | null, req: IncomingMessage, res: ServerResponse): Promise<void> => {
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
      if (!guard(req, res)) return
      const raw = await readJson(req)
      const body = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>

      switch (actionName) {
        case 'show': {
          await runtime.showWindow()
          json(res, 200, { ok: true })
          return
        }
        case 'hide': {
          runtime.hideWindow()
          json(res, 200, { ok: true })
          return
        }
        case 'takeover': {
          runtime.setUserControl(body.active === true)
          json(res, 200, { ok: true })
          return
        }
        case 'open': {
          const url = typeof body.url === 'string' ? body.url : undefined
          // Shell `+`: the USER's surface — bypass the takeover mutex.
          const tab = await runtime.userOpen(url)
          json(res, 200, { tab })
          return
        }
        case 'navigate': {
          const url = typeof body.url === 'string' ? body.url : ''
          await runtime.navigateUser(url)
          json(res, 200, { ok: true })
          return
        }
        case 'reload': {
          const fg = foregroundRequired()
          const tab = runtime.registry.activeTabOf(fg)
          if (tab !== undefined) await runtime.reloadFor(fg, tab, undefined, true)
          json(res, 200, { ok: true })
          return
        }
        case 'back': {
          const fg = foregroundRequired()
          const tab = runtime.registry.activeTabOf(fg)
          if (tab !== undefined) await runtime.goBackFor(fg, tab, undefined, true)
          json(res, 200, { ok: true })
          return
        }
        case 'forward': {
          const fg = foregroundRequired()
          const tab = runtime.registry.activeTabOf(fg)
          if (tab !== undefined) await runtime.goForwardFor(fg, tab, undefined, true)
          json(res, 200, { ok: true })
          return
        }
        case 'switch-tab': {
          const fg = foregroundRequired()
          const tab = typeof body.tab === 'number' ? body.tab : undefined
          if (tab === undefined) return json(res, 400, { error: 'tab is required' })
          await runtime.switchTabFor(fg, tab, undefined)
          json(res, 200, { ok: true })
          return
        }
        case 'switch-group': {
          const group = typeof body.group === 'string' ? body.group : undefined
          if (group === undefined) return json(res, 400, { error: 'group is required' })
          runtime.switchGroup(group)
          json(res, 200, { ok: true })
          return
        }
        case 'close-tab': {
          const fg = foregroundRequired()
          const tab = typeof body.tab === 'number' ? body.tab : runtime.registry.activeTabOf(fg)
          if (tab === undefined) return json(res, 400, { error: 'tab is required' })
          await runtime.closeTabFor(fg, tab, undefined, true)
          json(res, 200, { ok: true })
          return
        }
        case 'close-group': {
          const group = typeof body.group === 'string' ? body.group : undefined
          if (group === undefined) return json(res, 400, { error: 'group is required' })
          await runtime.closeGroup(group)
          json(res, 200, { ok: true })
          return
        }
        case 'clear-data': {
          await runtime.clearDataFor(foregroundRequired(), 'all-data')
          json(res, 200, { ok: true })
          return
        }
        default:
          json(res, 404, { error: 'not found' })
      }
    }

    const state: JsonHandler = (req, res) => {
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
      if (!guard(req, res)) return
      json(res, 200, runtime.shellState())
    }

    const ops: JsonHandler = (req, res) => {
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
      if (!guard(req, res)) return
      json(res, 200, { ops: runtime.opLog })
    }

    // SSE stream: signals only; clients re-pull /state on each event.
    const stream: JsonHandler = (req, res) => {
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
      if (!guard(req, res)) return
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      })
      res.write('retry: 1500\n\n')
      const off = runtime.onAny((event) => {
        res.write(`event: ${event}\ndata: {}\n\n`)
      })
      const heartbeat = setInterval(() => {
        res.write(': ping\n\n')
      }, 15_000)
      const timer = heartbeat
      res.on('close', () => {
        clearInterval(timer)
        off()
      })
    }

    const bookmarksGet: JsonHandler = (req, res) => {
      if (!guard(req, res)) return
      const url = new URL(req.url ?? '/', 'http://localhost')
      json(res, 200, { bookmarks: runtime.listBookmarksFor({ q: url.searchParams.get('q') ?? undefined, limit: num(url.searchParams.get('limit'), 200) }) })
    }
    const bookmarksPost: JsonHandler = async (req, res) => {
      if (!guard(req, res)) return
      const raw = await readJson(req)
      const body = (raw ?? {}) as { url?: string; label?: string }
      const fg = runtime.foreground
      if (fg === undefined) return json(res, 400, { error: 'no session group to attribute the bookmark to' })
      const tab = runtime.registry.activeTabOf(fg)
      if (tab === undefined) return json(res, 400, { error: 'no tab open in the foreground session' })
      // Bookmark for the foreground group (user-side add).
      const entry = runtime.addBookmarkFor(fg, tab, body.label)
      json(res, 200, { id: entry.id, url: entry.url, title: body.label ?? entry.title })
    }
    const bookmarksDelete: JsonHandler = (req, res) => {
      if (!guard(req, res)) return
      const url = new URL(req.url ?? '/', 'http://localhost')
      const id = num(url.searchParams.get('id'), undefined)
      if (id === undefined) return json(res, 400, { error: 'id is required' })
      json(res, 200, { ok: runtime.removeBookmarkFor(id) })
    }

    const historyGet: JsonHandler = (req, res) => {
      if (!guard(req, res)) return
      const url = new URL(req.url ?? '/', 'http://localhost')
      json(res, 200, {
        entries: runtime.historyFor({
          q: url.searchParams.get('q') ?? undefined,
          group: url.searchParams.get('group') ?? undefined,
          limit: num(url.searchParams.get('limit'), 100),
        }),
      })
    }

    const downloadsGet: JsonHandler = (req, res) => {
      if (!guard(req, res)) return
      const url = new URL(req.url ?? '/', 'http://localhost')
      const status = url.searchParams.get('status')
      json(res, 200, {
        downloads: runtime.downloadsFor({
          status: status !== null && ['in-progress', 'done', 'cancelled', 'rejected'].includes(status) ? status as 'done' : undefined,
          limit: num(url.searchParams.get('limit'), 100),
        }),
      })
    }
    const downloadsDelete: JsonHandler = (req, res) => {
      if (!guard(req, res)) return
      const url = new URL(req.url ?? '/', 'http://localhost')
      const id = num(url.searchParams.get('id'), undefined)
      if (id === undefined) return json(res, 400, { error: 'id is required' })
      json(res, 200, { ok: runtime.removeDownloadFor(id) })
    }

    const html = (content: string): JsonHandler => (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(content)
    }

    const disposers = [
      ctx.webServer.register({ kind: 'exact', path: '/api/pico/browser/state', handler: state }),
      ctx.webServer.register({ kind: 'exact', path: '/api/pico/browser/ops', handler: ops }),
      ctx.webServer.register({ kind: 'exact', path: '/api/pico/browser/stream', handler: stream }),
      ctx.webServer.register({ kind: 'prefix', path: '/api/pico/browser', handler: action }),
      ctx.webServer.register({ kind: 'exact', path: '/api/pico/browser/bookmarks', handler: bookmarksGet }),
      ctx.webServer.register({ kind: 'prefix', path: '/api/pico/browser/bookmarks', handler: (req, res) => {
        void (async () => {
          if (req.method === 'POST') return await bookmarksPost(req, res)
          if (req.method === 'DELETE') return bookmarksDelete(req, res)
          json(res, 405, { error: 'method not allowed' })
        })().catch((cause: unknown) => json(res, 400, { error: cause instanceof Error ? cause.message : String(cause) }))
      } }),
      ctx.webServer.register({ kind: 'exact', path: '/api/pico/browser/history', handler: historyGet }),
      ctx.webServer.register({ kind: 'exact', path: '/api/pico/browser/downloads', handler: downloadsGet }),
      ctx.webServer.register({ kind: 'prefix', path: '/api/pico/browser/downloads', handler: (req, res) => {
        if (req.method === 'DELETE') return downloadsDelete(req, res)
        json(res, 405, { error: 'method not allowed' })
      } }),
      ctx.webServer.register({ kind: 'exact', path: '/browser-shell', handler: html(BROWSER_SHELL_HTML) }),
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

/** Read a number from a string with a fallback. */
function num(value: string | null, fallback: number | undefined): number | undefined {
  if (value === null) return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

/** Encode the per-user store key (reflects the partition encoding). */
function encodePartitionSegment(segment: string): string {
  let out = ''
  for (const char of segment) {
    const code = char.codePointAt(0)!
    if ((code >= 0x30 && code <= 0x39)
      || (code >= 0x41 && code <= 0x5a)
      || (code >= 0x61 && code <= 0x7a)
      || char === '-' || char === '_') {
      out += char
    } else {
      out += `~${code.toString(16).toUpperCase()}~`
    }
  }
  return out.length === 0 ? 'anonymous' : out
}

export type { BrowserRuntime } from './runtime.ts'
export type { BrowserOpLogEntry, BrowserSnapshotElement, BrowserTabState, BrowserToolOptions, BrowserWindowState } from './types.ts'
