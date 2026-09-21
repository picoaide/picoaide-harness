// @vitest-environment jsdom
/**
 * 「更多」行 + 向上浮层的行为断言（冻结规格 §2.4 / §2.5）。
 *
 * 这些用例量的是**用户看得见的行为**：几何（宽栏 34px 行 / 窄轨 36px 圆按钮）、
 * 激活态文案（`更多 · 能力中心`）、警示圆点、浮层里条目的顺序与激活标记、
 * 点击/键盘/外部点击三种关闭路径，以及"关闭是 `display:none` 而不是卸载"。
 *
 * ---- 变异验证 ----
 *   - 无条目时仍渲染行 ⇒「条目为 0 渲染 null」红；
 *   - 关闭时把浮层卸载（而不是 display:none）⇒「关闭后条目仍在树里」红；
 *   - 点条目后不关闭浮层 / 不还焦点 ⇒ 对应用例红；
 *   - Esc 不还焦点、外部 pointerdown 不关闭 ⇒ 对应用例红；
 *   - 激活态不看 `PANEL_ACTIVE_ATTR` ⇒「激活面板时行文案带面板名」红。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { PANEL_ACTIVE_ATTR } from '@picoaide/dsh-panel-surface/client'
import { createFootMenuService, installFootMenu, type FootMenuEntry, type FootMenuService } from '../src/client/contract.ts'
import { FootMenuRow } from '../src/client/FootMenuRow.tsx'
import { setActiveLocale } from '../src/client/locales.ts'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
let service: FootMenuService
let activated: string[]

/** 把新登记表挂到上下文上（`provide` 在测试里只要不抛就行）。 */
function useService(): void {
  service = createFootMenuService()
  installFootMenu({ provide: () => undefined } as unknown as Context, service)
}

/** 加一个会记录点击的条目。 */
function add(id: string, order: number, extra: Partial<FootMenuEntry> = {}): void {
  service.add({ id, order, title: () => id, activate: () => { activated.push(id) }, ...extra })
}

const row = (): HTMLButtonElement => {
  const element = document.querySelector<HTMLButtonElement>('.pico-foot-menu-trigger')
  if (element === null) throw new Error('「更多」行不在 DOM 里')
  return element
}

const menu = (): HTMLDivElement => {
  const element = document.querySelector<HTMLDivElement>('[role="menu"]')
  if (element === null) throw new Error('浮层不在 DOM 里')
  return element
}

/** 浮层里的条目按钮（按渲染顺序）。 */
const items = (): HTMLButtonElement[] => [...menu().querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]

async function render(wide: boolean): Promise<void> {
  await act(async () => { root.render(<FootMenuRow wide={wide} />) })
}

