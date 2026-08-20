/**
 * Connectors client UI copy: zh is the key source, en mirrors the full key
 * set (the same pattern as dsh-cron/dsh-task locales).
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
  'auth.verificationHint': '请打开以下地址并登录授权：',
  'auth.code': '授权码：{code}',
  'auth.authorizeOpened': '授权页已在浏览器中打开；若未弹出请点击：',
  'auth.waiting': '等待授权完成…',
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
  'auth.verificationHint': 'Open the following address to authorize:',
  'auth.code': 'Authorization code: {code}',
  'auth.authorizeOpened': 'The authorization page was opened; if not, click here:',
  'auth.waiting': 'Waiting for authorization…',
}

export type ConnectorsKey = keyof typeof zh

/** Translate a key (zh key source; en mirrors the full key set). */
export function t(key: ConnectorsKey, params?: Record<string, string>): string {
  let text: string = zh[key] as string
  if (params !== undefined) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replaceAll(`{${name}}`, value)
    }
  }
  return text
}

/** Map raw connector/CLI errors to user-facing copy (P3-6). */
export function friendlyConnectorError(raw: string): string {
  if (raw.includes('退出码')) return '登录命令失败：请确认已安装对应命令行工具并完成登录，然后重试'
  // The node side names the missing binary and its install command; show it
  // verbatim so the user knows what to install (e.g. npm install -g beisen-cli).
  if (raw.includes('未找到命令')) return raw
  if (raw.includes('ENOENT')) return '未找到登录命令：请先安装对应命令行工具'
  if (raw.includes('token') || raw.includes('授权') || raw.includes('登录')) return raw
  return `连接失败：${raw}`
}
