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

// 注(P2-15):此前的 DateCompareExpr(col) = "col AT TIME ZONE 'Asia/Shanghai'"
// 用于范围比较,包裹分区键 created_at 会让 PG 无法分区裁剪/用索引(EXPLAIN
// 全分区扫)。范围比较一律直接写 "col >= ?::date" / "col < ?::date"
// ——会话时区已固定 Asia/Shanghai(见 pg.go),语义等价且可裁剪。
