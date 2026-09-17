/**
 * dsh-memory-evolve — COI 调度 tab（conversation.view 第二个 entry）。
 *
 * 统一调度 kimi/codex/grok/hermes 等 CLI 代理的 Web 面板：顶部六个子 Tab
 * （任务/会话/适配器/模板/统计/配置）。数据全部来自 host 的
 * /memory-evolve/api/coi 路由；样式在 coi-styles.css（coi- 前缀，
 * 由 index.ts 注入）。
 *
 * i18n（2026-09-16）：本文件原先自带一份 180 键的 zh/en 私有字典、
 * 按 `navigator.language` 选语言（后经 clientLang 修成跟随界面语言），
 * 但它**绕开了注册字典**（ctx.locale）——等于第二份真源。现在全部文案
 * 并入 src/client/index.ts 的 zh/en（键前缀 'coi.'），经 slot 注入的 t
 * 在**调用期**取当前语言；键类型用 MemoryEvolveKey 收窄，漏键编译期即报。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { createLatestOnly, createScrollFollow } from './ui-guards.js'
import type { MemoryEvolveKey } from '../index.ts'

/* ------------------------------------------------------------------ */
/* 类型（与 host API 响应形状一致）                                      */
/* ------------------------------------------------------------------ */

/** 一个 CLI 适配器定义。 */
interface Adapter {
  id: string
  name: string
  type: 'ai-cli' | 'plain-cli'
  binary: string
  args: string[]
  guide?: string
  testCmd?: string[]
  skillName?: string
  useCase?: string
  enabled?: boolean
  /** ai-cli 专属：指定会话恢复（必填）、最近会话恢复（可选）、会话 id 提取（可选）。 */
  resume?: { kind: 'flag'; flag: string; arg: string } | { kind: 'args'; args: string[] }
  continue?: { kind: 'flag'; flag: string } | { kind: 'args'; args: string[] }
  sessionIdExtract?: { source: 'stdout' | 'stderr' | 'any' | 'none'; regex: string | null }
  /** 平均完成耗时（毫秒，host 计算；0=暂无完成记录）。 */
  avgMs?: number
}

/** 任务状态机。 */
type TaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'killed' | 'interrupted'

/** 一条调度任务记录。 */
interface CoiTask {
  id: string
  adapterId: string
  coi: string
  prompt: string
  scope: string
  cwd: string | null
  branch: string | null
  sessionId: string | null
  status: TaskStatus
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
  lastOutputAt: number | null
  exitCode: number | null
  error: string | null
  summary: string | null
  refTaskId: string | null
  templateId: string | null
}

/** 一条 CLI 会话记录（可恢复的会话）。 */
interface CoiSession {
  id: string
  adapterId: string
  scope: string
  cwd: string | null
  branch: string | null
  note: string | null
  activeTaskId: string | null
  lastTaskId: string | null
  firstSeen: number
  lastSeen: number
}

/** 任务模板。 */
interface CoiTemplate {
  id: string
  name: string
  adapterId?: string
  prompt: string
  scope?: string
  note?: string
}

/** GET /stats 响应。 */
interface CoiStats {
  total: number
  byAdapter: Record<string, { count: number; totalMs: number; byStatus: Record<string, number> }>
}

/** GET /config 的运行时配置。 */
interface CoiConfig {
  coiNotifyCommand: string
  coiRetentionDays: number
  coiTaskTimeoutMs: number
}

/** 行内提示（成功/失败）。 */
interface Notice {
  kind: 'ok' | 'error'
  text: string
}

/**
 * 本视图的字典键域名（'coi.' 前缀；真源 = src/client/index.ts 的 zh/en）。
 *
 * 2026-09-16：此前这里是模块内的 `DICT = { zh, en }` 私有字典 + `lang()`
 * 读 navigator.language —— 现在只保留键，取值一律经注册字典的 t。
 */
type DictKey = Extract<MemoryEvolveKey, `coi.${string}`>

/**
 * 造一个「本视图键 → 当前语言文案」的查询函数。
 *
 * ⚠️ 必须是每个组件各持一份（`const t = dict(props.t)`），**不得**再退回
 * 模块级常量/闭包：模块求值早于插件 apply，那时 t 只能拿到默认语言，
 * 等于把界面语言钉死。
 *
 * ⚠️ 必须透传 `params`（2026-09-16 R9 审计 P1）：这里曾收窄成 `(key) => t(key)`，
 * 于是 9 处 `t('coi.…', { … })` 的插值参数被静默丢掉，用户看到的是模板原文
 * （`{count} 分钟前` / `（{value}）`）；上游 `translate` 无参时**原样返回模板**，
 * 不会报错。
 */
function dict(t: Translate): (key: DictKey, params?: Record<string, unknown>) => string {
  return (key, params) => t(key, params)
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const API = '/memory-evolve/api/coi'

/** 统一 fetch：非 2xx 抛出带 host message 的 Error，绝不抛未捕获异常到渲染层。 */
async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...init,
  })
  const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string }
  if (!res.ok) throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`)
  return body as T
}

/** POST JSON。 */
function postJson<T>(path: string, body?: unknown): Promise<T> {
  return fetchJson<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) })
}

/** DELETE。 */
function deleteJson<T>(path: string): Promise<T> {
  return fetchJson<T>(path, { method: 'DELETE' })
}

/** unknown → 可读错误文本；空信息兜底，绝不渲染空红框。 */
function errText(err: unknown, t: (key: DictKey, params?: Record<string, unknown>) => string): string {
  const text = err instanceof Error ? err.message : String(err)
  return text !== undefined && text.trim() !== '' ? text : t('coi.error.noDetail')
}

/** 后端 message 兜底：空串/缺失时用 fallback。 */
function msgOr(text: string | undefined, fallback: string): string {
  return text !== undefined && text.trim() !== '' ? text : fallback
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** 时间戳 → 'YYYY-MM-DD HH:mm:ss'。 */
function fmtTime(ts: number | null | undefined): string {
  if (ts === null || ts === undefined) return '—'
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

/** 时间戳 → 相对时间（当次渲染语言）。 */
function fmtAgo(ts: number | null | undefined, t: (key: DictKey, params?: Record<string, unknown>) => string): string {
  if (ts === null || ts === undefined) return '—'
  const delta = Math.max(0, Date.now() - ts)
  if (delta < 5000) return t('coi.ago.justNow')
  const s = Math.floor(delta / 1000)
  if (s < 60) return t('coi.ago.seconds', { count: s })
  const m = Math.floor(s / 60)
  if (m < 60) return t('coi.ago.minutes', { count: m })
  const h = Math.floor(m / 60)
  return t('coi.ago.hours', { count: h })
}

/** 毫秒 → '500ms' / '42s' / '3m 5s' / '1h 2m'。 */
function fmtDur(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/** 单行截断（默认 40 字）。 */
function trunc(text: string, n = 40): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n)}…` : one
}

/**
 * 状态 → 图标/文案/样式类。
 *
 * S4（2026-09-16）：**必须是函数**——表里含 `lang()`，写成模块级常量会让文案
 * 在模块加载那一刻就被钉死（与上面 `LANG` 常量同一个坑）。
 */
function statusMeta(status: string, t: (key: DictKey, params?: Record<string, unknown>) => string): { icon: string; label: string; cls: string } {
  const meta: Record<string, { icon: string; label: string; cls: string }> = {
    queued: { icon: '⏳', label: t('coi.status.queued'), cls: 'coi-status-queued' },
    running: { icon: '⏳', label: t('coi.status.running'), cls: 'coi-status-running' },
    completed: { icon: '✅', label: t('coi.status.completed'), cls: 'coi-status-completed' },
    failed: { icon: '❌', label: t('coi.status.failed'), cls: 'coi-status-failed' },
    killed: { icon: '🛑', label: t('coi.status.killed'), cls: 'coi-status-killed' },
    interrupted: { icon: '⚠️', label: t('coi.status.interrupted'), cls: 'coi-status-interrupted' },
  }
  return meta[status] ?? { icon: '❔', label: status, cls: '' }
}

const SCOPES = ['temporary', 'session', 'project', 'global'] as const

/**
 * 归属层级徽标：已知层级查字典（coi.scope.*），未知值原样透出。
 * 原先写的是 `t(动态 scope 键) ?? scope` —— 但 t 永不返回 nullish，
 * 未知值实际渲染成键名（'scope.foo'），`??` 从不生效；这里按原意兜底。
 */
function scopeLabel(scope: string, t: (key: DictKey, params?: Record<string, unknown>) => string): string {
  return (SCOPES as readonly string[]).includes(scope) ? t(`coi.scope.${scope}` as DictKey) : scope
}

/** 内置适配器 id（host 不返回内置标记，前端据此隐藏删除按钮；与 lib/coi/adapters.js 对齐）。 */
const BUILTIN_ADAPTER_IDS = new Set(['kimi', 'codex', 'grok', 'hermes'])

/** 内置模板 id（与 lib/coi/templates.js 对齐）。 */
const BUILTIN_TEMPLATE_IDS = new Set(['review-code', 'fix-tests', 'summarize-logs', 'architecture-analysis'])

/** 任务列表轮询间隔。 */
const TASKS_POLL_MS = 3000
/** 日志轮询间隔（仅运行中）。 */
const LOG_POLL_MS = 2000
/** 任务列表每页条数（分页：任务多时翻页查看历史，不再只显示最近 20 条）。 */
const TASK_LIMIT = 20

/* ------------------------------------------------------------------ */
/* 通用小件                                                             */
/* ------------------------------------------------------------------ */

