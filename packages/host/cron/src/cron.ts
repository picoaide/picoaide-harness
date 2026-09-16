/**
 * Minimal 5-field cron parsing and next-run computation for scheduled jobs.
 * Framework-free and dependency-free so the scheduler and the UI share one
 * tiny pure module.
 *
 * Ported from dsh-web-ui (https://github.com/zhu1090093659/dsh-web-ui),
 * packages/dsh-task-board/src/core/schedule.ts, Apache-2.0, by the DSH
 * Desktop team. Behavior is preserved verbatim; only comments were trimmed.
 *
 * Grammar: five whitespace-separated fields, 分 时 日 月 周. Every field
 * supports the wildcard, step (wildcard or range + "/n"), single value,
 * inclusive range a-b, and comma lists mixing any of those. Ranges: minutes
 * 0-59, hours 0-23, days 1-31, months 1-12, weekdays 0-7 (0 and 7 both mean
 * Sunday). When both the day and weekday fields are restricted they combine
 * with OR semantics (standard cron). Invalid expressions parse to null and
 * are rejected by the UI/controller.
 */

/** The parsed match sets of one cron expression. */
export interface CronSchedule {
  minutes: ReadonlySet<number>
  hours: ReadonlySet<number>
  days: ReadonlySet<number>
  months: ReadonlySet<number>
  /** Weekdays 0-6, 0 = Sunday (input 7 normalized to 0). */
  weekdays: ReadonlySet<number>
  /** Whether the day-of-month field was the literal '*' (unrestricted). */
  dayWildcard: boolean
  /** Whether the weekday field was the literal '*' (unrestricted). */
  weekdayWildcard: boolean
}

/** Inclusive ranges per field, in cron order. */
const FIELD_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0, 59], // minutes
  [0, 23], // hours
  [1, 31], // days
  [1, 12], // months
  [0, 7], // weekdays (7 = Sunday, normalized below)
]

/**
 * Parse a 5-field cron expression.
 * @returns the match sets, or null when the expression is invalid.
 */
export function parseCron(expr: string): CronSchedule | null {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return null
  const sets: Set<number>[] = []
  for (let index = 0; index < 5; index++) {
    const [min, max] = FIELD_RANGES[index]!
    const set = new Set<number>()
    if (!parseField(fields[index]!, min, max, set)) return null
    sets.push(set)
  }
  const weekdays = new Set<number>()
  for (const day of sets[4]!) weekdays.add(day === 7 ? 0 : day)
  // Vixie's parser sets its DOM_STAR/DOW_STAR flag whenever the field STARTS
  // with '*', including step-from-wildcard forms such as '*/n'. The flag does
  // not make the value set unrestricted: '*/9' still only matches days
  // 1,10,19,28. It only selects the combination rule in {@link dayCandidate}
  // (star flag present -> AND, both fields explicit -> OR).
  const wildcardField = (field: string): boolean => /^\*(?:\/\d+)?$/u.test(field)
  return {
    minutes: sets[0]!,
    hours: sets[1]!,
    days: sets[2]!,
    months: sets[3]!,
    weekdays,
    // Only a wildcard field (including '*/n') marks a field unrestricted: an
    // explicit full enumeration such as '1-31' is restricted and participates
    // in day/weekday OR semantics.
    dayWildcard: wildcardField(fields[2]!),
    weekdayWildcard: wildcardField(fields[4]!),
  }
}

/** Whether the expression parses. */
export function isValidCron(expr: string): boolean {
  return parseCron(expr) !== null
}

/**
 * Compute the next matching instant after `fromMs` (ms epoch), in local time,
 * at minute granularity, strictly greater than `fromMs`. Returns the ms epoch
 * of the matching minute's start, or undefined when the calendar constraint
 * can never match (for example `0 0 30 2 *`). The five-year horizon includes
 * a full leap cycle, so a valid February 29 schedule remains reachable from
 * every non-leap year.
 *
 * Walks candidate year/month/day/hour/minute values straight from the parsed
 * field sets instead of scanning every minute. Wall-clock field construction
 * + the final `matches` re-check preserve standard DST semantics: nonexistent
 * spring minutes normalize forward and the repeated fall-back hour is never
 * visited twice.
 */
