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
import type { Session } from '@picoaide/dsh-gateway-client/config'

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
  /**
   * 只清"发起这次请求时的那一个会话"（R22-V1-N3：迟到的 401 不得清掉新登录）。
   *
   * 2026-10-13（P0-b）：应用面的编排与工具原本直接写 `ctx.picoSession…`（那时它们
   * 住在 `@picoaide/dsh-enterprise` 里，服务由同一个包提供）。搬进本包后不能再依赖
   * provider 的 `declare module`，改回本模块既有的**结构探测**读法
   * （{@link picoSessionOf}）。
   */
  clearIfCurrent?: (token: string) => void
}

/**
 * 应用面（本机路由编排 + `wasm_app_*` 工具）需要的会话服务**读写面**。
 *
 * 返回的是 `@picoaide/dsh-gateway-client/config` 的 `Session`（而不是上面的
 * `AppSession`）：应用的写面要判 `role === 'auditor'`、并把会话原样交给编排，
 * 那几个字段必须可见。
 */
export interface PicoSessionHostFace {
  getSession: () => Session | null
  /**
   * 只清"发起这次调用时的那一个会话"（迟到 401 不得清掉新登录；R22-V1-N3）。
   *
   * 可选：探测面**只以 `getSession` 为必需**（读面与写面是两条独立能力，最小组合/
   * 夹具可以只提供读面），缺席时出站路径的 401 分支不清会话 —— 与
   * `PicoSessionLike` 里那批可选方法同一口径。
   */
  clearIfCurrent?: (token: string) => void
}

/**
 * 探测 `picoSession` 的读写面。
 *
 * 服务缺席或形状不符时返回 null，调用方按"未登录"处理（绝不猜）—— 与
 * {@link readAppSession} 同一口径。
 * @param ctx - Cordis 上下文。
 * @returns 结构面，或不可用时的 null。
 */
export function picoSessionOf(ctx: Context): PicoSessionHostFace | null {
  // 结构探测而不是必需依赖：最小组合（单测、无头嵌入）里 `get` 可能整个缺席 ——
  // 那时按"没有会话服务"处理（调用方回 AUTH_REQUIRED），与 `readAppSession` 同口径。
  const probe = (typeof ctx.get === 'function' ? ctx.get('picoSession') : undefined) as Partial<PicoSessionHostFace> | undefined
  if (typeof probe?.getSession !== 'function') return null
  const face: PicoSessionHostFace = { getSession: probe.getSession.bind(probe) }
  if (typeof probe.clearIfCurrent === 'function') face.clearIfCurrent = probe.clearIfCurrent.bind(probe)
  return face
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
