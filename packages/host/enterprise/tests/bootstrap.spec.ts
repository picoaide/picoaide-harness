import { describe, expect, it, vi } from 'vitest'
import { apply as applyBootstrap, maxOutputFromDefaultParams, resolveInputModalities } from '../src/bootstrap.ts'
import { GATEWAY_LLM_ROW_ID } from '../src/gateway-contract.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '../src/server-connector/config.ts'

const SAMPLE_SESSION: Session = {
  serverURL: 'https://gateway.example',
  username: 'tester',
  token: 'tok-1',
}

const SAMPLE_BOOTSTRAP = {
  default_model: 'deepseek-chat',
  models: [{ id: 'deepseek-chat', display_name: 'DeepSeek Chat', default_params: '{"max_output": 8192}' }],
  skills: [],
  mcp: [],
  web: { default_thinking_level: 'high' },
}

const VISION_BOOTSTRAP = {
  ...SAMPLE_BOOTSTRAP,
  models: [
    { id: 'deepseek-chat', display_name: 'DeepSeek Chat', default_params: '{"max_output": 8192}' },
    { id: 'deepseek-v4-flash-vision-exp', display_name: '视觉', input_modalities: ['text', 'image'] },
  ],
}

function stubCtx(restored?: Session | null): {
  ctx: Context
  settings: { update: ReturnType<typeof vi.fn>; replace: ReturnType<typeof vi.fn> }
  onHandler: (s: Session | null) => Promise<void>
} {
  const update = vi.fn(async () => undefined)
  const replace = vi.fn(async () => undefined)
  let registered: ((s: Session | null) => Promise<void>) | undefined
  const on = vi.fn((_event: string, handler: (s: Session | null) => Promise<void>) => { registered = handler })
  const ctx = {
    settings: { update, replace },
    // subscribeSession 用 isRestored() 判断"启动时那次会话事件是否已经错过"。
    // 不传 restored = 恢复还在进行（事件随后必到）。
    picoSession: {
      clear: vi.fn(),
      isRestored: () => restored !== undefined,
      getSession: () => restored ?? null,
    },
    logger: { error: vi.fn() },
    on,
  } as unknown as Context
  const fire = (s: Session | null): Promise<void> => registered!(s)
  return { ctx, settings: { update, replace }, onHandler: fire }
}

