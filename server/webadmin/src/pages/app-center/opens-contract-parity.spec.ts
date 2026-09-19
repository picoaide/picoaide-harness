/**
 * 管理端看板**响应形状的跨端对拍**（设计 §5.1c；A2-L6 第二轮审计 R2-L6-1/R2-L6-2 的核心增量）。
 *
 * ## 为什么必须有这条用例
 *
 * 这次 P1 的成因不是"某一侧写错了"，而是**两侧各钉自己的字面量**：服务端把响应键写在
 * `internal/wasmapp/api/admin_opens.go` 的 `gin.H{}` 与 `serverstore` 的 json tag 上，
 * 前端把契约写在本文件同目录的 `opens-contract.ts` 注释里 —— 谁也读不到对方，
 * 于是"参数与路径全对、响应键全错"，真实环境里看板恒显示 `—`、AI 面板整块不出数。
 * 现有的 webadmin 用例全部使用**前端自订夹具**，所以整套测试仍然是绿的
 * （章程 §3「各钉自己的字面量 / mock 掩盖真实契约」，正是这次漏检的原因）。
 *
 * ## 这条用例怎么判
 *
 * 它**读两边的源码**（不用任何夹具）：
 *   - Go 侧：`server/internal/serverstore/wasm_app_opens_summary.go` 的结构体 `json` tag
 *     + `server/internal/wasmapp/api/admin_opens.go` 里处理器的 `gin.H{}` 键；
 *   - 前端侧：`opens-contract.ts` 里 `interface` 的**声明键**（解析其源码，不是另写一份列表）。
 * 然后断言**集合相等（逐键一致）**：任何一侧改名、加键、删键都会立刻变红，
 * 并指出是哪一侧漂了。参照本仓既有对拍 spec 的写法
 * （`packages/host/wasm-apps-host/src/header-spec-parity.spec.ts`、
 * `budget-parity.spec.ts`：都读对方源码，而不是各用各的夹具）。
 *
 * ## 变异验证（改坏任一侧 ⇒ 必红，均已实跑）
 *
 *   - 把 Go 的 `window_pv` 改名（或前端 `OpensAppRow.window_pv` 改名）⇒ 第 2 条红；
 *   - 把 `attribution_available` 从 Go 结构体删掉（或前端 `AiUsage` 里删掉）⇒ 第 5 条红；
 *   - 把前端 `OpensSummary.today` 删掉、或把 `gin.H` 的 `totals` 删掉 ⇒ 第 1/2 条红；
 *   - 解析器自己坏掉（找不到结构体/接口）⇒ 直接抛错（**不静默零命中**），
 *     第 7 条另有"锚点必须命中"的非空自证。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// ---------------------------------------------------------------------------
// 定位两侧真源（路径不写死：从 cwd 向上找服务端标记，与 Audit.test.tsx 同款）
// ---------------------------------------------------------------------------

/**
 * 服务端源码根（`server/`）。
 *
 * 不用 `import.meta.url`：jsdom 环境下它是 `http://localhost/...`（`fileURLToPath`
 * 会直接抛 "The URL must be of scheme file"）。与 `src/pages/Audit.test.tsx` 同款做法。
 */
function findServerDir(): string {
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'internal', 'wasmapp', 'api', 'admin_opens.go'))) return dir
    if (existsSync(join(dir, 'server', 'internal', 'wasmapp', 'api', 'admin_opens.go'))) {
      return join(dir, 'server')
    }
    dir = resolve(dir, '..')
  }
  throw new Error(`找不到服务端源码根（cwd=${process.cwd()}）：本用例读 Go 源码对拍，找不到真源必须红`)
}

const SERVER_DIR = findServerDir()
const STORE_GO = join(SERVER_DIR, 'internal', 'serverstore', 'wasm_app_opens_summary.go')
const DETAIL_GO = join(SERVER_DIR, 'internal', 'serverstore', 'wasm_app_opens.go')
const API_GO = join(SERVER_DIR, 'internal', 'wasmapp', 'api', 'admin_opens.go')
const CONTRACT_TS = join(SERVER_DIR, 'webadmin', 'src', 'pages', 'app-center', 'opens-contract.ts')

for (const f of [STORE_GO, DETAIL_GO, API_GO, CONTRACT_TS]) {
  if (!existsSync(f)) throw new Error(`对拍真源缺失：${f}（缺失是失败，不是跳过 —— 静默跳过等于把判据关掉）`)
}

/** 去掉注释后再解析：注释里出现的 `{`/`}` 会把"成员名在顶层"的判定带偏。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

/** 取 `open` 处 `{` 与配对 `}` 之间的内容。 */
function braceBody(src: string, open: number): string {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    const ch = src[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return src.slice(open + 1, i)
    }
  }
  throw new Error(`括号不闭合（offset=${open}）`)
}

/**
 * Go 结构体的 `json` tag 名（**声明顺序**）。
 *
 * `json:"-"` 与 `json:",omitempty"`（无名）跳过 —— 它们不是响应键。
 */
