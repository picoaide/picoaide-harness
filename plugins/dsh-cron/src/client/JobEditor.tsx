/**
 * Job editor dialog: name, cron expression (with presets + live validation),
 * project (workspace) picker, and the action (run a dsh-task task, or send a
 * message to a session). Task actions select the target task from the chosen
 * project's board (fetched through the dsh-task loopback API); prompt actions
 * name a session id directly.
 */
import { useEffect, useState } from 'react'
import type { IWorkspaces } from '@deepseek-ai/dsh-client-runtime/client'
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

/** One task option fetched from the dsh-task board. */
interface TaskOption {
  id: string
  title: string
  /** Pinned workspace; absent = current workspace. */
  workspaceId?: string
}

/** Fetch the dsh-task board tasks through its loopback API (soft dependency). */
async function fetchTaskOptions(): Promise<TaskOption[]> {
  try {
    const response = await fetch('/api/task/state', { headers: { accept: 'application/json' } })
    if (!response.ok) return []
    const snapshot = await response.json() as { tasks?: Array<{ id: string; title: string; workspaceId?: string }> }
    return (snapshot.tasks ?? []).map(task => ({
      id: task.id,
      title: task.title,
      ...task.workspaceId !== undefined ? { workspaceId: task.workspaceId } : {},
    }))
  } catch {
    return []
  }
}

export function JobEditor({ controller, job, workspaces, onClose }: {
  controller: CronController
  job?: JobRecord
  workspaces?: IWorkspaces
  onClose: () => void
}): JSX.Element {
  const [name, setName] = useState(job?.name ?? '')
  const [cron, setCron] = useState(job?.cron ?? '0 9 * * *')
  const [actionKind, setActionKind] = useState<'task' | 'prompt'>(job?.action.kind ?? 'task')
  const [taskId, setTaskId] = useState(job?.action.kind === 'task' ? job.action.taskId : '')
  const [sessionId, setSessionId] = useState(job?.action.kind === 'prompt' ? job.action.sessionId : '')
  const [text, setText] = useState(job?.action.kind === 'prompt' ? job.action.text : '')
  const [error, setError] = useState<string | undefined>()

  // Project picker: '' = current project (default), matching the board.
  const workspaceOptions = useWorkspaceOptions(workspaces)
  const [workspaceId, setWorkspaceId] = useState('')

  // Task options for the chosen project ('' = tasks pinned to no project).
  const [taskOptions, setTaskOptions] = useState<TaskOption[]>([])
  useEffect(() => {
    if (actionKind !== 'task') return
    let alive = true
    void fetchTaskOptions().then(options => {
      if (!alive) return
      setTaskOptions(options)
    })
    return () => { alive = false }
  }, [actionKind, workspaceId])

  const cronValid = isValidCron(cron)
  const nextRun = cronValid ? nextRunAtMs(cron, Date.now()) : undefined

  const visibleTasks = workspaceId === ''
    ? taskOptions.filter(task => task.workspaceId === undefined)
    : taskOptions.filter(task => task.workspaceId === workspaceId)

  const save = (): void => {
    if (!cronValid) {
      setError(t('job.cronInvalid'))
      return
    }
    if (name.trim() === '') {
      setError(t('job.nameRequired'))
      return
    }
    const action = actionKind === 'task'
      ? { kind: 'task' as const, taskId: taskId.trim() }
      : { kind: 'prompt' as const, sessionId: sessionId.trim(), text }
    if (!isCronJobAction(action)) {
      // Distinguish the two prompt-mode fields so the error names the
      // missing input (P2-3): empty session ID vs empty message text.
      if (actionKind === 'task') setError(t('job.taskIdRequired'))
      else if (sessionId.trim() === '') setError(t('job.sessionIdRequired'))
      else setError(t('job.promptTextRequired'))
      return
    }
    if (job === undefined) {
      const input: NewJobInput = { name: name.trim(), cron: cron.trim(), action, enabled: true }
      controller.create(input)
    } else {
      controller.update(job.id, { name: name.trim(), cron: cron.trim() })
      if (!job.enabled) controller.enable(job.id)
    }
    onClose()
  }

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
              <button key={preset.key} type="button" style={styles.preset} onClick={() => { setCron(preset.cron) }}>
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
          <span style={styles.label}>{t('job.workspace')}</span>
          <select
            style={styles.input}
            value={workspaceId}
            onChange={(event) => { setWorkspaceId(event.target.value) }}
          >
            <option value="">{t('job.workspaceCurrent')}</option>
            {workspaceOptions.map(option => (
              <option key={option.workspaceId} value={option.workspaceId}>{option.title}</option>
            ))}
          </select>
        </div>
        <div style={styles.field}>
          <span style={styles.label}>{t('job.actionTask')} / {t('job.actionPrompt')}</span>
          <select
            style={styles.input}
            value={actionKind}
            onChange={(event) => { setActionKind(event.target.value as 'task' | 'prompt') }}
          >
            <option value="task">{t('job.actionTask')}</option>
            <option value="prompt">{t('job.actionPrompt')}</option>
          </select>
        </div>
        {actionKind === 'task' ? (
          <div style={styles.field}>
            <span style={styles.label}>{t('job.taskId')}</span>
            <select
              style={styles.input}
              value={taskId}
              onChange={(event) => { setTaskId(event.target.value) }}
            >
              <option value="">{t('job.taskSelect')}</option>
              {visibleTasks.map(task => (
                <option key={task.id} value={task.id}>{task.title || task.id}</option>
              ))}
            </select>
          </div>
        ) : (
          <>
            <div style={styles.field}>
              <span style={styles.label}>{t('job.sessionId')}</span>
              <input style={styles.input} value={sessionId} onChange={(event) => { setSessionId(event.target.value) }} placeholder="session-…" />
            </div>
            <div style={styles.field}>
              <span style={styles.label}>{t('job.promptText')}</span>
              <textarea style={styles.input} rows={3} value={text} onChange={(event) => { setText(event.target.value) }} />
            </div>
          </>
        )}
        {error !== undefined && <span style={styles.error}>{error}</span>}
        <div style={styles.editorActions}>
          <button type="button" style={styles.button} onClick={onClose}>{t('job.cancel')}</button>
          <button type="button" style={{ ...styles.button, ...styles.buttonPrimary }} onClick={save}>{t('job.save')}</button>
        </div>
      </div>
    </div>
  )
}
