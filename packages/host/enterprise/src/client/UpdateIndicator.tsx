/** Sidebar version-area update indicator: polls the Host update badge route. */

import { createElement, useEffect, useState } from 'react'

const UPDATE_ROUTE = '/api/pico/desktop/update'
const UPDATE_CHECK_ROUTE = '/api/pico/desktop/update/check'

/** 侧边栏轮询间隔(30s)。 */
export const SIDEBAR_UPDATE_POLL_MS = 30_000

interface UpdateState {
  readonly availableVersion: string | undefined
  readonly downloadingVersion: string | undefined
  readonly downloadProgress?: { receivedBytes: number; totalBytes: number | undefined } | undefined
  readonly isPackaged: boolean
  readonly canDownload: boolean
  readonly currentVersion: string
  readonly lastError?: 'network' | 'release-missing' | 'unsupported' | undefined
}

/** 拉取宿主更新快照(与设置「关于」页共用;2026-09-01 审计消除重复轮询)。 */
export async function fetchUpdateState(): Promise<UpdateState | null> {
  try {
    const res = await fetch(UPDATE_ROUTE, { method: 'GET', headers: { accept: 'application/json' }, cache: 'no-store' })
    if (!res.ok) return null
    const value: unknown = await res.json()
    if (typeof value !== 'object' || value === null) return null
    const record = value as Record<string, unknown>
    if (typeof record.isPackaged !== 'boolean' || typeof record.canDownload !== 'boolean') return null
    return value as UpdateState
  } catch {
    return null
  }
}

async function triggerCheck(): Promise<void> {
  try {
    await fetch(UPDATE_CHECK_ROUTE, { method: 'POST', headers: { accept: 'application/json' } })
  } catch {
    /* 检查失败静默;状态由轮询更新 */
  }
}

/** 侧边栏品牌版本号旁的更新提醒:蓝点 + 新版本号;点击触发检查/下载。
 *  共享 hook:侧边栏(默认 30s)与设置「关于」页(5s)经同一订阅源消费,
 *  避免同一端点两份独立 setInterval(2026-09-01 审计)。
 *  @param pollMs - 轮询间隔(毫秒);缺省 30s。 */
export function useUpdateState(pollMs: number = SIDEBAR_UPDATE_POLL_MS): UpdateState | null {
  const [state, setState] = useState<UpdateState | null>(null)
  useEffect(() => {
    let cancelled = false
    const poll = async (): Promise<void> => {
      const next = await fetchUpdateState()
      if (!cancelled) setState(next)
    }
    void poll()
    const timer = window.setInterval(() => { void poll() }, pollMs)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [pollMs])
  return state
}

/** 更新提醒按钮(品牌版本号右侧)。有可用更新/下载中才渲染。 */
export function UpdateIndicator({ state }: { state: UpdateState | null }): JSX.Element | null {
  if (state === null) return null
  const available = state.availableVersion
  const downloading = state.downloadingVersion
  if (available === undefined && downloading === undefined) return null
  if (!state.canDownload) return null

  const progress = state.downloadProgress
  const percent = progress !== undefined && progress.totalBytes !== undefined && progress.totalBytes > 0
    ? `${Math.min(99, Math.floor((progress.receivedBytes / progress.totalBytes) * 100))}%`
    : '…'

  return createElement(
    'button',
    {
      type: 'button',
      onClick: () => { void triggerCheck() },
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
      },
      title: downloading !== undefined
        ? `正在下载 ${downloading}…，点击重新检查`
        : `新版本 ${available} 可用，点击检查更新`,
      'aria-label': downloading !== undefined ? `download ${downloading} ${percent}` : `update available ${available ?? ''}`,
    },
    createElement('span', {
      'aria-hidden': true,
      style: {
        width: 6,
        height: 6,
        borderRadius: '50%',
        backgroundColor: downloading !== undefined ? '#f59e0b' : '#3b82f6',
      },
    }),
    downloading !== undefined ? `${downloading} ${percent}` : available,
  )
}
