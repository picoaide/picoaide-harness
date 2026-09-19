/**
 * 深链队列（§7.6 冻结：≤8 条 / TTL 5 min / 去重 / FIFO）与路径净化（§23.2 N8）的判据。
 * 变异验证：把 `prune` 的 TTL 判断去掉 ⇒ 过期用例必红；把容量上限去掉 ⇒ 有界用例必红。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  DEEP_LINK_QUEUE_MAX,
  DEEP_LINK_QUEUE_TTL_MS,
  createDeepLinkQueue,
  sanitizeAppPath,
} from './deep-link-queue.ts'

describe('deep link queue (§7.6)', () => {
  it('is bounded at 8 entries and drops the oldest with a warning', () => {
    const warn = vi.fn()
    const queue = createDeepLinkQueue({ warn })
    for (let i = 1; i <= DEEP_LINK_QUEUE_MAX + 2; i += 1) queue.enqueue(`app-${String(i)}`)
    expect(queue.size()).toBe(DEEP_LINK_QUEUE_MAX)
    expect(queue.list().map(item => item.appId)).toEqual(
      Array.from({ length: DEEP_LINK_QUEUE_MAX }, (_, index) => `app-${String(index + 3)}`),
    )
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('drops entries older than the TTL instead of failing', () => {
    let now = 0
    const warn = vi.fn()
    const queue = createDeepLinkQueue({ now: () => now, warn })
    queue.enqueue('my-notes')
    now = DEEP_LINK_QUEUE_TTL_MS - 1
    expect(queue.peek()?.appId).toBe('my-notes')
    now = DEEP_LINK_QUEUE_TTL_MS
    expect(queue.peek()).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('expired'))
  })

  it('de-duplicates by app_id + path and keeps FIFO order', () => {
    const queue = createDeepLinkQueue()
    queue.enqueue('a', '/x')
    queue.enqueue('b', '/y')
    queue.enqueue('a', '/x')
    expect(queue.list().map(item => `${item.appId}${item.path}`)).toEqual(['b/y', 'a/x'])
    expect(queue.shift()?.appId).toBe('b')
    expect(queue.peek()?.appId).toBe('a')
    expect(queue.shift()?.appId).toBe('a')
    expect(queue.shift()).toBeUndefined()
  })

  it('clears on account switch (上一个用户的待打开目标不得在新用户下打开)', () => {
    const queue = createDeepLinkQueue()
    queue.enqueue('a')
    queue.clear()
    expect(queue.size()).toBe(0)
    expect(queue.peek()).toBeUndefined()
  })
})

describe('deep link path sanitizing (§23.2 N8 / RED-3)', () => {
  it('keeps ordinary relative paths and defaults everything else to "/"', () => {
    expect(sanitizeAppPath('/notes/1?page=2')).toBe('/notes/1?page=2')
    expect(sanitizeAppPath(undefined)).toBe('/')
    expect(sanitizeAppPath('')).toBe('/')
    expect(sanitizeAppPath('notes')).toBe('/')
    expect(sanitizeAppPath(`/${'a'.repeat(3000)}`)).toBe('/')
  })

  it('rejects protocol-relative, traversal and userinfo shapes', () => {
    for (const hostile of ['//evil.example/x', '/\\evil', '/%2e%2e/etc', '/a/../../b', '/@evil', '/a\u0000b', '/%2F%2Fevil']) {
      // URL 解析器会给 `?path=` 解码一次，所以这里两种形态都覆盖：原始与解码后。
      expect(sanitizeAppPath(hostile), hostile).toBe('/')
      expect(sanitizeAppPath(decodeURIComponentSafe(hostile)), hostile).toBe('/')
    }
  })
})

/** decodeURIComponent 的宽松版（畸形百分号编码时原样返回，供夹具使用）。 */
function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}
