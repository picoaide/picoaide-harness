/**
 * Electron adapter seam for the embedded browser. The plugin must load under
 * plain Node (unit tests), so every Electron surface is reached through this
 * seam: type-only imports here, and the real adapter lazily requires
 * `electron` only when a browser actually starts.
 *
 * Window model (2026-08-20): the browser lives in its OWN BrowserWindow
 * (not embedded in the main window). The window loads a local control-shell
 * page (toolbar + tab strip); each tab is a WebContentsView over the content
 * area; an AI-control mask (another WebContentsView) overlays the content
 * area while the agent drives the browser. Closing the window (user X or the
 * shell's hide button) hides it — only the agent's `browser_close` truly
 * destroys it.
 * @module @picoaide/dsh-browser
 */

import { browserDefaultTitle } from './runtime.ts'
import { DEFAULT_HOST_LOCALE, type HostLocale } from '@picoaide/dsh-host-locale'
import type { CdpTransport } from './cdp.ts'

/** The minimal native view surface the browser runtime drives. */
export interface NativeView {
  /**
   * Stable partition name of this view's session (persistent browser storage).
   *
   * ABSENT = the view runs in Electron's **default session** (no partition).
   * That is the mask overlay since 2026-09-21 (§7b option A): it shares the
   * application's own cookie jar with the shell window, which is what makes the
   * BrowserAuth write proof work without copying the credential anywhere.
   */
  readonly partition?: string
  /** Attach this view to the browser window at the given bounds. */
  attach(win: NativeBrowserWindow, bounds: NativeBounds): void
  /** Update the view bounds (DIP, relative to the window content area). */
  setBounds(bounds: NativeBounds): void
  /** Show or hide the view. */
  setVisible(visible: boolean): void
  /** Remove the view from the window. */
  detach(): void
  /**
   * Raise this view to the TOP of the window's child stack. Electron's
   * WebContentsView z-order follows attach order; re-attaching (remove+add)
   * is the reliable way to bring a view forward, and the adapter must pass
   * the NATIVE view (not this wrapper) to contentView.
   */
  moveToTop(win: NativeBrowserWindow): void
  /** The webContents driving this view (loading, capture, CDP). */
  readonly webContents: NativeWebContents
  /** Destroy the underlying view. */
  destroy(): void
  /**
   * 把键盘焦点交给这个视图（可选：测试/非 Electron 适配器可以省略）。
   *
   * 2026-09-15 审计 P2-7：蒙版只挡鼠标 —— 用户点过页面输入框后 AI 进入 mask，
   * 焦点仍在下面的 tab 视图上，键盘输入会绕开"窗口已锁定"的模型。
   */
  focus?(): void
}

/** Bounds in DIP relative to the window's content area. */
export interface NativeBounds {
  x: number
  y: number
  width: number
  height: number
}

/** The minimal webContents surface used by the browser runtime. */
export interface NativeWebContents {
  readonly cdp: CdpTransport
  loadURL(url: string): Promise<void>
  /** Trigger a download of a URL through this webContents (programmatic path). */
  downloadURL(url: string): void
  goBack(): void
  goForward(): void
  reload(): void
  canGoBack(): boolean
  canGoForward(): boolean
  capturePage(rect?: NativeBounds): Promise<NativeImage>
  getURL(): string
  getTitle(): string
  isLoading(): boolean
  /** Optional: ask the renderer to stop this document's pending load (user takeover). */
  stop?(): void
  on(event: string, listener: (...args: unknown[]) => void): void
  removeListener(event: string, listener: (...args: unknown[]) => void): void
  session: NativeSession
  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void
  close(): void
  isDestroyed(): boolean
}

/** Native image (screenshot carrier). */
export interface NativeImage {
  getSize(): { width: number; height: number }
  resize(options: { width?: number; height?: number; quality?: 'good' | 'better' | 'best' }): NativeImage
  toJPEG(quality: number): Buffer
}

