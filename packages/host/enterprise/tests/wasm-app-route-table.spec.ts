/**
 * R6-B P3（第六轮审计，2026-09-23）：`createWasmAppsRoute` 的**路由表文档**与
 * handler 实际接受的分发清单必须同源。
 *
 * 缺陷形态：路由表把只读代理拆成了两行 —— 一行
 * `diagnostics|schema|export|releases|rows`（`rows` 另外要持有性证明）、另一行
 * `diagnostics|schema|export|releases|availability` —— 同一批段在前一行列过一遍、
 * 后一行又列一遍，而 `availability` 只在后一行出现。代码这边（handler 的
 * `['diagnostics','schema','export','releases','rows','availability']` 分支）其实
 * 只有**一处**分发，所以两行文档必然漂移：加一个段要改两处、漏一处的后果是
 * "文档说的能力"与"代码接受的能力"对不上（这份表是 AI/维护者读接口的第一步）。
 *
 * 判据（两条，都钉在源码文本上，不需要起 handler）：
 *   1. 表里**任何**路径段不得出现在两行里（重复列举即红 —— 正是本次的形态）；
 *   2. GET 只读代理段的集合必须**等于** handler 里那份字面量清单（文档 == 代码）。
 *
 * 变异验证（见 `temp/r6b-fix/MUTATION.md`）：把路由表改回两行（或删掉 handler 数组里
 * 的 `availability`）⇒ 对应的用例必红。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SOURCE = readFileSync(fileURLToPath(new URL('../src/wasm-apps.ts', import.meta.url)), 'utf8')

/** 路由表所在的那段 JSDoc（找不到即抛：文档搬家时必须同步改本用例的锚）。 */
function routeTableDoc(): string {
  const start = SOURCE.indexOf('构造 `/api/pico/apps/wasm` 的本地路由')
  const end = SOURCE.indexOf('export function createWasmAppsRoute(')
  if (start < 0 || end < 0 || end < start) throw new Error('找不到 createWasmAppsRoute 的路由表 JSDoc')
  return SOURCE.slice(start, end)
}

interface Row {
  method: string
  path: string
}

/** 解析表格行：`| method | \`path\` | 语义 |`（path 里的 `|` 在源码里写成 `\|`）。 */
function tableRows(): Row[] {
  const rows: Row[] = []
  for (const line of routeTableDoc().split('\n')) {
    const match = /^ \* \| ([A-Z/]+) \| `([^`]+)` \|/u.exec(line)
    if (match !== null) rows.push({ method: match[1]!, path: match[2]! })
  }
  return rows
}

/** 路径单元格里的备选段（`a\|b\|c` ⇒ `['a','b','c']`；首个段带 `/:app_id/` 前缀）。 */
function alternatives(path: string): string[] {
  return path.replace(/^\/:app_id\//u, '').split('\\|')
}

describe('R6-B P3：wasm 应用本机路由表（文档 ↔ 代码同源）', () => {
  it('路由表里没有任何段被两行重复列举（availability 曾被列两次）', () => {
    // 只统计 `/:app_id/<段>` 这一族的行（`/`、`/validate`、`/publish` 是固定路径，
    // 没有"备选段"的概念）。2026-09-23 第一版这里写了 `if (!segment.includes('/')) continue`
    // —— 归一化之后**没有一个**段含 `/`，于是整条判据恒真（假绿）；
    // 变异验证（把路由表改回两行）立刻把它暴露了。
    const seen = new Map<string, number>()
    for (const row of tableRows()) {
      if (!row.path.startsWith('/:app_id/')) continue
      for (const segment of alternatives(row.path)) {
        seen.set(segment, (seen.get(segment) ?? 0) + 1)
      }
    }
    expect(seen.size, '至少要有几条 `/:app_id/<段>` 行，否则本判据没在检查任何东西').toBeGreaterThan(4)
    const duplicated = [...seen.entries()].filter(([, count]) => count > 1).map(([segment]) => segment)
    expect(duplicated, `路由表把同一段列了多次：${duplicated.join(', ')}`).toEqual([])
  })

  it('GET 只读代理段清单 == handler 实际接受的那一份（少一个/多一个都红）', () => {
    const docSegments = new Set<string>()
    for (const row of tableRows()) {
      if (row.method !== 'GET' || !row.path.startsWith('/:app_id/')) continue
      for (const segment of alternatives(row.path)) docSegments.add(segment)
    }
    expect(docSegments.size, '路由表里必须有一行 GET 只读代理（含备选段）').toBeGreaterThan(1)

    // handler 侧的唯一真源：那一条 includes(...) 的字面量数组（源码逐字读，不 import
    // 任何运行期对象 —— 本用例的判据就是"文档说的 == 代码写的"）。
    const literal = /\[([^\]]*'diagnostics'[^\]]*)\]/u.exec(SOURCE)
    expect(literal, 'handler 里的只读段字面量数组必须存在（改名时同步改本用例）').not.toBeNull()
    const codeSegments = new Set([...literal![1]!.matchAll(/'([^']+)'/gu)].map(match => match[1]!))

    expect([...docSegments].sort()).toEqual([...codeSegments].sort())
  })

  it('对照：路由表本身仍是一张"有内容的表"（判据不是恒真）', () => {
    const rows = tableRows()
    expect(rows.length).toBeGreaterThanOrEqual(6)
    expect(rows.some(row => row.path === '/:app_id/publish\\|unpublish\\|freeze')).toBe(true)
  })
})
