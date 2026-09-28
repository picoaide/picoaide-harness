/**
 * 「会话代际」判据（第二十六轮审计 Z2-01，P1）—— **实现在叶子包里**。
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
 * ## 为什么本文件只剩一行 re-export（2026-09-27 改动）
 *
 * 第二十七轮 AA3-01 发现**同一族的第二个消费方在 desktop 包**：
 * `packages/host/desktop/src/updates.ts` 的两条异步投影（清单检查、安装包下载）
 * 在完成路径上只看 `disposed`、不看会话身份，于是上一台服务端/上一个渠道的安装包
 * 会在当前会话里被标成"可安装"并被平台安装器拉起。
 *
 * 而 desktop **不可能** import 本文件：构建图是
 * `叶子包 → connectors → browser → wasm-apps-host → desktop → enterprise`（本包的
 * `deps` 里有 `dsh-plugin-desktop`）⇒ 反向 import 会成环（见
 * `docs/decisions/2026-09-20-host-leaf-packages-build-graph.md`）。正解是把**原语下沉到
 * 零依赖叶子包**（与 2026-09-23 的 `loopback.ts` 四份合一、2026-09-24 的
 * `session-events.ts` 三份合一同一手法），而不是在 desktop 里复制一份。
 *
 * 所以 `SessionEpoch` / `createSessionEpoch` 的**实现**落在
 * `@picoaide/dsh-host-locale/session-events`（与本包同族、同一个构建图理由；
 * 那里的 JSDoc 保留了完整的"规则 1/2/3"与"为什么用计数而不是令牌"两节）。本文件
 * 继续作为本包的**语义入口**存在，导出面与语义**一字不改** —— `bootstrap.ts` /
 * `error-reporting.ts` / `gateway-model.ts` / `channel-sync.ts` 四个调用点的
 * `import { createSessionEpoch } from './session-epoch.ts'` 原样不动。
 *
 * @module @picoaide/dsh-enterprise/session-epoch
 */

export { createSessionEpoch, type SessionEpoch } from '@picoaide/dsh-host-locale/session-events'
