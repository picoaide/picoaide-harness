package main

// 装配级判据（R4-D-4）：审计保留策略调度器必须真的在**启动路径**上被构造并启动。
//
// 背景：`PurgeOldAuditLogs` 此前只有"启动时"与"保存配置时"两个调用点 ⇒ 稳态运行的
// 实例只在启动那一刻清理（`audit.retention_days` 形同虚设）。修法是挂周期调度器，但
// "挂上去"必须可被判据观察 —— 只加一行 `Start(ctx)` 时，删掉那一行所有门禁依旧全绿。
//
// 两条判据互补（与 gateway_reaper_test.go 同款）：
//   - 执行级（TestAuditRetentionSchedulerWiring）：把构造点换成桩，断言启动路径用它
//     构造了调度器并**调用了 Start**，参数是（启动期 ctx, 同一个 db, 间隔常量）；
//   - 源码级（TestStartupCallsAuditRetentionScheduler）：断言 main() 里存在
//     `startAuditRetentionScheduler(ctx, db, auditretention.DefaultTick)`，且在
//     signal ctx 之后 —— 整行删掉/挪进不执行的分支由这一条兜住。

import (
	"context"
	"database/sql"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/auditretention"
)

// fakeScheduler 记录 Start 是否被调用、拿到什么 ctx。
type fakeScheduler struct {
	db    *sql.DB
	tick  time.Duration
	key   any
	start chan struct{}
}

func (f *fakeScheduler) Start(ctx context.Context) {
	f.key = ctx.Value(auditRetentionCtxKey{})
	close(f.start)
}

type auditRetentionCtxKey struct{}

func TestAuditRetentionSchedulerWiring(t *testing.T) {
	got := make(chan *fakeScheduler, 1)
	prev := newAuditRetentionScheduler
	t.Cleanup(func() { newAuditRetentionScheduler = prev })
	newAuditRetentionScheduler = func(db *sql.DB, tick time.Duration, nowFn func() time.Time) schedulerStarter {
		f := &fakeScheduler{db: db, tick: tick, start: make(chan struct{})}
		got <- f
		return f
	}

	db, err := sql.Open("pgx", "postgres://user:pass@127.0.0.1:1/never-connected")
	if err != nil {
		t.Fatalf("open placeholder db: %v", err)
	}
	defer db.Close()

	parent, cancel := context.WithCancel(context.WithValue(context.Background(), auditRetentionCtxKey{}, "startup"))
	defer cancel()
	startAuditRetentionScheduler(parent, db, auditretention.DefaultTick)

	var f *fakeScheduler
	select {
	case f = <-got:
	case <-time.After(5 * time.Second):
		t.Fatal("启动路径没有构造审计保留调度器（装配接缝未被调用）")
	}
	select {
	case <-f.start:
	case <-time.After(5 * time.Second):
		t.Fatal("构造了调度器但没有调用 Start（调度器不会运行）")
	}
	if f.db != db {
		t.Fatal("调度器拿到的不是启动期的 db")
	}
	if f.tick != auditretention.DefaultTick {
		t.Fatalf("tick = %v, want %v（装配必须传默认间隔常量）", f.tick, auditretention.DefaultTick)
	}
	if f.key != "startup" {
		t.Fatalf("调度器拿到的不是启动期 ctx（value=%v）—— 关停信号到不了调度器", f.key)
	}
	// nil db 必须静默跳过（与其它装配接缝同口径：测试路由树/无 DB 启动不 panic）。
	startAuditRetentionScheduler(context.Background(), nil, auditretention.DefaultTick)
}

func TestStartupCallsAuditRetentionScheduler(t *testing.T) {
	src, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(src)
	call := "startAuditRetentionScheduler(ctx, db, auditretention.DefaultTick)"
	idx := strings.Index(text, call)
	if idx < 0 {
		t.Fatalf("main() 未调用 %s —— 审计保留策略在稳态下没有执行者", call)
	}
	ctxIdx := strings.Index(text, "ctx, stop := signal.NotifyContext(")
	if ctxIdx < 0 {
		t.Fatal("main() 里找不到 signal ctx 的定义（判据锚点漂移）")
	}
	if idx < ctxIdx {
		t.Fatal("审计保留调度器排在 signal ctx 之前（拿不到关停信号）")
	}
}
