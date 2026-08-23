/**
 * Package-owned invariant companion for `@picoaide/dsh-browser`.
 * @module @picoaide/dsh-browser/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@picoaide/dsh-browser'

/** Cordis companion plugin name. */
export const name = 'pico-browser-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the embedded browser owns its view hierarchy and CDP
 * sessions inside the plugin fiber, and registers ordinary Cordis tools
 * (conflicting registrations already fail loud at load); it emits no
 * cross-plugin mutable relation an invariant could check.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
