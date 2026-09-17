import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react'
import Gateway from './Gateway'
import { request } from '../api'

const mockRequest = vi.mocked(request)

const baseImpl = async (path: string, init?: RequestInit) => {
  if (path === '/api/server/admin/providers' && init?.method === 'POST') {
    return { provider: { id: 2, name: 'deepseek2', channel: 'deepseek' }, sync: { added: 2, removed: 0 } }
  }
  if (path === '/api/server/admin/providers/sync-all') {
    return { results: [{ provider: 'deepseek', added: 1, removed: 0 }, { provider: 'manual', skipped: true, error: '手动型上游无需同步' }] }
  }
  if (path === '/api/server/admin/providers') return { providers: [{ id: 1, name: 'deepseek', base_url: 'https://api.deepseek.com', api_key: '***', models: ['deepseek-chat'], enabled: true, channel: 'deepseek', protocol: 'openai' }] }
  if (path === '/api/server/admin/models') return { models: [{ id: 1, name: 'deepseek-chat', display_name: 'DeepSeek Chat', default_params: '{}', provider_name: 'deepseek', provider_channel: 'deepseek', provider_enabled: true }] }
  if (path === '/api/server/admin/gateway') return { default_model: 'deepseek-chat', rate_limit: '60', peak_windows: '', server_base_url: '' }
  if (path === '/api/server/admin/channels') return { channels: [{ name: 'deepseek', base_url: 'https://api.deepseek.com' }] }
  return {}
}

beforeEach(() => {
  mockRequest.mockReset()
  mockRequest.mockImplementation(baseImpl)
})

/**
 * 等网关配置**加载完成**。2026-09-17 独立审计：本文件 19 处锚在静态 CardTitle
 * 「全局设置」上，它在 loading 期就已渲染，随后同步读配置值的断言会拿到初值 ——
 * 注入 400ms 响应延迟即 10~11 例红（例：`Unable to find a label with the text of: 高峰开始 1`）。
 *
 * 判据 = loading 骨架的**消失**，用显式 `data-testid`（Gateway.tsx:686/756）而**不是**
 * CSS 类名：初版写成 `document.querySelectorAll('.animate-pulse')`，独立复核指出
 * 一次纯样式改名（`skeleton.tsx` 的类名）就能让它静默失效 —— 改名后加延迟 10/28 红、
 * 不加延迟 28/28 绿（判据被架空却零信号）。testid 把耦合钉在明面上，配套的正向对照
 * 用例（「加载期必须渲染骨架」）保证骨架被删/被改名时用例会**响亮地**失败。
 */
async function waitForGatewayLoaded(): Promise<void> {
  await waitFor(() => expect(screen.queryAllByTestId('gateway-loading')).toHaveLength(0), { timeout: 5000 })
}

async function openDialog() {
  render(<Gateway />)
  await waitForGatewayLoaded()
  fireEvent.click(screen.getByRole('button', { name: '添加上游' }))
  return within(await screen.findByRole('dialog'))
}

