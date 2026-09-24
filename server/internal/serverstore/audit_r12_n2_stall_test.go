package serverstore

// R12-N2 · P1-01 回归：`reclaim_stalled` 只反映**真的停摆**。
//
// 被审形态（origin/master @ 12540e681c，R12-A 的 P1-01，探针 TestR12AQ4*）：
//
//	① `reclaim_stalled` 由 `oldest_unreclaimed_*` 的**月龄**推导，而月龄是保留期的
//	   纯函数（`due_since`）⇒ **单轮** 5s 锁竞争（`failures=0`、`deferred_streak=1`、
//	   `deferred_stalled=false`）就把这个"跨重启停摆位"置真，下一轮成功即回落
//	   —— 告警抖动，24h 阈值失去区分力；
//	② 按设计的跳过（子树里还有保留期内的行 `subtree-retained`、多级布局的深层后代
//	   `descendant`、非表对象占名 `non-table`…）**永远不会**被自动回收 ⇒ 宽/嵌套/
//	   多级布局（本项目**显式支持**的形态）的部署会长期挂着 `reclaim_stalled=true`，
//	   真正的停摆被假阳性淹没。
//
// 本文件的判据（修复后必须成立）：
//
//	A. 按设计跳过的形态两轮之后仍 `reclaim_stalled=false`，且它们在**另一个**面
//	   （`needs_manual_months`）被点名 —— 不是"什么都不报"；
//	B. 单轮锁竞争延后不得置真（`reclaim_blocked_reason=lock-timeout`、
//	   `reclaim_blocked_rounds=1`）；
//	C. **对照**：真失败（DROP 被依赖视图挡住）+ 逾期 ≥24h ⇒ 重启后第一轮仍必须为真
//	   （R11-D-03 的性质不得回退）；
//	D. **对照**：同一个到期月连续 4 个**调度轮次**被延后 ⇒ 置真；3 轮 ⇒ 不置真；
//	   相隔 65min 的非调度轮次无论多少轮都不置真。
//
// 复跑：
//
//	cd server && PG_DSN_TEST=postgres://postgres:postgres@127.0.0.1:5432/r12n2 \
//	  go test ./internal/serverstore/ -run 'TestAuditR12N2' -count=1 -v

import (
	"database/sql"
	"fmt"
	"testing"
	"time"
)

// n2DropMonth 摘掉并删除 usage_<m>（造错位/缺失布局用）。
func n2DropMonth(t *testing.T, db *sql.DB, m time.Time) {
	t.Helper()
	rel := "usage_" + monthKey(m)
	_, _ = db.Exec("ALTER TABLE usage DETACH PARTITION " + quoteRelationIdent(rel))
	if _, err := db.Exec("DROP TABLE IF EXISTS " + quoteRelationIdent(rel)); err != nil {
		t.Fatalf("drop %s: %v", rel, err)
	}
}

// n2Reset 清空三张明细/账本表。
func n2Reset(t *testing.T, db *sql.DB) {
	t.Helper()
	for _, s := range []string{
		"TRUNCATE TABLE usage RESTART IDENTITY CASCADE",
		"TRUNCATE TABLE usage_daily RESTART IDENTITY CASCADE",
		"TRUNCATE TABLE usage_monthly RESTART IDENTITY CASCADE",
	} {
		if _, err := db.Exec(s); err != nil {
			t.Fatalf("重置夹具: %v", err)
		}
	}
}

// n2Round 造一轮**合成**的过程事实（只喂记账点，不碰数据库）——用于把"调度节奏"
// 精确地摆出来（真库里跑 4 个相隔 6h 的轮次不现实）。
func n2Round(at time.Time, rel, reason, cutoff string) usageRetentionRound {
	r := usageRetentionRound{
		EndedAt: at, Scanned: true, ConfiguredMonths: 2, ConfiguredMonthsKnown: true,
		CutoffMonth:     cutoff,
		Unreclaimed:     []string{rel + "(" + reason + ")"},
		SkippedByReason: map[string]int{reason: 1},
	}
	// 延后类必须同时出现在 DeferredRelations 里（真实轮次的 Unreclaimed 与
	// DeferredRelations 是同一个事实的两个投影，见 CleanupUsageRetention 的 noteSkip）。
	if usageSkipIsDeferral(reason) {
		r.DeferredRelations = []string{rel}
	}
	return r
}

