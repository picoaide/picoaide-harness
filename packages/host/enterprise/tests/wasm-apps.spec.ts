/**
 * WASM 应用平台**客户端侧创作链路**的契约测试
 * （设计基线 `docs/planning/2026-09-17-wasm-app-platform.md` §4.2 / §6.2 / §8 第 10 项、
 * 验证矩阵 §10.5 第 58 项）。
 *
 * 覆盖的是「服务端已经对了、客户端却用不了」这一段：本地路由的方法分发与写面围栏、
 * 业务错误信封（`code`/`details`/`hints`）原样透传、90 s 超时、>8 MiB 自动分片与
 * **续传**（只补缺失片）、`wasm_path` 的读取面校验。
 *
 * 全部经由 auth-gate 的**真实装配**（`apply()` 注册的真实路由 + 真实的
 * guard/requireWriteProof/collectBody），只把出站 `fetch` 换成假网关 —— 因此
 * "写面要不要持有性证明""错误信封丢没丢"这类断言测的是产品代码，不是测试替身。
 *
 * ---- 变异验证（把闸门改回危险实现时，哪条用例必红）----
 *
 *   - `CLIENT_UPLOAD_TIMEOUT_MS` 改回 30_000（既有技能上传的值）
 *     → 「90 秒预算」两条用例红（30 s 时就 abort 了）；
 *   - `CLIENT_UPLOAD_TIMEOUT_MS` 改成 ≤ `SERVER_READ_TIMEOUT_MS`
 *     → 「超时必须大于服务端读取超时」红（§10.5 第 58 项）；
 *   - 分片判定从 `base64Length(bytes) > 8 MiB` 改成恒 false（永远直传）
 *     → 「>8 MiB 走 uploads 端点」红；
 *   - 分片判定改成恒 true → 「刚好 8 MiB 走直传」红（边界）；
 *   - 续传改成"忽略 received[] 从 0 重传" → 「只补缺失片」红；
 *   - 分片失败后不重新拉 received[] / 不重试 → 「失败的片会重试」红；
 *   - 失败时直接 `gatewayError`（或重新序列化错误体） → 「服务端错误信封原样透传」红
 *     （hints/details 会消失）；
 *   - `readWasmFromPath` 去掉 realpath 或改成字符串前缀比较
 *     → 「符号链接逃逸被拒」「越界路径被拒」红；
 *   - 写面去掉 `requireWriteProof` → 「POST 缺持有性证明被拒（403）」红；
 *   - catalog 自己按 `access`/`enabled` 过滤（或补字段） → 「目录原样透传（客户端不二次过滤）」红；
 *   - catalog 重新加回入口链接补全（旧 `absolutizeEntryURL` 那套）→
 *     「目录逐字节透传：**不做**入口链接补全」红（相对地址会变成绝对地址，实测见 R2-L1-1）；
 *   - `readRoots` 的允许面改回整个数据根（`dataRoot` 取代 `appsRoot`）
 *     → 「session.json / .credentials.yaml / data/master.key 被拒且零出站」三条红（FIX-39）；
 *   - `decodePathSegments` 去掉 try/catch（改回裸 `decodeURIComponent`）
 *     → 「畸形百分号转义」两条红（异常抛穿 handler，响应退化成无 body 的 400，FIX-40）；
 *   - 去掉"必须是普通文件"的 `stat().isFile()` 判定
 *     → 「目录不是产物」红（EISDIR 抛穿，FIX-41）；
 *   - 分片开会话字段改回 `{app_id,size,chunks}`、或 complete 带 `app_id`/`version`
 *     → 「分片上传字段契约」整组红（FIX-43，与服务端 upload.go 漂移）；
 *   - 分片 PUT 对确定性 4xx 也重试（`isRetryableChunkStatus` 恒 true，P2-8 前的实现）
 *     → 「确定性 4xx 只发 1 次 PUT、0 次 GET、原样回 code」红；
 *   - `resolveWasmSource` 的 base64 分支去掉体积闸门（P1-10 前的实现）
 *     → 「base64 载荷超过 32 MiB 本地就拒」红；
 *   - 目录行丢掉 `current_version`（P1-4 前的实现）→ 「current_version 原样穿过」红。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, type Config as AuthGateConfig } from '../src/auth-gate.ts'
import {
  base64Length,
  CLIENT_UPLOAD_LIMITS,
  CHUNKED_PUBLISH_BUDGET_MS,
  CLIENT_UPLOAD_TIMEOUT_MS,
  isInsideRoot,
  isRetryableChunkStatus,
  decodePathSegments,
  planChunks,
  readRoots,
  SERVER_READ_TIMEOUT_MS,
  UPLOAD_BODY_MAX_BYTES,
  UPLOAD_CHUNK_MAX_BYTES,
  UPLOAD_CHUNK_MIN_BYTES,
  WASM_MAX_BYTES,
} from '../src/wasm-apps.ts'
import type { Session } from '../src/server-connector/config.ts'

const WASM_APPS_PREFIX = '/api/pico/apps/wasm'

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

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE'

function fakeReq(
  url: string,
  method: Method = 'GET',
  body?: string,
  headers: Record<string, string | null> = {},
): IncomingMessage {
  const host = '127.0.0.1:3080'
  const merged: Record<string, string | null> = {
    origin: `http://${host}`,
    host,
    'sec-fetch-site': 'same-origin',
    cookie: `dsh-auth-${host}=v1.signature`,
    ...headers,
  }
  // `null` = 显式摘掉这个头（模拟"裸 curl"/"浏览器页面没有持有性证明 cookie"）。
  for (const key of Object.keys(merged)) if (merged[key] === null) delete merged[key]
  const request = {
    method,
    url,
    headers: merged,
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(body, 'utf8')
    },
  }
  return request as unknown as IncomingMessage
}

interface Captured {
  code: number
  text: string
  body: any
}

function fakeRes(): { res: ServerResponse, read: () => Captured } {
  let code = 0
  let text = ''
  const res = {
    writeHead: (value: number) => { code = value },
    end: (chunk?: string | Buffer) => {
      text = chunk === undefined ? '' : chunk.toString()
    },
  } as unknown as ServerResponse
  return {
    res,
    read: () => {
      let body: unknown = null
      try { body = JSON.parse(text) } catch { body = null }
      return { code, text, body }
    },
  }
}

/** `connection.requestRejection` 的替身：持 `dsh-auth-*` cookie 才给持有性证明。 */
function browserFence(): { requestRejection: (r: { headers: Record<string, unknown> }) => 401 | undefined } {
  return {
    requestRejection: (request: { headers: Record<string, unknown> }) => {
      const cookie = request.headers['cookie']
      return typeof cookie === 'string' && cookie.startsWith('dsh-auth-') ? undefined : (401 as const)
    },
  }
}

/** 出站请求记录（顺序即真实调用顺序）。 */
interface Outbound {
  method: string
  url: string
  body: string
  contentType: string
  signal: AbortSignal | undefined
}

interface Harness {
  routes: Route[]
  outbound: Outbound[]
  cleared: number
  /** 经 `ctx.tools.register` 登记的宿主工具（真实装配路径，见 auth-gate 的 effect）。 */
  tools: Array<{ name: string, timeoutMs?: number }>
  call: (url: string, method?: Method, body?: string, headers?: Record<string, string | null>) => Promise<Captured>
}

/**
 * 装一个真实的 auth-gate，并把出站 fetch 换成 `respond`。
 * @param respond - 假网关：按 (method, path) 返回 Response；可用断言驱动分片/续传。
 * @param session - 员工会话；null = 未登录。
 */
function harness(
  respond: (
    method: string,
    path: string,
    init: { body: string, contentType: string, signal?: AbortSignal | undefined },
  ) => Response | Promise<Response>,
  session: Session | null = SESSION,
): Harness {
  const routes: Route[] = []
  const outbound: Outbound[] = []
  const tools: Array<{ name: string, timeoutMs?: number }> = []
  const state = { cleared: 0 }
  const ctx = {
    effect: (fn: () => unknown) => { fn() },
    get: (name: string) => (name === 'connection' ? browserFence() : undefined),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    // `tools` 服务在场（生产由 `inject: ['tools']` 保证）：宿主工具面（wasm_app_*）
    // 就是在这一条真实装配路径上注册的，因此这个替身让"注册了没有"可断言。
    tools: {
      register: (definition: { name: string, timeoutMs?: number }) => { tools.push(definition); return () => {} },
    },
    picoSession: {
      isRestored: () => true,
      isLoggedIn: () => session !== null,
      getSession: () => session,
      setSession: vi.fn(),
      clear: () => { state.cleared += 1 },
    },
    webServer: {
      tapIndex: () => () => {},
      register: (route: Route) => { routes.push(route); return () => {} },
    },
  }
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
    const href = String(url)
    const method = init?.method ?? 'GET'
    const headers = (init?.headers ?? {}) as Record<string, string>
    const contentType = headers['Content-Type'] ?? ''
    // 记录口径：字符串 body 原样；二进制 body 按 content-type 还原（JSON 解码成文本、
    // 分片按 base64 记录以便逐片解码对拍）。
    const body = typeof init?.body === 'string'
      ? init.body
      : init?.body === undefined
        ? ''
        : contentType.includes('json')
          ? Buffer.from(init.body as Uint8Array).toString('utf8')
          : Buffer.from(init.body as Uint8Array).toString('base64')
    outbound.push({
      method,
      url: href,
      body,
      contentType: headers['Content-Type'] ?? '',
      signal: init?.signal ?? undefined,
    })
    return await respond(method, href, { body, contentType, signal: init?.signal ?? undefined })
  }))
  apply(ctx as never, {} as AuthGateConfig)
  const route = routes.find(r => r.kind === 'prefix' && r.path === WASM_APPS_PREFIX)
  if (route === undefined) throw new Error('wasm apps route not registered')
  return {
    routes,
    outbound,
    tools,
    get cleared() { return state.cleared },
    call: async (url: string, method: Method = 'GET', body?: string, headers?: Record<string, string | null>) => {
      const { res, read } = fakeRes()
      await route.handler(fakeReq(url, method, body, headers), res)
      return read()
    },
  }
}

const json = (status: number, payload: unknown): Response =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })

/** 服务端 §8 的业务错误信封（第一消费者是 AI：details/hints 必须原样到达）。 */
const businessError = json(403, {
  error: {
    code: 'IMPORT_NOT_ALLOWED',
    message: '导入面不在白名单内',
    details: { symbol: 'wasi_snapshot_preview1.sock_open', expected: null, actual: 'i32i32_i32' },
    hints: ['按 skill 提供的 read_request()/write_response() 样板生成代码', '编译目标必须是 wasm32-wasip1'],
  },
})

