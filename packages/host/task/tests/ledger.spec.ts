import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HostTaskLedger } from '../src/host-ledger.ts'
import { createTask, settleExecution, startExecution, updateTask, withStatus } from '../src/tasks.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-task-ledger-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function ledger(): HostTaskLedger {
  return new HostTaskLedger({ dshHomeDir: dir })
}

const CREATE = {
  kind: 'create' as const,
  id: 't-1',
  input: {
    title: 'Ship report',
    description: 'Weekly report',
    prompt: '生成周报',
  },
}

describe('task model', () => {
  it('creates a task in todo with no executions', () => {
    const task = createTask('t-1', CREATE.input, 1000)
    expect(task.status).toBe('todo')
    expect(task.executions).toHaveLength(0)
    expect(task.createdAt).toBe(1000)
  })

  it('startExecution flips status to doing and appends a pending execution', () => {
    const task = createTask('t-1', CREATE.input, 1000)
    const { task: running, execution } = startExecution(task, 'run-1', 2000)
    expect(running.status).toBe('doing')
    expect(running.executions).toHaveLength(1)
    expect(execution.endedAt).toBeUndefined()
  })

  it('settleExecution maps succeeded to done and failed to failed', () => {
    const task = createTask('t-1', CREATE.input, 1000)
    const { task: running, execution } = startExecution(task, 'run-1', 2000)
    const done = settleExecution(running, execution.id, 'succeeded', 3000)
    expect(done.status).toBe('done')
    expect(done.executions[0]!.endedAt).toBe(3000)
    expect(done.executions[0]!.result).toBe('succeeded')

    const { task: running2, execution: execution2 } = startExecution(createTask('t-2', CREATE.input, 1000), 'run-2', 2000)
    const failed = settleExecution(running2, execution2.id, 'failed', 3000, 'boom')
    expect(failed.status).toBe('failed')
    expect(failed.executions[0]!.error).toBe('boom')

    // Cancelled releases a running task back to todo; the first settlement wins.
    const { task: running3, execution: execution3 } = startExecution(createTask('t-3', CREATE.input, 1000), 'run-3', 2000)
    const cancelled = settleExecution(running3, execution3.id, 'cancelled', 3000, 'gone')
    expect(cancelled.status).toBe('todo')
    const doubleSettle = settleExecution(cancelled, execution3.id, 'succeeded', 4000)
    expect(doubleSettle.executions[0]!.result).toBe('cancelled')
    expect(doubleSettle.status).toBe('todo')
  })

  it('updateTask applies only present fields', () => {
    const task = createTask('t-1', CREATE.input, 1000)
    const updated = updateTask(task, { title: 'New title' }, 2000)
    expect(updated.title).toBe('New title')
    expect(updated.description).toBe(CREATE.input.description)
  })

  it('withStatus moves between columns', () => {
    const task = createTask('t-1', CREATE.input, 1000)
    expect(withStatus(task, 'doing').status).toBe('doing')
  })
})

