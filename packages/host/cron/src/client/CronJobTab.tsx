/**
 * Scheduled-job center: the panel tab listing all jobs with enable/disable,
 * run-now, edit, delete, and per-job execution detail (triggered/start/end
 * time, result, error, session id, prompt view).
 */
import { useEffect, useState } from 'react'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type { IWorkspaces } from '@deepseek-ai/dsh-client-runtime/client'
import type { JobRecord } from '../jobs.ts'
import type { CronController, CronViewSnapshot } from './controller.ts'
import { styles } from './styles.ts'
import { JobEditor } from './JobEditor.tsx'
import { t } from './locales.ts'

function executionLabel(result: JobRecord['executions'][number]): { text: string; style: React.CSSProperties } {
  if (result.endedAt === undefined) return { text: t('job.execution.pending'), style: styles.resultPending! }
  switch (result.result) {
    case 'succeeded': return { text: t('job.execution.succeeded'), style: styles.resultOk! }
    case 'failed': return { text: t('job.execution.failed'), style: styles.resultFail! }
    case 'cancelled': return { text: t('job.execution.cancelled'), style: styles.resultCancel! }
    default: return { text: '?', style: styles.resultCancel! }
  }
}

export function CronJobTab({ controller, workspaces, api, openSession }: {
  controller: CronController
  workspaces?: IWorkspaces
  api?: ConnectionHandle['api']
  openSession?: (sessionId: string) => void
}): JSX.Element {
  const [snapshot, setSnapshot] = useState<CronViewSnapshot>(controller.getSnapshot())
  const [editing, setEditing] = useState<JobRecord | undefined>()
  const [creating, setCreating] = useState(false)

  useEffect(
    () => controller.subscribe(() => setSnapshot(controller.getSnapshot())),
    [controller],
  )

  // The roster is fetched inside JobEditor; only forward the api handle.
  void api

  return (
    <div style={styles.cron} data-dsh-plugin="cron" data-dsh-cron-panel="">
      <header style={styles.header}>
        <h3 style={styles.title}>{t('job.listTitle')}</h3>
        <span style={styles.meta}>{t('settings.hostMeta', { timeZone: snapshot.scheduler.timeZone, revision: String(snapshot.revision) })}</span>
        <button type="button" style={{ ...styles.button, ...styles.buttonPrimary }} onClick={() => { setCreating(true) }}>
          + {t('job.new')}
        </button>
      </header>
      {/* P1-13: a corrupt ledger reset must be loudly visible — the scheduler
          error field carries "ledger was corrupt and reset"; the user needs
          to know the restore path (.corrupt-* file) instead of a silent
          empty list. */}
      {snapshot.scheduler.error !== undefined && (
        <div style={styles.error}>
          {t('settings.ledgerCorrupt', { error: snapshot.scheduler.error })}
        </div>
      )}
      {snapshot.transportError !== undefined && (
        <div style={styles.error}>
          {snapshot.transportError}{' '}
          <button type="button" style={styles.button} onClick={() => { void controller.retryHostSync() }}>retry</button>
        </div>
      )}
      <div style={styles.list}>
        {snapshot.jobs.length === 0 && <div style={styles.empty}>{t('job.empty')}</div>}
        {snapshot.jobs.map(job => (
          <JobRow key={job.id} job={job} pending={snapshot.pendingJobIds.includes(job.id)} controller={controller} onEdit={setEditing} api={api} {...(openSession === undefined ? {} : { openSession })} />
        ))}
      </div>
      {creating && <JobEditor controller={controller} {...(workspaces === undefined ? {} : { workspaces })} {...(api === undefined ? {} : { api })} onClose={() => { setCreating(false) }} />}
      {editing !== undefined && <JobEditor controller={controller} job={editing} {...(workspaces === undefined ? {} : { workspaces })} {...(api === undefined ? {} : { api })} onClose={() => { setEditing(undefined) }} />}
    </div>
  )
}

