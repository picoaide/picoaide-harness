import { useCallback, useEffect, useRef, useState } from 'react'
import { request, ADMIN_API } from '../api'
import { fmtTokens, fmtMoney, usageRate, moneyRate } from '../lib/format'
import { deptTreeOptions } from '../lib/utils'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Badge } from '../components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../components/ui/dialog'
import { Card } from '../components/ui/card'
import { Switch } from '../components/ui/switch'
import { PageHeader } from '../components/page-header'
import { EmptyState } from '../components/empty-state'
import { Search, Users as UsersIcon } from 'lucide-react'

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
  // 0057 密码/MFA
  source?: string // 'local' | 'external'; external 密码由 IdP 管理
  password_changeable?: boolean
  password_must_change?: boolean
  password_changed_at?: string
  mfa_enabled?: boolean
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
  const [deptSelect, setDeptSelect] = useState<string[]>([])   // 多部门(2026-09)
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
        request(`${ADMIN_API}/users?${params}`),
        request(`${ADMIN_API}/departments`),
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
    setCreateErr('')
    // 前端必填校验(UX 改进):不在服务端报错后才提示
    if (!username.trim()) { setCreateErr('请填写用户名'); return }
    if (!password) { setCreateErr('请填写密码'); return }
    if (password.length < 10) { setCreateErr('密码至少 10 位'); return }
    setBusy(true)
    try {
      await request(`${ADMIN_API}/users`, {
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
      await request(`${ADMIN_API}/users/${u.id}`, {
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
    // 删除前再提示后果:服务端级联清理其令牌/用量/组归属,不可恢复
    if (!window.confirm(`再确认:删除 ${u.username} 将同时清除其全部 API 令牌、用量记录与组归属,此操作不可恢复。确定继续?`)) return
    setBusy(true)
    try {
      await request(`${ADMIN_API}/users/${u.id}`, { method: 'DELETE' })
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
      const data = await request(`${ADMIN_API}/users/${u.id}/tokens`)
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
      await request(`${ADMIN_API}/tokens/${t.id}/revoke`, { method: 'POST' })
      if (tokensUser) openTokens(tokensUser)
    } catch (err: any) {
      setTokenErr(err.message)
    } finally {
      setBusy(false)
    }
  }

  // ---- 员工部门归属(2026-09 起支持多部门:部门树多选) ----
  async function openDept(u: User) {
    setDeptUser(u)
    setDeptErr('')
    // 只取在部门树中的组作为当前归属(不在部门树的组可能是 LDAP 授权组)
    const groups = u.groups ?? []
    const deptNames = groups.filter((g) => depts.some((d) => d.name === g))
    const ids = depts.filter((d) => deptNames.includes(d.name)).map((d) => String(d.id))
    setDeptSelect(ids)
    if (deptNames.length > 1) {
      setDeptNote(`当前归属 ${deptNames.length} 个部门(${deptNames.join('、')});保存保留为多部门,预算按全部所属部门同时生效(任一超限即拦)。`)
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
      await request(`${ADMIN_API}/users/${deptUser.id}/department`, {
        method: 'PUT',
        body: JSON.stringify({ group_ids: deptSelect.map((x) => Number(x)) }),
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
    if (mv !== '' && (!Number.isFinite(Number(mv)) || Number(mv) < 0)) {
      // 审计修复 2026-P: 金额校验补 Number.isFinite——Number('abc')=NaN 时
      // NaN<0 为 false 会静默通过,JSON.stringify 把 NaN 序列化为 null 提交
      setQuotaErr('金额配额必须是非负数字')
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
      await request(`${ADMIN_API}/users/${quotaUser.id}`, {
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

  // ---- 0057 重置密码 / 重置 MFA ----
  const [resetPwUser, setResetPwUser] = useState<User | null>(null)
  const [resetPw1, setResetPw1] = useState('')
  const [resetPw2, setResetPw2] = useState('')
  const [resetPwErr, setResetPwErr] = useState('')

  function openResetPw(u: User) {
    setResetPwUser(u)
    setResetPw1(''); setResetPw2(''); setResetPwErr('')
  }

  async function saveResetPw() {
    if (busy || !resetPwUser) return // 双击守卫(L10)
    if (resetPw1.length < 10) { setResetPwErr('新密码至少 10 位'); return }
    if (resetPw1 !== resetPw2) { setResetPwErr('两次输入的新密码不一致'); return }
    const name = resetPwUser.username
    setBusy(true)
    try {
      await request(`${ADMIN_API}/users/${resetPwUser.id}`, {
        method: 'PUT',
        body: JSON.stringify({ password: resetPw1 }),
      })
      setResetPwUser(null)
      setError(`已重置 ${name} 的密码:已吊销其全部会话,对方下次登录须先修改密码`)
      load(page, q)
    } catch (err: any) {
      setResetPwErr(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function resetMFA(u: User) {
    if (busy) return // 双击守卫(L10)
    if (!window.confirm(`确定重置 ${u.username} 的双重验证?将关闭其 MFA 并吊销全部会话,对方需用密码重新登录。`)) return
    setBusy(true)
    try {
      await request(`${ADMIN_API}/users/${u.id}/mfa`, { method: 'PUT' })
      setError(`已重置 ${u.username} 的双重验证`)
      load(page, q)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const pages = Math.max(1, Math.ceil(total / 20))

  return (
    <div className="space-y-5">
      <PageHeader
        title="用户管理"
        desc="企业成员账号、部门归属、流量配额与登录令牌"
        actions={
          <>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="w-full sm:w-56 pl-8"
                placeholder="按用户名搜索…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && load(1, q)}
              />
            </div>
            <Button variant="outline" onClick={() => load(1, q)}>搜索</Button>
            <Button onClick={() => setCreateOpen(true)}>新建用户</Button>
          </>
        }
      />
      {error && <div className="text-sm text-destructive">{error}</div>}

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ID</TableHead>
              <TableHead>用户名</TableHead>
              <TableHead>部门</TableHead>
              <TableHead>角色</TableHead>
              <TableHead>状态</TableHead>
              <TableHead className="min-w-0">本月流量</TableHead>
              <TableHead className="min-w-0">上次改密</TableHead>
              <TableHead className="w-1 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((u) => (
              <TableRow key={u.id}>
                <TableCell className="font-mono text-xs text-slate-400">{u.id}</TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <div className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[10px] font-bold ${u.is_admin ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-500'}`}>
                      {u.username.slice(0, 1).toUpperCase()}
                    </div>
                    <span className="font-medium">{u.username}</span>
                  </div>
                </TableCell>
                <TableCell>
                  {(u.groups ?? []).length > 0
                    ? u.groups!.map((g) => <Badge key={g} variant="outline" className="mr-1">{g}</Badge>)
                    : <span className="text-xs text-muted-foreground">—</span>}
                </TableCell>
                <TableCell>{u.is_admin ? <Badge>管理员</Badge> : <Badge variant="secondary">员工</Badge>}</TableCell>
                <TableCell>{u.status === 1 ? <Badge variant="success">启用</Badge> : <Badge variant="destructive">禁用</Badge>}</TableCell>
                <TableCell className="font-mono text-xs">
                  {u.is_admin ? (
                    <span className="text-muted-foreground">豁免</span>
                  ) : (
                    <div className="space-y-0.5">
                      <div>
                        <span className="font-semibold text-slate-800">{fmtTokens(u.monthly_usage ?? 0)}</span>
                        <span className="text-muted-foreground"> / {quotaLabel(u.quota_tokens, u.effective_quota_tokens)}</span>
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        ¥{fmtMoney(u.monthly_cost ?? 0)} / {moneyQuotaLabel(u.quota_money, u.effective_quota_money)}
                      </div>
                      {/* 中7:使用率基于生效配额(跟随默认也可见超限预警)。
                          仅在配额限定时展示(0/跟随默认(不限)无意义);badge 定高 h-5 避免 % 被裁剪 */}
                      {(() => {
                        const rate = Math.max(usageRate(u.monthly_usage ?? 0, u.effective_quota_tokens), moneyRate(u.monthly_cost ?? 0, u.effective_quota_money))
                        const hasLimit = (u.effective_quota_tokens && u.effective_quota_tokens > 0) || (u.effective_quota_money && u.effective_quota_money > 0)
                        if (!hasLimit) return null
                        return (
                          <Badge
                            variant={rate >= 90 ? 'destructive' : 'secondary'}
                            className="h-5 px-1.5 text-[10px] leading-none"
                          >
                            {rate}%
                          </Badge>
                        )
                      })()}
                    </div>
                  )}
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {/* 0057: 上次改密时间; 未改密(NULL)= 创建时初始密码 */}
                  {u.password_changed_at ? fmtTime(u.password_changed_at) : '初始密码'}
                </TableCell>
              <TableCell className="text-right">
                <div className="flex justify-end gap-2 whitespace-nowrap">
                  <Button size="sm" variant="outline" onClick={() => openTokens(u)}>令牌</Button>
                  <Button size="sm" variant="outline" onClick={() => openDept(u)}>部门</Button>
                  {/* L9:管理员豁免配额,禁用配额按钮避免无效设置 */}
                  <Button size="sm" variant="outline" disabled={u.is_admin} title={u.is_admin ? '管理员不受配额限制' : undefined} onClick={() => openQuota(u)}>配额</Button>
                  {/* 0057: 重置密码(local 用户; external 由 IdP 管理) */}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={u.source === 'external'}
                    title={u.source === 'external' ? '外部认证(LDAP/OIDC)用户的密码由企业 IdP 管理' : '重置后将吊销其全部会话,对方下次登录须改密'}
                    onClick={() => openResetPw(u)}
                  >重置密码</Button>
                  {/* 0057: 重置他人 MFA(仅对已开启者显示; 不显示自己不在此页判定,服务端 400 兜底) */}
                  {u.mfa_enabled && (
                    <Button size="sm" variant="outline" onClick={() => void resetMFA(u)}>重置MFA</Button>
                  )}
                  <Button size="sm" variant="outline" onClick={() => toggleUser(u)}>
                    {u.status === 1 ? '禁用' : '启用'}
                  </Button>
                  <Button size="sm" variant="destructive" onClick={() => remove(u)}>删除</Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
          {users.length === 0 && (
            <TableRow>
              <TableCell colSpan={8} className="border-0 p-0">
                <EmptyState
                  icon={<UsersIcon className="h-5 w-5 text-muted-foreground" />}
                  title="暂无匹配用户"
                  desc="调整搜索条件或点击「新建用户」创建成员账号"
                />
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      </Card>
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
              <Input id="create-username" value={username} onChange={(e) => setUsername(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && create()} autoFocus />
            </div>
            <div className="space-y-1">
              <Label htmlFor="create-password">密码</Label>
              <Input id="create-password" type="password" placeholder="至少 10 位" value={password} onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && create()} />
            </div>
            <div className="flex items-center gap-2">
              <Switch id="create-admin" checked={isAdmin} onCheckedChange={setIsAdmin} />
              <Label htmlFor="create-admin">管理员</Label>
            </div>
            {createErr && <div className="text-sm text-destructive">{createErr}</div>}
            <Button onClick={create} className="w-full">创建</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 0057 重置密码对话框: 重置即生效; 服务端置 must_change 并吊销全部会话 */}
      <Dialog open={!!resetPwUser} onOpenChange={(open) => { if (!open) setResetPwUser(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>重置密码 · {resetPwUser?.username}</DialogTitle>
            <DialogDescription>
              重置后该用户全部登录会话被立即吊销,下次登录必须修改密码(防止管理员代设的密码被长期沿用)。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor="reset-pw-1">新密码(至少 10 位)</Label>
              <Input id="reset-pw-1" type="password" value={resetPw1} onChange={(e) => setResetPw1(e.target.value)} autoFocus />
            </div>
            <div className="space-y-1">
              <Label htmlFor="reset-pw-2">确认新密码</Label>
              <Input id="reset-pw-2" type="password" value={resetPw2} onChange={(e) => setResetPw2(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void saveResetPw() }} />
            </div>
            {resetPwErr && <div className="text-sm text-destructive">{resetPwErr}</div>}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setResetPwUser(null)} disabled={busy}>取消</Button>
              <Button onClick={() => void saveResetPw()} disabled={busy}>{busy ? '提交中…' : '确认重置'}</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* 员工部门归属(2026-09:支持多部门,多选) */}
      <Dialog open={!!deptUser} onOpenChange={(open) => { if (!open) setDeptUser(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>设置部门 · {deptUser?.username}</DialogTitle>
            <DialogDescription>从部门树选择归属(可多选);所属部门全部生效,授权/预算按全部部门计算</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1">
              <Label>部门(多选)</Label>
              <div className="max-h-56 space-y-1 overflow-y-auto rounded-md border p-2">
                {deptTreeOptions(depts, 0, 0).map((o) => (
                  <label key={o.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-muted">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-[#4176E6]"
                      checked={deptSelect.includes(String(o.id))}
                      onChange={(e) => {
                        const v = String(o.id)
                        setDeptSelect((prev) => e.target.checked ? [...prev, v] : prev.filter((x) => x !== v))
                      }}
                    />
                    <span className="flex-1">{o.label}</span>
                    {deptSelect.includes(String(o.id)) && <span className="text-xs text-muted-foreground">已选</span>}
                  </label>
                ))}
              </div>
            </div>
            {deptNote && <p className="text-xs text-destructive">{deptNote}</p>}
            <p className="text-xs text-muted-foreground">
              保存将替换该用户全部部门归属(LDAP/OIDC 用户下次登录/同步可能被企业目录覆盖);
              预算 = 全部所属部门+祖先链同时生效,任一超限即拦截
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
