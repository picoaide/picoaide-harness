package serverstore

// R13-GE · V2-1 回归：**停摆位必须由「任一受阻月」推导，不能只看最早那一条**。
//
// 被审形态（V12-2 的 A4 探针，纯状态机、无需真库）：
//
//	第 1..5 轮：更晚的月 `usage_<M+3>` 连续 5 个调度轮次**真失败** ⇒ reclaim_stalled=true
//	第 6 轮    ：更早的月 `usage_<M+5>` **第一次**被延后（lock-timeout，rounds=1）
//
// 旧实现的读数面（reclaim_blocked_month）取**最早**受阻月 ⇒ 第 6 轮的读数指向更早那个
// 刚被延后的月，停摆位随之翻回 **false**：**更晚月持续 5 轮的真失败被掩盖**
// （告警闪烁的另一半：R12-A 抱怨的是假告警，这里是真失败被漏报）。
//
// 修复口径：读数面保持"最早那个"（最逾期者最该被点名，交给人的现状清单），但
// **停摆位 = 任一受阻月达标**（usageReclaimStalledFor），并新增 `reclaim_blocked_months`
// 把**全部**受阻月列出来 —— 被顶掉的那个月不再消失。
//
// 反例（防止"一律 OR ⇒ 永久告警"）：只剩更早月的一次延后（rounds=1）时必须回到
// false；单次 5s 锁竞争（1 轮）永远不可能置真。

import (
	"testing"
	"time"
)

// r13geNow 是本文件夹具的**固定模拟当前时刻**（北京 2026-09-15 12:00）。
//
// 为什么不能用 time.Now()：停摆位"真失败"档的判据是**月龄 ≥ 24h**，而月龄 =
// 本轮结束时刻 − 该月的到期时刻，到期时刻由 `BeijingMonth(now)` 推导。夹具却把轮次时刻
// 写成 `time.Now()-72h` —— 月初那几天它会落到**上个月**，月龄随之变负、停摆位永远置不上，
// 夹具当场失效（不是产品回归）。2026-10-01（月初）实测本文件两条用例红在
// 「夹具无效：先要造出 stalled=true」。把时钟钉死，让月份相对关系与真实日历无关。
func r13geNow() time.Time { return BeijingDayAt(time.Date(2026, 9, 15, 0, 0, 0, 0, time.UTC), 12) }

// r13geMonth 是 `bjMonth` 的固定时钟版：相对 {@link r13geNow} 的"n 个月前的月首"。
func r13geMonth(monthsAgo int) time.Time {
	return BeijingMonth(r13geNow()).AddDate(0, -monthsAgo, 0)
}

// r13geRecordRound 是本文件唯一的轮次构造点（`recordUsageRetentionRound` 的生产装配）。
func r13geRecordRound(at time.Time, cutoff string, failed, deferred []string) usageRetentionRound {
	unreclaimed := make([]string, 0, len(failed)+len(deferred))
	for _, r := range failed {
		unreclaimed = append(unreclaimed, r+"("+usageReclaimBlockedFailed+")")
	}
	for _, r := range deferred {
		unreclaimed = append(unreclaimed, r+"("+usageSkipLockTimeout+")")
	}
	skipped := map[string]int{}
	if len(deferred) > 0 {
		skipped[usageSkipLockTimeout] = len(deferred)
	}
	return usageRetentionRound{
		EndedAt: at, Scanned: true, ConfiguredMonths: 2, ConfiguredMonthsKnown: true,
		CutoffMonth:       cutoff,
		FailedRelations:   failed,
		DeferredRelations: deferred,
		Unreclaimed:       unreclaimed,
		SkippedByReason:   skipped,
	}
}

