/**
 * Session-generation inventory for the diagnostic archive (2026-09-12, P1-12).
 *
 * "The session is gone" reports used to be unanswerable from an exported
 * diagnostic zip: it only carried logs, Crashpad dumps, and the active-run
 * marker. This walker adds **metadata only** — which generation files exist per
 * session directory, their sizes and timestamps, and whether the write-lock
 * file is present — so a v0/v3 generation split or a failed migration is
 * visible without shipping conversation content (privacy) or large artifacts
 * (size).
 *
 * The walk is strictly read-only, never follows a symlink out of the session
 * root, and truncates instead of throwing when a bound is reached.
 */

import { lstatSync, readdirSync, realpathSync, type Stats } from 'node:fs'
import { join, sep } from 'node:path'

/** Version of the `session-inventory.json` document shape. */
export const SESSION_INVENTORY_SCHEMA_VERSION = 1

/** File name of the JSONL backend's write lease inside one session directory. */
export const SESSION_LOCK_FILENAME = 'session.lock'

/** Every bound is a truncation point, never an error. */
export interface SessionInventoryLimits {
  /** Maximum number of session directories described in one inventory. */
  readonly maxSessions: number
  /** Maximum number of generation files listed per session directory. */
  readonly maxFilesPerSession: number
  /** Maximum summed generation-file bytes accounted before the walk stops. */
  readonly maxScannedBytes: number
}

/** Default bounds: ample for a real install, small enough for one zip entry. */
export const DEFAULT_SESSION_INVENTORY_LIMITS: SessionInventoryLimits = {
  maxSessions: 2_000,
  maxFilesPerSession: 64,
  maxScannedBytes: 64 * 1024 * 1024,
}

/** One immutable session generation artifact. */
export interface SessionInventoryFile {
  /** File name inside the session directory, e.g. `session.jsonl.zstd`. */
  readonly name: string
  /** Parsed format generation (`session.jsonl[.zstd]` is 0); omitted for odonyms. */
  readonly generation?: number
  /** Size in bytes at inventory time. */
  readonly bytes: number
  /** Last modification time, ISO-8601. */
  readonly modifiedAt: string
}

/** One session directory's generation metadata. */
export interface SessionInventorySession {
  /** Project directory (`--data-repo--`, `_no-cwd`, …) owning the session. */
  readonly project: string
  /** Session directory name (the session id, path-encoded). */
  readonly id: string
  readonly files: readonly SessionInventoryFile[]
  /** Whether `session.lock` (the flock write lease) exists. */
  readonly lockPresent: boolean
}

/** The exported `session-inventory.json` document. */
export interface SessionInventory {
  readonly schemaVersion: number
  /** Inventory creation time, ISO-8601. */
  readonly generatedAt: string
  /** Session root that was walked (`<DSH_HOME>/sessions`). */
  readonly sessionsRoot: string
  /** False when the root is absent, linked, not a directory, or unreadable. */
  readonly available: boolean
  /** Session directories, sorted by project then session name. */
  readonly sessions: readonly SessionInventorySession[]
  readonly totals: {
    readonly sessions: number
    readonly files: number
    readonly bytes: number
  }
  readonly limits: SessionInventoryLimits
  /** True when any bound stopped the walk early. */
  readonly truncated: boolean
  /** One-line statement of what this file does and does not contain. */
  readonly privacy: string
}

/** Options for {@link collectSessionInventory}. */
export interface SessionInventoryOptions {
  readonly limits?: Partial<SessionInventoryLimits>
  /** Clock seam for tests; defaults to the wall clock. */
  readonly now?: number
}

/** Canonical generation file names at or below format v3 (`v0` is untagged). */
const GENERATION_FILENAME = /^session(?:\.v([1-9][0-9]*))?\.jsonl(?:\.zstd)?$/u

const PRIVACY_NOTE = 'metadata only: session ids, project directory names, generation file names, '
  + 'sizes, and modification times; session contents are never read or exported'

