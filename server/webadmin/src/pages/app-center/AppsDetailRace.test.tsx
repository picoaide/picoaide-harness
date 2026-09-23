/**
 * WEB-3(2026-09-23 审计 P1)回归:应用详情抽屉的三条 loader
 * (`loadPending`/`loadRejected`/`loadDiagnostics`)必须有**请求序号守卫**。
 *
 * 原缺陷:打开 A 详情(其 `/releases` 慢)→ 关闭 → 打开 B 详情(B 的响应先到)
 * → A 的迟到响应落地,把 A 的待审清单(与"当前生效版本")写进 **B 的抽屉**;
 * 而「通过」按钮把 `detail`(=当前应用 B)与 `rel`(=A 的版本号)拼成一条请求:
 * `POST /wasm-apps/B/releases/<A 的版本>/approve`。版本号只在**应用内**唯一
 * (首发普遍都是 1.0.0),所以这不是必然 404,而是**批准了一个从未在审批界面
 * 展示过的版本**。
 *
 * 修法:`detailSeq`(openDetail 里 ++)+ 三条 loader 落地前判 `current !==
 * detailSeq.current`;加载不成功的清单不许拿去批准(`!pendingLoaded`)。
 * 变异验证:去掉任一 loader 的序号守卫,本文件第一条用例即红。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { request } from '../../api'
import { setCurrentAdmin } from '../../lib/rbac'
import Apps from './Apps'
import type { MeUser } from '../../lib/rbac'

vi.mock('../../components/chart-lazy', () => ({ ChartLazy: () => <div data-testid="chart-mock" /> }))

const base = {
  description: 'd', owner: 'alice', access: 'login', purpose: 'p', data_sensitivity: '内部',
  current_release_id: 1, current_version: '0.0.1', pending_releases: ['x'], pending_count: 1,
  frozen_at: null as string | null, deleted_at: null as string | null,
  created_at: '2026-09-18T10:00:00Z', updated_at: '2026-09-18T11:00:00Z',
}
const APP_A = { ...base, app_id: 'app-a', title: '应用A', current_version: '0.0.1' }
const APP_B = { ...base, app_id: 'app-b', title: '应用B', current_version: '0.2.0' }

const SUPER: MeUser = { role: 'super_admin', permissions: ['capability:read', 'capability:write'] }
const mockRequest = vi.mocked(request)

function rel(version: string) {
  return {
    id: 1, version, status: 'pending', title: 't', description: 'd', publisher: 'alice',
    size: 1024, checksum: 'c', changelog: 'ch', created_at: '2026-09-19T02:00:00Z', current: false,
  }
}
function rowOf(appId: string): HTMLElement {
  const cell = screen.getByText(appId)
  const tr = cell.closest('tr')
  if (tr === null) throw new Error(`未找到 ${appId} 所在的行`)
  return tr
}

beforeEach(() => {
  setCurrentAdmin(SUPER)
  mockRequest.mockReset()
})

describe('WEB-3:应用详情抽屉的请求归属', () => {
  it('上一个应用的迟到待审清单不落进当前抽屉,审批只会打到当前应用自己的版本', async () => {
    let releaseA!: () => void
    const gateA = new Promise<void>((resolve) => { releaseA = resolve })

    mockRequest.mockImplementation(async (path: string) => {
      const p = String(path)
      const b = p.split('?')[0]!
      const params = new URLSearchParams(p.split('?')[1] ?? '')
      if (b === '/api/server/admin/wasm-apps') {
        return {
          apps: [APP_A, APP_B], review_required: false, setting_key: 'k', pending_count: 2,
          total: 2, truncated: false, limit: 20, offset: 0, access: '',
        }
      }
      if (b.endsWith('/diagnostics')) {
        return { diagnostics: { app_id: 'x', app_enabled: true, app_frozen: false, app_deleted: false, owner: 'alice', window_minutes: 1440, retention_days: 30, summary: { total: 0, ok: 0, error: 0, killed: 0, failed: 0, reasons: [], hints: [], last_failure_at: null }, failures: [], hints: [] } }
      }
      if (b.endsWith('/releases')) {
        const appId = b.split('/')[5]!
        if (appId === 'app-a') {
          await gateA // A 的响应被挂住(模拟慢网络)
          return { app_id: 'app-a', status: params.get('status'), current_version: '0.0.1', releases: [rel('9.9.9')], pending_count: 1 }
        }
        return { app_id: 'app-b', status: params.get('status'), current_version: '0.2.0', releases: params.get('status') === 'rejected' ? [] : [rel('1.0.0')], pending_count: 1 }
      }
      if (b.endsWith('/approve')) return { ok: true }
      return {}
    })

    render(<Apps />)
    await screen.findByText('app-a')

    // ① 打开 A 的详情(A 的 /releases 挂起)。
    fireEvent.click(within(rowOf('app-a')).getByRole('button', { name: '详情' }))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()

    // ② 关掉抽屉,改开 B 的详情(B 的清单立刻落地 = v1.0.0,当前生效 0.2.0)。
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    fireEvent.click(within(rowOf('app-b')).getByRole('button', { name: '详情' }))
    const dialog = within(await screen.findByRole('dialog'))
    expect(await dialog.findByTestId('pending-approve-1.0.0')).toBeInTheDocument()
    expect(dialog.getByTestId('pending-current-version')).toHaveTextContent('0.2.0')

    // ③ A 的迟到响应此刻才落地 —— 它属于**已经关闭**的 A,不得写进 B 的抽屉。
    await act(async () => {
      releaseA()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(dialog.queryByTestId('pending-approve-9.9.9')).toBeNull()
    expect(dialog.getByTestId('pending-approve-1.0.0')).toBeInTheDocument()
    // 「当前生效版本」也不能被 A 的响应顶掉(currentVersionShown 与待审清单同源)。
    expect(dialog.getByTestId('pending-current-version')).toHaveTextContent('0.2.0')
    expect(dialog.getByTestId('detail-current-version')).toHaveTextContent('0.2.0')

    // ④ 点「通过」→ 只可能批准 B 自己的待审版本。
    fireEvent.click(dialog.getByTestId('pending-approve-1.0.0'))
    const approveCalls = mockRequest.mock.calls.filter((c) => String(c[0]).endsWith('/approve'))
    expect(approveCalls).toHaveLength(1)
    expect(String(approveCalls[0]![0])).toContain('/wasm-apps/app-b/releases/1.0.0/approve')
  })

  it('待审清单未落地时不渲染任何可点的通过/拒绝按钮', async () => {
    let releaseA!: () => void
    const gateA = new Promise<void>((resolve) => { releaseA = resolve })
    mockRequest.mockImplementation(async (path: string) => {
      const p = String(path)
      const b = p.split('?')[0]!
      if (b === '/api/server/admin/wasm-apps') {
        return {
          apps: [APP_A], review_required: false, setting_key: 'k', pending_count: 1,
          total: 1, truncated: false, limit: 20, offset: 0, access: '',
        }
      }
      if (b.endsWith('/releases')) {
        await gateA
        return { app_id: 'app-a', status: 'pending', current_version: '0.0.1', releases: [rel('0.0.9')], pending_count: 1 }
      }
      return { diagnostics: null }
    })
    render(<Apps />)
    await screen.findByText('app-a')
    fireEvent.click(within(rowOf('app-a')).getByRole('button', { name: '详情' }))
    const dialog = within(await screen.findByRole('dialog'))
    // 清单还在路上:抽屉里没有任何「通过」按钮(空清单不得冒充"没有待审")。
    expect(dialog.queryByTestId('pending-approve-0.0.9')).toBeNull()
    await act(async () => {
      releaseA()
      await Promise.resolve()
      await Promise.resolve()
    })
    // 落地后才出现,且是启用的。
    const approve = await dialog.findByTestId('pending-approve-0.0.9')
    expect(approve).not.toBeDisabled()
  })
})
