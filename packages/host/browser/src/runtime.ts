/**
 * BrowserRuntime v4.2 (2026-09-07 定案：取消分组，AI 可以控制所有页面):
 * ONE flat tab pool shared by every session and the user. AI operations run
 * serially under a global mutex with a whole-window user gate (我来操作);
 * a transparent interception mask blocks stray clicks while the AI drives;
 * the AI panel shows the live action stream. All v4 capabilities remain
 * (eval guardrail, wait_for, fill_form, upload_file, programmatic downloads,
 * stores, crash rebuild, per-frame eval).
 * @module @picoaide/dsh-browser
 */

import { CdpSession } from './cdp.ts'
import { BROWSER_PARTITION, BROWSER_SHELL_TOOLBAR_HEIGHT, type ElectronAdapter, type NativeBrowserWindow, type NativeSession, type NativeView } from './electron-adapter.ts'
import { BrowserGuard, ensureSessionGuard, isLocalHostname, looksLikeAbsoluteUrl } from './guard.ts'
import { extractSnapshotWithMeta, extractTextWithMeta, type SnapshotExtractionMeta } from './snapshot.ts'
import { captureScreenshot, captureScreenshotViaCdp } from './shots.ts'
import { appSurfaceAllowsUrl, asSurfaceWebContents, surfaceLabel, type BrowserSurface, type SurfaceControlOwner, type SurfaceRegistry, type SurfaceWebContents } from './surface.ts'
import { TabPool, gateRefusal, type TabReservation } from './pool.ts'
import { BrowserStore, stripSensitiveText, stripSensitiveUrl, type DownloadEntry, type HistoryEntry, type RecordActor } from './store.ts'
import { validateEvalExpression, wrapEvalExpression, serializeEvalResult } from './eval-policy.ts'
import { SENSITIVE_KEY_PATTERN, isExactProseSensitiveKey } from './sensitive.ts'
import { browserError, BrowserError, type BrowserErrorCode } from './errors.ts'
import { httpOriginOf } from './credential-site.ts'
import { isFrameOrderProblem, orderFramesByDom, frameOrderErrorMessage, SRCDOC_URL, type FrameCandidate, type FrameOrderProblem } from './frames.ts'
import { DEFAULT_HOST_LOCALE, hostCopy, type HostLocale } from '@picoaide/dsh-host-locale'
import { realpathSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import type {
  BrowserOpLogEntry,
  BrowserSnapshotElement,
  BrowserTabState,
  BrowserToolOptions,
  BrowserWaitUntil,
  BrowserWindowState,
  CredentialResolver,
} from './types.ts'

/** Default cooperative tool-call budget (ms). */
const DEFAULT_TIMEOUT_MS = 30_000
/** Default cap on waiting for Electron's loadURL promise (ms). */
const DEFAULT_LOAD_TIMEOUT_MS = 20_000
/**
 * Cap on the native `capturePage()` attempt before the renderer-side fallback
 * runs (ms). A hidden window can **hang** that call instead of rejecting it, and
 * an unbounded hang consumed the whole tool budget so the fallback never ran
 * (real-device report 2026-09-12: `tool call timed out after 30000ms`).
 */
const SCREENSHOT_PRIMARY_BUDGET_MS = 8_000
/**
 * Share of the call budget the renderer-side capture must keep in reserve (ms).
 *
 * It is the fallback's OWN bound as well (see
 * {@link BrowserRuntime.screenshotFallbackBudgetMs}) — reserving it without
 * enforcing it left the fallback able to eat the whole tool deadline.
 */
const SCREENSHOT_FALLBACK_RESERVE_MS = 5_000
/** Margin kept between the two bounded capture attempts and the tool deadline (ms). */
const SCREENSHOT_DEADLINE_MARGIN_MS = 1_000
/** Op-log ring size. */
const OP_LOG_LIMIT = 200
/**
 * Op-log summary caps (F-2, 2026-09-13 round 2).
 *
 * `record(..., summaryLimit)` applies these AFTER the value-level redaction, so
 * a credential that straddles the cut is masked instead of being clipped into a
 * plaintext head fragment. The limits keep the previous model-facing lengths:
 * the navigate summary showed a 200-character URL, and so on.
 */
const NAVIGATE_SUMMARY_LIMIT = 200 + 'navigate: '.length
const EVAL_SUMMARY_LIMIT = 60 + 'eval: '.length
const PAGE_STATE_SUMMARY_LIMIT = 120 + 'after-change: '.length
const SCREENSHOT_FALLBACK_SUMMARY_LIMIT = 120 + 'capturePage unavailable (); captured via CDP fromSurface:false'.length
const SELECT_VALUE_SUMMARY_LIMIT = 80
/**
 * Cap on the page-derived element name in the `browser_press` summary
 * (2026-09-17 审计 S02-04）。
 *
 * `keyReceivableTarget` 读的是 `document.activeElement.tagName` —— 谁被聚焦由
 * **页面**决定，而 HTML 的元素名没有长度上限（jsdom 实测 50000 字符的 tagName
 * 可被 focus）。该摘要落进内存 op log（OP_LOG_LIMIT=200 是唯一的内存界），并经
 * `/ops` 原样下发给蒙版页的活动面板；同一批页面派生的兄弟摘要（navigate/eval/
 * page_state/select）都显式带上限，这里补齐。上限走 `record(..., summaryLimit)`，
 * 即先脱敏后截断（F-2）。
 */
const PRESS_TARGET_SUMMARY_LIMIT = 64
/** Cap on the model-facing `wait_for` failure reason (F-2: applied after the
 * redaction — the page/CDP message is cut at the call site otherwise). */
const WAIT_FOR_REASON_LIMIT = 240
/**
 * Upper bound on the ORIGIN-scoped credential-activity window (R7, 2026-09-13
 * round 2 — F-3). R-4's window on the injecting TAB is unchanged: it stays shut
 * until that tab's own main-frame navigation, because the value is physically in
 * that document and eval could read it straight back. The origin-scoped mirror
 * only covers the storage channel (a sibling tab reading localStorage/cookies),
 * and R7 made it last for the whole session — an unrelated tab opened later on
 * the same origin could never eval/screenshot again. It is therefore bounded:
 * the immediate read-back is still refused (the window starts when the value is
 * injected), while the origin cannot be blocked forever. Configurable through
 * `BrowserToolOptions.credentialWindowTtlMs`.
 */
const CREDENTIAL_ORIGIN_WINDOW_TTL_MS = 5 * 60_000
/**
 * Hard cap on retained origin credential records (F-4, 2026-09-13 round 2).
 *
 * R7 kept one record — including the cleartext password — for every origin ever
 * filled, for the whole session; the adversarial re-check measured 40 records
 * after 40 fill+close cycles and flagged the unbounded growth (memory AND
 * plaintext residency) as P3. Deleting a record as soon as its last tab closes
 * was rejected on purpose: round-1's `audit-r6-outlets.spec.ts` locks the
 * fail-closed retention (a page can stash the value in localStorage and a LATER
 * tab of that origin then reads it back, so the value set must survive the tab).
 * The retention is therefore BOUNDED instead: past this many records the
 * least-recently-used one whose origin has no live tab is evicted. Eviction
 * order never touches an origin a live tab is showing — that would drop r7c-3's
 * protection — so the effective bound is `max(32, live origins)`.
 */
const MAX_CREDENTIAL_ORIGIN_RECORDS = 32
/** Cap on remembered redacted download display paths (R-5): the store keeps the
 * truthful handle, this map only holds the model-facing variant, and the
 * download list itself is pruned by `downloadLimit`. */
const DOWNLOAD_DISPLAY_PATH_LIMIT = 200

interface BrowserTab {
  readonly id: number
  readonly view: NativeView
  readonly cdp: CdpSession
  /** The session that created this tab (oplog attribution). */
  readonly ownerSession: string
  url: string
  title: string
  favicon: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  disposers: Array<() => void>
  /**
   * Credential values handed to this tab by `fillCredentials`. It is the value
   * set every **text** exit of this tab is scrubbed with, and its lifetime is
   * deliberately the TAB's lifetime (R-5, 2026-09-13): nothing clears it before
   * `destroyTab` drops the whole entry.
   *
   * R-4 emptied this list together with the credential window on the first
   * main-frame navigation, on the reasoning that "the values went with the old
   * document". That premise does not hold against a hostile page: a script can
   * copy the injected value into `sessionStorage`, a DOM node, a cookie, an
   * image or a server round-trip and read it back AFTER the navigation — the
   * independent re-verification did exactly that, and every text exit (page
   * text, title, URL, history, downloads) came back in cleartext. Retention is
   * therefore tab-scoped, not window-scoped: the window flag still governs
   * eval/screenshot, the value list keeps governing the text funnels.
   *
   * The converse does not hold — a username-only injection opens the window with
   * this list still empty (it holds passwords, whose redaction value is real
   * while a short username is an ordinary word).
   *
   * HONEST BOUNDARY (declared, not solved): the redaction matches the value
   * **verbatim**. A page may transform it (base64, reversed, split into
   * characters) before rendering and no value-level rule can see through that.
   */
  filledSecrets: string[]
  /**
   * Credential-activity window (R-4, 2026-09-13): true from a successful
   * `browser_fill_credentials` until the next main-frame cross-document
   * navigation. While it is open, `browser_eval` and `browser_screenshot` are
   * refused outright — the independent re-verification showed every value-level
   * defence can be transformed around (`btoa`, `slice`, cross-realm aliases,
   * pixels), so the *channel* is closed instead of the value. It is a separate
   * flag from {@link filledSecrets} because a username-only injection also opens
   * the window while contributing no redaction value.
   */
  credentialWindow: boolean
  /**
   * Out-of-process (cross-origin) subframes of this tab, keyed by their flat
   * CDP session id (R-4). Populated lazily by `ensureFrameTracking` and kept
   * current by `Target.attachedToTarget` / `Target.detachedFromTarget`. The
   * stored `tree` is the attach target's OWN `Page.getFrameTree`: the
   * authoritative source for its frame id, its parent, and its own descendants
   * (an OOPIF's same-process children never appear in the page session's tree).
   */
  oopifFrames: Map<string, { frameId: string; url: string; parentId: string | undefined; tree: RawFrameNode }>
  /** Whether `Target.setAutoAttach` + the attach listeners are installed. */
  frameTrackingReady: boolean
}

interface EvalResult {
  result?: { value?: unknown; type?: string }
  exceptionDetails?: unknown
}

/**
 * Origin-scoped credential accounting (R7, 2026-09-13).
 *
 * `BrowserTab.filledSecrets` / `.credentialWindow` remain the per-tab mirrors
 * every text funnel reads; this record is the authority for the scope those
 * mirrors are derived from — the ORIGIN, which is the scope of the storage a
 * page can stash an injected value in.
 */
interface OriginCredentialRecord {
  /** Injected values seen on this origin (password only, like the tab list). */
  secrets: string[]
  /**
   * Deadline (epoch ms) of the origin's credential-activity window, or
   * `undefined` when it is closed (F-3, 2026-09-13 round 2).
   *
   * R7 made the window origin-scoped but *session-permanent*: an unrelated tab
   * the user opened later on the same origin could never `browser_eval` or
   * `browser_screenshot` again, because the injecting tab happened to stay on
   * its document (SPA login). The window still covers the immediate read-back
   * (localStorage/cookies) — it simply has an upper bound now; see
   * {@link CREDENTIAL_ORIGIN_WINDOW_TTL_MS}.
   */
  windowUntil: number | undefined
  /** Tab that owns the open window (the one the credential was injected into):
   * its main-frame navigation ends the window (R-4 semantics), a sibling tab's
   * does not. */
  holder: number | undefined
  /** Last time a tab touched this origin (injection or arrival); the LRU key
   * for {@link MAX_CREDENTIAL_ORIGIN_RECORDS} (F-4, 2026-09-13 round 2). */
  lastUsed: number
}

/** Wait-for condition spec. */
/**
 * 浏览器窗口/标签标题的中性缺省值（按 locale）。
 *
 * 刻意不含厂商品牌：仓库里不留任何品牌描述。渠道构建下窗口标题应显示渠道名，
 * 由渠道包注入（迁移见 docs/planning/2026-09-10-channel-package-reference.md）。
 */
const BROWSER_DEFAULT_TITLE: Readonly<Record<HostLocale, string>> = {
  zh: 'AI 浏览器',
  en: 'AI Browser',
}

/**
 * Native window/tab-title fallback for one locale.
 *
 * The locale is passed in per call (never captured): the window can already be
 * open when the user switches the application language.
 * @param locale - locale to render the title in.
 * @returns the neutral default browser title.
 */
export function browserDefaultTitle(locale: HostLocale): string {
  return BROWSER_DEFAULT_TITLE[locale]
}

export interface WaitForOptions {
  condition: 'element-present' | 'element-visible' | 'text-appear' | 'url-change' | 'network-idle' | 'settled'
  selector?: string | undefined
  text?: string | undefined
  timeoutMs?: number | undefined
  /**
   * Absolute instant the whole tool call must return by (armed by the tool's
   * registered deadline minus a margin). Deducted from the effective wait when
   * the call actually starts running, so mutex/queue time counts against the
   * wait instead of pushing the tool past its deadline (2026-09-16 audit R3-C).
   */
  deadlineAt?: number | undefined
}

/** Control/turn state shared by the shell payload, the sidebar hint and the
 * model-facing `browser_list_tabs` note (2026-09-16). */
export interface BrowserControlState {
  /** The user holds 我来操作 — every agent browser action is refused. */
  controlled: boolean
  /** An agent operation is running/queued right now. */
  busy: boolean
  /** Tool name behind {@link busy} ('' when idle). */
  busyTool: string
  /**
   * True once an agent action was actually refused because the user holds
   * control: the AI is waiting for 「交给 AI」. Cleared when control returns or
   * the pool is cleared.
   */
  awaitingRelease: boolean
  /** Tool whose call was refused ('' when nothing is waiting). */
  awaitingReleaseTool: string
  /**
   * 由**用户**持有控制权的应用窗口 surface（§16.1 第 3 条：控制权按 surface 记）。
   *
   * 与 `controlled` 分开是两个不同的判据：`controlled` = 浏览器窗口被用户接管
   * （浏览器工具的池级闸门 + 蒙版），这里 = 某个应用窗口归人（只有针对那个
   * `app_id` 的操作被拒）。空数组 = 没有应用窗口归人。
   */
  userHeldSurfaces: Array<{ id: number, appId: string }>
}

/** Shell/panel state projection (GET /api/pico/browser/state). */
export interface BrowserShellState extends BrowserControlState {  tabs: BrowserTabState[]
  window: BrowserWindowState
  latestOp: BrowserOpLogEntry | null
  /** Overlay UI mode (capsule/panel/menu/viewer, or 'mask' while AI drives). */
  ui: { mode: OverlayMode | 'mask' }
}

/** State-change events emitted by the runtime (SSE stream). */
export type BrowserStreamEvent = 'state' | 'tab' | 'tab-meta' | 'busy' | 'takeover' | 'release' | 'ops'

/**
 * `waitForLoad` 需要的最小 webContents 面。
 *
 * 浏览器标签（`NativeView['webContents']`）与**应用窗口 surface**（注册表里的不透明
 * 句柄，§16.1）都要能传给同一个等待器；两者只是在 `on/removeListener/isLoading`
 * 上重合，所以这里声明结构最小面而不是 Electron 类型（本模块不 import electron）。
 */
interface LoadWaitTarget {
  on?(event: string, listener: (...args: unknown[]) => void): unknown
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown
  isLoading?(): boolean
}

/** Overlay UI modes (user-facing surfaces; the effective mode is forced to
 * 'mask' while the AI drives). */
export type OverlayMode = 'capsule' | 'panel' | 'menu' | 'viewer'

/** Runtime dependencies wired by the plugin. */
export interface RuntimeDeps {
  pool?: TabPool
  store?: BrowserStore
  currentUsername?: () => string | null
  /**
   * Locale provider for the copy the runtime produces (window title, activity
   * panel summaries, refusal messages).
   *
   * A PROVIDER, not a value: it is called at production time so a language
   * change applies to the next message instead of freezing the language the
   * plugin was applied with (the bug class documented in
   * `dsh-connectors/src/client/status-label.ts`). Absent ⇒ {@link DEFAULT_HOST_LOCALE}.
   */
  locale?: () => HostLocale
  /**
   * Surface 注册表（§16.1）：应用窗口由宿主（`@picoaide/dsh-wasm-apps-host`）经
   * `@picoaide/dsh-browser/surface` 注册进来，工具面按它寻址；**浏览器标签**这一半
   * 由 {@link BrowserRuntime.syncSurfaces} 从池子镜像过去。
   *
   * 缺席（纯单测/极简宿主）⇒ 工具面退回"只有浏览器标签"的老口径，不报错。
   */
  surfaces?: SurfaceRegistry
  /**
   * 本安装的应用源 scheme（渠道包注入；§10/§16.1）。宿主注册应用窗口 surface 时
   * 必须与它一致 —— 浏览器侧不猜、也不写死任何渠道值（CHN-3）。
   */
  appOriginScheme?: string
}

/**
 * The embedded browser service (v4.2 single pool). Constructed by the plugin
 * with the real adapter; tests inject a mock adapter plus optional deps.
 */
export class BrowserRuntime {
  private readonly tabs = new Map<number, BrowserTab>()
  private nextTabId = 1
  /** Locale provider for runtime-produced copy (see {@link RuntimeDeps.locale}). */
  private readonly locale: () => HostLocale
  /**
   * Surface 注册表（§16.1）。工具面靠它区分"浏览器标签"与"应用窗口"：
   * 配额/台账只算前者，默认寻址只指向前者，应用窗口必须显式给 `app_id`。
   */
  readonly surfaces: SurfaceRegistry | undefined
  /** 本安装的应用源 scheme（渠道注入；缺省 = 未配置，应用窗口注册时不带 scheme）。 */
  readonly appOriginScheme: string | undefined
  /**
   * Credential accounting keyed by ORIGIN (R7, 2026-09-13): the value set and
   * the activity window a `browser_fill_credentials` created, scoped to what
   * they actually protect (origin-shared storage: localStorage, cookies,
   * sessionStorage). Every tab on that origin inherits both, and the record
   * outlives the tab so a tab opened later still gets the value set — bounded
   * by the window TTL (F-3) and by {@link MAX_CREDENTIAL_ORIGIN_RECORDS} (F-4).
   */
  private readonly credentialOrigins = new Map<string, OriginCredentialRecord>()
  private readonly ops: BrowserOpLogEntry[] = []
  private opSeq = 0
  /**
   * Set while the AI is blocked by the user gate: the first agent browser
   * action that was refused because the user holds 我来操作 control
   * (2026-09-16). Non-null until control returns (`setUserControl(false)`) or
   * the pool is cleared; surfaced through {@link controlState} so the shell,
   * the sidebar hint and `browser_list_tabs` can all say the same thing.
   */
  private gateBlock: { at: number; tool: string } | null = null
  /** Redacted display paths of downloads, keyed by download id (R-5). The store
   * keeps the real on-disk path for `downloads_open`; only the model-facing
   * projection swaps this in. Bounded by {@link DOWNLOAD_DISPLAY_PATH_LIMIT}. */
  private readonly downloadDisplayPaths = new Map<number, string>()
  private window: NativeBrowserWindow | null = null
  /** AI-control overlay view (transparent, z-top): hosts the AI indicator
   * capsule, the activity panel, the ⋮ menu, the viewers and the busy-mask
   * pill. Its bounds follow the current UI mode (`overlayBounds`). */
  private overlay: NativeView | null = null
  /** User-chosen overlay mode (capsule/panel/menu/viewer); the effective mode
   * is forced to 'mask' while the AI drives (busy && !controlled). */
  private overlayMode: OverlayMode = 'capsule'
  /** Ledger tabs registered but not yet materialized into views (lazy
   * restore: the browser window must not pop up at app boot). */
  private pendingLedgerTabs: Array<{ tabId: number; url: string; title: string }> = []
  private materializing = false
  private materializeEpoch = 0
  private readonly guard: BrowserGuard
  private windowResizeDisposer: (() => void) | null = null
  private windowClosedDisposer: (() => void) | null = null
  private windowFocusDisposer: (() => void) | null = null
  private disposed = false
  private partition: string
  private readonly listeners = new Set<(event: BrowserStreamEvent) => void>()
  private shellOrigin: string | undefined
  private lastAgentId = ''
  readonly pool: TabPool
  store: BrowserStore

  constructor(
    private readonly adapter: ElectronAdapter,
    options: BrowserToolOptions = {},
    private readonly credentials?: CredentialResolver,
    partition?: string,
    deps: RuntimeDeps = {},
  ) {
    this.options = {
      maxTabs: options.maxTabs ?? 16,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      loadTimeoutMs: options.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS,
      evalEnabled: options.evalEnabled ?? true,
      snapshotLimit: options.snapshotLimit ?? 200,
      textLimit: options.textLimit ?? 32 * 1024,
      screenshotMaxWidth: options.screenshotMaxWidth ?? 1280,
      screenshotQuality: options.screenshotQuality ?? 70,
      downloadDir: options.downloadDir ?? '.picoaide-downloads',
      credentialWindowTtlMs: Number.isFinite(options.credentialWindowTtlMs) && (options.credentialWindowTtlMs ?? 0) > 0
        ? options.credentialWindowTtlMs as number
        : CREDENTIAL_ORIGIN_WINDOW_TTL_MS,
    }
    this.guard = new BrowserGuard(adapter)
    this.partition = partition ?? BROWSER_PARTITION
    this.locale = deps.locale ?? (() => DEFAULT_HOST_LOCALE)
    this.surfaces = deps.surfaces
    this.appOriginScheme = deps.appOriginScheme
    // The pool this runtime builds for itself must speak the same language as
    // the runtime (its user-gate refusals reach the activity panel AND the
    // model). Production composes a pool in `index.ts` with the same provider;
    // this branch is for embedders/tests that only pass `locale`
    // (2026-09-16 R9 audit: the provider was dropped here).
    this.pool = deps.pool ?? new TabPool({
      ...(options.maxTabs !== undefined ? { maxTabs: options.maxTabs } : {}),
      locale: this.locale,
    })
    if (deps.store !== undefined) this.store = deps.store
    else this.store = new BrowserStore({ dir: this.partition.replace(/[^a-zA-Z0-9_-]/g, '_') + '-store' })
    this.pool.onChange((event) => this.emitMapped(event))
  }

  private emitMapped(event: string): void {
    const mapped = (['tab', 'tab-meta', 'busy', 'takeover', 'release'] as const).includes(event as never)
      ? event as BrowserStreamEvent
      : 'state'
    // 「AI 被用户闸挡住」的提示随控制权交还一起消失 —— 池子被清空（关闭浏览器、
    // 窗口销毁、切换会话/分区、清数据）也会发 release，所以这条覆盖全部路径
    // （2026-09-16）。
    if (mapped === 'release') this.gateBlock = null
    if (mapped === 'busy' || mapped === 'takeover' || mapped === 'release') this.applyOverlay()
    this.emitAll(mapped)
  }

  private emitAll(event: BrowserStreamEvent): void {
    for (const listener of [...this.listeners]) {
      try { listener(event) } catch { /* bus must never break */ }
    }
  }

  onState(_event: BrowserStreamEvent, listener: () => void): () => void {
    const wrapper = (): void => listener()
    this.listeners.add(wrapper)
    return () => { this.listeners.delete(wrapper) }
  }

  onAny(listener: (event: BrowserStreamEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  readonly options: Required<BrowserToolOptions>

  // ------------------------------------------------------------- accessors

  get windowState(): BrowserWindowState {
    return {
      created: this.window !== null && !this.window.isDestroyed(),
      visible: this.window !== null && !this.window.isDestroyed() && this.window.isVisible(),
    }
  }

  get opLog(): readonly BrowserOpLogEntry[] {
    return [...this.ops].reverse()
  }

  get controlled(): boolean {
    return this.pool.controlled
  }

  get isBusy(): boolean {
    return this.pool.isBusy()
  }

  get busyToolName(): string {
    return this.pool.busyToolOf()
  }

  currentTabId(): number | undefined {
    return this.pool.activeTab
  }

  /** Record the calling session id (oplog attribution).
   *
   * NOTE: this runs BEFORE the operation acquires the global mutex, so the
   * value is only a hint — `agentRun` snapshots it at call time and restores
   * it inside the critical section (a queued tool must never attribute its
   * ops to another agent that called `setAgentContext` in the meantime). */
  setAgentContext(agentId: string | undefined): void {
    this.lastAgentId = agentId ?? ''
  }

  /** Drop the op log (user switch / logout): a new account must never see the
   * previous account's browsing trail (host names, paths, token-bearing URLs).
   * The sequence counter resets too so the UI's "newest op" logic cannot keep
   * a stale high-water mark. */
  clearOps(): void {
    this.ops.length = 0
    this.opSeq = 0
    this.emitAll('ops')
  }

  listTabs(): BrowserTabState[] {
    return [...this.tabs.values()].map((tab) => this.projectTabState(tab))
  }

  /**
   * Control/turn-state projection — ONE source for the shell payload, the
   * sidebar hint (`/state`) and the model-facing `browser_list_tabs` note.
   *
   * 2026-09-21（§16.1 第 3 条）：控制权**按 surface** 记。`userHeldSurfaces` 是那
   * 一半的投影 —— 池级 `controlled` 仍然只表示"浏览器窗口被用户接管"（它驱动蒙版与
   * 浏览器工具的闸门，语义不能改），应用窗口由用户按住时在这里如实列出，UI 与模型都
   * 能看见"哪个窗口现在归人"。
   */
  controlState(): BrowserControlState {
    return {
      controlled: this.pool.controlled,
      busy: this.pool.isBusy(),
      busyTool: this.pool.busyToolOf(),
      awaitingRelease: this.gateBlock !== null,
      awaitingReleaseTool: this.gateBlock?.tool ?? '',
      userHeldSurfaces: this.userHeldSurfaces(),
    }
  }

  /** 由用户持有控制权的应用窗口 surface（`kind:'app'`；浏览器标签不在这里）。 */
  userHeldSurfaces(): Array<{ id: number, appId: string }> {
    return (this.surfaces?.userHeldSurfaces() ?? []).map(surface => ({
      id: surface.id,
      appId: surface.appId ?? '',
    }))
  }

  /**
   * 设某个 surface 的控制权归属（§16.1 第 3 条）。
   *
   * 与浏览器窗口上的胶囊**同一个语义**：用户点「我来操作」= `'user'`，同一个按钮
   * （「交给 AI」）= `'agent'`；空白处点击 / Esc / 面板都不得调用它（2026-09-11 定案）。
   * 幂等：同值不记录、不发事件。
   *
   * 用户接管某个应用窗口时只停**那个窗口**的加载（浏览器标签的 `stopPendingLoads`
   * 管不到它），并记一条 op 让活动时间线可见。
   * @param id - surface id（未知 id ⇒ 什么都不做，返回 false）。
   * @param owner - 新的归属。
   * @param actor - 记录归属（用户按钮 = 'user'）。
   * @returns true = 状态确实变了。
   */
  setSurfaceControl(id: number, owner: SurfaceControlOwner, actor: RecordActor = 'user'): boolean {
    const registry = this.surfaces
    if (registry === undefined) return false
    const before = registry.surfaceControl(id)
    const surface = registry.setSurfaceControl(id, owner)
    if (surface === undefined) return false
    if (before === owner) return false
    if (owner === 'user') {
      const wc = asSurfaceWebContents(surface.webContents)
      try { wc?.stop?.() } catch { /* teardown never throws */ }
      this.record('browser_takeover', 0, `user took over ${surfaceLabel(surface)}`, false, actor)
    } else {
      this.record('browser_release', 0, `user released ${surfaceLabel(surface)}`, false, actor)
    }
    this.emitAll('state')
    return true
  }

  /** 某个 surface 的控制权归属（未知 id ⇒ undefined；缺省 `'agent'`）。 */
  surfaceControl(id: number): SurfaceControlOwner | undefined {
    return this.surfaces?.surfaceControl(id)
  }

  shellState(): BrowserShellState {
    const tabs = [...this.tabs.values()].map((tab) => this.projectTabState(tab))
    return {
      tabs,
      window: this.windowState,
      ...this.controlState(),
      latestOp: this.ops.at(-1) ?? null,
      ui: { mode: this.effectiveOverlayMode() },
    }
  }

  latestOp(): BrowserOpLogEntry | null {
    return this.ops.at(-1) ?? null
  }

  /**
   * Restore the persisted tab ledger (lazy, Chrome-like session restore):
   * registry metadata is repopulated immediately; VIEWS are materialized on
   * first browser use (`ensureWindow`/`showWindow`) — restoring must never
   * pop the window at app boot or on a session switch.
   */
  restoreLedger(): void {
    // 换账本 = 换归属（启动恢复 / 用户切换）：让**在飞**的 materialize 立刻作废。
    // 只靠循环顶部的代际检查不够 —— 已经进到 createTabReal 的那一个 tab 会跑完，
    // 把上一个账号的 URL/标题写进新账号的 ops/history/ledger（2026-09-15 审计 P1-2）。
    // 注意必须放在 `ledger === undefined` 早退**之前**：新账号的空账本同样要让
    // 上一个账号的在飞恢复作废。
    this.materializeEpoch++
    const ledger = this.store.getGroupLedger()
    if (ledger === undefined) return
    const ledgerTabs = ledger.tabs ?? []
    this.pool.restoreLedger({
      version: 1,
      activeTabId: ledger.activeTabId,
      tabs: ledgerTabs,
      savedAt: ledger.savedAt ?? Date.now(),
    })
    let maxId = 0
    for (const item of ledgerTabs) {
      if (typeof item.tabId === 'number') maxId = Math.max(maxId, item.tabId)
    }
    this.nextTabId = Math.max(this.nextTabId, maxId + 1)
    this.pendingLedgerTabs = ledgerTabs
      .filter((item): item is { tabId: number; url: string; title: string } => typeof item.tabId === 'number')
      .map((item) => ({ tabId: item.tabId, url: item.url ?? '', title: item.title ?? '' }))
    this.relayout()
  }

  /** Materialize pending ledger tabs into real views (idempotent). Triggered
   * when the browser actually opens. Each restored tab goes through the SAME
   * serial mutex and tab-slot reservation as an agent `browser_open` (P2-26):
   * restoring must never bypass `maxTabs` or interleave with a live operation.
   * Restored tabs are attributed to `'restore'` (not `'ai'`) so they neither
   * steal the agent's attribution nor surface the window. A session switch /
   * closeAll bumps the epoch, cancelling any in-flight materialization so a
   * previous user's tabs can never resurrect under the new user's partition. */
  materializePendingTabs(): void {
    if (this.materializing) return
    const pending = this.pendingLedgerTabs
    if (pending.length === 0) return
    this.materializing = true
    const epoch = this.materializeEpoch
    void (async () => {
      try {
        for (const item of [...pending]) {
          if (epoch !== this.materializeEpoch || this.disposed) return
          if (this.tabs.has(item.tabId)) {
            this.pendingLedgerTabs = this.pendingLedgerTabs.filter((p) => p.tabId !== item.tabId)
            continue
          }
          try {
            // Quota semantics: restore consumes a tab slot like any other open
            // (tryReserveTab = fail-fast, no queue). When the pool is full the
            // remaining tabs STAY PENDING and are retried on the next
            // materialization attempt — restore never exceeds maxTabs.
            const created = await this.pool.withOperation('browser_restore', async () => {
              // 进临界区后再校验一次代际（2026-09-15 审计 P1-2）：等待互斥锁/用户闸
              // 期间可能已经发生过一次 restoreLedger/closeAll（会话切换），此时 item
              // 属于**上一个账号**的账本 —— 继续建 tab 会把它的 URL/标题写进新账号的
              // history/ledger，并在新账号的分区里真的把页面加载起来。
              if (epoch !== this.materializeEpoch) return false
              const reservation = this.pool.tryReserveTab()
              if (reservation === undefined) return false
              try {
                const tab = await this.createTabReal(item.url, undefined, item.tabId, 'restore', undefined, reservation)
                if (epoch !== this.materializeEpoch) {
                  // 建完才发现代际变了（加载期间用户切换）：销毁刚建出来的 tab。
                  // 互斥锁保证新账号的恢复还没开始建 tab（不会误杀它的同 id tab）。
                  this.destroyTab(tab.id)
                  return false
                }
                return true
              } catch (error) {
                // 令牌是幂等的：registerTab 已兑现时这里是 no-op（P0-2 修复）。
                this.pool.releaseReservation(reservation)
                throw error
              }
            })
            if (!created) return
            if (epoch === this.materializeEpoch) {
              this.pendingLedgerTabs = this.pendingLedgerTabs.filter((p) => p.tabId !== item.tabId)
            }
          } catch (cause) {
            // A restored tab that fails to load is dropped (createTabReal's
            // error path already cleans view + registry meta). A user takeover
            // aborts materialization: the remaining tabs stay pending.
            this.pendingLedgerTabs = this.pendingLedgerTabs.filter((p) => p.tabId !== item.tabId)
            if (cause instanceof BrowserError && cause.code === 'window-controlled') return
          }
        }
      } finally {
        this.materializing = false
      }
      if (!this.disposed && epoch === this.materializeEpoch) {
        // relayout() 会碰窗口/视图：窗口销毁竞态下可能抛 —— 这里是最外层
        // `void (async () => …)()` 的尾部，抛出去就是未处理拒绝（审计 P2-4）。
        try {
          const ledger = this.store.getGroupLedger()
          if (ledger !== undefined && ledger.activeTabId !== undefined && this.pool.has(ledger.activeTabId)) {
            this.pool.setActiveTab(ledger.activeTabId)
          }
          this.relayout()
          this.saveLedger()
        } catch (cause) {
          console.error('[dsh-browser] post-restore relayout failed', cause)
        }
      }
    })()
  }

  /** Persist the tab ledger (host wires this on every state change).
   *
   * R-5 (2026-09-13): the pool metadata is raw (`wc.getURL()`/`getTitle()`), so
   * the tab's value set is applied here as well — the store's key-level rule
   * alone let a page-chosen parameter name or a bare fragment reach
   * `groups.jsonl` in cleartext, and the ledger is re-served to the shell on the
   * next start. */
  saveLedger(): void {
    const ledger = this.pool.snapshotLedger()
    const tabs = ledger.tabs?.map((entry) => {
      const tab = this.tabs.get(entry.tabId)
      if (tab === undefined) return entry
      return {
        ...entry,
        url: redactFilledSecretsText(tab, entry.url, { verbatim: true }),
        title: redactFilledSecretsText(tab, entry.title),
      }
    })
    this.store.saveGroupLedger(tabs === undefined ? ledger : { ...ledger, tabs })
  }

  /**
   * Swap the partition used by NEW tab views (user switch) and the store.
   *
   * The mask overlay deliberately does **NOT** follow this switch any more
   * (2026-09-21, §7b option A): it lives in the DEFAULT session, the jar that
   * already holds the application's `dsh-auth-*` proof cookie for the shell
   * window, so a user switch cannot invalidate its write proof — the new login
   * simply replaces the cookie in that one jar. Before that change the mask
   * followed the partition and the proof had to be COPIED into the tab jar.
   */
  setPartition(partition: string): void {
    if (this.partition === partition) return
    this.partition = partition
  }

  /** Switch the per-user store (session change): re-point ledger/stores. */
  setStore(store: BrowserStore): void {
    this.store = store
  }

  // ------------------------------------------------------------ tab creation

  /** Set the loopback origin the shell/overlay pages are served from. */
  setShellOrigin(origin: string): void {
    this.shellOrigin = origin
  }

  /**
   * Decide whether a **model-facing** navigation may proceed.
   *
   * 除了 scheme 策略（{@link DownloadGuard.allowNavigation}）之外，还要拒**本机目标**
   * （2026-09-21 三轮/四轮审计 P1-①，见 docs/decisions/2026-09-21-app-author-data-surface.md §7b）：
   *
   *   - 当时的形态：内置浏览器的分区**故意镜像**了 shell 的 `dsh-auth-*` cookie（本插件
   *     自己两个 shell 页面的写操作要靠它过 `requireWriteProof`），而导航策略对浏览器标签
   *     放行一切 `http(s)`；两者叠加 ⇒ 模型只要 `browser_navigate` 到
   *     `http://127.0.0.1:<port>/api/pico/...` 就天然持有那把 cookie，**任何**依赖持有性
   *     证明的本机守卫（不只是 `unmask`）都会被绕过 —— 因为它驱动的那个标签页**就是**
   *     一个持有 cookie 的真页面；
   *   - 2026-09-21 §7b **方案 A** 已把凭据移出模型可驱动的 jar（蒙版改跑默认 session，
   *     镜像删除）。判据**保留**为**纵深防御**：本机回环面是宿主控制面（登录态、连接器、
   *     应用数据、浏览器写面），模型驱动的标签不该有任何一条通路落在它上面 ——
   *     "今天那个 jar 里没凭据"不等于"明天不会有别的凭证"。
   *
   * 口径（2026-09-21 四轮审计后收紧，方案 A 后不变）：**本机一律不访问**。
   *
   * 宿主自己 load 两个 shell 页面走的是 `webContents.loadURL`，**不经过**这里
   * （`ensureWindow`/`mountOverlay`），所以接管蒙版与工具栏不受影响。
   * @param url - 候选 URL（模型输入 / `window.open` 目标 / 程序化下载）。
   * @returns true 表示可以继续。
   */
  private navigationAllowed(url: string): boolean {
    if (this.isForbiddenLocalTarget(url)) {
      // 不在这里写 op log：`record` 需要 tab id，而本判据同时服务 window.open / 下载
      // 两条没有 tab 的路径。拒绝本身是**可见**的 —— 导航抛 `navigation-blocked`
      // （模型与工具结果都能看到），window.open 由调用点记 `browser_window_open denied`。
      return false
    }
    return this.guard.allowNavigation(url)
  }

  /**
   * 判断 URL 是否是"模型不得访问的本机目标"。
   *
   * 覆盖两类（2026-09-21 三轮/四轮审计，见 docs/decisions/2026-09-21-app-author-data-surface.md §7b）：
   *
   *  1. **本机 shell origin**（`shellOrigin` 精确相等）；
   *  2. **任何本机主机名**（判定唯一实现在 `guard.isLocalHostname`：`127.0.0.0/8`、
   *     `::1`/`::`、IPv4-mapped、`localhost` 及其尾点/子域、`ip6-localhost` 等）——
   *     为什么不能只拒 shell origin（四轮审计当时的形态）：镜像的 `dsh-auth-*` 是
   *     **host-only** cookie，而 **cookie 不看端口** ⇒ 浏览器把它送到 `127.0.0.1` 的
   *     **任意端口**。真机实测：模型在自己的端口上起一个静态页并导航过去，就能在自己的
   *     服务器日志里拿到这把 cookie（等价于本机控制面的 bearer 凭据）。同 host 不同端口
   *     属 **same-site**，SameSite=Strict **不拦**它 —— 所以"外部页面 iframe 本机端口"
   *     那条路同样是危险的。方案 A 删掉了镜像，但判据按主机名一刀切保留：
   *     逐端口/逐来源的例外只会给下一次凭据回流留缝。
   *
   * 因此口径是：**AI 浏览器不访问本机地址**（这不是它的用途 —— 平台自己的页面由宿主
   * `webContents.loadURL` 直接加载，应用走应用窗口面，都不经过这里）。
   * 反向对照（不得退化成"什么都拒"）见 tests/audit-0921-shell-origin.spec.ts。
   * @param url - 候选 URL。
   * @returns true 表示该目标禁止模型导航。
   */
  private isForbiddenLocalTarget(url: string): boolean {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      // 解析失败 ≠ 安全：带 scheme 的绝对 URL 在 Node 侧解析失败、Chromium 侧却可能接受
      // （六轮审计实测 `http://[::ffff:0177.0.0.1]:PORT/` → 归一化为回环）⇒ 这种输入按
      // "禁止"处理；纯相对 URL 交给 guard 的既有语义（同源、不越界）。
      return looksLikeAbsoluteUrl(url)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    // 本机判定的**唯一实现**在 guard（含 IPv6 / IPv4-mapped / `*.localhost` 等写法），
    // 这里不复制一份 —— 两份判据必然漂移，而漂移方向是"漏掉某个能落到本机的写法"。
    if (isLocalHostname(parsed.hostname)) return true
    const shell = this.shellOrigin
    if (shell !== undefined && shell !== '') {
      try {
        return parsed.origin === new URL(shell).origin
      } catch {
        return false
      }
    }
    return false
  }

  /**
   * Open a tab (agent path: serial + quota wait under the user gate; user
   * path: fail-fast quota, gate bypassed).
   *
   * `inheritSecretsFrom` (R-5, 2026-09-13): a tab opened by a credential-bearing
   * page (`window.open` / `target=_blank`) inherits that tab's redaction VALUE
   * set, not its credential window. The child document never received the
   * credential, but the opener can put it in the popup URL (`/popup?pw=` + value)
   * — the independent re-verification read it straight out of `browser_list_tabs`
   * while the child tab sat there with an empty set (R-5 F7). Inheriting makes
   * every child text exit value-scrubbed too; eval/screenshot stay available
   * because nothing was injected into that document.
   */
  async open(url: string | undefined, signal?: AbortSignal, user = false, inheritSecretsFrom?: number): Promise<BrowserTabState> {
    if (this.disposed) throw new Error('browser: runtime disposed')
    if (user) {
      const reservation = this.pool.tryReserveTab()
      if (reservation === undefined) {
        throw browserError('quota', 'browser: tab limit reached — close a tab first')
      }
      try {
        return await this.createTabReal(url, signal, undefined, 'user', inheritSecretsFrom, reservation)
      } catch (error) {
        // 令牌幂等：导航失败时 createTabReal 已经 removeTab（槽位还回去了），
        // 这里再退一次不能把预留计数也抹掉（否则池子静默缩容，P0-2）。
        this.pool.releaseReservation(reservation)
        throw error
      }
    }
    return await this.withAgentAttribution('browser_open', async () => {
      const reservation = await this.pool.reserveTab(signal)
      try {
        return await this.createTabReal(url, signal, undefined, 'ai', inheritSecretsFrom, reservation)
      } catch (error) {
        this.pool.releaseReservation(reservation)
        throw error
      }
    }, signal)
  }

  private async createTabReal(url: string | undefined, signal: AbortSignal | undefined, fixedId: number | undefined, actor: RecordActor, inheritSecretsFrom?: number, reservation?: TabReservation): Promise<BrowserTabState> {
    const id = fixedId ?? this.nextTabId++
    const view = this.adapter.createView(this.partition)
    // Every CDP command is bounded by the tool budget: a wedged renderer
    // rejects the call instead of holding the global mutex forever (P0-4).
    const cdp = new CdpSession(view.webContents.cdp, { timeoutMs: this.options.timeoutMs })
    try {
      await cdp.attach()
    } catch (cause) {
      try { view.destroy() } catch { /* teardown never throws */ }
      throw cause
    }
    const tab: BrowserTab = { id, view, cdp, ownerSession: this.lastAgentId, url: '', title: '', favicon: '', loading: false, canGoBack: false, canGoForward: false, disposers: [], filledSecrets: [], credentialWindow: false, oopifFrames: new Map(), frameTrackingReady: false }
    // R-5 (F7): inherit the opener's redaction value set (never its window).
    if (inheritSecretsFrom !== undefined) {
      const opener = this.tabs.get(inheritSecretsFrom)
      if (opener !== undefined) tab.filledSecrets.push(...opener.filledSecrets)
    }
    this.tabs.set(id, tab)
    this.pool.registerTab(id, '', '', reservation)

    try {
      // User-created tabs (shell ＋ / address bar) surface the window; agent-created
      // tabs and ledger restore keep it hidden (2026-09-08 product decision).
      //
      // 2026-09-17（审计 S5）：`actor === 'user'` 还有一条非用户动作来源 —— 用户
      // 持有控制权时页面自行 window.open 会被判成 user 路径，而那一刻用户可能
      // 已经切走或最小化，再 show() 就是把窗口拽回前台。所以只在"窗口还不存在
      // （用户第一次点开浏览器）"或"窗口真的在前台（用户正看着它）"时才显示。
      const wantShow = actor === 'user' && (this.window === null || this.windowAttended(this.window))
      const win = await this.ensureWindow(this.shellOrigin, wantShow)
      const bounds = this.contentBounds()
      view.attach(win, bounds)
      this.relayout()
      // Checkpoint: a takeover that landed while the window/attach was awaited
      // must abort this tab creation (the catch below tears the view down).
      // The user's own + / address-bar path is allowed to create/load tabs
      // while they hold control; only agent/restore work is interruptible.
      if (actor !== 'user') this.assertAgentStillAllowed('browser_open')

      // `target=_blank` / window.open must not silently vanish (P2-30): open
      // the URL as a new tab through the normal path (quota, gate, navigation
      // policy, op log) and deny the native popup. A denied or failed open is
      // recorded as a failed op so the activity panel shows it.
      //
      // While the USER holds control (我来操作) no agent operation can be
      // running, so a popup at that moment is user-initiated: it MUST take the
      // user path — routing it through the agent path parked it behind the
      // user's own gate forever (the tab only appeared after 交给 AI, as a
      // burst; 2026-09-11 fix).
      view.webContents.setWindowOpenHandler((details) => {
        const target = typeof details?.url === 'string' ? details.url : ''
        const userInitiated = this.pool.controlled
        if (target === '' || !this.navigationAllowed(target)) {
          this.record('browser_window_open', id, `window.open denied: ${target}`, true)
          return { action: 'deny' }
        }
        this.record('browser_window_open', id, `window.open → new tab: ${target}`, false, userInitiated ? 'user' : 'ai')
        // R-5 (F7): the popup inherits this tab's redaction value set — the
        // opener commonly puts the injected value in the popup URL, and an
        // empty set on the child tab published it in cleartext.
        void this.open(target, undefined, userInitiated, id).catch((cause: unknown) => {
          const message = cause instanceof Error ? cause.message : String(cause)
          this.record('browser_window_open', id, `window.open failed: ${message}`, true)
        })
        return { action: 'deny' }
      })

      /**
       * 顶层导航的**第二道闸**：`will-navigate`（页面自己发起的导航：`location.href=…`、
       * 链接点击、表单提交、meta refresh）与 `will-redirect`（**服务端 302/303**）。
       *
       * 为什么必须有它（2026-09-21，与三轮审计 P1-① 同一族）：`browser_navigate`
       * 那条闸只罩"模型显式调用的导航"，而这两种导航**不经过**它 ——
       *   · 模型可以先导航到一个**它控制的**外站，再让那个站 302 到
       *     `http://127.0.0.1:<port>/api/pico/...`（Electron 不触发 `will-navigate` 于重定向）；
       *   · 或（若 eval 允许）直接 `location.href = …`。
       * 两者都发生在**持有被镜像 cookie 的标签里**，于是同样绕过所有依赖持有性证明的本机守卫。
       * 只判 shell origin（与 {@link isShellOriginUrl} 同一份判据），不碰其它回环端口。
       * @param event - Electron 的导航事件（`preventDefault()` 取消）。
       * @param target - 目标 URL。
       */
      const refuseLocalNavigation = (...args: unknown[]): void => {
        const event = args[0] as { preventDefault?: () => void } | undefined
        const target = typeof args[1] === 'string' ? args[1] : ''
        if (!this.isForbiddenLocalTarget(target)) return
        event?.preventDefault?.()
        this.record('navigate', id, `navigation denied (local target, ${stripSensitiveUrl(target).slice(0, 120)})`, true)
      }
      view.webContents.on('will-navigate', refuseLocalNavigation)
      view.webContents.on('will-redirect', refuseLocalNavigation)
      // **子框架**也必须管（2026-09-21 四轮审计 P0）：`will-navigate` / `will-redirect`
      // 只报主框架，而 `<iframe src="http://127.0.0.1:<端口>/api/pico/...">` 是子框架导航 ——
      // 模型先用一个自己控制的**本机页面**做父页（同 host ⇒ same-site ⇒ 镜像 cookie 会被带上），
      // 再 `browser_eval({frame:1})` 读子框架内容，就能拿回 `unmask` 后的行数据（真机实测）。
      // 上面"禁一切本机目标"已经掐掉了"父页落在本机"这条前提，这条是**纵深防御**：
      // 即便将来有人放宽了主框架策略，子框架也不会成为绕过口。
      // Electron 只给一个 details 对象（无第二个 url 参数），且主框架也会走这里 ⇒ 一并判。
      const refuseLocalFrameNavigation = (...args: unknown[]): void => {
        const details = args[0] as { url?: unknown, preventDefault?: () => void } | undefined
        const target = typeof details?.url === 'string' ? details.url : ''
        if (!this.isForbiddenLocalTarget(target)) return
        details?.preventDefault?.()
        this.record('navigate', id, `frame navigation denied (local target, ${stripSensitiveUrl(target).slice(0, 120)})`, true)
      }
      view.webContents.on('will-frame-navigate', refuseLocalFrameNavigation)

      view.webContents.on('did-start-loading', () => {
        tab.loading = true
        this.pool.updateTabMeta(id, tab.url, tab.title)
        this.emitAll('tab')
      })
      view.webContents.on('did-stop-loading', () => {
        tab.loading = false
        this.updateTabState(tab)
      })
      view.webContents.on('did-navigate', () => {
        // A main-frame cross-document navigation is the end of the
        // credential-activity window (R-4): the injected values are no longer in
        // the document, so their read-back risk is gone with it. Belt and braces
        // next to the CDP event below — Electron's `did-navigate` fires for the
        // same navigation, and is a no-op when the window is already closed.
        this.exitCredentialWindow(tab)
        this.updateTabState(tab)
      })
      // `did-navigate-in-page` (same-document) deliberately does NOT close the
      // window: the very same document (and the credentials in it) is still up.
      view.webContents.on('did-navigate-in-page', () => this.updateTabState(tab))
      view.webContents.on('page-title-updated', () => this.updateTabState(tab))
      view.webContents.on('page-favicon-updated', (_event: unknown, favicons: unknown) => {
        const first = Array.isArray(favicons) ? favicons[0] : undefined
        tab.favicon = typeof first === 'string' ? first : ''
        this.emitAll('tab-meta')
      })
      const wc = view.webContents
      view.webContents.on('render-process-gone', () => {
        const target = tab.url
        this.record('browser_page_crash', id, 'page process gone — rebuilding')
        if (target !== '' && !wc.isDestroyed()) {
          void wc.loadURL(target).catch(() => {})
        }
      })

      // Credential-activity window, CDP half (R-4): the model-facing definition
      // of "the tab navigated" is the protocol's, not Electron's. Only a
      // main-frame (`parentId === undefined`) `Page.frameNavigated` closes the
      // window; subframe navigations never do, and same-document navigations
      // emit `Page.navigatedWithinDocument` instead, so they never do either.
      tab.disposers.push(tab.cdp.on('Page.frameNavigated', (params) => {
        const frame = (params as { frame?: { parentId?: string } }).frame
        if (frame === undefined || frame.parentId !== undefined) return
        this.exitCredentialWindow(tab)
      }))
      // Enable the Page domain ONCE, here (never from `fillCredentials`): if
      // Chromium re-announced the current document on enable, doing it after an
      // injection would immediately close a window that had just opened. Here no
      // window can exist yet, so the notification is inert.
      void tab.cdp.send('Page.enable').catch(() => { /* mock/older protocol: `did-navigate` still closes the window */ })

      const session = view.webContents.session
      // 分区级幂等（§16.1：归属 = 分区初始化，不是建 tab 时）。重复调用是 no-op，
      // 所以这里不再需要 per-tab 的 disposer；真正的安装点是分区初始化路径。
      ensureSessionGuard(session)
      // Downloads are a session-level event with no tab identity: attribute
      // the op to whichever tab is active when it fires (falling back to the
      // registering tab). The guard itself is ref-counted per tab (P0-5).
      tab.disposers.push(this.guard.installDownloadGuard(session, (summary) => {
        this.record('browser_download', this.pool.activeTab ?? id, summary)
      }, this.downloadRecorder(), '', actor, this.options.downloadDir))

      if (url !== undefined && url !== '') {
        await this.navigateInternal(id, url, 'domcontentloaded', actor)
      }
      this.updateTabState(tab)
      this.record('browser_open', id, url === undefined || url === '' ? 'new tab' : url, false, actor)
      void signal
      return this.tabState(id)
    } catch (cause) {
      try {
        cdp.detach()
        view.destroy()
      } catch { /* teardown never throws */ }
      this.releaseTabDisposers(id)
      this.tabs.delete(id)
      this.pool.removeTab(id)
      throw cause
    }
  }

  releaseReservation(reservation?: TabReservation): void {
    this.pool.releaseReservation(reservation)
  }

  // ---------------------------------------------------------------- window

  private contentBounds(): { x: number; y: number; width: number; height: number } {
    // 2026-09-15 审计 P2-4：这是全文件唯一一处不判 isDestroyed() 就读窗口的地方。
    // closed 回调把它置空前存在"已销毁但 this.window 非 null"的窗口期，此时
    // getContentSize() 会抛 `Object has been destroyed`；await 之后走这条路的
    // prewarm/materialize 尾部会把异常变成未处理拒绝 ⇒ 桌面 fail-loud 直接退出。
    const win = this.window
    const size = win === null || win.isDestroyed() ? { width: 0, height: 0 } : win.getContentSize()
    return {
      x: 0,
      y: BROWSER_SHELL_TOOLBAR_HEIGHT,
      width: Math.max(0, size.width),
      height: Math.max(0, size.height - BROWSER_SHELL_TOOLBAR_HEIGHT),
    }
  }

  /** Re-layout tabs (active one visible) + place the AI overlay on top. */
  private relayout(): void {
    const bounds = this.contentBounds()
    const active = this.pool.activeTab
    for (const tab of this.tabs.values()) {
      tab.view.setBounds(bounds)
      tab.view.setVisible(tab.id === active)
    }
    // 2026-09-17（用户报告 + 独立审计 M1）：**不在这里重排活动标签视图**。
    // 原生层序只有两条不变式：①新 attach 的视图在最上（attach 本身如此）；
    // ②蒙版永远在最上（下面的 applyOverlay 负责，且已在最上时不重复重排）。
    // 标签之间不需要重排：同一时刻只有一个标签 setVisible(true)，而隐藏视图
    // 不参与合成、也不改变层序（像素级验证见 temp/audit-0917-window-focus/AUDIT.md §3）。
    // 每次 remove+add 都是一次 addChildView，而 addChildView 在 Windows 上可能
    // 激活顶层窗口（electron#42339）：旧代码让**每一次** relayout（切/关标签、
    // resize、恢复账本、最小化引发的 resize）都重排两次原生子视图，这正是
    // "用户切走/最小化之后窗口又弹回来"的第二条路径。
    // 任何将来新增的"改变子视图顺序"的入口，都必须调用 applyOverlay()。
    this.applyOverlay()
  }

  /** Effective overlay mode: the interception mask is the DEFAULT state —
   * the whole window is locked (idle OR busy) until the user explicitly clicks
   * 我来操作. Releasing control (交给 AI) re-arms the mask immediately, and it
   * stays armed even while the AI is idle (2026-09-07 product decision). */
  private effectiveOverlayMode(): OverlayMode | 'mask' {
    if (this.pool.controlled) return this.overlayMode
    return 'mask'
  }

  /** Overlay view bounds per mode. The view is always attached (z-top); its
   * rectangle defines what it owns/intercepts — outside it the page receives
   * input. */
  private overlayBounds(mode: OverlayMode | 'mask'): { x: number; y: number; width: number; height: number } {
    const size = this.window?.getContentSize() ?? { width: 0, height: 0 }
    const w = Math.max(0, size.width)
    const h = Math.max(0, size.height)
    switch (mode) {
      case 'mask':
        // Full window: the ONLY interaction is the 我来操作 pill — the
        // toolbar, tabs and the page are all locked behind it.
        return { x: 0, y: 0, width: w, height: h }
      case 'viewer':
        return { x: 0, y: BROWSER_SHELL_TOOLBAR_HEIGHT, width: w, height: Math.max(0, h - BROWSER_SHELL_TOOLBAR_HEIGHT) }
      case 'panel':
        return { x: Math.max(0, w - 340), y: 0, width: 340, height: h }
      case 'menu':
        // 6 items + separator: keep the rect short so the empty lower area
        // does not dead-block page clicks below the menu.
        return { x: Math.max(0, w - 240), y: BROWSER_SHELL_TOOLBAR_HEIGHT, width: 224, height: 244 }
      case 'capsule':
      default:
        // Compact capsule: right-aligned inside its own view, 16px from the
        // window edges; kept narrow so it blocks as little page as possible.
        return { x: Math.max(0, w - 188), y: Math.max(0, h - 50), width: 172, height: 34 }
    }
  }

  /**
   * True only while the window is genuinely in front of the user: visible, not
   * minimized, and holding OS focus.
   *
   * 2026-09-17（用户报告「浏览器老是弹出来，切到别的窗口一会儿它又弹出来，
   * 最小化会自动弹出」）：给一个 WebContents 抢焦点会激活它的顶层窗口 ——
   * Windows 上还会把**最小化**的窗口恢复回来。所以"上锁时夺键盘"（P2-7）这类
   * 动作必须只在用户真的在看这个窗口时做，三个判据任一不成立就跳过：
   *   - hidden（用户点 X → hide）：抢焦点会把它重新拉出来；
   *   - minimized：Windows 会把窗口从最小化恢复（并且 resize → relayout 会
   *     反复重试，形成"你最小化、它弹回来"的拉锯）；
   *   - 已经没有焦点（用户在别的应用里）：抢焦点等于把窗口拽到前台。
   *
   * 可选成员缺席（测试替身、非 Electron 适配器）按"未知即允许"处理：那是不抢
   * 焦点的宿主，保持既有语义比保守拒绝更安全。
   */
  private windowAttended(win: NativeBrowserWindow): boolean {
    try {
      if (win.isDestroyed() || !win.isVisible()) return false
      if (win.isMinimized?.() === true) return false
      if (win.isFocused?.() === false) return false
      return true
    } catch {
      // A window destroyed mid-check is by definition not attended.
      return false
    }
  }

  private applyOverlay(): void {
    if (this.overlay === null) return
    const win = this.window
    if (win === null || win.isDestroyed()) return
    const mode = this.effectiveOverlayMode()
    this.overlay.setBounds(this.overlayBounds(mode))
    this.overlay.moveToTop(win)
    // 2026-09-15 审计 P2-7：mask 是"整窗锁定"状态，必须同时拿键盘焦点 ——
    // 只挡鼠标时，用户先前点过的页面输入框仍会收到键盘输入。
    // 2026-09-17：夺焦点只在窗口真的在前台时进行（见 windowAttended）；用户把
    // 窗口带回前台时由 onFocus 补做这一次上锁，因此 P2-7 不会因为这道闸而退化。
    if (mode === 'mask' && this.windowAttended(win)) this.overlay.focus?.()
  }

  /** User-driven overlay mode switch (panel/menu/viewer/capsule). The mode is
   * recorded and takes effect once the AI stops driving (or immediately when
   * the user controls the window). */
  setOverlayMode(mode: OverlayMode): void {
    if (mode !== 'capsule' && mode !== 'panel' && mode !== 'menu' && mode !== 'viewer') return
    this.overlayMode = mode
    this.applyOverlay()
    this.emitAll('state')
    // Leaving a floating surface (menu/viewer) hands the keyboard back to the
    // shell toolbar so Ctrl+L/T/W/R keep working after overlay interactions.
    // 2026-09-17：同样只在这个窗口真的在前台时做（否则等于把窗口拽回前台）。
    if (mode === 'capsule' && this.window !== null && this.windowAttended(this.window)) {
      this.window.focusPage()
    }
  }

  /**
   * Mount the mask overlay (create + attach + load the overlay page + re-apply
   * bounds/z-order).
   *
   * Keep this the ONLY place that builds the mask view. The view is created
   * with **no partition** on purpose (2026-09-21, §7b option A): it must land in
   * the DEFAULT session, the jar that already holds the application's
   * `dsh-auth-*` proof cookie (the shell window's page and the main window live
   * there too). Its write operations therefore pass `requireWriteProof` with no
   * cross-jar cookie copy — and, more importantly, the model-drivable tab
   * partition (`{@link partition}`) never receives that credential.
   *
   * The session is fixed at creation, and since the mask no longer depends on
   * the tab partition there is nothing to rebuild on a user switch.
   */
  private mountOverlay(win: NativeBrowserWindow, origin: string | undefined): void {
    const overlay = this.adapter.createMaskView()
    this.overlay = overlay
    overlay.attach(win, this.overlayBounds('capsule'))
    if (origin !== undefined) {
      void overlay.webContents.loadURL(`${origin}/browser-overlay`).catch((cause: unknown) => {
        void overlay.webContents.loadURL(`${origin}/browser-overlay`).catch(() => {
          console.error('[dsh-browser] overlay page failed to load', cause)
        })
      })
    }
    this.applyOverlay()
  }

  /**
   * Create (or return) the browser window. `show` is opt-in (2026-09-08
   * product decision): agent paths — boot prewarm, ledger restore, AI tab
   * creation — must never pop the window to the front after the user closed
   * it; only user paths (shell 浏览器 button, user-created tab) show it.
   */
  async ensureWindow(origin?: string, show = false): Promise<NativeBrowserWindow> {
    this.materializePendingTabs()
    if (this.window !== null && !this.window.isDestroyed()) {
      if (show) this.window.show()
      return this.window
    }
    const win = this.adapter.createBrowserWindow()
    if (show) win.show()
    this.window = win
    this.mountOverlay(win, origin)
    if (origin !== undefined) {
      void win.loadURL(`${origin}/browser-shell`).catch((cause: unknown) => {
        void win.loadURL(`${origin}/browser-shell`).catch(() => {
          console.error('[dsh-browser] shell page failed to load', cause)
        })
      })
    }
    this.windowResizeDisposer = win.onResize(() => { this.relayout() })
    // 用户把窗口带回前台时补做键盘上锁：窗口在后台/最小化期间 windowAttended
    // 为假（那时夺焦点会把窗口拽回来），若不在这一刻补上，蒙版上锁就永久失效
    // —— 页面输入框会重新拿到键盘（P2-7 的原始缺陷）。
    this.windowFocusDisposer = win.onFocus?.(() => { this.applyOverlay() }) ?? null
    this.windowClosedDisposer = win.onClosed(() => {
      for (const tab of this.tabs.values()) {
        try {
          // Release the per-tab guards first: a real window close destroys
          // the views, so the ref-counted download guard must drop its refs
          // (P2-28) instead of leaking the session listener.
          this.releaseTabDisposers(tab.id)
          tab.cdp.detach()
          tab.view.destroy()
        } catch {
          // Teardown must never throw.
        }
      }
      this.tabs.clear()
      this.pool.clear()
      this.overlay = null
      this.windowResizeDisposer?.()
      this.windowClosedDisposer?.()
      this.windowFocusDisposer?.()
      this.windowResizeDisposer = null
      this.windowClosedDisposer = null
      this.windowFocusDisposer = null
      this.window = null
    })
    return win
  }

  async showWindow(): Promise<void> {
    if (this.window === null || this.window.isDestroyed()) {
      await this.ensureWindow(this.shellOrigin, true)
      this.relayout()
      return
    }
    this.materializePendingTabs()
    this.window.show()
    this.relayout()
  }

  /**
   * Re-serve the two chrome pages after the application language changed.
   *
   * The shell and overlay pages are rendered PER REQUEST, so a window that was
   * created (or prewarmed) earlier keeps the language it was loaded with —
   * switching the language in Settings left the whole chrome stale until the
   * window was destroyed and reopened (2026-09-16 R9 audit).
   *
   * Only the chrome is reloaded: tab contents are separate views attached to the
   * window and the user's browsing session must survive. A page that is not
   * mounted (no window / no overlay) is skipped.
   *
   * The whole body is fenced: `loadURL` on a WebContents that Electron destroyed
   * between the null check and the call throws SYNCHRONOUSLY, and this runs from
   * a `ctx.emit` listener (an uncaught throw would skip every later listener of
   * the same event) — 2026-09-16 R2 audit.
   */
  reloadChromePages(): void {
    try {
      const origin = this.shellOrigin
      if (origin === undefined) return
      const win = this.window
      if (win !== null && !win.isDestroyed()) {
        void win.loadURL(`${origin}/browser-shell`).catch(() => {
          console.error('[dsh-browser] shell page reload after a language change failed')
        })
      }
      const overlay = this.overlay
      if (overlay !== null) {
        void overlay.webContents.loadURL(`${origin}/browser-overlay`).catch(() => {
          console.error('[dsh-browser] overlay page reload after a language change failed')
        })
      }
    } catch (cause) {
      // A window that vanished mid-switch (or a torn-down overlay) is not a
      // failure the user needs to see: the next window creation renders in the
      // current language anyway.
      console.error('[dsh-browser] chrome reload after a language change failed', cause)
    }
  }

  /**
   * Boot / session-switch prewarm (2026-09-08 product decision): bring the
   * browser up HIDDEN — window, restored ledger tabs and their CDP sessions —
   * so the agent can drive it before the user ever opens it, and so a user
   * close (which only hides the window) leaves a fully working background
   * browser. Never shows the window.
   */
  async prewarm(): Promise<void> {
    if (this.disposed) return
    await this.ensureWindow(this.shellOrigin, false)
    this.materializePendingTabs()
    this.relayout()
  }

  hideWindow(): void {
    if (this.window === null || this.window.isDestroyed()) return
    this.window.hide()
  }

  // ------------------------------------------------------------------- state

  /**
   * Append one op-log entry.
   *
   * `summaryLimit` (F-2, 2026-09-13 round 2): several callers cap the summary
   * themselves (a URL, a fallback reason, a page value). Doing that cut at the
   * call site put it BEFORE the value-level redaction below, so an injected
   * credential straddling the cut could survive as a head fragment — and the
   * R7 tail heuristic that used to paper over it also rewrote untruncated prose.
   * Callers now pass the full text plus the cap they want; the cap is applied
   * here, after `maskBrowserSummary` and after the tab's value set.
   */
  private record(tool: string, tab: number, summary: string, failed = false, actor: RecordActor = 'ai', summaryLimit?: number): void {
    const tabEntry = this.tabs.get(tab)
    // Key-level first (credential-shaped names), then the tab's value set:
    // a summary embeds the page URL verbatim (`navigate: …`), and that URL
    // can carry an injected value under a page-chosen name (R-5). The op log
    // is model-facing through the /ops route and the shell's activity panel.
    // Redact first, cut second (F-2): the other order leaks a head fragment.
    const masked = maskBrowserSummary(summary)
    const redacted = tabEntry === undefined
      ? masked
      : redactFilledSecretsText(tabEntry, masked, { verbatim: true })
    this.ops.push({
      seq: ++this.opSeq,
      time: Date.now(),
      tool,
      tab,
      group: '',
      session: tabEntry?.ownerSession ?? '',
      actor,
      summary: summaryLimit === undefined ? redacted : redacted.slice(0, summaryLimit),
      failed,
    })
    if (this.ops.length > OP_LOG_LIMIT) this.ops.shift()
    this.emitAll('ops')
  }

  private tab(id: number): BrowserTab {
    const tab = this.tabs.get(id)
    if (tab === undefined) {
      // A ledger-restored tab whose view was not materialized yet (lazy
      // restore): kick materialization and ask the caller to retry.
      if (this.pool.has(id)) {
        this.materializePendingTabs()
        throw browserError('not-found', `browser: tab ${id} is being restored — retry the operation`)
      }
      throw browserError('not-found', `browser: unknown tab ${id}`)
    }
    return tab
  }

  /** Resolve a tab id: explicit (must exist) or the pool's active tab. */
  /**
   * 把池子里的浏览器标签镜像进 surface 注册表（§16.1）。
   *
   * 调用时机 = 每次工具面寻址之前（`resolveTarget`）。理由：池子的增删点有十来处
   * （开/关/恢复/清理/切账号），逐点插桩必然漏；镜像一次是 O(标签数)，代价可忽略，
   * 而且**幂等**——所以"漏插桩"这个 bug 类在结构上不存在。
   */
  syncSurfaces(): void {
    const registry = this.surfaces
    if (registry === undefined) return
    const live = new Map<number, unknown>()
    for (const view of this.pool.list()) {
      live.set(view.id, this.tabs.get(view.id)?.view.webContents)
    }
    for (const surface of registry.browserTabs()) {
      if (!live.has(surface.id)) registry.unregister(surface.id)
    }
    for (const [id, webContents] of live) {
      registry.registerBrowserTab(id, webContents)
    }
  }

  resolveTab(tabId: number | undefined): number {
    if (this.pendingLedgerTabs.length > 0) this.materializePendingTabs()
    if (tabId !== undefined) {
      if (!this.pool.has(tabId)) {
        // §16.1：`browser_list_tabs` 会把应用窗口的 surface id 一起列出来，但它们是
        // **另一种**目标 —— 用 `tab` 寻址应用窗口必须明确拒绝，而不是含混的
        // "unknown tab <id>"（那会让模型以为标签被关掉了，然后去开一张新的浏览器
        // 标签，把操作落在**错的窗口**上）。应用窗口只能显式给 `app_id`。
        const surface = this.surfaces?.get(tabId)
        if (surface?.kind === 'app') {
          throw browserError('policy', `browser: ${surfaceLabel(surface)} is an application window, not a browser tab — address it with app_id (only browser_navigate dispatches to application windows today)`)
        }
        throw browserError('not-found', `browser: unknown tab ${tabId}`)
      }
      return tabId
    }
    const active = this.pool.activeTab
    if (active === undefined) throw browserError('not-found', 'browser: no tab open — call browser_open first')
    return active
  }

  tabState(id: number): BrowserTabState {
    const tab = this.tab(id)
    return this.projectTabState(tab)
  }

  /**
   * 标签页的**原始** http(s) origin —— 授权判定不得以脱敏显示投影为基准
   * （2026-09-17 审计 S02-01）。
   *
   * `tabState()` 是给模型/界面看的投影：URL 先过 `stripSensitiveUrl`，再过
   * `redactFilledSecretsText` 的**逐字**擦除（值集合在标签页生命周期内一直存在，
   * R-5）。擦除范围是整个 URL 串，**主机段也在内**：注入过的口令只要 ≥8 字符且
   * 恰好是站点主机的子串（口令 `glitchtip`、站点 https://glitchtip.corp.example），
   * 投影 URL 就变成 `https://****….example`。`browser_fill_credentials` 的站点闸门
   * 曾拿这个投影算 origin，于是同一 origin 上第一次注入成功、之后每次都被拒，
   * 拒绝文案还把模型指向一个不存在的主机 —— 与 {@link fillCredentials} 临界区内
   * 用原始 `tab.url` 的 TOCTOU 复核（同一个闸门的另一半）口径互相矛盾。
   * @param id - 标签页 id（未知 id 与 `tabState` 同样抛 not-found）。
   * @returns 原始 http(s) origin；非 http(s)/不透明 origin 为 `null`。
   */
  tabOrigin(id: number): string | null {
    return httpOriginOf(this.tab(id).url)
  }

  /**
   * The credential-activity window (R-4, 2026-09-13).
   *
   * A tab enters the window when `browser_fill_credentials` injects a stored
   * credential into it, and leaves it on the next MAIN-FRAME CROSS-DOCUMENT
   * navigation (`Page.frameNavigated` with no `parentId`, mirrored by
   * Electron's `did-navigate`). Same-document navigations (`pushState`, `#hash`,
   * `did-navigate-in-page`) do NOT end it: the same document, and the credential
   * inside it, is still up.
   *
   * Leaving the window does NOT drop {@link BrowserTab.filledSecrets} any more
   * (R-5, 2026-09-13): the injected value can outlive the document (a script
   * copies it into `sessionStorage`/DOM/cookies before navigating), so the value
   * set is held for the tab's lifetime and keeps driving every text funnel. The
   * window, not the value list, is the eval/screenshot contract: inside it those
   * two channels are refused (see those methods), outside it they work again —
   * with value redaction still applied to whatever they return.
   *
   * R7 (2026-09-13): the tab's own flag is only half of the answer — see
   * {@link tabInCredentialWindow} and {@link credentialOrigins}. F-3
   * (2026-09-13 round 2): only the TAB half is tied to the document's lifetime;
   * the origin mirror the flag opens for sibling tabs has a deadline
   * ({@link CREDENTIAL_ORIGIN_WINDOW_TTL_MS}), so an unrelated tab on the same
   * origin cannot be blocked for the rest of the session.
   */
  credentialWindowOpen(tabId: number): boolean {
    const tab = this.tabs.get(tabId)
    return tab !== undefined && this.tabInCredentialWindow(tab)
  }

  /** Close the window (idempotent): called on every main-frame navigation, and
   * by nothing else — the window must never close while its document is up.
   * `filledSecrets` is deliberately left alone (R-5 retention; R7 scopes it to
   * the origin, so a sibling tab keeps the scrubbing too). */
  private exitCredentialWindow(tab: BrowserTab): void {
    tab.credentialWindow = false
    // R7: the origin-scoped mirror follows the tab the credential was injected
    // into. When THAT tab performs the main-frame navigation, the window ends
    // (R-4) — a sibling tab that merely inherited the window must not end it,
    // and this tab leaving an origin it only visited must not either.
    for (const record of this.credentialOrigins.values()) {
      if (record.holder !== tab.id) continue
      record.windowUntil = undefined
      record.holder = undefined
    }
  }

  /** Origin of a URL; `undefined` for opaque origins (`about:blank`, `data:`,
   * `file:` — none of which can carry a login form worth injecting into). */
  private originOf(url: string): string | undefined {
    if (url === '') return undefined
    try {
      const origin = new URL(url).origin
      return origin === '' || origin === 'null' ? undefined : origin
    } catch {
      return undefined
    }
  }

  /** The origin-scoped credential record for a URL, when one exists. */
  private credentialRecordFor(url: string): OriginCredentialRecord | undefined {
    const origin = this.originOf(url)
    return origin === undefined ? undefined : this.credentialOrigins.get(origin)
  }

  /**
   * Is this tab inside the credential-activity window?
   *
   * Two sources, because the leak is origin-scoped: the tab's own flag (it
   * received the injection) and the window of the ORIGIN it is currently
   * showing (a sibling tab that can read the value back out of localStorage /
   * a cookie — the storage R-5's own threat model names). Security-relevant
   * ordering: this is the predicate `eval`/`screenshot` judge inside the
   * critical section.
   *
   * F-3 (2026-09-13 round 2): the tab's own flag has NO deadline — the value is
   * in that document until its main-frame navigation (R-4). The origin mirror
   * HAS one ({@link CREDENTIAL_ORIGIN_WINDOW_TTL_MS}), so an unrelated tab on
   * the same origin is not blocked for the rest of the session.
   */
  private tabInCredentialWindow(tab: BrowserTab): boolean {
    if (tab.credentialWindow) return true
    return this.originWindowOpen(this.credentialRecordFor(tab.url))
  }

  /** Whether an origin record's credential window is currently open (F-3). */
  private originWindowOpen(record: OriginCredentialRecord | undefined): boolean {
    return record?.windowUntil !== undefined && Date.now() < record.windowUntil
  }

  /**
   * Remember an injected credential at its ORIGIN scope (R7, 2026-09-13).
   *
   * `filledSecrets`/`credentialWindow` used to be booked per TAB, but the
   * storage a hostile page uses to survive a navigation (localStorage,
   * sessionStorage, cookies) is ORIGIN-scoped: a second tab on the same origin —
   * the ordinary `browser_open` path, which does not inherit from an opener —
   * read the stashed value back in cleartext (eval) and unmasked (get_text)
   * while the injecting tab was refused and scrubbed. Booking the value set and
   * the window on the origin is what covers the scope of the leak: every live
   * tab on that origin gets the value (every text funnel masks it) and the
   * window (eval/screenshot are refused while the credential is live there).
   *
   * The record also outlives its tab, so a tab opened later on the same origin
   * still inherits the value set (see {@link adoptOriginCredentials}); redaction
   * is fail-closed, so keeping values longer can only mask more. Two bounds keep
   * that retention from being unbounded: the origin WINDOW expires (F-3,
   * {@link CREDENTIAL_ORIGIN_WINDOW_TTL_MS}) and the record MAP is capped (F-4,
   * {@link pruneCredentialOrigins}).
   */
  private rememberOriginCredential(tab: BrowserTab, secret: string): void {
    const origin = this.originOf(tab.url)
    if (origin === undefined) return
    const record = this.credentialOrigins.get(origin) ?? { secrets: [], windowUntil: undefined, holder: undefined, lastUsed: Date.now() }
    // F-3: the origin window is bounded. The immediate read-back is still shut
    // (it opens here, with the injection), and it cannot outlive the TTL.
    record.windowUntil = Date.now() + this.options.credentialWindowTtlMs
    record.holder = tab.id
    record.lastUsed = Date.now()
    if (secret !== '' && !record.secrets.includes(secret)) record.secrets.push(secret)
    this.credentialOrigins.set(origin, record)
    // Fan the value out to the tabs already sitting on that origin: they can
    // read the same storage the injecting tab just wrote to.
    for (const other of this.tabs.values()) {
      if (this.originOf(other.url) !== origin) continue
      if (secret !== '' && !other.filledSecrets.includes(secret)) other.filledSecrets.push(secret)
    }
    this.pruneCredentialOrigins()
  }

  /**
   * Bound the retained origin records (F-4, 2026-09-13 round 2).
   *
   * Within {@link MAX_CREDENTIAL_ORIGIN_RECORDS} nothing is dropped: round-1's
   * fail-closed retention — a later tab on an origin whose tab is gone still
   * inherits the value set — is kept on purpose. Past the cap the
   * least-recently-used record whose origin has NO live tab is evicted (oldest
   * `lastUsed` first), so the map stops growing with the number of origins a
   * session visits. A live origin is never evicted: that would undo r7c-3.
   */
  private pruneCredentialOrigins(): void {
    if (this.credentialOrigins.size <= MAX_CREDENTIAL_ORIGIN_RECORDS) return
    const live = new Set<string>()
    for (const tab of this.tabs.values()) {
      const origin = this.originOf(tab.url)
      if (origin !== undefined) live.add(origin)
    }
    const evictable = [...this.credentialOrigins.entries()]
      .filter(([origin]) => !live.has(origin))
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed)
    for (const [origin] of evictable) {
      if (this.credentialOrigins.size <= MAX_CREDENTIAL_ORIGIN_RECORDS) break
      this.credentialOrigins.delete(origin)
    }
  }

  /**
   * Model-facing interaction failure (R7, 2026-09-13).
   *
   * The selector an interaction fails on is NOT necessarily model-authored: a
   * snapshot NUMBER is resolved by `tools.resolveTarget` through the RAW page
   * snapshot (the runtime deliberately keeps the truthful selector there so the
   * interaction still finds the element). That raw selector is page-controlled —
   * a page that writes the credential into `el.id` yields `#<credential>` — so
   * the failure text used to hand the injected value back verbatim while the
   * `browser_get_snapshot` copy of the same selector was already masked.
   *
   * R7 closes this at the ONE place the message is built rather than at each
   * caller: every interaction error goes through the tab's value redactor.
   */
  private interactionError(tab: BrowserTab, code: BrowserErrorCode, message: string): BrowserError {
    return browserError(code, redactFilledSecretsText(tab, message, { verbatim: true }))
  }

  /**
   * Adopt the credential accounting of the origin a tab is ENTERING (R7).
   *
   * Called from `updateTabState` with the URL the tab showed before the refresh,
   * so a same-origin navigation is not an entry: a window this tab already left
   * (R-4: the next main-frame navigation closes it) does not reopen — only a tab
   * ARRIVING on an origin whose window is still held open inherits it.
   *
   * F-3 (2026-09-13 round 2): the arriving tab no longer latches its own
   * `credentialWindow` flag. That flag has no deadline (it is cleared only by
   * this tab's own main-frame navigation), so latching it made the origin window
   * permanent for every tab that ever touched the origin. The origin record's
   * deadline is consulted directly by {@link tabInCredentialWindow} instead.
   */
  private adoptOriginCredentials(tab: BrowserTab, previousUrl: string): void {
    const origin = this.originOf(tab.url)
    if (origin === undefined || this.originOf(previousUrl) === origin) return
    const record = this.credentialOrigins.get(origin)
    if (record === undefined) return
    for (const secret of record.secrets) {
      if (!tab.filledSecrets.includes(secret)) tab.filledSecrets.push(secret)
    }
    // F-4: arriving here counts as a use, so the LRU keeps the origins that are
    // actually being visited.
    record.lastUsed = Date.now()
  }

  /**
   * Model/UI-facing projection of a tab (R-1, 2026-09-13).
   *
   * A tab's live `url`/`title`/`favicon` are raw by design (navigation needs
   * them), but EVERY payload that leaves the runtime is built here: the
   * `browser_list_tabs` / `browser_open` / `browser_navigate` /
   * `browser_get_snapshot` envelopes, the shell's `/api/pico/browser/state`
   * and its SSE `state` event. Before this the redaction was applied per call
   * site and `browser_get_snapshot` shipped `state.url` in cleartext while the
   * element text beside it read `****` (independent re-verification
   * 2026-09-13). One projection, so a new accessor cannot miss it.
   *
   * Cost, stated on purpose: the shell address bar shows the masked URL for a
   * credential-bearing address. Restoring a cleartext address bar needs a
   * deliberately separate (un-redacted) shell-only channel — the unsafe
   * default is not kept for convenience.
   *
   * R-5 (2026-09-13) adds the value-level pass on top of the key-level one, for
   * all three fields. Key-level rules only see credential-*shaped* names, so a
   * page that picks its own name (`history.replaceState('?pw=' + value)`, a
   * bare `location.hash = value`) or none at all (`<a download=value + '.txt'>`)
   * published the injected value as an ordinary URL, title or file name.
   */
  private projectTabState(tab: BrowserTab): BrowserTabState {
    return {
      id: tab.id,
      url: redactFilledSecretsText(tab, stripSensitiveUrl(tab.url), { verbatim: true }),
      title: redactFilledSecretsText(tab, stripSensitiveText(tab.title)),
      loading: tab.loading,
      visible: tab.id === this.pool.activeTab,
      favicon: redactFilledSecretsText(tab, stripSensitiveUrl(tab.favicon), { verbatim: true }),
      canGoBack: tab.canGoBack,
      canGoForward: tab.canGoForward,
    }
  }

  private updateTabState(tab: BrowserTab): void {
    const wc = tab.view.webContents
    if (wc.isDestroyed()) return
    const previousUrl = tab.url
    tab.url = wc.getURL()
    // R7: entering an origin that holds credential accounting adopts it (value
    // set + window). Placed before the pool/UI fan-out so the very first
    // projection of the new document is already scoped.
    this.adoptOriginCredentials(tab, previousUrl)
    // FIX-06 (2026-09-12): the page title frequently *is* a URL (no `<title>`,
    // a guard-rejected navigation, an Electron title fallback) and it feeds the
    // persisted history, the native window caption and the model-facing
    // state — while `tab.url` next to it was already redacted. Same text-level
    // redactor as the store, applied once at the source.
    tab.title = stripSensitiveText(wc.getTitle() || tab.url || '')
    tab.loading = wc.isLoading()
    try {
      tab.canGoBack = wc.canGoBack()
      tab.canGoForward = wc.canGoForward()
    } catch {
      // history introspection is best-effort
    }
    this.pool.updateTabMeta(tab.id, tab.url, tab.title)
    this.emitAll('tab-meta')
    this.refreshWindowTitle(tab)
  }

  /** Follow the active tab's page title in the native window caption.
   *
   * R-5: the caption is built from the raw `tab.title`, which a page can set to
   * anything (`document.title = pw.value`) — it would then sit in the OS window
   * list, screen shares and screenshots of the app. Same value-level redactor as
   * the model-facing projection. */
  private refreshWindowTitle(tab: BrowserTab): void {
    if (this.window === null || this.window.isDestroyed()) return
    if (tab.id !== this.pool.activeTab) return
    const fallback = browserDefaultTitle(this.locale())
    const shown = redactFilledSecretsText(tab, tab.title)
    const title = shown !== '' ? shown : fallback
    this.window.setTitle(title === fallback ? title : `${title} — ${fallback}`)
  }

  private releaseTabDisposers(id: number): void {
    const tab = this.tabs.get(id)
    if (tab === undefined) return
    for (const dispose of tab.disposers) {
      try { dispose() } catch { /* 守卫释放失败不阻断关闭 */ }
    }
    tab.disposers.length = 0
  }

  /** Run one agent operation under the global serial mutex (user gate aware). */
  private async agentRun<T>(tool: string, body: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return await this.withAgentAttribution(tool, body, signal)
  }

  /**
   * Serial-mutex runner that keeps per-call agent attribution correct (P3):
   * `noteAgent` runs before the call, but a queued operation only acquires
   * the mutex later — by then another tool may have overwritten the global
   * `lastAgentId`. Snapshot the id at call time and restore it inside the
   * critical section so ops/tabs are attributed to the agent that issued them.
   */
/**
   * Run one store/window mutation under the SAME global user gate as page
   * operations. Tools that only touch bookmarks/downloads/session storage used
   * to bypass the mutex, so the model could still delete data while the user
   * was operating the page.
   * @param tool - tool name for busy attribution/logging.
   * @param work - mutation body.
   * @param signal - caller cancellation signal.
   */
  async runGated<T>(tool: string, work: () => Promise<T> | T, signal?: AbortSignal): Promise<T> {
    return await this.agentRun(tool, async () => await work(), signal)
  }

  private async withAgentAttribution<T>(tool: string, body: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const callerAgent = this.lastAgentId
    try {
      return await this.pool.withOperation(tool, async () => {
        const previous = this.lastAgentId
        this.lastAgentId = callerAgent
        try {
          return await body()
        } finally {
          this.lastAgentId = previous
        }
      }, signal)
    } catch (cause) {
      // "用户拿着控制权"是一个**状态**，不是一次普通失败：记下来让 shell / 客户端
      // 能提示用户去点「交给 AI」（2026-09-16 会话 88502514 的现场，AI 被静默挡住
      // 25 分钟而界面上没有任何提示）。
      if (cause instanceof BrowserError && cause.code === 'window-controlled') this.noteControlBlock(tool)
      throw cause
    }
  }

  /**
   * Remember that an agent browser action was refused because the USER holds
   * control (我来操作), and surface it once.
   *
   * 一次控制权周期只记一条 op（`gateBlock !== null` 时直接返回）：模型可能连续
   * 重试十几次，活动面板不该被同一条原因刷屏；真正的证据是"第一次被挡住"。
   * 状态在控制权交还（setUserControl(false)）或池子被清空时清掉。
   */
  private noteControlBlock(tool: string): void {
    if (this.gateBlock !== null) return
    this.gateBlock = { at: Date.now(), tool }
    this.record(tool, 0, hostCopy(
      this.locale(),
      '用户正在操作浏览器（我来操作），AI 操作被挡住 —— 点「交给 AI」后继续',
      'The user is operating the browser (take-over); the AI is blocked — click "Hand back to AI" to continue',
    ), true)
    this.emitAll('state')
  }

  // navigation family --------------------------------------------------------

  async navigate(tabId: number, url: string, waitUntil: BrowserWaitUntil = 'domcontentloaded', signal?: AbortSignal, user = false): Promise<void> {
    const body = async (): Promise<void> => {
      await this.navigateInternal(tabId, url, waitUntil, user ? 'user' : 'ai')
    }
    if (user) return await body()
    return await this.agentRun('browser_navigate', body, signal)
  }

  /** User path: navigate the pool's active tab (open one first if none). */
  async navigateUser(url: string): Promise<void> {
    const tab = this.pool.activeTab
    if (tab === undefined) {
      await this.open(url, undefined, true)
      return
    }
    await this.navigate(tab, url, 'domcontentloaded', undefined, true)
  }

  private async navigateInternal(id: number, url: string, waitUntil: BrowserWaitUntil, actor: RecordActor): Promise<void> {
    if (!this.navigationAllowed(url)) {
      // R-1: the refusal text is model-facing (tool error) — echo the
      // *redacted* URL, exactly like history/op-log do.
      throw browserError('navigation-blocked', `browser: navigation denied — ${stripSensitiveUrl(url).slice(0, 200)}`)
    }
    const tab = this.tab(id)
    const wc = tab.view.webContents
    const started = Date.now()
    if (actor !== 'user') this.assertAgentStillAllowed('browser_navigate')
    let loadError: unknown
    const outcome = await Promise.race([
      wc.loadURL(url).then(
        () => 'loaded' as const,
        (cause: unknown) => { loadError = cause; return 'failed' as const },
      ),
      sleep(this.options.loadTimeoutMs).then(() => 'pending' as const),
    ])
    // A user takeover while loadURL was pending wins over the load result:
    // the operation is reported as interrupted, not as a successful navigation
    // to whatever page happens to be left in the view. (The user's own
    // address-bar navigation is exempt from the gate.)
    if (actor !== 'user') this.assertAgentStillAllowed('browser_navigate')
    if (outcome === 'failed') {
      const detail = loadError instanceof Error ? loadError.message : String(loadError ?? 'unknown error')
      throw browserError('network', `browser: navigation failed — ${stripSensitiveUrl(detail).slice(0, 200)}`)
    }
    if (waitUntil !== 'domcontentloaded') {
      // 'load' settles on did-finish-load (or immediately when already done);
      // 'networkidle' waits a quiet window (800ms) after the last load event.
      const budget = Math.max(0, this.options.timeoutMs - (Date.now() - started))
      await this.waitForLoad(wc, waitUntil)(Math.min(budget, Math.max(0, this.options.loadTimeoutMs)))
    }
    this.updateTabState(tab)
    this.record('browser_navigate', id, `navigate: ${url}`, false, actor, NAVIGATE_SUMMARY_LIMIT)
    // R-5 (2026-09-13): the persisted history is a model-facing exit
    // (`browser_history_search`, the shell's history panel, `<dir>/history.jsonl`),
    // so it gets BOTH layers: the store's key-level rule and this tab's value set
    // (a page-chosen parameter name or a path segment carries the value past the
    // key vocabulary). Redacted at the write path so every reader agrees.
    this.store.addHistory({
      time: Date.now(),
      url: redactFilledSecretsText(tab, url, { verbatim: true }),
      title: redactFilledSecretsText(tab, tab.title),
      actor,
      group: '',
    } as Omit<HistoryEntry, 'seq'>)
  }

  /** Cooperative wait for the page load milestone; never rejects on timeout.
   *
   * The parameter is the minimal structural face (on/removeListener/isLoading)
   * rather than `NativeView['webContents']`: **application surfaces** carry a
   * `webContents` the registry holds as an opaque handle (§16.1), and this is
   * the only loader-side helper they share with browser tabs. */
  private waitForLoad(wc: LoadWaitTarget, waitUntil: BrowserWaitUntil): (budgetMs: number) => Promise<void> {
    return async (budgetMs: number) => {
      const deadline = Date.now() + Math.max(0, budgetMs)
      // Absent `isLoading` (a surface handle that only exposes loadURL) means
      // "unknown": treat it as still loading so the bounded timer settles the
      // wait instead of settling on a guess.
      const loading = (): boolean => wc.isLoading?.() ?? true
      await new Promise<void>((resolve) => {
        let settled = false
        let idleTimer: ReturnType<typeof setTimeout> | undefined
        const settle = (): void => {
          if (settled) return
          settled = true
          cleanup()
          resolve()
        }
        const scheduleIdle = (): void => {
          if (idleTimer !== undefined) return
          idleTimer = setTimeout(settle, NETWORK_IDLE_TICK_MS)
          idleTimer.unref?.()
        }
        const cleanup = (): void => {
          wc.removeListener?.('dom-ready', onDomReady)
          wc.removeListener?.('did-finish-load', onFinish)
          clearTimeout(timer)
          if (idleTimer !== undefined) clearTimeout(idleTimer)
        }
        const onDomReady = (): void => {
          if (waitUntil === 'domcontentloaded') settle()
        }
        const onFinish = (): void => {
          if (waitUntil === 'load') settle()
          if (waitUntil === 'networkidle') scheduleIdle()
        }
        wc.on?.('dom-ready', onDomReady)
        wc.on?.('did-finish-load', onFinish)
        const timer = setTimeout(settle, Math.max(0, deadline - Date.now()))
        timer.unref?.()
        if (waitUntil !== 'domcontentloaded' && !loading()) {
          if (waitUntil === 'networkidle') scheduleIdle()
          else settle()
        }
        if (waitUntil === 'domcontentloaded' && loading() === false) settle()
      })
    }
  }

  /**
   * 导航**应用窗口自己的** webContents（§16.1：`app_id` 显式寻址的唯一落点）。
   *
   * 为什么必须有这条路径（2026-09-21，P1）：应用窗口 surface 注册之后，
   * `browser_navigate{app_id, url}` 曾在校验完 surface 后**回落到浏览器标签** —— 模型
   * 以为自己在驱动应用窗口，实际把用户的浏览器当前标签导航走了（http(s) URL），或者
   * 被浏览器闸门拒绝（应用 scheme URL）。两种都是错的落点，且对用户是真实伤害
   * （劫持他正在看的页面）。
   *
   * 三条冻结语义：
   *  1. 只落在这个 surface 自己的 `webContents` 上 —— 没有可驱动句柄就**明确报错**，
   *     绝不回落到浏览器标签（"没有目标"比"错的目标"安全）；
   *  2. 只允许该应用自己的 origin（`<scheme>://<app_id>/…`）：应用窗口导航到外站是
   *     宿主原生闸门（`will-navigate`/`will-redirect` 共用的 verdict）也会拒的动作，
   *     这里在**碰 webContents 之前**就变成结构化错误，模型能看到原因；
   *  3. 用户按住这个窗口时（逐 surface 用户闸，§16.1 第 3 条）拒绝，文案与浏览器窗口
   *     上的「我来操作」逐字相同（{@link gateRefusal}）。
   * @param surface - 目标应用 surface（工具面用 `app_id` 解析得到）。
   * @param url - 目标 URL。
   * @param waitUntil - 加载里程碑（缺省 domcontentloaded）。
   * @param signal - 调用方取消信号。
   * @returns 该窗口的状态投影（url/title/loading）。
   */
  async navigateAppSurface(
    surface: BrowserSurface,
    url: string,
    waitUntil: BrowserWaitUntil = 'domcontentloaded',
    signal?: AbortSignal,
  ): Promise<{ url: string, title: string, loading: boolean }> {
    if (surface.kind !== 'app') {
      throw browserError('policy', `browser: application-surface navigation requires a kind:'app' surface (got ${surface.kind}) — refusing to guess a target`)
    }
    const label = surfaceLabel(surface)
    const wc = asSurfaceWebContents(surface.webContents)
    if (wc === undefined) {
      throw browserError('not-found', `browser: ${label} has no drivable webContents yet — reopen the application window and retry (refusing to act on a browser tab instead)`)
    }
    if (!appSurfaceAllowsUrl(surface, url)) {
      throw browserError('navigation-blocked', `browser: ${label} only navigates inside its own origin (${surface.appScheme ?? '?'}://${surface.appId ?? '?'}) — ${stripSensitiveUrl(url).slice(0, 200)} is a different origin; use a browser tab for http(s) pages`)
    }
    if (this.isForbiddenLocalTarget(url)) {
      throw browserError('navigation-blocked', `browser: navigation denied — ${stripSensitiveUrl(url).slice(0, 200)}`)
    }
    return await this.agentRun('browser_navigate', async () => {
      this.assertSurfaceAgentStillAllowed(surface, 'browser_navigate')
      const started = Date.now()
      let loadError: unknown
      const outcome = await Promise.race([
        wc.loadURL(url).then(
          () => 'loaded' as const,
          (cause: unknown) => { loadError = cause; return 'failed' as const },
        ),
        sleep(this.options.loadTimeoutMs).then(() => 'pending' as const),
      ])
      // 接管压过加载结果（与浏览器标签同一条判据）。
      this.assertSurfaceAgentStillAllowed(surface, 'browser_navigate')
      if (outcome === 'failed') {
        const detail = loadError instanceof Error ? loadError.message : String(loadError ?? 'unknown error')
        throw browserError('network', `browser: navigation failed — ${stripSensitiveUrl(detail).slice(0, 200)}`)
      }
      if (waitUntil !== 'domcontentloaded') {
        const budget = Math.max(0, this.options.timeoutMs - (Date.now() - started))
        await this.waitForLoad(wc, waitUntil)(Math.min(budget, Math.max(0, this.options.loadTimeoutMs)))
      }
      // op log 用 tab 0（与 browser_takeover 同口径）：应用窗口不是浏览器标签，
      // 塞一个 surface id 进 tab 字段会让"按标签看时间线"的界面指向不存在的标签。
      this.record('browser_navigate', 0, `${label} navigate: ${stripSensitiveUrl(url)}`, false, 'ai', NAVIGATE_SUMMARY_LIMIT)
      return this.appSurfaceState(wc, url)
    }, signal)
  }

  /** 应用窗口的状态投影（webContents 的读取全部当可选：宿主可能只交了 id）。 */
  private appSurfaceState(wc: SurfaceWebContents, fallbackUrl: string): { url: string, title: string, loading: boolean } {
    let current = fallbackUrl
    let title = ''
    let loading = false
    try { current = wc.getURL?.() ?? fallbackUrl } catch { current = fallbackUrl }
    try { title = wc.getTitle?.() ?? '' } catch { title = '' }
    try { loading = wc.isLoading?.() ?? false } catch { loading = false }
    return {
      url: stripSensitiveUrl(current),
      title: stripSensitiveText(title),
      loading,
    }
  }

  /**
   * 逐 surface 的接管检查点（§16.1 第 3 条）：用户按住**这个应用窗口**时 AI 不得
   * 操作它。错误码与文案与池级闸门完全一致（{@link gateRefusal}）—— 模型只需要学
   * 会一条"用户拿着控制权"的指令，而不是两条。
   */
  private assertSurfaceAgentStillAllowed(surface: BrowserSurface, operation: string): void {
    if (this.surfaces?.surfaceControl(surface.id) !== 'user') return
    this.record(operation, 0, `refused: ${surfaceLabel(surface)} is user-controlled`, true)
    throw browserError('window-controlled', gateRefusal(this.locale()))
  }

  async reload(tabId: number, signal?: AbortSignal, user = false): Promise<void> {
    const body = async (): Promise<void> => {
      const tab = this.tab(tabId)
      const wc = tab.view.webContents
      if (wc.isDestroyed()) return
      wc.reload()
      await this.waitForLoad(wc, 'domcontentloaded')(this.options.timeoutMs)
      // BUG-05：用户在一次已在跑的 reload 期间点「我来操作」时，旧实现照样把
      // 结果记成成功；接管必须让长操作中止（与 navigate/eval/wait_for 同口径）。
      if (!user) this.assertAgentStillAllowed('browser_reload')
      this.updateTabState(tab)
      this.record('browser_reload', tabId, `reload tab ${tabId}`, false, user ? 'user' : 'ai')
    }
    if (user) return await body()
    return await this.agentRun('browser_reload', body, signal)
  }

  async goBack(tabId: number, signal?: AbortSignal, user = false): Promise<void> {
    const body = async (): Promise<void> => {
      const tab = this.tab(tabId)
      const wc = tab.view.webContents
      if (wc.isDestroyed()) return
      wc.goBack()
      await this.waitForLoad(wc, 'domcontentloaded')(this.options.timeoutMs)
      if (!user) this.assertAgentStillAllowed('browser_go_back')
      this.updateTabState(tab)
      this.record('browser_go_back', tabId, `back to ${tab.url}`, false, user ? 'user' : 'ai')
    }
    if (user) return await body()
    return await this.agentRun('browser_go_back', body, signal)
  }

  async goForward(tabId: number, signal?: AbortSignal, user = false): Promise<void> {
    const body = async (): Promise<void> => {
      const tab = this.tab(tabId)
      const wc = tab.view.webContents
      if (wc.isDestroyed()) return
      wc.goForward()
      await this.waitForLoad(wc, 'domcontentloaded')(this.options.timeoutMs)
      if (!user) this.assertAgentStillAllowed('browser_go_forward')
      this.updateTabState(tab)
      this.record('browser_go_forward', tabId, `forward to ${tab.url}`, false, user ? 'user' : 'ai')
    }
    if (user) return await body()
    return await this.agentRun('browser_go_forward', body, signal)
  }

  /** Switch the pool's active tab. */
  async switchTab(tabId: number, user = false, signal?: AbortSignal): Promise<void> {
    const body = async (): Promise<void> => {
      this.materializePendingTabs()
      this.pool.setActiveTab(tabId)
      this.relayout()
      const switched = this.tabs.get(tabId)
      if (switched !== undefined) this.refreshWindowTitle(switched)
      this.record('browser_switch_tab', tabId, `switch to tab ${tabId}`, false, user ? 'user' : 'ai')
    }
    if (user) return await body()
    return await this.agentRun('browser_switch_tab', body, signal)
  }

  async closeTab(tabId: number, user = false, signal?: AbortSignal): Promise<void> {
    const body = async (): Promise<void> => {
      this.destroyTab(tabId)
      this.relayout()
      this.record('browser_close_tab', tabId, `close tab ${tabId}`, false, user ? 'user' : 'ai')
    }
    if (user) return await body()
    return await this.agentRun('browser_close_tab', body, signal)
  }

  private destroyTab(id: number): void {
    const tab = this.tabs.get(id)
    if (tab !== undefined) {
      try {
        tab.cdp.detach()
        tab.view.detach()
        tab.view.destroy()
      } catch { /* teardown never throws */ }
      this.releaseTabDisposers(id)
      this.tabs.delete(id)
    }
    // Drop the registry entry even when no view exists (restored ledger tabs
    // in a failed-materialization state must never become un-closable).
    this.pool.removeTab(id)
    // R7: a destroyed tab cannot hold an origin's credential window any more.
    // F-4 (2026-09-13 round 2): the record itself is KEPT (round-1 fail-closed
    // retention: a later tab on that origin must still be scrubbed), but the
    // map is bounded — evicting is LRU-based and never drops a live origin.
    for (const record of this.credentialOrigins.values()) {
      if (record.holder !== id) continue
      record.windowUntil = undefined
      record.holder = undefined
    }
    this.pruneCredentialOrigins()
  }

  /** Close everything (session switch / shell 清除). */
  async closeAll(user = false): Promise<void> {
    const body = async (): Promise<void> => {
      // Cancel in-flight ledger materialization (a previous user's restore
      // must not resurrect tabs after the pool was cleared).
      this.materializeEpoch++
      this.pendingLedgerTabs = []
      try {
        for (const id of [...this.tabs.keys()]) this.destroyTab(id)
        // R7: closing EVERYTHING ends the session's origin accounting (account
        // switch / shell 清除). Destroying one tab deliberately keeps its origin's
        // value set (a later tab on that origin must still be scrubbed); this is
        // the boundary where the previous account's values must not survive into
        // the next one.
        this.credentialOrigins.clear()
        this.pool.clear()
      } finally {
        // A window that is already destroyed must not abort the identity
        // switch before the pool is empty (cross-account browse leak); the
        // best-effort UI steps below are cosmetic.
        try { this.relayout() } catch { /* window gone */ }
        try { this.record('browser_close', 0, 'close browser (all tabs)', false, user ? 'user' : 'ai') } catch { /* log must not break switch */ }
        try { this.hideWindow() } catch { /* window gone */ }
      }
    }
    if (user) {
      // 2026-09-15 审计 P1-1：这里原本用 `already` 短路 —— 用户正拿着控制权
      // («我来操作») 时来一次会话切换（token 过期 → auth-gate clear、登出、改密
      // 都会发 pico/session-changed），finally 就不会把控制权交还：`controlled`
      // 永久为 true ⇒ 蒙版不再上锁、用户闸对 agent 失效、胶囊反而显示「交给 AI」。
      // 关闭浏览器这个动作本身就要结束"用户持有"状态，所以无条件交还。
      const wasControlled = this.pool.controlled
      if (!wasControlled) this.pool.setUserControl(true)
      try {
        return await body()
      } finally {
        this.pool.setUserControl(false)
      }
    }
    return await this.agentRun('browser_close', body)
  }

  // ----------------------------------------------------------- interactions

  async snapshot(tabId: number, signal?: AbortSignal): Promise<BrowserSnapshotElement[]> {
    // 2026-09-15 审计 P2：命中总数 + 截断/盲区统计必须离开本函数（模型面出口在
    // tools.ts，而 `snapshot()` 的 `BrowserSnapshotElement[]` 返回类型被大量
    // 既有调用点/测试钉死）。所以新增 `snapshotWithMeta()` 承载元数据，
    // `snapshot()` 委托它、返回类型不变（与 `text`/`textWithMeta` 同一形状）。
    return (await this.snapshotWithMeta(tabId, signal)).elements
  }

  /** {@link snapshot} plus the extraction counts/blind-spot metadata (2026-09-15
   * 审计 P2: `browser_get_snapshot` must be able to say "another N elements were
   * not listed; M sub-frames / shadow roots are not included").
   *
   * 值级擦除（P0-A depth layer）留在这条漏斗里：无论文本来自探针还是未来别的
   * 取值来源，`runtime.snapshot` 的每个调用方都被覆盖。R7 的顺序也不动 —— 先
   * 在**整段**元素文本上擦除，再做 80 字符的模型面截断，否则跨界的口令会被切成
   * 任何值规则都认不出的明文残片。 */
  async snapshotWithMeta(tabId: number, signal?: AbortSignal): Promise<{ elements: BrowserSnapshotElement[]; meta: SnapshotExtractionMeta }> {
    const resolved = this.resolveTab(tabId)
    const out = await this.agentRun('browser_get_snapshot', async () => {
      const tab = this.tab(resolved)
      const snapshot = await extractSnapshotWithMeta(
        (m, p) => tab.cdp.send(m, p),
        this.options.snapshotLimit,
        (elementText, textContext) => redactFilledSecretsText(tab, elementText, { tailMayBeTruncated: textContext.truncated }),
      )
      return { elements: redactFilledSecrets(tab, snapshot.elements), meta: snapshot.meta }
    }, signal)
    this.record('browser_get_snapshot', resolved, `snapshot: ${out.elements.length} elements`)
    return out
  }

  async text(tabId: number, selector: string | undefined, signal?: AbortSignal): Promise<string> {
    return (await this.textWithMeta(tabId, selector, signal)).text
  }

  /** {@link text} plus the REAL truncation flag (2026-09-15 审计 P2).
   *
   * 现场：`browser_get_text` 的 `truncated` 由工具用 `text.length >=
   * runtime.options.textLimit` 推算，而实际生效上限是 `min(textLimit, 32KiB)`
   * ——`textLimit=65536` 时工具拿着 65536 去比一条早被 32KiB 截断的文本，标记
   * 完全失真。长度只有这里（投影之后、截断之前）知道，所以判定也必须在这里。 */
  async textWithMeta(tabId: number, selector: string | undefined, signal?: AbortSignal): Promise<{ text: string; truncated: boolean }> {
    const resolved = this.resolveTab(tabId)
    const out = await this.agentRun('browser_get_text', async () => {
      const tab = this.tab(resolved)
      // R-1 (2026-09-13): page text is a model-facing exit too. innerText of a
      // password input is empty, but a page that *echoes* what was typed
      // ("your password abc123 is weak", a confirmation screen, a debug dump)
      // hands the injected credential back verbatim. Same value-level redactor
      // as the snapshot/eval funnels — one implementation, three exits.
      //
      // R7 (2026-09-13): same order as the snapshot funnel — redact, then apply
      // the 32KiB cap. Slicing first turned a credential straddling the cap into
      // a plaintext head fragment.
      return await extractTextWithMeta(
        (m, p) => tab.cdp.send(m, p),
        selector,
        this.options.textLimit,
        (raw) => redactFilledSecretsText(tab, raw),
      )
    }, signal)
    this.record('browser_get_text', resolved, selector === undefined ? `page text: ${out.text.length} chars` : `element text: ${out.text.length} chars`)
    return { text: out.text, truncated: out.truncated }
  }

  async screenshot(tabId: number, signal?: AbortSignal): Promise<string> {
    const resolved = this.resolveTab(tabId)
    // R-4 credential-activity window: checked BEFORE the capture `try`, so the
    // policy refusal below is not rewritten into the generic "screenshot failed"
    // wrapper (which would hide both the code and the reason). This lock-free
    // check is only a cheap early-out — the authoritative one runs INSIDE the
    // critical section below (R7).
    if (this.credentialWindowOpen(resolved)) {
      this.record('browser_screenshot', resolved, 'refused: credential window open', true)
      throw browserError('policy', CREDENTIAL_WINDOW_SCREENSHOT_REFUSAL)
    }
    let data: string
    try {
      data = await this.agentRun('browser_screenshot', async () => {
        const tab = this.tab(resolved)
        // R7 (2026-09-13): the window must be judged in the SAME critical
        // section as the capture, exactly like `eval` does. `agentRun` queues on
        // the global pool mutex, and `browser_fill_credentials` runs on that
        // same mutex — so the lock-free check above can read a pre-queue
        // snapshot (`credentialWindow === false`) while this call waits behind a
        // fill that is already injecting (a 30s `wait_for` budget, a slow
        // navigation or a wedged CDP round-trip is enough to hold the mutex).
        // Without this re-check the screenshot then captures the page with the
        // credential in it, bypassing the refusal the module advertises.
        if (this.tabInCredentialWindow(tab)) {
          this.record('browser_screenshot', resolved, 'refused: credential window open', true)
          throw browserError('policy', CREDENTIAL_WINDOW_SCREENSHOT_REFUSAL)
        }
        // BUG-05：接管检查与凭证窗口同一临界区（队列之后、真正的捕获之前），
        // 用户在这张图排队/渲染期间接管时不该把图交给模型。
        this.assertAgentStillAllowed('browser_screenshot')
        let captured: string
        let primary: string
        try {
          captured = await withScreenshotBudget(
            captureScreenshot(tab.view.webContents, this.options.screenshotMaxWidth, this.options.screenshotQuality),
            this.screenshotPrimaryBudgetMs(),
          )
        } catch (cause) {
          primary = cause instanceof Error ? cause.message : String(cause)
          // 2026-09-12: the browser window is created hidden by design, and a
          // hidden window has no viz surface — `capturePage()` then fails with
          // "Current display surface not available for capture". The renderer-side
          // CDP path composites the frame without a surface, so screenshots keep
          // working for an agent-driven (never shown) window.
          try {
            captured = await withScreenshotBudget(
              captureScreenshotViaCdp(
                (method, params) => tab.cdp.send(method, params),
                this.options.screenshotMaxWidth,
                this.options.screenshotQuality,
              ),
              this.screenshotFallbackBudgetMs(),
            )
            this.record('browser_screenshot', resolved, `capturePage unavailable (${primary}); captured via CDP fromSurface:false`, false, 'ai', SCREENSHOT_FALLBACK_SUMMARY_LIMIT)
          } catch (cause2) {
            const secondary = cause2 instanceof Error ? cause2.message : String(cause2)
            // Both reasons are kept: the primary one is what the P2-31 guard
            // ("empty image (0x0)") and real-device diagnostics key on.
            throw new Error(`${primary}; renderer-side fallback: ${secondary}`)
          }
        }
        // 截图完成后再确认一次接管状态：用户在这张图渲染期间点「我来操作」时，不该
        // 把画面交给模型（与 navigate 的"接管压过加载结果"同口径）。
        // 必须在 agentRun **体内**：`window-controlled` 由 withAgentAttribution 的
        // catch 转成 gateBlock（noteControlBlock），放到 agentRun 之外会让这次拒绝
        // 既不进 op-log 也不亮侧边栏「AI 正在等你交还浏览器控制权」（2026-09-17 审计
        // S01-2/S02-03：同一函数里 reload/go_back/go_forward 的检查点都在体内）。
        this.assertAgentStillAllowed('browser_screenshot')
        return captured
      }, signal)
    } catch (cause) {
      // A policy refusal (the credential window just above, or a future policy
      // decision inside the capture path) is NOT a capture failure: rethrowing
      // it unchanged keeps `code: 'policy'` and its actionable text instead of
      // rewriting both into the generic "screenshot failed" wrapper (R7).
      // `window-controlled`（BUG-05 的接管检查点）同理：把"用户接管了"包装成
      // "截图失败"会让模型以为重试就能拿到图。
      if (cause instanceof BrowserError && (cause.code === 'policy' || cause.code === 'window-controlled')) throw cause
      // An empty capture (hidden window / background tab / zero-sized view)
      // must be a visible failure, never a silent 0-byte "screenshot" (P2-31).
      const message = cause instanceof Error ? cause.message : String(cause)
      this.record('browser_screenshot', resolved, `screenshot failed: ${message}`, true)
      // Model-facing: English like the rest of the tool surface (tool
      // descriptions are registered once and cannot be per-request), and no
      // localized window name — the window is 「浏览器」in zh and "browser" here.
      throw new Error(
        `browser: screenshot failed — ${message}; the tab must be able to render (open the browser window if it is closed, then retry)`,
      )
    }
    // 截图完成后的接管复检已移入 agentRun 体内（见上方注释）：放在这里会因为
    // 绕过 withAgentAttribution 而丢掉 gateBlock/op-log 记录。
    this.record('browser_screenshot', resolved, 'screenshot captured')
    return data
  }

  /**
   * Budget for the native capture attempt. The renderer-side fallback needs a
   * real share of the call budget, so a deployment that shortens `timeoutMs`
   * shortens this bound with it instead of letting the native path overrun.
   */
  private screenshotPrimaryBudgetMs(): number {
    return Math.min(
      SCREENSHOT_PRIMARY_BUDGET_MS,
      Math.max(1_000, this.options.timeoutMs - SCREENSHOT_FALLBACK_RESERVE_MS),
    )
  }

  /**
   * Budget for the renderer-side (CDP) capture attempt: the reserve share of
   * the call budget, never more than what the primary attempt left behind.
   *
   * 2026-09-17 (real-device report, Windows client 2.7.5-beta.4): the primary
   * `capturePage()` attempt was bounded, but this fallback was awaited
   * **unbounded** — a renderer that never produces a frame made the whole call
   * run into the tool deadline, and the model only ever saw
   * `tool call timed out after 30000ms` (twice, on two different sites) with
   * nothing pointing at the capture being stuck. `budgets.ts` documents the
   * invariant as "8s native + 5s renderer fallback" *inside* the 30s tool
   * budget; without this bound that invariant does not hold. Both attempts are
   * bounded now, so a stall reports itself instead of being replaced by the
   * upstream timeout policy.
   */
  private screenshotFallbackBudgetMs(): number {
    const remaining = this.options.timeoutMs - this.screenshotPrimaryBudgetMs() - SCREENSHOT_DEADLINE_MARGIN_MS
    return Math.max(1_000, Math.min(SCREENSHOT_FALLBACK_RESERVE_MS, remaining))
  }

  /**
   * Eval guardrail (heuristic AST policy + result masking + credential window).
   *
   * On an ordinary tab the validator stays a misuse guardrail, NOT a security
   * boundary: the AI may operate every part of the browser (fetch/XHR/arbitrary
   * JS included). Since FIX-03 the *returned* string additionally goes through
   * {@link redactFilledSecretsText}.
   *
   * R-4 (2026-09-13) replaces the R-2 "per-API refusal on credential tabs"
   * layer with the credential-activity window: while the injected credential is
   * still in the page, `browser_eval` is refused **entirely**. The R-2 layer was
   * a heuristic (it refused the API names a model might use and shimmed the top
   * realm for the duration of one call) and the independent re-verification
   * walked around it — `document.querySelector('#f').contentWindow['fe'+'tch']`,
   * `Object.getPrototypeOf(navigator)['send'+'Beacon']`, `setAttribute('src')`,
   * and above all the read side (`btoa(pw)`, `[...pw].join('-')`, `pw.slice()`).
   * Value-level defences cannot see a transform, so the channel — not the value
   * — is what has to close. `assertCredentialTabExpression` /
   * `wrapEvalExpression({denyEgress:true})` stay in `eval-policy.ts` as the
   * documented R-2 vocabulary and as the second layer for any future eval entry
   * point that is not behind this window; they are no longer on this path.
   */
  async eval(tabId: number, expression: string, frame?: number, signal?: AbortSignal): Promise<string> {
    if (!this.options.evalEnabled) {
      throw browserError('policy', 'browser: browser_eval is disabled in this deployment')
    }
    if (typeof frame === 'number' && frame < 0) {
      throw browserError('not-found', 'browser: frame index must be >= 0')
    }
    validateEvalExpression(expression)
    const resolved = this.resolveTab(tabId)
    const result = await this.agentRun('browser_eval', async () => {
      const tab = this.tab(resolved)
      // R-4 credential-activity window: while the injected credentials are still
      // in this page, `browser_eval` is refused outright — the read-back itself
      // is a channel (see the class doc above). R7: the predicate also covers the
      // ORIGIN's window, so a sibling tab on the same origin (which can read the
      // value out of localStorage/cookies) is refused too.
      if (this.tabInCredentialWindow(tab)) {
        this.record('browser_eval', resolved, 'refused: credential window open', true)
        throw browserError('policy', CREDENTIAL_WINDOW_EVAL_REFUSAL)
      }
      // R-4: `frame: N` is a DOM position. Resolve it through the reconciled
      // index (same-process frames + out-of-process iframes) or refuse.
      const target = typeof frame === 'number' && frame > 0 ? await this.resolveFrame(tab, frame) : undefined
      const evalResult = await tab.cdp.send<EvalResult>('Runtime.evaluate', {
        expression: wrapEvalExpression(expression),
        returnByValue: true,
        // awaitPromise: true — a Promise result (fetch/XHR/async expression)
        // must be awaited by the renderer and serialized as its resolved value
        // (P1-20). With `false` CDP returned `{}` for every promise, so the AI
        // could issue requests but never read a response. The page-side
        // `timeout` below and the CDP transport timeout (P0-4) bound a never-
        // settling promise.
        awaitPromise: true,
        timeout: Math.min(this.options.timeoutMs, 10_000),
        // A frame's default world is addressed by contextId (same-process);
        // frame 0 passes neither and keeps the pre-existing default-world
        // semantics. A cross-origin frame is addressed by its flat CDP session
        // on the TRANSPORT (third argument), not as a command parameter.
        ...(target?.contextId === undefined ? {} : { contextId: target.contextId }),
      }, target?.sessionId === undefined ? {} : { sessionId: target.sessionId })
      // A long awaited promise may resolve after the user took over; discard
      // the result instead of handing it to the model as a live page read.
      this.assertAgentStillAllowed('browser_eval')
      if (evalResult.exceptionDetails !== undefined) {
        throw browserError('eval-policy', 'browser: page script failed (exception)')
      }
      // FIX-03 (2026-09-12): `browser_eval` used to be the un-redacted sibling
      // of `browser_get_snapshot` — `document.querySelector('#pw').value`
      // handed the injected connector password straight back to the model.
      // The serialized string goes through the SAME value-level redactor as the
      // snapshot funnel (`redactFilledSecretsText`), applied after
      // `serializeEvalResult`'s keyword masking (a random password carries no
      // keyword for that mask to catch).
      //
      // Since R-4 the credential window refuses eval before this point, so
      // `filledSecrets` is empty here on every tab that can reach it. The call
      // is kept as the value-exact backstop for any future path that runs page
      // JS without being behind the window.
      //
      // F-5 (2026-09-13 round 2): the projection is handed to
      // `serializeEvalResult` itself, so it runs on every string value and key
      // BEFORE `maskString`'s 4 KB cap and the 8 KB serialized cap — those two
      // cuts used to run first, and a password straddling either one came back
      // as a plaintext head fragment. The outer pass stays as the backstop for
      // anything the per-value projection cannot see (it is cheap: ≤ 8 KB).
      return redactFilledSecretsText(
        tab,
        serializeEvalResult(evalResult.result?.value, (text) => redactFilledSecretsText(tab, text)),
      )
    }, signal)
    this.record('browser_eval', resolved, `eval: ${expression}`, false, 'ai', EVAL_SUMMARY_LIMIT)
    return result
  }

  /**
   * Apply the value-level secret redaction of the snapshot/eval funnels to an
   * arbitrary text produced from `tabId` (FIX-03 depth layer, 2026-09-12).
   *
   * Exposed so the tool layer can re-apply the exact same reducer to a value
   * that already went through `runtime.eval` — redundant by design, so a
   * future runtime path or caller cannot hand the model a credential this tab
   * received through `fillCredentials`. Unknown/empty tabs pass the text
   * through unchanged (this helper must never break a working call). Since R-4
   * the list is non-empty only inside the credential window, where eval itself
   * is refused — this is a backstop, not the enforcement point.
   *
   * R7 (2026-09-13): `verbatim: true` for a machine-shaped string that cannot be
   * prose — a CSS selector is the case that matters (`#<credential>` from a page
   * that writes the value into `el.id`). Without it a SHORT id-safe value
   * (`abc123`) stayed verbatim in the snapshot's selector exit while the
   * interaction-error exit — which is verbatim — already masked it: same
   * selector, two rules. The token rule masks the whole occurrence, so a short
   * value cannot be confused with a neighbouring word (`/test-report` stays).
   *
   * Same honest boundary as `eval()`: this is not an egress firewall.
   */
  redactTabSecrets(tabId: number, text: string, options: { verbatim?: boolean } = {}): string {
    const tab = this.tabs.get(tabId)
    if (tab === undefined || tab.filledSecrets.length === 0) return text
    return redactFilledSecretsText(tab, text, options)
  }

  /**
   * Resolve the requested `frame: N` through the reconciled index.
   *
   * Out-of-range is a plain not-found listing the page's real frame count (the
   * model can only fix its call if it knows how many frames exist); a page the
   * index cannot prove 1:1 throws the explicit R-4 refusal instead.
   */
  private async resolveFrame(tab: BrowserTab, frameIndex: number): Promise<ResolvedFrame> {
    const index = await this.frameIndex(tab)
    const entry = index[frameIndex]
    if (entry === undefined) {
      throw browserError('not-found', `browser: frame ${frameIndex} does not exist (this page has ${index.length} frames: 0-${index.length - 1})`)
    }
    return entry
  }

  /**
   * Resolve `frame: N` into the JS world it actually means (R-4, 2026-09-13).
   *
   * The pre-2026-09-13 version indexed `Page.getFrameTree` directly. On a
   * site-isolated page that array is NOT the DOM order the model sees: a
   * cross-origin (out-of-process) iframe is absent from the page session's
   * frame tree, so with the OOPIF first in the DOM and a same-process iframe
   * second, `frame: 1` silently resolved to the *second* iframe. Verified on
   * Electron 43.4.0 / Chromium 150 with real CDP
   * (`tests/probes/frame-index-probe.mjs`, evidence `oopif-probe.json`).
   *
   * The index is now built from the page structure (DOM order of the
   * `iframe`/`frame` owners) reconciled against everything CDP can reach —
   * including out-of-process frames, which ARE reachable: Electron's debugger
   * supports flat sessions, so `Target.setAutoAttach({flatten:true})` reports
   * the OOPIF as an `iframe` target and `Runtime.evaluate` with its
   * `sessionId` reads the frame's own globals (same probe). Any frame owner
   * that cannot be paired 1:1 is refused with an explicit error instead of
   * being pointed at a neighbouring frame.
   */
  private async frameIndex(tab: BrowserTab): Promise<ResolvedFrame[]> {
    const attempt = async (): Promise<ResolvedFrame[] | FrameOrderProblem> => {
      const tree = await tab.cdp.send<{ frameTree?: RawFrameNode }>('Page.getFrameTree')
      if (tree.frameTree === undefined) throw browserError('not-found', 'browser: the page has no frame tree yet')
      // One flat registry built from BOTH sources: the page session's frame tree
      // (same-process frames) and every attached out-of-process target's own
      // frame tree. An OOPIF's same-process children exist only in the latter,
      // which is why indexing a single `Page.getFrameTree` silently dropped them.
      interface RegisteredFrame {
        frameId: string
        url: string
        parentId: string | undefined
        sessionId: string | undefined
        /** DOM children, in DOM order (rebuilt when the OOPIF re-registers the
         *  node from its own tree, so a frame is never listed twice). */
        childIds: string[]
        /** Root of an out-of-process frame: it IS addressed by its session, so
         *  no `contextId` is resolved for it (evaluating with the session and no
         *  context lands in that frame's own default world). */
        sessionOnly: boolean
      }
      const registry = new Map<string, RegisteredFrame>()
      const addTree = (node: RawFrameNode, parentId: string | undefined, sessionId: string | undefined, sessionOnly: boolean): string | undefined => {
        const id = node.frame?.id
        if (id === undefined) return undefined
        const childIds: string[] = []
        for (const child of node.childFrames ?? []) {
          const childId = addTree(child, id, sessionId, false)
          if (childId !== undefined) childIds.push(childId)
        }
        registry.set(id, { frameId: id, url: node.frame?.url ?? '', parentId, sessionId, childIds, sessionOnly })
        return id
      }
      const rootId = addTree(tree.frameTree, undefined, undefined, false)
      if (rootId === undefined) throw browserError('not-found', 'browser: the page has no frame tree yet')
      // Out-of-process frames only need attaching when the document actually has
      // frame owners: a page without any iframe must not pay for the round trips.
      const rootOwners = await this.domFrameOwnerUrls(tab, {})
      await this.ensureFrameTracking(tab, registry.size > 1 || rootOwners.length > 0)
      // Re-register every attached OOPIF from its OWN tree (authoritative
      // session + parent). Doing it unconditionally — not only when the frame id
      // is unknown — matters when a parent tree also mentions the remote frame:
      // the OOPIF entry must still carry the OOPIF's session, otherwise its
      // same-process children are resolved in the parent process and the whole
      // index is refused (R-4, 2026-09-13).
      for (const [sessionId, frame] of tab.oopifFrames) {
        addTree(frame.tree, frame.parentId, sessionId, true)
      }
      // Link re-adds: an out-of-process frame is normally absent from its
      // parent's `Page.getFrameTree` (that is WHY it needs its own session), so
      // the re-registration above left it out of `parent.childIds` and the DOM
      // reconciliation would count one frame owner too many and refuse the page.
      // The OOPIF's own tree reports its `parentId`, so the edge is known — add
      // it back, once.
      for (const frame of registry.values()) {
        if (frame.parentId === undefined) continue
        const parent = registry.get(frame.parentId)
        if (parent === undefined || parent.childIds.includes(frame.frameId)) continue
        parent.childIds.push(frame.frameId)
      }

      const index: ResolvedFrame[] = []
      const visit = async (frame: RegisteredFrame, depth: number, contextId: number | undefined): Promise<ResolvedFrame[] | FrameOrderProblem> => {
        index.push({
          frameId: frame.frameId,
          url: frame.url,
          depth,
          ...(frame.sessionId === undefined ? {} : { sessionId: frame.sessionId }),
          ...(contextId === undefined ? {} : { contextId }),
        })
        // This document's frame owners, read in ITS own world: the OOPIF session
        // for a cross-origin frame, the default-world context otherwise (nothing
        // at all for the main frame, whose world is the implicit default).
        const domUrls = depth === 0 && contextId === undefined && frame.sessionId === undefined
          ? rootOwners
          : await this.domFrameOwnerUrls(tab, {
            ...(frame.sessionId === undefined ? {} : { sessionId: frame.sessionId }),
            ...(contextId === undefined ? {} : { contextId }),
          })
        const candidates: FrameCandidate[] = frame.childIds.map((id) => {
          const child = registry.get(id)!
          return { frameId: child.frameId, url: child.url, ...(child.sessionId === undefined ? {} : { sessionId: child.sessionId }) }
        })
        const ordered = orderFramesByDom(domUrls, candidates)
        if (isFrameOrderProblem(ordered)) return { ...ordered, depth }
        for (const child of ordered) {
          const childNode = registry.get(child.frameId)
          if (childNode === undefined) continue
          // A frame that is not the root of its own (out-of-process) session is
          // addressed by the default-world context of THAT session: with only a
          // session id and no context, CDP evaluates in the session's own main
          // document, i.e. silently one frame up (the R-4 defect).
          let childContext: number | undefined
          if (!childNode.sessionOnly) {
            childContext = await defaultWorldContextId(tab, child.frameId, childNode.sessionId)
            // No silent fallback to an isolated world: that would restore the
            // P1-7 bug (page JS globals read as `undefined`) without any error.
            if (childContext === undefined) {
              return { domUrls, reachableUrls: [], reason: `frame ${child.url || child.frameId} has no default JavaScript world` }
            }
          }
          const nested = await visit(childNode, depth + 1, childContext)
          if (isFrameOrderProblem(nested)) return nested
        }
        return index
      }
      // The main frame is evaluated in its default world implicitly (no
      // contextId), exactly like `frame: 0` always did.
      return await visit(registry.get(rootId)!, 0, undefined)
    }

    let outcome = await attempt()
    if (isFrameOrderProblem(outcome)) {
      // A frame owner that appears a tick before its frame (insert before
      // commit) is a real race, not a security event: settle once, then refuse.
      await sleep(FRAME_INDEX_SETTLE_MS)
      outcome = await attempt()
      if (isFrameOrderProblem(outcome)) {
        throw browserError('not-found', frameOrderErrorMessage(outcome))
      }
    }
    return outcome
  }

  /** The `frame`/`iframe` owner URLs of one document, in DOM order (R-4). */
  private async domFrameOwnerUrls(tab: BrowserTab, world: { contextId?: number; sessionId?: string }): Promise<string[]> {
    const result = await tab.cdp.send<EvalResult>('Runtime.evaluate', {
      expression: `[...document.querySelectorAll('iframe,frame')].map((el) => el.hasAttribute('srcdoc') ? ${JSON.stringify(SRCDOC_URL)} : (el.src || 'about:blank'))`,
      returnByValue: true,
      ...(world.contextId === undefined ? {} : { contextId: world.contextId }),
    }, world.sessionId === undefined ? {} : { sessionId: world.sessionId })
    const value = result.result?.value
    if (!Array.isArray(value)) {
      // Mid-navigation / detached: the caller turns this into a fail-loud
      // refusal, because indexing an unknown layout is exactly the defect.
      throw browserError('not-found', 'browser: the page frame layout is not readable right now (navigation in progress)')
    }
    return value.map((url) => String(url))
  }

  /**
   * Install flat-session frame tracking for a tab (idempotent).
   *
   * `Target.setAutoAttach` reports existing out-of-process iframes once; the
   * listeners keep {@link BrowserTab.oopifFrames} current afterwards, so a
   * second `frame: N` call does not have to re-discover them. Detached targets
   * remove their entry.
   */
  private async ensureFrameTracking(tab: BrowserTab, needed: boolean): Promise<void> {
    if (tab.frameTrackingReady || !needed) return
    tab.frameTrackingReady = true
    const register = (sessionId: string, targetInfo: { url?: string } | undefined): void => {
      // The frame id and parent come from the attached target's OWN frame tree
      // (authoritative), not from URL guessing.
      void tab.cdp.send<{ frameTree?: RawFrameNode }>('Page.getFrameTree', {}, { sessionId }).then((tree) => {
        const frameTree = tree.frameTree
        if (frameTree?.frame?.id === undefined) return
        tab.oopifFrames.set(sessionId, {
          frameId: frameTree.frame.id,
          url: frameTree.frame.url ?? targetInfo?.url ?? '',
          parentId: frameTree.frame.parentId,
          tree: frameTree,
        })
        // Nested out-of-process frames: attach on the child session too, so a
        // grandchild OOPIF registers itself the same way.
        void tab.cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, { sessionId }).catch(() => { /* not an attachable target */ })
      }).catch(() => { /* detached before it answered */ })
    }
    tab.disposers.push(tab.cdp.on('Target.attachedToTarget', (params) => {
      const event = params as { sessionId?: string; targetInfo?: { type?: string; url?: string } }
      if (event.sessionId === undefined || event.targetInfo?.type !== 'iframe') return
      register(event.sessionId, event.targetInfo)
    }))
    tab.disposers.push(tab.cdp.on('Target.detachedFromTarget', (params) => {
      const sessionId = (params as { sessionId?: string }).sessionId
      if (sessionId !== undefined) tab.oopifFrames.delete(sessionId)
    }))
    try {
      await tab.cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
    } catch {
      // Older protocol / plain-Node mock: the index still works for
      // same-process frames, and refuses when the DOM proves more frames exist.
      return
    }
    // Let the already-existing iframe targets report in before the caller
    // reconciles (the attach events race the setAutoAttach reply).
    const deadline = Date.now() + FRAME_CONTEXT_WAIT_MS
    while (Date.now() < deadline && tab.oopifFrames.size === 0) await sleep(FRAME_CONTEXT_POLL_MS)
    await sleep(FRAME_CONTEXT_POLL_MS)
  }

  async locateElement(tabId: number, selector: string, signal?: AbortSignal): Promise<{ x: number; y: number }> {
    const resolved = this.resolveTab(tabId)
    return await this.agentRun('browser_locate', async () => {
      const tab = this.tab(resolved)
      const result = await tab.cdp.send<EvalResult>('Runtime.evaluate', {
        expression: `
          (() => {
            try {
              const el = document.querySelector(${JSON.stringify(String(selector))});
              if (!el) return { error: 'element not found' };
              el.scrollIntoView({ block: 'center', inline: 'center' });
              const r = el.getBoundingClientRect();
              return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
            } catch (e) {
              return { error: String(e) };
            }
          })()
        `,
        returnByValue: true,
      })
      const value = result.result?.value as { x?: number; y?: number; error?: string } | undefined
      if (value === undefined || value.error !== undefined) {
        throw this.interactionError(tab, 'not-found', `browser: cannot locate element ${selector}${value?.error !== undefined ? ` (${value.error})` : ''}`)
      }
      if (typeof value.x !== 'number' || typeof value.y !== 'number') {
        throw this.interactionError(tab, 'not-found', `browser: cannot locate element ${selector}`)
      }
      return { x: value.x, y: value.y }
    }, signal)
  }

  async clickAt(tabId: number, point: { x: number; y: number }, signal?: AbortSignal): Promise<void> {
    const resolved = this.resolveTab(tabId)
    await this.agentRun('browser_click', async () => {
      const tab = this.tab(resolved)
      // 2026-09-12: synthesized OS-level input (CDP `Input.dispatchMouseEvent`)
      // needs an input-visible RenderWidgetHost. The browser window is created
      // hidden by design (2026-09-08 product decision), and on a hidden window
      // those events are accepted by the protocol yet never delivered to the
      // page — the tool reported success while nothing happened (real-device
      // report: links did not navigate, submit buttons did not submit, while
      // DOM-level tools such as fill_form/select kept working).
      //
      // So: real input when the window can receive it, DOM-level activation
      // (elementFromPoint + a full bubbling event sequence) otherwise. The
      // dispatch path is recorded in the op log so the difference stays visible.
      if (this.windowCanReceiveInput()) {
        await tab.cdp.send('Input.dispatchMouseEvent', {
          type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1,
        })
        await tab.cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1,
        })
        this.record('browser_click', resolved, `click at (${Math.round(point.x)}, ${Math.round(point.y)})`)
        return
      }
      const target = await this.activateAtPoint(tab, point)
      this.record(
        'browser_click',
        resolved,
        target === 'none'
          ? `click at (${Math.round(point.x)}, ${Math.round(point.y)}) hit no element (hidden window: DOM dispatch)`
          : `click at (${Math.round(point.x)}, ${Math.round(point.y)}) via DOM dispatch (hidden window)`,
        target === 'none',
      )
      if (target === 'none') {
        throw browserError('not-found', `browser: nothing to click at (${Math.round(point.x)}, ${Math.round(point.y)}) — the point is outside any element`)
      }
    }, signal)
  }

  /** Whether the browser window currently has a surface that receives input. */
  private windowCanReceiveInput(): boolean {
    if (this.window === null || this.window.isDestroyed()) return false
    return this.window.isVisible()
  }

  /**
   * DOM-level activation of whatever sits at a viewport point, used when the
   * window cannot deliver real input (hidden window). `elementFromPoint` is
   * layout-based, so it works without a compositor, and the dispatched sequence
   * is a full bubbling pointer/mouse/click chain so handlers that listen for any
   * of those (and activation behavior such as link navigation, checkbox toggle
   * or form submission) still fire.
   *
   * @returns `'element'` when something was hit, `'none'` for an empty point.
   */
  private async activateAtPoint(tab: BrowserTab, point: { x: number; y: number }): Promise<'element' | 'none'> {
    const x = Number(point.x)
    const y = Number(point.y)
    const result = await tab.cdp.send<{ result?: { value?: unknown } }>('Runtime.evaluate', {
      expression: `
        (() => {
          const x = ${JSON.stringify(x)};
          const y = ${JSON.stringify(y)};
          const el = document.elementFromPoint(x, y);
          if (!el) return 'none';
          if (typeof el.focus === 'function') { try { el.focus({ preventScroll: true }); } catch {} }
          const base = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, detail: 1 };
          const Pointer = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
          const sequence = [
            () => el.dispatchEvent(new Pointer('pointerdown', { ...base, buttons: 1, isPrimary: true, pointerId: 1, pointerType: 'mouse' })),
            () => el.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 })),
            () => el.dispatchEvent(new Pointer('pointerup', { ...base, buttons: 0, isPrimary: true, pointerId: 1, pointerType: 'mouse' })),
            () => el.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 })),
            () => el.dispatchEvent(new MouseEvent('click', { ...base, buttons: 0 })),
          ];
          for (const dispatch of sequence) dispatch();
          return 'element';
        })()
      `,
      returnByValue: true,
    })
    return result.result?.value === 'element' ? 'element' : 'none'
  }

  async typeInto(tabId: number, selector: string, text: string, clear = true, signal?: AbortSignal): Promise<void> {
    const resolved = this.resolveTab(tabId)
    await this.agentRun('browser_type', async () => {
      const tab = this.tab(resolved)
      const before = await this.textFieldState(tab, selector)
      if (before === null) throw this.interactionError(tab, 'not-found', `browser: cannot locate element ${selector}`)
      await tab.cdp.send('Runtime.evaluate', {
        expression: `
          (() => {
            const el = document.querySelector(${JSON.stringify(String(selector))});
            if (!el) return { error: 'element not found' };
            el.focus();
            ${clear ? 'if (typeof el.select === "function") el.select();' : ''}
            return {};
          })()
        `,
        returnByValue: true,
      })
      await tab.cdp.send('Input.insertText', { text })
      // 2026-09-12: `Input.insertText` 与鼠标/键盘事件同属输入域，隐藏窗口下未必送达
      // （真机自检报告把 browser_type 记成"返回成功"，但没验效果）。这里不做平台假设，
      // 直接读回校验：内容没变就退到 DOM 写入（原生 setter + input/change，React 受控
      // 组件也认），并把实际路径写进操作日志。
      const after = await this.textFieldState(tab, selector)
      if (this.contentChanged(before, after)) {
        this.record('browser_type', resolved, `type into ${selector}`)
        await this.afterChangeSummary(tab)
        return
      }
      const outcome = await this.insertTextViaDom(tab, selector, text, clear)
      this.record(
        'browser_type',
        resolved,
        `type into ${selector} via DOM write (hidden window)${outcome === 'typed' ? '' : ` — ${outcome}`}`,
        outcome !== 'typed',
      )
      if (outcome !== 'typed') {
        throw this.interactionError(tab, 'not-found', `browser: cannot type into ${selector} (${outcome})`)
      }
      await this.afterChangeSummary(tab)
    }, signal)
  }

  /** Read back a field's current content (`null` when the element is missing). */
  private async textFieldState(tab: BrowserTab, selector: string): Promise<string | null> {
    try {
      const result = await tab.cdp.send<EvalResult>('Runtime.evaluate', {
        expression: `
          (() => {
            const el = document.querySelector(${JSON.stringify(String(selector))});
            if (!el) return null;
            if (typeof el.value === 'string') return el.value;
            if (el.isContentEditable) return el.textContent ?? '';
            return '';
          })()
        `,
        returnByValue: true,
      })
      const value = result.result?.value
      return typeof value === 'string' ? value : value === null ? null : ''
    } catch {
      return null
    }
  }

  /** Whether the readback shows the DOM write changed the field. */
  private contentChanged(before: string | null, after: string | null): boolean {
    if (after === null) return false
    return after !== before
  }

  /**
   * DOM-level text entry, used when the CDP input-domain write had no effect
   * (hidden window). Prefers `execCommand('insertText')` — that is the path rich
   * editors (contenteditable/Lexical) accept — and falls back to the element's
   * native `value` setter plus `input`/`change` events, which is what React
   * controlled inputs require.
   *
   * @returns `'typed'` on success, otherwise a short reason.
   */
  private async insertTextViaDom(
    tab: BrowserTab,
    selector: string,
    text: string,
    clear: boolean,
  ): Promise<'typed' | 'unsupported' | 'not-found'> {
    const result = await tab.cdp.send<EvalResult>('Runtime.evaluate', {
      expression: `
        (() => {
          const el = document.querySelector(${JSON.stringify(String(selector))});
          if (!el) return 'not-found';
          el.focus();
          const editable = el.isContentEditable === true || typeof el.value === 'string';
          if (!editable) return 'unsupported';
          if (${JSON.stringify(clear)}) {
            if (el.isContentEditable) {
              try { document.execCommand('selectAll', false, undefined); document.execCommand('delete', false, undefined); } catch {}
            } else if (typeof el.select === 'function') {
              el.select();
            }
          }
          let inserted = false;
          try { inserted = document.execCommand('insertText', false, ${JSON.stringify(text)}); } catch { inserted = false; }
          if (!inserted && typeof el.value === 'string') {
            const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
            const next = ${JSON.stringify(clear)} ? ${JSON.stringify(text)} : String(el.value ?? '') + ${JSON.stringify(text)};
            if (descriptor !== undefined && typeof descriptor.set === 'function') descriptor.set.call(el, next);
            else el.value = next;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            inserted = true;
          }
          return inserted ? 'typed' : 'unsupported';
        })()
      `,
      returnByValue: true,
    })
    const value = result.result?.value
    return value === 'typed' || value === 'unsupported' || value === 'not-found' ? value : 'unsupported'
  }

  private async afterChangeSummary(tab: BrowserTab): Promise<void> {
    try {
      const result = await tab.cdp.send<EvalResult>('Runtime.evaluate', {
        expression: '(() => { const b = document.body; const t = b ? document.title : ""; const forms = document.querySelectorAll("form").length; const errs = [...document.querySelectorAll("[role=alert], .error, [aria-invalid=true]")].length; return JSON.stringify({ title: t, forms, errors: errs }); })()',
        returnByValue: true,
      })
      const value = result.result?.value
      if (typeof value === 'string') this.record('browser_page_state', tab.id, `after-change: ${value}`, false, 'ai', PAGE_STATE_SUMMARY_LIMIT)
    } catch { /* best effort */ }
  }

  /**
   * 只读判定：文档里有没有能接收按键的元素（`document.activeElement`，退回
   * `body`）。隐藏窗口路径一直有这个判定，可见窗口路径没有 —— 工具描述对外
   * 承诺的 "no element able to receive the key ⇒ not-found" 因此只对一半路径
   * 成立（2026-09-15 审计 P3）。
   * @returns 命中的标签名，或 `null`（文档里没有可接收目标）。
   */
  private async keyReceivableTarget(tab: BrowserTab): Promise<string | null> {
    const result = await tab.cdp.send<EvalResult>('Runtime.evaluate', {
      expression: '(() => { const el = document.activeElement ?? document.body; return el ? String(el.tagName || "unknown") : "none"; })()',
      returnByValue: true,
    })
    const value = result.result?.value
    return typeof value === 'string' && value !== 'none' ? value : null
  }

  async pressKey(tabId: number, key: string, signal?: AbortSignal): Promise<void> {
    const resolved = this.resolveTab(tabId)
    await this.agentRun('browser_press', async () => {
      const tab = this.tab(resolved)
      const code = KEY_CODES[key] ?? key
      const vk = KEY_VK[key] ?? 0
      const target = await this.keyReceivableTarget(tab)
      if (target === null) {
        // 与隐藏窗口路径同一出口：记失败，由工具层的 assertNoFailedOp 统一报
        // not-found（消息里带 "not delivered"），不在 runtime 里另造一套文案。
        this.record('browser_press', resolved, `press ${key} — no element able to receive the key`, true)
        return
      }
      // 2026-09-12：与 browser_click 同源。键盘事件也属输入域，隐藏窗口下协议层接受、
      // 页面收不到（真机自检报告把 browser_press 记成"返回成功"，但没有验证效果）。
      if (this.windowCanReceiveInput()) {
        await tab.cdp.send('Input.dispatchKeyEvent', {
          type: 'keyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
        })
        await tab.cdp.send('Input.dispatchKeyEvent', {
          type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
        })
        // 可见窗口同样要有读回：先把"谁在接收"读出来再记成功（P3）。
        // target 来自页面（activeElement.tagName，无长度上限）⇒ 摘要必须带上限（S02-04）。
        this.record('browser_press', resolved, `press ${key} → ${target}`, false, 'ai', PRESS_TARGET_SUMMARY_LIMIT)
        return
      }
      const outcome = await this.dispatchKeyViaDom(tab, key, code, vk)
      this.record('browser_press', resolved, `press ${key} via DOM dispatch (hidden window) — ${outcome}`, outcome === 'none')
    }, signal)
  }

  /**
   * DOM-level key dispatch for a window that cannot receive real input.
   *
   * Synthetic keyboard events do **not** trigger a browser's activation behavior,
   * so the two shortcuts users actually depend on are applied explicitly:
   * Enter inside a form submits it, and Enter/Space on a button, link, checkbox
   * or radio activates it. Without that, "fill the field then press Enter" would
   * silently do nothing in a hidden window.
   *
   * @returns a short outcome label for the op log.
   */
  private async dispatchKeyViaDom(tab: BrowserTab, key: string, code: string, vk: number): Promise<string> {
    const result = await tab.cdp.send<EvalResult>('Runtime.evaluate', {
      expression: `
        (() => {
          const key = ${JSON.stringify(key)};
          const target = document.activeElement ?? document.body;
          if (!target) return 'none';
          const base = { key, code: ${JSON.stringify(code)}, keyCode: ${JSON.stringify(vk)}, which: ${JSON.stringify(vk)}, bubbles: true, cancelable: true, composed: true };
          const down = new KeyboardEvent('keydown', base);
          const allowed = target.dispatchEvent(down);
          target.dispatchEvent(new KeyboardEvent('keypress', base));
          target.dispatchEvent(new KeyboardEvent('keyup', base));
          if (!allowed) return 'default-prevented';
          if (key === 'Enter') {
            const form = target.form ?? (typeof target.closest === 'function' ? target.closest('form') : null);
            if (form !== null && form !== undefined && typeof form.requestSubmit === 'function') { form.requestSubmit(); return 'submitted-form'; }
          }
          const activatable = typeof target.closest === 'function'
            ? target.closest('button, a[href], input[type=checkbox], input[type=radio], [role=button]')
            : null;
          const activating = key === 'Enter' || key === ' ' || key === 'Spacebar';
          if (activating && activatable !== null && activatable !== undefined && typeof activatable.click === 'function') {
            activatable.click();
            return 'activated-element';
          }
          return 'dispatched';
        })()
      `,
      returnByValue: true,
    })
    const value = result.result?.value
    return typeof value === 'string' ? value : 'dispatched'
  }

  async selectOption(tabId: number, selector: string, value: string, signal?: AbortSignal): Promise<void> {
    const resolved = this.resolveTab(tabId)
    await this.agentRun('browser_select', async () => {
      const tab = this.tab(resolved)
      const result = await tab.cdp.send<EvalResult>('Runtime.evaluate', {
        expression: `
          (() => {
            const el = document.querySelector(${JSON.stringify(String(selector))});
            if (!el) return { error: 'element not found' };
            if (el.tagName !== 'SELECT') return { error: 'not a select element' };
            const wanted = ${JSON.stringify(value)};
            el.value = wanted;
            // Assigning an unknown value silently falls back to '' (or the
            // first option). Report it instead of claiming success (P2-32).
            if (el.value !== wanted) return { error: 'option not found: ' + wanted };
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return {};
          })()
        `,
        returnByValue: true,
      })
      if (result.result?.value !== undefined && (result.result.value as { error?: string }).error !== undefined) {
        throw this.interactionError(tab, 'not-found', `browser: select failed — ${(result.result.value as { error: string }).error}`)
      }
    }, signal)
    this.record('browser_select', resolved, `select ${selector} = ${value}`, false, 'ai', `select ${selector} = `.length + SELECT_VALUE_SUMMARY_LIMIT)
  }

  async scroll(tabId: number, deltaY: number, selector: string | undefined, signal?: AbortSignal): Promise<void> {
    const resolved = this.resolveTab(tabId)
    await this.agentRun('browser_scroll', async () => {
      const tab = this.tab(resolved)
      const targeted = selector !== undefined && selector !== ''
      const expression = !targeted
        ? `window.scrollBy({ top: ${Math.round(deltaY)}, behavior: 'instant' }); 'ok'`
        : `(() => { const el = document.querySelector(${JSON.stringify(String(selector))}); if (!el) return 'not found'; el.scrollIntoView({ block: 'center' }); return 'ok'; })()`
      const result = await tab.cdp.send<EvalResult>('Runtime.evaluate', { expression, returnByValue: true })
      // 页内判定必须回传（2026-09-15 审计残留）：旧实现丢掉返回值，选择器没命中
      // 也报成功，模型以为已经滚到了目标位置。
      if (targeted && result.result?.value === 'not found') {
        throw this.interactionError(tab, 'not-found', `browser: scroll target not found — ${String(selector)}`)
      }
    }, signal)
    this.record('browser_scroll', resolved, selector === undefined || selector === '' ? `scroll ${Math.round(deltaY)}px` : `scroll to ${selector}`)
  }

  async fillCredentials(tabId: number, connectorId: string, signal?: AbortSignal, expectedOrigin?: string): Promise<{ username: boolean; password: boolean }> {
    if (this.credentials === undefined) {
      throw browserError('policy', 'browser: credential injection is not available in this deployment')
    }
    const credential = await this.credentials(connectorId)
    if (credential === null) {
      throw browserError('not-found', `browser: no stored credentials for connector ${JSON.stringify(connectorId)}`)
    }
    const resolved = this.resolveTab(tabId)
    const outcome = await this.agentRun('browser_fill_credentials', async () => {
      const tab = this.tab(resolved)
      // TOCTOU 收口（2026-09-15 复核）：工具层的站点绑定检查发生在排队之前，注入
      // 发生在拿到全局互斥之后 —— 中间标签页可以导航走。写入 DOM 之前用**同一个**
      // expectedOrigin 再比一次。
      if (expectedOrigin !== undefined && httpOriginOf(tab.url) !== expectedOrigin) {
        // 拒绝文案**不含被观测的任何字节**（2026-09-17 四轮复核，与工具层
        // src/tools.ts 的同一条拒绝保持同一口径）：脱敏投影挡不住两类口令 ——
        // URL 主机会被大小写折叠（`Sup3rSecret` → `sup3rsecret`），而
        // MIN_EMBEDDED_SECRET_LENGTH 之下的短口令（如 `abc123`）根本不在擦除集里。
        // error.message 会进模型上下文与会话转录，所以这里只报"离开了站点"这个
        // 事实 + 期望 origin（后者来自用户自己的连接器登记，可安全回显）。
        throw browserError('policy', `browser_fill_credentials refused: the tab left ${expectedOrigin} before the injection ran; credentials are only injected into their own site`)
      }
      const result = await tab.cdp.send<EvalResult>('Runtime.evaluate', {
        expression: `
          (() => {
            const username = ${JSON.stringify(credential.username ?? '')};
            const password = ${JSON.stringify(credential.password ?? '')};
            const set = (el, value) => {
              el.value = value;
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            };
            const inputs = [...document.querySelectorAll('input')];
            const userField = inputs.find((el) => {
              const t = (el.type || 'text').toLowerCase();
              const n = (el.name || el.id || '').toLowerCase();
              return (t === 'text' || t === 'email' || t === 'tel') && !n.includes('password')
                && (n.includes('user') || n.includes('name') || n.includes('account') || n.includes('email') || n.includes('phone') || n.includes('login'));
            }) || inputs.find((el) => { const t = (el.type || 'text').toLowerCase(); return t === 'email' || t === 'tel'; });
            const passField = inputs.find((el) => (el.type || '').toLowerCase() === 'password');
            let filled = 0;
            if (userField && username) { set(userField, username); filled++; }
            if (passField && password) { set(passField, password); filled++; }
            return { filled, username: Boolean(userField && username), password: Boolean(passField && password) };
          })()
        `,
        returnByValue: true,
      })
      const value = result.result?.value as { filled?: number; username?: boolean; password?: boolean } | undefined
      if (value === undefined || (value.filled ?? 0) === 0) {
        throw browserError('not-found', 'browser: no matching login form found on this page')
      }
      // Remember what this tab was given (P0-A depth layer: runtime.snapshot
      // redacts these values even if a future probe source reads them back), and
      // open the credential-activity window (R-4): from here until the next
      // main-frame navigation, `browser_eval` and `browser_screenshot` are shut.
      // The window opens on ANY successful fill — a username-only injection is
      // still a credential in the DOM — while `filledSecrets` (the redaction
      // list) only ever holds passwords: a short username is an ordinary word
      // and masking it in page text would corrupt facts (R-3).
      //
      // R7 (2026-09-13): booked on the ORIGIN, not just this tab — a sibling tab
      // on the same origin can read the value back out of localStorage/cookies,
      // so it must inherit both the redaction list and the window. The TAB flag
      // set here has no deadline (this document holds the value until it
      // navigates, R-4); the origin mirror it opens is bounded (F-3).
      tab.credentialWindow = true
      this.rememberOriginCredential(
        tab,
        value.password === true && typeof credential.password === 'string' ? credential.password : '',
      )
      return { username: value.username === true, password: value.password === true }
    }, signal)
    this.record('browser_fill_credentials', resolved, `fill credentials for ${connectorId}`)
    return outcome
  }

  /**
   * Fill a form by field name/label/placeholder (batch).
   *
   * 2026-09-15 审计 BUG-04：
   *  - 写入走**原生 setter + 读回**（与 {@link insertTextViaDom} 同一形状）：
   *    旧实现直接 `el.value = v` 就 `filled++`，React 受控组件会把赋值丢掉，
   *    工具却报告"已填 N 个字段"；未知的 `<select>` 选项也被算作已填。
   *  - 提交目标是**所填字段所属的 form**（`el.form`），不是
   *    `document.querySelector('form')`（页面上第一个 form 往往是搜索框）：
   *    多表单页面会误提交无关表单。目标不唯一/不存在/没有提交控件时明确失败。
   *  - `missed` 把逐字段结果回给模型（没匹配上、或写了但读回不一致）。
   */
  async fillForm(tabId: number, fields: Array<{ field: string; value: string }>, submit: boolean, signal?: AbortSignal): Promise<{ filled: number; submitted: boolean; missed: string[] }> {
    const resolved = this.resolveTab(tabId)
    const outcome = await this.agentRun('browser_fill_form', async () => {
      const tab = this.tab(resolved)
      const result = await tab.cdp.send<EvalResult>('Runtime.evaluate', {
        expression: `
          (() => {
            const fields = ${JSON.stringify(fields.map((f) => ({ field: f.field, value: f.value })))};
            const lower = (s) => String(s || '').toLowerCase();
            const truthy = (v) => ['1', 'true', 'yes', 'on', 'y', 'checked'].includes(String(v).trim().toLowerCase());
            const writeValue = (el, value) => {
              const type = lower(el.type);
              const proto = Object.getPrototypeOf(el);
              if (type === 'checkbox' || type === 'radio') {
                const next = truthy(value);
                const descriptor = Object.getOwnPropertyDescriptor(proto, 'checked');
                try {
                  if (descriptor && typeof descriptor.set === 'function') descriptor.set.call(el, next);
                  else el.checked = next;
                } catch { return { ok: false, readBack: '' }; }
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                return { ok: el.checked === next, readBack: String(el.checked) };
              }
              // 受控组件（React 等）会拦截实例上的 value 赋值：走原型上的原生
              // setter，再读回校验，避免"填了但页面没变"被记成成功。
              const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
              try {
                if (descriptor && typeof descriptor.set === 'function') descriptor.set.call(el, String(value));
                else if (typeof el.value === 'string') el.value = String(value);
                else return { ok: false, readBack: '' };
              } catch { return { ok: false, readBack: '' }; }
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              const readBack = typeof el.value === 'string' ? el.value : '';
              return { ok: readBack === String(value), readBack };
            };
            let filled = 0;
            const missed = [];
            const targets = new Set();
            for (const f of fields) {
              const key = lower(f.field);
              const candidates = [...document.querySelectorAll('input, select, textarea')];
              const el = candidates.find((c) =>
                lower(c.name) === key || lower(c.id) === key || lower(c.placeholder) === key || lower(c.getAttribute('aria-label')) === key
              ) || candidates.find((c) => {
                const label = c.closest('label');
                return label && lower(label.textContent).includes(key);
              });
              if (!el) { missed.push(f.field); continue; }
              const outcome = writeValue(el, f.value);
              if (!outcome.ok) { missed.push(f.field); continue; }
              filled++;
              const form = el.form || el.closest('form');
              if (form) targets.add(form);
            }
            let submitted = false;
            let submitError = '';
            if (${JSON.stringify(submit)}) {
              if (targets.size === 0) submitError = 'the filled fields are not inside a form';
              else if (targets.size > 1) submitError = 'the filled fields belong to ' + targets.size + ' different forms, so the target is ambiguous';
              else {
                const form = [...targets][0];
                const btn = [form.querySelector('button[type=submit]'), form.querySelector('input[type=submit]')].find(Boolean);
                try {
                  if (btn) { btn.click(); submitted = true; }
                  else if (typeof form.requestSubmit === 'function') { form.requestSubmit(); submitted = true; }
                  else submitError = 'the target form has no submit control';
                } catch (cause) { submitError = String((cause && cause.message) || cause); }
              }
            }
            return { filled, submitted, missed, submitError };
          })()
        `,
        returnByValue: true,
      })
      const value = result.result?.value as { filled?: number; submitted?: boolean; missed?: string[]; submitError?: string } | undefined
      const filled = value?.filled ?? 0
      const missed = Array.isArray(value?.missed) ? value!.missed! : []
      if (filled === 0) {
        throw browserError('not-found', `browser: no matching form fields found${missed.length === 0 ? '' : ` (unmatched: ${missed.join(', ')})`}`)
      }
      if (submit && value?.submitted !== true) {
        // 提交失败必须显式：旧实现静默 submitted=false，模型以为已经提交，
        // 后续动作全都基于一个没发生的页面跳转。
        throw browserError('not-found', `browser: filled ${filled} field(s) but did not submit — ${value?.submitError || 'unknown reason'}; click the real submit control with browser_click instead`)
      }
      return { filled, submitted: value?.submitted === true, missed }
    }, signal)
    this.record('browser_fill_form', resolved, `fill form (${outcome.filled} fields${outcome.missed.length > 0 ? `, unmatched: ${outcome.missed.join(', ')}` : ''}${outcome.submitted ? ', submitted' : ''})`)
    return outcome
  }

  /** Upload files through CDP (no native dialog). Every path is vetted
   * against the allowed directories (downloads dir + session workspace) —
   * arbitrary local file uploads are refused. */
  async uploadFile(tabId: number, paths: string[], signal?: AbortSignal, allowedDirs?: string[]): Promise<{ uploaded: number }> {
    if (allowedDirs === undefined || allowedDirs.length === 0) {
      throw browserError('policy', 'browser: upload_file is not allowed in this deployment (no allowed directories)')
    }
    if (!Array.isArray(paths) || paths.length === 0) {
      throw browserError('policy', 'browser: upload_file requires at least one path')
    }
    const vetted = paths.map((p) => this.assertAllowedUploadPath(p, allowedDirs))
    const resolved = this.resolveTab(tabId)
    const outcome = await this.agentRun('browser_upload_file', async () => {
      const tab = this.tab(resolved)
      const doc = await tab.cdp.send<{ root?: { nodeId?: number } }>('DOM.getDocument')
      const rootId = doc.root?.nodeId
      if (rootId === undefined) throw browserError('not-found', 'browser: cannot resolve document')
      const query = await tab.cdp.send<{ nodeId?: number }>('DOM.querySelector', { nodeId: rootId, selector: 'input[type=file]' })
      if (query.nodeId === undefined) throw browserError('not-found', 'browser: no file input found on this page')
      await tab.cdp.send('DOM.setFileInputFiles', { nodeId: query.nodeId, files: vetted })
      return { uploaded: vetted.length }
    }, signal)
    this.record('browser_upload_file', resolved, `upload ${vetted.length} file(s)`)
    return outcome
  }

  /** Canonicalize + verify one upload path against the allowed directories
   * (realpath when the file exists; symlinks are resolved). */
  private assertAllowedUploadPath(path: string, allowedDirs: string[]): string {
    if (typeof path !== 'string' || path.trim() === '') {
      throw browserError('policy', 'browser: upload path must be a non-empty string')
    }
    let absolute: string
    try {
      absolute = realpathSync(path)
    } catch {
      absolute = resolve(path)
    }
    for (const dir of allowedDirs) {
      if (typeof dir !== 'string' || dir.trim() === '') continue
      let dirAbs: string
      try {
        dirAbs = realpathSync(dir)
      } catch {
        dirAbs = resolve(dir)
      }
      if (absolute === dirAbs || absolute.startsWith(dirAbs + sep)) return absolute
    }
    throw browserError('policy', 'browser: upload path is outside the allowed directories (downloads dir + session workspace)')
  }

  /** Wait for a page condition. */
  async waitFor(tabId: number, options: WaitForOptions, signal?: AbortSignal): Promise<{ ok: boolean; reason: string }> {
    const resolved = this.resolveTab(tabId)
    return await this.agentRun('browser_wait_for', async () => {
      // Compute the condition deadline INSIDE the critical section: whatever
      // time the mutex/gate took is already spent budget.
      const configured = options.timeoutMs ?? Math.min(this.options.timeoutMs, 30_000)
      const remaining = options.deadlineAt === undefined ? Number.POSITIVE_INFINITY : options.deadlineAt - Date.now()
      const timeout = Math.min(configured, 120_000, Math.max(0, remaining))
      const deadline = Date.now() + timeout
      const tab = this.tab(resolved)
      const startUrl = tab.url
      let lastReason = 'timeout'
      // The condition spec travels as a CDP *argument*: the page-side source is
      // the constant WAIT_FOR_FUNCTION_DECLARATION, so selector/text/URL values
      // can never become page-side syntax (they are data, not code).
      const payload = waitForPayload(options, startUrl)
      while (Date.now() < deadline) {
        if (signal !== undefined && signal.aborted) throw browserError('interrupted', 'browser: wait aborted')
        this.assertAgentStillAllowed('browser_wait_for')
        try {
          const state = await tab.cdp.send<EvalResult>('Runtime.callFunctionOn', {
            functionDeclaration: WAIT_FOR_FUNCTION_DECLARATION,
            // Re-resolved every poll: a navigation destroys the old object (and
            // with it the id), which is exactly the state `url-change` waits on.
            objectId: await pageGlobalObjectId(tab),
            arguments: [{ value: payload }],
            returnByValue: true,
          })
          if (state.result?.value === true) {
            this.updateTabState(tab)
            return { ok: true, reason: options.condition }
          }
          lastReason = `condition not met (${options.condition})`
        } catch (cause) {
          // Keep the underlying failure: a navigation destroys the execution
          // context mid-poll, and swallowing that into a constant "page not
          // ready" made a real-device timeout indistinguishable from "the URL
          // never changed" (report 2026-09-12). F-2: no cut here — the reason is
          // capped AFTER the redaction below, so a credential straddling the cap
          // cannot survive as a head fragment.
          const message = cause instanceof Error ? cause.message : String(cause)
          lastReason = `page not ready: ${message}`
        }
        await sleep(Math.min(250, Math.max(50, deadline - Date.now())))
      }
      this.updateTabState(tab)
      const urlChanged = tab.url !== startUrl ? 'page navigated' : lastReason
      // R-1: the reason is the tool's return value; a CDP failure text can carry
      // the current URL, so the whole string goes through the text redactor.
      // R-6: plus this tab's value set — a page-chosen URL (`?pw=<value>`) is
      // not credential-shaped, so the key vocabulary alone would let it through.
      // F-2: the cap runs after BOTH redaction passes.
      const reason = redactFilledSecretsText(tab, stripSensitiveText(`wait_for ${options.condition} timed out — ${urlChanged}`), { verbatim: true })
      return { ok: false, reason: reason.slice(0, WAIT_FOR_REASON_LIMIT) }
    }, signal)
  }

  /** Page-side wait predicate source. Constant by construction — the values
   * arrive through `Runtime.callFunctionOn` `arguments` (see `waitPayload`). */
  static waitFunctionDeclaration(): string {
    return WAIT_FOR_FUNCTION_DECLARATION
  }

  /** Wait-for payload builder (pure, testable). */
  static waitPayload(options: WaitForOptions, startUrl = ''): WaitForPayload {
    return waitForPayload(options, startUrl)
  }

  // -------------------------------------------------------------- user gate

  /**
   * Cooperative abort checkpoint for long-running operations whose work is
   * already inside the global mutex: `PoolMutex.run` only gates operations
   * BEFORE `work()` starts, so a user takeover must also be observed between
   * the steps of an in-flight operation. Throwing `window-controlled` from
   * here gives the model an actionable failure instead of letting it keep
   * clicking/typing while the user is operating the same page.
   * @param operation - tool name for the error text.
   */
  private assertAgentStillAllowed(operation: string): void {
    if (!this.pool.controlled) return
    throw browserError('window-controlled', hostCopy(
      this.locale(),
      `browser: 用户已接管浏览器，AI 操作已中止（${operation}）`,
      `browser: the user took over the browser — AI action aborted (${operation})`,
    ))
  }

  /** Stop pending page loads when the user takes over (navigation is not cancellable via a JS signal). */
  private stopPendingLoads(): void {
    for (const tab of this.tabs.values()) {
      try { tab.view.webContents.stop?.() } catch { /* teardown never throws */ }
    }
  }

  /** User takeover / release (whole window). Actor: 'user' on shell/button
   * paths, 'ai' for the browser_takeover/browser_release tools. No-op changes
   * are not recorded (the gate is idempotent). */
  setUserControl(active: boolean, actor: RecordActor = 'user'): void {
    const was = this.pool.controlled
    this.pool.setUserControl(active)
    if (was === this.pool.controlled) return
    if (active) {
      this.stopPendingLoads()
      this.record('browser_takeover', 0, 'user took over the browser', false, actor)
    } else {
      // 交还控制权 = 等待结束：清掉"AI 被挡住"的提示状态（2026-09-16）。
      this.gateBlock = null
      this.record('browser_release', 0, 'user released browser control', false, actor)
    }
  }

  // ------------------------------------------------------------- data (P1)

  addBookmark(tabId: number, title?: string, actor: RecordActor = 'ai'): { id: number; url: string; title: string } {
    const resolved = this.resolveTab(tabId)
    const tab = this.tab(resolved)
    // R-5: bookmarks are persisted AND handed back to the model
    // (`browser_bookmarks_list`), so the value set applies to both fields.
    const entry = this.store.addBookmark({
      url: redactFilledSecretsText(tab, tab.url, { verbatim: true }),
      title: redactFilledSecretsText(tab, title ?? tab.title),
      actor,
      group: '',
    })
    this.record('browser_bookmarks_add', resolved, `bookmark ${entry.title}`, false, actor)
    return { id: entry.id, url: entry.url, title: entry.title }
  }

  listBookmarks(filter: { q?: string | undefined; limit?: number | undefined } = {}): ReturnType<BrowserStore['queryBookmarks']> {
    return this.store.queryBookmarks(filter)
  }

  removeBookmark(id: number): boolean {
    return this.store.removeBookmark(id)
  }

  history(filter: { q?: string | undefined; limit?: number | undefined; group?: string | undefined } = {}): HistoryEntry[] {
    const { group, ...rest } = filter
    return this.store.queryHistory({ ...rest, group: group !== undefined && group !== '' ? group : undefined })
  }

  downloads(filter: { status?: DownloadEntry['status'] | undefined; limit?: number | undefined } = {}): DownloadEntry[] {
    // R-5 (2026-09-13): a download carries no tab identity (a session-level
    // Electron event), so its value set is the union of the live tabs' sets —
    // the tab that received the credential is live when it triggers a download.
    // `fileName` was already redacted at the write path; `path` is the real
    // on-disk handle (`downloads_open`, the file tools) and stays truthful in
    // the store, so the model-facing projection swaps in the redacted display
    // path recorded when the entry was written.
    const secrets = this.liveSecrets()
    return this.store.queryDownloads(filter).map((entry) => {
      const displayPath = this.downloadDisplayPaths.get(entry.id)
      const projected: DownloadEntry = displayPath === undefined ? entry : { ...entry, path: displayPath }
      if (secrets.length === 0) return projected
      return {
        ...projected,
        fileName: redactSecretsText(secrets, projected.fileName, { verbatim: true }),
        path: redactSecretsText(secrets, projected.path, { verbatim: true }),
      }
    })
  }

  removeDownload(id: number): boolean {
    return this.store.removeDownload(id)
  }

  /** Open a downloaded file with the OS default handler (downloads viewer). */
  async openDownloadPath(id: number): Promise<{ ok: boolean; error?: string }> {
    const entry = this.store.queryDownloads({ limit: 500 }).find((d) => d.id === id)
    if (entry === undefined) throw browserError('not-found', 'browser: unknown download')
    if (entry.path === '' || entry.status !== 'done') {
      throw browserError('not-found', 'browser: this download has no finished file to open')
    }
    const result = await this.adapter.openPath(entry.path)
    // R-6: attribute the op to the live tab (it used to be tab 0, which the op
    // log cannot value-scrub) — the summary embeds the real path, which carries
    // the download name.
    this.record('browser_download_open', this.pool.activeTab ?? 0, `open download: ${entry.path}`)
    return result.error === undefined ? { ok: true } : { ok: false, error: result.error }
  }

  /** Download recorder adapter for guard events.
   *
   * R-5 (2026-09-13): the name comes from `Content-Disposition` or the URL
   * basename, and a page can pick BOTH (`<a download=pw + '.txt'>`) — no
   * key-shaped rule can see a value in it, so the live tabs' value set is
   * applied at the write path (the store keeps the redacted name; the response
   * headers are not a model-facing exit). `path` must stay the real handle for
   * `downloads_open`, so its redacted variant is remembered separately and used
   * by the model-facing projection (`runtime.downloads`). */
  private downloadRecorder(): { add: (entry: Omit<DownloadEntry, 'id' | 'createdAt'>) => number; update: (id: number, patch: Partial<Pick<DownloadEntry, 'status' | 'path' | 'size'>>) => void } {
    return {
      add: (entry) => {
        const secrets = this.liveSecrets()
        const record = this.store.addDownload(secrets.length === 0 ? entry : {
          ...entry,
          url: redactSecretsText(secrets, entry.url, { verbatim: true }),
          fileName: redactSecretsText(secrets, entry.fileName, { verbatim: true }),
        })
        if (entry.path !== '') this.rememberDownloadPath(record.id, secrets, entry.path)
        return record.id
      },
      update: (id, patch) => {
        if (patch.path !== undefined && patch.path !== '') this.rememberDownloadPath(id, this.liveSecrets(), patch.path)
        this.store.updateDownload(id, patch)
      },
    }
  }

  /** Union of the injected-value sets (downloads/bookmarks have no single owning
   * tab). R7 (2026-09-13): the origin records are included, so the union does not
   * silently shrink when the tab that received the credential is closed while a
   * sibling tab on that origin (or a later download) still needs the scrubbing.
   * Empty when nothing was injected in this browser. */
  private liveSecrets(): string[] {
    const out: string[] = []
    const add = (secret: string): void => {
      if (secret !== '' && !out.includes(secret)) out.push(secret)
    }
    for (const record of this.credentialOrigins.values()) {
      for (const secret of record.secrets) add(secret)
    }
    for (const tab of this.tabs.values()) {
      for (const secret of tab.filledSecrets) add(secret)
    }
    return out
  }

  /** Remember the redacted display path of a download (bounded; the store keeps
   * the truthful handle). */
  private rememberDownloadPath(id: number, secrets: readonly string[], path: string): void {
    if (secrets.length === 0) return
    const redacted = redactSecretsText(secrets, path, { verbatim: true })
    if (redacted === path) return
    this.downloadDisplayPaths.set(id, redacted)
    if (this.downloadDisplayPaths.size > DOWNLOAD_DISPLAY_PATH_LIMIT) {
      const oldest = this.downloadDisplayPaths.keys().next()
      if (oldest.done !== true) this.downloadDisplayPaths.delete(oldest.value)
    }
  }

  async credentialsList(): Promise<Array<{ id: string; username?: string }>> {
    if (this.credentials === undefined) return []
    const list = (this.credentials as CredentialResolver & { list?: () => Promise<Array<{ id: string; username?: string }>> }).list
    return list !== undefined ? await list() : []
  }

  /**
   * 分区初始化：确保该分区的权限守卫已装（§16.1：归属 = 分区初始化）。
   *
   * 幂等，所以调用点可以多、可以重复 —— "漏一个入口"这个 bug 类因此不存在。
   * 应用窗口宿主也走同一条（它有自己的 session 注册面，见 wasm-apps-host 的适配器）。
   * @param session - 目标 session。
   */
  ensurePartitionGuard(session: NativeSession): void {
    ensureSessionGuard(session)
  }

  /**
   * Resolve the Electron session of a partition **without creating a view**
   * (adapter `getSession`, optional in test/non-Electron adapters ⇒ undefined).
   *
   * Exists so the plugin can install the partition permission guard at
   * plugin-boot (before any tab exists) without reaching for `require('electron')`
   * itself — the adapter is the only Electron seam (2026-09-21: this replaced the
   * cookie-mirroring function, which used to be the boot-time guard owner).
   * @param partition - partition name (`persist:agent-browser-<user>`).
   * @returns the session, or undefined when the host cannot resolve one.
   */
  sessionForPartition(partition: string): NativeSession | undefined {
    return this.adapter.getSession?.(partition)
  }

  /** Trigger a programmatic download of a URL. */
  async downloadUrl(url: string, signal?: AbortSignal): Promise<void> {
    if (!this.navigationAllowed(url)) {
      throw browserError('navigation-blocked', `browser: download denied — ${stripSensitiveUrl(url).slice(0, 200)}`)
    }
    const active = this.pool.activeTab
    if (active === undefined) throw browserError('not-found', 'browser: no tab open in the browser')
    await this.agentRun('browser_download', async () => {
      const tab = this.tab(active)
      tab.view.webContents.downloadURL(url)
      this.store.addHistory({
        // FIX-06: the summary title embeds the (possibly signed) URL verbatim;
        // redact it here so it never depends on the store having to clean up.
        // R-5: plus the tab's value set, same as the navigate path.
        time: Date.now(),
        url: redactFilledSecretsText(tab, url, { verbatim: true }),
        title: redactFilledSecretsText(tab, `download: ${stripSensitiveUrl(url)}`, { verbatim: true }),
        actor: 'ai',
        group: '',
      } as Omit<HistoryEntry, 'seq'>)
    }, signal)
  }

  // --------------------------------------------------------------- data ops

  async clearData(all = false): Promise<void> {
    const seen = new Set<NativeSession>()
    for (const tab of this.tabs.values()) {
      const session = tab.view.webContents.session
      if (seen.has(session)) continue
      seen.add(session)
      await this.clearSessionData(session, all)
    }
    if (seen.size === 0) {
      // No tab has materialized yet (lazy restore / never opened): the
      // partition still holds cookies+storage from previous runs, so a silent
      // no-op here is a lie (P2-28). Clear the known partition through the
      // adapter when it can resolve a session; otherwise fail loudly.
      const session = this.adapter.getSession?.(this.partition)
      if (session === undefined) {
        throw browserError('not-found', 'browser: no browser session yet — open a tab first, then clear data')
      }
      seen.add(session)
      await this.clearSessionData(session, all)
    }
    this.record('browser_clear_data', 0, hostCopy(
      this.locale(),
      `clear browsing data (${all ? '全部' : '站点'})`,
      `clear browsing data (${all ? 'all' : 'this site'})`,
    ))
  }

  private async clearSessionData(session: NativeSession, all: boolean): Promise<void> {
    if (all) {
      await session.clearStorageData()
      await session.clearCache()
      return
    }
    await session.clearStorageData({ storages: ['localstorage', 'cachestorage', 'indexdb', 'websql', 'serviceworkers'] })
    await session.clearCache()
  }

  // --------------------------------------------------------------- teardown

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.materializeEpoch++
    this.pendingLedgerTabs = []
    for (const id of [...this.tabs.keys()]) {
      // Releasing the per-tab disposers (permission guard + ref-counted
      // download guard) matters: a dropped ref-count keeps the download
      // listener installed forever (P2-28).
      this.releaseTabDisposers(id)
      const tab = this.tabs.get(id)
      if (tab !== undefined) {
        try {
          tab.cdp.detach()
          tab.view.destroy()
        } catch {
          // Teardown must never throw.
        }
      }
    }
    this.tabs.clear()
    this.windowResizeDisposer?.()
    this.windowClosedDisposer?.()
    this.windowFocusDisposer?.()
    this.windowFocusDisposer = null
    if (this.window !== null && !this.window.isDestroyed()) this.window.close()
    this.window = null
    this.overlay = null
    this.pool.dispose()
    this.listeners.clear()
  }
}

