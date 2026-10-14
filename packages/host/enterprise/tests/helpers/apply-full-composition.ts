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
 * ## 还要支持 `inject`（2026-10-13；`ctx.inject is not a function` 的成因）
 *
 * 模块行的宿主面用 `ctx.inject(['tools'], cb)` 取可选服务
 * （`wasm-apps-host/src/app-routes.ts`，理由写在那里：纯 Node 宿主里 `tools` 可能整行
 * 缺席，写进行级 `inject` 会把"工具没注册"升格成"启动门禁红"）。手写的假 ctx 没有这个
 * 方法，于是 `registerAppRoutes` 在**装组合的那一刻**就抛 `TypeError` —— 本文件下游
 * 三十个 spec 全部红在夹具形状上（不是产品行为），`yarn check` 的 enterprise 环节因此
 * 长期不可绿。
 *
 * {@link applyFullComposition} 按**真 Cordis 的语义**补上它：只有当**全部**被点名的服务
 * 当下可解析时才用 `ctx` 调回调；否则回调**不跑**（服务以后也不会出现 —— 这就是"纯 Node
 * 宿主里那一行缺席"的真实形态，不是把断言绕开）。这不是"测试替身"：三个 `apply` 与
 * `registerAppRoutes` 都是产品代码本身。
 *
 * ## 与真 Cordis 的差异：**已覆盖**与**未覆盖**（2026-10-14 对抗审计 · 乙-1）
 *
 * 审计用工作树里实际安装、产品运行期用的那一份 `@deepseek-ai/cordis@4.0.4` 实测了
 * `ctx.inject` 的 13 条语义，与本文件逐条对拍出 **6 处不一致**。本轮按性价比处置如下 ——
 * **不要把本文件当成真 Cordis**，它是"够用的形状"，不是等价实现：
 *
 * | 语义 | 真 Cordis | 本夹具 | 处置 |
 * | --- | --- | --- | --- |
 * | 依赖形态：裸字符串 | 抛 `TypeError: Reflect.has called on non-object`（`Inject.resolve` 对非对象调 `Reflect.has`） | 支持（包成 `[names]`）⇒ **比真机宽** ⇒ 能藏"本地绿、真机红" | **已修**：fail-loud（抛错并写明真机形态） |
 * | 依赖形态：对象映射 `{name: config}` | 支持（按名取服务；`config` 作为子插件 config） | 不支持 ⇒ `get('[object Object]')` 恒 undefined ⇒ 回调**静默不跑** | **已修**：按 `Object.keys` 取依赖名（`config` 不交给回调，见"未覆盖"） |
 * | 回调返回的 disposer | `runner.collect()` 收进该子 fiber（`fiber.ts:356-368`），卸载时调 | 直接丢弃 ⇒ 注销路径零覆盖 | **已修**：收进条目，`disposeInjections()` / 返回句柄的 `dispose()` 显式回收 |
 * | 返回值 | **Fiber 对象**（`dispose()` + thenable） | 普通函数 / 回调的返回值 | **已修**：返回 `{ dispose, then }` 形状 |
 * | 响应式：服务**后到** | 后来出现 ⇒ 回调**后来会跑** | 一次性判定 ⇒ 永不重跑 | **已修（仅限经本文件包装的 `provide` 这一条路）**：`provide` 写入后重扫待跑注入 |
 * | 响应式：服务**消失** | 回调被 unload、其返回的 disposer 被调 | 无 | **已修（仅限 `provide(name, undefined)` 这个信号）**：撤销该服务的注入并调它的 disposer |
 * | 时序 | 回调**至少晚一个微任务**（`_reload()` 首句 `await Promise.resolve()`） | **同步**执行 | **未覆盖**（登记，见下） |
 * | 回调拿到的 ctx | **子 Context**（`parent.extend({fiber})`，intercept/隔离生效） | 同一个父 `ctx` | **未覆盖**（登记） |
 * | "可用"的判据 | `reflect._getImpl(name, true)` + `impl.check()`（`check()` 为假 ⇒ 不可用） | `get(name) !== undefined`（值在就算可用） | **未覆盖**（登记） |
 * | 对象映射的 `config` | 作为子插件 config 交给 `apply(ctx, config)` | 只取依赖名，`config` 值不落地 | **未覆盖**（登记） |
 *
 * **这三/四条为什么不补齐**（诚实登记比假装等价重要）：
 *
 *  - **微任务时序**：本夹具的回调是**同步**跑的，而本仓用到它的 30 个 spec 全都在
 *    `applyFullComposition(...)` 返回之后**同步**断言（`h.tools` 必须立刻可用）。真按
 *    真机推迟一个微任务，会让几百条断言一起红在**夹具形状**上 —— 那正是本文件存在的
 *    理由的反面。
 *  - **子 Context**：假 ctx 是各 spec 手写的对象字面量，没有 `extend`/`fiber`。造一个
 *    假的 `extend` 只会把"intercept/隔离生效"这条真语义**伪装成已覆盖**。
 *  - **`impl.check()`**：同上，假 ctx 没有 `_getImpl`，`provide(name, value, check)` 的
 *    第三参也没有落点 ⇒ 判据只能停在"值在就算可用"。
 *  - **对象映射的 `config`**：夹具只把映射当"依赖名清单"读（这正是真机取服务的那一半），
 *    值本身没有消费方（本仓产品代码只用数组形态）。
 *
 *  ⇒ 这几条**今天没有任何判据**：产品里若出现"依赖 `check()` 为假视为不可用"、依赖
 *    intercept 隔离、或依赖"回调晚于微任务"的用法，夹具会绿，而真机行为另行判定。
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
 * {@link applyFullComposition} 的返回值 —— 把"服务齐不齐"从**日志代理**变成**可判的值**。
 *
 * 审计（乙-2）的现场：这条闸门此前唯一的观察者是
 * `wasm-app-tools.spec.ts` 的 `expect(h.loggedErrors).toEqual([])` —— 一个**间接**判据
 * （"没有多出一条错误日志"），而同一用例里 `expect(h.tools).toHaveLength(0)` 在闸门被
 * 拆掉时**仍然绿**（`registerWasmAppTools` 自己也会在 `tools` 缺席时早退）。spec 因此
 * 拿不到"回调到底跑没跑"的直接读面。
 */
