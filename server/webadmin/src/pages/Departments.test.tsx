import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import Departments from './Departments'
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
    if (path === '/api/admin/departments') return { departments: depts }
    if (path === '/api/admin/users?size=200') {
      return { users: [{ id: 2, username: 'alice', is_admin: false, status: 1, groups: ['研发部'] }], total: 1, page: 1, size: 200 }
    }
    if (path === '/api/admin/departments' && init?.method === 'POST') return { department: { id: 3, name: '财务部' } }
    if (path === '/api/admin/departments/1' && init?.method === 'PUT') return { ok: true }
    if (path === '/api/admin/departments/1' && init?.method === 'DELETE') return { ok: true }
    return {}
  })
})

describe('Departments 部门管理页', () => {
  it('渲染部门树表格:层级/主管/成员数/已授权徽标', async () => {
    render(<Departments />)
    expect(await screen.findByText('部门管理')).toBeInTheDocument()
    expect(screen.getAllByText('研发部').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('前端组').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('alice').length).toBeGreaterThanOrEqual(1) // 主管列
    expect(screen.getAllByText('已授权').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('1').length).toBeGreaterThanOrEqual(1) // 成员数
  })

  it('新建部门:提交 POST /departments', async () => {
    render(<Departments />)
    await screen.findByText('部门管理')
    fireEvent.click(screen.getByRole('button', { name: '新建部门' }))
    const dialog = within(await screen.findByRole('dialog'))
    fireEvent.change(dialog.getByPlaceholderText('如 研发部'), { target: { value: '财务部' } })
    fireEvent.click(dialog.getByRole('button', { name: '保存' }))
    expect(mockRequest).toHaveBeenCalledWith(
      '/api/admin/departments',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('新建部门:父级下拉可选已有部门(高1:新建时不得排除整棵树)', async () => {
    render(<Departments />)
    await screen.findByText('部门管理')
    fireEvent.click(screen.getByRole('button', { name: '新建部门' }))
    const dialog = within(await screen.findByRole('dialog'))
    fireEvent.click(dialog.getByRole('combobox', { name: '上级部门' }))
    // 新建时父级候选必须包含已有顶层部门 研发部 与 前端组
    expect(await screen.findByRole('option', { name: '研发部' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /前端组/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('option', { name: '研发部' }))
    expect(dialog.getByRole('combobox', { name: '上级部门' })).toHaveTextContent('研发部')
  })

  it('编辑部门:父级下拉排除自身及其子树', async () => {
    render(<Departments />)
    await screen.findByText('部门管理')
    fireEvent.click(screen.getAllByRole('button', { name: '编辑' })[0]) // 研发部
    const dialog = within(await screen.findByRole('dialog'))
    fireEvent.click(dialog.getByRole('combobox', { name: '上级部门' }))
    // 自身(研发部)与子部门(前端组)都不能作为自己的父级
    expect(screen.queryByRole('option', { name: '研发部' })).not.toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /前端组/ })).not.toBeInTheDocument()
    // 但同层其他部门(人事部不存在于 mock,此处验证顶层「无」选项仍在)
    expect(screen.getByRole('option', { name: '无(顶层部门)' })).toBeInTheDocument()
  })

  it('编辑部门:主管下拉列出用户,保存调用 PUT', async () => {
    render(<Departments />)
    await screen.findByText('部门管理')
    fireEvent.click(screen.getAllByRole('button', { name: '编辑' })[0])
    const dialog = within(await screen.findByRole('dialog'))
    expect((dialog.getByPlaceholderText('如 研发部') as HTMLInputElement).value).toBe('研发部')
    fireEvent.click(dialog.getByRole('button', { name: '保存' }))
    expect(mockRequest).toHaveBeenCalledWith(
      '/api/admin/departments/1',
      expect.objectContaining({ method: 'PUT' }),
    )
  })

  it('删除部门:确认后调用 DELETE', async () => {
    render(<Departments />)
    await screen.findByText('部门管理')
    fireEvent.click(screen.getAllByRole('button', { name: '删除' })[0])
    expect(mockRequest).toHaveBeenCalledWith(
      '/api/admin/departments/1',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })
})

  it('部门预算:表格展示费用/预算进度条,编辑提交 budget_money', async () => {
    mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/admin/departments') {
        return {
          departments: [
            { id: 1, name: '研发部', parent_id: 0, leader_id: 2, leader_name: 'alice', description: '', member_count: 1, child_count: 1, granted_count: 0, budget_money: 1000, monthly_cost: 800 },
            { id: 2, name: '前端组', parent_id: 1, leader_id: 0, leader_name: '', description: '', member_count: 1, child_count: 0, granted_count: 0, budget_money: null, monthly_cost: 0 },
          ],
        }
      }
      if (path === '/api/admin/users?size=200') return { users: [{ id: 2, username: 'alice', is_admin: false, status: 1, groups: ['研发部'] }], total: 1, page: 1, size: 200 }
      if (path === '/api/admin/departments/1' && init?.method === 'PUT') return { ok: true }
      return {}
    })
    render(<Departments />)
    await screen.findByText('部门管理')
    // 研发部预算 800/1000 = 80%;前端组无自身预算但受研发部预算约束(中6)
    expect(await screen.findByText(/¥800/)).toBeInTheDocument()
    expect(screen.getByText(/继承上级\(研发部/)).toBeInTheDocument()

    // 编辑部门填预算
    fireEvent.click(screen.getAllByRole('button', { name: '编辑' })[0])
    const dialog = within(await screen.findByRole('dialog'))
    const budgetInput = dialog.getByLabelText('月度金额预算(元,可选)')
    fireEvent.change(budgetInput, { target: { value: '2000' } })
    fireEvent.click(dialog.getByRole('button', { name: '保存' }))
    expect(mockRequest).toHaveBeenCalledWith(
      '/api/admin/departments/1',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ name: '研发部', parent_id: 0, leader_id: 2, description: '', budget_money: 2000 }) }),
    )
  })

  it('部门预算:留空保持现值,输入 0 清除预算', async () => {
    render(<Departments />)
    await screen.findByText('部门管理')
    fireEvent.click(screen.getAllByRole('button', { name: '编辑' })[0])
    const dialog = within(await screen.findByRole('dialog'))
    const budgetInput = dialog.getByLabelText('月度金额预算(元,可选)')
    fireEvent.change(budgetInput, { target: { value: '0' } })
    fireEvent.click(dialog.getByRole('button', { name: '保存' }))
    expect(mockRequest).toHaveBeenCalledWith(
      '/api/admin/departments/1',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ name: '研发部', parent_id: 0, leader_id: 2, description: '', budget_money: 0 }) }),
    )
  })

  it('子部门无自身预算但祖先有预算:显示继承提示而非「不限」(中6)', async () => {
    mockRequest.mockImplementation(async (path: string) => {
      if (path === '/api/admin/departments') {
        return {
          departments: [
            { id: 1, name: '研发部', parent_id: 0, leader_id: 2, leader_name: 'alice', description: '', member_count: 1, child_count: 1, granted_count: 0, budget_money: 1000, monthly_cost: 800 },
            { id: 2, name: '前端组', parent_id: 1, leader_id: 0, leader_name: '', description: '', member_count: 1, child_count: 0, granted_count: 0, budget_money: null, monthly_cost: 0 },
            { id: 3, name: '人事部', parent_id: 0, leader_id: 0, leader_name: '', description: '', member_count: 0, child_count: 0, granted_count: 0, budget_money: null, monthly_cost: 0 },
          ],
        }
      }
      if (path === '/api/admin/users?size=200') return { users: [], total: 0, page: 1, size: 200 }
      return {}
    })
    render(<Departments />)
    await screen.findByText('部门管理')
    // 前端组继承研发部预算
    expect(await screen.findByText(/继承上级\(研发部/)).toBeInTheDocument()
    // 人事部无任何祖先预算 → 不限
    expect(screen.getAllByText('不限').length).toBeGreaterThanOrEqual(1)
  })

  it('用户超过 200 时主管下拉给出提示(L15)', async () => {
    mockRequest.mockImplementation(async (path: string) => {
      if (path === '/api/admin/departments') return { departments: depts }
      if (path === '/api/admin/users?size=200') {
        const users = Array.from({ length: 200 }, (_, i) => ({ id: i + 1, username: `user${i}`, is_admin: false, status: 1, groups: [] }))
        return { users, total: 200, page: 1, size: 200 }
      }
      return {}
    })
    render(<Departments />)
    await screen.findByText('部门管理')
    fireEvent.click(screen.getByRole('button', { name: '新建部门' }))
    const dialog = within(await screen.findByRole('dialog'))
    expect(dialog.getByText(/仅展示前 200 名/)).toBeInTheDocument()
  })
