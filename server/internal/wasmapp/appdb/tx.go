package appdb

import (
	"context"
	"fmt"
	"time"

	"github.com/picoaide/picoaide/internal/wasmapp/abi"
	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// 本文件实现 §5.1 的 `db.tx`：ABI 层是 tx_begin / tx_commit / tx_rollback。
//
// 语义（§5.1、§4.4）：
//   - 同时最多一个事务（应用并发恒为 1，事务挂在读写连接上）；
//   - 事务内只允许 db.query/db.exec（其他宿主调用由 runtime 拒绝，`InTx()` 必须准确）；
//   - **硬超时 5 s 强制回滚**（limits.SQLStatementBudget），到点由看门狗回滚并打污染标记，
//     绝不允许「超时后继续以自动提交模式写」把原子性悄悄破坏掉；
//   - Commit/Rollback 的 p.TxID 非零时必须与当前事务一致（防串号）。

// txSession 是一次事务的运行态。
type txSession struct {
	id       int64
	ctx      context.Context
	cancel   context.CancelFunc
	timer    *time.Timer
	deadline time.Time
	// done 表示事务已终结（提交/回滚/超时回滚），防看门狗与调用方重复处理。
	done bool
	// timedOut 表示是被硬超时强制回滚的。
	timedOut bool
}

// Begin 开启事务并返回事务标识。实现 capapi.DB。
func (d *DB) Begin(ctx context.Context) (abi.TxResult, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if err := d.ensureReadyLocked(true); err != nil {
		return abi.TxResult{}, err
	}
	if d.tx != nil {
		return abi.TxResult{}, denied("tx_already_open",
			"已经有一个进行中的事务：同一时刻只允许一个事务").
			WithDetail("tx_id", d.tx.id).
			WithHint("请先 tx_commit 或 tx_rollback 再开新事务")
	}
	cctx, cancel := context.WithTimeout(ctx, d.budget)
	defer cancel()
	// L4：执行前复检即将使用的那条读写连接仍带全套限额（FIX-12）。
	conn, cerr := d.checkedConnLocked(ctx, false)
	if cerr != nil {
		return abi.TxResult{}, cerr
	}
	// BEGIN IMMEDIATE：开事务即取写锁，避免「先读后写」在同一连接上升级锁失败
	// （SQLITE_BUSY）这种难以诊断的失败形态。
	if _, err := conn.ExecContext(cctx, "BEGIN IMMEDIATE"); err != nil {
		return abi.TxResult{}, d.mapStmtErrorLocked(cctx, err)
	}
	d.nextTxID++
	txCtx, txCancel := context.WithTimeout(context.Background(), d.budget)
	tx := &txSession{
		id:       d.nextTxID,
		ctx:      txCtx,
		cancel:   txCancel,
		deadline: time.Now().Add(d.budget),
	}
	d.tx = tx
	// 看门狗：到点强制回滚（§5.1「事务硬超时 5 s 强制回滚」）。
	tx.timer = time.AfterFunc(d.budget, func() { d.expireTx(tx) })
	return abi.TxResult{TxID: tx.id}, nil
}

// Commit 提交当前事务；p.TxID 非零时校验一致性。实现 capapi.DB。
func (d *DB) Commit(ctx context.Context, p abi.TxParams) error {
	return d.finishTx(ctx, p, true)
}

// Rollback 回滚当前事务；p.TxID 非零时校验一致性。实现 capapi.DB。
func (d *DB) Rollback(ctx context.Context, p abi.TxParams) error {
	return d.finishTx(ctx, p, false)
}

// InTx 报告当前是否有打开的事务（事务内禁止其他宿主调用，§4.4）。实现 capapi.DB。
func (d *DB) InTx() bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.tx != nil
}

func (d *DB) finishTx(ctx context.Context, p abi.TxParams, commit bool) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	// write=true：事务硬超时后的"写闸"（deadTx）在这里生效 —— 应用可能仍以为自己在
	// 事务里，必须继续看到同一条超时错误，而不是含糊的 no_transaction。
	if err := d.ensureReadyLocked(true); err != nil {
		return err
	}
	tx := d.tx
	if tx == nil {
		return denied("no_transaction", "没有进行中的事务").WithDetail("tx_id", p.TxID)
	}
	if p.TxID != 0 && p.TxID != tx.id {
		return denied("tx_mismatch",
			"tx_id 与当前事务不一致").
			WithDetail("want", tx.id).
			WithDetail("got", p.TxID).
			WithHint("请用 tx_begin 返回的 tx_id 提交/回滚")
	}
	if tx.timedOut || time.Now().After(tx.deadline) {
		d.rollbackLocked(tx)
		return txTimeoutError()
	}
	stmt := "ROLLBACK"
	if commit {
		stmt = "COMMIT"
	}
	cctx, cancel := context.WithTimeout(ctx, d.budget)
	defer cancel()
	conn, cerr := d.checkedConnLocked(ctx, false)
	if cerr != nil {
		return cerr
	}
	if _, err := conn.ExecContext(cctx, stmt); err != nil {
		// 引擎已经结束了这个事务（例如锁冲突）：清状态并如实返回，绝不谎报成功。
		d.clearTxLocked(tx)
		return d.mapStmtErrorLocked(cctx, err)
	}
	d.clearTxLocked(tx)
	return nil
}

// expireTx 是硬超时看门狗：强制回滚 + 污染标记（fail-closed）。
func (d *DB) expireTx(tx *txSession) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.tx != tx || tx.done {
		return
	}
	tx.timedOut = true
	d.rollbackLocked(tx)
	d.poisonLocked(txTimeoutError())
}

// rollbackLocked 尽最大努力回滚并清理事务状态。
//
// 注意 ctx 已经无关（超时路径下事务 ctx 必然已到期），这里用**独立**的短预算
// context.Background()：回滚是安全动作，不能因为调用方 ctx 已取消就不做。
func (d *DB) rollbackLocked(tx *txSession) {
	if tx.cancel != nil {
		tx.cancel()
	}
	if d.rw != nil {
		ctx, cancel := context.WithTimeout(context.Background(), d.budget)
		_, _ = d.rw.ExecContext(ctx, "ROLLBACK")
		cancel()
	}
	d.clearTxLocked(tx)
}

// clearTxLocked 停表、取消事务 ctx、清空当前事务（幂等）。
func (d *DB) clearTxLocked(tx *txSession) {
	tx.done = true
	if tx.timer != nil {
		tx.timer.Stop()
	}
	if tx.cancel != nil {
		tx.cancel()
	}
	if d.tx == tx {
		d.tx = nil
	}
}

// txTimeoutError 是事务硬超时的统一错误（DB_DENIED + ReasonTransactionTimeout）。
//
// reason 用**导出常量**而不是字面量：句柄池（appserver）按同一个常量识别"该回收句柄"。
// 审计 P0-2 的根因就是两端各写一个字符串（生产者 transaction_timeout、消费者 tx_timeout），
// 于是这次超时永远不被回收 ⇒ 该应用直到进程重启都不可用。
func txTimeoutError() *apperr.Error {
	return apperr.Newf(apperr.CodeDBDenied,
		"事务超过 %s 硬预算，已强制回滚（事务内所有写入均未生效）", limits.SQLStatementBudget).
		WithDetail("reason", ReasonTransactionTimeout).
		WithDetail("budget_ms", limits.SQLStatementBudget.Milliseconds()).
		WithHint(fmt.Sprintf("请把事务体缩小到 %s 内：只包必要的写，把查询与 AI 调用放到事务外",
			limits.SQLStatementBudget))
}
