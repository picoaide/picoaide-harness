/**
 * Job executor: runs one triggered job action and settles its execution
 * record. Task actions delegate to the optional picoTaskService (dsh-task);
 * prompt actions send a queue-mode prompt to a named session through the
 * Host API proxy. Settling is the Host's job — the browser never writes
 * execution results.
 */
import type { ApiProxy, RpcId } from '@deepseek-ai/dsh-host-apiproxy'
import type { JobRecord } from './jobs.ts'
import type { PicoTaskService } from './service.ts'

function request<T>(payload: T) {
  return { rpcId: `cron-${crypto.randomUUID()}` as RpcId, payload }
}

function failure(error: { code: string; message: string }): Error {
  return new Error(`${error.code}: ${error.message}`)
}

export interface CronExecutorDeps {
  api: ApiProxy
  /** Resolved per run (the task plugin may (un)load at any time). */
  taskService: () => PicoTaskService | undefined
}

export class HostCronExecutor {
  constructor(private readonly deps: CronExecutorDeps) {}

  /**
   * Execute one job action. Resolves when the execution is settled.
   * @returns the settle result for tests.
   */
  async execute(job: JobRecord, _execution: { id: string }): Promise<{ result: 'succeeded' | 'failed'; error?: string }> {
    switch (job.action.kind) {
      case 'task': {
        const taskService = this.deps.taskService()
        if (taskService === undefined) {
          return { result: 'failed', error: 'task service unavailable (dsh-task plugin not loaded)' }
        }
        try {
          const outcome = await taskService.runTask(job.action.taskId)
          if (outcome.ok) return { result: 'succeeded' }
          return { result: 'failed', error: outcome.error }
        } catch (error) {
          return { result: 'failed', error: error instanceof Error ? error.message : String(error) }
        }
      }
      case 'prompt': {
        try {
          const response = await this.deps.api.sessions.prompt(request({
            sessionId: job.action.sessionId as never,
            mode: 'queue' as const,
            content: [{ type: 'text' as const, text: job.action.text }],
          }))
          if (!response.result.ok) throw failure(response.result.error)
          return { result: 'succeeded' }
        } catch (error) {
          return { result: 'failed', error: error instanceof Error ? error.message : String(error) }
        }
      }
    }
  }
}
