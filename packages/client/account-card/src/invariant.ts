/**
 * Package-owned invariant companion for `@picoaide/dsh-account-card`.
 * @module @picoaide/dsh-account-card/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@picoaide/dsh-account-card'

/** Cordis companion plugin name. */
export const name = 'dsh-account-card-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the host half reacts to the session service and the
 * agent status event, the client half renders a portalled card through the
 * sidebar foot slot; there is no owned cross-plugin mutable relation an
 * invariant could check.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
