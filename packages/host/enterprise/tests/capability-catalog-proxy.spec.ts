/**
 * 能力中心聚合代理的契约测试（2026-09-15，技能链路补齐）。
 *
 * 覆盖的是"员工上传 → 管理员审批 → 员工在面板上看到结果/安装"这条链路上**客户端侧**
 * 最容易静默出错的一段：`/api/pico/capabilities?source=local` 必须
 *   1. 向服务端请求 `?source=own`（不是 org —— org 只含 approved，本地行的状态徽章
 *      与拒因会恒空，2026-09-01 已修过一次）；
 *   2. 把服务端 own 行的 `status`/`reason` 按 (kind,name) 匹配到本地创作行
 *      （`uploadStatus`），面板据此渲染「审核中/已通过/已驳回 + 拒因」。
 * 另钉住市场面：`?source=market` 原样透传服务端载荷（含 source 徽章与 org 行）。
 *
 * 为什么必须在客户端侧再钉一遍：服务端链路（上传→审批→可见→可装→下架）已在
 * `server/internal/capabilities/skill_lifecycle_test.go` 端到端覆盖；但"服务端对了、
 * 客户端拿到却显示不出状态"是产品里真实出现过的形态，两层的断言不能互相替代。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, type Config } from '../src/auth-gate.ts'
import type { Session } from '../src/server-connector/config.ts'

const SKILL_MD = `---
name: codeql
title: CodeQL 示例技能
version: 1.0.0
description: 用于能力中心聚合代理回归测试的示例技能,描述长度足以通过发布前预检。
author: tester
category: security
---
本技能只用于自动化回归测试,不会执行任何静态分析任务;正文刻意写长以通过发布前预检的
正文长度下限要求,内容本身没有任何实际用途,仅用于验证聚合代理的状态匹配契约。
`

const SESSION: Session = {
  serverURL: 'https://harness.example',
  username: 'alice',
  token: 'USER-TOKEN-abc',
  role: 'employee',
}

interface Route {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void
}

function fakeReq(url: string, host = '127.0.0.1:3080'): IncomingMessage {
  return {
    method: 'GET',
    url,
    headers: {
      origin: `http://${host}`,
      host,
      'sec-fetch-site': 'same-origin',
      cookie: `dsh-auth-${host}=v1.signature`,
    },
    socket: { remoteAddress: '127.0.0.1' },
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

function browserFence(): { requestRejection: (r: { headers: Record<string, unknown> }) => 401 | undefined } {
  return {
    requestRejection: (request: { headers: Record<string, unknown> }) =>
      (request.headers['cookie'] === undefined ? (401 as const) : undefined),
  }
}

/** 装一个 auth-gate；fetch 全部拦截（网关不出网）并记录请求过的 URL。 */
function harness(session: Session | null): { gateway: string[], call: (url: string) => Promise<{ code: number, body: any }> } {
  const routes: Route[] = []
  const gateway: string[] = []
  const ctx = {
    effect: (fn: () => unknown) => { fn() },
    get: (name: string) => (name === 'connection' ? browserFence() : undefined),
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
  const handler = routes.find(r => r.kind === 'prefix' && r.path === '/api/pico/capabilities')?.handler
  if (handler === undefined) throw new Error('capabilities route not registered')
  return {
    gateway,
    call: async (url: string) => {
      const { res, read } = fakeRes()
      await handler(fakeReq(url), res)
      return read()
    },
  }
}

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'pico-cap-proxy-home-'))
  const skillsDir = join(home, 'skills')
  await mkdir(join(skillsDir, 'codeql'), { recursive: true })
  await writeFile(join(skillsDir, 'codeql', 'SKILL.md'), SKILL_MD, 'utf8')
  vi.stubEnv('DSH_HOME', home)
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await rm(home, { recursive: true, force: true })
})

/** 服务端载荷：own 面给一条「已通过」的自有行；market 面给一条组织行与一条市场行。 */
function stubCatalog(h: { gateway: string[] }): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
    const href = String(url)
    h.gateway.push(href)
    const payload = href.includes('source=own')
      ? {
          items: [{
            kind: 'skill', name: 'codeql', version: '1.0.0', status: 'approved',
            source: 'org', is_owner: true, display_name: 'CodeQL 示例技能',
          }],
        }
      : href.includes('source=org')
        ? { items: [{ kind: 'skill', name: 'codeql', version: '1.0.0', status: 'approved', source: 'org', display_name: 'CodeQL 示例技能' }] }
        : {
            items: [
              { kind: 'skill', name: 'codeql', version: '1.0.0', status: 'approved', source: 'org', display_name: 'CodeQL 示例技能' },
              { kind: 'skill', name: 'market-only', version: '2.0.0', status: 'approved', source: 'market', display_name: '市场技能' },
            ],
          }
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
  }))
}

describe('能力中心聚合代理：本地上传行的状态匹配（技能链路客户端侧契约）', () => {
  it('?source=local 请求服务端 ?source=own，并把 approved 匹配到本地创作行', async () => {
    const h = harness(SESSION)
    stubCatalog(h)
    const res = await h.call('/api/pico/capabilities?source=local')
    expect(res.code).toBe(200)
    expect(h.gateway.some(u => u.includes('/api/client/v2/capabilities?source=own'))).toBe(true)

    const local = (res.body.items as Array<Record<string, unknown>>).find(i => i.source === 'local' && i.name === 'codeql')
    expect(local, '本地创作行必须在「我的」面返回').toBeDefined()
    // 这两条就是"审批通过了但面板看不出结果"的判据：状态徽章与 uploadStatus 都来自匹配。
    expect(local?.status).toBe('approved')
    expect(local?.uploadStatus).toBe('approved')
  })

  it('服务端没有同名 own 行时，本地行不带状态（面板显示"上传"而不是假装已通过）', async () => {
    const h = harness(SESSION)
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      h.gateway.push(String(url))
      return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }))
    const res = await h.call('/api/pico/capabilities?source=local')
    const local = (res.body.items as Array<Record<string, unknown>>).find(i => i.source === 'local' && i.name === 'codeql')
    expect(local).toBeDefined()
    expect(local?.uploadStatus).toBeUndefined()
  })

  it('?source=market 原样透传服务端载荷（org 行与市场行都在，source 徽章保留）', async () => {
    const h = harness(SESSION)
    stubCatalog(h)
    const res = await h.call('/api/pico/capabilities?source=market')
    expect(res.code).toBe(200)
    expect(h.gateway.some(u => u.includes('/api/client/v2/capabilities?source=market'))).toBe(true)
    const items = res.body.items as Array<Record<string, unknown>>
    expect(items.find(i => i.name === 'codeql')?.source).toBe('org')
    expect(items.find(i => i.name === 'market-only')?.source).toBe('market')
  })

  it('非法 source 与未登录都会明确失败（不静默返回空目录）', async () => {
    const h = harness(SESSION)
    stubCatalog(h)
    expect((await h.call('/api/pico/capabilities?source=bogus')).code).toBe(400)
    const anon = harness(null)
    stubCatalog(anon)
    expect((await anon.call('/api/pico/capabilities?source=market')).code).toBe(401)
  })
})
