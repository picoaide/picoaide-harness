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

  // FIX-17: the old regression here asserted the STRING '/permission X' was in
  // the queued prompt — which stayed green while the preset was silently
  // dropped (the prompt channel never parses slash commands). The behavioural
  // replacement lives in the FIX-17 describe block below.

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

describe('FIX-17: permission preset is applied through the permission service', () => {
  interface PermissionCall { sessionId: string; preset: string }

  function permissionDeps(state: {
    names?: readonly string[]
    apply?: (session: { id: string }, preset: string) => void
    current?: (session: { id: string }) => string
    missingSession?: boolean
    missingService?: boolean
  } = {}) {
    const applied: PermissionCall[] = []
    const base = fakeDeps()
    const deps = base.deps as unknown as Record<string, unknown>
    if (state.missingService !== true) {
      const service = {
        names: state.names ?? ['read-only', 'workspace-write'],
        set: (session: { id: string }, preset: string) => {
          applied.push({ sessionId: session.id, preset })
          state.apply?.(session, preset)
        },
        current: state.current ?? (() => state.names?.[1] ?? 'workspace-write'),
      }
      deps.permissionPresets = () => service
    } else {
      deps.permissionPresets = () => undefined
    }
    if (state.missingSession !== true) {
      deps.sessions = () => ({ get: (id: string) => ({ id }) })
    } else {
      deps.sessions = () => undefined
    }
    return { ...base, deps, applied }
  }

  it('applies the preset and never sends a /permission prompt', async () => {
    const { deps, sessionController, applied } = permissionDeps()
    const executor = new HostCronExecutor(deps as never)
    const result = await executor.execute(job({ permission: 'workspace-write' }))

    expect(result.result).toBe('succeeded')
    // Behavioural assertion: the preset really reached the permission service.
    expect(applied).toEqual([{ sessionId: 'sess-1', preset: 'workspace-write' }])
    // Exactly one prompt — the task prompt. The old implementation queued a
    // "/permission X" line that no channel ever parsed (silent no-op).
    expect(sessionController.prompt).toHaveBeenCalledTimes(1)
    const promptPayload = JSON.stringify((sessionController.prompt as ReturnType<typeof vi.fn>).mock.calls[0]![0])
    expect(promptPayload).toContain('do the thing')
    expect(promptPayload).not.toContain('/permission')
  })

  it('fails the run when the pinned preset is not in the roster', async () => {
    const { deps, applied } = permissionDeps()
    const executor = new HostCronExecutor(deps as never)
    const result = await executor.execute(job({ permission: 'custom' }))
    expect(result.result).toBe('failed')
    expect(result.error).toMatch(/permission preset not found/)
    expect(applied).toEqual([])
  })

  it('fails the run when no permission service is composed (never silently ignores)', async () => {
    const { deps } = permissionDeps({ missingService: true })
    const executor = new HostCronExecutor(deps as never)
    const result = await executor.execute(job({ permission: 'workspace-write' }))
    expect(result.result).toBe('failed')
    expect(result.error).toMatch(/permission preset service unavailable/)
  })

  it('fails the run when the preset did not take effect on the session', async () => {
    const { deps } = permissionDeps({ current: () => 'custom' })
    const executor = new HostCronExecutor(deps as never)
    const result = await executor.execute(job({ permission: 'workspace-write' }))
    expect(result.result).toBe('failed')
    expect(result.error).toMatch(/did not take effect/)
  })

  it('fails the run when the session cannot be resolved', async () => {
    const { deps } = permissionDeps({ missingSession: true })
    const executor = new HostCronExecutor(deps as never)
    const result = await executor.execute(job({ permission: 'read-only' }))
    expect(result.result).toBe('failed')
    expect(result.error).toMatch(/session not found/)
  })
})
