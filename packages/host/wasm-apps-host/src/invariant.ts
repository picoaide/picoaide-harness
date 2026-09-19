/**
 * Package-owned invariant companion for `@picoaide/dsh-wasm-apps-host`.
 * @module @picoaide/dsh-wasm-apps-host/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@picoaide/dsh-wasm-apps-host'

/** Cordis companion plugin name. */
export const name = 'pico-wasm-apps-host-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this plugin owns no cross-plugin mutable relation. Its
 * whole surface is (a) protocol handlers registered on Electron sessions via an
 * injected adapter, (b) one exact local route, and (c) read-only probes of
 * `picoSession`/`desktopRuntime`. Conflicting registrations already fail loud at
 * load (Electron throws on a duplicate `protocol.handle`; the web server throws
 * on a duplicate exact route).
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
