/**
 * 版本历史（含**审核结论**）的客户端半边：应用中心面板 → 本机
 * `GET /api/pico/apps/wasm/:app_id/releases`（宿主代理到服务端员工面
 * `GET /api/client/v2/apps/wasm/:app_id/releases`）。
 *
 * 为什么必须有它（独立审计 R1-pm-3 / R1-uxw-4）：开启审核之后，发布者此前只有发布
 * 那一刻的一句"待审核（线上仍是旧版本）"，之后**永远**收不到任何结论 —— 服务端把
 * 被拒理由写进了 `app_releases.reason`，却没有任何读路径；而版本号一经提交就永久
 * 占位（被拒也不释放）。作者既不知道被拒、也拿不到理由，只能盲升版本号重发。
 *
 * 本模块只做三件事，全是纯逻辑（可单测、无 React）：
 *  1. 拼本机路由（app_id 一律 `encodeURIComponent`：它不是可信输入）；
 *  2. 发一次请求（**复用** `publish-app.ts` 的 {@link requestJSON}：错误信封的读法
 *     只有一份实现，不在这里抄第二遍）；
 *  3. 把响应解析成**结构化结果** —— 字段缺席/形状漂移一律按形状错误处理，绝不把
 *     "解析不出理由"显示成"没有理由"（那正是这条缺陷原本的形态）。
 *
 * 只读：本模块不发任何写请求（发布/上下架/删除在 `app-lifecycle.ts`）。
 *
 * @module @picoaide/dsh-wasm-apps/client/app-releases
 */

import { t } from './locales.ts'
import { lifecyclePath } from './app-lifecycle.ts'
import {
  requestJSON,
  type PublishFailure,
  type RequestDeps,
} from './publish-app.ts'

/** 本机路由后缀（与宿主 `wasm-apps.ts` 的只读代理白名单逐字一致）。 */
export const RELEASES_SUFFIX = 'releases'

/**
 * 版本历史的本机路由。
 * @param appId - 应用标识（服务端 `registry.NormalizeAppID` 的产物，仍按不可信输入编码）。
 * @returns 以 `/` 开头的本机路径。
 */
export function releasesPath(appId: string): string {
  return lifecyclePath(appId, RELEASES_SUFFIX)
}

/** 服务端的三种版本状态（`app_releases.status` 的 CHECK 约束）。 */
export const RELEASE_STATUSES = ['pending', 'approved', 'rejected'] as const

/** 版本状态取值。 */
export type ReleaseStatus = typeof RELEASE_STATUSES[number]

/**
 * 一条版本记录（服务端员工面 `GET …/:app_id/releases` 的一行）。
 *
 * `reason` 是**审核结论**：只有 `rejected` 行非空（approved 时服务端把 reason 清成
 * 空串、pending 行从未写过）。因此界面只在 rejected 行渲染它，而不是把空串当成
 * "没有被拒"的证据。
 */
export interface ReleaseRow {
  version: string
  /** 服务端原样下发的状态串（未知值不翻译、直接显示，避免把新状态说成已知状态）。 */
  status: string
  /** 被拒理由（≤200 字；非 rejected 行为空串）。 */
  reason: string
  /** 提交时间（服务端 RFC3339 原文；客户端不解析、不重排）。 */
  createdAt: string
  /** 是否线上正在跑的版本。 */
  current: boolean
  checksum: string
  size: number
}

/** 版本历史报告（成功）。 */
export interface MyReleasesReport {
  ok: true
  appId: string
  /** 当前生效版本（空串 = 还没有生效版本）。 */
  currentVersion: string
  /** 审核开关：解释"为什么这一版还没生效"。 */
  reviewRequired: boolean
  /** 按写入顺序（旧 → 新），服务端已排好序，客户端不重排。 */
  releases: ReleaseRow[]
}

/** 安全取对象。 */
function asRecord(value: unknown): Record<string, unknown> {
  return (value ?? {}) as Record<string, unknown>
}

