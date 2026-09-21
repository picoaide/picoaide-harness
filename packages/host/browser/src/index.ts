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
import { credentialSiteOrigin } from './credential-site.ts'
import { browserPartitionFor, createRealElectronAdapter } from './electron-adapter.ts'
import { browserSameOriginMarker, isLoopbackRequest } from './loopback.ts'
import { BrowserRuntime } from './runtime.ts'
import { BROWSER_SURFACE_SERVICE, createSurfaceRegistry, encodePartitionSegment, serverPartitionHash } from './surface.ts'
import { TabPool } from './pool.ts'
import { BrowserStore } from './store.ts'
import { applyBrowserTools, parseToolGroups } from './tools.ts'
import { browserOverlayHtml, browserShellHtml } from './shell-pages.ts'
import { hostLocaleFrom, type HostLocale } from '@picoaide/dsh-host-locale'
import type { CredentialResolver } from './types.ts'
import type { DownloadEntry } from './store.ts'
type DownloadEntryStatus = DownloadEntry['status']

// Type-only: declare the enterprise session event so `ctx.on` resolves it.
declare module '@deepseek-ai/cordis' {
  interface Events {
    'pico/session-changed'(session: { username?: string; token?: string; serverURL?: string } | null): void
    /**
     * The launcher's user-visible language changed (the in-app locale setting).
     *
     * Emitted by the desktop shell. This plugin serves its two chrome pages per
     * REQUEST, so a window that is already open keeps the language it was
     * loaded with — the listener re-serves them (2026-09-16 R9 audit).
     */
    'pico/locale-changed'(locale: 'zh' | 'en'): void
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
  /**
   * 每个连接器自己的站点地址（origin 或完整 URL），用于 `browser_fill_credentials`
   * 的站点绑定（2026-09-15 审计 BUG-03）。缺省时基准取自凭据字段里的地址；两者
   * 都拿不到就**拒绝注入**（fail-closed，工具描述对外承诺的即此）。这是部署侧配置，
   * 模型/页面输入永远不参与。
   */
  credentialSites?: Record<string, string>
  /**
   * 应用源 scheme（渠道包 `desktop.app_origin_scheme`，组装期注入；§10/§16.1）。
   *
   * 用途只有一处：**导航闸门按 surface 分流**（应用窗口放行它自己的 origin、
   * 浏览器标签一律拒 http(s)/about 之外的 scheme）。这里**不得**写死任何渠道值
   * （CHN-3）—— 缺省值只是官方构建的兜底。
   */
  appOriginScheme?: string
}

/**
 * 构造 `browser_fill_credentials` 用的凭据解析器（导出以便单测：站点绑定基准
 * 必须与工具侧闸门同源，2026-09-15 审计 BUG-03）。
 *
 * `@picoaide/dsh-connectors` 用 `createRequire` 惰性解析：本插件在没有连接器包
 * 的宿主里也必须能加载（此时返回 undefined，工具侧对 fill_credentials 一律
 * fail-closed 拒绝）。
 * @param options.currentUser - 当前登录用户名（scoping 凭据库）。
 * @param options.credentialSites - 部署显式声明的连接器站点地址。
 */
export function createCredentialResolver(options: {
  currentUser: () => string | null
  credentialSites?: Record<string, string>
  /**
   * 应用源 scheme（渠道包 `desktop.app_origin_scheme`，组装期注入；§10/§16.1）。
   *
   * 用途只有一处：**导航闸门按 surface 分流**（应用窗口放行它自己的 origin、
   * 浏览器标签一律拒 http(s)/about 之外的 scheme）。这里**不得**写死任何渠道值
   * （CHN-3）—— 缺省值只是官方构建的兜底。
   */
  appOriginScheme?: string
}): CredentialResolver | undefined {
  try {
    const require = createRequire(import.meta.url)
    const { ConnectorStore } = require('@picoaide/dsh-connectors/store') as typeof import('@picoaide/dsh-connectors/store')
    const resolveCredentials = async (connectorId: string): Promise<{ username?: string; password?: string } | null> => {
      const store = new ConnectorStore({ username: options.currentUser() })
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
        const dir = join(userScopePath(options.currentUser()), 'connectors')
        const names: string[] = []
        try {
          for (const file of readdirSync(dir)) {
            if (file.endsWith('.json')) names.push(file.slice(0, -5))
          }
        } catch {
          return []
        }
        const store = new ConnectorStore({ username: options.currentUser() })
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
    /**
     * 站点绑定基准：显式配置优先，其次凭据字段里的地址；都没有返回 null，
     * 工具侧拒绝注入（fail-closed）。派生规则见 credential-site.ts。
     */
    resolveCredentials.originOf = async (connectorId: string): Promise<string | null> => {
      try {
        const store = new ConnectorStore({ username: options.currentUser() })
        const credential = await store.readCredential(connectorId)
        return credentialSiteOrigin(credential?.fields, options.credentialSites?.[connectorId])
      } catch {
        return null
      }
    }
    return resolveCredentials
  } catch {
    return undefined
  }
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
  credentialSites: z.dict(z.string()),
  appOriginScheme: z.string(),
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
 * 只服务闸门（`proofOfPossession`）一处：服务缺席时写面一律 fail-closed 503，
 * 绝不退回"只查 Origin"的 `guard()`（2026-09-15 审计 F3 的口径保留）。
 * @param service - `ctx.get('connection')` 的返回值（任意宿主形状）。
 * @returns 服务存在且 `requestRejection` 可用时为 true。
 */
export function connectionFenceReady(service: unknown): service is ConnectionTrustFence {
  return service !== undefined && service !== null
    && typeof (service as { requestRejection?: unknown }).requestRejection === 'function'
}

/** 用户切换的四个步骤（导出以便确定性单测顺序与容错）。 */
export interface SessionSwitchSteps {
  /** 身份相关：分区 + store + 分区权限守卫（**必须**执行，失败即串账号）。 */
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
  // Close the PREVIOUS account's tabs while the old store/partition is still
  // current. If this order is reversed, `applyUserScope()` first restores the
  // NEW account's ledger into the pool and `closeAll()` then clears the pool
  // and its tab events persist an EMPTY ledger back through the new store —
  // silently deleting the new account's saved tabs before prewarm can restore
  // them (2026-09-15 audit regression).
  try {
    await steps.closeAll()
  } catch (cause) {
    // One failed teardown must not skip the identity/scope switch below.
    steps.warn('pico-browser: closing tabs during the user switch failed', cause)
  }
  steps.applyUserScope()
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

  /**
   * 当前会话的**服务端地址哈希**（§7.2/R2S-8 冻结：分区名 =
   * `persist:agent-browser-<user>@<sha256(normalized server url)[:32]>`）。
   *
   * 为什么必须与用户一起进分区名：分区是 `persist:` 的，同机切服务端（本仓部署拓扑里
   * 测试/正式并存，真实可触发）会让新旧租户共用同一个持久分区 —— 同名站点/应用
   * origin 的 cookie 与 localStorage 于是跨租户串味（2026-09-21 审计 P1-10 证据②）。
   *
   * **来源与宿主同源**：`picoSession.getSession().serverURL`，与
   * `@picoaide/dsh-wasm-apps-host` 的 `readAppSession` 读的是同一个服务 —— 应用窗口
   * 与浏览器标签必须落在**同一个**分区上，两边各读一份就会漂移成两个 session。
   * 未登录 / 读不到 ⇒ `undefined`（匿名分区**不带**后缀，逐字节不变）。
   * @returns 32 位 hex 摘要，或 undefined。
   */
  const currentServerHash = (): string | undefined => {
    try {
      const pico = ctx.get('picoSession') as { getSession?: () => { serverURL?: string } | null } | undefined
      const serverURL = pico?.getSession?.()?.serverURL
      return serverPartitionHash(typeof serverURL === 'string' ? serverURL : null)
    } catch {
      return undefined
    }
  }

  /**
   * Host UI locale for every piece of user-visible copy this plugin owns (the
   * injected chrome pages, the native window title, the activity-panel
   * summaries, the user-gate refusals).
   *
   * Resolved PER CALL, never cached: the language can change while the app runs
   * and the browser window may already be open, so nothing here may freeze the
   * first resolution into a module constant (the bug class documented in
   * `packages/host/connectors/src/client/status-label.ts`). The service probe
   * is per call too, so a launcher that composes later than this plugin is
   * still picked up. Precedence (all inside {@link hostLocaleFrom}): the probed
   * `desktopRuntime.locale` — the user's in-app choice, authoritative — then the
   * request's `Accept-Language`, then the product default (`zh`).
   * @param req - the request being served, when the copy is rendered for one.
   * @returns the locale to render host copy in.
   */
  const hostLocale = (req?: IncomingMessage): HostLocale => hostLocaleFrom(
    ctx.get('desktopRuntime') as { readonly locale?: unknown } | undefined,
    req?.headers['accept-language'],
  )

  const credentialResolver: CredentialResolver | undefined = createCredentialResolver({
    currentUser,
    ...(config.credentialSites === undefined ? {} : { credentialSites: config.credentialSites }),
  })

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
    locale: () => hostLocale(),
  })
  /**
   * Surface 注册表（§16.1）：本插件是**唯一**的 surface 提供者，`provide` 出去给
   * 应用窗口宿主（`@picoaide/dsh-wasm-apps-host` 经 `@picoaide/dsh-browser/surface`
   * 的 `BROWSER_SURFACE_SERVICE` 取得它）。浏览器标签这一半由 runtime 镜像，
   * 应用窗口那一半由宿主注册 —— 两者共用同一套工具实现与胶囊/遮罩。
   */
  const surfaces = createSurfaceRegistry({
    activeBrowserTab: () => pool.activeTab,
    warn: (message: string) => { ctx.logger?.warn?.(message) },
  })
  // 本安装的应用源 scheme（渠道注入）。工具面在应用窗口 surface 上用**它自己注册时
  // 带的 scheme** 判导航，所以这里只需要把值保存在 runtime 上供宿主注册时对齐
  // （§16.1：surface 自带 scheme，浏览器侧不猜）。
  const appOriginScheme = config.appOriginScheme !== undefined && config.appOriginScheme !== ''
    ? config.appOriginScheme
    : undefined
  // `provide` 只在真实 Cordis 上下文里存在（单测宿主是精简替身）：缺席时静默跳过
  // —— 那种宿主也不会有人来取这个服务；失败（重复提供）才记一条。
  const provide = (ctx as unknown as { provide?: (name: string, value: unknown) => void }).provide
  if (typeof provide === 'function') {
    try {
      provide.call(ctx, BROWSER_SURFACE_SERVICE, surfaces)
    } catch (cause) {
      ctx.logger?.warn?.(`pico-browser: providing the surface registry failed (${cause instanceof Error ? cause.message : String(cause)})`)
    }
  }
  const runtime = new BrowserRuntime(
    createRealElectronAdapter(undefined, () => hostLocale()),
    {
      ...config,
      downloadDir: config.downloadDir ?? (userDataDir !== undefined ? join(userDataDir, 'downloads') : join(fallbackDataRoot(), 'downloads')),
    },
    credentialResolver,
    browserPartitionFor(currentUser(), currentServerHash()),
    { pool, store, currentUsername: currentUser, locale: () => hostLocale(), surfaces, ...(appOriginScheme === undefined ? {} : { appOriginScheme }) },
  )
  const shellOrigin = `http://127.0.0.1:${String(ctx.webServer.port)}`
  runtime.setShellOrigin(shellOrigin)

  /**
   * §7b（2026-09-21）**方案 A**：把蒙版（overlay）视图移回**默认 session**，
   * 因此这里不再有任何 cookie 交接。
   *
   * 旧结构（已删除）：`mirrorBrowserAuthCookies` 把默认 session 里回环源的
   * `dsh-auth-*`（BrowserAuth 持有性证明）**复制进** `persist:agent-browser-<user>`
   * —— 也就是**模型可驱动的标签页用的那个 jar**。那是 §7b 记录的根妥协：只要
   * 标签页持有这把 cookie，模型 `browser_navigate` 到 `http://127.0.0.1:<port>/…`
   * 就是一个"持有证明的真页面"，任何依赖 `requireWriteProof` 的本机守卫都被绕过。
   *
   * 现在：蒙版与本插件的 shell 页、主应用窗口**同一个 default session**（`mountOverlay`
   * 用 `createMaskView()` 不传分区，见 runtime.ts），票据天然就在那个 jar 里，所以
   * 交接没有必要 ⇒ 整块删除（`cookie-handoff.ts` 一并删除）。模型面（标签页）的
   * 分区从此**没有任何 `dsh-auth-*`**。
   *
   * 留下的是**权限守卫**（与 cookie 无关的安全副作用，原先寄生在交接函数里）：
   * 分区初始化就装，§16.1 冻结的归属不变。
   *
   * 顺带消失的两类缺陷（原先都出在这条交接链上）：2026-09-14 蒙版分区 P0
   * （交接漏了蒙版所在的 jar ⇒「我来操作」整轮 401）与 2026-09-15 恢复型启动 P0
   * （fence 暂时缺席时交接一次判死 ⇒ 同样整轮 401）。判据见
   * `tests/audit-0914-mask-partition.spec.ts` 与 `tests/audit-0921-credential-isolation.spec.ts`。
   */
  const ensureBrowserPartitionGuard = (user: string | null, serverHash?: string | undefined): void => {
    const session = runtime.sessionForPartition(browserPartitionFor(user, serverHash))
    if (session !== undefined) runtime.ensurePartitionGuard(session)
  }

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
   * 把"当前用户作用域"切到 `user`：分区 + 书签/历史/下载 store + 分区权限守卫。
   *
   * 幂等、可从任意路径重复调用（`setPartition` 同值短路、守卫安装本身幂等），因此
   * 它同时服务两个入口：`pico/session-changed` 与启动期安装。
   *
   * 交接表已删除（§7b 方案 A）：用户切换只需要换标签分区与 store —— 蒙版在默认
   * session 里，它的写证明（应用自己的 `dsh-auth-*` cookie）由新登录直接替换，
   * 不需要任何重建或复制。
   */
  const applyUserScope = (user: string | null, serverHash?: string | undefined): void => {
    runtime.setPartition(browserPartitionFor(user, serverHash))
    switchStoreForUser(user)
    ensureBrowserPartitionGuard(user, serverHash)
  }

  // Language switch: the two chrome pages are rendered per request, so an
  // already-open window keeps the old language until it is re-served. Reload
  // ONLY the chrome pages — the tab webContents (the user's browsing session)
  // are separate views and must not be touched.
  ctx.on('pico/locale-changed', () => { runtime.reloadChromePages() })

  // User switch: point new tabs at the new user's partition and swap the
  // per-user browser store (bookmarks/history/downloads/ledger), then close the
  // previous account's tabs and prewarm HIDDEN so the agent keeps a live CDP
  // surface without any user action.
  ctx.on('pico/session-changed', (next) => {
    const username = (next as { username?: string } | null)?.username ?? null
    const user = username !== null && username !== undefined && username.length > 0 ? username : null
    // 分区名带**服务端哈希**（§7.2/R2S-8）：同一个用户在两个服务端上是两个租户，
    // 持久分区必须分开。哈希从 `picoSession` 现取（事件载荷只当兜底）—— 应用窗口
    // 那边读的是同一个服务，两边必须落在同一个分区上。
    const eventServerURL = (next as { serverURL?: string } | null)?.serverURL
    const serverHash = currentServerHash() ?? serverPartitionHash(eventServerURL ?? null)
    void runSessionSwitch({
      applyUserScope: () => { applyUserScope(user, serverHash) },
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

  // 分区初始化即装权限守卫（§16.1 冻结：归属 = 分区初始化，不是建 tab 时）。
  // 开机时分区名已经由构造函数定下（`browserPartitionFor(currentUser())`），但那时
  // 可能还没有任何 tab ⇒ 这里补装一次；切账号时由 `applyUserScope` 再装新分区。
  // 幂等（runtime.ensurePartitionGuard → guard.ensureSessionGuard）。
  ctx.effect(() => {
    ensureBrowserPartitionGuard(currentUser(), currentServerHash())
    return () => {}
  }, 'pico browser: browser partition permission guard')

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
        // 蒙版页在胶囊态弹失败 toast 时请求临时放大 overlay 视图（2026-09-21 缺陷 #7：
        // 172×34 的视图装不下 position:fixed 的 toast，失败文案会被裁掉）。页面回报
        // `visible:false` 即归还；模式/控制权变化与兜底超时也会归还。
        case 'notice': {
          runtime.setOverlayNotice(body.visible === true)
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
          // 只清**浏览器分区**（标签页的 cookie/storage）。蒙版页在默认 session 里，
          // 它的 BrowserAuth 证明不在清理范围内 ⇒ 清完照旧能接管、开面板、点书签
          // （旧结构下这里的 cookie 会被一起清掉，所以旧代码要在这里补一次交接；
          // §7b 方案 A 之后这个补丁连同交接表一起删除）。
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
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
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
     * 本插件自己的两个页面（`/browser-shell` 与 `/browser-overlay`）。
     *
     * 页面**按请求现渲染**：语言可能在使用过程中切换（桌面运行时的 locale 是
     * 活的），所以 locale 在这里、每次请求解析一次，再交给页面构建函数；把
     * locale 定死在插件装配期就是这条约束要消灭的 bug 类型。
     *
     * 这两个页面的写操作靠**默认 session 里**的应用 `dsh-auth-*` cookie 过
     * `requireWriteProof`（两个页面都由宿主 loadURL 加载到默认 session，§7b 方案 A）
     * —— 因此这里不再需要任何"加载页面时顺带交接一次票据"的动作。
     */
    const page = (render: (locale: HostLocale) => string): JsonHandler => (req, res) => {
      html(render(hostLocale(req)))(req, res)
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
      ctx.webServer.register({ kind: 'exact', path: '/browser-shell', handler: page(browserShellHtml) }),
      ctx.webServer.register({ kind: 'exact', path: '/browser-overlay', handler: page(browserOverlayHtml) }),
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

/** Encode the per-user store key (the ONE implementation lives in `./surface.ts`). */

export type { BrowserRuntime } from './runtime.ts'
export type { BrowserOpLogEntry, BrowserSnapshotElement, BrowserTabState, BrowserToolOptions, BrowserWindowState } from './types.ts'
