/**
 * BrowserRuntime: the embedded agent-driven browser service. Owns the tab
 * pool (one WebContentsView per tab), the CDP sessions, the agent/user
 * control mutex, navigation, interaction primitives, guards, and the audit
 * op log. Everything Electron-specific flows through the injected adapter,
 * so the whole service is unit-testable headlessly.
 * @module @picoaide/dsh-browser
 */
import { CdpSession } from './cdp.ts';
import { type ElectronAdapter, type NativeBrowserWindow, type NativeView } from './electron-adapter.ts';
import { BrowserGuard } from './guard.ts';
import type { BrowserOpLogEntry, BrowserSnapshotElement, BrowserTabState, BrowserToolOptions, BrowserWaitUntil, BrowserWindowState, CredentialResolver } from './types.ts';
/** Default cooperative tool-call budget (ms). */
export declare const DEFAULT_TIMEOUT_MS = 30000;
/** Default cap on waiting for Electron's loadURL promise (ms). */
export declare const DEFAULT_LOAD_TIMEOUT_MS = 20000;
/** Maximum simultaneous tabs. */
export declare const DEFAULT_MAX_TABS = 8;
interface BrowserTab {
    readonly id: number;
    readonly view: NativeView;
    readonly cdp: CdpSession;
    url: string;
    title: string;
    loading: boolean;
}
/**
 * The embedded browser service. Constructed by the plugin with the real
 * adapter; tests inject a mock adapter plus a fake approval asker.
 */
