import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react'
import Users from './Users'
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
    if (path.startsWith('/api/admin/users?page=')) {
      return {
        users: [
          { id: 1, username: 'alice', is_admin: false, status: 1, groups: ['研发部'] },
          { id: 2, username: 'boss', is_admin: true, status: 1, groups: [] },
        ],
        total: 2, page: 1, size: 20,
      }
    }
    if (path === '/api/admin/departments') return { departments: depts }
    if (path === '/api/admin/users/1/department' && init?.method === 'PUT') return { ok: true }
    return {}
  })
})

describe('Users 用户管理页', () => {
  it('渲染用户表格:部门徽标与管理角色', async () => {
    render(<Users />)
    expect(await screen.findByText('alice')).toBeInTheDocument()
    expect(screen.getByText('研发部')).toBeInTheDocument()
    expect(screen.getByText('管理员')).toBeInTheDocument()
    expect(screen.getByText('员工')).toBeInTheDocument()
  })

  it('员工部门归属:打开对话框从部门树单选并保存', async () => {
    render(<Users />)
    await screen.findByText('alice')
    fireEvent.click(screen.getAllByRole('button', { name: '部门' })[0])
    const dialog = within(await screen.findByRole('dialog'))
    expect(dialog.getByText(/从部门树选择归属/)).toBeInTheDocument()
    fireEvent.click(dialog.getByRole('button', { name: '保存' }))
    expect(mockRequest).toHaveBeenCalledWith(
      '/api/admin/users/1/department',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ group_id: 1 }) }),
    )
  })

  it('未分配部门用户显示占位', async () => {
    render(<Users />)
    await screen.findByText('boss')
    // boss 无部门
    expect(screen.getByText('—')).toBeInTheDocument()
  })

  it('禁用用户需确认(高2):确认后 PUT status 0,取消不发送', async () => {
    render(<Users />)
    await screen.findByText('alice')
    // 取消 → 不发送请求
    confirmSpy.mockReturnValueOnce(false)
    fireEvent.click(screen.getAllByRole('button', { name: '禁用' })[0])
    expect(confirmSpy).toHaveBeenCalled()
    expect(mockRequest).not.toHaveBeenCalledWith('/api/admin/users/1', expect.objectContaining({ method: 'PUT' }))
    // 确认 → 发送 PUT status:0
    confirmSpy.mockReturnValueOnce(true)
    fireEvent.click(screen.getAllByRole('button', { name: '禁用' })[0])
    await waitFor(() => expect(mockRequest).toHaveBeenCalledWith(
      '/api/admin/users/1',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ status: 0 }) }),
    ))
  })

  it('新建用户失败:错误显示在对话框内(中3)', async () => {
    mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.startsWith('/api/admin/users?page=')) {
        return { users: [{ id: 1, username: 'alice', is_admin: false, status: 1, groups: [] }], total: 1, page: 1, size: 20 }
      }
      if (path === '/api/admin/departments') return { departments: depts }
      if (path === '/api/admin/users' && init?.method === 'POST') throw new Error('密码至少 10 位')
      return {}
    })
    render(<Users />)
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
    mockRequest.mockImplementation(async (path: string) => {
      if (path.startsWith('/api/admin/users?page=')) {
        return { users: [{ id: 1, username: 'alice', is_admin: false, status: 1, groups: [] }], total: 1, page: 1, size: 20 }
      }
      if (path === '/api/admin/departments') return { departments: depts }
      if (path === '/api/admin/users/1/tokens') throw new Error('查询失败')
      return {}
    })
    render(<Users />)
    await screen.findByText('alice')
    fireEvent.click(screen.getByRole('button', { name: '令牌' }))
    const dialog = within(await screen.findByRole('dialog'))
    expect(await dialog.findByText('查询失败')).toBeInTheDocument()
    expect(dialog.queryByText('该用户暂无令牌')).not.toBeInTheDocument()
  })

  it('跟随默认配额展示全局默认值(中7)', async () => {
    mockRequest.mockImplementation(async (path: string) => {
      if (path.startsWith('/api/admin/users?page=')) {
        return {
          users: [{
            id: 1, username: 'alice', is_admin: false, status: 1, groups: ['研发部'],
            quota_tokens: null, effective_quota_tokens: 100000, monthly_usage: 5000,
            quota_money: null, effective_quota_money: 50, monthly_cost: 1,
          }],
          total: 1, page: 1, size: 20,
        }
      }
      if (path === '/api/admin/departments') return { departments: depts }
      return {}
    })
    render(<Users />)
    // 跟随默认 + 全局值
    expect(await screen.findByText(/跟随默认\(100K\/月\)/)).toBeInTheDocument()
    expect(screen.getByText(/跟随默认\(¥50\.00\/月\)/)).toBeInTheDocument()
    // 生效配额下使用率徽标可见(5%)
    expect(screen.getByText('5%')).toBeInTheDocument()
  })

  it('过期令牌显示「已过期」(L12)', async () => {
    mockRequest.mockImplementation(async (path: string) => {
      if (path.startsWith('/api/admin/users?page=')) {
        return { users: [{ id: 1, username: 'alice', is_admin: false, status: 1, groups: [] }], total: 1, page: 1, size: 20 }
      }
      if (path === '/api/admin/departments') return { departments: depts }
      if (path === '/api/admin/users/1/tokens') {
        return { tokens: [{ id: 9, name: 'old', created_at: '2025-01-01T00:00:00Z', expires_at: '2025-04-01T00:00:00Z', last_used_at: '', revoked: 0 }] }
      }
      return {}
    })
    render(<Users />)
    await screen.findByText('alice')
    fireEvent.click(screen.getByRole('button', { name: '令牌' }))
    const dialog = within(await screen.findByRole('dialog'))
    expect(await dialog.findByText('已过期')).toBeInTheDocument()
  })

  it('管理员配额按钮禁用(L9)', async () => {
    render(<Users />)
    await screen.findByText('boss')
    // boss 是 admin → 配额按钮禁用
    const row = screen.getByText('boss').closest('tr')!
    expect(within(row).getByRole('button', { name: '配额' })).toBeDisabled()
  })

  it('用户列表空态(L8)', async () => {
    mockRequest.mockImplementation(async (path: string) => {
      if (path.startsWith('/api/admin/users?page=')) return { users: [], total: 0, page: 1, size: 20 }
      if (path === '/api/admin/departments') return { departments: depts }
      return {}
    })
    render(<Users />)
    expect(await screen.findByText(/暂无匹配用户/)).toBeInTheDocument()
  })

  it('配额输入非法整数被前端拦截(L7)', async () => {
    render(<Users />)
    await screen.findByText('alice')
    fireEvent.click(screen.getAllByRole('button', { name: '配额' })[0])
    const dialog = within(await screen.findByRole('dialog'))
    fireEvent.change(dialog.getByLabelText('月度 token 配额'), { target: { value: '12.5' } })
    fireEvent.click(dialog.getByRole('button', { name: '保存' }))
    expect(await dialog.findByText('token 配额必须是 ≥0 的整数')).toBeInTheDocument()
    // 未发送请求
    expect(mockRequest).not.toHaveBeenCalledWith('/api/admin/users/1', expect.objectContaining({ method: 'PUT' }))
  })

  it('多组用户:部门对话框提示替换语义(中4)', async () => {
    mockRequest.mockImplementation(async (path: string) => {
      if (path.startsWith('/api/admin/users?page=')) {
        return { users: [{ id: 3, username: 'multi', is_admin: false, status: 1, groups: ['研发部', '前端组'] }], total: 1, page: 1, size: 20 }
      }
      if (path === '/api/admin/departments') return { departments: depts }
      return {}
    })
    render(<Users />)
    await screen.findByText('multi')
    fireEvent.click(screen.getByRole('button', { name: '部门' }))
    const dialog = within(await screen.findByRole('dialog'))
    expect(await dialog.findByText(/该用户当前归属 2 个组/)).toBeInTheDocument()
    expect(dialog.getByText(/保存将替换该用户全部部门归属/)).toBeInTheDocument()
  })
})

  it('员工金额配额:打开对话框设置 token+金额并保存', async () => {
    render(<Users />)
    await screen.findByText('alice')
    fireEvent.click(screen.getAllByRole('button', { name: '配额' })[0])
    const dialog = within(await screen.findByRole('dialog'))
    expect(dialog.getByText(/流量配额/)).toBeInTheDocument()
    const tokenInput = dialog.getByLabelText('月度 token 配额')
    const moneyInput = dialog.getByLabelText('月度金额配额(元)')
    fireEvent.change(tokenInput, { target: { value: '50000' } })
    fireEvent.change(moneyInput, { target: { value: '100' } })
    fireEvent.click(dialog.getByRole('button', { name: '保存' }))
    expect(mockRequest).toHaveBeenCalledWith(
      '/api/admin/users/1',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ quota_tokens: 50000, quota_money: 100 }),
      }),
    )
  })

  it('员工金额配额:留空清空金额(quota_money_clear)', async () => {
    render(<Users />)
    await screen.findByText('alice')
    fireEvent.click(screen.getAllByRole('button', { name: '配额' })[0])
    const dialog = within(await screen.findByRole('dialog'))
    fireEvent.click(dialog.getByRole('button', { name: '保存' }))
    expect(mockRequest).toHaveBeenCalledWith(
      '/api/admin/users/1',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ quota_clear: true, quota_money_clear: true }),
      }),
    )
  })
