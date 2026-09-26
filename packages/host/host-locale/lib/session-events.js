//#region src/session-events.ts
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
const SESSION_CHANGED_EVENT = "pico/session-changed";
/** `picoSession` 服务的注册名（`SessionService` 的 `super(ctx, 'picoSession')`）。 */
const PICO_SESSION_SERVICE = "picoSession";
/**
* 探测当前会话服务（两种上下文形态都认，见 {@link SessionEventContext}）。
*
* **顺序有讲究**：有 `get` 就只用它 —— 真实 Cordis 上下文在服务尚未注册时读属性
* （`ctx.picoSession`）不是"返回 undefined"那么无害，而 `get` 明确返回 undefined。
* 只有在 `get` 整个缺席（结构替身）时才回落到属性面。
* @param ctx - 上下文。
* @returns 会话服务（或缺席）。
*/
function probeSession(ctx) {
	if (typeof ctx.get === "function") return ctx.get(PICO_SESSION_SERVICE);
	return ctx.picoSession;
}
/**
* 订阅会话变化，并补发"已经恢复完成"的那一次状态（见模块头注释）。
*
* 补发规则（三条，与历史三份拷贝逐条对齐）：
*
*  - 探测到的服务**已完成恢复**（`isRestored() === true`）⇒ 立即用当前会话回调一次；
*  - 服务**不存在**或没有 `isRestored`（纯桌面冒烟、还没装配 enterprise 面）⇒ 也回调一次
*    并给出 `undefined`/"未登录" —— 消费方必须知道"现在没有会话"，而不是永远等一个
*    不会来的事件；
*  - 否则（恢复仍在飞行）⇒ **不**回调：那次事件还没发，订阅已经就位。
*
* @param ctx - 上下文（只需 `on`，外加 `get` 或 `picoSession` 之一）。
* @param listener - 收到会话（或未登录状态）时的回调。**必须幂等**：它可能被立即调用一次。
* @param probe - 探测 `picoSession`（缺省 = {@link probeSession}；wasm-apps-host 用它注入
*   自己的归一化读取）。
* @returns 取消订阅的函数。
*/
function subscribeSessionChanges(ctx, listener, probe = () => probeSession(ctx)) {
	const off = ctx.on(SESSION_CHANGED_EVENT, listener);
	const service = probe();
	if (service?.isRestored === void 0 || service.isRestored()) listener(service?.getSession?.());
	return off;
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
function createSessionEpoch() {
	let current = 0;
	return {
		begin: () => {
			current += 1;
			return current;
		},
		isCurrent: (epoch) => epoch === current
	};
}
//#endregion
export { PICO_SESSION_SERVICE, SESSION_CHANGED_EVENT, createSessionEpoch, subscribeSessionChanges };

//# sourceMappingURL=session-events.js.map