/**
 * 「能力中心」整页面板的装载点。
 *
 * 面板的切换语义（中列整页接管、与连接器/应用中心/定时任务互斥、点侧边栏行让位、
 * Esc 返回）全部由 `@picoaide/dsh-panel-surface` 提供；本文件只负责接上装载器，
 * 并给触发按钮一个 `openCapabilityCenter()`。
 *
 * 历史：这里原来是 `position:fixed` 的模态浮层（`OVERLAY`/`MASK`/`PANEL` +
 * Esc 关闭 + Tab 焦点陷阱）。2026-09-20 与连接器、应用中心一起改成中列整页 ——
 * 模态的焦点陷阱与"面板住在侧边栏槽位树里"这两件事都不再需要。
 *
 * @module @picoaide/dsh-enterprise/client/capability-surface
 */

import { createElement } from 'react'
import { mountPanelSurface, type PanelSurfaceHandle } from '@picoaide/dsh-panel-surface/client'
import { CapabilityCenterPanel } from './CapabilityCenterPanel.tsx'

/** 本面板在共享协议里的 id（激活态属性取值 / 容器标记取值）。 */
export const CAPABILITY_PANEL_ID = 'capability'

/** 当前装载的句柄（每个插件实例只有一个，触发按钮通过它开面板）。 */
let surface: PanelSurfaceHandle | undefined

/** 打开能力中心（侧边栏入口调用）。 */
export function openCapabilityCenter(): void {
  surface?.activate()
}

/** 关闭能力中心。 */
export function closeCapabilityCenter(): void {
  surface?.close()
}

/**
 * 装载能力中心面板（插件启动时一次）。
 * @returns 卸载函数（移除容器、样式与监听）。
 */
export function mountCapabilityCenter(): () => void {
  const mounted = mountPanelSurface({
    id: CAPABILITY_PANEL_ID,
    render: ({ close }) => createElement(CapabilityCenterPanel, { onClose: close }),
  })
  surface = mounted
  return () => {
    if (surface === mounted) surface = undefined
    mounted.dispose()
  }
}
