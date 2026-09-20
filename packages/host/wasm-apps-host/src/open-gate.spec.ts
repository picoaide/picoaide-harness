/**
 * 打开校验闸门的用例（§5.1b / §7.2；含 **R2-L2-2** 的 404 判别）。
 *
 * 关键判据：**404 有两种语义**，必须按响应体分开 ——
 *  · 带平台错误信封（`{"error":{"code","message"}}`）= 端点存在并明确说"没有这个应用"
 *    （服务端 `open.go` 的冻结/退役/未登记都是 404 + 信封）⇒ `denied`，
 *    路由据此**关窗 + 丢缓存**；
 *  · 不带信封（HTML/空体/路由不存在）= 旧平台还没有这条端点 ⇒ `unsupported`，
 *    继续打开（滚动升级窗口不能被打破）。
 *
 * 变异验证：把 404 分支改回"一律 unsupported" ⇒ 前两条红（冻结应用的窗口关不掉）；
 * 把信封判别放宽成"只要有 JSON 体" ⇒ 第三条红（旧平台的 SPA 404 会把应用拦下）。
 */
import { describe, expect, it, vi } from 'vitest'
import { APP_OPEN_PATH, createAppOpenGate, platformErrorCode, platformErrorReason } from './open-gate.ts'

const SERVER = 'https://harness.example.com'

/** 造一次闸门调用（出站替身按 URL 末段回答）。 */
async function check(reply: (url: string, init: RequestInit) => Response): Promise<ReturnType<ReturnType<typeof createAppOpenGate>['check']> extends Promise<infer T> ? T : never> {
  const gate = createAppOpenGate({
    session: () => ({ serverURL: SERVER, token: 'tok' }),
    fetch: async (url, init) => reply(url, init),
    warn: () => {},
  })
  return await gate.check('demo', '1.0.0')
}

