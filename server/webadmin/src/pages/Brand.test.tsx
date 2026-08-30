import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { request } from '../api'
import Brand from './Brand'

const mockRequest = vi.mocked(request)

beforeEach(() => {
  mockRequest.mockReset()
  mockRequest.mockImplementation(async (path: string) => {
    if (path === '/api/admin/brand') return { enabled: true, login: { display_name: 'Acme', tagline: 'AI', welcome: '欢迎' }, client: { display_name: 'Acme AI', accent: '#4176E6' }, title: '' }
    if (path === '/api/admin/portal') return { enabled: true, welcome: '', subtitle: '', client_download_url: '', client_download_note: '', landing_path: '' }
    if (path === '/api/admin/brand/snapshots') return { snapshots: [] }
    return {}
  })
})

describe('Brand 品牌配置页', () => {
  it('渲染启用开关与三 Tab', async () => {
    render(<Brand />)
    expect(await screen.findByText('品牌配置')).toBeInTheDocument()
    expect(screen.getByRole('switch')).toBeInTheDocument()
    expect(screen.getByText('登录页品牌')).toBeInTheDocument()
    expect(screen.getByText('客户端品牌')).toBeInTheDocument()
    expect(screen.getByText('门户首页')).toBeInTheDocument()
  })

  it('保存:提交 PUT brand 和 portal', async () => {
    render(<Brand />)
    await screen.findByText('品牌配置')
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('/api/admin/brand', expect.objectContaining({ method: 'PUT' }))
      expect(mockRequest).toHaveBeenCalledWith('/api/admin/portal', expect.objectContaining({ method: 'PUT' }))
    })
    expect(await screen.findByText(/已保存/)).toBeInTheDocument()
  })

  it('恢复默认: 弹确认并提交 enabled=false', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<Brand />)
    await screen.findByText('品牌配置')
    fireEvent.click(screen.getByRole('button', { name: /恢复默认/ }))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('/api/admin/brand', expect.objectContaining({
        method: 'PUT',
        body: expect.stringContaining('"enabled":false'),
      }))
    })
    confirmSpy.mockRestore()
  })
})
