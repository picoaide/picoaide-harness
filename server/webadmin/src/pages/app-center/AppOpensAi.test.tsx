import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ApiError, request } from '../../api'
import { setCurrentAdmin, type MeUser } from '../../lib/rbac'
import { AppAiUsageSection } from './AppAiUsageSection'
import { AppOpensSection } from './AppOpensSection'

// ---------------------------------------------------------------------------
// 应用详情抽屉的两个运营面板（F16 ② §8.9 / §21.4）：
//   「打开次数」= GET /wasm-apps/:app_id/opens?from=&to=&granularity=day|dept
//   「AI 用量」 = GET /wasm-apps/:app_id/ai-usage
//
// 守的口径（每条都在注释里写了变异点）：
//   ① PV 不去重、UV 只能取服务端窗口值（本地求和即红）；
//   ② 端点缺失/形状漂移 ⇒ 明说"服务端尚未提供/结构不符"，数字显示 `—`（不是 0）；
//   ③ AI 用量无归因数据 ⇒ 空状态（不是 0 次 / ¥0.00）；
//   ④ 只读权限：无 capability:read 时不发请求。
// ---------------------------------------------------------------------------

vi.mock('../../components/chart-lazy', () => ({
  ChartLazy: () => <div data-testid="chart-mock" />,
}))

// 部门名映射走 dept:read（与 capability:read 不同源）⇒ 默认夹具带上它。
const SUPER: MeUser = { role: 'super_admin', permissions: ['capability:read', 'dept:read'] }

/**
 * 服务端**已落地**的响应形状（`serverstore.WasmOpenSeries`，核对 2026-09-20）：
 *   - 区间合计是 `total_pv` / `total_uv`（不是 pv/uv）；
 *   - `granularity=day` 的 SQL 是 `GROUP BY day, dept_id` ⇒ **同一天可能多行**
 *     （下面 09-19 刻意给两行，用来钉住"按日合并 + UV 加总口径"的文案）；
 *   - `granularity=dept` 的行 `day` 为空串，且**没有部门名**（只有 dept_id）。
 */
const OPENS_DAY = {
  app_id: 'share-note', from: '2026-08-21', to: '2026-09-19', granularity: 'day',
  total_pv: 6, total_uv: 3,
  points: [
    { day: '2026-09-17', dept_id: 1, pv: 1, uv: 1 },
    { day: '2026-09-18', dept_id: 1, pv: 2, uv: 2 },
    { day: '2026-09-19', dept_id: 1, pv: 2, uv: 2 },
    { day: '2026-09-19', dept_id: 2, pv: 1, uv: 1 },
  ],
  detail_retention_days: 90,
}
const OPENS_DEPT = {
  app_id: 'share-note', granularity: 'dept', total_pv: 6, total_uv: 3,
  points: [
    { day: '', dept_id: 2, pv: 2, uv: 1 },
    { day: '', dept_id: 1, pv: 3, uv: 2 },
    { day: '', dept_id: 0, pv: 1, uv: 1 },
  ],
  detail_retention_days: 90,
}

const mockRequest = vi.mocked(request)
let opensMode: 'ok' | 'missing' | 'drift' = 'ok'
/**
 * AI 用量响应的档位（**服务端真实形状**，设计 §5.1c B）：
 *   - `no_attribution`：`attribution_available=false`（平台还没有任何带归因的 usage 行）；
 *   - `zero_calls`：`attribution_available=true` 而本应用全零（**确实**没调过模型）；
 *   - `indeterminate`：缺 `attribution_available`（形状漂移，两档都不能下结论）；
 *   - `data` / `missing`（404）/ `drift`（缺 days 数组）。
 */
let aiMode: 'no_attribution' | 'zero_calls' | 'indeterminate' | 'data' | 'missing' | 'drift' = 'no_attribution'

/** 服务端全零合计（`WasmAppAIUsageDay` 的真实键，§5.1c B）。 */
const AI_ZERO_TOTAL = {
  day: '', requests: 0, prompt_tokens: 0, completion_tokens: 0, cache_prompt_tokens: 0, cost: 0,
}

