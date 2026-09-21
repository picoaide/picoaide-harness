/**
 * 浏览器客户端半边的装配契约：条目登记进 `picoFootMenu`，"AI 在等你"仍然是
 * 条目的 attention + 文案（并道之后底部唯一的一行「更多」由
 * `@picoaide/dsh-foot-menu` 拥有）。
 *
 * ---- 变异验证 ----
 *   - 把 `ctx.picoFootMenu.add(…)` 删掉 ⇒「登记条目」红（界面上浏览器入口消失）；
 *   - `id` 改成 panel-surface 的某个 PanelId（例如把浏览器写成 'browser' 之外的 id）
 *     ⇒「id 不是 PanelId」红（否则「更多」行会谎称浏览器面板是当前面板）；
 *   - 去掉 `attention` 或让它恒 false ⇒「等待时 attention 为真」红（2026-09-16 用户闸
 *     事故的回归点：窗口外的可见提示不能丢）；
 *   - 把 `activate` 里的 POST 换掉 ⇒「activate 打写面路由」红。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { CONTROL_POLL_MS } from '../src/client/control-hint.ts'

/** 一条 foot menu 条目（stub 登记表保存的形状）。 */
interface RegisteredFootEntry {
  id: string
  order: number
  title: () => string
  activate: () => void
  attention?: (() => boolean) | undefined
}

interface Fixture {
  ctx: ClientContext
  footEntries: RegisteredFootEntry[]
  disposers: Map<string, () => void>
  effects: Array<string | undefined>
  locales: string[]
  /** `ctx.inject` 的服务等待（每一组依赖一个条目）。 */
  serviceWaits: string[][]
}

/**
 * 记录型上下文替身；effect 立刻执行（该插件没有挂 React 树的 effect）。
 * @param active - 语言服务报告的当前语言。
 * @param options - `footRowEnabled: false` 模拟"提供 picoFootMenu 的那一行被禁用"。
 * @returns 记录面。
 */
function fixture(active = 'zh', options: { footRowEnabled?: boolean } = {}): Fixture {
  const footEntries: RegisteredFootEntry[] = []
  const disposers = new Map<string, () => void>()
  const effects: Array<string | undefined> = []
  const locales: string[] = []
  const serviceWaits: string[][] = []
  const ctx = {
    effect: (callback: () => unknown, label?: string) => {
      effects.push(label)
      const dispose = callback()
      if (typeof dispose === 'function' && label !== undefined) disposers.set(label, dispose as () => void)
      return () => {}
    },
    // 服务等待：`picoFootMenu` 到位时子 fiber 立刻跑；禁用时不跑（条目消失，
    // "唤起浏览器窗口"与"AI 在等你"提示是它的消费者，所以那两个面本来就依附于条目）。
    inject: (deps: string[], run: (scope: ClientContext) => void) => {
      serviceWaits.push(deps)
      if (options.footRowEnabled !== false) run(ctx as unknown as ClientContext)
      return () => {}
    },
    locale: {
      register: (namespace: string) => { locales.push(namespace); return () => {} },
      getLocale: () => ({ active }),
      subscribe: () => () => {},
    },
    picoFootMenu: {
      add: (entry: RegisteredFootEntry) => {
        footEntries.push(entry)
        return () => {
          const index = footEntries.indexOf(entry)
          if (index !== -1) footEntries.splice(index, 1)
        }
      },
      touch: () => {},
      snapshot: () => [...footEntries],
      subscribe: () => () => {},
    },
    get: () => undefined,
  } as unknown as ClientContext
  return { ctx, footEntries, disposers, effects, locales, serviceWaits }
}

/** 每条用例都用一份全新的模块图（store 与语言都是模块级状态）。 */
async function freshPlugin(): Promise<{ apply: (ctx: ClientContext) => void, inject: string[] }> {
  vi.resetModules()
  const mod = await import('../src/client/index.ts')
  return { apply: mod.apply, inject: [...mod.inject] }
}

