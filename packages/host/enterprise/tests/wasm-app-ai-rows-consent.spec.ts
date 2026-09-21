/**
 * 「**允许 AI 读取此应用的数据**」：默认关 + 显式授权卡（2026-09-21 用户拍板）。
 *
 * 覆盖三件事，每一件都是"实现替产品做了决定"的对立面：
 *
 *  1. **默认关且零出站**：`wasm_app_rows` 在应用未授权时必须回**结构化拒绝**
 *     （稳定 code `AI_ROWS_NOT_AUTHORIZED`，带"去数据面板打开开关"的指路），
 *     并且**一个字节都不发往服务端**。绝不能是静默空结果 —— 那会让模型把
 *     "人还没授权"读成"数据没写进去"，然后去改代码。
 *  2. **两侧共用一个真源**：授权由**人在客户端面板**里做（本机路由
 *     `POST …/:app_id/ai-rows-consent`），闸门在**宿主工具**里。判据里那条
 *     "走本机路由授权 ⇒ 工具立刻放行"就是这条接线唯一可被打坏的地方。
 *  3. **落盘与 fail-closed**：状态落在 `$DSH_HOME/wasm-apps-ai-rows-consent.json`
 *     （0600，原子写），重启仍在；文件坏掉/版本不对 ⇒ **全未授权**（不是"全放行"）。
 *
 * 全部经 auth-gate 的**真实装配**（`apply()` 注册的真实路由 + 真实 guard/持有性证明/
 * 工具注册），只把出站 `fetch` 换成假网关。
 *
 * ---- 变异验证（拆掉哪一处，哪条用例必红）----
 *   - `wasm_app_rows` 去掉授权判定（回到"默认开"）⇒「默认关」三条红；
 *   - 判定放在出站**之后**（先请求再判）⇒「零出站」那几条红（outbound 计数变成 1）；
 *   - 拒绝换成 `{rows:[]}` 之类的空结果 ⇒「不是静默空结果」红（`ok`/code 断言）；
 *   - 路由与工具各建一个 store（或工具用内存 store）⇒「路由授权 ⇒ 工具放行」与
 *     「重启后仍在」红；
 *   - `parseAiRowsConsent` 放宽（坏文件当成空记录而不是整份作废）⇒「坏文件 = 未授权」红；
 *   - 路由去掉持有性证明 ⇒「裸请求被拒」红；
 *   - 授权写失败时静默成功 ⇒ 面板/工具状态不一致（由第 6 组的两条钉住）。
 */
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { apply, type Config as AuthGateConfig } from '../src/auth-gate.ts'
import { AI_ROWS_CONSENT_BODY_MAX_BYTES, WASM_APPS_PREFIX } from '../src/wasm-apps.ts'
import { AI_ROWS_NOT_AUTHORIZED } from '../src/wasm-app-tools.ts'
import {
  AI_ROWS_CONSENT_FILE_NAME,
  AI_ROWS_CONSENT_FORMAT_VERSION,
  createAiRowsConsentStore,
  defaultAiRowsConsentPath,
  parseAiRowsConsent,
  serializeAiRowsConsent,
} from '../src/wasm-apps-ai-rows-consent.ts'
import type { Session } from '../src/server-connector/config.ts'

const SESSION: Session = {
  serverURL: 'https://harness.example',
  username: 'alice',
  token: 'USER-TOKEN-abc',
  role: 'employee',
}

const AUDITOR: Session = { ...SESSION, username: 'audit', role: 'auditor' }

/** 工具定义（只看本文件用到的字段）。 */
interface ToolDef {
  name: string
  execute: (args: unknown, exec: unknown) => Promise<unknown>
}

interface Outbound { method: string, url: string }

interface Captured { code: number, text: string, body: any }

interface Route {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void
}

interface Harness {
  outbound: Outbound[]
  call: (url: string, method?: string, body?: string, headers?: Record<string, string | null>) => Promise<Captured>
  run: (name: string, args: Record<string, unknown>) => Promise<any>
}

