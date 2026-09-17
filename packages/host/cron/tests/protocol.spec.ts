import { describe, expect, it } from 'vitest'
import { parseActionEnvelope } from '../src/protocol.ts'

function envelope(action: unknown, requestId = 'req-1'): unknown {
  return { requestId, action }
}

const AGENT_ACTION = { kind: 'agent', prompt: 'do the thing', workspaceId: 'ws-1', agentPreset: 'default', permission: 'workspace-write' }

describe('parseActionEnvelope', () => {
  it('accepts a valid create (agent action)', () => {
    const parsed = parseActionEnvelope(envelope({
      kind: 'create',
      id: 'job-1',
      input: {
        name: 'Daily report',
        cron: '0 9 * * *',
        action: AGENT_ACTION,
        enabled: true,
      },
    }))
    expect(parsed).toBeDefined()
    expect(parsed!.action.kind).toBe('create')
  })

  it('accepts a minimal agent action (prompt only)', () => {
    const parsed = parseActionEnvelope(envelope({
      kind: 'create',
      id: 'job-2',
      input: {
        name: 'Ping',
        cron: '*/10 * * * *',
        action: { kind: 'agent', prompt: 'hello' },
      },
    }))
    expect(parsed).toBeDefined()
  })

  it('rejects unknown action kinds', () => {
    expect(parseActionEnvelope(envelope({ kind: 'explode', jobId: 'x' }))).toBeUndefined()
  })

  it('rejects command/shell-like fields anywhere', () => {
    expect(parseActionEnvelope(envelope({
      kind: 'create',
      id: 'j',
      input: { name: 'x', cron: '* * * * *', action: { kind: 'agent', prompt: 'p', command: 'rm -rf /' } },
    }))).toBeUndefined()
    expect(parseActionEnvelope(envelope({
      kind: 'create',
      id: 'j',
      input: { name: 'x', cron: '* * * * *', action: { kind: 'agent', prompt: 'p', shell: '/bin/sh' } },
    }))).toBeUndefined()
  })

  it('rejects the removed task/prompt action kinds', () => {
    expect(parseActionEnvelope(envelope({
      kind: 'create', id: 'j',
      input: { name: 'x', cron: '* * * * *', action: { kind: 'task', taskId: 't' } },
    }))).toBeUndefined()
    expect(parseActionEnvelope(envelope({
      kind: 'create', id: 'j',
      input: { name: 'x', cron: '* * * * *', action: { kind: 'prompt', sessionId: 's', text: 'hi' } },
    }))).toBeUndefined()
  })

  it('rejects malformed payloads', () => {
    expect(parseActionEnvelope(undefined)).toBeUndefined()
    expect(parseActionEnvelope('nope')).toBeUndefined()
    expect(parseActionEnvelope({ requestId: '', action: { kind: 'run', jobId: 'j' } })).toBeUndefined()
    expect(parseActionEnvelope(envelope({ kind: 'run' }))).toBeUndefined()
    expect(parseActionEnvelope(envelope({ kind: 'update', jobId: 'j', patch: { cron: 5 } }))).toBeUndefined()
    expect(parseActionEnvelope(envelope({ kind: 'update', jobId: 'j', patch: { enabled: 'yes' } }))).toBeUndefined()
    expect(parseActionEnvelope(envelope({ kind: 'create', id: '', input: {} }))).toBeUndefined()
  })

  it('rejects missing or empty prompt', () => {
    expect(parseActionEnvelope(envelope({
      kind: 'create', id: 'j',
      input: { name: 'x', cron: '* * * * *', action: { kind: 'agent', prompt: '' } },
    }))).toBeUndefined()
    expect(parseActionEnvelope(envelope({
      kind: 'create', id: 'j',
      input: { name: 'x', cron: '* * * * *', action: { kind: 'agent', prompt: '   ' } },
    }))).toBeUndefined()
  })

  it('accepts enable/disable/delete/run/rerun with a non-empty jobId', () => {
    for (const kind of ['enable', 'disable', 'delete', 'run', 'rerun'] as const) {
      expect(parseActionEnvelope(envelope({ kind, jobId: 'j' }))).toBeDefined()
      expect(parseActionEnvelope(envelope({ kind, jobId: '' }))).toBeUndefined()
    }
  })

  it('rejects extra envelope keys', () => {
    expect(parseActionEnvelope({ requestId: 'r', action: { kind: 'run', jobId: 'j' }, extra: 1 })).toBeUndefined()
  })
})

describe('parseActionEnvelope cron validation', () => {
  it('rejects malformed cron expressions at the protocol layer', () => {
    expect(parseActionEnvelope(envelope({
      kind: 'create', id: 'j',
      input: { name: 'x', cron: 'not-a-cron', action: { kind: 'agent', prompt: 'p' } },
    }))).toBeUndefined()
    expect(parseActionEnvelope(envelope({
      kind: 'create', id: 'j',
      input: { name: 'x', cron: '60 9 * * *', action: { kind: 'agent', prompt: 'p' } },
    }))).toBeUndefined()
  })

  it('rejects calendar-impossible cron expressions (silently inert jobs)', () => {
    expect(parseActionEnvelope(envelope({
      kind: 'create', id: 'j',
      input: { name: 'x', cron: '0 0 30 2 *', action: { kind: 'agent', prompt: 'p' } },
    }))).toBeUndefined()
  })

  it('accepts valid cron expressions including February 29', () => {
    expect(parseActionEnvelope(envelope({
      kind: 'create', id: 'j',
      input: { name: 'x', cron: '0 0 29 2 *', action: { kind: 'agent', prompt: 'p' } },
    }))).toBeDefined()
  })

  it('accepts AND schedules whose next match is years out (S08-02 审计)', () => {
    // 日/周 AND 分支的命中间隔可达 40 年：固定八年视野曾把这三条合法表达式
    // 判成 invalid-action（2026-09-17 S08-02 审计）。
    for (const cron of ['0 0 */7 3 0', '0 0 29 2 */7', '0 0 */31 1 1']) {
      expect(parseActionEnvelope(envelope({
        kind: 'create', id: 'j',
        input: { name: 'x', cron, action: { kind: 'agent', prompt: 'p' } },
      })), cron).toBeDefined()
    }
  })
})

describe('FIX-17: permission 是枚举,不是自由文本', () => {
  const create = (permission: unknown): unknown => envelope({
    kind: 'create',
    id: 'job-perm',
    input: { name: 'x', cron: '* * * * *', action: { kind: 'agent', prompt: 'p', permission } },
  })

  it('rejects a permission that is not a known preset name', () => {
    // The preset roster comes from ctx.permissionPresets.names.
    const options = { permissions: ['read-only', 'workspace-write', 'danger-full-access'] }
    expect(parseActionEnvelope(create('read-only'), options)).toBeDefined()
    expect(parseActionEnvelope(create('custom'), options)).toBeUndefined()
    expect(parseActionEnvelope(create('/permission read-only'), options)).toBeUndefined()
    expect(parseActionEnvelope(create('read-only '), options)).toBeUndefined()
    expect(parseActionEnvelope(create(''), options)).toBeUndefined()
  })

  it('rejects every permission when no preset service is composed', () => {
    expect(parseActionEnvelope(create('workspace-write'), { permissions: [] })).toBeUndefined()
  })

  it('still accepts a job without a permission pin', () => {
    const parsed = parseActionEnvelope(envelope({
      kind: 'create',
      id: 'job-perm',
      input: { name: 'x', cron: '* * * * *', action: { kind: 'agent', prompt: 'p' } },
    }), { permissions: ['read-only'] })
    expect(parsed).toBeDefined()
  })
})
