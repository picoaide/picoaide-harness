import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply, resolveChannelLogoURLs, type ChannelConfig } from '../src/channel-sync.ts'
import { brandChannel, DEFAULT_CHANNEL, NEUTRAL_CHANNEL } from '../src/channel-content.ts'
import { SESSION_CHANGED_EVENT } from '../src/session-service.ts'
import type { Session } from '../src/server-connector/config.ts'

describe('resolveChannelLogoURLs', () => {
  const channel: ChannelConfig = {
    channel_id: 'official',
    login: { logo_url: '/api/client/v2/channel/logo', display_name: 'Acme', tagline: '', welcome: '' },
    client: { logo_url: '/api/client/v2/channel/logo', display_name: 'Acme AI', tagline: '' },
    favicon_url: '/api/client/v2/channel/logo',
    title: 'Acme',
    accent: '#2563eb',
  }

  it('resolves relative logo URLs to absolute against the server URL', () => {
    const out = resolveChannelLogoURLs(channel, 'https://ai.example.com')
    expect(out.login?.logo_url).toBe('https://ai.example.com/api/client/v2/channel/logo')
    expect(out.client?.logo_url).toBe('https://ai.example.com/api/client/v2/channel/logo')
    expect(out.favicon_url).toBe('https://ai.example.com/api/client/v2/channel/logo')
  })

  it('trims trailing slashes from the server URL (no //path)', () => {
    const out = resolveChannelLogoURLs(channel, 'https://ai.example.com/')
    expect(out.client?.logo_url).toBe('https://ai.example.com/api/client/v2/channel/logo')
  })

  it('keeps absolute URLs untouched (defensive)', () => {
    const out = resolveChannelLogoURLs(
      { ...channel, client: { ...channel.client!, logo_url: 'https://cdn.example.com/logo.png' } },
      'https://ai.example.com',
    )
    expect(out.client?.logo_url).toBe('https://cdn.example.com/logo.png')
  })

  it('leaves empty/absent URLs alone', () => {
    const out = resolveChannelLogoURLs({ ...channel, login: { display_name: '', tagline: '', welcome: '' } }, 'https://ai.example.com')
    expect(out.login?.logo_url).toBeUndefined()
  })

  it('carries the non-URL channel fields (channel_id/accent) through unchanged', () => {
    // 渠道内容总是生效:没有 enabled 开关,未配置的项只是缺失。
    const out = resolveChannelLogoURLs(channel, 'https://ai.example.com')
    expect(out.channel_id).toBe('official')
    expect(out.accent).toBe('#2563eb')
    expect(out).not.toHaveProperty('enabled')
  })

  it('accepts a payload where every optional field is absent', () => {
    // 缺字段就**不产生**该字段（不再物化 title: ''）：下游 mergeChannel 用
    // nonEmpty 判空，'' 与缺失等价，但凭空造字段会让 store 里多出无名空值。
    const out = resolveChannelLogoURLs({}, 'https://ai.example.com')
    expect(out).toEqual({})
  })

  it('keeps the dark logo URL (previously dropped when client was rebuilt)', () => {
    // 服务端配了 assets.logo_dark 才下发 login.logo_url_dark；这里重建 login
    // 对象时曾把它丢掉，暗色主题那条链路就此静默失效（2026-09-10 实测发现）。
    const out = resolveChannelLogoURLs(
      { login: { logo_url: '/api/client/v2/channel/logo', logo_url_dark: '/api/client/v2/channel/logo-dark' } },
      'https://ai.example.com/',
    )
    expect(out.login?.logo_url).toBe('https://ai.example.com/api/client/v2/channel/logo')
    expect(out.login?.logo_url_dark).toBe('https://ai.example.com/api/client/v2/channel/logo-dark')
  })
})

