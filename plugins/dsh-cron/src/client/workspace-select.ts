/**
 * Project (workspace) options for the cron job editor. Reads the client
 * workspaces feed (the same list the shell sidebar shows) — implemented
 * locally because cross-package client imports are forbidden; the sibling
 * dsh-task plugin owns its own copy.
 */
import { useEffect, useState } from 'react'
import type { IWorkspaces } from '@deepseek-ai/dsh-client-runtime/client'

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
