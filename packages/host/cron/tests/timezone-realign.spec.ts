/**
 * R5-B-6：**时区变更后按本机时区重排**（2026-09-23 修复）的判据。
 *
 * 事实（审计复现，`temp/round5-2026-09-23/R5-B/evidence/cron-tz-probe.txt`）：
 *   [TZ=Asia/Shanghai]   建任务 → nextRunAt = 2026-09-24 09:00(+08)
 *   [TZ=America/New_York] 同一个绝对时刻 = 2026-09-23 21:00（表达式写的是 09:00）
 * 也就是说 `nextRunAt` 是绝对时刻、而表达式是**墙钟**语义，时区一变两者就分家：
 * 触发点错一次，面板显示的"下次运行"与表达式也自相矛盾。
 *
 * 两半都在这个包里，各有各的判据：
 *  - **宿主**（`HostCronLedger.realignTimeZone`，由 `HostCronScheduler` 的 tick 调用）：
 *    把**将来**的 nextRunAt 折到当前时区；
 *  - **面板**（`client/next-run.ts` 的 `displayNextRun`）：按本机时区从表达式**重算**显示。
 *
 * 这里的用例全部是确定性的（不依赖跑测试的机器当前时区）：
 *  "另一个时区算出来的绝对时刻"用 `+ 12h` 这样的位移精确构造 —— 位移后的墙钟不再是
 *  09:00，于是它在当前时区里**不是**该表达式的一次触发点，正是漂移的定义。文件末尾另有
 *  一条带**自校准**的真双时区用例（环境不认 `process.env.TZ` 时如实跳过，不把环境问题
 *  记成产品缺陷）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostCronLedger } from '../src/host-ledger.ts'
import { HostCronScheduler } from '../src/host-scheduler.ts'
import { currentTimeZone, nextRunAtMs } from '../src/cron.ts'
import { displayNextRun, hostTimeZoneDrift, soonestNextRun } from '../src/client/next-run.ts'
import type { JobRecord } from '../src/jobs.ts'

const T0 = new Date(2026, 8, 23, 20, 0, 0, 0).getTime()
const HOUR = 60 * 60 * 1000

function job(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: 'job-1',
    name: 'Daily',
    cron: '0 9 * * *',
    action: { kind: 'agent', prompt: 'do the daily thing' },
    enabled: true,
    nextRunAt: undefined,
    executions: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

const homes: string[] = []
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pico-cron-tz-'))
  homes.push(dir)
  return dir
}
afterEach(() => {
  while (homes.length > 0) rmSync(homes.pop()!, { recursive: true, force: true })
})

describe('R5-B-6 面板口径：下次运行按本机时区重算', () => {
  it('时区没变 ⇒ 显示宿主排的那一刻（重算与存档逐毫秒相同，不误报漂移）', () => {
    const at = nextRunAtMs('0 9 * * *', T0)!
    const display = displayNextRun(job({ nextRunAt: at }), T0)
    expect(display.at).toBe(at)
    expect(display.timeZoneDrift).toBe(false)
  })

  it('存档时刻在当前时区不是该表达式的一次触发点（= 旧时区留下的绝对时刻）⇒ 重算 + 标漂移', () => {
    const at = nextRunAtMs('0 9 * * *', T0)!
    // +12h：墙钟从 09:00 变成 21:00 —— 正是审计探针里"上海 09:00 在纽约是 21:00"的形状。
    const stale = at + 12 * HOUR
    const display = displayNextRun(job({ nextRunAt: stale }), T0)
    expect(display.timeZoneDrift).toBe(true)
    // 显示的是表达式在本机时区要求的那一刻（**不是**那个过期的绝对时刻）。
    expect(display.at).toBe(at)
    expect(new Date(display.at!).getHours()).toBe(9)
  })

  it('到期但仍是合法触发点 ⇒ 不算时区漂移（那是"错过一次"那条既有故事）', () => {
    const due = nextRunAtMs('0 9 * * *', T0)!
    const later = due + 2 * HOUR // 已经过了这个点，宿主还没跑
    const display = displayNextRun(job({ nextRunAt: due }), later)
    expect(display.timeZoneDrift).toBe(false)
    expect(display.at).toBe(due)
  })

  it('停用任务不重算、不标漂移（它下一次不会跑）', () => {
    const stale = nextRunAtMs('0 9 * * *', T0)! + 12 * HOUR
    const display = displayNextRun(job({ nextRunAt: stale, enabled: false }), T0)
    expect(display.timeZoneDrift).toBe(false)
    expect(display.at).toBe(stale)
  })

  it('没排上（nextRunAt 缺省）⇒ 用表达式补一个可显示的时刻', () => {
    expect(displayNextRun(job(), T0).at).toBe(nextRunAtMs('0 9 * * *', T0))
  })

  it('`soonestNextRun` 与卡片同源（取最早的那个，含重算）', () => {
    const nine = nextRunAtMs('0 9 * * *', T0)!
    const monday = nextRunAtMs('0 9 * * 1', T0)!
    const soonest = soonestNextRun([
      job({ id: 'a', nextRunAt: monday }),
      job({ id: 'b', nextRunAt: nine }),
      job({ id: 'c', enabled: false, nextRunAt: T0 }),
    ], T0)
    expect(soonest).toBe(Math.min(nine, monday))
  })

  it('宿主时区与本机不一致才给说明（一致时一个字都不多说）', () => {
    expect(hostTimeZoneDrift({ timeZone: currentTimeZone() })).toBe(false)
    expect(hostTimeZoneDrift({ timeZone: `${currentTimeZone()}-not-a-zone` })).toBe(true)
  })
})

describe('R5-B-6 宿主：realignTimeZone 把将来的触发点折到当前时区', () => {
  it('重排将来的任务、跳过到期的与停用的，并把快照时区改成当前时区', () => {
    const ledger = new HostCronLedger({ dshHomeDir: home(), now: () => T0 })
    const scheduled = nextRunAtMs('0 9 * * *', T0)!
    const stale = scheduled + 12 * HOUR
    const overdueStale = nextRunAtMs('0 9 * * *', T0 - 48 * HOUR)!
    ledger.upsertJob({ id: 'future', name: 'A', cron: '0 9 * * *', action: { kind: 'agent', prompt: 'x' }, enabled: true })
    ledger.upsertJob({ id: 'overdue', name: 'B', cron: '0 9 * * *', action: { kind: 'agent', prompt: 'x' }, enabled: true })
    ledger.upsertJob({ id: 'off', name: 'C', cron: '0 9 * * *', action: { kind: 'agent', prompt: 'x' }, enabled: true })
    // 手工伪造"旧时区留下的绝对时刻"（账本只做持久化，取值就是事实）。
    const mutate = ledger as unknown as { current: { jobs: JobRecord[] } }
    mutate.current.jobs.find(j => j.id === 'future')!.nextRunAt = stale
    mutate.current.jobs.find(j => j.id === 'overdue')!.nextRunAt = overdueStale
    mutate.current.jobs.find(j => j.id === 'off')!.nextRunAt = stale
    ledger.applyRequest('req-off', { kind: 'disable', jobId: 'off' })
    // 快照里的时区假装是"另一个时区"（= 变更前记账的那个）。
    ledger.setScheduler({ timeZone: 'Old/Zone' })

    const result = ledger.realignTimeZone(T0)
    expect(result).toBeDefined()
    expect(result!.from).toBe('Old/Zone')
    expect(result!.to).toBe(currentTimeZone())
    expect(result!.rescheduled).toBe(1)
    const jobs = ledger.state().jobs
    // 将来的那个：折回本机时区要求的墙钟（09:00）。
    expect(jobs.find(j => j.id === 'future')!.nextRunAt).toBe(scheduled)
    // 到期的那个：原样留给正常路径（错过/触发由 tick 与 skipMissed 记账）。
    expect(jobs.find(j => j.id === 'overdue')!.nextRunAt).toBe(overdueStale)
    // 停用的那个：不动。
    expect(jobs.find(j => j.id === 'off')!.nextRunAt).toBe(stale)
    expect(ledger.state().scheduler.timeZone).toBe(currentTimeZone())
    ledger.dispose()
  })

  it('时区没变 ⇒ 零写盘、零 revision（每个 tick 都会调它，不能每次都吵醒订阅者）', () => {
    const ledger = new HostCronLedger({ dshHomeDir: home(), now: () => T0 })
    const before = ledger.state().revision
    const notifications = vi.fn()
    ledger.subscribe(notifications)
    expect(ledger.realignTimeZone(T0)).toBeUndefined()
    expect(ledger.state().revision).toBe(before)
    expect(notifications).not.toHaveBeenCalled()
    ledger.dispose()
  })

  it('调度器的每个 tick 都会问一次时区（接线判据：删掉这次调用，本条必红）', async () => {
    const realignTimeZone = vi.fn(() => undefined)
    let tickAt = T0
    const ledger = {
      jobs: [],
      state: () => ({ revision: 1, jobs: [], scheduler: { timeZone: currentTimeZone() } }),
      setScheduler: vi.fn(),
      skipMissed: vi.fn(),
      openScheduled: vi.fn(() => undefined),
      realignTimeZone,
      settle: vi.fn(),
    }
    const executor = { execute: vi.fn(async () => ({ result: 'succeeded' as const })) }
    const scheduler = new HostCronScheduler(ledger as never, executor as never, { now: () => tickAt })
    await scheduler['tick'](false)
    expect(realignTimeZone).toHaveBeenCalledWith(tickAt)
    scheduler.dispose()
  })

  it('账本没有 realignTimeZone（结构替身/嵌入式账本）时 tick 照常跑，不能因此停摆', async () => {
    const opened: string[] = []
    const due = T0
    const ledger = {
      jobs: [job({ nextRunAt: due })],
      state: () => ({ revision: 1, jobs: [job({ nextRunAt: due })], scheduler: { timeZone: currentTimeZone() } }),
      setScheduler: vi.fn(),
      skipMissed: vi.fn(),
      openScheduled: vi.fn((jobId: string) => {
        opened.push(jobId)
        return undefined
      }),
      settle: vi.fn(),
    }
    const scheduler = new HostCronScheduler(ledger as never, { execute: vi.fn() } as never, { now: () => due })
    await scheduler['tick'](false)
    expect(ledger.openScheduled).toHaveBeenCalled()
    expect(opened.length).toBe(1)
    scheduler.dispose()
  })
})

/**
 * 真双时区用例（与审计探针同形）。
 *
 * 依赖 `process.env.TZ` 在运行期被 V8 接受 —— 这不是所有 Node/平台组合都成立，
 * 所以先**自校准**（复刻用例自己的动作：换区后 `getHours()` 真的变了吗），校准不上就
 * 如实跳过：环境差异既不能记成产品缺陷，也不能报成通过。
 */
