import { describe, expect, it } from 'vitest'
import { isValidCron, nextRunAtMs, parseCron } from '../src/cron.ts'

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

  it('returns undefined for impossible calendar dates', () => {
    expect(nextRunAtMs('0 0 30 2 *', Date.UTC(2026, 0, 1))).toBeUndefined()
  })

  it('reaches a February 29 schedule within the five-year horizon', () => {
    const from = new Date(2026, 0, 1).getTime()
    const next = nextRunAtMs('0 0 29 2 *', from)
    expect(next).toBeDefined()
    const date = new Date(next!)
    expect(date.getMonth()).toBe(1)
    expect(date.getDate()).toBe(29)
  })

  it('never returns a time at or before fromMs', () => {
    const from = new Date(2026, 7, 19, 9, 0, 0).getTime()
    const next = nextRunAtMs('0 9 * * *', from)!
    expect(next).toBeGreaterThan(from)
  })
})
