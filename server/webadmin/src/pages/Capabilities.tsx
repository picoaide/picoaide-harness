import { useCallback, useEffect, useRef, useState } from 'react'
import { request, ADMIN_API } from '../api'
import { Button } from '../components/ui/button'
import { Badge } from '../components/ui/badge'
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table'
import { PageHeader } from '../components/page-header'
import { EmptyState } from '../components/empty-state'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/dialog'
import { Textarea } from '../components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select'
import { Download, FileText, Lock, RefreshCw, Share2, ShieldCheck, Sparkles, TriangleAlert, UserCog } from 'lucide-react'
import { Input } from '../components/ui/input'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card'
import { GrantDialog } from '../components/grant-dialog'
import { ArchivePreviewDialog, ArchivePreviewData } from '../components/archive-preview-dialog'

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
  quality: '' | 'official' | 'featured'
  downloads: number
  calls?: number
  created_at: string
  base_path: string
  /** 授权基路径(name-only,授权是资源级,同名多版本共享);非 base_path。 */
  grants_base: string
  preview_path: string
  conflict?: boolean
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

interface LockRow { kind: 'skill' | 'agent'; name: string; reason: string; locked_by: string }

/**
 * 锁定管理(决策 2026-09-01 D4):被锁定的技能/智能体只能由管理员发布,
 * 员工在客户端上传时会收到 403 与此处填写的理由。支持对**尚不存在**的
 * 名字预先锁定(占名),防止员工抢占官方命名。
 */