describe('bootstrap sync', () => {
  it('maps the gateway token and base URL onto web-search-deepseek (0043 proxy)', async () => {
    const { ctx, settings, onHandler } = stubCtx()
    // 模拟 getBootstrap:注入一次成功响应
    const origFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(SAMPLE_BOOTSTRAP), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch

    try {
      applyBootstrap(ctx)
      // 触发 sync:回调内部 void sync(),等待其微任务/IO 完成
      await onHandler(SAMPLE_SESSION)
      // 现象：进程内异步状态传播（事件/回调派发后的断言）；vitest 缺省的 1s 在 CI 4 vCPU 负载下不够（R11-B-02）。
      await vi.waitFor(() => { expect(settings.update).toHaveBeenCalled() }, { timeout: 10_000 })

      // llm-deepseek 配置正确
      expect(settings.update).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat', maxTokens: 8192 }],
        reasoningEffort: 'high',
      }))
      // web-search-deepseek 被 repoint 到网关 token + 网关 v1 前缀
      expect(settings.update).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        apiKeyEnv: 'PICOAI_GATEWAY_TOKEN',
        baseURL: 'https://gateway.example/v1',
        model: 'deepseek-chat',
      }))
      expect(settings.replace).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        provider: 'deepseek-official',
        model: 'deepseek-chat',
        reasoningEffort: 'high',
      }))
    } finally {
      globalThis.fetch = origFetch
    }
  })

  it('maps the vision model input modalities onto the catalog (0058)', async () => {
    const { ctx, settings, onHandler } = stubCtx()
    const origFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(VISION_BOOTSTRAP), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch

    try {
      applyBootstrap(ctx)
      await onHandler(SAMPLE_SESSION)
      // 现象：进程内异步状态传播（事件/回调派发后的断言）；vitest 缺省的 1s 在 CI 4 vCPU 负载下不够（R11-B-02）。
      await vi.waitFor(() => { expect(settings.update).toHaveBeenCalled() }, { timeout: 10_000 })

      expect(settings.update).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        models: [
          { id: 'deepseek-chat', name: 'DeepSeek Chat', maxTokens: 8192 },
          { id: 'deepseek-v4-flash-vision-exp', name: '视觉', inputModalities: ['text', 'image'] },
        ],
      }))
    } finally {
      globalThis.fetch = origFetch
    }
  })

  it('syncs immediately for a session restored before the plugin was applied', async () => {
    // 2026-09-05 现场：升级后旧会话下视觉模型缺 inputModalities、上传图片被拒，
    // **重新登录即恢复** —— 因为 restore() 在 SessionService 构造期就跑完了，
    // 它 emit 的那次会话事件早于本插件 apply，裸 ctx.on 整个漏掉，启动后一次
    // bootstrap 同步都没发生。subscribeSession 必须把这第一次补上。
    const { ctx, settings } = stubCtx(SAMPLE_SESSION)
    const origFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(VISION_BOOTSTRAP), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch
    try {
      applyBootstrap(ctx)
      // 没有任何 onHandler 触发：全靠 apply 时的补发。
      await vi.waitFor(() => { expect(settings.update).toHaveBeenCalled() }, { timeout: 10_000 })
      expect(settings.update).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        models: [
          { id: 'deepseek-chat', name: 'DeepSeek Chat', maxTokens: 8192 },
          { id: 'deepseek-v4-flash-vision-exp', name: '视觉', inputModalities: ['text', 'image'] },
        ],
      }))
    } finally {
      globalThis.fetch = origFetch
    }
  })

  it('clears the search namespace on logout', async () => {
    const { ctx, settings, onHandler } = stubCtx()
    applyBootstrap(ctx)
    await onHandler(null)
    // 现象：进程内异步状态传播（事件/回调派发后的断言）；vitest 缺省的 1s 在 CI 4 vCPU 负载下不够（R11-B-02）。
    await vi.waitFor(() => { expect(settings.replace).toHaveBeenCalled() }, { timeout: 10_000 })
    expect(settings.replace).toHaveBeenCalledWith(expect.anything(), {})
    expect(settings.replace).toHaveBeenCalledTimes(3)
  })
})

describe('maxOutputFromDefaultParams', () => {
  it('extracts max_output from default params JSON', () => {
    expect(maxOutputFromDefaultParams('{"max_output": 4096}')).toBe(4096)
  })
  it('returns undefined for missing/invalid params', () => {
    expect(maxOutputFromDefaultParams('{}')).toBeUndefined()
    expect(maxOutputFromDefaultParams('not-json')).toBeUndefined()
    expect(maxOutputFromDefaultParams('{"max_output": -1}')).toBeUndefined()
    expect(maxOutputFromDefaultParams(undefined as unknown as string)).toBeUndefined()
  })
})

describe('resolveInputModalities', () => {
  it('passes through text+image and deduplicates', () => {
    expect(resolveInputModalities(['text', 'image'])).toEqual(['text', 'image'])
    expect(resolveInputModalities(['image', 'text', 'text'])).toEqual(['image', 'text'])
    expect(resolveInputModalities(['text'])).toEqual(['text'])
  })
  it('returns undefined for missing/invalid/empty values (schema defaults text-only)', () => {
    expect(resolveInputModalities(undefined)).toBeUndefined()
    expect(resolveInputModalities([])).toBeUndefined()
    expect(resolveInputModalities(['audio'])).toBeUndefined()
    expect(resolveInputModalities('text' as unknown as string[])).toBeUndefined()
  })
})

