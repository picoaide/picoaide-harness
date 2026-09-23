/**
 * Security guards for the embedded browser: navigation policy, download
 * interception, permission gating. Every decision is testable in isolation —
 * Electron surfaces arrive through the adapter.
 *
 * 2026-08-26: the approval seam was removed by product decision — every
 * browser operation (including form submission, password entry, eval and
 * credential fill) executes without a user-approval prompt. The embedded
 * browser is a first-class agent surface: the user grants its use through
 * the workspace permission (e.g. `danger-full-access` / `/permission`) and
 * sees every action in the browser window, so per-action prompts were
 * dropped. Navigation is still scheme-gated; downloads still route through
 * the native save dialog.
 * @module @picoaide/dsh-browser
 */

import type { BrowserNavigationVerdict } from './types.ts'
import type { ElectronAdapter, NativeDownloadItem, NativeSession } from './electron-adapter.ts'
import type { DownloadEntry, RecordActor } from './store.ts'
import { existsSync, mkdirSync } from 'node:fs'
import { join, dirname, basename, extname } from 'node:path'

/** Maximum accepted download size in bytes (100 MB). */
export const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024

/** Default downloads directory (overridden by the runtime wiring). */
export const DEFAULT_DOWNLOAD_DIR = '.picoaide-downloads'

/**
 * Windows 保留设备名（含带扩展名/结尾点的变体）。
 *
 * 2026-09-15 审计 P2-6：`join(dir, 'NUL')` 在 Windows 上被解析成 NUL 设备 ——
 * 下载"成功"但盘上零字节、下载列表却记 done+path，「打开」也打不开。Linux 没有这个
 * 语义，属典型"Linux 上碰巧成立"。这里不区分平台：在任何平台给保留名加 `_` 前缀，
 * 保证同一份下载文件名跨平台一致（也让 CI 能测）。
 */
const WINDOWS_RESERVED_STEM = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu

/** 去掉 Windows 会静默裁掉的结尾点与空格（`foo.` → `foo`，否则会覆盖已存在的 foo）。 */
function trimWindowsTrailing(value: string): string {
  // 2026-09-21（CodeQL #98 js/polynomial-redos）：旧实现是 `value.replace(/[. ]+$/u, '')`，
  // 该正则在"一长串点/空格"上会多项式回溯（CodeQL 给出的触发串是大量重复的空格）。
  // 这里的语义就是"从尾部往前扫，直到第一个既不是 `.` 也不是空格的字符"，写成循环是
  // **线性且无回溯**的，行为与原来逐字一致（`.`=0x2e、空格=0x20）。
  let end = value.length
  while (end > 0) {
    const ch = value.charCodeAt(end - 1)
    if (ch !== 0x2e && ch !== 0x20) break
    end -= 1
  }
  return end === value.length ? value : value.slice(0, end)
}

