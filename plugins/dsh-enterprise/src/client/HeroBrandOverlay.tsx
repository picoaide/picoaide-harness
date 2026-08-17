import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

const WRAPPER: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  pointerEvents: 'none',
  userSelect: 'none',
}

const TITLE: React.CSSProperties = {
  margin: 0,
  fontSize: 44,
  fontWeight: 700,
  letterSpacing: 0.5,
  color: '#e8eaf0',
}

const SUBTITLE: React.CSSProperties = {
  margin: 0,
  fontSize: 15,
  color: '#8a8f98',
}

/**
 * Brand the empty conversation hero: hide the upstream headline and preview
 * badge via injected CSS and paint the product name over the hero stage while
 * no session exists. The overlay layer is click-through, so it never blocks
 * the composer or workspace picker underneath.
 */
export function HeroBrandOverlay(props: PropsRuntime<'shell.overlay'>) {
  const sessionCount = props.useSessions(s => s.ids.length)
  if (sessionCount > 0) return null
  return (
    <div style={WRAPPER}>
      <p style={TITLE}>PicoAide Harness</p>
      <p style={SUBTITLE}>企业版</p>
    </div>
  )
}