export function nextRunAtMs(expr: string, fromMs: number): number | undefined {
  const schedule = parseCron(expr)
  if (schedule === null) return undefined
  if (!hasPossibleCalendarDay(schedule)) return undefined
  const from = new Date(fromMs)
  // Eight years, not five: the 2100 century is not a leap year, so a valid
  // `0 0 29 2 *` schedule can be up to ~7 years away (2097→2104) and a 5-year
  // horizon declared it impossible (2026-09-16 audit R3-J).
  const limitMs = fromMs + 8 * 366 * 24 * 60 * 60 * 1000

  const sortedMinutes = [...schedule.minutes].sort((a, b) => a - b)
  const sortedHours = [...schedule.hours].sort((a, b) => a - b)
  const sortedMonths = [...schedule.months].sort((a, b) => a - b)

  let year = from.getFullYear()
  let month = from.getMonth() + 1
  let day = from.getDate()
  let hour = from.getHours()
  // Strictly after fromMs: the scan starts from the next minute.
  let minute = from.getMinutes() + 1

  while (new Date(year, month - 1, 1, 0, 0, 0, 0).getTime() <= limitMs) {
    for (const candidateMonth of sortedMonths) {
      if (candidateMonth < month) continue
      const daysInMonth = new Date(year, candidateMonth, 0).getDate()
      const dayStart = candidateMonth === month ? day : 1
      for (let candidateDay = dayStart; candidateDay <= daysInMonth; candidateDay += 1) {
        const dayProbe = new Date(year, candidateMonth - 1, candidateDay, 0, 0, 0, 0)
        if (!dayCandidate(schedule, dayProbe)) continue
        const hourStart = candidateMonth === month && candidateDay === day ? hour : 0
        for (const candidateHour of sortedHours) {
          if (candidateHour < hourStart) continue
          const minuteStart = candidateMonth === month && candidateDay === day && candidateHour === hour ? minute : 0
          for (const candidateMinute of sortedMinutes) {
            if (candidateMinute < minuteStart) continue
            const candidate = new Date(year, candidateMonth - 1, candidateDay, candidateHour, candidateMinute, 0, 0)
            const time = candidate.getTime()
            if (time <= fromMs) continue
            if (time > limitMs) return undefined
            if (matches(schedule, candidate)) return time
          }
        }
      }
    }
    year += 1
    month = 1
    day = 1
    hour = 0
    minute = 0
  }
  return undefined
}

/**
 * Compute the most recent matching instant at or before `fromMs` (minute
 * granularity). Used by the scheduler's catch-up path: the previous
 * forward-only helper could only walk a bounded number of matches from the
 * last-known `nextRunAt`, so a long sleep fired an old occurrence instead of
 * the latest missed one. The backwards horizon is eight years (century leap
 * gap included).
 * @param expr - 5-field cron expression.
 * @param fromMs - upper bound (ms epoch).
 * @returns the matching minute start, or undefined when the calendar can never match.
 */
export function lastRunAtMs(expr: string, fromMs: number): number | undefined {
  const schedule = parseCron(expr)
  if (schedule === null || !hasPossibleCalendarDay(schedule)) return undefined
  const from = new Date(fromMs)
  // Walk whole days backwards (bounded by the same eight-year rule as
  // nextRunAtMs) and, on a matching day, pick the latest matching hour/minute
  // from the parsed sets. Minute-by-minute scanning would be correct but could
  // block the scheduler tick for millions of iterations after a long sleep.
  const dayLimit = new Date(fromMs - 8 * 366 * 24 * 60 * 60 * 1000)
  const sortedHours = [...schedule.hours].sort((a, b) => b - a)
  const sortedMinutes = [...schedule.minutes].sort((a, b) => b - a)
  let cursor = new Date(from.getFullYear(), from.getMonth(), from.getDate())
  while (cursor.getTime() >= dayLimit.getTime()) {
    if (schedule.months.has(cursor.getMonth() + 1) && dayCandidate(schedule, cursor)) {
      const year = cursor.getFullYear()
      const month = cursor.getMonth()
      const day = cursor.getDate()
      // Collect every candidate instant of this day FIRST, then take the
      // latest one <= fromMs. Short-circuiting inside the wall-clock-descending
      // loops is wrong under a rollback: a larger wall clock's FIRST pass can
      // be earlier than a smaller wall clock's SECOND pass (Antarctica/Troll
      // 01:59 first pass = 23:59Z, 01:30 second pass = 01:30Z), so the old
      // first-match return recorded a time up to the rollback length in the
      // "past" (or even later than the wake-up wall clock). 2026-09-16 audit R5.
      let best: number | undefined
      for (const hour of sortedHours) {
        for (const minute of sortedMinutes) {
          // Wall clock can repeat (DST fall-back) or vanish (spring-forward).
          // `new Date` only ever yields the FIRST instance of a repeated hour;
          // enumerate every minute within +180 (Lord Howe 30m, most zones 60m,
          // Troll 2h, Casey 3h) whose wall clock still matches.
          const first = new Date(year, month, day, hour, minute, 0, 0)
          if (first.getHours() !== hour || first.getMinutes() !== minute) continue
          // Only pay for the repeat-probe walk when this wall clock is close to
          // a DST offset change; ordinary minutes have exactly one instance.
          const repeated = new Date(first.getTime() + 180 * 60 * 1000).getTimezoneOffset() !== first.getTimezoneOffset()
          const maxDelta = repeated ? 180 * 60 * 1000 : 0
          for (let delta = 0; delta <= maxDelta; delta += 60 * 1000) {
            const probe = new Date(first.getTime() + delta)
            if (probe.getFullYear() !== year || probe.getMonth() !== month || probe.getDate() !== day
              || probe.getHours() !== hour || probe.getMinutes() !== minute) continue
            const time = probe.getTime()
            if (time > fromMs) continue
            if (!matches(schedule, probe)) continue
            if (best === undefined || time > best) best = time
          }
        }
      }
      if (best !== undefined) return best
    }
    cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() - 1)
  }
  return undefined
}

