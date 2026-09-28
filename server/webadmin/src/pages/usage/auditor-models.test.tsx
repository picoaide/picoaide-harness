import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { request } from '../../api'
import { setCurrentAdmin } from '../../lib/rbac'
import UsageLayout from './UsageLayout'
import UsageModels from './Models'
import UsageOverview from './Overview'
import { ROUTER_FUTURE } from '@/lib/router-future'

// 图表懒加载(VChart)在 jsdom 无 canvas:统一 mock 为占位(与 usage-center.test.tsx 同款)。
vi.mock('../../components/chart-lazy', () => ({
  ChartLazy: () => <div data-testid="chart-mock" />,
}))

// ---------------------------------------------------------------------------
// 审计 R7 residual(R7-RV-1):branding-3 只修了「用户」与「部门用量」两条路径,
// 同一张 TABS 表里的「模型分析」没做同样处理。
//
// 机理与 W3 完全同形:页面要求的权限域(usage:read)小于它首屏某个请求需要的
// 权限域(gateway:read —— 见 internal/router/router.go 的 GET /models),
// `Promise.all` 让一个 403 把整页(连同有权读的模型/渠道用量行)一起打掉,
// 只剩「没有权限执行该操作」。总览页的「上游账户余额」区块同理:GET /providers
// 403 被 catch 静默吞掉,区块永久为空且没有任何解释。
//
// 口径与已修的两条路径一致(前端不请求 + 正确文案;不动 rbac.go —— auditor 的
// 最小权限三元组是刻意设计),而不是给 auditor 加 gateway:read。
// ---------------------------------------------------------------------------
const mockRequest = vi.mocked(request)
const auditor = { role: 'auditor' as const, permissions: ['audit:read', 'usage:read', 'user:read'] }
const usageRow = (label: string, cost: number) => ({
  label, prompt_tokens: 100, completion_tokens: 50, requests: 2,
  embed_requests: 0, embed_tokens: 0, cache_tokens: 0, cost,
})

beforeEach(() => {
  mockRequest.mockReset()
  mockRequest.mockImplementation(async (path: string) => {
    if (path.startsWith('/api/server/admin/usage?group=model')) {
      return { rows: [usageRow('gpt-4o', 12.5), usageRow('deepseek-chat', 3.5)] }
    }
    if (path.startsWith('/api/server/admin/usage?group=provider')) {
      return { rows: [usageRow('upstream-a', 16)] }
    }
    if (path === '/api/server/admin/models') {
      // 真实服务端:RequirePermission(gateway:read) → 403。
      throw Object.assign(new Error('没有权限执行该操作'), { status: 403, code: 'FORBIDDEN' })
    }
    if (path === '/api/server/admin/providers') {
      throw Object.assign(new Error('没有权限执行该操作'), { status: 403, code: 'FORBIDDEN' })
    }
    if (path.startsWith('/api/server/admin/usage/overview')) {
      const rows = [usageRow('2026-09-01', 5)]
      return {
        today: { cost: 1, requests: 1 }, month: { cost: 10, requests: 10 },
        trend: rows, top_models: rows,
      }
    }
    return {}
  })
})

afterEach(() => setCurrentAdmin(null))

describe('审计员访问模型分析(R7-RV-1 residual)', () => {
  it('does not request the gateway-scoped model list and still renders the usage rows it may read', async () => {
    setCurrentAdmin(auditor)
    render(<MemoryRouter future={ROUTER_FUTURE} initialEntries={['/usage/models']}><UsageModels /></MemoryRouter>)

    // 有权读的用量行必须可见 —— 原来这里整页只有一句 403。
    expect(await screen.findByText('gpt-4o')).toBeInTheDocument()
    expect(screen.getByText('deepseek-chat')).toBeInTheDocument()
    expect(screen.getByText('upstream-a')).toBeInTheDocument()
    // 不是整页 403 空页。
    expect(screen.queryByText('没有权限执行该操作')).toBeNull()
    // 单价/模型名要 gateway:read:不请求那个注定 403 的接口。
    const paths = mockRequest.mock.calls.map(([p]) => String(p))
    expect(paths.some((p) => p === '/api/server/admin/models')).toBe(false)
    // 并给出解释(而不是静默显示 "—")。
    expect(screen.getAllByText(/gateway:read/).length).toBeGreaterThan(0)
  })

  it('keeps the 模型分析 tab visible for an auditor (usage:read is enough for this page)', () => {
    setCurrentAdmin(auditor)
    render(<MemoryRouter future={ROUTER_FUTURE} initialEntries={['/usage']}><UsageLayout /></MemoryRouter>)
    expect(screen.getByRole('link', { name: /模型分析/ })).toBeInTheDocument()
  })

  // 第三十二轮 FIX-47 子泳道 B：上面那条是**负例**（没有 gateway:read ⇒ 不请求、
  // 给说明）。负例对"权限点写错"不敏感 —— `hasPermission` 恒 false 时它照样通过。
  // 这一条是它的另一半：**显式授予 gateway:read** 时请求必须真的发出、单价必须
  // 真的渲染（目录与用量 join 得出来）。实参写成匹配不上的任何值（含行内字面量
  // `'gateway:raed'`）⇒ 本用例当场红。
  it('持有 gateway:read 时必须请求模型目录并渲染单价(正向夹具)', async () => {
    setCurrentAdmin({ role: 'super_admin', permissions: ['usage:read', 'gateway:read'] })
    mockRequest.mockImplementation(async (path: string) => {
      if (path.startsWith('/api/server/admin/usage?group=model')) {
        return { rows: [usageRow('gpt-4o', 12.5)] }
      }
      if (path.startsWith('/api/server/admin/usage?group=provider')) return { rows: [usageRow('upstream-a', 16)] }
      if (path === '/api/server/admin/models') {
        return {
          models: [{
            id: 1, name: 'gpt-4o', provider_id: 1, display_name: '', default_params: '{}',
            input_price_per_1m: 2, output_price_per_1m: 8, cache_input_price_per_1m: null, offpeak_discount: null,
          }],
        }
      }
      return {}
    })
    render(<MemoryRouter future={ROUTER_FUTURE} initialEntries={['/usage/models']}><UsageModels /></MemoryRouter>)

    // 单价来自 `/models`（gateway:read）与用量行的 join：没有权限时这一格是 "—"。
    expect(await screen.findByText('2.00 / 8.00')).toBeInTheDocument()
    expect(mockRequest.mock.calls.map(([p]) => String(p))).toContain('/api/server/admin/models')
    expect(screen.queryByText(/gateway:read/)).toBeNull()
  })
})

