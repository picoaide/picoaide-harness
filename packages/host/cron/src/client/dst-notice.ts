/**
 * Which DST-gap skip (if any) the job panel should announce (2026-09-23 R3-B3
 * F2 / B-5).
 *
 * The Host records every occurrence it rolled past because its local wall clock
 * does not exist (the spring-forward gap) in the scheduler state, so the skip is
 * no longer silent. The record is history, though: showing the newest one
 * forever would turn a twice-a-year event into a permanent banner. The panel
 * therefore announces it only while it is fresh, and `undefined` means "nothing
 * to show" — never "nothing was skipped".
 *
 * A pure function so the window is testable without mounting React.
 */
import type { CronSchedulerSnapshot, SkippedOccurrence } from '../protocol.ts'

/**
 * How long a skip stays announced. Long enough to cover "the app was closed
 * over the weekend and I open it on Monday", short enough that the notice is
 * gone once the missed day is no longer actionable.
 */
export const DST_NOTICE_WINDOW_MS = 3 * 24 * 60 * 60 * 1000

/**
 * The most recent DST-gap skip worth announcing, or undefined.
 * @param scheduler - scheduler snapshot from the Host.
 * @param now - current client clock (ms epoch); injected so tests need no fake timers.
 * @returns the newest skip record inside {@link DST_NOTICE_WINDOW_MS}.
 */
export function latestDstSkip(
  scheduler: Pick<CronSchedulerSnapshot, 'skippedOccurrences'>,
  now: number,
): SkippedOccurrence | undefined {
  const records = scheduler.skippedOccurrences
  if (records === undefined || records.length === 0) return undefined
  // The Host appends chronologically and bounds the list, so the last entry is
  // the newest one. A clock that ran backwards (or a Host stamped ahead) must
  // not hide the notice: only "older than the window" counts as stale.
  const latest = records[records.length - 1]!
  return now - latest.detectedAt > DST_NOTICE_WINDOW_MS ? undefined : latest
}
