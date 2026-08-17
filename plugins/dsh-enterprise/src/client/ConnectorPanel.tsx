import { ConnectorsList } from '@picoaide/dsh-connectors/client'

const OVERLAY: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 1000,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
}

const MASK: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  background: 'var(--dsw-alias-bg-mask-1)',
  backdropFilter: 'var(--dsw-mask-blur)',
}

const PANEL: React.CSSProperties = {
  position: 'relative',
  zIndex: 1,
  display: 'flex',
  flexDirection: 'column',
  width: 900,
  maxWidth: 'calc(100vw - 48px)',
  height: 'min(680px, calc(100vh - 48px))',
  borderRadius: 24,
  overflow: 'hidden',
  background: 'var(--dsw-alias-bg-layer-2)',
  boxShadow: 'var(--dsw-shadow-lv3)',
}

const HEADER: React.CSSProperties = {
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  height: 54,
  boxSizing: 'border-box',
  padding: '14px 18px',
}

const TITLE: React.CSSProperties = { margin: 0, fontSize: 16, lineHeight: 24, fontWeight: 500, color: 'var(--dsw-alias-label-primary)' }

const CLOSE: React.CSSProperties = {
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  color: 'var(--dsw-alias-label-caption)',
  fontSize: 13,
  padding: '4px 8px',
  borderRadius: 6,
}

const BODY: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  padding: 24,
}

/**
 * Connector center modal: the registered connectors with their auth flows
 * (the connectors plugin's client half renders the list).
 * @param props.onClose - close the modal.
 */
export function ConnectorPanel({ onClose }: { onClose: () => void }) {
  return (
    <div style={OVERLAY} role="presentation">
      <div style={MASK} aria-hidden="true" onClick={onClose} />
      <div style={PANEL} role="dialog" aria-modal="true" aria-label="连接器">
        <div style={HEADER}>
          <h2 style={TITLE}>连接器</h2>
          <button type="button" style={CLOSE} onClick={onClose}>关闭</button>
        </div>
        <div style={BODY}><ConnectorsList /></div>
      </div>
    </div>
  )
}
