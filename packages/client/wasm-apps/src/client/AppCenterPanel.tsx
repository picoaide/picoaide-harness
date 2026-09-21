import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Card,
  Chip,
  IconTile,
  PANEL_GRID,
  PANEL_SEARCH,
  PANEL_TOOLBAR,
  PanelButton,
  PanelPage,
  icons,
  type PanelTone,
} from '@picoaide/dsh-panel-surface/client'
import { PublishErrorBlock, PublishForm } from './PublishForm.tsx'
import {
  openAppEntry,
  type AppOpenCounts,
  type OpenFailure,
  type OpenFailureReason,
  type OpenWindowOutcome,
} from './open-app.ts'
import { DEFAULT_ACCESS, parseWindowSpec, type AccessMode, type AppWindowSpec } from './appcfg-contract.ts'
import { formatWindowRatio, parseErrorEnvelope, type PublishFailure, type PublishTarget, type RequestDeps } from './publish-app.ts'
import {
  deleteApp,
  fetchDiagnostics,
  setAppPublished,
  type DeleteSuccess,
  type DiagnosticsReport,
  type SetPublishedSuccess,
} from './app-lifecycle.ts'
import {
  RELEASE_STATUSES,
  fetchMyReleases,
  type MyReleasesReport,
  type ReleaseStatus,
} from './app-releases.ts'
import { AppAiPanel } from './AppAiPanel.tsx'
import { DataBrowserPanel } from './DataBrowserPanel.tsx'
import {
  appChannel,
  loadAppChannel,
  setAppChannel,
  type AppChannel,
  type AppChannelFailure,
  type AppChannelResult,
} from './channel-seam.ts'
import { ensureHostProof } from './host-proof.ts'
import { loadAppAiIdentity, type AppAiConsentStore, type AppAiDeps } from './app-ai.ts'
import { appShareLink } from './deep-link.ts'
import {
  CATALOG_PAGE_SIZE,
  EMPTY_FILTER,
  catalogEmptyState,
  filterCatalog,
  paginateCatalog,
  type CatalogFilter,
} from './catalog-filter.ts'
import { dismissOnboarding, isOnboardingDismissed, type OnboardingStore } from './onboarding.ts'
import { OPEN_INTENT_TTL_MS, clearOpenIntent, readOpenIntent, saveOpenIntent, type OpenIntentStore } from './open-intent.ts'
import { t, tCount, type AppCenterKey } from './locales.ts'

/**
 * 应用中心（App Center，R34）——「同事做的小工具」的目录。
 *
 * 四条产品约定（都来自设计基线，不是自由发挥）：
 *
 *  - **目录一律展示全部应用**（2026-09-18 拍板）。**不再按可见性过滤**：`visible` 字段
 *    已从契约里删除，"登录后使用 / 仅白名单"只决定**谁能用**，不决定**谁能看见**
 *    （白名单应用也列出来，点开由应用自己判并返回它的 403 页）。服务端
 *    `GET /api/client/v2/apps/wasm/catalog` 给什么就渲染什么，客户端不新增第二条筛选规则
 *    —— 两份规则迟早给出不同答案，而"为什么这个应用看不到"会变成无法回答的问题。
 *  - **标出访问级别**：用服务端下发的 `access`（2026-09-19 起写侧只有
 *    `login | whitelist`，历史 `public` 读作 `login`，见 {@link resolveAccess}），
 *    让"点开会被拦吗"在点击之前就有答案。
 *  - **下架的条目也要展示**（`enabled=false` 显示"已下架"并禁用打开）：下架不等于不存在，
 *    直接从目录里消失会让用户以为是自己看错了。
 *  - **R36：不显示额度/用量**。额度唯一的入口是桌面客户端本来的账号卡；这一页只有
 *    名称 / 一句话说明 / 负责人 / 访问级别 / 当前版本。**不做安装语义**：应用点开即用
 *    （没有"装到本地"这一步），但它**只在客户端内**打开 —— 打开走本机路由
 *    `POST /api/pico/wasm-apps/open`，由宿主确保协议 handler 与分区就绪后让内置浏览器
 *    加载 `<本安装的 app scheme>://<app_id>/`（冻结契约 2026-09-19 §4.5）。这一页没有入口链接、
 *    也没有系统浏览器兜底：应用不存在"可以贴进浏览器的地址"。
 *
 * 发布者本人（`is_owner`）额外拿到**作者自服务**那一组（R1-pm-1）：发新版、下架/上架、
 * 删除、诊断。三个判据：
 *
 *  - 每个动作都打**本机**路由（`/api/pico/apps/wasm/*`，宿主代理到服务端），由页面
 *    上下文发起 —— 页面天然持有 `dsh-auth-*` 持有性证明，不需要任何新信任机制；
 *  - **行状态只由服务端返回的值更新**（`app.enabled` / `app.deleted`）：请求成功不等于
 *    状态变了（服务端会幂等返回 `changed:false`），乐观更新会把"我点了下架"说成
 *    "它已下架"（`app-lifecycle.ts`）；
 *  - 危险动作（下架、删除）**必须二次确认**，且失败时把服务端信封的
 *    `code`/`message`/`details`/`hints` 渲染出来（与发布失败块同一形状）。
 *
 * 冻结/解冻、导出、自省**不在这里**：宿主有路由，但那是管理动作，员工侧要不要暴露是
 * 产品决策（独立评审 R1-pm-1 的边界即"只做作者自服务那一组"）。
 *
 * @module @picoaide/dsh-wasm-apps/client/AppCenterPanel
 */

/** 目录条目（服务端 `catalog` 的字段子集；未知字段一律忽略）。 */
export interface AppCenterItem {
  appId: string
  title: string
  description: string
  responsible: string
  /** 访问级别（服务端 `access`）：决定"点开会不会被应用拦下"。 */
  access: AccessMode
  /** 是否上架（服务端 `enabled`）；`false` = 已下架，仍然展示但禁用打开。 */
  enabled: boolean
  /**
   * 当前线上版本（服务端 `current_version`；空串 = 服务端没有版本行）。
   *
   * 为什么这一页必须有它（P1-4）：`wasm_app_list` 的工具描述要求模型"先查当前版本，
   * 新版本号必须严格大于它"，而目录行原先**没有版本字段** ⇒ 模型只能猜；
   * 猜错的代价是一次完整上传（≤32 MiB）+ 审计拒绝 + 消耗上传额度。
   * 同一份目录也是面板的"当前版本"来源，两处同源。
   */
  currentVersion: string
  /**
   * 调用者是不是这个应用的发布者（服务端 `is_owner`）。
   *
   * 用途：①只有发布者能发新版（服务端 `ownedApp` 对非发布者一律 404），
   * UI 据此给出/隐藏"发新版"入口；②`purpose` / `whitelist` **只对发布者下发**
   * （账号名单不外泄，见 `appcfg-contract.ts` 的 `CATALOG_ROW_AUTHOR_FIELDS`）。
   */
  isOwner: boolean
  /** 用途声明（**仅发布者本人**的目录行有；发新版时预填，见 P1-3）。 */
  purpose?: string
  /** 准入名单（**仅发布者本人**的目录行有；发新版时预填）。 */
  whitelist?: string[]
  /**
   * 作者声明的窗口规格（F3/§6：`window.ratio/width/height`）。
   *
   * 缺席 = 服务端没下发（或字段还没落地）⇒ 详情页不显示、也**不声称锁了比例**。
   */
  window?: AppWindowSpec
}

/**
 * 解析一条目录行的访问级别。
 *
 * 2026-09-19（冻结契约 §4.4）：匿名面已删除 ⇒ 本函数**永不返回** `public`：
 *
 *  - 服务端下发历史值 `public`（存量行、老服务端）⇒ 按 `login` 渲染（读侧当作登录后使用，
 *    与服务端的读取侧收敛一致）；
 *  - 服务端下发未知取值（例如将来新增的模式）⇒ 同样回落 `login`（缺省模式，不放大权限）；
 *  - `access` 缺失时按旧字段 `login_required` / `whitelist` 过渡兼容读取 —— 注意
 *    `login_required: false`（旧的"匿名可用"）现在也读作 `login`：那条语义已经不存在，
 *    渲染成"公开"会让用户以为可以不登录打开。
 *
 * 这条过渡分支**只在 `access` 缺席时生效**（服务端一旦返回 `access` 它就永远不会被走到）。
 * @param row - 服务端目录行。
 * @returns `login` 或 `whitelist`；任何不确定的输入都回落 `login`（最保守的缺省）。
 */
export function resolveAccess(row: Record<string, unknown>): AccessMode {
  const raw = row.access
  if (typeof raw === 'string') {
    // 历史 `public`：读作 login（服务端读取侧同一口径，§4.4）。
    if (raw === 'login' || raw === 'whitelist') return raw
    // **给了但不认识**（不是缺失）⇒ 按缺省模式处理，绝不落到下面的旧字段分支：
    // 那一条会把"服务端下发了一个我们还不认识的新模式"翻译成别的语义
    // （独立审计 2026-09-18 在 DOM 上复现过 `access: 'org'` + `login_required: false`
    // 渲染成「公开」）；不认识的值一律按最保守的缺省显示。
    return DEFAULT_ACCESS
  }
  // ---- 以下是过渡兼容分支（**只在 access 缺失时**生效，见函数注释）：access 就绪后删除 ----
  if (Array.isArray(row.whitelist) && row.whitelist.length > 0) return 'whitelist'
  return DEFAULT_ACCESS
}

/** 访问级别徽标的字典键。 */
const ACCESS_BADGE_KEYS: Record<AccessMode, AppCenterKey> = {
  login: 'appCenter.accessBadge.login',
  whitelist: 'appCenter.accessBadge.whitelist',
}

/**
 * 访问级别的展示文案（短标签，目录行里用）。
 * @param access - 访问级别。
 * @returns 当前语言下的短标签。
 */
export function accessBadge(access: AccessMode): string {
  return t(ACCESS_BADGE_KEYS[access])
}

/** 版本状态的字典键（R1-pm-3 的版本历史用）。 */
const RELEASE_STATUS_KEYS: Record<ReleaseStatus, AppCenterKey> = {
  pending: 'appCenter.releaseStatus.pending',
  approved: 'appCenter.releaseStatus.approved',
  rejected: 'appCenter.releaseStatus.rejected',
}

/**
 * 版本状态的展示文案。
 *
 * **未知状态原样显示**（不翻译、也不回落成"已生效"）：服务端将来新增一个状态
 * （例如 superseded）时，把它显示成一个已知状态就是谎报 —— 与 `resolveAccess`
 * 对未知 `access` 的处理同向（不认识的值绝不放大权限，也不假装认识）。
 * @param status - 服务端下发的状态串。
 * @returns 当前语言下的标签，或状态原文。
 */
export function releaseStatusLabel(status: string): string {
  return (RELEASE_STATUSES as readonly string[]).includes(status)
    ? t(RELEASE_STATUS_KEYS[status as ReleaseStatus])
    : status
}

/** 面板状态机。 */
export type AppCenterState =
  /** 正在取目录。 */
  | { kind: 'loading' }
  /**
   * 未登录（宿主路由 401 `AUTH_REQUIRED`）。
   *
   * 它是**一个独立的空态**（§19 Q4/Q2），不是错误：未登录时目录一个应用都不会有，
   * 而"还没有可用的应用"会把"你还没登录"说成"平台里没有应用"。登录闸门本身在宿主
   * （§16.1：客户端半边不持 bearer），客户端只负责把状态说清楚并给一个"登录后重试"。
   */
  | { kind: 'signed-out' }
  | { kind: 'error', error: AppCenterError }
  | { kind: 'ready', items: AppCenterItem[] }

/**
 * 错误态的可执行信息（P1-5）。
 *
 * 宿主与服务端给的都是 `{error:{code,message,details,hints}}` 信封，而面板原先
 * 在非 2xx 时**丢掉响应体**、只拼一句 `加载失败 (HTTP 502)` —— 于是"服务端到底说了
 * 什么、该怎么修"全部消失。这里逐字段带上，渲染成与发布失败块同一形状。
 */
export interface AppCenterError {
  /** 人可读的主要文案（401 时换成"登录后可以查看应用中心"）。 */
  message: string
  /** 稳定错误码（服务端信封的 `code`，缺失时回落 `HTTP_<status>` / `NETWORK_ERROR`）。 */
  code: string
  /** 可执行建议（信封的 `hints` 原样）。 */
  hints: string[]
  /** 诊断原文（目录形状对不上时是服务端下发的原始行样本）。 */
  details?: string
}

/** 目录条目的生命周期动作的结果类型（宿主/服务端返回，见 `app-lifecycle.ts`）。 */
export type SetPublishedOutcome = SetPublishedSuccess | PublishFailure
/** {@link SetPublishedOutcome} 的删除版本。 */
export type DeleteOutcome = DeleteSuccess | PublishFailure
/** {@link SetPublishedOutcome} 的诊断版本。 */
export type DiagnosticsOutcome = DiagnosticsReport | PublishFailure
/** {@link SetPublishedOutcome} 的版本历史版本（R1-pm-3：审核结论的作者侧出口）。 */
export type ReleasesOutcome = MyReleasesReport | PublishFailure

