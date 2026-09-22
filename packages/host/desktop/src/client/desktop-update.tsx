import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
/** Desktop update badge and the shared client-side update snapshot store. */

import { useSyncExternalStore } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  DESKTOP_UPDATE_PATH,
  DESKTOP_UPDATE_CHECK_PATH,
  DESKTOP_UPDATE_INSTALL_PATH,
  type DesktopUpdateStateResponse,
} from '../desktop-update-contract.ts'
import { t } from './locales.ts'

/**
 * Poll interval for the Host update snapshot, ms.
 *
 * 一个窗口只允许**一条**轮询:侧边栏、设置「关于」与会话头部徽标都读同一份
 * 共享快照(见 `subscribeDesktopUpdate`)。此前三个组件各起一个 setInterval
 * (30s/30s/5s 混用),同一时刻能显示三种不同状态(2026-09-12 用户报"左上角
 * 和设置-关于不同步")。
 */
const UPDATE_POLL_MS = 5_000

/** Cross-plugin client service name for the shared update snapshot. */
export const DESKTOP_UPDATE_SERVICE = 'desktopUpdateService'

/** Runtime `fetch`-compatible request boundary (test seam). */
export type UpdateBadgeRequest = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

/** Default request boundary: the window's own fetch (same object as `globalThis.fetch`). */
function defaultUpdateRequest(): UpdateBadgeRequest {
  return globalThis.fetch.bind(globalThis)
}

/** Update action the surfaces trigger: install a downloaded installer or check again. */
export type DesktopUpdateAction = 'check' | 'install'

/** Shared client-side update snapshot other client plugins consume. */
export interface DesktopUpdateService {
  /** Observe snapshot changes; the first subscriber starts polling. */
  subscribe(listener: () => void): () => void
  /** Latest snapshot; the same reference until the snapshot actually changes. */
  read(): DesktopUpdateStateResponse | null
  /** Fetch the snapshot once, right now (used after the user acts). */
  refresh(): Promise<void>
  /** Trigger the action the current snapshot implies (install when ready, else check). */
  act(): Promise<void>
}

let snapshot: DesktopUpdateStateResponse | null = null
let pollTimer: ReturnType<typeof setInterval> | undefined
let requestInFlight: Promise<void> | undefined
let actionInFlight: Promise<void> | undefined
const listeners = new Set<() => void>()

/**
 * Publish one snapshot and notify subscribers.
 *
 * 相同的快照不触发通知:轮询每 5 秒来一次,而状态绝大多数时间是同一条,
 * 每次都通知会让三个订阅面各重渲染一次。
 * @param next - snapshot read from the Host route.
 */
function publish(next: DesktopUpdateStateResponse): void {
  if (snapshot !== null && sameUpdateState(snapshot, next)) return
  snapshot = next
  for (const listener of [...listeners]) listener()
}

function sameUpdateState(left: DesktopUpdateStateResponse, right: DesktopUpdateStateResponse): boolean {
  return left.availableVersion === right.availableVersion
    && left.downloadingVersion === right.downloadingVersion
    && left.isPackaged === right.isPackaged
    && left.canDownload === right.canDownload
    && left.currentVersion === right.currentVersion
    && left.readyVersion === right.readyVersion
    && left.readyPath === right.readyPath
    && left.retryAttempt === right.retryAttempt
    && left.retryDelayMs === right.retryDelayMs
    && left.lastError === right.lastError
    && left.downloadProgress?.receivedBytes === right.downloadProgress?.receivedBytes
    && left.downloadProgress?.totalBytes === right.downloadProgress?.totalBytes
}

/** Fetch the live Host update snapshot once. */
export async function refreshDesktopUpdate(
  request: UpdateBadgeRequest = defaultUpdateRequest(),
): Promise<void> {
  requestInFlight ??= (async () => {
    try {
      const response = await request(DESKTOP_UPDATE_PATH, {
        method: 'GET',
        headers: { accept: 'application/json' },
        cache: 'no-store',
      })
      if (!response.ok) return
      const value: unknown = await response.json()
      // 路由不可用(兼容模式)时保持上一次快照;结构不符同样不覆盖好数据。
      if (isUpdateState(value)) publish(value)
    } catch {
      // 本机路由取不到不是更新失败:保持上一次快照,下一次轮询再试。
    } finally {
      requestInFlight = undefined
    }
  })()
  return requestInFlight
}

