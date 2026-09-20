/**
 * 作者**生命周期出口**的客户端半边（R1-pm-1）：应用中心面板 → 本机
 * `/api/pico/apps/wasm/:app_id/(publish|unpublish)` / `DELETE :app_id` /
 * `GET :app_id/diagnostics`。
 *
 * 为什么需要它：宿主早已把发布者的全套代理到本机面
 * （`packages/host/enterprise/src/wasm-apps.ts` 的 prefix handler：
 * `POST :app_id/publish|unpublish|freeze`、`GET :app_id/diagnostics|schema|export`、
 * `DELETE :app_id`），而客户端面板此前**只有"发布/发新版"** —— 作者发错内容既不能
 * 下架止损、也不能删除，排障只能靠猜；而作者指南明写"不要用 curl，工具是唯一走得通
 * 的路"，于是这些出口在产品里根本不可达（独立评审 R1-pm-1 / R1-uxc-10）。
 *
 * 本模块只做三件事，全是纯逻辑（可单测、无 React）：
 *  1. 拼本机路由（app_id 一律 `encodeURIComponent`：它不是可信输入）；
 *  2. 发一次请求（**复用** `publish-app.ts` 的 {@link requestJSON}：错误信封的读法
 *     只有一份实现，不在这里抄第二遍）；
 *  3. 把响应解析成**结构化结果** —— 特别是 `app.enabled` / `app.deleted`：
 *     行状态只能由**服务端返回的值**决定，不能拿"我请求的是下架"当成事实
 *     （服务端会幂等返回 `changed:false` 与它自己的当前值；乐观更新等于把
 *     "我点了下架"说成"它已经下架了"）。
 *
 * 只做**作者自服务**那一组：冻结/解冻、导出、自省、审批留给管理端与后续波次
 * （宿主路由有，但员工侧不该在没有产品决策的情况下暴露）。
 *
 * @module @picoaide/dsh-wasm-apps/client/app-lifecycle
 */

import { t } from './locales.ts'
import {
  requestJSON,
  type PublishFailure,
  type RequestDeps,
} from './publish-app.ts'

/** 本机写面里"上下架"的两个后缀（与宿主路由逐字一致）。 */
export const SET_PUBLISHED_SUFFIX = { online: 'publish', offline: 'unpublish' } as const

/** 本机路由前缀（与 `wasm-apps.ts` 的 `WASM_APPS_PREFIX` 同值；客户端不 import 宿主包）。 */
export const WASM_APPS_LOCAL_PREFIX = '/api/pico/apps/wasm'

/**
 * 一个 app_id 的本机路由（app_id 是路径段，必须 URI 编码）。
 * @param appId - 应用标识（服务端 `registry.NormalizeAppID` 的产物，仍按不可信输入编码）。
 * @param suffix - 可选的子路径（`` `publish` `` / `` `unpublish` `` / `` `diagnostics` ``）。
 * @returns 以 `/` 开头的本机路径。
 */
export function lifecyclePath(appId: string, suffix?: string): string {
  const base = `${WASM_APPS_LOCAL_PREFIX}/${encodeURIComponent(appId)}`
  return suffix === undefined ? base : `${base}/${suffix}`
}

/**
 * 上下架路由（同一 handler，后缀是**权威**判据：服务端 `publishTarget` 先看后缀再看
 * 请求体，见 `server/internal/wasmapp/api/release.go:90-115`）。
 * @param appId - 应用标识。
 * @param enabled - true = 上架（`publish`），false = 下架（`unpublish`）。
 * @returns 本机路径。
 */
export function setPublishedPath(appId: string, enabled: boolean): string {
  return lifecyclePath(appId, enabled ? SET_PUBLISHED_SUFFIX.online : SET_PUBLISHED_SUFFIX.offline)
}

/**
 * 删除路由（服务端软删：标识与版本号永久占位）。
 * @param appId - 应用标识。
 * @returns 本机路径。
 */
export function deletePath(appId: string): string {
  return lifecyclePath(appId)
}

/**
 * 诊断路由（只读）。
 * @param appId - 应用标识。
 * @returns 本机路径。
 */
export function diagnosticsPath(appId: string): string {
  return lifecyclePath(appId, 'diagnostics')
}

/**
 * 自省路由（只读；表结构 + 行数 + 占用）。
 *
 * 为什么客户端此前不消费自省（2026-09-22 起消费）：服务端从 2026-09-19 起就有
 * `GET …/schema`，但客户端只做了 4 个后缀，作者在产品里**看不到表结构** ——
 * 而"作者数据面"（`rows`）必须先知道有哪些表才能查。
 * @param appId - 应用标识。
 * @returns 本机路径。
 */
