import type { AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { MessageId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  DeepSeekAdapter,
  resolveAdapterOptions,
} from '@deepseek-ai/dsh-llm-deepseek'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * Messages SSE 帧（0.1.7 起适配器**只有**这一条协议路径）。
 *
 * 事故背景：0.1.6 的适配器有 `protocol` 选择（`chat-completions` / `messages`），
 * 这条用例当时喂的是 chat-completions 形态的 `choices[].delta.tool_calls`。
 * 0.1.7 删除了 `protocol`，端点固定 `<baseURL>/messages`、事件固定 Messages 形，
 * 旧夹具会被判 `DeepSeek Messages SSE event type mismatch`。
 *
 * @param payloads - `[event 名, data 对象]` 序列。
 * @returns SSE 正文。
 */
function messagesSse(payloads: readonly (readonly [string, unknown])[]): string {
  return payloads.map(([event, payload]) => `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`).join('')
}

/** 一段流式 tool_use：id/name 在 `content_block_start`，入参按 `input_json_delta` 分片。 */
const STREAMING_TOOL_CALL = messagesSse([
  ['message_start', {
    type: 'message_start',
    message: {
      id: 'msg_tool', type: 'message', role: 'assistant', model: 'deepseek-v4-pro',
      content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 },
    },
  }],
  ['content_block_start', {
    type: 'content_block_start', index: 0,
    content_block: { type: 'tool_use', id: 'call_web_search', name: 'web_search', input: {} },
  }],
  ['content_block_delta', {
    type: 'content_block_delta', index: 0,
    delta: { type: 'input_json_delta', partial_json: '{"query":' },
  }],
  ['content_block_delta', {
    type: 'content_block_delta', index: 0,
    delta: { type: 'input_json_delta', partial_json: '"AI news today"}' },
  }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['message_delta', {
    type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 },
  }],
  ['message_stop', { type: 'message_stop' }],
])

function sseResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

describe('DeepSeek streaming tool calls', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('assembles one tool call whose id/name come from the block start and whose arguments come from the deltas', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(STREAMING_TOOL_CALL)))

    // 0.1.7：`protocol` 不再是配置项（配了直接抛错，适配器只剩 Messages 一条路径），
    // 鉴权也由注册 provider 的一方通过 `resolveAuth` 给出，而不是适配器自己解析 key。
    // 这里按**产品的形态**给头（我们的网关只认 `Authorization: Bearer`）。
    const connection = resolveAdapterOptions({
      baseURL: 'https://harness.example.com/v1',
      thinking: 'disabled',
    })
    const adapter = new DeepSeekAdapter({
      options: () => connection,
      resolveAuth: async () => ({ headers: { Authorization: 'Bearer test-key' } }),
      resolveUserId: () => 'test-user' as AnonymousUserId,
      prepareExtensions: async () => ({ fields: {}, accept: async () => {} }),
    })
    const chunks: StreamChunk[] = []

    for await (const chunk of adapter.stream({
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      messages: [{
        id: MessageId('message-user'),
        role: 'user',
        content: [{ type: 'text', text: 'Search today AI news' }],
        source: { kind: 'user' },
      }],
      tools: [{
        name: 'web_search',
        description: 'Search the web',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      }],
    })) chunks.push(chunk)

    // 端点与鉴权头：请求真的打到网关的 Messages 路径，且带的是 Bearer。
    const [url, init] = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://harness.example.com/v1/messages')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key')

    expect(chunks.find(chunk => chunk.type === 'block-end')).toMatchObject({
      block: {
        type: 'tool-call',
        id: 'call_web_search',
        name: 'web_search',
        arguments: '{"query":"AI news today"}',
      },
    })
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'tool-calls' },
    })
  })
})
