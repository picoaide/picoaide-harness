import { describe, expect, it } from 'vitest'
import { parseActionEnvelope } from '../src/protocol.ts'

function envelope(action: unknown, requestId = 'req-1'): unknown {
  return { requestId, action }
}

const INPUT = {
  title: 'Ship the report',
  description: 'Write and send the weekly report',
  prompt: '请生成周报并发送',
}

describe('parseActionEnvelope', () => {
  it('accepts a valid create', () => {
    const parsed = parseActionEnvelope(envelope({ kind: 'create', id: 't-1', input: INPUT }))
    expect(parsed).toBeDefined()
    expect(parsed!.action.kind).toBe('create')
  })

  it('accepts a create with optional execution pins', () => {
    const parsed = parseActionEnvelope(envelope({
      kind: 'create', id: 't-2',
      input: { ...INPUT, workspaceId: 'w-1', mode: 'minimal', permission: 'danger-full-access' },
    }))
    expect(parsed).toBeDefined()
  })

  it('rejects permissions outside the official whitelist', () => {
    expect(parseActionEnvelope(envelope({ kind: 'create', id: 't', input: { ...INPUT, permission: 'pico' } }))).toBeUndefined()
    expect(parseActionEnvelope(envelope({ kind: 'create', id: 't', input: { ...INPUT, permission: 'danger-full-access' } }))).toBeDefined()
  })

  it('rejects command/shell-like fields anywhere', () => {
    expect(parseActionEnvelope(envelope({ kind: 'create', id: 't', input: { ...INPUT, command: 'rm -rf /' } }))).toBeUndefined()
    expect(parseActionEnvelope(envelope({ kind: 'create', id: 't', input: { ...INPUT, executable: '/bin/sh' } }))).toBeUndefined()
    expect(parseActionEnvelope(envelope({ kind: 'create', id: 't', input: { ...INPUT, shell: 'bash' } }))).toBeUndefined()
  })

  it('rejects malformed payloads', () => {
    expect(parseActionEnvelope(undefined)).toBeUndefined()
    expect(parseActionEnvelope('nope')).toBeUndefined()
    expect(parseActionEnvelope(envelope({ kind: 'run' }))).toBeUndefined()
    expect(parseActionEnvelope(envelope({ kind: 'move', taskId: 't', status: 'nope' }))).toBeUndefined()
    expect(parseActionEnvelope(envelope({ kind: 'update', taskId: 't', patch: { title: 5 } }))).toBeUndefined()
    expect(parseActionEnvelope(envelope({ kind: 'create', id: '', input: INPUT }))).toBeUndefined()
    expect(parseActionEnvelope(envelope({ kind: 'create', id: 't', input: { ...INPUT, title: '' } }))).toBeUndefined()
  })

  it('accepts move/archive/restore/delete/run/rerun with non-empty taskId', () => {
    for (const kind of ['move', 'archive', 'restore', 'delete', 'run', 'rerun'] as const) {
      const action = kind === 'move'
        ? { kind, taskId: 't', status: 'doing' as const }
        : { kind, taskId: 't' }
      expect(parseActionEnvelope(envelope(action))).toBeDefined()
      expect(parseActionEnvelope(envelope({ ...action, taskId: '' }))).toBeUndefined()
    }
  })
})
