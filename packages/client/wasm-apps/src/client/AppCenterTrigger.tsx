import { AppToastHost } from './app-toast.tsx'
import { openAppCenterPanel } from './app-center-surface.tsx'
import { t } from './locales.ts'

/**
 * 侧边栏底部的**应用中心入口**（R34 的"真实可达"入口）。
 *
 * 挂载点选 `sidebar.footer.action`：这是本仓所有"用户能点到功能面板"的统一位置
 * （能力中心、内置浏览器、账号卡、计划任务都在这里），槽位由上游 `ui-sidebar`
 * 渲染、`wide` 属性告诉我们当前是宽栏还是窄轨 —— 换句话说，它不需要在自带布局里
 * 再找位置，也不会被任何 CSS 隐藏（守卫测试断言渲染结果是真正的
 * `<button type="button">` 且带可见文案）。
 *
 * 面板本身由 `app-center-surface.tsx` 在**插件启动时**挂一次（容器常驻中列），
 * 这里只负责一次点击 —— 不再自己持有 `open` 状态：把面板生命周期绑在侧边栏的
 * 槽位树上，等于"侧边栏一重排，打开着的面板就没了"。
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

/**
 * 侧边栏底部的应用中心触发按钮。
 * @param props - 侧边栏底部槽位给出的列宽状态。
 */
export function AppCenterTrigger(props: { wide?: boolean }): JSX.Element {
  return (
    <>
      <button
        type="button"
        className="pico-app-center-trigger"
        data-panel="wasm-app-center"
        style={props.wide === true ? TRIGGER_WIDE : TRIGGER_RAIL}
        aria-label={t('appCenter.title')}
        title={t('appCenter.title')}
        onClick={openAppCenterPanel}
      >
        <svg width={props.wide === true ? 16 : 18} height={props.wide === true ? 16 : 18} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <rect x="1.8" y="1.8" width="5.4" height="5.4" rx="1.4" stroke="currentColor" strokeWidth="1.3"/>
          <rect x="8.8" y="1.8" width="5.4" height="5.4" rx="1.4" stroke="currentColor" strokeWidth="1.3"/>
          <rect x="1.8" y="8.8" width="5.4" height="5.4" rx="1.4" stroke="currentColor" strokeWidth="1.3"/>
          <rect x="8.8" y="8.8" width="5.4" height="5.4" rx="1.4" stroke="currentColor" strokeWidth="1.3"/>
        </svg>
        {props.wide === true && <span style={LABEL}>{t('appCenter.title')}</span>}
      </button>
      {/* 主窗口 toast 的挂载点：侧边栏入口在客户端 UI 存续期间一直挂着，
          因此异渠道深链的提示不依赖应用中心是否打开（§5.3 是"主窗口"级提示）。 */}
      <AppToastHost />
    </>
  )
}
