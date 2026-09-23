import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { request } from '../api'
import Connectors from './Connectors'

const mockRequest = vi.mocked(request)

const ROWS = [
  {
    id: 'example-crm', name: '示例 MCP 智能体', description: '示例描述', auth_mode: 'oauth',
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
    expect(await screen.findByText('示例 MCP 智能体')).toBeInTheDocument()
    expect(screen.getByText('glitchtip')).toBeInTheDocument()
    expect(screen.getByText('OAuth')).toBeInTheDocument()
    expect(screen.getByText('Token')).toBeInTheDocument()
  })

  it('新建连接器:图形化填表提交 POST(表单生成定义 JSON)', async () => {
    render(<Connectors />)
    await screen.findByText('示例 MCP 智能体')
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
    await screen.findByText('示例 MCP 智能体')
    fireEvent.click(screen.getByRole('button', { name: '新建连接器' }))
    const dialog = within(await screen.findByRole('dialog'))
    fireEvent.change(dialog.getByLabelText('编号(不可改,客户端按 id 匹配凭证)'), { target: { value: 'example-crm2' } })
    fireEvent.change(dialog.getByLabelText('名称'), { target: { value: '示例智能体2' } })
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
    await screen.findByText('示例 MCP 智能体')
    fireEvent.click(screen.getByRole('button', { name: '新建连接器' }))
    const dialog = within(await screen.findByRole('dialog'))
    fireEvent.click(dialog.getByRole('button', { name: '从 JSON 导入' }))
    fireEvent.click(dialog.getByRole('button', { name: '示例 MCP 智能体(远程 MCP + OAuth 发现)' }))
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
    await screen.findByText('示例 MCP 智能体')
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
    await screen.findByText('示例 MCP 智能体')
    const editBtns = screen.getAllByTitle('编辑')
    fireEvent.click(editBtns[0]!)
    const nameInput = await screen.findByLabelText('名称')
    expect((nameInput as HTMLInputElement).value).toBe('示例 MCP 智能体')
    fireEvent.change(nameInput, { target: { value: '示例 MCP 智能体 v2' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('/api/server/admin/connectors/example-crm', {
        method: 'PUT',
        body: expect.stringContaining('示例 MCP 智能体 v2'),
      })
    })
  })

  it('编辑已停用连接器:保存载荷不含 enabled,保存后仍为停用(A-11)', async () => {
    // 有状态替身:实现服务端 89026689ba 起的**部分更新**契约 ——
    // PUT 省略 `enabled` ⇒ 保持现值(不是回落 true);给了值则以 body 为准。
    // 这样"保存后对象仍为停用"才是可判定的(否则替身恒回原值,断言恒真)。
    let stored: any = { ...ROWS[1], enabled: false }
    mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === 'PUT' && path === '/api/server/admin/connectors/glitchtip') {
        const body = JSON.parse(String(init.body))
        stored = {
          ...stored,
          name: body.name, description: body.description,
          auth_mode: body.auth_mode, definition: body.definition,
          ...('enabled' in body ? { enabled: body.enabled } : {}),
        }
        return {}
      }
      if (path === '/api/server/admin/connectors') return { connectors: [stored] }
      return {}
    })
    render(<Connectors />)
    await screen.findByText('glitchtip')
    fireEvent.click(screen.getAllByTitle('编辑')[0]!)
    const nameInput = await screen.findByLabelText('名称')
    fireEvent.change(nameInput, { target: { value: 'GlitchTip v2' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('/api/server/admin/connectors/glitchtip', expect.objectContaining({ method: 'PUT' }))
    })
    const call = mockRequest.mock.calls.find(([p, i]) => p === '/api/server/admin/connectors/glitchtip' && (i as RequestInit)?.method === 'PUT')
    const body = JSON.parse((call![1] as RequestInit).body as string)
    // ① webadmin 半边:表单没建模 `enabled`,就**不许**回传它
    expect(Object.keys(body)).not.toContain('enabled')
    expect(body.name).toBe('GlitchTip v2')
    // ② 保存后对象仍是停用(没有被静默复活)
    await waitFor(() => expect(stored.name).toBe('GlitchTip v2'))
    expect(stored.enabled).toBe(false)
    expect(await screen.findByRole('switch', { name: '下发 GlitchTip v2' })).toHaveAttribute('aria-checked', 'false')
  })

  it('新建连接器:保存载荷同样不含 enabled(启用与否由服务端缺省决定,A-11)', async () => {
    render(<Connectors />)
    await screen.findByText('示例 MCP 智能体')
    fireEvent.click(screen.getByRole('button', { name: '新建连接器' }))
    const dialog = within(await screen.findByRole('dialog'))
    fireEvent.change(dialog.getByLabelText('编号(不可改,客户端按 id 匹配凭证)'), { target: { value: 'feishu' } })
    fireEvent.change(dialog.getByLabelText('名称'), { target: { value: '飞书' } })
    fireEvent.change(dialog.getByLabelText('描述'), { target: { value: '协作' } })
    fireEvent.change(dialog.getByLabelText('字段 key 1'), { target: { value: 'TOKEN' } })
    fireEvent.change(dialog.getByLabelText('字段显示名 1'), { target: { value: 'Token' } })
    fireEvent.change(dialog.getByLabelText('服务器名 serverName(名称空间,小写)'), { target: { value: 'feishu' } })
    fireEvent.change(dialog.getByLabelText('端点 URL(必填)'), { target: { value: 'https://mcp.feishu.cn/mcp' } })
    fireEvent.click(dialog.getByRole('button', { name: '保存' }))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('/api/server/admin/connectors', expect.objectContaining({ method: 'POST' }))
    })
    const call = mockRequest.mock.calls.find(([p, i]) => p === '/api/server/admin/connectors' && (i as RequestInit)?.method === 'POST')
    const body = JSON.parse((call![1] as RequestInit).body as string)
    expect(Object.keys(body)).not.toContain('enabled')
  })

  it('编辑弹窗初值与提交体逐字段对拍(只改名称时其余字段原样回传,A-11)', async () => {
    render(<Connectors />)
    await screen.findByText('示例 MCP 智能体')
    fireEvent.click(screen.getAllByTitle('编辑')[0]!)
    const dialog = within(await screen.findByRole('dialog'))
    // 初值回填:名称/描述/编号/认证方式/定义 JSON 全部来自该行
    const nameInput = (await dialog.findByLabelText('名称')) as HTMLInputElement
    const descInput = dialog.getByLabelText('描述') as HTMLInputElement
    const authSelect = dialog.getByLabelText('认证方式')
    const defArea = dialog.getByLabelText('定义 JSON(与客户端 ConnectorDef 对齐,实时生成)') as HTMLTextAreaElement
    expect(nameInput.value).toBe('示例 MCP 智能体')
    expect(descInput.value).toBe('示例描述')
    expect(authSelect.textContent).toContain('OAuth')
    expect(defArea.value).toContain('"serverName": "example-crm"')
    fireEvent.change(nameInput, { target: { value: '示例 MCP 智能体 v2' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('/api/server/admin/connectors/example-crm', expect.objectContaining({ method: 'PUT' }))
    })
    const call = mockRequest.mock.calls.find(([p, i]) => p === '/api/server/admin/connectors/example-crm' && (i as RequestInit)?.method === 'PUT')
    const body = JSON.parse((call![1] as RequestInit).body as string)
    // 提交体的字段集合 = 弹窗建模的字段集合(没有表单外的隐藏字段回传)
    expect(Object.keys(body).sort()).toEqual(['auth_mode', 'definition', 'description', 'id', 'name'])
    // 逐字段对拍:未改动的字段与初值逐字节一致,改动的那条是弹窗里的新值
    expect(body.id).toBe('example-crm')
    expect(body.name).toBe('示例 MCP 智能体 v2')
    expect(body.description).toBe(descInput.value)
    expect(body.auth_mode).toBe('oauth')
    expect(JSON.parse(body.definition).mcp[0].serverName).toBe('example-crm')
  })

  it('删除:确认后调用 DELETE', async () => {
    render(<Connectors />)
    await screen.findByText('示例 MCP 智能体')
    const delBtns = screen.getAllByTitle('删除')
    fireEvent.click(delBtns[0]!)
    fireEvent.click(await screen.findByRole('button', { name: '删除' }))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('/api/server/admin/connectors/example-crm', { method: 'DELETE' })
    })
  })

  // 审计 2026-09-12 P1-2(回归):非安全源(纯 HTTP + LAN IP,文档化部署形态)
  // 没有 crypto.randomUUID,而 `emptyForm()` 在 useState 初始化期就调 uid()
  // ⇒ 首渲染抛 TypeError、整页崩成白屏。
  it('非安全源(crypto.randomUUID 缺失)下首渲染不崩,列表与新建弹窗仍可用', async () => {
    vi.stubGlobal('crypto', {})
    try {
      render(<Connectors />)
      expect(await screen.findByText('示例 MCP 智能体')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: '新建连接器' }))
      const dialog = within(await screen.findByRole('dialog'))
      // 空表单里的每一行 keyId 都由 uid() 生成:没有回落这里就渲染不出来
      expect(dialog.getByLabelText('字段 key 1')).toBeInTheDocument()
      expect(dialog.getByLabelText('服务器名 serverName(名称空间,小写)')).toBeInTheDocument()
      fireEvent.click(dialog.getByRole('button', { name: '添加请求头' }))
      expect(dialog.getByLabelText('请求头 key 1-1')).toBeInTheDocument()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

// ---------------------------------------------------------------------------
// 审计 R7 webadmin-branding-2:连接器定义的编辑/导入都是**有损**的。
//
// 服务端把 definition 整列替换(serverstore.UpdateConnector),客户端
// packages/host/connectors 也把 `settings` 当一等公民(决定是否弹预连接表单、
// 参与 env 注入白名单),`icon` 等字段同理 —— 但本页表单只建模
// authMode/auth/tokenFields/examples/mcp,编辑一次就把其余字段静默丢掉
// (保存后无任何提示)。导入框走同一个 parseDefinition,同样有损。
// 修法:表单未建模的顶层键与 auth 子键原样透传,保存/导入都保留。
// ---------------------------------------------------------------------------
describe('未建模字段透传(R7 branding-2)', () => {
  const FULL = {
    authMode: 'token',
    tokenFields: [{ key: 'GLITCHTIP_TOKEN', label: 'Token', type: 'password', required: true }],
    settings: [{ key: 'GLITCHTIP_BASE_URL', label: '服务地址', type: 'text' }],
    icon: 'https://cdn.example.com/glitchtip.png',
    futureKey: { nested: [1, 2, 3] },
    examples: ['查询 issue'],
    auth: { clientId: 'keep-me', customAuthKey: 'also-keep' },
    mcp: [{ serverName: 'glitchtip', transport: 'stdio', command: 'npx', args: ['-y', 'glitchtip-mcp'] }],
  }
  const row = {
    id: 'glitchtip', name: 'GlitchTip', description: '错误追踪', auth_mode: 'token',
    definition: JSON.stringify(FULL), enabled: true,
    updated_at: '2026-08-28T10:00:00+08:00', created_at: '2026-08-28T10:00:00+08:00',
  }
  // 取最后一次写请求里的 definition(服务端整列替换,PUT body 就是最终值)
  function savedDefinition(method: 'POST' | 'PUT'): any {
    const call = [...mockRequest.mock.calls].reverse().find(([p, init]) =>
      init?.method === method && String(p).endsWith('/connectors') || (init?.method === method && String(p).endsWith('/connectors/glitchtip')))
    return JSON.parse(JSON.parse(String(call?.[1]?.body)).definition)
  }

  beforeEach(() => {
    mockRequest.mockReset()
    mockRequest.mockImplementation(async (path: string) => {
      if (path === '/api/server/admin/connectors') return { connectors: [row] }
      return {}
    })
  })

  it('编辑保存:未建模字段(settings/icon/未来键/未建模 auth 子键)原样保留', async () => {
    render(<Connectors />)
    await screen.findByText('GlitchTip')
    fireEvent.click(screen.getAllByTitle('编辑')[0]!)
    const nameInput = await screen.findByLabelText('名称')
    fireEvent.change(nameInput, { target: { value: 'GlitchTip v2' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(mockRequest).toHaveBeenCalledWith('/api/server/admin/connectors/glitchtip', expect.objectContaining({ method: 'PUT' })))
    const def = savedDefinition('PUT')
    expect(def.settings).toEqual(FULL.settings)
    expect(def.icon).toBe(FULL.icon)
    expect(def.futureKey).toEqual(FULL.futureKey)
    expect(def.auth.clientId).toBe('keep-me')
    expect(def.auth.customAuthKey).toBe('also-keep')
    // 建模字段照旧由表单决定
    expect(def.tokenFields[0].key).toBe('GLITCHTIP_TOKEN')
    expect(def.mcp[0].serverName).toBe('glitchtip')
  })

  it('JSON 导入:未建模字段同样保留(导入不是丢数据的旁路)', async () => {
    render(<Connectors />)
    await screen.findByText('GlitchTip')
    fireEvent.click(screen.getByRole('button', { name: '新建连接器' }))
    const dialog = within(await screen.findByRole('dialog'))
    fireEvent.change(dialog.getByLabelText('编号(不可改,客户端按 id 匹配凭证)'), { target: { value: 'glitchtip' } })
    fireEvent.change(dialog.getByLabelText('名称'), { target: { value: 'GlitchTip' } })
    fireEvent.click(dialog.getByRole('button', { name: '从 JSON 导入' }))
    fireEvent.change(dialog.getByLabelText('JSON'), { target: { value: JSON.stringify(FULL) } })
    fireEvent.click(dialog.getByRole('button', { name: '解析导入' }))
    fireEvent.click(dialog.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(mockRequest).toHaveBeenCalledWith('/api/server/admin/connectors', expect.objectContaining({ method: 'POST' })))
    const def = savedDefinition('POST')
    expect(def.settings).toEqual(FULL.settings)
    expect(def.icon).toBe(FULL.icon)
    expect(def.futureKey).toEqual(FULL.futureKey)
    expect(def.auth.customAuthKey).toBe('also-keep')
  })
})
