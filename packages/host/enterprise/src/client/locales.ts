/**
 * Enterprise client UI copy: zh is the key source, en mirrors the full key
 * set (the same pattern as the dsh-cron locale). The dictionary is
 * registered into the shared locale registry; `t()` resolves the zh key
 * source directly so components stay dependency-free.
 */
export const zh = {
  'account.current': '当前账号',
  'account.server': '服务端地址',
  'account.unknown': '未知',
  'account.logout': '退出登录',
  'account.loggingOut': '退出中…',
  'account.logoutFailed': '退出失败：{error}，请重试',
  'account.notLoggedIn': '未登录',
  'account.stateFailed': '无法获取登录状态',
  'account.loading': '加载中…',
  // 0057 本地账号自助改密(外部认证用户由企业 IdP 管理, 不渲染表单)
  'account.password.title': '修改密码',
  'account.password.old': '当前密码',
  'account.password.new': '新密码(至少 10 位)',
  'account.password.confirm': '确认新密码',
  'account.password.submit': '确认修改',
  'account.password.cancel': '取消',
  'account.password.submitting': '提交中…',
  'account.password.errOld': '当前密码错误',
  'account.password.errSame': '新密码不能与当前密码相同',
  'account.password.errShort': '新密码至少 10 位',
  'account.password.errMismatch': '两次输入的新密码不一致',
  'account.password.errFailed': '修改失败:{error}',
  'account.password.external': '当前为企业统一认证(SSO/LDAP),密码由企业管理员管理',
  'account.password.forceHint': '你的密码已被管理员重置,请先修改密码后再使用。',
  // 首屏 hero 徽章兜底（渠道未配置 client.tagline 时；按界面语言取，见 channel-vars.ts）。
  'hero.tagline': '企业版',
  // 更新面文案（2026-09-15 审计 BUG-07）：这些字符串以前硬编码在
  // UpdateIndicator/UpdateSection 里，英文界面下整块是中文。
  'update.serviceUnavailable': '更新服务不可用',
  'update.ready': '新版本 {version} 已下载，点击「安装更新」完成升级',
  'update.available': '发现新版本 {version}，正在准备下载…',
  'update.notSignedIn': '请先登录后再检查更新',
  'update.network': '检查更新失败：网络不可达（已自动重试），请稍后再试',
  'update.releaseMissing': '检查更新失败：最新版本缺少可下载安装包',
  'update.checksumMismatch': '更新下载失败：安装包校验不一致（已自动重试），请稍后再试',
  'update.invalidArtifact': '更新下载失败：安装包格式不正确，请联系管理员',
  'update.serverUnavailable': '检查更新失败：服务端未配置对外可用的 https 地址，请联系管理员',
  'update.unsupported': '当前平台不支持自动更新',
  'update.upToDate': '已是最新版本',
  'update.interrupted': '下载中断，{seconds} 秒后重试（第 {attempt}/{max} 次）…',
  'update.retrying': '正在重试下载 {version}（第 {attempt}/{max} 次）{percent}…',
  'update.downloading': '正在下载 {version}…{percent}',
  'update.readyShort': '可安装 {version}',
  'update.readyTitle': '新版本 {version} 已下载，点击安装',
  'update.availableTitle': '新版本 {version} 可用，点击检查更新',
  'update.checking': '检查中…',
  'update.install': '安装更新',
  'update.downloadingAction': '下载中…',
  'update.check': '检查更新',
  'update.about': '关于',
  'settings.account': '账号',
}

export const en: Record<keyof typeof zh, string> = {
  'account.current': 'Current account',
  'account.server': 'Server URL',
  'account.unknown': 'Unknown',
  'account.logout': 'Log out',
  'account.loggingOut': 'Logging out…',
  'account.logoutFailed': 'Log out failed: {error}. Please retry.',
  'account.notLoggedIn': 'Not logged in',
  'account.stateFailed': 'Could not fetch login state',
  'account.loading': 'Loading…',
  // 0057 local account self-service password change
  'account.password.title': 'Change password',
  'account.password.old': 'Current password',
  'account.password.new': 'New password (at least 10 characters)',
  'account.password.confirm': 'Confirm new password',
  'account.password.submit': 'Change password',
  'account.password.cancel': 'Cancel',
  'account.password.submitting': 'Submitting…',
  'account.password.errOld': 'Current password is incorrect',
  'account.password.errSame': 'New password must differ from the current one',
  'account.password.errShort': 'New password needs at least 10 characters',
  'account.password.errMismatch': 'The two new passwords do not match',
  'account.password.errFailed': 'Failed to change password: {error}',
  'account.password.external': 'Managed by enterprise IdP (SSO/LDAP); password changes are not available here',
  'account.password.forceHint': 'Your password was reset by an administrator. Please set a new password before continuing.',
  'hero.tagline': 'Enterprise',
  'update.serviceUnavailable': 'Update service unavailable',
  'update.ready': 'Version {version} is downloaded — click "Install update" to finish',
  'update.available': 'Version {version} found, preparing the download…',
  'update.notSignedIn': 'Sign in first to check for updates',
  'update.network': 'Update check failed: network unreachable (retried automatically), try again later',
  'update.releaseMissing': 'Update check failed: the latest release has no downloadable installer',
  'update.checksumMismatch': 'Update download failed: installer checksum mismatch (retried automatically), try again later',
  'update.invalidArtifact': 'Update download failed: malformed installer, contact your administrator',
  'update.serverUnavailable': 'Update check failed: the server has no public https address configured, contact your administrator',
  'update.unsupported': 'This platform does not support automatic updates',
  'update.upToDate': 'Already up to date',
  'update.interrupted': 'Download interrupted, retrying in {seconds}s (attempt {attempt}/{max})…',
  'update.retrying': 'Retrying download of {version} (attempt {attempt}/{max}){percent}…',
  'update.downloading': 'Downloading {version}…{percent}',
  'update.readyShort': 'Install {version}',
  'update.readyTitle': 'Version {version} is downloaded — click to install',
  'update.availableTitle': 'Version {version} is available — click to check for updates',
  'update.checking': 'Checking…',
  'update.install': 'Install update',
  'update.downloadingAction': 'Downloading…',
  'update.check': 'Check for updates',
  'update.about': 'About',
  'settings.account': 'Account',
}

export type EnterpriseKey = keyof typeof zh

/** Active UI locale, kept in sync by the client plugin from ctx.locale. */
let activeLocale: 'zh' | 'en' = 'zh'
/** Adopt the active locale (called by the client plugin; unknown ids fall back to Chinese). */
export function setActiveLocale(id: string): void {
  activeLocale = id.toLowerCase().startsWith('en') ? 'en' : 'zh'
}

/** Translate a key (zh key source; en mirrors the full key set). */
export function t(key: EnterpriseKey, params?: Record<string, string>): string {
  let text: string = (activeLocale === 'en' ? en[key] : zh[key]) as string
  if (params !== undefined) {
    // ONE pass over the template: a chained `replaceAll` per parameter re-scans
    // the values it just inserted, so a value carrying another key's `{name}`
    // token would be rewritten (2026-09-16 R9 audit; same shape as
    // `manifest-precheck`'s `fill`).
    text = text.replace(/\{(\w+)\}/gu, (match, name: string) => (Object.hasOwn(params, name) ? String(params[name]) : match))
  }
  return text
}

