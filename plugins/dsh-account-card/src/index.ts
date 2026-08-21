/**
 * Host plugin for `@picoaide/dsh-account-card`: keeps the gateway usage
 * snapshot fresh (on login/session change and after every completed agent
 * loop) and serves it to the client half through the loopback-only local
 * route `/api/pico/account/usage`.
 * @module @picoaide/dsh-account-card
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the agent event declarations (`agent/status`) into the
// compilation face so `ctx.on` resolves against the typed event map.
import type {} from '@deepseek-ai/dsh-agent'
// Type-only: declares the `webServer` service (`webServer.register`).
import type {} from '@deepseek-ai/dsh-host-webserver'
// Type-only: declares the `picoSession` service and `pico/session-changed`.
import type {} from '@picoaide/dsh-enterprise/session-service'
import type { Session } from '@picoaide/dsh-enterprise/server-connector/config'
import {
  browserSameOriginMarker,
  isLoopbackRequest,
} from '@picoaide/dsh-enterprise/loopback'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { UsageService } from './usage-service.ts'

export interface Config {}

/** Stable Cordis plugin name. */
export const name = 'dsh-account-card'

/** Services required: the local web server (route) and the enterprise session. */
export const inject = ['webServer', 'picoSession']

/** Loopback + same-origin trust fence, mirroring the enterprise auth-gate. */
function guard(req: IncomingMessage, res: ServerResponse): boolean {
  if (browserSameOriginMarker(req) && isLoopbackRequest(req)) return true
  json(res, 403, { error: 'forbidden' })
  return false
}

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/**
 * Register the account-card host half: refresh triggers (session change,
 * startup restore, every agent loop completion) and the local usage route.
 * @param ctx - Cordis context with webServer + picoSession.
 */
export function apply(ctx: Context): void {
  const service = new UsageService()
  const session = (): Session | null => ctx.picoSession.getSession()

  // Login/logout and startup restore: refresh immediately after login so the
  // card never shows a stale balance.
  ctx.on('pico/session-changed', (next) => { service.refresh(next) })
  if (session() !== null) service.refresh(session())

  // Refresh after every completed agent loop. `agent/status` transitions to
  // `idle` exactly when a running loop finishes; the debounce collapses bursts
  // (parallel sessions finishing together) into one gateway call.
  ctx.on('agent/status', ({ status }) => {
    if (status === 'idle') service.refresh(session())
  })

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/pico/account/usage',
    handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
      if (!guard(req, res)) return
      const s = session()
      if (s === null) return json(res, 401, { error: 'not logged in' })
      // `?refresh=1` forces an immediate gateway round-trip (manual button);
      // a plain GET serves the cached snapshot only (client polling must not
      // hit the gateway every 10s — P1-9).
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.searchParams.has('refresh')) {
        await service.refreshNow(s)
      }
      const snapshot = service.get()
      json(res, 200, {
        data: snapshot.data,
        fetchedAt: snapshot.fetchedAt,
        state: snapshot.state,
        error: snapshot.error,
      })
    },
  }), 'account-card usage route')
}
