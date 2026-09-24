package serverstore

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

// 本文件是 R9-A-1（审计 2026-09-24，第九轮 D 泳道，P1）的**确定性回归**：
//
//	「子树仍在保留期」闸门是读—判定—删**非原子**的 ⇒ 判定之后、`DROP TABLE`
//	之前**已提交**的计量行被级联删除，而清理侧 err=nil / skipped=0 /
//	failures=0 / cleared_partitions=1（完全静默）。
//
// 交错点不用 sleep 撞运气：用**两条真连接 + 锁屏障**固定（见下面的用例注释）。
// 复跑：
//
//	cd server && PG_DSN_TEST=... go test ./internal/serverstore/ -run 'TestR9A1' -count=1 -v
//
// 本用例在修复前**必须红**（丢数据）、修复后**必须绿**（不动数据，或 fail-loud）。

// r9aDropRelation 无条件删掉 public.<rel>（表/视图/物化视图都算）。
func r9aDropRelation(t *testing.T, db *sql.DB, rel string) {
	t.Helper()
	if _, err := db.Exec("DROP TABLE IF EXISTS " + r6Quote(rel) + " CASCADE"); err != nil {
		t.Fatalf("清理 %s: %v", rel, err)
	}
}

// r9aRelationExists 独立于产品侧探测，直接问 catalog。
func r9aRelationExists(t *testing.T, db *sql.DB, rel string) bool {
	t.Helper()
	var n int
	if err := db.QueryRow(`SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname = ?`, rel).Scan(&n); err != nil {
		t.Fatalf("探测 %s: %v", rel, err)
	}
	return n > 0
}

// r9aUsageRowsInMonth 对 usage **父表**求和某北京月内某模型的行数与金额
// （物理事实，不取被审判据自己的口径）。
func r9aUsageRowsInMonth(t *testing.T, db *sql.DB, month time.Time, model string) (int64, float64) {
	t.Helper()
	var rows int64
	var amount sql.NullFloat64
	if err := db.QueryRow(fmt.Sprintf(`SELECT count(*), COALESCE(sum(cost), 0) FROM usage
WHERE %s >= ?::date AND %s < ?::date AND model = ?`,
		bjWallExpr("created_at")+"::date", bjWallExpr("created_at")+"::date"),
		dayKey(month).Format(dateFmt), dayKey(month).AddDate(0, 1, 0).Format(dateFmt), model).Scan(&rows, &amount); err != nil {
		t.Fatalf("统计 usage 明细: %v", err)
	}
	return rows, amount.Float64
}

// r9aWaitForCleanupLockWait 轮询 pg_stat_activity，等"清理线程"阻塞在锁上
// （**不使用 sleep 撞时序**：屏障是"有人真的在等锁"这个事实）。
//
// 两种修复形态的阻塞点不同，本判据对二者都成立：
//   - 修复前：清理阻塞在 `ALTER TABLE usage DETACH PARTITION …`（写入者持有
//     usage 与中间父表的 RowExclusive）；
//   - 修复后：清理阻塞在 `LOCK TABLE ONLY "usage" IN ACCESS EXCLUSIVE MODE`
//     （临界区的第一把锁）—— 同样在"判定之后、任何删动作之前"。
func r9aWaitForCleanupLockWait(t *testing.T, db *sql.DB, budget time.Duration) (bool, string) {
	t.Helper()
	deadline := time.Now().Add(budget)
	for time.Now().Before(deadline) {
		var q string
		err := db.QueryRow(`SELECT COALESCE(query, '') FROM pg_stat_activity
WHERE datname = current_database() AND pid <> pg_backend_pid()
  AND state = 'active' AND wait_event_type = 'Lock'
ORDER BY query_start LIMIT 1`).Scan(&q)
		if err != nil && err != sql.ErrNoRows {
			t.Fatalf("轮询 pg_stat_activity: %v", err)
		}
		if err == nil && strings.Contains(strings.ToLower(q), "usage") {
			return true, q
		}
		time.Sleep(20 * time.Millisecond)
	}
	return false, ""
}

