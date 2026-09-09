/** Strict `picoaide://` deep-link gate (audit 2026-09-08 P2-62). */
import { describe, expect, it } from 'vitest'
import { parseDesktopDeepLink } from '../src/deep-link.ts'

describe('parseDesktopDeepLink', () => {
  it('accepts the allow-listed auth callback forms', () => {
    expect(parseDesktopDeepLink('picoaide://auth?token=t&server=https%3A%2F%2Fgw.example.com')).toEqual({
      action: 'auth',
      url: 'picoaide://auth?token=t&server=https%3A%2F%2Fgw.example.com',
    })
    // Path-only spellings parse to the same action.
    expect(parseDesktopDeepLink('picoaide:/auth?token=t')?.action).toBe('auth')
    expect(parseDesktopDeepLink('picoaide:///auth?token=t')?.action).toBe('auth')
    expect(parseDesktopDeepLink('PICOaide://AUTH?token=t')?.action).toBe('auth')
  })

  it('rejects unknown actions, wrong schemes and malformed input', () => {
    for (const raw of [
      'picoaide://evil?token=t',
      'picoaide://auth.evil.example?token=t',
      'https://auth?token=t',
      'picoaide:',
      'picoaide://',
      'not a url',
      '',
      'x'.repeat(5000),
    ]) {
      expect(parseDesktopDeepLink(raw), raw).toBeNull()
    }
    expect(parseDesktopDeepLink(undefined)).toBeNull()
    expect(parseDesktopDeepLink(42)).toBeNull()
    expect(parseDesktopDeepLink({ toString: () => 'picoaide://auth?token=t' })).toBeNull()
  })

  it('drops extra path segments and query values it does not understand', () => {
    // The action stays allow-listed; the enterprise parser still validates the
    // token/server fields it needs.
    expect(parseDesktopDeepLink('picoaide://auth/cb?token=t')?.action).toBe('auth')
  })
})