// TestAuditR12N2DesignedSkipsDoNotStall 覆盖 P1-01 ②：按设计的跳过不得让停摆位长期为真。
func TestAuditR12N2DesignedSkipsDoNotStall(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	n2Reset(t, db)
	if err := SetSetting(db, RetentionMonthsSetting, "2"); err != nil {
		t.Fatal(err)
	}
	uid := mustUserID(t, db)

	t.Run("subtree-retained", func(t *testing.T) {
		// 父关系名义月 bjMonth(4)（早已到期），覆盖到 bjMonth(2)（= cutoff，仍在保留
		// 期内）⇒ 子树闸门命中：**按设计**保留，等子树内最后一个到期月被回收后本轮
		// 自动继续（R8-A-4）。
		m0, m1, m2 := bjMonth(4), bjMonth(3), bjMonth(2)
		parent := "usage_" + monthKey(m0)
		for _, m := range []time.Time{m0, m1, m2} {
			n2DropMonth(t, db, m)
		}
		if _, err := db.Exec(fmt.Sprintf(
			"CREATE TABLE %s PARTITION OF usage FOR VALUES FROM ('%s') TO ('%s') PARTITION BY RANGE (created_at)",
			quoteRelationIdent(parent), pgInstantArg(BeijingDayInstant(dayKey(m0))),
			pgInstantArg(BeijingDayInstant(dayKey(m2).AddDate(0, 1, 0))))); err != nil {
			t.Fatalf("建父关系: %v", err)
		}
		for _, m := range []time.Time{m1, m2} {
			if _, err := db.Exec(fmt.Sprintf("CREATE TABLE %s PARTITION OF %s FOR VALUES FROM ('%s') TO ('%s')",
				quoteRelationIdent("usage_"+monthKey(m)), quoteRelationIdent(parent),
				pgInstantArg(BeijingDayInstant(dayKey(m))), pgInstantArg(BeijingDayInstant(dayKey(m).AddDate(0, 1, 0))))); err != nil {
				t.Fatalf("建子分区: %v", err)
			}
		}
		usageRowAt(t, db, uid, "r12n2-a", BeijingDayAt(m1, 10), 2.0)
		usageRowAt(t, db, uid, "r12n2-a", BeijingDayAt(m2, 10), 4.0)

		for round := 1; round <= 2; round++ {
			if err := CleanupUsageRetention(db); err != nil {
				t.Fatalf("第 %d 轮清理: %v", round, err)
			}
		}
		st := CurrentUsageRetentionStatus()
		t.Logf("A/subtree-retained：skip=%v | needs_manual=%v(%d) | oldest=%s reason=%s age=%ds | reclaim_stalled=%v blocked=%s/%s/%d",
			st.SkippedByReason, st.NeedsManualMonths, st.NeedsManualCount,
			st.OldestUnreclaimedMonth, st.OldestUnreclaimedReason, st.OldestUnreclaimedAgeSeconds,
			st.ReclaimStalled, st.ReclaimBlockedMonth, st.ReclaimBlockedReason, st.ReclaimBlockedRounds)
		if st.ReclaimStalled {
			t.Errorf("子树闸门（按设计：等子树内最后一个到期月被回收后自动继续）让 `reclaim_stalled=true`"+
				"（oldest=%s age=%ds）—— 该形态下这个位会长期为真，把真停摆淹掉",
				st.OldestUnreclaimedMonth, st.OldestUnreclaimedAgeSeconds)
		}
		if st.ReclaimBlockedMonth != "" {
			t.Errorf("按设计跳过的形态不得进真停摆账（reclaim_blocked_month=%q reason=%q）",
				st.ReclaimBlockedMonth, st.ReclaimBlockedReason)
		}
		if st.NeedsManualCount == 0 {
			t.Errorf("按设计不回收的形态必须进 needs_manual_months（长期可观测）——实测为空（skip=%v）",
				st.SkippedByReason)
		}
	})

	t.Run("multi-level-descendant", func(t *testing.T) {
		year := bjMonth(6).Year()
		mid := fmt.Sprintf("usage_%d", year)
		leaves := []time.Time{bjMonth(6), bjMonth(5)}
		for _, m := range leaves {
			n2DropMonth(t, db, m)
		}
		if _, err := db.Exec(fmt.Sprintf(
			"CREATE TABLE %s PARTITION OF usage FOR VALUES FROM ('%s') TO ('%s') PARTITION BY RANGE (created_at)",
			quoteRelationIdent(mid), pgInstantArg(BeijingDayInstant(dayKey(leaves[0]))),
			pgInstantArg(BeijingDayInstant(dayKey(leaves[1]).AddDate(0, 1, 0))))); err != nil {
			t.Fatalf("建中间父表 %s: %v", mid, err)
		}
		for _, m := range leaves {
			if _, err := db.Exec(fmt.Sprintf("CREATE TABLE %s PARTITION OF %s FOR VALUES FROM ('%s') TO ('%s')",
				quoteRelationIdent("usage_"+monthKey(m)), quoteRelationIdent(mid),
				pgInstantArg(BeijingDayInstant(dayKey(m))), pgInstantArg(BeijingDayInstant(dayKey(m).AddDate(0, 1, 0))))); err != nil {
				t.Fatalf("建孙辈叶子: %v", err)
			}
		}
		for i, m := range leaves {
			usageRowAt(t, db, uid, "r12n2-b", BeijingDayAt(m, 10), float64(i+1))
		}
		for round := 1; round <= 2; round++ {
			if err := CleanupUsageRetention(db); err != nil {
				t.Fatalf("第 %d 轮清理: %v", round, err)
			}
		}
		st := CurrentUsageRetentionStatus()
		t.Logf("A/multi-level：skip=%v | needs_manual=%v(%d) | oldest=%s age=%ds | reclaim_stalled=%v blocked=%s/%s/%d",
			st.SkippedByReason, st.NeedsManualMonths, st.NeedsManualCount,
			st.OldestUnreclaimedMonth, st.OldestUnreclaimedAgeSeconds,
			st.ReclaimStalled, st.ReclaimBlockedMonth, st.ReclaimBlockedReason, st.ReclaimBlockedRounds)
		if st.ReclaimStalled {
			t.Errorf("多级布局的深层后代叶子按设计只补账、不 DETACH（`descendant`）⇒ `reclaim_stalled` 不得为真"+
				"（oldest=%s age=%ds）", st.OldestUnreclaimedMonth, st.OldestUnreclaimedAgeSeconds)
		}
		if st.NeedsManualCount == 0 {
			t.Errorf("多级布局的深层后代必须进 needs_manual_months（人工拆分区树）——实测为空（skip=%v）",
				st.SkippedByReason)
		}
	})

	t.Run("non-table-index", func(t *testing.T) {
		expired := bjMonth(4)
		n2DropMonth(t, db, expired)
		rel := "usage_" + monthKey(expired)
		if _, err := db.Exec("CREATE INDEX " + quoteRelationIdent(rel) + " ON public.usage (id)"); err != nil {
			t.Fatalf("造同名索引: %v", err)
		}
		t.Cleanup(func() { _, _ = db.Exec("DROP INDEX IF EXISTS public." + quoteRelationIdent(rel)) })
		if err := CleanupUsageRetention(db); err != nil {
			t.Fatalf("清理: %v", err)
		}
		st := CurrentUsageRetentionStatus()
		t.Logf("A/non-table：skip=%v | needs_manual=%v(%d) | reclaim_stalled=%v blocked=%q",
			st.SkippedByReason, st.NeedsManualMonths, st.NeedsManualCount, st.ReclaimStalled, st.ReclaimBlockedMonth)
		if st.ReclaimStalled {
			t.Errorf("非表对象占名按设计跳过（`non-table`，人工处置）⇒ `reclaim_stalled` 不得为真")
		}
	})
}

