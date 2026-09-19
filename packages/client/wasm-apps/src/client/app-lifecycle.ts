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
  /** 上架后服务端给出的入口链接（下架或无基域时为空串）。 */
  entryURL: string
}

/**
 * 解析上下架响应：`{app:{app_id,enabled,changed,entry_url?}}`。
 *
 * `app.enabled` **必须**是布尔值：它是行状态的唯一来源。缺席时按形状错误处理
 * —— 回落成"我请求的那个值"就是把乐观更新伪装成服务端结果（本函数的全部意义）。
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
    entryURL: asString(app.entry_url),
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