/** 当前快照暗示的动作:已下载好就安装,否则再检查一次。 */
export function updateActionFor(state: DesktopUpdateStateResponse | null): DesktopUpdateAction {
  return state?.readyVersion === undefined ? 'check' : 'install'
}

/**
 * 触发一次更新动作并立刻刷新快照。
 *
 * 两个面(侧边栏指示器、设置「关于」按钮)共用这一份实现:动作与路由的对应
 * 关系只有一个真源,不会出现"一处点了检查、另一处点了安装"。
 * @param action - explicit action, or omit to derive it from the current snapshot.
 * @param request - request boundary (test seam).
 */
export async function triggerDesktopUpdateAction(
  action?: DesktopUpdateAction,
  request: UpdateBadgeRequest = defaultUpdateRequest(),
): Promise<void> {
  const resolved = action ?? updateActionFor(snapshot)
  actionInFlight ??= (async () => {
    try {
      await request(resolved === 'install' ? DESKTOP_UPDATE_INSTALL_PATH : DESKTOP_UPDATE_CHECK_PATH, {
        method: 'POST',
        headers: { accept: 'application/json' },
      })
    } catch {
      // 触发失败静默:下面的 refresh 会把真实状态带回来。
    } finally {
      actionInFlight = undefined
    }
    // 立刻取一次:宿主是异步执行的,这一取通常能看到"检查中/下载中"的中间态。
    await refreshDesktopUpdate(request)
  })()
  return actionInFlight
}

/** 立即刷新一次:窗口回到前台/重新聚焦时用(见 `subscribeDesktopUpdate`)。 */
function refreshWhenVisible(): void {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
  void refreshDesktopUpdate()
}

/** 订阅期间挂在 window/document 上的即时刷新监听(只挂一份)。 */
let foregroundListenersInstalled = false

function installForegroundListeners(): void {
  if (foregroundListenersInstalled) return
  if (typeof document === 'undefined' || typeof window === 'undefined') return
  foregroundListenersInstalled = true
  document.addEventListener('visibilitychange', refreshWhenVisible)
  window.addEventListener('focus', refreshWhenVisible)
}

function removeForegroundListeners(): void {
  if (!foregroundListenersInstalled) return
  foregroundListenersInstalled = false
  document.removeEventListener('visibilitychange', refreshWhenVisible)
  window.removeEventListener('focus', refreshWhenVisible)
}

/**
 * Subscribe to the shared snapshot; polling runs only while someone listens.
 *
 * 5 秒轮询之外还挂 `visibilitychange`/`focus` 即时刷新:窗口切到后台时
 * Chromium 会把主窗口的定时器节流到 ≥1 次/分钟(主窗口没有关 `backgroundThrottling`),
 * 用户切回来时若不补取一次,进度/状态会停在几十秒前的旧值。
 */
export function subscribeDesktopUpdate(listener: () => void): () => void {
  listeners.add(listener)
  if (pollTimer === undefined) {
    void refreshDesktopUpdate()
    installForegroundListeners()
    pollTimer = setInterval(() => { void refreshDesktopUpdate() }, UPDATE_POLL_MS)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && pollTimer !== undefined) {
      clearInterval(pollTimer)
      pollTimer = undefined
      removeForegroundListeners()
    }
  }
}

/** Latest snapshot (stable reference between changes). */
export function readDesktopUpdate(): DesktopUpdateStateResponse | null {
  return snapshot
}

/** Shared update snapshot as a React hook (one poller per window). */
export function useDesktopUpdateState(): DesktopUpdateStateResponse | null {
  return useSyncExternalStore(subscribeDesktopUpdate, readDesktopUpdate, () => null)
}

/** Client service handed to sibling client plugins through `ctx.provide`. */
export const desktopUpdateService: DesktopUpdateService = {
  subscribe: subscribeDesktopUpdate,
  read: readDesktopUpdate,
  refresh: () => refreshDesktopUpdate(),
  act: () => triggerDesktopUpdateAction(),
}

