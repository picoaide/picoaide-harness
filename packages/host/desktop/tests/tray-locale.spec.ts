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
    expect(desktopTrayLabel('en', 'updateAvailable', '2.5.9')).toBe('PicoAide Harness 2.5.9 Available')
    expect(desktopTrayLabel('en', 'downloadingUpdate', '2.5.9')).toBe('Downloading PicoAide Harness 2.5.9…')
    expect(desktopTrayLabel('en', 'exportDiagnostics')).toBe('Export Diagnostics…')
  })

  it('renders the zh locale labels with interpolation', () => {
    expect(desktopTrayLabel('zh', 'openDesktop', 'PicoAide Harness')).toBe('打开 PicoAide Harness')
    expect(desktopTrayLabel('zh', 'updateAvailable', '2.5.9')).toBe('PicoAide Harness 2.5.9 可用')
    expect(desktopTrayLabel('zh', 'downloadingUpdate', '2.5.9')).toBe('正在下载 PicoAide Harness 2.5.9…')
    expect(desktopTrayLabel('zh', 'exportDiagnostics')).toBe('导出诊断信息…')
  })

  it('covers the full key set for both locales', () => {
    // P3: the dead tray keys (openTerminal/profile/switchTo*/unavailableForDesktop)
    // were removed from the typed key set — keep this list in sync with it.
    const keys = [
      'checkForUpdates', 'checkingForUpdates', 'downloadingUpdate', 'exportDiagnostics',
      'openDesktop', 'quit', 'updateAvailable',
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

/**
 * 渠道构建下托盘/通知里不得出现厂商名。
 *
 * 这些文案是**系统级**可见的（托盘菜单、通知中心），渠道客户最容易在这里看到
 * 厂商品牌；产品名必须由 runtime 面传入（渠道构建下即渠道名）。
 */
describe('desktop tray labels use the resolved product name', () => {
  it('renders the channel product name in update copy', () => {
    expect(desktopTrayLabel('zh', 'updateAvailable', '2.7.0', 'Acme AI')).toBe('Acme AI 2.7.0 可用')
    expect(desktopTrayLabel('zh', 'downloadingUpdate', '2.7.0', 'Acme AI')).toBe('正在下载 Acme AI 2.7.0…')
    expect(desktopTrayLabel('en', 'updateAvailable', '2.7.0', 'Acme AI')).toBe('Acme AI 2.7.0 Available')
    expect(desktopTrayLabel('en', 'downloadingUpdate', '2.7.0', 'Acme AI')).toBe('Downloading Acme AI 2.7.0…')
  })

  it('never leaks a vendor name for a channel build', () => {
    for (const locale of ['zh', 'en'] as const) {
      for (const key of ['updateAvailable', 'downloadingUpdate'] as const) {
        expect(desktopTrayLabel(locale, key, '9.9.9', 'Zephyr AI')).not.toContain('PicoAide')
      }
    }
  })

  it('falls back to the official product name when the caller passes none', () => {
    // 本地开发/未渠道化构建:与改造前逐字节一致。
    expect(desktopTrayLabel('zh', 'updateAvailable', '2.7.0')).toBe('PicoAide Harness 2.7.0 可用')
    expect(desktopTrayLabel('en', 'downloadingUpdate', '2.7.0', '')).toBe('Downloading PicoAide Harness 2.7.0…')
  })
})
