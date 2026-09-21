/**
 * Host half of `@picoaide/dsh-foot-menu`（侧边栏底部「更多」行）。
 *
 * 这一半**故意是空的**：本包不拥有任何本机路由、数据面或宿主服务 —— 「更多」行只是
 * 一个**客户端布局座位**，它收集的条目全部来自其它插件的客户端半边（它们自己拥有
 * 面板、轮询与写面）。宿主半边唯一的职责是把客户端 bundle 带进 profile：
 * `package.json` 的 `dsh.client` 声明由 client-modules 扫描，`./client` 入口在浏览器里
 * 提供 `picoFootMenu` 服务并注册唯一一个 `sidebar.footer.action` 占用者。
 *
 * 宿主半边的契约（`name` / `apply`）与其它插件行一致，因此这一行可以像普通插件一样
 * 装配、禁用、卸载。
 *
 * @module @picoaide/dsh-foot-menu
 */

import type { Context } from '@deepseek-ai/cordis'

/** Stable Cordis plugin name（与 package.json 的 id 保持一致）。 */
export const name = 'dsh-foot-menu'

/** 无宿主依赖：条目、面板与文案都在客户端半边。 */
export const inject: string[] = []

/**
 * No-op host half: the foot lane is composed from the `dsh.client` declaration,
 * which does not require any host-side setup.
 * @param _ctx - Cordis context (unused; kept for the plugin-row contract).
 */
export function apply(_ctx: Context): void {}
