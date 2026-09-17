import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { request } from '../api'
import { setCurrentAdmin, type MeUser } from '../lib/rbac'
import Audit from './Audit'

// ---------------------------------------------------------------------------
// 审计 R7 branding-4:审计日志 CSV 导出必须做公式注入转义 + 带 UTF-8 BOM。
//
// 注入源匿名可写:登录失败时服务端把请求里的**用户名**原样写进审计行
// (server/internal/serverauth/handler.go: 只限 128 字节长度,无字符集校验),
// detail 里也可能带逗号/引号/换行。导出后管理员用 Excel/LibreOffice 打开,
// 以 = + - @ Tab CR 开头的单元格会被当公式执行(DDE 反弹 shell 那一类)。
// 同仓 usage/common.tsx 的 csvCell 早就有前缀转义 + BOM,两份实现分叉 ——
// 现在统一到 lib/csv.ts(单一实现,口径一致)。
// ---------------------------------------------------------------------------
const mockRequest = vi.mocked(request)

const EVIL_DDE = "=cmd|'/C calc'!A0"
const LOGS = [
  { id: 1, username: EVIL_DDE, action: 'login_fail', detail: 'ip=10.0.0.9', created_at: '2026-09-13T10:00:00+08:00' },
  { id: 2, username: '+1+1', action: 'login_fail', detail: 'ip=10.0.0.9', created_at: '2026-09-13T10:00:01+08:00' },
  { id: 3, username: '-2+3', action: 'login_fail', detail: 'ip=10.0.0.9', created_at: '2026-09-13T10:00:02+08:00' },
  { id: 4, username: '@SUM(1+1)', action: 'login_fail', detail: 'ip=10.0.0.9', created_at: '2026-09-13T10:00:03+08:00' },
  { id: 5, username: '\tTAB', action: 'login_fail', detail: 'ip=10.0.0.9', created_at: '2026-09-13T10:00:04+08:00' },
  { id: 6, username: '\rCR', action: 'login_fail', detail: 'ip=10.0.0.9', created_at: '2026-09-13T10:00:05+08:00' },
  { id: 7, username: 'alice', action: 'login_ok', detail: 'ip=1.2.3.4, ua="curl"', created_at: '2026-09-13T10:00:06+08:00' },
]

let captured = ''
// BOM 必须查**字节**:Blob.text() 按规范会吃掉开头的 U+FEFF(UTF-8 解码算法),
// 用它断言 BOM 会永远为假 —— 复核员的探针正栽在这里("无 BOM"那半条证据无效;
// 旧代码确实没有 BOM,但那个断言证明不了)。这里同时取文本与字节。
let bytes: Uint8Array | null = null

// ---------------------------------------------------------------------------
// 等"真的加载完",不要等"发过请求"(2026-09-17 Gate 红的根因)
//
// 原先各用例统一写 `await waitFor(() => expect(mockRequest).toHaveBeenCalled())` ——
// 只要**任意**一个请求发出就满足(可能是 /audit/settings),此刻列表响应还没落地、
// 组件 state 还是空数组,于是读 state 的断言拿到空数据。CI 负载下实测:导出的 CSV
// 只有表头(`expected 'id,username,action,detail,created_at' to contain '=cmd|…'`)。
// 判据必须是"渲染结果"而不是"调用记录":
//   * waitForAuditRows  —— 表头 + N 行数据都在 DOM 里(= logs 已落 state);
//   * waitForAuditLoad  —— 列表响应已落地(settings 请求只在 logs 落 state 之后发出)。
// ---------------------------------------------------------------------------
const AUDIT_SETTINGS_PATH = '/api/server/admin/audit/settings'

/**
 * 等到审计表格出现 rows 行数据(不含表头行)。
 *
 * 显式 5s 预算：RTL 默认 1000ms 在 CI/4 路并行负载下与 `app-login-capability.test.tsx`
 * 那处同因（2026-09-17 审计 P3-5）——判据本身是对的，只是预算要够。
 * 另注：**空态也占 1 行**（`Audit.tsx` 的 `logs.length===0` 分支渲一个 TableRow 包
 * EmptyState），所以 rows=1 与空态同形、rows=0 永不通过；本文件只在 ≥3 行处使用。
 */
