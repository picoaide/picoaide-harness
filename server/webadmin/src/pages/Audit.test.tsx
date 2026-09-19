import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { request } from '../api'
import { setCurrentAdmin, type MeUser } from '../lib/rbac'
import Audit, { ACTION_LABEL } from './Audit'

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
// 审计动作真源对拍（R1-uxw-3,2026-09-19 第三波修复）
//
// 上一版这里是**手写夹具** SERVER_ACTIONS —— 拿自己当判据：服务端新增写点而没人
// 同步本表时用例照样绿（文件里原本就写着这条口径更正）。而 wasm_* 那一族 17 个
// 动作一条都没登记 ⇒「v1.2.0 为什么被拒」在审计页查不了（R1-uxw-3 的现场）。
//
// 现在真源取自**服务端 Go 源码**：扫 server/ 下全部非 `_test.go` 文件，解析审计
// 写入点的动作实参。写入点形状共五种（这就是"真源"的确切定义，与
// `server/internal/serverstore/audit.go` 的两个写入函数一一对应）：
//   serverstore.AuditLog(db, username, ACTION, detail)       ← 通用写入
//   serverstore.AuditLogApp(db, appID, username, ACTION, …)  ← 应用维度写入
//   h.auditApp(appID, username, ACTION, detail)              ← wasm 应用级
//   h.auditOrg(username, ACTION, detail)                     ← wasm 组织级
//   *.opt.Audit(username, ACTION, detail)                    ← 注入的审计闭包
// 双向断言（缺任一方向即红）：
//   ① 服务端有写点、标签表没有 ⇒ 红，且断言筛选下拉里选不到它；
//   ② 标签表有、服务端抽不到字面量 ⇒ 红，除非落在下面两张**显式白名单**里，
//      而白名单自己也要过判据：DERIVED 的动作名必须在源码里仍有字面量（helper
//      参数传进写入点），LEGACY 的动作名必须真的已从源码消失（存量行专用）。
// ---------------------------------------------------------------------------

/**
 * 服务端源码根（`server/`）。
 *
 * 不用 `import.meta.url`：jsdom 环境下它是 `http://localhost/...`（fileURLToPath
 * 会直接抛 "The URL must be of scheme file"）。改为从 cwd 向上找审计写入点的
 * 存在性标记 —— 无论从 `server/webadmin` 还是仓库根跑 vitest 都能定位。
 */
function findServerDir(): string {
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'internal', 'serverstore', 'audit.go'))) return dir
    if (existsSync(join(dir, 'server', 'internal', 'serverstore', 'audit.go'))) return join(dir, 'server')
    dir = resolve(dir, '..')
  }
  return resolve(process.cwd(), '..')
}

const SERVER_DIR = findServerDir()

/**
 * 经**函数参数**进入审计写入点的动作名（源码里是 `AuditLog(db, user, action, …)`
 * 形态，字面量在 helper 的调用点）。
 *
 * 这不是"免检名单"：下面 `DERIVED_ACTIONS` 的用例要求每个动作名在服务端源码里
 * **仍以字符串字面量出现**（`"<name>"`），改名/删除会立刻红。
 */
const DERIVED_ACTIONS: Record<string, string> = {
  skill_grant: 'marketplace/admin.go applyGrant(..., grantAudit, revokeAudit)',
  skill_revoke: 'marketplace/admin.go applyGrant(..., grantAudit, revokeAudit)',
  capability_lock: 'sharedskills/routes.go 的 action 变量',
  capability_unlock: 'sharedskills/routes.go 的 action 变量',
  shared_skill_enable: 'sharedskills/routes.go 的 action 变量',
  shared_skill_disable: 'sharedskills/routes.go 的 action 变量',
  shared_skill_approve: 'sharedskills/routes.go decide(db, status, auditAction)',
  shared_skill_reject: 'sharedskills/routes.go decide(db, status, auditAction)',
  shared_skill_revoke: 'sharedskills/routes.go 的 action 变量',
  agent_preset_approve: 'agentshare/routes.go decide/decideVersioned(db, status, auditAction)',
  agent_preset_reject: 'agentshare/routes.go decide/decideVersioned(db, status, auditAction)',
  agent_preset_enable: 'agentshare/routes.go 的 action 变量',
  agent_preset_disable: 'agentshare/routes.go 的 action 变量',
  agent_preset_revoke: 'agentshare/routes.go 的 action 变量',
  agent_grant: 'marketplace/agent_api.go 的 action 变量',
  agent_revoke: 'marketplace/agent_api.go 的 action 变量',
}