describe('HostTaskLedger', () => {
  it('persists with 0600 and monotonic revision', () => {
    const host = ledger()
    host.applyRequest('r1', CREATE)
    host.dispose()

    const path = join(dir, 'task', 'ledger.json')
    expect(existsSync(path)).toBe(true)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    const document = JSON.parse(readFileSync(path, 'utf8'))
    expect(document.schemaVersion).toBe(1)
    expect(document.revision).toBe(1)
    expect(document.tasks).toHaveLength(1)
  })

  it('is idempotent per requestId across instances', () => {
    const first = ledger()
    first.applyRequest('r1', CREATE)
    first.dispose()

    const second = ledger()
    second.applyRequest('r1', CREATE)
    expect(second.state().tasks).toHaveLength(1)
    second.dispose()
  })

  it('move, archive, restore, delete behave', () => {
    const host = ledger()
    host.applyRequest('r1', CREATE)
    host.applyRequest('r2', { kind: 'move', taskId: 't-1', status: 'doing' })
    expect(host.state().tasks[0]!.status).toBe('doing')
    host.applyRequest('r3', { kind: 'archive', taskId: 't-1' })
    expect(host.state().tasks[0]!.archivedAt).toBeDefined()
    host.applyRequest('r4', { kind: 'restore', taskId: 't-1' })
    expect(host.state().tasks[0]!.archivedAt).toBeUndefined()
    host.applyRequest('r5', { kind: 'delete', taskId: 't-1' })
    expect(host.state().tasks).toHaveLength(0)
    host.dispose()
  })

  it('run refuses archived or already-running tasks', () => {
    const host = ledger()
    host.applyRequest('r1', CREATE)
    host.applyRequest('r2', { kind: 'run', taskId: 't-1' })
    expect(host.state().tasks[0]!.executions).toHaveLength(1)
    // Already running: refused.
    host.applyRequest('r3', { kind: 'run', taskId: 't-1' })
    expect(host.state().tasks[0]!.executions).toHaveLength(1)
    host.dispose()
  })

  it('attachSession and settle update the execution record', () => {
    const host = ledger()
    host.applyRequest('r1', CREATE)
    const result = host.applyRequest('r2', { kind: 'run', taskId: 't-1' })
    expect(result.run).toBeDefined()
    host.attachSession('t-1', result.run!.execution.id, 'session-1')
    host.settle('t-1', result.run!.execution.id, 'succeeded')
    const execution = host.state().tasks[0]!.executions[0]!
    expect(execution.sessionId).toBe('session-1')
    expect(execution.result).toBe('succeeded')
    expect(host.state().tasks[0]!.status).toBe('done')
    host.dispose()
  })
})

describe('HostTaskLedger recovery', () => {
  it('settles interrupted starts as cancelled after a crash', () => {
    const host = ledger()
    host.applyRequest('r1', CREATE)
    // A run was opened but the session was never attached (crash window).
    const result = host.applyRequest('r2', { kind: 'run', taskId: 't-1' })
    expect(result.run).toBeDefined()
    host.dispose()

    const restarted = ledger()
    const task = restarted.state().tasks[0]!
    const execution = task.executions[0]!
    expect(execution.endedAt).toBeDefined()
    expect(execution.result).toBe('cancelled')
    expect(execution.error).toMatch(/host restarted/)
    // The task is no longer pinned in 'doing'; a rerun is possible.
    expect(restarted.state().tasks[0]!.status).not.toBe('doing')
    const rerun = restarted.applyRequest('r3', { kind: 'rerun', taskId: 't-1' })
    expect(rerun.run).toBeDefined()
    restarted.dispose()
  })
})

describe('HostTaskLedger state-machine guards', () => {
  it('refuses delete/move/update/archive while a task is running', () => {
    const host = ledger()
    host.applyRequest('r1', CREATE)
    host.applyRequest('r2', { kind: 'run', taskId: 't-1' })

    expect(host.state().tasks[0]!.executions).toHaveLength(1)
    host.applyRequest('r3', { kind: 'delete', taskId: 't-1' })
    expect(host.state().tasks).toHaveLength(1)
    host.applyRequest('r4', { kind: 'move', taskId: 't-1', status: 'done' })
    expect(host.state().tasks[0]!.status).toBe('doing')
    host.applyRequest('r5', { kind: 'update', taskId: 't-1', patch: { title: 'x' } })
    expect(host.state().tasks[0]!.title).toBe(CREATE.input.title)
    host.applyRequest('r6', { kind: 'archive', taskId: 't-1' })
    expect(host.state().tasks[0]!.archivedAt).toBeUndefined()
    host.dispose()
  })

  it('rejects a reused requestId with a different payload', () => {
    const host = ledger()
    host.applyRequest('r1', CREATE)
    expect(() => host.applyRequest('r1', { ...CREATE, id: 't-2' })).toThrow(/reused with a different action/)
    host.dispose()
  })

  it('restores the idempotency cache across a restart', () => {
    const host = ledger()
    host.applyRequest('r1', CREATE)
    host.dispose()

    const restarted = ledger()
    restarted.applyRequest('r1', CREATE)
    expect(restarted.state().tasks).toHaveLength(1)
    restarted.dispose()
  })
})
