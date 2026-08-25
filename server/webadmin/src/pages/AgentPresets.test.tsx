import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import AgentPresets from './AgentPresets'
import { request } from '../api'

const mockRequest = vi.mocked(request)

const ROWS = [
  { name: 'ppt-gen', display_name: 'PPT 生成', description: '做 PPT', version: '1.0.0', author: 'alice', status: 'pending', reason: '', created_at: '2026-08-01T10:00:00+08:00' },
  { name: 'code-review', display_name: '', description: '', version: '1.0.0', author: 'bob', status: 'approved', reason: '', created_at: '2026-08-02T10:00:00+08:00' },
  { name: 'old', display_name: '旧版', description: '', version: '1.0.0', author: 'bob', status: 'rejected', reason: '缺少 skills/', created_at: '2026-08-03T10:00:00+08:00' },
]

beforeEach(() => {
  mockRequest.mockReset()
  mockRequest.mockImplementation(async (path: string) => {
    if (path.startsWith('/api/admin/agent-presets')) return { presets: ROWS }
    return {}
  })
})

describe('AgentPresets 共享 Agent 审核页', () => {
  it('渲染列表与状态徽章', async () => {
    render(<AgentPresets />)
    expect(await screen.findByText('PPT 生成')).toBeInTheDocument()
    expect(screen.getByText('待审核')).toBeInTheDocument()
    expect(screen.getByText('已通过')).toBeInTheDocument()
    expect(screen.getByText('已拒绝')).toBeInTheDocument()
  })

  it('点击通过会调用 approve 接口并刷新', async () => {
    render(<AgentPresets />)
    const approve = await screen.findAllByText('通过')
    fireEvent.click(approve[0]!)
    // 确认弹窗
    const confirm = await screen.findByText('确定通过该共享 Agent 吗？')
    expect(confirm).toBeInTheDocument()
    fireEvent.click(screen.getByText('确认'))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('/api/admin/agent-presets/ppt-gen/1.0.0/approve', { method: 'POST' })
    })
  })

  it('删除调用 DELETE 接口', async () => {
    render(<AgentPresets />)
    const del = await screen.findAllByText('删除')
    fireEvent.click(del[0]!)
    fireEvent.click(await screen.findByText('确认'))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('/api/admin/agent-presets/ppt-gen/1.0.0', { method: 'DELETE' })
    })
  })

  it('拒绝必须填写理由,调用 reject 接口带 reason', async () => {
    render(<AgentPresets />)
    const reject = await screen.findAllByText('拒绝')
    fireEvent.click(reject[0]!)
    // 未填理由时确认按钮禁用
    const confirmBtn = await screen.findByRole('button', { name: '确认' })
    expect(confirmBtn).toBeDisabled()
    fireEvent.change(screen.getByLabelText('拒绝理由'), { target: { value: '缺少 skills/' } })
    fireEvent.click(confirmBtn)
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('/api/admin/agent-presets/ppt-gen/1.0.0/reject', {
        method: 'POST',
        body: JSON.stringify({ reason: '缺少 skills/' }),
      })
    })
  })

  it('在计数 Tab 切换后仍显示全量统计', async () => {
    render(<AgentPresets />)
    // 默认 all tab:全部 3 / 待审核 1 / 已通过 1 / 已拒绝 1
    expect(await screen.findByText('全部（3）')).toBeInTheDocument()
    fireEvent.click(screen.getByText('待审核（1）'))
    // 切到待审核后计数不变(基于全量数据)
    expect(await screen.findByText('全部（3）')).toBeInTheDocument()
    expect(screen.getByText('待审核（1）')).toBeInTheDocument()
    expect(screen.getByText('已通过（1）')).toBeInTheDocument()
  })

  it('点击预览展示 composition 与文件清单', async () => {
    mockRequest.mockImplementation(async (path: string) => {
      if (path.includes('/preview')) return { files: ['agent.cordis.yml', 'skills/demo/SKILL.md'], composition: '- id: persona\n' }
      if (path.startsWith('/api/admin/agent-presets')) return { presets: ROWS }
      return {}
    })
    render(<AgentPresets />)
    // 点击第一个预览按钮(图标),需按 title
    const previewBtns = await screen.findAllByTitle('查看内容预览')
    fireEvent.click(previewBtns[0]!)
    // composition 内容出现在 <pre> 中;文件清单 badge 出现
    expect(await screen.findByText('- id: persona')).toBeInTheDocument()
    expect(screen.getByText('skills/demo/SKILL.md')).toBeInTheDocument()
  })

  it('接口错误展示提示', async () => {
    mockRequest.mockImplementation(async () => { throw new Error('查询失败') })
    render(<AgentPresets />)
    expect(await screen.findByText('查询失败')).toBeInTheDocument()
  })
})
