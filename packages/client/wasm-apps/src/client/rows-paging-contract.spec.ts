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

describe('rows 线格式字段名：服务端 json tag ↔ 客户端读取键（三轮审计 P2-④）', () => {
  // 为什么单独一条判据（2026-09-21 三轮独立审计）：`rowsPayload` 的字段名是**跨端冻结契约**，
  // 但两侧各有一套自己的测试 —— 服务端把 `has_more` 改名（并同步自己的用例）后，
  // **服务端 ok、客户端 30/30 全绿**，而面板会把"还有更多"读成 false（静默少一页），
  // 或把 `masked_columns` 读成空（静默显示"什么都没遮"，实际遮了）。
  // 判据 = 读服务端结构体的 json tag 集合 ↔ 读客户端解析函数里真正读的键集合，双向相等。
  //
  // 变异验证：把 `rows.go` 的 `json:"has_more"` 改成 `json:"hasMore"` ⇒ 本用例红。
  const goSrc = read(ROWS_GO)
  const clientSrc = read('packages/client/wasm-apps/src/client/app-lifecycle.ts')

  it('两侧字段名集合必须相等（缺一即红）', () => {
    const structStart = goSrc.indexOf('type rowsPayload struct {')
    expect(structStart, `${ROWS_GO} 里找不到 rowsPayload（契约结构体被改名？）`).toBeGreaterThan(-1)
    const structEnd = goSrc.indexOf('\n}', structStart)
    const structBody = goSrc.slice(structStart, structEnd)
    const serverKeys = new Set(
      [...structBody.matchAll(/json:"([a-z_]+)"/g)].map(m => m[1]!),
    )
    expect(serverKeys.size, 'rowsPayload 的 json tag 一个都没解析到（解析口径失效）').toBeGreaterThan(5)

    const parseStart = clientSrc.indexOf('export function parseRowsOutcome')
    expect(parseStart, '客户端找不到 parseRowsOutcome').toBeGreaterThan(-1)
    const parseEnd = clientSrc.indexOf('export async function fetchSchema', parseStart)
    const parseBody = clientSrc.slice(parseStart, parseEnd > 0 ? parseEnd : undefined)
    const clientKeys = new Set([...parseBody.matchAll(/body\.([a-z_]+)/g)].map(m => m[1]!))
    expect(clientKeys.size, '客户端解析函数里一个 body.<key> 都没解析到（解析口径失效）').toBeGreaterThan(0)

    // `app_id` / `table` / `rows` / `columns` 走形状校验（`asString` / `Array.isArray`），
    // 读取形态是 `body.x` 之外的写法，因此单独比对：它们必须同时出现在两侧。
    for (const shaped of ['app_id', 'table', 'rows', 'columns']) {
      expect(serverKeys.has(shaped), `服务端 rowsPayload 缺少字段 ${shaped}`).toBe(true)
      expect(clientSrc).toContain(`body.${shaped}`)
      clientKeys.delete(shaped)
    }
    serverKeys.delete('app_id')
    serverKeys.delete('table')
    serverKeys.delete('rows')
    serverKeys.delete('columns')

    const onlyServer = [...serverKeys].filter(k => !clientKeys.has(k)).sort()
    const onlyClient = [...clientKeys].filter(k => !serverKeys.has(k)).sort()
    expect(
      { onlyServer, onlyClient },
      'rows 线格式字段名必须两侧同源：只在服务端存在的字段 = 客户端没读（静默少功能）；' +
        '只在客户端存在的字段 = 服务端没给（恒 undefined）',
    ).toEqual({ onlyServer: [], onlyClient: [] })
  })
})
