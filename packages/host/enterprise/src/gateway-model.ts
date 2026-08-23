import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { SESSION_CHANGED_EVENT } from './session-service.ts'
import type { Session } from './server-connector/config.ts'

/** Credential reference under which the gateway token is stored and resolved. */
export const TOKEN_ENV = 'PICOAI_GATEWAY_TOKEN'

/** Stable Cordis plugin name. */
export const name = 'gateway-model'

/** Services consumed: settings writes and the credential store the adapter resolves against. */
export const inject = ['settings', 'credentials', 'picoSession']

const LLM_DEEPSEEK_NS = settingsNamespace('llm-deepseek')

/**
 * Point the `llm-deepseek` adapter at the enterprise gateway: store the session
 * token in the credential store and set the adapter's base URL plus credential
 * reference. Clearing the session removes the credential and resets the section.
 */
export function apply(ctx: Context): void {
  const ref = credentialRef(TOKEN_ENV)

  const sync = async (session: Session | null): Promise<void> => {
    if (session === null) {
      await ctx.credentials.unset(ref)
      await ctx.settings.replace(LLM_DEEPSEEK_NS, {})
      return
    }
    await ctx.credentials.set(ref, session.token)
    await ctx.settings.update(LLM_DEEPSEEK_NS, {
      baseURL: `${session.serverURL.replace(/\/+$/, '')}/v1`,
      apiKeyEnv: TOKEN_ENV,
    })
  }

  ctx.on(SESSION_CHANGED_EVENT, (session) => { void sync(session).catch((cause) => ctx.logger.error(cause)) })
}
