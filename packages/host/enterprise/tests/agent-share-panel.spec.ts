import { describe, expect, it } from 'vitest'
import { latestApprovedPreset, splitCatalog } from '../src/client/AgentSharePanel.tsx'

const PRESETS = [
  { name: 'a', display_name: '', description: '', version: '1.0.0', author: 'x', status: 'approved' as const, created_at: '' },
  { name: 'b', display_name: '', description: '', version: '1.0.0', author: 'x', status: 'pending' as const, created_at: '' },
  { name: 'c', display_name: '', description: '', version: '1.0.0', author: 'x', status: 'rejected' as const, created_at: '' },
]

describe('splitCatalog 共享 Agent 分区', () => {
  it('把 approved 归入共享库,其余归入自己的列表', () => {
    const { own, shared } = splitCatalog(PRESETS)
    expect(shared.map(p => p.name)).toEqual(['a'])
    expect(own.map(p => p.name)).toEqual(['b', 'c'])
  })

  it('空目录返回两个空列表', () => {
    const { own, shared } = splitCatalog([])
    expect(own).toEqual([])
    expect(shared).toEqual([])
  })
})

describe('latestApprovedPreset 版本更新检测', () => {
  const rows = [
    { name: 'ppt', display_name: '', description: '', version: '1.0.0', author: 'x', status: 'approved' as const, created_at: '' },
    { name: 'ppt', display_name: '', description: '', version: '1.2.0', author: 'x', status: 'approved' as const, created_at: '' },
    { name: 'ppt', display_name: '', description: '', version: '2.0.0-rc', author: 'x', status: 'pending' as const, created_at: '' },
  ]

  it('返回数值最高的已审核版本,忽略审核中的', () => {
    expect(latestApprovedPreset(rows, 'ppt')).toBe('1.2.0')
  })

  it('无已审核版本时返回 undefined', () => {
    expect(latestApprovedPreset(rows, 'missing')).toBeUndefined()
  })
})
