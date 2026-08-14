import { describe, expect, it, vi } from 'vitest'
import {
  createDesktopShutdown,
  installShutdownRequests,
  type DesktopQuitEvent,
  type DesktopQuitSource,
  type DesktopSignalSource,
} from '../src/shutdown.ts'

describe('application shutdown requests', () => {
  it('exits after graceful disposal and ignores later completions', async () => {
    const dispose = vi.fn(async () => {})
    const exit = vi.fn()
    const shutdown = createDesktopShutdown(dispose, exit)

    await shutdown.request(0)
    await shutdown.request(1)

    expect(dispose).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('forces a wedged shutdown after the grace period', async () => {
    vi.useFakeTimers()
    const exit = vi.fn()
    const shutdown = createDesktopShutdown(
      () => new Promise<void>(() => {}),
      exit,
      25,
    )
    const request = shutdown.request(0)

    await vi.advanceTimersByTimeAsync(25)

    expect(request).toBeInstanceOf(Promise)
    expect(exit).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledWith(0)
    vi.useRealTimers()
  })

  it('escalates a repeated request without waiting for disposal', async () => {
    let finish!: () => void
    const dispose = () => new Promise<void>((resolve) => { finish = resolve })
    const exit = vi.fn()
    const shutdown = createDesktopShutdown(dispose, exit, 5_000)
    const first = shutdown.request(0)
    await Promise.resolve()

    void shutdown.request(130)
    expect(exit).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledWith(130)

    finish()
    await first
    expect(exit).toHaveBeenCalledOnce()
  })

  it('routes native quit and process signals through one removable coordinator', () => {
    const signalListeners = new Map<string, () => void>()
    const appListeners = new Map<string, (event: DesktopQuitEvent) => void>()
    const signals: DesktopSignalSource = {
      on: (event, listener) => signalListeners.set(event, listener),
      off: (event, listener) => {
        if (signalListeners.get(event) === listener) signalListeners.delete(event)
      },
    }
    const app: DesktopQuitSource = {
      on: (event, listener) => appListeners.set(event, listener),
      off: (event, listener) => {
        if (appListeners.get(event) === listener) appListeners.delete(event)
      },
    }
    const requestQuit = vi.fn()
    const remove = installShutdownRequests(signals, app, requestQuit)
    const quitEvent = { preventDefault: vi.fn() }

    signalListeners.get('SIGINT')?.()
    signalListeners.get('SIGTERM')?.()
    appListeners.get('before-quit')?.(quitEvent)

    expect(requestQuit.mock.calls).toEqual([[130], [0], [0]])
    expect(quitEvent.preventDefault).toHaveBeenCalledOnce()

    remove()
    expect(signalListeners.size).toBe(0)
    expect(appListeners.size).toBe(0)
  })
})
