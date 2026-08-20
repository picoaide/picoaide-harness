/**
 * Task detail panel: editable fields, run/rerun with execution history,
 * open-session jump, and scheduled-run integration with dsh-cron (the
 * schedule is a cron job with action {kind:'task', taskId}).
 */
import { useEffect, useState } from 'react'
import type { TaskStatus } from '../tasks.ts'
import type { IWorkspaces } from '@deepseek-ai/dsh-client-runtime/client'
import type { TaskRecord } from '../tasks.ts'
import type { TaskController } from './controller.ts'
import { styles } from './styles.ts'
import { t, type TaskKey } from './locales.ts'
import { WorkspacePicker } from './WorkspacePicker.tsx'
import { PermissionPicker } from './PermissionPicker.tsx'

/** The cron service face (spelled locally; runtime identity is the cordis service). */
export interface CronServiceFace {
  getSnapshot(): { jobs: Array<{ id: string; name: string; cron: string; enabled: boolean; action: { kind: string; taskId?: string } }> }
  registerJob(registration: { id: string; name: string; cron: string; action: { kind: 'task'; taskId: string }; enabled?: boolean }): void
  unregisterJob(id: string): void
  subscribe(listener: () => void): () => void
}

export function TaskDetail({ controller, task, cron, workspaces }: {
  controller: TaskController
  task: TaskRecord
  cron?: CronServiceFace
  workspaces?: IWorkspaces
}): JSX.Element {
  const openSession = controller.openSession
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(task.title)
  const [description, setDescription] = useState(task.description)
  const [prompt, setPrompt] = useState(task.prompt)
  const [workspaceId, setWorkspaceId] = useState(task.workspaceId ?? '')
  const [permission, setPermission] = useState(task.permission ?? '')
  const [cronJobs, setCronJobs] = useState(cron?.getSnapshot().jobs ?? [])

  useEffect(() => {
    if (cron === undefined) return
    return cron.subscribe(() => setCronJobs(cron.getSnapshot().jobs))
  }, [cron])

  // The job linked to this task (by action.taskId).
  const linkedJob = cronJobs.find(job => job.action.kind === 'task' && job.action.taskId === task.id)

  const save = (): void => {
    controller.update(task.id, {
      ...(title.trim() !== '' ? { title: title.trim() } : {}),
      description,
      prompt,
      ...(workspaceId === '' ? {} : { workspaceId }),
      ...(permission === '' ? {} : { permission }),
    })
    setEditing(false)
  }

  const attachSchedule = (): void => {
    if (cron === undefined) return
    if (linkedJob !== undefined) {
      // Toggle the linked job's enabled state.
      cron.registerJob({
        id: linkedJob.id,
        name: linkedJob.name,
        cron: linkedJob.cron,
        action: { kind: 'task', taskId: task.id },
        enabled: !linkedJob.enabled,
      })
    } else {
      cron.registerJob({
        id: `task-${task.id}`,
        name: task.title,
        cron: '0 9 * * *',
        action: { kind: 'task', taskId: task.id },
        enabled: true,
      })
    }
  }

  const detachSchedule = (): void => {
    if (cron === undefined || linkedJob === undefined) return
    cron.unregisterJob(linkedJob.id)
  }

  const STATUS_OPTIONS: TaskStatus[] = ['todo', 'doing', 'done', 'failed']

  const running = task.executions.some(execution => execution.endedAt === undefined)
  const latest = task.executions[task.executions.length - 1]
  const history = [...task.executions].reverse()

  return (
    <div style={styles.detail} data-dsh-part="detail">
      <header style={styles.detailHeader}>
        <button type="button" style={styles.button} onClick={() => { controller.closeTask() }}>‹</button>
        <h3 style={{ ...styles.title, margin: 0 }}>{t('detail.title')}</h3>
        <button
          type="button"
          style={{ ...styles.button, ...styles.buttonPrimary, ...(running ? styles.buttonDisabled : {}) }}
          disabled={running}
          onClick={() => { controller.run(task.id) }}
        >
          {latest === undefined ? t('detail.run') : t('detail.rerun')}
        </button>
        <button type="button" style={styles.button} onClick={() => { setEditing(!editing) }}>
          {editing ? '✓' : t('detail.edit')}
        </button>
      </header>
      <div style={styles.detailBody}>
        {editing ? (
          <>
            <div style={styles.field}>
              <span style={styles.label}>{t('new.name')}</span>
              <input style={styles.input} value={title} onChange={(event) => { setTitle(event.target.value) }} />
            </div>
            <div style={styles.field}>
              <span style={styles.label}>{t('new.description')}</span>
              <input style={styles.input} value={description} onChange={(event) => { setDescription(event.target.value) }} />
            </div>
            <WorkspacePicker workspaces={workspaces} value={workspaceId} onChange={setWorkspaceId} />
            <PermissionPicker value={permission} onChange={setPermission} />
            <div style={styles.field}>
              <span style={styles.label}>{t('new.prompt')}</span>
              <textarea style={styles.input} rows={4} value={prompt} onChange={(event) => { setPrompt(event.target.value) }} />
            </div>
            <div style={styles.editorActions}>
              <button type="button" style={styles.button} onClick={() => { setEditing(false) }}>{t('new.cancel')}</button>
              <button type="button" style={{ ...styles.button, ...styles.buttonPrimary }} onClick={save}>{t('new.save')}</button>
            </div>
          </>
        ) : (
          <>
            <div style={styles.field}>
              <span style={styles.label}>{t('new.name')}</span>
              <span style={styles.value}>{task.title}</span>
            </div>
            {task.description !== '' && (
              <div style={styles.field}>
                <span style={styles.label}>{t('new.description')}</span>
                <span style={styles.value}>{task.description}</span>
              </div>
            )}
            <div style={styles.field}>
              <span style={styles.label}>{t('detail.prompt')}</span>
              <span style={styles.value}>{task.prompt}</span>
            </div>
            {task.workspaceId !== undefined && (
              <div style={styles.field}>
                <span style={styles.label}>{t('detail.workspace')}</span>
                <span style={styles.value}>{task.workspaceId}</span>
              </div>
            )}
            {task.mode !== undefined && (
              <div style={styles.field}>
                <span style={styles.label}>{t('detail.mode')}</span>
                <span style={styles.value}>{task.mode}</span>
              </div>
            )}
            {/* P1: manual status transitions — the Host `move` action and
                controller.move() were wired but had no UI trigger. */}
            <div style={styles.field}>
              <span style={styles.label}>{t('detail.status')}</span>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {STATUS_OPTIONS.map(status => {
                  const active = task.status === status
                  return (
                    <button
                      key={status}
                      type="button"
                      style={{
                        ...styles.button,
                        ...(active ? styles.buttonPrimary : {}),
                        ...(running && status !== task.status ? styles.buttonDisabled : {}),
                      }}
                      disabled={running && status !== task.status}
                      title={t('detail.statusMove')}
                      onClick={() => { if (!active) controller.move(task.id, status) }}
                    >
                      {t(`board.column.${status}` as TaskKey)}
                    </button>
                  )
                })}
              </div>
            </div>
          </>
        )}

        {/* Scheduled-run integration (dsh-cron) */}
        {cron !== undefined && (
          <div style={styles.schedule}>
            <span style={styles.label}>{t('detail.schedule')}</span>
            {linkedJob === undefined ? (
              <>
                <span>{t('detail.schedule.disabled')}</span>
                <button type="button" style={styles.button} onClick={attachSchedule}>{t('detail.schedule.attach')}</button>
              </>
            ) : (
              <>
                <span>{t('detail.schedule.attached')}: {linkedJob.cron} · {linkedJob.enabled ? t('detail.schedule.enabled') : t('detail.schedule.disabled')}</span>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button type="button" style={styles.button} onClick={attachSchedule}>
                    {linkedJob.enabled ? t('detail.schedule.disabled') : t('detail.schedule.enabled')}
                  </button>
                  <button type="button" style={styles.button} onClick={detachSchedule}>{t('detail.delete')}</button>
                </div>
              </>
            )}
          </div>
        )}

        <div style={styles.history}>
          <span style={styles.label}>{t('detail.history')}</span>
          {history.length === 0 && <span style={{ opacity: 0.6 }}>{t('detail.noHistory')}</span>}
          {history.map(execution => (
            <ExecutionRow
              key={execution.id}
              execution={execution}
              {...(openSession === undefined ? {} : { onOpenSession: openSession })}
            />
          ))}
        </div>

        <div style={{ display: 'flex', gap: 6 }}>
          <button type="button" style={styles.button} onClick={() => { controller.archive(task.id) }}>
            {task.archivedAt === undefined ? t('detail.archive') : t('detail.restore')}
          </button>
          <button
            type="button"
            style={{ ...styles.button, ...(running ? styles.buttonDisabled : {}) }}
            disabled={running}
            onClick={() => {
              // Deleting a task must also remove its scheduled job, or the
              // orphan job would keep firing into a nonexistent task.
              // Disabled while running: the Host refuses the delete anyway
              // (a running task must not lose its schedule silently).
              // P3-2: destructive actions need a confirmation step.
              if (!window.confirm(t('detail.deleteConfirm'))) return
              detachSchedule()
              controller.remove(task.id)
            }}
          >
            {t('detail.delete')}
          </button>
        </div>
      </div>
    </div>
  )
}

