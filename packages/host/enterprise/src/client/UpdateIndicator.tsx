/** Sidebar version-area update indicator: reads the window's shared update snapshot. */

import { createElement, useCallback, useSyncExternalStore } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { t } from './locales.ts'

/**
 * 宿主更新快照。
 *
 * 与 `dsh-plugin-desktop` 的 `desktop-update-contract.ts` 同形,但**不 import**:
 * 跨包客户端 import 被禁止(两个 client bundle 各自独立加载),所以这里只按
 * 服务名取 `ctx.get('desktopUpdateService')` 并本地声明结构。
 */
export interface UpdateState {
  readonly availableVersion: string | undefined
  readonly downloadingVersion: string | undefined
  readonly downloadProgress?: { receivedBytes: number; totalBytes: number | undefined } | undefined
  readonly isPackaged: boolean
  readonly canDownload: boolean
  readonly currentVersion: string
  readonly readyVersion?: string | undefined
  readonly readyPath?: string | undefined
  readonly retryAttempt?: number | undefined
  readonly retryMaxAttempts?: number | undefined
  readonly retryDelayMs?: number | undefined
  readonly lastError?: UpdateErrorCategory | undefined
}

/** 失败类别(与宿主契约同集)。 */
type UpdateErrorCategory =
  | 'network'
  | 'not-signed-in'
  | 'release-missing'
  | 'server-unavailable'
  | 'unsupported'
  | 'checksum-mismatch'
  | 'invalid-artifact'

/** 窗口级共享更新快照服务(桌面 client 面提供)。 */
interface DesktopUpdateService {
  subscribe(listener: () => void): () => void
  read(): UpdateState | null
  refresh(): Promise<void>
  act(): Promise<void>
}

/**
 * 组装期登记的客户端上下文。
 *
 * hook 拿不到 ctx,而 `ctx.get()` 只对当前窗口有效;记下 ctx、**懒解析**服务:
 * 两个客户端的 apply 顺序取决于组装行序,组装期直接取可能取到"还没挂上"的空,
 * 而首次 subscribe/read 一定发生在整棵树挂载之后,那时服务必然已就位。
 */
let clientContext: ClientContext | undefined
/** 已解析到的服务(只缓存命中;没命中就下次再找)。 */
let resolvedService: DesktopUpdateService | undefined

/**
 * 组装期登记宿主上下文。
 *
 * 桌面组装一定有 `desktopUpdateService`;兼容模式(上游默认客户端)没有,
 * 此时所有更新展示面一律不渲染 —— 没有更新路由可问,比假装"已是最新"更诚实。
 * @param ctx - browser Cordis context.
 */
export function applyUpdateService(ctx: ClientContext): void {
  clientContext = ctx
}

function updateService(): DesktopUpdateService | undefined {
  if (resolvedService !== undefined) return resolvedService
  const found = clientContext?.get('desktopUpdateService') as DesktopUpdateService | undefined
  if (found !== undefined) resolvedService = found
  return found
}

/** 共享快照 hook:同一窗口内所有展示面读到同一份状态(服务缺失时恒为 null)。 */
export function useUpdateState(): UpdateState | null {
  const subscribe = useCallback((listener: () => void): (() => void) => {
    return updateService()?.subscribe(listener) ?? ((): void => { /* 无服务即无变化源 */ })
  }, [])
  const read = useCallback((): UpdateState | null => updateService()?.read() ?? null, [])
  return useSyncExternalStore(subscribe, read, () => null) as UpdateState | null
}

/**
 * 触发更新动作(未下载完 → 检查/下载;已下载好 → 安装)。
 * @returns 触发后刷新一次快照的 promise。
 */
export async function triggerUpdateAction(): Promise<void> {
  await updateService()?.act()
}

/**
 * 下载进度的显示文本(与 desktop 侧 `updateProgressPercent` **同语义**;
 * 跨包对拍见 tests/update-progress-parity.spec.ts)。
 *
 * 完成语义(2026-09 缺陷修正):
 * - `receivedBytes >= totalBytes` ⇒ **`100%`** —— "下载完成"必须有唯一的数值表达,
 *   此前公式是单向封顶 `Math.min(99, …)`,整条链路里"100%"根本不存在;
 * - 未达之前最多 99%;
 * - `totalBytes` 未知(清单没给 size 且响应无 content-length)或非正数 ⇒
 *   显示**已下载字节数**(如 `12.3 MB`),不显示一个假百分比;
 * - 没有下载中的版本 / 没有进度快照 ⇒ undefined(调用方不渲染进度)。
 * @param state - 共享快照。
 * @returns 进度文本,或 undefined 表示当前没有可显示的进度。
 */
