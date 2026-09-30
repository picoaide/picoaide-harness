/**
 * 麦克风设备预检（`src/client/voice-device-guard.ts`）的判据。
 *
 * 现场来源（2026-09-30）：用户报「语音识别失败：Requested device not found」——
 * 那是上游原样透出的 Chromium 英文尾巴。本模块只做一件事：**设备不存在时换成
 * 本地化、可执行的文案，且仍然是 `NotFoundError`**（语义不变）。所以这里的判据分两组：
 *
 *   1. **该拦的拦**：只要音频、设备列表里没有 `audioinput` ⇒ 抛 `NotFoundError` 且文案
 *      来自我们的字典；
 *   2. **不该拦的一律不拦**：有设备（哪怕只有一个）、请求里带视频、`enumerateDevices`
 *      不可用或自己抛错、约束不是对象 —— 全部原样交给原实现（预检坏掉不得改变行为）。
 *
 * 另外两条工程判据：包装可还原（插件卸载后页面恢复原实现）、包装幂等（重复安装只包一层）。
 */

import { describe, expect, it, vi } from 'vitest'
import { installVoiceDevicePreflight, type VoiceMediaDevicesLike } from '../src/client/voice-device-guard.ts'
import { zh } from '../src/client/locales.ts'

/** 造一个 `mediaDevices` 替身（`getUserMedia` 返回一个可辨识的假流）。 */
function devices(options: {
  readonly inputs?: number
  readonly enumerateFails?: boolean
  readonly noEnumerate?: boolean
  readonly onCall?: (constraints: unknown) => void
} = {}): VoiceMediaDevicesLike & { calls: unknown[] } {
  const calls: unknown[] = []
  const list = Array.from({ length: options.inputs ?? 0 }, (_, index) => ({ kind: 'audioinput', label: `mic-${String(index)}` }))
  const target: VoiceMediaDevicesLike & { calls: unknown[] } = {
    calls,
    getUserMedia: async (constraints?: unknown) => {
      calls.push(constraints)
      options.onCall?.(constraints)
      return { kind: 'fake-stream' }
    },
  }
  if (options.noEnumerate !== true) {
    target.enumerateDevices = async () => {
      if (options.enumerateFails === true) throw new Error('enumerate failed')
      return [...list, { kind: 'videoinput' }]
    }
  }
  return target
}

/** 预检要的两句文案（与生产同源：都来自字典，抛出那一刻求值）。 */
const copy = (): { noDevice: () => string, denied: () => string } => ({
  noDevice: () => zh['voice.noDevice'],
  denied: () => zh['voice.micDenied'],
})

