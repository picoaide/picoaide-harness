import { describe, expect, it, vi } from 'vitest'
import * as plugin from '../src/index.ts'
import * as invariantCompanion from '../src/invariant.ts'

describe('dsh-branding host plugin', () => {
  it('declares the stable plugin name', () => {
    expect(plugin.name).toBe('dsh-branding')
  })

  it('apply is a no-op host half (all surfaces live in the client half)', () => {
    expect(() => plugin.apply()).not.toThrow()
  })
})

describe('dsh-branding invariant companion', () => {
  it('registers package ownership through the invariants service', async () => {
    const dispose = vi.fn()
    const register = vi.fn(() => dispose)
    const ctx = { invariants: { register } } as unknown as Parameters<typeof invariantCompanion.apply>[0]
    const disposer = await invariantCompanion.apply(ctx)
    expect(register).toHaveBeenCalledWith('@picoaide/dsh-branding', expect.any(Function))
    disposer()
    expect(dispose).toHaveBeenCalledOnce()
  })
})