export function schemaPath(appId: string): string {
  return lifecyclePath(appId, 'schema')
}

/**
 * 数据浏览路由（只读；服务端 `api/rows.go`）。
 *
 * 参数一律进查询串（不是路径段）：`table` 可能为空/非法 ⇒ 服务端回 400，
 * 客户端不需要在本地复刻表名规则（复刻 = 第二份真源）。
 * @param appId - 应用标识。
 * @param query - 查询参数（table / limit / offset / unmask）。
 * @returns 本机路径（已 URI 编码）。
 */
export function rowsPath(appId: string, query: { table: string, limit?: number, offset?: number, unmask?: boolean }): string {
  const params = new URLSearchParams()
  params.set('table', query.table)
  if (query.limit !== undefined) params.set('limit', String(query.limit))
  if (query.offset !== undefined) params.set('offset', String(query.offset))
  if (query.unmask === true) params.set('unmask', '1')
  return `${lifecyclePath(appId, 'rows')}?${params.toString()}`
}

/**
 * 形状对不上时的统一失败（绝不假装成功：宁可报错也不要一个错的行状态）。
 *
 * `message` 由调用方从**字典**取（`locales.ts`）：这条消息会进 en 界面，
 * 写死中文就是新增一处 i18n 缺陷（发布块的同类问题是被记录的 R1-uxc-7，不扩散）。
 * @param appId - 本次请求的 app_id（进 details，便于维护者定位）。
 * @param payload - 服务端原始响应体（进 details）。
 * @param message - 已本地化的说明。
 * @returns 结构化失败。
 */
function shapeMismatch(appId: string, payload: unknown, message: string): PublishFailure {
  return {
    ok: false,
    status: 200,
    code: 'UNEXPECTED_RESPONSE',
    message,
    details: { app_id: appId, response: payload },
    hints: [t('appCenter.shapeMismatchHint')],
    transport: false,
  }
}

/** 安全取对象。 */
function asRecord(value: unknown): Record<string, unknown> {
  return (value ?? {}) as Record<string, unknown>
}

/** 安全取字符串（非字符串给空串）。 */
function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

// ---------------------------------------------------------------------------
// 上下架
// ---------------------------------------------------------------------------

/** 上下架的**服务端**结果（`server/internal/wasmapp/api/release.go:69-86`）。 */
export interface SetPublishedSuccess {
  ok: true
  appId: string
  /** **服务端返回的**当前状态（不是请求里的值）。 */
  enabled: boolean
  /** 服务端是否真的改了（状态本来就一致时 `false` —— 幂等，不写审计）。 */
  changed: boolean
}

/**
 * 解析上下架响应：`{app:{app_id,enabled,changed}}`。
 *
 * `app.enabled` **必须**是布尔值：它是行状态的唯一来源。缺席时按形状错误处理
 * —— 回落成"我请求的那个值"就是把乐观更新伪装成服务端结果（本函数的全部意义）。
 *
 * 2026-09-19：响应里**不再有** `entry_url`（冻结契约 §4.5：应用只在客户端内以
 * `picoaide-app://<app_id>/` 打开，服务端目录/发布/上下架响应一律不下发入口链接）。
 * 客户端也不再读它 —— 服务端多带一个字段时这里是**忽略**，不是回落。
 * @param appId - 本次请求的 app_id（与回显比对，防串行）。
 * @param payload - 响应体。
 * @returns 结构化结果或失败。
 */
export function parseSetPublishedOutcome(appId: string, payload: unknown): SetPublishedSuccess | PublishFailure {
  const app = asRecord(asRecord(payload).app)
  if (typeof app.enabled !== 'boolean') {
    return shapeMismatch(appId, payload, t('appCenter.setPublishedShapeMismatch'))
  }
  const echoed = asString(app.app_id)
  if (echoed !== '' && echoed !== appId) {
    return shapeMismatch(appId, payload, t('appCenter.setPublishedShapeMismatch'))
  }
  return {
    ok: true,
    appId,
    enabled: app.enabled,
    changed: app.changed === true,
  }
}

/**
 * 上架 / 下架一个应用（发布者本人；服务端 `ownedApp` 对非发布者一律 404）。
 * @param appId - 应用标识。
 * @param enabled - true = 上架，false = 下架。
 * @param deps - 可注入的 fetch / 取消信号（测试与 UI 共用同一条实现）。
 * @returns 服务端结果或结构化失败（永不抛）。
 */
