/**
 * WASM 应用中心（应用平台）的**本机 API**（host 面）—— 2026-10-13（P0-b）自
 * `packages/host/enterprise/src/auth-gate.ts` 的注册块逐字搬出（编排实现
 * `wasm-apps.ts` / `wasm-app-tools.ts` 同批搬进本包）。
 *
 * 搬它的**唯一**目的：让"关掉应用中心 ⇒ 它的代码不进产物"在依赖图上成立。此前
 * 整条客户端创作链路（2,031 + 758 + 579 行）住在 `@picoaide/dsh-enterprise`
 * （必需包）里，模块再怎么关，它照样进 app.asar。
 *
 * ## 行为零变化
 *
 * 路由路径（`/api/pico/apps/wasm*`）、方法分发、状态码、错误信封与 hints 逐字不变。
 * 围栏（回环 + 同源 + 持有性证明）、语言解析、`aiRowsConsent` 的作用域口径也都不在
 * 这里重新实现：auth-gate 经服务 `picoLocalRoutes` 交出**同一批闭包**，本模块只做
 * 结构探测后调用（与 `src/session.ts` 探测 `picoSession` 同形）。**不要**把任何
 * 围栏判定复制一份进来：那是第二真源，而这里判的是信任边界。
 *
 * `aiRowsConsent` 的构造从 auth-gate 搬到本模块（它只服务应用面），语义不变：
 * 一个实例、两个消费方（本机路由与 `wasm_app_*` 工具面），作用域每次调用解析。
 *
 * @module @picoaide/dsh-wasm-apps-host/app-routes
 */

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { HostLocale } from './locale.ts'
import type { Session } from '@picoaide/dsh-gateway-client/config'
import { createAiRowsConsentStore, defaultAiRowsConsentPath } from './wasm-apps-ai-rows-consent.ts'
import { createWasmAppsRoute } from './wasm-apps.ts'
import { registerWasmAppTools, WASM_APP_TOOL_NAMES } from './wasm-app-tools.ts'

/**
 * 本机路由共用的**围栏与出口**：由 `@picoaide/dsh-enterprise/auth-gate` 的
 * `apply()` 经服务 `picoLocalRoutes` 交出（唯一实现，见模块头注释）。
 *
 * 结构类型而非 import：指向 auth-gate 会闭合出
 * `desktop → wasm-apps-host → enterprise → desktop` 这个构建环（desktop 的 tsdown 把
 * `@picoaide/*` 内联进自己的 `lib/`，而 enterprise 的 tsc 读 `dsh-plugin-desktop`）。
 */
export interface HostLocalRouteFence {
  /** 回环 + 同源围栏（所有方法都要过）。 */
  guard(req: IncomingMessage, res: ServerResponse): boolean
  /** 写面持有性证明（GET 直接放行，非 GET 在 fence 缺席时 fail-closed 503）。 */
  requireWriteProof(req: IncomingMessage, res: ServerResponse): boolean
  /** 不分方法的持有性证明（消费型 GET 用；fence 缺席时 fail-closed）。 */
  proofOfPossession(req: IncomingMessage, res: ServerResponse, level: 'required' | 'best-effort'): boolean
  /** 第二道保险：auditor 不得触发任何写面（§4.5）。 */
  writeGuard(): boolean
  /** 当前员工会话（令牌 + 服务端地址）。 */
  session(): Session | null
  /** 本地 JSON 响应（路由自己的围栏错误用它写出，与 `wasmError` 同字节）。 */
  json(res: ServerResponse, status: number, body: unknown): void
  /** 本地请求体收集（带上限，超限抛错）。 */
  collectBody(req: IncomingMessage, limit: number): Promise<Buffer>
  /** 宿主语言（本地文案按请求解析，禁止模块级冻结）。 */
  hostLocale(req?: IncomingMessage): HostLocale
}

/**
 * 「允许 AI 读取此应用的数据」的授权状态（**默认关**，2026-09-21 用户拍板）。
 *
 * 四条接线事实在这里一次说清：
 *  1. **一个实例、两个消费方** —— 本机路由（`/:app_id/ai-rows-consent`，人在面板上点）
 *     与宿主工具（`wasm_app_rows` 的闸门）共用下面这一个对象；
 *  2. **落盘位置** = `$DSH_HOME/wasm-apps-ai-rows-consent.json`（0600，原子写）——
 *     与 `server-connector/tls.ts` 的指纹库同一形态（"随装小状态"落点）；
 *     不用 `ctx.settings`：那是用户可编辑的产品配置域，且 `bootstrap.ts` 在退出登录时
 *     会 `replace()` 清掉命名空间 ⇒ 授权会随重登消失；
 *  3. **作用域 = 用户 ⊕ 服务端 ⊕ 应用**（第十九轮审计 R19B-03）：作用域由 store
 *     自己经下面的 `scope` 提供者**每次调用**解析 —— 登录、换账号、换服务端都发生在
 *     同一个进程里，构造期快照会让下一个账号继承上一个人的授权。拿不到用户名或
 *     服务端地址时 store 的写面拒绝（路由据此回 401 `AUTH_REQUIRED`，与本包
 *     `src/index.ts` 的同名闸门同形），读面回 false；
 *  4. **数据根不可信时**（`dshHomeSafe()` 拒绝：DSH_HOME 指向系统关键目录）退化成
 *     **内存记录**（照样 fail-closed，只是重启即忘），而不是让插件 apply 失败。
 * @param ctx - Cordis 上下文（日志出口）。
 * @param session - 当前会话提供者（每次调用求值；来自围栏服务）。
 * @returns 授权 store（路由与工具面共用同一个实例）。
 */
