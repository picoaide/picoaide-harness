/** Windows guard for upstream agent presets that require unsupported PTY inspection. */

import type { Context } from '@deepseek-ai/cordis'
import AgentPresetRegistry, { type AgentPreset } from '@deepseek-ai/dsh-agent-preset-registry'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'

/** Upstream preset whose persistent Bash terminal cannot run on win32. */
export const WINDOWS_UNSUPPORTED_PRESET = 'minimal'

/** Upstream preset that selects the supported PowerShell toolchain on win32. */
export const WINDOWS_SAFE_PRESET = 'standard'

/**
 * Agent-preset registry that keeps Windows sessions on a supported shell
 * composition.
 *
 * Upstream 0.1.7 replaced the directory roster (`@deepseek-ai/dsh-agent-presets`,
 * published `presets/<id>/agent.cordis.yml`, discovered from filesystem roots)
 * with the declarative `@deepseek-ai/dsh-agent-preset-registry`: the registry
 * only holds definitions registered by `@deepseek-ai/dsh-agent-preset` rows, and
 * the shipped presets are contributed by the Web bundle's own patch files. The
 * service name, the roster policy overrides and the `agentPresets` Remote are
 * the same shape as before, so this guard keeps working by subclassing the new
 * implementation and letting the shipped `preset-<id>` rows register into it.
 *
 * `copy()` is deliberately **not** overridden any more: preset authoring moved
 * out of this service (0.1.7 keeps `readDocument()` for viewing and persists
 * edits through the profile configuration form), so there is no copy path left
 * to reserve the id on.
 */
export class WindowsAgentPresets extends AgentPresetRegistry {
  override get defaultId(): string {
    const id = super.defaultId
    return id === WINDOWS_UNSUPPORTED_PRESET ? WINDOWS_SAFE_PRESET : id
  }

  override async list(): Promise<AgentPreset[]> {
    return (await super.list()).filter(preset => preset.id !== WINDOWS_UNSUPPORTED_PRESET)
  }

  override async resolve(id?: string): Promise<AgentPreset> {
    if (id !== WINDOWS_UNSUPPORTED_PRESET) return await super.resolve(id)
    const preset = (await super.list()).find(candidate => candidate.id === id)
    if (preset !== undefined) return preset
    const available = (await this.list()).map(candidate => candidate.id)
    throw new RemoteError('agent-preset/not-found', `agent-presets: preset "${WINDOWS_UNSUPPORTED_PRESET}" not available on Windows (available: ${available.join(', ') || 'none'})`, { agentPreset: WINDOWS_UNSUPPORTED_PRESET, available })
  }

  override async recompose(agentCtx: Context, id: string): Promise<AgentPreset> {
    if (id === WINDOWS_UNSUPPORTED_PRESET) {
      const available = (await this.list()).map(candidate => candidate.id)
      throw new RemoteError('agent-preset/not-found', `agent-presets: preset "${WINDOWS_UNSUPPORTED_PRESET}" not available on Windows (available: ${available.join(', ') || 'none'})`, { agentPreset: WINDOWS_UNSUPPORTED_PRESET, available })
    }
    return await super.recompose(agentCtx, id)
  }
}

export default WindowsAgentPresets
