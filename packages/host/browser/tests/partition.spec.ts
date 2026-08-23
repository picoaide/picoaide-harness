import { describe, expect, it } from 'vitest'
import { browserPartitionFor, encodePartitionSegment } from '../src/electron-adapter.ts'

describe('browser partition per-user', () => {
  it('partitions per username', () => {
    expect(browserPartitionFor('alice')).toBe('persist:agent-browser-alice')
    expect(browserPartitionFor('bob')).not.toBe(browserPartitionFor('alice'))
  })

  it('falls back to anonymous partition without a username', () => {
    expect(browserPartitionFor(null)).toBe('persist:agent-browser-anonymous')
    expect(browserPartitionFor(undefined)).toBe('persist:agent-browser-anonymous')
  })

  it('encodes separators and dots so names never collide or escape', () => {
    expect(encodePartitionSegment('a/b')).toBe('a~2F~b')
    expect(encodePartitionSegment('..')).toBe('~2E~~2E~')
    expect(encodePartitionSegment('')).toBe('anonymous')
    expect(browserPartitionFor('alice.1')).toBe('persist:agent-browser-alice~2E~1')
  })
})
