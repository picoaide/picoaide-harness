package serverstore

import "fmt"

// ---------------------------------------------------------------------------
// 时间分桶表达式(PG-only 2026-08;SQLite 分支已删除)。
// PG 存 TIMESTAMPTZ(真实瞬时),GROUP BY 表达式产出「北京墙钟」标签。
// ---------------------------------------------------------------------------

// bjWallExpr 返回把 timestamptz 列转成「北京墙钟 timestamp」的 SQL 表达式。
// 固定 +8h(UTC+8,无 DST),与 Go 侧 BeijingOffset 严格一致 —— 不用
// `AT TIME ZONE 'Asia/Shanghai'`,以免分桶口径依赖 PG 的 tzdata 版本
// (Asia/Shanghai 的 1986-1991 夏令时与 1949 前偏移会让历史数据分桶漂移)。
func bjWallExpr(col string) string {
	return fmt.Sprintf("(%s AT TIME ZONE 'UTC' + interval '8 hours')", col)
}

// DateDayExpr returns the SQL expression yielding a date-only label (YYYY-MM-DD).
func DateDayExpr(col string) string {
	return fmt.Sprintf("to_char(%s, 'YYYY-MM-DD')", bjWallExpr(col))
}

// DateWeekExpr returns the SQL expression bucketing by Monday of the week
// (independent of ISO week/year boundaries).
func DateWeekExpr(col string) string {
	return fmt.Sprintf("to_char(date_trunc('week', %s)::date, 'YYYY-MM-DD')", bjWallExpr(col))
}

// DateMonthExpr returns the SQL expression yielding a month label (YYYY-MM).
func DateMonthExpr(col string) string {
	return fmt.Sprintf("to_char(%s, 'YYYY-MM')", bjWallExpr(col))
}

// 注(2026-09-10 时区缺陷修复):范围比较一律写成
//
//	col >= ?::timestamptz AND col < ?::timestamptz
//
// 参数用 BeijingDay 边界经 pgInstantArg 渲染的「显式 UTC 偏移瞬时字符串」
// (见 beijing.go)。两点必须守住:
//  1. **不包裹**分区键:`col AT TIME ZONE …` 会让 PG 无法分区裁剪/用索引
//     (P2-15,EXPLAIN 全分区扫),故瞬时比较只作用于参数一侧;
//  2. **不用** `?::date` 或裸墙钟字符串:它们按 **PG 会话时区**解析,会话为
//     UTC 与 Asia/Shanghai 时"日窗口"相差 8 小时(2026-09-10 CI 实测)。
