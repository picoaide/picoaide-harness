import { useCallback, useEffect, useRef, useState } from 'react'
import { request } from '../../api'
import { Button } from '../../components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table'
import { EmptyState } from '../../components/empty-state'
import { fmtY } from '../usage/common'
import { RefreshCw, Sparkles } from 'lucide-react'
import {
  AI_ATTRIBUTION_NOTE,
  AI_USAGE_WINDOW_DAYS,
  aiUsagePath,
  aiUsageTokens,
  aiUsageView,
  classifyEndpointFailure,
  countText,
  effectiveWindowText,
  requireAiUsage,
  shapeDrift,
  tokensText,
  type AiUsage,
  type EndpointFailure,
} from './opens-contract'

/**
 * 应用详情抽屉 · 「AI 用量」面板（§21.1 第 12 问 / §21.4，台账 R2C-14 的 L6 落点）。
 *
 * 数据源：`GET /wasm-apps/:app_id/ai-usage?days=`（capability:read）
 * —— `usage` 表的**应用维度**（契约 §21.4：新迁移 0076 + 索引）。
 *
 * 响应形状**以服务端为准**（设计 §5.1c B）：
 * `{app_id,from,to,days:[{day,requests,prompt_tokens,completion_tokens,cache_prompt_tokens,cost}],
 *   total:{同结构},attribution_available}`。
 * 本面板此前读的是前端自订的 `{calls,total_tokens,points}` ⇒ 真实响应被判"缺少数组字段
 * points"，**整块面板永不出数**（R2-L6-2 现场）；现在按服务端形状读，并由
 * `opens-contract-parity.spec.ts` 读 Go 源码逐键对拍。
 *
 * 四条必须守住的语义：
 *   ① **账单归使用者账号，应用维度靠归因**：归因来自**会话链路** —— 隐藏会话 id 的
 *      `app:<app_id>` 前缀由上游出站头 `x-deepseek-harness-session-id` 带上，网关按前缀
 *      派生 `app_id`（§21.7⑤ 的替代路径；自报头 `X-Pico-App-Id` 发不出来，网关只识别并
 *      忽略）。链路已接线（`AI_ATTRIBUTION_WIRING === 'wired'`，三段锚点由
 *      `opens-contract-parity.spec.ts` 机械对拍）⇒ `attribution_available=false` 只表示
 *      "该窗口内没有带归因的调用"，**不得**再把成因推给客户端版本或客户环境；
 *   ② **"统计未上线" ≠ "零调用"**（§5.1c B / §21.4）：`attribution_available=false`
 *      ⇒ 渲染"统计尚未上线/无归因"；`true` 且全零 ⇒ 渲染"确实零调用"。
 *      两者数字都是 0、含义相反，合并渲染即违反 §21.4；
 *   ③ **缺后端不得显示 0**：端点 404 / 形状漂移 ⇒ 明说"服务端尚未提供"，数字显示 `—`；
 *   ④ **窗口不得静默**：显式请求 `days=`，并把服务端回显的生效窗口渲染出来。
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
      // 显式窗口（§5.1c B 的 `days=` 形态）：不传参就会落到服务端缺省的近 7 天，
      // 而那个回落只体现在响应里 —— 属于"静默窗口"（与 R2-L6-3 同类）。
      const raw = await request(aiUsagePath(appId, `days=${AI_USAGE_WINDOW_DAYS}`))
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
  const days = (data?.days ?? [])
    .slice()
    .sort((a, b) => String(b.day ?? '').localeCompare(String(a.day ?? '')))
    .slice(0, 14)

  /**
   * 面板状态（§5.1c B）：`data` / `zero_calls`（确实零调用）/ `no_attribution`
   * （统计尚未上线）/ `indeterminate`（缺字段，既不能说零也不能显示 0）。
   */
  const view = aiUsageView(data)

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
      ) : view === 'no_attribution' ? (
        /* 归因**无记录**（§5.1c B / §21.4）：服务端明确回报 attribution_available=false。
           这里绝不能写成"0 次调用"—— 那是另一种含义（统计已上线、本应用确实没调过）。
           成因**按 `AI_ATTRIBUTION_WIRING` 如实说**（R4-D-4 / R13-GB）：链路已接线时，
           这个 false 的唯一含义就是"该窗口内没有可归因的调用"；通道若再次断开，
           对拍用例会先把常量改回 `not_wired`，文案随之改说"平台侧这条链路还没接上"
           （`opens-contract-parity.spec.ts` 对这个说法做文本锚点双向断言）。 */
        <EmptyState
          icon={<Sparkles className="h-6 w-6" />}
          title="暂无应用归因记录"
          desc={
            '服务端回报 attribution_available=false：该窗口内平台还没有任何带应用归因的 AI 调用记录'
            + '（归因按隐藏会话 id 的 app: 前缀派生，链路已接线）。'
            + '这不是 0 次调用，而是「这个应用在本窗口内还没有走过应用 AI」。'
          }
        />
      ) : view === 'zero_calls' ? (
        /* 归因统计**可用**（attribution_available=true）而本应用全零 ⇒ 这才是"确实零调用"。 */
        <EmptyState
          icon={<Sparkles className="h-6 w-6" />}
          title="该应用确实零调用"
          desc={`服务端回报 attribution_available=true（归因统计已上线），而该应用在本窗口（${AI_USAGE_WINDOW_DAYS} 天）内确实没有 AI 调用记录：0 次 / ¥0.00。`}
        />
      ) : view === 'indeterminate' ? (
        /* 缺字段（形状漂移）：既不能说"零调用"，也不能渲染 0（CTL-11）。 */
        <p className="text-sm text-muted-foreground" data-testid="app-ai-indeterminate">
          无法判断归因状态：响应缺少 attribution_available 或计数分项（结构不符合契约）。
          这里既不能说"零调用"，也不能显示 0 —— 请核对服务端接口（见 §5.1c B）。
        </p>
      ) : (
        /* 上面已判 `data !== null` ⇒ 这一段里**不再用可选链取 data**（可选链会让
           "分支保证非空"这句注释变成谎言，也会掩盖将来把判定改松的改动）。 */
        <>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>
              调用次数 <span className="font-mono text-foreground" data-testid="app-ai-calls">{countText(data.total?.requests)}</span>
            </span>
            <span>
              tokens <span className="font-mono text-foreground" data-testid="app-ai-tokens">{countText(aiUsageTokens(data.total))}</span>
              {/* 明细字段与 headline 同一套缺失语义：缺字段 ⇒ —（不是 0）。
                  总 token 由前端的"输入 + 输出"得出（服务端只下发分项；缓存命中已含在输入里）。 */}
              <span className="ml-1">
                （输入 {tokensText(data.total?.prompt_tokens)} / 输出 {tokensText(data.total?.completion_tokens)}
                {' / '}缓存命中 {tokensText(data.total?.cache_prompt_tokens)}）
              </span>
            </span>
            <span>
              费用 <span className="font-mono text-foreground" data-testid="app-ai-cost">{fmtY(data.total?.cost)}</span>
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
                    <TableCell className="text-right font-mono" data-testid={`app-ai-day-calls-${d.day ?? ''}`}>{countText(d.requests)}</TableCell>
                    <TableCell className="text-right font-mono" data-testid={`app-ai-day-tokens-${d.day ?? ''}`}>{tokensText(aiUsageTokens(d))}</TableCell>
                    <TableCell className="text-right font-mono" data-testid={`app-ai-day-cost-${d.day ?? ''}`}>{fmtY(d.cost)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </>
      )}

      {/* 生效窗口（§5.1c C 同款纪律）：服务端回显的 from/to 必须渲染，
          否则管理员无从察觉自己看的是哪一段（缺省近 7 天）。 */}
      {!failure && data !== null && (
        <p className="text-[11px] text-muted-foreground" data-testid="app-ai-effective-window">
          {effectiveWindowText(data)}
        </p>
      )}

      <p className="text-[11px] leading-relaxed text-muted-foreground">{AI_ATTRIBUTION_NOTE}</p>
    </section>
  )
}
