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
	lastMonthAt := BeijingDayAt(bjMonth(1), 12) // 北京上月 1 日 12:00(必属上月)
	setCreatedAtAt(t, db, 3, lastMonthAt)
	// 重建账本(近 2 月;边界用北京日)
	if err := RebuildUsageLedger(db, bjDay(60), bjDay(0)); err != nil {
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
	// 上月-1(北京 2 个月前)一条:保留 1 个月 → 该月分区会被 DROP。
	// bjMonth 直接取北京月首(不依赖进程 TZ,也不会像 AddDate 在月末溢出)。
	older := bjMonth(2)
	id, err := RecordUsage(db, uid, "m-old", 1, 1)
	if err != nil {
		t.Fatal(err)
	}
	setCreatedAtAt(t, db, id, BeijingDayAt(older, 10))
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

// TestUsageAggregateWithLedgerSumsAcrossRetention 覆盖 P1-10:跨保留期时
// 账本负责 [from, cutoff) 的整日、明细负责 [cutoff, to],两段必须按维度**相加**。
// 旧实现账本查整窗口、明细只查 [cutoff,to] 再按 label 覆盖 → 早于 cutoff 的
// 历史整条丢失(实测 330 → 220)。
func TestUsageAggregateWithLedgerSumsAcrossRetention(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	db.Exec("TRUNCATE TABLE usage RESTART IDENTITY CASCADE")
	if err := SetSetting(db, RetentionMonthsSetting, "6"); err != nil {
		t.Fatal(err)
	}
	uid := mustUserID(t, db)

	// 8 个月前 110 tokens:明细分区已过期(这里用 DELETE 模拟 DROP),仅账本有
	oldMonth := bjMonth(8)
	if err := ensureUsagePartition(db, oldMonth); err != nil {
		t.Fatal(err)
	}
	if _, err := recordUsageKindAt(db, uid, "m-old", 110, 0, "chat", oldMonth.AddDate(0, 0, 2).Add(10*time.Hour)); err != nil {
		t.Fatal(err)
	}
	// 1 个月前 220 tokens:仍在保留窗口内(明细)
	recent := bjMonth(1)
	if err := ensureUsagePartition(db, recent); err != nil {
		t.Fatal(err)
	}
	if _, err := recordUsageKindAt(db, uid, "m-recent", 220, 0, "chat", recent); err != nil {
		t.Fatal(err)
	}
	// 账本生成后删掉 8 个月前的明细(等价于 CleanupUsageRetention DROP 分区)
	if err := RebuildUsageLedger(db, oldMonth, oldMonth.AddDate(0, 1, -1)); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("DELETE FROM usage WHERE model = 'm-old'"); err != nil {
		t.Fatal(err)
	}

	rows, err := UsageAggregateWithLedger(db, oldMonth, bjDay(0), "user")
	if err != nil {
		t.Fatalf("UsageAggregateWithLedger: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("rows = %+v, want exactly 1 user row", rows)
	}
	if rows[0].PromptTokens != 330 {
		t.Fatalf("group=user tokens = %d, want 330 (110 账本 + 220 明细,相加而非覆盖)", rows[0].PromptTokens)
	}
}

// TestUsageAggregateWithLedgerModelAndWeek 覆盖 P1-16:账本回退时
// group=model 必须按模型分组(旧实现默认分支 col=month → 所有模型合并成
// 「每月一行」)、group=week 必须按周一分桶(旧实现退化成逐日)。
func TestUsageAggregateWithLedgerModelAndWeek(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	db.Exec("TRUNCATE TABLE usage RESTART IDENTITY CASCADE")
	if err := SetSetting(db, RetentionMonthsSetting, "1"); err != nil {
		t.Fatal(err)
	}
	uid := mustUserID(t, db)

	// 固定 2026-03:3/2(周一)与 3/10(周二,所在周周一 = 3/9)
	marStart := time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC)
	if err := ensureUsagePartition(db, marStart); err != nil {
		t.Fatal(err)
	}
	d1 := time.Date(2026, 3, 2, 10, 0, 0, 0, time.UTC)
	d2 := time.Date(2026, 3, 10, 10, 0, 0, 0, time.UTC)
	if _, err := recordUsageKindAt(db, uid, "m1", 100, 0, "chat", d1); err != nil {
		t.Fatal(err)
	}
	if _, err := recordUsageKindAt(db, uid, "m2", 200, 0, "chat", d2); err != nil {
		t.Fatal(err)
	}
	if err := RebuildUsageLedger(db, marStart, time.Date(2026, 3, 31, 0, 0, 0, 0, time.UTC)); err != nil {
		t.Fatal(err)
	}
	// 模拟明细分区已过期:只留账本
	if _, err := db.Exec("DELETE FROM usage"); err != nil {
		t.Fatal(err)
	}
	marEnd := time.Date(2026, 3, 31, 0, 0, 0, 0, time.UTC)

	modelRows, err := UsageAggregateWithLedger(db, marStart, marEnd, "model")
	if err != nil {
		t.Fatalf("model: %v", err)
	}
	byModel := map[string]int64{}
	for _, r := range modelRows {
		byModel[r.Label] = r.PromptTokens
	}
	if len(byModel) != 2 || byModel["m1"] != 100 || byModel["m2"] != 200 {
		t.Fatalf("group=model ledger rows = %+v, want m1=100 m2=200 (不得合并成每月一行)", modelRows)
	}

	weekRows, err := UsageAggregateWithLedger(db, marStart, marEnd, "week")
	if err != nil {
		t.Fatalf("week: %v", err)
	}
	byWeek := map[string]int64{}
	for _, r := range weekRows {
		byWeek[r.Label] = r.PromptTokens
	}
	if len(byWeek) != 2 || byWeek["2026-03-02"] != 100 || byWeek["2026-03-09"] != 200 {
		t.Fatalf("group=week ledger rows = %+v, want 2026-03-02=100 2026-03-09=200 (按周一)", weekRows)
	}
}

// TestUsageAggregateDeptFilterArrayParam 覆盖 P2-7 的 SQL 形状:部门过滤
// 不再拼 IN(?,?,…),而是子查询 + 数组参数(见 pgInt64Array);此处验证
// 大规模成员集合能正常聚合(旧实现 66000 个占位参数会撞 PG 65535 上限)。
func TestUsageAggregateManyMembersArrayParam(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	db.Exec("TRUNCATE TABLE usage RESTART IDENTITY CASCADE")
	uid := mustUserID(t, db)
	dept := mustDept(t, db, "大部门", 0)
	if _, err := RecordUsage(db, uid, "m1", 42, 0); err != nil {
		t.Fatal(err)
	}
	// 6.6 万个成员(user_groups 无外键,批量插入即可)
	if _, err := db.Exec(`INSERT INTO user_groups (user_id, group_id)
		SELECT g + 1000000, $1 FROM generate_series(1, 66000) g`, dept); err != nil {
		t.Fatal(err)
	}
	// 真实成员也在部门内(过滤命中该用户)
	if _, err := db.Exec(`INSERT INTO user_groups (user_id, group_id) VALUES ($1, $2)`, uid, dept); err != nil {
		t.Fatal(err)
	}
	ids, err := DeptUserIDsByName(db, "大部门")
	if err != nil {
		t.Fatalf("DeptUserIDsByName: %v", err)
	}
	if len(ids) != 66001 {
		t.Fatalf("members = %d, want 66001", len(ids))
	}
	// 部门聚合过滤(展示层 WithDept;成员集合走数组参数,不撞 PG 参数上限)
	rows, err := UsageAggregateWithLedger(db, bjDay(1), bjDay(0), "model", WithDept("大部门"))
	if err != nil {
		t.Fatalf("UsageAggregate WithDept with 66001 members: %v", err)
	}
	if len(rows) != 1 || rows[0].PromptTokens != 42 {
		t.Fatalf("WithDept rows = %+v, want m1 42 tokens", rows)
	}
}

// TestUsageAggregateWithLedgerWindowOutsideRetention 窗口整体早于保留边界:
// 只走账本,且不得把窗口外的数据带进来(账本段上界 = min(cutoff-1, to))。
func TestUsageAggregateWithLedgerWindowOutsideRetention(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	db.Exec("TRUNCATE TABLE usage RESTART IDENTITY CASCADE")
	if err := SetSetting(db, RetentionMonthsSetting, "6"); err != nil {
		t.Fatal(err)
	}
	uid := mustUserID(t, db)
	monthStartOf := func(off int) time.Time { return bjMonth(-off) }
	m8, m7, m1 := monthStartOf(-8), monthStartOf(-7), monthStartOf(-1)
	for _, tc := range []struct {
		month time.Time
		tok   int64
	}{{m8, 110}, {m7, 220}, {m1, 330}} {
		if err := ensureUsagePartition(db, tc.month); err != nil {
			t.Fatal(err)
		}
		if _, err := recordUsageKindAt(db, uid, "m", tc.tok, 0, "chat", tc.month.AddDate(0, 0, 2).Add(10*time.Hour)); err != nil {
			t.Fatal(err)
		}
	}
	if err := RebuildUsageLedger(db, m8, m7.AddDate(0, 1, -1)); err != nil {
		t.Fatal(err)
	}
	rows, err := UsageAggregateWithLedger(db, m8, m8.AddDate(0, 1, -1), "user")
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].PromptTokens != 110 {
		t.Fatalf("rows = %+v, want 仅 8 个月前 110 tokens", rows)
	}
}

