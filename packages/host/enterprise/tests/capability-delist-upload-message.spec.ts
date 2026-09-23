/**
 * R5-B-1 的客户端尾巴（2026-09-23 跨泳道补齐）：下架冻结在能力中心里必须
 * **说得出来**，而不是变成一句通用错误。
 *
 * 服务端语义（`serverstore/distribution.go`）：下架（`apps.enabled=0`）期间内容冻结
 * ——发布新版本与审核通过一律 409 `APP_DELISTED`（技能侧 `sharedskills.decide`、
 * 上传侧 `appstore.Publish`，智能体侧 `agentshare.decide` 与发布内核同闸门）。
 * 客户端这半边的两个缺口此前都开着：
 *   1. 面板的 `upload()` 把 409 的响应体当字符串读（`data.error`），**错误码在
 *      本机写面就被丢掉了** ⇒ 面板没有任何判据能区分「已下架冻结」与「名称已被占用」
 *      （两者都是 409）；而本仓有明确的前车之鉴：判据必须看稳定错误码，不能看状态码。
 *   2. 即便拿到码，面板也只有服务端 message 可显示，没有自己的「怎么办」文案。
 *
 * 本文件钉住的三件事：
 *   - 本机写面（`auth-gate` 的两条上传代理）真的把 `APP_DELISTED` **透传**给页面
 *     —— 端到端驱动真路由，喂一个 409 + `{"error":{"code":"APP_DELISTED",…}}` 的
 *     上游响应，断言页面拿到 `{error, code}`；
 *   - 面板的 `uploadFailureText` 只对 `APP_DELISTED` 用专用文案，**其它任何码都
 *     逐字沿用原行为**（服务端 message 优先，缺省回落 `HTTP <status>`）；
 *   - 文案本身存在且说清「冻结 / 重新上架后才能发新版」（中英各一条）。
 *
 * 判据的判别力（变异验证见报告 §变异对照）：
 *   - 去掉写面的 `code: cause.code` ⇒ 端到端两条必红（`body.code` 变 undefined）；
 *   - 把 `uploadFailureText` 的 APP_DELISTED 分支删掉 / 改成按 `status === 409`
 *     兜底 ⇒ 「专用文案」条必红，且反向条（NAME_TAKEN 仍显示重名文案）会暴露兜底；
 *   - 删掉 `capability.delistedFrozen` 字典项 ⇒ 文案条与 TS 类型（en 镜像）同时红。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, type Config } from '../src/auth-gate.ts'
import { uploadFailureText } from '../src/client/CapabilityCenterPanel.tsx'
import { en, setActiveLocale, t, zh } from '../src/client/locales.ts'
import type { Session } from '../src/server-connector/config.ts'

afterEach(() => { setActiveLocale('zh') })

const SESSION: Session = {
  serverURL: 'https://harness.example',
  username: 'alice',
  token: 'USER-TOKEN-abc',
  role: 'employee',
}

const SKILL_MD = `---
name: codeql
title: CodeQL 示例技能
version: 1.0.0
description: 用于回归测试下架冻结文案的示例技能,描述长度足以通过发布前预检。
author: tester
category: security
---
本技能只用于自动化回归测试,不会真的执行任何静态分析任务;正文刻意写长以通过发布前
预检的正文长度下限要求,内容本身没有任何实际用途,仅用于验证上传链路的错误文案。
`

const PRESET_COMPOSITION = `- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: hi
`

interface Route {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void
}

function fakeReq(method: string, url: string, body?: string): IncomingMessage {
  const chunks = body === undefined ? [] : [Buffer.from(body)]
  return {
    method,
    url,
    headers: {
      origin: 'http://127.0.0.1:3080',
      host: '127.0.0.1:3080',
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
      cookie: 'dsh-auth-127.0.0.1:3080=v1.signature',
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

/** 持有性证明替身（真页面恒带 cookie ⇒ 放行）。 */
function browserFence(): { requestRejection: (r: { headers: Record<string, unknown> }) => 401 | undefined } {
  return { requestRejection: (request) => request.headers['cookie'] === undefined ? 401 : undefined }
}

