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
  'account.logoutFailed': '退出失败：{error}',
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
  'account.logoutFailed': 'Log out failed: {error}',
  'account.refresh': 'Refresh',
  'account.balance': 'Balance',
  'account.lowBalance': 'Low balance',
  'account.stale': 'Balance unavailable',
  'account.loading': 'Loading…',
}

/** Keys of the account-card dictionary. */
export type AccountKey = keyof typeof zh

const dict = zh as Record<AccountKey, string>
const enDict = en as Record<AccountKey, string>

/** Active UI locale, kept in sync by the client plugin from ctx.locale. */
let activeLocale: 'zh' | 'en' = 'zh'
/** Adopt the active locale (called by the client plugin; unknown ids fall back to Chinese). */
export function setActiveLocale(id: string): void {
  activeLocale = id.toLowerCase().startsWith('en') ? 'en' : 'zh'
}

/** Resolve a zh-source key; `en` mirror is registered for the locale service. */
export function t(key: AccountKey, params?: Record<string, string>): string {
  let text = (activeLocale === 'en' ? enDict : dict)[key]
  if (params !== undefined) {
    // ONE pass over the template: a chained `replaceAll` per parameter re-scans
    // the values it just inserted, so a value carrying another key's `{name}`
    // token would be rewritten (2026-09-16 R9 audit; same shape as
    // `manifest-precheck`'s `fill`).
    text = text.replace(/\{(\w+)\}/gu, (match, name: string) => (Object.hasOwn(params, name) ? String(params[name]) : match))
  }
  return text
}

/**
 * BCP-47 tag of the **UI** locale（2026-09-15 审计 BUG-07）：`Intl.NumberFormat`
 * 要的是标签而不是内部枚举，而且必须与界面语言一致 —— 传 `undefined` 会退回
 * 运行时/系统 locale，系统 en + 界面 zh 时金额会显示成 `CN¥`。
 */
export function activeLocaleTag(): string {
  return activeLocale === 'en' ? 'en-US' : 'zh-CN'
}