/**
 * 删除成功后目录顶部的通知。
 *
 * 为什么把服务端的 `note` / `retention_days` **原样**带上来：R37 的"真删由后台任务
 * 执行（当前未实现）"这条边界只写在服务端文案里，客户端自己写一句"数据会在 90 天后
 * 删除"就等于替服务端做出了它没有做出的承诺（管理端已踩过这个坑）。
 */
export interface CatalogNotice {
  kind: 'deleted'
  appId: string
  /** 服务端返回的说明（可能为空串）。 */
  note: string
  /** 服务端返回的保留天数；没有就是 undefined（不编造）。 */
  retentionDays: number | undefined
}

/** {@link parseCatalogReport} 的结果：条目 + 行数统计（P2-10 的诊断用）。 */
export interface CatalogReport {
  /** 归一化后的条目。 */
  items: AppCenterItem[]
  /** 服务端下发的行数；`apps` 不是数组时为 0。 */
  rows: number
  /** 因为没有合法 `app_id` 而被跳过的行数。 */
  skipped: number
  /** 被跳过行的**原文**样本（截断；面板据此报"下发的到底是什么形状"）。 */
  sample: string
}

/** 诊断样本的字节上限（够看清字段名，不至于把整页日志灌满）。 */
const CATALOG_SAMPLE_MAX = 400

/**
 * "未登录时记住这次打开"的登录态轮询间隔（5s）。
 *
 * 与 `auth-gate.ts` 的会话 tripwire 同节奏：那条负责"登出就跳登录页"，这条负责
 * "登录完成就继续打开"。轮询只在**有 pending 意图**时存在（不是常驻定时器）。
 */
const LOGIN_POLL_MS = 5000

/**
 * 解析目录载荷并**统计跳过的行**（纯函数，便于单测）。
 *
 * 字段名与 server 的 `catalog` 行一一对应（`app_id`/`title`/`description`/
 * `responsible`/`access`/`enabled`/`current_version`/`is_owner`，
 * 发布者本人另有 `purpose`/`whitelist`）；`title` 缺失时回落到 `app_id`
 * （应用名就是标识，至少能让人认出是哪个）。`entry_url` 自 2026-09-19 起**已不在契约里**
 * （冻结契约 §4.5：应用只在客户端内以 `<本安装的 app scheme>://<app_id>/` 打开）—— 服务端若
 * 仍带着它，这里**忽略**（不认识、不渲染、不拼链接）。
 *
 * **不丢任何一行**：这里只有"这条不是合法对象 / 没有合法 app_id"才跳过，没有任何
 * 按可见性/权限/上下架的筛选（目录展示全部应用）。但**跳过必须是可诊断的**：
 * 字段改名（`visible`→`access` 那次就是）会让每一行都被跳过，面板那时显示的是
 * 空态"还没有可用的应用" —— 一个把契约漂移说成"你没有应用"的假答案。
 * @param payload - `GET /api/pico/apps/wasm` 的响应体。
 * @returns 条目 + 行数统计（结构不对时 `rows = 0`、`items` 为空）。
 */
export function parseCatalogReport(payload: unknown): CatalogReport {
  const rows = (payload as { apps?: unknown } | null)?.apps
  if (!Array.isArray(rows)) return { items: [], rows: 0, skipped: 0, sample: '' }
  const items: AppCenterItem[] = []
  const skippedRows: unknown[] = []
  for (const row of rows) {
    if (row === null || typeof row !== 'object') {
      skippedRows.push(row)
      continue
    }
    const entry = row as Record<string, unknown>
    const appId = typeof entry.app_id === 'string' ? entry.app_id : ''
    if (appId === '') {
      skippedRows.push(row)
      continue
    }
    const windowSpec = parseWindowSpec(entry.window)
    items.push({
      appId,
      title: typeof entry.title === 'string' && entry.title.trim() !== '' ? entry.title : appId,
      description: typeof entry.description === 'string' ? entry.description : '',
      responsible: typeof entry.responsible === 'string' ? entry.responsible : '',
      access: resolveAccess(entry),
      // 服务端**会**下发 enabled（下架条目也照样列在目录里，见 api/read.go），
      // 所以这里只在字段缺失时才按"上架"兜底。
      enabled: entry.enabled !== false,
      // 版本缺失 ⇒ 空串（服务端版本行被保留策略回收时会这样）；面板显示为"未知"，
      // **不编造**一个版本号。
      currentVersion: typeof entry.current_version === 'string' ? entry.current_version : '',
      // 归属缺失 ⇒ false：不给"发新版"入口（服务端仍会兜底拒绝，见 ownedApp）。
      isOwner: entry.is_owner === true,
      // 这两个字段只对发布者下发（作者预填用）；缺席时保持缺席，
      // 让"没拿到"和"拿到空值"在类型上可区分。
      ...(typeof entry.purpose === 'string' ? { purpose: entry.purpose } : {}),
      ...(Array.isArray(entry.whitelist)
        ? { whitelist: entry.whitelist.filter((account): account is string => typeof account === 'string') }
        : {}),
      // 窗口声明（F3/§6）：服务端下发才带上；解析不出（越界/形态不符）就当没声明。
      ...(windowSpec === null ? {} : { window: windowSpec }),
    })
  }
  return {
    items,
    rows: rows.length,
    skipped: skippedRows.length,
    sample: skippedRows.length === 0 ? '' : truncate(JSON.stringify(skippedRows.slice(0, 3)), CATALOG_SAMPLE_MAX),
  }
}

/**
 * 解析目录载荷（{@link parseCatalogReport} 的条目部分）。
 * @param payload - `GET /api/pico/apps/wasm` 的响应体。
 * @returns 归一化后的条目；结构不对时返回空数组。
 */
export function parseCatalog(payload: unknown): AppCenterItem[] {
  return parseCatalogReport(payload).items
}

/**
 * 截断字符串（诊断样本用；超长时明说被截断了）。
 * @param text - 原文。
 * @param max - 字节上限。
 * @returns 截断后的文本。
 */
function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…(truncated)`
}

/**
 * 打开失败的 reason → 用户可见文案的字典键（2026-09-19）。
 *
 * 每一种失败都必须**分别可辨**：未登录（去登录）、应用不存在（可能已被删除/改名）、
 * 协议未就绪（客户端还没准备好，重试/升级）、证明缺失（必须在客户端窗口里用）不是
 * 同一件事，混成一句"打开失败"会让用户与维护者都无从下手。文案在 `locales.ts`。
 */
const OPEN_FAILURE_KEYS: Record<OpenFailureReason, AppCenterKey> = {
  'invalid-app-id': 'appCenter.openInvalidAppId',
  'proof-unavailable': 'appCenter.openProofUnavailable',
  'host-proof-unavailable': 'appCenter.openHostProofUnavailable',
  'scheme-unavailable': 'appCenter.openSchemeUnavailable',
  'not-signed-in': 'appCenter.openNotSignedIn',
  // 本机证明闸拒了令牌：请求**发出去了**（"没发请求"那个说法只属于 proof-unavailable）。
  'proof-required': 'appCenter.openHostProofRejected',
  'proof-expired': 'appCenter.openProofExpired',
  // 平台拒绝：不能说成"本页面无法证明自己属于这个客户端窗口"（那是本机那一层的事）。
  'platform-refused': 'appCenter.openPlatformRefused',
  // 平台说"被管理员冻结"：与"不存在"同码同状态，只有 `platform_reason` 能分开。
  // 文案必须说清"只读快照、数据仍保留"，否则用户会去要一个还在的新应用。
  'app-frozen': 'appCenter.openAppFrozen',
  'app-not-found': 'appCenter.openAppMissing',
  'protocol-not-ready': 'appCenter.openProtocolNotReady',
  'host-unreachable': 'appCenter.openHostUnreachable',
  'unexpected-response': 'appCenter.openUnexpectedResponse',
}

/** 打开失败的建议（`hints`，同样按 reason 分派）。 */
const OPEN_FAILURE_HINT_KEYS: Record<OpenFailureReason, AppCenterKey> = {
  'invalid-app-id': 'appCenter.openInvalidAppIdHint',
  'proof-unavailable': 'appCenter.openProofUnavailableHint',
  'host-proof-unavailable': 'appCenter.openHostProofUnavailableHint',
  'scheme-unavailable': 'appCenter.openSchemeUnavailableHint',
  'proof-expired': 'appCenter.openProofExpiredHint',
  'not-signed-in': 'appCenter.openNotSignedInHint',
  'proof-required': 'appCenter.openHostProofRejectedHint',
  'platform-refused': 'appCenter.openPlatformRefusedHint',
  'app-frozen': 'appCenter.openAppFrozenHint',
  'app-not-found': 'appCenter.openAppMissingHint',
  'protocol-not-ready': 'appCenter.openProtocolNotReadyHint',
  'host-unreachable': 'appCenter.openHostUnreachableHint',
  'unexpected-response': 'appCenter.openUnexpectedResponseHint',
}

/**
 * 把打开失败翻译成既有的错误块信封（复用 {@link PublishErrorBlock}：`code` 是稳定
 * 判据、`message` 是本地化说明、`hints` 是可照做的下一步）。
 *
 * `details` 里保留**英文诊断原文**（本机路由/形状细节），维护者据此定位；界面上显示
 * 的是字典文案 —— 不会把英文技术串丢给用户，也不会把原因藏起来。
 * @param failure - {@link openAppEntry} 的失败结果。
 * @returns 可直接渲染的失败信封。
 */
export function openFailureEnvelope(failure: OpenFailure): PublishFailure {
  return {
    ok: false,
    status: failure.status,
    code: `OPEN_${failure.reason.toUpperCase().replace(/-/gu, '_')}`,
    message: t(OPEN_FAILURE_KEYS[failure.reason]),
    details: { reason: failure.reason, error: failure.error },
    hints: [t(OPEN_FAILURE_HINT_KEYS[failure.reason])],
    transport: failure.reason === 'host-unreachable',
  }
}

/**
 * 面板外壳（返回出口 / 标题 / 工具条 / 滚动）由 `@picoaide/dsh-panel-surface`
 * 的 `PanelPage` 提供 —— 2026-09-20 之前这里是一整块 `position:fixed` 的模态浮层，
 * 与「定时任务」中列整页是两套切换语义。现在四个面板同一套。
 *
 * 下面的样式只剩**卡片与正文**，几何在内联、颜色在共享样式表（`.pico-card` 等）。
 */

/** 卡片外框（网格里的应用卡；纵向排布，动作条贴底）。 */
const CARD: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  padding: '14px 15px',
  borderRadius: 14,
}

/** 卡片底部的动作条（主操作贴左、占满剩余宽度）。 */
const CARD_FOOT: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  marginTop: 'auto',
  paddingTop: 10,
  borderTop: '1px solid var(--dsw-alias-border-l1)',
}


const ROW_MAIN: React.CSSProperties = { flex: 1, minWidth: 0 }

const TITLE_ROW: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 7, minWidth: 0, flexWrap: 'wrap' }

/**
 * 访问级别 → 语义色调（标题右侧的小徽章）。
 *
 * 用它替代原来"一种灰描边胶囊打天下"的写法：`login` / `whitelist` 的差别
 * （谁点得开）恰恰是用户最需要一眼看出来的信息。
 */
function accessTone(access: AccessMode): PanelTone {
  // AccessMode 的可写取值只有 login / whitelist（`public` 是历史只读值，
  // 客户端契约里已不在联合类型内 —— 见 appcfg-contract.ts 的对拍用例）。
  return access === 'whitelist' ? 'warn' : 'neutral'
}

const ROW_TITLE: React.CSSProperties = {
  margin: 0,
  fontSize: 14,
  lineHeight: '21px',
  fontWeight: 600,
  color: 'var(--dsw-alias-label-primary)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const ROW_DESC: React.CSSProperties = {
  margin: '6px 0 0',
  fontSize: 12,
  lineHeight: '18px',
  color: 'var(--dsw-alias-label-secondary)',
}

const ROW_META: React.CSSProperties = {
  margin: '6px 0 0',
  fontSize: 11,
  lineHeight: '16px',
  color: 'var(--dsw-alias-label-tertiary)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

/** 正文里的错误/空态块（居中 + 图标，取代原来的一段裸灰字）。 */
const HINT: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 6,
  padding: '34px 18px',
  textAlign: 'center',
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: 13,
  lineHeight: '20px',
}

/** 建议列表（错误信封的 `hints`；与发布失败块的形状一致）。 */
const HINT_LIST: React.CSSProperties = { margin: '6px 0 0', paddingLeft: 18 }

/** 一次性引导卡的外框。 */
const CARD_BOX: React.CSSProperties = {
  padding: '14px 16px',
  marginBottom: 14,
  borderRadius: 14,
  fontSize: 13,
  lineHeight: '20px',
  color: 'var(--dsw-alias-label-primary)',
}

/** 诊断原文（服务端下发的原始行样本 / 非 JSON body）。 */
const DETAILS: React.CSSProperties = {
  margin: '8px 0 0',
  maxHeight: 160,
  overflow: 'auto',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 11,
  lineHeight: '16px',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
}

/** 目录行下方的"管理"动作条（作者本人可见；次要动作，视觉上比"打开"轻）。 */
const ACTIONS: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 2,
  paddingTop: 8,
}

/**
 * 危险动作（下架 / 删除）的按钮样式。
 *
 * 用上游真实存在的 `--dsw-alias-state-error-primary` 而不是自造红色：主题 token 是上游的，
 * 硬编码 `#d00` 在暗色主题下会失真（`scripts/check-theme-tokens.mjs` 会直接拦下不存在的 token）。
 */

