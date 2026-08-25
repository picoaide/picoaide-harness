import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import {
  handleDesktopUpdateCheckRequest,
  handleDesktopUpdateRequest,
} from '../src/desktop-update-route.ts'
import { emptyDesktopUpdateState } from '../src/desktop-update-contract.ts'

function request(method = 'GET', origin = 'http://127.0.0.1:43120'): IncomingMessage {
  return { method, headers: { origin } } as IncomingMessage
}

function response(): ServerResponse & {
  body: string
  end: ReturnType<typeof vi.fn>
  setHeader: ReturnType<typeof vi.fn>
} {
  const res = {
    body: '',
    statusCode: 200,
    setHeader: vi.fn(),
    end: vi.fn((body?: string) => { res.body = body ?? '' }),
  }
  return res as unknown as ServerResponse & typeof res
}

describe('desktop update badge route', () => {
  it('serves the current snapshot for an allowed same-origin GET', async () => {
    const res = response()
    await handleDesktopUpdateRequest(
      request('GET'),
      res,
      'http://127.0.0.1:43120',
      () => ({
        ...emptyDesktopUpdateState(),
        isPackaged: true,
        canDownload: true,
        currentVersion: '2.2.0',
        availableVersion: '2.3.0',
      }),
    )

    expect(res.statusCode).toBe(200)
    expect(res.setHeader).toHaveBeenCalledWith('content-type', 'application/json; charset=utf-8')
    expect(JSON.parse(res.body)).toMatchObject({
      isPackaged: true,
      canDownload: true,
      currentVersion: '2.2.0',
      availableVersion: '2.3.0',
    })
  })

  it('rejects cross-origin and non-GET state requests', async () => {
    const cross = response()
    await handleDesktopUpdateRequest(
      request('GET', 'https://evil.example'),
      cross,
      'http://127.0.0.1:43120',
      () => emptyDesktopUpdateState(),
    )
    expect(cross.statusCode).toBe(403)
    expect(cross.body).toContain('forbidden')

    const badMethod = response()
    await handleDesktopUpdateRequest(
      request('POST'),
      badMethod,
      'http://127.0.0.1:43120',
      () => emptyDesktopUpdateState(),
    )
    expect(badMethod.statusCode).toBe(405)
  })

  it('triggers the manual check for an allowed same-origin POST', async () => {
    const checkNow = vi.fn()
    const res = response()
    await handleDesktopUpdateCheckRequest(request('POST'), res, 'http://127.0.0.1:43120', checkNow)

    expect(checkNow).toHaveBeenCalledOnce()
    expect(res.statusCode).toBe(202)
    expect(JSON.parse(res.body)).toEqual({ accepted: true })
  })

  it('rejects cross-origin and non-POST check requests', async () => {
    const checkNow = vi.fn()
    const cross = response()
    await handleDesktopUpdateCheckRequest(
      request('POST', 'https://evil.example'),
      cross,
      'http://127.0.0.1:43120',
      checkNow,
    )
    expect(cross.statusCode).toBe(403)
    expect(checkNow).not.toHaveBeenCalled()

    const badMethod = response()
    await handleDesktopUpdateCheckRequest(
      request('GET'),
      badMethod,
      'http://127.0.0.1:43120',
      checkNow,
    )
    expect(badMethod.statusCode).toBe(405)
  })
})
