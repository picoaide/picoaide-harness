import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { SESSION_CHANGED_EVENT } from './session-service.ts'
import type { Session } from './server-connector/config.ts'

/** Credential reference under which the gateway token is stored and resolved. */
export const TOKEN_ENV = 'PICOAI_GATEWAY_TOKEN'

/** Stable Cordis plugin name. */
export const name = 'gateway-model'

/** Services consumed: settings writes and the credential store the adapter resolves against. */
export const inject = ['settings', 'credentials', 'picoSession']

const LLM_DEEPSEEK_NS = 'llm-deepseek' as SettingsNamespace

/**
 * Point the `llm-deepseek` adapter at the enterprise gateway: store the session
 * token in the credential store and set the adapter's base URL plus credential
 * reference. Clearing the session removes the credential and resets the section.
 *
 * `protocol` 必须显式写成 `chat-completions`：0.1.6-alpha.2 给适配器新增了
 * `protocol`，**默认值是 `messages`**（`llm-deepseek/src/config.ts` 的
 * `z.union(['chat-completions','messages']).default('messages')`）。不写的话请求
 * 会打到 `<server>/v1/messages`，而该路径只发 `x-api-key`、不发 `Authorization`
 * （`protocols/messages/adapter.ts`），我们的网关 `/v1/messages` 挂在 BearerAuth
 * 下且 `bearerToken()` 只认 `Authorization: Bearer` ⇒ 每个模型请求 401，整条
 * 链路报废。即使补上鉴权，该路径在网关里固定记 `kind="search"` 且只匹配
 * anthropic 协议的上游 ⇒ 对话会被记错计费口径、只配 openai 的机房直接 404。
 * 所以这是必需项，不是可选优化。
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
      protocol: 'chat-completions',
      baseURL: `${session.serverURL.replace(/\/+$/, '')}/v1`,
      apiKeyEnv: TOKEN_ENV,
    })
  }

  // SessionService.restore() starts in its constructor and may complete before
  // this plugin's apply(), in which case the first SESSION_CHANGED_EVENT is
  // already gone (session-service.ts documents the race). Sample the restored
  // session once here; the event subscription then covers later transitions.
  const sampleRestoredSession = (): void => {
    try {
      const service = (ctx as unknown as {
        picoSession?: { isRestored?: () => boolean, getSession?: () => Session | null }
      }).picoSession
      if (service?.isRestored?.() !== true) return
      void sync(service.getSession?.() ?? null).catch((cause) => ctx.logger.error(cause))
    } catch (cause) {
      ctx.logger.error(cause)
    }
  }
  sampleRestoredSession()
  ctx.on(SESSION_CHANGED_EVENT, (session) => { void sync(session).catch((cause) => ctx.logger.error(cause)) })
}
