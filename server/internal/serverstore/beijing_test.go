package serverstore

import (
	"strings"
	"testing"
	"time"
)

// TestBeijingDayMonthPrimitives 钉死「北京日/月」唯一真源的算术(纯函数,不需要 DB):
// 固定 +8h 偏移(不依赖 tzdata/进程 TZ)、日期值 ↔ 绝对瞬时互转、边界参数渲染成
// 带显式 UTC 偏移的瞬时字符串(不依赖 PG 会话时区)。
func TestBeijingDayMonthPrimitives(t *testing.T) {
	// 北京 2026-09-01 00:30 = UTC 2026-08-31 16:30(最容易错切日/月界的时刻)
	at := time.Date(2026, 8, 31, 16, 30, 0, 0, time.UTC)
	if got := BeijingDay(at).Format(dateFmt); got != "2026-09-01" {
		t.Fatalf("BeijingDay = %s, want 2026-09-01(北京日)", got)
	}
	if got := BeijingMonth(at).Format(dateFmt); got != "2026-09-01" {
		t.Fatalf("BeijingMonth = %s, want 2026-09-01", got)
	}
	// 北京 9/1 00:00 的绝对瞬时 = UTC 8/31 16:00
	if got := BeijingDayInstant(BeijingDay(at)); !got.Equal(time.Date(2026, 8, 31, 16, 0, 0, 0, time.UTC)) {
		t.Fatalf("BeijingDayInstant = %s, want 2026-08-31T16:00Z", got)
	}
	if got := BeijingMonthInstant(at); !got.Equal(time.Date(2026, 8, 31, 16, 0, 0, 0, time.UTC)) {
		t.Fatalf("BeijingMonthInstant = %s, want 2026-08-31T16:00Z", got)
	}
	// 边界参数:显式 UTC 偏移 → 任何会话时区下都是同一瞬时
	if got := dayStartArg(at); got != "2026-08-31 16:00:00+00:00" {
		t.Fatalf("dayStartArg = %q, want 2026-08-31 16:00:00+00:00", got)
	}
	if got := dayEndArgInclusive(BeijingDay(at)); got != "2026-09-01 16:00:00+00:00" {
		t.Fatalf("dayEndArgInclusive = %q(want 次日北京 00:00 = 2026-09-01T16:00Z)", got)
	}
	// 日期值幂等:已是北京日期值时再归一不变(全仓 from/to 约定)
	if got := BeijingDay(BeijingDay(at)); !got.Equal(BeijingDay(at)) {
		t.Fatalf("BeijingDay 不幂等: %s", got)
	}

	// 进程 TZ 无关:同一瞬时用不同时区表达,北京日/月与边界必须一致。
	wantDay, wantMonth := BeijingDay(at), BeijingMonth(at)
	for _, loc := range []*time.Location{
		time.UTC,
		time.FixedZone("CST", 8*3600),
		time.FixedZone("UTC+14", 14*3600),
		time.FixedZone("UTC-11", -11*3600),
		time.FixedZone("UTC-12", -12*3600),
	} {
		if got := BeijingDay(at.In(loc)); !got.Equal(wantDay) {
			t.Fatalf("%s 下 BeijingDay = %s, want %s(不得依赖进程 TZ)", loc, got, wantDay)
		}
		if got := BeijingMonth(at.In(loc)); !got.Equal(wantMonth) {
			t.Fatalf("%s 下 BeijingMonth = %s, want %s(不得依赖进程 TZ)", loc, got, wantMonth)
		}
		if got := dayStartArg(at.In(loc)); got != dayStartArg(at) {
			t.Fatalf("%s 下 dayStartArg = %q, want %q", loc, got, dayStartArg(at))
		}
	}

	// 分桶表达式:固定 +8h 且不含会话时区依赖(拼进 SQL 的字符串里不得出现
	// AT TIME ZONE 'Asia/Shanghai'/current_setting 之类)。
	for _, expr := range []string{DateDayExpr("usage.created_at"), DateWeekExpr("usage.created_at"), DateMonthExpr("usage.created_at")} {
		if want := "AT TIME ZONE 'UTC' + interval '8 hours'"; !strings.Contains(expr, want) {
			t.Fatalf("分桶表达式未用固定 +8h: %q", expr)
		}
		if strings.Contains(expr, "Asia/Shanghai") {
			t.Fatalf("分桶表达式依赖 PG 时区名: %q", expr)
		}
	}
}
