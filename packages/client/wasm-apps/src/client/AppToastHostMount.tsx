/**
 * 侧边栏底部的 `AppToastHost` **常驻挂载点**（挂载点，不是入口行）。
 *
 * 为什么还需要一个 `sidebar.footer.action` 占用者：异渠道深链的一次性 toast（§5.3）
 * 是**主窗口级**提示 —— 用户可能在收到链接时根本没打开应用中心，所以宿主必须一直
 * 挂在那儿。它以前挂在 `AppCenterTrigger` 里（顺手搭了导航按钮的车），2026-09-21
 * 底部并道之后导航行搬进了「更多」浮层（`@picoaide/dsh-foot-menu` 的
 * `picoFootMenu` 条目），本组件就只留下这一件事。
 *
 * 它**不渲染任何按钮、文字或布局**：`AppToastHost` 无 toast 时返回 `null`，有 toast
 * 时是 `position:fixed`。因此这个占用者在底部功能区不占高度、不改观感 —— 它不是
 * 一行导航，别把它当成入口。
 *
 * @module @picoaide/dsh-wasm-apps/client/AppToastHostMount
 */

import { AppToastHost } from './app-toast.tsx'

/**
 * 常驻渲染 toast 宿主。
 * @returns toast 宿主（无 toast 时为 `null`）。
 */
export function AppToastHostMount(): JSX.Element {
  return <AppToastHost />
}
