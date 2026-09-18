import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { me, request } from '../api'
import { setCurrentAdmin, type MeUser } from '../lib/rbac'
import AppCenter from './AppCenter'

// ---------------------------------------------------------------------------
// 应用中心(2026-09-18):员工自建 WASM 应用的平台管理员面。
//
// 覆盖两条硬口径:
//   ① 每个写动作都打到**契约里那一条**路径与 body(上架/下架/冻结/解冻/转移归属/
//      更新审批开关),不做本地伪造;
//   ② 权限是体验层:capa:write 缺席时写控件整体不渲染、且**不发**任何写请求
//      (服务端 RequirePermission 才是护栏,这里只是别让用户点出 403)。
// ---------------------------------------------------------------------------

const LIVE = {
  app_id: 'share-note', title: '共享便签', description: '团队共享的便签墙',
  owner: 'alice', enabled: true, access: 'login', purpose: '团队协作与周会记录',
  data_sensitivity: '内部', current_release_id: 12, current_version: '1.0.2',
  frozen_at: null as string | null, deleted_at: null as string | null,
  created_at: '2026-09-18T10:00:00Z', updated_at: '2026-09-18T11:00:00Z',
}
const OFF = {
  ...LIVE, app_id: 'ops-tool', title: '运维小工具', description: '值班检查清单',
  owner: 'bob', enabled: false, access: 'whitelist', purpose: '值班巡检',
  data_sensitivity: '公开', current_release_id: 7, current_version: '0.9.0',
}
const FROZEN = {
  ...LIVE, app_id: 'legacy-board', title: '旧看板', description: '已停用的看板',
  owner: 'carol', enabled: false, access: 'public', purpose: '', data_sensitivity: '',
  current_release_id: 3, current_version: '', frozen_at: '2026-09-17T09:00:00Z',
}
const APP_LIST = [LIVE, OFF, FROZEN]

const SUPER: MeUser = { role: 'super_admin', permissions: ['capability:read', 'capability:write'] }
/** 只有读权限(capability:write 缺席)= 只读视图。 */
const READONLY: MeUser = { role: 'user', permissions: ['capability:read'] }

const mockRequest = vi.mocked(request)

beforeEach(() => {
  setCurrentAdmin(SUPER)
  mockRequest.mockReset()
  mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/api/server/admin/wasm-apps') {
      return { apps: APP_LIST, review_required: false, setting_key: 'wasm.review_required' }
    }
    // 应用泛域名配置(GET 当前值 / PUT 保存后回读同一形状)。
    if (path === '/api/server/admin/wasm-apps/domain') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { base_domain?: string }
      const next = init?.method === 'PUT' ? (body.base_domain ?? '') : 'apps.example.com'
      return {
        base_domain: next,
        source: next === '' ? 'none' : 'setting',
        enabled: next !== '',
        url_pattern: next === '' ? '' : `https://<app_id>.${next}`,
        setting_key: 'wasm.apps_base_domain',
      }
    }
    if (path === '/api/server/admin/wasm-apps/review') {
      return { review_required: true, changed: true, setting_key: 'wasm.review_required' }
    }
    if (path.endsWith('/unpublish')) return { app: { app_id: 'share-note', enabled: false, changed: true } }
    if (path.endsWith('/publish')) return { app: { app_id: 'ops-tool', enabled: true, changed: true } }
    if (path.endsWith('/freeze')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { frozen?: boolean }
      return body.frozen === false
        ? { app: { app_id: 'legacy-board', frozen: false, changed: true, enabled: false } }
        : { app: { app_id: 'share-note', frozen: true, changed: true, frozen_at: '2026-09-18T12:00:00Z', enabled: false } }
    }
    if (path.endsWith('/owner')) return { app: { app_id: 'share-note', owner: 'carol', changed: true } }
    return {}
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.mocked(me).mockReset()
  setCurrentAdmin(null)
})

/** 渲染并等到列表落地(否则断言会撞上"加载中…"中间态)。 */
async function renderList() {
  render(<AppCenter />)
  expect(await screen.findByText('共享便签')).toBeInTheDocument()
}

function rowOf(appId: string): HTMLElement {
  const cell = screen.getByText(appId)
  const tr = cell.closest('tr')
  if (tr === null) throw new Error(`未找到 ${appId} 所在的行`)
  return tr
}

