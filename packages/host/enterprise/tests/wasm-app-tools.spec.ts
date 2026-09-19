/**
 * WASM 应用平台**宿主工具面**的契约测试（`wasm_app_list` / `wasm_app_validate` /
 * `wasm_app_publish`，设计基线 `docs/planning/2026-09-17-wasm-app-platform.md` §6.5b）。
 *
 * 覆盖的是「AI 能不能自己发布」这一段：
 *
 *  - **装配**：`inject` 声明、三个工具的注册、预算序关系（工具 deadline > 出站 90 s）；
 *  - **参数契约**：每个参数都有说明、必填集合固定、`config` 的字段集合与首版必填
 *    与服务端字段表/limits 对拍 —— 这是"AI 知道该填什么"的机器可验证落点；
 *  - **行为**：假网关 + 真工具调用（断言出站路径与载荷）、>8 MiB 自动分片、
 *    服务端错误信封**原样**带出、未登录/审计账号明确拒绝且零出站、令牌不外泄；
 *  - **结构**：本地路由与宿主工具命中**同一个** `publishApp`（计数 spy），
 *    且两条路径产生的出站请求逐字节相同 —— 防"复制一份编排"的回归。
 *
 * ---- 变异验证（把闸门改回危险实现时，哪条用例必红）----
 *
 *   - 去掉 `inject` 里的 `'tools'` → 「inject 声明了 tools」红；
 *   - 去掉 `registerWasmAppTools` 的注册（或改名）→「三个工具都注册」整组红；
 *   - `WASM_APP_TOOL_TIMEOUT_MS` 改回 30 s（既有技能上传的值）→「预算序关系」红；
 *   - 工具里换成自己复制一份编排（不再调 `publishApp`）→「命中同一个实现」红；
 *   - 工具直接出站而不做 `wasm_path` 读取面校验 →「越界/目录被拒且零出站」红；
 *   - 错误结果里重新序列化信封（丢掉 hints/details）→「信封原样带出」红；
 *   - `config` 的字段名或必填标志漂移 →「配置字段与常量一致」+ limits/appcfg 对拍红；
 *   - 未登录/审计账号放行 →「明确拒绝且零出站」两条红。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { apply, inject as authGateInject, type Config as AuthGateConfig } from '../src/auth-gate.ts'
import * as authConnector from '../src/server-connector/auth.ts'
import * as wasmApps from '../src/wasm-apps.ts'
import { CLIENT_UPLOAD_TIMEOUT_MS, WASM_APPS_PREFIX } from '../src/wasm-apps.ts'
import {
  APP_CONFIG_ACCESS_MODES,
  APP_CONFIG_DEFAULT_ACCESS,
  APP_CONFIG_FIELDS,
  APP_CONFIG_FIELD_DESCRIPTIONS,
  APP_CONFIG_FIRST_RELEASE_REQUIRED,
  WASM_APP_TOOL_NAMES,
  WASM_APP_TOOL_TIMEOUT_MS,
  skillHintAppliesTo,
  wasmAppToolHeadroomMs,
} from '../src/wasm-app-tools.ts'
import { APP_BUILDER_SKILL } from '../src/builtin-skills.ts'
import type { Session } from '../src/server-connector/config.ts'

// `publishApp` 换成计数 spy（实现不变）：这样"路由"与"工具"两条路径是否命中**同一个
// 函数"就成了可断言的事实，而不是靠人读代码。mock 是文件级的 —— auth-gate（路由）
// 与 wasm-app-tools（工具）拿到的都是这个 spy。
vi.mock('../src/wasm-apps.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/wasm-apps.ts')>()
  return { ...actual, publishApp: vi.fn(actual.publishApp) }
})

// 出站原语也换成计数 spy：它是**跨模块**导入（wasm-apps.ts ← server-connector/auth.ts），
// 因此路由与工具两条路径都会命中它 —— 这是"两条路径共用同一条出站链路"的直接计数器。
vi.mock('../src/server-connector/auth.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/server-connector/auth.ts')>()
  return { ...actual, gatewayFetch: vi.fn(actual.gatewayFetch) }
})

const SESSION: Session = {
  serverURL: 'https://harness.example',
  username: 'alice',
  token: 'USER-TOKEN-abc',
  role: 'employee',
}

const AUDITOR: Session = { ...SESSION, username: 'audit', role: 'auditor' }

const TOKEN = SESSION.token

/** 工具定义（只看测试要用到的字段）。 */
interface ToolDef {
  name: string
  description: string
  parameters: {
    type?: string
    properties?: Record<string, Record<string, unknown>>
    required?: string[]
  }
  output: { schema: Record<string, unknown>, render: (args: unknown, value: unknown) => Array<{ type: string, text: string }> }
  timeoutMs?: number
  isConcurrencySafe?: (args: unknown) => boolean
  execute: (args: unknown, exec: unknown) => Promise<unknown>
}

interface Outbound {
  method: string
  url: string
  body: string
  contentType: string
}

interface Captured {
  code: number
  text: string
  body: any
}

interface Route {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void
}

interface Harness {
  tools: ToolDef[]
  outbound: Outbound[]
  cleared: number
  loggedErrors: string[]
  /** 走本机路由（HTTP 形态，与 wasm-apps.spec.ts 同款假 req/res）。 */
  call: (url: string, method?: string, body?: string) => Promise<Captured>
  /** 走宿主工具（模型形态，经 `defineTool` 的真实参数校验）。 */
  run: (name: string, args: Record<string, unknown>) => Promise<any>
}

interface HarnessOptions {
  /** false = 最小组合（没有 tools 服务）：注册必须**明确报错**而不是抛。 */
  withTools?: boolean
  /**
   * `ctx.workspaceRegistry` 认得的工作区（结构类型，与 wasm-apps.spec.ts 同款）。
   *
   * 传函数而不是字符串：harness 有时在 `describe` 收集期就被调用，而工作区目录是
   * `beforeEach` 才建的 —— 用函数在**调用时**取值，负例才能真的落在"工作区之外"。
   */
  workspacePath?: () => string | null
}

/** 装一个真实的 auth-gate（真路由 + 真工具注册），出站 fetch 换成 `respond`。 */
function harness(
  respond: (method: string, path: string, init: { body: string, contentType: string }) => Response | Promise<Response>,
  session: Session | null = SESSION,
  options: HarnessOptions = {},
): Harness {
  const tools: ToolDef[] = []
  const routes: Route[] = []
  const outbound: Outbound[] = []
  const loggedErrors: string[] = []
  const state = { cleared: 0 }
  const ctx = {
    effect: (fn: () => unknown) => { fn() },
    get: (name: string) => {
      if (name === 'connection') return { requestRejection: () => undefined }
      if (name === 'workspaceRegistry') {
        const path = (options.workspacePath ?? ((): string | null => workspace))()
        return { list: () => (path === null ? [] : [{ id: 'w1', path }]) }
      }
      return undefined
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: (message: string) => { loggedErrors.push(message) },
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
    ...(options.withTools === false
      ? {}
      : { tools: { register: (definition: ToolDef) => { tools.push(definition); return () => {} } } }),
  }
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    const contentType = headers['Content-Type'] ?? ''
    const body = typeof init?.body === 'string'
      ? init.body
      : init?.body === undefined
        ? ''
        : contentType.includes('json')
          ? Buffer.from(init.body as Uint8Array).toString('utf8')
          : Buffer.from(init.body as Uint8Array).toString('base64')
    outbound.push({ method: init?.method ?? 'GET', url: String(url), body, contentType })
    return await respond(init?.method ?? 'GET', String(url), { body, contentType })
  }))
  apply(ctx as never, {} as AuthGateConfig)
  const route = routes.find(entry => entry.kind === 'prefix' && entry.path === WASM_APPS_PREFIX)
  if (route === undefined) throw new Error('wasm apps route not registered')
  return {
    tools,
    outbound,
    loggedErrors,
    get cleared() { return state.cleared },
    call: async (url, method = 'GET', body) => {
      const host = '127.0.0.1:3080'
      const request = {
        method,
        url,
        headers: { origin: `http://${host}`, host, 'sec-fetch-site': 'same-origin', cookie: `dsh-auth-${host}=v1.sig` },
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

const json = (status: number, payload: unknown): Response =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })

let home: string
let workspace: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'pico-wasm-tools-home-'))
  workspace = await mkdtemp(join(tmpdir(), 'pico-wasm-tools-ws-'))
  vi.stubEnv('DSH_HOME', home)
  vi.mocked(wasmApps.publishApp).mockClear()
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await rm(home, { recursive: true, force: true })
  await rm(workspace, { recursive: true, force: true })
})