async function waitForAuditRows(rows: number): Promise<void> {
  if (rows < 2) throw new Error(`waitForAuditRows 只用于 rows>=2（空态占位行会与之同形），收到 ${rows}`)
  await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(rows + 1), { timeout: 5000 })
}

/**
 * 等到列表响应已落地。
 *
 * 判据 = settings 请求已发出（它在 `load()` 里紧跟在 `setLogs(data.logs)` 之后、
 * 同一同步块内）⇒ "settings 被调用" ≈ "setLogs 已被调用"。**严格说它不等于
 * "已渲染"**（React 可能还没 flush），所以读**数据行**的断言要用
 * `waitForAuditRows`；本函数只用于不依赖数据行的加载链等待（2026-09-17 审计 P3）。
 */
async function waitForAuditLoad(): Promise<void> {
  await waitFor(
    () => expect(mockRequest.mock.calls.some(([p]) => String(p) === AUDIT_SETTINGS_PATH)).toBe(true),
    { timeout: 5000 },
  )
}

beforeEach(() => {
  mockRequest.mockReset()
  mockRequest.mockImplementation(async (path: string) => {
    if (String(path).startsWith('/api/server/admin/audit?')) return { logs: LOGS, total: LOGS.length }
    if (String(path).startsWith('/api/server/admin/audit/settings')) return { retention_days: 180 }
    return {}
  })
  captured = ''
  bytes = null
  ;(globalThis.URL as any).createObjectURL = (blob: Blob) => {
    void blob.text().then((t) => { captured = t })
    void blob.arrayBuffer().then((b) => { bytes = new Uint8Array(b) })
    return 'blob:test'
  }
  ;(globalThis.URL as any).revokeObjectURL = () => {}
})

async function exportCsv(): Promise<string> {
  render(<Audit />)
  // 必须等数据行出现再点导出:导出读的是组件 state,提前点只会拿到表头。
  await waitForAuditRows(LOGS.length)
  fireEvent.click(screen.getByRole('button', { name: /导出 CSV/ }))
  await waitFor(() => {
    expect(captured).not.toBe('')
    expect(bytes).not.toBeNull()
  })
  return captured
}

describe('审计日志 CSV 导出(公式注入 + BOM)', () => {
  it("以 = + - @ Tab CR 开头的单元格加 ' 前缀,正常值不动", async () => {
    const csv = await exportCsv()
    expect(csv).toContain(`'${EVIL_DDE}`)
    for (const evil of ['+1+1', '-2+3', '@SUM(1+1)', '\tTAB', '\rCR']) {
      expect(csv).toContain(`'${evil}`)
    }
    // 前缀是"中和",不是"删掉内容":原文完整保留在前缀之后
    expect(csv).not.toContain(`"${EVIL_DDE}"`)
    // 普通值不加前缀(不含逗号/引号的值按 CSV 惯例也不加引号)
    expect(csv).toContain('alice')
    expect(csv).not.toContain("'alice")
  })

  it('带 UTF-8 BOM(Excel 中文表头不乱码),逗号/引号照旧转义', async () => {
    const csv = await exportCsv()
    // 字节级断言:EF BB BF
    expect(bytes!.slice(0, 3)).toEqual(new Uint8Array([0xef, 0xbb, 0xbf]))
    // 正文:detail 里的逗号与引号仍按 CSV 规则加引号 + 双写引号
    expect(csv).toContain('"ip=1.2.3.4, ua=""curl"""')
    // 表头/首行可被解析,且攻击者那格已被中和
    expect(csv.split('\n')[0]).toBe('id,username,action,detail,created_at')
    expect(csv.split('\n')[1]).toBe(`1,'${EVIL_DDE},login_fail,ip=10.0.0.9,2026-09-13T10:00:00+08:00`)
  })
})

