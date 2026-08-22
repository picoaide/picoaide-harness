import { describe, expect, it } from 'vitest'
import {
  classifyNavigation,
  isPasswordTarget,
  isSubmitTarget,
  MAX_DOWNLOAD_BYTES,
  navigationDenyReason,
} from '../src/guard.ts'

describe('navigation policy', () => {
  it('allows https and http', () => {
    expect(classifyNavigation('https://example.com/a?b=1')).toBe('allow')
    expect(classifyNavigation('http://example.com')).toBe('allow')
  })

  it('allows about:blank', () => {
    expect(classifyNavigation('about:blank')).toBe('allow')
  })

  it('denies dangerous schemes', () => {
    expect(classifyNavigation('javascript:alert(1)')).toBe('deny')
    expect(classifyNavigation('data:text/html,<script>1</script>')).toBe('deny')
    expect(classifyNavigation('file:///etc/passwd')).toBe('deny')
    expect(classifyNavigation('chrome://settings')).toBe('deny')
    expect(classifyNavigation('vbscript:x')).toBe('deny')
  })

  it('denies empty, non-string and oversized URLs', () => {
    expect(classifyNavigation('')).toBe('deny')
    expect(classifyNavigation(42 as unknown as string)).toBe('deny')
    expect(classifyNavigation(`https://example.com/${'a'.repeat(9000)}`)).toBe('deny')
  })

  it('allows relative URLs (the page cannot escalate origin through them)', () => {
    expect(classifyNavigation('/relative/path')).toBe('allow')
  })

  it('produces a human-readable deny reason', () => {
    expect(navigationDenyReason('javascript:alert(1)')).toContain('javascript')
    expect(navigationDenyReason('')).toContain('empty or too long')
  })
})

describe('sensitive-target detection', () => {
  it('flags submit-like buttons', () => {
    expect(isSubmitTarget('button', 'Submit', 'button')).toBe(true)
    expect(isSubmitTarget('button', '', '')).toBe(true)
    expect(isSubmitTarget('link', '登录', 'a')).toBe(true)
    expect(isSubmitTarget('link', 'Docs', 'a')).toBe(false)
    expect(isSubmitTarget('input', '', 'input#q')).toBe(false)
  })

  it('flags password fields', () => {
    expect(isPasswordTarget('#password')).toBe(true)
    expect(isPasswordTarget('input[name="passwd"]')).toBe(true)
    expect(isPasswordTarget('input#username')).toBe(false)
  })
})

describe('download bound', () => {
  it('caps downloads at 100MB', () => {
    expect(MAX_DOWNLOAD_BYTES).toBe(100 * 1024 * 1024)
  })
})
