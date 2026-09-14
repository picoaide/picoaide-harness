/**
 * 2026-09-15 恢复型启动 P0 的回归：票据交接表**不能因为 fence 暂时缺席就一次判死**。
 *
 * 现场（客户 v2.7.4-beta.3，win32）：开机即带着有效会话（恢复型启动）时，
 * `startCookieHandoff()` 在插件装载那一刻看到 `ctx.get('connection')` 还是
 * undefined 就直接 return —— 本插件的 loader 行早于 connection 行，而恢复型启动
 * 下两个本地页面在 boot prewarm 就加载完、又没有任何 `pico/session-changed` 事件
 * 兜底 ⇒ 交接一次都没跑过：蒙版页（「我来操作」唯一入口）永远拿不到持有性证明，
 * 整轮运行每次点击都 401（日志里只有 refuse、没有 handoff）。
 *
 * 本文件用注入的假调度器把状态机钉死：缺席要排队、就绪要交、成功要停、出错要重试。
 */
import { describe, expect, it, vi } from 'vitest'
import { CookieHandoff } from '../src/cookie-handoff.ts'

interface ScheduledRun {
  run: () => void
  delayMs: number
  cancelled: boolean
}

/** 确定性调度器：不真等时间，由测试显式"推进"一次排队的尝试。 */
function harness(options: {
  fence?: boolean
  /** 依次返回的交接结果（最后一个会被重复使用）。 */
  results?: Array<boolean | Error>
  fenceAfterAttempts?: number
} = {}): {
  handoff: CookieHandoff
  mirror: ReturnType<typeof vi.fn>
  warn: ReturnType<typeof vi.fn>
  queue: ScheduledRun[]
  /** 当前已排队但**未取消**的尝试数。 */
  queued: () => number
  /** 当前排队中那一次的退避延迟。 */
  pendingDelay: () => number | undefined
  /** 推进：执行最后一次排队的尝试（真实宿主里由定时器触发）。 */
  fire: () => void
  setFence: (value: boolean) => void
} {
  let fenceAvailable = options.fence ?? false
  const results = [...(options.results ?? [true])]
  const queue: ScheduledRun[] = []
  const mirror = vi.fn(async () => {
    const next = results.length > 1 ? (results.shift() as boolean | Error) : (results[0] as boolean | Error)
    if (next instanceof Error) throw next
    return next
  })
  const warn = vi.fn()
  const attemptsBeforeFence = options.fenceAfterAttempts
  let attempts = 0
  const handoff = new CookieHandoff({
    fenceAvailable: () => {
      if (attemptsBeforeFence !== undefined && attempts >= attemptsBeforeFence) return true
      return fenceAvailable
    },
    mirror,
    schedule: (run, delayMs) => {
      const entry: ScheduledRun = { run, delayMs, cancelled: false }
      queue.push(entry)
      return entry
    },
    cancel: (handle) => { (handle as ScheduledRun).cancelled = true },
    warn,
  })
  return {
    handoff,
    mirror,
    warn,
    queue,
    queued: () => queue.filter((entry) => !entry.cancelled).length,
    pendingDelay: () => queue.filter((entry) => !entry.cancelled).at(-1)?.delayMs,
    fire: () => {
      const pending = queue.filter((candidate) => !candidate.cancelled)
      const entry = pending[pending.length - 1]
      if (entry === undefined) throw new Error('no queued attempt to fire')
      // 触发即出队（真实宿主里定时器只响一次）
      queue.splice(queue.indexOf(entry), 1)
      attempts += 1
      entry.run()
    },
    setFence: (value: boolean) => { fenceAvailable = value },
  }
}

const tick = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve) })

describe('CookieHandoff — BrowserAuth 票据交接表', () => {
  it('fence 还没装载完（connection 行晚于本行）时保持排队，就绪后立刻交接', async () => {
    const h = harness({ fence: false, results: [true] })
    h.handoff.start()

    // 首次尝试：fence 缺席 ⇒ 不交接、但要排队（旧实现就是在这里 return 掉的）
    expect(h.mirror).not.toHaveBeenCalled()
    expect(h.queued()).toBe(1)
    expect(h.handoff.pending).toBe(true)

    // 再推进一次仍未就绪：继续排队（而不是放弃）
    h.fire()
    await tick()
    expect(h.mirror).not.toHaveBeenCalled()
    expect(h.queued()).toBe(1)

    // connection 行装载完 ⇒ 下一次尝试交接成功
    h.setFence(true)
    h.fire()
    await tick()
    expect(h.mirror).toHaveBeenCalledTimes(1)
    expect(h.handoff.pending).toBe(false)
    expect(h.queued()).toBe(0)
  })

  it('交接成功一次即停表（分区里已经有本 authority 的签名 cookie）', async () => {
    const h = harness({ fence: true, results: [true] })
    h.handoff.start()
    await tick()
    expect(h.mirror).toHaveBeenCalledTimes(1)
    expect(h.handoff.pending).toBe(false)
    expect(h.queued()).toBe(0)
  })

  it('交接未成功（分区里还没票）时按退避重试，延迟翻倍且封顶', async () => {
    const h = harness({ fence: true, results: [false, false, false, true] })
    h.handoff.start()
    await tick()
    expect(h.mirror).toHaveBeenCalledTimes(1)
    expect(h.pendingDelay()).toBe(2000)
    h.fire()
    await tick()
    expect(h.pendingDelay()).toBe(4000)
    h.fire()
    await tick()
    expect(h.pendingDelay()).toBe(8000)
    h.fire()
    await tick()
    // 第四次返回 true ⇒ 停表
    expect(h.mirror).toHaveBeenCalledTimes(4)
    expect(h.handoff.pending).toBe(false)
  })

  it('交接抛错时告警并继续重试（不把票据问题升级成插件失败）', async () => {
    const h = harness({ fence: true, results: [new Error('cookie store unavailable'), true] })
    h.handoff.start()
    await tick()
    expect(h.warn).toHaveBeenCalledWith('pico-browser: browser-auth cookie handoff failed', expect.any(Error))
    expect(h.queued()).toBe(1)
    h.fire()
    await tick()
    expect(h.mirror).toHaveBeenCalledTimes(2)
    expect(h.handoff.pending).toBe(false)
  })

  it('stop() 取消排队中的尝试，且取消后不再交接（插件卸载 / 切用户）', async () => {
    const h = harness({ fence: true, results: [false, true] })
    h.handoff.start()
    await tick()
    expect(h.queued()).toBe(1)
    h.handoff.stop()
    expect(h.handoff.pending).toBe(false)
    expect(h.queued()).toBe(0)
    expect(h.mirror).toHaveBeenCalledTimes(1)
  })

  it('start() 幂等：重启表会取消上一次排队（登录切换 / 清数据后再交一次）', async () => {
    const h = harness({ fence: true, results: [false, false, true] })
    h.handoff.start()
    await tick()
    h.handoff.start()
    await tick()
    expect(h.mirror).toHaveBeenCalledTimes(2)
    expect(h.queued()).toBe(1)
    // 只有最后一次 start 排的那一次还在表上
    h.fire()
    await tick()
    expect(h.handoff.pending).toBe(false)
  })
})
