/**
 * 客户端半边的装配契约：`apply(ctx)` 到底注册了什么。
 *
 * 这是"页面在 DOM 里、用户点得到"的**第一层**证据（真实 DOM 点击证据在 CDP 探针里，
 * `temp/wasm-l/app-center-probe.mjs`）：如果这里没把 `sidebar.footer.action` 注册上、
 * 或者注册的 id/order/组件不对，后面所有组件测试都可能全绿而产品里什么都没有。
 *
 * 变异验证：把 `slots.inject('sidebar.footer.action', …)` 删掉（或改成别的槽名）
 * → 本文件「注册到 sidebar.footer.action」红；把 order 改掉 → 顺序断言红。
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { apply, inject, name } from './index.ts'
import { AppCenterTrigger } from './AppCenterTrigger.tsx'
import { en, setActiveLocale, t, zh } from './locales.ts'

interface Registered {
  name: string
  id?: string
  order?: number
}

interface Fixture {
  ctx: ClientContext
  registered: Registered[]
  components: unknown[]
  locales: Array<{ namespace: string, dictionaries: { zh: unknown, en: unknown } }>
  injected: string[]
  setActive: (locale: string) => void
  effects: number
}

function fixture(): Fixture {
  const registered: Registered[] = []
  const components: unknown[] = []
  const locales: Array<{ namespace: string, dictionaries: { zh: unknown, en: unknown } }> = []
  const injected: string[] = []
  let active = 'zh'
  let effects = 0
  const ctx = {
    effect: (fn: () => unknown) => { effects += 1; fn(); return () => {} },
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
  } as unknown as ClientContext
  return {
    ctx,
    registered,
    components,
    locales,
    injected,
    effects,
    setActive: (locale: string) => { active = locale },
  }
}

afterEach(() => { setActiveLocale('zh') })

describe('客户端半边：apply 注册面', () => {
  it('声明插件名与服务依赖', () => {
    expect(name).toBe('picoaide-wasm-apps-client')
    expect(inject).toEqual(['slots', 'locale'])
  })

  it('把应用中心入口注册到 sidebar.footer.action（用户点得到的那个槽）', () => {
    const f = fixture()
    apply(f.ctx)
    expect(f.injected).toContain('sidebar.footer.action')
    const registration = f.registered.find(r => r.name === 'sidebar.footer.action')
    expect(registration, '未注册 sidebar.footer.action ⇒ 界面上没有入口').toBeDefined()
    expect(registration!.id).toBe('wasm-app-center')
    expect(registration!.order).toBe(2)
    expect(f.components[0]).toBe(AppCenterTrigger)
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
  })

  it('只声明 sidebar.footer.action 一个槽（不往别的槽位塞东西）', () => {
    const f = fixture()
    apply(f.ctx)
    expect(f.injected).toEqual(['sidebar.footer.action'])
    expect(f.registered).toHaveLength(1)
  })
})
