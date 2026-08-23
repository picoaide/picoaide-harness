import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, within, act } from '@testing-library/react'
import Knowledge from './Knowledge'
import { request } from '../api'

const confirmSpy = vi.fn(() => true)

const mockRequest = vi.mocked(request)

afterEach(() => {
  vi.useRealTimers()
})

beforeEach(() => {
  window.confirm = confirmSpy as any
  mockRequest.mockReset()
  mockRequest.mockImplementation(async (path: string) => {
    if (path === '/api/admin/kb/folders') return { folders: [{ id: 1, name: '研发部', parent_id: 0 }] }
    if (path === '/api/admin/departments') return { departments: [{ id: 1, name: '研发部', parent_id: 0 }, { id: 4, name: '财务部', parent_id: 0 }] }
    if (path.startsWith('/api/admin/kb/documents')) return { documents: [], total: 0 }
    if (path === '/api/admin/kb/import-status') return { status: { pending: 0, ready: 0, error: 0, total: 0 }, errors: [] }
    if (path === '/api/admin/kb/embedding-model') return { model: '' }
    if (path.startsWith('/api/admin/kb/folders/1/grants')) return { users: ['alice'], groups: ['研发部'] }
    if (path.startsWith('/api/admin/kb/search')) {
      return {
        mode: 'hybrid',
        total: 1,
        results: [{ chunk_id: 11, doc_id: 1, title: '差旅管理管理制度', title_path: '第一章 总则', content: '差旅费报销政策及流程说明', score: 0.85 }],
      }
    }
    return {}
  })
})

