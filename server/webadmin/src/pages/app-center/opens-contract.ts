/**
 * 打开计数（F16）与 AI 应用维度用量（§21.4）的**契约面**（2026-09-19，L6 泳道）。
 *
 * 这个文件是 webadmin 侧的唯一真源：路径、类型、形状守卫、降级分类与聚合口径。
 * 页面（`OpensBoard` / `Apps` / 详情抽屉两个面板）只做渲染与编排，不再各写一份。
 *
 * ## 对服务端的契约依赖（**逐字来自设计 §5.1c**；缺任一条 ⇒ 前端**降级并显式提示**，绝不显示 0）
 *
 * ⚠️ 这一节以前是"前端自己钉的字面量"：服务端把键写在 `admin_opens.go` 的 `gin.H{}`、
 * 前端把契约写在本注释里，**两侧都没读到对方** ⇒ 真实环境看板不出数（A2-L6 第二轮审计
 * **R2-L6-1/R2-L6-2，P1**）。现在**唯一权威 = 设计 §5.1c**，并由
 * [`opens-contract-parity.spec.ts`](./opens-contract-parity.spec.ts) **读 Go 侧源码**
 * （`serverstore` 的 json tag + `admin_opens.go` 的响应键）与本文件的 `interface` 声明
 * **逐键对拍（集合相等）**。**改这里任何一个键名都必须同时改 Go 侧**，否则对拍用例立刻变红
 * —— 各用各的夹具（章程 §3「各钉自己的字面量」）正是这次漏检的原因。
 *
 * ① 列表列 + 运营看板（跨应用聚合，`capability:read`）：
 *    `GET /api/server/admin/wasm-apps/opens/summary?days=&top=`
 *    200 `{from,to,days,top,capped,detail_retention_days,
 *         today:{day,pv,uv}, totals:{pv,uv}, trend:[{day,pv,uv}…],
 *         apps:[{app_id,title,today_pv,today_uv,window_pv,window_uv}…],
 *         top_apps:[{app_id,title,pv,uv}…]}`
 *    - **读源（§5.1c A，双读源是有意的，不是 bug）**：`apps[]`/`today`/`totals` 读**明细表**
 *      `wasm_app_opens`（与 §5.1b 的 `opens.today` 同源，保证"本次调用计数在内"）；
 *      `trend[]` 读**日汇总** `wasm_app_opens_daily`（长期保留，明细 90 天过期后曲线不断档）。
 *    - `uv` = `count(DISTINCT user_id)`（§5.1c A 的硬约束）：**禁止**把逐日 `uv` 相加、
 *      **禁止**把各应用 `uv` 相加（同一个人开两个应用会重复计）⇒ `totals.uv` / `today.uv`
 *      只能取服务端那一次**不带 `GROUP BY app_id`** 的聚合值。
 *    - `capped=true`：请求窗口长于明细保留期 ⇒ 服务端收敛到保留期并如实回报，界面必须显示。
 *    - `title` 来自应用登记表；**查不到就是空串**（界面回落显示 `app_id`），不得编造。
 *    - 三个数组与 `today`/`totals` **恒在**（空就空数组/零值）⇒ 前端据此区分
 *      "端点不支持"与"确实是 0"。
 * ② 应用详情（**设计已冻结的路径**，契约 §8.9 管理端出口 ④，`capability:read`）：
 *    `GET /api/server/admin/wasm-apps/:app_id/opens?from=YYYY-MM-DD&to=YYYY-MM-DD&granularity=day|dept`
 *    200 `{app_id, from, to, granularity, points:[{app_id,day,dept_id,pv,uv}…],
 *         total_pv, total_uv, detail_retention_days}`
 *    —— **已落地**（2026-09-19，`internal/wasmapp/api/admin_opens.go` +
 *    `internal/serverstore/wasm_app_opens.go`；核对日期 2026-09-20）。三个必须知道的口径：
 *      · `granularity=day` 的 SQL 是 `GROUP BY day, dept_id` ⇒ **同一天可能有多行**
 *        （每个部门一行）；前端用 `daySeries()` 合并成按日一行（PV 相加合法，UV 相加
 *        会被标注成"加总口径"）。
 *      · `granularity=dept` 的行 `day` 为空串、只有 `dept_id`（**没有部门名**）⇒
 *        部门名由前端用 `GET /departments`（`dept:read`）best-effort 映射，取不到就
 *        显示 `#<id>`，不伪造名字。
 *      · `total_uv` = 按 (日 × 部门) 去重后**加总**，不是区间去重人数（见
 *        `OPENS_DETAIL_UV_SUM_NOTE`）。
 *    - **窗口不得静默退化**（§5.1c C / R2-L6-3）：服务端回落的窗口**必须回显 `from`/`to`**，
 *      前端**必须渲染出来**；「全部（长期日汇总）」档必须**显式请求 90 天窗口**。
 * ③ AI 用量（§21.4 / §5.1c B，`capability:read`）：
 *    `GET /api/server/admin/wasm-apps/:app_id/ai-usage?days=|from=&to=`
 *    200 `{app_id, from, to,
 *         days:[{day,requests,prompt_tokens,completion_tokens,cache_prompt_tokens,cost}…],
 *         total:{同结构}, attribution_available}`
 *    - **必须消费 `attribution_available`**（§5.1c B + §21.4）：`false` ⇒ 渲染
 *      "统计尚未上线/无归因"；`true` 且全零 ⇒ 渲染"确实零调用"。
 *      **两者数字都是 0、含义相反，合并渲染即违反 §21.4。**
 *    - 归因来自客户端出站头 `X-Pico-App-Id`（只有客户端会话链路才记录；伪造头忽略 + warn）。
 *    - 老客户端不带该头 ⇒ **归因缺失但计费正常**（§21.4 认账）。
 * ④ 计数是 best-effort：接口失败/计数异常**不影响打开**（§5.1b）；管理端同理 ——
 *    拿不到数据就显示"不可用"。
 */

