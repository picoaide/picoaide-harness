package serverstore

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

// 本文件是 R9C-2（审计 2026-09-24，第九轮 C 泳道，P2）的回归：R8-A-2/R8-D-1 的
// "良性竞态"归类只补了 5 个窗口里的 2 个 —— W3（`cleanupDetachedUsageTable` 的
// `detailMonthsOutside`）、W4（同函数的 `retentionBackfill`）、W5（分区路径 DETACH
// 之后的 `SELECT relispartition` 过渡态）仍会把"关系已被另一个清理轮次回收"记成失败，
// 于是 4 路并发清理会出现"整轮非 nil"，管理端保存保留期偶发 500「保留清理失败」。
//
// 修复形态：良性判据收进**唯一出口** `usageFailureIsBenignRace`（判据 = catalog 事实
// "该关系此刻已不存在"），W5 由 reclaimUsagePartitionAtomically 的
// `usageReclaimNotAttached` 分支结构化收口。
//
// 复跑：
//
//	cd server && PG_DSN_TEST=... go test ./internal/serverstore/ -run 'TestR9C2' -count=1 -v

// r9c2ResetUsageMonthRelations 给夹具一个干净起点：摘掉 usage 的全部直接子分区，
// 并删掉所有 `usage_<6 位数字>` 关系（模板库预建了 2026-01..now+6 的月分区，
// 留着会变成噪声孤儿）。
func r9c2ResetUsageMonthRelations(t *testing.T, db *sql.DB) {
	t.Helper()
	r7aDropDirectUsagePartitions(t, db)
	rows, err := db.Query(`SELECT c.relname FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname ~ '^usage_[0-9]{6}$'`)
	if err != nil {
		t.Fatalf("枚举 usage_<月> 关系: %v", err)
	}
	var names []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			rows.Close()
			t.Fatal(err)
		}
		names = append(names, name)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	for _, name := range names {
		r9aDropRelation(t, db, name)
	}
}

// r9c2Row 是夹具里的一行明细 + 它应当在永久日账里留下的期望。
type r9c2Row struct {
	model string
	day   time.Time
	cost  float64
}

// r9c2LedgerCost 直接读永久日账某模型某天的金额（物理事实）。
func r9c2LedgerCost(t *testing.T, db *sql.DB, day time.Time, model string) (int64, float64) {
	t.Helper()
	var n int64
	var cost sql.NullFloat64
	if err := db.QueryRow(`SELECT count(*), COALESCE(sum(cost), 0) FROM usage_daily
WHERE day = ?::date AND model = ?`, day.Format(dateFmt), model).Scan(&n, &cost); err != nil {
		t.Fatalf("读日账: %v", err)
	}
	return n, cost.Float64
}

// r9c2InsertRow 往指定关系里插一行（关系可以是真分区，也可以是表形态孤儿）。
func r9c2InsertRow(t *testing.T, db *sql.DB, rel string, uid int64, row r9c2Row) {
	t.Helper()
	if _, err := db.Exec(`INSERT INTO `+r6Quote(rel)+` (user_id, model, prompt_tokens, completion_tokens, kind, cost, created_at, estimated)
VALUES (?, ?, 10, 10, 'chat', ?, ?, FALSE)`, uid, row.model, row.cost, BeijingDayAt(dayKey(row.day), 3)); err != nil {
		t.Fatalf("插入 %s: %v", rel, err)
	}
}

// r9c2Entry 是夹具里的一条关系：它是不是孤儿、以及它持有的那一行。
type r9c2Entry struct {
	rel    string
	orphan bool
	row    r9c2Row
}

