/**
 * Electron adapter seam for the embedded browser. The plugin must load under
 * plain Node (unit tests), so every Electron surface is reached through this
 * seam: type-only imports here, and the real adapter lazily requires
 * `electron` only when a browser actually starts.
 * @module @picoaide/dsh-browser
 */
import type { CdpTransport } from './cdp.ts';
/** The minimal native view surface the browser runtime drives. */
export interface NativeView {
    /** Stable partition name of this view's session (persistent browser storage). */
    readonly partition: string;
    /** Attach this view on top of the main window at the given bounds. */
    attach(win: NativeWindow, bounds: NativeBounds): void;
    /** Update the view bounds (DIP, relative to the window content area). */
    setBounds(bounds: NativeBounds): void;
    /** Show or hide the view. */
    setVisible(visible: boolean): void;
    /** Remove the view from the window. */
    detach(): void;
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
/** The native main window. */
export interface NativeWindow {
    readonly contentView: {
        addChildView(view: unknown): void;
        removeChildView(view: unknown): void;
    };
    on(event: 'resize' | 'move', listener: () => void): void;
    removeListener(event: 'resize' | 'move', listener: () => void): void;
    getBounds(): NativeBounds;
}
/**
 * The full native adapter: creates views bound to the persistent browser
 * partition and resolves the main window.
 */
export interface ElectronAdapter {
    createView(): NativeView;
    getMainWindow(): NativeWindow | undefined;
    showSaveDialog(options: {
        title: string;
        defaultPath: string;
    }): Promise<{
        canceled: boolean;
        filePath?: string;
    }>;
    onMainWindowGone(listener: () => void): () => void;
}
/**
 * Persistent browser partition: login sessions survive app restarts and stay
 * isolated from the main application's cookies/storage.
 */
export declare const BROWSER_PARTITION = "persist:agent-browser";
/** Lazy real adapter over Electron (imported only on first browser start). */
export declare function createRealElectronAdapter(): ElectronAdapter;