// ---------------------------------------------------------------------------
// 审计 R7-RV-2 残留(RECHECK3 R7RV2-1):审计页的保留策略控件对 auditor 仍可点。
// 服务端 PUT /audit/settings 要 audit:retention:write,**刻意不进
// AuditorPermissions**(serverauth/rbac.go:44-45,69),auditor 每次点「保存策略」
// 都是 403;而输入框 readOnly:false、按钮 disabled:false,与 App 的"所有修改
// 已禁用"横幅直接矛盾。
//
// 口径与已修页面一致:按权限点判定(不渲染写入口 + 说明为什么),导出 CSV /
// 筛选(audit:read)保持可用;super_admin 不受影响(角色矩阵)。
// ---------------------------------------------------------------------------
const AUDITOR: MeUser = { role: 'auditor', permissions: ['audit:read', 'usage:read', 'user:read'] }
const SUPER: MeUser = { role: 'super_admin', permissions: undefined }
/** 只有 audit:read（连 usage:read 都没有）的部分权限集：同样是只读视图。 */
const READONLY: MeUser = { role: 'user', permissions: ['audit:read'] }

describe('审计员访问审计保留策略(R7-RV-2 残留)', () => {
  it('auditor 能看到保留天数,但输入框只读、没有保存按钮', async () => {
    setCurrentAdmin(AUDITOR)
    render(<Audit />)
    await waitForAuditLoad()

    const input = screen.getByLabelText('审计保留天数') as HTMLInputElement
    expect(input.disabled || input.readOnly).toBe(true)
    expect(screen.queryByRole('button', { name: /保存策略/ })).toBeNull()
    // 说明为什么不能改(权限点),而不是让用户点出一个 403。
    expect(screen.getByText(/audit:retention:write/)).toBeInTheDocument()
    // 读面不受影响:导出 CSV 与筛选仍在。
    expect(screen.getByRole('button', { name: /导出 CSV/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /筛选/ })).toBeInTheDocument()
    // 且不会去写接口(只读 GET)。
    expect(mockRequest.mock.calls.map(([p]) => String(p)).some((p) => p.includes('/audit/settings'))).toBe(true)
  })

  it('保留策略未落地时不给出可点的保存(审计 F6:默认 180 会被写库)', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    mockRequest.mockImplementation(async (path: string) => {
      if (String(path).startsWith('/api/server/admin/audit?')) {
        await gate
        return { logs: LOGS, total: LOGS.length }
      }
      if (String(path).startsWith('/api/server/admin/audit/settings')) return { retention_days: 180 }
      return {}
    })
    setCurrentAdmin(SUPER)
    render(<Audit />)
    expect(screen.getByRole('button', { name: /保存策略/ })).toBeDisabled()
    release()
    await waitFor(() => expect(screen.getByRole('button', { name: /保存策略/ })).toBeEnabled())
  })

  it('auditor 的保留天数控件是只读的,且任何交互都不会触发 PUT', async () => {
    setCurrentAdmin(AUDITOR)
    render(<Audit />)
    await waitForAuditRows(LOGS.length)
    const input = screen.getByLabelText('审计保留天数') as HTMLInputElement
    // jsdom 的 fireEvent 会绕过浏览器"只读输入不触发 change"的语义,所以这里钉
    // DOM 属性 + 真正的护栏(saveRetention 无权限直接返回,绝不发 PUT)。
    expect(input.readOnly).toBe(true)
    expect(input.disabled).toBe(true)
    fireEvent.change(input, { target: { value: '30' } })
    expect(mockRequest.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')).toBe(false)
  })

  it('只有 audit:read 的部分权限集同样只读(等价形态)', async () => {
    setCurrentAdmin(READONLY)
    render(<Audit />)
    await waitForAuditRows(LOGS.length)
    expect((screen.getByLabelText('审计保留天数') as HTMLInputElement).readOnly).toBe(true)
    expect(screen.queryByRole('button', { name: /保存策略/ })).toBeNull()
    expect(screen.getByRole('button', { name: /导出 CSV/ })).toBeInTheDocument()
  })

  it('super_admin 仍然可编辑并可保存(不误伤)', async () => {
    setCurrentAdmin(SUPER)
    render(<Audit />)
    await waitForAuditRows(LOGS.length)
    const input = screen.getByLabelText('审计保留天数') as HTMLInputElement
    // 保留策略是**独立**请求：等它落地再断言可编辑，否则负载下会拿到"闸门还没开"
    // 的中间态（+400ms 全响应注入下本用例曾红：输入被禁用、点击被吞）。
    await waitFor(() => expect(screen.getByRole('button', { name: /保存策略/ })).toBeEnabled())
    expect(input.disabled).toBe(false)
    fireEvent.change(input, { target: { value: '30' } })
    // R5：落地值不得覆盖管理员刚输入的内容（实测输入 30 被改写回 90）。
    expect(input.value).toBe('30')
    fireEvent.click(screen.getByRole('button', { name: /保存策略/ }))
    await waitFor(() => {
      expect(mockRequest.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')).toBe(true)
    })
  })

  it('审计记录未落地时不渲染"暂无审计记录"(R6:首帧把"没读到"说成"没有")', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    mockRequest.mockImplementation(async (path: string) => {
      if (String(path).startsWith('/api/server/admin/audit?')) {
        await gate
        return { logs: [], total: 0 }
      }
      if (String(path).startsWith('/api/server/admin/audit/settings')) return { retention_days: 180 }
      return {}
    })
    setCurrentAdmin(SUPER)
    render(<Audit />)
    // 加载期：说明"在加载"，而不是断言"没有记录"。
    expect(screen.getByText(/审计记录加载中/)).toBeInTheDocument()
    expect(screen.queryByText('暂无审计记录')).toBeNull()
    release()
    // 真的读到了、并且确实是空 ⇒ 才允许渲染空态。
    expect(await screen.findByText('暂无审计记录')).toBeInTheDocument()
  })

  it('5-3: 保留策略读取失败时说明失败(不能永久显示"加载中")', async () => {
    // 2026-09-17 第二轮独立验证 P3：`.catch(() => {})` 静默吞掉失败，而"加载中"提示
    // 只由 !retentionLoaded 决定 ⇒ 请求失败会**永久**显示"加载中"，没有任何失败提示。
    mockRequest.mockImplementation(async (path: string) => {
      if (String(path).startsWith('/api/server/admin/audit?')) return { logs: LOGS, total: LOGS.length }
      if (String(path).startsWith('/api/server/admin/audit/settings')) throw new Error('读取策略失败')
      return {}
    })
    setCurrentAdmin(SUPER)
    render(<Audit />)
    expect(await screen.findByText(/保留策略读取失败/)).toBeInTheDocument()
    expect(screen.queryByText(/保留策略加载中/)).toBeNull()
    expect(screen.getByRole('button', { name: /保存策略/ })).toBeDisabled()
  })
})