/** Native session (cookies/storage + permission/download hooks). */
export interface NativeSession {
  setPermissionRequestHandler(handler: (wc: unknown, permission: string, callback: (grant: boolean) => void) => void): void
  /**
   * Permission CHECK handler (synchronous). Electron requires BOTH handlers
   * for a complete policy: most web APIs run a check first and only raise a
   * request when the check is DENIED, and with no check handler installed the
   * check reports granted — which silently defeats a deny-all request handler
   * (2026-09-11 audit: the embedded browser's deny-all was dead code while the
   * main window installed both, see desktop electron-runtime.ts).
   */
  setPermissionCheckHandler(handler: (wc: unknown, permission: string, requestingOrigin: string, details: unknown) => boolean): void
  on(event: 'will-download', listener: (event: unknown, item: NativeDownloadItem) => void): void
  removeListener(event: 'will-download', listener: (event: unknown, item: NativeDownloadItem) => void): void
  clearStorageData(options?: { storages?: string[] }): Promise<void>
  clearCache(): Promise<void>
}

/** A native download in flight. */
export interface NativeDownloadItem {
  getURL(): string
  getFilename(): string
  getTotalBytes(): number
  /** Bytes received so far (-1 until the first progress event). */
  getReceivedBytes(): number
  setSavePath(path: string): void
  cancel(): void
  on(event: 'done' | 'updated', listener: (event: unknown, state?: string) => void): void
}

/**
 * The dedicated browser window. User-initiated close (the window's native X
 * or the shell's hide button) HIDES the window; only the agent's close
 * (`close()`) truly destroys it. The window loads a local control-shell page
 * whose DOM renders the toolbar; tab WebContentsViews overlay the content
 * area below it.
 */
export interface NativeBrowserWindow {
  /** Load the local control-shell page. */
  loadURL(url: string): Promise<void>
  /** Show and focus the window (wakes a hidden window). */
  show(): void
  /** Hide the window without destroying tabs (user close semantics). */
  hide(): void
  focus(): void
  isVisible(): boolean
  isDestroyed(): boolean
  /**
   * Whether the window is minimized (optional: test doubles and non-Electron
   * adapters may omit it; "absent" means unknown and is treated as NOT
   * minimized).
   *
   * 2026-09-17：焦点动作必须能区分"用户在看的窗口"与"被最小化/在后台的窗口"——
   * 给最小化窗口的 webContents 抢焦点会让 Windows 把它恢复前台（用户报告
   * 「最小化会自动弹出、切走一会儿又弹回来」）。
   */
  isMinimized?(): boolean
  /**
   * Whether the window currently holds OS focus (optional; absent means unknown
   * and is treated as "may take focus").
   */
  isFocused?(): boolean
  /**
   * Observe the window GAINING OS focus (optional; returns an unsubscribe).
   *
   * 用户在窗口外时不得抢焦点，但用户把窗口带到前台时必须重新上锁键盘
   * （P2-7）——这个事件是唯一的合法时机。
   */
  onFocus?(listener: () => void): () => void
  /** Truly close the window (agent-initiated; destroys all child views). */
  close(): void
  setTitle(title: string): void
  /** Content-area size in DIP (the shell toolbar occupies the top strip). */
  getContentSize(): { width: number; height: number }
  readonly contentView: {
    addChildView(view: unknown): void
    removeChildView(view: unknown): void
    /**
     * Native child order, bottom-most first (optional; absent means unknown and
     * callers fall back to an unconditional re-attach).
     */
    readonly children?: readonly unknown[]
  }
  /** Observe window resize (bounds recomputation). */
  onResize(listener: () => void): () => void
  /** Observe the window being destroyed (agent close or app quit). */
  onClosed(listener: () => void): () => void
  /** Focus the window's own webContents (toolbar shell page) — hands keyboard
   * shortcuts back after the overlay view releases focus. */
  focusPage(): void
}

