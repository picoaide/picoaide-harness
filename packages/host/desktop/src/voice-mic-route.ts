/**
 * 麦克风**系统授权状态**的本机只读路由 + 申请入口（2026-09-30 现场反馈）。
 *
 * 为什么需要它：macOS 把麦克风归 TCC 管，**被拒之后系统不再弹窗** —— 此时
 * `enumerateDevices()` 里连 `audioinput` 都没有，`getUserMedia` 报的是
 * `NotFoundError: Requested device not found`（"没找到设备"），用户会去查硬件，
 * 而真正的原因在「系统设置 → 隐私与安全性 → 麦克风」里（或者是根本没点过允许）。
 * 只靠渲染层无法区分这两种情形（设备列表同样为空），所以状态必须由**宿主**给出：
 *
 *   · `GET  /api/pico/voice/mic`          —— 只读：平台 + TCC 状态（渲染层据此决定文案与按钮）
 *   · `POST /api/pico/voice/mic/request`  —— 触发系统授权（macOS `askForMediaAccess`；
 *                                            其它平台没有"申请"这一步，直接回当前状态）
 *
 * 安全口径：GET 不改变任何状态（只报一枚枚举值），与既有只读本机路由同规格；
 * POST 会弹系统对话框 ⇒ 走 `acceptWriteProof`（本机任意进程不得替用户弹窗）。
 * 两者都**不返回**设备名、账号、路径等任何可识别信息。
 *
 * @module dsh-plugin-desktop/voice-mic-route
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { acceptWriteProof, type WriteProofDeps } from './write-proof.ts'

/** 只读状态路由（渲染层轮询/读取）。 */
export const VOICE_MIC_STATUS_PATH = '/api/pico/voice/mic'
/** 申请系统授权（macOS 弹 TCC 对话框；其它平台为无副作用的读回）。 */
export const VOICE_MIC_REQUEST_PATH = '/api/pico/voice/mic/request'

/** macOS TCC 对麦克风的四种取值 + 非 macOS 的"不适用"。 */
export type VoiceMicPermission =
  | 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown' | 'not-applicable'

/** 状态载荷（渲染层只读它）。 */
export interface VoiceMicStatus {
  /** 载荷版本（渲染层据此判断字段是否存在）。 */
  readonly schema: 1
  /** 宿主平台（`darwin` 才有 TCC 这一步）。 */
  readonly platform: string
  /** 系统层面的麦克风授权状态。 */
  readonly permission: VoiceMicPermission
  /**
   * 是否还能由本应用发起系统授权询问。
   *
   * macOS 的语义：`not-determined` 才会弹窗；`denied`/`restricted` 之后
   * `askForMediaAccess` **不再弹**（必须用户自己去系统设置里改）⇒ 此时渲染层应当显示
   * "去系统设置里打开"，而不是给一个点了没反应的按钮。
   */
  readonly canRequest: boolean
}

/** 状态/申请的宿主依赖（测试注入；生产用 Electron 的 `systemPreferences`）。 */
export interface VoiceMicDeps {
  /** `process.platform`。 */
  readonly platform: string
  /** macOS：`systemPreferences.getMediaAccessStatus('microphone')`。 */
  readonly getMediaAccessStatus?: () => string
  /** macOS：`systemPreferences.askForMediaAccess('microphone')`（返回值不用：状态要重新读）。 */
  readonly askForMediaAccess?: () => Promise<unknown>
}

function finishJson(res: ServerResponse, statusCode: number, value: object): void {
  res.statusCode = statusCode
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(value))
}

/** 把 Electron 的字符串状态收窄到本路由的闭集（未知取值一律 `unknown`）。 */
function toPermission(raw: unknown): VoiceMicPermission {
  switch (raw) {
    case 'granted': case 'denied': case 'restricted': case 'not-determined': return raw
    case undefined: case null: return 'unknown'
    default: return 'unknown'
  }
}

/**
 * 读当前状态。
 *
 * 非 macOS 一律 `not-applicable`：Windows/Linux 没有"应用级授权询问"这一步
 * （Windows 的麦克风隐私开关在系统设置里，Chromium 只会拿到设备可用/不可用），
 * 渲染层据此不显示"申请授权"按钮。
 * @param deps - 宿主依赖（可注入）。
 * @returns 状态载荷。
 */
export function readVoiceMicStatus(deps: VoiceMicDeps): VoiceMicStatus {
  if (deps.platform !== 'darwin') {
    return { schema: 1, platform: deps.platform, permission: 'not-applicable', canRequest: false }
  }
  let raw: unknown
  try {
    raw = deps.getMediaAccessStatus?.()
  } catch {
    // 读状态失败不是终态：按"能申请"处理，让渲染层给用户一条出路（点一下会走真流程）。
    raw = undefined
  }
  const permission = toPermission(raw)
  return { schema: 1, platform: deps.platform, permission, canRequest: permission === 'not-determined' }
}

/**
 * 处理只读状态请求。
 * @param _req - 未使用（GET 无副作用，参数保留与既有路由同形）。
 * @param res - HTTP 响应。
 * @param deps - 宿主依赖。
 */
export function handleVoiceMicStatusRequest(_req: IncomingMessage, res: ServerResponse, deps: VoiceMicDeps): void {
  finishJson(res, 200, readVoiceMicStatus(deps))
}

/**
 * 处理"申请系统授权"。
 *
 * macOS 上先过写面证明（本机任意进程不得替用户弹窗），再 `askForMediaAccess`：
 * `not-determined` 时系统弹窗并返回用户的选择；`denied`/`restricted` 时系统**不弹**、
 * 直接返回 false。返回的永远是**申请之后**重新读到的状态（渲染层据此刷新文案）。
 * @param req - HTTP 请求（方法 + headers 进证明闸）。
 * @param res - HTTP 响应。
 * @param deps - 宿主依赖（含写面证明的围栏/标签/告警）。
 */
export async function handleVoiceMicRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: VoiceMicDeps & WriteProofDeps,
): Promise<void> {
  if (req.method !== 'POST') {
    finishJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'use POST' } })
    return
  }
  if (!await acceptWriteProof(req, res, deps)) return
  if (deps.platform === 'darwin' && deps.askForMediaAccess !== undefined) {
    try {
      await deps.askForMediaAccess()
    } catch (cause) {
      // 弹窗失败（TCC 不可用/被系统拒）不是崩溃点：状态会被重新读一遍，渲染层照常显示。
      deps.warn?.(`voice mic permission request failed: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }
  finishJson(res, 200, readVoiceMicStatus(deps))
}