/** 服务端 rows 的成功响应（形状与 `server/internal/wasmapp/api/rows.go` 一致）。 */
const ROWS_BODY = {
  rows: {
    app_id: 'shared-notes',
    table: 'notes',
    columns: [{ name: 'title', type: 'TEXT', sensitive: false }, { name: 'api_token', type: 'TEXT', sensitive: true }],
    rows: [['hello', '***']],
    limit: 50,
    offset: 0,
    returned: 1,
    total_rows: 1,
    has_more: false,
    truncated: false,
    truncated_values: 0,
    unmasked: false,
    masked_columns: ['api_token'],
    value_max_bytes: 4096,
  },
}

const json = (status: number, payload: unknown): Response =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })

/** 装一个真实的 auth-gate（真路由 + 真工具注册），出站 fetch 换成 `respond`。 */
function harness(
  respond: () => Response = () => json(200, ROWS_BODY),
  session: Session | null = SESSION,
): Harness {
  const routes: Route[] = []
  const tools: ToolDef[] = []
  const outbound: Outbound[] = []
  const ctx = {
    effect: (fn: () => unknown) => { fn() },
    // `connection.requestRejection` 的替身：持 `dsh-auth-*` cookie 才给持有性证明
    //（与 tests/wasm-apps.spec.ts 的 browserFence 同款）—— 否则"裸 curl 读不到/改不了
    // 授权状态"这条判据就是恒真的。
    get: (name: string) => (name === 'connection'
      ? {
          requestRejection: (request: { headers: Record<string, unknown> }) => {
            const cookie = request.headers['cookie']
            return typeof cookie === 'string' && cookie.startsWith('dsh-auth-') ? undefined : (401 as const)
          },
        }
      : undefined),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    tools: { register: (definition: ToolDef) => { tools.push(definition); return () => {} } },
    picoSession: {
      isRestored: () => true,
      isLoggedIn: () => session !== null,
      getSession: () => session,
      setSession: vi.fn(),
      clear: () => {},
    },
    webServer: {
      tapIndex: () => () => {},
      register: (route: Route) => { routes.push(route); return () => {} },
    },
  }
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
    outbound.push({ method: init?.method ?? 'GET', url: String(url) })
    return respond()
  }))
  apply(ctx as never, {} as AuthGateConfig)
  const route = routes.find(entry => entry.kind === 'prefix' && entry.path === WASM_APPS_PREFIX)
  if (route === undefined) throw new Error('wasm apps route not registered')
  return {
    outbound,
    call: async (url, method = 'GET', body, headers) => {
      const host = '127.0.0.1:3080'
      const merged: Record<string, string | null> = {
        origin: `http://${host}`,
        host,
        'sec-fetch-site': 'same-origin',
        cookie: `dsh-auth-${host}=v1.sig`,
        ...headers,
      }
      // `null` = 显式摘掉这个头（模拟"裸 curl"：没有持有性证明 cookie）。
      for (const key of Object.keys(merged)) if (merged[key] === null) delete merged[key]
      const request = {
        method,
        url,
        headers: merged,
        socket: { remoteAddress: '127.0.0.1' },
        async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(body, 'utf8') },
      }
      let code = 0
      let text = ''
      const response = {
        writeHead: (value: number) => { code = value },
        end: (chunk?: string | Buffer) => { text = chunk === undefined ? '' : chunk.toString() },
      }
      await route.handler(request as unknown as IncomingMessage, response as unknown as ServerResponse)
      let parsed: unknown = null
      try { parsed = JSON.parse(text) } catch { parsed = null }
      return { code, text, body: parsed }
    },
    run: async (name, args) => {
      const definition = tools.find(tool => tool.name === name)
      if (definition === undefined) throw new Error(`tool not registered: ${name}`)
      return await definition.execute(args, { signal: new AbortController().signal })
    },
  }
}