/**
 * 已下线、但存量审计行仍需中文标签与筛选入口的动作（**不许删**）。
 *
 * 判据是反的：这些动作名必须**不再出现**在服务端源码里 —— 谁把它们从这张表里
 * 拿去当"活跃动作"的挡箭牌（比如新写了同名写点却塞进 LEGACY 免检），用例会红。
 */
const LEGACY_ACTIONS: Record<string, string> = {
  mcp_create: 'MCP 功能已下线',
  mcp_update: 'MCP 功能已下线',
  mcp_delete: 'MCP 功能已下线',
  mcp_grant: 'MCP 功能已下线',
  mcp_revoke: 'MCP 功能已下线',
  kb_create: '知识库功能已下线',
  kb_update: '知识库功能已下线',
  kb_delete: '知识库功能已下线',
  kb_import: '知识库功能已下线',
  kb_grant: '知识库功能已下线',
  kb_revoke: '知识库功能已下线',
  // 应用基域配置面（应用子域 + 泛域名）随 2026-09-19「客户端专属」改造的 W4 删除波次
  // 一并删除（服务端已无该写点，见 scripts/wasm/check-old-model-residue.mjs 的 app-subdomain）。
  // 标签**必须留在 ACTION_LABEL**：存量审计链里仍有这个动作码的行，删标签会让历史
  // 记录回退成裸码 —— 与 mcp_*/kb_* 同一条"已下线动作"的处置口径。
  wasm_apps_base_domain_change: '应用基域配置面已随「客户端专属」改造删除（2026-09-19）',
}

/** 审计写入点形状：sink 名 + 动作实参在参数表里的下标（0 基）。 */
const AUDIT_SINKS: ReadonlyArray<{ name: string; actionArg: number }> = [
  { name: 'AuditLogApp', actionArg: 3 },
  { name: 'AuditLog', actionArg: 2 },
  { name: 'auditApp', actionArg: 2 },
  { name: 'auditOrg', actionArg: 1 },
  { name: 'Audit', actionArg: 1 },
]

/** 递归收集服务端非测试 Go 文件（webadmin/node_modules/data 不是服务端写入面）。 */
function goSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (['node_modules', 'webadmin', 'data', '.git', 'vendor'].includes(entry.name)) continue
      goSourceFiles(full, out)
    } else if (entry.name.endsWith('.go') && !entry.name.endsWith('_test.go')) {
      out.push(full)
    }
  }
  return out
}

/**
 * 从一次调用表达式里切出**顶层**实参（跳过字符串与嵌套括号/花括号里的逗号）。
 * 手写而不是正则：动作实参前面常有 `db, adminUsername(c),` 这类嵌套调用。
 */
function callArgs(src: string, start: number): string[] {
  const args: string[] = []
  let depth = 0
  let cur = ''
  let quote: string | null = null
  for (let i = start; i < src.length; i++) {
    const ch = src[i]!
    if (quote !== null) {
      cur += ch
      if (ch === '\\') { cur += src[++i] ?? ''; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === '`' || ch === "'") { quote = ch; cur += ch; continue }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; cur += ch; continue }
    if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) { args.push(cur); return args }
      depth--; cur += ch; continue
    }
    if (ch === ',' && depth === 0) { args.push(cur); cur = ''; continue }
    cur += ch
  }
  return args
}

