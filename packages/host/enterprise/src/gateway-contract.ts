/**
 * 网关模型链路的共享契约（唯一真源）。
 *
 * 两个值必须与组装期配置一致，改一处就得三处同改（本文件、
 * `packages/host/enterprise/cordis.patch.yml` 的行 id、以及引用它们的插件）：
 *
 *  · {@link TOKEN_ENV} —— 会话令牌在 `credentials` 服务里的引用名。`gateway-model.ts`
 *    在会话变化时 `set/unset` 它，`gateway-llm.ts` 在每次 Messages 请求前 `resolve` 它
 *    并把值作为 `Authorization: Bearer` 交给适配器；组装期 `web-search-deepseek` 行的
 *    `apiKeyEnv` 也指向同一个引用（搜索走同一个网关令牌）。
 *  · {@link GATEWAY_LLM_ROW_ID} —— 注册网关 provider 的那一行在 profile 里的 id。
 *    0.1.7 的 `SettingsForms` **以 profile 条目 id 作为设置命名空间**
 *    （`dsh-settings/lib/index.js` 的 `write()`：`entries().find(row => row.options.id === ns)`），
 *    所以 `gateway-model.ts`/`bootstrap.ts` 写 `baseURL`/`models` 用的命名空间就是它 ——
 *    行 id 一改，两处写入会以 `No configurable plugin entry "…"` 失败（模型面全灭）。
 */
/** Credential reference under which the gateway session token is stored and resolved. */
export const TOKEN_ENV = 'PICOAI_GATEWAY_TOKEN'

/** Profile row id (and therefore settings namespace) of the gateway model provider. */
export const GATEWAY_LLM_ROW_ID = 'picoaide-gateway-llm'