import { ADMIN_API } from '../../api'
import { errorText } from '../../lib/api-error'

/** 明细保留期（§8.9 定稿：明细 90 天，日汇总长期保留）。 */
export const OPENS_DETAIL_RETENTION_DAYS = 90

/** 跨应用聚合（列表列 + 看板共用）。 */
export const OPENS_SUMMARY_PATH = `${ADMIN_API}/wasm-apps/opens/summary`

/** 应用维度打开明细/趋势（设计冻结路径，§8.9）。 */
export function opensDetailPath(appId: string, query = ''): string {
  const base = `${ADMIN_API}/wasm-apps/${appId}/opens`
  return query === '' ? base : `${base}?${query}`
}

/** 应用维度 AI 用量（§21.4）。 */
export function aiUsagePath(appId: string, query = ''): string {
  const base = `${ADMIN_API}/wasm-apps/${appId}/ai-usage`
  return query === '' ? base : `${base}?${query}`
}

/**
 * AI 用量面板**显式**请求的窗口（天）。
 *
 * 为什么不能省这个参数：端点的 from/to 缺省是"近 7 天"，省掉它就等于又一个
 * "静默窗口"（与 R2-L6-3 同类的缺陷形态）。显式传 `days` + 把服务端回显的
 * `from`~`to` 渲染出来，管理员才知道自己看的是哪一段。
 */
export const AI_USAGE_WINDOW_DAYS = 30

/** 口径说明（页面统一引用，避免三处各写一份说法）。 */
export const OPENS_COUNT_NOTE =
  'PV = 每次打开都 +1（不去重）；UV = 按用户去重（当日 / 窗口，由服务端聚合）。'
export const OPENS_RETENTION_NOTE =
  `打开明细保留 ${OPENS_DETAIL_RETENTION_DAYS} 天，更早的数据只有日汇总（长期保留，趋势不丢）。`
export const OPENS_SCOPE_NOTE =
  '计数在**每次打开应用**时由客户端调用服务端 opens 端点记录；计数失败不影响打开（best-effort）。'
export const OPENS_PRIVACY_NOTE =
  '打开明细含 user_id / 部门 / 打开时间，仅 capability:read 可见；本期不提供导出。'
export const AI_ATTRIBUTION_NOTE =
  'AI 调用按**使用者账号**计费；应用维度按客户端出站头 X-Pico-App-Id 归因，未带该头的老客户端不产生归因（计费不受影响）。'

// ---------------------------------------------------------------------------
// 响应类型（只声明我们真正渲染的字段）
// ---------------------------------------------------------------------------

/** 趋势/聚合点：日粒度给 `day`，部门粒度给 `dept_id`/`dept_name`。 */
export interface OpensPoint {
  day?: string
  dept_id?: number | null
  dept_name?: string
  pv: number
  uv: number
}

/**
 * `opens/summary` 的 `trend[]` 一点（§5.1c A）。
 *
 * 与 `OpensPoint`（详情端点 `:app_id/opens` 的点，还带部门维度）**分开声明**：
 * 两者不是同一个形状，共用一个 interface 会让跨端对拍无法断言"逐键一致"。
 */
export interface OpensTrendPoint {
  day?: string
  pv?: number
  uv?: number
}

