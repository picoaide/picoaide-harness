/** Settings "关于" row: installed version + check-updates action with status/progress. */

import { createElement, useEffect, useState } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

const UPDATE_ROUTE = '/api/pico/desktop/update'
const UPDATE_CHECK_ROUTE = '/api/pico/desktop/update/check'
const POLL_MS = 5_000

interface UpdateState {
  readonly availableVersion: string | undefined
  readonly downloadingVersion: string | undefined
  readonly downloadProgress?: { receivedBytes: number; totalBytes: number | undefined } | undefined
  readonly isPackaged: boolean
  readonly canDownload: boolean
  readonly currentVersion: string
  readonly lastError?: 'network' | 'release-missing' | 'unsupported' | undefined
}

async function fetchUpdateState(): Promise<UpdateState | null> {
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

const ROW: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 8 }
const LABEL: React.CSSProperties = { fontSize: 13, margin: 0, color: 'var(--dsw-alias-label-caption)' }
const VALUE: React.CSSProperties = { fontSize: 15, margin: 0, fontWeight: 600 }
const BUTTON: React.CSSProperties = {
  marginTop: 8,
  padding: '8px 14px',
  borderRadius: 6,
  border: '1px solid var(--dsw-alias-state-error-primary)',
  background: 'transparent',
  color: 'var(--dsw-alias-state-error-primary)',
  fontSize: 13,
  cursor: 'pointer',
  alignSelf: 'flex-start',
}
const BUTTON_DISABLED: React.CSSProperties = { ...BUTTON, opacity: 0.6, cursor: 'default' }

/** 设置-账号区: 当前版本 + 检查更新/下载进度/失败提示。 */
export function UpdateSection(_props: PropsRuntime<'settings.section'>): JSX.Element {
  const [state, setState] = useState<UpdateState | null>(null)
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    let cancelled = false
    const poll = async (): Promise<void> => {
      const next = await fetchUpdateState()
      if (!cancelled) setState(next)
    }
    void poll()
    const timer = window.setInterval(() => { void poll() }, POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  const available = state?.availableVersion
  const downloading = state?.downloadingVersion
  const progress = state?.downloadProgress
  const percent = downloading !== undefined && progress !== undefined && progress.totalBytes !== undefined && progress.totalBytes > 0
    ? `${Math.min(99, Math.floor((progress.receivedBytes / progress.totalBytes) * 100))}%`
    : undefined
  const lastError = state?.lastError

  const status = downloading !== undefined
    ? `正在下载 ${downloading}…${percent !== undefined ? ` ${percent}` : ''}`
    : available !== undefined
      ? `发现新版本 ${available}，点击「检查更新」开始下载`
      : lastError === 'network'
        ? '检查更新失败：网络不可达，请检查网络后重试'
        : lastError === 'release-missing'
          ? '检查更新失败：最新版本缺少可下载安装包'
          : '已是最新版本'

  return createElement(
    'div',
    { style: ROW },
    createElement('p', { style: LABEL }, '关于'),
    createElement('p', { style: VALUE }, `PicoAide Harness v${state?.currentVersion ?? ''}`),
    createElement('p', { style: LABEL }, status),
    createElement(
      'button',
      {
        type: 'button',
        style: downloading !== undefined || checking ? BUTTON_DISABLED : BUTTON,
        disabled: downloading !== undefined || checking,
        onClick: () => {
          setChecking(true)
          void fetch(UPDATE_CHECK_ROUTE, { method: 'POST', headers: { accept: 'application/json' } })
            .finally(() => { setTimeout(() => setChecking(false), 1200) })
        },
      },
      checking ? '检查中…' : downloading !== undefined ? '下载中…' : available !== undefined ? '检查更新' : '检查更新',
    ),
  )
}

/** Register the update section under settings (below the account row). */
export function applyUpdateSection(ctx: ClientContext): void {
  ctx.effect(
    () => ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: 'update',
      order: 1000,
      label: '关于',
    }, UpdateSection)),
    'enterprise: settings update section',
  )
}
