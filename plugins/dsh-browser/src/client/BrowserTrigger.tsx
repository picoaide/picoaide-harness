import { useEffect, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { BrowserPanel } from './BrowserPanel.tsx'
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

/** Cross-plugin panel activation event (shared with cron/task/enterprise/connectors). */
const ACTIVATE_EVENT = 'dsh-panel-activate'
const PANEL_NAME = 'browser-center'

/**
 * Sidebar foot action opening the embedded browser modal. Opening this panel
 * evicts sibling panels via the shared activation event; a sibling activation
 * closes this panel.
 * @param props - sidebar column state from the foot slot owner.
 */
export function BrowserTrigger(props: PropsRuntime<'sidebar.footer.action'>) {
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
        className="pico-browser-trigger"
        style={props.wide ? TRIGGER_STYLE : TRIGGER_RAIL}
        aria-expanded={open}
        onClick={openPanel}
      >
        <svg width={props.wide ? 16 : 18} height={props.wide ? 16 : 18} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.3"/>
          <circle cx="8" cy="8" r="2.4" stroke="currentColor" strokeWidth="1.3"/>
          <path d="M8 1.8v2.4M8 11.8v2.4M1.8 8h2.4M11.8 8h2.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
        </svg>
        {props.wide && <span style={LABEL}>{t('panel.title')}</span>}
      </button>
      {open && <BrowserPanel onClose={() => { setOpen(false) }} />}
    </>
  )
}
