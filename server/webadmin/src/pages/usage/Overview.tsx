import { useCallback, useEffect, useState } from 'react'
import type { ISpec } from '@visactor/vchart'
import { ChartLazy } from '../../components/chart-lazy'
import { request, ADMIN_API } from '../../api'
import { Button } from '../../components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card'
import { Badge } from '../../components/ui/badge'
import { Skeleton } from '../../components/ui/skeleton'
import { PageHeader } from '../../components/page-header'
import { CircleDollarSign, Activity, Coins, Wallet, RefreshCw, Landmark } from 'lucide-react'
import { RangeFilter, defaultRange, sumRows, fmtY, type OverviewData, type ProviderInfo, type ProviderBalance } from './common'
import { fmtTokens, fmtFull } from '../../lib/format'

// 总览(主页面):企业整体消耗——渠道余额 + KPI + 近30天消耗趋势 + 模型 TOP10
export default function UsageOverview() {
  const init = defaultRange()
  const [from, setFrom] = useState(init.from)
  const [to, setTo] = useState(init.to)
  const [data, setData] = useState<OverviewData | null>(null)
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [balances, setBalances] = useState<Record<number, ProviderBalance | 'loading' | 'error'>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const loadOverview = useCallback(async (f: string, t: string) => {
    setLoading(true)
    setError('')
    try {
      const d = await request<OverviewData>(`${ADMIN_API}/usage/overview?from=${f}&to=${t}`)
      setData(d)
    } catch (e: any) {
      setError(e.message || '查询失败')
    } finally {
      setLoading(false)
    }
  }, [])

  const loadBalance = useCallback(async (id: number) => {
    setBalances((prev) => ({ ...prev, [id]: 'loading' }))
    try {
      const b = await request<ProviderBalance>(`${ADMIN_API}/providers/${id}/balance`)
      setBalances((prev) => ({ ...prev, [id]: b }))
    } catch {
      setBalances((prev) => ({ ...prev, [id]: 'error' }))
    }
  }, [])

  const load = useCallback(async (f: string, t: string) => {
    await loadOverview(f, t)
    try {
      const pl = await request<{ providers: ProviderInfo[] }>(`${ADMIN_API}/providers`)
      const list = (pl.providers ?? []) as ProviderInfo[]
      setProviders(list)
      setBalances({})
      list.forEach((p) => void loadBalance(p.id))
    } catch { /* 渠道余额失败不阻塞总览 */ }
  }, [loadOverview, loadBalance])

  useEffect(() => { void load(from, to) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const rangeSum = data ? sumRows(data.trend) : null
  const topSum = data ? sumRows(data.top_models) : null

  const kpis = data ? [
    { title: '本月消耗', value: fmtY(data.month.cost), desc: `本月请求 ${data.month.requests.toLocaleString()}`, icon: Wallet },
    { title: '今日消耗', value: fmtY(data.today.cost), desc: `今日请求 ${data.today.requests.toLocaleString()}`, icon: Activity },
    { title: '区间消耗', value: fmtY(rangeSum!.cost), desc: `${from} ~ ${to}`, icon: CircleDollarSign },
    { title: '区间请求', value: rangeSum!.requests.toLocaleString(), desc: `平均每请求 ${rangeSum!.requests > 0 ? fmtY(rangeSum!.cost / rangeSum!.requests) : '—'}`, icon: Coins },
    { title: '区间 tokens', value: fmtTokens(rangeSum!.tokens), desc: `chat 输入+输出,不含 embedding`, icon: Landmark },
  ] : []

  const trendSpec: ISpec | null = data && data.trend.length > 0 ? {
    type: 'bar',
    data: { values: data.trend.map((r) => ({ label: r.label.slice(5), cost: Number((r.cost ?? 0).toFixed(4)) })) },
    xField: 'label',
    yField: 'cost',
    axes: [
      { orient: 'left', label: { visible: true, style: { fontSize: 11 } } },
      { orient: 'bottom', label: { visible: true, style: { fontSize: 10 } }, title: { visible: true, text: '日期' } },
    ],
    tooltip: { visible: true },
  } : null

  const topSpec: ISpec | null = data && data.top_models.length > 0 ? {
    type: 'bar',
    data: { values: data.top_models.map((r) => ({ label: r.label, cost: Number((r.cost ?? 0).toFixed(4)) })) },
    xField: 'label',
    yField: 'cost',
    axes: [
      { orient: 'left', label: { visible: true, style: { fontSize: 11 } } },
      { orient: 'bottom', title: { visible: true, text: '费用(¥)' }, label: { formatMethod: (v: unknown) => fmtY(Number(v)).replace('¥', '') } },
    ],
    tooltip: { visible: true },
  } : null

  return (
    <div className="space-y-6">
      <PageHeader title="用量总览" desc="企业整体消耗：渠道余额 / 本月、今日、区间费用 / 消耗趋势 / 模型排行" />

      <RangeFilter from={from} to={to} setFrom={setFrom} setTo={setTo} onQuery={() => void load(from, to)} />

      {error && <div className="text-sm text-destructive">{error}</div>}

      {/* 渠道余额卡:账户级信息(DeepSeek 原生 /user/balance;其余渠道置灰说明) */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">渠道余额</CardTitle>
          <Button size="sm" variant="outline" onClick={() => providers.forEach((p) => void loadBalance(p.id))}>
            <RefreshCw className="h-3.5 w-3.5" /> 刷新
          </Button>
        </CardHeader>
        <CardContent>
          {providers.length === 0 ? (
            <div className="text-sm text-muted-foreground">未配置上游渠道</div>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {providers.map((p) => {
                const b = balances[p.id]
                const balance = b && b !== 'loading' && b !== 'error' ? b : null
                const info = balance?.infos?.[0]
                return (
                  <div key={p.id} className="space-y-1.5 rounded-md border p-3">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium">{p.name}</span>
                      <Badge variant="outline">{p.enabled ? '启用' : '禁用'}</Badge>
                    </div>
                    {b === 'loading' ? (
                      <Skeleton className="h-7 w-36" />
                    ) : balance?.supported === false ? (
                      <div className="text-xs text-muted-foreground">该服务商不开放余额查询</div>
                    ) : balance?.error ? (
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-destructive">{balance.error}</span>
                        <Button size="sm" variant="outline" onClick={() => void loadBalance(p.id)}>重试</Button>
                      </div>
                    ) : info ? (
                      <>
                        <div className="flex items-baseline gap-2">
                          <span className="font-mono text-xl font-bold tabular-nums">{info.total_balance}</span>
                          <span className="text-xs text-muted-foreground">{info.currency}</span>
                          <Badge variant={balance?.is_available ? 'secondary' : 'destructive'}>
                            {balance?.is_available ? '可调用' : '余额不足'}
                          </Badge>
                        </div>
                        <div className="flex gap-3 text-[11px] text-muted-foreground">
                          <span>赠金 {info.granted_balance}</span>
                          <span>充值 {info.topped_up_balance}</span>
                          <span>{balance?.fetched_at?.slice(11, 16)}</span>
                        </div>
                      </>
                    ) : (
                      <div className="text-xs text-muted-foreground">余额查询失败</div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* KPI 行:金额为第一指标 */}
      <div data-testid="overview-kpis" className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        {kpis.map((c) => (
          <Card key={c.title}>
            <CardContent className="flex h-full flex-col pt-5">
              <div className="flex shrink-0 items-center gap-2">
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[#1E40AF]/10 text-[#1E40AF]">
                  <c.icon className="h-3.5 w-3.5" />
                </div>
                <span className="whitespace-nowrap text-[13px] leading-tight text-muted-foreground">{c.title}</span>
              </div>
              <div className="mt-2.5 flex h-8 shrink-0 items-center">
                {loading ? <Skeleton className="h-7 w-24" /> : <div className="font-mono text-[22px] font-bold leading-tight tabular-nums tracking-tight text-slate-800">{c.value}</div>}
              </div>
              <div className="mt-1.5 flex-1 text-[11px] leading-relaxed text-muted-foreground">{c.desc}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* 消耗趋势 + 模型 TOP */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">消耗趋势</CardTitle>
            <CardDescription>按天费用(¥)· {from} ~ {to}{rangeSum ? ` · 合计 ${fmtY(rangeSum.cost)}` : ''}</CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? <Skeleton className="h-72 w-full" /> : trendSpec ? <div className="h-72"><ChartLazy spec={trendSpec} /></div> : <div className="flex h-72 items-center justify-center text-muted-foreground">暂无数据</div>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">模型消耗 TOP 10</CardTitle>
            <CardDescription>按费用(¥)· 点击可查看全部分析{topSum ? ` · TOP10 合计 ${fmtY(topSum.cost)}` : ''}</CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? <Skeleton className="h-72 w-full" /> : topSpec ? <div className="h-72"><ChartLazy spec={topSpec} /></div> : <div className="flex h-72 items-center justify-center text-muted-foreground">暂无数据</div>}
          </CardContent>
        </Card>
      </div>

      <div className="text-[11px] text-muted-foreground">
        费用口径:按模型定价折算(未定价模型计 0),含 embedding;与配额 enforcement 同口径。
        区间消耗合计 {rangeSum ? fmtY(rangeSum.cost) : '—'} ({fmtFull(rangeSum?.tokens ?? 0)} tokens)。
      </div>
    </div>
  )
}
