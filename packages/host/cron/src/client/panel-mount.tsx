/**
 * 「定时任务」中心面板的装载点。
 *
 * 面板本身的切换语义（中列整页接管、四个面板互斥、侧边栏点行让位、Esc 返回）
 * 全部由 `@picoaide/dsh-panel-surface` 提供 —— 本文件只剩两件事：把装载器接上，
 * 以及给触发按钮一个 `openCronPanel()`（它自己不读写 html 属性）。
 * 关闭由装载器负责（Esc / 面板返回按钮），故没有对称的 `closeCronPanel()`。
 *
 * 历史：这里原来有一整套自己实现的 DOM 接管（注入样式表 + `MutationObserver`
 * 等中列出现 + `data-dsh-cron-active`）。2026-09-20 收敛到共享装载器，因为
 * 能力中心/连接器/应用中心当时各自是模态浮层，同一个产品里出现了两种切换语义。
 *
 * @module @picoaide/dsh-cron/client/panel-mount
 */
import { createElement } from 'react'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { mountPanelSurface, type PanelSurfaceHandle } from '@picoaide/dsh-panel-surface/client'
import type { CronController } from './controller.ts'
import { CronJobTab } from './CronJobTab.tsx'

/** 本面板在共享协议里的 id（激活态属性取值 / 容器标记取值）。 */
export const CRON_PANEL_ID = 'cron'

/** 当前装载的句柄（每个插件实例只有一个，触发按钮通过它开面板）。 */
let surface: PanelSurfaceHandle | undefined

/** 打开定时任务中心（触发按钮调用）。 */
export function openCronPanel(): void {
  surface?.activate()
}

/**
 * 装载定时任务中心面板。
 * @param controller - 任务控制器（列表与动作的唯一数据源）。
 * @param workspaces - 可选的工作区服务（编辑器的项目选择器）。
 * @param api - 可选的连接句柄（编辑器的智能体清单）。
 * @param openSession - 可选的会话跳转（执行详情里的"打开会话"）。
 * @returns 卸载函数（移除容器、样式与监听）。
 */
export function mountCronPanel(
  controller: CronController,
  workspaces?: IWorkspaces,
  api?: ConnectionHandle['api'],
  openSession?: (sessionId: string) => void,
): () => void {
  const mounted = mountPanelSurface({
    id: CRON_PANEL_ID,
    render: ({ close }) => createElement(CronJobTab, {
      controller,
      page: { onClose: close },
      ...(workspaces === undefined ? {} : { workspaces }),
      ...(api === undefined ? {} : { api }),
      ...(openSession === undefined ? {} : { openSession }),
    }),
  })
  surface = mounted
  return () => {
    if (surface === mounted) surface = undefined
    mounted.dispose()
  }
}
