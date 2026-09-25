// @vitest-environment jsdom
/**
 * 回归（R16B-01，第十六轮审计泳道 B，P1，**渲染半边**）：一份余额只许在
 * **取它的那个会话身份**下渲染。
 *
 * 宿主路由已经把"跨账号交付"堵在出口（见 `r16b-account-switch-route.spec.ts`），
 * 但客户端不能只依赖对端：`/api/pico/auth/state` 与 `/api/pico/account/usage` 是
 * **两次独立请求**，可能落在换号点的两侧；而检测到"换号"需要**先观察过旧身份**
 * （刚挂载就撞上切换的那一跳没有旧身份可比）。所以路由在每一份快照上盖了身份章
 * （`sessionIdentity`），本组件的判据是：
 *
 *   快照章 ≠ `/api/pico/auth/state` 的 `identity`  ⇒ **整份作废**（余额与用量一起），
 *   刷新按钮同时禁用（此刻它没有可刷的对象）。
 *
 * ---- 变异验证（实跑过，逐条单独一次调用）----
 *   - `identityMismatch` 恒 false（去掉渲染期比较）⇒ 用例①红（`Bbob · ¥11.00` 回来了）；
 *   - 采纳响应时改用"本批 auth 的身份"盖章（丢掉 body 自带的章）⇒ 用例①红；
 *   - `metaParts` 不跟 `stale` 一起作废 ⇒ 用例②红（用量行仍在交付上一个账号的数字）。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AccountCard } from '../src/client/AccountCard.tsx'
import { setActiveLocale } from '../src/client/locales.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Tooltip: (props: { children: unknown }) => props.children,
}))

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const AUTH_PATH = '/api/pico/auth/state'
const USAGE_PATH = '/api/pico/account/usage'
const SERVER = 'https://gw.example'

/** 会话身份串（与 enterprise `session-identity.ts` 同形：`[serverURL, username]`）。 */
const identity = (username: string): string => JSON.stringify([SERVER, username])

interface Reply { status?: number, body?: unknown }

function snapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    balance_money: 0,
    balance_activated: true,
    balance_enabled: true,
    balance_monthly: 0,
    balance_mode: 'add',
    is_admin: false,
    monthly_usage: 0,
    monthly_cost: 0,
    today_usage: 0,
    today_cost: 0,
    yesterday_usage: 0,
    yesterday_cost: 0,
    total_usage: 0,
    total_cost: 0,
    ...overrides,
  }
}

/** `/api/pico/account/usage` 的 200：`data` 是快照，`identity` 是**宿主盖的章**。 */
function usageReply(balance: number, owner: string, extra: Record<string, unknown> = {}): Reply {
  return {
    body: {
      data: snapshot({ balance_money: balance, monthly_cost: 3.5, ...extra }),
      fetchedAt: 1,
      state: 'idle',
      error: null,
      identity: identity(owner),
    },
  }
}

function authReply(username: string): Reply {
  return { body: { loggedIn: true, username, serverURL: SERVER, identity: identity(username) } }
}

let container: HTMLDivElement
let footArea: HTMLDivElement
let root: Root
let routes: Map<string, Reply>

beforeEach(() => {
  setActiveLocale('zh')
  routes = new Map<string, Reply>([
    [`GET ${AUTH_PATH}`, authReply('alice')],
    [`GET ${USAGE_PATH}`, usageReply(11, 'alice')],
    [`GET ${USAGE_PATH}?refresh=1`, usageReply(11, 'alice')],
  ])
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : String(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    const reply = routes.get(`${method} ${url}`)
    if (reply === undefined) throw new Error(`unrouted request: ${method} ${url}`)
    return new Response(JSON.stringify(reply.body ?? null), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }))
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
  vi.unstubAllGlobals()
})

function rowButton(): HTMLButtonElement {
  const row = footArea.querySelector('button')
  expect(row).not.toBeNull()
  return row as HTMLButtonElement
}

