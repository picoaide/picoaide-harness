// @vitest-environment jsdom
/**
 * 账户卡并道改造（spec §6，2026-09-21）的**真挂载**用例。
 *
 * 改造把常显的 140px 卡片收成一行 34px，卡片内容搬进点击后向上弹出的
 * `role="dialog"` 浮层。真挂载是必须的：这些断言全都落在"点 → React 状态 →
 * DOM / fetch"的链路上，静态 markup 断言证明不了任何一条。
 *
 * 覆盖：
 *  ① 行内余额三态（正常 / 0 / 取数失败）+ 加载中 + 未开通（长文案只在
 *     title/aria-label，不塞进行内）；
 *  ② 点行开浮层（`role="dialog"`、内容与原卡片逐字一致）→ 刷新保持打开；
 *  ③ Esc 关闭且焦点回到行；打开时焦点进浮层（审计 P2-a11y）；
 *  ④ 行/浮层之外的 pointerdown **与只有 click 的激活**都关闭，浮层内的不关；
 *  ⑤ 浮层里的刷新打到 `/api/pico/account/usage?refresh=1`、退出登录打到
 *     `POST /api/pico/auth/logout`，两者各有重入闸（连点两次只发一次）；
 *  ⑥ 窄轨仍是头像圆按钮（`data-rail="true"` 自证）且能打开同一个浮层；
 *  ⑦ 未登录早退、挂载即轮询两个只读路由（语义回归）；
 *  ⑧ 字典 zh/en key 集合一致（新增 key 必须成对）；
 *  ⑨ 注入的样式表给出基准底 + `:hover`，且行不带内联 `background`（内联会顶掉
 *     `:hover`，hover 变死规则 —— 这条是那次回归的守卫）；
 *  ⑩ 轮询撞上服务端 401 后立刻转"余额不可用"，不显示上一次的金额（P1-5 规则）；
 *  ⑪ 宽 → 窄轨切换会换掉行节点，浮层必须按新锚点重算（审计 P2）。
 *
 * **一处"测不了"是明写的，不是漏的**：退出成功分支里的 `location.reload()`
 * 在 jsdom 25 下无法替身化 —— `window.location` 的 `reload` 是**自有、不可配置、
 * 不可写**属性（原型上的同名方法被它遮蔽，`vi.spyOn` / `defineProperty` /
 * `vi.stubGlobal('location')` 一律 "Cannot redefine property"），而 jsdom 的
 * "Not implemented: navigation" 也不经 `console.error` 暴露。因此成功分支只断言
 * **可观测的部分**：请求确实发出、按钮留在"退出中…"、没有回滚成错误文案。
 *
 * ---- 变异验证 ----
 *   - 行内余额去掉 `balanceMoney <= 0` 的红色分支 ⇒「0 用错误色」红；
 *   - `stale` 判定退回 `state === 'error' && data === null` ⇒「stale 显示 — 且
 *     不显示旧金额」红（旧判据在保留旧快照时 stale 恒 false）；
 *   - 去掉 `useOutsidePointerDismissal` 的 `pointerdown` ⇒ 外部点击那条红；
 *     去掉 `click` ⇒「只有 click 的激活也关掉」红（审计 P1 的回归守卫）；
 *   - Esc 关闭时不 `rowRef.current?.focus()` ⇒「焦点回到行」红；
 *   - 打开后不 `popoverElement.focus()` ⇒「焦点进入浮层」红；
 *   - 重入闸退回 state 判据（`if (refreshing) return`）⇒ 两条"连点两次"红；
 *   - 位置 effect 退回只依赖稳定 ref（不跟锚点元素）⇒「宽 → 窄轨重算」红；
 *   - 401 分支改成只写 state 不清 data ⇒「401 后不再显示金额」红。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AccountCard } from './AccountCard.tsx'
import { apply } from './index.ts'
import { en, setActiveLocale, zh } from './locales.ts'

// `@deepseek-ai/dsh-client-ui-primitives` 的运行时外部依赖（clsx / shiki / katex /
// simple-icons / micromark …）是 **shell 预置模块**（见 scripts/platform-modules.mjs
// 的 PRELOADED_CLIENT_EXTERNALS），node 下刻意不存在 —— 它的 lib 一加载就解析失败。
// 所以挂载类用例只能把这一个 import 替身化：替身只做"Tooltip 原样渲染锚点"这件事
// （真 Tooltip 也不额外包一层 DOM），**浮层开关/Esc/外部点击/取数全在组件内部实现，
// 不走替身**，因此它们的断言仍然打在真代码上。
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Tooltip: (props: { children: unknown }) => props.children,
}))

// React 18.3 在非测试构建下要求这个全局标记才认 `act()`。
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const AUTH_PATH = '/api/pico/auth/state'
const USAGE_PATH = '/api/pico/account/usage'
const REFRESH_PATH = '/api/pico/account/usage?refresh=1'
const LOGOUT_PATH = '/api/pico/auth/logout'

/** 占位账号（不是任何真实渠道/客户身份）。 */
const USERNAME = 'user001'

