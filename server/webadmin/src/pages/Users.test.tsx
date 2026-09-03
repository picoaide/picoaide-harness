import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react'
import Users from './Users'
import { MemoryRouter } from 'react-router-dom'
import { request } from '../api'

const mockRequest = vi.mocked(request)
const confirmSpy = vi.fn(() => true)

const depts = [
  { id: 1, name: '研发部', parent_id: 0, leader_id: 2, leader_name: 'alice', description: '', member_count: 1, child_count: 1, granted_count: 1 },
  { id: 2, name: '前端组', parent_id: 1, leader_id: 0, leader_name: '', description: '', member_count: 1, child_count: 0, granted_count: 0 },
]

beforeEach(() => {
  window.confirm = confirmSpy as any
  mockRequest.mockReset()
  mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path.startsWith('/api/server/admin/users?page=')) {
      return {
        users: [
          { id: 1, username: 'alice', is_admin: false, status: 1, groups: ['研发部'] },
          { id: 2, username: 'boss', is_admin: true, status: 1, groups: [] },
        ],
        total: 2, page: 1, size: 20,
      }
    }
    if (path === '/api/server/admin/departments') return { departments: depts }
    if (path === '/api/server/admin/users/1/department' && init?.method === 'PUT') return { ok: true }
    return {}
  })
})

