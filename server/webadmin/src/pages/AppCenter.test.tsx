import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ApiError, me, request } from '../api'
import { setCurrentAdmin, type MeUser } from '../lib/rbac'
import Apps from './app-center/Apps'
import Settings from './app-center/Settings'

// ---------------------------------------------------------------------------
// 应用中心(2026-09-18;2026-09-19 拆成子页):
//   应用   = wasm 应用列表与平台级处置(本文件 Apps 部分)
//   限制项 = 原「应用平台」页,测试在 AppPlatform.test.tsx(渲染 app-center/Limits)
//   设置   = 应用域名(泛域名),本文件 Settings 部分
// 子导航与老路由重定向的接线测试在 app-center/AppCenterLayout.test.tsx。
//
// 覆盖四条硬口径:
//   ① 每个写动作都打到**契约里那一条**路径与 body(上架/下架/冻结/解冻/转移归属/
//      更新审批开关/审核通过/审核拒绝),不做本地伪造;
//   ② 权限是体验层:capa:write 缺席时写控件不渲染/禁用、且**不发**任何写请求
//      (服务端 RequirePermission 才是护栏,这里只是别让用户点出 403);
//   ③ **有代价的动作必须二次确认**(开/关更新审批、冻结)—— 点一下开关就直接发
//      写请求是本轮要修的形态,以下用例会拦回去;
//   ④ P1-7:搜索/状态筛选/分页都进查询串,"共 N 条"必须显示,分页之外的行可被检索。
// ---------------------------------------------------------------------------