interface Reply {
  status?: number
  body?: unknown
  /** 挂起这条响应，直到 `releaseDeferred()` —— 用来在"请求还在飞"时再点一次。 */
  defer?: boolean
}

/** `/api/pico/auth/state` 的登录态响应。 */
const AUTH_LOGGED_IN: Reply = {
  body: { loggedIn: true, username: USERNAME, serverURL: 'https://gw.example' },
}

/** 一条 usage 快照（字段形状来自 usage-contract）。 */
function usageSnapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    balance_money: 89.65,
    balance_activated: true,
    balance_enabled: true,
    balance_monthly: 100,
    balance_mode: 'add',
    is_admin: false,
    monthly_usage: 0,
    monthly_cost: 12.3,
    today_usage: 0,
    today_cost: 1.2,
    yesterday_usage: 0,
    yesterday_cost: 0,
    total_usage: 0,
    total_cost: 0,
    ...overrides,
  }
}

/** `/api/pico/account/usage` 的成功响应（data 为快照）。 */
function usageReply(overrides: Record<string, unknown> = {}): Reply {
  return { body: { data: usageSnapshot(overrides), fetchedAt: 1, state: 'idle', error: null } }
}

function jsonResponse(reply: Reply): Response {
  return new Response(JSON.stringify(reply.body ?? null), {
    status: reply.status ?? 200,
    headers: { 'content-type': 'application/json' },
  })
}

let container: HTMLDivElement
let footArea: HTMLDivElement
let root: Root
let routes: Map<string, Reply>
let calls: string[]
let deferred: Array<() => void>

/** 放行所有 `defer: true` 的响应。 */
function releaseDeferred(): void {
  const pending = deferred
  deferred = []
  for (const release of pending) release()
}

beforeEach(() => {
  setActiveLocale('zh')
  calls = []
  deferred = []
  routes = new Map<string, Reply>([
    [`GET ${AUTH_PATH}`, AUTH_LOGGED_IN],
    [`GET ${USAGE_PATH}`, usageReply()],
  ])
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : String(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    calls.push(`${method} ${url}`)
    const reply = routes.get(`${method} ${url}`)
    if (reply === undefined) throw new Error(`unrouted request: ${method} ${url}`)
    if (reply.defer === true) {
      return await new Promise<Response>((resolve) => {
        deferred.push(() => { resolve(jsonResponse(reply)) })
      })
    }
    return jsonResponse(reply)
  }))
  // 账户行 portal 的落点：`[class$="_footArea"]`（与上游侧栏 class 后缀同判据）。
  footArea = document.createElement('div')
  footArea.className = 'spec_footArea'
  document.body.appendChild(footArea)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  footArea.remove()
  // 注入型样式表用例失败时也要清干净（head 是跨用例共享的）。
  for (const style of [...document.head.querySelectorAll('style')]) {
    if (style.textContent?.includes('.pico-account-row') === true) style.remove()
  }
  vi.unstubAllGlobals()
})

