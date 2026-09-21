/**
 * 作者声明的窗口几何（F3/§6）：解析、归一化与目录兜底来源的判据。
 *
 * 这一组钉的是 2026-09-21 审计 P0-2 的接线缺口：`window.ratio/width/height` 此前只
 * 到客户端详情页（渲染成「窗口比例 16:9」），建窗路径一个字段都没收到。
 *
 * 变异验证（每条都实跑过）：
 *  - `resolveDeclaredWindowSize` 改成"原样返回 width/height"（不按 ratio 推另一边）
 *    ⇒ "只给 ratio 时按缺省宽度 1280 推高" 与 "只给 height 时反推宽" 必红；
 *  - `createWindowCatalog` 去掉按会话缓存（每次都拉）⇒ "同一个会话只拉一次" 必红；
 *  - 去掉失败退避 ⇒ "失败后不反复重试" 必红。
 */
import { describe, expect, it } from 'vitest'
import {
  APP_CATALOG_PATH,
  CATALOG_RETRY_BACKOFF_MS,
  createWindowCatalog,
} from './window-catalog.ts'
import {
  APP_WINDOW_DEFAULT_HEIGHT,
  APP_WINDOW_DEFAULT_WIDTH,
  parseDeclaredWindowGeometry,
  resolveDeclaredWindowSize,
} from './windows.ts'

const SESSION = { token: 'tok-a', serverURL: 'https://harness.example.com' }

describe('parseDeclaredWindowGeometry', () => {
  it('accepts the three declared fields and clamps the ratio', () => {
    expect(parseDeclaredWindowGeometry({ ratio: 1.7778, width: 1400, height: 800 })).toEqual({ ratio: 1.7778, width: 1400, height: 800 })
    expect(parseDeclaredWindowGeometry({ ratio: 16 })).toEqual({ ratio: 4 })
    expect(parseDeclaredWindowGeometry({ ratio: 0.1 })).toEqual({ ratio: 0.25 })
  })

  it('drops a broken field instead of discarding the whole declaration', () => {
    // 声明了比例但尺寸写坏 ⇒ 比例仍然可用（逐字段独立解析）。
    expect(parseDeclaredWindowGeometry({ ratio: 2, width: '1280px', height: -5 })).toEqual({ ratio: 2 })
    expect(parseDeclaredWindowGeometry({ width: 1280 })).toEqual({ width: 1280 })
  })

  it('treats junk as "not declared" (never throws)', () => {
    for (const bad of [null, undefined, 42, 'window', [], {}, { ratio: '2' }, { ratio: Number.NaN }, { width: 1.5 }]) {
      expect(parseDeclaredWindowGeometry(bad), JSON.stringify(bad)).toBeNull()
    }
  })
})

describe('resolveDeclaredWindowSize（与 Go appcfg.ResolvedWindow 同判）', () => {
  it('falls back to 缺省 1280×720 when nothing is declared', () => {
    expect(resolveDeclaredWindowSize(null)).toEqual({ width: APP_WINDOW_DEFAULT_WIDTH, height: APP_WINDOW_DEFAULT_HEIGHT })
    expect(resolveDeclaredWindowSize({})).toEqual({ width: APP_WINDOW_DEFAULT_WIDTH, height: APP_WINDOW_DEFAULT_HEIGHT })
  })

  it('keeps explicit sizes when there is no ratio', () => {
    expect(resolveDeclaredWindowSize({ width: 900, height: 500 })).toEqual({ width: 900, height: 500 })
    expect(resolveDeclaredWindowSize({ width: 900 })).toEqual({ width: 900, height: APP_WINDOW_DEFAULT_HEIGHT })
    expect(resolveDeclaredWindowSize({ height: 500 })).toEqual({ width: APP_WINDOW_DEFAULT_WIDTH, height: 500 })
  })

  it('derives the missing side from the ratio (width is the anchor)', () => {
    // 只给 ratio ⇒ 以缺省宽度 1280 为锚（"16:9 ⇒ 1280×720"，appcfg 的原文例子）。
    expect(resolveDeclaredWindowSize({ ratio: 16 / 9 })).toEqual({ width: 1280, height: 720 })
    // 只给 height ⇒ 反推宽。
    expect(resolveDeclaredWindowSize({ ratio: 2, height: 600 })).toEqual({ width: 1200, height: 600 })
    // 两个都给了 ⇒ 以 width 为锚（高度被比例改写）—— 详情页显示的正是这个结果。
    expect(resolveDeclaredWindowSize({ ratio: 2, width: 1000, height: 999 })).toEqual({ width: 1000, height: 500 })
  })
})

