/**
 * 「连接器中心」整页面板的装载点。
 *
 * 与能力中心 / 应用中心 / 定时任务共用 `@picoaide/dsh-panel-surface` 的切换语义
 * （中列整页接管、互斥、点侧边栏行让位、Esc 返回）。本文件只负责接上装载器。
 *
 * @module @picoaide/dsh-connectors/client/connector-surface
 */

import { createElement } from 'react'
import { mountPanelSurface, type PanelSurfaceHandle } from '@picoaide/dsh-panel-surface/client'
import { ConnectorPanel } from './ConnectorPanel.tsx'

/** 本面板在共享协议里的 id。 */
export const CONNECTOR_PANEL_ID = 'connectors'

let surface: PanelSurfaceHandle | undefined

/** 打开连接器中心（侧边栏入口调用）。 */
export function openConnectorCenter(): void {
  surface?.activate()
}

/**
 * 装载连接器中心面板（插件启动时一次）。
 * @returns 卸载函数（移除容器、样式与监听）。
 */
export function mountConnectorCenter(): () => void {
  const mounted = mountPanelSurface({
    id: CONNECTOR_PANEL_ID,
    render: ({ close }) => createElement(ConnectorPanel, { onClose: close }),
  })
  surface = mounted
  return () => {
    if (surface === mounted) surface = undefined
    mounted.dispose()
  }
}