/** 二次确认块（危险动作的唯一闸门；确认与取消都是真 `<button>`，可键盘操作）。 */
const CONFIRM: React.CSSProperties = {
  marginTop: 10,
  padding: '10px 12px',
  borderRadius: 10,
  border: '1px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-layer-1)',
  fontSize: 12,
  lineHeight: '18px',
  color: 'var(--dsw-alias-label-primary)',
}

/** 确认块里的按钮行（确认在左、取消在右）。 */
const CONFIRM_ROW: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }

/** 版本历史面板（只读；与 {@link DIAGNOSTICS} 同一形状，作者读结论用）。 */
const RELEASES: React.CSSProperties = {
  marginTop: 10,
  padding: '10px 12px',
  borderRadius: 10,
  border: '1px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-layer-1)',
  fontSize: 12,
  lineHeight: '18px',
  color: 'var(--dsw-alias-label-primary)',
}

/** 被拒理由块（版本历史里最要紧的那一行：理由 + 出路）。 */
const REJECTION: React.CSSProperties = {
  marginTop: 4,
  padding: '6px 8px',
  borderRadius: 8,
  border: '1px solid var(--dsw-alias-state-error-primary)',
  background: 'var(--dsw-alias-bg-layer-1)',
  color: 'var(--dsw-alias-label-primary)',
}

/** 诊断面板（只读；缩进一级，与动作条区分）。 */
const DIAGNOSTICS: React.CSSProperties = {
  marginTop: 10,
  padding: '10px 12px',
  borderRadius: 10,
  border: '1px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-layer-1)',
  fontSize: 12,
  lineHeight: '18px',
  color: 'var(--dsw-alias-label-primary)',
}

/** 目录顶部的操作结果通知（目前只有"已删除"）。 */
const NOTICE: React.CSSProperties = {
  ...CONFIRM,
  marginTop: 0,
  marginBottom: 10,
}

/**
 * 应用中心面板（模态）。
 *
 * 视图（FIX-38 + F16）：**目录**（默认）/ **发布**（员工发布入口）/ **详情**
 * （打开次数 + 分享 + 应用 AI）。发布由页面上下文 `POST /api/pico/apps/wasm/publish`
 * —— 页面天然持 `dsh-auth-*` 持有性证明，因此不需要任何新的信任机制；分片/续传/90 s
 * 预算全部复用宿主那一份编排。
 *
 * 挂载期取三样东西（各自**独立**失败，互不阻塞）：
 *  1. 目录（`GET /api/pico/apps/wasm`）——失败 ⇒ 错误/未登录态；
 *  2. 渠道参数（`GET /api/pico/wasm-apps/channel`，§16.1）——失败 ⇒ 分享入口**不渲染**
 *     （fail-closed，§19 Q6），打开链路会自己再补一次取数；
 *  3. 身份（`GET /api/pico/auth/state`）——只为应用 AI 的"按用户×应用授权"提供作用域，
 *     拿不到就按未登录处理（授权不被记住，fail-closed）。
 *
 * @param props - `onClose` 由触发按钮提供（关闭时卸载面板）；其余为可注入依赖（测试用）。
 */