// r9aMultiLevel 是"月名中间父表 + 当月叶子"的多级布局（R8-A-4/R9-A-1 的判据面）。
type r9aMultiLevel struct {
	parent string
	leaf   string
	month  time.Time // 当月（北京月）
	cutoff time.Time // 保留期截断月
}

// r9aBuildMultiLevel 建出 usage → usage_<cutoff-1>[p] → usage_<当月> 三层布局：
// 中间父表的名字段早于 cutoff（本轮到期），它的边界却覆盖到当月 ⇒ 子树里挂着
// 一个**能接收写入**的当月分区。
func r9aBuildMultiLevel(t *testing.T, db *sql.DB) r9aMultiLevel {
	t.Helper()
	now := BeijingMonth(time.Now())
	cutoff := now.AddDate(0, -6, 0)
	parent := "usage_" + monthKey(cutoff.AddDate(0, -1, 0))
	leaf := "usage_" + monthKey(now)
	// 先摘掉全部直接子分区（PG 不允许分区区间重叠），再清掉与本次要建的两个
	// 关系同名的残留表。
	r7aDropDirectUsagePartitions(t, db)
	r9aDropRelation(t, db, parent)
	r9aDropRelation(t, db, leaf)
	lo := pgInstantArg(BeijingDayInstant(dayKey(cutoff.AddDate(0, -1, 0))))
	hi := pgInstantArg(BeijingDayInstant(dayKey(now).AddDate(0, 2, 0)))
	if _, err := db.Exec(fmt.Sprintf(
		"CREATE TABLE %s PARTITION OF usage FOR VALUES FROM ('%s') TO ('%s') PARTITION BY RANGE (created_at)",
		r6Quote(parent), lo, hi)); err != nil {
		t.Fatalf("建中间父表 %s: %v", parent, err)
	}
	mlo := pgInstantArg(BeijingDayInstant(dayKey(now)))
	mhi := pgInstantArg(BeijingDayInstant(dayKey(now).AddDate(0, 1, 0)))
	if _, err := db.Exec(fmt.Sprintf("CREATE TABLE %s PARTITION OF %s FOR VALUES FROM ('%s') TO ('%s')",
		r6Quote(leaf), r6Quote(parent), mlo, mhi)); err != nil {
		t.Fatalf("建当月叶子 %s: %v", leaf, err)
	}
	// 布局前提：当月分区对写入路径必须"就绪"（否则写入会 503，与本次竞态无关）。
	if err := ensureUsagePartition(db, now); err != nil {
		t.Fatalf("当月分区未就绪（布局前提不成立）: %v", err)
	}
	return r9aMultiLevel{parent: parent, leaf: leaf, month: now, cutoff: cutoff}
}

