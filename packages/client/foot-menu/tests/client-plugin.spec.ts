// @vitest-environment jsdom
/**
 * 客户端半边的装配契约：`apply(ctx)` 到底注册/提供了什么。
 *
 * 这是"底部那一行真的存在、条目真的有地方登记"的**第一层**证据：这里没把
 * `sidebar.footer.action` 的唯一占用者注册上、或者没 provide `picoFootMenu`，
 * 后面所有组件用例都可能全绿而产品里什么都没有（"存在性断言=假绿"的同族形态）。
 *
 * ---- 变异验证 ----
 *   - 删掉 `ctx.provide(FOOT_MENU_SERVICE, …)` ⇒「提供登记表服务」红（五个插件的条目会全部丢失）；
 *   - 把占用者的 id/order 改掉 ⇒「唯一占用者」红；
 *   - hover 样式的 effect 不返回 disposer ⇒「卸载时移除 style」红；
 *   - 登记表 effect 不返回 installFootMenu 的注销函数 ⇒「插件卸载后单例清干净」红。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { apply, inject, name } from '../src/client/index.ts'
import { currentFootMenuService } from '../src/client/contract.ts'
import { FootMenuRow } from '../src/client/FootMenuRow.tsx'
import { en, zh } from '../src/client/locales.ts'

interface Registered {
  name: string
  id?: string
  order?: number
}

interface Fixture {
  ctx: ClientContext
  effects: Array<string | undefined>
  disposers: Map<string, () => void>
  provided: Array<{ key: string, value: unknown }>
  slots: string[]
  registered: Registered[]
  components: unknown[]
  locales: Array<{ namespace: string, dictionaries: { zh: unknown, en: unknown } }>
}

/** 记录型上下文替身（effect 立刻执行，这正是 apply 里的"注册即 effect"约定）。 */
function fixture(): Fixture {
  const effects: Array<string | undefined> = []
  const disposers = new Map<string, () => void>()
  const provided: Fixture['provided'] = []
  const slots: string[] = []
  const registered: Registered[] = []
  const components: unknown[] = []
  const locales: Fixture['locales'] = []
  const ctx = {
    effect: (callback: () => unknown, label?: string) => {
      effects.push(label)
      const dispose = callback()
      if (typeof dispose === 'function') cleanups.push(dispose as () => void)
      if (typeof dispose === 'function' && label !== undefined) disposers.set(label, dispose as () => void)
      return () => {}
    },
    provide: (key: string, value: unknown) => { provided.push({ key, value }) },
    locale: {
      register: (namespace: string, dictionaries: { zh: unknown, en: unknown }) => {
        locales.push({ namespace, dictionaries })
        return () => {}
      },
      getLocale: () => ({ active: 'zh' }),
      subscribe: () => () => {},
    },
    slots: {
      inject: (slot: string, run: () => unknown) => { slots.push(slot); run(); return () => {} },
      register: (registration: Registered, component: unknown) => {
        registered.push(registration)
        components.push(component)
        return () => {}
      },
    },
  } as unknown as ClientContext
  return { ctx, effects, disposers, provided, slots, registered, components, locales }
}

/**
 * 本条用例安装过的东西（apply 里每个 effect 返回的 disposer）。
 *
 * `apply` 会把登记表装进**模块单例**（进程级状态），用例之间必须真的跑一遍注销函数
 * 才算复位 —— 2026-09-21 对抗审计 P2：此前这里调的是 `entry.activate()`，与注释说的
 * "清掉单例"完全不是一件事（单例仍指向上一轮的登记表，串味照样发生）。
 */
const cleanups: Array<() => void> = []

beforeEach(() => {
  // 同一文件里每条用例都跑一遍 apply：先清掉上一条注入的样式表，断言才有意义。
  for (const element of document.head.querySelectorAll('style')) element.remove()
})

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
  expect(currentFootMenuService(), '用例结束时登记表单例必须已清空').toBeUndefined()
})