/** Resolve a conflict-free absolute path inside `dir` for `filename`. */
export function resolveDownloadPath(dir: string, filename: string): string {
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    // dir may be created by the save itself; best effort.
  }
  const safeName = basename(filename || 'download').replace(/[\\/:*?"<>|]/g, '_')
  const ext = trimWindowsTrailing(extname(safeName))
  const rawStem = trimWindowsTrailing(safeName.slice(0, safeName.length - extname(safeName).length))
  // 空 stem（例如文件名就叫 "…" 或全是空格）必须留下可用的名字
  const fallbackStem = rawStem.length > 0 ? rawStem : 'download'
  const stem = WINDOWS_RESERVED_STEM.test(fallbackStem) ? `_${fallbackStem}` : fallbackStem
  const normalized = `${stem}${ext}`
  let candidate = join(dir, normalized)
  let n = 1
  while (existsSync(candidate)) {
    candidate = join(dir, `${stem}-${String(n)}${ext}`)
    n++
    if (n > 999) return join(dir, `${stem}-${Date.now()}${ext}`)
  }
  void dirname
  return candidate
}

/**
 * 导航闸门要作用的 surface（§16.1：`classifyNavigation` **按 surface kind 分流**）。
 *
 *  - `browser-tab`（**缺省**）：只允许 http(s)/about —— 应用源 scheme **一律拒**
 *    （§22.2 R4，R2-P0-2：网页不得把用户导航进应用 origin，那等于"带身份的导航型
 *    CSRF"，而且自定义协议下 `Origin`/`Sec-Fetch-*` 恒为空、无从事后区分发起者）；
 *  - `app`：应用窗口只允许**它自己那个** app origin（scheme 由渠道注入，见
 *    `surface.ts`）。
 *
 * 注意允许集里**没有任何写死的 scheme 字面量**：应用源 scheme 是运行期值（渠道
 * 参数化，CHN-3），所以浏览器侧的"拒"是"不在 http(s)/about 里"的自然结果。
 */
export interface NavigationSurface {
  readonly kind: 'browser-tab' | 'app'
  /** `kind === 'app'` 时的应用源 scheme（不含 `:`）。 */
  readonly appScheme?: string | undefined
}

/**
 * 判断主机名是否指向**本机地址**（模型不得访问 —— 见 `BrowserRuntime.navigationAllowed`）。
 *
 * 为什么必须这么细（2026-09-21 五轮审计实测）：漏掉的写法**真的会落到本机监听**，
 * 而朴素判据（`host === 'localhost' || host.startsWith('127.')`）两头都错 ——
 * 既漏 `localhost.` / `*.localhost` / `ip6-localhost` / `[::]` / IPv4-mapped 的
 * `[::ffff:127.0.0.1]`，又会把 `127.example.com` 这种**合法公网域名**误判成本机。
 * 覆盖范围：
 *   - IPv4：`127.0.0.0/8`（按**完整四段**匹配）、`0.0.0.0`；
 *   - IPv6：`::1`、`::`（未指定地址连上去就是本机）、IPv4-mapped 的
 *     `::ffff:127.0.0.1` 与 `::ffff:7f00:1` 两种写法；
 *   - 主机名：`localhost`、`localhost.`（尾点归一）、任意 `*.localhost`（RFC 6761 保留，
 *     Chromium 解析到回环）、`ip6-localhost` / `ip6-loopback`（/etc/hosts 惯例）、
 *     `localhost.localdomain`。
 * 纯函数、表驱动可测（`tests/guard.spec.ts`）。
 * @param rawHostname - `URL#hostname`（IPv6 带方括号）。
 * @returns true 表示该主机名是本机目标。
 */
export function isLocalHostname(rawHostname: string): boolean {
  const host = rawHostname.trim().toLowerCase().replace(/^\[|\]$/gu, '').replace(/\.$/u, '')
  if (host === '') return false
  if (host.includes(':')) {
    if (host === '::1' || host === '::') return true
    const mapped = /^::ffff:(.+)$/u.exec(host)
    if (mapped === null) return false
    const v4 = mapped[1]!
    if (isLoopbackIPv4(v4)) return true
    // 十六进制写法 `::ffff:7f00:1`（高 16 位的高字节 = 127）。
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(v4)
    if (hex === null) return false
    return Number.parseInt(hex[1]!, 16) >> 8 === 127
  }
  if (isLoopbackIPv4(host) || host === '0.0.0.0') return true
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  return host === 'ip6-localhost' || host === 'ip6-loopback' || host === 'localhost.localdomain'
}

/** 判断是否是 `127.0.0.0/8` 的**完整 IPv4 字面量**（四段、每段 0–255）。 */
function isLoopbackIPv4(host: string): boolean {
  const parts = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(host)
  if (parts === null) return false
  for (let i = 1; i <= 4; i++) {
    if (Number.parseInt(parts[i]!, 10) > 255) return false
  }
  return Number.parseInt(parts[1]!, 10) === 127
}

/**
 * 报告一个原始字符串是否**看起来是带 scheme 的绝对 URL**。
 *
 * 为什么要剥前导 C0 再判（2026-09-21 七轮审计 P2-①）：WHATWG 的 URL 解析器会**先去掉
 * 前导/尾随的 C0 控制符与空格**，而 JS 的 `String.prototype.trim()` **不剥 `\x01` 之类**。
 * 于是 `"\x01http://[::ffff:0177.0.0.1]:8080/"` 这种输入在 Node 侧 `new URL()` 抛错、
 * 在 Chromium 侧被接受并归一化成回环 —— 如果 catch 分支只用 `trim()` 判"是不是绝对 URL"，
 * 就会把它当成相对路径放行（真机实测：请求确实到达本机监听）。
 * 口径与 WHATWG 对齐：剥掉**首尾**的 C0 控制符（U+0000–U+001F、U+007F）与空白，再判 scheme。
 * @param raw - 候选原始字符串（模型输入 / 事件里的 URL）。
 * @returns true 表示剥壳后形如 `scheme:`。
 */
export function looksLikeAbsoluteUrl(raw: string): boolean {
  // 手写剥离而不是正则：等价语义（剥首尾 C0 控制符与空格）但**没有** `+` 量词回溯面 ——
  // CodeQL 的 `js/polynomial-redos` 对"库输入 + 字符类 + `+`"会报高优（本题实测是误报，
  // 但一个可以随手消掉的告警不值得留在面板上让后来者重新判断一次）。
  let start = 0
  let end = raw.length
  const isStrippable = (code: number): boolean => code <= 0x20 || code === 0x7f
  while (start < end && isStrippable(raw.charCodeAt(start))) start++
  while (end > start && isStrippable(raw.charCodeAt(end - 1))) end--
  const stripped = raw.slice(start, end)
  return /^[a-z][a-z0-9+.-]*:/iu.test(stripped)
}

/** Schemes the embedded browser (a browser tab) may navigate to. */
const ALLOWED_SCHEMES = new Set(['http:', 'https:', 'about:'])

/** 拒绝文案里列出的 scheme（与 {@link ALLOWED_SCHEMES} 同源，避免两处漂移）。 */
const ALLOWED_SCHEME_LIST = [...ALLOWED_SCHEMES].map(scheme => scheme.replace(/:$/u, '')).join(', ')

/** Maximum URL length accepted from the model (hostile-input bound). */
const MAX_URL_LENGTH = 8192

/**
 * Classify a navigation target under the deployment policy:
 * - http(s) → `allow` (regular navigation does not prompt);
 * - about:blank / about:srcdoc → `allow`;
 * - everything else (`javascript:`, `data:`, `file:`, `chrome:`, and the
 *   client's own application scheme) → `deny` **on a browser tab**;
 * - on an application surface (`kind: 'app'`) only that surface's own app
 *   origin is additionally allowed.
 * `approve` is reserved for sensitive actions decided at tool level (form
 * submission, password entry, eval).
 * @param rawUrl - candidate URL (model input or `window.open` target).
 * @param surface - the surface the navigation happens on; default = a browser tab.
 */
export function classifyNavigation(rawUrl: string, surface: NavigationSurface = { kind: 'browser-tab' }): BrowserNavigationVerdict {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > MAX_URL_LENGTH) return 'deny'
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    // 相对 URL 会按当前页解析，页面无法借此越出自己的 origin ⇒ 放行。
    //
    // ⚠️ 但**带 scheme 的绝对 URL 解析失败时必须拒**（2026-09-21 六轮审计 P2-①）：
    // Node 的 WHATWG 解析器与 Chromium 的**接受面不同** —— 实测
    // `http://[::ffff:0177.0.0.1]:PORT/` 在 Node 抛错、Chromium 接受并**归一化成回环**
    // `[::ffff:7f00:1]`。若这里返回 'allow'，闸门等于对该 URL 失效，而 Chromium 照常
    // 落到本机监听（真机实测模型读到了本机 dev server 的正文）。判据：`^scheme:` 形态
    // 解析失败 ⇒ deny（保守方向）；纯相对路径才走放行分支。
    return looksLikeAbsoluteUrl(rawUrl) ? 'deny' : 'allow'
  }
  if (surface.kind === 'app') {
    // 应用窗口：**只**允许它自己那个 app origin（§7.2 冻结）。http(s) 顶层导航同样
    // 拒 —— 外链走内置浏览器新标签 + 应用窗口提示条，不在应用窗口里换页（防"换壳
    // 钓鱼"与"导航外带数据"）。app_id 级的判定在应用窗口模块（按 app_id 判）。
    const scheme = surface.appScheme
    return scheme !== undefined && scheme !== '' && parsed.protocol === `${scheme}:` ? 'allow' : 'deny'
  }
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) return 'deny'
  return 'allow'
}