// TestR9A1SubtreeReclaimRaceKeepsCommittedRows 是核心回归。
//
// 交错时序（确定性，两处断言都是"事实"而不是"期望"）：
//
//	W（连接）: BEGIN; INSERT 一行**当月**计量（9.5 元）—— 不提交
//	          （真实计量写入的落点：`INSERT INTO usage` 由元组路由进当月叶子，
//	            顺带在 usage / 中间父表 / 叶子上各持一把 RowExclusive）
//	清理      : 前置筛看不到未提交行（holds=false）→ 形态探测 → 相邻月扫描 → 账本补算
//	屏障      : 清理**阻塞在加锁/摘分区**上 ⇒ 交错点被固定在"判定之后、删动作之前"
//	W        : COMMIT（这一行从此是不可撤销的已提交事实）
//	清理      : 继续跑完本轮
//
// 修复前的断言形态：明细 rows=0、关系消失、cleared_partitions=1、err=nil
// ⇒ 本用例的"数据必须还在"断言当场变红。
// 修复后：持锁复检命中 ⇒ 整株保留（reason=subtree-retained），或锁等超时 ⇒
// fail-loud；两种结果都**一行都没动**。
func TestR9A1SubtreeReclaimRaceKeepsCommittedRows(t *testing.T) {
	const model = "m-r9a-race"
	db, cleanup := NewTestDB(t)
	defer cleanup()
	if _, err := db.Exec("TRUNCATE TABLE usage RESTART IDENTITY CASCADE"); err != nil {
		t.Fatal(err)
	}
	resetUsageRetentionStatusForTest()
	if err := SetSetting(db, RetentionMonthsSetting, "6"); err != nil {
		t.Fatal(err)
	}
	uid := mustUserID(t, db)
	lay := r9aBuildMultiLevel(t, db)
	t.Logf("SETUP 中间父表 %s（本轮到期，边界覆盖到当月）＋当月叶子 %s", lay.parent, lay.leaf)

	// W：未提交的当月计量写入。
	ctx := context.Background()
	w, err := db.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	if _, err := w.ExecContext(ctx, "BEGIN"); err != nil {
		t.Fatal(err)
	}
	if _, err := w.ExecContext(ctx, `INSERT INTO usage (user_id, model, prompt_tokens, completion_tokens, kind, cost, created_at, estimated)
VALUES ($1, $2, 4242, 4242, 'chat', 9.5, now(), FALSE)`, uid, model); err != nil {
		t.Fatalf("并发写入: %v", err)
	}

	type result struct {
		err error
	}
	done := make(chan result, 1)
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		done <- result{err: CleanupUsageRetention(db)}
	}()

	blocked, blockedOn := r9aWaitForCleanupLockWait(t, db, 20*time.Second)
	if !blocked {
		_, _ = w.ExecContext(ctx, "ROLLBACK")
		t.Fatalf("未能把清理卡在锁等待上（交错点无法确定，用例不可信）")
	}
	t.Logf("RACE 清理已阻塞（判定已完成）于: %s", oneLine(blockedOn))
	if _, err := w.ExecContext(ctx, "COMMIT"); err != nil {
		t.Fatalf("并发写入提交: %v", err)
	}
	res := <-done
	wg.Wait()

	st := CurrentUsageRetentionStatus()
	rowsLeft, amountLeft := r9aUsageRowsInMonth(t, db, lay.month, model)
	exists := r9aRelationExists(t, db, lay.leaf)
	t.Logf("RACE 清理结束 err=%v cleared=%d skipped=%d failures=%d reasons=%v",
		res.err, st.ClearedPartitions, st.Skipped, st.Failures, st.SkippedByReason)
	t.Logf("RACE 当月叶子 %s 仍存在=%v ｜ 已提交的当月明细 rows=%d amount=%.4f",
		lay.leaf, exists, rowsLeft, amountLeft)

	// —— 物理事实（主判据）——
	if rowsLeft != 1 || amountLeft < 9.5-1e-9 {
		t.Fatalf("已提交的计量行被清理吃掉了（R9-A-1 未修）: rows=%d amount=%.4f;"+
			"清理侧 err=%v cleared_partitions=%d skipped=%d failures=%d",
			rowsLeft, amountLeft, res.err, st.ClearedPartitions, st.Skipped, st.Failures)
	}
	if !exists {
		t.Fatalf("子树连当月分区一起被 DROP（%s 已不存在）—— 明细被级联删除", lay.leaf)
	}
	if st.ClearedPartitions != 0 {
		t.Fatalf("关系不该被回收: cleared_partitions=%d", st.ClearedPartitions)
	}

	// —— 可观测性：要么"持锁复检命中 ⇒ 整株保留"，要么"拿不到锁 ⇒ fail-loud"。
	// 两种都不允许"静默成功"。
	skippedRetained := st.SkippedByReason[usageSkipSubtreeRetained] > 0
	failLoud := res.err != nil && st.Failures > 0
	if !skippedRetained && !failLoud {
		t.Fatalf("既没记跳过也没 fail-loud（静默）: err=%v skipped=%d failures=%d reasons=%v",
			res.err, st.Skipped, st.Failures, st.SkippedByReason)
	}
	if !skippedRetained {
		t.Logf("注意：本轮走的是 fail-loud 分支（锁等超时），数据同样未动: err=%v", res.err)
	}

	// —— 金额在**产品口径**里也可见（明细仍在 ⇒ 聚合读得到；账本由后续轮次补齐）。
	agg, err := UsageAggregateWithLedger(db, lay.month, lay.month.AddDate(0, 1, -1), "user")
	if err != nil {
		t.Fatalf("聚合当月用量: %v", err)
	}
	var total float64
	for _, row := range agg {
		total += row.Cost
	}
	if total < 9.5-1e-9 {
		t.Fatalf("已提交的 9.5 元在明细/聚合里都看不到（金额丢失）: 聚合合计=%.4f rows=%d", total, len(agg))
	}
	t.Logf("OK 明细保留、聚合可见（合计 %.4f 元），清理侧可观测=%v", total, skippedRetained)
}

