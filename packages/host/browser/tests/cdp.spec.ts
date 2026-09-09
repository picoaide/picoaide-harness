import { describe, expect, it, vi } from 'vitest'
import { CdpSession } from '../src/cdp.ts'
import type { CdpTransport } from '../src/cdp.ts'

class MockTransport implements CdpTransport {
  attached = false
  readonly sent: Array<{ method: string; params: Record<string, unknown> }> = []
  readonly listeners: Array<(event: unknown, method: string, params: unknown) => void> = []
  handler: ((method: string, params: Record<string, unknown>) => unknown) | undefined

  isAttached(): boolean { return this.attached }
  attach(): void { this.attached = true }
  detach(): void { this.attached = false }
  sendCommand(method: string, params: Record<string, unknown>): Promise<unknown> {
    this.sent.push({ method, params })
    return Promise.resolve(this.handler?.(method, params) ?? {})
  }
  on(_event: string, listener: (event: unknown, method: string, params: unknown) => void): void {
    this.listeners.push(listener)
  }
  removeListener(_event: string, listener: (event: unknown, method: string, params: unknown) => void): void {
    const idx = this.listeners.indexOf(listener)
    if (idx >= 0) this.listeners.splice(idx, 1)
  }

  emit(method: string, params: unknown): void {
    for (const listener of [...this.listeners]) listener({}, method, params)
  }
}

describe('CdpSession', () => {
  it('attaches with the stable protocol version', async () => {
    const transport = new MockTransport()
    const session = new CdpSession(transport)
    await session.attach()
    expect(transport.attached).toBe(true)
    session.detach()
    expect(transport.attached).toBe(false)
  })

  it('rejects double attach', async () => {
    const transport = new MockTransport()
    const session = new CdpSession(transport)
    await session.attach()
    await expect(session.attach()).rejects.toThrow(/already attached/)
  })

  it('sends commands with params', async () => {
    const transport = new MockTransport()
    transport.handler = (method) => method === 'Runtime.evaluate'
      ? { result: { value: { ok: true } } }
      : {}
    const session = new CdpSession(transport)
    await session.attach()
    const value = await session.send<{ result: { value: { ok: boolean } } }>('Runtime.evaluate', {
      expression: '1 + 1',
      returnByValue: true,
    })
    expect(value.result.value.ok).toBe(true)
    expect(transport.sent[0]?.method).toBe('Runtime.evaluate')
    expect(transport.sent[0]?.params.expression).toBe('1 + 1')
  })

  it('fans out events to subscribers and unsubscribes', async () => {
    const transport = new MockTransport()
    const session = new CdpSession(transport)
    await session.attach()
    const seen: unknown[] = []
    const off = session.on('Network.loadingFinished', (params) => { seen.push(params) })
    transport.emit('Network.loadingFinished', { requestId: '1' })
    transport.emit('Network.loadingFinished', { requestId: '2' })
    off()
    transport.emit('Network.loadingFinished', { requestId: '3' })
    expect(seen).toHaveLength(2)
  })

  it('rejects commands after detach', async () => {
    const transport = new MockTransport()
    const session = new CdpSession(transport)
    await session.attach()
    session.detach()
    await expect(session.send('Runtime.evaluate')).rejects.toThrow(/closed/)
  })

  it('detach is idempotent', async () => {
    const transport = new MockTransport()
    const session = new CdpSession(transport)
    await session.attach()
    session.detach()
    session.detach()
    expect(transport.attached).toBe(false)
  })

  it('a throwing listener does not break fan-out', async () => {
    const transport = new MockTransport()
    const session = new CdpSession(transport)
    await session.attach()
    const seen: unknown[] = []
    session.on('evt', () => { throw new Error('boom') })
    session.on('evt', (params) => { seen.push(params) })
    expect(() => transport.emit('evt', { n: 1 })).not.toThrow()
    expect(seen).toHaveLength(1)
  })
})

describe('CdpSession with real Transport shape (vi mock)', () => {
  it('uses vi.fn-compatible transports', async () => {
    let attached = false
    const isAttached = vi.fn(() => attached)
    const attach = vi.fn(() => { attached = true })
    const detach = vi.fn(() => { attached = false })
    const sendCommand = vi.fn(async () => ({}))
    const on = vi.fn()
    const removeListener = vi.fn()
    const transport = { isAttached, attach, detach, sendCommand, on, removeListener } as unknown as CdpTransport
    const session = new CdpSession(transport)
    await session.attach()
    await session.send('Page.enable')
    session.detach()
    expect(attach).toHaveBeenCalledWith('1.3')
    expect(sendCommand).toHaveBeenCalledWith('Page.enable', {})
    expect(detach).toHaveBeenCalledTimes(1)
  })
})

describe('CdpSession — command timeout / cancellation (2026-09-08 P0-4)', () => {
  it('rejects with a timeout when the transport never settles', async () => {
    const transport = new MockTransport()
    transport.sendCommand = () => new Promise(() => {})
    const session = new CdpSession(transport, { timeoutMs: 30 })
    await expect(session.send('Page.navigate', { url: 'https://x' })).rejects.toMatchObject({ code: 'timeout' })
  })

  it('rejects immediately when the signal aborts, even before the timeout', async () => {
    const transport = new MockTransport()
    transport.sendCommand = () => new Promise(() => {})
    const session = new CdpSession(transport, { timeoutMs: 10_000 })
    const controller = new AbortController()
    const pending = session.send('Page.navigate', {}, { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'interrupted' })
  })

  it('a per-call timeout overrides the session default and does not leak timers', async () => {
    const transport = new MockTransport()
    let resolveLate: ((value: unknown) => void) | undefined
    transport.sendCommand = () => new Promise((resolve) => { resolveLate = resolve })
    const session = new CdpSession(transport, { timeoutMs: 10_000 })
    await expect(session.send('Page.navigate', {}, { timeoutMs: 25 })).rejects.toMatchObject({ code: 'timeout' })
    // A late transport reply after the local timeout must not throw or re-settle.
    resolveLate?.({ ok: true })
    await Promise.resolve()
  })
})