/**
 * Human-readable classification reason (audit + model error text).
 *
 * 浏览器标签上被拒的应用协议要**说出真因**：不是"平台不支持这个协议"，而是
 * "只有应用窗口能导航到它" —— 否则模型会把 §22.2 R4 的拒绝误诊成前端缺陷，
 * 转而尝试别的绕法（那是审计里已经出现过一次的误诊）。
 * @param rawUrl - the refused URL.
 * @param surface - the surface the navigation was attempted on.
 */
export function navigationDenyReason(rawUrl: string, surface: NavigationSurface = { kind: 'browser-tab' }): string {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > MAX_URL_LENGTH) {
    return 'URL is empty or too long'
  }
  try {
    const protocol = new URL(rawUrl).protocol
    const appScheme = surface.kind === 'app' ? surface.appScheme : undefined
    if (appScheme !== undefined && appScheme !== '' && protocol === `${appScheme}:`) {
      return `scheme ${JSON.stringify(protocol)} belongs to an application window, not to a browser tab (design §22.2 R4)`
    }
    return `scheme ${JSON.stringify(protocol)} is not allowed (allowed schemes: ${ALLOWED_SCHEME_LIST})`
  } catch {
    return 'malformed URL'
  }
}

/** Store recorder contract for download auditing (create + update by id). */
export interface DownloadRecorder {
  add(entry: Omit<DownloadEntry, 'id' | 'createdAt'>): number
  update(id: number, patch: Partial<Pick<DownloadEntry, 'status' | 'path' | 'size'>>): void
}

