/**
 * R7-RV-3 回归（第三轮对抗复核）：`/api/pico/connectors` 写面的持有性证明。
 *
 * 缺陷面：`packages/host/connectors/src/index.ts` 的 `/api/pico/connectors`
 * 前缀此前只有 `guard()`（同源标记 + 回环），而 `loopback.ts:60-64` 自述"伪造
 * Origin 的 curl 也能过"。实测副作用（不是复述实现）：
 *   - `POST /<id>/auth-submit` → 200，把攻击者 token 写进**本地连接器凭据库**
 *     （`glitchtip.json`），后续连接器出站带攻击者凭据；
 *   - `POST /<id>/approve` → 200，往 `.mcp-approvals.json` 写入持久化的
 *     「允许在本机执行 <command> <args>」审批（跨重启生效，绕过用户确认闸门）。
 *
 * 修法与 enterprise `auth-gate.ts` 的 r7c-6 同口径：非 GET 路由经
 * `connection.requestRejection()` 要 BrowserAuth cookie；fence 缺席 fail-closed
 * 503；`GET /<id>/state` 轮询维持 `guard()`。
 *
 * 本文件断言的是**真实副作用**（凭据是否落盘 / 审批台账是否被写）与状态码。
 */
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { browserFence, callRoute, callRouteForged, createHarness, seedCredential } from './helpers/connector-harness.ts'
import type { ConnectorDef } from '../src/types.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { while (cleanups.length > 0) await cleanups.pop()?.() })

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pico-rv3-'))
  cleanups.push(async () => { await rm(dir, { recursive: true, force: true }) })
  return dir
}

function tokenDef(): ConnectorDef {
  return {
    id: 'glitchtip',
    name: 'Glitchtip',
    description: 'ordinary token connector',
    authMode: 'token',
    tokenFields: [{ key: 'PROBE_TOKEN', label: 'Token', type: 'password', required: true }],
    settings: [],
    mcp: [{
      serverName: 'probe-server',
      transport: 'stdio',
      command: '/bin/echo',
      args: ['hello'],
      env: { BENIGN_KEY: 'yes' },
    }],
  } as unknown as ConnectorDef
}

/** 伪造进程能打到的每一条写面。 */
const WRITE_ROUTES = [
  '/api/pico/connectors/glitchtip/connect',
  '/api/pico/connectors/glitchtip/cancel',
  '/api/pico/connectors/glitchtip/auth-submit',
  '/api/pico/connectors/glitchtip/disconnect',
  '/api/pico/connectors/glitchtip/approve',
  '/api/pico/connectors/glitchtip/deny',
]

