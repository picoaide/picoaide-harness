import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { isValidCron, lastRunAtMs, nextRunAtMs, parseCron } from '../src/cron.ts'

/**
 * Run cron assertions in a CHILD process with a fixed TZ.
 *
 * Mutating process.env.TZ at runtime proved inconsistent for Date (V8 caches
 * the timezone), which made the DST regressions flaky; a fresh process reads
 * TZ before the first Date is constructed.
 */
function assertWithTz(tz: string, body: string): void {
  const moduleUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '../src/cron.ts')).href
  const script = `import assert from 'node:assert/strict'\nimport { lastRunAtMs, nextRunAtMs } from ${JSON.stringify(moduleUrl)}\n${body}`
  // A regression in the walk can HANG (e.g. a day-cursor that stops moving).
  // Without this inner deadline the synchronous execFileSync defeats vitest's
  // testTimeout and the whole suite hangs until the CI job times out with no
  // assertion message (2026-09-16 R4 audit).
  execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], {
    env: { ...process.env, TZ: tz },
    stdio: 'pipe',
    timeout: 20_000,
    killSignal: 'SIGKILL',
  })
}

describe('DST/catch-up 一致性（2026-09-16 审计 E4/R2-E2）', () => {
  it('lastRunAtMs 不返回春季跳变中被归一化、表达式不匹配的瞬间', () => {
    assertWithTz('America/New_York', `
      const from = Date.UTC(2026, 2, 8, 7, 30) // 当地 03:30 EDT，02:xx 不存在
      const last = lastRunAtMs('0 2 * * *', from)
      assert.ok(last !== undefined, 'there is always a previous matching instant')
      assert.equal(new Date(last).getHours(), 2)
      assert.equal(nextRunAtMs('0 2 * * *', last - 1), last)
    `)
  })

  it('世纪闰年缺口：2100 不是闰年，2 月 29 日仍须可达', () => {
    assertWithTz('UTC', `
      const next = nextRunAtMs('0 0 29 2 *', Date.UTC(2097, 0, 1))
      assert.equal(next, Date.UTC(2104, 1, 29))
    `)
  })

  it('2 小时回拨跨 (时,分) 候选取最近瞬间，而不是墙钟降序的第一个', () => {
    assertWithTz('Antarctica/Troll', `
      const from = Date.UTC(2026, 9, 25, 1, 30) // 本地 01:30（第二遍）
      assert.equal(lastRunAtMs('* 1 * * *', from), from)
      assert.equal(lastRunAtMs('30,31 1 * * *', from), from)
    `)
  })

  it('2 小时回拨（Antarctica/Troll）：重复区间取第二遍', () => {
    assertWithTz('Antarctica/Troll', `
      const last = lastRunAtMs('45 1 * * *', Date.UTC(2026, 9, 25, 1, 50))
      assert.equal(last, Date.UTC(2026, 9, 25, 1, 45))
    `)
  })

  it('30 分钟回拨（Lord Howe）：重复区间取第二遍', () => {
    assertWithTz('Australia/Lord_Howe', `
      const last = lastRunAtMs('45 1 * * *', Date.UTC(2026, 3, 4, 15, 20))
      assert.equal(last, Date.UTC(2026, 3, 4, 15, 15))
    `)
  })

  it('秋季回拨：重复小时里已发生的匹配不得被整日跳过', () => {
    // Expected epochs come from an independent minute-by-minute scanner (the
    // agent's counterexample); nextRunAtMs is not a reference here because it
    // deliberately does not enumerate the repeated hour's second pass.
    assertWithTz('America/New_York', `
      const last0130 = lastRunAtMs('30 1 * * *', Date.UTC(2026, 10, 1, 6, 10)) // 01:10 EST
      assert.equal(last0130, Date.UTC(2026, 10, 1, 5, 30)) // 第一遍 01:30 EDT

      const last0100 = lastRunAtMs('0 1 * * *', Date.UTC(2026, 10, 1, 6, 30)) // 01:30 EST
      assert.equal(last0100, Date.UTC(2026, 10, 1, 6, 0)) // 第二遍 01:00 EST
    `)
  })
})

