import { describe, expect, it, vi, beforeEach } from 'vitest'

// setup.ts 为页面测试全局 mock 了 ../api;这里恢复真实实现测请求层本身
vi.unmock('./api')

// 动态 import,确保在 vi.unmock 之后加载真实模块
async function loadApi() {
  return await import('./api')
}

describe('api 请求层(审计 A5-M3/L5/L6)', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  it('401 触发全局 onUnauthorized 回调并抛出 ApiError(不再整页跳转)', async () => {
    const { request, setOnUnauthorized } = await loadApi()
    const handler = vi.fn()
    setOnUnauthorized(handler)
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: async () => ({ error: { code: 'AUTH_REQUIRED', message: '未登录' } }),
    })
    await expect(request('/api/admin/x')).rejects.toMatchObject({ status: 401, code: 'AUTH_REQUIRED' })
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('非 JSON 错误体(如反代 502)使用中文兜底文案', async () => {
    const { request } = await loadApi()
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      json: async () => { throw new Error('not json') },
    })
    await expect(request('/api/admin/x')).rejects.toMatchObject({ message: '服务暂时不可用,请稍后再试' })
  })

  it('成功响应返回解析后的 JSON', async () => {
    const { request } = await loadApi()
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, items: [1] }),
    })
    await expect(request('/api/admin/x')).resolves.toEqual({ ok: true, items: [1] })
  })
})