/** `opens/summary` 的 `today`（今日 PV/UV，读**明细表**；§5.1c A）。 */
export interface OpensToday {
  day?: string
  pv?: number
  uv?: number
}

/** `opens/summary` 的 `totals`（窗口合计，**不带 `GROUP BY app_id`** 的一次聚合）。 */
export interface OpensTotals {
  pv?: number
  uv?: number
}

/**
 * 列表行的窗口/今日概览（服务端 `GROUP BY app_id` 下发）。
 *
 * ⚠️ 键名是 §5.1c A 的权威键：窗口列叫 `window_pv`/`window_uv`（不是 `pv`/`uv`），
 * 另有 `title`（来自应用登记表，查不到为空串）。
 */
export interface OpensAppRow {
  app_id: string
  title?: string
  today_pv?: number
  today_uv?: number
  window_pv?: number
  window_uv?: number
}

/** 看板 TOP N 的一行（§5.1c A：`{app_id,title,pv,uv}`）。 */
export interface OpensTopRow {
  app_id: string
  title?: string
  pv?: number
  uv?: number
}

export interface OpensSummary {
  from?: string
  to?: string
  days?: number
  top?: number
  /** 请求窗口被收敛到明细保留期时为 true（§5.1c A）—— 界面必须如实显示。 */
  capped?: boolean
  /** 明细保留期（服务端权威值；前端常量只是回落）。 */
  detail_retention_days?: number
  today?: OpensToday | null
  totals?: OpensTotals | null
  trend?: OpensTrendPoint[]
  apps?: OpensAppRow[]
  top_apps?: OpensTopRow[]
}

export interface OpensDetail {
  app_id?: string
  from?: string
  to?: string
  granularity?: 'day' | 'dept' | string
  points?: OpensPoint[]
  /**
   * 区间合计（**服务端已落地字段**：`serverstore.WasmOpenSeries` 的 `total_pv`/`total_uv`）。
   *
   * ⚠️ `total_uv` 的语义是"按 (日 × 部门) 去重后**加总**"，**不等于**区间去重人数：
   * 同一人跨天/跨部门会被重复计数（服务端源码里把这条写进了注释，因为区间级去重
   * 需要回明细表算，而明细只保留 90 天 ⇒ 长区间做不到）。界面必须照这个口径标注，
   * 不能写成"区间去重人数"。
   */
  total_pv?: number
  total_uv?: number
  /** 兼容字段：早期约定的 `pv`/`uv`（若服务端将来改回这组名字也能读）。 */
  pv?: number
  uv?: number
  detail_retention_days?: number
}

/**
 * AI 用量的一天 / 合计（服务端 `serverstore.WasmAppAIUsageDay`，**逐键对照** §5.1c B）。
 *
 * 注意键名：`requests`（不是 `calls`）、`prompt_tokens`/`completion_tokens`/
 * `cache_prompt_tokens`（没有 `total_tokens` —— 总数由前端把输入+输出相加，
 * 见 `aiUsageTokens`）。旧契约里的 `calls`/`tokens`/`points` 是**前端自己钉的字面量**，
 * 与真实响应不符 ⇒ 面板整块不出数（R2-L6-2）。
 */
export interface AiUsageDay {
  day?: string
  requests?: number
  prompt_tokens?: number
  completion_tokens?: number
  cache_prompt_tokens?: number
  cost?: number
}

/**
 * `GET …/:app_id/ai-usage` 的响应（§5.1c B：**契约以服务端 `WasmAppAIUsage` 为准**）。
 *
 * `attribution_available` **必须被消费**：`false` = 平台在该窗口内还没有任何带应用归因的
 * usage 行（"统计尚未上线"）；`true` 而本应用全零 = "确实没调过模型"。两者数字都是 0，
 * 含义相反（§21.4）—— 合并渲染就是在编数据。
 */
export interface AiUsage {
  app_id?: string
  from?: string
  to?: string
  days?: AiUsageDay[]
  total?: AiUsageDay | null
  attribution_available?: boolean
}

// ---------------------------------------------------------------------------
// 降级分类（缺后端 ≠ 0）
// ---------------------------------------------------------------------------

export type EndpointFailureKind = 'missing' | 'forbidden' | 'unauthorized' | 'drift' | 'other'

export interface EndpointFailure {
  kind: EndpointFailureKind
  /** 给管理员看的完整说明（含端点路径，便于让运维/L1 补齐）。 */
  text: string
}

/** 从错误对象上取 HTTP 状态（**鸭子类型**：不依赖具体 ApiError 类，测试替身也适用）。 */
function statusOf(err: unknown): number {
  const raw = (err as { status?: unknown } | null | undefined)?.status
  return typeof raw === 'number' ? raw : 0
}

