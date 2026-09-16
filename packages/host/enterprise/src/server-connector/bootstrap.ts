import { fetchJSON } from './auth.ts'
import type { BootstrapConfig, Session } from './config.ts'

export const EMPTY: BootstrapConfig = { models: [], skills: [], mcp: [], web: {}, default_model: '' }

/**
 * 回退**种类**(2026-09-16,GlitchTip 收集为空缺陷回修)。
 *
 * `fellBack` 是个布尔,但它把两种**后果完全不同**的情况混成了一个值:
 *
 *  - `empty` —— `models` 为空/形状不合 ⇒ 整份配置被换成 `EMPTY`(`web:{}`)。
 *    **真正的致命回退**:服务端下发的 DSN 连同开关一起被丢弃。error-reporting
 *    必须据此判定 `config_unavailable` 并告警。
 *  - `default_model_substituted` —— `models` 非空,只是 `default_model` 不在其中
 *    (settings 里没配/模型被改名/版本错配) ⇒ 配置**原样保留**,只把
 *    `default_model` 替补成 `models[0]`。这对**错误上报毫无影响**:
 *    `web.error_reporting_*` 仍在下发。
 *
 * 为什么必须区分(实测教训):E2E 夹具一度有 `models` 但没有 `default_model`,
 * 客户端拿到的是"配置完整、只有默认模型被替补"的良性回退 —— 而按布尔判定,
 * error-reporting 会**静默关掉上报**,一个字节都不发,正是本轮要消灭的那类缺陷。
 */
export type BootstrapFallback = 'ok' | 'empty' | 'default_model_substituted'

export interface BootstrapValidation {
  config: BootstrapConfig
  /** 兼容字段:是否发生过任何一种回退(`ok` 之外都为 true)。 */
  fellBack: boolean
  /** 回退种类;`ok` = 未回退。 */
  fallback: BootstrapFallback
}

export function validateBootstrap(cfg: BootstrapConfig | null | undefined): BootstrapValidation {
  if (!cfg || typeof cfg !== 'object' || !Array.isArray(cfg.models) || cfg.models.length === 0) {
    return { config: EMPTY, fellBack: true, fallback: 'empty' }
  }
  if (cfg.models.some((m) => m.id === cfg.default_model)) {
    return { config: cfg, fellBack: false, fallback: 'ok' }
  }
  return {
    config: { ...cfg, default_model: cfg.models[0]!.id },
    fellBack: true,
    fallback: 'default_model_substituted',
  }
}

export async function getBootstrap(session: Session): Promise<BootstrapValidation> {
  const data = (await fetchJSON(session.serverURL, '/api/client/v2/config/bootstrap', { token: session.token })) as BootstrapConfig
  return validateBootstrap(data)
}
