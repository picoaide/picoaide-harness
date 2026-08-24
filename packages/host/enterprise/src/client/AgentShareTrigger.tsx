import { useEffect, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { AgentSharePanel } from './AgentSharePanel.tsx'

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

/** Cross-plugin panel activation event (shared with the skill center). */
const ACTIVATE_EVENT = 'dsh-panel-activate'
const PANEL_NAME = 'agent-share'

/**
 * Sidebar foot action opening the shared-agent modal, stacked above the
 * Skill center trigger. Opening this panel evicts sibling panels via the
 * shared activation event; a sibling activation closes this panel.
 * @param props - sidebar column state from the foot slot owner.
 */
export function AgentShareTrigger(props: PropsRuntime<'sidebar.footer.action'>) {
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
        className="pico-skill-trigger"
        style={props.wide ? TRIGGER_WIDE : TRIGGER_RAIL}
        aria-expanded={open}
        onClick={openPanel}
      >
        <svg width={props.wide ? 16 : 18} height={props.wide ? 16 : 18} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="5" cy="8" r="2.4" stroke="currentColor" strokeWidth="1.3" />
          <circle cx="11" cy="4" r="2" stroke="currentColor" strokeWidth="1.3" />
          <circle cx="11" cy="12" r="2" stroke="currentColor" strokeWidth="1.3" />
          <path d="M7 7L9.5 5M7 9L9.5 11" stroke="currentColor" strokeWidth="1.3" />
        </svg>
        {props.wide && <span style={LABEL}>共享 Agent</span>}
      </button>
      {open && <AgentSharePanel onClose={() => { setOpen(false) }} />}
    </>
  )
}