describe('AppCenter 应用中心', () => {
  it('渲染应用列表:标题/app_id/访问级别中文标签/负责人/当前版本/状态', async () => {
    await renderList()

    // 列头
    for (const h of ['应用', '访问级别', '状态', '负责人', '当前版本', '更新时间']) {
      expect(screen.getByRole('columnheader', { name: h })).toBeInTheDocument()
    }

    // 应用列:标题 + app_id 小字
    expect(screen.getByText('共享便签')).toBeInTheDocument()
    expect(screen.getByText('share-note')).toBeInTheDocument()
    expect(screen.getByText('运维小工具')).toBeInTheDocument()
    expect(screen.getByText('ops-tool')).toBeInTheDocument()

    // 访问级别:public/login/whitelist 各自的**中文**标签
    expect(screen.getByText('登录后全员')).toBeInTheDocument()
    expect(screen.getByText('白名单')).toBeInTheDocument()
    expect(screen.getByText('公开')).toBeInTheDocument()

    // 负责人 + 当前版本(空串回落 '—')
    expect(screen.getByText('alice')).toBeInTheDocument()
    expect(screen.getByText('bob')).toBeInTheDocument()
    expect(screen.getByText('carol')).toBeInTheDocument()
    expect(screen.getByText('1.0.2')).toBeInTheDocument()
    expect(screen.getByText('0.9.0')).toBeInTheDocument()

    // 状态:上架 / 已下架 / 已冻结(冻结优先于 enabled)
    expect(within(rowOf('share-note')).getByText('上架')).toBeInTheDocument()
    expect(within(rowOf('ops-tool')).getByText('已下架')).toBeInTheDocument()
    expect(within(rowOf('legacy-board')).getByText('已冻结')).toBeInTheDocument()
    // 冻结行虽然有 frozen_at,但按钮必须给「解冻」而不是「冻结」
    expect(within(rowOf('legacy-board')).getByRole('button', { name: '解冻' })).toBeInTheDocument()
  })

  it('点「下架」→ POST /wasm-apps/<id>/unpublish，并按响应把该行切回「上架」', async () => {
    await renderList()
    fireEvent.click(screen.getByRole('button', { name: '下架' }))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith(
        '/api/server/admin/wasm-apps/share-note/unpublish',
        { method: 'POST' },
      )
    })
    // 响应 enabled:false ⇒ 该行状态徽章变「已下架」、按钮变「上架」(本地同步状态)
    await waitFor(() => {
      expect(within(rowOf('share-note')).getByText('已下架')).toBeInTheDocument()
    })
  })

  it('点「上架」→ POST /wasm-apps/<id>/publish', async () => {
    await renderList()
    const offRow = rowOf('ops-tool')
    fireEvent.click(within(offRow).getByRole('button', { name: '上架' }))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith(
        '/api/server/admin/wasm-apps/ops-tool/publish',
        { method: 'POST' },
      )
    })
    await waitFor(() => {
      expect(within(rowOf('ops-tool')).getByText('上架')).toBeInTheDocument()
    })
  })

  it('冻结/解冻 → POST /wasm-apps/<id>/freeze 且 body 是 {"frozen":…}', async () => {
    await renderList()
    fireEvent.click(within(rowOf('share-note')).getByRole('button', { name: '冻结' }))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith(
        '/api/server/admin/wasm-apps/share-note/freeze',
        { method: 'POST', body: JSON.stringify({ frozen: true }) },
      )
    })
    // 冻结优先显示:即使响应把 enabled 置 false,该行也必须是「已冻结」
    await waitFor(() => {
      expect(within(rowOf('share-note')).getByText('已冻结')).toBeInTheDocument()
    })

    fireEvent.click(within(rowOf('legacy-board')).getByRole('button', { name: '解冻' }))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith(
        '/api/server/admin/wasm-apps/legacy-board/freeze',
        { method: 'POST', body: JSON.stringify({ frozen: false }) },
      )
    })
  })

  it('切换「更新审批」开关 → PUT /wasm-apps/review 且 body 是 {"required":…}', async () => {
    await renderList()
    const sw = screen.getByRole('switch', { name: '更新审批' })
    // 列表下发 review_required=false ⇒ 初始为关
    expect(sw).toHaveAttribute('data-state', 'unchecked')

    fireEvent.click(sw)
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith(
        '/api/server/admin/wasm-apps/review',
        { method: 'PUT', body: JSON.stringify({ required: true }) },
      )
    })
    // 成功后本地同步服务端真值
    await waitFor(() => {
      expect(screen.getByRole('switch', { name: '更新审批' })).toHaveAttribute('data-state', 'checked')
    })
  })

  it('转移归属对话框提交 → PUT /wasm-apps/<id>/owner 且 body 含 owner', async () => {
    await renderList()
    fireEvent.click(within(rowOf('share-note')).getByRole('button', { name: '转移归属' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('转移归属')
    // 未填写时不可提交(防把归属转移给空用户名)
    expect(screen.getByRole('button', { name: '确认转移' })).toBeDisabled()

    fireEvent.change(screen.getByLabelText('新负责人用户名'), { target: { value: 'carol' } })
    fireEvent.click(screen.getByRole('button', { name: '确认转移' }))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith(
        '/api/server/admin/wasm-apps/share-note/owner',
        { method: 'PUT', body: JSON.stringify({ owner: 'carol' }) },
      )
    })
    const call = mockRequest.mock.calls.find(([p]) => String(p).endsWith('/share-note/owner'))
    expect(String((call?.[1] as RequestInit | undefined)?.body)).toContain('carol')
    // 响应 owner ⇒ 列表该行负责人同步为 carol
    await waitFor(() => {
      expect(within(rowOf('share-note')).getByText('carol')).toBeInTheDocument()
    })
  })

  it('列表加载失败时给出可见错误提示(不静默、也不谎报空列表)', async () => {
    mockRequest.mockImplementation(async () => {
      throw new Error('服务暂时不可用,请稍后再试')
    })
    render(<AppCenter />)
    expect(await screen.findByText('服务暂时不可用,请稍后再试')).toBeInTheDocument()
    expect(screen.queryByText('暂无应用')).toBeNull()
  })

  it('写操作失败时给出可见错误提示,且不伪造成功状态', async () => {
    mockRequest.mockImplementation(async (path: string) => {
      if (path === '/api/server/admin/wasm-apps') {
        return { apps: APP_LIST, review_required: false, setting_key: 'wasm.review_required' }
      }
      throw new Error('下架失败:应用已被冻结')
    })
    await renderList()
    fireEvent.click(screen.getByRole('button', { name: '下架' }))
    expect(await screen.findByText('下架失败:应用已被冻结')).toBeInTheDocument()
    // 该行仍是上架态(不乐观改本地状态)
    expect(within(rowOf('share-note')).getByText('上架')).toBeInTheDocument()
  })

  it('无 capability:write 时写控件不可见/禁用,且不发任何写请求', async () => {
    setCurrentAdmin(READONLY)
    await renderList()

    // 读面照旧可用
    expect(screen.getByText('alice')).toBeInTheDocument()
    // 写操作入口整体缺席
    for (const name of ['上架', '下架', '冻结', '解冻', '转移归属']) {
      expect(screen.queryByRole('button', { name })).toBeNull()
    }
    // 组织级开关保留可见但禁用(只读用户仍应看到当前策略)
    expect(screen.getByRole('switch', { name: '更新审批' })).toBeDisabled()
    expect(screen.getByText(/capability:write/)).toBeInTheDocument()
    // 只读入口(详情/刷新)不受影响
    expect(screen.getAllByRole('button', { name: '详情' }).length).toBe(APP_LIST.length)

    // 任何交互都不产生写请求
    fireEvent.click(screen.getByRole('switch', { name: '更新审批' }))
    fireEvent.click(screen.getAllByRole('button', { name: '详情' })[0]!)
    const writes = mockRequest.mock.calls.filter(([, init]) => {
      const m = (init as RequestInit | undefined)?.method
      return m !== undefined && m !== 'GET' && m !== 'HEAD'
    })
    expect(writes).toEqual([])
  })

  it('详情对话框展示 purpose/数据敏感度/版本 id/创建与更新时间/描述', async () => {
    await renderList()
    fireEvent.click(within(rowOf('share-note')).getByRole('button', { name: '详情' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('团队协作与周会记录')
    expect(dialog).toHaveTextContent('内部')
    expect(dialog).toHaveTextContent('12')
    expect(dialog).toHaveTextContent(new Date(LIVE.created_at).toLocaleString('zh-CN', { hour12: false }))
    expect(dialog).toHaveTextContent(new Date(LIVE.updated_at).toLocaleString('zh-CN', { hour12: false }))
    expect(dialog).toHaveTextContent('团队共享的便签墙')
  })

  it('空列表走 EmptyState,不是一张空表格', async () => {
    mockRequest.mockImplementation(async () => ({ apps: [], review_required: false, setting_key: 'wasm.review_required' }))
    render(<AppCenter />)
    expect(await screen.findByText('暂无应用')).toBeInTheDocument()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('刷新按钮重新拉取列表', async () => {
    await renderList()
    const before = mockRequest.mock.calls.filter(([p]) => p === '/api/server/admin/wasm-apps').length
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await waitFor(() => {
      const after = mockRequest.mock.calls.filter(([p]) => p === '/api/server/admin/wasm-apps').length
      expect(after).toBe(before + 1)
    })
  })

  it('路由接线:nav 的 /app-center 在 App 里确实有条路由(懒加载页面可渲染)', async () => {
    // 光跑 build 只能证明 chunk 能解析,证不了 nav.to 与 Route path 是同一个字符串
    // —— 那条只有整树渲染才能钉住。App 自带 BrowserRouter(basename=/admin)。
    window.history.pushState({}, '', '/admin/app-center')
    vi.mocked(me).mockResolvedValue({ user: SUPER })
    // useChannel() 走原生 fetch(公开渠道端点);jsdom 里给个空渠道内容。
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', {
      status: 200, headers: { 'content-type': 'application/json' },
    })))
    const App = (await import('../App')).default
    render(<App />)
    // 页面 h1 渲染 = 路由命中 + 懒加载 chunk 就绪
    expect(await screen.findByRole('heading', { name: '应用中心' })).toBeInTheDocument()
    // 侧栏入口指向同一路径(声明与路由漂移会在这里红)
    expect(screen.getByRole('link', { name: '应用中心' })).toHaveAttribute('href', '/admin/app-center')
  })
})