/** Recorder context a download guard uses at fire time (latest tab wins). */
interface DownloadGuardContext {
  onDownload: (summary: string) => void
  record: DownloadRecorder | undefined
  groupKey: string | undefined
  actor: RecordActor | undefined
  downloadsDir: string
}

/**
 * One tab's registration on a shared download guard (R4-B-17).
 *
 * The context is per registration, and a registration is used only while it is
 * NOT released: a download has no tab identity, so it is attributed to the most
 * recent registration that is still alive. Before this, closing the newest tab
 * kept attributing downloads to its `actor`/`groupKey` forever.
 */
interface DownloadGuardRegistration {
  context: DownloadGuardContext
  released: boolean
}

interface DownloadGuardEntry {
  refs: number
  /** Registrations in install order; released ones stay as tombstones. */
  registrations: DownloadGuardRegistration[]
  dispose: () => void
}

/** The context a download is attributed to: the newest live registration. */
function liveContext(entry: DownloadGuardEntry): DownloadGuardContext {
  for (let index = entry.registrations.length - 1; index >= 0; index -= 1) {
    const registration = entry.registrations[index]!
    if (!registration.released) return registration.context
  }
  // Unreachable while `refs > 0`; keeping the last context is the old behavior.
  return entry.registrations[entry.registrations.length - 1]!.context
}

/**
 * Guard bundle bound to one plugin lifetime. The download and permission
 * hooks are bound to the browser session by the runtime. There is no
 * approval seam: every browser action runs without a user prompt (product
 * decision 2026-08-26).
 */
export class BrowserGuard {
  constructor(_adapter: ElectronAdapter) {}