/**
 * 把取数失败分类成可读说明。
 *
 * 关键语义（本泳道的硬要求）：**缺后端不得显示 0**。404 在管理面 = 该端点不存在
 * （路由未注册时 `NoRoute` 也是 404 JSON 信封），此时必须明说"服务端尚未提供"，
 * 页面显示「—」；否则管理员会把"读不到"当成"没人用过"，据此做出错误的运营判断。
 */
export function classifyEndpointFailure(err: unknown, what: string, path: string): EndpointFailure {
  const status = statusOf(err)
  if (status === 404) {
    return {
      kind: 'missing',
      text: `${what}接口尚不可用（HTTP 404 · ${path}）：服务端尚未提供该端点。`
        + '这里显示「—」而不是 0 —— 缺的是数据源，不是“没人用过”。',
    }
  }
  if (status === 403) {
    return {
      kind: 'forbidden',
      text: `${what}读取被拒（HTTP 403 · ${path}）：当前账号没有 capability:read 权限。`,
    }
  }
  if (status === 401) {
    return {
      kind: 'unauthorized',
      text: `${what}读取失败（HTTP 401 · ${path}）：登录状态已失效，请重新登录后重试。`,
    }
  }
  return { kind: 'other', text: `${what}读取失败（${path}）：${errorText(err, '请求失败')}` }
}

/** 形状漂移（服务端返回了 200，但结构不符合契约）—— 与"没有数据"必须分开。 */
export function shapeDrift(what: string, detail: string): EndpointFailure {
  return {
    kind: 'drift',
    text: `${what}响应结构不符合契约：${detail}。这不是“没有数据”，请核对服务端接口。`,
  }
}

// ---------------------------------------------------------------------------
// 形状守卫
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object'
}

/**
 * 校验跨应用聚合响应。
 *
 * `trend` / `apps` / `top_apps` 三个数组是**必填**（契约要求"空就空数组"）：
 * 缺任何一个都返回缺失键名，页面据此显示形状漂移提示而不是静默空列表。
 */
export function requireOpensSummary(raw: unknown): { ok: true; value: OpensSummary } | { ok: false; detail: string } {
  if (!isRecord(raw)) return { ok: false, detail: '响应不是对象' }
  const missing = (['trend', 'apps', 'top_apps'] as const).filter((k) => !Array.isArray((raw as Record<string, unknown>)[k]))
  if (missing.length > 0) return { ok: false, detail: `缺少数组字段 ${missing.join(' / ')}` }
  return { ok: true, value: raw as OpensSummary }
}

/** 校验应用详情响应：`points` 必须是数组（空数组 = 窗口内确实没有打开）。 */
export function requireOpensDetail(raw: unknown): { ok: true; value: OpensDetail } | { ok: false; detail: string } {
  if (!isRecord(raw)) return { ok: false, detail: '响应不是对象' }
  if (!Array.isArray((raw as Record<string, unknown>).points)) return { ok: false, detail: '缺少数组字段 points' }
  return { ok: true, value: raw as OpensDetail }
}

/** 校验 AI 用量响应：`points` 必须是数组（空数组 = 有归因能力但确实没有调用）。 */
/**
 * 校验 AI 用量响应：`days` 必须是数组（§5.1c B 的权威形状）。
 *
 * 空数组 = 有归因能力但确实没有调用；**缺 `days` = 形状漂移**（旧契约要的 `points`
 * 服务端从不下发 ⇒ 面板整块被这条判成漂移、永远不出数，R2-L6-2 的现场）。
 */
export function requireAiUsage(raw: unknown): { ok: true; value: AiUsage } | { ok: false; detail: string } {
  if (!isRecord(raw)) return { ok: false, detail: '响应不是对象' }
  if (!Array.isArray((raw as Record<string, unknown>).days)) return { ok: false, detail: '缺少数组字段 days' }
  return { ok: true, value: raw as AiUsage }
}

// ---------------------------------------------------------------------------
// 聚合口径（PV 不去重 / UV 不本地求和 / TOP N 排序）
// ---------------------------------------------------------------------------

/**
 * **只带 PV/UV** 的最小点形状：趋势点（`OpensTrendPoint`）与详情点（`OpensPoint`）
 * 都满足它。聚合函数（`sumOpenPv` / `windowUv` / `summarizeWindow`）按它取参，
 * 于是"两个读源（明细 / 日汇总）的点"共用同一份口径实现，不会各写一遍、也不会各错一遍。
 */
