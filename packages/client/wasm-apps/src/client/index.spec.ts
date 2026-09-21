/**
 * 客户端半边的装配契约：`apply(ctx)` 到底注册了什么。
 *
 * 这是"页面在 DOM 里、用户点得到"的**第一层**证据（真实 DOM 点击证据在 CDP 探针里，
 * `temp/wasm-l/app-center-probe.mjs`）：如果这里没把应用中心条目登记进
 * `picoFootMenu`（底部唯一的「更多」行由 `@picoaide/dsh-foot-menu` 拥有）、
 * 或者没给 toast 宿主留下常驻挂载点，后面所有组件测试都可能全绿而产品里什么都没有。
 *
 * 变异验证：把 `ctx.picoFootMenu.add(…)` 删掉（或改 id/order）→ 本文件对应的
 * 登记断言红；把 toast 宿主的槽位注册删掉 →「toast 宿主仍有常驻挂载点」红。
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { apply, inject, name } from './index.ts'
import { AppToastHostMount } from './AppToastHostMount.tsx'
import { openAppCenterPanel } from './app-center-surface.tsx'
import { APP_FOREIGN_DEEP_LINK_EVENT, clearAppToast, currentAppToast } from './app-toast.tsx'
import { en, setActiveLocale, t, zh } from './locales.ts'

interface Registered {
  name: string
  id?: string
  order?: number
}

/** 一条 foot menu 条目（stub 登记表保存的形状）。 */
interface RegisteredFootEntry {
  id: string
  order: number
  title: () => string
  activate: () => void
}

interface Fixture {
  ctx: ClientContext
  registered: Registered[]
  components: unknown[]
  footEntries: RegisteredFootEntry[]
  /** 每个 effect 的标签与它**首次执行**返回的 disposer（不重跑回调）。 */
  effectRuns: Array<{ label: string | undefined, dispose: () => void }>
  /** `ctx.inject` 的服务等待（每一组依赖一个条目）。 */
  serviceWaits: string[][]
  locales: Array<{ namespace: string, dictionaries: { zh: unknown, en: unknown } }>
  injected: string[]
  /** `ctx.on` 注册的宿主事件名（本次新增：异渠道深链 toast 的接缝）。 */
  events: string[]
  /** 手动触发某个已注册的宿主事件（模拟宿主 `ctx.emit`）。 */
  emit: (event: string, payload?: unknown) => void
  setActive: (locale: string) => void
  effects: number
}

/**
 * @param options - `footRowEnabled: false` 模拟"提供 picoFootMenu 的那一行被禁用"。
 */
