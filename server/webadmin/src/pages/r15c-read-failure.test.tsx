import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { request } from '../api'
import { ROUTER_FUTURE } from '@/lib/router-future'
import { OPENS_SUMMARY_PATH } from './app-center/opens-contract'
import Capabilities from './Capabilities'
import Connectors from './Connectors'
import Departments from './Departments'
import Audit from './Audit'
import Apps from './app-center/Apps'
import UsageLogs from './usage/Logs'
import UsageBalance from './usage/Balance'

// 审计 R15C-W-02…W-08（2026-09-25，P2 ×7）：**"读取失败"必须被渲染成确定态**。
//
// 同一族形态在本轮出现 7 次（每一处都是"失败的读 → 旧数据/空态/确定结论"）：
//   - 切 tab / 刷新 / 筛选的 GET 失败后，**上一份数据继续冒充本次结果**，行内的
//     破坏性写（删除/通过/拒绝/下发开关）照常可点（W-02/W-03/W-06/W-07）；
//   - 读取失败被渲染成**空态**（「暂无部门」「暂无流水」「暂无审计记录」），即把
//     "没读到"说成"已确认没有"（W-04/W-05）；
//   - 读取失败后仍对服务端状态给出**确定结论**（「关闭:更新即生效」）（W-08）。
//
// 仓库既有口径（`Apps.tsx` / `Marketplace.tsx` / `Agents.tsx`）：读取失败 = 页面级
// 确定态（错误 + 重试入口），**不渲染任何行、不渲染空态**。本文件把这 7 处钉死。
//
// 变异纪律：每处修复都只需"失败分支清空 + 渲染分支给出失败确定态"两半；只拆一半
// （例如只在 catch 里清空、渲染仍走空态）会被对应的"不得渲染空态/确定结论"断言抓到。

const mockRequest = vi.mocked(request)
const API = '/api/server/admin'

beforeEach(() => {
  mockRequest.mockReset()
  window.confirm = vi.fn(() => true) as unknown as typeof window.confirm
})

function renderInRouter(node: React.ReactElement) {
  return render(<MemoryRouter future={ROUTER_FUTURE}>{node}</MemoryRouter>)
}