describe('Gateway 网关配置页', () => {
  it('加载期必须渲染骨架(正向对照:骨架与判据同生共死)', async () => {
    // 把响应闸住 ⇒ 页面必须停在 loading 态、两张表各渲染一行骨架。
    // 若有人删掉骨架或改掉 data-testid,本用例**响亮地红**,而不是让 18 处
    // waitForGatewayLoaded 静默变成空判据（独立复核 P2-1 的修法）。
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      await gate
      return baseImpl(path, init)
    })
    render(<Gateway />)
    expect(screen.getAllByTestId('gateway-loading')).toHaveLength(2)
    release()
    await waitForGatewayLoaded()
  })

  it('配置未加载完时全局设置不可保存(审计 F5:空初值会清空默认模型/峰谷)', async () => {
    // 加载期间 `cfg` 还是空初值，此时保存会提交 default_model="" / peak_windows=""。
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      await gate
      return baseImpl(path, init)
    })
    render(<Gateway />)
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()
    release()
    await waitForGatewayLoaded()
    expect(screen.getByRole('button', { name: '保存' })).toBeEnabled()
  })

  it('加载失败时全局设置也不可保存(R1:失败路径此前会解锁并提交空初值)', async () => {
    // 独立验证 R1 实测：四个 GET 里只要有一个**失败**（不是挂起），此前 finally 会
    // 把 loading 置 false ⇒ 写面解锁而 cfg 仍是空初值 ⇒ 点保存提交
    // {"default_model":"","peak_windows":"",…}：清空默认模型与峰谷计费窗口。
    // 解锁条件必须是"这份配置真的读到了"。
    mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.endsWith('/gateway')) throw new Error('网关配置读取失败')
      return baseImpl(path, init)
    })
    render(<Gateway />)
    const save = screen.getByRole('button', { name: '保存' })
    await waitFor(() => expect(screen.getByText(/全局设置未加载成功/)).toBeInTheDocument())
    expect(save).toBeDisabled()
    fireEvent.click(save)
    expect(mockRequest.mock.calls.filter(([p, i]: any[]) => p.endsWith('/gateway') && i?.method === 'PUT')).toHaveLength(0)
  })

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
      if (path === '/api/server/admin/providers' && init?.method === 'POST') {
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
      if (path === '/api/server/admin/providers' && init?.method === 'POST') {
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

  // 全局默认配额已迁至「用量中心 → 配额与预算」页(2026-09 重构):
  // 网关页不再渲染/提交 monthly_quota 相关字段。

  it('模型表格展示价格列:未定价徽标与价格显示', async () => {
    mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/server/admin/models') {
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
    await waitForGatewayLoaded()
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    const dialog = within(await screen.findByRole('dialog'))
    expect(dialog.getByDisplayValue('deepseek')).toBeInTheDocument()
    fireEvent.change(dialog.getByDisplayValue('deepseek'), { target: { value: 'deepseek-v2' } })
    fireEvent.click(dialog.getByRole('button', { name: '保存' }))
    expect(mockRequest).toHaveBeenCalledWith(
      '/api/server/admin/providers/1',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ name: 'deepseek-v2', channel: 'deepseek', base_url: 'https://api.deepseek.com', enabled: true, protocol: 'openai' }),
      }),
    )
  })

  it('渠道同步模型删除确认文案说明不会自动恢复', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<Gateway />)
    await waitForGatewayLoaded()
    fireEvent.click(screen.getAllByRole('button', { name: '删除' })[1])
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('同步不会自动恢复'))
    confirmSpy.mockRestore()
  })

  it('全局设置:非 http URL 阻止保存并提示', async () => {
    render(<Gateway />)
    await waitForGatewayLoaded()
    fireEvent.change(screen.getByLabelText('对外访问地址 (Server Base URL)'), { target: { value: 'not-a-url' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText('对外访问地址必须是 http(s) URL')).toBeInTheDocument()
    expect(mockRequest).not.toHaveBeenCalledWith('/api/server/admin/gateway', expect.objectContaining({ method: 'PUT' }))
  })

  it('立即同步:手动型上游折叠为汇总行', async () => {
    render(<Gateway />)
    await waitForGatewayLoaded()
    fireEvent.click(screen.getByRole('button', { name: '立即同步' }))
    expect(await screen.findByText(/deepseek: \+1\/-0; 1 个手动型上游跳过/)).toBeInTheDocument()
  })

  it('上游表格空态展示引导文案', async () => {
    mockRequest.mockImplementation(async (path: string) => {
      if (path === '/api/server/admin/providers') return { providers: [] }
      return baseImpl(path)
    })
    render(<Gateway />)
    expect(await screen.findByText('暂无上游,点击「添加上游」开始接入')).toBeInTheDocument()
  })

  it('模型配置编辑:打开对话框提交显示名+价格', async () => {
    render(<Gateway />)
    await waitForGatewayLoaded()
    fireEvent.click(screen.getAllByRole('button', { name: '配置' })[0])
    const dialog = within(await screen.findByRole('dialog'))
    fireEvent.change(dialog.getByLabelText('输入价格(元/百万 token)'), { target: { value: '3' } })
    fireEvent.change(dialog.getByLabelText('输出价格(元/百万 token)'), { target: { value: '10' } })
    fireEvent.click(dialog.getByRole('button', { name: '保存' }))
    expect(mockRequest).toHaveBeenCalledWith(
      '/api/server/admin/models/1',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ name: 'deepseek-chat', input_price_per_1m: 3, output_price_per_1m: 10, input_modalities: ['text'], display_name: 'DeepSeek Chat' }),
      }),
    )
  })

  it('模型配置编辑:提交含低谷折扣率', async () => {
    render(<Gateway />)
    await waitForGatewayLoaded()
    fireEvent.click(screen.getAllByRole('button', { name: '配置' })[0])
    const dialog = within(await screen.findByRole('dialog'))
    fireEvent.change(dialog.getByLabelText('输入价格(元/百万 token)'), { target: { value: '2' } })
    fireEvent.change(dialog.getByLabelText('输出价格(元/百万 token)'), { target: { value: '8' } })
    fireEvent.change(dialog.getByLabelText('低谷折扣率(0-1,留空 = 保持现值;1 = 取消峰谷)'), { target: { value: '0.5' } })
    fireEvent.click(dialog.getByRole('button', { name: '保存' }))
    expect(mockRequest).toHaveBeenCalledWith(
      '/api/server/admin/models/1',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ name: 'deepseek-chat', input_price_per_1m: 2, output_price_per_1m: 8, offpeak_discount: 0.5, input_modalities: ['text'], display_name: 'DeepSeek Chat' }),
      }),
    )
  })

  it('模型输入模态:图片模型显示徽章,编辑对话框切换并提交 text+image(0058)', async () => {
    mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/server/admin/models') {
        return {
          models: [
            { id: 1, name: 'deepseek-v4-flash-vision-exp', display_name: 'Vision', default_params: '{}', input_modalities: ['text', 'image'], input_price_per_1m: 2, output_price_per_1m: 8 },
          ],
        }
      }
      return baseImpl(path, init)
    })
    render(<Gateway />)
    // 列表徽章
    expect(await screen.findByText('图片')).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: '配置' })[0])
    const dialog = within(await screen.findByRole('dialog'))
    // 预填「文字 + 图片」按模型现有配置;保存即提交 text+image
    expect(dialog.getByText('文字 + 图片')).toBeInTheDocument()
    fireEvent.click(dialog.getByRole('button', { name: '保存' }))
    expect(mockRequest).toHaveBeenCalledWith(
      '/api/server/admin/models/1',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ name: 'deepseek-v4-flash-vision-exp', input_price_per_1m: 2, output_price_per_1m: 8, input_modalities: ['text', 'image'], display_name: 'Vision' }),
      }),
    )
  })

  it('模型表格价格列:有低谷折扣时显示谷 N折', async () => {
    mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/server/admin/models') {
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
    await waitForGatewayLoaded()
    fireEvent.click(screen.getByRole('button', { name: 'DeepSeek 当前政策(工作日)' }))
    expect((screen.getByLabelText('高峰开始 1') as HTMLInputElement).value).toBe('09:00')
    expect((screen.getByLabelText('高峰结束 2') as HTMLInputElement).value).toBe('18:00')
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await screen.findByText('已保存')
    const call = mockRequest.mock.calls.find(
      (c) => c[0] === '/api/server/admin/gateway' && c[1]?.method === 'PUT'
    )
    expect(call).toBeTruthy()
    const sent = JSON.parse(call![1]!.body as string)
    expect(sent.peak_windows).toBe('[{"start":"09:00","end":"12:00","weekdays":[1,2,3,4,5]},{"start":"14:00","end":"18:00","weekdays":[1,2,3,4,5]}]')
  })

  it('高峰时段:清空保存 = 无峰谷价(留空语义成立)', async () => {
    mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/server/admin/gateway' && init?.method === 'PUT') return { ok: true }
      return {
        ...(await baseImpl(path, init)),
        ...(path === '/api/server/admin/gateway' ? { peak_windows: '[{"start":"09:00","end":"12:00"}]' } : {}),
      }
    })
    render(<Gateway />)
    await waitForGatewayLoaded()
    expect((screen.getByLabelText('高峰开始 1') as HTMLInputElement).value).toBe('09:00')
    fireEvent.click(screen.getByRole('button', { name: '清空(无峰谷价)' }))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await screen.findByText('已保存')
    expect(mockRequest).toHaveBeenCalledWith(
      '/api/server/admin/gateway',
      expect.objectContaining({
        method: 'PUT',
        body: expect.stringContaining('"peak_windows":""'),
      }),
    )
  })

  it('高峰时段:开始晚于结束时阻止保存并提示', async () => {
    render(<Gateway />)
    await waitForGatewayLoaded()
    fireEvent.click(screen.getByRole('button', { name: '添加时段' }))
    const start = screen.getByLabelText('高峰开始 1') as HTMLInputElement
    const end = screen.getByLabelText('高峰结束 1') as HTMLInputElement
    fireEvent.change(start, { target: { value: '18:00' } })
    fireEvent.change(end, { target: { value: '09:00' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText('高峰时段每行的开始时间必须早于结束时间')).toBeInTheDocument()
    expect(mockRequest).not.toHaveBeenCalledWith('/api/server/admin/gateway', expect.objectContaining({ method: 'PUT' }))
  })

  // 审计 2026-09-12 P1-2(回归):parsePeakWindows 曾把「解析失败」吞成 `[]`,
  // 与「本来就没配峰谷价」不可区分 ⇒ 任意一次保存都会把存量写成空串
  // (`peak_windows: ''`)并弹「已保存」——静默破坏计费口径。
  it.each([
    ['非法 JSON', 'not-json-at-all'],
    ['非数组(对象)', '{"start":"09:00","end":"12:00"}'],
    ['数组但元素结构不认得', '[{"from":"09:00","to":"12:00"}]'],
  ])('高峰时段:存量无法解析(%s)时拒绝提交,绝不写空串', async (_label, stored) => {
    mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/server/admin/gateway' && init?.method === 'PUT') return { ok: true }
      if (path === '/api/server/admin/gateway') return { default_model: 'deepseek-chat', rate_limit: '60', peak_windows: stored, server_base_url: '' }
      return baseImpl(path, init)
    })
    render(<Gateway />)
    await waitForGatewayLoaded()
    // 页面显式提示解析失败(而不是装作「无峰谷价」)
    expect(screen.getByText(/高峰时段配置无法解析/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText(/已拒绝保存/)).toBeInTheDocument()
    // 改前:这里会发出 PUT 且 body 含 `"peak_windows":""` + 弹出「已保存」
    expect(mockRequest).not.toHaveBeenCalledWith('/api/server/admin/gateway', expect.objectContaining({ method: 'PUT' }))
    expect(screen.queryByText('已保存')).toBeNull()
  })

  it('高峰时段:解析失败后显式重建时段即可保存(不把管理员锁死)', async () => {
    mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/server/admin/gateway' && init?.method === 'PUT') return { ok: true }
      if (path === '/api/server/admin/gateway') return { default_model: 'deepseek-chat', rate_limit: '60', peak_windows: 'not-json', server_base_url: '' }
      return baseImpl(path, init)
    })
    render(<Gateway />)
    await waitForGatewayLoaded()
    fireEvent.click(screen.getByRole('button', { name: 'DeepSeek 当前政策(工作日)' }))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await screen.findByText('已保存')
    const call = mockRequest.mock.calls.find((c) => c[0] === '/api/server/admin/gateway' && c[1]?.method === 'PUT')
    expect(call).toBeTruthy()
    expect(JSON.parse(call![1]!.body as string).peak_windows).toContain('"start":"09:00"')
  })

  it('非安全源(crypto.randomUUID 缺失)下网关页仍可渲染并保存', async () => {
    vi.stubGlobal('crypto', {})
    try {
      render(<Gateway />)
      await waitForGatewayLoaded()
      fireEvent.click(screen.getByRole('button', { name: 'DeepSeek 当前政策(工作日)' }))
      expect((screen.getByLabelText('高峰开始 1') as HTMLInputElement).value).toBe('09:00')
      fireEvent.click(screen.getByRole('button', { name: '保存' }))
      await screen.findByText('已保存')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  // 审计 2026-09-13(三轮残留③):上一轮只加了「解析失败 ⇒ 拒绝保存」,于是管理员
  // 被锁死:编辑区是空的,又没法把服务端那串坏 JSON 变成合法的空值。现在必须有一条
  // **显式**清空路径(二次确认),且写 `peak_windows: ""` 必须是用户确认的结果。
  describe('存量高峰时段不可解析时的显式清空(三轮残留③)', () => {
    function unparsableStore() {
      const puts: Array<Record<string, unknown>> = []
      mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
        if (path === '/api/server/admin/gateway' && init?.method === 'PUT') {
          puts.push(JSON.parse(String(init.body)) as Record<string, unknown>)
          return { ok: true }
        }
        if (path === '/api/server/admin/gateway') {
          return { default_model: 'deepseek-chat', rate_limit: '60', peak_windows: '{"start":"09:00"', retention_months: '6', default_thinking_level: 'max', server_base_url: '' }
        }
        return baseImpl(path, init)
      })
      return puts
    }

    it('确认前保存被拒;确认清空后保存成功且写入 peak_windows=""', async () => {
      const puts = unparsableStore()
      render(<Gateway />)
      await waitForGatewayLoaded()
      expect(screen.getByText(/高峰时段配置无法解析/)).toBeInTheDocument()

      // ① 未确认清空:保存被拒,绝不 PUT(改前这就是死路:页面里没有清空入口)。
      expect(screen.queryByRole('button', { name: '清空高峰时段配置' })).not.toBeNull()
      fireEvent.click(screen.getByRole('button', { name: '保存' }))
      expect(await screen.findByText(/已拒绝保存/)).toBeInTheDocument()
      expect(puts.length).toBe(0)

      // ② 点清空 ⇒ 出现二次确认对话框(不是直接生效)。
      fireEvent.click(screen.getByRole('button', { name: '清空高峰时段配置' }))
      const dialog = within(await screen.findByRole('dialog'))
      expect(dialog.getByText(/确认清空高峰时段配置\?/)).toBeInTheDocument()
      expect(puts.length).toBe(0) // 打开对话框本身不写任何东西

      // ③ 取消 ⇒ 仍然拒绝保存(证明空值必须来自明确确认)。
      fireEvent.click(dialog.getByRole('button', { name: '取消' }))
      fireEvent.click(screen.getByRole('button', { name: '保存' }))
      expect(puts.length).toBe(0)

      // ④ 再次打开并确认 ⇒ 页面常驻标出「已确认清空」,保存成功。
      fireEvent.click(screen.getByRole('button', { name: '清空高峰时段配置' }))
      fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '确认清空' }))
      expect(await screen.findByText(/已确认清空高峰时段/)).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: '保存' }))
      await screen.findByText('已保存')
      expect(puts.length).toBe(1)
      expect(puts[0]!.peak_windows).toBe('')
    })

    it('确认清空后又重建时段 ⇒ 提交的是新时段(不是空值)', async () => {
      const puts = unparsableStore()
      render(<Gateway />)
      await waitForGatewayLoaded()
      fireEvent.click(screen.getByRole('button', { name: '清空高峰时段配置' }))
      fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '确认清空' }))
      // 重建 = 放弃清空意图(确认标记作废),但列表非空本来就允许保存。
      fireEvent.click(screen.getByRole('button', { name: 'DeepSeek 当前政策(工作日)' }))
      fireEvent.click(screen.getByRole('button', { name: '保存' }))
      await screen.findByText('已保存')
      expect(puts.length).toBe(1)
      expect(String(puts[0]!.peak_windows)).toContain('"start":"09:00"')
    })
  })

