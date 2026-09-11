import { describe, expect, it } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  DSH_HOME_ENV,
  PRODUCT_DSH_HOME_DIR,
  DEFAULT_DSH_HOME_DISPLAY,
  channelDshHomeDir,
  dshHomePath,
  dshHomeSafe,
  expandHomePath,
  isSafeDshHome,
  isSafeDshHomeDirName,
  isSystemWorkingDirectory,
  resolveDshHome,
} from '../src/desktop-home.ts'

describe('resolveDshHome (product home)', () => {
  it('defaults to ~/.picoaide-harness (product home, not upstream ~/.dsh)', () => {
    expect(resolveDshHome(undefined, {}, '/home/user')).toBe(join('/home/user', PRODUCT_DSH_HOME_DIR))
    expect(PRODUCT_DSH_HOME_DIR).toBe('.picoaide-harness')
  })

  it('prefers an explicit DSH_HOME environment variable over the default', () => {
    expect(resolveDshHome(undefined, { [DSH_HOME_ENV]: '/custom/home' }, '/home/user')).toBe('/custom/home')
  })

  it('gives the configured path the highest precedence (official contract)', () => {
    expect(resolveDshHome('/configured', { [DSH_HOME_ENV]: '/from-env' }, '/home/user')).toBe('/configured')
  })

  it('expands a tilde in DSH_HOME and configured paths', () => {
    expect(resolveDshHome(undefined, { [DSH_HOME_ENV]: '~/data' }, '/home/user')).toBe(join('/home/user', 'data'))
    expect(resolveDshHome('~/cfg', {}, '/home/user')).toBe(join('/home/user', 'cfg'))
  })

  it('treats blank DSH_HOME as unset and falls back to the product default', () => {
    expect(resolveDshHome(undefined, { [DSH_HOME_ENV]: '  ' }, '/home/user')).toBe(join('/home/user', PRODUCT_DSH_HOME_DIR))
  })

  it('normalizes the result with path.resolve', () => {
    expect(resolveDshHome('/a/../b', {}, '/home/user')).toBe('/b')
  })

  it('uses the channel data directory when no explicit home is configured', () => {
    // 渠道构建的数据根：官方目录是常量，渠道用 `channelDshHomeDir` 派生的那一段。
    expect(resolveDshHome(undefined, {}, '/home/user', '.acme-harness')).toBe(join('/home/user', '.acme-harness'))
    // 显式覆盖（DSH_HOME / configured，e2e 与便携安装用）永远优先于渠道缺省
    expect(resolveDshHome(undefined, { [DSH_HOME_ENV]: '/custom/home' }, '/home/user', '.acme-harness'))
      .toBe('/custom/home')
    expect(resolveDshHome('/configured', {}, '/home/user', '.acme-harness')).toBe('/configured')
  })
})

describe('channelDshHomeDir (渠道数据隔离的唯一派生点)', () => {
  it('keeps the official directory for the official channel', () => {
    expect(channelDshHomeDir('official')).toBe(PRODUCT_DSH_HOME_DIR)
    // 官方渠道下即使渠道包写了别的值也不采纳（官方构建不随包分发渠道包）
    expect(channelDshHomeDir('official', { homeDir: '.other' })).toBe(PRODUCT_DSH_HOME_DIR)
  })

  it('prefers the explicit channel value, then the slug, then the channel id', () => {
    expect(channelDshHomeDir('acme', { homeDir: '.acme-data', slug: 'Acme-Harness' })).toBe('.acme-data')
    expect(channelDshHomeDir('acme', { slug: 'Acme-Harness' })).toBe('.acme-harness')
    // 没有 slug 的渠道（如 beta：复用官方品牌）也不能落到官方目录
    expect(channelDshHomeDir('beta')).toBe(`${PRODUCT_DSH_HOME_DIR}-beta`)
  })

  it('honors an explicitly declared official directory (public channels share it)', () => {
    // beta 刻意与官方共用数据根(2026-09-11 定案):显式值一律照办,包括官方目录本身。
    expect(channelDshHomeDir('beta', { homeDir: PRODUCT_DSH_HOME_DIR })).toBe(PRODUCT_DSH_HOME_DIR)
  })

  it('never *derives* the official directory for a non-official channel', () => {
    // 派生/回落路径仍不许撞上官方目录(那是"漏配"而不是"刻意共用"):
    // 经销商渠道由 CI 强制显式声明,运行期只在没有显式值时才走到这里。
    for (const options of [
      {},
      { homeDir: 'plain' },
      { homeDir: '../escape' },
      { homeDir: '/abs' },
      { homeDir: '.UPPER' },
      { slug: 'PicoAide-Harness' },
      { slug: '../../etc' },
      { slug: 42 },
    ]) {
      expect(channelDshHomeDir('acme', options)).not.toBe(PRODUCT_DSH_HOME_DIR)
    }
  })

  it('accepts only single-segment dot-prefixed lowercase names', () => {
    expect(isSafeDshHomeDirName('.acme-harness')).toBe(true)
    expect(isSafeDshHomeDirName('.a')).toBe(true)
    for (const bad of ['.', '..', '.UPPER', 'plain', '.with/slash', '.with\\slash', '.white space', '', undefined, 42, `.${'a'.repeat(64)}`]) {
      expect(isSafeDshHomeDirName(bad)).toBe(false)
    }
  })
})

