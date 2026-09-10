/** Settings "关于" row: installed version + check-updates action with status/progress. */

import { createElement, useState } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { DEFAULT_CHANNEL } from '../channel-content.ts'
import { useChannel } from './channel-store.ts'
import { useUpdateState } from './UpdateIndicator.tsx'

const UPDATE_CHECK_ROUTE = '/api/pico/desktop/update/check'
const POLL_MS = 5_000

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

/** 设置-账号区: 当前版本 + 检查更新/下载进度/失败提示。
 *  复用 UpdateIndicator 的 useUpdateState(5s 轮询),消除同一路口两份订阅。 */
function UpdateSection(_props: PropsRuntime<'settings.section'>): JSX.Element {
  const state = useUpdateState(POLL_MS)
  // 渠道内容(渠道构建下即渠道名):hooks 必须在组件顶层无条件调用。
  const channel = useChannel()
  const [checking, setChecking] = useState(false)

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
      : lastError === 'not-signed-in'
        // 客户端只从它登录的那台服务端取更新:未登录就没有更新源。
        // 这不是网络故障,不能误导用户去排查网络(审计 2026-09-10)。
        ? '请先登录后再检查更新'
        : lastError === 'network'
          ? '检查更新失败：网络不可达，请检查网络后重试'
          : lastError === 'release-missing'
            ? '检查更新失败：最新版本缺少可下载安装包'
            : lastError === 'server-unavailable'
              // 服务端连得上、清单也拿到了,只是它推不出安全的对外地址:
              // 这是部署配置问题(需管理员配 PICOAI_PUBLIC_BASE_URL 或反代的
              // X-Forwarded-Proto),不能显示成"已是最新"把故障藏起来。
              ? '检查更新失败：服务端未配置对外可用的 https 地址，请联系管理员'
              : '已是最新版本'

  return createElement(
    'div',
    { style: ROW },
    createElement('p', { style: LABEL }, '关于'),
    // 「关于」里的产品名走渠道内容(渠道构建下即渠道名),不在文案里硬编码厂商名。
    createElement(
      'p',
      { style: VALUE },
      `${channel?.client?.display_name || DEFAULT_CHANNEL.client?.display_name || ''} v${state?.currentVersion ?? ''}`,
    ),
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