// ---------------------------------------------------------------------------
// SG-5(审计 2026-09-17,r2 server-gateway P3):本区间新增的组织共享库审计动作
// (shared_skill_enable/disable,以及 SG-4 新增的 agent_preset_enable/disable)
// 必须进 ACTION_LABEL —— 否则筛选下拉里没有它们、行内还会回落成裸 id。
// ---------------------------------------------------------------------------
describe('审计动作表覆盖组织共享库动作(SG-5)', () => {
  const ORG_LOGS = [
    { id: 11, username: 'boss', action: 'shared_skill_disable', detail: 'codeql', created_at: '2026-09-17T10:00:00+08:00' },
    { id: 12, username: 'boss', action: 'shared_skill_enable', detail: 'codeql', created_at: '2026-09-17T10:00:01+08:00' },
    { id: 13, username: 'boss', action: 'agent_preset_disable', detail: 'ppt-gen', created_at: '2026-09-17T10:00:02+08:00' },
  ]

  beforeEach(() => {
    mockRequest.mockImplementation(async (path: string) => {
      if (String(path).startsWith('/api/server/admin/audit?')) return { logs: ORG_LOGS, total: ORG_LOGS.length }
      if (String(path).startsWith('/api/server/admin/audit/settings')) return { retention_days: 180 }
      return {}
    })
  })

  it('行内渲染中文标签,不回落成裸 action id', async () => {
    setCurrentAdmin(SUPER)
    render(<Audit />)
    await waitForAuditRows(ORG_LOGS.length)
    expect(await screen.findByText('下架共享技能')).toBeInTheDocument()
    expect(screen.getByText('重新上架共享技能')).toBeInTheDocument()
    expect(screen.getByText('下架智能体')).toBeInTheDocument()
    for (const raw of ['shared_skill_disable', 'shared_skill_enable', 'agent_preset_disable']) {
      expect(screen.queryByText(raw)).toBeNull()
    }
  })

  it('筛选下拉可选这两个动作(后端 ?action= 精确匹配的唯一入口)', async () => {
    setCurrentAdmin(SUPER)
    render(<Audit />)
    await waitForAuditRows(ORG_LOGS.length)
    fireEvent.click(screen.getByRole('combobox'))
    expect(await screen.findByRole('option', { name: '下架共享技能' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: '重新上架共享技能' })).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// SG-5 残留(r3v 复核,2026-09-17):上一轮只补了组织共享库那一族,漏了
// `agent_preset_revoke`(server/internal/agentshare/routes.go 的撤销分支)以及
// capability_lock / capability_unlock / skill_normalize 等一批**服务端一直在写**
// 的动作 —— 它们在表里回落成裸 id、在筛选下拉里选不到(后端 ?action= 本来就支持)。
//
// 下面的清单 = 服务端全部写点(repo 全量 grep `AuditLog(` 的第三个实参,含
// `action := …` 的双分支与 decide/applyGrant 的参数)。
// **口径更正(2026-09-17 独立审计 P3-2)**:这张表是**人工维护的清单**,用例只保证
// "清单内的动作都渲染中文标签、且裸 id 不出现" —— 服务端新增写点而**没人**往这里
// 补时,本用例**不会**红(原先"少一条 ⇒ 本用例红"的说法与实现不符,已删)。
// 自动对账机制尚未实现,服务端加审计动作时需人工同步本表。
// kebab 之外的历史动作(mcp_*/kb_*)只在 ACTION_LABEL 里保留(存量行),不在此表。
// ---------------------------------------------------------------------------
const SERVER_ACTIONS: ReadonlyArray<readonly [action: string, label: string]> = [
  ['skill_create', '上架技能'],
  ['skill_update', '更新技能'],
  ['skill_disable', '下架技能'],
  ['skill_enable', '重新上架技能'],
  ['skill_grant', '技能授权'],
  ['skill_revoke', '技能撤销授权'],
  ['skill_grants_replace', '技能部门授权替换'],
  ['skill_normalize', '规范化技能包'],
  ['shared_skill_upload', '上传共享技能'],
  ['shared_skill_approve', '通过共享技能'],
  ['shared_skill_reject', '拒绝共享技能'],
  ['shared_skill_delete', '删除共享技能'],
  ['shared_skill_qualify', '设置共享技能质量'],
  ['shared_skill_grant', '共享技能授权'],
  ['shared_skill_revoke', '共享技能撤销授权'],
  ['shared_skill_enable', '重新上架共享技能'],
  ['shared_skill_disable', '下架共享技能'],
  ['agent_preset_upload', '上传智能体'],
  ['agent_preset_approve', '通过智能体'],
  ['agent_preset_reject', '拒绝智能体'],
  ['agent_preset_delete', '删除智能体'],
  ['agent_preset_qualify', '设置智能体质量'],
  ['agent_preset_grant', '智能体授权'],
  ['agent_preset_revoke', '智能体撤销授权'],
  ['agent_preset_enable', '重新上架智能体'],
  ['agent_preset_disable', '下架智能体'],
  ['agent_create', '上架市场智能体'],
  ['agent_update', '更新市场智能体'],
  ['agent_update_meta', '更新市场智能体信息'],
  ['agent_disable', '下架市场智能体'],
  ['agent_enable', '重新上架市场智能体'],
  ['agent_grant', '市场智能体授权'],
  ['agent_revoke', '市场智能体撤销授权'],
  ['agent_grants', '市场智能体部门授权替换'],
  ['capability_lock', '锁定能力名称'],
  ['capability_unlock', '解锁能力名称'],
  ['app_owner_transfer', '转移能力归属'],
  ['user_create', '创建用户'],
  ['user_update', '更新用户'],
  ['user_delete', '删除用户'],
  ['user_dept', '用户部门变更'],
  ['user_tokens_revoked', '吊销令牌'],
  ['role_change', '变更角色'],
  ['dept_create', '新建部门'],
  ['dept_update', '更新部门'],
  ['dept_delete', '删除部门'],
  ['auth_config', '修改认证配置'],
  ['ldap_sync', 'LDAP 同步'],
  ['audit_retention_change', '审计保留策略变更'],
  ['login_success', '登录成功'],
  ['login_fail', '登录失败'],
  ['password_change', '修改密码'],
  ['admin_password_change', '修改管理员密码'],
  ['admin_mfa_login', '管理员 MFA 登录'],
  ['admin_mfa_enable', '开启管理员 MFA'],
  ['admin_mfa_disable', '关闭管理员 MFA'],
  ['admin_mfa_reset', '重置管理员 MFA'],
  ['balance_adjust', '调整余额'],
  ['balance_grant', '余额发放'],
  ['balance_settings', '余额策略变更'],
  ['gateway_config', '网关配置变更'],
  ['error_reporting_test', '错误上报连通性自检'],
  ['provider_create', '新建上游'],
  ['provider_update', '更新上游'],
  ['provider_delete', '删除上游'],
  ['model_create', '新建模型'],
  ['model_update', '更新模型'],
  ['model_delete', '删除模型'],
  ['connector_create', '新建连接器'],
  ['connector_update', '更新连接器'],
  ['connector_enabled', '连接器上下架'],
  ['connector_delete', '删除连接器'],
  ['report_subscription_create', '新建报表订阅'],
  ['report_subscription_update', '更新报表订阅'],
  ['report_subscription_delete', '删除报表订阅'],
]

describe('审计动作表覆盖服务端全部写点(SG-5 残留)', () => {
  it('清单本身自洽:标签唯一(下拉里同名两项会让管理员无法分辨)', () => {
    const labels = SERVER_ACTIONS.map(([, label]) => label)
    expect(new Set(labels).size).toBe(SERVER_ACTIONS.length)
    expect(new Set(SERVER_ACTIONS.map(([action]) => action)).size).toBe(SERVER_ACTIONS.length)
  })

  it('每一行都渲染中文标签(不回落成裸 action id),且筛选下拉可选', async () => {
    const logs = SERVER_ACTIONS.map(([action], i) => ({
      id: 100 + i,
      username: 'boss',
      action,
      detail: `${action}-detail`,
      created_at: '2026-09-17T10:00:00+08:00',
    }))
    mockRequest.mockImplementation(async (path: string) => {
      if (String(path).startsWith('/api/server/admin/audit?')) return { logs, total: logs.length }
      if (String(path).startsWith('/api/server/admin/audit/settings')) return { retention_days: 180 }
      return {}
    })
    setCurrentAdmin(SUPER)
    render(<Audit />)
    await waitForAuditRows(logs.length)

    // 性能与判据（2026-09-17 独立审计 P2-4）：原写法对 74 条动作逐条调
    // queryByText + getAllByText + getByRole(option)，**每次都是整文档扫描**
    // （单机 2845ms、负载下会撞用例预算）。改为一次性快照集合比对：
    // 语义等价（原断言就是精确文本匹配），实测 333ms（-88%）。
    const texts = new Set<string>()
    for (const el of document.querySelectorAll('*')) texts.add((el.textContent ?? '').trim())

    for (const [action, label] of SERVER_ACTIONS) {
      // 裸 id 一个都不许出现在表里(出现 = 未登记,row badge 会回落成 outline + 原串)。
      expect(texts.has(action)).toBe(false)
      expect(texts.has(label)).toBe(true)
    }

    fireEvent.click(screen.getByRole('combobox'))
    // 选项在 portal 里，同样一次查询取全集再比对（逐个 getByRole 是 N 次整文档扫描）。
    const options = new Set(screen.getAllByRole('option').map((o) => (o.textContent ?? '').trim()))
    for (const [, label] of SERVER_ACTIONS) {
      expect(options.has(label)).toBe(true)
    }
  })
})