// F11 回归(复核):上次 DETACH 成功但 DROP 失败留下的**孤儿表**必须被清理,
// 而不是让清理循环静默 continue 卡死(旧实现把所有 DETACH 错误都当"已删过")。
func TestCleanupUsageRetentionDropsOrphanDetachedTable(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	db.Exec("TRUNCATE TABLE usage RESTART IDENTITY CASCADE")
	if err := SetSetting(db, RetentionMonthsSetting, "1"); err != nil {
		t.Fatal(err)
	}
	uid := mustUserID(t, db)
	older := bjMonth(2)
	id, err := RecordUsage(db, uid, "m-orphan", 1, 1)
	if err != nil {
		t.Fatal(err)
	}
	setCreatedAtAt(t, db, id, BeijingDayAt(older, 10))
	// 先按真实顺序生成日账(清理会在 DROP 前校验/重建账本)。
	if err := RebuildUsageLedger(db, older, older.AddDate(0, 1, -1)); err != nil {
		t.Fatal(err)
	}
	// 模拟孤儿:分区被 DETACH 但 DROP 失败。
	if _, err := db.Exec("ALTER TABLE usage DETACH PARTITION usage_" + older.Format("200601")); err != nil {
		t.Fatalf("detach: %v", err)
	}
	if err := CleanupUsageRetention(db); err != nil {
		t.Fatalf("CleanupUsageRetention with orphan table: %v", err)
	}
	var exists bool
	if err := db.QueryRow(`SELECT EXISTS(SELECT 1 FROM pg_class WHERE relname = ?)`, "usage_"+older.Format("200601")).Scan(&exists); err != nil {
		t.Fatal(err)
	}
	if exists {
		t.Fatalf("orphan detached table usage_%s still exists after cleanup", older.Format("200601"))
	}
}
