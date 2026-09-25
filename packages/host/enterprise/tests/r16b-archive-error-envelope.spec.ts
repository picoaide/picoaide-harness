/**
 * R16B-08 回归判据（2026-09-25，第十六轮审计泳道 B，P2）。
 *
 * ## 缺陷
 *
 * `archiveUpstreamError`（auth-gate 的**二进制/归档**代理失败分支）把上游信封
 * **解析出来之后又丢掉**：只有 `PASSWORD_CHANGE_REQUIRED` 那一支用到了
 * `message`，其余一律 `json(res, upstream.status, { error: 'gateway error' })`。
 * 于是能力中心 6 条归档路径（内置技能安装 / 市场技能安装 / 市场技能下载 /
 * 智能体预设安装 / 智能体预设下载 / 共享技能安装）的失败只剩面板上那句
 * 「操作失败:gateway error」—— 状态码、稳定码、服务端原文全部消失，
 * 用户与支持都无法区分"令牌过期 / 没有权限 / 版本不存在 / 服务端 500"。
 *
 * 修 R15B-02 时它被当成"行为不变"，而既有回归的**对照用例用的是非 JSON body**
 * （`new Response('boom', {status:500})`）⇒ 有效信封这条分支从来没有判据。
 *
 * ## 现在的契约
 *
 *  - 有信封（`{error:{code,message}}`）⇒ **逐字透传**：状态码 + `error` 放服务端
 *    原文（渲染层 `CapabilityCenterPanel` 读的就是这个字符串字段）+ `code` 单列；
 *  - `PASSWORD_CHANGE_REQUIRED` ⇒ 走 `passwordChangeRequired`（403 + 稳定码 +
 *    action + hint，行为不变）；
 *  - 非 JSON / 空 body / 没有 `message` ⇒ 退回 `{error:'gateway error'}`（原行为）。
 *
 * 六条路径**逐个**跑同一份断言：这一条 helper 是共用出口，但"共用"本身没有判据
 * （将来有人复制一份内联的失败分支就会漏），所以判据钉在**每条真实路由的应答**上。
 *
 * ---- 变异验证（实跑过，逐条单独一次调用）----
 *   - 把成功透传那一支改回 `json(res, upstream.status, { error: 'gateway error' })`
 *     ⇒ 六条 `it.each` 全红；
 *   - 透传时只带 `error` 不带 `code` ⇒ 六条的 `code` 断言红；
 *   - 非 JSON 分支也去读 `envelope.error`（不去判 JSON 解析失败）⇒「非 JSON 仍回落」
 *     那条红。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, type Config } from '../src/auth-gate.ts'
import { PASSWORD_CHANGE_REQUIRED_CODE } from '../src/server-connector/auth.ts'
import type { Session } from '../src/server-connector/config.ts'

const ALICE: Session = { serverURL: 'https://harness.example', username: 'alice', token: 'ALICE-TOKEN', role: 'employee' }

interface Route {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void
}

function fakeReq(url: string, method: string): IncomingMessage {
  const host = '127.0.0.1:3080'
  return {
    method,
    url,
    headers: {
      origin: `http://${host}`,
      host,
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
      cookie: `dsh-auth-${host}=v1.signature`,
    },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { /* POST 的 body 由路由自行读取；这些路径在失败前不需要它 */ },
    on() { return this },
    once() { return this },
    removeListener() { return this },
  } as unknown as IncomingMessage
}

/** 六条归档路径（本地路由 + 方法）。枚举自 `archiveUpstreamError` 的 6 个调用点。 */
const ARCHIVE_ROUTES: Array<{ name: string, prefix: string, url: string, method: string }> = [
  { name: '内置技能安装', prefix: '/api/pico/skills', url: '/api/pico/skills/builtin/codeql/install', method: 'POST' },
  { name: '市场技能安装', prefix: '/api/pico/skills', url: '/api/pico/skills/codeql/install', method: 'POST' },
  { name: '市场技能下载', prefix: '/api/pico/skills', url: '/api/pico/skills/codeql/archive', method: 'GET' },
  { name: '智能体预设安装', prefix: '/api/pico/agent-presets', url: '/api/pico/agent-presets/reviewer/install', method: 'POST' },
  { name: '智能体预设下载', prefix: '/api/pico/agent-presets', url: '/api/pico/agent-presets/reviewer/archive', method: 'GET' },
  { name: '共享技能安装', prefix: '/api/pico/shared-skills', url: '/api/pico/shared-skills/codeql/1.0.0/install', method: 'POST' },
]