/** 客户端 Cordis 插件的最小夹具（`apply()` 到底往 DOM/槽位里放了什么）。 */
function clientFixture(): { ctx: ClientContext, disposers: Array<() => void> } {
  const disposers: Array<() => void> = []
  const ctx = {
    effect: (fn: () => unknown, _label?: string) => {
      const disposer = fn()
      const off = typeof disposer === 'function' ? disposer as () => void : () => {}
      disposers.push(off)
      return off
    },
    locale: {
      register: () => () => {},
      getLocale: () => ({ active: 'zh' }),
      subscribe: () => () => {},
    },
    slots: {
      inject: (_slot: string, run: () => unknown) => { run(); return () => {} },
      register: () => () => {},
    },
  } as unknown as ClientContext
  return { ctx, disposers }
}

/** 注入的账户行样式表（按选择器找，避免依赖 head 里的顺序）。 */
function injectedRowStyles(): HTMLStyleElement[] {
  return [...document.head.querySelectorAll('style')]
    .filter((style) => style.textContent?.includes('.pico-account-row') === true)
}

function slotProps(wide: boolean): PropsRuntime<'sidebar.footer.action'> {
  return { wide } as unknown as PropsRuntime<'sidebar.footer.action'>
}

/** 渲染并冲掉挂载期那两次 fetch（auth/state 与 account/usage）。 */
async function renderCard(wide = true): Promise<void> {
  await act(async () => { root.render(<AccountCard {...slotProps(wide)} />) })
  await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0) }) })
}

/** 收起态的行按钮（宽窄栏都是 footArea 里唯一那个 button）。 */
function rowButton(): HTMLButtonElement {
  const row = footArea.querySelector('button')
  expect(row).not.toBeNull()
  return row as HTMLButtonElement
}

function dialog(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('[role="dialog"]')
}

/** 一次真实手势：pointerdown + click（外部关闭判据挂在 pointerdown 上）。 */
async function press(element: Element): Promise<void> {
  await act(async () => { element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })) })
  await act(async () => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

async function pressKey(key: string): Promise<void> {
  await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })) })
}

function buttonByText(scope: HTMLElement, text: string): HTMLButtonElement {
  const found = [...scope.querySelectorAll('button')].find((button) => button.textContent?.includes(text))
  expect(found, `button containing ${text}`).toBeDefined()
  return found as HTMLButtonElement
}

