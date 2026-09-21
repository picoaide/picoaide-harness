// @vitest-environment jsdom
/**
 * 中列装载器的行为断言（四个面板共用，所以这一份就是四个面板的切换语义）。
 *
 * 覆盖的是**机制**而不是某个面板的内容：
 *   - 容器落进中列、默认隐藏（样式表规则，不是行内 style）；
 *   - 激活时 `<html>` 上的唯一激活态属性被写入，关闭时被移除；
 *   - 两个面板互斥（打开 B 关掉 A，走 `dsh-panel-activate` 事件）；
 *   - 点侧边栏的行 ⇒ 自动让位；
 *   - Esc ⇒ 让位，但面板内开着真模态（`role=dialog aria-modal`）时不抢 Esc；
 *   - dispose 把容器/样式/监听全部收干净。
 *
 * ---- 变异验证 ----
 *   - 把容器隐藏写成行内 `element.style.display = 'none'` ⇒ 「默认隐藏靠样式表」红；
 *   - `activate()` 不派发 `dsh-panel-activate` ⇒ 「两个面板互斥」红；
 *   - `onKeyDown` 去掉 `role=dialog` 的闸 ⇒ 「模态开着时 Esc 归模态」红；
 *   - `dispose()` 不摘 keydown 监听 ⇒ 「dispose 之后 Esc 不报错/不再改属性」红。
 */
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PANEL_ACTIVE_ATTR, PANEL_SURFACE_ATTR, activePanelId } from '../src/index.ts'
import { mountPanelSurface } from '../src/client/surface.tsx'
import { PanelButton, PanelPage, SegmentedControl } from '../src/client/ui.tsx'

// React 18 的 `act` 需要这个全局标志，否则每条用例都会打一遍
// "The current testing environment is not configured to support act(...)"。
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let column: HTMLDivElement
let handles: Array<{ dispose: () => void }> = []

beforeEach(() => {
  document.body.innerHTML = ''
  document.documentElement.removeAttribute(PANEL_ACTIVE_ATTR)
  // 中列的存在形状就是桌面壳里的那一层（`.dshDesktopConversationSurface`）。
  column = document.createElement('div')
  column.className = 'dshDesktopConversationSurface'
  const conversation = document.createElement('div')
  conversation.textContent = '会话区'
  column.appendChild(conversation)
  document.body.appendChild(column)
})

afterEach(() => {
  for (const handle of handles) handle.dispose()
  handles = []
})

function mount(id: string, text: string) {
  const handle = mountPanelSurface({ id, render: () => <div data-testid={`body-${id}`}>{text}</div> })
  handles.push(handle)
  return handle
}

