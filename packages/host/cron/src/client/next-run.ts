/**
 * 「下次运行」的呈现口径（R5-B-6）。
 *
 * 事实：`nextRunAt` 是**绝对时刻**，而 cron 表达式是**墙钟**语义（「0 9 * * *」
 * 说的是本机 09:00）。系统时区一变，两者就不再指同一件事 —— 2026-09-23 的复现：
 * 在上海建的任务存下 `2026-09-24 09:00 (+08)`，把机器时区换成纽约后，同一个绝对
 * 时刻是本地的 **21:00**，于是「每天 09:00」在 21:00 跑一次，而面板上"下次运行"
 * 与旁边的表达式自相矛盾。
 *
 * 两半都必须修，且判据只能有一份：
 *  - **宿主**（`host-ledger.ts` 的 `realignTimeZone`，由 `host-scheduler` 的 tick 调用）
 *    把**将来**的 `nextRunAt` 按当前时区重排 —— 触发点回到表达式要求的墙钟；
 *  - **面板**（本模块）按本机时区**重算**显示，而不是照抄那个可能过期的绝对时刻。
 *
 * 本模块是纯函数（无 React、无 IPC）：宿主与面板共用 `cron.ts` 的 `nextRunAtMs`
 * 与 `currentTimeZone`，所以"重算"这件事没有第二份实现。
 *
 * ---- 判据 ----
 * 一个没有改过时区的系统里，重算结果与存下来的时刻**逐毫秒相同**（表达式与时区都没变），
 * 于是 `drift === false`、"下次运行"就是宿主排的那一刻；时区变过时，存下来的时刻在当前
 * 时区下**不再是该表达式的一次触发点**，此时：
 *  - 显示改成重算值（"按本机时区下一次触发时刻"）；
 *  - `drift === true`，面板据此说明"宿主记录的时区与本机不同，宿主会在下一次 tick 对齐"。
 *
 * 判据用「`nextRunAtMs(cron, stored - 1min) === stored`」而不是"两者不相等"：错过的触发
 * （到期未跑、等宿主补记）同样会与重算值不等，那是 `missed` 那条既有故事，不是时区问题 ——
 * 到期时刻本身仍然是表达式的一次触发点，所以这里返回 `drift === false`。
 */
import { currentTimeZone, nextRunAtMs } from '../cron.ts'
import type { JobRecord } from '../jobs.ts'

/** cron 的最小粒度（一分钟）：用于"这个时刻是不是一次触发点"的判定。 */
export const CRON_MINUTE_MS = 60_000

export { currentTimeZone }

/** 面板要显示的下次运行（{@link displayNextRun} 的返回值）。 */
export interface NextRunDisplay {
  /** 要显示的时刻（ms epoch）；`undefined` = 没排上（未调度 / 表达式当前扫不到）。 */
  at: number | undefined
  /**
   * 宿主存下来的 `nextRunAt` 在当前时区**不是**该表达式的一次触发点 ⇒
   * 系统时区变过（宿主还没重排）。UI 据此给一句说明，而不是默默显示一个
   * 与表达式矛盾的时刻。
   */
  timeZoneDrift: boolean
}

/**
 * 一个绝对时刻在当前时区下是不是该表达式的一次触发点（分钟粒度）。
 *
 * 复用 `nextRunAtMs`（唯一实现）：它返回**严格晚于**下界的第一个匹配时刻，所以
 * 「从 `at - 1min` 出发的下一个匹配 == at」等价于「at 的墙钟满足表达式」。
 * @param cron - 5 字段表达式。
 * @param at - 绝对时刻（ledger 写入的都是整分钟）。
 * @returns 是 ⇒ true。
 */
function isOccurrenceOf(cron: string, at: number): boolean {
  if (at % CRON_MINUTE_MS !== 0) return false
  return nextRunAtMs(cron, at - CRON_MINUTE_MS) === at
}

/**
 * 面板该显示的下次运行时刻（**唯一判定**）。
 *
 * 停用任务不重算也不标漂移：它的 `nextRunAt` 是历史值，下一次根本不会跑。
 * @param job - 任务记录（只需要 enabled / cron / nextRunAt）。
 * @param now - 当前时刻（ms epoch；注入以便测试不需要假定时器）。
 * @returns 显示时刻 + 是否处于"宿主时区与本机不一致"的状态。
 */
export function displayNextRun(
  job: Pick<JobRecord, 'enabled' | 'cron' | 'nextRunAt'>,
  now: number,
): NextRunDisplay {
  const stored = job.nextRunAt
  if (!job.enabled) return { at: stored, timeZoneDrift: false }
  if (stored === undefined) return { at: nextRunAtMs(job.cron, now), timeZoneDrift: false }
  if (isOccurrenceOf(job.cron, stored)) return { at: stored, timeZoneDrift: false }
  return { at: nextRunAtMs(job.cron, now), timeZoneDrift: true }
}

/**
 * 一组任务里最早的下次运行（面板顶部的统计格用）。
 * @param jobs - 任务清单。
 * @param now - 当前时刻。
 * @returns 最早时刻；一个都排不上时 `undefined`。
 */
export function soonestNextRun(
  jobs: readonly Pick<JobRecord, 'enabled' | 'cron' | 'nextRunAt'>[],
  now: number,
): number | undefined {
  let soonest: number | undefined
  for (const job of jobs) {
    // 停用任务不进统计：它的 nextRunAt 是历史值（`displayNextRun` 原样返回），
    // 拿它当"最早的下次运行"会把一个不会再跑的过去时刻报成未来 —— 统计格与
    // 卡片因此说法不一致。
    if (!job.enabled) continue
    const { at } = displayNextRun(job, now)
    if (at === undefined) continue
    if (soonest === undefined || at < soonest) soonest = at
  }
  return soonest
}

/**
 * 宿主的时区与本机当前时区是否不一致（面板据此给"宿主尚未对齐"的说明）。
 *
 * 宿主每次 tick 都会用 {@link currentTimeZone} 对齐自己（见 `realignTimeZone`），
 * 所以这个状态正常情况下最多持续一个 tick（30s）；宿主进程没在跑（桌面客户端关闭、
 * 只有页面在）时会一直为真 —— 那正是需要如实告诉用户的场景。
 * @param scheduler - 快照里的 scheduler 段（只需要 timeZone）。
 * @returns 不一致 ⇒ true。
 */
export function hostTimeZoneDrift(scheduler: Pick<{ timeZone: string }, 'timeZone'>): boolean {
  return scheduler.timeZone !== currentTimeZone()
}
