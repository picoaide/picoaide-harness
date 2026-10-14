/**
 * 能力中心客户端插件（本包）的接线判据。
 *
 * 2026-10-13：本文件由 `@picoaide/dsh-enterprise` 的 `tests/client-foot-entry.spec.ts`
 * **搬过来并改写**（能力中心的客户端面整包搬出）。搬过来的三条断言一条不少：
 *   - 「不从硬 inject 等 picoFootMenu，而是在子 fiber 里等」；
 *   - 「foot 行被禁用 ⇒ 面板与其余面照常（只有条目等不到）」；
 *   - 「登记 id/order/文案正确的条目，activate 就是面板装载器的开关」；
 *   - 「注销函数真的摘掉条目」「不再往 sidebar.footer.action 注册任何东西」
 *     「面板仍然在插件启动时挂载」。
 * 企业包那一侧改成对称的反向断言（那边的 `tests/client-apply.spec.ts` 断言它
 * **不再**登记本条目、也**不再**挂载本面板），两条合起来钉住"搬走了、且没搬坏"。
 *
 * 为什么跑**真 apply** 而不是只读源码：入口的 id/order/title/activate 都是在 apply
 * 里内联构造的，只有真跑一遍才拿得到；"面板还挂着"这条也要在同一轮里断言。
 * apply 会碰 DOM（面板装载器 / 技能卡样式表），所以这里按 enterprise 的既有先例给一个
 * **极简 DOM 替身**，不引入 jsdom 依赖。
 *
 * ---- 变异验证 ----
 *   - 删掉 `ctx.picoFootMenu.add(…)` ⇒「登记条目」红（界面上能力中心入口消失）；
 *   - `id` 改成 'capability-center'（旧槽位 id）⇒「id 是 PanelId」红；
 *   - `activate` 换成空函数 ⇒「activate 是面板装载器的开关」红；
 *   - 删掉 `mountCapabilityCenter()` 那条 effect ⇒「面板仍然挂载」红；
 *   - 把 `picoFootMenu` 写进硬 `inject` ⇒「容器被禁用时整条 fiber 还在等」红；
 *   - 删掉技能卡样式表那条 effect ⇒「卡片样式随面板一起注入」红。
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
  /** `ctx.locale.register` 的调用记录（命名空间 + 字典键数）。 */
  dictionaries: { namespace: string, keys: number }[]
  /** `document.head.appendChild` 收到的样式表元素。 */
  styles: string[]
}

/**
 * 记录型上下文替身；effect 立刻执行（本包的 effect 只注册服务/槽位/样式表，不挂 React 树）。
 * @param options - `footRowEnabled: false` 模拟"提供 picoFootMenu 的那一行被禁用"。
 */
function harness(options: { footRowEnabled?: boolean } = {}): Harness {
  const footEntries: RegisteredFootEntry[] = []
  const disposers = new Map<string, () => void>()
  const effects: string[] = []
  const slots: string[] = []
  const serviceWaits: string[][] = []
  const dictionaries: { namespace: string, keys: number }[] = []
  const styles: string[] = []
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
      register: (namespace: string, dictionary: { zh: Record<string, string> }) => {
        dictionaries.push({ namespace, keys: Object.keys(dictionary.zh).length })
        return () => {}
      },
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
  return { ctx, footEntries, disposers, effects, slots, serviceWaits, dictionaries, styles }
}

/** 极简 DOM 替身：只满足面板装载器与技能卡样式表的最低需要。 */
function stubDom(h: { styles: string[] }): void {
  const element = (): Record<string, unknown> => ({
    isConnected: true,
    textContent: '',
    setAttribute: () => {},
    appendChild: () => {},
    remove: () => {},
    style: {},
  })
  const head = {
    appendChild: (node: { textContent: string }) => { h.styles.push(node.textContent) },
  }
  vi.stubGlobal('document', {
    title: '',
    documentElement: { style: { setProperty: () => {} }, setAttribute: () => {}, getAttribute: () => null },
    head,
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

let current: Harness

beforeEach(() => {
  current = harness()
  stubDom(current)
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
async function run(options: { footRowEnabled?: boolean } = {}): Promise<{ h: Harness, inject: readonly string[], openCapabilityCenter: () => void }> {
  vi.resetModules()
  const mod = await import('../src/client/index.ts')
  const surface = await import('../src/client/capability-surface.tsx')
  current = harness(options)
  stubDom(current)
  mod.apply(current.ctx)
  return { h: current, inject: [...mod.inject], openCapabilityCenter: surface.openCapabilityCenter }
}

describe('能力中心：客户端插件接线', () => {
  it('不从硬 inject 等 picoFootMenu（它由可被禁用的一行提供），而是在子 fiber 里等', async () => {
    const { h, inject } = await run()
    // 硬 inject 的后果：那一行被渠道覆盖层 / `$DSH_HOME/cordis.patch.yml` 禁用时，
    // 整条 fiber 永久 pending（无报错），能力中心面板一起消失（P1-7 教训）。
    expect(inject).not.toContain('picoFootMenu')
    expect(h.serviceWaits).toEqual([['picoFootMenu']])
  })

  it('foot 行被禁用 ⇒ 面板与样式照常（只有条目等不到）', async () => {
    const { h } = await run({ footRowEnabled: false })
    expect(h.footEntries).toEqual([])
    expect(h.effects).toContain('capability-center: client dictionaries')
    expect(h.effects).toContain('capability-center: capability center surface')
    expect(h.effects).not.toContain('capability-center: capability center foot menu entry')
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
    h.disposers.get('capability-center: capability center foot menu entry')?.()
    expect(h.footEntries).toEqual([])
  })

  it('不往 sidebar.footer.action 注册任何东西（那一行归 dsh-foot-menu）', async () => {
    const { h } = await run()
    expect(h.slots).not.toContain('sidebar.footer.action')
  })

  it('面板仍然在插件启动时挂载（并道与搬迁都不许丢行为）', async () => {
    const { h } = await run()
    expect(h.effects).toContain('capability-center: capability center surface')
    expect(typeof h.disposers.get('capability-center: capability center surface')).toBe('function')
  })

  it('技能卡样式随面板注入（搬出前它住在企业包的品牌样式表里）', async () => {
    const { h } = await run()
    expect(h.effects).toContain('capability-center: skill card style')
    // 装载器自己也往 head 里注入一份面板容器样式（`data-dsh-panel-style`），所以这里按
    // **内容**收敛到技能卡那一条，而不是数 head 里的元素个数。
    const cardStyles = h.styles.filter(css => css.includes('.pico-skill-card'))
    // 恰好一份：重复注入说明样式表被装了两次（企业包那份已被反向判据钉住不存在）。
    expect(cardStyles).toHaveLength(1)
    // 三条规则逐条在场（选择器与声明与搬出前一字未改）。
    const css = cardStyles[0]!
    expect(css).toContain('.pico-skill-card {')
    expect(css).toContain('.pico-skill-card:hover {')
    expect(css).toContain('.pico-skill-card:focus-within {')
    expect(css).toContain('border-color: var(--dsw-alias-brand-primary) !important;')
    expect(css).toContain('outline: 2px solid var(--dsw-alias-brand-primary);')
  })

  it('字典注册在 capability 命名空间下，键数与搬出前一致', async () => {
    const { h } = await run()
    expect(h.dictionaries).toEqual([{ namespace: 'capability', keys: 75 }])
  })
})
