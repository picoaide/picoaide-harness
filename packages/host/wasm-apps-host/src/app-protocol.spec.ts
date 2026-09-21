/**
 * 协议原语回归（契约 §4.2/§4.3）。
 *
 * 变异验证（改回危险实现即红）：
 *  - `buildRequestEnvelope` 不补 `origin` ⇒ "补 Origin" 组必红；
 *  - `REQUEST_HEADER_DENYLIST` 去掉 `authorization`/`cookie` ⇒ 令牌透传组必红；
 *  - `responseHeadersOf` 不丢 `set-cookie` ⇒ cookie 组必红；
 *  - 体积闸门换成"不限" ⇒ 两档上限组必红。
 */
import { describe, expect, it } from 'vitest'
import {
  APP_ENVELOPE_MAX_BYTES,
  APP_REQUEST_BODY_MAX_BYTES,
  APP_RESPONSE_BODY_MAX_BYTES,
  appOrigin,
  buildRequestEnvelope,
  decodeBase64Body,
  forwardableRequestHeaders,
  isHtmlResponse,
  DEFAULT_APP_SCHEME,
  FORWARDED_REQUEST_HEADERS,
  REQUEST_HEADER_COUNT_MAX,
  REQUEST_HEADER_VALUE_MAX_BYTES,
  headerGateViolation,
  isValidAppScheme,
  isValidAppId,
  parseAppUrl,
  parseResponseEnvelope,
  responseHeadersOf,
  wantsHtml,
} from './app-protocol.ts'

describe('app url parsing (strict)', () => {
  it('parses scheme/host/path/query into the envelope fields', () => {
    expect(parseAppUrl('picoaide-app://demo/notes?page=2', 'picoaide-app')).toEqual({
      appId: 'demo',
      path: '/notes',
      query: 'page=2',
    })
  })

  it('treats the bare origin as the root path with no query', () => {
    expect(parseAppUrl('picoaide-app://demo/', 'picoaide-app')).toEqual({ appId: 'demo', path: '/', query: '' })
    expect(parseAppUrl('picoaide-app://demo', 'picoaide-app')).toEqual({ appId: 'demo', path: '/', query: '' })
  })

  it('rejects every non-app scheme and shape', () => {
    for (const raw of [
      'https://demo/notes',
      'picoaide-app-extra://demo/',
      'picoaide-app:///notes',
      'picoaide-app://Demo/notes',
      'picoaide-app://-demo/',
      'picoaide-app://demo--x/',
      'picoaide-app://demo.other/',
      '',
      'not a url',
      `picoaide-app://${'a'.repeat(64)}/`,
    ]) {
      expect(parseAppUrl(raw, 'picoaide-app'), raw).toBeNull()
    }
    expect(parseAppUrl(undefined, 'picoaide-app')).toBeNull()
    expect(parseAppUrl(42, 'picoaide-app')).toBeNull()
  })

  it('keeps the app id pattern in sync with the platform limits', () => {
    expect(isValidAppId('my-notes-2')).toBe(true)
    expect(isValidAppId('a')).toBe(true)
    for (const value of ['', 'A', 'a_b', 'a b', '-a', 'a-', 'a--b', 'a.b', 'a'.repeat(64)]) {
      expect(isValidAppId(value), value).toBe(false)
    }
  })
})

