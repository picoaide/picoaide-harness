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
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  AI_ATTRIBUTION_WIRING,
  ATTRIBUTION_CHAIN_ANCHORS,
  ATTRIBUTION_HEADER_TEXT_ONLY,
  ATTRIBUTION_HEADER_READERS,
  ATTRIBUTION_HEADER_WRITERS,
  ATTRIBUTION_SESSION_HEADER,
  ATTRIBUTION_SESSION_PREFIX,
  OPENS_DETAIL_RETENTION_DAYS,
} from './opens-contract'
import { UPSTREAM_SESSION_HEADER_LINE } from './upstream-anchor-freeze'

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
const REPO_ROOT = resolve(SERVER_DIR, '..')
const STORE_GO = join(SERVER_DIR, 'internal', 'serverstore', 'wasm_app_opens_summary.go')
const DETAIL_GO = join(SERVER_DIR, 'internal', 'serverstore', 'wasm_app_opens.go')
const API_GO = join(SERVER_DIR, 'internal', 'wasmapp', 'api', 'admin_opens.go')
const CONTRACT_TS = join(SERVER_DIR, 'webadmin', 'src', 'pages', 'app-center', 'opens-contract.ts')
const API_REFERENCE_MD = join(SERVER_DIR, 'docs', '03-api-reference.md')

for (const f of [STORE_GO, DETAIL_GO, API_GO, CONTRACT_TS, API_REFERENCE_MD]) {
  if (!existsSync(f)) throw new Error(`对拍真源缺失：${f}（缺失是失败，不是跳过 —— 静默跳过等于把判据关掉）`)
}

/**
 * 抽出包含 `marker` 的那条 **SQL 语句**（Go 反引号原文）。
 *
 * 为什么不能"在整份源码里找一句话"：注释里也会出现表名/函数名，取最近的反引号片段
 * 会命中注释里的行内代码。这里只在**反引号字符串**里找，并要求它是一条 `SELECT`
 * （多条或不唯一即 throw —— 锚点不唯一就不算判据）。
 * @param src - Go 源码全文。
 * @param marker - 语句里必须出现的标记串。
 * @returns 该 SQL 语句的原文。
 */
