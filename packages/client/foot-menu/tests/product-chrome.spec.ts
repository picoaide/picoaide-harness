// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { hideProductChrome, installProductChromeHiding } from '../src/client/index.ts'

beforeEach(() => {
  document.body.innerHTML = ''
})

const visible = (element: Element): boolean => (element as HTMLElement).style.display !== 'none'

describe('hideProductChrome', () => {
  it('hides the official panellist rows without touching other rows', () => {
    document.body.innerHTML = `
      <button class="x_panelRow" aria-label="自动化任务">自动化任务</button>
      <button class="x_panelRow" aria-label="插件">插件</button>
      <button class="x_panelRow" aria-label="能力中心">能力中心</button>
    `
    hideProductChrome(document)
    const rows = [...document.querySelectorAll('button')]
    expect(visible(rows[0])).toBe(false)
    expect(visible(rows[1])).toBe(false)
    expect(visible(rows[2])).toBe(true)
  })

  it('recognises the account menu when the settings item carries a keycap suffix', () => {
    // macOS/Windows shortcuts append "⌘⌥," / "Ctrl+Alt+," to textContent.
    document.body.innerHTML = `
      <div role="menu">
        <button role="menuitem">设置Ctrl+Alt+,</button>
        <button role="menuitem">意见反馈</button>
        <button role="menuitem">退出登录</button>
      </div>
    `
    hideProductChrome(document)
    const items = [...document.querySelectorAll('[role="menuitem"]')]
    expect(visible(items[0])).toBe(true)
    expect(visible(items[1])).toBe(false)
    expect(visible(items[2])).toBe(false)
  })

  it('recognises the English Windows keycap suffix (SettingsCtrl+Alt+,)', () => {
    document.body.innerHTML = `
      <div role="menu">
        <button role="menuitem">SettingsCtrl+Alt+,</button>
        <button role="menuitem">Feedback</button>
        <button role="menuitem">Sign out</button>
      </div>
    `
    hideProductChrome(document)
    const items = [...document.querySelectorAll('[role="menuitem"]')]
    expect(visible(items[0])).toBe(true)
    expect(visible(items[1])).toBe(false)
    expect(visible(items[2])).toBe(false)
  })

  it('does not touch a menu that is not the official account menu', () => {
    document.body.innerHTML = `
      <div role="menu">
        <button role="menuitem">意见反馈</button>
        <button role="menuitem">账户</button>
      </div>
    `
    hideProductChrome(document)
    expect(visible(document.querySelector('[role="menuitem"]')!)).toBe(true)
  })

  it('hides 模型/内置插件 only inside the settings dialog and keeps real content buttons', () => {
    document.body.innerHTML = `
      <div role="dialog">
        <button>通用设置</button>
        <button>模型</button>
        <button>内置插件</button>
        <button>账号</button>
        <button>模型</button>
      </div>
      <button id="outside">模型</button>
    `
    hideProductChrome(document)
    const buttons = [...document.querySelectorAll('[role="dialog"] button')]
    expect(visible(buttons[0])).toBe(true)
    expect(visible(buttons[1])).toBe(false)
    expect(visible(buttons[2])).toBe(false)
    expect(visible(buttons[3])).toBe(true)
    expect(visible(buttons[4])).toBe(false)
    expect(visible(document.querySelector('#outside')!)).toBe(true)
  })

  it('observes menus mounted after install and stops after dispose', async () => {
    const dispose = installProductChromeHiding(document)
    const render = (feedbackVisible: boolean): void => {
      document.body.innerHTML = `
        <div role="menu">
          <button role="menuitem">设置</button>
          <button role="menuitem">意见反馈</button>
        </div>
      `
      if (feedbackVisible) expect(visible(document.querySelectorAll('[role="menuitem"]')[1]!)).toBe(true)
    }
    render(false)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(visible(document.querySelectorAll('[role="menuitem"]')[1]!)).toBe(false)
    dispose()
    render(true)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(visible(document.querySelectorAll('[role="menuitem"]')[1]!)).toBe(true)
  })

  it('is idempotent', () => {
    document.body.innerHTML = `<button class="panelRow" aria-label="Automation tasks">Automation tasks</button>`
    hideProductChrome(document)
    hideProductChrome(document)
    expect(visible(document.querySelector('button')!)).toBe(false)
  })
})