describe('request envelope', () => {
  const url = parseAppUrl('picoaide-app://demo/notes?page=2', 'picoaide-app')!

  it('synthesizes the self origin even though Chromium sends none (contract §4.3)', () => {
    const built = buildRequestEnvelope({
      scheme: DEFAULT_APP_SCHEME,
      url,
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: new TextEncoder().encode('{"title":"x"}'),
    })
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.envelope).toEqual({
      method: 'POST',
      path: '/notes',
      query: 'page=2',
      host: 'picoaide-app://demo',
      headers: { 'content-type': 'application/json', origin: 'picoaide-app://demo' },
      body: Buffer.from('{"title":"x"}').toString('base64'),
    })
  })

  it('forwards only the frozen whitelist — never credentials, cookies, a forged origin or browser hints', () => {
    const headers = new Headers({
      authorization: 'Bearer attacker',
      cookie: 'session=1',
      origin: 'https://evil.example',
      host: 'evil.example',
      referer: 'https://evil.example/',
      'accept-encoding': 'gzip',
      accept: 'application/json',
      // Chromium 每个请求都自带这些；黑名单口径会把它们塞进信封 ⇒ 服务端白名单拒 ⇒ 400。
      'sec-ch-ua': '"Chromium";v="150"',
      priority: 'u=0, i',
      'x-app-header': 'not-whitelisted',
    })
    const forwarded = forwardableRequestHeaders(headers)
    // `origin` 在**白名单里**（信封必须带一个 origin），但它的取值由 handler 合成并
    // **覆盖**，所以这里保留的是应用自带值、而下面断言的是合成值胜出（§4.3）。
    expect(forwarded).toEqual({ accept: 'application/json', origin: 'https://evil.example' })
    const built = buildRequestEnvelope({ scheme: DEFAULT_APP_SCHEME, url, method: 'GET', headers, body: new Uint8Array(0) })
    expect(built.ok).toBe(true)
    if (!built.ok) return
    // Origin 只可能是 handler 合成的自源（应用伪造的值在过滤阶段就被丢掉）。
    expect(built.envelope.headers.origin).toBe('picoaide-app://demo')
    expect(built.envelope.headers).not.toHaveProperty('authorization')
    expect(built.envelope.headers).not.toHaveProperty('cookie')
    expect(built.envelope.body).toBe('')
  })

  it('gates header count and value size locally instead of silently truncating (§5.1 limits)', () => {
    // 单值超限：本地拒绝（截断会让服务端看到"看着合法但内容变了"的请求）。
    const huge = new Headers({ accept: 'a'.repeat(REQUEST_HEADER_VALUE_MAX_BYTES + 1) })
    expect(buildRequestEnvelope({ scheme: DEFAULT_APP_SCHEME, url, method: 'GET', headers: huge, body: new Uint8Array(0) }))
      .toMatchObject({ ok: false, reason: 'header-value-too-large', limit: REQUEST_HEADER_VALUE_MAX_BYTES })
    // 条数闸门：白名单只有 8 项，条数上限在真实链路上不可达 —— 直接对闸门函数钉形状
    // （它是"服务端也有一份"的那条判据，不能被静默删掉）。
    const many: Record<string, string> = {}
    for (let i = 0; i < REQUEST_HEADER_COUNT_MAX + 1; i += 1) many[`x-${String(i)}`] = 'v'
    expect(headerGateViolation(many)).toMatchObject({ reason: 'too-many-headers', limit: REQUEST_HEADER_COUNT_MAX })
    expect(headerGateViolation({ accept: 'application/json' })).toBeNull()
    // 变异验证：把白名单里任一顶删掉 ⇒ 上面第一条（只转发 8 项）即红。
    expect(FORWARDED_REQUEST_HEADERS).toHaveLength(8)
  })

  it('enforces both size gates (1 MiB body / 1 MiB*4/3 + 64 KiB envelope)', () => {
    const tooBig = buildRequestEnvelope({
      scheme: DEFAULT_APP_SCHEME,
      url,
      method: 'POST',
      headers: new Headers(),
      body: new Uint8Array(APP_REQUEST_BODY_MAX_BYTES + 1),
    })
    expect(tooBig).toMatchObject({ ok: false, reason: 'body-too-large' })

    // 体积上限常量必须与契约 §4.2 逐字一致（`limits.go` 同源）。
    expect(APP_REQUEST_BODY_MAX_BYTES).toBe(1 << 20)
    expect(APP_ENVELOPE_MAX_BYTES).toBe(Math.ceil((1 << 20) * 4 / 3) + (64 << 10))
    expect(APP_RESPONSE_BODY_MAX_BYTES).toBe(8 << 20)

    // 信封闸门是"头表闸门之外"的兜底：白名单口径下头表最多 8×8 KiB，正常到不了
    // 这里，所以直接喂一个超限的 body 走 body 闸门，再断言信封上限常量本身。
    const oversized = buildRequestEnvelope({
      scheme: DEFAULT_APP_SCHEME,
      url,
      method: 'POST',
      headers: new Headers(),
      body: new Uint8Array(APP_ENVELOPE_MAX_BYTES),
    })
    expect(oversized).toMatchObject({ ok: false, reason: 'body-too-large' })
  })
})

