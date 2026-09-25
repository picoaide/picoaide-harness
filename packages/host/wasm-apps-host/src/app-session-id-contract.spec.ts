/**
 * 隐藏会话 id 的**跨端契约对拍**（R13-GB）。
 *
 * 真源 = `server/internal/llmgateway/app-session-id.json`（服务端 `//go:embed` 它并按里面的
 * 前缀/分隔符/正则解析归因；Go 侧的对拍在 `app_session_id_test.go`）。本文件跑**另一半**：
 * 用同一份 `build_cases` 语料断言客户端**构造**出来的 id 逐字等于语料里的 id。
 *
 * 为什么必须对拍而不是"两边都写 `app:`"：隐藏会话 id 同时是
 * ①本机多轮上下文的键、②服务端用量归因的输入。两端各自演化时，id 会静默错开 ——
 * 应用照常能聊（本机看不出来），而管理端的应用维度用量**一条都不会有**（`app:` 前缀
 * 派生不出 app_id 就是"无归因"）。本仓已有 5 个 P0 出自同一失效模式。
 *
 * 三条判据：
 *  ① 形状常量逐字相等（前缀 / 分隔符 / app_id 正则与上限 / 出站头名）；
 *  ② 同一份语料：`hiddenSessionId({user, serverURL}, appId) == session_id`；
 *  ③ 与现实绑定：出站头名必须仍是上游 `llm-deepseek` 适配器真的在发的那个头；
 *     app_id 正则必须与客户端半边（`appcfg-contract.ts`）逐字相同（第三份拷贝不许漂移）。
 *
 * 变异验证：把 `AI_HIDDEN_SESSION_SCOPE_SEPARATOR` 改成 `@`、或把账号作用域从
 * `hiddenSessionId` 里删掉 ⇒ 第一条/第二条必红；把 JSON 的 `scope_separator` 改了而
 * 客户端不改 ⇒ 同样红。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  AI_APP_ID_MAX_LENGTH,
  AI_APP_ID_PATTERN,
  AI_HIDDEN_SESSION_PREFIX,
  AI_HIDDEN_SESSION_SCOPE_SEPARATOR,
  AI_SESSION_ID_HEADER,
  hiddenSessionId,
} from './ai-chat.ts'

const CONTRACT = fileURLToPath(new URL('../../../../server/internal/llmgateway/app-session-id.json', import.meta.url))
const UPSTREAM_ADAPTER = fileURLToPath(new URL('../../../../deepseek-harness/packages/llm/llm-deepseek/src/protocols/chat-completions/adapter.ts', import.meta.url))
const CLIENT_APPCFG = fileURLToPath(new URL('../../../../packages/client/wasm-apps/src/client/appcfg-contract.ts', import.meta.url))

/** 契约结构（只声明本用例消费的字段）。 */
interface AppSessionIDContract {
  schema: string
  prefix: string
  scope_separator: string
  app_id_pattern: string
  app_id_max_length: number
  session_id_header: string
  legacy_form: string
  build_cases: Array<{ user: string, server_url: string, app_id: string, session_id: string }>
  parse_cases: Array<{ session_id: string, app_id: string, note: string }>
}

/** 读契约（**必须存在**：缺失即失败，不是跳过 —— 静默跳过等于把这条判据关掉）。 */
function contract(): AppSessionIDContract {
  const parsed = JSON.parse(readFileSync(CONTRACT, 'utf8')) as AppSessionIDContract
  expect(parsed.schema, `契约版本换了就必须有人来对齐两端（${CONTRACT}）`).toBe('picoaide-app-session-id/1')
  return parsed
}

/** 从源码里取一个字符串常量的字面量值（**故意不 import 对方包**：跨包 import 会引入构建
 * 依赖，而且"两边 import 同一个常量"本身就不是对拍）。 */
function literalOf(source: string, name: string): string | undefined {
  return new RegExp(`export const ${name}\\s*=\\s*'([^']*)'`, 'u').exec(source)?.[1]
}