const LIVE = {
  app_id: 'share-note', title: '共享便签', description: '团队共享的便签墙',
  owner: 'alice', enabled: true, access: 'login', purpose: '团队协作与周会记录',
  data_sensitivity: '内部', current_release_id: 12, current_version: '1.0.2',
  pending_releases: [] as string[], pending_count: 0,
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
/** 有待审积压的行(P0-1 的用途:审核开着时"谁在等审批"必须一眼可见)。 */
const REVIEWING = {
  ...LIVE, app_id: 'review-me', title: '待审应用', owner: 'dave',
  pending_releases: ['1.1.0', '1.2.0'], pending_count: 2,
}
/**
 * 软删行:服务端只在 `include_deleted=1`(或 `status=deleted`)时才下发
 * (admin.go 的 includeDeleted 判定) ⇒ 缺省列表里**不该出现**(R1-uxw-7)。
 */
const DELETED = {
  ...LIVE, app_id: 'gone-app', title: '已删除应用', owner: 'erin',
  enabled: false, current_release_id: 0, current_version: '',
  deleted_at: '2026-09-18T09:00:00Z',
}
const APP_LIST = [LIVE, OFF, FROZEN, REVIEWING]

/** 待审版本清单(GET /wasm-apps/:app_id/releases?status=pending)。 */
const PENDING_RELEASES = [
  {
    id: 21, version: '1.2.0', status: 'pending', title: '待审应用', publisher: 'dave',
    size: 2 * 1024 * 1024, checksum: 'ab12', changelog: '加了导出',
    created_at: '2026-09-19T02:00:00Z', current: false,
  },
]

/**
 * 被拒版本清单(GET …/releases?status=rejected) —— R1-uxw-4。
 *
 * 服务端 `admin.go` 的审批清单每行都下发 `reason`(非 rejected 行为空串);
 * 管理端此前拿不到它,拒绝理由只躺在审计详情里。
 */
const REJECTED_RELEASES = [
  {
    id: 20, version: '1.1.0', status: 'rejected', title: '待审应用', publisher: 'dave',
    size: 0, checksum: '', changelog: '',
    created_at: '2026-09-19T01:00:00Z', current: false,
    reason: '数据范围超出用途所需:请补充数据来源说明',
  },
]

/** 运行诊断(GET /wasm-apps/:app_id/diagnostics,与员工面同一份口径)。 */
const DIAGNOSTICS = {
  app_id: 'review-me', app_enabled: true, app_frozen: false, app_deleted: false, owner: 'dave',
  window_minutes: 1440, retention_days: 30,
  summary: {
    total: 12, ok: 9, error: 2, killed: 1, failed: 3,
    reasons: [{ reason_code: 'RUNTIME_TIMEOUT', count: 2, hints: ['把长任务拆成多次请求'] }],
    hints: ['把长任务拆成多次请求'], last_failure_at: '2026-09-19T01:00:00Z',
  },
  failures: [{
    created_at: '2026-09-19T01:00:00Z', outcome: 'error', reason_code: 'RUNTIME_TIMEOUT',
    guest_exit_code: 1, stderr_tail: 'boom', cpu_ms: 12, peak_memory_bytes: 2048,
  }],
  hints: ['把长任务拆成多次请求'],
}

const SUPER: MeUser = { role: 'super_admin', permissions: ['capability:read', 'capability:write'] }
/** 只有读权限(capability:write 缺席)= 只读视图。 */
const READONLY: MeUser = { role: 'user', permissions: ['capability:read'] }

const mockRequest = vi.mocked(request)

/** 列表数据源:分页/搜索用例会临时替换它(默认 = 4 行夹具)。 */
let appsFixture = APP_LIST

/** 抽屉里 `/releases` 回显的"当前生效版本"(审核通过后服务端会把它切到新版本)。 */
let pendingCurrentVersion = '1.0.2'

/** 按查询串在夹具上做过滤 + 分页(服务端口径的本地复刻,只用于断言 UI 行为)。 */
function listPage(params: URLSearchParams) {
  const limit = Number(params.get('limit') ?? 20)
  const offset = Number(params.get('offset') ?? 0)
  const q = (params.get('q') ?? '').toLowerCase()
  const status = params.get('status') ?? 'all'
  // 服务端语义(admin.go:93-95):include_deleted=1 或 status=deleted 才下发软删行。
  const includeDeleted =
    params.get('include_deleted') === '1' ||
    params.get('include_deleted') === 'true' ||
    status === 'deleted'
  let rows = includeDeleted ? appsFixture : appsFixture.filter((a) => a.deleted_at === null)
  if (q !== '') {
    rows = rows.filter((a) =>
      a.app_id.toLowerCase().includes(q) ||
      (a.title ?? '').toLowerCase().includes(q) ||
      (a.owner ?? '').toLowerCase().includes(q))
  }
  if (status === 'pending') rows = rows.filter((a) => (a.pending_count ?? 0) > 0)
  if (status === 'published') rows = rows.filter((a) => a.enabled && a.frozen_at === null && a.deleted_at === null)
  if (status === 'unpublished') rows = rows.filter((a) => !a.enabled && a.frozen_at === null && a.deleted_at === null)
  if (status === 'frozen') rows = rows.filter((a) => a.frozen_at !== null)
  if (status === 'deleted') rows = rows.filter((a) => a.deleted_at !== null)
  return {
    apps: rows.slice(offset, offset + limit),
    review_required: false,
    setting_key: 'wasm.review_required',
    pending_count: appsFixture.reduce((n, a) => n + (a.pending_count ?? 0), 0),
    total: rows.length,
    truncated: offset + limit < rows.length,
    limit,
    offset,
  }
}

beforeEach(() => {
  setCurrentAdmin(SUPER)
  appsFixture = APP_LIST
  pendingCurrentVersion = '1.0.2'
  mockRequest.mockReset()
  mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
    const base = String(path).split('?')[0]!
    const params = new URLSearchParams(String(path).split('?')[1] ?? '')
    if (base === '/api/server/admin/wasm-apps') return listPage(params)
    // 版本清单(审核闭环的数据面):服务端按 status 过滤,`reason` 每行都下发。
    // `status=rejected` 正是管理端「最近被拒」子清单的数据源(R1-uxw-4)。
    if (base.endsWith('/releases')) {
      const wanted = params.get('status') ?? 'pending'
      const releases = wanted === 'rejected'
        ? REJECTED_RELEASES
        : wanted === 'all' ? [...PENDING_RELEASES, ...REJECTED_RELEASES] : PENDING_RELEASES
      return {
        app_id: base.split('/')[4], status: wanted, current_version: pendingCurrentVersion,
        releases, pending_count: PENDING_RELEASES.length,
        review_required: true, setting_key: 'wasm.review_required',
      }
    }
    if (base.endsWith('/diagnostics')) return { diagnostics: DIAGNOSTICS }
    // 应用泛域名配置(GET 当前值 / PUT 保存后回读同一形状)。
    if (base === '/api/server/admin/wasm-apps/domain') {
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
    if (base === '/api/server/admin/wasm-apps/review') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { required?: boolean }
      return { review_required: body.required ?? true, changed: true, setting_key: 'wasm.review_required' }
    }
    if (base.endsWith('/unpublish')) return { app: { app_id: 'share-note', enabled: false, changed: true } }
    if (base.endsWith('/publish')) return { app: { app_id: 'ops-tool', enabled: true, changed: true } }
    if (base.endsWith('/freeze')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { frozen?: boolean }
      return body.frozen === false
        ? { app: { app_id: 'legacy-board', frozen: false, changed: true, enabled: false } }
        : { app: { app_id: 'share-note', frozen: true, changed: true, frozen_at: '2026-09-18T12:00:00Z', enabled: false } }
    }
    if (base.endsWith('/owner')) return { app: { app_id: 'share-note', owner: 'carol', changed: true } }
    if (base.endsWith('/approve')) return { app_id: 'review-me', version: '1.2.0', status: 'approved', changed: true, current_version: '1.2.0' }
    if (base.endsWith('/reject')) return { app_id: 'review-me', version: '1.2.0', status: 'rejected', changed: true, current_version: '1.0.2' }
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
  render(<Apps />)
  expect(await screen.findByText('共享便签')).toBeInTheDocument()
}

function rowOf(appId: string): HTMLElement {
  const cell = screen.getByText(appId)
  const tr = cell.closest('tr')
  if (tr === null) throw new Error(`未找到 ${appId} 所在的行`)
  return tr
}

/** 列表请求(带查询串的那一条)的调用参数。 */
function listCalls() {
  return mockRequest.mock.calls.filter(([p]) => String(p).startsWith('/api/server/admin/wasm-apps?'))
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

    // 访问级别:public/login/whitelist 各自的**中文**标签(按行断言:夹具里多行同级别)
    expect(within(rowOf('share-note')).getByText('登录后全员')).toBeInTheDocument()
    expect(within(rowOf('ops-tool')).getByText('白名单')).toBeInTheDocument()
    expect(within(rowOf('legacy-board')).getByText('公开')).toBeInTheDocument()

    // 负责人 + 当前版本(空串回落 '—')
    expect(screen.getByText('alice')).toBeInTheDocument()
    expect(screen.getByText('bob')).toBeInTheDocument()
    expect(screen.getByText('carol')).toBeInTheDocument()
    expect(within(rowOf('share-note')).getByText('1.0.2')).toBeInTheDocument()
    expect(within(rowOf('ops-tool')).getByText('0.9.0')).toBeInTheDocument()

    // 状态:上架 / 已下架 / 已冻结(冻结优先于 enabled)
    expect(within(rowOf('share-note')).getByText('上架')).toBeInTheDocument()
    expect(within(rowOf('ops-tool')).getByText('已下架')).toBeInTheDocument()
    expect(within(rowOf('legacy-board')).getByText('已冻结')).toBeInTheDocument()
    // 冻结行虽然有 frozen_at,但按钮必须给「解冻」而不是「冻结」
    expect(within(rowOf('legacy-board')).getByRole('button', { name: '解冻' })).toBeInTheDocument()
  })

  it('点「下架」→ POST /wasm-apps/<id>/unpublish，并按响应把该行切回「上架」', async () => {
    await renderList()
    fireEvent.click(within(rowOf('share-note')).getByRole('button', { name: '下架' }))
    // R1-uxw-13:下架现在必须过二次确认(确认前不发请求)。
    fireEvent.click(await screen.findByTestId('unpublish-confirm'))
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

  // -------------------------------------------------------------------------
  // F2（审计第二轮 A2-F2）：上下架的回填此前在响应缺 `enabled` 时回落到**乐观值**
  // `next`，于是一个不带该字段的 200 就把行翻成「已下架」；而同一文件的冻结路径
  // 写着"响应缺字段时不臆测"。以下两条钉住"只认服务端回填"。
  // -------------------------------------------------------------------------

  it('上下架响应缺 enabled ⇒ 不臆测：行状态保持不变(F2)', async () => {
    mockRequest.mockImplementation(async (path: string) => {
      const base = String(path).split('?')[0]!
      if (base === '/api/server/admin/wasm-apps') return listPage(new URLSearchParams())
      // 200 但没有 enabled（旧实现 ⇒ 乐观值 true ⇒ 行被翻成「上架」）
      if (base.endsWith('/publish')) return { app: { app_id: 'ops-tool', changed: true } }
      throw new Error(`unexpected ${path}`)
    })
    await renderList()
    fireEvent.click(within(rowOf('ops-tool')).getByRole('button', { name: '上架' }))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith(
        '/api/server/admin/wasm-apps/ops-tool/publish',
        { method: 'POST' },
      )
    })
    await waitFor(() => {
      expect(within(rowOf('ops-tool')).getByText('已下架')).toBeInTheDocument()
      expect(within(rowOf('ops-tool')).queryByRole('button', { name: '下架' })).toBeNull()
    })
  })

  it('上下架以服务端回填为准（与乐观值相反时听服务端的）', async () => {
    mockRequest.mockImplementation(async (path: string) => {
      const base = String(path).split('?')[0]!
      if (base === '/api/server/admin/wasm-apps') return listPage(new URLSearchParams())
      // 乐观值 = !false = true，服务端却回 false ⇒ 必须显示「已下架」
      if (base.endsWith('/publish')) return { app: { app_id: 'ops-tool', enabled: false, changed: true } }
      throw new Error(`unexpected ${path}`)
    })
    await renderList()
    fireEvent.click(within(rowOf('ops-tool')).getByRole('button', { name: '上架' }))
    await waitFor(() => {
      expect(within(rowOf('ops-tool')).getByText('已下架')).toBeInTheDocument()
      expect(within(rowOf('ops-tool')).queryByRole('button', { name: '下架' })).toBeNull()
    })
  })

  it('上下架请求失败 ⇒ 界面不呈现未落库的状态（结果级断言，不是"存在某个元素"）', async () => {
    mockRequest.mockImplementation(async (path: string) => {
      const base = String(path).split('?')[0]!
      if (base === '/api/server/admin/wasm-apps') return listPage(new URLSearchParams())
      if (base.endsWith('/publish')) throw new ApiError(500, 'INTERNAL', '上架失败:数据库不可达')
      throw new Error(`unexpected ${path}`)
    })
    await renderList()
    fireEvent.click(within(rowOf('ops-tool')).getByRole('button', { name: '上架' }))

    // 失败 = 什么都没有落库 ⇒ 行必须**仍是**「已下架」（按钮仍是「上架」），
    // 而不是先把乐观值画上去再撤销（那正是"界面呈现未落库状态"）。
    expect(await screen.findByTestId('apps-error')).toHaveTextContent('数据库不可达')
    const row = rowOf('ops-tool')
    expect(within(row).getByText('已下架')).toBeInTheDocument()
    expect(within(row).queryByRole('button', { name: '下架' })).toBeNull()
  })

  it('冻结必须先确认(P2-6):确认框列出停服/保留期/到期/解冻,确认后才发请求', async () => {
    await renderList()

    fireEvent.click(within(rowOf('share-note')).getByRole('button', { name: '冻结' }))
    // 未确认前**一个写请求都不能发**(单击即生效是本次要修的形态)
    const dialog = await screen.findByTestId('freeze-confirm-dialog')
    expect(mockRequest).not.toHaveBeenCalledWith(
      '/api/server/admin/wasm-apps/share-note/freeze',
      expect.anything(),
    )
    // 文案必须写清代价,否则"确认"只是个形式
    for (const t of ['立即停服', '数据保留', '到期处理', '如何解冻']) {
      expect(dialog).toHaveTextContent(t)
    }

    fireEvent.click(screen.getByTestId('freeze-confirm'))
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
  })

  it('取消冻结确认框 → 不发任何写请求', async () => {
    await renderList()
    fireEvent.click(within(rowOf('share-note')).getByRole('button', { name: '冻结' }))
    await screen.findByTestId('freeze-confirm-dialog')
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    const writes = mockRequest.mock.calls.filter(([, init]) => {
      const m = (init as RequestInit | undefined)?.method
      return m !== undefined && m !== 'GET' && m !== 'HEAD'
    })
    expect(writes).toEqual([])
  })

  it('解冻不确认,直接提交 {"frozen":false}', async () => {
    await renderList()
    fireEvent.click(within(rowOf('legacy-board')).getByRole('button', { name: '解冻' }))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith(
        '/api/server/admin/wasm-apps/legacy-board/freeze',
        { method: 'POST', body: JSON.stringify({ frozen: false }) },
      )
    })
  })

  it('冻结行的「上架」按钮禁用(P2-6:交付面一律 404,上架没有意义)', async () => {
    await renderList()
    // 夹具里 legacy-board 已冻结且 enabled=false ⇒ 按钮文字是「上架」
    const btn = within(rowOf('legacy-board')).getByRole('button', { name: '上架' }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(btn.getAttribute('title')).toContain('冻结')
    fireEvent.click(btn)
    expect(mockRequest).not.toHaveBeenCalledWith(
      '/api/server/admin/wasm-apps/legacy-board/publish',
      expect.anything(),
    )
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
    render(<Apps />)
    expect(await screen.findByText('服务暂时不可用,请稍后再试')).toBeInTheDocument()
    expect(screen.queryByText('暂无应用')).toBeNull()
  })

  it('写操作失败时给出可见错误提示,且不伪造成功状态', async () => {
    mockRequest.mockImplementation(async (path: string) => {
      if (String(path).startsWith('/api/server/admin/wasm-apps?')) return listPage(new URLSearchParams())
      throw new Error('下架失败:应用已被冻结')
    })
    await renderList()
    fireEvent.click(within(rowOf('share-note')).getByRole('button', { name: '下架' }))
    // R1-uxw-13:下架是影响全部使用者的危险动作,现在必须过二次确认(确认前不发请求)。
    fireEvent.click(await screen.findByTestId('unpublish-confirm'))
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

  it('详情对话框展示 purpose/数据敏感度/版本 id/创建与更新时间/描述 + 当前生效版本', async () => {
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
    appsFixture = []
    render(<Apps />)
    expect(await screen.findByText('暂无应用')).toBeInTheDocument()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('刷新按钮重新拉取列表', async () => {
    await renderList()
    const before = listCalls().length
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await waitFor(() => {
      expect(listCalls().length).toBe(before + 1)
    })
  })

  it('路由接线:nav 的 /app-center 在 App 里确实有条路由(懒加载页面可渲染)', async () => {
    // 光跑 build 只能证明 chunk 能解析,证不了 nav.to 与 Route path 是同一个字符串
    // —— 那条只有整树渲染才能钉住。App 自带 BrowserRouter(basename=/admin)。
    // 子路由(limits/settings)与 /app-platform 重定向见 app-center/AppCenterLayout.test.tsx。
    window.history.pushState({}, '', '/admin/app-center')
    vi.mocked(me).mockResolvedValue({ user: SUPER })
    // useChannel() 走原生 fetch(公开渠道端点);jsdom 里给个空渠道内容。
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', {
      status: 200, headers: { 'content-type': 'application/json' },
    })))
    const App = (await import('../App')).default
    render(<App />)
    // 页面 h1 渲染 = 路由命中 + 懒加载 chunk 就绪(索引页 = 应用列表)
    expect(await screen.findByRole('heading', { name: '应用' })).toBeInTheDocument()
    // 侧栏入口指向同一路径(声明与路由漂移会在这里红)
    expect(screen.getByRole('link', { name: '应用中心' })).toHaveAttribute('href', '/admin/app-center')
    // 「应用平台」不再是侧栏条目(已并入应用中心,只剩老书签重定向)
    expect(screen.queryByRole('link', { name: '应用平台' })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 审核闭环(P0-1 的服务端已就绪,前端此前一行未接):
//   列表徽标 + 状态筛选 + 详情抽屉的待审清单与「通过/拒绝」。
// ---------------------------------------------------------------------------

describe('应用中心 · 更新审批闭环', () => {
  it('有待审版本的行显示「待审批 N」徽标,没有的行不显示', async () => {
    await renderList()
    const badge = within(rowOf('review-me')).getByTestId('pending-badge')
    expect(badge).toHaveTextContent('待审批 2')
    // 徽标 title 里给出具体版本号(管理员不必点开就知道在等哪个版本)
    expect(badge.getAttribute('title')).toContain('1.2.0')
    expect(within(rowOf('share-note')).queryByTestId('pending-badge')).toBeNull()
  })

  it('顶部显示全组织待审积压(与分页无关)', async () => {
    await renderList()
    expect(screen.getByTestId('org-pending-count')).toHaveTextContent('待审 2')
  })

  it('状态筛选「待审批」→ 请求带 status=pending,且只留下有待审的行', async () => {
    await renderList()
    fireEvent.click(screen.getByRole('combobox', { name: '状态筛选' }))
    fireEvent.click(await screen.findByRole('option', { name: '待审批' }))

    await waitFor(() => {
      const withStatus = listCalls().filter(([p]) => String(p).includes('status=pending'))
      expect(withStatus.length, '必须发出带 status=pending 的列表请求').toBeGreaterThan(0)
    })
    await waitFor(() => {
      expect(screen.getByText('待审应用')).toBeInTheDocument()
      expect(screen.queryByText('共享便签')).toBeNull()
    })
  })

  it('详情抽屉渲染待审版本(版本号/提交人/时间/体积/当前生效版本)', async () => {
    await renderList()
    fireEvent.click(within(rowOf('review-me')).getByRole('button', { name: '详情' }))

    const block = await screen.findByTestId('pending-block')
    // 必须真的按契约路径取待审清单(而不是复用列表行里的版本号数组)
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith(
        '/api/server/admin/wasm-apps/review-me/releases?status=pending',
      )
    })
    expect(await within(block).findByTestId('pending-list')).toHaveTextContent('v1.2.0')
    expect(block).toHaveTextContent('dave')
    expect(block).toHaveTextContent('2.0 MiB')
    expect(block).toHaveTextContent('当前生效版本')
    expect(block).toHaveTextContent('1.0.2')
    expect(block).toHaveTextContent('加了导出')
  })

  it('详情抽屉渲染「最近被拒」版本与**驳回理由**(R1-uxw-4:理由此前只躺在审计详情里)', async () => {
    await renderList()
    fireEvent.click(within(rowOf('review-me')).getByRole('button', { name: '详情' }))

    const block = await screen.findByTestId('rejected-block')
    // 必须真的按 status=rejected 取一次(而不是把待审队列当成被拒队列)。
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith(
        '/api/server/admin/wasm-apps/review-me/releases?status=rejected',
      )
    })
    // 行 + 理由都在(理由就是这条缺陷的判据:写了必须有人读)。
    expect(await within(block).findByTestId('rejected-list')).toHaveTextContent('v1.1.0')
    expect(within(block).getByTestId('rejected-reason-1.1.0')).toHaveTextContent('数据范围超出用途所需')
    expect(block).toHaveTextContent('dave')
    // 待审队列与被拒清单是两份数据:待审那一版不得混进被拒清单。
    expect(within(block).queryByTestId('rejected-1.2.0')).toBeNull()
  })

  it('没有可回看的结论时给出空态(不是错误,也不是"理由为空"的行)', async () => {
    mockRequest.mockImplementation(async (path: string) => {
      const base = String(path).split('?')[0]!
      if (base === '/api/server/admin/wasm-apps') return listPage(new URLSearchParams())
      if (base.endsWith('/releases')) {
        return { app_id: 'review-me', status: 'rejected', current_version: '1.0.2', releases: [], pending_count: 0, review_required: true, setting_key: 'wasm.review_required' }
      }
      if (base.endsWith('/diagnostics')) return { diagnostics: DIAGNOSTICS }
      throw new Error(`unexpected ${path}`)
    })
    await renderList()
    fireEvent.click(within(rowOf('review-me')).getByRole('button', { name: '详情' }))
    const block = await screen.findByTestId('rejected-block')
    expect(await within(block).findByTestId('rejected-empty')).toHaveTextContent('没有被拒的版本')
    expect(within(block).queryByTestId('rejected-list')).toBeNull()
    expect(within(block).queryByTestId('rejected-error')).toBeNull()
  })

  // -------------------------------------------------------------------------
  // F6（审计第二轮 A2-F6）：`out.releases ?? []` 会把"响应里没有版本清单"渲染成
  // "没有被拒的版本。"（对管理员是假陈述）。客户端半边 `app-releases.ts` 对同一份
  // 响应是结构化失败 ⇒ 管理端必须与它同口径：明说读失败，不显示空态。
  // -------------------------------------------------------------------------

  it('被拒清单响应缺 releases ⇒ 明说读取失败，不显示"没有被拒的版本"(F6)', async () => {
    mockRequest.mockImplementation(async (path: string) => {
      const full = String(path)
      const base = full.split('?')[0]!
      if (base === '/api/server/admin/wasm-apps') return listPage(new URLSearchParams())
      if (base.includes('/releases')) {
        // 形状漂移：200，但 releases 键缺席；待审那条走正常形状，免得两块错误互相掩盖。
        return full.includes('status=rejected')
          ? { app_id: 'review-me', status: 'rejected', current_version: '1.0.2', pending_count: 0 }
          : { app_id: 'review-me', status: 'pending', current_version: '1.0.2', releases: PENDING_RELEASES, pending_count: 1 }
      }
      if (base.endsWith('/diagnostics')) return { diagnostics: DIAGNOSTICS }
      throw new Error(`unexpected ${path}`)
    })
    await renderList()
    fireEvent.click(within(rowOf('review-me')).getByRole('button', { name: '详情' }))
    const block = await screen.findByTestId('rejected-block')
    expect(await within(block).findByTestId('rejected-error')).toHaveTextContent('没有版本清单')
    expect(within(block).queryByTestId('rejected-empty')).toBeNull()
  })

  it('待审清单响应缺 releases ⇒ 同样明说读取失败，不显示"没有待审版本"(F6)', async () => {
    mockRequest.mockImplementation(async (path: string) => {
      const full = String(path)
      const base = full.split('?')[0]!
      if (base === '/api/server/admin/wasm-apps') return listPage(new URLSearchParams())
      if (base.includes('/releases')) {
        return full.includes('status=rejected')
          ? { app_id: 'review-me', status: 'rejected', current_version: '1.0.2', releases: REJECTED_RELEASES, pending_count: 0 }
          : { app_id: 'review-me', status: 'pending', current_version: '1.0.2', pending_count: 1 }
      }
      if (base.endsWith('/diagnostics')) return { diagnostics: DIAGNOSTICS }
      throw new Error(`unexpected ${path}`)
    })
    await renderList()
    fireEvent.click(within(rowOf('review-me')).getByRole('button', { name: '详情' }))
    expect(await screen.findByTestId('pending-error')).toHaveTextContent('没有版本清单')
    expect(screen.queryByTestId('pending-empty')).toBeNull()
  })

  it('点「通过」→ POST .../releases/<version>/approve,并刷新列表与待审清单', async () => {
    await renderList()
    fireEvent.click(within(rowOf('review-me')).getByRole('button', { name: '详情' }))
    const approve = await screen.findByTestId('pending-approve-1.2.0')

    const listBefore = listCalls().length
    const releasesBefore = mockRequest.mock.calls.filter(([p]) => String(p).includes('/releases')).length
    fireEvent.click(approve)

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith(
        '/api/server/admin/wasm-apps/review-me/releases/1.2.0/approve',
        { method: 'POST' },
      )
    })
    // 成功后刷新列表 + 抽屉(P0-1 要求"成功后刷新",否则界面停在过期的积压数上)
    await waitFor(() => {
      expect(listCalls().length).toBeGreaterThan(listBefore)
      expect(mockRequest.mock.calls.filter(([p]) => String(p).includes('/releases')).length)
        .toBeGreaterThan(releasesBefore)
    })
  })

  it('拒绝:弹窗可填理由,提交 POST .../releases/<version>/reject 且 body 带理由', async () => {
    await renderList()
    fireEvent.click(within(rowOf('review-me')).getByRole('button', { name: '详情' }))
    fireEvent.click(await screen.findByTestId('pending-reject-1.2.0'))

    const reason = await screen.findByTestId('reject-reason')
    fireEvent.change(reason, { target: { value: '数据范围超出用途所需' } })
    fireEvent.click(screen.getByTestId('reject-submit'))

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith(
        '/api/server/admin/wasm-apps/review-me/releases/1.2.0/reject',
        { method: 'POST', body: JSON.stringify({ reason: '数据范围超出用途所需' }) },
      )
    })
  })

  it('拒绝理由长度上限 200:输入框硬限长,超限时提交按钮禁用', async () => {
    await renderList()
    fireEvent.click(within(rowOf('review-me')).getByRole('button', { name: '详情' }))
    fireEvent.click(await screen.findByTestId('pending-reject-1.2.0'))

    const reason = (await screen.findByTestId('reject-reason')) as HTMLTextAreaElement
    // 与服务端 maxReviewReasonLen 同一口径(硬限长 + 计数提示)
    expect(reason.maxLength).toBe(200)

    // jsdom 的 fireEvent.change 会绕过 maxLength —— 正好用来验证按钮的兜底闸门
    fireEvent.change(reason, { target: { value: 'x'.repeat(201) } })
    expect((screen.getByTestId('reject-submit') as HTMLButtonElement).disabled).toBe(true)
    // 超限时点不动 ⇒ 不会把一个注定 400 的请求发出去
    fireEvent.click(screen.getByTestId('reject-submit'))
    expect(mockRequest).not.toHaveBeenCalledWith(
      '/api/server/admin/wasm-apps/review-me/releases/1.2.0/reject',
      expect.anything(),
    )

    fireEvent.change(reason, { target: { value: 'x'.repeat(200) } })
    expect((screen.getByTestId('reject-submit') as HTMLButtonElement).disabled).toBe(false)
  })

  it('只读账号:待审清单可见,但通过/拒绝按钮**禁用而不是隐藏**', async () => {
    setCurrentAdmin(READONLY)
    await renderList()
    fireEvent.click(within(rowOf('review-me')).getByRole('button', { name: '详情' }))

    const approve = (await screen.findByTestId('pending-approve-1.2.0')) as HTMLButtonElement
    const reject = screen.getByTestId('pending-reject-1.2.0') as HTMLButtonElement
    // 队列本身是只读信息(谁在等审批),按钮消失会让只读账号以为"没有待审"
    expect(approve.disabled).toBe(true)
    expect(reject.disabled).toBe(true)
    fireEvent.click(approve)
    expect(mockRequest).not.toHaveBeenCalledWith(
      '/api/server/admin/wasm-apps/review-me/releases/1.2.0/approve',
      expect.anything(),
    )
  })

  it('审核请求失败时把服务端的 hints 与字段一起显示(不放一句"失败"了事)', async () => {
    mockRequest.mockImplementation(async (path: string) => {
      const base = String(path).split('?')[0]!
      if (base === '/api/server/admin/wasm-apps') return listPage(new URLSearchParams())
      if (base.endsWith('/releases')) {
        return { app_id: 'review-me', status: 'pending', current_version: '1.0.2', releases: PENDING_RELEASES, pending_count: 1 }
      }
      if (base.endsWith('/diagnostics')) return { diagnostics: DIAGNOSTICS }
      if (base.endsWith('/approve')) {
        throw new ApiError(403, 'FORBIDDEN', '没有权限执行该操作', undefined, ['需要 capability:write 权限'])
      }
      return {}
    })
    await renderList()
    fireEvent.click(within(rowOf('review-me')).getByRole('button', { name: '详情' }))
    fireEvent.click(await screen.findByTestId('pending-approve-1.2.0'))
    // R1-uxw-1:审核成败反馈渲染在**对话框内部**(detail-feedback) —— 页面级的
    // apps-error 会被 Radix 的整屏遮罩压住,管理员看到的是"点了没反应"。
    expect(await screen.findByTestId('detail-feedback')).toHaveTextContent('需要 capability:write 权限')
  })

  it('列表错误信封的 hints 与 details.field 都被渲染(P1-6)', async () => {
    mockRequest.mockImplementation(async () => {
      // 真实信封形状:{"error":{code,message,details,hints}}
      throw new ApiError(400, 'VALIDATION', 'status 取值不合法', undefined, ['待审批队列用 status=pending'], { field: 'status' })
    })
    render(<Apps />)
    // R1-uxw-2:列表读取失败是页面级确定态,渲染在 apps-load-error(且不渲染任何行)。
    const err = await screen.findByTestId('apps-load-error')
    expect(err).toHaveTextContent('status 取值不合法')
    expect(err).toHaveTextContent('字段 status')
    expect(err).toHaveTextContent('待审批队列用 status=pending')
  })
})

