/** Settings "关于" row: installed version + update action with status/progress. */

import { createElement, useState } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { DEFAULT_CHANNEL } from '../channel-content.ts'
import { useChannel } from './channel-store.ts'
import {
  applyUpdateService,
  triggerUpdateAction,
  updateActionDisabled,
  updateActionLabel,
  updateStatusText,
  useUpdateState,
} from './UpdateIndicator.tsx'

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

/** 设置-关于区: 当前版本 + 检查/下载/安装。
 *  状态与侧边栏指示器读**同一份共享快照**(窗口级单轮询),两处不会再显示
 *  不同状态;按钮动作也走同一个服务(已下载好时那一下就是"安装")。 */
function UpdateSection(_props: PropsRuntime<'settings.section'>): JSX.Element {
  const state = useUpdateState()
  // 渠道内容(渠道构建下即渠道名):hooks 必须在组件顶层无条件调用。
  const channel = useChannel()
  const [checking, setChecking] = useState(false)

  const disabled = updateActionDisabled(state, checking)
  const status = updateStatusText(state)

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
        style: disabled ? BUTTON_DISABLED : BUTTON,
        disabled,
        onClick: () => {
          setChecking(true)
          // 已下载好时这一步就是"安装"(服务按当前快照分派),否则是重新检查。
          void triggerUpdateAction().finally(() => { setTimeout(() => setChecking(false), 1200) })
        },
      },
      updateActionLabel(state, checking),
    ),
  )
}

/** Register the update section under settings (below the account row). */
export function applyUpdateSection(ctx: ClientContext): void {
  // 组装期抓一次共享快照服务:设置页与侧边栏因此读同一份状态。
  applyUpdateService(ctx)
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
