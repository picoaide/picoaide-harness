import { describe, expect, it, vi } from 'vitest'
import { HostCronExecutor } from '../src/host-executor.ts'
import type { JobRecord } from '../src/jobs.ts'

/**
 * Minimal downstream fakes for the 0.1.2 collaborators: the SessionController
 * Remote owner (create/rename/prompt), the Workspace registry, and the
 * AgentPresets roster — just enough surface for the executor.
 */
function fakeDeps(overrides: Record<string, (payload: unknown) => Promise<unknown>> = {}) {
  const ok = (value: unknown) => ({ result: { ok: true as const, value } })
  const sessionController = {
    create: vi.fn(async () => ({ sessionId: 'sess-1' })),
    rename: vi.fn(async () => ({ title: 'Daily', seq: 1 })),
    prompt: vi.fn(async () => ({ accepted: true })),
  }
  const deps = {
    sessionController: sessionController as unknown,
    workspaceRegistry: {
      list: vi.fn(() => [{ id: 'ws-1', path: '/w', title: 'W', sessionIds: [], createdAt: '', updatedAt: '' }]),
    },
    agentPresets: {
      list: vi.fn(async () => [
        { id: 'default', name: 'Default', trust: 'system' as const, isDefault: true },
        {
          id: 'broken-preset', name: 'Broken', trust: 'system' as const,
          isDefault: false, broken: 'missing plugin',
        },
      ]),
    },
  }
  for (const [path, fn] of Object.entries(overrides)) {
    const parts = path.split('.')
    let cursor: Record<string, unknown> = deps as unknown as Record<string, unknown>
    for (const part of parts.slice(0, -1)) {
      cursor = cursor[part] as Record<string, unknown>
    }
    cursor[parts[parts.length - 1]] = fn
  }
  return { deps, sessionController, workspaceRegistry: deps.workspaceRegistry, agentPresets: deps.agentPresets }
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
    const { deps, sessionController } = fakeDeps()
    const executor = new HostCronExecutor(deps as never)
    const result = await executor.execute(job())
    expect(result.result).toBe('succeeded')
    expect(result.sessionId).toBe('sess-1')
    expect(result.prompt).toBe('do the thing')
    expect(sessionController.create).toHaveBeenCalledOnce()
    expect(sessionController.prompt).toHaveBeenCalledOnce()
  })

  it('validates the workspace before creating a session', async () => {
    const { deps, sessionController } = fakeDeps({
      'workspaceRegistry.list': () => [],
    })
    const executor = new HostCronExecutor(deps as never)
    const result = await executor.execute(job({ workspaceId: 'ws-missing' }))
    expect(result.result).toBe('failed')
    expect(result.error).toMatch(/workspace not found/)
    expect(sessionController.create).not.toHaveBeenCalled()
  })

  it('rejects an unknown or broken agent preset before creating a session', async () => {
    const { deps, sessionController } = fakeDeps()
    const executor = new HostCronExecutor(deps as never)
    const unknown = await executor.execute(job({ agentPreset: 'nope' }))
    expect(unknown.result).toBe('failed')
    expect(unknown.error).toMatch(/agent preset not found/)
    const broken = await executor.execute(job({ agentPreset: 'broken-preset' }))
    expect(broken.result).toBe('failed')
    expect(broken.error).toMatch(/unavailable/)
    expect(sessionController.create).not.toHaveBeenCalled()
  })

  it('applies /permission before the prompt', async () => {
    const { deps, sessionController } = fakeDeps()
    const executor = new HostCronExecutor(deps as never)
    const result = await executor.execute(job({ permission: 'workspace-write' }))
    expect(result.result).toBe('succeeded')
    expect(sessionController.prompt).toHaveBeenCalledTimes(2)
    const firstCall = (sessionController.prompt as ReturnType<typeof vi.fn>).mock.calls[0]![0]
    expect(JSON.stringify(firstCall)).toContain('/permission workspace-write')
  })

  it('reports failed when the session prompt is refused', async () => {
    const { deps, sessionController } = fakeDeps({
      'sessionController.prompt': async () => { throw new Error('E: refused') },
    })
    const executor = new HostCronExecutor(deps as never)
    const result = await executor.execute(job())
    expect(result.result).toBe('failed')
    expect(result.error).toMatch(/refused/)
    expect(result.sessionId).toBe('sess-1')
  })

  it('rejects a post-create failure with the session id attached (ghost guard)', async () => {
    const { deps, sessionController } = fakeDeps({
      'sessionController.rename': async () => { throw new Error('E: rename failed') },
    })
    const executor = new HostCronExecutor(deps as never)
    const result = await executor.execute(job())
    expect(result.result).toBe('failed')
    expect(result.error).toMatch(/rename failed/)
    expect(result.sessionId).toBe('sess-1')
  })
})
