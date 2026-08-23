import { useCallback, useEffect, useRef, useState } from 'react'
import { request } from '../api'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Badge } from '../components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select'
import { deptSubtreeIds, deptTreeOptions } from '../lib/utils'
import { fmtMoney, fmtMoneyFull, moneyPercent, moneyOver } from '../lib/format'

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
  budget_money?: number | null // 0024:月度金额预算(元),nil = 未配置
  monthly_cost?: number // 0024:部门树当月费用(元)
}

interface UserOption {
  id: number
  username: string
}

export default function Departments() {
  const [depts, setDepts] = useState<Department[]>([])
  const [users, setUsers] = useState<UserOption[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false) // L10:提交/删除双击守卫
  const [deptDialog, setDeptDialog] = useState(false)
  const [deptForm, setDeptForm] = useState({ id: 0, name: '', parent_id: '0', leader_id: '0', description: '', budget_money: '' })
  // 对话框内联错误(UX 改进):保存失败信息显示在对话框内,而非页面顶部
  const [deptErr, setDeptErr] = useState('')
  // P1-8: 请求序号防乱序——保存/删除后重拉与手动刷新竞态时只认最新响应
  const loadSeq = useRef(0)

  const load = useCallback(async () => {
    const current = ++loadSeq.current
    try {
      const [d, u] = await Promise.all([
        request('/api/admin/departments'),
        request('/api/admin/users?size=200'),
      ])
      if (current !== loadSeq.current) return // P1-8: 过期响应丢弃
      setDepts(d.departments ?? [])
      setUsers(u.users ?? [])
      setError('') // 成功后清空错误(中3 同口径)
    } catch (err: any) {
      if (current !== loadSeq.current) return // P1-8: 过期响应不写错误
      setError(err.message)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // 中6:沿祖先链找第一个配置了预算的部门(继承预算语义:
  // 部门预算约束其全部子部门成员,子部门自身无预算 ≠ 不限)。
  function inheritedBudget(d: Department): { name: string; budget: number } | undefined {
    let pid = d.parent_id
    let guard = 0
    while (pid !== 0 && guard < 100) {
      guard++
      const p = depts.find((x) => x.id === pid)
      if (!p) return undefined
      if (p.budget_money !== null && p.budget_money !== undefined && p.budget_money > 0) {
        return { name: p.name, budget: p.budget_money }
      }
      pid = p.parent_id
    }
    return undefined
  }

  function openDeptEdit(d?: Department) {
    setDeptErr('')
    setDeptForm({
      id: d?.id ?? 0,
      name: d?.name ?? '',
      parent_id: String(d?.parent_id ?? 0),
      leader_id: String(d?.leader_id ?? 0),
      description: d?.description ?? '',
      budget_money: d?.budget_money === null || d?.budget_money === undefined ? '' : String(d.budget_money),
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
    // 预算:留空 = 不变;0 = 清除(不限);>0 = 月度金额预算
    if (deptForm.budget_money.trim() !== '') payload.budget_money = Number(deptForm.budget_money)
    const body = JSON.stringify(payload)
    setBusy(true)
    try {
      if (deptForm.id > 0) {
        await request(`/api/admin/departments/${deptForm.id}`, { method: 'PUT', body })
      } else {
        await request('/api/admin/departments', { method: 'POST', body })
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
      await request(`/api/admin/departments/${d.id}`, { method: 'DELETE' })
      load()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="page-title">部门管理</h1>
        <Button onClick={() => openDeptEdit()}>新建部门</Button>
      </div>
      {error && <div className="text-sm text-destructive">{error}</div>}
      <p className="text-sm text-muted-foreground">
        金字塔架构:部门树(可嵌套)→ 部门主管 → 员工;授权给部门覆盖其子部门,主管自动继承部门及下级授权;「全员」为内置保留部门
      </p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>部门</TableHead>
            <TableHead>上级部门</TableHead>
            <TableHead>部门主管</TableHead>
            <TableHead>成员</TableHead>
            <TableHead>子部门</TableHead>
            <TableHead>月度金额预算</TableHead>
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
                    {d.parent_id !== 0 && <span className="text-muted-foreground">↳</span>}
                    {d.name}
                    {d.granted_count > 0 && <Badge variant="outline">已授权</Badge>}
                  </div>
                  {d.description && <div className="text-xs text-muted-foreground">{d.description}</div>}
                </TableCell>
                <TableCell>{parent?.name ?? '—'}</TableCell>
                <TableCell>{d.leader_name || '—'}</TableCell>
                <TableCell>{d.member_count}</TableCell>
                <TableCell>{d.child_count}</TableCell>
                <TableCell>
                  {d.budget_money === null || d.budget_money === undefined || d.budget_money <= 0 ? (
                    // 中6:本部门无预算 ≠ 不限——祖先部门预算仍约束其成员
                    (() => {
                      const ib = inheritedBudget(d)
                      return ib ? (
                        <span className="text-xs text-muted-foreground" title={`受 ${ib.name} 部门预算约束`}>继承上级({ib.name} ¥{fmtMoney(ib.budget)})</span>
                      ) : (
                        <span className="text-xs text-muted-foreground">不限</span>
                      )
                    })()
                  ) : (
                    <div className="space-y-0.5">
                      <div className="text-xs">
                        <span className="font-medium tabular-nums">¥{fmtMoney(d.monthly_cost ?? 0)}</span>
                        <span className="text-muted-foreground"> / ¥{fmtMoney(d.budget_money)}</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <div className="h-1.5 w-20 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={moneyPercent(d.monthly_cost ?? 0, d.budget_money) ?? 0} aria-valuemin={0} aria-valuemax={100} aria-label={`${d.name} 预算占用`}>
                          <div
                            className={`h-full rounded-full ${moneyOver(d.monthly_cost ?? 0, d.budget_money) ? 'bg-destructive' : moneyPercent(d.monthly_cost ?? 0, d.budget_money)! >= 80 ? 'bg-amber-500' : 'bg-primary'}`}
                            style={{ width: `${Math.min(100, moneyPercent(d.monthly_cost ?? 0, d.budget_money) ?? 0)}%` }}
                          />
                        </div>
                        <span
                          className={`text-[10px] tabular-nums ${moneyOver(d.monthly_cost ?? 0, d.budget_money) ? 'text-destructive' : ''}`}
                          title={fmtMoneyFull(d.monthly_cost ?? 0)}
                        >
                          {moneyPercent(d.monthly_cost ?? 0, d.budget_money)}%
                        </span>
                      </div>
                    </div>
                  )}
                </TableCell>
                <TableCell className="text-right space-x-2">
                  <Button size="sm" variant="outline" onClick={() => openDeptEdit(d)}>编辑</Button>
                  <Button size="sm" variant="destructive" disabled={busy} onClick={() => removeDept(d)}>删除</Button>
                </TableCell>
              </TableRow>
            )
          })}
          {depts.length === 0 && (
            <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground">暂无部门,点击「新建部门」开始搭建组织架构</TableCell></TableRow>
          )}
        </TableBody>
      </Table>

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
              <Label>上级部门</Label>
              <Select value={deptForm.parent_id} onValueChange={(v) => setDeptForm({ ...deptForm, parent_id: v })}>
                <SelectTrigger aria-label="上级部门"><SelectValue /></SelectTrigger>
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
              <Select value={deptForm.leader_id} onValueChange={(v) => setDeptForm({ ...deptForm, leader_id: v })}>
                <SelectTrigger aria-label="部门主管" id="dept-leader"><SelectValue placeholder="选择主管" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">未设置</SelectItem>
                  {users.map((u) => (
                    <SelectItem key={u.id} value={String(u.id)}>{u.username}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {/* L15:主管候选截断提示(接口 size 上限 200) */}
              {users.length >= 200 && (
                <p className="text-xs text-muted-foreground">用户较多,仅展示前 200 名,超出部分无法在此选择主管</p>
              )}
            </div>
            <div className="space-y-1">
              <Label htmlFor="dept-desc">描述(可选)</Label>
              <Input id="dept-desc" value={deptForm.description} onChange={(e) => setDeptForm({ ...deptForm, description: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="dept-budget">月度金额预算(元,可选)</Label>
              <Input
                id="dept-budget"
                type="number"
                min={0}
                step="0.01"
                placeholder="留空 = 不变;0 = 不限;>0 = 部门树月度费用上限"
                value={deptForm.budget_money}
                onChange={(e) => setDeptForm({ ...deptForm, budget_money: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">
                预算约束该部门及全部子部门成员:树内当月累计费用超限即拦截(与员工个人金额配额叠加生效)。
                子部门成员同时受其上级部门预算约束。
              </p>
            </div>
            <Button className="w-full" disabled={!deptForm.name.trim() || busy} onClick={saveDeptForm}>{busy ? '处理中…' : '保存'}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
