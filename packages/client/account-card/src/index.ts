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
// R16B-01：会话身份的**唯一实现**（serverURL + username）。交付给渲染层的每一份
// 快照都带上它属于谁 —— 客户端只有在这一串与 `/api/pico/auth/state` 的 `identity`
// 相等时才许把金额画出来（同服务端换号后不得把上一个账号的余额渲染在新账号名下）。
import { sessionIdentity } from '@picoaide/dsh-enterprise/session-identity'
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
  // card never shows a stale balance; logout clears the cached snapshot so a
  // later login never flashes the previous account's usage.
  ctx.on('pico/session-changed', (next) => {
    if (next === null) service.clear()
    else service.refresh(next)
  })
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
      // P2-22: bind the response to the account that asked for it. A login
      // switch while the gateway round-trip was in flight must not serve the
      // previous account's snapshot to the new one — answer 401 so the card
      // hides and the renderer refetches under the new session.
      const current = session()
      if (current === null || current.username !== s.username || current.serverURL !== s.serverURL) {
        return json(res, 401, { error: 'session changed' })
      }
      // R16B-01（2026-09-25）：同服务端**换号**（A→B，不经登出）只排一次 300ms
      // 去抖的 `service.refresh(B)`。上面那条守卫比较的是"请求开始时"与"刷新后"
      // 的会话 —— 换号后**两边都已经是 B**，它抓不到"快照还是 A 取的"。
      // 归属判据只有一处：`UsageService.owns()`（键 = serverURL + username + token）。
      // 快照不属于当前账号就**宁可回空**（401 + 保留会话），绝不交付上一个账号的金额。
      if (!service.owns(s)) {
        return json(res, 401, { error: 'session changed' })
      }
      const snapshot = service.get()
      // 审计 2026-09-12 P1-5:令牌已失效时**不再 200 交付旧余额**。
      // usage-service 承诺过"the route layer maps it to a 401"但该映射
      // 从未实现 —— 结果令牌过期后账号卡继续静默展示过期金额。这里补上:
      // 401 + 清会话(与 bootstrap.ts:108-110 / auth-gate.ts:1727-1730 同款),
      // 让渲染层隐藏卡片并回登录页。
      if (snapshot.authExpired) {
        ctx.picoSession.clear()
        return json(res, 401, { error: 'auth expired' })
      }
      json(res, 200, {
        data: snapshot.data,
        fetchedAt: snapshot.fetchedAt,
        state: snapshot.state,
        error: snapshot.error,
        // R16B-01：这一份快照属于**哪个会话身份**。`s` 就是取这份快照的会话
        // （上面 `owns(s)` 已经确认），所以这里盖的是真归属而不是"当前是谁"。
        // 客户端拿它与 `/api/pico/auth/state` 的 `identity` 比 —— 不等就整份作废。
        identity: sessionIdentity(s),
      })
    },
  }), 'account-card usage route')
}
