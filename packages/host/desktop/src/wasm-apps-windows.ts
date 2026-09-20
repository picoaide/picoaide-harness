/**
 * 应用窗口载体（设计总纲 §16.1 W-C「独立窗口 + surface」）的**桌面装配点**。
 *
 * ## 为什么单独一个模块
 *
 * 窗口适配器是**服务**（`ctx.provide`），窗口管理器是**插件**（
 * `@picoaide/dsh-wasm-apps-host` 读 `wasmAppsWindowAdapter` + 自己的 `userDataDir`
 * 配置）。三处只要有一处缺失，症状都是同一句话 ——「点打开，回 `opened`，
 * 屏幕上什么都没有」：
 *
 *  1. 没有 provider（服务缺席）⇒ `windows === undefined`（插件走"无窗口载体"分支）；
 *  2. `config.userDataDir` 没注入 ⇒ 同上（窗口几何/状态文件没有落点）；
 *  3. provider 给了，但真实适配器**没实现**（只有类型 + 单测替身）⇒ 调用即抛。
 *
 * 2026-09-20 的真实故障就是 1+2+3 同时成立（报告
 * `temp/wasm-client-only/fix-app-window.md`）。内联在 `main.ts` 的 boot 回调里时，
 * 这三种缺失在**任何**离线门禁下都是静默的（`main.ts` 只在真实 Electron 里执行），
 * 所以装配被抽到这里：由 `tests/wasm-apps-windows.spec.ts` 用**真实 `Context`**
 * 断言 `ctx.get(WASM_APPS_WINDOW_ADAPTER_SERVICE)` 真的拿得到适配器（删掉 provide
 * 即红），另加一条"`main.ts` 必须经本模块接线、并把 `app.getPath('userData')`
 * 注入插件行"的链接判据。
 *
 * @module dsh-plugin-desktop/wasm-apps-windows
 */

import type { Context } from '@deepseek-ai/cordis'
import { WASM_APPS_WINDOW_ADAPTER_SERVICE } from '@picoaide/dsh-wasm-apps-host'
import type { WasmAppsWindowAdapter } from '@picoaide/dsh-wasm-apps-host/windows'

/**
 * 把应用窗口适配器 `provide` 给插件（幂等：重复调用以后一次为准）。
 *
 * 调用点必须在 profile 树挂载**之前**（`boot()` 的 prepare 回调里，与
 * `wasmAppsHostAdapter` / 安装密钥 / AI runner 同批）—— 插件的 `apply()` 在
 * 挂载时读一次这个服务，晚于它的 provide 不会被看到。
 * @param ctx - 宿主 Cordis 上下文。
 * @param adapter - 真实 Electron 窗口适配器（`createRealElectronWindowAdapter`）。
 * @returns 同一个适配器（便于调用点复用它做诊断）。
 */
export function provideWasmAppsWindows(ctx: Context, adapter: WasmAppsWindowAdapter): WasmAppsWindowAdapter {
  ctx.provide(WASM_APPS_WINDOW_ADAPTER_SERVICE, adapter)
  return adapter
}
