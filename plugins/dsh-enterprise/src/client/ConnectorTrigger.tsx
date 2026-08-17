import { useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { ConnectorPanel } from './ConnectorPanel.tsx'

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

/**
 * Sidebar foot action opening the connector center modal, stacked above the
 * Skill center and Settings triggers (registered into `sidebar.footer.action`).
 * @param props - sidebar column state from the foot slot owner.
 */
export function ConnectorTrigger(props: PropsRuntime<'sidebar.footer.action'>) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        className="pico-connector-trigger"
        style={props.wide ? TRIGGER_WIDE : TRIGGER_RAIL}
        aria-expanded={open}
        onClick={() => { setOpen(true) }}
      >
        <svg width={props.wide ? 16 : 18} height={props.wide ? 16 : 18} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <rect x="2.5" y="6.5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.3"/>
          <path d="M6 6.5V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v1.5M6 10.5h2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
        </svg>
        {props.wide && <span style={LABEL}>连接器</span>}
      </button>
      {open && <ConnectorPanel onClose={() => { setOpen(false) }} />}
    </>
  )
}
