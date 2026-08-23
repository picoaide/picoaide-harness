import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HostTaskLedger } from '../src/host-ledger.ts'
import { taskVisibleTo } from '../src/tasks.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-task-owner-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const CREATE = (id = 'task-1') => ({
  kind: 'create' as const,
  id,
  input: {
    title: 'T',
    description: 'D',
    prompt: 'P',
  },
})

describe('task owner scoping', () => {
  it('stamps the current account on create', () => {
    const host = new HostTaskLedger({ dshHomeDir: dir, owner: () => 'alice' })
    host.applyRequest('r1', CREATE())
    expect(host.state().tasks[0]!.owner).toBe('alice')
  })

  it('rejects target actions on another account task', () => {
    let current = 'alice'
    const host = new HostTaskLedger({ dshHomeDir: dir, owner: () => current })
    host.applyRequest('r1', CREATE())
    current = 'bob'
    expect(() => host.applyRequest('r2', { kind: 'delete', taskId: 'task-1' })).toThrow(/another account/u)
  })

  it('keeps legacy owner-less tasks mutable by everyone', () => {
    let current: string | null = null
    const host = new HostTaskLedger({ dshHomeDir: dir, owner: () => current })
    host.applyRequest('r1', CREATE())
    expect(host.state().tasks[0]!.owner).toBeUndefined()
    current = 'bob'
    expect(() => host.applyRequest('r2', { kind: 'move', taskId: 'task-1', status: 'done' })).not.toThrow()
  })

  it('taskVisibleTo scopes owner tasks and keeps legacy tasks open', () => {
    expect(taskVisibleTo({ owner: 'alice' } as never, 'alice')).toBe(true)
    expect(taskVisibleTo({ owner: 'alice' } as never, 'bob')).toBe(false)
    expect(taskVisibleTo({ owner: 'alice' } as never, null)).toBe(false)
    expect(taskVisibleTo({} as never, 'bob')).toBe(true)
    expect(taskVisibleTo({} as never, null)).toBe(true)
  })
})
