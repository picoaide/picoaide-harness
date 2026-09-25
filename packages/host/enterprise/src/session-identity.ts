/**
 * 「员工会话身份」的**唯一判据**（R15B-04，2026-09-25）。
 *
 * ## 为什么需要一个单独的身份口径
 *
 * 同一条会话变化在仓里有两个维度：**换服务端**（`loginServerSwitchConflict` /
 * `deep-link.ts` 的 `serverIdentity`，两者已经拦下并报 409）与**同服务端换账号**
 * （有意放行：改密/换人）。后者此前没有任何"身份变了"的信号 —— 唯一会重载窗口的
 * 注入脚本判据只有 `loggedIn === false`，于是已加载的应用页继续以**上一个账号的
 * 渲染状态**跑在新账号的令牌下（能力中心「我的」、应用中心目录、连接器卡片、
 * 定时任务清单、账号卡都还显示旧账号的行）。
 *
 * 判据只允许一份：`serverURL + username`。少比 `username` 会在换服务端时静默
 * 漏判，少比 `serverURL` 就是本缺陷本身。取值用 `JSON.stringify([...])` 而不是
 * 拼接分隔符：用户名里出现任何分隔符都不会造成两个不同身份取到同一个串。
 *
 * ## 消费方
 *
 * - 注入页面的看门狗脚本（auth-gate）：文档渲染时记下当时的身份，轮询发现变了就
 *   `location.reload()` —— **这是让四个整页面板与账号卡一起归零的唯一机制**
 *   （面板分属三个互不可 import 的 client bundle，各自抄一份轮询正是本仓反复
 *   出现的失效形态）；
 * - `/api/pico/auth/state` 的 `identity` 字段：任何未来想自己比较的消费方都用
 *   同一个值，不再各拼各的。
 *
 * 本模块只依赖 `Session` 的**类型**，是零副作用叶子（不 import cordis、不读盘）。
 * @module @picoaide/dsh-enterprise/session-identity
 */

import type { Session } from './server-connector/config.ts'

/** 一个会话身份的最小读取面（结构类型，便于测试替身与部分会话）。 */
export interface SessionIdentityInput {
  serverURL?: string | undefined
  username?: string | undefined
}

/**
 * 会话身份的稳定字符串（未登录 ⇒ 空串）。
 *
 * 空串是"没有身份"，与任何真实身份的取值都不同 —— 所以"登录 → 登出"与
 * "登录 → 换号"都能被同一次比较认出来。
 * @param session - 当前会话（允许 null / undefined / 部分字段）。
 * @returns 稳定可比较的身份串（未登录为空串）。
 */
export function sessionIdentity(session: Session | null | undefined): string {
  if (session === null || session === undefined) return ''
  const input = session as SessionIdentityInput
  return JSON.stringify([input.serverURL ?? '', input.username ?? ''])
}

/**
 * 两次会话身份是否不同（未登录与任何身份都算不同）。
 * @param before - 变化前的会话。
 * @param after - 变化后的会话。
 * @returns true 表示必须按"换了人"处理。
 */
export function sessionIdentityChanged(
  before: Session | null | undefined,
  after: Session | null | undefined,
): boolean {
  return sessionIdentity(before) !== sessionIdentity(after)
}
