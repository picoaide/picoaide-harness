import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { login, changePassword, AuthError, ApiError } from '../src/server-connector/auth.ts'

// 0057: 登录响应解析(来源/可改密/强制改密标记)与员工自助改密请求层。
// gatewayFetch 在无 Electron 模块时退化为全局 fetch —— 用 vi.stubGlobal('fetch')
// 模拟服务端响应。
function mockFetch(body: unknown, status = 200): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }))
}

beforeEach(() => { vi.restoreAllMocks() })
afterEach(() => { vi.unstubAllGlobals() })

describe('login response parsing (0057)', () => {
  it('解析 must_change_password / source / password_changeable 到会话', async () => {
    mockFetch({
      token: 'tok-1',
      user: { role: 'user', source: 'local', password_changeable: true },
      must_change_password: true,
    })
    const sess = await login('https://gw.example', 'alice', 'pw1234567890')
    expect(sess.token).toBe('tok-1')
    expect(sess.source).toBe('local')
    expect(sess.passwordChangeable).toBe(true)
    expect(sess.mustChangePassword).toBe(true)
  })

  it('未返回可选字段时不写入(不产生 undefined 值)', async () => {
    mockFetch({ token: 'tok-1', user: { role: 'user' } })
    const sess = await login('https://gw.example', 'alice', 'pw1234567890')
    expect('source' in sess).toBe(false)
    expect('mustChangePassword' in sess).toBe(false)
  })
})

describe('changePassword (0057)', () => {
  it('成功: 调用 /api/client/v2/auth/password 并携带旧密码/新密码', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) })
    vi.stubGlobal('fetch', fetchMock)
    await changePassword('https://gw.example', 'tok-1', 'old12345678', 'new12345678')
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://gw.example/api/client/v2/auth/password')
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({ Authorization: 'Bearer tok-1' })
    expect(JSON.parse(String(init.body))).toEqual({ old_password: 'old12345678', new_password: 'new12345678' })
  })

  it('401 原密码错误: 抛出携带服务端消息的 AuthError', async () => {
    mockFetch({ error: { code: 'AUTH_FAILED', message: '原密码错误' } }, 401)
    await expect(changePassword('https://gw.example', 'tok-1', 'bad', 'new12345678'))
      .rejects.toThrowError('原密码错误')
  })

  it('400 长度不足: 抛出 ApiError 并透传服务端消息', async () => {
    mockFetch({ error: { code: 'VALIDATION', message: '密码至少 10 位' } }, 400)
    await expect(changePassword('https://gw.example', 'tok-1', 'ok12345678', 'short'))
      .rejects.toBeInstanceOf(ApiError)
    await expect(changePassword('https://gw.example', 'tok-1', 'ok12345678', 'short'))
      .rejects.toThrowError('密码至少 10 位')
  })
})
