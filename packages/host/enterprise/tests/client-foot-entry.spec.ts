/**
 * 能力中心的底部入口（2026-09-21 并道改造）：从"自己注册一整行到
 * `sidebar.footer.action`"改成"往 `picoFootMenu` 登记一个条目"。
 *
 * 为什么跑**真 apply** 而不是只读源码：入口的 id/order/title/activate 都是在 apply
 * 里内联构造的，只有真跑一遍才拿得到；"面板还挂着"这条（改造不许丢行为）也要在同一
 * 轮里断言。apply 的头部几条 effect 会碰 DOM（渠道 CSS 变量 / 品牌样式表 / favicon），
 * 所以这里按本包既有先例（`tests/favicon.spec.ts` 的 `stubGlobal('document', …)`）给一个
 * **极简 DOM 替身**，不引入 jsdom 依赖。
 *
 * ---- 变异验证 ----
 *   - 删掉 `ctx.picoFootMenu.add(…)` ⇒「登记条目」红（界面上能力中心入口消失）；
 *   - `id` 改成 'capability-center'（旧槽位 id）⇒「id 是 PanelId」红；
 *   - `activate` 换成空函数 ⇒「activate 是面板装载器的开关」红；
 *   - 删掉 `mountCapabilityCenter()` 那条 effect ⇒「面板仍然挂载」红。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context as ClientContext } from '@deepseek-ai/cordis'

/** 一条 foot menu 条目（stub 登记表保存的形状）。 */
interface RegisteredFootEntry {
  id: string
  order: number
  title: () => string
  activate: () => void
}

interface Harness {
  ctx: ClientContext
  footEntries: RegisteredFootEntry[]
  disposers: Map<string, () => void>
  effects: string[]
  slots: string[]
  /** `ctx.inject` 的服务等待（每一组依赖一个条目）。 */
  serviceWaits: string[][]
}

/**
 * 记录型上下文替身；effect 立刻执行（本包的 effect 只注册服务/槽位，不挂 React 树）。
 * @param options - `footRowEnabled: false` 模拟"提供 picoFootMenu 的那一行被禁用"。
 */
function harness(options: { footRowEnabled?: boolean } = {}): Harness {
  const footEntries: RegisteredFootEntry[] = []
  const disposers = new Map<string, () => void>()
  const effects: string[] = []
  const slots: string[] = []
  const serviceWaits: string[][] = []
  const ctx = {
    effect: (callback: () => unknown, label?: string) => {
      effects.push(label ?? '')
      const dispose = callback()
      if (typeof dispose === 'function' && label !== undefined) disposers.set(label, dispose as () => void)
      return () => {}
    },
    // 服务等待：`picoFootMenu` 到位时子 fiber 立刻跑；禁用时不跑（条目消失，其余面貌照常）。
    inject: (deps: string[], run: (scope: ClientContext) => void) => {
      serviceWaits.push(deps)
      if (options.footRowEnabled !== false) run(ctx as unknown as ClientContext)
      return () => {}
    },
    on: () => () => {},
    get: () => undefined,
    locale: {
      register: () => () => {},
      getLocale: () => ({ active: 'zh' }),
      subscribe: () => () => {},
    },
    slots: {
      inject: (slot: string, run: () => unknown) => { slots.push(slot); run(); return () => {} },
      register: () => () => {},
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
  } as unknown as ClientContext
  return { ctx, footEntries, disposers, effects, slots, serviceWaits }
}

/** 极简 DOM 替身：只满足 apply 头部那几条品牌/favicon effect 的最低需要。 */
function stubDom(): void {
  const element = (): Record<string, unknown> => ({
    isConnected: true,
    textContent: '',
    setAttribute: () => {},
    appendChild: () => {},
    remove: () => {},
    style: {},
  })
  vi.stubGlobal('document', {
    // `document.title` 是文档标题归一化那条 effect 的读面（字符串）；其余成员只满足
    // 品牌样式表 / favicon / 面板装载器的最低需要。
    title: '',
    documentElement: { style: { setProperty: () => {} } },
    head: { appendChild: () => {} },
    body: {},
    createElement: element,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
    // 面板装载器在中列还不存在时只会观察，不会创建容器。
  })
  vi.stubGlobal('MutationObserver', class {
    observe(): void {}
    disconnect(): void {}
  })
}

beforeEach(() => {
  stubDom()
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

/**
 * 跑一遍真 apply。
 * @param options - `footRowEnabled: false` 模拟提供 `picoFootMenu` 的那一行被禁用。
 */
async function run(options: { footRowEnabled?: boolean } = {}): Promise<{ h: Harness, inject: string[], openCapabilityCenter: () => void }> {
  vi.resetModules()
  const mod = await import('../src/client/index.ts')
  const surface = await import('../src/client/capability-surface.tsx')
  const h = harness(options)
  mod.apply(h.ctx)
  return { h, inject: [...mod.inject], openCapabilityCenter: surface.openCapabilityCenter }
}

describe('能力中心：foot menu 条目', () => {
  it('不从硬 inject 等 picoFootMenu（它由可被禁用的一行提供），而是在子 fiber 里等', async () => {
    const { h, inject } = await run()
    // 硬 inject 的后果：那一行被渠道覆盖层 / `$DSH_HOME/cordis.patch.yml` 禁用时，
    // 整条 fiber 永久 pending（无报错），能力中心面板 + 渠道 CSS 变量 + 品牌 chrome
    // + favicon 一起消失（P1-7 教训）。
    expect(inject).not.toContain('picoFootMenu')
    expect(h.serviceWaits).toEqual([['picoFootMenu']])
  })

  it('foot 行被禁用 ⇒ 面板与品牌面照常（只有条目等不到）', async () => {
    const { h } = await run({ footRowEnabled: false })
    expect(h.footEntries).toEqual([])
    expect(h.effects).toContain('enterprise: client dictionaries')
    expect(h.effects).toContain('enterprise: desktop favicon')
    expect(h.effects).toContain('enterprise: capability center surface')
    expect(h.effects).not.toContain('enterprise: capability center foot menu entry')
  })

  it('登记 id/order/文案正确的条目，activate 就是面板装载器的开关', async () => {
    const { h, openCapabilityCenter } = await run()
    expect(h.footEntries).toHaveLength(1)
    const entry = h.footEntries[0]!
    // id 必须等于 panel-surface 的 PanelId（'capability'），否则「更多」行不会显示
    // 「更多 · 能力中心」。
    expect(entry.id).toBe('capability')
    expect(entry.order).toBe(-1)
    expect(entry.title()).toBe('能力中心')
    expect(entry.activate).toBe(openCapabilityCenter)
  })

  it('注销函数真的摘掉条目（插件卸载后浮层里不留孤儿行）', async () => {
    const { h } = await run()
    h.disposers.get('enterprise: capability center foot menu entry')?.()
    expect(h.footEntries).toEqual([])
  })

  it('不再往 sidebar.footer.action 注册任何东西（那一行现在归 dsh-foot-menu）', async () => {
    const { h } = await run()
    expect(h.slots).not.toContain('sidebar.footer.action')
  })

  it('面板仍然在插件启动时挂载（并道不许丢行为）', async () => {
    const { h } = await run()
    expect(h.effects).toContain('enterprise: capability center surface')
    expect(typeof h.disposers.get('enterprise: capability center surface')).toBe('function')
  })
})
