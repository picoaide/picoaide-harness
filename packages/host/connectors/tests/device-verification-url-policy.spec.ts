/**
 * conn-4 (audit R7, P2 — the URL half): `runDevice` emitted
 * `auth.verificationUrl` verbatim. It is a definition-supplied URL (the
 * server-issued connector catalog carries it), it was the ONLY
 * definition-controlled URL in this package that never went through
 * `assertOutboundUrlAllowed`, and the client renders it as a clickable
 * `<a href>` (`src/client/ConnectorsSection.tsx`) — measured with
 * `javascript:alert(document.domain)//`.
 *
 * `authorizeUrl` (the sibling flow step) has always been checked. The device
 * verification address now is too, and a refused address fails the connect
 * loudly instead of reaching the panel.
 *
 * The "device probe returns true immediately" half of the finding is a written
 * product decision (2026-08-25: the CLI connector was removed, the device flow
 * is a stateless probe) and is deliberately NOT changed here.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-mcp-client', () => ({ apply: () => {} }))

import { runAuth } from '../src/auth.ts'
import type { ConnectorAuthRequest, ConnectorDef } from '../src/types.ts'
import { createHarness } from './helpers/connector-harness.ts'

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

function deviceDef(verificationUrl: string): ConnectorDef {
  return {
    id: 'dev',
    name: 'dev',
    description: 'device connector',
    authMode: 'device',
    auth: { verificationUrl, pollIntervalMs: 5, pollTimeoutMs: 1_000 },
    mcp: [{ serverName: 'dev-server', transport: 'stdio', command: 'node', args: [] }],
  }
}

async function runDeviceFlow(verificationUrl: string): Promise<{ outcome: string; requests: ConnectorAuthRequest[] }> {
  const requests: ConnectorAuthRequest[] = []
  const controller = new AbortController()
  try {
    await runAuth(deviceDef(verificationUrl), { onRequest: request => requests.push(request), signal: controller.signal })
    return { outcome: 'resolved', requests }
  } catch (error) {
    return { outcome: error instanceof Error ? error.message : String(error), requests }
  }
}

describe('conn-4: the device verification address passes the outbound URL policy', () => {
  it('refuses javascript: before it can reach the panel <a href>', async () => {
    const { outcome, requests } = await runDeviceFlow('javascript:alert(document.domain)//')
    console.log(`[conn-4] javascript: outcome = ${outcome}`)
    console.log(`[conn-4] requests = ${JSON.stringify(requests)}`)
    expect(outcome).toMatch(/设备授权验证地址/)
    expect(requests).toEqual([])
  })

  it('refuses data: and metadata addresses too', async () => {
    for (const url of ['data:text/html,<script>alert(1)</script>', 'http://169.254.169.254/latest/meta-data']) {
      const { outcome } = await runDeviceFlow(url)
      console.log(`[conn-4] ${url.slice(0, 24)} => ${outcome}`)
      expect(outcome).toMatch(/设备授权验证地址/)
    }
  })

  it('still accepts the plausible https / loopback-http verification pages', async () => {
    for (const url of ['https://idp.example/device', 'http://127.0.0.1:4711/device']) {
      const { outcome, requests } = await runDeviceFlow(url)
      console.log(`[conn-4] ${url} => ${outcome} / ${JSON.stringify(requests)}`)
      expect(outcome).toBe('resolved')
      expect(requests[0]?.verificationUrl).toBe(url)
    }
  })
})

describe('conn-4: a refused verification address fails the connect instead of connecting', () => {
  it('leaves the row unauthorized, registers no MCP server and discloses no URL', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pico-conn4-'))
    cleanups.push(async () => { await rm(dir, { recursive: true, force: true }) })
    const harness = createHarness([deviceDef('javascript:alert(document.domain)//')], dir, {
      requestApproval: () => true,
    })
    // 不做会话切换：harness 默认已报 user-a，且传了 storeBaseDir 时 store 恒定
    // 指向 dir（reconfigureUser 不会改它），emitSession 只是排队一次 teardownAll。
    // 用例紧接着同步发起 connect，那次 connect 属于「切换前的旧会话」，会被
    // BUG-02 的意图令牌正确地作废 —— 测到的就不是 verification URL 策略了。

    const response = await new Promise<string>(resolve => {
      let body = ''
      const res = { writeHead: () => {}, end: (text: string) => { body = text } }
      const req = {
        method: 'POST',
        url: '/api/pico/connectors/dev/connect',
        // R7-RV-3：写面要 BrowserAuth 持有性证明 —— 真页面（ConnectorsSection）恒持有。
        headers: { host: 'localhost:43120', origin: 'http://localhost:43120', cookie: 'dsh-auth-localhost:43120=v1.signature' },
        socket: { remoteAddress: '127.0.0.1' },
      }
      const route = harness.routes.find(candidate => candidate.kind === 'prefix')!
      void Promise.resolve(route.handler(req as never, res as never)).then(() => resolve(body))
    })
    expect(response).toContain('ok')

    // Give the background flow time to settle (it fails before any polling).
    await new Promise(resolve => setTimeout(resolve, 300))
    const state = await new Promise<Record<string, unknown>>(resolve => {
      let body = ''
      const res = { writeHead: () => {}, end: (text: string) => { body = text } }
      const req = {
        method: 'GET',
        url: '/api/pico/connectors/dev/state',
        // R7-RV-3：写面要 BrowserAuth 持有性证明 —— 真页面（ConnectorsSection）恒持有。
        headers: { host: 'localhost:43120', origin: 'http://localhost:43120', cookie: 'dsh-auth-localhost:43120=v1.signature' },
        socket: { remoteAddress: '127.0.0.1' },
      }
      const route = harness.routes.find(candidate => candidate.kind === 'prefix')!
      void Promise.resolve(route.handler(req as never, res as never)).then(() => {
        resolve(JSON.parse(body) as Record<string, unknown>)
      })
    })
    console.log(`[conn-4] state after connect = ${JSON.stringify(state)}`)
    console.log(`[conn-4] MCP registrations = ${harness.configs.length}`)
    expect(state.status).not.toBe('connected')
    expect(state.status).toBe('unauthorized')
    expect(harness.configs).toHaveLength(0)
    expect((state.request as { verificationUrl?: string } | null)?.verificationUrl).toBeUndefined()
    harness.dispose()
  }, 20_000)
})
