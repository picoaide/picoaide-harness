import { type CliBinaryManifest } from './cli-manifest.ts';
/** Progress callback surfaced to the skill installer (e.g. "正在下载…"). */
export type CliProgress = (message: string) => void;
export interface CliInstallOptions {
    /** Cache root (default `~/.picoaide-harness/cli-cache`); skill 侧传入。 */
    cacheDir?: string;
    /** Manifests override (tests). */
    manifests?: ReadonlyMap<string, CliBinaryManifest>;
    /** Fetch implementation override (tests). */
    fetchImpl?: typeof fetch;
    downloadTimeoutMs?: number;
    /**
     * Prefetched binaries shipped inside the application (build-time download,
     * see `dsh-plugin-desktop/scripts/prefetch-cli.mjs`). When set and the
     * bundled copy for the current platform exists, it is used directly —
     * first skill invocation needs no network. Layout:
     * `<bundledDir>/<command>/<version>/<binaryName>`.
     */
    bundledDir?: string;
}
/** Result of `ensureCliInstalled`. */
export interface CliInstallResult {
    /** Absolute path to the installed/bundled executable. */
    binaryPath: string;
    /** True when the binary was already present (cache/bundled) without network. */
    fromCache: boolean;
}
/** Install (or reuse) the pinned binary for `command`; throws on any failure. */
export declare function ensureCliInstalled(command: string, options?: CliInstallOptions): Promise<CliInstallResult>;
export declare class CliInstaller {
    private readonly cacheDir;
    private readonly bundledDir;
    private readonly manifests;
    private readonly fetchImpl;
    private readonly downloadTimeoutMs;
    private readonly inflight;
    constructor(options?: CliInstallOptions);
    /**
     * Ensure the pinned binary for `command` exists (bundled → cache → download),
     * deduplicated across concurrent calls. Returns null when the manifest or
     * platform is unsupported.
     */
    ensure(command: string, onProgress?: CliProgress): Promise<CliInstallResult | null>;
    /** Locate a prefetched binary in the bundled directory, if any. */
    private bundledBinary;
    /** Download + extract the pinned platform binary into the cache dir. */
    private installBinary;
    /** Derive the expected platform asset from the manifest (no network). */
    private expectedAsset;
    /** Download the pinned platform archive (tarball inner asset or direct URL). */
    private fetchPlatformArchive;
    private download;
}