// TestAuditR13GEStallSurvivesFreshDeferralOfAnEarlierMonth 是 A4 形态的正式判据。
func TestAuditR13GEStallSurvivesFreshDeferralOfAnEarlierMonth(t *testing.T) {
	resetUsageRetentionStatusForTest()
	cutoff := monthKey(r13geMonth(2))
	olderDefer := "usage_" + monthKey(r13geMonth(5))  // 更早：本轮才第一次被延后
	youngerFail := "usage_" + monthKey(r13geMonth(3)) // 更晚：已连续真失败多轮
	at := r13geNow().Add(-72 * time.Hour)

	// 更晚的月连续真失败 5 个调度轮次（相隔 6h ⇒ 计入节奏闸门）。
	for i := 0; i < 5; i++ {
		at = at.Add(6 * time.Hour)
		recordUsageRetentionRound(r13geRecordRound(at, cutoff, []string{youngerFail}, nil), nil)
	}
	mid := CurrentUsageRetentionStatus()
	t.Logf("基线：blocked=%s/%s/%d stalled=%v blocked_months=%v",
		mid.ReclaimBlockedMonth, mid.ReclaimBlockedReason, mid.ReclaimBlockedRounds,
		mid.ReclaimStalled, mid.ReclaimBlockedMonths)
	if !mid.ReclaimStalled {
		t.Fatalf("夹具无效：更晚的月连续真失败 5 轮却没有置真（blocked=%s/%s/%d）",
			mid.ReclaimBlockedMonth, mid.ReclaimBlockedReason, mid.ReclaimBlockedRounds)
	}

	// 第 6 轮：更早的月**第一次**被延后 —— 它成为"最早受阻月"。
	at = at.Add(6 * time.Hour)
	recordUsageRetentionRound(r13geRecordRound(at, cutoff, []string{youngerFail}, []string{olderDefer}), nil)
	st := CurrentUsageRetentionStatus()
	t.Logf("第6轮：blocked=%s/%s/%d stalled=%v blocked_months=%v",
		st.ReclaimBlockedMonth, st.ReclaimBlockedReason, st.ReclaimBlockedRounds,
		st.ReclaimStalled, st.ReclaimBlockedMonths)
	if st.ReclaimBlockedMonth != monthKey(r13geMonth(5)) {
		t.Errorf("读数面应仍指向**最早**受阻月 %s，得到 %s",
			monthKey(r13geMonth(5)), st.ReclaimBlockedMonth)
	}
	if !st.ReclaimStalled {
		t.Errorf("真失败被掩盖：更晚的月 %s 已连续 5 个调度轮次真失败，但停摆位被更早月 "+
			"(%s) 的一次新延后抹掉（blocked=%s/%s/%d, stalled=false）",
			youngerFail, olderDefer, st.ReclaimBlockedMonth, st.ReclaimBlockedReason, st.ReclaimBlockedRounds)
	}
	// 被顶掉的那个月必须仍然可见（新增的全量读数面）。
	found := false
	for _, m := range st.ReclaimBlockedMonths {
		if m == monthKey(r13geMonth(3)) {
			found = true
		}
	}
	if !found {
		t.Errorf("reclaim_blocked_months=%v 里没有仍然真失败的 %s —— 被掩盖的月没有任何读数面",
			st.ReclaimBlockedMonths, monthKey(r13geMonth(3)))
	}
}

// TestAuditR13GEStallClearsWhenOnlyAFreshDeferralRemains 是上面那条的**反向判据**：
// 真失败消失后，只剩一次新延后（1 轮）⇒ 停摆位必须回到 false。
// 没有它，"一律 OR" 的实现（把任何受阻月都算停摆）也能过 A4 那条用例。
func TestAuditR13GEStallClearsWhenOnlyAFreshDeferralRemains(t *testing.T) {
	resetUsageRetentionStatusForTest()
	cutoff := monthKey(r13geMonth(2))
	olderDefer := "usage_" + monthKey(r13geMonth(5))
	youngerFail := "usage_" + monthKey(r13geMonth(3))
	at := r13geNow().Add(-72 * time.Hour)

	for i := 0; i < 5; i++ {
		at = at.Add(6 * time.Hour)
		recordUsageRetentionRound(r13geRecordRound(at, cutoff, []string{youngerFail}, nil), nil)
	}
	if !CurrentUsageRetentionStatus().ReclaimStalled {
		t.Fatalf("夹具无效：先要造出 stalled=true")
	}
	// 真失败解决（本轮不再出现），只剩更早月的一次延后。
	at = at.Add(6 * time.Hour)
	recordUsageRetentionRound(r13geRecordRound(at, cutoff, nil, []string{olderDefer}), nil)
	st := CurrentUsageRetentionStatus()
	t.Logf("真失败消失后：blocked=%s/%s/%d stalled=%v blocked_months=%v",
		st.ReclaimBlockedMonth, st.ReclaimBlockedReason, st.ReclaimBlockedRounds,
		st.ReclaimStalled, st.ReclaimBlockedMonths)
	if st.ReclaimStalled {
		t.Errorf("只有一次新延后（rounds=1，未达 %d 轮阈值）时停摆位必须为 false —— "+
			"否则「任一受阻月达标」退化成「只要有受阻月就告警」（假告警）",
			usageReclaimStallRounds)
	}
	if len(st.ReclaimBlockedMonths) != 1 || st.ReclaimBlockedMonths[0] != monthKey(r13geMonth(5)) {
		t.Errorf("reclaim_blocked_months=%v，want [%s]（更晚月已被正常处理 ⇒ 从账上消失）",
			st.ReclaimBlockedMonths, monthKey(r13geMonth(5)))
	}
}

// TestAuditR13GEStallIsNotTriggeredByASingleContention 守住"单次 5s 锁竞争不是停摆"
// 这条既有契约（R12-A 的假告警面）：一个到期月只被延后 1 轮 ⇒ 不置真。
func TestAuditR13GEStallIsNotTriggeredByASingleContention(t *testing.T) {
	resetUsageRetentionStatusForTest()
	cutoff := monthKey(r13geMonth(2))
	rel := "usage_" + monthKey(r13geMonth(5))
	at := r13geNow().Add(-72 * time.Hour)
	recordUsageRetentionRound(r13geRecordRound(at, cutoff, nil, []string{rel}), nil)
	st := CurrentUsageRetentionStatus()
	t.Logf("单轮锁竞争：blocked=%s/%s/%d stalled=%v", st.ReclaimBlockedMonth,
		st.ReclaimBlockedReason, st.ReclaimBlockedRounds, st.ReclaimStalled)
	if st.ReclaimStalled {
		t.Errorf("单轮锁竞争把停摆位置真（threshold=%d 轮）—— 假告警回归", usageReclaimStallRounds)
	}
}
