import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CronSnapshot } from '../src/protocol.ts'
import type { CronTransport } from '../src/client/host-api.ts'
import { CronController } from '../src/client/controller.ts'

function snapshot(overrides: Partial<CronSnapshot> = {}): CronSnapshot {
  return {
    schemaVersion: 2,
    revision: 1,
    jobs: [],
    scheduler: { timeZone: 'local' },
    ...overrides,
  }
}

class FakeTransport implements CronTransport {
  stateResponses: Array<() => CronSnapshot | Promise<CronSnapshot>> = []
  actionResponses: Array<() => CronSnapshot | Promise<CronSnapshot>> = []
  stateCalls = 0
  actionCalls: unknown[] = []
  private listeners = new Set<(event?: unknown) => void>()

  async state(): Promise<CronSnapshot> {
    this.stateCalls += 1
    const next = this.stateResponses.shift() ?? (() => snapshot())
    return next()
  }

  async action(action: unknown): Promise<CronSnapshot> {
    this.actionCalls.push(action)
    const next = this.actionResponses.shift() ?? (() => snapshot({ revision: this.actionCalls.length + 1 }))
    return next()
  }

  subscribe(listener: (event?: unknown) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  emit(): void {
    for (const l of [...this.listeners]) l(undefined)
  }
}

let transport: FakeTransport
let controller: CronController

beforeEach(() => {
  transport = new FakeTransport()
  controller = new CronController({ transport, refetchDebounceMs: 5, uuid: () => 'uuid-1' })
})

afterEach(() => {
  vi.useRealTimers()
  controller.dispose()
})

describe('CronController', () => {
  it('bootstraps the snapshot on start', async () => {
    transport.stateResponses = [() => snapshot({ revision: 7, jobs: [{ id: 'j1' } as never] })]
    controller.start()
    await vi.waitFor(() => expect(controller.getSnapshot().revision).toBe(7))
    expect(transport.stateCalls).toBe(1)
  })

  it('is idempotent across repeated start() calls', () => {
    controller.start()
    controller.start()
    expect(transport.stateCalls).toBe(1)
  })

  it('installs the action result and clears pending job ids', async () => {
    transport.stateResponses = [() => snapshot({ revision: 1 })]
    transport.actionResponses = [() => snapshot({ revision: 2, jobs: [{ id: 'job-1' } as never] })]
    controller.start()
    await vi.waitFor(() => expect(controller.getSnapshot().revision).toBe(1))

    controller.remove('job-1')
    expect(controller.getSnapshot().pendingJobIds).toEqual(['job-1'])
    await vi.waitFor(() => expect(controller.getSnapshot().revision).toBe(2))
    expect(controller.getSnapshot().pendingJobIds).toEqual([])
    expect(transport.actionCalls).toEqual([{ kind: 'delete', jobId: 'job-1' }])
  })

  it('submits create/update/enable/disable/run/rerun with a generated id', async () => {
    controller.create({ name: 'Daily', cron: '0 9 * * *', action: { kind: 'agent', prompt: 'x', workspaceId: 'ws', agentPreset: 'default' }, enabled: true } as never)
    controller.update('job-1', { name: 'Renamed' } as never)
    controller.enable('job-1')
    controller.disable('job-1')
    controller.run('job-1')
    controller.rerun('job-1')
    await vi.waitFor(() => expect(transport.actionCalls).toHaveLength(6))
    expect(transport.actionCalls[0]).toMatchObject({ kind: 'create', id: 'uuid-1' })
    expect(transport.actionCalls[1]).toEqual({ kind: 'update', jobId: 'job-1', patch: { name: 'Renamed' } })
    expect(transport.actionCalls[2]).toEqual({ kind: 'enable', jobId: 'job-1' })
    expect(transport.actionCalls[3]).toEqual({ kind: 'disable', jobId: 'job-1' })
    expect(transport.actionCalls[4]).toEqual({ kind: 'run', jobId: 'job-1' })
    expect(transport.actionCalls[5]).toEqual({ kind: 'rerun', jobId: 'job-1' })
  })

  it('surfaces transport errors and schedules a delayed resync', async () => {
    controller.start()
    await vi.waitFor(() => expect(transport.stateCalls).toBe(1))
    transport.stateResponses = [() => { throw new Error('boom') }]
    controller.retryHostSync()
    await vi.waitFor(() => expect(controller.getSnapshot().transportError).toBe('boom'))
    expect(controller.getSnapshot().revision).toBe(1)
  })

  it('keeps the error visible until a successful refresh clears it', async () => {
    transport.stateResponses = [() => snapshot({ revision: 1 }), () => { throw new Error('down') }, () => snapshot({ revision: 2 })]
    controller.start()
    await vi.waitFor(() => expect(controller.getSnapshot().revision).toBe(1))
    controller.retryHostSync()
    await vi.waitFor(() => expect(controller.getSnapshot().transportError).toBe('down'))
    controller.retryHostSync()
    await vi.waitFor(() => expect(controller.getSnapshot().revision).toBe(2))
    expect(controller.getSnapshot().transportError).toBeUndefined()
  })

  it('debounces event-hint refetches', async () => {
    controller.start()
    await vi.waitFor(() => expect(transport.stateCalls).toBe(1))
    transport.stateResponses = [() => snapshot({ revision: 2 }), () => snapshot({ revision: 3 })]
    transport.emit()
    transport.emit()
    await vi.waitFor(() => expect(controller.getSnapshot().revision).toBe(2))
    expect(transport.stateCalls).toBe(2) // one refresh for two hints
  })

  it('refuses a stale read that started before a newer write', async () => {
    controller.start()
    await vi.waitFor(() => expect(controller.getSnapshot().revision).toBe(1))
    // A late state() answer with an older revision must not roll back.
    transport.stateResponses = [() => snapshot({ revision: 0 })]
    controller.retryHostSync()
    await vi.waitFor(() => expect(controller.getSnapshot().revision).toBe(1))
  })

  it('dispose stops refetches and clears listeners', async () => {
    controller.start()
    await vi.waitFor(() => expect(transport.stateCalls).toBe(1))
    const listener = vi.fn()
    controller.subscribe(listener)
    controller.dispose()
    transport.emit()
    expect(listener).not.toHaveBeenCalled()
  })
})
