/**
 * 「员工会话变化」订阅契约的**唯一实现**（宿主侧）。
 *
 * ## 为什么它必须是一份共享实现
 *
 * `pico/session-changed` 有三个消费方（enterprise 的一整套同步插件、wasm-apps-host 的
 * 窗口/缓存作用域、desktop 的应用 AI 执行面），而**裸 `ctx.on` 会漏掉最常见的那次事件**：
 * `SessionService.restore()` 在**构造期**就启动（`void this.restore().finally(…)`），
 * 它 emit 的那一刻可能早于任何插件的 `apply()` —— 于是"重启后带着有效会话"这条路径上，
 * 消费方要等到下一次登录/登出才生效（本仓已记录两次同根因事故：2026-09-05 的
 * inputModalities、2026-09-10 的渠道 logo）。
 *
 * 正确形态只有一条：**先订阅，再补一次"已经恢复完成"的状态**（判据用 `isRestored()`，
 * 它在 `restore()` 的 `finally` 里置位，而事件在那之前 emit ⇒ `true` = 已错过、`false` =
 * 后续必然收到；两个方向都不重不漏）。这段顺序此前在仓里有**三份拷贝**
 * （`enterprise/session-service.ts`、`wasm-apps-host/session.ts`、desktop 的
 * `updates.ts`），本模块是它的收口：前两者的公共入口都改为委托到这里。
 *
 * ## 为什么住在叶子包
 *
 * 构建图是 `desktop → wasm-apps-host → browser → connectors → 叶子包`，而 enterprise 依赖
 * desktop ⇒ desktop 不可能 import enterprise 的 `subscribeSession`（会成环）。把这个契约
 * 放进**零依赖叶子包**（与 2026-09-23 的 `loopback.ts` 四份合一同一手法）后，三方都能用
 * 同一份实现，且环不会以新形状绕回来。
 *
 * ⚠️ 本模块**不得** import `@deepseek-ai/cordis`：叶子包的零依赖不变量是构建图的锚
 * （见本包 `tsdown.config.ts`）。所以上下文按**结构最小面**声明（`on` + `get`），
 * 与 `@deepseek-ai/cordis` 的宽签名逐个字段兼容。
 *
 * ## 代际守卫（2026-09-27，第二十七轮 AA3-01）
 *
 * 与订阅契约同族、同一个构建图理由：`desktop/src/updates.ts` 的更新源是会话派生的
 * （换服务端 = 换更新源），而它的两条异步投影（清单检查、安装包下载）在**完成路径上
 * 只看 `disposed`、不看会话身份** ⇒ 上一台服务端/上一个渠道的安装包会在当前会话里
 * 被标成"可下载/可安装"，`installReady()` 甚至会把它交给平台安装器真的拉起。
 * 修法就是本模块的 {@link createSessionEpoch}（第二十六轮 Z2-01 在 enterprise 的
 * `session-epoch.ts` 里已经写过一遍同一份语义），而那个文件住在 **enterprise** 包 ——
 * desktop **不可能** import 它（enterprise 依赖 desktop，会成环）。所以实现搬到这里，
 * enterprise 的 `session-epoch.ts` 改为一行 re-export（对外语义一字不改）。
 *
 * 放在 `session-events` 而不是新开一个子路径，是因为两者是同一件事的两半：本模块知道
 * **会话什么时候变**，代际计数器就是"变了几次"的唯一读数 —— 而且
 * `node_modules/@picoaide/dsh-host-locale/lib/session-events.js` 已经在打包必需清单里，
 * 不引入新的打包面（新增子路径就必须同步 `REQUIRED_PACKAGED_RUNTIME_ENTRIES`）。
 *
 * @module @picoaide/dsh-host-locale/session-events
 */
/** 会话变化事件名（enterprise `SESSION_CHANGED_EVENT` 逐字一致）。 */
export declare const SESSION_CHANGED_EVENT = "pico/session-changed";
/** `picoSession` 服务的结构探测面（本模块只关心这两项）。 */
export interface PicoSessionProbe {
    /** 持久化会话是否已经恢复完成（`restore()` 的 `finally` 里置位）。 */
    isRestored?: () => boolean;
    /** 当前会话（未登录 ⇒ `null`）。 */
    getSession?: () => unknown;
}
/**
 * 订阅所需的**上下文最小面**。
 *
 * 两个签名都刻意取宽（与 cordis 自己的 `on(name: string|symbol, …)` / `get(name: string)`
 * 兼容）：叶子包不能 import cordis，而消费方传进来的就是真实的 `Context`。
 *
 * `get` 是**可选**的：真实 Cordis 上下文一定有它，但本仓不少用例用结构替身
 * （`{ on, emit, picoSession }`）驱动这条契约，替身只挂服务属性、没有注册表。
 */
