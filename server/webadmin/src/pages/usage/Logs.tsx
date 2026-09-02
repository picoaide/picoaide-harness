import { useCallback, useEffect, useState } from 'react'
import { request, ADMIN_API } from '../../api'
import { Button } from '../../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'
import { Badge } from '../../components/ui/badge'
import { Skeleton } from '../../components/ui/skeleton'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table'
import { PageHeader } from '../../components/page-header'
import { rangePreset, fmtTokens } from '../../lib/format'
import { fetchUsageList, sumRows, downloadCsv, fmtY, type UsageRequestRow } from './common'

const SIZE = 20
const KINDS = [
  { value: '', label: '全部类型' },
  { value: 'chat', label: 'chat' },
  { value: 'embedding', label: 'embedding' },
  { value: 'search', label: 'search' },
]

// 请求日志:统计徽标 + 多条件过滤 + 明细分页 + 导出(对齐 new-api 日志页)
export default function UsageLogs() {
  const init = rangePreset(7)
  const [from, setFrom] = useState(init.from)
  const [to, setTo] = useState(init.to)
  const [username, setUsername] = useState('')
  const [model, setModel] = useState('')
  const [kind, setKind] = useState('')
  const [page, setPage] = useState(1)
  const [rows, setRows] = useState<UsageRequestRow[]>([])
  const [total, setTotal] = useState(0)
  const [stats, setStats] = useState<{ cost: number; tokens: number; requests: number } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async (p: number) => {
    setLoading(true)
    setError('')
    try {
      const qs = new URLSearchParams({ from, to, page: String(p), size: String(SIZE) })
      if (username) qs.set('username', username)
      if (model) qs.set('model', model)
      if (kind) qs.set('kind', kind)
      const d = await request<{ rows: UsageRequestRow[]; total: number }>(`${ADMIN_API}/usage/requests?${qs}`)
      setRows(d.rows ?? [])
      setTotal(d.total ?? 0)
      // 统计徽标:区间聚合(与过滤条件一致)
      const agg: any = await fetchUsageList({ group: 'day', from, to, ...(username ? { username } : {}) })
      const s = sumRows(agg)
      setStats({ cost: s.cost, tokens: s.tokens, requests: s.requests })
    } catch (e: any) {
      setError(e.message || '查询失败')
    } finally {
      setLoading(false)
    }
  }, [from, to, username, model, kind])

  useEffect(() => { void load(1) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const pages = Math.max(1, Math.ceil(total / SIZE))

  const exportCsv = async () => {
    // 导出当前过滤全量(上限 50 页 = 5000 行,防爆炸)
    const all: UsageRequestRow[] = []
    for (let p = 1; p <= Math.min(50, pages); p++) {
      const qs = new URLSearchParams({ from, to, page: String(p), size: '100' })
      if (username) qs.set('username', username)
      if (model) qs.set('model', model)
      if (kind) qs.set('kind', kind)
      const d = await request<{ rows: UsageRequestRow[] }>(`${ADMIN_API}/usage/requests?${qs}`)
      all.push(...(d.rows ?? []))
      if ((d.rows ?? []).length < 100) break
    }
    downloadCsv(`usage_logs_${from}_${to}.csv`,
      ['时间', '用户', '模型', '类型', '输入tokens', '输出tokens', '缓存tokens', '费用(¥)'],
      all.map((r) => [r.time, r.username, r.model, r.kind, r.prompt_tokens, r.completion_tokens, r.cache_tokens, (r.cost ?? 0).toFixed(4)]))
  }

  return (
    <div className="space-y-6">
      <PageHeader title="请求日志" desc="每次模型调用的计量记录(不含对话内容)· 默认近 7 天,最长 90 天" />

      {/* 统计徽标(new-api CommonLogsStats 式) */}
      <div className="flex flex-wrap items-center gap-3">
        <Badge variant="secondary">区间请求 {stats ? stats.requests.toLocaleString() : '…'}</Badge>
        <Badge variant="secondary">区间消耗 {stats ? fmtY(stats.cost) : '…'}</Badge>
        <Badge variant="outline">平均每请求 {stats && stats.requests > 0 ? fmtY(stats.cost / stats.requests) : '—'}</Badge>
        <Badge variant="outline">区间 tokens {stats ? fmtTokens(stats.tokens) : '…'}</Badge>
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">过滤条件</CardTitle>
          <Button size="sm" variant="outline" onClick={() => void load(1)} disabled={loading}>查询</Button>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <div>
            <Label className="mb-1 block text-sm text-muted-foreground" htmlFor="lg-from">起始日期</Label>
            <Input id="lg-from" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <Label className="mb-1 block text-sm text-muted-foreground" htmlFor="lg-to">结束日期</Label>
            <Input id="lg-to" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div>
            <Label className="mb-1 block text-sm text-muted-foreground" htmlFor="lg-user">用户名</Label>
            <Input id="lg-user" placeholder="精确用户名" value={username} onChange={(e) => setUsername(e.target.value)} className="w-40" />
          </div>
          <div>
            <Label className="mb-1 block text-sm text-muted-foreground" htmlFor="lg-model">模型</Label>
            <Input id="lg-model" placeholder="精确模型名" value={model} onChange={(e) => setModel(e.target.value)} className="w-40" />
          </div>
          <div>
            <Label className="mb-1 block text-sm text-muted-foreground">类型</Label>
            <Select value={kind} onValueChange={(v) => setKind(v)}>
              <SelectTrigger className="w-32" aria-label="请求类型"><SelectValue /></SelectTrigger>
              <SelectContent>
                {KINDS.map((k) => <SelectItem key={k.value} value={k.value}>{k.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">明细</CardTitle>
          <Button size="sm" variant="outline" onClick={() => void exportCsv()} disabled={total === 0}>导出 CSV</Button>
        </CardHeader>
        <CardContent>
          {error && <div className="mb-2 text-sm text-destructive">{error}</div>}
          {loading ? <Skeleton className="h-80 w-full" /> : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>时间</TableHead>
                    <TableHead>用户</TableHead>
                    <TableHead>模型</TableHead>
                    <TableHead>类型</TableHead>
                    <TableHead className="text-right">输入</TableHead>
                    <TableHead className="text-right">输出</TableHead>
                    <TableHead className="text-right">缓存</TableHead>
                    <TableHead className="text-right">费用</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="tabular-nums">{r.time.replace('T', ' ').slice(0, 19)}</TableCell>
                      <TableCell>{r.username || `#${r.user_id}`}</TableCell>
                      <TableCell>{r.model}</TableCell>
                      <TableCell><Badge variant="outline">{r.kind}</Badge></TableCell>
                      <TableCell className="text-right tabular-nums">{fmtTokens(r.prompt_tokens)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtTokens(r.completion_tokens)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtTokens(r.cache_tokens)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtY(r.cost)}</TableCell>
                    </TableRow>
                  ))}
                  {rows.length === 0 && <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground">暂无数据</TableCell></TableRow>}
                </TableBody>
              </Table>
              {/* 分页 */}
              <div className="mt-3 flex items-center justify-between text-sm text-muted-foreground">
                <span>共 {total} 条 · 第 {page} / {pages} 页</span>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => { setPage(page - 1); void load(page - 1) }}>上一页</Button>
                  <Button size="sm" variant="outline" disabled={page >= pages} onClick={() => { setPage(page + 1); void load(page + 1) }}>下一页</Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
