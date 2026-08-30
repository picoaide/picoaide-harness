import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { request } from '../api'
import Connectors from './Connectors'

const mockRequest = vi.mocked(request)

const ROWS = [
  {
    id: 'moka', name: 'Moka HR 智能体', description: '招聘人事', auth_mode: 'oauth',
    definition: '{"mcp":[{"serverName":"moka","transport":"streamable-http","url":"https://mcp.mokahr.com/mcp"}]}',
    enabled: true, updated_at: '2026-08-28T10:00:00+08:00', created_at: '2026-08-28T10:00:00+08:00',
  },
  {
    id: 'glitchtip', name: 'GlitchTip', description: '错误追踪', auth_mode: 'token',
    definition: '{"tokenFields":[{"key":"GLITCHTIP_TOKEN","label":"Token","type":"password","required":true}],"mcp":[{"serverName":"glitchtip","transport":"stdio","command":"npx","args":["-y","glitchtip-mcp"]}]}',
    enabled: true, updated_at: '2026-08-28T10:00:00+08:00', created_at: '2026-08-28T10:00:00+08:00',
  },
]

beforeEach(() => {
  mockRequest.mockReset()
  mockRequest.mockImplementation(async (path: string) => {
    if (path === '/api/server/admin/connectors') return { connectors: ROWS }
    return {}
  })
})

describe('Connectors 连接器目录页', () => {
  it('渲染列表: 编号/名称/认证/下发开关', async () => {
    render(<Connectors />)
    expect(await screen.findByText('Moka HR 智能体')).toBeInTheDocument()
    expect(screen.getByText('glitchtip')).toBeInTheDocument()
    expect(screen.getByText('OAuth')).toBeInTheDocument()
    expect(screen.getByText('Token')).toBeInTheDocument()
  })

  it('新建连接器:填表提交 POST', async () => {
    render(<Connectors />)
    await screen.findByText('Moka HR 智能体')
    fireEvent.click(screen.getByRole('button', { name: '新建连接器' }))
    fireEvent.change(screen.getByLabelText('编号(不可改,客户端按 id 匹配凭证)'), { target: { value: 'feishu' } })
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '飞书' } })
    fireEvent.change(screen.getByLabelText('描述'), { target: { value: '协作' } })
    fireEvent.change(screen.getByLabelText('定义 JSON(与客户端 ConnectorDef 对齐)'), {
      target: { value: '{"mcp":[{"serverName":"feishu","transport":"streamable-http","url":"https://x"}]}' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('/api/server/admin/connectors', {
        method: 'POST',
        body: JSON.stringify({
          id: 'feishu', name: '飞书', description: '协作', auth_mode: 'token',
          definition: '{"mcp":[{"serverName":"feishu","transport":"streamable-http","url":"https://x"}]}',
          enabled: true,
        }),
      })
    })
  })

  it('切换下发开关调用 enabled 端点', async () => {
    render(<Connectors />)
    await screen.findByText('Moka HR 智能体')
    // 第一行的 switch
    const switches = screen.getAllByRole('switch')
    fireEvent.click(switches[0]!)
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('/api/server/admin/connectors/moka/enabled', {
        method: 'PUT',
        body: JSON.stringify({ enabled: false }),
      })
    })
  })

  it('编辑:预填并保存 PUT', async () => {
    render(<Connectors />)
    await screen.findByText('Moka HR 智能体')
    const editBtns = screen.getAllByTitle('编辑')
    fireEvent.click(editBtns[0]!)
    const nameInput = await screen.findByLabelText('名称')
    expect((nameInput as HTMLInputElement).value).toBe('Moka HR 智能体')
    fireEvent.change(nameInput, { target: { value: 'Moka HR 智能体 v2' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('/api/server/admin/connectors/moka', {
        method: 'PUT',
        body: expect.stringContaining('Moka HR 智能体 v2'),
      })
    })
  })

  it('删除:确认后调用 DELETE', async () => {
    render(<Connectors />)
    await screen.findByText('Moka HR 智能体')
    const delBtns = screen.getAllByTitle('删除')
    fireEvent.click(delBtns[0]!)
    fireEvent.click(await screen.findByRole('button', { name: '删除' }))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('/api/server/admin/connectors/moka', { method: 'DELETE' })
    })
  })
})