describe('Knowledge 知识库页', () => {
  it('渲染文件夹列表与文档表格空态', async () => {
    render(<Knowledge />)
    expect(await screen.findByText('研发部')).toBeInTheDocument()
    expect(await screen.findByText(/暂无文档/)).toBeInTheDocument()
  })

  it('命中测试:输入关键词后渲染块级结果(标题路径 + score)', async () => {
    render(<Knowledge />)
    await screen.findByText('研发部')
    fireEvent.change(screen.getByPlaceholderText(/搜索知识库/), { target: { value: '报销' } })
    fireEvent.click(screen.getByRole('button', { name: '搜索' }))
    expect(await screen.findByText('差旅管理管理制度')).toBeInTheDocument()
    expect(screen.getByText(/› 第一章 总则/)).toBeInTheDocument()
    expect(screen.getByText(/score 0.85/)).toBeInTheDocument()
    expect(screen.getAllByText('混合检索').length).toBeGreaterThanOrEqual(1)
  })

  it('授权对话框:展示已有授权(用户/组)并撤销', async () => {
    render(<Knowledge />)
    await screen.findByText('研发部')
    // 文件夹行的授权按钮
    const grantBtn = screen.getAllByRole('button', { name: '授权' })[0]
    fireEvent.click(grantBtn)
    const dialog = within(await screen.findByRole('dialog'))
    expect(await dialog.findByText('alice')).toBeInTheDocument()
    expect(dialog.getByText('@研发部')).toBeInTheDocument()
    fireEvent.click(dialog.getAllByRole('button', { name: '撤销' })[0])
    expect(mockRequest).toHaveBeenCalledWith(
      '/api/admin/kb/folders/1/grant',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('授权对话框:勾选部门多选保存(整组替换)', async () => {
    mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/admin/kb/folders/1/grants' && init?.method === 'PUT') return { ok: true }
      if (path === '/api/admin/kb/folders/1/grants') return { users: [], groups: [] }
      return {
        folders: [{ id: 1, name: '研发部', parent_id: 0 }],
        departments: [{ id: 1, name: '研发部', parent_id: 0 }, { id: 4, name: '财务部', parent_id: 0 }],
        documents: [], total: 0,
        status: { pending: 0, ready: 0, error: 0, total: 0 }, errors: [],
        model: '',
      } as any
    })
    render(<Knowledge />)
    await screen.findByText('研发部')
    fireEvent.click(screen.getAllByRole('button', { name: '授权' })[0])
    const dialog = within(await screen.findByRole('dialog'))
    // 勾选研发部 → 保存部门授权(整组替换)
    fireEvent.click(dialog.getByLabelText(/研发部/))
    fireEvent.click(dialog.getByRole('button', { name: '保存部门授权' }))
    expect(mockRequest).toHaveBeenCalledWith(
      '/api/admin/kb/folders/1/grants',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ groups: ['研发部'] }) }),
    )
  })

  // H1: processing 状态在 pending==0 时仍可见,进度面板不被隐藏
  it('导入进度:processing 徽标在 pending==0 时可见', async () => {
    const resolvers: ((v: any) => void)[] = []
    mockRequest.mockImplementation(async (path: string) => {
      if (path === '/api/admin/kb/import-status') return new Promise((res) => resolvers.push(res))
      if (path === '/api/admin/kb/folders') return { folders: [] }
      if (path === '/api/admin/departments') return { departments: [] }
      if (path === '/api/admin/kb/embedding-model') return { model: '' }
      if (path.startsWith('/api/admin/kb/documents')) return { documents: [], total: 0 }
      return {}
    })
    render(<Knowledge />)
    // 初始快照:pending=0 但 processing=1 → 徽标仍显示(轮询条件不含 processing 时会隐藏)
    await act(async () => {
      resolvers.shift()?.({ status: { pending: 0, processing: 1, ready: 1, error: 0, total: 2 }, errors: [] })
    })
    expect(screen.getByText(/1 处理中/)).toBeInTheDocument()
    expect(screen.getByText(/共 2 篇/)).toBeInTheDocument()
  })

  // M1: 授权加载失败时不打开弹窗(防止空勾选保存清空授权)
  it('授权对话框:grants 加载失败不打开弹窗', async () => {
    mockRequest.mockImplementation(async (path: string) => {
      if (path === '/api/admin/kb/folders/1/grants') throw new Error('网络错误')
      if (path === '/api/admin/kb/folders') return { folders: [{ id: 1, name: '研发部', parent_id: 0 }] }
      if (path === '/api/admin/departments') return { departments: [] }
      if (path === '/api/admin/kb/embedding-model') return { model: '' }
      if (path.startsWith('/api/admin/kb/documents')) return { documents: [], total: 0 }
      if (path === '/api/admin/kb/import-status') return { status: { pending: 0, processing: 0, ready: 0, error: 0, total: 0 }, errors: [] }
      return {}
    })
    render(<Knowledge />)
    await screen.findByText('研发部')
    fireEvent.click(screen.getAllByRole('button', { name: '授权' })[0])
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  // M2: 搜索结果分页请求携带 page 参数
  it('搜索分页:下一页携带 page=2', async () => {
    mockRequest.mockImplementation(async (path: string) => {
      if (path === '/api/admin/kb/folders') return { folders: [{ id: 1, name: '研发部', parent_id: 0 }] }
      if (path === '/api/admin/departments') return { departments: [] }
      if (path === '/api/admin/kb/embedding-model') return { model: '' }
      if (path.startsWith('/api/admin/kb/documents')) return { documents: [], total: 0 }
      if (path === '/api/admin/kb/import-status') return { status: { pending: 0, processing: 0, ready: 0, error: 0, total: 0 }, errors: [] }
      if (path.startsWith('/api/admin/kb/search')) {
        return {
          mode: 'lexical',
          total: 25,
          results: [{ chunk_id: 11, doc_id: 1, title: '差旅管理管理制度', title_path: '第一章 总则', content: '差旅费报销政策及流程说明', score: 0.85 }],
        }
      }
      return {}
    })
    render(<Knowledge />)
    await screen.findByText('研发部')
    fireEvent.change(screen.getByPlaceholderText(/搜索知识库/), { target: { value: '报销' } })
    fireEvent.click(screen.getByRole('button', { name: '搜索' }))
    expect(await screen.findByText('差旅管理管理制度')).toBeInTheDocument()
    // 25 条 → 2 页,下一页可用
    const next = screen.getByRole('button', { name: '下一页' })
    expect(next).toBeEnabled()
    fireEvent.click(next)
    const searchCalls = mockRequest.mock.calls.filter((c) => String(c[0]).includes('/api/admin/kb/search'))
    expect(searchCalls.length).toBeGreaterThanOrEqual(2)
    expect(String(searchCalls[1][0])).toContain('page=2')
  })
})
