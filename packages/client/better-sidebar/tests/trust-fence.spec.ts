import { describe, expect, it } from 'vitest'
import { isLoopbackAddress, isTrustedApiRequest } from '../src/trust-fence.ts'

function req(headers: Record<string, string | undefined>, remote?: string) {
  return {
    headers,
    socket: remote === undefined ? undefined : { remoteAddress: remote },
  }
}

describe('better-sidebar trust fence (F15)', () => {
  it('Host 自称 loopback 且 socket 是 loopback → 放行', () => {
    expect(isTrustedApiRequest(req({ host: '127.0.0.1:3000' }, '127.0.0.1'), [])).toBe(true)
    expect(isTrustedApiRequest(req({ host: 'localhost:3000' }, '::1'), [])).toBe(true)
    expect(isTrustedApiRequest(req({ host: '127.0.0.1:3000' }, '::ffff:127.0.0.1'), [])).toBe(true)
  })

  it('Host 伪造 loopback 但 socket 来自远程 → 拒绝(旧实现只信 Host 头)', () => {
    expect(isTrustedApiRequest(req({ host: '127.0.0.1:3000' }, '10.0.0.5'), [])).toBe(false)
    expect(isTrustedApiRequest(req({ host: 'localhost:3000' }, '192.168.1.9'), [])).toBe(false)
  })

  it('显式 trustedHosts 的非 loopback 权威仍放行(局域网 web UI 场景)', () => {
    expect(isTrustedApiRequest(req({ host: '10.0.0.5:3000' }, '10.0.0.5'), ['10.0.0.5:3000'])).toBe(true)
    expect(isTrustedApiRequest(req({ host: '10.0.0.5:3000' }, '10.0.0.5'), [])).toBe(false)
  })

  it('跨站标记/跨源 Origin 一律拒绝', () => {
    expect(isTrustedApiRequest(req({ host: '127.0.0.1:3000', 'sec-fetch-site': 'cross-site' }, '127.0.0.1'), [])).toBe(false)
    expect(isTrustedApiRequest(req({ host: '127.0.0.1:3000', origin: 'https://evil.example' }, '127.0.0.1'), [])).toBe(false)
    expect(isTrustedApiRequest(req({ host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' }, '127.0.0.1'), [])).toBe(true)
  })

  it('结构桩(无 socket)保持旧行为,真实 HTTP 永远带 socket', () => {
    expect(isTrustedApiRequest(req({ host: '127.0.0.1:3000' }), [])).toBe(true)
  })

  it('isLoopbackAddress 覆盖 IPv4-mapped 与 IPv6', () => {
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('::1')).toBe(true)
    expect(isLoopbackAddress('127.1.2.3')).toBe(true)
    expect(isLoopbackAddress('10.0.0.1')).toBe(false)
    expect(isLoopbackAddress(undefined)).toBe(false)
  })
})
