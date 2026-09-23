import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as tar from 'tar'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, type Config } from '../src/auth-gate.ts'
import { writeProvenance } from '../src/skill-install.ts'
import type { Session } from '../src/server-connector/config.ts'

/**
 * r7c-6(P2)回归:本地**写**路由只过 `guard()`,没有持有性证明。
 *
 * 缺陷(`auth-gate.ts` 的四条 prefix 路由 —— `/api/pico/skills`、
 * `/api/pico/agent-presets`、`/api/pico/shared-skills`、`/api/pico/capabilities`):
 * `guard()` 自述的边界是"回环 socket + 回环 Host + 同源标记",**本机任意进程**
 * 伪造一个 `Origin` 就能通过。同一份伪造头(回环 socket + 回环 Host + 伪造
 * Origin、无 BrowserAuth cookie)打 `POST /api/pico/auth/login` 得到 403
 * "browser session proof required",打 `POST /api/pico/skills/<id>/install`
 * 却穿过围栏、以**用户令牌**出站到网关(也能把技能/预设落到本地技能根、
 * 把本地产物上传到组织共享库)。
 *
 * 修法:这四条路由的非 GET 分支与 login 同口径接上 `proofOfPossession(req, res,
 * 'required')` —— 本机伪造 Origin 的进程拿不出 `dsh-auth-*` cookie;产品内所有
 * 调用点(CapabilityCenterPanel 的 fetch)都来自本进程服务的页面,cookie 恒在。
 *
 * 本测试钉住两件事:(1) 无 proof 的伪造写请求一律 403 且不出站/不动盘;
 * (2) 带 proof(真页面 cookie)的同一批请求仍全部放行 —— 不误伤正常流程。
 */

/** 让 `guard()` 放行的最小伪造头(同源标记 + 回环地址 + 回环 Host)。
 *  `cookie` 缺省为 false = 本机进程伪造 Origin 但拿不出持有性证明。 */
function fakeReq(method: string, url: string, body?: string, withCookie = false): IncomingMessage {
  const chunks = body === undefined ? [] : [Buffer.from(body)]
  return {
    method,
    url,
    headers: {
      origin: 'http://127.0.0.1:3080',
      host: '127.0.0.1:3080',
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
      ...(withCookie ? { cookie: 'dsh-auth-127.0.0.1:3080=v1.signature' } : {}),
      ...(body === undefined ? {} : { 'content-length': String(Buffer.byteLength(body)) }),
    },
    socket: { remoteAddress: '127.0.0.1' },
    [Symbol.asyncIterator]: async function* () { for (const c of chunks) yield c },
  } as unknown as IncomingMessage
}

function fakeRes(): { res: ServerResponse, read: () => { code: number, body: any } } {
  let code = 0
  let body: unknown
  const res = {
    writeHead: (value: number) => { code = value },
    end: (chunk?: string | Buffer) => {
      body = chunk === undefined ? undefined : JSON.parse(chunk.toString())
    },
  } as unknown as ServerResponse
  return { res, read: () => ({ code, body }) }
}

interface Route {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void
}

/**
 * 上游 `connection.requestRejection()` 的行为替身(`rpc-host.ts:97-100`:
 * Host/Origin 围栏过了之后,只有持 HMAC 签名 cookie 的页面才算持有性证明)。
 * 无 cookie ⇒ 401(与真 BrowserAuth 一致),真页面 ⇒ undefined。
 */
function browserFence(): { seen: number, requestRejection: (r: { headers: Record<string, unknown> }) => 401 | undefined } {
  const fence = {
    seen: 0,
    requestRejection: (request: { headers: Record<string, unknown> }) => {
      fence.seen += 1
      return request.headers['cookie'] === undefined ? (401 as const) : undefined
    },
  }
  return fence
}

const SESSION: Session = {
  serverURL: 'https://harness.example',
  username: 'alice',
  token: 'USER-TOKEN-abc',
  role: 'employee',
}

/** SKILL.md 必须过硬编码的发布前预检(name/version/title/description/author/
 *  category/正文长度),否则 upload 在本地就被拦下、到不了网关 —— 那会让
 *  "带 proof 的正常请求仍放行" 变成假红。 */
