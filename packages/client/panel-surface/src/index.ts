/**
 * 面板表面（center column panel surface）的**协议层**：与框架无关的常量与纯 DOM 断言。
 *
 * ## 它解决什么
 *
 * 产品里有四个"整页级"功能面板：定时任务、能力中心、连接器、应用中心。它们都要
 * **接管中列**（会话区让位、面板占满），并且**互斥**（同一时刻只有一个）。此前
 * 定时任务自己实现了一套（html 属性 + DOM 注入），其余三个是 `position:fixed` 的
 * 模态浮层 —— 同一个产品里两种切换语义，用户看到的差别是"有的从中间弹出来、有的
 * 整页翻过去"。
 *
 * 现在四个面板共用**同一套协议**，都走本模块：
 *
 *  - **唯一激活态**：`<html data-dsh-panel-active="<id>">`。取值就是当前面板的 id，
 *    所以"谁开着"只有一个真源，不存在两个面板各自 set/remove 自己的属性而同时可见
 *    的窗口（旧实现里 cron 与 task board 就出现过这种竞态）。
 *  - **互斥广播**：`dsh-panel-activate` 事件（`detail` = 激活方的 id）。打开一个面板
 *    派发一次，其余面板据此关闭自己。
 *  - **容器标记**：`<div data-dsh-panel-surface="<id>">`，由装载器插进中列。
 *    可见性由注入的样式表按 `html[data-dsh-panel-active="<id>"]` 驱动（**不能**用
 *    行内 `display:none`：行内样式的优先级会让"显示"规则永远失效 —— 这是定时任务
 *    最早踩过的坑，见 `surface.tsx` 的样式注释）。
 *
 * 本模块**不 import React**，也不碰 `document`（选择器是字符串常量，DOM 查询函数
 * 接受注入的 `Document`），这样宿主侧也能安全地 import 它做断言。
 *
 * @module @picoaide/dsh-panel-surface
 */

/**
 * 中列容器的候选选择器。
 *
 * **必须逐个列出真实存在的中列实现**（2026-09-12 打包版真机复现过一次事故）：
 * `[data-pane="conversation"]` 在上游 rc1/rc2 全仓零命中（死选择器），
 * `[class*="centerCol"]` 只匹配上游 `ui-layout` 的 AppFrame —— 而桌面高级壳把那一行
 * 禁用了、中列是 `AdvancedFrame` 的 `.dshDesktopConversationSurface`。漏掉它时面板
 * 不会让位，画面变成两个区域各占一半。
 *
 * 新增中列实现时，这里与 `surfaceStylesheet()` 里的隐藏规则**必须成对更新**。
 */
export const CONVERSATION_COLUMN_SELECTOR = [
  '[data-pane="conversation"]',
  '[class*="centerCol"]',
  '[class*="ConversationSurface"]',
  '[class*="dshDesktopConversationSurface"]',
].join(', ')

/** 侧边栏里"点了就该离开整页面板"的行（会话/项目/搜索结果/新建会话）。 */
export const SIDEBAR_ROW_SELECTOR = [
  '[class*="sessionRow"]',
  '[class*="projectRow"]',
  '[class*="searchResultRow"]',
  '[class*="searchResultWorkspace"]',
  '[class*="newSession"]',
].join(', ')

/** `<html>` 上的唯一激活态属性；值 = 当前面板 id（空 = 会话区）。 */
export const PANEL_ACTIVE_ATTR = 'data-dsh-panel-active'

/** 面板容器自己的标记属性；值 = 该面板的 id。 */
export const PANEL_SURFACE_ATTR = 'data-dsh-panel-surface'

/** 跨插件面板激活事件；`detail` 是激活方的面板 id。 */
export const PANEL_ACTIVATE_EVENT = 'dsh-panel-activate'

/**
 * 当前激活的面板 id。
 * @param doc - 目标文档（测试注入；缺省取全局 `document`）。
 * @returns 面板 id；没有面板打开时返回 `null`（**空串也当没有**：属性被写成空值时
 *   不能算"有一个 id 为空串的面板开着"，否则所有面板都会以为自己不活跃）。
 */
export function activePanelId(doc: Document): string | null {
  const value = doc.documentElement.getAttribute(PANEL_ACTIVE_ATTR)
  return value === null || value === '' ? null : value
}

/**
 * 指定面板是否处于激活态。
 * @param id - 面板 id。
 * @param doc - 目标文档。
 * @returns 激活中为 true。
 */
export function isPanelActive(id: string, doc: Document): boolean {
  return activePanelId(doc) === id
}

/**
 * 找到中列容器（第一个命中的候选）。
 * @param doc - 目标文档。
 * @returns 中列元素；还没挂载时返回 `null`（启动早期就是这样，装载器要观察等待）。
 */
export function findCenterColumn(doc: Document): HTMLElement | null {
  return doc.querySelector<HTMLElement>(CONVERSATION_COLUMN_SELECTOR)
}

/**
 * 事件目标是否落在侧边栏的某一"行"上（用于"点了会话就返回聊天"）。
 * @param target - 事件目标。
 * @returns 命中为 true。
 */
export function isSidebarRowTarget(target: Element | null): boolean {
  return target !== null && target.closest(SIDEBAR_ROW_SELECTOR) !== null
}

/**
 * 面板 id 的联合类型。**故意不是封闭联合**：`(string & {})` 让第三方插件也能用
 * 自有 id，同时保留 IDE 对已知四个面板的补全。
 */
export type PanelId = 'cron' | 'capability' | 'connectors' | 'apps' | (string & {})
