/**
 * 持久化会话/bootstrap 载荷形状的**同名 re-export**。
 *
 * 实现已收敛到叶子包 `@picoaide/dsh-gateway-client/config`（2026-10-13，P0-b，
 * 理由见 `auth.ts` 的注释）。`@picoaide/dsh-enterprise/server-connector/config`
 * 仍是 `packages/client/account-card` 在消费的外部契约。
 *
 * **改形状请只改叶子包那份。**
 */
export * from '@picoaide/dsh-gateway-client/config'