describe('channel-sync built-in brand (未登录/服务端不可达时的显示内容)', () => {
  /** 最小 Cordis 上下文：只实现 channel-sync 用到的 on/emit。 */
  function ctxWithEvents(restored?: Session | null): {
    ctx: Context
    emitSession: (session: Session | null) => void
    emitted: unknown[]
  } {
    const sessionListeners = new Set<(session: Session | null) => void>()
    const emitted: unknown[] = []
    const ctx = {
      on: (event: string, listener: (session: Session | null) => void) => {
        expect(event).toBe(SESSION_CHANGED_EVENT)
        sessionListeners.add(listener)
        return () => { sessionListeners.delete(listener) }
      },
      emit: (event: string, payload: unknown) => {
        expect(event).toBe('pico/channel-changed')
        emitted.push(payload)
      },
      // subscribeSession 会用 isRestored() 判断"启动时那次事件是否已经错过"。
      // 不传 restored = 恢复还在进行（事件随后必到，补发不该发生）。
      picoSession: { isRestored: () => restored !== undefined, getSession: () => restored ?? null },
    } as unknown as Context
    return {
      ctx,
      emitted,
      emitSession: (session) => { for (const l of [...sessionListeners]) l(session) },
    }
  }

  const BRAND = {
    title: 'Acme 门户',
    login: { displayName: 'Acme AI', shortName: 'Acme', tagline: '企业内部平台', welcome: '' },
    client: { displayName: 'Acme AI', shortName: 'Acme', tagline: '' },
  }

  it('emits the packaged channel brand on logout instead of null', async () => {
    // 此前登出发 null,客户端各自回落到硬编码的厂商文案 —— 渠道客户于是看到
    // 厂商名。现在回落的必须是渠道自己的内容。
    const { ctx, emitSession, emitted } = ctxWithEvents()
    apply(ctx, { brand: BRAND })
    emitSession(null)
    await Promise.resolve()
    expect(emitted).toEqual([brandChannel(BRAND)])
    expect(JSON.stringify(emitted)).not.toContain('PicoAide')
  })

  it('keeps the official built-in content when no channel brand is injected', async () => {
    const { ctx, emitSession, emitted } = ctxWithEvents()
    apply(ctx)
    emitSession(null)
    await Promise.resolve()
    expect(emitted).toEqual([DEFAULT_CHANNEL])
  })

  it('treats a materialized empty brand object as no channel brand', () => {
    // schemastery 物化出的 `{}` 不是渠道品牌:判成渠道会让官方构建改名
    // (2026-09-10 官方 E2E 标题变 "Harness")。中性占位由 desktop-channel.ts
    // 在注入前就写好。
    expect(brandChannel({})).toEqual(DEFAULT_CHANNEL)
  })

  it('syncs a restored session even when the startup event was missed', async () => {
    // 现场（2026-09-10）：重启后带着有效会话进来，侧边栏品牌图是裂的 —— 客户端
    // store 里存的是本地端点给的**相对** logo，而服务端驱动的渠道内容（绝对化的
    // logo）一直没到：`restore()` 在 SessionService 构造期就启动，它 emit 那次
    // 会话事件可能早于 channel-sync 的 apply，裸 ctx.on 会整个漏掉。
    // 这里模拟"订阅时已经恢复完成"，apply 必须自己补一次同步。
    const session: Session = {
      serverURL: 'https://ai.example.com',
      token: 't',
      username: 'user001',
    } as Session
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        channel_id: 'acme',
        client: { display_name: 'Acme AI', logo_url: '/api/client/v2/channel/logo' },
        accent: '#2563eb',
      }),
    }))
    try {
      const { ctx, emitted } = ctxWithEvents(session)
      apply(ctx, { brand: BRAND })
      // 没有 emitSession：这一次完全靠 subscribeSession 的补发。
      for (let i = 0; i < 50 && emitted.length === 0; i += 1) {
        await new Promise((resolve) => { setTimeout(resolve, 5) })
      }
      expect(emitted).toHaveLength(1)
      const channel = emitted[0] as { client?: { logo_url?: string, short_name?: string }, accent?: string }
      expect(channel.client?.logo_url).toBe('https://ai.example.com/api/client/v2/channel/logo')
      // 随包品牌补上的 short_name 仍在（白标不能因此丢掉）。
      expect(channel.client?.short_name).toBe('Acme')
      expect(channel.accent).toBe('#2563eb')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('keeps short_name through the logo-URL absolutization', () => {
    // short_name 服务端不下发:它由随包品牌补上。absolutizeURLs 重建 client
    // 对象时丢掉它,侧边栏就会变成另一套兜底名字。
    const out = resolveChannelLogoURLs(
      { client: { display_name: 'Acme AI', short_name: 'Acme', tagline: '' } },
      'https://ai.example.com',
    )
    expect(out.client?.short_name).toBe('Acme')
  })
})

