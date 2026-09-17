/**
 * 2026-09-17 S04-3 审计回归：行状态上的 `errorCode` 不得**粘住**。
 *
 * `setState` 是合并写（`{ ...current, ...patch }`），而分类字段是**状态**而不是
 * 一次性参数。旧实现只在错误**带** code 时才写这个字段，于是一条
 * `errorCode:'auth-required'` 会留到下一次失败上：后续失败若没有分类
 * （undici `TypeError: fetch failed`、出站策略之外的普通异常……），行仍会带着
 * 旧分类发出。客户端 `client/friendly-error.ts:42` 按 code 优先 ⇒ 直接返回原始
 * 文本、跳过 `:59` 的本地化通用包装，把一次普通失败显示成"需要重新授权"。
 *
 * 这里必须**先让行进入 auth-required 再触发一次未分类失败**：只从干净状态
 * 起测的用例看不到粘性（旧字段本来就不存在）。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-mcp-client', () => ({ apply: () => {} }))

import { callRoute, createHarness } from './helpers/connector-harness.ts'
import type { ConnectorDef } from '../src/types.ts'

const realFetch = globalThis.fetch

afterEach(() => { globalThis.fetch = realFetch })

/** 连接器面板读的行状态（`...state` 的线上形状）。 */
interface Row {
  status?: string
  error?: string
  errorCode?: string
}

/** 轮询到行进入目标状态（连接流程在后台跑，面板走 2s 轮询模型）。 */
async function waitForRow(
  harness: ReturnType<typeof createHarness>,
  id: string,
  settle: (row: Row) => boolean,
): Promise<Row> {
  let row: Row = {}
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const res = await callRoute(harness, `/api/pico/connectors/${id}/state`, 'GET')
    row = JSON.parse(res.body) as Row
    if (settle(row)) return row
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return row
}

/** discovery 文档把授权端点指向链路本地地址 ⇒ 出站策略拒绝并落 `auth-required`。 */
function discoveryFetch(): typeof fetch {
  const json = (body: unknown): Response =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  return (async (input: unknown) => {
    const url = String(input)
    if (url === 'https://mcp.example/mcp') {
      return new Response('nope', {
        status: 401,
        headers: { 'www-authenticate': 'Bearer resource_metadata="https://mcp.example/.well-known/oauth-protected-resource"' },
      })
    }
    if (url === 'https://mcp.example/.well-known/oauth-protected-resource') {
      return json({ resource: 'https://mcp.example/mcp', authorization_servers: ['https://as.example'] })
    }
    if (url.startsWith('https://as.example/.well-known/oauth-authorization-server')) {
      return json({
        issuer: 'https://as.example',
        authorization_endpoint: 'https://169.254.169.254/authorize',
        token_endpoint: 'https://169.254.169.254/token',
      })
    }
    throw new Error(`unexpected fetch ${url}`)
  }) as typeof fetch
}

/** 每个 harness 都用一份全新的定义对象（插件会按 def 建立自己的状态）。 */
function stickyDef(): ConnectorDef {
  return {
    id: 'sticky-mcp',
    name: 'Sticky MCP',
    description: 'x',
    authMode: 'oauth',
    auth: {
      authorizeUrl: '',
      tokenUrl: '',
      clientId: 'static-client',
      redirectUri: 'http://127.0.0.1/callback',
      pkce: true,
      publicClient: true,
      discoveryUrl: 'https://mcp.example/mcp',
    },
    mcp: [{ serverName: 'sticky-mcp', transport: 'streamable-http', url: 'https://mcp.example/mcp' }],
  } as unknown as ConnectorDef
}

/** 驱动行进入"分类正确的授权失败"（现实中留下 `auth-required` 的那一步）。 */
async function authRequiredRow(def = stickyDef()): Promise<{ harness: ReturnType<typeof createHarness>, row: Row }> {
  globalThis.fetch = discoveryFetch()
  const dir = mkdtempSync(join(tmpdir(), 's04-3-sticky-'))
  const harness = createHarness([def], dir)
  await callRoute(harness, '/api/pico/connectors/sticky-mcp/connect', 'POST')
  const row = await waitForRow(harness, 'sticky-mcp', candidate => candidate.status === 'unauthorized')
  return { harness, row }
}

