/**
 * Which skip the job panel should announce (2026-09-23 R3-B3 F2 / B-5, extended
 * by R4-B-9).
 *
 * The Host records every occurrence it rolled past without firing in the
 * scheduler state: DST spring-forward gaps (the local wall clock does not exist)
 * and triggers that came due while nothing was scheduling (the app was closed or
 * suspended). One record shape, two stories — and the panel must tell them
 * apart, because "02:30 does not exist today" and "the app was off at 09:00" are
 * different things to the user.
 *
 * The record is history, though: showing the newest one forever would turn a
 * twice-a-year (or one-off) event into a permanent banner. The panel therefore
 * announces it only while it is fresh, and `undefined` means "nothing to show" —
 * never "nothing was skipped".
 *
 * Pure functions so the window is testable without mounting React.
 */
import type { CronSchedulerSnapshot, SkippedOccurrence } from '../protocol.ts'

/**
 * How long a skip stays announced. Long enough to cover "the app was closed
 * over the weekend and I open it on Monday", short enough that the notice is
 * gone once the missed day is no longer actionable.
 */
export const DST_NOTICE_WINDOW_MS = 3 * 24 * 60 * 60 * 1000

/**
 * Whether one record describes a trigger missed while nothing was scheduling.
 * An absent reason is a pre-`reason` record, i.e. a DST gap.
 */
function isMissedTrigger(record: SkippedOccurrence): boolean {
  return record.reason === 'missed'
}

/**
 * The newest skip worth announcing that satisfies `matches`, or undefined.
 *
 * The Host appends chronologically and bounds the list, so the last MATCHING
 * entry is the newest one of its kind. A clock that ran backwards (or a Host
 * stamped ahead) must not hide the notice: only "older than the window" counts
 * as stale.
 */
function latestMatching(
  scheduler: Pick<CronSchedulerSnapshot, 'skippedOccurrences'>,
  now: number,
  matches: (record: SkippedOccurrence) => boolean,
): SkippedOccurrence | undefined {
  const records = scheduler.skippedOccurrences
  if (records === undefined || records.length === 0) return undefined
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]!
    if (!matches(record)) continue
    return now - record.detectedAt > DST_NOTICE_WINDOW_MS ? undefined : record
  }
  return undefined
}

/**
 * The most recent DST-gap skip worth announcing, or undefined.
 * @param scheduler - scheduler snapshot from the Host.
 * @param now - current client clock (ms epoch); injected so tests need no fake timers.
 * @returns the newest DST-gap record inside {@link DST_NOTICE_WINDOW_MS}.
 */
export function latestDstSkip(
  scheduler: Pick<CronSchedulerSnapshot, 'skippedOccurrences'>,
  now: number,
): SkippedOccurrence | undefined {
  return latestMatching(scheduler, now, record => !isMissedTrigger(record))
}

/**
 * The most recent trigger missed while the app was not scheduling, or undefined
 * (2026-09-23 R4-B-9).
 *
 * Same freshness rule as {@link latestDstSkip}: the missed run is actionable
 * only while it is recent, and the record itself stays in the ledger as history.
 * @param scheduler - scheduler snapshot from the Host.
 * @param now - current client clock (ms epoch).
 * @returns the newest `missed` record inside {@link DST_NOTICE_WINDOW_MS}.
 */
export function latestMissedTrigger(
  scheduler: Pick<CronSchedulerSnapshot, 'skippedOccurrences'>,
  now: number,
): SkippedOccurrence | undefined {
  return latestMatching(scheduler, now, isMissedTrigger)
}
