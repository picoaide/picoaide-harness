package serverstore

import (
	"database/sql"
	"testing"
	"time"
)

func TestUsagePartitionInsertAndQuery(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	db.Exec("TRUNCATE TABLE usage RESTART IDENTITY CASCADE")
	uid := mustUserID(t, db)
	// 插入当前月(分区应自动建)
	id, err := RecordUsage(db, uid, "m", 10, 5)
	if err != nil {
		t.Fatalf("RecordUsage: %v", err)
	}
	if id <= 0 {
		t.Fatalf("id = %d", id)
	}
	var n int
	if err := db.QueryRow("SELECT COUNT(*) FROM usage").Scan(&n); err != nil {
		t.Fatalf("query usage: %v", err)
	}
	if n != 1 {
		t.Fatalf("usage rows = %d, want 1", n)
	}
}

func TestRebuildUsageLedger(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	db.Exec("TRUNCATE TABLE usage RESTART IDENTITY CASCADE")
	uid := mustUserID(t, db)
	// 两条今日明细
	if _, err := RecordUsage(db, uid, "m1", 10, 5); err != nil {
		t.Fatal(err)
	}
	if _, err := RecordUsage(db, uid, "m1", 20, 10); err != nil {
		t.Fatal(err)
	}
	// 一个跨月行(上月 15 日)
	if _, err := RecordUsageKind(db, uid, "m2", 30, 0, "chat"); err != nil {
		t.Fatal(err)
	}
	// 把第三条回拨到上月(分区需先建)
	lastMonth := time.Now().AddDate(0, -1, 0)
	if err := ensureUsagePartition(db, lastMonth); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("UPDATE usage SET created_at = ? WHERE id = ?", lastMonth.Format("2006-01-02")+" 12:00:00", 3); err != nil {
		t.Fatal(err)
	}
	// 重建账本(近 2 月)
	if err := RebuildUsageLedger(db, time.Now().AddDate(0, -1, 0).Truncate(24*time.Hour), time.Now()); err != nil {
		t.Fatalf("RebuildUsageLedger: %v", err)
	}
	var dRows int
	if err := db.QueryRow("SELECT COUNT(*) FROM usage_daily WHERE model='m1' AND user_id=$1", uid).Scan(&dRows); err != nil {
		t.Fatal(err)
	}
	if dRows < 1 {
		t.Fatalf("usage_daily m1 rows = %d, want >=1", dRows)
	}
	var dTokens int64
	if err := db.QueryRow("SELECT prompt_tokens FROM usage_daily WHERE model='m1' AND user_id=$1 ORDER BY day DESC LIMIT 1", uid).Scan(&dTokens); err != nil {
		t.Fatal(err)
	}
	if dTokens != 30 {
		t.Fatalf("daily prompt_tokens = %d, want 30", dTokens)
	}
	var mRows int
	if err := db.QueryRow("SELECT COUNT(*) FROM usage_monthly WHERE model IN ('m1','m2') AND user_id=$1", uid).Scan(&mRows); err != nil {
		t.Fatal(err)
	}
	if mRows < 1 {
		t.Fatalf("usage_monthly rows = %d, want >=1", mRows)
	}
}

func TestCleanupUsageRetention(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	db.Exec("TRUNCATE TABLE usage RESTART IDENTITY CASCADE")
	if err := SetSetting(db, RetentionMonthsSetting, "1"); err != nil {
		t.Fatal(err)
	}
	uid := mustUserID(t, db)
	// 上月一条(会被保留 1 个月 = 不删);上月-1 一条(会删)
	// 月份归一化到每月 1 号:AddDate(0,-2,0) 在月末(如 8/31 → 6/31→7/1)会
	// 因天数溢出折进保留月,导致日期相关 flake(2026-08-31 实测复现)。
	now := time.Now()
	older := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC).AddDate(0, -2, 0)
	if err := ensureUsagePartition(db, older); err != nil {
		t.Fatal(err)
	}
	if _, err := RecordUsage(db, uid, "m-old", 1, 1); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("UPDATE usage SET created_at = $1 WHERE user_id = $2", older.Format("2006-01-02")+" 10:00:00", uid); err != nil {
		t.Fatal(err)
	}
	if err := CleanupUsageRetention(db); err != nil {
		t.Fatalf("CleanupUsageRetention: %v", err)
	}
	// 2 个月前的分区应被 DROP,记不到行
	var n int
	if err := db.QueryRow("SELECT COUNT(*) FROM usage").Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("usage rows after retention = %d, want 0 (2-month-old partition dropped)", n)
	}
}

