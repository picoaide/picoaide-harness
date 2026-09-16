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
  execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], {
    env: { ...process.env, TZ: tz },
    stdio: 'pipe',
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
 */
describe('按日回退游标不会因"跳日"原地打转（R9 审计）', () => {
  it('terminates on a skipped local calendar day', () => {
    assertWithTz('Pacific/Apia', `
      // 2011-12-30 在当地不存在（跨日界线跳到 12-31）；表达式在 2004/2032 之间
      // 没有命中日，游标会一路退到那个跳日。
      const last = lastRunAtMs('0 0 29 2 */7', Date.UTC(2017, 5, 1))
      assert.equal(last, undefined)
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
