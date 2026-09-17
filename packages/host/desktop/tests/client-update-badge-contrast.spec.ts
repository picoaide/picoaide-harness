/**
 * 更新徽标「已下载待安装」态的文字对比度护栏（2026-09-17 S06-01 审计）。
 *
 * 背景：该规则曾把文字色从字面量 `#15803d` 换成
 * `var(--dsw-alias-state-success-primary, #15803d)`，理由是要修暗色对比度。
 * 但那个 token **不翻转** —— 上游 design-platform.css 的亮色块与
 * `body[data-ds-dark-theme]` 块都把它指向 `--dsw-static-green-500`
 * (rgb(34, 197, 94))，于是亮色主题下 12px 文字压在白色徽标上只剩 2.28:1
 * （WCAG AA 正文要求 4.5:1），比改动前的 5.02:1 更难读。
 *
 * 这里不钉字面量，而是**用上游真实调色板重算对比度**：解析
 * design-platform.css 的亮/暗两个块，解引用徽标真正用到的 token，再按 WCAG
 * 相对亮度公式校验两套主题都 ≥ 4.5:1。这样：
 *  - 文字换回不翻转的状态色 ⇒ 亮色 2.28:1 红；
 *  - 删掉 `body[data-ds-dark-theme]` 覆盖 ⇒ 暗色 2.78:1 红；
 *  - 上游改了底色/token ⇒ 也会被要求重新确认可读性（不是快照比对）。
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
  // 去注释再解析：注释里的 `--x:` 会污染 token 解析，块内注释还会挡住
  // `(?:^|;)` 这条"声明必须跟在分号后"的边界判断。
  return css.replace(/\/\*[\s\S]*?\*\//gu, '')
}

/** 取出一个规则的声明体（`selector` 不含 `{`；取它之后的第一个块）。 */
function declarationBlock(css: string, selector: string): string {
  const start = css.indexOf(selector)
  if (start < 0) throw new Error(`missing rule: ${selector}`)
  const open = css.indexOf('{', start + selector.length)
  const close = css.indexOf('}', open)
  return css.slice(open + 1, close)
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

function rgb(value: string): [number, number, number] {
  const hex = /^#([0-9a-f]{6})$/iu.exec(value.trim())
  if (hex !== null) {
    const packed = Number.parseInt(hex[1]!, 16)
    return [(packed >> 16) & 0xff, (packed >> 8) & 0xff, packed & 0xff]
  }
  const parts = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/u.exec(value.trim())
  if (parts === null) throw new Error(`unsupported color: ${value}`)
  return [Number(parts[1]), Number(parts[2]), Number(parts[3])]
}

/** WCAG 相对亮度。 */
function luminance(color: string): number {
  const channel = (raw: number): number => {
    const scaled = raw / 255
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
  }
  const [r, g, b] = rgb(color)
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/** WCAG 对比度（1..21）。 */
function contrast(foreground: string, background: string): number {
  const first = luminance(foreground)
  const second = luminance(background)
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}

describe('desktop update badge ready-state contrast', () => {
  const css = advancedStyles()
  const { light, dark } = palettes(platformCss)
  const base = declarationBlock(css, '.dshDesktopUpdateBadge')
  const ready = declarationBlock(css, '.dshDesktopUpdateBadge[data-state="ready"]')
  const readyDark = declarationBlock(css, 'body[data-ds-dark-theme] .dshDesktopUpdateBadge[data-state="ready"]')
  const readyDot = declarationBlock(css, '.dshDesktopUpdateBadge[data-state="ready"] .dshDesktopUpdateBadgeDot')

  it('keeps the state token for the border and the dot only', () => {
    expect(declaration(ready, 'border-color')).toContain('--dsw-alias-state-success-primary')
    expect(declaration(readyDot, 'background')).toContain('--dsw-alias-state-success-primary')
    // 文字不得再用那个不翻转的 token（这正是 2026-09-17 S06-01 的回归点）。
    expect(declaration(ready, 'color')).not.toContain('--dsw-alias-state-success-primary')
  })

  it('clears WCAG AA (4.5:1) on the real badge surface in both themes', () => {
    const lightSurface = resolveValue(light, declaration(base, 'background'))
    const darkSurface = resolveValue(dark, declaration(base, 'background'))
    // 反假绿：解析失败会让两套底色相同（并让暗色用例变红），而不是静默通过。
    expect(lightSurface).not.toBe(darkSurface)
    const lightText = resolveValue(light, declaration(ready, 'color'))
    const darkText = resolveValue(dark, declaration(readyDark, 'color'))
    expect(contrast(lightText, lightSurface)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(darkText, darkSurface)).toBeGreaterThanOrEqual(4.5)
  })
})
