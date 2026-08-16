import { useCallback, useEffect, useState } from 'react'
import { request } from '../api'
import { Button } from '../components/ui/button'
import { Badge } from '../components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table'

interface LogRow {
  id: number
  username: string
  action: string
  detail: string
  created_at: string
}

const ACTION_LABEL: Record<string, string> = {
  kb_upload: '上传文档',
  kb_delete: '删除文档',
  kb_update: '更新文档',
}

export default function Audit() {
  const [logs, setLogs] = useState<LogRow[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [error, setError] = useState('')

  const load = useCallback(async (p: number) => {
    try {
      const data = await request(`/api/admin/kb/audit?page=${p}&size=50`)
      setLogs(data.logs)
      setTotal(data.total)
      setPage(p)
    } catch (err: any) {
      setError(err.message)
    }
  }, [])

  useEffect(() => { load(1) }, [load])

  const pages = Math.max(1, Math.ceil(total / 50))

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">审计日志</h1>
        <span className="text-sm text-muted-foreground">知识库与敏感操作记录(凭证下载见商城页)</span>
      </div>
      {error && <div className="text-sm text-destructive">{error}</div>}
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
              <TableCell>{l.id}</TableCell>
              <TableCell><Badge variant="secondary">{ACTION_LABEL[l.action] ?? l.action}</Badge></TableCell>
              <TableCell>{l.username}</TableCell>
              <TableCell className="max-w-96 truncate font-mono text-xs">{l.detail}</TableCell>
              <TableCell className="text-muted-foreground">{l.created_at ? l.created_at.slice(0, 19).replace('T', ' ') : '—'}</TableCell>
            </TableRow>
          ))}
          {logs.length === 0 && (
            <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground">暂无记录</TableCell></TableRow>
          )}
        </TableBody>
      </Table>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => load(page - 1)}>上一页</Button>
        <span className="text-sm text-muted-foreground">第 {page}/{pages} 页 · 共 {total} 条</span>
        <Button size="sm" variant="outline" disabled={page >= pages} onClick={() => load(page + 1)}>下一页</Button>
      </div>
    </div>
  )
}
