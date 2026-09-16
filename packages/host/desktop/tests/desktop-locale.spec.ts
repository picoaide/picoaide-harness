/**
 * 上游 locale 偏好 → 桌面语言（P2-B2，2026-09-16）。
 *
 * 事故形态（静默 + 单一平面）：上游客户端 locale id 允许带地区子标签
 * （`LOCALE_ID_PATTERN = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/`），
 * `zh-CN` 是它自己会写出来的合法值；而桌面原生面（托盘菜单/通知/隐私确认框）
 * 此前只认**裸 `zh` / `en`** ⇒ 用户在设置里选了 `zh-CN`（或系统语言是中文、
 * 上游写入 `zh-CN`）时得到 `undefined` ⇒ 回落系统语言：中文界面配英文托盘，
 * 零报错、零日志。
 *
 * 反向用例同样要钉住：`auto`（显式"跟随系统"）与 `undefined`（从未设置）
 * 必须继续返回 `undefined`，否则"跟随系统"会被硬钉成某个语言。
 */
import { describe, expect, it } from 'vitest'
import { desktopLocaleFromPreference, localeIdToDesktopLocale } from '../src/desktop-locale.ts'
import { desktopLocaleFromLanguageTag } from '../src/tray-locale.ts'

describe('localeIdToDesktopLocale', () => {
  it('识别中文的各种写法（地区/文字/大小写/分隔符）', () => {
    for (const id of ['zh', 'zh-CN', 'zh_CN', 'zh-Hans', 'zh-Hant', 'ZH-cn', ' zh ']) {
      expect(localeIdToDesktopLocale(id), id).toBe('zh')
    }
  })

  it('识别英文的各种写法', () => {
    for (const id of ['en', 'en-US', 'en_GB', 'EN-us']) {
      expect(localeIdToDesktopLocale(id), id).toBe('en')
    }
  })

  it('不支持的语言返回 undefined（不硬塞错的语言）', () => {
    for (const id of ['ja', 'ja-JP', 'fr', 'de-DE', '', '   ', 'zhx', 'enzh']) {
      expect(localeIdToDesktopLocale(id), id).toBeUndefined()
    }
  })
})

describe('desktopLocaleFromPreference', () => {
  it('带地区子标签的偏好不再被丢弃（P2-B2 修复点）', () => {
    expect(desktopLocaleFromPreference('zh-CN')).toBe('zh')
    expect(desktopLocaleFromPreference('zh_CN')).toBe('zh')
    expect(desktopLocaleFromPreference('en-US')).toBe('en')
    expect(desktopLocaleFromPreference('zh-Hans')).toBe('zh')
  })

  it('裸 zh/en 行为不变', () => {
    expect(desktopLocaleFromPreference('zh')).toBe('zh')
    expect(desktopLocaleFromPreference('en')).toBe('en')
  })

  it('auto 与未设置继续交给系统语言', () => {
    expect(desktopLocaleFromPreference('auto')).toBeUndefined()
    expect(desktopLocaleFromPreference('AUTO')).toBeUndefined()
    expect(desktopLocaleFromPreference(undefined)).toBeUndefined()
  })

  it('不认识的语言交给系统语言（不是静默选英文）', () => {
    expect(desktopLocaleFromPreference('ja-JP')).toBeUndefined()
  })
})

describe('与托盘语言标签解析共用同一份规则（防再次漂移）', () => {
  it('两处对同一输入给出一致的语言', () => {
    const cases = ['zh', 'zh-CN', 'zh_CN', 'zh-Hans', 'en', 'en-US', 'en_GB']
    for (const id of cases) {
      const viaTag = desktopLocaleFromLanguageTag(id)
      const viaPreference = desktopLocaleFromPreference(id)
      expect(viaPreference, id).toBe(viaTag)
    }
  })

  it('托盘解析对不支持的语言仍回落英文（原生面没有"跟随系统"这一态）', () => {
    expect(desktopLocaleFromLanguageTag('ja-JP')).toBe('en')
  })
})
