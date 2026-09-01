import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { request } from '../api'
import Connectors from './Connectors'

const mockRequest = vi.mocked(request)

const ROWS = [
  {
    id: 'example-crm', name: 'Moka HR 智能体', description: '招聘人事', auth_mode: 'oauth',
    definition: '{"auth":{"discoveryUrl":"https://mcp.example.com/mcp","pkce":true,"publicClient":true},"mcp":[{"serverName":"example-crm","transport":"streamable-http","url":"https://mcp.example.com/mcp"}]}',
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

  it('新建连接器:图形化填表提交 POST(表单生成定义 JSON)', async () => {
    render(<Connectors />)
    await screen.findByText('Moka HR 智能体')
    fireEvent.click(screen.getByRole('button', { name: '新建连接器' }))
    const dialog = within(await screen.findByRole('dialog'))
    fireEvent.change(dialog.getByLabelText('编号(不可改,客户端按 id 匹配凭证)'), { target: { value: 'feishu' } })
    fireEvent.change(dialog.getByLabelText('名称'), { target: { value: '飞书' } })
    fireEvent.change(dialog.getByLabelText('描述'), { target: { value: '协作' } })
    // 默认 token 模式:填一个 Token 表单字段
    fireEvent.change(dialog.getByLabelText('字段 key 1'), { target: { value: 'TOKEN' } })
    fireEvent.change(dialog.getByLabelText('字段显示名 1'), { target: { value: 'Token' } })
    // MCP(默认 streamable-http):填 serverName 与 URL
    fireEvent.change(dialog.getByLabelText('服务器名 serverName(名称空间,小写)'), { target: { value: 'feishu' } })
    fireEvent.change(dialog.getByLabelText('端点 URL(必填)'), { target: { value: 'https://mcp.feishu.cn/mcp' } })
    // 实时 JSON 预览应已生成
    const preview = dialog.getByLabelText('定义 JSON(与客户端 ConnectorDef 对齐,实时生成)') as HTMLTextAreaElement
    expect(preview.value).toContain('"serverName": "feishu"')
    expect(preview.value).toContain('"https://mcp.feishu.cn/mcp"')
    fireEvent.click(dialog.getByRole('button', { name: '保存' }))
    await waitFor(() => {
      // 注意:definition 是内嵌 JSON 字符串,body 内引号已转义
      expect(mockRequest).toHaveBeenCalledWith('/api/server/admin/connectors', expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('\\"serverName\\": \\"feishu\\"'),
      }))
    })
  })

  it('从 JSON 导入:粘贴标准定义解析并填充表单', async () => {
    render(<Connectors />)
    await screen.findByText('Moka HR 智能体')
    fireEvent.click(screen.getByRole('button', { name: '新建连接器' }))
    const dialog = within(await screen.findByRole('dialog'))
    fireEvent.change(dialog.getByLabelText('编号(不可改,客户端按 id 匹配凭证)'), { target: { value: 'example-crm2' } })
    fireEvent.change(dialog.getByLabelText('名称'), { target: { value: 'Moka2' } })
    fireEvent.click(dialog.getByRole('button', { name: '从 JSON 导入' }))
    fireEvent.change(dialog.getByLabelText('JSON'), {
      target: { value: '{"tokenFields":[{"key":"K","label":"K","type":"text","required":true}],"mcp":[{"serverName":"m2","transport":"streamable-http","url":"https://m.example.com/mcp"}]}' },
    })
    fireEvent.click(dialog.getByRole('button', { name: '解析导入' }))
    // 导入后表单被填充:认证方式切换为 token,字段/MCP 回填
    await waitFor(() => {
      expect((dialog.getByLabelText('字段 key 1') as HTMLInputElement).value).toBe('K')
    })
    expect((dialog.getByLabelText('服务器名 serverName(名称空间,小写)') as HTMLInputElement).value).toBe('m2')
    // 保存下发即导入的定义(含 authMode 推导)
    fireEvent.click(dialog.getByRole('button', { name: '保存' }))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('/api/server/admin/connectors', expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('\\"serverName\\": \\"m2\\"'),
      }))
    })
  })

  it('从示例模板开始:一键填充 OAuth + 远程 MCP', async () => {
    render(<Connectors />)
    await screen.findByText('Moka HR 智能体')
    fireEvent.click(screen.getByRole('button', { name: '新建连接器' }))
    const dialog = within(await screen.findByRole('dialog'))
    fireEvent.click(dialog.getByRole('button', { name: '从 JSON 导入' }))
    fireEvent.click(dialog.getByRole('button', { name: 'Moka(远程 MCP + OAuth 发现)' }))
    const preview = dialog.getByLabelText('定义 JSON(与客户端 ConnectorDef 对齐,实时生成)') as HTMLTextAreaElement
    expect(preview.value).toContain('"discoveryUrl": "https://mcp.example.com/mcp"')
    expect(preview.value).toContain('"serverName": "example-crm"')
    // 示例同时填好名称/描述;补编号后即可保存
    fireEvent.change(dialog.getByLabelText('编号(不可改,客户端按 id 匹配凭证)'), { target: { value: 'example-crm' } })
    fireEvent.click(dialog.getByRole('button', { name: '保存' }))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('/api/server/admin/connectors', expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"auth_mode":"oauth"'),
      }))
    })
  })

  it('切换下发开关调用 enabled 端点', async () => {
    render(<Connectors />)
    await screen.findByText('Moka HR 智能体')
    // 第一行的 switch
    const switches = screen.getAllByRole('switch')
    fireEvent.click(switches[0]!)
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('/api/server/admin/connectors/example-crm/enabled', {
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
      expect(mockRequest).toHaveBeenCalledWith('/api/server/admin/connectors/example-crm', {
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
      expect(mockRequest).toHaveBeenCalledWith('/api/server/admin/connectors/example-crm', { method: 'DELETE' })
    })
  })
})