describe('parseCron', () => {
  it('parses a plain five-field expression', () => {
    const schedule = parseCron('0 9 * * 1')
    expect(schedule).not.toBeNull()
    expect(schedule!.minutes.has(0)).toBe(true)
    expect(schedule!.hours.has(9)).toBe(true)
    expect(schedule!.weekdays.has(1)).toBe(true)
    expect(schedule!.dayWildcard).toBe(true)
    expect(schedule!.weekdayWildcard).toBe(false)
  })

  it('supports steps, ranges, and comma lists', () => {
    const schedule = parseCron('*/10 9-17 1,15 * 0,7')
    expect(schedule).not.toBeNull()
    for (const minute of [0, 10, 20, 30, 40, 50]) expect(schedule!.minutes.has(minute)).toBe(true)
    expect(schedule!.minutes.has(5)).toBe(false)
    for (let hour = 9; hour <= 17; hour++) expect(schedule!.hours.has(hour)).toBe(true)
    expect(schedule!.days.has(1)).toBe(true)
    expect(schedule!.days.has(15)).toBe(true)
    // 0 and 7 both normalize to Sunday (0).
    expect(schedule!.weekdays.has(0)).toBe(true)
    expect(schedule!.weekdays.has(7)).toBe(false)
  })

  it('rejects malformed expressions', () => {
    expect(parseCron('')).toBeNull()
    expect(parseCron('0 9 * *')).toBeNull()
    expect(parseCron('0 9 * * * *')).toBeNull()
    expect(parseCron('60 9 * * *')).toBeNull()
    expect(parseCron('0 24 * * *')).toBeNull()
    expect(parseCron('0 9 * * 8')).toBeNull()
    expect(parseCron('0 9 32 * *')).toBeNull()
    expect(parseCron('0 9 1-31 * *')).not.toBeNull()
    expect(parseCron('a 9 * * *')).toBeNull()
    expect(parseCron('0 9 */x * *')).toBeNull()
  })

  it('treats */n as a wildcard for day/weekday OR semantics (standard cron)', () => {
    const schedule = parseCron('0 0 */1 * 1')!
    expect(schedule.dayWildcard).toBe(true)
    expect(schedule.weekdayWildcard).toBe(false)
    // Every day is a match of */1, so only the weekday field is restricted:
    // the next run must be a Monday, not tomorrow (whichever day that is).
    const from = new Date(2026, 8, 8, 0, 0, 0).getTime()
    const next = nextRunAtMs('0 0 */1 * 1', from)!
    expect(new Date(next).getDay()).toBe(1)
    expect(next).toBeGreaterThan(from)
  })

  it('isValidCron agrees with parseCron', () => {
    expect(isValidCron('0 9 * * *')).toBe(true)
    expect(isValidCron('0 9 30 2 *')).toBe(true) // syntactically valid, impossible date
    expect(isValidCron('nope')).toBe(false)
  })
})

describe('nextRunAtMs', () => {
  it('finds the next daily 09:00 strictly after now', () => {
    // 2026-08-19 08:00 local
    const from = new Date(2026, 7, 19, 8, 0, 0).getTime()
    const next = nextRunAtMs('0 9 * * *', from)!
    expect(new Date(next).getHours()).toBe(9)
    expect(new Date(next).getMinutes()).toBe(0)
    expect(new Date(next).getDate()).toBe(19)
  })

  it('skips to tomorrow when today\'s 09:00 already passed', () => {
    const from = new Date(2026, 7, 19, 10, 0, 0).getTime()
    const next = nextRunAtMs('0 9 * * *', from)!
    expect(new Date(next).getDate()).toBe(20)
  })

  it('handles day/weekday OR semantics', () => {
    // The 1st of the month OR Mondays: 2026-09-01 is a Tuesday and must match.
    const from = new Date(2026, 7, 25, 0, 0, 0).getTime()
    const next = nextRunAtMs('0 0 1 * 1', from)!
    const date = new Date(next)
    // 2026-08-31 is a Monday.
    expect([date.getDate(), date.getDay()]).toEqual([31, 1])
  })

  it('keeps */n day-of-month steps when the weekday field is a wildcard', () => {
    // 2026-09-15 13:31 local. */9 matches days 1,10,19,28, so the next run is
    // the 19th. Returning the weekday set alone (the old behaviour) made the
    // next run tomorrow, i.e. every day.
    const from = new Date(2026, 8, 15, 13, 31, 0).getTime()
    const next = nextRunAtMs('0 0 */9 * *', from)!
    const date = new Date(next)
    expect([date.getDate(), date.getHours(), date.getMinutes()]).toEqual([19, 0, 0])

    // */2 inside a 31-day month is odd days: 15th -> 17th, never the 16th.
    const everyOther = nextRunAtMs('0 0 */2 * *', from)!
    expect(new Date(everyOther).getDate()).toBe(17)

    // The catch-up path must agree with the forward scan.
    const previous = lastRunAtMs('0 0 */9 * *', from)!
    expect(new Date(previous).getDate()).toBe(10)
  })

  it('ANDs a stepped day-of-month with a restricted weekday', () => {
    // Star flag on the day field -> AND: odd days that are Mondays. From
    // 2026-09-10 the next Monday is the 14th, but 14 is even and must be
    // skipped; the run lands on 2026-09-21 instead.
    const from = new Date(2026, 8, 10, 0, 0, 0).getTime()
    const next = nextRunAtMs('0 0 */2 * 1', from)!
    const date = new Date(next)
    expect([date.getDate(), date.getDay()]).toEqual([21, 1])
  })

  it('ORs an explicit day list with a restricted weekday', () => {
    // Neither field carries the star flag -> OR. From 2026-09-15 the list
    // matches the 19th (Saturday) before any Monday, so the 19th wins; an AND
    // interpretation would have skipped to 2026-09-28 (a listed Monday).
    const from = new Date(2026, 8, 15, 13, 31, 0).getTime()
    const next = nextRunAtMs('0 0 1,10,19,28 * 1', from)!
    const date = new Date(next)
    expect([date.getDate(), date.getDay()]).toEqual([19, 6])
  })

  it('returns undefined for impossible calendar dates', () => {
    expect(nextRunAtMs('0 0 30 2 *', Date.UTC(2026, 0, 1))).toBeUndefined()
  })

  it('reaches a February 29 schedule within the eight-year horizon', () => {
    const from = new Date(2026, 0, 1).getTime()
    const next = nextRunAtMs('0 0 29 2 *', from)
    expect(next).toBeDefined()
    const date = new Date(next!)
    expect(date.getMonth()).toBe(1)
    expect(date.getDate()).toBe(29)
  })

  it('lastRunAtMs returns the most recent match at/before fromMs', () => {
    const from = new Date(2026, 8, 20, 10, 0, 0).getTime()
    const daily = lastRunAtMs('0 9 * * *', from)!
    const date = new Date(daily)
    expect(date.getHours()).toBe(9)
    expect(date.getDate()).toBe(20)

    // A long gap must still return the LATEST match, not a capped forward walk
    // (regression: the old catch-up could fire the 100th match after nextRunAt).
    const old = new Date(2026, 7, 19, 9, 0, 0).getTime()
    const latest = lastRunAtMs('* * * * *', from)!
    expect(latest).toBeGreaterThan(old)
    expect(from - latest).toBeLessThan(60_000)
  })

  it('never returns a time at or before fromMs', () => {
    const from = new Date(2026, 7, 19, 9, 0, 0).getTime()
    const next = nextRunAtMs('0 9 * * *', from)!
    expect(next).toBeGreaterThan(from)
  })
})