function JobRow({ job, pending, controller, onEdit, api, openSession }: {
  job: JobRecord
  pending: boolean
  controller: CronController
  onEdit: (job: JobRecord) => void
  api?: ConnectionHandle['api']
  openSession?: (sessionId: string) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const recent = job.executions.slice(-5).reverse()
  void api
  return (
    <div style={styles.job}>
      <div style={styles.jobRow}>
        <span style={styles.jobName} title={job.name}>{job.name}</span>
        <span style={styles.jobCron}>{job.cron}</span>
        <span style={styles.jobNext}>
          {job.enabled
            ? `${t('job.nextRun')} ${job.nextRunAt === undefined ? t('job.notScheduled') : new Date(job.nextRunAt).toLocaleString()}`
            : t('job.disabled')}
        </span>
        <div style={styles.actions}>
          <label style={styles.switch}>
            <input
              type="checkbox"
              checked={job.enabled}
              disabled={pending}
              onChange={(event) => {
                if (event.target.checked) controller.enable(job.id)
                else controller.disable(job.id)
              }}
            />
            {t('job.enabled')}
          </label>
          <button type="button" style={{ ...styles.button, ...(pending || !job.enabled ? styles.buttonDisabled : {}) }} disabled={pending || !job.enabled} onClick={() => { controller.run(job.id) }}>
            {t('job.run')}
          </button>
          <button type="button" style={{ ...styles.button, ...(pending ? styles.buttonDisabled : {}) }} disabled={pending} onClick={() => { onEdit(job) }}>…</button>
          <button
            type="button"
            style={{ ...styles.button, ...(pending ? styles.buttonDisabled : {}) }}
            disabled={pending}
            onClick={() => {
              // P3-2: destructive actions need a confirmation step.
              if (!window.confirm(t('job.deleteConfirm'))) return
              controller.remove(job.id)
            }}
          >
            {t('job.delete')}
          </button>
          <button
            type="button"
            style={styles.button}
            aria-expanded={open}
            aria-label={open ? t('job.hideHistory') : t('job.showHistory')}
            onClick={() => { setOpen(!open) }}
          >
            {open ? '−' : '+'}
          </button>
        </div>
      </div>
      {open && (
        <div style={styles.history}>
          <div>{t('job.history')}</div>
          {recent.length === 0 && <div style={styles.historyRow}><span>{t('job.never')}</span></div>}
          {recent.map(execution => {
            const label = executionLabel(execution)
            return (
              <div key={execution.id} style={styles.historyRow}>
                <span style={styles.historyTime}>
                  {new Date(execution.triggeredAt).toLocaleString()}
                  {execution.startedAt !== undefined && execution.startedAt !== execution.triggeredAt && ` · ${t('job.execution.startedAt')} ${new Date(execution.startedAt).toLocaleTimeString()}`}
                  {execution.endedAt !== undefined && ` · ${t('job.execution.endedAt')} ${new Date(execution.endedAt).toLocaleTimeString()}`}
                </span>
                <span style={label.style}>{label.text}</span>
                {execution.sessionId !== undefined && (
                  <span title={execution.sessionId} style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                    {execution.sessionId.slice(0, 12)}…
                    {openSession !== undefined && (
                      <button
                        type="button"
                        style={styles.button}
                        title={t('job.execution.openSession')}
                        onClick={() => { openSession(execution.sessionId!) }}
                      >
                        {t('job.execution.openSession')}
                      </button>
                    )}
                  </span>
                )}
                {execution.error !== undefined && <span title={execution.error}>{execution.error.slice(0, 80)}</span>}
                {execution.prompt !== undefined && (
                  <button
                    type="button"
                    style={styles.button}
                    title={t('job.execution.prompt')}
                    onClick={() => { window.alert(`${t('job.execution.prompt')}:\n\n${execution.prompt}`) }}
                  >
                    {t('job.execution.prompt')}
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
