/**
 * Board view: the multi-column kanban that replaces the middle column while
 * active. Cards open the task detail; the header offers search, new-task,
 * archive view, and a back-to-chat escape. The `onClose` escape is supplied
 * by the main-area mount (absent in the better-sidebar tab).
 */
import { useEffect, useMemo, useState } from 'react'
import type { IWorkspaces } from '@deepseek-ai/dsh-client-runtime/client'
import { COLUMNS, type TaskRecord } from '../tasks.ts'
import type { TaskController, TaskViewSnapshot } from './controller.ts'
import { styles } from './styles.ts'
import { t, type TaskKey } from './locales.ts'
import { TaskDetail } from './TaskDetail.tsx'
import { NewTaskModal } from './NewTaskModal.tsx'
import type { CronServiceFace } from './TaskDetail.tsx'

/** Case-insensitive title/description match. */
function matchesFilter(task: TaskRecord, filter: string): boolean {
  if (filter.trim() === '') return true
  const needle = filter.trim().toLowerCase()
  return task.title.toLowerCase().includes(needle) || task.description.toLowerCase().includes(needle)
}

const STATUS_DOT: Record<string, string> = {
  todo: 'var(--dsw-warning, #d9a441)',
  doing: 'var(--dsw-accent, #4d6bfe)',
  done: 'var(--dsw-success, #4caf7d)',
  failed: 'var(--dsw-danger, #e06666)',
}

export function TaskBoard({ controller, onClose, workspaces }: {
  controller: TaskController
  onClose?: () => void
  workspaces?: IWorkspaces
}): JSX.Element {
  const [snapshot, setSnapshot] = useState<TaskViewSnapshot>(controller.getSnapshot())
  const [filter, setFilter] = useState('')
  const [showNew, setShowNew] = useState(false)

  useEffect(
    () => controller.subscribe(() => setSnapshot(controller.getSnapshot())),
    [controller],
  )

  const visible = useMemo(
    () => snapshot.tasks.filter(task => matchesFilter(task, filter)),
    [snapshot.tasks, filter],
  )
  const selected = snapshot.selectedTaskId === undefined
    ? undefined
    : snapshot.tasks.find(task => task.id === snapshot.selectedTaskId)

  return (
    <div style={styles.board} data-dsh-plugin="task" data-dsh-task-board="">
      <header style={styles.header}>
        {onClose !== undefined && (
          <button type="button" style={styles.button} onClick={onClose}>
            <span aria-hidden="true">‹ </span>{t('board.close')}
          </button>
        )}
        <h2 style={styles.title}>{t('board.title')}</h2>
        <span style={styles.meta}>{t('board.hostMeta', { revision: String(snapshot.revision) })}</span>
        <input
          style={styles.search}
          type="search"
          placeholder={t('board.search')}
          value={filter}
          onChange={(event) => { setFilter(event.target.value) }}
          aria-label={t('board.search')}
        />
        <button
          type="button"
          style={snapshot.archiveView ? { ...styles.button, ...styles.buttonPrimary } : styles.button}
          onClick={() => { controller.toggleArchiveView() }}
        >
          {snapshot.archiveView
            ? t('board.backToBoard')
            : t('board.archiveView', { count: String(snapshot.tasks.filter(task => task.archivedAt !== undefined).length) })}
        </button>
        <button type="button" style={{ ...styles.button, ...styles.buttonPrimary }} onClick={() => { setShowNew(true) }}>
          + {t('board.new')}
        </button>
      </header>

      {snapshot.transportError !== undefined && (
        <div style={styles.error}>
          {t('board.hostError', { error: snapshot.transportError })}{' '}
          <button type="button" style={styles.button} onClick={() => { void controller.retryHostSync() }}>
            {t('board.retryHost')}
          </button>
        </div>
      )}

      <div style={styles.columns}>
        {snapshot.archiveView ? (
          <Column title={t('board.archive')} count={visible.filter(task => task.archivedAt !== undefined).length}>
            {visible.filter(task => task.archivedAt !== undefined).map(task => (
              <TaskCard key={task.id} task={task} controller={controller} />
            ))}
          </Column>
        ) : (
          COLUMNS.map(column => {
            const tasks = visible.filter(task => task.status === column.status && task.archivedAt === undefined)
            return (
              <Column key={column.status} title={t(column.labelKey as TaskKey)} count={tasks.length} {...(STATUS_DOT[column.status] === undefined ? {} : { dot: STATUS_DOT[column.status] })}>
                {tasks.length === 0 && <div style={styles.columnEmpty}>{t('board.empty')}</div>}
                {tasks.map(task => (
                  <TaskCard key={task.id} task={task} controller={controller} />
                ))}
              </Column>
            )
          })
        )}
      </div>

      {selected !== undefined && (
        <TaskDetail
          key={selected.id}
          controller={controller}
          task={selected}
          {...(workspaces === undefined ? {} : { workspaces })}
          {...(controller.cron?.() === undefined ? {} : { cron: controller.cron?.() as CronServiceFace })}
        />
      )}
      {showNew && (
        <NewTaskModal
          controller={controller}
          {...(workspaces === undefined ? {} : { workspaces })}
          onClose={() => { setShowNew(false) }}
        />
      )}
    </div>
  )
}

function Column({ title, count, dot, children }: {
  title: string
  count: number
  dot?: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <section style={styles.column}>
      <header style={styles.columnHeader}>
        {dot !== undefined && <span style={{ ...styles.statusDot, background: dot }} aria-hidden="true" />}
        <h3 style={styles.columnTitle}>{title}</h3>
        <span style={styles.columnCount}>{count}</span>
      </header>
      <div style={styles.cards}>{children}</div>
    </section>
  )
}

function TaskCard({ task, controller }: { task: TaskRecord; controller: TaskController }): JSX.Element {
  const latest = task.executions[task.executions.length - 1]
  const running = latest !== undefined && latest.endedAt === undefined
  return (
    <button
      type="button"
      style={styles.card}
      onClick={() => { controller.openTask(task.id) }}
      data-dsh-part="card"
    >
      <span style={styles.cardTitle}>{task.title}</span>
      <span style={styles.cardDesc}>{task.description || task.prompt}</span>
      <span style={styles.cardMeta}>
        {running && <span style={styles.resultPending}>{t('detail.execution.pending')}</span>}
        {task.workspaceId !== undefined && <span>#{task.workspaceId.slice(0, 12)}</span>}
      </span>
    </button>
  )
}