describe('Users 用户管理页', () => {
  it('渲染用户表格:部门徽标与管理角色', async () => {
    render(<MemoryRouter><Users /></MemoryRouter>)
    expect(await screen.findByText('alice')).toBeInTheDocument()
    expect(screen.getByText('研发部')).toBeInTheDocument()
    expect(screen.getByText('管理员')).toBeInTheDocument()
    expect(screen.getByText('员工')).toBeInTheDocument()
  })

  it('员工部门归属:打开对话框从部门树多选并保存(group_ids)', async () => {
    render(<MemoryRouter><Users /></MemoryRouter>)
    await screen.findByText('alice')
    fireEvent.click(screen.getAllByRole('button', { name: '部门' })[0])
    const dialog = within(await screen.findByRole('dialog'))
    expect(dialog.getByText(/从部门树选择归属/)).toBeInTheDocument()
    // alice 归属研发部 → 复选框已勾选;保存提交 group_ids 数组
    expect(dialog.getByRole('checkbox', { name: /研发部/ })).toBeChecked()
    fireEvent.click(dialog.getByRole('button', { name: '保存' }))
    expect(mockRequest).toHaveBeenCalledWith(
      '/api/server/admin/users/1/department',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ group_ids: [1] }) }),
    )
  })

  it('未分配部门用户显示占位', async () => {
    render(<MemoryRouter><Users /></MemoryRouter>)
    await screen.findByText('boss')
    // boss 无部门
    expect(screen.getByText('—')).toBeInTheDocument()
  })

  it('禁用用户需确认(高2):确认后 PUT status 0,取消不发送', async () => {
    render(<MemoryRouter><Users /></MemoryRouter>)
    await screen.findByText('alice')
    // 取消 → 不发送请求
    confirmSpy.mockReturnValueOnce(false)
    fireEvent.click(screen.getAllByRole('button', { name: '禁用' })[0])
    expect(confirmSpy).toHaveBeenCalled()
    expect(mockRequest).not.toHaveBeenCalledWith('/api/server/admin/users/1', expect.objectContaining({ method: 'PUT' }))
    // 确认 → 发送 PUT status:0
    confirmSpy.mockReturnValueOnce(true)
    fireEvent.click(screen.getAllByRole('button', { name: '禁用' })[0])
    await waitFor(() => expect(mockRequest).toHaveBeenCalledWith(
      '/api/server/admin/users/1',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ status: 0 }) }),
    ))
  })

  it('新建用户失败:错误显示在对话框内(中3)', async () => {
    mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.startsWith('/api/server/admin/users?page=')) {
        return { users: [{ id: 1, username: 'alice', is_admin: false, status: 1, groups: [] }], total: 1, page: 1, size: 20 }
      }
      if (path === '/api/server/admin/departments') return { departments: depts }
      if (path === '/api/server/admin/users' && init?.method === 'POST') throw new Error('密码至少 10 位')
      return {}
    })
    render(<MemoryRouter><Users /></MemoryRouter>)
    await screen.findByText('alice')
    fireEvent.click(screen.getByRole('button', { name: '新建用户' }))
    const dialog = within(await screen.findByRole('dialog'))
    fireEvent.change(dialog.getByLabelText('用户名'), { target: { value: 'eve' } })
    fireEvent.change(dialog.getByLabelText('密码'), { target: { value: 'short' } })
    fireEvent.click(dialog.getByRole('button', { name: '创建' }))
    // 错误必须出现在对话框内
    expect(await dialog.findByText('密码至少 10 位')).toBeInTheDocument()
  })

  it('令牌加载失败:显示错误而非「暂无令牌」(中5)', async () => {
    mockRequest.mockImplementation(async (path: string, _init?: RequestInit) => {
      if (path.startsWith('/api/server/admin/users?page=')) {
        return { users: [{ id: 1, username: 'alice', is_admin: false, status: 1, groups: [] }], total: 1, page: 1, size: 20 }
      }
      if (path === '/api/server/admin/departments') return { departments: depts }
      if (path === '/api/server/admin/users/1/tokens') throw new Error('查询失败')
      return {}
    })
    render(<MemoryRouter><Users /></MemoryRouter>)
    await screen.findByText('alice')
    fireEvent.click(screen.getByRole('button', { name: '令牌' }))
    const dialog = within(await screen.findByRole('dialog'))
    expect(await dialog.findByText('查询失败')).toBeInTheDocument()
    expect(dialog.queryByText('该用户暂无令牌')).not.toBeInTheDocument()
  })

  it('跟随默认配额展示全局默认值(中7)', async () => {
    mockRequest.mockImplementation(async (path: string, _init?: RequestInit) => {
      if (path.startsWith('/api/server/admin/users?page=')) {
        return {
          users: [{
            id: 1, username: 'alice', is_admin: false, status: 1, groups: ['研发部'],
            quota_tokens: null, effective_quota_tokens: 100000, monthly_usage: 5000,
            quota_money: null, effective_quota_money: 50, monthly_cost: 1,
          }],
          total: 1, page: 1, size: 20,
        }
      }
      if (path === '/api/server/admin/departments') return { departments: depts }
      return {}
    })
    render(<MemoryRouter><Users /></MemoryRouter>)
    // 跟随默认 + 全局值
    expect(await screen.findByText(/跟随默认\(100K\/月\)/)).toBeInTheDocument()
    expect(screen.getByText(/跟随默认\(¥50\.00\/月\)/)).toBeInTheDocument()
    // 生效配额下使用率徽标可见(5%)
    expect(screen.getByText('5%')).toBeInTheDocument()
  })

  it('过期令牌显示「已过期」(L12)', async () => {
    mockRequest.mockImplementation(async (path: string, _init?: RequestInit) => {
      if (path.startsWith('/api/server/admin/users?page=')) {
        return { users: [{ id: 1, username: 'alice', is_admin: false, status: 1, groups: [] }], total: 1, page: 1, size: 20 }
      }
      if (path === '/api/server/admin/departments') return { departments: depts }
      if (path === '/api/server/admin/users/1/tokens') {
        return { tokens: [{ id: 9, name: 'old', created_at: '2025-01-01T00:00:00Z', expires_at: '2025-04-01T00:00:00Z', last_used_at: '', revoked: 0 }] }
      }
      return {}
    })
    render(<MemoryRouter><Users /></MemoryRouter>)
    await screen.findByText('alice')
    fireEvent.click(screen.getByRole('button', { name: '令牌' }))
    const dialog = within(await screen.findByRole('dialog'))
    expect(await dialog.findByText('已过期')).toBeInTheDocument()
  })

  it('管理员配额按钮禁用(L9)', async () => {
    render(<MemoryRouter><Users /></MemoryRouter>)
    await screen.findByText('boss')
    // boss 是 admin → 配额按钮禁用
    const row = screen.getByText('boss').closest('tr')!
    expect(within(row).getByRole('button', { name: '配额' })).toBeDisabled()
  })

  it('用户列表空态(L8)', async () => {
    mockRequest.mockImplementation(async (path: string, _init?: RequestInit) => {
      if (path.startsWith('/api/server/admin/users?page=')) return { users: [], total: 0, page: 1, size: 20 }
      if (path === '/api/server/admin/departments') return { departments: depts }
      return {}
    })
    render(<MemoryRouter><Users /></MemoryRouter>)
    expect(await screen.findByText(/暂无匹配用户/)).toBeInTheDocument()
  })

  it('配额概览:只读展示生效配额并跳转用量中心(G8 单入口)', async () => {
    render(<MemoryRouter><Users /></MemoryRouter>)
    await screen.findByText('alice')
    fireEvent.click(screen.getAllByRole('button', { name: '配额' })[0])
    const dialog = within(await screen.findByRole('dialog'))
    // 只读概览(生效配额) + 跳转入口; 不发任何 PUT
    expect(dialog.getByText(/生效 token 配额/)).toBeInTheDocument()
    expect(dialog.getByRole('link', { name: /去用量中心调整/ })).toBeInTheDocument()
    expect(mockRequest).not.toHaveBeenCalledWith('/api/server/admin/users/1', expect.objectContaining({ method: 'PUT' }))
  })

  it('多部门用户:部门对话框显示全部当前归属并提示预算同时生效', async () => {
    mockRequest.mockImplementation(async (path: string, _init?: RequestInit) => {
      if (path.startsWith('/api/server/admin/users?page=')) {
        return { users: [{ id: 3, username: 'multi', is_admin: false, status: 1, groups: ['研发部', '前端组'] }], total: 1, page: 1, size: 20 }
      }
      if (path === '/api/server/admin/departments') return { departments: depts }
      return {}
    })
    render(<MemoryRouter><Users /></MemoryRouter>)
    await screen.findByText('multi')
    fireEvent.click(screen.getByRole('button', { name: '部门' }))
    const dialog = within(await screen.findByRole('dialog'))
    expect(await dialog.findByText(/当前归属 2 个部门/)).toBeInTheDocument()
    expect(dialog.getByText(/保存将替换该用户全部部门归属/)).toBeInTheDocument()
    // 多部门复选框被勾选(研发部 + 前端组)
    expect(dialog.getByRole('checkbox', { name: /研发部/ })).toBeChecked()
    expect(dialog.getByRole('checkbox', { name: /前端组/ })).toBeChecked()
  })
})

