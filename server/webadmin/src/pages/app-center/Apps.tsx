import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { request, ADMIN_API } from '../../api'
import { Button } from '../../components/ui/button'
import { Badge } from '../../components/ui/badge'
import { Switch } from '../../components/ui/switch'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { Textarea } from '../../components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { EmptyState } from '../../components/empty-state'
import { PageHeader } from '../../components/page-header'
import { errorText } from '../../lib/api-error'
import { useFlash } from '../../lib/use-flash'
import { hasPermission, PERM_CAP_READ, PERM_CAP_WRITE } from '../../lib/rbac'
import { Boxes, Check, Eye, RefreshCw, Search, Stethoscope, UserCog, X } from 'lucide-react'

/**
 * 应用中心 · 应用(2026-09-19 页面合并):员工自建 WASM 应用的列表与平台级处置。
 *
 * 原 `/app-center` 单页(`pages/AppCenter.tsx`)的**列表部分**。同页顶部的
 * 「应用域名」卡片已搬进本分区的设置页(`./Settings.tsx`),并发/内存限制项在
 * `./Limits.tsx`,三者由 `./AppCenterLayout.tsx` 的子导航串起来(2026-09-19
 * 用户要求「应用平台并入应用中心 + 应用中心增加设置页」)。**服务端未改**:三条
 * 接口仍在同一组、权限点不变。
 *
 * 服务端管理面已就绪(server/internal/wasmapp/api/admin.go),本页只做组合与状态
 * 编排,不复制任何后端语义:
 *   GET  /wasm-apps?q=&status=&limit=&offset=  列表(含 total/truncated/积压)
 *   POST /wasm-apps/:app_id/publish     上架(幂等:已上架 changed:false)
 *   POST /wasm-apps/:app_id/unpublish   下架(同上,对称)
 *   POST /wasm-apps/:app_id/freeze      body {"frozen":true|false} 冻结/解冻
 *   PUT  /wasm-apps/:app_id/owner       body {"owner":"<用户名>"} 转移归属
 *   PUT  /wasm-apps/review              body {"required":true|false} 更新审批开关
 *   GET  /wasm-apps/:app_id/releases?status=pending   待审版本清单
 *   POST /wasm-apps/:app_id/releases/:version/approve|reject   审核出口
 *   GET  /wasm-apps/:app_id/diagnostics               运行诊断(失败码/hints/时间线)
 *
 * 本轮(P1-6/P1-7/P1-9/P2-6,2026-09-19 审计):
 *   - **待审批闭环**(P0-1 服务端已就绪,前端此前一行未接):行内徽标 + 状态筛选 +
 *     详情抽屉里的待审清单与「通过/拒绝」;
 *   - **不再静默截断**(P1-7):搜索 + 状态筛选 + 分页 + "共 N 条/当前显示 M 条",
 *     第 201 个应用可被检索;
 *   - **错误信封读全**(P1-6):统一走 errorText(message + details.field + hints),
 *     服务端说的"还差什么条件"不再丢;
 *   - **有代价的动作要二次确认**:开/关更新审批、冻结;
 *   - **运行诊断入口**(P1-9):详情抽屉里直接看失败码计数/hints/最近失败时间线。
 *
 * 两条边界:
 *   - 读面按 capability:read、写面按 capability:write 判定。前端只是**体验层**
 *     (没有权限就不渲染写控件、不发注定 403 的请求);服务端 RequirePermission
 *     才是护栏。**审核按钮例外:无写权限时禁用而不是隐藏** —— 审批队列本身是
 *     只读可见的信息(谁在等审批),按钮消失会让只读账号以为"没有待审"。
 *   - 状态徽章里**冻结优先于上下架**:冻结会连带把 enabled 置 false,只看 enabled
 *     会把"被平台冻结"误读成"员工自己下架了"。deleted_at 非空显示「已删除」。
 */

interface WasmApp {
  app_id: string
  title: string
  description: string
  owner: string
  enabled: boolean
  /** 访问级别:public 公开 / login 登录后全员 / whitelist 白名单。 */
  access: 'public' | 'login' | 'whitelist' | string
  purpose: string
  data_sensitivity: string
  current_release_id: number
  /** 可能是空串(版本行已被保留策略回收);展示时回落 '—'。 */
  current_version: string
  /** 待审版本号 + 计数(服务端 adminList 每行下发;空数组不是 null)。 */
  pending_releases: string[]
  pending_count: number
  frozen_at: string | null
  deleted_at: string | null
  created_at: string
  updated_at: string
}

interface ListResponse {
  apps: WasmApp[]
  review_required: boolean
  setting_key: string
  /** 组织级待审积压(与分页无关)。 */
  pending_count: number
  /** 命中筛选的总条数(分页之前)。 */
  total: number
  /** 还有下一页。 */
  truncated: boolean
  limit: number
  offset: number
}