describe('隐藏会话 id 的账号作用域：与服务端契约逐字对拍（R13-GB）', () => {
  it('形状常量逐字相等（前缀 / 分隔符 / 正则 / 上限 / 出站头名）', () => {
    const spec = contract()
    expect(AI_HIDDEN_SESSION_PREFIX).toBe(spec.prefix)
    expect(AI_HIDDEN_SESSION_SCOPE_SEPARATOR).toBe(spec.scope_separator)
    expect(AI_APP_ID_PATTERN.source).toBe(spec.app_id_pattern)
    expect(AI_APP_ID_MAX_LENGTH).toBe(spec.app_id_max_length)
    expect(AI_SESSION_ID_HEADER).toBe(spec.session_id_header)
    // 前缀必须保留（服务端归因按它派生）：这是本契约的**存在理由**，单独钉一条。
    expect(AI_HIDDEN_SESSION_PREFIX).toBe('app:')
  })

  it('同一份语料：客户端构造的 id 逐字等于契约里的 session_id', () => {
    const spec = contract()
    expect(spec.build_cases.length, '语料为空 ⇒ 对拍空转').toBeGreaterThan(0)
    for (const entry of spec.build_cases) {
      const built = hiddenSessionId({ userId: entry.user, serverURL: entry.server_url }, entry.app_id)
      expect(built, `语料 (user=${entry.user}, server=${entry.server_url}, app=${entry.app_id})`).toBe(entry.session_id)
      // 每条语料都必须真的带账号作用域（这正是要防的形态：只有应用维度的 id）。
      expect(built).toContain(AI_HIDDEN_SESSION_SCOPE_SEPARATOR)
    }
  })

  it('两个账号 / 两个服务端 ⇒ 同一个应用上是**不同**的会话 id', () => {
    const spec = contract()
    const first = spec.build_cases[0]!
    const alice = hiddenSessionId({ userId: first.user, serverURL: first.server_url }, first.app_id)
    const bob = hiddenSessionId({ userId: 'bob', serverURL: first.server_url }, first.app_id)
    const otherTenant = hiddenSessionId({ userId: first.user, serverURL: 'https://second.example.com' }, first.app_id)
    expect(new Set([alice, bob, otherTenant]).size).toBe(3)
  })

  it('历史形态不复用：新 id 永远不等于语料里的旧形态 id', () => {
    const spec = contract()
    const legacy = spec.parse_cases
      .filter(entry => entry.app_id !== '' && !entry.session_id.slice(spec.prefix.length).includes(spec.scope_separator))
      .map(entry => entry.session_id)
    // 兼容承诺的判据本身也要有判据：语料里必须留着历史形态。
    expect(legacy.length, `语料里没有历史形态 ${spec.legacy_form} 的用例`).toBeGreaterThan(0)
    for (const entry of spec.build_cases) {
      const built = hiddenSessionId({ userId: entry.user, serverURL: entry.server_url }, entry.app_id)
      expect(legacy).not.toContain(built)
    }
  })

  it('空账号 / 非法 app_id 一律拒绝构造（不产出可共享或不可归因的 id）', () => {
    const scope = { userId: 'alice', serverURL: 'https://harness.example.com' }
    expect(() => hiddenSessionId({ userId: '   ' }, 'demo')).toThrow(/account scope/u)
    for (const bad of ['', 'Demo', 'a--b', '-x', 'x-', 'notes.example', 'a'.repeat(AI_APP_ID_MAX_LENGTH + 1)]) {
      expect(() => hiddenSessionId(scope, bad), bad).toThrow(/app_id/u)
    }
  })

  it('与上游绑定：出站头名仍是 llm-deepseek 适配器真的在发的那个头', () => {
    const adapter = readFileSync(UPSTREAM_ADAPTER, 'utf8')
    // 适配器里那一行是 `{ 'x-deepseek-harness-session-id': String(options.sessionId) }`。
    expect(adapter).toContain(`'${AI_SESSION_ID_HEADER}': String(options.sessionId)`)
    expect(contract().session_id_header).toBe(AI_SESSION_ID_HEADER)
  })

  it('app_id 规则三份拷贝不许漂移（客户端半边 appcfg-contract.ts ↔ 本契约）', () => {
    const client = readFileSync(CLIENT_APPCFG, 'utf8')
    const spec = contract()
    expect(literalOf(client, 'APP_ID_PUNYCODE_PREFIX'), 'appcfg-contract.ts 的常量表换了名字？').toBe('xn--')
    // 正则与长度都以 `export const APP_ID_PATTERN = /…/u` / `= 63` 形态声明在客户端半边。
    expect(client).toContain(`export const APP_ID_PATTERN = /${spec.app_id_pattern}/u`)
    expect(new RegExp(`export const APP_ID_MAX_LENGTH = ${String(spec.app_id_max_length)}\\b`, 'u').test(client)).toBe(true)
  })
})