// G8: 配额编辑唯一入口 = 用量中心 → 配额与预算(Adjust Quota); 用户页仅只读概览。

describe('Users 0057 密码/MFA 操作', () => {
  it('重置密码: 提交 PUT /users/:id {password} 并提示强制改密', async () => {
    mockRequest.mockImplementation(async (path: string, _init?: RequestInit) => {
      if (path.startsWith('/api/server/admin/users?page=')) {
        return {
          users: [{ id: 1, username: 'alice', is_admin: false, status: 1, source: 'local', password_changed_at: '2026-08-01T06:00:00Z' }],
          total: 1, page: 1, size: 20,
        }
      }
      if (path === '/api/server/admin/departments') return { departments: [] }
      return {}
    })
    render(<MemoryRouter><Users /></MemoryRouter>)
    await screen.findByText('alice')
    // 上次改密列渲染本地格式化时间
    expect(screen.getByText(/2026-08-0[12]/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '重置密码' }))
    const dialog = within(await screen.findByRole('dialog'))
    const inputs = dialog.getAllByLabelText(/新密码|确认新密码/)
    fireEvent.change(inputs[0], { target: { value: 'newpass123456' } })
    fireEvent.change(inputs[1], { target: { value: 'newpass123456' } })
    fireEvent.click(dialog.getByRole('button', { name: '确认重置' }))
    await waitFor(() => expect(mockRequest).toHaveBeenCalledWith(
      '/api/server/admin/users/1',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ password: 'newpass123456' }) }),
    ))
  })

  it('重置 MFA: 仅对已开启 MFA 的用户显示按钮, 确认后调用 PUT /users/:id/mfa', async () => {
    mockRequest.mockImplementation(async (path: string, _init?: RequestInit) => {
      if (path.startsWith('/api/server/admin/users?page=')) {
        return {
          users: [
            { id: 1, username: 'alice', is_admin: false, status: 1, source: 'local' },
            { id: 2, username: 'boss', is_admin: true, status: 1, source: 'local', mfa_enabled: true },
          ],
          total: 2, page: 1, size: 20,
        }
      }
      if (path === '/api/server/admin/departments') return { departments: [] }
      return {}
    })
    render(<MemoryRouter><Users /></MemoryRouter>)
    await screen.findByText('alice')
    // 未开启 MFA 的 alice 无按钮; 仅 boss 有(全页恰一个)
    expect(screen.getAllByRole('button', { name: '重置MFA' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: '重置MFA' }))
    await waitFor(() => expect(confirmSpy).toHaveBeenCalled())
    await waitFor(() => expect(mockRequest).toHaveBeenCalledWith('/api/server/admin/users/2/mfa', expect.objectContaining({ method: 'PUT' })))
  })

  it('外部认证(LDAP/OIDC)用户的重置密码按钮禁用', async () => {
    mockRequest.mockImplementation(async (path: string, _init?: RequestInit) => {
      if (path.startsWith('/api/server/admin/users?page=')) {
        return {
          users: [{ id: 3, username: 'ldap1', is_admin: false, status: 1, source: 'external' }],
          total: 1, page: 1, size: 20,
        }
      }
      if (path === '/api/server/admin/departments') return { departments: [] }
      return {}
    })
    render(<MemoryRouter><Users /></MemoryRouter>)
    await screen.findByText('ldap1')
    expect(screen.getByRole('button', { name: '重置密码' })).toBeDisabled()
  })
})
