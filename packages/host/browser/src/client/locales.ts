/**
 * Browser client UI copy: zh is the key source, en mirrors the full key set.
 */
export const zh = {
  'panel.title': '浏览器',
}

export const en: Record<keyof typeof zh, string> = {
  'panel.title': 'Browser',
}

export type BrowserKey = keyof typeof zh

/** Translate a key (zh key source; en mirrors the full key set). */
export function t(key: BrowserKey): string {
  return zh[key] as string
}
