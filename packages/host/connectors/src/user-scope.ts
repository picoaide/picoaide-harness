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
import { join } from 'node:path'

// P2-36: the DSH-home constants/resolution used to be inlined copies of
// `dsh-plugin-desktop/desktop-home` (the single authority). Re-export them
// instead, exactly like `@picoaide/dsh-cron`'s dsh-home module. tsdown bundles
// the module into this package's lib, so consumers still need no runtime
// dependency on the desktop package.
export {
  DSH_HOME_ENV,
  PRODUCT_DSH_HOME_DIR,
  DEFAULT_DSH_HOME_DISPLAY,
  expandHomePath,
  resolveDshHome,
  dshHome,
  dshHomePath,
} from 'dsh-plugin-desktop/desktop-home'

import { resolveDshHome } from 'dsh-plugin-desktop/desktop-home'

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
