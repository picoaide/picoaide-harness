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

export class HttpCronTransport implements CronTransport {
  async bootstrap(): Promise<CronSnapshot> {
    return this.state()
  }

  async state(): Promise<CronSnapshot> {
    const response = await fetch('/api/cron/state', { headers: { accept: 'application/json' } })
    if (!response.ok) throw new Error(`cron state failed: ${response.status}`)
    return parseSnapshot(await response.json())
  }

  async action(action: CronAction): Promise<CronSnapshot> {
    const response = await fetch('/api/cron/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: crypto.randomUUID(), action }),
    })
    if (!response.ok) throw new Error(`cron action failed: ${response.status}`)
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
