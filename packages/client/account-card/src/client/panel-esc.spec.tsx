// @vitest-environment jsdom
/**
 * 「一次 Esc 只关一层」——账户浮层（内层模态）与整页面板（外层装载器）的回归。
 *
 * ## 被这条用例钉住的缺陷
 *
 * 账户行是常驻侧栏的（四个整页面板打开时它也在），它的浮层是**内层模态**。
 * 整页面板的 Esc 唯一权威是装载器 `@picoaide/dsh-panel-surface`：它在 `document`
 * 上按 `[role="dialog"][aria-modal="true"]`（或 alertdialog）**让位**给内层模态。
 * 浮层此前只声明了 `role="dialog"`、**没有 `aria-modal`**，装载器因此不认它 ——
 * 同一次按键被两层各处理一次（两个监听器都在 document 上，先注册的装载器 +
 * 后注册的浮层，`stopPropagation` 拦不住同一 target 上的另一份）
 * ⇒ **弹层与整个整页面板一起关掉**。
 *
 * 所以本文件刻意**挂真的装载器**（`mountPanelSurface`），而不是在测试里另写一份
 * "如果遇到模态就让位"的替身：替身会随装载器漂移，而这条缺陷的全部机制都在
 * "装载器认不认这个模态"上。
 *
 * ## 覆盖
 *  ① 详情浮层里按一次 Esc（**真键盘路径**：`keydown` 从 `document.activeElement`
 *    派发、沿 DOM 冒泡）⇒ 浮层关、整页面板仍在（`data-dsh-panel-active` 不变）；
 *  ② Esc 在浮层元素上就被消费 ⇒ `document` 上**后注册**的监听器也收不到它
 *    （`stopPropagation` 能挡住别的节点，挡不住同一 target 上后注册的那份，
 *    所以这条只能由"更早的一层"来保证）；
 *  ③ 浮层自己声明了 ARIA 模态契约（`role=dialog` + `aria-modal=true`）——
 *    装载器的让位判据认的正是这一对（判据同形，不是为内层改判据）；
 *  ④ 兜底：焦点已经离开浮层（Tab 走开 / 自动化在 document 上派发）时仍由浮层
 *    自己关掉，且同样不牵连整页面板；
 *  ⑤ Esc 收起后焦点回到触发它的行。
 *
 * ---- 变异验证（实测：拆掉修复的每一半都有用例变红，见下表） ----
 *   - 浮层去掉 `aria-modal="true"`（回到"只有 role=dialog"）⇒ ③（契约判据认不出这层）
 *     与 ④（装载器不再让位 ⇒ 兜底那条路径上两层都关）红；
 *   - 去掉浮层元素上的那份 keydown（只剩 document 兜底）⇒ ② 红
 *     （同一 target 上后注册的监听器照样收到那次按键）；
 *   - 去掉 document 上那份兜底 ⇒ ④ 红（焦点不在浮层里时没人接 Esc）；
 *   - Esc 收起后不 `rowRef.current?.focus()` ⇒ ⑤ 红。
 *
 * ① 在"去掉 aria-modal"这条变异下**仍然绿**是有意的、也是事实：焦点在浮层里时事件在
 * 浮层元素上就被消费了，装载器根本收不到 —— 那正是①要钉的性质（与注册顺序无关）。
 * 缺了 ARIA 契约会漏的是"焦点已离开浮层"那条路径，判据放在 ③/④，不是把①写成
 * "顺便证明契约"。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PANEL_ACTIVE_ATTR,
  activePanelId,
  hasInnerModal,
  mountPanelSurface,
  type PanelSurfaceHandle,
} from '@picoaide/dsh-panel-surface/client'
import { AccountCard } from './AccountCard.tsx'
import { setActiveLocale } from './locales.ts'

// 与 AccountCard.spec.tsx 同一条替身理由：primitive 包的运行时外部依赖是 shell
// 预置模块，node 下刻意不存在。替身只做"Tooltip 原样渲染锚点"，浮层开关/Esc/取数
// 全在组件内部实现，不走替身。
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Tooltip: (props: { children: unknown }) => props.children,
}))

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** 占位账号（不是任何真实渠道/客户身份）。 */
const USERNAME = 'user001'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

let root: Root
let container: HTMLDivElement
let footArea: HTMLDivElement
let panel: PanelSurfaceHandle

