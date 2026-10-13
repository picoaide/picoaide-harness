/**
 * 企业客户端半边的**接线判据**（2026-10-13 起）。
 *
 * 本文件的前身是 `client-foot-entry.spec.ts` —— 那时它跑真 `apply` 断言的是
 * **能力中心的底部条目**（id/order/title/activate）与面板装载。能力中心的客户端面
 * 整块搬进 `@picoaide/dsh-capability-center` 之后，那几条断言**逐条搬到了**
 * `packages/host/capability-center/tests/client-plugin.spec.ts`（一条不少），
 * 本文件改成断言企业包**留下的**那一半，并补上搬迁的**反向不变量**：
 *
 *   - 企业包仍然登记它自己的全部面（字典 / 品牌槽位 / 账号设置页 / favicon /
 *     文档标题 / 品牌样式表）；
 *   - 它**不再**登记能力中心的底部条目、**不再**挂载能力中心面板、**不再**等待
 *     `picoFootMenu`（那条服务只有面板入口需要）；
 *   - 它注入的品牌样式表里**不再**有 `.pico-skill-card`（技能卡样式随面板一起搬走，
 *     正反两条断言分别在本文件与新包 —— 任一侧多注入/漏注入都会红）。
 *
 * 为什么跑**真 apply** 而不是只读源码：槽位/服务/字典都是在 apply 里内联注册的，
 * 只有真跑一遍才拿得到。apply 的头部几条 effect 会碰 DOM（渠道 CSS 变量 / 品牌样式表 /
 * favicon / 文档标题），所以这里按本包既有先例给一个**极简 DOM 替身**，不引入 jsdom。
 *
 * ---- 变异验证 ----
 *   - 把能力中心的条目登记加回本包 ⇒「不登记底部条目」红；
 *   - 删掉账号设置页 / favicon / 品牌槽位任一条 effect ⇒ 对应那条红；
 *   - 把 `.pico-skill-card` 规则抄回品牌样式表 ⇒「品牌样式表里没有技能卡规则」红；
 *   - 把 `picoFootMenu` 写回硬 `inject` ⇒「不再等待 picoFootMenu」红。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context as ClientContext } from '@deepseek-ai/cordis'

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
  serviceWaits: string[][]
  /** `ctx.locale.register` 的调用记录（命名空间 + 键集）。 */
  dictionaries: { namespace: string, keys: string[] }[]
  /** 注入到 `document.head` 的样式表**节点**（`textContent` 在节点被写入后才读，见 `stubDom`）。 */
  styleNodes: { textContent: string }[]
}

/** 记录型上下文替身；effect 立刻执行（本包的 effect 只注册服务/槽位/样式表）。 */
function harness(): Harness {
  const footEntries: RegisteredFootEntry[] = []
  const disposers = new Map<string, () => void>()
  const effects: string[] = []
  const slots: string[] = []
  const serviceWaits: string[][] = []
  const dictionaries: { namespace: string, keys: string[] }[] = []
  const styles: string[] = []
  /** 注入到 `document.head` 的样式表**节点**；`textContent` 在节点写入后才读（见 `stubDom`）。 */
  const styleNodes: { textContent: string }[] = []
  const ctx = {
    effect: (callback: () => unknown, label?: string) => {
      effects.push(label ?? '')
      const dispose = callback()
      if (typeof dispose === 'function' && label !== undefined) disposers.set(label, dispose as () => void)
      return () => {}
    },
    inject: (deps: string[], run: (scope: ClientContext) => void) => {
      serviceWaits.push(deps)
      run(ctx as unknown as ClientContext)
      return () => {}
    },
    on: () => () => {},
    get: () => undefined,
    locale: {
      register: (namespace: string, dictionary: { zh: Record<string, string> }) => {
        dictionaries.push({ namespace, keys: Object.keys(dictionary.zh) })
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
        return () => {}
      },
      touch: () => {},
      snapshot: () => [...footEntries],
      subscribe: () => () => {},
    },
  } as unknown as ClientContext
  return { ctx, footEntries, disposers, effects, slots, serviceWaits, dictionaries, styles, styleNodes }
}