it('a later uncoded failure clears the row\u2019s stale `auth-required`', async () => {
  const { harness, row: classified } = await authRequiredRow()
  expect(classified.errorCode).toBe('auth-required')

  // 同一条行、同一次会话，失败换成没有分类的普通网络错误。
  globalThis.fetch = (async (input: unknown) => {
    throw new TypeError(`fetch failed: ${String(input)}`)
  }) as typeof fetch
  await callRoute(harness, '/api/pico/connectors/sticky-mcp/connect', 'POST')
  const uncoded = await waitForRow(harness, 'sticky-mcp', candidate => candidate.status === 'error')
  harness.dispose()

  expect(String(uncoded.error)).toContain('fetch failed')
  // 关键断言：旧分类不得跟着新错误一起发出去（否则客户端跳过本地化兜底）。
  expect(uncoded.errorCode).toBeUndefined()
}, 20_000)

it('disconnect clears the row\u2019s stale `auth-required`', async () => {
  const { harness, row: classified } = await authRequiredRow()
  expect(classified.errorCode).toBe('auth-required')

  await callRoute(harness, '/api/pico/connectors/sticky-mcp/disconnect', 'POST')
  const cleared = await waitForRow(harness, 'sticky-mcp', candidate => candidate.status === 'disconnected')
  harness.dispose()

  // 断开是"错误被清空"的路径：错误没了，分类也必须一起没（粘住会让下一次
  // 未分类失败继续按 auth-required 渲染）。
  expect(cleared.error).toBeUndefined()
  expect(cleared.errorCode).toBeUndefined()
}, 20_000)

it('a refused registration clears the row\u2019s stale `auth-required`', async () => {
  const def = stickyDef()
  const { harness, row: classified } = await authRequiredRow(def)
  expect(classified.errorCode).toBe('auth-required')

  // 第二段：MCP 探测报告"公开可用"，流程因此走到注册；注册被策略拒绝
  // （stdio 定义缺 command）—— 这是**换了一条新错误消息、且没有分类**的路径，
  // 与连接异常那条（经 withCode）是同一个字段的第二种粘法。
  def.mcp = [{ serverName: 'sticky-mcp', transport: 'stdio' }] as unknown as ConnectorDef['mcp']
  globalThis.fetch = (async () => new Response('ok', { status: 200 })) as typeof fetch
  await callRoute(harness, '/api/pico/connectors/sticky-mcp/connect', 'POST')
  const refused = await waitForRow(harness, 'sticky-mcp', candidate => candidate.status === 'error')
  harness.dispose()

  expect(String(refused.error)).toContain('sticky-mcp')
  expect(refused.errorCode).toBeUndefined()
}, 20_000)

it('entering `connecting` clears the previous error and its code', async () => {
  // 2026-09-17 S04-3 复核 P4：这是"写 state 的 setState"里唯一漏掉清除的一处。
  // 客户端对**任何非 connected 状态**都渲染 error 段落，所以新一轮连接中留着
  // 上一次的失败文案就是"看起来还在报同一个错"。
  const { harness, row: failed } = await authRequiredRow()
  expect(failed.errorCode).toBe('auth-required')
  // 先确认行上真的留着旧文案（没有待清掉的旧值就测不出残留）。
  expect(String(failed.error ?? '')).not.toBe('')

  // 第二次连接：discovery 请求被闸门挂住 ⇒ 行停在 connecting，可断言清除结果。
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  globalThis.fetch = (async () => { await gate; throw new TypeError('fetch failed') }) as typeof fetch
  await callRoute(harness, '/api/pico/connectors/sticky-mcp/connect', 'POST')
  const connecting = await waitForRow(harness, 'sticky-mcp', candidate => candidate.status === 'connecting')

  // 关键断言：连接中既不得显示上一条失败，也不得带着它的分类（两者同进同退）。
  expect(connecting.error).toBeUndefined()
  expect(connecting.errorCode).toBeUndefined()

  release()
  await new Promise(resolve => setTimeout(resolve, 50))
  harness.dispose()
}, 20_000)

