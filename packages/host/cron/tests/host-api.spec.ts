import { afterEach, describe, expect, it, vi } from 'vitest'
import { HttpCronTransport } from '../src/client/host-api.ts'

const VALID = {
  schemaVersion: 2,
  revision: 3,
  jobs: [],
  scheduler: { timeZone: 'local' },
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('HttpCronTransport', () => {
  it('state() fetches and parses the snapshot', async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      json: async () => VALID,
    }))
    vi.stubGlobal('fetch', fetch)
    const transport = new HttpCronTransport()
    const snapshot = await transport.state()
    expect(snapshot.revision).toBe(3)
    expect(fetch).toHaveBeenCalledWith('/api/cron/state', { headers: { accept: 'application/json' } })
  })

  it('state() throws on a non-ok response', async () => {
    const fetch = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }))
    vi.stubGlobal('fetch', fetch)
    await expect(new HttpCronTransport().state()).rejects.toThrow('cron state failed: 500')
  })

  it('state() throws on an unexpected schema', async () => {
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ schemaVersion: 1 }) }))
    vi.stubGlobal('fetch', fetch)
    await expect(new HttpCronTransport().state()).rejects.toThrow('unexpected schema')
  })

  it('state() throws on a non-object body', async () => {
    const fetch = vi.fn(async () => ({ ok: true, json: async () => null }))
    vi.stubGlobal('fetch', fetch)
    await expect(new HttpCronTransport().state()).rejects.toThrow('invalid snapshot')
  })

  it('action() posts an idempotent envelope and parses the result', async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      json: async () => VALID,
    }))
    vi.stubGlobal('fetch', fetch)
    const transport = new HttpCronTransport()
    await transport.action({ kind: 'delete', jobId: 'job-1' })
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(url).toBe('/api/cron/action')
    expect(init.method).toBe('POST')
    const body = JSON.parse(String(init.body))
    expect(body.action).toEqual({ kind: 'delete', jobId: 'job-1' })
    expect(typeof body.requestId).toBe('string')
  })

  it('action() throws on a non-ok response', async () => {
    const fetch = vi.fn(async () => ({ ok: false, status: 400, json: async () => ({}) }))
    vi.stubGlobal('fetch', fetch)
    await expect(new HttpCronTransport().action({ kind: 'delete', jobId: 'x' })).rejects.toThrow('cron action failed: 400')
  })

  it('bootstrap() delegates to state()', async () => {
    const fetch = vi.fn(async () => ({ ok: true, json: async () => VALID }))
    vi.stubGlobal('fetch', fetch)
    const transport = new HttpCronTransport()
    await expect(transport.bootstrap()).resolves.toMatchObject({ revision: 3 })
  })

  it('subscribe() wires EventSource frames and unsubscribes cleanly', () => {
    let instance: { onmessage: ((e: { data: string }) => void) | null; onerror: (() => void) | null; close: () => void } | null = null
    const close = vi.fn()
    class FakeEventSource {
      onmessage: ((e: { data: string }) => void) | null = null
      onerror: (() => void) | null = null
      constructor() { instance = this }
      close(): void { close() }
    }
    vi.stubGlobal('EventSource', FakeEventSource)

    const transport = new HttpCronTransport()
    const listener = vi.fn()
    const unsubscribe = transport.subscribe(listener)
    expect(instance).not.toBeNull()

    instance!.onmessage?.({ data: JSON.stringify({ revision: 4, scheduler: { timeZone: 'local' } }) })
    expect(listener).toHaveBeenCalledWith({ revision: 4, scheduler: { timeZone: 'local' } })

    // Malformed frames are ignored without throwing.
    instance!.onmessage?.({ data: '{oops' })
    expect(listener).toHaveBeenCalledTimes(1)

    // onerror → undefined-event hint (auto-reconnect path).
    instance!.onerror?.()
    expect(listener).toHaveBeenCalledTimes(2)

    unsubscribe()
    expect(close).toHaveBeenCalled()
    // After unsubscribe, no more frames reach the listener.
    instance!.onmessage?.({ data: JSON.stringify({ revision: 5, scheduler: { timeZone: 'local' } }) })
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('subscribe() degrades to an undefined-event hint when EventSource throws', () => {
    vi.stubGlobal('EventSource', class { constructor() { throw new Error('no EventSource') } })
    const transport = new HttpCronTransport()
    const listener = vi.fn()
    const unsubscribe = transport.subscribe(listener)
    expect(listener).toHaveBeenCalledWith(undefined)
    unsubscribe()
  })
})
