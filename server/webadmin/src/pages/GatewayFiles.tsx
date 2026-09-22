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
import { PERM_GATEWAY_WRITE, hasPermission } from '../lib/rbac'

const DEFAULT_SIZE = 20
/** 每页条数候选（服务端 `size` 上限 200，缺省 50；这里只给常用档）。 */
const PAGE_SIZES = [10, 20, 50, 100]

/**
 * 字节数渲染（二进制单位，保留一位小数）。
 *
 * 边界：0 / 负数 / NaN / ±Infinity 一律「0 B」。服务端不会下发这些值，但渲染层
 * 不能因为一个坏值把整张表打成 `Infinity TiB`（本页三处都直接吃服务端数字）。
 * 单位表到 TiB 为止：再大就以 TiB 计数（本页配额是全组织 25 GiB 量级，够用且
 * 不会因为自造 PiB 档位在别处产生第二套口径）。
 */
export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`
}

/** 时间戳公共实现：空值给 null（由调用方决定占位符），不可解析时原样回显。 */
function fmtStamp(v: string | null | undefined): string | null {
  if (!v) return null
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return v
  return d.toLocaleString('zh-CN', { hour12: false })
}

/** 过期时间渲染：「无过期时间」= 永久（不是缺失值）。 */
export function fmtTime(v: string | null | undefined): string {
  return fmtStamp(v) ?? '永久'
}

/**
 * 上传/创建时间渲染：空值给「—」。
 *
 * 创建时间没有「永久」这种语义 —— 共用 fmtTime 会让一条 created_at 缺失的行
 * 显示成「永久」，管理员据此判断"这条不会过期"，正好读反。
 */
export function fmtDateTime(v: string | null | undefined): string {
  return fmtStamp(v) ?? '—'
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

/**
 * 网关文件台账（2026-09-22）。
 *
 * 需求：上游 Files 配额是**每 API key**（全组织共享 25 GiB / 10000 文件），而保留上限
 * 由平台收敛（`gateway.file_expiry_days`，缺省 7 天）。本页给管理员一个"按员工看占用、
 * 搜索、排序、按条件清理"的工具；服务端另有 5 分钟一轮的自动回收。
 *
 * 三个刻意的产品约束：
 *   1. 批量清理**必须带条件**（员工或状态）—— 空条件等于"清空全公司台账"，
 *      服务端会 400，前端也不给这个按钮的可用状态；
 *   2. "清理仍然有效的文件"是危险动作：全组织范围只允许清「已过期」，
 *      指名员工后才允许清「有效」或「全部」状态，并要求二次确认里输入确认词；
 *   3. 过滤/排序/分页条件**全部进查询串**（`user`/`user_id`/`q`/`state`/`sort`/
 *      `order`/`page`/`size`），页面不做任何本地过滤 —— 本地过滤会让管理员
 *      把"当前这一页里没匹配"误读成"全公司没匹配"。
 */
export default function GatewayFiles() {
  const [rows, setRows] = useState<FileRow[]>([])
  const [summary, setSummary] = useState<SummaryRow[]>([])
  const [totals, setTotals] = useState<Totals | null>(null)
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [size, setSize] = useState(DEFAULT_SIZE)
  const [user, setUser] = useState('')
  // 服务端 `user=` 一律按**用户名**解，数字 ID 必须走 `user_id=`（审计 2026-09-22
  // R6 P1-B：`user=2` 曾被当成 id=2 —— 清理会删到另一个员工）。两个输入框互斥
  // （见 onChange 与「只看此人」），保证下发的永远是其中一个，不会出现
  // "填了 ID 又填了用户名、服务端按 ID 过滤而页面显示的是用户名"的静默错配。
  const [userId, setUserId] = useState('')
  const [q, setQ] = useState('')
  const [state, setState] = useState('all')
  const [sort, setSort] = useState('created_at')
  const [order, setOrder] = useState('desc')
  const [summarySort, setSummarySort] = useState('bytes')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [okMsg, setOkMsg] = useState('')
  const [busy, setBusy] = useState('')
  // 请求序号守卫：快速改条件时会有多个请求在飞，只有**最后发出**的那个能落状态。
  // 没有它时，"先发的慢响应后到"会把表格改回上一个条件的结果（用户看到的过滤
  // 条件与数据不一致）。
  const loadSeq = useRef(0)

  const load = useCallback(async (p: number) => {
    const current = ++loadSeq.current
    setLoading(true)
    setError('')
    try {
      const qs = new URLSearchParams({ page: String(p), size: String(size), sort, order })
      // 与服务端 adminFileQuery 同优先级：user_id 先于 user（两个输入框互斥，
      // 实际只会下发一个）。
      if (userId.trim()) qs.set('user_id', userId.trim())
      else if (user.trim()) qs.set('user', user.trim())
      if (q.trim()) qs.set('q', q.trim())
      if (state !== 'all') qs.set('state', state)
      const d = await request<{ rows: FileRow[]; total: number; totals: Totals }>(`${ADMIN_API}/gateway/files?${qs}`)
      const s = await request<{ rows: SummaryRow[]; totals: Totals }>(
        `${ADMIN_API}/gateway/files/summary?sort=${summarySort}&order=desc`)
      if (current !== loadSeq.current) return
      const totalRows = d.total ?? 0
      const lastPage = Math.max(1, Math.ceil(totalRows / size))
      if (p > lastPage) {
        // 末页被删空（或过滤后总数变小）导致当前页越界：回到最后一页，
        // 而不是显示「第 2/1 页」再给一张空表（管理员会以为"没数据了"）。
        setPage(lastPage)
        void load(lastPage)
        return
      }
      setRows(d.rows ?? [])
      setTotal(totalRows)
      setTotals(d.totals ?? s.totals ?? null)
      setSummary(s.rows ?? [])
    } catch (e: any) {
      if (current !== loadSeq.current) return
      // 失败时**清掉上一次成功的数据**：否则换了过滤条件后请求失败，屏幕上留着
      // 的仍是旧条件的行，管理员会把它当成新条件的结果（本仓记录过的假绿形态）。
      setRows([])
      setSummary([])
      setTotal(0)
      setError(e.message || '查询失败')
    } finally {
      if (current === loadSeq.current) setLoading(false)
    }
  }, [user, userId, q, state, sort, order, summarySort, size])

  // 首次挂载后：过滤/排序/分页条件变化即重新查询（文本输入 300ms 防抖）。
  // 没有这段的话，输入框只是改了 state、表格纹丝不动 —— 看起来"筛选生效了"，
  // 实际查的还是全量（本仓已记录过的假绿形态）。
  //
  // 这里**一律回到第 1 页**：条件变了以后第 N 页已经不是同一个东西了。因此所有
  // 条件变更都必须同步 `setPage(1)`（toggleSort / 每页条数 / 状态 / 输入框）——
  // 只 reload 不重置页码，界面上会出现"第 3/5 页"配第 1 页数据。
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

  const pages = Math.max(1, Math.ceil(total / size))
  // 删除/清理走服务端 `gateway:write`（router.go 的路由申报）。这里做体验层收敛：
  // 读权限（`gateway:read`，nav 条目的权限点）只给"看"，写按钮不该出现 —— 否则
  // 只读管理员点下去只会拿到 403。权限集未下发时 hasPermission 放行（旧版本/测试）。
  const canWrite = hasPermission(PERM_GATEWAY_WRITE)

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
    const name = user.trim()
    // 服务端 purgeGatewayFilesAdmin 的三条硬口径（这里保持同口径，避免用户点了
    // 才发现 400）：
    //   ① `user`/`user_id`/`state` 至少一个 —— 空条件 = 清空全公司台账；
    //   ② 删「仍然有效」的文件必须指名员工（全组织范围只允许清已过期）；
    //   ③ `state` 原样下发：`all` 就是"员工名下全部文件"，**不能**悄悄收敛成
    //      `expired`（确认框说的是全部、请求却只删过期 = 范围与承诺不一致）。
    if (!name && userId.trim()) {
      // 清理请求体按契约只带 `user`（用户名）；只填了员工 ID 时不能猜。
      // 更不能退化成本次筛选之外的范围：管理员看着"员工 ID = 5"的过滤条件点清理，
      // 若下发 `{state:'expired'}` 就成了**全组织**清理，范围与屏幕上的条件不一致。
      setError('按员工清理请在「员工（用户名）」里填用户名（员工 ID 只用于筛选列表）')
      return
    }
    if (state === 'all' && !name) {
      setError('批量清理必须指定条件：选择「有效 / 已过期」，或先填「员工（用户名）」（填了员工才可按「全部」状态清理）')
      return
    }
    if (state === 'active' && !name) {
      setError('清理仍然有效的文件必须指定员工（全组织范围只允许清理已过期文件）')
      return
    }
    const dangerous = state !== 'expired'
    const scope = name ? `员工「${name}」` : '全部员工'
    const what = state === 'expired' ? '已过期文件'
      : state === 'active' ? '仍然有效的文件' : '全部文件（含仍然有效的）'
    const answer = window.prompt(
      dangerous
        ? `将删除 ${scope}的${what}。这是危险操作（会同时删掉上游文件），请输入「确认」继续：`
        : `将删除 ${scope}的${what}（上游 + 台账，单次最多 500 条）。输入「确认」继续：`)
    if (answer !== '确认') return
    setBusy('purge')
    setError('')
    setOkMsg('')
    try {
      // 逐字对齐服务端契约：`{state, user?}`。
      const body: Record<string, unknown> = { state }
      if (name) body.user = name
      const d = await request<{ deleted: number; failed: number; matched: number }>(
        `${ADMIN_API}/gateway/files/purge`, { method: 'POST', body: JSON.stringify(body) })
      setOkMsg(`清理完成：命中 ${d.matched}，删除 ${d.deleted}，失败 ${d.failed}`)
      setPage(1)
      await load(1)
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
    // 换了排序键/方向，页 N 的内容已经不是原来的东西 ⇒ 回第 1 页。
    setPage(1)
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
            <Select value={summarySort} onValueChange={(v) => { setSummarySort(v); setPage(1) }}>
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
                    <Button variant="outline" size="sm" aria-label={`只看 ${s.username}`}
                      onClick={() => { setUser(s.username); setUserId(''); setPage(1) }}>只看此人</Button>
                  </TableCell>
                </TableRow>
              ))}
              {summary.length === 0 && !loading && !error && (
                <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground">暂无文件</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">文件明细</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <div className="space-y-1">
              <Label htmlFor="file-user">员工（用户名）</Label>
              <Input id="file-user" value={user} placeholder="全部员工"
                onChange={(e) => { setUser(e.target.value); setUserId(''); setPage(1) }} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="file-user-id">员工 ID</Label>
              <Input id="file-user-id" type="number" min={1} value={userId} placeholder="全部员工"
                onChange={(e) => { setUserId(e.target.value); setUser(''); setPage(1) }} />
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
            <div className="space-y-1">
              <Label htmlFor="file-size">每页条数</Label>
              <Select value={String(size)} onValueChange={(v) => { setSize(Number(v)); setPage(1) }}>
                <SelectTrigger id="file-size" aria-label="每页条数"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PAGE_SIZES.map((n) => (
                    <SelectItem key={n} value={String(n)}>{n} 条/页</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-end gap-2">
              <Button variant="outline" onClick={() => void load(page)} disabled={loading}>刷新</Button>
              {canWrite && (
                <Button variant="destructive" onClick={() => void purge()} disabled={busy === 'purge'}>
                  {busy === 'purge' ? '清理中…' : '按条件清理'}
                </Button>
              )}
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
                      <TableCell>{fmtDateTime(r.created_at)}</TableCell>
                      <TableCell>{fmtTime(r.expires_at)}</TableCell>
                      <TableCell>
                        {r.expired ? <Badge variant="destructive">已过期</Badge> : <Badge variant="secondary">有效</Badge>}
                      </TableCell>
                      <TableCell>
                        {canWrite ? (
                          <Button variant="outline" size="sm" disabled={busy === r.file_id}
                            onClick={() => void removeOne(r.file_id)}>
                            {busy === r.file_id ? '删除中…' : '删除'}
                          </Button>
                        ) : <span className="text-xs text-muted-foreground">—</span>}
                      </TableCell>
                    </TableRow>
                  ))}
                  {rows.length === 0 && !error && (
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
