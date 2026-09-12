/** Same-origin endpoint serving the live desktop update badge snapshot. */
export const DESKTOP_UPDATE_PATH = '/api/pico/desktop/update'

/** Same-origin endpoint triggering a renderer-initiated manual update check. */
export const DESKTOP_UPDATE_CHECK_PATH = '/api/pico/desktop/update/check'

/** Same-origin endpoint handing one already-downloaded installer to the platform installer. */
export const DESKTOP_UPDATE_INSTALL_PATH = '/api/pico/desktop/update/install'

/** Update badge state served to the renderer. */
export interface DesktopUpdateStateResponse {
  /** Version reported available by the last completed check, if newer and downloadable. */
  readonly availableVersion: string | undefined
  /** Version currently downloading (including the wait between retry attempts). */
  readonly downloadingVersion: string | undefined
  /** Whether the running executable came from an Electron package. */
  readonly isPackaged: boolean
  /** Whether this platform has a fixed installer download endpoint. */
  readonly canDownload: boolean
  /** Installed desktop product version. */
  readonly currentVersion: string
  /** Current download progress (bytes) while downloading; undefined otherwise. */
  readonly downloadProgress: UpdateDownloadProgressState | undefined
  /** Version whose installer is fully downloaded and verified, ready to install. */
  readonly readyVersion: string | undefined
  /** Absolute path of the verified installer behind `readyVersion`. */
  readonly readyPath: string | undefined
  /**
   * Download attempt in progress: 1 for the first try, 2 for the first retry.
   * Zero while no installer transfer is running.
   */
  readonly retryAttempt: number
  /** Total attempts one installer transfer may spend (initial attempt included). */
  readonly retryMaxAttempts: number
  /** Milliseconds until the next automatic attempt; 0 while an attempt is running. */
  readonly retryDelayMs: number
  /** Last user-visible failure category; cleared by the next successful check/download.
   * Transient transport failures are retried internally and only surface here once the
   * attempt budget is exhausted. */
  readonly lastError: DesktopUpdateErrorCategory | undefined
}

/** Failure categories surfaced to the user for update checks and downloads.
 * `checksum-*`/`invalid-artifact` are download-time causes that used to be
 * flattened into `network` (P2-63). `not-signed-in` 是"还没有可问的服务端"——
 * 客户端只从登录的那台服务端取更新，未登录不是网络故障，不能报成网络错误。 */
export type DesktopUpdateErrorCategory =
  | 'network'
  | 'not-signed-in'
  | 'release-missing'
  | 'server-unavailable'
  | 'unsupported'
  | 'checksum-mismatch'
  | 'invalid-artifact'

/** Byte-level download progress served to the renderer badge. */
interface UpdateDownloadProgressState {
  /** Bytes received so far. */
  readonly receivedBytes: number
  /** Total expected bytes (content-length), or undefined when unknown. */
  readonly totalBytes: number | undefined
}

/**
 * Bounded retry policy shared by the manifest check and the installer transfer.
 *
 * The delays are indexed by the attempt that just failed, so `delaysMs[0]` waits
 * after the first failure. Callers may supply a shorter list than `maxAttempts`;
 * the last value then repeats.
 */
export interface UpdateRetryPolicy {
  /** Total attempts per operation, the initial attempt included. At least 1. */
  readonly maxAttempts: number
  /** Backoff before each retry, in milliseconds. */
  readonly delaysMs: readonly number[]
  /** Deterministic jitter per retry, as a fraction of that retry's delay (0–1). */
  readonly jitterRatio: number
}

/**
 * Wait before the given retry attempt.
 *
 * Jitter is derived from the attempt number instead of randomness so that one
 * update flow produces the same schedule on every client and in every test: the
 * purpose is only to keep many clients from retrying on the same millisecond.
 * @param policy - bounded retry policy.
 * @param attempt - attempt that just failed (1 for the initial attempt).
 * @param seed - stable per-operation seed, normally the version under transfer.
 * @returns delay in milliseconds.
 */
export function updateRetryDelayMs(
  policy: UpdateRetryPolicy,
  attempt: number,
  seed: string,
): number {
  if (policy.delaysMs.length === 0) return 0
  const base = policy.delaysMs[Math.min(Math.max(attempt, 1), policy.delaysMs.length) - 1] ?? 0
  if (base <= 0 || policy.jitterRatio <= 0) return Math.max(0, base)
  const bucketCount = 100
  // FNV-1a over the seed and attempt: stable, cheap, and dependency-free.
  let hash = 0x811c9dc5
  for (const character of `${seed}#${String(attempt)}`) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  const spread = Math.round(base * policy.jitterRatio)
  const offset = spread === 0 ? 0 : ((hash % (bucketCount + 1)) / bucketCount) * spread - spread / 2
  return Math.max(0, Math.round(base + offset))
}

/** Empty snapshot before the update coordinator has produced any state. */
export function emptyDesktopUpdateState(): DesktopUpdateStateResponse {
  return {
    availableVersion: undefined,
    downloadingVersion: undefined,
    isPackaged: false,
    canDownload: false,
    currentVersion: '',
    downloadProgress: undefined,
    readyVersion: undefined,
    readyPath: undefined,
    retryAttempt: 0,
    retryMaxAttempts: 1,
    retryDelayMs: 0,
    lastError: undefined,
  }
}
