import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { me, request } from '../../api'
import { setCurrentAdmin, type MeUser } from '../../lib/rbac'

// ---------------------------------------------------------------------------
// 应用中心(2026-09-19 合并)的**结构接线**测试:子导航两项、两个子路由、
// 以及老路径 `/app-platform` 的重定向。
//
// 这里刻意渲染整棵 App(自带 BrowserRouter basename=/admin),而不是单独渲染
// 子组件 —— 光渲组件证明不了「tab 的 to」与「App.tsx 的 Route path」是同一个
// 字符串,也证明不了懒加载 chunk 能就绪。子组件自身的行为断言在
// AppCenter.test.tsx(应用)与 AppPlatform.test.tsx(限制项)。
//
// 2026-09-19 WASM 客户端专属改造:原「设置」子页(应用访问域名/泛域名)整页删除
// (契约 `docs/decisions/2026-09-19-wasm-client-internal-origin.md` §4.4/§4.5)——
// 应用只在桌面客户端内以 `picoaide-app://<app_id>/` 打开,服务端连基域配置面
// (`wasm.apps_base_domain`、`GET/PUT /wasm-apps/domain`)一起删。因此这里另加两条
// 拦截用例:①子导航不再有「设置」、旧路径落 404;②**整个应用中心一个字节都不许**
// 再请求 `/wasm-apps/domain`(后端下线后前端还发请求 = 每次进页面都 404/500)。
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
    cache_resident_bytes: 0, appdb_cache_bytes: 0, total_bytes: 0, available_bytes: 0,
    known: true, limit_bytes: 0, ok: true,
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
    if (path === '/api/server/admin/wasm-apps/limits') return LIMITS_VIEW
    // 运营看板（F16）：空窗口也能渲染（KPI 0 + 空态），避免接线测试里报"缺后端"。
    if (String(path).startsWith('/api/server/admin/wasm-apps/opens/summary')) {
      return {
        days: 7, top: 10, today: { day: '2026-09-19', pv: 0, uv: 0 },
        totals: { pv: 0, uv: 0 }, trend: [], apps: [], top_apps: [], detail_retention_days: 90,
      }
    }
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
  // AppCenterLayout 自己是懒加载 chunk：全套 32 个测试文件并行时，chunk 就绪可能
  // 超过全局 5s 的 asyncUtilTimeout（并行下实测偶发"找不到 tab"）⇒ 给 15s 预算。
  //
  // **best-effort**：`/app-center/settings` 这类不匹配父路由的路径会直接落到 404，
  // 根本没有 tab bar —— 这里等不到是正常的，由各用例自己断言该看到什么
  // （真正"tab 坏了"的用例仍会在自己的断言上红）。
  await screen.findByRole('link', { name: '应用' }, { timeout: 15_000 }).catch(() => null)
}

describe('应用中心(合并后)的子导航与子路由', () => {
  it('子导航三项:应用 / 运营看板 / 限制项(「设置」已随基域配置面删除)', async () => {
    await renderAppAt('/admin/app-center')

    expect(await screen.findByRole('link', { name: '应用' })).toHaveAttribute('href', '/admin/app-center')
    // F16（2026-09-19 W5）：打开次数是运营视图，与处置动作分页。
    expect(screen.getByRole('link', { name: '运营看板' })).toHaveAttribute('href', '/admin/app-center/opens')
    expect(screen.getByRole('link', { name: '限制项' })).toHaveAttribute('href', '/admin/app-center/limits')
    // 原「设置」子页(应用域名)整页删除 ⇒ 子导航项不许再出现
    expect(screen.queryByRole('link', { name: '设置' })).toBeNull()

    // 索引页 = 应用列表:不渲染限制项的专属控件
    expect(await screen.findByRole('heading', { name: '应用' })).toBeInTheDocument()
    expect(screen.queryByTestId('save-limits')).toBeNull()
  })

  it('深链接 /app-center/opens 直接渲染运营看板（打开次数 PV/UV/趋势/TOP N）', async () => {
    await renderAppAt('/admin/app-center/opens')
    expect(await screen.findByTestId('opens-board')).toBeInTheDocument()
    expect(await screen.findByTestId('opens-window-pv')).toBeInTheDocument()
    expect(screen.getByTestId('opens-notes').textContent).toContain('PV = 每次打开都 +1（不去重）')
    // 应用列表与限制项的控件不在这一页
    expect(screen.queryByRole('switch', { name: '更新审批' })).toBeNull()
    expect(screen.queryByTestId('save-limits')).toBeNull()
  })

  it('原「设置」的位置留一行说明:应用只在桌面客户端内打开,不再需要应用域名与证书', async () => {
    await renderAppAt('/admin/app-center')
    // 契约 §2/§4.5:应用只在客户端内以 picoaide-app://<app_id>/ 打开。
    // 这行说明是配置面删除后唯一的"去哪了"答案(不说明会被读成功能被藏起来)。
    expect(await screen.findByTestId('app-center-client-only-note')).toHaveTextContent(
      '应用只在桌面客户端内打开，不再需要应用域名与证书。',
    )
  })

  it('深链接 /app-center/limits 直接渲染限制项(原应用平台的主体)', async () => {
    await renderAppAt('/admin/app-center/limits')
    expect(await screen.findByTestId('save-limits')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '限制项' })).toBeInTheDocument()
    // 应用列表的控件不在这一页
    expect(screen.queryByRole('switch', { name: '更新审批' })).toBeNull()
  })

  it('老路径 /app-center/settings 不再有页面(基域配置整页删除,不静默回落)', async () => {
    await renderAppAt('/admin/app-center/settings')
    expect(await screen.findByText('404 页面不存在')).toBeInTheDocument()
    // 404 也不能顺手渲染出任何"应用域名"残留控件
    expect(screen.queryByLabelText('应用域名')).toBeNull()
  })

  it('点子导航切换:限制项 → 应用,各自渲染对应内容', async () => {
    await renderAppAt('/admin/app-center')
    expect(await screen.findByRole('heading', { name: '应用' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('link', { name: '限制项' }))
    expect(await screen.findByTestId('save-limits')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: '应用' })).toBeNull()

    fireEvent.click(screen.getByRole('link', { name: '应用' }))
    expect(await screen.findByRole('heading', { name: '应用' })).toBeInTheDocument()
    expect(screen.queryByTestId('save-limits')).toBeNull()
  })

  it('/app-platform 老书签 → 重定向到 /app-center/limits(内容等价,不 404)', async () => {
    await renderAppAt('/admin/app-platform')
    // 重定向后落到限制项子页（老书签原本看到的就是限制项，不是设置页）
    expect(await screen.findByTestId('save-limits')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/admin/app-center/limits')
    expect(screen.queryByText('404 页面不存在')).toBeNull()
  })

  it('应用中心三个子页都不再请求 /wasm-apps/domain(后端已删,C2 之后发给谁都是 404)', async () => {
    await renderAppAt('/admin/app-center')
    await screen.findByRole('heading', { name: '应用' })
    fireEvent.click(screen.getByRole('link', { name: '运营看板' }))
    await screen.findByTestId('opens-board')
    fireEvent.click(screen.getByRole('link', { name: '限制项' }))
    await screen.findByTestId('save-limits')

    const domainCalls = mockRequest.mock.calls.filter(([p]) => String(p).includes('/wasm-apps/domain'))
    expect(domainCalls, `前端仍在请求已删除的基域端点：${JSON.stringify(domainCalls)}`).toEqual([])
  })
})
