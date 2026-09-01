import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import { HostCronService } from '../src/host-service.ts'
import { HostCronLedger } from '../src/host-ledger.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-cron-service-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const CREATE = {
  kind: 'create' as const,
  id: 'job-1',
  input: {
    name: 'Daily',
    cron: '0 9 * * *',
    action: { kind: 'agent' as const, prompt: 'do the daily thing', workspaceId: 'ws-1', agentPreset: 'default' },
    enabled: true,
  },
}

function api(): ApiProxy {
  return {} as unknown as ApiProxy
}

function service(): HostCronService {
  const ledger = new HostCronLedger({ dshHomeDir: dir })
  return new HostCronService(api(), { ledger, now: () => 1_800_000_000_000 })
}

/**
 * Like service(), but pre-wires the ledger owner callback to a helper
 * `stamp(username)`. The service constructor only wires `owner: () =>
 * this.username` when it constructs its own ledger; an injected ledger keeps
 * its own callback, so owner-scoping tests need this explicit wiring.
 */
function serviceWithOwner(): { host: HostCronService; stamp: (user: string | null) => void } {
  let user: string | null = null
  const ledger = new HostCronLedger({ dshHomeDir: dir, owner: () => user })
  const host = new HostCronService(api(), { ledger, now: () => 1_800_000_000_000 })
  return { host, stamp: (u) => { user = u } }
}

describe('HostCronService', () => {
  it('snapshot filters jobs by owner scope', () => {
    const { host, stamp } = serviceWithOwner()
    // The ledger stamps the creating account, so create under u1 first.
    stamp('u1')
    host.setUsername('u1')
    host.apply('r1', CREATE)
    expect(host.snapshot().jobs).toHaveLength(1)

    // Switching account (or logging out) hides the owned job.
    stamp(null)
    host.setUsername(null)
    expect(host.snapshot().jobs).toHaveLength(0)

    stamp('u1')
    host.setUsername('u1')
    expect(host.snapshot().jobs).toHaveLength(1)
    expect(host.currentUsername()).toBe('u1')
    host.dispose()
  })

  it('apply rejects mutations while disabled', () => {
    const host = service()
    host.setConfiguration(false, true)
    expect(() => host.apply('r1', CREATE)).toThrow('cron scheduler is disabled')
    expect(() => host.registerJob({ id: 'x', name: 'x', cron: '0 0 * * *', action: { kind: 'agent', prompt: 'x' } }))
      .toThrow('cron scheduler is disabled')
    host.dispose()
  })

  it('setConfiguration(true) resumes a stopped scheduler', () => {
    const host = service()
    const startSpy = vi.spyOn(host.scheduler, 'start')
    const stopSpy = vi.spyOn(host.scheduler, 'stop')
    host.setConfiguration(true, false)
    expect(startSpy).not.toHaveBeenCalled()
    host.setConfiguration(false, false)
    expect(stopSpy).toHaveBeenCalled()
    host.setConfiguration(true, false)
    expect(startSpy).toHaveBeenCalled()
    host.dispose()
  })

  it('notifies subscribers when observables change (deduped frames)', () => {
    const host = service()
    const listener = vi.fn()
    host.subscribe(listener)
    host.apply('r1', CREATE)
    expect(listener).toHaveBeenCalledTimes(1)
    // apply() itself does not emit when the ledger state did not change…
    host.apply('r1', CREATE) // idempotent replay: no new frame
    expect(listener).toHaveBeenCalledTimes(1)

    const unsubscribe = host.subscribe(listener)
    unsubscribe()
    host.setUsername('u1') // emits a frame even with zero jobs
    host.setUsername('u1') // same payload: deduped
    expect(listener).toHaveBeenCalledTimes(1)
    host.dispose()
  })

  it('unregisterJob deletes by id and is restart-safe', () => {
    const first = service()
    first.apply('r1', CREATE)
    first.unregisterJob('job-1')
    expect(first.listJobs()).toHaveLength(0)
    expect(first.getSnapshot().revision).toBe(2)
    first.dispose()

    const second = service()
    expect(second.listJobs()).toHaveLength(0)
    second.dispose()
  })

  it('listVisibleJobs applies the owner filter (tools cannot enumerate others)', () => {
    const { host, stamp } = serviceWithOwner()
    stamp('u1')
    host.setUsername('u1')
    host.apply('r1', CREATE)
    expect(host.listVisibleJobs()).toHaveLength(1)
    stamp(null)
    host.setUsername(null)
    expect(host.listVisibleJobs()).toHaveLength(0)
    host.dispose()
  })

  it('eventPayload carries the scheduler summary without deep-cloning jobs', () => {
    const host = service()
    host.apply('r1', CREATE)
    const payload = host.eventPayload()
    expect(payload.revision).toBe(1)
    expect(payload.scheduler.timeZone).not.toBe('')
    expect(payload.scheduler.ledgerId).toBeDefined()
    host.dispose()
  })
})
