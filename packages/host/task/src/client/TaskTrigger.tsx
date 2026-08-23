/**
 * Sidebar foot action opening the task board in the main area (registered
 * into `sidebar.footer.action`, ordered between the cron entry and the
 * connector center). Global: root scope, no session dependency.
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

/** The main-area activation event shared by injected panels. */
const ACTIVATE_EVENT = 'dsh-panel-activate'
/** The html attribute this panel toggles. */
export const TASK_ACTIVE_ATTR = 'data-dsh-task-active'
/** Sibling panel attributes removed when this panel opens (cron, ssh). */
const OTHER_ACTIVE_ATTRS = ['data-dsh-cron-active', 'data-dsh-ssh-active']

function isTaskOpen(): boolean {
  return document.documentElement.hasAttribute(TASK_ACTIVE_ATTR)
}

/**
 * Sidebar foot trigger for the task board.
 * @param props - sidebar column state from the foot slot owner.
 */
export function TaskTrigger(props: PropsRuntime<'sidebar.footer.action'>): JSX.Element {
  const open = (): void => {
    if (isTaskOpen()) return
    // Single-occupant main area: evict sibling panels before activating.
    for (const attribute of OTHER_ACTIVE_ATTRS) document.documentElement.removeAttribute(attribute)
    document.documentElement.setAttribute(TASK_ACTIVE_ATTR, '')
    document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: 'task' }))
  }
  return (
    <button
      type="button"
      aria-label={t('entry.label')}
      onClick={open}
      style={props.wide ? TRIGGER_WIDE : TRIGGER_RAIL}
    >
      <svg width={props.wide ? 16 : 18} height={props.wide ? 16 : 18} viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <rect x="2" y="2.5" width="12" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
        <path d="M2 6.5h12M6.5 6.5v7" stroke="currentColor" strokeWidth="1.3" />
      </svg>
      {props.wide && <span style={LABEL}>{t('entry.label')}</span>}
    </button>
  )
}
