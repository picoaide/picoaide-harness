/**
 * Host plugin for `@picoaide/dsh-account-card`: keeps the gateway usage
 * snapshot fresh (on login/session change and after every completed agent
 * loop) and serves it to the client half through the loopback-only local
 * route `/api/pico/account/usage`.
 *
 * 信任边界是**两级**（FIX-42②，AB1-04）：
 *  1. 回环 socket + 回环 Host + 浏览器同源标记（`guard()`）——本机任意进程伪造
 *     `Origin` 就能过，它自述如此（`loopback.ts`）；
 *  2. **持有性证明**（`acceptConsumingProof`）——只有"由本进程服务、经 launch
 *     token 换过票的页面"持有的 `dsh-auth-*` cookie 才过。本路由的 `?refresh=1`
 *     与 `authExpired` 分支是写（往返网关 / 清会话），所以走第 2 级；纯读的缓存
 *     快照交付只走第 1 级（"GET 读面豁免"）。
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
  acceptWriteProof,
  browserSameOriginMarker,
  isLoopbackRequest,
  type ConnectionTrustFence,
  type WriteProofDeps,
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

/**
 * 消费型证明闸（FIX-36 在 `packages/host/desktop/src/loop-notify-route.ts` 建立的
 * 形态）：共享闸 `acceptWriteProof` 的契约是"**GET 读面豁免**"，而本路由的
 * `?refresh=1` **消费**（立刻往返网关），`authExpired` 分支还会**清会话** —— 两条
 * 都是写，落在它的豁免面之外。闸门只读 `method` 与 `headers`，因此用一份非 GET 的
 * 方法视图复用同一份实现：状态码（403/503）、错误信封、hint 与 fail-closed 行为
 * 都只有一处定义（规范实现在零依赖叶子 `@picoaide/dsh-host-locale/loopback`，
 * 经 `@picoaide/dsh-enterprise/loopback` 这个**既有**子路径到达本包）。
 *
 * 为什么不能直接复用 desktop 那份：`dsh-plugin-desktop` 在
 * `scripts/check-workspaces.mjs` 里声明了 `needs: ['@picoaide/dsh-account-card']`
 * （desktop → account-card 是既有构建边），本包反向 import 会成环。
 * @param req - 进入闸门的请求（只读 headers）。
 * @param res - 拒绝时写出的响应。
 * @param proof - 证明依赖；未接线 ⇒ fail-closed 503。
 * @returns 请求持有证明、可以继续时为 true。
 */
function acceptConsumingProof(
  req: IncomingMessage,
  res: ServerResponse,
  proof: WriteProofDeps | undefined,
): boolean {
  const nonGetView = { method: 'POST', headers: req.headers }
  return acceptWriteProof(nonGetView as unknown as IncomingMessage, res, proof)
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

  // R4-RV3a 族的持有性证明依赖：fence 每请求求值（`connection` 可能晚于路由注册
  // 出现）；未接线/服务缺席一律 fail-closed，不退回 `guard()` 的同源标记。
  const proof: WriteProofDeps = {
    fence: (): ConnectionTrustFence | undefined =>
      (ctx as unknown as { get?: (name: string) => unknown }).get?.('connection') as ConnectionTrustFence | undefined,
    label: 'dsh-account-card',
    warn: (message: string): void => { ctx.logger?.warn?.(message) },
  }

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
      const url = new URL(req.url ?? '/', 'http://localhost')
      // 本路由有**两条状态变更分支**，只要这一发请求会走到其中任何一条，就必须持
      // 持有性证明（FIX-42②，AB1-04）：
      //  ① `?refresh=1` 立刻往返网关（消费）；② `authExpired` 分支清会话。
      // 少了这一步，本机任意进程一个**伪造 Origin 的裸 GET**（无需 cookie）就能以
      // 任意速率往返网关 —— `UsageService` 的 single-flight 只挡**并发**不挡速率，
      // AB1 实测连发 5 次 = 5 次网关往返。纯读（交付缓存快照）**不**要求证明：那
      // 正是 `acceptWriteProof` 的"GET 读面豁免"口径，不要硬挂。
      //
      // `authExpired` 的读法必须与后面清会话时的那一次同源：`refresh=1` 时证明已经
      // 在前；`refresh` 缺席时这一发请求在清会话之前没有 await ⇒ 读到的就是终值。
      const forceRefresh = url.searchParams.has('refresh')
      if ((forceRefresh || service.get().authExpired) && !acceptConsumingProof(req, res, proof)) return
      if (forceRefresh) {
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
      // 401 + 清会话,让渲染层隐藏卡片并回登录页。
      //
      // 审计 2026-09-26 R23-W2-03:**清会话必须走 `clearIfCurrent(那次请求用的令牌)`**,
      // 不能无条件 `clear()`。`?refresh=1` 这一次请求在网关往返期间,用户可能以**同一
      // 账号同一服务端**重新登录(新令牌):三个既有守卫全部放行(`username`/`serverURL`
      // 相同;`owns(s)` 因 300ms 去抖尚未换快照而仍为真)⇒ 无条件 `clear()` 会把**刚建立
      // 的新会话**连同刚写下的新令牌一起删掉,用户"刚登录又被弹回登录页"、反复重登无效,
      // 且 `$DSH_HOME/session.json` 被删。同族三处数据面(`bootstrap.ts:113`、
      // `wasm-apps.ts:555/1249`)与 auth-gate 的 13 处在这之前已改成本形态,这一处是漏网
      // 的最后一处。反向语义不变:当前令牌**就是**那次请求用的令牌 ⇒ 真失效照样三件一起清。
      if (snapshot.authExpired) {
        ctx.picoSession.clearIfCurrent(s.token)
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
