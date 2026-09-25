import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { request } from '../api'
import { setCurrentAdmin } from '../lib/rbac'
import GatewayFiles, { fmtBytes, fmtDateTime, fmtTime } from './GatewayFiles'

// ---------------------------------------------------------------------------
// 网关文件台账页（2026-09-22）
//
// 硬口径（每条都能被打坏）：
//   ① 过滤/排序/分页**全部进查询串**（员工用户名、员工 ID、file_id 搜索、状态、
//      排序键与方向、页码与页大小）—— 页面不得本地伪造过滤结果；
//   ② 条件变化/排序/换页大小一律回到第 1 页；翻页只发一次请求；
//   ③ 批量清理**必须带条件**：无条件时前端直接拒绝、不发请求；删"有效"文件必须
//      指名员工；请求体逐字等于服务端契约 `{state, user?}`；`all` 原样下发
//      （不许悄悄收敛成 `expired`：确认框说的范围必须等于请求的范围）；
//   ④ 删除与清理都要二次确认（清理还要求输入确认词）；
//   ⑤ 上游/服务端的失败原因必须显示出来，且不得留着旧条件的行冒充新条件的结果；
//   ⑥ 服务端下发的 file_id/username/display_name 一律按**文本**渲染。
//
// 断言一律打**发出的查询串/请求体**（参数口径），不打"表格第一行是谁" ——
// 后者会被 mock 行序锁死，服务端排序改了也照绿。
// ---------------------------------------------------------------------------

const mockRequest = vi.mocked(request)

const TOTALS = { files: 2, bytes: 3 * 1024 * 1024 + 1024, expired: 1 }

function mkRow(over: Record<string, unknown> = {}) {
  return {
    file_id: 'file-api-aaa', user_id: 1, username: 'alice', display_name: 'Alice',
    size_bytes: 1024, created_at: '2026-09-20T10:00:00Z', expires_at: '2026-09-27T10:00:00Z', expired: false,
    ...over,
  }
}

function mkSummary(over: Record<string, unknown> = {}) {
  return {
    user_id: 1, username: 'alice', display_name: 'Alice', files: 1, bytes: 1024,
    expired_files: 0, earliest_expires_at: '2026-09-27T10:00:00Z', ...over,
  }
}

const DEFAULT_ROWS = [
  mkRow(),
  mkRow({
    file_id: 'file-api-bbb', user_id: 2, username: 'bob', display_name: 'Bob',
    size_bytes: 3 * 1024 * 1024, created_at: '2026-09-10T10:00:00Z',
    expires_at: '2026-09-17T10:00:00Z', expired: true,
  }),
]

const DEFAULT_SUMMARY = [
  mkSummary({ user_id: 2, username: 'bob', display_name: 'Bob', files: 1, bytes: 3 * 1024 * 1024, expired_files: 1, earliest_expires_at: '2026-09-17T10:00:00Z' }),
  mkSummary(),
]

interface Call { path: string; method: string; body?: string }

/** 记录所有请求（含查询串与请求体），供"条件进不进查询串"的断言使用。 */
function installMock(opts: { rows?: unknown[]; summary?: unknown[]; total?: number } = {}) {
  const calls: Call[] = []
  const rows = opts.rows ?? DEFAULT_ROWS
  const summary = opts.summary ?? DEFAULT_SUMMARY
  const total = opts.total ?? rows.length
  mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({ path: String(path), method, body: init?.body ? String(init.body) : undefined })
    const base = String(path).split('?')[0]!
    if (base === '/api/server/admin/gateway/files') return { rows, total, totals: TOTALS }
    if (base === '/api/server/admin/gateway/files/summary') return { rows: summary, totals: TOTALS }
    if (base === '/api/server/admin/gateway/files/purge') return { ok: true, deleted: 1, failed: 0, matched: 1 }
    if (method === 'DELETE') return { ok: true, deleted: 1 }
    return {}
  })
  return calls
}

const listCalls = (calls: Call[]) => calls.filter((c) => c.path.startsWith('/api/server/admin/gateway/files?'))
const summaryCalls = (calls: Call[]) => calls.filter((c) => c.path.startsWith('/api/server/admin/gateway/files/summary?'))
const purgeCalls = (calls: Call[]) => calls.filter((c) => c.path.includes('/purge'))
const lastList = (calls: Call[]) => listCalls(calls)[listCalls(calls).length - 1]!
const lastSummary = (calls: Call[]) => summaryCalls(calls)[summaryCalls(calls).length - 1]!

