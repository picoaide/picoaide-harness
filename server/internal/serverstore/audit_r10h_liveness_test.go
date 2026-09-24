package serverstore

// R10-H3 泳道 · **W3-3（P3）**：延后 streak 的两条重置路径 ⇒ "长期没回收"不蕴含
// "必达 5 轮阈值"（W3 实测 `2 → 0`）。
//
// 两条路径（复审 W3 的 `TestW3C2`）：
//
//	① **早退轮**：`retention_months=0`（或读配置失败、catalog 扫描失败）时
//	   `CleanupUsageRetention` 在扫描之前就 return，本轮 DeferredRelations 为空 ⇒
//	   旧实现按"本轮延后清单"重建 streak ⇒ **清零**（即使那条关系还在盘上）。
//	② **真失败轮**：同一关系这轮记的是失败（DROP 被依赖对象挡住 2BP01）而不是延后
//	   ⇒ 同样清零。它这一轮**也没被回收**，但 streak 归零。
//
// 修法（本泳道选的是 W3 建议里的第二个：新增**单调**的"最早未回收到期月"）：
// 字段本身不因单轮动作回退 —— 早退轮/无证据轮**不动它**，失败轮也**不动它**
// （失败的那个月同样没被回收），只有该月真的被回收（或不再落在回收面内）才前移。
// 同时把 streak 的推进收在"有证据的轮次"上（早退轮不清零）。
//
// 判据（每条都能被打坏）：
//
//	H1 早退轮**不得**清零 streak、**不得**前移/清空 oldest_unreclaimed_*；
//	H2 失败轮：streak 按既有语义清零（它这一轮没被延后），但 oldest_unreclaimed_*
//	   必须仍然点名**那个月**，原因读作 failed（"超时/失败交替"绕不过它）；
//	H3 该月真的被回收之后，两个面都收敛（oldest 清空、streak 归零）。
//
// 复跑（真 PG）：
//
//	PG_DSN_TEST=postgres://postgres:postgres@127.0.0.1:5432/r10h3 \
//	  go test ./internal/serverstore/ -run 'TestR10HW3' -count=1 -v

import (
	"database/sql"
	"testing"
)

