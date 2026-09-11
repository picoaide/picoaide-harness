import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ISpec } from '@visactor/vchart'
import { ChartLazy } from '../../components/chart-lazy'
import { request, ADMIN_API } from '../../api'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card'
import { Badge } from '../../components/ui/badge'
import { Skeleton } from '../../components/ui/skeleton'
import { Button } from '../../components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table'
import { PageHeader } from '../../components/page-header'
import { RangeFilter, defaultRange, fetchUsageList, chatTokens, downloadCsv, fmtY, type UsageRow, type DeptInfo } from './common'
import { fmtTokens } from '../../lib/format'
import { cn } from '../../lib/utils'

// 部门用量:部门树总表(费用/成员) + 选中部门详情(趋势/成员排行/模型拆分)
export default function UsageDepartments() {
  const init = defaultRange()
  const [from, setFrom] = useState(init.from)
  const [to, setTo] = useState(init.to)
  const [depts, setDepts] = useState<DeptInfo[]>([])
  const [deptRows, setDeptRows] = useState<UsageRow[]>([])
  const [selected, setSelected] = useState<string>('')
  const [detail, setDetail] = useState<{ trend: UsageRow[]; members: UsageRow[]; models: UsageRow[] } | null>(null)
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')
  const [error, setError] = useState('')
  // P2-46: 请求序号防乱序——快速切换区间时只有最新请求的响应能写 state。
  const loadSeq = useRef(0)

  const load = useCallback(async (f: string, t: string) => {
    const current = ++loadSeq.current
    setLoading(true)
    setError('')
    try {
      const [d, rows] = await Promise.all([
        request<{ departments: DeptInfo[] }>(`${ADMIN_API}/departments`),
        fetchUsageList({ group: 'dept', from: f, to: t }),
      ])
      if (current !== loadSeq.current) return // P2-46: 过期响应丢弃
      setDepts(d.departments ?? [])
      setDeptRows(rows)
    } catch (e: any) {
      if (current !== loadSeq.current) return // P2-46: 过期响应不写错误
      setError(e.message || '查询失败')
    } finally {
      if (current === loadSeq.current) setLoading(false)
    }
  }, [])

  useEffect(() => { void load(from, to) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // 部门树深度(缩进)
  const depth = useMemo(() => {
    const m = new Map<number, number>()
    const byId = new Map(depts.map((d) => [d.id, d]))
    for (const d of depts) {
      let p = d.parent_id
      let n = 0
      while (p !== 0 && byId.has(p)) {
        n += 1
        p = byId.get(p)!.parent_id
      }
      m.set(d.id, n)
    }
    return m
  }, [depts])

  const rowOf = useMemo(() => {
    const m = new Map<string, UsageRow>()
    for (const r of deptRows) m.set(r.label, r)
    return m
  }, [deptRows])

  const openDetail = useCallback(async (name: string) => {
    setSelected(name)
    setDetailLoading(true)
    setDetail(null)
    setDetailError('')
    try {
      const [trend, members, models] = await Promise.all([
        fetchUsageList({ group: 'day', dept: name, from, to }),
        fetchUsageList({ group: 'user', dept: name, from, to }),
        fetchUsageList({ group: 'model', dept: name, from, to }),
      ])
      setDetail({ trend, members: members.slice(0, 10), models })
    } catch (e: any) {
      // P3: 原来静默 catch → 点击部门后空白无提示,用户以为「没有数据」。
      setDetail(null)
      setDetailError(e?.message || '部门明细查询失败')
    } finally {
      setDetailLoading(false)
    }
  }, [from, to])

  const trendSpec: ISpec | null = detail && detail.trend.length > 0 ? {
    type: 'line',
    data: { values: detail.trend.map((r) => ({ label: r.label.slice(5), cost: Number((r.cost ?? 0).toFixed(4)) })) },
    xField: 'label',
    yField: 'cost',
    point: { visible: true },
    axes: [
      { orient: 'left', title: { visible: true, text: '费用(¥)' }, label: { visible: true, style: { fontSize: 11 } } },
      { orient: 'bottom', label: { visible: true, style: { fontSize: 10 } } },
    ],
    tooltip: { visible: true },
  } : null

  const exportDept = () => {
    if (!selected) return
    const rows = detail?.members ?? []
    downloadCsv(`dept_${selected}_${from}_${to}.csv`,
      ['成员', '请求数', '输入tokens', '输出tokens', 'chat合计tokens', '费用(¥)'],
      rows.map((r) => [r.label, r.requests, r.prompt_tokens, r.completion_tokens, chatTokens(r), (r.cost ?? 0).toFixed(4)]))
  }

  return (
    <div className="space-y-6">
      <PageHeader title="部门用量" desc="按部门维度查看消耗:本月/区间费用、成员排行、模型拆分" />
      <RangeFilter from={from} to={to} setFrom={setFrom} setTo={setTo} onQuery={() => void load(from, to)} />
      {error && <div className="text-sm text-destructive">{error}</div>}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">部门列表</CardTitle>
            <CardDescription>费用为所选区间口径(默认近 30 天)</CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? <Skeleton className="h-80 w-full" /> : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>部门</TableHead>
                    <TableHead className="text-right">区间费用</TableHead>
                    <TableHead className="text-right">成员</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {depts.map((d) => {
                    const rangeCost = rowOf.get(d.name)?.cost ?? 0
                    return (
                      <TableRow
                        key={d.id}
                        className={cn('cursor-pointer', selected === d.name && 'bg-accent')}
                        onClick={() => void openDetail(d.name)}
                      >
                        <TableCell>
                          <span style={{ paddingLeft: `${(depth.get(d.id) ?? 0) * 14}px` }} className="font-medium">{d.name}</span>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{fmtY(rangeCost)}</TableCell>
                        <TableCell className="text-right tabular-nums">{d.member_count}</TableCell>
                      </TableRow>
                    )
                  })}
                  {depts.length === 0 && <TableRow><TableCell colSpan={3} className="text-center text-muted-foreground">暂无部门</TableCell></TableRow>}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle className="text-base">{selected ? `${selected} · 部门详情` : '部门详情'}</CardTitle>
              <CardDescription>{selected ? `${from} ~ ${to}` : '点击左侧部门查看'}</CardDescription>
            </div>
            {selected && <Button size="sm" variant="outline" onClick={exportDept}>导出 CSV</Button>}
          </CardHeader>
          <CardContent>
            {detailLoading ? (
              <Skeleton className="h-72 w-full" />
            ) : detailError !== '' ? (
              <div className="flex h-72 items-center justify-center text-sm text-destructive">{detailError}</div>
            ) : !selected ? (
              <div className="flex h-72 items-center justify-center text-muted-foreground">选择部门查看消耗明细</div>
            ) : detail ? (
              <div className="space-y-5">
                <div className="h-56">
                  {trendSpec ? <ChartLazy spec={trendSpec} /> : <div className="flex h-56 items-center justify-center text-muted-foreground">区间内无数据</div>}
                </div>
                <div>
                  <div className="mb-2 text-sm font-medium">成员消费排行</div>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>成员</TableHead>
                        <TableHead className="text-right">请求数</TableHead>
                        <TableHead className="text-right">tokens</TableHead>
                        <TableHead className="text-right">费用(¥)</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {detail.members.map((r) => (
                        <TableRow key={r.label}>
                          <TableCell>{r.label}</TableCell>
                          <TableCell className="text-right tabular-nums">{r.requests}</TableCell>
                          <TableCell className="text-right tabular-nums">{fmtTokens(chatTokens(r))}</TableCell>
                          <TableCell className="text-right tabular-nums">{fmtY(r.cost ?? 0)}</TableCell>
                        </TableRow>
                      ))}
                      {detail.members.length === 0 && <TableRow><TableCell colSpan={3} className="text-center text-muted-foreground">无数据</TableCell></TableRow>}
                    </TableBody>
                  </Table>
                </div>
                <div>
                  <div className="mb-2 text-sm font-medium">模型花费</div>
                  <div className="flex flex-wrap gap-2">
                    {detail.models.slice(0, 5).map((r) => (
                      <Badge key={r.label} variant="secondary">{r.label} {fmtY(r.cost ?? 0)}</Badge>
                    ))}
                    {detail.models.length === 0 && <span className="text-sm text-muted-foreground">无数据</span>}
                  </div>
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
