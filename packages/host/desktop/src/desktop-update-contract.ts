/**
 * Largest delay one timer may be given, in milliseconds.
 *
 * Node (and therefore Electron) stores a `setTimeout` delay in a 32-bit signed
 * integer; anything above this bound is **clamped to 1 ms** and reported through
 * a `TimeoutOverflowWarning`. A retry configured as "try again in ~24.8 days"
 * would therefore become "retry immediately" — silently, because that warning is
 * not surfaced to the user.
 *
 * The value handed to `setTimeout` is the **jittered** delay, never the
 * configured one, so the bound has to be applied after the jitter (see
 * {@link updateRetryDelayMs}). Capping the configuration alone leaves the cap
 * reachable from below: `base = MAX_TIMER_DELAY_MS` with `jitterRatio = 1` is a
 * combination the config schema itself allows, and symmetric jitter pushes it to
 * `1.5 × MAX` (R13-E-P3). This export is the ONE constant for both uses — the
 * schema's per-field maximum and the clamp — so the two cannot drift apart.
 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

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
 * 客户端只从登录的那台服务端取更新，未登录不是网络故障，不能报成网络错误。
 * `storage`（B-07，2026-09-23）是**本地永久失败**（磁盘满/配额、权限、只读挂载、
 * 路径形态不可用）：重试不会成功，也不能告诉用户"网络问题"。 */
export type DesktopUpdateErrorCategory =
  | 'network'
  | 'not-signed-in'
  | 'release-missing'
  | 'server-unavailable'
  | 'unsupported'
  | 'checksum-mismatch'
  | 'invalid-artifact'
  | 'storage'

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
 *
 * **The 32-bit bound is applied to the returned value, i.e. AFTER the jitter**
 * (R13-E-P3). The jitter is symmetric — `base ± spread/2` — so `base = MAX` with
 * `jitterRatio = 1` (both accepted by the config schema) produces `1.5 × MAX`,
 * which `setTimeout` silently clamps to 1 ms: a "retry in ~24.8 days" became
 * "retry right now". Clamping here, where the value is produced, is the only
 * place that sees the final number.
 * @param policy - bounded retry policy.
 * @param attempt - attempt that just failed (1 for the initial attempt).
 * @param seed - stable per-operation seed, normally the version under transfer.
 * @returns delay in milliseconds, always within `[0, MAX_TIMER_DELAY_MS]`.
 */
export function updateRetryDelayMs(
  policy: UpdateRetryPolicy,
  attempt: number,
  seed: string,
): number {
  if (policy.delaysMs.length === 0) return 0
  const base = policy.delaysMs[Math.min(Math.max(attempt, 1), policy.delaysMs.length) - 1] ?? 0
  if (base <= 0 || policy.jitterRatio <= 0) return clampTimerDelay(base)
  const bucketCount = 100
  // FNV-1a over the seed and attempt: stable, cheap, and dependency-free.
  let hash = 0x811c9dc5
  for (const character of `${seed}#${String(attempt)}`) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  const spread = Math.round(base * policy.jitterRatio)
  const offset = spread === 0 ? 0 : ((hash % (bucketCount + 1)) / bucketCount) * spread - spread / 2
  return clampTimerDelay(Math.round(base + offset))
}

/**
 * Clamp one delay into the range `setTimeout` can actually honour.
 *
 * Shared by every return path of {@link updateRetryDelayMs} so "what the policy
 * produced" and "what the timer will be given" are the same number: a negative
 * or over-32-bit delay is a scheduling bug either way, and the caller has no
 * second chance to notice (the clamp inside Node is invisible and becomes 1 ms).
 * @param value - delay the policy computed, in milliseconds.
 * @returns the delay, never below 0 and never above {@link MAX_TIMER_DELAY_MS}.
 */
function clampTimerDelay(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(MAX_TIMER_DELAY_MS, Math.max(0, value))
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
