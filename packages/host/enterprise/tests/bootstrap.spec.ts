import { describe, expect, it, vi } from 'vitest'
import { apply as applyBootstrap, maxOutputFromDefaultParams, resolveInputModalities } from '../src/bootstrap.ts'
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
      await vi.waitFor(() => { expect(settings.update).toHaveBeenCalled() })

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
