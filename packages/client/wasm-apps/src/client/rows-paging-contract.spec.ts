/// <reference types="node" />
/**
 * **作者数据面分页口径的跨语言对拍**（服务端 `rows.go` ↔ 客户端 `DataBrowserPanel`）。
 *
 * 背景（2026-09-21 独立审计 P3-⑥）：面板硬编码 `PAGE_SIZE = 50`，服务端硬编码
 * `rowsDefaultLimit = 50` / `rowsMaxLimit = 200`（`server/internal/wasmapp/api/rows.go`）。
 * 这个 50 是**两处独立写死的同一件事** —— 任一侧改动（例如服务端把缺省改成 20）
 * 都会让分页静默漂移：面板按 50 计算"第几页 / 有没有下一页"，而服务端只回 20 行，
 * 于是"下一页"永远点不动、页码跳过整段数据，且**没有任何判据会红**。
 *
 * 本文件读服务端源码里的常量并逐项对拍客户端镜像 —— 与 `appcfg-contract.spec.ts`
 * 同一手法（真源缺席 ⇒ 直接失败，不 skip：skip 会让漂移完全静默）。
 *
 * ---- 变异验证 ----
 *   - 把 `DataBrowserPanel.tsx` 的 `PAGE_SIZE` 改成 20 ⇒ 「面板页大小 == 服务端缺省行数」红；
 *   - 把 `rows.go` 的 `rowsDefaultLimit` 改成 20 ⇒ 同一条红（两个方向都钉住）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/** 仓库根：从本文件（`packages/client/wasm-apps/src/client/`）往上走四级。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..')

const ROWS_GO = 'server/internal/wasmapp/api/rows.go'
const PANEL_TSX = 'packages/client/wasm-apps/src/client/DataBrowserPanel.tsx'

/** 从 Go 源码里读一个 `name = <int>` 形式的常量；读不到即抛（不静默回落）。 */
function goIntConst(source: string, name: string): number {
  const match = new RegExp(`\\b${name}\\s*=\\s*(\\d+)`).exec(source)
  if (match === null) throw new Error(`服务端 ${ROWS_GO} 里找不到常量 ${name}（改名或删掉都会让本判据失效）`)
  return Number(match[1])
}

/** 从 TSX 源码里读 `const NAME = <int>`。 */
function tsIntConst(source: string, name: string): number {
  const match = new RegExp(`const\\s+${name}\\s*=\\s*(\\d+)`).exec(source)
  if (match === null) throw new Error(`客户端 ${PANEL_TSX} 里找不到常量 ${name}（改名或删掉都会让本判据失效）`)
  return Number(match[1])
}

function read(relative: string): string {
  try {
    return readFileSync(join(REPO_ROOT, relative), 'utf8')
  } catch (err) {
    throw new Error(`对拍所需的服务端/客户端源文件读不到（${relative}）：${String(err)}`)
  }
}

describe('作者数据面分页口径：客户端面板 ↔ 服务端 rows.go（P3-⑥）', () => {
  const go = read(ROWS_GO)
  const panel = read(PANEL_TSX)

  it('面板页大小 == 服务端缺省行数（同一个 50，不允许两处各写一份）', () => {
    expect(tsIntConst(panel, 'PAGE_SIZE')).toBe(goIntConst(go, 'rowsDefaultLimit'))
  })

  it('面板页大小 <= 服务端单次上限（否则面板要的那一页永远拿不满）', () => {
    expect(tsIntConst(panel, 'PAGE_SIZE')).toBeLessThanOrEqual(goIntConst(go, 'rowsMaxLimit'))
  })

  it('服务端上限 > 缺省（上限若等于缺省，"能要更多"就是假的）', () => {
    expect(goIntConst(go, 'rowsMaxLimit')).toBeGreaterThan(goIntConst(go, 'rowsDefaultLimit'))
  })

  it('面板用的是自己发出去的那个 limit 回报的 offset（不拿本地常量算页码与下一页）', () => {
    // 判据：翻页按钮与页码都必须读 `rows.report.offset`，不能写 `offset ± PAGE_SIZE`
    // 之外的第二套口径 —— 服务端会把越界参数**收敛**后回显，面板必须信回显值。
    expect(panel).toContain('rows.report.offset - PAGE_SIZE')
    expect(panel).toContain('rows.report.offset + PAGE_SIZE')
    expect(panel).toContain('Math.floor(rows.report.offset / PAGE_SIZE) + 1')
  })
})