let home: string
let workspace: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'pico-wasm-apps-home-'))
  workspace = await mkdtemp(join(tmpdir(), 'pico-wasm-apps-ws-'))
  vi.stubEnv('DSH_HOME', home)
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.useRealTimers()
  await rm(home, { recursive: true, force: true })
  await rm(workspace, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 1. 客户端常量与服务端/设计文档同源（§10.5 第 58 项）
// ---------------------------------------------------------------------------

describe('客户端上限常量与设计基线同源（§4.2 / §10.5 第 58 项）', () => {
  /** 设计文档是唯一权威：数值必须逐字出现在文档里（文档改了这里没改 ⇒ 红）。 */
  const designDoc = readFileSync(
    fileURLToPath(new URL('../../../../docs/planning/2026-09-17-wasm-app-platform.md', import.meta.url)),
    'utf8',
  )

  it('四个数值与设计文档逐字一致（32 MiB / 48 MiB / 8 MiB / 90 s）', () => {
    expect(designDoc).toContain('**32 MiB**')
    expect(designDoc).toContain('**48 MiB**')
    expect(designDoc).toContain('**客户端上传超时** | **90 s**')
    expect(designDoc).toContain('>8 MiB 走**分片 + 续传**')
    expect(WASM_MAX_BYTES).toBe(32 * 1024 * 1024)
    expect(UPLOAD_BODY_MAX_BYTES).toBe(48 * 1024 * 1024)
    expect(UPLOAD_CHUNK_MAX_BYTES).toBe(8 * 1024 * 1024)
    expect(CLIENT_UPLOAD_TIMEOUT_MS).toBe(90_000)
    expect(CLIENT_UPLOAD_LIMITS.wasmMaxBytes).toBe(WASM_MAX_BYTES)
    expect(CLIENT_UPLOAD_LIMITS.uploadChunkMaxBytes).toBe(UPLOAD_CHUNK_MAX_BYTES)
    // 冻结快照：运行期改写它会让"本地提前拒绝"与"服务端裁决"给出矛盾答案。
    expect(Object.isFrozen(CLIENT_UPLOAD_LIMITS)).toBe(true)
  })

  it('客户端超时必须大于服务端读取超时（§4.2 的配置断言）', () => {
    expect(SERVER_READ_TIMEOUT_MS).toBe(60_000)
    expect(CLIENT_UPLOAD_TIMEOUT_MS).toBeGreaterThan(SERVER_READ_TIMEOUT_MS)
  })

  it('分片下限来自 limits.go，且均分策略不会产生低于下限的片', () => {
    expect(UPLOAD_CHUNK_MIN_BYTES).toBe(64 * 1024)
    // 真实触发区间：base64 > 8 MiB ⇒ 二进制 > 6 MiB。
    for (const total of [6 * 1024 * 1024 + 1, 8 * 1024 * 1024, 20 * 1024 * 1024, 32 * 1024 * 1024]) {
      const slices = planChunks(total)
      expect(slices.length).toBeGreaterThan(0)
      for (const slice of slices) {
        const size = slice.end - slice.start
        expect(size).toBeLessThanOrEqual(UPLOAD_CHUNK_MAX_BYTES)
        expect(size).toBeGreaterThanOrEqual(UPLOAD_CHUNK_MIN_BYTES)
      }
      // 全覆盖、无空洞、确定性（续传靠下标，切法必须稳定）。
      expect(slices[0]!.start).toBe(0)
      expect(slices[slices.length - 1]!.end).toBe(total)
      for (let i = 1; i < slices.length; i += 1) expect(slices[i]!.start).toBe(slices[i - 1]!.end)
      expect(planChunks(total)).toEqual(slices)
    }
    expect(planChunks(0)).toEqual([])
  })

  it('base64Length 与实际编码长度一致（分片判定用它，不能拍脑袋）', () => {
    for (const size of [0, 1, 2, 3, 4, 5, 1023, 1024, 6 * 1024 * 1024 + 1]) {
      const buf = Buffer.alloc(size, 7)
      expect(base64Length(size)).toBe(buf.toString('base64').length)
    }
  })

  /**
   * P2-8：分片 PUT 的**可重试**判据。
   *
   * 变异验证：把 `isRetryableChunkStatus` 改成恒 `true`（旧行为：任何非 2xx 都重试）
   * ⇒ 「确定性 4xx 是终态」红；改成恒 `false` ⇒ 「5xx / 408 / 429 可重试」红。
   */
  it('分片失败的可重试判定：5xx / 408 / 429 可重试，其余 4xx 是终态', () => {
    for (const status of [500, 502, 503, 504]) expect(isRetryableChunkStatus(status), String(status)).toBe(true)
    expect(isRetryableChunkStatus(408)).toBe(true)
    expect(isRetryableChunkStatus(429)).toBe(true)
    // 确定性 4xx：重发同一片只会得到同一个答案 —— 终态，原样回服务端信封。
    for (const status of [400, 401, 403, 404, 409, 411, 413, 422]) {
      expect(isRetryableChunkStatus(status), String(status)).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// 2. 路由装配 / 方法分发 / 写面围栏
// ---------------------------------------------------------------------------

describe('本地路由：装配、方法分发、写面持有性证明', () => {
  it('auth-gate 注册了 /api/pico/apps/wasm 前缀路由（方法分发在 handler 内）', () => {
    const h = harness(() => json(200, {}))
    const registered = h.routes.filter(r => r.path === WASM_APPS_PREFIX)
    expect(registered).toHaveLength(1)
    expect(registered[0]!.kind).toBe('prefix')
  })

  it('同一次装配也注册了宿主工具面（AI 的发布路径与路由共用编排）', () => {
    const h = harness(() => json(200, {}))
    // 六个名字逐个钉死（写死在这里是**有意**的：这条断言的用途就是"注册面少了/多了
    // 一个工具立刻红"，改成读 WASM_APP_TOOL_NAMES 会让它变成自证）。
    expect(h.tools.map(t => t.name).sort()).toEqual([
      'wasm_app_diagnostics',
      'wasm_app_list',
      'wasm_app_publish',
      'wasm_app_rows',
      'wasm_app_schema',
      'wasm_app_validate',
    ])
    // 预算序关系：工具 deadline 必须**严格大于**出站预算（90 s），否则上游超时
    // 策略会把带 hints 的结构化结果整条换成笼统的 "tool call timed out"。
    for (const tool of h.tools) expect(tool.timeoutMs).toBeGreaterThan(CLIENT_UPLOAD_TIMEOUT_MS)
  })

  it('未知子路径 / 未知方法明确失败（不静默 200）', async () => {
    const h = harness(() => json(200, { ok: true }))
    // `/:app_id` 只有 DELETE 一条路由 ⇒ GET 是 405（路径存在、方法不存在），
    // 未知的两段子路径才是 404。两者都不静默成功。
    expect((await h.call(`${WASM_APPS_PREFIX}/nope`)).code).toBe(405)
    expect((await h.call(`${WASM_APPS_PREFIX}/demo-tool/bogus`)).code).toBe(404)
    // 同前缀但不同路径（`/wasmfoo`）必须按段边界判 404，不能当成 `:app_id` 回 405。
    expect((await h.call('/api/pico/apps/wasmx')).code).toBe(404)
    expect((await h.call('/api/pico/apps/wasmx/diagnostics')).code).toBe(404)
    expect((await h.call(`${WASM_APPS_PREFIX}/demo-tool/diagnostics`, 'POST')).code).toBe(405)
    expect((await h.call(`${WASM_APPS_PREFIX}/demo-tool`, 'GET')).code).toBe(405)
    expect((await h.call(WASM_APPS_PREFIX, 'POST')).code).toBe(405)
    expect((await h.call(`${WASM_APPS_PREFIX}/validate`, 'GET')).code).toBe(405)
    expect((await h.call(`${WASM_APPS_PREFIX}/publish`, 'GET')).code).toBe(405)
  })

  it('写面缺少持有性证明一律 403；GET 只读面不受影响', async () => {
    const h = harness(() => json(200, { apps: [] }))
    // 摘掉持有性证明 cookie（同机任意进程伪造 Origin 就是这个形态）：
    // 写面必须被 auth-gate 的 proofOfPossession 拒掉，且**不出站**。
    const post = await h.call(`${WASM_APPS_PREFIX}/validate`, 'POST', '{}', { cookie: null })
    expect(post.code).toBe(403)
    expect(String(post.body.error)).toContain('proof')
    expect(h.outbound).toHaveLength(0)
    // 读面（GET 目录）同一请求形态下照常放行 —— 围栏只罩写面，与技能代理同口径。
    const get = await h.call(WASM_APPS_PREFIX, 'GET', undefined, { cookie: null })
    expect(get.code).toBe(200)
    expect(h.outbound).toHaveLength(1)
  })

  it('未登录时给出 AUTH_REQUIRED 信封（而不是透传服务端错误）', async () => {
    const h = harness(() => json(200, {}), null)
    const res = await h.call(WASM_APPS_PREFIX)
    expect(res.code).toBe(401)
    expect(res.body.error.code).toBe('AUTH_REQUIRED')
    expect(h.outbound).toHaveLength(0)
  })

  it('审计账号被第二道保险挡住（§4.5）', async () => {
    const h = harness(() => json(200, {}), { ...SESSION, role: 'auditor' })
    const res = await h.call(`${WASM_APPS_PREFIX}/validate`, 'POST', '{}')
    expect(res.code).toBe(403)
    expect(res.body.error.code).toBe('FORBIDDEN')
    expect(h.outbound).toHaveLength(0)
  })

  it('作者数据面 GET 也要求持有性证明（unmask 不得被本机伪造 Origin 的 curl 读到）', async () => {
    // P1-②（2026-09-21 独立审计）：`rows` 是**唯一**返回使用者数据的只读后缀，
    // 且 `?unmask=1` 直接给原值。它曾与 schema/diagnostics 同走 `guard()`，而
    // `guard()` 自述"伪造 Origin 的 curl 也能过" ⇒ 模型一条 curl 就能把 PII 读走。
    // 判据三条，缺一不可：
    //   ① 无 cookie 的 rows 请求 ⇒ 403 且**零出站**（不是"转发后被服务端拒"）；
    //   ② 同一请求带真页面 cookie ⇒ 200 且查询串（含 unmask=1）逐字转发；
    //   ③ 其余只读后缀（schema）同一无 cookie 形态下照常放行 —— 围栏只加在
    //      "含使用者数据"的那一条上，不能顺手把作者自己的诊断面也锁死。
    const h = harness(() => json(200, { rows: [] }))
    const bare = await h.call(`${WASM_APPS_PREFIX}/demo-tool/rows?table=notes&unmask=1`, 'GET', undefined, { cookie: null })
    expect(bare.code).toBe(403)
    expect(String(bare.body.error)).toContain('proof')
    expect(h.outbound).toHaveLength(0)

    const withProof = await h.call(`${WASM_APPS_PREFIX}/demo-tool/rows?table=notes&unmask=1`)
    expect(withProof.code).toBe(200)
    expect(h.outbound).toHaveLength(1)
    expect(h.outbound[0]!.url).toBe(
      'https://harness.example/api/client/v2/apps/wasm/demo-tool/rows?table=notes&unmask=1',
    )

    const schema = await h.call(`${WASM_APPS_PREFIX}/demo-tool/schema`, 'GET', undefined, { cookie: null })
    expect(schema.code).toBe(200)
    expect(h.outbound).toHaveLength(2)
  })

  it('只有白名单后缀会转发查询串（其余路由不得把 query 带出站）', async () => {
    // P2-⑤（2026-09-21 独立审计的实跑变异）：把查询串转发从"只给 rows"扩到任意
    // 路由（含 DELETE / publish / unpublish / freeze）时，既有 62 条用例**全绿**
    // —— 也就是"query 转发白名单"这条不变量此前零防线。
    // 判据：非白名单路由带 `?search=…` 出站时 URL 里**不得**出现 `?`。
    // ⚠️ 每条非白名单调用**必须自带查询串**：不带 `?` 时这条断言恒真（第一版就是
    // 这样写的，变异实跑 64/64 全绿 = 假绿）。判据要能被打坏，输入就得带上被禁的东西。
    const h = harness(() => json(200, { ok: true }))
    // 非白名单 GET（未知后缀 / 未知应用段 / 目录）：一律不出站，查询串无从泄漏。
    expect((await h.call(`${WASM_APPS_PREFIX}/demo-tool/bogus?search=x`)).code).toBe(404)
    expect((await h.call(`${WASM_APPS_PREFIX}?search=x`)).code).toBe(200) // 目录 GET 合法
    expect(h.outbound).toHaveLength(1)
    expect(h.outbound[0]!.url).toBe('https://harness.example/api/client/v2/apps/wasm/catalog')
    // 写面 POST / DELETE 与诊断面 GET：查询串**不得**出站。
    await h.call(`${WASM_APPS_PREFIX}/demo-tool?search=x`, 'DELETE')
    await h.call(`${WASM_APPS_PREFIX}/demo-tool/publish?search=x`, 'POST', '{}')
    await h.call(`${WASM_APPS_PREFIX}/demo-tool/unpublish?search=x`, 'POST', '{}')
    await h.call(`${WASM_APPS_PREFIX}/demo-tool/freeze?search=x`, 'POST', '{}')
    await h.call(`${WASM_APPS_PREFIX}/validate?search=x`, 'POST', '{}')
    for (const o of h.outbound.slice(1)) expect(o.url).not.toContain('?')
    // 白名单后缀**必须**保留查询串（rows 的 table/limit/offset/unmask 全是服务端判据）；
    // 四个只读后缀共用同一条转发路径，因此这里同时钉住"白名单整条都带 query"。
    for (const suffix of ['rows', 'schema', 'diagnostics', 'export', 'releases']) {
      await h.call(`${WASM_APPS_PREFIX}/demo-tool/${suffix}?search=x`)
      expect(h.outbound.at(-1)!.url).toContain('?search=x')
    }
  })

  it('validate 代理到服务端 validate（POST + Bearer）', async () => {
    const h = harness(() => json(200, { ok: true, imports: [] }))
    const res = await h.call(`${WASM_APPS_PREFIX}/validate`, 'POST', JSON.stringify({ wasm_base64: 'AA==' }))
    expect(res.code).toBe(200)
    expect(h.outbound[0]!.url).toBe('https://harness.example/api/client/v2/apps/wasm/validate')
    expect(h.outbound[0]!.method).toBe('POST')
  })
})

// ---------------------------------------------------------------------------
// 3. 业务错误信封原样透传（§8：第一消费者是 AI）
// ---------------------------------------------------------------------------

describe('错误语义：业务信封原样透传，只有传输层失败才回落 gateway error', () => {
  it('服务端 details/hints 一字不改地回到调用方', async () => {
    const h = harness(() => businessError)
    const res = await h.call(`${WASM_APPS_PREFIX}/validate`, 'POST', '{}')
    expect(res.code).toBe(403)
    expect(res.body).toEqual({
      error: {
        code: 'IMPORT_NOT_ALLOWED',
        message: '导入面不在白名单内',
        details: { symbol: 'wasi_snapshot_preview1.sock_open', expected: null, actual: 'i32i32_i32' },
        hints: ['按 skill 提供的 read_request()/write_response() 样板生成代码', '编译目标必须是 wasm32-wasip1'],
      },
    })
    // 逐字节相同：重新序列化也必须无损（顺序无关，但字段一个不少）。
    expect(JSON.parse(res.text).error.hints).toHaveLength(2)
  })

  it('publish 编排失败时同样原样透传（AI 靠 code+hints 自修）', async () => {
    const h = harness(() => json(409, {
      error: {
        code: 'VERSION_NOT_NEWER',
        message: '版本号必须严格递增',
        details: { current: '1.2.0', incoming: '1.1.0' },
        hints: ['失败的发布不占号；换成 1.2.1 重发'],
      },
    }))
    const res = await h.call(
      `${WASM_APPS_PREFIX}/publish`,
      'POST',
      JSON.stringify({ app_id: 'demo-tool', version: '1.0.0', wasm_base64: Buffer.from('wasm').toString('base64') }),
    )
    expect(res.code).toBe(409)
    expect(res.body.error.code).toBe('VERSION_NOT_NEWER')
    expect(res.body.error.hints).toEqual(['失败的发布不占号；换成 1.2.1 重发'])
  })

  it('网络层失败回落 gateway error 系文案（不是业务信封）', async () => {
    const h = harness(() => { throw new Error('net::ERR_CONNECTION_REFUSED') })
    const res = await h.call(WASM_APPS_PREFIX)
    expect(res.code).toBe(502)
    expect(res.body.error.code).toBe('GATEWAY_UNAVAILABLE')
    expect(String(res.body.error.message)).toMatch(/^gateway error: /u)
  })

  it('服务端 401 清本地会话并透传（渲染层据此回登录页）', async () => {
    const h = harness(() => json(401, { error: { code: 'AUTH_FAILED', message: 'token expired' } }))
    const res = await h.call(WASM_APPS_PREFIX)
    expect(res.code).toBe(401)
    expect(h.cleared).toBe(1)
  })

  it('生命周期与只读代理保留 method / body / 路径', async () => {
    const h = harness(() => json(200, { ok: true, changed: true }))
    await h.call(`${WASM_APPS_PREFIX}/demo-tool/unpublish`, 'POST', JSON.stringify({ enabled: false }))
    await h.call(`${WASM_APPS_PREFIX}/demo-tool/freeze`, 'POST', JSON.stringify({ frozen: true }))
    await h.call(`${WASM_APPS_PREFIX}/demo-tool/diagnostics`)
    await h.call(`${WASM_APPS_PREFIX}/demo-tool/schema`)
    await h.call(`${WASM_APPS_PREFIX}/demo-tool/export`)
    // R1-pm-3：发布者的版本历史 + 审核结论（含被拒理由）必须也被转发 ——
    // 只读白名单是逐后缀的，漏一个后缀 = 服务端做完了、客户端永远 404。
    await h.call(`${WASM_APPS_PREFIX}/demo-tool/releases`)
    // 作者数据面（2026-09-21）：查询串必须**原样**转发（table/limit/offset/unmask 都是
    // 服务端的判据；代理层吞掉查询串会让"看数据"永远查第一张表的第一页默认视图）。
    await h.call(`${WASM_APPS_PREFIX}/demo-tool/rows?table=notes&limit=50&offset=100`)
    // 标识唯一性预查（2026-09-20）：发布表单的异步查重走这条只读代理。
    // 它同样必须在这张逐后缀分发的白名单里，否则表单永远拿不到判词。
    await h.call(`${WASM_APPS_PREFIX}/demo-tool/availability`)
    await h.call(`${WASM_APPS_PREFIX}/demo-tool`, 'DELETE')
    expect(h.outbound.map(o => `${o.method} ${o.url.replace('https://harness.example', '')}`)).toEqual([
      'POST /api/client/v2/apps/wasm/demo-tool/unpublish',
      'POST /api/client/v2/apps/wasm/demo-tool/freeze',
      'GET /api/client/v2/apps/wasm/demo-tool/diagnostics',
      'GET /api/client/v2/apps/wasm/demo-tool/schema',
      'GET /api/client/v2/apps/wasm/demo-tool/export',
      'GET /api/client/v2/apps/wasm/demo-tool/releases',
      'GET /api/client/v2/apps/wasm/demo-tool/rows?table=notes&limit=50&offset=100',
      'GET /api/client/v2/apps/wasm/demo-tool/availability',
      'DELETE /api/client/v2/apps/wasm/demo-tool',
    ])
    expect(h.outbound[0]!.body).toBe(JSON.stringify({ enabled: false }))
  })
})

// ---------------------------------------------------------------------------
// 4. 应用中心目录（R34 / R36 / R38）
// ---------------------------------------------------------------------------

describe('应用中心目录：只做地址补全，不二次过滤、不加额度字段', () => {
  const catalogPayload = {
    apps: [
      { app_id: 'notes', title: '共享便签', description: '值班记录', responsible: 'alice', entry_url: 'https://notes.apps.example.com', access: 'public', enabled: true, current_version: '1.4.2', is_owner: true, purpose: '值班记录', whitelist: [] },
      { app_id: 'offline', title: '内部工具', description: '', responsible: 'bob', entry_url: '/hidden', access: 'whitelist', enabled: false, current_version: '2.0.0', is_owner: false },
      { app_id: 'no-link', title: '未配基域', description: '', responsible: 'carol' },
    ],
  }

  // ⚠️ **反向断言**（R2-L1-1，2026-09-20 主控裁定）：这条用例原先钉的是"相对
  // `entry_url` 补成绝对地址"——那正是被 W4 删除的**旧访问模型**字段（应用曾在
  // `https://<app_id>.<基域>/` 上服务，客户端才需要把服务端下发的入口链接补全）。
  // 现在服务端契约里（emit 已删、字段已不再下发）根本没有这个键，宿主再留一段
  // "补全"逻辑就是**语义已死却仍可被当成活契约**的依据 ⇒ 代码已删，用例改为
  // 反向断言：宿主不认这个字段、不改写它、更不发明它。
  it('目录逐字节透传：**不做**入口链接补全（旧模型的相对地址保持相对）', async () => {
    const h = harness(() => json(200, catalogPayload))
    const res = await h.call(WASM_APPS_PREFIX)
    expect(res.code).toBe(200)
    // 相对地址**必须保持相对**：旧实现会把它拼成 `https://harness.example/hidden`。
    expect(res.body.apps[1].entry_url).toBe('/hidden')
    // 服务端下发的原值原样穿过（不是"重新序列化后的等价物"）。
    expect(res.body.apps[0].entry_url).toBe('https://notes.apps.example.com')
    // 服务端没下发的行，宿主**不得**发明这个键。
    expect('entry_url' in res.body.apps[2]).toBe(false)
    // 最强形态：整份响应与出站收到的字节逐字一致（透传 = 不解析、不改写、不重排）。
    expect(res.text).toBe(JSON.stringify(catalogPayload))
  })

  /**
   * P1-4：`current_version` 必须原样穿过宿主到客户端。
   *
   * 宿主这一层对目录只做地址补全（不增删字段），所以这条断言的价值是**钉住
   * "字段确实在这一跳活下来"**：`wasm_app_list` 的工具描述要求模型"先查当前版本"，
   * 端到端少一站这份数据就到不了模型手里。
   */
  it('P1-4：current_version / is_owner / 发布者字段原样穿过（宿主不增删目录字段）', async () => {
    const h = harness(() => json(200, catalogPayload))
    const res = await h.call(WASM_APPS_PREFIX)
    expect(res.body.apps.map((a: { current_version?: string }) => a.current_version)).toEqual(['1.4.2', '2.0.0', undefined])
    expect(res.body.apps.map((a: { is_owner?: boolean }) => a.is_owner)).toEqual([true, false, undefined])
    // 发布者专属字段也在（服务端只对发布者下发；宿主原样转发，不替它过滤）。
    expect(res.body.apps[0].whitelist).toEqual([])
    expect(res.body.apps[0].purpose).toBe('值班记录')
    // 未知字段仍然不增删（原有口径不变）。
    expect('whitelist' in res.body.apps[1]).toBe(false)
  })

  it('目录原样透传：**下架条目也照列**，客户端既不按 access 过滤也不补字段（R38）', async () => {
    const h = harness(() => json(200, catalogPayload))
    const res = await h.call(WASM_APPS_PREFIX)
    // 三行分别是：公开在用 / 白名单但**已下架** / 未配入口。服务端下发什么就返回什么 ——
    // 「应用中心展示全部应用」是产品口径（2026-09-18 拍板），客户端不得再引入可见性规则：
    // 过滤会把已下架的应用藏起来（它的域名仍然可访问），补字段则等于替服务端编数据。
    expect(res.body.apps.map((a: { app_id: string }) => a.app_id)).toEqual(['notes', 'offline', 'no-link'])
    expect(res.body.apps.map((a: { access?: string }) => a.access)).toEqual(['public', 'whitelist', undefined])
    expect(res.body.apps.map((a: { enabled?: boolean }) => a.enabled)).toEqual([true, false, undefined])
  })

  it('响应里不出现任何额度/用量字段（R36）', async () => {
    const h = harness(() => json(200, catalogPayload))
    const res = await h.call(WASM_APPS_PREFIX)
    expect(res.text).not.toMatch(/quota|balance|usage|budget|余额|用量|额度/iu)
  })

  // 旧模型的入口链接补全助手（`absolutizeEntryURL`）已随 R2-L1-1 删除 —— 那组
  // 单元断言与其实现一并消失（"绝不被重新引入"由上面那条目录透传的反向断言承担：
  // 重新加回补全逻辑 ⇒ 相对地址不再是 `/hidden` ⇒ 立刻红）。
  it('isInsideRoot 不是字符串前缀比较（/a/bc 不属于 /a/b）', () => {
    expect(isInsideRoot('/a/b', '/a/b/c')).toBe(true)
    expect(isInsideRoot('/a/b', '/a/b')).toBe(true)
    expect(isInsideRoot('/a/b', '/a/bc')).toBe(false)
    expect(isInsideRoot('/a/b', '/a')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 5. 发布编排：直传 / 分片 / 续传（§4.2）
// ---------------------------------------------------------------------------

describe('发布编排：wasm 来源、>8 MiB 分片、续传只补缺失片', () => {
  it('小载荷直传 releases：带上 wasm_base64 与 manifest', async () => {
    const h = harness(() => json(200, { ok: true, version: '1.0.0' }))
    const wasm = Buffer.from('small-wasm-module')
    const res = await h.call(`${WASM_APPS_PREFIX}/publish`, 'POST', JSON.stringify({
      app_id: 'demo-tool',
      version: '1.0.0',
      title: '演示工具',
      changelog: '首版',
      config: { access: 'whitelist', whitelist: ['alice'] },
      wasm_base64: wasm.toString('base64'),
    }))
    expect(res.code).toBe(200)
    expect(h.outbound).toHaveLength(1)
    expect(h.outbound[0]!.url).toBe('https://harness.example/api/client/v2/apps/wasm/demo-tool/releases')
    const sent = JSON.parse(h.outbound[0]!.body)
    expect(sent.wasm_base64).toBe(wasm.toString('base64'))
    expect(sent.config).toEqual({ access: 'whitelist', whitelist: ['alice'] })
    expect(h.outbound.every(o => !o.url.includes('/uploads'))).toBe(true)
  })

  it('刚好 8 MiB 的 base64 仍走直传（边界：> 而不是 >=）', async () => {
    // 6 MiB 二进制 ⇒ base64 恰好 8 MiB。
    const wasm = Buffer.alloc(6 * 1024 * 1024, 3)
    expect(wasm.toString('base64').length).toBe(UPLOAD_CHUNK_MAX_BYTES)
    const h = harness(() => json(200, { ok: true }))
    await h.call(`${WASM_APPS_PREFIX}/publish`, 'POST', JSON.stringify({
      app_id: 'demo-tool', version: '1.0.0', wasm_base64: wasm.toString('base64'),
    }))
    expect(h.outbound).toHaveLength(1)
    expect(h.outbound[0]!.url).toContain('/releases')
  })

  it('超过 8 MiB 自动走 uploads 端点，逐片 PUT 且 complete 不带 wasm_base64', async () => {
    // 17 MiB 二进制 ⇒ base64 ≈22.7 MiB ⇒ 均分 3 片。
    const wasm = Buffer.alloc(17 * 1024 * 1024, 5)
    const chunks: string[] = []
    const h = harness((method, url, init) => {
      if (url.endsWith('/uploads') && method === 'POST') {
        // 契约：服务端 `uploadCreateRequest`（upload.go:97-102）。字段名/取值由
        // 专门的契约用例逐条钉（见下方 "分片字段契约" describe），这里只做流程断言。
        const opened = JSON.parse(init.body) as Record<string, unknown>
        expect(opened.app_id).toBe('demo-tool')
        expect(opened.total_bytes).toBe(wasm.byteLength)
        return json(201, { upload_id: 'UP-1', received: [] })
      }
      if (method === 'PUT') {
        chunks.push(init.body)
        expect(init.contentType).toBe('application/octet-stream')
        return new Response(null, { status: 204 })
      }
      if (url.endsWith('/uploads/UP-1/complete')) {
        return json(200, { ok: true, version: '1.0.0' })
      }
      throw new Error(`unexpected ${method} ${url}`)
    })
    const res = await h.call(`${WASM_APPS_PREFIX}/publish`, 'POST', JSON.stringify({
      app_id: 'demo-tool',
      version: '1.0.0',
      wasm_base64: wasm.toString('base64'),
    }))
    expect(res.code).toBe(200)
    const puts = h.outbound.filter(o => o.method === 'PUT')
    expect(puts.map(o => o.url.split('/').pop())).toEqual(['0', '1', '2'])
    // 每片解码后必须落在 (0, 8 MiB]，且拼起来逐字节等于原模块。
    const sizes = chunks.map(c => Buffer.from(c, 'base64').length)
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(wasm.byteLength)
    for (const size of sizes) expect(size).toBeLessThanOrEqual(UPLOAD_CHUNK_MAX_BYTES)
    expect(Buffer.concat(chunks.map(c => Buffer.from(c, 'base64'))).equals(wasm)).toBe(true)
    const complete = h.outbound.find(o => o.url.endsWith('/complete'))!
    expect(complete.url).toBe('https://harness.example/api/client/v2/apps/wasm/uploads/UP-1/complete')
    expect(complete.body.includes('wasm_base64')).toBe(false)
    expect(JSON.parse(complete.body).app_id).toBeUndefined()
  })

  it('续传：received[] 里的片不重传，只补缺失片', async () => {
    const wasm = Buffer.alloc(17 * 1024 * 1024, 9)
    const put: string[] = []
    const h = harness((method, url) => {
      if (url.endsWith('/uploads') && method === 'POST') return json(201, { upload_id: 'UP-2', received: [] })
      if (method === 'GET' && url.endsWith('/uploads/UP-2')) return json(200, { received: [0, 2] })
      if (method === 'PUT') {
        put.push(url.split('/').pop()!)
        return new Response(null, { status: 204 })
      }
      if (url.endsWith('/complete')) return json(200, { ok: true })
      throw new Error(`unexpected ${method} ${url}`)
    })
    const res = await h.call(`${WASM_APPS_PREFIX}/publish`, 'POST', JSON.stringify({
      app_id: 'demo-tool', version: '1.0.0', wasm_base64: wasm.toString('base64'), upload_id: 'UP-2',
    }))
    expect(res.code).toBe(200)
    expect(put).toEqual(['1'])
  })

  it('断线重试：失败的片重新拉 received[] 后重传，最终完成', async () => {
    const wasm = Buffer.alloc(17 * 1024 * 1024, 1)
    const put: string[] = []
    let failures = 1
    const h = harness((method, url) => {
      if (url.endsWith('/uploads') && method === 'POST') return json(201, { upload_id: 'UP-3', received: [] })
      if (method === 'GET' && url.endsWith('/uploads/UP-3')) {
        // 第二次查询时服务端已经收下了第 0 片（真实场景：PUT 成功但响应丢了）。
        return json(200, { received: put.includes('0') ? [0] : [] })
      }
      if (method === 'PUT') {
        const index = url.split('/').pop()!
        if (index === '1' && failures > 0) {
          failures -= 1
          return json(500, { error: { code: 'INTERNAL', message: 'disk hiccup' } })
        }
        put.push(index)
        return new Response(null, { status: 204 })
      }
      if (url.endsWith('/complete')) return json(200, { ok: true })
      throw new Error(`unexpected ${method} ${url}`)
    })
    const res = await h.call(`${WASM_APPS_PREFIX}/publish`, 'POST', JSON.stringify({
      app_id: 'demo-tool', version: '1.0.0', wasm_base64: wasm.toString('base64'),
    }))
    expect(res.code).toBe(200)
    expect(put.filter(i => i === '1')).toHaveLength(1)
    expect(new Set(put)).toEqual(new Set(['0', '1', '2']))
    expect(h.outbound.some(o => o.method === 'GET' && o.url.endsWith('/uploads/UP-3'))).toBe(true)
  })

  /**
   * P2-8：确定性 4xx 是**终态** —— 不重试、不补 GET、不改写成 `UPLOAD_INCOMPLETE`。
   *
   * 旧行为：任何一片非 2xx 都重试 3 轮 + 每轮一次额外 GET，最后统一回
   * `UPLOAD_INCOMPLETE` + "带同一个 upload_id 重发"。对确定性拒绝（这一片本身就错）
   * 那句建议是**错的**，而且把服务端的 `VALIDATION` / hints 压没了。
   *
   * 变异验证：把分片循环里的 `!isRetryableChunkStatus(...)` 终态分支删掉 ⇒
   * 本条红（会变成 3 次 PUT + 2 次 GET + `UPLOAD_INCOMPLETE`）。
   */
  it('P2-8：某一片被确定性 4xx 拒 ⇒ 只发 1 次 PUT、0 次额外 GET、原样回服务端 code', async () => {
    const wasm = Buffer.alloc(17 * 1024 * 1024, 3)
    const put: string[] = []
    let gets = 0
    const h = harness((method, url) => {
      if (url.endsWith('/uploads') && method === 'POST') return json(201, { upload_id: 'UP-T', received: [] })
      if (method === 'GET') { gets += 1; return json(200, { received: [] }) }
      if (method === 'PUT') {
        const index = url.split('/').pop()!
        put.push(index)
        // 服务端对"这一片本身不合法"的确定性裁决（upload.go 的 VALIDATION）。
        return json(400, {
          error: {
            code: 'VALIDATION',
            message: '分片大小与开会话时声明的 chunk_bytes 不符',
            details: { chunk_index: Number(index), reason: 'chunk_size_mismatch' },
            hints: ['用同一个 upload_id 重开会话并声明正确的 chunk_bytes；重发同一片不会成功'],
          },
        })
      }
      throw new Error(`unexpected ${method} ${url}`)
    })
    const res = await h.call(`${WASM_APPS_PREFIX}/publish`, 'POST', JSON.stringify({
      app_id: 'demo-tool', version: '1.0.0', wasm_base64: wasm.toString('base64'),
    }))
    // ① 只试了一次（旧实现是 3 次）。
    expect(put).toHaveLength(1)
    // ② 没有"每轮一次额外 GET"（旧实现 2 次）。
    expect(gets).toBe(0)
    // ③ 返回的就是服务端的信封（code/details/hints 一个不丢），不是 UPLOAD_INCOMPLETE。
    expect(res.code).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION')
    expect(res.body.error.details.reason).toBe('chunk_size_mismatch')
    expect(res.body.error.hints[0]).toContain('chunk_bytes')
  })

  it('P2-8 对照：5xx 仍然重试（可自愈的故障不该被当成终态）', async () => {
    const wasm = Buffer.alloc(17 * 1024 * 1024, 4)
    const put: string[] = []
    let failures = 2
    const h = harness((method, url) => {
      if (url.endsWith('/uploads') && method === 'POST') return json(201, { upload_id: 'UP-R', received: [] })
      if (method === 'GET') return json(200, { received: [] })
      if (method === 'PUT') {
        const index = url.split('/').pop()!
        if (failures > 0) { failures -= 1; return json(503, { error: { code: 'COMPILE_BUSY', message: '编译器忙' } }) }
        put.push(index)
        return new Response(null, { status: 204 })
      }
      if (url.endsWith('/complete')) return json(200, { ok: true })
      throw new Error(`unexpected ${method} ${url}`)
    })
    const res = await h.call(`${WASM_APPS_PREFIX}/publish`, 'POST', JSON.stringify({
      app_id: 'demo-tool', version: '1.0.0', wasm_base64: wasm.toString('base64'),
    }))
    expect(res.code).toBe(200)
    expect(new Set(put)).toEqual(new Set(['0', '1', '2']))
  })

  it('始终收不齐时给出可续传的错误（带 upload_id 与已收片）', async () => {
    const wasm = Buffer.alloc(17 * 1024 * 1024, 2)
    const h = harness((method, url) => {
      if (url.endsWith('/uploads') && method === 'POST') return json(201, { upload_id: 'UP-4', received: [] })
      if (method === 'GET') return json(200, { received: [] })
      if (method === 'PUT') return json(503, { error: { code: 'COMPILE_BUSY', message: '编译器忙' } })
      throw new Error(`unexpected ${method} ${url}`)
    })
    const res = await h.call(`${WASM_APPS_PREFIX}/publish`, 'POST', JSON.stringify({
      app_id: 'demo-tool', version: '1.0.0', wasm_base64: wasm.toString('base64'),
    }))
    expect(res.code).toBe(503)
    expect(res.body.error.code).toBe('UPLOAD_INCOMPLETE')
    expect(res.body.error.details.upload_id).toBe('UP-4')
    expect(res.body.error.details.chunks).toBe(3)
    expect(String(res.body.error.details.upstream)).toContain('COMPILE_BUSY')
    expect(res.body.error.hints[0]).toContain('upload_id')
  })

  it('缺少来源 / 非法 base64 / 缺字段都明确拒（不发出站请求）', async () => {
    const h = harness(() => json(200, {}))
    const noSource = await h.call(`${WASM_APPS_PREFIX}/publish`, 'POST', JSON.stringify({ app_id: 'a', version: '1.0.0' }))
    expect(noSource.code).toBe(400)
    expect(noSource.body.error.code).toBe('MISSING_FIELD')
    const badB64 = await h.call(`${WASM_APPS_PREFIX}/publish`, 'POST', JSON.stringify({
      app_id: 'a', version: '1.0.0', wasm_base64: '!!!not-base64!!!',
    }))
    expect(badB64.body.error.code).toBe('WASM_SOURCE_INVALID')
    const noApp = await h.call(`${WASM_APPS_PREFIX}/publish`, 'POST', JSON.stringify({ version: '1.0.0', wasm_base64: 'AA==' }))
    expect(noApp.body.error.code).toBe('MISSING_FIELD')
    const noVersion = await h.call(`${WASM_APPS_PREFIX}/publish`, 'POST', JSON.stringify({ app_id: 'a', wasm_base64: 'AA==' }))
    expect(noVersion.body.error.code).toBe('MISSING_FIELD')
    expect(h.outbound).toHaveLength(0)
  })

  /**
   * P1-10：base64 分支的**体积闸门**（此前只有两条 `wasm_path` 分支有）。
   *
   * 变异验证：把 `resolveWasmSource` 里新增的 `bytes.byteLength > WASM_MAX_BYTES`
   * 分支删掉 ⇒ 本条红（会一路出站到服务端才被拒）。
   */
  it('P1-10：base64 载荷超过 32 MiB 时本地就拒（UPLOAD_TOO_LARGE，零出站）', async () => {
    const h = harness(() => json(200, {}))
    // 构造恰好解码为 `WASM_MAX_BYTES + 1` 字节的合法 base64（避免真的分配 44 MB 字符串
    // 再逐字节编码）：`'A'` 的重复串按 3 字节/4 字符解码。
    const oversize = 'A'.repeat(Math.ceil((WASM_MAX_BYTES + 1) / 3) * 4)
    expect(Buffer.from(oversize, 'base64').byteLength).toBeGreaterThan(WASM_MAX_BYTES)
    const res = await h.call(`${WASM_APPS_PREFIX}/publish`, 'POST', JSON.stringify({
      app_id: 'demo-tool', version: '1.0.0', wasm_base64: oversize,
    }))
    expect(res.code).toBe(413)
    expect(res.body.error.code).toBe('UPLOAD_TOO_LARGE')
    expect(res.body.error.details.limit_bytes).toBe(WASM_MAX_BYTES)
    expect(res.body.error.details.size_bytes).toBeGreaterThan(WASM_MAX_BYTES)
    // 关键：**零出站**（不浪费一次上传与一次编译）。
    expect(h.outbound).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 6. 90 s 超时（§4.2 / §10.5 第 58 项）
// ---------------------------------------------------------------------------

describe('单次请求预算：90 秒（不是既有技能上传的 30 秒）', () => {
  it('30 秒不 abort、90 秒 abort（fake timer 驱动真实 AbortController）', async () => {
    vi.useFakeTimers()
    // 假网关模仿真实 fetch 的 abort 语义：signal 一 abort 就以 AbortError 拒绝，
    // 否则这一跳永不结束（正是"32 MiB 在 30 秒预算下必然超时"的形态）。
    const h = harness((_method, _url, init) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))
      })
    }))
    const pending = h.call(WASM_APPS_PREFIX)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(h.outbound[0]!.signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(CLIENT_UPLOAD_TIMEOUT_MS - 30_000)
    expect(h.outbound[0]!.signal?.aborted).toBe(true)
    const res = await pending
    expect(res.code).toBe(502)
    expect(res.body.error.code).toBe('GATEWAY_TIMEOUT')
  })

  it('超时文案把 90 秒与分片续传说清楚（AI 据此换策略）', async () => {
    const h = harness(() => { throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }) })
    const res = await h.call(WASM_APPS_PREFIX)
    expect(res.body.error.code).toBe('GATEWAY_TIMEOUT')
    expect(String(res.body.error.hints[0])).toContain('90 秒')
    expect(String(res.body.error.hints[0])).toContain('wasm_path')
  })
})

// ---------------------------------------------------------------------------
// 7. wasm_path 的读取面（会话工作区 / 数据根）
// ---------------------------------------------------------------------------

describe('wasm_path：只允许会话工作区与 <数据根>/apps（FIX-39）', () => {
  /**
   * 让 ctx.workspaceRegistry 认得工作区（结构类型，与 cron 同款做法）。
   *
   * 与上面的 {@link harness} 不同，这里**记录出站**：负例的核心判据是"零出站"
   * （拒绝必须发生在读文件之前，而不是"先上传再让服务端拒"）。
   */
  function harnessWithWorkspace(respond: () => Response, workspacePath: string | null): Harness {
    const routes: Route[] = []
    const outbound: Outbound[] = []
    const ctx = {
      effect: (fn: () => unknown) => { fn() },
      get: (name: string) => {
        if (name === 'connection') return browserFence()
        if (name === 'workspaceRegistry') {
          return { list: () => (workspacePath === null ? [] : [{ id: 'w1', path: workspacePath }]) }
        }
        return undefined
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      picoSession: {
        isRestored: () => true,
        isLoggedIn: () => true,
        getSession: () => SESSION,
        setSession: vi.fn(),
        clear: vi.fn(),
      },
      webServer: { tapIndex: () => () => {}, register: (route: Route) => { routes.push(route); return () => {} } },
    }
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      outbound.push({ method: 'POST', url: String(url), body: '', contentType: '', signal: undefined })
      return respond()
    }))
    apply(ctx as never, {} as AuthGateConfig)
    const route = routes.find(r => r.kind === 'prefix' && r.path === WASM_APPS_PREFIX)!
    return {
      routes,
      outbound,
      get cleared() { return 0 },
      call: async (url: string, method: Method = 'GET', body?: string, headers?: Record<string, string>) => {
        const { res, read } = fakeRes()
        await route.handler(fakeReq(url, method, body, headers), res)
        return read()
      },
    }
  }

  const publishPath = (path: string): string => JSON.stringify({
    app_id: 'demo-tool', version: '1.0.0', wasm_path: path,
  })

  it('工作区内的产物直传成功（wasm_path 不需要 base64 请求体）', async () => {
    const file = join(workspace, 'main.wasm')
    await writeFile(file, Buffer.from('wasm-bytes'))
    const h = harnessWithWorkspace(() => json(200, { ok: true }), workspace)
    const res = await h.call(`${WASM_APPS_PREFIX}/publish`, 'POST', publishPath(file))
    expect(res.code).toBe(200)
    expect(h.outbound).toHaveLength(1)
  })

  it('正例：<数据根>/apps/** 内的文件放行（平台自己的应用数据面）', async () => {
    await mkdir(join(home, 'apps', 'demo-tool', 'build'), { recursive: true })
    const file = join(home, 'apps', 'demo-tool', 'build', 'main.wasm')
    await writeFile(file, Buffer.from('wasm-bytes'))
    const h = harnessWithWorkspace(() => json(200, { ok: true }), workspace)
    const res = await h.call(`${WASM_APPS_PREFIX}/publish`, 'POST', publishPath(file))
    expect(res.code).toBe(200)
    expect(res.body.error).toBeUndefined()
    expect(h.outbound).toHaveLength(1)
    // 数据根本身也要能报告出来（报错文本与诊断用它），但它不参与放行。
    const roots = await readRoots({
      get: (name: string) => (name === 'workspaceRegistry' ? { list: () => [{ path: workspace }] } : undefined),
    } as never)
    expect(roots.dataRoot).toBe(home)
    expect(roots.appsRoot).toBe(join(home, 'apps'))
  })

  it('反例：$DSH_HOME/session.json（明文员工令牌）被拒且零出站', async () => {
    const tokenFile = join(home, 'session.json')
    await writeFile(tokenFile, JSON.stringify({ serverURL: 'https://harness.example', username: 'alice', token: 'EMPLOYEE-TOKEN' }))
    const h = harnessWithWorkspace(() => json(200, { ok: true }), workspace)
    const res = await h.call(`${WASM_APPS_PREFIX}/publish`, 'POST', publishPath(tokenFile))
    expect(res.code).toBe(400)
    expect(res.body.error.code).toBe('WASM_PATH_OUTSIDE_ALLOWED_ROOTS')
    // 凭据文件的内容绝不能出现在任何响应里（红线 3 的同族）。
    expect(res.text).not.toContain('EMPLOYEE-TOKEN')
    expect(h.outbound).toHaveLength(0)
  })

  it('反例：$DSH_HOME/.credentials.yaml（browser-session 签名 secret）被拒且零出站', async () => {
    const creds = join(home, '.credentials.yaml')
    await writeFile(creds, 'client-connection:\n  browser-session:\n    secret: SIGNING-SECRET\n')
    const h = harnessWithWorkspace(() => json(200, { ok: true }), workspace)
    const res = await h.call(`${WASM_APPS_PREFIX}/publish`, 'POST', publishPath(creds))
    expect(res.code).toBe(400)
    expect(res.body.error.code).toBe('WASM_PATH_OUTSIDE_ALLOWED_ROOTS')
    expect(res.text).not.toContain('SIGNING-SECRET')
    expect(h.outbound).toHaveLength(0)
  })

  it('反例：数据根下的其他任意文件（如 data/master.key）被拒且零出站', async () => {
    await mkdir(join(home, 'data'), { recursive: true })
    const masterKey = join(home, 'data', 'master.key')
    await writeFile(masterKey, 'MASTER-KEY-BYTES')
    const h = harnessWithWorkspace(() => json(200, { ok: true }), workspace)
    const res = await h.call(`${WASM_APPS_PREFIX}/publish`, 'POST', publishPath(masterKey))
    expect(res.code).toBe(400)
    expect(res.body.error.code).toBe('WASM_PATH_OUTSIDE_ALLOWED_ROOTS')
    expect(h.outbound).toHaveLength(0)
    // hints 必须说清"数据根只有 apps 子目录可读"，否则 AI 只会重试同一个值。
    expect(String(res.body.error.hints.join(' '))).toContain('apps')
  })

  it('反例矩阵：数据根根目录下的每一层都不放行（只有 apps/** 例外）', async () => {
    const cases = ['firebase.json', 'settings.yaml', 'session.json', '.credentials.yaml', 'logs/host.log', 'storages/x.json']
    for (const relative of cases) {
      const file = join(home, relative)
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, `payload-of-${relative}`)
      const h = harnessWithWorkspace(() => json(200, { ok: true }), workspace)
      const res = await h.call(`${WASM_APPS_PREFIX}/publish`, 'POST', publishPath(file))
      expect(res.code, `${relative} 必须被拒`).toBe(400)
      expect(res.body.error.code, relative).toBe('WASM_PATH_OUTSIDE_ALLOWED_ROOTS')
      expect(h.outbound, `${relative} 不得出站`).toHaveLength(0)
    }
    // 反向对照：同一份字节放在 <数据根>/apps 下就放行（拒的是"面"，不是文件本身）。
    await mkdir(join(home, 'apps'), { recursive: true })
    await writeFile(join(home, 'apps', 'ok.wasm'), 'payload')
    const ok = harnessWithWorkspace(() => json(200, { ok: true }), workspace)
    const allowed = await ok.call(`${WASM_APPS_PREFIX}/publish`, 'POST', publishPath(join(home, 'apps', 'ok.wasm')))
    expect(allowed.code).toBe(200)
  })

  it('越界路径被拒，并把"哪条根"写清（AI 需要可直接照做的原因）', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'pico-wasm-outside-'))
    const file = join(outside, 'evil.wasm')
    await writeFile(file, Buffer.from('x'))
    const h = harnessWithWorkspace(() => json(200, {}), workspace)
    const res = await h.call(`${WASM_APPS_PREFIX}/publish`, 'POST', publishPath(file))
    expect(res.code).toBe(400)
    expect(res.body.error.code).toBe('WASM_PATH_OUTSIDE_ALLOWED_ROOTS')
    expect(res.body.error.details.wasm_path).toBe(file)
    expect(Array.isArray(res.body.error.details.allowed_roots)).toBe(true)
    expect(String(res.body.error.hints.join(' '))).toContain('会话工作区')
    await rm(outside, { recursive: true, force: true })
  })

  it('符号链接逃逸被拒（先 realpath 再判包含）', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'pico-wasm-link-'))
    const secret = join(outside, 'secret.wasm')
    await writeFile(secret, Buffer.from('secret'))
    const link = join(workspace, 'link.wasm')
    await symlink(secret, link)
    const h = harnessWithWorkspace(() => json(200, {}), workspace)
    const res = await h.call(`${WASM_APPS_PREFIX}/publish`, 'POST', publishPath(link))
    expect(res.code).toBe(400)
    expect(res.body.error.code).toBe('WASM_PATH_OUTSIDE_ALLOWED_ROOTS')
    await rm(outside, { recursive: true, force: true })
  })

  it('符号链接从工作区指向数据根凭据文件也被拒（软链不绕过收敛后的允许面）', async () => {
    const tokenFile = join(home, 'session.json')
    await writeFile(tokenFile, '{"token":"EMPLOYEE-TOKEN"}')
    const link = join(workspace, 'sneaky.wasm')
    await symlink(tokenFile, link)
    const h = harnessWithWorkspace(() => json(200, {}), workspace)
    const res = await h.call(`${WASM_APPS_PREFIX}/publish`, 'POST', publishPath(link))
    expect(res.code).toBe(400)
    expect(res.body.error.code).toBe('WASM_PATH_OUTSIDE_ALLOWED_ROOTS')
    expect(h.outbound).toHaveLength(0)
  })

  it('审计 P1-1 形态①：工作区 == 数据根本身时，数据根里的凭据仍不是上传源', async () => {
    // 用户完全可以把家目录选成工作区。此时"允许面 = 工作区 ∪ <数据根>/apps"里的
    // 工作区**就是**数据根 ⇒ 只做包含判定的话 session.json 会落进允许面。
    const tokenFile = join(home, 'session.json')
    await writeFile(tokenFile, '{"token":"EMPLOYEE-TOKEN"}')
    const h = harnessWithWorkspace(() => json(200, { ok: true }), home)
    const res = await h.call(`${WASM_APPS_PREFIX}/publish`, 'POST', publishPath(tokenFile))
    expect(res.code).toBe(400)
    expect(res.body.error.code).toBe('WASM_PATH_OUTSIDE_ALLOWED_ROOTS')
    expect(res.text).not.toContain('EMPLOYEE-TOKEN')
    expect(h.outbound).toHaveLength(0)
  })

  it('审计 P1-1 形态②：工作区是数据根的**祖先**时同样不放行', async () => {
    const outer = await mkdtemp(join(tmpdir(), 'pico-wasm-ancestor-'))
    const innerHome = join(outer, 'dsh-home')
    await mkdir(innerHome, { recursive: true })
    vi.stubEnv('DSH_HOME', innerHome)
    const tokenFile = join(innerHome, 'session.json')
    await writeFile(tokenFile, '{"token":"EMPLOYEE-TOKEN"}')
    const h = harnessWithWorkspace(() => json(200, { ok: true }), outer)
    const res = await h.call(`${WASM_APPS_PREFIX}/publish`, 'POST', publishPath(tokenFile))
    expect(res.code).toBe(400)
    expect(res.body.error.code).toBe('WASM_PATH_OUTSIDE_ALLOWED_ROOTS')
    expect(res.text).not.toContain('EMPLOYEE-TOKEN')
    expect(h.outbound).toHaveLength(0)
    // 反向对照：同一个祖先工作区里，**数据根之外**的产物照常放行
    // （否决的是数据根子树，不是这个工作区）。
    const own = join(outer, 'main.wasm')
    await writeFile(own, Buffer.from('wasm'))
    const ok = await h.call(`${WASM_APPS_PREFIX}/publish`, 'POST', publishPath(own))
    expect(ok.code).toBe(200)
    await rm(outer, { recursive: true, force: true })
  })

  it('审计 P1-1 形态③：工作区是指向数据根的**软链**时同样不放行', async () => {
    const linkRoot = await mkdtemp(join(tmpdir(), 'pico-wasm-linkroot-'))
    const linkWs = join(linkRoot, 'ws-link')
    await symlink(home, linkWs)
    const tokenFile = join(home, '.credentials.yaml')
    await writeFile(tokenFile, 'secret: SIGNING-SECRET\n')
    const h = harnessWithWorkspace(() => json(200, { ok: true }), linkWs)
    const res = await h.call(`${WASM_APPS_PREFIX}/publish`, 'POST', publishPath(join(linkWs, '.credentials.yaml')))
    expect(res.code).toBe(400)
    expect(res.body.error.code).toBe('WASM_PATH_OUTSIDE_ALLOWED_ROOTS')
    expect(res.text).not.toContain('SIGNING-SECRET')
    expect(h.outbound).toHaveLength(0)
    await rm(linkRoot, { recursive: true, force: true })
  })

  it('审计 P1-1 反向对照：工作区是数据根时，<数据根>/apps 里的产物仍然放行', async () => {
    await mkdir(join(home, 'apps'), { recursive: true })
    const inApps = join(home, 'apps', 'built.wasm')
    await writeFile(inApps, Buffer.from('wasm-bytes'))
    const h = harnessWithWorkspace(() => json(200, { ok: true }), home)
    const res = await h.call(`${WASM_APPS_PREFIX}/publish`, 'POST', publishPath(inApps))
    expect(res.code).toBe(200)
  })

  it('相对路径与非绝对路径被拒；<数据根>/apps 内的路径放行、数据根根目录被拒', async () => {
    const h = harnessWithWorkspace(() => json(200, {}), workspace)
    const relative = await h.call(`${WASM_APPS_PREFIX}/publish`, 'POST', JSON.stringify({
      app_id: 'a', version: '1.0.0', wasm_path: 'main.wasm',
    }))
    expect(relative.body.error.code).toBe('WASM_PATH_NOT_ABSOLUTE')

    await mkdir(join(home, 'apps', 'build'), { recursive: true })
    const inApps = join(home, 'apps', 'build', 'app.wasm')
    await writeFile(inApps, Buffer.from('in-apps'))
    const ok = await h.call(`${WASM_APPS_PREFIX}/publish`, 'POST', publishPath(inApps))
    expect(ok.code).toBe(200)

    // 同一层级的"数据根根目录下的裸文件"是 FIX-39 收敛掉的那一类。
    const inHomeRoot = join(home, 'app.wasm')
    await writeFile(inHomeRoot, Buffer.from('in-home-root'))
    const rejected = await h.call(`${WASM_APPS_PREFIX}/publish`, 'POST', publishPath(inHomeRoot))
    expect(rejected.code).toBe(400)
    expect(rejected.body.error.code).toBe('WASM_PATH_OUTSIDE_ALLOWED_ROOTS')
  })

  it('超过 32 MiB 的产物在本地就被拒（不浪费一次出站上传）', async () => {
    const big = join(workspace, 'big.wasm')
    await writeFile(big, Buffer.alloc(WASM_MAX_BYTES + 1, 0))
    const h = harnessWithWorkspace(() => json(200, {}), workspace)
    const res = await h.call(`${WASM_APPS_PREFIX}/publish`, 'POST', publishPath(big))
    expect(res.code).toBe(413)
    expect(res.body.error.code).toBe('UPLOAD_TOO_LARGE')
    expect(res.body.error.details.limit_bytes).toBe(WASM_MAX_BYTES)
    expect(h.outbound).toHaveLength(0)
  })

  it('目录不是产物：wasm_path 指向目录 ⇒ 结构化 400（FIX-41，不再抛穿 handler）', async () => {
    await mkdir(join(home, 'apps'), { recursive: true })
    for (const target of [workspace, join(home, 'apps'), home]) {
      const h = harnessWithWorkspace(() => json(200, {}), workspace)
      const res = await h.call(`${WASM_APPS_PREFIX}/publish`, 'POST', publishPath(target))
      expect(res.code, `${target} 必须被 400 拒`).toBe(400)
      // 两个都合法：数据根本身会在"允许面"之前被拒（OUTSIDE），工作区内目录会被
      // NOT_A_FILE 拒 —— 关键判据是"有结构化信封且零出站"，不是具体码。
      expect(['WASM_PATH_NOT_A_FILE', 'WASM_PATH_OUTSIDE_ALLOWED_ROOTS'], target).toContain(res.body.error.code)
      expect(res.body.error.message).toBeTruthy()
      expect(h.outbound, `${target} 不得出站`).toHaveLength(0)
    }
    // 工作区内的目录：必须是 NOT_A_FILE + hints 指明"要填文件路径"。
    const h = harnessWithWorkspace(() => json(200, {}), workspace)
    const res = await h.call(`${WASM_APPS_PREFIX}/publish`, 'POST', publishPath(workspace))
    expect(res.body.error.code).toBe('WASM_PATH_NOT_A_FILE')
    expect(res.body.error.details.kind).toBe('directory')
    expect(String(res.body.error.hints.join(' '))).toContain('文件')
  })
})

