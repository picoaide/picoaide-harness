/**
 * 2026-09-16 i18n：connectors 的 **Host 半边**文案回归。
 *
 * 被保护的不变量：
 *  1. Host 文案**每次构消息时**按 `desktopRuntime.locale` 解析（模块级/apply 期
 *     冻结即红——这是 `src/client/status-label.ts` 记录的那类根因，宿主侧同样
 *     存在）；
 *  2. 承载用户可见文案的产出面（连接器行错误、OAuth 回环回调页）真的跟随语言；
 *  3. 中文文案逐字节不变（翻译是加法）；
 *  4. `friendly-error` 的契约在翻译后**仍然生效**：Host 下发的稳定 code 一路
 *     传到面板，客户端据此选文案，而不是匹配已经可以被翻译的字串。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('@deepseek-ai/dsh-mcp-client', () => ({ apply: () => {} }))

import { runAuth } from '../src/auth.ts'
import { friendlyConnectorError } from '../src/client/friendly-error.ts'
import { setActiveLocale } from '../src/client/locales.ts'
import { hostLocaleOf, hostT, stepLabel } from '../src/host-copy.ts'
import { mcpServerProblem } from '../src/policy.ts'
import type { ConnectorDef } from '../src/types.ts'
import { callRoute, createHarness, type Harness } from './helpers/connector-harness.ts'

let dir: string
let harness: Harness | null = null

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pico-i18n-')) })

afterEach(() => {
  harness?.dispose()
  harness = null
  rmSync(dir, { recursive: true, force: true })
})

/** Connector whose only MCP server is refused by the outbound URL policy. */
function blockedDef(): ConnectorDef {
  return {
    id: 'blocked',
    name: 'Blocked',
    description: 'x',
    authMode: 'token',
    mcp: [{ serverName: 'blocked-srv', transport: 'streamable-http', url: 'http://169.254.169.254/mcp' }],
  }
}

/** Device connector whose verification page is refused by the outbound policy. */
function deviceDef(): ConnectorDef {
  return {
    id: 'dev',
    name: 'Dev',
    description: 'x',
    authMode: 'device',
    auth: { verificationUrl: 'javascript:alert(document.domain)//', pollIntervalMs: 5, pollTimeoutMs: 500 },
    mcp: [],
  }
}

async function rows(h: Harness): Promise<Array<Record<string, unknown>>> {
  const response = await callRoute(h, '/api/pico/connectors', 'GET')
  const body = JSON.parse(response.body) as { connectors?: Array<Record<string, unknown>> }
  return body.connectors ?? []
}

async function row(h: Harness, id: string): Promise<Record<string, unknown>> {
  const found = (await rows(h)).find(entry => entry.id === id)
  expect(found, `connector row ${id}`).toBeDefined()
  return found as Record<string, unknown>
}

/** Poll the connector row (the flow settles in the background) until it matches. */
async function waitForRow(
  h: Harness,
  id: string,
  predicate: (current: Record<string, unknown>) => boolean,
  timeoutMs = 15_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs
  let last: Record<string, unknown> = {}
  while (Date.now() < deadline) {
    last = await row(h, id)
    if (predicate(last)) return last
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`row ${id} never matched: ${JSON.stringify(last)}`)
}

