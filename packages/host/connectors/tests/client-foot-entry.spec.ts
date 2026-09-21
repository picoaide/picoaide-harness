/**
 * 连接器中心的底部入口（2026-09-21 并道改造）：从"自己注册一整行到
 * `sidebar.footer.action`"改成"往 `picoFootMenu` 登记一个条目"。
 *
 * 跑**真 apply**：条目是在 apply 里内联构造的，只有真跑一遍才拿得到 id/order/title/
 * activate；同时验证"面板仍然挂载"与"每个已连接连接器的斜杠命令还在"（不许丢行为）。
 * 本包的 client `apply` 不碰 DOM（面板装载器在没有 `document` 的环境里是 no-op），
 * 因此这份用例是纯 node 环境。
 *
 * ---- 变异验证 ----
 *   - 删掉 `ctx.picoFootMenu.add(…)` ⇒「登记条目」红；
 *   - `id` 改成 'connector-center'（旧槽位 id）⇒「id 是 PanelId」红；
 *   - `activate` 换成空函数 ⇒「activate 是面板装载器的开关」红；
 *   - 删掉 `mountConnectorCenter()` 那条 effect ⇒「面板仍然挂载」红。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
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
  commands: string[]
  /** `ctx.inject` 的服务等待（每一组依赖一个条目）。 */
  serviceWaits: string[][]
}

/**
 * 记录型上下文替身；effect 立刻执行。
 * @param options - `footRowEnabled: false` 模拟"提供 picoFootMenu 的那一行被禁用"。
 */
function harness(options: { footRowEnabled?: boolean } = {}): Harness {
  const footEntries: RegisteredFootEntry[] = []
  const disposers = new Map<string, () => void>()
  const effects: string[] = []
  const slots: string[] = []
  const commands: string[] = []
  const serviceWaits: string[][] = []
  const ctx = {
    effect: (callback: () => unknown, label?: string) => {
      effects.push(label ?? '')
      const dispose = callback()
      if (typeof dispose === 'function' && label !== undefined) disposers.set(label, dispose as () => void)
      return () => {}
    },
    // 服务的等待：`picoFootMenu` 到位时子 fiber 立刻跑起来；禁用时不跑（条目消失，
    // 但 apply 的其余面貌照常 —— 这正是子 fiber 存在的理由）。
    inject: (deps: string[], run: (scope: ClientContext) => void) => {
      serviceWaits.push(deps)
      if (options.footRowEnabled !== false) run(ctx as unknown as ClientContext)
      return () => {}
    },
    get: (name: string) => (name === 'commandUi'
      ? { register: (definition: { name: string }) => { commands.push(definition.name); return () => {} } }
      : undefined),
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
  return { ctx, footEntries, disposers, effects, slots, commands, serviceWaits }
}

/**
 * 跑一遍真 apply。
 * @param options - `footRowEnabled: false` 模拟提供 `picoFootMenu` 的那一行被禁用。
 */
async function run(options: { footRowEnabled?: boolean } = {}): Promise<{ h: Harness, inject: string[], openConnectorCenter: () => void }> {
  vi.resetModules()
  const mod = await import('../src/client/index.ts')
  const surface = await import('../src/client/connector-surface.tsx')
  const h = harness(options)
  mod.apply(h.ctx)
  return { h, inject: [...mod.inject], openConnectorCenter: surface.openConnectorCenter }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('连接器：foot menu 条目', () => {
  it('不从硬 inject 等 picoFootMenu（它由可被禁用的一行提供），而是在子 fiber 里等', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ connectors: [] }), { status: 200 })))
    const { h, inject } = await run()
    // 硬 inject 的后果：那一行被渠道覆盖层 / `$DSH_HOME/cordis.patch.yml` 禁用时，
    // 整条 fiber 永久 pending（无报错），连接器面板与斜杠命令一起消失（P1-7 教训）。
    expect(inject).not.toContain('picoFootMenu')
    expect(h.serviceWaits).toEqual([['picoFootMenu']])
  })

  it('foot 行被禁用 ⇒ 面板与斜杠命令照常（只有条目等不到）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      connectors: [{ id: 'crm', name: 'CRM', status: 'connected', examples: ['查一下今天的商机'] }],
    }), { status: 200 })))
    const { h } = await run({ footRowEnabled: false })
    expect(h.footEntries).toEqual([])
    expect(h.effects).toContain('connectors: connector center surface')
    for (let index = 0; index < 12 && h.commands.length === 0; index += 1) await Promise.resolve()
    expect(h.commands).toEqual(['crm'])
    h.disposers.get('pico-connectors-client: per-connector slash commands')?.()
    h.disposers.get('connectors: connector center surface')?.()
  })

  it('登记 id/order/文案正确的条目，activate 就是面板装载器的开关', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ connectors: [] }), { status: 200 })))
    const { h, openConnectorCenter } = await run()
    expect(h.footEntries).toHaveLength(1)
    const entry = h.footEntries[0]!
    // id 必须等于 panel-surface 的 PanelId（'connectors'），否则「更多」行不会显示
    // 「更多 · 连接器」。
    expect(entry.id).toBe('connectors')
    expect(entry.order).toBe(0)
    expect(entry.title()).toBe('连接器')
    expect(entry.activate).toBe(openConnectorCenter)
  })

  it('注销函数真的摘掉条目（插件卸载后浮层里不留孤儿行）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ connectors: [] }), { status: 200 })))
    const { h } = await run()
    h.disposers.get('connectors: foot menu entry')?.()
    expect(h.footEntries).toEqual([])
  })

  it('不再往 sidebar.footer.action 注册任何东西（那一行现在归 dsh-foot-menu）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ connectors: [] }), { status: 200 })))
    const { h } = await run()
    expect(h.slots).not.toContain('sidebar.footer.action')
  })

  it('面板仍然在插件启动时挂载，已连接连接器的斜杠命令仍然注册', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      connectors: [
        { id: 'crm', name: 'CRM', status: 'connected', examples: ['查一下今天的商机'] },
        { id: 'wiki', name: 'Wiki', status: 'disconnected', examples: [] },
      ],
    }), { status: 200 })))
    const { h } = await run()
    expect(h.effects).toContain('connectors: connector center surface')
    // 命令注册是异步轮询里的动作：等它落地。
    for (let index = 0; index < 12 && h.commands.length === 0; index += 1) await Promise.resolve()
    expect(h.commands).toEqual(['crm'])
    // 卸载不留定时器（轮询 effect 的 disposer）。
    h.disposers.get('pico-connectors-client: per-connector slash commands')?.()
    h.disposers.get('connectors: connector center surface')?.()
  })
})