/** Backwards-compatible single-shot fetch used by older call sites and tests. */
export async function fetchDesktopUpdateState(
  request: UpdateBadgeRequest = defaultUpdateRequest(),
): Promise<DesktopUpdateStateResponse | null> {
  try {
    const response = await request(DESKTOP_UPDATE_PATH, {
      method: 'GET',
      headers: { accept: 'application/json' },
      cache: 'no-store',
    })
    if (!response.ok) return null
    const value: unknown = await response.json()
    return isUpdateState(value) ? value : null
  } catch {
    return null
  }
}

function isUpdateState(value: unknown): value is DesktopUpdateStateResponse {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.isPackaged === 'boolean'
    && typeof record.canDownload === 'boolean'
    && typeof record.currentVersion === 'string'
    && (record.availableVersion === undefined || typeof record.availableVersion === 'string')
    && (record.downloadingVersion === undefined || typeof record.downloadingVersion === 'string')
}

/** Ask the Host to run the user-visible manual check (same flow as the tray command). */
export async function triggerDesktopUpdateCheck(
  request: UpdateBadgeRequest = defaultUpdateRequest(),
): Promise<boolean> {
  try {
    const response = await request(DESKTOP_UPDATE_CHECK_PATH, {
      method: 'POST',
      headers: { accept: 'application/json' },
    })
    return response.ok
  } catch {
    return false
  }
}

/**
 * Register the session-header update badge (right-aligned utilities seat).
 * The badge appears only when an update is available, downloading, or ready;
 * it hides itself when the Host reports no pending update.
 * @param ctx - browser Cordis context.
 */
export function applyUpdateBadge(ctx: ClientContext): void {
  ctx.effect(
    () => ctx.slots.inject(
      'conversation.session.header.utilities',
      () => ctx.slots.register({
        name: 'conversation.session.header.utilities',
        id: 'desktop-update-badge',
        order: 10,
      }, DesktopUpdateBadge),
    ),
    'desktop: session-header update badge',
  )
}

/** Full utilities seat props (owner passes nothing; the badge is self-sufficient). */
type DesktopUpdateBadgeProps = PropsRuntime<'conversation.session.header.utilities'>

/** Everything the header badge renders for one snapshot (`null` = render nothing). */
export interface DesktopUpdateBadgeView {
  /** `data-state` for styling: available / downloading / ready. */
  readonly state: 'available' | 'downloading' | 'ready'
  /** Button text. */
  readonly label: string
  /** Hover text; carries the retry attempt and countdown while downloading. */
  readonly title: string
}

/**
 * 下载进度的显示文本(与 enterprise 侧 `progressPercent` **同语义**;
 * 跨包对拍见 `packages/host/enterprise/tests/update-progress-parity.spec.ts`)。
 *
 * 完成语义(2026-09 缺陷修正):
 * - `receivedBytes >= totalBytes` ⇒ **`100%`** —— "下载完成"必须有唯一的数值表达,
 *   此前公式是单向封顶 `Math.min(99, …)`,整条链路里"100%"根本不存在;
 * - 未达之前最多 99%;
 * - `totalBytes` 未知(清单没给 size 且响应无 content-length)或非正数 ⇒
 *   显示**已下载字节数**(如 `12.3 MB`),不显示一个假百分比;
 * - 没有下载中的版本 / 没有进度快照 ⇒ undefined(调用方不渲染进度)。
 * @param state - 最新更新快照,或首轮轮询前的 null。
 * @returns 进度文本,或 undefined 表示当前没有可显示的进度。
 */
export function updateProgressPercent(state: DesktopUpdateStateResponse | null): string | undefined {
  const progress = state?.downloadProgress
  if (state?.downloadingVersion === undefined || progress === undefined) return undefined
  return downloadProgressText(progress)
}

/** 一段字节进度的文本(纯函数)。 */
function downloadProgressText(
  progress: { readonly receivedBytes: number, readonly totalBytes: number | undefined },
): string {
  const received = Number.isFinite(progress.receivedBytes) ? Math.max(0, progress.receivedBytes) : 0
  const total = progress.totalBytes
  if (total === undefined || !Number.isFinite(total) || total <= 0) return formatByteCount(received)
  if (received >= total) return '100%'
  return `${String(Math.min(99, Math.floor((received / total) * 100)))}%`
}