export declare class BrowserRuntime {
    private readonly adapter;
    private readonly credentials?;
    private readonly tabs;
    private nextTabId;
    private visibleTabId;
    private readonly mutex;
    /** Loopback origin serving the shell/mask pages (set by the plugin). */
    private shellOrigin;
    private readonly ops;
    private opSeq;
    private window;
    private mask;
    private readonly guard;
    private readonly permissionsDisposers;
    private readonly downloadDisposers;
    private windowResizeDisposer;
    private windowClosedDisposer;
    private disposed;
    constructor(adapter: ElectronAdapter, options?: BrowserToolOptions, askApproval?: BrowserGuard['askApproval'], credentials?: CredentialResolver | undefined);
    readonly options: Required<BrowserToolOptions>;
    /** Current browser window state (created + visible). */
    get windowState(): BrowserWindowState;
    /** Recent audit op log (newest first). */
    get opLog(): readonly BrowserOpLogEntry[];
    /** Snapshot of all tabs. */
    listTabs(): BrowserTabState[];
    get controlled(): boolean;
    /** Id of the visible tab, or undefined when none is open. */
    currentTabId(): number | undefined;
    /** Public tab state (throws for unknown ids). */
    tabState(id: number): BrowserTabState;
    /** Route a sensitive-action approval through the guard. */
    requireApproval(request: Parameters<BrowserGuard['askApproval']>[0]): Promise<boolean>;
    /** Content-area bounds below the shell toolbar (DIP). */
    private contentBounds;
    /** Re-layout every tab view + the mask over the window content area. */
    private relayout;
    /**
     * Ensure the dedicated browser window exists and is shown. Creating the
     * window also loads the control-shell page and mounts the AI-control mask.
     * @param origin - the loopback webServer origin (e.g. `http://127.0.0.1:33407`)
     *   the shell/mask pages are served from; without it the window cannot load
     *   them (Electron needs absolute URLs).
     */
    ensureWindow(origin?: string): Promise<NativeBrowserWindow>;
    /** Set the loopback origin the shell/mask pages are served from. */
    setShellOrigin(origin: string): void;
    /** Show the browser window (wake from a user close; the sidebar trigger). */
    showWindow(): void;
    /** Hide the browser window without destroying tabs (user close semantics). */
    hideWindow(): void;
    private record;
    /** Resolve a tab by id; throws with a model-facing message. */
    private tab;
    private updateTabState;
    /**
     * Create a tab and optionally navigate it. The first tab becomes visible.
     */
    open(url: string | undefined): Promise<BrowserTabState>;
    private tabStateInternal;
    /** Run one agent operation under the control mutex. Passes the agent's
     * abort signal so a takeover pauses the loop until release (or the agent
     * stops). */
    withControl<T>(_tool: string, tabId: number, work: (tab: BrowserTab) => Promise<T>, signal?: AbortSignal): Promise<T>;
    /**
     * Navigate the tab to `url`, waiting per `waitUntil`.
     *
     * Electron's `loadURL` promise settles on `did-finish-load`, which pages
     * with long-lived connections (polls, SSE, analytics) can delay well past
     * the page being interactive. Racing it against `loadTimeoutMs` keeps the
     * tool call from dying on the cooperative 30s budget while the page is
     * already usable; once the load promise settles (or the race times out),
     * `domcontentloaded`/`load` are guaranteed satisfied (did-finish-load is
     * strictly after dom-ready) and only `networkidle` needs an extra quiet
     * tick.
     */
    navigate(id: number, url: string, waitUntil?: BrowserWaitUntil, signal?: AbortSignal): Promise<void>;
    /** Cooperative wait for the page load milestone; never rejects on timeout. */
    private waitForLoad;
    /** Extract the interactable-element snapshot of one tab. */
    snapshot(id: number, signal?: AbortSignal): Promise<BrowserSnapshotElement[]>;
    /** Extract page text (optionally scoped by selector). */
    text(id: number, selector: string | undefined, signal?: AbortSignal): Promise<string>;
    /** Capture a JPEG screenshot of one tab. */
    screenshot(id: number, signal?: AbortSignal): Promise<string>;
    /** Navigate history. */
    goBack(id: number): Promise<void>;
    goForward(id: number): Promise<void>;
    reload(id: number): Promise<void>;
    /** Switch the visible tab. */
    switchTab(id: number): Promise<void>;
    /** Close a tab and destroy its view/CDP. */
    closeTab(id: number): Promise<void>;
    /**
     * Close the whole browser (all tabs). The dedicated window stays alive
     * (hidden) so the user can wake it from the sidebar — only plugin teardown
     * truly destroys it. Tabs are dropped; the next `browser_open` recreates
     * them.
     */
    closeAll(): Promise<void>;
    /** User takeover / release: hides/shows the AI-control mask and pauses /
     * resumes the agent loop (in-flight tool calls wait on the mutex). */
    setUserControl(active: boolean): void;
    /** Clear the persistent partition data (cookies, storage, cache). */
    clearData(): Promise<void>;
    /** Evaluate page JS (eval-enabled deployments only). */
    eval(id: number, expression: string, signal?: AbortSignal): Promise<unknown>;
    /** Locate an element and return its viewport-center point for CDP input. */
    locateElement(id: number, selector: string, signal?: AbortSignal): Promise<{
        x: number;
        y: number;
    }>;
    /** Dispatch a left-click at a viewport point. */
    clickAt(id: number, point: {
        x: number;
        y: number;
    }, signal?: AbortSignal): Promise<void>;
    /** Focus an element and insert text (Unicode-safe); clears first when requested. */
    typeInto(id: number, selector: string, text: string, clear?: boolean, signal?: AbortSignal): Promise<void>;
    /** Dispatch one keyboard key. */
    pressKey(id: number, key: string, signal?: AbortSignal): Promise<void>;
    /** Set a select's value and fire change/input. */
    selectOption(id: number, selector: string, value: string, signal?: AbortSignal): Promise<void>;
    /**
     * Fill the login form with stored connector credentials. The resolver looks
     * up the connector's credential fields (username/password); the form's first
     * text/email input receives the username and its password input the
     * password. Callers must route this through approval (credentials are
     * sensitive).
     */
    fillCredentials(id: number, connectorId: string, signal?: AbortSignal): Promise<{
        username: boolean;
        password: boolean;
    }>;
    /** Scroll the page by a delta (or the element into view). */
    scroll(id: number, deltaY: number, selector: string | undefined, signal?: AbortSignal): Promise<void>;
    /** Dispose everything (plugin teardown): destroy the window for real. */
    dispose(): void;
}
/** Redact credential-shaped parts of a browser op-log summary (URLs and
 * query parameters). Mirrors the desktop logger's mask-secrets semantics. */
export declare function maskBrowserSummary(summary: string): string;
export {};
