/**
 * vendored memory-evolve 旧色板适配层的**覆盖率与取值**护栏（2026-09-16 暗色审计）。
 *
 * 为什么必须有这条测试：适配层是"用一份映射表兜住另一个仓库的坏名字"，
 * 一旦上游同步带进新名字、或我们漏写一个，症状依旧是**静默**的（颜色不随主题变化、
 * 或整条声明失效）。所以这里做三件事：
 *  1. 全深度扫描 vendored 源码里所有 `var(--dsw-*)` 引用，逐个对账：**未定义的名字
 *     必须在适配层里有条目**（多了/少了都报）；
 *  2. 适配层里凡是 `var(--x)` 的目标名，必须能在上游 ui-theme 样式里找到定义
 *     （防上游改名后层静默失效）；
 *  3. 每个条目 light/dark 都非空（上游 validateOverrides 会拒空串，且单值会在
 *     切换主题时变得不可读）。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LEGACY_THEME_TOKENS } from '../src/client/legacy-theme-tokens.ts'

/** 仓库根（`packages/host/desktop/tests/` 往上三层）。 */
const workspaceRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const THEME_ROOT = join(workspaceRoot, 'deepseek-harness', 'packages', 'client', 'ui-theme', 'src')
const VENDOR_ROOT = join(workspaceRoot, 'packages', 'vendor', 'memory-evolve', 'src')

/** 上游样式里定义过的全部 token（亮色基准 ∪ 暗色覆盖 ∪ 其它主题样式文件）。 */
function upstreamTokens(): Set<string> {
  const defined = new Set<string>()
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) walk(path)
      else if (/\.(?:css|ts)$/u.test(entry)) {
        const text = readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '')
        for (const match of text.matchAll(/(--[a-z0-9-]+)\s*:/gu)) defined.add(match[1]!)
      }
    }
  }
  walk(THEME_ROOT)
  return defined
}

/** 全深度扫出 vendored 源码里引用的 token（含嵌套 var 的内层）。 */
function referencedTokens(): { token: string, defined: boolean }[] {
  const defined = upstreamTokens()
  const out: { token: string, defined: boolean }[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) walk(path)
      else if (/\.(?:css|tsx?)$/u.test(entry)) {
        const text = readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '')
        for (const match of text.matchAll(/var\(\s*(--dsw-[a-z0-9-]+)/gu)) {
          out.push({ token: match[1]!, defined: defined.has(match[1]!) })
        }
      }
    }
  }
  walk(VENDOR_ROOT)
  return out
}

describe('vendored memory-evolve 旧色板适配层', () => {
  it('vendored 源码里未定义的 --dsw-* 名字全部被适配层覆盖（且不多不少）', () => {
    const referenced = referencedTokens()
    const undefinedNames = [...new Set(referenced.filter(entry => !entry.defined).map(entry => entry.token))].sort()
    const covered = Object.keys(LEGACY_THEME_TOKENS).sort()
    // 少一个 ⇒ 那个名字继续走 fallback（静默不随主题变化）；多一个 ⇒ 上游已经补上了
    // 同名 token，这一层该删（否则我们的值会盖住上游的新设计）。
    expect(undefinedNames).toEqual(covered)
    expect(referenced.length).toBeGreaterThan(100)
  })

  it('映射里的 var() 目标都是上游真实存在的 token', () => {
    const defined = upstreamTokens()
    const targets = new Set<string>()
    for (const modes of Object.values(LEGACY_THEME_TOKENS)) {
      for (const value of [modes.light, modes.dark]) {
        for (const match of value.matchAll(/var\(\s*(--[a-z0-9-]+)\s*\)/gu)) targets.add(match[1]!)
      }
    }
    expect(targets.size).toBeGreaterThan(20)
    const missing = [...targets].filter(token => !defined.has(token)).sort()
    expect(missing).toEqual([])
  })

  it('每个条目都给了亮/暗两套非空取值', () => {
    for (const [name, modes] of Object.entries(LEGACY_THEME_TOKENS)) {
      expect(modes.light, `${name}.light`).not.toBe('')
      expect(modes.dark, `${name}.dark`).not.toBe('')
    }
  })
})