interface Harness {
  handler: (path: string) => Route['handler']
  gateway: string[]
}

function harness(session: Session | null): Harness {
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
  return {
    gateway,
    handler: (path: string) => {
      const route = routes.find((r) => r.kind === 'prefix' && r.path === path)
        ?? routes.find((r) => r.kind === 'exact' && r.path === path)
      if (route === undefined) throw new Error(`no route ${path}`)
      return route.handler
    },
  }
}

/** 上游一律回同一个错误信封（模拟服务端的 409 APP_DELISTED / 409 NAME_TAKEN）。 */
function stubGatewayError(h: Harness, status: number, code: string, message: string): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
    h.gateway.push(String(url))
    return new Response(JSON.stringify({ error: { code, message } }), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }))
}

/** 跑一次本机写面的上传（真路由 + 真 body 流）。 */
async function postUpload(h: Harness, route: string, url: string, body: string): Promise<{ code: number, body: any }> {
  const { res, read } = fakeRes()
  await h.handler(route)(fakeReq('POST', url, body), res)
  return read()
}

const DELISTED_MESSAGE = '该技能已下架，暂不能发布新版本：请先联系管理员重新上架'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'pico-delist-upload-'))
  await mkdir(join(home, 'skills', 'codeql'), { recursive: true })
  await writeFile(join(home, 'skills', 'codeql', 'SKILL.md'), SKILL_MD, 'utf8')
  await mkdir(join(home, '.agent-presets', 'preset-a'), { recursive: true })
  await writeFile(join(home, '.agent-presets', 'preset-a', 'agent.cordis.yml'), PRESET_COMPOSITION, 'utf8')
  vi.stubEnv('DSH_HOME', home)
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await rm(home, { recursive: true, force: true })
})

describe('下架冻结(409 APP_DELISTED)：本机写面透传错误码，面板据此给可读文案', () => {
  it('技能与智能体两条上传代理都把 APP_DELISTED 交给页面，面板映射成专用文案', async () => {
    const h = harness(SESSION)
    stubGatewayError(h, 409, 'APP_DELISTED', DELISTED_MESSAGE)

    const skill = await postUpload(h, '/api/pico/shared-skills', '/api/pico/shared-skills/upload', '{"name":"codeql"}')
    expect(skill.code).toBe(409)
    // 判据必须是 code（409 同时是 NAME_TAKEN/VERSION_*/CONFLICT 的码）。
    expect(skill.body.code).toBe('APP_DELISTED')
    expect(skill.body.error).toBe(DELISTED_MESSAGE)
    // 面板拿到的就是这两个字段 —— 端到端闭合：代理透传 ⇒ 映射生效。
    const shown = uploadFailureText({ code: skill.body.code, message: skill.body.error, status: skill.code })
    expect(shown).toBe(t('capability.delistedFrozen'))
    expect(shown).toContain('重新上架')

    // 智能体面的代理是另一条分支（同一类缺陷的孪生），必须逐字同形。
    const agent = await postUpload(h, '/api/pico/agent-presets', '/api/pico/agent-presets/upload', '{"name":"preset-a"}')
    expect(agent.code).toBe(409)
    expect(agent.body.code).toBe('APP_DELISTED')
    expect(uploadFailureText({ code: agent.body.code, message: agent.body.error, status: agent.code }))
      .toBe(t('capability.delistedFrozen'))
  })

  it('反向：其它 409（NAME_TAKEN）不被这条分支吞掉，仍显示服务端原文', async () => {
    const h = harness(SESSION)
    const takenMessage = '名称已被占用，无法上传：请更换名称或联系管理员'
    stubGatewayError(h, 409, 'NAME_TAKEN', takenMessage)

    const res = await postUpload(h, '/api/pico/shared-skills', '/api/pico/shared-skills/upload', '{"name":"codeql"}')
    expect(res.code).toBe(409)
    expect(res.body.code).toBe('NAME_TAKEN')
    const shown = uploadFailureText({ code: res.body.code, message: res.body.error, status: res.code })
    expect(shown).toBe(takenMessage)
    expect(shown).not.toBe(t('capability.delistedFrozen'))
  })
})