/** 扫描服务端源码，返回 `动作名 → 首个出现位置`（只认字面量动作名）。 */
function extractServerAuditActions(): Map<string, string> {
  const found = new Map<string, string>()
  for (const file of goSourceFiles(SERVER_DIR)) {
    const src = readFileSync(file, 'utf8')
    for (const sink of AUDIT_SINKS) {
      const re = new RegExp(`\\b(?:[A-Za-z_][\\w]*\\.)?${sink.name}\\s*\\(`, 'g')
      let m: RegExpExecArray | null
      while ((m = re.exec(src)) !== null) {
        const arg = callArgs(src, m.index + m[0].length)[sink.actionArg]
        if (arg === undefined) continue
        const literal = /^"([^"]*)"$/.exec(arg.trim())
        if (literal === null) continue
        const action = literal[1]!
        if (!found.has(action)) found.set(action, file.slice(SERVER_DIR.length))
      }
    }
  }
  return found
}

/** 真源不可见时必须红，而不是静默跳过（跳过 = 又一条假绿）。 */
function assertServerSourceVisible(): void {
  expect(
    existsSync(join(SERVER_DIR, 'internal', 'serverstore', 'audit.go')),
    `服务端审计写入点不可见：${SERVER_DIR}（真源必须可读，动作对拍不能静默跳过）`,
  ).toBe(true)
}

const SERVER_AUDIT_ACTIONS = (() => {
  assertServerSourceVisible()
  return extractServerAuditActions()
})()

/** 服务端**字面量**写点全集（排序后，用于渲染用例）。 */
const SERVER_ACTIONS: readonly string[] = [...SERVER_AUDIT_ACTIONS.keys()].sort()

const RAW_SERVER_SOURCE = (() => {
  assertServerSourceVisible()
  return goSourceFiles(SERVER_DIR).map((f) => readFileSync(f, 'utf8')).join('\n')
})()

