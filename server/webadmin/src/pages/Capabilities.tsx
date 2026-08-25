import { useCallback, useEffect, useRef, useState } from 'react'
import { request } from '../api'
import { Button } from '../components/ui/button'
import { Badge } from '../components/ui/badge'
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table'
import { PageHeader } from '../components/page-header'
import { EmptyState } from '../components/empty-state'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../components/ui/dialog'
import { Textarea } from '../components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select'
import { Download, FileText, RefreshCw, Sparkles, Share2, ShieldCheck } from 'lucide-react'
import { GrantDialog } from '../components/grant-dialog'

/**
 * 能力中心·统一审批(决策 2026-08-25 Phase 3):共享技能与共享 Agent 的
 * pending 队列归并到一个列表(类型徽章区分),approve/reject/delete 与授权
 * 仍走各自原域端点(base_path 由服务端逐行下发),质量标记(官方/精选)经
 * 各域 /quality 端点设置。不复制审核逻辑,仅组合与状态编排。
 */

interface ApprovalRow {
  kind: 'skill' | 'agent'
  name: string
  version: string
  display_name: string
  description: string
  author: string
  status: 'pending' | 'approved' | 'rejected'
  reason: string
  quality: '' | 'official' | 'featured'
  created_at: string
  base_path: string
  preview_path: string
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

export default function Capabilities() {
  const [allRows, setAllRows] = useState<ApprovalRow[]>([])
  const [tab, setTab] = useState('pending')
  const [typeFilter, setTypeFilter] = useState<'all' | 'skill' | 'agent'>('all')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [confirm, setConfirm] = useState<ApprovalRow | null>(null)
  const [confirmKind, setConfirmKind] = useState<'approve' | 'reject' | 'delete'>('approve')
  const [reason, setReason] = useState('')
  const [preview, setPreview] = useState<{ files: string[]; skill_md?: string; composition?: string } | null>(null)
  const [previewKey, setPreviewKey] = useState('')
  const [busy, setBusy] = useState('')
  const [grantName, setGrantName] = useState('')
  const [grantBase, setGrantBase] = useState('')
  const [departments, setDepartments] = useState<Dept[]>([])

  useEffect(() => {
    request('/api/admin/departments')
      .then((data) => { setDepartments(data.departments ?? []) })
      .catch(() => { /* 单用户授权仍可用 */ })
  }, [])
  const loadSeq = useRef(0)

  const load = useCallback(async () => {
    const current = ++loadSeq.current
    setLoading(true)
    setError('')
    try {
      const data = await request<{ approvals: ApprovalRow[] }>('/api/admin/capabilities/approvals')
      if (current !== loadSeq.current) return
      setAllRows(data.approvals ?? [])
    } catch (err: any) {
      if (current !== loadSeq.current) return
      setError(err.message)
    } finally {
      if (current === loadSeq.current) setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const shown = allRows
    .filter(r => (tab === 'all' || r.status === tab) && (typeFilter === 'all' || r.kind === typeFilter))

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
      await load()
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
      await load()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusy('')
    }
  }

  const openPreview = async (row: ApprovalRow) => {
    setPreviewKey(row.display_name || row.name + '@' + row.version)
    setPreview(null)
    setError('')
    try {
      const data = await request<{ files: string[]; skill_md?: string; composition?: string }>(row.preview_path)
      setPreview(data)
    } catch (err: any) {
      setError(err.message)
      setPreviewKey('')
    }
  }

  const counts = {
    all: allRows.length,
    pending: allRows.filter(r => r.status === 'pending').length,
    approved: allRows.filter(r => r.status === 'approved').length,
    rejected: allRows.filter(r => r.status === 'rejected').length,
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="能力中心"
        desc="共享技能与共享 Agent 的统一审核队列;通过后需授权才可见可装"
        actions={
          <Button variant="outline" size="sm" onClick={() => { void load() }}>
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
        <EmptyState icon={<Sparkles className="h-6 w-6" />} title="加载中…" desc="请稍候" />
      ) : shown.length === 0 ? (
        <EmptyState icon={<Sparkles className="h-6 w-6" />} title="暂无待处理能力" desc="员工上传的技能/Agent 将出现在这里" />
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>类型</TableHead>
                <TableHead>名称 / 标题</TableHead>
                <TableHead>版本</TableHead>
                <TableHead>作者</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>质量</TableHead>
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
                    <TableCell><Badge variant="outline"><KindIcon className="mr-1 h-3 w-3" />{kindMeta.label}</Badge></TableCell>
                    <TableCell>
                      <div className="whitespace-nowrap font-medium">{row.display_name || row.name}</div>
                      <div className="text-xs text-muted-foreground">{row.name}</div>
                    </TableCell>
                    <TableCell className="font-mono text-sm">{row.version}</TableCell>
                    <TableCell>{row.author}</TableCell>
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
                        {row.status === 'approved' && (
                          <Button size="sm" variant="outline" disabled={isBusy} onClick={() => { setGrantName(row.name); setGrantBase(row.base_path) }} title="授权">
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

      {/* 内容预览 */}
      <Dialog open={previewKey !== ''} onOpenChange={(open) => { if (!open) setPreviewKey('') }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>内容预览: {previewKey}</DialogTitle>
            <DialogDescription>归档内容与文件清单(用于决策审核)</DialogDescription>
          </DialogHeader>
          {preview === null ? (
            <p className="text-sm text-muted-foreground">加载中…</p>
          ) : (
            <div className="space-y-3">
              <div>
                <h4 className="mb-1 text-sm font-medium">{preview.skill_md !== undefined ? 'SKILL.md' : 'agent.cordis.yml'}</h4>
                <pre className="max-h-64 overflow-auto rounded-md bg-muted p-3 text-xs">{preview.skill_md ?? preview.composition ?? '—'}</pre>
              </div>
              <div>
                <h4 className="mb-1 text-sm font-medium">文件清单（{preview.files.length}）</h4>
                <div className="flex max-h-40 flex-wrap gap-1 overflow-auto">
                  {preview.files.map(f => (
                    <Badge key={f} variant="outline" className="font-mono text-[11px]">{f}</Badge>
                  ))}
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

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
        onSaved={() => { void load() }}
      />
    </div>
  )
}
