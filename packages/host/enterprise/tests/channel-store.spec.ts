import { describe, expect, it, vi } from 'vitest'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { readChannelSync, startChannelStore, subscribeChannel } from '../src/client/channel-store.ts'
import type { ChannelConfig } from '../src/channel-content.ts'

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

describe('channel store packaged-brand seed', () => {
  const PACKAGED: ChannelConfig = {
    title: 'Acme 门户',
    login: { display_name: 'Acme AI', tagline: '', welcome: '' },
    client: { display_name: 'Acme AI', short_name: 'Acme', tagline: '' },
  }

  /** flush the pending seed fetch (one microtask + one macrotask). */
  const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0) })

  function stubChannelEndpoint(payload: unknown, ok = true): void {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok, json: async () => payload }))
  }

  it('seeds the packaged brand when the store is still empty', async () => {
    // 登录后到服务端下发之间有一段时间,界面要在这段时间就显示渠道自己的品牌。
    stubChannelEndpoint(PACKAGED)
    const { ctx, emit } = ctxWithEvent()
    const cancel = startChannelStore(ctx)
    emit(null)
    await settle()
    expect(readChannelSync()).toEqual(PACKAGED)
    cancel()
    vi.unstubAllGlobals()
  })

  it('never overwrites content the server already delivered', async () => {
    // 并发竞态:随包请求后到时会盖掉服务端的权威内容(渠道改了服务端配置,
    // 客户端却显示旧名)。
    stubChannelEndpoint(PACKAGED)
    const { ctx, emit } = ctxWithEvent()
    const cancel = startChannelStore(ctx)
    emit({ client: { display_name: '服务端权威名' } })
    await settle()
    expect(readChannelSync()?.client?.display_name).toBe('服务端权威名')
    cancel()
    vi.unstubAllGlobals()
  })

  it('ignores an empty payload and a failed request', async () => {
    stubChannelEndpoint({})
    const { ctx, emit } = ctxWithEvent()
    const cancel = startChannelStore(ctx)
    emit(null)
    await settle()
    expect(readChannelSync()).toBeNull()
    cancel()
    vi.unstubAllGlobals()

    stubChannelEndpoint({}, false)
    const second = ctxWithEvent()
    const cancel2 = startChannelStore(second.ctx)
    second.emit(null)
    await settle()
    expect(readChannelSync()).toBeNull()
    cancel2()
    vi.unstubAllGlobals()
  })

  it('drops relative asset URLs from the seed payload', async () => {
    // 2026-09-10 实测的裂图根因：服务端下发的 logo_url 是相对路径
    // (/api/client/v2/channel/logo)，而 <img src> 在 Electron 渲染层会打到
    // **本地** webServer（那里没有服务端命名空间的路由）→ 404 → 界面上一张裂图。
    // 播种是"手上没有服务端地址可比对"的路径（端点出口已绝对化，这里是第二道
    // 保险）：相对地址一律丢弃，让消费方回落到内置品牌图形，别渲染必然 404 的地址。
    stubChannelEndpoint({
      ...PACKAGED,
      client: { display_name: 'Acme AI', short_name: 'Acme', tagline: '', logo_url: '/api/client/v2/channel/logo' },
      favicon_url: '/api/client/v2/channel/favicon',
    })
    const { ctx, emit } = ctxWithEvent()
    const cancel = startChannelStore(ctx)
    emit(null)
    await settle()
    const seeded = readChannelSync()
    expect(seeded?.client?.logo_url).toBeUndefined()
    expect(seeded?.favicon_url).toBeUndefined()
    // 名字/短名等非素材字段照常保留（否则等于把白标一起丢了）。
    expect(seeded?.client?.short_name).toBe('Acme')
    cancel()
    vi.unstubAllGlobals()
  })

  it('keeps absolute asset URLs from the seed payload', async () => {
    stubChannelEndpoint({
      ...PACKAGED,
      client: { display_name: 'Acme AI', short_name: 'Acme', tagline: '', logo_url: 'https://ai.example.com/api/client/v2/channel/logo' },
    })
    const { ctx, emit } = ctxWithEvent()
    const cancel = startChannelStore(ctx)
    emit(null)
    await settle()
    expect(readChannelSync()?.client?.logo_url).toBe('https://ai.example.com/api/client/v2/channel/logo')
    cancel()
    vi.unstubAllGlobals()
  })
})

describe('channel store value subscriptions', () => {
  it('notifies value subscribers on seed and on host events', async () => {
    // 标题归一化/hero 变量这类非 React 消费方靠它:播种不经过 Host 事件,
    // 只订阅 pico/channel-changed 会一直拿旧值(实测:侧边栏已是渠道名、
    // 窗口标题还是厂商名)。
    const seen: Array<unknown> = []
    const off = subscribeChannel((channel) => seen.push(channel))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ title: 'Zephyr AI', client: { display_name: 'Zephyr AI', short_name: 'Zephyr' } }),
    }))
    const { ctx, emit } = ctxWithEvent()
    const cancel = startChannelStore(ctx)
    emit(null)
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(seen.some(entry => (entry as { title?: string } | null)?.title === 'Zephyr AI')).toBe(true)
    cancel()
    off()
    vi.unstubAllGlobals()
  })

  it('stops notifying after unsubscribe', () => {
    const seen: Array<unknown> = []
    const off = subscribeChannel((channel) => seen.push(channel))
    off()
    const { ctx, emit } = ctxWithEvent()
    const cancel = startChannelStore(ctx)
    emit(null)
    expect(seen).toHaveLength(0)
    cancel()
  })
})
