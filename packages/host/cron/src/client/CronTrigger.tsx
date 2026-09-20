/**
 * 侧边栏底部的「定时任务」入口。
 *
 * 全局面板（root 作用域、不依赖会话）：点它把中列换成定时任务中心。面板的
 * 打开/关闭语义全在共享装载器里（`panel-mount.tsx`），这里**只负责一次点击** ——
 * 不再自己读写 html 激活属性（那是四个面板互斥关系的真源，只能有一份实现）。
 */
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { openCronPanel } from './panel-mount.tsx'
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
 * 侧边栏底部的定时任务触发按钮。
 * @param props - 侧边栏底部槽位给出的列宽状态。
 */
export function CronTrigger(props: PropsRuntime<'sidebar.footer.action'>): JSX.Element {
  return (
    <button
      type="button"
      aria-label={t('job.listTitle')}
      onClick={openCronPanel}
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