function LockPanel() {
  const [locks, setLocks] = useState<LockRow[]>([])
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [kind, setKind] = useState<'skill' | 'agent'>('skill')
  const [name, setName] = useState('')
  const [reason, setReason] = useState('')

  const load = useCallback(async () => {
    try {
      const data = await request<{ locks: LockRow[] }>(`${ADMIN_API}/capability-locks`)
      setLocks(data.locks ?? [])
      setErr('')
    } catch (e) { setErr((e as Error).message) }
  }, [])
  useEffect(() => { void load() }, [load])

  const add = async () => {
    if (!name.trim()) return
    setBusy(true)
    try {
      await request(`${ADMIN_API}/capability-locks/${kind}/${encodeURIComponent(name.trim())}`,
        { method: 'PUT', body: JSON.stringify({ reason: reason.trim() }) })
      setName(''); setReason(''); await load()
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }
  const remove = async (l: LockRow) => {
    if (!window.confirm(`解除「${l.name}」的锁定?解除后员工可再次上传该名称。`)) return
    setBusy(true)
    try {
      await request(`${ADMIN_API}/capability-locks/${l.kind}/${encodeURIComponent(l.name)}`, { method: 'DELETE' })
      await load()
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><Lock className="h-4 w-4" /> 锁定管理</CardTitle>
        <CardDescription>
          锁定的名称只能由管理员发布,员工上传会被拒绝并看到下方理由;可对尚不存在的名称预先锁定以保护官方命名
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {err !== '' && <div className="text-sm text-destructive">{err}</div>}
        <div className="flex flex-wrap items-end gap-2">
          <Select value={kind} onValueChange={(v) => { setKind(v as 'skill' | 'agent') }}>
            <SelectTrigger className="w-28" aria-label="锁定类型"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="skill">技能</SelectItem>
              <SelectItem value="agent">智能体</SelectItem>
            </SelectContent>
          </Select>
          <Input className="w-56" placeholder="名称(小写 kebab-case)" value={name} onChange={(e) => { setName(e.target.value) }} />
          <Input className="w-72" placeholder="锁定理由(员工可见)" value={reason} onChange={(e) => { setReason(e.target.value) }} />
          <Button size="sm" disabled={busy || !name.trim()} onClick={() => { void add() }}>锁定</Button>
        </div>
        {locks.length === 0
          ? <p className="text-sm text-muted-foreground">暂无锁定名称</p>
          : (
            <Table>
              <TableHeader>
                <TableRow><TableHead>类型</TableHead><TableHead>名称</TableHead><TableHead>理由</TableHead><TableHead>操作人</TableHead><TableHead /></TableRow>
              </TableHeader>
              <TableBody>
                {locks.map((l) => (
                  <TableRow key={`${l.kind}:${l.name}`}>
                    <TableCell><Badge variant="outline">{l.kind === 'agent' ? '智能体' : '技能'}</Badge></TableCell>
                    <TableCell className="font-mono text-xs">{l.name}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{l.reason || '—'}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{l.locked_by || '—'}</TableCell>
                    <TableCell className="text-right">
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void remove(l) }}>解除</Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
      </CardContent>
    </Card>
  )
}

export default function Capabilities() {
  const [allRows, setAllRows] = useState<ApprovalRow[]>([])
  // 独立的全状态计数数据(仅 tab 徽章用);allRows 只含当前 status 过滤后的
  // 列表,不能用于跨状态计数(否则其它 tab 的徽章恒为 0,2026-09-01 审计发现)。
  const [countRows, setCountRows] = useState<ApprovalRow[]>([])
  const [tab, setTab] = useState('pending')
  const [typeFilter, setTypeFilter] = useState<'all' | 'skill' | 'agent'>('all')
  const [error, setError] = useState('')
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
  const [transferOwner, setTransferOwner] = useState('')
  const [transferBusy, setTransferBusy] = useState(false)

  useEffect(() => {
    request(`${ADMIN_API}/departments`)
      .then((data) => { setDepartments(data.departments ?? []) })
      .catch(() => { /* 单用户授权仍可用 */ })
  }, [])
  const loadSeq = useRef(0)

  const load = useCallback(async (status: string, kind: 'all' | 'skill' | 'agent') => {
    const current = ++loadSeq.current
    setLoading(true)
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
      setError(err.message)
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

  const setQuality = async (row: ApprovalRow, quality: '' | 'official' | 'featured') => {
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

  // 归属转移(2026-09-02):PUT /api/server/admin/apps/:kind/:app_id/owner。
  // 只改 apps.owner(谁能续传),不触碰版本/授权/渠道;审计由服务端留痕。
  const transfer = async (row: ApprovalRow) => {
    const target = transferOwner.trim()
    if (target === '' || transferRow === null) return
    setTransferBusy(true)
    setError('')
    try {
      await request(`${ADMIN_API}/apps/${row.kind}/${encodeURIComponent(row.name)}/owner`, {
        method: 'PUT',
        body: JSON.stringify({ owner: target }),
      })
      setTransferRow(null)
      setTransferOwner('')
      await load(tab, typeFilter)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setTransferBusy(false)
    }
  }

  const counts = {
    all: countRows.length,
    pending: countRows.filter(r => r.status === 'pending').length,
    approved: countRows.filter(r => r.status === 'approved').length,
    rejected: countRows.filter(r => r.status === 'rejected').length,
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="能力中心"
        desc="共享技能与共享 Agent 的统一审核队列;通过后需授权才可见可装"
        actions={
          <Button variant="outline" size="sm" onClick={() => { void load(tab, typeFilter) }}>
            <RefreshCw className="h-4 w-4" /> 刷新
          </Button>
        }
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
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {loading ? (
        <EmptyState icon={<Share2 className="h-6 w-6" />} title="加载中…" desc="请稍候" />
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
                const isBusy = busy === row.name + row.version + 'approve'
                  || busy === row.name + row.version + 'reject'
                  || busy === row.name + row.version + 'delete'
                  || busy === row.name + row.version + 'quality'
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
                    <TableCell><Badge variant={meta.variant}>{meta.label}</Badge></TableCell>
                    <TableCell>
                      {row.status === 'approved' ? (
                        <Select
                          value={row.quality || 'none'}
                          onValueChange={(v) => { void setQuality(row, v === 'none' ? '' : v as '' | 'official' | 'featured') }}
                          disabled={isBusy}
                        >
                          <SelectTrigger className="h-7 w-24 text-xs">
                            <SelectValue placeholder="无" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">无</SelectItem>
                            <SelectItem value="official">官方</SelectItem>
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
                          title="下载归档核查">
                          <Download className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="sm" disabled={isBusy}
                          onClick={() => { setTransferRow(row); setTransferOwner(row.owner ?? '') }}
                          title="转移归属(负责人)">
                          <UserCog className="h-4 w-4" />
                        </Button>
                        {row.status === 'approved' && (
                          <Button size="sm" variant="outline" disabled={isBusy} onClick={() => { setGrantName(row.name); setGrantBase(row.grants_base) }} title="授权">
                            <ShieldCheck className="h-4 w-4" />
                          </Button>
                        )}
                        {row.status !== 'approved' && (
                          <Button size="sm" disabled={isBusy} onClick={() => { setConfirm(row); setConfirmKind('approve') }}>通过</Button>
                        )}
                        {row.status !== 'rejected' && (
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

      <LockPanel />

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
            {confirmKind === 'reject' && '拒绝后仅上传者可见并可重新上传。请填写理由,上传者可见。'}
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

      {/* 归属转移(2026-09-02):管理员把维护权交给其他员工/管理员账号。 */}
      <Dialog open={transferRow !== null} onOpenChange={(open) => { if (!open) { setTransferRow(null); setTransferOwner('') } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>转移归属</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {transferRow && `将「${transferRow.display_name || transferRow.name}」的维护权转移给新负责人:原负责人不能再上传新版本,新负责人获得续传权(版本须递增)。`}
          </p>
          <Input
            value={transferOwner}
            onChange={e => { setTransferOwner(e.target.value) }}
            placeholder="新归属人用户名"
            aria-label="新归属人用户名"
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => { setTransferRow(null); setTransferOwner('') }}>取消</Button>
            <Button
              disabled={transferBusy || transferOwner.trim() === ''}
              onClick={() => { void transfer(transferRow!) }}
            >
              {transferBusy ? '处理中…' : '确认转移'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