describe('中列整页装载器', () => {
  it('容器落进中列，且默认隐藏是样式表规则而不是行内样式', () => {
    mount('cron', '定时任务')
    const container = column.querySelector(`[${PANEL_SURFACE_ATTR}="cron"]`)
    expect(container).not.toBeNull()
    // 行内 display:none 会压过"显示"规则 ⇒ 面板永远出不来（真实踩过的 bug）。
    expect((container as HTMLElement).style.display).toBe('')
    const style = document.querySelector('style[data-dsh-panel-style="cron"]')
    expect(style?.textContent).toMatch(new RegExp(`\\[${PANEL_SURFACE_ATTR}\\] \\{[^}]*display: none`))
  })

  /**
   * 高度链的**规则**判据（2026-09-21「能力中心不能往下翻页」）。
   *
   * jsdom 没有排版引擎，量不出"能不能滚"——这里只能钉住"共享样式表必须下发这条
   * 规则"（防删除/防改选择器）。**真能力判据在 `scripts/e2e-client.mjs`**：真机注入
   * 超高内容后断言 `.pico-scroll` 真的溢出且 `scrollTop` 生效（改回 auto 链即红）。
   */
  it('共享样式表把容器高度透传给面板根包装层（滚动区有界的前提）', () => {
    mount('capability', '能力中心')
    const css = document.querySelector('style[data-dsh-panel-style="capability"]')?.textContent ?? ''
    expect(css).toContain(`html[${PANEL_ACTIVE_ATTR}] [${PANEL_SURFACE_ATTR}] > * { height: 100%; min-height: 0; }`)
    // 容器自己是"一页"：溢出必须被裁（否则内容会压到侧边栏上，且滚不动）。
    expect(css).toMatch(new RegExp(`\\[${PANEL_SURFACE_ATTR}\\] \\{[^}]*overflow: hidden`))
  })

  it('激活写唯一激活态属性并渲染内容；关闭把它摘掉并卸载内容', async () => {
    const handle = mount('cron', '定时任务')
    expect(document.querySelector('[data-testid="body-cron"]')).toBeNull()
    await act(async () => { handle.activate() })
    expect(activePanelId(document)).toBe('cron')
    expect(document.querySelector('[data-testid="body-cron"]')?.textContent).toBe('定时任务')
    await act(async () => { handle.close() })
    expect(activePanelId(document)).toBeNull()
    expect(document.querySelector('[data-testid="body-cron"]')).toBeNull()
  })

  it('两个面板互斥：打开 B 会把 A 挤下去', async () => {
    const a = mount('capability', '能力中心')
    const b = mount('apps', '应用中心')
    await act(async () => { a.activate() })
    expect(activePanelId(document)).toBe('capability')
    await act(async () => { b.activate() })
    expect(activePanelId(document)).toBe('apps')
    // 互斥不是"两边都以为自己开着"：A 的内容同样被卸载。
    expect(document.querySelector('[data-testid="body-capability"]')).toBeNull()
  })

  /**
   * 切换面板 = 旧面板的"关闭"，可见性回调必须走同一条出口（2026-09-21 真机审计）。
   *
   * `activate()` 曾经先写 `<html>` 激活属性、再派发激活事件，旧面板的 `close()` 因为
   * "当前激活的不是我"直接提前返回 ⇒ 不渲染 null（只是被 CSS 隐藏）、**不派发
   * `onVisibilityChange(false)`**。内容被卸载只是 MutationObserver 顺带救回来的，
   * 而可见性回调没有任何东西救——凡是靠它停轮询/停定时器的面板，切走后会一直跑。
   */
  it('切换到另一个面板时，旧面板的可见性回调必须触发 false', async () => {
    const seen: boolean[] = []
    const a = mountPanelSurface({
      id: 'capability',
      render: () => <div data-testid="body-capability" />,
      onVisibilityChange: value => { seen.push(value) },
    })
    handles.push(a)
    const b = mount('apps', '应用中心')
    await act(async () => { a.activate() })
    await act(async () => { b.activate() })
    expect(activePanelId(document)).toBe('apps')
    expect(seen).toEqual([true, false])
  })

  it('点侧边栏的行 ⇒ 自动让位（会话/项目/新建会话都算）', async () => {
    const handle = mount('connectors', '连接器')
    await act(async () => { handle.activate() })
    const row = document.createElement('div')
    row.className = 'sessionRow-x'
    document.body.appendChild(row)
    await act(async () => { row.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(activePanelId(document)).toBeNull()
  })

  it('Esc 让位；但面板内开着真模态时 Esc 归模态', async () => {
    const handle = mount('apps', '应用中心')
    await act(async () => { handle.activate() })
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('aria-modal', 'true')
    document.body.appendChild(dialog)
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(activePanelId(document)).toBe('apps')
    dialog.remove()
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(activePanelId(document)).toBeNull()
  })

  it('可见性回调只在真正变化时触发', async () => {
    const seen: boolean[] = []
    const handle = mountPanelSurface({ id: 'cron2', render: () => <div />, onVisibilityChange: value => { seen.push(value) } })
    handles.push(handle)
    await act(async () => { handle.activate() })
    await act(async () => { handle.activate() })
    await act(async () => { handle.close() })
    await act(async () => { handle.close() })
    expect(seen).toEqual([true, false])
  })

  it('dispose 之后不再响应 Esc，容器与样式都收干净', async () => {
    const handle = mount('apps', '应用中心')
    await act(async () => { handle.activate() })
    await act(async () => { handle.dispose() })
    handles = handles.filter(item => item !== handle)
    expect(activePanelId(document)).toBeNull()
    expect(document.querySelector(`[${PANEL_SURFACE_ATTR}="apps"]`)).toBeNull()
    expect(document.querySelector('style[data-dsh-panel-style="apps"]')).toBeNull()
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(activePanelId(document)).toBeNull()
  })
})

describe('共享视觉语言', () => {
  it('骨架带返回出口，标题与副标题都渲染', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const { createRoot } = await import('react-dom/client')
    const root = createRoot(host)
    await act(async () => {
      root.render(
        <PanelPage title="应用中心" subtitle="在客户端里打开的小应用" onClose={() => undefined} backLabel="返回聊天">
          <div>正文</div>
        </PanelPage>,
      )
    })
    expect(host.textContent).toContain('返回聊天')
    expect(host.textContent).toContain('应用中心')
    expect(host.textContent).toContain('在客户端里打开的小应用')
    expect(host.textContent).toContain('正文')
    root.unmount()
  })

  it('分段切换用真实 button[role=tab] 并标记当前项', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const { createRoot } = await import('react-dom/client')
    const root = createRoot(host)
    await act(async () => {
      root.render(
        <SegmentedControl
          ariaLabel="范围"
          value="mine"
          options={[{ value: 'mine', label: '我的' }, { value: 'market', label: '市场' }]}
          onChange={() => undefined}
        />,
      )
    })
    const tabs = [...host.querySelectorAll('button[role="tab"]')]
    expect(tabs).toHaveLength(2)
    expect(tabs[0]?.getAttribute('data-active')).toBe('true')
    expect(tabs[1]?.getAttribute('data-active')).toBe('false')
    root.unmount()
  })

  it('按钮变体落在类名上（颜色由样式表负责，才能有悬停反馈）', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const { createRoot } = await import('react-dom/client')
    const root = createRoot(host)
    await act(async () => {
      root.render(<PanelButton variant="primary">发布</PanelButton>)
    })
    const button = host.querySelector('button')
    expect(button?.className).toContain('pico-btn--primary')
    expect(button?.style.background).toBe('')
    root.unmount()
  })
})