export interface PvUvPoint {
  pv?: number
  uv?: number
}

/**
 * **唯一**的"可能是数字"归一化入口：非数字 / 非有限 ⇒ `null`（**不是 0**）。
 *
 * 为什么必须有它（主控预审计 CTL-11）：本模块的规则是"读不到 ⇒ `—`"，
 * 但服务端 200 却少下发一个字段（形状漂移）时，`x ?? 0` / `Number(x ?? 0)`
 * 会把"读不到"渲染成 **0** —— 同一屏上 headline 显示 `—`、明细显示 0，
 * 两套缺失语义并存，且**掩盖契约漂移**（管理员看到 0 而不是告警）。
 * 页面里一律走本函数 + `countText` / `tokensText` / `fmtY`，不要再就地 `?? 0`。
 */
export function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * 窗口 PV：**不去重**（每次打开 +1）⇒ 逐日相加就是窗口内的总打开次数。
 *
 * 语义边界（与 `numOrNull` 同源）：**任意一天缺 `pv` 字段 ⇒ 整个结果为 null**
 * （显示 `—`），而不是把缺的那天当 0 悄悄少算。空数组是"窗口内确实没有打开"⇒ 0。
 *
 * 变异验证（两条）：
 *   ① 改成"按天去重/取最大值"（`points.length` 或 `max(pv)`）⇒ PV 用例红；
 *   ② 把缺字段的点当 0（`num()`）⇒ 漂移用例红。
 */
export function sumOpenPv(points: PvUvPoint[] | null | undefined): number | null {
  if (!Array.isArray(points)) return null
  let total = 0
  for (const p of points) {
    const pv = numOrNull(p?.pv)
    if (pv === null) return null
    total += pv
  }
  return total
}

/**
 * 窗口 UV：**只能**用服务端按窗口去重的值。
 *
 * 逐日 `uv` 是"当日去重人数"：把多天相加 = 同一个人被重复计数
 * （同一个人 3 天各打开一次会算成 3）。所以这里**拒绝本地求和**：
 * 服务端没给窗口 UV 就显示 `—` + 说明，而不是编一个数出来。
 *
 * 变异验证：改成 Σ `points.uv` ⇒ 对应用例必红（会给 3，而不是服务端值 2 / null）。
 */
export function windowUv(
  points: PvUvPoint[] | null | undefined,
  serverUv: number | null | undefined,
): { uv: number | null; note: string } {
  if (typeof serverUv === 'number' && Number.isFinite(serverUv)) return { uv: serverUv, note: '' }
  const hasPoints = Array.isArray(points) && points.length > 0
  return {
    uv: null,
    note: hasPoints
      ? '窗口 UV 需要服务端按窗口去重（逐日 UV 相加会把同一个人重复计数），服务端未下发时显示 —。'
      : '',
  }
}

export interface WindowSummary {
  /** 窗口内打开总数（PV 口径）；拿不到任何数据时为 null。 */
  pv: number | null
  /** 窗口内去重人数（**服务端**口径）；服务端未下发时为 null。 */
  uv: number | null
  /** uv 为 null 时的原因说明（为空串表示无需说明）。 */
  uvNote: string
}

/**
 * 应用详情（C3，`/wasm-apps/:app_id/opens`）的 UV 口径说明。
 *
 * 服务端返回的 `total_uv` 是**按 (日 × 部门) 去重后加总**，不是区间去重人数
 * （见 `serverstore.WasmOpenSeries` 的注释）。界面上必须按这个口径说，否则
 * 管理员会把它当成"这段时间有多少人用过"。
 */
export const OPENS_DETAIL_UV_SUM_NOTE =
  '区间/按日的 UV 是**按（日 × 部门）去重后加总**：同一人跨天或在同一天跨部门会被重复计数，'
  + '因此它不等于"区间去重人数"（区间级去重需回明细计算，而明细只保留 90 天）。'

/** 该窗口内每个自然日只有一行（单部门）⇒ 按日 UV 就是当日去重人数。 */
export const OPENS_DETAIL_UV_SINGLE_NOTE = '该窗口内每天只有一份部门数据：图中 UV 就是当日去重人数。'

export interface DaySeriesPoint {
  day: string
  /** 当日 PV（缺失 ⇒ null ⇒ 界面显示 `—` 并且**不画这个点**）。 */
  pv: number | null
  /** 当日 UV（缺失 ⇒ null；多部门日时它是"加总"而不是"当日去重人数"）。 */
  uv: number | null
  /** 该日出现的行数（= 部门数）；>1 时按日 UV 是"加总"而不是"当日去重人数"。 */
  rows: number
}

