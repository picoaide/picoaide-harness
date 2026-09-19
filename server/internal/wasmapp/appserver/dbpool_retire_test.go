package appserver

import (
	"context"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/wasmapp/abi"
	"github.com/picoaide/picoaide/internal/wasmapp/appdb"
	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// 本文件是审计 R1-rt-5 的回归护栏：**被放弃的宿主调用不能在句柄被池回收之后把 appdb 复活**。
//
// 现场（评审用探针实测：Close 之后 fd 0→7）：
//   - 宿主调用有硬预算（runtime.callHost 的 select），到点后请求返回、Dispatch goroutine
//     被**放弃**（注释明写"被放弃的 goroutine 最多多跑一会儿"）；
//   - 同一时刻句柄池在 `dirty && inflight==0` 时 `delete(p.handles) + Close()`；
//   - 而 appdb 的 Close 是"之后按需重连" ⇒ 被放弃的 goroutine 一旦在 Close **之后**
//     走到 appdb，就新建 1+N 条连接；这一代连接没有任何人再持有，永久泄漏。
//
// 修法：句柄池的**淘汰/关停**路径走 appdb.Retire（终态，不可重连），Close 保持"会话边界"
// 语义（污染恢复/会话恢复仍按需重连）。本用例断言三件事：
//
//	(a) fd/连接数不增长（不复活、不泄漏）；
//	(b) 被放弃的调用拿到**明确错误**（DB_DENIED + reason=appdb_retired），不是成功、不 panic；
//	(c) 下一次正常请求仍能拿到**全新**句柄并正常工作（淘汰只是缓存策略，不是功能降级）。
//
// 变异验证（实测：改回旧实现时哪条必红）：
//   - 把 release 的 `closeDB.Retire()` 改回 `closeDB.Close()`（旧行为）⇒ (a)(b) 两条必红
//     （fd 从 0 涨到 1+readers，且调用成功返回）；
//   - 把 acquire/sweepIdle/evictApp/closeAll 里任何一处 retire 改回 Close ⇒
//     对应用例（本文件 + TestAppDBPool_IdleEvictionReopensFreshHandle）必红；
//   - 把 Retire 实现成"只置标记不关连接" ⇒ (a) 必红（fd 不为 0）；
//   - 把 Retire 实现成 Close（清掉终态标记）⇒ (b) 必红（被放弃的调用会成功）。
func TestAppDBPool_RetiredHandleCannotBeResurrected(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	const appID = "retireprobe"

	p := newAppDBPoolWithMax(time.Now, 4)
	h, aerr := p.acquire(ctx, root, appID)
	if aerr != nil {
		t.Fatalf("acquire: %v", aerr)
	}
	db := h.db
	path := db.Path()
	if _, err := db.Query(ctx, abi.SQLParams{SQL: "SELECT 1"}); err != nil {
		t.Fatalf("前置：句柄应可用：%v", err)
	}
	wantConns := 1 + limits.AppDBReaders // 1 写 + N 读（池未注入 readers ⇒ appdb 默认）
	if got := countOpenFiles(t, path); got != wantConns {
		t.Fatalf("前置：句柄应持有 %d 条连接，实测 %d", wantConns, got)
	}

	// 构造"被放弃的宿主调用"：它持有 db 引用，并在**淘汰之后**才真正走到 appdb。
	// 用 channel 握手保证顺序确定性（不靠 sleep 赢竞态）。
	proceed := make(chan struct{})
	type outcome struct {
		err error
	}
	done := make(chan outcome, 1)
	go func() {
		<-proceed
		_, err := db.Query(ctx, abi.SQLParams{SQL: "SELECT 1"})
		done <- outcome{err: err}
	}()

	// 请求结束：句柄标脏 + inflight 归零 ⇒ 池按 dirty 淘汰它（评审现场的等价触发条件）。
	h.dirty.Store(true)
	p.release(h, false)
	if p.lookup(appID) != nil {
		t.Fatal("淘汰后句柄必须从池里摘除（否则下一次请求会复用它）")
	}
	if n := countOpenFiles(t, path); n != 0 {
		t.Fatalf("淘汰后这一代连接必须全部关闭，实测仍有 %d 条", n)
	}

	// 放行被放弃的调用：它只能拿到"句柄已回收"的明确错误，且不得新建连接。
	// (a) 与 (b) 都收集起来一次报出 —— 旧实现下这两件事**同时**发生
	// （复活成功 ⇒ 调用返回成功 且 fd 0→1+N），只报一条会埋掉另一半证据。
	close(proceed)
	select {
	case o := <-done:
		leaked := countOpenFiles(t, path)
		if leaked != 0 {
			t.Errorf("(a) 被放弃的调用不得新建连接（泄漏现场就是这里：fd 0→%d）", leaked)
		}
		if o.err == nil {
			t.Errorf("(b) 被放弃的调用在句柄回收之后必须拿到错误，而不是成功——这就是把 appdb 复活的那条路径")
		} else if aerr, ok := o.err.(*apperr.Error); !ok {
			t.Errorf("(b) 错误必须是 *apperr.Error（回给应用的 JSON-RPC 错误），得到 %T: %v", o.err, o.err)
		} else {
			if aerr.Code != apperr.CodeDBDenied {
				t.Errorf("(b) 错误码应为 DB_DENIED（可重试的会话边界），得到 %s: %s", aerr.Code, aerr.Message)
			}
			if got := aerr.Details["reason"]; got != "appdb_retired" {
				t.Errorf("(b) 明细应点名终态原因，得到 %v", aerr.Details)
			}
		}
		if t.Failed() {
			t.FailNow() // (a)/(b) 已给出判据，(c) 依赖它们成立才有意义
		}
	case <-time.After(10 * time.Second):
		t.Fatal("被放弃的调用没有返回（Retire 之后不得阻塞在建连上）")
	}

	// (c) 下一次正常请求：拿到**全新**句柄并正常工作（淘汰是缓存策略，不是功能降级）。
	h2, aerr := p.acquire(ctx, root, appID)
	if aerr != nil {
		t.Fatalf("(c) 淘汰后重新 acquire 必须成功：%v", aerr)
	}
	if h2 == h || h2.db == db {
		t.Fatal("(c) 淘汰后必须拿到全新句柄（复用被回收的 db 对象就是把泄漏变成静默复用）")
	}
	res, err := h2.db.Query(ctx, abi.SQLParams{SQL: "SELECT 1"})
	if err != nil {
		t.Fatalf("(c) 新句柄必须可用：%v", err)
	}
	if len(res.Rows) != 1 {
		t.Fatalf("(c) 新句柄的查询结果不对：%+v", res)
	}
	if n := countOpenFiles(t, path); n != wantConns {
		t.Fatalf("(c) 新句柄应持有 %d 条连接，实测 %d", wantConns, n)
	}
	h2.dirty.Store(true)
	p.release(h2, false)
	if n := countOpenFiles(t, path); n != 0 {
		t.Fatalf("收尾：淘汰后连接应归零，实测 %d", n)
	}
}

// TestAppDB_RetireIsNotClose：Retire 是**新增的终态**，不许把 Close 的"会话边界"语义改掉。
//
// 为什么单列一条（两条语义必须同时成立，缺哪条都会出问题）：
//   - Close 之后**必须**能按需重连：污染恢复（dropPoisonedConnectionsLocked）与
//     "一次语句超时后立即恢复"都建立在它上面 —— 改成终态会让一次超时把应用打到重启；
//   - Retire 之后**必须**不能重连：句柄池淘汰/关停走的就是它（R1-rt-5）。
func TestAppDB_RetireIsNotClose(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()

	db, err := appdb.Open(ctx, appdb.Options{DataRoot: root, AppID: "retiresemantics"})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer func() { _ = db.Retire() }()
	if db.Retired() {
		t.Fatal("刚打开的句柄不是终态")
	}
	// Close = 会话边界 ⇒ 之后按需重连。
	if err := db.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if _, err := db.Query(ctx, abi.SQLParams{SQL: "SELECT 1"}); err != nil {
		t.Fatalf("Close 之后必须仍能按需重连（污染恢复依赖它）：%v", err)
	}
	// Retire = 终态 ⇒ 之后不可能再建连，且幂等；Retire 之后的 Close 也不得复活。
	if err := db.Retire(); err != nil {
		t.Fatalf("Retire: %v", err)
	}
	if !db.Retired() {
		t.Fatal("Retire 之后必须报告终态")
	}
	if _, err := db.Query(ctx, abi.SQLParams{SQL: "SELECT 1"}); err == nil {
		t.Fatal("终态句柄不得重连")
	}
	if _, err := db.Exec(ctx, abi.SQLParams{SQL: "CREATE TABLE t (id INTEGER)"}); err == nil {
		t.Fatal("终态句柄不得执行写语句")
	}
	if err := db.Close(); err != nil {
		t.Fatalf("终态句柄上的 Close 应幂等：%v", err)
	}
	if _, err := db.Query(ctx, abi.SQLParams{SQL: "SELECT 1"}); err == nil {
		t.Fatal("Close 不得清掉终态（否则淘汰后的句柄会被下一次 Close 复活）")
	}
	if err := db.Retire(); err != nil {
		t.Fatalf("Retire 必须幂等：%v", err)
	}
}