  /** Sessions that already have the download guard installed, ref-counted per
   * tab. Tabs sharing one partition share one Session — installing a listener
   * per tab would duplicate every download record, but the listener must
   * survive until the LAST tab releases it: before 2026-09-08 closing the
   * first tab removed the shared listener and silently disabled download
   * interception for every remaining tab (audit P0-5). */
  private readonly guardedSessions = new WeakMap<object, DownloadGuardEntry>()

  /**
   * Decide a navigation: `true` lets it proceed.
   * @param rawUrl - candidate URL.
   * @param surface - the surface the navigation happens on; default = a browser tab
   *   (so the client's own application scheme is refused here, §22.2 R4).
   */
  allowNavigation(rawUrl: string, surface: NavigationSurface = { kind: 'browser-tab' }): boolean {
    return classifyNavigation(rawUrl, surface) === 'allow'
  }

  /**
   * Install the programmatic download interception (v4 §11.6): every download
   * is saved into the configured downloads directory (auto-renamed on
   * conflict, bounded size, no native dialogs — an AI-driven flow must never
   * block on a dialog), recorded in the store for downloads_list.
   *
   * The returned disposer releases ONE tab's reference; the listener is
   * removed only when the last reference goes away.
   */
  installDownloadGuard(
    session: NativeSession,
    onDownload: (summary: string) => void,
    record?: DownloadRecorder,
    groupKey?: string,
    actor?: RecordActor,
    downloadsDir = DEFAULT_DOWNLOAD_DIR,
  ): () => void {
    const key = session as object
    const context: DownloadGuardContext = { onDownload, record, groupKey, actor, downloadsDir }
    const existing = this.guardedSessions.get(key)
    if (existing !== undefined) {
      existing.refs++
      // A download carries no tab identity (session-level event); attribute
      // it to the most recent registration rather than the first tab forever.
      const registration: DownloadGuardRegistration = { context, released: false }
      existing.registrations.push(registration)
      return this.downloadGuardDisposer(key, registration)
    }
    const registration: DownloadGuardRegistration = { context, released: false }
    const entry: DownloadGuardEntry = { refs: 1, registrations: [registration], dispose: () => {} }
    const listener = (_event: unknown, item: NativeDownloadItem): void => {
      const { onDownload, record, groupKey, actor, downloadsDir } = liveContext(entry)
      const filename = item.getFilename() || 'download'
      let received = 0
      let rejected = false
      const recordId = record !== undefined
        ? record.add({ url: item.getURL(), fileName: filename, path: '', size: 0, status: 'in-progress', group: groupKey ?? 'unknown', actor: actor ?? 'ai' })
        : undefined
      const onUpdated = (): void => {
        received = item.getReceivedBytes()
        if (received > MAX_DOWNLOAD_BYTES && !rejected) {
          rejected = true
          item.cancel()
          onDownload(`download rejected (>100MB): ${filename}`)
          if (recordId !== undefined) {
            record?.update(recordId, { size: received, status: 'rejected' })
          }
        } else if (recordId !== undefined) {
          record?.update(recordId, { size: received, status: 'in-progress' })
        }
      }
      item.on?.('updated', onUpdated)
      if (item.getReceivedBytes() > MAX_DOWNLOAD_BYTES) {
        rejected = true
        item.cancel()
        onDownload(`download rejected (>100MB): ${filename}`)
        return
      }
      void (async () => {
        let target: string
        try {
          target = resolveDownloadPath(downloadsDir, filename)
        } catch (cause) {
          // Download dir unusable: never block the UI; reject loudly and
          // record the failure so downloads_list is not stuck at in-progress.
          rejected = true
          item.cancel()
          onDownload(`download failed (target dir unusable): ${filename}`)
          if (recordId !== undefined) record?.update(recordId, { status: 'rejected', size: received })
          void cause
          return
        }
        try {
          item.setSavePath(target)
        } catch (cause) {
          rejected = true
          item.cancel()
          onDownload(`download failed (save path rejected): ${filename}`)
          if (recordId !== undefined) record?.update(recordId, { status: 'rejected', size: received })
          void cause
          return
        }
        onDownload(`download saved to ${target}: ${filename}`)
        item.on?.('done', (event, state) => {
          // A size-rejected or failed download must keep 'rejected' — the
          // later 'cancelled' done-event must not overwrite the verdict.
          if (rejected) return
          const status = state === 'completed' ? 'done' : state === 'cancelled' ? 'cancelled' : 'rejected'
          if (record !== undefined && recordId !== undefined) {
            record.update(recordId, {
              status,
              path: status === 'done' ? target : '',
              size: item.getTotalBytes() > 0 ? item.getTotalBytes() : received,
            })
          }
          void event
        })
      })().catch(() => {
        item.cancel()
      })
    }
    session.on('will-download', listener)
    entry.dispose = () => { session.removeListener('will-download', listener) }
    this.guardedSessions.set(key, entry)
    return this.downloadGuardDisposer(key, registration)
  }

