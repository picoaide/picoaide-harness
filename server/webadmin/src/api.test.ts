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
    await expect(request('/api/server/admin/x')).rejects.toMatchObject({ status: 401, code: 'AUTH_REQUIRED' })
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
    await expect(request('/api/server/admin/x')).rejects.toMatchObject({ message: '服务暂时不可用,请稍后再试' })
  })

  it('成功响应返回解析后的 JSON', async () => {
    const { request } = await loadApi()
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, items: [1] }),
    })
    await expect(request('/api/server/admin/x')).resolves.toEqual({ ok: true, items: [1] })
  })

  // 2026-09-17 审计 S12-04:detail 的解析此前没有任何测试真正执行 ——
  // setup.ts 全局 mock 了 ../api,页面用例里的 detail 是测试自己塞进替身
  // ApiError 的;把 api.ts 的读取位置写错(如 body.error.detail)或整段删掉,
  // 套件仍然全绿,线上 DNS/CONNECT/TLS/TIMEOUT/HTTP_4XX/HTTP_5XX 分类会静默
  // 退化成裸 message。这两条用例打桩 fetch 打**真实实现**(本文件已 unmock)。
  it('失败信封顶层的 detail 段被解析并暴露(错误上报失败分类)', async () => {
    const { request, ApiError } = await loadApi()
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      json: async () => ({
        error: { code: 'UPSTREAM', message: '无法解析上报服务域名(DNS 失败)' },
        // 分类在 error **之外**的顶层 detail 里(与服务端信封一致)。
        detail: { kind: 'DNS' },
      }),
    })
    const err = await request('/api/server/admin/gateway/error-reporting/test', { method: 'POST' }).catch((e: any) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(502)
    expect(err.code).toBe('UPSTREAM')
    expect(err.message).toBe('无法解析上报服务域名(DNS 失败)')
    expect(err.detail).toEqual({ kind: 'DNS' })
  })

  it('detail 缺失或不是对象时保持 undefined(不产生半解析的 detail)', async () => {
    const { request } = await loadApi()
    const bodies = [
      { error: { code: 'UPSTREAM', message: '上游失败' } },
      { error: { code: 'UPSTREAM', message: '上游失败' }, detail: null },
      { error: { code: 'UPSTREAM', message: '上游失败' }, detail: 'oops' },
      { error: { code: 'UPSTREAM', message: '上游失败' }, detail: 42 },
    ]
    for (const body of bodies) {
      fetchMock.mockResolvedValue({ ok: false, status: 502, statusText: 'Bad Gateway', json: async () => body })
      const err = await request('/api/server/admin/x').catch((e: any) => e)
      expect(err.detail).toBeUndefined()
    }
  })
})