function dialog(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('[role="dialog"]')
}

async function press(element: Element): Promise<void> {
  await act(async () => { element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })) })
  await act(async () => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

/** 浮层里的「刷新」按钮（浮层里唯一带 ↻ 的那个）。 */
function refreshButton(): HTMLButtonElement {
  const panel = dialog()
  expect(panel).not.toBeNull()
  const button = [...panel!.querySelectorAll('button')].find((node) => (node.textContent ?? '').includes('↻'))
  expect(button, '浮层里应当有刷新按钮').toBeDefined()
  return button as HTMLButtonElement
}

/** 渲染并冲掉挂载期那两次 fetch。 */
async function renderCard(): Promise<void> {
  await act(async () => { root.render(<AccountCard wide />) })
  await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0) }) })
}

describe('R16B-01：余额只在取它的会话身份下渲染', () => {
  it('① 挂载时已经是新账号、但拿到的是上一个账号盖过章的快照 ⇒ 不渲染该金额', async () => {
    // 服务端已经把身份切到 bob，而这一发 usage 是切换**之前**生成的（章是 alice）。
    routes.set(`GET ${AUTH_PATH}`, authReply('bob'))
    routes.set(`GET ${USAGE_PATH}`, usageReply(11, 'alice'))

    await renderCard()

    // 行内不得出现上一个账号的金额；停在**不可信占位**（`—` + 「余额获取失败」，
    // 与令牌失效 P1-5 同一套词汇：余额属于计费口径，宁可留白不可展示错数）。
    expect(rowButton().textContent, '换号窗口内渲染了上一个账号的余额').not.toContain('11.00')
    expect(rowButton().textContent).toContain('—')
    expect(rowButton().getAttribute('aria-label')).toContain('余额获取失败')
    expect(dialog()).toBeNull()

    // 浮层里刷新按钮必须禁用（这份数字不属于当前账号，没有可刷的对象）。
    await press(rowButton())
    expect(refreshButton().disabled, '身份不符期间刷新按钮必须禁用').toBe(true)
    expect(dialog()!.textContent).not.toContain('¥11.00')
  })

  it('② 轮询观察到换号 ⇒ 丢弃这一发；下一拍在新身份下重取才渲染', async () => {
    vi.useFakeTimers()
    try {
      await act(async () => { root.render(<AccountCard wide />) })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(rowButton().textContent).toContain('¥11.00')

      // 第二拍：身份变成 bob，但 usage 回包仍带着 alice 的章与金额（宿主未修 /
      // 响应生成于切换之前 —— 这一发无论来自哪条路径都不可信）。
      routes.set(`GET ${AUTH_PATH}`, authReply('bob'))
      routes.set(`GET ${USAGE_PATH}`, usageReply(11, 'alice'))
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
      expect(rowButton().textContent, '换号那一拍渲染了上一个账号的余额').not.toContain('11.00')

      // 第三拍：bob 自己的余额（章也对上了）⇒ 正常渲染。
      routes.set(`GET ${USAGE_PATH}`, usageReply(22, 'bob'))
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
      expect(rowButton().textContent).toContain('¥22.00')
    } finally {
      vi.useRealTimers()
    }
  })

  it('③ 身份不符时用量行（metaParts）也必须一起作废，不能只作废金额', async () => {
    routes.set(`GET ${AUTH_PATH}`, authReply('bob'))
    // 章是 alice ⇒ 整份不可信；金额 0（不会被 ¥ 断言抓到），用量 3.5 才是这条的判据。
    routes.set(`GET ${USAGE_PATH}`, usageReply(0, 'alice'))

    await renderCard()
    await press(rowButton())
    expect(dialog()!.textContent, '不可信快照的用量行仍在渲染').not.toContain('3.50')
    expect(dialog()!.textContent).not.toContain('¥0.00')
  })
})