describe('dshHomePath and display', () => {
  it('joins segments onto the resolved home (honoring the live DSH_HOME)', () => {
    // The test process itself may run under a real DSH_HOME; dshHomePath has
    // no seam, so assert against the live environment instead of a fixed cwd.
    const home = resolveDshHome()
    expect(dshHomePath('cron', 'ledger.json')).toBe(join(home, 'cron', 'ledger.json'))
  })

  it('labels the default home symbolically', () => {
    expect(DEFAULT_DSH_HOME_DISPLAY).toBe('~/.picoaide-harness')
  })
})

describe('expandHomePath', () => {
  it('expands ~ and ~/ prefixes only', () => {
    expect(expandHomePath('~', '/home/user')).toBe('/home/user')
    expect(expandHomePath('~/x', '/home/user')).toBe(join('/home/user', 'x'))
    expect(expandHomePath('/abs', '/home/user')).toBe('/abs')
  })
})

describe('isSafeDshHome (审计 P2-3 系统目录拒绝)', () => {
  it('allows the product default and /tmp-based homes (e2e/sandbox use)', () => {
    expect(isSafeDshHome('/home/user/.picoaide-harness')).toBe(true)
    expect(isSafeDshHome('/tmp/dsh-desktop-profile-abc')).toBe(true)
    expect(isSafeDshHome('/tmp')).toBe(true)
  })
  it('allows macOS temp dir (/var/folders/.../T/, os.tmpdir() on macOS)', () => {
    // 2026-08-25 修复:macOS profile 冒烟(verify-profile-boot)用 $TMPDIR
    // 下的 mktemp DSH_HOME,此前被 /var 前缀误拒导致 CI 失败。
    expect(isSafeDshHome('/var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/dsh-desktop-profile-5e84bS')).toBe(true)
  })
  it('refuses system-critical prefixes (/, /etc, /usr, /var, /dev, /proc)', () => {
    expect(isSafeDshHome('/')).toBe(false)
    expect(isSafeDshHome('/etc')).toBe(false)
    expect(isSafeDshHome('/usr/local')).toBe(false)
    expect(isSafeDshHome('/var/lib/picoaide')).toBe(false)
    expect(isSafeDshHome('/dev/shm')).toBe(false)
    expect(isSafeDshHome('/proc/self')).toBe(false)
  })
})

describe('dshHomeSafe (P2-33: the launcher uses the guarded entry point)', () => {
  it('returns a safe home', () => {
    expect(dshHomeSafe({ env: { DSH_HOME: '/tmp/dsh-home' } })).toBe('/tmp/dsh-home')
  })

  it('honors the channel data directory passed by the launcher', () => {
    expect(dshHomeSafe({ env: {}, productDir: '.acme-harness' })).toBe(join(homedir(), '.acme-harness'))
  })

  it('throws for an injected system-directory home instead of using it', () => {
    expect(() => dshHomeSafe({ env: { DSH_HOME: '/etc' } })).toThrow(/unsafe DSH_HOME/u)
    expect(() => dshHomeSafe({ configured: '/' })).toThrow(/unsafe DSH_HOME/u)
  })
})

describe('isSystemWorkingDirectory (P2-34: packaged cwd guard)', () => {
  it('flags filesystem roots of both path flavours', () => {
    expect(isSystemWorkingDirectory('/')).toBe(true)
    expect(isSystemWorkingDirectory('C:\\')).toBe(true)
    expect(isSystemWorkingDirectory('')).toBe(true)
  })

  it('flags POSIX system directories and their children', () => {
    expect(isSystemWorkingDirectory('/usr')).toBe(true)
    expect(isSystemWorkingDirectory('/usr/bin')).toBe(true)
    expect(isSystemWorkingDirectory('/etc/systemd')).toBe(true)
    expect(isSystemWorkingDirectory('/var/log')).toBe(true)
  })

  it('flags the Windows system root and Program Files from the environment', () => {
    const env = {
      SystemRoot: 'C:\\Windows',
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      ProgramData: 'C:\\ProgramData',
    }
    expect(isSystemWorkingDirectory('C:\\Windows\\System32', env)).toBe(true)
    expect(isSystemWorkingDirectory('C:\\Program Files\\PicoAide', env)).toBe(true)
    expect(isSystemWorkingDirectory('C:\\ProgramData\\PicoAide', env)).toBe(true)
  })

  it('allows ordinary project directories', () => {
    expect(isSystemWorkingDirectory('/data/picoaide-harness')).toBe(false)
    expect(isSystemWorkingDirectory('/home/user/projects/app')).toBe(false)
    expect(isSystemWorkingDirectory('/tmp/workspace')).toBe(false)
  })
})
