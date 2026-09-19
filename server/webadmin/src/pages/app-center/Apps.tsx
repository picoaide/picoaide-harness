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
  /**
   * 审核结果理由(驳回理由)。
   *
   * ⚠️ **服务端 DTO 尚未下发**:`serverstore.WasmRelease` 没有 reason 列,
   * `api/admin.go` 的 adminReleases 行也没有这个字段 —— 拒绝理由目前只落在审计详情里
   * (`wasm_app_release_reject` 的 detail)。前端这里先把渲染位留好(有就显示),
   * 依赖清单见 `temp/wasm-review-r1/fix-wave3.md` 的 R1-uxw-4 条目。
   */
  reason?: string
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

/**
 * `releases` 必须**真的是数组**，否则返回 null（调用方按读取失败处理）。
 *
 * F6（审计第二轮 A2-F6）：`out.releases ?? []` 会把"响应里没有版本清单"渲染成
 * "没有被拒的版本。"（对管理员是假陈述），而客户端半边 `app-releases.ts` 对同一份
 * 响应返回结构化失败（UNEXPECTED_RESPONSE）—— 同一功能的两半不能一个说"形状错误"、
 * 一个说"你没有"。
 */
function requireReleases(out: ReleasesResponse): PendingRelease[] | null {
  return Array.isArray(out?.releases) ? out.releases : null
}

/** 状态筛选:取值与**服务端**admin.go 的 status 参数逐字一致(不要本地另造词汇表)。 */
const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: 'all', label: '全部状态' },
  { value: 'pending', label: '待审批' },
  { value: 'published', label: '已上架' },
  { value: 'unpublished', label: '已下架' },
  { value: 'frozen', label: '已冻结' },
  // 软删(冻结保留期到期后由后台真删/软删)的行**默认不出现**在列表里;要复核
  // "谁删了什么"、或对已删应用跑只读诊断,必须先能筛出来(R1-uxw-7)。服务端
  // 支持 status=deleted,且它就是 include_deleted=1 的同义入口。
  { value: 'deleted', label: '已删除' },
]

