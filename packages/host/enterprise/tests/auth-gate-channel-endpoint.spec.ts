import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, type Config } from '../src/auth-gate.ts'

/**
 * 客户端本地端点 `/api/pico/channel` 的**出口契约**：只对外给绝对素材 URL。
 *
 * 为什么钉死：服务端下发的 `logo_url`/`favicon_url` 是相对路径（如
 * `/api/client/v2/channel/logo`）。本端点的返回值会被客户端 store 直接存下并交给
 * `<img>` 渲染 —— 相对路径在 Electron 渲染层会打到本地 webServer 而 404。
 * 2026-09-10 实测：服务端开始下发 `client.logo_url` 之后，侧边栏与首页的品牌图
 * 立刻变成裂图（此前该字段恒为空，走的是内置品牌图形回落，所以这条路径一直潜伏）。
 */

/** 让 guard() 放行的最小请求（同源标记 + 回环地址 + 回环 Host）。 */
function fakeRequest(method = 'GET'): IncomingMessage {
  return {
    method,
    url: '/api/pico/channel',
    headers: { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' },
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as IncomingMessage
}

/** 捕获响应体（handler 走 json()，只需 writeHead/end）。 */
function fakeResponse(): { res: ServerResponse, read: () => { code: number, body: unknown } } {
  let code = 0
  let body: unknown
  const res = {
    writeHead: (value: number) => { code = value },
    end: (chunk?: string | Buffer) => {
      body = chunk === undefined ? undefined : JSON.parse(chunk.toString())
    },
  } as unknown as ServerResponse
  return { res, read: () => ({ code, body }) }
}

/** 装一个 auth-gate，并取出 /api/pico/channel 的 handler。 */
function channelHandler(
  config: Config,
  session: { serverURL: string, token: string } | null,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  let handler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined
  const ctx = {
    effect: (fn: () => unknown) => { fn() },
    picoSession: {
      isRestored: () => true,
      isLoggedIn: () => session !== null,
      getSession: () => session,
    },
    webServer: {
      tapIndex: () => () => {},
      register: (route: { path: string, handler: typeof handler }) => {
        if (route.path === '/api/pico/channel') handler = route.handler
        return () => {}
      },
    },
  }
  apply(ctx as never, config)
  expect(handler, 'auth-gate 必须注册 /api/pico/channel').toBeDefined()
  return handler!
}

/** 服务端 /api/client/v2/channel 的真实形状：素材 URL 是相对路径。 */
const UPSTREAM = {
  channel_id: 'beta',
  title: 'Acme 门户',
  login: { display_name: 'Acme', tagline: '', welcome: '', logo_url: '/api/client/v2/channel/logo', logo_url_dark: '/api/client/v2/channel/logo-dark' },
  client: { display_name: 'Acme AI', tagline: '', logo_url: '/api/client/v2/channel/logo' },
  favicon_url: '/api/client/v2/channel/favicon',
  accent: '#2563eb',
}

describe('auth-gate /api/pico/channel asset URL contract', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('returns absolute asset URLs when a session provides the server address', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => UPSTREAM,
      text: async () => JSON.stringify(UPSTREAM),
    }))
    const handler = channelHandler({ brand: undefined }, { serverURL: 'https://ai.example.com', token: 't' })
    const { res, read } = fakeResponse()
    await handler(fakeRequest(), res)

    const { code, body } = read()
    expect(code).toBe(200)
    expect(body).toMatchObject({
      client: { display_name: 'Acme AI', logo_url: 'https://ai.example.com/api/client/v2/channel/logo' },
      login: {
        logo_url: 'https://ai.example.com/api/client/v2/channel/logo',
        logo_url_dark: 'https://ai.example.com/api/client/v2/channel/logo-dark',
      },
      favicon_url: 'https://ai.example.com/api/client/v2/channel/favicon',
    })
    // 出口不得再出现相对路径（渲染层拿到它必然裂图）。
    expect(JSON.stringify(body)).not.toContain('"/api/')
  })

  it('fills the packaged-only short_name the server never sends', async () => {
    // 侧边栏要的是**短名**（"PicoAide"），而服务端下发的载荷里没有 `client.short_name`
    // —— 它是随包品牌独有的字段。此前本端点把服务端载荷原样透传，短名整条丢失，
    // 侧边栏于是回落到显示名 "PicoAide Harness"，在 184px 的定高行里折成两行
    // （2026-09-11 现场）。出口必须以随包品牌为底做逐字段叠加。
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => UPSTREAM,
      text: async () => JSON.stringify(UPSTREAM),
    }))
    // 无渠道包 = 官方构建：随包兜底就是内置官方内容（短名 "PicoAide"）。
    const handler = channelHandler({ brand: undefined }, { serverURL: 'https://ai.example.com', token: 't' })
    const { res, read } = fakeResponse()
    await handler(fakeRequest(), res)

    const body = read().body as { client: { display_name?: string, short_name?: string }, title?: string }
    expect(body.client.short_name).toBe('PicoAide')
    // 服务端的显示名仍然胜出（叠加不是替换）。
    expect(body.client.display_name).toBe('Acme AI')
    expect(body.title).toBe('Acme 门户')
  })

  it('takes the short name from the packaged channel brand, not the vendor one', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => UPSTREAM,
      text: async () => JSON.stringify(UPSTREAM),
    }))
    const handler = channelHandler(
      { brand: { login: { displayName: 'Acme', shortName: 'Acme' }, client: { displayName: 'Acme AI' } } },
      { serverURL: 'https://ai.example.com', token: 't' },
    )
    const { res, read } = fakeResponse()
    await handler(fakeRequest(), res)
    const body = read().body as { client: { short_name?: string, display_name?: string } }
    expect(body.client.short_name).toBe('Acme')
    expect(JSON.stringify(body)).not.toContain('PicoAide')
  })

  it('keeps already-absolute asset URLs untouched', async () => {
    const absolute = {
      ...UPSTREAM,
      client: { display_name: 'Acme AI', tagline: '', logo_url: 'https://cdn.example.com/logo.svg' },
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => absolute,
      text: async () => JSON.stringify(absolute),
    }))
    const handler = channelHandler({ brand: undefined }, { serverURL: 'https://ai.example.com', token: 't' })
    const { res, read } = fakeResponse()
    await handler(fakeRequest(), res)
    expect(read().body).toMatchObject({ client: { logo_url: 'https://cdn.example.com/logo.svg' } })
  })
})
