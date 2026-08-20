/**
 * Project (workspace) picker shared by the new-task modal and the task
 * detail editor. Reads the client workspaces feed (the same list the shell
 * sidebar shows) and offers an empty "当前项目（默认）" option plus every
 * registered project.
 */
import { useEffect, useState } from 'react'
import type { IWorkspaces } from '@deepseek-ai/dsh-client-runtime/client'
import { styles } from './styles.ts'
import { t } from './locales.ts'

export interface WorkspaceOption {
  workspaceId: string
  title: string
}

/** Extract the workspace option list from the client feed. */
export function workspaceOptionsFrom(workspaces: IWorkspaces | undefined): WorkspaceOption[] {
  if (workspaces === undefined) return []
  const snapshot = workspaces.list.getSnapshot()
  return snapshot.items.map(item => ({
    workspaceId: String(item.workspaceId),
    title: item.title !== '' ? item.title : String(item.path),
  }))
}

/** Subscribe to the workspaces feed; returns the latest option list. */
export function useWorkspaceOptions(workspaces: IWorkspaces | undefined): WorkspaceOption[] {
  const [options, setOptions] = useState<WorkspaceOption[]>(() => workspaceOptionsFrom(workspaces))
  useEffect(() => {
    if (workspaces === undefined) return
    const update = (): void => { setOptions(workspaceOptionsFrom(workspaces)) }
    update()
    return workspaces.list.subscribe(update)
  }, [workspaces])
  return options
}

/**
 * Project select row. `value` is the selected workspaceId ('' = current
 * project); onChange receives the selected workspaceId or ''.
 */
export function WorkspacePicker({ workspaces, value, onChange }: {
  workspaces: IWorkspaces | undefined
  value: string
  onChange: (workspaceId: string) => void
}): JSX.Element {
  const options = useWorkspaceOptions(workspaces)
  return (
    <div style={styles.field}>
      <span style={styles.label}>{t('detail.workspace')}</span>
      <select
        style={styles.input}
        value={value}
        onChange={(event) => { onChange(event.target.value) }}
      >
        <option value="">{t('detail.current')}</option>
        {options.map(option => (
          <option key={option.workspaceId} value={option.workspaceId}>{option.title}</option>
        ))}
      </select>
    </div>
  )
}
