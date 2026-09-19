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
let aiMode: 'empty' | 'data' | 'missing' | 'drift' = 'empty'

beforeEach(() => {
  setCurrentAdmin(SUPER)
  opensMode = 'ok'
  aiMode = 'empty'
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
      if (aiMode === 'drift') return { app_id: 'share-note', calls: 1 }
      if (aiMode === 'data') {
        return {
          app_id: 'share-note', calls: 4, prompt_tokens: 1000, completion_tokens: 500,
          total_tokens: 1500, cost: 0.25,
          points: [
            { day: '2026-09-18', calls: 1, tokens: 500, cost: 0.05 },
            { day: '2026-09-19', calls: 3, tokens: 1000, cost: 0.2 },
          ],
        }
      }
      return { app_id: 'share-note', calls: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost: 0, points: [] }
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

describe('AI 用量面板 · 空状态与降级', () => {
  it('无归因数据 ⇒ 空状态，**不渲染** 0 次 / ¥0.00', async () => {
    // 变异验证：把 aiUsageIsEmpty 分支删掉（直接渲染数字）⇒ 本用例必红
    // （会读到"0"），而"0 次调用"会被读成"这个应用没人用 AI"。
    render(<AppAiUsageSection appId="share-note" canRead />)
    expect(await screen.findByText('该应用还没有 AI 调用记录')).toBeInTheDocument()
    expect(screen.queryByTestId('app-ai-calls')).toBeNull()
    expect(screen.getByTestId('app-ai-usage-block').textContent).toContain('不代表 0 次调用')
    // 归因说明：账单归使用者账号 + 老客户端无归因
    expect(screen.getByTestId('app-ai-usage-block').textContent).toContain('X-Pico-App-Id')
  })

  it('有数据 ⇒ 次数 / tokens / 费用 + 按日明细（新到旧）', async () => {
    aiMode = 'data'
    render(<AppAiUsageSection appId="share-note" canRead />)
    expect(await screen.findByTestId('app-ai-calls')).toHaveTextContent('4')
    expect(screen.getByTestId('app-ai-tokens')).toHaveTextContent('1,500')
    expect(screen.getByTestId('app-ai-cost').textContent).toContain('0.25')
    const days = screen.getByTestId('app-ai-days')
    expect(days.textContent).toContain('2026-09-19')
    expect(days.textContent).toContain('2026-09-18')
  })

  it('AI 明细缺字段（200 但少下发 prompt_tokens/按日 calls）⇒ —，不是 0（CTL-11）', async () => {
    // 变异验证：把明细单元格改回 `fmtTokens(Number(x ?? 0))` / `fmtFull(Number(x ?? 0))`
    // ⇒ 本用例必红（会读到 "0"）。
    mockRequest.mockImplementation(async () => ({
      app_id: 'share-note', calls: 2, total_tokens: 900, cost: 0.5,
      // prompt_tokens / completion_tokens / 按日行的 calls / cost 全部缺失
      points: [{ day: '2026-09-19', tokens: 900 }],
    }))
    render(<AppAiUsageSection appId="share-note" canRead />)
    expect(await screen.findByTestId('app-ai-calls')).toHaveTextContent('2')
    expect(screen.getByTestId('app-ai-cost').textContent).toContain('0.50')
    // 明细两处：headline 括号里的输入/输出、按日表的 calls/cost 都必须是 —
    const block = screen.getByTestId('app-ai-usage-block')
    expect(block.textContent).toContain('输入 —')
    expect(block.textContent).toContain('输出 —')
    expect(screen.getByTestId('app-ai-day-calls-2026-09-19')).toHaveTextContent('—')
    expect(screen.getByTestId('app-ai-day-cost-2026-09-19')).toHaveTextContent('—')
    expect(screen.getByTestId('app-ai-day-tokens-2026-09-19')).toHaveTextContent('900')
  })

  it('端点缺失 ⇒ 明说"服务端尚未提供该端点"（AI 用量维度随 0076 迁移落地）', async () => {
    aiMode = 'missing'
    render(<AppAiUsageSection appId="share-note" canRead />)
    const failure = await screen.findByTestId('app-ai-failure')
    expect(failure.textContent).toContain('404')
    expect(failure.textContent).toContain('/api/server/admin/wasm-apps/share-note/ai-usage')
    expect(screen.queryByTestId('app-ai-calls')).toBeNull()
  })

  it('形状漂移（缺 points）⇒ 不把"解析不出来"说成"没有调用记录"', async () => {
    aiMode = 'drift'
    render(<AppAiUsageSection appId="share-note" canRead />)
    const failure = await screen.findByTestId('app-ai-failure')
    expect(failure.textContent).toContain('points')
    expect(screen.queryByText('该应用还没有 AI 调用记录')).toBeNull()
  })

  it('没有 capability:read ⇒ 不发请求，给权限说明', async () => {
    render(<AppAiUsageSection appId="share-note" canRead={false} />)
    expect(await screen.findByTestId('app-ai-noperm')).toHaveTextContent('capability:read')
    expect(mockRequest).not.toHaveBeenCalled()
  })
})
