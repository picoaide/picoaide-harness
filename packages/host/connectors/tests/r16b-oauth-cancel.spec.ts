// @vitest-environment node
/**
 * 回归：OAuth 流的**「等用户回调」阶段**必须仍然可取消、可超时。
 *
 * 缺陷（R16B-02，第十六轮审计泳道 B，P1）——`src/auth.ts` 的 `runOAuth` 里三条
 * 收尾动作被搬到了 `await codePromise` **之前**：
 *
 * ```
 * options.onRequest({ connectorId: def.id, authorizeUrl: … })
 *   options.signal.removeEventListener('abort', onAbort)   // ← 等待阶段还没开始就摘了
 *   clearTimeout(flowTimer)                                // ← 5 分钟超时再也到不了
 *   callbackServer = null                                  // ← abortFlow/releaseFlow 从此够不着
 * code = await codePromise
 * ```
 *
 * 三条动作的**唯一正确归属**是同一个 `try/finally` 里的 `releaseFlow()`（R3B2-1
 * 的目标是"建流阶段抛出时也要收尾"，那由 finally 覆盖）。提前执行一次的后果：
 *
 * - `/cancel`（取消按钮）、`disconnect`、插件卸载 effect 三处 abort 的信号**无人监听**；
 * - `auth.flowTimeout` 的 5 分钟兜底成为死键 ⇒ 面板永远停在「连接中…」；
 * - 用户每放弃一次授权，就留下一个**仍在监听的 loopback 端口**（`/connect` 只清
 *   `pendingFlows` 里的旧条目，挡不住累积）。
 *
 * 判据是**真 socket**：真 `createServer` 回调端口 + 真 `runAuth`（静态端点形态，
 * 不需要发现/注册）。断言两件事：abort 后流在 1s 内结束、且回调端口**真的关了**；
 * 以及等待阶段的 5 分钟定时器**仍然武装**（用可注入的短预算证明，不是等 5 分钟）。
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { connect } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { runAuth } from '../src/auth.ts'
import type { ConnectorDef } from '../src/types.ts'

const servers: Server[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  }
})

/** 一个"授权服务器"（本用例只用它的地址拼 URL；静态端点形态不会真的调它）。 */
async function startAuthServer(): Promise<number> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  servers.push(server)
  return (server.address() as AddressInfo).port
}

/** 该端口上现在还有人 accept 吗（真 TCP 连接，不靠猜）。 */
async function portIsOpen(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' })
    const done = (value: boolean): void => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(value)
    }
    socket.once('connect', () => { done(true) })
    socket.once('error', () => { done(false) })
    setTimeout(() => { done(false) }, 500)
  })
}

/**
 * 静态端点形态的 OAuth 连接器：没有 `registrationEndpoint`、`clientId` 已给 ⇒
 * 建流阶段不做任何网络调用，`onRequest` 立刻到达，用例只测等待阶段。
 */
function oauthDef(authPort: number): ConnectorDef {
  return {
    id: 'probe-oauth',
    name: 'Probe OAuth',
    description: 'probe',
    authMode: 'oauth',
    auth: {
      authorizeUrl: `http://127.0.0.1:${String(authPort)}/authorize`,
      tokenUrl: `http://127.0.0.1:${String(authPort)}/token`,
      clientId: 'probe-client',
      pkce: true,
    },
    mcp: [{ transport: 'http', url: `http://127.0.0.1:${String(authPort)}/mcp` }],
  } as unknown as ConnectorDef
}

/** 从 authorizeUrl 的 `redirect_uri` 取本流自己 listen(0) 选中的回调端口。 */
function callbackPortOf(authorizeUrl: string): number {
  const redirect = new URL(authorizeUrl).searchParams.get('redirect_uri')
  if (redirect === null) throw new Error('the authorize URL carried no redirect_uri')
  return Number(new URL(redirect).port)
}

const sleep = async (ms: number): Promise<void> => { await new Promise<void>((resolve) => { setTimeout(resolve, ms) }) }

/** 启动一发流并等到"等待用户回调"阶段；返回 authorizeUrl 与回调端口。 */
async function startFlow(
  authPort: number,
  options: { signal: AbortSignal, flowTimeoutMs?: number },
): Promise<{ flow: Promise<unknown>, callbackPort: number }> {
  let authorizeUrl: string | null = null
  const flow = runAuth(oauthDef(authPort), {
    signal: options.signal,
    onRequest: (request) => { authorizeUrl = (request as { authorizeUrl?: string }).authorizeUrl ?? null },
    callbackHost: '127.0.0.1',
    outboundTimeoutMs: 2_000,
    ...(options.flowTimeoutMs === undefined ? {} : { flowTimeoutMs: options.flowTimeoutMs }),
  })
  for (let i = 0; i < 200 && authorizeUrl === null; i++) await sleep(25)
  expect(authorizeUrl, 'onRequest 未到达 ⇒ 前置条件不成立').not.toBeNull()
  const callbackPort = callbackPortOf(authorizeUrl!)
  expect(await portIsOpen(callbackPort), '回调端口在等待期间应当是开着的（前置条件）').toBe(true)
  return { flow, callbackPort }
}

describe('R16B-02：OAuth「等用户回调」阶段仍可取消、仍会超时', () => {
  it('abort 之后流在 1s 内结束，且回调端口已关闭', async () => {
    const authPort = await startAuthServer()
    const controller = new AbortController()
    const { flow, callbackPort } = await startFlow(authPort, { signal: controller.signal })

    // 用户点「停止」/ 关掉授权页 ⇒ abort。
    controller.abort(new Error('user cancelled'))

    const settled = await Promise.race([
      flow.then(() => 'resolved' as const, () => 'rejected' as const),
      sleep(1_000).then(() => 'timeout' as const),
    ])
    expect(settled, 'abort 之后 runAuth 仍未结束（abort 监听已被提前摘掉）').toBe('rejected')
    // 收尾是同步的（close() 之后端口立刻停止 accept），但仍给事件循环一个回合。
    await sleep(50)
    expect(await portIsOpen(callbackPort), 'abort 之后回调服务器仍在监听（句柄已被提前置 null）').toBe(false)
  }, 20_000)

  it('等待阶段的超时定时器仍然武装（到点即结束并关端口）', async () => {
    const authPort = await startAuthServer()
    const controller = new AbortController()
    // 5 分钟的真实预算在用例里不可等待 ⇒ 注入一个短预算，测的是"同一颗定时器
    // 在等待阶段还有没有主人"，不是这个数字本身。
    const { flow, callbackPort } = await startFlow(authPort, { signal: controller.signal, flowTimeoutMs: 150 })

    const outcome = await Promise.race([
      flow.then(
        () => ({ kind: 'resolved' as const, message: '' }),
        (cause: unknown) => ({ kind: 'rejected' as const, message: cause instanceof Error ? cause.message : String(cause) }),
      ),
      sleep(3_000).then(() => ({ kind: 'pending' as const, message: '' })),
    ])
    expect(outcome.kind, '等待阶段没有超时兜底（clearTimeout 被提前执行）⇒ 流永不结束').toBe('rejected')
    expect(outcome.message).toMatch(/超时|timed out/u)
    await sleep(50)
    expect(await portIsOpen(callbackPort), '超时结束之后回调服务器仍在监听').toBe(false)
  }, 20_000)
})
