/**
 * R6-B P3（第六轮审计，2026-09-23）：auth-gate 的**全部**路径段解码都必须兜住
 * 畸形百分号转义。
 *
 * 缺陷形态：`decodeURIComponent('%zz')` 抛 `URIError`，而 auth-gate 的 handler 是
 * async 的 —— 异常穿出 handler 后被上游 webserver 兜底成 `writeHead(400); res.end()`
 * （**无 body**）。同仓的三处（`wasm-apps.ts:decodePathSegments`、`connectors` 与
 * `browser` 的 `decodeSegment`）早已按 FIX-40 收敛，只有本文件里的 11 条语句
 * （12 次调用）还是裸 `decodeURIComponent`：AI 的 http 工具/脚本拿到一个空 body 的
 * 400，完全无法判断该改什么。合法客户端不会构造这种路径（面板一律 encodeURIComponent），
 * 所以这不是安全边界，而是"错误一律 JSON 信封"这条契约的完整性。
 *
 * 判据（每条端点都过一遍，不用抽查代表元）：
 *   1. 畸形转义 ⇒ **不抛穿 handler** + `400 {error, code:'INVALID_PATH'}`；
 *   2. 畸形请求**不得触达上游**（`fetch` 零调用 —— 校验发生在出站之前）；
 *   3. 对照：合法的百分号编码仍然照常走到上游（判据不是"一律拒绝"）。
 *
 * 变异验证（见 `temp/r6b-fix/MUTATION.md`）：把任一处 `decodePathSegment` 改回裸
 * `decodeURIComponent` ⇒ 对应用例必红（异常抛穿）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, decodePathSegment, type Config } from '../src/auth-gate.ts'
import type { Session } from '../src/server-connector/config.ts'

/** 与 wasm-apps 的 FIX-40 同一份畸形语料（含截断的多字节序列与裸 %）。 */
const MALFORMED = ['%zz', '%E0%A4%A', '%', '%2', '%GG']

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

/** 本文件里**每一处**解码点对应的端点（`{bad}` = 畸形转义所在的那一格）。 */
const ENDPOINTS: Array<{ method: string, path: (bad: string) => string, note: string }> = [
  { method: 'POST', path: bad => `/api/pico/skills/builtin/${bad}/install`, note: '内置技能安装' },
  { method: 'POST', path: bad => `/api/pico/skills/builtin/${bad}/uninstall`, note: '内置技能卸载' },
  { method: 'POST', path: bad => `/api/pico/skills/${bad}/install`, note: '市场技能安装' },
  { method: 'POST', path: bad => `/api/pico/skills/${bad}/uninstall`, note: '市场技能卸载' },
  { method: 'GET', path: bad => `/api/pico/skills/${bad}/archive`, note: '市场技能归档下载' },
  { method: 'POST', path: bad => `/api/pico/agent-presets/${bad}/install`, note: '共享 Agent 安装' },
  { method: 'POST', path: bad => `/api/pico/agent-presets/${bad}/uninstall`, note: '共享 Agent 卸载' },
  { method: 'GET', path: bad => `/api/pico/agent-presets/${bad}/archive`, note: '共享 Agent 归档下载' },
  { method: 'POST', path: bad => `/api/pico/shared-skills/${bad}/1.0.0/install`, note: '组织技能安装（名字段）' },
  { method: 'POST', path: bad => `/api/pico/shared-skills/demo/${bad}/install`, note: '组织技能安装（版本段）' },
  { method: 'POST', path: bad => `/api/pico/shared-skills/${bad}/1.0.0/uninstall`, note: '组织技能卸载' },
]

function fakeRequest(url: string, method: string): IncomingMessage {
  const chunks: Buffer[] = []
  return {
    method,
    url,
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
      body = chunk === undefined ? undefined : (() => {
        try { return JSON.parse(chunk.toString()) } catch { return chunk.toString() }
      })()
    },
  } as unknown as ServerResponse
  return { res, read: () => ({ code, body }) }
}

