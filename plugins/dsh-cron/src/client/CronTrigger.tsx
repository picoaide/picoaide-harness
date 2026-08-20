/**
 * Sidebar foot action opening the scheduled-job center in the main area
 * (registered into `sidebar.footer.action`, ordered before the connector
 * center). Global: root scope, no session dependency.
 */
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
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
  lineHeight: 22,
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

/** The main-area activation event shared by injected panels (task-board family protocol). */
const ACTIVATE_EVENT = 'dsh-panel-activate'
/** The html attribute this panel toggles (sibling panels remove it). */
export const CRON_ACTIVE_ATTR = 'data-dsh-cron-active'
/** The html attribute sibling injected panels toggle (removed when we open). */
const OTHER_ACTIVE_ATTR = 'data-dsh-task-active'

function isCronOpen(): boolean {
  return document.documentElement.hasAttribute(CRON_ACTIVE_ATTR)
}

/**
 * Sidebar foot trigger for the scheduled-job center.
 * @param props - sidebar column state from the foot slot owner.
 */
export function CronTrigger(props: PropsRuntime<'sidebar.footer.action'>): JSX.Element {
  const open = (): void => {
    if (isCronOpen()) return
    // Single-occupant main area: evict sibling panels (their html attribute
    // and their controller state) before activating.
    document.documentElement.removeAttribute(OTHER_ACTIVE_ATTR)
    document.documentElement.setAttribute(CRON_ACTIVE_ATTR, '')
    document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: 'cron' }))
  }
  return (
    <button
      type="button"
      aria-label={t('job.listTitle')}
      onClick={open}
      style={props.wide ? TRIGGER_WIDE : TRIGGER_RAIL}
    >
      <svg width={props.wide ? 16 : 18} height={props.wide ? 16 : 18} viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.3" />
        <path d="M8 4.5V8l2.2 1.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
      {props.wide && <span style={LABEL}>{t('job.listTitle')}</span>}
    </button>
  )
}
