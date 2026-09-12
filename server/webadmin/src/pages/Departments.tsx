import { useCallback, useEffect, useRef, useState } from 'react'
import { request, ADMIN_API } from '../api'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Badge } from '../components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../components/ui/dialog'
import { Card } from '../components/ui/card'
import { PageHeader } from '../components/page-header'
import { EmptyState } from '../components/empty-state'
import { UserSearchSelect } from '../components/user-search-select'
import { Network } from 'lucide-react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select'
import { deptSubtreeIds, deptTreeOptions } from '../lib/utils'

interface Department {
  id: number
  name: string
  parent_id: number
  leader_id: number
  leader_name: string
  description: string
  member_count: number
  child_count: number
  granted_count: number
  monthly_cost?: number // 0024:部门树当月费用(元)
}

export default function Departments() {
  const [depts, setDepts] = useState<Department[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false) // L10:提交/删除双击守卫
  const [deptDialog, setDeptDialog] = useState(false)
  const [deptForm, setDeptForm] = useState({ id: 0, name: '', parent_id: '0', leader_id: '0', description: '' })
  // 对话框内联错误(UX 改进):保存失败信息显示在对话框内,而非页面顶部
  const [deptErr, setDeptErr] = useState('')
  // P1-8: 请求序号防乱序——保存/删除后重拉与手动刷新竞态时只认最新响应
  const loadSeq = useRef(0)

  const load = useCallback(async () => {
    const current = ++loadSeq.current
    try {
      const d = await request(`${ADMIN_API}/departments`)
      if (current !== loadSeq.current) return // P1-8: 过期响应丢弃
      setDepts(d.departments ?? [])
      setError('') // 成功后清空错误(中3 同口径)
    } catch (err: any) {
      if (current !== loadSeq.current) return // P1-8: 过期响应不写错误
      setError(err.message)
    }
  }, [])

  useEffect(() => { load() }, [load])

  function openDeptEdit(d?: Department) {
    setDeptErr('')
    setDeptForm({
      id: d?.id ?? 0,
      name: d?.name ?? '',
      parent_id: String(d?.parent_id ?? 0),
      leader_id: String(d?.leader_id ?? 0),
      description: d?.description ?? '',
    })
    setDeptDialog(true)
  }

  async function saveDeptForm() {
    if (busy) return // L10:双击守卫
    setDeptErr('')
    if (!deptForm.name.trim()) { setDeptErr('请填写部门名称'); return }
    const payload: Record<string, any> = {
      name: deptForm.name,
      parent_id: Number(deptForm.parent_id),
      leader_id: Number(deptForm.leader_id),
      description: deptForm.description,
    }
    const body = JSON.stringify(payload)
    setBusy(true)
    try {
      if (deptForm.id > 0) {
        await request(`${ADMIN_API}/departments/${deptForm.id}`, { method: 'PUT', body })
      } else {
        await request(`${ADMIN_API}/departments`, { method: 'POST', body })
      }
      setDeptDialog(false)
      load()
    } catch (err: any) {
      setDeptErr(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function removeDept(d: Department) {
    if (busy) return // L10:双击守卫
    if (!window.confirm(`确定删除部门「${d.name}」?有关联(成员/子部门/授权)时将被拒绝。`)) return
    setBusy(true)
    try {
      await request(`${ADMIN_API}/departments/${d.id}`, { method: 'DELETE' })
      load()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="部门管理"
        desc="金字塔架构:部门树(可嵌套)→ 部门主管 → 员工;授权给部门覆盖其子部门,主管自动继承部门及下级授权;「全员」为内置保留部门。员工可花的钱统一由「用量中心 → 余额」管理"
        actions={<Button onClick={() => openDeptEdit()}>新建部门</Button>}
      />
      {error && <div className="text-sm text-destructive">{error}</div>}
      <Card>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>部门</TableHead>
            <TableHead>上级部门</TableHead>
            <TableHead>部门主管</TableHead>
            <TableHead>成员</TableHead>
            <TableHead>子部门</TableHead>
            <TableHead className="text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {depts.map((d) => {
            const parent = depts.find((x) => x.id === d.parent_id)
            return (
              <TableRow key={d.id}>
                <TableCell>
                  <div className="flex items-center gap-2">
                    {d.parent_id !== 0 && <span className="self-center text-xs leading-none text-slate-300">└</span>}
                    <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded ${d.parent_id === 0 ? 'bg-blue-600/10 text-[#1E40AF]' : 'bg-slate-100 text-slate-400'}`}>
                      <Network className="h-3 w-3" />
                    </span>
                    <span className="font-medium">{d.name}</span>
                    {d.granted_count > 0 && <Badge variant="outline">已授权</Badge>}
                  </div>
                  {d.description && <div className="pl-7 text-xs text-muted-foreground">{d.description}</div>}
                </TableCell>
                <TableCell>{parent?.name ?? '—'}</TableCell>
                <TableCell>{d.leader_name || '—'}</TableCell>
                <TableCell className="font-mono text-xs">{d.member_count}</TableCell>
                <TableCell className="font-mono text-xs">{d.child_count}</TableCell>
                <TableCell className="text-right space-x-2">
                  <Button size="sm" variant="outline" onClick={() => openDeptEdit(d)}>编辑</Button>
                  <Button size="sm" variant="destructive" disabled={busy} onClick={() => removeDept(d)}>删除</Button>
                </TableCell>
              </TableRow>
            )
          })}
          {depts.length === 0 && (
            <TableRow>
              <TableCell colSpan={7} className="border-0 p-0">
                <EmptyState
                  icon={<Network className="h-5 w-5 text-muted-foreground" />}
                  title="暂无部门"
                  desc="点击「新建部门」开始搭建组织架构"
                />
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      </Card>

      <Dialog open={deptDialog} onOpenChange={(v) => { setDeptDialog(v); if (!v) setDeptErr('') }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{deptForm.id > 0 ? '编辑部门' : '新建部门'}</DialogTitle>
            <DialogDescription>上级部门为空 = 顶层部门;主管可为空,后续补任</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {deptErr && <div className="text-sm text-destructive">{deptErr}</div>}
            <div className="space-y-1">
              <Label htmlFor="dept-name">部门名称</Label>
              <Input id="dept-name" placeholder="如 研发部" value={deptForm.name} onChange={(e) => setDeptForm({ ...deptForm, name: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="dept-parent">上级部门</Label>
              <Select value={deptForm.parent_id} onValueChange={(v) => setDeptForm({ ...deptForm, parent_id: v })}>
                <SelectTrigger aria-label="上级部门" id="dept-parent"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">无(顶层部门)</SelectItem>
                  {deptTreeOptions(
                    // 高1:新建时(id=0)父级候选是整棵部门树;编辑时排除自身及其子树防环
                    depts.filter((d) => deptForm.id <= 0 || !deptSubtreeIds(depts, deptForm.id).has(d.id)),
                    0,
                    0,
                  ).map((o) => (
                    <SelectItem key={o.id} value={String(o.id)}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="dept-leader">部门主管</Label>
              <UserSearchSelect
                ariaLabel="部门主管"
                value={deptForm.leader_id}
                onValueChange={(v) => setDeptForm({ ...deptForm, leader_id: v })}
                placeholder="搜索并选择主管"
                allowEmpty
                emptyLabel="未设置"
              />
              {/* G10: 主管从全量用户搜索选择(服务端 q= 搜索, 不再受前 200 截断) */}
            </div>
            <div className="space-y-1">
              <Label htmlFor="dept-desc">描述(可选)</Label>
              <Input id="dept-desc" value={deptForm.description} onChange={(e) => setDeptForm({ ...deptForm, description: e.target.value })} />
            </div>
            <Button className="w-full" disabled={!deptForm.name.trim() || busy} onClick={saveDeptForm}>{busy ? '处理中…' : '保存'}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
