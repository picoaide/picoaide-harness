package main

// 装配级判据（R15C-R-01 ①，审计 2026-09-25，P1）：API 令牌过期回收调度器必须真的在
// **启动路径**上被构造并启动。
//
// 背景：`api_tokens` 此前**完全没有回收者**（DELETE 只有 4 处按 user_id），迁移 0031
// 建的 `idx_tokens_expires` 实测 `idx_scan = 0`，500 条过期行重启服务后依然存在。
// 修法是挂周期调度器（internal/tokenretention），但"挂上去"必须可被判据观察 ——
// 只加一行 `Start(ctx)` 时，删掉那一行所有门禁依旧全绿（本仓已用同一手法踩过多次：
// 网关回收器、审计保留、usage 保留三条装配漂移都只能靠读装配源码发现）。
//
// 两条判据互补（与 audit_retention_test.go 同款）：
//   - 执行级（TestTokenRetentionSchedulerWiring）：把构造点换成桩，断言启动路径用它
//     构造了调度器、**登记进调度器状态表**并调用了 Start，参数是（启动期 ctx,
//     同一个 db, 间隔常量）；
//   - 源码级（TestStartupCallsTokenRetentionScheduler）：断言 main() 里存在
//     `startTokenRetentionScheduler(ctx, db, tokenretention.DefaultTick)`，且在
//     signal ctx 之后 —— 整行删掉/挪进不执行的分支由这一条兜住。

import (
	"context"
	"database/sql"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/tokenretention"
)

// fakeObservableScheduler 是 observableScheduler 的桩（记录 Start 是否被调用、
// 拿到什么 ctx/db/tick；读数一律为零值）。
type fakeObservableScheduler struct {
	ctx   context.Context
	start chan struct{}
}

func (f *fakeObservableScheduler) Start(ctx context.Context) {
	f.ctx = ctx
	close(f.start)
}
func (f *fakeObservableScheduler) Started() bool        { return true }
func (f *fakeObservableScheduler) StartedAt() time.Time { return time.Time{} }
func (f *fakeObservableScheduler) Runs() int64          { return 0 }
func (f *fakeObservableScheduler) Errors() int64        { return 0 }
func (f *fakeObservableScheduler) LastRunAt() time.Time { return time.Time{} }
func (f *fakeObservableScheduler) LastError() string    { return "" }
func (f *fakeObservableScheduler) Tick() time.Duration  { return tokenretention.DefaultTick }

type tokenRetentionCtxKey struct{}

func TestTokenRetentionSchedulerWiring(t *testing.T) {
	resetSchedulerStatus(t)
	got := make(chan *fakeObservableScheduler, 1)
	prev := newTokenRetentionScheduler
	t.Cleanup(func() { newTokenRetentionScheduler = prev })
	var gotDB *sql.DB
	var gotTick time.Duration
	newTokenRetentionScheduler = func(db *sql.DB, tick time.Duration) observableScheduler {
		gotDB, gotTick = db, tick
		f := &fakeObservableScheduler{start: make(chan struct{})}
		got <- f
		return f
	}

	db, err := sql.Open("pgx", "postgres://user:pass@127.0.0.1:1/never-connected")
	if err != nil {
		t.Fatalf("open placeholder db: %v", err)
	}
	defer db.Close()

	parent, cancel := context.WithCancel(context.WithValue(context.Background(), tokenRetentionCtxKey{}, "startup"))
	defer cancel()
	startTokenRetentionScheduler(parent, db, tokenretention.DefaultTick)

	var f *fakeObservableScheduler
	select {
	case f = <-got:
	case <-time.After(5 * time.Second):
		t.Fatal("启动路径没有构造令牌回收调度器（装配接缝未被调用）")
	}
	select {
	case <-f.start:
	case <-time.After(5 * time.Second):
		t.Fatal("构造了调度器但没有调用 Start（回收者不会运行）")
	}
	if gotDB != db {
		t.Fatal("调度器拿到的不是启动期的 db")
	}
	if gotTick != tokenretention.DefaultTick {
		t.Fatalf("tick = %v, want %v（装配必须传默认间隔常量）", gotTick, tokenretention.DefaultTick)
	}
	if v, _ := f.ctx.Value(tokenRetentionCtxKey{}).(string); v != "startup" {
		t.Fatalf("调度器拿到的不是启动期 ctx（value=%v）—— 关停信号到不了回收者", v)
	}
	// 必须登记进调度器状态表（启动/关停日志里可读 `name=token-retention …`）。
	statuses := schedulerStatuses()
	found := false
	for _, st := range statuses {
		if st.Name == schedulerTokenRetention {
			found = true
		}
	}
	if !found {
		t.Fatalf("回收者未登记进调度器状态表（%v）—— 运维面看不到它是否在跑", statuses)
	}
	// nil db 必须静默跳过（与其它装配接缝同口径：测试路由树/无 DB 启动不 panic）。
	startTokenRetentionScheduler(context.Background(), nil, tokenretention.DefaultTick)
}

func TestStartupCallsTokenRetentionScheduler(t *testing.T) {
	src, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(src)
	call := "startTokenRetentionScheduler(ctx, db, tokenretention.DefaultTick)"
	idx := strings.Index(text, call)
	if idx < 0 {
		t.Fatalf("main() 未调用 %s —— api_tokens 在稳态下没有回收者（过期行永久堆积）", call)
	}
	ctxIdx := strings.Index(text, "ctx, stop := signal.NotifyContext(")
	if ctxIdx < 0 {
		t.Fatal("main() 里找不到 signal ctx 的定义（判据锚点漂移）")
	}
	if idx < ctxIdx {
		t.Fatal("令牌回收调度器排在 signal ctx 之前（拿不到关停信号）")
	}
}
