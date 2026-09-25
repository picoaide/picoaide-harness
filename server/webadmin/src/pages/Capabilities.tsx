import { useCallback, useEffect, useRef, useState } from 'react'
import { request, ADMIN_API } from '../api'
import { Button } from '../components/ui/button'
import { Badge } from '../components/ui/badge'
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table'
import { EmptyState } from '../components/empty-state'
import { PageHeader } from '../components/page-header'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/dialog'
import { Textarea } from '../components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select'
import { Download, FileText, RefreshCw, Share2, ShieldCheck, Sparkles, TriangleAlert, UserCog } from 'lucide-react'
import { GrantDialog } from '../components/grant-dialog'
import { ArchivePreviewDialog, ArchivePreviewData } from '../components/archive-preview-dialog'
import { TransferOwnerDialog } from '../components/transfer-owner-dialog'

/**
 * 能力中心·统一审批(决策 2026-08-25 Phase 3,2026-09 恢复):共享技能与
 * 共享 Agent 的审核队列归并到一个列表(类型徽章区分 + 类型筛选),
 * approve/reject/delete 与授权仍走各自原域端点(base_path 由服务端逐行
 * 下发,均为 /api/server/admin 前缀),质量标记(官方/精选)经各域 /quality
 * 端点设置。不复制审核逻辑,仅组合与状态编排。
 */

interface ApprovalRow {
  kind: 'skill' | 'agent'
  name: string
  version: string
  display_name: string
  description: string
  author: string
  /** 归属人(apps.owner,2026-09-02 归属权)——与 author(本行上传者)可不同。 */
  owner?: string
  status: 'pending' | 'approved' | 'rejected'
  reason: string
  quality: '' | 'featured'
  downloads: number
  calls?: number
  created_at: string
  base_path: string
  /** 授权基路径(name-only,授权是资源级,同名多版本共享);非 base_path。 */
  grants_base: string
  preview_path: string
  conflict?: boolean
  /** 上下架状态（App 级，2026-09-15；智能体行 2026-09-17 起同样下发）。 */
  enabled?: boolean
}

interface Dept {
  id: number
  parent_id: number
  name: string
}

const STATUS_META: Record<ApprovalRow['status'], { label: string; variant: 'secondary' | 'success' | 'destructive' }> = {
  pending: { label: '待审核', variant: 'secondary' },
  approved: { label: '已通过', variant: 'success' },
  rejected: { label: '已拒绝', variant: 'destructive' },
}

const KIND_META: Record<ApprovalRow['kind'], { label: string; icon: typeof Sparkles }> = {
  skill: { label: '技能', icon: Sparkles },
  agent: { label: '智能体', icon: Share2 },
}

function fmtTime(iso: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('zh-CN', { hour12: false })
}

/**
 * 「待审 + 应用已下架」这一格为什么不能点（R6-B P2，2026-09-23）。
 *
 * 服务端自第五轮起在下架期间对 approve 一律 409 `APP_DELISTED`
 * （`server/internal/sharedskills/routes.go` 的 `Distribution.Writable()`，agentshare 同闸；
 * 带真 PG 的回归用例 `internal/capabilities/r5b_delist_owner_semantics_test.go` 明确造出
 * "先有 1.1.0 待审、再下架"并断言 409）。而本页此前只在 `status === 'approved'` 的行上
 * 渲染下架徽标，待审行给出的是一个**注定失败**的「通过」按钮，事前没有任何标记。
 *
 * 文案与 `APP_DELISTED` 语义一致，并给出 Admin 在本页可达的处置路径
 * （上下架是 App 级、按 name 生效 ⇒ 在「已通过」页对同名应用的已通过版本「上架」即可解冻）。
 */
export const DELISTED_PENDING_HINT =
  '该应用已下架：下架期间「通过」会被服务端拒绝（409 APP_DELISTED）。请先到「已通过」页对该应用「上架」。'

/**
 * 锁定管理(决策 2026-09-01 D4):被锁定的技能/智能体只能由管理员发布,
 * 员工在客户端上传时会收到 403 与此处填写的理由。支持对**尚不存在**的
 * 名字预先锁定(占名),防止员工抢占官方命名。
 */