// ---------------------------------------------------------------------------
// 更新审批开关的二次确认(P1-6 的一部分:开关改变的是**全组织**的发布行为,
// 单击即生效没有代价提示)。
// ---------------------------------------------------------------------------

describe('应用中心 · 更新审批开关二次确认', () => {
  it('点开关先弹确认框(说明代价),确认后才 PUT required:true', async () => {
    await renderList()
    const sw = screen.getByRole('switch', { name: '更新审批' })
    expect(sw).toHaveAttribute('data-state', 'unchecked')

    fireEvent.click(sw)
    const dialog = await screen.findByTestId('review-confirm-dialog')
    // 未确认前一个写请求都不能发
    expect(mockRequest).not.toHaveBeenCalledWith(
      '/api/server/admin/wasm-apps/review',
      expect.anything(),
    )
    // 文案必须写清代价:新版本会停在待审、需要审批才能上线
    expect(dialog).toHaveTextContent('停在「待审批」状态')
    expect(dialog).toHaveTextContent('需要管理员')
    // 已有积压时显示积压数
    expect(screen.getByTestId('review-pending-warning')).toHaveTextContent('2 个待审版本')

    fireEvent.click(screen.getByTestId('review-confirm'))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith(
        '/api/server/admin/wasm-apps/review',
        { method: 'PUT', body: JSON.stringify({ required: true }) },
      )
    })
    await waitFor(() => {
      expect(screen.getByRole('switch', { name: '更新审批' })).toHaveAttribute('data-state', 'checked')
    })
  })

  it('确认框取消 → 开关不动、不发请求', async () => {
    await renderList()
    fireEvent.click(screen.getByRole('switch', { name: '更新审批' }))
    await screen.findByTestId('review-confirm-dialog')
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    const writes = mockRequest.mock.calls.filter(([, init]) => {
      const m = (init as RequestInit | undefined)?.method
      return m !== undefined && m !== 'GET' && m !== 'HEAD'
    })
    expect(writes).toEqual([])
    expect(screen.getByRole('switch', { name: '更新审批' })).toHaveAttribute('data-state', 'unchecked')
  })

  it('关闭开关也要确认:明确说明已 pending 的版本不会自动转正', async () => {
    // 夹具改为"当前已开启",这样点开关是关闭方向。
    appsFixture = APP_LIST
    mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      const base = String(path).split('?')[0]!
      const params = new URLSearchParams(String(path).split('?')[1] ?? '')
      if (base === '/api/server/admin/wasm-apps') return { ...listPage(params), review_required: true }
      if (base.endsWith('/releases')) {
        return { app_id: 'review-me', status: 'pending', current_version: '1.0.2', releases: PENDING_RELEASES, pending_count: 1 }
      }
      if (base.endsWith('/diagnostics')) return { diagnostics: DIAGNOSTICS }
      if (base === '/api/server/admin/wasm-apps/review') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { required?: boolean }
        return { review_required: body.required ?? false, changed: true, setting_key: 'wasm.review_required' }
      }
      return {}
    })
    render(<Apps />)
    await screen.findByText('共享便签')
    const sw = screen.getByRole('switch', { name: '更新审批' })
    expect(sw).toHaveAttribute('data-state', 'checked')

    fireEvent.click(sw)
    const dialog = await screen.findByTestId('review-confirm-dialog')
    expect(dialog).toHaveTextContent('关闭')
    expect(screen.getByTestId('review-close-warning')).toHaveTextContent('不会')
    expect(screen.getByTestId('review-close-warning')).toHaveTextContent('重新发布')

    fireEvent.click(screen.getByTestId('review-confirm'))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith(
        '/api/server/admin/wasm-apps/review',
        { method: 'PUT', body: JSON.stringify({ required: false }) },
      )
    })
  })
})

