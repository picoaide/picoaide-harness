import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ApiError, me, request } from '../api'
import { setCurrentAdmin, type MeUser } from '../lib/rbac'
import Apps from './app-center/Apps'

// 打开次数趋势用 ChartLazy（懒加载 VChart，~182KB gz）。组件测试只断言"有图/没图"
// 与数据口径，图表内部渲染不在范围内 —— 与 usage 三个测试文件同口径。
vi.mock('../components/chart-lazy', () => ({
  ChartLazy: () => <div data-testid="chart-mock" />,
}))

// ---------------------------------------------------------------------------
// 应用中心(2026-09-18;2026-09-19 拆成子页):
//   应用   = wasm 应用列表与平台级处置(本文件 Apps 部分)
//   限制项 = 原「应用平台」页,测试在 AppPlatform.test.tsx(渲染 app-center/Limits)
//
// 2026-09-19 WASM 客户端专属改造:原「设置」子页(应用域名/泛域名)整页删除 ——
// 应用只在桌面客户端内以 `picoaide-app://<app_id>/` 打开,服务端的基域配置面
// (`wasm.apps_base_domain`、`GET/PUT /wasm-apps/domain`)随之删除(契约 §4.4/§4.5)。
// 本文件里那一整组设置页用例随之删除;`access:'public'` 夹具**保留为历史值用例**,
// 断言新口径(渲染成「已退役（历史值）」而不是「公开」)。
// 子导航与老路由重定向的接线测试在 app-center/AppCenterLayout.test.tsx。
//
// W5 追加(2026-09-19,契约 §19 Q11/Q13 + §3 F16):
//   ⑤ **访问级别筛选**只有两值(+全部)；历史 public 行由「登录后全员」命中，
//      行上标注「已退役（历史值）」；服务端未回显该筛选时降级为"本页过滤 + 明说"；
//   ⑥ **打开次数列**（F16）：聚合端点缺失时显示「—」+ 明说原因，**不得显示 0**；
//   ⑦ **公告模板**（访问级别变更 / 客户端专属形态）：可复制、含必须告知的措辞。
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
/**
 * 冻结行,同时是**历史访问级别**的载体:存量行里可能仍写着 `access:'public'`
 * (2026-09-19 契约 §4.4 起写侧只接受 login|whitelist,读侧把 public 当 login)。
 * 这个夹具**有意保留 `public`** —— 服务端/前端任何一端把它当成"还能匿名可达"
 * 都会在这里被断言咬住(渲染必须是「已退役（历史值）」)。
 */
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
    id: 21, version: '1.2.0', status: 'pending', title: '待审应用',
    // 描述与线上一致(夹具默认场景 = 只改代码不改门面)⇒ 卡片不得制造"变更"假象。
    description: '团队共享的便签墙',
    publisher: 'dave',
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

/**
 * F16 跨应用聚合（`GET /wasm-apps/opens/summary`）—— 列表「打开次数」列 + 运营看板共用。
 *
 * 数字刻意选成：
 *   - `totals.uv = 9` **小于**逐日 UV 之和（6+5=11）：窗口 UV 只能信服务端的去重值，
 *     把逐日 UV 相加会把同一个人重复计数（opens-contract 的硬口径）；
 *   - `totals.pv = 40` 等于逐日 PV 之和（20+20）：PV 不去重，可以相加。
 */
const OPENS_SUMMARY = {
  days: 7,
  top: 10,
  today: { day: '2026-09-19', pv: 12, uv: 5 },
  totals: { pv: 40, uv: 9 },
  trend: [
    { day: '2026-09-18', pv: 20, uv: 6 },
    { day: '2026-09-19', pv: 20, uv: 5 },
  ],
  apps: [
    { app_id: 'share-note', today_pv: 8, today_uv: 3, window_pv: 25, window_uv: 6 },
    { app_id: 'ops-tool', today_pv: 4, today_uv: 2, window_pv: 15, window_uv: 4 },
  ],
  top_apps: [
    { app_id: 'share-note', title: '共享便签', pv: 25, uv: 6 },
    { app_id: 'ops-tool', title: '运维小工具', pv: 15, uv: 4 },
  ],
  detail_retention_days: 90,
}