export function progressPercent(state: UpdateState | null): string | undefined {
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

/** 下载状态文本:重试等待中显示"第 n/N 次 + 倒计时",否则显示进度。 */
export function downloadingStatusText(state: UpdateState): string {
  const version = state.downloadingVersion ?? ''
  const attempt = state.retryAttempt ?? 0
  const max = state.retryMaxAttempts ?? 0
  const delay = state.retryDelayMs ?? 0
  const percent = progressPercent(state)
  if (delay > 0) {
    return t('update.interrupted', { seconds: String(Math.ceil(delay / 1000)), attempt: String(attempt), max: String(max) })
  }
  if (attempt > 1) {
    return t('update.retrying', { version, attempt: String(attempt), max: String(max), percent: percent !== undefined ? ` ${percent}` : '' })
  }
  return t('update.downloading', { version, percent: percent !== undefined ? ` ${percent}` : '' })
}

/** 「关于」页的状态行文案(与侧边栏指示器同源,不再各写一套判断)。 */
export function updateStatusText(state: UpdateState | null): string {
  // A missing update service (compatibility mode / service not composed) is
  // not "up to date": saying so hides a broken update path.
  if (state === null) return t('update.serviceUnavailable')
  if (state.readyVersion !== undefined) return t('update.ready', { version: state.readyVersion })
  if (state.downloadingVersion !== undefined) return downloadingStatusText(state)
  if (state.availableVersion !== undefined) return t('update.available', { version: state.availableVersion })
  switch (state.lastError) {
    case 'not-signed-in':
      // 客户端只从它登录的那台服务端取更新:未登录就没有更新源。
      return t('update.notSignedIn')
    case 'network':
      return t('update.network')
    case 'release-missing':
      return t('update.releaseMissing')
    case 'checksum-mismatch':
      return t('update.checksumMismatch')
    case 'invalid-artifact':
      return t('update.invalidArtifact')
    case 'server-unavailable':
      // 服务端连得上、清单也拿到了,只是它推不出安全的对外地址:
      // 这是部署配置问题(需管理员配 PICOAI_PUBLIC_BASE_URL 或反代的
      // X-Forwarded-Proto),不能显示成"已是最新"把故障藏起来。
      return t('update.serverUnavailable')
    case 'unsupported':
      return t('update.unsupported')
    default:
      return t('update.upToDate')
  }
}

/** 侧边栏品牌版本号旁的更新提醒:蓝点(有新版本)/橙点(下载中)/绿点(可安装)。
 *  @param state - 共享快照(缺省自己订阅一份)。
 */
export function UpdateIndicator({ state }: { state?: UpdateState | null }): JSX.Element | null {
  const subscribed = useUpdateState()
  const snapshot = state === undefined ? subscribed : state
  if (snapshot === null) return null
  const available = snapshot.availableVersion
  const downloading = snapshot.downloadingVersion
  const ready = snapshot.readyVersion
  if (available === undefined && downloading === undefined && ready === undefined) return null
  if (!snapshot.canDownload) return null

  const percent = progressPercent(snapshot)
  const label = ready !== undefined
    ? t('update.readyShort', { version: ready })
    : downloading !== undefined
      ? `${downloading}${percent !== undefined ? ` ${percent}` : ''}`
      : available ?? ''
  // 状态色走会翻转的 token（2026-09-16 暗色审计）：原先写死的 #16a34a/#f59e0b/#3b82f6
  // 在亮色侧边栏上只有 2.06–3.15:1，'下载中'的琥珀点在亮色下几乎看不见。
  const color = ready !== undefined
    ? 'var(--dsw-alias-state-success-primary, #16a34a)'
    : downloading !== undefined
      ? 'var(--dsw-alias-state-warn-primary, #f59e0b)'
      : 'var(--dsw-alias-state-business-primary, #3b82f6)'
  const title = ready !== undefined
    ? t('update.readyTitle', { version: ready })
    : downloading !== undefined
      ? downloadingStatusText(snapshot)
      : t('update.availableTitle', { version: available ?? '' })

  return createElement(
    'button',
    {
      type: 'button',
      onClick: () => { void triggerUpdateAction() },
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        border: 'none',
        background: 'none',
        padding: 0,
        cursor: 'pointer',
        fontSize: 10,
        fontWeight: 600,
        lineHeight: 1,
        color: 'var(--dsw-alias-label-primary, #000000)',
        whiteSpace: 'nowrap',
      },
      title,
      'aria-label': title,
    },
    createElement('span', {
      'aria-hidden': true,
      style: {
        width: 6,
        height: 6,
        borderRadius: '50%',
        backgroundColor: color,
        // 6px 的点在浅底上只有 2–3:1：用一圈描边把边界补出来（跟随主题的 border token）。
        boxShadow: '0 0 0 1px var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1))',
      },
    }),
    label,
  )
}

/** 「关于」页按钮文案:检查更新 / 安装更新 / 下载中。 */
export function updateActionLabel(state: UpdateState | null, checking: boolean): string {
  if (checking) return t('update.checking')
  if (state?.readyVersion !== undefined) return t('update.install')
  if (state?.downloadingVersion !== undefined) return t('update.downloadingAction')
  return t('update.check')
}

/** 按钮是否应禁用(下载中或已在检查)。 */
export function updateActionDisabled(state: UpdateState | null, checking: boolean): boolean {
  // 2026-09-15 审计 P3：没有更新服务（state === null）时状态行写着"更新服务不可用"，
  // 按钮却仍可点、点了没有任何反应 —— 死按钮。服务缺席即禁用。
  if (state === null) return true
  return checking || state?.downloadingVersion !== undefined
}

