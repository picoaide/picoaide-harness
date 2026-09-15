/**
 * Token lifetime constants shared by the store, the OAuth provider and the UI.
 *
 * Kept in its own module so `store.ts` can validate `expiresAt` without
 * importing the SDK-backed provider (and so the client bundle never pulls the
 * MCP SDK in through a constant).
 */

/**
 * How long before actual expiry a token counts as stale. A call that starts
 * 30s before expiry still fails inside the request, and a refresh costs one
 * round trip, so the margin is deliberately generous.
 */
export const REFRESH_LEAD_MS = 60_000

/**
 * Sweep interval for credentials that must be refreshed while nothing calls
 * them: a stdio MCP server receives its token in the child environment at
 * spawn time and cannot recover from a 401 by itself.
 */
export const REFRESH_SWEEP_INTERVAL_MS = 60_000

/**
 * Assumed lifetime when the authorization server omits `expires_in`. Refresh
 * correctness never depends on it (the 401 path is the safety net); it only
 * decides when the proactive sweep bothers to ask.
 */
export const DEFAULT_TOKEN_LIFETIME_MS = 60 * 60 * 1000

/** `expires_in` may be a number or a numeric string; anything else is ignored. */
function expiresInMs(data: Record<string, unknown>): number {
  const raw = data.expires_in
  const seconds = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_TOKEN_LIFETIME_MS
}

/** Absolute expiry for one token response, or the assumed lifetime when absent. */
export function expiryFromResponse(data: Record<string, unknown>, now = Date.now()): number {
  return now + expiresInMs(data)
}
