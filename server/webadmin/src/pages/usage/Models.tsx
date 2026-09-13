import { useCallback, useEffect, useRef, useState } from 'react'
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
import { PERM_GATEWAY_READ, hasPermission } from '../../lib/rbac'
// 模型分析:模型明细(含单价) + 金额占比 + 渠道消耗
//
// 审计 R7 残余(R7-RV-1):本页只要求 usage:read,但首屏原来用 Promise.all 把
// GET /models(要 gateway:read,见 internal/router/router.go:285)和两个用量
// 请求绑在一起 —— auditor(有 usage:read、没有 gateway:read)打开本页时一个
// 403 把整页打掉,连它有权读的模型/渠道用量行也一起消失,只剩一句错误。
// 修法与 branding-3 已修的两条路径同口径:**前端不请求**注定 403 的接口,
// 用量数据照常渲染,并把"单价/模型名需要 gateway:read"讲清楚;不动 rbac.go
// (auditor 的最小权限三元组是刻意设计,PermReportRead 同样被刻意排除)。
export default function UsageModels() {
  const init = defaultRange()
  const [from, setFrom] = useState(init.from)
  const [to, setTo] = useState(init.to)
  const [rows, setRows] = useState<UsageRow[]>([])
  const [providers, setProviders] = useState<UsageRow[]>([])
  const [models, setModels] = useState<ModelInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  // P2-46: 请求序号防乱序——快速切换区间时只有最新请求的响应能写 state。
  const loadSeq = useRef(0)
  // 模型目录(名称/单价)是网关配置面:没有 gateway:read 就不发这个必然 403 的请求。
  const canReadGateway = hasPermission(PERM_GATEWAY_READ)

  const load = useCallback(async (f: string, t: string) => {
    const current = ++loadSeq.current
    setLoading(true)
    setError('')
    try {
      const [mr, pr, ml] = await Promise.all([
        fetchUsageList({ group: 'model', from: f, to: t }),
        fetchUsageList({ group: 'provider', from: f, to: t }),
        canReadGateway
          ? request<{ models: ModelInfo[] }>(`${ADMIN_API}/models`)
          : Promise.resolve({ models: [] as ModelInfo[] }),
      ])
      if (current !== loadSeq.current) return // P2-46: 过期响应丢弃
      setRows(mr)
      setProviders(pr)
      setModels((ml.models ?? []).slice().sort((a, b) => (a.name < b.name ? -1 : 1)))
    } catch (e: any) {
      if (current !== loadSeq.current) return // P2-46: 过期响应不写错误
      setError(e.message || '查询失败')
    } finally {
      if (current === loadSeq.current) setLoading(false)
    }
  }, [canReadGateway])

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
      <RangeFilter from={from} to={to} setFrom={setFrom} setTo={setTo} onQuery={(f, t) => void load(f, t)} />
      {error && <div className="text-sm text-destructive">{error}</div>}
      {!canReadGateway && (
        // 服务端:GET /models(网关模型目录)要 gateway:read,本页主体(用量)
        // 只要 usage:read —— 只读角色在这里必须看到"能看什么、为什么没有单价",
        // 而不是整页 403 或一排空荡荡的 "—"。
        <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          当前账号没有网关配置读取权限(gateway:read):模型消耗、费用与渠道分布照常显示,但模型目录与单价不可见(单价列显示「—」,不代表免费)。
        </div>
      )}

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

      {canReadGateway && (!models.some((m) => isModelPriced(m))) && rows.length > 0 && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          存在未配置价格的模型:其费用按 0 计,金额口径可能被低估(在网关「模型管理」中配置单价)。
        </div>
      )}
    </div>
  )
}
