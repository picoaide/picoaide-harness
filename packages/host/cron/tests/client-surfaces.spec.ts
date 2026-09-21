/**
 * Cron plugin client surfaces: which faces register unconditionally and which
 * exist only where their owning row does.
 *
 * Both optional faces regressed silently during the 0.1.5 upgrade (P1-7: a hard
 * `inject` on `sidebarRightTabs` left the whole plugin fiber pending when the
 * `ui-sidebar-right` row was absent; P2-3: the settings card was registered
 * into a slot only the disabled `ui-settings-plugins` row declares), so the
 * wiring is pinned here instead of depending on a live profile.
 *
 * Applied effects are recorded, not run: the two outer effects mount React
 * trees (`mountCronPanel` writes to `document`), which this node-environment
 * suite cannot host. The registry callbacks the assertions read are driven
 * explicitly by the tests.
 */
import { describe, expect, it } from 'vitest'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { apply, inject } from '../src/client/index.ts'

/** A slot entry as the stub registry keeps it. */
interface RegisteredEntry {
  name: string
  key?: string
  id?: string
  order?: number
  label?: () => string
  locale?: string
  inject?: () => Record<string, unknown>
}

/** A right-Sidebar tab definition as the stub tab registry keeps it. */
interface RegisteredTab {
  id?: string
  kind?: string
}

/** Recording doubles for every context face `apply` touches. */
interface Harness {
  ctx: ClientContext
  probes: Array<{ key: string, declared: boolean }>
  slotWaits: Array<{ key: string, register: () => RegisteredEntry }>
  registered: RegisteredEntry[]
  serviceWaits: Array<{ deps: string[], run: (child: ClientContext) => void }>
  effects: Array<string | undefined>
  provided: string[]
  tabs: RegisteredTab[]
  child: () => ClientContext
}

/**
 * Build one stub client context.
 * @param options - which optional rows the composition declares.
 * @returns recording harness; `child()` mints the fiber a `ctx.inject` callback receives.
 */
function harness(options: { pluginsPage?: boolean } = {}): Harness {
  const probes: Harness['probes'] = []
  const slotWaits: Harness['slotWaits'] = []
  const registered: RegisteredEntry[] = []
  const serviceWaits: Harness['serviceWaits'] = []
  const effects: Array<string | undefined> = []
  const provided: string[] = []
  const tabs: RegisteredTab[] = []

  // The settings service face the Host half publishes; the card only binds a
  // namespace scope over it.
  const settingsScope = {
    bind: (spec: { namespace: string }) => ({
      ...spec,
      getSnapshot: () => ({ value: {} }),
      subscribe: () => () => {},
      set: async () => {},
    }),
  }

  const scope = (child: boolean): ClientContext => ({
    effect: (callback: () => unknown, label?: string) => {
      effects.push(label)
      // A child fiber's effects are registry registrations; the outer ones
      // mount React trees into a document this suite does not provide.
      if (child) callback()
      return () => {}
    },
    get: (name: string) => (name === 'settingsScope' ? settingsScope : undefined),
    provide: (name: string) => { provided.push(name) },
    inject: (deps: string[], run: (inner: ClientContext) => void) => {
      serviceWaits.push({ deps, run })
      return () => {}
    },
    slots: {
      spec: (key: string) => {
        const declared = key === 'plugins.item' && options.pluginsPage === true
        probes.push({ key, declared })
        return declared ? { kind: 'list' } : undefined
      },
      inject: (key: string, register: () => RegisteredEntry) => {
        slotWaits.push({ key, register })
        return () => {}
      },
      register: (entry: RegisteredEntry) => {
        registered.push(entry)
        return () => {}
      },
    },
    sidebarRightTabs: {
      register: (definition: RegisteredTab) => {
        tabs.push(definition)
        return () => {}
      },
    },
  }) as unknown as ClientContext

  return {
    ctx: scope(false), probes, slotWaits, registered, serviceWaits, effects, provided, tabs,
    child: () => scope(true),
  }
}

/**
 * Run one slot-injection callback the way a live declaration would and return
 * the entries it registered.
 * @param harness - recording harness after `apply`.
 * @param key - slot key whose wait to resolve.
 * @returns entries that callback registered, in order.
 */
function register(harness: Harness, key: string): RegisteredEntry[] {
  const before = harness.registered.length
  harness.slotWaits.find(wait => wait.key === key)?.register()
  return harness.registered.slice(before)
}

describe('cron client surfaces', () => {
  it('requires no service the optional right-Sidebar row provides', () => {
    // The exact required set: adding `sidebarRightTabs` back leaves this fiber
    // pending whenever `ui-sidebar-right` is absent, which silently drops the
    // sidebar entry, the job center, and the settings card along with the tab.
    expect(inject).toEqual(['slots', 'settingsScope', 'locale', 'workspaces', 'connection', 'sessions'])
  })

  it('registers the sidebar entry, the center, and the browser face without optional rows', () => {
    const h = harness()
    apply(h.ctx)

    expect(h.provided).toEqual(['picoCronService'])
    expect(register(h, 'sidebar.footer.action')).toEqual([
      expect.objectContaining({ name: 'sidebar.footer.action', id: 'pico-cron', order: -10 }),
    ])
    expect(h.effects).toContain('dsh-cron: main-area center')
    // The tab is still attempted, through its own fiber: the wait is what keeps
    // it working when the row is present.
    expect(h.serviceWaits.map(wait => wait.deps)).toEqual([['sidebarRightTabs']])
  })

  it('does not register the settings card where the plugins page is disabled', () => {
    const h = harness()
    apply(h.ctx)

    expect(h.probes).toEqual([{ key: 'plugins.item', declared: false }])
    expect(h.slotWaits.map(wait => wait.key)).toEqual(['sidebar.footer.action'])
  })

  it('registers the settings card under its namespace where the page exists', () => {
    const h = harness({ pluginsPage: true })
    apply(h.ctx)

    expect(h.probes).toEqual([{ key: 'plugins.item', declared: true }])
    expect(h.slotWaits.map(wait => wait.key).sort()).toEqual(['plugins.item', 'sidebar.footer.action'])
    const card = register(h, 'plugins.item')[0]
    // 0.1.6-alpha.2：承接面从 keyed `settings.plugin.item` 变成 list `plugins.item`，
    // 注册形态随之从 key 变成 id/order/label（owner 契约新增 view:'summary'|'page'）。
    expect(card).toMatchObject({ name: 'plugins.item', id: 'cron', order: 40, locale: 'cron' })
    expect(typeof card?.label?.()).toBe('string')
    // 2026-09-21：注入面新增 `getError` —— 开关保存失败时 Scope.set 会回滚并重读宿主状态，
    // 原来控制器把 promise `void` 掉，界面静默弹回旧值、还留一条未处理的 rejection。
    // 现在失败原因经这条出口回到卡片里显示。
    expect(Object.keys(card?.inject?.() ?? {}).sort()).toEqual(['getError', 'getSnapshot', 'set', 'subscribe'])
  })

  it('registers the right-Sidebar tab with the official id, kind, and seat key', () => {
    const h = harness()
    apply(h.ctx)
    h.serviceWaits[0]?.run(h.child())

    expect(h.tabs).toEqual([expect.objectContaining({ id: 'pico:cron', kind: 'pico-cron' })])
    const body = register(h, 'sidebar.right.pane.tab')[0]
    expect(body).toMatchObject({ name: 'sidebar.right.pane.tab', key: 'pico:cron', locale: 'cron' })
    // The tab body shares the one controller with the other two surfaces.
    expect(body?.inject?.()).toMatchObject({ controller: expect.anything() })
  })
})