function sqlStatement(src: string, marker: string): string {
  const segments = [...src.matchAll(/`([^`]*)`/gu)].map((m) => m[1]!)
  const hits = segments.filter((s) => s.includes(marker))
  const selects = hits.filter((s) => /SELECT/iu.test(s))
  if (selects.length === 1) return selects[0]!
  if (selects.length > 1) {
    throw new Error(`含 ${marker} 的 SQL 有 ${selects.length} 条（锚点不唯一，判据必须指向唯一实现）`)
  }
  if (hits.length === 1) return hits[0]!
  throw new Error(`Go 源码里找不到含 ${marker} 的 SQL 语句（读源口径改了？锚点必须更新）`)
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
/** 前端契约**原文**（含注释）：文本锚点必须看注释，键解析才需要去注释。 */
const CONTRACT_RAW = readFileSync(CONTRACT_TS, 'utf8')
const TS = stripComments(CONTRACT_RAW)

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

  it('趋势读源 = 同一天同源（语义锚点；改回"PV 读日汇总 + UV 读明细"必红）', () => {
    // ---- ① 文本锚点：两侧的**说法**必须与实现同口径（R4-D-2）----
    //
    // 事故形态：AUD-1（2026-09-20）只改了实现与设计总纲，API 参考与前端契约注释仍是
    // 修复前口径（"trend[].pv 读日汇总"）⇒ 按文档实现的新消费方会复现 `uv > pv`。
    const doc = readFileSync(API_REFERENCE_MD, 'utf8')
    for (const [label, src] of [['03-api-reference.md', doc], ['opens-contract.ts', CONTRACT_RAW]] as const) {
      expect(src, `${label} 必须写明趋势"同一天同源"`).toContain('同一天同源')
      for (const stale of ['trend[].pv` 读**日汇总**', '`trend[]` 读**日汇总**', '读源是有意分开的', '双读源是有意的']) {
        expect(src, `${label} 不得残留修复前口径「${stale}」`).not.toContain(stale)
      }
    }

    // ---- ② 查询锚点：PV 与 UV 必须出自**同一次**明细聚合（GROUP BY 1）----
    //
    // 判据不是"文件里出现过某张表名"（存在性断言改回旧行为仍绿），而是**趋势那两条
    // 查询各自的形状**：明细聚合一次给出 count(*) 与 count(DISTINCT user_id)；
    // 日汇总回落只取 SUM(pv)（不含 user_id —— 那天的人数已不可知，如实给 0）。
    const detailAgg = sqlStatement(GO_STORE, 'width_bucket')
    expect(detailAgg, '趋势明细聚合必须同时算 count(*)').toMatch(/count\(\*\)/)
    expect(detailAgg, '趋势明细聚合必须同时算 count(DISTINCT user_id)').toMatch(/count\(DISTINCT user_id\)/)
    expect(detailAgg, 'PV/UV 必须来自同一次聚合（同一个 GROUP BY）').toMatch(/GROUP BY 1/)
    expect(detailAgg, '趋势明细聚合必须读明细表').toContain('FROM wasm_app_opens')

    const fallback = sqlStatement(GO_STORE, 'wasm_app_opens_daily')
    expect(fallback, '日汇总回落只取 PV（SUM(pv)）').toMatch(/SUM\(pv\)/)
    expect(fallback, '日汇总表里没有 user_id 维度，回落分支不得去算 UV').not.toContain('user_id')

    // ---- ③ 装配锚点：明细覆盖到的天用同源聚合，直接 continue（不回落到日汇总）----
    //
    // 这一条是"改回旧行为必红"的关键：旧行为下每一天的 PV 都来自 summaryPV，
    // `PV: agg.PV, UV: agg.UV` 这一句会消失。
    expect(
      GO_STORE,
      '趋势装配必须在"该日有明细"分支里用同一次聚合的 PV+UV（`PV: agg.PV, UV: agg.UV`）',
    ).toContain('PV: agg.PV, UV: agg.UV')
    const fallbackAppend = 'PV: pv, UV: 0'
    expect(GO_STORE, '日汇总回落分支必须把 UV 如实给 0').toContain(fallbackAppend)

    // ④ 去重口径（§5.1c A 的硬约束）：逐日/逐应用相加会把同一个人算成 N 个。
    expect(GO_STORE).toContain('count(DISTINCT user_id)')
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

  it('明细保留期：前端回落常量 ↔ Go 真源（R4-D-9）', () => {
    // 前端在三处把它当**回落值/请求窗口**用（OpensBoard / AppOpensSection），却只对自己
    // 断言 `toBe(90)`（自证）。Go 改一行保留期（`WasmAppOpensRetentionDays`）后前端仍按
    // 90 天算 ⇒ 「全部（长期日汇总）」会少取，或显示错误的保留天数。这里读 Go 真源比。
    const go = /WasmAppOpensRetentionDays\s*=\s*(\d+)/u.exec(GO_DETAIL)
    if (go === null) {
      throw new Error('wasm_app_opens.go 里找不到 WasmAppOpensRetentionDays（改名了？对拍真源必须更新）')
    }
    expect(
      OPENS_DETAIL_RETENTION_DAYS,
      '前端 OPENS_DETAIL_RETENTION_DAYS 必须等于 Go 的 WasmAppOpensRetentionDays',
    ).toBe(Number(go[1]))
  })
})

// ---------------------------------------------------------------------------
// D. 应用 AI 归因通道的接线状态（R4-D-4：只有读没有写）
// ---------------------------------------------------------------------------

/** 扫描面：平台侧源码（Go 服务端 + 客户端包）。 */
const ATTRIBUTION_SCAN_ROOTS = ['server/internal', 'server/cmd', 'packages']
/** 不进扫描面的目录：依赖、构建产物、测试夹具。 */
const SCAN_SKIP_DIRS = new Set(['node_modules', 'lib', 'dist', 'build', 'coverage', 'temp', 'tests', 'test', 'testdata', '__tests__'])
/** 测试文件不算产品源码（它们只断言契约，不构造出站头）。 */
const SCAN_SKIP_FILE = /(\.spec\.|\.test\.|_test\.go$)/u
/** 出站头名（大小写不敏感）。 */
const ATTRIBUTION_HEADER_RE = /x-pico-app-id/iu

/**
 * 递归收集"提到出站头名"的产品源文件（仓库相对 POSIX 路径，已排序）。
 *
 * fail-loud：一个文件都没扫到 ⇒ throw（扫描面写错/被搬走时不能"零命中全绿"）。
 * @param root - 仓库根。
 * @returns 命中文件清单与扫描文件总数。
 */
