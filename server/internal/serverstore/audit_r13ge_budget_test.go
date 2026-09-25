package serverstore

// R13-GE · V2-6 回归：`usageReclaimFreezeBudgetMS` **一变量两语义**。
//
// 被审形态（V12-2 的 F1 探针，真 PG 实测）：同一个 `var` 既是冻结段整段的 ctx
// deadline（`usageBoundedTx`），又被 `setUsageRetentionStatementBudget` 当成该段内
// 的**单语句** `statement_timeout`：
//
//	usageReclaimFreezeBudgetMS = 1234  ⇒  段内 statement_timeout="1234ms"
//
// 后果：两个语义被一个旋钮绑死 —— 为慢月放大段预算会顺带把单语句上界一起放大
// （该段里任何一条慢语句都不再被 20s 严上界罩住）；把它调小做测试时又会同时收紧
// 语句预算（真实预算被压缩 16 倍，测出来的"有界"不是生产的有界）。
//
// 修法：拆成两个**具名**量 ——
//
//	usageReclaimStatementBudgetMS   单语句上界（段内 statement_timeout）
//	usageReclaimFreezeBudgetMS      冻结段整段（含 COMMIT）上界（ctx deadline）
//	usageReclaimFreezeCommitMarginMS  两者之差 = 留给提交期的余量
//
// 本文件是配套的**不变量判据**（序关系 + 两语义互不牵连），两条：
//
//	A. 常量层的序关系（纯函数、无需真库）：
//	     lock < statement < freeze；freeze + rollback < 调度周期
//	   —— 缺了任何一条，拆分就只是"换个名字"，两个旋钮仍然会互相打架：
//	     · statement ≥ freeze  ⇒ 单语句上界永远轮不到生效（段 deadline 先到）；
//	     · freeze ≤ statement  ⇒ 提交期没有余量，COMMIT 一慢就整段中止（R11A-03 回归）；
//	     · freeze + rollback ≥ 调度周期 ⇒ 一轮跑不完就撞下一轮，清理永久堆积。
//	B. 行为层（真 PG）：把**段**预算调小，段内 `statement_timeout` 必须**不变**
//	   —— 这正是 V2 的 F1(a) 读数，修复后取向反转。
//
// 反向判据（防止拆分被无声合并回去）：B 里同时断言两个预算是**两个不同的量**
// （若有人把 `usageReclaimStatementBudgetMS` 删掉、让 `setUsageRetentionStatementBudget`
// 又取回 freeze 那个 var，B 立刻红）。

import (
	"database/sql"
	"testing"
	"time"
)

// r13geReadBudget 在一个按生产路径配置过的临界区事务里读回两个 GUC（毫秒值）。
// 走 `setUsageRetentionStatementBudget`（而不是自己拼 SET），所以判据与生产同源。
func r13geReadBudget(t *testing.T, db *sql.DB) (statementTimeout, lockTimeout string) {
	t.Helper()
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback() //nolint:errcheck
	if err := setUsageRetentionStatementBudget(tx); err != nil {
		t.Fatalf("setUsageRetentionStatementBudget: %v", err)
	}
	if err := tx.QueryRow(`SHOW statement_timeout`).Scan(&statementTimeout); err != nil {
		t.Fatalf("SHOW statement_timeout: %v", err)
	}
	if err := tx.QueryRow(`SHOW lock_timeout`).Scan(&lockTimeout); err != nil {
		t.Fatalf("SHOW lock_timeout: %v", err)
	}
	return statementTimeout, lockTimeout
}

