package serverstore

// R11-I4 · 可观测面回归（R11A-04 / R11A-05 / R11-D-03 / 调度周期对拍）。
//
//   - R11A-04（P2）：`write_blocked_other_months` 的条目只在该月**下一次成功写入**
//     时清除，而回收窗口里被挡住的恰恰是**到期月**（写路径永不写它）⇒ 条目永久
//     残留，"非空 ⇒ 有月份写不进去"成为**单向棘轮**。修法：每轮有证据的清理结束
//     时，把"该月关系已不在本轮 catalog 枚举里"的条目收敛掉（判据是事实，不是猜）。
//   - R11A-05（P3）：streak 的节奏闸门是"距上次计入 ≥1h"，挡不住相隔 65min 的
//     **非调度轮次** ⇒ 实测 6 轮 5.4h 就把 `deferred_stalled` 置真，与文档承诺的
//     "只有调度停摆才告警"不一致。修法：闸门取**调度周期**（6h）⇒ 节奏 + 来源双判据。
//   - R11-D-03（P2）：`deferred_stalled` / `oldest_unreclaimed_*` 是**进程内**状态，
//     重启归零 ⇒ 重启节奏快于 ≈24h 的部署永远看不到"永久不回收"。修法：补一条
//     **由 catalog 事实推导**的判据（该月"应被回收"的时刻是保留期的纯函数）。

import (
	"fmt"
	"os"
	"regexp"
	"strconv"
	"testing"
	"time"
)

// i4RoundWithDeferral 造一轮"该关系被延后"的过程事实（只喂记账点，不碰数据库）。
func i4RoundWithDeferral(at time.Time, rel string) usageRetentionRound {
	return usageRetentionRound{
		EndedAt: at, Scanned: true, ConfiguredMonths: 2,
		DeferredRelations: []string{rel},
		Unreclaimed:       []string{rel + "(" + usageSkipLockTimeout + ")"},
		SkippedByReason:   map[string]int{usageSkipLockTimeout: 1},
	}
}

// TestR11I4NonSchedulerRoundsDoNotStall 覆盖 R11A-05：65min 间隔的**非调度轮次**
// （管理端保存保留期/启动补跑在节奏上与它同形）不得推进 streak。
//
// 夹具用**仍在保留期内**的月份（`bjMonth(1)`，retention=2 ⇒ 它的"应被回收时刻"
// 在未来）：这样"逾期时长"那条判据（R11-D-03）恒为 0，本用例只验**节奏**判据。
// 用已到期月份会把两条判据混在一起（那不是本条的判据面）。
func TestR11I4NonSchedulerRoundsDoNotStall(t *testing.T) {
	resetUsageRetentionStatusForTest()
	rel := "usage_" + monthKey(bjMonth(1))
	at := time.Now().Add(-6 * time.Hour)
	for i := 0; i < 6; i++ {
		at = at.Add(65 * time.Minute)
		recordUsageRetentionRound(i4RoundWithDeferral(at, rel), nil)
	}
	st := CurrentUsageRetentionStatus()
	t.Logf("节奏看板：6 轮 × 65min（非调度轮次）⇒ 累计墙钟 %.1fh，max_deferred_streak=%d deferred_stalled=%v reclaim_stalled=%v",
		float64(5*65)/60, st.MaxDeferredStreak, st.DeferredStalled, st.ReclaimStalled)
	if st.MaxDeferredStreak > 1 {
		t.Errorf("非调度轮次推进了 streak：max_deferred_streak=%d（want ≤1；旧闸门 1h 时实测到 6，"+
			"累计 5.4h 就把 deferred_stalled 置真 —— R11A-05）", st.MaxDeferredStreak)
	}
	if st.DeferredStalled || st.ReclaimStalled {
		t.Errorf("非调度轮次把停摆告警置真（streak=%d deferred_stalled=%v reclaim_stalled=%v）："+
			"告警读数取决于**谁在调用清理**", st.MaxDeferredStreak, st.DeferredStalled, st.ReclaimStalled)
	}
}