async function pickSelect(label: string, option: string) {
  fireEvent.click(screen.getByLabelText(label))
  fireEvent.click(await screen.findByRole('option', { name: option }))
}

beforeEach(() => {
  mockRequest.mockReset()
  vi.restoreAllMocks()
  // rbac 的当前管理员是**模块级快照**，用例间必须复位（否则写面收敛用例会把
  // 只读身份泄漏给后面的用例）。
  setCurrentAdmin(null)
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
    // 默认查询串：分页 + 排序（不默认带 user/user_id/q/state）
    const list = lastList(calls)
    expect(list.path).toContain('page=1')
    expect(list.path).toContain('size=20')
    expect(list.path).toContain('sort=created_at')
    expect(list.path).toContain('order=desc')
    expect(list.path).not.toContain('state=')
    expect(list.path).not.toContain('user')
  })

  it('员工用户名 / file_id 搜索 / 状态筛选都进查询串', async () => {
    const calls = installMock()
    render(<GatewayFiles />)
    await waitFor(() => expect(screen.getByText('file-api-aaa')).toBeTruthy())

    fireEvent.change(screen.getByLabelText('员工（用户名）'), { target: { value: 'alice' } })
    await waitFor(() => expect(lastList(calls).path).toContain('user=alice'))

    fireEvent.change(screen.getByLabelText('搜索 file_id'), { target: { value: 'bbb' } })
    await waitFor(() => expect(lastList(calls).path).toContain('q=bbb'))

    await pickSelect('状态', '已过期')
    await waitFor(() => {
      const p = lastList(calls).path
      expect(p).toContain('state=expired')
      expect(p).toContain('user=alice') // 前一个条件不丢
      expect(p).toContain('q=bbb')
    })
  })

  it('员工 ID 走 user_id（不带 user），与服务端的用户名/ID 口径一致', async () => {
    const calls = installMock()
    render(<GatewayFiles />)
    await waitFor(() => expect(screen.getByText('file-api-aaa')).toBeTruthy())

    fireEvent.change(screen.getByLabelText('员工 ID'), { target: { value: '2' } })
    await waitFor(() => {
      const p = lastList(calls).path
      expect(p).toContain('user_id=2')
      expect(p).not.toContain('user=')
    })
  })

  it('用户名与员工 ID 互斥：后填的那个赢，另一个被清空（避免服务端静默按 ID 过滤）', async () => {
    const calls = installMock()
    render(<GatewayFiles />)
    await waitFor(() => expect(screen.getByText('file-api-aaa')).toBeTruthy())

    fireEvent.change(screen.getByLabelText('员工 ID'), { target: { value: '2' } })
    await waitFor(() => expect(lastList(calls).path).toContain('user_id=2'))

    fireEvent.change(screen.getByLabelText('员工（用户名）'), { target: { value: 'alice' } })
    await waitFor(() => {
      const p = lastList(calls).path
      expect(p).toContain('user=alice')
      expect(p).not.toContain('user_id=')
    })
    expect((screen.getByLabelText('员工 ID') as HTMLInputElement).value).toBe('')
    // 反向：再填 ID 时用户名被清空
    fireEvent.change(screen.getByLabelText('员工 ID'), { target: { value: '7' } })
    await waitFor(() => {
      const p = lastList(calls).path
      expect(p).toContain('user_id=7')
      expect(p).not.toContain('user=')
    })
    expect((screen.getByLabelText('员工（用户名）') as HTMLInputElement).value).toBe('')
  })

  it('「只看此人」按该行用户名过滤，并发起新查询', async () => {
    const calls = installMock()
    render(<GatewayFiles />)
    await waitFor(() => expect(screen.getByText('file-api-aaa')).toBeTruthy())

    // 按 aria-label 定位到 Bob 那一行的按钮（不依赖汇总表的行序）
    fireEvent.click(screen.getByRole('button', { name: '只看 bob' }))
    await waitFor(() => expect(lastList(calls).path).toContain('user=bob'))
    expect((screen.getByLabelText('员工（用户名）') as HTMLInputElement).value).toBe('bob')
  })

  it('列头排序：同列两次 asc/desc 互换，换列回 desc，且都回到第 1 页', async () => {
    const calls = installMock({ total: 100 })
    render(<GatewayFiles />)
    await waitFor(() => expect(screen.getByText('file-api-aaa')).toBeTruthy())

    // 先翻到第 2 页：排序后必须回第 1 页（"第 3/5 页"配第 1 页数据是显示错位）
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    await waitFor(() => expect(screen.getByText(/第 2\/5 页/)).toBeTruthy())

    // created_at 默认 desc ⇒ 点一次变 asc
    fireEvent.click(screen.getByText(/上传时间/))
    await waitFor(() => {
      const p = lastList(calls).path
      expect(p).toContain('sort=created_at')
      expect(p).toContain('order=asc')
      expect(p).toContain('page=1')
    })
    expect(screen.getByText(/第 1\/5 页/)).toBeTruthy()

    // 再点一次 ⇒ desc
    fireEvent.click(screen.getByText(/上传时间/))
    await waitFor(() => expect(lastList(calls).path).toContain('order=desc'))

    // 换列 ⇒ desc
    fireEvent.click(screen.getByText(/大小/))
    await waitFor(() => {
      const p = lastList(calls).path
      expect(p).toContain('sort=size_bytes')
      expect(p).toContain('order=desc')
    })
    fireEvent.click(screen.getByText(/过期时间/))
    await waitFor(() => expect(lastList(calls).path).toContain('sort=expires_at'))
  })

  it('汇总表三档排序都发出正确的 sort/order 参数', async () => {
    const calls = installMock()
    render(<GatewayFiles />)
    await waitFor(() => expect(screen.getByText('file-api-aaa')).toBeTruthy())

    // 缺省 = bytes desc
    expect(lastSummary(calls).path).toContain('sort=bytes')
    expect(lastSummary(calls).path).toContain('order=desc')

    await pickSelect('员工占用排序', '按文件数')
    await waitFor(() => expect(lastSummary(calls).path).toContain('sort=files'))

    await pickSelect('员工占用排序', '按用户名')
    await waitFor(() => expect(lastSummary(calls).path).toContain('sort=username'))

    await pickSelect('员工占用排序', '按占用字节')
    await waitFor(() => expect(lastSummary(calls).path).toContain('sort=bytes'))
    for (const c of summaryCalls(calls)) expect(c.path).toContain('order=desc')
  })

  it('汇总排序变更同样回到第 1 页', async () => {
    const calls = installMock({ total: 100 })
    render(<GatewayFiles />)
    await waitFor(() => expect(screen.getByText('file-api-aaa')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    await waitFor(() => expect(screen.getByText(/第 2\/5 页/)).toBeTruthy())

    await pickSelect('员工占用排序', '按文件数')
    await waitFor(() => expect(lastSummary(calls).path).toContain('sort=files'))
    await waitFor(() => expect(lastList(calls).path).toContain('page=1'))
    expect(screen.getByText(/第 1\/5 页/)).toBeTruthy()
  })

  it('每页条数进 size，且变更后 page 回到 1', async () => {
    const calls = installMock({ total: 100 })
    render(<GatewayFiles />)
    await waitFor(() => expect(screen.getByText('file-api-aaa')).toBeTruthy())
    expect(lastList(calls).path).toContain('size=20')

    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    await waitFor(() => expect(lastList(calls).path).toContain('page=2'))

    await pickSelect('每页条数', '50 条/页')
    await waitFor(() => {
      const p = lastList(calls).path
      expect(p).toContain('size=50')
      expect(p).toContain('page=1')
    })
    expect(screen.getByText(/第 1\/2 页/)).toBeTruthy() // ceil(100 / 50)
  })

  it('翻页：page 递增、一次点击只发一次请求、首/末页按钮禁用', async () => {
    const calls = installMock({ total: 100 })
    render(<GatewayFiles />)
    await waitFor(() => expect(screen.getByText('file-api-aaa')).toBeTruthy())

    expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '下一页' })).not.toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    await waitFor(() => expect(screen.getByText(/第 2\/5 页/)).toBeTruthy())
    expect(listCalls(calls).filter((c) => c.path.includes('page=2')).length).toBe(1)

    for (const target of [3, 4, 5]) {
      fireEvent.click(screen.getByRole('button', { name: '下一页' }))
      await waitFor(() => expect(screen.getByText(new RegExp(`第 ${target}/5 页`))).toBeTruthy())
    }
    expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '上一页' })).not.toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: '上一页' }))
    await waitFor(() => expect(screen.getByText(/第 4\/5 页/)).toBeTruthy())
  })

  it('末页被删空后当前页越界时回落到最后一页（不是「第 2/1 页」空表）', async () => {
    const listPaths: string[] = []
    let sawPage2 = false
    mockRequest.mockImplementation(async (path: string) => {
      const p = String(path)
      if (p.startsWith('/api/server/admin/gateway/files?')) {
        listPaths.push(p)
        const page = Number(new URLSearchParams(p.split('?')[1]).get('page'))
        if (page === 2) sawPage2 = true
        const total = sawPage2 ? 20 : 21
        return { rows: [mkRow({ file_id: `file-page-${page}` })], total, totals: TOTALS }
      }
      if (p.startsWith('/api/server/admin/gateway/files/summary')) return { rows: [], totals: TOTALS }
      return {}
    })
    render(<GatewayFiles />)
    await waitFor(() => expect(screen.getByText('file-page-1')).toBeTruthy())
    expect(screen.getByText(/第 1\/2 页/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    await waitFor(() => expect(listPaths.some((c) => c.includes('page=2'))).toBe(true))
    // 总数变小 ⇒ 第 2 页已越界 ⇒ 自动回第 1 页重查，而不是显示「第 2/1 页」
    await waitFor(() => expect(listPaths.filter((c) => c.includes('page=1')).length).toBeGreaterThanOrEqual(2))
    await waitFor(() => expect(screen.getByText(/第 1\/1 页/)).toBeTruthy())
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
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    expect(calls.filter((c) => c.method === 'DELETE').length).toBe(0)
  })

  it('批量清理：状态为「全部」且没填员工 ⇒ 拒绝（不发请求、不弹确认）', async () => {
    const calls = installMock()
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('确认')
    render(<GatewayFiles />)
    await waitFor(() => expect(screen.getByText('file-api-aaa')).toBeTruthy())

    fireEvent.click(screen.getByText('按条件清理'))
    await waitFor(() => expect(screen.getByText(/批量清理必须指定条件/)).toBeTruthy())
    expect(purgeCalls(calls).length).toBe(0)
    expect(promptSpy).not.toHaveBeenCalled()
  })

  it('批量清理：选「有效」但没填员工 ⇒ 拒绝（与服务端同口径，不发请求）', async () => {
    const calls = installMock()
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('确认')
    render(<GatewayFiles />)
    await waitFor(() => expect(screen.getByText('file-api-aaa')).toBeTruthy())

    await pickSelect('状态', '有效')
    await waitFor(() => expect(lastList(calls).path).toContain('state=active'))

    fireEvent.click(screen.getByText('按条件清理'))
    await waitFor(() => expect(screen.getByText(/清理仍然有效的文件必须指定员工/)).toBeTruthy())
    expect(purgeCalls(calls).length).toBe(0)
    expect(promptSpy).not.toHaveBeenCalled()
  })

  it('批量清理：只填了员工 ID 时拒绝（清理体只带用户名，不许放宽成全组织范围）', async () => {
    const calls = installMock()
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('确认')
    render(<GatewayFiles />)
    await waitFor(() => expect(screen.getByText('file-api-aaa')).toBeTruthy())

    fireEvent.change(screen.getByLabelText('员工 ID'), { target: { value: '2' } })
    await waitFor(() => expect(lastList(calls).path).toContain('user_id=2'))

    fireEvent.click(screen.getByText('按条件清理'))
    await waitFor(() => expect(screen.getByText(/按员工清理请在「员工（用户名）」里填用户名/)).toBeTruthy())
    expect(purgeCalls(calls).length).toBe(0)
    expect(promptSpy).not.toHaveBeenCalled()
  })

  it('批量清理：确认词不对（取消）⇒ 不发请求', async () => {
    const calls = installMock()
    vi.spyOn(window, 'prompt').mockReturnValue('取消')
    render(<GatewayFiles />)
    await waitFor(() => expect(screen.getByText('file-api-aaa')).toBeTruthy())

    await pickSelect('状态', '已过期')
    await waitFor(() => expect(lastList(calls).path).toContain('state=expired'))

    fireEvent.click(screen.getByText('按条件清理'))
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    expect(purgeCalls(calls).length).toBe(0)
  })

  it('批量清理：输入确认词后按当前条件发 POST，请求体逐字等于 {state, user}', async () => {
    const calls = installMock()
    vi.spyOn(window, 'prompt').mockReturnValue('确认')
    render(<GatewayFiles />)
    await waitFor(() => expect(screen.getByText('file-api-aaa')).toBeTruthy())

    fireEvent.change(screen.getByLabelText('员工（用户名）'), { target: { value: 'bob' } })
    await waitFor(() => expect(lastList(calls).path).toContain('user=bob'))
    await pickSelect('状态', '已过期')
    await waitFor(() => expect(lastList(calls).path).toContain('state=expired'))

    fireEvent.click(screen.getByText('按条件清理'))
    await waitFor(() => expect(screen.getByText(/清理完成：命中 1，删除 1，失败 0/)).toBeTruthy())
    const purge = purgeCalls(calls)[0]!
    expect(purge.method).toBe('POST')
    expect(JSON.parse(purge.body!)).toEqual({ state: 'expired', user: 'bob' })
  })

  it('批量清理：服务端跳过（skipped）的条数必须显示出来，不能只说"删除 N"', async () => {
    // R18C-02：拿不到删除权 / 删除期间世代已变的行会被跳过（没有调用上游、行原样保留）。
    // 服务端响应新增 skipped ⇒ 页面必须如实显示，否则"命中 2 删除 1"看起来像静默失败。
    const calls = installMock()
    mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      calls.push({ path: String(path), method, body: init?.body ? String(init.body) : undefined })
      const base = String(path).split('?')[0]!
      if (base === '/api/server/admin/gateway/files') return { rows: DEFAULT_ROWS, total: 1, totals: TOTALS }
      if (base === '/api/server/admin/gateway/files/purge') return { ok: true, deleted: 1, failed: 0, matched: 2, skipped: 1 }
      return {}
    })
    vi.spyOn(window, 'prompt').mockReturnValue('确认')
    render(<GatewayFiles />)
    await waitFor(() => expect(screen.getByText('file-api-aaa')).toBeTruthy())
    await pickSelect('状态', '已过期')
    fireEvent.click(screen.getByText('按条件清理'))
    await waitFor(() => expect(screen.getByText(/清理完成：命中 2，删除 1，失败 0，跳过 1/)).toBeTruthy())
  })

  it('批量清理：没填员工时请求体只有 state（不带 user 键）', async () => {
    const calls = installMock()
    vi.spyOn(window, 'prompt').mockReturnValue('确认')
    render(<GatewayFiles />)
    await waitFor(() => expect(screen.getByText('file-api-aaa')).toBeTruthy())

    await pickSelect('状态', '已过期')
    await waitFor(() => expect(lastList(calls).path).toContain('state=expired'))
    fireEvent.click(screen.getByText('按条件清理'))
    await waitFor(() => expect(purgeCalls(calls).length).toBe(1))
    expect(JSON.parse(purgeCalls(calls)[0]!.body!)).toEqual({ state: 'expired' })
  })

  it('批量清理：填了员工后「全部」状态可清理，且 state=all 原样下发（不收敛成 expired）', async () => {
    // 旧实现把 `all` 硬编码成 `expired`：确认框说"删除全部文件"、请求只删已过期，
    // 属于"承诺的范围 ≠ 实际的范围"。这条断言把两者钉在一起。
    const calls = installMock()
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('确认')
    render(<GatewayFiles />)
    await waitFor(() => expect(screen.getByText('file-api-aaa')).toBeTruthy())

    fireEvent.change(screen.getByLabelText('员工（用户名）'), { target: { value: 'bob' } })
    await waitFor(() => expect(lastList(calls).path).toContain('user=bob'))
    expect(lastList(calls).path).not.toContain('state=')

    fireEvent.click(screen.getByText('按条件清理'))
    await waitFor(() => expect(purgeCalls(calls).length).toBe(1))
    expect(JSON.parse(purgeCalls(calls)[0]!.body!)).toEqual({ state: 'all', user: 'bob' })
    // 危险路径必须走"输入确认词"的提示
    expect(String(promptSpy.mock.calls[0]![0])).toContain('全部文件')
    expect(String(promptSpy.mock.calls[0]![0])).toContain('确认')
  })

  it('服务端失败时把原因显示出来，并且不留旧条件的行冒充新结果', async () => {
    installMock()
    render(<GatewayFiles />)
    await waitFor(() => expect(screen.getByText('file-api-aaa')).toBeTruthy())

    // 让后续列表请求失败（模拟改了过滤条件后 5xx）
    mockRequest.mockImplementation(async (path: string) => {
      if (String(path).startsWith('/api/server/admin/gateway/files?')) throw new Error('读取文件台账失败')
      return { rows: [], totals: TOTALS }
    })
    fireEvent.change(screen.getByLabelText('员工（用户名）'), { target: { value: 'alice' } })
    await waitFor(() => expect(screen.getByText(/读取文件台账失败/)).toBeTruthy())
    // 旧条件的行不能留在屏幕上（会被当成新条件的结果）；也不显示"没有匹配"
    expect(screen.queryByText('file-api-aaa')).toBeNull()
    expect(screen.queryByText('没有匹配的文件')).toBeNull()
  })

  it('空列表显示「没有匹配的文件」', async () => {
    installMock({ rows: [], summary: [] })
    render(<GatewayFiles />)
    await waitFor(() => expect(screen.getByText('没有匹配的文件')).toBeTruthy())
    expect(screen.getByText('暂无文件')).toBeTruthy()
  })

  it('加载中显示骨架屏（不是空表格）', async () => {
    let release: (v: unknown) => void = () => {}
    mockRequest.mockImplementation(async (path: string) => {
      if (String(path).startsWith('/api/server/admin/gateway/files?')) {
        return await new Promise((resolve) => { release = resolve })
      }
      return { rows: [], totals: TOTALS }
    })
    const { container } = render(<GatewayFiles />)
    expect(container.querySelector('.animate-pulse')).not.toBeNull()
    expect(screen.queryByText('没有匹配的文件')).toBeNull()
    await act(async () => { release({ rows: [], total: 0, totals: TOTALS }) })
    await waitFor(() => expect(container.querySelector('.animate-pulse')).toBeNull())
  })

  it('服务端下发的 file_id/username 以文本渲染，不注入 DOM（XSS 判据）', async () => {
    const EVIL = '<img src=x onerror="window.__pwned=1">'
    installMock({
      rows: [mkRow({ file_id: EVIL, username: EVIL, display_name: EVIL })],
      summary: [mkSummary({ username: EVIL, display_name: EVIL })],
    })
    const { container } = render(<GatewayFiles />)
    await waitFor(() => expect(screen.getAllByText(EVIL).length).toBeGreaterThan(0))
    // 没有真的元素被造出来
    expect(container.querySelectorAll('img, script, iframe, svg[onload]').length).toBe(0)
    // file_id 单元格里就是**一个文本节点**（dangerouslySetInnerHTML 会造出元素节点）
    const cell = container.querySelector('td.font-mono')!
    expect(cell.childNodes.length).toBe(1)
    expect(cell.childNodes[0]!.nodeType).toBe(Node.TEXT_NODE)
    expect(cell.textContent).toBe(EVIL)
    expect(container.innerHTML).toContain('&lt;img')
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined()
  })

  it('竞态守卫：先发的慢响应后到时不能覆盖后发请求的结果', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    let listCount = 0
    const STALE = mkRow({ file_id: 'file-stale' })
    const FRESH = mkRow({ file_id: 'file-fresh' })
    mockRequest.mockImplementation(async (path: string) => {
      const p = String(path)
      if (p.startsWith('/api/server/admin/gateway/files?')) {
        listCount += 1
        if (listCount === 1) {
          await gate // 第 1 个请求挂起：模拟"慢响应后到"
          return { rows: [STALE], total: 1, totals: TOTALS }
        }
        return { rows: [FRESH], total: 1, totals: TOTALS }
      }
      if (p.startsWith('/api/server/admin/gateway/files/summary')) return { rows: [], totals: TOTALS }
      return {}
    })
    render(<GatewayFiles />)
    await waitFor(() => expect(listCount).toBe(1))

    // 改过滤条件 ⇒ 300ms 防抖后发出第 2 个请求（第 1 个仍挂起）
    fireEvent.change(screen.getByLabelText('员工（用户名）'), { target: { value: 'bob' } })
    await waitFor(() => expect(listCount).toBe(2), { timeout: 5000 })
    await waitFor(() => expect(screen.getByText('file-fresh')).toBeTruthy())

    // 放行第 1 个（过期的）请求：它必须被整段丢弃
    await act(async () => { release() })
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    expect(screen.queryByText('file-stale')).toBeNull()
    expect(screen.getByText('file-fresh')).toBeTruthy()
  })

  it('写面收敛：只有 gateway:read 的管理员看到数据，但看不到删除/清理入口', async () => {
    // nav 条目 gate 在 `gateway:read`（服务端 GET 路由同权限点），而删除/清理走
    // `gateway:write`。只读管理员不该看到一个点下去必然 403 的按钮。
    setCurrentAdmin({ role: 'auditor', permissions: ['gateway:read'] })
    try {
      installMock()
      render(<GatewayFiles />)
      await waitFor(() => expect(screen.getByText('file-api-aaa')).toBeTruthy())
      expect(screen.queryByText('按条件清理')).toBeNull()
      expect(screen.queryByText('删除')).toBeNull()
      expect(screen.getByText('刷新')).toBeTruthy()
    } finally {
      setCurrentAdmin(null)
    }
  })

  it('写面收敛：持有 gateway:write 时删除/清理入口可见', async () => {
    setCurrentAdmin({ role: 'super_admin', permissions: ['gateway:read', 'gateway:write'] })
    try {
      installMock()
      render(<GatewayFiles />)
      await waitFor(() => expect(screen.getByText('file-api-aaa')).toBeTruthy())
      expect(screen.getByText('按条件清理')).toBeTruthy()
      expect(screen.getAllByText('删除').length).toBeGreaterThan(0)
    } finally {
      setCurrentAdmin(null)
    }
  })
})