describe('uploadFailureText：判据只看错误码，其它码逐字沿用原行为', () => {
  it('APP_DELISTED ⇒ 专用文案（中英各一条，且说明"冻结 + 重新上架后才能发新版"）', () => {
    expect(uploadFailureText({ code: 'APP_DELISTED', message: DELISTED_MESSAGE, status: 409 }))
      .toBe(zh['capability.delistedFrozen'])
    expect(zh['capability.delistedFrozen']).toContain('冻结')
    expect(zh['capability.delistedFrozen']).toContain('重新上架')
    setActiveLocale('en')
    expect(uploadFailureText({ code: 'APP_DELISTED', status: 409 })).toBe(en['capability.delistedFrozen'])
    expect(en['capability.delistedFrozen']).not.toBe('')
  })

  it('缺 code 时**不得**按状态码兜底成下架文案（本仓踩过"看 409 不看 code"的坑）', () => {
    const shown = uploadFailureText({ status: 409, message: '名称已被占用，无法上传' })
    expect(shown).toBe('名称已被占用，无法上传')
    expect(shown).not.toBe(t('capability.delistedFrozen'))
    // 连 message 都没有时退回 HTTP 状态码，同样不得误判成下架。
    const bare = uploadFailureText({ status: 409 })
    expect(bare).toBe('HTTP 409')
    expect(bare).not.toBe(t('capability.delistedFrozen'))
  })

  it('无 code / 其它 code 时沿用服务端 message；message 缺失才回落 HTTP <status>', () => {
    expect(uploadFailureText({ code: 'PENDING_LIMIT', message: '待审上限已满', status: 429 })).toBe('待审上限已满')
    expect(uploadFailureText({ code: 'UPSTREAM', status: 502 })).toBe('HTTP 502')
  })
})

describe('下架文案的字典与接线（两处都必须真的用上）', () => {
  const PANEL = fileURLToPath(new URL('../src/client/CapabilityCenterPanel.tsx', import.meta.url))
  const AUTH_GATE = fileURLToPath(new URL('../src/auth-gate.ts', import.meta.url))

  it('「已下架」说明文字说清内容冻结与重新上架（中英各一条）', () => {
    expect(zh['capability.delistedHint']).toContain('冻结')
    expect(zh['capability.delistedHint']).toContain('重新上架')
    expect(en['capability.delistedHint']).toMatch(/frozen/i)
    expect(en['capability.delistedHint']).toMatch(/relist/i)
  })

  it('面板在 upload() 里真的调用映射函数（纯函数测得再准，没接线也是死代码）', () => {
    const panel = readFileSync(PANEL, 'utf8')
    // 上传失败分支走映射（`throw new Error(uploadFailureText({…}))`）。
    expect(panel).toContain('throw new Error(uploadFailureText({')
    // 安装/卸载两条**保持原行为**（本次只改上传面，不顺手扩张判据）。
    const legacyRelays = panel.match(/throw new Error\(\(data as \{ error\?: string \}\)\.error \?\? `HTTP \$\{String\(res\.status\)\}`\)/g) ?? []
    expect(legacyRelays).toHaveLength(2)
  })

  it('两条本机上传代理都透传 code（漏一条 = 该面的下架文案退化成服务端 message）', () => {
    const gate = readFileSync(AUTH_GATE, 'utf8')
    const relays = gate.match(/\{ error: cause\.message, code: cause\.code \}/g) ?? []
    expect(relays).toHaveLength(2)
  })
})
