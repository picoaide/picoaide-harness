import { describe, expect, it } from 'vitest'
import {
  desktopDiagnosticsPrivacyCopy,
  desktopLocaleFromLanguageTag,
  desktopTrayLabel,
} from '../src/tray-locale.ts'

describe('desktopLocaleFromLanguageTag', () => {
  it('maps zh variants (with separators) to zh', () => {
    for (const tag of ['zh', 'zh-CN', 'zh_CN', 'zh-Hans', 'zh-SG']) {
      expect(desktopLocaleFromLanguageTag(tag)).toBe('zh')
    }
  })
  it('maps everything else to en', () => {
    for (const tag of ['en', 'en-US', 'ja', 'fr', 'de', '', '`zh` is not a tag', 'en-zh', 'z']) {
      expect(desktopLocaleFromLanguageTag(tag)).toBe('en')
    }
  })
})

describe('desktopTrayLabel', () => {
  it('renders the en locale labels with interpolation', () => {
    expect(desktopTrayLabel('en', 'openDesktop', 'PicoAide Harness')).toBe('Open PicoAide Harness')
    expect(desktopTrayLabel('en', 'profile', 'default')).toBe('Profile: default')
    expect(desktopTrayLabel('en', 'updateAvailable', '2.5.9')).toBe('PicoAide Harness 2.5.9 Available')
    expect(desktopTrayLabel('en', 'downloadingUpdate', '2.5.9')).toBe('Downloading PicoAide Harness 2.5.9…')
    expect(desktopTrayLabel('en', 'unavailableForDesktop', 'default')).toBe('default (Unavailable for Desktop)')
  })

  it('renders the zh locale labels with interpolation', () => {
    expect(desktopTrayLabel('zh', 'openDesktop', 'PicoAide Harness')).toBe('打开 PicoAide Harness')
    expect(desktopTrayLabel('zh', 'profile', 'default')).toBe('配置文件：default')
    expect(desktopTrayLabel('zh', 'updateAvailable', '2.5.9')).toBe('PicoAide Harness 2.5.9 可用')
    expect(desktopTrayLabel('zh', 'downloadingUpdate', '2.5.9')).toBe('正在下载 PicoAide Harness 2.5.9…')
    expect(desktopTrayLabel('zh', 'unavailableForDesktop', 'default')).toBe('default（不可用于桌面端）')
  })

  it('covers the full key set for both locales', () => {
    const keys = [
      'checkForUpdates', 'checkingForUpdates', 'downloadingUpdate', 'exportDiagnostics',
      'openDesktop', 'openTerminal', 'profile', 'quit', 'switchToAdvanced',
      'switchToCompatibility', 'unavailableForDesktop', 'updateAvailable',
    ] as const
    for (const key of keys) {
      expect(desktopTrayLabel('en', key)).not.toBe('')
      expect(desktopTrayLabel('zh', key)).not.toBe('')
    }
  })

  it('supports value-less keys with an empty default value', () => {
    expect(desktopTrayLabel('en', 'quit')).toBe('Quit')
    expect(desktopTrayLabel('zh', 'quit')).toBe('退出')
  })
})

describe('desktopDiagnosticsPrivacyCopy', () => {
  it('returns localized confirm/cancel copy', () => {
    const en = desktopDiagnosticsPrivacyCopy('en')
    expect(en.confirm).toBe('Export')
    expect(en.cancel).toBe('Cancel')
    expect(en.title).toBe('Export Diagnostics')
    const zh = desktopDiagnosticsPrivacyCopy('zh')
    expect(zh.confirm).toBe('导出')
    expect(zh.cancel).toBe('取消')
    expect(zh.title).toBe('导出诊断信息')
  })

  it('warns about credentials being masked in the detail text', () => {
    const en = desktopDiagnosticsPrivacyCopy('en')
    expect(en.detail).toMatch(/credentials/i)
    expect(en.detail).toMatch(/masked/i)
    const zh = desktopDiagnosticsPrivacyCopy('zh')
    expect(zh.detail).toMatch(/脱敏/)
  })
})