function NoticeLine(props: { notice: Notice | null }): JSX.Element | null {
  if (props.notice === null) return null
  return <div className={`coi-notice coi-notice-${props.notice.kind}`}>{props.notice.text}</div>
}

function ErrorLine(props: { error: string | null }): JSX.Element | null {
  if (props.error === null) return null
  return <div className="coi-error">{props.error}</div>
}

/* ------------------------------------------------------------------ */
/* 主组件：子 Tab 切换                                                   */
/* ------------------------------------------------------------------ */

type SubTab = 'guide' | 'tasks' | 'sessions' | 'adapters' | 'templates' | 'stats' | 'config'

export interface CoIViewProps {
  /** slot 注入的插件 locale 翻译（文案一律经它取；键域 'coi.'）。 */
  t: Translate
}

export function CoIView(props: ConvViewProps & CoIViewProps): JSX.Element {
  const t = dict(props.t)
  // 当前 DSH 会话 id：层级可见性依据（临时/会话层级仅本会话可见）
  const sessionId = (props as { sessionId?: string }).sessionId
  const [sub, setSub] = useState<SubTab>('tasks')
  const tabs: { id: SubTab; key: DictKey }[] = [
    { id: 'guide', key: 'coi.guide' },
    { id: 'tasks', key: 'coi.tasks' },
    { id: 'sessions', key: 'coi.sessions' },
    { id: 'adapters', key: 'coi.adapters' },
    { id: 'templates', key: 'coi.templates' },
    { id: 'stats', key: 'coi.stats' },
    { id: 'config', key: 'coi.config' },
  ]
  return (
    <div className="coi-root">
      <div className="coi-tabs" role="tablist">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={sub === tab.id}
            className={`coi-tab${sub === tab.id ? ' coi-tab-active' : ''}`}
            onClick={() => setSub(tab.id)}
          >
            {t(tab.key)}
          </button>
        ))}
      </div>
      <div className="coi-body">
        {sub === 'guide' && <GuidePane t={props.t} />}
        {sub === 'tasks' && <TasksPane t={props.t} dsSessionId={sessionId} />}
        {sub === 'sessions' && <SessionsPane t={props.t} dsSessionId={sessionId} />}
        {sub === 'adapters' && <AdaptersPane t={props.t} />}
        {sub === 'templates' && <TemplatesPane t={props.t} />}
        {sub === 'stats' && <StatsPane t={props.t} />}
        {sub === 'config' && <ConfigPane t={props.t} />}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 使用指南                                                             */
/* ------------------------------------------------------------------ */

