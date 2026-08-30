import { useCallback, useEffect, useRef, useState } from 'react'
import { request, ADMIN_API } from '../api'
import { Button } from '../components/ui/button'
import { Badge } from '../components/ui/badge'
import { Input } from '../components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table'
import { PageHeader } from '../components/page-header'
import { EmptyState } from '../components/empty-state'
import { Card } from '../components/ui/card'
import { ScrollText, RefreshCw, Download } from 'lucide-react'

interface LogRow {
  id: number
  username: string
  action: string
  detail: string
  created_at: string
}

// M3: 与服务端实际写入的 audit action 全集对齐(用户/部门/技能/令牌等敏感操作)
const ACTION_LABEL: Record<string, string> = {
  skill_create: '上架技能',
  skill_update: '更新技能',
  skill_disable: '下架技能',
  skill_enable: '重新上架技能',
  skill_grant: '技能授权',
  skill_revoke: '技能撤销授权',
  skill_grants_replace: '技能部门授权替换',
  user_create: '创建用户',
  user_update: '更新用户',
  user_delete: '删除用户',
  user_dept: '用户部门变更',
  user_tokens_revoked: '吊销令牌',
  auth_config: '修改认证配置',
  dept_create: '新建部门',
  dept_update: '更新部门',
  dept_delete: '删除部门',
  // MCP 与知识库(MCP/KB)动作——生产环境写入,原名未映射时显示原始 id
  mcp_create: '新建MCP',
  mcp_update: 'MCP更新',
  mcp_delete: '删除MCP',
  mcp_grant: 'MCP授权',
  mcp_revoke: 'MCP撤销授权',
  kb_create: '新建知识库',
  kb_update: '更新知识库',
  kb_delete: '删除知识库',
  kb_import: '知识库导入',
  kb_grant: '知识库授权',
  kb_revoke: '知识库撤销授权',
}

// M8: 筛选下拉的可选动作
const FILTER_ACTIONS = Object.keys(ACTION_LABEL).sort()

// 操作 → 徽章语义色:创建=绿 / 删除=红 / 更新=琥珀 / 授权=绿
// 未收录进 ACTION_LABEL 的动作统一中性 outline,避免误撞成实心蓝(default)。
function actionBadgeVariant(action: string): 'default' | 'secondary' | 'destructive' | 'outline' | 'success' {
  if (!(action in ACTION_LABEL)) return 'outline'
  if (/create|enable|grant/.test(action)) return 'success'
  if (/delete|disable|revoke/.test(action)) return 'destructive'
  if (/update|dept/.test(action)) return 'secondary'
  return 'outline'
}

function fmtTime(iso: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  // L4: 保留时区语义,按本地时间展示
  return d.toLocaleString('zh-CN', { hour12: false })
}