// TestR11I4SchedulerCadenceStillStalls 是对照：真实调度节奏（6h）仍必须到阈值 ——
// 证明上面的判据不是"只要调用记账函数就不告警"。
func TestR11I4SchedulerCadenceStillStalls(t *testing.T) {
	resetUsageRetentionStatusForTest()
	rel := "usage_" + monthKey(bjMonth(1))
	at := time.Now().Add(-36 * time.Hour)
	for i := 0; i < 6; i++ {
		at = at.Add(6 * time.Hour)
		recordUsageRetentionRound(i4RoundWithDeferral(at, rel), nil)
	}
	st := CurrentUsageRetentionStatus()
	t.Logf("对照组：6h×6 ⇒ max_deferred_streak=%d deferred_stalled=%v reclaim_stalled=%v stalled_rounds=%d",
		st.MaxDeferredStreak, st.DeferredStalled, st.ReclaimStalled, st.DeferredStalledRounds)
	if st.MaxDeferredStreak < usageRetentionDeferredStallRounds {
		t.Fatalf("对照组失败：6h 调度节奏本应把 streak 推到 %d，实得 %d",
			usageRetentionDeferredStallRounds, st.MaxDeferredStreak)
	}
	if !st.DeferredStalled {
		t.Fatalf("对照组失败：6h×6 轮本应判停摆（streak=%d）", st.MaxDeferredStreak)
	}
	if st.ReclaimStalled {
		t.Errorf("对照组不应由「逾期时长」这条置真（本夹具的月份仍在保留期内 ⇒ age=0）")
	}
}

// TestR11I4StallSurvivesRestart 覆盖 R11-D-03：**重启后第一轮**就能判"长期没回收"。
//
// 夹具（真 PG、生产构造）：一个早就到期、但 DROP 被依赖视图挡住的月分区
// （`TestR10G5SettleFailureKeepsMoneyVisible` 的同形故障注入）⇒ 每轮它都进
// `failed_relations` ⇒ `oldest_unreclaimed_month` 稳定指向它。
//
// 判据：
//
//	① 第二轮（= 重启后的第一轮）`deferred_stalled=true`，且 `deferred_stalled_by_age=true`
//	   —— 旧实现里 streak 只有 1（阈值 5），永远是 false；
//	② `oldest_unreclaimed_due_since` 是一个**确定**的历史时刻（保留期的纯函数），
//	   `age_seconds ≥ 24h`。
func TestR11I4StallSurvivesRestart(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	if _, err := db.Exec("TRUNCATE TABLE usage RESTART IDENTITY CASCADE"); err != nil {
		t.Fatal(err)
	}
	if err := SetSetting(db, RetentionMonthsSetting, "2"); err != nil {
		t.Fatal(err)
	}
	// bjMonth(5) ⇒ 应被回收时刻 = bjMonth(2)（≈ 2 个月前）⇒ 逾期远超 24h。
	expired := bjMonth(5)
	rel := "usage_" + monthKey(expired)
	uid := mustUserID(t, db)
	if err := ensureUsagePartition(db, expired); err != nil {
		t.Fatal(err)
	}
	usageRowAt(t, db, uid, "r11i4-stall", BeijingDayAt(expired, 10), 3.75)
	if _, err := db.Exec("CREATE VIEW r11i4_dep_view AS SELECT id FROM " + quoteRelationIdent(rel)); err != nil {
		t.Fatalf("建依赖视图: %v", err)
	}
	t.Cleanup(func() { _, _ = db.Exec("DROP VIEW IF EXISTS r11i4_dep_view") })

	// 第一轮：确认夹具真的卡住（进 failed_relations）。
	resetUsageRetentionStatusForTest()
	_ = CleanupUsageRetention(db)
	first := CurrentUsageRetentionStatus()
	if !containsRel(first.FailedRelations, rel) {
		t.Fatalf("夹具无效：%s 没有进 failed_relations（%v）", rel, first.FailedRelations)
	}
	dueWant, _ := usageReclaimDueSince(monthKey(expired), 2)

	// "重启"：包级单例归零（与进程重启后的形态逐字相同）。
	resetUsageRetentionStatusForTest()

	_ = CleanupUsageRetention(db)
	st := CurrentUsageRetentionStatus()
	t.Logf("看板：重启后第 1 轮 rounds=%d max_deferred_streak=%d deferred_stalled=%v reclaim_stalled=%v "+
		"oldest=%s due_since=%s age=%ds（期望的应回收时刻=%s）",
		st.RoundNumber, st.MaxDeferredStreak, st.DeferredStalled, st.ReclaimStalled,
		st.OldestUnreclaimedMonth, st.OldestUnreclaimedDueSince, st.OldestUnreclaimedAgeSeconds,
		dueWant.UTC().Format(time.RFC3339))
	if st.MaxDeferredStreak >= usageRetentionDeferredStallRounds {
		t.Fatalf("夹具/形态不符：重启后第一轮的 streak=%d 已达阈值 ⇒ 无法区分两条判据", st.MaxDeferredStreak)
	}
	if st.OldestUnreclaimedMonth != monthKey(expired) {
		t.Fatalf("最早未回收月=%q，want %q（夹具无效）", st.OldestUnreclaimedMonth, monthKey(expired))
	}
	if st.OldestUnreclaimedAgeSeconds < int64(usageReclaimStallAfter/time.Second) {
		t.Fatalf("重启后第一轮算出的逾期时长=%ds，want ≥ %s（应由保留期推导，而不是靠进程内累积）",
			st.OldestUnreclaimedAgeSeconds, usageReclaimStallAfter)
	}
	// 判据落在 `reclaim_stalled`（跨重启那一位）上；`deferred_stalled` 是 streak 面，
	// 重启后第一轮必然还是 false（streak 需要 5 个调度轮次）—— 两者**故意分开**，
	// 理由见 UsageRetentionStatus.ReclaimStalled。
	if !st.ReclaimStalled {
		t.Fatalf("重启后第一轮必须能判「长期没回收」：reclaim_stalled=%v（deferred_stalled=%v streak=%d）",
			st.ReclaimStalled, st.DeferredStalled, st.MaxDeferredStreak)
	}
}

