import type { Context } from '@deepseek-ai/cordis'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { SESSION_CHANGED_EVENT } from './session-service.ts'
import { getBootstrap } from './server-connector/bootstrap.ts'
import type { Session } from './server-connector/config.ts'

/** Stable Cordis plugin name. */
export const name = 'bootstrap'

/** Services consumed: settings writes and the session being synced. */
export const inject = ['settings', 'picoSession']

const LLM_DEEPSEEK_NS = settingsNamespace('llm-deepseek')
const AGENT_DEFAULT_MODEL_NS = settingsNamespace('agent-default-model')

/** The provider route the `llm-deepseek` adapter registers (gateway repoints its base URL). */
const DEEPSEEK_PROVIDER = 'deepseek-official'

/**
 * Project a gateway session onto the DSH model settings: the gateway model
 * catalog drives the `llm-deepseek` models list, and the gateway default model
 * becomes the Agent default. Clearing the session resets both to composition
 * defaults.
 */
export function apply(ctx: Context): void {
  const sync = async (session: Session | null): Promise<void> => {
    if (session === null) {
      await ctx.settings.replace(AGENT_DEFAULT_MODEL_NS, {})
      await ctx.settings.replace(LLM_DEEPSEEK_NS, {})
      return
    }
    try {
      const { config: cfg } = await getBootstrap(session)
      await ctx.settings.update(LLM_DEEPSEEK_NS, {
        models: cfg.models.map((m) => ({ id: m.id, name: m.display_name })),
      })
      await ctx.settings.replace(AGENT_DEFAULT_MODEL_NS, {
        provider: DEEPSEEK_PROVIDER,
        model: cfg.default_model,
      })
    } catch (cause) {
      ctx.logger.error('pico bootstrap sync failed')
      ctx.logger.error(cause)
    }
  }

  ctx.on(SESSION_CHANGED_EVENT, (session) => { void sync(session).catch((cause) => ctx.logger.error(cause)) })
}
