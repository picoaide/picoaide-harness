import { useCallback, useEffect, useRef, useState } from 'react'
import { request, ADMIN_API } from '../api'
import { Button } from '../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card'
import { Badge } from '../components/ui/badge'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Skeleton } from '../components/ui/skeleton'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table'
import { PageHeader } from '../components/page-header'

const SIZE = 20

/** 字节数渲染（二进制单位，保留一位小数）。 */
function fmtBytes(n: number): string {
  if (!n || n <= 0) return '0 B'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`
}

interface FileRow {
  file_id: string
  user_id: number
  username: string
  display_name: string
  size_bytes: number
  created_at: string
  expires_at: string | null
  expired: boolean
}

interface SummaryRow {
  user_id: number
  username: string
  display_name: string
  files: number
  bytes: number
  expired_files: number
  earliest_expires_at: string | null
}

interface Totals {
  files: number
  bytes: number
  expired: number
}

/** 时间戳渲染:空值给「永久」（无过期时间的文件）。 */
function fmtTime(v: string | null): string {
  if (!v) return '永久'
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return v
  return d.toLocaleString('zh-CN', { hour12: false })
}

/**
 * 网关文件台账（2026-09-22）。
 *
 * 需求：上游 Files 配额是**每 API key**（全组织共享 25 GiB / 10000 文件），而保留上限
 * 由平台收敛（`gateway.file_expiry_days`，缺省 7 天）。本页给管理员一个"按员工看占用、
 * 搜索、排序、按条件清理"的工具；服务端另有 5 分钟一轮的自动回收。
 *
 * 两个刻意的产品约束：
 *   1. 批量清理**必须带条件**（员工或状态）——空条件等于"清空全公司台账"，
 *      服务端会 400，前端也不给这个按钮的可用状态；
 *   2. "清理仍然有效的文件"是危险动作：只在显式选择「全部状态」时才允许，
 *      并要求二次确认里输入确认词，避免误点。
 */
export default function GatewayFiles() {
  const [rows, setRows] = useState<FileRow[]>([])
  const [summary, setSummary] = useState<SummaryRow[]>([])
  const [totals, setTotals] = useState<Totals | null>(null)
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [user, setUser] = useState('')
  const [q, setQ] = useState('')
  const [state, setState] = useState('all')
  const [sort, setSort] = useState('created_at')
  const [order, setOrder] = useState('desc')
  const [summarySort, setSummarySort] = useState('bytes')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [okMsg, setOkMsg] = useState('')
  const [busy, setBusy] = useState('')
  const loadSeq = useRef(0)

  const load = useCallback(async (p: number) => {
    const current = ++loadSeq.current
    setLoading(true)
    setError('')
    try {
      const qs = new URLSearchParams({ page: String(p), size: String(SIZE), sort, order })
      if (user.trim()) qs.set('user', user.trim())
      if (q.trim()) qs.set('q', q.trim())
      if (state !== 'all') qs.set('state', state)
      const d = await request<{ rows: FileRow[]; total: number; totals: Totals }>(`${ADMIN_API}/gateway/files?${qs}`)
      const s = await request<{ rows: SummaryRow[]; totals: Totals }>(
        `${ADMIN_API}/gateway/files/summary?sort=${summarySort}&order=desc`)
      if (current !== loadSeq.current) return
      setRows(d.rows ?? [])
      setTotal(d.total ?? 0)
      setTotals(d.totals ?? s.totals ?? null)
      setSummary(s.rows ?? [])
    } catch (e: any) {
      if (current !== loadSeq.current) return
      setError(e.message || '查询失败')
    } finally {
      if (current === loadSeq.current) setLoading(false)
    }
  }, [user, q, state, sort, order, summarySort])

  // 首次挂载后：过滤/排序条件变化即重新查询（文本输入 300ms 防抖）。
  // 没有这段的话，输入框只是改了 state、表格纹丝不动 —— 看起来"筛选生效了"，
  // 实际查的还是全量（本仓已记录过的假绿形态）。
  const mounted = useRef(false)
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true
      void load(1)
      return
    }
    const t = setTimeout(() => { void load(1) }, 300)
    return () => clearTimeout(t)
  }, [load])

  const pages = Math.max(1, Math.ceil(total / SIZE))

  async function removeOne(fileID: string) {
    if (busy) return
    if (!window.confirm(`删除 ${fileID}？会同时删除上游文件与台账记录。`)) return
    setBusy(fileID)
    setError('')
    setOkMsg('')
    try {
      await request(`${ADMIN_API}/gateway/files/${encodeURIComponent(fileID)}`, { method: 'DELETE' })
      setOkMsg(`已删除 ${fileID}`)
      await load(page)
    } catch (e: any) {
      setError(e.message || '删除失败')
    } finally {
      setBusy('')
    }
  }

  async function purge() {
    if (busy) return
    // 服务端要求：至少一个条件；且**删有效文件必须指名员工**（全组织范围只允许清已过期）。
    // 这里保持同口径，避免用户点了才发现 400。
    if (state === 'all') {
      setError('批量清理必须指定状态（全部状态请先指定员工）')
      return
    }
    if (state === 'active' && !user.trim()) {
      setError('清理仍然有效的文件必须指定员工（全组织范围只允许清理已过期文件）')
      return
    }
    const scope = state === 'expired'
      ? `已过期文件${user.trim() ? `（员工「${user.trim()}」）` : ''}`
      : `员工「${user.trim()}」仍然有效的文件`
    const needTyped = state !== 'expired'
    const answer = window.prompt(
      needTyped
        ? `将删除 ${scope}。这是危险操作（会同时删掉上游文件），请输入「确认」继续：`
        : `将删除 ${scope}（上游 + 台账，单次最多 500 条）。输入「确认」继续：`)
    if (answer !== '确认') return
    setBusy('purge')
    setError('')
    setOkMsg('')
    try {
      // `all` 在服务端等价于"全部状态"，但删有效文件必须带 user ⇒ 这里按用户收敛。
      const body: Record<string, unknown> = { state: state === 'all' ? 'expired' : state }
      if (user.trim()) body.user = user.trim()
      const d = await request<{ deleted: number; failed: number; matched: number }>(
        `${ADMIN_API}/gateway/files/purge`, { method: 'POST', body: JSON.stringify(body) })
      setOkMsg(`清理完成：命中 ${d.matched}，删除 ${d.deleted}，失败 ${d.failed}`)
      await load(1)
      setPage(1)
    } catch (e: any) {
      setError(e.message || '清理失败')
    } finally {
      setBusy('')
    }
  }

  function toggleSort(key: string) {
    if (sort === key) {
      setOrder(order === 'desc' ? 'asc' : 'desc')
    } else {
      setSort(key)
      setOrder('desc')
    }
  }

  const sortMark = (key: string) => (sort === key ? (order === 'desc' ? ' ↓' : ' ↑') : '')

  return (
    <div className="space-y-4">
      <PageHeader title="网关文件" desc="按员工查看上游文件占用（全组织共享配额），可搜索、排序与清理" />

      {totals && (
        <div className="grid grid-cols-3 gap-4">
          <Card><CardContent className="pt-6">
            <div className="text-xs text-muted-foreground">台账文件数</div>
            <div className="text-2xl font-semibold">{totals.files}</div>
          </CardContent></Card>
          <Card><CardContent className="pt-6">
            <div className="text-xs text-muted-foreground">占用字节</div>
            <div className="text-2xl font-semibold">{fmtBytes(totals.bytes)}</div>
          </CardContent></Card>
          <Card><CardContent className="pt-6">
            <div className="text-xs text-muted-foreground">其中已过期（待回收）</div>
            <div className="text-2xl font-semibold">{totals.expired}</div>
          </CardContent></Card>
        </div>
      )}

      <Card>
        <CardHeader><CardTitle className="text-base">按员工占用</CardTitle></CardHeader>
        <CardContent>
          <div className="mb-2 flex items-center gap-2">
            <Label className="text-xs text-muted-foreground">排序</Label>
            <Select value={summarySort} onValueChange={setSummarySort}>
              <SelectTrigger className="w-[160px]" aria-label="员工占用排序"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="bytes">按占用字节</SelectItem>
                <SelectItem value="files">按文件数</SelectItem>
                <SelectItem value="username">按用户名</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>员工</TableHead>
                <TableHead>文件数</TableHead>
                <TableHead>占用</TableHead>
                <TableHead>已过期</TableHead>
                <TableHead>最早过期</TableHead>
                <TableHead className="w-[120px]">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {summary.map((s) => (
                <TableRow key={s.user_id}>
                  <TableCell>
                    {s.display_name || s.username}
                    <span className="ml-2 text-xs text-muted-foreground">{s.username}</span>
                  </TableCell>
                  <TableCell>{s.files}</TableCell>
                  <TableCell>{fmtBytes(s.bytes)}</TableCell>
                  <TableCell>{s.expired_files || '—'}</TableCell>
                  <TableCell>{fmtTime(s.earliest_expires_at)}</TableCell>
                  <TableCell>
                    <Button variant="outline" size="sm"
                      onClick={() => { setUser(s.username); setPage(1) }}>只看此人</Button>
                  </TableCell>
                </TableRow>
              ))}
              {summary.length === 0 && !loading && (
                <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground">暂无文件</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">文件明细</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-4 gap-3">
            <div className="space-y-1">
              <Label htmlFor="file-user">员工（用户名或 ID）</Label>
              <Input id="file-user" value={user} placeholder="全部员工"
                onChange={(e) => { setUser(e.target.value); setPage(1) }} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="file-q">搜索 file_id</Label>
              <Input id="file-q" value={q} placeholder="file-api-…"
                onChange={(e) => { setQ(e.target.value); setPage(1) }} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="file-state">状态</Label>
              <Select value={state} onValueChange={(v) => { setState(v); setPage(1) }}>
                <SelectTrigger id="file-state" aria-label="状态"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部</SelectItem>
                  <SelectItem value="active">有效</SelectItem>
                  <SelectItem value="expired">已过期</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-end gap-2">
              <Button variant="outline" onClick={() => void load(page)} disabled={loading}>刷新</Button>
              <Button variant="destructive" onClick={() => void purge()} disabled={busy === 'purge'}>
                {busy === 'purge' ? '清理中…' : '按条件清理'}
              </Button>
            </div>
          </div>

          {error && <div className="rounded border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</div>}
          {okMsg && <div className="rounded border border-emerald-500/40 bg-emerald-500/5 px-3 py-2 text-sm">{okMsg}</div>}

          {loading ? (
            <Skeleton className="h-32 w-full" />
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>file_id</TableHead>
                    <TableHead>员工</TableHead>
                    <TableHead className="cursor-pointer" onClick={() => toggleSort('size_bytes')}>大小{sortMark('size_bytes')}</TableHead>
                    <TableHead className="cursor-pointer" onClick={() => toggleSort('created_at')}>上传时间{sortMark('created_at')}</TableHead>
                    <TableHead className="cursor-pointer" onClick={() => toggleSort('expires_at')}>过期时间{sortMark('expires_at')}</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead className="w-[90px]">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.file_id}>
                      <TableCell className="font-mono text-xs">{r.file_id}</TableCell>
                      <TableCell>{r.display_name || r.username}<span className="ml-2 text-xs text-muted-foreground">{r.username}</span></TableCell>
                      <TableCell>{fmtBytes(r.size_bytes)}</TableCell>
                      <TableCell>{fmtTime(r.created_at)}</TableCell>
                      <TableCell>{fmtTime(r.expires_at)}</TableCell>
                      <TableCell>
                        {r.expired ? <Badge variant="destructive">已过期</Badge> : <Badge variant="secondary">有效</Badge>}
                      </TableCell>
                      <TableCell>
                        <Button variant="outline" size="sm" disabled={busy === r.file_id}
                          onClick={() => void removeOne(r.file_id)}>
                          {busy === r.file_id ? '删除中…' : '删除'}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                  {rows.length === 0 && (
                    <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground">没有匹配的文件</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">共 {total} 条 · 第 {page}/{pages} 页</span>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" disabled={page <= 1 || loading}
                    onClick={() => { const p = page - 1; setPage(p); void load(p) }}>上一页</Button>
                  <Button variant="outline" size="sm" disabled={page >= pages || loading}
                    onClick={() => { const p = page + 1; setPage(p); void load(p) }}>下一页</Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
