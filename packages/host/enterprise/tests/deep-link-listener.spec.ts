import { describe, expect, it, vi } from 'vitest'
import { installDeepLinkListener } from '../src/deep-link.ts'
import { readDesktopChannelProfile } from 'dsh-plugin-desktop/desktop-channel'
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

// 监听器按随包渠道决定深链 scheme(构建渠道可为 moka 等白标),测试对齐。
const SCHEME = readDesktopChannelProfile()?.deepLinkScheme ?? 'picoaide'

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
    installDeepLinkListener(ctx, (s) => applied.push(s), () => A)
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
    installDeepLinkListener(ctx, (s) => applied.push(s), () => null)
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
    installDeepLinkListener(ctx, (s) => applied.push(s), () => A)
    fire(`${SCHEME}://auth?token=tok-new&server=` + encodeURIComponent('https://a.example') + '&user=alice')
    await new Promise((r) => setTimeout(r, 30))
    expect(applied).toHaveLength(1)
    expect(applied[0]!.token).toBe('tok-new')
    vi.unstubAllGlobals()
  })
})
