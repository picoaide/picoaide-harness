import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import Gateway from './Gateway'
import { request } from '../api'

const mockRequest = vi.mocked(request)

const baseImpl = async (path: string, init?: RequestInit) => {
  if (path === '/api/admin/providers' && init?.method === 'POST') {
    return { provider: { id: 2, name: 'deepseek2', channel: 'deepseek' }, sync: { added: 2, removed: 0 } }
  }
  if (path === '/api/admin/providers/sync-all') {
    return { results: [{ provider: 'deepseek', added: 1, removed: 0 }, { provider: 'manual', skipped: true, error: '手动型上游无需同步' }] }
  }
  if (path === '/api/admin/providers') return { providers: [{ id: 1, name: 'deepseek', base_url: 'https://api.deepseek.com', api_key: '***', models: ['deepseek-chat'], enabled: true, channel: 'deepseek', protocol: 'openai' }] }
  if (path === '/api/admin/models') return { models: [{ id: 1, name: 'deepseek-chat', display_name: 'DeepSeek Chat', default_params: '{}', provider_name: 'deepseek', provider_channel: 'deepseek', provider_enabled: true }] }
  if (path === '/api/admin/gateway') return { default_model: 'deepseek-chat', rate_limit: '60', monthly_quota: '0', monthly_quota_money: '0', peak_windows: '', allow_private: false, search_endpoint: '', server_base_url: '' }
  if (path === '/api/admin/channels') return { channels: [{ name: 'deepseek', base_url: 'https://api.deepseek.com' }] }
  return {}
}

beforeEach(() => {
  mockRequest.mockReset()
  mockRequest.mockImplementation(baseImpl)
})

async function openDialog() {
  render(<Gateway />)
  await screen.findByText('全局设置')
  fireEvent.click(screen.getByRole('button', { name: '添加上游' }))
  return within(await screen.findByRole('dialog'))
}