/** 点「更多」行。 */
async function open(): Promise<void> {
  await act(async () => { row().dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

beforeEach(() => {
  setActiveLocale('zh')
  activated = []
  useService()
  document.documentElement.removeAttribute(PANEL_ACTIVE_ATTR)
  document.body.innerHTML = ''
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  document.body.innerHTML = ''
  document.documentElement.removeAttribute(PANEL_ACTIVE_ATTR)
})

describe('「更多」行：几何与无障碍', () => {
  it('条目为 0 时整行渲染 null（没有条目就没有这一行）', async () => {
    await render(true)
    expect(document.querySelector('.pico-foot-menu-trigger')).toBeNull()
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })

  it('宽栏：逐字对齐被替换行的几何，且是真实 button + 菜单语义', async () => {
    add('capability', -1)
    await render(true)
    const trigger = row()
    expect(trigger.getAttribute('type')).toBe('button')
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(trigger.getAttribute('aria-controls')).toBe(menu().id)
    expect(trigger.getAttribute('aria-label')).toBe('更多功能')
    expect(trigger.textContent).toContain('更多')
    expect(trigger.style.height).toBe('34px')
    expect(trigger.style.margin).toBe('4px -4px')
    expect(trigger.style.padding).toBe('6px 2px 6px 10px')
    expect(trigger.style.width).toBe('calc(100% + 8px)')
    expect(trigger.style.borderRadius).toBe('12px')
    expect(trigger.style.fontSize).toBe('14px')
    expect(trigger.style.gap).toBe('8px')
    expect(trigger.style.boxSizing).toBe('border-box')
    // 上色靠类名 + 注入的样式表：**行内 background 会压死 `:hover`**
    //（2026-09-21 行查发现的真实缺陷）。
    expect(trigger.style.background).toBe('')
    expect(trigger.classList.contains('pico-foot-menu-trigger')).toBe(true)
    // 宽栏：glyph + chevron 两个 SVG。
    expect(trigger.querySelectorAll('svg').length).toBe(2)
  })

  it('窄轨（wide=false）：36×36 圆按钮，无文字无 chevron，警示圆点保留', async () => {
    add('browser', 1, { attention: () => true })
    await render(false)
    const trigger = row()
    expect(trigger.style.width).toBe('36px')
    expect(trigger.style.height).toBe('36px')
    expect(trigger.style.borderRadius).toBe('50%')
    expect(trigger.style.justifyContent).toBe('center')
    expect(trigger.textContent).toBe('')
    // 窄轨只有一个 glyph（没有尾部 chevron）。
    expect(trigger.querySelectorAll('svg').length).toBe(1)
    expect(trigger.querySelector('[data-role="foot-menu-attention"]')).not.toBeNull()
    expect(trigger.getAttribute('aria-label')).toBe('更多功能（有等待处理的事项）')
  })

  it('有 attention 的条目 ⇒ 行上有琥珀色圆点、aria-label 换成"有等待"那句', async () => {
    add('browser', 1, { attention: () => false })
    await render(true)
    expect(row().querySelector('[data-role="foot-menu-attention"]')).toBeNull()
    await act(async () => { add('cron', -10, { attention: () => true }) })
    await render(true)
    expect(row().querySelector('[data-role="foot-menu-attention"]')).not.toBeNull()
    expect(row().getAttribute('aria-label')).toBe('更多功能（有等待处理的事项）')
  })

  it('激活面板时行文案是「更多 · <面板名>」，面板关掉后回到「更多」', async () => {
    add('capability', -1, { title: () => '能力中心' })
    await render(true)
    expect(row().textContent).toBe('更多')
    await act(async () => { document.documentElement.setAttribute(PANEL_ACTIVE_ATTR, 'capability') })
    expect(row().textContent).toBe('更多 · 能力中心')
    // 面板关闭**只删属性、不发事件** —— 这必须被 MutationObserver 接住。
    await act(async () => { document.documentElement.removeAttribute(PANEL_ACTIVE_ATTR) })
    expect(row().textContent).toBe('更多')
  })

  it('跟随语言：en 下是 More', async () => {
    setActiveLocale('en')
    add('capability', -1)
    await render(true)
    expect(row().textContent).toBe('More')
    expect(row().getAttribute('aria-label')).toBe('More')
  })
})

describe('浮层：打开、顺序、激活态', () => {
  it('点开后按 order 列出全部条目，且焦点落在第一条', async () => {
    add('apps', 2, { title: () => '应用中心' })
    add('cron', -10, { title: () => '定时任务' })
    add('browser', 1, { title: () => '浏览器' })
    await render(true)
    expect(menu().style.display).toBe('none')
    await open()
    expect(menu().style.display).toBe('block')
    expect(row().getAttribute('aria-expanded')).toBe('true')
    expect(items().map(item => item.textContent)).toEqual(['定时任务', '浏览器', '应用中心'])
    expect(document.activeElement).toBe(items()[0])
    expect(menu().getAttribute('role')).toBe('menu')
    expect(menu().getAttribute('aria-label')).toBe('更多功能')
    // 浮层 portal 到 body，且是 fixed 定位（侧边栏列的 overflow:hidden 会裁掉它）。
    expect(menu().parentElement).toBe(document.body)
    expect(menu().style.position).toBe('fixed')
    expect(menu().style.zIndex).toBe('1100')
    // 条目同样不带行内背景（否则 hover / focus-visible 规则失效）。
    expect(items()[0]!.classList.contains('pico-foot-menu-item')).toBe(true)
    expect(items()[0]!.style.background).toBe('')
  })

  it('当前激活的条目标 aria-current + ✓，并把焦点放在它身上', async () => {
    add('cron', -10, { title: () => '定时任务' })
    add('capability', -1, { title: () => '能力中心' })
    await act(async () => { document.documentElement.setAttribute(PANEL_ACTIVE_ATTR, 'capability') })
    await render(true)
    await open()
    const [cron, capability] = items()
    expect(cron?.getAttribute('aria-current')).toBeNull()
    expect(capability?.getAttribute('aria-current')).toBe('true')
    // 激活项前置 ✓（第一条没有 ✓，因此它的 svg 数比激活项少一个）。
    expect(capability!.querySelectorAll('svg').length).toBe(cron!.querySelectorAll('svg').length + 1)
    expect(document.activeElement).toBe(capability)
  })

  it('attention 条目：文字用琥珀色 + 右侧圆点 + title/aria-label 用等待文案', async () => {
    add('browser', 1, { title: () => 'AI 等待交还', attention: () => true })
    add('apps', 2, { title: () => '应用中心' })
    await render(true)
    await open()
    const [browser, apps] = items()
    expect(browser!.style.color).toBe('rgb(217, 119, 6)')
    expect(browser!.getAttribute('title')).toBe('AI 正在等待你的操作')
    expect(browser!.getAttribute('aria-label')).toBe('AI 正在等待你的操作')
    expect(browser!.querySelector('[data-role="foot-menu-attention"]')).not.toBeNull()
    expect(apps!.style.color).not.toBe('rgb(217, 119, 6)')
    expect(apps!.querySelector('[data-role="foot-menu-attention"]')).toBeNull()
  })

  it('attentionTitle 覆盖通用警示文案（条目自己给的可操作句子）', async () => {
    // 通用那句只说"AI 在等"，不告诉用户下一步点哪里；条目可以用 `attentionTitle`
    // 给出可操作的句子，而「更多」行不必认识任何具体插件（2026-09-21 对抗审计 P2）。
    add('browser', 1, {
      title: () => 'AI 等待交还',
      attention: () => true,
      attentionTitle: () => '打开浏览器窗口点「交给 AI」即可继续',
    })
    // 没给 attentionTitle 的条目必须退回通用文案（不是空白、也不是 undefined）。
    add('apps', 2, { title: () => '应用中心', attention: () => true })
    await render(true)
    // 行上的 tooltip 取第一个在等条目的文案。
    expect(row().getAttribute('title')).toBe('打开浏览器窗口点「交给 AI」即可继续')
    await open()
    const [browser, apps] = items()
    expect(browser!.getAttribute('title')).toBe('打开浏览器窗口点「交给 AI」即可继续')
    expect(browser!.getAttribute('aria-label')).toBe('打开浏览器窗口点「交给 AI」即可继续')
    expect(apps!.getAttribute('title')).toBe('AI 正在等待你的操作')
    expect(apps!.getAttribute('aria-label')).toBe('AI 正在等待你的操作')
  })

  it('尾部 chevron 随展开状态翻转（收起朝下、展开朝上）', async () => {
    add('cron', -10)
    await render(true)
    // 宽栏是 [「更多」图标, chevron]；chevron 的几何本身朝下，展开时旋转 180°。
    const chevron = (): SVGSVGElement => row().querySelectorAll('svg')[1] as SVGSVGElement
    expect(chevron().style.transform).toBe('')
    await open()
    expect(chevron().style.transform).toBe('rotate(180deg)')
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(chevron().style.transform).toBe('')
  })

  it('点条目：调用 activate 并关闭浮层，焦点回到「更多」行', async () => {
    add('cron', -10, { title: () => '定时任务' })
    await render(true)
    await open()
    await act(async () => { items()[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(activated).toEqual(['cron'])
    expect(menu().style.display).toBe('none')
    expect(document.activeElement).toBe(row())
  })
})

describe('浮层：关闭路径与"关闭 ≠ 卸载"', () => {
  it('Esc 关闭并把焦点还给「更多」行', async () => {
    add('cron', -10)
    await render(true)
    await open()
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(menu().style.display).toBe('none')
    expect(document.activeElement).toBe(row())
  })

  it('浮层里开着真模态时不抢 Esc（那一层自己处理）', async () => {
    add('cron', -10)
    await render(true)
    await open()
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('aria-modal', 'true')
    document.body.appendChild(dialog)
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(menu().style.display).toBe('block')
    dialog.remove()
  })

  it('外部 pointerdown 关闭；行内部的 pointerdown 不关闭', async () => {
    add('cron', -10)
    await render(true)
    await open()
    await act(async () => { row().dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })) })
    expect(menu().style.display).toBe('block')
    await act(async () => { menu().dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })) })
    expect(menu().style.display).toBe('block')
    const outside = document.createElement('div')
    document.body.appendChild(outside)
    await act(async () => { outside.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })) })
    expect(menu().style.display).toBe('none')
  })

  it('外部**程序化** click 也关闭（只有 click、没有 pointerdown 的那条路径）', async () => {
    add('cron', -10)
    await render(true)
    await open()
    const outside = document.createElement('div')
    document.body.appendChild(outside)
    await act(async () => { outside.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(menu().style.display).toBe('none')
  })

  it('点行自己不会"开了又立刻关"（锚点上的 click 不算外部）', async () => {
    add('cron', -10)
    await render(true)
    await open()
    await act(async () => { row().dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(menu().style.display).toBe('none') // 第二次点 = 收起
    await act(async () => { row().dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(menu().style.display).toBe('block') // 第三次点 = 再开（同一个 click 事件不自我关闭）
  })

  it('焦点不在浮层/锚点上时 Esc 不抢（让给最上层的那一层）', async () => {
    add('cron', -10)
    await render(true)
    await open()
    const outsideInput = document.createElement('input')
    document.body.appendChild(outsideInput)
    outsideInput.focus()
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(menu().style.display).toBe('block')
    // 焦点回到条目上，Esc 才是"本层的 Esc"。
    await act(async () => { items()[0]!.focus() })
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(menu().style.display).toBe('none')
  })

  it('关闭态是 display:none，条目**仍在树里**（隐藏 = 不可聚焦、不进 tab 序列）', async () => {
    add('cron', -10)
    await render(true)
    await open()
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(menu().style.display).toBe('none')
    // 仍然是同一批按钮：收起浮层不卸载子树（条目背后的轮询/状态不能因此停掉）。
    expect(items().length).toBe(1)
    expect(menu().isConnected).toBe(true)
  })

  it('订阅者发布后行跟着重渲染（touch 驱动 title/attention 重新求值）', async () => {
    let waiting = false
    add('browser', 1, { title: () => (waiting ? 'AI 等待交还' : '浏览器'), attention: () => waiting })
    await render(true)
    await open()
    expect(items()[0]?.textContent).toBe('浏览器')
    waiting = true
    await act(async () => { service.touch() })
    expect(items()[0]?.textContent).toBe('AI 等待交还')
    expect(row().querySelector('[data-role="foot-menu-attention"]')).not.toBeNull()
  })

  it('登记表条目变化后浮层顺序跟着变', async () => {
    add('apps', 2, { title: () => '应用中心' })
    await render(true)
    await open()
    expect(items().map(item => item.textContent)).toEqual(['应用中心'])
    await act(async () => { add('cron', -10, { title: () => '定时任务' }) })
    expect(items().map(item => item.textContent)).toEqual(['定时任务', '应用中心'])
  })
})

describe('浮层：键盘导航', () => {
  it('ArrowDown/ArrowUp 在条目间循环移动焦点', async () => {
    add('cron', -10, { title: () => '定时任务' })
    add('connectors', 0, { title: () => '连接器' })
    add('apps', 2, { title: () => '应用中心' })
    await render(true)
    await open()
    const [first, second, third] = items()
    expect(document.activeElement).toBe(first)
    const press = async (key: string): Promise<void> => {
      await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })) })
    }
    await press('ArrowDown')
    expect(document.activeElement).toBe(second)
    await press('ArrowDown')
    expect(document.activeElement).toBe(third)
    await press('ArrowDown')
    expect(document.activeElement).toBe(first)
    await press('ArrowUp')
    expect(document.activeElement).toBe(third)
    await press('Home')
    expect(document.activeElement).toBe(first)
    await press('End')
    expect(document.activeElement).toBe(third)
  })
})