/**
 * Day/weekday gate shared by {@link matches} and the candidate scan.
 *
 * Vixie cron's rule: when EITHER field carries the star flag (a literal star,
 * or a star-prefixed step field), the two fields are ANDed, otherwise they are
 * ORed. ANDing is what keeps a day step of 9 on days 1,10,19,28 — returning the
 * weekday set alone (the old behaviour) made every stepped day-of-month
 * expression run daily.
 */
function dayCandidate(schedule: CronSchedule, date: Date): boolean {
  const dayMatches = schedule.days.has(date.getDate())
  const weekdayMatches = schedule.weekdays.has(date.getDay())
  if (schedule.dayWildcard || schedule.weekdayWildcard) return dayMatches && weekdayMatches
  return dayMatches || weekdayMatches
}

/** Reject impossible month/day pairs without spending the multi-year scan. */
function hasPossibleCalendarDay(schedule: CronSchedule): boolean {
  if (schedule.dayWildcard || !schedule.weekdayWildcard) return true
  const maximumDay = new Map<number, number>([
    [1, 31], [2, 29], [3, 31], [4, 30], [5, 31], [6, 30],
    [7, 31], [8, 31], [9, 30], [10, 31], [11, 30], [12, 31],
  ])
  for (const month of schedule.months) {
    const maximum = maximumDay.get(month) ?? 0
    if ([...schedule.days].some(day => day <= maximum)) return true
  }
  return false
}

/** Parse one comma-list field into the match set. */
function parseField(field: string, min: number, max: number, out: Set<number>): boolean {
  if (field === '*') {
    for (let value = min; value <= max; value++) out.add(value)
    return true
  }
  for (const part of field.split(',')) {
    if (part === '') return false
    const slashParts = part.split('/')
    if (slashParts.length > 2) return false
    const [rangeRaw, stepRaw] = slashParts
    const range = rangeRaw ?? ''
    let low: number
    let high: number
    if (range === '*') {
      low = min
      high = max
    } else if (range.includes('-')) {
      const [a, b] = range.split('-')
      if (a === undefined || b === undefined || a === '' || b === '' || !isDigits(a) || !isDigits(b)) return false
      low = Number(a)
      high = Number(b)
    } else if (isDigits(range)) {
      low = Number(range)
      high = Number(range)
    } else {
      return false
    }
    if (low < min || high > max || low > high) return false
    const step = stepRaw === undefined ? 1 : isDigits(stepRaw) ? Number(stepRaw) : NaN
    if (!Number.isInteger(step) || step < 1) return false
    for (let value = low; value <= high; value += step) out.add(value)
  }
  return true
}

/** Day/weekday OR semantics: a restricted day field alone gates, and vice versa. */
function matches(schedule: CronSchedule, date: Date): boolean {
  if (!schedule.minutes.has(date.getMinutes())) return false
  if (!schedule.hours.has(date.getHours())) return false
  if (!schedule.months.has(date.getMonth() + 1)) return false
  return dayCandidate(schedule, date)
}

function isDigits(value: string): boolean {
  return /^\d+$/.test(value)
}
