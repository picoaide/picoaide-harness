/**
 * 麦克风**设备预检**：把"本机没有可用的输入设备"这件事变成一句能看懂的中文。
 *
 * 背景（2026-09-30 实测）：上游语音组件在 `getUserMedia` 失败时只对 `NotAllowedError`
 * 做分类，其它 `DOMException` **原样透出 message** —— 于是设备不存在时用户看到的是
 * 上游文案 + Chromium 的英文尾巴：
 *
 * ```
 * 语音识别失败：Requested device not found
 * ```
 *
 * 这句话在客户现场会指向三个完全不同的排查方向（没插/没选输入设备、虚拟机与远程桌面
 * 没开音频重定向、被别的程序独占），而产品侧一个字都没说。桌面插件因此在这里补一层
 * **纯预检**：请求音频（且不请求视频）时先看一眼 `enumerateDevices()`，没有 `audioinput`
 * 就抛一个**同样类型**（`NotFoundError`）但**文案可执行**的异常 —— 语义不变（仍是"设备
 * 找不到"），只是把不可读的英文换成"该做什么"。
 *
 * **为什么要问宿主**（2026-09-30 现场）：macOS 的 TCC **被拒之后不再弹窗**，此时
 * `enumerateDevices()` 里同样没有 `audioinput` —— 只靠渲染层无法把"没插麦克风"与
 * "系统没允许"分开，用户会拿着"找不到设备"去查硬件。宿主侧的
 * `GET /api/pico/voice/mic` 给出真实授权状态，于是文案能分开：
 *   · `denied` / `restricted` ⇒ 告诉用户去「系统设置 → 隐私与安全性 → 麦克风」打开；
 *   · `not-determined` ⇒ **不拦**：让原请求走过去，宿主会触发系统弹窗（用户此刻就该看到它）；
 *   · 其它（含非 macOS）⇒ "未检测到麦克风设备"（真的没有设备）。
 *
 * 边界（刻意的）：
 *   · 只在**音频且不含视频**的请求上生效；其余请求一律原样交给原实现；
 *   · `enumerateDevices` 不可用、或它自己抛错 ⇒ **不拦**（回落原本的错误，绝不因为
 *     预检本身坏掉而改变行为）；
 *   · 状态查询失败 ⇒ 按"没有设备"的既有文案（不因为查询坏掉而放行或换错话术）；
 *   · 设备列表里只要有一个 `audioinput` 就放行 —— 设备能否真正打开仍由 Chromium 判断；
 *   · 包装与还原都在 `ctx.effect` 里（插件卸载即恢复原实现，不污染页面）。
 *
 * @module dsh-plugin-desktop/voice-device-guard
 */

/** 本模块用到的那一小面 `navigator.mediaDevices`（结构类型，便于测试替身）。 */
export interface VoiceMediaDevicesLike {
  getUserMedia?: (constraints?: unknown) => Promise<unknown>
  enumerateDevices?: () => Promise<readonly { readonly kind?: string }[]>
}

/** 预检要用的最小环境面。 */
export interface VoiceDeviceTarget {
  /** 缺省 `navigator.mediaDevices`。 */
  readonly mediaDevices?: VoiceMediaDevicesLike | undefined
}

/** 宿主给出的麦克风授权状态（`GET /api/pico/voice/mic` 的载荷子集）。 */
export interface VoiceMicStatusView {
  /** 系统层面的授权状态；非 macOS 是 `not-applicable`。 */
  readonly permission?: string
}

/** 预检需要的文案（在**抛出那一刻**求值，语言切换即时生效）。 */
export interface VoiceDeviceCopy {
  /** 有权限但一个录音设备都没有。 */
  readonly noDevice: () => string
  /** 系统层面没有授权（macOS 已拒/受限，系统不再弹窗）。 */
  readonly denied: () => string
}

/** 判断约束是不是"只要音频"（含 `audio: true`/对象，且没有 `video`）。 */
function wantsAudioOnly(constraints: unknown): boolean {
  if (typeof constraints !== 'object' || constraints === null) return false
  const record = constraints as { audio?: unknown, video?: unknown }
  if (record.video !== undefined && record.video !== false) return false
  return record.audio !== undefined && record.audio !== false
}

/**
 * 安装设备预检（幂等：同一份 `mediaDevices` 只包一层）。
 * @param target - 环境面（缺省取 `navigator.mediaDevices`）。
 * @param message - 缺设备时抛出的文案（**在抛出那一刻求值**，让语言切换立刻生效）。
 * @returns 还原原实现的 disposer。
 */
export function installVoiceDevicePreflight(
  target: VoiceDeviceTarget = { mediaDevices: (globalThis.navigator as { mediaDevices?: VoiceMediaDevicesLike } | undefined)?.mediaDevices },
  copy: VoiceDeviceCopy,
  readStatus?: () => Promise<VoiceMicStatusView | undefined>,
): () => void {
  const devices = target.mediaDevices
  const original = devices?.getUserMedia
  const enumerate = devices?.enumerateDevices
  if (devices === undefined || original === undefined || enumerate === undefined) return () => {}
  if ((original as { __dshVoicePreflight?: boolean }).__dshVoicePreflight === true) return () => {}
  const wrapped = async function preflight(constraints?: unknown): Promise<unknown> {
    if (wantsAudioOnly(constraints)) {
      let inputs: readonly { readonly kind?: string }[] | undefined
      try {
        inputs = await enumerate.call(devices)
      } catch {
        // 预检自己失败 ⇒ 不拦：让原实现抛出它原本的错误（行为与没装这层时一致）。
        inputs = undefined
      }
      if (inputs !== undefined && !inputs.some(device => device?.kind === 'audioinput')) {
        let permission: string | undefined
        if (readStatus !== undefined) {
          try {
            permission = (await readStatus())?.permission
          } catch {
            // 查状态失败 ⇒ 回落"没有设备"的既有文案（不因为查询坏掉而换错话术）。
            permission = undefined
          }
        }
        // `not-determined`：**不拦** —— 宿主会在真实请求里触发系统弹窗，用户此刻就该看到它。
        if (permission !== 'not-determined') {
          const denied = permission === 'denied' || permission === 'restricted'
          throw new DOMException(denied ? copy.denied() : copy.noDevice(), 'NotFoundError')
        }
      }
    }
    return await original.call(devices, constraints)
  }
  Object.defineProperty(wrapped, '__dshVoicePreflight', { value: true })
  devices.getUserMedia = wrapped
  return () => {
    if (devices.getUserMedia === wrapped) devices.getUserMedia = original
  }
}
