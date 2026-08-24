import { useEffect, useState } from 'react'
import { request } from '../api'
import { Button } from '../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table'
import { PageHeader } from '../components/page-header'
import { Server, Cpu, MemoryStick, HardDrive, Database, Activity, RefreshCw, ShieldCheck } from 'lucide-react'

interface SysInfo {
  uptime_sec: number
  uptime_human: string
  go_version: string
  num_cpu: number
  gomaxprocs: number
  goroutines: number
  mem: { allocated_mb: number; total_system_mb: number; system_memory_mb: number }
  load_avg: [number, number, number]
  disk: { data_path: string; total_gb: number; used_gb: number; free_gb: number; used_pct: number }
  db: {
    driver: string
    tables: Record<string, number>
    total_rows: number
    disk_bytes: number
    disk_human: string
    schema_migrations: number
  }
  version: string
}

// 统计卡(与用量页 stat-card 风格一致):图标品牌色渐变方块 + 标题 + 主值
function StatCard({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: string; sub?: string }) {
  return (
    <div className="app-card p-4">
      <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
        <span className="flex h-7 w-7 items-center justify-center rounded-md bg-blue-600/10 text-[#1E40AF]">{icon}</span>
        {label}
      </div>
      <div className="mt-2 text-xl font-bold tabular-nums">{value}</div>
      {sub && <div className="mt-1 text-[11px] text-muted-foreground">{sub}</div>}
    </div>
  )
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-slate-100 py-2 text-sm last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  )
}

export default function ServerInfo() {
  const [info, setInfo] = useState<SysInfo | null>(null)
  const [error, setError] = useState('')

  const load = async () => {
    setError('')
    try {
      const d = await request('/api/admin/server-info')
      setInfo(d)
    } catch (e: any) {
      setError(e.message || '加载失败')
    }
  }

  useEffect(() => { load() }, [])

  return (
    <div className="space-y-4">
      <PageHeader
        title="服务器信息"
        desc="系统运行状态与数据库统计(独立于业务数据,仅管理员可见)"
        actions={
          <Button size="sm" variant="outline" onClick={load}>
            <RefreshCw className="h-3.5 w-3.5" /> 刷新
          </Button>
        }
      />
      {error && <div className="text-sm text-destructive">{error}</div>}

      {info ? (
        <>
          {/* 系统统计卡 */}
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <StatCard icon={<Activity className="h-4 w-4" />} label="运行时长" value={info.uptime_human} sub={`版本 ${info.version}`} />
            <StatCard icon={<Cpu className="h-4 w-4" />} label="CPU / 负载" value={`${info.num_cpu} 核`} sub={`负载 ${info.load_avg[0].toFixed(2)} / ${info.load_avg[1].toFixed(2)} / ${info.load_avg[2].toFixed(2)} · GOMAXPROCS ${info.gomaxprocs}`} />
            <StatCard icon={<MemoryStick className="h-4 w-4" />} label="内存 (Go 堆)" value={`${info.mem.allocated_mb} MB`} sub={`系统 ${info.mem.system_memory_mb} MB · 进程占用 ${info.mem.total_system_mb} MB`} />
            <StatCard icon={<HardDrive className="h-4 w-4" />} label="磁盘占用" value={`${info.disk.used_gb} / ${info.disk.total_gb} GB`} sub={`使用率 ${info.disk.used_pct}% · 剩余 ${info.disk.free_gb} GB`} />
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {/* 系统详情 */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base"><Server className="h-4 w-4 text-muted-foreground" /> 系统详情</CardTitle>
                <CardDescription>运行时与数据库引擎信息</CardDescription>
              </CardHeader>
              <CardContent>
                <InfoRow label="Go 运行时" value={info.go_version} />
                <InfoRow label="Goroutines" value={info.goroutines} />
                <InfoRow label="GOMAXPROCS" value={info.gomaxprocs} />
                <InfoRow label="数据库引擎" value={info.db.driver === 'pg' ? 'PostgreSQL' : 'SQLite'} />
                <InfoRow label="数据库大小" value={`${info.db.disk_human} (${info.db.disk_bytes.toLocaleString()} B)`} />
                <InfoRow label="Schema 迁移版本" value={info.db.schema_migrations} />
                <InfoRow label="数据目录" value={<span className="font-mono text-xs">{info.disk.data_path}</span>} />
              </CardContent>
            </Card>

            {/* 数据表统计 */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base"><Database className="h-4 w-4 text-muted-foreground" /> 数据表统计</CardTitle>
                <CardDescription>各表行数(共 {info.db.total_rows.toLocaleString()} 行)</CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>表</TableHead>
                      <TableHead className="text-right">行数</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {Object.entries(info.db.tables).map(([name, rows]) => (
                      <TableRow key={name}>
                        <TableCell className="font-mono text-xs">{name}</TableCell>
                        <TableCell className="text-right tabular-nums">{rows.toLocaleString()}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </div>

          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <ShieldCheck className="h-3 w-3" /> 仅管理员可访问 · 数据实时从服务器获取
          </div>
        </>
      ) : (
        <div className="flex h-64 items-center justify-center text-muted-foreground">加载中…</div>
      )}
    </div>
  )
}