export interface FullComposition {
  /**
   * 被点名、但**注册那一刻**解析不到的服务名（按声明顺序，逐次登记）。
   *
   * 这是一条**历史**记录：服务若后来经 `provide` 到齐，回调仍会补跑（见
   * {@link ranInjections}），而这个名字**仍然留在这里** —— 它回答的是"注册时缺了什么"。
   */
  skippedInjections: string[]
  /** 真正跑过的注入回调的依赖名（按运行顺序，每次回调一项）—— "服务齐了才跑"的**直接见证**。 */
  ranInjections: string[][]
  /** 回收全部注入回调返回的 disposer（真 Cordis 由子 fiber 在卸载时做）。可重复调用。 */
  disposeInjections(): void
}

/** 一次 `ctx.inject(deps, cb)` 的登记条目。 */
interface Injection {
  /** 依赖的服务名（真 Cordis 的 `Inject.resolve` 归一化后的键集）。 */
  deps: string[]
  callback: (scope: Context) => unknown
  /** 回调已经跑过（服务消失时会被放回 false，服务回来再跑一次）。 */
  running: boolean
  /** 这个条目名下的 disposer（回调返回值收集而来）。 */
  disposers: Array<() => void>
}

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
 * @returns 注入面的**可判读面**（{@link FullComposition}）。
 */