// ---------------------------------------------------------------- W-02 审批页
describe('R15C-W-02 Capabilities：切状态页 GET 失败后，上一页的行（带可点的「删除」）必须撤下', () => {
  const PENDING_ROW = {
    kind: 'skill' as const,
    name: 'pend-skill-r15',
    version: '1.0.0',
    display_name: '待审技能R15',
    description: 'd',
    author: 'alice',
    owner: 'alice',
    status: 'pending' as const,
    reason: '',
    quality: '' as const,
    downloads: 0,
    created_at: '2026-09-24T10:00:00Z',
    base_path: `/api/server/admin/shared-skills/pend-skill-r15/1.0.0`,
    grants_base: `/api/server/admin/shared-skills/pend-skill-r15`,
    preview_path: `/api/server/admin/shared-skills/pend-skill-r15/1.0.0/preview`,
  }

  it('切到「已拒绝」失败 ⇒ 不渲染待审行、删除按钮数为 0，且不渲染空态', async () => {
    mockRequest.mockImplementation(async (p: string) => {
      if (p.startsWith(`${API}/capabilities/approvals`)) {
        if (p.includes('status=rejected')) throw new Error('查询失败: 500')
        return { approvals: [PENDING_ROW] } as any
      }
      if (p === `${API}/departments`) return { departments: [] } as any
      return {} as any
    })
    renderInRouter(<Capabilities />)

    expect(await screen.findByText('待审技能R15')).toBeInTheDocument()
    // 对照：正常路径下「删除」确实可点（不是被权限挡掉的）。
    expect(screen.getAllByRole('button', { name: '删除' }).length).toBe(1)

    await userEvent.setup().click(screen.getByRole('tab', { name: /已拒绝/ }))
    await waitFor(() => expect(screen.getByText(/查询失败/)).toBeInTheDocument())

    expect(screen.queryByText('待审技能R15')).toBeNull()
    expect(screen.queryAllByRole('button', { name: '删除' }).length).toBe(0)
    // 失败不是空态。
    expect(screen.queryByText('暂无待处理能力')).toBeNull()
    expect(screen.getByText('审批列表未读取成功')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------- W-03 连接器页
describe('R15C-W-03 Connectors：刷新失败后旧表与行内写控件必须撤下', () => {
  it('刷新失败 ⇒ 不再渲染旧行（连带「下发」开关/编辑/删除），且不渲染空态', async () => {
    let call = 0
    mockRequest.mockImplementation(async (p: string) => {
      if (p === `${API}/connectors`) {
        call += 1
        if (call === 1) {
          return {
            connectors: [{
              id: 'example-mcp', name: 'CRM X', description: '', auth_mode: 'token',
              definition: '{"mcp":[]}', enabled: true,
              updated_at: '2026-09-24T10:00:00Z', created_at: '2026-09-24T10:00:00Z',
            }],
          } as any
        }
        throw new Error('查询失败: 500')
      }
      return {} as any
    })
    renderInRouter(<Connectors />)

    expect(await screen.findByText('example-mcp')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /刷新/ }))
    await waitFor(() => expect(screen.getByText(/查询失败/)).toBeInTheDocument())

    expect(screen.queryByText('example-mcp')).toBeNull()
    expect(screen.queryByRole('switch', { name: '下发 CRM X' })).toBeNull()
    expect(screen.queryByText('暂无连接器')).toBeNull()
    expect(screen.getByText('连接器列表未读取成功')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------- W-04 部门页
describe('R15C-W-04 Departments：读取失败不得渲染空态「暂无部门」', () => {
  it('GET /departments 失败 ⇒ 显式失败态，不出现「暂无部门」', async () => {
    mockRequest.mockImplementation(async (p: string) => {
      if (p === `${API}/departments`) throw new Error('查询失败: 500')
      return {} as any
    })
    renderInRouter(<Departments />)

    await waitFor(() => expect(screen.getByText(/查询失败/)).toBeInTheDocument())
    expect(screen.queryByText('暂无部门')).toBeNull()
  })

  it('对照：读取成功且确实为空 ⇒ 空态照常渲染（闸门不误伤）', async () => {
    mockRequest.mockImplementation(async (p: string) => {
      if (p === `${API}/departments`) return { departments: [] } as any
      return {} as any
    })
    renderInRouter(<Departments />)
    expect(await screen.findByText('暂无部门')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------- W-05 余额流水
describe('R15C-W-05 usage/Balance：流水读取失败不得渲染成「暂无流水」', () => {
  const USERS = [{
    id: 1, username: 'alice', display_name: 'Alice', status: 1, groups: ['研发部'],
    balance_money: 50, balance_activated: true, monthly_cost: 1.5, monthly_usage: 100,
  }]
  const SUMMARY = {
    settings: { enabled: true, monthly_amount: 100, monthly_mode: 'add' as const },
    last_grant: null, month_grant: null,
    status: { month: '2026-09', eligible: 1, granted: 1, pending: 0, activated: 1 },
    users: 1, total_balance: 50,
  }

  it('流水请求失败 ⇒ 弹窗内明说失败 + 可重试，不显示「暂无流水」', async () => {
    mockRequest.mockImplementation(async (p: string) => {
      if (p.startsWith(`${API}/balance`)) return SUMMARY as any
      if (p.startsWith(`${API}/users?`)) return { users: USERS, total: 1 } as any
      if (p.includes('/balance/ledger')) throw new Error('流水加载失败: 500')
      return {} as any
    })
    renderInRouter(<UsageBalance />)

    fireEvent.click(await screen.findByRole('button', { name: /流水/ }))
    await waitFor(() => expect(screen.getByText(/余额流水 · alice/)).toBeInTheDocument())

    expect(screen.queryByText('暂无流水')).toBeNull()
    expect(screen.getByText(/流水加载失败/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
  })

  it('对照：读取成功且确实无流水 ⇒ 「暂无流水」照常渲染', async () => {
    mockRequest.mockImplementation(async (p: string) => {
      if (p.startsWith(`${API}/balance`)) return SUMMARY as any
      if (p.startsWith(`${API}/users?`)) return { users: USERS, total: 1 } as any
      if (p.includes('/balance/ledger')) return { items: [], ledger_sum: 0 } as any
      return {} as any
    })
    renderInRouter(<UsageBalance />)
    fireEvent.click(await screen.findByRole('button', { name: /流水/ }))
    expect(await screen.findByText('暂无流水')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------- W-06 审计页
describe('R15C-W-06 Audit：筛选失败后旧行不得冒充筛选结果（也不得被导出固化）', () => {
  it('筛选请求失败 ⇒ 旧行撤下 + 失败确定态 + 导出不可用', async () => {
    let call = 0
    mockRequest.mockImplementation(async (p: string) => {
      if (p.startsWith(`${API}/audit?`)) {
        call += 1
        if (call === 1) {
          return {
            logs: [{
              id: 1, username: 'staleaudituser', action: 'user_create',
              detail: 'stale-detail-marker', created_at: '2026-09-24T10:00:00Z',
            }],
            total: 1,
          } as any
        }
        throw new Error('查询失败: 500')
      }
      if (p === `${API}/audit/settings`) return { retention_days: 180 } as any
      return {} as any
    })
    renderInRouter(<Audit />)

    expect(await screen.findByText('staleaudituser')).toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText('操作者'), { target: { value: 'nobody' } })
    fireEvent.click(screen.getByRole('button', { name: '筛选' }))

    await waitFor(() => expect(screen.getByText(/查询失败/)).toBeInTheDocument())
    // 旧行不得继续留在表里（筛选条件已是 nobody）。
    expect(screen.queryByText('staleaudituser')).toBeNull()
    // 失败 ≠ 空态。
    expect(screen.queryByText('暂无审计记录')).toBeNull()
    // 导出按钮此时必须不可用（否则会把"旧数据 + 新条件"固化成 CSV 留档）。
    expect(screen.getByRole('button', { name: /导出 CSV/ })).toBeDisabled()
  })
})

// ---------------------------------------------------------------- W-07 请求日志页
describe('R15C-W-07 usage/Logs：过滤失败后旧明细必须撤下', () => {
  it('改条件后查询失败 ⇒ 旧明细撤下 + 不渲染「暂无数据」', async () => {
    let call = 0
    mockRequest.mockImplementation(async (p: string) => {
      if (p.startsWith(`${API}/usage/requests`)) {
        call += 1
        if (call === 1) {
          return {
            rows: [{
              id: 1, time: '2026-09-24T10:00:00Z', username: 'staleloguser', model: 'm',
              kind: 'chat', prompt_tokens: 1, completion_tokens: 1, cache_tokens: 0, cost: 0.1,
            }],
            total: 1,
          } as any
        }
        throw new Error('查询失败: 500')
      }
      return { rows: [] } as any
    })
    renderInRouter(<UsageLogs />)

    expect(await screen.findByText('staleloguser')).toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText('精确用户名'), { target: { value: 'nobody' } })
    fireEvent.click(screen.getByRole('button', { name: '查询' }))

    await waitFor(() => expect(screen.getByText(/查询失败/)).toBeInTheDocument())
    expect(screen.queryByText('staleloguser')).toBeNull()
    expect(screen.queryByText('暂无数据')).toBeNull()
  })
})

// ---------------------------------------------------------------- W-08 应用中心
describe('R15C-W-08 app-center/Apps：「更新审批」开关在列表读取失败时不得谎报关闭', () => {
  it('首屏列表 GET 失败 ⇒ 文案为「状态未知」且开关禁用；对照：读取成功后按真实取值渲染', async () => {
    mockRequest.mockImplementation(async (p: string) => {
      if (p.startsWith(`${API}/wasm-apps?`)) throw new Error('加载失败: 500')
      if (p.startsWith(OPENS_SUMMARY_PATH)) throw new Error('打开次数缺失: 404')
      return {} as any
    })
    renderInRouter(<Apps />)

    await waitFor(() => expect(screen.getByTestId('apps-load-error')).toBeInTheDocument())
    expect(screen.queryByText('关闭:更新即生效')).toBeNull()
    expect(screen.queryByText('开启:新版本需审核')).toBeNull()
    expect(screen.getByText('状态未知:列表未读取成功')).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: '更新审批' })).toBeDisabled()
  })

  it('对照：读取成功且 review_required=false ⇒ 显示「关闭:更新即生效」且开关可用', async () => {
    mockRequest.mockImplementation(async (p: string) => {
      if (p.startsWith(`${API}/wasm-apps?`)) return { apps: [], total: 0, pending_count: 0, review_required: false } as any
      if (p.startsWith(OPENS_SUMMARY_PATH)) return { rows: [] } as any
      return {} as any
    })
    renderInRouter(<Apps />)

    expect(await screen.findByText('关闭:更新即生效')).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: '更新审批' })).toBeEnabled()
  })
})