function ExecutionRow({ execution, onOpenSession }: {
  execution: TaskRecord['executions'][number]
  onOpenSession?: (sessionId: string) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={styles.historyRow}>
        <span style={{ opacity: 0.7 }}>{new Date(execution.startedAt).toLocaleString()}</span>
        <ExecutionLabel execution={execution} />
        {execution.prompt !== undefined && (
          <button
            type="button"
            style={styles.button}
            onClick={() => { setOpen(!open) }}
            title={t('detail.context')}
          >
            {open ? t('detail.contextHide') : t('detail.context')}
          </button>
        )}
      </div>
      {open && (
        <div style={{ ...styles.value, fontSize: 12, background: 'var(--dsw-input, rgba(0,0,0,0.2))', borderRadius: 6, padding: '6px 8px', whiteSpace: 'pre-wrap' }}>
          {execution.prompt ?? t('detail.contextEmpty')}
        </div>
      )}
      {execution.sessionId !== undefined && onOpenSession !== undefined && (
        <button
          type="button"
          style={styles.button}
          onClick={() => { onOpenSession(execution.sessionId!) }}
          title={t('detail.openSession')}
        >
          {t('detail.openSession')}
        </button>
      )}
    </div>
  )
}

function ExecutionLabel({ execution }: { execution: TaskRecord['executions'][number] }): JSX.Element {
  if (execution.endedAt === undefined) return <span style={styles.resultPending}>{t('detail.execution.pending')}</span>
  switch (execution.result) {
    case 'succeeded': return <span style={styles.resultOk}>{t('detail.execution.succeeded')}</span>
    case 'failed': return <span style={styles.resultFail}>{t('detail.execution.failed')}</span>
    case 'cancelled': return <span style={styles.resultCancel}>{t('detail.execution.cancelled')}</span>
    default: return <span>?</span>
  }
}