describe('打开校验闸门：404 的两档语义（R2-L2-2）', () => {
  it('404 + 平台错误信封 ⇒ denied（冻结/退役/未登记：窗口该关、缓存该丢）', async () => {
    const result = await check(() => new Response(JSON.stringify({
      error: { code: 'NOT_FOUND', message: '应用不存在', details: { reason: 'app_frozen' } },
    }), { status: 404 }))
    expect(result).toMatchObject({ kind: 'denied', status: 404, code: 'NOT_FOUND' })
  })

  it('404 无信封（HTML / 空体）⇒ unsupported（旧平台没有这条端点，照常打开）', async () => {
    const html = await check(() => new Response('<!doctype html><title>404</title>', { status: 404, headers: { 'content-type': 'text/html' } }))
    expect(html).toMatchObject({ kind: 'unsupported' })
    const empty = await check(() => new Response('', { status: 404 }))
    expect(empty).toMatchObject({ kind: 'unsupported' })
  })

  it('404 + 非平台形状的 JSON（例如 {"ok":false}）⇒ 仍按 unsupported（判别不能放宽）', async () => {
    const result = await check(() => new Response(JSON.stringify({ ok: false }), { status: 404 }))
    expect(result).toMatchObject({ kind: 'unsupported' })
    // 信封判别本身的边界（`error` 必须是字符串或带字符串 `code` 的对象）。
    expect(platformErrorCode({ error: { code: 'X' } })).toBe('X')
    expect(platformErrorCode({ error: 'X' })).toBe('X')
    expect(platformErrorCode({ error: { message: 'no code' } })).toBeNull()
    expect(platformErrorCode({ ok: false })).toBeNull()
    expect(platformErrorCode('404')).toBeNull()
  })

  it('405 / 501 仍按"端点不存在"继续打开', async () => {
    expect(await check(() => new Response('', { status: 405 }))).toMatchObject({ kind: 'unsupported' })
    expect(await check(() => new Response('', { status: 501 }))).toMatchObject({ kind: 'unsupported' })
  })

  it('410（已下架）+ 信封 ⇒ denied 410', async () => {
    const result = await check(() => new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: '应用已下架' } }), { status: 410 }))
    expect(result).toMatchObject({ kind: 'denied', status: 410, code: 'NOT_FOUND' })
  })

  it('200 ⇒ ok，并把平台字段原样带出（不做投影）', async () => {
    const result = await check(() => new Response(JSON.stringify({ version: '2.0.0', changed: true, title: '值班表', opens: { today: { pv: 3, uv: 2 } } }), { status: 200 }))
    expect(result).toMatchObject({ kind: 'ok', version: '2.0.0', changed: true, title: '值班表', opens: { today: { pv: 3, uv: 2 } } })
  })

  it('请求打到正确的端点并带 bearer（POST /agents? no —— /apps/wasm/:id/open）', async () => {
    const seen: Array<{ url: string, init: RequestInit }> = []
    await check((url, init) => {
      seen.push({ url, init })
      return new Response(JSON.stringify({ version: '1.0.0', changed: false }), { status: 200 })
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.url).toBe(`${SERVER}${APP_OPEN_PATH}/demo/open`)
    expect(seen[0]?.init.method).toBe('POST')
    expect((seen[0]?.init.headers as Record<string, string>).Authorization).toBe('Bearer tok')
    expect(JSON.parse(String(seen[0]?.init.body))).toEqual({ current_version: '1.0.0' })
  })

  it('401 且证明可重签 ⇒ 重试一次；重试成功即 ok', async () => {
    const invalidate = vi.fn()
    let calls = 0
    const gate = createAppOpenGate({
      session: () => ({ serverURL: SERVER, token: 'tok' }),
      fetch: async () => {
        calls += 1
        if (calls === 1) return new Response(JSON.stringify({ error: { code: 'proof_expired' } }), { status: 401 })
        return new Response(JSON.stringify({ version: '1.0.0', changed: false }), { status: 200 })
      },
      appProof: { get: async () => 'proof', invalidate },
      warn: () => {},
    })
    const result = await gate.check('demo', '')
    expect(result).toMatchObject({ kind: 'ok' })
    expect(calls).toBe(2)
    expect(invalidate).toHaveBeenCalledTimes(1)
  })

  it('未登录 ⇒ denied 401（一次出站都不发）', async () => {
    const fetchImpl = vi.fn()
    const gate = createAppOpenGate({
      session: () => null,
      fetch: fetchImpl as unknown as (url: string, init: RequestInit) => Promise<Response>,
      warn: () => {},
    })
    expect(await gate.check('demo', '')).toMatchObject({ kind: 'denied', status: 401, code: 'AUTH_REQUIRED' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  /**
   * 真机实测（2026-09-20，`temp/appwin/probe-freeze-close.mjs`）：应用被冻结后点"打开"，
   * 宿主回给客户端的是 `PLATFORM_PROOF_REPLAYED`（404 配一个"证明重放"的码）—— 因为
   * 第一张 proof 已被平台消费（401 `proof_replayed`），重试才拿到真正的结论（404 冻结），
   * 而代码把**第一次**响应的码跟**重试**的状态一起返回了。平台真正说的 `NOT_FOUND`
   * 被丢掉 ⇒ 客户端拿不到可辨结论（§19 Q3 的冻结文案因此不可达）。
   */
  it('重试被拒 ⇒ 报**重试**的码（不是第一张 proof 的 proof_replayed）', async () => {
    const proofs: string[] = []
    const invalidate = vi.fn()
    let calls = 0
    const gate = createAppOpenGate({
      session: () => ({ serverURL: SERVER, token: 'tok' }),
      fetch: async (_url, init) => {
        calls += 1
        proofs.push(new Headers(init.headers).get('x-pico-app-proof') ?? '')
        if (calls === 1) {
          return new Response(JSON.stringify({ error: { code: 'proof_replayed', message: '持有性证明重放' } }), { status: 401 })
        }
        return new Response(JSON.stringify({
          error: { code: 'NOT_FOUND', message: '应用已被管理员停用（冻结）', details: { reason: 'app_frozen' } },
        }), { status: 404 })
      },
      // 第一张来自缓存，重试必须用**重签**后的那一张。
      appProof: { get: async (_appId, force) => (force === true ? 'proof-fresh' : 'proof-cached'), invalidate },
      warn: () => {},
    })
    const result = await gate.check('demo', '')
    expect(result).toMatchObject({ kind: 'denied', status: 404, code: 'NOT_FOUND', reason: 'app_frozen' })
    expect(calls).toBe(2)
    expect(proofs).toEqual(['proof-cached', 'proof-fresh'])
    expect(invalidate).toHaveBeenCalledTimes(1)
  })

  /**
   * `details.reason` 是"冻结 vs 软删/未登记"的**唯一**区分凭据（同 404 同 `NOT_FOUND`）。
   * 解析必须宽容（`details.reason` / `error.reason` / 顶层 `reason`），但**不许猜**：
   * 都没有 ⇒ 不出现该字段，由调用方按"没有额外信息"处理。
   */
  it('读平台的结构化 reason（宽容三种形态；没有就不猜）', () => {
    expect(platformErrorReason({ error: { code: 'NOT_FOUND', details: { reason: 'app_frozen' } } })).toBe('app_frozen')
    expect(platformErrorReason({ error: { code: 'NOT_FOUND', reason: 'app_frozen' } })).toBe('app_frozen')
    expect(platformErrorReason({ reason: 'app_frozen' })).toBe('app_frozen')
    expect(platformErrorReason({ error: { code: 'NOT_FOUND' } })).toBeNull()
    expect(platformErrorReason({ error: 'NOT_FOUND' })).toBeNull()
    expect(platformErrorReason({ error: { details: { reason: '' } } })).toBeNull()
    expect(platformErrorReason(undefined)).toBeNull()
    expect(platformErrorReason('404')).toBeNull()
  })

  it('首次响应即被拒（非 401）时 reason 同样带出来', async () => {
    const result = await check(() => new Response(JSON.stringify({
      error: { code: 'NOT_FOUND', message: '应用不存在', details: { reason: 'app_not_found' } },
    }), { status: 404 }))
    expect(result).toMatchObject({ kind: 'denied', status: 404, code: 'NOT_FOUND', reason: 'app_not_found' })
  })
})