export default function Apps() {
  const [apps, setApps] = useState<WasmApp[]>([])
  const [reviewRequired, setReviewRequired] = useState(false)
  const [loading, setLoading] = useState(true)
  /** 处置类动作失败(下架/冻结/转移…):列表本身仍然可信,只是那一次操作没成功。 */
  const [error, setError] = useState('')
  /**
   * **列表读取**失败(与上面的动作失败分开)。
   *
   * 分开的理由就是 R1-uxw-2:两者混用一个 error 时,"翻页请求失败"与"下架失败"
   * 在界面上长得一模一样,而前者意味着屏幕上的行数/范围数字已经不可信。
   */
  const [loadError, setLoadError] = useState('')
  /** 成功加载过一次(用来区分"还在读"与"真的没有应用")。 */
  const [loaded, setLoaded] = useState(false)
  /**
   * 服务端回显的 offset = 屏幕上这批行在全集里的起始下标。
   *
   * 范围标签只认它:本地 offset 是"我想看第几页",越界时服务端给的是空页 ——
   * 用本地 offset 自算就会写出"共 25 条,当前显示第 21–40 条"而屏幕上是第一页
   * 的假数字(审计 R1-uxw-2 实测文本)。
   */
  const [pageStart, setPageStart] = useState(0)
  /** 还有下一页:**服务端 truncated 字段**(不再用 offset+shown<total 自算)。 */
  const [truncated, setTruncated] = useState(false)
  /** 在途操作键(`<app_id>:<动作>` 或 'review');非空时禁用写控件防连点。 */
  const [busy, setBusy] = useState('')
  const [ownerTarget, setOwnerTarget] = useState<WasmApp | null>(null)
  const [ownerInput, setOwnerInput] = useState('')
  /** 转移归属弹窗内的失败反馈(渲染在弹窗里,否则被遮罩盖住 = "点了没反应")。 */
  const [ownerError, setOwnerError] = useState('')
  const [detail, setDetail] = useState<WasmApp | null>(null)
  /**
   * 详情抽屉内的成败反馈。
   *
   * R1-uxw-1:审核的「通过/拒绝」是在**弹窗里**点的,而反馈此前渲染在页面级
   * (`apps-error`/`apps-flash`)—— Radix 的整屏遮罩(`fixed inset-0 z-50 bg-black/80`)
   * 把它压住,管理员看到的是"点了没反应"(真实 Chromium 命中测试:错误文本中心点
   * 命中的是弹窗标题)。现在反馈渲染进 `DialogContent` 内部。
   */
  const [detailFeedback, setDetailFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  /** 拒绝确认框内的失败反馈(理由输入在这里,失败必须原地可见)。 */
  const [rejectError, setRejectError] = useState('')
  /**
   * 刚提交的驳回(版本 + 理由)。
   *
   * 服务端 DTO 还没有 `reason` 字段(见 PendingRelease.reason 注释),所以拒绝成功后
   * 那一行就从待审清单里消失了 —— 管理员刚写下的理由会在界面上蒸发。这里如实回显
   * "我刚才驳回了谁、理由是什么",服务端补上字段后由 `rel.reason` 接管。
   */
  const [lastRejection, setLastRejection] = useState<{ version: string; reason: string } | null>(null)
  /** 审核开关的**待确认**目标值(null = 没有待确认的变更)。 */
  const [reviewPrompt, setReviewPrompt] = useState<boolean | null>(null)
  /** 冻结的**待确认**目标行(null = 无)。解冻不确认(恢复服务,无破坏性)。 */
  const [freezeTarget, setFreezeTarget] = useState<WasmApp | null>(null)
  /** 下架的**待确认**目标行(R1-uxw-13:下架=全组织员工当场不可用,不能一键生效)。 */
  const [unpublishTarget, setUnpublishTarget] = useState<WasmApp | null>(null)
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
  /** 待审清单是否**成功读到**过(读失败时不能拿抽屉快照冒充服务端真值)。 */
  const [pendingLoaded, setPendingLoaded] = useState(false)
  const [pendingError, setPendingError] = useState('')
  /**
   * 最近被拒的版本(R1-uxw-4)。
   *
   * 服务端此前连 reason 都不下发,拒绝理由只躺在审计详情里 —— 审批面自己都回看不了
   * "我上次为什么拒的"。这条独立取数(status=rejected)与待审队列分开,读失败不会把
   * 待审队列一起打成错误态。
   */
  const [rejected, setRejected] = useState<PendingRelease[]>([])
  const [rejectedError, setRejectedError] = useState('')
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
    if (status !== 'all') {
      params.set('status', status)
      // 软删行必须显式带 include_deleted:服务端两条入口同义(status=deleted 也
      // 会打开 include_deleted),这里两条都带上,免得将来只改一端就静默查不到。
      if (status === 'deleted') params.set('include_deleted', '1')
    }
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
    setLoadError('')
    try {
      const data = await request<ListResponse>(`${ADMIN_API}/wasm-apps?${listQuery}`)
      if (current !== loadSeq.current) return // 刷新连点时只认最后一次响应
      setApps(data.apps ?? [])
      setReviewRequired(data.review_required === true)
      setTotal(typeof data.total === 'number' ? data.total : (data.apps ?? []).length)
      setPendingTotal(typeof data.pending_count === 'number' ? data.pending_count : 0)
      // 范围标签与翻页一律以**服务端回显**为准(见 pageStart/truncated 的注释)。
      setPageStart(typeof data.offset === 'number' && data.offset >= 0 ? data.offset : offset)
      setTruncated(data.truncated === true)
      setLoaded(true)
    } catch (err: any) {
      if (current !== loadSeq.current) return
      // R1-uxw-2:失败时**清空**列表,不保留"看着像本次结果"的旧行。
      // 保留旧行的代价是:屏幕上是第 1 页的 20 行,标签却写着新 offset 编出来的
      // "第 21–40 条",而管理员分辨不出这是上一次成功的数据(审计实测现场)。
      // 清空 + 明说失败 + 重试,是唯一不会撒谎的形态。
      setApps([])
      setTotal(0)
      setTruncated(false)
      setLoadError(errorText(err, '加载失败'))
    } finally {
      if (current === loadSeq.current) setLoading(false)
    }
  }, [canRead, listQuery, offset])

  useEffect(() => { void load() }, [load])

  /** 详情抽屉打开时拉取该应用的待审版本(筛选变更/审核后重拉同一份)。 */
  const loadPending = useCallback(async (appId: string) => {
    setPendingError('')
    try {
      const out = await request<ReleasesResponse>(
        `${ADMIN_API}/wasm-apps/${appId}/releases?status=pending`,
      )
      const releases = requireReleases(out)
      if (releases === null) {
        // F6（审计第二轮 A2-F6）：形状漂移不能显示成"没有待审版本"。
        setPending([])
        setPendingLoaded(false)
        setPendingError('读取待审版本失败：响应里没有版本清单（这不是"没有待审版本"，请核对服务端接口）')
        return
      }
      setPending(releases)
      setPendingCurrent(out.current_version ?? '')
      setPendingLoaded(true)
    } catch (err: any) {
      setPending([])
      setPendingLoaded(false)
      setPendingError(errorText(err, '读取待审版本失败'))
    }
  }, [])

  /**
   * 详情抽屉打开时拉取该应用的**最近被拒**版本(R1-uxw-4:驳回理由的唯一可回看来源)。
   *
   * 为什么单独取一次 `status=rejected`:待审队列按定义看不到被拒版本,而"我上次为什么
   * 拒的"恰恰只能从那一条回答 —— 服务端此前连 reason 都不下发,理由只躺在审计详情里。
   * 与待审清单分开取还有两个好处:①待审队列的语义与请求形状一个字不变(既有门禁照旧);
   * ②被拒清单读失败不会把待审队列一起打成错误态(两条错误各自可见)。
   */
  const loadRejected = useCallback(async (appId: string) => {
    setRejectedError('')
    try {
      const out = await request<ReleasesResponse>(
        `${ADMIN_API}/wasm-apps/${appId}/releases?status=rejected`,
      )
      const releases = requireReleases(out)
      if (releases === null) {
        // 与客户端半边同口径（`app-releases.ts` 对同样响应返回 UNEXPECTED_RESPONSE）：
        // 不把"解析不出来"说成"没有被拒的版本"（F6）。
        setRejected([])
        setRejectedError('读取被拒版本失败：响应里没有版本清单（这不是"没有被拒的版本"，请核对服务端接口）')
        return
      }
      setRejected(releases)
    } catch (err: any) {
      setRejected([])
      setRejectedError(errorText(err, '读取被拒版本失败'))
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
    setPendingLoaded(false)
    setPendingError('')
    setRejected([])
    setRejectedError('')
    setDetailFeedback(null)
    setLastRejection(null)
    setRejectError('')
    setDiag(null)
    setDiagError('')
    void loadPending(row.app_id)
    void loadRejected(row.app_id)
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
      patchRow(row.app_id, {
        // F2（审计第二轮 A2-F2）：响应缺 `enabled` 时**不臆测** —— 旧实现回落到乐观值
        // `next`，于是一个不带该字段的 200 就把行翻成「已下架」（探针实测）。这与同一
        // 文件冻结路径（:463 的"响应缺字段时不臆测"）本是同形响应，口径必须一致。
        ...(typeof out?.app?.enabled === 'boolean' ? { enabled: out.app.enabled } : {}),
      })
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
    setOwnerError('')
    setOwnerTarget(row)
  }

  const submitOwner = async () => {
    const row = ownerTarget
    if (!row || busy || !canWrite) return
    const owner = ownerInput.trim()
    if (owner === '') {
      setOwnerError('请填写新负责人用户名')
      return
    }
    setBusy(`${row.app_id}:owner`)
    setOwnerError('')
    setError('')
    try {
      const out = await request<{ app?: { owner?: string } }>(
        `${ADMIN_API}/wasm-apps/${row.app_id}/owner`,
        { method: 'PUT', body: JSON.stringify({ owner }) },
      )
      patchRow(row.app_id, { owner: out?.app?.owner ?? owner })
      setOwnerTarget(null)
      setOwnerInput('')
      flash(`已转移归属:${row.title || row.app_id} → ${out?.app?.owner ?? owner}`)
    } catch (err: any) {
      // 弹窗里的动作,失败必须渲染在弹窗里(R1-uxw-1 同族:页面级红字被遮罩压住)。
      setOwnerError(errorText(err, '转移归属失败'))
    } finally {
      setBusy('')
    }
  }

  /** 审核通过:成功后刷新列表与抽屉(待审清单、积压数、当前生效版本都变了)。 */
  const approveRelease = async (row: WasmApp, rel: PendingRelease) => {
    if (busy || !canWrite) return
    setBusy(`${row.app_id}:approve`)
    setDetailFeedback(null)
    setError('')
    try {
      await request(
        `${ADMIN_API}/wasm-apps/${row.app_id}/releases/${encodeURIComponent(rel.version)}/approve`,
        { method: 'POST' },
      )
      // 弹窗内 + 页面级都写:抽屉关掉之后仍能看到"刚才发生了什么"。
      setDetailFeedback({ kind: 'ok', text: `已通过 v${rel.version}` })
      flash(`已通过 v${rel.version}`)
      await Promise.all([load(), loadPending(row.app_id)])
    } catch (err: any) {
      // R1-uxw-1:反馈必须在**抽屉内**可见(页面级的 apps-error 被 80% 不透明
      // 整屏遮罩压住,管理员看到的是"点了没反应")。
      setDetailFeedback({ kind: 'err', text: errorText(err, '审核通过失败') })
    } finally {
      setBusy('')
    }
  }

  /** 审核拒绝(理由可选,≤200 字;服务端超过上限直接 400)。 */
  const rejectRelease = async () => {
    const row = detail
    const rel = rejectTarget
    if (!row || !rel || busy || !canWrite) return
    const reason = rejectReason.trim()
    setBusy(`${row.app_id}:reject`)
    setRejectError('')
    setError('')
    try {
      await request(
        `${ADMIN_API}/wasm-apps/${row.app_id}/releases/${encodeURIComponent(rel.version)}/reject`,
        { method: 'POST', body: JSON.stringify({ reason }) },
      )
      flash(`已拒绝 v${rel.version}`)
      setRejectTarget(null)
      setRejectReason('')
      // 驳回理由要留在管理员眼前:拒绝成功后那一行就从**待审**清单消失。两条留痕一起给
      // —— ①即时回显(拒绝响应里带 reason,不必等取数);②重取被拒清单(权威来源)。
      setLastRejection({ version: rel.version, reason })
      setDetailFeedback({ kind: 'ok', text: `已拒绝 v${rel.version}` })
      await Promise.all([load(), loadPending(row.app_id), loadRejected(row.app_id)])
    } catch (err: any) {
      // 失败时**不关闭**拒绝框:理由还在输入框里,原地显示原因让管理员能改后重试。
      setRejectError(errorText(err, '审核拒绝失败'))
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
  // 翻页判据只用**服务端回显**:pageStart(实际渲染的第一行)与 truncated(还有下一页)。
  // hasPrev 用 pageStart>0 而不是 offset>0 —— 越界失败后两者会分叉,而屏幕上真实
  // 渲染的位置才是管理员能验证的那个数(R1-uxw-2)。
  const hasPrev = pageStart > 0
  const hasNext = truncated
  /** 页码越界:服务端返回空页但全集非空(数据缩水/筛选变化后翻页的典型现场)。 */
  const outOfRange = !loading && loadError === '' && shown === 0 && total > 0
  /**
   * 抽屉里"当前生效版本"的**唯一取值**:待审清单读到了就以它为准(它比行快照新,
   * 审核通过后服务端返回的就是新版本),读不到才回落行快照。
   *
   * R1-uxw-5:此前 dl 用 `detail.current_version`(点开时的快照)、待审块用
   * `pendingCurrent`(刚拉的),通过 v1.2.0 之后同一屏上会出现"1.0.2"与"1.2.0"
   * 两个互相矛盾的"当前生效版本"。
   */
  const currentVersionShown = pendingLoaded ? pendingCurrent : (detail?.current_version ?? '')

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
                aria-describedby={!canWrite ? 'apps-readonly-note' : undefined}
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

      {/* 反馈都带 live 区(R1-uxw-14):读屏/键盘用户此前在保存失败或被拒时
          没有任何播报 —— flash/error 都只是普通 div。 */}
      {flashMsg && (
        <div
          data-testid="apps-flash"
          role="status"
          aria-live="polite"
          className="rounded-md border border-border bg-muted px-3 py-2 text-sm"
        >
          {flashMsg}
        </div>
      )}
      {error && (
        <p data-testid="apps-error" role="alert" aria-live="assertive" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {!canWrite && (
        <p id="apps-readonly-note" data-testid="apps-readonly-note" className="text-xs text-muted-foreground">
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
        {/* 显式总数:没有它,"被截断的列表"和"就这么多应用"在页面上长得一样(P1-7)。
            数字全部来自**实际渲染的这批行 + 服务端回显的 total/offset**(R1-uxw-2);
            读取失败时明说"条数未知",不拿 0 或者上一次的数字充数。 */}
        <span className="text-xs text-muted-foreground" data-testid="app-total">
          {loadError !== ''
            ? '读取失败,条数未知'
            : !loaded
              ? '加载中…'
              : `共 ${total} 条${shown > 0 ? `,当前显示第 ${pageStart + 1}–${pageStart + shown} 条` : ''}`}
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
      ) : loadError !== '' ? (
        // R1-uxw-2:列表读取失败 = 页面级的确定态(错误 + 重试),**不渲染任何行**。
        // 此前这里保留旧行,于是"共 25 条,当前显示第 21–40 条"与屏幕上的第 1 页
        // 同屏出现 —— 数字全是编的。
        <div className="space-y-2" data-testid="apps-load-error-block">
          <p data-testid="apps-load-error" role="alert" aria-live="assertive" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {loadError}
          </p>
          <Button variant="outline" size="sm" data-testid="apps-retry" onClick={() => { void load() }}>
            <RefreshCw className="mr-1 h-4 w-4" />重试
          </Button>
        </div>
      ) : apps.length === 0 ? (
        outOfRange ? (
          // 越界空页:服务端 offset 越界时返回空数组但 total>0(先过滤再分页)。
          // 此前这里渲染「暂无应用」,与标签里的"共 5 条"直接互相矛盾(A2 现场)。
          <EmptyState
            icon={<Boxes className="h-6 w-6" />}
            title="这一页没有数据"
            desc={`共 ${total} 条,当前页码已越界(数据可能因下架/删除变少了)`}
            action={
              <Button variant="outline" size="sm" data-testid="apps-first-page" onClick={() => { setOffset(0) }}>
                回到第一页
              </Button>
            }
          />
        ) : (
          // 加载失败时 apps 必为空,且上面 loadError 分支已接管 —— 走到这里就是
          // 服务端如实回答"没有数据"(写操作失败时 apps 非空,走表格分支)。
          <EmptyState
            icon={<Boxes className="h-6 w-6" />}
            title={q !== '' || status !== 'all' ? '没有匹配的应用' : '暂无应用'}
            desc={q !== '' || status !== 'all' ? '换个关键词或状态再试' : '员工发布的 WASM 应用将出现在这里'}
          />
        )
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
                <TableHead className="sticky right-0 z-10 bg-muted/60 text-right backdrop-blur-sm">操作</TableHead>
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
                    <TableCell className="max-w-[16rem]">
                      <div className="truncate font-medium" title={row.title || row.app_id}>{row.title || row.app_id}</div>
                      <div className="truncate font-mono text-xs text-muted-foreground" title={row.app_id}>{row.app_id}</div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={am.variant}>{am.label}</Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-1">
                        <Badge variant={sm.variant}>{sm.label}</Badge>
                        {/* 待审批徽标(P0-1 前端闭环):有积压的行必须在列表上就能看出来,
                            否则"审核开着但没人知道谁在等"就是这次审计的 P0 现场。
                            R1-uxw-14:版本清单此前只挂在 hover 的 title 上 —— 徽标改成
                            可聚焦 + aria-label,键盘/读屏用户同样读得到在等哪个版本。 */}
                        {pendingCount > 0 && (
                          <Badge
                            variant="destructive"
                            data-testid="pending-badge"
                            tabIndex={0}
                            title={`待审版本:${(row.pending_releases ?? []).join('、')}`}
                            aria-label={`待审批 ${pendingCount} 个版本:${(row.pending_releases ?? []).join('、')}`}
                          >
                            待审批 {pendingCount}
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>{row.owner || '—'}</TableCell>
                    <TableCell className="font-mono text-sm">{row.current_version || '—'}</TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{fmtTime(row.updated_at)}</TableCell>
                    {/* 操作列:窄屏(375px)下**吸右**。此前它整体落在视口之外
                        (`right` 632~782 > 375),管理员只看得到列表、点不到任何处置
                        (R1-uxw-8 的真实 Chromium 实测)。sticky 让它在横向滚动条
                        的右缘常驻,按钮允许换行避免被压成图标。 */}
                    <TableCell className="sticky right-0 z-10 bg-background text-right shadow-[-8px_0_8px_-8px_rgba(0,0,0,0.15)]">
                      <div className="flex flex-wrap items-center justify-end gap-1">
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
                            {/* 禁用按钮不可聚焦 ⇒ 原因只写 title 等于没有(R1-uxw-14)。
                                sr-only 的说明 + aria-describedby 让读屏也能读到"先解冻再上架";
                                再加 tabIndex 让它**可聚焦**：键盘用户 Tab 到这一条就能听到
                                原因，而不是对着一个点不动的按钮猜。 */}
                            {frozen && (
                              <span
                                id={`frozen-reason-${row.app_id}`}
                                data-testid={`frozen-reason-${row.app_id}`}
                                tabIndex={0}
                                className="sr-only"
                              >
                                已冻结:交付面一律 404,先解冻再上架
                              </span>
                            )}
                            <Button
                              size="sm"
                              variant="outline"
                              // 冻结优先(P2-6):冻结期间交付面一律 404,所以"上架"没有意义
                              // (服务端同样返回 403 APP_FROZEN + hint,这里只是别让它可点)。
                              disabled={isBusy || frozen}
                              aria-describedby={frozen ? `frozen-reason-${row.app_id}` : undefined}
                              // R1-uxw-13:下架 = 全组织员工当场不可用(与冻结同级的可见性
                              // 破坏),必须确认;上架是恢复动作,不打扰(与解冻一致)。
                              onClick={() => { row.enabled ? setUnpublishTarget(row) : void togglePublished(row) }}
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
            {ownerError && (
              <p data-testid="owner-error" role="alert" aria-live="assertive" className="text-sm text-destructive">
                {ownerError}
              </p>
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

      {/* 下架确认(R1-uxw-13):下架 = 全组织员工当场不可用,与冻结同级的可见性破坏,
          此前却是一键生效;而同类风险的冻结/审批开关/拒绝都有重确认 ⇒ 语义不成体系。
          规则收敛为:**可见性下降/破坏性动作要确认(冻结、下架、关闭子域、拒绝),
          恢复类动作不打扰(解冻、上架)**。 */}
      <Dialog open={unpublishTarget !== null} onOpenChange={(open) => { if (!open) setUnpublishTarget(null) }}>
        <DialogContent data-testid="unpublish-confirm-dialog">
          <DialogHeader>
            <DialogTitle>
              下架应用{unpublishTarget ? `:${unpublishTarget.title || unpublishTarget.app_id}` : ''}?
            </DialogTitle>
            <DialogDescription>下架影响该应用的全部使用者,但不删除任何数据。</DialogDescription>
          </DialogHeader>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            <li><strong>员工端立即不可用</strong>:该应用对所有人消失,已在用的人当场打不开。</li>
            <li><strong>数据保留</strong>:应用数据与已发布版本都不动,重新上架即恢复。</li>
            <li><strong>如何回滚</strong>:本页「上架」按钮即可恢复(恢复类动作不需要再确认)。</li>
          </ul>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => { setUnpublishTarget(null) }}>取消</Button>
            <Button
              variant="destructive"
              data-testid="unpublish-confirm"
              disabled={busy !== ''}
              onClick={() => {
                const row = unpublishTarget
                setUnpublishTarget(null)
                if (row) void togglePublished(row)
              }}
            >
              确认下架
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
            {rejectError && (
              <p data-testid="reject-error" role="alert" aria-live="assertive" className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-sm text-destructive">
                {rejectError}
              </p>
            )}
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
          {/* R1-uxw-1:审核的成败反馈渲染在**对话框内部**。
              此前它走页面级的 apps-error/apps-flash,而 Radix 的整屏遮罩
              (`fixed inset-0 z-50 bg-black/80`)把它压在下面 —— 真实 Chromium 的
              elementFromPoint 命中测试显示:错误文本中心点命中的是弹窗标题,
              管理员看到的是"点了没反应"。放这里 = 天然浮在遮罩之上。 */}
          {detailFeedback && (
            <div
              data-testid="detail-feedback"
              role={detailFeedback.kind === 'err' ? 'alert' : 'status'}
              aria-live={detailFeedback.kind === 'err' ? 'assertive' : 'polite'}
              className={`rounded-md border px-3 py-2 text-sm ${
                detailFeedback.kind === 'err'
                  ? 'border-destructive/40 bg-destructive/10 text-destructive'
                  : 'border-border bg-muted'
              }`}
            >
              {detailFeedback.text}
            </div>
          )}
          {detail && (
            <dl className="grid grid-cols-[6.5rem_1fr] gap-x-3 gap-y-2 text-sm">
              <dt className="text-muted-foreground">用途</dt>
              <dd className="break-words">{detail.purpose || '—'}</dd>
              <dt className="text-muted-foreground">数据敏感度</dt>
              <dd>{detail.data_sensitivity || '—'}</dd>
              <dt className="text-muted-foreground">当前生效版本</dt>
              <dd className="font-mono" data-testid="detail-current-version">{currentVersionShown || '—'}</dd>
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
                  onClick={() => { void loadPending(detail.app_id); void loadRejected(detail.app_id) }}
                  data-testid="pending-refresh"
                >
                  <RefreshCw className="h-4 w-4" />
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {/* 与上面 dl 里的「当前生效版本」共用同一个取值(currentVersionShown):
                    两处各读各的会出现"同屏两个当前生效版本"(R1-uxw-5)。 */}
                当前生效版本:<span className="font-mono" data-testid="pending-current-version">{currentVersionShown || '—'}</span>
                (审批通过后线上切到新版本;拒绝会释放归档字节)
              </p>
              {pendingError && <p className="text-sm text-destructive" role="alert" aria-live="assertive" data-testid="pending-error">{pendingError}</p>}
              {/* 禁用原因不能只写 title(R1-uxw-14):禁用按钮不可聚焦,读屏/键盘用户
                  只能看到一个点不动的「通过」。常驻 sr-only 说明 + aria-describedby。 */}
              {!canWrite && (
                <span id="pending-write-note" data-testid="pending-write-note" tabIndex={0} className="sr-only">
                  没有 capability:write 权限:通过/拒绝按钮已禁用(服务端同样会拒绝写请求)
                </span>
              )}
              {/* 刚提交的驳回:理由必须留在管理员眼前。下面「最近被拒」子清单是权威来源
                  (服务端 status=rejected 下发 reason),这一条是即时回显。 */}
              {lastRejection && (
                <p className="rounded-md border border-border bg-muted px-2 py-1.5 text-xs" data-testid="last-rejection">
                  已拒绝 v{lastRejection.version}
                  {lastRejection.reason !== '' ? `:${lastRejection.reason}` : '(未填写理由)'}
                </p>
              )}
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
                        {/* 审核理由(驳回理由):服务端在**每一行**下发 reason(非 rejected
                            行为空串),渲染位与「最近被拒」子清单共用同一字段名。 */}
                        {rel.reason && (
                          <div className="text-xs text-destructive" data-testid={`pending-reason-${rel.version}`}>
                            审核理由:{rel.reason}
                          </div>
                        )}
                      </div>
                      {/* 无写权限时**禁用而不是隐藏**(与开关同风格):待审清单本身是
                          只读可见的信息,按钮消失会让只读账号以为"没有待审"。 */}
                      <div className="flex items-center gap-1">
                        <Button
                          size="sm"
                          data-testid={`pending-approve-${rel.version}`}
                          disabled={!canWrite || busy !== ''}
                          aria-describedby={!canWrite ? 'pending-write-note' : undefined}
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
                          aria-describedby={!canWrite ? 'pending-write-note' : undefined}
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

              {/* 最近被拒(R1-uxw-4):服务端此前连 reason 都不下发 —— 管理员写过的拒绝理由
                  只躺在审计详情里,审批面自己都回看不了。这里用 status=rejected 取回
                  (含 reason),与待审队列并列显示,失败/空态各自可见。 */}
              <div className="space-y-1 border-t pt-2" data-testid="rejected-block">
                <h4 className="text-xs font-semibold text-muted-foreground">最近被拒版本({rejected.length})</h4>
                {rejectedError && (
                  <p className="text-sm text-destructive" role="alert" aria-live="assertive" data-testid="rejected-error">{rejectedError}</p>
                )}
                {!rejectedError && rejected.length === 0 ? (
                  <p className="text-sm text-muted-foreground" data-testid="rejected-empty">没有被拒的版本。</p>
                ) : (
                  <ul className="space-y-1" data-testid="rejected-list">
                    {rejected.map((rel) => (
                      <li key={rel.version} className="text-xs" data-testid={`rejected-${rel.version}`}>
                        <span className="font-mono">v{rel.version}</span>
                        {rel.publisher && <span className="text-muted-foreground">{` · 提交人 ${rel.publisher}`}</span>}
                        <span className="text-muted-foreground">{` · ${fmtTime(rel.created_at)}`}</span>
                        {/* 被拒理由(驳回结果)必须显示出来:它就是"为什么没过"的答案。 */}
                        <div className="text-destructive" data-testid={`rejected-reason-${rel.version}`}>
                          {`审核理由:${rel.reason && rel.reason !== '' ? rel.reason : '(未填写理由)'}`}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
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
