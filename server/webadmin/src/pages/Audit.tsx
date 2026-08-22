import { useCallback, useEffect, useRef, useState } from 'react'
import { request } from '../api'
import { Button } from '../components/ui/button'
import { Badge } from '../components/ui/badge'
import { Input } from '../components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table'

interface LogRow {
  id: number
  username: string
  action: string
  detail: string
  created_at: string
}

// M3: 与服务端实际写入的 audit action 全集对齐(用户/部门/技能/令牌等敏感操作)
const ACTION_LABEL: Record<string, string> = {
  skill_create: '上架技能',
  skill_update: '更新技能',
  skill_disable: '下架技能',
  skill_enable: '重新上架技能',
  skill_grant: '技能授权',
  skill_revoke: '技能撤销授权',
  skill_grants_replace: '技能部门授权替换',
  user_create: '创建用户',
  user_update: '更新用户',
  user_delete: '删除用户',
  user_dept: '用户部门变更',
  user_tokens_revoked: '吊销令牌',
  dept_create: '新建部门',
  dept_update: '更新部门',
  dept_delete: '删除部门',
}

// M8: 筛选下拉的可选动作
const FILTER_ACTIONS = Object.keys(ACTION_LABEL).sort()

function fmtTime(iso: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  // L4: 保留时区语义,按本地时间展示
  return d.toLocaleString('zh-CN', { hour12: false })
}

export default function Audit() {
  const [logs, setLogs] = useState<LogRow[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [error, setError] = useState('')
  // M8: 筛选条件(输入态 vs 已应用态)
  const [filterAction, setFilterAction] = useState('')
  const [filterUser, setFilterUser] = useState('')
  const [appliedAction, setAppliedAction] = useState('')
  const [appliedUser, setAppliedUser] = useState('')
  // P1-8: 请求序号防乱序——快速翻页/切筛选时只有最新请求的响应能更新 state
  const loadSeq = useRef(0)

  const load = useCallback(async (p: number, action: string, username: string) => {
    const current = ++loadSeq.current
    try {
      const params = new URLSearchParams({ page: String(p), size: '50' })
      if (action) params.set('action', action)
      if (username) params.set('username', username)
      const data = await request(`/api/admin/audit?${params.toString()}`)
      if (current !== loadSeq.current) return // P1-8: 过期响应丢弃
      setLogs(data.logs)
      setTotal(data.total)
      setPage(p)
    } catch (err: any) {
      if (current !== loadSeq.current) return // P1-8: 过期响应不写错误
      setError(err.message)
    }
  }, [])

  useEffect(() => { load(1, appliedAction, appliedUser) }, [load, appliedAction, appliedUser])

  const applyFilter = () => {
    setAppliedAction(filterAction)
    setAppliedUser(filterUser.trim())
    setPage(1)
    load(1, filterAction, filterUser.trim())
  }

  const pages = Math.max(1, Math.ceil(total / 50))

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">审计日志</h1>
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">敏感操作记录(用户/部门/技能等)</span>
          <Button size="sm" variant="outline" onClick={() => load(page, appliedAction, appliedUser)}>刷新</Button>
        </div>
      </div>
      {error && <div className="text-sm text-destructive">{error}</div>}
      {/* M8: 筛选条 */}
      <div className="flex flex-wrap items-center gap-2">
        <Select value={filterAction} onValueChange={setFilterAction}>
          <SelectTrigger className="w-52">
            <SelectValue placeholder="全部操作" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">全部操作</SelectItem>
            {FILTER_ACTIONS.map((a) => (
              <SelectItem key={a} value={a}>{ACTION_LABEL[a]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          className="w-44"
          placeholder="操作者"
          value={filterUser}
          onChange={(e) => setFilterUser(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') applyFilter() }}
        />
        <Button size="sm" variant="outline" onClick={applyFilter}>筛选</Button>
        {(appliedAction || appliedUser) && (
          <Button size="sm" variant="ghost" onClick={() => { setFilterAction(''); setFilterUser(''); setAppliedAction(''); setAppliedUser('') }}>清除筛选</Button>
        )}
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>ID</TableHead>
            <TableHead>操作</TableHead>
            <TableHead>操作者</TableHead>
            <TableHead>详情</TableHead>
            <TableHead>时间</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {logs.map((l) => (
            <TableRow key={l.id}>
              <TableCell>{l.id}</TableCell>
              <TableCell><Badge variant="secondary">{ACTION_LABEL[l.action] ?? l.action}</Badge></TableCell>
              <TableCell>{l.username}</TableCell>
              {/* M8: 详情悬停可查看全文 */}
              <TableCell className="max-w-96 truncate font-mono text-xs" title={l.detail}>{l.detail}</TableCell>
              <TableCell className="text-muted-foreground">{fmtTime(l.created_at)}</TableCell>
            </TableRow>
          ))}
          {logs.length === 0 && (
            <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground">暂无记录</TableCell></TableRow>
          )}
        </TableBody>
      </Table>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => load(page - 1, appliedAction, appliedUser)}>上一页</Button>
        <span className="text-sm text-muted-foreground">第 {page}/{pages} 页 · 共 {total} 条</span>
        <Button size="sm" variant="outline" disabled={page >= pages} onClick={() => load(page + 1, appliedAction, appliedUser)}>下一页</Button>
      </div>
    </div>
  )
}
