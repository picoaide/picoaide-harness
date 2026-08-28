import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import ErrorMonitoring from './ErrorMonitoring'
import { request } from '../api'

const mockRequest = vi.mocked(request)

const GATEWAY = {
  default_model: 'deepseek-v4-flash',
  error_reporting_enabled: true,
  error_reporting_dsn: 'https://cc825c63d6494f9f8bb9cff238c1bdae@glitchtip.kq0575.cn/1',
  error_reporting_level: 'warning',
  glitchtip_base_url: 'https://glitchtip.kq0575.cn',
  glitchtip_organization: 'picoaide',
  default_thinking_level: 'max',
}

beforeEach(() => {
  mockRequest.mockReset()
  mockRequest.mockImplementation(async () => GATEWAY)
})

describe('ErrorMonitoring 错误监控页', () => {
  it('回填错误监控域配置(不含网关其他字段)', async () => {
    render(<ErrorMonitoring />)
    expect(await screen.findByLabelText('错误上报 DSN(客户端 Sentry 上报地址,如 GlitchTip)')).toHaveValue(GATEWAY.error_reporting_dsn)
    expect(screen.getByLabelText('GlitchTip 服务地址(连接器预填)')).toHaveValue(GATEWAY.glitchtip_base_url)
    expect(screen.getByLabelText('GlitchTip 组织 slug(连接器预填)')).toHaveValue(GATEWAY.glitchtip_organization)
    // 仅展示错误监控域字段,不渲染网关的默认模型/思考强度
    expect(screen.queryByText('默认模型')).not.toBeInTheDocument()
    expect(screen.queryByText('默认思考强度(客户端默认模型,登录自动应用)')).not.toBeInTheDocument()
  })

  it('保存仅提交错误监控域字段(不覆盖其他网关配置)', async () => {
    render(<ErrorMonitoring />)
    await screen.findByLabelText('错误上报 DSN(客户端 Sentry 上报地址,如 GlitchTip)')
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith(
        '/api/admin/gateway',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({
            error_reporting_enabled: true,
            error_reporting_dsn: GATEWAY.error_reporting_dsn,
            error_reporting_level: 'warning',
            glitchtip_base_url: GATEWAY.glitchtip_base_url,
            glitchtip_organization: 'picoaide',
          }),
        }),
      )
    })
    // 提交体中不得包含 default_model / default_thinking_level(避免误覆盖)
    const call = mockRequest.mock.calls.find((c) => c[0] === '/api/admin/gateway' && (c[1] as RequestInit)?.method === 'PUT')
    const body = JSON.parse((call![1] as RequestInit).body as string)
    expect(body.default_model).toBeUndefined()
    expect(body.default_thinking_level).toBeUndefined()
  })

  it('非法 DSN 触发校验', async () => {
    render(<ErrorMonitoring />)
    const input = await screen.findByLabelText('错误上报 DSN(客户端 Sentry 上报地址,如 GlitchTip)')
    fireEvent.change(input, { target: { value: 'not-a-url' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText('错误上报 DSN 必须是 http(s) URL(如 https://glitchtip.example.com/...或留空)')).toBeInTheDocument()
    expect(mockRequest).not.toHaveBeenCalledWith('/api/admin/gateway', expect.objectContaining({ method: 'PUT' }))
  })

  it('关闭上报开关保存 false', async () => {
    render(<ErrorMonitoring />)
    await screen.findByLabelText('错误上报 DSN(客户端 Sentry 上报地址,如 GlitchTip)')
    // 当前 enabled=true;点击开关 → false
    fireEvent.click(screen.getByRole('switch'))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => {
      const put = mockRequest.mock.calls.find((c) => c[0] === '/api/admin/gateway' && (c[1] as RequestInit)?.method === 'PUT')
      const body = JSON.parse((put![1] as RequestInit).body as string)
      expect(body.error_reporting_enabled).toBe(false)
    })
  })
})