describe('R7-RV-3 connectors:本地写路由要求持有性证明', () => {
  it('a forged local process cannot write credentials or the execution approval ledger', async () => {
    const dir = await tempDir()
    await seedCredential(dir, 'glitchtip', { accessToken: 'SEEDED' })
    const h = createHarness([tokenDef()], dir, {})
    h.emitSession({ username: 'user-a' })
    // 等真实 pending 审批建立（无 requestApproval 钩子 ⇒ 走面板路径）。
    await new Promise((resolve) => setTimeout(resolve, 1200))

    // ① 凭据注入：auth-submit 之前是 200 且 token 落盘（复核实测），现在必须被拒。
    const submit = await callRouteForged(h, '/api/pico/connectors/glitchtip/auth-submit')
    expect(submit.status).toBe(403)
    expect(JSON.parse(submit.body).error).toBe('browser session proof required')
    // ② 持久化执行审批：approve 同样必须被拒，且台账未出现。
    const approve = await callRouteForged(h, '/api/pico/connectors/glitchtip/approve')
    expect(approve.status).toBe(403)
    // ③ 其余写面一并被拒（同族，不是只修报告点名的那一条）。
    for (const path of WRITE_ROUTES) {
      const out = await callRouteForged(h, path)
      expect(out.status, path).toBe(403)
      expect(JSON.parse(out.body).error, path).toBe('browser session proof required')
    }
    // ④ 围栏之外没有副作用：没有攻击者 token 落盘，也没有审批台账。
    const listing = await readdir(dir).catch(() => [] as string[])
    for (const file of listing) {
      const text = await readFile(join(dir, file), 'utf8').catch(() => '')
      expect(text.includes('ATTACKER-INJECTED-TOKEN'), file).toBe(false)
    }
    expect(existsSync(join(dir, '.mcp-approvals.json'))).toBe(false)
    // ⑤ 证明真的被问了（不是靠别的分支拒绝）。
    expect(h.fence.seen).toBeGreaterThanOrEqual(WRITE_ROUTES.length)
    // ⑥ MCP 服务器没有被注册（审批没通过 ⇒ 不 spawn）。
    expect(h.configs).toEqual([])
    h.dispose()
  })

  it('the real page (BrowserAuth cookie) still gets through — no friendly fire', async () => {
    const dir = await tempDir()
    const h = createHarness([tokenDef()], dir, {})
    h.emitSession({ username: 'user-a' })

    // 真页面：connect/auth-submit 必须照常走 handler（不是 403）。harness 的
    // 请求对象没有 body 流，auth-submit 因读不到 body 走到自己的 400 分支 ——
    // 关键是它**没有**撞上持有性证明（否则就是误伤真页面）。
    const connect = await callRoute(h, '/api/pico/connectors/glitchtip/connect')
    expect(connect.status).not.toBe(403)
    const submit = await callRoute(h, '/api/pico/connectors/glitchtip/auth-submit')
    expect(submit.status).not.toBe(403)
    expect(submit.body).not.toContain('browser session proof')
    // GET 读面（状态轮询）对两边都开放。
    const state = await callRoute(h, '/api/pico/connectors/glitchtip/state', 'GET')
    expect(state.status).toBe(200)
    h.dispose()
  })

  it('fails closed when the connection service is absent', async () => {
    const dir = await tempDir()
    const h = createHarness([tokenDef()], dir, { connectionFence: null })
    h.emitSession({ username: 'user-a' })
    const out = await callRoute(h, '/api/pico/connectors/glitchtip/connect')
    expect(out.status).toBe(503)
    expect(JSON.parse(out.body).error).toBe('browser session proof unavailable')
    h.dispose()
  })

  it('rejects non-POST method variants on the same routes (no method switch bypass)', async () => {
    const dir = await tempDir()
    const h = createHarness([tokenDef()], dir, {})
    h.emitSession({ username: 'user-a' })
    for (const method of ['PUT', 'PATCH', 'DELETE', 'HEAD', 'post', 'get']) {
      const out = await callRouteForged(h, '/api/pico/connectors/glitchtip/auth-submit', method)
      expect([403, 405], `${method} must not reach the handler`).toContain(out.status)
    }
    h.dispose()
  })
})

describe('R7-RV-3 connectors:等价伪造形态（同族绕过面）', () => {
  it.each([
    ['cookie 存在但来自别的 authority（别的端口签名）', 'dsh-auth-localhost:9999=v1.signature'],
    ['cookie 存在但是空值', ''],
    ['cookie 头存在但完全没有 dsh-auth 成员', 'session=abc; theme=dark'],
  ])('refuses auth-submit when %s', async (_label, cookie) => {
    const dir = await tempDir()
    const fence = browserFence()
    // 与真 BrowserAuth 同判据：只有本 authority 的那一枚签名 cookie 算证明。
    fence.requestRejection = (request: { headers: Record<string, unknown> }) =>
      request.headers['cookie'] === 'dsh-auth-localhost:43120=v1.signature' ? undefined : (401 as const)
    const h = createHarness([tokenDef()], dir, { connectionFence: fence })
    h.emitSession({ username: 'user-a' })

    // 伪造请求：同源头齐全（Origin/Host/Sec-Fetch-Site 都能造假），只差证明。
    const original = fence.requestRejection
    expect(original({ headers: { cookie } })).toBe(401)
    const forged = await callRouteForged(h, '/api/pico/connectors/glitchtip/auth-submit')
    expect(forged.status).toBe(403)
    h.dispose()
  })
})
