import { describe, expect, it } from 'vitest'
import * as plugin from '../src/index.ts'

describe('dsh-branding host plugin', () => {
  it('declares the stable plugin name', () => {
    expect(plugin.name).toBe('dsh-branding')
  })

  it('apply is a no-op host half (all surfaces live in the client half)', () => {
    expect(() => plugin.apply()).not.toThrow()
  })
})
