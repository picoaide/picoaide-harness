import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react'
import Marketplace from './Marketplace'
import { request } from '../api'

const mockRequest = vi.mocked(request)
const confirmSpy = vi.fn(() => true)

const SKILLS = [
  { id: 1, name: 'data-extract', version: '1.0.0', description: '数据提取', author: 'seed', git_url: 'https://x/data-extract', git_ref: 'main', enabled: true },
  { id: 2, name: 'legacy', version: '0.9.0', description: '旧版', author: 'seed', git_url: 'https://x/legacy', git_ref: 'main', enabled: false },
]
const MCPS = [
  { id: 1, name: 'time-now', description: '时间', transport: 'stdio', command: 'date', args: [], url: '', env: { API_KEY: '***', TIMEOUT: '30' }, headers: {}, enabled: true },
  { id: 2, name: 'old-plugin', description: '旧插件', transport: 'stdio', command: 'date', args: [], url: '', env: {}, headers: {}, enabled: false },
]
const DEPTS = [{ id: 1, name: '研发部', parent_id: 0 }, { id: 2, name: '人事部', parent_id: 0 }]

function defaultMock() {
  mockRequest.mockImplementation(async (path: string) => {
    if (path === '/api/admin/departments') return { departments: DEPTS }
    if (path === '/api/admin/skills') return { skills: SKILLS }
    if (path === '/api/admin/mcp') return { mcp: MCPS }
    if (path.startsWith('/api/admin/mcp-downloads')) return { downloads: [], total: 0 }
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
  it('渲染技能与 MCP 表格,状态徽标按 enabled 展示', async () => {
    render(<Marketplace />)
    expect(await screen.findByText('data-extract')).toBeInTheDocument()
    expect(await screen.findByText('time-now')).toBeInTheDocument()
    // H1: enabled=true → 上架;enabled=false → 已下架
    expect(screen.getByText('data-extract').closest('tr')!.textContent).toContain('上架')
    expect(screen.getByText('legacy').closest('tr')!.textContent).toContain('已下架')
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
      if (path === '/api/admin/mcp') return { mcp: MCPS }
      if (path.startsWith('/api/admin/mcp-downloads')) return { downloads: [], total: 0 }
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
    // 技能表在 MCP 表之前,第一个「重新上架」属于技能行
    fireEvent.click(screen.getAllByRole('button', { name: '重新上架' })[0])
    expect(mockRequest).toHaveBeenCalledWith('/api/admin/skills/legacy/enable', { method: 'POST' })
  })

  it('M1: 已下架 MCP 显示「重新上架」并调用 enable 端点', async () => {
    render(<Marketplace />)
    await screen.findByText('old-plugin')
    // 第二个「重新上架」属于 MCP 行(技能表在前)
    fireEvent.click(screen.getAllByRole('button', { name: '重新上架' })[1])
    expect(mockRequest).toHaveBeenCalledWith('/api/admin/mcp/2/enable', { method: 'POST' })
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

  it('M2+H2: 编辑 MCP 回填掩码凭证,保存时 *** 原样回传(服务端保持原值)', async () => {
    render(<Marketplace />)
    await screen.findByText('time-now')
    fireEvent.click(within(screen.getByText('time-now').closest('tr')!).getByRole('button', { name: '编辑' }))
    const dialog = within(await screen.findByRole('dialog'))
    const envInput = dialog.getByLabelText(/环境变量/) as HTMLInputElement
    expect(envInput.value).toContain('***')
    expect(envInput.value).toContain('TIMEOUT')
    fireEvent.click(dialog.getByRole('button', { name: '保存修改' }))
    await waitFor(() => {
      const putCall = mockRequest.mock.calls.find(([p, i]) => p === '/api/admin/mcp/1' && i?.method === 'PUT')
      expect(putCall).toBeTruthy()
      const body = JSON.parse((putCall![1] as RequestInit).body as string)
      expect(body.env.API_KEY).toBe('***')
      expect(body.env.TIMEOUT).toBe('30')
    })
  })

  it('M5: 下载记录超过一页时显示总数与下一页', async () => {
    const items = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, username: `u${i}`, mcp_name: 'time-now', created_at: '2026-01-01T00:00:00Z' }))
    mockRequest.mockImplementation(async (path: string) => {
      if (path === '/api/admin/departments') return { departments: DEPTS }
      if (path === '/api/admin/skills') return { skills: SKILLS }
      if (path === '/api/admin/mcp') return { mcp: MCPS }
      if (path.startsWith('/api/admin/mcp-downloads')) return { downloads: items, total: 25 }
      return {}
    })
    render(<Marketplace />)
    expect(await screen.findByText('共 25 条')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    expect(mockRequest).toHaveBeenCalledWith('/api/admin/mcp-downloads?page=2&size=20')
  })

  it('L3: 空列表显示空态文案', async () => {
    mockRequest.mockImplementation(async (path: string) => {
      if (path === '/api/admin/departments') return { departments: DEPTS }
      if (path === '/api/admin/skills') return { skills: [] }
      if (path === '/api/admin/mcp') return { mcp: [] }
      if (path.startsWith('/api/admin/mcp-downloads')) return { downloads: [], total: 0 }
      return {}
    })
    render(<Marketplace />)
    expect(await screen.findByText(/暂无技能/)).toBeInTheDocument()
    expect(await screen.findByText(/暂无插件/)).toBeInTheDocument()
  })

  it('M4: 技能加载失败显示错误与重试,重试成功恢复列表', async () => {
    let fail = true
    mockRequest.mockImplementation(async (path: string) => {
      if (path === '/api/admin/departments') return { departments: DEPTS }
      if (path === '/api/admin/skills') {
        if (fail) throw new Error('skills 加载失败')
        return { skills: SKILLS }
      }
      if (path === '/api/admin/mcp') return { mcp: MCPS }
      if (path.startsWith('/api/admin/mcp-downloads')) return { downloads: [], total: 0 }
      return {}
    })
    render(<Marketplace />)
    expect(await screen.findByText(/技能加载失败/)).toBeInTheDocument()
    // MCP 卡片不受技能失败影响(独立加载)
    expect(await screen.findByText('time-now')).toBeInTheDocument()
    fail = false
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByText('data-extract')).toBeInTheDocument()
  })
})
