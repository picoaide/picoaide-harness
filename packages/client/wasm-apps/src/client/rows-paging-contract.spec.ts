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
const TOOLS_TS = 'packages/host/enterprise/src/wasm-app-tools.ts'

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

  it('AI 工具说明里的「缺省 N 行、最多 M 行」必须与 rows.go 同源（P2-⑤）', () => {
    // 为什么单独钉这个（2026-09-21 二轮审计 P2-⑤）：50/200 这组数字在仓库里有 **4 份拷贝** ——
    // rows.go 的两个常量、面板的 PAGE_SIZE（上面已对拍），以及 `wasm-app-tools.ts` 里
    // **两处纯散文字面量**（工具描述与 limit 参数说明）。改 rows.go 而忘了改散文，
    // 模型看到的说明书就静默过期：它会以为缺省是 50，实际服务端已经按 20 返回。
    // 判据 = 从工具源码里把这两句里的数字抠出来，逐个与 Go 常量比。
    const tools = read(TOOLS_TS)
    const defaultLimit = goIntConst(go, 'rowsDefaultLimit')
    const maxLimit = goIntConst(go, 'rowsMaxLimit')

    // 允许"缺省 N 行/最多 M 行"的两种现有写法，但**必须**同时出现这两个数。
    const prose = tools.match(/缺省\s*(\d+)\s*行[、,，]\s*最多\s*(\d+)\s*行/g) ?? []
    expect(prose.length, `wasm-app-tools.ts 里应能找到「缺省 N 行、最多 M 行」这类说明（找不到 = 文案被改写，请同步本判据）`).toBeGreaterThan(0)
    for (const line of prose) {
      const nums = [...line.matchAll(/(\d+)/g)].map(m => Number(m[1]))
      expect(nums).toEqual([defaultLimit, maxLimit])
    }
    // limit 参数说明（「缺省 X，上限 Y」）同样必须同源。
    const paramLine = /limit:\s*\{[^}]*description:\s*'([^']*)'/.exec(tools)
    expect(paramLine, `${TOOLS_TS} 里找不到 limit 参数说明`).not.toBeNull()
    const paramNums = [...paramLine![1]!.matchAll(/(\d+)/g)].map(m => Number(m[1]))
    expect(paramNums).toEqual([defaultLimit, maxLimit])
  })

  it('面板用的是自己发出去的那个 limit 回报的 offset（不拿本地常量算页码与下一页）', () => {
    // 判据：翻页按钮与页码都必须读 `rows.report.offset`，不能写 `offset ± PAGE_SIZE`
    // 之外的第二套口径 —— 服务端会把越界参数**收敛**后回显，面板必须信回显值。
    expect(panel).toContain('rows.report.offset - PAGE_SIZE')
    expect(panel).toContain('rows.report.offset + PAGE_SIZE')
    expect(panel).toContain('Math.floor(rows.report.offset / PAGE_SIZE) + 1')
  })
})
