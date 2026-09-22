/**
 * 模态打开期间「左栏不再是原生材质上的透明洞」的护栏（issue #128 D2）。
 *
 * 背景：设置弹窗的整视口蒙版是 `rgba(0,0,0,.24)` + `backdrop-filter: blur(2px)`
 * （上游 `SettingsRoot.module.css` 的 `.mask`，token `--dsw-mask-blur`），而
 * `backdrop-filter` 只采样**页面自身**的绘制结果。左栏 `.dshDesktopSidebarSurface`
 * 平时刻意 `background: transparent`（为的是透出 macOS vibrancy / Windows mica 原生材质），
 * 于是蒙版在左栏没有可模糊的底：左侧 = 0.24 黑直接压在未模糊的原生材质上，右侧 =
 * 0.24 黑 + 模糊后的页面，分界线正好落在 `border-right` 上（半糊重影 = 用户说的扫描感）。
 *
 * 修复 = 模态存在时把左栏交回不透明底（`html:has([role="dialog"][aria-modal="true"])`）。
 * 这里不钉字面量，而是：
 *  1. 解析**我们真正注入的那张样式表**（走 `installAdvancedStyles` 的生产路径）；
 *  2. 用上游真实调色板（`design-platform.css`）解引用声明值，按 alpha 判定不透明/透明；
 *  3. 对拍上游 `SidebarRoot.module.css` 是否仍在读 `--dsw-specific-sidebar-fill`；
 *  4. 对拍上游设置面板是否仍带 `role="dialog"` + `aria-modal="true"`（触发条件）。
 * 因此：删掉规则 / 值改成 transparent / 丢掉变量覆盖 / 上游改 ARIA 或改底色来源，
 * 都会变红，而不是静默失效。
 *
 * 真机（Chromium 计算样式）证据由同目录的 `modal-frost-computed-probe.mjs` 提供
 * （本包 vitest 是 Node 环境、故意不装 jsdom，所以计算样式只能在 Electron 里量）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { installAdvancedStyles } from '../src/client/styles.ts'

/** 仓库根（`packages/host/desktop/tests/` 往上三层）。 */
const workspaceRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const PLATFORM_CSS = join(
  workspaceRoot, 'deepseek-harness', 'packages', 'client', 'ui-theme', 'src', 'styles', 'design-platform.css',
)
const SIDEBAR_ROOT_CSS = join(
  workspaceRoot, 'deepseek-harness', 'packages', 'client', 'ui-sidebar', 'src', 'client', 'SidebarRoot.module.css',
)
const SETTINGS_ROOT_TSX = join(
  workspaceRoot, 'deepseek-harness', 'packages', 'client', 'ui-settings-general', 'src', 'client', 'SettingsRoot.tsx',
)
const CAPABILITY_PANEL_TSX = join(
  workspaceRoot, 'packages', 'host', 'enterprise', 'src', 'client', 'CapabilityCenterPanel.tsx',
)

/** 修复规则的选择器：只用 html:has() + 我们自己的稳定类名。 */
const MODAL_SELECTOR = 'html:has([role="dialog"][aria-modal="true"]) .dshDesktopSidebarSurface'
/** 触发条件与装载器（@picoaide/dsh-panel-surface）的模态判据同形。 */
const MODAL_TRIGGER = '[role="dialog"][aria-modal="true"]'

/** 真实上游样式表（去注释：注释里的 `--x:` 会污染 token 解析）。 */
const platformCss = readFileSync(PLATFORM_CSS, 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '')

/** 取高级外壳样式表文本（与 client-environment.spec.ts 相同的 document 替身姿势）。 */
function advancedStyles(): string {
  let css = ''
  const style = {
    dataset: {} as Record<string, string>,
    get textContent() { return css },
    set textContent(value: string) { css = value },
    remove: (): void => {},
  }
  vi.stubGlobal('document', { createElement: () => style, head: { appendChild: (): void => {} } })
  try {
    installAdvancedStyles()()
  }
  finally {
    vi.unstubAllGlobals()
  }
  return css.replace(/\/\*[\s\S]*?\*\//gu, '')
}

/** 取出一个规则的原文（`selector` 不含 `{`；选择器与 `{` 之间只允许空白）。 */
function ruleText(css: string, selector: string): string {
  const start = css.indexOf(selector)
  if (start < 0) throw new Error(`missing rule: ${selector}`)
  const open = css.indexOf('{', start + selector.length)
  if (open < 0 || !/^\s*$/u.test(css.slice(start + selector.length, open))) {
    throw new Error(`ambiguous rule: ${selector}`)
  }
  const close = css.indexOf('}', open)
  return css.slice(start, close + 1)
}

/** 取出一个规则的声明体（`selector` 不含 `{`）。 */
function declarationBlock(css: string, selector: string): string {
  const text = ruleText(css, selector)
  return text.slice(text.indexOf('{') + 1, -1)
}

/** 取一条声明的值。 */
function declaration(block: string, property: string): string {
  const match = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, 'u').exec(block)
  if (match === null) throw new Error(`missing declaration: ${property}`)
  return match[1]!.trim()
}

/** design-platform.css 的块级 token 表；暗色表以亮色表为底再被暗色块覆盖。 */
function palettes(css: string): { light: Map<string, string>, dark: Map<string, string> } {
  const light = new Map<string, string>()
  const dark = new Map<string, string>()
  for (const block of css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
    const target = block[1]!.includes('data-ds-dark-theme') ? dark : light
    for (const token of block[2]!.matchAll(/(--dsw-[a-z0-9-]+)\s*:\s*([^;]+);/gu)) {
      target.set(token[1]!, token[2]!.trim())
    }
  }
  return { light, dark: new Map([...light, ...dark]) }
}

