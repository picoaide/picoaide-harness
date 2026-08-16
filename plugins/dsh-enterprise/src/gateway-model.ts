import type { Context } from '@deepseek-ai/cordis'
import type { Session } from './server-connector/config.ts'
import { SESSION_CHANGED_EVENT, type SessionEvents } from './session-service.ts'

export const TOKEN_ENV = 'PICOAI_GATEWAY_TOKEN'
const SETTINGS_NS = 'llm-deepseek'

interface SettingsLike { update(ns: string, patch: Record<string, unknown>): Promise<unknown> }

export const name = 'gateway-model'
export const inject = ['settings']

export function apply(ctx: Context): void {
  const settings = ctx.get('settings') as SettingsLike
  const events = ctx as unknown as SessionEvents
  events.on(SESSION_CHANGED_EVENT, (session: Session | null) => {
    if (!session) {
      process.env[TOKEN_ENV] = ''
      void settings.update(SETTINGS_NS, { baseURL: '', apiKeyEnv: '' })
      return
    }
    process.env[TOKEN_ENV] = session.token
    void settings.update(SETTINGS_NS, {
      baseURL: `${session.serverURL.replace(/\/+$/, '')}/v1`,
      apiKeyEnv: TOKEN_ENV,
    })
  })
}
