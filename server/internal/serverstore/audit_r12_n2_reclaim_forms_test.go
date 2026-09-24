package serverstore

// R12-N2 · P1-03 回归：月名被**非表对象**占用时，按 relkind 分流。
//
// 被审形态（origin/master @ 12540e681c，R12-A 的 P1-03，探针 TestR12AW5）：
// 结算段对目标关系一律取 `LOCK TABLE <rel> IN ACCESS EXCLUSIVE MODE`，而 PG 的
// `RangeVarCallbackForLockTable` **不接受物化视图**（真 PG 18.6 实测：matview 上
// 无论 ACCESS EXCLUSIVE 还是 ACCESS SHARE 都是 **42809** `cannot lock relation …
// This operation is not supported for materialized views`）：
//
//	VIEW      → 可锁 ⇒ 走到 R11 的零窗口分支 ⇒ 正确 DROP（对照：通过）
//	MATVIEW   → 42809 ⇒ **到不了**零窗口分支 ⇒ 每轮 failures=1、关系永不回收、
//	            管理端保存保留期每轮 500、reclaim_stalled 永久为真
//	INDEX/SEQ → `dropStatementForViewLike` 不可 DROP ⇒ 按设计 skip（人工处置）
//
// R11 的注释与回归用例（TestUsageRetentionViewOccupiedMonthNameIsClearedNotStalling）
// 都把这一族说成"已覆盖视图/物化视图" ⇒ 判据面缺口。
//
// 修法：`usageReclaimTargetLock(rel, kind)` 按 **relkind** 分流（matview 不取锁；
// 视图/表形态保持 AEX）。本文件把**四种形态**都摆出来跑两轮。

import (
	"fmt"
	"math"
	"testing"
)

func TestAuditR12N2MonthNameOccupiedRelkindMatrix(t *testing.T) {
	cases := []struct {
		name        string
		ddl         string
		mustBeGone  bool
		wantSkipped bool
	}{
		{"view", "CREATE VIEW %s AS SELECT 1 AS id", true, false},
		{"matview", "CREATE MATERIALIZED VIEW %s AS SELECT 1 AS id", true, false},
		{"index", "CREATE INDEX %s ON usage (user_id)", false, true},
		{"sequence", "CREATE SEQUENCE %s", false, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			db, cleanup := NewTestDB(t)
			defer cleanup()
			n2Reset(t, db)
			if err := SetSetting(db, RetentionMonthsSetting, "2"); err != nil {
				t.Fatal(err)
			}
			occupied := bjMonth(4) // 早已到期
			alive := bjMonth(1)    // 仍在保留期内（金额对照）
			uid := mustUserID(t, db)
			if err := ensureUsagePartition(db, alive); err != nil {
				t.Fatal(err)
			}
			const seed = 6.25
			usageRowAt(t, db, uid, "r12n2-forms", BeijingDayAt(alive, 10), seed)

			n2DropMonth(t, db, occupied)
			rel := "usage_" + monthKey(occupied)
			if _, err := db.Exec(fmt.Sprintf(tc.ddl, quoteRelationIdent(rel))); err != nil {
				t.Fatalf("占用月名 %s: %v", rel, err)
			}
			t.Cleanup(func() {
				for _, s := range []string{
					"DROP VIEW IF EXISTS public." + quoteRelationIdent(rel),
					"DROP MATERIALIZED VIEW IF EXISTS public." + quoteRelationIdent(rel),
					"DROP INDEX IF EXISTS public." + quoteRelationIdent(rel),
					"DROP SEQUENCE IF EXISTS public." + quoteRelationIdent(rel),
				} {
					_, _ = db.Exec(s)
				}
			})

			// **两轮**：判据是"不再每轮失败"，所以必须看到第二轮的读数。
			var firstErr, secondErr error
			for round := 1; round <= 2; round++ {
				err := CleanupUsageRetention(db)
				if round == 1 {
					firstErr = err
				} else {
					secondErr = err
				}
			}
			st := CurrentUsageRetentionStatus()
			var kind string
			_ = db.QueryRow(`SELECT relkind FROM pg_class WHERE relname = $1`, rel).Scan(&kind)
			exists := r9aRelationExists(t, db, rel)
			rep := n2ReportCost(t, db, alive)
			t.Logf("P1-03[%s]：relkind=%q 对象仍在=%v | r1err=%v r2err=%v failures=%d last_error=%q skip=%v needs_manual=%v",
				tc.name, kind, exists, firstErr != nil, secondErr != nil, st.Failures, st.LastError,
				st.SkippedByReason, st.NeedsManualMonths)
			t.Logf("P1-03[%s]：金额对照=%0.4f（want %0.4f）| reclaim_stalled=%v blocked=%s/%s/%d",
				tc.name, rep, seed, st.ReclaimStalled, st.ReclaimBlockedMonth, st.ReclaimBlockedReason, st.ReclaimBlockedRounds)

			if math.Abs(rep-seed) > 1e-9 {
				t.Errorf("无关月份的读数被影响：%.4f want %.4f", rep, seed)
			}
			if firstErr != nil || secondErr != nil {
				t.Errorf("%s 占名让整轮保留清理失败（r1=%v r2=%v）⇒ 管理端保存保留期每轮 500、"+
					"failed_rounds 单调增长", tc.name, firstErr, secondErr)
			}
			if st.Failures != 0 {
				t.Errorf("%s 占名被记成 failure（%d 条，last_error=%q）", tc.name, st.Failures, st.LastError)
			}
			if tc.mustBeGone && exists {
				t.Errorf("%s 占名的关系没有被回收（该月永久占着告警位、磁盘不回收）", tc.name)
			}
			if !tc.mustBeGone && !exists {
				t.Fatalf("夹具/形态不符：%s 本该被跳过，却被删掉了", tc.name)
			}
			if tc.wantSkipped {
				if st.SkippedByReason[usageSkipNonTable] == 0 {
					t.Errorf("非表对象占名必须按设计记 %s（实测 skip=%v）", usageSkipNonTable, st.SkippedByReason)
				}
				if st.NeedsManualCount == 0 {
					t.Errorf("非表对象占名必须进 needs_manual_months（人工处置）——实测为空")
				}
			}
			if st.ReclaimStalled {
				t.Errorf("月名被 %s 占用不是「保留策略停摆」（形态需人工处置或已被清掉）⇒ reclaim_stalled 不得为真"+
					"（blocked=%s/%s/%d）", tc.name, st.ReclaimBlockedMonth, st.ReclaimBlockedReason, st.ReclaimBlockedRounds)
			}
		})
	}
}

// TestAuditR12N2MatviewLockIsRelkindDriven 是**单位判据**：分流函数本身必须按 relkind
// 给出不同的 LOCK（防止"改回去一律 AEX"这种回归只被真 PG 用例偶然抓到）。
func TestAuditR12N2MatviewLockIsRelkindDriven(t *testing.T) {
	if got := usageReclaimTargetLock("usage_202601", "m"); got != "" {
		t.Errorf("物化视图（relkind=m）不得取任何 LOCK（PG 报 42809），实得 %q", got)
	}
	for _, kind := range []string{"r", "p", "v", ""} {
		got := usageReclaimTargetLock("usage_202601", kind)
		if got == "" {
			t.Errorf("relkind=%q 必须取 ACCESS EXCLUSIVE（表形态的钱账窗口靠它），实得空", kind)
		}
	}
}