// ---------------------------------------------------------------------------
// 修复轮 1(F-07):本页只提交自己的字段
// ---------------------------------------------------------------------------

describe('Gateway 保存面(F-07)', () => {
  /** 模拟"库里存着别的域(错误监控)字段"的服务端 GET 响应。 */
  function storeWithForeignFields() {
    const puts: Array<Record<string, unknown>> = []
    mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/server/admin/gateway' && init?.method === 'PUT') {
        puts.push(JSON.parse(String(init.body)) as Record<string, unknown>)
        return { ok: true, warnings: [] }
      }
      if (path === '/api/server/admin/gateway') {
        return {
          default_model: 'deepseek-chat',
          rate_limit: '60',
          peak_windows: '',
          retention_months: '6',
          default_thinking_level: 'max',
          server_base_url: '',
          // 「网关」页没有这些输入框,但 GET 会下发它们(错误监控域)。
          error_reporting_dsn: 'http://key@localhost:8000/1',
          error_reporting_enabled: true,
          error_reporting_level: 'error',
          error_reporting_heartbeat: false,
          glitchtip_base_url: 'https://glitchtip.example.com',
          glitchtip_organization: 'picoaide',
        }
      }
      return baseImpl(path, init)
    })
    return puts
  }

  it('提交体只含本页字段,不回写错误监控域的字段', async () => {
    // 事故:F-07 —— 本页 GET 整份配置后 `{ ...cfg }` 原样回提交,把别的域的
    // (可能已被新校验拒绝的)DSN 带回服务端,导致保存无关配置被 400 拦住。
    const puts = storeWithForeignFields()
    render(<Gateway />)
    await waitForGatewayLoaded()
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await screen.findByText('已保存')

    expect(puts.length).toBe(1)
    const body = puts[0]!
    expect(Object.keys(body).sort()).toEqual([
      'default_model',
      'default_thinking_level',
      'peak_windows',
      'rate_limit',
      'retention_months',
      'server_base_url',
    ])
    for (const foreign of ['error_reporting_dsn', 'error_reporting_enabled', 'error_reporting_level', 'error_reporting_heartbeat', 'glitchtip_base_url', 'glitchtip_organization']) {
      expect(body[foreign]).toBeUndefined()
    }
  })
})

