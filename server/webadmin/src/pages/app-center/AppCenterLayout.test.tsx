import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { me, request } from '../../api'
import { setCurrentAdmin, type MeUser } from '../../lib/rbac'

// ---------------------------------------------------------------------------
// 应用中心(2026-09-19 合并)的**结构接线**测试:子导航三项、三个子路由、
// 以及老路径 `/app-platform` 的重定向。
//
// 这里刻意渲染整棵 App(自带 BrowserRouter basename=/admin),而不是单独渲染
// 子组件 —— 光渲组件证明不了「tab 的 to」与「App.tsx 的 Route path」是同一个
// 字符串,也证明不了懒加载 chunk 能就绪。子组件自身的行为断言在
// AppCenter.test.tsx(应用/设置)与 AppPlatform.test.tsx(限制项)。
// ---------------------------------------------------------------------------

const SUPER: MeUser = { role: 'super_admin', permissions: ['capability:read', 'capability:write'] }
const mockRequest = vi.mocked(request)

const LIMITS = {
  max_instances: 3, app_running: 4, app_queue: 32, user_global_running: 4,
  user_per_app_running: 1, user_per_app_queued: 4, instance_memory_mb: 64,
  module_cache_mb: 64, module_cache_idle_min: 10, appdb_idle_min: 3, appdb_cache_kib: 1024,
  app_db_readers: 4,
}
const LIMITS_VIEW = {
  limits: LIMITS,
  source: 'setting',
  defaults: LIMITS,
  presets: {},
  ranges: {},
  budget: {
    profile: 'settings', instances_bytes: 0, compile_peak_bytes: 0, upload_peak_bytes: 0,
    cache_resident_bytes: 0, total_bytes: 0, available_bytes: 0, limit_bytes: 0, ok: true,
  },
  guard_percent: 70,
  restart_fields: [],
  restart_pending: [],
  setting_key: 'wasm.limits',
}

beforeEach(() => {
  setCurrentAdmin(SUPER)
  mockRequest.mockReset()
  mockRequest.mockImplementation(async (path: string) => {
    if (path === '/api/server/admin/wasm-apps') {
      return { apps: [], review_required: false, setting_key: 'wasm.review_required' }
    }
    if (path === '/api/server/admin/wasm-apps/domain') {
      return {
        base_domain: 'apps.example.com', source: 'setting', enabled: true,
        url_pattern: 'https://<app_id>.apps.example.com', setting_key: 'wasm.apps_base_domain',
      }
    }
    if (path === '/api/server/admin/wasm-apps/limits') return LIMITS_VIEW
    return {}
  })
  vi.mocked(me).mockResolvedValue({ user: SUPER })
  // useChannel() 走原生 fetch(公开渠道端点);jsdom 里给个空渠道内容。
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', {
    status: 200, headers: { 'content-type': 'application/json' },
  })))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.mocked(me).mockReset()
  setCurrentAdmin(null)
})

/** 渲染整棵 App 并停在指定路径(等侧栏到位 = 应用壳已挂载)。 */
async function renderAppAt(path: string) {
  window.history.pushState({}, '', path)
  const App = (await import('../../App')).default
  render(<App />)
  await screen.findByRole('link', { name: '应用中心' })
}

describe('应用中心(合并后)的子导航与子路由', () => {
  it('子导航三项:应用 / 限制项 / 设置,分别指向三个子路由', async () => {
    await renderAppAt('/admin/app-center')

    expect(await screen.findByRole('link', { name: '应用' })).toHaveAttribute('href', '/admin/app-center')
    expect(screen.getByRole('link', { name: '限制项' })).toHaveAttribute('href', '/admin/app-center/limits')
    expect(screen.getByRole('link', { name: '设置' })).toHaveAttribute('href', '/admin/app-center/settings')

    // 索引页 = 应用列表:不渲染限制项/设置的专属控件
    expect(await screen.findByRole('heading', { name: '应用' })).toBeInTheDocument()
    expect(screen.queryByTestId('save-limits')).toBeNull()
    expect(screen.queryByLabelText('应用域名')).toBeNull()
  })

  it('深链接 /app-center/limits 直接渲染限制项(原应用平台的主体)', async () => {
    await renderAppAt('/admin/app-center/limits')
    expect(await screen.findByTestId('save-limits')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '限制项' })).toBeInTheDocument()
    // 应用列表的控件不在这一页
    expect(screen.queryByRole('switch', { name: '更新审批' })).toBeNull()
  })

  it('深链接 /app-center/settings 直接渲染设置页(应用域名卡片)', async () => {
    await renderAppAt('/admin/app-center/settings')
    expect(await screen.findByLabelText('应用域名')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '设置' })).toBeInTheDocument()
    expect(screen.queryByTestId('save-limits')).toBeNull()
  })

  it('点子导航切换:限制项 → 设置 → 应用,各自渲染对应内容', async () => {
    await renderAppAt('/admin/app-center')
    expect(await screen.findByRole('heading', { name: '应用' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('link', { name: '限制项' }))
    expect(await screen.findByTestId('save-limits')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: '应用' })).toBeNull()

    fireEvent.click(screen.getByRole('link', { name: '设置' }))
    expect(await screen.findByLabelText('应用域名')).toBeInTheDocument()
    expect(screen.queryByTestId('save-limits')).toBeNull()

    fireEvent.click(screen.getByRole('link', { name: '应用' }))
    expect(await screen.findByRole('heading', { name: '应用' })).toBeInTheDocument()
    expect(screen.queryByLabelText('应用域名')).toBeNull()
  })

  it('/app-platform 老书签 → 重定向到 /app-center/limits(内容等价,不 404)', async () => {
    await renderAppAt('/admin/app-platform')
    // 重定向后落到限制项子页（老书签原本看到的就是限制项，不是设置页）
    expect(await screen.findByTestId('save-limits')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/admin/app-center/limits')
    expect(screen.queryByText('404 页面不存在')).toBeNull()
  })
})
