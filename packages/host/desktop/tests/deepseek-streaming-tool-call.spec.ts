import type { AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { MessageId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  DeepSeekAdapter,
  resolveAdapterOptions,
} from '@deepseek-ai/dsh-llm-deepseek'
import { afterEach, describe, expect, it, vi } from 'vitest'

function sseResponse(payloads: readonly unknown[]): Response {
  const body = payloads
    .map(payload => `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`)
    .join('')
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

describe('DeepSeek streaming tool calls', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps the first non-empty id and name when continuation deltas contain empty strings', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_web_search',
              type: 'function',
              function: { name: 'web_search', arguments: '{"query":' },
            }],
          },
        }],
      },
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: '',
              function: { name: '', arguments: '"AI news today"}' },
            }],
          },
        }],
      },
      {
        choices: [{ delta: {}, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
      '[DONE]',
    ])))

    // protocol 必须与产品写入一致：0.1.6-alpha.2 的适配器默认 `messages`
    // （请求打 /v1/messages、只发 x-api-key），而网关只认 Authorization: Bearer。
    // enterprise/gateway-model 显式写 'chat-completions'，这里跟随该契约。
    const connection = resolveAdapterOptions({
      protocol: 'chat-completions',
      baseURL: 'https://example.test/v1',
      thinking: 'disabled',
    })
    const adapter = new DeepSeekAdapter({
      options: () => connection,
      resolveApiKey: async () => 'test-key',
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
