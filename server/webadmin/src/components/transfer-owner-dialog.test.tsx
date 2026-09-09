import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { request } from '../api'
import { TransferOwnerDialog } from './transfer-owner-dialog'

const mockRequest = vi.mocked(request)

beforeEach(() => {
  mockRequest.mockReset()
  mockRequest.mockImplementation(async (path: string) => {
    if (path.startsWith('/api/server/admin/users?')) {
      return { users: [{ username: 'alice' }, { username: 'bob', display_name: 'Bob' }] }
    }
    return {}
  })
})

function renderDialog(props: Partial<Parameters<typeof TransferOwnerDialog>[0]> = {}) {
  const onClose = vi.fn()
  const onSaved = vi.fn()
  render(
    <TransferOwnerDialog
      open
      kind="skill"
      name="crm-skill"
      displayName="CRM 技能"
      currentOwner="alice"
      onClose={onClose}
      onSaved={onSaved}
      {...props}
    />,
  )
  return { onClose, onSaved }
}

describe('TransferOwnerDialog 归属转移', () => {
  it('打开时在 effect 中拉取候选用户(P2-44)', async () => {
    renderDialog()
    await waitFor(() => expect(mockRequest).toHaveBeenCalledWith(
      expect.stringContaining('/api/server/admin/users?'),
    ))
    // 未选用户 + 未选官方 → 确认按钮禁用
    expect(screen.getByRole('button', { name: '确认转移' })).toBeDisabled()
  })

  it('选择「归属官方」后确认按钮可用并提交 {official:true}(P2-41)', async () => {
    const { onSaved, onClose } = renderDialog()
    const officialRadio = screen.getByLabelText(/归属官方/)
    fireEvent.click(officialRadio)
    const confirm = screen.getByRole('button', { name: '确认转移' })
    expect(confirm).toBeEnabled()
    fireEvent.click(confirm)
    await waitFor(() => expect(mockRequest).toHaveBeenCalledWith(
      '/api/server/admin/apps/skill/crm-skill/owner',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ official: true }) }),
    ))
    expect(onSaved).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it('转给用户:未选人时禁用,选人后提交 {owner}', async () => {
    renderDialog()
    // 触发按钮 role=combobox(radix PopoverTrigger asChild + role 覆盖)
    fireEvent.click(await screen.findByRole('combobox'))
    fireEvent.click(await screen.findByText('bob'))
    const confirm = screen.getByRole('button', { name: '确认转移' })
    expect(confirm).toBeEnabled()
    fireEvent.click(confirm)
    await waitFor(() => expect(mockRequest).toHaveBeenCalledWith(
      '/api/server/admin/apps/skill/crm-skill/owner',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ owner: 'bob' }) }),
    ))
  })

  it('选择当前归属人时禁用(无变化)', async () => {
    renderDialog()
    // 触发按钮 role=combobox(radix PopoverTrigger asChild + role 覆盖)
    fireEvent.click(await screen.findByRole('combobox'))
    // alice 是当前归属 → CommandItem disabled(列表项 + 页脚文案都有 alice,取列表项)
    const items = await screen.findAllByText('alice')
    const listItem = items.find((el) => el.closest('[cmdk-item]') !== null) ?? items[0]!
    fireEvent.click(listItem)
    expect(screen.getByRole('button', { name: '确认转移' })).toBeDisabled()
  })
})