export function createAppAiRowsConsent(ctx: Context, session: () => Session | null) {
  const file = ((): string | undefined => {
    try {
      return defaultAiRowsConsentPath()
    } catch (cause) {
      ctx.logger?.warn?.(`pico: resolving the data root for the AI rows consent failed (${cause instanceof Error ? cause.message : String(cause)}); the consent will not survive a restart`)
      return undefined
    }
  })()
  return createAiRowsConsentStore({
    ...(file === undefined ? {} : { file }),
    // 每次调用求值：`session()` 是同一个进程里随登录状态变化的权威来源。
    scope: () => {
      const current = session()
      return current === null ? null : { user: current.username, server: current.serverURL }
    },
    warn: message => { ctx.logger?.warn?.(message) },
  })
}

/**
 * 注册应用中心的两条宿主面：本机路由（{@link createWasmAppsRoute}）与宿主工具
 * （{@link registerWasmAppTools}）。
 *
 * 两者共用**同一个** `aiRowsConsent` 实例 —— 两个实例（或一份内存副本）会让
 * "点了允许、工具仍旧拒绝"，而那看起来像 AI 坏了（既有注释，2026-09-21）。
 * @param ctx - Cordis 上下文。
 * @param fence - auth-gate 交出的共用围栏（见 {@link HostLocalRouteFence}）。
 * @returns 路由的注销函数（工具面自己管自己的注销）。
 */
export function registerAppRoutes(ctx: Context, fence: HostLocalRouteFence): () => void {
  const hostLocale = (req?: IncomingMessage): HostLocale => fence.hostLocale(req)
  const aiRowsConsent = createAppAiRowsConsent(ctx, () => fence.session())
  const disposeRoute = (ctx.webServer as { register: (route: unknown) => () => void }).register(
    createWasmAppsRoute(ctx, {
      guard: fence.guard,
      requireWriteProof: fence.requireWriteProof,
      // GET 也要证明显（行数据面）：同一份持有性证明原语，策略由路由决定。
      requireProof: (req: IncomingMessage, res: ServerResponse) => fence.proofOfPossession(req, res, 'required'),
      writeGuard: fence.writeGuard,
      session: fence.session,
      json: fence.json,
      collectBody: fence.collectBody,
      hostLocale,
      // 面板经本机路由写它、`wasm_app_rows` 读它 —— **同一个实例**（下面那个
      // registerWasmAppTools 拿到的就是它）。
      aiRowsConsent,
    }),
  )
  // WASM 应用平台的**宿主工具面**（§6.5b）：让 AI 能自己预检与发布，而不是只能请
  // 员工去应用中心点。工具直接调用上面那条路由背后的**同一批编排函数**
  // （wasm-apps.ts 的 publishApp/validateApp/listCatalog/readAppRows…）—— 不经 HTTP，
  // 因此不需要浏览器持有性证明，也不会把员工令牌交给任何调用方。
  // 语言按**每次调用**解析（hostLocale 是上面的函数，不在模块级冻结）。
  //
  // `tools` 服务经 `ctx.inject` 取，**不写进行级 `export const inject`**（与
  // `src/index.ts` 的 `browserSurface` 同一条理由，那段注释是这条约定的真源）：
  // 纯 Node 宿主（组合冒烟、单测、无头嵌入）里 `tools` 可能整行缺席，而本插件在桌面
  // 组合里是**必需行**（`desktop/src/startup-rows.ts`）—— 写进行级 inject 会让那种
  // 组合里的行停在 PENDING，把"工具没注册"升格成"启动门禁红"。
  // 回调在服务出现时才跑；它返回的 disposer 由 Cordis 收进这个子 fiber，`tools` 消失
  // 或插件卸载时自动回收（`registerWasmAppTools` 要求的"从插件 fiber 里调用并回收"
  // 仍然成立，且不会与下面那句重复回收）。
  //
  // **组装期观测（2026-10-14 对抗审计 · 乙-P2）**：`inject` 化之后，
  // `registerWasmAppTools` 里那句「tools 服务缺席 ⇒ 明确报错」在**真缺 `tools`** 的宿主里
  // **永远到不了**（回调根本不跑）；该宿主于是**静默**地少掉 6 个 `wasm_app_*` 工具，
  // 日志里一条线索都没有 —— 这正是 2026-10-13 那次修复想消除的形态，却被同一处改动
  // 挡在了后面。所以这里补一句**组装期**观测（`logger.warn`，与 `src/index.ts` 既有的
  // 告警通道同款），把"缺席"重新变成可检索的一行。
  //
  // 为什么这里同步读 `ctx.get('tools')` 不会误报：本插件的插件行
  // （`src/index.ts` 的 `inject = ['picoSession', 'webServer', 'picoLocalRoutes']`）不含
  // `tools`，而桌面组合里 `tools` 行在 base bundle、早于本行就位 ⇒ 在场时不会打这条。
  // 真到了"缺席"那一档，它就是事实：工具不会注册，除非 `tools` 之后才出现（那时
  // `inject` 的回调会补跑 —— 这条提示说的是"组装那一刻缺席"）。
  if (ctx.get('tools') === undefined) {
    ctx.logger?.warn?.(
      `pico: tools service is absent at composition time — ${WASM_APP_TOOL_NAMES.join('/')}`
      + ' were NOT registered (they will be registered if the tools service appears later)',
    )
  }
  ctx.inject(['tools'], toolsCtx =>
    registerWasmAppTools(toolsCtx, { locale: () => hostLocale(), aiRowsConsent }))
  return disposeRoute
}