export function AppCenterPanel({
  onClose, onboardingStore, channelLoader, channelResultLoader, identityLoader, writeClipboard, aiDeps, aiConsentStore,
  intentStore, loginStateLoader, loginPollMs, now, dataDeps,
}: {
  onClose: () => void
  /** 一次性引导卡的存储（缺省渲染进程 `localStorage`）。 */
  onboardingStore?: OnboardingStore | null
  /** 渠道参数取数（缺省宿主只读路由；测试注入假实现）。 */
  channelLoader?: () => Promise<AppChannel | null>
  /** 渠道取数的**分档结果**（测试注入失败原因；优先于 `channelLoader`）。 */
  channelResultLoader?: () => Promise<AppChannelResult>
  /** 应用 AI 的身份取数（缺省 `/api/pico/auth/state`）。 */
  identityLoader?: () => Promise<string>
  /** 写剪贴板（缺省 `navigator.clipboard.writeText`；测试注入 spy）。 */
  writeClipboard?: (text: string) => Promise<void>
  /** 应用 AI 的传输依赖（测试注入假 fetch）。 */
  aiDeps?: AppAiDeps
  /** 应用 AI 的授权存储（缺省渲染进程 `localStorage`）。 */
  aiConsentStore?: AppAiConsentStore | null
  /** 作者数据面的取数依赖（测试注入假 fetch；缺省走页面上下文的本机路由）。 */
  dataDeps?: RequestDeps
  /** 「未登录时记住这次打开」的存储（缺省 `sessionStorage`）。 */
  intentStore?: OpenIntentStore | null
  /** 登录态取数（缺省读本机 `/api/pico/auth/state`；测试注入假实现）。 */
  loginStateLoader?: () => Promise<boolean>
  /** 待继续打开的登录态轮询间隔（缺省 5s，与 auth-gate 的 tripwire 同节奏）。 */
  loginPollMs?: number
  /** 当前时间（TTL 判定；测试注入）。 */
  now?: () => number
}) {
  const [state, setState] = useState<AppCenterState>({ kind: 'loading' })
  const [view, setView] = useState<'catalog' | 'publish' | 'detail'>('catalog')
  // 发布基线（P1-3）：目录行的"发新版"按钮把它带进表单；`undefined` = 首版发布。
  const [publishTarget, setPublishTarget] = useState<PublishTarget | undefined>(undefined)
  // 删除成功后的服务端说明（见 CatalogNotice）。
  const [notice, setNotice] = useState<CatalogNotice | null>(null)
  // 详情视图当前选中的应用（F16 / §19 Q11）。
  const [detail, setDetail] = useState<AppCenterItem | null>(null)
  // 渠道参数：分享链接的**唯一**来源（未拿到 ⇒ 分享入口不渲染）。
  const [channel, setChannel] = useState<AppChannel | null>(() => appChannel())
  // 没拿到渠道参数的**原因**（分享入口不可用时据此分档说明：证明问题 ≠ 配置问题）。
  const [channelFailure, setChannelFailure] = useState<AppChannelFailure | null>(null)
  // 可发现性（§19 Q1）：搜索 + 「我发布的」+ 分批显示。
  const [filter, setFilter] = useState<CatalogFilter>(EMPTY_FILTER)
  const [visible, setVisible] = useState(CATALOG_PAGE_SIZE)
  // F16 的打开计数（按 app_id 记；只在 open 端点回传过之后才有值）。
  const [openCounts, setOpenCounts] = useState<Record<string, AppOpenCounts>>({})
  // 一次性引导卡（§7.2）：关过就不再出现。
  const [onboarded, setOnboarded] = useState(() => isOnboardingDismissed(onboardingStore))
  // 应用 AI 的授权作用域（用户×服务端；空串 = 未登录/拿不到 ⇒ 授权不记住）。
  const [identity, setIdentity] = useState('')
  // 复制链接的即时反馈（哪个 app_id 刚复制成功）。
  const [copied, setCopied] = useState<string | null>(null)
  // 打开动作的反馈（§5.2 的 `window` 字段：新开 / 聚焦；没下发就什么都不说）。
  const [openFeedback, setOpenFeedback] = useState<Record<string, OpenWindowOutcome>>({})
  // 「未登录时记住这次打开」（§19 Q4）：登录完成后自动继续，不再要求用户点一次。
  /** 待继续的打开：`at` 是意图记录时刻，轮询按 `OPEN_INTENT_TTL_MS` 判过期（与宿主同口径）。 */
  const [pendingOpen, setPendingOpen] = useState<{ appId: string; at: number } | null>(null)
  /** 自动继续打开失败的原因（此前完全静默：提示消失、窗不开、什么都不说）。 */
  const [pendingOpenFailure, setPendingOpenFailure] = useState<PublishFailure | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setState({ kind: 'loading' })
    try {
      const response = await fetch('/api/pico/apps/wasm')
      if (!response.ok) {
        // 非 2xx 时**必须解析响应体**（P1-5）：宿主/服务端给的是可执行的
        // `{error:{code,message,details,hints}}`（例如网关的 GATEWAY_UNAVAILABLE +
        // "检查网络与服务端地址"），只拼状态码等于把可自修的信息全丢掉。
        const text = await response.text().catch(() => '')
        let payload: unknown = null
        try { payload = text === '' ? null : JSON.parse(text) } catch { payload = null }
        const failure = parseErrorEnvelope(response.status, payload, text === '' ? t('appCenter.error') : text.slice(0, CATALOG_SAMPLE_MAX))
        // 401 = 未登录（宿主路由的 AUTH_REQUIRED）：这是**独立的空态**，不是错误，
        // 也不是"还没有可用的应用"（§19 Q2/Q4 的三种空态各自可辨）。
        if (response.status === 401) {
          setState({ kind: 'signed-out' })
          return
        }
        setState({
          kind: 'error',
          error: {
            code: failure.code,
            message: failure.message,
            hints: failure.hints,
            ...(failure.details === undefined ? {} : { details: typeof failure.details === 'string' ? failure.details : JSON.stringify(failure.details) }),
          },
        })
        return
      }
      const report = parseCatalogReport(await response.json())
      // 服务端**下发了行**却一行都没解析出来 ⇒ 契约漂移（字段改名），必须报错而不是
      // 显示"还没有可用的应用"：后者把"我们的解析坏了"说成"你没有应用"（P2-10）。
      if (report.rows > 0 && report.items.length === 0) {
        setState({
          kind: 'error',
          error: {
            code: 'CATALOG_SHAPE_MISMATCH',
            message: t('appCenter.catalogShapeMismatch'),
            hints: [t('appCenter.catalogShapeHint')],
            details: report.sample,
          },
        })
        return
      }
      setState({ kind: 'ready', items: report.items })
    } catch (cause) {
      setState({
        kind: 'error',
        error: {
          code: 'NETWORK_ERROR',
          message: cause instanceof Error ? cause.message : String(cause),
          hints: [],
        },
      })
    }
  }, [])

  useEffect(() => { void load() }, [load])

  // 渠道参数：挂载时取一次（§16.1 的渲染进程 scheme 注入）。失败 ⇒ `channel` 保持
  // `null`，分享入口一个都不渲染（§19 Q6 的 fail-closed），并把**原因**分档显示出来
  // （R2-X-1：证明问题与配置问题不能塌缩成同一句，否则排障会指错方向）。
  useEffect(() => {
    let cancelled = false
    // 本机持有性证明（§22.2 R2）：顺手引导一枚令牌 —— 渠道/打开都要它。
    // 这里失败不阻塞目录渲染（打开时会再判一次并给可辨原因）。
    void ensureHostProof().catch(() => undefined)
    const loader: () => Promise<AppChannelResult> = channelResultLoader
      ?? (channelLoader === undefined
        ? () => loadAppChannel()
        : async () => ({ channel: await channelLoader(), failure: null }))
    void loader()
      .then((result) => {
        if (cancelled) return
        // 注入模块态（打开链路读它），并同步到渲染态（分享入口据此决定是否渲染）。
        if (result.channel !== null) setAppChannel(result.channel)
        setChannel(result.channel ?? appChannel())
        setChannelFailure(result.failure)
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setChannel(appChannel())
        setChannelFailure({
          reason: 'transport',
          status: null,
          message: cause instanceof Error ? cause.message : String(cause),
        })
      })
    return () => { cancelled = true }
  }, [channelLoader, channelResultLoader])

  // 应用 AI 的身份作用域（§21.1 第 9 条：授权按 **用户×应用** 记）。
  useEffect(() => {
    let cancelled = false
    const loader = identityLoader ?? (() => loadAppAiIdentity())
    void loader()
      .then((value) => { if (!cancelled) setIdentity(value) })
      .catch(() => { if (!cancelled) setIdentity('') })
    return () => { cancelled = true }
  }, [identityLoader])

  // Esc 由装载器统一处理（`@picoaide/dsh-panel-surface`：面板自身是激活态时关闭，
  // 检测到内层模态时让位）。这里**不要**再注册一份：2026-09-21 真机审计发现这份
  // 重复的 document 级监听会把内层场景一起关掉 ——
  //   ① 在 `type="search"` 搜索框里按 Esc（浏览器本来会清空输入）会连面板一起关；
  //   ② 发布表单填了一半/正在上传时按 Esc，表单与已选文件直接丢失（上传被卸载 effect
  //      abort），没有二次确认；
  //   ③ 下架/删除确认块打开时按 Esc 关的是整个面板，而不是取消确认。
  // 需要"Esc 只回上一层"的地方（详情/发布表单）应由那一层自己接管。

  /**
   * 复制分享深链（F6 / §19 Q6）。
   *
   * 只在**有渠道 scheme** 时才可能成功：`appShareLink` 在未注入时返回 `null`，
   * 这里也就什么都不写（按钮本身在那种情况下不渲染，这里是第二道闸）。
   * @param item - 目录条目。
   * @returns true = 真的写进了剪贴板。
   */
  const handleCopyLink = useCallback(async (item: AppCenterItem): Promise<boolean> => {
    const link = appShareLink(item.appId)
    if (link === null) return false
    try {
      const write = writeClipboard ?? defaultWriteClipboard
      await write(link)
      setCopied(item.appId)
      return true
    } catch {
      setCopied(null)
      return false
    }
  }, [writeClipboard])

  /**
   * 登录态取数（缺省读本机 `/api/pico/auth/state`）。
   *
   * 复用 `app-ai.ts` 的身份解析：它返回空串表示"未登录/拿不到"，非空表示已登录
   * （用户名 + 服务端地址）。身份取不到时按**未登录**处理 —— 对"自动继续"来说，
   * 不确定就不动（宁可让用户再点一次，也不在一个不确定的会话上开窗）。
   */
  const loadLoginState = useCallback(
    async (): Promise<boolean> => await (loginStateLoader ?? (async () => (await loadAppAiIdentity()) !== ''))(),
    [loginStateLoader],
  )

  /**
   * 登录完成后**自动继续**那次被记住的打开（§19 Q4：不用再点一次）。
   *
   * 记在存储里（不是 state）的原因见 `open-intent.ts`：客户端登录会重载页面，
   * 组件 state 活不过那一跳。这里只在"确实已登录"时才发起，失败就清掉意图（不循环）。
   * @param appId - 待继续的 app_id。
   */
  const continuePendingOpen = useCallback(async (appId: string): Promise<void> => {
    clearOpenIntent(intentStore === undefined ? {} : { store: intentStore })
    setPendingOpen(null)
    const result = await openAppEntry(appId)
    if (!result.ok) {
      // 静默是缺陷（2026-09-21 审计）：登录后自动继续若失败（应用已删/被冻结/协议未就绪），
      // 用户只会看到"提示没了、窗也没开"。复用既有的错误块信封如实渲染。
      setPendingOpenFailure(openFailureEnvelope(result))
      return
    }
    setPendingOpenFailure(null)
    if (result.window !== undefined) setOpenFeedback(previous => ({ ...previous, [appId]: result.window! }))
    if (result.counts !== undefined) {
      const counts = result.counts
      setOpenCounts(previous => ({ ...previous, [appId]: counts }))
    }
  }, [intentStore])

  /**
   * 挂载时读一次"待继续的打开"（页面重载回来后的第一件事）。
   *
   * 已登录 ⇒ 立刻继续；未登录 ⇒ 保持 pending，由下面的轮询等登录完成。
   */
  useEffect(() => {
    const intent = readOpenIntent(intentStore === undefined ? {} : { store: intentStore, ...(now === undefined ? {} : { now: now() }) })
    if (intent === null) return
    let cancelled = false
    void loadLoginState().then((loggedIn) => {
      if (cancelled) return
      if (loggedIn) { void continuePendingOpen(intent.appId); return }
      setPendingOpen({ appId: intent.appId, at: intent.at })
    }).catch(() => { if (!cancelled) setPendingOpen({ appId: intent.appId, at: intent.at }) })
    return () => { cancelled = true }
    // 只在挂载时跑一次：意图的后续变化由 pendingOpen 的轮询与打开动作驱动。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 未登录期间轮询登录态；一旦登录完成就自动继续（§19 Q4）。轮询只在有 pending 时存在。
  useEffect(() => {
    if (pendingOpen === null) return
    const appId = pendingOpen.appId
    const at = pendingOpen.at
    let cancelled = false
    const timer = setInterval(() => {
      // TTL 与宿主同口径（5 分钟，`open-intent.ts`）：挂载时判过一次，但"用户 6 分钟后才
      // 登录"这条路径此前没有任何时间判据 ⇒ 提示常驻、每 5s 永久轮询，还会在过期后突然
      // 开窗。过期即清意图并停止轮询。
      if ((now ?? Date.now)() - at > OPEN_INTENT_TTL_MS) {
        clearOpenIntent(intentStore === undefined ? {} : { store: intentStore })
        setPendingOpen(null)
        return
      }
      void loadLoginState().then((loggedIn) => {
        if (cancelled || !loggedIn) return
        void continuePendingOpen(appId)
      }).catch(() => { /* 下一次轮询再试 */ })
    }, loginPollMs ?? LOGIN_POLL_MS)
    return () => { cancelled = true; clearInterval(timer) }
  }, [pendingOpen, loadLoginState, continuePendingOpen, loginPollMs, intentStore, now])

  /**
   * 上架 / 下架：**用服务端返回的 `enabled` 更新行**（不是请求里的值）。
   *
   * 为什么不能乐观更新：服务端对"状态本来就一致"的请求返回 `changed:false` 与它自己的
   * 当前值（`api/release.go:69-73`）。拿请求值当结果，界面上就会出现一个服务端从未
   * 确认过的状态 —— 而这一行的状态决定"打开"按钮能不能点。
   */
  const handleSetPublished = useCallback(async (item: AppCenterItem, enabled: boolean): Promise<SetPublishedOutcome> => {
    const result = await setAppPublished(item.appId, enabled)
    if (result.ok) {
      setState(previous => previous.kind !== 'ready'
        ? previous
        : { kind: 'ready', items: previous.items.map(row => (row.appId === result.appId ? { ...row, enabled: result.enabled } : row)) })
    }
    return result
  }, [])

  /**
   * 删除：服务端确认 `deleted` 之后行才消失，并把服务端的 `note` / `retention_days`
   * 原样显示在通知里（保留期语义由服务端说，客户端不复述 —— 见 {@link CatalogNotice}）。
   */
  const handleDelete = useCallback(async (item: AppCenterItem): Promise<DeleteOutcome> => {
    const result = await deleteApp(item.appId)
    if (result.ok) {
      setState(previous => previous.kind !== 'ready'
        ? previous
        : { kind: 'ready', items: previous.items.filter(row => row.appId !== result.appId) })
      setNotice({ kind: 'deleted', appId: result.appId, note: result.note, retentionDays: result.retentionDays })
    }
    return result
  }, [])

  /** 诊断：只读，不改任何行状态（失败由行自己渲染信封）。 */
  const handleDiagnostics = useCallback(
    async (item: AppCenterItem): Promise<DiagnosticsOutcome> => await fetchDiagnostics(item.appId),
    [],
  )

  /**
   * 版本历史：只读，不改任何行状态（R1-pm-3）。
   *
   * 与诊断共用同一条路径形状（`/api/pico/apps/wasm/:app_id/<后缀>`）：页面上下文发起，
   * 宿主代理到服务端员工面；非发布者服务端一律 404，失败由行自己渲染信封。
   */
  const handleReleases = useCallback(
    async (item: AppCenterItem): Promise<ReleasesOutcome> => await fetchMyReleases(item.appId),
    [],
  )

  return (
    <div className="pico-app-center" data-role="app-center-page">
      <PanelPage
        icon={<icons.IconApps size={16} />}
        title={view === 'publish' ? t('appCenter.publishTitle') : t('appCenter.title')}
        subtitle={view === 'publish' ? t('appCenter.publishSubtitle') : t('appCenter.subtitle')}
        backLabel={t('appCenter.backToChat')}
        onClose={onClose}
        {...(view === 'catalog'
          ? {
              actions: (
                <PanelButton
                  variant="primary"
                  size="md"
                  className="pico-app-center-publish"
                  data-action="open-publish"
                  icon={<icons.IconPlus size={14} />}
                  aria-label={t('appCenter.publishAria')}
                  // 表头的"发布"= **首版**发布：不带基线，因此不预填任何"当前值"。
                  onClick={() => { setPublishTarget(undefined); setView('publish') }}
                >
                  {t('appCenter.publish')}
                </PanelButton>
              ),
            }
          : {})}
      >
        {view === 'catalog' && pendingOpenFailure !== null && (
          <PublishErrorBlock failure={pendingOpenFailure} title={t('appCenter.actionFailed')} role="lifecycle-error" />
        )}
        {view === 'publish' && (
          <PublishForm
            {...(publishTarget === undefined ? {} : { target: publishTarget })}
            onClose={() => { setView('catalog') }}
            onPublished={() => { void load() }}
          />
        )}
        {view === 'detail' && detail !== null && (
          <AppDetailView
            item={detail}
            channel={channel}
            {...(openCounts[detail.appId] === undefined ? {} : { counts: openCounts[detail.appId] })}
            {...(openFeedback[detail.appId] === undefined ? {} : { windowOutcome: openFeedback[detail.appId] })}
              copied={copied === detail.appId}
              identity={identity}
              {...(aiDeps === undefined ? {} : { aiDeps })}
              {...(aiConsentStore === undefined ? {} : { aiConsentStore })}
              {...(dataDeps === undefined ? {} : { dataDeps })}
              onBack={() => { setView('catalog') }}
              onOpen={async () => await openRow(detail)}
              onCopyLink={async () => await handleCopyLink(detail)}
            />
          )}
          {view === 'catalog' && (
            <AppCenterBody
              state={state}
              notice={notice}
              filter={filter}
              onFilterChange={next => { setFilter(next); setVisible(CATALOG_PAGE_SIZE) }}
              visible={visible}
              onShowMore={() => { setVisible(previous => previous + CATALOG_PAGE_SIZE) }}
              onboardingDismissed={onboarded}
              onDismissOnboarding={() => { dismissOnboarding(onboardingStore); setOnboarded(true) }}
              pendingOpenAppId={pendingOpen === null ? null : pendingOpen.appId}
              shareScheme={channel === null ? null : channel.deepLinkScheme}
              channelFailure={channel === null ? channelFailure : null}
              openCounts={openCounts}
              openFeedback={openFeedback}
              copied={copied}
              onCopyLink={async item => await handleCopyLink(item)}
              onOpenDetail={item => { setDetail(item); setView('detail') }}
              onRetry={() => { void load() }}
              onPublish={() => { setPublishTarget(undefined); setView('publish') }}
              onPublishNewVersion={item => {
                // 把目录行的当前值交给表单（P1-3）：预填是"不静默改写线上配置"
                // 的唯一手段 —— 作者不动单选框时提交的就是现状。
                setPublishTarget({
                  appId: item.appId,
                  title: item.title,
                  access: item.access,
                  currentVersion: item.currentVersion,
                  owner: item.responsible,
                  ...(item.purpose === undefined ? {} : { purpose: item.purpose }),
                  ...(item.whitelist === undefined ? {} : { whitelist: item.whitelist }),
                  ...(item.window === undefined ? {} : { window: item.window }),
                })
                setView('publish')
              }}
              onOpenFailure={(item, failure) => {
                // 未登录（§19 Q4/Q6）：宿主负责弹登录，客户端负责"登录后自动继续"。
                if (failure.reason !== 'not-signed-in') return
                saveOpenIntent(item.appId, intentStore === undefined ? {} : { store: intentStore, ...(now === undefined ? {} : { now: now() }) })
                setPendingOpen({ appId: item.appId, at: (now ?? Date.now)() })
              }}
              onOpenResult={(item, counts, outcome) => {
                // F16：打开端点在同一次调用里回传今日计数 ⇒ 记下来给详情页渲染
                // （没回传就保持"未知"，不编造）。
                if (counts !== undefined) setOpenCounts(previous => ({ ...previous, [item.appId]: counts }))
                // §5.2 的 `window`：新开还是聚焦（没回传就什么都不说）。
                if (outcome !== undefined) setOpenFeedback(previous => ({ ...previous, [item.appId]: outcome }))
              }}
              onSetPublished={handleSetPublished}
              onDelete={handleDelete}
              onDiagnostics={handleDiagnostics}
              onReleases={handleReleases}
            />
          )}
      </PanelPage>
    </div>
  )

  /**
   * 打开一个应用并把结果翻译成面板状态（F16 的计数在这里被记下）。
   *
   * 只认 `openAppEntry` 的成功/失败判据：失败**不**清空任何已有计数（一次网络抖动不该
   * 让"今日已被打开 N 次"消失），成功且回传计数才覆盖。
   * @param item - 目录条目。
   * @returns 失败信封（成功为 `null`）。
   */
  async function openRow(item: AppCenterItem): Promise<PublishFailure | null> {
    const result = await openAppEntry(item.appId)
    if (result.ok) {
      if (result.counts !== undefined) {
        const counts = result.counts
        setOpenCounts(previous => ({ ...previous, [item.appId]: counts }))
      }
      if (result.window !== undefined) {
        const outcome = result.window
        setOpenFeedback(previous => ({ ...previous, [item.appId]: outcome }))
      }
      return null
    }
    // 未登录：**记住这次打开**（§19 Q4/Q6）——宿主负责弹登录，客户端负责"登录后自动继续"。
    if (result.reason === 'not-signed-in') {
      saveOpenIntent(item.appId, intentStore === undefined ? {} : { store: intentStore, ...(now === undefined ? {} : { now: now() }) })
      setPendingOpen({ appId: item.appId, at: (now ?? Date.now)() })
    }
    return openFailureEnvelope(result)
  }
}

/**
 * 默认的剪贴板写入（`navigator.clipboard.writeText`）。
 *
 * 缺席（旧内核 / 非安全上下文）时**抛**：调用方据此渲染"复制失败：请手动复制"，
 * 而不是显示一个假的"已复制"。
 * @param text - 要复制的文本。
 */
async function defaultWriteClipboard(text: string): Promise<void> {
  const clipboard = (globalThis as { navigator?: { clipboard?: { writeText?: (value: string) => Promise<void> } } })
    .navigator?.clipboard
  if (clipboard?.writeText === undefined) throw new Error('clipboard API is unavailable')
  await clipboard.writeText(text)
}

/**
 * 面板正文：把五种状态渲染成 DOM（loading / signed-out / error / empty / list）。
 *
 * 单独导出而不是内联在 {@link AppCenterPanel} 里，是为了让"目录渲染 / 三种空态 /
 * 不含额度字段"这些断言可以**直接渲染**；而"挂载后真的取数"这条链路由
 * `app-center-mount.spec.tsx` 用真挂载（跑 `useEffect`）+ 真路由覆盖（FIX-42）。
 *
 * 作者自服务的四个回调（`onSetPublished` / `onDelete` / `onDiagnostics` / `onReleases`）
 * 都是**可选**的：缺席时对应按钮一个都不渲染（`app-center.spec.tsx` 的静态渲染用例正是
 * 这种形态）—— "面板不给我这个能力"与"我点了但服务端拒绝"是两件事，不能混。
 *
 * 筛选与分享同样是可选的（`filter` 缺席 ⇒ 不过滤、不渲染工具条）：静态渲染用例与
 * 真挂载用例共用同一个组件，而不是各自维护一份渲染分支。
 * @param props - 状态、回调、筛选、分享与 F16 计数。
 */
export function AppCenterBody({
  state, notice, filter, onFilterChange, visible, onShowMore,
  onboardingDismissed, onDismissOnboarding, pendingOpenAppId,
  shareScheme, channelFailure, openCounts, openFeedback, copied, onCopyLink, onOpenDetail, onOpenResult, onOpenFailure,
  onRetry, onPublish, onPublishNewVersion, onSetPublished, onDelete, onDiagnostics, onReleases,
}: {
  state: AppCenterState
  notice?: CatalogNotice | null
  /** 筛选条件（缺席 ⇒ 不过滤，也不渲染工具条）。 */
  filter?: CatalogFilter
  onFilterChange?: (next: CatalogFilter) => void
  /** 目录行可见上限（缺席 ⇒ 不分批）。 */
  visible?: number
  onShowMore?: () => void
  /** 一次性引导卡是否已关闭（缺席 ⇒ 不渲染引导卡）。 */
  onboardingDismissed?: boolean
  onDismissOnboarding?: () => void
  /** 已记住、等登录完成后自动继续的 app_id（渲染一行说明，不是错误）。 */
  pendingOpenAppId?: string | null
  /** 生效的渠道深链 scheme；`null`/缺席 ⇒ 分享入口**不渲染**（§19 Q6）。 */
  shareScheme?: string | null
  /** 没拿到渠道参数的**原因**（分档说明：证明问题 ≠ 配置问题）。 */
  channelFailure?: AppChannelFailure | null
  /** F16 的今日打开计数（按 app_id）。 */
  openCounts?: Record<string, AppOpenCounts>
  /** 打开结果（§5.2 `window`：新开 / 聚焦），按 app_id。 */
  openFeedback?: Record<string, OpenWindowOutcome>
  /** 刚复制成功的 app_id。 */
  copied?: string | null
  onCopyLink?: (item: AppCenterItem) => Promise<boolean>
  onOpenDetail?: (item: AppCenterItem) => void
  /** 打开动作结束后由行上报（成功时带上服务端回传的计数与 §5.2 的 `window`）。 */
  onOpenResult?: (item: AppCenterItem, counts: AppOpenCounts | undefined, window: OpenWindowOutcome | undefined) => void
  /** 打开**失败**时由行上报（面板据此记住"未登录时的那次打开"）。 */
  onOpenFailure?: (item: AppCenterItem, failure: OpenFailure) => void
  onRetry: () => void
  onPublish?: () => void
  onPublishNewVersion?: (item: AppCenterItem) => void
  onSetPublished?: (item: AppCenterItem, enabled: boolean) => Promise<SetPublishedOutcome>
  onDelete?: (item: AppCenterItem) => Promise<DeleteOutcome>
  onDiagnostics?: (item: AppCenterItem) => Promise<DiagnosticsOutcome>
  onReleases?: (item: AppCenterItem) => Promise<ReleasesOutcome>
}) {
  const activeFilter = filter ?? EMPTY_FILTER
  const items = state.kind === 'ready' ? state.items : []
  const filtered = useMemo(() => filterCatalog(items, activeFilter), [items, activeFilter])
  const empty = state.kind === 'ready' ? catalogEmptyState(items, filtered, activeFilter) : null
  const { page, remaining } = paginateCatalog(filtered, visible ?? Number.MAX_SAFE_INTEGER)
  return (
    <>
      {notice !== null && notice !== undefined && <NoticeBlock notice={notice} />}
      {state.kind === 'loading' && <div style={HINT}>{t('appCenter.loading')}</div>}

      {/* 未登录（§19 Q2/Q4 的独立空态）：不是错误、也不是"没有应用"。 */}
      {state.kind === 'signed-out' && (
        <div style={HINT} data-role="catalog-signed-out">
          <IconTile size={46} radius={15} tone="warn"><icons.IconShield size={22} /></IconTile>
          <div data-role="signed-out-message" style={{ fontSize: 14, fontWeight: 600 }}>{t('appCenter.notLoggedIn')}</div>
          <div data-role="signed-out-hint">{t('appCenter.notLoggedInHint')}</div>
          <PanelButton variant="secondary" size="md" className="pico-app-center-retry" icon={<icons.IconRefresh size={14} />} style={{ marginTop: 6 }} onClick={onRetry}>
            {t('appCenter.retry')}
          </PanelButton>
        </div>
      )}

      {state.kind === 'error' && (
        <div style={HINT} data-role="catalog-error">
          <IconTile size={46} radius={15} tone="danger"><icons.IconAlert size={22} /></IconTile>
          {/* 错误信封逐字段显示（P1-5）：code + message + hints（+ 可选原文）。 */}
          <div data-role="error-code" style={{ fontSize: 14, fontWeight: 600 }}>{`${t('appCenter.errorCode')}: ${state.error.code}`}</div>
          <div data-role="error-message">{state.error.message}</div>
          {state.error.hints.length > 0 && (
            <ul style={{ ...HINT_LIST, textAlign: 'left' }} data-role="error-hints">
              {state.error.hints.map(hint => <li key={hint}>{hint}</li>)}
            </ul>
          )}
          {state.error.details !== undefined && state.error.details !== '' && (
            <pre style={{ ...DETAILS, textAlign: 'left' }} data-role="error-details">{state.error.details}</pre>
          )}
          <PanelButton variant="secondary" size="md" className="pico-app-center-retry" icon={<icons.IconRefresh size={14} />} style={{ marginTop: 6 }} onClick={onRetry}>
            {t('appCenter.retry')}
          </PanelButton>
        </div>
      )}

      {state.kind === 'ready' && (
        <CatalogToolbar filter={activeFilter} {...(onFilterChange === undefined ? {} : { onFilterChange })} />
      )}

      {/* 一次性引导卡（§7.2）：只在**首次**打开应用中心时出现，关闭后不再出现。 */}
      {state.kind === 'ready' && onboardingDismissed === false && onDismissOnboarding !== undefined && (
        <OnboardingCard onDismiss={onDismissOnboarding} />
      )}

      {/* 空态 ①：目录里一个应用都没有 ⇒ 引导让 AI 做一个。 */}
      {empty === 'no-apps' && (
        <div style={HINT} data-role="catalog-empty">
          <IconTile size={46} radius={15} tone="brand"><icons.IconApps size={22} /></IconTile>
          <div style={{ fontSize: 14, fontWeight: 600 }}>{t('appCenter.empty')}</div>
          <div>{t('appCenter.emptyHint')}</div>
          {onPublish !== undefined && (
            <PanelButton variant="primary" size="md" className="pico-app-center-empty-publish" icon={<icons.IconPlus size={14} />} style={{ marginTop: 6 }} onClick={onPublish}>
              {t('appCenter.publish')}
            </PanelButton>
          )}
        </div>
      )}

      {/* 分享入口不可用时的分档说明（R2-X-1 第 6 条）——只在渠道确实没拿到时出现。 */}
      {channelFailure !== null && channelFailure !== undefined && (
        <div style={CONFIRM} data-role="share-unavailable" data-reason={channelFailure.reason}>
          {channelFailure.reason === 'scheme-not-configured'
            ? t('appCenter.shareUnavailableConfig')
            : t('appCenter.shareUnavailableProof')}
        </div>
      )}

      {/* 已记住的打开（§19 Q4）：不是错误，是"等你登录完我接着开"。 */}
      {pendingOpenAppId !== null && pendingOpenAppId !== undefined && (
        <div style={CONFIRM} data-role="open-pending-login" role="status">
          {`${t('appCenter.openPendingLogin')} (${pendingOpenAppId})`}
        </div>
      )}

      {/* 空态 ②：有应用，但当前筛选条件一个都没命中（**不得**说成"还没有可用的应用"）。 */}
      {empty === 'no-results' && (
        <div style={HINT} data-role="catalog-no-results">
          <IconTile size={46} radius={15} tone="neutral"><icons.IconSearch size={22} /></IconTile>
          <div data-role="no-results-message" style={{ fontSize: 14, fontWeight: 600 }}>{t('appCenter.noResults')}</div>
          <div data-role="no-results-hint">{t('appCenter.noResultsHint')}</div>
          {onFilterChange !== undefined && (
            <PanelButton
              variant="secondary"
              size="md"
              className="pico-app-center-clear-filters"
              style={{ marginTop: 6 }}
              onClick={() => { onFilterChange(EMPTY_FILTER) }}
            >
              {t('appCenter.clearFilters')}
            </PanelButton>
          )}
        </div>
      )}

      {/* 空态 ③：可见的行**全部下架**（§19 Q2 第二档：说明原因 + 联系负责人）。 */}
      {empty === 'all-disabled' && (
        <div style={HINT} data-role="catalog-all-disabled">
          <IconTile size={46} radius={15} tone="neutral"><icons.IconUnplug size={22} /></IconTile>
          <div data-role="all-disabled-message" style={{ fontSize: 14, fontWeight: 600 }}>{t('appCenter.allDisabled')}</div>
          <div data-role="all-disabled-hint">{t('appCenter.allDisabledHint')}</div>
        </div>
      )}

      {state.kind === 'ready' && page.length > 0 && (
        <div style={PANEL_GRID} data-role="catalog-grid">
          {page.map(item => (
            <AppCenterRow
              key={item.appId}
              item={item}
              shareScheme={shareScheme ?? null}
              copied={copied === item.appId}
              {...(openCounts?.[item.appId] === undefined ? {} : { counts: openCounts[item.appId] })}
              {...(openFeedback?.[item.appId] === undefined ? {} : { windowOutcome: openFeedback[item.appId] })}
              {...(onCopyLink === undefined ? {} : { onCopyLink })}
              {...(onOpenDetail === undefined ? {} : { onOpenDetail })}
              {...(onOpenResult === undefined ? {} : { onOpenResult })}
              {...(onOpenFailure === undefined ? {} : { onOpenFailure })}
              {...(onPublishNewVersion === undefined ? {} : { onPublishNewVersion })}
              {...(onSetPublished === undefined ? {} : { onSetPublished })}
              {...(onDelete === undefined ? {} : { onDelete })}
              {...(onDiagnostics === undefined ? {} : { onDiagnostics })}
              {...(onReleases === undefined ? {} : { onReleases })}
            />
          ))}
        </div>
      )}
      {state.kind === 'ready' && remaining > 0 && onShowMore !== undefined && (
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: 12 }}>
          <PanelButton variant="secondary" size="md" className="pico-app-center-show-more" onClick={onShowMore}>
            {tCount('appCenter.showMore', remaining)}
          </PanelButton>
        </div>
      )}
    </>
  )
}

