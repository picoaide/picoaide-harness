/**
 * 定时任务中心：任务清单 + 启用/停用、立即执行、编辑、删除，以及每个任务的
 * 执行详情（触发/开始/结束时间、结果、错误、会话 id、提示词全文）。
 *
 * 两个宿主形态共用同一个组件（`page` 决定外壳）：
 *   - **中列整页**（侧边栏底部入口打开）：外壳走共享的 `PanelPage`；
 *   - **右侧栏标签页**（rc.2 `ui-sidebar-right`，可缺省）：外壳是紧凑头部。
 *   列表与行渲染只有一份实现，两种形态不会各自漂移。
 */
import { useEffect, useState } from 'react'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'
import {
  Card,
  Chip,
  EmptyState,
  IconTile,
  PANEL_GRID,
  PanelButton,
  PanelPage,
  PanelStats,
  icons,
} from '@picoaide/dsh-panel-surface/client'
import type { JobRecord } from '../jobs.ts'
import { jobIsRunning } from '../jobs.ts'
import type { CronController, CronViewSnapshot } from './controller.ts'
import { styles } from './styles.ts'
import { JobEditor } from './JobEditor.tsx'
import { t } from './locales.ts'

/** 执行结果的展示标签（文字 + 语义色调）。 */
function executionLabel(result: JobRecord['executions'][number]): { text: string; tone: 'success' | 'danger' | 'neutral' | 'warn' } {
  if (result.endedAt === undefined) return { text: t('job.execution.pending'), tone: 'warn' }
  switch (result.result) {
    case 'succeeded': return { text: t('job.execution.succeeded'), tone: 'success' }
    case 'failed': return { text: t('job.execution.failed'), tone: 'danger' }
    case 'cancelled': return { text: t('job.execution.cancelled'), tone: 'neutral' }
    default: return { text: '?', tone: 'neutral' }
  }
}

/** 下次运行的可读文案（未启用 ⇒ 已停用；已启用但没排上 ⇒ 未调度）。 */
function nextRunText(job: JobRecord): string {
  if (!job.enabled) return t('job.disabled')
  return job.nextRunAt === undefined
    ? `${t('job.nextRun')} ${t('job.notScheduled')}`
    : `${t('job.nextRun')} ${new Date(job.nextRunAt).toLocaleString()}`
}

/** cron 表达式的等宽小胶囊（放在卡片里当"技术标识"用）。 */
const CRON_CODE: React.CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 11.5,
  lineHeight: '18px',
  padding: '1px 7px',
  borderRadius: 6,
  background: 'var(--dsw-alias-bg-layer-3, transparent)',
  color: 'var(--dsw-alias-label-secondary)',
  whiteSpace: 'nowrap',
}

const META_LINE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap',
  fontSize: 11.5,
  lineHeight: '17px',
  color: 'var(--dsw-alias-label-caption)',
}

const CARD_FOOT: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  // 五个动作（立即执行/编辑/执行详情/删除，文案都 nowrap）在窄列里放不下：
  // 面板网格的最小列宽是 268px（`PANEL_GRID`），不放行折行时"删除"会被挤出卡片右侧，
  // 用户得横向滚动才能摸到（右侧栏标签页形态尤其明显，2026-09-21 审计）。
  flexWrap: 'wrap',
  rowGap: 4,
  marginTop: 'auto',
  paddingTop: 9,
  borderTop: '1px solid var(--dsw-alias-border-l1)',
}

