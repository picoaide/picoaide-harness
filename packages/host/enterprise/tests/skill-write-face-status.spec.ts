/**
 * tests/skill-write-face-status.spec.ts — 第四轮审计 **R4-B-6**（四条写面的非法名
 * 状态码不收敛）与 **R4-B-14**（`?source=local` 的商店行缺 `isOwner`）的回归。
 *
 * 两条都发生在**宿主路由层**（`src/auth-gate.ts`），所以这里起真实的 auth-gate
 * `apply()`（假 ctx + 假 req/res，与 `builtin-skills.spec.ts` 同口径）并按真实
 * pathname 分派，而不是只读源码。
 *
 * ## R4-B-6：非法技能名必须是 400（不是 422）
 *
 * `/api/pico/skills/:name/{install,uninstall}`、`/api/pico/skills/builtin/:name/
 * {install,uninstall}` 都在进安装器**之前** `validateSkillName` → 400；只有
 * `/api/pico/shared-skills/:name/:version/uninstall` 把校验留给 `uninstallSkill`
 * 内部抛，于是走 `describeArchiveFailure` 的 typed 分支 → **422 + code**。同一个
 * 客户端面板对同一类输入看到两种状态码。判据：四条写面在同一个非法名下一律 400
 * （且都属于"请求有问题"，不是"内容有问题"）。
 *
 * ## R4-B-14：`?source=local` 的商店行必须带 `isOwner`
 *
 * 面板的上传预检是 `clash.isOwner !== true ⇒ 直接提示「名称已被占用」、不发请求`
 * （`CapabilityCenterPanel.upload()`），而它扫的是当前 `items`。市场分区取数失败/
 * 未回来时，`applySectionRows` 会丢掉旧的非本地行 ⇒「我的」里只剩这一份**没有
 * `isOwner`** 的商店行 ⇒ 作者上传**自己的**技能被本地预检挡住。字段来自服务端
 * `capabilities.CapabilityItem.IsOwner`（json: `is_owner`），enriched 分支早已透传，
 * 只有 `?source=local` 的商店行漏了。
 *
 * ---- 变异验证 ----
 *   - 去掉 shared-skills 卸载分支的 `validateSkillName` 调用 ⇒ 第 1 条红（422）；
 *   - 去掉 `?source=local` 商店行里的 `isOwner` ⇒ 第 2 条红（undefined）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, type Config } from '../src/auth-gate.ts'
import type { Session } from '../src/server-connector/config.ts'

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

function fakeReq(url: string, method = 'GET'): IncomingMessage {
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
  } as unknown as IncomingMessage
}

function fakeRes(): { res: ServerResponse, read: () => { code: number, body: any } } {
  let code = 0
  let body: unknown
  const res = {
    writeHead: (value: number) => { code = value },
    end: (chunk?: string | Buffer) => {
      try {
        body = JSON.parse(chunk === undefined ? '' : Buffer.from(chunk).toString())
      } catch {
        body = undefined
      }
    },
  } as unknown as ServerResponse
  return { res, read: () => ({ code, body }) }
}

/** 宿主侧 `connection` 服务的持有性证明栅栏。 */
function browserFence(): { requestRejection: (r: { headers: Record<string, unknown> }) => 401 | undefined } {
  return {
    requestRejection: (request: { headers: Record<string, unknown> }) =>
      (request.headers['cookie'] === undefined ? (401 as const) : undefined),
  }
}

/** 起真实 auth-gate，按 pathname 最长前缀分派到已注册的 prefix 路由。 */
function harness(session: Session | null): { call: (url: string, method?: string) => Promise<{ code: number, body: any }> } {
  const routes: Route[] = []
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
  const prefixes = routes.filter(r => r.kind === 'prefix')
  return {
    call: async (url: string, method = 'GET') => {
      const pathname = url.split('?')[0] ?? url
      const handler = prefixes
        .filter(r => pathname === r.path || pathname.startsWith(`${r.path}/`))
        .sort((a, b) => b.path.length - a.path.length)[0]?.handler
      if (handler === undefined) throw new Error(`no route registered for ${pathname}`)
      const { res, read } = fakeRes()
      await handler(fakeReq(url, method), res)
      return read()
    },
  }
}

let home = ''

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'r4b-write-face-'))
  vi.stubEnv('DSH_HOME', home)
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await rm(home, { recursive: true, force: true })
})

