import { useCallback, useEffect, useRef, useState } from 'react'
import { request } from '../api'
import { Button } from '../components/ui/button'
import { Badge } from '../components/ui/badge'
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table'
import { PageHeader } from '../components/page-header'
import { EmptyState } from '../components/empty-state'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/dialog'
import { Download, RefreshCw, Share2 } from 'lucide-react'

interface PresetRow {
  name: string
  display_name: string
  description: string
  version: string
  author: string
  status: 'pending' | 'approved' | 'rejected'
  created_at: string
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
  const [rows, setRows] = useState<PresetRow[]>([])
  const [tab, setTab] = useState('all')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  // 二次确认(通过/拒绝/删除共用行内确认)
  const [confirm, setConfirm] = useState<{ name: string; kind: 'approve' | 'reject' | 'delete' } | null>(null)
  const [busy, setBusy] = useState('')
  const loadSeq = useRef(0)

  const load = useCallback(async (status: string) => {
    const current = ++loadSeq.current
    setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams()
      if (status && status !== 'all') params.set('status', status)
      const data = await request(`/api/admin/agent-presets?${params.toString()}`)
      if (current !== loadSeq.current) return
      setRows(data.presets ?? [])
    } catch (err: any) {
      if (current !== loadSeq.current) return
      setError(err.message)
    } finally {
      if (current === loadSeq.current) setLoading(false)
    }
  }, [])

  useEffect(() => { load(tab) }, [load, tab])

  const act = async (name: string, kind: 'approve' | 'reject' | 'delete') => {
    if (busy) return
    setBusy(name + kind)
    setError('')
    try {
      if (kind === 'delete') {
        await request(`/api/admin/agent-presets/${encodeURIComponent(name)}`, { method: 'DELETE' })
      } else {
        await request(`/api/admin/agent-presets/${encodeURIComponent(name)}/${kind}`, { method: 'POST' })
      }
      setConfirm(null)
      await load(tab)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusy('')
    }
  }

  const counts = {
    all: rows.length,
    pending: rows.filter(r => r.status === 'pending').length,
    approved: rows.filter(r => r.status === 'approved').length,
    rejected: rows.filter(r => r.status === 'rejected').length,
  }

  const filtered = tab === 'all' ? rows : rows.filter(r => r.status === tab)

  return (
    <div className="space-y-4">
      <PageHeader
        title="共享 Agent"
        desc="员工创造的 Agent 预设上传后在此审核;通过后全员可见可安装"
        actions={
          <Button variant="outline" size="sm" onClick={() => { load(tab) }}>
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
      ) : filtered.length === 0 ? (
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
                <TableHead>上传时间</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map(row => {
                const meta = STATUS_META[row.status]
                const isBusy = busy === row.name + 'approve' || busy === row.name + 'reject' || busy === row.name + 'delete'
                return (
                  <TableRow key={row.name}>
                    <TableCell>
                      <div className="font-medium">{row.display_name || row.name}</div>
                      <div className="text-xs text-muted-foreground">{row.name}</div>
                    </TableCell>
                    <TableCell>{row.author}</TableCell>
                    <TableCell>{row.version}</TableCell>
                    <TableCell className="max-w-xs truncate">{row.description || '—'}</TableCell>
                    <TableCell><Badge variant={meta.variant}>{meta.label}</Badge></TableCell>
                    <TableCell className="text-muted-foreground">{fmtTime(row.created_at)}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost" size="sm"
                          asChild={false}
                          onClick={() => { window.open(`/api/admin/agent-presets/${encodeURIComponent(row.name)}/archive`, '_blank') }}
                          title="下载归档核查"
                        >
                          <Download className="h-4 w-4" />
                        </Button>
                        {row.status !== 'approved' && (
                          <Button size="sm" disabled={isBusy} onClick={() => { setConfirm({ name: row.name, kind: 'approve' }) }}>
                            通过
                          </Button>
                        )}
                        {row.status !== 'rejected' && (
                          <Button size="sm" variant="outline" disabled={isBusy} onClick={() => { setConfirm({ name: row.name, kind: 'reject' }) }}>
                            拒绝
                          </Button>
                        )}
                        <Button size="sm" variant="destructive" disabled={isBusy} onClick={() => { setConfirm({ name: row.name, kind: 'delete' }) }}>
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

      <Dialog open={confirm !== null} onOpenChange={(open) => { if (!open) setConfirm(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirm?.kind === 'approve' && '确定通过该共享 Agent 吗？'}
              {confirm?.kind === 'reject' && '确定拒绝该共享 Agent 吗？'}
              {confirm?.kind === 'delete' && '确定删除该共享 Agent 吗？'}
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {confirm?.kind === 'approve' && `通过后「${confirm.name}」将全员可见可安装。`}
            {confirm?.kind === 'reject' && `拒绝后「${confirm.name}」仅上传者本人可见并可重新上传。`}
            {confirm?.kind === 'delete' && `删除后「${confirm.name}」记录与归档将被移除,不可恢复。`}
          </p>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => { setConfirm(null) }}>取消</Button>
            {confirm && (
              <Button
                variant={confirm.kind === 'delete' || confirm.kind === 'reject' ? 'destructive' : 'default'}
                disabled={busy !== ''}
                onClick={() => { void act(confirm.name, confirm.kind) }}
              >
                {busy ? '处理中…' : '确认'}
              </Button>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