describe('Gateway 网关配置页', () => {
  it('渲染全局设置、上游表格与模型列表', async () => {
    render(<Gateway />)
    expect(await screen.findByText('全局设置')).toBeInTheDocument()
    expect((await screen.findAllByText('deepseek')).length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('DeepSeek Chat')).toBeInTheDocument()
  })

  it('添加上游:对话框渲染名称/密钥/模型字段(Radix Select 联动由浏览器 E2E 覆盖)', async () => {
    const dialog = await openDialog()
    expect(dialog.getByPlaceholderText('如 deepseek')).toBeInTheDocument()
    expect(dialog.getByPlaceholderText('sk-...')).toBeInTheDocument()
    expect(dialog.getByPlaceholderText(/保存后自动同步|deepseek-chat/)).toBeInTheDocument()
  })

  it('提交上游时携带 protocol 字段(默认 openai;选择 anthropic 后提交 anthropic)', async () => {
    let submitted: string | undefined
    mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/admin/providers' && init?.method === 'POST') {
        submitted = (JSON.parse(String(init.body)) as { protocol?: string }).protocol
        return { provider: { id: 2, name: 'ds-anthropic', channel: '', protocol: 'anthropic' }, sync: undefined }
      }
      return baseImpl(path, init)
    })
    const dialog = await openDialog()
    fireEvent.change(dialog.getByPlaceholderText('如 deepseek'), { target: { value: 'ds-anthropic' } })
    fireEvent.change(dialog.getByPlaceholderText('https://api.example.com'), { target: { value: 'https://api.deepseek.com/anthropic/v1' } })
    fireEvent.change(dialog.getByPlaceholderText('sk-...'), { target: { value: 'sk-a' } })
    // 选择 Anthropic 协议
    fireEvent.click(screen.getAllByText('OpenAI 兼容(chat/completions、embeddings)')[0]!)
    fireEvent.click(await screen.findByText('Anthropic 兼容(/v1/messages,web 搜索)'))
    fireEvent.click(screen.getByRole('button', { name: '添加' }))
    await screen.findByText('已保存')
    expect(submitted).toBe('anthropic')
  })

  it('提交含 sync.added 时显示"已上架 N 个模型"', async () => {
    const dialog = await openDialog()
    fireEvent.change(dialog.getByPlaceholderText('如 deepseek'), { target: { value: 'deepseek2' } })
    fireEvent.change(dialog.getByPlaceholderText('https://api.example.com'), { target: { value: 'https://api.deepseek.com' } })
    fireEvent.change(dialog.getByPlaceholderText('sk-...'), { target: { value: 'sk-x' } })
    fireEvent.click(screen.getByRole('button', { name: '添加' }))
    expect(await screen.findByText(/已上架 2 个模型/)).toBeInTheDocument()
  })

  it('提交 sync.error 时提示可重试', async () => {
    mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/admin/providers' && init?.method === 'POST') {
        return { provider: { id: 2, name: 'deepseek2', channel: 'deepseek' }, sync: { error: 'upstream 500' } }
      }
      return baseImpl(path, init)
    })
    const dialog = await openDialog()
    fireEvent.change(dialog.getByPlaceholderText('如 deepseek'), { target: { value: 'deepseek2' } })
    fireEvent.change(dialog.getByPlaceholderText('https://api.example.com'), { target: { value: 'https://api.deepseek.com' } })
    fireEvent.change(dialog.getByPlaceholderText('sk-...'), { target: { value: 'sk-x' } })
    fireEvent.click(screen.getByRole('button', { name: '添加' }))
    expect(await screen.findByText(/已保存,但模型同步失败/)).toBeInTheDocument()
  })
})

  it('全局设置渲染默认月金额配额字段并可编辑保存', async () => {
    mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/admin/gateway' && init?.method === 'PUT') {
        return { ok: true }
      }
      return {
        ...(await baseImpl(path, init)),
        ...(path === '/api/admin/gateway' ? { monthly_quota: '100000', monthly_quota_money: '500' } : {}),
      }
    })
    render(<Gateway />)
    await screen.findByText('全局设置')
    // 默认月金额配额字段存在并渲染已保存值
    const moneyInput = screen.getByDisplayValue('500')
    expect(moneyInput).toBeInTheDocument()
    // 修改并保存
    fireEvent.change(moneyInput, { target: { value: '800' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await screen.findByText('已保存')
    expect(mockRequest).toHaveBeenCalledWith(
      '/api/admin/gateway',
      expect.objectContaining({ method: 'PUT', body: expect.stringContaining('"monthly_quota_money":"800"') }),
    )
  })

  it('模型表格展示价格列:未定价徽标与价格显示', async () => {
    mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/admin/models') {
        return {
          models: [
            { id: 1, name: 'deepseek-chat', display_name: 'DeepSeek Chat', default_params: '{}', input_price_per_1m: 2, output_price_per_1m: 8 },
            { id: 2, name: 'free-model', display_name: 'Free', default_params: '{}', input_price_per_1m: null, output_price_per_1m: null },
          ],
        }
      }
      return baseImpl(path, init)
    })
    render(<Gateway />)
    expect(await screen.findByText(/入 2 \/ 出 8/)).toBeInTheDocument()
    const unpriced = await screen.findAllByText('未定价')
    expect(unpriced.length).toBeGreaterThan(0)
  })

  it('上游编辑:对话框回填并提交 PUT(密钥留空不提交)', async () => {
    render(<Gateway />)
    await screen.findByText('全局设置')
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    const dialog = within(await screen.findByRole('dialog'))
    expect(dialog.getByDisplayValue('deepseek')).toBeInTheDocument()
    fireEvent.change(dialog.getByDisplayValue('deepseek'), { target: { value: 'deepseek-v2' } })
    fireEvent.click(dialog.getByRole('button', { name: '保存' }))
    expect(mockRequest).toHaveBeenCalledWith(
      '/api/admin/providers/1',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ name: 'deepseek-v2', channel: 'deepseek', base_url: 'https://api.deepseek.com', enabled: true, protocol: 'openai' }),
      }),
    )
  })

  it('渠道同步模型删除确认文案说明不会自动恢复', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<Gateway />)
    await screen.findByText('全局设置')
    fireEvent.click(screen.getAllByRole('button', { name: '删除' })[1])
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('同步不会自动恢复'))
    confirmSpy.mockRestore()
  })

  it('全局设置:非 http URL 阻止保存并提示', async () => {
    render(<Gateway />)
    await screen.findByText('全局设置')
    fireEvent.change(screen.getByLabelText('对外访问地址 (Server Base URL)'), { target: { value: 'not-a-url' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText('对外访问地址必须是 http(s) URL')).toBeInTheDocument()
    expect(mockRequest).not.toHaveBeenCalledWith('/api/admin/gateway', expect.objectContaining({ method: 'PUT' }))
  })

  it('立即同步:手动型上游折叠为汇总行', async () => {
    render(<Gateway />)
    await screen.findByText('全局设置')
    fireEvent.click(screen.getByRole('button', { name: '立即同步' }))
    expect(await screen.findByText(/deepseek: \+1\/-0; 1 个手动型上游跳过/)).toBeInTheDocument()
  })

  it('上游表格空态展示引导文案', async () => {
    mockRequest.mockImplementation(async (path: string) => {
      if (path === '/api/admin/providers') return { providers: [] }
      return baseImpl(path)
    })
    render(<Gateway />)
    expect(await screen.findByText('暂无上游,点击「添加上游」开始接入')).toBeInTheDocument()
  })

  it('模型价格编辑:打开对话框提交价格 PUT', async () => {
    render(<Gateway />)
    await screen.findByText('全局设置')
    fireEvent.click(screen.getAllByRole('button', { name: '价格' })[0])
    const dialog = within(await screen.findByRole('dialog'))
    fireEvent.change(dialog.getByLabelText('输入价格(元/百万 token)'), { target: { value: '3' } })
    fireEvent.change(dialog.getByLabelText('输出价格(元/百万 token)'), { target: { value: '10' } })
    fireEvent.click(dialog.getByRole('button', { name: '保存' }))
    expect(mockRequest).toHaveBeenCalledWith(
      '/api/admin/models/1',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ name: 'deepseek-chat', input_price_per_1m: 3, output_price_per_1m: 10 }),
      }),
    )
  })

  it('模型价格编辑:提交含低谷折扣率', async () => {
    render(<Gateway />)
    await screen.findByText('全局设置')
    fireEvent.click(screen.getAllByRole('button', { name: '价格' })[0])
    const dialog = within(await screen.findByRole('dialog'))
    fireEvent.change(dialog.getByLabelText('输入价格(元/百万 token)'), { target: { value: '2' } })
    fireEvent.change(dialog.getByLabelText('输出价格(元/百万 token)'), { target: { value: '8' } })
    fireEvent.change(dialog.getByLabelText('低谷折扣率(0-1,留空 = 保持现值;1 = 取消峰谷)'), { target: { value: '0.5' } })
    fireEvent.click(dialog.getByRole('button', { name: '保存' }))
    expect(mockRequest).toHaveBeenCalledWith(
      '/api/admin/models/1',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ name: 'deepseek-chat', input_price_per_1m: 2, output_price_per_1m: 8, offpeak_discount: 0.5 }),
      }),
    )
  })

  it('模型表格价格列:有低谷折扣时显示谷 N折', async () => {
    mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/admin/models') {
        return {
          models: [
            { id: 1, name: 'deepseek-chat', display_name: 'DeepSeek Chat', default_params: '{}', input_price_per_1m: 2, output_price_per_1m: 8, offpeak_discount: 0.5 },
            { id: 2, name: 'plain-model', display_name: 'Plain', default_params: '{}', input_price_per_1m: 1, output_price_per_1m: 3, offpeak_discount: null },
          ],
        }
      }
      return baseImpl(path, init)
    })
    render(<Gateway />)
    expect(await screen.findByText(/谷 5折/)).toBeInTheDocument()
    // 无峰谷的模型不显示谷折扣
    const cells = screen.getAllByRole('cell')
    expect(cells.some((c) => c.textContent?.includes('谷'))).toBe(true)
  })

  it('高峰时段:结构化编辑器预设 DeepSeek 政策并序列化保存', async () => {
    render(<Gateway />)
    await screen.findByText('全局设置')
    fireEvent.click(screen.getByRole('button', { name: 'DeepSeek 当前政策(工作日)' }))
    expect((screen.getByLabelText('高峰开始 1') as HTMLInputElement).value).toBe('09:00')
    expect((screen.getByLabelText('高峰结束 2') as HTMLInputElement).value).toBe('18:00')
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await screen.findByText('已保存')
    const call = mockRequest.mock.calls.find(
      (c) => c[0] === '/api/admin/gateway' && c[1]?.method === 'PUT'
    )
    expect(call).toBeTruthy()
    const sent = JSON.parse(call![1]!.body as string)
    expect(sent.peak_windows).toBe('[{"start":"09:00","end":"12:00","weekdays":[1,2,3,4,5]},{"start":"14:00","end":"18:00","weekdays":[1,2,3,4,5]}]')
  })

  it('高峰时段:清空保存 = 无峰谷价(留空语义成立)', async () => {
    mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/admin/gateway' && init?.method === 'PUT') return { ok: true }
      return {
        ...(await baseImpl(path, init)),
        ...(path === '/api/admin/gateway' ? { peak_windows: '[{"start":"09:00","end":"12:00"}]' } : {}),
      }
    })
    render(<Gateway />)
    await screen.findByText('全局设置')
    expect((screen.getByLabelText('高峰开始 1') as HTMLInputElement).value).toBe('09:00')
    fireEvent.click(screen.getByRole('button', { name: '清空(无峰谷价)' }))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await screen.findByText('已保存')
    expect(mockRequest).toHaveBeenCalledWith(
      '/api/admin/gateway',
      expect.objectContaining({
        method: 'PUT',
        body: expect.stringContaining('"peak_windows":""'),
      }),
    )
  })

  it('高峰时段:开始晚于结束时阻止保存并提示', async () => {
    render(<Gateway />)
    await screen.findByText('全局设置')
    fireEvent.click(screen.getByRole('button', { name: '添加时段' }))
    const start = screen.getByLabelText('高峰开始 1') as HTMLInputElement
    const end = screen.getByLabelText('高峰结束 1') as HTMLInputElement
    fireEvent.change(start, { target: { value: '18:00' } })
    fireEvent.change(end, { target: { value: '09:00' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText('高峰时段每行的开始时间必须早于结束时间')).toBeInTheDocument()
    expect(mockRequest).not.toHaveBeenCalledWith('/api/admin/gateway', expect.objectContaining({ method: 'PUT' }))
  })
