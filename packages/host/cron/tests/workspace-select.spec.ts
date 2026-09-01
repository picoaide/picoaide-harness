import { describe, expect, it } from 'vitest'
import { workspaceOptionsFrom, type WorkspaceOption } from '../src/client/workspace-select.ts'
import type { IWorkspaces } from '@deepseek-ai/dsh-client-runtime/client'

function workspaces(items: Array<{ workspaceId: number | string; title: string; path: string }>): IWorkspaces {
  return {
    list: {
      getSnapshot: () => ({ items }),
      subscribe: () => () => {},
    },
  } as unknown as IWorkspaces
}

describe('workspaceOptionsFrom', () => {
  it('maps items to id/title options', () => {
    const options = workspaceOptionsFrom(workspaces([
      { workspaceId: 1, title: 'Project A', path: '/home/a' },
      { workspaceId: 'ws-2', title: '', path: '/home/b' },
    ]))
    expect(options).toEqual([
      { workspaceId: '1', title: 'Project A' },
      { workspaceId: 'ws-2', title: '/home/b' },
    ])
  })

  it('returns an empty list for an undefined feed', () => {
    expect(workspaceOptionsFrom(undefined)).toEqual([])
  })

  it('falls back to the path for empty titles and keeps numeric ids as strings', () => {
    const options: WorkspaceOption[] = workspaceOptionsFrom(workspaces([
      { workspaceId: 42, title: '', path: '/srv/x' },
    ]))
    expect(options[0]!.workspaceId).toBe('42')
    expect(options[0]!.title).toBe('/srv/x')
  })
})
