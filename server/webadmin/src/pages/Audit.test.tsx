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
  await waitFor(() => expect(mockRequest).toHaveBeenCalled())
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
    await waitFor(() => expect(mockRequest).toHaveBeenCalled())

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

  it('auditor 的保留天数控件是只读的,且任何交互都不会触发 PUT', async () => {
    setCurrentAdmin(AUDITOR)
    render(<Audit />)
    await waitFor(() => expect(mockRequest).toHaveBeenCalled())
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
    await waitFor(() => expect(mockRequest).toHaveBeenCalled())
    expect((screen.getByLabelText('审计保留天数') as HTMLInputElement).readOnly).toBe(true)
    expect(screen.queryByRole('button', { name: /保存策略/ })).toBeNull()
    expect(screen.getByRole('button', { name: /导出 CSV/ })).toBeInTheDocument()
  })

  it('super_admin 仍然可编辑并可保存(不误伤)', async () => {
    setCurrentAdmin(SUPER)
    render(<Audit />)
    await waitFor(() => expect(mockRequest).toHaveBeenCalled())
    const input = screen.getByLabelText('审计保留天数') as HTMLInputElement
    expect(input.disabled).toBe(false)
    fireEvent.change(input, { target: { value: '30' } })
    expect(input.value).toBe('30')
    fireEvent.click(screen.getByRole('button', { name: /保存策略/ }))
    await waitFor(() => {
      expect(mockRequest.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')).toBe(true)
    })
  })
})
