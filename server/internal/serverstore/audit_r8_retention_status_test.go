package serverstore

// R8-A-3 的判据（审计 2026-09-24，P2）：**深层后代永不回收**必须有可判定的观测面。
//
// 缺陷形态：多级布局下的深层后代分区每 6 小时被 SKIP 一次，而除了那一行日志之外
// `/readyz` 零命中、没有任何 metric、管理端只显示"retention_months 已配置" ⇒
// "保留策略在这个月其实没生效"与"一切正常"在运维面上逐字同形。
//
// 判据：一轮清理之后，进程内的过程事实必须能回答"跑了几轮 / 清了几条 / 哪几条
// 没有回收、为什么" —— 计数按原因分类、关系名点名、未跑过时如实为 0（不伪造
// "一切正常"）。

import (
	"encoding/json"
	"math"
	"strings"
	"testing"
	"time"
)

// TestR8Fix5UsageRetentionStatusObservable：深后代（永不回收）+ 一个正常到期月
// 走完一轮后，状态必须同时给出**精确计数**与**点名清单**。
func TestR8Fix5UsageRetentionStatusObservable(t *testing.T) {
	const costOk = 4.5
	// 状态是**包级单例**；显式复位（与 NewTestDB 里的统一复位同一纪律），
	// 让"跑了几轮/失败几轮"的断言与用例顺序无关。
	resetUsageRetentionStatusForTest()
	defer resetUsageRetentionStatusForTest()
	db, cleanup := NewTestDB(t)
	defer cleanup()
	if _, err := db.Exec("TRUNCATE TABLE usage RESTART IDENTITY CASCADE"); err != nil {
		t.Fatal(err)
	}
	if err := SetSetting(db, RetentionMonthsSetting, "2"); err != nil {
		t.Fatal(err)
	}
	uid := mustUserID(t, db)

	// 深后代（4 级：叶子距 usage 3 层）—— R7-A 之后**永不回收**的那一类。
	mDeep := bjMonth(3)
	r7aDropDirectUsagePartitions(t, db)
	yearRel := "usage_" + mDeep.Format("2006")
	midRel := yearRel + "q"
	leaf := "usage_" + monthKey(mDeep)
	yearFrom := time.Date(mDeep.Year(), 1, 1, 0, 0, 0, 0, time.UTC)
	yearTo := yearFrom.AddDate(1, 0, 0)
	lo := pgInstantArg(BeijingDayInstant(dayKey(mDeep)))
	hi := pgInstantArg(BeijingDayInstant(dayKey(mDeep).AddDate(0, 1, 0)))
	for _, stmt := range []string{
		"CREATE TABLE " + r6Quote(yearRel) + " PARTITION OF usage FOR VALUES FROM ('" +
			pgInstantArg(BeijingDayInstant(yearFrom)) + "') TO ('" + pgInstantArg(BeijingDayInstant(yearTo)) + "') PARTITION BY RANGE (created_at)",
		"CREATE TABLE " + r6Quote(midRel) + " PARTITION OF " + r6Quote(yearRel) + " FOR VALUES FROM ('" + lo + "') TO ('" + hi + "') PARTITION BY RANGE (created_at)",
		"CREATE TABLE " + r6Quote(leaf) + " PARTITION OF " + r6Quote(midRel) + " FOR VALUES FROM ('" + lo + "') TO ('" + hi + "')",
	} {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatalf("建多级布局: %v (%s)", err, stmt)
		}
	}
	usageRowAt(t, db, uid, "r8fix5-deep", BeijingDayAt(mDeep, 10), 2.5)

	// 一个正常到期月（同轮被回收，用来验"计数不是把所有关系都算成跳过"）。
	mOk := bjMonth(4)
	// mOk 与该年中间父表区间不重叠（bjMonth(4) 是更早的月，可能落在同一年）。
	// 为免区间冲突，只在**不同年**时才建直挂分区。
	if mOk.Year() != mDeep.Year() {
		if err := ensureUsagePartition(db, mOk); err != nil {
			t.Fatalf("建对照月 %s: %v", monthKey(mOk), err)
		}
		usageRowAt(t, db, uid, "r8fix5-ok", BeijingDayAt(mOk, 10), costOk)
	}
	logs := captureRetentionLog(t)
	if err := CleanupUsageRetention(db); err != nil {
		t.Fatalf("深后代必须只补账 + 跳过（不失败）: %v\n%s", err, logs.String())
	}

	st := CurrentUsageRetentionStatus()
	if st.RoundNumber < 1 {
		t.Fatalf("status.rounds = %d，want >=1（跑过一轮必须记账）", st.RoundNumber)
	}
	if st.LastRoundAt == "" {
		t.Fatalf("status.last_round_at 为空 —— 运维无法回答「最近一轮何时跑的」")
	}
	if st.ConfiguredMonths != 2 {
		t.Fatalf("status.configured_months = %d，want 2", st.ConfiguredMonths)
	}
	if st.FailedRounds != 0 || st.LastError != "" {
		t.Fatalf("本轮无失败：failed_rounds=%d last_error=%q", st.FailedRounds, st.LastError)
	}
	if st.Skipped != 1 || st.SkippedByReason[usageSkipDescendant] != 1 {
		t.Fatalf("深后代必须被计成 skipped=1 / skipped_by_reason[descendant]=1；实际 skipped=%d reasons=%v",
			st.Skipped, st.SkippedByReason)
	}
	if len(st.Unreclaimed) != 1 || !strings.Contains(st.Unreclaimed[0], leaf) || !strings.Contains(st.Unreclaimed[0], usageSkipDescendant) {
		t.Fatalf("未回收清单必须点名关系与原因；实际 %v（want 含 %s 与 %s）", st.Unreclaimed, leaf, usageSkipDescendant)
	}
	if !relationExists(t, db, leaf) {
		t.Fatalf("深后代 %s 不得被删（判据是「不回收但可见」，不是「删掉它」）", leaf)
	}

	// R9C-4：`UsageRetentionUnreclaimableCount` 这个导出访问器在仓库内**零消费点**
	// （只有本用例调用它），已删除 —— 计数面唯一出口是快照本身（`CurrentUsageRetentionStatus`
	// 的 Skipped / SkippedByReason），少一个会分叉的投影。上面几条断言已经把它钉在快照上。

	// 状态必须能**序列化进 /readyz**（cmd/server 的 usageRetentionReadyzHandler 用它）。
	raw, err := json.Marshal(st)
	if err != nil {
		t.Fatalf("状态必须可 JSON 序列化: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("状态 JSON 必须可解析: %v", err)
	}
	for _, key := range []string{"rounds", "skipped", "skipped_by_reason", "unreclaimed", "last_round_at", "configured_months"} {
		if _, ok := decoded[key]; !ok {
			t.Fatalf("状态 JSON 缺少字段 %q（/readyz 的判据面）: %s", key, raw)
		}
	}
	// 计数必须与日志同源（日志给人、状态给机器，两者不得分叉）。
	out := logs.String()
	if !strings.Contains(out, "skip_reasons="+usageSkipDescendant+":1") {
		t.Fatalf("round summary 必须带按原因计数（skip_reasons=…）:\n%s", out)
	}
}

