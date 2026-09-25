/**
 * 页面加载级消费者：「未登录时记住这次打开」在**新文档的第一跳**兑现（§19 Q4 / §7.6）。
 *
 * ## 为什么消费点必须在这里（R16B-03）
 *
 * 这个意图的两端原本都在面板里（写：目录行的「打开」；读：面板挂载 effect），而
 * `@picoaide/dsh-panel-surface` 在**非激活**态把面板渲染成 `null` —— 组件不存在，
 * 它的挂载 effect 自然不会跑。客户端登录又走**整文档导航**（`auth-gate` 登录成功后
 * `location.replace('/')`）⇒ "登录成功"那一刻没有任何代码去读那个意图。它于是活到
 * 用户**下一次**打开应用中心才被兑现：用户当初点的"登录后自动打开"没有发生，而一次
 * **与它无关**地打开应用中心会自己弹出一个应用窗口。
 *
 * 所以消费点要站在"每个文档加载都跑"的那一跳上：`mountAppCenterPanel()` 由
 * `index.ts` 的 `ctx.effect` 在**插件 apply 时**调用一次（＝每个文档加载一次），
 * 装载时调这里一次。
 *
 * ## 三条不变量
 *
 * 1. **页面加载即消费**：有意图 + 已登录 ⇒ 立刻走 `openAppEntry`（与面板里**同一份**
 *    打开实现，不复制请求逻辑），不等用户点开应用中心。
 * 2. **至多一次**：开窗前必须**原子认领**（`claimOpenIntent` = 读 + 删之间没有
 *    `await`）。认领失败 = 另一个消费者先拿走了 ⇒ **什么都不做**。这条同时罩住面板
 *    挂载兜底那条路径 —— "先清后开"只保证下次读不到，不保证两个**已读到**的消费者
 *    只有一个开窗，所以两边都必须走认领（见 `open-intent.ts` 的约定注释）。
 * 3. **未登录不丢意图**：登录态取数失败/未登录 ⇒ **原样留着**，一条都不清。宿主那一跳
 *    登录完成后是**新的文档加载**，本函数会再跑一次；面板激活后的既有轮询路径继续兜底。
 *
 * ## 失败要有痕迹（静默是缺陷）
 *
 * 面板里失败有错误块可渲染（`pendingOpenFailure`），页面加载这一跳**没有面板可渲染**，
 * 所以至少打一条可检索的 `console.warn`（前缀 `[open-intent]`，带 `reason` 与诊断
 * 信息），便于在客户机日志里定位"我登录了但它没开"。失败**不**把意图写回去：写回去
 * 会让一次持续性失败（应用已删/协议未就绪）在每次页面加载时重试，与面板里
 * `continuePendingOpen` 的"失败就清掉意图（不循环）"同口径。
 *
 * @module @picoaide/dsh-wasm-apps/client/open-intent-resume
 */

import { loadAppAiIdentity } from './app-ai.ts'
import { openAppEntry, type OpenFailure, type OpenResult } from './open-app.ts'
import { claimOpenIntent, readOpenIntent, type OpenIntentStore } from './open-intent.ts'

/** 本模块告警文案的前缀（可检索：客户机日志里 grep 它）。 */
export const OPEN_INTENT_WARN_PREFIX = '[open-intent]'

/** {@link resumeOpenIntent} 的可注入依赖（缺省 = 生产实现；测试/探针注入假实现）。 */
export interface OpenIntentResumeDeps {
  /** 意图存储（缺省 `sessionStorage`，与写意图的那一侧同一份）。 */
  store?: OpenIntentStore | null
  /** 登录态取数（缺省读本机 `/api/pico/auth/state`；非空用户名 = 已登录）。 */
  loginStateLoader?: () => Promise<boolean>
  /** 打开动作（缺省 {@link openAppEntry}；测试注入假实现用）。 */
  open?: (appId: string) => Promise<OpenResult>
  /** 当前时间（TTL 判定；测试注入）。 */
  now?: () => number
}

