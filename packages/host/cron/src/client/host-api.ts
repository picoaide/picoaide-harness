/**
 * Browser transport for the cron API: full snapshot bootstrap, idempotent
 * action submission, and SSE change hints. The Host snapshot is the only
 * confirmed UI state; the browser never writes unconfirmed state.
 */
import type { CronAction, CronEventPayload, CronSnapshot } from '../protocol.ts'

export interface CronTransport {
  bootstrap(): Promise<CronSnapshot>
  state(): Promise<CronSnapshot>
  action(action: CronAction): Promise<CronSnapshot>
  subscribe(listener: (event?: CronEventPayload) => void): () => void
}

function parseSnapshot(value: unknown): CronSnapshot {
  if (typeof value !== 'object' || value === null) throw new Error('invalid snapshot')
  const snapshot = value as CronSnapshot
  if (snapshot.schemaVersion !== 2 || !Array.isArray(snapshot.jobs)) throw new Error('unexpected schema')
  return snapshot
}

/**
 * 把宿主失败响应翻成一条**带原因**的错误（2026-09-21 审计）。
 *
 * 宿主在失败时回的是 JSON 信封 `{ok:false,error,hint?}`（见 host-routes.ts 的
 * `requireWriteProof` / 动作解析分支），但这里原来只用状态码造串 ⇒ 界面上永远只有
 * `cron action failed: 400`：调度被停用、权限名未知、账号切换、写面证明失败（带 hint）
 * 这些**可操作原因**全被丢掉，用户只能猜。
 */
async function failureMessage(response: Response, prefix: string): Promise<string> {
  const fallback = `${prefix}: ${response.status}`
  try {
    const body = (await response.json()) as { error?: unknown; hint?: unknown }
    const parts: string[] = []
    if (typeof body.error === 'string' && body.error !== '') parts.push(body.error)
    if (typeof body.hint === 'string' && body.hint !== '') parts.push(body.hint)
    if (parts.length === 0) return fallback
    return `${prefix}: ${response.status} — ${parts.join(' · ')}`
  } catch {
    // 非 JSON 响应（代理/网关错误页）：保留状态码，不要因为解析失败再抛一个错。
    return fallback
  }
}

export class HttpCronTransport implements CronTransport {
  async bootstrap(): Promise<CronSnapshot> {
    return this.state()
  }

  async state(): Promise<CronSnapshot> {
    const response = await fetch('/api/cron/state', { headers: { accept: 'application/json' } })
    if (!response.ok) throw new Error(await failureMessage(response, 'cron state failed'))
    return parseSnapshot(await response.json())
  }

  async action(action: CronAction): Promise<CronSnapshot> {
    const response = await fetch('/api/cron/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: crypto.randomUUID(), action }),
    })
    if (!response.ok) throw new Error(await failureMessage(response, 'cron action failed'))
    return parseSnapshot(await response.json())
  }

  subscribe(listener: (event?: CronEventPayload) => void): () => void {
    let closed = false
    let source: EventSource | undefined
    try {
      source = new EventSource('/api/cron/events')
      source.onmessage = (message: MessageEvent<string>): void => {
        if (closed) return
        try {
          listener(JSON.parse(message.data) as CronEventPayload)
        } catch {
          // Malformed frame: ignore, the next heartbeat/state pull recovers.
        }
      }
      source.onerror = (): void => {
        // EventSource auto-reconnects; the controller refetches on events.
        listener(undefined)
      }
    } catch {
      // EventSource unavailable (odd environment): degrade to polling via
      // the undefined-event hint.
      listener(undefined)
    }
    return () => {
      closed = true
      source?.close()
    }
  }
}
