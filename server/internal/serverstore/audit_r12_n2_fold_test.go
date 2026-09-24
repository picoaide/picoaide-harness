package serverstore

// R12-N2 · P1-04 回归：错界分区让「相邻月并入」失败时，**不得让整轮保留清理停摆**。
//
// 被审形态（origin/master @ 12540e681c，R12-A 的 P1-04，探针 TestR12AW1b）：
// 某月分区按 **UTC 自然月**（或任何与北京月错界 8h 的边界）建，并且真的持有相邻月
// 前 8 小时的行（R6-A-1 §1.5-B 的"错界尾段"形态）⇒「相邻月并入」要找的目标月关系
// **同名但边界错位**，`ensureUsagePartition` 返回"窗口前段未被覆盖"⇒ 每轮
//
//	FAILED usage_202605 op=fold-adjacent sqlstate=42P17
//
// ⇒ ① 该月**永久**不被回收；② `CleanupUsageRetention` 每轮返回非 nil ⇒ 管理端保存
// 保留期每轮 500 + 调度器每 6h 报错 + failed_rounds 单调增长；③ `reclaim_stalled`
// 永久为真。这与 R5-A-9 写在代码里的承诺（"分区形态只影响该月新写入，不得让整轮保留
// 清理停摆"）直接冲突。
//
// 修法口径（**选"跳过"并写清理由**，见 usageSkipFoldMisbounded 的注释）：
// 走到 fold 失败这一步时，① 补账已按扩到整月的窗口提交、② DROP 没有做
// （`dropStmt = ""`）⇒ **金额不会丢**（真 PG 实测逐月守恒）。所以它**不是**"本轮
// 失败"，而是"需人工处置的形态"（PG 禁止分区区间重叠 ⇒ 只有人能改边界/搬行）：
// 记 skip + 进 `needs_manual_months`（长期、带关系名、可 grep），不进 failed_rounds、
// 不进 reclaim_stalled。另一条路（"放宽并入判据、容忍错界并照常 DROP"）被否：
// 那些相邻月的行还在 rel 里，DROP 会让相邻月的**明细段**永久少计（账本补得上，
// 但用量中心的逐笔明细会凭空消失）—— 用金额守恒换不回来。

import (
	"fmt"
	"math"
	"testing"
	"time"
)

// n2At 返回"北京月 m 的第 day 天 hour:00"的绝对瞬时（北京日期值 + 小时）。
func n2At(m time.Time, day, hour int) time.Time {
	return BeijingDayAt(dayKey(BeijingMonth(m)).AddDate(0, 0, day-1), hour)
}

