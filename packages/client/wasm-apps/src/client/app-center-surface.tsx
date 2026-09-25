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
import { resumeOpenIntent } from './open-intent-resume.ts'

/** 本面板在共享协议里的 id（激活态属性取值 / 容器标记取值）。 */
export const APP_CENTER_PANEL_ID = 'apps'

/** 当前装载的句柄（每个插件实例只有一个，触发按钮通过它开面板）。 */
let surface: PanelSurfaceHandle | undefined

/** 打开应用中心（侧边栏入口调用）。 */
export function openAppCenterPanel(): void {
  surface?.activate()
}

/** 面板依赖（全部可选；缺省值在 `AppCenterPanel` 内部回落）。 */
export type AppCenterPanelDeps = Omit<React.ComponentProps<typeof AppCenterPanel>, 'onClose'>

/**
 * 装载应用中心面板。
 *
 * 装载时**额外做一件事**：兑现"未登录时记住这次打开"（§19 Q4 / §7.6）。装载点由
 * `index.ts` 的 `ctx.effect` 在**插件 apply 时**调用一次 ⇒ 每个文档加载都会跑到，
 * 这正是登录成功（整文档导航）之后那一跳 —— 面板此刻还没被激活、组件根本没渲染，
 * 只有站在这一跳上才谈得上"登录后自动继续"（R16B-03）。三条不变量与"唯一先行
 * 清理点"的约定见 `open-intent-resume.ts` 的模块头。
 *
 * @param deps - 面板的可注入依赖（测试/真机探针用；生产留空）。
 * @returns 卸载函数（移除容器、样式与监听）。
 */
export function mountAppCenterPanel(deps: AppCenterPanelDeps = {}): () => void {
  const mounted = mountPanelSurface({
    id: APP_CENTER_PANEL_ID,
    render: ({ close }) => createElement(AppCenterPanel, { ...deps, onClose: close }),
  })
  surface = mounted
  // 与面板同一份注入（存储 / 登录态 / 时钟）：探针与用例只描述一次环境，两条消费者
  // 看到的就是同一个世界。`resumeOpenIntent` 自己不抛，`void` 掉即可。
  void resumeOpenIntent({
    ...(deps.intentStore === undefined ? {} : { store: deps.intentStore }),
    ...(deps.loginStateLoader === undefined ? {} : { loginStateLoader: deps.loginStateLoader }),
    ...(deps.now === undefined ? {} : { now: deps.now }),
  })
  return () => {
    if (surface === mounted) surface = undefined
    mounted.dispose()
  }
}
