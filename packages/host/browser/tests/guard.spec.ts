import { readFileSync } from 'node:fs'
import { URL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  classifyNavigation,
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

describe('download bound', () => {
  it('caps downloads at 100MB', () => {
    expect(MAX_DOWNLOAD_BYTES).toBe(100 * 1024 * 1024)
  })
})

describe('no browser approval seam (product decision 2026-08-26)', () => {
  it('guard.ts has no askApproval / requireApproval', () => {
    const source = readFileSync(new URL('../src/guard.ts', import.meta.url), 'utf8')
    expect(source).not.toContain('askApproval')
    expect(source).not.toContain('requireApproval')
    expect(source).not.toContain("ctx.get('approval')")
  })

  it('tools.ts has no requireApproval calls', () => {
    const source = readFileSync(new URL('../src/tools.ts', import.meta.url), 'utf8')
    expect(source).not.toContain('requireApproval')
    expect(source).not.toContain('not approved by the user')
  })

  it('index.ts does not wire the approval service', () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
    expect(source).not.toContain("ctx.get('approval')")
    expect(source).not.toContain('dsh-user-approval')
  })
})
