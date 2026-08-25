import { describe, expect, it } from 'vitest'
import {
  avatarColor,
  compareVersions,
  hasUpdateFor,
  latestApprovedVersionByName,
  mergeItems,
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