// TestR11I4WriteBlockedOtherMonthsSelfHeals 覆盖 R11A-04：条目会**自己消失**。
//
// 判据（两侧都要）：
//
//	① 被回收掉的那个月（关系已不在本轮枚举里）⇒ 条目消失；
//	② 关系**仍在**的那个月（仍在保留期内，本轮没动它）⇒ 条目保留 ——
//	   证明收敛不是"清空整张表"。
func TestR11I4WriteBlockedOtherMonthsSelfHeals(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	if _, err := db.Exec("TRUNCATE TABLE usage RESTART IDENTITY CASCADE"); err != nil {
		t.Fatal(err)
	}
	if err := SetSetting(db, RetentionMonthsSetting, "2"); err != nil {
		t.Fatal(err)
	}
	uid := mustUserID(t, db)
	expired := bjMonth(3)  // 到期 ⇒ 本轮会被回收
	retained := bjMonth(1) // 仍在保留期内（cutoff = bjMonth(2)）⇒ 本轮不动它
	expiredRel := "usage_" + monthKey(expired)
	retainedRel := "usage_" + monthKey(retained)
	for _, m := range []time.Time{expired, retained} {
		if err := ensureUsagePartition(db, m); err != nil {
			t.Fatalf("建 %s 分区: %v", monthKey(m), err)
		}
	}
	usageRowAt(t, db, uid, "r11i4-heal", BeijingDayAt(expired, 10), 1.25)

	// 形态与真实回收窗口里的失败逐字相同（写路径唯一记账点）。
	resetUsageRetentionStatusForTest()
	noteUsagePartitionWriteFailure(expired, &partitionLayoutError{
		kind: usagePartitionKindOrphanNameCollision, action: "人工处置", msg: "回收窗口内到期月写入被挡(用例注入)",
	})
	noteUsagePartitionWriteFailure(retained, &partitionLayoutError{
		kind: usagePartitionKindOrphanNameCollision, action: "人工处置", msg: "保留期内月份写入被挡(用例注入)",
	})
	before := CurrentUsageRetentionStatus()
	if len(before.WriteBlockedOtherMonths) != 2 {
		t.Fatalf("夹具无效：注入的两个月没有都进 write_blocked_other_months（%+v）", before.WriteBlockedOtherMonths)
	}
	t.Logf("注入后：other_months=%d（%s / %s）", len(before.WriteBlockedOtherMonths), expiredRel, retainedRel)

	if err := CleanupUsageRetention(db); err != nil {
		t.Fatalf("清理失败: %v", err)
	}
	after := CurrentUsageRetentionStatus()
	got := map[string]bool{}
	for _, m := range after.WriteBlockedOtherMonths {
		got[m.Month] = true
	}
	t.Logf("一轮清理后：other_months=%d %v（cleared=%d skipped=%d failures=%d）",
		len(after.WriteBlockedOtherMonths), got, after.ClearedPartitions, after.Skipped, after.Failures)

	if r9aRelationExists(t, db, expiredRel) {
		t.Fatalf("夹具/形态不符：到期的 %s 本轮没有被回收，无法验「条目自己消失」", expiredRel)
	}
	if got[monthKey(expired)] {
		t.Errorf("已回收月份 %s 的写入面条目仍在（旧形态：只在「该月再次成功写入」时清除 ⇒ 永久残留，"+
			"消费口径「非空 ⇒ 有月份写不进去」成为单向棘轮 —— R11A-04）", monthKey(expired))
	}
	if !got[monthKey(retained)] {
		t.Errorf("仍在保留期内的月份 %s 的条目被误清（收敛判据过宽：关系还在 ⇒ 这条观测仍然成立）",
			monthKey(retained))
	}
}