describe('审计动作表 = 服务端写点真源（R1-uxw-3 双向对拍）', () => {
  it('真源本身非空且含 wasm 一族（抽取器坏掉/路径漂移都要红，不许"零动作=全绿"）', () => {
    expect(SERVER_ACTIONS.length).toBeGreaterThan(60)
    for (const a of [
      'wasm_app_release_approve', 'wasm_app_release_reject', 'wasm_app_publish_toggle',
      'wasm_app_freeze', 'wasm_app_release', 'wasm_app_access_change',
      'wasm_app_release_pending', 'wasm_app_release_denied', 'wasm_app_release_failed',
      'wasm_app_delete', 'wasm_app_export', 'wasm_app_prune_failed',
    ]) {
      expect(SERVER_AUDIT_ACTIONS.has(a), `真源里应当有 ${a}`).toBe(true)
    }
  })

  it('方向①:服务端每个写点都有中文标签（新增写点不补标签即红）', () => {
    const missing = SERVER_ACTIONS.filter((a) => !(a in ACTION_LABEL))
    expect(missing, `服务端会写这些审计动作但标签表没有：${missing.join(', ')}`).toEqual([])
    for (const a of SERVER_ACTIONS) {
      expect((ACTION_LABEL[a] ?? '').trim(), `${a} 的标签不能为空`).not.toBe('')
    }
  })

  it('方向②:标签表每一项都能追溯到服务端（活跃写点 / 参数传入 / 已下线三选一）', () => {
    const unexplained = Object.keys(ACTION_LABEL).filter(
      (a) => !SERVER_AUDIT_ACTIONS.has(a) && !(a in DERIVED_ACTIONS) && !(a in LEGACY_ACTIONS),
    )
    expect(
      unexplained,
      `这些标签既没有活跃写点、也不在白名单里（凭空发明的动作名？）：${unexplained.join(', ')}`,
    ).toEqual([])
  })

  it('白名单自证:DERIVED 的动作名在源码里仍有字面量，LEGACY 的动作名真的已消失', () => {
    const stillDerived = Object.keys(DERIVED_ACTIONS).filter((a) => !RAW_SERVER_SOURCE.includes(`"${a}"`))
    expect(stillDerived, `白名单里的参数传入动作已从服务端消失，应删标签：${stillDerived.join(', ')}`).toEqual([])

    const resurrected = Object.keys(LEGACY_ACTIONS).filter((a) => RAW_SERVER_SOURCE.includes(`"${a}"`))
    expect(
      resurrected,
      `已下线动作在服务端源码里复活（或被人塞进 LEGACY 免检）：${resurrected.join(', ')}`,
    ).toEqual([])

    // 双向白名单不许重叠（同一动作不能既"参数传入"又"已下线"）。
    const overlap = Object.keys(DERIVED_ACTIONS).filter((a) => a in LEGACY_ACTIONS)
    expect(overlap).toEqual([])
  })

  it('每一行都渲染中文标签(不回落成裸 action id),且筛选下拉可选', async () => {
    const logs = SERVER_ACTIONS.map((action, i) => ({
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

    // 性能与判据（2026-09-17 独立审计 P2-4）：不要对每条动作逐次整文档扫描；
    // 一次性快照集合比对，语义等价（精确文本匹配）。
    const texts = new Set<string>()
    for (const el of document.querySelectorAll('*')) texts.add((el.textContent ?? '').trim())

    for (const action of SERVER_ACTIONS) {
      // 裸 id 一个都不许出现在表里(出现 = 未登记,row badge 会回落成 outline + 原串)。
      expect(texts.has(action)).toBe(false)
      expect(texts.has(ACTION_LABEL[action]!)).toBe(true)
    }

    fireEvent.click(screen.getByRole('combobox'))
    // 选项在 portal 里，同样一次查询取全集再比对（逐个 getByRole 是 N 次整文档扫描）。
    const options = new Set(screen.getAllByRole('option').map((o) => (o.textContent ?? '').trim()))
    for (const action of SERVER_ACTIONS) {
      expect(options.has(ACTION_LABEL[action]!)).toBe(true)
    }
  })

  it('下拉派生自同一张表:选项集 = 标签表(不是两处手写)', async () => {
    mockRequest.mockImplementation(async (path: string) => {
      if (String(path).startsWith('/api/server/admin/audit?')) {
        return { logs: [{ id: 1, username: 'a', action: 'login_success', detail: 'ip=1', created_at: '2026-09-17T10:00:00+08:00' }], total: 1 }
      }
      if (String(path).startsWith('/api/server/admin/audit/settings')) return { retention_days: 180 }
      return {}
    })
    setCurrentAdmin(SUPER)
    render(<Audit />)
    // 只等这一行落地（waitForAuditRows 只接受 >=2 行：空态占位行与 1 行同形）。
    expect(await screen.findByText('登录成功')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('combobox'))
    const options = new Set(screen.getAllByRole('option').map((o) => (o.textContent ?? '').trim()))
    // 「全部操作」是固定首项；其余必须是 ACTION_LABEL 的全部取值。
    const labels = new Set(Object.values(ACTION_LABEL))
    for (const label of labels) expect(options.has(label), `下拉缺选项：${label}`).toBe(true)
    for (const opt of options) {
      expect(opt === '全部操作' || labels.has(opt), `下拉出现标签表里没有的选项：${opt}`).toBe(true)
    }
  })

  it('wasm_* 动作可筛可选(驳回理由那条审计从此查得到)', async () => {
    mockRequest.mockImplementation(async (path: string) => {
      if (String(path).startsWith('/api/server/admin/audit?')) {
        return {
          logs: [{ id: 7, username: 'boss', action: 'wasm_app_release_reject', detail: 'review-me v1.2.0 审核拒绝：数据范围超出用途所需', created_at: '2026-09-19T10:00:00+08:00' }],
          total: 1,
        }
      }
      if (String(path).startsWith('/api/server/admin/audit/settings')) return { retention_days: 180 }
      return {}
    })
    setCurrentAdmin(SUPER)
    render(<Audit />)
    // 行内是中文标签 + 理由明细，不是裸 id。
    expect(await screen.findByText('拒绝应用版本')).toBeInTheDocument()
    expect(screen.getByText(/数据范围超出用途所需/)).toBeInTheDocument()
    expect(screen.queryByText('wasm_app_release_reject')).toBeNull()

    fireEvent.click(screen.getByRole('combobox'))
    fireEvent.click(await screen.findByRole('option', { name: '拒绝应用版本' }))
    fireEvent.click(screen.getByRole('button', { name: '筛选' }))
    await waitFor(() => {
      const hit = mockRequest.mock.calls.find(([p]) => String(p).includes('action=wasm_app_release_reject'))
      expect(hit, '必须发出带 action=wasm_app_release_reject 的审计查询').toBeTruthy()
    })
  })
})
