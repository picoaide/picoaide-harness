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
      baseURL: 'https://gateway.example/v1',
      apiKeyEnv: TOKEN_ENV,
    }))
  })

  it('strips trailing slashes from the server URL', async () => {
    const f = ctxFixture()
    apply(f.ctx)
    f.emit({ ...SESSION, serverURL: 'https://gateway.example///' })
    await vi.waitFor(() => expect(f.update).toHaveBeenCalledWith(expect.anything(), {
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
})
