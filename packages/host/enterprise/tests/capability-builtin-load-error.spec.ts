import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { builtinLoadNotice } from '../src/client/CapabilityCenterPanel.tsx'
import { setActiveLocale, zh, en } from '../src/client/locales.ts'

/**
 * R21 FIX-7 ②：内置技能**清单**读失败的错误态**必须画出来**（FIX-1 的 D1 残项）。
 *
 * 背景（FIX-1 的报告 §⑥ DEFERRED / §未做项 D1）：
 *  - `useBuiltinSkills`（`BuiltinSkillsStrip.tsx`）已经把"读失败"（5xx / 网络 / 超时）
 *    与"这台服务端确实没有这条路由"分成 `error` 三态，并给出 `reload()`；
 *  - 但面板（`CapabilityCenterPanel.tsx:1810-1818` 那一带）只读
 *    `rows/installed/versions/busy/failed/install` ⇒ **error 没有消费者**，
 *    于是"读失败"在界面上与"平台没有内置技能"同形。
 *
 * 本文件钉两条：
 *  1. **判定 + 文案**（纯函数 `builtinLoadNotice`）：`error !== null` ⇒ 给出提示与重试
 *     文案（中英双语都走字典）；`null` ⇒ 不渲染（`ok` 与 404 的 `absent` 都不该出现提示）。
 *  2. **接线**（读面板源码）：提示条真的进了分区渲染，且**空分区也渲染**
 *     （否则列表为空时错误照样看不见），重试按钮接的是 `builtin.reload()`。
 *     不是存在性断言：断言的是"两处渲染分支都用了它"这一结构。
 *
 * ---- 变异验证 ----
 *   - `builtinLoadNotice` 恒返回 `null`（= 回到"不渲染错误态"）⇒ 第 1 组 3 条红；
 *   - 面板把 `builtinErrorStrip` 从 `cards.length === 0` 那条分支里去掉（只在有卡时显示）
 *     ⇒ 「空分区也必须渲染」红；
 *   - 重试按钮改接 `loadAll()`（刷新分区目录而不是重拉清单）⇒ 「重试接 reload」红。
 */
const PANEL_SOURCE = readFileSync(fileURLToPath(new URL('../src/client/CapabilityCenterPanel.tsx', import.meta.url)), 'utf8')

afterEach(() => { setActiveLocale('zh') })

describe('内置技能清单读失败 ⇒ 面板给出提示与重试（R21 FIX-7 ②）', () => {
  it('读失败（5xx / 网络）⇒ 有提示，且把诊断细节原样带出来', () => {
    expect(builtinLoadNotice('HTTP 500')).toEqual({ message: '内置技能清单读取失败：HTTP 500', retry: '重试' })
    expect(builtinLoadNotice('Failed to fetch')).toEqual({ message: '内置技能清单读取失败：Failed to fetch', retry: '重试' })
  })

  it('没失败（可用 / 404 的 absent）⇒ null（不许"总是显示一条错误"）', () => {
    expect(builtinLoadNotice(null)).toBeNull()
  })

  it('两种语言都有文案（字典键，不硬编码中文）', () => {
    setActiveLocale('en')
    expect(builtinLoadNotice('HTTP 500')).toEqual({ message: 'Failed to load the built-in skill list: HTTP 500', retry: 'Retry' })
    setActiveLocale('zh')
    expect(builtinLoadNotice('HTTP 502')).toEqual({ message: '内置技能清单读取失败：HTTP 502', retry: '重试' })
  })

  it('两个字典键都存在且 zh/en 都有值（键集对齐由 locales-hygiene 另钉）', () => {
    expect(zh['capability.builtinLoadFailed']).toContain('{error}')
    expect(en['capability.builtinLoadFailed']).toContain('{error}')
    expect(zh['capability.builtinRetry']).toBe('重试')
    expect(en['capability.builtinRetry']).toBe('Retry')
  })

  it('接线：面板用 `builtinLoadNotice(builtin.error)` 判定，并把提示渲染在两处分支', () => {
    expect(PANEL_SOURCE).toContain('builtinLoadNotice(builtin.error)')
    expect(PANEL_SOURCE).toContain('data-role="capability-builtin-error"')
    // 空分区分支：`cards.length === 0` 时先给提示、再回落空态。
    expect(PANEL_SOURCE).toMatch(/if \(cards\.length === 0\) \{\s*return builtinErrorStrip \?\? renderEmpty\(/u)
    // 有卡片分支：提示挂在卡片前面（同一分区的列表不完整这件事必须可见）。
    expect(PANEL_SOURCE).toMatch(/return \(\s*<>\s*\{builtinErrorStrip\}/u)
  })

  it('接线：重试按钮接的是 `builtin.reload()`（重拉清单），不是分区目录的 `loadAll()`', () => {
    const strip = PANEL_SOURCE.slice(PANEL_SOURCE.indexOf('const builtinErrorStrip'), PANEL_SOURCE.indexOf('const renderSection'))
    expect(strip).toContain('builtin.reload()')
    expect(strip).not.toContain('loadAll()')
    // 反向锚：分区级的错误态仍然是 loadAll（别把两处重试搞混）。
    expect(PANEL_SOURCE).toMatch(/st\.status === 'error'[\s\S]{0,400}loadAll\(\)/u)
  })

  it('接线：面板不再只读 rows/installed/…（`builtin.error` 真的被消费一次）', () => {
    const reads = [...PANEL_SOURCE.matchAll(/builtin\.(error|reload)\b/gu)].map(match => match[0])
    expect(reads).toContain('builtin.error')
    expect(reads).toContain('builtin.reload')
  })
})