// TestAuditR12N2SingleContentionDoesNotStall 覆盖 P1-01 ①：**单轮**锁竞争不是停摆。
func TestAuditR12N2SingleContentionDoesNotStall(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	n2Reset(t, db)
	if err := SetSetting(db, RetentionMonthsSetting, "2"); err != nil {
		t.Fatal(err)
	}
	expired := bjMonth(5) // 早已到期（月龄 ≫ 24h —— 这正是旧判据被污染的原因）
	uid := mustUserID(t, db)
	if err := ensureUsagePartition(db, expired); err != nil {
		t.Fatal(err)
	}
	usageRowAt(t, db, uid, "r12n2-c", BeijingDayAt(expired, 10), 8.0)
	rel := "usage_" + monthKey(expired)

	side, err := openPG(r10f4DSNFor(r10gCurDB(t, db)))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { side.Close() })
	conn, err := side.Conn(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	if _, err := conn.ExecContext(t.Context(), "BEGIN"); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.ExecContext(t.Context(), "LOCK TABLE "+quoteRelationIdent(rel)+" IN ACCESS EXCLUSIVE MODE"); err != nil {
		t.Fatal(err)
	}
	cerr := CleanupUsageRetention(db) // 等锁 5s 超时 ⇒ 延后
	_, _ = conn.ExecContext(t.Context(), "ROLLBACK")

	st := CurrentUsageRetentionStatus()
	t.Logf("B：清理err=%v（nil = 延后不是失败）failures=%d skip=%v | deferred_streak=%d deferred_stalled=%v | "+
		"reclaim_stalled=%v blocked=%s/%s/%d age=%ds | oldest=%s age=%ds",
		cerr != nil, st.Failures, st.SkippedByReason, st.MaxDeferredStreak, st.DeferredStalled,
		st.ReclaimStalled, st.ReclaimBlockedMonth, st.ReclaimBlockedReason, st.ReclaimBlockedRounds,
		st.ReclaimBlockedAgeSeconds, st.OldestUnreclaimedMonth, st.OldestUnreclaimedAgeSeconds)
	if cerr != nil {
		t.Fatalf("锁竞争应当是**延后**（清理返回 nil），实得 %v", cerr)
	}
	if st.ReclaimBlockedReason != usageSkipLockTimeout {
		t.Fatalf("夹具/形态不符：真停摆账的原因=%q，want %q（skip=%v）",
			st.ReclaimBlockedReason, usageSkipLockTimeout, st.SkippedByReason)
	}
	if st.ReclaimBlockedRounds != 1 {
		t.Fatalf("单轮延后的 reclaim_blocked_rounds=%d，want 1", st.ReclaimBlockedRounds)
	}
	if st.ReclaimStalled {
		t.Errorf("**单轮** 5s 锁竞争（下一轮自愈）就把跨重启停摆位置真 —— 判据仍在读月龄"+
			"（reclaim_blocked_age_seconds=%ds）而不是「这个状态持续了多久」", st.ReclaimBlockedAgeSeconds)
	}
	if st.DeferredStalled {
		t.Errorf("单轮延后不得把 deferred_stalled 置真（streak=%d）", st.MaxDeferredStreak)
	}
}