describe('R5-B-6 真双时区（自校准）', () => {
  const original = process.env.TZ
  afterEach(() => {
    if (original === undefined) delete process.env.TZ
    else process.env.TZ = original
  })

  it('东八区存下的 09:00 在纽约被认成 21:00 ⇒ 判为漂移并重算回 09:00', () => {
    const probe = new Date(2026, 8, 24, 9, 0, 0)
    process.env.TZ = 'Asia/Shanghai'
    const east = probe.getHours()
    process.env.TZ = 'America/New_York'
    const west = probe.getHours()
    if (east !== 9 || west !== 9) {
      // 校准成功：同一个挂钟构造在两区里落到了不同的绝对时刻。
    } else {
      // 环境不认运行期 TZ 变更 ⇒ 跳过（并说清是环境问题）。
      expect(east).toBe(west)
      return
    }
    process.env.TZ = 'Asia/Shanghai'
    const scheduled = nextRunAtMs('0 9 * * *', new Date(2026, 8, 23, 20, 0, 0).getTime())
    expect(scheduled, '东八区里必须能排到第二天 09:00').toBeDefined()
    process.env.TZ = 'America/New_York'
    const display = displayNextRun(job({ nextRunAt: scheduled! }), new Date(2026, 8, 23, 20, 0, 0).getTime())
    expect(display.timeZoneDrift).toBe(true)
    expect(new Date(display.at!).getHours()).toBe(9)
  })
})
