// @vitest-environment jsdom
/**
 * **组合**判据：真浮层（`FootMenuRow`）+ 真装载器（`mountPanelSurface`）。
 *
 * 为什么单包用例证明不了这条（2026-09-25 审计 FIX-29 P2）：
 *   · `foot-menu` 自己的用例用的是**替身** `activate`（不移动焦点），于是"点条目后焦点
 *     回到「更多」行"被写成契约 —— 而真实组合里装载器会把焦点移进面板，那句
 *     `closeMenu(true)` 恰好把焦点抢了回来；
 *   · `panel-surface` 自己的用例只覆盖"互斥/Esc/dispose"，`container.focus()` 那一行
 *     删掉 14 例全绿（判据缺失）。
 * 所以这条判据必须把两半接起来跑：点浮层条目 ⇒ 焦点在面板里；Esc ⇒ 面板关掉且焦点回到
 * 触发它的「更多」行。
 *
 * ---- 变异验证 ----
 *   - `FootMenuRow` 的条目 onClick 改回 `entry.activate(); closeMenu(true)`（不先交还
 *     锚点、且无条件抢回焦点）⇒「点条目后焦点进面板」红；
 *   - `FootMenuRow` 去掉 `closeMenu` 的"焦点已离开浮层"判据 ⇒ 同上红；
 *   - `surface.tsx` 的 `container?.focus(...)` 删掉 ⇒「点条目后焦点进面板」红；
 *   - `surface.tsx` 的 `closeAndMaybeRestoreFocus` 不归还焦点 ⇒「Esc 后焦点回到
 *     『更多』行」红；
 *   - `surface.tsx` 归还焦点时不判 `focusIsOurs()` ⇒「用户点到别处后关面板不抢焦点」红。
 *
 * 导入走 `vitest.config.ts` 的 alias 指向 `panel-surface` 的**源码**：判据必须咬住
 * 源码，而不是 `lib/` 里可能过期的构建产物（否则上面第一条变异杀不掉本用例）。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { PANEL_ACTIVE_ATTR, PANEL_SURFACE_ATTR, mountPanelSurface, type PanelSurfaceHandle } from '@picoaide/dsh-panel-surface/client'
import { createFootMenuService, installFootMenu, type FootMenuService } from '../src/client/contract.ts'
import { FootMenuRow } from '../src/client/FootMenuRow.tsx'
import { setActiveLocale } from '../src/client/locales.ts'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let column: HTMLDivElement
let root: Root
let surface: PanelSurfaceHandle

const row = (): HTMLButtonElement => document.querySelector<HTMLButtonElement>('.pico-foot-menu-trigger')!
const menu = (): HTMLDivElement => document.querySelector<HTMLDivElement>('[role="menu"]')!
const items = (): HTMLButtonElement[] => [...menu().querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
const panelContainer = (): HTMLDivElement => column.querySelector<HTMLDivElement>(`[${PANEL_SURFACE_ATTR}="cron"]`)!

async function open(): Promise<void> {
  await act(async () => { row().dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

beforeEach(() => {
  setActiveLocale('zh')
  document.documentElement.removeAttribute(PANEL_ACTIVE_ATTR)
  document.body.innerHTML = ''
  // 中列的形态就是桌面壳里的那一层（装载器只认它）。
  column = document.createElement('div')
  column.className = 'dshDesktopConversationSurface'
  document.body.appendChild(column)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)

  // 真装载器：条目点开的那个面板就是它。
  surface = mountPanelSurface({ id: 'cron', render: () => <div data-testid="cron-body">定时任务</div> })
  const service: FootMenuService = createFootMenuService()
  installFootMenu({ provide: () => undefined } as unknown as Context, service)
  service.add({ id: 'cron', order: -10, title: () => '定时任务', activate: () => { surface.activate() } })
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  surface.dispose()
  container.remove()
  document.body.innerHTML = ''
  document.documentElement.removeAttribute(PANEL_ACTIVE_ATTR)
})

describe('焦点交接：底部「更多」浮层 → 中列整页面板', () => {
  it('从浮层条目打开面板：焦点进入面板（Tab 能继续往里走）', async () => {
    await act(async () => { root.render(<FootMenuRow wide={true} />) })
    await open()
    await act(async () => { items()[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

    expect(menu().style.display, '浮层必须收起').toBe('none')
    expect(PANEL_ACTIVE_ATTR && document.documentElement.getAttribute(PANEL_ACTIVE_ATTR)).toBe('cron')
    expect(document.activeElement, '焦点必须落在面板容器上，而不是被浮层抢回侧边栏行')
      .toBe(panelContainer())
  })

  it('Esc 关闭面板：焦点归还给触发它的「更多」行（与装载器的归还契约配对）', async () => {
    await act(async () => { root.render(<FootMenuRow wide={true} />) })
    await open()
    await act(async () => { items()[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(document.activeElement).toBe(panelContainer())

    // 真键盘路径：从**获得焦点的元素**上冒泡（装载器的 Esc 监听在 document 冒泡阶段）。
    await act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    expect(document.documentElement.getAttribute(PANEL_ACTIVE_ATTR)).toBeNull()
    expect(document.activeElement, '归还目标必须是常驻的「更多」行，而不是随浮层消失的条目按钮').toBe(row())
  })

  it('面板开着时用户点到别处：关闭面板不把焦点抢回来', async () => {
    await act(async () => { root.render(<FootMenuRow wide={true} />) })
    await open()
    await act(async () => { items()[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

    const elsewhere = document.createElement('button')
    document.body.appendChild(elsewhere)
    await act(async () => { elsewhere.focus() })
    await act(async () => { surface.close() })
    expect(document.activeElement, '焦点已经不在面板里 ⇒ 装载器不得抢').toBe(elsewhere)
    elsewhere.remove()
  })
})