// TestR8Fix5UsageRetentionStatusResetAndZeroValue：未跑过清理时状态如实为 0（不伪造
// "一切正常"），reset 之后同样归零 —— 判据不能靠"上一次的残留读数"成立。
func TestR8Fix5UsageRetentionStatusResetAndZeroValue(t *testing.T) {
	resetUsageRetentionStatusForTest()
	if st := CurrentUsageRetentionStatus(); st.RoundNumber != 0 || st.Skipped != 0 || st.LastRoundAt != "" {
		t.Fatalf("reset 后状态必须归零：rounds=%d", st.RoundNumber)
	}
	resetUsageRetentionStatusForTest()
	defer resetUsageRetentionStatusForTest()
	db, cleanup := NewTestDB(t)
	defer cleanup()
	if err := SetSetting(db, RetentionMonthsSetting, "0"); err != nil { // 0 = 永不删除
		t.Fatal(err)
	}
	_ = captureRetentionLog(t)
	if err := CleanupUsageRetention(db); err != nil {
		t.Fatalf("retention=0 时清理必须直接返回: %v", err)
	}
	st := CurrentUsageRetentionStatus()
	if st.RoundNumber != 1 || st.ConfiguredMonths != 0 {
		t.Fatalf("retention=0 也要记账（rounds=%d configured=%d，want 1/0）", st.RoundNumber, st.ConfiguredMonths)
	}
	if st.Skipped != 0 || st.ClearedPartitions != 0 || st.Failures != 0 {
		t.Fatalf("retention=0 时不得有清理/跳过/失败计数: %+v", st)
	}
	if math.Abs(float64(st.ClearedDetached)) != 0 {
		t.Fatalf("retention=0 时 cleared_detached 必须为 0: %d", st.ClearedDetached)
	}
}
