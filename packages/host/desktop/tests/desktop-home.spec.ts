import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import {
  DSH_HOME_ENV,
  PRODUCT_DSH_HOME_DIR,
  DEFAULT_DSH_HOME_DISPLAY,
  dshHomePath,
  expandHomePath,
  isSafeDshHome,
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
