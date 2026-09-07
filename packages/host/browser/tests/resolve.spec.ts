import { describe, expect, it } from 'vitest'
import { groupLabelFrom, resolveGroupKey, SessionLineage } from '../src/resolve.ts'

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
    expect(resolveGroupKey(lineage, 'sub')).toBe('top')
    expect(resolveGroupKey(lineage, 'loner')).toBe('loner')
  })
})

describe('groupLabelFrom', () => {
  it('uses the trimmed title when present', () => {
    expect(groupLabelFrom('  Hello World  ', 'abcdef123456')).toBe('Hello World')
  })

  it('falls back to the short code when the title is empty or whitespace', () => {
    expect(groupLabelFrom('', 'abcdef123456')).toBe('会话 abcdef')
    expect(groupLabelFrom('   ', 'abcdef123456')).toBe('会话 abcdef')
    expect(groupLabelFrom(undefined, 'abcdef123456')).toBe('会话 abcdef')
  })
})
