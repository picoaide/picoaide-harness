import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { GATEWAY_LLM_ROW_ID, TOKEN_ENV } from './gateway-contract.ts'
import { SESSION_CHANGED_EVENT } from './session-service.ts'
import { createSessionEpoch } from './session-epoch.ts'
import type { Session } from './server-connector/config.ts'

export { TOKEN_ENV }

/** Stable Cordis plugin name. */
export const name = 'gateway-model'

/** Services consumed: settings writes and the credential store the adapter resolves against. */
export const inject = ['settings', 'credentials', 'picoSession']

const GATEWAY_LLM_NS = GATEWAY_LLM_ROW_ID as SettingsNamespace

/**
 * Point the gateway model provider at the enterprise server: store the session
 * token in the credential store and set the provider row's `baseURL`. Clearing
 * the session removes the credential and resets the section.
 *
 * 0.1.7 起这里**只写 `baseURL`**：
 *  · `protocol` 键已从上游 `llm-deepseek` 删除，**配了就抛错**
 *    （`llm-deepseek/src/config.ts:207` → `llm-deepseek: protocol is not configurable;
 *    remove it and use a Messages-compatible baseURL`）。适配器只剩 Messages 一条路径，
 *    端点固定 `<baseURL>/messages` ⇒ 写 `<server>/v1` 就是网关的 `/v1/messages`。
 *  · 鉴权不再经过 settings 的 `apiKeyEnv`：那个键只存在于上游
 *    `dsh-llm-deepseek-api-key` 的私有 Config（且它硬编码 `x-api-key`，对只认
 *    `Authorization: Bearer` 的网关必然 401）。本行换成 `gateway-llm.ts` 的 provider
 *    注册，令牌由它在每次请求前从 `credentials` 服务按 {@link TOKEN_ENV} 解析。
 *    往本行写 `apiKeyEnv` 还会直接抛错（`SettingsForms.write` 的
 *    `Config field "apiKeyEnv" is not volatile` 守卫 —— 本行的 Config 没有这个字段）。
 */
export function apply(ctx: Context): void {
  const ref = credentialRef(TOKEN_ENV)
  // Z2-01：会话代际守卫（唯一实现见 session-epoch.ts）。
  //
  // 这里没有网络往返，但 `credentials.unset/set` 与 `settings.replace/update` **之间**
  // 有 await（凭据要落盘/走 keyring）。登出那次 `sync(null)` 的续体如果落在重新登录
  // 之后，就会把新会话的 provider 段整段清空 —— 凭据还是新会话的令牌，模型
  // 链路却没了 baseURL，直到下一次会话变化才恢复。
  const epochs = createSessionEpoch()

  const sync = async (session: Session | null): Promise<void> => {
    const epoch = epochs.begin()
    if (session === null) {
      await ctx.credentials.unset(ref)
      if (!epochs.isCurrent(epoch)) return
      await ctx.settings.replace(GATEWAY_LLM_NS, {})
      return
    }
    await ctx.credentials.set(ref, session.token)
    if (!epochs.isCurrent(epoch)) return
    await ctx.settings.update(GATEWAY_LLM_NS, {
      baseURL: `${session.serverURL.replace(/\/+$/, '')}/v1`,
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
