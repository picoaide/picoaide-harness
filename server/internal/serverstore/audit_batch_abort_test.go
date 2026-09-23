package serverstore

import (
	"testing"
)

// R4-C-5（审计 2026-09-23，P2）：审计批写在"事务不可用"路径上曾经**报成功但整批
// 回滚** —— `failAll(err, i)` 只标记 errs[i..n-1]，errs[0..i-1] 仍是 nil（=成功），
// 而函数随即 return、`defer tx.Rollback()` 把已插入的行一起丢弃。调用方（worker →
// r.done → AuditLog 的调用点）被告知"这几条审计写成功了"，实际一条都没落库，且
// 既不计数也不打日志 —— 方向与 FIX-12"审计丢失必须可观测"完全相反。
//
// 判据：**要么全部成功、要么如实报告失败**。事务被判废时（SAVEPOINT 发不出去）
// 必须整批报失败。
//
// 触发路径怎么确定性地构造：SAVEPOINT 是事务里的第一条语句，只有当事务**已经**
// 被 PG 打成 aborted 时才会失败（SQLSTATE 25P02）。测试通过 auditBatchFaultHook
// 在建立保存点之前注入一条必然报错的语句（`SELECT 1/0`）来制造这个状态 —— 这不是
// 桩化驱动，而是真实 PG 的真实错误路径。
//
// 变异验证：把 `return failAll(err, 0)` 改回 `return failAll(err, i)` ⇒ 本用例红
// （前半批会被报成成功）。
func TestAuditBatchAbortedTransactionReportsWholeBatchFailed(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()

	const n = 4
	done := make(chan error, n)
	batch := make([]auditRequest, 0, n)
	for i := 0; i < n; i++ {
		batch = append(batch, auditRequest{
			username: "admin",
			action:   "act_abort",
			detail:   "abort-" + string(rune('a'+i)),
			done:     done,
		})
	}

	// 在第 2 条（i=1）建立保存点**之前**把事务打成 aborted：
	// 第 0 条已经成功插入，第 1 条起 SAVEPOINT 必然报 25P02。
	hook := func(ex auditBatchExecer, i int) {
		if i == 1 {
			if _, err := ex.Exec("SELECT 1/0"); err == nil {
				t.Errorf("故障注入失效：SELECT 1/0 竟然成功")
			}
		}
	}
	auditBatchFaultHook.Store(&hook)
	defer auditBatchFaultHook.Store(nil)

	errs := writeAuditBatch(db, batch)
	if len(errs) != n {
		t.Fatalf("errs len = %d, want %d（必须逐条返回错误）", len(errs), n)
	}
	for i, err := range errs {
		if err == nil {
			t.Fatalf("第 %d 条被报成成功，但整批已随 defer tx.Rollback() 丢弃 —— "+
				"这正是 R4-C-5 的形态（报成功但实际丢失）", i)
		}
	}
	// 报"全部失败"就必须真的全部没落库（返回值与实际一致）。
	for i := 0; i < n; i++ {
		detail := "abort-" + string(rune('a'+i))
		if got := auditCount(t, db, detail); got != 0 {
			t.Fatalf("第 %d 条既被报失败又落了库（%q rows=%d），返回值与实际不一致", i, detail, got)
		}
	}
	// 链在整批失败后必须仍然完整（不得留下半截不连续的链）。
	if id, err := VerifyAuditChain(db); err != nil || id != 0 {
		t.Fatalf("整批失败后链必须完整: id=%d err=%v", id, err)
	}
}

// TestAuditBatchAbortAtFirstEntryReportsWholeBatchFailed 是同一条判据的边界形态：
// 第 0 条就失败（一条都没插入）。此时语义上与旧实现一致，用它锁住"注入路径本身
// 有效"（若注入失效、真的插入了行，本用例会红）。
func TestAuditBatchAbortAtFirstEntryReportsWholeBatchFailed(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()

	done := make(chan error, 2)
	batch := []auditRequest{
		{username: "admin", action: "act_abort0", detail: "abort-first", done: done},
		{username: "admin", action: "act_abort0", detail: "abort-second", done: done},
	}
	hook := func(ex auditBatchExecer, i int) {
		if i == 0 {
			if _, err := ex.Exec("SELECT 1/0"); err == nil {
				t.Errorf("故障注入失效：SELECT 1/0 竟然成功")
			}
		}
	}
	auditBatchFaultHook.Store(&hook)
	defer auditBatchFaultHook.Store(nil)

	errs := writeAuditBatch(db, batch)
	for i, err := range errs {
		if err == nil {
			t.Fatalf("第 %d 条被报成成功（事务在第一条就已判废）", i)
		}
	}
	if got := auditCount(t, db, "abort-first"); got != 0 {
		t.Fatalf("abort-first rows = %d, want 0", got)
	}
}