// ---------------------------------------------------------------------------
// 搜索 / 状态筛选 / 分页(P1-7:此前前端不带任何参数,第 201 个应用查不到,
// 页面也看不出列表被截断)
// ---------------------------------------------------------------------------

describe('应用中心 · 搜索与分页', () => {
  /** 25 行(> 一页 20 行):第 25 行只有在翻页或搜索时才拿得到。 */
  function bulkFixture(n = 25) {
    return Array.from({ length: n }, (_, i) => ({
      ...LIVE,
      app_id: `bulk-${String(i).padStart(2, '0')}`,
      title: `批量应用 ${String(i).padStart(2, '0')}`,
      owner: i === n - 1 ? 'zeta-owner' : 'alice',
    }))
  }

  it('显式显示"共 N 条 / 当前显示第几到第几条"', async () => {
    appsFixture = bulkFixture()
    render(<Apps />)
    await screen.findByText('批量应用 00')
    expect(screen.getByTestId('app-total')).toHaveTextContent('共 25 条')
    expect(screen.getByTestId('app-total')).toHaveTextContent('第 1–20 条')
  })

  it('翻页把 offset 带进查询串,并显示第 21–25 条', async () => {
    appsFixture = bulkFixture()
    render(<Apps />)
    await screen.findByText('批量应用 00')

    fireEvent.click(screen.getByTestId('app-next-page'))
    await waitFor(() => {
      expect(listCalls().some(([p]) => String(p).includes('offset=20'))).toBe(true)
    })
    // 第 25 行(分页之外的那一条)出现在第二页
    expect(await screen.findByText('批量应用 24')).toBeInTheDocument()
    expect(screen.getByTestId('app-total')).toHaveTextContent('第 21–25 条')
    expect((screen.getByTestId('app-next-page') as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(screen.getByTestId('app-prev-page'))
    await waitFor(() => {
      expect(listCalls().some(([p]) => String(p).includes('offset=0'))).toBe(true)
    })
  })

  it('搜索把 q 带进查询串,并回到第一页(能捞到分页之外的应用)', async () => {
    appsFixture = bulkFixture()
    render(<Apps />)
    await screen.findByText('批量应用 00')
    // 先翻到第二页,验证"换搜索词会回到第一页"
    fireEvent.click(screen.getByTestId('app-next-page'))
    await screen.findByText('批量应用 24')

    fireEvent.change(screen.getByTestId('app-search'), { target: { value: 'zeta-owner' } })
    fireEvent.click(screen.getByTestId('app-search-submit'))

    await waitFor(() => {
      const hit = listCalls().find(([p]) => String(p).includes('q=zeta-owner'))
      expect(hit, '必须发出带 q= 的列表请求').toBeTruthy()
      expect(String(hit![0])).toContain('offset=0')
    })
    expect(await screen.findByText('批量应用 24')).toBeInTheDocument()
    expect(screen.queryByText('批量应用 00')).toBeNull()
    expect(screen.getByTestId('app-total')).toHaveTextContent('共 1 条')
  })

  it('清除筛选恢复全量列表', async () => {
    appsFixture = bulkFixture()
    render(<Apps />)
    await screen.findByText('批量应用 00')
    fireEvent.change(screen.getByTestId('app-search'), { target: { value: 'bulk-07' } })
    fireEvent.click(screen.getByTestId('app-search-submit'))
    await screen.findByText('批量应用 07')

    fireEvent.click(screen.getByTestId('app-clear-filters'))
    expect(await screen.findByText('批量应用 00')).toBeInTheDocument()
    expect(screen.getByTestId('app-total')).toHaveTextContent('共 25 条')
  })

  it('搜不到时给出"没有匹配的应用"而不是"暂无应用"', async () => {
    await renderList()
    fireEvent.change(screen.getByTestId('app-search'), { target: { value: '不存在的名字' } })
    fireEvent.click(screen.getByTestId('app-search-submit'))
    expect(await screen.findByText('没有匹配的应用')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// 运行诊断(P1-9:平台有 diag 能力,但管理端此前零入口)
// ---------------------------------------------------------------------------

describe('应用中心 · 运行诊断', () => {
  it('详情抽屉渲染失败码计数、hints 与最近失败时间线', async () => {
    await renderList()
    fireEvent.click(within(rowOf('review-me')).getByRole('button', { name: '详情' }))

    const block = await screen.findByTestId('diag-block')
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('/api/server/admin/wasm-apps/review-me/diagnostics')
    })
    expect(await within(block).findByTestId('diag-reasons')).toHaveTextContent('RUNTIME_TIMEOUT')
    expect(within(block).getByTestId('diag-reasons')).toHaveTextContent('× 2')
    // hints 是"下一步改什么",必须原样显示
    expect(within(block).getByTestId('diag-hints')).toHaveTextContent('把长任务拆成多次请求')
    // 时间线(最近失败)
    expect(within(block).getByTestId('diag-failures')).toHaveTextContent('RUNTIME_TIMEOUT')
    expect(block).toHaveTextContent('失败 3')
  })

  it('没有失败记录时说明"没有失败",而不是留一片空白', async () => {
    mockRequest.mockImplementation(async (path: string) => {
      const base = String(path).split('?')[0]!
      if (base === '/api/server/admin/wasm-apps') return listPage(new URLSearchParams())
      if (base.endsWith('/releases')) {
        return { app_id: 'review-me', status: 'pending', current_version: '', releases: [], pending_count: 0 }
      }
      if (base.endsWith('/diagnostics')) {
        return {
          diagnostics: {
            ...DIAGNOSTICS,
            summary: { ...DIAGNOSTICS.summary, failed: 0, error: 0, killed: 0, reasons: [], hints: [] },
            failures: [], hints: [],
          },
        }
      }
      return {}
    })
    await renderList()
    fireEvent.click(within(rowOf('share-note')).getByRole('button', { name: '详情' }))
    expect(await screen.findByTestId('diag-empty')).toHaveTextContent('没有失败记录')
  })

  it('诊断读取失败时给出可读错误(不静默留空)', async () => {
    mockRequest.mockImplementation(async (path: string) => {
      const base = String(path).split('?')[0]!
      if (base === '/api/server/admin/wasm-apps') return listPage(new URLSearchParams())
      if (base.endsWith('/releases')) {
        return { app_id: 'share-note', status: 'pending', current_version: '', releases: [], pending_count: 0 }
      }
      if (base.endsWith('/diagnostics')) {
        throw new ApiError(403, 'FORBIDDEN', '没有权限执行该操作', undefined, ['需要 capability:read 权限'])
      }
      return {}
    })
    await renderList()
    fireEvent.click(within(rowOf('share-note')).getByRole('button', { name: '详情' }))
    const err = await screen.findByTestId('diag-error')
    expect(err).toHaveTextContent('需要 capability:read 权限')
  })
})

// ---------------------------------------------------------------------------
// 应用中心 · 设置页:应用域名(泛域名)配置,应用名 + 该域名 = 应用访问地址
// (2026-09-18 用户要求;2026-09-19 从应用中心首页顶部卡片搬进独立设置页)
// ---------------------------------------------------------------------------

describe('应用中心 · 设置(应用域名/泛域名)', () => {
  it('展示当前基域、来源与"应用名.域名"模板', async () => {
    render(<Settings />)
    const input = await screen.findByLabelText('应用域名')
    expect((input as HTMLInputElement).value).toBe('apps.example.com')
    // 文本是"来源：控制台配置"整体（同一 span），用正则匹配子串。
    expect(await screen.findByText(/控制台配置/)).toBeTruthy()
    expect(await screen.findByText('https://<app_id>.apps.example.com')).toBeTruthy()
    // 提示里必须写明"填主域名、不要填通配符",否则管理员八成会填 *.example.com。
    expect(screen.getByText(/不要填/)).toBeTruthy()
  })

  it('保存 → PUT /wasm-apps/domain，body 是 {"base_domain": …}', async () => {
    render(<Settings />)
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

  it('关闭应用子域:先二次确认(R1-uxw-13),确认后 PUT 传空串(不是删除字段)', async () => {
    render(<Settings />)
    await screen.findByLabelText('应用域名')
    fireEvent.click(screen.getByRole('button', { name: '关闭应用子域' }))

    // 关闭 = 清空基域 ⇒ 全部应用域名当场失效(与"下架"同级的可见性破坏),
    // 因此必须与冻结/下架同一套确认语义:说清影响谁 + 数据是否保留 + 如何回滚。
    const dialog = await screen.findByTestId('close-domain-confirm-dialog')
    expect(dialog).toHaveTextContent('全部应用域名立即失效')
    expect(dialog).toHaveTextContent('应用与数据不受影响')
    expect(dialog).toHaveTextContent('如何回滚')

    // 确认前**零写请求**(单击即生效正是本次要修的形态)
    const writesBefore = mockRequest.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method && (init as RequestInit).method !== 'GET',
    )
    expect(writesBefore).toEqual([])

    fireEvent.click(screen.getByTestId('close-domain-confirm'))
    await waitFor(() => {
      const hit = mockRequest.mock.calls.find(
        ([p, init]) => p === '/api/server/admin/wasm-apps/domain' && (init as RequestInit | undefined)?.method === 'PUT',
      )
      expect(hit, '关闭也必须显式发请求').toBeTruthy()
      expect(JSON.parse(String((hit![1] as RequestInit).body))).toEqual({ base_domain: '' })
    })
  })

  it('关闭应用子域的确认框可以取消:零写请求、域名不动', async () => {
    render(<Settings />)
    const input = (await screen.findByLabelText('应用域名')) as HTMLInputElement
    fireEvent.click(screen.getByRole('button', { name: '关闭应用子域' }))
    const dialog = await screen.findByTestId('close-domain-confirm-dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))

    const writes = mockRequest.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method && (init as RequestInit).method !== 'GET',
    )
    expect(writes).toEqual([])
    expect(input.value).toBe('apps.example.com')
  })

  it('保存被服务端拒绝(真实信封带 hints + details) → 原样显示 message + hints', async () => {
    mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/server/admin/wasm-apps/domain' && (init as RequestInit | undefined)?.method === 'PUT') {
        // 真实信封形状(不再手工挂属性:那样 api.ts 改错也测不出来,P1-6 的假绿)
        throw new ApiError(
          400, 'VALIDATION',
          '已启用应用子域，但未配置 PICOAI_TRUSTED_PROXIES',
          undefined,
          ['在部署 .env 里显式写出前置反向代理的地址'],
          { field: 'base_domain' },
        )
      }
      if (path === '/api/server/admin/wasm-apps/domain') {
        return { base_domain: '', source: 'none', enabled: false, url_pattern: '', setting_key: 'wasm.apps_base_domain' }
      }
      return {}
    })
    render(<Settings />)
    const input = await screen.findByLabelText('应用域名')
    fireEvent.change(input, { target: { value: 'apps.example.com' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText(/未配置 PICOAI_TRUSTED_PROXIES/)).toBeTruthy()
    expect(await screen.findByText(/前置反向代理的地址/)).toBeTruthy()
    expect(await screen.findByText(/字段 base_domain/)).toBeTruthy()
  })

  it('读取配置失败 → 页面级错误 + 重试(不再局部静默)', async () => {
    // 行为变化(2026-09-19 搬进设置页):原来域名 GET 失败只在卡片里显示一行局部错误、
    // 页面其余部分照常渲染;设置页只有这一件事 —— 读不到就是整页不可用 + 可重试。
    mockRequest.mockImplementation(async () => {
      throw new Error('服务暂时不可用,请稍后再试')
    })
    render(<Settings />)
    expect(await screen.findByTestId('settings-error')).toHaveTextContent('服务暂时不可用,请稍后再试')
    // 失败时不渲染域名输入框(否则"读不到"会被误读成"没配")
    expect(screen.queryByLabelText('应用域名')).toBeNull()

    // 重试成功 → 页面恢复,读到什么就显示什么
    mockRequest.mockImplementation(async (path: string) => {
      if (path === '/api/server/admin/wasm-apps/domain') {
        return {
          base_domain: 'apps.example.com', source: 'setting', enabled: true,
          url_pattern: 'https://<app_id>.apps.example.com', setting_key: 'wasm.apps_base_domain',
        }
      }
      return {}
    })
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect((await screen.findByLabelText('应用域名') as HTMLInputElement).value).toBe('apps.example.com')
    expect(screen.queryByTestId('settings-error')).toBeNull()
  })

  it('只读账号 → 输入框与保存/关闭按钮都禁用(零写请求)', async () => {
    setCurrentAdmin(READONLY)
    render(<Settings />)
    const input = (await screen.findByLabelText('应用域名')) as HTMLInputElement
    expect(input.disabled).toBe(true)
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '关闭应用子域' }) as HTMLButtonElement).disabled).toBe(true)
    const writes = mockRequest.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method && (init as RequestInit).method !== 'GET',
    )
    expect(writes).toEqual([])
  })

  // -------------------------------------------------------------------------
  // F3（审计第二轮 A2-F3）：设置页这组无障碍判据（只读原因常驻文本 + 三处
  // aria-describedby + 保存错误的 live 区）**此前零用例** —— 删掉后 52 条全绿。
  // 下面两条把它们钉住。
  // -------------------------------------------------------------------------

  it('只读原因常驻且被三个禁用控件引用（不是只藏在 title 里）(F3)', async () => {
    setCurrentAdmin(READONLY)
    render(<Settings />)
    const input = await screen.findByLabelText('应用域名')

    const note = screen.getByTestId('settings-readonly-note')
    expect(note.textContent).toContain('只读')
    // 引用必须指向**真实存在**的节点（悬空 aria-describedby 等于没说）
    expect(document.getElementById('settings-readonly-note')).toBe(note)
    for (const el of [
      input,
      screen.getByRole('button', { name: '保存' }),
      screen.getByRole('button', { name: '关闭应用子域' }),
    ]) {
      expect(el.getAttribute('aria-describedby')).toBe('settings-readonly-note')
    }
  })

  it('保存失败的提示是 alert live 区（读屏用户能听到保存被拒）(F3)', async () => {
    mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/server/admin/wasm-apps/domain' && (init as RequestInit | undefined)?.method === 'PUT') {
        throw new ApiError(400, 'VALIDATION', '未配置 PICOAI_TRUSTED_PROXIES')
      }
      if (path === '/api/server/admin/wasm-apps/domain') {
        return {
          base_domain: 'apps.example.com', source: 'setting', enabled: true,
          url_pattern: 'https://<app_id>.apps.example.com', setting_key: 'wasm.apps_base_domain',
        }
      }
      return {}
    })
    render(<Settings />)
    const input = await screen.findByLabelText('应用域名')
    fireEvent.change(input, { target: { value: 'harness.example.com' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    const err = await screen.findByTestId('settings-save-error')
    expect(err).toHaveTextContent('未配置 PICOAI_TRUSTED_PROXIES')
    expect(err).toHaveAttribute('role', 'alert')
    expect(err).toHaveAttribute('aria-live', 'assertive')
  })
})

