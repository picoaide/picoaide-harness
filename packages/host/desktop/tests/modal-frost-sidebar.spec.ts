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
 *  3. 断言左栏的底色与会话列**同源**（同一个 `var(--dsw-alias-bg-base)`）——"不透明"不够：
 *     换成另一个同样不透明的 token（如 `--dsw-alias-bg-layer-2`）在亮色下与会话列同色、
 *     暗色下却是 rgb(44,44,46) vs rgb(21,21,23)，接缝会原样回来（2026-09-23 审计 M4）；
 *  4. 对拍上游 `SidebarRoot.module.css` 是否仍在读 `--dsw-specific-sidebar-fill`；
 *  5. 对拍上游设置面板是否仍带 `role="dialog"` + `aria-modal="true"`（触发条件）；
 *  6. 钉住修复赖以成立的前提：上游 `.mask` 仍是"半透明底 + `backdrop-filter:
 *     var(--dsw-mask-blur)`"。上游哪天不再模糊蒙版，这条规则修的东西就不存在了。
 * 因此：删掉规则 / 值改成 transparent / 丢掉变量覆盖 / 换成别的 token / 上游改 ARIA、
 * 改底色来源或去掉蒙版模糊，都会变红，而不是静默失效。
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
const SETTINGS_ROOT_CSS = join(
  workspaceRoot, 'deepseek-harness', 'packages', 'client', 'ui-settings-general', 'src', 'client', 'SettingsRoot.module.css',
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

/**
 * 取"独立成条"的类规则（行首就是该类名）。
 *
 * 同一个类名还会出现在复合选择器里（如
 * `.dshDesktopFrame[data-platform=…] .dshDesktopConversationSurface,`），裸类名会先命中
 * 那里、再因选择器列表不是空白而抛 `ambiguous rule`；行首锚定只命中独立规则。
 */
function standaloneRule(css: string, className: string): string {
  return declarationBlock(css, `\n${className}`)
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

  it('paints the open column with the same token as the conversation column, not merely an opaque one', () => {
    // 审计 C 的 M4：把取值换成 `--dsw-alias-bg-layer-2`（同样不透明）时，亮色下两个 token 都
    // 解析成 rgb(255,255,255) ⇒ 只看 alpha 的断言会全绿；暗色下却是 rgb(44,44,46) vs
    // rgb(21,21,23)，左栏与会话列的接缝重新出现。所以判据必须是"与会话列同源"。
    const conversation = declaration(standaloneRule(css, '.dshDesktopConversationSurface'), 'background')
    expect(conversation).toBe('var(--dsw-alias-bg-base)')
    const block = declarationBlock(css, MODAL_SELECTOR)
    // 两个真源都必须与会话列逐字相同（同一个 var()，不是"另一个也不透明的值"）。
    expect(declaration(block, 'background')).toBe(conversation)
    expect(declaration(block, '--dsw-specific-sidebar-fill')).toBe(conversation)
    // 解引用后逐主题也必须相等：亮暗两套调色板下都不能出现色差。
    for (const theme of [light, dark]) {
      expect(resolveValue(theme, declaration(block, 'background'))).toBe(resolveValue(theme, conversation))
    }
    // 反假绿：会话列在两个主题下确实解析出不同的颜色（否则上面的相等是空转）。
    expect(resolveValue(light, conversation)).not.toBe(resolveValue(dark, conversation))
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

  it('pins the premise that makes the rule necessary: the upstream mask still blurs', () => {
    // 审计 D4：两个判据都没钉"上游 .mask 仍带 backdrop-filter: var(--dsw-mask-blur)"这个前提。
    // 上游哪天把模糊去掉，本规则照旧生效、判据照旧全绿，"修的是什么"就说不清了 ——
    // 所以这里把前提本身也钉住：蒙版必须仍是"半透明压暗 + 模糊页面自身"。
    const settings = readFileSync(SETTINGS_ROOT_CSS, 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '')
    const mask = declarationBlock(settings, '.mask')
    expect(declaration(mask, 'backdrop-filter')).toBe('var(--dsw-mask-blur)')
    expect(alpha(resolveValue(light, declaration(mask, 'background')))).toBeLessThan(1)
  })

  it('the extractor is not vacuous: deleting the rule throws here', () => {
    const without = css.replace(ruleText(css, MODAL_SELECTOR), '')
    expect(without).not.toBe(css)
    expect(() => declarationBlock(without, MODAL_SELECTOR)).toThrow(/missing rule/u)
    // 触发条件也不能退化成"任意 aria 属性"：非模态浮层不该让左栏放弃原生材质。
    expect(MODAL_TRIGGER).toBe('[role="dialog"][aria-modal="true"]')
  })
})
