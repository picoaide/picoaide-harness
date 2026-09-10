import { describe, expect, it, vi } from 'vitest'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { readChannelSync, startChannelStore } from '../src/client/channel-store.ts'
import type { ChannelConfig } from '../src/channel-sync.ts'

const CHANNEL: ChannelConfig = {
  name: 'PicoAide',
  logoUrl: 'https://srv/logo.svg',
  faviconUrl: 'https://srv/favicon.svg',
  primaryColor: '#2563eb',
} as ChannelConfig

function ctxWithEvent(): { ctx: ClientContext; emit: (channel: ChannelConfig | null) => void } {
  const listeners = new Set<(channel: ChannelConfig | null) => void>()
  const ctx = {
    on: (event: string, listener: (channel: ChannelConfig | null) => void) => {
      expect(event).toBe('pico/channel-changed')
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  } as unknown as ClientContext
  return {
    ctx,
    emit: (channel) => { for (const l of [...listeners]) l(channel) },
  }
}

describe('channel store', () => {
  it('starts empty and updates on the host event', () => {
    const { ctx, emit } = ctxWithEvent()
    expect(readChannelSync()).toBeNull()
    const cancel = startChannelStore(ctx)
    emit(CHANNEL)
    expect(readChannelSync()).toEqual(CHANNEL)
    cancel()
  })

  it('treats a null host event as the built-in default channel', () => {
    const { ctx, emit } = ctxWithEvent()
    const cancel = startChannelStore(ctx)
    emit(CHANNEL)
    emit(null)
    expect(readChannelSync()).toBeNull()
    cancel()
  })

  it('is re-entrant: repeated start returns the same cancellation', () => {
    const { ctx } = ctxWithEvent()
    const first = startChannelStore(ctx)
    // Second install while already started must not double-subscribe.
    const second = startChannelStore(ctx)
    const res = readChannelSync()
    expect(res).toBeNull()
    second()
    // After cancel, a fresh start re-subscribes.
    const third = startChannelStore(ctx)
    expect(typeof third).toBe('function')
    third()
    first()
  })

  it('unsubscribes when the returned cancel is invoked', () => {
    const { ctx, emit } = ctxWithEvent()
    const cancel = startChannelStore(ctx)
    cancel()
    emit(CHANNEL)
    expect(readChannelSync()).toBeNull()
  })
})
