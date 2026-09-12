import { describe, expect, it } from 'vitest'
import {
  defaultDesktopUserDataDirectory,
  desktopUserDataDirectoryName,
} from '../src/desktop-user-data.ts'
import { OFFICIAL_PRODUCT_NAME } from '../src/desktop-channel.ts'

describe('desktopUserDataDirectoryName (随渠道的第二份数据根)', () => {
  it('keeps the plain product name for the official channel', () => {
    expect(desktopUserDataDirectoryName(OFFICIAL_PRODUCT_NAME)).toBe(OFFICIAL_PRODUCT_NAME)
    expect(desktopUserDataDirectoryName(OFFICIAL_PRODUCT_NAME, 'official')).toBe(OFFICIAL_PRODUCT_NAME)
  })

  it('suffixes every non-official channel, so two brands can never share one directory', () => {
    // 2026-09-12 审计 P1-13:旧口径只在"产品名与官方逐字相同"时补后缀,于是两个
    // **不同的**品牌渠道只要取同一个产品名就共用同一个 userData(单实例锁互顶 +
    // 日志/更新状态/插件管理状态/已下载安装包共享)。渠道 id 唯一,补上它就由构造
    // 保证唯一 —— 不再依赖"渠道包作者恰好没重名"。
    expect(desktopUserDataDirectoryName('Acme Harness', 'acme')).toBe('Acme Harness (acme)')
    expect(desktopUserDataDirectoryName('Acme Harness', 'acme-staging')).toBe('Acme Harness (acme-staging)')
    expect(desktopUserDataDirectoryName('Acme Harness', 'acme'))
      .not.toBe(desktopUserDataDirectoryName('Acme Harness', 'acme-staging'))
  })

  it('never lets a channel name collide with another channel (injective construction)', () => {
    // 同一组 (产品名, 渠道 id) 不可能拼出两个相同的目录名:渠道 id 形状固定
    // (小写字母/数字/连字符,无括号),所以末尾那段 ` (<id>)` 唯一可解码。
    const names = new Map<string, string>()
    for (const product of ['Acme Harness', 'Acme', 'PicoAide Harness', 'Harness']) {
      for (const id of ['acme', 'acme-staging', 'beta', 'zeta', 'acme-2']) {
        const name = desktopUserDataDirectoryName(product, id)
        const key = `${product}/${id}`
        const previous = names.get(name)
        expect(previous === undefined || previous === key).toBe(true)
        names.set(name, key)
      }
    }
  })

  it('disambiguates a channel that reuses the official product name', () => {
    // beta 复用官方品牌 → 产品名与 official 逐字相同；不消歧就会共用 userData，
    // 于是共用日志/更新状态/**单实例锁**（两个客户端互相顶掉启动）。
    expect(desktopUserDataDirectoryName(OFFICIAL_PRODUCT_NAME, 'beta'))
      .toBe(`${OFFICIAL_PRODUCT_NAME} (beta)`)
  })

  it('never returns an empty or path-like name for a channel', () => {
    for (const id of ['acme', 'beta', 'acme-2']) {
      const name = desktopUserDataDirectoryName(OFFICIAL_PRODUCT_NAME, id)
      expect(name.length).toBeGreaterThan(0)
      expect(name).not.toContain('/')
      expect(name).not.toContain('\\')
    }
  })
})

describe('defaultDesktopUserDataDirectory (无 Electron 的等价实现)', () => {
  it('resolves the platform app-data directory plus the data directory name', () => {
    expect(defaultDesktopUserDataDirectory('win32', { APPDATA: 'C:\\Users\\Example\\AppData\\Roaming' }, 'ignored'))
      .toBe('C:\\Users\\Example\\AppData\\Roaming\\PicoAide Harness')
    expect(defaultDesktopUserDataDirectory('darwin', {}, '/Users/example'))
      .toBe('/Users/example/Library/Application Support/PicoAide Harness')
    expect(defaultDesktopUserDataDirectory('linux', { XDG_CONFIG_HOME: '/home/example/.config' }, '/home/example'))
      .toBe('/home/example/.config/PicoAide Harness')
  })

  it('uses the channel-specific name when one is given', () => {
    // 渠道构建的 userData 必须与官方不同（否则单实例锁互相顶掉）。
    expect(defaultDesktopUserDataDirectory('linux', { XDG_CONFIG_HOME: '/home/example/.config' }, '/home/example', 'Acme Harness (acme)'))
      .toBe('/home/example/.config/Acme Harness (acme)')
  })

  it('fails loudly when Windows has no APPDATA', () => {
    expect(() => defaultDesktopUserDataDirectory('win32', {}, 'C:\\Users\\Example'))
      .toThrow(/APPDATA/u)
  })
})
