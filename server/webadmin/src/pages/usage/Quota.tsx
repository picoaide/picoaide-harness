import { useCallback, useEffect, useState } from 'react'
import { request, ADMIN_API } from '../../api'
import { Button } from '../../components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card'
import { Badge } from '../../components/ui/badge'
import { Skeleton } from '../../components/ui/skeleton'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { PageHeader } from '../../components/page-header'
import { fmtY, type UserInfo, type DeptInfo } from './common'
import { fmtTokens, moneyPercent, moneyOver } from '../../lib/format'
import { cn } from '../../lib/utils'

// 配额与预算(管理页):三层配额(全局默认/用户/部门预算)集中配置。
// 三层语义:员工有效配额 = 用户覆盖 → 全局默认;0 = 不限;null = 跟随默认。
type AdjustMode = 'override' | 'add' | 'subtract'

interface AdjustState {
  user: UserInfo
  tokenMode: AdjustMode
  moneyMode: AdjustMode
  tokenVal: string
  moneyVal: string
}

function preview(current: number | null | undefined, mode: AdjustMode, val: string): number | null {
  const v = Number(val)
  if (!isFinite(v) || val === '') return null
  const base = current ?? 0
  if (mode === 'override') return v
  if (mode === 'add') return Math.round((base + v) * 100) / 100
  return Math.round((base - v) * 100) / 100
}