/** 安全取字符串（非字符串给空串）。 */
function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * 形状对不上时的统一失败（绝不假装成功）。
 *
 * `message` 从**字典**取：这条消息会进 en 界面，写死中文就是新增一处 i18n 缺陷
 * （`app-lifecycle.ts` 的同类处理是既有口径）。
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

/**
 * 解析版本历史响应：`{app_id,current_version,review_required,releases:[{version,status,reason,created_at,current,checksum,size}]}`。
 *
 * 三条纪律：
 *  - `releases` **必须是数组**：缺席/类型不对 ⇒ 形状错误（回落成空清单就是把
 *    "我们解析坏了"说成"你没有版本"，与目录页的 P2-10 同族）；
 *  - `reason` **必须是字符串**（可以是空串 —— rejected 行确实可能没写理由）：键缺席/
 *    类型漂移 ⇒ 形状错误，绝不降级成空串（"管理员没有填写理由"是把解析失败说成事实）；
 *  - 服务端**下发了行**却一行都没解析出来（`version` 全空）⇒ 形状错误，同样不显示空态。
 * @param appId - 本次请求的 app_id（与回显比对，防串行）。
 * @param payload - 响应体。
 * @returns 结构化报告或失败。
 */
export function parseMyReleasesOutcome(appId: string, payload: unknown): MyReleasesReport | PublishFailure {
  const root = asRecord(payload)
  const echoed = asString(root.app_id)
  if (echoed !== '' && echoed !== appId) {
    return shapeMismatch(appId, payload, t('appCenter.releasesShapeMismatch'))
  }
  if (!Array.isArray(root.releases)) {
    return shapeMismatch(appId, payload, t('appCenter.releasesShapeMismatch'))
  }
  // `reason` 是**审核结论本身**：键缺席/非字符串 ⇒ 形状错误，绝不当成空串 ——
  // 空串在界面上会显示成"管理员没有填写理由"，那是把"我们没读到"说成服务端的事实
  // （模块头两条纪律里的第二条）。审计第二轮 A2-F6 实测：`releases`/`version` 受形状
  // 门约束，只有 `reason` 被 `asString()` 静默降级。
  const malformedReason = root.releases.some(row =>
    row !== null && typeof row === 'object' &&
    typeof (row as Record<string, unknown>).reason !== 'string')
  if (malformedReason) {
    return shapeMismatch(appId, payload, t('appCenter.releasesShapeMismatch'))
  }
  const rows = root.releases
    .filter((row): row is Record<string, unknown> => row !== null && typeof row === 'object')
    .map(row => ({
      version: asString(row.version),
      status: asString(row.status),
      reason: asString(row.reason),
      createdAt: asString(row.created_at),
      current: row.current === true,
      checksum: asString(row.checksum),
      size: typeof row.size === 'number' ? row.size : 0,
    }))
  const releases = rows.filter(row => row.version !== '')
  if (rows.length > 0 && releases.length === 0) {
    return shapeMismatch(appId, payload, t('appCenter.releasesShapeMismatch'))
  }
  return {
    ok: true,
    appId: echoed === '' ? appId : echoed,
    currentVersion: asString(root.current_version),
    reviewRequired: root.review_required === true,
    releases,
  }
}

/**
 * 读取一个应用的版本历史与审核结论（只读；服务端 `ownedApp` 对非发布者一律 404）。
 * @param appId - 应用标识。
 * @param deps - 可注入的 fetch / 取消信号（测试与 UI 共用同一条实现）。
 * @returns 结构化报告或失败（永不抛）。
 */
export async function fetchMyReleases(appId: string, deps: RequestDeps = {}): Promise<MyReleasesReport | PublishFailure> {
  const outcome = await requestJSON(releasesPath(appId), { method: 'GET' }, deps)
  if (!outcome.ok) return outcome
  return parseMyReleasesOutcome(appId, outcome.payload)
}