function GuidePane({ t: tt }: { t: Translate }): JSX.Element {
  const t = dict(tt)
  return (
    <div className="coi-pane">
      <div className="coi-card">
        <div className="coi-card-title">{t('coi.guide.title')}</div>
        <p className="coi-muted">{t('coi.guide.intro')}</p>
      </div>
      <div className="coi-card">
        <div className="coi-card-title">🚀 {t('coi.guide.use.title')}</div>
        <p className="coi-muted">{t('coi.guide.use.desc')}</p>
        <ul className="coi-guide-list">
          <li><strong>{t('coi.guide.use.ai')}</strong>{t('coi.guide.use.aiDesc')}</li>
          <li><strong>{t('coi.guide.use.slash')}</strong>{t('coi.guide.use.slashDesc')}</li>
          <li><strong>{t('coi.guide.use.tab')}</strong>{t('coi.guide.use.tabDesc')}</li>
        </ul>
      </div>
      <div className="coi-card">
        <div className="coi-card-title">🗂️ {t('coi.guide.scope.title')}</div>
        <p className="coi-muted">{t('coi.guide.scope.desc')}</p>
        <ul className="coi-guide-list">
          <li><strong>{t('coi.scope.temporary')}</strong>{t('coi.sep.colon')}{t('coi.guide.scope.temp')}</li>
          <li><strong>{t('coi.scope.session')}</strong>{t('coi.sep.colon')}{t('coi.guide.scope.session')}</li>
          <li><strong>{t('coi.scope.project')}</strong>{t('coi.sep.colon')}{t('coi.guide.scope.project')}</li>
          <li><strong>{t('coi.scope.global')}</strong>{t('coi.sep.colon')}{t('coi.guide.scope.global')}</li>
        </ul>
      </div>
      <div className="coi-card">
        <div className="coi-card-title">🧭 {t('coi.guide.skill.title')}</div>
        <p className="coi-muted">{t('coi.guide.skill.desc')}</p>
      </div>
      <div className="coi-card">
        <div className="coi-card-title">💡 {t('coi.guide.tips.title')}</div>
        <ul className="coi-guide-list">
          <li>{t('coi.guide.tips.1')}</li>
          <li>{t('coi.guide.tips.2')}</li>
          <li>{t('coi.guide.tips.3')}</li>
          <li>{t('coi.guide.tips.4')}</li>
        </ul>
      </div>
      <p className="coi-muted coi-pad">{t('coi.guide.loop')}</p>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 任务视图：发起表单 + 列表 + 详情/日志                                  */
/* ------------------------------------------------------------------ */

function TasksPane({ t: tt, dsSessionId }: { t: Translate; dsSessionId?: string }): JSX.Element {
  const t = dict(tt)
  /** 可见性 query：带 DSH 会话 id 时后端按层级过滤（临时/会话=本会话，项目=本会话 cwd）。 */
  const visQs = (dsSessionId ?? '') !== '' ? `&sessionId=${encodeURIComponent(String(dsSessionId))}` : ''
  const [adapters, setAdapters] = useState<Adapter[]>([])
  const [templates, setTemplates] = useState<CoiTemplate[]>([])
  const [sessions, setSessions] = useState<CoiSession[]>([])
  const [refTasks, setRefTasks] = useState<CoiTask[]>([])
  const [tasks, setTasks] = useState<CoiTask[] | null>(null)
  // 分页（任务列表）：page 从 1 起；total=后端返回的过滤后总数（算总页数）。
  // 搜索/翻页都会触发重新拉取；轮询刷新保持当前页。
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)

  // 发起表单
  const [adapterId, setAdapterId] = useState('kimi')
  const [prompt, setPrompt] = useState('')
  // 默认层级 session（仅发起会话可见，私有默认；用户拍板 2026-08-07）
  const [scope, setScope] = useState<string>('session')
  const [sessionId, setSessionId] = useState('')
  const [templateId, setTemplateId] = useState('')
  const [refTaskId, setRefTaskId] = useState('')
  const [launching, setLaunching] = useState(false)
  // 注入轨（memory=长期记忆 / user=用户档案 / key=项目关键记忆；与 scope 无关）
  const [injectTracks, setInjectTracks] = useState<string[]>([])
  const [ctxText, setCtxText] = useState('')
  // 发起表单默认收起（用户基本由 AI 派单，手动发起是少数）：给列表/详情更多高度
  const [launchOpen, setLaunchOpen] = useState(false)

  // 详情
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<CoiTask | null>(null)
  const [log, setLog] = useState('')
  const [logError, setLogError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [fullLog, setFullLog] = useState(false)
  const [fullPrompt, setFullPrompt] = useState(false)
  const [searchQ, setSearchQ] = useState('')
  const logRef = useRef<HTMLPreElement | null>(null)
  const fullLogRef = useRef<HTMLPreElement | null>(null)
  const selectedRef = useRef<string | null>(null)
  /** ME-9：日志「跟随底部」闸门（用户上滚后停止自动滚动）。 */
  const logFollow = useRef(createScrollFollow())
  /** ME-11：只认最新一次列表请求的序号闸门（搜索/翻页 vs 3s 轮询）。 */
  const tasksSeq = useRef(createLatestOnly())

  useEffect(() => {
    selectedRef.current = selectedId
  }, [selectedId])

  const loadTasks = useCallback(async (): Promise<void> => {
    // ME-11（2026-09-17 二审）：搜索/翻页请求与 3s 轮询共用这组 setState，
    // 必须只认最新一次请求 —— 旧请求后返回会把新筛选结果覆盖成旧列表
    // （搜索框里是 'fix'、列表却是未过滤的），最长 3s 后才被下轮轮询纠正。
    const isCurrent = tasksSeq.current.begin()
    try {
      const q = searchQ.trim()
      const data = await fetchJson<{ tasks: CoiTask[]; total: number }>(`/tasks?page=${page}&pageSize=${TASK_LIMIT}${visQs}${q !== '' ? `&q=${encodeURIComponent(q)}` : ''}`)
      if (!isCurrent()) return
      // 页码越界保护：当前页已无数据但总数 > 0（如删除了本页任务）→ 自动跳回最后一页
      if (data.tasks.length === 0 && data.total > 0 && page > 1) {
        setPage(Math.max(1, Math.ceil(data.total / TASK_LIMIT)))
        return
      }
      setTasks(data.tasks)
      setTotal(data.total)
      setError(null)
    } catch (err) {
      if (!isCurrent()) return
      setError(errText(err, t))
    }
  }, [searchQ, page])

  const loadDetail = useCallback(async (id: string): Promise<void> => {
    try {
      const data = await fetchJson<{ ok: boolean; task: CoiTask }>(`/tasks/${encodeURIComponent(id)}`)
      setDetail(data.task)
    } catch (err) {
      setNotice({ kind: 'error', text: errText(err, t) })
    }
  }, [])

  const removeTask = async (id: string): Promise<void> => {
    // 稳定版复审 P1-6：文案里的 {id} 占位符必须替换成真实任务 id，
    // 否则对话框显示字面量 {id}（旧版未替换，用户不知道删的是哪个任务）
    if (!window.confirm(t('coi.tasks.confirmDelete').replace('{id}',() => (id)))) return
    try {
      const res = await deleteJson<{ ok: boolean; message?: string }>(`/tasks/${encodeURIComponent(id)}`)
      if (res.ok !== true) {
        setNotice({ kind: 'error', text: msgOr(res.message, t('coi.tasks.deleteFailed')) })
        return
      }
      setSelectedId(null)
      setDetail(null)
      void loadTasks()
      setNotice({ kind: 'ok', text: res.message ?? t('coi.tasks.deleted') })
    } catch (err) {
      setNotice({ kind: 'error', text: errText(err, t) })
    }
  }

  const loadLog = useCallback(async (id: string): Promise<void> => {
    try {
      const data = await fetchJson<{ ok: boolean; text: string }>(`/tasks/${encodeURIComponent(id)}/log?tail=8000`)
      setLog(data.text)
      setLogError(null)
    } catch (err) {
      setLogError(errText(err, t))
    }
  }, [])

  // 列表 3s 轮询（TasksPane 卸载即停止）；顺带刷新已打开详情的元信息。
  useEffect(() => {
    void loadTasks()
    const timer = setInterval(() => {
      void loadTasks()
      const id = selectedRef.current
      if (id !== null) void loadDetail(id)
    }, TASKS_POLL_MS)
    return () => clearInterval(timer)
  }, [loadTasks, loadDetail])

  // 下拉数据源（适配器/模板/会话/可引用的已完成任务）。
  useEffect(() => {
    fetchJson<{ adapters: Adapter[] }>('/adapters')
      .then((data) => {
        setAdapters(data.adapters)
        setAdapterId((prev) => (data.adapters.some((a) => a.id === prev) ? prev : data.adapters[0]?.id ?? prev))
      })
      .catch(() => { /* 下拉留空，发起时由 host 报错 */ })
    fetchJson<{ templates: CoiTemplate[] }>('/templates')
      .then((data) => setTemplates(data.templates))
      .catch(() => { /* 同上 */ })
    fetchJson<{ sessions: CoiSession[] }>(`/sessions?${visQs.slice(1)}`)
      .then((data) => setSessions(data.sessions))
      .catch(() => { /* 同上 */ })
    fetchJson<{ tasks: CoiTask[] }>(`/tasks?status=completed&limit=50${visQs}`)
      .then((data) => setRefTasks(data.tasks))
      .catch(() => { /* 同上 */ })
  }, [])

  // 选中任务 → 拉详情与首屏日志。
  useEffect(() => {
    if (selectedId === null) {
      setDetail(null)
      return
    }
    setDetail(null)
    setLog('')
    setLogError(null)
    // ME-9：换任务=换日志，跟随状态复位（否则上一个任务里上滚过就再也不跟了）。
    logFollow.current.reset()
    void loadDetail(selectedId)
    void loadLog(selectedId)
  }, [selectedId, loadDetail, loadLog])

  const running = detail !== null && (detail.status === 'running' || detail.status === 'queued')

  // 日志 2s 轮询（仅运行中）；顺带刷新详情（最后输出时间/耗时时时更新）。
  useEffect(() => {
    if (selectedId === null || !running) return
    const timer = setInterval(() => {
      void loadLog(selectedId)
      void loadDetail(selectedId)
    }, LOG_POLL_MS)
    return () => clearInterval(timer)
  }, [selectedId, running, loadLog, loadDetail])

  // 日志自动滚到底部（详情 + 全屏弹窗）。
  // ME-9（2026-09-17 二审）：必须带「用户是否还在底部」的闸门 —— 旧写法
  // 每有新内容就无条件 scrollTop = scrollHeight，而运行中任务每 2s 轮询一次
  // ⇒ 用户上滚回读中段输出会被反复拽回底部（全屏弹窗同样）。用户滚回底部
  // 即自动恢复跟随；切换任务时重置为跟随（新日志从底部跟起）。
  useEffect(() => {
    logFollow.current.apply(logRef.current)
    logFollow.current.apply(fullLogRef.current)
  }, [log])
  const onLogScroll = (): void => {
    logFollow.current.onScroll(logRef.current)
    logFollow.current.onScroll(fullLogRef.current)
  }

  const applyTemplate = (id: string): void => {
    setTemplateId(id)
    const tpl = templates.find((item) => item.id === id)
    if (tpl !== undefined) {
      setPrompt(tpl.prompt)
      if (tpl.adapterId !== undefined) setAdapterId(tpl.adapterId)
      if (tpl.scope !== undefined) setScope(tpl.scope)
    }
  }

  const launch = async (): Promise<void> => {
    if (prompt.trim() === '') {
      setNotice({ kind: 'error', text: t('coi.launch.needPrompt') })
      return
    }
    setLaunching(true)
    try {
      const body: Record<string, unknown> = { adapterId, prompt, scope }
      if (scope !== 'temporary' && sessionId !== '') body.sessionId = sessionId
      if (templateId !== '') body.templateId = templateId
      if (refTaskId !== '') body.refTaskId = refTaskId
      const res = await postJson<{ ok: boolean; taskId?: string; message?: string }>('/tasks', {
        ...body,
        dsSessionId: dsSessionId ?? '',
        injectTracks: injectTracks.length > 0 ? injectTracks : undefined,
        contextText: ctxText.trim() === '' ? undefined : ctxText,
      })
      setNotice({ kind: 'ok', text: `${t('coi.launch.ok')}${res.taskId !== undefined ? `${t('coi.sep.colon')}${res.taskId}` : ''}` })
      setPrompt('')
      setTemplateId('')
      setRefTaskId('')
      void loadTasks()
      // 通知宿主层重查 COI Tab 红点（新任务立即可见，不等 30s 轮询）。
      window.dispatchEvent(new CustomEvent('dsh-memory-evolve:badge-change'))
    } catch (err) {
      setNotice({ kind: 'error', text: errText(err, t) })
    } finally {
      setLaunching(false)
    }
  }

  const kill = async (): Promise<void> => {
    if (detail === null) return
    if (!window.confirm(t('coi.tasks.confirmKill'))) return
    try {
      // 稳定版复审 P1-6：先发 force:false——host 对「正在写文件」等任务
      // 会返回确认提示而不是直接终止（跳过它会绕过安全检查）；被拒时
      // 把服务端提示原样给用户二次确认后再带 force 重发（catch 分支）。
      await postJson(`/tasks/${encodeURIComponent(detail.id)}/cancel`, { force: false })
      setNotice({ kind: 'ok', text: t('coi.tasks.killed') })
      void loadTasks()
      void loadDetail(detail.id)
    } catch (err) {
      // host 要求二次确认时：把确认提示原样透出，再带 force 重发。
      const msg = errText(err, t)
      if (window.confirm(msg)) {
        try {
          await postJson(`/tasks/${encodeURIComponent(detail.id)}/cancel`, { force: true })
          setNotice({ kind: 'ok', text: t('coi.tasks.killed') })
          void loadTasks()
          void loadDetail(detail.id)
        } catch (err2) {
          setNotice({ kind: 'error', text: errText(err2, t) })
        }
      }
    }
  }

  const retry = async (): Promise<void> => {
    if (detail === null) return
    try {
      const res = await postJson<{ ok: boolean; taskId?: string; message?: string }>(`/tasks/${encodeURIComponent(detail.id)}/retry`)
      setNotice({ kind: 'ok', text: res.message ?? `${t('coi.tasks.retried')}${res.taskId !== undefined ? `${t('coi.sep.colon')}${res.taskId}` : ''}` })
      void loadTasks()
    } catch (err) {
      setNotice({ kind: 'error', text: errText(err, t) })
    }
  }

  const copySession = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setNotice({ kind: 'error', text: t('coi.tasks.copyFail') })
    }
  }

  const detailDur = (task: CoiTask): number | null => {
    if (task.startedAt === null) return null
    if (task.finishedAt !== null) return task.finishedAt - task.startedAt
    if (task.status === 'running') return Date.now() - task.startedAt
    return null
  }

  return (
    <div className="coi-pane coi-tasks">
      <div className="coi-card">
        <div className="coi-card-head">
          <span className="coi-card-title">{t('coi.launch.title')}</span>
          <span className="coi-grow" />
          <button type="button" className="coi-btn coi-btn-mini" onClick={() => setLaunchOpen(!launchOpen)}>
            {launchOpen ? t('coi.launch.collapse') : t('coi.launch.expand')}
          </button>
        </div>
        {launchOpen && (
        <>
        <div className="coi-form-grid">
          <label className="coi-field">
            <span className="coi-label">{t('coi.launch.adapter')}</span>
            <select
              className="coi-select"
              value={adapterId}
              onChange={(e) => {
                const next = e.target.value
                setAdapterId(next)
                // 会话绑定适配器：切换适配器后，已选会话若不属于新适配器则清空，
                // 避免恢复会话时拿其他适配器的 session id 去调度（必然失败）
                if (sessionId !== '' && !sessions.some((s) => s.id === sessionId && s.adapterId === next)) {
                  setSessionId('')
                }
              }}
            >
              {adapters.map((a) => (
                <option key={a.id} value={a.id}>{a.name}{t('coi.sep.paren', { value: a.id })}</option>
              ))}
              {adapters.length === 0 && <option value={adapterId}>{adapterId}</option>}
            </select>
          </label>
          <label className="coi-field">
            <span className="coi-label">{t('coi.launch.scope')}</span>
            <select className="coi-select" value={scope} onChange={(e) => setScope(e.target.value)}>
              {SCOPES.map((s) => (
                <option key={s} value={s}>{t(`coi.scope.${s}` as DictKey)}</option>
              ))}
            </select>
          </label>
          {scope !== 'temporary' && (
            <label className="coi-field">
              <span className="coi-label">{t('coi.launch.session')}</span>
              {/* 会话属于某个适配器：只列当前适配器的会话（跨适配器恢复必然失败） */}
              <select className="coi-select" value={sessionId} onChange={(e) => setSessionId(e.target.value)}>
                <option value="">{t('coi.launch.sessionNone')}</option>
                {sessions.filter((s) => s.adapterId === adapterId).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.id}{t('coi.sep.paren', { value: `${s.adapterId}${s.note !== null && s.note !== '' ? ` · ${trunc(s.note, 12)}` : ''}` })}
                  </option>
                ))}
                {sessions.filter((s) => s.adapterId === adapterId).length === 0 && (
                  <option value="" disabled>{t('coi.launch.sessionEmpty')}</option>
                )}
              </select>
            </label>
          )}
          <label className="coi-field">
            <span className="coi-label">{t('coi.launch.template')}</span>
            <select className="coi-select" value={templateId} onChange={(e) => applyTemplate(e.target.value)}>
              <option value="">{t('coi.launch.templateNone')}</option>
              {templates.map((tpl) => (
                <option key={tpl.id} value={tpl.id}>{tpl.name}{t('coi.sep.paren', { value: tpl.id })}</option>
              ))}
            </select>
          </label>
          <label className="coi-field">
            <span className="coi-label">{t('coi.launch.ref')}</span>
            <select className="coi-select" value={refTaskId} onChange={(e) => setRefTaskId(e.target.value)}>
              <option value="">{t('coi.launch.refNone')}</option>
              {refTasks.map((task) => (
                <option key={task.id} value={task.id}>{task.id} · {trunc(task.prompt, 24)}</option>
              ))}
            </select>
          </label>
        </div>
        <label className="coi-field">
          <span className="coi-label">{t('coi.launch.prompt')}</span>
          <textarea
            className="coi-textarea coi-textarea-lg"
            rows={6}
            placeholder={t('coi.launch.promptPh')}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </label>
        <label className="coi-field coi-field-wide">
          <span className="coi-field-check">
            <span className="coi-label">{t('coi.launch.injectTracks')}</span>
          </span>
          <span className="coi-muted coi-small">{t('coi.launch.injectTracksHint')}</span>
        </label>
        <label className="coi-field coi-field-wide coi-inject-track-line">
          {(['memory', 'user', 'key'] as const).map((track) => (
            <span key={track} className="coi-field-check">
              <input
                type="checkbox"
                checked={injectTracks.includes(track)}
                onChange={(e) => setInjectTracks(
                  e.target.checked
                    ? [...injectTracks, track]
                    : injectTracks.filter((item) => item !== track),
                )}
              />
              <span className="coi-label">{track}</span>
            </span>
          ))}
        </label>
        {injectTracks.length > 0 && (
          <label className="coi-field coi-field-wide">
            <span className="coi-label">{t('coi.launch.ctxText')}</span>
            <textarea
              className="coi-textarea"
              rows={4}
              value={ctxText}
              onChange={(e) => setCtxText(e.target.value)}
              placeholder={t('coi.launch.ctxTextPh')}
            />
          </label>
        )}
        <div className="coi-form-actions">
          <button type="button" className="coi-btn coi-btn-primary" disabled={launching} onClick={() => void launch()}>
            {t('coi.launch.submit')}
          </button>
        </div>
        </>
        )}
      </div>

      <NoticeLine notice={notice} />

      <div className="coi-task-toolbar">
        <input
          className="coi-input"
          placeholder={t('coi.tasks.searchPh')}
          value={searchQ}
          onChange={(e) => {
            setSearchQ(e.target.value)
            // 搜索条件变化 → 回到第一页（否则可能落在过滤后的空页上）
            setPage(1)
          }}
        />
      </div>

      <div className="coi-split">
        <div className="coi-task-list">
          <ErrorLine error={error} />
          {tasks === null && error === null && <div className="coi-muted coi-pad">{t('coi.loading')}</div>}
          {tasks !== null && tasks.length === 0 && <div className="coi-muted coi-pad">{t('coi.tasks.empty')}</div>}
          {tasks?.map((task) => {
            const meta = statusMeta(task.status, t)
            return (
              <button
                key={task.id}
                type="button"
                className={`coi-task-row${selectedId === task.id ? ' coi-task-row-active' : ''}`}
                onClick={() => setSelectedId(task.id)}
              >
                <span className={`coi-task-status ${meta.cls}`} title={meta.label}>{meta.icon}</span>
                <span className="coi-mono coi-task-id">{task.id}</span>
                <span className="coi-task-adapter">{task.adapterId}</span>
                <span className="coi-task-prompt" title={task.prompt}>{trunc(task.prompt)}</span>
                <span className="coi-badge">{scopeLabel(task.scope, t)}</span>
                <span className="coi-muted coi-task-time">{fmtTime(task.createdAt)}</span>
              </button>
            )
          })}
          {/* 分页控件：任务超过一页时显示（上一页 / 当前页-总页数 · 共 N 条 / 下一页）。
              放列表容器内末尾：列表是滚动容器，控件随内容滚动到底可见。 */}
          {tasks !== null && total > TASK_LIMIT && (
            <div className="coi-pager">
              <button
                type="button"
                className="coi-btn coi-btn-mini"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                ‹ {t('coi.tasks.pager.prev')}
              </button>
              <span className="coi-pager-info">
                {page} / {Math.max(1, Math.ceil(total / TASK_LIMIT))} · {t('coi.tasks.pager.total')} {total}
              </span>
              <button
                type="button"
                className="coi-btn coi-btn-mini"
                disabled={page >= Math.max(1, Math.ceil(total / TASK_LIMIT))}
                onClick={() => setPage((p) => p + 1)}
              >
                {t('coi.tasks.pager.next')} ›
              </button>
            </div>
          )}
        </div>

        <div className="coi-detail">
          {selectedId === null && <div className="coi-muted coi-pad">{t('coi.tasks.selectHint')}</div>}
          {selectedId !== null && detail === null && <div className="coi-muted coi-pad">{t('coi.loading')}</div>}
          {detail !== null && (
            <>
              <div className="coi-detail-meta">
                <div className="coi-meta-row">
                  <span className="coi-label">{t('coi.tasks.status')}</span>
                  <span className={statusMeta(detail.status, t).cls}>
                    {statusMeta(detail.status, t).icon} {statusMeta(detail.status, t).label}
                  </span>
                </div>
                <div className="coi-meta-row">
                  <span className="coi-label">{t('coi.tasks.adapter')}</span>
                  <span>{detail.adapterId}</span>
                </div>
                <div className="coi-meta-row">
                  <span className="coi-label">{t('coi.tasks.scope')}</span>
                  <span className="coi-badge">{scopeLabel(detail.scope, t)}</span>
                </div>
                {detail.branch !== null && (
                  <div className="coi-meta-row">
                    <span className="coi-label">{t('coi.tasks.branch')}</span>
                    <span className="coi-mono">{detail.branch}</span>
                  </div>
                )}
                {detail.sessionId !== null && (
                  <div className="coi-meta-row">
                    <span className="coi-label">{t('coi.tasks.sessionId')}</span>
                    <span className="coi-mono coi-small">{detail.sessionId}</span>
                    <button type="button" className="coi-btn coi-btn-mini" onClick={() => void copySession(detail.sessionId ?? '')}>
                      {copied ? t('coi.tasks.copied') : t('coi.tasks.copy')}
                    </button>
                  </div>
                )}
                <div className="coi-meta-row">
                  <span className="coi-label">{t('coi.tasks.created')}</span>
                  <span>{fmtTime(detail.createdAt)}</span>
                </div>
                <div className="coi-meta-row">
                  <span className="coi-label">{t('coi.tasks.duration')}</span>
                  <span>{fmtDur(detailDur(detail))}</span>
                </div>
                {running && detail.lastOutputAt != null && (
                  <div className="coi-meta-row">
                    <span className="coi-label">{t('coi.tasks.lastOutput')}</span>
                    <span>{fmtAgo(detail.lastOutputAt, t)}</span>
                  </div>
                )}
                {detail.exitCode !== null && (
                  <div className="coi-meta-row">
                    <span className="coi-label">{t('coi.tasks.exitCode')}</span>
                    <span className="coi-mono">{detail.exitCode}</span>
                  </div>
                )}
              </div>
              <div className="coi-detail-actions">
                {running && (
                  <button type="button" className="coi-btn coi-btn-danger" onClick={() => void kill()}>
                    🛑 {t('coi.tasks.kill')}
                  </button>
                )}
                {!running && (
                  <button type="button" className="coi-btn" onClick={() => void retry()}>
                    ↻ {t('coi.tasks.retry')}
                  </button>
                )}
                {!running && (
                  <button type="button" className="coi-btn coi-btn-danger" onClick={() => void removeTask(detail.id)}>
                    🗑 {t('coi.tasks.delete')}
                  </button>
                )}
              </div>
              {detail.error !== null && detail.error !== '' && (
                <div className="coi-error">
                  {t('coi.tasks.error')}{t('coi.sep.colon')}{detail.error}
                </div>
              )}
              <div className="coi-log-head">
                <span className="coi-label coi-log-title">{t('coi.tasks.prompt')}</span>
                <button type="button" className="coi-btn coi-btn-mini" onClick={() => setFullPrompt(true)}>⛶ {t('coi.tasks.logFull')}</button>
              </div>
              <pre className="coi-prompt-view">{detail.prompt}</pre>
              <div className="coi-log-head">
                <span className="coi-label coi-log-title">{t('coi.tasks.log')}</span>
                <button type="button" className="coi-btn coi-btn-mini" onClick={() => setFullLog(true)}>⛶ {t('coi.tasks.logFull')}</button>
              </div>
              {logError !== null && <div className="coi-error">{logError}</div>}
              <pre ref={logRef} className="coi-log" onScroll={onLogScroll}>{log === '' ? t('coi.tasks.logEmpty') : log}</pre>
            </>
          )}
        </div>
      </div>
      {fullPrompt && detail !== null && (
        <div className="coi-modal" onClick={() => setFullPrompt(false)}>
          <div className="coi-modal-box" onClick={(e) => e.stopPropagation()}>
            <div className="coi-modal-head">
              <span className="coi-mono coi-small">{t('coi.tasks.prompt')} — {detail.id}</span>
              <button type="button" className="coi-btn coi-btn-mini" onClick={() => setFullPrompt(false)}>✕</button>
            </div>
            <pre className="coi-log coi-log-full coi-prompt-view-full">{detail.prompt}</pre>
          </div>
        </div>
      )}
      {fullLog && detail !== null && (
        <div className="coi-modal" onClick={() => setFullLog(false)}>
          <div className="coi-modal-box" onClick={(e) => e.stopPropagation()}>
            <div className="coi-modal-head">
              <span className="coi-mono coi-small">{t('coi.tasks.log')} — {t('coi.sep.paren', { value: `${detail.id} ${detail.adapterId} ${scopeLabel(detail.scope, t)}` })}</span>
              <button type="button" className="coi-btn coi-btn-mini" onClick={() => setFullLog(false)}>✕</button>
            </div>
            <pre ref={fullLogRef} className="coi-log coi-log-full" onScroll={onLogScroll}>{log === '' ? t('coi.tasks.logEmpty') : log}</pre>
          </div>
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 会话视图                                                             */
/* ------------------------------------------------------------------ */

function SessionsPane({ t: tt, dsSessionId }: { t: Translate; dsSessionId?: string }): JSX.Element {
  const t = dict(tt)
  const visQs = (dsSessionId ?? '') !== '' ? `&sessionId=${encodeURIComponent(String(dsSessionId))}` : ''
  const [sessions, setSessions] = useState<CoiSession[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [scopeFilter, setScopeFilter] = useState('')
  const [q, setQ] = useState('')
  const [editId, setEditId] = useState<string | null>(null)
  const [noteDraft, setNoteDraft] = useState('')
  /** ME-11：只认最新一次列表请求（范围过滤/搜索连续变更时丢弃旧响应）。 */
  const sessionsSeq = useRef(createLatestOnly())

  const load = useCallback(async (): Promise<void> => {
    const isCurrent = sessionsSeq.current.begin()
    try {
      const params = new URLSearchParams()
      // 参数名必须与宿主一致：lib/coi/api.js 只读 ?scope / ?q（不是字典键，
      // 不加 coi. 前缀——2026-09-17 i18n 批量加前缀时误伤过这两处）。
      if (scopeFilter !== '') params.set('scope', scopeFilter)
      if (q.trim() !== '') params.set('q', q.trim())
      const data = await fetchJson<{ sessions: CoiSession[] }>(`/sessions?${params.toString()}${visQs}`)
      if (!isCurrent()) return
      setSessions(data.sessions)
      setError(null)
    } catch (err) {
      if (!isCurrent()) return
      setError(errText(err, t))
    }
  }, [scopeFilter, q])

  useEffect(() => {
    void load()
  }, [load])

  const saveNote = async (id: string): Promise<void> => {
    try {
      await postJson('/sessions/note', { id, note: noteDraft })
      setEditId(null)
      setNotice({ kind: 'ok', text: t('coi.config.saved') })
      void load()
    } catch (err) {
      setNotice({ kind: 'error', text: errText(err, t) })
    }
  }

  const remove = async (id: string): Promise<void> => {
    if (!window.confirm(t('coi.sessions.confirmDelete'))) return
    try {
      await deleteJson(`/sessions/${encodeURIComponent(id)}`)
      void load()
    } catch (err) {
      setNotice({ kind: 'error', text: errText(err, t) })
    }
  }

  return (
    <div className="coi-pane">
      <div className="coi-toolbar">
        <select className="coi-select" value={scopeFilter} onChange={(e) => setScopeFilter(e.target.value)} title={t('coi.sessions.filterScope')}>
          <option value="">{t('coi.all')}</option>
          {SCOPES.map((s) => (
            <option key={s} value={s}>{t(`coi.scope.${s}` as DictKey)}</option>
          ))}
        </select>
        <input
          className="coi-input"
          placeholder={t('coi.sessions.searchPh')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <button type="button" className="coi-btn" onClick={() => void load()}>{t('coi.refresh')}</button>
      </div>
      <NoticeLine notice={notice} />
      <ErrorLine error={error} />
      {sessions === null && error === null && <div className="coi-muted coi-pad">{t('coi.loading')}</div>}
      {sessions !== null && sessions.length === 0 && <div className="coi-muted coi-pad">{t('coi.sessions.empty')}</div>}
      {sessions?.map((s) => (
        <div key={s.id} className="coi-row">
          <div className="coi-row-line">
            <span className="coi-mono coi-small">{s.id}</span>
            {s.activeTaskId !== null && s.activeTaskId !== '' && (
              <span title={`${t('coi.sessions.locked')}${t('coi.sep.colon')}${s.activeTaskId}`}>🔒</span>
            )}
            <span className="coi-badge">{scopeLabel(s.scope, t)}</span>
            <span>{s.adapterId}</span>
            {s.branch !== null && <span className="coi-muted coi-mono coi-small">{s.branch}</span>}
            <span className="coi-muted coi-small">{t('coi.sessions.lastSeen')} {fmtTime(s.lastSeen)}</span>
          </div>
          <div className="coi-row-line">
            {editId === s.id ? (
              <>
                <input
                  className="coi-input coi-grow"
                  value={noteDraft}
                  onChange={(e) => setNoteDraft(e.target.value)}
                  placeholder={t('coi.sessions.note')}
                />
                <button type="button" className="coi-btn coi-btn-mini" onClick={() => void saveNote(s.id)}>{t('coi.sessions.save')}</button>
              </>
            ) : (
              <>
                <span className="coi-muted coi-grow">{s.note !== null && s.note !== '' ? s.note : '—'}</span>
                <button
                  type="button"
                  className="coi-btn coi-btn-mini"
                  onClick={() => {
                    setEditId(s.id)
                    setNoteDraft(s.note ?? '')
                  }}
                >
                  {t('coi.sessions.note')}
                </button>
              </>
            )}
            <button type="button" className="coi-btn coi-btn-mini coi-btn-danger" onClick={() => void remove(s.id)}>
              {t('coi.sessions.delete')}
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 适配器视图                                                           */
/* ------------------------------------------------------------------ */

function AdaptersPane({ t: tt }: { t: Translate }): JSX.Element {
  const t = dict(tt)
  const [adapters, setAdapters] = useState<Adapter[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [guideOpen, setGuideOpen] = useState<string | null>(null)
  // 技能编辑（指南 = 关联技能的 SKILL.md）
  const [skillEditId, setSkillEditId] = useState<string | null>(null)
  const [skillEditName, setSkillEditName] = useState('')
  const [skillContent, setSkillContent] = useState('')
  const [skillSaving, setSkillSaving] = useState(false)
  const [skillError, setSkillError] = useState<string | null>(null)
  // useCase 行内编辑
  const [useCaseEditId, setUseCaseEditId] = useState<string | null>(null)
  const [useCaseDraft, setUseCaseDraft] = useState('')

  // 添加表单
  const [fId, setFId] = useState('')
  const [fName, setFName] = useState('')
  const [fType, setFType] = useState<'ai-cli' | 'plain-cli'>('ai-cli')
  const [fBinary, setFBinary] = useState('')
  const [fArgs, setFArgs] = useState('')
  const [fSkill, setFSkill] = useState('')
  const [fUseCase, setFUseCase] = useState('')
  const [fSkillContent, setFSkillContent] = useState('')
  // ai-cli 专属：会话恢复配置（resume 必填，continue/提取可选）
  const [fResumeKind, setFResumeKind] = useState<'flag' | 'args'>('flag')
  const [fResumeFlag, setFResumeFlag] = useState('')
  const [fResumeArg, setFResumeArg] = useState('')
  const [fResumeArgs, setFResumeArgs] = useState('')
  const [fContinueFlag, setFContinueFlag] = useState('')
  const [fExtractSource, setFExtractSource] = useState<'stdout' | 'stderr' | 'any' | 'none'>('none')
  const [fExtractRegex, setFExtractRegex] = useState('')
  const [adding, setAdding] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    try {
      const data = await fetchJson<{ adapters: Adapter[] }>('/adapters')
      setAdapters(data.adapters)
      setError(null)
    } catch (err) {
      setError(errText(err, t))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const test = async (id: string): Promise<void> => {
    try {
      const res = await postJson<{ ok: boolean; taskId?: string; message?: string }>('/adapters/test', { id })
      setNotice({ kind: 'ok', text: `${t('coi.adapters.testOk')}${res.taskId !== undefined ? `${t('coi.sep.colon')}${res.taskId}` : ''}${res.message !== undefined ? t('coi.sep.paren', { value: res.message }) : ''}` })
    } catch (err) {
      setNotice({ kind: 'error', text: errText(err, t) })
    }
  }

  const remove = async (id: string): Promise<void> => {
    if (!window.confirm(t('coi.adapters.confirmDelete'))) return
    try {
      const res = await deleteJson<{ ok: boolean; message?: string }>(`/adapters/${encodeURIComponent(id)}`)
      if (res.ok === false) {
        setNotice({ kind: 'error', text: msgOr(res.message, 'ok:false') })
        return
      }
      void load()
    } catch (err) {
      setNotice({ kind: 'error', text: errText(err, t) })
    }
  }

  const saveUseCase = async (a: Adapter): Promise<void> => {
    try {
      // 发送完整定义（...a 含 resume/continue/sessionIdExtract 等全部字段），
      // 只覆盖 useCase——后端按完整定义校验，避免部分字段被拒
      const def = { ...a, useCase: useCaseDraft.trim() }
      const res = await postJson<{ ok: boolean; message?: string }>('/adapters', { def })
      if (res.ok !== true) {
        setNotice({ kind: 'error', text: msgOr(res.message, t('coi.adapters.saveFailed')) })
        return
      }
      setUseCaseEditId(null)
      void load()
    } catch (err) {
      setNotice({ kind: 'error', text: errText(err, t) })
    }
  }

  const toggleEnabled = async (a: Adapter): Promise<void> => {
    try {
      const next = a.enabled === false
      const res = await postJson<{ ok: boolean; message?: string }>(`/adapters/${encodeURIComponent(a.id)}/enabled`, { enabled: next })
      if (res.ok !== true) {
        setNotice({ kind: 'error', text: msgOr(res.message, t('coi.adapters.opFailed')) })
        return
      }
      void load()
    } catch (err) {
      setNotice({ kind: 'error', text: errText(err, t) })
    }
  }

  // 技能编辑：指南 = 关联技能的 SKILL.md（源头在插件，技能管理 Tab 可禁用）
  const openSkillEdit = async (a: Adapter): Promise<void> => {
    setSkillError(null)
    setSkillEditName(a.skillName ?? '')
    setSkillContent('')
    setSkillEditId(a.id)
    try {
      const res = await fetchJson<{ ok: boolean; skillName?: string; exists?: boolean; content?: string; message?: string }>(`/adapters/${encodeURIComponent(a.id)}/skill`)
      if (res.ok !== true) {
        setSkillError(msgOr(res.message, t('coi.adapters.readFailed')))
        return
      }
      setSkillEditName(res.skillName ?? '')
      setSkillContent(res.content ?? '')
    } catch (err) {
      setSkillError(errText(err, t))
    }
  }

  const saveSkill = async (): Promise<void> => {
    if (skillEditId === null) return
    setSkillSaving(true)
    setSkillError(null)
    try {
      const res = await fetchJson<{ ok: boolean; message?: string }>(`/adapters/${encodeURIComponent(skillEditId)}/skill`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: skillContent }),
      })
      if (res.ok !== true) {
        setSkillError(msgOr(res.message, t('coi.adapters.saveFailed')))
        return
      }
      setNotice({ kind: 'ok', text: res.message ?? t('coi.adapters.skillSaved') })
      setSkillEditId(null)
      setSkillContent('')
    } catch (err) {
      setSkillError(errText(err, t))
    } finally {
      setSkillSaving(false)
    }
  }

  const add = async (): Promise<void> => {
    // 前端预校验：ai-cli 必须有 resume（与后端 validateAdapter 一致，省一次往返）
    if (fType === 'ai-cli') {
      const resumeEmpty = fResumeKind === 'flag' ? fResumeFlag.trim() === '' : fResumeArgs.trim() === ''
      if (resumeEmpty) {
        setNotice({ kind: 'error', text: t('coi.adapters.resumeMissing') })
        return
      }
    }
    setAdding(true)
    try {
      const def: Record<string, unknown> = {
        id: fId.trim(),
        name: fName.trim(),
        type: fType,
        binary: fBinary.trim(),
        args: fArgs.split(',').map((s) => s.trim()).filter((s) => s !== ''),
        skillName: fSkill.trim() === '' ? undefined : fSkill.trim(),
        useCase: fUseCase.trim() === '' ? undefined : fUseCase.trim(),
      }
      if (fType === 'ai-cli') {
        // resume 必填：flag 模式（flag+arg 插在基础参数前）/ args 模式（完整恢复命令）
        // arg 留空默认 {sessionId}——调度器用它替换会话 id
        def.resume = fResumeKind === 'flag'
          ? { kind: 'flag', flag: fResumeFlag.trim(), arg: fResumeArg.trim() === '' ? '{sessionId}' : fResumeArg.trim() }
          : { kind: 'args', args: fResumeArgs.split(',').map((s) => s.trim()).filter((s) => s !== '') }
        if (fContinueFlag.trim() !== '') def.continue = { kind: 'flag', flag: fContinueFlag.trim() }
        if (fExtractSource !== 'none' && fExtractRegex.trim() !== '') {
          def.sessionIdExtract = { source: fExtractSource, regex: fExtractRegex.trim() }
        }
      }
      const skillContent = fSkill.trim() !== '' && fSkillContent.trim() !== '' ? fSkillContent : undefined
      const res = await postJson<{ ok: boolean; message?: string; skillMessage?: string | null }>('/adapters', { def, skillContent })
      if (res.ok !== true) {
        setNotice({ kind: 'error', text: msgOr(res.message, t('coi.adapters.saveFailed')) })
        return
      }
      // ME-3（2026-09-17 二审）：宿主在「技能名留空」这条常见路径上回的是
      // 裸 `skillMessage: null`（不是缺字段），只判 !== undefined 会把这句
      // 空值当成提示正文 ⇒ NoticeLine 渲染成一条空绿条，用户看不到「已保存」。
      // 判据收紧为「非空字符串」，否则回落通用保存成功文案。
      const skillMessage = typeof res.skillMessage === 'string' && res.skillMessage !== '' ? res.skillMessage : null
      setNotice({ kind: 'ok', text: skillMessage ?? t('coi.config.saved') })
      setFId('')
      setFName('')
      setFBinary('')
      setFArgs('')
      setFUseCase('')
      // 清空 ai-cli 会话恢复配置（类型/恢复方式保留，方便连续添加同类适配器）
      setFResumeFlag('')
      setFResumeArg('')
      setFResumeArgs('')
      setFContinueFlag('')
      setFExtractRegex('')
      void load()
    } catch (err) {
      setNotice({ kind: 'error', text: errText(err, t) })
    } finally {
      setAdding(false)
    }
  }

  return (
    <div className="coi-pane">
      <NoticeLine notice={notice} />
      <ErrorLine error={error} />
      {adapters === null && error === null && <div className="coi-muted coi-pad">{t('coi.loading')}</div>}
      <div className="coi-cards">
        {adapters?.map((a) => {
          const builtin = BUILTIN_ADAPTER_IDS.has(a.id)
          return (
            <div key={a.id} className="coi-card coi-adapter-card">
              <div className="coi-row-line">
                <span className="coi-strong">{a.name}</span>
                <span className="coi-mono coi-small coi-muted">{a.id}</span>
                <span className="coi-badge">{a.type}</span>
                <span className="coi-badge">{builtin ? t('coi.adapters.builtin') : t('coi.adapters.custom')}</span>
                <span className="coi-grow" />
                {a.skillName !== undefined && a.skillName !== '' && (
                  <span className="coi-muted coi-small coi-skill-tag" title={t('coi.adapters.skillHint')}>
                    {t('coi.adapters.skill')}{t('coi.sep.colon')}{a.skillName}
                  </span>
                )}
                {a.skillName !== undefined && a.skillName !== '' && (
                  <button type="button" className="coi-btn coi-btn-mini" onClick={() => void openSkillEdit(a)}>
                    {t('coi.adapters.skillBtn')}
                  </button>
                )}
                {/* ME-5（2026-09-17 二审）：guideOpen 此前没有任何 setter —— 宿主
                    每个内置适配器都下发多行 markdown guide（adapters.js 注释写明
                    「GUI 可查看」），渲染分支与样式都在，唯独缺触发入口 ⇒ 指南
                    整体不可达（死 UI）。这里补上唯一开关。 */}
                {typeof a.guide === 'string' && a.guide !== '' && (
                  <button
                    type="button"
                    className="coi-btn coi-btn-mini"
                    aria-expanded={guideOpen === a.id}
                    onClick={() => setGuideOpen(guideOpen === a.id ? null : a.id)}
                  >
                    {t('coi.adapters.guide')}
                  </button>
                )}
                <button
                  type="button"
                  className={`coi-btn coi-btn-mini${a.enabled === false ? ' coi-btn-danger' : ''}`}
                  onClick={() => void toggleEnabled(a)}
                >
                  {a.enabled === false ? t('coi.adapters.enable') : t('coi.adapters.disable')}
                </button>
                <button type="button" className="coi-btn coi-btn-mini" onClick={() => void test(a.id)}>
                  {t('coi.adapters.test')}
                </button>
                {!builtin && (
                  <button type="button" className="coi-btn coi-btn-mini coi-btn-danger" onClick={() => void remove(a.id)}>
                    {t('coi.adapters.delete')}
                  </button>
                )}
              </div>
              <div className="coi-row-line coi-muted coi-small">
                <span className="coi-mono">{a.binary}</span>
                {a.args.length > 0 && <span className="coi-mono">{a.args.join(' ')}</span>}
                {/* 平均完成耗时（有完成记录才显示）：分钟一位小数，与工具 render 同格式 */}
                {a.avgMs !== undefined && a.avgMs > 0 && (
                  <span className="coi-avg-ms" title={t('coi.adapters.avgMsTitle')}>
                    {t('coi.adapters.avgMs', { minutes: (a.avgMs / 60000).toFixed(1) })}
                  </span>
                )}
              </div>
              <div className="coi-row-line coi-muted coi-small">
                {useCaseEditId === a.id ? (
                  <>
                    <span>🎯</span>
                    <input
                      className="coi-input coi-grow"
                      value={useCaseDraft}
                      onChange={(e) => setUseCaseDraft(e.target.value)}
                      placeholder={t('coi.adapters.useCasePh')}
                    />
                    <button type="button" className="coi-btn coi-btn-mini coi-btn-primary" onClick={() => void saveUseCase(a)}>{t('coi.adapters.saveUseCase')}</button>
                    <button type="button" className="coi-btn coi-btn-mini" onClick={() => setUseCaseEditId(null)}>{t('coi.cancel')}</button>
                  </>
                ) : (
                  <>
                    <span className="coi-grow">🎯 {a.useCase !== undefined && a.useCase !== '' ? a.useCase : t('coi.adapters.useCaseEmpty')}</span>
                    <button
                      type="button"
                      className="coi-btn coi-btn-mini"
                      onClick={() => { setUseCaseEditId(a.id); setUseCaseDraft(a.useCase ?? '') }}
                    >
                      {t('coi.adapters.editUseCase')}
                    </button>
                  </>
                )}
              </div>
              {a.enabled === false && (
                <div className="coi-row-line coi-error">
                  <span>⛔ {t('coi.adapters.disabledHint')}</span>
                </div>
              )}
              {guideOpen === a.id && a.guide !== undefined && <pre className="coi-guide">{a.guide}</pre>}
            </div>
          )
        })}
      </div>

      <div className="coi-card">
        <div className="coi-card-title">{t('coi.adapters.addTitle')}</div>
        <div className="coi-form-grid">
          <label className="coi-field">
            <span className="coi-label">id</span>
            <input className="coi-input" value={fId} onChange={(e) => setFId(e.target.value)} placeholder="my-cli" />
          </label>
          <label className="coi-field">
            <span className="coi-label">{t('coi.adapters.name')}</span>
            <input className="coi-input" value={fName} onChange={(e) => setFName(e.target.value)} />
          </label>
          <label className="coi-field">
            <span className="coi-label">{t('coi.adapters.type')}</span>
            <select className="coi-select" value={fType} onChange={(e) => setFType(e.target.value as 'ai-cli' | 'plain-cli')}>
              <option value="ai-cli">ai-cli</option>
              <option value="plain-cli">plain-cli</option>
            </select>
          </label>
          <label className="coi-field">
            <span className="coi-label">{t('coi.adapters.binary')}</span>
            <input className="coi-input" value={fBinary} onChange={(e) => setFBinary(e.target.value)} placeholder="/usr/local/bin/my-cli" />
          </label>
          <label className="coi-field coi-field-wide">
            <span className="coi-label">{t('coi.adapters.args')}</span>
            <input className="coi-input" value={fArgs} onChange={(e) => setFArgs(e.target.value)} placeholder={t('coi.adapters.argsPh')} />
          </label>
          <label className="coi-field coi-field-wide">
            <span className="coi-label">{t('coi.adapters.skillName')}</span>
            <input className="coi-input" value={fSkill} onChange={(e) => setFSkill(e.target.value)} placeholder={t('coi.adapters.skillNamePh')} />
          </label>
          <label className="coi-field coi-field-wide">
            <span className="coi-label">{t('coi.adapters.useCase')}</span>
            <input className="coi-input" value={fUseCase} onChange={(e) => setFUseCase(e.target.value)} placeholder={t('coi.adapters.useCasePh')} />
          </label>
          {fType === 'ai-cli' && (
            <>
              {/* ai-cli 会话恢复配置：后端 validateAdapter 强制 ai-cli 必须有 resume，
                  这里提供对应输入，避免"手动添加 AI 适配器保存被拒" */}
              <div className="coi-field coi-field-wide coi-resume-section">
                <span className="coi-label">{t('coi.adapters.resumeSection')}</span>
                <span className="coi-muted coi-small">{t('coi.adapters.resumeSectionHint')}</span>
              </div>
              <label className="coi-field">
                <span className="coi-label">{t('coi.adapters.resumeKind')}</span>
                <select className="coi-select" value={fResumeKind} onChange={(e) => setFResumeKind(e.target.value as 'flag' | 'args')}>
                  <option value="flag">{t('coi.adapters.resumeKindFlag')}</option>
                  <option value="args">{t('coi.adapters.resumeKindArgs')}</option>
                </select>
              </label>
              {fResumeKind === 'flag' ? (
                <>
                  <label className="coi-field">
                    <span className="coi-label">{t('coi.adapters.resumeFlag')}</span>
                    <input className="coi-input" value={fResumeFlag} onChange={(e) => setFResumeFlag(e.target.value)} placeholder={t('coi.adapters.resumeFlagPh')} />
                  </label>
                  <label className="coi-field">
                    <span className="coi-label">{t('coi.adapters.resumeArg')}</span>
                    <input className="coi-input" value={fResumeArg} onChange={(e) => setFResumeArg(e.target.value)} placeholder={t('coi.adapters.resumeArgPh')} />
                  </label>
                </>
              ) : (
                <label className="coi-field coi-field-wide">
                  <span className="coi-label">{t('coi.adapters.resumeArgs')}</span>
                  <input className="coi-input" value={fResumeArgs} onChange={(e) => setFResumeArgs(e.target.value)} placeholder={t('coi.adapters.resumeArgsPh')} />
                </label>
              )}
              <label className="coi-field coi-field-wide">
                <span className="coi-label">{t('coi.adapters.continueFlag')}</span>
                <input className="coi-input" value={fContinueFlag} onChange={(e) => setFContinueFlag(e.target.value)} placeholder={t('coi.adapters.continueFlagPh')} />
              </label>
              <div className="coi-field coi-field-wide coi-resume-section">
                <span className="coi-label">{t('coi.adapters.extractSection')}</span>
              </div>
              <label className="coi-field">
                <span className="coi-label">{t('coi.adapters.extractSource')}</span>
                <select className="coi-select" value={fExtractSource} onChange={(e) => setFExtractSource(e.target.value as 'stdout' | 'stderr' | 'any' | 'none')}>
                  <option value="none">none</option>
                  <option value="stdout">stdout</option>
                  <option value="stderr">stderr</option>
                  <option value="any">any</option>
                </select>
              </label>
              {fExtractSource !== 'none' && (
                <label className="coi-field coi-field-wide">
                  <span className="coi-label">{t('coi.adapters.extractRegex')}</span>
                  <input className="coi-input" value={fExtractRegex} onChange={(e) => setFExtractRegex(e.target.value)} placeholder={t('coi.adapters.extractRegexPh')} />
                </label>
              )}
            </>
          )}
          {fSkill.trim() !== '' && (
            <label className="coi-field coi-field-wide">
              <span className="coi-label">{t('coi.adapters.skillContent')}</span>
              <textarea
                className="coi-textarea"
                rows={5}
                value={fSkillContent}
                onChange={(e) => setFSkillContent(e.target.value)}
                placeholder={t('coi.adapters.skillContentPh')}
              />
              <span className="coi-muted coi-small">{t('coi.adapters.skillContentHint')}</span>
            </label>
          )}
        </div>
        <div className="coi-form-actions">
          {/* ai-cli 必填 resume：缺失时禁用添加按钮（与 add() 内预校验一致） */}
          <button
            type="button"
            className="coi-btn coi-btn-primary"
            disabled={adding
              || fId.trim() === ''
              || fName.trim() === ''
              || fBinary.trim() === ''
              || (fType === 'ai-cli' && (fResumeKind === 'flag' ? fResumeFlag.trim() === '' : fResumeArgs.trim() === ''))}
            onClick={() => void add()}
          >
            {t('coi.adapters.add')}
          </button>
        </div>
      </div>

      {/* 技能编辑弹窗：指南 = 关联技能的 SKILL.md */}
      {skillEditId !== null && (
        <div className="coi-modal" onClick={() => setSkillEditId(null)}>
          <div className="coi-modal-box" onClick={(e) => e.stopPropagation()}>
            <div className="coi-modal-head">
              <span className="coi-small">{t('coi.adapters.editSkillTitle')}{t('coi.sep.colon')}{skillEditName}</span>
              <button type="button" className="coi-btn coi-btn-mini" onClick={() => setSkillEditId(null)}>✕</button>
            </div>
            {skillError !== null && <div className="coi-error coi-pad">{skillError}</div>}
            <div className="coi-pad coi-muted coi-small">{t('coi.adapters.editSkillHint')}</div>
            <textarea
              className="coi-textarea coi-skill-editor"
              value={skillContent}
              onChange={(e) => setSkillContent(e.target.value)}
              placeholder="# SKILL.md"
            />
            <div className="coi-modal-head">
              <button type="button" className="coi-btn coi-btn-mini" onClick={() => setSkillEditId(null)}>{t('coi.cancel')}</button>
              <button type="button" className="coi-btn coi-btn-primary coi-btn-mini" disabled={skillSaving} onClick={() => void saveSkill()}>
                {skillSaving ? t('coi.saving') : t('coi.adapters.saveSkill')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 模板视图                                                             */
/* ------------------------------------------------------------------ */

function TemplatesPane({ t: tt }: { t: Translate }): JSX.Element {
  const t = dict(tt)
  const [templates, setTemplates] = useState<CoiTemplate[] | null>(null)
  const [adapters, setAdapters] = useState<Adapter[]>([])
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)

  const [fId, setFId] = useState('')
  const [fName, setFName] = useState('')
  const [fPrompt, setFPrompt] = useState('')
  const [fAdapterId, setFAdapterId] = useState('')
  const [adding, setAdding] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    try {
      const data = await fetchJson<{ templates: CoiTemplate[] }>('/templates')
      setTemplates(data.templates)
      setError(null)
    } catch (err) {
      setError(errText(err, t))
    }
  }, [])

  useEffect(() => {
    void load()
    fetchJson<{ adapters: Adapter[] }>('/adapters')
      .then((data) => setAdapters(data.adapters))
      .catch(() => { /* 下拉留空 */ })
  }, [load])

  const remove = async (id: string): Promise<void> => {
    if (BUILTIN_TEMPLATE_IDS.has(id)) {
      setNotice({ kind: 'error', text: t('coi.templates.builtinKeep') })
      return
    }
    if (!window.confirm(t('coi.templates.confirmDelete'))) return
    try {
      await deleteJson(`/templates/${encodeURIComponent(id)}`)
      void load()
    } catch (err) {
      setNotice({ kind: 'error', text: errText(err, t) })
    }
  }

  const add = async (): Promise<void> => {
    setAdding(true)
    try {
      const def: Record<string, unknown> = { name: fName.trim(), prompt: fPrompt }
      if (fId.trim() !== '') def.id = fId.trim()
      if (fAdapterId !== '') def.adapterId = fAdapterId
      await postJson('/templates', { def })
      setNotice({ kind: 'ok', text: t('coi.config.saved') })
      setFId('')
      setFName('')
      setFPrompt('')
      setFAdapterId('')
      void load()
    } catch (err) {
      setNotice({ kind: 'error', text: errText(err, t) })
    } finally {
      setAdding(false)
    }
  }

  return (
    <div className="coi-pane">
      <NoticeLine notice={notice} />
      <ErrorLine error={error} />
      {templates === null && error === null && <div className="coi-muted coi-pad">{t('coi.loading')}</div>}
      {templates !== null && templates.length === 0 && <div className="coi-muted coi-pad">{t('coi.templates.empty')}</div>}
      {templates?.map((tpl) => (
        <div key={tpl.id} className="coi-row">
          <div className="coi-row-line">
            <span className="coi-strong">{tpl.name}</span>
            <span className="coi-mono coi-small coi-muted">{tpl.id}</span>
            {tpl.adapterId !== undefined && <span className="coi-badge">{tpl.adapterId}</span>}
            {BUILTIN_TEMPLATE_IDS.has(tpl.id) && <span className="coi-badge">{t('coi.adapters.builtin')}</span>}
            <span className="coi-grow" />
            <button type="button" className="coi-btn coi-btn-mini coi-btn-danger" onClick={() => void remove(tpl.id)}>
              {t('coi.templates.delete')}
            </button>
          </div>
          <div className="coi-row-line coi-muted" title={tpl.prompt}>{trunc(tpl.prompt, 80)}</div>
        </div>
      ))}

      <div className="coi-card">
        <div className="coi-card-title">{t('coi.templates.addTitle')}</div>
        <div className="coi-form-grid">
          <label className="coi-field">
            <span className="coi-label">{t('coi.templates.name')}</span>
            <input className="coi-input" value={fName} onChange={(e) => setFName(e.target.value)} />
          </label>
          <label className="coi-field">
            <span className="coi-label">{t('coi.templates.adapterOpt')}</span>
            <select className="coi-select" value={fAdapterId} onChange={(e) => setFAdapterId(e.target.value)}>
              <option value="">{t('coi.none')}</option>
              {adapters.map((a) => (
                <option key={a.id} value={a.id}>{a.id}</option>
              ))}
            </select>
          </label>
          <label className="coi-field coi-field-wide">
            <span className="coi-label">{t('coi.templates.idOpt')}</span>
            <input className="coi-input" value={fId} onChange={(e) => setFId(e.target.value)} placeholder="my-template" />
          </label>
        </div>
        <label className="coi-field">
          <span className="coi-label">{t('coi.templates.prompt')}</span>
          <textarea className="coi-textarea" rows={3} value={fPrompt} onChange={(e) => setFPrompt(e.target.value)} />
        </label>
        <div className="coi-form-actions">
          <button type="button" className="coi-btn coi-btn-primary" disabled={adding || fName.trim() === '' || fPrompt.trim() === ''} onClick={() => void add()}>
            {t('coi.templates.add')}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 统计视图                                                             */
/* ------------------------------------------------------------------ */

function StatsPane({ t: tt }: { t: Translate }): JSX.Element {
  const t = dict(tt)
  const [stats, setStats] = useState<CoiStats | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      const data = await fetchJson<CoiStats>('/stats')
      setStats(data)
      setError(null)
    } catch (err) {
      setError(errText(err, t))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="coi-pane">
      <div className="coi-toolbar">
        <button type="button" className="coi-btn" onClick={() => void load()}>{t('coi.refresh')}</button>
      </div>
      <ErrorLine error={error} />
      {stats === null && error === null && <div className="coi-muted coi-pad">{t('coi.loading')}</div>}
      {stats !== null && (
        <>
          <div className="coi-stat-grid">
            <div className="coi-stat-card">
              <div className="coi-stat-num">{stats.total}</div>
              <div className="coi-muted">{t('coi.stats.total')}</div>
            </div>
          </div>
          <div className="coi-stat-grid">
            {Object.entries(stats.byAdapter).map(([id, bucket]) => (
              <div key={id} className="coi-stat-card">
                <div className="coi-strong">{id}</div>
                <div className="coi-stat-num">{bucket.count}</div>
                <div className="coi-muted coi-small">
                  {t('coi.stats.count')} · {t('coi.stats.hours')} {(bucket.totalMs / 3600000).toFixed(2)}h
                </div>
                <div className="coi-row-line coi-small">
                  {Object.entries(bucket.byStatus).map(([status, count]) => {
                    const meta = statusMeta(status, t)
                    return (
                      <span key={status} className={meta.cls} title={meta.label}>
                        {meta.icon} {count}
                      </span>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
          {Object.keys(stats.byAdapter).length === 0 && <div className="coi-muted coi-pad">{t('coi.stats.empty')}</div>}
        </>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 配置视图                                                             */
/* ------------------------------------------------------------------ */

function ConfigPane({ t: tt }: { t: Translate }): JSX.Element {
  const t = dict(tt)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [notify, setNotify] = useState('')
  const [retention, setRetention] = useState('')
  const [timeoutH, setTimeoutH] = useState('')
  const [timeoutM, setTimeoutM] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    fetchJson<{ config: CoiConfig }>('/config')
      .then((data) => {
        setNotify(data.config.coiNotifyCommand ?? '')
        setRetention(String(data.config.coiRetentionDays ?? ''))
        const ms = data.config.coiTaskTimeoutMs ?? 0
        setTimeoutH(String(Math.floor(ms / 3600000)))
        setTimeoutM(String(Math.round((ms % 3600000) / 60000)))
        setLoaded(true)
      })
      .catch((err) => setError(errText(err, t)))
  }, [])

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const patch: Record<string, unknown> = { coiNotifyCommand: notify }
      const days = Number(retention)
      const h = Number(timeoutH)
      const m = Number(timeoutM)
      if (retention.trim() !== '' && Number.isFinite(days)) patch.coiRetentionDays = days
      if (timeoutH.trim() !== '' || timeoutM.trim() !== '') {
        const totalMinutes = (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0)
        if (!Number.isFinite(totalMinutes) || totalMinutes < 0) throw new Error(t('coi.config.timeoutBad'))
        patch.coiTaskTimeoutMs = totalMinutes * 60000
      }
      await postJson('/config', { patch })
      setNotice({ kind: 'ok', text: t('coi.config.saved') })
    } catch (err) {
      setNotice({ kind: 'error', text: errText(err, t) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="coi-pane">
      <NoticeLine notice={notice} />
      <ErrorLine error={error} />
      {!loaded && error === null && <div className="coi-muted coi-pad">{t('coi.loading')}</div>}
      {loaded && (
        <div className="coi-card">
          <label className="coi-field">
            <span className="coi-label">{t('coi.config.notify')}</span>
            <input className="coi-input" value={notify} onChange={(e) => setNotify(e.target.value)} />
            <span className="coi-muted coi-small">{t('coi.config.notifyHint')}</span>
          </label>
          <label className="coi-field">
            <span className="coi-label">{t('coi.config.retention')}</span>
            <input className="coi-input" type="number" min={0} value={retention} onChange={(e) => setRetention(e.target.value)} />
          </label>
          <label className="coi-field">
            <span className="coi-label">{t('coi.config.timeout')}</span>
            <div className="coi-inline">
              <input className="coi-input" type="number" min={0} value={timeoutH} onChange={(e) => setTimeoutH(e.target.value)} placeholder="0" />
              <span className="coi-muted coi-small">{t('coi.config.timeoutHours')}</span>
              <input className="coi-input" type="number" min={0} max={59} value={timeoutM} onChange={(e) => setTimeoutM(e.target.value)} placeholder="0" />
              <span className="coi-muted coi-small">{t('coi.config.timeoutMinutes')}</span>
            </div>
            <span className="coi-muted coi-small">{t('coi.config.timeoutHint')}</span>
          </label>
          <div className="coi-form-actions">
            <button type="button" className="coi-btn coi-btn-primary" disabled={saving} onClick={() => void save()}>
              {t('coi.config.save')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