describe('Host 文案按调用解析（模块级冻结即红）', () => {
  it('切语言后同一条连接器错误立刻换语言（真实 apply + 真实路由）', async () => {
    harness = createHarness([blockedDef()], dir)
    expect(harness.locale()).toBe('zh')

    // 第一次：中文（默认）
    await callRoute(harness, '/api/pico/connectors/blocked/connect')
    const chinese = await waitForRow(harness, 'blocked', current => current.error !== undefined)
    expect(chinese.status).toBe('error')
    expect(chinese.error).toBe('blocked-srv: url 不在允许的出站范围内: http://169.254.169.254/mcp')

    // 第二次：把运行时语言切成 en（真机语义 = 用户在设置里改语言，进程不重启）。
    // 冻结在模块级/apply 期的实现会在这里继续吐中文。
    harness.setLocale('en')
    await callRoute(harness, '/api/pico/connectors/blocked/connect')
    const english = await waitForRow(
      harness,
      'blocked',
      current => String(current.error).startsWith('blocked-srv: url is outside'),
    )
    expect(english.error).toBe('blocked-srv: url is outside the allowed outbound range: http://169.254.169.254/mcp')
  }, 20_000)

  it('生命周期/交互文案同样按调用解析（deny 路由的行错误）', async () => {
    harness = createHarness([blockedDef()], dir)
    await callRoute(harness, '/api/pico/connectors/blocked/deny')
    expect((await row(harness, 'blocked')).error).toBe('本地执行确认被拒绝，未启动本地命令')

    harness.setLocale('en')
    await callRoute(harness, '/api/pico/connectors/blocked/deny')
    expect((await row(harness, 'blocked')).error)
      .toBe('The local execution confirmation was refused; no local command was started')
  }, 20_000)

  it('hostLocaleOf 每次读探针（拿不到 desktopRuntime 时回落产品默认）', () => {
    const runtime: { locale?: unknown } = { locale: 'zh' }
    const ctx = { get: (name: string) => (name === 'desktopRuntime' ? runtime : undefined) }
    expect(hostLocaleOf(ctx)).toBe('zh')
    runtime.locale = 'en-US'
    expect(hostLocaleOf(ctx)).toBe('en')
    expect(hostLocaleOf({ get: () => undefined })).toBe('zh')
  })
})

