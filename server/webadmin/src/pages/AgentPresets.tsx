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
import { Download, FileText, RefreshCw, Share2, ShieldCheck } from 'lucide-react'
import { GrantDialog } from '../components/grant-dialog'

interface PresetRow {
  name: string
  display_name: string
  description: string
  version: string
  author: string
  status: 'pending' | 'approved' | 'rejected'
  reason: string
  downloads?: number
  created_at: string
}

interface Dept {
  id: number
  parent_id: number
  name: string
}

interface PreviewData {
  files: string[]
  composition: string
}

// 状态 → 中文标签与徽章色
const STATUS_META: Record<PresetRow['status'], { label: string; variant: 'secondary' | 'success' | 'destructive' }> = {
  pending: { label: '待审核', variant: 'secondary' },
  approved: { label: '已通过', variant: 'success' },
  rejected: { label: '已拒绝', variant: 'destructive' },
}

function fmtTime(iso: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('zh-CN', { hour12: false })
}

export default function AgentPresets() {
  const [allRows, setAllRows] = useState<PresetRow[]>([])
  const [rows, setRows] = useState<PresetRow[]>([])
  const [tab, setTab] = useState('all')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  // 二次确认(通过/拒绝/删除共用行内确认)
  const [confirm, setConfirm] = useState<{ name: string; version: string; kind: 'approve' | 'reject' | 'delete' } | null>(null)
  // 拒绝理由输入(拒绝确认弹窗内)
  const [reason, setReason] = useState('')
  // 审核预览(composition + 文件清单)
  const [preview, setPreview] = useState<PreviewData | null>(null)
  const [previewName, setPreviewName] = useState('')
  const [busy, setBusy] = useState('')
  // 授权对话框(分享前需授权给用户/部门)
  const [grantName, setGrantName] = useState('')
  const [departments, setDepartments] = useState<Dept[]>([])

  useEffect(() => {
    request('/api/server/admin/departments')
      .then((data) => { setDepartments(data.departments ?? []) })
      .catch(() => { /* 授权对话框内部门为空时仍可单用户授权 */ })
  }, [])
  const loadSeq = useRef(0)

  // counts 必须基于全量数据,不能基于当前 tab 的 rows(否则切 tab 后数字全变)。
  const load = useCallback(async (status: string) => {
    const current = ++loadSeq.current
    setLoading(true)
    setError('')
    try {
      const data = await request<{ presets: PresetRow[] }>('/api/server/admin/agent-presets')
      if (current !== loadSeq.current) return
      setAllRows(data.presets ?? [])
      const filtered = status === 'all' ? (data.presets ?? []) : (data.presets ?? []).filter(r => r.status === status)
      setRows(filtered)
    } catch (err: any) {
      if (current !== loadSeq.current) return
      setError(err.message)
    } finally {
      if (current === loadSeq.current) setLoading(false)
    }
  }, [])

  useEffect(() => { load(tab) }, [load, tab])

  const act = async (name: string, version: string, kind: 'approve' | 'reject' | 'delete') => {
    if (busy) return
    setBusy(name + '@' + version + kind)
    setError('')
    try {
      if (kind === 'delete') {
        await request(`/api/server/admin/agent-presets/${encodeURIComponent(name)}/${encodeURIComponent(version)}`, { method: 'DELETE' })
      } else if (kind === 'reject') {
        const trimmed = reason.trim()
        if (trimmed === '') {
          setError('请填写拒绝理由')
          setBusy('')
          return
        }
        await request(`/api/server/admin/agent-presets/${encodeURIComponent(name)}/${encodeURIComponent(version)}/reject`, {
          method: 'POST',
          body: JSON.stringify({ reason: trimmed }),
        })
      } else {
        await request(`/api/server/admin/agent-presets/${encodeURIComponent(name)}/${encodeURIComponent(version)}/approve`, { method: 'POST' })
      }
      setConfirm(null)
      setReason('')
      await load(tab)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusy('')
    }
  }

  const openPreview = async (name: string, version: string) => {
    setPreviewName(name + '@' + version)
    setPreview(null)
    setError('')
    try {
      const data = await request<PreviewData>(`/api/server/admin/agent-presets/${encodeURIComponent(name)}/${encodeURIComponent(version)}/preview`)
      setPreview(data)
    } catch (err: any) {
      setError(err.message)
      setPreviewName('')
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
        title="共享 Agent"
        desc="员工创造的 Agent 预设上传后在此审核;通过后全员可见可安装"
        actions={
          <Button variant="outline" size="sm" onClick={() => { void load(tab) }}>
            <RefreshCw className="h-4 w-4" /> 刷新
          </Button>
        }
      />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="all">全部（{counts.all}）</TabsTrigger>
          <TabsTrigger value="pending">待审核（{counts.pending}）</TabsTrigger>
          <TabsTrigger value="approved">已通过（{counts.approved}）</TabsTrigger>
          <TabsTrigger value="rejected">已拒绝（{counts.rejected}）</TabsTrigger>
        </TabsList>
      </Tabs>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {loading ? (
        <EmptyState icon={<Share2 className="h-6 w-6" />} title="加载中…" desc="请稍候" />
      ) : rows.length === 0 ? (
        <EmptyState icon={<Share2 className="h-6 w-6" />} title="暂无共享 Agent" desc="员工上传后将出现在这里" />
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>名称 / 标题</TableHead>
                <TableHead>作者</TableHead>
                <TableHead>版本</TableHead>
                <TableHead>描述</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>下载</TableHead>
                <TableHead>上传时间</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(row => {
                const meta = STATUS_META[row.status]
                const isBusy = busy === row.name + '@' + row.version + 'approve' || busy === row.name + '@' + row.version + 'reject' || busy === row.name + '@' + row.version + 'delete'
                return (
                  <TableRow key={row.name + '@' + row.version}>
                    <TableCell>
                      <div className="whitespace-nowrap font-medium">{row.display_name || row.name}</div>
                      <div className="text-xs text-muted-foreground">{row.name}</div>
                    </TableCell>
                    <TableCell>{row.author}</TableCell>
                    <TableCell>{row.version}</TableCell>
                    <TableCell className="max-w-xs truncate">{row.description || '—'}</TableCell>
                    <TableCell><Badge variant={meta.variant}>{meta.label}</Badge></TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{row.downloads ?? 0}</TableCell>
                    <TableCell className="text-muted-foreground">{fmtTime(row.created_at)}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost" size="sm"
                          onClick={() => { void openPreview(row.name, row.version) }}
                          title="查看内容预览"
                        >
                          <FileText className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost" size="sm"
                          asChild={false}
                          onClick={() => { window.open(`/api/server/admin/agent-presets/${encodeURIComponent(row.name)}/${encodeURIComponent(row.version)}/archive`, '_blank') }}
                          title="下载归档核查"
                        >
                          <Download className="h-4 w-4" />
                        </Button>
                        {row.status === 'approved' && (
                          <Button size="sm" variant="outline" disabled={isBusy} onClick={() => { setGrantName(row.name) }} title="授权(通过后需授权才可见可装)">
                            <ShieldCheck className="h-4 w-4" />
                          </Button>
                        )}
                        {row.status !== 'approved' && (
                          <Button size="sm" disabled={isBusy} onClick={() => { setConfirm({ name: row.name, version: row.version, kind: 'approve' }) }}>
                            通过
                          </Button>
                        )}
                        {row.status !== 'rejected' && (
                          <Button size="sm" variant="outline" disabled={isBusy} onClick={() => { setReason(''); setConfirm({ name: row.name, version: row.version, kind: 'reject' }) }}>
                            拒绝
                          </Button>
                        )}
                        <Button size="sm" variant="destructive" disabled={isBusy} onClick={() => { setConfirm({ name: row.name, version: row.version, kind: 'delete' }) }}>
                          删除
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {/* 审核预览:composition + 文件清单 */}
      <Dialog open={previewName !== ''} onOpenChange={(open) => { if (!open) setPreviewName('') }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>内容预览: {previewName}</DialogTitle>
            <DialogDescription>顶层 agent.cordis.yml 与归档文件清单(用于决策审核)</DialogDescription>
          </DialogHeader>
          {preview === null ? (
            <p className="text-sm text-muted-foreground">加载中…</p>
          ) : (
            <div className="space-y-3">
              <div>
                <h4 className="mb-1 text-sm font-medium">agent.cordis.yml</h4>
                <pre className="max-h-64 overflow-auto rounded-md bg-muted p-3 text-xs">{preview.composition || '—'}</pre>
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

      <Dialog open={confirm !== null} onOpenChange={(open) => { if (!open) { setConfirm(null); setReason('') } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirm?.kind === 'approve' && '确定通过该共享 Agent 吗？'}
              {confirm?.kind === 'reject' && '确定拒绝该共享 Agent 吗？'}
              {confirm?.kind === 'delete' && '确定删除该共享 Agent 吗？'}
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {confirm?.kind === 'approve' && `通过后「${confirm.name}@${confirm.version}」将全员可见可安装。`}
            {confirm?.kind === 'reject' && `拒绝后「${confirm.name}@${confirm.version}」仅上传者本人可见并可重新上传。请填写拒绝理由,上传者将可见该理由。`}
            {confirm?.kind === 'delete' && `删除后「${confirm.name}@${confirm.version}」记录与归档将被移除,不可恢复。`}
          </p>
          {confirm?.kind === 'reject' && (
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
                variant={confirm.kind === 'delete' || confirm.kind === 'reject' ? 'destructive' : 'default'}
                disabled={busy !== '' || (confirm.kind === 'reject' && reason.trim() === '')}
                onClick={() => { void act(confirm.name, confirm.version, confirm.kind) }}
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
        basePath={`/api/server/admin/agent-presets/${encodeURIComponent(grantName)}`}
        departments={departments}
        onClose={() => { setGrantName('') }}
        onSaved={() => { void load(tab) }}
      />
    </div>
  )
}
