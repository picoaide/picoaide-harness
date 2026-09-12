/**
 * Account card client UI copy: zh is the key source, en mirrors the full key
 * set (the same pattern as dsh-enterprise/dsh-cron/dsh-task locales). The
 * dictionary is registered into the shared locale registry; `t()` resolves
 * the zh key source directly so components stay dependency-free.
 */
export const zh = {
  'account.usedThisMonth': '本月已用',
  'account.today': '今日',
  'account.admin': '管理员',
  'account.notActivated': '余额未开通',
  'account.monthlyGrant': '每月发放',
  'account.logout': '退出登录',
  'account.loggingOut': '退出中…',
  'account.refresh': '刷新',
  'account.balance': '账户余额',
  'account.lowBalance': '余额不足',
  'account.stale': '余额获取失败',
  'account.loading': '加载中…',
}

export const en: Record<keyof typeof zh, string> = {
  'account.usedThisMonth': 'Used this month',
  'account.today': 'Today',
  'account.admin': 'Admin',
  'account.notActivated': 'Balance not set up',
  'account.monthlyGrant': 'Monthly grant',
  'account.logout': 'Log out',
  'account.loggingOut': 'Logging out…',
  'account.refresh': 'Refresh',
  'account.balance': 'Balance',
  'account.lowBalance': 'Low balance',
  'account.stale': 'Balance unavailable',
  'account.loading': 'Loading…',
}

/** Keys of the account-card dictionary. */
export type AccountKey = keyof typeof zh

const dict = zh as Record<AccountKey, string>

/** Resolve a zh-source key; `en` mirror is registered for the locale service. */
export function t(key: AccountKey): string {
  return dict[key]
}
