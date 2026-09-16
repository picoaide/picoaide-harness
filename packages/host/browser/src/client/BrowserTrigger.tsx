import { useEffect, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { CONTROL_POLL_MS, NO_CONTROL_HINT, readControlHint, showsWaitingHint, type ControlHint } from './control-hint.ts'
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

/** 警示态配色：用户持有控制权、AI 已被挡住（2026-09-16）。 */
const WAITING_COLOR = '#d97706'

const LABEL: React.CSSProperties = { overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }

/** 警示圆点（窄栏 36px 也要看得见 —— 那里没有文字位）。 */
const WAITING_DOT: React.CSSProperties = {
  position: 'absolute',
  top: 4,
  right: 4,
  width: 7,
  height: 7,
  borderRadius: '50%',
  background: WAITING_COLOR,
  pointerEvents: 'none',
}

/**
 * Poll `/api/pico/browser/state` for the control hint.
 *
 * 读面是 GET（同源 + 回环 fence，无需写面证明），失败一律保留上一次结果——
 * 这个组件只做提示，绝不能因为宿主暂时不可用而影响侧边栏。
 * @returns 投影后的提示状态。
 */
function useControlHint(): ControlHint {
  const [hint, setHint] = useState<ControlHint>(NO_CONTROL_HINT)
  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = async (): Promise<void> => {
      try {
        const response = await fetch('/api/pico/browser/state')
        if (response.ok) {
          const next = readControlHint(await response.json() as unknown)
          if (!stopped) setHint(next)
        }
      } catch { /* keep the last known hint */ }
      if (!stopped) timer = setTimeout(() => { void read() }, CONTROL_POLL_MS)
    }
    void read()
    return () => {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [])
  return hint
}

/**
 * Sidebar foot action waking the dedicated browser window. The browser lives
 * in its own OS window, created HIDDEN at client start so the agent can drive
 * it in the background; the sidebar button shows that window, and a user close
 * only hides it. The window itself carries the tab strip
 * and control buttons; no modal panel is rendered in the main window.
 *
 * 2026-09-16：控制权交还按钮只在浏览器窗口里，用户回到聊天窗口就再也看不到
 * "AI 在等你" —— 这里补一个窗口外的可见提示（着色 + 圆点 + 文案 + tooltip）。
 * @param props - sidebar column state from the foot slot owner.
 */
export function BrowserTrigger(props: PropsRuntime<'sidebar.footer.action'>) {
  const hint = useControlHint()
  const waiting = showsWaitingHint(hint)

  const wake = (): void => {
    // 2026-09-15 审计 F6：这是写面（需持有性证明 cookie）。失败时旧实现静默吞掉，
    // 用户看到的正是"点了按钮没反应"，而主机日志与客户端控制台都不留痕。
    void fetch('/api/pico/browser/show', { method: 'POST' }).then(
      (response) => {
        if (!response.ok) console.warn('[pico-browser] show rejected', response.status)
      },
      (cause: unknown) => { console.warn('[pico-browser] show request failed', cause) },
    )
  }

  const base = props.wide ? TRIGGER_STYLE : TRIGGER_RAIL
  return (
    <button
      type="button"
      className="pico-browser-trigger"
      data-waiting={waiting ? 'true' : undefined}
      style={{ ...base, position: 'relative', ...(waiting ? { color: WAITING_COLOR } : null) }}
      onClick={wake}
      title={waiting ? t('panel.waiting') : t('panel.title')}
    >
      <svg width={props.wide ? 16 : 18} height={props.wide ? 16 : 18} viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.3"/>
        <circle cx="8" cy="8" r="2.4" stroke="currentColor" strokeWidth="1.3"/>
        <path d="M8 1.8v2.4M8 11.8v2.4M1.8 8h2.4M11.8 8h2.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
      </svg>
      {props.wide && <span style={LABEL}>{waiting ? t('panel.waitingShort') : t('panel.title')}</span>}
      {waiting && <span style={WAITING_DOT} aria-hidden="true" />}
    </button>
  )
}