/**
 * 目录工具条（§19 Q1）：搜索框 + 「我发布的」开关 + 清空。
 *
 * 搜索框是**受控**的（值来自面板 state）：目录可能有一百行，把 query 放在工具条里会
 * 让"筛选条件"与"渲染结果"分属两个组件，测试也就只能测其中一个。
 * @param props - 当前筛选与变更回调。
 */
export function CatalogToolbar({ filter, onFilterChange }: {
  filter: CatalogFilter
  onFilterChange?: (next: CatalogFilter) => void
}) {
  const disabled = onFilterChange === undefined
  return (
    <div style={{ ...PANEL_TOOLBAR, marginBottom: 14 }} data-role="catalog-toolbar">
      <input
        type="search"
        className="pico-app-center-search"
        style={PANEL_SEARCH}
        value={filter.query}
        placeholder={t('appCenter.searchPlaceholder')}
        aria-label={t('appCenter.search')}
        disabled={disabled}
        onChange={event => { onFilterChange?.({ ...filter, query: event.target.value }) }}
      />
      <label className="pico-checkchip">
        <input
          type="checkbox"
          className="pico-app-center-owned-only"
          checked={filter.ownedOnly}
          disabled={disabled}
          onChange={event => { onFilterChange?.({ ...filter, ownedOnly: event.target.checked }) }}
        />
        <span>{t('appCenter.ownedOnly')}</span>
      </label>
    </div>
  )
}

