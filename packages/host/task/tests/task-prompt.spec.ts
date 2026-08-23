import { describe, expect, it } from 'vitest'
import { buildTaskPrompt } from '../src/task-prompt.ts'
import { createTask } from '../src/tasks.ts'

describe('buildTaskPrompt', () => {
  it('injects title, description, project, permission, and the action', () => {
    const task = createTask('t-1', {
      title: 'Ship the report',
      description: 'Write and send the weekly report',
      prompt: '请生成周报并发送',
      workspaceId: 'w-1',
      permission: 'danger-full-access',
    }, 1_000)

    const text = buildTaskPrompt(task)
    expect(text).toContain('任务：Ship the report')
    expect(text).toContain('任务描述：Write and send the weekly report')
    expect(text).toContain('项目（工作区）：w-1')
    expect(text).toContain('权限预设：danger-full-access')
    expect(text).toContain('请完成以下任务：请生成周报并发送')
  })

  it('falls back to the title as the action when no prompt is set', () => {
    const task = createTask('t-2', { title: 'Do the thing', description: '', prompt: '' }, 1_000)
    const text = buildTaskPrompt(task)
    expect(text).toContain('请完成以下任务：Do the thing')
    expect(text).not.toContain('任务描述')
    expect(text).not.toContain('项目')
    expect(text).not.toContain('权限')
  })
})
