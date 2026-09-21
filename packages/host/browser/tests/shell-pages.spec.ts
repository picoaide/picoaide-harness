/**
 * Contract tests for the injected browser chrome pages (`shell-pages.ts`).
 *
 * These two pages are HTML/CSS/JS strings injected into Electron webContents,
 * so this package (no DOM environment) can only assert their SOURCE contract.
 * Real behaviour still needs the real-machine E2E over CDP — but the control
 * takeover rules below must never regress silently again (2026-09-11):
 *
 *   - the mask scrim is inert: only the pill's 我来操作 button grants control.
 *     A click anywhere else in the window must NOT steal the browser (the old
 *     whole-scrim click listener did exactly that, so a stray click on the
 *     toolbar or the page parked every queued AI action);
 *   - 我来操作 / 交给 AI is ONE always-visible toggle (never hover-revealed);
 *   - neither the activity panel nor Escape may hand control back to the AI.
 */
import { describe, expect, it } from 'vitest'
import { browserOverlayHtml, browserShellHtml } from '../src/shell-pages.ts'

// The zh renderings are the source locale: every control-contract assertion
// below was written against them before i18n, so they keep applying verbatim.
const BROWSER_OVERLAY_HTML = browserOverlayHtml('zh')
const BROWSER_SHELL_HTML = browserShellHtml('zh')

describe('browser control contract: the pill button is the only entry', () => {
  it('页面产物里没有反引号（外层就是模板字符串，任何反引号都会提前终止它）', () => {
    // 2026-09-21：本仓已踩过三次同类坑（含本次修壳层 UI 时在注释里写 `x`）。
    // 内联脚本与 CSS 一律用字符串拼接，所以产物里出现反引号 100% 是事故 ——
    // 它会让整个模块解析失败（tsc/tsdown 立刻红），这条断言把判据前移到单测。
    for (const html of [BROWSER_SHELL_HTML, BROWSER_OVERLAY_HTML]) {
      expect(html).not.toContain('`')
    }
  })

  it('never binds a click takeover on the whole-window scrim', () => {
    expect(BROWSER_OVERLAY_HTML).not.toContain("$('mask').addEventListener")
    expect(BROWSER_OVERLAY_HTML).toContain('id="pill-take"')
    expect(BROWSER_OVERLAY_HTML).toContain("$('pill-take').addEventListener('click'")
  })

  it('renders the scrim as a surface, not as a button', () => {
    expect(BROWSER_OVERLAY_HTML).not.toMatch(/\.s-mask \{[^}]*cursor: pointer/u)
  })

  it('胶囊锚在视图底部（宿主放大提示矩形时不许把胶囊一起拉大）', () => {
    // 2026-09-21（缺陷 #7）：胶囊态弹失败 toast 时宿主会把 overlay 视图临时放大到
    // 300×116。胶囊若继续 `height: 100%` 就会被拉成一整块盖住页面的大药丸 ——
    // 所以它必须自己钉在视图底部、高度恒为 34px（紧凑态下与原来逐像素等价）。
    // 注意必须锚在行首：`body[data-mode="capsule"] .surface.s-capsule { display:flex }`
    // 里也含 `.s-capsule {`，不锚定就会断言到那条 display 规则上（本测试第一版踩过）。
    const rule = /^[ \t]*\.s-capsule \{([^}]*)\}/mu.exec(BROWSER_OVERLAY_HTML)?.[1] ?? ''
    expect(rule, '.s-capsule 基础规则').toContain('bottom: 0')
    expect(rule).toContain('height: 34px')
    expect(rule).not.toContain('height: 100%')
  })

  it('keeps the toggle always visible and drops the sidebar duplicate', () => {
    expect(BROWSER_OVERLAY_HTML).not.toContain('.s-capsule:not(:hover) .take')
    expect(BROWSER_OVERLAY_HTML).not.toContain('.s-capsule:hover .take')
    expect(BROWSER_OVERLAY_HTML).not.toContain('take-btn')
  })

  it('releases control only from the toggle — never from Escape or the shell page', () => {
    expect(BROWSER_OVERLAY_HTML).not.toContain("if (state.controlled) post('takeover'")
    expect(BROWSER_SHELL_HTML).not.toContain("post('takeover'")
    // Escape still closes the floating surface in both pages.
    expect(BROWSER_OVERLAY_HTML).toContain("post('overlay', { mode: 'capsule' })")
    expect(BROWSER_SHELL_HTML).toContain("post('overlay', { mode: 'capsule' })")
  })

  it('keeps the takeover reachable from the keyboard while masked', () => {
    expect(BROWSER_OVERLAY_HTML).toContain("e.key === 'Enter' || e.key === ' '")
    // 2026-09-21（壳层缺陷 #1，P0）：键盘入口必须**只**作用于真正聚焦的可见按钮。
    // 旧实现把整个文档的 Enter/空格都当成「我来操作」并 preventDefault —— 蒙版页在
    // 前台持键盘焦点，于是用户想用空格翻页时：不翻页、正在跑的工具调用被
    // window-controlled 中止、控制权静默转移。此处钉两件事：
    //   1. 判定条件是 activeElement === 那个按钮（不是"窗口里有人按键"）；
    //   2. 按钮本身仍是真 <button>（蒙版显示时它是唯一可聚焦元素 ⇒ Tab 可达，
    //      原生 Enter/空格也能激活 —— 键盘可达性不退化）。
    expect(BROWSER_OVERLAY_HTML).toContain('document.activeElement === pill')
    expect(BROWSER_OVERLAY_HTML).toContain('<button id="pill-take" type="button">')
    // 行为层的判据在 shell-pages.behavior.spec.ts（jsdom 真按键）。
  })
})