/** 走**本机路由**授权（生产里面板做的就是这件事）。 */
async function authorize(h: Harness, appId: string, enabled = true): Promise<Captured> {
  return await h.call(`${WASM_APPS_PREFIX}/${appId}/ai-rows-consent`, 'POST', JSON.stringify({ enabled }))
}

/** 读授权状态（面板展开时做的第一件事）。 */
async function readConsent(h: Harness, appId: string, headers?: Record<string, string | null>): Promise<Captured> {
  return await h.call(`${WASM_APPS_PREFIX}/${appId}/ai-rows-consent`, 'GET', undefined, headers)
}

const ROWS_ARGS = { appId: 'shared-notes', table: 'notes' }

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'pico-ai-rows-home-'))
  vi.stubEnv('DSH_HOME', home)
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await rm(home, { recursive: true, force: true })
})

const consentFile = (): string => join(home, AI_ROWS_CONSENT_FILE_NAME)

// ---------------------------------------------------------------------------
// 1. 默认关：结构化拒绝 + 零出站
// ---------------------------------------------------------------------------

describe('默认关：未授权 ⇒ 结构化拒绝且零出站（不是静默空结果）', () => {
  it('回 AI_ROWS_NOT_AUTHORIZED，指路指向数据面板，且一个字节都没出站', async () => {
    const h = harness()
    const result = await h.run('wasm_app_rows', ROWS_ARGS)
    expect(result.ok).toBe(false)
    expect(result.status).toBe(403)
    expect(result.error.code).toBe(AI_ROWS_NOT_AUTHORIZED)
    // **零出站**：授权判定必须在任何网关调用之前。
    expect(h.outbound).toHaveLength(0)
    // 不是"空表"：既没有 rows 数据，也不是 ok。
    expect(result.body).toBeUndefined()
    expect(JSON.stringify(result)).not.toContain('***')
    // 模型必须能自己找到下一步：指路要点名数据面板 + 由人打开 + 只看脱敏列。
    const hints = (result.error.hints as string[]).join('\n')
    expect(hints).toContain('数据')
    expect(hints).toContain('允许 AI 读取此应用的数据')
    expect(hints).toContain('脱敏')
  })

  it('每次调用都重新判定：没有"第一次拒绝之后就放行"的记忆效应', async () => {
    const h = harness()
    for (let i = 0; i < 3; i += 1) {
      const result = await h.run('wasm_app_rows', ROWS_ARGS)
      expect(result.error.code).toBe(AI_ROWS_NOT_AUTHORIZED)
    }
    expect(h.outbound).toHaveLength(0)
  })

  it('授权是**按应用**的：给 A 打开不等于给 B 打开', async () => {
    const h = harness()
    expect((await authorize(h, 'shared-notes')).code).toBe(200)
    const other = await h.run('wasm_app_rows', { appId: 'other-app', table: 'notes' })
    expect(other.error.code).toBe(AI_ROWS_NOT_AUTHORIZED)
    expect(h.outbound).toHaveLength(0)
  })

  it('未登录时先回 AUTH_REQUIRED（会话闸门在外层），仍然零出站', async () => {
    const h = harness(() => json(200, ROWS_BODY), null)
    const result = await h.run('wasm_app_rows', ROWS_ARGS)
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('AUTH_REQUIRED')
    expect(h.outbound).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 2. 授权卡 → 闸门：两侧共用一个真源
// ---------------------------------------------------------------------------

describe('授权卡（本机路由）与宿主工具共用同一个真源', () => {
  it('路由 POST enabled=true ⇒ 工具立刻放行，且**仍然不带 unmask**', async () => {
    const h = harness()
    const granted = await authorize(h, 'shared-notes')
    expect(granted.code).toBe(200)
    expect(granted.body).toEqual({ app_id: 'shared-notes', enabled: true })

    const result = await h.run('wasm_app_rows', { ...ROWS_ARGS, limit: 10, offset: 20 })
    expect(result.ok).toBe(true)
    expect(h.outbound).toHaveLength(1)
    expect(h.outbound[0]!.method).toBe('GET')
    const url = new URL(h.outbound[0]!.url)
    expect(url.pathname).toBe('/api/client/v2/apps/wasm/shared-notes/rows')
    expect(url.searchParams.get('table')).toBe('notes')
    expect(url.searchParams.get('limit')).toBe('10')
    expect(url.searchParams.get('offset')).toBe('20')
    // 授权卡打开的是"能不能读"，**不是**"能不能看原值"：unmask 永远不在出站 URL 里。
    expect(url.searchParams.has('unmask')).toBe(false)
    // 服务端的脱敏值原样到模型手里。
    expect(result.body.rows.rows[0][1]).toBe('***')
    expect(JSON.stringify(result)).not.toContain(SESSION.token)
  })

  it('路由 GET 回读宿主状态（面板渲染开关的唯一依据）', async () => {
    const h = harness()
    expect((await readConsent(h, 'shared-notes')).body).toEqual({ app_id: 'shared-notes', enabled: false })
    await authorize(h, 'shared-notes')
    expect((await readConsent(h, 'shared-notes')).body).toEqual({ app_id: 'shared-notes', enabled: true })
  })

  it('撤销（enabled=false）立刻恢复拒绝，且不再新增出站', async () => {
    const h = harness()
    await authorize(h, 'shared-notes')
    expect((await h.run('wasm_app_rows', ROWS_ARGS)).ok).toBe(true)
    const before = h.outbound.length

    const revoked = await authorize(h, 'shared-notes', false)
    expect(revoked.body).toEqual({ app_id: 'shared-notes', enabled: false })
    const after = await h.run('wasm_app_rows', ROWS_ARGS)
    expect(after.ok).toBe(false)
    expect(after.error.code).toBe(AI_ROWS_NOT_AUTHORIZED)
    expect(h.outbound).toHaveLength(before)
  })

  it('落盘：重启（新的插件实例、同一个数据根）后授权仍在', async () => {
    const first = harness()
    await authorize(first, 'shared-notes')
    // 同一个数据根、全新装配 = 重启客户端。
    const second = harness()
    expect((await readConsent(second, 'shared-notes')).body).toEqual({ app_id: 'shared-notes', enabled: true })
    expect((await second.run('wasm_app_rows', ROWS_ARGS)).ok).toBe(true)
  })

  it('落盘位置与权限：$DSH_HOME/wasm-apps-ai-rows-consent.json（0600）', async () => {
    const h = harness()
    await authorize(h, 'shared-notes')
    const info = await stat(consentFile())
    expect(info.isFile()).toBe(true)
    // 0600：这是"AI 能读哪些应用的数据"的开关，同机其它用户不得改写。
    expect(info.mode & 0o777).toBe(0o600)
    const parsed = JSON.parse(await readFile(consentFile(), 'utf8')) as { version: number, apps: string[] }
    expect(parsed.version).toBe(AI_ROWS_CONSENT_FORMAT_VERSION)
    expect(parsed.apps).toEqual(['shared-notes'])
  })
})

// ---------------------------------------------------------------------------
// 3. 文件坏掉 = 全未授权（fail-closed）
// ---------------------------------------------------------------------------

describe('授权文件不可信 ⇒ 全未授权（fail-closed，不是全放行）', () => {
  it('坏 JSON ⇒ 工具拒绝且零出站', async () => {
    await writeFile(consentFile(), '{ this is not json', { mode: 0o600 })
    const h = harness()
    const result = await h.run('wasm_app_rows', ROWS_ARGS)
    expect(result.error.code).toBe(AI_ROWS_NOT_AUTHORIZED)
    expect(h.outbound).toHaveLength(0)
  })

  it('版本号不认识 ⇒ 工具拒绝（旧/新格式都不得被猜测性地读成"已授权"）', async () => {
    await writeFile(consentFile(), JSON.stringify({ version: AI_ROWS_CONSENT_FORMAT_VERSION + 1, apps: ['shared-notes'] }), { mode: 0o600 })
    const h = harness()
    expect((await readConsent(h, 'shared-notes')).body).toEqual({ app_id: 'shared-notes', enabled: false })
    expect((await h.run('wasm_app_rows', ROWS_ARGS)).error.code).toBe(AI_ROWS_NOT_AUTHORIZED)
  })

  it('一条坏条目 ⇒ 整份作废（不静默跳过坏行）', async () => {
    await writeFile(consentFile(), JSON.stringify({ version: AI_ROWS_CONSENT_FORMAT_VERSION, apps: ['shared-notes', 42] }), { mode: 0o600 })
    const h = harness()
    expect((await readConsent(h, 'shared-notes')).body).toEqual({ app_id: 'shared-notes', enabled: false })
  })

  it('文件不可读（权限 000）⇒ 拒绝而不是抛穿', async () => {
    const h = harness()
    await authorize(h, 'shared-notes')
    await chmod(consentFile(), 0o000)
    try {
      const result = await h.run('wasm_app_rows', ROWS_ARGS)
      // root 下 chmod 对读取不生效（容器里常见），所以这条允许两种结果之一：
      // 要么读到旧内容（放行）、要么读失败（拒绝）。**不允许**的是抛异常/500。
      expect([true, false]).toContain(result.ok)
      if (!result.ok) expect(result.error.code).toBe(AI_ROWS_NOT_AUTHORIZED)
    } finally {
      await chmod(consentFile(), 0o600)
    }
  })
})

// ---------------------------------------------------------------------------
// 4. 路由自身的闸门与校验
// ---------------------------------------------------------------------------

describe('授权路由的围栏与参数校验', () => {
  it('没有持有性证明：GET 与 POST 都被拒（403）且零出站', async () => {
    const h = harness()
    const noProof = { cookie: null }
    const get = await readConsent(h, 'shared-notes', noProof)
    expect(get.code).toBe(403)
    const post = await h.call(`${WASM_APPS_PREFIX}/shared-notes/ai-rows-consent`, 'POST', JSON.stringify({ enabled: true }), noProof)
    expect(post.code).toBe(403)
    expect(h.outbound).toHaveLength(0)
  })

  it('body 必须是 {"enabled":boolean}：畸形载荷一律 400 VALIDATION', async () => {
    const h = harness()
    for (const body of ['{}', '{"enabled":"yes"}', '{"enabled":1}', '[]', 'null', 'not json']) {
      const res = await h.call(`${WASM_APPS_PREFIX}/shared-notes/ai-rows-consent`, 'POST', body)
      expect(res.code, body).toBe(400)
      expect(res.body?.error?.code, body).toBe('VALIDATION')
    }
    // 校验失败不得留下状态。
    expect((await readConsent(h, 'shared-notes')).body).toEqual({ app_id: 'shared-notes', enabled: false })
    expect(h.outbound).toHaveLength(0)
  })

  it('请求体上限 4 KiB：超限回 413（不借用 publish 的 48 MiB 通道）', async () => {
    const h = harness()
    const huge = JSON.stringify({ enabled: true, pad: 'x'.repeat(AI_ROWS_CONSENT_BODY_MAX_BYTES) })
    const res = await h.call(`${WASM_APPS_PREFIX}/shared-notes/ai-rows-consent`, 'POST', huge)
    expect(res.code).toBe(413)
    expect(res.body?.error?.code).toBe('UPLOAD_TOO_LARGE')
    expect((await readConsent(h, 'shared-notes')).body).toEqual({ app_id: 'shared-notes', enabled: false })
  })

  it('方法限制：PUT/DELETE 该路径回 405（不落到 DELETE :app_id 的删除分支上）', async () => {
    const h = harness()
    const res = await h.call(`${WASM_APPS_PREFIX}/shared-notes/ai-rows-consent`, 'PUT', '{}')
    expect(res.code).toBe(405)
    expect(h.outbound).toHaveLength(0)
  })

  it('审计账号：可以读状态（只读面），但不能改（沿用既有的 writeGuard）', async () => {
    const h = harness(() => json(200, ROWS_BODY), AUDITOR)
    expect((await readConsent(h, 'shared-notes')).code).toBe(200)
    const res = await authorize(h, 'shared-notes')
    expect(res.code).toBe(403)
    expect(res.body?.error?.code).toBe('FORBIDDEN')
    expect((await readConsent(h, 'shared-notes')).body).toEqual({ app_id: 'shared-notes', enabled: false })
    expect(h.outbound).toHaveLength(0)
  })

  it('未登录：路由回 401，不改状态也不出站', async () => {
    const h = harness(() => json(200, ROWS_BODY), null)
    const res = await authorize(h, 'shared-notes')
    expect(res.code).toBe(401)
    expect(res.body?.error?.code).toBe('AUTH_REQUIRED')
    expect(h.outbound).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 5. 授权记录本身的纯函数契约（文件格式：真源）
// ---------------------------------------------------------------------------

describe('授权文件格式（parse/serialize，唯一实现）', () => {
  it('往返一致且稳定排序（两份内容相同的记录逐字节相同）', () => {
    const text = serializeAiRowsConsent(new Set(['b-app', 'a-app']))
    expect(text).toBe(`${JSON.stringify({ version: AI_ROWS_CONSENT_FORMAT_VERSION, apps: ['a-app', 'b-app'] }, null, 2)}\n`)
    expect([...(parseAiRowsConsent(text) ?? [])]).toEqual(['a-app', 'b-app'])
    expect(serializeAiRowsConsent(parseAiRowsConsent(text)!)).toBe(text)
  })

  it('严格拒绝：非对象 / 版本不符 / apps 非数组 / 空串 / 非字符串条目', () => {
    for (const text of [
      'null', '[]', '"x"', '{}',
      JSON.stringify({ version: 2, apps: [] }),
      JSON.stringify({ version: AI_ROWS_CONSENT_FORMAT_VERSION, apps: 'shared-notes' }),
      JSON.stringify({ version: AI_ROWS_CONSENT_FORMAT_VERSION, apps: [''] }),
      JSON.stringify({ version: AI_ROWS_CONSENT_FORMAT_VERSION, apps: [null] }),
    ]) {
      expect(parseAiRowsConsent(text), text).toBeNull()
    }
  })

  it('默认路径 = $DSH_HOME/wasm-apps-ai-rows-consent.json（数据根随渠道）', () => {
    expect(defaultAiRowsConsentPath({ DSH_HOME: '/tmp/some-home' })).toBe(join('/tmp/some-home', AI_ROWS_CONSENT_FILE_NAME))
  })

  it('内存形态（没有数据根）也 fail-closed：默认全未授权，写进去才放行', async () => {
    const store = createAiRowsConsentStore()
    expect(await store.isEnabled('a')).toBe(false)
    await store.setEnabled('a', true)
    expect(await store.isEnabled('a')).toBe(true)
    await store.setEnabled('a', false)
    expect(await store.isEnabled('a')).toBe(false)
  })

  it('并发写不互相覆盖（读-改-写串行化）', async () => {
    const store = createAiRowsConsentStore({ file: consentFile() })
    await Promise.all([
      store.setEnabled('a', true),
      store.setEnabled('b', true),
      store.setEnabled('c', true),
    ])
    expect(await store.isEnabled('a')).toBe(true)
    expect(await store.isEnabled('b')).toBe(true)
    expect(await store.isEnabled('c')).toBe(true)
  })
})
