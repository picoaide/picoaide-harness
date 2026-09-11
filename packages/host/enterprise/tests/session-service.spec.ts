import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
      on: vi.fn(() => () => {}), // 2026-09: deep-link listener 安装需要
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
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
    // mac CI runner 上 setup 需下载 Electron, 网络波动可致 5s 默认超时(flaky);
    // 给足 30s。
  }, 30000)

  it('degrades with a warning instead of an unhandled rejection when the token file is unwritable (P1-13)', async () => {
    const { ctx, emit } = stubCtx()
    const warn = (ctx.logger as unknown as { warn: ReturnType<typeof vi.fn> }).warn
    const service = new SessionService(ctx, { tokenFile: '/nonexistent-picoaide-dir-xyz/session.json' })
    const rejections: unknown[] = []
    const onRejection = (reason: unknown): void => { rejections.push(reason) }
    process.on('unhandledRejection', onRejection)
    try {
      service.setSession(SAMPLE_SESSION)
      await vi.waitFor(() => { expect(warn).toHaveBeenCalled() })
      // Give the rejection path a chance to surface if the write were still
      // fire-and-forget: a rejected persist() must never reach the process.
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(rejections).toEqual([])
      // Degraded, not dropped: the session stays usable for this run.
      expect(service.getSession()).toEqual(SAMPLE_SESSION)
      expect(emit).toHaveBeenCalledWith(SESSION_CHANGED_EVENT, SAMPLE_SESSION)
      expect(String(warn.mock.calls[0]?.[0])).toContain('could not be persisted')
    } finally {
      process.off('unhandledRejection', onRejection)
    }
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


describe('session persist 竞态 (F7 复核)', () => {
  it('clear() 之后在途的异步 persist 不得复活 token 文件', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pico-session-race-'))
    const file = join(dir, 'session.json')
    const { ctx } = stubCtx()
    const service = new SessionService(ctx, { tokenFile: file })
    // 登录后立即登出:persist 仍在 await 动态 import,clear 已同步删除文件。
    service.setSession(SAMPLE_SESSION)
    service.clear()
    await new Promise((r) => setTimeout(r, 80))
    expect(existsSync(file)).toBe(false)
    expect(service.isLoggedIn()).toBe(false)
  }, 30000)
})