function goJSONKeys(src: string, structName: string): string[] {
  const m = new RegExp(`type\\s+${structName}\\s+struct\\s*\\{`).exec(src)
  if (m === null) throw new Error(`Go 源码里找不到结构体 ${structName}（改名了？对拍真源必须更新）`)
  const keys: string[] = []
  for (const line of braceBody(src, src.indexOf('{', m.index)).split('\n')) {
    const tag = /json:"([^"]*)"/.exec(line)
    if (tag === null) continue
    const name = tag[1].split(',')[0]
    if (name === '' || name === '-') continue
    keys.push(name)
  }
  return keys
}

/** 处理器里 `c.JSON(http.StatusOK, gin.H{…})` 的**顶层**键（嵌套对象的键不算）。 */
function goGinHKeys(src: string, funcName: string): string[] {
  const fm = new RegExp(`func \\(h \\*Handlers\\) ${funcName}\\(c \\*gin\\.Context\\) \\{`).exec(src)
  if (fm === null) throw new Error(`Go 源码里找不到处理器 ${funcName}`)
  const body = braceBody(src, src.indexOf('{', fm.index))
  const jm = /c\.JSON\(http\.StatusOK,\s*gin\.H\{/.exec(body)
  if (jm === null) throw new Error(`${funcName} 里找不到 gin.H 响应（响应改用别的写法了？）`)
  const keys: string[] = []
  let depth = 0
  for (const line of braceBody(body, body.indexOf('{', jm.index + jm[0].length - 1)).split('\n')) {
    const t = line.trim()
    if (depth === 0) {
      const km = /^"([A-Za-z_]\w*)":/.exec(t)
      if (km !== null) keys.push(km[1])
    }
    for (const ch of line) {
      if (ch === '{' || ch === '(' || ch === '[') depth += 1
      else if (ch === '}' || ch === ')' || ch === ']') depth -= 1
    }
  }
  return keys
}

/** TypeScript `interface` 的**顶层**成员名（声明顺序；嵌套对象类型的成员不算）。 */
function tsInterfaceKeys(src: string, name: string): string[] {
  const m = new RegExp(`export interface ${name} \\{`).exec(src)
  if (m === null) throw new Error(`前端契约里找不到 interface ${name}`)
  const keys: string[] = []
  let depth = 0
  for (const line of braceBody(src, src.indexOf('{', m.index)).split('\n')) {
    const t = line.trim()
    if (depth === 0) {
      const km = /^([A-Za-z_$][\w$]*)\??\s*:/.exec(t)
      if (km !== null) keys.push(km[1])
    }
    for (const ch of line) {
      if (ch === '{' || ch === '(' || ch === '[') depth += 1
      else if (ch === '}' || ch === ')' || ch === ']') depth -= 1
    }
  }
  return keys
}

const GO_STORE = readFileSync(STORE_GO, 'utf8')
const GO_DETAIL = readFileSync(DETAIL_GO, 'utf8')
const GO_API = readFileSync(API_GO, 'utf8')
const TS = stripComments(readFileSync(CONTRACT_TS, 'utf8'))

/**
 * 逐键对拍：**集合相等**（不是"包含"）—— 多一个键也是漂移（前端会读不到/读错，
 * 服务端多下发的键意味着契约里有一半没被声明）。
 */
function sameKeys(goKeys: string[], tsKeys: string[], label: string): void {
  expect(new Set(goKeys).size, `${label}：Go 侧键不得重复（实际 ${goKeys.join(', ')}）`).toBe(goKeys.length)
  expect(new Set(tsKeys).size, `${label}：前端侧键不得重复（实际 ${tsKeys.join(', ')}）`).toBe(tsKeys.length)
  expect([...tsKeys].sort(), `${label} 的键集必须与服务端逐字一致`).toEqual([...goKeys].sort())
}

// ---------------------------------------------------------------------------
// A. 打开看板概览 `GET /wasm-apps/opens/summary`（§5.1c A）
// ---------------------------------------------------------------------------

describe('跨端对拍 · A 打开看板概览（§5.1c A）', () => {
  it('summary 顶层键：gin.H ↔ OpensSummary 逐字一致', () => {
    const goKeys = goGinHKeys(GO_API, 'adminOpensSummary')
    // 锚点非空自证：解析器坏掉时不能"零命中全绿"。
    for (const anchor of ['from', 'to', 'days', 'capped', 'trend', 'apps', 'top_apps', 'today', 'totals', 'detail_retention_days']) {
      expect(goKeys, `Go 侧 summary 响应必须声明 ${anchor}（§5.1c A 的权威键）`).toContain(anchor)
    }
    sameKeys(goKeys, tsInterfaceKeys(TS, 'OpensSummary'), 'opens/summary 顶层')
  })

  it('嵌套块 today / totals / trend / apps / top_apps 逐字一致（含 window_pv / window_uv / title）', () => {
    // today
    sameKeys(
      goJSONKeys(GO_STORE, 'WasmAppOpenSummaryToday'),
      tsInterfaceKeys(TS, 'OpensToday'),
      'opens/summary · today',
    )
    // totals（**不带 GROUP BY app_id** 的那一次聚合）
    sameKeys(
      goJSONKeys(GO_STORE, 'WasmAppOpenSummaryTotals'),
      tsInterfaceKeys(TS, 'OpensTotals'),
      'opens/summary · totals',
    )
    // trend（读日汇总，长期保留）
    sameKeys(
      goJSONKeys(GO_STORE, 'WasmOpenTrendPoint'),
      tsInterfaceKeys(TS, 'OpensTrendPoint'),
      'opens/summary · trend[]',
    )
    // apps[]（读明细：与 §5.1b 的 opens.today 同源）
    const appKeys = goJSONKeys(GO_STORE, 'WasmAppOpenSummaryRow')
    for (const anchor of ['window_pv', 'window_uv', 'today_pv', 'today_uv', 'title']) {
      expect(appKeys, `apps[] 行必须声明 ${anchor}（R2-L6-1 的现场就是它不叫这个名字）`).toContain(anchor)
    }
    sameKeys(appKeys, tsInterfaceKeys(TS, 'OpensAppRow'), 'opens/summary · apps[]')
    // top_apps[]：§5.1c A 给的是 `{app_id,title,pv,uv}`（**不是** apps 行的窗口键）
    sameKeys(
      goJSONKeys(GO_STORE, 'WasmAppOpenTopRow'),
      tsInterfaceKeys(TS, 'OpensTopRow'),
      'opens/summary · top_apps[]',
    )
  })

  it('UV 口径的源码锚点：去重聚合 + 趋势读日汇总（两个读源是有意的）', () => {
    // ① 窗口聚合必须是 count(DISTINCT user_id) —— 逐日相加会把同一个人算成 N 个。
    expect(GO_STORE).toContain('count(DISTINCT user_id)')
    // ② 趋势读**日汇总**表（长期保留；明细 90 天过期后曲线不断档）。
    expect(GO_STORE).toContain('wasm_app_opens_daily')
    // ③ 明细窗口聚合读**明细**表（与 open 端点的 opens.today 同源）。
    expect(GO_STORE).toContain('FROM wasm_app_opens')
  })
})

// ---------------------------------------------------------------------------
// B. 应用 AI 用量 `GET /wasm-apps/:app_id/ai-usage`（§5.1c B）
// ---------------------------------------------------------------------------

describe('跨端对拍 · B 应用 AI 用量（§5.1c B）', () => {
  it('ai-usage 顶层键：WasmAppAIUsage ↔ AiUsage 逐字一致（含 attribution_available）', () => {
    const goKeys = goJSONKeys(GO_STORE, 'WasmAppAIUsage')
    for (const anchor of ['app_id', 'from', 'to', 'days', 'total', 'attribution_available']) {
      expect(goKeys, `服务端必须下发 ${anchor}（§5.1c B：webadmin 必须消费它）`).toContain(anchor)
    }
    const tsKeys = tsInterfaceKeys(TS, 'AiUsage')
    sameKeys(goKeys, tsKeys, 'ai-usage 顶层')
    // 反向自证：前端**不得**再回到旧的自订字面量（`points`/`calls`/`total_tokens`）。
    for (const legacy of ['points', 'calls', 'total_tokens']) {
      expect(tsKeys, `前端契约不得再声明旧字面量 ${legacy}（R2-L6-2 的病根）`).not.toContain(legacy)
    }
  })

  it('ai-usage 按日/合计行：WasmAppAIUsageDay ↔ AiUsageDay 逐字一致（requests 而不是 calls）', () => {
    const goKeys = goJSONKeys(GO_STORE, 'WasmAppAIUsageDay')
    for (const anchor of ['day', 'requests', 'prompt_tokens', 'completion_tokens', 'cache_prompt_tokens', 'cost']) {
      expect(goKeys, `按日行必须声明 ${anchor}`).toContain(anchor)
    }
    sameKeys(goKeys, tsInterfaceKeys(TS, 'AiUsageDay'), 'ai-usage · days[]/total')
  })
})

// ---------------------------------------------------------------------------
// C. 详情 `GET /wasm-apps/:app_id/opens`（§5.1c C：窗口不得静默退化）
// ---------------------------------------------------------------------------

describe('跨端对拍 · C 应用详情（§5.1c C）', () => {
  it('详情响应：服务端回显 from/to（前端据此渲染生效窗口），且前端必须声明它们', () => {
    const goKeys = goJSONKeys(GO_DETAIL, 'WasmOpenSeries')
    for (const anchor of ['from', 'to', 'points', 'total_pv', 'total_uv', 'detail_retention_days']) {
      expect(goKeys, `详情响应必须声明 ${anchor}`).toContain(anchor)
    }
    const tsKeys = tsInterfaceKeys(TS, 'OpensDetail')
    for (const key of goKeys) {
      expect(tsKeys, `前端 OpensDetail 必须声明服务端下发的 ${key}（缺了就读不到，也就无从渲染生效窗口）`).toContain(key)
    }
  })
})
