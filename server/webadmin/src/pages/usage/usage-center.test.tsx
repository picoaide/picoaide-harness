import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { request } from '../../api'
import Overview from './Overview'
import Departments from './Departments'
import Members from './Members'
import MemberDetail from './MemberDetail'
import Models from './Models'
import Logs from './Logs'
import Balance from './Balance'

// 图表懒加载(VChart)在 jsdom 无 canvas:统一 mock 为占位
vi.mock('../../components/chart-lazy', () => ({
  ChartLazy: () => <div data-testid="chart-mock" />,
}))

const mockRequest = vi.mocked(request)

const USERS = [
  { id: 1, username: 'alice', display_name: '', role: 'user', status: 1, is_admin: false, balance_money: 88.5, balance_activated: true, monthly_usage: 1000, monthly_cost: 12.34, groups: ['研发部'] },
  { id: 2, username: 'bob', display_name: 'Bob', role: 'user', status: 1, is_admin: false, balance_money: 0, balance_activated: false, monthly_usage: 90000, monthly_cost: 3.21, groups: [] },
  { id: 3, username: 'boss', display_name: '', role: 'super_admin', status: 1, is_admin: true, balance_money: 0, balance_activated: false, monthly_usage: 0, monthly_cost: 0, groups: [] },
]

const DEPTS = [
  { id: 1, name: '研发部', parent_id: 2, leader_name: 'alice', member_count: 2 },
  { id: 2, name: '全员', parent_id: 0, leader_name: '', member_count: 3 },
]

const usageRow = (label: string, cost: number, requests = 1, pt = 100, ct = 50) => ({
  label, prompt_tokens: pt, completion_tokens: ct, requests,
  embed_requests: 0, embed_tokens: 0, cache_tokens: 0, cost,
})