describe('客户端半边：apply 注册面', () => {
  it('声明插件名与服务依赖', () => {
    expect(name).toBe('picoaide-foot-menu-client')
    expect(inject).toEqual(['slots', 'locale'])
  })

  it('提供 picoFootMenu 服务，且它就是行组件要读的那份登记表', () => {
    const f = fixture()
    apply(f.ctx)
    expect(f.provided.map(item => item.key)).toEqual(['picoFootMenu'])
    const service = f.provided[0]?.value as { add: (entry: unknown) => () => void, snapshot: () => unknown[] }
    expect(typeof service.add).toBe('function')
    expect(service.snapshot()).toEqual([])
    // 行组件渲染时读的是同一个实例（`installFootMenu` 把两件事绑在一起）。
    expect(currentFootMenuService()).toBe(service)
  })

  it('登记表可用：登记后快照里就有（服务与模块单例是同一份）', () => {
    const f = fixture()
    apply(f.ctx)
    const service = currentFootMenuService()
    expect(service).toBeDefined()
    service!.add({ id: 'cron', order: -10, title: () => '定时任务', activate: () => undefined })
    expect(service!.snapshot().map(entry => entry.id)).toEqual(['cron'])
    expect((f.provided[0]?.value as { snapshot: () => unknown[] }).snapshot()).toHaveLength(1)
  })

  it('注册唯一一个底部座位占用者：id/order 固定，组件是「更多」行', () => {
    const f = fixture()
    apply(f.ctx)
    expect(f.slots).toEqual(['sidebar.footer.action'])
    expect(f.registered).toEqual([expect.objectContaining({ name: 'sidebar.footer.action', id: 'pico-foot-menu', order: 10 })])
    expect(f.components).toEqual([FootMenuRow])
  })

  it('注册 zh/en 双语文案（zh 是 key 源）', () => {
    const f = fixture()
    apply(f.ctx)
    const entry = f.locales.find(item => item.namespace === 'foot-menu')
    expect(entry, '未注册 foot-menu 字典').toBeDefined()
    expect(entry!.dictionaries.zh).toBe(zh)
    expect(entry!.dictionaries.en).toBe(en)
  })

  it('注入 hover/focus 样式（含透明底），并在卸载时移除 style 标签', () => {
    const f = fixture()
    apply(f.ctx)
    const styles = [...document.querySelectorAll('style')].filter(element => element.textContent?.includes('.pico-foot-menu-trigger'))
    expect(styles).toHaveLength(1)
    const css = styles[0]!.textContent ?? ''
    // 透明底与 hover 底必须在同一张表里：行内 `background` 会压死 `:hover`。
    expect(css).toContain('.pico-foot-menu-trigger { background: transparent; }')
    expect(css).toContain('.pico-foot-menu-trigger:hover { background: var(--dsw-alias-interactive-bg-hover); }')
    expect(css).toContain('.pico-foot-menu-item { background: transparent; }')
    expect(css).toContain('.pico-foot-menu-item:hover, .pico-foot-menu-item:focus-visible { background: var(--dsw-alias-interactive-bg-hover); }')
    f.disposers.get('foot-menu: hover styles')?.()
    expect([...document.querySelectorAll('style')].filter(element => element.textContent?.includes('.pico-foot-menu-trigger'))).toHaveLength(0)
  })

  it('插件卸载后登记表单例被清掉（不再有"半挂"的行）', () => {
    const f = fixture()
    apply(f.ctx)
    expect(currentFootMenuService()).toBeDefined()
    f.disposers.get('foot-menu: menu registry')?.()
    expect(currentFootMenuService()).toBeUndefined()
  })

  it('provide 抛错时不留下半挂的模块单例（先 provide、再落地单例）', () => {
    // `ctx.provide` 是会抛的（服务名已被别的 fiber 占用 / 上下文已失效）。反过来做
    // （先装单例、再 provide）会留下"服务不存在、组件却拿着它渲染"的半挂状态 ——
    // 2026-09-21 对抗审计 P2。这条用例把顺序钉住：抛错之后单例必须是空的。
    const f = fixture()
    const taken = (f.ctx as unknown as { provide: () => void })
    taken.provide = () => { throw new Error('service already provided') }
    expect(() => apply(f.ctx)).toThrow('service already provided')
    expect(currentFootMenuService()).toBeUndefined()
  })

  it('注销只清掉"自己那份"单例（后来者的实例不许被误清）', () => {
    const first = fixture()
    apply(first.ctx)
    const firstService = currentFootMenuService()
    expect(firstService).toBeDefined()
    // 第二次安装（插件重载 / 第二个实例）覆盖单例：此时跑第一份的注销函数不能把
    // 第二份清掉 —— 那会让界面上的行拿着 undefined 渲染。
    const second = fixture()
    apply(second.ctx)
    const secondService = currentFootMenuService()
    expect(secondService).toBeDefined()
    expect(secondService).not.toBe(firstService)
    first.disposers.get('foot-menu: menu registry')?.()
    expect(currentFootMenuService()).toBe(secondService)
  })
})
