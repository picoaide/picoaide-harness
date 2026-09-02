import { useCallback, useEffect, useState } from 'react'
import type { ISpec } from '@visactor/vchart'
import { ChartLazy } from '../../components/chart-lazy'
import { request, ADMIN_API } from '../../api'
import { Button } from '../../components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card'
import { Skeleton } from '../../components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table'
import { PageHeader } from '../../components/page-header'
import { RangeFilter, defaultRange, fetchUsageList, chatTokens, sumRows, downloadCsv, fmtY, type UsageRow, type ModelInfo } from './common'
import { fmtTokens, isModelPriced } from '../../lib/format'
// 模型分析:模型明细(含单价) + 金额占比 + 渠道消耗
export default function UsageModels() {
  const init = defaultRange()
  const [from, setFrom] = useState(init.from)
  const [to, setTo] = useState(init.to)
  const [rows, setRows] = useState<UsageRow[]>([])
  const [providers, setProviders] = useState<UsageRow[]>([])
  const [models, setModels] = useState<ModelInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async (f: string, t: string) => {
    setLoading(true)
    setError('')
    try {
      const [mr, pr, ml] = await Promise.all([
        fetchUsageList({ group: 'model', from: f, to: t }),
        fetchUsageList({ group: 'provider', from: f, to: t }),
        request<{ models: ModelInfo[] }>(`${ADMIN_API}/models`),
      ])
      setRows(mr)
      setProviders(pr)
      setModels((ml.models ?? []).slice().sort((a, b) => (a.name < b.name ? -1 : 1)))
    } catch (e: any) {
      setError(e.message || '查询失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load(from, to) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const priceOf = (name: string) => models.find((m) => m.name === name)
  const s = sumRows(rows)

  const pieSpec: ISpec | null = rows.length > 0 ? {
    type: 'pie',
    data: { values: rows.map((r) => ({ name: r.label, value: Number((r.cost ?? 0).toFixed(4)) })) },
    categoryField: 'name',
    valueField: 'value',
    outerRadius: 0.8,
    label: { visible: true },
    tooltip: { visible: true },
  } : null

  const exportCsv = () => {
    downloadCsv(`models_${from}_${to}.csv`,
      ['模型', '请求数', '输入tokens', '输出tokens', '缓存tokens', '合计tokens(chat)', '费用(¥)'],
      rows.map((r) => [r.label, r.requests, r.prompt_tokens, r.completion_tokens, r.cache_tokens ?? 0, chatTokens(r), (r.cost ?? 0).toFixed(4)]))
  }

  return (
    <div className="space-y-6">
      <PageHeader title="模型分析" desc="哪些模型消耗了多少：单价、tokens、费用占比与渠道分布" />
      <RangeFilter from={from} to={to} setFrom={setFrom} setTo={setTo} onQuery={() => void load(from, to)} />
      {error && <div className="text-sm text-destructive">{error}</div>}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle className="text-base">模型明细</CardTitle>
              <CardDescription>合计 {fmtY(s.cost)} · {fmtTokens(s.tokens)} tokens(chat)</CardDescription>
            </div>
            <Button size="sm" variant="outline" onClick={exportCsv}>导出 CSV</Button>
          </CardHeader>
          <CardContent>
            {loading ? <Skeleton className="h-80 w-full" /> : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>模型</TableHead>
                    <TableHead className="text-right">单价(¥/1M)</TableHead>
                    <TableHead className="text-right">请求</TableHead>
                    <TableHead className="text-right">输入</TableHead>
                    <TableHead className="text-right">输出</TableHead>
                    <TableHead className="text-right">缓存</TableHead>
                    <TableHead className="text-right">费用</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => {
                    const m = priceOf(r.label)
                    const priced = isModelPriced(m)
                    return (
                      <TableRow key={r.label}>
                        <TableCell className="font-medium">{r.label}</TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {m ? (priced ? `${(m.input_price_per_1m ?? 0).toFixed(2)} / ${(m.output_price_per_1m ?? 0).toFixed(2)}` : '未定价') : '—'}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{r.requests}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtTokens(r.prompt_tokens)}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtTokens(r.completion_tokens)}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtTokens(r.cache_tokens ?? 0)}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtY(r.cost ?? 0)}</TableCell>
                      </TableRow>
                    )
                  })}
                  {rows.length === 0 && <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground">暂无数据</TableCell></TableRow>}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">金额占比</CardTitle>
            <CardDescription>模型费用构成(¥)</CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? <Skeleton className="h-60 w-full" /> : pieSpec ? <div className="h-60"><ChartLazy spec={pieSpec} /></div> : <div className="flex h-60 items-center justify-center text-muted-foreground">暂无数据</div>}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">渠道消耗</CardTitle>
          <CardDescription>按上游渠道(provider)归并· 同名模型多渠道时为近似归并</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? <Skeleton className="h-40 w-full" /> : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>渠道</TableHead>
                  <TableHead className="text-right">请求</TableHead>
                  <TableHead className="text-right">tokens</TableHead>
                  <TableHead className="text-right">费用</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {providers.map((r) => (
                  <TableRow key={r.label}>
                    <TableCell className="font-medium">{r.label}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.requests}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtTokens(chatTokens(r))}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtY(r.cost ?? 0)}</TableCell>
                  </TableRow>
                ))}
                {providers.length === 0 && <TableRow><TableCell colSpan={4} className="text-center text-muted-foreground">暂无数据</TableCell></TableRow>}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {(!models.some((m) => isModelPriced(m))) && rows.length > 0 && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          存在未配置价格的模型:其费用按 0 计,金额口径可能被低估(在网关「模型管理」中配置单价)。
        </div>
      )}
    </div>
  )
}
