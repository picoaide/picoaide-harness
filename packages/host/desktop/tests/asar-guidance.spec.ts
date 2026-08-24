import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply as applyGuidance, name as guidanceName, inject as guidanceInject } from '../src/asar-guidance.ts'

function mockContext(): Context {
  const section = vi.fn<(section: unknown) => () => void>(() => () => {})
  const ctx = {
    systemPrompt: { section },
    effect: (callback: () => unknown) => { callback() },
  }
  return { ...ctx, systemPrompt: ctx.systemPrompt } as unknown as Context
}

describe('desktop-asar-guidance', () => {
  it('has a stable plugin identity', () => {
    expect(guidanceName).toBe('desktop-asar-guidance')
    expect(guidanceInject).toEqual(['systemPrompt'])
  })

  it('registers an inbox-package prompt section through systemPrompt', () => {
    const ctx = mockContext()
    const section = (ctx.systemPrompt as unknown as { section: ReturnType<typeof vi.fn> }).section

    applyGuidance(ctx)

    expect(section).toHaveBeenCalledOnce()
    const registered = section.mock.calls[0]?.[0] as { name: string; order: number; text: string }
    expect(registered.name).toBe('desktop:inbox-packages')
    expect(registered.order).toBe(90)
    expect(registered.text).toContain('app.asar')
    expect(registered.text).toContain('profiles\\node_modules')
    expect(registered.text).toContain('Read-only packaged files')
  })

  it('handles the section disposer', () => {
    const dispose = vi.fn()
    const section = vi.fn<(section: unknown) => () => void>(() => dispose)
    const ctx = {
      systemPrompt: { section },
      effect: (callback: () => unknown) => { callback() },
    } as unknown as Context

    applyGuidance(ctx)
    expect(section).toHaveBeenCalledOnce()
  })
})