/**
 * Raise one NATIVE child view to the top of the window's child stack.
 *
 * Electron's `WebContentsView` z-order follows attach order, so the reliable
 * way to bring a view forward is `removeChildView` + `addChildView`. Both calls
 * are skipped when the view is ALREADY the last (top-most) child: Electron
 * itself treats that as a no-op reorder, and attaching a view is reported to
 * grab focus with no opt-out (electron/electron#42339; electron/electron#42922
 * has no `focusable`).
 *
 * Evidence split (2026-09-17): the user report — "the browser window keeps
 * popping back to the front, and restores itself from minimized" — is
 * consistent with a focus grab on Windows; on Linux, direct measurement
 * (temp/audit-0917-window-focus) shows `addChildView` itself does NOT activate
 * the window, so the Windows half is inferred rather than reproduced. The
 * redundant re-attaches this helper removes are real either way: before the fix
 * every relayout (tab switch/close, resize, ledger restore, the resize Windows
 * emits when minimizing) re-ordered two native views.
 *
 * When `contentView.children` is unavailable the helper falls back to the
 * unconditional re-attach, which is always correct (only wasteful).
 * @param win - the browser window owning the child stack.
 * @param view - the native view to raise.
 */
export function raiseChildView(win: NativeBrowserWindow, view: unknown): void {
  try {
    const children = win.contentView.children
    if (children !== undefined && children.length > 0 && children[children.length - 1] === view) return
  } catch {
    // `children` is best-effort: an adapter that throws here still gets the
    // unconditional re-attach below.
  }
  try {
    win.contentView.removeChildView(view)
  } catch {
    // A never-attached view cannot be removed; adding it again is
    // harmless either way.
  }
  try {
    win.contentView.addChildView(view)
  } catch {
    // 视图销毁竞态下 attach 可能抛（与该文件的 view focus/detach 同类）：层序问题
    // 不该升级成插件失败，下一次 relayout/applyOverlay 还会再试。
  }
}

/**
 * The full native adapter: creates tab views and the mask view bound to the
 * persistent browser partition, and creates the dedicated browser window.
 */
export interface ElectronAdapter {
  createView(partition?: string): NativeView
  /**
   * The AI interception mask view (transparent, z-top; clicks hand control to the user).
   *
   * `partition` is OPTIONAL and the runtime passes **nothing**: the mask then
   * runs in the DEFAULT session, i.e. the same jar as the browser window's own
   * shell page and the main application window. That is a security requirement,
   * not a default (docs/decisions/2026-09-21-app-author-data-surface.md §7b):
   * the mask page is served by this host and its write operations must pass
   * `requireWriteProof`, whose proof is the application's `dsh-auth-*` cookie.
   * Putting the mask in a `persist:` partition either loses that cookie (the
   * 2026-09-14 P0: 「我来操作」 silently 403s) or — as the pre-2026-09-21 code
   * did — forces the cookie to be COPIED into the model-drivable tab partition.
   */
  createMaskView(partition?: string): NativeView
  createBrowserWindow(): NativeBrowserWindow
  showSaveDialog(options: { title: string; defaultPath: string }): Promise<{ canceled: boolean; filePath?: string }>
  /** Open a local path with the OS default handler (downloads viewer). */
  openPath(path: string): Promise<{ error?: string }>
  /**
   * Resolve an existing session for a partition without creating a view.
   * Used by `clearData` when no tab has materialized yet (P2-28): the
   * partition's cookies/storage still exist on disk, so "clear" must reach
   * them instead of silently doing nothing. Optional so test adapters and
   * non-Electron hosts can omit it (the runtime then fails loudly).
   */
  getSession?(partition: string): NativeSession | undefined
}

/**
 * Persistent browser partition: login sessions survive app restarts and stay
 * isolated from the main application's cookies/storage. The partition name is
 * per-user (`persist:agent-browser-<encoded-user>[@<server-hash>]`), so a user
 * switch never exposes A's website logins to B, and a **server** switch (the
 * deployment topology has a test and a production server side by side on one
 * machine) never shares one persistent partition between two tenants.
 *
 * The formula has ONE implementation — `./surface.ts` (`browserPartitionFor`),
 * re-exported here so the long-standing import path keeps working. The
 * `@picoaide/dsh-wasm-apps-host/partition` mirror is pinned against it by
 * `tests/partition-parity.spec.ts`.
 *
 * CROSS-PACKAGE CONSTRAINT (2026-08-22): the encoding intentionally mirrors
 * `@picoaide/dsh-connectors` `encodeSegment` (user-scope.ts) byte-for-byte —
 * the two are implemented separately because cross-package runtime imports
 * are forbidden, but they must NEVER diverge (a divergence would let the
 * browser partition name collide with, or shadow, a connectors user dir, or
 * break the injective property). Keep the charset: A-Za-z0-9_- literal, all
 * else `~<HEX>~`. `tests/partition.spec.ts` locks the examples.
 */
