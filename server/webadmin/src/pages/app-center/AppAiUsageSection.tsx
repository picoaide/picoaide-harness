import { useCallback, useEffect, useRef, useState } from 'react'
import { request } from '../../api'
import { Button } from '../../components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table'
import { EmptyState } from '../../components/empty-state'
import { fmtY } from '../usage/common'
import { RefreshCw, Sparkles } from 'lucide-react'
import {
  AI_ATTRIBUTION_NOTE,
  aiUsageIsEmpty,
  aiUsagePath,
  classifyEndpointFailure,
  countText,
  requireAiUsage,
  shapeDrift,
  tokensText,
  type AiUsage,
  type EndpointFailure,
} from './opens-contract'

/**
 * 应用详情抽屉 · 「AI 用量」面板（§21.1 第 12 问 / §21.4，台账 R2C-14 的 L6 落点）。
 *
 * 数据源：`GET /wasm-apps/:app_id/ai-usage`（capability:read）
 * —— `usage` 表的**应用维度**（契约 §21.4：新迁移 0076 + 索引）。
 *
 * 三条必须守住的语义：
 *   ① **账单归使用者账号，应用维度靠归因**：客户端 LLM 出站带 `X-Pico-App-Id`，
 *      服务端只在该请求确属客户端会话链路时记录（伪造头忽略并 warn）；
 *   ② **无数据 ≠ 0**：老客户端不带归因头 ⇒ 归因缺失但计费正常（§21.4 认账）。
 *      所以"次数/费用/token 全 0 且没有按日点"必须渲染成**空状态**
 *      （"还没有 AI 调用记录"），而不是"0 次调用 / ¥0.00" —— 后者会被读成
 *      "这个应用没人用 AI"，据此停掉一个其实在用的应用；
 *   ③ **缺后端不得显示 0**：端点 404 / 形状漂移 ⇒ 明说"服务端尚未提供"，数字显示 `—`。
 *
 * 应用 AI 的完整链路（每应用一个隐藏会话、仅对话、SSE、窗口关闭即取消）见 §21.2，
 * 客户端侧实现归 L2/L3；管理端只读它的用量结果，不参与执行。
 */

export function AppAiUsageSection({ appId, canRead }: { appId: string; canRead: boolean }) {
  const [data, setData] = useState<AiUsage | null>(null)
  const [failure, setFailure] = useState<EndpointFailure | null>(null)
  const [loading, setLoading] = useState(true)
  const seq = useRef(0)

  const load = useCallback(async () => {
    if (!canRead) {
      setLoading(false)
      return
    }
    const current = ++seq.current
    setLoading(true)
    setFailure(null)
    try {
      const raw = await request(aiUsagePath(appId))
      if (current !== seq.current) return
      const parsed = requireAiUsage(raw)
      if (!parsed.ok) {
        setData(null)
        setFailure(shapeDrift('AI 用量', parsed.detail))
        return
      }
      setData(parsed.value)
    } catch (err: unknown) {
      if (current !== seq.current) return
      setData(null)
      setFailure(classifyEndpointFailure(err, 'AI 用量', aiUsagePath(appId)))
    } finally {
      if (current === seq.current) setLoading(false)
    }
  }, [appId, canRead])

  useEffect(() => { void load() }, [load])

  /** 按日点：新到旧，最多 14 行（面板是抽屉里的一小节，不做完整报表）。 */
  const days = (data?.points ?? [])
    .slice()
    .sort((a, b) => String(b.day ?? '').localeCompare(String(a.day ?? '')))
    .slice(0, 14)

  return (
    <section className="space-y-2 rounded-md border p-3" data-testid="app-ai-usage-block">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-1 text-sm font-semibold">
          <Sparkles className="h-4 w-4" />AI 用量
        </h3>
        <Button variant="ghost" size="sm" onClick={() => { void load() }} title="刷新" aria-label="刷新 AI 用量" data-testid="app-ai-refresh">
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      {!canRead ? (
        <p className="text-sm text-muted-foreground" data-testid="app-ai-noperm">
          需要 capability:read 权限才能查看 AI 用量。
        </p>
      ) : failure ? (
        <div className="space-y-2" data-testid="app-ai-failure-block">
          <p data-testid="app-ai-failure" role="alert" aria-live="assertive" className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-sm text-destructive">
            {failure.text}
          </p>
          <Button variant="outline" size="sm" data-testid="app-ai-retry" onClick={() => { void load() }}>
            <RefreshCw className="mr-1 h-4 w-4" />重试
          </Button>
        </div>
      ) : loading ? (
        <p className="text-sm text-muted-foreground" data-testid="app-ai-loading">读取中…</p>
      ) : data === null ? (
        /* 理论上不可达（成功分支必写 data）；真出现就按"没数据"处理 ——
           **不渲染 0**（0 会被读成"这个应用没人用 AI"）。 */
        <p className="text-sm text-muted-foreground" data-testid="app-ai-nodata">
          没有取到 AI 用量数据（既不是错误也不是 0 次调用）；请刷新重试。
        </p>
      ) : aiUsageIsEmpty(data) ? (
        /* 空状态（**不是** 0 次 / ¥0.00）：归因数据还没有出现。 */
        <EmptyState
          icon={<Sparkles className="h-6 w-6" />}
          title="该应用还没有 AI 调用记录"
          desc="应用页调用 AI 后（应用前端 → 客户端 AI 链路）才会产生归因数据；这里的空白表示“暂无归因数据”，不代表 0 次调用。"
        />
      ) : (
        /* 上面已判 `data !== null` ⇒ 这一段里**不再用可选链**（可选链会让"分支保证
           非空"这句注释变成谎言，也会掩盖将来把判定改松的改动）。 */
        <>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>
              调用次数 <span className="font-mono text-foreground" data-testid="app-ai-calls">{countText(data.calls)}</span>
            </span>
            <span>
              tokens <span className="font-mono text-foreground" data-testid="app-ai-tokens">{countText(data.total_tokens)}</span>
              {/* 明细字段与 headline 同一套缺失语义：缺字段 ⇒ —（不是 0）。 */}
              <span className="ml-1">（输入 {tokensText(data.prompt_tokens)} / 输出 {tokensText(data.completion_tokens)}）</span>
            </span>
            <span>
              费用 <span className="font-mono text-foreground" data-testid="app-ai-cost">{fmtY(data.cost)}</span>
            </span>
          </div>

          {days.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>日期</TableHead>
                  <TableHead className="text-right">调用</TableHead>
                  <TableHead className="text-right">tokens</TableHead>
                  <TableHead className="text-right">费用</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody data-testid="app-ai-days">
                {days.map((d) => (
                  <TableRow key={String(d.day ?? '')} data-testid={`app-ai-day-${d.day ?? ''}`}>
                    <TableCell className="font-mono text-xs">{typeof d.day === 'string' && d.day !== '' ? d.day : '—'}</TableCell>
                    <TableCell className="text-right font-mono" data-testid={`app-ai-day-calls-${d.day ?? ''}`}>{countText(d.calls)}</TableCell>
                    <TableCell className="text-right font-mono" data-testid={`app-ai-day-tokens-${d.day ?? ''}`}>{tokensText(d.tokens)}</TableCell>
                    <TableCell className="text-right font-mono" data-testid={`app-ai-day-cost-${d.day ?? ''}`}>{fmtY(d.cost)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </>
      )}

      <p className="text-[11px] leading-relaxed text-muted-foreground">{AI_ATTRIBUTION_NOTE}</p>
    </section>
  )
}
