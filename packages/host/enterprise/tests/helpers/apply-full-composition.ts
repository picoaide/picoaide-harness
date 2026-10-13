/**
 * 装一个**完整的本机 API 组合**：auth-gate + 技能商店 + 应用中心。
 *
 * ## 为什么需要它（2026-10-13，P0-b）
 *
 * 技能商店的四条本机路由（`/api/pico/skills`、`/agent-presets`、`/shared-skills`、
 * `/capabilities`）与应用中心的三条（`/api/pico/apps/wasm*`）原先都注册在
 * `auth-gate.apply()` 里，所以测试只要 `apply(ctx, config)` 就能按真实 pathname 打进去。
 * 那些路由现在**随各自的模块包**（`@picoaide/dsh-capability-center` /
 * `@picoaide/dsh-wasm-apps-host`），由它们自己的插件行注册 —— 因为"host 面留在必需包里"
 * 正是"关掉模块它的代码照样进产物"的成因。
 *
 * 于是测试也必须装**同样的三层**，否则判据会失去输入（路由不存在 ⇒ 每条断言都红，
 * 而红的原因不是产品行为）。顺序与真实 profile 的 bundle 层顺序一致：
 * auth-gate 先（它 `provide('picoLocalRoutes')` 交出围栏），模块行后（它们 `inject` 它）。
 *
 * 假 ctx 因此必须支持 `provide`/`get` 这一对 —— 各 spec 里的 `const ctx = { … }` 都补了
 * 两行（`provide` 写进 `ctx['__svc_<name>']`，`get` 先查它）。
 *
 * **这不是"测试替身"**：装的三个 `apply` 都是产品代码本身，围栏、网关客户端、语言解析
 * 都还是那一份实现。这个文件只负责按真实顺序把它们串起来。
 *
 * @module tests/helpers/apply-full-composition
 */
import type { Context } from '@deepseek-ai/cordis'
import { apply as applyCapabilityCenter } from '../../../capability-center/src/index.ts'
import type { HostLocalRouteFence } from '../../../wasm-apps-host/src/app-routes.ts'
import { registerAppRoutes } from '../../../wasm-apps-host/src/app-routes.ts'
import { apply as applyAuthGate, type Config } from '../../src/auth-gate.ts'

/**
 * 装完整组合（auth-gate → 技能商店 → 应用中心）。
 *
 * ## 假 ctx 的 `provide`/`get` 由本函数统一兜住
 *
 * 各 spec 里的 `const ctx = { … }` 是**手写对象字面量**，形状各不相同（`get` 有单行
 * 三元、多行三元、块体三种写法）；而真实 Cordis 的 `ctx.provide(name, value)` 会让后
 * 续的 `ctx.get(name)` 拿到它。这里在装组合**之前**把这一对方法包一层：写入记进一个
 * 局部表，读取先查表、查不到再走各 spec 原本的实现。
 *
 * 这样做的理由不是图方便：模块行（能力中心 / 应用宿主）读的是
 * `ctx.get('picoLocalRoutes')`，如果每个 spec 各自决定"要不要支持这条服务"，判据就会
 * 因为**假 ctx 的写法**而红/绿 —— 判据要判的是产品行为，不是夹具的形状。
 * @param ctx - 假 ctx（必须支持 `effect`/`webServer.register`）。
 * @param config - auth-gate 的组合配置。
 */
export function applyFullComposition(ctx: Context, config: Config = {} as Config): void {
  const provided = new Map<string, unknown>()
  const mutable = ctx as unknown as {
    get: (name: string) => unknown
    provide?: (name: string, value: unknown) => unknown
  }
  // 有的 spec 的假 ctx **没有** `get`（只装登录页那几个，从不查服务）—— 兜一个
  // 恒 undefined 的读面，而不是让 `bind` 抛在夹具形状上。
  const rawGet = typeof mutable.get === 'function' ? mutable.get.bind(ctx) : ((): undefined => undefined)
  const rawProvide = typeof mutable.provide === 'function' ? mutable.provide.bind(ctx) : undefined
  /**
   * 真 Cordis 的 Context 是 Proxy：读 `ctx[name]` 内部**又**回到 `ctx.get(name)`。
   * 兜底那一跳因此必须自带重入闸，否则真 Context 的 spec（`auth-gate-session-switch`）
   * 会滚成 RangeError —— 那种红与产品行为毫无关系。
   */
  let inPropertyFallback = false
  mutable.get = (name: string) => {
    if (provided.has(name)) return provided.get(name)
    const viaRaw = rawGet(name)
    if (viaRaw !== undefined) return viaRaw
    if (inPropertyFallback) return undefined
    // 真 Cordis 里"服务属性"与 `ctx.get('<服务名>')` 是同一条服务（`Service` 基类
    // 两者都挂）。有的 spec 只在假 ctx 上摆了 `picoSession: { … }` 属性、没让 `get`
    // 认它 —— 这里按同一性补齐，判据才不会因为夹具的形状而红。
    inPropertyFallback = true
    try {
      return (ctx as unknown as Record<string, unknown>)[name]
    } finally {
      inPropertyFallback = false
    }
  }
  mutable.provide = (name: string, value: unknown) => {
    provided.set(name, value)
    return rawProvide?.(name, value)
  }
  applyAuthGate(ctx, config)
  applyCapabilityCenter(ctx)
  const fence = ctx.get('picoLocalRoutes') as HostLocalRouteFence | undefined
  if (fence === undefined) {
    // 组合装坏了就该在测试里**可见**地失败，而不是让几十个 spec 各自红在"没有路由"上。
    throw new Error('applyFullComposition: auth-gate did not provide picoLocalRoutes')
  }
  registerAppRoutes(ctx, fence)
}
