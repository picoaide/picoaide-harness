/**
 * Embedded agent-driven browser for PicoAide Harness (v4.2 single pool):
 * owns the WebContentsView tab pool, the CDP sessions, the `browser_*` tool
 * suite, the loopback shell API + SSE push, the programmatic download path,
 * the AI interception mask page, and the local stores.
 *
 * HTTP API (loopback, same-origin fenced):
 *   GET  /api/pico/browser/state          -> tabs + window + busy + control
 *   GET  /api/pico/browser/ops            -> recent op log
 *   GET  /api/pico/browser/stream         -> SSE (state-change signals)
 *   POST /api/pico/browser/open           -> { url? } (user new tab)
 *   POST /api/pico/browser/navigate       -> { url } (user address bar)
 *   POST /api/pico/browser/reload|back|forward -> (active tab)
 *   POST /api/pico/browser/switch-tab     -> { tab }
 *   POST /api/pico/browser/close-tab      -> { tab }
 *   POST /api/pico/browser/show|hide|takeover|clear-data
 *   GET  /api/pico/browser/bookmarks [+ POST / DELETE ?id=]
 *   GET  /api/pico/browser/history        -> ?q=&limit=
 *   GET  /api/pico/browser/downloads      [DELETE ?id=]
 *   GET  /browser-shell | /browser-overlay -> toolbar shell + AI UI overlay pages
 * @module @picoaide/dsh-browser
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createRequire } from 'node:module'
import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { browserPartitionFor, createRealElectronAdapter } from './electron-adapter.ts'
import { browserSameOriginMarker, isLoopbackRequest } from './loopback.ts'
import { BrowserRuntime } from './runtime.ts'
import { TabPool } from './pool.ts'
import { BrowserStore } from './store.ts'
import { applyBrowserTools, parseToolGroups } from './tools.ts'
import { BROWSER_SHELL_HTML, BROWSER_OVERLAY_HTML } from './shell-pages.ts'
import type { CredentialResolver } from './types.ts'
import type { DownloadEntry } from './store.ts'
type DownloadEntryStatus = DownloadEntry['status']

// Type-only: declare the enterprise session event so `ctx.on` resolves it.
declare module '@deepseek-ai/cordis' {
  interface Events {
    'pico/session-changed'(session: { username?: string; token?: string; serverURL?: string } | null): void
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
  waitTimeoutMs?: number
  downloadDir?: string
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
  waitTimeoutMs: z.number(),
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
 * Register the embedded browser plugin (v4.2 single pool).
 * @param ctx - Cordis context carrying webServer/tools/systemPrompt/attachments.
 * @param config - runtime caps and enablement.
 */