/** 造一份本机已装技能（能力中心聚合面据它以磁盘事实补 installed/origin）。 */
async function seedInstalled(name: string): Promise<void> {
  const dir = join(home, 'skills', name)
  await mkdir(join(dir, '.picoaide'), { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: mine\n---\n\nbody\n`)
  await writeFile(join(dir, '.picoaide', 'release.json'), `${JSON.stringify({
    appId: name, version: '1.0.0', channel: 'org', installedAt: '2026-09-01T00:00:00.000Z',
  }, null, 2)}\n`)
}

describe('R4-B-6 四条写面对非法技能名的状态码收敛到 400', () => {
  const BAD = 'Bad Name' // 含空格与大写 ⇒ 不匹配 SKILL_NAME_PATTERN

  it('同一个非法名：四条写面一律 400（不是 422），且都不落盘', async () => {
    const h = harness(SESSION)
    const faces: Array<[string, string]> = [
      ['市场安装', `POST /api/pico/skills/${encodeURIComponent(BAD)}/install`],
      ['市场卸载', `POST /api/pico/skills/${encodeURIComponent(BAD)}/uninstall`],
      ['内置安装', `POST /api/pico/skills/builtin/${encodeURIComponent(BAD)}/install`],
      ['内置卸载', `POST /api/pico/skills/builtin/${encodeURIComponent(BAD)}/uninstall`],
      ['共享卸载（R4-B-6 的缺口）', `POST /api/pico/shared-skills/${encodeURIComponent(BAD)}/1.0.0/uninstall`],
      ['共享安装（R4-B-6 的缺口）', `POST /api/pico/shared-skills/${encodeURIComponent(BAD)}/1.0.0/install`],
    ]
    for (const [label, spec] of faces) {
      const [method, url] = spec.split(' ') as [string, string]
      const res = await h.call(url, method)
      expect(res.code, `${label} 对非法名必须回 400（请求有问题，不是内容有问题）`).toBe(400)
      expect(typeof res.body?.error, `${label} 必须带可读原因`).toBe('string')
    }
  })

  it('合法名但未安装：仍是 404 NOT_INSTALLED（收敛不把别的语义改坏）', async () => {
    const h = harness(SESSION)
    const res = await h.call('/api/pico/shared-skills/not-installed/1.0.0/uninstall', 'POST')
    expect(res.code).toBe(404)
    expect(res.body.code).toBe('NOT_INSTALLED')
  })
})

describe('R4-B-14 `?source=local` 的商店行必须带 isOwner（作者上传自己的技能不被预检挡住）', () => {
  /** 服务端 `GET /api/client/v2/capabilities` 的两种载荷（含 is_owner）。 */
  function stubCatalog(): void {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const href = String(url)
      const items = href.includes('source=market') || href.includes('source=own')
        ? [{ kind: 'skill', name: 'codeql', display_name: 'CodeQL', version: '1.0.0', source: 'market', is_owner: true, author: 'alice' }]
        : href.includes('source=org')
          ? [{ kind: 'skill', name: 'codeql', display_name: '组织版 CodeQL', version: '1.0.0', source: 'org', is_owner: true, author: 'alice' }]
          : []
      return new Response(JSON.stringify({ items }), { status: 200, headers: { 'content-type': 'application/json' } })
    }))
  }

  it('本机已装的同名商店行必须带 isOwner:true（否则面板预检判"名称已被占用"）', async () => {
    stubCatalog()
    await seedInstalled('codeql')
    const h = harness(SESSION)
    const res = await h.call('/api/pico/capabilities?source=local')
    expect(res.code).toBe(200)
    const storeRows = (res.body.items as Array<Record<string, unknown>>).filter(i => i.source !== 'local')
    expect(storeRows.length, '已装的商店行必须出现在「我的」里').toBeGreaterThan(0)
    for (const row of storeRows) {
      expect(
        row.isOwner,
        `${String(row.source)} 的已装行缺 isOwner ⇒ 作者上传自己的技能会被本地预检直接挡下（R4-B-14）`,
      ).toBe(true)
    }
  })

  it('服务端说不是本人（is_owner:false）时不得伪造成 true', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      items: [{ kind: 'skill', name: 'codeql', display_name: 'CodeQL', version: '1.0.0', source: 'market', is_owner: false }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })))
    await seedInstalled('codeql')
    const h = harness(SESSION)
    const res = await h.call('/api/pico/capabilities?source=local')
    const storeRows = (res.body.items as Array<Record<string, unknown>>).filter(i => i.source !== 'local')
    expect(storeRows.every(row => row.isOwner === false)).toBe(true)
  })
})
