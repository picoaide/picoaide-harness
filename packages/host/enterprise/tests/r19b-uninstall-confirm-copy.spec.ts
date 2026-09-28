/**
 * R19B-07（第十九轮审计）：面板内**卸载确认框**的文案必须与实现一致。
 *
 * 缺陷形态（修前）：`capability.confirmUninstallLocal/Dirty` 写的是
 * 「删除会连同你自己的文件 / 这些改动一起移除」—— 一句**无条件承诺**。而
 * `skill-install.ts` 的 `uninstallSkill` 有两条 `RESIDUE` 判据（同根用户自建影子、
 * 项目/用户/内置等其它技能根里的同名条目），R19A-S2-09 起它们**前移到删除之前**：
 * 命中即 422 且**一个字都不删**。于是用户按确认框的承诺预期"删掉自己的文件"，
 * 实际拿到的是"卸载失败 + 什么都没变"。
 *
 * 本判据读字典源码（不是 `t()` 的渲染结果）并钉三件事：
 *  1. **不许再无条件承诺**：zh/en 两条都不得出现"一起移除 / removes … too"这类
 *     只说后果、不提拒绝的句式；
 *  2. **必须写明拒绝与"不删"**：zh 含「被拒绝」「不会被删除」，en 含 refused /
 *     nothing local is deleted，且都给出下一步（先处理那一份再重试）；
 *  3. **口径与实现对拍**：`skill-install.ts` 的两条 `RESIDUE` 判据仍在
 *     `rm(target)` **之前**（否则文案里"会被拒绝"这句又变成假话）。
 *
 * ---- 变异验证 ----
 *   - 文案改回"删除会连同你自己的文件一起移除" ⇒ 第 1、2 组红；
 *   - en 改回 "removes your own files too" ⇒ 第 1、2 组红；
 *   - 面板里再硬编码一份同义文案 ⇒ 第 3 组红（源码级检查）；
 *   - `skill-install.ts` 把 `RESIDUE` 判据挪到 `rm` 之后（或删掉）⇒ 第 4 组红。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { en, setActiveLocale, t, zh } from '../src/client/locales.ts'
import { afterEach } from 'vitest'

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url))
const LOCALE_FILE = join(PKG_ROOT, 'src', 'client', 'locales.ts')
const PANEL_FILE = join(PKG_ROOT, 'src', 'client', 'CapabilityCenterPanel.tsx')
const INSTALL_FILE = join(PKG_ROOT, 'src', 'skill-install.ts')

const CJK = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/u

/** 两条"卸载确认"正文（面板里紧挨着删除按钮显示）。 */
const KEYS = ['capability.confirmUninstallLocal', 'capability.confirmUninstallDirty'] as const

/** 修前那两句无条件承诺（连同常见变体）。 */
const UNCONDITIONAL_ZH = ['一起移除', '一并移除', '会连同']
const UNCONDITIONAL_EN = [/removes? (your own files|those changes) too/iu, /removes? .{0,24}too\./iu]

afterEach(() => { setActiveLocale('zh') })

describe('R19B-07：卸载确认文案不再做无条件承诺', () => {
  it('zh：不出现"一起移除"式承诺，且写明会被拒绝、本地内容不会被删除', () => {
    for (const key of KEYS) {
      const text = zh[key]
      for (const banned of UNCONDITIONAL_ZH) {
        expect(text, `${key} 不得再写「${banned}」`).not.toContain(banned)
      }
      // 必须有的两件事：可能被拒绝 + 被拒时不删本地内容。
      expect(text, `${key} 必须说明可能被拒绝`).toContain('被拒绝')
      expect(text, `${key} 必须说明本地内容不会被删除`).toContain('不会被删除')
      // 以及"接下来该做什么"：先处理另一份副本再重试。
      expect(text, `${key} 必须给出下一步`).toContain('先处理那一份再重试')
      // 仍是带 {name} 的模板（面板传 name）。
      expect(text, `${key} 必须保留 {name} 占位符`).toContain('{name}')
    }
  })

  it('en：同样不再承诺无条件移除，且写明 refused / nothing local is deleted', () => {
    for (const key of KEYS) {
      const text = en[key]
      for (const banned of UNCONDITIONAL_EN) {
        expect(banned.test(text), `${key} 不得再写 ${String(banned)}`).toBe(false)
      }
      expect(text, `${key} must state the refusal`).toMatch(/refus/iu)
      expect(text, `${key} must state that nothing local is deleted`).toMatch(/nothing local is deleted/iu)
      expect(text, `${key} must give the next step`).toMatch(/handle that copy first/iu)
      expect(text, `${key} must keep the {name} placeholder`).toContain('{name}')
      expect(CJK.test(text), `${key} must not leak Chinese`).toBe(false)
    }
  })

  it('渲染结果：两种语言下都带上技能名，且都不含旧承诺句式', () => {
    for (const key of KEYS) {
      const rendered = t(key, { name: 'alpha' })
      expect(rendered).toContain('alpha')
      for (const banned of UNCONDITIONAL_ZH) expect(rendered, key).not.toContain(banned)
    }
    setActiveLocale('en')
    for (const key of KEYS) {
      const rendered = t(key, { name: 'alpha' })
      expect(rendered).toContain('alpha')
      for (const banned of UNCONDITIONAL_EN) expect(banned.test(rendered), key).toBe(false)
    }
  })
})

describe('R19B-07：面板只有一份文案（字典），且引用的就是这两条', () => {
  it('CapabilityCenterPanel 引用这两个 key，且源码里没有第二份同义硬编码', () => {
    const source = readFileSync(PANEL_FILE, 'utf8')
    expect(source).toContain("t('capability.confirmUninstallLocal'")
    expect(source).toContain("t('capability.confirmUninstallDirty'")
    for (const banned of UNCONDITIONAL_ZH) expect(source, `面板不得硬编码「${banned}」`).not.toContain(banned)
    expect(source).not.toMatch(/removes? (your own files|those changes) too/iu)
  })

  it('字典里这两条只有一处定义（zh/en 各一份，没有第三份副本）', () => {
    const source = readFileSync(LOCALE_FILE, 'utf8')
    for (const key of KEYS) {
      const occurrences = source.match(new RegExp(`'${key.replace('.', '\\.')}'`, 'gu')) ?? []
      expect(occurrences, `${key} 应恰好定义两次（zh + en）`).toHaveLength(2)
    }
  })
})

describe('R19B-07：文案口径与实现绑定（拒绝是"删除之前"的）', () => {
  it('uninstallSkill 的两条 RESIDUE 前置判据仍在 rm(target) 之前', () => {
    const source = readFileSync(INSTALL_FILE, 'utf8')
    const shadow = source.indexOf('const userShadowPreflight')
    const foreign = source.indexOf('const foreignPreflight')
    const remove = source.indexOf('await rm(target')
    // 三处都在同一段实现里：缺任一处 ⇒ 文案里"会被拒绝"成了假话。
    expect(shadow, '同根影子的前置判据不见了').toBeGreaterThan(-1)
    expect(foreign, '跨根残留的前置判据不见了').toBeGreaterThan(-1)
    expect(remove, '删除本身不见了').toBeGreaterThan(-1)
    expect(shadow, '同根影子判据必须在删除之前').toBeLessThan(remove)
    expect(foreign, '跨根残留判据必须在删除之前').toBeLessThan(remove)
    // 两条判据都抛同一个拒绝构造点（`RESIDUE` ⇒ 422），文案里说的"被拒绝"就是它。
    expect(source).toContain('function uninstallResidueRefusal')
    expect(source).toContain("'RESIDUE'")
  })
})
