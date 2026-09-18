package appdb

import (
	"context"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/wasmapp/abi"
	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// 事务语义（§5.1 db.tx）：
//   - 同时最多一个事务；
//   - 事务内 db.query 走事务连接（看得到未提交的写）；
//   - Commit/Rollback 的 tx_id 非零时必须一致；
//   - 硬超时 5 s 强制回滚（这里用注入预算跑快版本）；
//   - InTx() 必须准确（runtime 靠它拒绝事务内的其他宿主调用，§4.4）。

func TestTransactionCommitAndRollback(t *testing.T) {
	root := t.TempDir()
	d := newTestDBIn(t, root, "tx-app")
	defineTable(t, d, "items", col("v", "text"))
	ctx := context.Background()

	// ---- 回滚路径 ----
	tx, err := d.Begin(ctx)
	if err != nil {
		t.Fatalf("Begin 失败：%v", err)
	}
	if tx.TxID == 0 {
		t.Fatal("tx_id 必须非零")
	}
	if !d.InTx() {
		t.Fatal("Begin 后 InTx() 应为 true")
	}
	mustExec(t, d, "INSERT INTO items(v) VALUES (?)", "rolled-back")
	// 事务内查询看得到自己的未提交写（db.query 走事务连接）。
	res, err := d.Query(ctx, abi.SQLParams{SQL: "SELECT count(*) FROM items"})
	if err != nil {
		t.Fatalf("事务内查询失败：%v", err)
	}
	if res.Rows[0][0].(int64) != 1 {
		t.Fatalf("事务内应看到自己的写：%+v", res.Rows)
	}
	if err := d.Rollback(ctx, abi.TxParams{TxID: tx.TxID}); err != nil {
		t.Fatalf("Rollback 失败：%v", err)
	}
	if d.InTx() {
		t.Fatal("Rollback 后 InTx() 应为 false")
	}
	res, err = d.Query(ctx, abi.SQLParams{SQL: "SELECT count(*) FROM items"})
	if err != nil {
		t.Fatalf("Query 失败：%v", err)
	}
	if res.Rows[0][0].(int64) != 0 {
		t.Fatalf("回滚后不应有数据：%+v", res.Rows)
	}

	// ---- 提交路径 ----
	tx, err = d.Begin(ctx)
	if err != nil {
		t.Fatalf("Begin 失败：%v", err)
	}
	mustExec(t, d, "INSERT INTO items(v) VALUES (?)", "committed")
	if err := d.Commit(ctx, abi.TxParams{TxID: tx.TxID}); err != nil {
		t.Fatalf("Commit 失败：%v", err)
	}
	if d.InTx() {
		t.Fatal("Commit 后 InTx() 应为 false")
	}
	// 另一个 DB 对象（独立连接）必须看得到提交结果。
	other := newTestDBIn(t, root, "tx-app")
	res, err = other.Query(ctx, abi.SQLParams{SQL: "SELECT v FROM items"})
	if err != nil {
		t.Fatalf("重开查询失败：%v", err)
	}
	if len(res.Rows) != 1 || res.Rows[0][0] != "committed" {
		t.Fatalf("提交结果应落盘：%+v", res.Rows)
	}

	// tx_id 省略（0）也允许提交/回滚（abi.TxParams 里 tx_id 可选）。
	tx, err = d.Begin(ctx)
	if err != nil {
		t.Fatalf("Begin 失败：%v", err)
	}
	if err := d.Rollback(ctx, abi.TxParams{}); err != nil {
		t.Fatalf("省略 tx_id 的 Rollback 应成功：%v", err)
	}
}

func TestTransactionSingleAtATime(t *testing.T) {
	d := newTestDB(t, "single-tx-app")
	ctx := context.Background()
	tx, err := d.Begin(ctx)
	if err != nil {
		t.Fatalf("Begin 失败：%v", err)
	}
	_, err = d.Begin(ctx)
	e := requireAppErr(t, err, apperr.CodeDBDenied)
	requireReason(t, e, "tx_already_open")
	if e.Details["tx_id"] != tx.TxID {
		t.Fatalf("details.tx_id 应为当前事务 %d，实际 %v", tx.TxID, e.Details["tx_id"])
	}
	if err := d.Rollback(ctx, abi.TxParams{TxID: tx.TxID}); err != nil {
		t.Fatalf("Rollback 失败：%v", err)
	}
	// 结束后可以再开。
	tx2, err := d.Begin(ctx)
	if err != nil {
		t.Fatalf("再次 Begin 失败：%v", err)
	}
	if tx2.TxID == tx.TxID {
		t.Fatalf("tx_id 应当递增，两次都是 %d", tx.TxID)
	}
	if err := d.Rollback(ctx, abi.TxParams{TxID: tx2.TxID}); err != nil {
		t.Fatalf("Rollback 失败：%v", err)
	}
}

func TestTransactionTxIDMismatchRejected(t *testing.T) {
	d := newTestDB(t, "mismatch-app")
	ctx := context.Background()
	tx, err := d.Begin(ctx)
	if err != nil {
		t.Fatalf("Begin 失败：%v", err)
	}
	defer func() { _ = d.Rollback(ctx, abi.TxParams{TxID: tx.TxID}) }()

	err = d.Commit(ctx, abi.TxParams{TxID: tx.TxID + 99})
	e := requireAppErr(t, err, apperr.CodeDBDenied)
	requireReason(t, e, "tx_mismatch")
	if e.Details["want"] != tx.TxID {
		t.Fatalf("details.want 应为 %d，实际 %v", tx.TxID, e.Details["want"])
	}
	if !d.InTx() {
		t.Fatal("tx_id 不一致被拒后，事务必须仍然打开（不能误回滚）")
	}
	// 用正确的 tx_id 仍可正常提交。
	if err := d.Commit(ctx, abi.TxParams{TxID: tx.TxID}); err != nil {
		t.Fatalf("正确 tx_id 的 Commit 应成功：%v", err)
	}
}

func TestCommitOrRollbackWithoutTransaction(t *testing.T) {
	d := newTestDB(t, "notx-app")
	ctx := context.Background()
	if err := d.Commit(ctx, abi.TxParams{}); err == nil {
		t.Fatal("没有事务时 Commit 应报错")
	} else {
		requireReason(t, requireAppErr(t, err, apperr.CodeDBDenied), "no_transaction")
	}
	if err := d.Rollback(ctx, abi.TxParams{}); err == nil {
		t.Fatal("没有事务时 Rollback 应报错")
	} else {
		requireReason(t, requireAppErr(t, err, apperr.CodeDBDenied), "no_transaction")
	}
	if d.InTx() {
		t.Fatal("InTx() 应为 false")
	}
}

// TestTransactionHardTimeoutRollsBack 覆盖 §5.1「事务硬超时 5 s 强制回滚」。
// 用注入预算（200 ms）跑快版本；生产预算恒为 limits.SQLStatementBudget（5 s）。
//
// 变异方式：去掉 Begin 里的看门狗（time.AfterFunc）⇒ 超时后事务不会回滚，本用例变红。
func TestTransactionHardTimeoutRollsBack(t *testing.T) {
	old := defaultStmtBudget
	defaultStmtBudget = 200 * time.Millisecond
	t.Cleanup(func() { defaultStmtBudget = old })

	root := t.TempDir()
	d := newTestDBIn(t, root, "txtimeout-app")
	defineTable(t, d, "items", col("v", "text"))
	ctx := context.Background()

	tx, err := d.Begin(ctx)
	if err != nil {
		t.Fatalf("Begin 失败：%v", err)
	}
	mustExec(t, d, "INSERT INTO items(v) VALUES (?)", "must-not-persist")
	if !d.InTx() {
		t.Fatal("事务应处于打开状态")
	}
	time.Sleep(400 * time.Millisecond) // 超过事务预算，等看门狗强制回滚

	if d.InTx() {
		t.Fatal("硬超时后 InTx() 必须为 false（已强制回滚）")
	}
	err = d.Commit(ctx, abi.TxParams{TxID: tx.TxID})
	e := requireAppErr(t, err, apperr.CodeDBDenied)
	requireReason(t, e, "transaction_timeout")
	if e.Details["budget_ms"] != limits.SQLStatementBudget.Milliseconds() {
		t.Fatalf("details.budget_ms 应为 %d，实际 %v", limits.SQLStatementBudget.Milliseconds(), e.Details["budget_ms"])
	}

	// 独立 DB 对象确认：超时事务里的写入没有落盘。
	other := newTestDBIn(t, root, "txtimeout-app")
	res, err := other.Query(ctx, abi.SQLParams{SQL: "SELECT count(*) FROM items"})
	if err != nil {
		t.Fatalf("重开查询失败：%v", err)
	}
	if n := res.Rows[0][0].(int64); n != 0 {
		t.Fatalf("超时事务必须整体回滚，实际留下 %d 行", n)
	}
}

// TestTransactionQueryDoesNotUseReadOnlyConn 钉住「事务内查询走事务连接」这一必要行为：
// 只读连接在事务外才用；如果实现退回「事务内也走 ro」，未提交数据将不可见，本用例变红。
func TestTransactionQueryDoesNotUseReadOnlyConn(t *testing.T) {
	d := newTestDB(t, "txconn-app")
	defineTable(t, d, "items", col("v", "text"))
	ctx := context.Background()
	tx, err := d.Begin(ctx)
	if err != nil {
		t.Fatalf("Begin 失败：%v", err)
	}
	defer func() { _ = d.Rollback(ctx, abi.TxParams{TxID: tx.TxID}) }()
	if d.readConnLocked() != d.rw {
		t.Fatal("事务内读连接必须是事务连接（rw）")
	}
	mustExec(t, d, "INSERT INTO items(v) VALUES (?)", "uncommitted")
	res, err := d.Query(ctx, abi.SQLParams{SQL: "SELECT v FROM items"})
	if err != nil {
		t.Fatalf("Query 失败：%v", err)
	}
	if len(res.Rows) != 1 || res.Rows[0][0] != "uncommitted" {
		t.Fatalf("事务内必须看到未提交写：%+v", res.Rows)
	}
	if err := d.Rollback(ctx, abi.TxParams{TxID: tx.TxID}); err != nil {
		t.Fatalf("Rollback 失败：%v", err)
	}
	if d.readConnLocked() != d.ro {
		t.Fatal("事务外读连接必须是只读连接（ro）")
	}
}

// TestCloseRollsBackOpenTransaction：未结束的事务在 Close 时必须被回滚（fail-closed）。
func TestCloseRollsBackOpenTransaction(t *testing.T) {
	root := t.TempDir()
	d := newTestDBIn(t, root, "close-tx-app")
	defineTable(t, d, "items", col("v", "text"))
	ctx := context.Background()
	if _, err := d.Begin(ctx); err != nil {
		t.Fatalf("Begin 失败：%v", err)
	}
	mustExec(t, d, "INSERT INTO items(v) VALUES (?)", "half-open")
	if err := d.Close(); err != nil {
		t.Fatalf("Close 失败：%v", err)
	}
	other := newTestDBIn(t, root, "close-tx-app")
	res, err := other.Query(ctx, abi.SQLParams{SQL: "SELECT count(*) FROM items"})
	if err != nil {
		t.Fatalf("重开查询失败：%v", err)
	}
	if n := res.Rows[0][0].(int64); n != 0 {
		t.Fatalf("关闭时未提交的事务必须被回滚，实际留下 %d 行", n)
	}
}

// TestTransactionTimeoutWriteGateAndRecovery 覆盖 FIX-10 的两条恢复路径 + 写闸：
//   - 事务硬超时（看门狗）后：污染标记与"写闸"都置位；
//   - **读**可以立刻恢复（丢弃被污染的整组连接后重连继续），但**写**
//     （db.exec / db.define / tx_commit）继续返回同一条 transaction_timeout ——
//     绝不能因为"事务已被回滚"就让应用的写落到自动提交模式（tx.go 头注释的硬约束）；
//   - 会话边界（Close）清掉污染与写闸，重开后读写都恢复（审计 P0-2 的修复要求）。
//
// 变异方式：把 ensureReadyLocked 里的 deadTx 判定去掉 ⇒ 超时后的写会以自动提交模式成功，
// 本用例的"写必须被拒"变红。
func TestTransactionTimeoutWriteGateAndRecovery(t *testing.T) {
	old := defaultStmtBudget
	defaultStmtBudget = 200 * time.Millisecond
	t.Cleanup(func() { defaultStmtBudget = old })

	root := t.TempDir()
	d := newTestDBIn(t, root, "txgate-app")
	defineTable(t, d, "items", col("v", "text"))
	ctx := context.Background()

	// reason 常量是 appdb 与句柄池（appserver）之间的唯一真源：这里钉住生产侧用的值。
	if got := reasonOf(txTimeoutError()); got != ReasonTransactionTimeout {
		t.Fatalf("事务超时的 reason 应为常量 %q，实际 %q", ReasonTransactionTimeout, got)
	}
	if got := reasonOf(mapStmtErrorLockedErrorForTest(d)); got != ReasonStatementTimeout {
		t.Fatalf("语句超时的 reason 应为常量 %q，实际 %q", ReasonStatementTimeout, got)
	}

	if _, err := d.Begin(ctx); err != nil {
		t.Fatalf("Begin 失败：%v", err)
	}
	mustExec(t, d, "INSERT INTO items(v) VALUES (?)", "in-tx")
	time.Sleep(400 * time.Millisecond) // 超过事务预算，等看门狗强制回滚

	if d.poisoned == nil {
		t.Fatal("事务硬超时后必须置污染标记（不复用被中断的连接）")
	}
	if d.deadTx == nil {
		t.Fatal("事务硬超时后必须置写闸（应用可能仍以为自己在事务里）")
	}

	// 写：继续被拒，且 reason 是同一个常量（句柄池据此回收句柄）。
	if _, err := d.Exec(ctx, abi.SQLParams{SQL: "INSERT INTO items(v) VALUES ('post-timeout')"}); err == nil {
		t.Fatal("事务硬超时后的写必须被拒（否则原子性被静默破坏）")
	} else {
		requireReason(t, requireAppErr(t, err, apperr.CodeDBDenied), ReasonTransactionTimeout)
	}

	// 读：立刻恢复（重连后的新连接），并且超时事务的写整体回滚。
	res, err := d.Query(ctx, abi.SQLParams{SQL: "SELECT count(*) FROM items"})
	if err != nil {
		t.Fatalf("事务超时后的读应能恢复：%v", err)
	}
	if n := res.Rows[0][0].(int64); n != 0 {
		t.Fatalf("超时事务的写必须整体回滚，实际留下 %d 行", n)
	}
	// 写闸不因"读的恢复"而清除（只有会话边界才清）。
	if _, err := d.Exec(ctx, abi.SQLParams{SQL: "INSERT INTO items(v) VALUES ('still-blocked')"}); err == nil {
		t.Fatal("读恢复之后写闸仍必须生效")
	} else {
		requireReason(t, requireAppErr(t, err, apperr.CodeDBDenied), ReasonTransactionTimeout)
	}
	// 建表与新事务同属"写"面，同样被写闸拦下。
	if _, err := d.Define(ctx, abi.DBDefineParams{Table: "t2", Columns: []abi.ColumnDef{col("a", "text")}}); err == nil {
		t.Fatal("写闸生效期间 db.define 必须被拒")
	}
	if _, err := d.Begin(ctx); err == nil {
		t.Fatal("写闸生效期间不应能开新事务")
	}

	// 会话边界：Close 清毒 + 清写闸，重开后读写都恢复。
	if err := d.Close(); err != nil {
		t.Fatalf("Close 失败：%v", err)
	}
	if d.poisoned != nil || d.deadTx != nil {
		t.Fatal("Close 必须清掉污染标记与写闸")
	}
	mustExec(t, d, "INSERT INTO items(v) VALUES (?)", "after-close")
	res, err = d.Query(ctx, abi.SQLParams{SQL: "SELECT count(*) FROM items"})
	if err != nil {
		t.Fatalf("Close 后查询应可用：%v", err)
	}
	if n := res.Rows[0][0].(int64); n != 1 {
		t.Fatalf("Close 后应能写入并读回 1 行，实际 %d", n)
	}
}

// TestPoisonRecoveryWorksWhenCallerCtxIsAlreadyDead 是 FIX-10 恢复路径的边界：
// 单语句超时往往正是"调用方 ctx 到期"造成的，此时同一个请求里的**下一次**调用
// 仍然必须能完成恢复（重连用独立 ctx），并如实返回超时语义，而不是
// "获取只读连接失败"这种误导性错误。
//
// 变异方式：把 ensureReadyLocked 里的恢复改成用调用方 ctx ⇒ 本用例红。
func TestPoisonRecoveryWorksWhenCallerCtxIsAlreadyDead(t *testing.T) {
	d := newTestDB(t, "deadctx-app")
	defineTable(t, d, "items", col("v", "text"))
	ctx := context.Background()
	if err := d.Close(); err != nil { // 让下一次调用走"按需重连"路径
		t.Fatalf("Close 失败：%v", err)
	}

	dead, cancel := context.WithCancel(ctx)
	cancel() // 已到期的 ctx：任何语句都必然 statement_timeout
	_, err := d.Query(dead, abi.SQLParams{SQL: "SELECT 1"})
	e := requireAppErr(t, err, apperr.CodeDBDenied)
	requireReason(t, e, ReasonStatementTimeout)
	if d.poisoned == nil {
		t.Fatal("超时后必须置污染标记")
	}

	// 同一个已到期的 ctx 再调一次：恢复必须成功（维护动作走独立 ctx，
	// 不会因为调用方 ctx 已死而拿不到连接），错误仍是超时语义。
	oldRO, oldRW := d.ro, d.rw
	_, err = d.Query(dead, abi.SQLParams{SQL: "SELECT 1"})
	e = requireAppErr(t, err, apperr.CodeDBDenied)
	requireReason(t, e, ReasonStatementTimeout)
	if d.ro == oldRO || d.rw == oldRW {
		t.Fatal("被污染的整组连接必须被换掉（恢复动作不能因为调用方 ctx 已死而跳过）")
	}
	// 换一个健康的 ctx：对象已经完全可用（上一次超时的污染在下一次调用里被清掉）。
	res, err := d.Query(ctx, abi.SQLParams{SQL: "SELECT 1"})
	if err != nil {
		t.Fatalf("健康 ctx 下必须可用：%v", err)
	}
	if len(res.Rows) != 1 {
		t.Fatalf("应返回 1 行：%+v", res.Rows)
	}
}
