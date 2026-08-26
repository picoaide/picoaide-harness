/**
 * Job executor: runs one triggered job action and settles its execution
 * record. The only action kind is `agent`: create a fresh agent session
 * (optionally pinned to a workspace / agent preset / permission), send the
 * task prompt, and settle the run. Launch semantics mirror the former
 * dsh-task host runner (real DSH agent session; settlement is the Host's
 * duty — the browser never writes execution results).
 */
import type { ApiProxy, RpcId } from '@deepseek-ai/dsh-host-apiproxy'
import type { JobRecord } from './jobs.ts'

function request<T>(payload: T) {
  return { rpcId: `cron-${crypto.randomUUID()}` as RpcId, payload }
}

function failure(error: { code: string; message: string }): Error {
  return new Error(`${error.code}: ${error.message}`)
}

export interface CronExecutorDeps {
  api: ApiProxy
}

export class HostCronExecutor {
  constructor(private readonly deps: CronExecutorDeps) {}

  /**
   * Execute one job action. Resolves when the execution is settled (the
   * caller records sessionId/prompt onto the execution record via the
   * returned launch info; a session that was created then failed to launch
   * is reported through `error` so the ledger can settle as failed).
   */
  async execute(job: JobRecord): Promise<{
    result: 'succeeded' | 'failed'
    error?: string
    sessionId?: string
    prompt?: string
  }> {
    if (job.action.kind !== 'agent') {
      return { result: 'failed', error: `unsupported action kind: ${String(job.action.kind)}` }
    }
    const prompt = job.action.prompt
    try {
      if (job.action.workspaceId !== undefined) {
        const workspaces = await this.deps.api.workspace.list(request({}))
        if (!workspaces.result.ok) throw failure(workspaces.result.error)
        if (!workspaces.result.value.items.some(item => item.workspaceId === job.action.workspaceId)) {
          throw new Error(`workspace not found: ${job.action.workspaceId}`)
        }
      }
      if (job.action.agentPreset !== undefined) {
        const presets = await this.deps.api.agentPresets.list(request({}))
        if (!presets.result.ok) throw failure(presets.result.error)
        const preset = presets.result.value.presets.find(item => item.id === job.action.agentPreset)
        if (preset === undefined) throw new Error(`agent preset not found: ${job.action.agentPreset}`)
        if (preset.broken !== undefined) throw new Error(`agent preset is unavailable: ${preset.broken}`)
      }
      const created = await this.deps.api.sessions.create(request({
        ...(job.action.workspaceId === undefined ? {} : { workspaceId: job.action.workspaceId as never }),
        ...(job.action.agentPreset === undefined ? {} : { agentPreset: job.action.agentPreset }),
      }))
      if (!created.result.ok) throw failure(created.result.error)
      const sessionId = created.result.value.sessionId
      try {
        const renamed = await this.deps.api.sessions.rename(request({ sessionId, title: job.name }))
        if (!renamed.result.ok) throw failure(renamed.result.error)
        if (job.action.permission !== undefined) {
          const command = await this.deps.api.sessions.prompt(request({
            sessionId,
            mode: 'queue' as const,
            content: [{ type: 'text' as const, text: `/permission ${job.action.permission}` }],
          }))
          if (!command.result.ok) throw failure(command.result.error)
          if (command.result.value.command?.kind !== 'success') throw new Error('permission command was not acknowledged')
        }
        const prompted = await this.deps.api.sessions.prompt(request({
          sessionId,
          mode: 'queue' as const,
          content: [{ type: 'text' as const, text: prompt }],
        }))
        if (!prompted.result.ok) throw failure(prompted.result.error)
      } catch (error) {
        // The session exists but launch failed part-way; surface the session
        // id so the ledger can attach it before settling as failed.
        return { result: 'failed', error: error instanceof Error ? error.message : String(error), sessionId, prompt }
      }
      return { result: 'succeeded', sessionId, prompt }
    } catch (error) {
      return { result: 'failed', error: error instanceof Error ? error.message : String(error), prompt }
    }
  }
}
