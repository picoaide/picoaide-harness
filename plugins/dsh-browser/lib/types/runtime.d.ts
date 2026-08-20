/**
 * BrowserRuntime: the embedded agent-driven browser service. Owns the tab
 * pool (one WebContentsView per tab), the CDP sessions, the agent/user
 * control mutex, navigation, interaction primitives, guards, and the audit
 * op log. Everything Electron-specific flows through the injected adapter,
 * so the whole service is unit-testable headlessly.
 * @module @picoaide/dsh-browser
 */
import { CdpSession } from './cdp.ts';
import type { ElectronAdapter, NativeView } from './electron-adapter.ts';
import { BrowserGuard } from './guard.ts';
import type { BrowserOpLogEntry, BrowserPanelState, BrowserSnapshotElement, BrowserTabState, BrowserToolOptions, BrowserWaitUntil, CredentialResolver } from './types.ts';
/** Default cooperative tool-call budget (ms). */
export declare const DEFAULT_TIMEOUT_MS = 30000;
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
    private readonly ops;
    private opSeq;
    private panel;
    private readonly guard;
    private readonly permissionsDisposers;
    private readonly downloadDisposers;
    private readonly windowGoneDisposer;
    private disposed;
    constructor(adapter: ElectronAdapter, options?: BrowserToolOptions, askApproval?: BrowserGuard['askApproval'], credentials?: CredentialResolver | undefined);
    readonly options: Required<BrowserToolOptions>;
    /** Current panel visibility + placement (set by the client panel). */
    get panelState(): BrowserPanelState;
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
    /** Update the panel placement and re-layout the visible view. */
    setPanel(state: BrowserPanelState): void;
    private record;
    private visibleTab;
    /** Resolve a tab by id; throws with a model-facing message. */
    private tab;
    private updateTabState;
    /**
     * Create a tab and optionally navigate it. The first tab becomes visible.
     */
    open(url: string | undefined): Promise<BrowserTabState>;
    private tabStateInternal;
    /** Run one agent operation under the control mutex. */
    withControl<T>(_tool: string, tabId: number, work: (tab: BrowserTab) => Promise<T>): Promise<T>;
    /** Navigate the tab to `url`, waiting per `waitUntil`. */
    navigate(id: number, url: string, waitUntil?: BrowserWaitUntil): Promise<void>;
    /** Cooperative wait for the page load milestone; never rejects on timeout. */
    private waitForLoad;
    /** Extract the interactable-element snapshot of one tab. */
    snapshot(id: number): Promise<BrowserSnapshotElement[]>;
    /** Extract page text (optionally scoped by selector). */
    text(id: number, selector: string | undefined): Promise<string>;
    /** Capture a JPEG screenshot of one tab. */
    screenshot(id: number): Promise<string>;
    /** Navigate history. */
    goBack(id: number): Promise<void>;
    goForward(id: number): Promise<void>;
    reload(id: number): Promise<void>;
    /** Switch the visible tab. */
    switchTab(id: number): Promise<void>;
    /** Close a tab and destroy its view/CDP. */
    closeTab(id: number): Promise<void>;
    /** Close the whole browser (all tabs). */
    closeAll(): Promise<void>;
    /** User takeover / release. */
    setUserControl(active: boolean): void;
    /** Clear the persistent partition data (cookies, storage, cache). */
    clearData(): Promise<void>;
    /** Evaluate page JS (eval-enabled deployments only). */
    eval(id: number, expression: string): Promise<unknown>;
    /** Locate an element and return its viewport-center point for CDP input. */
    locateElement(id: number, selector: string): Promise<{
        x: number;
        y: number;
    }>;
    /** Dispatch a left-click at a viewport point. */
    clickAt(id: number, point: {
        x: number;
        y: number;
    }): Promise<void>;
    /** Focus an element and insert text (Unicode-safe); clears first when requested. */
    typeInto(id: number, selector: string, text: string, clear?: boolean): Promise<void>;
    /** Dispatch one keyboard key. */
    pressKey(id: number, key: string): Promise<void>;
    /** Set a select's value and fire change/input. */
    selectOption(id: number, selector: string, value: string): Promise<void>;
    /**
     * Fill the login form with stored connector credentials. The resolver looks
     * up the connector's credential fields (username/password); the form's first
     * text/email input receives the username and its password input the
     * password. Callers must route this through approval (credentials are
     * sensitive).
     */
    fillCredentials(id: number, connectorId: string): Promise<{
        username: boolean;
        password: boolean;
    }>;
    /** Scroll the page by a delta (or the element into view). */
    scroll(id: number, deltaY: number, selector: string | undefined): Promise<void>;
    /** Dispose everything (plugin teardown). */
    dispose(): void;
}
export {};
