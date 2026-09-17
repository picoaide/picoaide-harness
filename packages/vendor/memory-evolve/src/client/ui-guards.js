/**
 * 客户端视图的三个异步/生命周期护栏（2026-09-17 二审 ME-9 / ME-10 / ME-11）。
 *
 * 三者同源：视图里「后台动作」（轮询刷新、提示定时器、并发请求）抢走用户
 * 正在看的东西。逻辑放在无框架的纯 JS 模块里，便于用假元素/假调度器做
 * 行为断言（.tsx 里的逻辑没法在 node --test 下直接跑）。
 */

/** 认定「仍贴在底部」的容差（像素）：滚动位置离底部不超过它就算跟随。 */
export const SCROLL_FOLLOW_THRESHOLD_PX = 24

/**
 * ME-9：日志自动滚动必须带「用户是否还在底部」的闸门。
 * 旧写法每有新内容就无条件 `scrollTop = scrollHeight`，运行中任务每 2s
 * 轮询一次 ⇒ 用户上滚回读中段输出会被反复拽回底部（全屏弹窗同样）。
 */
export function createScrollFollow(threshold = SCROLL_FOLLOW_THRESHOLD_PX) {
  let following = true
  /**
   * @param {{ scrollTop: number, scrollHeight: number, clientHeight: number } | null} el
   * @returns {boolean} 当前位置是否仍贴底。
   */
  const nearBottom = (el) => {
    if (el === null || el === undefined) return true
    const height = Number(el.scrollHeight) || 0
    const top = Number(el.scrollTop) || 0
    const client = Number(el.clientHeight) || 0
    return height - top - client <= threshold
  }
  return {
    /**
     * 滚动事件：按用户当前位置更新跟随开关（上滚即停止跟随）。
     *
     * 未挂载/缺席的元素（null/undefined）必须**保持既有状态**：内联日志面板与
     * 全屏弹窗共用同一个 onScroll，弹窗关闭时 fullLogRef.current === null 且是
     * 最后一次调用 —— 旧写法把 null 当"未知元素 = 仍贴底"，于是内联面板的每次
     * 滚动都以下一个 following = true 收尾，上滚闸门整个失效（2026-09-17 三轮
     * 对抗复核 ME-9 残留：探测到 following=true、下一轮 2s 轮询把用户拽回底部）。
     */
    onScroll(el) {
      if (el === null || el === undefined) return
      following = nearBottom(el)
    },
    /**
     * 新内容到达：仅在仍跟随时才滚到底；返回是否真的滚动了
     * （false = 用户正在回读，保持其滚动位置）。
     */
    apply(el) {
      if (el === null || el === undefined) return false
      if (!following) return false
      el.scrollTop = el.scrollHeight
      return true
    },
    /** 切换会话/任务时重置为跟随（新日志从底部跟起）。 */
    reset() {
      following = true
    },
    following: () => following,
  }
}

/**
 * ME-10：单一提示位（notice）的定时清理。
 * 旧写法每次 showNotice 都新开一个 4s 定时器且不跟踪：先触发的提示留下的
 * 定时器到点后无条件清空**当前**提示位，把 4s 内后到的第二条提示提前抹掉
 * （第二条刚出现就消失）；定时器也从不在卸载时清理。
 *
 * @param {(text: string | null) => void} apply 写入提示位（null = 清除）。
 * @param {{ delayMs?: number, schedule?: Function, cancel?: Function }} [opts]
 *   schedule/cancel 可注入（测试用假调度器；默认 setTimeout/clearTimeout）。
 */
export function createNoticeTimer(apply, opts = {}) {
  const delayMs = opts.delayMs ?? 4000
  const schedule = opts.schedule ?? setTimeout
  const cancel = opts.cancel ?? clearTimeout
  let timer
  return {
    /** 显示新提示：重置计时（旧定时器作废，绝不会清掉新提示）。 */
    show(text) {
      if (timer !== undefined) cancel(timer)
      apply(text)
      timer = schedule(() => {
        timer = undefined
        apply(null)
      }, delayMs)
    },
    /** 卸载/切换时清理挂起的定时器（避免卸载后 setState）。 */
    dispose() {
      if (timer === undefined) return
      cancel(timer)
      timer = undefined
    },
    pending: () => timer !== undefined,
  }
}

/**
 * ME-11：并发请求的「只认最新」序号闸门。
 * 旧写法让搜索/翻页请求与 3s 轮询共用无守卫的 setState：旧请求后返回就会
 * 覆盖新筛选结果（搜索框里是 'fix'，列表却是未过滤的），最长 3s 后才被
 * 下一次轮询纠正。
 */
export function createLatestOnly() {
  let seq = 0
  return {
    /**
     * 开一次请求，返回「这次请求是否仍是最新」的判定函数。
     * @returns {() => boolean} true = 仍是最新（可以落地）；false = 已被更
     *   新的请求取代（丢弃结果，且不要动任何 state）。
     */
    begin() {
      seq += 1
      const token = seq
      return () => token === seq
    },
    /** 作废所有在飞请求（卸载/换会话用）。 */
    invalidate() {
      seq += 1
    },
    current: () => seq,
  }
}
