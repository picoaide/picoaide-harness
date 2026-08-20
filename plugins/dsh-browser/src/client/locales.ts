/**
 * Browser client UI copy: zh is the key source, en mirrors the full key set.
 */
export const zh = {
  'panel.title': '浏览器',
  'panel.close': '关闭',
  'panel.closeTab': '关闭标签页',
  'panel.tab': '标签',
  'panel.loading': '加载中',
  'panel.newTab': '新建标签页',
  'panel.back': '后退',
  'panel.forward': '前进',
  'panel.reload': '刷新',
  'panel.addressPlaceholder': '输入网址后回车',
  'panel.go': 'Go',
  'panel.takeover': '接管',
  'panel.release': '接管中·释放',
  'panel.takeoverTitle': '切换手动接管（暂停 agent 浏览器操作）',
  'panel.clear': '清除',
  'panel.clearTitle': '清除浏览数据并关闭',
  'panel.controlledNotice': '用户接管中：agent 的浏览器操作已暂停',
}

export const en: Record<keyof typeof zh, string> = {
  'panel.title': 'Browser',
  'panel.close': 'Close',
  'panel.closeTab': 'Close tab',
  'panel.tab': 'Tab',
  'panel.loading': 'loading',
  'panel.newTab': 'New tab',
  'panel.back': 'Back',
  'panel.forward': 'Forward',
  'panel.reload': 'Reload',
  'panel.addressPlaceholder': 'Enter a URL and press Enter',
  'panel.go': 'Go',
  'panel.takeover': 'Take over',
  'panel.release': 'Release',
  'panel.takeoverTitle': 'Toggle manual control (blocks agent browser actions)',
  'panel.clear': 'Clear',
  'panel.clearTitle': 'Clear browsing data and close',
  'panel.controlledNotice': 'User control: agent browser actions are paused',
}

export type BrowserKey = keyof typeof zh

/** Translate a key (zh key source; en mirrors the full key set). */
export function t(key: BrowserKey): string {
  return zh[key] as string
}
