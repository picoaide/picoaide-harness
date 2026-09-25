/**
 * R19B-03（第十九轮审计）：AI 读应用行数据的授权必须**按 用户 ⊕ 服务端 ⊕ 应用** 记录。
 *
 * 缺陷形态（修前）：`wasm-apps-ai-rows-consent.ts` 的键只有 `app_id`（机器级），
 * 于是同一台机器**换账号**、或把客户端**指向另一个服务端（换租户）** 之后，下一个人
 * 原样继承上一个人的授权 —— 被绕过的正是"默认关 + 显式授权卡"这条产品拍板本身。
 * 兄弟闸门 `packages/host/wasm-apps-host/src/ai-authorization.ts` 的模块头早就把口径
 * 写死："换账号（或换服务端地址 ⇒ 不同 username）**不得**继承上一个人的授权"。
 *
 * 本文件把 temp/r19/B 探针的两条断言落成仓内判据（走**仓内 import 路径**，不依赖
 * `temp/`），并补上修法要求的另外三条：
 *
 *  1. 换账号后不得继承（同机同数据根，重启后仍不继承）；
 *  2. 换服务端地址后不得继承（同一用户名、同一数据根）；
 *  3. 拿不到作用域（未登录 / 缺用户名 / 缺服务端地址）时**写面必须拒绝**，
 *     且一个字都不落盘（路由侧 = 401 `AUTH_REQUIRED`，与兄弟闸门同形）；
 *  4. v1 旧文件（`{version:1, apps:[…]}`）**整体判为未授权**（方向安全：旧记录
 *     不得被当成已授权）；
 *  5. 读面与写面共用同一个键构造点 / 同一实例：作用域在**每次调用**时从会话解析
 *     （登录、换账号、换服务端都发生在同一个进程里 —— 构造期快照会让 B 继承 A）。
 *
 * ---- 变异验证（拆掉修复即红）----
 *   - 键退回只按 `app_id`（`aiRowsConsentKey` 忽略 scope）⇒ 第 1、2 组全红；
 *   - 作用域在 store 构造期快照（`scope()` 只调一次）⇒「同一实例内换账号」那几条红；
 *   - 拿不到作用域时写面照写（落一条 `''\0''\0app`）⇒ 第 3 组与「一个字都没落盘」红；
 *   - `parseAiRowsConsent` 容忍 v1 ⇒ 第 4 组红；
 *   - 路由不把作用域拒绝映射成 401（吞成 500/200）⇒ 第 3 组的路由断言红。
 */
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { apply, type Config as AuthGateConfig } from '../src/auth-gate.ts'
import { WASM_APPS_PREFIX } from '../src/wasm-apps.ts'
import { AI_ROWS_NOT_AUTHORIZED } from '../src/wasm-app-tools.ts'
import {
  AI_ROWS_CONSENT_FILE_NAME,
  AI_ROWS_CONSENT_FORMAT_VERSION,
  aiRowsConsentKey,
  createAiRowsConsentStore,
  isAiRowsConsentScopeError,
  parseAiRowsConsent,
} from '../src/wasm-apps-ai-rows-consent.ts'
import type { Session } from '../src/server-connector/config.ts'

/** 员工 A（租户 1）。 */
const ALICE: Session = {
  serverURL: 'https://harness.example',
  username: 'alice',
  token: 'USER-TOKEN-a',
  role: 'employee',
}

/** 员工 B：同一台机器、同一个数据根、同一个服务端。 */
const BOB: Session = { ...ALICE, username: 'bob', token: 'USER-TOKEN-b' }

/** 员工 A 在**另一台服务端**（换租户：同一个用户名，另一段作用域）。 */
const ALICE_OTHER_TENANT: Session = { ...ALICE, serverURL: 'https://other.example' }

/**
 * 「拿不到作用域」的三种会话形态（服务端可能下发空字段；服务缺席时的历史上限是
 * `username` 为空字符串）—— 它们都必须 fail-closed。
 */
const NO_USER: Session = { ...ALICE, username: '' }
const BLANK_USER: Session = { ...ALICE, username: '   ' }
const NO_SERVER: Session = { ...ALICE, serverURL: '' }

interface ToolDef {
  name: string
  execute: (args: unknown, exec: unknown) => Promise<any>
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
  /** 换账号 / 换服务端（同一个插件实例内，不重新 apply）。 */
  setSession: (session: Session | null) => void
  call: (url: string, method?: string, body?: string) => Promise<Captured>
  run: (name: string, args: Record<string, unknown>) => Promise<any>
}

