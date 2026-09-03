package serverstore

import "fmt"

// pgTZ is the PG timezone matching the app's local time (Beijing, UTC+8, no DST).
const pgTZ = "Asia/Shanghai"

// ---------------------------------------------------------------------------
// Date/time bucket expressions (PG-only 2026-08; SQLite 分支已删除)。
// PG 存 TIMESTAMPTZ,GROUP BY 表达式产出统一标签(北京时间)。
// ---------------------------------------------------------------------------

// DateDayExpr returns the SQL expression yielding a date-only label (YYYY-MM-DD).
func DateDayExpr(col string) string {
	return fmt.Sprintf("to_char(%s AT TIME ZONE '%s', 'YYYY-MM-DD')", col, pgTZ)
}

// DateWeekExpr returns the SQL expression bucketing by Monday of the week
// (independent of ISO week/year boundaries).
func DateWeekExpr(col string) string {
	return fmt.Sprintf("to_char(date_trunc('week', %s AT TIME ZONE '%s')::date, 'YYYY-MM-DD')", col, pgTZ)
}

// DateMonthExpr returns the SQL expression yielding a month label (YYYY-MM).
func DateMonthExpr(col string) string {
	return fmt.Sprintf("to_char(%s AT TIME ZONE '%s', 'YYYY-MM')", col, pgTZ)
}

// DateCompareExpr wraps a column so range comparisons (>= ?, < ?) align with
// the "day" semantics (PG TIMESTAMPTZ vs formatted date string argument).
func DateCompareExpr(col string) string {
	return fmt.Sprintf("%s AT TIME ZONE '%s'", col, pgTZ)
}
