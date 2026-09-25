package serverstore

import (
	"testing"
)

// TestMarkReportRunFailureKeepsLastRunAt 钉 R18C-03（审计 2026-09-25，P2）修正后的契约：
// **失败不推进 last_run_at**（它记的是"最近一次成功"），只写 last_error。
//
// 修前（P2-4 的原口径）：失败同样写 `last_run_at = now()` ⇒ `ShouldRunMonthly` 在本北京月内
// 恒为 false ⇒ 月内零重试；而下一次真正运行在**下月**、生成的是"刚结束的那个月"
// ⇒ 失败的那一期永不投递 —— 与 webadmin「失败会重试」的承诺相反。
//
// 改后：失败后该订阅本月内仍然"待补跑"（调度器每小时那一轮会重投同一期），
// 成功一次才推进并清空 last_error。
func TestMarkReportRunFailureKeepsLastRunAt(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	id, err := CreateReportSubscription(db, "月度用量", "https://example.com/hook", true)
	if err != nil {
		t.Fatal(err)
	}
	// 先成功一次，留下一个"上次成功"的锚（模拟上个月已经正常投递过）。
	if err := MarkReportRun(db, id, true, ""); err != nil {
		t.Fatalf("MarkReportRun(true): %v", err)
	}
	subs, err := ListReportSubscriptions(db)
	if err != nil {
		t.Fatal(err)
	}
	if subs[0].LastRunAt == nil {
		t.Fatal("成功路径必须写 last_run_at")
	}
	anchor := *subs[0].LastRunAt

	// 失败：只写 last_error，**不动** last_run_at（否则本月内不会再补跑）。
	if err := MarkReportRun(db, id, false, "webhook 502"); err != nil {
		t.Fatalf("MarkReportRun(false): %v", err)
	}
	subs, err = ListReportSubscriptions(db)
	if err != nil {
		t.Fatal(err)
	}
	s := subs[0]
	if s.LastError != "webhook 502" {
		t.Fatalf("last_error = %q, want webhook 502", s.LastError)
	}
	if s.LastRunAt == nil {
		t.Fatal("last_run_at 被清空：它必须保留「上一次成功」的时刻")
	}
	if !s.LastRunAt.Equal(anchor) {
		t.Fatalf("失败推进了 last_run_at（%v → %v）⇒ 本月内 ShouldRunMonthly 恒 false、失败的那一期永不重投",
			anchor, *s.LastRunAt)
	}

	// 成功：清空 last_error 并推进 last_run_at。
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
	if !subs[0].LastRunAt.After(anchor) {
		t.Fatalf("成功必须推进 last_run_at（%v → %v）", anchor, *subs[0].LastRunAt)
	}
}
