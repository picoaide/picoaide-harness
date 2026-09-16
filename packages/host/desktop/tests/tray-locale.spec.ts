import { describe, expect, it } from 'vitest'
import {
  desktopCrashPageCopy,
  desktopDiagnosticsPrivacyCopy,
  desktopLocaleFromLanguageTag,
  desktopTrayLabel,
  desktopUpdateDialogCopy,
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

describe('native copy added by the 2026-09-16 i18n pass', () => {
  const CJK = /[\u4e00-\u9fff]/u

  it('localizes the whole update dialog, not just the Linux detail', () => {
    // 回归：此前 title/message/按钮恒为英文，只有 Linux 的 detail 是中文，
    // 于是两个语言下都是中英混排。整段（含按钮）必须同语言。
    const zhReady = desktopUpdateDialogCopy('zh')
    const enReady = desktopUpdateDialogCopy('en')
    expect(zhReady.readyTitle('P')).toContain('更新已就绪')
    expect(enReady.readyTitle('P')).toContain('Update Ready')
    expect(zhReady.confirm).toBe('确定')
    expect(enReady.confirm).toBe('OK')
    expect(zhReady.readyMessage('1.0.0', 'P')).toMatch(CJK)
    expect(enReady.readyMessage('1.0.0', 'P')).not.toMatch(CJK)
  })

  it('gives every update-dialog string an English form free of Chinese', () => {
    const en = desktopUpdateDialogCopy('en')
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      expect(en.readyDetail(platform, '/tmp/i', 'P'), platform).not.toMatch(CJK)
    }
    expect(en.readyTitle('P')).not.toMatch(CJK)
    expect(en.readyMessage('1.0.0', 'P')).not.toMatch(CJK)
    expect(en.downloadedTitle('P')).not.toMatch(CJK)
    expect(en.downloadedMessage('1.0.0', 'P')).not.toMatch(CJK)
    expect(en.downloadedDetail('/tmp/i')).not.toMatch(CJK)
  })

  it('keeps the Linux AppImage instruction in both languages', () => {
    // 中文原文必须逐字保留（只做加法）；英文侧此前根本不存在。
    expect(desktopUpdateDialogCopy('zh').readyDetail('linux', '/tmp/i', 'P'))
      .toBe('新版本 AppImage 已下载到: /tmp/i\n\n在界面或托盘里点「安装更新」后,关闭本程序并用该文件替换当前 AppImage。')
    expect(desktopUpdateDialogCopy('en').readyDetail('linux', '/tmp/i', 'P'))
      .toContain('The new AppImage has been downloaded to: /tmp/i')
  })

  it('localizes the crash-fallback page and its lang attribute', () => {
    const zh = desktopCrashPageCopy('zh')
    const en = desktopCrashPageCopy('en')
    expect(zh.heading).toBe('界面加载失败')
    expect(zh.body).toMatch(CJK)
    expect(zh.retry).toBe('重新加载')
    expect(zh.lang).toBe('zh-CN')
    // 诊断导出失败框的标题（R3 审计：原先只被英文断言覆盖 ⇒ 回退成硬编码不红）。
    expect(desktopDiagnosticsPrivacyCopy('zh').errorTitle).toMatch(CJK)
    expect(desktopDiagnosticsPrivacyCopy('en').errorTitle).not.toMatch(CJK)
    expect(en.heading).not.toMatch(CJK)
    expect(en.body).not.toMatch(CJK)
    expect(en.retry).not.toMatch(CJK)
    expect(en.lang).toBe('en')
  })

  // 2026-09-16 R9 审计：i18n 那一轮只改了 announceUpdateReady 与 installUpdate 的
  // Linux 分支，Windows/macOS 的安装对话框与「检查更新…」（托盘项已中文化）触发的
  // 三个对话框仍是硬编码英文 —— 同一条流程从中文弹窗跳进英文弹窗。
  it('localizes the rest of the update dialogs (install + manual check)', () => {
    const zh = desktopUpdateDialogCopy('zh')
    const en = desktopUpdateDialogCopy('en')
    for (const value of [
      zh.darwinOpenedDetail('P'), zh.winInstallDetail('P'), zh.winRestart, zh.winLater,
      zh.checkFailedTitle('P'), zh.checkFailedMessage('P'), zh.checkFailedDetail,
      zh.upToDateTitle('P'), zh.upToDateMessage('P'), zh.upToDateDetail('1.0.0'),
      zh.availableTitle('P'), zh.availableMessage('1.0.0', 'P'), zh.availableDetail,
    ]) {
      expect(value, JSON.stringify(value)).toMatch(CJK)
    }
    for (const value of [
      en.darwinOpenedDetail('P'), en.winInstallDetail('P'), en.winRestart, en.winLater,
      en.checkFailedTitle('P'), en.checkFailedMessage('P'), en.checkFailedDetail,
      en.upToDateTitle('P'), en.upToDateMessage('P'), en.upToDateDetail('1.0.0'),
      en.availableTitle('P'), en.availableMessage('1.0.0', 'P'), en.availableDetail,
    ]) {
      expect(value, JSON.stringify(value)).not.toMatch(CJK)
    }
    // 产品名/版本号必须由 runtime 面传入（渠道构建下即渠道名）。
    expect(zh.availableMessage('9.9.9', 'Acme AI')).toContain('Acme AI 9.9.9')
    expect(en.upToDateDetail('9.9.9')).toContain('9.9.9')
  })
})