// r9c2Fixture 建出"若干到期真分区 + 若干表形态孤儿"的夹具（按月份从新到旧排列）：
//   - orphan=false：仍挂在 usage 下的到期月分区（走 attached 路径）
//   - orphan=true ：已被 DETACH 的表形态关系（走孤儿路径 ⇒ W1..W4）
func r9c2Fixture(t *testing.T, db *sql.DB) []r9c2Entry {
	t.Helper()
	r9c2ResetUsageMonthRelations(t, db)
	if _, err := db.Exec("TRUNCATE TABLE usage RESTART IDENTITY CASCADE"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("TRUNCATE TABLE usage_daily"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("TRUNCATE TABLE usage_monthly"); err != nil {
		t.Fatal(err)
	}
	if err := SetSetting(db, RetentionMonthsSetting, "6"); err != nil {
		t.Fatal(err)
	}
	uid := mustUserID(t, db)
	now := BeijingMonth(time.Now())
	var entries []r9c2Entry
	// 3 个到期月分区（attached）+ 2 个到期月孤儿（DETACH 后的表）。
	specs := []struct {
		monthsAgo int
		orphan    bool
		model     string
		cost      float64
	}{
		{7, false, "m-r9c2-p1", 1.5},
		{8, false, "m-r9c2-p2", 2.5},
		{9, false, "m-r9c2-p3", 3.5},
		{10, true, "m-r9c2-o1", 4.5},
		{11, true, "m-r9c2-o2", 5.5},
	}
	for _, s := range specs {
		m := now.AddDate(0, -s.monthsAgo, 0)
		if err := ensureUsagePartition(db, m); err != nil {
			t.Fatalf("建 %s 分区: %v", monthKey(m), err)
		}
		rel := "usage_" + monthKey(m)
		row := r9c2Row{model: s.model, day: m, cost: s.cost}
		r9c2InsertRow(t, db, rel, uid, row)
		if s.orphan {
			if _, err := db.Exec("ALTER TABLE usage DETACH PARTITION " + r6Quote(rel)); err != nil {
				t.Fatalf("摘 %s 造成孤儿: %v", rel, err)
			}
		}
		entries = append(entries, r9c2Entry{rel: rel, orphan: s.orphan, row: row})
	}
	// 前置：日账此刻应为空（金额只能由清理路径补进来）。
	for _, e := range entries {
		if n, _ := r9c2LedgerCost(t, db, e.row.day, e.row.model); n != 0 {
			t.Fatalf("前置失败：日账里已经有 %s 的钱（夹具不干净）", e.row.model)
		}
	}
	return entries
}

// r9c2Orphans / r9c2LedgerOf 是夹具的两个投影（读起来比在用例里现算清楚）。
func r9c2Orphans(entries []r9c2Entry) []string {
	var out []string
	for _, e := range entries {
		if e.orphan {
			out = append(out, e.rel)
		}
	}
	return out
}

func r9c2LedgerOf(entries []r9c2Entry) map[string]r9c2Row {
	out := map[string]r9c2Row{}
	for _, e := range entries {
		out[e.row.model] = e.row
	}
	return out
}

func r9c2ByRel(entries []r9c2Entry, rel string) r9c2Row {
	for _, e := range entries {
		if e.rel == rel {
			return e.row
		}
	}
	return r9c2Row{}
}

// r9c2AssertLedgerConsistent 断言"每一行明细都已进永久账本，且没有被算两遍"。
func r9c2AssertLedgerConsistent(t *testing.T, db *sql.DB, ledger map[string]r9c2Row, when string) {
	t.Helper()
	for model, want := range ledger {
		n, cost := r9c2LedgerCost(t, db, want.day, model)
		if n != 1 || cost < want.cost-1e-9 || cost > want.cost+1e-9 {
			t.Fatalf("%s：日账不自洽（期望 1 行 / %.4f，实得 %d 行 / %.4f）", when, want.cost, n, cost)
		}
	}
}

// TestR9C2OverlappingCleanupRoundsReturnNil 是 R9C-2 的**并发**判据：多分区 + 孤儿，
// 4 路重叠清理，每一路都必须返回 nil，且账本自洽（每行各一次）。
//
// 判据刻意放在"每路返回 nil"上：受损的不是金额（并发后账本仍等于真值），而是运维面
// —— 任一非 nil 都会让管理端保存保留期偶发 500、调度器每轮 cleanup failed，真实失败
// 被 42P01 噪声淹没。
func TestR9C2OverlappingCleanupRoundsReturnNil(t *testing.T) {
	const rounds, ensembles = 4, 3
	for e := 0; e < ensembles; e++ {
		t.Run(fmt.Sprintf("ensemble_%d", e), func(t *testing.T) {
			db, cleanup := NewTestDB(t)
			defer cleanup()
			entries := r9c2Fixture(t, db)
			orphans := r9c2Orphans(entries)
			ledger := r9c2LedgerOf(entries)
			t.Logf("SETUP 3 个到期真分区 + %d 个表形态孤儿（%s）", len(orphans), strings.Join(orphans, ","))

			errs := make([]error, rounds)
			start := make(chan struct{})
			var wg sync.WaitGroup
			for i := 0; i < rounds; i++ {
				wg.Add(1)
				go func(i int) {
					defer wg.Done()
					<-start
					errs[i] = CleanupUsageRetention(db)
				}(i)
			}
			close(start)
			wg.Wait()

			nonNil := 0
			for i, err := range errs {
				if err != nil {
					nonNil++
					t.Errorf("第 %d 路返回非 nil（R9C-2：重叠轮次必须良性）: %v", i+1, err)
				}
			}
			if nonNil > 0 {
				t.Fatalf("%d/%d 路非 nil", nonNil, rounds)
			}
			r9c2AssertLedgerConsistent(t, db, ledger, "4 路并发清理后")
			for _, rel := range orphans {
				if r9aRelationExists(t, db, rel) {
					t.Errorf("孤儿 %s 未被回收（并发下停摆）", rel)
				}
			}
		})
	}
}

// TestR9C2BenignRaceClassification 钉死"良性竞态"的判据面（确定性，无并发）：
// 判据是 **catalog 事实**（该关系已不存在），不是错误串也不是 SQLSTATE 本身。
func TestR9C2BenignRaceClassification(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	now := BeijingMonth(time.Now())
	exists := "usage_" + monthKey(now.AddDate(0, -7, 0))
	r9c2ResetUsageMonthRelations(t, db)
	if err := ensureUsagePartition(db, now.AddDate(0, -7, 0)); err != nil {
		t.Fatal(err)
	}

	// 一个**真实**的 42P01（引用一个不存在的兄弟关系），但被处理的关系还在。
	var real42P01 error
	if err := db.QueryRow("SELECT 1 FROM usage_r9c2_no_such_relation").Scan(new(int)); err != nil {
		real42P01 = err
	} else {
		t.Fatal("前置失败：没有拿到真实的 42P01")
	}
	if !strings.Contains(fmt.Sprint(real42P01), "42P01") {
		t.Fatalf("前置失败：期望 42P01，实得 %v", real42P01)
	}

	if usageFailureIsBenignRace(db, exists, nil) {
		t.Fatal("nil 错误不得判良性")
	}
	if usageFailureIsBenignRace(db, exists, errors.New("boom")) {
		t.Fatal("关系还在时的普通错误不得判良性")
	}
	if usageFailureIsBenignRace(db, exists, real42P01) {
		t.Fatal("42P01 但被处理的关系还在 ⇒ 必须 fail-loud（例如账本关系缺表）")
	}

	// 关系真的消失之后：同一个 42P01 判良性（含被 %w 包裹的形态）。
	gone := "usage_" + monthKey(now.AddDate(0, -8, 0))
	if err := ensureUsagePartition(db, now.AddDate(0, -8, 0)); err != nil {
		t.Fatal(err)
	}
	r9aDropRelation(t, db, gone)
	if !usageFailureIsBenignRace(db, gone, real42P01) {
		t.Fatal("关系已不存在 ⇒ 必须判良性（R8-A-2/R8-D-1 口径）")
	}
	if !usageFailureIsBenignRace(db, gone, fmt.Errorf("scan detail months of %s: %w", gone, real42P01)) {
		t.Fatal("良性判据必须能穿透 %w 包装的错误")
	}
}

// TestR9C2VanishBetweenStatementsIsBenign 是 W3/W4 的**确定性**复现：
// 用 cleanupDetachedStepHook 把清理精确停在两条语句之间，另一条连接把该关系 DROP 掉
// （这正是 4 路并发里自然发生的 TOCTOU），再放行 —— 整轮必须返回 nil。
//
//	W3 = min/max 探测之后、detailMonthsOutside 之前
//	W4 = detailMonthsOutside 与相邻月并入之后、retentionBackfill 之前
func TestR9C2VanishBetweenStatementsIsBenign(t *testing.T) {
	for _, step := range []string{"detail-months", "backfill"} {
		t.Run(step, func(t *testing.T) {
			db, cleanup := NewTestDB(t)
			defer cleanup()
			entries := r9c2Fixture(t, db)
			orphans := r9c2Orphans(entries)
			victim := orphans[0]
			other := orphans[1]

			steps := make(chan string, 8)
			release := make(chan struct{}, 8)
			cleanupDetachedStepHook = func(rel, gotStep string) {
				if rel != victim {
					return // 其它关系不拦
				}
				steps <- gotStep
				<-release
			}
			t.Cleanup(func() { cleanupDetachedStepHook = nil })

			done := make(chan error, 1)
			go func() { done <- CleanupUsageRetention(db) }()

			dropped := false
			deadline := time.After(30 * time.Second)
			for !dropped {
				select {
				case got := <-steps:
					if got == step {
						// 交错点：清理尚未执行这一步，关系此刻还在（且清理不持它的锁）。
						if _, err := db.Exec("DROP TABLE " + r6Quote(victim)); err != nil {
							t.Fatalf("在 %s 窗口内 DROP %s: %v", step, victim, err)
						}
						dropped = true
						t.Logf("R9C2 在 %s 窗口内把 %s 交给了并发轮次（已 DROP）", step, victim)
					}
					release <- struct{}{}
				case <-deadline:
					t.Fatalf("清理没有到达 %s 挂钩（用例装置失效）", step)
				}
			}
			err := <-done
			st := CurrentUsageRetentionStatus()
			t.Logf("round err=%v failures=%d skipped=%d cleared=%d", err, st.Failures, st.Skipped, st.ClearedPartitions)
			if err != nil {
				t.Fatalf("关系在 %s 窗口被并发回收 ⇒ 本轮必须良性返回 nil（R9C-2 的 W3/W4）: %v", step, err)
			}
			if st.Failures != 0 {
				t.Fatalf("良性竞态不得计入失败: failures=%d", st.Failures)
			}
			// 另一个孤儿照常被回收，它的钱照常进账本。
			if r9aRelationExists(t, db, other) {
				t.Errorf("与竞态无关的孤儿 %s 未被回收", other)
			}
			want := r9c2ByRel(entries, other)
			if n, cost := r9c2LedgerCost(t, db, want.day, want.model); n != 1 || cost < want.cost-1e-9 {
				t.Errorf("与竞态无关的孤儿金额没进账本: rows=%d cost=%.4f", n, cost)
			}
		})
	}
}

// TestR9C2ReclaimDefersConcurrentlyDetachedRelation 覆盖 W5 的过渡态（确定性）：
// 扫描时还是 usage 的直接子分区、动手时已被另一个轮次摘下来的关系，临界区必须
// **良性且不 DROP**（它的行没进这一轮的补账 ⇒ DROP 就是金额丢失），留给下一轮的
// 孤儿路径补账后回收。
func TestR9C2ReclaimDefersConcurrentlyDetachedRelation(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	now := BeijingMonth(time.Now())
	m := now.AddDate(0, -7, 0)
	r9c2ResetUsageMonthRelations(t, db)
	if _, err := db.Exec("TRUNCATE TABLE usage RESTART IDENTITY CASCADE"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("TRUNCATE TABLE usage_daily"); err != nil {
		t.Fatal(err)
	}
	if err := SetSetting(db, RetentionMonthsSetting, "6"); err != nil {
		t.Fatal(err)
	}
	if err := ensureUsagePartition(db, m); err != nil {
		t.Fatal(err)
	}
	rel := "usage_" + monthKey(m)
	uid := mustUserID(t, db)
	row := r9c2Row{model: "m-r9c2-w5", day: m, cost: 7.25}
	r9c2InsertRow(t, db, rel, uid, row)

	// 另一个清理轮次先把它摘下来（提交）：此刻它是"表形态孤儿"，行还在。
	if _, err := db.Exec("ALTER TABLE usage DETACH PARTITION " + r6Quote(rel)); err != nil {
		t.Fatal(err)
	}
	res := reclaimUsagePartitionAtomically(db, rel, usageRelationShape{Kind: "r", Parent: "usage"}, BeijingMonth(time.Now()).AddDate(0, -6, 0))
	t.Logf("跨界关系 %s 的临界区结果: outcome=%d op=%s err=%v", rel, res.outcome, res.op, res.err)
	if res.outcome != usageReclaimNotAttached {
		t.Fatalf("已被摘下的关系必须良性返回 usageReclaimNotAttached，实得 outcome=%d err=%v", res.outcome, res.err)
	}
	if !r9aRelationExists(t, db, rel) {
		t.Fatalf("已被并发轮次摘下的关系**不得**在本轮 DROP（它的行还没进账本）: %s 已消失", rel)
	}
	// 下一轮（孤儿路径）必须把它正常回收，并把钱补进账本。
	if err := CleanupUsageRetention(db); err != nil {
		t.Fatalf("下一轮清理必须成功: %v", err)
	}
	if r9aRelationExists(t, db, rel) {
		t.Fatalf("下一轮未回收孤儿 %s", rel)
	}
	if n, cost := r9c2LedgerCost(t, db, row.day, row.model); n != 1 || cost < row.cost-1e-9 {
		t.Fatalf("孤儿的金额没有补进永久账本: rows=%d cost=%.4f", n, cost)
	}
}
