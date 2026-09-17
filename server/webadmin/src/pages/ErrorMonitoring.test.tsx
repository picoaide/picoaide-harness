import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import ErrorMonitoring from './ErrorMonitoring'
import { request } from '../api'
import { DSN_BLOCKED_MESSAGE, DSN_MALFORMED_MESSAGE } from '../lib/dsn'

const mockRequest = vi.mocked(request)

/**
 * 夹具刻意**不含**任何真实上报地址(DECIDED 红线 5 + DoD「全仓无生产上报地址
 * 字面量」):既有版本在这里硬编码了生产 GlitchTip 域名+公钥,是 2026-08-27
 * 做过历史清理的同类复发。`glitchtip.example.com` 是 IANA 保留示例域,形态与
 * 生产一致(https + 公钥 + 项目 ID),足以覆盖"接受生产形态的公网 DSN"这条验收。
 */
const GATEWAY = {
  default_model: 'deepseek-v4-flash',
  error_reporting_enabled: true,
  error_reporting_dsn: 'https://0123456789abcdef0123456789abcdef@glitchtip.example.com/1',
  error_reporting_level: 'warning',
  error_reporting_heartbeat: false,
  glitchtip_base_url: 'https://glitchtip.example.com',
  glitchtip_organization: 'picoaide',
  default_thinking_level: 'max',
}

const CLIENTS = {
  ready: 3,
  disabled: 1,
  failed: 1,
  config_unavailable: 0,
  idle: 0,
  total: 5,
  last_report_at: '2026-09-16T12:00:00Z',
  items: [
    { username: 'u1', state: 'ready', reason: '', dsn_host: 'glitchtip.example.com', level: 'warning', release: 'picoaide-desktop@2.7.5', updated_at: '2026-09-16T12:00:00Z' },
    { username: 'u2', state: 'failed', reason: 'Sentry init 失败:invalid dsn', dsn_host: '', level: 'error', release: 'picoaide-desktop@2.7.5', updated_at: '2026-09-16T11:30:00Z' },
  ],
}

/** 按端点分派 mock,避免"所有请求都返回同一个对象"掩盖路径错误。 */
function mockApi(overrides: { gateway?: unknown; clients?: unknown } = {}) {
  mockRequest.mockImplementation(async (path: string) => {
    if (path.endsWith('/gateway/error-reporting/clients')) return (overrides.clients ?? CLIENTS) as any
    if (path.endsWith('/gateway/error-reporting/test')) return { ok: true, event_id: 'abcdef0123456789abcdef0123456789', http_status: 200, elapsed_ms: 42, note: '本结果由服务端发起' } as any
    if (path.endsWith('/gateway')) return (overrides.gateway ?? GATEWAY) as any
    throw new Error(`unexpected path: ${path}`)
  })
}

const DSN_LABEL = '错误上报 DSN(客户端 Sentry 上报地址,如 GlitchTip)'

beforeEach(() => {
  mockRequest.mockReset()
  mockApi()
})