function fixture(options: { footRowEnabled?: boolean } = {}): Fixture {
  const registered: Registered[] = []
  const components: unknown[] = []
  const footEntries: RegisteredFootEntry[] = []
  const effectRuns: Fixture['effectRuns'] = []
  const serviceWaits: string[][] = []
  const locales: Array<{ namespace: string, dictionaries: { zh: unknown, en: unknown } }> = []
  const injected: string[] = []
  const events: string[] = []
  const handlers = new Map<string, Array<(payload?: unknown) => void>>()
  let active = 'zh'
  let effects = 0
  const ctx = {
    inject: (deps: string[], run: (scope: ClientContext) => void) => {
      serviceWaits.push(deps)
      if (options.footRowEnabled !== false) run(ctx as unknown as ClientContext)
      return () => {}
    },
    effect: (fn: () => unknown, label?: string) => {
      effects += 1
      const dispose = fn()
      effectRuns.push({ label, dispose: typeof dispose === 'function' ? dispose as () => void : () => {} })
      return () => {}
    },
    // 宿主事件订阅（客户端半边用 `ctx.on('pico/…')` 接收宿主广播）。
    on: (event: string, handler: (payload?: unknown) => void) => {
      events.push(event)
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return () => {}
    },
    locale: {
      register: (namespace: string, dictionaries: { zh: unknown, en: unknown }) => {
        locales.push({ namespace, dictionaries })
        return () => {}
      },
      getLocale: () => ({ active }),
      subscribe: () => () => {},
    },
    slots: {
      inject: (slot: string, run: () => unknown) => { injected.push(slot); run(); return () => {} },
      register: (registration: Registered, component: unknown) => {
        registered.push(registration)
        components.push(component)
        return () => {}
      },
    },
    // foot menu 登记表（`@picoaide/dsh-foot-menu` 提供；这里只记录调用）。
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
  return {
    ctx,
    events,
    emit: (event, payload) => { for (const handler of handlers.get(event) ?? []) handler(payload) },
    registered,
    components,
    footEntries,
    effectRuns,
    serviceWaits,
    locales,
    injected,
    effects,
    setActive: (locale: string) => { active = locale },
  }
}

afterEach(() => {
  setActiveLocale('zh')
  clearAppToast()
})

describe('客户端半边：异渠道深链 toast 的接缝（§5.3/§19 Q5）', () => {
  /**
   * 判据：宿主广播**那一个**事件名 ⇒ 客户端弹出一次性提示；别的事件不弹。
   *
   * 变异验证：把 `ctx.on(APP_FOREIGN_DEEP_LINK_EVENT, …)` 删掉（或换成别的事件名）
   * ⇒ 本组两条红。
   */
  it('订阅宿主广播的异渠道深链事件，并据此弹出 toast（文案由 store 驱动）', () => {
    const f = fixture()
    apply(f.ctx)
    expect(f.events).toContain(APP_FOREIGN_DEEP_LINK_EVENT)
    expect(currentAppToast()).toBeNull()
    f.emit(APP_FOREIGN_DEEP_LINK_EVENT, { url: 'other-channel://app/x' })
    expect(currentAppToast()).toEqual({ kind: 'foreign-deep-link' })
  })

  it('别的宿主事件（打开应用 / 渠道变化）不得弹 toast', () => {
    const f = fixture()
    apply(f.ctx)
    f.emit('pico/wasm-app-open', { app_id: 'x' })
    f.emit('pico/channel-changed', null)
    expect(currentAppToast()).toBeNull()
  })
})

describe('客户端半边：apply 注册面', () => {
  it('声明插件名与服务依赖（picoFootMenu 走子 fiber，不写进硬 inject）', () => {
    expect(name).toBe('picoaide-wasm-apps-client')
    // 硬 inject 的后果：提供 `picoFootMenu` 的那一行被渠道覆盖层 /
    // `$DSH_HOME/cordis.patch.yml` 禁用时，整条 fiber 永久 pending（无报错），
    // 应用中心面板与 toast 挂载点一起消失（P1-7 教训）⇒ 只在子 fiber 里等它。
    expect(inject).toEqual(['slots', 'locale'])
  })

  it('在子 fiber 里等服务到位后再登记条目', () => {
    const f = fixture()
    apply(f.ctx)
    expect(f.serviceWaits).toEqual([['picoFootMenu']])
  })

  it('foot 行被禁用 ⇒ 面板与 toast 挂载点照常（只有条目等不到）', () => {
    const f = fixture({ footRowEnabled: false })
    apply(f.ctx)
    expect(f.footEntries).toEqual([])
    // toast 挂载点与面板挂载都在外层 effect 里，不受 foot 行是否存在影响。
    expect(f.injected).toContain('sidebar.footer.action')
    expect(f.components).toEqual([AppToastHostMount])
    expect(f.effectRuns.map(item => item.label)).toContain('wasm-apps: foreign deep-link toast')
  })

  it('把应用中心条目登记到 picoFootMenu（用户点得到的那个浮层）', () => {
    const f = fixture()
    apply(f.ctx)
    expect(f.footEntries).toHaveLength(1)
    const entry = f.footEntries[0]!
    // id 必须等于 panel-surface 的 PanelId（'apps'）：否则激活态文案不会变成
    // 「更多 · 应用中心」。
    expect(entry.id).toBe('apps')
    expect(entry.order).toBe(2)
    expect(entry.title()).toBe('应用中心')
    // activate 就是面板装载器导出的那个函数（不是复制品）。
    expect(entry.activate).toBe(openAppCenterPanel)
  })

  it('注销函数真的摘掉条目（插件卸载后浮层里不留孤儿行）', () => {
    const f = fixture()
    apply(f.ctx)
    const effect = [...f.effectRuns].reverse().find(item => item.label === 'wasm-apps: foot menu entry')
    expect(effect, '未登记 foot menu 条目').toBeDefined()
    effect!.dispose()
    expect(f.footEntries).toEqual([])
  })

  it('toast 宿主仍有常驻挂载点（导航行搬走了，异渠道深链提示不能跟着消失）', () => {
    const f = fixture()
    apply(f.ctx)
    expect(f.injected).toContain('sidebar.footer.action')
    const registration = f.registered.find(r => r.name === 'sidebar.footer.action')
    expect(registration, '未挂 toast 宿主 ⇒ 主窗口级提示没有消费者').toBeDefined()
    expect(registration!.id).toBe('wasm-app-toast-host')
    expect(f.components).toEqual([AppToastHostMount])
  })

  it('注册 zh/en 双语文案（中文术语「应用中心」/ 英文 App Center）', () => {
    const f = fixture()
    apply(f.ctx)
    const entry = f.locales.find(l => l.namespace === 'app-center')
    expect(entry, '未注册 app-center 字典').toBeDefined()
    expect(entry!.dictionaries.zh).toBe(zh)
    expect(entry!.dictionaries.en).toBe(en)
  })

  it('跟随当前语言：启动即采样，且语言变化后 t() 立即换文案', () => {
    const f = fixture()
    f.setActive('en')
    apply(f.ctx)
    // 采样发生在 apply 期间（subscribe 回调同步调用一次）。
    expect(t('appCenter.title')).toBe('App Center')
    expect(f.footEntries[0]?.title()).toBe('App Center')
  })

  it('只声明 sidebar.footer.action 一个槽（不往别的槽位塞东西）', () => {
    const f = fixture()
    apply(f.ctx)
    expect(f.injected).toEqual(['sidebar.footer.action'])
    // 唯一的槽位占用者是 toast 挂载点 —— 它不渲染按钮，不算导航行。
    expect(f.registered).toHaveLength(1)
  })
})
