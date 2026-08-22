/**
 * Download-on-demand runtime for connector CLI tools.
 *
 * Resolution order for a connector CLI command (`dws`, `beisen-cli`, ...):
 *   1. PATH lookup wins — a user-installed CLI is used as-is, nothing is
 *      downloaded and no cache is touched.
 *   2. Otherwise, if a pinned manifest exists for the command, the official
 *      platform archive is downloaded, sha256-verified against the pinned
 *      checksum, extracted into the user cache dir and the native binary is
 *      spawned directly (never the vendor's install scripts, which have
 *      invasive side effects — e.g. dws' postinstall writes skills into
 *      claude/cursor agent dirs).
 *   3. Otherwise `null` — the caller keeps the original command and the
 *      regular ENOENT flow produces the "install the CLI manually" hint.
 *
 * The cache is per command+version under the connector store dir; the binary
 * is only replaced when its marker (pinned archive checksum + extracted
 * binary size) is missing or mismatched. Downloads are deduplicated across
 * concurrent connects.
 */
import { type CliBinaryManifest } from './cli-manifest.ts';
export interface ResolvedCommand {
    /** Executable to spawn (absolute path, or the original name). */
    command: string;
    args: string[];
    /** True when the executable is a Windows .cmd/.bat shim needing a shell. */
    shell?: boolean;
}
/** Progress callback surfaced to the connect UI (e.g. "正在下载…"). */
export type CliProgress = (message: string) => void;
export interface CliRuntimeOptions {
    /** Cache root; defaults to `<user scope>/cli` (mirrors ConnectorStore). */
    cacheDir?: string;
    /** Manifests override (tests). */
    manifests?: ReadonlyMap<string, CliBinaryManifest>;
    /** Fetch implementation override (tests). */
    fetchImpl?: typeof fetch;
    downloadTimeoutMs?: number;
    /**
     * Prefetched binaries shipped inside the application (build-time download,
     * see `dsh-plugin-desktop/scripts/prefetch-cli.mjs`). When set and the
     * bundled copy for the current platform exists, `resolve` uses it directly
     * — first connect needs no network and no download wait.
     * Layout: `<bundledDir>/<command>/<version>/<binaryName>`.
     */
    bundledDir?: string;
    /** The logged-in username; per-user scoping when omitted/missing. */
    username?: string | null;
}
export declare class CliRuntime {
    private readonly cacheDir;
    private readonly bundledDir;
    private readonly manifests;
    private readonly fetchImpl;
    private readonly downloadTimeoutMs;
    private readonly inflight;
    constructor(options?: CliRuntimeOptions);
    /**
     * Resolve a CLI command to an executable, downloading the pinned binary
     * when the command is not installed. Returns null when the runtime does not
     * provide this command (caller falls back to the raw name).
     */
    resolve(command: string, args: string[], onProgress?: CliProgress): Promise<ResolvedCommand | null>;
    /** Locate a prefetched binary in the bundled directory, if any. */
    private bundledBinary;
    /**
     * Ensure the pinned native binary for `manifest` exists in the cache,
     * downloading and extracting it when needed. Returns null on platforms the
     * manifest does not cover.
     */
    ensureBinary(manifest: CliBinaryManifest, onProgress?: CliProgress): Promise<string | null>;
    private installBinary;
    /** Derive the expected platform asset from the manifest (no network). */
    private expectedAsset;
    /** Download the pinned platform archive (tarball inner asset or direct URL). */
    private fetchPlatformArchive;
    private download;
}
/**
 * Locate `command` on PATH (Windows: PATHEXT-aware). Returns the concrete
 * file path; `.cmd`/`.bat` shims need a shell to spawn.
 */
export declare function findOnPath(command: string): Promise<{
    path: string;
    shell: boolean;
} | null>;
