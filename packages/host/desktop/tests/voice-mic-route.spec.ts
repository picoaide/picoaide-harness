/**
 * 麦克风系统授权路由（`src/voice-mic-route.ts`）的判据。
 *
 * 为什么需要这条路由（现场 bug 的核心）：macOS 的 TCC **被拒之后系统不再弹窗**，
 * 那时 `enumerateDevices()` 里同样没有 `audioinput` —— 渲染层无法区分"没插麦克风"
 * 与"系统没允许"，用户会拿着"找不到设备"去查硬件。所以状态必须由宿主给出。
 *
 * 这里钉四件事：① 非 macOS 一律 `not-applicable`（没有"申请"这一步）；
 * ② macOS 的四种状态原样透出，且**只有 `not-determined` 允许显示"申请"按钮**
 * （已拒之后点了系统也不会弹，给按钮比不给更糟）；③ 读状态抛错不崩（回落 `unknown`）；
 * ④ POST 必须过写面证明（本机任意进程不得替用户弹系统对话框），且申请后**重新读**状态。
 */

import { describe, expect, it, vi } from 'vitest'
import type { WriteProofDeps } from '../src/write-proof.ts'
import {
  handleVoiceMicRequest,
  handleVoiceMicStatusRequest,
  readVoiceMicStatus,
  VOICE_MIC_REQUEST_PATH,
  VOICE_MIC_STATUS_PATH,
  type VoiceMicDeps,
} from '../src/voice-mic-route.ts'

/** 最小 res 替身：记下状态码与 JSON 正文。 */
function fakeRes(): { res: unknown, status: () => number, body: () => any } {
  let statusCode = 0
  let payload = ''
  const res = {
    setHeader: () => {},
    end: (value?: string) => { payload = value ?? '' },
    set statusCode(value: number) { statusCode = value },
    get statusCode() { return statusCode },
  }
  return { res, status: () => statusCode, body: () => JSON.parse(payload) as unknown }
}

/** 放行态写面证明（与既有路由用例同一接缝：围栏认为本请求带证明）。 */
const ALLOWING_PROOF: WriteProofDeps = { fence: () => ({ requestRejection: () => undefined }), label: 'test' }

describe('voice mic status route', () => {
  it('reports not-applicable off macOS (no per-app prompt exists)', () => {
    for (const platform of ['win32', 'linux']) {
      expect(readVoiceMicStatus({ platform })).toEqual({
        schema: 1, platform, permission: 'not-applicable', canRequest: false,
      })
    }
    expect(VOICE_MIC_STATUS_PATH).toBe('/api/pico/voice/mic')
    expect(VOICE_MIC_REQUEST_PATH).toBe('/api/pico/voice/mic/request')
  })

  it('passes the macOS TCC state through and only offers a request when undetermined', () => {
    const status = (raw: string): ReturnType<typeof readVoiceMicStatus> =>
      readVoiceMicStatus({ platform: 'darwin', getMediaAccessStatus: () => raw })
    expect(status('granted')).toEqual({ schema: 1, platform: 'darwin', permission: 'granted', canRequest: false })
    expect(status('denied')).toEqual({ schema: 1, platform: 'darwin', permission: 'denied', canRequest: false })
    expect(status('restricted').canRequest).toBe(false)
    // 只有"还没问过"才给按钮：已拒之后 askForMediaAccess 不再弹窗，按钮会是死的。
    expect(status('not-determined')).toEqual({ schema: 1, platform: 'darwin', permission: 'not-determined', canRequest: true })
    // 未知取值收窄成 unknown，不把 Electron 的未来取值漏给渲染层。
    expect(status('something-new').permission).toBe('unknown')
  })

  it('survives a throwing status read (renders as unknown, never crashes the route)', () => {
    const deps: VoiceMicDeps = {
      platform: 'darwin',
      getMediaAccessStatus: () => { throw new Error('tcc unavailable') },
    }
    expect(readVoiceMicStatus(deps).permission).toBe('unknown')
    const response = fakeRes()
    expect(() => handleVoiceMicStatusRequest({} as never, response.res as never, deps)).not.toThrow()
    expect(response.status()).toBe(200)
  })

  it('serves the read-only status as JSON', () => {
    const response = fakeRes()
    handleVoiceMicStatusRequest({} as never, response.res as never, {
      platform: 'darwin',
      getMediaAccessStatus: () => 'granted',
    })
    expect(response.status()).toBe(200)
    expect(response.body()).toMatchObject({ platform: 'darwin', permission: 'granted' })
  })

  it('requires a write proof before it can raise the system dialog', async () => {
    const askForMediaAccess = vi.fn(async () => undefined)
    // 证明不过（围栏拒绝）：`acceptWriteProof` 自己写 403/503 并返回 false ⇒ 不得弹窗。
    const denied: VoiceMicDeps & WriteProofDeps = {
      platform: 'darwin',
      getMediaAccessStatus: () => 'not-determined',
      askForMediaAccess,
      fence: () => ({ requestRejection: () => 403 }),
      label: 'test',
    }
    const rejected = fakeRes()
    await handleVoiceMicRequest({ method: 'POST', headers: {} } as never, rejected.res as never, denied)
    expect(askForMediaAccess).not.toHaveBeenCalled()
    expect(rejected.status()).toBe(403)
  })

  it('rejects non-POST with 405 (and does not touch the system dialog)', async () => {
    const askForMediaAccess = vi.fn(async () => undefined)
    const deps: VoiceMicDeps & WriteProofDeps = {
      platform: 'darwin',
      getMediaAccessStatus: () => 'not-determined',
      askForMediaAccess,
      ...ALLOWING_PROOF,
    }
    const response = fakeRes()
    await handleVoiceMicRequest({ method: 'GET', headers: {} } as never, response.res as never, deps)
    expect(response.status()).toBe(405)
    expect(askForMediaAccess).not.toHaveBeenCalled()
  })

  it('raises the dialog then returns the re-read state, and survives a dialog failure', async () => {
    let permission = 'not-determined'
    const deps: VoiceMicDeps & WriteProofDeps = {
      platform: 'darwin',
      getMediaAccessStatus: () => permission,
      askForMediaAccess: async () => { permission = 'granted' },
      ...ALLOWING_PROOF,
    }
    const granted = fakeRes()
    await handleVoiceMicRequest({ method: 'POST', headers: {} } as never, granted.res as never, deps)
    expect(granted.status()).toBe(200)
    expect(granted.body()).toMatchObject({ permission: 'granted', canRequest: false })

    // 弹窗失败（已拒之后系统不再弹）不是 5xx：状态照读，界面显示"去系统设置"。
    const warn = vi.fn()
    const failing: VoiceMicDeps & WriteProofDeps = {
      platform: 'darwin',
      getMediaAccessStatus: () => 'denied',
      askForMediaAccess: async () => { throw new Error('no prompt possible') },
      fence: ALLOWING_PROOF.fence,
      label: 'test',
      warn,
    }
    const failed = fakeRes()
    await handleVoiceMicRequest({ method: 'POST', headers: {} } as never, failed.res as never, failing)
    expect(failed.status()).toBe(200)
    expect(failed.body()).toMatchObject({ permission: 'denied', canRequest: false })
    expect(warn).toHaveBeenCalled()
  })
})