/**
 * 2026-09-16 R9 审计：`lastRunAtMs` 的按日回退游标落在**整日不存在**的本地日
 * （跨日界线的跳日，如 Pacific/Apia 的 2011-12-30）时，`new Date(y, m, d - 1)`
 * 会被归一化回当天 ⇒ 死循环。该函数在调度器 tick 里同步调用，卡住就等于所有
 * 定时任务永久停摆（`tickInFlight` 不复位）。8 年回退视野把这个窗口从 5 年放大
 * 到 8 年，所以本轮一并加守卫。
 * （S08-02 之后 AND 分支的回退视野变成 41 年：同一条用例的游标现在会越过跳日
 * 继续走到 2004-02-29，所以断言从 undefined 改为"跨过跳日仍拿到正确的命中"。）
 */
describe('按日回退游标不会因"跳日"原地打转（R9 审计）', () => {
  it('terminates on a skipped local calendar day', () => {
    assertWithTz('Pacific/Apia', `
      // 2011-12-30 在当地不存在（跨日界线跳到 12-31）；2004-02-29 是周日，
      // 游标必须跨过那个跳日往回走到它（走不出去就是死循环，用例会超时）。
      const last = lastRunAtMs('0 0 29 2 */7', Date.UTC(2017, 5, 1))
      assert.ok(last !== undefined, 'the walk must terminate with the 2004 match')
      const d = new Date(last)
      assert.equal(d.getFullYear(), 2004)
      assert.equal(d.getMonth(), 1)
      assert.equal(d.getDate(), 29)
      assert.equal(d.getDay(), 0)
    `)
  })

  it('still finds a match that lies BEFORE the skipped day', () => {
    assertWithTz('Pacific/Apia', `
      // 2011-12-30 不存在；2011-12-25 是周日 03:00，必须仍被找到
      // （早期实现遇到跳日直接 break，会丢掉它 —— R3 审计）。
      const last = lastRunAtMs('0 3 * * 0', new Date('2011-12-31T23:59:00').getTime())
      assert.ok(last !== undefined, 'the Sunday before the skipped day must be found')
      const d = new Date(last)
      assert.equal(d.getDate(), 25)
      assert.equal(d.getHours(), 3)
      assert.equal(d.getDay(), 0)
    `)
  })

  it('walks back by LOCAL days (a midnight DST day must not be skipped)', () => {
    assertWithTz('America/Havana', `
      // 2020-03-08 当地 00:00→01:00 跳变：若把"上一日"算成绝对 -24h，
      // 2020-03-09 00:00 -04:00 会落到 03-07 23:00 -05:00，整个 03-08 被跳过。
      const last = lastRunAtMs('0 3 * * 0', new Date('2020-03-15T00:30:00').getTime())
      assert.ok(last !== undefined)
      const d = new Date(last)
      assert.equal(d.getDate(), 8, 'the Sunday 2020-03-08 must be found')
      assert.equal(d.getHours(), 3)
    `)
  })

  it('still walks past ordinary days', () => {
    assertWithTz('Pacific/Apia', `
      const last = lastRunAtMs('0 0 29 2 *', Date.UTC(2017, 5, 1))
      assert.ok(last !== undefined, 'an earlier February 29 exists inside the horizon')
      const d = new Date(last)
      assert.equal(d.getMonth(), 1)
      assert.equal(d.getDate(), 29)
    `)
  })
})

