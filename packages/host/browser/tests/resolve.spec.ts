import { describe, expect, it } from 'vitest'
import { projectLabelFrom, projectKeyFrom, resolveGroupKey, SessionLineage } from '../src/resolve.ts'

describe('SessionLineage.resolve', () => {
  it('returns the session id itself when no lineage is known', () => {
    const lineage = new SessionLineage()
    expect(lineage.resolve('session-a')).toBe('session-a')
    expect(lineage.resolve('another-id')).toBe('another-id')
  })

  it('resolves a two-level chain to the top-level id', () => {
    const lineage = new SessionLineage()
    lineage.registerLineage('child', 'parent')
    lineage.registerLineage('parent', 'root')
    expect(lineage.resolve('child')).toBe('root')
    expect(lineage.resolve('parent')).toBe('root')
    expect(lineage.resolve('root')).toBe('root')
  })

  it('tolerates circular registrations without hanging', () => {
    const lineage = new SessionLineage()
    lineage.registerLineage('a', 'b')
    lineage.registerLineage('b', 'a')
    const resolved = lineage.resolve('a')
    expect(['a', 'b']).toContain(resolved)
    // No infinite loop: a second call returns the same cached result.
    expect(lineage.resolve('a')).toBe(resolved)
    expect(lineage.resolve('b')).toBe(resolved)
  })

  it('ignores self-registration and empty ids (defensive)', () => {
    const lineage = new SessionLineage()
    lineage.registerLineage('a', 'a') // self-link: ignored
    expect(lineage.resolve('a')).toBe('a')
    lineage.registerLineage('', 'b') // empty child: ignored
    lineage.registerLineage('a', '') // empty parent: ignored
    expect(lineage.resolve('')).toBe('')
    expect(lineage.resolve('a')).toBe('a')
  })

  it('forget removes lineage and cached roots', () => {
    const lineage = new SessionLineage()
    lineage.registerLineage('child', 'root')
    expect(lineage.resolve('child')).toBe('root')
    lineage.forget('child')
    expect(lineage.resolve('child')).toBe('child')
  })

  it('forget on a root resolves the chain back to the root id', () => {
    const lineage = new SessionLineage()
    lineage.registerLineage('b', 'a')
    lineage.registerLineage('c', 'b')
    expect(lineage.resolve('c')).toBe('a')
    lineage.forget('a') // roots cache for 'a' dropped; chain still walks to 'a'
    expect(lineage.resolve('c')).toBe('a')
  })
})

describe('SessionLineage.rootsOf', () => {
  it('returns an empty set for a fresh lineage', () => {
    const lineage = new SessionLineage()
    expect(lineage.rootsOf().size).toBe(0)
  })

  it('collects every resolved root key', () => {
    const lineage = new SessionLineage()
    lineage.registerLineage('b', 'a')
    lineage.registerLineage('c', 'b')
    lineage.registerLineage('y', 'x')
    expect([...lineage.rootsOf()].sort()).toEqual(['a', 'x'])
  })

  it('includes standing-solo sessions once resolved', () => {
    const lineage = new SessionLineage()
    lineage.registerLineage('b', 'a')
    lineage.resolve('solo')
    expect([...lineage.rootsOf()].sort()).toEqual(['a', 'solo'])
  })
})

describe('resolveGroupKey', () => {
  it('returns undefined for missing or empty agentId', () => {
    const lineage = new SessionLineage()
    expect(resolveGroupKey(lineage, undefined)).toBeUndefined()
    expect(resolveGroupKey(lineage, '')).toBeUndefined()
  })

  it('resolves a known agent id to its group key, and unknown ids to themselves', () => {
    const lineage = new SessionLineage()
    lineage.registerLineage('sub', 'top')
    expect(resolveGroupKey(lineage, 'sub')).toBe('session:top')
    expect(resolveGroupKey(lineage, 'loner')).toBe('session:loner')
  })
})

describe('projectLabelFrom', () => {
  it('uses the trimmed title when present', () => {
    expect(projectLabelFrom('  Hello World  ', '/a/b')).toBe('Hello World')
  })

  it('falls back to the directory basename when no title', () => {
    expect(projectLabelFrom('', '/data/picoaide-harness')).toBe('picoaide-harness')
    expect(projectLabelFrom('   ', '/data/my-app')).toBe('my-app')
    expect(projectLabelFrom(undefined, 'C:\\\\work\\\\my-app')).toBe('my-app')
  })

  it('falls back to the default when nothing is known', () => {
    expect(projectLabelFrom(undefined, undefined)).toBe('未命名项目')
  })
})

describe('projectKeyFrom', () => {
  it('uses the session header cwd (canonical) as the project key', () => {
    expect(projectKeyFrom({ id: 's1', session: { header: { cwd: '/data/my-app' } } })).toBe('proj:/data/my-app')
  })

  it('prefers header cwd over meta cwd over session cwd', () => {
    expect(projectKeyFrom({ id: 's1', session: { header: { cwd: '/a' }, meta: { cwd: '/b' }, cwd: '/c' } })).toBe('proj:/a')
    expect(projectKeyFrom({ id: 's1', session: { meta: { cwd: '/b' }, cwd: '/c' } })).toBe('proj:/b')
    expect(projectKeyFrom({ id: 's1', session: { cwd: '/c' } })).toBe('proj:/c')
  })

  it('falls back to a per-session key when no cwd exists', () => {
    expect(projectKeyFrom({ id: 's1' })).toBe('session:s1')
  })

  it('returns undefined without an agent identity', () => {
    expect(projectKeyFrom(undefined)).toBeUndefined()
    expect(projectKeyFrom({ id: '' })).toBeUndefined()
  })

  it('canonicalizes trailing slashes', () => {
    expect(projectKeyFrom({ id: 's1', session: { cwd: '/data/my-app/' } })).toBe('proj:/data/my-app')
  })
})
