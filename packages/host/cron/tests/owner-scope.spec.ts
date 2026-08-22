import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HostCronLedger } from '../src/host-ledger.ts'
import { jobVisibleTo } from '../src/jobs.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-cron-owner-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const CREATE = (id = 'job-1') => ({
  kind: 'create' as const,
  id,
  input: {
    name: 'Daily',
    cron: '0 9 * * *',
    action: { kind: 'task' as const, taskId: 'task-1' },
    enabled: true,
  },
})

describe('cron owner scoping', () => {
  it('stamps the current account on create', () => {
    const host = new HostCronLedger({ dshHomeDir: dir, owner: () => 'alice' })
    host.applyRequest('r1', CREATE())
    expect(host.state().jobs[0]!.owner).toBe('alice')
  })

  it('rejects target actions on another account job', () => {
    let current = 'alice'
    const host = new HostCronLedger({ dshHomeDir: dir, owner: () => current })
    host.applyRequest('r1', CREATE())
    current = 'bob'
    expect(() => host.applyRequest('r2', { kind: 'disable', jobId: 'job-1' })).toThrow(/another account/u)
  })

  it('keeps legacy owner-less jobs mutable by everyone', () => {
    let current: string | null = null
    const host = new HostCronLedger({ dshHomeDir: dir, owner: () => current })
    host.applyRequest('r1', CREATE())
    expect(host.state().jobs[0]!.owner).toBeUndefined()
    current = 'bob'
    // No throw: legacy jobs are not owner-scoped.
    expect(() => host.applyRequest('r2', { kind: 'disable', jobId: 'job-1' })).not.toThrow()
    expect(host.state().jobs[0]!.enabled).toBe(false)
  })

  it('jobVisibleTo scopes owner jobs and keeps legacy jobs open', () => {
    expect(jobVisibleTo({ owner: 'alice' } as never, 'alice')).toBe(true)
    expect(jobVisibleTo({ owner: 'alice' } as never, 'bob')).toBe(false)
    expect(jobVisibleTo({ owner: 'alice' } as never, null)).toBe(false)
    expect(jobVisibleTo({} as never, 'bob')).toBe(true)
    expect(jobVisibleTo({} as never, null)).toBe(true)
  })
})
