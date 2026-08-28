import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import SharedSkills from './SharedSkills'
import { request } from '../api'

const mockRequest = vi.mocked(request)

const ROWS = [
  { name: 'codeql', display_name: '代码审计', version: '1.0.0', description: '审计', author: 'alice', status: 'pending', reason: '', created_at: '2026-08-01T10:00:00+08:00' },
  { name: 'codeql', display_name: '代码审计', version: '1.1.0', description: '审计v2', author: 'alice', status: 'approved', reason: '', created_at: '2026-08-02T10:00:00+08:00' },
  { name: 'ding', display_name: '钉钉', version: '0.1.0', description: '', author: 'bob', status: 'rejected', reason: '缺演示', created_at: '2026-08-03T10:00:00+08:00' },
]

beforeEach(() => {
  mockRequest.mockReset()
  mockRequest.mockImplementation(async (path: string) => {
    if (path.startsWith('/api/admin/shared-skills')) return { skills: ROWS }
    return {}
  })
})

describe('SharedSkills 共享技能审核页', () => {
  it('渲染列表与版本列', async () => {
    render(<SharedSkills />)
    expect(await screen.findAllByText('代码审计')).toHaveLength(2)
    expect(screen.getByText('1.0.0')).toBeInTheDocument()
    expect(screen.getByText('1.1.0')).toBeInTheDocument()
  })

  it('拒绝必须填理由并调用 reject 接口', async () => {
    render(<SharedSkills />)
    const reject = await screen.findAllByText('拒绝')
    fireEvent.click(reject[0]!)
    const confirmBtn = await screen.findByRole('button', { name: '确认' })
    expect(confirmBtn).toBeDisabled()
    fireEvent.change(screen.getByLabelText('拒绝理由'), { target: { value: '缺演示文件' } })
    fireEvent.click(confirmBtn)
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('/api/admin/shared-skills/codeql/1.0.0/reject', {
        method: 'POST',
        body: JSON.stringify({ reason: '缺演示文件' }),
      })
    })
  })

  it('通过调用 approve 接口', async () => {
    render(<SharedSkills />)
    const approve = await screen.findAllByText('通过')
    fireEvent.click(approve[0]!)
    fireEvent.click(await screen.findByText('确认'))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('/api/admin/shared-skills/codeql/1.0.0/approve', { method: 'POST' })
    })
  })

  it('点击预览展示 SKILL.md', async () => {
    mockRequest.mockImplementation(async (path: string) => {
      if (path.endsWith('/preview')) return { files: ['SKILL.md', 'scripts/run.sh'], skill_md: '---\nname: codeql\n---\n' }
      if (path.startsWith('/api/admin/shared-skills')) return { skills: ROWS }
      return {}
    })
    render(<SharedSkills />)
    const btns = await screen.findAllByTitle('查看内容预览')
    fireEvent.click(btns[0]!)
    expect(await screen.findByText('scripts/run.sh')).toBeInTheDocument()
  })

  it('点击文件清单中的文件可查看其内容(审核全部内容)', async () => {
    mockRequest.mockImplementation(async (path: string) => {
      if (path.endsWith('/preview')) return { files: ['SKILL.md', 'scripts/run.sh'], skill_md: '---\nname: codeql\n---\n' }
      if (path.includes('/file?path=scripts%2Frun.sh')) {
        return { path: 'scripts/run.sh', size: 14, binary: false, too_large: false, content: '#!/bin/sh\necho hi\n' }
      }
      if (path.startsWith('/api/admin/shared-skills')) return { skills: ROWS }
      return {}
    })
    render(<SharedSkills />)
    const btns = await screen.findAllByTitle('查看内容预览')
    fireEvent.click(btns[0]!)
    const fileChip = await screen.findByText('scripts/run.sh')
    expect(fileChip).toBeInTheDocument()
    fireEvent.click(fileChip)
    expect(await screen.findByText(/echo hi/u)).toBeInTheDocument()
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('/api/admin/shared-skills/codeql/1.0.0/file?path=scripts%2Frun.sh')
    })
  })
})