export interface SessionEventContext {
    /** 注册事件监听，返回取消订阅函数。 */
    on(event: string, listener: (...args: any[]) => unknown): () => void;
    /** 探测服务（缺席 ⇒ `undefined`）。 */
    get?(name: string): unknown;
    /** Cordis 把服务同时挂成上下文的属性（结构替身常用这一面）。 */
    picoSession?: PicoSessionProbe;
}
/** `picoSession` 服务的注册名（`SessionService` 的 `super(ctx, 'picoSession')`）。 */
export declare const PICO_SESSION_SERVICE = "picoSession";
/**
 * 订阅会话变化，并补发"已经恢复完成"的那一次状态（见模块头注释）。
 *
 * 补发规则（三条，与历史三份拷贝逐条对齐）：
 *
 *  - 探测到的服务**已完成恢复**（`isRestored() === true`）⇒ 立即用当前会话回调一次；
 *  - 服务**不存在**或没有 `isRestored`（纯桌面冒烟、还没装配 enterprise 面）⇒ 也回调一次
 *    并给出 `null`/"未登录" —— 消费方必须知道"现在没有会话"，而不是永远等一个
 *    不会来的事件；
 *  - 否则（恢复仍在飞行）⇒ **不**回调：那次事件还没发，订阅已经就位。
 *
 * ## "没有会话"的哨兵只有一个：`null`（2026-10 审计 C2-2）
 *
 * 本函数有**两条投递通道**：`pico/session-changed` 事件，以及上面那次补发。事件通道
 * 由 `SessionService` 投递，它一直用 `null`（`subscribeSession` 里的事件签名就是
 * `(session: Session | null) => void`）；补发通道此前把"探测不到服务"投成
 * `undefined` ⇒ **同一个订阅按到达方式给出两种哨兵**，而消费方只认一种：
 * enterprise 的三处（`bootstrap` / `channel-sync` / `error-reporting`）只判
 * `=== null`，收到 `undefined` 会走进"已登录"分支、在字段读取上抛错
 * （`channel-sync` 的同步失败还会被它自己的 `.catch` 吞掉）。
 *
 * 归一收口在**唯一实现**里（`?? null`），而不是在每个包装层/每个消费方各补一次：
 * 这里是"会话什么时候变"的唯一读数，多一个消费方就多一处可漏的地方。
 * 判据 `packages/host/host-locale/tests/session-events.spec.ts` 的
 * 「服务缺席 ⇒ 补发 null，不是 undefined」＋ enterprise 侧的
 * `tests/session-sentinel.spec.ts`（真 `apply()` 的行为面）。
 *
 * @param ctx - 上下文（只需 `on`，外加 `get` 或 `picoSession` 之一）。
 * @param listener - 收到会话（或未登录状态）时的回调。**必须幂等**：它可能被立即调用一次。
 * @param probe - 探测 `picoSession`（缺省 = {@link probeSession}；wasm-apps-host 用它注入
 *   自己的归一化读取）。
 * @returns 取消订阅的函数。
 */
export declare function subscribeSessionChanges<S = unknown>(ctx: SessionEventContext, listener: (session: S) => void, probe?: () => PicoSessionProbe | undefined): () => void;
/** 会话代际守卫：一次同步的"我是不是最新"判定。 */
export interface SessionEpoch {
    /**
     * 开始一次会话派生的同步，返回本次的代号（单调递增）。
     *
     * **必须在同步入口、第一个 `await` 之前调用**：晚一步就可能把"已经过期的自己"
     * 当成最新的一代。
     * @returns 本次同步的代际号（调用方可直接闭包持有）。
     */
    begin(): number;
    /**
     * 本次同步是否仍是**最新**的那一次。
     *
     * 只在 `await` 之后调用：`false` ⇒ 期间已有更新的一次同步开始（登出、换服务端、
     * 换账号、重登），本次结果必须整份丢弃。
     * @param epoch - {@link begin} 返回的代际号。
     * @returns 仍是最新一代为 true。
     */
    isCurrent(epoch: number): boolean;
}
/**
 * 造一个代际守卫（每个插件实例一个，住在 `apply()` 作用域里）。
 *
 * ## 它解决什么
 *
 * 本仓有一整族「**会话派生的异步投影**」：会话一变就把服务端下发的东西写进本地
 * settings / 凭据 / 界面 / 更新状态。它们的形状都是「订阅会话 → `await` 一次远地
 * 往返 → 落地（写盘 / 发事件 / 改状态）」，而**订阅是并发的**：每次会话变化都直接
 * 调用一次，不串行、不带序号。于是"服务端 A 的响应慢、用户已登出并登录到服务端 B、
 * B 先回、A 后回"这条普通时序会让 A 的内容盖住 B 的。
 *
 * 已收口的消费方：
 *  - enterprise 的四条（`bootstrap` 的模型目录/搜索地址、`error-reporting` 的 Sentry
 *    DSN、`gateway-model` 的网关令牌与 baseURL、`channel-sync` 的品牌内容）——
 *    它们是第二十六轮 Z2-01，判据见 `enterprise/tests/session-epoch-wiring.spec.ts`；
 *  - desktop 的 `updates.ts`（清单检查 + 安装包下载）—— 第二十七轮 AA3-01。
 *
 * ## 规则（每个投影都必须照此写）
 *
 * 1. 入口**同步**取一次代际：`const epoch = epochs.begin()`（必须在第一个 await
 *    之前，否则"取代际"这一步自己就会被乱序）；
 * 2. **每个 `await` 之后**比对 `if (!epochs.isCurrent(epoch)) return` —— 不写盘、
 *    不发事件、不改状态；
 * 3. 被 await 的**被调方**如果自己也要在 await 之后改状态（enterprise 的 `initSentry`
 *    就是），就必须把「还算不算最新」当谓词**传进去**，而不是只在外层补一句比对。
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
 * 本函数**零依赖、零副作用**（不 import cordis、不读盘、不读环境），可以被任何
 * 宿主面安全引入。
 * @returns 代际守卫。
 */
export declare function createSessionEpoch(): SessionEpoch;