export function applyFullComposition(ctx: Context, config: Config = {} as Config): FullComposition {
  const provided = new Map<string, unknown>()
  const mutable = ctx as unknown as {
    get: (name: string) => unknown
    provide?: (name: string, value: unknown) => unknown
    inject?: (
      names: string | string[] | Record<string, unknown>,
      callback: (scope: Context) => unknown,
    ) => unknown
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

  const injections: Injection[] = []
  const skippedInjections: string[] = []
  const ranInjections: string[][] = []

  /** 卸载一个条目：调它名下全部 disposer，并放回"待跑"（服务回来时再跑一次）。 */
  const disposeEntry = (entry: Injection): void => {
    for (const disposer of entry.disposers.splice(0)) disposer()
    entry.running = false
  }
  const runEntry = (entry: Injection): void => {
    entry.running = true
    // 回调返回的函数在真 Cordis 里被收进该子 fiber 的 disposables（`fiber.ts:356-368`），
    // 卸载时调 —— 此前这里**直接丢弃**，于是"注销路径"整块不在观察面内。
    const result = entry.callback(ctx)
    if (typeof result === 'function') entry.disposers.push(result as () => void)
    ranInjections.push([...entry.deps])
  }
  /**
   * 重扫待跑的注入：服务**后到**（或消失后又回来）时把回调跑掉 —— 真 Cordis 是
   * **响应式**的（本夹具只在经下面 `provide` 包装的那条路上响应，见文件头"未覆盖"）。
   */
  const pump = (): void => {
    for (const entry of injections) {
      if (entry.running) continue
      // 读面用**包装后**的 `get`（它认 `provide` 写的表、也认 spec 摆的属性）。
      if (entry.deps.every(name => mutable.get(name) !== undefined)) runEntry(entry)
    }
  }

  mutable.provide = (name: string, value: unknown) => {
    provided.set(name, value)
    const result = rawProvide?.(name, value)
    if (value === undefined) {
      // 假 ctx 没有 fiber/destroy 事件 ⇒ 这是夹具里**唯一**的"服务消失"信号。
      // 真 Cordis 语义：服务消失 ⇒ 依赖它的子 fiber 被 unload，其 disposer 被调。
      for (const entry of injections) {
        if (entry.running && entry.deps.includes(name)) disposeEntry(entry)
      }
    }
    pump()
    return result
  }

  /**
   * `ctx.inject(deps, cb)` 的本仓形态：**服务齐了才跑回调**（真 Cordis 语义）。
   *
   * 保留各 spec 自己写的 `inject`（如果它摆了）：本函数的职责只是"假 ctx 缺这个方法时
   * 不要炸在产品代码里"。手写对象字面量没有这个方法，于是这里兜一个。
   */
  const rawInject = mutable.inject?.bind(ctx)
  mutable.inject = (
    names: string | string[] | Record<string, unknown>,
    callback: (scope: Context) => unknown,
  ) => {
    if (rawInject !== undefined) return rawInject(names, callback)
    if (typeof names === 'string') {
      // 真 Cordis 的 `Inject.resolve` 对非对象调 `Reflect.has` ⇒ **当场抛**
      // `TypeError: Reflect.has called on non-object`（实测）。夹具此前把它包成
      // `[names]` 支持了 —— 比真机**宽**，于是 `ctx.inject('tools', cb)` 这种写法会
      // "本地绿、真机红"。这里改成 fail-loud：不替真机兜底，也不静默接受。
      throw new Error(
        `applyFullComposition: ctx.inject 收到裸字符串 '${names}' —— 真 Cordis 会抛 `
        + '`TypeError: Reflect.has called on non-object`（`Inject.resolve` 对非对象调 `Reflect.has`），'
        + `夹具不替它兜底。请写成数组 ['${names}'] 或对象映射 { ${names}: <config> }。`,
      )
    }
    // 真 Cordis 的 `Inject` 形态：数组 = 只要服务；对象映射 = 按名取服务 + 每名一份
    // intercept config（config 交给子插件的 apply，本夹具只取依赖名 —— 见文件头"未覆盖"）。
    const deps = Array.isArray(names) ? [...names] : Object.keys(names)
    const entry: Injection = { deps, callback, running: false, disposers: [] }
    injections.push(entry)
    const missing = deps.filter(name => mutable.get(name) === undefined)
    if (missing.length > 0) skippedInjections.push(...missing)
    pump()
    return {
      /** 真 Cordis 的 Fiber 有 `dispose()`（卸载这个注入、调它的 disposer）。 */
      dispose: () => disposeEntry(entry),
      /**
       * 真 Cordis 的 Fiber 是 **thenable**（ACTIVE 时 resolve）。夹具是同步的，所以
       * 这里立即 resolve —— 形状对齐，**语义不等价**（见文件头"未覆盖"）。
       */
      then: (resolve?: (value: unknown) => unknown) => resolve?.(undefined),
    }
  }

  applyAuthGate(ctx, config)
  applyCapabilityCenter(ctx)
  const fence = ctx.get('picoLocalRoutes') as HostLocalRouteFence | undefined
  if (fence === undefined) {
    // 组合装坏了就该在测试里**可见**地失败，而不是让几十个 spec 各自红在"没有路由"上。
    throw new Error('applyFullComposition: auth-gate did not provide picoLocalRoutes')
  }
  registerAppRoutes(ctx, fence)
  return {
    skippedInjections,
    ranInjections,
    disposeInjections: () => {
      for (const entry of injections) disposeEntry(entry)
    },
  }
}