// TestR10HW3LivenessSurvivesResetPaths 是 W3-3 的判据。
func TestR10HW3LivenessSurvivesResetPaths(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	if _, err := db.Exec("TRUNCATE TABLE usage RESTART IDENTITY CASCADE"); err != nil {
		t.Fatal(err)
	}
	if err := SetSetting(db, RetentionMonthsSetting, "2"); err != nil {
		t.Fatal(err)
	}
	uid := mustUserID(t, db)
	expired := bjMonth(3)
	rel := "usage_" + monthKey(expired)
	expiredMonth := monthKey(expired)
	if err := ensureUsagePartition(db, expired); err != nil {
		t.Fatal(err)
	}
	r10gSeedMonth(t, db, uid, expired, 5, 0.5)
	// 只留这一个到期月关系：模板库里还有别的到期月分区（它们同样会被延后），
	// "最早未回收月"必须唯一 ⇒ 判据才能点名到具体某个月。
	r10gIsolateMonths(t, db, rel)

	// 外部会话占住父表 ⇒ 每一轮都只能"延后"。
	blocker, err := sql.Open("pgx", r10f4DSNFor(r10gCurDB(t, db)))
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Close()
	btx, err := blocker.BeginTx(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := btx.Exec("LOCK TABLE ONLY usage IN ACCESS EXCLUSIVE MODE"); err != nil {
		t.Fatal(err)
	}

	resetUsageRetentionStatusForTest()
	for i := 1; i <= 2; i++ {
		if cerr := CleanupUsageRetention(db); cerr != nil {
			t.Fatalf("延后轮不该失败: %v", cerr)
		}
	}
	st := CurrentUsageRetentionStatus()
	t.Logf("两轮延后之后：streak=%v oldest=%s/%s/%d", st.DeferredStreak, st.OldestUnreclaimedMonth, st.OldestUnreclaimedReason, st.OldestUnreclaimedRounds)
	if st.OldestUnreclaimedMonth != expiredMonth {
		t.Fatalf("夹具前提不成立：oldest_unreclaimed_month=%q want %q", st.OldestUnreclaimedMonth, expiredMonth)
	}
	before := struct {
		streak map[string]int
		max    int
		since  string
		rounds int64
	}{st.DeferredStreak, st.MaxDeferredStreak, st.OldestUnreclaimedSince, st.OldestUnreclaimedRounds}

	// ---- H1：早退轮（保留期=0 ⇒ 在扫描之前 return，本轮没有任何证据）----
	if err := SetSetting(db, RetentionMonthsSetting, "0"); err != nil {
		t.Fatal(err)
	}
	if cerr := CleanupUsageRetention(db); cerr != nil {
		t.Fatalf("保留期=0（永不删除）不该失败: %v", cerr)
	}
	st = CurrentUsageRetentionStatus()
	t.Logf("早退轮之后：streak=%v max=%d oldest=%s/%s/%d rounds=%d（关系仍在=%v）",
		st.DeferredStreak, st.MaxDeferredStreak, st.OldestUnreclaimedMonth, st.OldestUnreclaimedReason,
		st.OldestUnreclaimedRounds, st.RoundNumber, r9aRelationExists(t, db, rel))
	if st.RoundNumber != int64(3) {
		t.Errorf("夹具前提不成立：rounds=%d want 3（早退轮也必须记账）", st.RoundNumber)
	}
	if st.MaxDeferredStreak != before.max || st.DeferredStreak[rel] != before.streak[rel] {
		t.Errorf("**早退轮不得清零 streak**（它没有任何证据：没观测 ≠ 已回收；旧实现 `2 → 0`）: "+
			"streak=%v（前 %v）max=%d（前 %d）", st.DeferredStreak, before.streak, st.MaxDeferredStreak, before.max)
	}
	if st.OldestUnreclaimedMonth != expiredMonth || st.OldestUnreclaimedSince != before.since ||
		st.OldestUnreclaimedRounds != before.rounds {
		t.Errorf("早退轮不得动 oldest_unreclaimed_*（单调面）: month=%q since=%q rounds=%d（前 %q/%q/%d）",
			st.OldestUnreclaimedMonth, st.OldestUnreclaimedSince, st.OldestUnreclaimedRounds,
			expiredMonth, before.since, before.rounds)
	}

	// 恢复保留期：再来一轮延后 ⇒ 未被清零的 streak 继续（旧实现是从 1 重新数）。
	if err := SetSetting(db, RetentionMonthsSetting, "2"); err != nil {
		t.Fatal(err)
	}
	if cerr := CleanupUsageRetention(db); cerr != nil {
		t.Fatalf("恢复保留期后不该失败: %v", cerr)
	}
	st = CurrentUsageRetentionStatus()
	t.Logf("恢复保留期后再延后一轮：streak=%v oldest_rounds=%d", st.DeferredStreak, st.OldestUnreclaimedRounds)
	if st.DeferredStreak[rel] != before.streak[rel] {
		t.Errorf("早退轮之后的延后轮必须延续原计数（不是从 1 重新数）: %v（前 %v）", st.DeferredStreak, before.streak)
	}
	if st.OldestUnreclaimedRounds <= before.rounds {
		t.Errorf("有证据的延后轮必须推进 oldest_unreclaimed_rounds: %d → %d", before.rounds, st.OldestUnreclaimedRounds)
	}

	// ---- H2：失败轮（DROP 被依赖对象挡住 2BP01）----
	if err := btx.Rollback(); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("DROP VIEW IF EXISTS r10h_w3_dep_view"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("CREATE VIEW r10h_w3_dep_view AS SELECT id FROM " + quoteRelationIdent(rel)); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = db.Exec("DROP VIEW IF EXISTS r10h_w3_dep_view") })
	cerr := CleanupUsageRetention(db)
	st = CurrentUsageRetentionStatus()
	t.Logf("失败轮：err=%v failures=%d failed_rels=%v streak=%v oldest=%s/%s/%d",
		cerr != nil, st.Failures, st.FailedRelations, st.DeferredStreak,
		st.OldestUnreclaimedMonth, st.OldestUnreclaimedReason, st.OldestUnreclaimedRounds)
	if st.Failures == 0 {
		t.Fatalf("夹具前提不成立：DROP 应当被依赖视图挡住（2BP01）")
	}
	if st.MaxDeferredStreak != 0 {
		t.Errorf("失败轮之后 streak 按既有语义清零（它这一轮没被延后）: %v", st.DeferredStreak)
	}
	// 这就是 W3-3 的核心：streak 归零 **不代表**"长期未回收"不可判。
	if st.OldestUnreclaimedMonth != expiredMonth {
		t.Errorf("失败轮**不得**清掉 oldest_unreclaimed_month（那个月同样没被回收；"+
			"否则'超时/失败交替'可以永久绕过告警）: got %q want %q", st.OldestUnreclaimedMonth, expiredMonth)
	}
	if st.OldestUnreclaimedReason != "failed" {
		t.Errorf("oldest_unreclaimed_reason 必须读作 failed（它这一轮的未回收原因是真失败）: %q", st.OldestUnreclaimedReason)
	}
	if st.OldestUnreclaimedRounds <= 0 {
		t.Errorf("oldest_unreclaimed_rounds 必须 ≥1: %d", st.OldestUnreclaimedRounds)
	}

	// ---- H3：真的回收之后两个面一起收敛 ----
	if _, err := db.Exec("DROP VIEW r10h_w3_dep_view"); err != nil {
		t.Fatal(err)
	}
	if cerr := CleanupUsageRetention(db); cerr != nil {
		t.Fatalf("撤掉依赖对象后必须自愈: %v", cerr)
	}
	st = CurrentUsageRetentionStatus()
	t.Logf("自愈轮：cleared=%d failures=%d streak=%v oldest=%q stalled=%v",
		st.ClearedPartitions, st.Failures, st.DeferredStreak, st.OldestUnreclaimedMonth, st.DeferredStalled)
	if r9aRelationExists(t, db, rel) {
		t.Errorf("自愈轮必须回收 %s", rel)
	}
	if st.OldestUnreclaimedMonth != "" || st.OldestUnreclaimedRounds != 0 || st.OldestUnreclaimedSince != "" {
		t.Errorf("该月被回收之后 oldest_unreclaimed_* 必须清空: %q/%d/%q",
			st.OldestUnreclaimedMonth, st.OldestUnreclaimedRounds, st.OldestUnreclaimedSince)
	}
}
