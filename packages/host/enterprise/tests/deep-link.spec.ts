import { describe, expect, it } from 'vitest'
import { parseAuthDeepLink } from '../src/deep-link.ts'

describe('parseAuthDeepLink', () => {
  it('解析完整深链 token+server+user', () => {
    const s = parseAuthDeepLink('picoaide://auth?token=tok-1&server=https%3A%2F%2Fgw.example.com&user=alice')
    expect(s).toEqual({
      serverURL: 'https://gw.example.com',
      username: 'alice',
      token: 'tok-1',
    })
  })

  it('拒绝非 picoaide 协议 / 非 auth 主机 / 缺 token', () => {
    expect(parseAuthDeepLink('https://evil.com/auth?token=x')).toBeNull()
    expect(parseAuthDeepLink('picoaide://other?token=x')).toBeNull()
    expect(parseAuthDeepLink('picoaide://auth?server=https://gw.example.com')).toBeNull()
    expect(parseAuthDeepLink('not a url')).toBeNull()
  })

  it('没有 server/user 时返回空串字段(由监听器拒绝)', () => {
    const s = parseAuthDeepLink('picoaide://auth?token=tok-2')
    expect(s).not.toBeNull()
    expect(s!.serverURL).toBe('')
    expect(s!.username).toBe('')
    expect(s!.token).toBe('tok-2')
  })

  it('保留 server 中非默认端口', () => {
    const s = parseAuthDeepLink('picoaide://auth?token=t&server=https%3A%2F%2Fgw.example.com%3A8443&user=bob')
    expect(s!.serverURL).toBe('https://gw.example.com:8443')
  })
})