/**
 * 极简 DOM 替身：只满足 apply 那条品牌/渠道/favicon/文档标题链的最低需要。
 *
 * ⚠️ `head.appendChild` 必须**留存节点引用**而不是当场读 `node.textContent`：
 * `paintBrandStyle()` 的顺序是 `createElement('style')` → `appendChild` → **之后**才写
 * `textContent = brandCss(...)`。当场读值会把空串记下来，样式表判据就变成"对空串断言"
 * —— `not.toContain('pico-skill-card')` 这种否定断言会**假绿**（本文件那两条
 * `toContain('class$="_footerActions"')` 正向锚点正是为了钉死这一点）。
 */
function stubDom(h: Harness): void {
  const element = (): Record<string, unknown> => ({
    isConnected: true,
    textContent: '',
    setAttribute: () => {},
    appendChild: () => {},
    remove: () => {},
    style: {},
  })
  vi.stubGlobal('document', {
    // `document.title` 是文档标题归一化那条 effect 的读面（字符串）。
    title: '',
    documentElement: { style: { setProperty: () => {} } },
    head: { appendChild: (node: { textContent: string }) => { h.styleNodes.push(node) } },
    body: {},
    createElement: element,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
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

/** 跑一遍真 apply。 */
async function run(): Promise<{ h: Harness, inject: readonly string[] }> {
  vi.resetModules()
  const mod = await import('../src/client/index.ts')
  current = harness()
  stubDom(current)
  mod.apply(current.ctx)
  // 样式表的正文是 `appendChild` **之后**才写进节点的（`paintBrandStyle` 的顺序），
  // 所以这里在 apply 跑完之后才收获，避免把空串当成样式表内容（否则否定断言会假绿）。
  current.styles.push(...current.styleNodes.map(node => node.textContent))
  return { h: current, inject: [...mod.inject] }
}

describe('企业客户端半边：留下来的那一半接线', () => {
  it('不再登记能力中心的底部条目，也不再挂载它的面板（那一整块已搬走）', async () => {
    const { h } = await run()
    expect(h.footEntries).toEqual([])
    expect(h.effects.filter(label => label.includes('capability center'))).toEqual([])
    expect(h.effects.some(label => label.includes('skill card'))).toBe(false)
  })

  it('不再等 picoFootMenu（那条服务只有面板入口需要）', async () => {
    const { h, inject } = await run()
    expect(inject).not.toContain('picoFootMenu')
    expect(h.serviceWaits).toEqual([])
  })

  it('企业字典只注册企业面的键（capability.* 随面板搬走）', async () => {
    const { h } = await run()
    expect(h.dictionaries).toHaveLength(1)
    const entry = h.dictionaries[0]!
    expect(entry.namespace).toBe('enterprise')
    expect(entry.keys.length).toBeGreaterThan(0)
    expect(entry.keys.filter(key => key.startsWith('capability.'))).toEqual([])
    expect(entry.keys).toContain('settings.account')
    expect(entry.keys).toContain('hero.tagline')
  })

  it('品牌样式表里没有技能卡规则（`.pico-skill-card` 随面板注入）', async () => {
    const { h } = await run()
    const css = h.styles.join('\n')
    expect(css).toContain('class$="_footerActions"')
    expect(css).toContain('class$="_previewBadge"')
    expect(css).not.toContain('pico-skill-card')
  })

  it('企业自己的面仍然全部登记（搬迁不许把它们带走）', async () => {
    const { h } = await run()
    expect(h.effects).toContain('enterprise: channel store')
    expect(h.effects).toContain('enterprise: client dictionaries')
    expect(h.effects).toContain('enterprise: desktop favicon')
    expect(h.effects).toContain('enterprise: account section')
    expect(h.effects).toContain('enterprise: document channel title')
    expect(h.effects).toContain('enterprise: brand styles')
    expect(h.slots).toEqual(expect.arrayContaining([
      'sidebar.brand.mark',
      'sidebar.brand.name',
      'conversation.hero.brand.mark',
      'conversation.session.header.actions',
      'settings.section',
    ]))
    expect(h.slots).not.toContain('sidebar.footer.action')
  })
})