/** 写一个真的 wasm 产物到会话工作区（工具面走的是 `wasm_path` 读取面）。 */
async function writeWasm(bytes: number, name = 'main.wasm'): Promise<string> {
  const path = join(workspace, name)
  await writeFile(path, Buffer.alloc(bytes, 7))
  return path
}

/** 完整的发布配置（三个声明字段是"首版必填"，工具 schema 也要求它们）。 */
const CONFIG = {
  access: 'whitelist',
  whitelist: ['alice', 'bob'],
  purpose: '共享便签：小团队的公共记录板',
  data_sensitivity: '内部',
  owner: 'alice',
}

const CATALOG = {
  apps: [
    {
      app_id: 'shared-notes',
      title: '共享便签',
      responsible: 'alice',
      access: 'login',
      current_version: '1.2.0',
      entry_url: '/shared-notes',
    },
  ],
}

// ---------------------------------------------------------------------------
// 1. 装配与参数契约
// ---------------------------------------------------------------------------

describe('装配：inject、注册、预算序关系', () => {
  it('auth-gate 的 inject 声明了 tools（不声明 ⇒ 工具可能静默缺席）', () => {
    expect(authGateInject).toContain('tools')
    // 既有依赖不能被这次改动挤掉。
    expect(authGateInject).toContain('webServer')
    expect(authGateInject).toContain('picoSession')
  })

  it('三个工具都经真实装配注册，名字与常量一致', () => {
    const h = harness(() => json(200, {}))
    expect(h.tools.map(tool => tool.name).sort()).toEqual([...WASM_APP_TOOL_NAMES].sort())
    for (const tool of h.tools) {
      expect(tool.description.length).toBeGreaterThan(40)
      // `{type:'json'}` 编译成"任意 JSON"（空 schema）——无约束即无损。
      expect(tool.output.schema).toEqual({})
    }
  })

  it('预算序关系：工具 deadline 严格大于出站预算（否则 hints 送不到模型）', () => {
    const h = harness(() => json(200, {}))
    expect(WASM_APP_TOOL_TIMEOUT_MS).toBeGreaterThan(CLIENT_UPLOAD_TIMEOUT_MS)
    expect(wasmAppToolHeadroomMs()).toBe(WASM_APP_TOOL_TIMEOUT_MS - CLIENT_UPLOAD_TIMEOUT_MS)
    expect(wasmAppToolHeadroomMs()).toBeGreaterThan(0)
    for (const tool of h.tools) expect(tool.timeoutMs).toBe(WASM_APP_TOOL_TIMEOUT_MS)
  })

  it('写面工具声明为不可并发（改远端状态），只读的列表可以并发', () => {
    const h = harness(() => json(200, {}))
    const byName = (name: string): ToolDef => h.tools.find(tool => tool.name === name)!
    expect(byName('wasm_app_list').isConcurrencySafe?.({})).toBe(true)
    expect(byName('wasm_app_publish').isConcurrencySafe?.({})).toBe(false)
    expect(byName('wasm_app_validate').isConcurrencySafe?.({})).toBe(false)
  })

  it('tools 服务缺席时明确报错，且不抛（最小组合仍能应用插件）', () => {
    const h = harness(() => json(200, {}), SESSION, { withTools: false })
    expect(h.tools).toHaveLength(0)
    expect(h.loggedErrors.join('\n')).toContain('tools service is absent')
    expect(h.loggedErrors.join('\n')).toContain('wasm_app_publish')
  })
})

describe('参数契约：模型必须能读懂每个字段', () => {
  const h = harness(() => json(200, {}))
  const byName = (name: string): ToolDef => h.tools.find(tool => tool.name === name)!

  it('每个参数的 description 都非空（"AI 知道该填什么"的直接落点）', () => {
    // list 没有参数（目录由服务端裁决，客户端不二次过滤）。
    expect(byName('wasm_app_list').parameters.properties ?? {}).toEqual({})
    for (const name of ['wasm_app_validate', 'wasm_app_publish']) {
      const properties = byName(name).parameters.properties ?? {}
      expect(Object.keys(properties).length).toBeGreaterThan(0)
      for (const [key, schema] of Object.entries(properties)) {
        expect(typeof schema.description, `${name}.${key} 缺 description`).toBe('string')
        expect((schema.description as string).length, `${name}.${key} description 过短`).toBeGreaterThan(10)
      }
      // `config` 的每个子字段也必须带说明。
      const config = properties.config!
      const sub = config.properties as Record<string, Record<string, unknown>>
      for (const field of APP_CONFIG_FIELDS) {
        expect(typeof sub[field]!.description, `${name}.config.${field} 缺 description`).toBe('string')
        expect((sub[field]!.description as string).length, `${name}.config.${field} description 过短`).toBeGreaterThan(10)
      }
    }
  })

  it('publish 的必填集合 = 服务端字段表的必填项（title 首版必填、config 必填）', () => {
    const publish = byName('wasm_app_publish')
    expect([...(publish.parameters.required ?? [])].sort()).toEqual([
      'appId', 'config', 'title', 'version', 'wasmPath',
    ])
    expect(Object.keys(publish.parameters.properties ?? {}).sort()).toEqual([
      'appId', 'changelog', 'config', 'title', 'uploadId', 'version', 'wasmPath',
    ])
    // changelog 是"非首版必填"：JSON Schema 表达不了条件必填，因此**不能**标进 required
    // （否则首版发布会被本地拦下），但描述里必须写清。
    expect(String(publish.parameters.properties!.changelog!.description)).toContain('非首版必填')
  })

  it('validate 只要求 appId/wasmPath（预检不占号，其余可选）', () => {
    const validate = byName('wasm_app_validate')
    expect([...(validate.parameters.required ?? [])].sort()).toEqual(['appId', 'wasmPath'])
    // 预检的 config 是可选的（服务端 validate 允许没有配置文件就能编译）：
    // 它不在顶层 required 里（上面那条断言），因此可以不带 config 直接预检。
  })

  it('config 的字段集合与首版必填标志 = 常量（配置字段的单一真源在服务端）', () => {
    for (const tool of [byName('wasm_app_publish'), byName('wasm_app_validate')]) {
      const config = tool.parameters.properties!.config!
      expect(config.type).toBe('object')
      expect(config.additionalProperties).toBe(false)
      const properties = config.properties as Record<string, Record<string, unknown>>
      expect(Object.keys(properties).sort()).toEqual([...APP_CONFIG_FIELDS].sort())
      // 编译后的 JSON Schema 把必填放在父节点的 `required` 数组里（与 defineTool 的
      // `required: true` 注解同义，只是形状不同）。
      expect((config.required as string[] | undefined ?? []).slice().sort())
        .toEqual([...APP_CONFIG_FIRST_RELEASE_REQUIRED].sort())
      // 每个字段都有说明，且说明就是常量里的那一句（不许两处各写一份）。
      for (const field of APP_CONFIG_FIELDS) {
        expect(properties[field]!.description).toBe(APP_CONFIG_FIELD_DESCRIPTIONS[field])
      }
    }
  })

  it('access 枚举与缺省语义写进参数描述（三取值一个不少）', () => {
    const config = byName('wasm_app_publish').parameters.properties!.config!
    const access = (config.properties as Record<string, Record<string, unknown>>).access!
    expect(access.enum).toEqual([...APP_CONFIG_ACCESS_MODES])
    const description = String(access.description)
    for (const mode of APP_CONFIG_ACCESS_MODES) expect(description).toContain(mode)
    expect(description).toContain(APP_CONFIG_DEFAULT_ACCESS)
    // 三模式的语义必须都在（用户拍板的口径）：匿名可用 / 登录后全员可用 / 仅名单内。
    expect(description).toContain('匿名')
    expect(description).toContain('全员')
    expect(description).toContain('名单')
  })

  it('version / appId 的约束写进描述（严格递增、形态、不可改名）', () => {
    const properties = byName('wasm_app_publish').parameters.properties!
    expect(String(properties.version!.description)).toContain('严格大于')
    expect(String(properties.appId!.description)).toContain('不能改名')
    expect(String(properties.changelog!.description)).toContain('非首版必填')
    expect(String(properties.uploadId!.description)).toContain('upload_id')
  })
})

