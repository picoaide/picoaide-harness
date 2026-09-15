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
import { CookieHandoff } from './cookie-handoff.ts'
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

/**
 * 上游 `connection` 服务（BrowserAuth 持有性检查）在本包内需要的**最小结构**。
 *
 * 与 `packages/host/enterprise/src/auth-gate.ts` 的 `ConnectionTrustFence` 同形：
 * 刻意不 `import type {} from '@deepseek-ai/dsh-client-connection'`（那会给本包
 * 增加一条依赖边），只要运行时存在性判断 + 一个方法。
 */
interface ConnectionTrustFence {
  /**
   * Connection 的 Host/Origin 围栏 + BrowserAuth cookie 校验。
   * @param request - 只用到 headers(Host / Cookie)。
   * @returns 401/403 表示拒绝；undefined 表示通过。
   */
  requestRejection(request: { headers: IncomingMessage['headers'] }): 401 | 403 | undefined
}

/** BrowserAuth cookie 前缀（上游 `client-connection/browser-auth.ts`）。 */
const BROWSER_AUTH_COOKIE_PREFIX = 'dsh-auth-'

/**
 * `require('electron')` 在本模块内需要的**最小结构**（只用于 cookie 交接）。
 *
 * 同 `electron-adapter.ts` 的理由：`electron` 是 peerDependency、只在
 * Electron 宿主里可用，类型面刻意收窄到用到的两个 session 入口。
 */
interface ElectronCookieLike {
  name: string
  value: string
  path?: string
  httpOnly?: boolean
  secure?: boolean
  sameSite?: 'unspecified' | 'no_restriction' | 'lax' | 'strict'
  expirationDate?: number
}

interface ElectronSessionLike {
  cookies: {
    get(filter: { url: string }): Promise<ElectronCookieLike[]>
    set(details: Record<string, unknown>): Promise<void>
  }
}

interface ElectronLike {
  session?: {
    defaultSession?: ElectronSessionLike
    fromPartition?(partition: string): ElectronSessionLike
  }
}

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
/**
 * fence（交互证明闸）是否处于"能用"状态。
 *
 * 闸门（`proofOfPossession`）与票据交接表（`CookieHandoff.fenceAvailable`）**必须**
 * 用同一判据（2026-09-15 审计 F3）：只看"服务在不在"会让交接在
 * `requestRejection` 缺失时"假成功即停表"，之后每次写都被 503 拒且不再重试。
 * @param service - `ctx.get('connection')` 的返回值（任意宿主形状）。
 * @returns 服务存在且 `requestRejection` 可用时为 true。
 */
export function connectionFenceReady(service: unknown): service is ConnectionTrustFence {
  return service !== undefined && service !== null
    && typeof (service as { requestRejection?: unknown }).requestRejection === 'function'
}

/** 用户切换的四个步骤（导出以便确定性单测顺序与容错）。 */
export interface SessionSwitchSteps {
  /** 身份相关：分区 + store + 票据交接（**必须**执行，失败即串账号）。 */
  applyUserScope: () => void
  /** 破坏性清理：关掉上一个账号的标签页（可能因窗口销毁竞态抛错）。 */
  closeAll: () => Promise<void>
  /** 审计轨迹按账号隔离。 */
  clearOps: () => void
  /** 重建隐藏窗口，让 agent 保持可驱动的 CDP 面。 */
  prewarm: () => Promise<void>
  /** 清理失败的告警出口。 */
  warn: (message: string, cause: unknown) => void
}

/**
 * 执行一次用户切换（2026-09-15 审计 F2 的修复形态）。
 *
 * 顺序：**先切身份，再做清理**。旧实现把 `closeAll` 放在链首，它一旦抛错
 * （窗口/视图销毁竞态）就被 catch 吞掉后面的全部步骤：界面已换账号、浏览器却
 * 还在旧账号的分区与书签/历史上，交接也不重来。
 * @param steps - 四个步骤 + 告警出口。
 */