  /**
   * One-shot disposer for ONE registration (R4-B-17).
   *
   * Idempotent by construction: calling it twice used to decrement the shared
   * count twice, dropping the listener while another tab was still alive — i.e.
   * silently disabling download interception for a live tab (P0-5's failure
   * mode, reachable this time through a double release). The registration is
   * marked released on the first call, so any later call is a no-op.
   */
  private downloadGuardDisposer(key: object, registration: DownloadGuardRegistration): () => void {
    return () => { this.releaseDownloadGuard(key, registration) }
  }

  /**
   * Drop one registration's reference; the shared listener goes away at zero.
   *
   * When a registration is released while others remain, the surviving ones
   * keep owning the attribution context ({@link liveContext}), so a download
   * triggered by a still-open tab is no longer recorded under a closed tab's
   * actor/group.
   */
  private releaseDownloadGuard(key: object, registration?: DownloadGuardRegistration): void {
    const entry = this.guardedSessions.get(key)
    if (entry === undefined) return
    if (registration !== undefined) {
      if (registration.released) return
      registration.released = true
    } else {
      // Legacy call shape (no token): release the newest live registration.
      const live = entry.registrations.filter(candidate => !candidate.released).at(-1)
      if (live !== undefined) live.released = true
    }
    entry.refs--
    if (entry.refs > 0) return
    entry.dispose()
    this.guardedSessions.delete(key)
  }
}

/**
 * Default permission stance: everything is denied unless a future product
 * decision grants it. BOTH Electron handlers are required — Chromium checks a
 * permission first and only raises a request when the check is denied, and
 * Electron's check handler defaults to GRANTING when none is installed, so a
 * request handler alone never runs (2026-09-11 audit: an untrusted page in the
 * agent browser could silently obtain camera/microphone/geolocation). The main
 * window installs the same pair (desktop electron-runtime.ts P1-4).
 */
export type { NativeSession } from './electron-adapter.ts'

export function installPermissionGuard(session: NativeSession): () => void {
  session.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false)
  })
  session.setPermissionCheckHandler(() => false)
  // No removal API for either handler; returning a no-op disposer keeps the
  // interface uniform (a new handler overwrites on reinstall).
  return () => {}
}

/**
 * 已装过权限守卫的 session（**分区级幂等**，§16.1 冻结）。
 *
 * 归属为什么必须是"分区初始化"而不是"建 tab 时"：应用窗口与应用标签共用按用户分区，
 * 但**应用窗口可以在一张浏览器标签都没开过时创建**（深链、应用中心直达）。per-tab 安装
 * 在那条路径上永远不会执行 ⇒ 该分区没有 check handler ⇒ Electron **默认放行**
 * camera/mic/geolocation（2026-09-11 审计同类缺陷）。分区级幂等安装把这个缝封死：
 * 谁先碰这个分区谁装，重复调用是 no-op。
 */
const guardedSessions = new WeakSet<object>()