/** 服务端 rows 的最小成功响应（形状与 `server/internal/wasmapp/api/rows.go` 一致）。 */
const ROWS_BODY = {
  rows: {
    app_id: 'shared-notes',
    table: 'notes',
    columns: [{ name: 'title', type: 'TEXT', sensitive: false }],
    rows: [['hello']],
    limit: 50,
    offset: 0,
    returned: 1,
    total_rows: 1,
    has_more: false,
    truncated: false,
    truncated_values: 0,
    unmask: false,
    masked_columns: [],
    value_max_bytes: 4096,
  },
}

const json = (status: number, payload: unknown): Response =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })

/**
 * 装一个**真实的** auth-gate（真路由 + 真工具注册 + 真 store 装配），只把出站 `fetch`
 * 换成假网关。会话由一个可变变量提供 —— 这正是"同一个进程里换账号"的真实形态。
 * @param initial - 初始会话。
 * @returns 可调用路由 / 工具并切换会话的探针。
 */
function harness(initial: Session | null): Harness {
  const routes: Route[] = []
  const tools: ToolDef[] = []
  const outbound: Outbound[] = []
  let current: Session | null = initial
  const ctx = {
    effect: (fn: () => unknown) => { fn() },
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
      isLoggedIn: () => current !== null,
      getSession: () => current,
      setSession: vi.fn(),
      clear: () => { current = null },
    },
    webServer: {
      tapIndex: () => () => {},
      register: (route: Route) => { routes.push(route); return () => {} },
    },
  }
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
    outbound.push({ method: init?.method ?? 'GET', url: String(url) })
    return json(200, ROWS_BODY)
  }))
  apply(ctx as never, {} as AuthGateConfig)
  const route = routes.find(entry => entry.kind === 'prefix' && entry.path === WASM_APPS_PREFIX)
  if (route === undefined) throw new Error('wasm apps route not registered')
  return {
    outbound,
    setSession: (session) => { current = session },
    call: async (url, method = 'GET', body) => {
      const host = '127.0.0.1:3080'
      const request = {
        method,
        url,
        headers: {
          origin: `http://${host}`,
          host,
          'sec-fetch-site': 'same-origin',
          cookie: `dsh-auth-${host}=v1.sig`,
        },
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
async function readConsent(h: Harness, appId: string): Promise<Captured> {
  return await h.call(`${WASM_APPS_PREFIX}/${appId}/ai-rows-consent`, 'GET')
}

const ROWS_ARGS = { appId: 'shared-notes', table: 'notes' }

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'pico-ai-rows-scope-'))
  vi.stubEnv('DSH_HOME', home)
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await rm(home, { recursive: true, force: true })
})

const consentFile = (): string => join(home, AI_ROWS_CONSENT_FILE_NAME)

// ---------------------------------------------------------------------------
// 1. 换账号：同一个插件实例内 + 重启之后
// ---------------------------------------------------------------------------

describe('换账号不得继承上一个人的读行授权（同机同数据根）', () => {
  it('A 授权后切到 B：读面 false、工具拒绝且零出站；A 回来仍在', async () => {
    const h = harness(ALICE)
    expect((await authorize(h, 'shared-notes')).code).toBe(200)
    expect((await readConsent(h, 'shared-notes')).body).toEqual({ app_id: 'shared-notes', enabled: true })
    expect((await h.run('wasm_app_rows', ROWS_ARGS)).ok).toBe(true)

    // —— 换账号（同一个进程、同一个插件实例、同一个数据根）——
    h.setSession(BOB)
    expect((await readConsent(h, 'shared-notes')).body).toEqual({ app_id: 'shared-notes', enabled: false })
    const denied = await h.run('wasm_app_rows', ROWS_ARGS)
    expect(denied.ok).toBe(false)
    expect(denied.error.code).toBe(AI_ROWS_NOT_AUTHORIZED)
    const before = h.outbound.length

    // A 回来：那是 A 自己的记录，仍在（撤销/授权只影响当前作用域）。
    h.setSession(ALICE)
    expect((await readConsent(h, 'shared-notes')).body).toEqual({ app_id: 'shared-notes', enabled: true })

    // B 那一轮没有新增任何出站（"拒绝"必须发生在网关之前）。
    expect(h.outbound.length).toBe(before)
  })

  it('重启（新的插件实例、同一个数据根）后 B 仍然看不到 A 的授权', async () => {
    const first = harness(ALICE)
    await authorize(first, 'shared-notes')

    const second = harness(BOB)
    expect((await readConsent(second, 'shared-notes')).body).toEqual({ app_id: 'shared-notes', enabled: false })
    expect((await second.run('wasm_app_rows', ROWS_ARGS)).error.code).toBe(AI_ROWS_NOT_AUTHORIZED)
    expect(second.outbound).toHaveLength(0)
  })

  it('落盘形状带三段作用域（结构性证据：不是"只有 app_id"）', async () => {
    const h = harness(ALICE)
    await authorize(h, 'shared-notes')
    const parsed = JSON.parse(await readFile(consentFile(), 'utf8')) as { version: number, grants: unknown }
    expect(parsed.version).toBe(AI_ROWS_CONSENT_FORMAT_VERSION)
    expect(parsed.grants).toEqual([{ user: 'alice', server: ALICE.serverURL, app: 'shared-notes' }])
  })
})

