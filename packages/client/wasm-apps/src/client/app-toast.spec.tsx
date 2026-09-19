// @vitest-environment jsdom
/**
 * 主窗口 toast（§5.3/§19 Q5 异渠道深链提示）的文案与渲染判据。
 *
 * 三件事各自有用例：
 *  1. **冻结文案逐字**（中英各一份）—— 它写在总纲里，改写即回归；
 *  2. **只在异渠道事件上出现**（接缝在 `index.spec.ts`：宿主广播 → 插件 → store）；
 *  3. 一次性：关闭即消失、到点自动消失（不常驻）。
 *
 * ---- 变异验证 ----
 *   - `foreignDeepLinkToastText` 改写一个标点 ⇒「冻结文案」红；
 *   - `AppToastHost` 无条件渲染（不看 store）⇒「默认不渲染」红；
 *   - 关闭按钮不清 store ⇒「关闭即消失」红。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  APP_TOAST_TTL_MS,
  AppToastHost,
  clearAppToast,
  currentAppToast,
  foreignDeepLinkToastText,
  showAppToast,
} from './app-toast.tsx'
import { en, setActiveLocale, zh } from './locales.ts'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  setActiveLocale('zh')
  clearAppToast()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  clearAppToast()
  vi.useRealTimers()
})

async function renderHost(): Promise<void> {
  await act(async () => { root.render(<AppToastHost />) })
}

describe('冻结文案（§5.3/§19 Q5 逐字）', () => {
  it('zh 逐字等于总纲那一句', () => {
    expect(zh['appCenter.toast.foreignDeepLink'])
      .toBe('这个链接属于另一家企业的客户端，请让对方用你们客户端的『复制链接』重发')
    expect(foreignDeepLinkToastText()).toBe(zh['appCenter.toast.foreignDeepLink'])
  })

  it('en 是同一句话的镜像（不是空串、不是中文）', () => {
    setActiveLocale('en')
    const text = foreignDeepLinkToastText()
    expect(text).toBe(en['appCenter.toast.foreignDeepLink'])
    expect(text).not.toBe('')
    expect(text).not.toMatch(/[一-龥]/u)
  })
})

describe('渲染与一次性', () => {
  it('默认不渲染（没有事件就没有 toast）', async () => {
    await renderHost()
    expect(container.querySelector('[data-role="app-toast"]')).toBeNull()
  })

  it('showAppToast 之后渲染出文案，点关闭即消失', async () => {
    await renderHost()
    await act(async () => { showAppToast({ kind: 'foreign-deep-link' }) })
    const toast = container.querySelector('[data-role="app-toast"]')
    expect(toast).not.toBeNull()
    expect(toast!.getAttribute('data-toast')).toBe('foreign-deep-link')
    expect(toast!.textContent).toContain('这个链接属于另一家企业的客户端')
    expect(toast!.getAttribute('role')).toBe('status')
    // 关闭按钮是真实 button（键盘可达）。
    const close = container.querySelector<HTMLButtonElement>('.pico-app-toast-dismiss')
    expect(close).not.toBeNull()
    await act(async () => { close!.click() })
    expect(container.querySelector('[data-role="app-toast"]')).toBeNull()
    expect(currentAppToast()).toBeNull()
  })

  it('到点自动消失（一次性提示不常驻）', async () => {
    vi.useFakeTimers()
    await renderHost()
    await act(async () => { showAppToast({ kind: 'foreign-deep-link' }) })
    expect(container.querySelector('[data-role="app-toast"]')).not.toBeNull()
    await act(async () => { vi.advanceTimersByTime(APP_TOAST_TTL_MS + 1) })
    expect(container.querySelector('[data-role="app-toast"]')).toBeNull()
  })

  it('重复调用会重置计时（后一条不会被前一条的计时提前吃掉）', async () => {
    vi.useFakeTimers()
    await renderHost()
    await act(async () => { showAppToast({ kind: 'foreign-deep-link' }) })
    await act(async () => { vi.advanceTimersByTime(APP_TOAST_TTL_MS - 100) })
    await act(async () => { showAppToast({ kind: 'foreign-deep-link' }) })
    await act(async () => { vi.advanceTimersByTime(200) })
    expect(container.querySelector('[data-role="app-toast"]')).not.toBeNull()
  })
})
