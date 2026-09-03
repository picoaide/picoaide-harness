import { describe, expect, it } from 'vitest'
import {
  avatarColor,
  compareVersions,
  hasUpdateFor,
  installEndpoint,
  latestApprovedVersionByName,
  mergeItems,
  uninstallEndpoint,
  type CapabilityItem,
} from '../src/client/CapabilityCenterPanel.tsx'

describe('compareVersions', () => {
  it('compares numerically (1.9.0 < 1.10.0)', () => {
    expect(compareVersions('1.9.0', '1.10.0')).toBe(-1)
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1)
  })
  it('treats a trailing alphabetic run as prerelease (rc < release)', () => {
    expect(compareVersions('1.0.0-rc1', '1.0.0')).toBe(-1)
    expect(compareVersions('1.0.0', '1.0.0-rc1')).toBe(1)
  })
  it('handles equal versions', () => {
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('v2', 'v2')).toBe(0)
  })
  it('falls back to byte order for non-semver inputs', () => {
    expect(compareVersions('abc!', 'abcd')).toBe(-1)
    expect(compareVersions('', '1.0')).toBe(-1)
  })
})

describe('latestApprovedVersionByName', () => {
  const rows: CapabilityItem[] = [
    { kind: 'skill', source: 'org', name: 'codeql', displayName: '', version: '1.0.0', description: '', author: 'a', status: 'approved', versions: ['1.0.0'] },
    { kind: 'skill', source: 'org', name: 'codeql', displayName: '', version: '1.2.0', description: '', author: 'a', status: 'approved', versions: ['1.2.0'] },
    { kind: 'skill', source: 'org', name: 'codeql', displayName: '', version: '2.0.0-rc1', description: '', author: 'a', status: 'pending', versions: [] },
  ]
  it('returns the numerically-highest approved version; ignores pending', () => {
    expect(latestApprovedVersionByName(rows, 'skill', 'codeql')).toBe('1.2.0')
  })
  it('returns undefined when no approved rows', () => {
    expect(latestApprovedVersionByName(rows, 'skill', 'missing')).toBeUndefined()
  })
})

describe('hasUpdateFor', () => {
  it('true when approved latest > installed version', () => {
    const item: CapabilityItem = { kind: 'skill', source: 'org', name: 'x', displayName: '', version: '1.2.0', description: '', author: '', status: 'approved', versions: ['1.0.0', '1.2.0'], installed: true, installedVersion: '1.0.0' }
    expect(hasUpdateFor(item)).toBe(true)
  })
  it('false when installed version is the latest', () => {
    const item: CapabilityItem = { kind: 'skill', source: 'org', name: 'x', displayName: '', version: '1.2.0', description: '', author: '', status: 'approved', versions: ['1.2.0'], installed: true, installedVersion: '1.2.0' }
    expect(hasUpdateFor(item)).toBe(false)
  })
  it('false when not installed', () => {
    const item: CapabilityItem = { kind: 'skill', source: 'org', name: 'x', displayName: '', version: '1.2.0', description: '', author: '', status: 'approved', versions: ['1.2.0'], installed: false }
    expect(hasUpdateFor(item)).toBe(false)
  })
})

describe('installEndpoint / uninstallEndpoint (来源路由 bug 回归)', () => {
  const base: CapabilityItem = { kind: 'skill', source: 'org', name: 'codeql', displayName: '', version: '1.0.0', description: '', author: 'a', status: 'approved', versions: ['1.0.0'], installed: false }

  it('market skill installs via /api/pico/skills (gateway marketplace), NOT shared-skills', () => {
    const market = { ...base, source: 'market' as const }
    expect(installEndpoint(market, '1.0.0')).toBe('/api/pico/skills/codeql/install')
    // 回归:57aeffecbb 曾把所有技能路由到 shared-skills → 网关 404 gateway error。
    expect(installEndpoint(market, '1.0.0')).not.toContain('shared-skills')
  })

  it('org shared skill installs via /api/pico/shared-skills with version', () => {
    expect(installEndpoint(base, '1.2.0')).toBe('/api/pico/shared-skills/codeql/1.2.0/install')
  })

  it('market skill uninstalls via /api/pico/skills (matched install route)', () => {
    const market = { ...base, source: 'market' as const }
    expect(uninstallEndpoint(market, '1.0.0')).toBe('/api/pico/skills/codeql/uninstall')
    expect(uninstallEndpoint(base, '1.0.0')).toBe('/api/pico/shared-skills/codeql/1.0.0/uninstall')
  })

  it('agent install/uninstall route via /api/pico/agent-presets', () => {
    const agent: CapabilityItem = { ...base, kind: 'agent', name: 'creative-writer', source: 'org' }
    expect(installEndpoint(agent, '1.0.0')).toBe('/api/pico/agent-presets/creative-writer/install')
    expect(uninstallEndpoint(agent, '1.0.0')).toBe('/api/pico/agent-presets/creative-writer/uninstall')
  })

  it('force install appends ?force=1', () => {
    expect(installEndpoint(base, '1.0.0', true)).toBe('/api/pico/shared-skills/codeql/1.0.0/install?force=1')
  })
})

