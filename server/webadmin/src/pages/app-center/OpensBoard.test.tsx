import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ApiError, request } from '../../api'
import { setCurrentAdmin, type MeUser } from '../../lib/rbac'
import OpensBoard from './OpensBoard'

// ---------------------------------------------------------------------------
// 运营看板（F16，契约 §3 F16 / §8.9 / §19 Q13）。
//
// 这组用例守四条：
//   ① PV 不去重 / UV 去重（窗口 UV 取服务端值，**不等于**逐日 UV 之和）；
//   ② 缺后端（404）与形状漂移 ⇒ 明说"服务端尚未提供 / 结构不符" + 数字显示 `—`，
//      **绝不显示 0**（把"读不到"显示成 0 会让管理员以为没人用应用）；
//   ③ TOP N 由前端兜底排序与截断（服务端乱序/多返回都不改变页面）；
//   ④ 只读权限：没有 capability:read 时不发注定 403 的请求。
// ---------------------------------------------------------------------------

vi.mock('../../components/chart-lazy', () => ({
  ChartLazy: () => <div data-testid="chart-mock" />,
}))

const SUPER: MeUser = { role: 'super_admin', permissions: ['capability:read', 'capability:write'] }
const NO_CAP: MeUser = { role: 'user', permissions: [] }

/**
 * 聚合夹具：`totals.uv = 3` **小于**逐日 UV 之和（1+2+2=5），
 * `totals.pv = 6` 等于逐日 PV 之和（不去重可相加）。
 */
const SUMMARY = {
  days: 7,
  top: 10,
  today: { day: '2026-09-19', pv: 3, uv: 2 },
  totals: { pv: 6, uv: 3 },
  trend: [
    { day: '2026-09-17', pv: 1, uv: 1 },
    { day: '2026-09-18', pv: 2, uv: 2 },
    { day: '2026-09-19', pv: 3, uv: 2 },
  ],
  apps: [{ app_id: 'a', today_pv: 3, today_uv: 2, window_pv: 9, window_uv: 2 }],
  // **乱序** + 12 行（> TOP 10）：前端必须自己排序并截断。
  // 前四行有真实 PV；f1..f8 是 pv=0 的填充行，用来验证"只显示 TOP N 行"。
  top_apps: [
    { app_id: 'c', title: '丙应用', pv: 1, uv: 1 },
    { app_id: 'a', title: '甲应用', pv: 9, uv: 2 },
    { app_id: 'd', title: '丁应用', pv: 9, uv: 5 },
    { app_id: 'b', title: '乙应用', pv: 4, uv: 3 },
    ...Array.from({ length: 8 }, (_, i) => ({ app_id: `f${i + 1}`, title: `填充${i + 1}`, pv: 0, uv: 0 })),
  ],
  detail_retention_days: 90,
}

const mockRequest = vi.mocked(request)
let mode: 'ok' | 'missing' | 'drift' = 'ok'