export interface DaySeries {
  points: DaySeriesPoint[]
  /**
   * 是否存在"一天多行（多部门）"的日子。
   *
   * 服务端 `granularity=day` 的 SQL 是 `GROUP BY day, dept_id` ⇒ 同一天可能有多行。
   * PV 可以跨部门相加（PV 不去重）；UV 相加会把同一人重复计数 ⇒ 界面据此切换文案。
   */
  multiDeptDays: boolean
  /** 有几天缺少 `pv`/`uv` 字段（形状漂移）—— 这些天**不参与计算也不画点**。 */
  missingDays: number
}

/**
 * 把服务端的 `granularity=day` 点聚合成**按自然日一行**的趋势。
 *
 * 缺失语义：某天的任意一行缺 `pv`（或 `uv`）⇒ 该天的对应字段为 `null`
 * （**不把缺的那行当 0**）；这样下游要么显示 `—`、要么跳过该点，绝不画出假 0。
 *
 * 变异验证：去掉按日合并（直接用原始行画线）⇒ 同一天会出现多个点，
 * `opens-contract.test.ts` 的"同日多部门合并"用例必红。
 */
export function daySeries(points: OpensPoint[] | null | undefined): DaySeries {
  if (!Array.isArray(points)) return { points: [], multiDeptDays: false, missingDays: 0 }
  interface Acc { day: string; pv: number | null; uv: number | null; rows: number; bad: boolean }
  const byDay = new Map<string, Acc>()
  for (const p of points) {
    const day = typeof p?.day === 'string' ? p.day : ''
    if (day === '') continue // dept 粒度行没有 day，混进来会被当成"空日期"
    const pv = numOrNull(p.pv)
    const uv = numOrNull(p.uv)
    const row = byDay.get(day) ?? { day, pv: 0, uv: 0, rows: 0, bad: false }
    // 一旦有任一行缺字段，这一天就整体判为"不可计算"（不是把缺的当 0）。
    if (pv === null || uv === null) row.bad = true
    row.pv = pv === null ? row.pv : (row.pv ?? 0) + pv
    row.uv = uv === null ? row.uv : (row.uv ?? 0) + uv
    row.rows += 1
    byDay.set(day, row)
  }
  const out: DaySeriesPoint[] = Array.from(byDay.values())
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
    .map((r) => ({ day: r.day, pv: r.bad ? null : r.pv, uv: r.bad ? null : r.uv, rows: r.rows }))
  return {
    points: out,
    multiDeptDays: out.some((p) => p.rows > 1),
    missingDays: out.filter((p) => p.pv === null || p.uv === null).length,
  }
}

/** 区间合计：**只取服务端下发的值**（前端不从按日点反推，避免与"加总口径"混淆）。 */
export function detailTotals(d: OpensDetail | null | undefined): { pv: number | null; uv: number | null } {
  const pv = d?.total_pv ?? d?.pv
  const uv = d?.total_uv ?? d?.uv
  return {
    pv: typeof pv === 'number' && Number.isFinite(pv) ? pv : null,
    uv: typeof uv === 'number' && Number.isFinite(uv) ? uv : null,
  }
}

/**
 * 服务端**实际生效**的窗口文本（§5.1c C：**必须渲染**）。
 *
 * 适用于两个都回显 `from`/`to` 的响应（详情 `OpensDetail` 与 AI 用量 `AiUsage`）。
 *
 * 为什么强制：服务端的 `from`/`to` 缺省是"近 7 天"，而这一回落**只体现在响应里**；
 * 前端不渲染它，管理员就无法察觉自己看的是 7 天而不是所选档位（R2-L6-3 的现场：
 * 「全部（长期日汇总）」曾经 `days:0` ⇒ 不传参 ⇒ 静默退化成 7 天）。
 * 缺 `from`/`to` 时如实说"无法确认区间"，**不猜**。
 */
export function effectiveWindowText(d: { from?: string; to?: string } | null | undefined): string {
  const from = typeof d?.from === 'string' && d.from !== '' ? d.from : null
  const to = typeof d?.to === 'string' && d.to !== '' ? d.to : null
  if (from === null || to === null) {
    return '生效窗口：—（服务端未回显 from/to，无法确认实际统计区间）'
  }
  return `生效窗口：${from} ~ ${to}`
}