/** Everything the page-side wait predicate needs, as **data**.
 *
 * The six conditions are evaluated by `WAIT_FOR_FUNCTION_DECLARATION` inside the
 * page, with this object passed through CDP `Runtime.callFunctionOn`
 * `arguments`. Nothing here is ever concatenated into page-side source: a
 * selector/text/URL value can only ever be a string value, never a syntax node
 * (`js/bad-code-sanitization`). */
export interface WaitForPayload {
  condition: WaitForOptions['condition']
  /** `null` when the condition has no selector — `querySelector(null)` yields null. */
  selector: string | null
  text: string | null
  startUrl: string
  networkIdleMs: number
}

/** The page-side wait predicate: a **constant** function body.
 *
 * `payload.selector` / `payload.text` / `payload.startUrl` are looked up as
 * values only; the source text of this function never changes with the input,
 * so there is no code-construction point at all. Kept byte-stable so tests can
 * evaluate it under `node:vm` together with `waitForPayload`.
 *
 * DO NOT interpolate anything into this string: an interpolated
 * selector/text/URL would turn the AI's tool input back into page-side syntax
 * (`js/bad-code-sanitization`, alerts #40/#41/#43/#44). Add a field to
 * `WaitForPayload` instead. */
const WAIT_FOR_FUNCTION_DECLARATION = `function (payload) {
  switch (payload.condition) {
    case 'element-present': {
      const el = document.querySelector(payload.selector);
      return el !== null;
    }
    case 'element-visible': {
      const el = document.querySelector(payload.selector);
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    }
    case 'text-appear':
      return (document.body ? document.body.innerText : '').includes(payload.text);
    case 'url-change':
      // TRUE only when the page actually navigated away from the captured URL.
      return location.href !== payload.startUrl;
    case 'network-idle': {
      // TRUE once the last resource has been quiet for at least
      // payload.networkIdleMs (or the document is already complete with no
      // resource entries at all).
      const rs = performance.getEntriesByType('resource');
      if (rs.length === 0) return document.readyState === 'complete';
      const last = rs[rs.length - 1];
      return performance.now() - (last.responseEnd || 0) > payload.networkIdleMs;
    }
    case 'settled':
      return document.readyState === 'complete';
    default:
      return false;
  }
}`