// TestAuditR13GEReclaimBudgetOrderingInvariants 是判据 A（序关系，常量层）。
func TestAuditR13GEReclaimBudgetOrderingInvariants(t *testing.T) {
	t.Logf("lock=%dms statement=%dms freeze=%dms(余量=%dms) rollback=%dms scheduler=%s",
		usageReclaimLockTimeoutMS, usageReclaimStatementBudgetMS, usageReclaimFreezeBudgetMS,
		usageReclaimFreezeCommitMarginMS, usageReclaimRollbackBudgetMS, usageRetentionSchedulerPeriod)

	// ① 等锁上界必须严格小于单语句上界（否则"有界等待"永远被更严的语句上界截断，
	//    lock_timeout 的 55P03 分类再也拿不到 —— 延后会被误判成失败）。
	if !(usageReclaimLockTimeoutMS < usageReclaimStatementBudgetMS) {
		t.Errorf("序关系被破坏：lock_timeout(%dms) 必须 < statement(%dms)",
			usageReclaimLockTimeoutMS, usageReclaimStatementBudgetMS)
	}
	// ② 单语句上界必须**严格小于**段上界，且差值 = 给提交期留的余量。
	//    相等（旧形态）意味着两个语义同值、拆而不分：段 deadline 一到就中止，
	//    单语句上界永远不会成为先到的那个；而提交期完全没有余量。
	if !(usageReclaimStatementBudgetMS < usageReclaimFreezeBudgetMS) {
		t.Errorf("单语句预算(%dms) 必须**严格小于**段预算(%dms) —— 相等即「一变量两语义」的等价形态"+
			"（段 deadline 先到，单语句上界永不生效，且提交期零余量）",
			usageReclaimStatementBudgetMS, usageReclaimFreezeBudgetMS)
	}
	if got := usageReclaimFreezeBudgetMS - usageReclaimStatementBudgetMS; got != usageReclaimFreezeCommitMarginMS {
		t.Errorf("段预算 - 单语句预算 = %dms，want 提交期余量 %dms（差值必须是那个具名常量，不能是魔法数）",
			got, usageReclaimFreezeCommitMarginMS)
	}
	// ③ 一轮（段 + 回滚余量）必须显著短于调度周期 —— 否则一轮跑不完就撞下一轮，
	//    清理永久堆积（"整轮上界与关系数无关"这条不变量也会失效）。
	round := (time.Duration(usageReclaimFreezeBudgetMS) + time.Duration(usageReclaimRollbackBudgetMS)) * time.Millisecond
	if !(round < usageRetentionSchedulerPeriod) {
		t.Errorf("段预算 + 回滚余量 = %s，必须 < 调度周期 %s（一轮跑不完就撞下一轮）",
			round, usageRetentionSchedulerPeriod)
	}
	// ④ 余量必须为正（否则"段 = 单语句 + 余量"退化成相等，同 ②）。
	if usageReclaimFreezeCommitMarginMS <= 0 {
		t.Errorf("提交期余量必须 > 0，得到 %dms", usageReclaimFreezeCommitMarginMS)
	}
}

// TestAuditR13GEReclaimStatementBudgetIsIndependentFromSegmentBudget 是判据 B（真 PG）。
//
// 把**段**预算改小（测试注入点），再问该段事务里的 `statement_timeout` —— 它必须
// 仍然是单语句预算。修复前这里是 "1234ms"（段预算渗进了语句预算）。
func TestAuditR13GEReclaimStatementBudgetIsIndependentFromSegmentBudget(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()

	prev := usageReclaimFreezeBudgetMS
	const shrinkMS = 1234
	usageReclaimFreezeBudgetMS = shrinkMS
	t.Cleanup(func() { usageReclaimFreezeBudgetMS = prev })

	statement, lock := r13geReadBudget(t, db)
	t.Logf("段预算缩到 %dms 后：statement_timeout=%q lock_timeout=%q（单语句预算应为 %dms）",
		shrinkMS, statement, lock, usageReclaimStatementBudgetMS)
	wantStatement := (time.Duration(usageReclaimStatementBudgetMS) * time.Millisecond).String()
	if statement != wantStatement {
		t.Errorf("段预算渗进了段内单语句预算：statement_timeout=%q，want %q —— "+
			"这正是 V2-6 的「一变量两语义」（两个旋钮必须互不牵连）", statement, wantStatement)
	}
	wantLock := (time.Duration(usageReclaimLockTimeoutMS) * time.Millisecond).String()
	if lock != wantLock {
		t.Errorf("lock_timeout=%q，want %q", lock, wantLock)
	}
	// 反向：两个量必须是**两个不同的**具名量（防止有人把拆分合回去）。
	if usageReclaimFreezeBudgetMS == usageReclaimStatementBudgetMS {
		t.Errorf("段预算与单语句预算又变成同一个值（%d）—— 拆分被合回去了",
			usageReclaimFreezeBudgetMS)
	}
}
