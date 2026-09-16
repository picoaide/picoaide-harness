/**
 * macOS 标题栏双击的 renderer 侧：命中判定 + 通知宿主（2026-09-16）。
 *
 * 背景：窗口用 `titleBarStyle: 'hiddenInset'`，顶部的拖拽区是 CSS 伪元素上的
 * `-webkit-app-region: drag`（见 `styles.ts`）。Electron **不会**给这种自定义拖拽区
 * 补上原生双击行为（electron#16385：官方只给出 `AppleActionOnDoubleClick` 这套写法），
 * 所以用户双击顶部条什么也不会发生。这里判定"这一击是否落在拖拽条上"，命中就请宿主
 * 执行系统偏好对应的窗口动作（缩放/最小化/什么都不做）。
 *
 * 判定必须与 CSS 的两条 `::before` 精确对应，否则会出现"看着在拖拽条上却缩放不了"
 * 或"点在内容上却把窗口缩放了"：
 *   - `.dshDesktopSidebarSurface::before`：`left: MACOS_TRAFFIC_LIGHT_SAFE_WIDTH` 起，
 *     高 `MACOS_DRAG_REGION_HEIGHT`；
 *   - `.dshDesktopMacCaptionRow::before`：从侧边栏右缘起，同样高度（仍然满足
 *     `x >= MACOS_TRAFFIC_LIGHT_SAFE_WIDTH`）。
 * 有模态时这两条拖拽区被 CSS 关掉（`html:has([aria-modal="true"]) …`），这里同步关掉。
 *
 * @module dsh-plugin-desktop/client/titlebar
 */

import { MACOS_DRAG_REGION_HEIGHT, MACOS_TRAFFIC_LIGHT_SAFE_WIDTH } from '../window-chrome.ts'
import { DESKTOP_TITLEBAR_DOUBLE_CLICK_PATH } from '../desktop-window-contract.ts'

/**
 * 该点是否落在 macOS 拖拽条上（可双击缩放/最小化）。
 * @param platform - 当前客户端平台。
 * @param point - 视口坐标（`clientX` / `clientY`）。
 * @param modalOpen - 当前是否有模态（有模态时拖拽区按 CSS 失效）。
 * @returns 命中返回 true。
 */
export function isMacTitleBarDoubleClickTarget(
  platform: string,
  point: { clientX: number, clientY: number },
  modalOpen: boolean,
): boolean {
  if (platform !== 'darwin') return false
  if (modalOpen) return false
  if (point.clientY > MACOS_DRAG_REGION_HEIGHT) return false
  return point.clientX >= MACOS_TRAFFIC_LIGHT_SAFE_WIDTH
}

/** renderer 侧可注入的请求边界（测试用）。 */
export type TitleBarRequest = (path: string, init: { method: string, headers: Record<string, string> }) => Promise<unknown>

/** 缺省请求边界：同源 POST（BrowserAuth cookie 随请求自动带上，宿主侧据此验证明）。 */
const defaultRequest: TitleBarRequest = (path, init) => fetch(path, init)

/**
 * 请求宿主执行一次"标题栏双击"动作。
 *
 * 失败静默：这是窗口装饰层面的动作，出错不该弹任何东西（与更新徽标的写面同口径）。
 * @param request - 请求边界（测试注入口）。
 */
export async function requestTitleBarDoubleClick(request: TitleBarRequest = defaultRequest): Promise<void> {
  try {
    await request(DESKTOP_TITLEBAR_DOUBLE_CLICK_PATH, {
      method: 'POST',
      headers: { accept: 'application/json' },
    })
  } catch {
    // 静默：拿不到就算了。
  }
}
