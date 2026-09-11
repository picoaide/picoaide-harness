/**
 * `GET /api/client/v2/auth/usage` 的**唯一契约**(2026-09-11 收敛)。
 *
 * 背景:此前 payload 有两份手写 interface —— `usage-service.ts` 的 `UsagePayload`
 * 完全没有 balance 字段,`AccountCard.tsx` 又在组件里就地声明了一遍可选字段,
 * 两边互相冲突且没有运行时校验(服务端改字段名只会静默失效)。本文件是唯一真源:
 * 类型、键集合、解析校验都在这里,服务端有测试读取 `USAGE_PAYLOAD_KEYS` 做集合对拍。
 *
 * 服务端语义(server/internal/serverauth/handler.go handleUsageSummary):
 *   - 员工唯一可花的钱 = **账户余额**(balance_money,已按分位下发);
 *   - balance_activated=false 表示从未入账 —— 客户端不渲染余额行;
 *   - token/金额配额与部门预算已下线,不再下发 quota_ 与 remaining_ 系列字段。
 *
 * @module @picoaide/dsh-account-card/usage-contract
 */

/** 服务端 `/auth/usage` 的完整字段集合(与 Go handler 一一对应)。 */
export const USAGE_PAYLOAD_KEYS = [
  'balance_money',
  'balance_activated',
  'balance_enabled',
  'balance_monthly',
  'balance_mode',
  'is_admin',
  'monthly_usage',
  'monthly_cost',
  'today_usage',
  'today_cost',
  'yesterday_usage',
  'yesterday_cost',
  'total_usage',
  'total_cost',
] as const

/** 账户卡消费的用量载荷(唯一类型定义)。 */
export interface UsagePayload {
  /** 账户余额(元,服务端已 quantize 到分)。 */
  balance_money: number
  /** 是否已开通余额账户(首次入账置位);false = 客户端不显示余额行。 */
  balance_activated: boolean
  /** 余额闸门是否开启(仅用于文案:开启时余额耗尽会被网关拦截)。 */
  balance_enabled: boolean
  /** 每月发放额度(元,0 = 未配置)。 */
  balance_monthly: number
  /** 发放方式:add 累加 | cover 清零后重发。 */
  balance_mode: string
  is_admin: boolean
  monthly_usage: number
  monthly_cost: number
  today_usage: number
  today_cost: number
  yesterday_usage: number
  yesterday_cost: number
  total_usage: number
  total_cost: number
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/**
 * 运行时校验并归一化一份 payload:字段类型不符或缺失时返回 null(调用方
 * 保持上一份快照/空态),而不是把 `undefined` 漏进渲染层(formatMoney(undefined)
 * 曾直接崩掉整个侧边栏 slot)。
 *
 * 规则:必填的数值/布尔字段全部校验;服务端未知的新字段被忽略(向后兼容)。
 */
export function parseUsagePayload(raw: unknown): UsagePayload | null {
  if (raw === null || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (
    !isNum(r.balance_money) || !isNum(r.balance_monthly) || !isNum(r.monthly_usage) ||
    !isNum(r.monthly_cost) || !isNum(r.today_usage) || !isNum(r.today_cost) ||
    !isNum(r.yesterday_usage) || !isNum(r.yesterday_cost) ||
    !isNum(r.total_usage) || !isNum(r.total_cost)
  ) {
    return null
  }
  if (typeof r.balance_activated !== 'boolean' || typeof r.balance_enabled !== 'boolean' ||
      typeof r.is_admin !== 'boolean' || typeof r.balance_mode !== 'string') {
    return null
  }
  return {
    balance_money: r.balance_money,
    balance_activated: r.balance_activated,
    balance_enabled: r.balance_enabled,
    balance_monthly: r.balance_monthly,
    balance_mode: r.balance_mode,
    is_admin: r.is_admin,
    monthly_usage: r.monthly_usage,
    monthly_cost: r.monthly_cost,
    today_usage: r.today_usage,
    today_cost: r.today_cost,
    yesterday_usage: r.yesterday_usage,
    yesterday_cost: r.yesterday_cost,
    total_usage: r.total_usage,
    total_cost: r.total_cost,
  }
}