/** Build the wait-for payload (pure function). The `startUrl` is the URL
 * captured when the wait began — `url-change` compares against it so the
 * condition only succeeds on an ACTUAL navigation. */
function waitForPayload(options: WaitForOptions, startUrl = ''): WaitForPayload {
  return {
    condition: options.condition,
    selector: options.selector ?? null,
    text: options.text ?? null,
    startUrl,
    networkIdleMs: NETWORK_IDLE_TICK_MS,
  }
}

/** `objectId` of the page's global object, so the constant predicate can run in
 * the page's own world via `Runtime.callFunctionOn`. */
async function pageGlobalObjectId(tab: BrowserTab): Promise<string> {
  const global = await tab.cdp.send<{ result?: { objectId?: string } }>('Runtime.evaluate', {
    expression: 'globalThis',
  })
  const objectId = global.result?.objectId
  if (objectId === undefined) {
    throw browserError('not-found', 'browser: page has no global object to evaluate against')
  }
  return objectId
}

const NETWORK_IDLE_TICK_MS = 800

/**
 * Resolve `attempt`, or reject once `budgetMs` elapses without it settling.
 *
 * `webContents.capturePage()` can stay pending forever on a window with no viz
 * surface rather than rejecting, so the caller's rejection-only fallback was
 * unreachable and the tool reported a bare timeout. Losing the race is not a
 * failure of the abandoned attempt: it keeps a rejection handler so a late
 * failure can never surface as an unhandled rejection.
 *
 * @param attempt - the capture already in flight.
 * @param budgetMs - how long it may take before the caller falls back.
 * @returns the capture result when it settles in time.
 */
