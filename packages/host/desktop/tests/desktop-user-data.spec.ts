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

  it('keeps the brand channel product name as-is', () => {
    // 品牌渠道的产品名就是它自己的品牌：目录名干净且能自查。
    expect(desktopUserDataDirectoryName('Moka Harness', 'moka')).toBe('Moka Harness')
  })

  it('disambiguates a channel that reuses the official product name', () => {
    // beta 复用官方品牌 → 产品名与 official 逐字相同；不消歧就会共用 userData，
    // 于是共用日志/更新状态/**单实例锁**（两个客户端互相顶掉启动）。
    expect(desktopUserDataDirectoryName(OFFICIAL_PRODUCT_NAME, 'beta'))
      .toBe(`${OFFICIAL_PRODUCT_NAME} (beta)`)
  })

  it('never returns an empty or path-like name for a channel', () => {
    for (const id of ['moka', 'beta', 'acme-2']) {
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
    expect(defaultDesktopUserDataDirectory('linux', { XDG_CONFIG_HOME: '/home/example/.config' }, '/home/example', 'Moka Harness'))
      .toBe('/home/example/.config/Moka Harness')
  })

  it('fails loudly when Windows has no APPDATA', () => {
    expect(() => defaultDesktopUserDataDirectory('win32', {}, 'C:\\Users\\Example'))
      .toThrow(/APPDATA/u)
  })
})
