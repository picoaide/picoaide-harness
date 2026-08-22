import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import {
  DSH_HOME_ENV,
  PRODUCT_DSH_HOME_DIR,
  expandHomePath,
  resolveDshHome,
} from '../src/dsh-home.ts'

describe('resolveDshHome (product home, re-exported from dsh-plugin-desktop/desktop-home)', () => {
  it('defaults to ~/.picoaide-harness (product home, not upstream ~/.dsh)', () => {
    expect(resolveDshHome(undefined, {}, '/home/user')).toBe(join('/home/user', PRODUCT_DSH_HOME_DIR))
    expect(PRODUCT_DSH_HOME_DIR).toBe('.picoaide-harness')
  })

  it('prefers an explicit DSH_HOME environment variable', () => {
    expect(resolveDshHome(undefined, { [DSH_HOME_ENV]: '/custom/home' }, '/home/user')).toBe('/custom/home')
  })

  it('gives the configured path the highest precedence (official contract)', () => {
    expect(resolveDshHome('/configured', { [DSH_HOME_ENV]: '/from-env' }, '/home/user')).toBe('/configured')
  })

  it('expands a tilde in DSH_HOME', () => {
    expect(resolveDshHome(undefined, { [DSH_HOME_ENV]: '~/data' }, '/home/user')).toBe(join('/home/user', 'data'))
  })

  it('ignores blank DSH_HOME and falls back to the product default', () => {
    expect(resolveDshHome(undefined, { [DSH_HOME_ENV]: ' ' }, '/home/user')).toBe(join('/home/user', PRODUCT_DSH_HOME_DIR))
  })
})

describe('expandHomePath', () => {
  it('expands ~ and ~/ prefixes only', () => {
    expect(expandHomePath('~', '/home/user')).toBe('/home/user')
    expect(expandHomePath('~/x', '/home/user')).toBe(join('/home/user', 'x'))
    expect(expandHomePath('/abs', '/home/user')).toBe('/abs')
  })
})
