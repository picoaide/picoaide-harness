/**
 * R6-B P3（第六轮审计，2026-09-23）：账户卡片的改密失败判据**不得嗅探服务端中文原文**。
 *
 * 缺陷形态：`AccountSection.tsx` 用 `raw.includes('原密码')` 把 401 映射成
 * `account.password.errOld`（"原密码不正确"）。而服务端另有 **400** 分支
 * `"新密码不能与原密码相同"`（`server/internal/serverauth/handler.go` 的 VALIDATION）
 * 也含这一串 ⇒ 文案耦合：服务端改措辞时这里静默退化，而且这条 400 会被显示成
 * "原密码不正确"（错误归因）。
 *
 * 修法（两端各一半）：
 *   - 宿主 `POST /api/pico/auth/password` 回**稳定错误码**（扁平 `{error, code}`，
 *     与同文件其余写面同形状）：`AUTH_FAILED`（401，服务端拒绝本次凭据 = 原密码错）
 *     / `NETWORK`（502）/ `ApiError.code`（如 `HTTP_400`）/ `INTERNAL`；
 *   - 面板按 `payload.code === 'AUTH_FAILED'` 判定（`isWrongOldPassword`），
 *     文本只用于"显示服务端原文"，不参与判定。
 *
 * 判据的判别力（变异验证见 `temp/r6b-fix/MUTATION.md`）：
 *   - 把 `isWrongOldPassword` 改回 `JSON.stringify(payload).includes('原密码')`
 *     ⇒ 本文件第 2、3 条红（那条 400 被误判成"旧密码错"）；
 *   - 宿主不再下发 `code` ⇒ 第 1 条红。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, type Config } from '../src/auth-gate.ts'
import type { Session } from '../src/server-connector/config.ts'
import { isWrongOldPassword } from '../src/client/AccountSection.tsx'

const SESSION: Session = {
  serverURL: 'https://harness.example',
  username: 'alice',
  token: 'TOKEN',
  role: 'employee',
}

interface Route {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void
}

function fakeRequest(body: unknown): IncomingMessage {
  const chunks = [Buffer.from(JSON.stringify(body))]
  return {
    method: 'POST',
    url: '/api/pico/auth/password',
    headers: {
      origin: 'http://127.0.0.1:3080',
      host: '127.0.0.1:3080',
      'sec-fetch-site': 'same-origin',
      cookie: 'dsh-auth-127.0.0.1:3080=v1.signature',
    },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk },
  } as unknown as IncomingMessage
}

function fakeResponse(): { res: ServerResponse, read: () => { code: number, body: any } } {
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

/** 真 auth-gate 路由 + 假服务端（只关心服务端的错误信封）。 */
function callPassword(upstream: { status: number, error: { code: string, message: string } } | 'network'): Promise<{ code: number, body: any }> {
  const routes: Route[] = []
  const ctx = {
    effect: (fn: () => unknown) => { fn() },
    get: (name: string) => (name === 'connection' ? { requestRejection: () => undefined } : undefined),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    picoSession: {
      isRestored: () => true,
      isLoggedIn: () => true,
      getSession: () => SESSION,
      setSession: vi.fn(),
      clear: vi.fn(),
    },
    webServer: {
      tapIndex: () => () => {},
      register: (route: Route) => { routes.push(route); return () => {} },
    },
  }
  apply(ctx as never, {} as Config)
  const handler = routes.find(r => r.kind === 'exact' && r.path === '/api/pico/auth/password')?.handler
  if (handler === undefined) throw new Error('没有注册 /api/pico/auth/password')
  vi.stubGlobal('fetch', vi.fn(async () => {
    if (upstream === 'network') throw new Error('socket hang up')
    return new Response(JSON.stringify({ error: upstream.error }), {
      status: upstream.status,
      headers: { 'content-type': 'application/json' },
    })
  }))
  const { res, read } = fakeResponse()
  return Promise.resolve(handler(fakeRequest({ old_password: 'old-password-1', new_password: 'new-password-2' }), res))
    .then(() => read())
}

afterEach(() => { vi.unstubAllGlobals() })

describe('R6-B P3：改密失败的判据是错误码，不是服务端文案', () => {
  it('服务端 401 AUTH_FAILED（原密码错误）⇒ 宿主回 code=AUTH_FAILED，面板判"旧密码错"', async () => {
    const out = await callPassword({ status: 401, error: { code: 'AUTH_FAILED', message: '原密码错误' } })
    expect(out.code).toBe(401)
    expect(out.body.code, '宿主必须下发稳定错误码（面板据此本地化）').toBe('AUTH_FAILED')
    expect(isWrongOldPassword(out.body)).toBe(true)
  })

  it('服务端 400 VALIDATION「新密码不能与原密码相同」⇒ **不得**判成旧密码错（文本嗅探的错档）', async () => {
    const out = await callPassword({ status: 400, error: { code: 'VALIDATION', message: '新密码不能与原密码相同' } })
    expect(out.code).toBe(400)
    // 文案里**含**"原密码"三个字：旧的 `includes('原密码')` 会在这里误判。
    expect(String(out.body.error)).toContain('原密码')
    expect(isWrongOldPassword(out.body), '判据必须只看 code，不看文案').toBe(false)
  })

  it('判据是纯函数：只认 code=AUTH_FAILED，其余形状一律 false', () => {
    expect(isWrongOldPassword({ code: 'AUTH_FAILED', error: '原密码错误' })).toBe(true)
    expect(isWrongOldPassword({ error: '原密码错误' })).toBe(false)          // 老形状（无码）
    expect(isWrongOldPassword({ code: 'HTTP_400', error: '新密码不能与原密码相同' })).toBe(false)
    expect(isWrongOldPassword({ code: 'NETWORK' })).toBe(false)
    expect(isWrongOldPassword('原密码错误')).toBe(false)
    expect(isWrongOldPassword(null)).toBe(false)
    expect(isWrongOldPassword(undefined)).toBe(false)
  })

  it('连接层失败（不是服务端拒绝）回 NETWORK + 502，不冒充"旧密码错"', async () => {
    const out = await callPassword('network')
    expect(out.code).toBe(502)
    expect(out.body.code).toBe('NETWORK')
    expect(isWrongOldPassword(out.body)).toBe(false)
  })

  it('源码级对拍：面板里不再有"嗅探中文原文"的判据（改回去即红）', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/client/AccountSection.tsx', import.meta.url)), 'utf8')
    const code = source.split('\n')
      .filter(line => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
      .join('\n')
    expect(code).not.toContain("includes('原密码')")
    expect(code).not.toContain('includes("原密码")')
    expect(code).toContain('isWrongOldPassword(data)')
  })
})
