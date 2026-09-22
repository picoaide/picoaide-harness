import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { request } from '../api'
import GatewayFiles from './GatewayFiles'

// ---------------------------------------------------------------------------
// 网关文件台账页（2026-09-22）
//
// 硬口径（每条都能被打坏）：
//   ① 过滤/排序/分页**全部进查询串**（员工、file_id 搜索、状态、排序键与方向、
//      页码与页大小）—— 页面不得本地伪造过滤结果；
//   ② 批量清理**必须带条件**：无条件时前端直接拒绝、不发请求（服务端也会 400，
//      这是两层防护的第二层）；
//   ③ 删除与清理都要二次确认（清理还要求输入确认词）；
//   ④ 上游/服务端的失败原因必须显示出来，不能只把表格留空。
// ---------------------------------------------------------------------------

const mockRequest = vi.mocked(request)

const ROWS = [
  {
    file_id: 'file-api-aaa', user_id: 1, username: 'alice', display_name: 'Alice',
    size_bytes: 1024, created_at: '2026-09-20T10:00:00Z', expires_at: '2026-09-27T10:00:00Z', expired: false,
  },
  {
    file_id: 'file-api-bbb', user_id: 2, username: 'bob', display_name: 'Bob',
    size_bytes: 3 * 1024 * 1024, created_at: '2026-09-10T10:00:00Z', expires_at: '2026-09-17T10:00:00Z', expired: true,
  },
]

const SUMMARY = [
  { user_id: 2, username: 'bob', display_name: 'Bob', files: 1, bytes: 3 * 1024 * 1024, expired_files: 1, earliest_expires_at: '2026-09-17T10:00:00Z' },
  { user_id: 1, username: 'alice', display_name: 'Alice', files: 1, bytes: 1024, expired_files: 0, earliest_expires_at: '2026-09-27T10:00:00Z' },
]

const TOTALS = { files: 2, bytes: 3 * 1024 * 1024 + 1024, expired: 1 }

/** 记录所有请求（含查询串），供"过滤进不进查询串"的断言使用。 */
function installMock() {
  const calls: { path: string; method: string; body?: string }[] = []
  mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({ path: String(path), method, body: init?.body ? String(init.body) : undefined })
    const base = String(path).split('?')[0]!
    if (base === '/api/server/admin/gateway/files') {
      return { rows: ROWS, total: ROWS.length, totals: TOTALS }
    }
    if (base === '/api/server/admin/gateway/files/summary') {
      return { rows: SUMMARY, totals: TOTALS }
    }
    if (method === 'DELETE') return { ok: true, deleted: 1 }
    if (base === '/api/server/admin/gateway/files/purge') return { ok: true, deleted: 1, failed: 0, matched: 1 }
    return {}
  })
  return calls
}

beforeEach(() => {
  mockRequest.mockReset()
  vi.restoreAllMocks()
})