export function apply(ctx: Context, config: Config = {}): void {
  // 2026-08-26 product decision: browser actions run with no user-approval
  // prompt; browser use is granted through the workspace permission and the
  // browser window shows every live action (mask + activity panel).

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
  // P2-38b: with no Electron userData dir (headless loader smoke, tests) the
  // store must NOT fall back to a cwd-relative `<cwd>/.browser-store` — that
  // silently writes untracked files into whatever directory the process
  // started in. Use the product DSH home instead (same source as downloadDir),
  // resolved through the shared connectors user-scope module.
  const fallbackDataRoot = (): string => {
    try {
      const require = createRequire(import.meta.url)
      const { dshHomePath } = require('@picoaide/dsh-connectors/user-scope') as typeof import('@picoaide/dsh-connectors/user-scope')
      return dshHomePath()
    } catch {
      return join(homedir(), '.picoaide-harness')
    }
  }
  const storeDirFor = (username: string): string => join(
    userDataDir !== undefined ? join(userDataDir, 'browser-store') : join(fallbackDataRoot(), 'browser-store'),
    encodePartitionSegment(username),
  )
  let store = new BrowserStore({ dir: storeDirFor(usernameForStore) })
  const pool = new TabPool({
    ...(config.maxTabs !== undefined ? { maxTabs: config.maxTabs } : {}),
    ...(config.waitTimeoutMs !== undefined ? { waitTimeoutMs: config.waitTimeoutMs } : {}),
  })
  const runtime = new BrowserRuntime(
    createRealElectronAdapter(),
    {
      ...config,
      downloadDir: config.downloadDir ?? (userDataDir !== undefined ? join(userDataDir, 'downloads') : join(fallbackDataRoot(), 'downloads')),
    },
    credentialResolver,
    browserPartitionFor(currentUser()),
    { pool, store, currentUsername: currentUser },
  )
  runtime.setShellOrigin(`http://127.0.0.1:${String(ctx.webServer.port)}`)
  // Restore the persisted tab ledger; keep it fresh on every tab change (ops/
  // busy events never change the ledger — persisting on them would sync-write
  // the file on every operation).
  runtime.restoreLedger()
  runtime.onAny((event) => {
    if (event === 'tab' || event === 'tab-meta') runtime.saveLedger()
  })

  const switchStoreForUser = (username: string | null): void => {
    const name = username ?? 'anonymous'
    store = new BrowserStore({ dir: storeDirFor(name) })
    runtime.setStore(store)
    runtime.restoreLedger()
    // Persist the freshly restored ledger immediately (the pool may be empty).
    runtime.saveLedger()
  }

  // User switch: close every tab, point new tabs at the new user's partition
  // and swap the per-user browser store (bookmarks/history/downloads/ledger).
  ctx.on('pico/session-changed', (next) => {
    const username = (next as { username?: string } | null)?.username ?? null
    const user = username !== null && username !== undefined && username.length > 0 ? username : null
    void (async () => {
      // Login switch / logout destroys background tabs (2026-09-08 product
      // decision), then prewarms the new user's browser HIDDEN so the agent
      // keeps a live CDP surface without any user action.
      await runtime.closeAll(true)
      // P1-19: the op log (hosts, paths, token-bearing URLs) is per-account —
      // the new user must never read the previous account's trail via the
      // activity panel or GET /ops.
      runtime.clearOps()
      runtime.setPartition(browserPartitionFor(user))
      switchStoreForUser(user)
      await runtime.prewarm()
    })().catch((cause: unknown) => {
      ctx.logger?.error('pico-browser: session change handling failed', cause)
    })
  })

  // P2-29: the tool registrations are released with the plugin fiber.
  ctx.effect(
    () => applyBrowserTools(ctx, runtime, parseToolGroups(config.toolGroups)),
    'pico-browser: tool suite',
  )

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

    const activeTab = (): number => {
      const tab = runtime.currentTabId()
      if (tab === undefined) throw new Error('browser: no tab open — use ＋ to open one first')
      return tab
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
        case 'overlay': {
          const mode = typeof body.mode === 'string' ? body.mode : undefined
          if (mode === undefined || !['capsule', 'panel', 'menu', 'viewer'].includes(mode)) {
            return json(res, 400, { error: 'mode must be one of capsule/panel/menu/viewer' })
          }
          runtime.setOverlayMode(mode as 'capsule' | 'panel' | 'menu' | 'viewer')
          json(res, 200, { ok: true })
          return
        }
        case 'open': {
          const url = typeof body.url === 'string' ? body.url : undefined
          // Shell `+`: the USER's surface — bypasses the agent mutex.
          const tab = await runtime.open(url, undefined, true)
          json(res, 200, { tab })
          return
        }
        case 'navigate': {
          const url = typeof body.url === 'string' ? body.url : ''
          if (url.trim() === '') return json(res, 400, { error: 'url is required' })
          await runtime.navigateUser(url.trim())
          json(res, 200, { ok: true })
          return
        }
        case 'reload': {
          if (runtime.currentTabId() !== undefined) await runtime.reload(activeTab(), undefined, true)
          json(res, 200, { ok: true })
          return
        }
        case 'back': {
          if (runtime.currentTabId() !== undefined) await runtime.goBack(activeTab(), undefined, true)
          json(res, 200, { ok: true })
          return
        }
        case 'forward': {
          if (runtime.currentTabId() !== undefined) await runtime.goForward(activeTab(), undefined, true)
          json(res, 200, { ok: true })
          return
        }
        case 'switch-tab': {
          const tab = typeof body.tab === 'number' ? body.tab : undefined
          if (tab === undefined) return json(res, 400, { error: 'tab is required' })
          await runtime.switchTab(tab, true)
          json(res, 200, { ok: true })
          return
        }
        case 'close-tab': {
          const tab = typeof body.tab === 'number' ? body.tab : runtime.currentTabId()
          if (tab === undefined) return json(res, 400, { error: 'tab is required' })
          await runtime.closeTab(tab, true)
          json(res, 200, { ok: true })
          return
        }
        case 'clear-data': {
          await runtime.clearData(true)
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
      res.on('close', () => {
        clearInterval(heartbeat)
        off()
      })
    }

    const bookmarksGet: JsonHandler = (req, res) => {
      if (!guard(req, res)) return
      const url = new URL(req.url ?? '/', 'http://localhost')
      json(res, 200, {
        bookmarks: runtime.listBookmarks({
          q: url.searchParams.get('q') ?? undefined,
          limit: num(url.searchParams.get('limit'), 200),
        }),
      })
    }
    const bookmarksPost: JsonHandler = async (req, res) => {
      if (!guard(req, res)) return
      const body = await readJson(req) as { title?: string } | null
      const tab = runtime.currentTabId()
      if (tab === undefined) return json(res, 400, { error: 'no tab open to bookmark' })
      const entry = runtime.addBookmark(tab, body?.title, 'user')
      json(res, 200, { id: entry.id, url: entry.url, title: body?.title ?? entry.title })
    }
    const bookmarksDelete: JsonHandler = (req, res) => {
      if (!guard(req, res)) return
      const url = new URL(req.url ?? '/', 'http://localhost')
      const id = num(url.searchParams.get('id'), undefined)
      if (id === undefined) return json(res, 400, { error: 'id is required' })
      json(res, 200, { ok: runtime.removeBookmark(id) })
    }

    const historyGet: JsonHandler = (req, res) => {
      if (!guard(req, res)) return
      const url = new URL(req.url ?? '/', 'http://localhost')
      json(res, 200, {
        entries: runtime.history({
          q: url.searchParams.get('q') ?? undefined,
          limit: num(url.searchParams.get('limit'), 100),
        }),
      })
    }

    const downloadsGet: JsonHandler = (req, res) => {
      if (!guard(req, res)) return
      const url = new URL(req.url ?? '/', 'http://localhost')
      const rawStatus = url.searchParams.get('status')
      const status = rawStatus !== null && ['in-progress', 'done', 'cancelled', 'rejected'].includes(rawStatus)
        ? rawStatus as DownloadEntryStatus
        : undefined
      json(res, 200, {
        downloads: runtime.downloads({
          status,
          limit: num(url.searchParams.get('limit'), 100),
        }),
      })
    }
    const downloadsDelete: JsonHandler = (req, res) => {
      if (!guard(req, res)) return
      const url = new URL(req.url ?? '/', 'http://localhost')
      const id = num(url.searchParams.get('id'), undefined)
      if (id === undefined) return json(res, 400, { error: 'id is required' })
      json(res, 200, { ok: runtime.removeDownload(id) })
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
      ctx.webServer.register({ kind: 'exact', path: '/api/pico/browser/bookmarks', handler: (req, res) => {
        void (async () => {
          if (req.method === 'GET') return bookmarksGet(req, res)
          if (req.method === 'POST') return await bookmarksPost(req, res)
          if (req.method === 'DELETE') return bookmarksDelete(req, res)
          json(res, 405, { error: 'method not allowed' })
        })().catch((cause: unknown) => json(res, 400, { error: cause instanceof Error ? cause.message : String(cause) }))
      } }),
      ctx.webServer.register({ kind: 'exact', path: '/api/pico/browser/history', handler: historyGet }),
      ctx.webServer.register({ kind: 'exact', path: '/api/pico/browser/downloads', handler: (req, res) => {
        if (req.method === 'GET') return downloadsGet(req, res)
        if (req.method === 'DELETE') return downloadsDelete(req, res)
        json(res, 405, { error: 'method not allowed' })
      } }),
      ctx.webServer.register({ kind: 'exact', path: '/api/pico/browser/downloads/open', handler: (req, res) => {
        void (async () => {
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
          if (!guard(req, res)) return
          const body = await readJson(req) as { id?: number } | null
          const id = body !== null && typeof body.id === 'number' ? body.id : undefined
          if (id === undefined) return json(res, 400, { error: 'id is required' })
          try {
            json(res, 200, await runtime.openDownloadPath(id))
          } catch (cause) {
            json(res, 400, { error: cause instanceof Error ? cause.message : String(cause) })
          }
        })().catch((cause: unknown) => json(res, 400, { error: cause instanceof Error ? cause.message : String(cause) }))
      } }),
      ctx.webServer.register({ kind: 'exact', path: '/browser-shell', handler: html(BROWSER_SHELL_HTML) }),
      ctx.webServer.register({ kind: 'exact', path: '/browser-overlay', handler: html(BROWSER_OVERLAY_HTML) }),
    ]
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'pico browser: panel api')

  // Boot prewarm (2026-09-08 product decision): the browser window, the
  // restored ledger tabs and their CDP sessions come up at client start —
  // HIDDEN. The agent can therefore drive the browser with no user action,
  // and the shell's 浏览器 button merely shows the already-running window.
  void runtime.prewarm().catch((cause: unknown) => {
    ctx.logger?.warn('pico-browser: prewarm failed', cause)
  })

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
