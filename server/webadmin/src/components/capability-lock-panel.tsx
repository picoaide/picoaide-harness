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
  // 写面闸门（第十二轮规则 1「成功才解锁」，审计 R13-F F-13）：`locksLoaded` 只在
  // **成功**分支置 true。读失败时清单必须回到「未知」，不能留成「上一份」——
  // 否则用户会把服务端早已解除（或本次根本没读到）的锁定当成当前清单，
  // 点「解除」真的会发出 `DELETE …/capability-locks/skill/<旧行>`。
  const [locksLoaded, setLocksLoaded] = useState(false)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [kind, setKind] = useState<'skill' | 'agent'>('skill')
  const [name, setName] = useState('')
  const [reason, setReason] = useState('')

  // 渲染期归零（第十二轮规则 2，同族收口）：`useEffect` 在绘制**之后**才跑，会留下
  // 一帧「上一次打开的锁定行 + 可点的解除」。这里在 `open` false→true 的当帧同步清空
  // （React 认可的「props 变化时调整 state」写法：条件成立才 setState，不会死循环）。
  const [stateOpen, setStateOpen] = useState(open)
  if (stateOpen !== open) {
    setStateOpen(open)
    if (open) {
      setLocks([])
      setLocksLoaded(false)
      setErr('')
    }
  }

  const load = useCallback(async () => {
    try {
      const data = await request<{ locks: LockRow[] }>(`${ADMIN_API}/capability-locks`)
      setLocks(data.locks ?? [])
      setErr('')
      setLocksLoaded(true)
    } catch (e) {
      setErr((e as Error).message)
      // 失败分支：清空 + 降闸门（两个动作一起做，缺一条就会留下可点的旧行）。
      setLocks([])
      setLocksLoaded(false)
    }
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
    // 闸门（与列表渲染同一个 `locksLoaded`）：清单没读到就不允许按「当前清单」处置。
    if (!locksLoaded || busy) return
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
          {!locksLoaded && (
            // 「未知」不能装成「空」：读失败/在途时说「暂无锁定名称」等于替服务端下结论，
            // 与 R3「写面闸门一律成功才解锁」同一条口径。
            <p className="text-sm text-muted-foreground">
              {err === '' ? '正在读取锁定清单…' : '锁定清单未加载成功：下方不显示任何行，请关闭后重试。'}
            </p>
          )}
          {locksLoaded && (locks.length === 0
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
                        <Button size="sm" variant="ghost" disabled={busy || !locksLoaded} onClick={() => { void remove(l) }}>解除</Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
