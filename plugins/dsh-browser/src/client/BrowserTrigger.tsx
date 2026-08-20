import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { t } from './locales.ts'

const TRIGGER_STYLE: React.CSSProperties = {
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
  ...TRIGGER_STYLE,
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
 * Sidebar foot action waking the dedicated browser window. The browser lives
 * in its own OS window (created on first agent open); the sidebar button
 * shows it again after a user close. The window itself carries the tab strip
 * and control buttons; no modal panel is rendered in the main window.
 * @param props - sidebar column state from the foot slot owner.
 */
export function BrowserTrigger(props: PropsRuntime<'sidebar.footer.action'>) {
  const wake = (): void => {
    void fetch('/api/pico/browser/show', { method: 'POST' }).catch(() => {})
  }

  return (
    <button
      type="button"
      className="pico-browser-trigger"
      style={props.wide ? TRIGGER_STYLE : TRIGGER_RAIL}
      onClick={wake}
      title={t('panel.title')}
    >
      <svg width={props.wide ? 16 : 18} height={props.wide ? 16 : 18} viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.3"/>
        <circle cx="8" cy="8" r="2.4" stroke="currentColor" strokeWidth="1.3"/>
        <path d="M8 1.8v2.4M8 11.8v2.4M1.8 8h2.4M11.8 8h2.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
      </svg>
      {props.wide && <span style={LABEL}>{t('panel.title')}</span>}
    </button>
  )
}
