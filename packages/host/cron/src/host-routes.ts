/**
 * Same-origin HTTP routes for the cron API: state snapshot, action POST, and
 * SSE events. All three share one trust fence: a browser same-origin marker
 * plus the loopback socket/Host/origin-equality checks. No lenient CORS
 * headers are ever returned.
 *
 * R4-RV3a：`guard()` 只能挡裸 curl，自述边界就是"伪造 Origin 的 curl 也能过"。
 * 因此写入面（`action`）在 `guard()` 之上再要一份 BrowserAuth 持有性证明
 * （见 `write-proof.ts`）；读面（`state` / `events`）维持 `guard()`。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { HostCronService } from './host-service.ts'
import { browserSameOriginMarker, isLoopbackRequest } from './loopback.ts'
import { parseActionEnvelope, CRON_API_PREFIX } from './protocol.ts'
import { WRITE_PROOF_HINT, requireWriteProof, type ConnectionTrustFence, type WriteProofDeps } from './write-proof.ts'

const ACTION_LIMIT = 64 * 1024
const HEARTBEAT_MS = 15_000

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage, limit: number): Promise<{ raw: string; value: unknown }> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > limit) throw new Error('body-too-large')
    chunks.push(buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  return { raw, value: JSON.parse(raw) }
}

/**
 * Host-side collaborators of the routes. `permissions` returns the composed
 * permission-preset roster for request validation (FIX-17). `fence` supplies
 * the BrowserAuth proof-of-possession source for write routes; a missing fence
 * fails closed (503), never falls back to `guard()`.
 */
export interface CronRouteOptions {
  permissions?: () => readonly string[]
  /** 写面证明来源（`ctx.get('connection')`）；缺省 = 证明机制缺席 ⇒ 写面 503。 */
  fence?: () => ConnectionTrustFence | undefined
  /** 证明拒绝的插件日志。 */
  warn?: (message: string) => void
  /**
   * 这批路由的**生命周期信号**（R16B-13）。abort ⇒ 所有仍然打开的 SSE 流被
   * `end()` 收尾。
   *
   * 为什么必须由调用方给：`ctx.webServer.register()` 返回的 disposer 只把路径从
   * 路由表里删掉，**对已经建立的连接一无所知** —— 而 `/api/cron/events` 是一条
   * 长连接：插件卸载（HMR / 组合变更 / 退出）之后它仍在每 15s 收 `: ping` 且永不
   * `end()`。对端是 `EventSource`：**收不到 onerror 就不会回落到轮询**，界面于是
   * 静默冻结（任务列表停在上一次推送的样子，看起来像"没有新任务"）。
   * 缺席时保持旧行为（不主动收尾）——但生产装配必须传（`src/index.ts` 的 effect）。
   */
  lifecycle?: AbortSignal
}

export function makeCronRoutes(service: HostCronService, options: CronRouteOptions = {}): WebRoute[] {
  const guard = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (browserSameOriginMarker(req) && isLoopbackRequest(req)) return true
    json(res, 403, { ok: false, error: 'forbidden' })
    return false
  }
  const proofDeps: WriteProofDeps = {
    fence: options.fence ?? ((): undefined => undefined),
    label: 'pico-cron',
    ...(options.warn === undefined ? {} : { warn: options.warn }),
  }
  const state: WebRoute = {
    kind: 'exact',
    path: `${CRON_API_PREFIX}/state`,
    handler: (req, res): void => {
      if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' })
      if (!guard(req, res)) return
      json(res, 200, service.snapshot())
    },
  }
  const action: WebRoute = {
    kind: 'exact',
    path: `${CRON_API_PREFIX}/action`,
    handler: async (req, res): Promise<void> => {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
      if (!guard(req, res)) return
      // R4-RV3a：拿不到持有性证明就不进校验/解析/service.apply——伪造头的本机
      // 进程既写不了 ledger，也触发不了 run。
      const proof = requireWriteProof(req, proofDeps)
      if (!proof.ok) {
        return json(res, proof.status, { ok: false, error: proof.error, hint: WRITE_PROOF_HINT })
      }
      if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
        return json(res, 415, { ok: false, error: 'json-required' })
      }
      try {
        const body = await readBody(req, ACTION_LIMIT)
        const parsed = parseActionEnvelope(body.value, { permissions: options.permissions?.() ?? [] })
        if (parsed === undefined) return json(res, 400, { ok: false, error: 'invalid-action' })
        json(res, 200, service.apply(parsed.requestId, parsed.action))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        json(res, message === 'body-too-large' ? 413 : 400, { ok: false, error: message })
      }
    },
  }
  const permissions: WebRoute = {
    kind: 'exact',
    path: `${CRON_API_PREFIX}/permissions`,
    handler: (req, res): void => {
      if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' })
      if (!guard(req, res)) return
      json(res, 200, { permissions: [...(options.permissions?.() ?? [])] })
    },
  }
  const events: WebRoute = {
    kind: 'exact',
    path: `${CRON_API_PREFIX}/events`,
    handler: (req, res): void => {
      if (req.method !== 'GET') {
        res.writeHead(405)
        res.end()
        return
      }
      if (!guard(req, res)) return
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      const push = (): void => {
        const payload = service.eventPayload()
        res.write(`data: ${JSON.stringify(payload)}\n\n`)
      }
      const unsubscribe = service.subscribe(push)
      const heartbeat = setInterval(() => { res.write(': ping\n\n') }, HEARTBEAT_MS)
      let closed = false
      /**
       * 收尾（幂等）。`endStream` = 这是一次**宿主主动收尾**，必须让对端看见流结束
       * （R16B-13）；对端自己断开时（req/res 的 close）不需要再 end 一次，而且那时
       * `end()` 可能抛（socket 已销毁）—— 所以两条路径分开。
       */
      const close = (endStream: boolean): void => {
        if (closed) return
        closed = true
        clearInterval(heartbeat)
        unsubscribe()
        options.lifecycle?.removeEventListener('abort', onLifecycleAbort)
        if (endStream) {
          try { res.end() } catch { /* 对端已经没了：无需再收尾 */ }
        }
      }
      const onLifecycleAbort = (): void => { close(true) }
      options.lifecycle?.addEventListener('abort', onLifecycleAbort, { once: true })
      req.once('close', () => close(false))
      res.once('close', () => close(false))
      push()
    },
  }
  return [state, action, events, permissions]
}