describe('目录兜底来源（window-catalog）', () => {
  const catalog = (apps: unknown[]): Response => new Response(JSON.stringify({ apps }), { status: 200 })

  it('拉一次目录、按 app_id 取值，并带上 Bearer（不带 app-proof）', async () => {
    const calls: Array<{ url: string, init: RequestInit }> = []
    const source = createWindowCatalog({
      session: () => SESSION,
      fetch: async (url, init) => {
        calls.push({ url, init })
        return catalog([
          { app_id: 'my-notes', window: { width: 1400, height: 800, ratio: 1.75 } },
          { app_id: 'plain' },
        ])
      },
    })
    expect(await source.lookup('my-notes')).toEqual({ width: 1400, height: 800, ratio: 1.75 })
    expect(await source.lookup('plain')).toBeUndefined()
    // 第二个应用不再发请求：同一个会话只拉一次目录。
    expect(await source.lookup('missing-app')).toBeUndefined()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(`https://harness.example.com${APP_CATALOG_PATH}`)
    expect(calls[0]?.init.method).toBe('GET')
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe('Bearer tok-a')
    // 目录路由不要求持有性证明（proof 按 app_id 绑定，而目录是跨应用的读）。
    expect((calls[0]?.init.headers as Record<string, string>)['X-Pico-App-Proof']).toBeUndefined()
  })

  it('invalidate() 与会话变化后重新拉取', async () => {
    let session = SESSION
    const urls: string[] = []
    const source = createWindowCatalog({
      session: () => session,
      fetch: async (url) => {
        urls.push(url)
        return catalog([{ app_id: 'a', window: { ratio: 2 } }])
      },
    })
    await source.lookup('a')
    await source.lookup('a')
    expect(urls).toHaveLength(1)
    source.invalidate()
    await source.lookup('a')
    expect(urls).toHaveLength(2)
    // 换服务端地址 ⇒ 必须重拉（不得把上一台租户的目录用在新租户上）。
    session = { token: 'tok-a', serverURL: 'https://other.example.com' }
    await source.lookup('a')
    expect(urls).toHaveLength(3)
    expect(urls[2]).toBe(`https://other.example.com${APP_CATALOG_PATH}`)
  })

  it('未登录 / 失败 / 畸形响应一律 undefined 且绝不抛（打开动作不受影响）', async () => {
    const offline = createWindowCatalog({
      session: () => SESSION,
      fetch: async () => { throw new Error('network down') },
      warn: () => {},
    })
    await expect(offline.lookup('a')).resolves.toBeUndefined()

    const signedOut = createWindowCatalog({
      session: () => null,
      fetch: async () => { throw new Error('must not be called') },
      warn: () => {},
    })
    await expect(signedOut.lookup('a')).resolves.toBeUndefined()

    for (const body of ['not json', JSON.stringify({}), JSON.stringify({ apps: 'nope' }), JSON.stringify([{ app_id: 'a' }])]) {
      const source = createWindowCatalog({
        session: () => SESSION,
        fetch: async () => new Response(body, { status: 200 }),
        warn: () => {},
      })
      await expect(source.lookup('a')).resolves.toBeUndefined()
    }

    const denied = createWindowCatalog({
      session: () => SESSION,
      fetch: async () => new Response('{"error":"nope"}', { status: 401 }),
      warn: () => {},
    })
    await expect(denied.lookup('a')).resolves.toBeUndefined()
  })

  it('失败后按退避不再重试（目录不可达不得让每次打开都变成一次失败请求）', async () => {
    let now = 1_000
    let calls = 0
    const source = createWindowCatalog({
      session: () => SESSION,
      fetch: async () => { calls += 1; return new Response('boom', { status: 500 }) },
      warn: () => {},
      now: () => now,
    })
    await source.lookup('a')
    expect(calls).toBe(1)
    await source.lookup('a')
    expect(calls).toBe(1)
    now += CATALOG_RETRY_BACKOFF_MS
    // 退避过后允许重试（目录只是暂时不可达时不该永久放弃）。
    await source.lookup('a')
    expect(calls).toBe(2)
  })

  it('并发打开只拉一次（单飞）', async () => {
    let calls = 0
    const source = createWindowCatalog({
      session: () => SESSION,
      fetch: async () => {
        calls += 1
        await new Promise(resolve => { setTimeout(resolve, 5) })
        return new Response(JSON.stringify({ apps: [{ app_id: 'a', window: { ratio: 2 } }, { app_id: 'b' }] }), { status: 200 })
      },
    })
    const [a, b] = await Promise.all([source.lookup('a'), source.lookup('b')])
    expect(a).toEqual({ ratio: 2 })
    expect(b).toBeUndefined()
    expect(calls).toBe(1)
  })
})
