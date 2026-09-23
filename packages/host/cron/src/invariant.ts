/**
 * Package-owned invariant companion for `@picoaide/dsh-cron`.
 * @module @picoaide/dsh-cron/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@picoaide/dsh-cron'

/** Cordis companion plugin name. */
export const name = 'pico-cron-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the host scheduler is the only writer of the job
 * ledger and the only trigger of scheduled executions; every mutating code
 * path goes through the serialized applyRequest seam, so revision
 * monotonicity and request idempotency are enforced there (pinned by the
 * ledger tests) rather than by a registry check. No cross-plugin mutable
 * relation is left for an invariant to observe.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