export default function UsageQuota() {
  const [users, setUsers] = useState<UserInfo[]>([])
  const [total, setTotal] = useState(0)
  const [depts, setDepts] = useState<DeptInfo[]>([])
  const [defToken, setDefToken] = useState('')
  const [defMoney, setDefMoney] = useState('')
  const [q, setQ] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [adjust, setAdjust] = useState<AdjustState | null>(null)
  const [budgetDept, setBudgetDept] = useState<DeptInfo | null>(null)
  const [budgetVal, setBudgetVal] = useState('')

  const load = useCallback(async (query: string) => {
    setLoading(true)
    setError('')
    try {
      const [ul, dl, gw] = await Promise.all([
        request<{ users: UserInfo[]; total: number }>(`${ADMIN_API}/users?size=200${query ? `&q=${encodeURIComponent(query)}` : ''}`),
        request<{ departments: DeptInfo[] }>(`${ADMIN_API}/departments`),
        request<any>(`${ADMIN_API}/gateway`),
      ])
      setUsers((ul.users ?? []).filter((u) => u.role !== 'super_admin'))
      setTotal(ul.total ?? 0)
      setDepts(dl.departments ?? [])
      setDefToken(gw?.monthly_quota === undefined || gw?.monthly_quota === null || gw?.monthly_quota === '' ? '' : String(gw.monthly_quota))
      setDefMoney(gw?.monthly_quota_money === undefined || gw?.monthly_quota_money === null || gw?.monthly_quota_money === '' ? '' : String(gw.monthly_quota_money))
    } catch (e: any) {
      setError(e.message || '查询失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load(q) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const saveDefault = async () => {
    setSaving(true)
    setError('')
    try {
      await request(`${ADMIN_API}/gateway`, {
        method: 'PUT',
        body: JSON.stringify({
          monthly_quota: defToken, // 字符串;空串 = 不限(清空)
          monthly_quota_money: defMoney,
        }),
      })
      setSaving(false)
    } catch (e: any) {
      setError(e.message || '保存失败')
      setSaving(false)
    }
  }

  const saveAdjust = async () => {
    if (!adjust) return
    setSaving(true)
    setError('')
    try {
      const body: Record<string, unknown> = {}
      const tokenResult = preview(adjust.user.quota_tokens, adjust.tokenMode, adjust.tokenVal)
      const moneyResult = preview(adjust.user.quota_money, adjust.moneyMode, adjust.moneyVal)
      if (adjust.tokenMode === 'override') {
        if (adjust.tokenVal !== '') body.quota_tokens = Math.max(0, tokenResult ?? 0)
        else body.quota_clear = true // 覆盖为空 → 恢复跟随默认
      } else if (tokenResult !== null) {
        body.quota_tokens = Math.max(0, tokenResult) // 加/减结果;<0 钳为 0(不限)
      }
      if (adjust.moneyMode === 'override') {
        if (adjust.moneyVal !== '') body.quota_money = Math.max(0, moneyResult ?? 0)
        else body.quota_money_clear = true
      } else if (moneyResult !== null) {
        body.quota_money = Math.max(0, moneyResult)
      }
      await request(`${ADMIN_API}/users/${adjust.user.id}`, { method: 'PUT', body: JSON.stringify(body) })
      setAdjust(null)
      await load(q)
      setSaving(false)
    } catch (e: any) {
      setError(e.message || '保存失败')
      setSaving(false)
    }
  }

  const saveBudget = async () => {
    if (!budgetDept) return
    setSaving(true)
    setError('')
    try {
      const payload: Record<string, unknown> = {
        name: budgetDept.name,
        parent_id: budgetDept.parent_id,
        budget_money: budgetVal === '' ? null : Number(budgetVal),
      }
      await request(`${ADMIN_API}/departments/${budgetDept.id}`, { method: 'PUT', body: JSON.stringify(payload) })
      setBudgetDept(null)
      setSaving(false)
      await load(q)
    } catch (e: any) {
      setError(e.message || '保存失败')
      setSaving(false)
    }
  }

  const effective = (u: UserInfo, kind: 'token' | 'money') => {
    const mine = kind === 'token' ? u.quota_tokens : u.quota_money
    if (mine !== null && mine !== undefined) return mine
    const d = kind === 'token' ? defToken : defMoney
    return d === '' ? null : Number(d)
  }

  return (
    <div className="space-y-6">
      <PageHeader title="配额与预算" desc="三层配额集中配置:全局默认 → 用户覆盖 → 部门预算(任一超限网关 429,自然月口径)" />
      {error && <div className="text-sm text-destructive">{error}</div>}

      {/* 全局默认配额(从网关设置迁入) */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="text-base">全局默认配额</CardTitle>
            <CardDescription>每位员工的默认月配额;用户未单独设置时生效。0 或留空 = 不限</CardDescription>
          </div>
          <Button size="sm" onClick={saveDefault} disabled={saving}>{saving ? '保存中…' : '保存'}</Button>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="quota-def-token">每用户默认月配额(token)</Label>
            <Input id="quota-def-token" type="number" min={0} value={defToken} onChange={(e) => setDefToken(e.target.value)} />
            <p className="text-xs text-muted-foreground">0 = 不限</p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="quota-def-money">每用户默认月金额配额(元)</Label>
            <Input id="quota-def-money" type="number" min={0} step="0.01" value={defMoney} onChange={(e) => setDefMoney(e.target.value)} />
            <p className="text-xs text-muted-foreground">0 = 不限;按模型定价折算费用统计</p>
          </div>
        </CardContent>
      </Card>

      {/* 用户配额表 */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">用户配额</CardTitle>
          <div className="flex items-center gap-2">
            <Input placeholder="搜索用户名" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void load(q) }} className="h-8 w-48" aria-label="搜索配额用户" />
            <Button size="sm" variant="outline" onClick={() => void load(q)}>查询</Button>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? <Skeleton className="h-72 w-full" /> : (
            <>
              <div className="mb-2 text-xs text-muted-foreground">共 {Math.max(0, total - 1)} 名员工{total > 200 ? '(展示前 200,搜索可缩小范围)' : ''} · 超额/临近按「金额 或 token」任一维度</div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>用户</TableHead>
                    <TableHead className="text-right">本月费用</TableHead>
                    <TableHead className="text-right">金额配额</TableHead>
                    <TableHead className="text-right">使用率</TableHead>
                    <TableHead className="text-right">token 配额</TableHead>
                    <TableHead className="w-24">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {users.map((u) => {
                    const mq = effective(u, 'money')
                    const pct = moneyPercent(u.monthly_cost, mq)
                    const over = moneyOver(u.monthly_cost, mq)
                    return (
                      <TableRow key={u.id}>
                        <TableCell className="font-medium">{u.display_name || u.username}{u.groups?.length ? <span className="ml-1 text-xs text-muted-foreground">({u.groups.filter((g) => g !== '全员').join(', ')})</span> : null}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtY(u.monthly_cost)}</TableCell>
                        <TableCell className="text-right tabular-nums">{mq ? fmtY(mq) : '不限'}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {pct === null ? '—' : (
                            <span className={cn(over && 'font-semibold text-destructive', !over && pct >= 90 && 'text-amber-600')}>{pct}%</span>
                          )}
                          {over && <Badge variant="destructive" className="ml-1.5">超额</Badge>}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{effective(u, 'token') ? fmtTokens(effective(u, 'token')!) : '不限'}</TableCell>
                        <TableCell>
                          <Button size="sm" variant="outline" onClick={() => {
                            setAdjust({ user: u, tokenMode: 'override', moneyMode: 'override', tokenVal: u.quota_tokens === null ? '' : String(u.quota_tokens), moneyVal: u.quota_money === null ? '' : String(u.quota_money) })
                          }}>调整</Button>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                  {users.length === 0 && <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground">暂无数据</TableCell></TableRow>}
                </TableBody>
              </Table>
            </>
          )}
        </CardContent>
      </Card>

      {/* 部门预算表 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">部门预算</CardTitle>
          <CardDescription>预算为部门树合计(含全部子部门成员);任一预算超限即拦截 429;0 或留空 = 不限</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? <Skeleton className="h-40 w-full" /> : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>部门</TableHead>
                  <TableHead className="text-right">本月已用</TableHead>
                  <TableHead className="text-right">预算</TableHead>
                  <TableHead className="text-right">使用率</TableHead>
                  <TableHead className="w-24">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {depts.filter((d) => d.name !== '全员').map((d) => {
                  const over = moneyOver(d.monthly_cost, d.budget_money)
                  const rate = moneyPercent(d.monthly_cost, d.budget_money)
                  return (
                    <TableRow key={d.id}>
                      <TableCell className="font-medium">{d.name}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtY(d.monthly_cost)}</TableCell>
                      <TableCell className="text-right tabular-nums">{d.budget_money ? fmtY(d.budget_money) : '不限'}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {rate === null ? '—' : (
                          <span className={cn(over && 'font-semibold text-destructive', !over && rate >= 90 && 'text-amber-600')}>{rate}%</span>
                        )}
                        {over && <Badge variant="destructive" className="ml-1.5">超预算</Badge>}
                      </TableCell>
                      <TableCell>
                        <Button size="sm" variant="outline" onClick={() => { setBudgetDept(d); setBudgetVal(d.budget_money === null ? '' : String(d.budget_money)) }}>设置</Button>
                      </TableCell>
                    </TableRow>
                  )
                })}
                {depts.filter((d) => d.name !== '全员').length === 0 && <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground">暂无部门</TableCell></TableRow>}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Adjust Quota 弹窗(new-api UserQuotaDialog 式:覆盖/增加/减少 + 实时预览) */}
      <Dialog open={!!adjust} onOpenChange={(o) => { if (!o) setAdjust(null) }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>调整配额 · {adjust?.user.username}</DialogTitle>
            <DialogDescription>当前:token {adjust?.user.quota_tokens === null ? '跟随默认' : fmtTokens(adjust?.user.quota_tokens ?? 0)} · 金额 {adjust?.user.quota_money === null ? '跟随默认' : fmtY(adjust?.user.quota_money)}(0 = 不限)</DialogDescription>
          </DialogHeader>
          {adjust && (
            <div className="space-y-4">
              <div className="space-y-3">
                <div className="grid grid-cols-2 items-center gap-2">
                  <Select value={adjust.tokenMode} onValueChange={(v) => setAdjust({ ...adjust, tokenMode: v as AdjustMode })}>
                    <SelectTrigger aria-label="token 调整方式"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="override">覆盖为</SelectItem>
                      <SelectItem value="add">增加</SelectItem>
                      <SelectItem value="subtract">减少</SelectItem>
                    </SelectContent>
                  </Select>
                  <Input type="number" min={0} placeholder="token 值(留空=跟随默认)" value={adjust.tokenVal} onChange={(e) => setAdjust({ ...adjust, tokenVal: e.target.value })} />
                </div>
                <div className="text-xs text-muted-foreground">
                  预览: {adjust.user.quota_tokens === null ? '跟随默认' : fmtTokens(adjust.user.quota_tokens)} → {adjust.tokenMode === 'override' && adjust.tokenVal === '' ? '跟随默认' : preview(adjust.user.quota_tokens, adjust.tokenMode, adjust.tokenVal) === null ? '—' : fmtTokens(preview(adjust.user.quota_tokens, adjust.tokenMode, adjust.tokenVal)!)}
                </div>
              </div>
              <div className="space-y-3">
                <div className="grid grid-cols-2 items-center gap-2">
                  <Select value={adjust.moneyMode} onValueChange={(v) => setAdjust({ ...adjust, moneyMode: v as AdjustMode })}>
                    <SelectTrigger aria-label="金额调整方式"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="override">覆盖为</SelectItem>
                      <SelectItem value="add">增加</SelectItem>
                      <SelectItem value="subtract">减少</SelectItem>
                    </SelectContent>
                  </Select>
                  <Input type="number" min={0} step="0.01" placeholder="金额(元,留空=跟随默认)" value={adjust.moneyVal} onChange={(e) => setAdjust({ ...adjust, moneyVal: e.target.value })} />
                </div>
                <div className="text-xs text-muted-foreground">
                  预览: {adjust.user.quota_money === null ? '跟随默认' : fmtY(adjust.user.quota_money)} → {adjust.moneyMode === 'override' && adjust.moneyVal === '' ? '跟随默认' : preview(adjust.user.quota_money, adjust.moneyMode, adjust.moneyVal) === null ? '—' : fmtY(preview(adjust.user.quota_money, adjust.moneyMode, adjust.moneyVal)!)}
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="outline" onClick={() => setAdjust(null)}>取消</Button>
                <Button size="sm" onClick={saveAdjust} disabled={saving}>{saving ? '保存中…' : '保存'}</Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* 部门预算设置弹窗 */}
      <Dialog open={!!budgetDept} onOpenChange={(o) => { if (!o) setBudgetDept(null) }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>设置部门预算 · {budgetDept?.name}</DialogTitle>
            <DialogDescription>月度金额预算(元);留空或 0 = 不限(清除),超限后该部门成员调用返回 429</DialogDescription>
          </DialogHeader>
          <Input type="number" min={0} step="0.01" value={budgetVal} onChange={(e) => setBudgetVal(e.target.value)} placeholder="1000" />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => setBudgetDept(null)}>取消</Button>
            <Button size="sm" onClick={saveBudget} disabled={saving}>{saving ? '保存中…' : '保存'}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