async function withScreenshotBudget(attempt: Promise<string>, budgetMs: number): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      attempt,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { reject(new Error(`capture did not settle within ${budgetMs}ms`)) }, budgetMs)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    attempt.catch(() => { /* superseded by the renderer-side fallback */ })
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms))
    timer.unref?.()
  })
}

/** Common key → CDP `code`. */
const KEY_CODES: Record<string, string> = {
  Enter: 'Enter',
  Tab: 'Tab',
  Escape: 'Escape',
  Backspace: 'Backspace',
  Delete: 'Delete',
  ArrowUp: 'ArrowUp',
  ArrowDown: 'ArrowDown',
  ArrowLeft: 'ArrowLeft',
  ArrowRight: 'ArrowRight',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ' ': 'Space',
}

/** Common key → Windows virtual key code. */
const KEY_VK: Record<string, number> = {
  Enter: 13,
  Tab: 9,
  Escape: 27,
  Backspace: 8,
  Delete: 46,
  ArrowUp: 38,
  ArrowDown: 40,
  ArrowLeft: 37,
  ArrowRight: 39,
  Home: 36,
  End: 35,
  PageUp: 33,
  PageDown: 34,
  ' ': 32,
}

const MASK = '****'

/**
 * Model-facing refusals of the credential-activity window (R-4, 2026-09-13).
 *
 * Exported so the regression tests and the real-machine probes assert on the
 * shipped string instead of a copy of it, and so the release notes can quote
 * what a user sees. Both name the tool, the cause and the way out.
 */