interface PendingRelease {
  id: number
  version: string
  status: string
  title: string
  publisher: string
  /** 制品体积(字节);服务端字段名是 size。 */
  size: number
  checksum: string
  changelog: string
  created_at: string
  /** 是否就是线上正在跑的版本。 */
  current: boolean
}

interface ReleasesResponse {
  app_id: string
  status: string
  current_version: string
  releases: PendingRelease[]
  pending_count: number
}

/** 运行诊断(admin.go 的 AdminDiagnostics 与员工面同一份口径)。 */
interface DiagnosticsSummary {
  total: number
  ok: number
  error: number
  killed: number
  failed: number
  reasons: { reason_code: string; count: number; hints: string[] }[]
  hints: string[]
  last_failure_at: string | null
}

interface Diagnostics {
  app_id: string
  app_enabled: boolean
  app_frozen: boolean
  app_deleted: boolean
  owner: string
  window_minutes: number
  retention_days: number
  summary: DiagnosticsSummary
  failures: {
    created_at: string
    outcome: string
    reason_code: string
    guest_exit_code: number
    stderr_tail: string
    cpu_ms: number
    peak_memory_bytes: number
  }[]
  hints: string[]
}

const ACCESS_META: Record<string, { label: string; variant: 'success' | 'secondary' | 'outline' }> = {
  public: { label: '公开', variant: 'success' },
  login: { label: '登录后全员', variant: 'secondary' },
  whitelist: { label: '白名单', variant: 'outline' },
}

/** 未知访问级别不静默吞掉:原样回显(服务端加了新枚举时页面仍可读)。 */
function accessMeta(access: string): { label: string; variant: 'success' | 'secondary' | 'outline' } {
  return ACCESS_META[access] ?? { label: access || '未知', variant: 'outline' }
}

type StatusVariant = 'success' | 'secondary' | 'destructive'

/** 冻结 > 上下架;已删除优先于一切(列表缺省不含已删,防漏判仍保留判定)。 */
function statusMeta(app: WasmApp): { label: string; variant: StatusVariant } {
  if (app.deleted_at) return { label: '已删除', variant: 'destructive' }
  if (app.frozen_at) return { label: '已冻结', variant: 'destructive' }
  if (app.enabled) return { label: '上架', variant: 'success' }
  return { label: '已下架', variant: 'secondary' }
}

function fmtTime(iso: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('zh-CN', { hour12: false })
}

/** 制品体积:MiB 保留一位小数;0/未知回落 '—'(不显示"0 B"这种假精确)。 */
function fmtSize(bytes: number): string {
  if (!bytes || bytes <= 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

/** 列表页大小:管理面是"人在看"的列表,一页 20 条足够,翻页成本也低。 */
const PAGE_SIZE = 20

/** 状态筛选:取值与**服务端**admin.go 的 status 参数逐字一致(不要本地另造词汇表)。 */
const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: 'all', label: '全部状态' },
  { value: 'pending', label: '待审批' },
  { value: 'published', label: '已上架' },
  { value: 'unpublished', label: '已下架' },
  { value: 'frozen', label: '已冻结' },
]