export default function Audit() {
  const [logs, setLogs] = useState<LogRow[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [error, setError] = useState('')
  // M8: 筛选条件(输入态 vs 已应用态)
  const [filterAction, setFilterAction] = useState('')
  const [filterUser, setFilterUser] = useState('')
  const [appliedAction, setAppliedAction] = useState('')
  const [appliedUser, setAppliedUser] = useState('')
  // P1-8: 请求序号防乱序——快速翻页/切筛选时只有最新请求的响应能更新 state
  const loadSeq = useRef(0)

  const load = useCallback(async (p: number, action: string, username: string) => {
    const current = ++loadSeq.current
    try {
      const params = new URLSearchParams({ page: String(p), size: '50' })
      if (action) params.set('action', action)
      if (username) params.set('username', username)
      const data = await request(`${ADMIN_API}/audit?${params.toString()}`)
      if (current !== loadSeq.current) return // P1-8: 过期响应丢弃
      setLogs(data.logs)
      setTotal(data.total)
      setPage(p)
    } catch (err: any) {
      if (current !== loadSeq.current) return // P1-8: 过期响应不写错误
      setError(err.message)
    }
  }, [])

  useEffect(() => { load(1, appliedAction, appliedUser) }, [load, appliedAction, appliedUser])

  const applyFilter = () => {
    setAppliedAction(filterAction)
    setAppliedUser(filterUser.trim())
    setPage(1)
    load(1, filterAction, filterUser.trim())
  }

  const pages = Math.max(1, Math.ceil(total / 50))

  // CSV 导出(当前页数据; 轻量版 v3b, 不调服务端)
  const exportCSV = () => {
    const header = ['id', 'username', 'action', 'detail', 'created_at']
    const lines = [header.join(',')]
    for (const l of logs) {
      lines.push([l.id, l.username, l.action, l.detail, l.created_at].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `audit-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="审计日志"
        desc="敏感操作记录(用户/部门/技能等)"
        actions={
          <>
            <Button size="sm" variant="outline" onClick={exportCSV}>
              <Download className="h-3.5 w-3.5" /> 导出 CSV
            </Button>
            <Button size="sm" variant="outline" onClick={() => load(page, appliedAction, appliedUser)}>
              <RefreshCw className="h-3.5 w-3.5" /> 刷新
            </Button>
          </>
        }
      />
      {error && <div className="text-sm text-destructive">{error}</div>}
      {/* M8: 筛选条 */}
      <div className="flex flex-wrap items-center gap-2">
        <Select value={filterAction} onValueChange={setFilterAction}>
          <SelectTrigger className="w-52">
            <SelectValue placeholder="全部操作" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">全部操作</SelectItem>
            {FILTER_ACTIONS.map((a) => (
              <SelectItem key={a} value={a}>{ACTION_LABEL[a]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          className="w-44"
          placeholder="操作者"
          value={filterUser}
          onChange={(e) => setFilterUser(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') applyFilter() }}
        />
        <Button size="sm" variant="outline" onClick={applyFilter}>筛选</Button>
        {(appliedAction || appliedUser) && (
          <Button size="sm" variant="ghost" onClick={() => { setFilterAction(''); setFilterUser(''); setAppliedAction(''); setAppliedUser('') }}>清除筛选</Button>
        )}
      </div>
      <Card>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>ID</TableHead>
            <TableHead>操作</TableHead>
            <TableHead>操作者</TableHead>
            <TableHead>详情</TableHead>
            <TableHead>时间</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {logs.map((l) => (
            <TableRow key={l.id}>
              <TableCell className="font-mono text-xs text-slate-400">{l.id}</TableCell>
              <TableCell><Badge variant={actionBadgeVariant(l.action)}>{ACTION_LABEL[l.action] ?? l.action}</Badge></TableCell>
              <TableCell>
                <span className="inline-flex items-center gap-1.5 font-medium">
                  <span className="flex h-5 w-5 items-center justify-center rounded bg-slate-100 text-[9px] font-bold text-slate-500">
                    {l.username.slice(0, 1).toUpperCase()}
                  </span>
                  {l.username}
                </span>
              </TableCell>
              {/* M8: 详情悬停可查看全文;截断单元可聚焦,键盘/触屏用户经 aria-label 读全文 */}
              <TableCell
                className="max-w-96 truncate font-mono text-xs text-slate-500 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                title={l.detail}
                tabIndex={0}
                aria-label={l.detail}
              >
                {l.detail}
              </TableCell>
              <TableCell className="font-mono text-xs text-muted-foreground">{fmtTime(l.created_at)}</TableCell>
            </TableRow>
          ))}
          {logs.length === 0 && (
            <TableRow>
              <TableCell colSpan={5} className="border-0 p-0">
                <EmptyState
                  icon={<ScrollText className="h-5 w-5 text-muted-foreground" />}
                  title="暂无审计记录"
                  desc="敏感操作(用户/部门/技能/令牌)会在此留痕"
                />
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      </Card>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => load(page - 1, appliedAction, appliedUser)}>上一页</Button>
        <span className="text-sm text-muted-foreground">第 {page}/{pages} 页 · 共 {total} 条</span>
        <Button size="sm" variant="outline" disabled={page >= pages} onClick={() => load(page + 1, appliedAction, appliedUser)}>下一页</Button>
      </div>
    </div>
  )
}