/** 让 store 的首轮读取跑完。 */
async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('浏览器客户端半边：foot menu 条目', () => {
  it('不从硬 inject 等 picoFootMenu（它由可被禁用的一行提供），而是在子 fiber 里等', async () => {
    const { inject } = await freshPlugin()
    // 硬 inject 的后果：那一行被渠道覆盖层 / `$DSH_HOME/cordis.patch.yml` 禁用时，
    // 整条 fiber 永久 pending（无报错），控制权轮询也一起不启动（P1-7 教训）。
    expect(inject).not.toContain('picoFootMenu')
    expect(inject).toContain('locale')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
    const f = fixture()
    const { apply } = await freshPlugin()
    apply(f.ctx)
    await settle()
    expect(f.serviceWaits).toEqual([['picoFootMenu']])
  })

  it('foot 行被禁用 ⇒ 控制权轮询照常跑（只有条目等不到）', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const f = fixture('zh', { footRowEnabled: false })
    const { apply } = await freshPlugin()
    apply(f.ctx)
    await settle()
    expect(f.footEntries).toEqual([])
    // 轮询在**外层** effect 里，与条目是否登记无关。
    expect(f.effects).toContain('browser: control hint store')
    expect(fetchMock).toHaveBeenCalledWith('/api/pico/browser/state')
    f.disposers.get('browser: control hint store')?.()
  })

  it('登记 id/order/文案正确的条目，并注册浏览器字典', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
    const f = fixture()
    const { apply } = await freshPlugin()
    apply(f.ctx)
    await settle()
    expect(f.locales).toEqual(['browser'])
    expect(f.footEntries).toHaveLength(1)
    const entry = f.footEntries[0]!
    expect(entry.id).toBe('browser')
    expect(entry.order).toBe(1)
    expect(entry.title()).toBe('浏览器')
    expect(entry.attention?.()).toBe(false)
  })

  it('id 不占任何中列面板的 PanelId（浏览器在独立窗口，「更多」行不许谎称它是当前面板）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
    const f = fixture()
    const { apply } = await freshPlugin()
    apply(f.ctx)
    await settle()
    // 本仓四个中列面板的 PanelId（panel-surface 协议）。浏览器的条目 id 若撞上其中
    // 任何一个，「更多」行就会在浏览器窗口活着的时候显示「更多 · 某面板」。
    const PANEL_IDS = ['cron', 'capability', 'connectors', 'apps']
    expect(PANEL_IDS).not.toContain(f.footEntries[0]!.id)
    expect(f.footEntries[0]!.id).toBe('browser')
  })

  it('宿主报告"AI 被挡住"时：attention 为真、文案换成等待短句', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ controlled: true, awaitingRelease: true }), { status: 200 })))
    const f = fixture()
    const { apply } = await freshPlugin()
    apply(f.ctx)
    await settle()
    const entry = f.footEntries[0]!
    expect(entry.attention?.()).toBe(true)
    expect(entry.title()).toBe('AI 等待交还')
  })

  it('attentionTitle 给出**可操作**的那句话（用户不是只看到一个圆点）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ controlled: true, awaitingRelease: true }), { status: 200 })))
    const f = fixture()
    const { apply } = await freshPlugin()
    apply(f.ctx)
    await settle()
    const title = f.footEntries[0]!.attentionTitle?.()
    // 并道时这句曾随整行一起被删掉，用户只剩"琥珀色圆点 + 短标签"（2026-09-21 对抗
    // 审计 P2）。判据是"说清了下一步点哪里"，不是"有一句非空文案"。
    expect(typeof title).toBe('string')
    expect(title).toContain('交给 AI')
    expect(title).toContain('浏览器窗口')
  })

  it('en 下文案是 Browser / AI waiting（含可操作的警示句）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ controlled: true, awaitingRelease: true }), { status: 200 })))
    const f = fixture('en')
    const { apply } = await freshPlugin()
    apply(f.ctx)
    await settle()
    expect(f.footEntries[0]!.title()).toBe('AI waiting')
    expect(f.footEntries[0]!.attentionTitle?.()).toContain('Hand back to AI')
    expect(f.disposers.has('browser: control hint store')).toBe(true)
  })

  it('activate 打写面路由（POST /api/pico/browser/show）', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const f = fixture()
    const { apply } = await freshPlugin()
    apply(f.ctx)
    await settle()
    f.footEntries[0]!.activate()
    await settle()
    expect(fetchMock.mock.calls.some(([url, init]) => url === '/api/pico/browser/show' && (init as RequestInit | undefined)?.method === 'POST')).toBe(true)
  })

  it('写面被拒时留痕（控制台 warn），不静默吞掉', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => (String(input) === '/api/pico/browser/show'
      ? new Response('no', { status: 403 })
      : new Response('{}', { status: 200 })))
    vi.stubGlobal('fetch', fetchMock)
    const f = fixture()
    const { apply } = await freshPlugin()
    apply(f.ctx)
    await settle()
    f.footEntries[0]!.activate()
    await settle()
    expect(warn).toHaveBeenCalledWith('[pico-browser] show rejected', 403)
    warn.mockRestore()
  })

  it('插件卸载：条目被摘掉，且轮询**真的停了**（不是"disposer 存在"就算过）', async () => {
    // 对抗审计 P2：这条原先只断言 `disposers.get('browser: control hint store')` 有值 ——
    // 把 `controlHint.dispose()` 从 effect 里删掉，mutant 照样绿。判据必须是行为：
    // 卸载后再放过三个轮询周期，fetch 次数不许再涨。
    vi.useFakeTimers()
    try {
      const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)
      const f = fixture()
      const { apply } = await freshPlugin()
      apply(f.ctx)
      await vi.advanceTimersByTimeAsync(0)
      const afterStart = fetchMock.mock.calls.length
      expect(afterStart).toBeGreaterThan(0)
      f.disposers.get('browser: foot menu entry')?.()
      expect(f.footEntries).toEqual([])
      f.disposers.get('browser: control hint store')?.()
      await vi.advanceTimersByTimeAsync(CONTROL_POLL_MS * 3)
      expect(fetchMock.mock.calls.length).toBe(afterStart)
    } finally {
      vi.useRealTimers()
    }
  })
})