/**
 * 2026-09-17 S08-02 审计：扫描视野原本是**固定**八年，但日/周 AND 分支（任一
 * 侧带 `*` 前缀即 AND，见 dayCandidate）的 (月, 日, 周几) 合取最长可隔 40 年
 * —— 2 月 29 日 + 周日是 2088→2128（2100 不是闰年，之后的星期循环整体错位），
 * 普通日期最长 12 年。于是完全合法的表达式被判「八年内无匹配时刻」：
 * cron_create 抛错、POST /api/cron/action 回 400 invalid-action；从 2026-09-17
 * 当天算起，5952 个可表达的 AND 形式里有 97 个被误拒（v2.7.4 对同一条表达式
 * 是返回值的）。修法=按表达式给视野（horizonDays：AND 分支 41*366 天，覆盖
 * 400 年格里高利周期实测最大间隔 14609 天；其余保持 8*366）。
 */
describe('AND 分支的扫描视野（S08-02 审计，2026-09-17）', () => {
  it('今天就被误拒的案例：3 月的日步进 AND 周日，真实命中在 10.5 年后', () => {
    assertWithTz('UTC', `
      assert.equal(nextRunAtMs('0 0 */7 3 0', Date.UTC(2026, 8, 17)), Date.UTC(2037, 2, 1))
    `)
  })

  it('40 年闰日缺口：2 月 29 日 AND 周日仍须可达', () => {
    assertWithTz('UTC', `
      // 2088-02-29 是周日，下一次同样是周日的 2 月 29 日在 2128 年。
      assert.equal(nextRunAtMs('0 0 29 2 */7', Date.UTC(2088, 1, 29)), Date.UTC(2128, 1, 29))
      assert.equal(nextRunAtMs('0 0 29 2 */7', Date.UTC(2089, 5, 1)), Date.UTC(2128, 1, 29))
    `)
  })

  it('12 年普通日期缺口：1 月的日步进 AND 周一 / 1 月 2 日 AND 周日', () => {
    assertWithTz('UTC', `
      assert.equal(nextRunAtMs('0 0 */31 1 1', Date.UTC(2092, 0, 2)), Date.UTC(2103, 0, 1))
      assert.equal(nextRunAtMs('0 0 2 1 */7', Date.UTC(2191, 0, 3)), Date.UTC(2203, 0, 2))
    `)
  })

  it('catch-up（lastRunAtMs）用同一视野', () => {
    assertWithTz('UTC', `
      // 2088-02-29 与 2128-02-29 之间是 40 年空档：从空档中间的 2108 年回看，
      // 上一次命中在近 20 年前，旧的八年回退视野会直接返回 undefined
      // （调度器的补跑路径依赖它，见 host-scheduler.ts）。
      assert.equal(lastRunAtMs('0 0 29 2 */7', Date.UTC(2108, 0, 1)), Date.UTC(2088, 1, 29))
      assert.equal(lastRunAtMs('0 0 29 2 */7', Date.UTC(2128, 2, 1)), Date.UTC(2128, 1, 29))
      assert.equal(lastRunAtMs('0 0 */7 3 0', Date.UTC(2037, 2, 2)), Date.UTC(2037, 2, 1))
    `)
  })

  it('视野放宽不放过真正不可能的表达式', () => {
    // 2 月 31 日即使在 AND 分支里也永远不成立（hasPossibleCalendarDay 直接拒），
    // 放宽视野不得把「不可能」变成「有匹配」。
    assertWithTz('UTC', `
      assert.equal(nextRunAtMs('0 0 31 2 */2', Date.UTC(2026, 0, 1)), undefined)
      assert.equal(lastRunAtMs('0 0 31 2 */2', Date.UTC(2026, 0, 1)), undefined)
    `)
    expect(nextRunAtMs('0 0 30 2 *', Date.UTC(2026, 0, 1))).toBeUndefined()
    expect(lastRunAtMs('0 0 30 2 *', Date.UTC(2026, 0, 1))).toBeUndefined()
  })
})
