/**
 * 中列整页面板的**装载器**。
 *
 * ## 用法（插件的 client `apply` 里一次）
 *
 * ```ts
 * const surface = mountPanelSurface({ id: 'capability', render: ({ close }) => <CapabilityCenterPanel onClose={close} /> })
 * // 侧边栏触发按钮：
 * surface.activate()
 * // 插件卸载：
 * ctx.effect(() => () => surface.dispose())
 * ```
 *
 * ## 为什么是"插件启动时挂一次"而不是"按钮点开时挂"
 *
 * 触发按钮住在侧边栏的槽位树里，而窄轨/宽栏切换会让那棵树重新挂载 —— 把面板的
 * 生命周期绑在按钮上，等于"侧边栏一重排，打开着的面板就没了"。所以：**容器常驻**
 * （挂在 React 管不到的中列 DOM 上），React 子树按需挂载/卸载 —— 关闭时把树渲染成
 * `null`（而不是销毁 root、下次重建）：既保证"每次打开都重新取数"（与旧模态语义
 * 一致），又不会在同一个容器上反复 `createRoot` / `unmount`（那正是 React 会警告
 * "container already has a root" 的用法）。
 *
 * @module @picoaide/dsh-panel-surface/client/surface
 */

import { createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  PANEL_ACTIVATE_EVENT,
  PANEL_ACTIVE_ATTR,
  PANEL_SURFACE_ATTR,
  activePanelId,
  findCenterColumn,
  isSidebarRowTarget,
} from '../index.ts'
import { PANEL_STYLE_ATTR, panelStylesheet } from './stylesheet.ts'

/** 面板拿到的操作面（目前只有"返回会话区"）。 */
export interface PanelSurfaceApi {
  /** 关闭本面板、把中列还给会话区。 */
  close: () => void
}

export interface PanelSurfaceOptions {
  /** 面板 id（唯一；同时是激活态属性的取值与容器标记的取值）。 */
  id: string
  /** 渲染面板内容；`close` 由装载器提供。 */
  render: (api: PanelSurfaceApi) => ReactNode
  /** 可见性变化回调（面板可用它暂停后台轮询）。 */
  onVisibilityChange?: (active: boolean) => void
}

export interface PanelSurfaceHandle {
  /** 打开本面板（同时把其它面板挤下去）。 */
  activate: () => void
  /** 关闭本面板（不是本面板打开时是无害的 no-op）。 */
  close: () => void
  /** 本面板当前是否打开。 */
  isActive: () => boolean
  /** 卸载：移除容器、样式、监听，并关闭面板。 */
  dispose: () => void
}

/**
 * 挂载一个中列整页面板。
 * @param options - 面板 id、渲染函数与可见性回调。
 * @returns 激活 / 关闭 / 查询 / 卸载的操作面。
 */
export function mountPanelSurface(options: PanelSurfaceOptions): PanelSurfaceHandle {
  const { id, render, onVisibilityChange } = options

  // 没有 DOM 的环境（node 单测里直接跑插件 `apply`、SSR 预渲染）里**不装载**：
  // 这里若直接 `document.createElement` 会抛 `ReferenceError: document is not defined`，
  // 而调用方（插件的 client `apply`）没有任何理由在非浏览器环境里失败 —— 它要
  // 注册的槽位/字典都还在。返回一个全 no-op 的句柄，语义与"面板还没挂上"一致。
  if (typeof document === 'undefined') {
    return {
      activate: () => undefined,
      close: () => undefined,
      isActive: () => false,
      dispose: () => undefined,
    }
  }

  const style = document.createElement('style')
  style.setAttribute(PANEL_STYLE_ATTR, id)
  style.textContent = panelStylesheet(id)
  document.head.appendChild(style)

  let container: HTMLDivElement | undefined
  let root: Root | undefined

  function ensureContainer(): HTMLDivElement | undefined {
    if (container !== undefined) return container
    const column = findCenterColumn(document)
    if (column === null) return undefined
    const element = document.createElement('div')
    element.setAttribute(PANEL_SURFACE_ATTR, id)
    element.dataset.dshPlugin = id
    element.tabIndex = -1
    // 不写行内 display：可见性由注入的样式表按 html 激活属性驱动
    //（行内 display:none 的优先级会让"显示"规则永远失效）。
    column.appendChild(element)
    container = element
    return element
  }

  /** 把当前状态同步进 React 树：打开 ⇒ 渲染面板，关闭 ⇒ 渲染 null（卸载子树、保留 root）。 */
  function sync(): void {
    const element = ensureContainer()
    if (element === undefined) return
    if (root === undefined) root = createRoot(element)
    root.render(activePanelId(document) === id ? createElement(PanelContent, { render, close }) : null)
  }

  /** 中列在启动早期还不存在 —— 观察等待它出现（框架挂载晚于插件 apply）。 */
  const observer = new MutationObserver(() => { sync() })
  observer.observe(document.body, { childList: true, subtree: true })
  sync()

  function close(): void {
    if (activePanelId(document) !== id) return
    document.documentElement.removeAttribute(PANEL_ACTIVE_ATTR)
    sync()
    onVisibilityChange?.(false)
  }

  function activate(): void {
    if (activePanelId(document) === id) return
    if (ensureContainer() === undefined) return
    document.documentElement.setAttribute(PANEL_ACTIVE_ATTR, id)
    document.dispatchEvent(new CustomEvent(PANEL_ACTIVATE_EVENT, { detail: id }))
    sync()
    onVisibilityChange?.(true)
    container?.focus({ preventScroll: true })
  }

  const onOtherActivate = (event: Event): void => {
    if ((event as CustomEvent).detail !== id) close()
  }
  const onClickSidebarRow = (event: MouseEvent): void => {
    if (activePanelId(document) !== id) return
    if (isSidebarRowTarget(event.target as Element | null)) close()
  }
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || activePanelId(document) !== id) return
    // 面板里可能再开一层真正的模态（确认框/表单）：那时 Esc 归那一层。
    if (document.querySelector('[role="dialog"][aria-modal="true"]') !== null) return
    event.preventDefault()
    close()
  }

  document.addEventListener(PANEL_ACTIVATE_EVENT, onOtherActivate)
  document.addEventListener('click', onClickSidebarRow, true)
  document.addEventListener('keydown', onKeyDown)

  return {
    activate,
    close,
    isActive: () => activePanelId(document) === id,
    dispose: () => {
      document.removeEventListener(PANEL_ACTIVATE_EVENT, onOtherActivate)
      document.removeEventListener('click', onClickSidebarRow, true)
      document.removeEventListener('keydown', onKeyDown)
      observer.disconnect()
      const current = activePanelId(document)
      if (current === id) {
        document.documentElement.removeAttribute(PANEL_ACTIVE_ATTR)
        onVisibilityChange?.(false)
      }
      if (root !== undefined) {
        root.unmount()
        root = undefined
      }
      container?.remove()
      container = undefined
      style.remove()
    },
  }
}

/**
 * 面板 React 子树的根：只负责把 `close` 注进渲染函数。
 *
 * 抽成组件而不是直接 `render(...)`，是为了让面板在 **render 期**就能拿到稳定的
 * `close` 引用（内联对象每次渲染都是新引用，会被当成依赖变化的来源）。
 */
function PanelContent({ render, close }: { render: (api: PanelSurfaceApi) => ReactNode; close: () => void }): ReactNode {
  return render({ close })
}