export const CREDENTIAL_WINDOW_EVAL_REFUSAL = 'browser: browser_eval is paused on this tab — credentials were injected here through browser_fill_credentials and are still in the page, so any script read-back could hand them to the model (a transformed value, a frame realm or an image is still a channel). Submit the form or navigate the tab to leave the credential window; browser_eval resumes automatically on the next document.'

/** Screenshot half of the window refusal (the page can render a credential as
 * text or a barcode, which no image redaction can undo). */
export const CREDENTIAL_WINDOW_SCREENSHOT_REFUSAL = 'browser: browser_screenshot is paused on this tab — credentials were injected here through browser_fill_credentials and are still in the page, and a page can render them as text or a barcode that no image redaction can undo. Submit the form or navigate the tab to leave the credential window; screenshots resume automatically on the next document.'

/** Redact credential-shaped parts of a browser op-log summary. Delegates to
 * `store.stripSensitiveText` (userinfo + sensitive query parameters + fragment
 * pairs) so the same URL never reads `****` in history and cleartext in the op
 * log / activity panel (P1-5, and FIX-06 for titles). The scanner used to live
 * here as a second copy; it now has exactly one implementation. */
function maskBrowserSummary(summary: string): string {
  return stripSensitiveText(summary)
}

/**
 * Shortest injected secret that may be redacted as a **substring** of a longer
 * text (R-3, 2026-09-13).
 *
 * Below this length a bare `includes()` match is not evidence of a credential:
 * `abc123` is also an order id, a SKU, a build number. The independent
 * re-verification found the page text `order abc123 confirmed` rewritten to
 * `order **** confirmed`, i.e. the redactor was *corrupting facts* the model
 * needs in order to act — a false positive that is worse than the leak it
 * prevents, because the leak (a short password echoed in prose) is ambiguous
 * by construction while the corruption is certain.
 *
 * A short secret is therefore still redacted in the shapes that are not
 * ambiguous — the whole field, an assignment (`password=abc123`), a JSON pair
 * (`"pw":"abc123"`) and a keyed wrapper (`token=[abc123]`) — and left alone in
 * prose, INCLUDING prose that happens to bracket or quote it (`Item (abc123)
 * shipped`, `Ref "abc123" noted`: R-4 closed that last residual by requiring a
 * credential key name in front of a bracket/quote before it counts as a value).
 */