describe('会话代际守卫（Z2-01）：迟到的渠道内容不得改写当前会话的品牌', () => {
  const SESSION_A: Session = { serverURL: 'https://server-a.example.com', username: 'alice', token: 'tok-a' }
  const SESSION_B: Session = { serverURL: 'https://server-b.example.com', username: 'bob', token: 'tok-b' }

  type Deferred = { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  let pending: Map<'A' | 'B', Deferred[]>

  function installDeferredFetch(): () => void {
    pending = new Map()
    const original = globalThis.fetch
    globalThis.fetch = vi.fn((input: unknown) => {
      const key: 'A' | 'B' = String(input).startsWith('https://server-a') ? 'A' : 'B'
      return new Promise<unknown>((resolve, reject) => {
        const queue = pending.get(key) ?? []
        queue.push({ resolve, reject })
        pending.set(key, queue)
      })
    }) as unknown as typeof fetch
    return () => { globalThis.fetch = original }
  }

  function respond(key: 'A' | 'B', tenant: string): void {
    const next = (pending.get(key) ?? []).shift()
    if (next === undefined) throw new Error(`没有在飞的请求：${key}`)
    next.resolve(new Response(JSON.stringify({ client: { display_name: tenant }, title: tenant }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
  }

  function fail(key: 'A' | 'B'): void {
    const next = (pending.get(key) ?? []).shift()
    if (next === undefined) throw new Error(`没有在飞的请求：${key}`)
    next.reject(new Error('network down'))
  }

  const flush = async (n = 12): Promise<void> => {
    for (let i = 0; i < n; i += 1) await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
  }

  function fixture(): { ctx: Context; emitted: unknown[]; emitSession: (s: Session | null) => void } {
    const listeners = new Set<(s: Session | null) => void>()
    const emitted: unknown[] = []
    const ctx = {
      on: (event: string, listener: (s: Session | null) => void) => {
        expect(event).toBe(SESSION_CHANGED_EVENT)
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      emit: (event: string, payload: unknown) => {
        expect(event).toBe('pico/channel-changed')
        emitted.push(payload)
      },
      picoSession: { isRestored: () => false, getSession: () => null },
    } as unknown as Context
    return { ctx, emitted, emitSession: (s) => { for (const l of [...listeners]) l(s) } }
  }

  it('换服务端后到达的旧渠道内容必须被丢弃（界面不能停在上一台租户的品牌）', async () => {
    const restore = installDeferredFetch()
    try {
      const { ctx, emitted, emitSession } = fixture()
      apply(ctx)

      emitSession(SESSION_A)
      await flush()
      emitSession(null)
      emitSession(SESSION_B)
      await flush()

      respond('B', 'Tenant-B')
      await flush()
      respond('A', 'Tenant-A')
      await flush()

      const last = emitted.at(-1) as { client?: { display_name?: string } }
      expect(
        last?.client?.display_name,
        `当前会话是 ${SESSION_B.serverURL}，但界面品牌停在上一台服务端的内容上`,
      ).toBe('Tenant-B')
    } finally {
      restore()
    }
  })

  it('旧请求的**失败**同样不得把当前会话的品牌重置成随包品牌（catch 分支也要判代际）', async () => {
    const restore = installDeferredFetch()
    try {
      const { ctx, emitted, emitSession } = fixture()
      apply(ctx)

      emitSession(SESSION_A)
      await flush()
      emitSession(null)
      emitSession(SESSION_B)
      await flush()

      respond('B', 'Tenant-B')
      await flush()
      fail('A') // 上一台服务端的请求在新会话建立之后才失败
      await flush()

      const last = emitted.at(-1) as { client?: { display_name?: string } }
      expect(last?.client?.display_name, '旧请求的迟到失败把品牌重置了').toBe('Tenant-B')
    } finally {
      restore()
    }
  })
})
