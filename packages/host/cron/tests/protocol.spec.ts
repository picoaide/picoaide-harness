import { describe, expect, it } from 'vitest'
import { parseActionEnvelope } from '../src/protocol.ts'

function envelope(action: unknown, requestId = 'req-1'): unknown {
  return { requestId, action }
}

describe('parseActionEnvelope', () => {
  it('accepts a valid create', () => {
    const parsed = parseActionEnvelope(envelope({
      kind: 'create',
      id: 'job-1',
      input: {
        name: 'Daily report',
        cron: '0 9 * * *',
        action: { kind: 'task', taskId: 'task-1' },
        enabled: true,
      },
    }))
    expect(parsed).toBeDefined()
    expect(parsed!.action.kind).toBe('create')
  })

  it('accepts a valid prompt action', () => {
    const parsed = parseActionEnvelope(envelope({
      kind: 'create',
      id: 'job-2',
      input: {
        name: 'Ping',
        cron: '*/10 * * * *',
        action: { kind: 'prompt', sessionId: 's-1', text: 'hello' },
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
      input: { name: 'x', cron: '* * * * *', action: { kind: 'task', taskId: 't' }, command: 'rm -rf /' },
    }))).toBeUndefined()
    expect(parseActionEnvelope(envelope({
      kind: 'create',
      id: 'j',
      input: { name: 'x', cron: '* * * * *', action: { kind: 'prompt', sessionId: 's', text: 'hi', shell: '/bin/sh' } },
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

  it('rejects missing or empty taskId/sessionId/text', () => {
    expect(parseActionEnvelope(envelope({
      kind: 'create', id: 'j',
      input: { name: 'x', cron: '* * * * *', action: { kind: 'task', taskId: '' } },
    }))).toBeUndefined()
    expect(parseActionEnvelope(envelope({
      kind: 'create', id: 'j',
      input: { name: 'x', cron: '* * * * *', action: { kind: 'prompt', sessionId: '', text: 'hi' } },
    }))).toBeUndefined()
    expect(parseActionEnvelope(envelope({
      kind: 'create', id: 'j',
      input: { name: 'x', cron: '* * * * *', action: { kind: 'prompt', sessionId: 's', text: '' } },
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
      input: { name: 'x', cron: 'not-a-cron', action: { kind: 'task', taskId: 't' } },
    }))).toBeUndefined()
    expect(parseActionEnvelope(envelope({
      kind: 'create', id: 'j',
      input: { name: 'x', cron: '60 9 * * *', action: { kind: 'task', taskId: 't' } },
    }))).toBeUndefined()
  })

  it('rejects calendar-impossible cron expressions (silently inert jobs)', () => {
    expect(parseActionEnvelope(envelope({
      kind: 'create', id: 'j',
      input: { name: 'x', cron: '0 0 30 2 *', action: { kind: 'task', taskId: 't' } },
    }))).toBeUndefined()
  })

  it('accepts valid cron expressions including February 29', () => {
    expect(parseActionEnvelope(envelope({
      kind: 'create', id: 'j',
      input: { name: 'x', cron: '0 0 29 2 *', action: { kind: 'task', taskId: 't' } },
    }))).toBeDefined()
  })
})