export async function runSessionSwitch(steps: SessionSwitchSteps): Promise<void> {
  steps.applyUserScope()
  try {
    await steps.closeAll()
  } catch (cause) {
    steps.warn('pico-browser: closing tabs during the user switch failed', cause)
  }
  steps.clearOps()
  await steps.prewarm()
}

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
  const shellOrigin = `http://127.0.0.1:${String(ctx.webServer.port)}`
  runtime.setShellOrigin(shellOrigin)

  /**
   * R7-RV-3 证明交接：本插件自己服务的两个页面（`/browser-shell` 与
   * `/browser-overlay`）里的写操作也必须带上 BrowserAuth cookie，否则接管
   * 按钮、隐藏窗口、书签、下载打开这些正常按钮会在 `requireWriteProof` 下
   * 变成 403（那是"修好漏洞、弄坏产品"）。
   *
   * shell 窗口与主应用窗口同用默认 Electron session，token 换票后天然持有
   * cookie；**overlay（mask view）跑在 `persist:agent-browser-<user>` 分区里，
   * 是另一个 cookie jar**。这里把应用 session 里回环源的 `dsh-auth-*` cookie
   * 镜像进浏览器分区：两个页面都由本插件在同一回环源上服务，cookie 保持
   * HttpOnly + SameSite=Strict（浏览器分区里的任意站点读不到它，跨站请求也
   * 带不出去），本机其它进程更无法凭空造出 HMAC 签名。
   *
   * 开机时序：prewarm 建 overlay 与主窗口 load 是并发的，cookie 可能还没换出来
   * ——所以交接**反复尝试到成功一次**（首次成功即停表），用户切换分区时重来。
   * 两次尝试之间的间隔按 1s→2s→…→30s 退避（登录可能晚于开机很久）。
   * 非 Electron 宿主（headless loader / 单测）里 `require('electron')` 直接抛错，
   * 交接是 no-op，路由仍由 fence 决定（缺席即 fail-closed 503）。
   */
  const mirrorBrowserAuthCookies = async (): Promise<boolean> => {
    let electron: ElectronLike | undefined
    try {
      electron = createRequire(import.meta.url)('electron') as ElectronLike
    } catch {
      return false // 非 Electron 宿主：无需交接
    }
    const from = electron.session?.defaultSession
    const to = electron.session?.fromPartition?.(browserPartitionFor(currentUser()))
    if (from === undefined || to === undefined) return false
    const cookies = await from.cookies.get({ url: shellOrigin })
    const auth = cookies.filter((cookie) => cookie.name.startsWith(BROWSER_AUTH_COOKIE_PREFIX))
    if (auth.length === 0) return false
    for (const cookie of auth) {
      await to.cookies.set({
        url: shellOrigin,
        name: cookie.name,
        value: cookie.value,
        path: cookie.path ?? '/',
        httpOnly: cookie.httpOnly ?? true,
        secure: cookie.secure ?? false,
        ...(cookie.sameSite === undefined ? {} : { sameSite: cookie.sameSite }),
        ...(cookie.expirationDate === undefined ? {} : { expirationDate: cookie.expirationDate }),
      })
    }
    return true
  }

  /**
   * 票据交接表：反复把应用 session 的 BrowserAuth 证明镜像进**当前**浏览器分区，
   * 直到成功一次（分区里有票即停）。退避重试与"fence 缺席也要排队"的口径见
   * `cookie-handoff.ts` —— 2026-09-15 恢复型启动 P0 就是这里一次判死造成的。
   */
  const cookieHandoff = new CookieHandoff({
    // 判据必须与真正的闸门**同口径**（2026-09-15 审计 F3）：闸门在服务缺席
    // **或** `requestRejection` 不是函数时 fail-closed 503。只看"服务在不在"
    // 会让交接"假成功即停表"，随后每次写都被 503 拒且不再重试 —— 正是现场
    // "只有 refuse、没有 handoff"的镜像形态。
    fenceAvailable: () => connectionFenceReady((ctx as unknown as { get?: (name: string) => unknown }).get?.('connection')),
    mirror: mirrorBrowserAuthCookies,
    schedule: (run, delayMs) => setTimeout(run, delayMs),
    cancel: (handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>) },
    warn: (message, cause) => { ctx.logger?.warn?.(message, cause) },
  })
  const startCookieHandoff = (): void => { cookieHandoff.start() }
  const stopCookieHandoff = (): void => { cookieHandoff.stop() }

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

  /**
   * 把"当前用户作用域"切到 `user`：分区 + 书签/历史/下载 store + 票据交接。
   *
   * 幂等、可从任意路径重复调用（`setPartition` 同值短路、交接表可重启），因此
   * 它同时服务三个入口：启动期补采样、`pico/session-changed`、以及失败重试。
   */
  const applyUserScope = (user: string | null): void => {
    runtime.setPartition(browserPartitionFor(user))
    switchStoreForUser(user)
    startCookieHandoff()
  }

  // User switch: point new tabs at the new user's partition and swap the
  // per-user browser store (bookmarks/history/downloads/ledger), then close the
  // previous account's tabs and prewarm HIDDEN so the agent keeps a live CDP
  // surface without any user action.
  ctx.on('pico/session-changed', (next) => {
    const username = (next as { username?: string } | null)?.username ?? null
    const user = username !== null && username !== undefined && username.length > 0 ? username : null
    void runSessionSwitch({
      applyUserScope: () => { applyUserScope(user) },
      // Login switch / logout destroys background tabs (2026-09-08 decision).
      closeAll: async () => { await runtime.closeAll(true) },
      // P1-19: the op log (hosts, paths, token-bearing URLs) is per-account —
      // the new user must never read the previous account's trail via the
      // activity panel or GET /ops.
      clearOps: () => { runtime.clearOps() },
      prewarm: async () => { await runtime.prewarm() },
      warn: (message, cause) => { ctx.logger?.warn?.(message, cause) },
    }).catch((cause: unknown) => {
      ctx.logger?.error('pico-browser: session change handling failed', cause)
    })
  })

  // P2-29: the tool registrations are released with the plugin fiber.
  ctx.effect(
    () => applyBrowserTools(ctx, runtime, parseToolGroups(config.toolGroups)),
    'pico-browser: tool suite',
  )

  // R7-RV-3：开机即开始把应用 session 的 BrowserAuth cookie 交接进浏览器分区
  // （overlay 页在 prewarm 时就会加载，早于主窗口换票完成）。
  ctx.effect(() => {
    startCookieHandoff()
    return stopCookieHandoff
  }, 'pico browser: browser-auth cookie handoff')

  ctx.effect(() => {
    /**
     * `guard()` 之上再要一份持有性证明（第三轮 R7-RV-3；与 enterprise
     * `auth-gate.ts` 的 r7c-6 同一口径、同一机制）。
     *
     * `loopback.ts:60-64` 自述的边界就是"伪造 Origin 的 curl 也能过"：本机任意
     * 进程伪造 `Origin`/`Host`/`Sec-Fetch-Site` 就能 `POST /api/pico/browser/eval`
     * 以用户已登录身份操作任意站点、`clear-data` 抹掉用户浏览器数据。证明 =
     * 上游 `connection` 服务的 BrowserAuth cookie（`dsh-auth-<authority>`：
     * HttpOnly + SameSite=Strict + HMAC，只能由本进程服务、经 launch token 换票
     * 的页面持有），直接复用 `connection.requestRejection()`，不新造机制。
     *
     * 口径与 login/enterprise 写面一致：fence 缺席 ⇒ fail-closed 503（退回
     * `guard()` 等于把"伪造 Origin 即可"重新放进来）；读面（GET）维持 `guard()`。
     */
    const proofOfPossession = (req: IncomingMessage, res: ServerResponse): boolean => {
      const fence = (ctx as unknown as { get?: (name: string) => unknown }).get?.('connection') as ConnectionTrustFence | undefined
      if (!connectionFenceReady(fence)) {
        // 与 401/403 分支同口径带上路由（2026-09-15 审计 F5）：现场若 fence 缺席，
        // 只有一句 "connection service unavailable" 同样指不到是哪个页面的哪个请求。
        ctx.logger?.warn?.(`pico-browser: connection service unavailable; refusing a local write (fail-closed) [${req.method ?? 'POST'} ${(req.url ?? '').split('?')[0] ?? ''}]`)
        json(res, 503, {
          error: 'browser session proof unavailable',
          hint: 'reopen the application window from its launch URL',
        })
        return false
      }
      let rejection: 401 | 403 | undefined
      try {
        rejection = fence.requestRejection({ headers: req.headers })
      } catch (err) {
        // 校验器自身抛错 = 无法证明 ⇒ 按拒绝处理（不把异常泄漏成 500）。
        ctx.logger?.warn?.(`pico-browser: browser proof check failed (${err instanceof Error ? err.message : String(err)})`)
        rejection = 403
      }
      if (rejection === undefined) return true
      // 诊断口径（2026-09-14）：日志必须说清**是哪个页面的哪条路由**被拒——
      // 现场只看到 "refused a local write without browser proof (401)" 时，无法
      // 区分 shell 页（默认 session，天然持票）与 overlay 蒙版页（浏览器分区，
      // 靠 cookie 交接）。只记 pathname，丢掉 query（可能带用户数据）。
      ctx.logger?.warn?.(`pico-browser: refused a local write without browser proof (${String(rejection)}) [${req.method ?? 'POST'} ${(req.url ?? '').split('?')[0] ?? ''}]`)
      json(res, 403, {
        error: 'browser session proof required',
        hint: 'reopen the application window from its launch URL',
      })
      return false
    }
    const requireWriteProof = (req: IncomingMessage, res: ServerResponse): boolean =>
      req.method === 'GET' || proofOfPossession(req, res)

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
      if (!requireWriteProof(req, res)) return
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
          // 交接表在首次成功后停表（见 startCookieHandoff），而「清除全部数据」
          // 会连 cookie 一起清掉：蒙版页持有的 BrowserAuth 证明随之消失，此后
          // 接管/面板按钮全部 403。清完立刻再交接一次，把票据补回分区。
          startCookieHandoff()
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
      if (!requireWriteProof(req, res)) return
      const body = await readJson(req) as { title?: string } | null
      const tab = runtime.currentTabId()
      if (tab === undefined) return json(res, 400, { error: 'no tab open to bookmark' })
      const entry = runtime.addBookmark(tab, body?.title, 'user')
      json(res, 200, { id: entry.id, url: entry.url, title: body?.title ?? entry.title })
    }
    const bookmarksDelete: JsonHandler = (req, res) => {
      if (!guard(req, res)) return
      if (!requireWriteProof(req, res)) return
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
      if (!requireWriteProof(req, res)) return
      const url = new URL(req.url ?? '/', 'http://localhost')
      const id = num(url.searchParams.get('id'), undefined)
      if (id === undefined) return json(res, 400, { error: 'id is required' })
      json(res, 200, { ok: runtime.removeDownload(id) })
    }

    const html = (content: string): JsonHandler => (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(content)
    }

    /**
     * 本插件自己的两个页面：加载即再交接一次 cookie（交接可能在开机竞态里
     * 刚开始播表，页面加载是一个自然的"该有了"时点）。
     */
    const page = (content: string): JsonHandler => (req, res) => {
      startCookieHandoff()
      html(content)(req, res)
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
          if (!requireWriteProof(req, res)) return
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
      ctx.webServer.register({ kind: 'exact', path: '/browser-shell', handler: page(BROWSER_SHELL_HTML) }),
      ctx.webServer.register({ kind: 'exact', path: '/browser-overlay', handler: page(BROWSER_OVERLAY_HTML) }),
    ]
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'pico browser: panel api')

  /**
   * 等"持久会话已恢复"再建浏览器窗口（2026-09-15 审计 F1 的保守修法）。
   *
   * 为什么不是"恢复完成后再补一次采样"：`usernameForStore` 与 `currentUser()` 同源，
   * 补采样永远相等、是死代码（本轮实测证伪了"补采样"这个方向）。真正的窗口在
   * **恢复还没回来**的那段时间里：`currentUser()` 为 null ⇒ 分区与书签/历史 store
   * 先落在匿名桶上，登录态慢（例如要等一次服务端校验）时这个窗口能到秒级。
   * 修法就是**别急着建**：`isRestored()` 一到就建（正常路径只多等一次 token 文件
   * 读取，毫秒级）；超时（缺 picoSession 的宿主 / 恢复卡住）照常建，行为与旧版一致。
   */
  const waitForSessionRestored = async (budgetMs = 15_000): Promise<boolean> => {
    const pico = ctx.get('picoSession') as { isRestored?: () => boolean } | undefined
    if (typeof pico?.isRestored !== 'function') return true
    const deadline = Date.now() + budgetMs
    while (pico.isRestored() !== true && Date.now() < deadline) {
      await new Promise((resolve) => { setTimeout(resolve, 50) })
    }
    return pico.isRestored() === true
  }

  // Boot prewarm (2026-09-08 product decision): the browser window, the
  // restored ledger tabs and their CDP sessions come up at client start —
  // HIDDEN. The agent can therefore drive the browser with no user action,
  // and the shell's 浏览器 button merely shows the already-running window.
  ctx.effect(() => {
    let cancelled = false
    void (async () => {
      const restored = await waitForSessionRestored()
      if (!restored) ctx.logger?.warn?.('pico-browser: session restore did not finish in 15s; prewarming with the current scope')
      if (!cancelled) await runtime.prewarm()
    })().catch((cause: unknown) => {
      ctx.logger?.warn('pico-browser: prewarm failed', cause)
    })
    return () => { cancelled = true }
  }, 'pico browser: boot prewarm')

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