/** 递归解引用 `var(--x)`（token 不存在时取 var() 的 fallback）。 */
function resolveToken(tokens: Map<string, string>, name: string, depth = 0): string | undefined {
  if (depth > 8) return undefined
  const value = tokens.get(name)
  if (value === undefined) return undefined
  const nested = /^var\(\s*(--[a-z0-9-]+)\s*(?:,\s*([^)]+))?\)$/u.exec(value)
  if (nested === null) return value
  return resolveToken(tokens, nested[1]!, depth + 1) ?? nested[2]?.trim()
}

/** 把一个声明值解析成具体颜色（字面量原样返回）。 */
function resolveValue(tokens: Map<string, string>, declared: string): string {
  const token = /^var\(\s*(--[a-z0-9-]+)\s*(?:,\s*([^)]+))?\)$/u.exec(declared)
  if (token === null) return declared
  return resolveToken(tokens, token[1]!) ?? token[2]?.trim() ?? declared
}

/** 颜色 alpha：只认上游调色板会出现的形态，其它一律抛（避免解析失败被当成"通过"）。 */
function alpha(value: string): number {
  const text = value.trim().toLowerCase()
  if (text === 'transparent') return 0
  const hex = /^#([0-9a-f]{3,8})$/u.exec(text)
  if (hex !== null) {
    const digits = hex[1]!
    if (digits.length === 3 || digits.length === 4) {
      return digits.length === 4 ? Number.parseInt(digits[3]! + digits[3]!, 16) / 255 : 1
    }
    if (digits.length === 6) return 1
    if (digits.length === 8) return Number.parseInt(digits.slice(6), 16) / 255
  }
  const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)$/u.exec(text)
  if (fn !== null) return fn[4] === undefined ? 1 : Number(fn[4])
  throw new Error(`unsupported color: ${value}`)
}

/** 把 JSX 里某个属性所在的标签切出来（同一标签内的兄弟属性才算命中）。 */
function tagAround(source: string, needle: string): string {
  const at = source.indexOf(needle)
  if (at < 0) throw new Error(`missing attribute: ${needle}`)
  const open = source.lastIndexOf('<', at)
  const close = source.indexOf('>', at)
  return source.slice(open, close + 1)
}

describe('modal-open sidebar fill (issue #128 D2)', () => {
  const css = advancedStyles()
  const { light, dark } = palettes(platformCss)

  it('binds the opaque fill to our own surface class, never to a hashed upstream class', () => {
    const block = declarationBlock(css, MODAL_SELECTOR)
    // 两个真源都要换：surface 自身（darwin 上真正被绘制的那层）与上游 .root 读的变量。
    expect(declaration(block, 'background')).not.toBe('')
    expect(declaration(block, '--dsw-specific-sidebar-fill')).not.toBe('')
    // 本仓铁律：上游 CSS-module 类名是哈希形态，禁止用 [class^=]/[class*=]/[class$=] 匹配。
    expect(css).not.toMatch(/\[class[$^*]=/u)
  })

  it('makes the column opaque in both themes (alpha === 1 on the real palette)', () => {
    const block = declarationBlock(css, MODAL_SELECTOR)
    for (const theme of [light, dark]) {
      expect(alpha(resolveValue(theme, declaration(block, 'background')))).toBe(1)
      expect(alpha(resolveValue(theme, declaration(block, '--dsw-specific-sidebar-fill')))).toBe(1)
    }
    // 反假绿：解引用失败会让两套主题得到同一个值（而不是静默通过）。
    expect(resolveValue(light, declaration(block, 'background')))
      .not.toBe(resolveValue(dark, declaration(block, 'background')))
  })

  it('keeps the open window transparent when no modal is on screen (vibrancy stays)', () => {
    const base = declarationBlock(css, '.dshDesktopSidebarSurface')
    expect(alpha(resolveValue(light, declaration(base, 'background')))).toBe(0)
    expect(declaration(base, '--dsw-specific-sidebar-fill')).toBe('transparent')
    // 变量与 background 都必须回到透明：常量不透明就是"把原生材质永久关掉"。
    expect(resolveValue(dark, declaration(base, 'background'))).toBe('transparent')
  })

  it('still covers the paint source upstream actually reads', () => {
    const sidebar = readFileSync(SIDEBAR_ROOT_CSS, 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '')
    const root = declarationBlock(sidebar, '.root')
    expect(declaration(root, 'background')).toContain('--dsw-specific-sidebar-fill')
  })

  it('the upstream settings modal still matches the trigger selector', () => {
    // 触发条件是 role=dialog + aria-modal=true：上游只改其中一个，规则就静默不命中。
    const settings = readFileSync(SETTINGS_ROOT_TSX, 'utf8')
    const panel = tagAround(settings, 'role="dialog"')
    expect(panel).toContain('aria-modal="true"')
  })

  it('our own full-viewport mask modals still match the trigger selector', () => {
    const panel = readFileSync(CAPABILITY_PANEL_TSX, 'utf8')
    const dialog = tagAround(panel, 'role="dialog"')
    expect(dialog).toContain('aria-modal="true"')
    // 该模态必须自带整视口蒙版，否则它没有理由让左栏放弃原生材质。
    expect(panel).toMatch(/backdropFilter:\s*'var\(--dsw-mask-blur\)'/u)
  })

  it('the extractor is not vacuous: deleting the rule throws here', () => {
    const without = css.replace(ruleText(css, MODAL_SELECTOR), '')
    expect(without).not.toBe(css)
    expect(() => declarationBlock(without, MODAL_SELECTOR)).toThrow(/missing rule/u)
    // 触发条件也不能退化成"任意 aria 属性"：非模态浮层不该让左栏放弃原生材质。
    expect(MODAL_TRIGGER).toBe('[role="dialog"][aria-modal="true"]')
  })
})
