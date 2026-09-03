import { useCallback, useEffect, useState } from 'react'
import { request, ADMIN_API } from '../api'
import { Button } from './ui/button'
import { Badge } from './ui/badge'
import { Input } from './ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { Lock } from 'lucide-react'

interface LockRow {
  kind: 'skill' | 'agent'
  name: string
  reason?: string
  locked_by?: string
}

/**
 * 锁定管理(2026-09-04 从审批页迁入市场页): 锁定的名称只能由管理员发布,
 * 员工上传会被拒绝并看到下方理由;可对尚不存在的名称预先锁定以保护官方命名。
 * 技能市场页与智能体市场页共用(弹窗内可切换锁定类型)。
 */
export function CapabilityLockPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
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
  useEffect(() => { if (open) void load() }, [open, load])

  const add = async () => {
    if (!name.trim() || busy) return
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
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Lock className="h-4 w-4" /> 锁定管理</DialogTitle>
          <DialogDescription>
            锁定的名称只能由管理员发布,员工上传会被拒绝并看到理由;可对尚不存在的名称预先锁定以保护官方命名
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
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
        </div>
      </DialogContent>
    </Dialog>
  )
}