export { browserPartitionFor, encodePartitionSegment } from './surface.ts'
import { browserPartitionFor } from './surface.ts'

/** Legacy fixed partition name (pre-user-scope); kept for tests/back-compat. */
export const BROWSER_PARTITION = browserPartitionFor(null)

/** Height (DIP) of the control-shell toolbar area overlaid by tab views. */
export const BROWSER_SHELL_TOOLBAR_HEIGHT = 66

/** Default browser window size (DIP) — matches the PicoAide main window
 * defaults so the browser opens at the same footprint (2026-09-07 用户反馈). */
const BROWSER_WINDOW_DEFAULT = { width: 1280, height: 840 }
/** Browser window minimums (mirror the main window 900×640). */
const BROWSER_WINDOW_MIN = { width: 900, height: 640 }

/** The Electron surface this adapter consumes; injectable so unit tests can
 * assert the webPreferences/lifecycle contract without an Electron runtime. */
export interface ElectronModuleLike {
  WebContentsView: typeof import('electron').WebContentsView
  BrowserWindow: typeof import('electron').BrowserWindow
  dialog: typeof import('electron').dialog
  shell: typeof import('electron').shell
  session: typeof import('electron').session
}

/** Lazy real adapter over Electron (imported only on first browser start). */
export function createRealElectronAdapter(
  electronModule?: ElectronModuleLike,
  /**
   * Locale provider for the native window title created here. A provider (not
   * a value) because the window outlives any single locale resolution; the
   * runtime re-titles it on every active-tab change anyway.
   */
  locale: () => HostLocale = () => DEFAULT_HOST_LOCALE,
): ElectronAdapter {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const electron = electronModule ?? (require('electron') as ElectronModuleLike)
  const { WebContentsView, BrowserWindow, dialog } = electron

  const createView = (partition: string = BROWSER_PARTITION): NativeView => {
    const view = new WebContentsView({
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // 2026-09-08 product decision: the AI keeps driving tabs after the user
        // closes the browser window, and tabs that are not the active one are
        // `setVisible(false)`. Chromium's default background throttling clamps
        // page timers to 1 Hz (and 1/min after ~5 min) in both cases —
        // measured 30 → 3 ticks per 3s — which breaks SPA polling/debounce on
        // the very tabs the agent is operating. Keep every browser renderer at
        // full speed while it is backgrounded.
        backgroundThrottling: false,
      },
    })
    const wc = view.webContents
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    return {
      partition,
      attach(win, bounds) {
        win.contentView.addChildView(view)
        view.setBounds(bounds)
      },
      setBounds(bounds) {
        view.setBounds(bounds)
      },
      setVisible(visible) {
        view.setVisible(visible)
      },
      detach() {
        // WebContentsView removes itself from its parent on close; nothing
        // to do here beyond releasing the reference (the window owns it).
      },
      moveToTop(win) {
        raiseChildView(win, view)
      },
      webContents: {
        cdp: wc.debugger,
        loadURL: (url) => wc.loadURL(url),
        downloadURL: (url) => wc.downloadURL(url),
        goBack: () => wc.goBack(),
        goForward: () => wc.goForward(),
        reload: () => wc.reload(),
        canGoBack: () => wc.navigationHistory.canGoBack(),
        canGoForward: () => wc.navigationHistory.canGoForward(),
        capturePage: (rect) => wc.capturePage(rect),
        getURL: () => wc.getURL(),
        getTitle: () => wc.getTitle(),
        isLoading: () => wc.isLoading(),
        on: (event, listener) => {
          wc.on(event as never, listener as never)
        },
        removeListener: (event, listener) => {
          wc.removeListener(event as never, listener as never)
        },
        session: wc.session,
        setWindowOpenHandler: (handler) => {
          wc.setWindowOpenHandler((details) => handler(details))
        },
        close: () => wc.close(),
        isDestroyed: () => wc.isDestroyed(),
      },
      destroy() {
        if (!view.webContents.isDestroyed()) view.webContents.close()
      },
    }
  }

  return {
    createView,
    createMaskView(partition?: string): NativeView {
      // The AI-control mask must COMPOSITE over the tab views beneath it:
      // the mask page paints a translucent scrim (`rgba(...)`) whose alpha
      // must blend with the live page, not with this view's own canvas.
      // A WebContentsView is opaque by default, so a translucent page color
      // blends against opaque white and the page below is invisible
      // (verified on Electron 43, 2026-08-22: sampled pixels showed a flat
      // gray over a red page). `webPreferences.transparent: true` makes the
      // guest page's own background transparent, so rgba() blends through it
      // onto the tabs underneath. The window itself stays opaque; only the
      // mask view carries alpha.
      //
      // 2026-09-21 (§7b option A): no partition ⇒ DEFAULT session, which is
      // where the application's `dsh-auth-*` proof cookie lives (same jar as
      // the shell window's page and the main window). Omit the key entirely —
      // passing `partition: undefined` explicitly is not the same statement
      // and Electron's own default is what we rely on here.
      const view = new WebContentsView({
        webPreferences: {
          ...(partition === undefined ? {} : { partition }),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          transparent: true,
          // Overlay UI (pill/panel/menu/viewer) must keep animating and
          // polling while the browser window is hidden — see createView.
          backgroundThrottling: false,
        },
      })
      const wc = view.webContents
      wc.setWindowOpenHandler(() => ({ action: 'deny' }))
      return {
        ...(partition === undefined ? {} : { partition }),
        attach(win, bounds) {
          win.contentView.addChildView(view)
          view.setBounds(bounds)
        },
        setBounds(bounds) {
          view.setBounds(bounds)
        },
        setVisible(visible) {
          view.setVisible(visible)
        },
        detach() {
          // WebContentsView removes itself from its parent on close; nothing
          // to do here beyond releasing the reference (the window owns it).
        },
        focus() {
          // 蒙版上锁时把键盘焦点拿过来（审计 P2-7）：否则键盘输入直入下面的页面。
          try {
            if (!wc.isDestroyed()) wc.focus()
          } catch {
            // 视图销毁竞态下 focus 可能抛：焦点问题不该升级成插件失败。
          }
        },
        moveToTop(win) {
          raiseChildView(win, view)
        },
        webContents: {
          cdp: wc.debugger,
          loadURL: (url) => wc.loadURL(url),
        downloadURL: (url) => wc.downloadURL(url),
          goBack: () => wc.goBack(),
          goForward: () => wc.goForward(),
          reload: () => wc.reload(),
          canGoBack: () => false,
          canGoForward: () => false,
          capturePage: (rect) => wc.capturePage(rect),
          getURL: () => wc.getURL(),
          getTitle: () => wc.getTitle(),
          isLoading: () => wc.isLoading(),
          on: (event, listener) => {
            wc.on(event as never, listener as never)
          },
          removeListener: (event, listener) => {
            wc.removeListener(event as never, listener as never)
          },
          session: wc.session,
          setWindowOpenHandler: (handler) => {
            wc.setWindowOpenHandler((details) => handler(details))
          },
          close: () => wc.close(),
          isDestroyed: () => wc.isDestroyed(),
        },
        destroy() {
          if (!view.webContents.isDestroyed()) view.webContents.close()
        },
      }
    },
    createBrowserWindow(): NativeBrowserWindow {
      let allowClose = false
      const win = new BrowserWindow({
        width: BROWSER_WINDOW_DEFAULT.width,
        height: BROWSER_WINDOW_DEFAULT.height,
        minWidth: BROWSER_WINDOW_MIN.width,
        minHeight: BROWSER_WINDOW_MIN.height,
        title: browserDefaultTitle(locale()),
        // 2026-09-08 product decision: the browser is created at client boot
        // but stays HIDDEN — the agent operates it in the background and the
        // shell's 浏览器 button shows it on demand. Creation must therefore
        // never flash a window on screen.
        show: false,
        backgroundColor: '#f2f3f5',
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          // The shell toolbar/overlay keep working while the window is hidden
          // (user closed it): no background timer throttling.
          backgroundThrottling: false,
        },
      })
      win.setMenuBarVisibility(false)
      win.on('close', (event) => {
        // User close hides the window; only the agent's close destroys it.
        if (!allowClose) {
          event.preventDefault()
          win.hide()
        }
      })
      const resizeListeners = new Set<() => void>()
      win.on('resize', () => {
        for (const listener of resizeListeners) {
          try {
            listener()
          } catch {
            // A layout listener must never break the window.
          }
        }
      })
      const closedListeners = new Set<() => void>()
      win.on('closed', () => {
        for (const listener of closedListeners) {
          try {
            listener()
          } catch {
            // A closed observer must never break teardown.
          }
        }
      })
      return {
        loadURL: (url) => win.loadURL(url),
        show: () => {
          if (win.isDestroyed()) return
          win.show()
          win.focus()
        },
        hide: () => {
          if (win.isDestroyed()) return
          win.hide()
        },
        focus: () => {
          if (win.isDestroyed()) return
          win.focus()
        },
        isVisible: () => !win.isDestroyed() && win.isVisible(),
        isDestroyed: () => win.isDestroyed(),
        isMinimized: () => !win.isDestroyed() && win.isMinimized(),
        isFocused: () => !win.isDestroyed() && win.isFocused(),
        onFocus: (listener) => {
          if (win.isDestroyed()) return () => {}
          // 逐个 listener 兜异常（与 resize/closed 的处理一致）：这个回调在窗口
          // 事件派发栈里跑，抛出去就是未捕获异常，而它唯一的职责是重新上锁。
          const wrapped = (): void => {
            try {
              listener()
            } catch {
              // 焦点处理绝不能把窗口事件链打断。
            }
          }
          win.on('focus', wrapped)
          return () => {
            // A window destroyed between the check and the call throws on
            // removeListener: unsubscribing is best-effort by nature.
            try {
              win.removeListener('focus', wrapped)
            } catch {
              // The window is gone; its listeners went with it.
            }
          }
        },
        close: () => {
          if (win.isDestroyed()) return
          allowClose = true
          win.close()
        },
        setTitle: (title) => {
          if (win.isDestroyed()) return
          win.setTitle(title)
        },
        getContentSize: () => {
          const [width, height] = win.getContentSize()
          return { width: width ?? 0, height: height ?? 0 }
        },
        contentView: win.contentView,
        onResize(listener) {
          resizeListeners.add(listener)
          return () => {
            resizeListeners.delete(listener)
          }
        },
        onClosed(listener) {
          closedListeners.add(listener)
          return () => {
            closedListeners.delete(listener)
          }
        },
        focusPage: () => {
          if (win.isDestroyed()) return
          win.focus()
          win.webContents.focus()
        },
      }
    },
    showSaveDialog: async (options) => {
      const result = await dialog.showSaveDialog(options)
      return { canceled: result.canceled, filePath: result.filePath }
    },
    openPath: async (path) => {
      const { shell } = electron
      const error = await shell.openPath(path)
      return error === '' ? {} : { error }
    },
    // P2-28: resolve an existing partition session without creating a view,
    // so `clearData` can still clear cookies/storage when no tab has been
    // materialized yet. Electron's Session satisfies NativeSession.
    getSession: (partition) => {
      const sessions = (electron as { session?: typeof import('electron').session }).session
      if (sessions === undefined || typeof sessions.fromPartition !== 'function') return undefined
      return sessions.fromPartition(partition) as unknown as NativeSession
    },
  }
}