// TestAuditR12N2FailedMonthStillStalls 是对照（C）：R11-D-03 的性质不得回退 ——
// 真失败 + 逾期 ≥24h ⇒ **重启后第一轮**仍必须置真。
func TestAuditR12N2FailedMonthStillStalls(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	n2Reset(t, db)
	if err := SetSetting(db, RetentionMonthsSetting, "2"); err != nil {
		t.Fatal(err)
	}
	expired := bjMonth(5)
	rel := "usage_" + monthKey(expired)
	uid := mustUserID(t, db)
	if err := ensureUsagePartition(db, expired); err != nil {
		t.Fatal(err)
	}
	usageRowAt(t, db, uid, "r12n2-d", BeijingDayAt(expired, 10), 3.75)
	if _, err := db.Exec("CREATE VIEW r12n2_dep_view AS SELECT id FROM " + quoteRelationIdent(rel)); err != nil {
		t.Fatalf("建依赖视图: %v", err)
	}
	t.Cleanup(func() { _, _ = db.Exec("DROP VIEW IF EXISTS r12n2_dep_view") })

	resetUsageRetentionStatusForTest() // "重启"
	_ = CleanupUsageRetention(db)
	st := CurrentUsageRetentionStatus()
	t.Logf("C：rounds=%d reclaim_stalled=%v blocked=%s/%s/%d due=%s age=%ds | failed=%v",
		st.RoundNumber, st.ReclaimStalled, st.ReclaimBlockedMonth, st.ReclaimBlockedReason,
		st.ReclaimBlockedRounds, st.ReclaimBlockedDueSince, st.ReclaimBlockedAgeSeconds, st.FailedRelations)
	if !containsRel(st.FailedRelations, rel) {
		t.Fatalf("夹具无效：%s 没有进 failed_relations（%v）", rel, st.FailedRelations)
	}
	if st.ReclaimBlockedReason != usageReclaimBlockedFailed {
		t.Fatalf("真停摆账的原因=%q，want %q", st.ReclaimBlockedReason, usageReclaimBlockedFailed)
	}
	if st.ReclaimBlockedAgeSeconds < int64(usageReclaimStallAfter/time.Second) {
		t.Fatalf("逾期时长=%ds，want ≥ %s（应由保留期推导，而不是靠进程内累积）",
			st.ReclaimBlockedAgeSeconds, usageReclaimStallAfter)
	}
	if !st.ReclaimStalled {
		t.Errorf("重启后第一轮必须能判「长期没回收」：reclaim_stalled=false（blocked=%s/%s/%d）"+
			"—— R11-D-03 的性质回退了", st.ReclaimBlockedMonth, st.ReclaimBlockedReason, st.ReclaimBlockedRounds)
	}
}