// ---------------------------------------------------------------------------
// 2. 配置字段的单一真源：与平台真源对拍
// ---------------------------------------------------------------------------

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const LIMITS_JSON = join(REPO_ROOT, 'server/internal/wasmapp/limits/limits.json')
const APPCFG_JSON = join(REPO_ROOT, 'server/internal/wasmapp/appcfg/appcfg.json')

/** 读 `limits.json` 的 Key→Value 表（不存在 ⇒ 抛，调用方自行 skip）。 */
function readLimits(): Map<string, string> {
  const parsed = JSON.parse(readFileSync(LIMITS_JSON, 'utf8')) as { items?: Array<Record<string, string>> }
  const out = new Map<string, string>()
  for (const item of parsed.items ?? []) {
    const key = item.Key ?? item.key
    const value = item.Value ?? item.value
    if (typeof key === 'string' && typeof value === 'string') out.set(key, value)
  }
  return out
}

describe('参数描述与平台真源对拍（limits.json）', () => {
  const limits = readLimits()
  // **原文**而不是 JSON.stringify：描述里带反斜杠（版本号正则），序列化会二次转义，
  // 让"逐字包含"这条断言永远为假。
  const descriptions = (() => {
    const h = harness(() => json(200, {}))
    const parts: string[] = []
    for (const tool of h.tools) {
      parts.push(tool.description)
      for (const schema of Object.values(tool.parameters.properties ?? {})) {
        if (typeof schema.description === 'string') parts.push(schema.description)
        const sub = schema.properties as Record<string, Record<string, unknown>> | undefined
        for (const nested of Object.values(sub ?? {})) {
          if (typeof nested.description === 'string') parts.push(nested.description)
        }
      }
    }
    return parts.join('\n')
  })()

  it('app_id / version 的形态正则逐字来自 limits.json', () => {
    const appIdPattern = limits.get('app_id_pattern')
    const versionPattern = limits.get('version_pattern')
    expect(appIdPattern).toBeTypeOf('string')
    expect(versionPattern).toBeTypeOf('string')
    expect(descriptions).toContain(appIdPattern!)
    expect(descriptions).toContain(versionPattern!)
  })

  it('长度 / 白名单上限 / 频率 / 体积上限都出现在描述里', () => {
    expect(descriptions).toContain(limits.get('max_app_id_len')!)
    expect(descriptions).toContain(limits.get('app_config_whitelist_max')!)
    expect(descriptions).toContain(limits.get('upload_rate_per_hour')!)
    const wasmMiB = String(Number(limits.get('wasm_max_bytes')) / (1024 * 1024))
    expect(descriptions).toContain(`${wasmMiB} MiB`)
  })

  it('保留字至少覆盖 limits.json 里最容易被当应用名的那几个', () => {
    const reserved = (limits.get('reserved_app_ids') ?? '').split(',').map(value => value.trim())
    const mustMention = ['www', 'api', 'admin', 'portal', 'updates', 'sso', 'login']
    for (const name of mustMention) {
      expect(reserved, `${name} 不在 limits.json 的保留字里`).toContain(name)
      expect(descriptions, `${name} 没写进工具描述`).toContain(name)
    }
  })
})

