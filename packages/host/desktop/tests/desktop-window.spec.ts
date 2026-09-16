/**
 * macOS 标题栏双击：renderer 命中判定 + 宿主路由 + 运行期动作（2026-09-16）。
 *
 * 事故：用户报"左边无法双击扩大或缩小窗口"。根因是自定义拖拽区（CSS
 * `-webkit-app-region: drag`）**不会**获得原生双击行为（electron#16385），
 * 应用必须自己判定命中并按系统偏好（`AppleActionOnDoubleClick`）执行缩放/最小化。
 * 这组用例钉住三件事：命中矩形与 CSS 的拖拽条一致、路由守卫不放松、偏好三态都照做。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import {
  isMacTitleBarDoubleClickTarget,
  requestTitleBarDoubleClick,
} from '../src/client/titlebar.ts'
import { DESKTOP_TITLEBAR_DOUBLE_CLICK_PATH } from '../src/desktop-window-contract.ts'
import { handleDesktopTitleBarDoubleClickRequest } from '../src/desktop-window-route.ts'
import type { WriteProofDeps } from '../src/write-proof.ts'
import { MACOS_DRAG_REGION_HEIGHT, MACOS_TRAFFIC_LIGHT_SAFE_WIDTH } from '../src/window-chrome.ts'

const ALLOWING_PROOF: WriteProofDeps = { fence: () => ({ requestRejection: () => undefined }), label: 'test' }
const DENYING_PROOF: WriteProofDeps = { fence: () => ({ requestRejection: () => 403 }), label: 'test' }

function request(origin = 'http://127.0.0.1:43120', method = 'POST'): IncomingMessage {
  return { method, headers: { origin } } as IncomingMessage
}

function response(): ServerResponse & { body: string, statusCode: number } {
  const res = {
    body: '',
    statusCode: 200,
    setHeader: vi.fn(),
    end: vi.fn((body?: string) => { res.body = body ?? '' }),
  }
  return res as unknown as ServerResponse & { body: string, statusCode: number }
}

describe('isMacTitleBarDoubleClickTarget（命中矩形必须与 CSS 拖拽条一致）', () => {
  const point = (clientX: number, clientY: number): { clientX: number, clientY: number } => ({ clientX, clientY })

  it('侧边栏顶部拖拽条（红绿灯右侧、拖拽高度以内）命中', () => {
    expect(isMacTitleBarDoubleClickTarget('darwin', point(MACOS_TRAFFIC_LIGHT_SAFE_WIDTH + 40, 10), false)).toBe(true)
    expect(isMacTitleBarDoubleClickTarget('darwin', point(600, MACOS_DRAG_REGION_HEIGHT), false)).toBe(true)
  })

  it('红绿灯安全区内 / 拖拽高度以外不命中（别把内容区的双击吞掉）', () => {
    expect(isMacTitleBarDoubleClickTarget('darwin', point(MACOS_TRAFFIC_LIGHT_SAFE_WIDTH - 1, 10), false)).toBe(false)
    expect(isMacTitleBarDoubleClickTarget('darwin', point(600, MACOS_DRAG_REGION_HEIGHT + 1), false)).toBe(false)
  })

  it('非 macOS 与模态打开时不命中', () => {
    expect(isMacTitleBarDoubleClickTarget('win32', point(600, 10), false)).toBe(false)
    expect(isMacTitleBarDoubleClickTarget('linux', point(600, 10), false)).toBe(false)
    // 有模态时 CSS 把拖拽区关掉（html:has([aria-modal="true"]) …），这里必须同步。
    expect(isMacTitleBarDoubleClickTarget('darwin', point(600, 10), true)).toBe(false)
  })
})

describe('requestTitleBarDoubleClick（renderer→宿主）', () => {
  it('向契约路径发同源 POST', async () => {
    const request = vi.fn(async () => ({ ok: true }))
    await requestTitleBarDoubleClick(request)
    expect(request).toHaveBeenCalledWith(DESKTOP_TITLEBAR_DOUBLE_CLICK_PATH, {
      method: 'POST',
      headers: { accept: 'application/json' },
    })
  })

  it('失败静默（窗口装饰动作不该弹错）', async () => {
    const request = vi.fn(async () => { throw new Error('offline') })
    await expect(requestTitleBarDoubleClick(request)).resolves.toBeUndefined()
  })
})

describe('titlebar double-click route', () => {
  it('放行时执行宿主动作并返回 202', async () => {
    const perform = vi.fn()
    const res = response()
    await handleDesktopTitleBarDoubleClickRequest(request(), res, 'http://127.0.0.1:43120', perform, ALLOWING_PROOF)
    expect(perform).toHaveBeenCalledOnce()
    expect(res.statusCode).toBe(202)
  })

  it('非 POST 405、跨源 403、证明不足不执行动作', async () => {
    const get = response()
    await handleDesktopTitleBarDoubleClickRequest(request('http://127.0.0.1:43120', 'GET'), get, 'http://127.0.0.1:43120', vi.fn(), ALLOWING_PROOF)
    expect(get.statusCode).toBe(405)

    const crossOrigin = response()
    await handleDesktopTitleBarDoubleClickRequest(request('http://evil.test'), crossOrigin, 'http://127.0.0.1:43120', vi.fn(), ALLOWING_PROOF)
    expect(crossOrigin.statusCode).toBe(403)

    const noProof = vi.fn()
    const denied = response()
    await handleDesktopTitleBarDoubleClickRequest(request(), denied, 'http://127.0.0.1:43120', noProof, DENYING_PROOF)
    expect(noProof).not.toHaveBeenCalled()
    expect(denied.statusCode).toBe(403)
  })
})
