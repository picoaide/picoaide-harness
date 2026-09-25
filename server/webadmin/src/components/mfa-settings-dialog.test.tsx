import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ApiError, request } from '../api'
import { MFASettingsDialog } from './mfa-settings-dialog'

// 审计 R15C-W-01（2026-09-25，P1）：MFA 状态读取失败被谎报成「未开启」，且失败在
// view 模式**零出口**，界面还把「开启双重验证」摆出来。
//
// 为什么这条与"前端小瑕疵"不是一个量级：服务端的 enable 当时**不校验已开启**
// （R15C-02），于是「状态读失败 → 界面说未开启 → 管理员用主密码再开启一次」等于
// 用更弱的凭据替换第二因子（旧验证器立即失效、其他会话被踢）。
//
// 本文件把仓库既有规则钉在这个对话框上：**写面闸门一律成功才解锁**
// （`statusLoaded` 只在成功分支置 true，失败分支置 false；状态未读到 ⇒ 显式
// 「状态未知」+ 不给任何开启/关闭入口）。
//
// 变异纪律：把 `load()` 的 `setStatusLoaded(true)` 挪回 finally（或删掉
// statusLoaded 分支）⇒ 用例 1 必红。

const mockRequest = vi.mocked(request)

const MFA_PATH = '/api/server/admin/me/mfa'

function renderDialog() {
  const onChanged = vi.fn()
  render(<MFASettingsDialog open onOpenChange={() => {}} onChanged={onChanged} />)
  return { onChanged }
}

beforeEach(() => {
  mockRequest.mockReset()
})

describe('MFASettingsDialog 安全设置（R15C-W-01）', () => {
  it('【红】GET /me/mfa 失败：不得谎报「未开启」，必须明说状态未知，且不给「开启」入口', async () => {
    mockRequest.mockImplementation(async (path: string) => {
      if (path === MFA_PATH) throw new Error('网络错误')
      return {}
    })
    renderDialog()

    await waitFor(() => expect(screen.getByText(/状态读取失败/)).toBeInTheDocument(), { timeout: 5000 })
    // 失败不得被渲染成"已确认未开启"。
    expect(screen.queryByText('未开启')).toBeNull()
    // 写面必须锁死：既没有"开启"，也没有"关闭"。
    expect(screen.queryByRole('button', { name: '开启双重验证' })).toBeNull()
    expect(screen.queryByRole('button', { name: '关闭双重验证' })).toBeNull()
    // 失败原因可见（此前 view 模式零出口）。
    expect(screen.getByText(/网络错误/)).toBeInTheDocument()
  })

  it('对照：成功且 enabled=true ⇒ 显示「已开启」与「关闭」入口，无失败提示', async () => {
    mockRequest.mockImplementation(async (path: string) => (path === MFA_PATH ? { enabled: true } : {}))
    renderDialog()

    await waitFor(() => expect(screen.getByText('已开启')).toBeInTheDocument(), { timeout: 5000 })
    expect(screen.getByRole('button', { name: '关闭双重验证' })).toBeInTheDocument()
    expect(screen.queryByText(/状态读取失败/)).toBeNull()
  })

  it('对照：成功且 enabled=false ⇒ 闸门不误伤，点「开启」真的进入主密码表单', async () => {
    mockRequest.mockImplementation(async (path: string) => (path === MFA_PATH ? { enabled: false } : {}))
    renderDialog()

    await waitFor(() => expect(screen.getByText('未开启')).toBeInTheDocument(), { timeout: 5000 })
    fireEvent.click(screen.getByRole('button', { name: '开启双重验证' }))
    // 进入 enable 视图（主密码字段 + 下一步）。
    await waitFor(() => expect(screen.getByText('主密码确认')).toBeInTheDocument(), { timeout: 5000 })
    expect(screen.getByRole('button', { name: '下一步' })).toBeInTheDocument()
  })

  it('失败后「重试」成功 ⇒ 状态落地并解锁写面（重试真的重新取数）', async () => {
    let fail = true
    mockRequest.mockImplementation(async (path: string) => {
      if (path !== MFA_PATH) return {}
      if (fail) throw new Error('暂时不可用')
      return { enabled: false }
    })
    renderDialog()
    await waitFor(() => expect(screen.getByText(/状态读取失败/)).toBeInTheDocument(), { timeout: 5000 })

    fail = false
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expect(screen.getByText('未开启')).toBeInTheDocument(), { timeout: 5000 })
    expect(screen.getByRole('button', { name: '开启双重验证' })).toBeInTheDocument()
  })

  it('服务端回 409 MFA_ALREADY_ENABLED ⇒ 收敛到「已开启」状态视图，不留在开启表单', async () => {
    mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === MFA_PATH) return { enabled: false }
      if (path === `${MFA_PATH}/enable` && init?.method === 'POST') {
        throw new ApiError(409, 'MFA_ALREADY_ENABLED', '双重验证已开启;如需更换验证器,请先关闭双重验证(需主密码与当前动态码)后重新开启')
      }
      return {}
    })
    renderDialog()

    await waitFor(() => expect(screen.getByText('未开启')).toBeInTheDocument(), { timeout: 5000 })
    fireEvent.click(screen.getByRole('button', { name: '开启双重验证' }))
    await waitFor(() => expect(screen.getByText('主密码确认')).toBeInTheDocument(), { timeout: 5000 })
    fireEvent.change(screen.getByPlaceholderText('请输入当前密码'), { target: { value: 'pw123456' } })
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))

    // 服务端说"已开启"就是权威：回到状态视图 + 明确文案。
    await waitFor(() => expect(screen.getByText('已开启')).toBeInTheDocument(), { timeout: 5000 })
    expect(screen.queryByText('主密码确认')).toBeNull()
    expect(screen.getByText(/如需更换验证器/)).toBeInTheDocument()
  })
})