function scanAttributionHeaderFiles(root: string): { hits: string[]; scanned: number } {
  const hits: string[] = []
  let scanned = 0
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || SCAN_SKIP_DIRS.has(entry.name)) continue
        walk(full)
        continue
      }
      if (!entry.isFile() || SCAN_SKIP_FILE.test(entry.name)) continue
      scanned += 1
      let text = ''
      try {
        text = readFileSync(full, 'utf8')
      } catch {
        continue // 非常规文件（管道/权限）不参与判据
      }
      if (ATTRIBUTION_HEADER_RE.test(text)) hits.push(relative(root, full).split('\\').join('/'))
    }
  }
  for (const rel of ATTRIBUTION_SCAN_ROOTS) {
    const dir = join(root, rel)
    if (!existsSync(dir)) throw new Error(`归因扫描面缺失：${rel}（扫描面缩水是失败，不是跳过）`)
    walk(dir)
  }
  if (scanned === 0) throw new Error(`归因扫描面一个文件都没扫到（root=${root}）—— 扫描器坏了必须红`)
  return { hits: hits.sort(), scanned }
}

/**
 * "真的在写这个出站头"的形态（Go/TS 各两种常见写法）。
 *
 * 与"文件清单双向对拍"互补：清单能抓住**新文件**里冒出这个头，但抓不住"已经登记的
 * 读方文件里多出一行写"。这条纯句法扫描不依赖登记表，代价是只覆盖常见写法
 * （常量间接写法的兜底仍是登记表 + 人工决定）。
 */
