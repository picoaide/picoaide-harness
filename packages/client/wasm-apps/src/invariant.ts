/**
 * Package-owned invariant companion for `@picoaide/dsh-wasm-apps`.
 * @module @picoaide/dsh-wasm-apps/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@picoaide/dsh-wasm-apps'

/** Cordis companion plugin name. */
export const name = 'dsh-wasm-apps-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the host half owns no mutable relation (the local API
 * lives in `@picoaide/dsh-enterprise`), and the client half only renders the
 * server-provided catalog and hands entry links to a browser. The catalogue's
 * visibility rule is the server's (`§4.8`/R38) — a client-side invariant would
 * be a second, weaker copy of it.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