beforeEach(() => {
  setCurrentAdmin(SUPER)
  opensMode = 'ok'
  aiMode = 'no_attribution'
  mockRequest.mockReset()
  mockRequest.mockImplementation(async (path: string) => {
    const p = String(path)
    if (p.includes('/opens')) {
      if (opensMode === 'missing') throw new ApiError(404, 'NOT_FOUND', '请求的资源不存在')
      if (opensMode === 'drift') return { app_id: 'share-note' }
      return p.includes('granularity=dept') ? OPENS_DEPT : OPENS_DAY
    }
    // 部门名映射（best-effort；服务端 opens 响应不含部门名）。
    if (p === '/api/server/admin/departments') {
      return { departments: [{ id: 1, name: '研发部' }, { id: 2, name: '市场部' }] }
    }
    if (p.includes('/ai-usage')) {
      if (aiMode === 'missing') throw new ApiError(404, 'NOT_FOUND', '请求的资源不存在')
      if (aiMode === 'drift') return { app_id: 'share-note' }
      if (aiMode === 'indeterminate') return { app_id: 'share-note', days: [], total: AI_ZERO_TOTAL }
      if (aiMode === 'zero_calls') {
        return {
          app_id: 'share-note', from: '2026-08-21', to: '2026-09-19',
          days: [], total: AI_ZERO_TOTAL, attribution_available: true,
        }
      }
      if (aiMode === 'data') {
        return {
          app_id: 'share-note', from: '2026-08-21', to: '2026-09-19',
          days: [
            { day: '2026-09-18', requests: 1, prompt_tokens: 300, completion_tokens: 200, cache_prompt_tokens: 0, cost: 0.05 },
            { day: '2026-09-19', requests: 3, prompt_tokens: 700, completion_tokens: 300, cache_prompt_tokens: 0, cost: 0.2 },
          ],
          total: { day: '', requests: 4, prompt_tokens: 1000, completion_tokens: 500, cache_prompt_tokens: 0, cost: 0.25 },
          attribution_available: true,
        }
      }
      return {
        app_id: 'share-note', from: '2026-08-21', to: '2026-09-19',
        days: [], total: AI_ZERO_TOTAL, attribution_available: false,
      }
    }
    return {}
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  setCurrentAdmin(null)
})

const OVERVIEW = { days: 7, todayPv: 3, todayUv: 2, windowPv: 6, windowUv: 3 }

describe('打开次数面板 · 口径', () => {
  it('窗口 PV/UV 取服务端值：UV 是窗口去重值（3），不是逐日 UV 之和（5）', async () => {
    render(<AppOpensSection appId="share-note" canRead overview={OVERVIEW} />)
    // 变异验证：把 data.uv 换成逐日 UV 求和 ⇒ 这里会读到 5，用例必红。
    await waitFor(() => { expect(screen.getByTestId('app-opens-range-pv')).toHaveTextContent('6') })
    expect(screen.getByTestId('app-opens-range-uv')).toHaveTextContent('3')
    // 列表那份聚合的今日/近 7 日数字直接复用（不重复请求）
    expect(screen.getByTestId('app-opens-today-pv')).toHaveTextContent('3')
    expect(screen.getByTestId('app-opens-window-pv')).toHaveTextContent('6')
    expect(await screen.findByTestId('app-opens-trend')).toContainElement(screen.getByTestId('chart-mock'))
    // 保留期/隐私说明必须在面板里（§19 Q11 的告知口径）
    expect(screen.getByTestId('app-opens-block').textContent).toContain('90 天')
    expect(screen.getByTestId('app-opens-block').textContent).toContain('capability:read')
  })

  it('生效窗口来自服务端回显（R2-L6-3：窗口不得静默退化、必须渲染）', async () => {
    // 变异验证：把 app-opens-effective-window 那段渲染删掉 / 或把 from/to 换成
    // 本地请求窗口 ⇒ 本用例必红（管理员将无从察觉服务端实际用的区间）。
    render(<AppOpensSection appId="share-note" canRead overview={OVERVIEW} />)
    await waitFor(() => { expect(screen.getByTestId('app-opens-range-pv')).toHaveTextContent('6') })
    const text = screen.getByTestId('app-opens-effective-window').textContent ?? ''
    expect(text).toContain('生效窗口：2026-08-21 ~ 2026-09-19')
    expect(text).toContain('明细保留 90 天')
  })

  it('「全部（长期日汇总）」显式请求 90 天窗口（不再用"不传参"表达全部）', async () => {
    // R2-L6-3 的现场：`days: 0` ⇒ 不传 from/to ⇒ 服务端静默回落近 7 天。
    // 变异验证：把该档改回 days: 0（不带 from/to）⇒ 本用例必红（URL 里没有 from/to）。
    render(<AppOpensSection appId="share-note" canRead overview={OVERVIEW} />)
    await waitFor(() => { expect(screen.getByTestId('app-opens-range-pv')).toHaveTextContent('6') })
    mockRequest.mockClear()
    fireEvent.click(screen.getByTestId('app-opens-range'))
    fireEvent.click(await screen.findByRole('option', { name: /全部（长期日汇总/ }))
    let call = ''
    await waitFor(() => {
      call = mockRequest.mock.calls.map(([p]) => String(p)).find((p) => p.includes('/opens?')) ?? ''
      expect(call).not.toBe('')
    })
    const q = new URLSearchParams(call.split('?')[1] ?? '')
    expect(q.get('granularity')).toBe('day')
    const from = q.get('from')
    const to = q.get('to')
    expect(from).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(to).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    // 「全部」= 明细保留期上限：窗口必须是 90 天（含两端 ⇒ 相差 89 天），而不是 7 天。
    const spanDays = Math.round(
      (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000,
    )
    expect(spanDays).toBe(89)
  })

  it('聚合不可用（overview=null）⇒ 概览显示 —（不是 0），详情照常独立取数', async () => {
    render(<AppOpensSection appId="share-note" canRead overview={null} />)
    await waitFor(() => { expect(screen.getByTestId('app-opens-range-pv')).toHaveTextContent('6') })
    expect(screen.getByTestId('app-opens-today-pv')).toHaveTextContent('—')
    expect(screen.getByTestId('app-opens-window-uv')).toHaveTextContent('—')
  })

  it('按部门：部门名 best-effort 映射（dept:read），行按 PV 降序，未归属部门单独成行', async () => {
    render(<AppOpensSection appId="share-note" canRead overview={OVERVIEW} />)
    fireEvent.click(screen.getByTestId('app-opens-granularity'))
    fireEvent.click(await screen.findByRole('option', { name: '按部门' }))
    const list = await screen.findByTestId('app-opens-dept-list')
    // 服务端只给 dept_id ⇒ 名字来自 GET /departments（异步）⇒ 等它落地。
    await waitFor(() => { expect(list.textContent).toContain('研发部') })
    const rows = Array.from(list.querySelectorAll('tr')).map((tr) => tr.textContent ?? '')
    expect(rows[0]).toContain('研发部')   // pv 3
    expect(rows[1]).toContain('市场部')   // pv 2
    expect(rows[2]).toContain('（未归属部门）') // dept_id = 0/NULL
    expect(screen.getByTestId('app-opens-dept-note').textContent).toContain('dept:read')
    // 部门名走的是既有部门接口（不新造端点）
    expect(mockRequest.mock.calls.some(([p]) => String(p) === '/api/server/admin/departments')).toBe(true)
  })

  it('没有 dept:read 权限 ⇒ 不发部门请求、显示「部门 #<id>」（不编名字、不报错）', async () => {
    // 权限点不同源：capability:read（打开次数）≠ dept:read（部门目录）。
    setCurrentAdmin({ role: 'auditor', permissions: ['capability:read'] })
    render(<AppOpensSection appId="share-note" canRead overview={OVERVIEW} />)
    fireEvent.click(screen.getByTestId('app-opens-granularity'))
    fireEvent.click(await screen.findByRole('option', { name: '按部门' }))
    const list = await screen.findByTestId('app-opens-dept-list')
    expect(list.textContent).toContain('部门 #1')
    expect(mockRequest.mock.calls.some(([p]) => String(p) === '/api/server/admin/departments')).toBe(false)
  })

  it('端点缺失 ⇒ 明说"服务端尚未提供"并点名路径，数字显示 —', async () => {
    // 变异验证：把 404 分类删掉（回落成通用失败文案）⇒ 第一条断言红。
    opensMode = 'missing'
    render(<AppOpensSection appId="share-note" canRead overview={OVERVIEW} />)
    const failure = await screen.findByTestId('app-opens-failure')
    expect(failure.textContent).toContain('404')
    expect(failure.textContent).toContain('/api/server/admin/wasm-apps/share-note/opens')
    expect(screen.getByTestId('app-opens-range-pv')).toHaveTextContent('—')
  })

  it('形状漂移 ⇒ 按"结构不符合契约"提示，而不是"该窗口没有打开记录"', async () => {
    opensMode = 'drift'
    render(<AppOpensSection appId="share-note" canRead overview={OVERVIEW} />)
    const failure = await screen.findByTestId('app-opens-failure')
    expect(failure.textContent).toContain('points')
    expect(screen.queryByTestId('app-opens-empty')).toBeNull()
  })

  it('窗口内确实没有记录 ⇒ 明确的空态文案', async () => {
    mockRequest.mockImplementation(async () => ({ app_id: 'share-note', granularity: 'day', pv: 0, uv: 0, points: [] }))
    render(<AppOpensSection appId="share-note" canRead overview={OVERVIEW} />)
    expect(await screen.findByTestId('app-opens-empty')).toHaveTextContent('没有打开记录')
  })

  it('服务端 200 但明细缺字段（形状漂移）⇒ 单元格显示 —，不是 0（CTL-11）', async () => {
    // 主控预审计 CTL-11：失败/空态之外，**有数据分支**也不能把缺字段渲染成 0 ——
    // 同一屏 headline 显示 —、明细显示 0 = 两套缺失语义，且掩盖契约漂移。
    // 变异验证：把部门单元格改回 `fmtFull(Number(d.pv ?? 0))`、把按日点改回
    // `Number(p.pv ?? 0)` ⇒ 本用例必红。
    mockRequest.mockImplementation(async (path: string) => {
      const p = String(path)
      if (p === '/api/server/admin/departments') return { departments: [{ id: 1, name: '研发部' }] }
      if (p.includes('granularity=dept')) {
        // total_pv/total_uv 在场，但每行缺 pv/uv 字段。
        return {
          app_id: 'share-note', granularity: 'dept', total_pv: 6, total_uv: 3,
          points: [{ day: '', dept_id: 1 }, { day: '', dept_id: 0, pv: 1, uv: 1 }],
          detail_retention_days: 90,
        }
      }
      return {}
    })
    render(<AppOpensSection appId="share-note" canRead overview={OVERVIEW} />)
    fireEvent.click(screen.getByTestId('app-opens-granularity'))
    fireEvent.click(await screen.findByRole('option', { name: '按部门' }))
    await screen.findByTestId('app-opens-dept-list')
    expect(screen.getByTestId('app-opens-dept-pv-1')).toHaveTextContent('—')
    expect(screen.getByTestId('app-opens-dept-uv-1')).toHaveTextContent('—')
    // 有值的行照常显示数字（不是整表退化成 —）
    expect(screen.getByTestId('app-opens-dept-pv-none')).toHaveTextContent('1')
  })

  it('按日点缺 pv/uv ⇒ 不画该点并显式提示跳过数量（不按 0 画线）', async () => {
    mockRequest.mockImplementation(async (path: string) => {
      const p = String(path)
      if (p.includes('/opens')) {
        return {
          app_id: 'share-note', granularity: 'day', total_pv: 3, total_uv: 2,
          points: [
            { day: '2026-09-18', dept_id: 1, pv: 2, uv: 1 },
            { day: '2026-09-19', dept_id: 1 }, // 漂移行：缺 pv/uv
          ],
          detail_retention_days: 90,
        }
      }
      return {}
    })
    render(<AppOpensSection appId="share-note" canRead overview={OVERVIEW} />)
    const note = await screen.findByTestId('app-opens-trend-skipped')
    expect(note.textContent).toContain('跳过这些点')
    expect(note.textContent).toContain('不是按 0 画点')
    // 仍有一个有效点（09-18）⇒ 图还在；区间合计取服务端值不受影响。
    expect(screen.getByTestId('app-opens-trend')).toBeInTheDocument()
    expect(screen.getByTestId('app-opens-range-pv')).toHaveTextContent('3')
  })

  it('没有 capability:read ⇒ 不发请求，给权限说明', async () => {
    render(<AppOpensSection appId="share-note" canRead={false} overview={null} />)
    expect(await screen.findByTestId('app-opens-noperm')).toHaveTextContent('capability:read')
    expect(mockRequest).not.toHaveBeenCalled()
  })
})

describe('AI 用量面板 · 「无归因记录」/「确实零调用」/ 有数据 / 降级（§5.1c B）', () => {
  it('attribution_available=false ⇒ "暂无应用归因记录"，明说**不是 0 次调用**、不渲染 0', async () => {
    // 变异验证：把 aiUsageView 的 no_attribution 分支去掉（落到 zero_calls 或 data）⇒
    // 本用例必红 —— §21.4：两者数字都是 0、含义相反，合并渲染就是在编数据。
    render(<AppAiUsageSection appId="share-note" canRead />)
    expect(await screen.findByText('暂无应用归因记录')).toBeInTheDocument()
    expect(screen.queryByTestId('app-ai-calls')).toBeNull()
    const block = screen.getByTestId('app-ai-usage-block')
    expect(block.textContent).toContain('attribution_available=false')
    expect(block.textContent).toContain('这不是 0 次调用')
    // 归因说明（R13-GB 起语义收窄）：账单归使用者账号；归因走**会话链路**
    //（隐藏会话 id 的 `app:` 前缀 ⇒ 上游出站头），并且**不得**再说"平台侧尚未接线"
    // —— 那是接线前的成因；现在这么写就是在编数据（成因由 AI_ATTRIBUTION_WIRING 决定，
    // 通道若再次断开，对拍用例会先把常量改回 not_wired 并改回相应文案）。
    expect(block.textContent).toContain('app:')
    expect(block.textContent).toContain('x-deepseek-harness-session-id')
    expect(block.textContent).not.toContain('尚未接线')
  })

  it('attribution_available=true 且全零 ⇒ "确实零调用"（**与上一档文案不同**）', async () => {
    // 变异验证：把两档合并成同一句文案 ⇒ 本用例与上一条必有一条红。
    aiMode = 'zero_calls'
    render(<AppAiUsageSection appId="share-note" canRead />)
    expect(await screen.findByText('该应用确实零调用')).toBeInTheDocument()
    expect(screen.queryByText('暂无应用归因记录')).toBeNull()
    expect(screen.getByTestId('app-ai-usage-block').textContent).toContain('attribution_available=true')
    // 空状态不渲染 0 次 / ¥0.00 的行（数字行只在 data 档出现）。
    expect(screen.queryByTestId('app-ai-calls')).toBeNull()
  })

  it('缺 attribution_available ⇒ "无法判断"（既不说零调用，也不显示 0）', async () => {
    // 变异验证：把下面这条 indeterminate 分支删掉（回落成 zero_calls）⇒ 必红。
    aiMode = 'indeterminate'
    render(<AppAiUsageSection appId="share-note" canRead />)
    const note = await screen.findByTestId('app-ai-indeterminate')
    expect(note.textContent).toContain('无法判断')
    expect(note.textContent).toContain('attribution_available')
    expect(screen.queryByTestId('app-ai-calls')).toBeNull()
  })

  it('有数据 ⇒ 次数 / tokens（输入+输出）/ 费用 + 按日明细（新到旧）', async () => {
    aiMode = 'data'
    render(<AppAiUsageSection appId="share-note" canRead />)
    expect(await screen.findByTestId('app-ai-calls')).toHaveTextContent('4')
    // 服务端只给分项 ⇒ 总数 = 输入 1000 + 输出 500 = 1500（headline 用千分位）。
    expect(screen.getByTestId('app-ai-tokens')).toHaveTextContent('1,500')
    expect(screen.getByTestId('app-ai-cost').textContent).toContain('0.25')
    const days = screen.getByTestId('app-ai-days')
    expect(days.textContent).toContain('2026-09-19')
    expect(days.textContent).toContain('2026-09-18')
    // 按日明细同样按服务端形状读（requests / 输入+输出 / cost）。
    expect(screen.getByTestId('app-ai-day-calls-2026-09-19')).toHaveTextContent('3')
    expect(screen.getByTestId('app-ai-day-tokens-2026-09-19')).toHaveTextContent('1K')
    // 生效窗口来自服务端回显（不显示它 = 管理员不知道看的是哪一段）。
    expect(screen.getByTestId('app-ai-effective-window').textContent).toContain('2026-08-21 ~ 2026-09-19')
  })

  it('请求带显式窗口（days=），不靠服务端缺省（静默窗口与 R2-L6-3 同类）', async () => {
    render(<AppAiUsageSection appId="share-note" canRead />)
    await screen.findByTestId('app-ai-usage-block')
    expect(mockRequest.mock.calls.some(
      ([p]) => String(p) === '/api/server/admin/wasm-apps/share-note/ai-usage?days=30',
    )).toBe(true)
  })

  it('AI 明细缺字段（200 但少下发 prompt_tokens / 按日 requests）⇒ —，不是 0（CTL-11）', async () => {
    // 变异验证：把明细单元格改回 `Number(x ?? 0)` ⇒ 本用例必红（会读到 "0"）。
    mockRequest.mockImplementation(async () => ({
      app_id: 'share-note', from: '2026-08-21', to: '2026-09-19',
      // total 里 prompt_tokens/completion_tokens 与按日行的 requests/cost 全部缺失。
      days: [{ day: '2026-09-19' }],
      total: { requests: 2, cost: 0.5 },
      attribution_available: true,
    }))
    render(<AppAiUsageSection appId="share-note" canRead />)
    expect(await screen.findByTestId('app-ai-calls')).toHaveTextContent('2')
    expect(screen.getByTestId('app-ai-cost').textContent).toContain('0.50')
    const block = screen.getByTestId('app-ai-usage-block')
    expect(block.textContent).toContain('输入 —')
    expect(block.textContent).toContain('输出 —')
    expect(screen.getByTestId('app-ai-day-calls-2026-09-19')).toHaveTextContent('—')
    expect(screen.getByTestId('app-ai-day-cost-2026-09-19')).toHaveTextContent('—')
    // 总 token 由输入+输出得出 ⇒ 分项缺失时是 —（不是 0）。
    expect(screen.getByTestId('app-ai-tokens')).toHaveTextContent('—')
  })

  it('端点缺失 ⇒ 明说"服务端尚未提供该端点"（AI 用量维度随 0076 迁移落地）', async () => {
    aiMode = 'missing'
    render(<AppAiUsageSection appId="share-note" canRead />)
    const failure = await screen.findByTestId('app-ai-failure')
    expect(failure.textContent).toContain('404')
    expect(failure.textContent).toContain('/api/server/admin/wasm-apps/share-note/ai-usage')
    expect(screen.queryByTestId('app-ai-calls')).toBeNull()
  })

  it('形状漂移（缺 days）⇒ 不把"解析不出来"说成"没有调用记录"', async () => {
    // 旧契约要的 `points` 服务端从不下发 —— 这条就是 R2-L6-2 的现场回归判据。
    aiMode = 'drift'
    render(<AppAiUsageSection appId="share-note" canRead />)
    const failure = await screen.findByTestId('app-ai-failure')
    expect(failure.textContent).toContain('days')
    expect(screen.queryByText('暂无应用归因记录')).toBeNull()
    expect(screen.queryByText('该应用确实零调用')).toBeNull()
  })

  it('没有 capability:read ⇒ 不发请求，给权限说明', async () => {
    render(<AppAiUsageSection appId="share-note" canRead={false} />)
    expect(await screen.findByTestId('app-ai-noperm')).toHaveTextContent('capability:read')
    expect(mockRequest).not.toHaveBeenCalled()
  })
})
