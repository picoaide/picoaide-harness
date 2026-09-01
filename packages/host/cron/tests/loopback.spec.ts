import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import { browserSameOriginMarker, isLoopbackRequest } from '../src/loopback.ts'

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

describe('isLoopbackRequest', () => {
  it('accepts a loopback socket + loopback host with no origin', () => {
    expect(isLoopbackRequest(request({ remoteAddress: '127.0.0.1', host: 'localhost:43120' }))).toBe(true)
    expect(isLoopbackRequest(request({ remoteAddress: '::1', host: '[::1]:43120' }))).toBe(true)
    expect(isLoopbackRequest(request({ remoteAddress: '::ffff:127.0.0.1', host: '127.0.0.1:43120' }))).toBe(true)
  })

  it('accepts a same-host origin (browser same-origin fetch carries Origin)', () => {
    expect(isLoopbackRequest(request({
      remoteAddress: '127.0.0.1',
      host: 'localhost:43120',
      origin: 'http://localhost:43120',
    }))).toBe(true)
  })

  it('rejects a cross-origin browser request (Origin mismatch)', () => {
    expect(isLoopbackRequest(request({
      remoteAddress: '127.0.0.1',
      host: 'localhost:43120',
      origin: 'https://evil.example',
    }))).toBe(false)
  })

  it('rejects a cross-site browser request even with a forged Origin', () => {
    expect(isLoopbackRequest(request({
      remoteAddress: '127.0.0.1',
      host: 'localhost:43120',
      origin: 'http://localhost:43120',
      secFetchSite: 'cross-site',
    }))).toBe(false)
  })

  it('rejects non-loopback sockets and hosts', () => {
    expect(isLoopbackRequest(request({ remoteAddress: '10.0.0.1', host: 'localhost:43120' }))).toBe(false)
    expect(isLoopbackRequest(request({ remoteAddress: '192.168.1.2', host: '192.168.1.2:43120' }))).toBe(false)
    expect(isLoopbackRequest(request({ remoteAddress: '127.0.0.1', host: 'example.com' }))).toBe(false)
    expect(isLoopbackRequest(request({ remoteAddress: '127.0.0.1', host: '127.0.0.2:43120' }))).toBe(true) // 127/8 accepted
  })

  it('rejects missing or malformed fields', () => {
    expect(isLoopbackRequest(request({ host: 'localhost' }))).toBe(false)
    expect(isLoopbackRequest(request({ remoteAddress: '127.0.0.1' }))).toBe(false)
    expect(isLoopbackRequest(request({ remoteAddress: '127.0.0.1', host: '' }))).toBe(false)
    expect(isLoopbackRequest(request({ remoteAddress: '127.0.0.1', host: 'not a host' }))).toBe(false)
    expect(isLoopbackRequest(request({ remoteAddress: '127.0.0.1', host: 'localhost:43120', origin: 'not a url' }))).toBe(false)
  })

  it('never trusts X-Forwarded-For: the socket address is authoritative', () => {
    const req = request({ remoteAddress: '10.0.0.1', host: 'localhost:43120' })
    req.headers['x-forwarded-for'] = '127.0.0.1'
    expect(isLoopbackRequest(req)).toBe(false)
  })
})

describe('browserSameOriginMarker', () => {
  it('accepts same-origin and Origin-carrying requests', () => {
    expect(browserSameOriginMarker(request({ secFetchSite: 'same-origin' }))).toBe(true)
    expect(browserSameOriginMarker(request({ origin: 'http://localhost:43120' }))).toBe(true)
  })

  it('rejects bare requests without browser markers (tripwire only)', () => {
    expect(browserSameOriginMarker(request({}))).toBe(false)
  })
})
