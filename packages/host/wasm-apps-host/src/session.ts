/**
 * The minimum this plugin needs from the enterprise `picoSession` service, and
 * the session subscription it must use.
 *
 * **为什么不 import `@picoaide/dsh-enterprise/session-service`**（那里有现成的
 * `subscribeSession`）：新包在 `check-workspaces.mjs` 里以 `needs: []` 登记
 * （任务书附录 A 的构建期约束），跨包类型/值 import 会把构建顺序绑死。本文件
 * 因此只声明**结构最小面**（`getSession`/`isRestored`/`clear`），运行期经
 * `ctx.get('picoSession')` 探测 —— 与 `packages/host/browser/src/index.ts` 对
 * `picoSession` 的用法同形。
 *
 * `subscribePicoSession` 复刻 `session-service.ts` 的 `subscribeSession` 语义
 * （订阅 + 用 `isRestored()` 补发启动时那一次），**不是**裸 `ctx.on`：恢复型
 * 启动（重启后带着有效会话）下，`restore()` 在 SessionService 构造期就启动，
 * 首个事件经常在消费方订阅之前发完 —— 裸订阅会漏掉它，表现是"要等下次登录
 * 才生效"（本仓已记录两次同根因 bug）。
 *
 * 2026-09-24（R13）：那段顺序的实现已收口到零依赖叶子包
 * `@picoaide/dsh-host-locale/session-events` 的 `subscribeSessionChanges`（本包在
 * 构建图上游，不可能 import enterprise）。本模块只剩"会话归一化"这一半
 * （`readAppSession`：缺 serverURL/token 的持久化会话按未登录处理）。
 *
 * @module @picoaide/dsh-wasm-apps-host/session
 */

import type { Context } from '@deepseek-ai/cordis'
import { subscribeSessionChanges } from '@picoaide/dsh-host-locale/session-events'

/**
 * 员工会话变化事件（唯一实现在叶子包 `@picoaide/dsh-host-locale/session-events`；
 * 这里 re-export 供本包既有调用点使用，值与 enterprise `session-service.ts` 逐字相同）。
 */
export { SESSION_CHANGED_EVENT } from '@picoaide/dsh-host-locale/session-events'

/** 员工会话（本插件只消费这三项；其余字段由 enterprise 负责）。 */
export interface AppSession {
  readonly serverURL: string
  readonly token: string
  readonly username?: string
}

/**
 * `picoSession` 服务的最小结构面。
 *
 * 全部方法都可缺席（探测式）：缺席时本插件按"未登录"处理，绝不猜。
 */
export interface PicoSessionLike {
  getSession?: () => AppSession | null
  isRestored?: () => boolean
  isLoggedIn?: () => boolean
  clear?: () => void
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** 会话变化（登录/登出/恢复完成）；载荷形状不做承诺，见本模块头注释。 */
    'pico/session-changed'(session: { username?: string; token?: string; serverURL?: string } | null): void
    /** 桌面壳转发的深链；`<渠道 scheme>://app/<app_id>` 由本插件消费。 */
    'pico/deep-link'(url: string): void
  }
}

/**
 * 读取当前员工会话，并**校验可用于出站**（serverURL 与 token 都非空）。
 *
 * 一个字段残缺的持久化会话必须当作"未登录"：拿空 serverURL 拼出站 URL 会变成
 * 一个指向本机的相对请求，而空 token 会让平台的 401 分支被反复触发。
 * @param service - 探测到的 `picoSession`（可缺席）。
 * @returns 可用的会话，或 null。
 */
export function readAppSession(service: PicoSessionLike | undefined): AppSession | null {
  if (service === undefined || typeof service.getSession !== 'function') return null
  let session: AppSession | null
  try {
    session = service.getSession()
  } catch {
    return null
  }
  if (session === null || typeof session !== 'object') return null
  const serverURL = typeof session.serverURL === 'string' ? session.serverURL.trim() : ''
  const token = typeof session.token === 'string' ? session.token : ''
  if (serverURL === '' || token === '') return null
  return typeof session.username === 'string'
    ? { serverURL, token, username: session.username }
    : { serverURL, token }
}

/**
 * 订阅会话变化，并补发启动时那一次（见模块头注释）。
 *
 * 实现委托给叶子包 `subscribeSessionChanges`（唯一实现）：这里只把事件带来的会话过一遍
 * {@link readAppSession} 的归一化，并把 `probe` 交给调用方（本包的调用点用
 * `ctx.get('picoSession')`；测试可注入替身）。
 * @param ctx - Host 上下文（只需 `on`/`get`）。
 * @param resolve - 每次事件时探测当前 `picoSession`（launcher 可能晚装配）。
 * @param listener - 收到可用会话（或 null=未登录）时回调。
 * @returns 取消订阅的函数。
 */
export function subscribePicoSession(
  ctx: Pick<Context, 'on' | 'get'>,
  resolve: () => PicoSessionLike | undefined,
  listener: (session: AppSession | null) => void,
): () => void {
  return subscribeSessionChanges<unknown>(
    ctx,
    () => { listener(readAppSession(resolve())) },
    () => resolve(),
  )
}