const MIN_EMBEDDED_SECRET_LENGTH = 8

/** Characters that make a short occurrence look like a *value* on its left, on
 * their own: `key=value`, `key: value`, `user:pass@host`. */
const VALUE_LEFT_STRONG = new Set(['=', ':'])
/** Characters that only *suggest* a value position: brackets, quotes and
 * separators. Prose uses them too (`Item (abc123) shipped`, `Ref "abc123"
 * noted`), so an occurrence wrapped in one of them is masked only when a
 * credential KEY name sits in the fragment in front of it (R-4, 2026-09-13). */
const VALUE_LEFT_WEAK = new Set(['(', '[', '{', ',', '"', "'"])
/** Characters that make it look like a value on its right. `@` covers
 * userinfo (`user:abc123@host`) — the left-hand `:` alone is not enough — and
 * the whitespace characters end a value the way a page's own markup does
 * (`password=abc123\n…`: without them the newline made the occurrence look like
 * prose and the credential was returned verbatim). */
const VALUE_RIGHT = new Set(['"', "'", ')', ']', '}', ',', ';', '&', '@', '\n', '\r', '\t'])
/** Structural characters that end the backward scan for a key name: the
 * fragment in front of the value cannot cross them. `=`/`:` are deliberately
 * absent — they are the separator the key name sits before. */
