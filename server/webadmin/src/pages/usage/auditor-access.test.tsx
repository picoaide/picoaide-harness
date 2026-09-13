import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { request } from '../../api'
import { setCurrentAdmin } from '../../lib/rbac'
import UsageDepartments from './Departments'
import UsageLayout from './UsageLayout'

// 图表懒加载(VChart)在 jsdom 无 canvas:统一 mock 为占位(与 usage-center.test.tsx 同款)。
vi.mock('../../components/chart-lazy', () => ({
  ChartLazy: () => <div data-testid="chart-mock" />,
}))

// ---------------------------------------------------------------------------
// 审计 R7 webadmin-branding-3:auditor(只读三元组 audit:read + usage:read +
// user:read)**没有 dept:read** —— 这是 rbac.go 的刻意设计(与 PermReportRead
// 一样属最小权限,审计角色不该看到组织架构树)。于是"部门用量"页原来首屏
// 整块失效:GET /departments 403 → Promise.all 拒绝 → 连它本来有权读的
// group=dept 用量行也一起消失,只剩一句 403 报错。
// 修法:没有 dept:read 就不请求组织树,改用用量行(usage:read)呈现"各部门消耗",
// 并说明组织架构树需要更高权限;用量中心子导航同样按权限过滤。
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
    if (path === '/api/server/admin/departments') {
      // 真实服务端:RequirePermission(dept:read) → 403。
      throw Object.assign(new Error('没有权限执行该操作'), { status: 403, code: 'FORBIDDEN' })
    }
    if (path.startsWith('/api/server/admin/usage?group=dept')) {
      return { rows: [usageRow('研发部', 15.55), usageRow('销售部', 3.2)] }
    }
    if (path.startsWith('/api/server/admin/usage?')) return { rows: [usageRow('2026-09-01', 1)] }
    return {}
  })
})

afterEach(() => setCurrentAdmin(null))

describe('审计员访问部门用量(R7 branding-3)', () => {
  it('不请求需要 dept:read 的组织树,仍渲染按用量口径的各部门消耗与权限说明', async () => {
    setCurrentAdmin(auditor)
    render(<MemoryRouter initialEntries={['/usage/depts']}><UsageDepartments /></MemoryRouter>)

    // 用量行(usage:read 允许的数据)必须可见 —— 原来这里整块是空的。
    expect(await screen.findByText('研发部')).toBeInTheDocument()
    expect(screen.getByText('销售部')).toBeInTheDocument()
    // 不是 403 报错页。
    expect(screen.queryByText('没有权限执行该操作')).toBeNull()
    // 组织架构树(及其成员数)需要 dept:read:不请求、也不显示"成员"列。
    const paths = mockRequest.mock.calls.map(([p]) => String(p))
    expect(paths.some((p) => p === '/api/server/admin/departments')).toBe(false)
    expect(screen.queryByRole('columnheader', { name: '成员' })).toBeNull()
    // 给出正确文案:说明为什么看不到组织树(页内说明 + 表头描述各一处)。
    expect(screen.getAllByText(/dept:read/).length).toBeGreaterThan(0)
    // 点击部门仍可下钻(明细走 usage:read)。
    fireEvent.click(screen.getByText('研发部'))
    await waitFor(() => {
      const after = mockRequest.mock.calls.map(([p]) => String(p))
      expect(after.some((p) => p.includes('group=day') && p.includes('dept=%E7%A0%94%E5%8F%91%E9%83%A8'))).toBe(true)
    })
  })

  it('用量中心子导航对审计员隐藏需要 dept:read / report:read 的标签', () => {
    setCurrentAdmin(auditor)
    render(<MemoryRouter initialEntries={['/usage']}><UsageLayout /></MemoryRouter>)
    expect(screen.getByRole('link', { name: /总览/ })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /成员用量/ })).toBeInTheDocument()
    // 部门用量要 dept:read;报表订阅要 report:read(服务端刻意不给 auditor)。
    expect(screen.queryByRole('link', { name: /部门用量/ })).toBeNull()
    expect(screen.queryByRole('link', { name: /报表订阅/ })).toBeNull()
  })
})