describe('response envelope', () => {
  it('accepts the contract example', () => {
    const result = parseResponseEnvelope({
      status: 200,
      headers: { 'Content-Type': ['text/html; charset=utf-8'] },
      body: Buffer.from('<h1>ok</h1>').toString('base64'),
      truncated: false,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.envelope.status).toBe(200)
    expect(result.envelope.headers['Content-Type']).toEqual(['text/html; charset=utf-8'])
    expect(result.envelope.truncated).toBe(false)
  })

  it('rejects malformed envelopes instead of guessing', () => {
    for (const value of [
      null,
      [],
      'text',
      {},
      { status: 0, headers: {}, body: '' },
      { status: 200, headers: {}, body: 42 },
      { status: 200, headers: { a: 1 }, body: '' },
      { status: 999, headers: {}, body: '' },
    ]) {
      expect(parseResponseEnvelope(value).ok, JSON.stringify(value)).toBe(false)
    }
  })

  it('drops Set-Cookie, hop-by-hop headers and Content-Length', () => {
    const headers = responseHeadersOf({
      'Content-Type': 'text/html; charset=utf-8',
      'Set-Cookie': ['a=1', 'b=2'],
      Connection: 'keep-alive',
      'Transfer-Encoding': 'chunked',
      'Content-Length': '3',
      'X-Kept': ['1', '2'],
    })
    expect(headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(headers.get('set-cookie')).toBeNull()
    expect(headers.get('connection')).toBeNull()
    expect(headers.get('transfer-encoding')).toBeNull()
    expect(headers.get('content-length')).toBeNull()
    expect(headers.get('x-kept')).toBe('1, 2')
  })

  it('decodes base64 strictly and rejects malformed input', () => {
    expect(decodeBase64Body('')).toEqual(new Uint8Array(0))
    expect(Array.from(decodeBase64Body(Buffer.from('hi').toString('base64'))!)).toEqual([0x68, 0x69])
    for (const bad of ['a', '!!!!', 'ab=c', 'abcde']) {
      expect(decodeBase64Body(bad), bad).toBeNull()
    }
  })

  it('classifies document navigations vs app fetches', () => {
    expect(wantsHtml(new Headers({ accept: 'text/html,application/xhtml+xml' }))).toBe(true)
    expect(wantsHtml(new Headers({ accept: 'application/json' }))).toBe(false)
    expect(wantsHtml(new Headers())).toBe(false)
    expect(isHtmlResponse(new Headers({ 'content-type': 'text/html; charset=utf-8' }))).toBe(true)
    expect(isHtmlResponse(new Headers({ 'content-type': 'application/json' }))).toBe(false)
  })

  it('accepts only the frozen scheme shape and rejects reserved schemes (design §8.3/§10)', () => {
    // 与 Go `channel.AppOriginScheme()` 的正则逐字一致：^[a-z][a-z0-9+.-]{1,31}$
    expect(isValidAppScheme('picoaide-app')).toBe(true)
    expect(isValidAppScheme('example-harness-app')).toBe(true)
    expect(isValidAppScheme('a1')).toBe(true)
    for (const value of ['a', '', 'A-app', '-app', 'app_', 'app name', 'x'.repeat(33), 'http', 'https', 'file', 'data', 'javascript', 'about', 'blob']) {
      expect(isValidAppScheme(value), value).toBe(false)
    }
  })

  it('builds the app origin from the parsed host only', () => {
    expect(appOrigin(DEFAULT_APP_SCHEME, 'demo')).toBe('picoaide-app://demo')
  })
})