describe('mergeItems', () => {
  it('collapses same kind+name into one card with highest approved version', () => {
    const rows: CapabilityItem[] = [
      { kind: 'skill', source: 'org', name: 'codeql', displayName: '', version: '1.0.0', description: '', author: 'a', status: 'approved', versions: ['1.0.0'] },
      { kind: 'skill', source: 'org', name: 'codeql', displayName: '', version: '1.10.0', description: '', author: 'a', status: 'approved', versions: ['1.10.0'] },
    ]
    const merged = mergeItems(rows)
    expect(merged).toHaveLength(1)
    expect(merged[0]!.version).toBe('1.10.0')
    expect(merged[0]!.versions).toEqual(['1.0.0', '1.10.0'])
  })
  it('keeps skill and agent separate when names collide', () => {
    const rows: CapabilityItem[] = [
      { kind: 'skill', source: 'org', name: 'codeql', displayName: '', version: '1.0.0', description: '', author: 'a', status: 'approved', versions: ['1.0.0'] },
      { kind: 'agent', source: 'org', name: 'codeql', displayName: '', version: '1.0.0', description: '', author: 'a', status: 'approved', versions: ['1.0.0'] },
    ]
    const merged = mergeItems(rows)
    expect(merged).toHaveLength(2)
    expect(merged.map(m => m.kind).sort()).toEqual(['agent', 'skill'])
  })
})

describe('avatarColor', () => {
  it('returns a stable color token for any non-empty name', () => {
    const color = avatarColor('code-review')
    expect(color).toMatch(/^var\(--dsw-static-/u)
    expect(avatarColor('code-review')).toBe(avatarColor('code-review'))
  })
  it('handles the empty name (fallback first color)', () => {
    expect(avatarColor('')).toBe('var(--dsw-static-deepseek-5, var(--dsw-alias-brand-primary))')
  })
})

describe('mergeItems cross-source merge (market/org 合并 bug 修复)', () => {
  it('keeps market as the display source when the same name exists in org', () => {
    const items = [
      { kind: 'skill', source: 'market', name: 'code-review', version: '1.0.0', status: 'approved', versions: ['1.0.0'], displayName: 'code-review', description: '代码审查' },
      { kind: 'skill', source: 'org', name: 'code-review', version: '2.0.0', status: 'approved', versions: ['2.0.0'], displayName: '代码审查', description: '组织版代码审查' },
    ] as never
    const merged = mergeItems(items)
    expect(merged.length).toBe(1)
    const row = merged[0]
    expect(row.source).toBe('market') // 市场优先
    expect(row.version).toBe('2.0.0') // approved 最高版本
    expect(row.displayName).toBe('代码审查') // 非空标题保留(不被 market 同名值覆盖)
    expect(row.description).toBe('组织版代码审查') // 非空描述保留(较新)
    expect(row.versions).toEqual(['1.0.0', '2.0.0'])
  })

  it('preserves org-only rows untouched', () => {
    const items = [
      { kind: 'agent', source: 'org', name: 'creative-writer', version: '1.0.0', status: 'pending', versions: [], displayName: '妙笔文案', description: '' },
    ] as never
    const merged = mergeItems(items)
    expect(merged.length).toBe(1)
    expect(merged[0].source).toBe('org')
    expect(merged[0].displayName).toBe('妙笔文案')
  })

  it('does not let a market-only same-name row shadow the org title when market has none', () => {
    const items = [
      { kind: 'skill', source: 'org', name: 'x', version: '1.0.0', status: 'approved', versions: ['1.0.0'], displayName: '中文标题', description: '描述' },
      { kind: 'skill', source: 'org', name: 'x', version: '1.1.0', status: 'approved', versions: ['1.1.0'], displayName: '', description: '' },
    ] as never
    const merged = mergeItems(items)
    expect(merged[0].displayName).toBe('中文标题')
    expect(merged[0].version).toBe('1.1.0')
  })
})

describe('0059 official & score fields', () => {
  const base: CapabilityItem = {
    kind: 'skill', source: 'market', name: 'official-skill', displayName: '', version: '1.0.0',
    description: '', author: '', status: 'approved', versions: ['1.0.0'], installed: false,
  }
  it('types permit official/downloads/calls/score', () => {
    const item: CapabilityItem = { ...base, official: true, downloads: 10, calls: 5, score: 25 }
    expect(item.official).toBe(true)
    expect(item.score).toBe(25)
  })
  it('quality no longer permits official value (retired to official attr)', () => {
    // 编译期保证: quality 只接受 '' | 'featured'
    const item: CapabilityItem = { ...base, quality: 'featured' }
    expect(item.quality).toBe('featured')
  })
})
