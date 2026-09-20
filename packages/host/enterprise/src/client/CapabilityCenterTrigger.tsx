import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { openCapabilityCenter } from './capability-surface.tsx'
import { t } from './locales.ts'

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
 * 侧边栏底部的「能力中心」入口（技能 / 智能体的统一入口，取代旧的技能中心与
 * 智能体分享入口，决策 2026-08-25）。
 *
 * 面板本身由 `capability-surface.tsx` 在**插件启动时**挂一次（容器常驻中列），
 * 这里只负责一次点击 —— 不再自己持有 `open` 状态：面板的生命周期绑在侧边栏槽位树
 * 上时，窄轨/宽栏切换会让打开着的面板消失。
 * @param props - 侧边栏底部槽位给出的列宽状态。
 */
export function CapabilityCenterTrigger(props: PropsRuntime<'sidebar.footer.action'>) {
  return (
    <button
      type="button"
      className="pico-skill-trigger"
      style={props.wide ? TRIGGER_WIDE : TRIGGER_RAIL}
      aria-label={t('capability.title')}
      onClick={openCapabilityCenter}
    >
      <svg width={props.wide ? 16 : 18} height={props.wide ? 16 : 18} viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <rect x="2" y="2" width="12" height="12" rx="2.5" stroke="currentColor" strokeWidth="1.3"/>
        <path d="M5 5h6M5 8h6M5 11h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
      </svg>
      {props.wide && <span style={LABEL}>{t('capability.title')}</span>}
    </button>
  )
}
