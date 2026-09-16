/**
 * macOS 标题栏双击的客户端↔宿主契约（2026-09-16）。
 *
 * ## 为什么需要这条通道
 *
 * macOS 的约定是"双击标题栏 ⇒ 按系统设置缩放/最小化窗口"（系统设置 → 桌面与程序坞
 * → "双击窗口的标题栏以"）。标题栏是我们自绘的：窗口用 `titleBarStyle: 'hiddenInset'`，
 * 拖拽区靠 CSS `-webkit-app-region: drag` 标出来。
 *
 * Electron **不会**为这种自定义拖拽区补上原生双击行为（electron#16385：维护者明确
 * 说明这是应用自己的事，官方只给出 `AppleActionOnDoubleClick` 这套写法）。所以点在我们
 * 的拖拽条上双击什么也不会发生 —— 用户报的"左边无法双击扩大或缩小窗口"就是这个。
 *
 * 通道形状与其它 desktop 写面一致（`desktop-update-contract.ts` /
 * `directory-picker-contract.ts`）：客户端 `POST` 本机回环路由，宿主侧校验
 * Origin + BrowserAuth 持有性证明后执行。
 *
 * @module dsh-plugin-desktop/desktop-window-contract
 */

/** 客户端请求宿主执行一次"标题栏双击"动作（macOS 语义）。 */
export const DESKTOP_TITLEBAR_DOUBLE_CLICK_PATH = '/api/pico/desktop/window/titlebar-double-click'
