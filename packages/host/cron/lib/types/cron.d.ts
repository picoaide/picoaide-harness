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
    minutes: ReadonlySet<number>;
    hours: ReadonlySet<number>;
    days: ReadonlySet<number>;
    months: ReadonlySet<number>;
    /** Weekdays 0-6, 0 = Sunday (input 7 normalized to 0). */
    weekdays: ReadonlySet<number>;
    /** Whether the day-of-month field was the literal '*' (unrestricted). */
    dayWildcard: boolean;
    /** Whether the weekday field was the literal '*' (unrestricted). */
    weekdayWildcard: boolean;
}
/**
 * Parse a 5-field cron expression.
 * @returns the match sets, or null when the expression is invalid.
 */
export declare function parseCron(expr: string): CronSchedule | null;
/** Whether the expression parses. */
export declare function isValidCron(expr: string): boolean;
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
export declare function nextRunAtMs(expr: string, fromMs: number): number | undefined;
