/**
 * 2026-09-15 审计 BUG-03（凭据注入的站点绑定）的回归用例。
 *
 * 分两层：
 *  1. 派生规则（credential-site.ts）：显式配置 → 凭据字段里的 http(s) 地址 →
 *     null；结果与对象键序无关。
 *  2. 接线（index.ts 的 createCredentialResolver）：`originOf` 必须真的从
 *     凭据库读出来 —— 这是生产上唯一把闸门基准喂给 tools.ts 的地方，旧版本
 *     完全没接，工具对外承诺的 SITE-BOUND 因此只是文案。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { bareHostOrigin, credentialSiteOrigin, httpOriginOf, siteOriginFromFields } from '../src/credential-site.ts'
import { createCredentialResolver } from '../src/index.ts'
import { ConnectorStore } from '@picoaide/dsh-connectors/store'

let home: string
let previousHome: string | undefined

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'pico-browser-site-'))
  previousHome = process.env['DSH_HOME']
  process.env['DSH_HOME'] = home
})

afterEach(() => {
  if (previousHome === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = previousHome
  rmSync(home, { recursive: true, force: true })
})

describe('httpOriginOf', () => {
  it('accepts http/https and normalizes to an origin', () => {
    expect(httpOriginOf('https://login.example/app?x=1#f')).toBe('https://login.example')
    expect(httpOriginOf('  http://127.0.0.1:8080/login ')).toBe('http://127.0.0.1:8080')
  })

  it('refuses every non-http(s) shape a hostile page could produce', () => {
    for (const value of ['javascript:alert(1)', 'data:text/html,x', 'about:blank', 'file:///etc/passwd', '', '   ', 'not a url', null, undefined]) {
      expect(httpOriginOf(value as string | null | undefined), String(value)).toBeNull()
    }
  })

  it('stays strict about scheme-less hostnames (the bare-host normalization is opt-in per key)', () => {
    expect(httpOriginOf('app.glitchtip.com')).toBeNull()
  })
})

describe('bareHostOrigin: 用户按内置模板只填主机名', () => {
  it('normalizes address-shaped values the GlitchTip template asks for', () => {
    expect(bareHostOrigin('app.glitchtip.com')).toBe('https://app.glitchtip.com')
    expect(bareHostOrigin('glitchtip.corp.example/api')).toBe('https://glitchtip.corp.example')
    expect(bareHostOrigin('glitchtip.corp.example:8443/x')).toBe('https://glitchtip.corp.example:8443')
    expect(bareHostOrigin('localhost:8000')).toBe('http://localhost:8000')
    // Self-hosted addresses the template also asks for: IP, intranet single
    // label, IDN. Private/loopback/single-label default to http.
    expect(bareHostOrigin('127.0.0.1:8000')).toBe('http://127.0.0.1:8000')
    expect(bareHostOrigin('10.0.0.5:8000')).toBe('http://10.0.0.5:8000')
    // IP literals default to http (CGNAT / benchmark / public addresses alike):
    // guessing https made http intranet services permanently unbindable.
    expect(bareHostOrigin('100.64.0.7')).toBe('http://100.64.0.7')
    expect(bareHostOrigin('198.18.0.9')).toBe('http://198.18.0.9')
    expect(bareHostOrigin('203.0.113.9:8080')).toBe('http://203.0.113.9:8080')
    expect(bareHostOrigin('[2001:db8::1]')).toBe('http://[2001:db8::1]')
    expect(bareHostOrigin('glitchtip:8000')).toBe('http://glitchtip:8000')
    expect(bareHostOrigin('例子.中国')).toBe('https://xn--fsqu00a.xn--fiqs8s')
  })

  it('refuses values that are not host-shaped', () => {
    for (const value of ['not a host', 'https://x.example', 'javascript:alert(1)', '', undefined, 'x.y/z z']) {
      expect(bareHostOrigin(value as string | undefined), String(value)).toBeNull()
    }
  })
})

describe('siteOriginFromFields', () => {
  it('prefers address-shaped field names (self-hosted base URL pattern)', () => {
    expect(siteOriginFromFields({
      GLITCHTIP_TOKEN: 'https://token.example/should-not-win', // 值像 URL，但键名不是地址
      GLITCHTIP_BASE_URL: 'https://glitchtip.corp.example/api',
    })).toBe('https://glitchtip.corp.example')
  })

  it('falls back to any http(s) value and ignores the rest', () => {
    expect(siteOriginFromFields({ token: 'abc', note: 'hello', endpoint: 'https://crm.example/x' }))
      .toBe('https://crm.example')
    expect(siteOriginFromFields({ token: 'abc', note: 'hello' })).toBeNull()
    expect(siteOriginFromFields(undefined)).toBeNull()
  })

  it('is independent of object key order (stable binding)', () => {
    const a = siteOriginFromFields({ zzz: 'https://b.example', aaa: 'https://a.example' })
    const b = siteOriginFromFields({ aaa: 'https://a.example', zzz: 'https://b.example' })
    expect(a).toBe(b)
    expect(a).toBe('https://a.example')
  })

  it('recognizes camelCase address keys as well as snake_case', () => {
    expect(siteOriginFromFields({ serverUrl: 'app.glitchtip.com' })).toBe('https://app.glitchtip.com')
    expect(siteOriginFromFields({ apiEndpoint: 'glitchtip.corp.example' })).toBe('https://glitchtip.corp.example')
    expect(siteOriginFromFields({ plain: 'app.glitchtip.com' })).toBeNull()
  })

  it('normalizes a bare hostname only when the field name is address-shaped', () => {
    // The built-in GlitchTip template tells users to type `app.glitchtip.com`.
    expect(siteOriginFromFields({ GLITCHTIP_BASE_URL: 'app.glitchtip.com' })).toBe('https://app.glitchtip.com')
    // An unrelated field value without a scheme must not become an origin.
    expect(siteOriginFromFields({ note: 'app.glitchtip.com' })).toBeNull()
  })

  // 2026-09-16 R9 审计：关键词表放宽成裸子串后，非地址字段（`security` 里含
  // `uri`、`website`/`siteName` 里含 `site`）也参与竞争，且裸主机归一让它们的
  // 值变成 origin —— 一个口令形状的值就顶掉了连接器真正的站点。
  it('does not let a non-address key hijack the binding', () => {
    expect(siteOriginFromFields({ SECURITY_TOKEN: 'abc123def456', SITE_URL: 'https://real.example' }))
      .toBe('https://real.example')
    expect(siteOriginFromFields({ siteName: 'staging', URL: 'https://real.example' }))
      .toBe('https://real.example')
    expect(siteOriginFromFields({ website: 'staging', url: 'https://real.example' }))
      .toBe('https://real.example')
    expect(siteOriginFromFields({ note: 'staging', url: 'https://real.example' }))
      .toBe('https://real.example')
  })

  it('prefers the key that names the site over a camelCase flow URL', () => {
    // `callbackUrl` is the OAuth redirect, not the connector's own site.
    expect(siteOriginFromFields({ callbackUrl: 'https://sso.example/cb', url: 'https://app.example' }))
      .toBe('https://app.example')
  })

  it('prefers an explicit scheme over a scheme-less guess regardless of key order', () => {
    // base 只认带 scheme 的值；裸主机是新增能力，不得改写既有判定。
    expect(siteOriginFromFields({ host: 'staging', url: 'https://real.example' }))
      .toBe('https://real.example')
    expect(siteOriginFromFields({ hostname: 'staging', siteUrl: 'https://real.example' }))
      .toBe('https://real.example')
    // 没有任何显式地址时，地址形状键上的裸主机仍然生效（E1 的新能力）。
    expect(siteOriginFromFields({ username: 'alice', hostname: 'glitchtip.corp.example' }))
      .toBe('https://glitchtip.corp.example')
  })

  // 2026-09-16 R2 复核：把 `hostname` 并进 base 的地址键档、或把 `_` 放宽成 `[_-]`，
  // 会让两个 base 地址键之间的取舍翻转 —— 同一份凭据的绑定基准被静默换主机。
  it('keeps base’s choice between two address keys (no silent rebinding)', () => {
    expect(siteOriginFromFields({ hostname: 'https://a.example', url: 'https://b.example' }))
      .toBe('https://b.example')
    expect(siteOriginFromFields({ server_url: 'https://real.example', 'callback-url': 'https://sso.example/cb' }))
      .toBe('https://real.example')
    // 两个 base 地址键两两对拍（110 组）见 temp/audit-r9/my-probe/site-diff.mjs。
    expect(siteOriginFromFields({ SITE_URL: 'https://a.example', API_ENDPOINT: 'https://b.example' }))
      .toBe('https://b.example')
  })

  it('does not let a placeholder in an address key beat a real URL elsewhere', () => {
    // 2026-09-16 R3 审计：`n/a`/`changeme`/`TODO`/`-` 都能被裸主机归一成
    // `http://n` 这类 origin，早期实现让它压过真站点，拒绝文案还会把该主机
    // 当成指令告诉模型。单标签猜测必须排在显式地址之后。
    expect(siteOriginFromFields({ api_url: 'n/a', homepage: 'https://real.example' }))
      .toBe('https://real.example')
    expect(siteOriginFromFields({ server_url: 'changeme', docs: 'https://real.example' }))
      .toBe('https://real.example')
    expect(siteOriginFromFields({ address: 'TODO', note: 'https://real.example' }))
      .toBe('https://real.example')
    // 明确像主机的裸值（含点 / IP / 私网）仍然赢过无关键上的 URL。
    expect(siteOriginFromFields({ server_url: 'glitchtip.corp.example', docs: 'https://real.example' }))
      .toBe('https://glitchtip.corp.example')
    expect(siteOriginFromFields({ server_url: '10.0.0.5:8000', docs: 'https://real.example' }))
      .toBe('http://10.0.0.5:8000')
    // 没有别的候选时，单标签内网值仍可用（E1 能力）。
    expect(siteOriginFromFields({ server_url: 'glitchtip:8000' })).toBe('http://glitchtip:8000')
  })

  it('recognizes env-style HOSTNAME and camelCase hostName keys', () => {
    expect(siteOriginFromFields({ HOSTNAME: 'glitchtip.corp.example' })).toBe('https://glitchtip.corp.example')
    expect(siteOriginFromFields({ hostName: 'glitchtip.corp.example' })).toBe('https://glitchtip.corp.example')
    // 词边界仍然成立：非地址键的单键形态不得凭空造出 origin。
    expect(siteOriginFromFields({ SECURITY_TOKEN: 'abc123def456' })).toBeNull()
    expect(siteOriginFromFields({ siteName: 'staging' })).toBeNull()
    expect(siteOriginFromFields({ website: 'staging' })).toBeNull()
  })

  // 2026-09-16 R4 复核：`bareHostOrigin` 会把纯数字当成整数 IPv4
  // （`134744072` → `8.8.8.8`）、也会接受尾点/一位 TLD/带路径的单标签，
  // 这些"文字上不像主机"的值不得进入绑定基准（实测曾落到公网 IPv4 字面量）。
  it('rejects values whose TEXT is not a host (numeric IPv4 coercion, placeholders)', () => {
    expect(siteOriginFromFields({ host: '134744072', homepage: 'https://real.example' }))
      .toBe('https://real.example')
    expect(siteOriginFromFields({ host: '134744072' })).toBeNull()
    expect(siteOriginFromFields({ server_url: '3232235777', docs: 'https://real.example' }))
      .toBe('https://real.example')
    expect(siteOriginFromFields({ server_url: 'changeme.', docs: 'https://real.example' }))
      .toBe('https://real.example')
    expect(siteOriginFromFields({ server_url: 'n.a', docs: 'https://real.example' }))
      .toBe('https://real.example')
    expect(siteOriginFromFields({ server_url: 'example.com', docs: 'https://real.example' }))
      .toBe('https://real.example')
    // solo 形态同样不得凭空造出 origin（base 也是 null）。
    expect(siteOriginFromFields({ server_url: 'n/a' })).toBeNull()
    expect(siteOriginFromFields({ server_url: '-' })).toBeNull()
    expect(siteOriginFromFields({ server_url: 'changeme' })).toBeNull()
    expect(siteOriginFromFields({ server_url: 'TODO' })).toBeNull()
  })

  // 2026-09-16 R5 复核：前导零的 IPv4 会被 WHATWG 按八进制重读（`010.0.0.1` →
  // `8.0.0.1`），带点占位符与保留示例域则整个绕过"单标签否表"。
  it('rejects normalized-away IPv4 spellings, reserved domains and dotted placeholders', () => {
    const real = 'https://real.example'
    for (const value of [
      '010.0.0.1', '01.2.3.4', '1.02.3.4', '127.000.000.001', '0177.0.0.1',
      'placeholder.com', 'your-domain.com', 'changeme.example', 'secret.com', 'host.com', 'todo.com',
      'example.com', 'www.example.org', '0.0.0.0',
      // A trailing dot is stripped by the gate but kept by the normalizer, so the
      // derived origin could never equal a page origin — refuse it instead.
      'glitchtip.corp.example.',
    ]) {
      expect(siteOriginFromFields({ server_url: value, homepage: real }), value).toBe(real)
    }
    expect(siteOriginFromFields({ server_url: 'tools.example' })).toBe('https://tools.example')
    expect(siteOriginFromFields({ server_url: '例子.中国' })).toBe('https://xn--fsqu00a.xn--fiqs8s')
  })

  it('prefers the base address key’s typed host over a camelCase flow URL', () => {
    // base 地址键上的裸主机（第 2 遍）优先于扩展拼法键上的显式 URL（第 4 遍）：
    // `callbackUrl` 是 OAuth 回调，不是连接器站点（R4 复核）。
    expect(siteOriginFromFields({ base_url: 'glitchtip.corp.example', callbackUrl: 'https://sso.example/cb' }))
      .toBe('https://glitchtip.corp.example')
    // 但同一形态里"显式 vs 显式"必须与 base 一致：裸单标签不做承诺，显式 URL 赢。
    expect(siteOriginFromFields({ url: 'staging', HOSTNAME: 'https://real.example' }))
      .toBe('https://real.example')
  })

  it('does not let a URL under an unrelated key beat the address key’s bare host', () => {
    // DSN / 文档链接这类字段里带 URL，但它们不是连接器的站点。
    expect(siteOriginFromFields({ base_url: 'glitchtip.corp.example', sentry_dsn: 'https://abc123@9f1.sentry.io/1' }))
      .toBe('https://glitchtip.corp.example')
    expect(siteOriginFromFields({ host: 'glitchtip.corp.example', docs: 'https://docs.example/start' }))
      .toBe('https://glitchtip.corp.example')
  })
})

describe('credentialSiteOrigin', () => {
  it('lets the deployment declaration win over the stored fields', () => {
    expect(credentialSiteOrigin({ baseUrl: 'https://from-field.example' }, 'https://declared.example/login'))
      .toBe('https://declared.example')
  })

  it('falls back to the credential fields when the declaration is missing or unusable', () => {
    expect(credentialSiteOrigin({ baseUrl: 'https://from-field.example' }, undefined)).toBe('https://from-field.example')
    expect(credentialSiteOrigin({ baseUrl: 'https://from-field.example' }, 'not-a-url')).toBe('https://from-field.example')
    // A dotted bare host is a usable declaration; a single-label one is not
    // (typo guard: fall through to the credential fields).
    expect(credentialSiteOrigin(undefined, 'glitchtip.corp.example')).toBe('https://glitchtip.corp.example')
    expect(credentialSiteOrigin(undefined, 'glitchtip')).toBeNull()
  })

  it('returns null when nothing can be bound (the tool then refuses)', () => {
    expect(credentialSiteOrigin({ username: 'alice', password: 'x' }, undefined)).toBeNull()
    expect(credentialSiteOrigin(undefined, undefined)).toBeNull()
  })
})

describe('createCredentialResolver: originOf 接线', () => {
  async function seed(id: string, fields: Record<string, string>): Promise<void> {
    await new ConnectorStore({ username: 'user-a' }).writeCredential(id, { updatedAt: Date.now(), fields })
  }

  it('derives the origin from the stored credential of the CURRENT user', async () => {
    await seed('corp', { username: 'alice', password: 'secret', baseUrl: 'https://corp.example/login' })
    const resolver = createCredentialResolver({ currentUser: () => 'user-a' })!
    expect(await resolver.originOf!('corp')).toBe('https://corp.example')
    // Another user's store is a different directory: no credential ⇒ no binding.
    const other = createCredentialResolver({ currentUser: () => 'user-b' })!
    expect(await other.originOf!('corp')).toBeNull()
  })

  it('honours the credentialSites config for connectors without an address field', async () => {
    await seed('corp', { username: 'alice', password: 'secret' })
    const resolver = createCredentialResolver({
      currentUser: () => 'user-a',
      credentialSites: { corp: 'https://intranet.example/sso' },
    })!
    expect(await resolver.originOf!('corp')).toBe('https://intranet.example')
  })

  it('returns null for an unknown connector and never leaks the secret fields', async () => {
    await seed('corp', { username: 'alice', password: 'secret' })
    const resolver = createCredentialResolver({ currentUser: () => 'user-a' })!
    expect(await resolver.originOf!('missing')).toBeNull()
    expect(JSON.stringify(await resolver.originOf!('corp'))).not.toContain('secret')
  })
})