// TestR9A1ExpiredSubtreeStillReclaimedWithoutConcurrency 是"不得退化成永不回收"
// 的反向判据：没有并发写入时，到期关系必须**照常**被 DETACH + DROP（叶子与
// 非叶子子树两条路径都要过一遍临界区）。
func TestR9A1ExpiredSubtreeStillReclaimedWithoutConcurrency(t *testing.T) {
	t.Run("leaf_direct_child_of_usage", func(t *testing.T) {
		db, cleanup := NewTestDB(t)
		defer cleanup()
		if _, err := db.Exec("TRUNCATE TABLE usage RESTART IDENTITY CASCADE"); err != nil {
			t.Fatal(err)
		}
		resetUsageRetentionStatusForTest()
		if err := SetSetting(db, RetentionMonthsSetting, "6"); err != nil {
			t.Fatal(err)
		}
		uid := mustUserID(t, db)
		now := BeijingMonth(time.Now())
		expired := now.AddDate(0, -7, 0)
		rel := "usage_" + monthKey(expired)
		r7aDropDirectUsagePartitions(t, db)
		if err := ensureUsagePartition(db, expired); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(`INSERT INTO usage (user_id, model, prompt_tokens, completion_tokens, kind, cost, created_at, estimated)
VALUES (?, 'm-r9a-expired', 10, 10, 'chat', 1.25, ?, FALSE)`, uid, BeijingDayAt(dayKey(expired), 3)); err != nil {
			t.Fatal(err)
		}
		if err := CleanupUsageRetention(db); err != nil {
			t.Fatalf("无并发时清理不得失败: %v", err)
		}
		st := CurrentUsageRetentionStatus()
		t.Logf("LEAF cleared=%d skipped=%d failures=%d 关系仍存在=%v",
			st.ClearedPartitions, st.Skipped, st.Failures, r9aRelationExists(t, db, rel))
		if st.ClearedPartitions != 1 || st.Failures != 0 {
			t.Fatalf("到期叶子分区未被回收: cleared=%d failures=%d", st.ClearedPartitions, st.Failures)
		}
		if r9aRelationExists(t, db, rel) {
			t.Fatalf("到期叶子分区 %s 仍在盘上（保留清理退化成永不回收）", rel)
		}
		// 明细已删，但金额必须已进永久账本（补账在 DROP 之前完成）。
		var rows int64
		var amount sql.NullFloat64
		if err := db.QueryRow(`SELECT count(*), COALESCE(sum(cost), 0) FROM usage_daily
WHERE day = ?::date AND model = 'm-r9a-expired'`, dayKey(expired).Format(dateFmt)).Scan(&rows, &amount); err != nil {
			t.Fatal(err)
		}
		if rows != 1 || amount.Float64 < 1.25-1e-9 {
			t.Fatalf("明细被删而账本没补上（金额丢失）: 日账 rows=%d cost=%.4f", rows, amount.Float64)
		}
	})

	t.Run("expired_subtree_parent", func(t *testing.T) {
		db, cleanup := NewTestDB(t)
		defer cleanup()
		if _, err := db.Exec("TRUNCATE TABLE usage RESTART IDENTITY CASCADE"); err != nil {
			t.Fatal(err)
		}
		resetUsageRetentionStatusForTest()
		if err := SetSetting(db, RetentionMonthsSetting, "6"); err != nil {
			t.Fatal(err)
		}
		uid := mustUserID(t, db)
		now := BeijingMonth(time.Now())
		cutoff := now.AddDate(0, -6, 0)
		// 名字段比 cutoff 早 ⇒ 本轮到期；子树里**只有**到期月的行 ⇒ 整株都已到期。
		parent := "usage_" + monthKey(cutoff.AddDate(0, -2, 0))
		child := "usage_r9a_expired_leaf" // 非月名：不参与"月份关系"扫描，只充当子关系
		r7aDropDirectUsagePartitions(t, db)
		r9aDropRelation(t, db, parent)
		lo := pgInstantArg(BeijingDayInstant(dayKey(cutoff.AddDate(0, -2, 0))))
		hi := pgInstantArg(BeijingDayInstant(dayKey(now).AddDate(0, 2, 0)))
		if _, err := db.Exec(fmt.Sprintf(
			"CREATE TABLE %s PARTITION OF usage FOR VALUES FROM ('%s') TO ('%s') PARTITION BY RANGE (created_at)",
			r6Quote(parent), lo, hi)); err != nil {
			t.Fatal(err)
		}
		clo := pgInstantArg(BeijingDayInstant(dayKey(cutoff.AddDate(0, -2, 0))))
		chi := pgInstantArg(BeijingDayInstant(dayKey(cutoff.AddDate(0, -1, 0))))
		if _, err := db.Exec(fmt.Sprintf("CREATE TABLE %s PARTITION OF %s FOR VALUES FROM ('%s') TO ('%s')",
			r6Quote(child), r6Quote(parent), clo, chi)); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(`INSERT INTO `+r6Quote(child)+` (user_id, model, prompt_tokens, completion_tokens, kind, cost, created_at, estimated)
VALUES (?, 'm-r9a-subtree', 10, 10, 'chat', 2.5, ?, FALSE)`, uid, BeijingDayAt(dayKey(cutoff.AddDate(0, -2, 0)), 3)); err != nil {
			t.Fatal(err)
		}
		if err := CleanupUsageRetention(db); err != nil {
			t.Fatalf("无并发时清理不得失败: %v", err)
		}
		st := CurrentUsageRetentionStatus()
		t.Logf("SUBTREE cleared=%d skipped=%d failures=%d reasons=%v 关系仍存在=%v",
			st.ClearedPartitions, st.Skipped, st.Failures, st.SkippedByReason, r9aRelationExists(t, db, parent))
		if st.ClearedPartitions != 1 || st.Failures != 0 {
			t.Fatalf("整株都已到期的子树未被回收（持锁复检把回收挡死了）: cleared=%d skipped=%d failures=%d",
				st.ClearedPartitions, st.Skipped, st.Failures)
		}
		if r9aRelationExists(t, db, parent) {
			t.Fatalf("到期子树 %s（含子关系）仍在盘上", parent)
		}
		// 被回收的子树里含"覆盖当月的那一支"时当月分区会一起消失 —— 写路径
		// （ensureUsagePartition + INSERT）必须能自愈，否则保留清理会把计量写面
		// 打成永久 503（R9-D FINDING 07 的落点：本泳道不改它的语义，但必须证明
		// 回收不留残局）。
		if _, err := RecordUsageKind(db, uid, "m-r9a-heal", 7, 7, "chat"); err != nil {
			t.Fatalf("回收后当月计量写入未自愈: %v", err)
		}
	})
}

