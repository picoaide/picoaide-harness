import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import {
  browserSameOriginMarker,
  isIPv4Loopback,
  isLoopbackAddress,
  isLoopbackHostname,
  isLoopbackRequest,
} from '../src/loopback.ts'

function request(partial: {
  remoteAddress?: string
  host?: string
  origin?: string
  secFetchSite?: string
}): IncomingMessage {
  const headers: Record<string, string> = {}
  if (partial.host !== undefined) headers.host = partial.host
  if (partial.origin !== undefined) headers.origin = partial.origin
  if (partial.secFetchSite !== undefined) headers['sec-fetch-site'] = partial.secFetchSite
  return {
    headers,
    socket: { remoteAddress: partial.remoteAddress },
  } as unknown as IncomingMessage
}

describe('isIPv4Loopback', () => {
  it('accepts the whole 127/8 range', () => {
    expect(isIPv4Loopback('127.0.0.1')).toBe(true)
    expect(isIPv4Loopback('127.0.0.2')).toBe(true)
    expect(isIPv4Loopback('127.255.255.255')).toBe(true)
  })
  it('rejects non-127 addresses and malformed octets', () => {
    expect(isIPv4Loopback('192.168.1.1')).toBe(false)
    expect(isIPv4Loopback('128.0.0.1')).toBe(false)
    expect(isIPv4Loopback('127.0.0')).toBe(false)
    expect(isIPv4Loopback('127.0.0.1.1')).toBe(false)
    expect(isIPv4Loopback('127.0.0.256')).toBe(false)
    expect(isIPv4Loopback('127.0.0.abc')).toBe(false)
    expect(isIPv4Loopback('')).toBe(false)
  })
})

describe('isLoopbackAddress', () => {
  it('accepts IPv6 loopback and IPv4-mapped forms', () => {
    expect(isLoopbackAddress('::1')).toBe(true)
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('::ffff:127.1.2.3')).toBe(true)
  })
  it('rejects undefined, IPv6 link-local and public IPv4', () => {
    expect(isLoopbackAddress(undefined)).toBe(false)
    expect(isLoopbackAddress('fe80::1')).toBe(false)
    expect(isLoopbackAddress('::ffff:10.0.0.1')).toBe(false)
    expect(isLoopbackAddress('2001:db8::1')).toBe(false)
  })
})

describe('isLoopbackHostname', () => {
  it('accepts localhost, [::1] and 127/8', () => {
    expect(isLoopbackHostname('localhost')).toBe(true)
    expect(isLoopbackHostname('[::1]')).toBe(true)
    expect(isLoopbackHostname('127.0.0.1')).toBe(true)
  })
  it('rejects other names', () => {
    expect(isLoopbackHostname('example.com')).toBe(false)
    expect(isLoopbackHostname('::1')).toBe(false) // bracketed form expected
    expect(isLoopbackHostname('[fe80::1]')).toBe(false)
  })
})

describe('isLoopbackRequest', () => {
  it('accepts a loopback socket + loopback host, with and without origin', () => {
    expect(isLoopbackRequest(request({ remoteAddress: '127.0.0.1', host: 'localhost:43120' }))).toBe(true)
    expect(isLoopbackRequest(request({
      remoteAddress: '127.0.0.1', host: 'localhost:43120', origin: 'http://localhost:43120',
    }))).toBe(true)
  })
  it('rejects cross-site or cross-origin browser requests', () => {
    expect(isLoopbackRequest(request({
      remoteAddress: '127.0.0.1', host: 'localhost:43120', origin: 'https://evil.example',
    }))).toBe(false)
    expect(isLoopbackRequest(request({
      remoteAddress: '127.0.0.1', host: 'localhost:43120', origin: 'http://localhost:43120', secFetchSite: 'cross-site',
    }))).toBe(false)
  })
  it('rejects host-header spoofing from non-loopback sockets', () => {
    expect(isLoopbackRequest(request({ remoteAddress: '10.0.0.5', host: 'localhost:43120' }))).toBe(false)
  })
  it('rejects malformed hosts and origins', () => {
    expect(isLoopbackRequest(request({ remoteAddress: '127.0.0.1', host: 'not a host' }))).toBe(false)
    expect(isLoopbackRequest(request({ remoteAddress: '127.0.0.1', host: 'localhost:43120', origin: 'not-a-url' }))).toBe(false)
  })
})

describe('browserSameOriginMarker', () => {
  it('matches browsers and refuses bare curls', () => {
    expect(browserSameOriginMarker(request({ secFetchSite: 'same-origin' }))).toBe(true)
    expect(browserSameOriginMarker(request({ origin: 'http://localhost:43120' }))).toBe(true)
    expect(browserSameOriginMarker(request({}))).toBe(false)
  })
})