// TestAuditR12N2SustainedDeferralIsBoundedInRounds 是对照（D）：延后类的判据是
// **连续调度轮次**（单轮不告警、3 轮不告警、4 轮告警、非调度轮次永远不告警）。
func TestAuditR12N2SustainedDeferralIsBoundedInRounds(t *testing.T) {
	dueRel := "usage_" + monthKey(bjMonth(4)) // 比 cutoff 早 ⇒ "应回收"
	cutoff := monthKey(bjMonth(2))

	t.Run("scheduled-rounds-reach-threshold", func(t *testing.T) {
		resetUsageRetentionStatusForTest()
		at := time.Now().Add(-48 * time.Hour)
		wantFalse := usageReclaimStallRounds - 1
		for i := int64(0); i < wantFalse; i++ {
			at = at.Add(6 * time.Hour)
			recordUsageRetentionRound(n2Round(at, dueRel, usageSkipLockTimeout, cutoff), nil)
		}
		st := CurrentUsageRetentionStatus()
		t.Logf("D：%d 个调度轮次 ⇒ blocked_rounds=%d reclaim_stalled=%v（阈值 %d）",
			wantFalse, st.ReclaimBlockedRounds, st.ReclaimStalled, usageReclaimStallRounds)
		if st.ReclaimStalled {
			t.Fatalf("%d 轮就已置真（阈值 %d）：延后类的轮数判据过松", wantFalse, usageReclaimStallRounds)
		}
		at = at.Add(6 * time.Hour)
		recordUsageRetentionRound(n2Round(at, dueRel, usageSkipLockTimeout, cutoff), nil)
		st = CurrentUsageRetentionStatus()
		t.Logf("D：第 %d 个调度轮次 ⇒ blocked_rounds=%d reclaim_stalled=%v",
			usageReclaimStallRounds, st.ReclaimBlockedRounds, st.ReclaimStalled)
		if !st.ReclaimStalled {
			t.Fatalf("%d 个连续调度轮次仍未置真（blocked_rounds=%d）：真停摆漏报",
				usageReclaimStallRounds, st.ReclaimBlockedRounds)
		}
	})

	t.Run("non-scheduler-rounds-never-stall", func(t *testing.T) {
		resetUsageRetentionStatusForTest()
		at := time.Now().Add(-48 * time.Hour)
		for i := 0; i < 6; i++ { // 6 × 65min ≈ 5.4h（管理端连点保存/启动补跑的形态）
			at = at.Add(65 * time.Minute)
			recordUsageRetentionRound(n2Round(at, dueRel, usageSkipLockTimeout, cutoff), nil)
		}
		st := CurrentUsageRetentionStatus()
		t.Logf("D：6 个非调度轮次（65min 间隔）⇒ streak=%d blocked_rounds=%d reclaim_stalled=%v",
			st.MaxDeferredStreak, st.ReclaimBlockedRounds, st.ReclaimStalled)
		if st.ReclaimStalled {
			t.Errorf("非调度轮次把停摆位置真（blocked_rounds=%d）—— 告警读数取决于谁在调用清理",
				st.ReclaimBlockedRounds)
		}
	})

	t.Run("retained-month-never-stalls", func(t *testing.T) {
		// 保留期内（month >= cutoff）的月即使每轮被延后也不是"该回收而没回收"。
		resetUsageRetentionStatusForTest()
		retained := "usage_" + monthKey(bjMonth(1))
		at := time.Now().Add(-48 * time.Hour)
		for i := 0; i < 8; i++ {
			at = at.Add(6 * time.Hour)
			recordUsageRetentionRound(n2Round(at, retained, usageSkipLockTimeout, cutoff), nil)
		}
		st := CurrentUsageRetentionStatus()
		t.Logf("D：保留期内的月被延后 8 轮 ⇒ streak=%d blocked=%q reclaim_stalled=%v",
			st.MaxDeferredStreak, st.ReclaimBlockedMonth, st.ReclaimStalled)
		if st.ReclaimStalled {
			t.Errorf("仍在保留期内的月不得进真停摆账（blocked=%q rounds=%d）",
				st.ReclaimBlockedMonth, st.ReclaimBlockedRounds)
		}
	})
}

// n2ReportCost 是**产品读路径**给出的某北京月金额（明细在则读明细、明细已回收则回落
// 永久账本）——探针的金额判据一律走它，不看日志文本。
func n2ReportCost(t *testing.T, db *sql.DB, m time.Time) float64 {
	t.Helper()
	from := dayKey(BeijingMonth(m))
	rows, err := UsageAggregateWithLedger(db, from, from.AddDate(0, 1, -1), "model")
	if err != nil {
		t.Fatalf("UsageAggregateWithLedger(%s): %v", monthKey(m), err)
	}
	var sum float64
	for _, r := range rows {
		sum += r.Cost
	}
	return sum
}
