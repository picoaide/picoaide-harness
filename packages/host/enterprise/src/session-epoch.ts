/**
 * 「会话代际」判据的**唯一实现**（第二十六轮审计 Z2-01，P1）。
 *
 * ## 它解决什么
 *
 * 本包有一整族「**会话派生的异步投影**」：会话一变就把服务端下发的东西写进本地
 * settings / 凭据 / 界面（bootstrap 的模型目录与搜索地址、error-reporting 的
 * Sentry DSN、gateway-model 的网关令牌与 baseURL、channel-sync 的品牌内容）。
 * 它们的形状都是「订阅会话 → `await` 一次远地往返 → 落地（写盘 / 发事件 / 改状态）」，
 * 而**订阅是并发的**：每次会话变化都直接调用一次，不串行、不带序号。
 *
 * 于是"服务端 A 的响应慢、用户已登出并登录到服务端 B、B 先回、A 后回"这条普通时序
 * 会让 A 的内容盖住 B 的：
 *
 *  - `bootstrap.ts`：当前会话（B）的 `llm-deepseek.models` 与
 *    `web-search-deepseek.baseURL` 被改写成 **A** 的，而 `gateway-model.ts` 已经把
 *    `PICOAI_GATEWAY_TOKEN` 写成 B 的令牌 ⇒ 上游 `web-search-deepseek` 在**同一次
 *    请求**里用这份 URL + 这份 key（`x-api-key` 与 `Authorization: Bearer` 都发），
 *    把 B 的 90 天 bearer POST 到 A 的 `/v1/messages`（跨租户凭据外泄）；
 *  - `error-reporting.ts`：Sentry DSN 改回 A 的采集端 ⇒ 未捕获异常的**栈、URL、
 *    用户名**上报到上一台租户；登出后还会把 `disabled` 变回 `ready`；
 *  - `gateway-model.ts`：登出那次 `sync(null)` 的续体落在重新登录之后 ⇒ 把新会话的
 *    `llm-deepseek` 段整段清空；
 *  - `channel-sync.ts`：界面品牌停在上一台服务端。
 *
 * ## 规则（每个 sync 都必须照此写）
 *
 * 1. sync 入口**同步**取一次代际：`const epoch = epochs.begin()`（必须在第一个 await
 *    之前，否则"取代际"这一步自己就会被乱序）；
 * 2. **每个 `await` 之后**比对 `if (!epochs.isCurrent(epoch)) return` —— 不写盘、
 *    不发事件、不改状态；
 * 3. 被 await 的**被调方**如果自己也要在 await 之后改状态（`initSentry` 就是），
 *    就必须把「还算不算最新」当谓词**传进去**，而不是只在外层补一句比对。
 *
 * 第 2、3 条不是靠自觉：`tests/session-epoch-wiring.spec.ts` 用 AST 逐条钉死
 * （未守卫的 await、未守卫的新 sync 入口、忘了传谓词的 `initSentry` 都会变红）。
 *
 * ## 为什么是"代际计数器"而不是复用令牌比较
 *
 * 同仓已有两条同族先例，二者的**判据强度不同**，不能互相替代：
 *
 *  - `session-service.ts` 的 `persistEpoch`（F7）：写盘前比对"期间是否又发生过一次
 *    会话变化"——**计数**语义，与这里逐字同形；
 *  - `session-service.ts` 的 `clearIfCurrent(token)`（R22-V1-N3）：比对**令牌**，
 *    用于"这次 401 属于哪一代会话"。它的注释已经把同一条推理写完了
 *    （「`session` 是订阅那一刻的那一份，而 `sync` 里有 await —— 期间用户可能已经
 *    重新登录」）——**但那一轮只把它用在了错误路径**，成功路径（三次 settings 写入）
 *    原样未守卫，这就是 Z2-01。
 *
 * 令牌比较在这里**不够**：同一账号重新登录完全可能拿到同一个字符串（服务端不保证
 * 令牌每次不同），而"同一个令牌、不同代"恰恰是本族最危险的一种（bootstrap 的
 * models/baseURL 会被旧响应改写，凭据却"看起来没变"）。代际计数器对
 * 「登出再登录同一台服务端」「同一会话被重复广播」也一律成立，所以这里用它；
 * `clearIfCurrent` 继续负责"401 该不该清"那一问（两者在各自调用点并存，语义互指，
 * 见 `bootstrap.ts` 的 catch 分支注释）。
 *
 * 本模块**零依赖、零副作用**（不 import cordis、不读盘、不读环境），可以被任何
 * 宿主面安全引入。
 * @module @picoaide/dsh-enterprise/session-epoch
 */

/** 会话代际守卫：一次同步的"我是不是最新"判定。 */
export interface SessionEpoch {
  /**
   * 开始一次会话派生的同步，返回本次的代号（单调递增）。
   *
   * **必须在同步入口、第一个 `await` 之前调用**：晚一步就可能把"已经过期的自己"
   * 当成最新的一代。
   * @returns 本次同步的代际号（调用方可直接闭包持有）。
   */
  begin(): number
  /**
   * 本次同步是否仍是**最新**的那一次。
   *
   * 只在 `await` 之后调用：`false` ⇒ 期间已有更新的一次同步开始（登出、换服务端、
   * 换账号、重登），本次结果必须整份丢弃。
   * @param epoch - {@link begin} 返回的代际号。
   * @returns 仍是最新一代为 true。
   */
  isCurrent(epoch: number): boolean
}

/**
 * 造一个代际守卫（每个插件实例一个，住在 `apply()` 作用域里）。
 *
 * 用闭包而不是模块级单例：模块级状态会跨插件实例/测试用例串味，而"谁是当前代"
 * 本来就是单个插件的订阅序列的属性。
 * @returns 代际守卫。
 */
export function createSessionEpoch(): SessionEpoch {
  let current = 0
  return {
    begin: () => {
      current += 1
      return current
    },
    isCurrent: (epoch: number) => epoch === current,
  }
}
