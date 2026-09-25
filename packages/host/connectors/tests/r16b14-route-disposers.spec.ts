/**
 * R16B-14（第十六轮审计泳道 B）:connectors 路由数组的 disposer 缺口。
 *
 * 缺陷形态：两条 `ctx.webServer.register` 写在**数组字面量**里，而 `register`
 * **不是 Cordis effect** —— Cordis 只在 effect 回调正常返回时收集返回的 disposer。
 * 第二条（prefix）抛错时，第一条（exact）已经注册进路由表，但它的 disposer 既没进
 * Cordis 的账、也没人调用 ⇒ 那条路由留在一个已卸载的世代上（重挂载后仍指着旧闭包）。
 *
 * 判据用**真实的 Cordis 语义**驱动（`Fiber#effect`：回调抛错 ⇒ 原样抛出、不收集任何
 * disposer），只是把 `webServer` 换成一个可以在第 N 次 register 抛错的替身：
 *
 *  1. 第二条注册抛错 ⇒ 第一条必须已被 dispose，**且错误必须继续向上抛**
 *     （吞掉就等于"插件加载成功但少一条路由"，没有任何信号）；
 *  2. 两条都成功 ⇒ effect 返回的 disposer 必须把两条都 dispose（语义不退化）。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { apply } from '../src/index.ts'

interface FakeCordis {
  ctx: Context
  /** Routes the fake webServer accepted (i.e. handed back a disposer for). */
  readonly registered: string[]
  /** Routes whose disposer was actually called. */
  readonly disposed: string[]
  /** Disposers Cordis collected from the plugin's effects. */
  readonly collected: Array<() => void>
}

/**
 * A context whose `effect` mirrors `@deepseek-ai/cordis`'s observable contract:
 * the disposer is collected ONLY when the callback returns normally, and a
 * throwing callback propagates to the caller (`Fiber#_execute` → `composeError`).
 *
 * @param failOn - 1-based register call number that throws.
 */
function fakeCordis(failOn: number): FakeCordis {
  const registered: string[] = []
  const disposed: string[] = []
  const collected: Array<() => void> = []
  let calls = 0
  const ctx = {
    get: () => undefined,
    on: () => () => {},
    emit: () => {},
    plugin: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    effect: (register: () => (() => void) | undefined) => {
      const dispose = register()
      if (typeof dispose === 'function') collected.push(dispose)
      return () => {}
    },
    webServer: {
      register: (route: WebRoute) => {
        calls += 1
        if (calls === failOn) throw new Error(`register refused: ${route.kind} ${route.path}`)
        registered.push(`${route.kind} ${route.path}`)
        const label = `${route.kind} ${route.path}`
        return () => { disposed.push(label) }
      },
    },
  } as unknown as Context
  return { ctx, registered, disposed, collected }
}

describe('R16B-14: a failed second route registration must not orphan the first route\'s disposer', () => {
  it('rolls the already-registered route back and still lets Cordis see the error', () => {
    const fake = fakeCordis(2)
    expect(
      () => apply(fake.ctx, { connectors: [], refreshSweepIntervalMs: 0 }),
      '注册失败必须抛出去（插件不能"看起来加载成功"却少一条路由）',
    ).toThrow('register refused: prefix /api/pico/connectors')

    expect(fake.registered).toEqual(['exact /api/pico/connectors'])
    expect(
      fake.disposed,
      '第二条注册抛错时，第一条（exact）的 disposer 必须被调用（否则路由留在已卸载的世代上）',
    ).toEqual(['exact /api/pico/connectors'])
    // 与真实 Cordis 同形：回调抛错 ⇒ 这个 effect 的 disposer **没有**被收集
    // （前面两个 effect 的 disposer 是各自正常返回时收集的，与本次失败无关）。
    // 判据 = 把 Cordis 手上的 disposer 全部跑一遍，也不会有人去动那条路由。
    const already = fake.disposed.length
    for (const dispose of fake.collected) dispose()
    expect(
      fake.disposed.slice(already),
      '路由 effect 抛错时 Cordis 收集不到它的 disposer（上面那条回滚是唯一的清理路径）',
    ).toEqual([])
  })

  it('hands a disposer to Cordis only once EVERY route is registered, and it disposes them all', () => {
    const fake = fakeCordis(Number.POSITIVE_INFINITY)
    apply(fake.ctx, { connectors: [], refreshSweepIntervalMs: 0 })

    expect(fake.registered).toEqual([
      'exact /api/pico/connectors',
      'prefix /api/pico/connectors',
    ])
    expect(fake.disposed).toEqual([])

    const routes = fake.collected.at(-1)
    expect(routes, '两条都注册成功时 effect 必须把 disposer 交给 Cordis').toBeTypeOf('function')
    routes?.()
    expect(fake.disposed.sort()).toEqual([
      'exact /api/pico/connectors',
      'prefix /api/pico/connectors',
    ])
  })
})