describe('voice device preflight', () => {
  it('throws a localized NotFoundError when no audio input exists', async () => {
    const target = devices({ inputs: 0 })
    installVoiceDevicePreflight({ mediaDevices: target }, copy())
    await expect(target.getUserMedia!({ audio: true, video: false })).rejects.toMatchObject({
      name: 'NotFoundError',
      message: zh['voice.noDevice'],
    })
    // 文案可执行（不是上游那句英文尾巴）：系统设置 + 虚拟机/远程桌面的重定向。
    expect(zh['voice.noDevice']).toContain('麦克风')
    expect(zh['voice.noDevice']).toContain('远程桌面')
  })

  it('passes through when at least one audio input exists', async () => {
    const target = devices({ inputs: 1 })
    installVoiceDevicePreflight({ mediaDevices: target }, copy())
    await expect(target.getUserMedia!({ audio: { echoCancellation: true }, video: false })).resolves.toEqual({ kind: 'fake-stream' })
    expect(target.calls).toHaveLength(1)
  })

  it('never intercepts requests that include video or are not audio-only', async () => {
    const target = devices({ inputs: 0 })
    installVoiceDevicePreflight({ mediaDevices: target }, copy())
    await expect(target.getUserMedia!({ audio: true, video: true })).resolves.toEqual({ kind: 'fake-stream' })
    await expect(target.getUserMedia!({ video: true })).resolves.toEqual({ kind: 'fake-stream' })
    await expect(target.getUserMedia!(undefined)).resolves.toEqual({ kind: 'fake-stream' })
    await expect(target.getUserMedia!('audio')).resolves.toEqual({ kind: 'fake-stream' })
    expect(target.calls).toHaveLength(4)
  })

  it('falls through when the preflight itself cannot enumerate', async () => {
    const failing = devices({ inputs: 0, enumerateFails: true })
    installVoiceDevicePreflight({ mediaDevices: failing }, copy())
    await expect(failing.getUserMedia!({ audio: true })).resolves.toEqual({ kind: 'fake-stream' })
    const missing = devices({ inputs: 0, noEnumerate: true })
    installVoiceDevicePreflight({ mediaDevices: missing }, copy())
    await expect(missing.getUserMedia!({ audio: true })).resolves.toEqual({ kind: 'fake-stream' })
    // 没有 mediaDevices（非安全上下文）时安装是 no-op，不得抛。
    expect(() => installVoiceDevicePreflight({ mediaDevices: undefined }, copy())).not.toThrow()
  })

  it('evaluates the copy at throw time so a locale switch takes effect', async () => {
    const target = devices({ inputs: 0 })
    installVoiceDevicePreflight({ mediaDevices: target }, { noDevice: () => '切换后的文案', denied: () => '拒绝文案' })
    await expect(target.getUserMedia!({ audio: true })).rejects.toMatchObject({ message: '切换后的文案' })
  })

  it('tells "system denied" apart from "no device" (macOS TCC 被拒后设备列表同样为空)', async () => {
    // 这是现场那条 bug 的核心：两种情形在渲染层看起来一模一样（都没有 audioinput），
    // 只有宿主知道系统授权状态 —— 文案必须分开，否则用户拿着"找不到设备"去查硬件。
    const deniedTarget = devices({ inputs: 0 })
    installVoiceDevicePreflight({ mediaDevices: deniedTarget }, copy(), async () => ({ permission: 'denied' }))
    await expect(deniedTarget.getUserMedia!({ audio: true })).rejects.toMatchObject({
      name: 'NotFoundError',
      message: zh['voice.micDenied'],
    })
    const restricted = devices({ inputs: 0 })
    installVoiceDevicePreflight({ mediaDevices: restricted }, copy(), async () => ({ permission: 'restricted' }))
    await expect(restricted.getUserMedia!({ audio: true })).rejects.toMatchObject({ message: zh['voice.micDenied'] })

    // `not-determined`：**不拦** —— 宿主会在真实请求里触发系统弹窗（用户此刻就该看到它）。
    const undetermined = devices({ inputs: 0 })
    installVoiceDevicePreflight({ mediaDevices: undetermined }, copy(), async () => ({ permission: 'not-determined' }))
    await expect(undetermined.getUserMedia!({ audio: true })).resolves.toEqual({ kind: 'fake-stream' })

    // 非 macOS（`not-applicable`）与查不到状态：维持"没有设备"的文案。
    const plain = devices({ inputs: 0 })
    installVoiceDevicePreflight({ mediaDevices: plain }, copy(), async () => ({ permission: 'not-applicable' }))
    await expect(plain.getUserMedia!({ audio: true })).rejects.toMatchObject({ message: zh['voice.noDevice'] })
    const unknown = devices({ inputs: 0 })
    installVoiceDevicePreflight({ mediaDevices: unknown }, copy(), async () => undefined)
    await expect(unknown.getUserMedia!({ audio: true })).rejects.toMatchObject({ message: zh['voice.noDevice'] })
    // 查状态本身抛错也不得改变行为（回落"没有设备"）。
    const failing = devices({ inputs: 0 })
    installVoiceDevicePreflight({ mediaDevices: failing }, copy(), async () => { throw new Error('route down') })
    await expect(failing.getUserMedia!({ audio: true })).rejects.toMatchObject({ message: zh['voice.noDevice'] })
  })

  it('restores the original implementation and stays idempotent', async () => {
    const target = devices({ inputs: 1 })
    const original = target.getUserMedia
    const restore = installVoiceDevicePreflight({ mediaDevices: target }, copy())
    const wrapped = target.getUserMedia
    expect(wrapped).not.toBe(original)
    // 幂等：第二次安装不改变包装（避免叠加多层预检）。
    installVoiceDevicePreflight({ mediaDevices: target }, copy())
    expect(target.getUserMedia).toBe(wrapped)
    restore()
    expect(target.getUserMedia).toBe(original)
    // 卸载后再装一次仍然可用（disposer 不被状态污染）。
    installVoiceDevicePreflight({ mediaDevices: target }, copy())
    expect(target.getUserMedia).not.toBe(original)
  })

  it('keeps the preflight cheap: no enumeration for a non-audio request', async () => {
    const enumerate = vi.fn(async () => [{ kind: 'audioinput' }])
    const target: VoiceMediaDevicesLike = { getUserMedia: async () => ({}), enumerateDevices: enumerate }
    installVoiceDevicePreflight({ mediaDevices: target }, copy())
    await target.getUserMedia!({ video: true })
    expect(enumerate).not.toHaveBeenCalled()
  })
})
