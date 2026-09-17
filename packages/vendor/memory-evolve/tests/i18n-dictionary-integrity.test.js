/**
 * 字典健康度（P2-B1，2026-09-16）。
 *
 * 背景：本插件的 i18n 走 `lib/i18n.js` 的 21 张 `[zh, en]` 二元组字典 +
 * `ctx.locale.bind(NS)` 调用期解析（机制是对的），但**它不在任何门禁里**：
 * `packages/host/desktop/tests/i18n-keys.spec.ts` 的 DICTIONARY_PACKAGES 只认
 * 本仓自研包的 `src/client/locales.ts` 形态，本文件补上 vendored 包这一块。
 *
 * 这里**直接 import 真实字典对象**而不是正则扫源码：字典条目两种引号混用、
 * 还含 `"Conflict {index}'s …"` 这类内嵌撇号的英文，正则解析会漏条目（假绿）。
 *
 * 钉住四条结构性不变量（都是"漂了就静默降级成 key 本身 / 英文列露出中文"的类型）：
 *  1. 每个条目恰好两个非空字符串（少一个 → 该语言渲染出 key 原文）；
 *  2. 英文列无 CJK 残留（复制粘贴最常见的错）；
 *  3. 占位符 `{name}` 在 zh/en 两侧**完全一致**（少一个 → 参数永远填不上）；
 *  4. 键在**同一张字典内**唯一（重复键在对象字面量里后者覆盖前者，
 *     是"改了没生效"的经典来源）。
 *
 * 注：跨字典同名键是**允许**的（各字典独立命名空间），故不做全局唯一断言；
 * 键与调用点的一致性由各处功能测试覆盖（本插件的键大量经 `mt()/st()` 间接
 * 引用，静态"死键"扫描会大量误报，故不在此文件做）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as i18n from '../lib/i18n.js'

/** `export const XXX_DICT = { … }` 形式的字典。 */
const DICTS = Object.entries(i18n)
  .filter(([name, value]) => name.endsWith('_DICT') && value !== null && typeof value === 'object' && !Array.isArray(value))
  .sort(([a], [b]) => a.localeCompare(b))

const CJK = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/u
const placeholders = (text) => [...String(text).matchAll(/\{([A-Za-z0-9_]+)\}/gu)].map(m => m[1]).sort()

test('字典清单可解析（导出改名/结构变化时立即红，而不是静默 0 覆盖）', () => {
  assert.ok(DICTS.length >= 20, `应发现 20+ 张 *_DICT，实际 ${DICTS.length}：${DICTS.map(([n]) => n).join(', ')}`)
  const total = DICTS.reduce((sum, [, dict]) => sum + Object.keys(dict).length, 0)
  // 宿主侧（lib/i18n.js）字典基线 573 键；阈值留出余量但足以在
  // "解析器失效 / 导出改名"时立刻变红。浏览器侧另有字典（随 lib/client.js
  // 打包，见 src/client/**），不在本文件的覆盖范围。
  assert.ok(total >= 500, `字典键总数应 ≥ 500，实际 ${total}`)
})

for (const [name, dict] of DICTS) {
  test(`${name}：二元组/非空/英文列无中文/占位符对齐/键唯一`, () => {
    const keys = Object.keys(dict)
    assert.ok(keys.length > 0, `${name} 不应为空`)
    for (const key of keys) {
      const pair = dict[key]
      assert.ok(
        Array.isArray(pair) && pair.length === 2,
        `${name}.${key} 必须是 [zh, en] 二元组，实际 ${JSON.stringify(pair)}`,
      )
      const [zh, en] = pair
      assert.equal(typeof zh, 'string', `${name}.${key} 中文列必须是字符串`)
      assert.equal(typeof en, 'string', `${name}.${key} 英文列必须是字符串`)
      assert.ok(zh.trim() !== '', `${name}.${key} 中文列不得为空`)
      assert.ok(en.trim() !== '', `${name}.${key} 英文列不得为空`)
      assert.doesNotMatch(
        en,
        CJK,
        `${name}.${key} 英文列残留中文：${en.slice(0, 60)}`,
      )
      assert.deepEqual(
        placeholders(en),
        placeholders(zh),
        `${name}.${key} 占位符两侧不一致：zh=${JSON.stringify(placeholders(zh))} en=${JSON.stringify(placeholders(en))}`,
      )
    }
  })
}

test('同一张字典内键不重复（对象字面量重复键会静默覆盖）', async () => {
  const { readFileSync } = await import('node:fs')
  const { dirname, join } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const source = readFileSync(join(dirname(dirname(fileURLToPath(import.meta.url))), 'lib', 'i18n.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//gu, '') // 块注释
    .split('\n').map((line) => line.replace(/(^|\s)\/\/.*$/u, '$1')).join('\n') // 行注释
  // TQ-7（2026-09-17 审计）：原实现只认「行首**两空格** + 'key': [」这一种缩进形态，
  // 且从不检查解析到了多少条 —— 字典一旦被重排（四空格/无缩进/双引号键），seen 恒空，
  // 重复键检查静默变成空转；插入一条缩进不同的重复键（如 4 空格的 'memory.desc'）
  // 也照样绿（变异实测 GREEN，而 JS 里后者确实覆盖前者）。
  // 现在：①按 `export const X_DICT = {` 分块；②任意缩进、单/双引号键都认；
  // ③与运行期 import 的字典**逐键对拍**（解析失效/漏条立刻红，不是静默 0 覆盖）。
  const perDict = new Map()
  let current = null
  for (const line of source.split('\n')) {
    const start = /^export const ([A-Z0-9_]+_DICT) = \{/u.exec(line)
    if (start !== null) {
      current = start[1]
      perDict.set(current, [])
      continue
    }
    if (current === null) continue
    if (line === '}') { current = null; continue } // 顶层字典以行首 `}` 收尾
    const entry = /^\s*(?:'([^']+)'|"([^"]+)")\s*:\s*\[/u.exec(line)
    if (entry !== null) perDict.get(current).push(entry[1] ?? entry[2])
  }
  const parsedTotal = [...perDict.values()].reduce((sum, keys) => sum + keys.length, 0)
  assert.ok(perDict.size >= 20, `必须解析到 20+ 张字典块，实际 ${perDict.size}（判据空转）`)
  assert.ok(parsedTotal >= 500, `源码解析出的字典键总数应 ≥ 500，实际 ${parsedTotal}（解析器失效＝判据空转）`)
  const duplicates = []
  for (const [name, keys] of perDict) {
    const seen = new Set()
    for (const key of keys) {
      if (seen.has(key)) duplicates.push(`${name}.${key}`)
      seen.add(key)
    }
    // 与运行期字典对拍：重复键会让源码侧多出一条（JS 已静默丢弃后者），
    // 条目形态变化（改成 helper 生成等）也会在这里露出来。
    assert.deepEqual(
      [...keys].sort(),
      Object.keys(i18n[name] ?? {}).sort(),
      `${name} 的源码条目与运行期字典不一致（解析器跟不上格式＝判据空转）`,
    )
  }
  assert.deepEqual(duplicates, [], `i18n.js 存在重复键（后者覆盖前者）：${duplicates.join(', ')}`)
})
