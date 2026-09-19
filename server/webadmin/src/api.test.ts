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

  // -------------------------------------------------------------------------
  // P1-6(2026-09-19):wasm 平台错误信封是 {"error":{code,message,details,hints}}
  // -------------------------------------------------------------------------
  //
  // 审计现场:api.ts 只从**顶层** body.detail 取结构化信息,ApiError 上根本没有
  // hints —— 页面里 `err?.hints` 是死代码,服务端说的"还差什么条件"在管理端
  // 全丢;而页面测试用手工挂属性的方式让它恒绿(假绿)。
  //
  // 这两条用例打桩 fetch 打**真实实现**、喂**真实信封形状**:
  // 把 api.ts 改回只读 body.detail(不读 error.hints/error.details)⇒ 必红。
  it('嵌套 error.details / error.hints 被解析(hints 恒为数组)', async () => {
    const { request, ApiError } = await loadApi()
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({
        error: {
          code: 'VALIDATION',
          message: '这组限制项的理论内存峰值超过可用内存的安全水位',
          details: { field: 'max_instances' },
          hints: ['把全局并发实例数调到 4 以内', '或改用小内存档'],
        },
      }),
    })
    const err = await request('/api/server/admin/wasm-apps/limits', { method: 'PUT' }).catch((e: any) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err.message).toBe('这组限制项的理论内存峰值超过可用内存的安全水位')
    expect(err.details).toEqual({ field: 'max_instances' })
    expect(err.hints).toEqual(['把全局并发实例数调到 4 以内', '或改用小内存档'])
  })

  it('hints 缺失 / 含非字符串 / details 非对象时不产生半解析结果', async () => {
    const { request } = await loadApi()
    const bodies = [
      { error: { code: 'NOT_FOUND', message: '应用不存在' } },
      { error: { code: 'NOT_FOUND', message: '应用不存在', hints: null } },
      { error: { code: 'NOT_FOUND', message: '应用不存在', hints: 'oops' } },
      { error: { code: 'NOT_FOUND', message: '应用不存在', hints: [1, '', null] } },
      { error: { code: 'NOT_FOUND', message: '应用不存在', details: 'oops' } },
    ]
    for (const body of bodies) {
      fetchMock.mockResolvedValue({ ok: false, status: 404, json: async () => body })
      const err = await request('/api/server/admin/x').catch((e: any) => e)
      // hints 恒为数组(空),调用方不必判 null/undefined。
      expect(err.hints).toEqual([])
      expect(err.details).toBeUndefined()
    }
  })

  it('error.details 优先于顶层 detail,但 detail 字段本身不被改口径', async () => {
    const { request } = await loadApi()
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => ({
        error: { code: 'UPSTREAM', message: '上游失败', details: { field: 'base_domain' } },
        detail: { kind: 'DNS' },
      }),
    })
    const err = await request('/api/server/admin/x').catch((e: any) => e)
    // details = error.details ?? body.detail(错误上报分类仍读 detail,行为不变)。
    expect(err.details).toEqual({ field: 'base_domain' })
    expect(err.detail).toEqual({ kind: 'DNS' })
  })
})
