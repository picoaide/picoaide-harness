import type { Context } from '@deepseek-ai/cordis'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { SESSION_CHANGED_EVENT } from './session-service.ts'
import { getBootstrap } from './server-connector/bootstrap.ts'
import { AuthError } from './server-connector/auth.ts'
import { TOKEN_ENV } from './gateway-model.ts'
import type { Session } from './server-connector/config.ts'

/** Stable Cordis plugin name. */
export const name = 'bootstrap'

/** Services consumed: settings writes and the session being synced. */
export const inject = ['settings', 'picoSession']

const LLM_DEEPSEEK_NS = settingsNamespace('llm-deepseek')
const AGENT_DEFAULT_MODEL_NS = settingsNamespace('agent-default-model')
const WEB_SEARCH_DEEPSEEK_NS = settingsNamespace('web-search-deepseek')

/** The provider route the `llm-deepseek` adapter registers (gateway repoints its base URL). */
const DEEPSEEK_PROVIDER = 'deepseek-official'

/**
 * Extract the server-configured output cap from a model's `default_params`
 * JSON (`{"max_output": N}`). The gateway injects this cap only when the
 * client omits `max_tokens`; mapping it onto the catalog model's `maxTokens`
 * makes the client send exactly the server-configured value (M5) instead of
 * its own 256k default, so the server-side cap actually applies.
 */
export function maxOutputFromDefaultParams(raw: unknown): number | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  try {
    const value = JSON.parse(raw) as { max_output?: unknown }
    if (typeof value.max_output === 'number' && Number.isFinite(value.max_output) && value.max_output > 0) {
      return Math.floor(value.max_output)
    }
    return undefined
  } catch {
    return undefined
  }
}

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
      await ctx.settings.replace(WEB_SEARCH_DEEPSEEK_NS, {})
      return
    }
    try {
      const { config: cfg } = await getBootstrap(session)
      // 服务端下发的思考强度(2026-08):llm-deepseek 适配器的
      // connection.defaults.reasoningEffort 来自 settings(off|low|high|max),
      // 这是实际生效点;同时写 agent-default-model 保持 UI 展示一致。
      const reasoningEffort = cfg.web?.default_thinking_level
      await ctx.settings.update(LLM_DEEPSEEK_NS, {
        models: cfg.models.map((m) => {
          const maxTokens = maxOutputFromDefaultParams(m.default_params)
          return {
            id: m.id,
            name: m.display_name,
            ...maxTokens === undefined ? {} : { maxTokens },
          }
        }),
        ...reasoningEffort ? { reasoningEffort } : {},
      })
      await ctx.settings.replace(AGENT_DEFAULT_MODEL_NS, {
        provider: DEEPSEEK_PROVIDER,
        model: cfg.default_model,
        ...reasoningEffort ? { reasoningEffort } : {},
      })
      // web_search 服务端代理(0043):搜索也走网关 /v1/messages,官方 key
      // 不下发客户端。apiKeyEnv 指向网关 token(与 chat 同一凭据),baseURL
      // 指向网关路由前缀(provider 追加 /messages 即 /v1/messages),model 与
      // chat 同用服务端 default_model(该模型名由服务端 anthropic 协议
      // provider 承载,与 openai 协议 provider 可同名共存)。
      await ctx.settings.update(WEB_SEARCH_DEEPSEEK_NS, {
        apiKeyEnv: TOKEN_ENV,
        baseURL: `${session.serverURL.replace(/\/+$/, '')}/v1`,
        model: cfg.default_model,
      })
    } catch (cause) {
      // M2: a revoked/expired/disabled session must not linger. Clear it so
      // the auth-gate tripwire reloads the window into the login page.
      if (cause instanceof AuthError && cause.kind === 'auth_expired') {
        ctx.picoSession.clear()
        return
      }
      ctx.logger.error('pico bootstrap sync failed')
      ctx.logger.error(cause)
    }
  }

  ctx.on(SESSION_CHANGED_EVENT, (session) => { void sync(session).catch((cause) => ctx.logger.error(cause)) })
}
