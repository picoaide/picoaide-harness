/**
 * Per-user **and per-server** scope resolution for the connectors plugin.
 *
 * The enterprise session is the product's single source of truth for "who is
 * logged in" (`picoSession` service + `pico/session-changed` event) and for
 * "which deployment they are logged into" (`session.serverURL`). Connector
 * credentials, CLI caches, and browser persistent partitions are scoped per
 * logged-in user so A's tokens never leak into B's session.
 *
 * Namespace layout (everything under the DSH home):
 *
 *   <dshHome>/users/<encoded-username>/servers/<server-scope>/connectors/
 *
 * where `<server-scope>` is `sha256(normalized server address)[:32]`
 * ({@link serverScopeHash}) or the literal {@link UNSCOPED_SERVER_SEGMENT}
 * when the session carries no server address.
 *
 * R6-B-2 (audit 2026-09-23): the **server dimension used to be missing**. Two
 * deployments of one account (the repo's own topology runs a test and a
 * production deployment, plus two channel stacks on one host, and `/login`
 * supports re-pointing the address) shared ONE credential directory, so after
 * switching servers the previous tenant's secrets were handed to the new
 * tenant's same-id connector: a manual-token connector's `fields` (i.e. the
 * plaintext secret) were injected into the new endpoint's headers/child env,
 * and an OAuth connector's access/refresh token was presented to the new
 * endpoint as well (the SDK's `issuer` stamp only catches the case where the
 * two tenants' authorization servers differ — it does nothing for a shared
 * IdP, and nothing at all for `fields`-only connectors).
 *
 * The pre-2026-09-24 layout
 *
 *   <dshHome>/users/<encoded-username>/connectors/
 *
 * is now the **unscoped (legacy) directory**: it is never resolved as a live
 * scope, and the stored bytes are never adopted (see `ConnectorStore`), so a
 * file written by an older build can no longer be replayed against whichever
 * server the user happens to be pointed at now. The files are deliberately
 * LEFT ON DISK — the migration is fail-closed, not destructive.
 *
 * The username segment is filesystem-safe encoded — a gateway account name
 * may contain `/`, `..`, or OS-reserved characters, so it is never used raw.
 */
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'

// P2-36: the DSH-home constants/resolution used to be inlined copies of the
// single authority (`dsh-plugin-desktop/desktop-home` at the time). Re-export it
// instead, exactly like `@picoaide/dsh-cron`'s dsh-home module.
//
// 2026-09-20（构建环修复，路线 A 扩展）：权威搬到了零依赖叶子包
// `@picoaide/dsh-host-home`，本包改指它 —— 原来那条
// `connectors → dsh-plugin-desktop/desktop-home` 是真实构建环的一段
// （`desktop → wasm-apps-host → browser → connectors → desktop`），
// 改指叶子包后 connectors 不再依赖桌面包，环断开。
export {
  DSH_HOME_ENV,
  PRODUCT_DSH_HOME_DIR,
  DEFAULT_DSH_HOME_DISPLAY,
  expandHomePath,
  resolveDshHome,
  dshHome,
  dshHomePath,
} from '@picoaide/dsh-host-home'

import { resolveDshHome } from '@picoaide/dsh-host-home'

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

/**
 * The directory segment used when the session carries no server address.
 *
 * A separate segment (never the user root, never a plausible hash) is what
 * makes "we cannot tell which server this belongs to" fail closed: a session
 * without a server identity gets its own empty scope instead of silently
 * adopting the unscoped legacy directory. 32-hex hashes can never equal this
 * literal, so the two can never collide.
 */
export const UNSCOPED_SERVER_SEGMENT = 'unscoped'

/**
 * Server address → the scope segment it maps to (sha256, first 32 hex chars).
 *
 * CROSS-PACKAGE CONSTRAINT (2026-09-24): this is the SAME normalization and the
 * SAME truncation as `@picoaide/dsh-browser/surface`'s `serverPartitionHash`
 * and its mirror `@picoaide/dsh-wasm-apps-host/partition` — "one machine, two
 * deployments, two tenants" is one threat model, so it gets ONE hash. The
 * three implementations are kept in step by
 * `tests/server-scope-parity.spec.ts`, which runs the other two in a real Node
 * process and compares outputs example by example; do not invent a third
 * digest (a different truncation here would silently re-scope every user's
 * credentials on the next upgrade).
 *
 * Normalization is part of the contract: leading/trailing whitespace and
 * trailing slashes are stripped, because `https://a.example` and
 * `https://a.example/` are the same server — an address that was once saved
 * with a slash must not open a second, empty scope ("all my connectors
 * disappeared").
 * @param serverURL - the session's server address.
 * @returns 32 hex chars, or `undefined` when there is no usable address.
 */
export function serverScopeHash(serverURL: string | null | undefined): string | undefined {
  if (typeof serverURL !== 'string') return undefined
  let value = serverURL.trim()
  while (value.endsWith('/')) value = value.slice(0, -1)
  if (value === '') return undefined
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32)
}

/**
 * Scope root of one (account, server) pair:
 * `<dshHome>/users/<encoded-user>/servers/<hash|unscoped>`.
 * @param username - the logged-in account.
 * @param serverURL - the session's server address (may be missing).
 * @param env - environment used to resolve the DSH home.
 * @returns the absolute scope directory.
 */
export function serverScopePath(
  username: string | null | undefined,
  serverURL: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(userScopePath(username, env), 'servers', serverScopeHash(serverURL) ?? UNSCOPED_SERVER_SEGMENT)
}

/**
 * The live credential directory of one (account, server) pair:
 * `<server scope>/connectors`. This — not the user root — is what
 * `ConnectorStore` reads and writes.
 * @param username - the logged-in account.
 * @param serverURL - the session's server address (may be missing).
 * @param env - environment used to resolve the DSH home.
 * @returns the absolute credential directory.
 */
export function connectorScopePath(
  username: string | null | undefined,
  serverURL: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(serverScopePath(username, serverURL, env), 'connectors')
}

/**
 * The **legacy** (unscoped) credential directory:
 * `<dshHome>/users/<encoded-user>/connectors`.
 *
 * It is the pre-2026-09-24 layout and the target of {@link migrateLegacyStore}
 * (the even older single-user `~/.picoaide/connectors`). Nothing resolves it as
 * a live scope any more: the plugin only asks whether these files exist, so it
 * can tell the user "this connector needs a fresh authorization" instead of
 * quietly using a secret of unknown provenance. Those bytes must never be
 * adopted, and must never be deleted either.
 * @param username - the logged-in account.
 * @param env - environment used to resolve the DSH home.
 * @returns the absolute legacy directory.
 */
export function unscopedConnectorPath(
  username: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(userScopePath(username, env), 'connectors')
}
