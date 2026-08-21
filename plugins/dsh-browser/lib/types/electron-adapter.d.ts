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
import type { CdpTransport } from './cdp.ts';
/** The minimal native view surface the browser runtime drives. */
export interface NativeView {
    /** Stable partition name of this view's session (persistent browser storage). */
    readonly partition: string;
    /** Attach this view to the browser window at the given bounds. */
    attach(win: NativeBrowserWindow, bounds: NativeBounds): void;
    /** Update the view bounds (DIP, relative to the window content area). */
    setBounds(bounds: NativeBounds): void;
    /** Show or hide the view. */
    setVisible(visible: boolean): void;
    /** Remove the view from the window. */
    detach(): void;
    /**
     * Raise this view to the TOP of the window's child stack. Electron's
     * WebContentsView z-order follows attach order; re-attaching (remove+add)
     * is the reliable way to bring a view forward, and the adapter must pass
     * the NATIVE view (not this wrapper) to contentView.
     */
    moveToTop(win: NativeBrowserWindow): void;
    /** The webContents driving this view (loading, capture, CDP). */
    readonly webContents: NativeWebContents;
    /** Destroy the underlying view. */
    destroy(): void;
}
/** Bounds in DIP relative to the window's content area. */
export interface NativeBounds {
    x: number;
    y: number;
    width: number;
    height: number;
}
/** The minimal webContents surface used by the browser runtime. */
export interface NativeWebContents {
    readonly cdp: CdpTransport;
    loadURL(url: string): Promise<void>;
    goBack(): void;
    goForward(): void;
    reload(): void;
    capturePage(rect?: NativeBounds): Promise<NativeImage>;
    getURL(): string;
    getTitle(): string;
    isLoading(): boolean;
    on(event: string, listener: (...args: unknown[]) => void): void;
    removeListener(event: string, listener: (...args: unknown[]) => void): void;
    session: NativeSession;
    setWindowOpenHandler(handler: (details: {
        url: string;
    }) => {
        action: 'deny';
    }): void;
    close(): void;
    isDestroyed(): boolean;
}
/** Native image (screenshot carrier). */
export interface NativeImage {
    getSize(): {
        width: number;
        height: number;
    };
    resize(options: {
        width?: number;
        height?: number;
        quality?: 'good' | 'better' | 'best';
    }): NativeImage;
    toJPEG(quality: number): Buffer;
}
/** Native session (cookies/storage + permission/download hooks). */
export interface NativeSession {
    setPermissionRequestHandler(handler: (wc: unknown, permission: string, callback: (grant: boolean) => void) => void): void;
    on(event: 'will-download', listener: (event: unknown, item: NativeDownloadItem) => void): void;
    removeListener(event: 'will-download', listener: (event: unknown, item: NativeDownloadItem) => void): void;
    clearStorageData(): Promise<void>;
    clearCache(): Promise<void>;
}
/** A native download in flight. */
export interface NativeDownloadItem {
    getURL(): string;
    getFilename(): string;
    getTotalBytes(): number;
    /** Bytes received so far (-1 until the first progress event). */
    getReceivedBytes(): number;
    setSavePath(path: string): void;
    cancel(): void;
    on(event: 'done' | 'updated', listener: (event: unknown, state?: string) => void): void;
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
    loadURL(url: string): Promise<void>;
    /** Show and focus the window (wakes a hidden window). */
    show(): void;
    /** Hide the window without destroying tabs (user close semantics). */
    hide(): void;
    focus(): void;
    isVisible(): boolean;
    isDestroyed(): boolean;
    /** Truly close the window (agent-initiated; destroys all child views). */
    close(): void;
    setTitle(title: string): void;
    /** Content-area size in DIP (the shell toolbar occupies the top strip). */
    getContentSize(): {
        width: number;
        height: number;
    };
    readonly contentView: {
        addChildView(view: unknown): void;
        removeChildView(view: unknown): void;
    };
    /** Observe window resize (bounds recomputation). */
    onResize(listener: () => void): () => void;
    /** Observe the window being destroyed (agent close or app quit). */
    onClosed(listener: () => void): () => void;
}
/**
 * The full native adapter: creates tab views and the mask view bound to the
 * persistent browser partition, and creates the dedicated browser window.
 */
export interface ElectronAdapter {
    createView(): NativeView;
    /** The AI-control mask view (local translucent page with the takeover button). */
    createMaskView(): NativeView;
    createBrowserWindow(): NativeBrowserWindow;
    showSaveDialog(options: {
        title: string;
        defaultPath: string;
    }): Promise<{
        canceled: boolean;
        filePath?: string;
    }>;
}
/**
 * Persistent browser partition: login sessions survive app restarts and stay
 * isolated from the main application's cookies/storage.
 */
export declare const BROWSER_PARTITION = "persist:agent-browser";
/** Height (DIP) of the control-shell toolbar area overlaid by tab views. */
export declare const BROWSER_SHELL_TOOLBAR_HEIGHT = 84;
/** Default browser window size (DIP). */
export declare const BROWSER_WINDOW_DEFAULT: {
    width: number;
    height: number;
};
/** Lazy real adapter over Electron (imported only on first browser start). */
export declare function createRealElectronAdapter(): ElectronAdapter;
