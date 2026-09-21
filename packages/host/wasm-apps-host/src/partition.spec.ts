/**
 * 分区名镜像回归。
 *
 * 这些例值与 `packages/host/browser/tests/partition.spec.ts` **逐字相同**：两份
 * 实现（browser 的 `browserPartitionFor` 与本包的镜像）必须永不发散，否则协议
 * handler 会注册在一个没人用的分区上（应用页面 = 空白页）。
 *
 * 2026-09-21 审计 P1-10 证据②补齐的部分（`@<server-hash>` 后缀）在本文件末尾：
 * browser 侧必须**同批**改成同一份公式（`packages/host/browser/src/electron-adapter.ts`
 * 的 `browserPartitionFor` 一处），否则登录态下两边的分区名会不同。
 */
import { describe, expect, it } from 'vitest'
import { browserPartitionFor, encodePartitionSegment, serverPartitionHash } from './partition.ts'

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

/**
 * 服务端哈希后缀（§7.2 冻结：`persist:agent-browser-<user>@<server-hash>`）。
 *
 * 变异：`browserPartitionFor` 去掉后缀拼接 ⇒ 前两条必红；`serverPartitionHash` 不做
 * 尾斜杠归一化 ⇒ "尾斜杠是同一个服务端" 红；把匿名分支也加上后缀 ⇒ "匿名为空分区
 * 逐字不变" 红。
 */
describe('server-address hash in the partition name (§7.2 / P1-10②)', () => {
  const HASH_A = serverPartitionHash('https://a.example.com')!
  const HASH_B = serverPartitionHash('https://b.example.com')!

  it('serverPartitionHash: 32 位 hex、去尾斜杠、空值 undefined', () => {
    expect(HASH_A).toMatch(/^[0-9a-f]{32}$/)
    expect(HASH_A).not.toBe(HASH_B)
    expect(serverPartitionHash('https://a.example.com/')).toBe(HASH_A)
    expect(serverPartitionHash('  https://a.example.com//  ')).toBe(HASH_A)
    for (const bad of ['', '   ', '/', null, undefined]) {
      expect(serverPartitionHash(bad), String(bad)).toBeUndefined()
    }
  })

  it('分区名带 @<hash>：同一用户在不同服务端上必须落在不同分区', () => {
    expect(browserPartitionFor('alice', HASH_A)).toBe(`persist:agent-browser-alice@${HASH_A}`)
    expect(browserPartitionFor('alice', HASH_A)).not.toBe(browserPartitionFor('alice', HASH_B))
    // 没有哈希（未登录/服务端地址拿不到）⇒ 保持旧形状（滚动升级期不钉死任何一边）。
    expect(browserPartitionFor('alice')).toBe('persist:agent-browser-alice')
    expect(browserPartitionFor('alice', undefined)).toBe('persist:agent-browser-alice')
    expect(browserPartitionFor('alice', '')).toBe('persist:agent-browser-alice')
  })

  it('匿名分区与哈希无关（与 browser 包的启动分区逐字相同）', () => {
    expect(browserPartitionFor(null, HASH_A)).toBe('persist:agent-browser-anonymous')
    expect(browserPartitionFor('', HASH_B)).toBe('persist:agent-browser-anonymous')
  })
})