/** {@link resumeOpenIntent} 的结果（机器可读；用例与探针据此分派，不匹配文案）。 */
export type OpenIntentResumeOutcome =
  /** 没有待继续的打开（含已过期 —— `readOpenIntent` 顺手清掉了）。 */
  | { kind: 'idle' }
  /** 有意图但**未登录**（含登录态取数失败）⇒ 意图原样留着。 */
  | { kind: 'deferred', appId: string }
  /** 已登录并真的开了窗。 */
  | { kind: 'opened', appId: string }
  /** 已登录、认领成功，但打开失败（痕迹见 `console.warn`）。 */
  | { kind: 'failed', appId: string, failure: OpenFailure }

/**
 * 缺省登录态取数：复用应用 AI 的身份解析（`/api/pico/auth/state`，非空用户名 = 已登录）。
 *
 * 与 `AppCenterPanel.loadLoginState` 的缺省实现**逐字同口径** —— 两处必须一致，否则
 * "面板认为已登录、页面加载这一跳认为没有"会让同一个意图时而兑现时而不兑现。
 * @returns 是否已登录。
 */
async function defaultLoginState(): Promise<boolean> {
  return (await loadAppAiIdentity()) !== ''
}

/**
 * 打一条可检索的失败告警（页面加载这一跳没有面板可渲染，这是唯一的痕迹）。
 * @param appId - 待继续的 app_id。
 * @param failure - {@link openAppEntry} 的失败结果。
 */
function warnResumeFailure(appId: string, failure: OpenFailure): void {
  console.warn(`${OPEN_INTENT_WARN_PREFIX} could not resume the remembered open of ${JSON.stringify(appId)} (${failure.reason}): ${failure.error}`)
}

/**
 * 兑现一次"待继续的打开"（**页面加载时调用一次**）。
 *
 * 本函数**不抛**：登录态取数失败按未登录处理（不确定就不开窗），打开动作的失败是
 * 结构化结果（`openAppEntry` 自己不抛；注入实现抛了也在这里收成一个 `failed`）。
 * @param deps - 可注入依赖（缺省 = 生产实现）。
 * @returns 结构化结果（见 {@link OpenIntentResumeOutcome}）。
 */
export async function resumeOpenIntent(deps: OpenIntentResumeDeps = {}): Promise<OpenIntentResumeOutcome> {
  // `store`/`now` 的三态（未传 / null / 值）必须原样透传：未传 = 缺省存储（sessionStorage），
  // null = "这个宿主没有存储"（读不到也不用读）。
  const storeOption = deps.store === undefined ? {} : { store: deps.store }
  const nowOption = deps.now === undefined ? {} : { now: deps.now() }
  const intent = readOpenIntent({ ...storeOption, ...nowOption })
  if (intent === null) return { kind: 'idle' }

  let loggedIn: boolean
  try {
    loggedIn = await (deps.loginStateLoader ?? defaultLoginState)()
  } catch {
    // 取数本身出错（网络/解析）＝拿不到登录态 ⇒ 按**未登录**处理：宁可让用户再点一次，
    // 也不在一个不确定的会话上开窗（与面板里那条 loadLoginState 同判据）。
    loggedIn = false
  }
  if (!loggedIn) return { kind: 'deferred', appId: intent.appId }

  // 原子认领（读 + 删之间没有 await）：另一个消费者（面板挂载兜底）可能在这之前
  // 已经把它拿走了 —— 那时这里必须停手，否则同一个意图会开两次窗。
  const claimed = claimOpenIntent({ ...storeOption, ...nowOption })
  if (claimed === null) return { kind: 'idle' }

  const open = deps.open ?? ((appId: string): Promise<OpenResult> => openAppEntry(appId))
  let result: OpenResult
  try {
    result = await open(claimed.appId)
  } catch (cause) {
    const failure: OpenFailure = {
      ok: false,
      reason: 'host-unreachable',
      error: `the open action threw: ${cause instanceof Error ? cause.message : String(cause)}`,
      status: null,
    }
    warnResumeFailure(claimed.appId, failure)
    return { kind: 'failed', appId: claimed.appId, failure }
  }
  if (!result.ok) {
    warnResumeFailure(claimed.appId, result)
    return { kind: 'failed', appId: claimed.appId, failure: result }
  }
  return { kind: 'opened', appId: claimed.appId }
}