// TestRebuildUsageLedgerPartialWindowKeepsMonthly 覆盖 2026-09-01 审计 B2:
// 启动补算窗口(from = now.AddDate(0,-N,0),非整月对齐;to = now)不得把边界
// 月月账覆盖为"仅窗口内几天"的部分和——月账聚合必须按整月边界进行,
// usage_daily 保留的旧日数据使结果单调收敛。
func TestRebuildUsageLedgerPartialWindowKeepsMonthly(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	db.Exec("TRUNCATE TABLE usage RESTART IDENTITY CASCADE")
	uid := mustUserID(t, db)
	// 固定月份(2026-03,避开真实时间):3/1 与 3/5 各一条明细。
	day1 := time.Date(2026, 2, 28, 10, 0, 0, 0, time.UTC) // 月末基准(防 3/1 溢出)
	day1 = time.Date(2026, 3, 1, 10, 0, 0, 0, time.UTC)
	day5 := time.Date(2026, 3, 5, 10, 0, 0, 0, time.UTC)
	if err := ensureUsagePartition(db, time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC)); err != nil {
		t.Fatal(err)
	}
	if _, err := recordUsageKindAt(db, uid, "m", 100, 10, "chat", day1); err != nil {
		t.Fatal(err)
	}
	if _, err := recordUsageKindAt(db, uid, "m", 100, 10, "chat", day5); err != nil {
		t.Fatal(err)
	}
	// 基线:整月重建 → 月账 requests=2。
	marStart := time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC)
	marEnd := time.Date(2026, 3, 31, 23, 59, 59, 0, time.UTC)
	if err := RebuildUsageLedger(db, marStart, marEnd); err != nil {
		t.Fatalf("full-month rebuild: %v", err)
	}
	if n := monthlyRequests(t, db, uid, "m", "2026-03-01"); n != 2 {
		t.Fatalf("full-month monthly requests=%d, want 2", n)
	}
	// 模拟启动补算:from = 3/5(非整月对齐),to = 3/10(月中)。
	if err := RebuildUsageLedger(db, time.Date(2026, 3, 5, 0, 0, 0, 0, time.UTC), time.Date(2026, 3, 10, 23, 59, 59, 0, time.UTC)); err != nil {
		t.Fatalf("partial-window rebuild: %v", err)
	}
	if n := monthlyRequests(t, db, uid, "m", "2026-03-01"); n != 2 {
		t.Fatalf("BUG: partial-window rebuild overwrote monthly ledger (requests=%d, want 2)", n)
	}
	// 再验证月账含 3/1 那笔(次数),日账同样完好。
	var d int64
	if err := db.QueryRow("SELECT prompt_tokens FROM usage_daily WHERE user_id=$1 AND model='m' ORDER BY day LIMIT 1", uid).Scan(&d); err != nil {
		t.Fatalf("daily: %v", err)
	}
	if d != 100 {
		t.Fatalf("daily prompt_tokens=%d, want 100", d)
	}
}

func monthlyRequests(t *testing.T, db *sql.DB, uid int64, model, month string) int64 {
	t.Helper()
	var n int64
	if err := db.QueryRow("SELECT COALESCE(SUM(requests),0) FROM usage_monthly WHERE user_id=$1 AND model=$2 AND month=$3::date", uid, model, month).Scan(&n); err != nil {
		t.Fatalf("query monthly: %v", err)
	}
	return n
}
