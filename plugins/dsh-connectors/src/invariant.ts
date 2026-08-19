/**
 * Package-owned invariant companion for `@picoaide/dsh-connectors`.
 * @module @picoaide/dsh-connectors/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@picoaide/dsh-connectors'

/** Cordis companion plugin name. */
export const name = 'pico-connectors-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the connector framework owns its state in private
 * per-user files and the loopback HTTP API, and registers MCP servers as
 * ordinary Cordis fibers (registration conflicts already fail loud at load);
 * it emits no cross-plugin mutable relation an invariant could check.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