// ---------------------------------------------------------------------------
// 7. 分片上传的字段契约与服务端 upload.go 对拍（FIX-43）
// ---------------------------------------------------------------------------

/**
 * 跨端契约断言。
 *
 * 为什么要有这一组：分片链路的字段名过去是**客户端单方面假定**的
 * （`{app_id,size,chunks}` / complete 带 app_id），与服务端 `uploadCreateRequest`
 * 对不上 ⇒ 真实服务端会直接 400，而假网关（按客户端假定建模）永远测不出来。
 *
 * 期望值**逐条抄自服务端**（不要去改这里去迁就客户端：客户端错了就改客户端）：
 *   - `server/internal/wasmapp/api/upload.go:96-102`  `uploadCreateRequest`
 *     ⇒ `{app_id, version, total_bytes, chunk_bytes}`
 *   - `server/internal/wasmapp/upload/upload.go:97-102` 语义：`total_bytes` 必须
 *     **恰好等于各片之和**（:903-912），`chunk_bytes` ∈ [64 KiB, 8 MiB]（:479-487）
 *   - `server/internal/wasmapp/api/upload.go:140-145` 201 体
 *     ⇒ `{upload_id, received, chunk_bytes, expires_at}`
 *   - `server/internal/wasmapp/api/upload.go:186-189` PUT 200 体
 *     ⇒ `{received, received_bytes}`
 *   - `server/internal/wasmapp/api/upload.go:272-277` GET 200 体
 *     ⇒ `{received, received_bytes, total_bytes, expires_at}`
 *   - `server/internal/wasmapp/api/upload.go:328`（`uploadPayload`）+
 *     `:381-401`（`checkCompletePayload`）complete 体
 *     ⇒ 只有 `{title, changelog, config}`；带 `wasm_base64` 即拒，
 *       `app_id`/`version` **取会话元数据**（请求体里带也只会被当防呆校验）
 *
 * 变异验证：把客户端的 `total_bytes`/`chunk_bytes` 改回 `size`/`chunks`、或让
 * complete 重新带上 `app_id`/`version` ⇒ 这一组逐条变红。
 */