function sortedNames(directory: string): string[] {
  try {
    return readdirSync(directory).sort((a, b) => a.localeCompare(b, 'en'))
  } catch {
    // An unreadable directory contributes nothing; the walk stays best-effort
    // because a missing inventory is worse than a partial one.
    return []
  }
}

function safeStats(path: string): Stats | undefined {
  try {
    return lstatSync(path)
  } catch {
    return undefined
  }
}

/**
 * Is `path` a real directory (not a symlink/junction) that still resolves
 * inside the session root? The lstat rejects links; the realpath check rejects
 * a directory that reached outside the root through any other indirection.
 * @param path - candidate child directory.
 * @param rootReal - realpath of the session root.
 * @returns whether the directory may be read as part of the inventory.
 */
function containedDirectory(path: string, rootReal: string): boolean {
  const stats = safeStats(path)
  if (stats === undefined || stats.isSymbolicLink() || !stats.isDirectory()) return false
  try {
    const real = realpathSync(path)
    return real === rootReal || real.startsWith(rootReal.endsWith(sep) ? rootReal : `${rootReal}${sep}`)
  } catch {
    return false
  }
}

function generationOf(name: string): number | undefined {
  const match = GENERATION_FILENAME.exec(name)
  if (match === null) return undefined
  return match[1] === undefined ? 0 : Number(match[1])
}

/**
 * Walk one session root and describe every session directory's generation
 * files. Read-only; a missing root yields an empty, non-throwing inventory.
 * @param sessionsDir - the session root, normally `<DSH_HOME>/sessions`.
 * @param options - limits and clock overrides.
 * @returns the inventory document to publish as `session-inventory.json`.
 */
export function collectSessionInventory(
  sessionsDir: string,
  options: SessionInventoryOptions = {},
): SessionInventory {
  const limits: SessionInventoryLimits = { ...DEFAULT_SESSION_INVENTORY_LIMITS, ...options.limits }
  const generatedAt = new Date(options.now ?? Date.now()).toISOString()
  const sessions: SessionInventorySession[] = []
  let truncated = false
  let scannedBytes = 0
  let fileCount = 0

  const rootStats = safeStats(sessionsDir)
  let rootReal: string | undefined
  if (rootStats !== undefined && !rootStats.isSymbolicLink() && rootStats.isDirectory()) {
    try {
      rootReal = realpathSync(sessionsDir)
    } catch {
      rootReal = undefined
    }
  }

  if (rootReal !== undefined) {
    walk: for (const project of sortedNames(sessionsDir)) {
      const projectPath = join(sessionsDir, project)
      if (!containedDirectory(projectPath, rootReal)) continue
      for (const id of sortedNames(projectPath)) {
        if (sessions.length >= limits.maxSessions) {
          truncated = true
          break walk
        }
        const sessionPath = join(projectPath, id)
        if (!containedDirectory(sessionPath, rootReal)) continue
        const files: SessionInventoryFile[] = []
        let lockPresent = false
        for (const name of sortedNames(sessionPath)) {
          if (name === SESSION_LOCK_FILENAME) {
            lockPresent = true
            continue
          }
          const generation = generationOf(name)
          if (generation === undefined) continue
          const stats = safeStats(join(sessionPath, name))
          if (stats === undefined || stats.isSymbolicLink() || !stats.isFile()) continue
          if (files.length >= limits.maxFilesPerSession) {
            truncated = true
            continue
          }
          files.push({
            name,
            ...(generation === 0 ? {} : { generation }),
            bytes: stats.size,
            modifiedAt: new Date(stats.mtimeMs).toISOString(),
          })
          fileCount += 1
          scannedBytes += stats.size
          if (scannedBytes > limits.maxScannedBytes) {
            truncated = true
            break walk
          }
        }
        sessions.push({ project, id, files, lockPresent })
      }
    }
  }

  return {
    schemaVersion: SESSION_INVENTORY_SCHEMA_VERSION,
    generatedAt,
    sessionsRoot: sessionsDir,
    available: rootReal !== undefined,
    sessions,
    totals: { sessions: sessions.length, files: fileCount, bytes: scannedBytes },
    limits,
    truncated,
    privacy: PRIVACY_NOTE,
  }
}