beforeEach(() => {
  setCurrentAdmin(SUPER)
  mode = 'ok'
  mockRequest.mockReset()
  mockRequest.mockImplementation(async (path: string) => {
    if (String(path).startsWith('/api/server/admin/wasm-apps/opens/summary')) {
      if (mode === 'missing') throw new ApiError(404, 'NOT_FOUND', '请求的资源不存在')
      if (mode === 'drift') return { days: 7, trend: [] }
      return SUMMARY
    }
    return {}
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  setCurrentAdmin(null)
})

/** 渲染并等到**取数结束**（KPI 卡在加载态就已存在，只等元素会读到占位的 —）。 */
async function renderBoard() {
  render(<OpensBoard />)
  await waitFor(() => {
    expect(screen.queryByTestId('opens-loading')).toBeNull()
  })
}

describe('运营看板 · KPI 与趋势', () => {
  it('今日 PV/UV 取服务端原值；窗口 PV 可累加、窗口 UV 取服务端去重值', async () => {
    await renderBoard()
    expect(screen.getByTestId('opens-today-pv')).toHaveTextContent('3')
    expect(screen.getByTestId('opens-today-uv')).toHaveTextContent('2')
    // PV：totals.pv = 6（= 1+2+3，每次打开 +1）
    expect(screen.getByTestId('opens-window-pv')).toHaveTextContent('6')
    // UV：**服务端**去重值 3 —— 变异验证：改成逐日相加会得到 5，本断言必红。
    expect(screen.getByTestId('opens-window-uv')).toHaveTextContent('3')

    expect(await screen.findByTestId('opens-trend')).toContainElement(screen.getByTestId('chart-mock'))
    expect(screen.getByTestId('opens-notes').textContent).toContain('PV = 每次打开都 +1（不去重）')
    expect(screen.getByTestId('opens-notes').textContent).toContain('90 天')
  })

  it('窗口切换 / TOP N 切换都进查询串（服务端才是聚合真源）', async () => {
    await renderBoard()
    fireEvent.click(screen.getByTestId('opens-days'))
    fireEvent.click(await screen.findByRole('option', { name: '近 30 天' }))
    await waitFor(() => {
      expect(mockRequest.mock.calls.some(([p]) => String(p).includes('days=30'))).toBe(true)
    })
    fireEvent.click(screen.getByTestId('opens-topn'))
    fireEvent.click(await screen.findByRole('option', { name: 'TOP 20' }))
    await waitFor(() => {
      expect(mockRequest.mock.calls.some(([p]) => String(p).includes('top=20'))).toBe(true)
    })
  })

  it('服务端没给窗口 UV 时显示 — 并说明"不能由逐日 UV 相加得出"', async () => {
    mockRequest.mockImplementation(async () => {
      const { totals: _drop, ...rest } = SUMMARY
      return rest
    })
    await renderBoard()
    // PV 仍可由趋势累加（不去重）
    expect(screen.getByTestId('opens-window-pv')).toHaveTextContent('6')
    expect(screen.getByTestId('opens-window-uv')).toHaveTextContent('—')
    expect(screen.getByTestId('opens-uv-note').textContent).toContain('逐日 UV 相加')
  })
})

describe('运营看板 · TOP N 排序与截断', () => {
  it('乱序输入按 PV 降序（UV 次序）排名，且只显示 TOP N 行', async () => {
    // 夹具：a(pv9,uv2) / d(pv9,uv5) / b(pv4) / c(pv1) —— 期望 d, a, b。
    // 变异验证：去掉 rankTopApps 的 sort 或 slice ⇒ 名次/行数断言必红。
    await renderBoard()
    const list = await screen.findByTestId('opens-top-list')
    const ids = Array.from(list.querySelectorAll('tr')).map((tr) => tr.getAttribute('data-testid'))
    expect(ids.slice(0, 4)).toEqual(['opens-top-d', 'opens-top-a', 'opens-top-b', 'opens-top-c'])
    expect(screen.getByTestId('opens-rank-d')).toHaveTextContent('1')
    expect(screen.getByTestId('opens-rank-a')).toHaveTextContent('2')
    // TOP N（默认 10）：12 行里只显示 10 行，最小的两行被截掉。
    // 变异验证：去掉 rankTopApps 的 slice ⇒ 行数断言必红。
    expect(ids).toHaveLength(10)
    expect(screen.queryByTestId('opens-top-f7')).toBeNull()
    expect(screen.queryByTestId('opens-top-f8')).toBeNull()
    // 数字是应用维度的真值
    expect(screen.getByTestId('opens-pv-d')).toHaveTextContent('9')
    expect(screen.getByTestId('opens-uv-d')).toHaveTextContent('5')
  })
})

describe('运营看板 · 降级（缺后端不得显示 0）', () => {
  it('404 ⇒ 明说"服务端尚未提供该端点"，KPI 显示 —（不是 0），并给重试', async () => {
    // 变异验证：把 classifyEndpointFailure 的 404 分支去掉（回落成"读取失败"）⇒
    // 第一条断言红；把 countText(null) 改成 0 ⇒ 第二条断言红。
    mode = 'missing'
    render(<OpensBoard />)
    const failure = await screen.findByTestId('opens-failure')
    expect(failure.textContent).toContain('404')
    expect(failure.textContent).toContain('/api/server/admin/wasm-apps/opens/summary')
    expect(failure.textContent).toContain('不是 0')
    for (const id of ['opens-today-pv', 'opens-today-uv', 'opens-window-pv', 'opens-window-uv']) {
      expect(screen.getByTestId(id)).toHaveTextContent('—')
    }
    mode = 'ok'
    fireEvent.click(screen.getByTestId('opens-retry'))
    await waitFor(() => { expect(screen.getByTestId('opens-window-pv')).toHaveTextContent('6') })
  })

  it('形状漂移（缺 top_apps）⇒ 按"结构不符合契约"提示，而不是空看板', async () => {
    mode = 'drift'
    render(<OpensBoard />)
    const failure = await screen.findByTestId('opens-failure')
    expect(failure.textContent).toContain('top_apps')
    expect(failure.textContent).toContain('不是“没有数据”')
    expect(screen.getByTestId('opens-window-pv')).toHaveTextContent('—')
  })

  it('趋势点缺 pv/uv（服务端 200 但少下发字段）⇒ 不画 0、窗口 PV 显示 —（CTL-11）', async () => {
    // 主控预审计 CTL-11 的看板侧：明细/趋势也不能把"读不到"渲染成 0。
    // 变异验证：把趋势值改回 `Number(p.pv ?? 0)`、把窗口 PV 回落改成 `?? 0`
    // ⇒ 第一条（跳过提示）与第二条（窗口 PV = —）各有一处必红。
    mockRequest.mockImplementation(async () => ({
      days: 7, top: 10, today: { day: '2026-09-19', pv: 3, uv: 2 },
      // **没有 totals** ⇒ 窗口 PV 只能由趋势累加；而趋势里有一行缺 pv ⇒ 不可计算
      trend: [
        { day: '2026-09-18', pv: 3, uv: 2 },
        { day: '2026-09-19' }, // 漂移行：缺 pv/uv
      ],
      apps: [], top_apps: [], detail_retention_days: 90,
    }))
    await renderBoard()
    const note = await screen.findByTestId('opens-trend-skipped')
    expect(note.textContent).toContain('跳过')
    expect(note.textContent).toContain('不是按 0')
    // 缺字段 ⇒ 窗口 PV 不可计算 ⇒ —（而不是把缺的那天当 0 得出 3）
    expect(screen.getByTestId('opens-window-pv')).toHaveTextContent('—')
    expect(screen.getByTestId('opens-window-uv')).toHaveTextContent('—')
  })

  it('TOP 榜缺 uv 的行仍进榜，UV 单元格显示 —（不是 0）', async () => {
    mockRequest.mockImplementation(async () => ({
      days: 7, top: 10, today: null, totals: { pv: 5, uv: 2 }, trend: [],
      apps: [], top_apps: [{ app_id: 'a', title: '甲', pv: 5 }], detail_retention_days: 90,
    }))
    await renderBoard()
    expect(screen.getByTestId('opens-pv-a')).toHaveTextContent('5')
    expect(screen.getByTestId('opens-uv-a')).toHaveTextContent('—')
  })

  it('后端可用但窗口内没有打开记录 ⇒ 空态（0 是真值，可以显示）', async () => {
    mockRequest.mockImplementation(async () => ({
      days: 7, top: 10, today: { day: '2026-09-19', pv: 0, uv: 0 },
      totals: { pv: 0, uv: 0 }, trend: [], apps: [], top_apps: [], detail_retention_days: 90,
    }))
    await renderBoard()
    expect(screen.getByTestId('opens-window-pv')).toHaveTextContent('0')
    // 趋势卡与 TOP 卡的空态文案必须不同（同屏两句一样的话读不出哪块没数据）。
    expect(screen.getByText('窗口内还没有打开记录')).toBeInTheDocument()
    expect(screen.getByText('窗口内还没有应用上榜')).toBeInTheDocument()
  })
})

describe('运营看板 · 权限', () => {
  it('没有 capability:read ⇒ 不发请求，给权限说明（服务端 RequirePermission 才是护栏）', async () => {
    setCurrentAdmin(NO_CAP)
    render(<OpensBoard />)
    expect(await screen.findByText('没有查看运营看板的权限')).toBeInTheDocument()
    expect(mockRequest).not.toHaveBeenCalled()
  })
})
