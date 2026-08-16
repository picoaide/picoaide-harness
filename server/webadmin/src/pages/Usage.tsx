import { useCallback, useEffect, useState } from 'react'
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid,
} from 'recharts'
import { request } from '../api'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table'

interface UsageRow {
  label: string
  prompt_tokens: number
  completion_tokens: number
  requests: number
}

export default function Usage() {
  const [group, setGroup] = useState<'day' | 'model' | 'user'>('day')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [rows, setRows] = useState<UsageRow[]>([])
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ group })
      if (from) params.set('from', from)
      if (to) params.set('to', to)
      const data = await request(`/api/admin/usage?${params}`)
      setRows(data.rows ?? [])
      setError('')
    } catch (err: any) {
      setError(err.message)
    }
  }, [group])

  // 只在分组变化或点击"查询"时加载,避免每次击键/改日期都发请求
  useEffect(() => { load() }, [load])

  const chartData = rows.map((r) => ({ name: r.label, tokens: r.prompt_tokens + r.completion_tokens, requests: r.requests }))

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">用量统计</h1>
      {error && <div className="text-sm text-destructive">{error}</div>}
      <div className="flex items-end gap-3">
        <div>
          <div className="mb-1 text-sm text-muted-foreground">分组</div>
          <Select value={group} onValueChange={(v) => setGroup(v as any)}>
            <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="day">按日</SelectItem>
              <SelectItem value="model">按模型</SelectItem>
              <SelectItem value="user">按用户</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <div className="mb-1 text-sm text-muted-foreground">起始日期</div>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div>
          <div className="mb-1 text-sm text-muted-foreground">结束日期</div>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <Button onClick={load}>查询</Button>
      </div>

      <div className="h-64 rounded-xl border p-4">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="name" />
            <YAxis />
            <Tooltip />
            <Bar dataKey="tokens" name="tokens" fill="hsl(222.2 47.4% 11.2%)" />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{group === 'day' ? '日期' : group === 'model' ? '模型' : '用户 ID'}</TableHead>
            <TableHead>请求数</TableHead>
            <TableHead>输入 tokens</TableHead>
            <TableHead>输出 tokens</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.label}>
              <TableCell>{r.label}</TableCell>
              <TableCell>{r.requests}</TableCell>
              <TableCell>{r.prompt_tokens}</TableCell>
              <TableCell>{r.completion_tokens}</TableCell>
            </TableRow>
          ))}
          {rows.length === 0 && (
            <TableRow><TableCell colSpan={4} className="text-center text-muted-foreground">暂无数据</TableCell></TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  )
}
