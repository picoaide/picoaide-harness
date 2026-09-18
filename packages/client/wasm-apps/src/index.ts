/**
 * Host half of `@picoaide/dsh-wasm-apps`（WASM 应用平台的客户端面）。
 *
 * 这一半**故意是空的**：应用平台在本机只有一个本地 API 面
 * `/api/pico/apps/wasm/*`（目录 / 预检 / 发布编排 / 生命周期），它属于
 * `@picoaide/dsh-enterprise` 的 `wasm-apps` 模块 —— 那里能和 auth-gate 的
 * `guard` / `requireWriteProof` / 会话 / 有限体读取共用同一套信任原语。
 * 在第二个包里再注册一份路由，等于把"写面证明了什么"变成两种口径。
 *
 * 那本包存在的意义是什么？**客户端 bundle 的载体**：`package.json` 的
 * `dsh.client` 声明由 client-modules 扫描，`./client` 入口提供应用中心面板
 * 与侧边栏入口（浏览器半边）。宿主半边的契约（`name` / `apply`）与其它插件
 * 行一致，因此这一行可以像普通插件一样装配、禁用、卸载。
 *
 * @module @picoaide/dsh-wasm-apps
 */

import type { Context } from '@deepseek-ai/cordis'

/** Stable Cordis plugin name（与 package.json 的 id 保持一致）。 */
export const name = 'dsh-wasm-apps'

/** 无宿主依赖：本地路由与凭据都在 `@picoaide/dsh-enterprise` 那一侧。 */
export const inject: string[] = []

/**
 * No-op host half: the App Center client bundle is composed from the
 * `dsh.client` declaration, which does not require any host-side setup.
 * @param _ctx - Cordis context (unused; kept for the plugin-row contract).
 */
export function apply(_ctx: Context): void {}