const SKILL_MD = `---
name: codeql
title: CodeQL 示例技能
version: 1.0.0
description: 用于回归测试上传与安装路径的示例技能,描述长度足以通过发布前预检。
author: tester
category: security
---
本技能只用于自动化回归测试,不会真的执行任何静态分析任务;正文刻意写长以通过发布前
预检的正文长度下限要求,内容本身没有任何实际用途,仅用于验证上传与安装链路。
`

/** 与安装器期望一致的最小 tar.gz(SKILL.md 在归档根)。 */
async function skillArchive(name = 'codeql'): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'pico-write-proof-'))
  try {
    await writeFile(join(dir, 'SKILL.md'), SKILL_MD.replace('name: codeql', `name: ${name}`), 'utf8')
    const chunks: Buffer[] = []
    await new Promise<void>((resolve, reject) => {
      const stream = tar.c({ gzip: true, cwd: dir, portable: true }, ['.'])
      stream.on('data', (c: Buffer) => chunks.push(c))
      stream.on('error', reject)
      stream.on('end', () => resolve())
    })
    return Buffer.concat(chunks)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

interface Harness {
  handler: (path: string) => Route['handler']
  gateway: string[]
  auth: Array<string | undefined>
  fence: ReturnType<typeof browserFence>
}

/** 装一个 auth-gate,按 prefix 路由取 handler;fetch 全部拦截(网关不出网)。 */
function harness(session: Session | null, fence?: ReturnType<typeof browserFence>): Harness {
  const routes: Route[] = []
  const gateway: string[] = []
  const auth: Array<string | undefined> = []
  const ctx = {
    effect: (fn: () => unknown) => { fn() },
    get: (name: string) => (name === 'connection' ? fence : undefined),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    picoSession: {
      isRestored: () => true,
      isLoggedIn: () => session !== null,
      getSession: () => session,
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
    fence: fence ?? browserFence(),
    gateway,
    auth,
    handler: (path: string) => {
      const route = routes.find((r) => r.kind === 'prefix' && r.path === path)
        ?? routes.find((r) => r.kind === 'exact' && r.path === path)
      if (route === undefined) throw new Error(`no route ${path}`)
      return route.handler
    },
  }
}

/** 装一个"网关永远正常"的 fetch;归档请求返回可安装的 tar.gz,其余返回 JSON。 */
async function stubGateway(h: Harness): Promise<void> {
  const archive = await skillArchive()
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
    const href = String(url)
    h.gateway.push(href)
    h.auth.push(new Headers(init?.headers).get('authorization') ?? undefined)
    if (href.includes('/archive')) {
      return new Response(new Uint8Array(archive), {
        status: 200,
        headers: { 'content-type': 'application/gzip', 'x-skill-version': '1.0.0' },
      })
    }
    return new Response(JSON.stringify({ ok: true, skill: { name: 'codeql' }, preset: { name: 'preset-a' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }))
}

let home: string
let skillsDir: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'pico-write-proof-home-'))
  skillsDir = join(home, 'skills')
  await mkdir(join(skillsDir, 'codeql'), { recursive: true })
  await writeFile(join(skillsDir, 'codeql', 'SKILL.md'), SKILL_MD, 'utf8')
  // 溯源标记 = "这一份是能力中心装的"：卸载/覆盖不需要额外确认（审计 2026-09-23
  // A2/A3 的来源判定）。没有它的话卸载会被 409 LOCAL_CONTENT 拦下 —— 那条契约
  // 由 builtin-skills.spec.ts 的专项用例钉住，这里只测持有性证明这一层。
  await writeProvenance(join(skillsDir, 'codeql'), {
    appId: 'codeql', version: '1.0.0', channel: 'market', installedAt: new Date().toISOString(),
  })
  vi.stubEnv('DSH_HOME', home)
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await rm(home, { recursive: true, force: true })
})