describe('配置字段与 appcfg.json 对拍（单一真源缺席即红，不再 skip）', () => {
  /** 字段表可能把这些字段放在哪（先按候选路径找）。 */
  const FIELD_TABLE_PATHS = [
    'fields', 'field_names', 'config_fields', 'app_config_fields', 'appcfg_fields', 'top_level_fields',
    'config.fields', 'config',
  ]
  const FIELD_NAME_KEYS = ['name', 'field', 'key', 'id', 'json_name']
  const REQUIRED_KEYS = [
    'required_first_release', 'first_release_required', 'required_on_first_release',
    'requiredForFirstRelease', 'required',
  ]
  /** 载荷/元数据键：它们在字段表里出现不算配置字段（发布载荷不是 picoaide.app.json）。 */
  /**
   * 发布载荷字段集合（服务端 `publish_fields` 的期望值）。
   *
   * 与客户端 `@picoaide/dsh-wasm-apps` 的 `PUBLISH_PAYLOAD_FIELDS` 是**同一个契约**
   * 的两端镜像；第三方（服务端）改名时两边必须一起改 —— 两处各自对拍同一份
   * `appcfg.json`，所以漏改哪一边都会红。
   */
  const PUBLISH_FIELDS_EXPECTED = ['app_id', 'version', 'title', 'changelog', 'wasm_base64', 'config']

  const NON_CONFIG_KEYS = new Set([
    'app_id', 'version', 'title', 'changelog', 'wasm_base64', 'wasm_path', 'upload_id',
    'version_of_spec', 'spec_version', 'generated_by', 'source', 'note', 'description',
  ])

  /** 按点分路径取值（对象键 + 数组里按 name 索引，两种形态都吃）。 */
  function readPath(root: unknown, path: string): unknown {
    let current: unknown = root
    for (const segment of path.split('.')) {
      if (current === null || typeof current !== 'object') return undefined
      if (Array.isArray(current)) {
        current = current.find((node) => {
          if (node === null || typeof node !== 'object') return false
          const record = node as Record<string, unknown>
          return FIELD_NAME_KEYS.some(key => record[key] === segment)
        })
        continue
      }
      const record = current as Record<string, unknown>
      if (!Object.hasOwn(record, segment)) return undefined
      current = record[segment]
    }
    return current
  }

  /** 抽出字段表：字段名 → 节点；认不出来时返回 null（测试据此变红并提示补候选路径）。 */
  function readFieldTable(root: unknown): Map<string, unknown> | null {
    for (const path of FIELD_TABLE_PATHS) {
      const value = readPath(root, path)
      if (value === null || typeof value !== 'object') continue
      const fields = new Map<string, unknown>()
      if (Array.isArray(value)) {
        for (const node of value) {
          if (node === null || typeof node !== 'object') continue
          const record = node as Record<string, unknown>
          for (const key of FIELD_NAME_KEYS) {
            const name = record[key]
            if (typeof name === 'string' && name !== '') { fields.set(name, node); break }
          }
        }
      } else {
        for (const [name, node] of Object.entries(value as Record<string, unknown>)) fields.set(name, node)
      }
      if (fields.size > 0) return fields
    }
    return null
  }

  /** 字段节点的"首版必填"标记（认不出来时 null）。 */
  function requiredFlag(node: unknown): boolean | null {
    if (node === null || typeof node !== 'object') return null
    const record = node as Record<string, unknown>
    // ① 条件必填（服务端字段表的写法）：`required_when: 'first_release'` 之类。
    const when = record.required_when ?? record.requiredWhen
    if (typeof when === 'string') return when === 'first_release'
    if (Array.isArray(when)) return when.some(entry => entry === 'first_release')
    // ② 无条件布尔标记。
    for (const key of REQUIRED_KEYS) if (typeof record[key] === 'boolean') return record[key]
    return null
  }

  /** 表级"首版必填名单"（有些字段表把它放在顶层数组里）。 */
  function requiredList(root: unknown): string[] | null {
    for (const path of ['first_release_required', 'required_first_release', 'required_fields', 'first_release_required_fields']) {
      const value = readPath(root, path)
      if (Array.isArray(value) && value.every(entry => typeof entry === 'string')) return value as string[]
    }
    return null
  }

  /** 服务端字段表里的发布载荷字段（`publish_fields`，可选）。 */
  function readPublishFields(root: unknown): Array<Record<string, unknown>> {
    const value = readPath(root, 'publish_fields') ?? readPath(root, 'payload_fields') ?? readPath(root, 'publish')
    if (!Array.isArray(value)) return []
    return value.filter((node): node is Record<string, unknown> => node !== null && typeof node === 'object')
  }

  let spec: unknown
  let missing: string | null = null
  try {
    spec = JSON.parse(readFileSync(APPCFG_JSON, 'utf8'))
  } catch (cause) {
    missing = cause instanceof Error ? cause.message : String(cause)
  }

  it('字段集合与首版必填标志与常量一致', () => {
    // 单一真源缺席 = **红**，不是 skip（独立审计 2026-09-18 P1-2：原先
    // `ctx.skip()` 让"文件被删/改名"表现成一条 skipped 用例、`yarn check`
    // 依旧绿 —— 那正是这道闸最该拦住的形态）。
    expect(missing, `${APPCFG_JSON} 必须存在且是合法 JSON：它是本对拍的唯一真源`).toBeNull()
    const table = readFieldTable(spec)
    expect(table, `认不出 ${APPCFG_JSON} 的字段表形状；请在 FIELD_TABLE_PATHS 里补候选路径`).not.toBeNull()
    const names = [...table!.keys()].filter(name => !NON_CONFIG_KEYS.has(name)).sort()
    expect(names).toEqual([...APP_CONFIG_FIELDS].sort())
    // 已删除的旧字段不得回来（字段集合封闭：多发一个即发布被拒）。
    for (const removed of ['visible', 'login_required']) {
      expect(table!.has(removed), `${removed} 必须已删除`).toBe(false)
    }
    // 首版必填：字段节点上的标记优先，其次表级名单；两者都没有 ⇒ 红（契约要求它可读）。
    const declaredList = requiredList(spec)
    const declared = APP_CONFIG_FIELDS.filter(field => requiredFlag(table!.get(field)) === true).sort()
    const expected = [...APP_CONFIG_FIRST_RELEASE_REQUIRED].sort()
    if (declared.length > 0) {
      expect(declared).toEqual(expected)
    } else {
      expect(
        declaredList,
        `${APPCFG_JSON} 必须声明"首版必填"（字段节点上的 required_when / ${REQUIRED_KEYS.join('/')} 之一，或顶层 first_release_required 数组）`,
      ).not.toBeNull()
      expect(declaredList!.filter(name => name !== 'title').sort()).toEqual(expected)
    }
  })

  it('发布载荷字段的集合与必填都与工具 schema 一致（app_id/version/wasm_base64↔wasmPath/title/config）', () => {
    expect(missing, `${APPCFG_JSON} 必须存在且是合法 JSON：它是本对拍的唯一真源`).toBeNull()
    const fields = readPublishFields(spec)
    expect(fields.length, `${APPCFG_JSON} 认不出发布载荷字段表（publish_fields）`).toBeGreaterThan(0)
    // **全集合相等**（独立审计 2026-09-18 P1-1）：只查必填会让"改名"静默溜过
    // —— 服务端把 `wasm_base64` 改名、工具却继续发旧名，每次发布被按未知字段拒。
    expect(fields.map(field => String(field.key)).sort()).toEqual([...PUBLISH_FIELDS_EXPECTED].sort())
    // 服务端字段名 → 工具参数名（宿主用 wasm_path 替代 wasm_base64：同一条读取面）。
    const TOOL_PARAM: Record<string, string> = {
      app_id: 'appId',
      version: 'version',
      title: 'title',
      changelog: 'changelog',
      wasm_base64: 'wasmPath',
      config: 'config',
    }
    const required = fields
      .filter(field => field.required === true || field.required_when === 'first_release')
      .map(field => TOOL_PARAM[String(field.key)] ?? String(field.key))
      .sort()
    // `changelog` 是 required_when=non_first_release：条件必填在 JSON Schema 里表达不了，
    // 因此不在 required 里（首版发布若被本地拦下才是 bug），由描述承担。
    expect(required).not.toContain('changelog')
    const publish = harness(() => json(200, {})).tools.find(tool => tool.name === 'wasm_app_publish')!
    expect([...(publish.parameters.required ?? [])].sort()).toEqual(required)
  })
})

// ---------------------------------------------------------------------------
// 3. wasm_app_list
// ---------------------------------------------------------------------------

