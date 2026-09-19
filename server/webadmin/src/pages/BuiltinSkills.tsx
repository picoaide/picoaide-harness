import { useCallback, useEffect, useState } from 'react'
import { request, ADMIN_API } from '../api'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card'
import { Skeleton } from '../components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table'
import { hasPermission, PERM_CAP_READ } from '../lib/rbac'
import { AlertTriangle, Boxes, FolderOpen, PackageCheck, RefreshCw } from 'lucide-react'

/**
 * 平台内置技能（服务端只读面，2026-09-19）。
 *
 * 用户原话：「这个应该是默认放在服务端的技能库里…我在能力中心里看不到这个」。
 * 管理后台此前**完全没有内置技能面**：服务端带了哪些技能、哪条因为什么被跳过，
 * 只有启动日志里能看到；而坏掉的表现是「接口 200 + 空数组」，员工侧只看到
 * "能力中心里没有这条技能"，管理员在这页之前无处可查。
 *
 * 因此这一页要回答两个问题，且**只回答这两个**：
 *  1. 这个部署的镜像里到底带了哪些技能（名称/版本/大小/文件数/sha256/目录）；
 *  2. 有没有被跳过的技能、为什么（frontmatter 缺字段、目录名与 name 不一致…）。
 *
 * 只读：内置技能是**镜像资产**，不是数据库行 —— 没有 owner、没有上架/授权/审批，
 * 所以这里不提供任何写入口（改内容 = 改 `server/skills/` 并重新构建镜像）。
 */
interface BuiltinSkill {
  name: string
  version: string
  title?: string
  description?: string
  author?: string
  category?: string
  sha256: string
  size: number
  files: number
  source?: string
}

interface BuiltinProblem {
  name: string
  reason: string
}

interface BuiltinView {
  dir: string
  dir_exists: boolean
  skills: BuiltinSkill[] | null
  problems: BuiltinProblem[] | null
  counts?: { skills: number; problems: number }
  /** 扫描本身失败（目录读不了等）时才有；此时其余字段可能为空。 */
  load_error?: string
}

/** 字节 → 人类可读（技能包在几十 KiB 量级，保留一位小数足够）。 */
function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

/** sha256 只显示前 12 位（完整值挂 title，核对时鼠标悬停可读全）。 */
function shortSha(sha: string): string {
  return typeof sha === 'string' && sha.length > 12 ? `${sha.slice(0, 12)}…` : (sha || '—')
}

export default function BuiltinSkills() {
  const [view, setView] = useState<BuiltinView | null>(null)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)
  const canRead = hasPermission(PERM_CAP_READ)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await request<BuiltinView>(`${ADMIN_API}/skills/builtin`)
      setView(data)
      setErr('')
    } catch (e: unknown) {
      setErr((e as { message?: string })?.message || '读取平台内置技能失败')
    } finally {
      setLoading(false)
    }
  }, [])

  // 没有 capability:read 就不发请求（前端只是体验层，但"必然 403 的接口"
  // 不该白打一发 —— 与仓库既有页面的口径一致）。
  useEffect(() => { if (canRead) void load() }, [load, canRead])

  if (!canRead) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>平台内置技能</CardTitle>
          <CardDescription>没有查看权限（需要 capability:read）。</CardDescription>
        </CardHeader>
      </Card>
    )
  }

  const skills = view?.skills ?? []
  const problems = view?.problems ?? []
  const loadError = view?.load_error ?? ''

  return (
    <div className="space-y-4" data-testid="builtin-skills">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2">
              <Boxes className="h-4 w-4" />
              平台内置技能
              {view && (
                <Badge variant={problems.length > 0 || loadError ? 'destructive' : 'secondary'} data-testid="builtin-count">
                  {skills.length} 条
                  {problems.length > 0 ? ` · ${problems.length} 条被跳过` : ''}
                </Badge>
              )}
            </CardTitle>
            <CardDescription>
              随服务端镜像发布的内置技能（源在仓库的 <code>server/skills/</code>，镜像内
              <code> /opt/picoaide/skills/</code>）；员工在客户端「能力中心 → 平台内置」按需安装。
              这里是只读视图：改内容 = 改仓库并重新构建镜像。
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading} data-testid="builtin-refresh">
            <RefreshCw className="mr-2 h-4 w-4" />
            刷新
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[13px] text-muted-foreground">
            <span className="flex items-center gap-2">
              <FolderOpen className="h-4 w-4" />
              资产目录：<code data-testid="builtin-dir">{view?.dir ?? '—'}</code>
            </span>
            <span className="flex items-center gap-2">
              <PackageCheck className="h-4 w-4" />
              目录存在：{view ? (view.dir_exists ? '是' : '否') : '—'}
            </span>
          </div>

          {err !== '' && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-[13px] text-destructive" data-testid="builtin-error">
              {err}
            </div>
          )}

          {/* 扫描本身失败：把原因与目录一起显示出来（这正是"接口 200 + 空数组"看不见的部分）。 */}
          {loadError !== '' && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-[13px]" data-testid="builtin-load-error">
              <div className="flex items-center gap-2 font-medium text-destructive">
                <AlertTriangle className="h-4 w-4" />
                资产扫描失败
              </div>
              <div className="mt-1 break-all text-muted-foreground">{loadError}</div>
            </div>
          )}

          {/* 被跳过的技能：名字 + 原因（frontmatter 缺字段、目录名与 name 不一致…）。 */}
          {problems.length > 0 && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-[13px]" data-testid="builtin-problems">
              <div className="flex items-center gap-2 font-medium text-amber-700">
                <AlertTriangle className="h-4 w-4" />
                有 {problems.length} 条技能被跳过（不会出现在员工的能力中心里）
              </div>
              <ul className="mt-2 space-y-1">
                {problems.map((p, i) => (
                  <li key={`${p.name}-${i}`} className="break-all">
                    <span className="font-mono text-xs">{p.name}</span>
                    <span className="text-muted-foreground"> —— {p.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {view === null && !err && (
            <div className="space-y-2">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          )}

          {view !== null && skills.length === 0 && (
            <div className="rounded-md border p-3 text-[13px] text-muted-foreground" data-testid="builtin-empty">
              {view.dir_exists
                ? '资产目录存在，但没有一条技能通过校验。请看上面的「被跳过」原因。'
                : '镜像里没有内置技能资产目录（本地直接跑二进制就是这种形态，不是故障）。'}
            </div>
          )}

          {skills.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>技能</TableHead>
                  <TableHead>版本</TableHead>
                  <TableHead>作者 / 分类</TableHead>
                  <TableHead>文件数</TableHead>
                  <TableHead>大小</TableHead>
                  <TableHead>sha256</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {skills.map((s) => (
                  <TableRow key={s.name} data-testid={`builtin-row-${s.name}`}>
                    <TableCell>
                      <div className="font-medium">{s.title || s.name}</div>
                      <div className="font-mono text-xs text-muted-foreground">{s.name}</div>
                      {s.description && (
                        <div className="mt-1 max-w-[42rem] text-xs text-muted-foreground">{s.description}</div>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{s.version}</TableCell>
                    <TableCell className="whitespace-nowrap text-[13px]">
                      {s.author || '—'}
                      {s.category ? ` / ${s.category}` : ''}
                    </TableCell>
                    <TableCell>{s.files}</TableCell>
                    <TableCell className="whitespace-nowrap">{humanSize(s.size)}</TableCell>
                    <TableCell className="font-mono text-xs" title={s.sha256}>
                      {shortSha(s.sha256)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
