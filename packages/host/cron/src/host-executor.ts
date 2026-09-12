/**
 * Job executor: runs one triggered job action and settles its execution
 * record. The only action kind is `agent`: create a fresh agent session
 * (optionally pinned to a workspace / agent preset / permission), send the
 * task prompt, and settle the run. Launch semantics mirror the former
 * dsh-task host runner (real DSH agent session; settlement is the Host's
 * duty — the browser never writes execution results).
 *
 * @since upstream 0.1.2 the legacy API Proxy is gone: workspace facts come
 * from the Workspace registry, preset facts from the AgentPresets service,
 * and session create/rename/prompt from the SessionController Remote owner
 * (host-side direct calls on the Remote-decorated methods).
 */
import type { SessionController } from '@deepseek-ai/dsh-api-session-controller'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import type { AgentPresets } from '@deepseek-ai/dsh-agent-presets'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import type { JobRecord } from './jobs.ts'

/**
 * Structural view of the live session a permission preset is applied to. The
 * real value is a DSH `Session`; typing the narrow shape keeps this package
 * free of a host-service type import.
 */
export interface CronSessionHandle {
  readonly id: string
}

/**
 * The slice of `ctx.permissionPresets` the executor drives. The service
 * (`packages/interaction/permission-presets`) exposes exactly these members;
 * `set()` writes the preset's sandbox + approval bundle onto a live session —
 * the same call its `/permission` command handler makes.
 */
export interface CronPermissionPresets {
  /** Switchable preset names (the roster a job's `permission` must name). */
  readonly names: readonly string[]
  /** Apply one preset to a live session. */
  set(session: CronSessionHandle, name: string): void
  /** Effective preset of a session; used to confirm the write took effect. */
  current?(session: CronSessionHandle): string
}

/** Host collaborators the executor drives to launch one agent run. */
export interface CronExecutorDeps {
  /** Session Remote owner: create/rename/prompt (host-side direct calls). */
  readonly sessionController: SessionController
  /** Workspace registry holding the canonical workspace rows (host service). */
  readonly workspaceRegistry: WorkspaceRegistry
  /** Agent preset roster (the desktop installs the Windows-guarded subclass). */
  readonly agentPresets: AgentPresets
  /**
   * Resolve the permission-preset service (FIX-17). Resolved lazily so a
   * service composed after this plugin still applies; a missing service makes
   * a job that pins `permission` FAIL instead of silently ignoring it.
   */
  readonly permissionPresets?: () => CronPermissionPresets | undefined
  /** Resolve the session store: the freshly created session the preset lands on. */
  readonly sessions?: () => { get(id: string): CronSessionHandle | undefined } | undefined
}

export class HostCronExecutor {
  constructor(private readonly deps: CronExecutorDeps) {}

  /**
   * Apply one pinned permission preset to a freshly created session (FIX-17).
   *
   * The previous implementation queued a `/permission <name>` chat line, but
   * the `prompt` channel never parses slash commands (`SessionController.prompt`
   * only accepts text; only `commands.execute()` dispatches commands), so the
   * preset was silently dropped. Writing through the permission service is the
   * same path the command handler takes, and the read-back makes a preset that
   * failed to stick a failed run instead of a silent no-op.
   */
  private applyPermissionPreset(sessionId: string, preset: string): void {
    const presets = this.deps.permissionPresets?.()
    if (presets === undefined) {
      throw new Error(`permission preset service unavailable, cannot apply "${preset}"`)
    }
    if (!presets.names.includes(preset)) {
      throw new Error(`permission preset not found: ${preset}`)
    }
    const session = this.deps.sessions?.()?.get(sessionId)
    if (session === undefined) {
      throw new Error(`session not found for permission preset: ${sessionId}`)
    }
    presets.set(session, preset)
    if (presets.current !== undefined && presets.current(session) !== preset) {
      throw new Error(`permission preset did not take effect: ${preset}`)
    }
  }

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
    // One run-scoped abort token: prompt cancellation-waives the signal, so
    // the controller is created per run and abandoned on completion.
    const runSignal = new AbortController().signal
    try {
      if (job.action.workspaceId !== undefined) {
        const workspaces = this.deps.workspaceRegistry.list()
        if (!workspaces.some(item => item.id === job.action.workspaceId)) {
          throw new Error(`workspace not found: ${job.action.workspaceId}`)
        }
      }
      if (job.action.agentPreset !== undefined) {
        const presets = await this.deps.agentPresets.list()
        const preset = presets.find(item => item.id === job.action.agentPreset)
        if (preset === undefined) throw new Error(`agent preset not found: ${job.action.agentPreset}`)
        if (preset.broken !== undefined) throw new Error(`agent preset is unavailable: ${preset.broken}`)
      }
      const created = await this.deps.sessionController.create({
        ...(job.action.workspaceId === undefined ? {} : { workspaceId: job.action.workspaceId as WorkspaceId }),
        ...(job.action.agentPreset === undefined ? {} : { agentPreset: job.action.agentPreset }),
      })
      const sessionId = created.sessionId
      try {
        await this.deps.sessionController.rename({ sessionId, title: job.name })
        if (job.action.permission !== undefined) {
          // FIX-17: direct service call (no chat line), before the task prompt
          // so the run starts under the pinned permission.
          this.applyPermissionPreset(sessionId, job.action.permission)
        }
        await this.deps.sessionController.prompt({
          requestId: crypto.randomUUID() as SessionRequestId,
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: prompt }],
        }, runSignal)
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