export function CronJobTab({ controller, workspaces, api, openSession, page }: {
  controller: CronController
  workspaces?: IWorkspaces
  api?: ConnectionHandle['api']
  openSession?: (sessionId: string) => void
  /** 给了就是"中列整页"形态（外壳走共享 PanelPage）；不给则是右侧栏标签页形态。 */
  page?: { onClose: () => void }
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

  const enabledCount = snapshot.jobs.filter(job => job.enabled).length
  const nextRunAt = snapshot.jobs
    .filter(job => job.enabled && job.nextRunAt !== undefined)
    .reduce<number | undefined>((soonest, job) => (soonest === undefined || job.nextRunAt! < soonest ? job.nextRunAt : soonest), undefined)

  const newButton = (
    <PanelButton variant="primary" size="md" icon={<icons.IconPlus size={14} />} onClick={() => { setCreating(true) }}>
      {t('job.new')}
    </PanelButton>
  )

  const body = (
    <>
      {page !== undefined && snapshot.jobs.length > 0 && (
        <PanelStats items={[
          { label: t('job.listTitle'), value: String(snapshot.jobs.length) },
          { label: t('job.enabled'), value: String(enabledCount), tone: enabledCount > 0 ? 'success' : undefined },
          { label: t('job.nextRun'), value: nextRunAt === undefined ? t('job.notScheduled') : new Date(nextRunAt).toLocaleString() },
        ]} />
      )}
      {/* P1-13: a corrupt ledger reset must be loudly visible — the scheduler
          error field carries "ledger was corrupt and reset"; the user needs
          to know the restore path (.corrupt-* file) instead of a silent
          empty list. 2026-09-23 CR-1: a ledger that could not be *read* is a
          different state (nothing was reset, nothing may be written), so it
          gets its own notice instead of the corrupt/reset wording. */}
      {snapshot.scheduler.readOnly === true
        ? (
            <div style={{ ...styles.error, display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
              <icons.IconAlert size={14} />
              <span>{t('settings.ledgerReadOnly', { error: snapshot.scheduler.error ?? '' })}</span>
            </div>
          )
        : snapshot.scheduler.error !== undefined && (
            <div style={{ ...styles.error, display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
              <icons.IconAlert size={14} />
              <span>{t('settings.ledgerCorrupt', { error: snapshot.scheduler.error })}</span>
            </div>
          )}
      {snapshot.transportError !== undefined && (
        <div style={{ ...styles.error, display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <icons.IconAlert size={14} />
          <span style={{ flex: 1 }}>{snapshot.transportError}</span>
          <PanelButton size="sm" variant="secondary" icon={<icons.IconRefresh size={13} />} onClick={() => { void controller.retryHostSync() }}>
            {t('board.retry')}
          </PanelButton>
        </div>
      )}
      {snapshot.jobs.length === 0
        ? (
            <EmptyState
              icon={<icons.IconClock size={22} />}
              tone="brand"
              title={t('job.empty')}
              description={t('job.emptyHint')}
              action={(
                <PanelButton variant="primary" size="md" icon={<icons.IconPlus size={14} />} onClick={() => { setCreating(true) }}>
                  {t('job.new')}
                </PanelButton>
              )}
            />
          )
        : (
            <div style={PANEL_GRID}>
              {snapshot.jobs.map(job => (
                <JobCard
                  key={job.id}
                  job={job}
                  pending={snapshot.pendingJobIds.includes(job.id)}
                  controller={controller}
                  onEdit={setEditing}
                  {...(openSession === undefined ? {} : { openSession })}
                />
              ))}
            </div>
          )}
    </>
  )

  return (
    <>
      {page === undefined
        ? (
            <div style={styles.cron} data-dsh-plugin="cron" data-dsh-cron-panel="">
              <header style={{ ...styles.header, padding: '10px 12px' }}>
                <h3 style={{ ...styles.title, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <icons.IconClock size={15} />
                  {t('job.listTitle')}
                </h3>
                {newButton}
              </header>
              <div className="pico-scroll" style={{ ...styles.list, padding: 12 }}>{body}</div>
            </div>
          )
        : (
            <div data-dsh-plugin="cron" data-dsh-cron-panel="">
              <PanelPage
                icon={<icons.IconClock size={16} />}
                title={t('job.listTitle')}
                subtitle={t('settings.hostMeta', { timeZone: snapshot.scheduler.timeZone, revision: String(snapshot.revision) })}
                backLabel={t('board.close')}
                onClose={page.onClose}
                actions={newButton}
              >
                {body}
              </PanelPage>
            </div>
          )}
      {creating && <JobEditor controller={controller} {...(workspaces === undefined ? {} : { workspaces })} {...(api === undefined ? {} : { api })} onClose={() => { setCreating(false) }} />}
      {editing !== undefined && <JobEditor controller={controller} job={editing} {...(workspaces === undefined ? {} : { workspaces })} {...(api === undefined ? {} : { api })} onClose={() => { setEditing(undefined) }} />}
    </>
  )
}

function JobCard({ job, pending, controller, onEdit, openSession }: {
  job: JobRecord
  pending: boolean
  controller: CronController
  onEdit: (job: JobRecord) => void
  openSession?: (sessionId: string) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  /** 当前展开查看全文的 prompt（行内展示；null=收起）。 */
  const [shownPrompt, setShownPrompt] = useState<string | null>(null)
  const recent = job.executions.slice(-5).reverse()
  const latest = recent[0]
  const latestLabel = latest === undefined ? null : executionLabel(latest)
  // 2026-09-23 CR-2：正在执行的任务不能删——删除不会取消已 spawn 的会话，
  // 执行记录（会话 id / 提示词 / 结果）会凭空消失。判据与工具面、账本 delete
  // 闸共用 jobs.ts 的 jobIsRunning（单一实现）。
  const running = jobIsRunning(job)

  return (
    <Card interactive style={{ display: 'flex', flexDirection: 'column', gap: 10, borderRadius: 14, padding: '13px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, minWidth: 0 }}>
        <IconTile size={34} radius={10} tone={job.enabled ? 'brand' : 'neutral'}>
          <icons.IconClock size={17} />
        </IconTile>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
            <span className="pico-clamp-1" title={job.name} style={{ fontSize: 13.5, fontWeight: 600, lineHeight: '20px' }}>
              {job.name}
            </span>
            {!job.enabled && <Chip tone="neutral">{t('job.disabled')}</Chip>}
            {latestLabel !== null && job.enabled && <Chip tone={latestLabel.tone}>{latestLabel.text}</Chip>}
          </div>
          <div style={{ ...META_LINE, marginTop: 4 }}>
            <code style={CRON_CODE}>{job.cron}</code>
            <span className="pico-clamp-1" title={nextRunText(job)}>{nextRunText(job)}</span>
          </div>
        </div>
        <label className="pico-switch" title={t('job.enabled')} style={{ marginTop: 2 }}>
          <input
            type="checkbox"
            checked={job.enabled}
            disabled={pending}
            aria-label={t('job.enabled')}
            onChange={(event) => {
              if (event.target.checked) controller.enable(job.id)
              else controller.disable(job.id)
            }}
          />
        </label>
      </div>
      <div style={CARD_FOOT}>
        <PanelButton
          size="sm"
          variant="secondary"
          icon={<icons.IconPlay size={13} />}
          disabled={pending || !job.enabled}
          onClick={() => { controller.run(job.id) }}
        >
          {t('job.run')}
        </PanelButton>
        <PanelButton size="sm" variant="ghost" icon={<icons.IconEdit size={13} />} disabled={pending} onClick={() => { onEdit(job) }}>
          {t('job.editTitle')}
        </PanelButton>
        <span style={{ flex: 1 }} />
        <PanelButton
          size="sm"
          variant="ghost"
          aria-expanded={open}
          aria-label={open ? t('job.hideHistory') : t('job.showHistory')}
          icon={<icons.IconChevron size={13} style={open ? { transform: 'rotate(180deg)' } : undefined} />}
          onClick={() => { setOpen(!open) }}
        >
          {t('job.history')}
        </PanelButton>
        <PanelButton
          size="sm"
          variant="danger"
          icon={<icons.IconTrash size={13} />}
          disabled={pending || running}
          title={running ? t('job.deleteRunning') : undefined}
          onClick={() => {
            // P3-2: destructive actions need a confirmation step.
            if (!window.confirm(t('job.deleteConfirm'))) return
            controller.remove(job.id)
          }}
        >
          {t('job.delete')}
        </PanelButton>
      </div>
      {open && (
        <div style={styles.history}>
          {recent.length === 0 && <div style={{ ...styles.historyRow, opacity: 0.75 }}><span>{t('job.never')}</span></div>}
          {recent.map(execution => {
            const label = executionLabel(execution)
            return (
              <div key={execution.id} style={{ display: 'flex', flexDirection: 'column', gap: 3, padding: '4px 0' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <Chip tone={label.tone}>{label.text}</Chip>
                  <span style={styles.historyTime}>
                    {new Date(execution.triggeredAt).toLocaleString()}
                    {execution.startedAt !== undefined && execution.startedAt !== execution.triggeredAt && ` · ${t('job.execution.startedAt')} ${new Date(execution.startedAt).toLocaleTimeString()}`}
                    {execution.endedAt !== undefined && ` · ${t('job.execution.endedAt')} ${new Date(execution.endedAt).toLocaleTimeString()}`}
                  </span>
                  {execution.sessionId !== undefined && (
                    <span title={execution.sessionId} style={{ display: 'inline-flex', gap: 6, alignItems: 'center', opacity: 0.8 }}>
                      {execution.sessionId.slice(0, 12)}…
                      {openSession !== undefined && (
                        <PanelButton size="sm" variant="ghost" onClick={() => { openSession(execution.sessionId!) }}>
                          {t('job.execution.openSession')}
                        </PanelButton>
                      )}
                    </span>
                  )}
                </div>
                {execution.error !== undefined && (
                  <span style={{ color: 'var(--dsw-alias-state-error-primary)', wordBreak: 'break-word' }} title={execution.error}>
                    {execution.error.slice(0, 160)}
                  </span>
                )}
                {execution.prompt !== undefined && (
                  <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ ...styles.historyTime, flex: 'none' }}>{t('job.execution.prompt')}</span>
                      <PanelButton
                        size="sm"
                        variant="ghost"
                        onClick={() => { setShownPrompt(shownPrompt === execution.prompt ? null : (execution.prompt ?? null)) }}
                      >
                        {shownPrompt === execution.prompt ? t('job.hideHistory') : t('job.showHistory')}
                      </PanelButton>
                    </span>
                    {shownPrompt === execution.prompt && (
                      <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', opacity: 0.9 }}>{execution.prompt}</span>
                    )}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}