describe('wasm_app_list：列出目录（只读）', () => {
  // ⚠️ **反向断言**（R2-L1-1，2026-09-20 主控裁定）：这条用例原先钉的是"entry_url
  // 绝对化后原样返回"—— 服务端已不再下发该键（旧访问模型的 emit 随 W4 删除），宿主
  // 的补全分支也一并删除。夹具**故意**保留一行旧形态数据（模拟旧服务端/历史缓存），
  // 用来钉住"宿主不认识它、不改写它"：重新加回补全 ⇒ `/shared-notes` 变成绝对地址 ⇒ 红。
  it('出站 GET catalog，带 Bearer；目录逐字节透传（旧入口链接字段不被改写）', async () => {
    const h = harness(() => json(200, CATALOG))
    const result = await h.run('wasm_app_list', {})
    expect(h.outbound).toHaveLength(1)
    expect(h.outbound[0]!.method).toBe('GET')
    expect(h.outbound[0]!.url).toBe('https://harness.example/api/client/v2/apps/wasm/catalog')
    expect(result.ok).toBe(true)
    expect(result.status).toBe(200)
    expect(result.body.apps[0].app_id).toBe('shared-notes')
    // 相对值保持相对（旧实现这里会给出 `https://harness.example/shared-notes`）。
    expect(result.body.apps[0].entry_url).toBe('/shared-notes')
    // P1-4：工具描述承诺输出"当前版本"（模型据此算出严格递增的新版本号），而目录行
    // 原先**没有**这个字段 —— 猜错版本号的代价是一次完整上传（≤32 MiB）+ 审计拒绝
    // + 消耗上传额度。这条断言钉住"承诺的数据真的在工具输出里"。
    expect(result.body.apps[0].current_version).toBe('1.2.0')
    // 红线 3：结果里不得出现令牌。
    expect(JSON.stringify(result)).not.toContain(TOKEN)
  })

  it('审计账号可以列目录（只读面与本地路由同口径：只有写面拒）', async () => {
    const h = harness(() => json(200, CATALOG), AUDITOR)
    const result = await h.run('wasm_app_list', {})
    expect(result.ok).toBe(true)
    expect(h.outbound).toHaveLength(1)
  })

  it('未登录时明确拒绝且零出站', async () => {
    const h = harness(() => json(200, CATALOG), null)
    const result = await h.run('wasm_app_list', {})
    expect(result.ok).toBe(false)
    expect(result.status).toBe(401)
    expect(result.error.code).toBe('AUTH_REQUIRED')
    expect(h.outbound).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 4. wasm_app_validate
// ---------------------------------------------------------------------------

describe('wasm_app_validate：预检（不占版本号）', () => {
  it('把本地产物读成 base64 出站到 /validate，并带上 version/config', async () => {
    const wasmPath = await writeWasm(64)
    const h = harness(() => json(200, { validation: { ok: true, wasm_bytes: 64, first_release: true } }))
    const result = await h.run('wasm_app_validate', {
      appId: 'shared-notes',
      wasmPath,
      version: '1.0.0',
      config: CONFIG,
    })
    expect(h.outbound).toHaveLength(1)
    expect(h.outbound[0]!.method).toBe('POST')
    expect(h.outbound[0]!.url).toBe('https://harness.example/api/client/v2/apps/wasm/validate')
    const payload = JSON.parse(h.outbound[0]!.body)
    expect(payload.app_id).toBe('shared-notes')
    expect(payload.version).toBe('1.0.0')
    expect(payload.config).toEqual(CONFIG)
    expect(Buffer.from(payload.wasm_base64, 'base64')).toEqual(Buffer.alloc(64, 7))
    expect(result.ok).toBe(true)
    expect(result.body.validation.ok).toBe(true)
  })

  it('预检失败时把服务端信封原样带出（AI 靠 hints 自修）', async () => {
    const wasmPath = await writeWasm(64)
    const envelope = {
      error: {
        code: 'IMPORT_NOT_ALLOWED',
        message: '导入面不在白名单内',
        details: { symbol: 'wasi_snapshot_preview1.sock_open', actual: 'i32i32_i32' },
        hints: ['按 skill 的 ABI 样板生成代码', '编译目标必须是 wasm32-wasip1'],
      },
    }
    const h = harness(() => json(422, envelope))
    const result = await h.run('wasm_app_validate', { appId: 'shared-notes', wasmPath })
    expect(result.ok).toBe(false)
    expect(result.status).toBe(422)
    // 服务端信封**逐字段原样**：hints 一字不改且排在最前（末尾可能追加一条本机
    // 作者手册的安装指路，见「内置作者手册缺失时…」describe）。
    expect(result.error.code).toBe(envelope.error.code)
    expect(result.error.message).toBe(envelope.error.message)
    expect(result.error.details).toEqual(envelope.error.details)
    expect(result.error.hints.slice(0, envelope.error.hints.length)).toEqual(envelope.error.hints)
    expect(JSON.stringify(result)).not.toContain(TOKEN)
  })

  it('审计账号被拒（与本地路由的 writeGuard 同口径），零出站', async () => {
    const wasmPath = await writeWasm(64)
    const h = harness(() => json(200, {}), AUDITOR)
    const result = await h.run('wasm_app_validate', { appId: 'shared-notes', wasmPath })
    expect(result.ok).toBe(false)
    expect(result.status).toBe(403)
    expect(result.error.code).toBe('FORBIDDEN')
    expect(h.outbound).toHaveLength(0)
  })

  it('未登录时明确拒绝，零出站', async () => {
    const wasmPath = await writeWasm(64)
    const h = harness(() => json(200, {}), null)
    const result = await h.run('wasm_app_validate', { appId: 'shared-notes', wasmPath })
    expect(result.error.code).toBe('AUTH_REQUIRED')
    expect(h.outbound).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 5. wasm_app_publish
// ---------------------------------------------------------------------------

describe('wasm_app_publish：小载荷直传', () => {
  it('出站 POST :app_id/releases，载荷逐字段正确（服务端契约）', async () => {
    const wasmPath = await writeWasm(128)
    const h = harness(() => json(201, { release: { version: '1.0.0', status: 'approved', live: true } }))
    const result = await h.run('wasm_app_publish', {
      appId: 'shared-notes',
      version: '1.0.0',
      wasmPath,
      title: '共享便签',
      changelog: '首个版本',
      config: CONFIG,
    })
    expect(h.outbound).toHaveLength(1)
    expect(h.outbound[0]!.method).toBe('POST')
    expect(h.outbound[0]!.url).toBe('https://harness.example/api/client/v2/apps/wasm/shared-notes/releases')
    const payload = JSON.parse(h.outbound[0]!.body)
    expect(Object.keys(payload)).toEqual(['app_id', 'version', 'title', 'changelog', 'config', 'wasm_base64'])
    expect(payload.app_id).toBe('shared-notes')
    expect(payload.version).toBe('1.0.0')
    expect(payload.title).toBe('共享便签')
    expect(payload.changelog).toBe('首个版本')
    expect(payload.config).toEqual(CONFIG)
    expect(Buffer.from(payload.wasm_base64, 'base64')).toEqual(Buffer.alloc(128, 7))
    expect(result.ok).toBe(true)
    expect(result.status).toBe(201)
    expect(result.body.release.live).toBe(true)
    expect(JSON.stringify(result)).not.toContain(TOKEN)
  })

  it('不给 changelog 也能发（非首版更新；config 仍必填）', async () => {
    const wasmPath = await writeWasm(64)
    const h = harness(() => json(201, { release: { status: 'pending', live: false } }))
    const result = await h.run('wasm_app_publish', {
      appId: 'shared-notes',
      version: '1.0.1',
      wasmPath,
      title: '共享便签',
      config: CONFIG,
    })
    const payload = JSON.parse(h.outbound[0]!.body)
    expect(Object.keys(payload)).toEqual(['app_id', 'version', 'title', 'config', 'wasm_base64'])
    expect(result.body.release.status).toBe('pending')
  })

  it('缺 config 时由工具 schema 在本地就拒（服务端字段表里 config 必填）', async () => {
    const wasmPath = await writeWasm(64)
    const h = harness(() => json(201, {}))
    await expect(h.run('wasm_app_publish', {
      appId: 'shared-notes', version: '1.0.0', wasmPath, title: '共享便签',
    })).rejects.toThrow(/config/)
    expect(h.outbound).toHaveLength(0)
  })

  it('缺必填参数时由工具 schema 拒掉（不再出站）', async () => {
    const h = harness(() => json(201, {}))
    await expect(h.run('wasm_app_publish', { appId: 'shared-notes', version: '1.0.0' })).rejects.toThrow()
    await expect(h.run('wasm_app_publish', { appId: 'a', version: '1.0.0', wasmPath: '/x.wasm' })).rejects.toThrow()
    expect(h.outbound).toHaveLength(0)
  })

  it('access 只接受三个取值（第四个值被 schema 拒）', async () => {
    const wasmPath = await writeWasm(64)
    const h = harness(() => json(201, {}))
    await expect(h.run('wasm_app_publish', {
      appId: 'a', version: '1.0.0', wasmPath, title: 'T',
      config: { ...CONFIG, access: 'everyone' },
    })).rejects.toThrow()
    expect(h.outbound).toHaveLength(0)
  })
})

describe('wasm_app_publish：>8 MiB 自动分片 + 续传', () => {
  it('走 uploads：开会话 → 逐片 PUT → complete 只带 {title,changelog,config}', async () => {
    const wasmPath = await writeWasm(17 * 1024 * 1024)
    const puts: string[] = []
    const h = harness((method, url) => {
      if (method === 'POST' && url.endsWith('/uploads')) return json(201, { upload_id: 'UP-1', received: [] })
      if (method === 'PUT') { puts.push(url.split('/').pop()!); return new Response(null, { status: 204 }) }
      if (method === 'POST' && url.endsWith('/complete')) return json(201, { release: { status: 'approved', live: true } })
      throw new Error(`unexpected ${method} ${url}`)
    })
    const result = await h.run('wasm_app_publish', {
      appId: 'shared-notes', version: '2.0.0', wasmPath, title: '共享便签', changelog: '大版本', config: CONFIG,
    })
    const opened = JSON.parse(h.outbound[0]!.body)
    expect(Object.keys(opened)).toEqual(['app_id', 'version', 'total_bytes', 'chunk_bytes'])
    expect(opened.total_bytes).toBe(17 * 1024 * 1024)
    expect(opened.chunk_bytes).toBeLessThanOrEqual(8 * 1024 * 1024)
    expect(opened.chunk_bytes).toBeGreaterThanOrEqual(64 * 1024)
    expect(puts).toEqual(['0', '1', '2'])
    const complete = h.outbound[h.outbound.length - 1]!
    expect(complete.url.endsWith('/uploads/UP-1/complete')).toBe(true)
    expect(Object.keys(JSON.parse(complete.body))).toEqual(['title', 'changelog', 'config'])
    expect(result.ok).toBe(true)
  })

  it('带 uploadId 时先拉 received[]，只补缺失片（不重开会话、不重传已收片）', async () => {
    const wasmPath = await writeWasm(17 * 1024 * 1024)
    const puts: string[] = []
    const h = harness((method, url) => {
      if (method === 'GET' && url.endsWith('/uploads/UP-9')) return json(200, { received: [0, 2] })
      if (method === 'PUT') { puts.push(url.split('/').pop()!); return new Response(null, { status: 204 }) }
      if (method === 'POST' && url.endsWith('/complete')) return json(201, { release: { status: 'approved' } })
      throw new Error(`unexpected ${method} ${url}`)
    })
    const result = await h.run('wasm_app_publish', {
      appId: 'shared-notes', version: '2.0.1', wasmPath, title: '共享便签', uploadId: 'UP-9', config: CONFIG,
    })
    expect(h.outbound[0]!.method).toBe('GET')
    expect(h.outbound[0]!.url.endsWith('/uploads/UP-9')).toBe(true)
    expect(h.outbound.some(entry => entry.method === 'POST' && entry.url.endsWith('/uploads'))).toBe(false)
    expect(puts).toEqual(['1'])
    expect(result.ok).toBe(true)
  })

  it('收不齐时给出可续传的结构化错误（upload_id 可回填给下一次调用）', async () => {
    const wasmPath = await writeWasm(17 * 1024 * 1024)
    const h = harness((method, url) => {
      if (method === 'POST' && url.endsWith('/uploads')) return json(201, { upload_id: 'UP-4', received: [] })
      if (method === 'GET') return json(200, { received: [] })
      if (method === 'PUT') return json(503, { error: { code: 'COMPILE_BUSY', message: '编译器忙' } })
      throw new Error(`unexpected ${method} ${url}`)
    })
    const result = await h.run('wasm_app_publish', {
      appId: 'shared-notes', version: '2.1.0', wasmPath, title: '共享便签', config: CONFIG,
    })
    expect(result.ok).toBe(false)
    expect(result.status).toBe(503)
    expect(result.error.code).toBe('UPLOAD_INCOMPLETE')
    expect(result.error.details.upload_id).toBe('UP-4')
    expect(result.error.details.chunks).toBe(3)
    expect(String(result.error.details.upstream)).toContain('COMPILE_BUSY')
    expect(result.error.hints.join(' ')).toContain('upload_id')
  })
})

describe('wasm_app_publish：错误信封与本地闸门', () => {
  it('服务端业务错误原样带出（code/message/details/hints 一字不改）', async () => {
    const wasmPath = await writeWasm(64)
    const envelope = {
      error: {
        code: 'APP_CONFIG_INVALID',
        message: '配置里的 access 缺失且 whitelist 为空',
        details: { field: 'whitelist', reason: 'empty_whitelist', max: 2000 },
        hints: ['access=whitelist 时必须给出至少一个账号', '平台不校验账号是否存在'],
      },
    }
    const h = harness(() => json(422, envelope))
    const result = await h.run('wasm_app_publish', {
      appId: 'shared-notes', version: '1.0.0', wasmPath, title: '共享便签', config: CONFIG,
    })
    expect(result.ok).toBe(false)
    expect(result.status).toBe(422)
    expect(result.error.code).toBe('APP_CONFIG_INVALID')
    expect(result.error.message).toBe(envelope.error.message)
    expect(result.error.details).toEqual(envelope.error.details)
    // 服务端的 hints **一字不改且排在最前**（它是主证据）；末尾多出的那一条是
    // 本机作者手册缺失时的指路，由下个 describe 逐条钉住。
    expect(result.error.hints.slice(0, envelope.error.hints.length)).toEqual(envelope.error.hints)
  })

  it('限流错误把 RATE_LIMITED 与它的 hints 一起带回（模型据此等待而不是重试）', async () => {
    const wasmPath = await writeWasm(64)
    const h = harness(() => json(429, {
      error: {
        code: 'RATE_LIMITED',
        message: '每小时最多 30 次上传',
        details: { retry_after_seconds: 600 },
        hints: ['等 10 分钟后再试；预检与发布共用这条额度'],
      },
    }))
    const result = await h.run('wasm_app_publish', {
      appId: 'shared-notes', version: '1.0.0', wasmPath, title: '共享便签', config: CONFIG,
    })
    expect(result.error.code).toBe('RATE_LIMITED')
    expect(result.error.details.retry_after_seconds).toBe(600)
    expect(result.error.hints[0]).toContain('10 分钟')
  })

  it('wasm_path 越界：与路由同一条读取面（本地拒，零出站）', async () => {
    const outside = join(home, 'outside.wasm')
    await mkdir(dirname(outside), { recursive: true })
    await writeFile(outside, Buffer.alloc(8, 1))
    const h = harness(() => json(201, {}))
    const result = await h.run('wasm_app_publish', {
      appId: 'shared-notes', version: '1.0.0', wasmPath: outside, title: '共享便签', config: CONFIG,
    })
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('WASM_PATH_OUTSIDE_ALLOWED_ROOTS')
    expect(result.error.details.allowed_roots.length).toBeGreaterThan(0)
    expect(h.outbound).toHaveLength(0)
  })

  it('wasm_path 指向目录：结构化 400（FIX-41，不抛穿）', async () => {
    const h = harness(() => json(201, {}))
    const result = await h.run('wasm_app_publish', {
      appId: 'shared-notes', version: '1.0.0', wasmPath: workspace, title: '共享便签', config: CONFIG,
    })
    expect(result.error.code).toBe('WASM_PATH_NOT_A_FILE')
    expect(result.error.details.kind).toBe('directory')
    expect(h.outbound).toHaveLength(0)
  })

  it('wasm_path 不存在 / 非绝对路径：结构化 400，零出站', async () => {
    const h = harness(() => json(201, {}))
    const missing = await h.run('wasm_app_publish', {
      appId: 'shared-notes', version: '1.0.0', wasmPath: join(workspace, 'nope.wasm'), title: '共享便签', config: CONFIG,
    })
    expect(missing.error.code).toBe('WASM_PATH_NOT_FOUND')
    const relative = await h.run('wasm_app_publish', {
      appId: 'shared-notes', version: '1.0.0', wasmPath: 'main.wasm', title: '共享便签', config: CONFIG,
    })
    expect(relative.error.code).toBe('WASM_PATH_NOT_ABSOLUTE')
    expect(h.outbound).toHaveLength(0)
  })

  it('未登录 / 审计账号都被明确拒绝，零出站', async () => {
    const wasmPath = await writeWasm(64)
    const args = { appId: 'shared-notes', version: '1.0.0', wasmPath, title: '共享便签', config: CONFIG }
    const anonymous = harness(() => json(201, {}), null)
    expect((await anonymous.run('wasm_app_publish', args)).error.code).toBe('AUTH_REQUIRED')
    expect(anonymous.outbound).toHaveLength(0)
    const auditor = harness(() => json(201, {}), AUDITOR)
    expect((await auditor.run('wasm_app_publish', args)).error.code).toBe('FORBIDDEN')
    expect(auditor.outbound).toHaveLength(0)
    vi.mocked(wasmApps.publishApp).mockClear()
  })
})

// ---------------------------------------------------------------------------
// 6. 结构断言：一条编排，两个调用面
// ---------------------------------------------------------------------------

describe('路由与工具命中同一个实现（防"复制一份编排"）', () => {
  const TOOL_SOURCE = readFileSync(fileURLToPath(new URL('../src/wasm-app-tools.ts', import.meta.url)), 'utf8')

  it('工具只调共享编排：文件里没有任何上游路径 / 出站原语 / 分片实现', () => {
    // 结构性判据：编排（路径拼装、90 s 预算、分片续传、错误信封）只允许住在
    // wasm-apps.ts。工具一旦自己复制一份，就必须在本文件里出现上游路径字面量 —— 直接红。
    expect(TOOL_SOURCE).toContain("from './wasm-apps.ts'")
    expect(TOOL_SOURCE).toMatch(/\bpublishApp\b/)
    expect(TOOL_SOURCE).toMatch(/\bvalidateApp\b/)
    expect(TOOL_SOURCE).toMatch(/\blistCatalog\b/)
    expect(TOOL_SOURCE).not.toMatch(/api\/client\/v2/)
    expect(TOOL_SOURCE).not.toMatch(/gatewayFetch|gatewayRequest/)
    expect(TOOL_SOURCE).not.toMatch(/wasm_base64/)
    expect(TOOL_SOURCE).not.toMatch(/planChunks|\/uploads/)
    // 令牌红线：工具面不打印、不返回、也不自己拼 Authorization。
    expect(TOOL_SOURCE).not.toMatch(/Bearer/)
  })

  it('工具调用进共享 publishApp；与本地路由的出站请求逐字节相同', async () => {
    const wasmPath = await writeWasm(256)
    const h = harness(() => json(201, { release: { status: 'approved', live: true } }))
    const spy = vi.mocked(wasmApps.publishApp)
    spy.mockClear()
    // 出站原语计数器：**两条路径**都必须命中同一个 gatewayFetch。
    const gateway = vi.mocked(authConnector.gatewayFetch)
    gateway.mockClear()

    // 路径 A：本机路由（员工在应用中心 / 页面脚本走的形态）。
    const viaRoute = await h.call(`${WASM_APPS_PREFIX}/publish`, 'POST', JSON.stringify({
      app_id: 'shared-notes',
      version: '1.0.0',
      title: '共享便签',
      wasm_path: wasmPath,
      config: CONFIG,
    }))
    expect(viaRoute.code).toBe(201)
    expect(gateway).toHaveBeenCalledTimes(1)
    const routeOutbound = h.outbound.splice(0)

    // 路径 B：宿主工具（模型走的形态）——它必须命中**同一个**导出函数。
    // 注：模块 mock 只能拦到跨模块 import，路由那次调用是 wasm-apps.ts 的模块内调用
    // （文件级 mock 拦不到），所以计数断言针对工具路径、路由路径靠"出站逐字节相同"证明。
    const viaTool = await h.run('wasm_app_publish', {
      appId: 'shared-notes',
      version: '1.0.0',
      title: '共享便签',
      wasmPath,
      config: CONFIG,
    })
    expect(viaTool.ok).toBe(true)
    expect(spy).toHaveBeenCalledTimes(1)
    // 同一个出站原语，累计两次（路由 1 + 工具 1）—— 没有第二条链路。
    expect(gateway).toHaveBeenCalledTimes(2)
    const toolOutbound = h.outbound.splice(0)

    // 同一份入参 ⇒ 同一串出站请求（方法、路径、Content-Type、逐字节载荷）。
    const normalize = (list: Outbound[]): Outbound[] =>
      list.map(entry => ({ method: entry.method, url: entry.url, body: entry.body, contentType: entry.contentType }))
    expect(normalize(toolOutbound)).toEqual(normalize(routeOutbound))
    expect(toolOutbound).toHaveLength(1)
    expect(toolOutbound[0]!.method).toBe('POST')
    expect(toolOutbound[0]!.url).toBe('https://harness.example/api/client/v2/apps/wasm/shared-notes/releases')
  })
})

// ---------------------------------------------------------------------------
// 8. 内置作者手册缺失时的指路（「skill 内置到服务端、客户端按需安装」的失败面）
// ---------------------------------------------------------------------------

/**
 * 造一个「已装」的本机状态：`<dshHome>/skills/<name>/SKILL.md`（`beforeEach` 已把
 * `DSH_HOME` 指到临时目录，因此缺省就是「未装」）。
 */
async function installBuiltinSkill(): Promise<void> {
  await mkdir(join(home, 'skills', APP_BUILDER_SKILL), { recursive: true })
  await writeFile(join(home, 'skills', APP_BUILDER_SKILL, 'SKILL.md'), '# 手册\n')
}

/** 一次会失败的发布（上游 422），返回工具结果。 */
async function failingPublish(h: Harness): Promise<any> {
  const wasmPath = await writeWasm(64)
  return await h.run('wasm_app_publish', {
    appId: 'shared-notes', version: '1.0.0', wasmPath, title: '共享便签', config: CONFIG,
  })
}

describe('内置作者手册缺失时，工具失败必须给出安装指路', () => {
  const upstream422 = () => json(422, {
    error: { code: 'APP_CONFIG_INVALID', message: '名单为空', hints: ['access=whitelist 时必须给出至少一个账号'] },
  })

  it('未装：在失败信封**末尾**追加一条指路，点名技能与安装位置', async () => {
    const h = harness(upstream422)
    const result = await failingPublish(h)
    expect(result.ok).toBe(false)
    const hints: string[] = result.error.hints
    expect(hints).toHaveLength(2)
    expect(hints[0]).toBe('access=whitelist 时必须给出至少一个账号')
    expect(hints[1]).toContain(APP_BUILDER_SKILL)
    expect(hints[1]).toContain('能力中心')
    expect(hints[1]).toContain('安装')
  })

  it('已装：不带指路（装了还提示只会是噪音）', async () => {
    await installBuiltinSkill()
    const h = harness(upstream422)
    const result = await failingPublish(h)
    expect(result.error.hints).toEqual(['access=whitelist 时必须给出至少一个账号'])
  })

  it('每次调用重新判定磁盘事实：会话中途装上，下一次失败就不再提示', async () => {
    const h = harness(upstream422)
    expect((await failingPublish(h)).error.hints).toHaveLength(2)
    await installBuiltinSkill()
    expect((await failingPublish(h)).error.hints).toHaveLength(1)
  })

  it('成功结果不查磁盘、不带任何 hints', async () => {
    const h = harness(() => json(201, { release: { version: '1.0.0', status: 'approved', live: true } }))
    const result = await failingPublish(h)
    expect(result.ok).toBe(true)
    expect(JSON.stringify(result)).not.toContain(APP_BUILDER_SKILL)
  })

  it('身份 / 传输 / 本地前置闸门都不指路：装手册解决不了这些', async () => {
    // 身份类：未登录、审计只读、越权。
    expect(skillHintAppliesTo(401)).toBe(false)
    expect(skillHintAppliesTo(403)).toBe(false)
    // 传输类：网络不可达 / 出站超时（审计 2026-09-18 P2-2 复现的误指路）。
    expect(skillHintAppliesTo(502, 'GATEWAY_UNAVAILABLE')).toBe(false)
    expect(skillHintAppliesTo(504, 'GATEWAY_TIMEOUT')).toBe(false)
    // 本地前置闸门：产物没送到服务端，问题是路径/参数/分片会话。
    expect(skillHintAppliesTo(400, 'WASM_PATH_NOT_FOUND')).toBe(false)
    expect(skillHintAppliesTo(400, 'WASM_PATH_OUTSIDE_ALLOWED_ROOTS')).toBe(false)
    expect(skillHintAppliesTo(400, 'MISSING_FIELD')).toBe(false)
    expect(skillHintAppliesTo(400, 'INVALID_JSON')).toBe(false)
    expect(skillHintAppliesTo(413, 'UPLOAD_TOO_LARGE')).toBe(false)
    // 认不出信封（无 code）：上游没在说我们的协议 ⇒ 不指路（独立验证 R-1）。
    expect(skillHintAppliesTo(502)).toBe(false)
    // 平台侧"现在别来"：等服务端腾出来即可，不是作者要改东西（独立验证 P3-2）。
    expect(skillHintAppliesTo(429, 'RATE_LIMITED')).toBe(false)
    expect(skillHintAppliesTo(503, 'COMPILE_BUSY')).toBe(false)
    // 但"产物本身有问题/太大"仍要指路（COMPILE_TIMEOUT 不是"忙"）。
    expect(skillHintAppliesTo(504, 'COMPILE_TIMEOUT')).toBe(true)
    // 服务端业务错误：正是手册能救的场景。
    expect(skillHintAppliesTo(400, 'APP_CONFIG_INVALID')).toBe(true)
    expect(skillHintAppliesTo(422, 'IMPORT_NOT_ALLOWED')).toBe(true)
    expect(skillHintAppliesTo(500, 'RUNTIME_OUTPUT_OVERRUN')).toBe(true)
    // 本地闸门的 401（未登录）走的是另一条分支：零出站，也不带指路。
    const anonymous = harness(() => json(201, {}), null)
    const result = await anonymous.run('wasm_app_publish', {
      appId: 'shared-notes', version: '1.0.0', wasmPath: await writeWasm(64), title: 'x', config: CONFIG,
    })
    expect(result.status).toBe(401)
    expect(result.error.hints.every((hint: string) => !hint.includes(APP_BUILDER_SKILL))).toBe(true)
    expect(anonymous.outbound).toHaveLength(0)
  })

  it('上游 401/403（令牌过期/越权）同样不指路', async () => {
    const h = harness(() => json(403, { error: { code: 'FORBIDDEN', message: '只有发布者能发新版' } }))
    const result = await failingPublish(h)
    expect(result.status).toBe(403)
    expect(result.error.hints).toBeUndefined()
  })

  it('上游返回非业务信封（HTML/空 body）时不指路：那不是我们的协议在说话', async () => {
    // 独立验证 R-1：认不出信封 = 反代 HTML / 空 body / 被劫持的响应，
    // 装作者手册解决不了；把原文带出去就够了。
    const h = harness(() => new Response('<html>502 Bad Gateway</html>', {
      status: 502, headers: { 'content-type': 'text/html' },
    }))
    const result = await failingPublish(h)
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('UNEXPECTED_UPSTREAM_BODY')
    expect(JSON.stringify(result)).not.toContain(APP_BUILDER_SKILL)
  })

  it('网关不可达（502 GATEWAY_UNAVAILABLE）不指路：那是网络故障，不是作者不懂 ABI', async () => {
    // 审计 aitools P2-2 复现的形态：出站失败被包成 502 信封，旧实现会追加
    // "去能力中心装作者手册"，把模型引向与故障无关的动作。
    const h = harness(() => json(502, {
      error: { code: 'GATEWAY_UNAVAILABLE', message: '服务端不可达', hints: ['确认服务端地址与网络后重试'] },
    }))
    const result = await failingPublish(h)
    expect(result.status).toBe(502)
    expect(result.error.hints).toEqual(['确认服务端地址与网络后重试'])
    expect(JSON.stringify(result)).not.toContain(APP_BUILDER_SKILL)
  })

  it('本地 wasm_path 闸门（产品代码自己产生 400）不指路：路径问题与手册无关', async () => {
    const h = harness(() => json(201, {}))
    const result = await h.run('wasm_app_publish', {
      appId: 'shared-notes', version: '1.0.0', wasmPath: join(workspace, 'nope.wasm'),
      title: '共享便签', config: CONFIG,
    })
    expect(result.status).toBe(400)
    expect(result.error.code).toBe('WASM_PATH_NOT_FOUND')
    expect(result.error.hints ?? []).not.toContain(expect.stringContaining(APP_BUILDER_SKILL))
    expect(JSON.stringify(result)).not.toContain(APP_BUILDER_SKILL)
    expect(h.outbound).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 3. 工具描述与服务端实现一致（文本侧的反向断言）
// ---------------------------------------------------------------------------

/**
 * 模型关于"下架"与"旧配置字段"的唯一知识来源就是这几句描述 —— 描述与实现相反时，
 * 模型会自信地给出错误结论（独立评审 R1-pm-5 / R1-uxc-8 的文本侧）。
 *
 * 这一组因此不满足于"描述里有某个词"，而是**两端一起钉**：
 *  - 先断言服务端实现仍然是那个语义（`enabled=false` ⇒ 410 Gone；未知字段才拒、
 *    `visible`/`login_required` 走兼容映射）—— 实现改了这里先红，逼人回来同步描述；
 *  - 再断言描述说的就是那个语义，且**旧的错误说法不再出现**（把描述改回去即红）。
 */
describe('工具描述与服务端实现一致（下架语义 / 旧配置字段语义）', () => {
  const h = harness(() => json(200, {}))
  const byName = (name: string): ToolDef => h.tools.find(tool => tool.name === name)!

  const SERVE_GO = readFileSync(join(REPO_ROOT, 'server/internal/wasmapp/appserver/serve.go'), 'utf8')
  const READ_GO = readFileSync(join(REPO_ROOT, 'server/internal/wasmapp/api/read.go'), 'utf8')
  const APPCFG_GO = readFileSync(join(REPO_ROOT, 'server/internal/wasmapp/appcfg/appcfg.go'), 'utf8')
  const INHERIT_GO = readFileSync(join(REPO_ROOT, 'server/internal/wasmapp/appcfg/inherit.go'), 'utf8')

  it('服务端实现：enabled=false 走 writeGone（410），下架条目**照样**列在目录里', () => {
    // 先证明"实现是 410"仍然是事实（否则下面的描述断言没有意义）。
    expect(SERVE_GO, 'serve.go 的 !app.Enabled 分支不再 writeGone：请连同工具描述一起复核').toMatch(/if\s*!app\.Enabled\s*\{[\s\S]{0,240}?writeGone\(/)
    // 目录条件只排除冻结与无版本行 —— 下架**不在**排除项里。
    expect(READ_GO).toMatch(/if\s*a\.FrozenAt\s*!=\s*nil\s*\|\|\s*a\.CurrentReleaseID\s*<=\s*0\s*\{\s*\n\s*continue/)
    expect(READ_GO).toContain('"enabled":    a.Enabled')
  })

  it('wasm_app_list 描述说"下架即不能访问（410）"，且不再说"域名仍然可访问/不在应用中心推荐"', () => {
    const description = byName('wasm_app_list').description
    // ① 下架语义与实现一致（旧描述说"可访问"，正是被勘误的那句）。
    expect(description).toContain('410')
    expect(description).toContain('不能访问')
    expect(description).not.toContain('仍然可访问')
    // ② 目录语义：下架条目**也列出**（旧描述说"不在应用中心推荐"是反的）。
    expect(description).toContain('也会列出')
    expect(description).not.toContain('不在应用中心推荐')
  })

  it('config 描述说清"未知字段才拒"与旧字段的真实后果（与 appcfg 的 decode + mergeMissing 一致）', () => {
    // 服务端事实：只有 !knownField(k) 才报 unknown_field；旧字段被显式解析（decode
    // 的 shim 仍在，首版/无基线时参与映射）。
    expect(APPCFG_GO).toMatch(/if\s*!knownField\(k\)/)
    expect(APPCFG_GO).toContain('legacyFieldLoginRequired')
    expect(APPCFG_GO).toContain('legacyFieldVisible')
    // 而**继承**一侧不得再看这两个键：旧字段不参与"字段是否缺席"的判定
    // （2026-09-19 审计 §1.3：带 visible 的更新曾让白名单应用静默变 login）。
    // 变异：把 legacy 键重新计入 mergeMissing 的缺席判定 ⇒ 本断言红。
    const mergeMissing = /func mergeMissing\([\s\S]*?\n}/.exec(INHERIT_GO)?.[0] ?? ''
    expect(mergeMissing, 'inherit.go 里找不到 mergeMissing').not.toBe('')
    expect(mergeMissing).not.toContain('legacyField')
    expect(mergeMissing).toContain('KnownFields')

    const publishConfig = String(byName('wasm_app_publish').parameters.properties!.config!.description)
    const validateConfig = String(byName('wasm_app_validate').parameters.properties!.config!.description)
    for (const description of [publishConfig, validateConfig]) {
      // 旧说法：把这两个**兼容字段**当成"会被拒的未知字段"的例子（与实现相反）。
      expect(description).not.toContain('例如已删除的 visible / login_required')
      // 未知字段才拒 + 旧字段是兼容形态。
      expect(description).toContain('未知')
      expect(description).toContain('兼容')
      // 关键（本次修复的契约）：旧字段**不参与缺席判定** ⇒ 带了它们也照样沿用上一版，
      // 访问级别不会被它们改写。
      expect(description).toContain('不参与')
      expect(description).toContain('沿用')
      // 基线坏行的语义也说清：拒绝发布（不是静默回落成缺省），模型据此不再盲目重试。
      expect(description).toContain('baseline_unusable')
      expect(description).toContain('拒绝')
    }
  })

  it('待审语义分首版与已有应用（原句只对已有应用成立）', () => {
    // 服务端事实：首版在审核通过前既不在目录里（read.go 的 CurrentReleaseID<=0 跳过），
    // 子域也是 404"应用还没有可用版本"（serve.go）。
    expect(SERVE_GO).toContain('应用还没有可用版本')
    const description = byName('wasm_app_publish').description
    expect(description).toContain('首版')
    expect(description).toContain('还没有可用版本')
  })
})
