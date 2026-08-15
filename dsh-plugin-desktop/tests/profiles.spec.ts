import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { DesktopRuntime, DesktopTrayItem } from '../src/runtime.ts'
import { apply, inject, name, type DesktopProfiles } from '../src/profiles.ts'

describe('desktop profiles Host plugin', () => {
  it('registers radio profile commands and restarts only after selection persists', async () => {
    let trayItem: DesktopTrayItem | undefined
    let disposeEffect: (() => void) | undefined
    const events: string[] = []
    const disposeRegistration = vi.fn()
    const runtime = {
      registerTrayItem: (item: DesktopTrayItem) => {
        trayItem = item
        return { refresh: () => {}, dispose: disposeRegistration }
      },
      requestRestart: async () => { events.push('restart') },
    } as unknown as DesktopRuntime
    const profiles: DesktopProfiles = {
      currentProfileName: 'desktop',
      list: () => [
        { name: 'desktop', dir: '/profiles/desktop', exists: true, bundles: [], webCapable: true },
        { name: '工作 profile', dir: '/profiles/work', exists: true, bundles: [], webCapable: true },
        { name: 'headless', dir: '/profiles/headless', exists: true, bundles: [], webCapable: false },
      ],
      select: async selected => { events.push(`select:${selected}`) },
    }
    const ctx = {
      desktopRuntime: runtime,
      desktopProfiles: profiles,
      effect: (register: () => (() => void)) => {
        disposeEffect = register()
        return disposeEffect
      },
    } as unknown as Context

    apply(ctx)

    expect(name).toBe('desktop-profiles')
    expect(inject).toEqual(['desktopRuntime', 'desktopProfiles'])
    expect(trayItem).toMatchObject({ group: 'profiles', order: 10 })
    expect(trayItem?.label()).toBe('Profile: desktop')
    const commands = trayItem?.submenu?.() ?? []
    expect(commands.map(command => ({
      label: command.label(),
      checked: command.checked?.(),
      enabled: command.enabled?.(),
    }))).toEqual([
      { label: 'desktop', checked: true, enabled: true },
      { label: '工作 profile', checked: false, enabled: true },
      { label: 'headless (Unavailable for Desktop)', checked: false, enabled: false },
    ])

    await commands[1]?.invoke()
    expect(events).toEqual(['select:工作 profile', 'restart'])
    disposeEffect?.()
    expect(disposeRegistration).toHaveBeenCalledOnce()
  })
})
