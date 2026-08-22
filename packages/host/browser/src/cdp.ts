/**
 * Minimal CDP client over Electron's per-webContents Debugger. The embedded
 * browser drives every tab through `webContents.debugger` (the built-in CDP
 * channel), so no extra runtime dependency is needed. This module owns the
 * wire protocol only: attach/detach, `sendCommand`, and event fan-out.
 * @module @picoaide/dsh-browser
 */

/**
 * The Electron Debugger surface this adapter needs. Type-only import keeps
 * the module loadable under plain Node (unit tests inject a mock).
 */
export interface CdpTransport {
  isAttached(): boolean
  attach(protocolVersion: string): void
  detach(): void
  sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>
  on(event: 'message', listener: (event: unknown, method: string, params: unknown) => void): unknown
  removeListener(event: 'message', listener: (event: unknown, method: string, params: unknown) => void): unknown
}

/** One established CDP session over a transport. */
export class CdpSession {
  private readonly listeners = new Map<string, Set<(params: unknown) => void>>()
  private readonly messageListener: (event: unknown, method: string, params: unknown) => void
  private closed = false

  constructor(private readonly transport: CdpTransport) {
    this.messageListener = (_event, method, params) => {
      const set = this.listeners.get(method)
      if (set === undefined) return
      for (const handler of [...set]) {
        try {
          handler(params)
        } catch {
          // A listener must never break the CDP fan-out.
        }
      }
    }
  }

  /** Attach with the stable protocol version, failing loudly on double attach. */
  async attach(): Promise<void> {
    if (this.transport.isAttached()) throw new Error('browser: CDP already attached')
    this.transport.attach('1.3')
    this.transport.on('message', this.messageListener)
    this.closed = false
  }

  /** Send one CDP command; rejects when the session is closed or the command fails. */
  async send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.closed) throw new Error(`browser: CDP session closed (${method})`)
    return await this.transport.sendCommand(method, params) as T
  }

  /** Subscribe to one CDP method; returns a disposer. */
  on(method: string, handler: (params: unknown) => void): () => void {
    let set = this.listeners.get(method)
    if (set === undefined) {
      set = new Set()
      this.listeners.set(method, set)
    }
    set.add(handler)
    return () => {
      set?.delete(handler)
    }
  }

  /** Detach idempotently and clear all subscriptions. */
  detach(): void {
    if (this.closed) return
    this.closed = true
    this.listeners.clear()
    this.transport.removeListener('message', this.messageListener)
    if (this.transport.isAttached()) {
      try {
        this.transport.detach()
      } catch {
        // Detach races with a destroyed webContents; nothing to clean up.
      }
    }
  }
}
