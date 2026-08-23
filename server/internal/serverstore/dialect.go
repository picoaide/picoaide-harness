package serverstore

import "fmt"

// ---------------------------------------------------------------------------
// Date/time bucket expressions.
//
// SQLite stores DATETIME as wall-clock strings; PG stores TIMESTAMPTZ. Both
// scan back to local time via parseSQLTime. The GROUP BY expressions below
// produce the equivalent bucket label on each backend.
// ---------------------------------------------------------------------------

// DateDayExpr returns the SQL expression yielding a date-only label (YYYY-MM-DD).
func DateDayExpr(col string) string {
	if currentDriver == DriverPG {
		return fmt.Sprintf("to_char(%s AT TIME ZONE 'localtime', 'YYYY-MM-DD')", col)
	}
	return fmt.Sprintf("date(%s)", col)
}

// DateWeekExpr returns the SQL expression bucketing by Monday of the week
// (independent of ISO week/year boundaries).
func DateWeekExpr(col string) string {
	if currentDriver == DriverPG {
		// PG: date_trunc('week', col AT TIME ZONE 'localtime') - 1 day gives Monday?
		// Monday = date_trunc week - interval '1 day' when week starts Monday.
		// Simpler: date_trunc('week', ...) is ISO Monday-based? PG date_trunc('week')
		// uses ISO week starting Monday. Use to_char of that date.
		return fmt.Sprintf("to_char(date_trunc('week', %s AT TIME ZONE 'localtime')::date, 'YYYY-MM-DD')", col)
	}
	return fmt.Sprintf("date(%s, 'weekday 0', '-6 days')", col)
}

// DateMonthExpr returns the SQL expression yielding a month label (YYYY-MM).
func DateMonthExpr(col string) string {
	if currentDriver == DriverPG {
		return fmt.Sprintf("to_char(%s AT TIME ZONE 'localtime', 'YYYY-MM')", col)
	}
	return fmt.Sprintf("strftime('%%Y-%%m', %s)", col)
}

// DateTruncDayExpr is used in WHERE / comparisons for day buckets.
func DateTruncDayExpr(col string) string {
	if currentDriver == DriverPG {
		return fmt.Sprintf("(%s AT TIME ZONE 'localtime')::date", col)
	}
	return fmt.Sprintf("date(%s)", col)
}

// DateCompareExpr wraps a column so range comparisons (>= ?, < ?) align with
// the "day" semantics on both backends. SQLite compares wall-clock strings;
// PG compares TIMESTAMPTZ against the formatted date string argument.
func DateCompareExpr(col string) string {
	if currentDriver == DriverPG {
		return fmt.Sprintf("%s AT TIME ZONE 'localtime'", col)
	}
	return col
}
