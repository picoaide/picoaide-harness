import { describe, expect, it, vi } from 'vitest'
import { apply as applyBootstrap, maxOutputFromDefaultParams } from '../src/bootstrap.ts'
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

function stubCtx(): {
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
    picoSession: { clear: vi.fn() },
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
      await vi.waitFor(() => { expect(settings.update).toHaveBeenCalled() })

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

  it('clears the search namespace on logout', async () => {
    const { ctx, settings, onHandler } = stubCtx()
    applyBootstrap(ctx)
    await onHandler(null)
    await vi.waitFor(() => { expect(settings.replace).toHaveBeenCalled() })
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
