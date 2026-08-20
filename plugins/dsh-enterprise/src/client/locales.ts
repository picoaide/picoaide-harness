/**
 * Enterprise client UI copy: zh is the key source, en mirrors the full key
 * set (the same pattern as dsh-cron/dsh-task locales). The dictionary is
 * registered into the shared locale registry; `t()` resolves the zh key
 * source directly so components stay dependency-free.
 */
export const zh = {
  'skill.title': '技能中心',
  'skill.close': '关闭',
  'skill.install': '安装',
  'skill.installing': '安装中…',
  'skill.installed': '已安装 {name}',
  'skill.failed': '安装失败，请重试',
  'skill.loading': '加载中…',
  'skill.empty': '暂无可用技能',
  'skill.loadError': '技能列表加载失败',
  'account.current': '当前账号',
  'account.server': '服务端地址',
  'account.unknown': '未知',
  'account.logout': '退出登录',
  'account.loggingOut': '退出中…',
  'account.notLoggedIn': '未登录',
  'account.stateFailed': '无法获取登录状态',
  'account.loading': '加载中…',
  'session.title': 'PicoAide 企业登录',
  'session.serverPlaceholder': '服务端地址 (https://...)',
  'session.usernamePlaceholder': '账号',
  'session.passwordPlaceholder': '密码',
  'session.submit': '登录',
  'session.networkError': '网络错误',
}

export const en: Record<keyof typeof zh, string> = {
  'skill.title': 'Skill Center',
  'skill.close': 'Close',
  'skill.install': 'Install',
  'skill.installing': 'Installing…',
  'skill.installed': 'Installed {name}',
  'skill.failed': 'Install failed, please retry',
  'skill.loading': 'Loading…',
  'skill.empty': 'No skills available',
  'skill.loadError': 'Failed to load skill list',
  'account.current': 'Current account',
  'account.server': 'Server URL',
  'account.unknown': 'Unknown',
  'account.logout': 'Log out',
  'account.loggingOut': 'Logging out…',
  'account.notLoggedIn': 'Not logged in',
  'account.stateFailed': 'Could not fetch login state',
  'account.loading': 'Loading…',
  'session.title': 'PicoAide Enterprise Login',
  'session.serverPlaceholder': 'Server URL (https://...)',
  'session.usernamePlaceholder': 'Username',
  'session.passwordPlaceholder': 'Password',
  'session.submit': 'Sign in',
  'session.networkError': 'Network error',
}

export type EnterpriseKey = keyof typeof zh

/** Translate a key (zh key source; en mirrors the full key set). */
export function t(key: EnterpriseKey, params?: Record<string, string>): string {
  let text: string = zh[key] as string
  if (params !== undefined) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replaceAll(`{${name}}`, value)
    }
  }
  return text
}