export async function setAppPublished(
  appId: string,
  enabled: boolean,
  deps: RequestDeps = {},
): Promise<SetPublishedSuccess | PublishFailure> {
  // 不带 body：服务端以**路径后缀**判定目标（release.go:90-115），body 只在挂载点
  // 不含后缀时才是判据 —— 发一个 `{enabled}` 反而会造出第二条判据。
  const outcome = await requestJSON(setPublishedPath(appId, enabled), { method: 'POST' }, deps)
  if (!outcome.ok) return outcome
  return parseSetPublishedOutcome(appId, outcome.payload)
}

// ---------------------------------------------------------------------------
// 删除（软删）
// ---------------------------------------------------------------------------

/** 删除的**服务端**结果（`server/internal/wasmapp/api/release.go:189-227`）。 */
export interface DeleteSuccess {
  ok: true
  appId: string
  /** 服务端确认已删除（恒为 true；缺席即形状错误）。 */
  deleted: boolean
  /** 数据保留期（天）；服务端没给就是 `undefined`（**不编造** 90）。 */
  retentionDays: number | undefined
  /** 服务端给运维/用户看的说明（含"真删由后台任务执行"这类边界）。 */
  note: string
}

/**
 * 解析删除响应：`{app:{app_id,deleted,...},retention_days?,note?}`。
 *
 * 行只在 `app.deleted === true` 时才允许消失 —— 这是"确认后行消失"那条行为用例的
 * 判据，也是防"点了删除就先抹掉行"的唯一手段。
 * @param appId - 本次请求的 app_id。
 * @param payload - 响应体。
 * @returns 结构化结果或失败。
 */
export function parseDeleteOutcome(appId: string, payload: unknown): DeleteSuccess | PublishFailure {
  const root = asRecord(payload)
  const app = asRecord(root.app)
  if (app.deleted !== true) {
    return shapeMismatch(appId, payload, t('appCenter.deleteShapeMismatch'))
  }
  const echoed = asString(app.app_id)
  if (echoed !== '' && echoed !== appId) {
    return shapeMismatch(appId, payload, t('appCenter.deleteShapeMismatch'))
  }
  return {
    ok: true,
    appId,
    deleted: true,
    retentionDays: typeof root.retention_days === 'number' ? root.retention_days : undefined,
    note: asString(root.note),
  }
}

/**
 * 删除一个应用（软删；不可恢复，标识与版本号永久占位）。
 *
 * **危险动作，调用方必须先二次确认**（面板的确认块就是那个闸）。
 * @param appId - 应用标识。
 * @param deps - 可注入的 fetch / 取消信号。
 * @returns 服务端结果或结构化失败（永不抛）。
 */
export async function deleteApp(appId: string, deps: RequestDeps = {}): Promise<DeleteSuccess | PublishFailure> {
  const outcome = await requestJSON(deletePath(appId), { method: 'DELETE' }, deps)
  if (!outcome.ok) return outcome
  return parseDeleteOutcome(appId, outcome.payload)
}

// ---------------------------------------------------------------------------
// 诊断（只读）
// ---------------------------------------------------------------------------

/** 一条失败记录（服务端 `diag.Failure`；只取面板要显示的字段）。 */
export interface DiagnosticsFailureRow {
  /** 稳定失败码（`reason_code`）—— 排障的第一判据。 */
  reasonCode: string
  /** `error` / `killed` 等。 */
  outcome: string
  /** 发生时间（服务端 RFC3339 原文）。 */
  createdAt: string
  /** guest 退出码（被杀/陷入时非零）。 */
  guestExitCode: number
}

/** 诊断报告（服务端 `api/read.go` 的 `diagnosticsPayload`）。 */
export interface DiagnosticsReport {
  ok: true
  appId: string
  /** 应用当时的上下架状态（服务端回显，不是目录行的缓存）。 */
  enabled: boolean
  frozen: boolean
  deleted: boolean
  /** 时间窗口（分钟）。 */
  windowMinutes: number
  /** 窗口内调用总数与失败数。 */
  total: number
  failed: number
  /** 最近失败（可能为空）。 */
  failures: DiagnosticsFailureRow[]
  /** 可操作建议（服务端按失败码给出 + 逐条 failure 的建议，已去重）。 */
  hints: string[]
}

/**
 * 解析诊断响应：`{diagnostics:{app_id,app_enabled,...,summary:{total,failed},failures[],hints[]}}`。
 *
 * 字段缺席一律回落成"空/0"而不是编造：诊断页显示"0 失败"是**服务端说的**，
 * 不能是客户端自己推的（评审 R1-pm-16 的教训：诊断口径必须与服务端一致）。
 * @param appId - 本次请求的 app_id。
 * @param payload - 响应体。
 * @returns 结构化报告或失败。
 */