/** 四条 prefix 路由上的写请求(与 r7c-6 的缺陷面一一对应)。 */
const WRITE_REQUESTS: Array<{ path: string, url: string, body?: string }> = [
  { path: '/api/pico/skills', url: '/api/pico/skills/evil-skill/install' },
  { path: '/api/pico/skills', url: '/api/pico/skills/codeql/uninstall' },
  { path: '/api/pico/shared-skills', url: '/api/pico/shared-skills/evil-skill/1.0.0/install' },
  { path: '/api/pico/shared-skills', url: '/api/pico/shared-skills/codeql/1.0.0/uninstall' },
  { path: '/api/pico/shared-skills', url: '/api/pico/shared-skills/upload', body: '{"name":"codeql"}' },
  { path: '/api/pico/agent-presets', url: '/api/pico/agent-presets/evil-preset/install' },
  { path: '/api/pico/agent-presets', url: '/api/pico/agent-presets/evil-preset/uninstall' },
  { path: '/api/pico/agent-presets', url: '/api/pico/agent-presets/upload', body: '{"name":"preset-a"}' },
  { path: '/api/pico/capabilities', url: '/api/pico/capabilities' },
]

describe('本地写路由的持有性证明(r7c-6)', () => {
  it('refuses forged local write requests that POST /auth/login already refuses', async () => {
    const h = harness(SESSION, browserFence())
    await stubGateway(h)

    // 差分基线:同一份伪造头打 login 是 403(既有行为)。
    const login = fakeRes()
    await h.handler('/api/pico/auth/login')(
      fakeReq('POST', '/api/pico/auth/login', '{"server":"https://harness.example","username":"x","password":"y"}'),
      login.res,
    )
    expect(login.read().code).toBe(403)
    expect(login.read().body.error).toBe('browser session proof required')

    // 改前:这些写请求全部穿过围栏 —— 出站/落盘都真的发生。
    for (const write of WRITE_REQUESTS) {
      const { res, read } = fakeRes()
      await h.handler(write.path)(fakeReq('POST', write.url, write.body), res)
      expect(read().code, `${write.url} must be refused without browser proof`).toBe(403)
      expect(read().body.error, write.url).toBe('browser session proof required')
    }

    // 围栏之外一个字节都没发生:没有以用户令牌出站,也没有动本地技能根。
    expect(h.gateway).toEqual([])
    await expect(stat(join(skillsDir, 'codeql', 'SKILL.md'))).resolves.toBeTruthy()
    expect(h.fence.seen).toBeGreaterThanOrEqual(WRITE_REQUESTS.length + 1)
  })

  it('lets the same requests through once the page holds the browser proof', async () => {
    const h = harness(SESSION, browserFence())
    await stubGateway(h)

    const post = async (path: string, url: string, body?: string): Promise<{ code: number, body: any }> => {
      const { res, read } = fakeRes()
      await h.handler(path)(fakeReq('POST', url, body, true), res)
      return read()
    }

    // ① 纯本地写(卸载):带 proof 就必须真的删盘。
    const uninstall = await post('/api/pico/skills', '/api/pico/skills/codeql/uninstall')
    expect(uninstall.code).toBe(200)
    await expect(stat(join(skillsDir, 'codeql'))).rejects.toThrow()

    // ② 出站下载 + 落盘(安装):带 proof 就必须真的装回来。
    const install = await post('/api/pico/skills', '/api/pico/skills/codeql/install')
    expect(install.code).toBe(200)
    await expect(stat(join(skillsDir, 'codeql', 'SKILL.md'))).resolves.toBeTruthy()
    expect(h.gateway).toContain('https://harness.example/api/client/v2/marketplace/skills/codeql/archive')
    expect(h.auth).toContain('Bearer USER-TOKEN-abc')

    // ③ 打包 + 以用户令牌上传到组织共享库。
    const upload = await post('/api/pico/shared-skills', '/api/pico/shared-skills/upload', '{"name":"codeql"}')
    expect(upload.code).toBe(200)
    expect(h.gateway).toContain('https://harness.example/api/client/v2/shared-skills')

    // ④ 读面(GET 目录)不受影响,照常服务。
    const catalog = fakeRes()
    await h.handler('/api/pico/capabilities')(
      fakeReq('GET', '/api/pico/capabilities?source=market', undefined, true), catalog.res)
    expect(catalog.read().code).toBe(200)
  })

  it('fails closed on writes when the connection service is absent (same level as login)', async () => {
    const h = harness(SESSION, undefined)
    await stubGateway(h)

    const { res, read } = fakeRes()
    await h.handler('/api/pico/skills')(
      fakeReq('POST', '/api/pico/skills/evil-skill/install'), res)
    expect(read().code).toBe(503)
    expect(read().body.error).toBe('browser session proof unavailable')
    expect(h.gateway).toEqual([])
  })
})
