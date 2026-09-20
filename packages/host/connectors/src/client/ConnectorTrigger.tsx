import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { openConnectorCenter } from './connector-surface.tsx'
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
 * 侧边栏底部的「连接器」入口。
 *
 * 面板本身由 `connector-surface.tsx` 在**插件启动时**挂一次（容器常驻中列），
 * 这里只负责一次点击。
 * @param props - 侧边栏底部槽位给出的列宽状态。
 */
export function ConnectorTrigger(props: PropsRuntime<'sidebar.footer.action'>) {
  return (
    <button
      type="button"
      className="pico-connector-trigger"
      style={props.wide ? TRIGGER_WIDE : TRIGGER_RAIL}
      aria-label={t('panel.title')}
      onClick={openConnectorCenter}
    >
      <svg width={props.wide ? 16 : 18} height={props.wide ? 16 : 18} viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <rect x="2.5" y="6.5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.3"/>
        <path d="M6 6.5V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v1.5M6 10.5h2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
      </svg>
      {props.wide && <span style={LABEL}>{t('panel.title')}</span>}
    </button>
  )
}
