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
import { Download, FileText, RefreshCw, Sparkles, ShieldCheck } from 'lucide-react'
import { GrantDialog } from '../components/grant-dialog'

interface SkillRow {
  name: string
  display_name: string
  version: string
  description: string
  author: string
  status: 'pending' | 'approved' | 'rejected'
  reason: string
  created_at: string
}

interface Dept {
  id: number
  parent_id: number
  name: string
}

interface PreviewData {
  files: string[]
  skill_md: string
}

const STATUS_META: Record<SkillRow['status'], { label: string; variant: 'secondary' | 'success' | 'destructive' }> = {
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

export default function SharedSkills() {
  const [allRows, setAllRows] = useState<SkillRow[]>([])
  const [rows, setRows] = useState<SkillRow[]>([])
  const [tab, setTab] = useState('all')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [confirm, setConfirm] = useState<{ name: string; version: string; kind: 'approve' | 'reject' | 'delete' } | null>(null)
  const [reason, setReason] = useState('')
  const [preview, setPreview] = useState<PreviewData | null>(null)
  const [previewKey, setPreviewKey] = useState('')
  const [busy, setBusy] = useState('')
  const [grantName, setGrantName] = useState('')
  const [departments, setDepartments] = useState<Dept[]>([])

  useEffect(() => {
    request('/api/admin/departments')
      .then((data) => { setDepartments(data.departments ?? []) })
      .catch(() => { /* 单用户授权仍可用 */ })
  }, [])
  const loadSeq = useRef(0)

  const load = useCallback(async (status: string) => {
    const current = ++loadSeq.current
    setLoading(true)
    setError('')
    try {
      const data = await request<{ skills: SkillRow[] }>('/api/admin/shared-skills')
      if (current !== loadSeq.current) return
      setAllRows(data.skills ?? [])
      setRows(status === 'all' ? (data.skills ?? []) : (data.skills ?? []).filter(r => r.status === status))
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
    setBusy(name + version + kind)
    setError('')
    try {
      const base = `/api/admin/shared-skills/${encodeURIComponent(name)}/${encodeURIComponent(version)}`
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
      await load(tab)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusy('')
    }
  }

  const openPreview = async (name: string, version: string) => {
    setPreviewKey(name + '@' + version)
    setPreview(null)
    setError('')
    try {
      const data = await request<PreviewData>(
        `/api/admin/shared-skills/${encodeURIComponent(name)}/${encodeURIComponent(version)}/preview`)
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
        title="共享技能"
        desc="员工本地技能上传后在此审核;通过版本全员可见可安装"
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
        <EmptyState icon={<Sparkles className="h-6 w-6" />} title="加载中…" desc="请稍候" />
      ) : rows.length === 0 ? (
        <EmptyState icon={<Sparkles className="h-6 w-6" />} title="暂无共享技能" desc="员工上传后将出现在这里" />
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>名称 / 标题</TableHead>
                <TableHead>版本</TableHead>
                <TableHead>作者</TableHead>
                <TableHead>描述</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>上传时间</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(row => {
                const meta = STATUS_META[row.status]
                const isBusy = busy === row.name + row.version + 'approve'
                  || busy === row.name + row.version + 'reject'
                  || busy === row.name + row.version + 'delete'
                return (
                  <TableRow key={row.name + '@' + row.version}>
                    <TableCell>
                      <div className="whitespace-nowrap font-medium">{row.display_name || row.name}</div>
                      <div className="text-xs text-muted-foreground">{row.name}</div>
                    </TableCell>
                    <TableCell className="font-mono text-sm">{row.version}</TableCell>
                    <TableCell>{row.author}</TableCell>
                    <TableCell className="max-w-xs truncate">{row.description || '—'}</TableCell>
                    <TableCell><Badge variant={meta.variant}>{meta.label}</Badge></TableCell>
                    <TableCell className="text-muted-foreground">{fmtTime(row.created_at)}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => { void openPreview(row.name, row.version) }} title="查看内容预览">
                          <FileText className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="sm" asChild={false}
                          onClick={() => { window.open(`/api/admin/shared-skills/${encodeURIComponent(row.name)}/${encodeURIComponent(row.version)}/archive`, '_blank') }}
                          title="下载归档核查">
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

      {/* 审核预览 */}
      <Dialog open={previewKey !== ''} onOpenChange={(open) => { if (!open) setPreviewKey('') }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>内容预览: {previewKey}</DialogTitle>
            <DialogDescription>SKILL.md 与归档文件清单(用于决策审核)</DialogDescription>
          </DialogHeader>
          {preview === null ? (
            <p className="text-sm text-muted-foreground">加载中…</p>
          ) : (
            <div className="space-y-3">
              <div>
                <h4 className="mb-1 text-sm font-medium">SKILL.md</h4>
                <pre className="max-h-64 overflow-auto rounded-md bg-muted p-3 text-xs">{preview.skill_md || '—'}</pre>
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
              {confirm?.kind === 'approve' && `确定通过「${confirm?.name}@${confirm?.version}」吗？`}
              {confirm?.kind === 'reject' && `确定拒绝「${confirm?.name}@${confirm?.version}」吗？`}
              {confirm?.kind === 'delete' && `确定删除「${confirm?.name}@${confirm?.version}」吗？`}
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {confirm?.kind === 'approve' && '通过后该版本将全员可见可安装。'}
            {confirm?.kind === 'reject' && '拒绝后仅上传者可见并可重新上传。请填写理由,上传者可见。'}
            {confirm?.kind === 'delete' && '删除后记录与归档将被移除,不可恢复。'}
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
        basePath={`/api/admin/shared-skills/${encodeURIComponent(grantName)}`}
        departments={departments}
        onClose={() => { setGrantName('') }}
        onSaved={() => { void load(tab) }}
      />
    </div>
  )
}