/**
 * 一次性引导卡（§7.2 冻结：应用是什么 / 怎么让 AI 做一个 / 怎么分享）。
 * @param props - 关闭回调（关闭后由面板写存储并收起）。
 */
export function OnboardingCard({ onDismiss }: { onDismiss: () => void }) {
  return (
    <Card style={CARD_BOX} className="pico-app-center-onboarding" data-role="catalog-onboarding" role="note">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <IconTile size={32} radius={10} tone="brand"><icons.IconInfo size={17} /></IconTile>
        <div style={{ flex: 1, minWidth: 0, fontSize: 13.5, fontWeight: 600 }} data-role="onboarding-title">
          {t('appCenter.onboarding.title')}
        </div>
        <PanelButton variant="ghost" size="sm" className="pico-app-center-onboarding-dismiss" onClick={onDismiss}>
          {t('appCenter.onboarding.dismiss')}
        </PanelButton>
      </div>
      <ul style={{ ...HINT_LIST, marginTop: 10, marginBottom: 0, color: 'var(--dsw-alias-label-secondary)' }} data-role="onboarding-points">
        <li>{t('appCenter.onboarding.what')}</li>
        <li>{t('appCenter.onboarding.build')}</li>
        <li>{t('appCenter.onboarding.share')}</li>
      </ul>
    </Card>
  )
}

/**
 * 应用详情视图（F16 的消费端 + 分享 + 应用 AI）。
 *
 * 三条口径：
 *  - **打开次数只显示服务端回传过的值**（`counts`；`undefined` ⇒ 这一行不渲染），
 *    并在旁边写出"平台记录打开次数用于运营"（§19 Q11）；
 *  - **分享入口只在拿到渠道 scheme 时渲染**（§19 Q6 的 fail-closed）；
 *  - **应用 AI** 挂在详情页（§21 的前端桥消费者），授权按用户×应用记。
 * @param props - 条目、渠道参数、计数、分享与 AI 的依赖与回调。
 */
