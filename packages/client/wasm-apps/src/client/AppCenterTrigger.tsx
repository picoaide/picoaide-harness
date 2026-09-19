import { useEffect, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { AppCenterPanel } from './AppCenterPanel.tsx'
import { AppToastHost } from './app-toast.tsx'
import { t } from './locales.ts'

/**
 * 侧边栏底部的**应用中心入口**（R34 的"真实可达"入口）。
 *
 * 挂载点选 `sidebar.footer.action`：这是本仓所有"用户能点到的功能面板"的统一
 * 位置（能力中心、内置浏览器、账号卡、计划任务都在这里），槽位由上游
 * `ui-sidebar` 渲染、`wide` 属性告诉我们当前是宽栏还是窄轨 —— 换句话说，
 * 它不需要在自带布局里再找位置，也不会被任何 CSS 隐藏（守卫测试断言
 * 渲染结果是真正的 `<button type="button">` 且带可见文案）。
 *
 * 面板互斥：与能力中心/浏览器共用 `dsh-panel-activate` 事件（打开一个就关掉
 * 兄弟面板），避免两个模态叠在一起。
 *
 * @module @picoaide/dsh-wasm-apps/client/AppCenterTrigger
 */

const TRIGGER_WIDE: React.CSSProperties = {
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: 'calc(100% + 8px)',
  height: 34,
  margin: '4px -4px 4px',
  padding: '6px 2px 6px 10px',
  boxSizing: 'border-box',
  border: 'none',
  borderRadius: 12,
  background: 'transparent',
  cursor: 'pointer',
  overflow: 'hidden',
  color: 'var(--dsw-alias-label-primary)',
  fontFamily: 'inherit',
  fontSize: 14,
  lineHeight: '22px',
}

const TRIGGER_RAIL: React.CSSProperties = {
  ...TRIGGER_WIDE,
  width: 36,
  height: 36,
  margin: '8px 0 10px',
  justifyContent: 'center',
  gap: 0,
  padding: 0,
  borderRadius: '50%',
}

const LABEL: React.CSSProperties = { overflow: 'hidden', whiteSpace: 'nowrap' }

/** 跨插件面板激活事件（与 capability-center / cron / browser 共用）。 */
const ACTIVATE_EVENT = 'dsh-panel-activate'
const PANEL_NAME = 'wasm-app-center'

/**
 * Sidebar foot action opening the App Center. Opening this panel evicts sibling
 * panels through the shared activation event; a sibling activation closes it.
 * @param props - sidebar column state from the foot slot owner.
 */
export function AppCenterTrigger(props: PropsRuntime<'sidebar.footer.action'>) {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const onOtherActivate = (event: Event): void => {
      if ((event as CustomEvent).detail !== PANEL_NAME) setOpen(false)
    }
    document.addEventListener(ACTIVATE_EVENT, onOtherActivate)
    return () => { document.removeEventListener(ACTIVATE_EVENT, onOtherActivate) }
  }, [])

  const openPanel = (): void => {
    if (open) return
    setOpen(true)
    document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: PANEL_NAME }))
  }

  return (
    <>
      <button
        type="button"
        className="pico-app-center-trigger"
        data-panel={PANEL_NAME}
        style={props.wide ? TRIGGER_WIDE : TRIGGER_RAIL}
        aria-expanded={open}
        aria-label={t('appCenter.title')}
        title={t('appCenter.title')}
        onClick={openPanel}
      >
        <svg width={props.wide ? 16 : 18} height={props.wide ? 16 : 18} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <rect x="1.8" y="1.8" width="5.4" height="5.4" rx="1.4" stroke="currentColor" strokeWidth="1.3"/>
          <rect x="8.8" y="1.8" width="5.4" height="5.4" rx="1.4" stroke="currentColor" strokeWidth="1.3"/>
          <rect x="1.8" y="8.8" width="5.4" height="5.4" rx="1.4" stroke="currentColor" strokeWidth="1.3"/>
          <rect x="8.8" y="8.8" width="5.4" height="5.4" rx="1.4" stroke="currentColor" strokeWidth="1.3"/>
        </svg>
        {props.wide && <span style={LABEL}>{t('appCenter.title')}</span>}
      </button>
      {/* 主窗口 toast 的挂载点：侧边栏入口在客户端 UI 存续期间一直挂着，
          因此异渠道深链的提示不依赖应用中心是否打开（§5.3 是"主窗口"级提示）。 */}
      <AppToastHost />
      {open && <AppCenterPanel onClose={() => { setOpen(false) }} />}
    </>
  )
}
