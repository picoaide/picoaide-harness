/**
 * 会话作用域切换时的**清理链**（第二十八轮 FIX-40 ③）。
 *
 * ## 它解决什么
 *
 * `§7.2` 冻结的语义是「登出 / 切账号 / 切渠道 ⇒ 关闭全部应用窗口并清空映射，且会话作用域
 * 内的缓存作废」。两道清理的**代价形态完全不同**：
 *
 *  - `windows.closeAll()` 内部**没有 await**（`windows.ts` 的实现：逐个 `closeAppWindow`
 *    之后同步清空映射）⇒ 调用即同步关完，不存在"迟到完成"；
 *  - `cache.clearAll()` 是**真异步**（`rm -rf` 整个缓存根 + 重建根目录）。
 *
 * 于是修前这条路径上有一个真实窗口：会话事件触发的 `void cache?.clearAll()` 与**新作用域
 * 的第一个动作**（消费待打开队列的深链 / 本机路由的 open ⇒ 应用页加载 ⇒ `cache.put`）
 * 并发，`rm` 可能在新账号刚写进缓存**之后**才落地，把新账号的条目一起删掉。
 *
 * 修法不是给清理加"代际比对"（清理一旦开始，`rm` 的后果无法撤回），而是**排序**：
 * 新作用域的任何动作都必须排在上一代的清理链**落地之后**。本模块就是那条链 ——
 * 上一代留下一个 promise，新一代读它。
 *
 * ## 为什么不复用 `createSessionEpoch`
 *
 * 代际计数器回答的是"我现在还是不是最新的一代"（用于**丢弃**迟到结果）；这里要的是
 * "上一代的清理做完没有"（用于**排队**）。本包确实也用了代际（`appProof.invalidate`
 * 一类的作用域失效是同步的），但清理链的语义是顺序而不是新鲜度：即使中间又发生了一次
 * 换代，前一代的清理也**必须做完**（它清的是同一个缓存根），只是下一条会接在它后面。
 * 所以这里用串行链；`settled()` 负责"等到不再有在飞的清理"。
 *
 * ## 两条不变量
 *
 * 1. **顺序**：同一时刻只有一条清理在跑，后一次换代接在前一次之后（不会两条 `rm -rf`
 *    并发抢同一个根）；
 * 2. **fail-open**：清理钩子抛错只记一条 warn，链**照常落地** —— 否则一次 IO 失败会让
 *    `settled()` 永远挂住，此后每一次打开应用都要等它（把偶发 IO 失败升级成不可自愈的
 *    卡死，本仓已判过 P0 的同形事故）。
 *
 * @module @picoaide/dsh-wasm-apps-host/scope-reset
 */

/** 清理链的三件事（全部注入：本模块不 import electron、不做 IO）。 */
export interface ScopeResetTargets {
  /**
   * 关掉**全部**应用窗口（上一位用户/上一个服务端的窗口不得在新作用域复活）。
   *
   * **在 {@link ScopeReset.start} 里被同步调用**（不排进链）：`windows.closeAll()` 内部
   * 没有 await，调用即同步关完并清空映射 —— "登出即拆窗"这条既有语义（`index.spec.ts`
   * 的 B1 用例按同步断言钉着它）不能被推迟到一个微任务之后。返回值仍会被链等待，
   * 这样将来它真的变成异步时顺序依然成立。
   */
  closeWindows(): void | Promise<void>
  /** 清空会话作用域的缓存根（登出/切账号/切渠道）。真异步，串在链上。 */
  clearCache(): void | Promise<void>
  /** 诊断出口。 */
  warn(message: string): void
}

/** 作用域清理链。 */
export interface ScopeReset {
  /**
   * 开始一次换代清理，返回本次清理落地的 promise。
   *
   * ⚠️ 方法名**刻意**不叫 `begin`（也不是 `isCurrent`）：本仓的接线判据
   * （`packages/host/enterprise/tests/session-epoch-wiring.spec.ts`）按**名字**识别
   * "代际协议" —— 一个文件里出现 `x.begin(` 就会被判成"用了代际守卫"，于是规则 C 要求
   * 该文件里**每一个** await 都住在被守卫的函数里。实测：把本方法叫 `begin` 之后，
   * `index.ts` 立刻报 **11 条 `await-outside-guard`**（`requestOpen` 的 6 个 await +
   * 两个路由 handler + ai-chat 包装），而那 11 条只能靠新增 `AWAIT_EXEMPTIONS` 行豁免。
   * 这条清理链**不是**代际协议（见模块头"为什么不复用 createSessionEpoch"），换个名字
   * 既如实、又不会把无关文件拖进那个适用面。**不要改回 `begin`。**
   * @param leaving - 离开的作用域标识（`null` = 之前是未登录 ⇒ 只关窗、不清缓存：
   *   §7.6 要求"未登录入队、登录后打开"，清缓存会把那条链路上的热缓存一起打掉）。
   * @returns 本次清理（含它之前所有未落地的清理）的 promise。
   */
  start(leaving: string | null): Promise<void>
  /**
   * 等到**当前**这条链落地（期间又换代就继续等新的那条）。
   *
   * 新作用域的动作（消费待打开队列、本机路由的 open）必须经它排队，这样上一代的
   * `clearAll()` 不可能落在新作用域写下的内容之后。
   * @returns 全部在飞清理落地后的 promise。
   */
  settled(): Promise<void>
}

/**
 * 造一条作用域清理链（每个插件实例一条，住在 `apply()` 作用域里）。
 * @param targets - 关窗 / 清缓存 / 诊断三个钩子。
 * @returns 清理链。
 */
export function createScopeReset(targets: ScopeResetTargets): ScopeReset {
  let chain: Promise<void> = Promise.resolve()
  return {
    start(leaving: string | null): Promise<void> {
      // ① 关窗**同步**（见 ScopeResetTargets.closeWindows 的说明）：调用点返回时窗口
      //    与 surface 映射已经拆干净，"登出即拆窗"不退化成一个微任务之后的承诺。
      let closed: void | Promise<void>
      try {
        closed = targets.closeWindows()
      } catch (cause) {
        targets.warn(`pico-wasm-apps-host: closing application windows failed (${describe(cause)})`)
        closed = undefined
      }
      // ② 清缓存串在链上（真异步）；新作用域的动作等的是它。
      const next = chain.then(async () => {
        // fail-open：清理失败必须留下诊断，但不能把链卡住（见模块头不变量 2）。
        try {
          await closed
          if (leaving !== null) await targets.clearCache()
        } catch (cause) {
          targets.warn(`pico-wasm-apps-host: scope cleanup failed (${describe(cause)})`)
        }
      })
      chain = next
      return next
    },
    async settled(): Promise<void> {
      // 读-比-再读：等待期间若又发生一次换代，等的是**新的**那条链（否则会出现
      // "我等完了"与"新清理刚开始"同时成立，新作用域的写入又落进下一次 rm 的窗口）。
      for (;;) {
        const pending = chain
        await pending
        if (pending === chain) return
      }
    },
  }
}

/** 诊断用的错误描述（原始值兜底，避免 `[object Object]` 之外再抛一次）。 */
function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
