/**
 * Task context assembly: builds the full prompt injected into the execution
 * session. The session is a fresh conversation inside the pinned project
 * (workspace); the first message carries the task's full context (title,
 * description, project, permission, timestamps) plus the user's prompt, so
 * the agent executes with the same understanding the board shows — and the
 * execution record persists the exact injected text for post-run review.
 */
import type { TaskRecord } from './tasks.ts'

/** Build the model-facing task context block (stable, deterministic prose). */
export function buildTaskPrompt(task: TaskRecord): string {
  const lines: string[] = []

  lines.push(`【任务看板执行】任务：${task.title}`)

  if (task.description !== '') {
    lines.push(`任务描述：${task.description}`)
  }

  if (task.workspaceId !== undefined) {
    lines.push(`项目（工作区）：${task.workspaceId}`)
  }

  if (task.permission !== undefined) {
    lines.push(`权限预设：${task.permission}`)
  }

  lines.push(`创建时间：${new Date(task.createdAt).toLocaleString()}`)

  // The user's execution prompt, or the task title as the default action.
  const action = task.prompt !== '' ? task.prompt : task.title
  lines.push('')
  lines.push(`请完成以下任务：${action}`)

  return lines.join('\n')
}