beforeEach(() => {
  setActiveLocale('zh')
  document.body.innerHTML = ''
  document.documentElement.removeAttribute(PANEL_ACTIVE_ATTR)
  vi.stubGlobal('fetch', vi.fn(async (input: unknown): Promise<Response> => {
    const url = typeof input === 'string' ? input : String(input)
    if (url.startsWith('/api/pico/auth/state')) {
      return jsonResponse({ loggedIn: true, username: USERNAME, serverURL: 'https://gw.example' })
    }
    if (url.startsWith('/api/pico/account/usage')) {
      return jsonResponse({
        data: {
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
        },
        fetchedAt: 1,
        state: 'idle',
        error: null,
      })
    }
    throw new Error(`unrouted request: ${url}`)
  }))
  // 中列：装载器容器的落点（与桌面壳 `.dshDesktopConversationSurface` 同形）。
  const column = document.createElement('div')
  column.className = 'dshDesktopConversationSurface'
  document.body.appendChild(column)
  // 账户行 portal 的落点：`[class$="_footArea"]`（与上游侧栏 class 后缀同判据）。
  footArea = document.createElement('div')
  footArea.className = 'spec_footArea'
  document.body.appendChild(footArea)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  // **真的面板装载器**（不是替身）：这条缺陷的全部机制都在它的让位判据上。
  panel = mountPanelSurface({
    id: 'capability',
    render: () => <div data-testid="panel-body">能力中心</div>,
  })
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  panel.dispose()
  document.documentElement.removeAttribute(PANEL_ACTIVE_ATTR)
  vi.unstubAllGlobals()
})

/** 渲染账户行并冲掉挂载期那两次 fetch。 */
async function renderCard(): Promise<void> {
  await act(async () => {
    root.render(<AccountCard {...({ wide: true } as unknown as PropsRuntime<'sidebar.footer.action'>)} />)
  })
  await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0) }) })
}

/** 打开整页面板 + 点开账户浮层；返回浮层元素。 */
async function openPanelAndPopover(): Promise<HTMLElement> {
  await act(async () => { panel.activate() })
  await renderCard()
  const row = footArea.querySelector('button')
  expect(row, '账户行').not.toBeNull()
  await act(async () => { row!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })) })
  await act(async () => { row!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  const popover = popoverElement()
  expect(popover, '账户浮层').not.toBeNull()
  return popover!
}

function popoverElement(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('[role="dialog"]')
}

/** 真键盘路径：事件从**获得焦点的元素**上派发，沿 DOM 冒泡。 */
async function pressEscapeFromFocus(): Promise<void> {
  await act(async () => {
    const focused = document.activeElement ?? document.body
    focused.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  })
}

describe('一次 Esc 只关一层（账户浮层 vs 整页面板）', () => {
  it('详情浮层里按一次 Esc ⇒ 只关浮层，整页面板留在原位', async () => {
    const popover = await openPanelAndPopover()
    // 打开浮层会把焦点移进浮层（下面的用例⑤单独钉这一条）。
    expect(popover.contains(document.activeElement), '焦点在浮层里').toBe(true)

    await pressEscapeFromFocus()

    expect(popoverElement(), '内层（浮层）必须关掉').toBeNull()
    expect(activePanelId(document), '外层（整页面板）不许被同一次按键关掉').toBe('capability')
    expect(document.querySelector('[data-testid="panel-body"]'), '面板内容仍在').not.toBeNull()
  })

  it('Esc 在浮层元素上就被消费：document 上后注册的监听器也收不到', async () => {
    const popover = await openPanelAndPopover()
    const seen: string[] = []
    const probe = (event: KeyboardEvent): void => { if (event.key === 'Escape') seen.push('document') }
    // 注册顺序刻意**晚于**浮层：`stopPropagation` 只挡别的节点，不挡同一 target 上
    // 后注册的那份 —— 所以"事件根本不冒到 document"这件事只能由更早的一层保证。
    document.addEventListener('keydown', probe)
    try {
      await pressEscapeFromFocus()
    } finally {
      document.removeEventListener('keydown', probe)
    }
    expect(seen, 'document 上的其它层不该看到这次 Esc').toEqual([])
    expect(popover.isConnected, '浮层仍应被它自己关掉').toBe(false)
    expect(activePanelId(document)).toBe('capability')
  })

  it('浮层声明的 ARIA 契约与装载器判据同形（role=dialog + aria-modal=true）', async () => {
    const popover = await openPanelAndPopover()
    expect(popover.getAttribute('role')).toBe('dialog')
    expect(popover.getAttribute('aria-modal')).toBe('true')
    expect(popover.getAttribute('aria-label')).not.toBeNull()
    expect(popover.getAttribute('tabindex')).toBe('-1')
    // 判据是**装载器自己导出的那一个**（不是测试里另抄一份选择器）：
    // 它必须认这一层模态，否则外层照常吃掉同一次 Esc。
    expect(hasInnerModal(document), '装载器的让位判据必须认这层模态').toBe(true)
  })

  it('兜底：焦点已离开浮层（在 document 上派发）时仍只关浮层', async () => {
    const popover = await openPanelAndPopover()
    await act(async () => { (document.activeElement as HTMLElement | null)?.blur() })
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    expect(popoverElement(), '浮层关掉').toBeNull()
    expect(popover.isConnected).toBe(false)
    expect(activePanelId(document), '整页面板仍在').toBe('capability')
  })

  it('Esc 收起后焦点回到触发它的行', async () => {
    await openPanelAndPopover()
    const row = footArea.querySelector('button')!
    await pressEscapeFromFocus()
    expect(popoverElement()).toBeNull()
    expect(document.activeElement).toBe(row)
  })
})
