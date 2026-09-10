package serverstore

import (
	"testing"
	"time"
)

// TestMarkReportRunFailureRecordsLastRunAt 覆盖 P2-4:失败也必须写 last_run_at,
// 否则 ShouldRunMonthly 恒为 true,调度器每小时重算整月报表并重发
// (reports/scheduler.go 只看 last_run_at 的月份)。
func TestMarkReportRunFailureRecordsLastRunAt(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	id, err := CreateReportSubscription(db, "月度用量", "https://example.com/hook", true)
	if err != nil {
		t.Fatal(err)
	}
	if err := MarkReportRun(db, id, false, "webhook 502"); err != nil {
		t.Fatalf("MarkReportRun(false): %v", err)
	}
	subs, err := ListReportSubscriptions(db)
	if err != nil {
		t.Fatal(err)
	}
	if len(subs) != 1 {
		t.Fatalf("subs = %d, want 1", len(subs))
	}
	s := subs[0]
	if s.LastRunAt == nil {
		t.Fatal("last_run_at 为空:失败未记账 → 调度器同月会重复跑")
	}
	if s.LastError != "webhook 502" {
		t.Fatalf("last_error = %q", s.LastError)
	}
	now := time.Now()
	// 月口径 = 北京月(唯一真源):last_run_at 由 SQL now() 写入(绝对瞬时),
	// 进程 TZ=UTC 时其"本机月"会与北京月错开(每月 00:00-08:00)。
	if !BeijingMonth(*s.LastRunAt).Equal(BeijingMonth(now)) {
		t.Fatalf("last_run_at = %v, want 北京本月(%v)", s.LastRunAt, BeijingMonth(now))
	}
	// 成功路径:last_run_at 更新且 last_error 清空
	if err := MarkReportRun(db, id, true, ""); err != nil {
		t.Fatalf("MarkReportRun(true): %v", err)
	}
	subs, err = ListReportSubscriptions(db)
	if err != nil {
		t.Fatal(err)
	}
	if subs[0].LastError != "" || subs[0].LastRunAt == nil {
		t.Fatalf("after success: %+v", subs[0])
	}
}
