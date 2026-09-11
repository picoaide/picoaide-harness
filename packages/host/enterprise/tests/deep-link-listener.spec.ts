import { describe, expect, it, vi } from 'vitest'
import { installDeepLinkListener } from '../src/deep-link.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '../src/server-connector/config.ts'

/** Minimal Cordis-context stub capturing the 'pico/deep-link' listener. */
function stubCtx() {
  const warns: string[] = []
  let listener: ((url: unknown) => void) | null = null
  const ctx = {
    on: (event: string, cb: (url: unknown) => void) => {
      if (event === 'pico/deep-link') listener = cb
      return () => {}
    },
    logger: {
      info: () => {},
      warn: (m: string) => { warns.push(String(m)) },
      error: () => {},
    },
  } as unknown as Context
  return {
    ctx,
    warns,
    fire: (url: string) => { listener?.(url) },
  }
}

const A: Session = { serverURL: 'https://a.example', username: 'alice', token: 'tok-a' }

// 深链 scheme 由**桌面壳按渠道注入**（渠道构建是客户自己的，如 acmeai）：
// 监听器不再自己读随包 channel.json —— enterprise 的 lib 是 tsdown 内联产物，
// `../build/channel.json` 在那里指向不存在的路径，读到的永远是 undefined。
const SCHEME = 'acmebrand'

function stubFetchOk() {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"user":{"username":"alice"}}', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })))
}

describe('installDeepLinkListener 会话切换防护 (F12)', () => {
  it('已登录时拒绝把会话静默切换到另一台服务端', async () => {
    stubFetchOk()
    const { ctx, warns, fire } = stubCtx()
    const applied: Session[] = []
    installDeepLinkListener(ctx, (s) => applied.push(s), () => A, SCHEME)
    fire(`${SCHEME}://auth?token=attacker&server=` + encodeURIComponent('https://evil.example') + '&user=eve')
    await new Promise((r) => setTimeout(r, 30))
    expect(applied).toHaveLength(0)
    expect(warns.join(' ')).toContain('refused server switch')
    vi.unstubAllGlobals()
  })

  it('未登录时正常接受通过预验证的深链', async () => {
    stubFetchOk()
    const { ctx, fire } = stubCtx()
    const applied: Session[] = []
    installDeepLinkListener(ctx, (s) => applied.push(s), () => null, SCHEME)
    fire(`${SCHEME}://auth?token=tok-b&server=` + encodeURIComponent('https://b.example') + '&user=bob')
    await new Promise((r) => setTimeout(r, 30))
    expect(applied).toHaveLength(1)
    expect(applied[0]!.serverURL).toBe('https://b.example')
    vi.unstubAllGlobals()
  })

  it('已登录且目标 server 相同(刷新 token)时允许更新', async () => {
    stubFetchOk()
    const { ctx, fire } = stubCtx()
    const applied: Session[] = []
    installDeepLinkListener(ctx, (s) => applied.push(s), () => A, SCHEME)
    fire(`${SCHEME}://auth?token=tok-new&server=` + encodeURIComponent('https://a.example') + '&user=alice')
    await new Promise((r) => setTimeout(r, 30))
    expect(applied).toHaveLength(1)
    expect(applied[0]!.token).toBe('tok-new')
    vi.unstubAllGlobals()
  })

  it('接受注入的渠道 scheme，而不是永远按官方 scheme 校验', async () => {
    // 2026-09-11 真机复现的缺陷：渠道客户端（acmeai）的浏览器 SSO 回调
    // 被当成畸形链接丢掉。scheme 必须来自桌面壳注入的 config。
    stubFetchOk()
    const { ctx, warns, fire } = stubCtx()
    const applied: Session[] = []
    installDeepLinkListener(ctx, (s) => applied.push(s), () => null, SCHEME)
    fire(`${SCHEME}://auth?token=tok-c&server=` + encodeURIComponent('https://c.example') + '&user=carol')
    await new Promise((r) => setTimeout(r, 30))
    expect(applied).toHaveLength(1)
    expect(warns.join(' ')).not.toContain('malformed')

    // 反向：不注入（缺省官方值）时，渠道 scheme 的回调进不来 —— 这正是缺陷形态。
    const fallback = stubCtx()
    const rejected: Session[] = []
    installDeepLinkListener(fallback.ctx, (s) => rejected.push(s), () => null)
    fallback.fire(`${SCHEME}://auth?token=tok-d&server=` + encodeURIComponent('https://d.example') + '&user=dave')
    await new Promise((r) => setTimeout(r, 30))
    expect(rejected).toHaveLength(0)
    expect(fallback.warns.join(' ')).toContain('malformed')
    vi.unstubAllGlobals()
  })
})