describe('分片上传字段契约：与服务端 upload.go 逐字对拍（FIX-43）', () => {
  /** 17 MiB ⇒ 均分 3 片（`planChunks` 的确定性切法）。 */
  const payload = Buffer.alloc(17 * 1024 * 1024, 7)

  function chunkHarness(): Harness {
    return harness((method, url) => {
      if (method === 'POST' && url.endsWith('/uploads')) return json(201, {
        upload_id: 'UP-CONTRACT',
        received: [],
        chunk_bytes: 5_949_057,
        expires_at: '2026-09-18T00:00:00Z',
      })
      if (method === 'PUT') return json(200, { received: [0], received_bytes: 1 })
      if (method === 'GET' && url.endsWith('/uploads/UP-CONTRACT')) {
        return json(200, { received: [0, 1, 2], received_bytes: 1, total_bytes: 1, expires_at: 'x' })
      }
      if (method === 'POST' && url.endsWith('/complete')) return json(201, { ok: true, version: '1.0.0', status: 'approved' })
      throw new Error(`unexpected ${method} ${url}`)
    })
  }

  it('POST /uploads 的字段名与取值 = upload.go:96-102 的 uploadCreateRequest', async () => {
    const h = chunkHarness()
    const res = await h.call(`${WASM_APPS_PREFIX}/publish`, 'POST', JSON.stringify({
      app_id: 'demo-tool', version: '2026.9.18', title: '演示', changelog: '首版', wasm_base64: payload.toString('base64'),
    }))
    expect(res.code).toBe(201)
    const opened = h.outbound.find(o => o.method === 'POST' && o.url.endsWith('/uploads'))!
    // 唯一权威断言：键集合逐字相等（多一个键就是漂移）。
    expect(Object.keys(JSON.parse(opened.body)).sort()).toEqual(['app_id', 'chunk_bytes', 'total_bytes', 'version'])
    const body = JSON.parse(opened.body) as { app_id: string, version: string, total_bytes: number, chunk_bytes: number }
    expect(body.app_id).toBe('demo-tool')
    expect(body.version).toBe('2026.9.18')
    // total_bytes 必须恰好等于各片之和（upload/upload.go:903-912）。
    expect(body.total_bytes).toBe(payload.byteLength)
    // chunk_bytes ∈ [64 KiB, 8 MiB]（upload/upload.go:479-487）。
    expect(body.chunk_bytes).toBeGreaterThanOrEqual(UPLOAD_CHUNK_MIN_BYTES)
    expect(body.chunk_bytes).toBeLessThanOrEqual(UPLOAD_CHUNK_MAX_BYTES)
    // 服务端用它算片序号上界（`ChunkCount = ceil(total_bytes/chunk_bytes)`）：
    // 必须恰好等于客户端实际发出的片数，否则最后一片会被判越界。
    const putIndexes = h.outbound.filter(o => o.method === 'PUT').map(o => o.url.split('/').pop())
    expect(Math.ceil(body.total_bytes / body.chunk_bytes)).toBe(putIndexes.length)
  })

  it('PUT /uploads/:upload_id/chunks/:index = upload.go:152-190（路径 + octet-stream 原始片）', async () => {
    const h = chunkHarness()
    await h.call(`${WASM_APPS_PREFIX}/publish`, 'POST', JSON.stringify({
      app_id: 'demo-tool', version: '1.0.0', wasm_base64: payload.toString('base64'),
    }))
    const puts = h.outbound.filter(o => o.method === 'PUT')
    expect(puts.map(o => o.url)).toEqual([
      'https://harness.example/api/client/v2/apps/wasm/uploads/UP-CONTRACT/chunks/0',
      'https://harness.example/api/client/v2/apps/wasm/uploads/UP-CONTRACT/chunks/1',
      'https://harness.example/api/client/v2/apps/wasm/uploads/UP-CONTRACT/chunks/2',
    ])
    expect(puts.every(o => o.contentType === 'application/octet-stream')).toBe(true)
    // 片字节逐字节对拍（服务端拼接后必须等于原模块）。
    const joined = Buffer.concat(puts.map(o => Buffer.from(o.body, 'base64')))
    expect(joined.equals(payload)).toBe(true)
  })

  it('GET /uploads/:upload_id = upload.go:252-278（续传查询只读 received[]）', async () => {
    const h = harness((method, url) => {
      if (method === 'GET' && url.endsWith('/uploads/UP-PREV')) {
        return json(200, { received: [0, 2], received_bytes: 2, total_bytes: payload.byteLength, expires_at: 'x' })
      }
      if (method === 'PUT') return json(200, { received: [1], received_bytes: 1 })
      if (method === 'POST' && url.endsWith('/complete')) return json(201, { ok: true })
      throw new Error(`unexpected ${method} ${url}`)
    })
    const res = await h.call(`${WASM_APPS_PREFIX}/publish`, 'POST', JSON.stringify({
      app_id: 'demo-tool', version: '1.0.0', wasm_base64: payload.toString('base64'), upload_id: 'UP-PREV',
    }))
    expect(res.code).toBe(201)
    expect(h.outbound[0]!.method).toBe('GET')
    expect(h.outbound[0]!.url).toBe('https://harness.example/api/client/v2/apps/wasm/uploads/UP-PREV')
    // 服务端已收到的 0/2 不重传。
    expect(h.outbound.filter(o => o.method === 'PUT').map(o => o.url.split('/').pop())).toEqual(['1'])
  })

  it('POST /uploads/:upload_id/complete 只发 {title,changelog,config} = upload.go:328/381-401', async () => {
    const h = chunkHarness()
    const res = await h.call(`${WASM_APPS_PREFIX}/publish`, 'POST', JSON.stringify({
      app_id: 'demo-tool',
      version: '1.0.0',
      title: '演示工具',
      changelog: '首版：支持导出',
      config: { access: 'whitelist', whitelist: ['alice'], purpose: '值班', data_sensitivity: 'internal', owner: 'alice' },
      wasm_base64: payload.toString('base64'),
      upload_id: 'UP-CONTRACT',
    }))
    expect(res.code).toBe(201)
    const complete = h.outbound.find(o => o.url.endsWith('/complete'))!
    const body = JSON.parse(complete.body) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['changelog', 'config', 'title'])
    expect(body.title).toBe('演示工具')
    expect(body.changelog).toBe('首版：支持导出')
    expect(body.config).toEqual({
      access: 'whitelist', whitelist: ['alice'], purpose: '值班', data_sensitivity: 'internal', owner: 'alice',
    })
    // 这两个字段出现即被服务端拒（upload.go:382-399）：complete 不是第二个"发布"入口。
    expect(body.app_id).toBeUndefined()
    expect(body.version).toBeUndefined()
    expect(complete.body).not.toContain('wasm_base64')
  })

  it('审计 P2-1：某一跳传输失败也回**可续传**的 UPLOAD_INCOMPLETE（带 upload_id），不是笼统网关信封', async () => {
    // 形态：会话已开好（upload_id 已在手）、第一片 PUT 就断在传输层。
    // 旧实现直接把网关信封回出去 ⇒ 模型拿到 502 GATEWAY_TIMEOUT、丢掉 upload_id，
    // 只能重开会话从头再传，而慢链路下重来往往撞上同一堵墙。
    const payload = Buffer.alloc(17 * 1024 * 1024, 9)
    const h = harness((method, url) => {
      if (method === 'POST' && url.endsWith('/uploads')) {
        return json(201, { upload_id: 'UP-BUDGET', received: [], chunk_bytes: 5_949_057, expires_at: 'x' })
      }
      if (method === 'PUT') {
        throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
      }
      throw new Error(`unexpected ${method} ${url}`)
    })
    const res = await h.call(`${WASM_APPS_PREFIX}/publish`, 'POST', JSON.stringify({
      app_id: 'demo-tool', version: '1.0.0', wasm_base64: payload.toString('base64'),
    }))
    expect(res.body.error.code).toBe('UPLOAD_INCOMPLETE')
    // 续传的唯一凭据必须在（这条断言就是审计发现的判据本身）。
    expect(res.body.error.details.upload_id).toBe('UP-BUDGET')
    expect(res.body.error.details.received).toEqual([])
    expect(res.body.error.details.chunks).toBeGreaterThan(1)
    // 传输层的真实 code 带出来（模型据此区分"网络/超时"与"服务端拒了某一片"）。
    expect(res.body.error.details.transport_code).toBe('GATEWAY_TIMEOUT')
    expect(String(res.body.error.hints.join(' '))).toContain('upload_id')
    // 只发一次 PUT（没有把同一片重试三轮）、没有多余的 received[] 刷新、
    // 也没有走到 complete —— 传输断了就立刻收口，不再烧预算。
    expect(h.outbound.filter(o => o.method === 'PUT')).toHaveLength(1)
    expect(h.outbound.filter(o => o.method === 'GET')).toHaveLength(0)
    expect(h.outbound.some(o => o.url.endsWith('/complete'))).toBe(false)
  })

  it('审计 P2-1：分片链路的总预算 = 单次预算（分片不是"更大包的额外额度"）', () => {
    // 每次出站都用剩余额度（见下一条源级门禁），所以"总预算"必须有界；
    // 它与工具 deadline 的序关系由 wasm-app-tools.spec.ts 的预算不变量钉住。
    expect(CHUNKED_PUBLISH_BUDGET_MS).toBe(CLIENT_UPLOAD_TIMEOUT_MS)
  })

  it('审计 P2-1：分片链路不再逐跳各给一份 90 秒（源级回归门禁）', () => {
    // 结构断言：publishChunked 里每一次出站都必须用**剩余额度**（perCallBudget），
    // 出现裸 CLIENT_UPLOAD_TIMEOUT_MS 即等于"每跳各 90 秒"，聚合必然溢出工具预算。
    const source = readFileSync(fileURLToPath(new URL('../src/wasm-apps.ts', import.meta.url)), 'utf8')
    const start = source.indexOf('async function publishChunked(')
    expect(start, 'publishChunked 必须存在（函数改名时同步改这条）').toBeGreaterThan(0)
    const body = source.slice(start, source.indexOf('\n/**\n * 分片链路 `complete` 的请求体', start))
    expect(body).toContain('perCallBudget()')
    expect(body, 'publishChunked 内不得再出现裸的 CLIENT_UPLOAD_TIMEOUT_MS').not.toContain('CLIENT_UPLOAD_TIMEOUT_MS')
  })

  it('缺 version 时本地就拒（服务端开会话必须要有它；不发半截请求）', async () => {
    const h = chunkHarness()
    const res = await h.call(`${WASM_APPS_PREFIX}/publish`, 'POST', JSON.stringify({
      app_id: 'demo-tool', wasm_base64: payload.toString('base64'),
    }))
    expect(res.code).toBe(400)
    expect(res.body.error.code).toBe('MISSING_FIELD')
    expect(h.outbound).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 8. 健壮性：畸形输入不得让 handler 抛异常（FIX-40，本地 API 一律 JSON 信封）
// ---------------------------------------------------------------------------

/**
 * 上游 webserver 对 handler 抛出的异常只发 `writeHead(400); res.end()` —— **无 body**。
 * 对"第一消费者是 AI"的本模块来说，空 body 等于让它完全无法自修，因此所有畸形输入
 * 都必须在 handler 内部转成结构化信封。
 *
 * 变异验证：把 `decodePathSegments` 的 try/catch 去掉（改回裸 `decodeURIComponent`）
 * ⇒ 前两条红（异常抛穿）；把段解码改成 `decodeURIComponent` 但只 catch 不 fail ⇒
 * "有 code/hints" 的断言红。
 */
describe('健壮性：畸形百分号转义 ⇒ 结构化 400（FIX-40）', () => {
  const malformed = ['%zz', '%E0%A4%A', '%', '%2', '%GG']

  it('路径段里的畸形转义不会抛穿 handler，且回 JSON 信封（code/message/hints）', async () => {
    const h = harness(() => json(200, { ok: true }))
    for (const bad of malformed) {
      let thrown: unknown = null
      let out: Captured | null = null
      try {
        out = await h.call(`${WASM_APPS_PREFIX}/${bad}/diagnostics`)
      } catch (cause) { thrown = cause }
      expect(thrown, `${bad} 抛穿 handler：${String(thrown)}`).toBeNull()
      expect(out!.code, bad).toBe(400)
      expect(out!.body.error.code, bad).toBe('INVALID_PATH')
      expect(typeof out!.body.error.message, bad).toBe('string')
      expect(Array.isArray(out!.body.error.hints), bad).toBe(true)
      // hints 必须点明"非法百分号转义"，否则 AI 只会重试同一个路径。
      expect(String(out!.body.error.hints.join(' ')), bad).toContain('百分号')
      expect(out!.body.error.details.path, bad).toContain(WASM_APPS_PREFIX)
    }
    // 畸形路径不得触达上游。
    expect(h.outbound).toHaveLength(0)
  })

  it('畸形转义出现在 app_id 段同样结构化 400（不是 404、更不是异常）', async () => {
    const h = harness(() => json(200, { ok: true }))
    for (const bad of malformed) {
      let thrown: unknown = null
      let out: Captured | null = null
      try {
        out = await h.call(`${WASM_APPS_PREFIX}/${bad}/publish`, 'POST', '{}')
      } catch (cause) { thrown = cause }
      expect(thrown, `${bad} 抛穿 handler`).toBeNull()
      expect([400], `${bad} ⇒ ${out!.code}`).toContain(out!.code)
      expect(out!.body.error.code).toBe('INVALID_PATH')
    }
    expect(h.outbound).toHaveLength(0)
  })

  it('decodePathSegments 是纯函数：合法路径解码、非法转义回 null（不发异常）', () => {
    expect(decodePathSegments('')).toEqual([])
    expect(decodePathSegments('demo/diagnostics')).toEqual(['demo', 'diagnostics'])
    expect(decodePathSegments('demo%20tool')).toEqual(['demo tool'])
    for (const bad of malformed) expect(decodePathSegments(`demo/${bad}`)).toBeNull()
  })

  it('对照：合法的百分号编码仍然正常工作（不是"一律拒绝"）', async () => {
    const h = harness(() => json(200, { ok: true }))
    const out = await h.call(`${WASM_APPS_PREFIX}/demo%2Dtool/diagnostics`)
    expect(out.code).toBe(200)
    expect(h.outbound[0]!.url).toBe('https://harness.example/api/client/v2/apps/wasm/demo-tool/diagnostics')
  })
})