/**
 * 单应用打开明细（`GET /wasm-apps/:app_id/opens`，设计冻结路径 §8.9）。
 *
 * 形状按**服务端已落地实现**写（`serverstore.WasmOpenSeries`，核对 2026-09-20）：
 * 区间合计 = `total_pv`/`total_uv`；`granularity=dept` 的行 `day` 为空串且**无部门名**
 * （只有 dept_id ⇒ 部门名由前端 best-effort 映射，本夹具的管理员没有 dept:read，
 * 因此断言的是「部门 #1」这种如实回退）。
 */
const APP_OPENS_DAY = {
  app_id: 'share-note', from: '2026-08-21', to: '2026-09-19', granularity: 'day',
  total_pv: 40, total_uv: 9,
  points: OPENS_SUMMARY.trend.map((p) => ({ ...p, dept_id: 1 })),
  detail_retention_days: 90,
}
const APP_OPENS_DEPT = {
  app_id: 'share-note', granularity: 'dept', total_pv: 40, total_uv: 9,
  points: [
    { day: '', dept_id: 1, pv: 30, uv: 7 },
    { day: '', dept_id: 0, pv: 10, uv: 2 },
  ],
  detail_retention_days: 90,
}

/**
 * AI 用量（§21.4 / §5.1c B）：**服务端真实形状**，`days: []` + 全零合计
 * + `attribution_available: false` = 「统计尚未上线」，而不是"0 次调用"。
 */
const AI_USAGE_EMPTY = {
  app_id: 'share-note', from: '2026-08-21', to: '2026-09-19',
  days: [],
  total: { day: '', requests: 0, prompt_tokens: 0, completion_tokens: 0, cache_prompt_tokens: 0, cost: 0 },
  attribution_available: false,
}

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

/**
 * F16/AI 用量的取数开关（用例级覆盖点）。
 *
 * 默认 **全部可用**（夹具齐全），单条用例改成 `'missing'` 就能断言"缺后端时的
 * 降级提示 + `—`"，不必在每个用例里重写整个 mockImplementation。
 */
let opensSummaryMode: 'ok' | 'missing' | 'drift' = 'ok'
let appOpensMode: 'ok' | 'missing' | 'drift' = 'ok'
let aiUsageMode: 'ok' | 'missing' | 'drift' | 'data' = 'ok'

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
  // 访问级别筛选（契约 §19 Q13）：`login` **必须**命中历史 public（读侧同口径）。
  const access = params.get('access') ?? ''
  if (access === 'login') rows = rows.filter((a) => a.access === 'login' || a.access === 'public')
  else if (access === 'whitelist') rows = rows.filter((a) => a.access === 'whitelist')
  return {
    apps: rows.slice(offset, offset + limit),
    review_required: false,
    setting_key: 'wasm.review_required',
    pending_count: appsFixture.reduce((n, a) => n + (a.pending_count ?? 0), 0),
    total: rows.length,
    truncated: offset + limit < rows.length,
    limit,
    offset,
    // 服务端把生效的筛选值原样回显（L6 契约依赖；缺它前端按"不支持"降级）。
    access,
  }
}