/**
 * 列表列 / 详情概览的四个计数：**缺"行"与缺"字段"是两件事**（R2-L6-4）。
 *
 *   - 服务端聚合可用但**没有这个应用的行** ⇒ 该应用在窗口内确实没有打开记录
 *     （服务端 `GROUP BY app_id` 会省略零打开的应用）⇒ **按 0 计**并带说明；
 *   - 行在、但**字段缺失**（响应形状漂移）⇒ `null` ⇒ 显示 `—`，**不是 0**（CTL-11）。
 *
 * 旧实现把这行当 `—`，与"前端按 0 处理并带 title 说明"的声明冲突，而真实服务端
 * 一定会省略零打开的应用 ⇒ 整列大面积显示 `—`（真值是 0）。这里把两者分开。
 */
export const OPENS_MISSING_ROW_NOTE =
  '窗口内没有该应用的打开记录（服务端聚合只下发有记录的应用）—— 按 0 计；'
  + '与"字段缺失（形状漂移）显示 —"是两件事。'

export interface AppOpenCounts {
  todayPv: number | null
  todayUv: number | null
  windowPv: number | null
  windowUv: number | null
  /** true = 服务端没有下发该应用的行（按 0 计），false = 行在（字段仍可能缺失）。 */
  missingRow: boolean
}

export function appOpenCounts(orow: OpensAppRow | null | undefined): AppOpenCounts {
  if (orow === null || orow === undefined) {
    return { todayPv: 0, todayUv: 0, windowPv: 0, windowUv: 0, missingRow: true }
  }
  return {
    todayPv: numOrNull(orow.today_pv),
    todayUv: numOrNull(orow.today_uv),
    windowPv: numOrNull(orow.window_pv),
    windowUv: numOrNull(orow.window_uv),
    missingRow: false,
  }
}

/**
 * 看板/列表的窗口汇总。
 *
 * 优先级：服务端 `totals` > 本地按日累加（仅 PV 可累加）。
 * 这样即使服务端只给趋势数组，PV 依旧是"每次打开 +1"的真值，UV 则如实留空。
 */
export function summarizeWindow(input: {
  totals?: { pv?: number; uv?: number } | null
  trend?: PvUvPoint[] | null
}): WindowSummary {
  const trend = Array.isArray(input.trend) ? input.trend : null
  const serverPv = input.totals?.pv
  const pv =
    typeof serverPv === 'number' && Number.isFinite(serverPv)
      ? serverPv
      : trend === null
        ? null
        : sumOpenPv(trend)
  const { uv, note } = windowUv(trend, input.totals?.uv)
  return { pv, uv, uvNote: note }
}

export interface RankedApp {
  rank: number
  app_id: string
  title: string
  pv: number
  /** UV 缺失（形状漂移）⇒ null ⇒ 界面显示 `—`，而不是 0。 */
  uv: number | null
}

/**
 * 热门应用 TOP N：`pv` 降序 → `uv` 降序 → `app_id` 升序（稳定）。
 *
 * 服务端 SHOULD 已排好序，但**排序与截断由前端兜底**：看板上的名次是显示契约，
 * 不能让"服务端顺手换了个顺序"或"多返回了几行"就悄悄改变页面，
 * 也不能把 `top` 参数只当成服务端的君子协定。
 *
 * 缺失语义：**缺 `pv` 的行直接不进榜**（既不能排也不能显示 0）；缺 `uv` 的行
 * 照样进榜（PV 是主键），UV 显示 `—`。
 *
 * 变异验证：去掉 sort（或把 slice 去掉）⇒ `opens-contract.test.ts` 的排序/截断用例必红。
 */
export function rankTopApps(rows: OpensTopRow[] | null | undefined, limit: number): RankedApp[] {
  if (!Array.isArray(rows)) return []
  const clean: Omit<RankedApp, 'rank'>[] = []
  for (const r of rows) {
    if (r === null || typeof r !== 'object' || typeof r.app_id !== 'string' || r.app_id === '') continue
    const pv = numOrNull(r.pv)
    if (pv === null) continue // 缺 PV 无法排名（不是 0，是不知道）
    clean.push({
      app_id: r.app_id,
      title: typeof r.title === 'string' && r.title !== '' ? r.title : r.app_id,
      pv,
      uv: numOrNull(r.uv),
    })
  }
  clean.sort((a, b) => {
    if (b.pv !== a.pv) return b.pv - a.pv
    // uv 缺失排在有值的后面，但仍然是有效行。
    const au = a.uv ?? -1
    const bu = b.uv ?? -1
    if (bu !== au) return bu - au
    return a.app_id < b.app_id ? -1 : a.app_id > b.app_id ? 1 : 0
  })
  const n = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0
  return clean.slice(0, n).map((r, i) => ({ ...r, rank: i + 1 }))
}

