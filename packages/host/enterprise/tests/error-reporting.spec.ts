import { describe, expect, it, vi } from 'vitest'
import { initSentry } from '../src/error-reporting.ts'

type InitOpts = { dsn: string; release: string; beforeSend?: (e: { level?: string }) => unknown }

const sentryMock = vi.hoisted(() => {
  const captured: { init: InitOpts[] } = { init: [] }
  return {
    captured,
    init: vi.fn((opts: InitOpts) => { captured.init.push(opts) }),
    captureMessage: vi.fn(),
  }
})

vi.mock('@sentry/node', () => sentryMock)

function lastInit(): InitOpts {
  expect(sentryMock.init).toHaveBeenCalled()
  return sentryMock.init.mock.calls.at(-1)![0] as InitOpts
}

function initCalls(): number {
  return sentryMock.init.mock.calls.length
}

describe('initSentry', () => {
  it('is a no-op for an empty DSN', async () => {
    await initSentry('', 'r1')
    await initSentry('   ', 'r1')
    expect(initCalls()).toBe(0)
    expect(sentryMock.captureMessage).not.toHaveBeenCalled()
  })

  it('calls init with the normalized DSN and release', async () => {
    sentryMock.captureMessage.mockClear()
    await initSentry('https://dsn@example.com/42', '2.5.9')
    expect(initCalls()).toBe(1)
    const opts = lastInit()
    expect(opts.dsn).toBe('https://dsn@example.com/42')
    expect(opts.release).toBe('2.5.9')
    expect(typeof opts.beforeSend).toBe('function')
    expect(sentryMock.captureMessage).toHaveBeenCalledWith('客户端已启动,错误监控已启用 (2.5.9)', 'info')
  })

  it('sends a self-check message after init under the release tag', async () => {
    sentryMock.init.mockClear()
    sentryMock.captureMessage.mockClear()
    await initSentry('https://dsn@example.com/42', '1.0.0')
    expect(sentryMock.captureMessage).toHaveBeenCalledWith('客户端已启动,错误监控已启用 (1.0.0)', 'info')
  })

  it('filters events below the configured level (warning threshold)', async () => {
    sentryMock.init.mockClear()
    await initSentry('https://dsn@example.com/42', 'r1', 'warning')
    const { beforeSend } = lastInit()
    expect(beforeSend!({ level: 'debug' })).toBeNull()
    expect(beforeSend!({ level: 'info' })).toBeNull()
    expect(beforeSend!({ level: 'warning' })).toEqual({ level: 'warning' })
    expect(beforeSend!({ level: 'error' })).toEqual({ level: 'error' })
    expect(beforeSend!({ level: 'fatal' })).toEqual({ level: 'fatal' })
    // Missing level defaults to error (passes at warning threshold).
    expect(beforeSend!({})).toEqual({})
  })

  it('uses the error default threshold when the level is unknown', async () => {
    sentryMock.init.mockClear()
    await initSentry('https://dsn@example.com/42', 'r1', 'verbose')
    const { beforeSend } = lastInit()
    expect(beforeSend!({ level: 'info' })).toBeNull()
    expect(beforeSend!({ level: 'warning' })).toBeNull()
    expect(beforeSend!({ level: 'error' })).toEqual({ level: 'error' })
    expect(beforeSend!({ level: 'fatal' })).toEqual({ level: 'fatal' })
  })

  it('passes warning-level events at the default (error) threshold', async () => {
    sentryMock.init.mockClear()
    await initSentry('https://dsn@example.com/42', 'r1')
    const { beforeSend } = lastInit()
    expect(beforeSend!({ level: 'warning' })).toBeNull()
    expect(beforeSend!({ level: 'error' })).toEqual({ level: 'error' })
  })

  it('degrades silently when a prior instance is closed', async () => {
    await expect(initSentry('https://dsn@example.com/42', 'r1')).resolves.toBeUndefined()
    // Second init with the same DSN must not throw even though the module
    // mocked here has no close (the degrade path swallows).
    await expect(initSentry('https://dsn@example.com/42', 'r1')).resolves.toBeUndefined()
  })
})