// ---------------------------------------------------------------------------
// 渲染边界（直接打纯函数，不经组件）
// ---------------------------------------------------------------------------

describe('网关文件台账页 · 渲染边界', () => {
  it('fmtBytes：0/负数/非有限值给 0 B，单位换算到 TiB 封顶', () => {
    expect(fmtBytes(0)).toBe('0 B')
    expect(fmtBytes(-1)).toBe('0 B')
    expect(fmtBytes(Number.NaN)).toBe('0 B')
    expect(fmtBytes(Number.POSITIVE_INFINITY)).toBe('0 B')
    expect(fmtBytes(Number.NEGATIVE_INFINITY)).toBe('0 B')
    expect(fmtBytes(1)).toBe('1 B')
    expect(fmtBytes(1023)).toBe('1023 B')
    expect(fmtBytes(1024)).toBe('1.0 KiB')
    expect(fmtBytes(1024 * 1024)).toBe('1.0 MiB')
    expect(fmtBytes(3 * 1024 * 1024)).toBe('3.0 MiB')
    expect(fmtBytes(1024 ** 4)).toBe('1.0 TiB')
    expect(fmtBytes(9 * 1024 ** 4)).toBe('9.0 TiB')
    expect(fmtBytes(1024 ** 5)).toBe('1024.0 TiB') // 单位封顶，不造 PiB 档
  })

  it('fmtTime：空值 = 永久（无过期时间），非法值原样回显', () => {
    expect(fmtTime(null)).toBe('永久')
    expect(fmtTime(undefined)).toBe('永久')
    expect(fmtTime('')).toBe('永久')
    expect(fmtTime('not-a-date')).toBe('not-a-date')
    expect(fmtTime('2026-09-27T10:00:00Z')).toBe(new Date('2026-09-27T10:00:00Z').toLocaleString('zh-CN', { hour12: false }))
  })

  it('fmtDateTime：创建时间缺失给「—」，不能说成「永久」', () => {
    expect(fmtDateTime(null)).toBe('—')
    expect(fmtDateTime('')).toBe('—')
    expect(fmtDateTime('not-a-date')).toBe('not-a-date')
    expect(fmtDateTime('2026-09-20T10:00:00Z')).not.toBe('永久')
  })
})
