/**
 * Job editor dialog: name, cron expression (with presets + live validation),
 * project (workspace) picker, agent preset picker (from agentPresets.list),
 * permission picker, and the prompt text sent to the spawned agent session.
 * The only action kind is `agent`.
 */
import { useEffect, useState } from 'react'
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

  const cronValid = isValidCron(cron)
  const nextRun = cronValid ? nextRunAtMs(cron, Date.now()) : undefined

  const save = (): void => {
    if (!cronValid) {
      setError(t('job.cronInvalid'))
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

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div style={styles.overlay} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div style={styles.editor} role="dialog" aria-label={t('job.new')}>
        <div style={styles.field}>
          <span style={styles.label}>{t('job.name')}</span>
          <input style={styles.input} value={name} onChange={(event) => { setName(event.target.value) }} />
        </div>
        <div style={styles.field}>
          <span style={styles.label}>{t('job.cron')}</span>
          <input style={styles.input} value={cron} onChange={(event) => { setCron(event.target.value) }} spellCheck={false} />
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
          <span style={styles.label}>{t('job.workspace')}{job !== undefined && <span style={{ color: 'var(--dsw-alias-label-caption)' }}>（{t('job.actionNotEditable')}）</span>}</span>
          <select
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
          <span style={styles.label}>{t('job.agent')}{job !== undefined && <span style={{ color: 'var(--dsw-alias-label-caption)' }}>（{t('job.actionNotEditable')}）</span>}</span>
          <select
            style={styles.input}
            value={agentPreset}
            disabled={job !== undefined || agentOptions.length === 0}
            onChange={(event) => { setAgentPreset(event.target.value) }}
          >
            <option value="">{t('job.agentDefault')}</option>
            {agentOptions.map(option => (
              <option key={option.id} value={option.id} disabled={option.broken !== undefined}>
                {option.label}{option.broken !== undefined ? `（${option.broken}）` : ''}
              </option>
            ))}
          </select>
        </div>
        <div style={styles.field}>
          <span style={styles.label}>{t('job.permission')}{job !== undefined && <span style={{ color: 'var(--dsw-alias-label-caption)' }}>（{t('job.actionNotEditable')}）</span>}</span>
          <select
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
          <span style={styles.label}>{t('job.promptText')}{job !== undefined && <span style={{ color: 'var(--dsw-alias-label-caption)' }}>（{t('job.actionNotEditable')}）</span>}</span>
          <textarea style={styles.input} rows={4} value={prompt} disabled={job !== undefined} onChange={(event) => { setPrompt(event.target.value) }} />
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