describe('会话代际守卫（Z2-01）：迟到的 bootstrap 响应不得落地', () => {
  // 场景：`getBootstrap` 缺省 15s 超时，期间用户登出并登录到**另一台**服务端。
  // 没有守卫时，迟到的旧响应会把上一台的模型目录/默认模型/搜索地址写进当前会话，
  // 而 `PICOAI_GATEWAY_TOKEN` 已经是新服务端的令牌 ⇒ 一次 web 搜索就把新会话的
  // bearer 发到旧服务端的 `/v1/messages`（跨租户凭据外泄）。
  const SESSION_A: Session = { serverURL: 'https://server-a.example.com', username: 'alice', token: 'tok-a' }
  const SESSION_B: Session = { serverURL: 'https://server-b.example.com', username: 'bob', token: 'tok-b' }

  type Deferred = { resolve: (r: Response) => void }
  let pending: Map<'A' | 'B', Deferred[]>

  /** 受控 fetch：每个服务端一个队列，由用例决定响应到达顺序。 */
  function installDeferredFetch(): () => void {
    pending = new Map()
    const original = globalThis.fetch
    globalThis.fetch = vi.fn((input: unknown) => {
      const url = String(input)
      const key: 'A' | 'B' = url.startsWith('https://server-a') ? 'A' : 'B'
      return new Promise<Response>((resolve) => {
        const queue = pending.get(key) ?? []
        queue.push({ resolve })
        pending.set(key, queue)
      })
    }) as unknown as typeof fetch
    return () => { globalThis.fetch = original }
  }

  function respond(key: 'A' | 'B', model: string): void {
    const next = (pending.get(key) ?? []).shift()
    if (next === undefined) throw new Error(`没有在飞的请求：${key}`)
    next.resolve(new Response(JSON.stringify({
      default_model: model,
      models: [{ id: model, display_name: model }],
      skills: [],
      mcp: [],
      web: {},
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
  }

  const flush = async (n = 12): Promise<void> => {
    for (let i = 0; i < n; i += 1) await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
  }

  /** 取某个 namespace 最后一次写入的值（update/replace 合并看）。 */
  function lastWrite(settings: { update: ReturnType<typeof vi.fn>; replace: ReturnType<typeof vi.fn> }, ns: string): Record<string, unknown> | undefined {
    const calls = [...settings.update.mock.calls, ...settings.replace.mock.calls]
      .filter((call) => String(call[0]) === ns)
    return calls.at(-1)?.[1] as Record<string, unknown> | undefined
  }

  it('换服务端后到达的旧响应必须被丢弃（模型目录 / 默认模型 / 搜索地址）', async () => {
    const restore = installDeferredFetch()
    try {
      const { ctx, settings, onHandler } = stubCtx()
      applyBootstrap(ctx)

      onHandler(SESSION_A) // A 的 bootstrap 挂住
      await flush()
      expect(pending.get('A')).toHaveLength(1)

      onHandler(null) // 登出
      onHandler(SESSION_B) // 立刻登录到另一台
      await flush()

      respond('B', 'model-of-B') // B 先回
      await flush()
      expect(lastWrite(settings, 'web-search-deepseek')?.baseURL).toBe('https://server-b.example.com/v1')

      respond('A', 'model-of-A') // A 现在才回 —— 必须被整份丢弃
      await flush()

      expect(
        {
          search: lastWrite(settings, 'web-search-deepseek'),
          catalog: lastWrite(settings, GATEWAY_LLM_ROW_ID),
          defaultModel: lastWrite(settings, 'agent-default-model'),
        },
        '迟到响应改写了当前会话（B）的模型配置：凭据是新服务端的令牌，baseURL/模型目录却是旧服务端的',
      ).toEqual({
        search: { apiKeyEnv: 'PICOAI_GATEWAY_TOKEN', baseURL: 'https://server-b.example.com/v1', model: 'model-of-B' },
        catalog: { models: [{ id: 'model-of-B', name: 'model-of-B' }] },
        defaultModel: { provider: 'deepseek-official', model: 'model-of-B' },
      })
    } finally {
      restore()
    }
  })

  it('登出之后到达的旧响应不得把 settings 重新写回（登出态保持清空）', async () => {
    const restore = installDeferredFetch()
    try {
      const { ctx, settings, onHandler } = stubCtx()
      applyBootstrap(ctx)

      onHandler(SESSION_A)
      await flush()
      onHandler(null)
      await flush()
      const writesAfterLogout = settings.update.mock.calls.length + settings.replace.mock.calls.length
      expect(writesAfterLogout, '登出必须把三个 namespace 清空').toBe(3)

      respond('A', 'model-of-A')
      await flush()

      expect(
        settings.update.mock.calls.length + settings.replace.mock.calls.length,
        '登出之后迟到的旧响应把 settings 重新写回了',
      ).toBe(writesAfterLogout)
    } finally {
      restore()
    }
  })
})