describe('行内余额状态（spec §6）', () => {
  it('已开通：行显示用户名 + 金额，无警示圆点', async () => {
    await renderCard()
    const row = rowButton()
    expect(row.textContent).toContain(USERNAME)
    expect(row.textContent).toContain('¥89.65')
    const balance = [...row.querySelectorAll('span')].find((span) => span.textContent === '¥89.65')
    expect(balance?.style.color).toBe('var(--dsw-alias-label-primary)')
    expect(row.querySelector('[data-attention]')).toBeNull()
    expect(row.getAttribute('aria-haspopup')).toBe('dialog')
    expect(row.getAttribute('aria-expanded')).toBe('false')
    expect(row.getAttribute('aria-label')).toContain(USERNAME)
    expect(row.getAttribute('aria-label')).toContain('¥89.65')
  })

  it('余额为 0：金额用错误色 + 行上出现警示圆点 + aria-label 说明余额不足', async () => {
    routes.set(`GET ${USAGE_PATH}`, usageReply({ balance_money: 0 }))
    await renderCard()
    const row = rowButton()
    expect(row.textContent).toContain('¥0.00')
    const balance = [...row.querySelectorAll('span')].find((span) => span.textContent === '¥0.00')
    expect(balance?.style.color).toBe('var(--dsw-alias-state-error-primary)')
    expect(row.querySelector('[data-attention]')).not.toBeNull()
    expect(row.getAttribute('aria-label')).toContain('余额不足')
  })

  it('取数失败（stale）：行显示 —（次要色）而不是旧金额', async () => {
    routes.set(`GET ${USAGE_PATH}`, {
      body: { data: usageSnapshot(), fetchedAt: 1, state: 'error', error: 'boom' },
    })
    await renderCard()
    const row = rowButton()
    expect(row.textContent).not.toContain('¥89.65')
    expect(row.textContent).toContain('—')
    const placeholder = [...row.querySelectorAll('span')].find((span) => span.textContent === '—')
    expect(placeholder?.style.color).toBe('var(--dsw-alias-label-secondary)')
    expect(row.getAttribute('aria-label')).toContain('余额获取失败')
    expect(row.getAttribute('title')).toContain('余额获取失败')
    expect(row.querySelector('[data-attention]')).toBeNull()
  })

  it('加载中：行显示 …', async () => {
    routes.set(`GET ${USAGE_PATH}`, { body: { data: null, fetchedAt: 0, state: 'loading', error: null } })
    await renderCard()
    expect(rowButton().textContent).toContain('…')
  })

  it('未开通余额：行内只有 —，说明只在 title / aria-label', async () => {
    routes.set(`GET ${USAGE_PATH}`, usageReply({ balance_activated: false, balance_money: 0 }))
    await renderCard()
    const row = rowButton()
    expect(row.textContent).toContain('—')
    // 长文案不得出现在行内（行只有 34px）。
    expect(row.textContent).not.toContain('余额未开通')
    expect(row.getAttribute('title')).toContain('余额未开通')
    expect(row.getAttribute('aria-label')).toContain(USERNAME)
    expect(row.getAttribute('aria-label')).toContain('余额未开通')
  })

  it('管理员未开通：说明文案是「管理员」', async () => {
    routes.set(`GET ${USAGE_PATH}`, usageReply({ balance_activated: false, is_admin: true }))
    await renderCard()
    expect(rowButton().getAttribute('aria-label')).toContain('管理员')
  })
})

describe('向上浮层（spec §6）', () => {
  it('点行打开浮层：内容与原卡片逐字一致', async () => {
    await renderCard()
    const row = rowButton()
    expect(dialog()).toBeNull()
    await press(row)
    const panel = dialog()
    expect(panel).not.toBeNull()
    expect(row.getAttribute('aria-expanded')).toBe('true')
    expect(panel!.getAttribute('aria-label')).toBe('账户')
    const text = panel!.textContent ?? ''
    expect(text).toContain('¥89.65')
    expect(text).toContain('账户余额')
    expect(text).toContain('每月发放 ¥100.00')
    expect(text).toContain('本月已用 ¥12.30 · 今日 ¥1.20')
    expect(buttonByText(panel!, '刷新').textContent).toContain('↻')
    expect(buttonByText(panel!, '退出登录')).toBeDefined()
    expect(panel!.textContent).toContain(USERNAME)
    // 分隔线（刷新行与用户名行之间那条 1px 线）。
    expect([...panel!.querySelectorAll('div')].some((el) => el.style.height === '1px')).toBe(true)
    // 浮层是 body portal（侧栏列的 overflow 裁不到它）。
    expect(panel!.parentElement).toBe(document.body)
    expect(panel!.style.position).toBe('fixed')
    expect(panel!.style.bottom).not.toBe('')
  })

  it('Esc 关闭浮层并把焦点还给行', async () => {
    await renderCard()
    const row = rowButton()
    await press(row)
    expect(dialog()).not.toBeNull()
    await pressKey('Escape')
    expect(dialog()).toBeNull()
    expect(row.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(row)
  })

  it('落到行与浮层之外的 pointerdown 关闭浮层', async () => {
    await renderCard()
    await press(rowButton())
    expect(dialog()).not.toBeNull()
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    })
    expect(dialog()).toBeNull()
  })

  it('浮层内部的 pointerdown 不关闭（点刷新按钮的前半程）', async () => {
    await renderCard()
    await press(rowButton())
    const panel = dialog()!
    await act(async () => {
      buttonByText(panel, '刷新').dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    })
    expect(dialog()).not.toBeNull()
  })
})