/**
 * 确保某个 session（分区）装了**两个**权限 handler（幂等）。
 *
 * 浏览器与应用窗口**共用**它 —— 单一来源，不允许任何调用点自己再装一份
 * （两份实现在权限面上必然漂移，而漂移的方向是"更宽松"）。
 * @param session - 目标 session（Electron `Session` 满足 `NativeSession`）。
 * @returns 本次调用是否真的安装了（false = 该 session 已有守卫）。
 */
export function ensureSessionGuard(session: NativeSession): boolean {
  const key = session as unknown as object
  if (guardedSessions.has(key)) return false
  guardedSessions.add(key)
  installPermissionGuard(session)
  return true
}

/** `webRequest.onBeforeRequest` 的最小结构面（Electron 的 Session 满足它）。 */
export interface NativeWebRequestSession extends NativeSession {
  webRequest: {
    onBeforeRequest(
      filter: { urls: string[] },
      listener: (details: { url: string, webContentsId?: number, initiator?: string, resourceType?: string }, callback: (response: { cancel?: boolean }) => void) => void,
    ): void
  }
}

/** 应用 scheme 请求闸门的注入面。 */
export interface AppSchemeRequestGateOptions {
  /** 本安装的应用源 scheme（渠道注入；不含 `:`）。 */
  scheme: string
  /**
   * 该 `webContentsId` 是否是**应用窗口**（由应用窗口模块维护的白名单）。
   *
   * 判定按发起者身份，不按 URL：任意 http(s) 页面都能写
   * `<img src="<scheme>://<app_id>/…">`、`sendBeacon`、`prefetch`，而协议 handler 会
   * **带员工 bearer 转发** ⇒ 这是"发起者绑定"的另一半（§23.2 N6/R2S-7）。
   */
  isAppSurfaceWebContents: (webContentsId: number | undefined) => boolean
  /** 被拒请求的诊断出口（缺省丢弃）。**不要**把 URL 原样打出去（可能含应用数据）。 */
  warn?: ((message: string) => void) | undefined
}

/**
 * 在**注册了应用协议 handler 的 session** 上装请求闸门：只有应用窗口发出的应用
 * scheme 请求才放行，其余一律 `{cancel:true}`（§16.1 导航闸门 / §23.2 N6）。
 *
 * 为什么必须在 session 级而不是 `will-navigate`：`will-navigate` 只看顶层导航，
 * 覆盖不到 `<img>`/`sendBeacon`/`prefetch`/Service Worker 这类**子资源**请求。
 *
 * 过滤器只覆盖本安装的 scheme（`scheme://` 之下的全部 URL）：http(s) 与其它协议
 * 一个都不碰（浏览器面自己的导航闸门仍由 `classifyNavigation` 负责）。
 * @param session - 目标 session（默认 session 或某个 `persist:` 分区）。
 * @param options - scheme + 应用窗口白名单 + 诊断出口。
 * @returns 注销函数（Electron 没有移除 API ⇒ 置一个放行 listener 覆盖它）。
 */
export function installAppSchemeRequestGate(session: NativeWebRequestSession, options: AppSchemeRequestGateOptions): () => void {
  const warn = options.warn ?? ((): void => {})
  const prefix = `${options.scheme}:`
  let active = true
  session.webRequest.onBeforeRequest({ urls: [`${prefix}//*/*`] }, (details, callback) => {
    if (!active) {
      callback({})
      return
    }
    if (typeof details?.url !== 'string' || !details.url.startsWith(prefix)) {
      callback({})
      return
    }
    if (options.isAppSurfaceWebContents(details.webContentsId)) {
      callback({})
      return
    }
    // 正向对照的纪律（R2T-7）：这里**取消**请求 —— handler 一次都不会被调用，
    // 而不是"让它抵达再拒绝响应"。判据断言的是 handler 调用计数为 0。
    warn(`pico-browser: refused an application-scheme request from a non-application surface (resourceType=${details.resourceType ?? 'unknown'})`)
    callback({ cancel: true })
  })
  return () => { active = false }
}