const ATTRIBUTION_WRITE_PATTERNS: Array<[string, RegExp]> = [
  ['Go: Header.Set(...)', /(?:Header|h)\.(?:Set|Add)\(\s*(?:appIDHeader|"X-Pico-App-Id")/iu],
  ['Go: req.Header["X-Pico-App-Id"] = ...', /\[\s*"X-Pico-App-Id"\s*\]\s*=/u],
  ['TS: new Headers({...})/headers: {...}', /['"]x-pico-app-id['"]\s*:/iu],
  ['TS: headers.set(...)', /\.(?:set|append)\(\s*['"]x-pico-app-id['"]/iu],
]

describe('跨端对拍 · D 应用 AI 归因通道（R4-D-4 / R13-GB）', () => {
  const found = scanAttributionHeaderFiles(REPO_ROOT)
  const declared = [
    ...ATTRIBUTION_HEADER_READERS,
    ...ATTRIBUTION_HEADER_WRITERS,
    ...ATTRIBUTION_HEADER_TEXT_ONLY,
  ].sort()

  it('出站头 X-Pico-App-Id 的登记表与实际源码**双向**相等（冒出写方即红）', () => {
    expect(found.scanned, '扫描面必须真的覆盖到源码（缩面即失败）').toBeGreaterThan(200)
    for (const rel of declared) {
      expect(existsSync(join(REPO_ROOT, rel)), `登记表里的文件不存在：${rel}`).toBe(true)
    }
    expect(
      found.hits,
      'X-Pico-App-Id 出现的文件必须全部登记（新出现写方/读方 ⇒ 本用例红，逼着同步接线状态与文案）',
    ).toEqual(declared)
  })

  it('接线状态与"是否真的有人写出站头"一致（未接线时不得出现写方句法）', () => {
    const offenders: string[] = []
    for (const rel of found.hits) {
      const text = readFileSync(join(REPO_ROOT, rel), 'utf8')
      for (const [label, pattern] of ATTRIBUTION_WRITE_PATTERNS) {
        if (pattern.test(text)) offenders.push(`${rel} (${label})`)
      }
    }
    if (AI_ATTRIBUTION_WIRING === 'not_wired') {
      expect(
        offenders,
        `平台侧归因通道标为"未接线"，但这些文件在写出站头（接线状态与文案必须一起改）：${offenders.join(', ')}`,
      ).toEqual([])
    } else {
      // 2026-09-24 起 `'wired'` 说的是**会话链路**（见下一条），不再来自自报头的发送方；
      // 自报头必须仍然**零写方**（它的设计发不出来，网关也只识别并忽略）。
      expect(
        offenders,
        `自报头 X-Pico-App-Id 不该有任何写方（真实链路是会话 id 的前缀）：${offenders.join(', ')}`,
      ).toEqual([])
    }
  })

  it('归因链路三段锚点齐备（客户端前缀 / 上游头名 / 服务端契约），且与接线状态双向一致', () => {
    // 这条替代原先"从自报头发送方登记表派生接线状态"的判据：真实链路是**会话 id 本身**
    // （§21.7⑤ 的替代路径），发送方在 pinned 上游 submodule 里、不在本仓扫描面内，
    // 所以改用**三段锚点机械对拍** —— 任何一段缺失或漂移都判红。
    const anchors = [
      ['客户端前缀常量', ATTRIBUTION_CHAIN_ANCHORS.client, new RegExp(`AI_HIDDEN_SESSION_PREFIX\\s*=\\s*'${ATTRIBUTION_SESSION_PREFIX}'`, 'u')],
      ['上游出站头名', ATTRIBUTION_CHAIN_ANCHORS.sender, new RegExp(`'${ATTRIBUTION_SESSION_HEADER}':\\s*String\\(options\\.sessionId\\)`, 'u')],
      ['服务端契约前缀', ATTRIBUTION_CHAIN_ANCHORS.contract, new RegExp(`"prefix":\\s*"${ATTRIBUTION_SESSION_PREFIX}"`, 'u')],
      ['服务端解析实现', ATTRIBUTION_CHAIN_ANCHORS.reader, /func AppIDFromSessionID\(sessionID string\) string/u],
    ] as const
    const missing: string[] = []
    const sources: string[] = []
    for (const [label, rel, pattern] of anchors) {
      const path = join(REPO_ROOT, rel)
      if (!existsSync(path)) {
        // 只有**锚点②**（上游出站头名）会走到这里：`Go server` job 不检 submodule。
        // 用冻结件判（见 upstream-anchor-freeze.ts 的头注释），**不静默 skip**。
        if (label !== '上游出站头名') { missing.push(`${label}: 文件不存在 ${rel}`); continue }
        if (!pattern.test(UPSTREAM_SESSION_HEADER_LINE)) {
          // 先记来源再报错：否则先触发的是下面那条"sources 少一条"的断言，
          // 看不到本条真正想说的话（V13-B 复审实测）。
          sources.push(`${label}: submodule 缺席 ⇒ 按冻结件判定（但冻结件不含锚点）`)
          missing.push(`${label}: 冻结件本身不含锚点（upstream-anchor-freeze.ts 与锚点模式不一致）`)
          continue
        }
        sources.push(`${label}: submodule 缺席 ⇒ 按冻结件判定（Go server job 不检 submodule）`)
        continue
      }
      const text = readFileSync(path, 'utf8')
      if (!pattern.test(text)) missing.push(`${label}: ${rel} 里找不到锚点`)
      // submodule 在场 ⇒ 多判一半：活上游必须逐字包含冻结行（上游漂移必须同步冻结件）。
      if (label === '上游出站头名' && !text.includes(UPSTREAM_SESSION_HEADER_LINE)) {
        missing.push(`${label}: 活上游与冻结件**不一致**（pin/适配器变了？请同步 `
          + '`upstream-anchor-freeze.ts` 的 `UPSTREAM_SESSION_HEADER_LINE`）')
      }
      sources.push(`${label}: 活文件`)
    }
    // 来源必须可见（否则"用了冻结件"这件事会变成静默降级）。
    expect(sources.length, `每条锚点都要记录判定来源：${sources.join('；')}`).toBe(anchors.length)
    expect(
      missing,
      `归因链路的三段锚点必须齐备（缺一段 ⇒ 归因不会产生，面板文案必须改回"尚未接线"）：${missing.join('；')}`,
    ).toEqual([])
    // 双向：锚点齐备 ⇔ `'wired'`。
    expect(
      AI_ATTRIBUTION_WIRING,
      '三段锚点齐备 ⇒ 接线状态必须是 wired（反向：改回 not_wired 也就必须让锚点消失）',
    ).toBe('wired')
  })

  it('文案不得把"没有归因"归因于客户端版本/客户环境（文本锚点）', () => {
    const ui = readFileSync(join(SERVER_DIR, 'webadmin', 'src', 'pages', 'app-center', 'AppAiUsageSection.tsx'), 'utf8')
    const doc = readFileSync(API_REFERENCE_MD, 'utf8')
    if (AI_ATTRIBUTION_WIRING === 'not_wired') {
      // 面板：成因必须是"平台侧尚未接线"，不得出现"客户端尚未上报 / 老客户端"。
      expect(ui, 'AI 用量面板必须写明"平台侧归因通道尚未接线"').toContain('尚未接线')
      expect(ui, '不得再把成因写成"客户端尚未上报"').not.toContain('客户端尚未上报')
      expect(ui, '不得再把成因写成"老客户端"').not.toContain('老客户端')
      expect(doc, 'API 参考必须写明客户端出站头尚未接线').toContain('归因通道尚未接线')
    } else {
      // 已接线：不得再说"尚未接线"；且必须写明真实链路（会话 id 的 app: 前缀）。
      expect(ui, '归因已接线，面板不得再说"尚未接线"').not.toContain('尚未接线')
      expect(ui, '面板必须写明归因来自会话链路（app: 前缀）').toContain(ATTRIBUTION_SESSION_PREFIX)
      expect(ui).not.toContain('老客户端')
      expect(doc, 'API 参考不得再说"归因通道尚未接线"').not.toContain('归因通道尚未接线')
      expect(doc, 'API 参考必须写明归因来自会话链路（app: 前缀）').toContain(ATTRIBUTION_SESSION_PREFIX)
    }
  })
})