// ---------------------------------------------------------------------------
// 应用域名(泛域名)配置:应用名 + 该域名 = 应用访问地址(2026-09-18 用户要求)
// ---------------------------------------------------------------------------

describe('应用域名(泛域名)配置', () => {
  it('展示当前基域、来源与"应用名.域名"模板', async () => {
    render(<AppCenter />)
    const input = await screen.findByLabelText('应用域名')
    expect((input as HTMLInputElement).value).toBe('apps.example.com')
    // 文本是"来源：控制台配置"整体（同一 span），用正则匹配子串。
    expect(await screen.findByText(/控制台配置/)).toBeTruthy()
    expect(await screen.findByText('https://<app_id>.apps.example.com')).toBeTruthy()
    // 提示里必须写明"填主域名、不要填通配符",否则管理员八成会填 *.example.com。
    expect(screen.getByText(/不要填/)).toBeTruthy()
  })

  it('保存 → PUT /wasm-apps/domain，body 是 {"base_domain": …}', async () => {
    render(<AppCenter />)
    const input = await screen.findByLabelText('应用域名')
    fireEvent.change(input, { target: { value: 'harness.example.com' } })
    const save = screen.getByRole('button', { name: '保存' })
    fireEvent.click(save)
    await waitFor(() => {
      const hit = mockRequest.mock.calls.find(
        ([p, init]) => p === '/api/server/admin/wasm-apps/domain' && (init as RequestInit | undefined)?.method === 'PUT',
      )
      expect(hit, '必须真的发出保存请求').toBeTruthy()
      expect(JSON.parse(String((hit![1] as RequestInit).body))).toEqual({ base_domain: 'harness.example.com' })
    })
  })

  it('关闭应用子域 → PUT 传空串(不是删除字段)', async () => {
    render(<AppCenter />)
    await screen.findByLabelText('应用域名')
    fireEvent.click(screen.getByRole('button', { name: '关闭应用子域' }))
    await waitFor(() => {
      const hit = mockRequest.mock.calls.find(
        ([p, init]) => p === '/api/server/admin/wasm-apps/domain' && (init as RequestInit | undefined)?.method === 'PUT',
      )
      expect(hit, '关闭也必须显式发请求').toBeTruthy()
      expect(JSON.parse(String((hit![1] as RequestInit).body))).toEqual({ base_domain: '' })
    })
  })

  it('保存被服务端拒绝(带 hints) → 原样显示 message + hints，绝不静默', async () => {
    mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/server/admin/wasm-apps') {
        return { apps: APP_LIST, review_required: false, setting_key: 'wasm.review_required' }
      }
      if (path === '/api/server/admin/wasm-apps/domain' && (init as RequestInit | undefined)?.method === 'PUT') {
        const e: any = new Error('已启用应用子域，但未配置 PICOAI_TRUSTED_PROXIES')
        e.hints = ['在部署 .env 里显式写出前置反向代理的地址']
        throw e
      }
      if (path === '/api/server/admin/wasm-apps/domain') {
        return { base_domain: '', source: 'none', enabled: false, url_pattern: '', setting_key: 'wasm.apps_base_domain' }
      }
      return {}
    })
    render(<AppCenter />)
    const input = await screen.findByLabelText('应用域名')
    fireEvent.change(input, { target: { value: 'apps.example.com' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText(/未配置 PICOAI_TRUSTED_PROXIES/)).toBeTruthy()
    expect(await screen.findByText(/前置反向代理的地址/)).toBeTruthy()
  })

  it('只读账号 → 输入框与保存/关闭按钮都禁用(零写请求)', async () => {
    setCurrentAdmin(READONLY)
    render(<AppCenter />)
    const input = (await screen.findByLabelText('应用域名')) as HTMLInputElement
    expect(input.disabled).toBe(true)
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '关闭应用子域' }) as HTMLButtonElement).disabled).toBe(true)
    const writes = mockRequest.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method && (init as RequestInit).method !== 'GET',
    )
    expect(writes).toEqual([])
  })
})