describe('浮层里的接口调用（行为不丢）', () => {
  it('刷新打到 ?refresh=1、更新金额、浮层保持打开', async () => {
    await renderCard()
    await press(rowButton())
    const panel = dialog()!
    routes.set(`GET ${REFRESH_PATH}`, usageReply({ balance_money: 42.5 }))
    await press(buttonByText(panel, '刷新'))
    expect(calls).toContain(`GET ${REFRESH_PATH}`)
    expect(dialog()).not.toBeNull()
    expect(dialog()!.textContent).toContain('¥42.50')
  })

  it('刷新有重入闸：同一批次连点两次只发一次 ?refresh=1（审计 P2-c）', async () => {
    await renderCard()
    await press(rowButton())
    const panel = dialog()!
    // 请求挂起 → 按钮还没变 disabled，第二次点击真的会再次进 handler。
    routes.set(`GET ${REFRESH_PATH}`, { ...usageReply({ balance_money: 42.5 }), defer: true })
    const refresh = buttonByText(panel, '刷新')
    await act(async () => { refresh.click(); refresh.click() })
    expect(calls.filter((call) => call === `GET ${REFRESH_PATH}`)).toHaveLength(1)
    releaseDeferred()
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0) }) })
    expect(dialog()!.textContent).toContain('¥42.50')
  })

  it('退出登录打到 POST /api/pico/auth/logout，失败就地显示错误', async () => {
    await renderCard()
    await press(rowButton())
    const panel = dialog()!
    routes.set(`POST ${LOGOUT_PATH}`, { status: 500, body: { error: 'boom' } })
    await press(buttonByText(panel, '退出登录'))
    expect(calls).toContain(`POST ${LOGOUT_PATH}`)
    expect(dialog()!.textContent).toContain('退出失败')
  })

  it('退出有重入闸：同一批次连点两次只发一次 POST（审计 P2-d）', async () => {
    await renderCard()
    await press(rowButton())
    const panel = dialog()!
    routes.set(`POST ${LOGOUT_PATH}`, { status: 500, body: { error: 'boom' }, defer: true })
    const logout = buttonByText(panel, '退出登录')
    await act(async () => { logout.click(); logout.click() })
    expect(calls.filter((call) => call === `POST ${LOGOUT_PATH}`)).toHaveLength(1)
    releaseDeferred()
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0) }) })
    expect(dialog()!.textContent).toContain('退出失败')
  })

  it('退出成功分支：POST 200 后停在「退出中…」且不显示错误文案', async () => {
    await renderCard()
    await press(rowButton())
    routes.set(`POST ${LOGOUT_PATH}`, { status: 200, body: { ok: true } })
    await press(buttonByText(dialog()!, '退出登录'))
    expect(calls).toContain(`POST ${LOGOUT_PATH}`)
    // 200 分支进入 `location.reload()`（jsdom 下不可观测，见文件头说明）：
    // 可观测的是"没有走失败回滚" —— 按钮留在退出中态、没有错误行。
    expect(buttonByText(dialog()!, '退出中').disabled).toBe(true)
    expect(dialog()!.textContent).not.toContain('退出失败')
  })

  it('挂载即轮询两个只读路由（语义未改）', async () => {
    await renderCard()
    expect(calls).toContain(`GET ${AUTH_PATH}`)
    expect(calls).toContain(`GET ${USAGE_PATH}`)
  })

  it('未登录时整行不渲染（登录页拥有该状态）', async () => {
    routes.set(`GET ${AUTH_PATH}`, { body: { loggedIn: false } })
    await renderCard()
    expect(footArea.querySelector('button')).toBeNull()
    expect(dialog()).toBeNull()
  })
})

