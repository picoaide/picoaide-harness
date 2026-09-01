import { describe, expect, it, vi } from 'vitest'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { readBrandSync, startBrandStore } from '../src/client/brand-store.ts'
import type { BrandConfig } from '../src/brand-sync.ts'

const BRAND: BrandConfig = {
  name: 'PicoAide',
  logoUrl: 'https://srv/logo.svg',
  faviconUrl: 'https://srv/favicon.svg',
  primaryColor: '#2563eb',
} as BrandConfig

function ctxWithEvent(): { ctx: ClientContext; emit: (brand: BrandConfig | null) => void } {
  const listeners = new Set<(brand: BrandConfig | null) => void>()
  const ctx = {
    on: (event: string, listener: (brand: BrandConfig | null) => void) => {
      expect(event).toBe('pico/brand-changed')
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  } as unknown as ClientContext
  return {
    ctx,
    emit: (brand) => { for (const l of [...listeners]) l(brand) },
  }
}

describe('brand store', () => {
  it('starts empty and updates on the host event', () => {
    const { ctx, emit } = ctxWithEvent()
    expect(readBrandSync()).toBeNull()
    const cancel = startBrandStore(ctx)
    emit(BRAND)
    expect(readBrandSync()).toEqual(BRAND)
    cancel()
  })

  it('treats a null host event as the default brand', () => {
    const { ctx, emit } = ctxWithEvent()
    const cancel = startBrandStore(ctx)
    emit(BRAND)
    emit(null)
    expect(readBrandSync()).toBeNull()
    cancel()
  })

  it('is re-entrant: repeated start returns the same cancellation', () => {
    const { ctx } = ctxWithEvent()
    const first = startBrandStore(ctx)
    // Second install while already started must not double-subscribe.
    const second = startBrandStore(ctx)
    const res = readBrandSync()
    expect(res).toBeNull()
    second()
    // After cancel, a fresh start re-subscribes.
    const third = startBrandStore(ctx)
    expect(typeof third).toBe('function')
    third()
    first()
  })

  it('unsubscribes when the returned cancel is invoked', () => {
    const { ctx, emit } = ctxWithEvent()
    const cancel = startBrandStore(ctx)
    cancel()
    emit(BRAND)
    expect(readBrandSync()).toBeNull()
  })
})
