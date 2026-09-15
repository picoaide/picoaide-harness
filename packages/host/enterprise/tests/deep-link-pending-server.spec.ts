/**
 * srvcore-1(P0,审计 2026-09-13)客户端一半的回归:
 *
 * 深链是任何人都能触发的本机事件(`picoaide://auth?token=…&server=…`)。服务端
 * 同源校验(server/internal/serverauth/oidc.go)是主防线,但客户端必须同时做到
 * ——**只接受本机登录页正在等待的那台服务端**,否则一个本地进程(或网页里的
 * 自定义 scheme 跳转)就能让客户端把后续会话指向攻击者服务端。
 *
 * 这里用真实 fetch 桩记录"token 到底发去了哪里"(URL + Authorization 头),
 * 而不是只断言本地 applied 状态。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '../src/server-connector/config.ts'

const SCHEME = 'picoaide'

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
  return { ctx, warns, fire: (url: string) => { listener?.(url) } }
}

/** fetch 桩:恒 200(预验证必过),并记录每个请求的 URL 与 Authorization。 */
function stubFetchCapturing() {
  const calls: { url: string; authorization: string | null }[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: { headers?: Record<string, string> }) => {
    const headers = init?.headers ?? {}
    calls.push({
      url: String(input),
      authorization: headers.Authorization ?? headers.authorization ?? null,
    })
    return new Response('{"user":{"username":"alice"}}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }))
  return calls
}

/**
 * 每个用例都重新加载模块:待登录状态是模块级单例(与登录页同进程共享),
 * 直接复用静态实例会让用例之间互相污染。
 */
async function freshModule() {
  vi.resetModules()
  return import('../src/deep-link.ts')
}

describe('installDeepLinkListener 只接受本机登录页等待的服务端 (srvcore-1)', () => {
  it('normalizes same-origin server spellings but keeps non-default ports distinct', async () => {
    const mod = await freshModule()
    const base = mod.serverIdentity('https://gw.example.com')
    expect(base).toBe('https://gw.example.com')
    for (const variant of [
      'https://gw.example.com/',
      'https://GW.Example.com',
      'https://gw.example.com:443',
      'https://gw.example.com/some/sub/path',
    ]) {
      expect(mod.serverIdentity(variant)).toBe(base)
    }
    // 非默认端口是**不同**的来源,不能被归一掉。
    expect(mod.serverIdentity('https://gw.example.com:8443')).toBe('https://gw.example.com:8443')
    expect(mod.serverIdentity('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080')
    expect(mod.serverIdentity('ftp://gw.example.com')).toBeNull()
    expect(mod.serverIdentity('not a url')).toBeNull()
  })

  it('refuses a deep link for a server no local login page is waiting for, sending no token', async () => {
    const mod = await freshModule()
    const calls = stubFetchCapturing()
    const { ctx, warns, fire } = stubCtx()
    const applied: Session[] = []
    mod.installDeepLinkListener(ctx, (s) => applied.push(s), () => null, SCHEME)
    mod.noteBrowserLoginStarted('https://real-corp.example')

    fire(`${SCHEME}://auth?token=REAL-EMPLOYEE-TOKEN&server=` + encodeURIComponent('https://evil.example') + '&user=eve')
    await vi.waitFor(() => { expect(warns.join(' ')).toContain('no local login is waiting') })

    expect(calls).toEqual([])
    expect(applied).toHaveLength(0)
    vi.unstubAllGlobals()
  })

  it('accepts the server the local login page is waiting for (case/trailing slash normalized)', async () => {
    const mod = await freshModule()
    const calls = stubFetchCapturing()
    const { ctx, fire } = stubCtx()
    const applied: Session[] = []
    mod.installDeepLinkListener(ctx, (s) => applied.push(s), () => null, SCHEME)
    mod.noteBrowserLoginStarted('https://real-corp.example/')

    fire(`${SCHEME}://auth?token=tok-real&server=` + encodeURIComponent('https://REAL-CORP.example') + '&user=alice')
    await vi.waitFor(() => {
      expect(applied).toHaveLength(1)
      expect(calls).toHaveLength(1)
    })
    expect(new URL(calls[0]!.url).hostname).toBe('real-corp.example')
    expect(calls[0]!.authorization).toBe('Bearer tok-real')
    vi.unstubAllGlobals()
  })

  it('refuses any deep link after the login page reset its pending target (cancel/timeout)', async () => {
    const mod = await freshModule()
    const calls = stubFetchCapturing()
    const { ctx, warns, fire } = stubCtx()
    const applied: Session[] = []
    mod.installDeepLinkListener(ctx, (s) => applied.push(s), () => null, SCHEME)
    mod.noteBrowserLoginStarted('https://real-corp.example')
    mod.clearBrowserLoginPending()

    fire(`${SCHEME}://auth?token=tok-late&server=` + encodeURIComponent('https://real-corp.example') + '&user=alice')
    await vi.waitFor(() => { expect(warns.join(' ')).toContain('no local login is waiting') })

    expect(calls).toEqual([])
    expect(applied).toHaveLength(0)
    vi.unstubAllGlobals()
  })

  it('arms strict mode with no pending target: noteLoginPageWired() alone refuses every unauthenticated deep link', async () => {
    // R3-N1a:官方构建(没有预置服务端地址)在 auth-gate.apply() 里只调用
    // noteLoginPageWired(),不登记任何服务端 ⇒ "当前没有等待目标"必须是拒绝
    // 理由而不是放行理由。这条锁的是 deep-link 侧的最小 API 语义。
    const mod = await freshModule()
    const calls = stubFetchCapturing()
    const { ctx, warns, fire } = stubCtx()
    const applied: Session[] = []
    mod.installDeepLinkListener(ctx, (s) => applied.push(s), () => null, SCHEME)

    mod.noteLoginPageWired()
    expect(mod.pendingBrowserLoginServer()).toBeNull()
    fire(`${SCHEME}://auth?token=REAL-EMPLOYEE-TOKEN&server=` + encodeURIComponent('https://evil.example') + '&user=eve')
    await vi.waitFor(() => { expect(warns.join(' ')).toContain('no local login is waiting') })

    expect(calls, '未登记 ⇒ 一个字节都不外发').toEqual([])
    expect(applied).toHaveLength(0)

    // 登记之后同一台服务端才被接受(登记先于深链的顺序语义不变)。
    mod.noteBrowserLoginStarted('https://real-corp.example')
    fire(`${SCHEME}://auth?token=tok-real&server=` + encodeURIComponent('https://real-corp.example') + '&user=alice')
    await vi.waitFor(() => {
      expect(applied).toHaveLength(1)
      expect(calls).toHaveLength(1)
    })
    vi.unstubAllGlobals()
  })
})