// ---------------------------------------------------------------------------
// 本轮 P2 的行为级护栏(每条都能"改回旧实现即红"):
//   R1-uxw-5  抽屉里"当前生效版本"只允许有一个真源(审核后不得同屏两个版本)
//   R1-uxw-7  软删应用可筛可见(下拉有"已删除",请求真的带 include_deleted)
//   R1-uxw-14 反馈进 live 区 + 禁用原因可聚焦可读
// ---------------------------------------------------------------------------

describe('应用中心 · 抽屉单一真源(R1-uxw-5)', () => {
  it('审核通过后抽屉里只有一个"当前生效版本"(快照与待审块不得互相矛盾)', async () => {
    await renderList()
    fireEvent.click(within(rowOf('review-me')).getByRole('button', { name: '详情' }))
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByTestId('pending-list')

    // 打开时两处一致:行快照就是服务端的 1.0.2
    expect(within(dialog).getByTestId('detail-current-version')).toHaveTextContent('1.0.2')
    expect(within(dialog).getByTestId('pending-current-version')).toHaveTextContent('1.0.2')

    // 通过 v1.2.0:服务端把当前生效版本切成 1.2.0,而**列表行快照仍是 1.0.2**
    // (detail 是点开时的对象,不会因为重拉列表而变)。
    pendingCurrentVersion = '1.2.0'
    fireEvent.click(within(dialog).getByTestId('pending-approve-1.2.0'))

    await waitFor(() => {
      expect(within(dialog).getByTestId('detail-current-version')).toHaveTextContent('1.2.0')
    })
    // 两处必须是同一个数(旧实现在 dl 里读 detail.current_version ⇒ 这里会是 1.0.2)
    expect(within(dialog).getByTestId('pending-current-version')).toHaveTextContent('1.2.0')
    // 抽屉里不得再出现旧的 1.0.2 —— 同一屏两个"当前生效版本"就是本次要修的形态。
    expect(within(dialog).queryByText('1.0.2')).toBeNull()
  })

  it('待审清单读失败时两处一起回落到行快照(不出现半新半旧)', async () => {
    mockRequest.mockImplementation(async (path: string) => {
      const base = String(path).split('?')[0]!
      const params = new URLSearchParams(String(path).split('?')[1] ?? '')
      if (base === '/api/server/admin/wasm-apps') return listPage(params)
      if (base.endsWith('/releases')) throw new ApiError(500, 'INTERNAL', '读取待审版本失败')
      if (base.endsWith('/diagnostics')) return { diagnostics: DIAGNOSTICS }
      return {}
    })
    await renderList()
    fireEvent.click(within(rowOf('review-me')).getByRole('button', { name: '详情' }))
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByTestId('pending-error')

    // 读不到待审清单 ⇒ 两处都用行快照的值(而不是一处空一处有)
    expect(within(dialog).getByTestId('detail-current-version')).toHaveTextContent('1.0.2')
    expect(within(dialog).getByTestId('pending-current-version')).toHaveTextContent('1.0.2')
  })
})