export function AppDetailView({
  item, channel, counts, windowOutcome, copied, identity, aiDeps, aiConsentStore, dataDeps, onBack, onOpen, onCopyLink,
}: {
  item: AppCenterItem
  /** 渠道参数；`null` ⇒ 分享入口不渲染、产品名不显示。 */
  channel: AppChannel | null
  /** 今日打开计数；`undefined` ⇒ 不渲染"今日已被打开 N 次"。 */
  counts?: AppOpenCounts
  /** §5.2 的打开结果（新开 / 聚焦）；`undefined` ⇒ 不渲染这一行。 */
  windowOutcome?: OpenWindowOutcome
  /** 刚复制成功。 */
  copied?: boolean
  /** 应用 AI 的授权作用域（用户×服务端）。 */
  identity: string
  aiDeps?: AppAiDeps
  /** 应用 AI 的授权存储（缺省 `localStorage`）。 */
  aiConsentStore?: AppAiConsentStore | null
  /** 数据面板的可注入取数依赖（测试用；缺省走页面上下文的 fetch）。 */
  dataDeps?: RequestDeps
  onBack: () => void
  onOpen: () => Promise<PublishFailure | null>
  onCopyLink: () => Promise<boolean>
}) {
  const [opening, setOpening] = useState(false)
  const [failure, setFailure] = useState<PublishFailure | null>(null)
  const [copyFailed, setCopyFailed] = useState(false)
  const link = appShareLink(item.appId)
  return (
    <div className="pico-app-detail" data-role="app-detail" data-app-id={item.appId}>
      <PanelButton variant="ghost" size="sm" className="pico-app-center-back" icon={<icons.IconBack size={14} />} onClick={onBack}>
        {t('appCenter.backToCatalog')}
      </PanelButton>
      <h3 style={{ ...ROW_TITLE, whiteSpace: 'normal', marginTop: 8 }} data-role="detail-title">{item.title}</h3>
      {item.description !== '' && <p style={ROW_DESC} data-role="detail-description">{item.description}</p>}
      <p style={ROW_META}>
        <span data-role="detail-access" data-access={item.access}>{accessBadge(item.access)}</span>
        {item.responsible !== '' && <span>{` · ${t('appCenter.responsible')}: ${item.responsible}`}</span>}
        {item.currentVersion !== '' && (
          <span data-role="detail-version">{` · ${t('appCenter.currentVersion')}: ${item.currentVersion}`}</span>
        )}
      </p>

      {/*
        作者声明的窗口规格（F3/§6）。**只在服务端真的下发了 window 时**才显示：
        没拿到就什么都不说 —— 不写"比例已锁定"这种客户端无法兑现的话
        （锁定由窗口侧按同一份声明执行）。
      */}
      {item.window !== undefined && (
        <p style={ROW_META} data-role="detail-window">
          {item.window.ratio !== undefined && (
            <span data-role="window-ratio">{`${t('appCenter.windowRatioLabel')}: ${formatWindowRatio(item.window.ratio)}`}</span>
          )}
          {item.window.width !== undefined && item.window.height !== undefined && (
            <span data-role="window-size">
              {`${item.window.ratio === undefined ? '' : ' · '}${t('appCenter.windowSizeLabel')}: ${String(item.window.width)}×${String(item.window.height)}`}
            </span>
          )}
        </p>
      )}

      {windowOutcome !== undefined && (
        <p style={ROW_META} data-role="detail-open-outcome" data-window={windowOutcome}>
          {windowOutcome === 'opened' ? t('appCenter.openWindowOpened') : t('appCenter.openWindowFocused')}
        </p>
      )}

      {/* F16 消费端：计数只在服务端回传过之后出现（§19 Q11 的"今日已被打开 N 次"）。 */}
      {counts !== undefined && (
        <p style={ROW_META} data-role="detail-open-count">
          <span data-role="opens-today">{tCount('appCenter.opensToday', counts.todayPv)}</span>
          <span data-role="opens-privacy-note">{` · ${t('appCenter.privacyNote')}`}</span>
        </p>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        <PanelButton
          variant="primary"
          size="lg"
          className="pico-app-center-open"
          data-action="open-app"
          icon={<icons.IconExternal size={14} />}
          disabled={!item.enabled || opening}
          onClick={() => {
            setOpening(true)
            setFailure(null)
            void onOpen().then(result => { setFailure(result) }).finally(() => { setOpening(false) })
          }}
        >
          {opening ? t('appCenter.openOpening') : t('appCenter.open')}
        </PanelButton>
        {/* §19 Q6：未注入渠道 scheme ⇒ 不渲染（宁可少一行，也不给一条打不开的链接）。 */}
        {link !== null && (
          <PanelButton
            variant="secondary"
            size="lg"
            className="pico-app-center-copy-link"
            data-action="copy-link"
            icon={<icons.IconCopy size={14} />}
            aria-label={`${t('appCenter.copyLinkAria')} ${item.title}`}
            onClick={() => {
              setCopyFailed(false)
              void onCopyLink().then(ok => { if (!ok) setCopyFailed(true) })
            }}
          >
            {t('appCenter.copyLink')}
          </PanelButton>
        )}
      </div>
      {link !== null && (copied === true || copyFailed) && (
        <p style={ROW_META} data-role="copy-feedback" data-ok={copied === true ? 'true' : 'false'}>
          {copied === true ? `${t('appCenter.copied')}: ${link}` : t('appCenter.copyFailed')}
        </p>
      )}
      {channel !== null && channel.productName !== '' && (
        <p style={ROW_META} data-role="detail-product">{channel.productName}</p>
      )}
      {failure !== null && (
        <PublishErrorBlock failure={failure} title={t('appCenter.actionFailed')} role="lifecycle-error" />
      )}

      {/* 作者数据面（2026-09-21）：**只在发布者本人**的详情页渲染 ——
          服务端对非发布者一律 404（与"应用不存在"同形），界面上摆一个必然失败的入口
          只会让人以为"功能坏了"。
          `isOwner` 显式传进去（面板的 prop 是**必填**）：AI 读取数据的授权卡挂在
          这个面板里，而那是"默认关"的能力 —— 不允许出现"忘了传就默认可见"的形态。 */}
      {item.isOwner && (
        <DataBrowserPanel
          appId={item.appId}
          isOwner={item.isOwner}
          {...(dataDeps === undefined ? {} : { deps: dataDeps })}
        />
      )}

      <AppAiPanel
        appId={item.appId}
        userId={identity}
        {...(aiDeps === undefined ? {} : { deps: aiDeps })}
        {...(aiConsentStore === undefined ? {} : { store: aiConsentStore })}
      />
    </div>
  )
}

/**
 * 删除后的通知块：应用标识 + **服务端返回的**说明与保留天数。
 *
 * 保留期是服务端语义（`api/release.go:223-226`：R37 的"真删"由后台任务执行，当前未
 * 实现）—— 客户端不写死"90 天后自动删除"，那会变成一个系统没有做出的承诺。
 * @param props - 通知内容（来自 {@link DeleteOutcome}）。
 */
export function NoticeBlock({ notice }: { notice: CatalogNotice }) {
  return (
    <div style={NOTICE} data-role="catalog-notice" role="status">
      <div>{`${t('appCenter.appDeleted')}: ${notice.appId}`}</div>
      {notice.note !== '' && <div data-role="notice-note">{`${t('appCenter.appDeletedNote')}: ${notice.note}`}</div>}
      {notice.retentionDays !== undefined && (
        <div data-role="notice-retention">{`${t('appCenter.retentionDays')}: ${String(notice.retentionDays)}`}</div>
      )}
    </div>
  )
}

/** 目录行的动作条状态：没有确认、正在确认下架、正在确认删除。 */
type RowConfirm = 'none' | 'offline' | 'delete'

/** 诊断面板状态（关闭 / 读取中 / 报告 / 失败信封）。 */
type RowDiagnostics =
  | { kind: 'closed' }
  | { kind: 'loading' }
  | { kind: 'ready', report: DiagnosticsReport }
  | { kind: 'failed', failure: PublishFailure }

/**
 * 行内版本历史面板的状态机（R1-pm-3）。
 *
 * 与 {@link RowDiagnostics} 同形：`closed` 之外的三态都渲染出来，失败走
 * {@link PublishErrorBlock}（复用既有错误块，`code`/`message`/`details`/`hints`
 * 逐字段显示）—— "读不到理由"与"没有被拒理由"必须是两种可见的不同结果。
 */
type RowReleases =
  | { kind: 'closed' }
  | { kind: 'loading' }
  | { kind: 'ready', report: MyReleasesReport }
  | { kind: 'failed', failure: PublishFailure }

/**
 * 一行应用：名称 / 访问级别 / 当前版本 / 一句话说明 / 负责人 / 打开 /
 * （发布者本人）发新版 + 下架·上架 / **版本历史** / 诊断 / 删除。
 *
 * "打开"打的是**本机路由**（`POST /api/pico/wasm-apps/open`），成功即本机确认
 * `<本安装的 app scheme>://<app_id>/` 已就绪；失败把 reason 渲染成**可读原因**（未登录 /
 * 应用不存在 / **被管理员冻结**（只读快照，数据保留）/ 平台拒绝 / 协议未就绪 /
 * 本机证明缺失 各自可辨，见 {@link openFailureEnvelope}）。
 * 这里**没有**入口链接、也没有系统浏览器兜底（冻结契约 2026-09-19 §4.5/§5）。
 *
 * 下架的条目（`enabled=false`）**照常展示**并标出"已下架"，打开按钮禁用 ——
 * 直接从目录消失会让用户以为是自己看错了。下架状态下**"发新版"按钮仍然出现但被禁用**
 * 并附一句可见的原因（R1-uxc-1）：静默隐藏会让作者以为"这个应用不能发新版"，
 * 而真相是"发新版不会恢复访问，先上架"。
 *
 * 三个危险/管理动作的判据：
 *  - **下架与删除都要二次确认**（确认块里的按钮是真实 `<button>`，出现后自动获得焦点，
 *    键盘用户按 Enter 即可确认）；
 *  - **每个动作后用服务端返回的值更新行状态**（`app.enabled`，见 `handleSetPublished`）；
 *  - 失败把服务端信封的 `code`/`message`/`details`/`hints` 渲染出来（复用发布失败块）。
 *
 * 「版本历史」（R1-pm-3）是**只读**的第四个出口：审核开启后作者此前没有任何结论出口
 * （被拒理由写了没人读、版本号又永久占位），这一块把每版的 status / 被拒理由 /
 * 是否线上，以及"被拒后升版本号重发"的出路一并显示出来。
 *
 * @param props - 目录条目、发新版回调与作者生命周期回调。
 */
export function AppCenterRow({
  item, shareScheme, copied, counts, windowOutcome, onCopyLink, onOpenDetail, onOpenResult, onOpenFailure,
  onPublishNewVersion, onSetPublished, onDelete, onDiagnostics, onReleases,
}: {
  item: AppCenterItem
  /** 生效的渠道深链 scheme；`null`/缺席 ⇒ 不渲染「复制链接」（§19 Q6）。 */
  shareScheme?: string | null
  /** 刚复制成功。 */
  copied?: boolean
  /** F16 的今日打开计数（服务端回传过才有）。 */
  counts?: AppOpenCounts
  /** §5.2 的打开结果（新开 / 聚焦）；服务端没回传就没有。 */
  windowOutcome?: OpenWindowOutcome
  onCopyLink?: (item: AppCenterItem) => Promise<boolean>
  onOpenDetail?: (item: AppCenterItem) => void
  onOpenResult?: (item: AppCenterItem, counts: AppOpenCounts | undefined, window: OpenWindowOutcome | undefined) => void
  onOpenFailure?: (item: AppCenterItem, failure: OpenFailure) => void
  onPublishNewVersion?: (item: AppCenterItem) => void
  onSetPublished?: (item: AppCenterItem, enabled: boolean) => Promise<SetPublishedOutcome>
  onDelete?: (item: AppCenterItem) => Promise<DeleteOutcome>
  onDiagnostics?: (item: AppCenterItem) => Promise<DiagnosticsOutcome>
  onReleases?: (item: AppCenterItem) => Promise<ReleasesOutcome>
}) {
  const [opening, setOpening] = useState(false)
  const [confirm, setConfirm] = useState<RowConfirm>('none')
  const [busy, setBusy] = useState<null | 'set-published' | 'delete'>(null)
  const [actionFailure, setActionFailure] = useState<PublishFailure | null>(null)
  const [diagnostics, setDiagnostics] = useState<RowDiagnostics>({ kind: 'closed' })
  const [releases, setReleases] = useState<RowReleases>({ kind: 'closed' })
  const [copyFailed, setCopyFailed] = useState(false)
  const confirmRef = useRef<HTMLButtonElement | null>(null)
  // 分享链接在**渲染期**求值：`shareScheme` **缺席**（调用方没传）时读注入值，
  // 显式 `null`（调用方说"这个渠道没有 scheme"）时**不回落**；两者都拿不到 ⇒
  // `null` ⇒ 按钮一个都不渲染（fail-closed 的判据只有这一条）。
  const shareLink = shareScheme === undefined ? appShareLink(item.appId) : appShareLink(item.appId, shareScheme)

  // 确认块出现后把焦点移进去：键盘用户按一次"下架"就能直接 Enter 确认（或 Esc 走开），
  // 不必再 Tab 找按钮。只在打开的那一刻做一次，之后的输入不被打断。
  useEffect(() => {
    if (confirm !== 'none') confirmRef.current?.focus()
  }, [confirm])

  /**
   * 确认块的键盘出口（2026-09-21 审计）。
   *
   * 确认块会声明成 `role="alertdialog" aria-modal="true"`，而面板装载器的 Esc 在检测到
   * 内层模态时会让位 —— 所以这里必须自己接住 Esc 取消，否则键盘用户失去唯一的取消途径。
   * 收起（取消/确认完成/失败后关闭）时把焦点还给触发它的按钮：此前焦点直接掉到 body，
   * 用户得从文档头重新 Tab 回来。
   */
  const confirmTriggerRef = useRef<HTMLElement | null>(null)
  const previousConfirm = useRef(confirm)
  useEffect(() => {
    if (confirm !== 'none') {
      const onKey = (event: KeyboardEvent): void => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        setConfirm('none')
      }
      window.addEventListener('keydown', onKey)
      return () => window.removeEventListener('keydown', onKey)
    }
    if (previousConfirm.current !== 'none') confirmTriggerRef.current?.focus()
    return undefined
  }, [confirm])
  useEffect(() => { previousConfirm.current = confirm }, [confirm])

  // 可打开 = 应用已上架。判据里**没有 URL 了**（2026-09-19）：应用只在客户端内以
  // `<本安装的 app scheme>://<app_id>/` 打开，入口链接这个字段已经从两侧契约里删除 —— 打开
  // 能力不再取决于"服务端有没有下发一个链接"，而是取决于本机路由能不能把它打开
  // （失败时把 reason 渲染成可读原因，见下面 openFailureEnvelope）。
  const openable = item.enabled
  const open = (): void => {
    if (!openable || opening) return
    setOpening(true)
    setActionFailure(null)
    void openAppEntry(item.appId)
      .then((result) => {
        // 成功 = 本机确认协议 URL 已就绪，内置浏览器正在加载它 —— 不需要客户端再做什么
        //（也没有系统浏览器兜底）。F16 的计数若随响应回来，交由面板记录并展示。
        if (!result.ok) {
          setActionFailure(openFailureEnvelope(result))
          // 面板需要知道"这次是未登录"（§19 Q4：记住它并在登录后自动继续）。
          onOpenFailure?.(item, result)
          return
        }
        onOpenResult?.(item, result.counts, result.window)
      })
      .finally(() => { setOpening(false) })
  }
  // "发新版"只给发布者本人（P1-3 的入口）：服务端 `ownedApp` 对非发布者一律 404，
  // 给别人一个必然失败的按钮不如不给。
  const canPublish = item.isOwner && onPublishNewVersion !== undefined
  const canManage = item.isOwner && (onSetPublished !== undefined || onDelete !== undefined || onDiagnostics !== undefined || onReleases !== undefined)
  const diagnosticsPanelId = `pico-app-center-diagnostics-${item.appId}`
  const releasesPanelId = `pico-app-center-releases-${item.appId}`

  /** 执行上下架：只认服务端返回的 `enabled`（回调里已写回行状态）。 */
  const runSetPublished = async (enabled: boolean): Promise<void> => {
    if (onSetPublished === undefined) return
    setBusy('set-published')
    setActionFailure(null)
    const result = await onSetPublished(item, enabled)
    setBusy(null)
    setConfirm('none')
    if (!result.ok) setActionFailure(result)
  }

  /** 执行删除：只有服务端确认 `deleted` 才收掉确认块（行由面板收掉）。 */
  const runDelete = async (): Promise<void> => {
    if (onDelete === undefined) return
    setBusy('delete')
    setActionFailure(null)
    const result = await onDelete(item)
    setBusy(null)
    if (!result.ok) { setActionFailure(result); return }
    setConfirm('none')
  }

  /**
   * 诊断开关（`aria-expanded` 与面板同步；失败也留在原地显示信封）。
   *
   * 迟到响应必须丢弃（2026-09-21 审计）：先点开再点收起时，先发的那次请求仍在飞，
   * 落地后会把已收起的块重新 `ready` —— 用户看到"面板自己又冒出来了"。
   * 用每资源一个序号，只有最后一次请求的结论可以落地（同 `DataBrowserPanel` 的口径）。
   */
  const diagnosticsSeq = useRef(0)
  const toggleDiagnostics = async (): Promise<void> => {
    if (diagnostics.kind !== 'closed') { diagnosticsSeq.current += 1; setDiagnostics({ kind: 'closed' }); return }
    if (onDiagnostics === undefined) return
    const seq = ++diagnosticsSeq.current
    setDiagnostics({ kind: 'loading' })
    const result = await onDiagnostics(item)
    if (seq !== diagnosticsSeq.current) return
    setDiagnostics(result.ok ? { kind: 'ready', report: result } : { kind: 'failed', failure: result })
  }

  /**
   * 版本历史开关（R1-pm-3）。
   *
   * 每次打开都**重新取一次**（与诊断同口径）：审核结论是别的会话（管理员）改的，
   * 缓存一份"我上次看到的结论"会让作者在一个已经通过的版本上继续等。
   */
  const releasesSeq = useRef(0)
  const toggleReleases = async (): Promise<void> => {
    if (releases.kind !== 'closed') { releasesSeq.current += 1; setReleases({ kind: 'closed' }); return }
    if (onReleases === undefined) return
    const seq = ++releasesSeq.current
    setReleases({ kind: 'loading' })
    const result = await onReleases(item)
    if (seq !== releasesSeq.current) return
    setReleases(result.ok ? { kind: 'ready', report: result } : { kind: 'failed', failure: result })
  }

  return (
    <Card interactive muted={!item.enabled} style={CARD} className="pico-app-center-card">
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 11, minWidth: 0 }}>
        <IconTile
          size={40}
          radius={12}
          tone={!item.enabled ? 'neutral' : item.access === 'whitelist' ? 'warn' : 'brand'}
          label={item.title.slice(0, 1)}
        />
        <div style={ROW_MAIN}>
          <div style={TITLE_ROW}>
            {/* 标题即详情入口（真实 button：键盘可达，也不再需要单独一行"详情"链接）。 */}
            {onOpenDetail === undefined
              ? <h3 style={ROW_TITLE} title={item.title}>{item.title}</h3>
              : (
                  <button
                    type="button"
                    className="pico-app-center-detail"
                    data-action="open-detail"
                    style={{ ...ROW_TITLE, border: 'none', background: 'transparent', padding: 0, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left', maxWidth: '100%' }}
                    title={item.title}
                    aria-label={`${t('appCenter.detailAria')} ${item.title}`}
                    onClick={() => { onOpenDetail(item) }}
                  >
                    {item.title}
                  </button>
                )}
            <span className="pico-app-center-access" data-role="access-level" data-access={item.access} style={{ display: 'inline-flex' }}>
              <Chip tone={accessTone(item.access)}>{accessBadge(item.access)}</Chip>
            </span>
            {!item.enabled && (
              <span className="pico-app-center-disabled" data-role="app-disabled" style={{ display: 'inline-flex' }}>
                <Chip tone="neutral" plain>{t('appCenter.disabled')}</Chip>
              </span>
            )}
          </div>
          {item.description !== '' && (
            <p style={ROW_DESC} className="pico-clamp-2" title={item.description}>{item.description}</p>
          )}
          <p style={ROW_META}>
            {/* 当前版本（P1-4）：发新版前必须能看见它 —— 新版本号要严格大于它。 */}
            {item.currentVersion !== '' && (
              <span className="pico-app-center-current-version" data-role="current-version">
                {`${t('appCenter.currentVersion')}: ${item.currentVersion}`}
              </span>
            )}
            {item.currentVersion !== '' && <span>{' · '}</span>}
            {item.responsible !== '' && <span>{`${t('appCenter.responsible')}: ${item.responsible}`}</span>}
            {/* F16 的消费端：服务端回传过计数才显示（不编造、也不用别处的数字凑）。 */}
            {counts !== undefined && (
              <span className="pico-app-center-open-count" data-role="open-count">
                {` · ${tCount('appCenter.opensToday', counts.todayPv)}`}
              </span>
            )}
            {/* 2026-09-19：这里原来显示"入口链接"（服务端下发的 entry_url）。字段已从
                两侧契约删除 —— 应用没有可贴进浏览器的地址，唯一的分享形态是渠道深链
                （目录行的「复制链接」与发布成功块，见 §19 Q6）。 */}
          </p>
        </div>
      </div>
      {windowOutcome !== undefined && (
        <p style={ROW_META} data-role="open-outcome" data-window={windowOutcome}>
          {windowOutcome === 'opened' ? t('appCenter.openWindowOpened') : t('appCenter.openWindowFocused')}
        </p>
      )}

      {canPublish && !item.enabled && (
        <p
          style={{ ...ROW_META, whiteSpace: 'normal', overflow: 'visible', textOverflow: 'clip' }}
          data-role="publish-new-disabled-reason"
        >
          {t('appCenter.publishNewDisabled')}
        </p>
      )}

      {/* 复制结果的即时反馈（成功给链接原文，失败给"手动复制"这条出路）。 */}
      {shareLink !== null && (copied === true || copyFailed) && (
        <p style={ROW_META} data-role="copy-feedback" data-ok={copied === true ? 'true' : 'false'}>
          {copied === true ? `${t('appCenter.copied')}: ${shareLink}` : t('appCenter.copyFailed')}
        </p>
      )}


      {(canManage || canPublish) && (
        <div style={ACTIONS} data-role="row-actions">
          {canPublish && (
            <PanelButton
              variant="ghost"
              size="sm"
              className="pico-app-center-publish-new"
              data-action="publish-new-version"
              icon={<icons.IconPlus size={13} />}
              // 下架状态下**保留按钮但禁用**：发新版不会恢复访问（仍是 410 Gone），
              // 让作者白等一次上传再看到"已生效"是最坏的组合（R1-uxc-1）。
              disabled={!item.enabled}
              aria-disabled={!item.enabled}
              aria-label={`${t('appCenter.publishNewVersionAria')} ${item.title}`}
              onClick={() => { onPublishNewVersion?.(item) }}
            >
              {t('appCenter.publishNewVersion')}
            </PanelButton>
          )}
          {onSetPublished !== undefined && (
            item.enabled
              ? (
                  <PanelButton
                    variant="danger"
                    size="sm"
                    className="pico-app-center-take-offline"
                    data-action="take-offline"
                    disabled={busy !== null}
                    aria-label={`${t('appCenter.takeOfflineAria')} ${item.title}`}
                    onClick={(event) => { confirmTriggerRef.current = event.currentTarget; setActionFailure(null); setConfirm('offline') }}
                  >
                    {t('appCenter.takeOffline')}
                  </PanelButton>
                )
              : (
                  <PanelButton
                    variant="ghost"
                    size="sm"
                    className="pico-app-center-bring-online"
                    data-action="bring-online"
                    disabled={busy !== null}
                    aria-label={`${t('appCenter.bringOnlineAria')} ${item.title}`}
                    onClick={() => { void runSetPublished(true) }}
                  >
                    {t('appCenter.bringOnline')}
                  </PanelButton>
                )
          )}
          {onDiagnostics !== undefined && (
            <PanelButton
              variant="ghost"
              size="sm"
              className="pico-app-center-diagnostics-toggle"
              data-action="diagnostics"
              aria-label={`${t('appCenter.diagnosticsAria')} ${item.title}`}
              aria-expanded={diagnostics.kind !== 'closed'}
              aria-controls={diagnosticsPanelId}
              onClick={() => { void toggleDiagnostics() }}
            >
              {t('appCenter.diagnostics')}
            </PanelButton>
          )}
          {/* 版本历史（R1-pm-3）：审核开启后作者唯一的结论出口 —— 被拒理由、
              待审状态与"线上是哪一版"都在这一块里。 */}
          {onReleases !== undefined && (
            <PanelButton
              variant="ghost"
              size="sm"
              className="pico-app-center-releases-toggle"
              data-action="releases"
              aria-label={`${t('appCenter.releasesAria')} ${item.title}`}
              aria-expanded={releases.kind !== 'closed'}
              aria-controls={releasesPanelId}
              onClick={() => { void toggleReleases() }}
            >
              {t('appCenter.releases')}
            </PanelButton>
          )}
          {onDelete !== undefined && (
            <PanelButton
              variant="danger"
              size="sm"
              className="pico-app-center-delete"
              data-action="delete"
              disabled={busy !== null}
              aria-label={`${t('appCenter.deleteAria')} ${item.title}`}
              onClick={(event) => { confirmTriggerRef.current = event.currentTarget; setActionFailure(null); setConfirm('delete') }}
            >
              {t('appCenter.deleteApp')}
            </PanelButton>
          )}
        </div>
      )}

      {/* 主操作条：**必须排在作者动作之后** —— 它带 `marginTop:auto` 贴卡片底部，
          排在前面时"有作者动作"的卡片会把主按钮顶高一整行，同一行卡片的主按钮
          参差不齐（网格截图实测）。 */}
      <div style={CARD_FOOT}>
        <PanelButton
          variant="primary"
          size="md"
          // 稳定钩子（自动化与真机探针用）：打开走本机路由，失败在行内显示可读原因。
          data-action="open-app"
          className="pico-app-center-open"
          icon={<icons.IconExternal size={14} />}
          onClick={open}
          disabled={!openable || opening}
          aria-label={`${t('appCenter.openAria')} ${item.title}`}
          style={{ flex: 1 }}
        >
          {/* §19 Q12 的客户端侧反馈：请求在途时按钮自己说"正在打开…"，
              不让用户以为点了没反应（窗口骨架屏在 L2）。 */}
          {opening ? t('appCenter.openOpening') : t('appCenter.open')}
        </PanelButton>
        {/* 分享（F6/§19 Q6）：只在拿到渠道 scheme 时渲染；未拿到时这一行彻底不存在。 */}
        {shareLink !== null && onCopyLink !== undefined && (
          <PanelButton
            variant="secondary"
            size="md"
            className="pico-app-center-copy-link"
            data-action="copy-link"
            icon={<icons.IconCopy size={14} />}
            aria-label={`${t('appCenter.copyLinkAria')} ${item.title}`}
            onClick={() => {
              setCopyFailed(false)
              void onCopyLink(item).then(ok => { if (!ok) setCopyFailed(true) })
            }}
          >
            {t('appCenter.copyLink')}
          </PanelButton>
        )}
      </div>
      {confirm === 'offline' && (
        <div style={CONFIRM} data-role="confirm-take-offline" role="alertdialog" aria-modal="true" aria-label={t('appCenter.takeOfflineConfirm')}>
          <div data-role="confirm-message">{t('appCenter.takeOfflineConfirm')}</div>
          <div style={CONFIRM_ROW}>
            <PanelButton
              variant="danger"
              size="sm"
              ref={confirmRef}
              className="pico-app-center-confirm-take-offline"
              data-action="confirm-take-offline"
              disabled={busy !== null}
              onClick={() => { void runSetPublished(false) }}
            >
              {t('appCenter.takeOfflineConfirmAction')}
            </PanelButton>
            <PanelButton
              variant="secondary"
              size="sm"
              className="pico-app-center-confirm-cancel"
              data-action="cancel-confirm"
              disabled={busy !== null}
              onClick={() => { setConfirm('none') }}
            >
              {t('appCenter.confirmCancel')}
            </PanelButton>
          </div>
        </div>
      )}

      {confirm === 'delete' && (
        <div style={CONFIRM} data-role="confirm-delete" role="alertdialog" aria-modal="true" aria-label={t('appCenter.deleteConfirm')}>
          <div data-role="confirm-message">{t('appCenter.deleteConfirm')}</div>
          <div style={CONFIRM_ROW}>
            <PanelButton
              variant="danger"
              size="sm"
              ref={confirmRef}
              className="pico-app-center-confirm-delete"
              data-action="confirm-delete"
              disabled={busy !== null}
              onClick={() => { void runDelete() }}
            >
              {t('appCenter.deleteConfirmAction')}
            </PanelButton>
            <PanelButton
              variant="secondary"
              size="sm"
              className="pico-app-center-confirm-cancel"
              data-action="cancel-confirm"
              disabled={busy !== null}
              onClick={() => { setConfirm('none') }}
            >
              {t('appCenter.confirmCancel')}
            </PanelButton>
          </div>
        </div>
      )}

      {actionFailure !== null && (
        <PublishErrorBlock failure={actionFailure} title={t('appCenter.actionFailed')} role="lifecycle-error" />
      )}

      {diagnostics.kind !== 'closed' && (
        <div style={DIAGNOSTICS} id={diagnosticsPanelId} data-role="diagnostics">
          {diagnostics.kind === 'loading' && <div>{t('appCenter.diagnosticsLoading')}</div>}
          {diagnostics.kind === 'failed' && (
            <PublishErrorBlock failure={diagnostics.failure} title={t('appCenter.actionFailed')} role="diagnostics-error" />
          )}
          {diagnostics.kind === 'ready' && <DiagnosticsBlock report={diagnostics.report} />}
        </div>
      )}

      {releases.kind !== 'closed' && (
        <div style={RELEASES} id={releasesPanelId} data-role="releases">
          {releases.kind === 'loading' && <div data-role="releases-loading">{t('appCenter.releasesLoading')}</div>}
          {/* 读失败必须与"没有被拒"区分开：走既有错误块，信封逐字段显示。 */}
          {releases.kind === 'failed' && (
            <PublishErrorBlock failure={releases.failure} title={t('appCenter.releasesFailed')} role="releases-error" />
          )}
          {releases.kind === 'ready' && <ReleasesBlock report={releases.report} />}
        </div>
      )}
    </Card>
  )
}

/**
 * 版本历史（只读）：每版的版本号 / 状态 / 是否线上 / 提交时间，以及**被拒理由**与
 * 「被拒后升版本号重发」的出路（R1-pm-3）。
 *
 * 三条口径：
 *  - **理由只在 rejected 行显示**（服务端 approved/pending 行的 reason 恒为空串）：
 *    把空串渲染成"没有理由"的普通行，等于把"审核没给结论"与"审核给了理由"混成一件事；
 *  - **被拒必带出路**：被拒版本的版本号**永久占位**、不能复用，所以理由旁边永远跟着
 *    "用更高的版本号重新提交"这句话 —— 只说"被拒了"等于把作者留在原地；
 *  - **状态未知就原样显示**（`releaseStatusLabel`），不假装认识服务端的新状态。
 * @param props - 服务端版本历史报告。
 */
export function ReleasesBlock({ report }: { report: MyReleasesReport }) {
  return (
    <div className="pico-app-center-releases">
      <div data-role="releases-summary">
        {`${t('appCenter.currentVersion')}: ${report.currentVersion === '' ? '—' : report.currentVersion}`}
        {` · ${t('appCenter.versionLabel')}: ${String(report.releases.length)}`}
      </div>
      {report.releases.length === 0
        ? <div data-role="releases-empty">{t('appCenter.releasesEmpty')}</div>
        : (
            <ul style={HINT_LIST} data-role="releases-list">
              {report.releases.map(release => (
                <li key={release.version} data-role="release" data-version={release.version} data-status={release.status}>
                  <span data-role="release-version">{`v${release.version}`}</span>
                  {` · ${releaseStatusLabel(release.status)}`}
                  {release.current && (
                    <span data-role="release-current">{` · ${t('appCenter.releaseCurrent')}`}</span>
                  )}
                  {release.createdAt !== '' && <span data-role="release-created">{` · ${release.createdAt}`}</span>}
                  {release.status === 'pending' && (
                    <div data-role="release-pending-hint">{t('appCenter.releasePendingHint')}</div>
                  )}
                  {release.status === 'rejected' && (
                    <div style={REJECTION} data-role="release-rejection">
                      <div data-role="release-reason">
                        {`${t('appCenter.releaseReason')}: ${release.reason === '' ? t('appCenter.releaseReasonMissing') : release.reason}`}
                      </div>
                      {/* 出路：理由 + 这一句才构成"作者能自己往前走"的闭环。 */}
                      <div data-role="release-resubmit-hint">{t('appCenter.releaseResubmitHint')}</div>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
    </div>
  )
}

/**
 * 诊断报告（只读）：窗口 / 调用总数 / 失败数 / 最近失败（含 `reason_code`）/ hints。
 *
 * 只显示服务端给的东西：客户端**不**在这里算"有没有问题"（R1-pm-16 的教训是诊断口径
 * 必须与服务端一致 —— 每个访客都被余额不足挡住时服务端会显示 0 失败，
 * 客户端再自己推一个结论只会制造第二套真相）。
 * @param props - 服务端诊断报告。
 */
export function DiagnosticsBlock({ report }: { report: DiagnosticsReport }) {
  return (
    <div className="pico-app-center-diagnostics">
      <div data-role="diagnostics-summary">
        {`${t('appCenter.diagnosticsWindow')}: ${String(report.windowMinutes)}`}
        {` · ${t('appCenter.diagnosticsCalls')}: ${String(report.total)}`}
        {` · ${t('appCenter.diagnosticsFailed')}: ${String(report.failed)}`}
      </div>
      <div style={{ marginTop: 6 }}>{`${t('appCenter.diagnosticsRecentFailures')}:`}</div>
      {report.failures.length === 0
        ? <div data-role="diagnostics-empty">{t('appCenter.diagnosticsNoFailures')}</div>
        : (
            <ul style={HINT_LIST} data-role="diagnostics-failures">
              {report.failures.map((failure, index) => (
                <li key={`${failure.reasonCode}:${failure.createdAt}:${String(index)}`} data-role="diagnostics-failure">
                  {`${t('appCenter.diagnosticsReasonCode')}: ${failure.reasonCode === '' ? '-' : failure.reasonCode}`}
                  {` · ${t('appCenter.diagnosticsOutcome')}: ${failure.outcome}`}
                  {failure.createdAt !== '' && ` · ${failure.createdAt}`}
                </li>
              ))}
            </ul>
          )}
      {report.hints.length > 0 && (
        <>
          <div style={{ marginTop: 6 }}>{`${t('appCenter.diagnosticsHints')}:`}</div>
          <ul style={HINT_LIST} data-role="diagnostics-hints">
            {report.hints.map(hint => <li key={hint}>{hint}</li>)}
          </ul>
        </>
      )}
    </div>
  )
}
