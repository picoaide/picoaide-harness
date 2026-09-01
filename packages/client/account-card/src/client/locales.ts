/**
 * Account card client UI copy: zh is the key source, en mirrors the full key
 * set (the same pattern as dsh-enterprise/dsh-cron/dsh-task locales). The
 * dictionary is registered into the shared locale registry; `t()` resolves
 * the zh key source directly so components stay dependency-free.
 */
export const zh = {
  'account.balance': '余额',
  'account.budget': '本月预算',
  'account.usedThisMonth': '本月已用',
  'account.today': '今日',
  'account.unlimited': '不限',
  'account.noQuota': '无配额限制',
  'account.admin': '管理员',
  'account.logout': '退出登录',
  'account.loggingOut': '退出中…',
  'account.refresh': '刷新',
  'account.lowBalance': '余额不足',
  'account.stale': '余额获取失败',
  'account.tokens': 'tokens',
  'account.loading': '加载中…',
}

export const en: Record<keyof typeof zh, string> = {
  'account.balance': 'Balance',
  'account.budget': 'Monthly budget',
  'account.usedThisMonth': 'Used this month',
  'account.today': 'Today',
  'account.unlimited': 'Unlimited',
  'account.noQuota': 'No quota',
  'account.admin': 'Admin',
  'account.logout': 'Log out',
  'account.loggingOut': 'Logging out…',
  'account.refresh': 'Refresh',
  'account.lowBalance': 'Low balance',
  'account.stale': 'Balance unavailable',
  'account.tokens': 'tokens',
  'account.loading': 'Loading…',
}

/** Keys of the account-card dictionary. */
export type AccountKey = keyof typeof zh

const dict = zh as Record<AccountKey, string>

/** Resolve a zh-source key; `en` mirror is registered for the locale service. */
export function t(key: AccountKey): string {
  return dict[key]
}
