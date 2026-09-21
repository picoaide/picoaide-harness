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
import { openCronPanel } from '../src/client/panel-mount.tsx'

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

/** One foot-menu entry as the stub registry keeps it。 */
interface RegisteredFootEntry {
  id: string
  order: number
  title: () => string
  activate: () => void
  attention?: (() => boolean) | undefined
}

/** Recording doubles for every context face `apply` touches. */
interface Harness {
  ctx: ClientContext
  probes: Array<{ key: string, declared: boolean }>
  slotWaits: Array<{ key: string, register: () => RegisteredEntry }>
  registered: RegisteredEntry[]
  serviceWaits: Array<{ deps: string[], run: (child: ClientContext) => void }>
  effects: Array<string | undefined>
  /** Effect callbacks by label — the outer ones are NOT run by the harness. */
  effectRuns: Array<{ label: string | undefined, run: () => unknown }>
  /** Entries currently registered in the stub `picoFootMenu` registry. */
  footEntries: RegisteredFootEntry[]
  provided: string[]
  tabs: RegisteredTab[]
  child: () => ClientContext
}

/**
 * Run one recorded effect callback by its label (the outer effects mount React
 * trees this suite cannot host, so `apply` must not run them eagerly).
 * @param harness - recording harness after `apply`.
 * @param label - effect label the plugin passed to `ctx.effect`.
 * @returns the effect's disposer (when it returned one).
 */
function runEffect(harness: Harness, label: string): () => void {
  const effect = [...harness.effectRuns].reverse().find(item => item.label === label)
  if (effect === undefined) throw new Error(`no effect labeled ${label}`)
  const dispose = effect.run()
  return typeof dispose === 'function' ? dispose as () => void : () => {}
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
  const effectRuns: Harness['effectRuns'] = []
  const footEntries: RegisteredFootEntry[] = []
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
      if (child) {
        // A child fiber's effects are registry registrations: run them now and
        // keep what they returned, so `runEffect` hands back the real disposer
        // instead of re-registering a second copy.
        const dispose = callback()
        effectRuns.push({ label, run: () => (typeof dispose === 'function' ? dispose as () => void : () => {}) })
        return () => {}
      }
      // The outer effects mount React trees into a document this suite does not
      // provide — the tests drive selected callbacks through `runEffect`.
      effectRuns.push({ label, run: callback })
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
  }) as unknown as ClientContext

  return {
    ctx: scope(false), probes, slotWaits, registered, serviceWaits, effects, effectRuns, footEntries, provided, tabs,
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
  it('requires no service the optional rows provide (including the foot-lane row)', () => {
    // The exact required set: adding `sidebarRightTabs` back leaves this fiber
    // pending whenever `ui-sidebar-right` is absent, which silently drops the
    // foot-lane entry, the job center, and the settings card along with the tab.
    // `picoFootMenu` is the same hazard (its row can be disabled by a channel
    // overlay / the machine-wide patch): it is waited on from a CHILD scope, so
    // its absence costs only the popover entry.
    expect(inject).toEqual(['slots', 'settingsScope', 'locale', 'workspaces', 'connection', 'sessions'])
  })

  it('registers the foot-lane entry from a child scope (the rest does not wait on it)', () => {
    const h = harness()
    apply(h.ctx)

    expect(h.provided).toEqual(['picoCronService'])
    // The service wait is what makes the entry survive a late/absent row; the
    // center and the settings card are registered WITHOUT it (that ordering is
    // the point of the child scope).
    expect(h.serviceWaits.map(wait => wait.deps)).toEqual([['picoFootMenu'], ['sidebarRightTabs']])
    h.serviceWaits[0]?.run(h.child())
    // The entry: id == the panel-surface PanelId, order keeps the job center
    // first in the popover, title is the live dictionary lookup, and activate
    // is the panel opener itself (not a copy of it).
    const dispose = runEffect(h, 'dsh-cron: foot menu entry')
    expect(h.footEntries).toHaveLength(1)
    const entry = h.footEntries[0]!
    expect(entry.id).toBe('cron')
    expect(entry.order).toBe(-10)
    expect(entry.title()).toBe('定时任务')
    expect(entry.activate).toBe(openCronPanel)
    // Disposer really unregisters (插件卸载后条目不能留在浮层里).
    dispose()
    expect(h.footEntries).toEqual([])
    // The center is still mounted by its own effect.
    expect(h.effects).toContain('dsh-cron: main-area center')
    // The tab is still attempted, through its own fiber: the wait is what keeps
    // it working when the row is present.
    expect(h.serviceWaits.find(wait => wait.deps.includes('sidebarRightTabs'))?.deps).toEqual(['sidebarRightTabs'])
  })

  it('foot row disabled ⇒ every other surface still applies (only the entry waits)', () => {
    // `picoFootMenu` never arrives (its row was disabled by an overlay): the child
    // scope stays pending, and NOTHING else may be held back by that — otherwise
    // disabling one row silently strips the job center, the settings card, and
    // the right-Sidebar tab too (the P1-7 failure mode).
    const h = harness()
    apply(h.ctx)

    expect(h.footEntries).toEqual([])
    expect(h.effects).toContain('dsh-cron: main-area center')
    expect(h.probes).toEqual([{ key: 'plugins.item', declared: false }])
    expect(h.serviceWaits.map(wait => wait.deps)).toEqual([['picoFootMenu'], ['sidebarRightTabs']])
    // The tab body still registers once its own service arrives.
    h.serviceWaits.find(wait => wait.deps.includes('sidebarRightTabs'))?.run(h.child())
    expect(h.tabs).toEqual([expect.objectContaining({ id: 'pico:cron', kind: 'pico-cron' })])
  })

  it('no longer registers anything into the sidebar foot slot (that row is owned by dsh-foot-menu)', () => {
    const h = harness()
    apply(h.ctx)

    expect(h.slotWaits.map(wait => wait.key)).toEqual([])
  })

  it('does not register the settings card where the plugins page is disabled', () => {
    const h = harness()
    apply(h.ctx)

    expect(h.probes).toEqual([{ key: 'plugins.item', declared: false }])
    expect(h.slotWaits.map(wait => wait.key)).toEqual([])
  })

  it('registers the settings card under its namespace where the page exists', () => {
    const h = harness({ pluginsPage: true })
    apply(h.ctx)

    expect(h.probes).toEqual([{ key: 'plugins.item', declared: true }])
    expect(h.slotWaits.map(wait => wait.key)).toEqual(['plugins.item'])
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
    h.serviceWaits.find(wait => wait.deps.includes('sidebarRightTabs'))?.run(h.child())

    expect(h.tabs).toEqual([expect.objectContaining({ id: 'pico:cron', kind: 'pico-cron' })])
    const body = register(h, 'sidebar.right.pane.tab')[0]
    expect(body).toMatchObject({ name: 'sidebar.right.pane.tab', key: 'pico:cron', locale: 'cron' })
    // The tab body shares the one controller with the other two surfaces.
    expect(body?.inject?.()).toMatchObject({ controller: expect.anything() })
  })
})
