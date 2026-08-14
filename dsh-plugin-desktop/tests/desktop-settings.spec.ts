import { describe, expect, it, vi } from 'vitest'
import { setDesktopMode } from '../src/client/desktop-settings.tsx'

describe('desktop settings client', () => {
  it('posts the exact mode object to the same-origin desktop endpoint', async () => {
    const request = vi.fn(async () => new Response(null, { status: 204 }))

    await expect(setDesktopMode('advanced', request)).resolves.toBe(true)
    expect(request).toHaveBeenCalledWith('/api/dsh-desktop/mode', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'advanced' }),
    })
  })

  it('keeps a non-204 response visible as a failure instead of claiming a relaunch', async () => {
    const request = vi.fn(async () => new Response(null, { status: 400 }))

    await expect(setDesktopMode('advanced', request)).resolves.toBe(false)
  })

  it('turns a transport rejection into the settings-page failure state', async () => {
    const request = vi.fn(async () => { throw new Error('connection closed') })

    await expect(setDesktopMode('advanced', request)).resolves.toBe(false)
  })
})
