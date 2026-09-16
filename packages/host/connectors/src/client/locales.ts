/**
 * Connectors client UI copy: zh is the key source, en mirrors the full key
 * set (the same pattern as the dsh-cron locale).
 */
export const zh = {
  'panel.title': '连接器',
  'panel.close': '关闭',
  'search.placeholder': '搜索连接器…',
  'filter.all': '全部',
  'filter.connected': '已连接',
  'filter.disconnected': '未连接',
  'filter.count': '{connected}/{total} 已连接',
  'empty.noMatch': '暂无匹配的连接器',
  'status.disconnected': '未连接',
  'status.connecting': '连接中…',
  'status.connected': '已连接',
  'status.unauthorized': '需要授权',
  'status.error': '连接失败',
  'action.connect': '连接',
  'action.disconnect': '断开',
  'action.submit': '提交',
  'action.connecting': '连接中…',
  'action.disconnecting': '断开中…',
  'action.cancelling': '取消中…',
  'action.stop': '停止连接',
  'action.cancelHint': '连接进行中：点击停止并结束本次授权',
  'auth.verificationHint': '请打开以下地址并登录授权：',
  'auth.code': '授权码：{code}',
  'auth.authorizeOpened': '授权页已在浏览器中打开；若未弹出请点击：',
  'auth.authorizeLink': '点击打开授权页',
  'auth.waiting': '等待授权完成…',
  'approval.title': '本地执行确认',
  'approval.hint': '服务端下发的连接器要求在{target}执行以下本地命令；每一条命令及其环境变量都会一并被批准，请逐条确认来源可信：',
  'approval.command': '命令：',
  'approval.args': '参数：',
  'approval.env': '环境变量：',
  'approval.envValues': '环境变量取值（命令真正收到的内容）：',
  'approval.once': '允许后不会再重复询问；拒绝则不会启动该命令。',
  'action.allow': '允许执行',
  'action.deny': '拒绝',
  'action.deciding': '处理中…',
  'action.refreshToken': '刷新令牌',
  'action.refreshingToken': '刷新中…',
  'action.refreshTokenHint': '立即用 refresh token 换取新的访问令牌（不会重新打开授权页）',
  'token.expiresAt': '令牌有效期至 {time}',
  'token.expired': '令牌已过期，正在自动续期',
  'token.refreshedAt': '上次刷新 {time}',
  'token.refreshFailed': '令牌刷新失败：{message}',
  // 错误兜底文案（2026-09-15 审计 BUG-07）：以前这三条硬编码中文，
  // 英文界面下连接失败提示仍是中文。
  'error.exitCode': '登录命令失败：请确认已安装对应命令行工具并完成登录，然后重试',
  'error.commandMissing': '未找到登录命令：请先安装对应命令行工具',
  'error.generic': '连接失败：{message}',
  'error.refreshStale': '刷新失败，显示上次数据',
  'command.connected': '{name}（已连接）',
  'command.info': '查看连接器信息',
  'command.infoPrompt': '{name}（已连接）。模型可直接调用其注入工具（mcp__*），例如：{examples}',
  // 列表分隔符随语言走：中文用顿号，英文用逗号。此前硬编码 '、' 会漏进英文句子
  // （`for example: a、b`）。
  'command.exampleSeparator': '、',
}

export const en: Record<keyof typeof zh, string> = {
  'panel.title': 'Connectors',
  'panel.close': 'Close',
  'search.placeholder': 'Search connectors…',
  'filter.all': 'All',
  'filter.connected': 'Connected',
  'filter.disconnected': 'Disconnected',
  'filter.count': '{connected}/{total} connected',
  'empty.noMatch': 'No matching connectors',
  'status.disconnected': 'Not connected',
  'status.connecting': 'Connecting…',
  'status.connected': 'Connected',
  'status.unauthorized': 'Authorization required',
  'status.error': 'Connection failed',
  'action.connect': 'Connect',
  'action.disconnect': 'Disconnect',
  'action.submit': 'Submit',
  'action.connecting': 'Connecting…',
  'action.disconnecting': 'Disconnecting…',
  'action.cancelling': 'Cancelling…',
  'action.stop': 'Stop connection',
  'action.cancelHint': 'Connection in progress: click to stop and cancel this authorization',
  'auth.verificationHint': 'Open the following address to authorize:',
  'auth.code': 'Authorization code: {code}',
  'auth.authorizeOpened': 'The authorization page was opened; if not, click here:',
  'auth.authorizeLink': 'Click to open the authorization page',
  'auth.waiting': 'Waiting for authorization…',
  'approval.title': 'Local execution confirmation',
  'approval.hint': 'A server-issued connector asks to run the following local commands on {target}; allowing approves every command and environment variable listed. Confirm each one is trustworthy:',
  'approval.command': 'Command:',
  'approval.args': 'Arguments:',
  'approval.env': 'Environment:',
  'approval.envValues': 'Environment values (what the command really receives):',
  'approval.once': 'Allowing it will not ask again; denying it will not run the command.',
  'action.allow': 'Allow',
  'action.deny': 'Deny',
  'action.deciding': 'Working…',
  'action.refreshToken': 'Refresh token',
  'action.refreshingToken': 'Refreshing…',
  'action.refreshTokenHint': 'Exchange the refresh token for a new access token now (no authorization page)',
  'token.expiresAt': 'Token valid until {time}',
  'token.expired': 'Token expired — renewing automatically',
  'token.refreshedAt': 'Last refreshed {time}',
  'token.refreshFailed': 'Token refresh failed: {message}',
  'error.exitCode': 'Login command failed: make sure the corresponding CLI is installed and signed in, then retry',
  'error.commandMissing': 'Login command not found: install the corresponding CLI first',
  'error.generic': 'Connection failed: {message}',
  'error.refreshStale': 'Refresh failed — showing the last known data',
  'command.connected': '{name} (connected)',
  'command.info': 'View connector information',
  'command.infoPrompt': '{name} (connected). The model can call its injected tools (mcp__*), for example: {examples}',
  'command.exampleSeparator': ', ',
}

export type ConnectorsKey = keyof typeof zh

/** Active UI locale, kept in sync by the client plugin from ctx.locale. */
let activeLocale: 'zh' | 'en' = 'zh'
/** Adopt the active locale (called by the client plugin; unknown ids fall back to Chinese). */
export function setActiveLocale(id: string): void {
  activeLocale = id.toLowerCase().startsWith('en') ? 'en' : 'zh'
}

/** Translate a key (zh key source; en mirrors the full key set). */
export function t(key: ConnectorsKey, params?: Record<string, string>): string {
  let text: string = (activeLocale === 'en' ? en[key] : zh[key]) as string
  if (params !== undefined) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replaceAll(`{${name}}`, () => String(value))
    }
  }
  return text
}

