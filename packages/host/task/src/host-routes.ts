/**
 * Same-origin HTTP routes for the task API: state snapshot, action POST, and
 * SSE events. All three share one trust fence: a browser same-origin marker
 * plus the loopback socket/Host/origin-equality checks. No lenient CORS
 * headers are ever returned.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { HostTaskService } from './host-service.ts'
import { browserSameOriginMarker, isLoopbackRequest } from './loopback.ts'
import { parseActionEnvelope, TASK_API_PREFIX } from './protocol.ts'

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

export function makeTaskRoutes(service: HostTaskService): WebRoute[] {
  const guard = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (browserSameOriginMarker(req) && isLoopbackRequest(req)) return true
    json(res, 403, { ok: false, error: 'forbidden' })
    return false
  }
  const state: WebRoute = {
    kind: 'exact',
    path: `${TASK_API_PREFIX}/state`,
    handler: (req, res): void => {
      if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' })
      if (!guard(req, res)) return
      json(res, 200, service.snapshot())
    },
  }
  const action: WebRoute = {
    kind: 'exact',
    path: `${TASK_API_PREFIX}/action`,
    handler: async (req, res): Promise<void> => {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
      if (!guard(req, res)) return
      if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
        return json(res, 415, { ok: false, error: 'json-required' })
      }
      try {
        const body = await readBody(req, ACTION_LIMIT)
        const parsed = parseActionEnvelope(body.value)
        if (parsed === undefined) return json(res, 400, { ok: false, error: 'invalid-action' })
        json(res, 200, service.apply(parsed.requestId, parsed.action))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        json(res, message === 'body-too-large' ? 413 : 400, { ok: false, error: message })
      }
    },
  }
  const events: WebRoute = {
    kind: 'exact',
    path: `${TASK_API_PREFIX}/events`,
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
        const payload = service.ledger.summary()
        res.write(`data: ${JSON.stringify(payload)}\n\n`)
      }
      const unsubscribe = service.subscribe(push)
      const heartbeat = setInterval(() => { res.write(': ping\n\n') }, HEARTBEAT_MS)
      const close = (): void => {
        clearInterval(heartbeat)
        unsubscribe()
      }
      req.once('close', close)
      res.once('close', close)
      push()
    },
  }
  return [state, action, events]
}
