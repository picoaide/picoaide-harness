/**
 * 「应用中心」整页面板的装载点。
 *
 * 面板的切换语义（中列整页接管、与能力中心/连接器/定时任务互斥、点侧边栏行让位、
 * Esc 返回）全部由 `@picoaide/dsh-panel-surface` 提供；本文件只负责把装载器接上，
 * 并给触发按钮一个 `openAppCenterPanel()`。
 *
 * 历史：这里原来是 `position:fixed` 的模态浮层（`OVERLAY`/`MASK`/`PANEL`）。
 * 2026-09-20 与另外三个面板一起改成中列整页 —— 同一产品里两种切换语义是这次改造
 * 要解决的原始问题。
 *
 * @module @picoaide/dsh-wasm-apps/client/app-center-surface
 */

import { createElement } from 'react'
import { mountPanelSurface, type PanelSurfaceHandle } from '@picoaide/dsh-panel-surface/client'
import { AppCenterPanel } from './AppCenterPanel.tsx'

/** 本面板在共享协议里的 id（激活态属性取值 / 容器标记取值）。 */
export const APP_CENTER_PANEL_ID = 'apps'

/** 当前装载的句柄（每个插件实例只有一个，触发按钮通过它开面板）。 */
let surface: PanelSurfaceHandle | undefined

/** 打开应用中心（侧边栏入口调用）。 */
export function openAppCenterPanel(): void {
  surface?.activate()
}

/** 关闭应用中心。 */
export function closeAppCenterPanel(): void {
  surface?.close()
}

/** 面板依赖（全部可选；缺省值在 `AppCenterPanel` 内部回落）。 */
export type AppCenterPanelDeps = Omit<React.ComponentProps<typeof AppCenterPanel>, 'onClose'>

/**
 * 装载应用中心面板。
 * @param deps - 面板的可注入依赖（测试/真机探针用；生产留空）。
 * @returns 卸载函数（移除容器、样式与监听）。
 */
export function mountAppCenterPanel(deps: AppCenterPanelDeps = {}): () => void {
  const mounted = mountPanelSurface({
    id: APP_CENTER_PANEL_ID,
    render: ({ close }) => createElement(AppCenterPanel, { ...deps, onClose: close }),
  })
  surface = mounted
  return () => {
    if (surface === mounted) surface = undefined
    mounted.dispose()
  }
}
