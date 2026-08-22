/**
 * Browser transport for the task API: full snapshot bootstrap, idempotent
 * action submission, and SSE change hints. The Host snapshot is the only
 * confirmed UI state.
 */
import type { TaskAction, TaskSnapshot } from '../protocol.ts'

export interface TaskTransport {
  bootstrap(): Promise<TaskSnapshot>
  state(): Promise<TaskSnapshot>
  action(action: TaskAction): Promise<TaskSnapshot>
  subscribe(listener: () => void): () => void
}

function parseSnapshot(value: unknown): TaskSnapshot {
  if (typeof value !== 'object' || value === null) throw new Error('invalid snapshot')
  const snapshot = value as TaskSnapshot
  if (snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.tasks)) throw new Error('unexpected schema')
  return snapshot
}

export class HttpTaskTransport implements TaskTransport {
  async bootstrap(): Promise<TaskSnapshot> {
    return this.state()
  }

  async state(): Promise<TaskSnapshot> {
    const response = await fetch('/api/task/state', { headers: { accept: 'application/json' } })
    if (!response.ok) throw new Error(`task state failed: ${response.status}`)
    return parseSnapshot(await response.json())
  }

  async action(action: TaskAction): Promise<TaskSnapshot> {
    const response = await fetch('/api/task/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: crypto.randomUUID(), action }),
    })
    if (!response.ok) throw new Error(`task action failed: ${response.status}`)
    return parseSnapshot(await response.json())
  }

  subscribe(listener: () => void): () => void {
    let closed = false
    let source: EventSource | undefined
    try {
      source = new EventSource('/api/task/events')
      source.onmessage = (): void => {
        if (!closed) listener()
      }
      source.onerror = (): void => {
        if (!closed) listener()
      }
    } catch {
      listener()
    }
    return () => {
      closed = true
      source?.close()
    }
  }
}