describe('用量中心子导航(TABS 表驱动实参 t.perm)', () => {
  // 第三十二轮 FIX-47 子泳道 B：`UsageLayout.tsx:35` 的实参是表驱动形态（`t.perm`，
  // 权限点来自同文件 `TABS` 常量表）。它被
  // `lib/nav.test.ts` 的调用点守卫**显式登记**放行，登记的前提是"表取值仍来自
  // rbac.ts 的 PERM_*"（结构判据）。本条是它的**行为**另一半：显式授予 TABS 里
  // 出现的全部权限点 ⇒ 7 个标签一个都不能少。
  it('持有全部权限点时 7 个标签全部可见(含 dept:read 的部门用量与 report:read 的报表订阅)', () => {
    setCurrentAdmin({ role: 'super_admin', permissions: ['usage:read', 'dept:read', 'user:read', 'report:read'] })
    render(<MemoryRouter future={ROUTER_FUTURE} initialEntries={['/usage']}><UsageLayout /></MemoryRouter>)
    for (const label of ['总览', '部门用量', '成员用量', '模型分析', '请求日志', '余额', '报表订阅']) {
      expect(screen.getByRole('link', { name: new RegExp(label) })).toBeInTheDocument()
    }
  })
})

describe('审计员访问用量总览的上游余额区块(R7-RV-1 residual)', () => {
  it('explains the missing permission instead of silently rendering an empty balance block', async () => {
    setCurrentAdmin(auditor)
    render(<MemoryRouter future={ROUTER_FUTURE} initialEntries={['/usage']}><UsageOverview /></MemoryRouter>)

    // KPI 数据(usage:read)照常渲染。
    expect(await screen.findByTestId('overview-kpis')).toBeInTheDocument()
    // 上游余额要 gateway:read:不请求、且给出可读解释。
    const paths = mockRequest.mock.calls.map(([p]) => String(p))
    expect(paths.some((p) => p === '/api/server/admin/providers')).toBe(false)
    expect(await screen.findByText(/上游账户余额需要/)).toBeInTheDocument()
    expect(screen.queryByText('未配置上游渠道')).toBeNull()
  })

  // 第三十二轮 FIX-47 子泳道 B：负例的另一半（同上一条的说明）。
  it('持有 gateway:read 时必须请求上游渠道并渲染余额(正向夹具)', async () => {
    setCurrentAdmin({ role: 'super_admin', permissions: ['usage:read', 'gateway:read'] })
    mockRequest.mockImplementation(async (path: string) => {
      if (path === '/api/server/admin/providers') {
        return { providers: [{ id: 1, name: 'DeepSeek', base_url: 'https://upstream.example.com', enabled: true }] }
      }
      if (path === '/api/server/admin/providers/1/balance') {
        return {
          supported: true, is_available: true, fetched_at: '2026-09-02T10:00:00Z',
          infos: [{ currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' }],
        }
      }
      if (path.startsWith('/api/server/admin/usage/overview')) {
        const rows = [usageRow('2026-09-01', 5)]
        return { today: { cost: 1, requests: 1 }, month: { cost: 10, requests: 10 }, trend: rows, top_models: rows }
      }
      return {}
    })
    render(<MemoryRouter future={ROUTER_FUTURE} initialEntries={['/usage']}><UsageOverview /></MemoryRouter>)

    expect(await screen.findByText('110.00')).toBeInTheDocument()
    expect(screen.getByText('DeepSeek')).toBeInTheDocument()
    expect(mockRequest.mock.calls.map(([p]) => String(p))).toContain('/api/server/admin/providers')
    expect(screen.queryByText(/上游账户余额需要/)).toBeNull()
  })
})