// ---------------------------------------------------------------------------
// 2. 换服务端（换租户）：同一个用户名也不是同一段作用域
// ---------------------------------------------------------------------------

describe('换服务端地址不得继承（同一个用户名、同一台机器）', () => {
  it('同一实例内切到另一台服务端 ⇒ 未授权；工具拒绝', async () => {
    const h = harness(ALICE)
    await authorize(h, 'shared-notes')
    h.setSession(ALICE_OTHER_TENANT)
    expect((await readConsent(h, 'shared-notes')).body).toEqual({ app_id: 'shared-notes', enabled: false })
    expect((await h.run('wasm_app_rows', ROWS_ARGS)).error.code).toBe(AI_ROWS_NOT_AUTHORIZED)
    expect(h.outbound).toHaveLength(0)
  })

  it('两台服务端各授权各的：记录并存、互不可见', async () => {
    const h = harness(ALICE)
    await authorize(h, 'shared-notes')
    h.setSession(ALICE_OTHER_TENANT)
    expect((await readConsent(h, 'shared-notes')).body.enabled).toBe(false)
    await authorize(h, 'shared-notes')

    const parsed = JSON.parse(await readFile(consentFile(), 'utf8')) as { grants: unknown[] }
    expect(parsed.grants).toHaveLength(2)
    // 回到租户 1：租户 1 的记录仍在，租户 2 的那条不会被误当成它。
    h.setSession(ALICE)
    expect((await readConsent(h, 'shared-notes')).body.enabled).toBe(true)
  })

  it('store 级：三段的键互不相等（键构造是唯一实现）', () => {
    const base = aiRowsConsentKey({ user: 'alice', server: 'https://a.example' }, 'notes')
    expect(base).toBe('alice\u0000https://a.example\u0000notes')
    expect(aiRowsConsentKey({ user: 'bob', server: 'https://a.example' }, 'notes')).not.toBe(base)
    expect(aiRowsConsentKey({ user: 'alice', server: 'https://b.example' }, 'notes')).not.toBe(base)
    expect(aiRowsConsentKey({ user: 'alice', server: 'https://a.example' }, 'other')).not.toBe(base)
  })

  it('源码级：读面与写面共用**同一个**键构造点（只允许一份实现）', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/wasm-apps-ai-rows-consent.ts', import.meta.url)), 'utf8')
    const isEnabledBody = /async isEnabled\(appId: string\): Promise<boolean> \{([\s\S]*?)\n {4}\},/u.exec(source)?.[1]
    const setEnabledBody = /setEnabled\(appId: string, enabled: boolean\): Promise<void> \{([\s\S]*?)\n {4}\},\n {2}\}/u.exec(source)?.[1]
    expect(isEnabledBody, 'isEnabled 方法体没找到（源码形状变了，请同步这条判据）').toBeDefined()
    expect(setEnabledBody, 'setEnabled 方法体没找到（源码形状变了，请同步这条判据）').toBeDefined()
    // 两处都必须经 `keyFor`，不得各自拼键（各自拼 = 判据键与记账键可能不同源）。
    expect(isEnabledBody).toContain('keyFor(appId)')
    expect(setEnabledBody).toContain('keyFor(appId)')
    // `aiRowsConsentKey` 在 store 里只出现一次（就是 keyFor 那一行）。
    expect(source.match(/aiRowsConsentKey\(currentScope\(\)/gu) ?? []).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// 3. 拿不到作用域 ⇒ 写面拒绝（fail-closed；路由 401，与兄弟闸门同形）
// ---------------------------------------------------------------------------

describe('拿不到作用域时：读面 false、写面拒绝、一个字都不落盘', () => {
  it('store 级：没有 scope 来源 ⇒ isEnabled false 且 setEnabled 抛可判因的作用域错误', async () => {
    const store = createAiRowsConsentStore({ file: consentFile() })
    expect(await store.isEnabled('notes')).toBe(false)
    const rejection = await store.setEnabled('notes', true).then(() => null, (cause: unknown) => cause)
    expect(isAiRowsConsentScopeError(rejection)).toBe(true)
    expect(existsSync(consentFile())).toBe(false)
  })

  it('store 级：作用域缺任一段（用户名空 / 纯空白 / 服务端空）⇒ 同样拒绝', async () => {
    for (const scope of [
      { user: '', server: 'https://a.example' },
      { user: '   ', server: 'https://a.example' },
      { user: 'alice', server: '' },
      { user: 'alice', server: '   ' },
    ]) {
      const store = createAiRowsConsentStore({ file: consentFile(), scope: () => scope })
      expect(await store.isEnabled('notes'), JSON.stringify(scope)).toBe(false)
      const rejection = await store.setEnabled('notes', true).then(() => null, (cause: unknown) => cause)
      expect(isAiRowsConsentScopeError(rejection), JSON.stringify(scope)).toBe(true)
    }
    expect(existsSync(consentFile())).toBe(false)
  })

  it('路由级：未登录 / 用户名空 / 服务端空 ⇒ POST 回 401 AUTH_REQUIRED，GET 回 false', async () => {
    for (const session of [null, NO_USER, BLANK_USER, NO_SERVER]) {
      const h = harness(session)
      const post = await authorize(h, 'shared-notes')
      expect(post.code, JSON.stringify(session)).toBe(401)
      expect(post.body?.error?.code, JSON.stringify(session)).toBe('AUTH_REQUIRED')
      if (session !== null) {
        // 未登录时路由在更外层就 401 了（拿不到会话），读面断言只对"有会话但缺字段"有意义。
        expect((await readConsent(h, 'shared-notes')).body).toEqual({ app_id: 'shared-notes', enabled: false })
      }
      expect(h.outbound).toHaveLength(0)
    }
    // 一次都没落盘：拒绝不是"写了一条空作用域记录"。
    expect(existsSync(consentFile())).toBe(false)
  })

  it('登录态恢复了就能授权（拒绝是"当前拿不到作用域"，不是永久锁死）', async () => {
    const h = harness(null)
    expect((await authorize(h, 'shared-notes')).code).toBe(401)
    h.setSession(ALICE)
    expect((await authorize(h, 'shared-notes')).code).toBe(200)
    expect((await h.run('wasm_app_rows', ROWS_ARGS)).ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 4. v1 旧文件：整体判为未授权（方向安全）
// ---------------------------------------------------------------------------

describe('v1（机器级）旧记录不得被当成已授权', () => {
  it('读面 / 工具 / 解析三处一致地判为未授权', async () => {
    await writeFile(consentFile(), JSON.stringify({ version: 1, apps: ['shared-notes'] }), { mode: 0o600 })
    expect(parseAiRowsConsent(await readFile(consentFile(), 'utf8'))).toBeNull()

    const h = harness(ALICE)
    expect((await readConsent(h, 'shared-notes')).body).toEqual({ app_id: 'shared-notes', enabled: false })
    expect((await h.run('wasm_app_rows', ROWS_ARGS)).error.code).toBe(AI_ROWS_NOT_AUTHORIZED)
    expect(h.outbound).toHaveLength(0)
  })

  it('升级后重新授权会就地改写成 v2（v1 记录就此作废，不会被合并回来）', async () => {
    await writeFile(consentFile(), JSON.stringify({ version: 1, apps: ['shared-notes', 'other-app'] }), { mode: 0o600 })
    const h = harness(ALICE)
    expect((await authorize(h, 'shared-notes')).code).toBe(200)
    const parsed = JSON.parse(await readFile(consentFile(), 'utf8')) as { version: number, grants: unknown[] }
    expect(parsed.version).toBe(AI_ROWS_CONSENT_FORMAT_VERSION)
    expect(parsed.grants).toEqual([{ user: 'alice', server: ALICE.serverURL, app: 'shared-notes' }])
  })

  it('store 级：v1 文件对任何作用域都是未授权（不是"只对当前用户"）', async () => {
    await writeFile(consentFile(), JSON.stringify({ version: 1, apps: ['notes'] }), { mode: 0o600 })
    const alice = createAiRowsConsentStore({ file: consentFile(), scope: () => ({ user: 'alice', server: 'https://a.example' }) })
    const bob = createAiRowsConsentStore({ file: consentFile(), scope: () => ({ user: 'bob', server: 'https://a.example' }) })
    expect(await alice.isEnabled('notes')).toBe(false)
    expect(await bob.isEnabled('notes')).toBe(false)
  })
})