describe('OAuth 回环回调页跟随语言（用户浏览器里真正看到的页面）', () => {
  function oauthDef(): ConnectorDef {
    return {
      id: 'cb',
      name: 'Callback',
      description: 'x',
      authMode: 'oauth',
      auth: {
        authorizeUrl: 'https://auth.example/authorize',
        tokenUrl: 'https://auth.example/token',
        clientId: 'fixed-client',
        redirectUri: '',
      },
      mcp: [],
    }
  }

  async function callbackPage(locale: 'zh' | 'en'): Promise<string> {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('http://127.0.0.1')) return originalFetch(input, init)
      if (url.includes('/token')) {
        return new Response(JSON.stringify({ access_token: 'at-1' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('{}', { status: 404 })
    }) as typeof fetch
    let page: Promise<string> | undefined
    try {
      await runAuth(oauthDef(), {
        locale,
        signal: new AbortController().signal,
        onRequest: (request) => {
          if (request.authorizeUrl === undefined) return
          const authorize = new URL(request.authorizeUrl)
          const redirect = authorize.searchParams.get('redirect_uri') ?? ''
          const state = authorize.searchParams.get('state') ?? ''
          if (redirect === '') return
          // The callback page is served by the flow's own loopback server; the
          // response is written before the flow's code promise settles, so the
          // body is readable once runAuth resolves.
          page = originalFetch(`${redirect}?code=c1&state=${encodeURIComponent(state)}`)
            .then(async response => await response.text())
        },
      })
    } finally {
      globalThis.fetch = originalFetch
    }
    return await (page ?? Promise.resolve(''))
  }

  it('en 渲染英文页，zh 渲染中文页', async () => {
    const english = await callbackPage('en')
    expect(english).toContain('Authorization complete. You can close this window.')
    expect(english).not.toMatch(/[\u4e00-\u9fff]/u)

    const chinese = await callbackPage('zh')
    // 中文页逐字节不变（翻译是加法）。
    expect(chinese).toBe('<html><body><p>授权完成，可以关闭此窗口。</p></body></html>')
  }, 30_000)
})

describe('中文文案逐字节不变 + 步骤标签映射', () => {
  it('翻译只加英文侧，zh 值与改造前逐字相同', () => {
    expect(hostT('zh', 'flow.authRequired')).toBe('需要先完成授权：当前凭据被服务端拒绝（点击「连接」重新授权）')
    expect(hostT('zh', 'auth.callbackPage')).toBe('<html><body><p>授权完成，可以关闭此窗口。</p></body></html>')
    expect(hostT('zh', 'policy.serverNameInvalid', { serverName: '"X"' })).toBe('serverName 不合规: "X"')
    expect(hostT('zh', 'outbound.blocked', { what: 'MCP 端点', target: 'a.example' }))
      .toBe('MCP 端点 指向内网/链路本地/元数据地址，已拒绝: a.example')
    // 逐字节核对两条把插值搬到参数里的模板（改造前是模板字符串字面量）。
    expect(hostT('zh', 'outbound.notHttps', { what: 'MCP 端点', target: 'javascript://x' }))
      .toBe('MCP 端点 只允许 https（或本地回环 http）: javascript://x')
    expect(hostT('zh', 'outbound.timeout', { what: 'OAuth token 端点', timeoutMs: '30000', host: 'a.example' }))
      .toBe('OAuth token 端点 出站请求超时（30000ms 内未完成），已中止: a.example')
  })

  it('步骤标签：zh 原样、en 映射已知标签、未知标签两种语言都原样透出', () => {
    expect(stepLabel('zh', 'MCP 端点')).toBe('MCP 端点')
    expect(stepLabel('en', 'MCP 端点')).toBe('MCP endpoint')
    expect(stepLabel('en', 'OAuth token 端点')).toBe('OAuth token endpoint')
    expect(stepLabel('en', 'MCP 端点 glitchtip')).toBe('MCP endpoint glitchtip')
    expect(stepLabel('zh', 'MCP 端点 glitchtip')).toBe('MCP 端点 glitchtip')
    // 本来就是英文的标签（以及测试用的 'probe'）在两种语言下都不变。
    expect(stepLabel('en', 'OAuth resource metadata')).toBe('OAuth resource metadata')
    expect(stepLabel('en', 'probe')).toBe('probe')
  })

  it('mcpServerProblem 的判定值按传入语言渲染，判定结果（null/非 null）不受语言影响', () => {
    const bad = { serverName: 'Bad Name', transport: 'stdio', command: 'x' }
    expect(mcpServerProblem(bad)).toBe('serverName 不合规: "Bad Name"')
    expect(mcpServerProblem(bad, { locale: 'en' })).toBe('invalid serverName: "Bad Name"')
    expect(mcpServerProblem({ serverName: 'ok', transport: 'stdio', command: 'x' })).toBeNull()
    expect(mcpServerProblem({ serverName: 'ok', transport: 'stdio', command: 'x' }, { locale: 'en' })).toBeNull()
  })
})

describe('耦合修复：Host 的稳定 code 一路传到面板，friendly 映射在两种语言下都生效', () => {
  it('授权类失败带 auth-required，英文界面下仍走「原样透出」而不是通用兜底', async () => {
    harness = createHarness([deviceDef()], dir)
    harness.setLocale('en')
    await callRoute(harness, '/api/pico/connectors/dev/connect')
    const current = await waitForRow(harness, 'dev', entry => entry.errorCode !== undefined)
    expect(current.status).toBe('unauthorized')
    expect(current.errorCode).toBe('auth-required')
    const english = String(current.error)
    expect(english).toContain('device authorization verification URL')
    // 客户端此时也是英文界面（真机上 ctx.locale 与 desktopRuntime.locale 同源）。
    setActiveLocale('en')
    // 关键断言：客户端解析出的文案就是 Host 的原文，没有被包进 "Connection failed: …"。
    expect(friendlyConnectorError(english, current.errorCode as 'auth-required')).toBe(english)
    // 没有 code 时同样的英文信息会退化成通用兜底——这正是修复前的行为，留作对照。
    expect(friendlyConnectorError(english)).toBe(`Connection failed: ${english}`)
    setActiveLocale('zh')
  }, 20_000)

  it('中文侧的 status/文案/code 同样保持（默认语言不回归）', async () => {
    harness = createHarness([deviceDef()], dir)
    await callRoute(harness, '/api/pico/connectors/dev/connect')
    const current = await waitForRow(harness, 'dev', entry => entry.errorCode !== undefined)
    expect(current.status).toBe('unauthorized')
    expect(current.errorCode).toBe('auth-required')
    expect(String(current.error)).toContain('设备授权验证地址')
  }, 20_000)
})
