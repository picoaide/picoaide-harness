import { useCallback, useEffect, useRef, useState } from 'react'
import { request } from '../api'
import { fmtTokens, fmtMoney, usageRate, moneyRate } from '../lib/format'
import { deptTreeOptions } from '../lib/utils'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Badge } from '../components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../components/ui/dialog'
import { Switch } from '../components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select'

interface User {
  id: number
  username: string
  is_admin: boolean
  status: number
  groups?: string[]
  quota_tokens?: number | null // null = follow global default, 0 = unlimited, >0 = monthly cap
  monthly_usage?: number // tokens used this calendar month
  quota_money?: number | null // 0022:null = follow global default, 0 = unlimited, >0 = monthly yuan cap
  monthly_cost?: number // 0022:yuan spent this calendar month
  effective_quota_tokens?: number // 0021:解析后生效配额(跟随默认=全局值,admin=0)
  effective_quota_money?: number // 0022:同上(元)
}

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
}

interface ApiToken {
  id: number
  name: string
  created_at: string
  expires_at: string
  last_used_at: string
  revoked: number
}

function fmtTime(s: string): string {
  // P1-5: slice(0,16) dropped the timezone offset, so UTC-backed values
  // (e.g. "2026-08-21T06:00:00Z") rendered 8h behind local time and
  // inconsistently with the audit page's toLocaleString. Parse as an
  // absolute instant and render in the viewer's local timezone.
  if (!s) return '—'
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return s.slice(0, 16).replace('T', ' ')
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// quotaLabel renders the effective monthly quota for a user row.
// effective 为服务端解析后的生效配额(中7):跟随默认时展示全局值,0 = 不限。
function quotaLabel(q: number | null | undefined, effective?: number): string {
  if (q === null || q === undefined) {
    if (effective !== undefined && effective > 0) return `跟随默认(${fmtTokens(effective)}/月)`
    if (effective === 0) return '跟随默认(不限)'
    return '跟随默认'
  }
  if (q === 0) return '不限'
  return `${fmtTokens(q)} / 月`
}

// moneyQuotaLabel renders the effective monthly money quota (yuan, 0022).
function moneyQuotaLabel(q: number | null | undefined, effective?: number): string {
  if (q === null || q === undefined) {
    if (effective !== undefined && effective > 0) return `跟随默认(¥${fmtMoney(effective)}/月)`
    if (effective === 0) return '跟随默认(不限)'
    return '跟随默认'
  }
  if (q === 0) return '不限'
  return `¥${fmtMoney(q)} / 月`
}

export default function Users() {
  const [users, setUsers] = useState<User[]>([])
  const [depts, setDepts] = useState<Department[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [isAdmin, setIsAdmin] = useState(false)
  const [error, setError] = useState('')          // 页面级(列表加载失败)
  const [createErr, setCreateErr] = useState('')  // 新建用户对话框内错误(中3)
  const [deptErr, setDeptErr] = useState('')      // 部门归属对话框内错误(中3)
  const [quotaErr, setQuotaErr] = useState('')    // 配额对话框内错误(中3)
  const [tokenErr, setTokenErr] = useState('')    // 令牌对话框内错误(中5)
  const [tokensLoading, setTokensLoading] = useState(false)
  const [deptNote, setDeptNote] = useState('')    // 多组/LDAP 归属提示(中4)
  const [tokensUser, setTokensUser] = useState<User | null>(null)
  const [tokens, setTokens] = useState<ApiToken[]>([])
  const [deptUser, setDeptUser] = useState<User | null>(null)
  const [deptSelect, setDeptSelect] = useState('0')
  const [quotaUser, setQuotaUser] = useState<User | null>(null)
  const [quotaInput, setQuotaInput] = useState('')
  // P1-8: 请求序号防乱序——快速翻页/搜索/删除重拉时只有最新请求的响应能更新 state
  const loadSeq = useRef(0)
  const tokensSeq = useRef(0)

  const load = useCallback(async (p: number, search: string) => {
    const current = ++loadSeq.current
    try {
      const params = new URLSearchParams({ page: String(p), size: '20' })
      if (search) params.set('q', search)
      const [u, d] = await Promise.all([
        request(`/api/admin/users?${params}`),
        request('/api/admin/departments'),
      ])
      if (current !== loadSeq.current) return // P1-8: 过期响应丢弃
      setUsers(u.users)
      setTotal(u.total)
      setDepts(d.departments ?? [])
      setPage(p)
      setError('') // 成功后清空页面级错误(中3)
    } catch (err: any) {
      if (current !== loadSeq.current) return // P1-8: 过期响应不写错误
      setError(err.message)
    }
  }, [])

  useEffect(() => { load(1, '') }, [load])

  async function create() {
    if (busy) return // 双击守卫(审计2026-W9)
    setBusy(true)
    try {
      await request('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({ username, password, is_admin: isAdmin }),
      })
      setCreateErr('')
      setCreateOpen(false)
      setUsername('')
      setPassword('')
      setIsAdmin(false)
      load(1, "")
    } catch (err: any) {
      setCreateErr(err.message) // 错误显示在对话框内(中3),不再被遮罩盖住
    } finally {
      setBusy(false)
    }
  }

  async function toggleUser(u: User) {
    if (busy) return // 双击守卫(审计2026-W9)
    // 高2:禁用是危险操作(服务端会同时吊销该用户全部 API 令牌),必须确认
    if (u.status === 1 && !window.confirm(`确定禁用用户 ${u.username}?禁用将立即吊销其全部 API 令牌,客户端需重新登录。`)) return
    setBusy(true)
    try {
      await request(`/api/admin/users/${u.id}`, {
        method: 'PUT',
        body: JSON.stringify({ status: u.status === 1 ? 0 : 1 }),
      })
      load(page, q)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function remove(u: User) {
    if (busy) return // 双击守卫(审计2026-W9)
    if (!window.confirm(`确定删除用户 ${u.username}?`)) return
    setBusy(true)
    try {
      await request(`/api/admin/users/${u.id}`, { method: 'DELETE' })
      // L14:末页删除最后一条后回退页码,避免出现「第 2/1 页」空表
      const newPages = Math.max(1, Math.ceil((total - 1) / 20))
      load(Math.min(page, newPages), q)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function openTokens(u: User) {
    const current = ++tokensSeq.current // P1-8: 快速切换用户时只认最新响应
    setTokensUser(u)
    setTokens([])          // 中5:打开即清空,避免跨用户残留上一用户令牌
    setTokenErr('')
    setTokensLoading(true)
    try {
      const data = await request(`/api/admin/users/${u.id}/tokens`)
      if (current !== tokensSeq.current) return // P1-8: 过期响应丢弃
      setTokens(data.tokens)
    } catch (err: any) {
      if (current !== tokensSeq.current) return // P1-8: 过期响应不写错误
      setTokenErr(err.message) // 中5:错误显示在对话框内,不再误报「暂无令牌」
    } finally {
      if (current === tokensSeq.current) setTokensLoading(false)
    }
  }

  async function revoke(t: ApiToken) {
    if (busy) return // 双击守卫(L10)
    if (!window.confirm(`确定撤销令牌 #${t.id}(${t.name})?撤销后客户端需重新登录。`)) return
    setBusy(true)
    try {
      await request(`/api/admin/tokens/${t.id}/revoke`, { method: 'POST' })
      if (tokensUser) openTokens(tokensUser)
    } catch (err: any) {
      setTokenErr(err.message)
    } finally {
      setBusy(false)
    }
  }

  // ---- 员工部门归属(金字塔单选,从部门树选择) ----
  async function openDept(u: User) {
    setDeptUser(u)
    setDeptErr('')
    // 中4:不猜 groups[0];只取在部门树中的组作为当前归属
    const groups = u.groups ?? []
    const deptNames = groups.filter((g) => depts.some((d) => d.name === g))
    const current = deptNames.length === 1 ? deptNames[0] : undefined
    const d = current ? depts.find((x) => x.name === current) : undefined
    setDeptSelect(d ? String(d.id) : '0')
    if (deptNames.length > 1) {
      setDeptNote(`该用户当前归属 ${deptNames.length} 个组(${deptNames.join('、')}),保存将替换为所选单个部门。`)
    } else if (deptNames.length === 0 && groups.length > 0) {
      setDeptNote(`该用户当前组(${groups.join('、')})不在部门树中,保存将清空其全部归属。`)
    } else {
      setDeptNote('')
    }
  }

  async function saveDept() {
    if (busy || !deptUser) return // 双击守卫(L10)
    setBusy(true)
    try {
      await request(`/api/admin/users/${deptUser.id}/department`, {
        method: 'PUT',
        body: JSON.stringify({ group_id: Number(deptSelect) }),
      })
      setDeptErr('')
      setDeptUser(null)
      load(page, q)
    } catch (err: any) {
      setDeptErr(err.message)
    } finally {
      setBusy(false)
    }
  }

  // ---- 员工流量配额(token + 金额,跟随全局 / 不限 / 按月限额) ----
  const [quotaMoneyInput, setQuotaMoneyInput] = useState('')
  function openQuota(u: User) {
    setQuotaUser(u)
    setQuotaErr('')
    setQuotaInput(u.quota_tokens === null || u.quota_tokens === undefined ? '' : String(u.quota_tokens))
    setQuotaMoneyInput(u.quota_money === null || u.quota_money === undefined ? '' : String(u.quota_money))
  }

  async function saveQuota() {
    if (busy || !quotaUser) return // 双击守卫(L10)
    const v = quotaInput.trim()
    const mv = quotaMoneyInput.trim()
    // L7:前端校验,token 必须 ≥0 整数,金额 ≥0
    if (v !== '' && (Number(v) < 0 || !Number.isInteger(Number(v)))) {
      setQuotaErr('token 配额必须是 ≥0 的整数')
      return
    }
    if (mv !== '' && Number(mv) < 0) {
      setQuotaErr('金额配额不能为负数')
      return
    }
    setBusy(true)
    try {
      const body: Record<string, any> = {}
      // token:空 = 跟随全局默认(清空覆盖);"0" = 不限;正数 = 月配额
      if (v === '') body.quota_clear = true
      else body.quota_tokens = Number(v)
      // 金额(0022):空 = 跟随全局默认;0 = 不限;正数 = 月金额上限
      if (mv === '') body.quota_money_clear = true
      else body.quota_money = Number(mv)
      await request(`/api/admin/users/${quotaUser.id}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      })
      setQuotaErr('')
      setQuotaUser(null)
      load(page, q)
    } catch (err: any) {
      setQuotaErr(err.message)
    } finally {
      setBusy(false)
    }
  }

  const pages = Math.max(1, Math.ceil(total / 20))

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">用户管理</h1>
        <div className="flex items-center gap-2">
          <Input
            className="w-56"
            placeholder="按用户名搜索…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && load(1, q)}
          />
          <Button variant="outline" onClick={() => load(1, q)}>搜索</Button>
          <Button onClick={() => setCreateOpen(true)}>新建用户</Button>
        </div>
      </div>
      {error && <div className="text-sm text-destructive">{error}</div>}

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>ID</TableHead>
            <TableHead>用户名</TableHead>
            <TableHead>部门</TableHead>
            <TableHead>角色</TableHead>
            <TableHead>状态</TableHead>
            <TableHead>本月流量</TableHead>
            <TableHead className="text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {users.map((u) => (
            <TableRow key={u.id}>
              <TableCell>{u.id}</TableCell>
              <TableCell>{u.username}</TableCell>
              <TableCell>
                {(u.groups ?? []).length > 0
                  ? u.groups!.map((g) => <Badge key={g} variant="outline" className="mr-1">{g}</Badge>)
                  : <span className="text-xs text-muted-foreground">—</span>}
              </TableCell>
              <TableCell>{u.is_admin ? <Badge>管理员</Badge> : <Badge variant="secondary">员工</Badge>}</TableCell>
              <TableCell>{u.status === 1 ? <Badge variant="success">启用</Badge> : <Badge variant="destructive">禁用</Badge>}</TableCell>
              <TableCell>
                {u.is_admin ? (
                  <span className="text-xs text-muted-foreground">豁免</span>
                ) : (
                  <div className="space-y-0.5">
                    <div className="text-xs">
                      <span className="font-medium">{fmtTokens(u.monthly_usage ?? 0)}</span>
                      <span className="text-muted-foreground"> / {quotaLabel(u.quota_tokens, u.effective_quota_tokens)}</span>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      ¥{fmtMoney(u.monthly_cost ?? 0)} / {moneyQuotaLabel(u.quota_money, u.effective_quota_money)}
                    </div>
                    {/* 中7:使用率基于生效配额(跟随默认也可见超限预警) */}
                    {((u.effective_quota_tokens && u.effective_quota_tokens > 0) || (u.effective_quota_money && u.effective_quota_money > 0)) && (
                      <Badge
                        variant={Math.max(usageRate(u.monthly_usage ?? 0, u.effective_quota_tokens), moneyRate(u.monthly_cost ?? 0, u.effective_quota_money)) >= 90 ? 'destructive' : 'secondary'}
                        className="h-4 px-1.5 text-[10px]"
                      >
                        {Math.max(usageRate(u.monthly_usage ?? 0, u.effective_quota_tokens), moneyRate(u.monthly_cost ?? 0, u.effective_quota_money))}%
                      </Badge>
                    )}
                  </div>
                )}
              </TableCell>
              <TableCell className="text-right space-x-2">
                <Button size="sm" variant="outline" onClick={() => openTokens(u)}>令牌</Button>
                <Button size="sm" variant="outline" onClick={() => openDept(u)}>部门</Button>
                {/* L9:管理员豁免配额,禁用配额按钮避免无效设置 */}
                <Button size="sm" variant="outline" disabled={u.is_admin} title={u.is_admin ? '管理员不受配额限制' : undefined} onClick={() => openQuota(u)}>配额</Button>
                <Button size="sm" variant="outline" onClick={() => toggleUser(u)}>
                  {u.status === 1 ? '禁用' : '启用'}
                </Button>
                <Button size="sm" variant="destructive" onClick={() => remove(u)}>删除</Button>
              </TableCell>
            </TableRow>
          ))}
          {users.length === 0 && (
            <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground">暂无匹配用户,调整搜索条件或点击「新建用户」</TableCell></TableRow>
          )}
        </TableBody>
      </Table>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => load(page - 1, q)}>上一页</Button>
        <span className="text-sm text-muted-foreground">第 {page}/{pages} 页 · 共 {total} 人</span>
        <Button size="sm" variant="outline" disabled={page >= pages} onClick={() => load(page + 1, q)}>下一页</Button>
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建用户</DialogTitle>
            <DialogDescription>创建本地账号,创建后在「部门」中设置归属</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor="create-username">用户名</Label>
              <Input id="create-username" value={username} onChange={(e) => setUsername(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="create-password">密码</Label>
              <Input id="create-password" type="password" placeholder="至少 10 位" value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            <div className="flex items-center gap-2">
              <Switch checked={isAdmin} onCheckedChange={setIsAdmin} />
              <Label htmlFor="create-admin">管理员</Label>
            </div>
            {createErr && <div className="text-sm text-destructive">{createErr}</div>}
            <Button onClick={create} className="w-full">创建</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 员工部门归属(金字塔单选) */}
      <Dialog open={!!deptUser} onOpenChange={(open) => { if (!open) setDeptUser(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>设置部门 · {deptUser?.username}</DialogTitle>
            <DialogDescription>从部门树选择归属(单选);授权给上级部门自动覆盖本部门</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor="dept-select">部门</Label>
              <Select value={deptSelect} onValueChange={setDeptSelect}>
                <SelectTrigger aria-label="部门" id="dept-select"><SelectValue placeholder="选择部门" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">未分配</SelectItem>
                  {deptTreeOptions(depts, 0, 0).map((o) => (
                    <SelectItem key={o.id} value={String(o.id)}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {deptNote && <p className="text-xs text-destructive">{deptNote}</p>}
            <p className="text-xs text-muted-foreground">
              保存将替换该用户全部部门归属(LDAP 用户下次登录可能被企业目录同步回滚)
            </p>
            {deptErr && <div className="text-sm text-destructive">{deptErr}</div>}
            <Button onClick={saveDept} className="w-full">保存</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 员工流量配额(token + 金额双维度) */}
      <Dialog open={!!quotaUser} onOpenChange={(open) => { if (!open) setQuotaUser(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>流量配额 · {quotaUser?.username}</DialogTitle>
            <DialogDescription>
              本月已用 {fmtTokens(quotaUser?.monthly_usage ?? 0)} tokens · ¥{fmtMoney(quotaUser?.monthly_cost ?? 0)}。
              配额按月统计,每月 1 日重置。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor="quota-tokens">月度 token 配额</Label>
              <Input
                id="quota-tokens"
                type="number"
                min={0}
                step={1}
                placeholder="留空 = 跟随全局默认;0 = 不限"
                value={quotaInput}
                onChange={(e) => setQuotaInput(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="quota-money">月度金额配额(元)</Label>
              <Input
                id="quota-money"
                type="number"
                min={0}
                step="0.01"
                placeholder="留空 = 跟随全局默认;0 = 不限"
                value={quotaMoneyInput}
                onChange={(e) => setQuotaMoneyInput(e.target.value)}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              留空:跟随网关「全局设置」中的默认配额;输入 0:该员工不限;输入正数:按月限额。
              金额配额按模型定价折算费用统计,任一维度超限即拦截。管理员(admin)不受配额限制。
            </p>
            {quotaErr && <div className="text-sm text-destructive">{quotaErr}</div>}
            <Button className="w-full" onClick={saveQuota}>保存</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!tokensUser} onOpenChange={(open) => { if (!open) setTokensUser(null) }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>令牌管理 · {tokensUser?.username}</DialogTitle>
            <DialogDescription>客户端登录凭证,90 天过期;撤销后客户端需重新登录</DialogDescription>
          </DialogHeader>
          {tokensLoading ? (
            <div className="text-sm text-muted-foreground">加载中…</div>
          ) : tokenErr ? (
            <div className="text-sm text-destructive">{tokenErr}</div>
          ) : tokens.length === 0 ? (
            <div className="text-sm text-muted-foreground">该用户暂无令牌</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>名称</TableHead>
                  <TableHead>创建时间</TableHead>
                  <TableHead>过期时间</TableHead>
                  <TableHead>最后使用</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tokens.map((t) => {
                  const expired = !t.revoked && t.expires_at && new Date(t.expires_at) < new Date()
                  return (
                    <TableRow key={t.id}>
                      <TableCell>{t.name}</TableCell>
                      <TableCell>{fmtTime(t.created_at)}</TableCell>
                      <TableCell>{fmtTime(t.expires_at)}</TableCell>
                      <TableCell>{fmtTime(t.last_used_at)}</TableCell>
                      <TableCell>
                        {t.revoked ? <Badge variant="destructive">已撤销</Badge> : expired ? <Badge variant="secondary">已过期</Badge> : <Badge variant="success">正常</Badge>}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button size="sm" variant="destructive" disabled={!!t.revoked} onClick={() => revoke(t)}>撤销</Button>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