export function parseDiagnosticsOutcome(appId: string, payload: unknown): DiagnosticsReport | PublishFailure {
  const body = asRecord(asRecord(payload).diagnostics)
  if (asString(body.app_id) === '') {
    return shapeMismatch(appId, payload, t('appCenter.diagnosticsShapeMismatch'))
  }
  const summary = asRecord(body.summary)
  const rawFailures = Array.isArray(body.failures) ? body.failures : []
  return {
    ok: true,
    appId,
    enabled: body.app_enabled === true,
    frozen: body.app_frozen === true,
    deleted: body.app_deleted === true,
    windowMinutes: typeof body.window_minutes === 'number' ? body.window_minutes : 0,
    total: typeof summary.total === 'number' ? summary.total : 0,
    failed: typeof summary.failed === 'number' ? summary.failed : 0,
    failures: rawFailures
      .filter((row): row is Record<string, unknown> => row !== null && typeof row === 'object')
      .map(row => ({
        reasonCode: asString(row.reason_code),
        outcome: asString(row.outcome),
        createdAt: asString(row.created_at),
        guestExitCode: typeof row.guest_exit_code === 'number' ? row.guest_exit_code : 0,
      })),
    hints: Array.isArray(body.hints)
      ? body.hints.filter((hint): hint is string => typeof hint === 'string' && hint !== '')
      : [],
  }
}

/**
 * 读取一个应用的最近失败诊断（只读；发布者本人或管理员）。
 * @param appId - 应用标识。
 * @param deps - 可注入的 fetch / 取消信号。
 * @returns 结构化报告或失败（永不抛）。
 */
export async function fetchDiagnostics(appId: string, deps: RequestDeps = {}): Promise<DiagnosticsReport | PublishFailure> {
  const outcome = await requestJSON(diagnosticsPath(appId), { method: 'GET' }, deps)
  if (!outcome.ok) return outcome
  return parseDiagnosticsOutcome(appId, outcome.payload)
}

// ---------------------------------------------------------------------------
// 作者数据面：自省（schema）+ 行浏览（rows）
// ---------------------------------------------------------------------------
//
// 契约真源：`server/internal/wasmapp/api/read.go`（schema）与 `api/rows.go`（rows）。
// 两个解析器都遵循同一条纪律：**形状对不上就报错，不回落成空表** ——
// 把 404 页面解析成"0 行数据"会让作者以为"数据没写进去"，方向完全错。

/** 自省里的一张表。 */
export interface AppSchemaTable {
  /** 表名（`db.define` 用的那个；平台规则：小写字母开头、[a-z0-9_]）。 */
  name: string
  /** 行数（服务端 `SELECT COUNT(*)`）。 */
  rows: number
  /** 列（含平台自动追加的 `_row_id`，与 `db.define` 的视角一致）。 */
  columns: Array<{ name: string, type: string, pk: boolean }>
  /** 表名不符合平台规则（不是 `db.define` 建的）时置位，此时 columns 为空。 */
  skipped: boolean
  /** skipped 的原因（服务端原文）。 */
  skipReason: string
}

/** 自省报告（服务端 `inspectAppDB`）。 */
export interface AppSchemaReport {
  ok: true
  appId: string
  /** 数据根之下的逻辑路径（不暴露宿主目录布局）。 */
  db: string
  sizeBytes: number
  maxBytes: number
  tableCount: number
  usagePercent: number
  tables: AppSchemaTable[]
}

/**
 * 解析自省响应（`{schema:{app_id,...,tables:[...]}}`）。
 * @param appId - 本次请求的 app_id。
 * @param payload - 响应体。
 * @returns 结构化报告或失败。
 */
export function parseSchemaOutcome(appId: string, payload: unknown): AppSchemaReport | PublishFailure {
  const body = asRecord(asRecord(payload).schema)
  if (asString(body.app_id) === '') {
    return shapeMismatch(appId, payload, t('appCenter.schemaShapeMismatch'))
  }
  const rawTables = Array.isArray(body.tables) ? body.tables : []
  return {
    ok: true,
    appId,
    db: asString(body.db),
    sizeBytes: typeof body.size_bytes === 'number' ? body.size_bytes : 0,
    maxBytes: typeof body.max_bytes === 'number' ? body.max_bytes : 0,
    tableCount: typeof body.table_count === 'number' ? body.table_count : rawTables.length,
    usagePercent: typeof body.usage_percent === 'number' ? body.usage_percent : 0,
    tables: rawTables
      .filter((row): row is Record<string, unknown> => row !== null && typeof row === 'object')
      .map(row => ({
        name: asString(row.name),
        rows: typeof row.rows === 'number' ? row.rows : 0,
        columns: (Array.isArray(row.columns) ? row.columns : [])
          .filter((col): col is Record<string, unknown> => col !== null && typeof col === 'object')
          .map(col => ({
            name: asString(col.name),
            type: asString(col.type),
            pk: col.pk === true,
          })),
        skipped: row.skipped === true,
        skipReason: asString(row.skip_reason),
      })),
  }
}

