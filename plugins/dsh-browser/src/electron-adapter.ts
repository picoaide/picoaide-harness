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

import type { CdpTransport } from './cdp.ts'

/** The minimal native view surface the browser runtime drives. */
export interface NativeView {
  /** Stable partition name of this view's session (persistent browser storage). */
  readonly partition: string
  /** Attach this view to the browser window at the given bounds. */
  attach(win: NativeBrowserWindow, bounds: NativeBounds): void
  /** Update the view bounds (DIP, relative to the window content area). */
  setBounds(bounds: NativeBounds): void
  /** Show or hide the view. */
  setVisible(visible: boolean): void
  /** Remove the view from the window. */
  detach(): void
  /** The webContents driving this view (loading, capture, CDP). */
  readonly webContents: NativeWebContents
  /** Destroy the underlying view. */
  destroy(): void
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
  goBack(): void
  goForward(): void
  reload(): void
  capturePage(rect?: NativeBounds): Promise<NativeImage>
  getURL(): string
  getTitle(): string
  isLoading(): boolean
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
  on(event: 'will-download', listener: (event: unknown, item: NativeDownloadItem) => void): void
  removeListener(event: 'will-download', listener: (event: unknown, item: NativeDownloadItem) => void): void
  clearStorageData(): Promise<void>
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
  /** Truly close the window (agent-initiated; destroys all child views). */
  close(): void
  setTitle(title: string): void
  /** Content-area size in DIP (the shell toolbar occupies the top strip). */
  getContentSize(): { width: number; height: number }
  readonly contentView: {
    addChildView(view: unknown): void
    removeChildView(view: unknown): void
  }
  /** Observe window resize (bounds recomputation). */
  onResize(listener: () => void): () => void
  /** Observe the window being destroyed (agent close or app quit). */
  onClosed(listener: () => void): () => void
}

/**
 * The full native adapter: creates tab views and the mask view bound to the
 * persistent browser partition, and creates the dedicated browser window.
 */
export interface ElectronAdapter {
  createView(): NativeView
  /** The AI-control mask view (local translucent page with the takeover button). */
  createMaskView(): NativeView
  createBrowserWindow(): NativeBrowserWindow
  showSaveDialog(options: { title: string; defaultPath: string }): Promise<{ canceled: boolean; filePath?: string }>
}

/**
 * Persistent browser partition: login sessions survive app restarts and stay
 * isolated from the main application's cookies/storage.
 */
export const BROWSER_PARTITION = 'persist:agent-browser'

/** Height (DIP) of the control-shell toolbar area overlaid by tab views. */
export const BROWSER_SHELL_TOOLBAR_HEIGHT = 84

/** Default browser window size (DIP). */
export const BROWSER_WINDOW_DEFAULT = { width: 1100, height: 780 }

/** Lazy real adapter over Electron (imported only on first browser start). */
export function createRealElectronAdapter(): ElectronAdapter {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const electron = require('electron') as typeof import('electron')
  const { WebContentsView, BrowserWindow, dialog } = electron

  const createView = (): NativeView => {
    const view = new WebContentsView({
      webPreferences: {
        partition: BROWSER_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    const wc = view.webContents
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    return {
      partition: BROWSER_PARTITION,
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
      webContents: {
        cdp: wc.debugger,
        loadURL: (url) => wc.loadURL(url),
        goBack: () => wc.goBack(),
        goForward: () => wc.goForward(),
        reload: () => wc.reload(),
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
    createMaskView: createView,
    createBrowserWindow(): NativeBrowserWindow {
      let allowClose = false
      const win = new BrowserWindow({
        width: BROWSER_WINDOW_DEFAULT.width,
        height: BROWSER_WINDOW_DEFAULT.height,
        title: 'PicoAide 浏览器',
        show: true,
        backgroundColor: '#f2f3f5',
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
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
      }
    },
    showSaveDialog: async (options) => {
      const result = await dialog.showSaveDialog(options)
      return { canceled: result.canceled, filePath: result.filePath }
    },
  }
}
