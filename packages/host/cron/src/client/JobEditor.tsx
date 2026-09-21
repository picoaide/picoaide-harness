/**
 * Job editor dialog: name, cron expression (with presets + live validation),
 * project (workspace) picker, agent preset picker (from agentPresets.list),
 * permission picker, and the prompt text sent to the spawned agent session.
 * The only action kind is `agent`.
 */
import { useEffect, useRef, useState } from 'react'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { isValidCron, nextRunAtMs } from '../cron.ts'
import { isCronJobAction, type JobRecord, type NewJobInput } from '../jobs.ts'
import type { CronController } from './controller.ts'
import { styles } from './styles.ts'
import { t } from './locales.ts'
import { useWorkspaceOptions } from './workspace-select.ts'

const PRESETS: ReadonlyArray<{ cron: string; key: 'preset.daily9' | 'preset.hourly' | 'preset.tenMin' | 'preset.weeklyMon9' }> = [
  { cron: '0 9 * * *', key: 'preset.daily9' },
  { cron: '0 * * * *', key: 'preset.hourly' },
  { cron: '*/10 * * * *', key: 'preset.tenMin' },
  { cron: '0 9 * * 1', key: 'preset.weeklyMon9' },
]

/** One agent preset option from the deployment roster. */
interface AgentOption {
  id: string
  label: string
  broken?: string
}

/** Fetch the deployment agent-preset roster through the client api (soft). */
async function fetchAgentOptions(api?: ConnectionHandle['api']): Promise<AgentOption[]> {
  if (api === undefined) return []
  try {
    // The client fetch facade fills rpcId itself; the payload is `{}`.
    const response = await api.agentPresets.list({})
    if (!response.result.ok) return []
    return response.result.value.presets.map((preset: { id: string; name?: string; description?: string; broken?: string }) => ({
      id: preset.id,
      label: preset.name ?? preset.id,
      ...(preset.broken === undefined ? {} : { broken: preset.broken }),
    }))
  } catch {
    return []
  }
}