/** 数据浏览的一列。 */
export interface AppRowsColumn {
  name: string
  type: string
  /** 服务端按列名启发式判定为敏感（默认脱敏；显式 unmask 才给原值）。 */
  sensitive: boolean
}

/** 数据浏览报告（服务端 `rowsPayload`）。 */
export interface AppRowsReport {
  ok: true
  appId: string
  table: string
  columns: AppRowsColumn[]
  /** 行值：字符串/数字/布尔/null（服务端已把 BLOB 归一成字符串）。 */
  rows: Array<Array<string | number | boolean | null>>
  limit: number
  offset: number
  returned: number
  totalRows: number
  hasMore: boolean
  /** 服务端返回上限（行数/字节）被命中 —— 与 hasMore 是两件事。 */
  truncated: boolean
  /** 被按字节截断的值个数。 */
  truncatedValues: number
  unmasked: boolean
  maskedColumns: string[]
  valueMaxBytes: number
}

/**
 * 解析数据浏览响应（`{rows:{app_id,table,columns,rows,...}}`）。
 * @param appId - 本次请求的 app_id。
 * @param payload - 响应体。
 * @returns 结构化报告或失败。
 */
export function parseRowsOutcome(appId: string, payload: unknown): AppRowsReport | PublishFailure {
  const body = asRecord(asRecord(payload).rows)
  if (asString(body.app_id) === '' || asString(body.table) === '') {
    return shapeMismatch(appId, payload, t('appCenter.rowsShapeMismatch'))
  }
  const rawCols = Array.isArray(body.columns) ? body.columns : []
  const rawRows = Array.isArray(body.rows) ? body.rows : []
  return {
    ok: true,
    appId,
    table: asString(body.table),
    columns: rawCols
      .filter((col): col is Record<string, unknown> => col !== null && typeof col === 'object')
      .map(col => ({
        name: asString(col.name),
        type: asString(col.type),
        sensitive: col.sensitive === true,
      })),
    rows: rawRows
      .filter((row): row is unknown[] => Array.isArray(row))
      .map(row => row.map(v => (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : String(v)))),
    limit: typeof body.limit === 'number' ? body.limit : 0,
    offset: typeof body.offset === 'number' ? body.offset : 0,
    returned: typeof body.returned === 'number' ? body.returned : rawRows.length,
    totalRows: typeof body.total_rows === 'number' ? body.total_rows : 0,
    hasMore: body.has_more === true,
    truncated: body.truncated === true,
    truncatedValues: typeof body.truncated_values === 'number' ? body.truncated_values : 0,
    unmasked: body.unmasked === true,
    maskedColumns: Array.isArray(body.masked_columns)
      ? body.masked_columns.filter((c): c is string => typeof c === 'string')
      : [],
    valueMaxBytes: typeof body.value_max_bytes === 'number' ? body.value_max_bytes : 0,
  }
}

/**
 * 读取一个应用的表结构（只读；发布者本人）。
 * @param appId - 应用标识。
 * @param deps - 可注入的 fetch / 取消信号。
 * @returns 结构化报告或失败（永不抛）。
 */
export async function fetchSchema(appId: string, deps: RequestDeps = {}): Promise<AppSchemaReport | PublishFailure> {
  const outcome = await requestJSON(schemaPath(appId), { method: 'GET' }, deps)
  if (!outcome.ok) return outcome
  return parseSchemaOutcome(appId, outcome.payload)
}

/**
 * 读取一个应用某张表的行（只读；发布者本人；默认脱敏）。
 * @param appId - 应用标识。
 * @param query - table / limit / offset / unmask。
 * @param deps - 可注入的 fetch / 取消信号。
 * @returns 结构化报告或失败（永不抛）。
 */
export async function fetchRows(
  appId: string,
  query: { table: string, limit?: number, offset?: number, unmask?: boolean },
  deps: RequestDeps = {},
): Promise<AppRowsReport | PublishFailure> {
  const outcome = await requestJSON(rowsPath(appId, query), { method: 'GET' }, deps)
  if (!outcome.ok) return outcome
  return parseRowsOutcome(appId, outcome.payload)
}
