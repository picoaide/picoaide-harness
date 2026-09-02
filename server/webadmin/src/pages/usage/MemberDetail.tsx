import { useCallback, useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import type { ISpec } from '@visactor/vchart'
import { ChartLazy } from '../../components/chart-lazy'
import { request, ADMIN_API } from '../../api'
import { Button } from '../../components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card'
import { Badge } from '../../components/ui/badge'
import { Skeleton } from '../../components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table'
import { PageHeader } from '../../components/page-header'
import { ArrowLeft } from 'lucide-react'
import { RangeFilter, defaultRange, fetchUsageList, chatTokens, sumRows, downloadCsv, fmtY, type UsageRow, type UsageRequestRow, type UserInfo } from './common'
import { fmtTokens, fmtFull, fmtMoney } from '../../lib/format'

// 成员详情(独立二级页):该成员近30天趋势 + 模型构成 + 最近请求 + 导出
export default function UsageMemberDetail() {
  const { username = '' } = useParams()
  const init = defaultRange()
  const [from, setFrom] = useState(init.from)
  const [to, setTo] = useState(init.to)
  const [user, setUser] = useState<UserInfo | null>(null)
  const [trend, setTrend] = useState<UsageRow[]>([])
  const [models, setModels] = useState<UsageRow[]>([])
  const [requests, setRequests] = useState<UsageRequestRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async (f: string, t: string) => {
    setLoading(true)
    setError('')
    try {
      const [ul, tr, mo, rq] = await Promise.all([
        request<{ users: UserInfo[] }>(`${ADMIN_API}/users?size=50&q=${encodeURIComponent(username)}`),
        fetchUsageList({ group: 'day', username, from: f, to: t }),
        fetchUsageList({ group: 'model', username, from: f, to: t }),
        request<{ rows: UsageRequestRow[] }>(`${ADMIN_API}/usage/requests?username=${encodeURIComponent(username)}&from=${f}&to=${t}&size=5`),
      ])
      setUser((ul.users ?? []).find((u) => u.username === username) ?? null)
      setTrend(tr)
      setModels(mo)
      setRequests(rq.rows ?? [])
    } catch (e: any) {
      setError(e.message || '查询失败')
    } finally {
      setLoading(false)
    }
  }, [username])

  useEffect(() => { void load(from, to) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const trendSpec: ISpec | null = trend.length > 0 ? {
    type: 'line',
    data: { values: trend.map((r) => ({ label: r.label.slice(5), cost: Number((r.cost ?? 0).toFixed(4)) })) },
    xField: 'label',
    yField: 'cost',
    point: { visible: true },
    axes: [
      { orient: 'left', title: { visible: true, text: '费用(¥)' }, label: { visible: true, style: { fontSize: 11 } } },
      { orient: 'bottom', label: { visible: true, style: { fontSize: 10 } } },
    ],
    tooltip: { visible: true },
  } : null

  const s = sumRows(trend)

  const exportCsv = () => {
    downloadCsv(`member_${username}_${from}_${to}.csv`,
      ['维度', '请求数', '输入tokens', '输出tokens', 'chat合计tokens', '费用(¥)'],
      models.map((r) => [r.label, r.requests, r.prompt_tokens, r.completion_tokens, chatTokens(r), (r.cost ?? 0).toFixed(4)]))
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={`成员用量 · ${username}`}
        desc="单人的消耗画像:近 30 天按天费用、模型构成、最近请求(不含对话内容)"
        actions={<Link to="/usage/members"><Button size="sm" variant="outline"><ArrowLeft className="h-3.5 w-3.5" /> 返回成员列表</Button></Link>}
      />
      <RangeFilter from={from} to={to} setFrom={setFrom} setTo={setTo} onQuery={() => void load(from, to)} />
      {error && <div className="text-sm text-destructive">{error}</div>}

      <div className="flex flex-wrap items-center gap-2">
        {user ? (
          <>
            <Badge variant="outline">部门: {(user.groups ?? []).filter((g) => g !== '全员').join(', ') || '未分配'}</Badge>
            <Badge variant="secondary">本月消耗 {fmtY(user.monthly_cost)}</Badge>
            <Badge variant="secondary">本月 tokens {fmtTokens(user.monthly_usage)}</Badge>
            <Badge variant="outline">金额配额 {user.quota_money ? fmtY(user.quota_money) : '不限'}</Badge>
            <Badge variant="outline">token 配额 {user.quota_tokens ? fmtTokens(user.quota_tokens) : '不限'}</Badge>
          </>
        ) : loading ? <Skeleton className="h-6 w-48" /> : null}
      </div>

      {loading ? <Skeleton className="h-80 w-full" /> : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <div>
                <CardTitle className="text-base">消耗趋势</CardTitle>
                <CardDescription>按天费用(¥)· {from} ~ {to} · 合计 {fmtY(s.cost)} ({fmtFull(s.tokens)} tokens)</CardDescription>
              </div>
              <Button size="sm" variant="outline" onClick={exportCsv}>导出 CSV</Button>
            </CardHeader>
            <CardContent>
              {trendSpec ? <div className="h-72"><ChartLazy spec={trendSpec} /></div> : <div className="flex h-72 items-center justify-center text-muted-foreground">区间内无数据</div>}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">模型构成</CardTitle>
              <CardDescription>按模型费用(¥)</CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>模型</TableHead>
                    <TableHead className="text-right">请求数</TableHead>
                    <TableHead className="text-right">tokens</TableHead>
                    <TableHead className="text-right">费用</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {models.map((r) => (
                    <TableRow key={r.label}>
                      <TableCell>{r.label}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.requests}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtTokens(chatTokens(r))}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtY(r.cost ?? 0)}</TableCell>
                    </TableRow>
                  ))}
                  {models.length === 0 && <TableRow><TableCell colSpan={4} className="text-center text-muted-foreground">无数据</TableCell></TableRow>}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">最近请求</CardTitle>
          <CardDescription>最新 5 条调用记录(点开「请求日志」查看全部)</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>时间</TableHead>
                <TableHead>模型</TableHead>
                <TableHead>类型</TableHead>
                <TableHead className="text-right">输入</TableHead>
                <TableHead className="text-right">输出</TableHead>
                <TableHead className="text-right">费用</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {requests.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="tabular-nums">{r.time.replace('T', ' ').slice(0, 19)}</TableCell>
                  <TableCell>{r.model}</TableCell>
                  <TableCell><Badge variant="outline">{r.kind}</Badge></TableCell>
                  <TableCell className="text-right tabular-nums">{fmtTokens(r.prompt_tokens)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtTokens(r.completion_tokens)}</TableCell>
                  <TableCell className="text-right tabular-nums" title={fmtMoney(r.cost)}>{fmtY(r.cost)}</TableCell>
                </TableRow>
              ))}
              {requests.length === 0 && <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground">无数据</TableCell></TableRow>}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