describe('应用中心 · 软删应用可见(R1-uxw-7)', () => {
  it('状态筛选有「已删除」,选中后请求带 status=deleted 且 include_deleted=1', async () => {
    appsFixture = [...APP_LIST, DELETED]
    render(<Apps />)
    await screen.findByText('共享便签')
    // 缺省列表不含软删行(服务端 include_deleted 缺省为假)
    expect(screen.queryByText('已删除应用')).toBeNull()

    fireEvent.click(screen.getByRole('combobox', { name: '状态筛选' }))
    fireEvent.click(await screen.findByRole('option', { name: '已删除' }))

    await waitFor(() => {
      const hit = listCalls().find(([p]) => String(p).includes('status=deleted'))
      expect(hit, '必须发出带 status=deleted 的列表请求').toBeTruthy()
      expect(String(hit![0]), '软删行必须显式带 include_deleted(两条入口都要)').toContain('include_deleted=1')
    })
    // 真的能看到那条已删除的应用(以及它的「已删除」状态徽章)
    expect(await screen.findByText('已删除应用')).toBeInTheDocument()
    expect(within(rowOf('gone-app')).getByText('已删除')).toBeInTheDocument()
  })
})

describe('应用中心 · 无障碍(R1-uxw-14)', () => {
  it('成功提示与失败红字都在 live 区(读屏用户能听到结果)', async () => {
    await renderList()
    // 失败路径:下架被拒 ⇒ 页面级错误是 alert live 区
    mockRequest.mockImplementation(async (path: string) => {
      if (String(path).startsWith('/api/server/admin/wasm-apps?')) return listPage(new URLSearchParams())
      throw new Error('下架失败:应用已被冻结')
    })
    fireEvent.click(within(rowOf('share-note')).getByRole('button', { name: '下架' }))
    fireEvent.click(await screen.findByTestId('unpublish-confirm'))
    const err = await screen.findByTestId('apps-error')
    expect(err).toHaveAttribute('role', 'alert')
    expect(err).toHaveAttribute('aria-live', 'assertive')
  })

  it('冻结成功的 flash 是 status live 区', async () => {
    await renderList()
    fireEvent.click(within(rowOf('share-note')).getByRole('button', { name: '冻结' }))
    fireEvent.click(await screen.findByTestId('freeze-confirm'))
    const flashMsg = await screen.findByTestId('apps-flash')
    expect(flashMsg).toHaveAttribute('role', 'status')
    expect(flashMsg).toHaveAttribute('aria-live', 'polite')
  })

  it('被禁用的「上架」原因可聚焦可读,而不只是 title', async () => {
    await renderList()
    const btn = within(rowOf('legacy-board')).getByRole('button', { name: '上架' }) as HTMLButtonElement
    const note = screen.getByTestId('frozen-reason-legacy-board')

    // 禁用按钮本身不可聚焦 ⇒ 原因必须是一个**可聚焦**的节点 + aria-describedby
    expect(note).toHaveAttribute('tabindex', '0')
    expect(btn.getAttribute('aria-describedby')).toBe('frozen-reason-legacy-board')
    expect(note).toHaveTextContent('先解冻再上架')
    note.focus()
    expect(document.activeElement).toBe(note)
  })

  it('只读账号:被禁用的审批按钮指向可读的权限说明', async () => {
    setCurrentAdmin(READONLY)
    await renderList()
    fireEvent.click(within(rowOf('review-me')).getByRole('button', { name: '详情' }))
    const approve = await screen.findByTestId('pending-approve-1.2.0')
    expect(approve).toBeDisabled()
    expect(approve.getAttribute('aria-describedby')).toBe('pending-write-note')
    const note = screen.getByTestId('pending-write-note')
    expect(note.textContent).toContain('capability:write')
    // 组织级开关的原因指向页面级只读说明(同样是可见文本,不是 title)
    expect(screen.getByTestId('apps-readonly-note').textContent).toContain('capability:write')
  })
})