interface Harness {
  call: (prefix: string, url: string, method: string) => Promise<{ code: number, body: any }>
}

function harness(): Harness {
  const routes: Route[] = []
  const current: Session = { ...ALICE }
  const ctx = {
    effect: (fn: () => unknown) => { fn() },
    get: (name: string) => (name === 'connection' ? { requestRejection: () => undefined } : undefined),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    picoSession: {
      isRestored: () => true,
      isLoggedIn: () => true,
      getSession: () => current,
      setSession: vi.fn(),
      clear: vi.fn(),
    },
    webServer: {
      tapIndex: () => () => {},
      register: (route: Route) => { routes.push(route); return () => {} },
    },
  }
  apply(ctx as never, {} as Config)
  return {
    call: async (prefix, url, method) => {
      const handler = routes.find(r => r.kind === 'prefix' && r.path === prefix)?.handler
      if (handler === undefined) throw new Error(`route not registered: prefix ${prefix}`)
      let code = 0
      let body: unknown
      const res = {
        writeHead: (value: number) => { code = value },
        end: (chunk?: string | Buffer) => { body = chunk === undefined ? undefined : JSON.parse(chunk.toString()) },
      } as unknown as ServerResponse
      await handler(fakeReq(url, method), res)
      return { code, body }
    },
  }
}

/** 上游的业务错误信封（服务端 `serverauth.WriteError` 的形状）。 */
const NOT_FOUND = (): Response => new Response(
  JSON.stringify({ error: { code: 'NOT_FOUND', message: '指定的技能不存在' } }),
  { status: 404, headers: { 'content-type': 'application/json' } },
)

let home: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'r16b8-archive-')); vi.stubEnv('DSH_HOME', home) })
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }) })

describe('R16B-08 归档代理不得吞掉上游的 code / message', () => {
  it.each(ARCHIVE_ROUTES)('$name：上游 404 信封逐字透传（状态 + 原文 + 稳定码）', async (route) => {
    vi.stubGlobal('fetch', vi.fn(async () => NOT_FOUND()))
    const h = harness()
    const res = await h.call(route.prefix, route.url, route.method)

    expect(res.code, '状态码被改写').toBe(404)
    expect(res.body, '失败被打回笼统的 gateway error，诊断信息被吞').toEqual({
      error: '指定的技能不存在',
      code: 'NOT_FOUND',
    })
  })

  it('强制改密码仍走同一条出口（403 + action + hint，不回归）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { code: PASSWORD_CHANGE_REQUIRED_CODE, message: '请先修改密码' } }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    )))
    const h = harness()
    const res = await h.call('/api/pico/skills', '/api/pico/skills/codeql/archive', 'GET')
    expect(res.code).toBe(403)
    expect(res.body.code).toBe(PASSWORD_CHANGE_REQUIRED_CODE)
    expect(res.body.action).toBe('change-password')
    expect(res.body.error).toBe('请先修改密码')
  })

  it('非 JSON body / 没有 message 的信封仍回落 gateway error（原行为不借机改口径）', async () => {
    const h = harness()
    // ① 网关 HTML 错误页（非 JSON）。
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })))
    expect(await h.call('/api/pico/skills', '/api/pico/skills/codeql/archive', 'GET'))
      .toEqual({ code: 500, body: { error: 'gateway error' } })

    // ② JSON 但没有可读 message（只有 code / 结构漂移）⇒ 没有东西可透传。
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { code: 'WEIRD' } }),
      { status: 418, headers: { 'content-type': 'application/json' } },
    )))
    expect(await h.call('/api/pico/skills', '/api/pico/skills/codeql/archive', 'GET'))
      .toEqual({ code: 418, body: { error: 'gateway error' } })
  })
})