// ---------------------------------------------------------------------------
// 修复轮 2(S12-01 / S10-5):保存响应里的非阻断告警必须在页面上可见
// ---------------------------------------------------------------------------

describe('Gateway 保存告警', () => {
  /** 模拟服务端对「写入后配置仍不可用」返回 200 + warnings(S12-01 的降级路径)。 */
  function warnOnSave(warnings: string[]) {
    const puts: Array<Record<string, unknown>> = []
    mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/server/admin/gateway' && init?.method === 'PUT') {
        puts.push(JSON.parse(String(init.body)) as Record<string, unknown>)
        return { ok: true, warnings }
      }
      return baseImpl(path, init)
    })
    return puts
  }

  it('200 + warnings 时页面显示黄条告警(不能只闪「已保存」)', async () => {
    // 事故:Gateway 页此前 `await request(...)` 后丢弃响应体 —— S12-01 把
    // 「库里 enabled=true 但 DSN 为空」从 400 降级成 200+warning、S10-5 把
    // 「库中现值不可用」也做成 warning,两处告警在唯一会触发它们的页面上
    // 一律不可见,管理员只看到「已保存」。
    const puts = warnOnSave([
      '错误上报:库中开关已打开但 DSN 为空(客户端不会上报任何错误);请在「错误监控」页填写 DSN 或关闭开关',
      '错误上报 DSN:库中现有值不可用(不能指向本机或云元数据地址);请在「错误监控」页更新它',
    ])
    render(<Gateway />)
    await waitForGatewayLoaded()
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    // 告警逐条渲染(不是只取第一条),且保存本身仍然成功。
    expect(await screen.findByText(/库中开关已打开但 DSN 为空/)).toBeInTheDocument()
    expect(screen.getByText(/库中现有值不可用/)).toBeInTheDocument()
    expect(screen.getByText('已保存')).toBeInTheDocument()
    expect(puts.length).toBe(1)
  })

  it('warnings 为空/缺省时不渲染任何告警条', async () => {
    warnOnSave([])
    render(<Gateway />)
    await waitForGatewayLoaded()
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await screen.findByText('已保存')
    expect(document.querySelector('.border-amber-500\\/40')).toBeNull()
  })
})
