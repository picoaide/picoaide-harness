import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import Marketplace from './Marketplace'
import { request } from '../api'

const mockRequest = vi.mocked(request)
const confirmSpy = vi.fn(() => true)

const SKILLS = [
  { id: 1, name: 'data-extract', version: '1.0.0', description: '数据提取', author: 'seed', git_url: 'https://x/data-extract', git_ref: 'main', enabled: true },
  { id: 2, name: 'legacy', version: '0.9.0', description: '旧版', author: 'seed', git_url: 'https://x/legacy', git_ref: 'main', enabled: false },
]
const DEPTS = [{ id: 1, name: '研发部', parent_id: 0 }, { id: 2, name: '人事部', parent_id: 0 }]

function defaultMock() {
  mockRequest.mockImplementation(async (path: string) => {
    if (path === '/api/admin/departments') return { departments: DEPTS }
    if (path === '/api/admin/skills') return { skills: SKILLS }
    if (path === '/api/admin/skills/data-extract/grants') return { grants: [{ grantee_type: 'group', grantee: '研发部' }] }
    return {}
  })
}

beforeEach(() => {
  window.confirm = confirmSpy as any
  mockRequest.mockReset()
  defaultMock()
})

describe('Marketplace 商城页', () => {
  it('渲染技能表格,状态徽标按 enabled 展示', async () => {
    render(<Marketplace />)
    expect(await screen.findByText('data-extract')).toBeInTheDocument()
    // H1: enabled=true → 上架;enabled=false → 已下架
    expect(screen.getByText('data-extract').closest('tr')!.textContent).toContain('上架')
    expect(screen.getByText('legacy').closest('tr')!.textContent).toContain('已下架')
    expect(screen.queryByText('MCP 插件')).not.toBeInTheDocument()
  })

  it('技能授权对话框:展示已有组授权并可撤销', async () => {
    render(<Marketplace />)
    await screen.findByText('data-extract')
    fireEvent.click(screen.getAllByRole('button', { name: '授权' })[0])
    const dialog = within(await screen.findByRole('dialog'))
    expect(await dialog.findByText('@研发部')).toBeInTheDocument()
    expect(dialog.queryByText(/未授权:所有用户均不可见/)).not.toBeInTheDocument()
    fireEvent.click(dialog.getAllByRole('button', { name: '撤销' })[0])
    expect(mockRequest).toHaveBeenCalledWith(
      '/api/admin/skills/data-extract/grant',
      expect.objectContaining({ method: 'DELETE', body: JSON.stringify({ group: '研发部' }) }),
    )
  })

  it('技能授权对话框:勾选部门多选保存(整组替换,保存前需确认)', async () => {
    mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/admin/skills/data-extract/grants' && init?.method === 'PUT') return { ok: true }
      if (path === '/api/admin/departments') return { departments: DEPTS }
      if (path === '/api/admin/skills') return { skills: SKILLS }
      if (path === '/api/admin/skills/data-extract/grants') return { grants: [] }
      return {}
    })
    render(<Marketplace />)
    await screen.findByText('data-extract')
    fireEvent.click(screen.getAllByRole('button', { name: '授权' })[0])
    const dialog = within(await screen.findByRole('dialog'))
    expect(await dialog.findByText(/一个资源可授权多个部门/)).toBeInTheDocument()
    fireEvent.click(dialog.getByLabelText(/研发部/))
    fireEvent.click(dialog.getByRole('button', { name: '保存部门授权' }))
    expect(confirmSpy).toHaveBeenCalled()
    expect(mockRequest).toHaveBeenCalledWith(
      '/api/admin/skills/data-extract/grants',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ groups: ['研发部'] }) }),
    )
  })

  it('M6: 部门整组替换在用户取消确认时不发请求', async () => {
    window.confirm = vi.fn(() => false) as any
    render(<Marketplace />)
    await screen.findByText('data-extract')
    fireEvent.click(screen.getAllByRole('button', { name: '授权' })[0])
    const dialog = within(await screen.findByRole('dialog'))
    await dialog.findByText('@研发部')
    fireEvent.click(dialog.getByRole('button', { name: '保存部门授权' }))
    expect(mockRequest).not.toHaveBeenCalledWith(
      '/api/admin/skills/data-extract/grants',
      expect.objectContaining({ method: 'PUT' }),
    )
  })

  it('M1: 已下架技能显示「重新上架」并调用 enable 端点', async () => {
    render(<Marketplace />)
    await screen.findByText('legacy')
    fireEvent.click(screen.getAllByRole('button', { name: '重新上架' })[0])
    expect(mockRequest).toHaveBeenCalledWith('/api/admin/skills/legacy/enable', { method: 'POST' })
  })

  it('M2: 编辑技能对话框回填并提交 PUT', async () => {
    render(<Marketplace />)
    await screen.findByText('data-extract')
    fireEvent.click(screen.getAllByRole('button', { name: '编辑' })[0])
    const dialog = within(await screen.findByRole('dialog'))
    const nameInput = dialog.getByLabelText('名称') as HTMLInputElement
    expect(nameInput.value).toBe('data-extract')
    const verInput = dialog.getByLabelText('版本') as HTMLInputElement
    fireEvent.change(verInput, { target: { value: '2.0.0' } })
    fireEvent.click(dialog.getByRole('button', { name: '保存修改' }))
    expect(mockRequest).toHaveBeenCalledWith(
      '/api/admin/skills/data-extract',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ name: 'data-extract', git_url: 'https://x/data-extract', version: '2.0.0', description: '数据提取', author: 'seed' }),
      }),
    )
  })

  it('L3: 空列表显示空态文案', async () => {
    mockRequest.mockImplementation(async (path: string) => {
      if (path === '/api/admin/departments') return { departments: DEPTS }
      if (path === '/api/admin/skills') return { skills: [] }
      return {}
    })
    render(<Marketplace />)
    expect(await screen.findByText(/暂无技能/)).toBeInTheDocument()
  })

  it('M4: 技能加载失败显示错误与重试,重试成功恢复列表', async () => {
    let fail = true
    mockRequest.mockImplementation(async (path: string) => {
      if (path === '/api/admin/departments') return { departments: DEPTS }
      if (path === '/api/admin/skills') {
        if (fail) throw new Error('skills 加载失败')
        return { skills: SKILLS }
      }
      return {}
    })
    render(<Marketplace />)
    expect(await screen.findByText(/技能加载失败/)).toBeInTheDocument()
    fail = false
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByText('data-extract')).toBeInTheDocument()
  })
})
