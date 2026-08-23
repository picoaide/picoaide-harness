import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import DesktopActionsService, { type DesktopActionsBootstrap } from '../src/desktop-actions.ts'

async function mount(bootstrap: DesktopActionsBootstrap): Promise<{
  readonly ctx: Context
  readonly service: DesktopActionsService
  dispose(): Promise<unknown>
}> {
  const ctx = new Context()
  const fiber = ctx.plugin(DesktopActionsService, bootstrap)
  await fiber
  return { ctx, service: ctx.desktopActions as DesktopActionsService, dispose: fiber.dispose }
}

describe('desktop actions Host service', () => {
  it('exposes only no-argument restart operation', async () => {
    const requestRestart = vi.fn<() => Promise<void>>(async () => {})
    const mounted = await mount({ requestRestart })

    await expect(mounted.service.requestRestart()).resolves.toBeUndefined()

    expect(requestRestart).toHaveBeenCalledWith()
    expect(Object.keys(mounted.service).sort()).not.toContain('runCommand')
  })

  it('coalesces a restart request and rejects retained references after disposal', async () => {
    let finishRestart!: () => void
    const requestRestart = vi.fn(() => new Promise<void>(resolve => { finishRestart = resolve }))
    const mounted = await mount({ requestRestart })

    const first = mounted.service.requestRestart()
    const second = mounted.service.requestRestart()
    expect(second).toBe(first)
    expect(requestRestart).toHaveBeenCalledOnce()
    await mounted.dispose()
    await expect(mounted.service.requestRestart()).rejects.toThrow(/service disposed/u)

    finishRestart()
    await expect(first).resolves.toBeUndefined()
  })
})