const KEY_STOP = new Set([';', '{', '}', '<', '>', ',', '(', ')', '[', ']', '"', "'", '\n', '\r', '|'])
/** How far back (characters) a wrapped occurrence looks for that key name. */
const KEY_LOOKBACK = 48

/** Characters skipped when looking for the delimiter next to an occurrence:
 * whitespace, and the backslash that JSON string escaping puts in front of a
 * quote (`serializeEvalResult` hands the redactor `"{\"pw\":\"abc123\"}"`, where
 * the quote next to the value is escaped). */
function isSkippable(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\\'
}

/** Nearest significant character index walking left from `from`, if any. */
function nearestLeftIndex(text: string, from: number): number {
  for (let i = from; i >= 0; i--) {
    if (!isSkippable(text[i]!)) return i
  }
  return -1
}

/**
 * Nearest significant character walking right from `from`, if any.
 *
 * Only spaces (alignment before a delimiter) and the JSON string escape are
 * skipped — NOT newlines: a line break is where a page's value ends, and
 * skipping it made `password=abc123\nnext line` read as prose and hand the
 * credential back verbatim (real-machine `credential-window-probe.mjs`, R-3).
 */
function nearestRight(text: string, from: number): string | undefined {
  for (let i = from; i < text.length; i++) {
    const ch = text[i]!
    if (ch !== ' ' && ch !== '\\') return ch
  }
  return undefined
}

