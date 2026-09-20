import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply, TOKEN_ENV } from '../src/gateway-model.ts'
import { SESSION_CHANGED_EVENT } from '../src/session-service.ts'
import type { Session } from '../src/server-connector/config.ts'

const SESSION: Session = {
  serverURL: 'https://gateway.example/',
  username: 'tester',
  token: 'tok-1',
}

function ctxFixture() {
  const set = vi.fn(async () => {})
  const unset = vi.fn(async () => {})
  const update = vi.fn(async () => {})
  const replace = vi.fn(async () => {})
  const listeners = new Set<(session: Session | null) => void>()
  const ctx = {
    logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
    on: (event: string, listener: (session: Session | null) => void) => {
      expect(event).toBe(SESSION_CHANGED_EVENT)
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    credentials: { set, unset },
    settings: {
      update,
      replace,
    },
  } as unknown as Context
  return {
    ctx,
    set,
    unset,
    update,
    replace,
    emit: (session: Session | null) => { for (const l of [...listeners]) l(session) },
  }
}

describe('gateway-model', () => {
  it('exposes the stable env/token contract', () => {
    expect(TOKEN_ENV).toBe('PICOAI_GATEWAY_TOKEN')
  })

  it('writes the session token and points llm-deepseek at the gateway', async () => {
    const f = ctxFixture()
    apply(f.ctx)
    f.emit(SESSION)
    await vi.waitFor(() => expect(f.set).toHaveBeenCalledWith(expect.anything(), 'tok-1'))
    expect(f.unset).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(f.update).toHaveBeenCalledWith(expect.anything(), {
      protocol: 'chat-completions',
      baseURL: 'https://gateway.example/v1',
      apiKeyEnv: TOKEN_ENV,
    }))
  })

  it('syncs an already-restored session on apply (startup race)', async () => {
    // SessionService.restore() can finish before this plugin's apply(); the
    // first session-changed event is then already gone. apply() must sample
    // the restored session itself.
    const f = ctxFixture()
    ;(f.ctx as unknown as { picoSession: unknown }).picoSession = {
      isRestored: () => true,
      getSession: () => SESSION,
    }
    apply(f.ctx)
    await vi.waitFor(() => expect(f.set).toHaveBeenCalledWith(expect.anything(), 'tok-1'))
    await vi.waitFor(() => expect(f.update).toHaveBeenCalledWith(expect.anything(), {
      protocol: 'chat-completions',
      baseURL: 'https://gateway.example/v1',
      apiKeyEnv: TOKEN_ENV,
    }))
  })

  it('strips trailing slashes from the server URL', async () => {
    const f = ctxFixture()
    apply(f.ctx)
    f.emit({ ...SESSION, serverURL: 'https://gateway.example///' })
    await vi.waitFor(() => expect(f.update).toHaveBeenCalledWith(expect.anything(), {
      protocol: 'chat-completions',
      baseURL: 'https://gateway.example/v1',
      apiKeyEnv: TOKEN_ENV,
    }))
  })

  it('clears the credential and resets the section on logout', async () => {
    const f = ctxFixture()
    apply(f.ctx)
    f.emit(null)
    await vi.waitFor(() => expect(f.unset).toHaveBeenCalledWith(expect.anything()))
    await vi.waitFor(() => expect(f.replace).toHaveBeenCalledWith(expect.anything(), {}))
    expect(f.set).not.toHaveBeenCalled()
  })

  it('logs (instead of throwing) when the credential write fails', async () => {
    const f = ctxFixture()
    f.set.mockRejectedValueOnce(new Error('denied'))
    apply(f.ctx)
    f.emit(SESSION)
    await vi.waitFor(() => expect(f.ctx.logger.error).toHaveBeenCalled())
  })

  // 2026-09-20 升级审计 P0：0.1.6-alpha.2 给上游适配器新增了 `protocol`，默认
  // `messages`。这个默认值不是"接口形状"而是**契约**——它决定请求打到
  // `/v1/chat/completions` 还是 `/v1/messages`，而后者只发 `x-api-key`、在只认
  // `Authorization: Bearer` 的网关上必然 401（且计费 kind 也会记错）。
  // 本用例钉住我们的显式声明；同时探测上游默认值，一旦它不再是 messages 就提示
  // 这个 pin 可能已可删除（提示不是失败：pin 本身无害）。
  it('pins protocol=chat-completions while the upstream default is messages', async () => {
    const f = ctxFixture()
    apply(f.ctx)
    f.emit(SESSION)
    await vi.waitFor(() => expect(f.update).toHaveBeenCalled())
    const payload = f.update.mock.calls.at(-1)?.[1] as Record<string, unknown> | undefined
    expect(payload?.protocol).toBe('chat-completions')

    // 上游产物通过桌面包（部署根，声明了 llm-deepseek）解析，而不是从本包 —
    // 本包不声明该依赖，直接从测试文件解析会 Cannot find module。
    const desktopManifest = createRequire(import.meta.url).resolve('dsh-plugin-desktop/package.json')
    const pkgDir = dirname(createRequire(desktopManifest).resolve('@deepseek-ai/dsh-llm-deepseek/package.json'))
    const upstreamConfig = readFileSync(join(pkgDir, 'lib', 'index.js'), 'utf8')
    const defaultIsMessages = /default\("messages"\)/.test(upstreamConfig)
      || /protocol\s*\?\?\s*"messages"/.test(upstreamConfig)
    if (!defaultIsMessages) {
      console.warn('[gateway-model] 上游 llm-deepseek 的 protocol 默认值不再是 messages —— 复核该 pin 是否仍必要')
    }
  })
})
