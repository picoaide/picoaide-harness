/**
 * Package-owned invariant companion for `@picoaide/dsh-branding`.
 * @module @picoaide/dsh-branding/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@picoaide/dsh-branding'

/** Cordis companion plugin name. */
export const name = 'dsh-branding-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the client half registers brand slots and swaps the
 * favicon; there is no owned cross-plugin mutable relation to check.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