/** True when a credential KEY name (`password`, `token`, `sid`, …) sits in the
 * fragment immediately in front of the delimiter at `delimiterIndex`. */
function keyVocabularyBefore(text: string, delimiterIndex: number): boolean {
  let start = delimiterIndex
  const floor = Math.max(0, delimiterIndex - KEY_LOOKBACK)
  while (start > floor && !KEY_STOP.has(text[start - 1]!)) start--
  return start < delimiterIndex && SENSITIVE_KEY_PATTERN.test(text.slice(start, delimiterIndex))
}

/**
 * R-8 (2026-09-15 审计 P1，安全)：散文里紧挨在值前面的**凭据键名**判定。
 *
 * 现场：`your password abc123 is wrong` 原样回给了模型。旧口径只认"值位"——
 * 左邻必须是 `=`/`:`，或是被括号/引号包住且前面有键名；散文里 `password` 与
 * `abc123` 之间是一个空格、`abc123` 右边是 `i`（is），两个条件都不成立，于是
 * 短口令在散文语境里**完全不擦除**。而"页面把用户刚输入的口令回显在一句话里"
 * （`your password … is weak`）恰恰是最常见的泄漏形态。
 *
 * 与 {@link keyVocabularyBefore}（URL 键名表，含 `key`/`code`/`sid` 这类普通英文
 * 词）不同，这里用散文强凭据词表 {@link isExactProseSensitiveKey}：散文字符串里
 * `keyboard`/`order code` 这类片段不能把普通文本改坏（2026-09-15 另一条审计结论，
 * 见 sensitive.ts 的 PROSE_SENSITIVE_TERMS）。`order abc123 confirmed` 因此保持
 * 原样，而 `your password abc123 is wrong` 会被擦除。
 *
 * 扫描边界仍是 {@link KEY_STOP}（不含空格，好让"键名 + 空格 + 值"连起来），
 * 括号/引号处停下——`Item (abc123) shipped`、`Ref "abc123" noted` 不误伤（R-4）。
 */
function proseKeyBefore(text: string, at: number): boolean {
  let start = at
  const floor = Math.max(0, at - KEY_LOOKBACK)
  while (start > floor && !KEY_STOP.has(text[start - 1]!)) start--
  return start < at && isExactProseSensitiveKey(text.slice(start, at))
}

/**
 * Redact the occurrences of a SHORT secret that are *value-shaped*:
 * `password=abc123`, `"pw":"abc123"`, `user:abc123@host`, `?token=abc123&x=1`,
 * `token=[abc123]`. Prose keeps its text (`order abc123 confirmed`,
 * `Item (abc123) shipped`, `Ref "abc123" noted`), and so does a longer word
 * containing the value (`xabc123y`).
 *
 * R-4 (2026-09-13) splits the left context in two, because the earlier single
 * delimiter set rewrote facts: parentheses and quotes are punctuation in prose,
 * so they only count as a value position when a credential key name precedes
 * them. `=`/`:` stay unconditional — that shape is an assignment.
 */
function maskShortSecretOccurrences(text: string, secret: string): string {
  const parts: string[] = []
  let from = 0
  for (;;) {
    const at = text.indexOf(secret, from)
    if (at < 0) {
      parts.push(text.slice(from))
      return parts.join('')
    }
    parts.push(text.slice(from, at), isValueShaped(text, at, secret.length) ? MASK : secret)
    from = at + secret.length
  }
}

/**
 * Verbatim-context variant for SHORT secrets (R7, 2026-09-13): a URL, path or
 * file name has no prose, so a short value only counts when it occupies a whole
 * token — bounded by separators or the ends of the string. `/test` and
 * `?pw=test&x=1` are masked; `/test-report` and `mytest.com` are left alone
 * (the previous whole-substring rule rewrote unrelated pages once the value set
 * became tab-lifetime).
 * @param text - URL / path / file-name-ish string.
 * @param secret - injected value shorter than the embedded-secret threshold.
 * @returns text with whole-token occurrences masked.
 */
function maskShortSecretTokens(text: string, secret: string): string {
  const isWord = (ch: string | undefined): boolean => ch !== undefined && /[A-Za-z0-9_.-]/u.test(ch)
  const parts: string[] = []
  let from = 0
  for (;;) {
    const at = text.indexOf(secret, from)
    if (at < 0) {
      parts.push(text.slice(from))
      return parts.join('')
    }
    const before = at === 0 ? undefined : text[at - 1]
    const after = at + secret.length >= text.length ? undefined : text[at + secret.length]
    const wholeToken = !isWord(before) && !isWord(after)
    parts.push(text.slice(from, at), wholeToken ? MASK : secret)
    from = at + secret.length
  }
}

/** Is the occurrence at `at` sitting where a *value* would sit? */function isValueShaped(text: string, at: number, length: number): boolean {
  const leftIndex = at === 0 ? -1 : nearestLeftIndex(text, at - 1)
  const left = leftIndex < 0 ? undefined : text[leftIndex]!
  // R-5 (2026-09-13): an assignment delimiter is a value position on its own,
  // whatever character follows the occurrence. The R-4 rule checked the RIGHT
  // character first, and internal `innerText` folds the page's newline into a
  // space — so `password=abc123\nnext line` arrived as `password=abc123 next
  // line`, the character after the short password was an ordinary `n`, and the
  // credential was returned verbatim (real-machine probe E, R-5). A longer word
  // that merely starts with the value (`x=abc123y`) is over-masked in the same
  // step: fail-closed, and the visible tail is recoverable from the page.
  if (left !== undefined && VALUE_LEFT_STRONG.has(left)) return true
  // R-8 (2026-09-15 审计 P1，安全)：**键名判定必须在"右侧必须是值结束符"之前**。
  // 旧顺序先看右邻字符，于是散文里的 `your password abc123 is wrong`（右邻是
  // `i`）在这里 return false，前面那个凭据键名根本没被咨询过 —— 短口令在散文
  // 语境里等于完全不擦除。键名从**未经跳空白**的位置 `at` 起算，好让
  // "键名 + 空格 + 值"的散文形态被识别；`order abc123 confirmed` 因 `order` 不是
  // 凭据键名而保持原样（散文词表，见 proseKeyBefore）。
  if (proseKeyBefore(text, at)) return true
  const right = at + length >= text.length ? undefined : nearestRight(text, at + length)
  if (right !== undefined && !VALUE_RIGHT.has(right)) return false
  if (left === undefined) return true
  if (!VALUE_LEFT_WEAK.has(left)) return false
  // A quote right after a separator is a value (`"pw":"abc123"`, `pw: "abc123"`).
  if (left === '"' || left === "'") {
    const before = nearestLeftIndex(text, leftIndex - 1)
    if (before >= 0 && VALUE_LEFT_STRONG.has(text[before]!)) return true
  }
  return keyVocabularyBefore(text, leftIndex)
}

/**
 * Value-level redaction of the secrets this tab received through
 * `fillCredentials` (P0-A depth layer, extended to `browser_eval` by FIX-03,
 * to `browser_get_text` and short-secret precision by R-1/R-3 on 2026-09-13,
 * re-scoped by the R-4 credential window and made TAB-scoped by R-5).
 *
 * Exact-value matching: a page string that merely *talks* about passwords is
 * untouched, while an injected secret can never leave through a snapshot or the
 * page text — no matter which probe/field/expression produced it. A text that is
 * a truncated head of a longer secret is redacted as a whole.
 *
 * F-2 (2026-09-13 round 2): R7 additionally guessed at head fragments sitting at
 * the tail of a text (`maskTruncatedSecretTail`: "the text ends with ≥8
 * characters that are a prefix of some injected value"). It did not require the
 * text to have been truncated at all, so with a password starting with a common
 * word (`Security123!`) the ordinary phrase `Privacy and Security` became
 * `Privacy and ****` — and, worse, the *persisted* history URL / op-log summary
 * / tab address `https://app.example/help/Security` became `/help/****` for the
 * rest of the session. That is not "less information", it is wrong information.
 * The guess is gone. Truncation is now always handled by ORDER instead: every
 * producer redacts the FULL text and only then applies its cap
 * (`extractSnapshot` / `extractText` / `serializeEvalResult` / the op-log
 * `record` summary), so no exit can produce a fragment.
 *
 * 2026-09-15 审计 P1（`>1024 的长凭据只剩头部`）——F-2 之后残留的那一个例外：
 * 快照探针在**页面侧**按 `ELEMENT_TEXT_CAP`（1 KiB）先切一刀，主机拿到的是切过的
 * 文本。旧注释断言"它的尾部落在 80 字符窗口之外，所以不是出口"——**这个断言是错的**：
 * 只要值在切点之前就开始（`Token: <900 字符的值头>…` 被切在第 1024 字符），值的
 * 头部就落在窗口内，而它既不是完整值也不是整段文本，任何值规则都认不出。
 * 现在由生产者把"这一刀确实切了"作为事实告诉本函数（
 * {@link RedactOptions.tailMayBeTruncated}，唯一来源是 `extractSnapshot`），
 * 只在这种情况下做尾部值头匹配——判据从"看起来像截断"变成"上游确实截断"。
 *
 * `verbatim: true` (R-5) is for strings that cannot be prose: a URL, a download
 * name/path, a file name. Short secrets used to be masked on EVERY occurrence
 * there — R7 (2026-09-13) narrowed that: the value set now lives for the whole
 * tab (R-6), so a 4-character secret replaced everywhere corrupted unrelated
 * pages (`/test-report` → `/****-report`). Length ≥
 * {@link MIN_EMBEDDED_SECRET_LENGTH} still replaces verbatim; shorter values go
 * through the same value-shaped rule as prose (`password=test` is masked,
 * a standalone `test` in a URL path is not). `verbatim` is kept as the callers'
 * intent marker for that long-value path.
 *
 * ONE implementation for every text funnel (`runtime.snapshot`,
 * `runtime.text`, `runtime.eval`'s result, the tab projection, history/ledger,
 * the op log, downloads). HONEST BOUNDARY: the match is verbatim — a page that
 * transforms the value (base64, reversed, character-split) renders something
 * this function cannot recognize; that residual is declared in the tool
 * descriptions and asserted by `tests/probes/r6-outlet-probe.mjs`.
 */
function redactFilledSecretsText(tab: BrowserTab, text: string, options: RedactOptions = {}): string {
  return redactSecretsText(tab.filledSecrets, text, options)
}

/** Options shared by the redaction funnels (module-internal shape). */
interface RedactOptions {
  /** Verbatim context (URL / path / file name) — see {@link redactSecretsText}. */
  verbatim?: boolean
  /**
   * The producer cut this text at its own cap, so it may end in the HEAD of a
   * value (2026-09-15 审计 P1). Only set by callers that really did cut
   * (`extractSnapshot`'s page-side `ELEMENT_TEXT_CAP`); never inferred.
   */
  tailMayBeTruncated?: boolean
}

/**
 * Length of the longest prefix of `secret` that is a SUFFIX of `text` (0 when
 * there is none) — how much of a value a cap would have left behind.
 *
 * Only consulted when the producer says the text was cut (see
 * {@link RedactOptions.tailMayBeTruncated}); guessing this from the text alone
 * is exactly what F-2 (2026-09-13) removed after it rewrote ordinary prose.
 * Bounded by construction: the caller's text is at most one element's page-side
 * cap (1 KiB), and the scan stops at the first match, skipping lengths whose
 * last character cannot match.
 */
function truncatedHeadLength(text: string, secret: string): number {
  const max = Math.min(text.length, secret.length - 1)
  if (max < MIN_EMBEDDED_SECRET_LENGTH) return 0
  const last = text.charCodeAt(text.length - 1)
  for (let k = max; k >= MIN_EMBEDDED_SECRET_LENGTH; k--) {
    if (secret.charCodeAt(k - 1) !== last) continue
    if (text.endsWith(secret.slice(0, k))) return k
  }
  return 0
}

/** Secrets-array core of {@link redactFilledSecretsText}: also usable for exits
 * with no single owning tab (a download is a session event, so its redaction set
 * is the union of the live tabs' sets). */
function redactSecretsText(secrets: readonly string[], text: string, options: RedactOptions = {}): string {
  if (secrets.length === 0) return text
  let out = text
  for (const secret of secrets) {
    if (secret === '') continue
    if (out === secret) { out = MASK; continue }
    // A truncated head of a longer secret is unambiguous once it is long
    // enough to not be an ordinary word.
    if (out.length >= MIN_EMBEDDED_SECRET_LENGTH && secret.startsWith(out)) { out = MASK; continue }
    // R7（2026-09-13）：verbatim 语境（URL / 路径 / 文件名）曾对**任意长度**的值整串
    // 替换，于是 4 字符口令 `test` 会把同 tab 之后所有页面的 `/test-report` 擦成
    // `/****-report`（值集合现在按 tab 生命周期保留，污染面被放大）。现在的口径：
    //  · ≥ MIN_EMBEDDED_SECRET_LENGTH：仍逐字整串替换（verbatim 与散文一致）；
    //  · <  MIN：verbatim 语境按**完整 token** 匹配（`/test`、`?pw=test&x=1` 会被擦，
    //    `/test-report` 不会），散文语境仍走"值形态"判定（`password=test` 会擦）。
    if (secret.length >= MIN_EMBEDDED_SECRET_LENGTH) {
      if (out.includes(secret)) out = out.split(secret).join(MASK)
      // F-2 (2026-09-13 round 2): no tail-fragment heuristic here **unless the
      // producer says it cut**. Guessing "the text ends with a prefix of a value,
      // therefore it must have been truncated" rewrote untruncated prose and
      // persisted the wrong fact (`/help/Security` → `/help/****`). Every host
      // funnel redacts before it cuts — the ONE exception is the snapshot probe's
      // page-side `ELEMENT_TEXT_CAP`, which cuts before the host can redact
      // (2026-09-15 审计 P1: a credential longer than that cap survived as a
      // plaintext head no rule could recognize). `extractSnapshot` marks exactly
      // that case, so the premise here is "the upstream really did cut", not
      // "this looks truncated".
      if (options.tailMayBeTruncated === true) {
        const head = truncatedHeadLength(out, secret)
        if (head >= MIN_EMBEDDED_SECRET_LENGTH) out = `${out.slice(0, out.length - head)}${MASK}`
      }
      continue
    }
    out = options.verbatim === true ? maskShortSecretTokens(out, secret) : maskShortSecretOccurrences(out, secret)
  }
  return out
}

/** Snapshot-shaped wrapper around {@link redactFilledSecretsText}: keeps the
 * element objects untouched when nothing matched. */
function redactFilledSecrets(tab: BrowserTab, elements: BrowserSnapshotElement[]): BrowserSnapshotElement[] {
  if (tab.filledSecrets.length === 0) return elements
  return elements.map((element) => {
    const text = redactFilledSecretsText(tab, element.text)
    return text === element.text ? element : { ...element, text }
  })
}

/** How long to wait for `Runtime.enable` to re-report existing execution
 * contexts, and the re-check interval (the enable response and the
 * `executionContextCreated` notifications race on the wire; Chromium reports
 * them alongside the reply, but a slow renderer can lag). */
const FRAME_CONTEXT_WAIT_MS = 500
const FRAME_CONTEXT_POLL_MS = 10

/** Extra settle time before refusing an index a dynamic page may still be
 * committing (a frame owner inserted a tick before its frame exists). */
const FRAME_INDEX_SETTLE_MS = 150

/** One entry of the DOM-ordered frame index (`frame: N`). */
interface ResolvedFrame {
  frameId: string
  url: string
  depth: number
  /** Flat CDP session of an out-of-process (cross-origin) frame. */
  sessionId?: string
  /** Default-world context of a same-process frame (absent for frame 0). */
  contextId?: number
}

/** Raw `Page.getFrameTree` node shape. */
interface RawFrameNode {
  frame?: { id?: string; url?: string; parentId?: string }
  childFrames?: RawFrameNode[]
}

/**
 * Execution context id of `frameId`'s DEFAULT world.
 *
 * `frame: 0` evaluates in the default world implicitly (no `contextId` is
 * passed) and `frame: N > 0` must mean exactly the same thing: the tool
 * advertises reading page-owned data ("SSR globals, hidden fields, datasets").
 * `Page.createIsolatedWorld` — used here before 2026-09-12 — shares the DOM but
 * NOT the page's JS globals by design, so `window.__APP__` silently read as
 * `undefined` in every frame but the main one (P1-7). The default-world context
 * of a frame can only be learned from `Runtime.executionContextCreated`
 * (`auxData.frameId` + `auxData.isDefault`), which `Runtime.enable` re-emits for
 * every existing context.
 *
 * `sessionId` (R-4, 2026-09-13): the flat CDP session that owns the frame. A
 * frame inside an out-of-process iframe has its execution contexts in THAT
 * session, so both the `Runtime.enable` that reports them and the events that
 * carry them are session-scoped. Without this the nested frame's context was
 * searched in the page session, found nowhere, and the whole index was refused.
 */
async function defaultWorldContextId(tab: BrowserTab, frameId: string, sessionId?: string): Promise<number | undefined> {
  const contexts: Array<{ id: number; frameId: string | undefined; isDefault: boolean; session: string | undefined }> = []
  const dispose = tab.cdp.on('Runtime.executionContextCreated', (params, eventSession) => {
    const context = (params as {
      context?: { id?: number; auxData?: { frameId?: string; isDefault?: boolean } }
    }).context
    if (context?.id === undefined) return
    contexts.push({
      id: context.id,
      frameId: context.auxData?.frameId,
      isDefault: context.auxData?.isDefault === true,
      session: eventSession,
    })
  })
  const call = sessionId === undefined ? {} : { sessionId }
  /**
   * A frame id is announced by the session that can reach the frame, so a
   * same-session context is the answer. An event that arrives with NO session
   * attribution (a transport that does not report flat-session ids) is accepted
   * only as a fallback — never preferred over an attributed one, which is how a
   * context belonging to another process would otherwise be adopted.
   */
  const pick = (): number | undefined => {
    const matches = (context: { frameId: string | undefined; isDefault: boolean }): boolean => context.frameId === frameId && context.isDefault
    if (sessionId === undefined) return contexts.find(matches)?.id
    const exact = contexts.find((context) => matches(context) && context.session === sessionId)
    if (exact !== undefined) return exact.id
    return contexts.find((context) => matches(context) && context.session === undefined)?.id
  }
  const look = async (): Promise<number | undefined> => {
    await tab.cdp.send('Runtime.enable', {}, call)
    const deadline = Date.now() + FRAME_CONTEXT_WAIT_MS
    for (;;) {
      const hit = pick()
      if (hit !== undefined) return hit
      if (Date.now() >= deadline) return undefined
      await new Promise((resolve) => setTimeout(resolve, FRAME_CONTEXT_POLL_MS))
    }
  }
  try {
    const first = await look()
    if (first !== undefined) return first
    // Chromium does NOT re-announce the existing execution contexts on a second
    // `Runtime.enable` — verified on Electron 43.4.0 with real CDP
    // (`tests/probes/frame-index-probe.mjs`): after
    // `Target.setAutoAttach({flatten:true})` (which the frame index needs for
    // out-of-process frames) the next `Runtime.enable` reported nothing, while
    // `Runtime.disable` + `Runtime.enable` reported every context again. Without
    // this cycle the R-4 resolver would refuse every same-process subframe of a
    // page that also has an OOPIF.
    contexts.length = 0
    try { await tab.cdp.send('Runtime.disable', {}, call) } catch { /* not enabled */ }
    return await look()
  } finally {
    dispose()
  }
}
