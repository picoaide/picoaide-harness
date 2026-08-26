/**
 * Per-user scope resolution for the connectors plugin.
 *
 * The enterprise session is the product's single source of truth for "who is
 * logged in" (`picoSession` service + `pico/session-changed` event).
 * Connector credentials, CLI caches, and browser persistent partitions are
 * scoped per logged-in user so A's tokens never leak into B's session.
 *
 * Namespace layout (everything under the DSH home):
 *
 *   <dshHome>/users/<encoded-username>/connectors/   credentials + cli cache
 *
 * The username segment is filesystem-safe encoded — a gateway account name
 * may contain `/`, `..`, or OS-reserved characters, so it is never used raw.
 */
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Environment variable that overrides the product home. */
export const DSH_HOME_ENV = 'DSH_HOME'

/** Directory name of the product default Harness home under the OS home. */
export const PRODUCT_DSH_HOME_DIR = '.picoaide-harness'

/** Expand a leading ~ (or ~user) in a path, platform-style. */
export function expandHomePath(path: string, home: string = homedir()): string {
  if (path === '~') return home
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(home, path.slice(2))
  return path
}

/**
 * Resolve the single-root product Harness home.
 *
 * Precedence, highest first: an explicit configured path, `$DSH_HOME`, then
 * `~/.picoaide-harness`. Mirrors `dsh-plugin-desktop/desktop-home`
 * (duplicated here to keep this module dependency-free for consumers that
 * must not pull the desktop package at runtime).
 */
export function resolveDshHome(
  configured?: string,
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  const fromEnv = env[DSH_HOME_ENV]
  const selected = configured
    ?? (fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : join(home, PRODUCT_DSH_HOME_DIR))
  return resolve(expandHomePath(selected, home))
}

/** Join path segments onto the resolved product Harness home. */
export function dshHomePath(...segments: string[]): string {
  return join(resolveDshHome(), ...segments)
}

/** Resolve the product home from the live environment. */
export function dshHome(): string {
  return resolveDshHome()
}

/**
 * Filesystem-safe encoding of a username for a directory segment. Hex-encodes
 * every byte outside [A-Za-z0-9_-]: dots are encoded too, so the result can
 * never be `.`, `..`, empty, hidden, or contain a separator — it always
 * resolves inside the users root even for hostile (or non-ASCII) account
 * names. The `~` escape introducer is unambiguous because `~` itself is
 * encoded (`~7E~`), so the output is injective (no two inputs collide).
 *
 * CROSS-PACKAGE CONSTRAINT (2026-08-22): `@picoaide/dsh-browser`
 * `encodePartitionSegment` (electron-adapter.ts) mirrors this encoding
 * byte-for-byte (kept separate because cross-package runtime imports are
 * forbidden). Never diverge; the empty-string fallback differs on purpose
 * (`~<uuid>~` here, `anonymous` there) and cannot collide because a
 * directory segment with `~` is never equal to the literal `anonymous`.
 */
export function encodeSegment(segment: string): string {
  let out = ''
  for (const char of segment) {
    const code = char.codePointAt(0)!
    if ((code >= 0x30 && code <= 0x39)
      || (code >= 0x41 && code <= 0x5a)
      || (code >= 0x61 && code <= 0x7a)
      || char === '-' || char === '_') {
      out += char
    } else {
      out += `~${code.toString(16).toUpperCase()}~`
    }
  }
  if (out.length === 0) return `~${randomUUID()}~`
  return out
}

/**
 * Per-user scope path under the DSH home: `<dshHome>/users/<encoded-user>`.
 * A `null`/empty username yields `users/<encoded-anonymous>` so unauthenticated
 * state never collides with a real user's directory.
 */
export function userScopePath(username: string | null | undefined, env: NodeJS.ProcessEnv = process.env): string {
  const key = username !== undefined && username !== null && username.length > 0 ? username : 'anonymous'
  return join(
    resolveDshHome(undefined, env),
    'users',
    encodeSegment(key),
  )
}