export default function Apps() {
  const [apps, setApps] = useState<WasmApp[]>([])
  const [reviewRequired, setReviewRequired] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  /** 在途操作键(`<app_id>:<动作>` 或 'review');非空时禁用写控件防连点。 */
  const [busy, setBusy] = useState('')
  const [ownerTarget, setOwnerTarget] = useState<WasmApp | null>(null)
  const [ownerInput, setOwnerInput] = useState('')
  const [detail, setDetail] = useState<WasmApp | null>(null)
  /** 审核开关的**待确认**目标值(null = 没有待确认的变更)。 */
  const [reviewPrompt, setReviewPrompt] = useState<boolean | null>(null)
  /** 冻结的**待确认**目标行(null = 无)。解冻不确认(恢复服务,无破坏性)。 */
  const [freezeTarget, setFreezeTarget] = useState<WasmApp | null>(null)
  /** 拒绝理由的目标版本(null = 关闭)。 */
  const [rejectTarget, setRejectTarget] = useState<PendingRelease | null>(null)
  const [rejectReason, setRejectReason] = useState('')
  const [flashMsg, flash] = useFlash()

  // 列表筛选/分页状态(全部进查询串,服务端才是过滤真源)。
  const [qInput, setQInput] = useState('')
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('all')
  const [offset, setOffset] = useState(0)
  const [total, setTotal] = useState(0)
  const [pendingTotal, setPendingTotal] = useState(0)

  // 详情抽屉的待审清单 + 运行诊断。
  const [pending, setPending] = useState<PendingRelease[]>([])
  const [pendingCurrent, setPendingCurrent] = useState('')
  const [pendingError, setPendingError] = useState('')
  const [diag, setDiag] = useState<Diagnostics | null>(null)
  const [diagError, setDiagError] = useState('')

  const loadSeq = useRef(0)

  // 体验层能力判定:服务端 RequirePermission 才是护栏(见页面头注释)。
  const canRead = hasPermission(PERM_CAP_READ)
  const canWrite = hasPermission(PERM_CAP_WRITE)

  const listQuery = useMemo(() => {
    const params = new URLSearchParams()
    params.set('limit', String(PAGE_SIZE))
    params.set('offset', String(offset))
    if (q !== '') params.set('q', q)
    if (status !== 'all') params.set('status', status)
    return params.toString()
  }, [offset, q, status])

  const load = useCallback(async () => {
    // 没有 capability:read 时不发这个注定 403 的请求(与用量中心同口径)。
    if (!canRead) {
      setLoading(false)
      return
    }
    const current = ++loadSeq.current
    setLoading(true)
    setError('')
    try {
      const data = await request<ListResponse>(`${ADMIN_API}/wasm-apps?${listQuery}`)
      if (current !== loadSeq.current) return // 刷新连点时只认最后一次响应
      setApps(data.apps ?? [])
      setReviewRequired(data.review_required === true)
      setTotal(typeof data.total === 'number' ? data.total : (data.apps ?? []).length)
      setPendingTotal(typeof data.pending_count === 'number' ? data.pending_count : 0)
    } catch (err: any) {
      if (current !== loadSeq.current) return
      setError(errorText(err, '加载失败'))
    } finally {
      if (current === loadSeq.current) setLoading(false)
    }
  }, [canRead, listQuery])

  useEffect(() => { void load() }, [load])

  /** 详情抽屉打开时拉取该应用的待审版本(筛选变更/审核后重拉同一份)。 */
  const loadPending = useCallback(async (appId: string) => {
    setPendingError('')
    try {
      const out = await request<ReleasesResponse>(
        `${ADMIN_API}/wasm-apps/${appId}/releases?status=pending`,
      )
      setPending(out.releases ?? [])
      setPendingCurrent(out.current_version ?? '')
    } catch (err: any) {
      setPending([])
      setPendingError(errorText(err, '读取待审版本失败'))
    }
  }, [])

  /** 详情抽屉打开时拉取运行诊断(P1-9:管理端此前没有任何排障入口)。 */
  const loadDiagnostics = useCallback(async (appId: string) => {
    setDiagError('')
    try {
      const out = await request<{ diagnostics: Diagnostics }>(
        `${ADMIN_API}/wasm-apps/${appId}/diagnostics`,
      )
      setDiag(out.diagnostics)
    } catch (err: any) {
      setDiag(null)
      setDiagError(errorText(err, '读取运行诊断失败'))
    }
  }, [])

  const openDetail = (row: WasmApp) => {
    setDetail(row)
    setPending([])
    setPendingCurrent(row.current_version ?? '')
    setPendingError('')
    setDiag(null)
    setDiagError('')
    void loadPending(row.app_id)
    void loadDiagnostics(row.app_id)
  }

  /** 写操作成功后按响应回填单行(服务端返回的就是该字段的新真值)。 */
  const patchRow = (appId: string, patch: Partial<WasmApp>) => {
    setApps((prev) => prev.map((a) => (a.app_id === appId ? { ...a, ...patch } : a)))
  }

  const togglePublished = async (row: WasmApp) => {
    if (busy || !canWrite) return
    const next = !row.enabled
    setBusy(`${row.app_id}:publish`)
    setError('')
    try {
      const out = await request<{ app?: { enabled?: boolean } }>(
        `${ADMIN_API}/wasm-apps/${row.app_id}/${next ? 'publish' : 'unpublish'}`,
        { method: 'POST' },
      )
      patchRow(row.app_id, { enabled: typeof out?.app?.enabled === 'boolean' ? out.app.enabled : next })
    } catch (err: any) {
      setError(errorText(err, next ? '上架失败' : '下架失败'))
    } finally {
      setBusy('')
    }
  }

  /** 冻结/解冻的真正提交(冻结方向由确认框调用,见 freezeTarget)。 */
  const submitFrozen = async (row: WasmApp, frozen: boolean) => {
    if (busy || !canWrite) return
    setBusy(`${row.app_id}:freeze`)
    setError('')
    try {
      const out = await request<{ app?: { enabled?: boolean; frozen_at?: string | null } }>(
        `${ADMIN_API}/wasm-apps/${row.app_id}/freeze`,
        { method: 'POST', body: JSON.stringify({ frozen }) },
      )
      patchRow(row.app_id, {
        frozen_at: frozen ? (out?.app?.frozen_at ?? new Date().toISOString()) : null,
        // 冻结会连带下架(服务端行为);解冻不改 enabled。响应缺字段时不臆测。
        ...(typeof out?.app?.enabled === 'boolean' ? { enabled: out.app.enabled } : {}),
      })
      flash(frozen ? '已冻结:该应用立即停止服务' : '已解冻:应用可重新上架')
    } catch (err: any) {
      setError(errorText(err, frozen ? '冻结失败' : '解冻失败'))
    } finally {
      setBusy('')
    }
  }

  /** 审核开关的真正提交(由确认框调用:开/关都会改变全组织的发布行为)。 */
  const toggleReview = async (next: boolean) => {
    if (busy || !canWrite) return
    const prev = reviewRequired
    setBusy('review')
    setError('')
    setReviewRequired(next) // 乐观切换(开关手感);失败回滚
    try {
      const out = await request<{ review_required?: boolean }>(`${ADMIN_API}/wasm-apps/review`, {
        method: 'PUT',
        body: JSON.stringify({ required: next }),
      })
      if (typeof out?.review_required === 'boolean') setReviewRequired(out.review_required)
      flash(next ? '已开启更新审批:新版本需审批后生效' : '已关闭更新审批:新版本发布即生效')
    } catch (err: any) {
      setReviewRequired(prev)
      setError(errorText(err, '更新审批开关保存失败'))
    } finally {
      setBusy('')
    }
  }

  const openOwner = (row: WasmApp) => {
    setOwnerInput('')
    setOwnerTarget(row)
  }

  const submitOwner = async () => {
    const row = ownerTarget
    if (!row || busy || !canWrite) return
    const owner = ownerInput.trim()
    if (owner === '') {
      setError('请填写新负责人用户名')
      return
    }
    setBusy(`${row.app_id}:owner`)
    setError('')
    try {
      const out = await request<{ app?: { owner?: string } }>(
        `${ADMIN_API}/wasm-apps/${row.app_id}/owner`,
        { method: 'PUT', body: JSON.stringify({ owner }) },
      )
      patchRow(row.app_id, { owner: out?.app?.owner ?? owner })
      setOwnerTarget(null)
      setOwnerInput('')
    } catch (err: any) {
      setError(errorText(err, '转移归属失败'))
    } finally {
      setBusy('')
    }
  }

  /** 审核通过:成功后刷新列表与抽屉(待审清单、积压数、当前生效版本都变了)。 */
  const approveRelease = async (row: WasmApp, rel: PendingRelease) => {
    if (busy || !canWrite) return
    setBusy(`${row.app_id}:approve`)
    setError('')
    try {
      await request(
        `${ADMIN_API}/wasm-apps/${row.app_id}/releases/${encodeURIComponent(rel.version)}/approve`,
        { method: 'POST' },
      )
      flash(`已通过 v${rel.version}`)
      await Promise.all([load(), loadPending(row.app_id)])
    } catch (err: any) {
      setError(errorText(err, '审核通过失败'))
    } finally {
      setBusy('')
    }
  }

  /** 审核拒绝(理由可选,≤200 字;服务端超过上限直接 400)。 */
  const rejectRelease = async () => {
    const row = detail
    const rel = rejectTarget
    if (!row || !rel || busy || !canWrite) return
    setBusy(`${row.app_id}:reject`)
    setError('')
    try {
      await request(
        `${ADMIN_API}/wasm-apps/${row.app_id}/releases/${encodeURIComponent(rel.version)}/reject`,
        { method: 'POST', body: JSON.stringify({ reason: rejectReason.trim() }) },
      )
      flash(`已拒绝 v${rel.version}`)
      setRejectTarget(null)
      setRejectReason('')
      await Promise.all([load(), loadPending(row.app_id)])
    } catch (err: any) {
      setError(errorText(err, '审核拒绝失败'))
    } finally {
      setBusy('')
    }
  }

  const submitSearch = (e?: FormEvent) => {
    e?.preventDefault()
    setOffset(0) // 换搜索词必须回到第一页,否则会停在一个"搜索结果的第 3 页"上
    setQ(qInput.trim())
  }

  const shown = apps.length
  const hasPrev = offset > 0
  const hasNext = offset + shown < total

  return (
    <div className="space-y-4">
      <PageHeader
        title="应用"
        desc="员工自建的 WASM 应用:查看访问级别与运行状态,并做上下架、冻结、归属转移、版本审核等平台级处置"
        actions={
          <>
            {/* 组织级「更新审批」开关:开启后新版本进待审队列,线上仍旧版本。
                开/关都必须二次确认(见下方 Dialog):它会改变**全组织**的发布行为。 */}
            <div className="flex items-center gap-2 rounded-md border px-3 py-1.5">
              <Switch
                id="wasm-review-required"
                aria-label="更新审批"
                checked={reviewRequired}
                disabled={!canWrite || busy === 'review'}
                title={canWrite ? undefined : '没有 capability:write 权限,仅可查看'}
                onCheckedChange={(v) => { setReviewPrompt(v) }}
              />
              <Label htmlFor="wasm-review-required" className="text-xs">更新审批</Label>
              <span className="text-[11px] text-muted-foreground">
                {reviewRequired ? '开启:新版本需审核' : '关闭:更新即生效'}
              </span>
              {pendingTotal > 0 && (
                <Badge variant="destructive" data-testid="org-pending-count" title="全组织待审版本数">
                  待审 {pendingTotal}
                </Badge>
              )}
            </div>
            <Button variant="outline" size="sm" onClick={() => { void load() }} title="刷新" aria-label="刷新">
              <RefreshCw className="h-4 w-4" />
            </Button>
          </>
        }
      />

      {flashMsg && (
        <div data-testid="apps-flash" className="rounded-md border border-border bg-muted px-3 py-2 text-sm">{flashMsg}</div>
      )}
      {error && <p data-testid="apps-error" className="text-sm text-destructive">{error}</p>}
      {!canWrite && (
        <p className="text-xs text-muted-foreground">
          当前账号没有 capability:write 权限 —— 仅可查看,处置按钮已禁用(服务端同样会拒绝写请求)。
        </p>
      )}

      {/* 搜索 + 状态筛选(P1-7):两者都进查询串由服务端过滤,第 201 个应用可被检索。 */}
      <form className="flex flex-wrap items-center gap-2" onSubmit={submitSearch}>
        <Input
          aria-label="搜索应用"
          data-testid="app-search"
          className="max-w-xs"
          placeholder="搜索应用名 / 应用 ID / 负责人"
          value={qInput}
          onChange={(e) => { setQInput(e.target.value) }}
        />
        <Button type="submit" variant="outline" size="sm" data-testid="app-search-submit">
          <Search className="mr-1 h-4 w-4" />搜索
        </Button>
        <Select
          value={status}
          onValueChange={(v) => { setOffset(0); setStatus(v) }}
        >
          <SelectTrigger className="w-40" aria-label="状态筛选" data-testid="app-status-filter">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_FILTERS.map((s) => (
              <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {(q !== '' || status !== 'all') && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="app-clear-filters"
            onClick={() => { setQInput(''); setQ(''); setStatus('all'); setOffset(0) }}
          >
            清除筛选
          </Button>
        )}
        {/* 显式总数:没有它,"被截断的列表"和"就这么多应用"在页面上长得一样(P1-7)。 */}
        <span className="text-xs text-muted-foreground" data-testid="app-total">
          共 {total} 条{total > 0 ? `,当前显示第 ${offset + 1}–${offset + shown} 条` : ''}
        </span>
      </form>

      {loading ? (
        <EmptyState icon={<Boxes className="h-6 w-6" />} title="加载中…" desc="请稍候" />
      ) : !canRead ? (
        <EmptyState
          icon={<Boxes className="h-6 w-6" />}
          title="没有查看应用中心的权限"
          desc="需要 capability:read 权限,请联系平台管理员"
        />
      ) : apps.length === 0 ? (
        // 加载失败时 apps 必为空 —— 此刻错误已在上方显示,再渲染「暂无应用」等于谎报
        // (写操作失败时 apps 非空,走下面的表格分支,错误与列表可以并存)。
        error === '' ? (
          <EmptyState
            icon={<Boxes className="h-6 w-6" />}
            title={q !== '' || status !== 'all' ? '没有匹配的应用' : '暂无应用'}
            desc={q !== '' || status !== 'all' ? '换个关键词或状态再试' : '员工发布的 WASM 应用将出现在这里'}
          />
        ) : null
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>应用</TableHead>
                <TableHead>访问级别</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>负责人</TableHead>
                <TableHead>当前版本</TableHead>
                <TableHead>更新时间</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {apps.map((row) => {
                const am = accessMeta(row.access)
                const sm = statusMeta(row)
                const isBusy = busy.startsWith(`${row.app_id}:`)
                const frozen = row.frozen_at !== null && row.frozen_at !== ''
                const pendingCount = row.pending_count ?? (row.pending_releases ?? []).length
                return (
                  <TableRow key={row.app_id}>
                    <TableCell>
                      <div className="whitespace-nowrap font-medium">{row.title || row.app_id}</div>
                      <div className="font-mono text-xs text-muted-foreground">{row.app_id}</div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={am.variant}>{am.label}</Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-1">
                        <Badge variant={sm.variant}>{sm.label}</Badge>
                        {/* 待审批徽标(P0-1 前端闭环):有积压的行必须在列表上就能看出来,
                            否则"审核开着但没人知道谁在等"就是这次审计的 P0 现场。 */}
                        {pendingCount > 0 && (
                          <Badge
                            variant="destructive"
                            data-testid="pending-badge"
                            title={`待审版本:${(row.pending_releases ?? []).join('、')}`}
                          >
                            待审批 {pendingCount}
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>{row.owner || '—'}</TableCell>
                    <TableCell className="font-mono text-sm">{row.current_version || '—'}</TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{fmtTime(row.updated_at)}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => { openDetail(row) }}
                          title="详情"
                          aria-label="详情"
                        >
                          <Eye className="h-4 w-4" />
                        </Button>
                        {/* 写操作整体按 capability:write 缺席(只读账号看不到注定 403 的按钮)。 */}
                        {canWrite && (
                          <>
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={isBusy}
                              onClick={() => { openOwner(row) }}
                              title="转移归属(负责人)"
                              aria-label="转移归属"
                            >
                              <UserCog className="h-4 w-4" />
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              // 冻结优先(P2-6):冻结期间交付面一律 404,所以"上架"没有意义
                              // (服务端同样返回 403 APP_FROZEN + hint,这里只是别让它可点)。
                              disabled={isBusy || frozen}
                              onClick={() => { void togglePublished(row) }}
                              title={
                                frozen
                                  ? '已冻结:交付面一律 404,先解冻再上架'
                                  : row.enabled ? '下架(员工不可用,数据保留)' : '上架(员工可见可用)'
                              }
                              aria-label={row.enabled ? '下架' : '上架'}
                            >
                              {row.enabled ? '下架' : '上架'}
                            </Button>
                            <Button
                              size="sm"
                              variant={frozen ? 'outline' : 'destructive'}
                              disabled={isBusy}
                              // 冻结是破坏性动作(立即停服 + 进入保留期)⇒ 先确认;
                              // 解冻是恢复动作,不打扰。
                              onClick={() => { frozen ? void submitFrozen(row, false) : setFreezeTarget(row) }}
                              title={frozen ? '解冻(恢复服务)' : '冻结(停止服务 + 只读快照保留期)'}
                              aria-label={frozen ? '解冻' : '冻结'}
                            >
                              {frozen ? '解冻' : '冻结'}
                            </Button>
                          </>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {/* 分页(P1-7):不翻页也能看到"被截断了"(truncated),翻了才可能看到第 201 个。 */}
      {(hasPrev || hasNext) && (
        <div className="flex items-center justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            data-testid="app-prev-page"
            disabled={!hasPrev || loading}
            onClick={() => { setOffset(Math.max(0, offset - PAGE_SIZE)) }}
          >
            上一页
          </Button>
          <Button
            variant="outline"
            size="sm"
            data-testid="app-next-page"
            disabled={!hasNext || loading}
            onClick={() => { setOffset(offset + PAGE_SIZE) }}
          >
            下一页
          </Button>
        </div>
      )}

      {/* 转移归属:输入用户名 → PUT /wasm-apps/:app_id/owner(服务端校验用户存在)。 */}
      <Dialog
        open={ownerTarget !== null}
        onOpenChange={(open) => { if (!open) { setOwnerTarget(null); setOwnerInput('') } }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              转移归属{ownerTarget ? `:${ownerTarget.title || ownerTarget.app_id}` : ''}
            </DialogTitle>
            <DialogDescription>
              转移后新负责人获得该应用的续传发布权,原负责人的发布请求将失效。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="wasm-app-owner" className="text-xs text-muted-foreground">新负责人用户名</Label>
            <Input
              id="wasm-app-owner"
              aria-label="新负责人用户名"
              value={ownerInput}
              placeholder="如 alice"
              disabled={busy !== ''}
              onChange={(e) => { setOwnerInput(e.target.value) }}
            />
            {ownerTarget && (
              <p className="text-xs text-muted-foreground">当前负责人:{ownerTarget.owner || '—'}</p>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => { setOwnerTarget(null); setOwnerInput('') }}>取消</Button>
            <Button
              disabled={busy !== '' || ownerInput.trim() === ''}
              onClick={() => { void submitOwner() }}
            >
              确认转移
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 更新审批开关的二次确认:开启 = 全组织新版本停在待审;关闭 = 已积压的不会自动转正。 */}
      <Dialog open={reviewPrompt !== null} onOpenChange={(open) => { if (!open) setReviewPrompt(null) }}>
        <DialogContent data-testid="review-confirm-dialog">
          <DialogHeader>
            <DialogTitle>{reviewPrompt ? '开启更新审批?' : '关闭更新审批?'}</DialogTitle>
            <DialogDescription>
              {reviewPrompt
                ? '开启后,员工发布的新版本会停在「待审批」状态,需要管理员在本页审批通过才能上线;线上继续运行当前生效版本,不会中断使用。'
                : '关闭后,员工发布的新版本立即生效,不再需要审批。'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            {reviewPrompt ? (
              <>
                <p>
                  代价:从此刻起<strong>全组织</strong>的新版本都不会自动上线,直到有人审批。
                </p>
                {pendingTotal > 0 && (
                  <p className="text-destructive" data-testid="review-pending-warning">
                    当前已有 {pendingTotal} 个待审版本积压(开启后仍需逐个审批)。
                  </p>
                )}
              </>
            ) : (
              <p className="text-destructive" data-testid="review-close-warning">
                已处于待审状态的版本<strong>不会</strong>自动转正,发布者需要重新发布更高版本;需要它们上线请在关闭前先在详情里逐个通过。
              </p>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => { setReviewPrompt(null) }}>取消</Button>
            <Button
              data-testid="review-confirm"
              disabled={busy !== ''}
              onClick={() => {
                const next = reviewPrompt
                setReviewPrompt(null)
                if (next !== null) void toggleReview(next)
              }}
            >
              {reviewPrompt ? '确认开启' : '确认关闭'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 冻结确认:说清代价(立即停服 / 保留期 / 到期处理 / 如何解冻)。 */}
      <Dialog open={freezeTarget !== null} onOpenChange={(open) => { if (!open) setFreezeTarget(null) }}>
        <DialogContent data-testid="freeze-confirm-dialog">
          <DialogHeader>
            <DialogTitle>
              冻结应用{freezeTarget ? `:${freezeTarget.title || freezeTarget.app_id}` : ''}?
            </DialogTitle>
            <DialogDescription>冻结是平台级处置动作,影响该应用的全部使用者。</DialogDescription>
          </DialogHeader>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            <li><strong>立即停服</strong>:所有访问一律 404(与上下架状态无关),员工端当场不可用。</li>
            <li><strong>数据保留</strong>:应用进入只读快照保留期,数据不会被立即删除。</li>
            <li><strong>到期处理</strong>:保留期结束后由后台任务真正删除(不可恢复)。</li>
            <li><strong>如何解冻</strong>:本页「解冻」按钮即可恢复;解冻后需要重新上架才会对员工可见。</li>
          </ul>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => { setFreezeTarget(null) }}>取消</Button>
            <Button
              variant="destructive"
              data-testid="freeze-confirm"
              disabled={busy !== ''}
              onClick={() => {
                const row = freezeTarget
                setFreezeTarget(null)
                if (row) void submitFrozen(row, true)
              }}
            >
              确认冻结
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 拒绝理由:可选,长度上限与服务端一致(200 字);超限直接禁用提交而不是等 400。 */}
      <Dialog
        open={rejectTarget !== null}
        onOpenChange={(open) => { if (!open) { setRejectTarget(null); setRejectReason('') } }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>拒绝 v{rejectTarget?.version}?</DialogTitle>
            <DialogDescription>
              拒绝会<strong>释放该版本的归档字节</strong>(不可恢复,版本号永久占位);发布者需要发布更高的新版本。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="reject-reason" className="text-xs text-muted-foreground">
              拒绝理由(可选,将写入审计)
            </Label>
            <Textarea
              id="reject-reason"
              aria-label="拒绝理由"
              data-testid="reject-reason"
              maxLength={200}
              value={rejectReason}
              placeholder="如:申请的数据范围超出该用途所需"
              onChange={(e) => { setRejectReason(e.target.value) }}
            />
            <p className="text-xs text-muted-foreground">{rejectReason.length}/200</p>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => { setRejectTarget(null); setRejectReason('') }}>取消</Button>
            <Button
              variant="destructive"
              data-testid="reject-submit"
              disabled={busy !== '' || rejectReason.length > 200}
              onClick={() => { void rejectRelease() }}
            >
              确认拒绝
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 详情:用途/数据敏感度/当前版本 id/创建与更新时间/描述 + 待审版本 + 运行诊断。 */}
      <Dialog open={detail !== null} onOpenChange={(open) => { if (!open) setDetail(null) }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{detail ? `${detail.title || detail.app_id} 详情` : '应用详情'}</DialogTitle>
            <DialogDescription>{detail?.app_id}</DialogDescription>
          </DialogHeader>
          {detail && (
            <dl className="grid grid-cols-[6.5rem_1fr] gap-x-3 gap-y-2 text-sm">
              <dt className="text-muted-foreground">用途</dt>
              <dd className="break-words">{detail.purpose || '—'}</dd>
              <dt className="text-muted-foreground">数据敏感度</dt>
              <dd>{detail.data_sensitivity || '—'}</dd>
              <dt className="text-muted-foreground">当前生效版本</dt>
              <dd className="font-mono">{detail.current_version || '—'}</dd>
              <dt className="text-muted-foreground">当前版本 ID</dt>
              <dd className="font-mono">{detail.current_release_id > 0 ? detail.current_release_id : '—'}</dd>
              <dt className="text-muted-foreground">创建时间</dt>
              <dd>{fmtTime(detail.created_at)}</dd>
              <dt className="text-muted-foreground">更新时间</dt>
              <dd>{fmtTime(detail.updated_at)}</dd>
              <dt className="text-muted-foreground">描述</dt>
              <dd className="whitespace-pre-wrap break-words">{detail.description || '—'}</dd>
            </dl>
          )}

          {/* 待审版本(P0-1 的前端出口):版本号/提交时间/提交人/体积/当前生效版本 + 通过/拒绝。 */}
          {detail && (
            <section className="space-y-2 rounded-md border p-3" data-testid="pending-block">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold">待审版本({pending.length})</h3>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => { void loadPending(detail.app_id) }}
                  data-testid="pending-refresh"
                >
                  <RefreshCw className="h-4 w-4" />
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                当前生效版本:<span className="font-mono">{pendingCurrent || '—'}</span>
                (审批通过后线上切到新版本;拒绝会释放归档字节)
              </p>
              {pendingError && <p className="text-sm text-destructive" data-testid="pending-error">{pendingError}</p>}
              {!pendingError && pending.length === 0 ? (
                <p className="text-sm text-muted-foreground" data-testid="pending-empty">
                  没有待审版本。员工发布新版本后,若组织开启了更新审批,会出现在这里。
                </p>
              ) : (
                <ul className="space-y-2" data-testid="pending-list">
                  {pending.map((rel) => (
                    <li key={rel.version} className="flex flex-wrap items-center justify-between gap-2 border-b pb-2 last:border-b-0 last:pb-0">
                      <div className="space-y-0.5">
                        <div className="font-mono text-sm">
                          v{rel.version}
                          {rel.current && <Badge variant="secondary" className="ml-2">当前生效</Badge>}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          提交人 {rel.publisher || '—'} · {fmtTime(rel.created_at)} · {fmtSize(rel.size)}
                        </div>
                        {rel.changelog && (
                          <div className="text-xs text-muted-foreground">变更说明:{rel.changelog}</div>
                        )}
                      </div>
                      {/* 无写权限时**禁用而不是隐藏**(与开关同风格):待审清单本身是
                          只读可见的信息,按钮消失会让只读账号以为"没有待审"。 */}
                      <div className="flex items-center gap-1">
                        <Button
                          size="sm"
                          data-testid={`pending-approve-${rel.version}`}
                          disabled={!canWrite || busy !== ''}
                          title={canWrite ? '通过:该版本上线' : '没有 capability:write 权限'}
                          onClick={() => { void approveRelease(detail, rel) }}
                        >
                          <Check className="mr-1 h-4 w-4" />通过
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          data-testid={`pending-reject-${rel.version}`}
                          disabled={!canWrite || busy !== ''}
                          title={canWrite ? '拒绝:释放归档字节(不可恢复)' : '没有 capability:write 权限'}
                          onClick={() => { setRejectReason(''); setRejectTarget(rel) }}
                        >
                          <X className="mr-1 h-4 w-4" />拒绝
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {/* 运行诊断(P1-9):管理端此前零入口,排障只能找发布者要令牌。 */}
          {detail && (
            <section className="space-y-2 rounded-md border p-3" data-testid="diag-block">
              <div className="flex items-center justify-between">
                <h3 className="flex items-center gap-1 text-sm font-semibold">
                  <Stethoscope className="h-4 w-4" />运行诊断
                </h3>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => { void loadDiagnostics(detail.app_id) }}
                  data-testid="diag-refresh"
                >
                  <RefreshCw className="h-4 w-4" />
                </Button>
              </div>
              {diagError && <p className="text-sm text-destructive" data-testid="diag-error">{diagError}</p>}
              {!diagError && diag && (
                <>
                  <p className="text-xs text-muted-foreground">
                    近 {Math.round((diag.window_minutes ?? 0) / 60)} 小时:共 {diag.summary.total} 次调用,
                    失败 {diag.summary.failed}(错误 {diag.summary.error} / 被杀 {diag.summary.killed});
                    调用事件保留 {diag.retention_days} 天
                  </p>
                  {diag.summary.reasons.length === 0 ? (
                    <p className="text-sm text-muted-foreground" data-testid="diag-empty">该窗口内没有失败记录</p>
                  ) : (
                    <ul className="space-y-1 text-sm" data-testid="diag-reasons">
                      {diag.summary.reasons.map((r) => (
                        <li key={r.reason_code}>
                          <span className="font-mono">{r.reason_code}</span> × {r.count}
                          {r.hints.length > 0 && (
                            <ul className="list-disc pl-5 text-xs text-muted-foreground">
                              {r.hints.map((h) => <li key={h}>{h}</li>)}
                            </ul>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  {diag.failures.length > 0 && (
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-muted-foreground">最近失败</div>
                      <ul className="space-y-1 text-xs text-muted-foreground" data-testid="diag-failures">
                        {diag.failures.slice(0, 10).map((f, i) => (
                          <li key={`${f.created_at}-${i}`} className="font-mono">
                            {fmtTime(f.created_at)} · {f.outcome} · {f.reason_code} · exit {f.guest_exit_code} · cpu {f.cpu_ms}ms
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {/* hints 是"下一步改什么"(第一消费者是排障的人/AI),原文照显。 */}
                  {diag.hints.length > 0 && (
                    <ul className="list-disc pl-5 text-xs" data-testid="diag-hints">
                      {diag.hints.slice(0, 8).map((h) => <li key={h}>{h}</li>)}
                    </ul>
                  )}
                </>
              )}
              {!diagError && !diag && <p className="text-sm text-muted-foreground">读取中…</p>}
            </section>
          )}

          <div className="flex justify-end">
            <Button variant="outline" onClick={() => { setDetail(null) }}>关闭</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