describe('令牌失效（2026-09-12 P1-5 规则）', () => {
  it('轮询撞上服务端 401：行立刻转 —，不再显示上一次成功取的金额（审计 P2-a）', async () => {
    // 假表必须在挂载前装：轮询的 setInterval 是在挂载期创建的。
    vi.useFakeTimers()
    try {
      await act(async () => { root.render(<AccountCard {...slotProps(true)} />) })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(rowButton().textContent).toContain('¥89.65')

      // 第二拍：会话失效（路由层 401）。**响应体仍带着上一次的快照**（真实
      // 网关 401 时宿主缓存也还没清）—— 只按 body 走就会把过期金额当当前余额
      // 显示出来，这正是 P1-5 规则要拦的那条。
      routes.set(`GET ${USAGE_PATH}`, {
        status: 401,
        body: { data: usageSnapshot(), fetchedAt: 1, state: 'idle', error: null },
      })
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })

      const row = rowButton()
      expect(row.textContent).not.toContain('¥89.65')
      expect(row.textContent).toContain('—')
      const placeholder = [...row.querySelectorAll('span')].find((span) => span.textContent === '—')
      expect(placeholder?.style.color).toBe('var(--dsw-alias-label-secondary)')
      expect(row.getAttribute('aria-label')).toContain('余额获取失败')
      expect(row.getAttribute('title')).toContain('余额获取失败')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('无障碍焦点（审计 P2-a11y）', () => {
  it('打开后焦点进入浮层（Tab 的第一站就是浮层里的控件），Esc 后回到行', async () => {
    await renderCard()
    const row = rowButton()
    await press(row)
    const panel = dialog()!
    expect(panel.getAttribute('tabindex')).toBe('-1')
    expect(document.activeElement).toBe(panel)
    expect(panel.contains(document.activeElement)).toBe(true)
    // 浮层不是模态：不许用 aria-modal（兄弟「更多」行的 Esc 守卫会礼让模态）。
    expect(panel.getAttribute('aria-modal')).toBeNull()
    await pressKey('Escape')
    expect(document.activeElement).toBe(row)
  })
})

describe('跨行交互（与「更多」行同一套刺激，审计 P1）', () => {
  it('只有 click 的激活（键盘/程序化 .click()）也会关掉账户浮层', async () => {
    await renderCard()
    await press(rowButton())
    expect(dialog()).not.toBeNull()
    // 旁边「更多」行被键盘/`.click()` 激活时只发 click、没有 pointerdown
    //（兄弟行 `FootMenuRow` 自己就同时听 pointerdown + click，这里用同款刺激）。
    const sibling = document.createElement('button')
    sibling.type = 'button'
    document.body.appendChild(sibling)
    try {
      await act(async () => { sibling.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      expect(dialog()).toBeNull()
    } finally {
      sibling.remove()
    }
  })
})

describe('宽窄栏切换（审计 P2：浮层不许留在旧几何上）', () => {
  it('宽 → 窄轨时行节点被换掉，浮层按新锚点重算', async () => {
    const rectOf = (r: { left: number, top: number, width: number, height: number }): DOMRect => ({
      ...r,
      right: r.left + r.width,
      bottom: r.top + r.height,
      x: r.left,
      y: r.top,
      toJSON: () => ({}),
    }) as DOMRect
    // jsdom 的 rect 全是 0，量不出"几何有没有跟着锚点走" —— 这里把 rect 钉死，
    // 而且**按元素**给：带 data-rail 的行才拿到窄轨几何。这样"重算时量的还是旧
    // 节点"也会被抓到（旧节点拿宽栏几何，断言直接对不上）。
    const WIDE_RECT = rectOf({ left: 20, top: 700, width: 260, height: 34 })
    const RAIL_RECT = rectOf({ left: 12, top: 720, width: 32, height: 32 })
    const original = Object.getOwnPropertyDescriptor(Element.prototype, 'getBoundingClientRect')
    Object.defineProperty(Element.prototype, 'getBoundingClientRect', {
      configurable: true,
      writable: true,
      value: function (this: Element): DOMRect {
        return (this as HTMLElement).dataset.rail === 'true' ? RAIL_RECT : WIDE_RECT
      },
    })
    try {
      await renderCard(true)
      const wideRow = rowButton()
      expect(wideRow.dataset.rail).toBeUndefined()
      await press(wideRow)
      expect(dialog()!.style.width).toBe('260px')
      expect(dialog()!.style.left).toBe('20px')
      expect(dialog()!.style.bottom).toBe('74px')

      // 收起侧栏：宽栏渲染裸行、窄轨渲染 Tooltip 包着的行 ⇒ React 换节点。
      await act(async () => { root.render(<AccountCard {...slotProps(false)} />) })
      const railRow = rowButton()
      expect(railRow).not.toBe(wideRow)
      expect(railRow.dataset.rail).toBe('true')
      expect(dialog()).not.toBeNull()
      expect(dialog()!.style.width).toBe('200px')
      expect(dialog()!.style.left).toBe('12px')
      expect(dialog()!.style.bottom).toBe('54px')
    } finally {
      if (original !== undefined) Object.defineProperty(Element.prototype, 'getBoundingClientRect', original)
    }
  })
})

describe('窄轨（wide === false）', () => {
  it('仍是头像圆按钮，点它能打开同一个浮层', async () => {
    await renderCard(false)
    const row = rowButton()
    expect(row.textContent).toBe('U')
    // 窄轨可自证：Tooltip 在用例里是替身，行本身带 data-rail 标记。
    expect(row.dataset.rail).toBe('true')
    expect(row.style.borderRadius).toBe('50%')
    expect(row.style.width).toBe('32px')
    expect(row.style.height).toBe('32px')
    // 窄轨保留原来的着色头像底（不是透明底的一个字母）。
    expect(row.style.background).toBe('var(--dsw-alias-interactive-bg-hover-accent)')
    expect(row.getAttribute('aria-haspopup')).toBe('dialog')
    expect(row.getAttribute('aria-expanded')).toBe('false')
    expect(row.getAttribute('aria-label')).toContain(USERNAME)
    await press(row)
    expect(row.getAttribute('aria-expanded')).toBe('true')
    const panel = dialog()
    expect(panel).not.toBeNull()
    expect(panel!.textContent).toContain('¥89.65')
    expect(panel!.textContent).toContain('退出登录')
    // 浮层比 56px 轨道宽，靠 fixed 定位而不是被裁掉。
    expect(panel!.style.position).toBe('fixed')
    expect(Number.parseInt(panel!.style.width, 10)).toBeGreaterThanOrEqual(200)
  })
})

describe('注入样式（hover 真的生效）', () => {
  it('注入的样式表同时给出基准底与 :hover，且行不带内联底色；卸载时移除', async () => {
    const fixture = clientFixture()
    apply(fixture.ctx)

    // jsdom 不算 :hover 伪类，所以断言的是"注入的规则文本 + 规则落在行身上"。
    const styles = injectedRowStyles()
    expect(styles).toHaveLength(1)
    const css = styles[0]!.textContent ?? ''
    expect(css).toContain('.pico-account-row { background: transparent; }')
    expect(css).toContain('.pico-account-row:hover { background: var(--dsw-alias-interactive-bg-hover); }')

    await renderCard()
    const row = rowButton()
    expect(row.className).toBe('pico-account-row')
    // 关键回归：内联 `background` 会顶掉样式表里的 :hover（hover 变死规则）。
    expect(row.style.background).toBe('')

    for (const dispose of fixture.disposers) dispose()
    expect(injectedRowStyles()).toHaveLength(0)
  })
})

describe('字典（zh 是 key 源）', () => {
  it('en 覆盖 zh 的每一个 key', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('新增的账户标题 / 行标签成对存在', () => {
    expect(zh['account.title']).toBe('账户')
    expect(en['account.title']).toBe('Account')
    expect(zh['account.rowLabel']).toContain('{username}')
    expect(zh['account.rowLabel']).toContain('{balance}')
    expect(en['account.rowLabel']).toContain('{username}')
    expect(zh['account.rowLabelLow']).not.toBe(zh['account.rowLabel'])
    expect(en['account.rowLabelLow']).not.toBe(en['account.rowLabel'])
  })
})
