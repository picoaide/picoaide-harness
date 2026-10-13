/**
 * 能力中心（技能商店）的宿主行 —— **host + client 双面**（照
 * `packages/host/connectors` 的标准形态）。
 *
 *   - **client 面**：`dsh.client` 声明的 UI bundle（整页面板 + 内置技能区 +
 *     `capability.*` 字典 + 底部「更多」条目），由 client-modules 组装；
 *   - **host 面**：四条本机路由 `/api/pico/skills`、`/api/pico/agent-presets`、
 *     `/api/pico/shared-skills`、`/api/pico/capabilities`（2026-10-13，P0-b 自
 *     `@picoaide/dsh-enterprise/src/auth-gate.ts` 逐字搬出）。搬它的目的只有一个：
 *     让"关掉技能商店 ⇒ 它的代码不进产物"在依赖图上成立 —— 路由留在必需包里的
 *     话，模块再怎么关，这一整块（1,088 行）照样进 app.asar。
 *
 * 路由要用的**判定**（回环 + 同源 + 持有性证明、审计只读、网关失败分支、按请求
 * 解析的宿主语言）不在这里重新实现：auth-gate 经服务 `picoLocalRoutes` 交出同一批
 * 闭包，本行只是把它接上（`inject` 保证服务在场；缺席时 Cordis 让本行保持 pending，
 * 而不是静默少掉四条路由）。
 *
 * `@picoaide/dsh-capability-center/skill-telemetry` 是与本行同包的第二个插件行
 * （技能库变更的匿名计数），由本包的 `cordis.patch.yml` 一并插入。
 *
 * @module @picoaide/dsh-capability-center
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { createSkillRoutes, type HostLocalRouteFence } from './host/skill-routes.ts'

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'picoaide-capability-center'

/**
 * 本行需要的服务：本机 webServer（注册路由）、员工会话（路由自己经
 * `ctx.picoSession` 读写），以及 auth-gate 交出的共用围栏。
 */
export const inject = ['webServer', 'picoSession', 'picoLocalRoutes']

/**
 * 注册技能商店的四条本机路由。
 * @param ctx - Cordis 上下文（`inject` 保证三个服务在场）。
 */
export function apply(ctx: Context): void {
  const fence = ctx.get('picoLocalRoutes') as HostLocalRouteFence | undefined
  const webServer = ctx.webServer as { register?: (route: unknown) => () => void } | undefined
  if (fence === undefined || typeof webServer?.register !== 'function') {
    // `inject` 本该拦住这一支；真到了这里说明组合被改坏了 —— 明确报错，而不是
    // "界面上安静地少掉一个面板"（那是本仓记录过两次的 bug 类）。
    throw new Error('picoaide-capability-center: picoLocalRoutes/webServer is absent; the skill-store routes cannot be registered')
  }
  ctx.effect(() => {
    const disposers = createSkillRoutes(ctx, fence).map(route => webServer.register!(route))
    return () => { for (const dispose of disposers) dispose() }
  }, 'pico capability-center host routes')
}
