/**
 * 分区名镜像回归。
 *
 * 这些例值与 `packages/host/browser/tests/partition.spec.ts` **逐字相同**：两份
 * 实现（browser 的 `browserPartitionFor` 与本包的镜像）必须永不发散，否则协议
 * handler 会注册在一个没人用的分区上（应用页面 = 空白页）。
 */
import { describe, expect, it } from 'vitest'
import { browserPartitionFor, encodePartitionSegment } from './partition.ts'

describe('browser partition mirror', () => {
  it('partitions per username', () => {
    expect(browserPartitionFor('alice')).toBe('persist:agent-browser-alice')
    expect(browserPartitionFor('bob')).not.toBe(browserPartitionFor('alice'))
  })

  it('falls back to the anonymous partition without a username', () => {
    expect(browserPartitionFor(null)).toBe('persist:agent-browser-anonymous')
    expect(browserPartitionFor(undefined)).toBe('persist:agent-browser-anonymous')
    expect(browserPartitionFor('')).toBe('persist:agent-browser-anonymous')
  })

  it('encodes separators and dots so names never collide or escape', () => {
    expect(encodePartitionSegment('a/b')).toBe('a~2F~b')
    expect(encodePartitionSegment('..')).toBe('~2E~~2E~')
    expect(encodePartitionSegment('')).toBe('anonymous')
    expect(browserPartitionFor('alice.1')).toBe('persist:agent-browser-alice~2E~1')
  })
})