describe('ErrorMonitoring 错误监控页', () => {
  it('回填错误监控域配置(不含网关其他字段)', async () => {
    render(<ErrorMonitoring />)
    expect(await screen.findByLabelText(DSN_LABEL)).toHaveValue(GATEWAY.error_reporting_dsn)
    expect(screen.getByLabelText('GlitchTip 服务地址(连接器预填)')).toHaveValue(GATEWAY.glitchtip_base_url)
    expect(screen.getByLabelText('GlitchTip 组织 slug(连接器预填)')).toHaveValue(GATEWAY.glitchtip_organization)
    // 仅展示错误监控域字段,不渲染网关的默认模型/思考强度
    expect(screen.queryByText('默认模型')).not.toBeInTheDocument()
    expect(screen.queryByText('默认思考强度(客户端默认模型,登录自动应用)')).not.toBeInTheDocument()
  })

  it('保存仅提交错误监控域字段(不覆盖其他网关配置)', async () => {
    render(<ErrorMonitoring />)
    await screen.findByLabelText(DSN_LABEL)
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith(
        '/api/server/admin/gateway',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({
            error_reporting_enabled: true,
            error_reporting_dsn: GATEWAY.error_reporting_dsn,
            error_reporting_level: 'warning',
            // P1-2:心跳开关随保存提交(默认 false = 与今天行为一致)。
            error_reporting_heartbeat: false,
            glitchtip_base_url: GATEWAY.glitchtip_base_url,
            glitchtip_organization: 'picoaide',
          }),
        }),
      )
    })
    // 提交体中不得包含 default_model / default_thinking_level(避免误覆盖)
    const call = mockRequest.mock.calls.find((c) => c[0] === '/api/server/admin/gateway' && (c[1] as RequestInit)?.method === 'PUT')
    const body = JSON.parse((call![1] as RequestInit).body as string)
    expect(body.default_model).toBeUndefined()
    expect(body.default_thinking_level).toBeUndefined()
  })

  it('非法 DSN 触发校验', async () => {
    render(<ErrorMonitoring />)
    const input = await screen.findByLabelText(DSN_LABEL)
    fireEvent.change(input, { target: { value: 'not-a-url' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    // 同一句中文会出现在两处(输入框下方的实时提示 + 顶部"保存被拦"横幅),
    // 两处都是有意为之:前者定位错误字段,后者确认保存动作被拒。
    expect((await screen.findAllByText(DSN_MALFORMED_MESSAGE)).length).toBeGreaterThanOrEqual(1)
    expect(mockRequest).not.toHaveBeenCalledWith('/api/server/admin/gateway', expect.objectContaining({ method: 'PUT' }))
  })

  it('关闭上报开关保存 false', async () => {
    render(<ErrorMonitoring />)
    await screen.findByLabelText(DSN_LABEL)
    // 当前 enabled=true;点击开关 → false。
    // 页面现有两个 Switch(启用上报 + 心跳),这里按序取第一个 = 启用开关。
    fireEvent.click(screen.getAllByRole('switch')[0]!)
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => {
      const put = mockRequest.mock.calls.find((c) => c[0] === '/api/server/admin/gateway' && (c[1] as RequestInit)?.method === 'PUT')
      const body = JSON.parse((put![1] as RequestInit).body as string)
      expect(body.error_reporting_enabled).toBe(false)
    })
  })

  // --- P0-2:保存前拦截(AC2) -------------------------------------------------

  it('拒绝指向本机的 DSN 并给出中文提示(不发 PUT)', async () => {
    render(<ErrorMonitoring />)
    const input = await screen.findByLabelText(DSN_LABEL)
    // 现场真值(REQUEST F6/F8):GlitchTip 缺 GLITCHTIP_DOMAIN 时后台展示的 DSN。
    fireEvent.change(input, { target: { value: 'http://key@localhost:8000/1' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect((await screen.findAllByText(DSN_BLOCKED_MESSAGE)).length).toBeGreaterThanOrEqual(1)
    // 必须**不发请求** —— 不只是服务端拒绝,页面自己就该拦下。
    expect(mockRequest).not.toHaveBeenCalledWith('/api/server/admin/gateway', expect.objectContaining({ method: 'PUT' }))
  })

  it('接受生产形态的公网 DSN', async () => {
    render(<ErrorMonitoring />)
    const input = await screen.findByLabelText(DSN_LABEL)
    const dsn = 'https://key@glitchtip.example.com/sentry/7'
    fireEvent.change(input, { target: { value: dsn } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => {
      const put = mockRequest.mock.calls.find((c) => c[0] === '/api/server/admin/gateway' && (c[1] as RequestInit)?.method === 'PUT')
      expect(put).toBeTruthy()
      const body = JSON.parse((put![1] as RequestInit).body as string)
      expect(body.error_reporting_dsn).toBe(dsn)
    })
  })

  // --- 修复轮 1(F-13):跨字段一致性 ----------------------------------------

  it('开启上报但 DSN 为空时拒绝保存(跨字段,不发 PUT)', async () => {
    // 单字段都合法、组合起来必然不工作:客户端 initSentry('') 直接返回,
    // 后台永远收不到,而管理员看到的是"已保存"(R2 的跨字段形态)。
    render(<ErrorMonitoring />)
    const input = await screen.findByLabelText(DSN_LABEL)
    fireEvent.change(input, { target: { value: '' } })
    // 当前 enabled=true(mock GET 返回值),直接保存。
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText(/启用客户端错误上报时必须填写 DSN/)).toBeInTheDocument()
    expect(mockRequest).not.toHaveBeenCalledWith('/api/server/admin/gateway', expect.objectContaining({ method: 'PUT' }))
  })

  it('关闭上报开关 + 空 DSN 是合法组合(允许停用)', async () => {
    render(<ErrorMonitoring />)
    const input = await screen.findByLabelText(DSN_LABEL)
    fireEvent.change(input, { target: { value: '' } })
    // 两个 Switch 按序:第一个 = 启用上报。
    fireEvent.click(screen.getAllByRole('switch')[0]!)
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => {
      const put = mockRequest.mock.calls.find((c) => c[0] === '/api/server/admin/gateway' && (c[1] as RequestInit)?.method === 'PUT')
      const body = JSON.parse((put![1] as RequestInit).body as string)
      expect(body.error_reporting_enabled).toBe(false)
      expect(body.error_reporting_dsn).toBe('')
    })
  })

  it('端口越界的 DSN 在前端就被拒(与 Go 权威规则同文案)', async () => {
    render(<ErrorMonitoring />)
    const input = await screen.findByLabelText(DSN_LABEL)
    fireEvent.change(input, { target: { value: 'http://key@glitchtip.example.com:99999/1' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect((await screen.findAllByText(/端口必须是 1-65535/)).length).toBeGreaterThanOrEqual(1)
    expect(mockRequest).not.toHaveBeenCalledWith('/api/server/admin/gateway', expect.objectContaining({ method: 'PUT' }))
  })

  // --- P2-3:私网/明文只告警不阻断 ------------------------------------------

  it('私网 DSN 保存后显示黄色告警(不阻断保存)', async () => {
    // 公钥用**独特字面量**而不是 "key":下面的"不回显公钥"断言必须能咬住真泄漏
    // (泛化的 /key/ 在页面把 `publicKey` 原样渲染出来时仍可能假绿)。
    const publicKey = 'pubkey0123456789abcdef'
    render(<ErrorMonitoring />)
    const input = await screen.findByLabelText(DSN_LABEL)
    fireEvent.change(input, { target: { value: `http://${publicKey}@10.0.0.5/1` } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    // 保存必须发生(内网自建 GlitchTip 是合法场景)。
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('/api/server/admin/gateway', expect.objectContaining({ method: 'PUT' }))
    })
    // 输入框下方实时回显解析结果(不含 public key)。
    expect(await screen.findByText(/主机: 10\.0\.0\.5 \/ 项目 ID: 1/, { exact: false })).toBeInTheDocument()
    // 2026-09-17 审计 S12-03:原断言漏了调用括号(`.not.toBeInTheDocument`),
    // 取到的是函数对象 —— 永远为真、从不执行,页面真泄漏公钥也照样绿。
    // 靶点必须落在**渲染出来的文本**上:input 的 value 不进 textContent,
    // 所以这里若是红的,只可能是页面把 DSN 里的公钥渲染了出来。
    expect(document.body.textContent ?? '').not.toContain(publicKey)
  })

  // --- P0-4:发送测试事件(AC3) ---------------------------------------------

  it('发送测试事件成功时显示成功提示', async () => {
    render(<ErrorMonitoring />)
    await screen.findByLabelText(DSN_LABEL)
    fireEvent.click(screen.getByRole('button', { name: '发送测试事件' }))
    expect(await screen.findByText(/测试事件已发送\(event_id abcdef01…,HTTP 200,42ms\)/)).toBeInTheDocument()
    expect(mockRequest).toHaveBeenCalledWith(
      '/api/server/admin/gateway/error-reporting/test',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('发送测试事件失败时显示可读原因', async () => {
    mockRequest.mockImplementation(async (path: string) => {
      if (path.endsWith('/gateway/error-reporting/clients')) return CLIENTS as any
      if (path.endsWith('/gateway/error-reporting/test')) {
        const { ApiError } = await import('../api')
        throw new ApiError(502, 'UPSTREAM', '无法解析上报服务域名(DNS 失败)', { kind: 'DNS' })
      }
      return GATEWAY as any
    })
    render(<ErrorMonitoring />)
    await screen.findByLabelText(DSN_LABEL)
    fireEvent.click(screen.getByRole('button', { name: '发送测试事件' }))
    // 失败分类必须透出(AC3 要求可区分 DNS/CONNECT/TLS/TIMEOUT/HTTP_4XX/HTTP_5XX)。
    expect(await screen.findByText('无法解析上报服务域名(DNS 失败)(DNS)')).toBeInTheDocument()
  })

  // --- P1-2:心跳开关 --------------------------------------------------------

  it('心跳开关随保存提交', async () => {
    render(<ErrorMonitoring />)
    await screen.findByLabelText(DSN_LABEL)
    fireEvent.click(screen.getByLabelText('启动时发送链路心跳(证明上报链路存活)'))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => {
      const put = mockRequest.mock.calls.find((c) => c[0] === '/api/server/admin/gateway' && (c[1] as RequestInit)?.method === 'PUT')
      const body = JSON.parse((put![1] as RequestInit).body as string)
      expect(body.error_reporting_heartbeat).toBe(true)
    })
  })

  // --- P1-3:客户端上报状态 --------------------------------------------------

  it('展示客户端上报状态(含失败原因)', async () => {
    render(<ErrorMonitoring />)
    expect(await screen.findByText(/已启用上报:/)).toBeInTheDocument()
    // 计数块是**无条件渲染**的（ErrorMonitoring.tsx 的四个 div 用 `?? 0`），它出现
    // 不代表 clients 明细已落地 —— 明细断言必须自己等（同族竞态，2026-09-17 审计）。
    expect(await screen.findByText(/u2\(初始化失败\): Sentry init 失败:invalid dsn/)).toBeInTheDocument()
    expect(mockRequest).toHaveBeenCalledWith('/api/server/admin/gateway/error-reporting/clients')
    // 有数据时不得出现"尚无客户端上报状态"误导文案。
    expect(screen.queryByText(/尚无客户端上报状态/)).not.toBeInTheDocument()
  })

  it('无数据时不显示为正常', async () => {
    mockApi({ clients: { ready: 0, disabled: 0, failed: 0, config_unavailable: 0, idle: 0, total: 0, last_report_at: null, items: [] } })
    render(<ErrorMonitoring />)
    // 本 bug 的教训:空数据必须显式说明"这不代表链路正常"。
    expect(await screen.findByText(/尚无客户端上报状态。这不代表链路正常/)).toBeInTheDocument()
  })
})
