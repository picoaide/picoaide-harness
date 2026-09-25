import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { request } from '../api'
import { CapabilityLockPanel } from './capability-lock-panel'

// 审计 R13-F F-13（P3，同族第三处未收口）：锁定管理对话框此前**没有任何直接单测**。
// 缺陷形态（实测）：成功打开一次 → 关闭 → 再次打开时 GET 失败 ⇒ 错误横幅出现了，
// **上一次的锁定行与可点的「解除」按钮照样在**，点下去真的会发
// `DELETE …/capability-locks/skill/<旧行>`。
//
// 本文件把第十二轮的两条规则钉在这个组件上：
//   规则 1（成功才解锁）：`locksLoaded` 只在成功分支置 true；失败分支置 false 并清空 locks。
//   规则 2（渲染期同步归零）：`open` false→true 的**当帧**就清空上一份清单。
// 列表渲染、空态文案与「解除」都吃同一个 `locksLoaded` 闸门。
//
// 变异纪律（见 temp/r13/GF/sub-webadmin/FINDINGS.md）：jsdom 里 act() 会冲掉 effect，
// 所以「渲染期归零」与「列表闸门」**单独**拆掉时用例多半仍绿；两个一起拆必红。

const mockRequest = vi.mocked(request)

/** 与组件同一路径（前缀常量来自 lib/api-paths.ts 的真源）。 */
const LOCKS_PATH = '/api/server/admin/capability-locks'

const row = { kind: 'skill' as const, name: 'stale-lock', reason: '官方命名保护', locked_by: 'admin' }

/** 所有以 DELETE 发出的调用（判"是否真的发了写请求"的唯一口径）。 */
function deleteCalls(): unknown[][] {
  return mockRequest.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'DELETE')
}

beforeEach(() => {
  mockRequest.mockReset()
  window.confirm = vi.fn(() => true) as unknown as typeof window.confirm
})

describe('CapabilityLockPanel 锁定管理（R13-F F-13）', () => {
  it('正例：读取成功时渲染清单，「解除」真的发出 DELETE（闸门不误伤正常路径）', async () => {
    mockRequest.mockImplementation(async (path: string) => (path === LOCKS_PATH ? { locks: [row] } : {}))
    render(<CapabilityLockPanel open onClose={() => {}} />)

    expect(await screen.findByText('stale-lock')).toBeInTheDocument()
    expect(screen.getByText('官方命名保护')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '解除' }))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith(`${LOCKS_PATH}/skill/stale-lock`, { method: 'DELETE' })
    })
  })

  it('读失败：不显示「暂无锁定名称」（未知 ≠ 空），且没有任何行与解除按钮', async () => {
    mockRequest.mockImplementation(async () => { throw new Error('读取锁定清单失败: 502') })
    render(<CapabilityLockPanel open onClose={() => {}} />)

    expect(await screen.findByText(/读取锁定清单失败/)).toBeInTheDocument()
    expect(screen.queryByText('暂无锁定名称')).toBeNull()
    expect(screen.queryByRole('button', { name: '解除' })).toBeNull()
    expect(deleteCalls()).toEqual([])
  })

  it('【主判据】关掉再打开、第二次 GET 失败：不得渲染上一次的锁定行，也不得有可点的「解除」', async () => {
    mockRequest.mockImplementation(async (path: string) => (path === LOCKS_PATH ? { locks: [row] } : {}))
    const { rerender } = render(<CapabilityLockPanel open onClose={() => {}} />)
    expect(await screen.findByText('stale-lock')).toBeInTheDocument()

    // 关闭（组件常挂载在 Capabilities/Agents 页上，state 不会因为关闭而消失）
    rerender(<CapabilityLockPanel open={false} onClose={() => {}} />)
    // 再次打开 —— 这次读取失败
    mockRequest.mockImplementation(async () => { throw new Error('读取锁定清单失败: 502') })
    rerender(<CapabilityLockPanel open onClose={() => {}} />)

    expect(await screen.findByText(/读取锁定清单失败/)).toBeInTheDocument()
    expect(screen.queryByText('stale-lock')).toBeNull()
    expect(screen.queryByRole('button', { name: '解除' })).toBeNull()
    // 缺陷形态的硬证据：旧行不可点 ⇒ 一条 DELETE 都不该发出去。
    expect(deleteCalls()).toEqual([])
  })

  it('【主判据】关掉再打开、读取仍在途（未落地）：上一份行不得在屏，也不得声称「暂无锁定名称」', async () => {
    mockRequest.mockImplementation(async (path: string) => (path === LOCKS_PATH ? { locks: [row] } : {}))
    const { rerender } = render(<CapabilityLockPanel open onClose={() => {}} />)
    expect(await screen.findByText('stale-lock')).toBeInTheDocument()

    rerender(<CapabilityLockPanel open={false} onClose={() => {}} />)
    // 第二次读取永不落地：这一帧只有「渲染期归零 + 列表闸门」能挡住旧行。
    mockRequest.mockImplementation(() => new Promise(() => {}))
    rerender(<CapabilityLockPanel open onClose={() => {}} />)

    expect(screen.queryByText('stale-lock')).toBeNull()
    expect(screen.queryByRole('button', { name: '解除' })).toBeNull()
    expect(screen.queryByText('暂无锁定名称')).toBeNull()
    expect(screen.getByText('正在读取锁定清单…')).toBeInTheDocument()
    expect(deleteCalls()).toEqual([])
  })

  it('失败后恢复正常：重新打开成功 ⇒ 行与「解除」都回来（闸门可重新解锁）', async () => {
    mockRequest.mockImplementation(async () => { throw new Error('读取锁定清单失败: 502') })
    const { rerender } = render(<CapabilityLockPanel open onClose={() => {}} />)
    expect(await screen.findByText(/读取锁定清单失败/)).toBeInTheDocument()

    rerender(<CapabilityLockPanel open={false} onClose={() => {}} />)
    mockRequest.mockImplementation(async (path: string) => (path === LOCKS_PATH ? { locks: [row] } : {}))
    rerender(<CapabilityLockPanel open onClose={() => {}} />)

    expect(await screen.findByText('stale-lock')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '解除' })).toBeEnabled()
  })
})
