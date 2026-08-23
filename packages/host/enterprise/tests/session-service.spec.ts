import { describe, expect, it, vi } from 'vitest'
import SessionService, { Config, SESSION_CHANGED_EVENT } from '../src/session-service.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '../src/server-connector/config.ts'

const SAMPLE_SESSION: Session = {
  serverURL: 'https://gateway.example',
  username: 'tester',
  token: 'tok-1',
}

function stubCtx(): { ctx: Context; emit: ReturnType<typeof vi.fn> } {
  const emit = vi.fn()
  return {
    ctx: {
      emit,
      reflect: { provide: vi.fn() },
    } as unknown as Context,
    emit,
  }
}

describe('session-service', () => {
  it('exposes the stable session-changed event name', () => {
    expect(SESSION_CHANGED_EVENT).toBe('pico/session-changed')
  })

  it('validates the tokenFile config through the schema', () => {
    const value = Config({ tokenFile: '/tmp/session.json' })
    expect(value.tokenFile).toBe('/tmp/session.json')
    // tokenFile is optional: the service falls back to $DSH_HOME/session.json.
    expect(Config({}).tokenFile).toBeUndefined()
  })

  it('starts logged out and emits on set and clear', async () => {
    const { ctx, emit } = stubCtx()
    const service = new SessionService(ctx, { tokenFile: '/tmp/unused-session.json' })
    expect(service.isLoggedIn()).toBe(false)
    expect(service.getSession()).toBeNull()
    // restore() runs asynchronously; in a non-Electron test it resolves to null
    // and must not flip an already-set session.
    await vi.waitFor(() => { expect(emit).toHaveBeenCalledWith(SESSION_CHANGED_EVENT, null) })

    service.setSession(SAMPLE_SESSION)
    expect(service.isLoggedIn()).toBe(true)
    expect(service.getSession()).toEqual(SAMPLE_SESSION)
    expect(emit).toHaveBeenCalledWith(SESSION_CHANGED_EVENT, SAMPLE_SESSION)

    service.clear()
    expect(service.isLoggedIn()).toBe(false)
    expect(emit).toHaveBeenCalledWith(SESSION_CHANGED_EVENT, null)
  })

  it('never lets an async restore overwrite an already-set session', async () => {
    const { ctx, emit } = stubCtx()
    const service = new SessionService(ctx, { tokenFile: '/tmp/unused-session.json' })
    service.setSession(SAMPLE_SESSION)
    // restore() settles after setSession; the session must stay the set value.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(service.getSession()).toEqual(SAMPLE_SESSION)
    expect(emit).toHaveBeenCalledWith(SESSION_CHANGED_EVENT, SAMPLE_SESSION)
  })
})

describe('defaultTokenFile', () => {
  it('uses $DSH_HOME when set', async () => {
    const { defaultTokenFile } = await import('../src/session-service.ts')
    expect(defaultTokenFile({ DSH_HOME: '/custom/home' })).toBe('/custom/home/session.json')
  })

  it('falls back to the product home when DSH_HOME is unset or blank', async () => {
    const { defaultTokenFile } = await import('../src/session-service.ts')
    const home = expect(defaultTokenFile({})).toContain('.picoaide-harness')
    expect(home).toBeTruthy()
    expect(defaultTokenFile({ DSH_HOME: '   ' })).toContain('.picoaide-harness')
  })
})

describe('authErrorMessage', () => {
  it('maps every auth failure kind to user-facing Chinese copy', async () => {
    const { authErrorMessage } = await import('../src/server-connector/auth.ts')
    expect(authErrorMessage('invalid_credentials')).toContain('账号')
    expect(authErrorMessage('auth_expired')).toContain('登录已过期')
    expect(authErrorMessage('network')).toContain('网络')
    expect(authErrorMessage('server_error')).toContain('服务端')
  })
})

describe('maxOutputFromDefaultParams', () => {
  it('extracts max_output from the server default_params JSON', async () => {
    const { maxOutputFromDefaultParams } = await import('../src/bootstrap.ts')
    expect(maxOutputFromDefaultParams('{"context_length":1048576,"max_output":393216}')).toBe(393216)
    expect(maxOutputFromDefaultParams('{"max_output":0}')).toBeUndefined()
    expect(maxOutputFromDefaultParams('not-json')).toBeUndefined()
    expect(maxOutputFromDefaultParams(undefined)).toBeUndefined()
  })
})