/**
 * 已下载字节数的人类可读文本。
 *
 * 单位(`B`/`KB`/`MB`/`GB`/`TB`)与中文/英文无关,所以两个展示面可以逐字相同,
 * 不必为此新增字典条目。
 * @param bytes - non-negative byte count.
 * @returns e.g. `812 B`, `12.3 MB`, `1.5 GB`.
 */
function formatByteCount(bytes: number): string {
  if (bytes < 1024) return `${String(Math.round(bytes))} B`
  const units = ['KB', 'MB', 'GB', 'TB'] as const
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const rounded = value >= 100 ? String(Math.round(value)) : value.toFixed(1)
  return `${rounded} ${units[unit] as string}`
}

/**
 * 徽标显示内容(纯函数,便于钉住三态与重试文案)。
 * @param state - latest update snapshot, or null before the first poll.
 * @returns what to render, or null when nothing is pending.
 */
export function desktopUpdateBadgeView(state: DesktopUpdateStateResponse | null): DesktopUpdateBadgeView | null {
  if (state === null || !state.canDownload) return null
  const available = state.availableVersion
  const downloading = state.downloadingVersion
  const ready = state.readyVersion
  if (available === undefined && downloading === undefined && ready === undefined) return null

  const percent = updateProgressPercent(state)

  if (ready !== undefined) {
    return {
      state: 'ready',
      label: t('update.install', { version: ready }),
      title: t('update.installTitle', { version: ready }),
    }
  }
  if (downloading !== undefined) {
    return {
      state: 'downloading',
      label: `${downloading}${percent !== undefined ? ` ${percent}` : ''}`,
      title: downloadingRetryTitle(state) ?? t('update.downloadingTitle', { version: downloading }),
    }
  }
  return {
    state: 'available',
    label: available ?? '',
    title: t('update.availableTitle', { version: available ?? '' }),
  }
}

/** 下载阶段的说明文字:重试等待中要显示"第几次 / 还有多久"。 */
function downloadingRetryTitle(state: DesktopUpdateStateResponse): string | undefined {
  if (state.retryAttempt <= 1 && state.retryDelayMs === 0) return undefined
  const attempt = `${String(state.retryAttempt)}/${String(state.retryMaxAttempts)}`
  return state.retryDelayMs > 0
    ? t('update.retryingIn', { attempt, seconds: String(Math.ceil(state.retryDelayMs / 1000)) })
    : t('update.retryingNow', { attempt })
}

/** Right-aligned badge: newest pending update state, click to check/download/install. */
export function DesktopUpdateBadge(_props: DesktopUpdateBadgeProps): JSX.Element | null {
  const view = desktopUpdateBadgeView(useDesktopUpdateState())
  if (view === null) return null

  return (
    <button
      type="button"
      className="dshDesktopUpdateBadge"
      data-state={view.state}
      title={view.title}
      onClick={() => { void triggerDesktopUpdateAction() }}
    >
      <span className="dshDesktopUpdateBadgeDot" aria-hidden="true" />
      {view.label}
    </button>
  )
}

/**
 * Register the shared snapshot store and expose it to sibling client plugins.
 *
 * Sibling client plugins (the enterprise sidebar indicator and settings
 * 「关于」) reach the snapshot through `ctx.get('desktopUpdateService')` — the
 * cross-package client import ban means they cannot import this module, so the
 * service name and the snapshot contract are the seam. The contract module
 * (`desktop-update-contract.ts`) stays import-free for that reason.
 * @param ctx - browser Cordis context.
 */
export function applyUpdateStore(ctx: ClientContext): void {
  ctx.provide(DESKTOP_UPDATE_SERVICE, desktopUpdateService)
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Shared desktop update snapshot provided by the desktop client half. */
    desktopUpdateService: DesktopUpdateService
  }
}

/** Test-only teardown: drop subscribers and the poller between cases. */
export function resetDesktopUpdateStoreForTests(): void {
  listeners.clear()
  if (pollTimer !== undefined) clearInterval(pollTimer)
  pollTimer = undefined
  removeForegroundListeners()
  snapshot = null
  requestInFlight = undefined
  actionInFlight = undefined
}

export type { DesktopUpdateStateResponse }