export function JobEditor({ controller, job, workspaces, api, onClose }: {
  controller: CronController
  job?: JobRecord
  workspaces?: IWorkspaces
  api?: ConnectionHandle['api']
  onClose: () => void
}): JSX.Element {
  const [name, setName] = useState(job?.name ?? '')
  const [cron, setCron] = useState(job?.cron ?? '0 9 * * *')
  const [prompt, setPrompt] = useState(job?.action.kind === 'agent' ? job.action.prompt : '')
  const [workspaceId, setWorkspaceId] = useState(job?.action.kind === 'agent' ? (job.action.workspaceId ?? '') : '')
  const [agentPreset, setAgentPreset] = useState(job?.action.kind === 'agent' ? (job.action.agentPreset ?? '') : '')
  const [permission, setPermission] = useState(job?.action.kind === 'agent' ? (job.action.permission ?? '') : '')
  const [permissionOptions, setPermissionOptions] = useState<string[]>([])
  const [error, setError] = useState<string | undefined>()

  // Permission roster comes from the Host (deployment-configured names), not
  // from a hardcoded list: the Host validator rejects unknown names, so a
  // built-in `read-only` option used to fail with an opaque HTTP 400.
  useEffect(() => {
    let alive = true
    void fetch('/api/cron/permissions', { headers: { accept: 'application/json' } }).then(async (res) => {
      if (!res.ok) return
      const body = (await res.json()) as { permissions?: unknown }
      if (!alive || !Array.isArray(body.permissions)) return
      setPermissionOptions(body.permissions.filter((name): name is string => typeof name === 'string' && name !== ''))
    }).catch(() => { /* leave the roster empty; the "none" option still works */ })
    return () => { alive = false }
  }, [])

  const permissionLabel = (value: string): string => {
    if (value === 'read-only') return t('job.permissionRead')
    if (value === 'workspace-write') return t('job.permissionWrite')
    if (value === 'danger-full-access') return t('job.permissionFull')
    return value
  }
  const shownPermissionOptions = [...new Set(permissionOptions.concat(permission === '' ? [] : [permission]))]

  // Project picker: '' = current project (default).
  const workspaceOptions = useWorkspaceOptions(workspaces)
  // Agent roster: '' = deployment default.
  const [agentOptions, setAgentOptions] = useState<AgentOption[]>([])
  useEffect(() => {
    let alive = true
    void fetchAgentOptions(api).then(options => {
      if (!alive) return
      setAgentOptions(options)
    })
    return () => { alive = false }
  }, [api])

  // 与**宿主同口径**(protocol.ts 的 validCron)：语法合法 **且** 扫描窗口内存在可达的
  // 下一次触发。只判语法会把 `0 0 30 2 *` 这类日历上不可能的组合放过去 —— 保存后宿主
  // 返 400、弹窗已经关掉，用户只在列表顶部看到一句 "cron action failed: 400"
  // [2026-09-21 审计]。
  const cronParsed = isValidCron(cron)
  const nextRun = cronParsed ? nextRunAtMs(cron, Date.now()) : undefined
  const cronValid = cronParsed && nextRun !== undefined

  const save = (): void => {
    if (!cronParsed) {
      setError(t('job.cronInvalid'))
      return
    }
    if (nextRun === undefined) {
      setError(t('job.cronNoMatch'))
      return
    }
    if (name.trim() === '') {
      setError(t('job.nameRequired'))
      return
    }
    if (prompt.trim() === '') {
      setError(t('job.promptTextRequired'))
      return
    }
    const action = {
      kind: 'agent' as const,
      prompt: prompt.trim(),
      ...(workspaceId === '' ? {} : { workspaceId }),
      ...(agentPreset === '' ? {} : { agentPreset }),
      ...(permission === '' ? {} : { permission }),
    }
    if (permission !== '' && permissionOptions.length > 0 && !permissionOptions.includes(permission)) {
      setError(t('job.permissionUnknown', { name: permission, available: permissionOptions.join(', ') }))
      return
    }
    if (!isCronJobAction(action)) {
      setError(t('job.promptTextRequired'))
      return
    }
    if (job === undefined) {
      const input: NewJobInput = { name: name.trim(), cron: cron.trim(), action, enabled: true }
      controller.create(input)
    } else {
      controller.update(job.id, { name: name.trim(), cron: cron.trim() })
      // 编辑只改 name/cron——不得静默改变启停状态(旧实现 `if(!job.enabled)
      // controller.enable()` 会让用户编辑名称后任务被悄悄重新启用,颠覆其
      // 显式停用意图;重新启用请用任务行的显式开关)。
    }
    onClose()
  }

  // Modal mutex: announce this modal and close when another modal opens.
  useEffect(() => {
    document.dispatchEvent(new CustomEvent('dsh-modal-open', { detail: 'cron-job' }))
    const onOtherModal = (event: Event): void => {
      if ((event as CustomEvent).detail !== 'cron-job') onClose()
    }
    document.addEventListener('dsh-modal-open', onOtherModal)
    return () => {
      document.removeEventListener('dsh-modal-open', onOtherModal)
    }
  }, [onClose])

  // `onClose` 是父组件里的内联箭头函数 ⇒ 每次父渲染都是新引用。固定进 ref，让下面两个
  // effect 都是**只挂载一次**的：否则控制器快照每次变化都会重跑，把焦点从用户正在填的
  // 字段(例如提示词)抢回第一个输入框。
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCloseRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 初始焦点 + Tab 环：遮罩是视觉上的模态，键盘也必须真的是模态 ——
  // 否则 Tab 会穿到遮罩背后的面板按钮："新建/启用/立即执行/删除"都能被 Tab 到并回车触发。
  const boxRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    boxRef.current?.querySelector<HTMLElement>('input, select, textarea')?.focus()
  }, [])
  useEffect(() => {
    const onTab = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return
      const box = boxRef.current
      if (box === null) return
      const focusables = [...box.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href]',
      )]
      if (focusables.length === 0) return
      const first = focusables[0]!
      const last = focusables[focusables.length - 1]!
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onTab)
    return () => window.removeEventListener('keydown', onTab)
  }, [])

  return (
    <div style={styles.overlay} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      {/*
        `aria-modal` 不只是无障碍标注：面板装载器就是按 `[role=dialog][aria-modal=true]`
        判断"把 Esc 让给内层模态"的。少了它，在编辑器里按 Esc 想取消编辑，整页面板也一起
        关闭、被踢回会话区 [2026-09-21 审计]。
      */}
      <div ref={boxRef} style={styles.editor} role="dialog" aria-modal="true" aria-label={job === undefined ? t('job.new') : t('job.editTitle')}>
        <div style={styles.field}>
          <label style={styles.label} htmlFor="cron-job-name">{t('job.name')}</label>
          <input id="cron-job-name" style={styles.input} value={name} onChange={(event) => { setName(event.target.value) }} />
        </div>
        <div style={styles.field}>
          <label style={styles.label} htmlFor="cron-job-expr">{t('job.cron')}</label>
          <input id="cron-job-expr" style={styles.input} value={cron} onChange={(event) => { setCron(event.target.value) }} spellCheck={false} />
          <div style={styles.presets}>
            {PRESETS.map(preset => (
              <button
                key={preset.key}
                type="button"
                // UX-2: highlight the chip whose value matches the current
                // expression (also when the user types it by hand).
                style={cron.trim() === preset.cron ? { ...styles.preset, ...styles.presetActive } : styles.preset}
                onClick={() => { setCron(preset.cron) }}
              >
                {t(preset.key)}
              </button>
            ))}
          </div>
          {cronValid && nextRun !== undefined && (
            <span style={styles.jobNext}>
              {t('job.nextRun')}: {new Date(nextRun).toLocaleString()}
            </span>
          )}
        </div>
        <div style={styles.field}>
          <label style={styles.label} htmlFor="cron-job-workspace">{t('job.workspace')}{job !== undefined && <span style={{ color: 'var(--dsw-alias-label-caption)' }}>{t('job.parenthesized', { text: t('job.actionNotEditable') })}</span>}</label>
          <select
            id="cron-job-workspace"
            style={styles.input}
            value={workspaceId}
            disabled={job !== undefined}
            onChange={(event) => { setWorkspaceId(event.target.value) }}
          >
            <option value="">{t('job.workspaceCurrent')}</option>
            {workspaceOptions.map(option => (
              <option key={option.workspaceId} value={option.workspaceId}>{option.title}</option>
            ))}
          </select>
        </div>
        <div style={styles.field}>
          <label style={styles.label} htmlFor="cron-job-agent">{t('job.agent')}{job !== undefined && <span style={{ color: 'var(--dsw-alias-label-caption)' }}>{t('job.parenthesized', { text: t('job.actionNotEditable') })}</span>}</label>
          <select
            id="cron-job-agent"
            style={styles.input}
            value={agentPreset}
            disabled={job !== undefined || agentOptions.length === 0}
            onChange={(event) => { setAgentPreset(event.target.value) }}
          >
            <option value="">{t('job.agentDefault')}</option>
            {agentOptions.map(option => (
              <option key={option.id} value={option.id} disabled={option.broken !== undefined}>
                {option.label}{option.broken !== undefined ? t('job.parenthesized', { text: option.broken }) : ''}
              </option>
            ))}
          </select>
        </div>
        <div style={styles.field}>
          <label style={styles.label} htmlFor="cron-job-permission">{t('job.permission')}{job !== undefined && <span style={{ color: 'var(--dsw-alias-label-caption)' }}>{t('job.parenthesized', { text: t('job.actionNotEditable') })}</span>}</label>
          <select
            id="cron-job-permission"
            style={styles.input}
            value={permission}
            disabled={job !== undefined}
            onChange={(event) => { setPermission(event.target.value) }}
          >
            <option value="">{t('job.permissionNone')}</option>
            {shownPermissionOptions.map(name => (
              <option key={name} value={name}>{permissionLabel(name)}</option>
            ))}
          </select>
        </div>
        <div style={styles.field}>
          <label style={styles.label} htmlFor="cron-job-prompt">{t('job.promptText')}{job !== undefined && <span style={{ color: 'var(--dsw-alias-label-caption)' }}>{t('job.parenthesized', { text: t('job.actionNotEditable') })}</span>}</label>
          <textarea id="cron-job-prompt" style={styles.input} rows={4} value={prompt} disabled={job !== undefined} onChange={(event) => { setPrompt(event.target.value) }} />
        </div>
        {error !== undefined && <span style={styles.error}>{error}</span>}
        <div style={styles.editorActions}>
          <button type="button" style={styles.button} onClick={onClose}>{t('job.cancel')}</button>
          <button type="button" style={{ ...styles.button, ...styles.buttonPrimary }} onClick={save}>{t('job.save')}</button>
        </div>
      </div>
    </div>
  )
}
