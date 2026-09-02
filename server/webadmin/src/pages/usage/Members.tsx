import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { request, ADMIN_API } from '../../api'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'
import { Badge } from '../../components/ui/badge'
import { Skeleton } from '../../components/ui/skeleton'
import { Input } from '../../components/ui/input'
import { Button } from '../../components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table'
import { PageHeader } from '../../components/page-header'
import { fmtY, type UserInfo } from './common'
import { fmtTokens, moneyPercent, moneyOver } from '../../lib/format'
import { cn } from '../../lib/utils'

// 成员用量(本月维度):用户列表 + 搜索;行点击 → 个人详情二级页
export default function UsageMembers() {
  const [users, setUsers] = useState<UserInfo[]>([])
  const [total, setTotal] = useState(0)
  const [q, setQ] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = async (query: string) => {
    setLoading(true)
    setError('')
    try {
      const d = await request<{ users: UserInfo[]; total: number }>(`${ADMIN_API}/users?size=200${query ? `&q=${encodeURIComponent(query)}` : ''}`)
      setUsers((d.users ?? []).filter((u) => !u.role || u.role !== 'super_admin'))
      setTotal(d.total ?? 0)
    } catch (e: any) {
      setError(e.message || '查询失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load(q) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-6">
      <PageHeader title="成员用量" desc="本月每人消耗与配额(自然月口径);点击成员查看其近 30 天个人明细" />
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">成员列表</CardTitle>
          <div className="flex items-center gap-2">
            <Input
              placeholder="搜索用户名"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void load(q) }}
              className="h-8 w-48"
              aria-label="搜索成员"
            />
            <Button size="sm" variant="outline" onClick={() => void load(q)}>查询</Button>
          </div>
        </CardHeader>
        <CardContent>
          {error && <div className="mb-2 text-sm text-destructive">{error}</div>}
          <div className="mb-2 text-xs text-muted-foreground">共 {Math.max(0, total - 1)} 名员工{total > 200 ? '(列表展示前 200,搜索可缩小范围)' : ''}</div>
          {loading ? <Skeleton className="h-72 w-full" /> : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>用户名</TableHead>
                  <TableHead>部门</TableHead>
                  <TableHead className="text-right">本月费用</TableHead>
                  <TableHead className="text-right">本月 tokens</TableHead>
                  <TableHead className="text-right">金额配额</TableHead>
                  <TableHead className="text-right">使用率</TableHead>
                  <TableHead className="w-16">状态</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((u) => {
                  const pct = moneyPercent(u.monthly_cost, u.quota_money)
                  const over = moneyOver(u.monthly_cost, u.quota_money)
                  return (
                    <TableRow key={u.id} className="cursor-pointer hover:bg-accent">
                      <TableCell>
                        <Link to={`/usage/members/${encodeURIComponent(u.username)}`} className="font-medium text-foreground hover:underline">
                          {u.display_name || u.username}
                        </Link>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{(u.groups ?? []).filter((g) => g !== '全员').join(', ') || '—'}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtY(u.monthly_cost)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtTokens(u.monthly_usage)}</TableCell>
                      <TableCell className="text-right tabular-nums">{u.quota_money ? fmtY(u.quota_money) : '不限'}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {pct === null ? '—' : (
                          <span className={cn(over && 'font-semibold text-destructive', !over && (pct ?? 0) >= 90 && 'text-amber-600')}>{pct}%</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant={u.status === 1 ? 'secondary' : 'destructive'}>{u.status === 1 ? '正常' : '停用'}</Badge>
                      </TableCell>
                    </TableRow>
                  )
                })}
                {users.length === 0 && <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground">暂无成员</TableCell></TableRow>}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