beforeEach(() => {
  mockRequest.mockReset()
  mockRequest.mockImplementation(async (path: string) => {
    if (path.startsWith('/api/server/admin/usage/overview')) {
      return {
        range: { cost: 20, tokens: 300, requests: 3 },
        month: { cost: 100, tokens: 1000, requests: 10 },
        today: { cost: 5, tokens: 60, requests: 1 },
        trend: [usageRow('2026-09-01', 12), usageRow('2026-09-02', 8)],
        top_models: [usageRow('deepseek-chat', 18), usageRow('gpt-4o', 2)],
      }
    }
    if (path === '/api/server/admin/providers') return { providers: [{ id: 1, name: 'DeepSeek', base_url: 'https://api.deepseek.com', enabled: true }] }
    if (path === '/api/server/admin/providers/1/balance') {
      return { supported: true, is_available: true, fetched_at: '2026-09-02T10:00:00Z', infos: [{ currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' }] }
    }
    if (path === '/api/server/admin/departments') return { departments: DEPTS }
    if (path.startsWith('/api/server/admin/usage?group=dept')) return { rows: [usageRow('研发部', 15.55, 5), usageRow('全员', 15.55, 5)] }
    if (path.startsWith('/api/server/admin/usage?group=day')) return { rows: [usageRow('2026-09-01', 1), usageRow('2026-09-02', 2)] }
    if (path.startsWith('/api/server/admin/usage?group=user')) return { rows: [usageRow('alice', 12.34, 5), usageRow('bob', 3.21, 2)] }
    if (path.startsWith('/api/server/admin/usage?group=model')) return { rows: [usageRow('deepseek-chat', 14), usageRow('embed-model', 1, 1, 10, 0)] }
    if (path.startsWith('/api/server/admin/usage?group=provider')) return { rows: [usageRow('DeepSeek', 14), usageRow('(未配置渠道)', 1)] }
    if (path.startsWith('/api/server/admin/usage/requests')) return { rows: [{ id: 9, time: '2026-09-02T10:00:00Z', user_id: 1, username: 'alice', model: 'deepseek-chat', kind: 'chat', prompt_tokens: 100, completion_tokens: 50, cache_tokens: 0, cost: 0.12 }], total: 1, page: 1, size: 20, kind: '' }
    if (path === '/api/server/admin/models') return { models: [{ id: 1, name: 'deepseek-chat', provider_id: 1, display_name: '', default_params: '{}', input_price_per_1m: 2, output_price_per_1m: 8, cache_input_price_per_1m: null, offpeak_discount: null }, { id: 2, name: 'embed-model', provider_id: 1, display_name: '', default_params: '{}', input_price_per_1m: null, output_price_per_1m: null, cache_input_price_per_1m: null, offpeak_discount: null }] }
    if (path === '/api/server/admin/gateway') return { default_model: 'deepseek-chat', rate_limit: '60', peak_windows: '', server_base_url: '' }
    if (path === '/api/server/admin/balance') {
      return {
        settings: { enabled: true, monthly_amount: 100, monthly_mode: 'add' },
        last_grant: { month: '202609', mode: 'add', amount: 100, affected: 2 },
        month_grant: { month: '202609', mode: 'add', amount: 100, affected: 2 },
        status: { month: '202609', eligible: 3, granted: 2, pending: 1, activated: 1 },
        users: 3,
        total_balance: 88.5,
      }
    }
    if (path.includes('/balance/ledger')) return { items: [], total: 0, ledger_sum: 88.5, balance_money: 88.5 }
    if (path.startsWith('/api/server/admin/users')) return { users: USERS, total: 3 }
    return {}
  })
})

function renderAt(path: string, ui: React.ReactNode, routePath?: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={routePath ?? path} element={ui} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('用量中心 · 总览', () => {
  it('渲染渠道余额卡、KPI 行、趋势与模型 TOP', async () => {
    renderAt('/usage', <Overview />)
    expect(await screen.findByText('上游账户余额')).toBeInTheDocument()
    expect(await screen.findByText('110.00')).toBeInTheDocument() // DeepSeek 余额
    expect(await screen.findByText('赠金 10.00')).toBeInTheDocument()
    expect(screen.getByTestId('overview-kpis')).toBeInTheDocument()
    expect(await screen.findByText('本月消耗')).toBeInTheDocument()
    expect(await screen.findByText('今日消耗')).toBeInTheDocument()
    expect(screen.getByText('消耗趋势')).toBeInTheDocument()
    expect(screen.getByText('模型消耗 TOP 10')).toBeInTheDocument()
    expect(screen.getAllByTestId('chart-mock').length).toBeGreaterThanOrEqual(2)
  })
})

describe('用量中心 · 部门用量', () => {
  it('渲染部门表与部门详情下钻', async () => {
    renderAt('/usage', <Departments />)
    expect(await screen.findByText('研发部')).toBeInTheDocument()
    // 区间费用(部门预算已下线,列只剩区间费用与成员数)
    expect((await screen.findAllByText('¥15.55')).length).toBeGreaterThanOrEqual(1)
    // 点击部门行 → 详情(成员排行 + 模型花费)
    fireEvent.click(screen.getByText('研发部'))
    expect(await screen.findByText('成员消费排行')).toBeInTheDocument()
    expect(await screen.findByText('alice')).toBeInTheDocument()
    expect(await screen.findByText('模型花费')).toBeInTheDocument()
    expect(screen.getByText('导出 CSV')).toBeInTheDocument()
  })
})

describe('用量中心 · 成员用量', () => {
  it('渲染成员表并链接到个人详情', async () => {
    renderAt('/usage/members', <Members />)
    expect(await screen.findByText('alice')).toBeInTheDocument()
    expect(screen.getByText('Bob')).toBeInTheDocument()
    expect(screen.getByText('研发部')).toBeInTheDocument() // 部门列
    expect(screen.getByText('¥12.34')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /alice/ })).toHaveAttribute('href', '/usage/members/alice')
    // 账户余额列(alice 88.5 / bob 未开通;配额已下线)
    expect(screen.getByText('¥88.50')).toBeInTheDocument()
    expect(screen.getByText('未开通')).toBeInTheDocument()
    // P3: 员工数不再假设「仅一名超管」——3 个账号 1 个超管 → 2 名员工
    expect(screen.getByText('共 2 名员工')).toBeInTheDocument()
  })

  it('个人详情:徽章 + 趋势 + 模型构成 + 最近请求', async () => {
    renderAt('/usage/members/alice', <MemberDetail />, '/usage/members/:username')
    expect(await screen.findByText('成员用量 · alice')).toBeInTheDocument()
    expect(await screen.findByText(/本月消耗/)).toBeInTheDocument()
    expect(await screen.findByText('模型构成')).toBeInTheDocument()
    expect((await screen.findAllByText('deepseek-chat')).length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('最近请求')).toBeInTheDocument()
    expect(screen.getByText(/2026-09-02 10:00:00/)).toBeInTheDocument()
    expect(screen.getAllByTestId('chart-mock').length).toBeGreaterThanOrEqual(1)
    // 徽章用账户余额(配额已下线)
    expect(screen.getByText('账户余额 ¥88.50')).toBeInTheDocument()
  })
})

describe('用量中心 · 模型分析', () => {
  it('渲染模型单价列、渠道消耗与占比图', async () => {
    renderAt('/usage', <Models />)
    expect(await screen.findByText('模型明细')).toBeInTheDocument()
    expect(await screen.findByText('deepseek-chat')).toBeInTheDocument()
    expect(await screen.findByText(/2\.00 \/ 8\.00/)).toBeInTheDocument() // 单价
    expect(await screen.findByText('未定价')).toBeInTheDocument() // embed-model
    expect(await screen.findByText('渠道消耗')).toBeInTheDocument()
    expect(screen.getByText('(未配置渠道)')).toBeInTheDocument()
    expect(screen.getByText('金额占比')).toBeInTheDocument()
  })
})

describe('用量中心 · 请求日志', () => {
  it('渲染统计徽标、过滤条件与明细分页', async () => {
    renderAt('/usage', <Logs />)
    expect(await screen.findByText(/区间请求/)).toBeInTheDocument()
    expect(await screen.findByText('alice')).toBeInTheDocument()
    expect(await screen.findByText('deepseek-chat')).toBeInTheDocument()
    expect(screen.getByText(/共 1 条/)).toBeInTheDocument()
    // 过滤条件存在
    expect(screen.getByText('过滤条件')).toBeInTheDocument()
    expect(screen.getByText('导出 CSV')).toBeInTheDocument()
  })
})

describe('用量中心 · 余额', () => {
  it('展示发放策略与员工余额,调整弹窗实时预览并提交', async () => {
    renderAt('/usage', <Balance />)
    // 发放策略卡
    expect(await screen.findByText('按月发放余额')).toBeInTheDocument()
    const amt = screen.getByLabelText('每人每月额度(元)')
    expect((amt as HTMLInputElement).value).toBe('100')
    // 员工余额表(过滤掉 super_admin)
    expect(await screen.findByText('alice')).toBeInTheDocument()
    expect(screen.queryByText('boss')).not.toBeInTheDocument()
    expect(await screen.findByText('未开通')).toBeInTheDocument()
    // 调整弹窗:预览 + 提交
    fireEvent.click(screen.getAllByRole('button', { name: /调整/ })[0]!)
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toBeInTheDocument()
    const amountInput = dialog.querySelector('input[inputmode="decimal"]')
    fireEvent.change(amountInput!, { target: { value: '20' } })
    expect(await screen.findByText('¥108.50')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /确认/ }))
    await waitFor(() => expect(mockRequest).toHaveBeenCalledWith(
      '/api/server/admin/users/1/balance',
      expect.objectContaining({ method: 'POST', body: expect.stringContaining('"mode":"add"') }),
    ))
  })
})
