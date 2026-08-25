import { describe, expect, it, vi } from 'vitest'
import {
  fetchDesktopUpdateState,
  triggerDesktopUpdateCheck,
} from '../src/client/desktop-update.tsx'

describe('desktop update badge client', () => {
  it('parses a valid snapshot and rejects malformed bodies', async () => {
    const request = vi.fn(async () => Response.json({
      isPackaged: true,
      canDownload: true,
      currentVersion: '2.2.0',
      availableVersion: '2.3.0',
      downloadingVersion: undefined,
    }))
    const state = await fetchDesktopUpdateState(request)
    expect(state).toMatchObject({
      isPackaged: true,
      canDownload: true,
      currentVersion: '2.2.0',
      availableVersion: '2.3.0',
    })

    const invalid = vi.fn(async () => Response.json({ nope: true }))
    await expect(fetchDesktopUpdateState(invalid)).resolves.toBeNull()

    const failing = vi.fn(async () => { throw new Error('offline') })
    await expect(fetchDesktopUpdateState(failing)).resolves.toBeNull()
  })

  it('returns null on non-200 responses', async () => {
    const request = vi.fn(async () => new Response('', { status: 500 }))
    await expect(fetchDesktopUpdateState(request)).resolves.toBeNull()
  })

  it('triggers the Host check with the fixed POST endpoint', async () => {
    const request = vi.fn(async () => new Response('', { status: 202 }))
    await expect(triggerDesktopUpdateCheck(request)).resolves.toBe(true)
    expect(request).toHaveBeenCalledWith(
      '/api/pico/desktop/update/check',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('reports a failed trigger without throwing', async () => {
    const request = vi.fn(async () => new Response('', { status: 500 }))
    await expect(triggerDesktopUpdateCheck(request)).resolves.toBe(false)
  })
})
