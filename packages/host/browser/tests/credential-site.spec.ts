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

import { credentialSiteOrigin, httpOriginOf, siteOriginFromFields } from '../src/credential-site.ts'
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
})

describe('credentialSiteOrigin', () => {
  it('lets the deployment declaration win over the stored fields', () => {
    expect(credentialSiteOrigin({ baseUrl: 'https://from-field.example' }, 'https://declared.example/login'))
      .toBe('https://declared.example')
  })

  it('falls back to the credential fields when the declaration is missing or unusable', () => {
    expect(credentialSiteOrigin({ baseUrl: 'https://from-field.example' }, undefined)).toBe('https://from-field.example')
    expect(credentialSiteOrigin({ baseUrl: 'https://from-field.example' }, 'not-a-url')).toBe('https://from-field.example')
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
