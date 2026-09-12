/** Sidebar version-area update indicator: reads the window's shared update snapshot. */

import { createElement, useCallback, useSyncExternalStore } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'

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
export type UpdateErrorCategory =
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

/** 已下载待安装的版本(没有则为 undefined)。 */
export function readyVersionOf(state: UpdateState | null): string | undefined {
  return state?.readyVersion
}

/** 下载进度百分比文本(无进度信息时为 undefined)。 */
export function progressPercent(state: UpdateState | null): string | undefined {
  const progress = state?.downloadProgress
  if (state?.downloadingVersion === undefined || progress === undefined) return undefined
  return progress.totalBytes !== undefined && progress.totalBytes > 0
    ? `${Math.min(99, Math.floor((progress.receivedBytes / progress.totalBytes) * 100))}%`
    : undefined
}

/** 下载状态文本:重试等待中显示"第 n/N 次 + 倒计时",否则显示进度。 */
export function downloadingStatusText(state: UpdateState): string {
  const version = state.downloadingVersion ?? ''
  const attempt = state.retryAttempt ?? 0
  const max = state.retryMaxAttempts ?? 0
  const delay = state.retryDelayMs ?? 0
  const percent = progressPercent(state)
  if (delay > 0) {
    return `下载中断，${String(Math.ceil(delay / 1000))} 秒后重试（第 ${String(attempt)}/${String(max)} 次）…`
  }
  if (attempt > 1) {
    return `正在重试下载 ${version}（第 ${String(attempt)}/${String(max)} 次）${percent !== undefined ? ` ${percent}` : ''}…`
  }
  return `正在下载 ${version}…${percent !== undefined ? ` ${percent}` : ''}`
}

/** 「关于」页的状态行文案(与侧边栏指示器同源,不再各写一套判断)。 */
export function updateStatusText(state: UpdateState | null): string {
  if (state === null) return '已是最新版本'
  if (state.readyVersion !== undefined) return `新版本 ${state.readyVersion} 已下载，点击「安装更新」完成升级`
  if (state.downloadingVersion !== undefined) return downloadingStatusText(state)
  if (state.availableVersion !== undefined) return `发现新版本 ${state.availableVersion}，正在准备下载…`
  switch (state.lastError) {
    case 'not-signed-in':
      // 客户端只从它登录的那台服务端取更新:未登录就没有更新源。
      return '请先登录后再检查更新'
    case 'network':
      return '检查更新失败：网络不可达（已自动重试），请稍后再试'
    case 'release-missing':
      return '检查更新失败：最新版本缺少可下载安装包'
    case 'checksum-mismatch':
      return '更新下载失败：安装包校验不一致（已自动重试），请稍后再试'
    case 'invalid-artifact':
      return '更新下载失败：安装包格式不正确，请联系管理员'
    case 'server-unavailable':
      // 服务端连得上、清单也拿到了,只是它推不出安全的对外地址:
      // 这是部署配置问题(需管理员配 PICOAI_PUBLIC_BASE_URL 或反代的
      // X-Forwarded-Proto),不能显示成"已是最新"把故障藏起来。
      return '检查更新失败：服务端未配置对外可用的 https 地址，请联系管理员'
    case 'unsupported':
      return '当前平台不支持自动更新'
    default:
      return '已是最新版本'
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
    ? `可安装 ${ready}`
    : downloading !== undefined
      ? `${downloading}${percent !== undefined ? ` ${percent}` : ''}`
      : available ?? ''
  const color = ready !== undefined ? '#16a34a' : downloading !== undefined ? '#f59e0b' : '#3b82f6'
  const title = ready !== undefined
    ? `新版本 ${ready} 已下载，点击安装`
    : downloading !== undefined
      ? downloadingStatusText(snapshot)
      : `新版本 ${available ?? ''} 可用，点击检查更新`

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
        color: 'var(--dsw-alias-fg-primary, #000000)',
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
      },
    }),
    label,
  )
}

/** 「关于」页按钮文案:检查更新 / 安装更新 / 下载中。 */
export function updateActionLabel(state: UpdateState | null, checking: boolean): string {
  if (checking) return '检查中…'
  if (state?.readyVersion !== undefined) return '安装更新'
  if (state?.downloadingVersion !== undefined) return '下载中…'
  return '检查更新'
}

/** 按钮是否应禁用(下载中或已在检查)。 */
export function updateActionDisabled(state: UpdateState | null, checking: boolean): boolean {
  return checking || state?.downloadingVersion !== undefined
}

/** Test seam: re-resolve the service after a test swaps the client context. */
export function resetUpdateServiceForTests(): void {
  clientContext = undefined
  resolvedService = undefined
}

/** 供测试注入替身服务(生产路径只走 applyUpdateService)。 */
export function setUpdateServiceForTests(service: DesktopUpdateService | undefined): void {
  resolvedService = service
  clientContext = undefined
}