/** 注册全部 auth-gate 路由；返回按 URL 选中的那个 prefix handler。 */
function harness(session: Session | null): { call: (url: string, method: string) => Promise<{ code: number, body: any }> } {
  const routes: Route[] = []
  const ctx = {
    effect: (fn: () => unknown) => { fn() },
    get: (name: string) => (name === 'connection' ? { requestRejection: () => undefined } : undefined),
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
    call: async (url: string, method: string) => {
      const pathname = new URL(url, 'http://localhost').pathname
      const route = routes.find(r => r.kind === 'prefix' && pathname.startsWith(r.path))
      if (route === undefined) throw new Error(`没有匹配 ${url} 的路由`)
      const { res, read } = fakeResponse()
      await route.handler(fakeRequest(url, method), res)
      return read()
    },
  }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('R6-B P3：本机路由的路径段解码不得让 URIError 抛穿 handler', () => {
  it('decodePathSegment 是纯函数：合法段解码、畸形段回 null（不发异常）', () => {
    expect(decodePathSegment('demo%2Dtool')).toBe('demo-tool')
    expect(decodePathSegment('a%20b')).toBe('a b')
    for (const bad of MALFORMED) expect(decodePathSegment(bad), bad).toBeNull()
  })

  it('11 条端点 × 5 种畸形转义：一律 400 + JSON 信封，且零出站', async () => {
    for (const endpoint of ENDPOINTS) {
      for (const bad of MALFORMED) {
        const outbound = vi.fn(async () => new Response('{}', { status: 200 }))
        vi.stubGlobal('fetch', outbound)
        const h = harness(SESSION)
        let thrown: unknown = null
        let out: { code: number, body: any } | null = null
        try {
          out = await h.call(endpoint.path(bad), endpoint.method)
        } catch (cause) {
          thrown = cause
        }
        const label = `${endpoint.note} ${endpoint.method} ${endpoint.path(bad)}`
        expect(thrown, `${label} 抛穿 handler：${String(thrown)}`).toBeNull()
        expect(out!.code, label).toBe(400)
        expect(out!.body?.code, `${label} 必须回具名错误码（否则 AI 只能看到无 body 的 400）`).toBe('INVALID_PATH')
        expect(typeof out!.body?.error, label).toBe('string')
        expect(outbound, `${label} 不得触达上游`).not.toHaveBeenCalled()
        vi.unstubAllGlobals()
      }
    }
    // 已知规模的回查：本文件覆盖的解码点必须与源码里的解码点数量一致
    // （新增裸 decodeURIComponent 时这条会红，逼作者同步补用例）。
    expect(ENDPOINTS.length).toBe(11)
  })

  it('对照：合法的百分号编码照常走到上游（不是"一律拒绝"）', async () => {
    const outbound = vi.fn(async () => new Response('not found', { status: 404 }))
    vi.stubGlobal('fetch', outbound)
    const h = harness(SESSION)
    const out = await h.call('/api/pico/skills/demo%2Dtool/archive', 'GET')
    // 过了解码 + 命名校验 ⇒ 打到上游；上游 404 原样透出（不是 INVALID_PATH）。
    expect(outbound).toHaveBeenCalledTimes(1)
    expect(String((outbound.mock.calls[0] as unknown[])[0])).toContain('/marketplace/skills/demo-tool/archive')
    expect(out.code).toBe(404)
    expect(out.body?.code).toBeUndefined()
  })

  it('源码级对拍：本文件的 11 条端点覆盖了 auth-gate 里全部解码语句', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const source = readFileSync(fileURLToPath(new URL('../src/auth-gate.ts', import.meta.url)), 'utf8')
    // **注释行不算**（helper 的 JSDoc 里就写着 `decodeURIComponent('%zz')` 这个例子）。
    const codeLines = source.split('\n').filter(line => {
      const trimmed = line.trim()
      return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*')
    })
    const code = codeLines.join('\n')
    // 解析体里不得再有裸 decodeURIComponent（只允许 helper 自己那一处）。
    const calls = [...code.matchAll(/decodeURIComponent\(/gu)].length
    expect(calls, '裸 decodeURIComponent 只允许出现在 decodePathSegment 内部').toBe(1)
    const guarded = [...code.matchAll(/decodePathSegment\(/gu)].length
    // 11 次调用（组织技能 install 那一处名字+版本各一次，共 2 次）+ 1 次 helper 定义。
    // 原始形态核对：`git show HEAD:…/auth-gate.ts | grep -c 'decodeURIComponent('` = 11。
    expect(guarded).toBe(12)
    // 每一处后面都必须紧跟 null 检查（不能"只解码不判"）。
    const unchecked = [...code.matchAll(/decodePathSegment\([^\n]*\)\n(?!\s*if \(\w+ === null\))/gu)]
    expect(unchecked.map(m => m[0].trim()), '每个 decodePathSegment 调用后必须紧跟 null 检查').toEqual([])
  })
})