beforeEach(() => {
  setCurrentAdmin(SUPER)
  appsFixture = APP_LIST
  pendingCurrentVersion = '1.0.2'
  opensSummaryMode = 'ok'
  appOpensMode = 'ok'
  aiUsageMode = 'ok'
  // 访问级别筛选会同步回 URL（刷新/分享用），而 jsdom 的 location 在用例之间是
  // **共享**的 ⇒ 每条用例开始前清掉查询串，否则上一条用例的 `?access=` 会变成
  // 下一条的初值（不是被测行为，是测试污染）。
  window.history.replaceState({}, '', '/admin/app-center')
  /** 404 是"服务端没这个端点"（NoRoute 也是 404 JSON 信封）。 */
  const missing = (path: string) => {
    const err = new ApiError(404, 'NOT_FOUND', `请求的资源不存在（${path}）`)
    return Promise.reject(err)
  }
  mockRequest.mockReset()
  mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
    const base = String(path).split('?')[0]!
    const params = new URLSearchParams(String(path).split('?')[1] ?? '')
    if (base === '/api/server/admin/wasm-apps') return listPage(params)
    // F16 跨应用聚合（列表列 + 看板）；`missing` 模式演练"缺后端不得显示 0"。
    if (base === '/api/server/admin/wasm-apps/opens/summary') {
      if (opensSummaryMode === 'missing') return missing(base)
      if (opensSummaryMode === 'drift') return { days: 7 }
      return OPENS_SUMMARY
    }
    // 单应用打开明细（设计冻结路径 §8.9）：granularity=dept 时给部门行。
    if (base.endsWith('/opens')) {
      if (appOpensMode === 'missing') return missing(base)
      if (appOpensMode === 'drift') return { app_id: 'share-note' }
      return params.get('granularity') === 'dept' ? APP_OPENS_DEPT : APP_OPENS_DAY
    }
    // AI 用量（§21.4）：默认空归因数据（面板必须渲染空状态而不是 0）。
    if (base.endsWith('/ai-usage')) {
      if (aiUsageMode === 'missing') return missing(base)
      if (aiUsageMode === 'drift') return { app_id: 'share-note' }
      if (aiUsageMode === 'data') {
        return {
          app_id: 'share-note', from: '2026-08-21', to: '2026-09-19',
          days: [{ day: '2026-09-19', requests: 3, prompt_tokens: 900, completion_tokens: 300, cache_prompt_tokens: 0, cost: 1.5 }],
          total: { day: '', requests: 3, prompt_tokens: 900, completion_tokens: 300, cache_prompt_tokens: 0, cost: 1.5 },
          attribution_available: true,
        }
      }
      return AI_USAGE_EMPTY
    }
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
  // 同上：把 URL 里的筛选带走，别污染下一条用例（含 `?access=public` 负例）。
  window.history.replaceState({}, '', '/admin/app-center')
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

    // 列头(F16 起多一列「打开次数」)
    for (const h of ['应用', '访问级别', '状态', '负责人', '当前版本', '打开次数', '更新时间']) {
      expect(screen.getByRole('columnheader', { name: h })).toBeInTheDocument()
    }

    // 应用列:标题 + app_id 小字
    expect(screen.getByText('共享便签')).toBeInTheDocument()
    expect(screen.getByText('share-note')).toBeInTheDocument()
    expect(screen.getByText('运维小工具')).toBeInTheDocument()
    expect(screen.getByText('ops-tool')).toBeInTheDocument()

    // 访问级别:login/whitelist 的中文标签 + 历史 public 的**新口径**文案
    // (按行断言:夹具里多行同级别)
    expect(within(rowOf('share-note')).getByText('登录后全员')).toBeInTheDocument()
    expect(within(rowOf('ops-tool')).getByText('白名单')).toBeInTheDocument()
    expect(within(rowOf('legacy-board')).getByText('已退役（历史值）')).toBeInTheDocument()

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

  it('历史访问级别 public 的行:渲染「已退役（历史值）」并带解释，不给裸值也不给「公开」', async () => {
    // 2026-09-19 契约 §4.4/I6:写侧只接受 login|whitelist,读侧把历史 public 当 login。
    // 管理端必须给**同一口径**的可读文案:显示裸 `public` 读不懂、显示「公开」
    // 会让管理员以为匿名仍然可达 —— 两种都是这次要拦回去的形态；
    // 但也不能**隐藏**这一行/这一列（隐藏 = 存量应用的访问级别看起来丢了）。
    await renderList()
    const row = rowOf('legacy-board')
    const badge = within(row).getByText('已退役（历史值）')
    expect(badge).toBeInTheDocument()
    expect(within(row).queryByText('公开')).toBeNull()
    expect(within(row).queryByText('public')).toBeNull()
    // 「已退役」不是一句无解释的标签:悬浮说明必须写清服务端按 login 执行。
    expect(badge.getAttribute('title') ?? '').toContain('按「登录后全员」执行')
  })

  it('访问级别**筛选器**只有两值(+全部):不含 public,也不会出现"访问级别"写控件', async () => {
    // 「收敛到两值」有两层含义:
    //   ① 可写取值只有 login|whitelist（管理端没有访问级别编辑器 —— 取值由应用包
    //      决定），所以不存在"选成 public"的控件；
    //   ② 筛选器只提供两值 + 全部；历史 public 由「登录后全员」命中（读侧同口径）。
    // 变异验证：把 public 加回筛选选项（或补一个含 public 的访问级别下拉）⇒ 本用例必红。
    await renderList()

    const filter = screen.getByTestId('app-access-filter')
    fireEvent.click(filter)
    const options = await screen.findAllByRole('option')
    const labels = options.map((o) => o.textContent ?? '')
    expect(labels.some((l) => l.includes('全部访问级别'))).toBe(true)
    expect(labels.some((l) => l.includes('登录后全员'))).toBe(true)
    expect(labels.some((l) => l.includes('白名单'))).toBe(true)
    // 没有"public / 公开 / 已退役"这类**可选项**：历史值不是可选的访问级别。
    expect(labels.some((l) => l.includes('public') || l.includes('公开'))).toBe(false)
    // 访问级别编辑器不存在：名字恰为「访问级别」的控件只有筛选器的 label，
    // 而没有可写控件（写侧在应用包，服务端 WritableAccess 拒绝 public）。
    expect(screen.queryByRole('combobox', { name: '访问级别' })).toBeNull()
    expect(screen.queryByRole('textbox', { name: '访问级别' })).toBeNull()
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

  // -------------------------------------------------------------------------
  // 审计第三轮 B 区 CONFIRMED(2026-09-19):审批人看不到待审标题 ⇒ 盲批。
  //
  // approve 是 title/description 进全组织目录的**唯一入口**(待审期间 apps.title
  // 刻意不写),而首版待审时 apps.title 是 app_id 占位、按提交标题也搜不到 ⇒ 卡片
  // 必须自己把待审显示面渲染出来。判据是**结果级**的:DOM 文本里必须出现待审标题。
  // -------------------------------------------------------------------------

  it('待审卡片渲染将公开的标题/描述(与线上不同 ⇒ 「现 X → 待审 Y」对照)', async () => {
    const renamed = [{
      ...PENDING_RELEASES[0]!,
      title: 'IT 密码重置',
      description: 'IT 密码重置:请在此输入你的域账号密码',
    }]
    mockRequest.mockImplementation(async (path: string) => {
      const full = String(path)
      const base = full.split('?')[0]!
      if (base === '/api/server/admin/wasm-apps') return listPage(new URLSearchParams())
      if (base.includes('/releases')) {
        const wanted = new URLSearchParams(full.split('?')[1] ?? '').get('status') ?? 'pending'
        return {
          app_id: 'review-me', status: wanted, current_version: '1.0.2',
          releases: wanted === 'rejected' ? REJECTED_RELEASES : renamed,
          pending_count: 1,
        }
      }
      if (base.endsWith('/diagnostics')) return { diagnostics: DIAGNOSTICS }
      throw new Error(`unexpected ${path}`)
    })
    await renderList()
    fireEvent.click(within(rowOf('review-me')).getByRole('button', { name: '详情' }))

    const block = await screen.findByTestId('pending-block')
    await within(block).findByTestId('pending-list')
    // ① 待审标题必须真的出现在 DOM 里(而不是只存在于接口响应里)。
    expect(within(block).getByTestId('pending-title-next-1.2.0')).toHaveTextContent('IT 密码重置')
    // ② 与线上标题不同 ⇒ 「现标题 → 待审标题」对照(旧值也必须在场,否则看不出改了什么)。
    expect(within(block).getByTestId('pending-title-current-1.2.0')).toHaveTextContent('待审应用')
    expect(within(block).getByTestId('pending-title-1.2.0')).toHaveTextContent('现标题')
    expect(within(block).getByTestId('pending-title-1.2.0')).toHaveTextContent('待审标题')
    // 描述同理(approve 会把 description 一起公开)。
    expect(within(block).getByTestId('pending-description-next-1.2.0'))
      .toHaveTextContent('请在此输入你的域账号密码')
    expect(within(block).getByTestId('pending-description-current-1.2.0'))
      .toHaveTextContent('团队共享的便签墙')
  })

  it('首版待审:渲染待审标题并明说目录暂以应用标识占位(不伪造"现标题")', async () => {
    const first = [{
      ...PENDING_RELEASES[0]!,
      version: '1.0.0',
      title: 'IT 密码重置',
      description: 'IT 密码重置:请在此输入你的域账号密码',
    }]
    // apps 行还是 app_id 占位(首版待审:current_release_id = 0)。
    appsFixture = [{
      ...REVIEWING, app_id: 'brand-new-tool', title: 'brand-new-tool', description: '',
      current_release_id: 0, current_version: '', pending_releases: ['1.0.0'], pending_count: 1,
    }] as typeof APP_LIST
    mockRequest.mockImplementation(async (path: string) => {
      const full = String(path)
      const base = full.split('?')[0]!
      if (base === '/api/server/admin/wasm-apps') return listPage(new URLSearchParams())
      if (base.includes('/releases')) {
        const wanted = new URLSearchParams(full.split('?')[1] ?? '').get('status') ?? 'pending'
        return {
          app_id: 'brand-new-tool', status: wanted, current_version: '',
          releases: wanted === 'rejected' ? [] : first,
          pending_count: 1,
        }
      }
      if (base.endsWith('/diagnostics')) return { diagnostics: DIAGNOSTICS }
      throw new Error(`unexpected ${path}`)
    })
    render(<Apps />)
    // 占位场景里 title 与 app_id 同值(两列文本相同)⇒ 取第一个命中所在的 <tr>。
    const cells = await screen.findAllByText('brand-new-tool')
    const row = cells[0]!.closest('tr')
    if (row === null) throw new Error('未找到 brand-new-tool 所在的行')
    fireEvent.click(within(row).getByRole('button', { name: '详情' }))

    const block = await screen.findByTestId('pending-block')
    await within(block).findByTestId('pending-list')
    expect(within(block).getByTestId('pending-title-next-1.0.0')).toHaveTextContent('IT 密码重置')
    expect(within(block).getByTestId('pending-title-1.0.0')).toHaveTextContent('首版待审')
    // 占位不是"现标题":不得渲染成"现标题 brand-new-tool → ..."(那是伪造旧值)。
    expect(within(block).queryByTestId('pending-title-current-1.0.0')).toBeNull()
    expect(within(block).getByTestId('pending-title-1.0.0')).not.toHaveTextContent('→')
  })

  it('待审值与线上相同 ⇒ 不制造"变更"假象(只渲染现值一行)', async () => {
    await renderList()
    fireEvent.click(within(rowOf('review-me')).getByRole('button', { name: '详情' }))
    const block = await screen.findByTestId('pending-block')
    await within(block).findByTestId('pending-list')
    // 夹具里待审标题/描述与线上一致(待审应用 / 团队共享的便签墙)⇒ 不出现对照。
    expect(within(block).getByTestId('pending-title-next-1.2.0')).toHaveTextContent('待审应用')
    expect(within(block).queryByTestId('pending-title-current-1.2.0')).toBeNull()
    expect(within(block).queryByTestId('pending-description-current-1.2.0')).toBeNull()
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

// ---------------------------------------------------------------------------
// W5（2026-09-19）：F16 打开次数列 + 访问级别筛选（§19 Q11/Q13）+ 公告模板。
// 每条都对应一条"缺后端/缺判据即红"的口径，变异点写在用例注释里。
// ---------------------------------------------------------------------------
describe('应用中心 · F16 打开次数列与降级', () => {
  it('列表按应用显示今日 / 近 7 日 PV+UV（来自跨应用聚合，不是每行一个请求）', async () => {
    await renderList()
    const cell = await screen.findByTestId('app-opens-cell-share-note')
    expect(cell.textContent).toContain('今日')
    expect(cell.textContent).toContain('8')
    expect(cell.textContent).toContain('3')
    expect(cell.textContent).toContain('近 7 日')
    expect(cell.textContent).toContain('25')
    expect(cell.textContent).toContain('6')
    // 一次聚合服务整页：不能退化成"每行一个 opens 请求"。
    const summaryCalls = mockRequest.mock.calls.filter(
      ([p]) => String(p).startsWith('/api/server/admin/wasm-apps/opens/summary'),
    )
    expect(summaryCalls.length).toBeGreaterThan(0)
    expect(summaryCalls.length).toBeLessThanOrEqual(2) // 严格模式下的重复挂载容忍一次
    const perApp = mockRequest.mock.calls.filter(([p]) => /\/wasm-apps\/[^/]+\/opens\?/.test(String(p)))
    expect(perApp).toEqual([])
  })

  it('聚合可用但服务端没下发该应用的行 ⇒ **按 0 计**并带 title 说明（不是 —）', async () => {
    // R2-L6-4：`GROUP BY app_id` 会省略零打开的应用 ⇒ 缺"行"是"窗口内确实没打开"（0），
    // 与缺"字段"（形状漂移 ⇒ —）是两件事。变异验证：改回 `countText(orow?.today_pv)`
    // ⇒ 本用例读到 '—'，必红。
    await renderList()
    const cell = await screen.findByTestId('app-opens-cell-legacy-board')
    expect(cell.textContent).toContain('0')
    expect(cell.textContent).not.toContain('—')
    expect(cell.getAttribute('title')).toContain('按 0 计')
    expect(cell.getAttribute('title')).toContain('没有该应用的打开记录')
  })

  it('聚合端点缺失（404）：列显示 — 且页面明说"服务端尚未提供"，绝不显示 0', async () => {
    // 变异验证：把这里的降级分支去掉（改成 countText(orow?.today_pv ?? 0) 之类），
    // 用例会读到 "0" 而不是 "—"，本用例必红。
    opensSummaryMode = 'missing'
    await renderList()
    const cell = await screen.findByTestId('app-opens-cell-share-note')
    expect(cell.textContent).toBe('—')
    const failure = await screen.findByTestId('apps-opens-failure')
    expect(failure.textContent).toContain('404')
    // 提示必须点名端点，运维/L1 才知道要补什么。
    expect(failure.textContent).toContain('/api/server/admin/wasm-apps/opens/summary')
    expect(failure.textContent).toContain('不是 0')
  })

  it('聚合响应形状漂移（缺 top_apps）：按"结构不符合契约"提示，而不是当成没有数据', async () => {
    opensSummaryMode = 'drift'
    await renderList()
    const failure = await screen.findByTestId('apps-opens-failure')
    expect(failure.textContent).toContain('top_apps')
    expect(await screen.findByTestId('app-opens-cell-share-note')).toHaveTextContent('—')
  })

  it('详情抽屉：打开次数（PV/UV/趋势/按部门）与 AI 用量同页展示', async () => {
    await renderList()
    fireEvent.click(within(rowOf('share-note')).getByRole('button', { name: '详情' }))

    // ① 打开次数：概览来自聚合，当前窗口来自 :app_id/opens
    expect(await screen.findByTestId('app-opens-block')).toBeInTheDocument()
    expect(await screen.findByTestId('app-opens-today-pv')).toHaveTextContent('8')
    expect(screen.getByTestId('app-opens-window-pv')).toHaveTextContent('25')
    // 窗口 UV 取**服务端**去重值 9（逐日 UV 之和是 11 —— 相加即错）
    expect(await screen.findByTestId('app-opens-range-pv')).toHaveTextContent('40')
    expect(screen.getByTestId('app-opens-range-uv')).toHaveTextContent('9')
    expect(await screen.findByTestId('app-opens-trend')).toBeInTheDocument()

    // ② 切到按部门：部门行 + 未归属部门行
    fireEvent.click(screen.getByTestId('app-opens-granularity'))
    fireEvent.click(await screen.findByRole('option', { name: '按部门' }))
    const deptList = await screen.findByTestId('app-opens-dept-list')
    // 服务端只给 dept_id，本夹具账号没有 dept:read ⇒ 如实显示编号而不是编名字。
    expect(deptList.textContent).toContain('部门 #1')
    expect(deptList.textContent).toContain('（未归属部门）')

    // ③ AI 用量：默认夹具是 attribution_available=false（**统计尚未上线**）⇒ 空状态而不是 0
    expect(await screen.findByTestId('app-ai-usage-block')).toBeInTheDocument()
    expect(await screen.findByText('统计尚未上线：暂无应用归因')).toBeInTheDocument()
    expect(screen.queryByTestId('app-ai-calls')).toBeNull()
  })

  it('详情抽屉：AI 用量有数据时显示次数 / tokens / 费用', async () => {
    aiUsageMode = 'data'
    await renderList()
    fireEvent.click(within(rowOf('share-note')).getByRole('button', { name: '详情' }))
    expect(await screen.findByTestId('app-ai-calls')).toHaveTextContent('3')
    // 服务端只给分项 ⇒ 总 token = 输入 900 + 输出 300 = 1200（headline 用千分位）。
    expect(screen.getByTestId('app-ai-tokens')).toHaveTextContent('1,200')
    expect(screen.getByTestId('app-ai-cost').textContent).toContain('1.50')
    expect(screen.getByTestId('app-ai-days').textContent).toContain('2026-09-19')
    // 生效窗口由服务端回显（R2-L6-3 同款纪律）。
    expect(screen.getByTestId('app-ai-effective-window').textContent).toContain('2026-08-21 ~ 2026-09-19')
  })

  it('详情抽屉：打开次数端点缺失时明说不可用（不把"读不到"当成"没人打开过"）', async () => {
    appOpensMode = 'missing'
    await renderList()
    fireEvent.click(within(rowOf('share-note')).getByRole('button', { name: '详情' }))
    const failure = await screen.findByTestId('app-opens-failure')
    expect(failure.textContent).toContain('/api/server/admin/wasm-apps/share-note/opens')
    expect(screen.getByTestId('app-opens-range-pv')).toHaveTextContent('—')
  })
})

describe('应用中心 · 访问级别筛选（§19 Q13）', () => {
  it('选「登录后全员」：进查询串、由服务端过滤，且**历史 public 行一起命中**', async () => {
    await renderList()
    fireEvent.click(screen.getByTestId('app-access-filter'))
    fireEvent.click(await screen.findByRole('option', { name: /登录后全员/ }))

    await waitFor(() => {
      const calls = listCalls()
      expect(calls.some(([p]) => String(p).includes('access=login'))).toBe(true)
    })
    // 历史 public 行必须还在（读侧同口径 ⇒ 不能因为筛选而"看起来丢了"）。
    expect(await screen.findByText('旧看板')).toBeInTheDocument()
    expect(await screen.findByTestId('app-access-legacy-note')).toHaveTextContent('1 条')
    // 白名单行被服务端过滤掉
    expect(screen.queryByText('运维小工具')).toBeNull()
  })

  it('选「白名单」：只留白名单行，不出现历史值提示', async () => {
    await renderList()
    fireEvent.click(screen.getByTestId('app-access-filter'))
    fireEvent.click(await screen.findByRole('option', { name: '白名单' }))
    expect(await screen.findByText('运维小工具')).toBeInTheDocument()
    expect(screen.queryByText('旧看板')).toBeNull()
    expect(screen.queryByTestId('app-access-legacy-note')).toBeNull()
  })

  it('服务端不回显 access（不支持该筛选）：本页过滤 + 明说"共 N 条/翻页仍是全集"', async () => {
    // 变异验证：把 accessFilterSupported 恒判为 true（或删掉本地过滤）⇒
    // 本用例的"白名单行消失 + 提示存在"就有一条会红。
    const original = mockRequest.getMockImplementation()!
    mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      const out = await original(path, init)
      if (String(path).startsWith('/api/server/admin/wasm-apps?')) {
        const { access: _drop, ...rest } = out as Record<string, unknown>
        return rest
      }
      return out
    })
    await renderList()
    fireEvent.click(screen.getByTestId('app-access-filter'))
    fireEvent.click(await screen.findByRole('option', { name: '白名单' }))

    const note = await screen.findByTestId('app-access-local-note')
    expect(note.textContent).toContain('只在**本页')
    expect(note.textContent).toContain('未筛选全集')
    // 本页过滤仍然生效（否则筛选器就是个摆设）
    expect(await screen.findByText('运维小工具')).toBeInTheDocument()
    expect(screen.queryByText('旧看板')).toBeNull()
  })

  it('URL 带 ?access=public：给出两值口径的拒绝消息，且**不隐藏**任何行', async () => {
    // 「不可再选」不等于「假装它不存在」：旧书签带着 public 进来时，
    // ①不能静默当成"全部"（管理员以为筛过了），②不能把历史行藏起来（看起来像数据丢了）。
    window.history.pushState({}, '', '/admin/app-center?access=public')
    try {
      await renderList()
      const rejected = await screen.findByTestId('app-access-rejected')
      expect(rejected.textContent).toContain('login')
      expect(rejected.textContent).toContain('whitelist')
      expect(rejected.textContent).toContain('已退役')
      // 筛选回落到"全部"：四条夹具行都还在（含历史 public 那行）
      expect(screen.getByText('旧看板')).toBeInTheDocument()
      expect(screen.getByText('共享便签')).toBeInTheDocument()
      expect(screen.queryByTestId('app-access-local-note')).toBeNull()
    } finally {
      window.history.pushState({}, '', '/admin/app-center')
    }
  })
})

describe('应用中心 · 公告模板（§19 Q13）', () => {
  it('提供两份员工公告（访问级别变更 / 客户端专属打开）与一份管理员清单', async () => {
    await renderList()
    fireEvent.click(screen.getByTestId('announcement-open'))
    const dialog = await screen.findByTestId('announcement-dialog')

    // ① 访问级别变更：必须说清"需要登录 + 旧网页地址失效"
    const accessBody = within(dialog).getByTestId('announcement-body-access-login-only').textContent ?? ''
    expect(accessBody).toContain('登录')
    expect(accessBody).toContain('不再支持')
    // ② 客户端专属形态：入口、分享、身份
    const clientBody = within(dialog).getByTestId('announcement-body-client-only-open').textContent ?? ''
    expect(clientBody).toContain('桌面客户端')
    expect(clientBody).toContain('复制链接')
    expect(clientBody).toContain('打开次数')
    // ③ 管理员自查清单：点名筛选器与"两值"口径
    const opsBody = within(dialog).getByTestId('announcement-body-ops-converge-legacy').textContent ?? ''
    expect(opsBody).toContain('已退役（历史值）')
    expect(opsBody).toContain('login / whitelist')
    // 写侧口径只有两值（对话框顶部那行就是 accessLevelRejectionMessage 的正文）
    expect(within(dialog).getByTestId('announcement-access-rule').textContent).toContain('两值')
    // 公开面纪律：不许出现任何真实域名（占位符才行）
    expect(accessBody).not.toMatch(/https?:\/\//)
    expect(clientBody).not.toMatch(/https?:\/\//)
  })

  it('复制走剪贴板并回显"已复制"；失败时明说请手动复制', async () => {
    const writeText = vi.fn(async (_text: string) => {})
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    await renderList()
    fireEvent.click(screen.getByTestId('announcement-open'))
    fireEvent.click(await screen.findByTestId('announcement-copy-client-only-open'))
    await waitFor(() => { expect(writeText).toHaveBeenCalledTimes(1) })
    const copied = String(writeText.mock.calls[0]![0])
    expect(copied).toContain('桌面客户端')
    expect(await screen.findByTestId('announcement-flash')).toHaveTextContent('已复制')

    // 剪贴板不可用（http 内网 + execCommand 也不支持）⇒ 必须明说，不假装成功。
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined })
    mockRequest.mockClear()
    fireEvent.click(screen.getByTestId('announcement-copy-access-login-only'))
    expect(await screen.findByTestId('announcement-copy-failed-access-login-only')).toHaveTextContent('手动选择')
  })
})
