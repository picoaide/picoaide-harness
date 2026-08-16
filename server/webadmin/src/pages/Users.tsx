import { useCallback, useEffect, useState } from 'react'
import { request } from '../api'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Badge } from '../components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../components/ui/dialog'
import { Switch } from '../components/ui/switch'

interface User {
  id: number
  username: string
  is_admin: boolean
  status: number
  groups?: string[]
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
  return s ? s.slice(0, 16).replace('T', ' ') : '—'
}

export default function Users() {
  const [users, setUsers] = useState<User[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [q, setQ] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [isAdmin, setIsAdmin] = useState(false)
  const [error, setError] = useState('')
  const [tokensUser, setTokensUser] = useState<User | null>(null)
  const [tokens, setTokens] = useState<ApiToken[]>([])
  const [groupsUser, setGroupsUser] = useState<User | null>(null)
  const [groupsInput, setGroupsInput] = useState('')

  const load = useCallback(async (p: number, search: string) => {
    try {
      const params = new URLSearchParams({ page: String(p), size: '20' })
      if (search) params.set('q', search)
      const data = await request(`/api/admin/users?${params}`)
      setUsers(data.users)
      setTotal(data.total)
      setPage(p)
    } catch (err: any) {
      setError(err.message)
    }
  }, [])

  useEffect(() => { load(1, '') }, [load])

  async function create() {
    try {
      await request('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({ username, password, is_admin: isAdmin }),
      })
      setCreateOpen(false)
      setUsername('')
      setPassword('')
      setIsAdmin(false)
      load(1, "")
    } catch (err: any) {
      setError(err.message)
    }
  }

  async function toggleUser(u: User) {
    try {
      await request(`/api/admin/users/${u.id}`, {
        method: 'PUT',
        body: JSON.stringify({ status: u.status === 1 ? 0 : 1 }),
      })
      load(page, q)
    } catch (err: any) {
      setError(err.message)
    }
  }

  async function remove(u: User) {
    if (!window.confirm(`确定删除用户 ${u.username}?`)) return
    try {
      await request(`/api/admin/users/${u.id}`, { method: 'DELETE' })
      load(page, q)
    } catch (err: any) {
      setError(err.message)
    }
  }

  async function openTokens(u: User) {
    setTokensUser(u)
    try {
      const data = await request(`/api/admin/users/${u.id}/tokens`)
      setTokens(data.tokens)
    } catch (err: any) {
      setError(err.message)
    }
  }

  async function revoke(t: ApiToken) {
    if (!window.confirm(`确定撤销令牌 #${t.id}(${t.name})?撤销后客户端需重新登录。`)) return
    try {
      await request(`/api/admin/tokens/${t.id}/revoke`, { method: 'POST' })
      if (tokensUser) openTokens(tokensUser)
    } catch (err: any) {
      setError(err.message)
    }
  }

  async function openGroups(u: User) {
    setGroupsUser(u)
    setGroupsInput((u.groups ?? []).join(', '))
  }

  async function saveGroups() {
    if (!groupsUser) return
    const groups = groupsInput.split(',').map((s) => s.trim()).filter(Boolean)
    try {
      await request(`/api/admin/users/${groupsUser.id}/groups`, {
        method: 'PUT',
        body: JSON.stringify({ groups }),
      })
      setGroupsUser(null)
      load(page, q)
    } catch (err: any) {
      setError(err.message)
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
            <TableHead>部门组</TableHead>
            <TableHead>角色</TableHead>
            <TableHead>状态</TableHead>
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
                  ? u.groups!.map((g) => <Badge key={g} variant="outline" className="mr-1">@{g}</Badge>)
                  : <span className="text-xs text-muted-foreground">—</span>}
              </TableCell>
              <TableCell>{u.is_admin ? <Badge>管理员</Badge> : <Badge variant="secondary">员工</Badge>}</TableCell>
              <TableCell>{u.status === 1 ? <Badge variant="success">启用</Badge> : <Badge variant="destructive">禁用</Badge>}</TableCell>
              <TableCell className="text-right space-x-2">
                <Button size="sm" variant="outline" onClick={() => openTokens(u)}>令牌</Button>
                <Button size="sm" variant="outline" onClick={() => openGroups(u)}>部门组</Button>
                <Button size="sm" variant="outline" onClick={() => toggleUser(u)}>
                  {u.status === 1 ? '禁用' : '启用'}
                </Button>
                <Button size="sm" variant="destructive" onClick={() => remove(u)}>删除</Button>
              </TableCell>
            </TableRow>
          ))}
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
            <DialogDescription>创建本地账号</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1">
              <Label>用户名</Label>
              <Input value={username} onChange={(e) => setUsername(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>密码</Label>
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            <div className="flex items-center gap-2">
              <Switch checked={isAdmin} onCheckedChange={setIsAdmin} />
              <Label>管理员</Label>
            </div>
            <Button onClick={create} className="w-full">创建</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!groupsUser} onOpenChange={(open) => { if (!open) setGroupsUser(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>部门组 · {groupsUser?.username}</DialogTitle>
            <DialogDescription>组名以逗号分隔;部门组用于知识库/技能/MCP 授权(LDAP 登录自动同步,此处仅本地账号)</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1">
              <Label>部门组</Label>
              <Input placeholder="研发部, 财务部" value={groupsInput} onChange={(e) => setGroupsInput(e.target.value)} />
            </div>
            <Button onClick={saveGroups} className="w-full">保存</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!tokensUser} onOpenChange={(open) => { if (!open) setTokensUser(null) }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>令牌管理 · {tokensUser?.username}</DialogTitle>
            <DialogDescription>客户端登录凭证,90 天过期;撤销后客户端需重新登录</DialogDescription>
          </DialogHeader>
          {tokens.length === 0 ? (
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
                {tokens.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell>{t.name}</TableCell>
                    <TableCell>{fmtTime(t.created_at)}</TableCell>
                    <TableCell>{fmtTime(t.expires_at)}</TableCell>
                    <TableCell>{fmtTime(t.last_used_at)}</TableCell>
                    <TableCell>{t.revoked ? <Badge variant="destructive">已撤销</Badge> : <Badge variant="success">正常</Badge>}</TableCell>
                    <TableCell className="text-right">
                      <Button size="sm" variant="destructive" disabled={!!t.revoked} onClick={() => revoke(t)}>撤销</Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