export default function Capabilities() {
  const [allRows, setAllRows] = useState<ApprovalRow[]>([])
  // 独立的全状态计数数据(仅 tab 徽章用);allRows 只含当前 status 过滤后的
  // 列表,不能用于跨状态计数(否则其它 tab 的徽章恒为 0,2026-09-01 审计发现)。
  const [countRows, setCountRows] = useState<ApprovalRow[]>([])
  const [tab, setTab] = useState('pending')
  const [typeFilter, setTypeFilter] = useState<'all' | 'skill' | 'agent'>('all')
  const [error, setError] = useState('')
  /**
   * **列表读取**失败（R16A-18，审计 2026-09-25，P3）：必须与 `error`（**动作**失败：
   * 拒绝理由为空 / approve / reject / delete / 上下架的 catch）分开。
   *
   * 合用一个状态时，一次**写**请求失败就会把整张表换成「审批列表未读取成功 /
   * 读取失败时不渲染任何行」—— 而列表读**从未**失败，文案还反过来说"为避免把上一页
   * 的数据当成当前结果"。同族修法（R15C-W-04）在 Departments/Apps/Balance/Audit
   * 已经就位（`loadError`），本页与 Connectors 是漏掉的两处。
   *
   * 渲染口径不变：`loadError` 非空 ⇒ 页面级确定态（不渲染任何行，指回刷新入口）；
   * `error` 非空 ⇒ 只显示横幅，**表格照常渲染**（动作失败不改变"当前数据是这一份"）。
   */
  const [loadError, setLoadError] = useState('')
  const [loading, setLoading] = useState(true)
  const [confirm, setConfirm] = useState<ApprovalRow | null>(null)
  const [confirmKind, setConfirmKind] = useState<'approve' | 'reject' | 'delete'>('approve')
  const [reason, setReason] = useState('')
  const [preview, setPreview] = useState<ArchivePreviewData | null>(null)
  const [previewKey, setPreviewKey] = useState('')
  const [previewRow, setPreviewRow] = useState<ApprovalRow | null>(null)
  const [busy, setBusy] = useState('')
  const [grantName, setGrantName] = useState('')
  const [grantBase, setGrantBase] = useState('')
  const [departments, setDepartments] = useState<Dept[]>([])
  // 归属转移(2026-09-02):管理员可修改技能/智能体负责人。
  const [transferRow, setTransferRow] = useState<ApprovalRow | null>(null)

  useEffect(() => {
    request(`${ADMIN_API}/departments`)
      .then((data) => { setDepartments(data.departments ?? []) })
      .catch(() => { /* 单用户授权仍可用 */ })
  }, [])
  const loadSeq = useRef(0)

  const load = useCallback(async (status: string, kind: 'all' | 'skill' | 'agent') => {
    const current = ++loadSeq.current
    setLoading(true)
    // 只清"读取失败"；**不清**动作失败的横幅（否则一次自动重拉会把管理员刚看到的
    // "删除失败：xxx"悄悄抹掉，而他们正需要据此重试或换做法）。
    setLoadError('')
    setError('')
    try {
      // status=all 必须显式传(服务端缺省=仅 pending);type 缺省=全部。
      const qs = new URLSearchParams({ status })
      if (kind !== 'all') qs.set('type', kind)
      const data = await request<{ approvals: ApprovalRow[] }>(`${ADMIN_API}/capabilities/approvals?${qs}`)
      if (current !== loadSeq.current) return
      setAllRows(data.approvals ?? [])
    } catch (err: any) {
      if (current !== loadSeq.current) return
      // R15C-W-02（审计 2026-09-25，P2）：失败必须把**行**清掉。此前只 setError，
      // 切 tab 后失败仍渲染上一个 tab 的行，而行内「删除/通过/拒绝/下架」全部可点
      // —— 管理员点「已拒绝」本意是清理已拒绝的版本，屏幕上却是待审版本，删除还会
      // 不可恢复地释放归档字节。与 Apps.tsx「列表读取失败 = 页面级的确定态」同口径。
      setAllRows([])
      setLoadError(err.message)
    } finally {
      if (current === loadSeq.current) setLoading(false)
    }
  }, [])

  // tab/type 变化都触发重拉(服务端过滤);计数用独立的全状态数据。
  useEffect(() => { void load(tab, typeFilter) }, [load, tab, typeFilter])

  // tab 徽章计数:status=all 全量(与当前 tab/type 无关——计数反映每种
  // 状态的真实总量;type 筛选时同样按 type 拉全状态)。
  useEffect(() => {
    let cancelled = false
    const qs = new URLSearchParams({ status: 'all' })
    if (typeFilter !== 'all') qs.set('type', typeFilter)
    void request<{ approvals: ApprovalRow[] }>(`${ADMIN_API}/capabilities/approvals?${qs}`)
      .then((data) => { if (!cancelled) setCountRows(data.approvals ?? []) })
      .catch(() => { /* 徽章保持上次值,不阻塞列表 */ })
    return () => { cancelled = true }
  }, [typeFilter])

  const shown = allRows

  const act = async (row: ApprovalRow, kind: 'approve' | 'reject' | 'delete') => {
    if (busy) return
    setBusy(row.name + row.version + kind)
    setError('')
    try {
      const base = row.base_path
      if (kind === 'delete') {
        await request(base, { method: 'DELETE' })
      } else if (kind === 'reject') {
        const trimmed = reason.trim()
        if (trimmed === '') {
          setError('请填写拒绝理由')
          setBusy('')
          return
        }
        await request(`${base}/reject`, { method: 'POST', body: JSON.stringify({ reason: trimmed }) })
      } else {
        await request(`${base}/approve`, { method: 'POST' })
      }
      setConfirm(null)
      setReason('')
      await load(tab, typeFilter)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusy('')
    }
  }

  /**
   * 组织共享技能/智能体上下架（技能 2026-09-15，智能体 2026-09-17 SG-4）：
   * apps.enabled 级开关，员工可见性与下载同时受控。两 kind 的服务端端点对称
   * （/shared-skills/:name/enabled 与 /agent-presets/:name/enabled），都挂在
   * 行的 grants_base 下，故这里不需要按 kind 分支。
   */
  const setEnabled = async (row: ApprovalRow, enabled: boolean) => {
    if (busy) return
    setBusy(row.name + row.version + 'enabled')
    setError('')
    try {
      await request(`${row.grants_base}/enabled`, { method: 'PUT', body: JSON.stringify({ enabled }) })
      await load(tab, typeFilter)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusy('')
    }
  }

  const setQuality = async (row: ApprovalRow, quality: '' | 'featured') => {
    if (row.status !== 'approved') return
    setBusy(row.name + row.version + 'quality')
    setError('')
    try {
      await request(`${row.base_path}/quality`, { method: 'PUT', body: JSON.stringify({ quality }) })
      await load(tab, typeFilter)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusy('')
    }
  }

  const openPreview = async (row: ApprovalRow) => {
    setPreviewKey(row.display_name || row.name + '@' + row.version)
    setPreviewRow(row)
    setPreview(null)
    setError('')
    try {
      const data = await request<ArchivePreviewData>(row.preview_path)
      setPreview(data)
    } catch (err: any) {
      setError(err.message)
      setPreviewKey('')
    }
  }

  // 归属转移(2026-09-02):行按钮只打开公共 TransferOwnerDialog,
  // PUT /apps/:kind/:app_id/owner 与错误展示在弹窗组件内,审计由服务端留痕。
  const counts = {
    all: countRows.length,
    pending: countRows.filter(r => r.status === 'pending').length,
    approved: countRows.filter(r => r.status === 'approved').length,
    rejected: countRows.filter(r => r.status === 'rejected').length,
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="审批"
        desc="员工上传的技能/智能体统一审批队列:通过→授权可见;官方归属与锁定管理在对应市场页"
      />
      {/* 状态 tab + 类型筛选 */}
      <div className="flex items-center justify-between gap-2">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="pending">待审核（{counts.pending}）</TabsTrigger>
            <TabsTrigger value="approved">已通过（{counts.approved}）</TabsTrigger>
            <TabsTrigger value="rejected">已拒绝（{counts.rejected}）</TabsTrigger>
            <TabsTrigger value="all">全部（{counts.all}）</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="flex items-center gap-1">
          {(['all', 'skill', 'agent'] as const).map(t => (
            <Button key={t} size="sm" variant={typeFilter === t ? 'default' : 'outline'} onClick={() => { setTypeFilter(t) }}>
              {t === 'all' ? '全部类型' : KIND_META[t].label}
            </Button>
          ))}
          <Button variant="outline" size="sm" className="ml-1" onClick={() => { void load(tab, typeFilter) }} title="刷新">
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* 横幅：**读取失败与动作失败都显示原文**（否则读取失败的具体原因只剩
          「…未读取成功」一句，运维拿不到 500 里的细节）。与 Departments.tsx 同口径。 */}
      {(loadError || error) && <p className="text-sm text-destructive">{loadError || error}</p>}

      {loading ? (
        <EmptyState icon={<Share2 className="h-6 w-6" />} title="加载中…" desc="请稍候" />
      ) : loadError ? (
        // 失败 ≠ 空态：说清"没读到"，并指回可用的重试入口（右上角刷新 / 切换 tab）。
        // 判据必须是 **loadError**（列表读失败），不是 error（动作失败）——见 state 注释。
        <EmptyState icon={<Share2 className="h-6 w-6" />} title="审批列表未读取成功"
          desc="为避免把上一页的数据当成当前结果，读取失败时不渲染任何行；请点右上角刷新重试" />
      ) : shown.length === 0 ? (
        <EmptyState icon={<Share2 className="h-6 w-6" />} title="暂无待处理能力" desc="员工上传的技能/Agent 将出现在这里" />
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>类型</TableHead>
                <TableHead>名称 / 标题</TableHead>
                <TableHead>版本</TableHead>
                <TableHead>作者</TableHead>
                <TableHead>归属</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>质量</TableHead>
                <TableHead>下载/调用</TableHead>
                <TableHead>上传时间</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map(row => {
                const meta = STATUS_META[row.status]
                const kindMeta = KIND_META[row.kind]
                const KindIcon = kindMeta.icon
                // 行内**任一**操作在途都要置灰并拦住重复点击。此前漏了 'enabled'
                // （上下架的键，见 setEnabled）⇒ 管理员在"下架"在途时点"重新上架"会被
                // `if (busy) return` 静默吞掉、按钮也不置灰，零反馈（2026-09-17 独立审计）。
                const isBusy = busy === row.name + row.version + 'approve'
                  || busy === row.name + row.version + 'reject'
                  || busy === row.name + row.version + 'delete'
                  || busy === row.name + row.version + 'quality'
                  || busy === row.name + row.version + 'enabled'
                return (
                  <TableRow key={row.kind + ':' + row.name + '@' + row.version}>
                    <TableCell>
                      <Badge variant="outline"><KindIcon className="mr-1 h-3 w-3" />{kindMeta.label}</Badge>
                    </TableCell>
                    <TableCell>
                      <div className="whitespace-nowrap font-medium">
                        {row.display_name || row.name}
                        {row.conflict && (
                          <Badge variant="destructive" className="ml-2" title="与市场技能同名,通过会被 409 阻断,请先处理市场技能">
                            <TriangleAlert className="mr-1 h-3 w-3" />名称冲突
                          </Badge>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground">{row.name}</div>
                    </TableCell>
                    <TableCell className="font-mono text-sm">{row.version}</TableCell>
                    <TableCell>{row.author}</TableCell>
                    <TableCell title="归属人(谁能续传新版本;与作者可不同)">
                      {row.owner || '—'}
                    </TableCell>
                    <TableCell>
                      <Badge variant={meta.variant}>{meta.label}</Badge>
                      {/* 下架徽标按**服务端字段**（`apps.enabled=false`）渲染，不再只在
                          `status === 'approved'` 的行上：待审版本叠在已下架应用上时，
                          通过必被服务端 409 `APP_DELISTED` 拒（R6-B P2），事前必须有标记。 */}
                      {row.enabled === false && (
                        <Badge variant="destructive" className="ml-1" title="已下架：员工目录不可见且不可下载（数据保留）">已下架</Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      {row.status === 'approved' ? (
                        <Select
                          value={row.quality || 'none'}
                          onValueChange={(v) => { void setQuality(row, v === 'none' ? '' : 'featured') }}
                          disabled={isBusy}
                        >
                          <SelectTrigger className="h-7 w-24 text-xs">
                            <SelectValue placeholder="无" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">无</SelectItem>
                            <SelectItem value="featured">精选</SelectItem>
                          </SelectContent>
                        </Select>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      下载 {row.downloads ?? 0}{row.kind === 'skill' ? ` / 调用 ${row.calls ?? 0}` : ''}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{fmtTime(row.created_at)}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => { void openPreview(row) }} title="查看内容预览">
                          <FileText className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="sm"
                          onClick={() => { window.open(`${row.base_path}/archive`, '_blank') }}
                          title="下载归档核查" aria-label="下载归档核查">
                          <Download className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="sm" disabled={isBusy}
                          onClick={() => { setTransferRow(row) }}
                          title="转移归属(负责人)" aria-label="转移归属(负责人)">
                          <UserCog className="h-4 w-4" />
                        </Button>
                        {row.status === 'approved' && (
                          <Button size="sm" variant="outline" disabled={isBusy} onClick={() => { setGrantName(row.name); setGrantBase(row.grants_base) }} title="授权" aria-label="授权">
                            <ShieldCheck className="h-4 w-4" />
                          </Button>
                        )}
                        {row.status === 'approved' && (
                          row.enabled === false ? (
                            <Button size="sm" variant="outline" disabled={isBusy}
                              onClick={() => { void setEnabled(row, true) }}
                              title="重新上架（员工可见可下载）" aria-label="重新上架">
                              上架
                            </Button>
                          ) : (
                            <Button size="sm" variant="outline" disabled={isBusy}
                              onClick={() => { void setEnabled(row, false) }}
                              title="下架（员工不可见、不可下载；数据保留）" aria-label="下架">
                              下架
                            </Button>
                          )
                        )}
                        {row.status !== 'approved' && (
                          // 已下架的待审行：「通过」置灰（点下去必然 409 APP_DELISTED），
                          // 说明挂在**外层 span** 上 —— 禁用按钮不派发鼠标事件，浏览器
                          // 不会显示它自己的 title（R6-B P2）。
                          <span title={row.enabled === false ? DELISTED_PENDING_HINT : undefined}>
                            <Button size="sm" disabled={isBusy || row.enabled === false}
                              onClick={() => { setConfirm(row); setConfirmKind('approve') }}>通过</Button>
                          </span>
                        )}
                        {/* 拒绝只对待审版本开放(ID-01,审计 2026-09-23):拒绝与
                            「释放归档字节」是同一条 UPDATE,对**已通过且在服务中**
                            的版本执行它会不可恢复地销毁归档(该版本对全员 404、版本号
                            烧毁)。要停服务用「下架」(可逆)。服务端在 DAO 层同样拒绝
                            并回 409 APPROVED_NOT_REJECTABLE,这里只是不让入口出现。 */}
                        {row.status === 'pending' && (
                          <Button size="sm" variant="outline" disabled={isBusy} onClick={() => { setReason(''); setConfirm(row); setConfirmKind('reject') }}>拒绝</Button>
                        )}
                        <Button size="sm" variant="destructive" disabled={isBusy} onClick={() => { setConfirm(row); setConfirmKind('delete') }}>删除</Button>
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}


      {/* 内容预览(文件清单可点击查看任意文件内容;主文件按 kind:SKILL.md / agent.cordis.yml) */}
      <ArchivePreviewDialog
        openKey={previewKey}
        data={preview}
        mainTitle={previewRow?.kind === 'agent' ? 'agent.cordis.yml' : 'SKILL.md'}
        mainContent={previewRow?.kind === 'agent' ? (preview?.composition ?? '') : (preview?.skill_md ?? '')}
        fileBase={previewRow ? previewRow.base_path : ''}
        onClose={() => { setPreviewKey('') }}
      />

      {/* 确认弹窗 */}
      <Dialog open={confirm !== null} onOpenChange={(open) => { if (!open) { setConfirm(null); setReason('') } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirm && confirmKind === 'approve' && `确定通过「${confirm.display_name || confirm.name}@${confirm.version}」吗？`}
              {confirm && confirmKind === 'reject' && `确定拒绝「${confirm.display_name || confirm.name}@${confirm.version}」吗？`}
              {confirm && confirmKind === 'delete' && `确定删除「${confirm.display_name || confirm.name}@${confirm.version}」吗？`}
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {confirmKind === 'approve' && '通过后该版本将按授权可见可安装。'}
            {confirmKind === 'reject' && '拒绝后仅上传者可见；该版本的归档字节会被释放且不可恢复。如需停止服务请改用「下架」（可恢复）。请填写理由，上传者可见。'}
            {confirmKind === 'delete' && '删除后记录与归档将被移除,不可恢复。'}
          </p>
          {confirmKind === 'reject' && (
            <Textarea
              value={reason}
              onChange={e => { setReason(e.target.value) }}
              placeholder="拒绝理由(必填,≤500 字,作者可见)"
              maxLength={500}
              rows={3}
              aria-label="拒绝理由"
            />
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => { setConfirm(null); setReason('') }}>取消</Button>
            {confirm && (
              <Button
                variant={confirmKind === 'delete' || confirmKind === 'reject' ? 'destructive' : 'default'}
                disabled={busy !== '' || (confirmKind === 'reject' && reason.trim() === '')}
                onClick={() => { void act(confirm, confirmKind) }}
              >
                {busy ? '处理中…' : '确认'}
              </Button>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <GrantDialog
        open={grantName !== ''}
        name={grantName}
        basePath={grantBase}
        departments={departments}
        onClose={() => { setGrantName(''); setGrantBase('') }}
        onSaved={() => { void load(tab, typeFilter) }}
      />

      {/* 归属转移(2026-09-02):管理员把维护权交给其他员工/管理员账号。
          弹窗组件自包含(输入/错误/提交),与市场技能页共用同一实现。 */}
      <TransferOwnerDialog
        open={transferRow !== null}
        kind={transferRow?.kind ?? 'skill'}
        name={transferRow?.name ?? ''}
        displayName={transferRow?.display_name}
        currentOwner={transferRow?.owner ?? ''}
        onClose={() => { setTransferRow(null) }}
        onSaved={() => { void load(tab, typeFilter) }}
      />
    </div>
  )
}