func TestAuditR12N2MisboundedFoldDoesNotStallRound(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	n2Reset(t, db)
	if err := SetSetting(db, RetentionMonthsSetting, "2"); err != nil {
		t.Fatal(err)
	}
	uid := mustUserID(t, db)
	from, to := bjMonth(6), bjMonth(0)
	// UTC 自然月边界比北京月早 8 小时 ⇒ 与紧邻的下一个月分区必然重叠，PG 不允许
	// 重叠 ⇒ 只能把整段（含将来月）重铺成错界布局。
	for m := bjMonth(24); !m.After(BeijingMonth(time.Now()).AddDate(0, 12, 0)); m = m.AddDate(0, 1, 0) {
		n2DropMonth(t, db, m)
	}
	r6MakeUTCMonthPartitions(t, db, from, to)

	m := bjMonth(4) // 早已到期
	id := usageRowAt(t, db, uid, "r12n2-fold", n2At(m, 14, 10), 1.0)
	rel := r6PartitionOf(t, db, id)
	adj := m.AddDate(0, 1, 0)
	adjID := usageRowAt(t, db, uid, "r12n2-fold", n2At(adj, 1, 3), 10.0)
	adjRel := r6PartitionOf(t, db, adjID)
	// 相邻月北京日 1 日 03:00（错界尾段：UTC 月的最后 8 小时落在**上一个** UTC 月分区里）。
	t.Logf("P1-04：种子行落在 %s；相邻月 %s 的错界尾段行落在 %s", rel, monthKey(adj), adjRel)

	var errs []error
	for round := 1; round <= 2; round++ {
		cerr := CleanupUsageRetention(db)
		st := CurrentUsageRetentionStatus()
		errs = append(errs, cerr)
		t.Logf("P1-04 round%d：清理err=%v failures=%d failed_rels=%v cleared=%d skip=%v needs_manual=%v | rel仍在=%v | "+
			"reclaim_stalled=%v blocked=%s/%s/%d",
			round, cerr != nil, st.Failures, st.FailedRelations, st.ClearedPartitions, st.SkippedByReason,
			st.NeedsManualMonths, r9aRelationExists(t, db, rel), st.ReclaimStalled,
			st.ReclaimBlockedMonth, st.ReclaimBlockedReason, st.ReclaimBlockedRounds)
	}
	st := CurrentUsageRetentionStatus()
	// ① 不得让整轮停摆：两轮都必须返回 nil（管理端保存保留期不得 500）。
	for i, e := range errs {
		if e != nil {
			t.Errorf("第 %d 轮返回非 nil（%v）⇒ 管理端保存保留期每轮 500、调度器每轮报错、"+
				"failed_rounds 单调增长（R5-A-9 的承诺：错界分区不得让整轮保留清理停摆）", i+1, e)
		}
	}
	if st.Failures != 0 || len(st.FailedRelations) != 0 || st.LastError != "" {
		t.Errorf("fold-adjacent 被记成 failure（failures=%d failed_rels=%v last_error=%q）—— "+
			"该形态金额不丢（补账已提交 + 未 DROP），应记 skip + 人工处置面",
			st.Failures, st.FailedRelations, st.LastError)
	}
	// ② 但必须**结构化登记**且**长期可观测**：skip 原因 + 关系名。
	if st.SkippedByReason[usageSkipFoldMisbounded] == 0 {
		t.Errorf("错界形态必须按 %s 登记（实测 skip=%v）", usageSkipFoldMisbounded, st.SkippedByReason)
	}
	foundManual := false
	for _, item := range st.NeedsManualMonths {
		if item == monthKey(m)+"("+usageSkipFoldMisbounded+")" {
			foundManual = true
		}
	}
	if !foundManual {
		t.Errorf("错界形态必须进 needs_manual_months 并点名到月（%s(%s)），实测 %v",
			monthKey(m), usageSkipFoldMisbounded, st.NeedsManualMonths)
	}
	// ③ 不许永久占着**停摆**告警位（它是人工处置面，不是"保留策略停摆"）。
	if st.ReclaimStalled {
		t.Errorf("错界形态让 reclaim_stalled 永久为真（blocked=%s/%s/%d）—— 需人工处置的形态"+
			"挤占了停摆位", st.ReclaimBlockedMonth, st.ReclaimBlockedReason, st.ReclaimBlockedRounds)
	}
	// ④ 金额守恒（fail-loud 换成 skip 的前提，必须由探针证明）。
	rep := n2ReportCost(t, db, m)
	repAdj := n2ReportCost(t, db, adj)
	var detail float64
	if err := db.QueryRow(`SELECT COALESCE(SUM(cost),0) FROM usage`).Scan(&detail); err != nil {
		t.Fatal(err)
	}
	t.Logf("P1-04 金额：%s 报告=%.4f（want 1.0000）；%s 报告=%.4f（want 10.0000）| 明细合计=%.4f",
		monthKey(m), rep, monthKey(adj), repAdj, detail)
	if math.Abs(rep-1.0) > 1e-9 {
		t.Errorf("%s 金额不守恒：报告=%.4f want 1.0000", monthKey(m), rep)
	}
	if math.Abs(repAdj-10.0) > 1e-9 {
		t.Errorf("%s 金额不守恒：报告=%.4f want 10.0000", monthKey(adj), repAdj)
	}
	if math.Abs(detail-11.0) > 1e-9 {
		t.Errorf("明细合计=%.4f want 11.0000（skip 的前提是「一行未删」）", detail)
	}
	if !r9aRelationExists(t, db, rel) {
		t.Errorf("夹具/承诺不符：%s 不该被 DROP（相邻月明细还在里面）", rel)
	}
	_ = fmt.Sprint
}