// TestR9A1RetentionGatePredicateMatchesBeijingDayBoundary 钉死 R9-A-1 里的
// **等价改写**：`bjWallExpr(created_at)::date >= D` ⟺ `created_at >= BeijingDayInstant(D)`。
//
// 这条等价是"复检可在临界区里跑"的前提（旧谓词给列套了表达式 ⇒ 用不上 created_at
// 索引、也没法按分区边界裁剪，实测 20 万行子树 33.8ms vs 0.6ms）。任何一侧
// （bjWallExpr / BeijingDayInstant / 谓词写法）漂移都必须在这里变红。
func TestR9A1RetentionGatePredicateMatchesBeijingDayBoundary(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	if _, err := db.Exec("TRUNCATE TABLE usage RESTART IDENTITY CASCADE"); err != nil {
		t.Fatal(err)
	}
	now := BeijingMonth(time.Now())
	cutoff := now.AddDate(0, -6, 0)
	boundary := BeijingDayInstant(dayKey(cutoff))

	// ① 表达式级对拍：北京零点这一刻前后各取若干瞬时。
	var allEqual bool
	if err := db.QueryRow(`SELECT bool_and(
  ((t AT TIME ZONE 'UTC' + interval '8 hours')::date >= $1::date) = (t >= $2::timestamptz))
FROM (VALUES ($2::timestamptz - interval '2 hours'),
             ($2::timestamptz - interval '1 second'),
             ($2::timestamptz),
             ($2::timestamptz + interval '1 second'),
             ($2::timestamptz + interval '8 hours'),
             ($2::timestamptz + interval '26 hours')) v(t)`,
		dayKey(cutoff).Format(dateFmt), pgInstantArg(boundary)).Scan(&allEqual); err != nil {
		t.Fatal(err)
	}
	if !allEqual {
		t.Fatalf("谓词不等价：bjWallExpr(created_at)::date >= %s 与 created_at >= %s 在北京零点两侧给出不同结论",
			dayKey(cutoff).Format(dateFmt), pgInstantArg(boundary))
	}

	// ② 行级对拍：真实分区上，边界前 1 秒的行不算保留期，边界当刻的行算。
	// 用一个**跨边界**的宽分区，让两行都落在同一个关系里（否则边界前 1 秒的行
	// 属于上一个月，物理上到不了同一个分区）。
	rel := "usage_r9a_bound_wide"
	r7aDropDirectUsagePartitions(t, db)
	r9aDropRelation(t, db, rel)
	wlo := pgInstantArg(BeijingDayInstant(dayKey(cutoff.AddDate(0, -1, 0))))
	whi := pgInstantArg(BeijingDayInstant(dayKey(cutoff.AddDate(0, 2, 0))))
	if _, err := db.Exec(fmt.Sprintf("CREATE TABLE %s PARTITION OF usage FOR VALUES FROM ('%s') TO ('%s')",
		r6Quote(rel), wlo, whi)); err != nil {
		t.Fatal(err)
	}
	uid := mustUserID(t, db)
	if _, err := db.Exec(`INSERT INTO `+r6Quote(rel)+` (user_id, model, prompt_tokens, completion_tokens, kind, cost, created_at, estimated)
VALUES (?, 'm-r9a-bound', 1, 1, 'chat', 0.01, ?, FALSE)`, uid, boundary.Add(-time.Second)); err != nil {
		t.Fatal(err)
	}
	holds, err := usageSubtreeHoldsRetainedRows(db, rel, cutoff)
	if err != nil {
		t.Fatal(err)
	}
	if holds {
		t.Fatalf("边界前 1 秒的行（北京日 %s 23:59:59）被算成保留期内", dayKey(cutoff).AddDate(0, 0, -1).Format(dateFmt))
	}
	if _, err := db.Exec(`INSERT INTO `+r6Quote(rel)+` (user_id, model, prompt_tokens, completion_tokens, kind, cost, created_at, estimated)
VALUES (?, 'm-r9a-bound', 1, 1, 'chat', 0.01, ?, FALSE)`, uid, boundary); err != nil {
		t.Fatal(err)
	}
	holds, err = usageSubtreeHoldsRetainedRows(db, rel, cutoff)
	if err != nil {
		t.Fatal(err)
	}
	if !holds {
		t.Fatalf("边界当刻的行（北京 %s 00:00:00）未被算成保留期内", dayKey(cutoff).Format(dateFmt))
	}
}

// oneLine 把 pg_stat_activity 里的多行语句压成一行（日志可读）。
func oneLine(s string) string {
	return strings.Join(strings.Fields(s), " ")
}