/**
 * AI 用量面板的四种状态（§5.1c B 要求 `attribution_available` **必须被消费**）：
 *
 *   - `data`：有归因数据（任一计数 > 0，或有按日行）⇒ 渲染数字；
 *   - `zero_calls`：归因统计**可用**（`attribution_available=true`）而本应用全零
 *     ⇒ "确实零调用"；
 *   - `no_attribution`：归因统计**尚未上线**（`attribution_available=false`）
 *     ⇒ "统计尚未上线 / 无归因"，**不得**写成"0 次调用"；
 *   - `indeterminate`：响应缺字段（形状漂移）⇒ 既不能说"零调用"也不能渲染 0。
 *
 * 为什么不是一个布尔 `isEmpty`：旧实现只有一种"空"，于是"平台还没上线归因"与
 * "这个应用确实没调过模型"被渲染成同一句话 —— 两者数字都是 0、含义相反（§21.4）。
 *
 * 变异验证：把 `attribution_available` 的两条分支删掉（都走 `zero_calls`）⇒
 * `AppOpensAi.test.tsx` 的"未上线 ⇒ 不得说成零调用"用例必红。
 */
export type AiUsageView = 'data' | 'zero_calls' | 'no_attribution' | 'indeterminate'

export function aiUsageView(u: AiUsage | null | undefined): AiUsageView {
  if (u === null || u === undefined) return 'indeterminate'
  const days = Array.isArray(u.days) ? u.days : null
  const requests = numOrNull(u.total?.requests)
  const cost = numOrNull(u.total?.cost)
  const prompt = numOrNull(u.total?.prompt_tokens)
  const completion = numOrNull(u.total?.completion_tokens)
  // 判"确实零调用"必须四个分项都可读：任一项缺失都不能说"是 0"（CTL-11）。
  const readable = days !== null && requests !== null && cost !== null && prompt !== null && completion !== null
  const positive = (v: number | null): boolean => v !== null && v > 0
  if (positive(requests) || positive(cost) || positive(prompt) || positive(completion) || (days?.length ?? 0) > 0) {
    return 'data'
  }
  if (!readable) return 'indeterminate'
  if (u.attribution_available === false) return 'no_attribution'
  if (u.attribution_available === true) return 'zero_calls'
  return 'indeterminate'
}

/**
 * 总数 tokens = 输入 + 输出（服务端只下发分项：`prompt_tokens`/`completion_tokens`）。
 *
 * `cache_prompt_tokens` 是输入里**命中前缀缓存**的那部分（已含在 `prompt_tokens` 里），
 * 再加一次就把同一批 token 算两遍。任一分项缺失 ⇒ `null`（界面显示 `—`，不是 0）。
 */
export function aiUsageTokens(total: AiUsageDay | null | undefined): number | null {
  const p = numOrNull(total?.prompt_tokens)
  const c = numOrNull(total?.completion_tokens)
  if (p === null || c === null) return null
  return p + c
}

/** 计数展示：`null` / 非有限数 ⇒ `—`（**不是 0**）。 */
export function countText(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  return n.toLocaleString('zh-CN')
}

/**
 * token 展示：紧凑格式（K/M），缺失 ⇒ `—`。
 *
 * 与 `countText` 同源（都走 `numOrNull` 的缺失语义），只是格式不同 ——
 * 明细里不要再写 `fmtTokens(Number(x ?? 0))`（那就把"读不到"变成了 0）。
 */
export function tokensText(n: number | null | undefined): string {
  const v = numOrNull(n)
  if (v === null) return '—'
  if (v >= 1_000_000) return `${Number((v / 1_000_000).toFixed(1))}M`
  if (v >= 1000) return `${Number((v / 1000).toFixed(1))}K`
  return String(v)
}

export interface TrendDatum {
  label: string
  kind: string
  value: number
}

/**
 * 趋势点 → 折线图数据：**缺值不画点**（而不是补 0）。
 *
 * 图表上补 0 与表格里写 0 是同一类错误：线会掉到 0 看起来像"那天没人用"。
 * 跳过该点后线在该处断开（缺数据 = 不知道），并把跳过数量回报给调用方去显式提示。
 */
export function trendValues(
  rows: { label: string; pv: number | null; uv: number | null }[],
  uvSeriesName: string,
): { values: TrendDatum[]; skipped: number } {
  const values: TrendDatum[] = []
  let skipped = 0
  for (const r of rows) {
    if (r.pv === null) skipped += 1
    else values.push({ label: r.label, kind: 'PV（打开次数）', value: r.pv })
    if (r.uv === null) skipped += 1
    else values.push({ label: r.label, kind: uvSeriesName, value: r.uv })
  }
  return { values, skipped }
}