// TestR11I4SchedulerPeriodMatchesUsageretentionTick 是跨包**值对拍**：
// `serverstore` 不能 import `internal/usageretention`（后者依赖前者，会成环），
// 所以"调度周期"这个值在两处各有一份 —— 判据是读**对方的源码**把两份钉在一起。
// 改任何一侧而不同步 ⇒ 本用例红（R11A-05 的节奏闸门就建立在这个值上）。
func TestR11I4SchedulerPeriodMatchesUsageretentionTick(t *testing.T) {
	const src = "../usageretention/scheduler.go"
	raw, err := os.ReadFile(src)
	if err != nil {
		t.Fatalf("读 %s: %v", src, err)
	}
	re := regexp.MustCompile(`(?m)^\s*(?:const\s+)?DefaultTick\s*=\s*(\d+)\s*\*\s*time\.Hour\s*$`)
	m := re.FindSubmatch(raw)
	if m == nil {
		t.Fatalf("%s 里找不到 `DefaultTick = <n> * time.Hour`（对拍的另一端变了，必须同步本用例）", src)
	}
	hours, cerr := strconv.Atoi(string(m[1]))
	if cerr != nil {
		t.Fatalf("解析 DefaultTick 小时数: %v", cerr)
	}
	want := time.Duration(hours) * time.Hour
	t.Logf("对拍：usageretention.DefaultTick=%v，serverstore.usageRetentionSchedulerPeriod=%v（节奏闸门）",
		want, usageRetentionSchedulerPeriod)
	if want != usageRetentionSchedulerPeriod {
		t.Fatalf("调度周期两份值不一致：usageretention.DefaultTick=%v vs usageRetentionSchedulerPeriod=%v"+
			"（R11A-05 的节奏闸门取后者，不等就会把调度轮次误判成非调度轮次、或反之）",
			want, usageRetentionSchedulerPeriod)
	}
	if usageRetentionSchedulerPeriodGap != usageRetentionSchedulerPeriod {
		t.Fatalf("闸门必须等于调度周期：gap=%v period=%v", usageRetentionSchedulerPeriodGap, usageRetentionSchedulerPeriod)
	}
}

var _ = fmt.Sprintf
