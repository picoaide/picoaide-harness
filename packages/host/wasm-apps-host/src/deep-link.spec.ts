/**
 * 深链回归（契约 §4.5）：`<渠道 scheme>://app/<app_id>`，严格校验、未知一律丢弃。
 *
 * 变异验证：把 `parseAppDeepLink` 改成"scheme 不符也返回"或"接受多余路径段"，
 * 对应用例必红。
 */
import { describe, expect, it } from 'vitest'
import { parseAppDeepLink, parseForeignAppDeepLink } from './deep-link.ts'

describe('app deep link', () => {
  it('parses the channel scheme form', () => {
    expect(parseAppDeepLink('acmeai://app/my-notes', 'acmeai', 'picoaide-app')).toEqual({
      appId: 'my-notes',
      path: '/',
      url: 'picoaide-app://my-notes/',
    })
    expect(parseAppDeepLink('acmeai://app/my-notes/', 'acmeai', 'picoaide-app')?.appId).toBe('my-notes')
  })

  it('accepts the path-shaped spellings the desktop shell also accepts', () => {
    expect(parseAppDeepLink('acmeai:/app/my-notes', 'acmeai', 'picoaide-app')?.appId).toBe('my-notes')
    expect(parseAppDeepLink('acmeai:///app/my-notes', 'acmeai', 'picoaide-app')?.appId).toBe('my-notes')
  })

  it('carries ?path= into the internal URL and sanitizes it (§5.3/§23.2 N8)', () => {
    expect(parseAppDeepLink('acmeai://app/my-notes?path=/notes/1', 'acmeai', 'picoaide-app')).toEqual({
      appId: 'my-notes',
      path: '/notes/1',
      url: 'picoaide-app://my-notes/notes/1',
    })
    // 协议相对 / 穿越形态：丢弃 path 参数，**不**拒整条链接。
    for (const hostile of ['//evil.example/x', '/\\evil', '/%2e%2e/etc', '/a/../../b', '/@evil']) {
      const link = parseAppDeepLink(`acmeai://app/my-notes?path=${encodeURIComponent(hostile)}`, 'acmeai', 'picoaide-app')
      expect(link, hostile).not.toBeNull()
      expect(link?.url, hostile).toBe('picoaide-app://my-notes/')
    }
  })

  it('parameterizes the app origin scheme instead of hardcoding the official one (§7.8/CHN-3)', () => {
    expect(parseAppDeepLink('example-harness://app/my-notes', 'example-harness', 'example-harness-app')?.url)
      .toBe('example-harness-app://my-notes/')
    // 没有注入应用源 scheme ⇒ fail-closed（不猜官方值）。
    expect(parseAppDeepLink('acmeai://app/my-notes', 'acmeai', '')).toBeNull()
  })

  it('never hardcodes the official scheme', () => {
    // 官方 scheme 在**别的**安装的深链里：本安装（acmeai）必须丢弃它。
    expect(parseAppDeepLink('picoaide://app/my-notes', 'acmeai', 'picoaide-app')).toBeNull()
    expect(parseAppDeepLink('acmeai://app/my-notes', 'picoaide', 'picoaide-app')).toBeNull()
  })

  it('drops unknown hosts, extra path segments and malformed ids without a fallback', () => {
    for (const raw of [
      'acmeai://auth?token=t', // 登录回调：不是应用链接（由 enterprise 消费）
      'acmeai://my-notes', // host 不是 app
      'acmeai://app', // 缺 app_id
      'acmeai://app/',
      'acmeai://app/my-notes/extra',
      'acmeai://app/My-Notes',
      'acmeai://app/a--b',
      'https://app/my-notes',
      '',
      'not a url',
      `acmeai://app/${'a'.repeat(64)}`,
      `acmeai://app/${'a'.repeat(5000)}`,
    ]) {
      expect(parseAppDeepLink(raw, 'acmeai', 'picoaide-app'), raw).toBeNull()
    }
    expect(parseAppDeepLink(undefined, 'acmeai', 'picoaide-app')).toBeNull()
    expect(parseAppDeepLink(42, 'acmeai', 'picoaide-app')).toBeNull()
    // 没有注入深链 scheme 的宿主要 fail-closed（不猜官方值）。
    expect(parseAppDeepLink('acmeai://app/my-notes', '', 'picoaide-app')).toBeNull()
  })
})

describe('异渠道深链识别（接缝 J13 / §19 Q5）', () => {
  it('形状是应用深链但 scheme 不是本安装的 ⇒ 判定为"别人家的链接"', () => {
    expect(parseForeignAppDeepLink('other-brand://app/my-notes')).toEqual({ scheme: 'other-brand', appId: 'my-notes' })
    expect(parseForeignAppDeepLink('picoaide://app/my-notes?path=/x')?.scheme).toBe('picoaide')
    // 形状不符（不是 app 深链）⇒ null：那是畸形链接，不是异渠道提示的场合。
    expect(parseForeignAppDeepLink('other-brand://auth?token=t')).toBeNull()
    expect(parseForeignAppDeepLink('other-brand://app/My-Notes')).toBeNull()
    expect(parseForeignAppDeepLink('not a url')).toBeNull()
    expect(parseForeignAppDeepLink(42)).toBeNull()
    // 反向对照：本安装 scheme 的链接当然也解析得出（调用方自己比对排除）。
    expect(parseForeignAppDeepLink('acmeai://app/my-notes')?.scheme).toBe('acmeai')
  })
})
