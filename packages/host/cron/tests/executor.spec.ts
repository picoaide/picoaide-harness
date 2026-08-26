import { describe, expect, it, vi } from 'vitest'
import { HostCronExecutor } from '../src/host-executor.ts'
import type { JobRecord } from '../src/jobs.ts'

/** A minimal ApiProxy fake with just enough surface for the executor. */
function fakeApi(overrides: Record<string, (payload: unknown) => Promise<unknown>> = {}) {
  const ok = (value: unknown) => ({ result: { ok: true as const, value } })
  const api = {
    workspace: { list: vi.fn(async () => ok({ items: [{ workspaceId: 'ws-1' }] })) },
    agentPresets: {
      list: vi.fn(async () => ok({
        presets: [
          { id: 'default', name: 'Default', trust: 'system', isDefault: true },
          { id: 'broken-preset', name: 'Broken', trust: 'system', isDefault: false, broken: 'missing plugin' },
        ],
        authorable: false,
        hasDocument: false,
      })),
    },
    sessions: {
      create: vi.fn(async () => ok({ sessionId: 'sess-1' })),
      rename: vi.fn(async () => ok({})),
      prompt: vi.fn(async () => ok({ command: { kind: 'success' } })),
    },
  }
  for (const [path, fn] of Object.entries(overrides)) {
    const parts = path.split('.')
    let cursor: Record<string, unknown> = api as unknown as Record<string, unknown>
    for (const part of parts.slice(0, -1)) {
      cursor = cursor[part] as Record<string, unknown>
    }
    cursor[parts[parts.length - 1]] = fn
  }
  return api
}

function job(overrides: Partial<JobRecord['action']> & { name?: string } = {}): JobRecord {
  const action = { kind: 'agent' as const, prompt: 'do the thing', ...overrides }
  return {
    id: 'job-1',
    name: overrides.name ?? 'Daily',
    cron: '0 9 * * *',
    action,
    enabled: true,
    executions: [],
    createdAt: 0,
    updatedAt: 0,
  }
}

describe('HostCronExecutor agent action', () => {
  it('creates a session, prompts it, and reports success with session info', async () => {
    const api = fakeApi()
    const executor = new HostCronExecutor({ api: api as never })
    const result = await executor.execute(job())
    expect(result.result).toBe('succeeded')
    expect(result.sessionId).toBe('sess-1')
    expect(result.prompt).toBe('do the thing')
    expect(api.sessions.create).toHaveBeenCalledOnce()
    expect(api.sessions.prompt).toHaveBeenCalledOnce()
  })

  it('validates the workspace before creating a session', async () => {
    const api = fakeApi({
      'workspace.list': async () => ({ result: { ok: true as const, value: { items: [] } } }),
    })
    const executor = new HostCronExecutor({ api: api as never })
    const result = await executor.execute(job({ workspaceId: 'ws-missing' }))
    expect(result.result).toBe('failed')
    expect(result.error).toMatch(/workspace not found/)
    expect(api.sessions.create).not.toHaveBeenCalled()
  })

  it('rejects an unknown or broken agent preset before creating a session', async () => {
    const api = fakeApi()
    const executor = new HostCronExecutor({ api: api as never })
    const unknown = await executor.execute(job({ agentPreset: 'nope' }))
    expect(unknown.result).toBe('failed')
    expect(unknown.error).toMatch(/agent preset not found/)
    const broken = await executor.execute(job({ agentPreset: 'broken-preset' }))
    expect(broken.result).toBe('failed')
    expect(broken.error).toMatch(/unavailable/)
    expect(api.sessions.create).not.toHaveBeenCalled()
  })

  it('applies /permission before the prompt', async () => {
    const api = fakeApi()
    const executor = new HostCronExecutor({ api: api as never })
    const result = await executor.execute(job({ permission: 'workspace-write' }))
    expect(result.result).toBe('succeeded')
    expect(api.sessions.prompt).toHaveBeenCalledTimes(2)
    const firstCall = (api.sessions.prompt as ReturnType<typeof vi.fn>).mock.calls[0]![0]
    expect(JSON.stringify(firstCall)).toContain('/permission workspace-write')
  })

  it('reports failed when the session prompt is refused', async () => {
    const api = fakeApi({
      'sessions.prompt': async () => ({ result: { ok: false as const, error: { code: 'E', message: 'refused' } } }),
    })
    const executor = new HostCronExecutor({ api: api as never })
    const result = await executor.execute(job())
    expect(result.result).toBe('failed')
    expect(result.error).toMatch(/refused/)
    expect(result.sessionId).toBe('sess-1')
  })

  it('rejects a post-create failure with the session id attached (ghost guard)', async () => {
    const api = fakeApi({
      'sessions.rename': async () => ({ result: { ok: false as const, error: { code: 'E', message: 'rename failed' } } }),
    })
    const executor = new HostCronExecutor({ api: api as never })
    const result = await executor.execute(job())
    expect(result.result).toBe('failed')
    expect(result.error).toMatch(/rename failed/)
    expect(result.sessionId).toBe('sess-1')
  })
})
