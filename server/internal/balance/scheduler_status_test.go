package balance

// R6-A-2 判据（第六轮审计 2026-09-23，P1）：月度发放调度器必须有**可读的运行观测
// 出口**。
//
// 它是**唯一的自动发放路径**（另两个调用点是管理端手动 PUT /balance 与
// POST /balance/grant）：死掉时 `balance.enabled=true` 的部署里余额只减不增、
// 员工最终全部 429 BALANCE_EXHAUSTED，而此前没有任何出口能指出"发放循环是死的"。
//
// 这里用**不可达的 DSN** 制造一个必然失败的轮次：正好覆盖两条最容易被写成"恒空"
// 的读数 —— errors 与 last_error（成功路径下 last_error 本来就是空串）。

import (
	"context"
	"database/sql"
	"strings"
	"testing"
	"time"
)

func unreachableDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sql.Open("pgx", "postgres://user:pass@127.0.0.1:1/never-connected")
	if err != nil {
		t.Fatalf("open placeholder db: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func TestSchedulerRunStatusRecordsRunsAndErrors(t *testing.T) {
	db := unreachableDB(t)
	s := NewScheduler(db, 10*time.Millisecond, nil)

	if s.Started() {
		t.Fatal("未 Start 时 Started() 必须为 false")
	}
	if !s.StartedAt().IsZero() || !s.LastRunAt().IsZero() || s.Runs() != 0 || s.Errors() != 0 || s.LastError() != "" {
		t.Fatal("未 Start 时全部读数必须是零值（恒空结构体与'还没跑'必须同形）")
	}
	if s.Tick() != 10*time.Millisecond {
		t.Fatalf("Tick() = %v, want 10ms", s.Tick())
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s.Start(ctx)

	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) && (s.Runs() < 1 || s.Errors() < 1) {
		time.Sleep(10 * time.Millisecond)
	}
	if !s.Started() {
		t.Fatal("Start 之后 Started() 仍为 false —— 可观测面看不到调度器已启动")
	}
	if s.StartedAt().IsZero() {
		t.Fatal("StartedAt() 为空 —— 启动时刻没记账")
	}
	if s.Runs() < 1 {
		t.Fatal("Runs() 为 0 —— 后台循环没有跑过（或没有记账）")
	}
	if s.Errors() < 1 {
		t.Fatal("Errors() 为 0 —— 不可达 DSN 下的失败轮次没有被记账")
	}
	if s.LastRunAt().IsZero() {
		t.Fatal("LastRunAt() 为空 —— '上次何时'没有出口")
	}
	if strings.TrimSpace(s.LastError()) == "" {
		t.Fatal("LastError() 为空 —— '上次错误'没有出口（运维看不到为什么没发放）")
	}
}

// TestTryRunIsTheSingleRoundEntry 锁住"公开单轮入口与 Start 走同一条实现"：
// 直接调 TryRun 也必须记账（否则外部按单轮驱动时观测面看不到）。
func TestTryRunRecordsRound(t *testing.T) {
	db := unreachableDB(t)
	s := NewScheduler(db, time.Hour, nil)
	s.TryRun()
	if s.Runs() != 1 {
		t.Fatalf("TryRun 之后 Runs() = %d, want 1", s.Runs())
	}
	if s.Errors() != 1 || strings.TrimSpace(s.LastError()) == "" {
		t.Fatal("TryRun 的失败没有被记账（errors/last_error）")
	}
}

func TestSchedulerStartWithNilDBIsObservableNoop(t *testing.T) {
	s := NewScheduler(nil, time.Millisecond, nil)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s.Start(ctx)
	if s.Started() || s.Runs() != 0 {
		t.Fatal("nil db 必须静默不启动，且 Started()/Runs() 如实为 false/0（不得谎报已启动）")
	}
	s.TryRun() // nil db 的单轮调用同样不得 panic
	if s.Runs() != 0 {
		t.Fatal("nil db 的 TryRun 不该记一轮（它什么都没做）")
	}
}