describe('网关文件台账页', () => {
  it('渲染合计、按员工占用与明细，并把默认过滤条件发到服务端', async () => {
    const calls = installMock()
    render(<GatewayFiles />)

    await waitFor(() => expect(screen.getByText('file-api-aaa')).toBeTruthy())
    expect(screen.getByText('file-api-bbb')).toBeTruthy()
    // 合计卡：文件数 / 占用 / 其中已过期
    expect(screen.getByText('台账文件数')).toBeTruthy()
    expect(screen.getAllByText('2').length).toBeGreaterThan(0)
    expect(screen.getAllByText('3.0 MiB').length).toBeGreaterThan(0) // 汇总行 + 明细行
    // 状态徽标
    expect(screen.getAllByText('已过期').length).toBeGreaterThan(0) // 表头 + 徽标
    expect(screen.getAllByText('有效').length).toBeGreaterThan(0)
    // 默认查询串：分页 + 排序（不默认带 user/q/state）
    const list = calls.find((c) => c.path.startsWith('/api/server/admin/gateway/files?'))!
    expect(list.path).toContain('page=1')
    expect(list.path).toContain('size=20')
    expect(list.path).toContain('sort=created_at')
    expect(list.path).toContain('order=desc')
    expect(list.path).not.toContain('state=')
  })

  it('员工过滤 / file_id 搜索 / 状态筛选都进查询串，排序可切换方向', async () => {
    const calls = installMock()
    render(<GatewayFiles />)
    await waitFor(() => expect(screen.getByText('file-api-aaa')).toBeTruthy())

    fireEvent.change(screen.getByLabelText('员工（用户名或 ID）'), { target: { value: 'alice' } })
    fireEvent.change(screen.getByLabelText('搜索 file_id'), { target: { value: 'bbb' } })
    await waitFor(() => {
      const last = [...calls].reverse().find((c) => c.path.startsWith('/api/server/admin/gateway/files?'))!
      expect(last.path).toContain('user=alice')
      expect(last.path).toContain('q=bbb')
    })

    // 状态下拉（shadcn Select：点触发器后点选项）
    fireEvent.click(screen.getByLabelText('状态'))
    fireEvent.click(await screen.findByRole('option', { name: '已过期' }))
    await waitFor(() => {
      const last = [...calls].reverse().find((c) => c.path.startsWith('/api/server/admin/gateway/files?'))!
      expect(last.path).toContain('state=expired')
    })

    // 点列头切换排序（默认 created_at desc ⇒ 点一次变 asc）
    fireEvent.click(screen.getByText(/上传时间/))
    await waitFor(() => {
      const last = [...calls].reverse().find((c) => c.path.startsWith('/api/server/admin/gateway/files?'))!
      expect(last.path).toContain('order=asc')
    })
  })

  it('「只看此人」把员工过滤填成该用户名并重新查询', async () => {
    const calls = installMock()
    render(<GatewayFiles />)
    await waitFor(() => expect(screen.getByText('file-api-aaa')).toBeTruthy())

    const buttons = screen.getAllByText('只看此人')
    fireEvent.click(buttons[0]!)
    await waitFor(() => {
      const last = [...calls].reverse().find((c) => c.path.startsWith('/api/server/admin/gateway/files?'))!
      expect(last.path).toContain('user=bob') // 汇总第一行是 Bob（按占用降序）
    })
    expect((screen.getByLabelText('员工（用户名或 ID）') as HTMLInputElement).value).toBe('bob')
  })

  it('删除单条：二次确认后才发 DELETE', async () => {
    const calls = installMock()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<GatewayFiles />)
    await waitFor(() => expect(screen.getByText('file-api-aaa')).toBeTruthy())

    fireEvent.click(screen.getAllByText('删除')[0]!)
    await waitFor(() => {
      const del = calls.find((c) => c.method === 'DELETE')!
      expect(del.path).toBe('/api/server/admin/gateway/files/file-api-aaa')
    })
    expect(confirmSpy).toHaveBeenCalled()
  })

  it('删除单条：取消确认则不请求', async () => {
    const calls = installMock()
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<GatewayFiles />)
    await waitFor(() => expect(screen.getByText('file-api-aaa')).toBeTruthy())

    fireEvent.click(screen.getAllByText('删除')[0]!)
    await new Promise((r) => setTimeout(r, 20))
    expect(calls.filter((c) => c.method === 'DELETE').length).toBe(0)
  })

  it('批量清理：状态为「全部」时拒绝；选「有效」但没填员工也拒绝（都不发请求）', async () => {
    const calls = installMock()
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('确认')
    render(<GatewayFiles />)
    await waitFor(() => expect(screen.getByText('file-api-aaa')).toBeTruthy())

    // 默认状态 = 全部 ⇒ 必须先选状态（避免"全部状态"这种无边界范围）。
    fireEvent.click(screen.getByText('按条件清理'))
    await waitFor(() => expect(screen.getByText(/必须指定状态/)).toBeTruthy())

    // 选「有效」但不填员工 ⇒ 与服务端同口径拒绝。
    fireEvent.click(screen.getByLabelText('状态'))
    fireEvent.click(await screen.findByRole('option', { name: '有效' }))
    await waitFor(() => {
      const last = [...calls].reverse().find((c) => c.path.startsWith('/api/server/admin/gateway/files?'))!
      expect(last.path).toContain('state=active')
    })
    fireEvent.click(screen.getByText('按条件清理'))
    await waitFor(() => expect(screen.getByText(/必须指定员工/)).toBeTruthy())
    expect(calls.filter((c) => c.path.includes('/purge')).length).toBe(0)
    expect(promptSpy).not.toHaveBeenCalled()
  })

  it('批量清理：输入确认词后按当前条件发 POST，并回显删除结果', async () => {
    const calls = installMock()
    vi.spyOn(window, 'prompt').mockReturnValue('确认')
    render(<GatewayFiles />)
    await waitFor(() => expect(screen.getByText('file-api-aaa')).toBeTruthy())

    fireEvent.change(screen.getByLabelText('员工（用户名或 ID）'), { target: { value: 'bob' } })
    fireEvent.click(screen.getByLabelText('状态'))
    fireEvent.click(await screen.findByRole('option', { name: '已过期' }))
    await waitFor(() => {
      const last = [...calls].reverse().find((c) => c.path.startsWith('/api/server/admin/gateway/files?'))!
      expect(last.path).toContain('state=expired')
    })

    fireEvent.click(screen.getByText('按条件清理'))
    await waitFor(() => expect(screen.getByText(/清理完成：命中 1，删除 1，失败 0/)).toBeTruthy())
    const purge = calls.find((c) => c.path.includes('/purge'))!
    expect(purge.method).toBe('POST')
    expect(JSON.parse(purge.body!)).toEqual({ state: 'expired', user: 'bob' })
  })

  it('服务端失败时把原因显示出来（不是空表格）', async () => {
    mockRequest.mockImplementation(async (path: string) => {
      if (String(path).startsWith('/api/server/admin/gateway/files?')) throw new Error('读取文件台账失败')
      return { rows: [], totals: { files: 0, bytes: 0, expired: 0 } }
    })
    render(<GatewayFiles />)
    await waitFor(() => expect(screen.getByText(/读取文件台账失败/)).toBeTruthy())
  })
})
